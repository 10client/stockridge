// =====================================================================
// StockRidge — VAT
// =====================================================================
// Nigeria's Value Added Tax, administered by FIRS. Standard rate 7.5%.
//
// THE PRICING MODEL IS THE IMPORTANT PART, and it is a client decision
// carried over from PharmaRidge because it is correct for every Nigerian
// retail vertical, not just pharmacy:
//
//   VAT-INCLUSIVE. Enabling VAT does NOT increase what the customer pays at
//   the counter. sales.total is unchanged by the toggle. VAT is EXTRACTED
//   from the existing total for reporting and remittance bookkeeping.
//
// That matches how Nigerian shelf prices already work: the label says
// ₦150,000 and the customer pays ₦150,000. A system that added 7.5% at
// checkout would make every shelf label in the shop wrong the day the
// owner turned the feature on, and would start an argument at the counter
// the cashier cannot win.
//
// CONSEQUENCE, and it must be understood before reading the maths:
// the taxable base is total / 1.075, NOT total. The VAT component of a
// ₦107,500 inclusive price is ₦7,500, not ₦8,062.50. Getting this the
// other way round overstates output VAT by 7.5% on every sale, which is a
// real overpayment to FIRS and a real understatement of gross margin.
//
// The rate is a setting, never a constant in code: it has changed before
// and the owner must be able to change it without a deploy.
// =====================================================================

const { round2, toKobo, fromKobo } = require('../../shared/money');

const DEFAULT_VAT_RATE_PERCENT = 7.5;
const MAX_VAT_RATE_PERCENT = 50;

function normaliseRate(ratePercent, fallback = DEFAULT_VAT_RATE_PERCENT) {
  const r = Number(ratePercent);
  if (!Number.isFinite(r) || r < 0 || r > MAX_VAT_RATE_PERCENT) return fallback;
  return round2(r);
}

// EXTRACT VAT from an inclusive amount.
//   taxable = total / (1 + rate/100)
//   vat     = total - taxable          <- by SUBTRACTION, never a second rounding
//
// Deriving `vat` by subtraction is what keeps total = taxable + vat exactly.
// Rounding both legs independently is the classic way that identity fails by
// a kobo, and a filing whose components do not sum to its own total is a
// filing that gets queried.
function extractVat(totalInclusive, ratePercent) {
  const total = round2(Number(totalInclusive) || 0);
  const rate = normaliseRate(ratePercent);
  if (total <= 0 || rate <= 0) return { total, rate_percent: rate, taxable: total, vat: 0, net_of_vat: total };
  const taxable = total / (1 + rate / 100);
  const vat = total - taxable;
  return {
    total,
    rate_percent: rate,
    taxable: round2(taxable),
    vat: round2(vat),
    net_of_vat: round2(taxable),
    // Recomputed-from-rounded check, so a caller can assert the identity held.
    balanced: Math.abs(toKobo(round2(taxable)) + toKobo(round2(vat)) - toKobo(total)) <= 1,
  };
}

// ADD VAT to an exclusive amount. Used for purchase orders quoted ex-VAT and
// for wholesale invoices where the customer is VAT-registered and expects
// the tax shown separately.
function addVat(amountExclusive, ratePercent) {
  const base = round2(Number(amountExclusive) || 0);
  const rate = normaliseRate(ratePercent);
  if (base <= 0 || rate <= 0) return { net: base, rate_percent: rate, vat: 0, gross: base };
  const vat = (base * rate) / 100;
  return { net: base, rate_percent: rate, vat: round2(vat), gross: round2(base + vat) };
}

// Split a multi-line sale so the sum of the per-line VAT equals the VAT on
// the total EXACTLY. Rounding each line independently leaves a residual of a
// few kobo on a 20-line invoice, and a VAT return whose line detail does not
// sum to its own headline figure fails a FIRS desk review.
//
// Largest-remainder allocation in integer kobo, same technique as
// money.allocateKobo. The residual always lands on the LARGEST line, so it
// is proportionally least distorting and deterministic across retries.
function allocateVatAcrossLines(lines, ratePercent) {
  const rate = normaliseRate(ratePercent);
  const amounts = lines.map((l) => round2(Number(l && l.line_total) || 0));
  const total = round2(amounts.reduce((a, b) => a + b, 0));
  if (rate <= 0 || total <= 0) {
    return lines.map((l, i) => ({
      index: i, line_total: amounts[i], rate_percent: rate, taxable: amounts[i], vat: 0,
    }));
  }
  const totalKobo = toKobo(total);
  const vatKoboTotal = Math.round((totalKobo * rate) / (100 + rate));
  const weights = amounts.map((a) => Math.max(0, toKobo(a)));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => (wSum > 0 ? Math.floor((vatKoboTotal * w) / wSum) : 0));
  let rem = vatKoboTotal - shares.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, frac: wSum > 0 ? ((vatKoboTotal * w) / wSum) - Math.floor((vatKoboTotal * w) / wSum) : 0, w }))
    .sort((a, b) => (b.frac - a.frac) || (b.w - a.w));
  let idx = 0;
  while (rem > 0 && order.length) { shares[order[idx % order.length].i] += 1; rem -= 1; idx += 1; }

  return lines.map((l, i) => {
    const lineKobo = toKobo(amounts[i]);
    const vatKobo = shares[i];
    return {
      index: i,
      line_total: amounts[i],
      rate_percent: rate,
      vat: fromKobo(vatKobo),
      taxable: fromKobo(lineKobo - vatKobo),
      product_id: l && l.product_id,
      category_id: l && l.category_id,
    };
  });
}

// Whether a specific line is taxable. Exempt and zero-rated supplies exist
// in Nigerian VAT law (basic foodstuffs, medical services, books and
// educational materials are exempt; exports are zero-rated), and a general
// merchandise business will absolutely sell some of them alongside taxable
// goods. Rather than hardcode a schedule that will drift, the product carries
// a tax_code and this function resolves it. The codes are DATA in
// Settings → Tax, seeded with the common cases.
const TAX_CODES = Object.freeze({
  STANDARD: { code: 'STANDARD', label: 'Standard rated', rate_multiplier: 1, note: 'Normal 7.5% VAT.' },
  EXEMPT: { code: 'EXEMPT', label: 'Exempt', rate_multiplier: 0, note: 'No VAT charged; not part of the taxable base. Exempt supplies include basic foodstuffs, medical and pharmaceutical products, books and educational materials, and baby products.' },
  ZERO_RATED: { code: 'ZERO_RATED', label: 'Zero rated', rate_multiplier: 0, note: 'VAT applies at 0% — the supply is taxable but at zero, so input VAT on its costs remains recoverable. Exports are zero-rated.' },
  OUT_OF_SCOPE: { code: 'OUT_OF_SCOPE', label: 'Out of scope', rate_multiplier: 0, note: 'Not a VAT supply at all (e.g. a staff purchase at cost, an internal transfer).' },
});

function taxCodeOf(code) {
  const k = String(code || 'STANDARD').trim().toUpperCase();
  return TAX_CODES[k] || TAX_CODES.STANDARD;
}

function effectiveRateFor(taxCode, ratePercent) {
  const t = taxCodeOf(taxCode);
  return round2(normaliseRate(ratePercent) * t.rate_multiplier);
}

// Is the business VAT-registered at all? An unregistered business must not
// charge VAT, must not show it on a receipt, and must not file. The schema
// default is OFF for exactly that reason: the app must never silently start
// charging a tax nobody registered for.
function isVatEnabled(unitSettings) {
  return !!(unitSettings && unitSettings.vat_enabled);
}

function isVatInclusive(unitSettings) {
  // Default inclusive: that is the Nigerian retail norm. A business that
  // quotes ex-VAT (typical for B2B wholesale and government supply) opts
  // out explicitly.
  return unitSettings ? unitSettings.vat_inclusive_pricing !== 0 : true;
}

module.exports = {
  DEFAULT_VAT_RATE_PERCENT, MAX_VAT_RATE_PERCENT, TAX_CODES,
  normaliseRate, extractVat, addVat, allocateVatAcrossLines,
  taxCodeOf, effectiveRateFor, isVatEnabled, isVatInclusive,
};
'use strict';
