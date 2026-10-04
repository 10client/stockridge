// =====================================================================
// StockRidge — NIGERIAN TAX ENGINE (VAT + Withholding Tax)
// =====================================================================
// Reconstructed from PharmaRidge's domain/wht.js, corrected and extended
// to the regime actually in force as at October 2026.
//
// ---------------------------------------------------------------------
// WHAT THE LAW SAYS (verified, not assumed — see docs/TAX-COMPLIANCE.md
// for the sources and the date each was checked)
// ---------------------------------------------------------------------
// VAT — Nigeria Tax Act 2025, effective 1 January 2026:
//   * Standard rate UNCHANGED at 7.5%. The proposed rise to 12.5%/15%
//     was rejected by the National Assembly.
//   * Registration trigger: turnover above ₦25,000,000 in any 12
//     consecutive months. Below that, registration is voluntary.
//   * ZERO-RATED (0%, input VAT recoverable): basic food items, medical
//     and pharmaceutical products, educational books and materials,
//     tuition, residential rent, exports.
//   * NEW under the NTA 2025: input VAT is recoverable on SERVICES and
//     CAPITAL ASSETS, not only on goods. That is a real cash-flow change
//     for a retailer buying delivery trucks and shopfitting services.
//   * Returns due by the 21st of the following month. Late filing:
//     ₦100,000 for the first month + ₦50,000 for each subsequent month.
//   * Administered by the Nigeria Revenue Service (NRS, formerly FIRS).
//   * E-invoicing is being phased in by turnover band: >₦5bn live since
//     November 2025; ₦1bn–₦5bn live July 2026 (enforced Jan 2027);
//     <₦1bn live July 2027 (enforced Jan 2028).
//
// Withholding Tax — Deduction of Tax at Source (Withholding) Regulations
// 2024, effective 1 July 2024, and still operative under the NTA 2025:
//   * Supply of goods or materials (other than by the manufacturer or
//     producer):                     2%  resident / 2%  non-resident
//   * General (unlisted) services:   2%  resident / 5%  non-resident
//   * Commission, consultancy, technical, management, professional fees:
//                                    5%  resident / 10% non-resident (final)
//   * Brokerage:                     5%  resident / 10% non-resident
//   * Construction of roads, bridges, buildings, power plants:
//                                    2%  resident / 5%  non-resident
//   * Other construction & installation: 5% resident / 10% non-resident
//   * Rent, hire, lease:             5%  resident / 10% non-resident
//   * Dividends, interest:          10%  resident / 10% non-resident
//   * Royalties:                    10%  resident / 5%  non-resident (individual)
//   * Directors' fees:              15%  resident / 20% non-resident
//   * NO TIN → the rate is DOUBLED (non-passive income).
//   * Small company / unincorporated body is EXEMPT from deducting WHT
//     where the supplier holds a valid TIN AND the transaction value is
//     ₦2,000,000 or less in the relevant CALENDAR MONTH.
//   * EXEMPT transactions include "across-the-counter" transactions —
//     a non-contractual arrangement paid instantly in cash or on the spot
//     by electronic means. This is the single most important rule for a
//     RETAIL app: the shop selling a fridge over the counter for cash is
//     not deducting WHT from its customer, and the customer buying stock
//     over the counter is not deducting WHT from the shop.
//   * Remittance/return due by the 21st (10th day following the month of
//     payment under the 2024 Regulations) — configurable below.
//   * WHT is NOT a separate tax and must NOT be grossed up: it is a
//     deduction FROM the transaction value, being an advance payment of
//     the supplier's income tax.
//
// ---------------------------------------------------------------------
// DESIGN DECISIONS (each one a deliberate answer to a real problem)
// ---------------------------------------------------------------------
// 1. RATES ARE DATA, NOT CODE. They live in the wht_rates table and this
//    file only supplies the SEED. Nigerian rates changed materially in
//    July 2024 and will change again; a hardcoded 5% in an if-statement
//    means a redeploy to apply a gazette.
// 2. GROSS IN, NEVER NET IN. computeWht() takes the gross (the invoice
//    value, which is the only figure anyone actually has) and derives net
//    by SUBTRACTION. Grossing up is exactly the "WHT as an additional
//    contract cost" practice the 2024 Regulations prohibit, and deriving
//    net by a second independent rounding is how gross = net + wht fails
//    by a kobo and trips the database CHECK.
// 3. ADVISORY, NOT BLOCKING. The small-company exemption and the
//    over-the-counter exemption produce HINTS. The app cannot know a
//    client's own turnover band or whether a particular supplier is a
//    manufacturer, and a checkout that refuses to complete over a tax
//    judgement call is a checkout the staff will find a way around —
//    which is worse than the error it prevented. The owner decides.
// 4. VAT-INCLUSIVE BY DEFAULT. Nigerian retail shelf prices already
//    include VAT. Enabling VAT must NOT increase what the customer pays;
//    it EXTRACTS the tax from the existing total for remittance
//    bookkeeping. Carried over from PharmaRidge unchanged, because it was
//    right there and it is right here.
// =====================================================================

const { round2 } = require('./money');

// ---------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------
const VAT_STANDARD_RATE = 7.5;              // % — NTA 2025, unchanged from Feb 2020
const VAT_REGISTRATION_THRESHOLD = 25_000_000; // ₦ turnover in any 12 consecutive months
const VAT_RETURN_DUE_DAY = 21;              // of the following month
const VAT_LATE_PENALTY_FIRST_MONTH = 100_000;
const VAT_LATE_PENALTY_EACH_FURTHER_MONTH = 50_000;

// Zero-rated supplies: 0% charged, but input VAT on the purchases behind
// them IS recoverable. Distinct from EXEMPT, where no VAT applies and no
// input recovery is available. Conflating the two is the most common VAT
// error in Nigerian retail bookkeeping, so they are separate values.
const VAT_TREATMENTS = Object.freeze([
  { code: 'STANDARD', label: 'Standard-rated (7.5%)', ratePercent: VAT_STANDARD_RATE, inputRecoverable: true },
  { code: 'ZERO_RATED', label: 'Zero-rated (0%)', ratePercent: 0, inputRecoverable: true },
  { code: 'EXEMPT', label: 'Exempt (no VAT)', ratePercent: 0, inputRecoverable: false },
]);

// Categories that are zero-rated by law and therefore default to it.
// A retailer of general merchandise will have basic food items in stock;
// getting this wrong means over-collecting VAT on zero-rated goods, which
// is a refund liability the business owes its customers.
const ZERO_RATED_CATEGORY_HINTS = Object.freeze([
  'FOODSTUFFS',          // basic food items
  'MEDICINES',           // medical and pharmaceutical products
  'BOOKS_STATIONERY',    // educational books and materials
]);

// Extract VAT from a VAT-INCLUSIVE total.
//   total = net + vat,  vat = total - total/(1 + r)
// The net is derived FIRST and the VAT by SUBTRACTION, so the two always
// add back to the exact total. Computing both independently is how a
// ₦10,000 basket comes out at ₦10,000.01 on the return.
function extractVat(inclusiveTotal, ratePercent) {
  const total = round2(inclusiveTotal);
  const r = Number(ratePercent);
  if (!Number.isFinite(r) || r <= 0) return { net: total, vat: 0, ratePercent: 0, gross: total };
  const net = round2(total / (1 + r / 100));
  return { net, vat: round2(total - net), ratePercent: r, gross: total };
}

// Add VAT ON TOP of a net price. Only used where the client has explicitly
// configured VAT-exclusive pricing (unusual in Nigerian retail, common on
// corporate/contract supply), so it is a separate function and never the
// default path.
function addVat(netAmount, ratePercent) {
  const net = round2(netAmount);
  const r = Number(ratePercent);
  if (!Number.isFinite(r) || r <= 0) return { net, vat: 0, ratePercent: 0, gross: net };
  const vat = round2((net * r) / 100);
  return { net, vat, ratePercent: r, gross: round2(net + vat) };
}

// Does this business HAVE to register and charge VAT? Advisory — the
// client's own turnover band is something only the owner knows for
// certain, and voluntary registration below the threshold is legal and
// sometimes desirable (to recover input VAT on a shopfit).
function vatRegistrationAdvice({ trailing12MonthTurnover, vatEnabled }) {
  const t = Number(trailing12MonthTurnover) || 0;
  if (t > VAT_REGISTRATION_THRESHOLD && !vatEnabled) {
    return {
      level: 'WARN',
      message:
        `Turnover over the last 12 months is ₦${t.toLocaleString('en-NG')}, above the ₦${VAT_REGISTRATION_THRESHOLD.toLocaleString('en-NG')} VAT registration threshold. ` +
        'Registration and charging 7.5% VAT is mandatory — turn on VAT in Settings → Tax.',
    };
  }
  if (t <= VAT_REGISTRATION_THRESHOLD && vatEnabled) {
    return {
      level: 'INFO',
      message:
        'You are charging VAT below the ₦25m registration threshold. That is permitted (voluntary registration) and lets you recover input VAT, but confirm it with your tax adviser.',
    };
  }
  return { level: 'OK', message: null };
}

// ---------------------------------------------------------------------
// WITHHOLDING TAX
// ---------------------------------------------------------------------

// The seed schedule. Direction says which side of the transaction the rate
// applies to:
//   PAYABLE   — WE are paying a supplier/contractor and must deduct
//   RECEIVABLE— a CUSTOMER is paying us and will deduct from our invoice
//   BOTH      — symmetric (e.g. commission either way)
// Enforcing direction matters: a RECEIVABLE-only rate must not be usable
// on an expense, or the app will deduct tax from its own outgoing payment
// at a rate that only ever applied to its incoming income.
const WHT_RATE_SEED = Object.freeze([
  { code: 'GOODS_MATERIALS', label: 'Supply of goods or materials (not by manufacturer)', rate_percent: 2, direction: 'BOTH', note: 'Reduced from 5% by the 2024 Regulations for low-margin trades.' },
  { code: 'GENERAL_SERVICES', label: 'General / unlisted services', rate_percent: 2, direction: 'BOTH', note: '5% where the recipient is non-resident.' },
  { code: 'PROFESSIONAL_FEES', label: 'Commission, consultancy, technical, management & professional fees', rate_percent: 5, direction: 'BOTH', note: '10% (final tax) for non-residents.' },
  { code: 'BROKERAGE', label: 'Brokerage / agency fees', rate_percent: 5, direction: 'BOTH', note: '10% for non-residents.' },
  { code: 'CONSTRUCTION_MAJOR', label: 'Construction of roads, bridges, buildings, power plants', rate_percent: 2, direction: 'PAYABLE', note: '5% for non-residents.' },
  { code: 'CONSTRUCTION_OTHER', label: 'Other construction & installation work', rate_percent: 5, direction: 'PAYABLE', note: '10% for non-residents.' },
  { code: 'RENT_HIRE_LEASE', label: 'Rent, hire and lease', rate_percent: 5, direction: 'PAYABLE', note: '10% for non-residents. Applies to shop and warehouse rent.' },
  { code: 'DIVIDENDS_INTEREST', label: 'Dividends and interest', rate_percent: 10, direction: 'BOTH', note: '' },
  { code: 'ROYALTIES', label: 'Royalties', rate_percent: 10, direction: 'BOTH', note: '5% where the recipient is an individual.' },
  { code: 'DIRECTORS_FEES', label: "Directors' fees", rate_percent: 15, direction: 'PAYABLE', note: '20% for non-resident directors.' },
  { code: 'MARKETING_AGENCY', label: 'Marketing & advertising agency services', rate_percent: 5, direction: 'PAYABLE', note: '' },
  { code: 'LOGISTICS_HAULAGE', label: 'Logistics, haulage & delivery contracts', rate_percent: 2, direction: 'PAYABLE', note: 'General services rate; confirm against the contract type.' },
  { code: 'SECURITY_SERVICES', label: 'Security & cleaning services', rate_percent: 2, direction: 'PAYABLE', note: '' },
  { code: 'REPAIRS_MAINTENANCE', label: 'Repairs & maintenance contracts', rate_percent: 5, direction: 'PAYABLE', note: 'Covers AC servicing, generator maintenance, warranty subcontracting.' },
]);

// The small-company exemption threshold: ₦2,000,000 or less per supplier
// per CALENDAR MONTH, conditional on the supplier holding a valid TIN.
// Note the test is per-supplier-per-month, NOT per-transaction — ten
// ₦300,000 invoices to the same supplier in one month is ₦3,000,000 and
// the exemption is lost for the whole month. This is the detail most
// implementations get wrong, so it is computed properly in
// monthToDateSupplierSpend().
const WHT_SMALL_COMPANY_MONTHLY_THRESHOLD = 2_000_000;

// A small company for WHT-exemption purposes: gross turnover ₦25,000,000
// or less per annum (2024 Regulations). The NTA 2025 uses ₦50,000,000 for
// the 0% CIT band and ₦100,000,000 in the Administration Act — an
// acknowledged gap in the reform package. We expose BOTH and let the owner
// declare which applies to them, rather than silently picking one.
const WHT_SMALL_COMPANY_TURNOVER = 25_000_000;
const NTA_SMALL_COMPANY_TURNOVER = 50_000_000;
const NTA_SMALL_COMPANY_FIXED_ASSETS = 250_000_000;

// No-TIN penalty: the rate is doubled for non-passive income.
const WHT_NO_TIN_MULTIPLIER = 2;

// Compute a deduction from a GROSS amount. See rule 2 in the header.
function computeWht({ grossAmount, ratePercent }) {
  if (!Number.isFinite(Number(grossAmount)) || Number(grossAmount) < 0) {
    throw Object.assign(new Error('WHT gross amount must be a non-negative number'), {
      status: 400, code: 'WHT_INVALID_GROSS',
    });
  }
  const r = Number(ratePercent);
  if (!Number.isFinite(r) || r < 0 || r > 100) {
    throw Object.assign(new Error('WHT rate must be a percentage between 0 and 100'), {
      status: 400, code: 'WHT_INVALID_RATE',
    });
  }
  const gross = round2(grossAmount);
  const wht = round2((gross * r) / 100);
  // Derive net by SUBTRACTION, never by a second independent rounding.
  const net = round2(gross - wht);
  return { gross, wht, net, ratePercent: r };
}

// Apply (or reverse) the no-TIN doubling. Kept as its own function so the
// doubling is visible and auditable rather than buried in a rate lookup —
// a supplier who pays twice the rate because nobody captured their TIN is
// a supplier who will call, and the clerk needs to see exactly why.
function effectiveRatePercent(baseRatePercent, { hasTin = true } = {}) {
  const base = Number(baseRatePercent);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return hasTin ? round2(base) : round2(base * WHT_NO_TIN_MULTIPLIER);
}

// ---------------------------------------------------------------------
// ACROSS-THE-COUNTER EXEMPTION
// ---------------------------------------------------------------------
// The 2024 Regulations exempt "across-the-counter transactions" — a
// non-contractual arrangement paid instantly in cash or on the spot by
// electronic means. Practically every POS retail sale in this app is one:
// a customer walks in, pays, and walks out with the goods. There is no
// contract and no credit.
//
// We classify it explicitly rather than leaving the user to know the rule,
// because the alternative is a shop owner either (a) deducting WHT from
// every cash sale and creating a nonsense ledger, or (b) never deducting
// WHT anywhere and missing the cases that DO apply — paying a contractor
// to fit out the shop, or a haulier to move a container.
const OTC_PAYMENT_METHODS = Object.freeze(['CASH', 'POS_TERMINAL', 'USSD', 'MOBILE_MONEY']);

function isAcrossTheCounter({ paymentMethods, isCreditSale = false, hasWrittenContract = false }) {
  if (isCreditSale) return false;         // credit = not paid instantly
  if (hasWrittenContract) return false;   // contractual = not "across the counter"
  const methods = Array.isArray(paymentMethods) && paymentMethods.length ? paymentMethods : [];
  if (!methods.length) return false;
  // EVERY leg must be an instant-settlement method. A part-cash /
  // part-30-day-credit basket is not an across-the-counter transaction.
  return methods.every((m) => OTC_PAYMENT_METHODS.includes(String(m).toUpperCase()));
}

// ---------------------------------------------------------------------
// EXEMPTION HINTS — advisory only, never blocking (see rule 3)
// ---------------------------------------------------------------------
function smallCompanyExemptionHint({
  grossAmount,
  counterpartyTin,
  monthToDateSpendWithSupplier = 0,
  payerIsSmallCompany = null,
}) {
  if (!Number.isFinite(Number(grossAmount))) return null;
  if (payerIsSmallCompany === false) return null; // known not to qualify: no hint

  const monthTotal = (Number(monthToDateSpendWithSupplier) || 0) + (Number(grossAmount) || 0);

  if (!counterpartyTin) {
    return {
      code: 'NO_TIN',
      level: 'WARN',
      message:
        'This supplier has no TIN on record. Under the 2024 Regulations the deduction is DOUBLED where the recipient has no TIN, ' +
        'and the small-company exemption is unavailable. Capture their TIN in Suppliers to avoid over-deducting.',
    };
  }

  if (monthTotal <= WHT_SMALL_COMPANY_MONTHLY_THRESHOLD && payerIsSmallCompany !== false) {
    return {
      code: 'SMALL_COMPANY_UNDER_THRESHOLD',
      level: 'INFO',
      message:
        `Payments to this supplier total ₦${round2(monthTotal).toLocaleString('en-NG')} in this calendar month, at or below the ₦2,000,000 threshold. ` +
        'If your own gross turnover is ₦25m or less, you need not deduct WHT on this transaction — but the test is PER SUPPLIER PER MONTH, so a later payment that crosses ₦2m removes the exemption for the whole month.',
    };
  }

  if (monthToDateSpendWithSupplier <= WHT_SMALL_COMPANY_MONTHLY_THRESHOLD && monthTotal > WHT_SMALL_COMPANY_MONTHLY_THRESHOLD) {
    return {
      code: 'SMALL_COMPANY_CROSSED_THRESHOLD',
      level: 'WARN',
      message:
        `This payment takes the month's total with this supplier to ₦${round2(monthTotal).toLocaleString('en-NG')}, above ₦2,000,000. ` +
        'The small-company exemption is now lost for the WHOLE calendar month with this supplier — earlier exempted payments in this month should be reviewed.',
    };
  }

  return null;
}

function overTheCounterHint({ paymentMethods, isCreditSale, hasWrittenContract, amount }) {
  if (isAcrossTheCounter({ paymentMethods, isCreditSale, hasWrittenContract })) {
    return {
      code: 'ACROSS_THE_COUNTER',
      level: 'INFO',
      message:
        'This looks like an across-the-counter transaction (non-contractual, settled instantly in cash or electronically), which the 2024 Regulations exempt from deduction at source. No WHT has been applied.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------
// Resolve what a caller asked for into a validated deduction.
// ---------------------------------------------------------------------
// Centralised so every route rejects bad input the same way with the same
// error codes. Returns null when no WHT applies (distinct from a 0% rate,
// which is also null — a 0% deduction is not a deduction).
function resolveDeduction({ grossAmount, ratePercent, rateCode, rateRow, direction, hasTin = true, ratePercentOverride = null }) {
  if (!rateCode && ratePercentOverride == null && ratePercent == null) return null;

  let base = ratePercent;
  let code = rateCode ? String(rateCode).trim().toUpperCase() : 'CUSTOM';

  if (rateCode) {
    if (!rateRow) {
      throw Object.assign(
        new Error(`Unknown or inactive WHT rate "${rateCode}". Choose a rate from Settings → Tax, or add it there first.`),
        { status: 400, code: 'WHT_UNKNOWN_RATE' },
      );
    }
    if (rateRow.direction !== 'BOTH' && rateRow.direction !== direction) {
      throw Object.assign(
        new Error(`WHT rate "${rateRow.code}" applies to ${rateRow.direction} transactions only and cannot be used on a ${direction} one.`),
        { status: 400, code: 'WHT_WRONG_DIRECTION' },
      );
    }
    base = Number(rateRow.rate_percent);
    code = rateRow.code;
  }

  // An explicit override wins, so a tax adviser's one-off instruction does
  // not require editing the shared schedule.
  if (ratePercentOverride != null) {
    const o = Number(ratePercentOverride);
    if (!Number.isFinite(o) || o < 0 || o > 100) {
      throw Object.assign(new Error('WHT rate must be a percentage between 0 and 100'), {
        status: 400, code: 'WHT_INVALID_RATE',
      });
    }
    base = o;
  }

  const effective = effectiveRatePercent(base, { hasTin });
  const computed = computeWht({ grossAmount, ratePercent: effective });
  if (computed.wht <= 0) return null;
  if (computed.wht > computed.gross) {
    throw Object.assign(new Error('WHT cannot exceed the gross amount'), {
      status: 400, code: 'WHT_EXCEEDS_GROSS',
    });
  }

  return {
    ...computed,
    rateCode: code,
    baseRatePercent: round2(Number(base)),
    doubledForNoTin: !hasTin && Number(base) > 0,
  };
}

// ---------------------------------------------------------------------
// E-INVOICING BAND (NTA 2025 phased rollout)
// ---------------------------------------------------------------------
// Included because a retailer above ₦1bn turnover in 2026 is already in
// scope and needs the app to produce the fields an e-invoice requires
// (supplier TIN/RC, per-line VAT treatment, unique sequential number).
const E_INVOICE_BANDS = Object.freeze([
  { code: 'LARGE', minTurnover: 5_000_000_000, liveFrom: '2025-11-01', enforcedFrom: '2025-11-01' },
  { code: 'MEDIUM', minTurnover: 1_000_000_000, liveFrom: '2026-07-01', enforcedFrom: '2027-01-01' },
  { code: 'SMALL', minTurnover: 0, liveFrom: '2027-07-01', enforcedFrom: '2028-01-01' },
]);

function eInvoiceBand(trailing12MonthTurnover) {
  const t = Number(trailing12MonthTurnover) || 0;
  return E_INVOICE_BANDS.find((b) => t >= b.minTurnover) || E_INVOICE_BANDS[E_INVOICE_BANDS.length - 1];
}

module.exports = {
  VAT_STANDARD_RATE,
  VAT_REGISTRATION_THRESHOLD,
  VAT_RETURN_DUE_DAY,
  VAT_LATE_PENALTY_FIRST_MONTH,
  VAT_LATE_PENALTY_EACH_FURTHER_MONTH,
  VAT_TREATMENTS,
  ZERO_RATED_CATEGORY_HINTS,
  extractVat,
  addVat,
  vatRegistrationAdvice,

  WHT_RATE_SEED,
  WHT_SMALL_COMPANY_MONTHLY_THRESHOLD,
  WHT_SMALL_COMPANY_TURNOVER,
  NTA_SMALL_COMPANY_TURNOVER,
  NTA_SMALL_COMPANY_FIXED_ASSETS,
  WHT_NO_TIN_MULTIPLIER,
  OTC_PAYMENT_METHODS,
  E_INVOICE_BANDS,

  computeWht,
  effectiveRatePercent,
  isAcrossTheCounter,
  smallCompanyExemptionHint,
  overTheCounterHint,
  resolveDeduction,
  eInvoiceBand,
};
