// =====================================================================
// StockRidge — MONEY
// =====================================================================
// The single source of truth for every monetary calculation in the app.
//
// WHY A DEDICATED MODULE
// ----------------------
// A retail platform that lets rounding drift between the POS, the GL and
// the receipt is a platform whose books never balance. PharmaRidge hit
// this repeatedly (a kobo difference between a gross/net split computed
// in two places trips a database CHECK constraint and 500s a checkout).
// So: one rounding function, one currency, one formatting path, and
// every caller goes through here.
//
// PRECISION MODEL
// ---------------
// All amounts are NGN (Naira) held as IEEE-754 doubles, rounded to 2dp
// (kobo) at every boundary. Doubles are used rather than integer kobo
// because the D1/SQLite storage type is REAL and because unit costs are
// DELIBERATELY full-precision (see splitTotalCost in uom.js: a carton of
// 7,000 units for ₦480,000 is ₦68.5714…/unit, and rounding that to kobo
// undervalues every delivery by ₦10 forever).
//
// RULE: valuation keeps full precision; DISPLAY and any figure that
// leaves the system is rounded. round2() is the only rounding function.
//
// PORTABILITY: plain ES, no Node APIs, no imports — usable verbatim from
// both server/lib (Node + better-sqlite3) and worker/src (Cloudflare
// Workers + D1). This is the "one domain core, two backends" contract.
// =====================================================================

// Half-up rounding to 2 decimal places.
//
// The Number.EPSILON nudge is load-bearing, not cargo cult: 1.005 is
// stored as 1.00499999999999989… so a naive Math.round(1.005 * 100)/100
// returns 1.00 instead of 1.01. On a ₦1.005 margin line that is a kobo
// that silently vanishes on every transaction, forever.
function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

// Kobo as the smallest legal tender unit. Nigerian cash cannot pay a
// fraction of a kobo, so any figure destined for a cash drawer is
// rounded to whole kobo — never truncated, which would systematically
// favour the customer and leak money at volume.
function toKobo(n) {
  return Math.round(round2(n) * 100);
}

function fromKobo(kobo) {
  return round2(Number(kobo) / 100);
}

// Cash rounding for the Naira. There is no 0.5 kobo coin in circulation
// and the Central Bank of Nigeria's lowest circulating denomination is
// 50 kobo, so a till physically cannot give change below that. We round
// the CASH leg only — a transfer/POS-terminal payment is settled to the
// exact kobo by the bank and must not be rounded, or the receipt and the
// bank statement disagree.
const CASH_ROUNDING_STEP = 0.5; // ₦0.50 = 50 kobo

function roundCashAmount(n) {
  const step = CASH_ROUNDING_STEP;
  return round2(Math.round(Number(n) / step) * step);
}

// Is this a plausible money figure? Guards against the two real-world
// input failures that corrupt books: NaN from an empty form field, and a
// negative from a sign error. Zero is legal (a 100% discount, a free
// warranty part) but must be intentional, so callers decide separately.
function isMoney(n) {
  return Number.isFinite(Number(n)) && Number(n) >= 0;
}

function isStrictlyPositiveMoney(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0;
}

// A hard sanity ceiling. ₦10 billion on a single retail line is a typo
// (an extra digit on a ₦10,000 air-conditioner) far more often than a
// real transaction, and accepting it silently poisons every downstream
// report. Deliberately a WARNING the caller may override rather than a
// hard reject — a genuine bulk wholesale order can legitimately be large,
// and a system that blocks real business gets worked around, which is
// worse than the typo it was protecting against.
const PLAUSIBILITY_CEILING = 10_000_000_000; // ₦10bn

function isPlausible(n) {
  return isMoney(n) && Number(n) <= PLAUSIBILITY_CEILING;
}

// ---------------------------------------------------------------------
// ARITHMETIC HELPERS
// ---------------------------------------------------------------------

// Sum a list of amounts, rounding ONCE at the end rather than per item.
// Rounding each element first is the classic way a basket of 7 lines
// fails to equal its own total by a kobo.
function sum(amounts) {
  let total = 0;
  for (const a of amounts || []) {
    const x = Number(a);
    if (Number.isFinite(x)) total += x;
  }
  return round2(total);
}

function sumBy(rows, field) {
  return sum((rows || []).map((r) => Number(r && r[field]) || 0));
}

// Margin and markup are different numbers and mixing them up is the most
// common retail-pricing error. Both are here so no caller can invent one.
//   margin  = (price - cost) / price        -> share of the SELLING price
//   markup  = (price - cost) / cost         -> share added ON TOP of cost
// Division by zero returns null (not Infinity, not 0) so the UI can show
// "—" for a free or zero-cost item instead of a nonsense percentage.
function marginPercent(price, cost) {
  const p = Number(price);
  const c = Number(cost);
  if (!Number.isFinite(p) || p === 0) return null;
  return round2(((p - (Number.isFinite(c) ? c : 0)) / p) * 100);
}

function markupPercent(price, cost) {
  const p = Number(price);
  const c = Number(cost);
  if (!Number.isFinite(c) || c === 0) return null;
  return round2(((p - c) / c) * 100);
}

function grossProfit(price, cost, qty) {
  return round2((Number(price) - Number(cost || 0)) * Number(qty || 0));
}

// Apply a percentage discount, never below zero and never above 100%.
// A discount field is a place where a fat-fingered "50" meaning ₦50 gets
// typed as "5000" meaning 5000% — clamping to [0,100] turns a book
// corruption into an obvious on-screen mistake.
function applyPercentDiscount(amount, percent) {
  const a = Number(amount) || 0;
  let p = Number(percent);
  if (!Number.isFinite(p)) p = 0;
  p = Math.min(100, Math.max(0, p));
  return round2(a - (a * p) / 100);
}

function applyFixedDiscount(amount, fixed) {
  const a = Number(amount) || 0;
  const f = Number(fixed);
  if (!Number.isFinite(f) || f < 0) return round2(a);
  return round2(Math.max(0, a - f));
}

// ---------------------------------------------------------------------
// FORMATTING
// ---------------------------------------------------------------------
// 'en-NG' gives the grouping Nigerians read (1,234,567.89). The ₦ sign
// is applied by the caller's choice of symbol, NOT hardcoded, because
// white-labelled deployments may trade across borders (Ghana, Benin) and
// client_settings carries the currency symbol.
function formatMoney(n, { symbol = '₦', decimals = 2, sign = false } = {}) {
  const x = Number(n);
  const v = Number.isFinite(x) ? x : 0;
  const body = v.toLocaleString('en-NG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const neg = v < 0;
  return `${neg || sign ? (neg ? '-' : '+') : ''}${symbol}${neg ? body.replace('-', '') : body}`;
}

// Compact form for dashboard tiles where "₦12,480,000" will not fit:
// renders ₦12.48M / ₦480.5K. This is a DISPLAY convenience only — never
// feed a compacted string back into arithmetic.
function formatCompact(n, { symbol = '₦' } = {}) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${symbol}${round2(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}${symbol}${round2(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${symbol}${round2(abs / 1_000)}K`;
  return `${sign}${symbol}${round2(abs)}`;
}

function formatPercent(n, { decimals = 1 } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(decimals)}%`;
}

module.exports = {
  round2,
  toKobo,
  fromKobo,
  roundCashAmount,
  CASH_ROUNDING_STEP,
  PLAUSIBILITY_CEILING,
  isMoney,
  isStrictlyPositiveMoney,
  isPlausible,
  sum,
  sumBy,
  marginPercent,
  markupPercent,
  grossProfit,
  applyPercentDiscount,
  applyFixedDiscount,
  formatMoney,
  formatCompact,
  formatPercent,
};
