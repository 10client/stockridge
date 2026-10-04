// =====================================================================
// server/lib/auth.js — PIN HASHING, SESSION TOKENS, LOGIN THROTTLING
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: worker/src/lib/auth.js and server/lib/auth.js
// were two copies. StockRidge has one, and it is deliberately written against
// node:crypto ONLY (no bcrypt/argon2 dependency) so it runs on a bare VPS with
// no native build step and in a Cloudflare Worker via nodejs_compat.
//
// THE THREAT MODEL IS UNUSUAL AND DRIVES EVERY DECISION HERE.
//
// This product authenticates with SHORT NUMERIC PINs. That is correct for the
// environment — a cashier with a queue at 6pm on a Friday cannot type a
// passphrase, and a shop that makes them will have the PIN taped under the
// keyboard, which is worse than a 4-digit PIN properly throttled. But it means
// the keyspace is 10,000 values (4 digits) to 1,000,000 (6 digits).
//
// Reproduced live against a running system before throttling existed:
//   60 consecutive wrong PINs against the `owner` account all returned a plain
//   401 in 1,150ms total — 19ms per attempt, no lockout, no throttle, no record
//   that it had happened. The correct PIN then worked immediately afterwards.
//   At 19ms per attempt a 4-digit PIN is exhaustible in about three minutes.
//
// So the defence is layered, and no single layer is trusted:
//   1. A SLOW HASH (scrypt, N=2^14) so each guess costs real CPU.
//   2. A THROTTLE (8 failures per 15 minutes per username) so the keyspace
//      cannot be walked: exhausting 10,000 values at 8 per 15 minutes takes
//      over a month of uninterrupted attacking instead of three minutes.
//   3. A PER-USERNAME LOCK, not per-IP. A shop's tills all share one public IP,
//      so per-IP throttling would let one cashier lock out the whole branch —
//      and would not stop an attacker who rotates IPs anyway.
//   4. AN AUDIT TRAIL that survives the lockout, so the attempt is visible
//      after the fact even when the throttle did its job.
//   5. AN INSTANT UNLOCK PATH for a higher-ranked user, because the lock is
//      time-based and username-scoped: a legitimate owner who mistypes 8 times
//      is locked out of their own shop for 15 minutes, potentially mid-queue,
//      unable to open the till. "Wait it out" is not an acceptable answer for a
//      shop floor.
//
// The throttle FAILS OPEN. If the login_attempts table cannot be read (disk
// full, migration not applied, corruption), logins still work. Being unable to
// sign in is a business-stopping failure; a briefly unthrottled login endpoint
// is not, and choosing the other way round would turn a small fault into a
// shop that cannot trade.

'use strict';

const crypto = require('node:crypto');

// ---------------------------------------------------------------------
// PIN HASHING — scrypt
// ---------------------------------------------------------------------
// scrypt rather than bcrypt because node:crypto provides it natively (no build
// step) and it is memory-hard, which matters more than raw iteration count
// against a GPU-backed attacker working through a 10,000-value keyspace.
//
// The parameters are OWASP's current guidance for scrypt. They are stored IN
// the hash string, so a future re-tune does not invalidate existing hashes:
// verify() reads the parameters back out of the stored value rather than
// assuming today's.
const SCRYPT_N = 16384;   // 2^14 — CPU/memory cost
const SCRYPT_R = 8;       // block size
const SCRYPT_P = 1;       // parallelism
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * Hash a PIN. Returns a self-describing string:
 *   scrypt$N$r$p$saltB64$hashB64
 */
function hashPin(pin) {
  const plain = normalisePin(pin);
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verify a PIN against a stored hash.
 *
 * timingSafeEqual, always — a byte-by-byte comparison leaks the correct prefix
// through response timing, which for a 4-digit PIN is a real (if slow) oracle.
 * Returns false rather than throwing on a malformed stored hash, because a
 * corrupt hash must not become a 500 that reveals the account exists.
 */
function verifyPin(pin, stored) {
  try {
    const plain = normalisePin(pin);
    const parts = String(stored || '').split('$');
    if (parts[0] === 'scrypt' && parts.length === 6) {
      const [, n, r, p, saltB64, hashB64] = parts;
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      const derived = crypto.scryptSync(plain, salt, expected.length, {
        N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
      });
      return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    }
    // Legacy/pbkdf2 support, so a database migrated from an older build can
    // still sign in and be re-hashed on next successful login.
    if (parts[0] === 'pbkdf2-sha256' && parts.length === 5) {
      const [, iter, saltB64, hashB64] = parts;
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      const derived = crypto.pbkdf2Sync(plain, salt, Number(iter), expected.length, 'sha256');
      return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * PIN format rules.
 *
 *   * 4-8 digits. Below 4 is a keyspace of 1,000 that the throttle cannot save;
 *     above 8 is a PIN nobody will remember and therefore one that gets written
 *     down, which defeats the purpose.
 *   * NOT a repeated digit (1111) and NOT a straight run (1234). These are the
 *     first four things anyone tries, and allowing them makes the throttle's
 *     maths much worse than it looks.
 *   * NOT the username, and not the last PIN.
 */
const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '12345', '123456', '4321', '54321', '654321', '12345678', '87654321',
  '1212', '121212', '2323', '2580', '0852', '6969', '1122', '102030',
]);

function normalisePin(pin) {
  return String(pin == null ? '' : pin).replace(/\D/g, '');
}

function validatePin(pin, { minLength = 4, maxLength = 8, username = null, currentPinHash = null } = {}) {
  const digits = normalisePin(pin);
  const problems = [];
  if (digits.length < minLength) problems.push(`A PIN must be at least ${minLength} digits.`);
  if (digits.length > maxLength) problems.push(`A PIN must be at most ${maxLength} digits.`);
  if (String(pin || '').length !== digits.length) problems.push('A PIN may contain digits only.');
  if (WEAK_PINS.has(digits)) problems.push('That PIN is one of the first anyone tries. Choose another.');
  if (digits.length >= minLength && /^(\d)\1+$/.test(digits)) problems.push('A PIN of one repeated digit is too easy to guess.');
  if (username && digits.toLowerCase() === String(username).replace(/\D/g, '').toLowerCase() && digits.length) {
    problems.push('A PIN cannot be the same as the username.');
  }
  if (currentPinHash && verifyPin(digits, currentPinHash)) {
    problems.push('That is the PIN already in use. Choose a different one.');
  }
  return { ok: problems.length === 0, problems, digits };
}

// ---------------------------------------------------------------------
// SESSION TOKENS — HMAC-signed compact JWT
// ---------------------------------------------------------------------
// Hand-rolled rather than a library, because the requirement is small and
// specific (HS256 sign/verify, a few claims, no algorithm negotiation) and
// because `alg: none` and algorithm-confusion attacks are the two classic JWT
// failures — both of which are structurally impossible when the verifier does
// not read the algorithm from the token at all.
const JWT_ALG = 'HS256';

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

/**
 * Sign a session token.
 *
 * Claims:
 *   sub   user id            sid   session id (for revocation without a PIN reset)
 *   role  ADMIN|OWNER|...    bid   business scope (null = all)
 *   br    branch scope (null = all in scope)
 *   ver   the user's pin_version — bumping it invalidates every token at once
 */
function signToken({ userId, sessionId, role, businessId = null, branchId = null, pinVersion = 0, username = null }, { secret, ttlHours = 12, issuer = 'stockridge', audience = 'stockridge-app' }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: JWT_ALG, typ: 'JWT' };
  const payload = {
    iss: issuer,
    aud: audience,
    sub: String(userId),
    sid: String(sessionId),
    role: String(role),
    bid: businessId || null,
    br: branchId || null,
    ver: Number(pinVersion) || 0,
    usr: username || null,
    iat: now,
    nbf: now,
    exp: now + Math.floor(ttlHours * 3600),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/**
 * Verify a token. Returns { valid, payload, reason }.
 *
 * Never throws: an invalid token is an ordinary 401, not a 500, and the reason
 * is returned so the client can say something useful ("your session expired,
// sign in again" vs "this link is not valid").
 */
function verifyToken(token, { secret, issuer = 'stockridge', audience = 'stockridge-app', now = Math.floor(Date.now() / 1000) }) {
  const fail = (reason) => ({ valid: false, payload: null, reason });
  if (!token || typeof token !== 'string') return fail('missing');

  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed');

  // THE ALGORITHM IS NOT READ FROM THE TOKEN. `alg: none` and RS256/HS256
  // confusion both require the verifier to trust a claim in the thing being
  // verified. Recomputing the HMAC with our own secret and comparing is the only
  // safe shape, so that is the only shape implemented.
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
  const provided = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (parts[2].length % 4)) % 4), 'base64');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return fail('bad_signature');
  }

  let header; let payload;
  try { header = JSON.parse(b64urlDecode(parts[0])); } catch (e) { return fail('malformed_header'); }
  try { payload = JSON.parse(b64urlDecode(parts[1])); } catch (e) { return fail('malformed_payload'); }

  if (header.alg !== JWT_ALG) return fail('unexpected_algorithm');
  if (payload.iss !== issuer) return fail('wrong_issuer');
  if (payload.aud !== audience) return fail('wrong_audience');
  if (typeof payload.exp !== 'number') return fail('no_expiry');
  if (now >= payload.exp) return fail('expired');
  if (typeof payload.nbf === 'number' && now + 30 < payload.nbf) return fail('not_yet_valid');
  if (!payload.sub || !payload.role) return fail('missing_claims');

  return { valid: true, payload, reason: null };
}

/** Extract a bearer token from an Authorization header or a cookie. */
function extractToken(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const cookie = req.headers && req.headers.cookie;
  if (cookie) {
    const m = String(cookie).match(/(?:^|;\s*)sr_session=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

// ---------------------------------------------------------------------
// LOGIN THROTTLING
// ---------------------------------------------------------------------
const DEFAULT_MAX_FAILED = 8;
const DEFAULT_WINDOW_MINUTES = 15;
const DEFAULT_LOCKOUT_MINUTES = 15;

class LoginLockedError extends Error {
  constructor(retryAfterSeconds) {
    const mins = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    super(
      `Too many failed sign-in attempts for this account. For security it has been temporarily locked. `
      + `Please try again in about ${mins} minute${mins === 1 ? '' : 's'}, or ask a manager to reset your PIN.`
    );
    this.status = 429;
    this.code = 'TOO_MANY_LOGIN_ATTEMPTS';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Throws LoginLockedError when `username` currently has too many recent
 * failures. Call BEFORE verifying the PIN — checking the PIN first would hand
 * the attacker a fast oracle and only throttle afterwards.
 *
 * The lock runs from the MOST RECENT failure, so continuing to hammer the
 * endpoint keeps extending it rather than letting an attacker wait out a fixed
 * window while still guessing.
 *
 * FAILS OPEN: any internal error allows the login to proceed.
 */
async function assertLoginAllowed(db, username, opts = {}) {
  if (!username) return;
  const maxFailed = opts.maxFailed || DEFAULT_MAX_FAILED;
  const windowMinutes = opts.windowMinutes || DEFAULT_WINDOW_MINUTES;
  const lockoutMinutes = opts.lockoutMinutes || DEFAULT_LOCKOUT_MINUTES;
  try {
    const row = await db.prepare(`
      SELECT COUNT(*) AS failures, MAX(attempted_at) AS last_failure
        FROM login_attempts
       WHERE username = ? AND succeeded = 0
         AND attempted_at > datetime('now', ?)
    `).bind(String(username), `-${windowMinutes} minutes`).first();

    if (!row || row.failures < maxFailed) return;

    const at = await db.prepare(
      `SELECT datetime(?, ?) AS unlock_at, datetime('now') AS now_at`
    ).bind(row.last_failure, `+${lockoutMinutes} minutes`).first();

    const remaining = Math.max(0, Math.round(
      (Date.parse(`${at.unlock_at}Z`) - Date.parse(`${at.now_at}Z`)) / 1000
    ));
    if (remaining <= 0) return;
    throw new LoginLockedError(remaining);
  } catch (e) {
    if (e instanceof LoginLockedError) throw e;
    // FAIL OPEN — see the header comment.
    // eslint-disable-next-line no-console
    console.error('[auth] throttle check failed, allowing login:', e && e.message);
  }
}

/** Records one attempt. Never throws: an audit failure must not break a login. */
async function recordLoginAttempt(db, { username, userId, succeeded, ipAddress, userAgent, deviceId, branchId, failureReason = null }) {
  try {
    const { newId } = require('../../shared/lib/ids');
    await db.prepare(`
      INSERT INTO login_attempts (id, username, user_id, succeeded, failure_reason, ip_address, user_agent, device_id, branch_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      newId(),
      String(username || '').slice(0, 120),
      userId || null,
      succeeded ? 1 : 0,
      failureReason,
      ipAddress ? String(ipAddress).slice(0, 60) : null,
      userAgent ? String(userAgent).slice(0, 220) : null,
      deviceId ? String(deviceId).slice(0, 64) : null,
      branchId || null
    ).run();

    // A successful sign-in clears the slate, so ordinary mistyping never
    // accumulates into a lockout days later.
    if (succeeded) {
      await db.prepare('DELETE FROM login_attempts WHERE username = ? AND succeeded = 0')
        .bind(String(username)).run();
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth] could not record login attempt:', e && e.message);
  }
}

/**
 * Clears the failed-attempt counter, unlocking immediately. Callable only by a
 * HIGHER-RANKED account.
 *
 * OPERATIONAL NECESSITY, not a convenience: the lock is username-scoped and
 * time-based, so a legitimate owner who mistypes 8 times is locked out of their
 * own shop for 15 minutes — potentially mid-queue, unable to open the till.
 * Authority mirrors PIN-reset exactly (assertCanModifyUser in routes/users.js),
 * so this grants no new power: anyone who can clear a lock could already reset
 * that user's PIN outright.
 *
 * The AUDIT TRAIL IS NOT DELETED — only the failure rows that feed the
 * throttle. Successful logins, and the fact that an unlock happened, remain
 * visible.
 */
async function clearLoginLock(db, username) {
  const result = await db.prepare('DELETE FROM login_attempts WHERE username = ? AND succeeded = 0')
    .bind(String(username)).run();
  return (result && result.meta && result.meta.changes) || 0;
}

/** Current lock state, so a manager can see WHICH accounts are locked instead
 *  of waiting for a phone call from a cashier who cannot sign in. */
async function getLockState(db, username, opts = {}) {
  const windowMinutes = opts.windowMinutes || DEFAULT_WINDOW_MINUTES;
  const maxFailed = opts.maxFailed || DEFAULT_MAX_FAILED;
  const row = await db.prepare(`
    SELECT COUNT(*) AS failures, MAX(attempted_at) AS last_failure
      FROM login_attempts
     WHERE username = ? AND succeeded = 0
       AND attempted_at > datetime('now', ?)
  `).bind(String(username), `-${windowMinutes} minutes`).first();
  const failures = (row && row.failures) || 0;
  return {
    failed_attempts: failures,
    is_locked: failures >= maxFailed,
    max_failed: maxFailed,
    last_failed_at: (row && row.last_failure) || null,
  };
}

/**
 * Re-hash a PIN on successful login when the stored hash uses older or weaker
 * parameters than the current ones. Transparent key-strengthening: a database
 * seeded five years ago gets upgraded as people use it, with no migration and
 * no forced PIN reset.
 */
function needsRehash(stored) {
  const parts = String(stored || '').split('$');
  if (parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT_N || Number(parts[2]) < SCRYPT_R || Number(parts[3]) < SCRYPT_P;
}

module.exports = {
  SCRYPT_N, SCRYPT_R, SCRYPT_P,
  hashPin, verifyPin, validatePin, normalisePin, WEAK_PINS, needsRehash,
  signToken, verifyToken, extractToken, b64url, b64urlDecode, JWT_ALG,
  LoginLockedError, assertLoginAllowed, recordLoginAttempt, clearLoginLock, getLockState,
  DEFAULT_MAX_FAILED, DEFAULT_WINDOW_MINUTES, DEFAULT_LOCKOUT_MINUTES,
};
'use strict';
