// =====================================================================
// shared/lib/money.js — MONEY ARITHMETIC (backend-neutral, zero deps)
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: glService.round2 / receiving.splitTotalCost /
// wht.round2 were three private copies of the same rounding rule living in
// three files. Any two of them drifting by a kobo produced a CHECK-constraint
// violation deep inside a transaction (gross <> net + wht). StockRidge keeps
// ONE implementation and every caller — VAT, WHT, instalments, GL, pricing,
// receipts, exports — imports it.
//
// WHY KOBO INTEGER MATH:
//   JavaScript has no decimal type. 0.1 + 0.2 === 0.30000000000000004. For a
//   shop that rings up 400 sales a day this is not a rounding curiosity — it
//   accumulates into a till that will not reconcile, and into a trial balance
//   that is out by a few kobo and therefore useless as an audit artefact.
//
//   The rule used throughout StockRidge:
//     * STORE and COMPUTE money as INTEGER KOBO (REAL columns in SQLite hold
//       the naira figure only at the persistence boundary; every calculation
//       is done in kobo and divided once, at the end).
//     * never multiply two money values together.
//     * round HALF-UP (Nigerian commercial convention, and what a customer
//       expects to see on a receipt), never banker's rounding.
//
// WHY NOT JUST toFixed(2):
//   (1.005).toFixed(2) === "1.00" — binary floating point already lost the
//   half-kobo before toFixed ever saw it. toKobo() adds a scaled epsilon
//   BEFORE rounding so the decimal the human typed survives.

'use strict';

const KOBO_PER_NAIRA = 100;

// Largest safe integer kobo figure: ~9.0e13 naira. Comfortably above any
// Nigerian SME's annual turnover, and far above the point where a REAL column
// loses precision (2^53 kobo).
const MAX_KOBO = Number.MAX_SAFE_INTEGER;

/**
 * Round a naira amount to 2dp, HALF-UP, immune to the binary-float
 * representation error that makes (1.005).toFixed(2) === "1.00".
 *
 * Kept as the public "round2" so callers porting from PharmaRidge find the
 * same name and the same behaviour.
 */
function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  // Sign-aware: Math.round(-0.5) === -0 in JS, which would flip a small
  // negative figure to positive. Split, round the magnitude, restore the sign.
  const sign = v < 0 ? -1 : 1;
  const scaled = Math.abs(v) * KOBO_PER_NAIRA;
  // epsilon scaled to the magnitude, not a fixed 1e-9: a fixed epsilon fails
  // on large figures where the float error is proportionally larger.
  const eps = Math.max(1e-7, scaled * 1e-12);
  return (sign * Math.round(scaled + eps)) / KOBO_PER_NAIRA;
}

/** Naira (possibly fractional) -> integer kobo. */
function toKobo(naira) {
  const v = Number(naira);
  if (!Number.isFinite(v)) return 0;
  const sign = v < 0 ? -1 : 1;
  const scaled = Math.abs(v) * KOBO_PER_NAIRA;
  const eps = Math.max(1e-7, scaled * 1e-12);
  const kobo = sign * Math.round(scaled + eps);
  if (!Number.isSafeInteger(kobo)) {
    throw Object.assign(new Error('Money amount is too large to represent precisely'), {
      status: 400, code: 'MONEY_OVERFLOW',
    });
  }
  return kobo;
}

/** Integer kobo -> naira as a Number rounded to 2dp. */
function fromKobo(kobo) {
  return round2(Number(kobo || 0) / KOBO_PER_NAIRA);
}

function addKobo(...vals) {
  let total = 0;
  for (const v of vals) {
    const k = toKobo(v);
    if (Math.abs(total) + Math.abs(k) > MAX_KOBO) {
      throw Object.assign(new Error('Money amount is too large to represent precisely'), {
        status: 400, code: 'MONEY_OVERFLOW',
      });
    }
    total += k;
  }
  return total;
}

/**
 * Allocate an integer kobo total across `parts` weights so that the pieces
 * SUM EXACTLY to the total — no kobo created, none destroyed.
 *
 * THIS IS THE SINGLE MOST IMPORTANT FUNCTION IN THE FILE. It is what keeps:
 *   * a VAT-inclusive split (net + vat === total)
 *   * a WHT split (gross === net + wht)
 *   * an instalment schedule (sum of instalments === amount financed)
 *   * a multi-line discount apportionment (sum of line discounts === discount)
 *   * a part-payment allocation across invoices
 * ...all exactly balanced, instead of balanced-except-for-one-kobo, which is
 * the failure mode that makes a database CHECK constraint reject an otherwise
 * correct transaction and leaves the till out.
 *
 * Method: largest-remainder. Give every part floor(share), then hand the
 * leftover kobo one at a time to the parts with the biggest fractional
 * remainder (ties broken by position, so the result is DETERMINISTIC — an
 * allocation that changes between two identical runs is a reporting bug).
 *
 * @param {number} totalKobo integer kobo to distribute
 * @param {number[]} weights relative weights; need not sum to 1 or 100
 * @returns {number[]} integer kobo per weight, same length, summing exactly
 */
function allocateKobo(totalKobo, weights) {
  const w = (weights || []).map((x) => Number(x));
  if (!w.length) return [];
  const total = Math.round(Number(totalKobo) || 0);

  const weightSum = w.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  if (weightSum <= 0) {
    // Degenerate weights: fall back to an even split so we still balance
    // exactly rather than handing the whole amount to the first part.
    const even = w.map(() => 1);
    return allocateKobo(total, even);
  }

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const exact = w.map((x) => (abs * (Number.isFinite(x) && x > 0 ? x : 0)) / weightSum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = abs - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));

  const out = floors.slice();
  for (let k = 0; k < order.length && remainder > 0; k += 1) {
    out[order[k].i] += 1;
    remainder -= 1;
  }
  // remainder should now be 0; if floating point left one, give it to the
  // largest part so the invariant holds absolutely.
  if (remainder > 0) out[0] += remainder;

  return out.map((x) => sign * x);
}

/**
 * Split a VAT-INCLUSIVE total into net + VAT.
 *
 * Nigerian retail convention (and the explicit model PharmaRidge settled on
 * after client discussion): shelf prices already include VAT, so turning VAT
 * on must NOT increase what the customer pays. VAT is EXTRACTED from the
 * existing total for reporting and remittance, never added on top.
 *
 *   net = total / (1 + r)   ;   vat = total - net   (by subtraction)
 *
 * vat is derived by SUBTRACTION so `net + vat === total` holds exactly in
 * kobo. Computing both legs with independent rounding is the classic way that
 * identity fails by one kobo.
 */
function extractVat(totalNaira, ratePercent) {
  const totalK = toKobo(totalNaira);
  const r = Number(ratePercent);
  if (!Number.isFinite(r) || r < 0 || r > 100) {
    throw Object.assign(new Error('VAT rate must be a percentage between 0 and 100'), {
      status: 400, code: 'VAT_INVALID_RATE',
    });
  }
  if (r === 0) return { total: fromKobo(totalK), net: fromKobo(totalK), vat: 0, ratePercent: 0 };
  const netK = Math.round(totalK / (1 + r / 100));
  const vatK = totalK - netK;
  return {
    total: fromKobo(totalK),
    net: fromKobo(netK),
    vat: fromKobo(vatK),
    ratePercent: r,
  };
}

/** Add VAT ON TOP of a net figure (used for B2B quotations/invoices). */
function addVat(netNaira, ratePercent) {
  const netK = toKobo(netNaira);
  const r = Number(ratePercent);
  if (!Number.isFinite(r) || r < 0 || r > 100) {
    throw Object.assign(new Error('VAT rate must be a percentage between 0 and 100'), {
      status: 400, code: 'VAT_INVALID_RATE',
    });
  }
  const vatK = Math.round((netK * r) / 100);
  return { net: fromKobo(netK), vat: fromKobo(vatK), total: fromKobo(netK + vatK), ratePercent: r };
}

/**
 * Percentage of an amount, in kobo-exact terms.
 * Used for discounts, margins and price-tier percentages.
 */
function percentOf(amountNaira, pct) {
  const k = toKobo(amountNaira);
  const p = Number(pct);
  if (!Number.isFinite(p)) return 0;
  return fromKobo(Math.round((k * p) / 100));
}

/** unit cost x qty, without the float drift of repeated multiplication. */
function multiply(unitNaira, qty) {
  return fromKobo(toKobo(unitNaira) * Math.round(Number(qty) || 0));
}

/**
 * Margin and markup as PERCENTAGES.
 *   margin  = (price - cost) / price    <- what you keep of each naira sold
 *   markup  = (price - cost) / cost     <- what you added to the cost
 * Reporting confuses these constantly; both are provided so a screen never
 * has to guess which one it wanted.
 */
function marginPercent(price, cost) {
  const p = Number(price) || 0;
  if (p === 0) return 0;
  return round2(((p - (Number(cost) || 0)) / p) * 100);
}

function markupPercent(price, cost) {
  const c = Number(cost) || 0;
  if (c === 0) return 0;
  return round2(((p0(price) - c) / c) * 100);
}

function p0(x) { return Number(x) || 0; }

/**
 * Format for display. Always ₦ and always en-NG grouping (1,234,567.89).
 * `opts.kobo` hides the decimals when they are zero — receipts show
 * "₦45,000" not "₦45,000.00", but a computed figure like "₦1,234.56" keeps
 * them, because dropping a real 56 kobo looks like an error to the customer.
 */
function formatNaira(amount, opts = {}) {
  const v = Number(amount);
  if (!Number.isFinite(v)) return '₦0';
  const decimals = opts.decimals != null
    ? opts.decimals
    : (opts.kobo === false && Math.abs(v - Math.round(v)) < 1e-9 ? 0 : 2);
  const s = Math.abs(v).toLocaleString('en-NG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sign = v < 0 ? '-' : (opts.signed && v > 0 ? '+' : '');
  return `${sign}₦${s}`;
}

/** Plain number with en-NG grouping, no currency symbol (qty, units). */
function formatNumber(n, decimals = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('en-NG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Parse free-text money a cashier typed. Tolerates the things people actually
 * type at a Nigerian counter: "45k", "₦45,000", "1,200.50", " 45 000 ",
 * "45,000/-". Returns null (NOT 0) when unparseable, so a caller can tell
 * "they entered zero" from "they entered nonsense".
 */
function parseMoney(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? round2(input) : null;
  let s = String(input).trim();
  if (!s) return null;

  // "45,000/-" and "45000/=" are a common handwritten-receipt convention
  // (the stroke meaning "and no kobo"). Strip the whole trailing token, not
  // just the slash, or the "-" survives and eats the digits after the comma.
  s = s.replace(/\s*[\/=][-–=]?\s*$/, '');
  s = s.replace(/[₦nN][aA]?[iI]?[rR]?[aA]?\s*/g, '');
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()]/g, '').replace(/^[-+]/, '');

  let multiplier = 1;
  const km = s.match(/^([\d.,\s]+)\s*([kKmM])\b/);
  if (km) {
    s = km[1];
    multiplier = km[2].toLowerCase() === 'k' ? 1000 : 1000000;
  }

  // A comma as thousands separator (Nigerian/UK convention). If the string
  // has BOTH , and . then , is the separator. If it has only commas and they
  // sit in thousands positions, treat them as separators too.
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    const parts = s.split(',');
    const looksGrouped = parts.slice(1).every((p) => /^\d{3}$/.test(p));
    s = looksGrouped ? parts.join('') : s.replace(/,/g, '.');
  }

  s = s.replace(/\s+/g, '').replace(/[^\d.]/g, '');
  if (!s || !/^\d*\.?\d*$/.test(s)) return null;
  const v = Number(s) * multiplier;
  if (!Number.isFinite(v)) return null;
  return negative ? -round2(v) : round2(v);
}

module.exports = {
  KOBO_PER_NAIRA,
  round2, toKobo, fromKobo, addKobo, allocateKobo,
  extractVat, addVat, percentOf, multiply,
  marginPercent, markupPercent,
  formatNaira, formatNumber, parseMoney,
};
