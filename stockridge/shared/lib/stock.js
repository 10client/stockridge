// =====================================================================
// shared/lib/stock.js — STOCK PICKING, VALUATION AND MOVEMENT RULES
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: the FEFO batch-picking logic lived inside
// salesService and was implicitly "pick the batch that expires soonest". For a
// general retailer expiry is only ONE of several reasons to prefer a batch, so
// the rule is generalised to an explicit, ordered POLICY:
//
//   FEFO   first-expired-first-out   (food, paint, cement, cosmetics)
//   FIFO   first-in-first-out        (the default: furniture, hardware,
//                                    anything with no shelf life)
//   LIFO   last-in-first-out         (rarely correct for stock, but some
//                                    clients ask for it to match a costing
//                                    method their accountant uses)
//   SPECIFIC  the operator picks the exact batch (serialised goods, or a
//             customer collecting a layaway item they physically chose)
//
// WHY THIS IS THE MOST DANGEROUS CODE IN THE SYSTEM:
// Every other module reads stock. If picking decrements the wrong batch, the
// quantity total still looks right while the COST is wrong, so margin, COGS,
// stock valuation and the GL are all quietly wrong — and nothing on any screen
// looks broken. That is why:
//   * picking is a PURE function over a batch list (testable in isolation);
//   * the returned allocation is EXHAUSTIVE-checked against availability
//     before any write;
//   * every movement writes a stock_movements row so the batch history can be
//     replayed and audited against the balances.

'use strict';

const { round2, toKobo, fromKobo, allocateKobo } = require('./money');

const PICK_POLICIES = Object.freeze(['FEFO', 'FIFO', 'LIFO', 'SPECIFIC']);

const MOVEMENT_TYPES = Object.freeze([
  'RECEIPT',            // goods received against a PO -> stock in
  'SALE',               // sold -> stock out
  'SALE_RETURN',        // customer returned -> stock in (restock) or scrapped
  'TRANSFER_OUT',       // sent to another branch -> stock out
  'TRANSFER_IN',        // received from another branch -> stock in
  'ADJUSTMENT',         // stocktake variance, damage, theft, found
  'LAYAWAY_RESERVE',    // held for a customer (still on hand, not sellable)
  'LAYAWAY_RELEASE',    // hold released back to sellable, or converted to sale
  'DELIVERY_DISPATCH',  // left the branch for a customer under a delivery job
  'WARRANTY_SWAP',      // replaced unit out / replacement unit in
  'OPENING_BALANCE',    // the stock a client started with
  'WRITE_OFF',          // explicitly scrapped (damaged beyond sale)
]);

/**
 * Sort batches according to the picking policy.
 *
 * `batches` are the AVAILABLE rows for (branch, product): each carries
 *   quantity_on_hand, quantity_reserved, cost_per_unit, best_before_date,
 *   received_at, id
 * Only batches with a positive SELLABLE quantity are returned. Sellable is
 *   on_hand - reserved
 * because a layaway hold or a dispatched-but-undelivered item is physically on
 * the shelf but already spoken for. Selling it twice is the single most common
 * way a multi-till shop oversells.
 */
function pickBatches(batches, { policy = 'FIFO', requiredQty, specificBatchIds = null, now = new Date() }) {
  const need = Math.round(Number(requiredQty) || 0);
  if (need <= 0) return { ok: true, allocation: [], short: 0, policy };

  const p = String(policy || 'FIFO').toUpperCase();
  if (!PICK_POLICIES.includes(p)) {
    return { ok: false, code: 'UNKNOWN_PICK_POLICY', error: `Unknown stock picking policy "${policy}".` };
  }

  let pool = (batches || [])
    .map((b) => ({
      ...b,
      sellable: Math.max(0, (Number(b.quantity_on_hand) || 0) - (Number(b.quantity_reserved) || 0)),
    }))
    .filter((b) => b.sellable > 0);

  if (p === 'SPECIFIC') {
    const wanted = new Set((specificBatchIds || []).map(String));
    if (!wanted.size) {
      return { ok: false, code: 'NO_BATCH_SPECIFIED', error: 'Choose which batch to take this from.' };
    }
    pool = pool.filter((b) => wanted.has(String(b.id)));
    // In SPECIFIC mode we keep the caller's order (the operator's choice).
  } else {
    pool = sortForPolicy(pool, p);
  }

  const allocation = [];
  let remaining = need;
  for (const b of pool) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.sellable);
    if (take <= 0) continue;
    allocation.push({
      stock_batch_id: b.id,
      batch_no: b.batch_no || null,
      quantity: take,
      cost_per_unit: Number(b.cost_per_unit) || 0,
      costKobo: toKobo(Number(b.cost_per_unit) || 0) * take,
      best_before_date: b.best_before_date || null,
      received_at: b.received_at || null,
    });
    remaining -= take;
  }

  if (remaining > 0) {
    // Report the shortfall precisely: the operator needs to know whether the
    // whole line is short or only the serialised part of it.
    return {
      ok: false,
      code: 'INSUFFICIENT_STOCK',
      error: `Only ${need - remaining} of ${need} available${p === 'SPECIFIC' ? ' in the selected batch(es)' : ''}.`,
      allocation,
      short: remaining,
      available: need - remaining,
      required: need,
      policy: p,
    };
  }

  return { ok: true, allocation, short: 0, policy: p };
}

function sortForPolicy(pool, policy) {
  const copy = pool.slice();
  if (policy === 'FEFO') {
    // Soonest best-before first. Batches with NO date sort LAST — a dateless
    // batch must never win over one that is about to expire, or the expiry
    // alert feature stops working in practice.
    copy.sort((a, b) => {
      const ad = a.best_before_date ? Date.parse(a.best_before_date) : Infinity;
      const bd = b.best_before_date ? Date.parse(b.best_before_date) : Infinity;
      if (ad !== bd) return ad - bd;
      // tie-break: oldest receipt first, so FEFO degrades gracefully to FIFO
      return receiptTime(a) - receiptTime(b);
    });
  } else if (policy === 'LIFO') {
    copy.sort((a, b) => receiptTime(b) - receiptTime(a));
  } else {
    copy.sort((a, b) => receiptTime(a) - receiptTime(b));
  }
  return copy;
}

function receiptTime(b) {
  const t = Date.parse(b.received_at || b.created_at || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Weighted average cost of an allocation, at full precision.
 *
 * Used to value a sale's COGS when the picking spans several batches bought at
 * different prices. Returned unrounded on purpose (see receiving.splitTotalCost
 * for why rounding a per-unit figure is a permanent, compounding error); the
 * CALLER rounds once, at the point of storage.
 */
function weightedCost(allocation) {
  const list = allocation || [];
  const totalQty = list.reduce((a, l) => a + (Number(l.quantity) || 0), 0);
  if (totalQty <= 0) return { totalQty: 0, costKobo: 0, costPerUnit: 0, costPerUnitRounded: 0 };
  const costKobo = list.reduce((a, l) => a + (Number(l.costKobo) || 0), 0);
  return {
    totalQty,
    costKobo,
    costPerUnit: costKobo / totalQty / 100,
    costPerUnitRounded: fromKobo(Math.round(costKobo / totalQty)),
    cost: fromKobo(costKobo),
  };
}

/**
 * Value a set of batches at cost. This is the figure on the stock-valuation
 * report and the "Inventory" line of the balance sheet, so it must be computed
 * from the SAME per-unit precision the receipt used.
 */
function valueBatches(batches) {
  let costKobo = 0;
  let retailKobo = 0;
  let units = 0;
  for (const b of batches || []) {
    const q = Math.max(0, Number(b.quantity_on_hand) || 0);
    units += q;
    costKobo += toKobo(Number(b.cost_per_unit) || 0) * q;
    retailKobo += toKobo(Number(b.selling_price_per_unit) || 0) * q;
  }
  return {
    units,
    costKobo, cost: fromKobo(costKobo),
    retailKobo, retail: fromKobo(retailKobo),
    potentialMarginKobo: retailKobo - costKobo,
    potentialMargin: fromKobo(retailKobo - costKobo),
    potentialMarginPercent: retailKobo > 0 ? round2(((retailKobo - costKobo) / retailKobo) * 100) : 0,
  };
}

/**
 * Stock ageing. A retailer that cannot see what has not moved in 90 days is a
 * retailer holding dead capital. Buckets are the conventional retail ones.
 */
const AGE_BUCKETS = Object.freeze([
  { code: '0_30',   label: '0-30 days',   min: 0,   max: 30 },
  { code: '31_60',  label: '31-60 days',  min: 31,  max: 60 },
  { code: '61_90',  label: '61-90 days',  min: 61,  max: 90 },
  { code: '91_180', label: '91-180 days', min: 91,  max: 180 },
  { code: '180_PLUS', label: 'Over 180 days (dead stock)', min: 181, max: Infinity },
]);

function ageBucket(daysOld) {
  const d = Math.max(0, Math.floor(Number(daysOld) || 0));
  return AGE_BUCKETS.find((b) => d >= b.min && d <= b.max) || AGE_BUCKETS[AGE_BUCKETS.length - 1];
}

/**
 * Reorder advice.
 *
 * reorder_level alone is not enough for a multi-branch retailer: a branch that
 * sells 40 units a week and a branch that sells 2 units a month cannot share a
 * sensible reorder point. So the recommendation is driven by observed velocity
 * and supplier lead time, with the client's own reorder_level as a floor.
 *
 *   suggested = max(reorder_level, ceil(avgDailySales * (leadTimeDays + reviewDays)))
 *
 * `stockCoverDays` is the number a manager actually reads: how long until this
 * branch runs out at current velocity.
 */
function reorderAdvice({ quantityOnHand, reorderLevel, avgDailySales, leadTimeDays = 7, reviewDays = 7, safetyFactor = 1.25 }) {
  const onHand = Math.max(0, Number(quantityOnHand) || 0);
  const ads = Math.max(0, Number(avgDailySales) || 0);
  const lead = Math.max(0, Number(leadTimeDays) || 0);
  const review = Math.max(0, Number(reviewDays) || 0);
  const rl = Math.max(0, Number(reorderLevel) || 0);

  const demandDuringLead = ads * (lead + review) * (Number(safetyFactor) || 1);
  const suggested = Math.max(rl, Math.ceil(demandDuringLead));
  const stockCoverDays = ads > 0 ? Math.floor(onHand / ads) : (onHand > 0 ? Infinity : 0);

  return {
    quantityOnHand: onHand,
    reorderLevel: rl,
    avgDailySales: round2(ads),
    stockCoverDays: Number.isFinite(stockCoverDays) ? stockCoverDays : null,
    suggestedReorderPoint: Math.ceil(suggested),
    shouldReorder: onHand <= suggested,
    urgency: onHand === 0 ? 'OUT_OF_STOCK'
      : onHand <= rl ? 'CRITICAL'
        : onHand <= suggested ? 'REORDER'
          : stockCoverDays !== null && stockCoverDays <= lead ? 'WATCH'
            : 'OK',
  };
}

/**
 * Shelf-life / best-before alerts.
 *
 * Generalised from PharmaRidge's expiry alerts: same three horizons, but the
 * ACTION differs by vertical. Food gets marked down or destroyed; paint gets
 * stirred and sold; a mattress with a manufacturing date gets discounted. The
 * horizon days are a client setting, not a constant.
 */
function shelfLifeAlerts({ batches, horizonsDays = [7, 30, 90], today = new Date() }) {
  const todayIso = (today instanceof Date ? today : new Date(today)).toISOString().slice(0, 10);
  const out = [];
  for (const b of batches || []) {
    if (!b.best_before_date) continue;
    const days = Math.round((Date.parse(`${String(b.best_before_date).slice(0, 10)}T00:00:00Z`)
      - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000);
    const qty = Number(b.quantity_on_hand) || 0;
    if (qty <= 0) continue;
    let band = null;
    if (days < 0) band = 'EXPIRED';
    else {
      const sorted = horizonsDays.slice().sort((a, c) => a - c);
      band = sorted.find((h) => days <= h);
      band = band == null ? null : `WITHIN_${band}`;
    }
    if (!band) continue;
    out.push({
      stock_batch_id: b.id,
      product_id: b.product_id,
      product_name: b.product_name || null,
      branch_id: b.branch_id,
      batch_no: b.batch_no || null,
      best_before_date: String(b.best_before_date).slice(0, 10),
      days_remaining: days,
      band,
      quantity_on_hand: qty,
      cost_value: fromKobo(toKobo(Number(b.cost_per_unit) || 0) * qty),
      retail_value: fromKobo(toKobo(Number(b.selling_price_per_unit) || 0) * qty),
      recommended_action: band === 'EXPIRED' ? 'WRITE_OFF'
        : days <= 7 ? 'MARKDOWN_OR_RETURN_TO_SUPPLIER'
          : 'MARKDOWN',
    });
  }
  // Soonest first, then largest value at risk.
  out.sort((a, b) => (a.days_remaining - b.days_remaining) || (b.retail_value - a.retail_value));
  return out;
}

/**
 * Net movement for a period, from stock_movements.
 *
 * THREE directions, not two, since migration 0007:
 *   +1  units arrived
 *   -1  units left
 *    0  reservation changed only — no unit moved
 *
 * A direction of 0 must contribute to NEITHER the in nor the out total. The
 * previous version of this function inferred a missing direction from the
 * movement TYPE and defaulted to +1, which counted a layaway hold as stock
 * ARRIVING: a batch showing 1 unit on hand would reconcile against 2 units of
 * movement history. That is the discrepancy this now refuses to produce.
 */
function netMovement(movements) {
  let inQty = 0; let outQty = 0; let inKobo = 0; let outKobo = 0;
  let reservedQty = 0; let releasedQty = 0;
  for (const m of movements || []) {
    const dir = Number(m.direction);
    // Reservation effects are tracked separately, because they are real changes
    // to what the branch can sell but are NOT changes to what it holds.
    const rd = Number(m.reservation_delta) || 0;
    if (rd > 0) reservedQty += rd;
    else if (rd < 0) releasedQty += -rd;

    if (!Number.isFinite(dir) || dir === 0) continue;   // nothing physical moved
    const q = Math.abs(Number(m.quantity) || 0);
    const k = Math.abs(Number(m.value_kobo) || 0);
    if (dir < 0) { outQty += q; outKobo += k; } else { inQty += q; inKobo += k; }
  }
  return {
    inQty, outQty, netQty: inQty - outQty,
    inValue: fromKobo(inKobo), outValue: fromKobo(outKobo), netValue: fromKobo(inKobo - outKobo),
    reservedQty, releasedQty, netReserved: reservedQty - releasedQty,
  };
}

module.exports = {
  PICK_POLICIES, MOVEMENT_TYPES, AGE_BUCKETS,
  pickBatches, weightedCost, valueBatches,
  ageBucket, reorderAdvice, shelfLifeAlerts, netMovement,
};
