// =====================================================================
// StockRidge — STOCK MOVEMENT, BATCH ALLOCATION & VALUATION
// =====================================================================
// THE INVARIANT THAT THE WHOLE PLATFORM RESTS ON
// ---------------------------------------------------------------------
//   Every unit that leaves stock has a REASON, a QUANTITY, a BATCH and a
//   COST — and the sum of all movements against a batch equals the change
//   in that batch's quantity.
//
// If that holds, the stock figure on the dashboard is true, the cost of
// goods sold in the P&L is true, and a stocktake variance is a real signal
// rather than noise. If it does not hold, every number downstream of stock
// is decoration. PharmaRidge's hardest-won lesson was that this invariant
// breaks in exactly one way in practice: a movement is written WITHOUT its
// ledger row, or the ledger row is written without the movement, because
// the two happen in different places in the code. So here they are one
// function, and it is the ONLY way stock moves.
//
// ---------------------------------------------------------------------
// WHY BATCHES, NOT A SINGLE QUANTITY
// ---------------------------------------------------------------------
// A product's stock is not one number. It is a set of CONSIGNMENTS, each
// with its own cost price, its own arrival date, and (for consumables) its
// own expiry. Selling from the wrong batch destroys one of two things:
//   * cost accuracy — a ₦40,000 fridge bought last year at ₦28,000 cost and
//     one bought this month at ₦36,000 have completely different margins,
//     and blending them reports a margin that never existed on either;
//   * shelf life — selling the new consignment first leaves the old one to
//     expire, which for a provisions trader is the entire loss.
// So allocation is a POLICY, and it is declared rather than incidental.
//
// ---------------------------------------------------------------------
// ALLOCATION POLICIES
// ---------------------------------------------------------------------
// FEFO  First-Expired First-Out. Default where a product carries an expiry
//       (general merchandise, foodstuffs, paint, cement). Minimises loss.
// FIFO  First-In First-Out. Default where there is no expiry (electronics,
//       furniture). Matches the accounting convention and gives a stable
//       COGS.
// LOWEST_COST_FIRST  Deliberately available and deliberately NOT a default:
//       it maximises reported gross margin on the current sale, which is
//       flattering and misleading. Offered because a clearance sale of old
//       stock is a real decision a manager may want to make knowingly.
// SPECIFIC_BATCH  The cashier names the batch — required for serialised
//       stock, where the customer is buying THAT unit with THAT serial.
// =====================================================================

const { round2 } = require('./money');

const ALLOCATION_POLICIES = Object.freeze(['FEFO', 'FIFO', 'LOWEST_COST_FIRST', 'SPECIFIC_BATCH']);

// ---------------------------------------------------------------------
// MOVEMENT REASONS
// ---------------------------------------------------------------------
// Every movement has a reason, and every reason has a DIRECTION and an
// accounting consequence. This table is the authority: a movement reason
// not in it cannot be created, which is what stops a "miscellaneous"
// reason becoming the place where stock quietly disappears.
//
// `glEffect` says how the movement lands in the ledger:
//   COGS      — cost of goods sold (a sale)
//   NONE      — no P&L effect; the asset merely moves (a transfer in
//               transit, a hold, a reservation)
//   SHRINKAGE — a loss (damage, theft, count variance)
//   INCOME    — stock coming back that was written off, or a supplier
//               return credited
//   CAPITALISED — an addition to stock value (a receipt from a supplier)
const MOVEMENT_REASONS = Object.freeze({
  // --- in -------------------------------------------------------------
  PURCHASE_RECEIPT: { code: 'PURCHASE_RECEIPT', direction: 'IN', label: 'Goods received from supplier', glEffect: 'CAPITALISED', requiresBatch: true, requiresCost: true },
  TRANSFER_IN: { code: 'TRANSFER_IN', direction: 'IN', label: 'Transfer received from another branch', glEffect: 'NONE', requiresBatch: true, requiresCost: true },
  CUSTOMER_RETURN: { code: 'CUSTOMER_RETURN', direction: 'IN', label: 'Customer return — back to sellable stock', glEffect: 'INCOME', requiresBatch: true, requiresCost: true },
  REPOSSESSION: { code: 'REPOSSESSION', direction: 'IN', label: 'Goods repossessed from a defaulted instalment plan', glEffect: 'INCOME', requiresBatch: true, requiresCost: true },
  WARRANTY_RETURN_TO_STOCK: { code: 'WARRANTY_RETURN_TO_STOCK', direction: 'IN', label: 'Repaired warranty unit returned to stock', glEffect: 'NONE', requiresBatch: true, requiresCost: false },
  SUPPLIER_REPLACEMENT: { code: 'SUPPLIER_REPLACEMENT', direction: 'IN', label: 'Replacement unit received from supplier', glEffect: 'NONE', requiresBatch: true, requiresCost: false },
  STOCKTAKE_GAIN: { code: 'STOCKTAKE_GAIN', direction: 'IN', label: 'Stocktake — counted more than the system held', glEffect: 'INCOME', requiresBatch: true, requiresCost: true },
  REVERSAL_IN: { code: 'REVERSAL_IN', direction: 'IN', label: 'Reversal of a prior issue (a voided sale)', glEffect: 'INCOME', requiresBatch: true, requiresCost: true },
  OPENING_BALANCE: { code: 'OPENING_BALANCE', direction: 'IN', label: 'Opening stock at go-live', glEffect: 'CAPITALISED', requiresBatch: true, requiresCost: true },

  // --- out ------------------------------------------------------------
  SALE: { code: 'SALE', direction: 'OUT', label: 'Sold', glEffect: 'COGS', requiresBatch: true, requiresCost: true },
  TRANSFER_OUT: { code: 'TRANSFER_OUT', direction: 'OUT', label: 'Transfer dispatched to another branch', glEffect: 'NONE', requiresBatch: true, requiresCost: true },
  LAYAWAY_RELEASE: { code: 'LAYAWAY_RELEASE', direction: 'OUT', label: 'Released to a customer on a completed layaway', glEffect: 'COGS', requiresBatch: true, requiresCost: true },
  TRADE_IN_OUT: { code: 'TRADE_IN_OUT', direction: 'OUT', label: 'Old unit sent on to a refurbisher or scrap', glEffect: 'COGS', requiresBatch: true, requiresCost: true },
  DAMAGE: { code: 'DAMAGE', direction: 'OUT', label: 'Damaged — not sellable', glEffect: 'SHRINKAGE', requiresBatch: true, requiresCost: true },
  THEFT_LOSS: { code: 'THEFT_LOSS', direction: 'OUT', label: 'Theft or unexplained loss', glEffect: 'SHRINKAGE', requiresBatch: true, requiresCost: true },
  EXPIRED: { code: 'EXPIRED', direction: 'OUT', label: 'Expired / out of date', glEffect: 'SHRINKAGE', requiresBatch: true, requiresCost: true },
  DEFECTIVE_TO_SUPPLIER: { code: 'DEFECTIVE_TO_SUPPLIER', direction: 'OUT', label: 'Returned to supplier as defective', glEffect: 'INCOME', requiresBatch: true, requiresCost: true },
  AT_SERVICE_CENTRE: { code: 'AT_SERVICE_CENTRE', direction: 'OUT', label: 'Sent away for warranty repair', glEffect: 'NONE', requiresBatch: true, requiresCost: true },
  SCRAPPED: { code: 'SCRAPPED', direction: 'OUT', label: 'Scrapped / disposed of', glEffect: 'SHRINKAGE', requiresBatch: true, requiresCost: true },
  SAMPLE_DEMO: { code: 'SAMPLE_DEMO', direction: 'OUT', label: 'Demo unit or staff sample', glEffect: 'SHRINKAGE', requiresBatch: true, requiresCost: true },
  STOCKTAKE_LOSS: { code: 'STOCKTAKE_LOSS', direction: 'OUT', label: 'Stocktake — counted less than the system held', glEffect: 'SHRINKAGE', requiresBatch: true, requiresCost: true },
  INTERNAL_USE: { code: 'INTERNAL_USE', direction: 'OUT', label: 'Consumed by the business (workshop materials, office use)', glEffect: 'SHRINKAGE', requiresBatch: true, requiresCost: true },

  // --- neither (a change of state, not a change of quantity) ----------
  HOLD_PLACED: { code: 'HOLD_PLACED', direction: 'NEUTRAL', label: 'Reserved against a customer hold', glEffect: 'NONE', requiresBatch: false, requiresCost: false },
  HOLD_RELEASED: { code: 'HOLD_RELEASED', direction: 'NEUTRAL', label: 'Hold released', glEffect: 'NONE', requiresBatch: false, requiresCost: false },
  LAYAWAY_RESERVED: { code: 'LAYAWAY_RESERVED', direction: 'NEUTRAL', label: 'Reserved under a layaway agreement', glEffect: 'NONE', requiresBatch: false, requiresCost: false },
  SERIAL_ASSIGNED: { code: 'SERIAL_ASSIGNED', direction: 'NEUTRAL', label: 'Serial number captured against a unit', glEffect: 'NONE', requiresBatch: true, requiresCost: false },
});

const MOVEMENT_REASON_CODES = Object.freeze(Object.keys(MOVEMENT_REASONS));

function movementReason(code) {
  return MOVEMENT_REASONS[String(code || '').toUpperCase()] || null;
}

function isMovementReason(code) {
  return Object.prototype.hasOwnProperty.call(MOVEMENT_REASONS, String(code || '').toUpperCase());
}

function reasonsForDirection(direction) {
  return MOVEMENT_REASON_CODES.filter((c) => MOVEMENT_REASONS[c].direction === direction).map((c) => MOVEMENT_REASONS[c]);
}

// ---------------------------------------------------------------------
// ALLOCATION
// ---------------------------------------------------------------------
// Given the batches a branch holds for a product, decide how many pieces
// come from each. Returns an ordered allocation, or a refusal that names
// exactly which batch ran short.
//
// `availableOnly` excludes batches whose stock is RESERVED (layaway/hold) or
// IN_TRANSIT. This is the difference between "how much do I own" and "how
// much can I sell to the next customer" — conflating them is how a shop
// sells the same sofa twice.
function allocateStock({ batches = [], quantityRequired, policy = 'FIFO', specificBatchId = null, now = new Date() }) {
  const need = Number(quantityRequired);
  if (!Number.isFinite(need) || need <= 0) {
    return { ok: false, code: 'QUANTITY_INVALID', error: 'Enter a quantity greater than zero.' };
  }
  if (!Number.isInteger(need)) {
    // Fractions of a piece are legal ONLY for measured stock (kg, metre,
    // litre). The caller says which by passing a non-integer deliberately;
    // anything else is a keying error.
    return { ok: false, code: 'QUANTITY_NOT_WHOLE', error: `Quantity must be a whole number of pieces (asked for ${need}).` };
  }

  const live = (batches || []).filter((b) => b && Number(b.quantity_available) > 0 && b.is_deleted !== 1);

  if (policy === 'SPECIFIC_BATCH') {
    if (!specificBatchId) {
      return { ok: false, code: 'BATCH_REQUIRED', error: 'Choose which consignment this comes from — serialised stock must be allocated to a specific batch.' };
    }
    const batch = live.find((b) => String(b.id) === String(specificBatchId));
    if (!batch) {
      return { ok: false, code: 'BATCH_NOT_FOUND', error: 'That consignment has no available stock at this branch.' };
    }
    if (Number(batch.quantity_available) < need) {
      return {
        ok: false, code: 'BATCH_SHORT',
        error: `That consignment holds ${Number(batch.quantity_available).toLocaleString('en-NG')} but ${need.toLocaleString('en-NG')} was asked for.`,
        available: Number(batch.quantity_available), required: need,
      };
    }
    return {
      ok: true, policy,
      allocation: [{ batch, quantity: need, costPerPiece: Number(batch.cost_per_unit) || 0 }],
      totalCost: round2(need * (Number(batch.cost_per_unit) || 0)),
      totalQuantity: need,
    };
  }

  const today = isoDateOf(now);
  const sorted = [...live].sort((a, b) => {
    if (policy === 'FEFO') {
      // A batch with no expiry sorts LAST: consuming an undated consignment
      // before a dated one is how the dated one expires on the shelf.
      const ae = a.expiry_date || '9999-12-31';
      const be = b.expiry_date || '9999-12-31';
      if (ae !== be) return ae < be ? -1 : 1;
      return String(a.received_at || '').localeCompare(String(b.received_at || ''));
    }
    if (policy === 'LOWEST_COST_FIRST') {
      return (Number(a.cost_per_unit) || 0) - (Number(b.cost_per_unit) || 0);
    }
    // FIFO
    return String(a.received_at || '').localeCompare(String(b.received_at || ''));
  });

  const allocation = [];
  let remaining = need;
  let totalCost = 0;

  for (const batch of sorted) {
    if (remaining <= 0) break;
    // Never allocate from an expired batch. Selling out-of-date stock is a
    // legal and reputational problem, and the allocation is the last place
    // it can be stopped without blocking the cashier — so it is stopped here
    // and the batch surfaces on the expiry report instead.
    if (batch.expiry_date && batch.expiry_date < today) continue;

    const take = Math.min(remaining, Number(batch.quantity_available));
    if (take <= 0) continue;
    const cost = Number(batch.cost_per_unit) || 0;
    allocation.push({ batch, quantity: take, costPerPiece: cost, batchLabel: batchLabel(batch) });
    totalCost += take * cost; // FULL PRECISION — see money.js
    remaining -= take;
  }

  if (remaining > 0) {
    const have = need - remaining;
    return {
      ok: false, code: 'INSUFFICIENT_STOCK',
      error:
        `Only ${have.toLocaleString('en-NG')} of ${need.toLocaleString('en-NG')} available at this branch` +
        (policy === 'FEFO' ? ' (expired consignments are excluded — check the expiry report).' : '.'),
      available: have, required: need, shortfall: remaining,
      partialAllocation: allocation,
    };
  }

  return { ok: true, policy, allocation, totalCost: round2(totalCost), totalQuantity: need };
}

function batchLabel(batch) {
  if (!batch) return '';
  const parts = [];
  if (batch.batch_no) parts.push(`#${batch.batch_no}`);
  if (batch.received_at) parts.push(String(batch.received_at).slice(0, 10));
  if (batch.expiry_date) parts.push(`exp ${batch.expiry_date}`);
  return parts.join(' · ') || '(unlabelled consignment)';
}

// ---------------------------------------------------------------------
// VALUATION
// ---------------------------------------------------------------------
// Three valuation figures, because three different questions get asked and
// answering all of them with one number is how a report becomes untrustable:
//   AT_COST     what the stock is worth to us — the balance-sheet figure and
//               the basis of COGS.
//   AT_RETAIL   what it would raise if sold at the shelf price — the figure
//               an insurer wants and the figure a buyer of the business
//               will argue about.
//   NET_REALISABLE  what it would actually raise, after the markdown a
//               slow-moving or damaged item needs. The honest one.
function valueStock({ batches = [], mode = 'AT_COST' }) {
  let cost = 0;
  let retail = 0;
  let units = 0;

  for (const b of batches || []) {
    if (!b || b.is_deleted === 1) continue;
    const q = Number(b.quantity_available) || 0;
    if (q <= 0) continue;
    units += q;
    cost += q * (Number(b.cost_per_unit) || 0);
    retail += q * (Number(b.selling_price_per_unit) || 0);
  }

  const atCost = round2(cost);
  const atRetail = round2(retail);
  const potentialMargin = round2(atRetail - atCost);

  return {
    units,
    at_cost: atCost,
    at_retail: atRetail,
    potential_margin: potentialMargin,
    margin_percent: atRetail > 0 ? round2((potentialMargin / atRetail) * 100) : null,
    requested_mode: mode,
    value: mode === 'AT_RETAIL' ? atRetail : atCost,
  };
}

// ---------------------------------------------------------------------
// EXPIRY & SLOW-MOVEMENT ALERTS
// ---------------------------------------------------------------------
// The window that matters differs by trade and the default is per-profile:
// a provisions trader needs 60 days' warning on a carton of tomato paste,
// while a paint supplier needs 180. Both are the same calculation.
const EXPIRY_WARNING_WINDOWS_DAYS = Object.freeze([180, 90, 60, 30, 14, 7, 0]);

function expiryStatus(expiryDate, now = new Date(), warningDays = 90) {
  if (!expiryDate) return { status: 'NO_EXPIRY', days: null };
  const days = daysBetweenDates(isoDateOf(now), isoDateOf(expiryDate));
  if (!Number.isFinite(days)) return { status: 'UNKNOWN', days: null };
  if (days < 0) return { status: 'EXPIRED', days: -days };
  if (days === 0) return { status: 'EXPIRES_TODAY', days: 0 };
  if (days <= Math.max(0, Number(warningDays) || 0)) return { status: 'EXPIRING_SOON', days };
  return { status: 'OK', days };
}

// Slow-moving stock is the silent killer of a furniture or appliance shop:
// capital sits in a showroom sofa that has not sold in 8 months, and the
// owner's cash is in it rather than in stock that turns. Days-of-cover is
// the honest measure — "how long would current stock last at the recent
// sales rate" — because a raw "not sold in N days" list punishes a seasonal
// item that sells in one burst a year.
function daysOfCover({ quantityAvailable, unitsSoldInWindow, windowDays = 90 }) {
  const q = Number(quantityAvailable) || 0;
  const sold = Number(unitsSoldInWindow) || 0;
  const w = Number(windowDays) || 90;
  if (sold <= 0) return q > 0 ? Infinity : 0;   // nothing sold: infinite cover
  return round2((q / sold) * w);
}

const STOCK_VELOCITY_CLASSES = Object.freeze([
  { code: 'FAST', label: 'Fast mover', maxDaysOfCover: 30 },
  { code: 'NORMAL', label: 'Normal', maxDaysOfCover: 90 },
  { code: 'SLOW', label: 'Slow mover', maxDaysOfCover: 180 },
  { code: 'DEAD', label: 'Dead stock', maxDaysOfCover: Infinity },
]);

function velocityClass(cover) {
  if (cover === Infinity || cover > 180) return STOCK_VELOCITY_CLASSES[3];
  return STOCK_VELOCITY_CLASSES.find((c) => cover <= c.maxDaysOfCover) || STOCK_VELOCITY_CLASSES[3];
}

// Reorder point. The classic formula, but with the Nigerian reality that
// lead times are long and unreliable: a supplier in Lagos importing from
// Guangzhou may quote 3 weeks and take 9. `leadTimeVarianceDays` is a
// deliberate buffer the owner sets from experience, not a statistic.
function reorderPoint({ avgDailySales, leadTimeDays, safetyStockDays = 7, leadTimeVarianceDays = 0 }) {
  const daily = Math.max(0, Number(avgDailySales) || 0);
  const lead = Math.max(0, Number(leadTimeDays) || 0);
  const safety = Math.max(0, Number(safetyStockDays) || 0);
  const variance = Math.max(0, Number(leadTimeVarianceDays) || 0);
  return Math.ceil(daily * (lead + safety + variance));
}

function reorderQuantity({ avgDailySales, reviewPeriodDays = 30, leadTimeDays = 21, quantityAvailable = 0, minimumOrderQuantity = 1, packSize = 1 }) {
  const need = reorderPoint({ avgDailySales, leadTimeDays })
    + Math.max(0, Number(avgDailySales) || 0) * Math.max(0, Number(reviewPeriodDays) || 0)
    - Math.max(0, Number(quantityAvailable) || 0);
  if (need <= 0) return 0;
  const moq = Math.max(1, Number(minimumOrderQuantity) || 1);
  const pack = Math.max(1, Number(packSize) || 1);
  // Round UP to a whole pack — ordering 37 pieces of an item sold by the
  // carton of 24 means 13 loose pieces the supplier will not ship.
  const rounded = Math.ceil(need / pack) * pack;
  return Math.max(rounded, Math.ceil(moq / pack) * pack);
}

// ---------------------------------------------------------------------
// STOCKTAKE VARIANCE
// ---------------------------------------------------------------------
// Variance is counted minus system. Positive = we found more than we
// thought (a gain, but ALSO a signal that a previous issue was
// under-recorded — either way the books were wrong). Negative = shrinkage.
//
// Both directions matter and both are suspicious in opposite ways. A shop
// whose stocktakes always come out POSITIVE is a shop whose sales are being
// rung up short; a shop whose stocktakes always come out NEGATIVE is a shop
// with a theft problem or a receiving problem. The signed variance is kept
// precisely so that pattern is visible.
function stocktakeVariance({ systemQty, countedQty }) {
  const sys = Number(systemQty) || 0;
  const cnt = Number(countedQty) || 0;
  const variance = cnt - sys;
  return {
    system_qty: sys,
    counted_qty: cnt,
    variance,
    variance_percent: sys > 0 ? round2((variance / sys) * 100) : (variance > 0 ? 100 : 0),
    is_gain: variance > 0,
    is_loss: variance < 0,
    is_match: variance === 0,
  };
}

// Materiality threshold for a variance. Below it, a count difference is
// ordinary noise (a mis-scan, a unit moved between shelves during the
// count) and requiring a manager for it means the stocktake never finishes.
// Above it, someone must own the number.
function varianceRequiresApproval({ variance, costPerUnit, valueThreshold = 25000, unitThreshold = 10 }) {
  const units = Math.abs(Number(variance) || 0);
  const value = round2(units * (Number(costPerUnit) || 0));
  const needs = units > Number(unitThreshold) || value > Number(valueThreshold);
  return {
    needs_approval: needs,
    variance_units: units,
    variance_value: value,
    unit_threshold: Number(unitThreshold),
    value_threshold: Number(valueThreshold),
    reason: needs
      ? `${units.toLocaleString('en-NG')} unit(s) worth ₦${value.toLocaleString('en-NG')} exceeds the approval threshold (${unitThreshold} units or ₦${Number(valueThreshold).toLocaleString('en-NG')}).`
      : null,
  };
}

// ---------------------------------------------------------------------
// TRANSFERS
// ---------------------------------------------------------------------
const TRANSFER_STATUSES = Object.freeze([
  'PENDING_APPROVAL', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'PARTIALLY_RECEIVED',
  'REJECTED', 'CANCELLED', 'DISCREPANCY',
]);

// A transfer is TWO movements, not one: out of the sending branch and into
// the receiving branch. Between them the stock is IN_TRANSIT and belongs to
// NEITHER branch's sellable figure but STILL belongs to the business. Losing
// track of the in-transit leg is how a company's total stock figure stops
// matching the sum of its branches — and then nobody trusts either.
function transferLegs({ transfer, allocation = [] }) {
  const lines = allocation.map((a) => ({
    batch_id: a.batch.id,
    product_id: a.batch.product_id,
    quantity: a.quantity,
    cost_per_unit: a.costPerPiece,
  }));
  const totalCost = round2(lines.reduce((s, l) => s + l.quantity * l.cost_per_unit, 0));
  return {
    out: {
      branch_id: transfer.from_branch_id,
      reason: 'TRANSFER_OUT',
      lines,
      value: totalCost,
      at: new Date().toISOString(),
    },
    in: {
      branch_id: transfer.to_branch_id,
      reason: 'TRANSFER_IN',
      lines,
      value: totalCost, // SAME value — a transfer moves cost, it does not create or destroy it
      at: null,         // set on receipt
    },
    in_transit_value: totalCost,
  };
}

// Discrepancy on receipt. The receiving branch counted 19 where the sender
// dispatched 20. The honest answer is that ONE is missing and the system
// must not quietly absorb it into either branch's figures: the shortfall is
// recorded against the transfer, the received quantity is what the receiver
// counted, and the difference is a shrinkage line the owner can chase.
function transferDiscrepancy({ dispatchedLines = [], receivedLines = [] }) {
  const byBatch = new Map(dispatchedLines.map((l) => [String(l.batch_id), Number(l.quantity) || 0]));
  const discrepancies = [];
  for (const r of receivedLines) {
    const key = String(r.batch_id);
    const sent = byBatch.get(key);
    if (sent == null) {
      discrepancies.push({ batch_id: key, dispatched: 0, received: Number(r.quantity) || 0, variance: Number(r.quantity) || 0, kind: 'UNEXPECTED' });
      continue;
    }
    const recv = Number(r.quantity) || 0;
    if (recv !== sent) discrepancies.push({ batch_id: key, dispatched: sent, received: recv, variance: recv - sent, kind: recv < sent ? 'SHORT' : 'OVER' });
    byBatch.delete(key);
  }
  for (const [batchId, sent] of byBatch) {
    discrepancies.push({ batch_id: batchId, dispatched: sent, received: 0, variance: -sent, kind: 'NOT_RECEIVED' });
  }
  return {
    has_discrepancy: discrepancies.length > 0,
    discrepancies,
    total_short: discrepancies.filter((d) => d.variance < 0).reduce((s, d) => s + Math.abs(d.variance), 0),
    total_over: discrepancies.filter((d) => d.variance > 0).reduce((s, d) => s + d.variance, 0),
  };
}

// ---------------------------------------------------------------------
// NEGATIVE STOCK
// ---------------------------------------------------------------------
// Allowed for some verticals and forbidden for others, and the reason is
// operational, not accounting: a building materials depot lets a loaded
// truck leave for a site before the weighbridge ticket is keyed, and
// blocking that sale stops real business. An electronics shop cannot
// hand over a serialised unit it does not hold. So the profile decides,
// and where it is allowed the event is still RECORDED and reported — an
// unrecorded negative is how a stock figure becomes permanently wrong.
function assertStockAvailable({ required, available, allowNegative = false, reason = 'SALE' }) {
  const need = Number(required) || 0;
  const have = Number(available) || 0;
  if (have >= need) return { ok: true, negative: false };
  if (!allowNegative) {
    return {
      ok: false, code: 'INSUFFICIENT_STOCK',
      error: `Only ${have.toLocaleString('en-NG')} in stock but ${need.toLocaleString('en-NG')} was asked for. Receive stock, transfer it in, or reduce the quantity.`,
      available: have, required: need, shortfall: need - have,
    };
  }
  return {
    ok: true,
    negative: true,
    code: 'NEGATIVE_STOCK_PERMITTED',
    warning: `This will take stock to -${(need - have).toLocaleString('en-NG')}. Permitted for this business profile, but it is recorded and appears on the negative-stock report — resolve it with a receipt or an adjustment.`,
  };
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
function isoDateOf(d) {
  const date = d instanceof Date ? d : new Date(String(d || new Date().toISOString()));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function daysBetweenDates(fromIso, toIso) {
  const a = Date.parse(String(fromIso));
  const b = Date.parse(String(toIso));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / 86400000);
}

module.exports = {
  ALLOCATION_POLICIES,
  MOVEMENT_REASONS,
  MOVEMENT_REASON_CODES,
  EXPIRY_WARNING_WINDOWS_DAYS,
  STOCK_VELOCITY_CLASSES,
  TRANSFER_STATUSES,
  movementReason,
  isMovementReason,
  reasonsForDirection,
  allocateStock,
  batchLabel,
  valueStock,
  expiryStatus,
  daysOfCover,
  velocityClass,
  reorderPoint,
  reorderQuantity,
  stocktakeVariance,
  varianceRequiresApproval,
  transferLegs,
  transferDiscrepancy,
  assertStockAvailable,
  isoDateOf,
  daysBetweenDates,
};
