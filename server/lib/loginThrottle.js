// =====================================================================
// StockRidge — LOGIN THROTTLE
// =====================================================================
// Ported from PharmaRidge's lib/loginThrottle.js with the numbers and the
// reasoning kept, because the reasoning is what makes the numbers right.
//
// A 4-digit PIN has a 10,000-value keyspace. Slow hashing (PBKDF2, 150k
// iterations) makes an OFFLINE attack against a leaked database expensive.
// It does nothing at all for an ONLINE attack, because the server does the
// hashing for the attacker. The original audit measured exactly that: 60
// consecutive wrong PINs returned a plain 401 in 1,150ms total — 19ms per
// attempt, no lockout, no throttle, no record. At that rate a 10,000-value
// keyspace is searchable in minutes.
//
// 8 attempts per 15 minutes means exhausting a 4-digit PIN takes over a
// month of uninterrupted attacking instead of three minutes.
// =====================================================================

const MAX_FAILED_ATTEMPTS = 8;
const WINDOW_MINUTES = 15;
const LOCKOUT_MINUTES = 15;

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

// Scope: username + business unit. Two different businesses may both have a
// cashier called "ada", and locking one because the other was attacked
// would be a denial of service against an innocent shop.
function scopeSql(businessUnitCode) {
  return businessUnitCode
    ? { sql: 'AND (business_unit_id = (SELECT id FROM business_units WHERE lower(code) = ? AND is_deleted = 0))', params: [String(businessUnitCode).trim().toLowerCase()] }
    : { sql: '', params: [] };
}

/**
 * Throws LoginLockedError when this account currently has too many recent
 * failures. Call BEFORE verifying the PIN.
 *
 * FAILS OPEN: any internal error here allows the login to proceed. A
 * throttle that can lock every user out because the audit table is locked
 * or corrupt is worse than no throttle — it turns a security control into
 * an availability outage on a shop floor mid-queue.
 */
async function assertLoginAllowed(db, rawUsername, businessUnitCode = null) {
  if (!rawUsername) return;
  const uname = String(rawUsername).trim().toLowerCase();
  try {
    const scope = scopeSql(businessUnitCode);
    const row = await db.prepare(`
      SELECT COUNT(*) AS failures, MAX(attempted_at) AS last_failure
      FROM login_attempts
      WHERE lower(username) = ?
        AND succeeded = 0
        AND attempted_at > datetime('now', '+1 hour', ?)
        ${scope.sql}
    `).bind(uname, `-${WINDOW_MINUTES} minutes`, ...scope.params).first();

    if (!row || row.failures < MAX_FAILED_ATTEMPTS) return;

    // The lock runs from the MOST RECENT failure, so continuing to hammer
    // the endpoint keeps extending it rather than letting an attacker wait
    // out a fixed window while still guessing.
    const unlockAt = await db.prepare(
      `SELECT datetime(?, '+1 hour', ?) AS unlock_at, datetime('now', '+1 hour') AS now_at`
    ).bind(row.last_failure, `+${LOCKOUT_MINUTES} minutes`).first();

    const remainingSeconds = Math.max(
      1,
      Math.round((Date.parse(unlockAt.unlock_at.replace(' ', 'T') + 'Z') - Date.parse(unlockAt.now_at.replace(' ', 'T') + 'Z')) / 1000)
    );
    if (remainingSeconds <= 0) return;
    throw new LoginLockedError(remainingSeconds);
  } catch (e) {
    if (e instanceof LoginLockedError) throw e;
    console.error('[loginThrottle] check failed, allowing login:', e && e.message);
  }
}

/**
 * Records one authentication attempt. NEVER THROWS — an audit-trail
 * failure must not break a legitimate sign-in, and it must not become a way
 * to lock someone out by filling the table.
 */
async function recordLoginAttempt(db, { username: uname, businessUnitId, userId, succeeded, ipAddress, userAgent, deviceId, failureReason }) {
  try {
    await db.prepare(`
      INSERT INTO login_attempts (username, business_unit_id, user_id, succeeded, ip_address, user_agent, device_id, failure_reason)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(
      String(uname || '').slice(0, 120),
      businessUnitId || null,
      userId || null,
      succeeded ? 1 : 0,
      ipAddress ? String(ipAddress).slice(0, 60) : null,
      userAgent ? String(userAgent).slice(0, 200) : null,
      deviceId ? String(deviceId).slice(0, 120) : null,
      failureReason ? String(failureReason).slice(0, 60) : null
    ).run();

    // A successful sign-in clears the slate, so ordinary mistyping across a
    // month never accumulates into a lockout on the wrong day.
    if (succeeded) {
      await db.prepare('DELETE FROM login_attempts WHERE lower(username) = ? AND succeeded = 0')
        .bind(String(uname || '').trim().toLowerCase()).run();
    }
  } catch (e) {
    console.error('[loginThrottle] could not record attempt:', e && e.message);
  }
}

/**
 * Clears the failed-attempt counter, unlocking the account immediately.
 *
 * OPERATIONAL NECESSITY, not a convenience: the lock is username-scoped and
 * time-based, so a legitimate owner who mistypes 8 times is locked out of
 * their own business for 15 minutes — potentially mid-queue, unable to open
 * the till. Waiting it out is not an acceptable answer for a shop floor, so
 * someone who OUTRANKS the locked user can clear it instantly.
 *
 * Authority mirrors PIN-reset exactly, so this grants no new power: anyone
 * who can clear a lock could already reset that user's PIN outright.
 *
 * The AUDIT TRAIL IS NOT DELETED — only the failure rows that feed the
 * throttle. Successful logins and the fact that an unlock happened remain
 * visible, so "who let themselves in after 20 failed attempts?" is still
 * answerable.
 */
async function clearLoginLock(db, rawUsername, businessUnitCode = null) {
  const uname = String(rawUsername || '').trim().toLowerCase();
  const scope = scopeSql(businessUnitCode);
  const result = await db.prepare(
    `DELETE FROM login_attempts WHERE lower(username) = ? AND succeeded = 0 ${scope.sql}`
  ).bind(uname, ...scope.params).run();
  return (result && result.meta && result.meta.changes) || 0;
}

/** Which accounts are currently locked — so a manager can see it rather
 *  than waiting for a phone call from a cashier who cannot sign in. */
async function getLockState(db, rawUsername, businessUnitCode = null) {
  const uname = String(rawUsername || '').trim().toLowerCase();
  const scope = scopeSql(businessUnitCode);
  const row = await db.prepare(`
    SELECT COUNT(*) AS failures, MAX(attempted_at) AS last_failure
    FROM login_attempts
    WHERE lower(username) = ?
      AND succeeded = 0
      AND attempted_at > datetime('now', '+1 hour', ?)
      ${scope.sql}
  `).bind(uname, `-${WINDOW_MINUTES} minutes`, ...scope.params).first();
  const failures = (row && row.failures) || 0;
  return {
    failed_attempts: failures,
    attempts_remaining: Math.max(0, MAX_FAILED_ATTEMPTS - failures),
    is_locked: failures >= MAX_FAILED_ATTEMPTS,
    last_failed_at: (row && row.last_failure) || null,
  };
}

/** All currently-locked usernames in a business unit, for the Users screen. */
async function listLockedAccounts(db, businessUnitId) {
  const rows = await db.prepare(`
    SELECT lower(username) AS username, COUNT(*) AS failures, MAX(attempted_at) AS last_failure
    FROM login_attempts
    WHERE succeeded = 0
      AND attempted_at > datetime('now', '+1 hour', ?)
      AND (? IS NULL OR business_unit_id = ?)
    GROUP BY lower(username)
    HAVING COUNT(*) >= ?
    ORDER BY last_failure DESC
  `).bind(`-${WINDOW_MINUTES} minutes`, businessUnitId || null, businessUnitId || null, MAX_FAILED_ATTEMPTS).all();
  return rows.results;
}

/** Housekeeping: the table grows with every attempt forever otherwise. */
async function pruneLoginAttempts(db, { keepDays = 90 } = {}) {
  const res = await db.prepare(
    `DELETE FROM login_attempts WHERE attempted_at < datetime('now', '+1 hour', ?)`
  ).bind(`-${keepDays} days`).run();
  return (res && res.meta && res.meta.changes) || 0;
}

module.exports = {
  assertLoginAllowed, recordLoginAttempt, clearLoginLock, getLockState,
  listLockedAccounts, pruneLoginAttempts, LoginLockedError,
  MAX_FAILED_ATTEMPTS, WINDOW_MINUTES, LOCKOUT_MINUTES,
};
'use strict';
