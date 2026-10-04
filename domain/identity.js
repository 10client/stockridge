// =====================================================================
// StockRidge — IDENTITY & AUTHENTICATION PRIMITIVES
// =====================================================================
// Reconstructed from PharmaRidge's crypto.js, kept deliberately identical
// in mechanism because every one of its choices was a response to a
// measured constraint, not a preference.
//
// WHY PBKDF2-SHA256 VIA WEBCRYPTO, NOT bcrypt
// -------------------------------------------
//  1. bcryptjs and jsonwebtoken both pull in Node's `crypto` in ways that
//     do not map cleanly onto the Workers runtime, and this codebase runs
//     on BOTH Node and Cloudflare Workers from ONE source. WebCrypto is the
//     only primitive that exists identically in both.
//  2. bcrypt's entire design goal is to be slow. That is exactly the wrong
//     property on a platform whose free tier gives a Worker 10ms of CPU for
//     the WHOLE request — routing, JSON parsing, the database query and the
//     hash all share it.
//
// THE ITERATION COUNT IS A MEASURED TRADE-OFF
// -------------------------------------------
// Benchmarked with Node's WebCrypto (the same V8 SubtleCrypto the Workers
// runtime uses): ~4ms at 20,000 iterations, ~19ms at 100,000. 20,000 leaves
// headroom inside the free plan's 10ms budget. On a paid Workers plan, or
// on the Node backend where there is no such ceiling, raise
// PBKDF2_ITERATIONS to 210,000 (OWASP's current PBKDF2-SHA256
// recommendation) with NO OTHER CODE CHANGE: the stored hash embeds its own
// iteration count per record, so existing hashes keep verifying after you
// raise it for new ones. That versioning is the whole point of the format.
//
// STORED FORMAT: pbkdf2$<iterations>$<salt-hex>$<hash-hex>
// =====================================================================

const PBKDF2_ITERATIONS = Number(process.env && process.env.PBKDF2_ITERATIONS) || 20000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

// A PIN is short. The minimum is 4 digits, which is a 10,000-value keyspace
// — trivially searchable if an attacker gets unlimited attempts. The
// throttle in domain/loginThrottle.js is what makes a short PIN acceptable
// at all, and the two must be read together: a 4-digit PIN with no lockout
// is not a credential, and a 12-character password on a shop-floor keypad is
// not going to be typed correctly at 6pm on a Saturday.
const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 8;

function isPlausiblePin(pin) {
  const s = String(pin == null ? '' : pin);
  if (!/^\d+$/.test(s)) return { ok: false, code: 'PIN_NOT_NUMERIC', error: 'A PIN is digits only.' };
  if (s.length < MIN_PIN_LENGTH || s.length > MAX_PIN_LENGTH) {
    return { ok: false, code: 'PIN_LENGTH', error: `A PIN must be ${MIN_PIN_LENGTH}–${MAX_PIN_LENGTH} digits.` };
  }
  // Repeated digits and straight runs are the first things an attacker
  // tries and the ones a clerk picks because they are easy to remember.
  // Rejected at SET time, never at verify time — an existing weak PIN must
  // keep working or its owner is locked out of their own shop.
  if (/^(\d)\1+$/.test(s)) return { ok: false, code: 'PIN_TOO_SIMPLE', error: 'That PIN is one repeated digit. Choose something harder to guess.' };
  const runs = ['0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654', '6543', '5432', '4321', '3210'];
  if (runs.some((r) => s.includes(r))) return { ok: false, code: 'PIN_TOO_SIMPLE', error: 'That PIN contains a straight run of digits. Choose something harder to guess.' };
  return { ok: true, pin: s };
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const clean = String(hex || '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

// Constant-time string comparison. A standard === leaks how far the match
// got through response timing, which is a real (if slow) side channel on a
// hash comparison.
function timingSafeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let result = 0;
  for (let i = 0; i < sa.length; i++) result |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return result === 0;
}

async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, HASH_BYTES * 8,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

async function verifyPin(pin, stored) {
  const s = String(stored || '');
  if (!s.startsWith('pbkdf2$')) return false;
  const [, iterationsStr, saltHex, hashHex] = s.split('$');
  const iterations = Number(iterationsStr);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, HASH_BYTES * 8,
  );
  return timingSafeEqual(toHex(bits), hashHex);
}

// Does this stored hash predate the current iteration count? If so it should
// be transparently re-hashed on the next successful sign-in — the only
// moment the plaintext PIN is available. Without this, raising the count
// protects new users forever and existing users never.
function isHashStrengthOutdated(stored, currentIterations = PBKDF2_ITERATIONS) {
  const s = String(stored || '');
  if (!s.startsWith('pbkdf2$')) return false;
  const iterations = Number(s.split('$')[1]);
  return Number.isFinite(iterations) && iterations < currentIterations;
}

// ---------------------------------------------------------------------
// JWT (HMAC-SHA256), hand-rolled
// ---------------------------------------------------------------------
// Hand-rolled rather than `jsonwebtoken` for the same portability reason as
// the hashing: one implementation that runs unchanged on Node and Workers.
// HS256 with a 256-bit secret is the right choice here — the alternative
// (RS256) buys key distribution across services this deployment does not
// have, and costs a signature verification on every request.
const TOKEN_TTL_SECONDS = 12 * 60 * 60; // one shop day; renewed in flight by the sliding session

function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const withPad = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '=');
  const binary = atob(withPad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

async function signToken(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  // `iat`/`exp` stay whole seconds, as the JWT spec requires.
  //
  // `imt` (issued-at, MILLISECONDS) is a private claim and it is
  // load-bearing. `iat` alone cannot decide whether a token was minted
  // before or after a credential change that happened in the SAME second:
  // a stale token minted at N.000 and a fresh one at N.950 carry an
  // identical iat. With second-resolution comparison one of the two answers
  // is always wrong — either the compromised session survives the PIN
  // change, or the user's own immediate re-login with the new PIN is
  // rejected. `imt` is additive, so any token already in the wild simply
  // lacks it and falls back to the conservative second-based comparison.
  const fullPayload = {
    ...payload,
    iat: nowSeconds,
    imt: nowMs,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

// Verifies signature AND expiry. Throws on any failure — callers respond
// 401 and must NEVER trust a token that fails this.
async function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await getHmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC', key, base64UrlDecode(encodedSignature), new TextEncoder().encode(signingInput),
  );
  if (!valid) throw new Error('Invalid signature');
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && nowSeconds >= payload.exp) throw new Error('Token expired');
  return payload;
}

// ---------------------------------------------------------------------
// IDENTIFIERS
// ---------------------------------------------------------------------
// 32 hex chars from randomblob(16)/randomUUID. Text rather than INTEGER
// primary keys, because an offline-first system must be able to mint an id
// on a device with no network and have it never collide with one minted on
// the server or at another branch. An autoincrement cannot do that.
function uuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return toHex(digest);
}

// Human-readable document numbers. A receipt numbered
// "a3f9c2e17b8d4f60a1c9e3b7d5f2a8c4" is a receipt a customer cannot read
// back over the phone. So every customer-facing document also gets a short
// sequential-per-branch number: SR- IKE-000123. The uuid remains the join
// key; this is the label.
function documentNumber({ prefix, branchCode, sequence, date = new Date() }) {
  const d = date instanceof Date ? date : new Date(String(date));
  const ymd = Number.isNaN(d.getTime()) ? '000000' : d.toISOString().slice(2, 10).replace(/-/g, '');
  const bc = String(branchCode || 'HQ').slice(0, 4).toUpperCase();
  const seq = String(Math.max(0, Number(sequence) || 0)).padStart(6, '0');
  return `${String(prefix || 'SR').toUpperCase()}-${bc}${ymd}-${seq}`;
}

// A claim/booking code for a customer to read aloud. Unambiguous alphabet
// (no 0/O, no 1/I/l) because a code quoted over a bad phone line to the
// wrong account is worse than no code at all.
const READABLE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function readableCode(length = 8, random = Math.random) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += READABLE_ALPHABET[Math.floor(random() * READABLE_ALPHABET.length) % READABLE_ALPHABET.length];
  }
  return out;
}

// Nigerian mobile numbers. Accepts the forms people actually type —
// 08031234567, +2348031234567, 234 803 123 4567 — and normalises to
// +2348031234567. Normalising matters because a customer saved as
// "08031234567" and the same customer saved as "+2348031234567" are two
// debtors in every report that groups by phone.
function normaliseNigerianPhone(value) {
  const digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  let d = digits.replace(/^\+/, '');
  if (d.startsWith('234')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  if (!/^\d{10}$/.test(d)) return null;
  return `+234${d}`;
}

function isValidNigerianPhone(value) {
  return normaliseNigerianPhone(value) !== null;
}

// TIN validation. A Nigerian Tax Identification Number is 8 digits for an
// individual and 8 digits prefixed/suffixed per JTB's instant-registration
// format for companies; in practice the app sees 8-digit and
// "NNNNNNNN-NNNN" forms. We accept the digit-length forms and normalise,
// and we DO NOT reject an unfamiliar shape outright — blocking a supplier
// record over a TIN format the app does not recognise means the goods do
// not get received, and the clerk will invent a TIN to get past the field.
function normaliseTin(value) {
  const cleaned = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleaned) return null;
  return cleaned;
}

function looksLikeTin(value) {
  const t = normaliseTin(value);
  if (!t) return false;
  return /^\d{8,11}$/.test(t) || /^[A-Z]{0,3}\d{8,11}$/.test(t);
}

// CAC registration number: RC (companies) or BN (business names).
function normaliseCacNumber(value) {
  const cleaned = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!cleaned) return null;
  return cleaned;
}

function looksLikeCacNumber(value) {
  const c = normaliseCacNumber(value);
  if (!c) return false;
  return /^(RC|BN|LP)?-?\d{4,12}$/.test(c);
}

module.exports = {
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  HASH_BYTES,
  MIN_PIN_LENGTH,
  MAX_PIN_LENGTH,
  TOKEN_TTL_SECONDS,
  READABLE_ALPHABET,
  isPlausiblePin,
  toHex,
  fromHex,
  timingSafeEqual,
  hashPin,
  verifyPin,
  isHashStrengthOutdated,
  signToken,
  verifyToken,
  uuid,
  sha256Hex,
  documentNumber,
  readableCode,
  normaliseNigerianPhone,
  isValidNigerianPhone,
  normaliseTin,
  looksLikeTin,
  normaliseCacNumber,
  looksLikeCacNumber,
};
