// =====================================================================
// shared/lib/ids.js — IDENTITY (backend-neutral, zero deps)
// =====================================================================
//
// PharmaRidge used `lower(hex(randomblob(16)))` as a SQLite column DEFAULT for
// every primary key. That is elegant but it TIES THE ID SCHEME TO THE ENGINE:
// randomblob() exists in SQLite and in D1, but the moment an ID has to be
// generated client-side (the offline queue must mint a sale id before it knows
// whether the network is up) the two schemes disagree and a replayed offline
// sale can collide with a server-minted one.
//
// StockRidge therefore mints ALL ids in application code, from one function,
// on both backends and in the browser. The database still has a DEFAULT for
// defence in depth, but nothing relies on it.
//
// FORMAT: 26-char Crockford-base32 ULID-shaped string.
//   * time-sortable  — lexicographic order == chronological order, so
//                      `ORDER BY id` is a usable "newest first" and range
//                      scans over a day's sales are index-friendly.
//   * URL-safe, no dashes, case-insensitively unique.
//   * 80 bits of randomness after the timestamp — collision-resistant at any
//                      volume a Nigerian retail chain will reach, and safe to
//                      generate on 400 offline tills that never talk to each
//                      other until they sync.

'use strict';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I L O U
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ID_LEN = TIME_LEN + RANDOM_LEN;

// crypto is a global in Node >=19, in Cloudflare Workers, and in browsers.
// Falling back to require('node:crypto') keeps this file loadable under an
// older Node used by a build tool.
function getRandomValues(out) {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    return globalThis.crypto.getRandomValues(out);
  }
  // eslint-disable-next-line global-require
  const nodeCrypto = require('node:crypto');
  const buf = nodeCrypto.randomBytes(out.length);
  out.set(buf);
  return out;
}

function encodeTime(now, len) {
  let mod = now;
  let str = '';
  for (let i = len - 1; i >= 0; i -= 1) {
    str = ENCODING[mod % ENCODING_LEN] + str;
    mod = Math.floor(mod / ENCODING_LEN);
  }
  return str;
}

function encodeRandom(len) {
  const bytes = getRandomValues(new Uint8Array(len));
  let str = '';
  for (let i = 0; i < len; i += 1) {
    str += ENCODING[bytes[i] % ENCODING_LEN];
  }
  return str;
}

/** New sortable unique id. */
function newId(when = Date.now()) {
  return encodeTime(when, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

/** Is this string shaped like one of our ids? Cheap sanity check on input. */
function isId(value) {
  if (typeof value !== 'string' || value.length !== ID_LEN) return false;
  return /^[0-9A-HJKMNP-TV-Z]+$/.test(value.toUpperCase());
}

/** Extract the creation timestamp from an id, or null if malformed. */
function idTime(value) {
  if (!isId(value)) return null;
  const chars = String(value).toUpperCase().slice(0, TIME_LEN).split('');
  let time = 0;
  for (const ch of chars) {
    time = time * ENCODING_LEN + ENCODING.indexOf(ch);
  }
  return time;
}

// ---------------------------------------------------------------------
// HUMAN-FACING DOCUMENT NUMBERS
// ---------------------------------------------------------------------
// An id is for machines. A customer, an auditor and FIRS all need a document
// number they can read aloud over the phone: "invoice SR-LG-000417". These are
// generated from a per-branch, per-document-type counter table so they are
// SEQUENTIAL AND GAP-FREE WITHIN A SERIES (an invoice series with gaps is a
// tax-audit red flag), which a random id can never guarantee.

/**
 * @param {string} prefix    e.g. "INV", "RCPT", "PO", "DN"
 * @param {string} branchTag e.g. "LG" for Lekki
 * @param {number} seq       1-based counter value for that series
 */
function docNumber(prefix, branchTag, seq) {
  const p = String(prefix || 'DOC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const b = String(branchTag || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const n = String(Math.max(1, Math.floor(Number(seq) || 1))).padStart(6, '0');
  return b ? `${p}-${b}-${n}` : `${p}-${n}`;
}

/** Short random code for customer-facing claims (change-owed, layaway). */
function claimCode(len = 8) {
  // Ambiguous characters removed: a code read off a receipt over a phone call
  // must not be mis-heard as a different valid code.
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = { newId, isId, idTime, docNumber, claimCode, ID_LEN };
