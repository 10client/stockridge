'use strict';
// =====================================================================
// domain/money.js — money arithmetic for the Nigerian Naira
// =====================================================================
// WHY THIS FILE EXISTS
// Every kobo discrepancy in this system is a real argument with a real
// customer or a real hole in a real till. Floating-point money arithmetic
// in JavaScript produces those discrepancies constantly:
//
//   0.1 + 0.2 === 0.30000000000000004
//   1250.005 * 100 === 125000.49999999999   -> Math.round gives 125000
//
// The second example is the dangerous one: it rounds the WRONG WAY on a
// half-kobo boundary and does so silently. `round2` below adds
// Number.EPSILON before scaling, which nudges 125000.49999999999 over
// the boundary so it rounds to 125001 as a human would expect.
//
// This exact function is used by glService, wht, pricing and the till
// reconciliation. ONE definition, so a figure computed in one place and a
// figure computed in another can never disagree by a hair. That matters
// because several CHECK constraints in the schema enforce equalities to
// 2dp — gross = net + wht, total = paid + balance_due — and a rounding
// disagreement between two callers turns into a rejected INSERT at the
// worst possible moment: mid-queue, at the counter.
// =====================================================================

/** Round to 2 decimal places, tolerant of IEEE-754 representation dust. */
function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round to an arbitrary number of decimal places (unit costs keep more). */
function roundTo(n, places) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, places);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Coerce to a finite non-negative number, or null when it is not one. */
function toMoney(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[^0-9.eE+-]/g, '')) : Number(value);
  return Number.isFinite(n) ? round2(n) : null;
}

/** Coerce to a finite quantity (may be fractional for measured goods). */
function toQty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Sum an array of money values with a single final rounding. */
function sum(values) {
  let total = 0;
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return round2(total);
}

/**
 * Split `total` across `parts` weights so the pieces add back to the total
 * EXACTLY, to the kobo. The last part absorbs the rounding remainder.
 *
 * Used for: allocating PO freight across lines, allocating an order-level
 * discount across sale lines, and splitting VAT across categories. Naive
 * division leaves a kobo or two unallocated, which then fails a CHECK
 * constraint or makes a category report not foot to the invoice.
 */
function allocate(total, weights) {
  const t = round2(Number(total) || 0);
  const w = (weights || []).map((x) => Math.max(0, Number(x) || 0));
  const weightSum = w.reduce((a, b) => a + b, 0);
  if (!w.length) return [];
  if (weightSum <= 0) {
    // No basis to allocate on: spread evenly rather than dropping the money.
    const even = roundTo(t / w.length, 2);
    const out = w.map(() => even);
    out[out.length - 1] = round2(t - even * (out.length - 1));
    return out;
  }
  let assigned = 0;
  const out = w.map((weight, i) => {
    if (i === w.length - 1) return round2(t - assigned);
    const share = round2((t * weight) / weightSum);
    assigned = round2(assigned + share);
    return share;
  });
  return out;
}

/**
 * Percentage change, guarding the divide-by-zero that a first sale of the
 * day against a zero baseline otherwise produces (Infinity, which then
 * renders as "Infinity%" on a dashboard and JSON-serialises to null).
 */
function pctChange(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c === 0 ? 0 : null; // null = "not comparable", distinct from 0%
  return round2(((c - p) / Math.abs(p)) * 100);
}

/** Margin percentage from cost and price, guarding a zero cost. */
function marginPct(cost, price) {
  const c = Number(cost) || 0;
  const p = Number(price) || 0;
  if (p === 0) return null;
  if (c === 0) return null; // a zero cost means the cost is unknown, not that margin is 100%
  return round2(((p - c) / p) * 100);
}

/** Markup percentage (profit over COST, not over price — the two differ). */
function markupPct(cost, price) {
  const c = Number(cost) || 0;
  if (c === 0) return null;
  return round2((((Number(price) || 0) - c) / c) * 100);
}

/**
 * Format for display. Nigerian convention: ₦ symbol, thousands separated,
 * 2dp only when there are kobo to show. This is a DISPLAY concern and is
 * deliberately separate from round2 — the stored value always keeps full
 * precision for unit costs (see the note on stock_batches.cost_price_per_unit).
 */
function formatNaira(value, { symbol = '₦', alwaysDecimals = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${symbol}0.00`;
  const hasKobo = Math.abs(n * 100 - Math.round(n * 100)) > 1e-9 || Math.round(Math.abs(n) * 100) % 100 !== 0;
  const decimals = alwaysDecimals || hasKobo ? 2 : 0;
  return symbol + n.toLocaleString('en-NG', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Compact format for dashboard tiles: ₦1.2m, ₦450k. */
function formatCompact(value, { symbol = '₦' } = {}) {
  const n = Math.abs(Number(value) || 0);
  const sign = (Number(value) || 0) < 0 ? '-' : '';
  if (n >= 1e9) return `${sign}${symbol}${roundTo(n / 1e9, 2)}b`;
  if (n >= 1e6) return `${sign}${symbol}${roundTo(n / 1e6, 2)}m`;
  if (n >= 1e3) return `${sign}${symbol}${roundTo(n / 1e3, 1)}k`;
  return `${sign}${formatNaira(n, { symbol })}`;
}

/**
 * Compare two money values for equality within a kobo tolerance. Used by
 * reconciliation and by tests, so a float artefact never reads as a real
 * variance. A till that is out by 0.004 kobo is not a till that is out.
 */
function moneyEqual(a, b, tolerance = 0.005) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tolerance;
}

module.exports = {
  round2, roundTo, toMoney, toQty, sum, allocate,
  pctChange, marginPct, markupPct,
  formatNaira, formatCompact, moneyEqual,
};
