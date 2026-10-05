'use strict';
// =====================================================================
// domain/nigerianTax.js — VAT and Withholding Tax under Nigerian law
// =====================================================================
// TWO RULES THAT ARE NOT NEGOTIABLE, BOTH LEARNED THE HARD WAY
//
// 1. VAT IS INCLUSIVE, NEVER ADDITIVE.
//    Enabling VAT must NOT increase what a customer pays at the counter.
//    Nigerian retail shelf prices already include VAT, so a shop that
//    "turns VAT on" and watches its prices rise by 7.5% has just priced
//    itself out of its own market. `total` is unchanged by the toggle;
//    vat_amount is EXTRACTED from the existing total for reporting and
//    remittance bookkeeping only.
//
//    Extraction from a VAT-inclusive amount:  vat = total * r / (100 + r)
//    The naive `total * r / 100` computes VAT on a VAT-exclusive base and
//    over-reports the liability by r% of itself — on ₦10m of monthly
//    turnover at 7.5% that is ₦5,581 of phantom VAT, which then has to be
//    reconciled against a FIRS return that does not agree.
//
// 2. WHT RATES ARE DATA, NOT CODE.
//    Nigerian rates changed materially under the Deduction of Tax at Source
//    (Withholding) Regulations 2024, effective 1 January 2025. Nothing here
//    hardcodes a percentage; callers resolve a rate ROW and pass the
//    percentage in, so the next change is a data edit and not a deploy.
// =====================================================================

const { round2 } = require('./money');

// Nigeria's standard FIRS VAT rate. The OWNER may change it in Settings if
// the statutory rate ever moves; the app never assumes.
const DEFAULT_VAT_RATE_PERCENT = 7.5;

// The small-company exemption in the 2024 Regulations: a small company or
// unincorporated body need not deduct WHT where the transaction value in
// the relevant CALENDAR MONTH is not above ₦2,000,000 AND the supplier
// holds a valid TIN.
const SMALL_COMPANY_MONTHLY_THRESHOLD = 2000000;

// WHT is remitted by the 21st day of the FOLLOWING month.
const WHT_REMITTANCE_DAY_OF_MONTH = 21;

// ---------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------

/**
 * Extract VAT from a VAT-INCLUSIVE total.
 * Returns the VAT component and the net-of-VAT figure, which foot to the
 * total to the kobo: total = net + vat, derived by SUBTRACTION so a second
 * independent rounding can never break that equality.
 */
function extractVatFromInclusive({ grossAmount, ratePercent }) {
  const rate = Number(ratePercent);
  const gross = round2(Number(grossAmount) || 0);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw Object.assign(new Error('VAT rate must be a percentage between 0 and 100'), { status: 400, code: 'VAT_INVALID_RATE' });
  }
  if (rate === 0) return { gross, vat: 0, net: gross, ratePercent: 0, inclusive: true };
  const vat = round2((gross * rate) / (100 + rate));
  return { gross, vat, net: round2(gross - vat), ratePercent: rate, inclusive: true };
}

/**
 * Add VAT to a VAT-EXCLUSIVE amount. Used for B2B invoicing where a
 * corporate customer expects to see VAT added on top of a quoted net
 * price — a genuinely different document from a shop receipt, and the
 * reason both directions exist here.
 */
function addVatToExclusive({ netAmount, ratePercent }) {
  const rate = Number(ratePercent);
  const net = round2(Number(netAmount) || 0);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw Object.assign(new Error('VAT rate must be a percentage between 0 and 100'), { status: 400, code: 'VAT_INVALID_RATE' });
  }
  const vat = round2((net * rate) / 100);
  return { net, vat, gross: round2(net + vat), ratePercent: rate, inclusive: false };
}

/**
 * Split VAT across lines proportionally to line value, with the remainder
 * assigned to the largest line so the parts foot to the whole exactly.
 * Without this, per-category VAT reporting does not sum to the invoice's
 * VAT figure and the accountant has to explain the difference to FIRS.
 */
function allocateVatAcrossLines({ totalVat, lineValues }) {
  const total = round2(Number(totalVat) || 0);
  const values = (lineValues || []).map((v) => Math.max(0, Number(v) || 0));
  if (!values.length || total === 0) return values.map(() => 0);
  const weightSum = values.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) return values.map(() => 0);
  let assigned = 0;
  const out = values.map(() => 0);
  // Largest line last, so it absorbs the rounding remainder.
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  order.forEach((idx, pos) => {
    if (pos === order.length - 1) { out[idx] = round2(total - assigned); return; }
    const share = round2((total * values[idx]) / weightSum);
    out[idx] = share;
    assigned = round2(assigned + share);
  });
  return out;
}

// ---------------------------------------------------------------------
// WITHHOLDING TAX
// ---------------------------------------------------------------------

/**
 * Compute a deduction from a GROSS amount.
 *
 * Deliberately takes GROSS, never net. A business always knows the invoice
 * value; asking it to supply the net would mean grossing up, which is
 * exactly the "WHT as an additional contract cost" practice the 2024
 * Regulations prohibit.
 */
function computeWht({ grossAmount, ratePercent }) {
  if (!Number.isFinite(grossAmount) || grossAmount < 0) {
    throw Object.assign(new Error('WHT gross amount must be a non-negative number'), { status: 400, code: 'WHT_INVALID_GROSS' });
  }
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    throw Object.assign(new Error('WHT rate must be a percentage between 0 and 100'), { status: 400, code: 'WHT_INVALID_RATE' });
  }
  const gross = round2(grossAmount);
  const wht = round2((gross * ratePercent) / 100);
  // Derive net by SUBTRACTION, never by a second independent rounding.
  // Rounding both legs separately is the classic way gross = net + wht
  // fails by a kobo, which the database CHECK then rejects outright — at
  // the moment somebody is trying to pay a supplier.
  const net = round2(gross - wht);
  return { gross, wht, net, ratePercent };
}

/** Look up an active rate by code. Returns null rather than throwing so a caller can distinguish "no WHT requested" from "bad code". */
async function findRate(db, code) {
  if (!code) return null;
  return db.first('SELECT * FROM wht_rates WHERE code = ? AND is_active = 1 AND is_deleted = 0', [String(code).trim().toUpperCase()]);
}

/**
 * Resolve what a caller asked for into a validated deduction, or null when
 * no WHT applies. Centralised so every route rejects the same bad input in
 * the same way with the same error codes.
 *
 * `direction` is checked against the rate's own direction: a RECEIVABLE-only
 * rate must not be usable on an expense, and vice versa.
 */
async function resolveDeduction(db, { grossAmount, rateCode, ratePercentOverride, direction }) {
  if (!rateCode && ratePercentOverride == null) return null;

  let ratePercent;
  let resolvedCode = rateCode ? String(rateCode).trim().toUpperCase() : 'CUSTOM';

  if (rateCode) {
    const row = await findRate(db, rateCode);
    if (!row) {
      throw Object.assign(
        new Error(`Unknown or inactive WHT rate "${rateCode}". Choose a rate from Settings → Withholding Tax, or add it there first.`),
        { status: 400, code: 'WHT_UNKNOWN_RATE' },
      );
    }
    if (row.direction !== 'BOTH' && row.direction !== direction) {
      throw Object.assign(
        new Error(`WHT rate "${row.code}" applies to ${row.direction} transactions only and cannot be used on a ${direction} one.`),
        { status: 400, code: 'WHT_WRONG_DIRECTION' },
      );
    }
    ratePercent = Number(row.rate_percent);
    resolvedCode = row.code;
  }

  // An explicit override wins, so a one-off non-resident rate or a tax
  // adviser's instruction does not require editing the shared schedule.
  if (ratePercentOverride != null) {
    if (!Number.isFinite(ratePercentOverride) || ratePercentOverride < 0 || ratePercentOverride > 100) {
      throw Object.assign(new Error('WHT rate must be a percentage between 0 and 100'), { status: 400, code: 'WHT_INVALID_RATE' });
    }
    ratePercent = Number(ratePercentOverride);
  }

  const computed = computeWht({ grossAmount, ratePercent });
  if (computed.wht <= 0) return null; // a 0% rate is not a deduction
  if (computed.wht > computed.gross) {
    throw Object.assign(new Error('WHT cannot exceed the gross amount'), { status: 400, code: 'WHT_EXCEEDS_GROSS' });
  }
  return { ...computed, rateCode: resolvedCode };
}

/**
 * Advisory exemption hint. Returns a message or null; NEVER blocks.
 *
 * Whether a given business is itself a "small company" depends on its own
 * turnover, which this system does not authoritatively know, and the ₦2m
 * test is per-supplier-per-month rather than per-transaction. So the app
 * surfaces the hint and lets the owner — who does know — decide.
 */
function exemptionHint({ grossAmount, counterpartyTin, counterpartyIsManufacturer = false }) {
  if (!Number.isFinite(grossAmount)) return null;
  if (grossAmount > SMALL_COMPANY_MONTHLY_THRESHOLD) return null;
  if (counterpartyIsManufacturer) {
    return 'Goods manufactured or materials produced by the supplier itself are NOT liable to the 2% supply-of-goods deduction under the 2024 Regulations. This supplier is flagged as a manufacturer, so a deduction here is usually wrong.';
  }
  if (!counterpartyTin) {
    return 'Under the 2024 Regulations a small company need not deduct WHT on a transaction of ₦2,000,000 or less in a calendar month WHERE THE SUPPLIER HAS A VALID TIN. No TIN is recorded for this counterparty — add one in Suppliers, or deduct and issue a credit note.';
  }
  return 'This transaction is ₦2,000,000 or less. If you are a small company and this supplier holds a valid TIN, the 2024 Regulations do not require a deduction. This is a hint, not a block — the decision is yours.';
}

/** Due date for remitting WHT deducted in a given month. */
function whtRemittanceDueDate(monthString) {
  const m = String(monthString || '').slice(0, 7); // YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(m)) return null;
  const [y, mo] = m.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo, WHT_REMITTANCE_DAY_OF_MONTH)); // mo is 1-based, so this is the following month
  return next.toISOString().slice(0, 10);
}

/**
 * The shipped WHT schedule under the Deduction of Tax at Source
 * (Withholding) Regulations 2024, effective 1 January 2025.
 *
 * These are SEED DATA. They are inserted with is_system = 1 so a client
 * edit stays distinguishable from the shipped schedule, and a client may
 * override any of them — some practitioners argue s.72 PITA's 10% still
 * governs directors' fees, and the owner is the one who has to file.
 */
const WHT_SCHEDULE_2024 = Object.freeze([
  { code: 'RENT', name: 'Rent, Hire or Lease', rate_percent: 10.0, direction: 'BOTH', note: 'Rent on land, buildings or equipment. 10% for resident corporate and non-corporate recipients.' },
  { code: 'PROFESSIONAL_FEES', name: 'Professional, Consultancy, Technical & Management Fees', rate_percent: 5.0, direction: 'BOTH', note: 'Reduced from 10% to 5% by the 2024 Regulations for residents. Non-residents attract 10%, treated as a final tax.' },
  { code: 'COMMISSION', name: 'Commission & Brokerage', rate_percent: 5.0, direction: 'BOTH', note: '5% for residents; 10% for non-residents.' },
  { code: 'SUPPLY_OF_GOODS', name: 'Supply of Goods or Materials', rate_percent: 2.0, direction: 'BOTH', note: 'Reduced to 2% by the 2024 Regulations. IMPORTANT EXEMPTION: goods manufactured or materials produced by the supplier itself are NOT liable — so a deduction against a manufacturer is usually wrong, while a distributor or wholesaler is liable.' },
  { code: 'OTHER_SERVICES', name: 'Supply or Rendering of Other Services', rate_percent: 2.0, direction: 'BOTH', note: 'Any service not specifically listed in the Schedule: 2% for residents, 5% for non-residents. Covers cleaning, security, haulage and similar.' },
  { code: 'CONSTRUCTION', name: 'Construction of Roads, Bridges, Buildings & Power Plants', rate_percent: 2.0, direction: 'PAYABLE', note: '2% for residents. Other construction and related activities attract 5%.' },
  { code: 'DIRECTORS_FEES', name: "Directors' Fees", rate_percent: 15.0, direction: 'PAYABLE', note: "INCREASED to 15% by the 2024 Regulations for residents (20% non-resident, final tax). Note some practitioners argue s.72 PITA's 10% still governs; the owner can edit this rate if their tax adviser directs otherwise." },
  { code: 'DIVIDEND_INTEREST', name: 'Dividend & Interest', rate_percent: 10.0, direction: 'BOTH', note: 'Unchanged at 10%. Interest and fees paid to a Nigerian bank by direct debit of funds domiciled with that bank are exempt.' },
  { code: 'ROYALTY', name: 'Royalty', rate_percent: 10.0, direction: 'BOTH', note: '10% to corporate recipients, 5% to individuals.' },
  { code: 'CONTRACTS_AGENCY', name: 'Contracts & Agency Arrangements', rate_percent: 5.0, direction: 'BOTH', note: '5% for residents on contracts and agency arrangements.' },
]);

module.exports = {
  DEFAULT_VAT_RATE_PERCENT, SMALL_COMPANY_MONTHLY_THRESHOLD, WHT_REMITTANCE_DAY_OF_MONTH,
  extractVatFromInclusive, addVatToExclusive, allocateVatAcrossLines,
  computeWht, findRate, resolveDeduction, exemptionHint, whtRemittanceDueDate,
  WHT_SCHEDULE_2024,
};
