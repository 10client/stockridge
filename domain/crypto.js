'use strict';
// =====================================================================
// domain/crypto.js — PIN hashing, tokens, ids, hash chains
// =====================================================================
// ZERO DEPENDENCIES ON PURPOSE.
// This module must run identically on Node 20 (server/) and on Cloudflare
// Workers (worker/). Both provide the WebCrypto API at globalThis.crypto,
// so everything here is written against that and nothing else. No bcrypt
// native addon, no jsonwebtoken, no uuid package — each of which is either
// unavailable or differently-shaped on one of the two runtimes.
//
// WHY PBKDF2 AND NOT A PLAIN HASH
// This product authenticates with SHORT NUMERIC PINs. The minimum is 4
// digits: a 10,000-value keyspace. A leaked database hashed with SHA-256
// is fully recoverable on a laptop in under a minute, because there is
// nothing to slow the attacker down. PBKDF2 with 120,000 SHA-256 iterations
// makes each guess cost real time, which is the only defence that works
// when the keyspace itself is tiny. (The complementary defence — login
// throttling — lives in domain/access.js and lib/loginThrottle.js, and
// protects the ONLINE attack; this protects the OFFLINE one against a
// stolen database.)
// =====================================================================

// 100,000 — AND THIS NUMBER IS A PLATFORM CEILING, NOT A PREFERENCE.
//
// StockRidge hashes with PBKDF2 because a 4-digit PIN has a 10,000-value
// keyspace; the iteration count is the only thing standing between a stolen
// database and every PIN in it, so the temptation is always to raise it.
//
// It cannot be raised. The Cloudflare Workers WebCrypto implementation REFUSES
// any iteration count above 100,000:
//
//     Pbkdf2 failed: iteration counts above 100000 are not supported
//
// and it refuses by THROWING, which `verifyPin` is documented to swallow and
// turn into `false`. The result was a deployment where the schema, the admin row
// and the hash format were all correct, every local test passed 251/251, and
// every single sign-in answered 401 — because Node computes a 120,000-iteration
// PBKDF2 happily and Workers will not.
//
// Two runtimes, one stored format: the count has to be one both can compute, or
// a hash written by the Node backend is a hash the deployed Worker cannot check.
// 100,000 is that number. `verifyPin` below now reports a stored count above it
// instead of failing silently, and `/api/diagnose` on the Worker exercises the
// round trip in the runtime that will actually use it.
//
// ONE CONSTANT, NOT TWO. `PBKDF2_MAX_ITERATIONS` is not a second knob to tune:
// it is the platform ceiling, and hashing uses it directly. A separate lower
// "hashing" value would mean the ceiling is never exercised and the drift that
// caused the lockout could return unnoticed.
const PBKDF2_MAX_ITERATIONS = 100000;
const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;
const PBKDF2_KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // a shop day, plus overtime

// ---------------------------------------------------------------------
// Encoding helpers — identical semantics on Node and Workers
// ---------------------------------------------------------------------
function toBytes(value) {
  return new TextEncoder().encode(String(value));
}

function bytesToBase64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
  // btoa exists on both Node 16+ and Workers.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function cryptoSubtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('WebCrypto is unavailable. Node >= 20 and Cloudflare Workers both provide globalThis.crypto.subtle.');
  }
  return c.subtle;
}

// ---------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------
/**
 * The same shape the schema's DEFAULT produces: 32 lowercase hex chars.
 * Generated in the application rather than relying on the column default
 * whenever a row's id must be known BEFORE insert (batch inserts, and
 * building parent/child rows in one transaction).
 */
function newId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Short human-quotable code: a change-owed claim, a receipt suffix. */
function shortCode(length = 8, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
  // Ambiguous characters (I/1/O/0) are excluded from the alphabet because
  // these codes are read aloud across a shop counter or over a phone call.
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Numeric-only code, for till receipt numbers and job numbers. */
function numericCode(length = 6) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => String(b % 10)).join('');
}

// ---------------------------------------------------------------------
// PIN hashing
// ---------------------------------------------------------------------
async function hashPin(pin, saltHex) {
  const salt = saltHex ? base64urlToBytes(saltHex) : globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await cryptoSubtle().importKey('raw', toBytes(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await cryptoSubtle().deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key, PBKDF2_KEY_LENGTH_BITS,
  );
  const hashHex = bytesToHex(new Uint8Array(bits));
  return {
    saltHex: bytesToBase64url(salt),
    hashHex,
    stored: `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${bytesToBase64url(salt)}$${hashHex}`,
    iterations: PBKDF2_ITERATIONS,
  };
}

/**
 * Verify a PIN against a stored hash.
 *
 * Compares in CONSTANT TIME. A short-circuiting string comparison leaks,
 * byte by byte, how much of a guess is correct — which matters far more
 * than usual here because the keyspace is only 10,000 values.
 *
 * Returns false (never throws) for a malformed stored value, so a corrupt
 * row cannot be used to lock every user out of the system.
 */
async function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;

  // A stored hash above the platform ceiling CANNOT be verified here — the
  // runtime will refuse to derive it. Returning false silently is technically
  // correct and operationally terrible: it presents as "your PIN is wrong" to
  // every user in the business at once, which is indistinguishable from a
  // forgotten PIN. Say so in the log, where an operator can find it. (Node
  // computes these fine, which is exactly how a 120,000-iteration hash gets
  // written and then cannot be checked by the deployed Worker.)
  if (iterations > PBKDF2_MAX_ITERATIONS) {
    console.warn(
      `[crypto] stored PIN hash uses ${iterations} PBKDF2 iterations, above this runtime's maximum of ${PBKDF2_MAX_ITERATIONS}. `
      + 'It cannot be verified here. Re-set this user\'s PIN with a hash written by the running backend.',
    );
    return false;
  }

  try {
    const salt = base64urlToBytes(parts[3]);
    const key = await cryptoSubtle().importKey('raw', toBytes(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await cryptoSubtle().deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, PBKDF2_KEY_LENGTH_BITS,
    );
    const candidate = bytesToHex(new Uint8Array(bits));
    return timingSafeEqualString(candidate, parts[4]);
  } catch (e) {
    return false;
  }
}

function timingSafeEqualString(a, b) {
  const x = String(a); const y = String(b);
  if (x.length !== y.length) {
    // Still walk the full length of x so the timing does not reveal that
    // the lengths differed.
    let diff = 1;
    for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ x.charCodeAt(i);
    return false && diff === 0;
  }
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------
// Generic SHA-256 (hash chains, idempotency request hashing)
// ---------------------------------------------------------------------
async function sha256Hex(input) {
  const digest = await cryptoSubtle().digest('SHA-256', toBytes(input));
  return bytesToHex(new Uint8Array(digest));
}

function sha256HexSync(input) {
  // Synchronous fallback for the Node backend only, where node:crypto is
  // available. Used by the seed tool, which hashes thousands of rows and
  // would otherwise await each one. Throws on Workers — call sha256Hex there.
  // eslint-disable-next-line global-require
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(String(input)).digest('hex');
}

/**
 * Canonical JSON for hashing. Object key order is sorted so that
 * {"a":1,"b":2} and {"b":2,"a":1} hash identically — without this, an
 * idempotency key would treat a semantically identical retry with
 * reordered keys as a DIFFERENT request and execute it twice.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

async function hashRequestBody(body) {
  return sha256Hex(canonicalJson(body === undefined ? null : body));
}

// ---------------------------------------------------------------------
// TOKENS — HMAC-SHA256 signed JWT-shaped, implemented locally
// ---------------------------------------------------------------------
// A compact, auditable implementation rather than a dependency, because the
// only two things this app needs are "sign a payload" and "verify a
// signature and expiry", and a full JWT library's surface area (algorithm
// negotiation in particular) is where the classic `alg: none` and
// key-confusion vulnerabilities live. The header is FIXED to HS256 and is
// checked on verification rather than trusted.

const TOKEN_HEADER_B64 = bytesToBase64url(toBytes(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

async function hmacSha256Base64url(secret, message) {
  const key = await cryptoSubtle().importKey('raw', toBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await cryptoSubtle().sign('HMAC', key, toBytes(message));
  return bytesToBase64url(new Uint8Array(sig));
}

async function signToken(payload, secret, { ttlSeconds = TOKEN_TTL_SECONDS } = {}) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const now = Math.floor(Date.now() / 1000);
  // A non-finite or omitted TTL falls back to the default and is floored at
  // 60s, because a token that expires before the response reaches the browser
  // is a login loop and not a security feature. An EXPLICITLY negative TTL is
  // honoured: it is only ever passed deliberately, to test the expiry path.
  const requested = Number(ttlSeconds);
  const ttl = Number.isFinite(requested) ? requested : TOKEN_TTL_SECONDS;
  const body = {
    ...payload,
    iat: now,
    exp: now + (Number.isFinite(requested) && requested < 0 ? ttl : Math.max(60, ttl)),
    jti: newId(),
  };
  const payloadB64 = bytesToBase64url(toBytes(JSON.stringify(body)));
  const signingInput = `${TOKEN_HEADER_B64}.${payloadB64}`;
  const signature = await hmacSha256Base64url(secret, signingInput);
  return `${signingInput}.${signature}`;
}

async function verifyToken(token, secret) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw Object.assign(new Error('Malformed token'), { code: 'TOKEN_MALFORMED' });
  // The header is verified, not trusted: an attacker who could change it to
  // "none" or to an asymmetric algorithm would otherwise be able to forge.
  if (parts[0] !== TOKEN_HEADER_B64) throw Object.assign(new Error('Unsupported token algorithm'), { code: 'TOKEN_BAD_ALG' });
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = await hmacSha256Base64url(secret, signingInput);
  if (!timingSafeEqualString(expected, parts[2])) throw Object.assign(new Error('Invalid token signature'), { code: 'TOKEN_BAD_SIGNATURE' });

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[1])));
  } catch (e) {
    throw Object.assign(new Error('Unreadable token payload'), { code: 'TOKEN_BAD_PAYLOAD' });
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) {
    throw Object.assign(new Error('Session expired — please sign in again'), { code: 'TOKEN_EXPIRED' });
  }
  return payload;
}

module.exports = {
  PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS, TOKEN_TTL_SECONDS,
  newId, shortCode, numericCode,
  hashPin, verifyPin, timingSafeEqualString,
  sha256Hex, sha256HexSync, canonicalJson, hashRequestBody,
  signToken, verifyToken,
  bytesToHex, bytesToBase64url, base64urlToBytes,
};
