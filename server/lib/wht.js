// =====================================================================
// StockRidge — WITHHOLDING TAX
// =====================================================================
// Deduction of Tax at Source (Withholding) Regulations 2024, effective
// 1 January 2025. Ported from PharmaRidge's lib/wht.js with the reasoning
// kept, because the reasoning is the compliance:
//
//   RATES ARE DATA, NOT CODE. Nigerian WHT rates changed materially under
//   the 2024 Regulations and they now differ by the COUNTERPARTY's company
//   size (small / medium / large) as well as by transaction type. Nothing
//   here hardcodes a percentage; a caller resolves a rate row from
//   wht_rates and passes the percentage in. A hardcoded rate is a
//   compliance bug waiting for the next gazette.
//
//   DEDUCTION IS COMPUTED FROM GROSS, NEVER NET. A business always knows
//   the invoice value; asking it to supply the net would mean grossing up,
//   which is precisely the "WHT as an additional contract cost" practice the
//   2024 Regulations prohibit.
//
//   NET IS DERIVED BY SUBTRACTION, never by a second independent rounding.
//   Rounding both legs separately is the classic way `gross = net + wht`
//   fails by a kobo, which the database CHECK constraint would then reject
//   outright — a hard failure at the point of posting, not a quiet drift.
//
//   THE SMALL-COMPANY EXEMPTION IS ADVISORY ONLY — warn, never block.
//   Whether a given business is itself a "small company" depends on its own
//   turnover, which this system does not authoritatively know, and the
//   ₦2,000,000 test is per-supplier-per-CALENDAR-MONTH rather than
//   per-transaction. So the app surfaces the hint and lets the owner — who
//   does know both facts — decide. A system that blocks on a guess would be
//   blocking real payments on the strength of an inference.
//
// WHAT IS NEW FOR A GENERAL BUSINESS: the transaction categories differ. A
// pharmacy deducts on professional fees and rent; an appliance wholesaler
// also deducts on contracts for installation, on agency/commission to sales
// agents, and on payments to distributors. The schedule below is seeded as
// data and is editable in Settings → Withholding Tax.
// =====================================================================

const { round2 } = require('../../shared/money');
const { HttpError } = require('./http');

// The small-company exemption threshold in the 2024 Regulations: a small
// company or unincorporated body need not deduct WHT where the transaction
// value in the relevant CALENDAR MONTH is not above ₦2,000,000 and the
// supplier holds a valid TIN.
const SMALL_COMPANY_MONTHLY_THRESHOLD = 2000000;

// Company-size bands used by the 2024 Regulations. Kept as codes because a
// rate row references one, and because "small" is defined by turnover in the
// Regulations rather than by intuition.
const COUNTERPARTY_TYPES = Object.freeze([
  'SMALL_COMPANY', 'MEDIUM_COMPANY', 'LARGE_COMPANY', 'COMPANY',
  'INDIVIDUAL', 'GOVERNMENT', 'NON_RESIDENT',
]);

// Seed schedule. Rates here reflect the 2024 Regulations' structure
// (differentiated by company size) and are loaded into wht_rates as DATA on
// first run — after which the OWNER/ADMIN edits the table, not this file.
// `rate_percent` is the general/company rate; `rate_percent_small_company`
// is the reduced rate the same transaction attracts where the counterparty
// is a small company.
const SEED_RATES = Object.freeze([
  { code: 'GOODS_SUPPLIER',    label: 'Purchase of goods / supplies',        category: 'PURCHASES',   direction: 'PAYABLE',   rate_percent: 0,   rate_percent_small_company: 0,  regulation_ref: 'Deduction of Tax at Source (Withholding) Regulations 2024', note: 'WHT on goods purchases was removed for most trading transactions under the 2024 Regulations. Verify against your tax adviser before enabling a rate here.' },
  { code: 'CONTRACTS',         label: 'Contracts (construction, installation, supply)', category: 'CONTRACTS', direction: 'BOTH', rate_percent: 5, rate_percent_small_company: 2, regulation_ref: '2024 Regulations — contracts' },
  { code: 'AGENCY_COMMISSION', label: 'Agency, commission & brokerage',      category: 'SERVICES',    direction: 'BOTH',      rate_percent: 10,  rate_percent_small_company: 5,  regulation_ref: '2024 Regulations — agency arrangements' },
  { code: 'PROFESSIONAL_FEES', label: 'Professional, management & technical fees', category: 'SERVICES', direction: 'BOTH', rate_percent: 10, rate_percent_small_company: 5, regulation_ref: '2024 Regulations — professional fees' },
  { code: 'RENT',              label: 'Rent (premises, plant, equipment)',   category: 'RENT',        direction: 'BOTH',      rate_percent: 10,  rate_percent_small_company: 5,  regulation_ref: '2024 Regulations — rent' },
  { code: 'DIRECTORS_FEES',    label: 'Directors\u2019 fees (non-executive)', category: 'FEES',        direction: 'PAYABLE',   rate_percent: 10,  rate_percent_small_company: 10, regulation_ref: '2024 Regulations — directors' },
  { code: 'DIVIDENDS',         label: 'Dividends',                           category: 'INVESTMENT',  direction: 'RECEIVABLE', rate_percent: 10, rate_percent_small_company: 10, regulation_ref: '2024 Regulations — dividends' },
  { code: 'INTEREST',          label: 'Interest',                            category: 'INVESTMENT',  direction: 'RECEIVABLE', rate_percent: 10, rate_percent_small_company: 10, regulation_ref: '2024 Regulations — interest' },
  { code: 'ROYALTIES',         label: 'Royalties',                           category: 'INVESTMENT',  direction: 'RECEIVABLE', rate_percent: 10, rate_percent_small_company: 5, regulation_ref: '2024 Regulations — royalties' },
  { code: 'NON_RESIDENT',      label: 'Non-resident supplier (no PE in Nigeria)', category: 'IMPORT', direction: 'PAYABLE',  rate_percent: 10,  rate_percent_small_company: null, regulation_ref: '2024 Regulations — non-residents', note: 'A non-resident without a Nigerian permanent establishment is outside the small-company band, so no reduced rate applies.' },
]);

function computeWht({ grossAmount, ratePercent }) {
  if (!Number.isFinite(grossAmount) || grossAmount < 0) {
    throw new HttpError(400, 'WHT gross amount must be a non-negative number.', 'WHT_INVALID_GROSS');
  }
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    throw new HttpError(400, 'WHT rate must be a percentage between 0 and 100.', 'WHT_INVALID_RATE');
  }
  const gross = round2(grossAmount);
  const wht = round2((gross * ratePercent) / 100);
  const net = round2(gross - wht);            // SUBTRACTION, never a second rounding
  return { gross, wht, net, ratePercent };
}

// Resolve the rate for a counterparty. A small company gets the reduced
// rate; anything else gets the general one. The choice is recorded on the
// entry so an auditor can see WHICH band was applied and why.
function rateForCounterparty(rateRow, counterpartyType) {
  if (!rateRow) return null;
  const type = String(counterpartyType || '').toUpperCase();
  const reduced = rateRow.rate_percent_small_company;
  if (type === 'SMALL_COMPANY' && reduced != null && Number.isFinite(Number(reduced))) {
    return { rate_percent: Number(reduced), band: 'SMALL_COMPANY' };
  }
  return { rate_percent: Number(rateRow.rate_percent), band: type || 'GENERAL' };
}

async function findRate(db, code, { businessUnitId = null } = {}) {
  if (!code) return null;
  const key = String(code).trim().toUpperCase();
  // A client-specific row beats the system schedule, so a business can
  // override one rate without editing the shared seed.
  const row = await db.prepare(`
    SELECT * FROM wht_rates
    WHERE code = ? AND is_active = 1 AND is_deleted = 0
      AND (business_unit_id = ? OR (business_unit_id IS NULL AND is_system = 1))
      AND effective_from <= date('now','+1 hour')
      AND (effective_to IS NULL OR effective_to >= date('now','+1 hour'))
    ORDER BY (business_unit_id IS NULL) ASC, effective_from DESC
    LIMIT 1
  `).bind(key, businessUnitId || '__none__').first();
  return row || null;
}

// Resolve what a caller asked for into a validated deduction, or null when
// no WHT applies. Centralised so every route rejects the same bad input in
// the same way with the same error codes.
//
// `direction` is checked against the rate's own direction: a RECEIVABLE-only
// rate must not be usable on a supplier payment, and vice versa. That guard
// is what stops a user "fixing" a customer's deduction by applying it to the
// wrong side of the ledger.
async function resolveDeduction(db, {
  grossAmount, rateCode, ratePercentOverride, direction, counterpartyType = null, businessUnitId = null,
}) {
  if (!rateCode && ratePercentOverride == null) return null;

  let ratePercent;
  let resolvedCode = rateCode ? String(rateCode).trim().toUpperCase() : 'CUSTOM';
  let band = counterpartyType ? String(counterpartyType).toUpperCase() : 'GENERAL';
  let regulationRef = null;

  if (rateCode) {
    const row = await findRate(db, rateCode, { businessUnitId });
    if (!row) {
      throw new HttpError(400,
        `Unknown or inactive WHT rate "${rateCode}". Choose a rate from Settings → Withholding Tax, or add it there first.`,
        'WHT_UNKNOWN_RATE');
    }
    if (row.direction !== 'BOTH' && row.direction !== direction) {
      throw new HttpError(400,
        `WHT rate "${row.code}" applies to ${row.direction === 'PAYABLE' ? 'payments you make' : 'amounts deducted from you'} only and cannot be used on a ${direction === 'PAYABLE' ? 'payment you make' : 'receipt'} .`,
        'WHT_WRONG_DIRECTION');
    }
    const resolved = rateForCounterparty(row, counterpartyType);
    ratePercent = resolved.rate_percent;
    band = resolved.band;
    resolvedCode = row.code;
    regulationRef = row.regulation_ref || null;
  }

  // An explicit override wins, so a one-off non-resident rate or a tax
  // adviser's instruction does not require editing the shared schedule.
  if (ratePercentOverride != null) {
    if (!Number.isFinite(ratePercentOverride) || ratePercentOverride < 0 || ratePercentOverride > 100) {
      throw new HttpError(400, 'WHT rate must be a percentage between 0 and 100.', 'WHT_INVALID_RATE');
    }
    ratePercent = ratePercentOverride;
    band = 'OVERRIDE';
  }

  const computed = computeWht({ grossAmount, ratePercent });
  if (computed.wht <= 0) return null;               // a 0% rate is not a deduction
  if (computed.wht > computed.gross) {
    throw new HttpError(400, 'WHT cannot exceed the gross amount.', 'WHT_EXCEEDS_GROSS');
  }

  return {
    ...computed,
    rateCode: resolvedCode,
    ratePercent,
    counterpartyBand: band,
    regulationRef,
  };
}

// Advisory exemption hint. Returns a message or null; NEVER BLOCKS.
function exemptionHint({ grossAmount, counterpartyTin, counterpartyType, monthlyTotalForCounterparty = 0 }) {
  if (!Number.isFinite(grossAmount)) return null;
  const combined = round2((Number(monthlyTotalForCounterparty) || 0) + grossAmount);
  if (combined > SMALL_COMPANY_MONTHLY_THRESHOLD) return null;
  if (!counterpartyTin) {
    return `Under the 2024 Regulations a small company need not deduct WHT on a transaction of ₦2,000,000 or less in a calendar month WHERE THE SUPPLIER HAS A VALID TIN. `
      + `No TIN is recorded for this counterparty — add one under Suppliers if they have one, or apply the deduction.`;
  }
  if (String(counterpartyType || '').toUpperCase() !== 'SMALL_COMPANY') return null;
  return `This counterparty is marked as a small company and the month's total with them is ₦${combined.toLocaleString('en-NG')}, which is within the ₦2,000,000 threshold. `
    + 'You may be entitled not to deduct WHT. This is a hint, not a determination — your accountant decides.';
}

// Running total for a counterparty in the current calendar month, which is
// the basis of the ₦2m test. Without it the hint would be per-transaction
// and therefore wrong: eleven ₦190,000 invoices to one supplier are over the
// threshold even though no single one is.
async function monthToDateTotal(db, { businessUnitId, direction, counterpartyName, tin, month }) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(gross_amount), 0) AS total, COUNT(*) AS entries
    FROM wht_entries
    WHERE is_deleted = 0
      AND direction = ?
      AND filed_period = ?
      AND (? IS NULL OR business_unit_id = ?)
      AND (lower(counterparty_name) = lower(?) OR (counterparty_tin IS NOT NULL AND counterparty_tin = ?))
  `).bind(
    direction, month, businessUnitId || null, businessUnitId || null,
    String(counterpartyName || ''), tin || '__none__'
  ).first();
  return { total: round2((row && row.total) || 0), entries: (row && row.entries) || 0 };
}

function filingPeriod(dateStr) {
  return String(dateStr || '').slice(0, 7);
}

module.exports = {
  SMALL_COMPANY_MONTHLY_THRESHOLD, COUNTERPARTY_TYPES, SEED_RATES,
  computeWht, rateForCounterparty, findRate, resolveDeduction,
  exemptionHint, monthToDateTotal, filingPeriod, round2,
};
'use strict';
