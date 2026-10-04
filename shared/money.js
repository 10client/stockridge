// =====================================================================
// StockRidge — MONEY
// =====================================================================
// Copied in principle from PharmaRidge's glService.round2 / wht round2,
// which existed in two places and had to be kept identical by hand. Here
// there is ONE definition and every module imports it, so a figure
// computed in the POS and the same figure computed in the GL can never
// disagree by a kobo.
//
// NIGERIA-SPECIFIC NOTE: the Naira has 2 decimal places (kobo) but the
// smallest coin in practical circulation is ₦1 — banks and shops round
// cash transactions to whole Naira. Two rounding modes are therefore
// exposed and the distinction is deliberate:
//
//   round2()      accounting precision. Every stored ledger amount,
//                 invoice total, VAT split and WHT deduction. Never
//                 loses value; used for the books.
//   roundCash()   what the customer actually hands over. Applied ONLY to
//                 cash-tendered/change-given at the till, so a ₦1,234.56
//                 bill paid in notes gives ₦1,235 change rather than
//                 promising 56 kobo nobody can produce.
//
// Mixing these two up is the classic till-reconciliation bug: the books
// balance but the drawer is short by kobo on every single sale.
// =====================================================================

const KOBO_PER_NAIRA = 100;

// Half-away-from-zero at 2dp, immune to the float representation error
// that makes Math.round(1.005 * 100) === 100 instead of 101.
function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * KOBO_PER_NAIRA) / KOBO_PER_NAIRA;
}

function roundCash(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n + Number.EPSILON);
}

// Integer kobo. Used wherever a comparison must be exact — a till that
// closes on "expected === counted" cannot compare floats.
function toKobo(n) {
  return Math.round(round2(n) * KOBO_PER_NAIRA);
}

function fromKobo(k) {
  return round2(k / KOBO_PER_NAIRA);
}

function isMoney(n) {
  return Number.isFinite(n) && n >= 0;
}

// Parse user input. Nigerian shop floors type "1,500", "1500.50", "₦1500"
// and "1.5k" interchangeably; the till must accept all of them rather
// than bouncing the cashier at the point of sale. Returns null on junk —
// never NaN, because NaN propagates silently into totals.
function parseMoney(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? round2(raw) : null;
  let s = String(raw).trim();
  if (!s) return null;
  let multiplier = 1;
  // "1.5k" / "2m" shorthand — common in wholesale chats and on paper slips.
  const short = s.match(/^([₦nN]?\s*)([0-9][0-9,.\s]*)(k|m)\b$/i);
  if (short) {
    s = short[2];
    multiplier = short[3].toLowerCase() === 'm' ? 1_000_000 : 1_000;
  }
  s = s.replace(/[₦\s,]/g, '').replace(/^n/i, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s) * multiplier;
  return Number.isFinite(n) ? round2(n) : null;
}

// Display. 'en-NG' gives the 1,234,567.89 grouping Nigerians read on
// invoices. Currency symbol is explicit rather than relying on
// Intl's NGN formatting, which renders "NGN" not "₦" on many browsers.
function formatMoney(n, { symbol = '₦', decimals = 2 } = {}) {
  const v = Number.isFinite(n) ? n : 0;
  return symbol + v.toLocaleString('en-NG', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatMoneyShort(n) {
  const v = Number.isFinite(n) ? Math.abs(n) : 0;
  const sign = Number(n) < 0 ? '-' : '';
  if (v >= 1_000_000_000) return `${sign}₦${round2(v / 1_000_000_000)}b`;
  if (v >= 1_000_000) return `${sign}₦${round2(v / 1_000_000)}m`;
  if (v >= 1_000) return `${sign}₦${round2(v / 1_000)}k`;
  return `${sign}₦${round2(v)}`;
}

// Sum a list of money values without float drift: accumulate in integer
// kobo, convert once. Used for invoice line totals, which is exactly
// where drift becomes visible to a customer.
function sumMoney(values) {
  let kobo = 0;
  for (const v of values) kobo += toKobo(v || 0);
  return fromKobo(kobo);
}

// Split `total` into `parts.length` shares in integer kobo such that the
// shares sum EXACTLY to the total. Needed by instalment schedules: a
// ₦100,000 item over 3 months is 33,333.33 each, and three rounded
// instalments would total ₦100,000.00 only if the remainder is pushed
// onto one of them. Silent under-collection of one kobo per plan, across
// thousands of plans, is real money and a reconciliation nightmare.
function allocateKobo(total, weights) {
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const wSum = w.reduce((a, b) => a + b, 0);
  const k = toKobo(total);
  if (wSum <= 0 || k <= 0) return w.map(() => 0);
  const out = w.map((x) => Math.floor((k * x) / wSum));
  let rem = k - out.reduce((a, b) => a + b, 0);
  // Largest-remainder allocation: hand the leftover kobo out one at a
  // time to the shares with the biggest fractional part.
  const order = w
    .map((x, i) => ({ i, frac: ((k * x) / wSum) - Math.floor((k * x) / wSum) }))
    .sort((a, b) => b.frac - a.frac);
  let idx = 0;
  while (rem > 0 && order.length) { out[order[idx % order.length].i] += 1; rem -= 1; idx += 1; }
  return out;
}

function percentOf(amount, percent) {
  return round2(((Number(amount) || 0) * (Number(percent) || 0)) / 100);
}

module.exports = {
  KOBO_PER_NAIRA, round2, roundCash, toKobo, fromKobo, isMoney, parseMoney,
  formatMoney, formatMoneyShort, sumMoney, allocateKobo, percentOf,
};
'use strict';
