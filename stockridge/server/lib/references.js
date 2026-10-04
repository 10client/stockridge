// =====================================================================
// StockRidge — REFERENCE NUMBERS
// =====================================================================
// Receipts, POs, transfers, plans, holds, deliveries, returns and claims all
// need a number a human can read aloud over the phone and quote on a
// complaint. Two properties matter:
//
//   1. UNIQUE. Two tills issuing the same receipt number is not a cosmetic
//      problem — it is an unreconcilable cash dispute and a VAT filing error.
//   2. STABLE ACROSS RETRIES. An offline queue replaying a sale must not
//      mint a second receipt number for the same sale.
//
// The naive implementation — SELECT MAX(seq)+1 FROM sales — fails both. It
// races between two concurrent tills, and it gets slower every day forever
// as the table grows. So sequences live in their own table with a
// PRIMARY KEY per (business, branch, prefix, period), and allocation is a
// single UPDATE ... SET current_value = current_value + 1 followed by a
// read. On SQLite that is serialised by the write lock; the same shape maps
// to a D1 batch.
//
// The returned number embeds the branch code and the year:
//     SR-LAG-2026-000431
// so a receipt found on the floor of any branch identifies itself without
// anyone opening the system.
// =====================================================================

const { watDate } = require('../../shared/ids');

const PREFIXES = Object.freeze({
  SALE: 'SR',
  RETURN: 'RT',
  PURCHASE_ORDER: 'PO',
  GRN: 'GRN',
  TRANSFER: 'TR',
  STOCKTAKE: 'ST',
  ADJUSTMENT: 'ADJ',
  PAYMENT_PLAN: 'PP',
  PLAN_RECEIPT: 'PR',
  LAYAWAY: 'LH',
  LAYAWAY_RECEIPT: 'LR',
  DELIVERY_JOB: 'DJ',
  WARRANTY_CLAIM: 'WC',
  CHANGE_CLAIM: 'CC',
  TILL_SESSION: 'TS',
  EXPENSE: 'EX',
  JOURNAL: 'JV',
});

function periodKey({ scope = 'YEAR', now = new Date() } = {}) {
  if (scope === 'YEAR') return String(now.getUTCFullYear());
  if (scope === 'MONTH') return watDate(now).slice(0, 7).replace('-', '');
  if (scope === 'DAY') return watDate(now).replace(/-/g, '');
  return '*';
}

// Allocate the next number for a prefix. `branchCode` of '*' means a
// business-wide sequence (used for POs and plans, which are quoted across
// branches); a real branch code scopes it to that branch (receipts and tills).
async function nextReference(db, {
  businessUnitId,
  prefix,
  branchCode = '*',
  scope = 'YEAR',
  now = new Date(),
  padWidth = 6,
}) {
  const period = periodKey({ scope, now });
  const key = String(prefix).toUpperCase();

  // UPSERT-then-increment. `INSERT ... ON CONFLICT DO UPDATE` is supported
  // by both better-sqlite3 and D1, and doing it in ONE statement avoids a
  // read-modify-write race between two tills.
  await db.prepare(`
    INSERT INTO reference_sequences (business_unit_id, branch_code, prefix, period, current_value, updated_at)
    VALUES (?,?,?,?,1,datetime('now','+1 hour'))
    ON CONFLICT (business_unit_id, branch_code, prefix, period)
    DO UPDATE SET current_value = current_value + 1, updated_at = datetime('now','+1 hour')
  `).bind(businessUnitId, String(branchCode).toUpperCase(), key, period).run();

  const row = await db.prepare(`
    SELECT current_value FROM reference_sequences
    WHERE business_unit_id = ? AND branch_code = ? AND prefix = ? AND period = ?
  `).bind(businessUnitId, String(branchCode).toUpperCase(), key, period).first();

  const seq = (row && Number(row.current_value)) || 1;
  const branchPart = String(branchCode).toUpperCase() === '*' ? null : String(branchCode).toUpperCase();
  const parts = [key];
  if (branchPart) parts.push(branchPart);
  if (period !== '*') parts.push(period);
  parts.push(String(seq).padStart(padWidth, '0'));
  return { reference: parts.join('-'), sequence: seq, period };
}

// A claim code a customer can read off a receipt and quote at ANY branch to
// collect change owed. Short, unambiguous, and excludes the characters that
// get confused when read aloud over a noisy counter: 0/O, 1/I/L, 5/S, 8/B.
const CLAIM_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY3479';

function claimCode({ prefix = 'CHG', length = 6 } = {}) {
  const bytes = new Uint8Array(length);
  (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CLAIM_ALPHABET[bytes[i] % CLAIM_ALPHABET.length];
  return `${prefix}-${out}`;
}

// Group a claim code for reading aloud: "CHG-4K7D 9M2P".
function formatClaimCode(code) {
  const s = String(code || '');
  const body = s.includes('-') ? s.slice(s.indexOf('-') + 1) : s;
  const head = s.includes('-') ? s.slice(0, s.indexOf('-')) : '';
  const groups = body.match(/.{1,4}/g) || [];
  return head ? `${head}-${groups.join(' ')}` : groups.join(' ');
}

// Normalise what a customer typed back at the counter. Accepts any
// spacing/case and the confusable characters, because a code that cannot be
// typed correctly by the person it was given to is not a code.
function normaliseClaimCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  const [maybePrefix, ...rest] = s.split('-');
  const body = (rest.length ? rest.join('') : maybePrefix).replace(/[^A-Z0-9]/g, '');
  // Map the visually confusable characters back. This is lossy by design
  // and safe here because the alphabet excludes the targets.
  const fixed = body.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  const prefix = rest.length ? maybePrefix : 'CHG';
  return { prefix, body: fixed, joined: `${prefix}-${fixed}` };
}

module.exports = { PREFIXES, periodKey, nextReference, claimCode, formatClaimCode, normaliseClaimCode, CLAIM_ALPHABET };
'use strict';
