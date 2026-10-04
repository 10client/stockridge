// =====================================================================
// shared/lib/wht.js — NIGERIAN WITHHOLDING TAX (2024 REGULATIONS)
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: server/lib/wht.js and worker/src/lib/wht.js were
// two copies of the same rules. StockRidge has ONE, imported by both backends.
//
// WHY THIS MATTERS MORE FOR A GENERAL RETAILER THAN FOR A PHARMACY:
// A pharmacy mostly buys from a handful of registered distributors. A
// wholesale/retail store, a furniture shop and a building-materials dealer buy
// from importers, from manufacturers, from artisans, from transporters and
// from landlords — and they SELL to corporates, to government and to
// contractors who will deduct WHT from their payments. Both directions of the
// tax therefore show up in ordinary trading:
//
//   PAYABLE   we deducted WHT from a supplier's invoice  -> remit to FIRS/LIRS
//   RECEIVABLE a customer deducted WHT from our invoice   -> we chase the
//             credit note, because it is a real asset until it lands
//
// RATES ARE DATA, NOT CODE. The Deduction of Tax at Source (Withholding)
// Regulations 2024 (effective 1 January 2025) changed rates materially and
// introduced a differential structure by company size. Hard-coding a
// percentage here would mean a statutory change requires a deployment while
// the client is mid-quarter. Rates live in `wht_rates` and are seeded from
// migrations/0005.
//
// 2024 REGULATION STRUCTURE (seeded, and editable by the client's OWNER):
//
//   Transaction type                          Small co.   Medium/Large
//   ---------------------------------------------------------------
//   Rent / royalties                            10%          10%
//   Dividends, interest                          10%          10%
//   Directors' fees (non-employment)             10%          10%
//   Building / construction / road contracts      5%           5%
//   Contracts of supply                          5%           5%
//   Agency / commission / brokerage              5%          10%
//   Consultancy / professional / technical       5%          10%
//   Management fees                              5%          10%
//   Transport (goods haulage)                    2%           2%
//   Advertising                                    -          5%
//
//   Company size for these purposes is by TURNOVER:
//     Small   <= NGN 25 million fixed assets AND <= NGN 25 million turnover
//     Medium  <= NGN 100 million fixed assets OR turnover
//     Large   >  NGN 100 million
//
// THE SMALL-COMPANY EXEMPTION (advisory, never blocking):
//   Under the 2024 Regulations a small company or unincorporated body need not
//   deduct WHT where the transaction value in the relevant CALENDAR MONTH is
//   not above NGN 2,000,000 AND the supplier holds a valid TIN.
//
//   This is surfaced as a HINT and never enforced, because whether a given
//   business is itself a "small company" depends on its own turnover and fixed
//   assets, which the system does not authoritatively know, and because the
//   NGN 2m test is per-supplier-per-month rather than per-transaction. The
//   owner knows; the software advises.

'use strict';

const { round2, toKobo, fromKobo } = require('./money');

const SMALL_COMPANY_MONTHLY_THRESHOLD = 2000000;

const DIRECTIONS = Object.freeze(['PAYABLE', 'RECEIVABLE', 'BOTH']);

const COMPANY_SIZES = Object.freeze([
  { code: 'SMALL',  label: 'Small (turnover <= ₦25m)',  maxTurnover: 25000000 },
  { code: 'MEDIUM', label: 'Medium (turnover <= ₦100m)', maxTurnover: 100000000 },
  { code: 'LARGE',  label: 'Large (turnover > ₦100m)',   maxTurnover: Infinity },
]);

// The seeded schedule. `direction` says which side of the transaction the rate
// applies to: PAYABLE = we deduct from a supplier; RECEIVABLE = a customer
// deducts from us; BOTH = either.
const SEED_RATES = Object.freeze([
  { code: 'RENT',            description: 'Rent and royalties',                       small: 10, medium: 10, large: 10, direction: 'BOTH' },
  { code: 'DIVIDEND',        description: 'Dividends',                                small: 10, medium: 10, large: 10, direction: 'RECEIVABLE' },
  { code: 'INTEREST',        description: 'Interest',                                 small: 10, medium: 10, large: 10, direction: 'BOTH' },
  { code: 'DIRECTORS_FEE',   description: "Directors' fees (not employment)",         small: 10, medium: 10, large: 10, direction: 'PAYABLE' },
  { code: 'CONSTRUCTION',    description: 'Building, construction and road contracts', small: 5,  medium: 5,  large: 5,  direction: 'BOTH' },
  { code: 'SUPPLY',          description: 'Contracts of supply',                      small: 5,  medium: 5,  large: 5,  direction: 'BOTH' },
  { code: 'AGENCY',          description: 'Agency arrangements',                      small: 5,  medium: 10, large: 10, direction: 'BOTH' },
  { code: 'COMMISSION',      description: 'Commission and brokerage',                 small: 5,  medium: 10, large: 10, direction: 'BOTH' },
  { code: 'CONSULTANCY',     description: 'Consultancy, professional and technical',  small: 5,  medium: 10, large: 10, direction: 'BOTH' },
  { code: 'MANAGEMENT_FEE',  description: 'Management fees',                          small: 5,  medium: 10, large: 10, direction: 'BOTH' },
  { code: 'TRANSPORT',       description: 'Transport / goods haulage',                small: 2,  medium: 2,  large: 2,  direction: 'BOTH' },
  { code: 'ADVERTISING',     description: 'Advertising',                              small: 0,  medium: 5,  large: 5,  direction: 'PAYABLE' },
]);

/**
 * Compute a deduction from a GROSS amount.
 *
 * DELIBERATELY TAKES GROSS, NEVER NET. A business always knows the invoice
 * value. Asking it to supply the net would mean grossing up, which is exactly
 * the "WHT as an additional contract cost" practice the 2024 Regulations
 * prohibit — and which suppliers will (correctly) refuse.
 */
function computeWht({ grossAmount, ratePercent }) {
  const g = Number(grossAmount);
  if (!Number.isFinite(g) || g < 0) {
    throw Object.assign(new Error('WHT gross amount must be a non-negative number'),
      { status: 400, code: 'WHT_INVALID_GROSS' });
  }
  const r = Number(ratePercent);
  if (!Number.isFinite(r) || r < 0 || r > 100) {
    throw Object.assign(new Error('WHT rate must be a percentage between 0 and 100'),
      { status: 400, code: 'WHT_INVALID_RATE' });
  }
  const grossK = toKobo(g);
  const whtK = Math.round((grossK * r) / 100);
  // NET BY SUBTRACTION. Rounding both legs independently is the classic way
  // `gross === net + wht` fails by a kobo — and the database CHECK constraint
  // then rejects an otherwise-correct entry, mid-transaction.
  const netK = grossK - whtK;
  return {
    gross: fromKobo(grossK),
    wht: fromKobo(whtK),
    net: fromKobo(netK),
    grossKobo: grossK,
    whtKobo: whtK,
    netKobo: netK,
    ratePercent: r,
  };
}

/** Resolve a rate row by code. Adapter-agnostic: takes a `db` handle. */
async function findRate(db, code) {
  if (!code) return null;
  const row = await db.prepare(
    `SELECT * FROM wht_rates
      WHERE code = ? AND is_active = 1 AND is_deleted = 0`
  ).bind(String(code).trim().toUpperCase()).first();
  return row || null;
}

/**
 * Resolve what a caller asked for into a validated deduction, or null when no
 * WHT applies. Centralised so every route rejects the same bad input in the
 * same way with the same error codes.
 *
 * `direction` is checked against the rate's own direction: a RECEIVABLE-only
 * rate must not be usable on a supplier payment, and vice versa. That check is
 * the difference between a WHT schedule and a WHT schedule that quietly lets
 * you book a receivable as a payable.
 */
async function resolveDeduction(db, { grossAmount, rateCode, ratePercentOverride, direction, companySize }) {
  if (!rateCode && ratePercentOverride == null) return null;

  const dir = String(direction || 'PAYABLE').toUpperCase();
  if (!DIRECTIONS.includes(dir)) {
    throw Object.assign(new Error(`WHT direction must be one of: ${DIRECTIONS.join(', ')}`),
      { status: 400, code: 'WHT_INVALID_DIRECTION' });
  }

  let ratePercent;
  let resolvedCode = rateCode ? String(rateCode).trim().toUpperCase() : 'CUSTOM';

  if (rateCode) {
    const row = await findRate(db, rateCode);
    if (!row) {
      throw Object.assign(
        new Error(`Unknown or inactive WHT rate "${rateCode}". Choose a rate from Settings → Withholding Tax, or add it there first.`),
        { status: 400, code: 'WHT_UNKNOWN_RATE' });
    }
    if (row.direction !== 'BOTH' && row.direction !== dir) {
      throw Object.assign(
        new Error(`WHT rate "${row.code}" applies to ${row.direction} transactions only and cannot be used on a ${dir} one.`),
        { status: 400, code: 'WHT_WRONG_DIRECTION' });
    }
    // The 2024 Regulations are size-differentiated. Pick the column that
    // matches OUR size as the deducting/claiming entity.
    ratePercent = resolveSizeColumn(row, companySize);
    resolvedCode = row.code;
  }

  // An explicit override wins, so a one-off non-resident rate or a tax
  // adviser's instruction does not require editing the shared schedule.
  if (ratePercentOverride != null) {
    const o = Number(ratePercentOverride);
    if (!Number.isFinite(o) || o < 0 || o > 100) {
      throw Object.assign(new Error('WHT rate must be a percentage between 0 and 100'),
        { status: 400, code: 'WHT_INVALID_RATE' });
    }
    ratePercent = o;
  }

  const computed = computeWht({ grossAmount, ratePercent });
  if (computed.whtKobo <= 0) return null; // a 0% rate is not a deduction

  if (computed.whtKobo > computed.grossKobo) {
    throw Object.assign(new Error('WHT cannot exceed the gross amount'),
      { status: 400, code: 'WHT_EXCEEDS_GROSS' });
  }

  return { ...computed, rateCode: resolvedCode, direction: dir };
}

function resolveSizeColumn(row, companySize) {
  const size = String(companySize || 'LARGE').toUpperCase();
  if (size === 'SMALL' && row.rate_percent_small != null) return Number(row.rate_percent_small);
  if (size === 'MEDIUM' && row.rate_percent_medium != null) return Number(row.rate_percent_medium);
  return Number(row.rate_percent != null ? row.rate_percent : row.rate_percent_large);
}

/**
 * Advisory exemption hint. Returns a message or null; NEVER blocks.
 *
 * Deliberately not a gate: blocking a legitimate deduction because the
 * software guessed the client's turnover band wrong would be far worse than
 * surfacing a hint the owner can dismiss.
 */
function exemptionHint({ grossAmount, counterpartyTin, calendarMonthTotal }) {
  const g = Number(grossAmount);
  if (!Number.isFinite(g)) return null;

  const monthTotal = Number.isFinite(Number(calendarMonthTotal)) ? Number(calendarMonthTotal) : g;
  if (monthTotal > SMALL_COMPANY_MONTHLY_THRESHOLD) return null;

  if (!counterpartyTin) {
    return 'Under the 2024 Regulations a small company need not deduct WHT on a transaction of ₦2,000,000 or less in a calendar month WHERE THE SUPPLIER HAS A VALID TIN. No TIN is recorded for this counterparty, so the exemption may not apply — confirm before relying on it.';
  }
  return 'This counterparty may qualify for the small-company exemption (≤ ₦2,000,000 in the calendar month, supplier holds TIN ₦'
    + String(counterpartyTin) + '). Confirm your own company size before applying WHT — this hint never blocks the entry.';
}

/**
 * Which FIRS/LIRS office and which form. Withholding tax remittance in
 * Nigeria is filed on Form 0103 (companies) within 21 days of the month end
 * in which the deduction was made.
 */
const REMITTANCE_DAY_OF_FOLLOWING_MONTH = 21;

function remittanceDueDate(entryDateIso) {
  const d = new Date(Date.parse(`${String(entryDateIso).slice(0, 10)}T00:00:00Z`));
  if (Number.isNaN(d.getTime())) return null;
  // 21st of the FOLLOWING month.
  const due = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, REMITTANCE_DAY_OF_FOLLOWING_MONTH));
  return due.toISOString().slice(0, 10);
}

/** Overdue receivables: credit notes we should have received by now. */
function receivableStatus({ entryDate, creditNoteReceived, today = new Date() }) {
  if (creditNoteReceived) return 'RECEIVED';
  const due = remittanceDueDate(entryDate);
  if (!due) return 'UNKNOWN';
  return due < today.toISOString().slice(0, 10) ? 'OVERDUE' : 'PENDING';
}

module.exports = {
  SMALL_COMPANY_MONTHLY_THRESHOLD, DIRECTIONS, COMPANY_SIZES, SEED_RATES,
  REMITTANCE_DAY_OF_FOLLOWING_MONTH,
  computeWht, findRate, resolveDeduction, resolveSizeColumn,
  exemptionHint, remittanceDueDate, receivableStatus, round2,
};
