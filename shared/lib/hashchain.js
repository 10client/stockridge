// =====================================================================
// shared/lib/hashchain.js — TAMPER-EVIDENT, HASH-CHAINED REGISTERS
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: controlled_substance_register. That table was an
// APPEND-ONLY, HASH-CHAINED log of every controlled-drug dispense — buyer
// identity, quantity, dispenser — where each row stored the hash of the row
// before it. Editing or deleting a row in the middle breaks every subsequent
// link, and a verification query finds exactly where.
//
// StockRidge keeps the mechanism and generalises the purpose, because the
// control it provides is not specific to drugs at all. It is the answer to:
// "how do you make a record that a dishonest insider cannot quietly rewrite?"
//
// Applied to a general Nigerian retailer, the same chain protects:
//
//   HIGH_VALUE_REGISTER  every sale of a register-required line (phones,
//                        laptops, generators, mattresses on credit): buyer
//                        name, phone, ID type and number, serial(s), price,
//                        who rang it up. When a branch reports a missing
//                        laptop this is the record that says whether it was
//                        ever sold and to whom.
//
//   AGE_VERIFICATION_LOG every alcohol/tobacco/solvent sale where the operator
//                        confirmed the buyer's age. Recorded because a shop
//                        that cannot evidence the check has no defence.
//
//   AUTHORITY_DOCUMENT_LOG project and government sales where an authorising
//                        document was required. The document reference and who
//                        accepted it are chained, so a back-dated PO cannot be
//                        inserted to justify a sale that already happened.
//
//   CASH_MOVEMENT_CHAIN  large safe withdrawals and till voids, chained per
//                        branch per day.
//
// WHAT THIS IS NOT: it is not a blockchain, it is not distributed, and it does
// not make the data immutable. A determined attacker with database write
// access can recompute the whole chain. What it DOES do — and this is the whole
// point — is make a rewrite EXPENSIVE, VISIBLE and PROVABLE. An insider who
// deletes one row to hide one sale must recompute every row after it, and the
// verification query will show the break the moment anyone runs it. For the
// actual threat model here (a store manager covering a theft, not a nation-
// state), that is a genuine and sufficient deterrent.
//
// The chain is scoped PER BRANCH PER DAY. A single global chain would mean a
// Lagos sale and a Kano sale compete for the same previous-hash link, which
// serialises writes across the whole business and makes offline branches
// impossible. Per-branch-per-day chains are independent, so an offline branch
// can extend its own chain locally and the server can verify it on sync.

'use strict';

const { toKobo } = require('./money');

// SHA-256 is available as a Web Crypto global in Workers and browsers, and via
// node:crypto on the Node backend. To keep this file backend-neutral AND usable
// inside a synchronous code path (the Node backend computes hashes inside a
// transaction), the sync path uses node:crypto when present and the async path
// uses Web Crypto when it is not.
function sha256HexSync(input) {
  // eslint-disable-next-line global-require
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

async function sha256HexAsync(input) {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const data = new TextEncoder().encode(String(input));
    const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256HexSync(input);
}

const REGISTERS = Object.freeze([
  'HIGH_VALUE_REGISTER',
  'AGE_VERIFICATION_LOG',
  'AUTHORITY_DOCUMENT_LOG',
  'CASH_MOVEMENT_CHAIN',
  'DATA_EXPORT_LOG',      // who exported the customer list, and when
  'PRICE_OVERRIDE_LOG',   // every manual price change above a threshold
]);

const ID_TYPES = Object.freeze([
  'NIN', 'BVN', 'DRIVERS_LICENCE', 'INTERNATIONAL_PASSPORT', 'VOTERS_CARD',
  'STUDENT_ID', 'WORK_ID', 'COMPANY_CAC', 'UTILITY_BILL', 'OTHER',
]);

/**
 * The canonical string a row hashes to.
 *
 * FIELD ORDER IS PART OF THE CONTRACT. Changing it invalidates every existing
 * chain, so it is frozen here and versioned: `v` is included in the payload,
 * and a verifier that meets an unknown version says so rather than silently
 * producing a mismatch that looks like tampering.
 *
 * Nulls are encoded as the literal token `\x00` rather than an empty string,
 * so `field: null` and `field: ""` hash differently — otherwise an attacker
 * could clear a field without changing the hash.
 */
const CHAIN_VERSION = 1;
const NULL_TOKEN = '\x00';

function canonicalPayload(fields) {
  const parts = [`v${CHAIN_VERSION}`];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'prev_hash' || k === 'row_hash' || k === 'chain_key' || k === 'version') continue;
    let enc;
    if (v == null) enc = NULL_TOKEN;
    else if (v === '') enc = '';
    else if (typeof v === 'number') enc = Number.isFinite(v) ? String(Math.round(v * 100) / 100) : NULL_TOKEN;
    else if (typeof v === 'boolean') enc = v ? '1' : '0';
    else if (v instanceof Date) enc = v.toISOString();
    else enc = String(v).trim();
    parts.push(`${k}=${enc}`);
  }
  // Sorted keys so a caller passing fields in a different order produces the
  // same hash. Order-independence of the INPUT, order-dependence of the SCHEMA.
  return parts.sort().join('|');
}

function rowHash(fields, prevHash) {
  const payload = canonicalPayload(fields);
  return sha256HexSync(`${prevHash || GENESIS_HASH}::${payload}`);
}

async function rowHashAsync(fields, prevHash) {
  const payload = canonicalPayload(fields);
  return sha256HexAsync(`${prevHash || GENESIS_HASH}::${payload}`);
}

// The first row of a chain points at a fixed, published genesis value rather
// than NULL, so "no previous row" and "previous row was deleted" are
// distinguishable — a NULL prev_hash on row 5 is tampering, not a fresh chain.
const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Chain key = the scope a chain runs over. Per branch, per day, per register.
 * Independent scopes mean independent chains, which is what lets an offline
 * branch extend its own without coordinating with anyone.
 */
function chainKey({ register, branchId, dayIso }) {
  return `${String(register).toUpperCase()}::${String(branchId || 'GLOBAL')}::${String(dayIso || '0000-00-00').slice(0, 10)}`;
}

/**
 * Append a row. The caller supplies the previous row's hash (GENESIS_HASH for
 * the first in a chain) and gets back the row's own hash to store alongside it.
 *
 * Returns the full record so the caller persists exactly what was hashed —
 * hashing one thing and storing another is the mistake that makes a chain
 * unverifiable.
 */
function appendRow({ register, branchId, dayIso, fields, prevHash }) {
  const key = chainKey({ register, branchId, dayIso });
  const prev = prevHash || GENESIS_HASH;
  const hash = rowHash(fields, prev);
  return {
    register: String(register).toUpperCase(),
    branch_id: branchId || null,
    chain_key: key,
    chain_day: String(dayIso || new Date().toISOString().slice(0, 10)).slice(0, 10),
    prev_hash: prev,
    row_hash: hash,
    version: CHAIN_VERSION,
    payload_json: JSON.stringify(fields),
    ...fields,
  };
}

async function appendRowAsync({ register, branchId, dayIso, fields, prevHash }) {
  const key = chainKey({ register, branchId, dayIso });
  const prev = prevHash || GENESIS_HASH;
  const hash = await rowHashAsync(fields, prev);
  return {
    register: String(register).toUpperCase(),
    branch_id: branchId || null,
    chain_key: key,
    chain_day: String(dayIso || new Date().toISOString().slice(0, 10)).slice(0, 10),
    prev_hash: prev,
    row_hash: hash,
    version: CHAIN_VERSION,
    payload_json: JSON.stringify(fields),
    ...fields,
  };
}

/**
 * Verify a chain. Returns the FIRST break and everything after it, because a
 * break at row 7 makes rows 8..N unverifiable regardless of whether they were
 * also touched.
 *
 * Checks four distinct failure modes, reported separately, because they have
 * different causes and different remedies:
 *   LINK_BROKEN     row.prev_hash <> previous row's row_hash
 *                   -> a row was inserted, deleted or reordered
 *   CONTENT_BROKEN  recomputed hash of the stored fields <> stored row_hash
 *                   -> a field on this row was edited in place
 *   GENESIS_MISSING row 1 does not point at the published genesis value
 *                   -> the head of the chain was removed
 *   VERSION_UNKNOWN the row was written by a schema version we cannot verify
 */
function verifyChain(rows, { register, branchId, dayIso }) {
  const key = chainKey({ register, branchId, dayIso });
  const list = (rows || []).slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)));
  const breaks = [];

  if (!list.length) {
    return { ok: true, chainKey: key, rows: 0, breaks, verifiedAt: new Date().toISOString(), note: 'Empty chain — nothing has been recorded in this scope yet.' };
  }

  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    const version = Number(row.version || CHAIN_VERSION);

    if (version !== CHAIN_VERSION) {
      breaks.push({ index: i, rowId: row.id, type: 'VERSION_UNKNOWN', detail: `Written by chain version ${version}; this build verifies version ${CHAIN_VERSION}.` });
      // Cannot verify further: every subsequent prev_hash depends on this row.
      break;
    }

    if (String(row.prev_hash || '') !== expectedPrev) {
      breaks.push({
        index: i, rowId: row.id, type: i === 0 ? 'GENESIS_MISSING' : 'LINK_BROKEN',
        detail: i === 0
          ? 'The first row of this chain does not start from the published genesis value — the head has been removed or replaced.'
          : `Row ${i + 1} points at ${String(row.prev_hash).slice(0, 12)}… but the previous row hashes to ${expectedPrev.slice(0, 12)}…. A row was inserted, deleted or reordered here.`,
        expectedPrev, actualPrev: row.prev_hash,
      });
    }

    let fields = {};
    try {
      fields = row.payload_json ? JSON.parse(row.payload_json) : reconstructFields(row);
    } catch (e) {
      breaks.push({ index: i, rowId: row.id, type: 'PAYLOAD_UNREADABLE', detail: 'The stored payload could not be parsed.' });
    }

    const recomputed = rowHash(fields, String(row.prev_hash || ''));
    if (recomputed !== String(row.row_hash || '')) {
      breaks.push({
        index: i, rowId: row.id, type: 'CONTENT_BROKEN',
        detail: 'The fields stored on this row do not hash to the hash stored on it — this row was edited in place after it was written.',
        storedHash: row.row_hash, recomputedHash: recomputed,
      });
    }

    expectedPrev = String(row.row_hash || '');
  }

  return {
    ok: breaks.length === 0,
    chainKey: key,
    rows: list.length,
    breaks,
    firstBreakIndex: breaks.length ? breaks[0].index : null,
    unverifiableRows: breaks.length ? list.length - breaks[0].index : 0,
    verifiedAt: new Date().toISOString(),
    verifierNote: breaks.length
      ? `This register has been altered. ${breaks.length} problem(s) found, first at row ${breaks[0].index + 1}. Do not rely on entries after that point until the change is explained and documented.`
      : 'Chain intact — every entry follows from the one before it and no field has been altered.',
  };
}

/** Fallback when payload_json was not stored: rebuild from the known columns. */
function reconstructFields(row) {
  const skip = new Set(['id', 'register', 'branch_id', 'chain_key', 'chain_day', 'prev_hash', 'row_hash', 'version', 'payload_json', 'created_at', 'updated_at', 'is_deleted', 'recorded_by']);
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (!skip.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Normalise a high-value register entry. Enforces the identity capture that
 * makes the register useful: a row that says "sold a laptop" without a buyer
 * is worth nothing when the laptop goes missing.
 */
function highValueEntry({ saleId, saleNumber, branchId, productId, productName, serials, quantity, unitPrice, totalAmount, buyer, recordedBy, idType, idNumber, notes }) {
  const problems = [];
  if (!buyer || !String(buyer.name || '').trim()) problems.push('Buyer name is required for a register entry.');
  const phone = buyer && buyer.phone ? String(buyer.phone).replace(/\D/g, '') : '';
  if (phone && !/^0\d{10}$/.test(phone) && !/^234\d{10}$/.test(phone)) problems.push('Enter a valid Nigerian mobile number for the buyer.');

  const it = String(idType || '').toUpperCase();
  if (it && !ID_TYPES.includes(it)) problems.push(`ID type must be one of: ${ID_TYPES.join(', ')}`);
  // An ID type with no number, or a number with no type, is half a record.
  if (it && !idNumber) problems.push('An ID number is required when an ID type is given.');
  if (!it && idNumber) problems.push('Choose which kind of ID this number is.');

  if (!problems.length === false) {
    const err = new Error(problems.join(' '));
    err.status = 400; err.code = 'REGISTER_ENTRY_INCOMPLETE';
    throw err;
  }

  return {
    sale_id: saleId || null,
    sale_number: saleNumber || null,
    product_id: productId || null,
    product_name: productName || null,
    serial_numbers: (serials || []).join(','),
    quantity: Math.max(0, Math.floor(Number(quantity) || 0)),
    unit_price_kobo: toKobo(unitPrice || 0),
    total_amount_kobo: toKobo(totalAmount || 0),
    buyer_name: String(buyer.name).trim(),
    buyer_phone: phone ? (phone.startsWith('234') ? `0${phone.slice(3)}` : phone) : null,
    buyer_address: buyer.address ? String(buyer.address).slice(0, 300) : null,
    id_type: it || null,
    id_number: idNumber ? String(idNumber).trim().slice(0, 60) : null,
    recorded_by: recordedBy || null,
    notes: notes ? String(notes).slice(0, 500) : null,
  };
}

module.exports = {
  CHAIN_VERSION, GENESIS_HASH, REGISTERS, ID_TYPES,
  canonicalPayload, rowHash, rowHashAsync, chainKey,
  appendRow, appendRowAsync, verifyChain, reconstructFields, highValueEntry,
};
