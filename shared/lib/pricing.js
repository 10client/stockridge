// =====================================================================
// shared/lib/pricing.js — PRICE RESOLUTION
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: the batch's `selling_price_per_unit` was the
// price of record and `product_price_overrides` gave each branch a different
// default. That two-layer model is kept (it is correct — a batch bought at a
// different cost genuinely carries a different price) but StockRidge adds
// THREE more layers, because a general Nigerian retailer prices on more axes
// than a pharmacy does:
//
//   1. BATCH PRICE          what this specific stock cost-plus-margin says.
//                           Still the price of record. Branch-scoped.
//   2. BRANCH OVERRIDE      Lagos vs Kano default shelf price for the product.
//   3. CUSTOMER CLASS TIER  a wholesaler buying 50 cartons does not pay the
//                           shelf price. Discount per (class, category).
//   4. VOLUME BREAK         a quantity-based break independent of who is
//                           buying ("10+ units, 5% off").
//   5. PROMOTION            a dated campaign: fixed price, % off, or
//                           buy-N-get-M. Overrides 3 and 4 while active.
//
// PRECEDENCE, deliberately explicit and documented because "why did it charge
// that?" is the most common question a POS ever has to answer:
//
//   promotion  >  volume break  >  customer-class tier  >  branch override  >  batch price
//
// Each applied layer is RETURNED as a `pricingTrail` entry so the receipt, the
// audit log and the margin report can all show exactly which rule fired and
// what it did. A price with no explanation is a price nobody will trust.
//
// GUARD RAILS (owner-settable, enforced here and in the POS route):
//   * floor_price_percent — never sell below this % of the batch cost without
//     a manager override. Stops a cashier "discounting" a ₦400,000 TV to
//     ₦40,000 for a friend.
//   * max_discount_percent — the largest single discount a non-manager may
//     apply, regardless of tier.
//   * selling below cost is always recorded as a priced exception even when
//     permitted, because it is either a promotion (fine) or shrinkage (not).

'use strict';

const { round2, toKobo, fromKobo, allocateKobo } = require('./money');

const DISCOUNT_KINDS = Object.freeze(['PERCENT', 'FIXED_AMOUNT', 'FIXED_PRICE', 'BUY_N_GET_M']);
const PROMOTION_TYPES = Object.freeze(['PERCENT_OFF', 'FIXED_PRICE', 'BUNDLE', 'BUY_N_GET_M', 'CLEARANCE']);

/**
 * Resolve the unit price and discounts for ONE line.
 *
 * PURE FUNCTION — no database access. The caller loads the inputs (batch,
 * override, tier, promotion, volume break) and passes them in, so this logic
 * is identical on the Node backend, the Cloudflare Worker, and in the offline
 * POS queue where a sale is priced with no network at all.
 *
 * @param {object} i
 * @param {number} i.baseQuantity        base units being sold
 * @param {number} i.sellingUnit         rung the price was quoted at
 * @param {number} i.piecesPerRung       base units in that rung
 * @param {number} i.batchPricePerBaseUnit  price of record from the batch
 * @param {number} [i.branchPricePerBaseUnit] branch override, if any
 * @param {number} [i.unitCostPerBaseUnit]    batch weighted cost, for the floor check
 * @param {object} [i.customer]          { customer_class, credit_limit }
 * @param {object} [i.tier]              { discount_percent } for that class+category
 * @param {object} [i.volumeBreak]       { min_qty, discount_percent }
 * @param {object} [i.promotion]         { type, value, ... }
 * @param {object} [i.manualDiscount]    { kind, value, approved_by_manager }
 * @param {object} [i.policy]            { floor_price_percent, max_discount_percent }
 * @returns {object} priced line + pricingTrail
 */
function priceLine(i) {
  const qtyBase = Math.max(0, Number(i.baseQuantity) || 0);
  const trail = [];

  // ---- layer 0: the price of record ------------------------------------
  const rawBatch = i.batchPricePerBaseUnit;
  if (rawBatch == null || rawBatch === '' || Number.isNaN(Number(rawBatch))) {
    if (i.branchPricePerBaseUnit == null || i.branchPricePerBaseUnit === '') {
      const err = new Error('This stock has no selling price. Set the batch price before selling.');
      err.status = 409; err.code = 'NO_SELLING_PRICE';
      throw err;
    }
  }
  const batchPrice = Number(rawBatch);
  if (rawBatch != null && (!Number.isFinite(batchPrice) || batchPrice < 0)) {
    const err = new Error('This stock has no selling price. Set the batch price before selling.');
    err.status = 409; err.code = 'NO_SELLING_PRICE';
    throw err;
  }
  let unitKobo = rawBatch != null ? toKobo(batchPrice) : 0;
  if (rawBatch != null) {
    trail.push({ layer: 'BATCH', label: 'Batch price', unitKobo, note: 'price of record for this stock' });
  }

  // ---- layer 1: branch override ----------------------------------------
  if (i.branchPricePerBaseUnit != null && i.branchPricePerBaseUnit !== '') {
    const bp = Number(i.branchPricePerBaseUnit);
    if (Number.isFinite(bp) && bp >= 0 && toKobo(bp) !== unitKobo) {
      unitKobo = toKobo(bp);
      trail.push({ layer: 'BRANCH_OVERRIDE', label: 'Branch shelf price', unitKobo, note: 'this branch prices this product differently' });
    }
  }

  let grossKobo = unitKobo * qtyBase;
  const beforeDiscountKobo = grossKobo;

  // ---- layer 2: promotion (wins outright while active) ------------------
  let freeUnits = 0;
  const promo = i.promotion;
  if (promo && promoIsLive(promo, i.now)) {
    const type = String(promo.type || '').toUpperCase();
    if (type === 'PERCENT_OFF') {
      const pct = clampPercent(promo.value);
      const off = Math.round((grossKobo * pct) / 100);
      grossKobo -= off;
      trail.push({ layer: 'PROMOTION', label: promo.name || 'Promotion', offKobo: off, note: `${pct}% off (promotion)` });
    } else if (type === 'FIXED_PRICE' || type === 'CLEARANCE') {
      const target = toKobo(promo.value) * qtyBase;
      const off = Math.max(0, grossKobo - target);
      grossKobo = target;
      trail.push({ layer: 'PROMOTION', label: promo.name || 'Clearance', offKobo: off, note: `promotional price ${fromKobo(toKobo(promo.value))} each` });
    } else if (type === 'BUY_N_GET_M') {
      const n = Math.max(1, Math.floor(Number(promo.buy_n) || 1));
      const m = Math.max(1, Math.floor(Number(promo.get_m) || 1));
      const sets = Math.floor(qtyBase / (n + m));
      freeUnits = sets * m;
      const off = unitKobo * freeUnits;
      grossKobo -= off;
      trail.push({ layer: 'PROMOTION', label: promo.name || `Buy ${n} get ${m}`, offKobo: off, note: `${freeUnits} free unit(s)` });
    } else if (type === 'BUNDLE') {
      // A bundle price applies to the whole line regardless of qty.
      const off = Math.max(0, grossKobo - toKobo(promo.value));
      grossKobo = toKobo(promo.value);
      trail.push({ layer: 'PROMOTION', label: promo.name || 'Bundle', offKobo: off, note: 'bundle price for the line' });
    }
  }

  // ---- layer 3: customer-class tier -------------------------------------
  if (!trail.some((t) => t.layer === 'PROMOTION')) {
    const tierPct = Number(i.tier && i.tier.discount_percent);
    if (Number.isFinite(tierPct) && tierPct > 0) {
      const pct = clampPercent(tierPct);
      const off = Math.round((grossKobo * pct) / 100);
      grossKobo -= off;
      trail.push({
        layer: 'CUSTOMER_TIER',
        label: `${String((i.customer && i.customer.customer_class) || 'TRADE').toLowerCase()} price`,
        offKobo: off,
        note: `${pct}% ${i.tier.tier_name || 'trade'} discount`,
      });
    }
  }

  // ---- layer 4: volume break --------------------------------------------
  const vb = i.volumeBreak;
  if (vb && qtyBase >= Math.max(1, Number(vb.min_qty) || 1)) {
    const pct = clampPercent(vb.discount_percent);
    if (pct > 0) {
      const off = Math.round((grossKobo * pct) / 100);
      grossKobo -= off;
      trail.push({ layer: 'VOLUME_BREAK', label: `Buy ${vb.min_qty}+`, offKobo: off, note: `${pct}% volume discount` });
    }
  }

  // ---- layer 5: manual discount -----------------------------------------
  const md = i.manualDiscount;
  let manualOffKobo = 0;
  if (md && (md.value != null && md.value !== '')) {
    const kind = String(md.kind || 'PERCENT').toUpperCase();
    if (kind === 'PERCENT') {
      const pct = clampPercent(md.value);
      manualOffKobo = Math.round((grossKobo * pct) / 100);
      trail.push({ layer: 'MANUAL', label: 'Staff discount', offKobo: manualOffKobo, note: `${pct}% manual`, approvedByManager: !!md.approved_by_manager });
    } else if (kind === 'FIXED_AMOUNT') {
      manualOffKobo = Math.min(grossKobo, toKobo(md.value));
      trail.push({ layer: 'MANUAL', label: 'Staff discount', offKobo: manualOffKobo, note: `${fromKobo(manualOffKobo)} off`, approvedByManager: !!md.approved_by_manager });
    }
    grossKobo -= manualOffKobo;
  }

  grossKobo = Math.max(0, grossKobo);

  // ---- per-line discount apportionment back onto base units --------------
  const totalOffKobo = beforeDiscountKobo - grossKobo;
  // Allocate across units so a partial return of this line can refund the
  // EXACT kobo that unit contributed — not an average that leaves the
  // remainder of the line mispriced.
  const perUnitKobo = qtyBase > 0 ? allocateKobo(grossKobo, new Array(qtyBase).fill(1)) : [];
  const effectiveUnitKobo = perUnitKobo.length ? perUnitKobo[0] : 0;

  // ---- guard rails --------------------------------------------------------
  const policy = i.policy || {};
  const warnings = [];
  const blocks = [];

  const costKobo = Number.isFinite(Number(i.unitCostPerBaseUnit)) ? toKobo(i.unitCostPerBaseUnit) : null;
  if (costKobo != null && costKobo > 0 && qtyBase > 0) {
    const floorPct = Number(policy.floor_price_percent);
    const floorKobo = Number.isFinite(floorPct)
      ? Math.round((costKobo * clampPercent(floorPct, 0, 1000)) / 100)
      : costKobo;
    if (effectiveUnitKobo < floorKobo) {
      const msg = `This line prices at ${fromKobo(effectiveUnitKobo)} per unit, below the ${floorPct != null ? floorPct + '%-of-cost' : 'cost'} floor of ${fromKobo(floorKobo)}.`;
      if (md && md.approved_by_manager) warnings.push(`${msg} Manager override applied.`);
      else blocks.push({ code: 'BELOW_PRICE_FLOOR', message: `${msg} A manager must approve this discount.` });
    }
    if (effectiveUnitKobo < costKobo) {
      warnings.push(`Selling below cost (${fromKobo(costKobo)}). Margin on this line is negative.`);
    }
  }

  const maxDiscPct = Number(policy.max_discount_percent);
  if (Number.isFinite(maxDiscPct) && beforeDiscountKobo > 0) {
    const appliedPct = (totalOffKobo / beforeDiscountKobo) * 100;
    if (appliedPct > maxDiscPct + 1e-9) {
      const msg = `Total discount is ${round2(appliedPct)}%, above the ${maxDiscPct}% limit.`;
      if (md && md.approved_by_manager) warnings.push(`${msg} Manager override applied.`);
      else blocks.push({ code: 'DISCOUNT_EXCEEDS_LIMIT', message: `${msg} A manager must approve it.` });
    }
  }

  return {
    ok: blocks.length === 0,
    blocks,
    warnings,
    baseQuantity: qtyBase,
    freeUnits,
    chargeableBaseQuantity: Math.max(0, qtyBase - freeUnits),
    grossKobo: beforeDiscountKobo,
    discountKobo: totalOffKobo,
    netKobo: grossKobo,
    gross: fromKobo(beforeDiscountKobo),
    discount: fromKobo(totalOffKobo),
    net: fromKobo(grossKobo),
    unitPriceKobo: effectiveUnitKobo,
    unitPrice: fromKobo(effectiveUnitKobo),
    discountPercent: beforeDiscountKobo > 0 ? round2((totalOffKobo / beforeDiscountKobo) * 100) : 0,
    costKobo,
    cost: costKobo == null ? null : fromKobo(costKobo),
    marginKobo: costKobo == null ? null : grossKobo - costKobo * qtyBase,
    margin: costKobo == null ? null : fromKobo(grossKobo - costKobo * qtyBase),
    marginPercent: (costKobo == null || grossKobo === 0) ? null
      : round2(((grossKobo - costKobo * qtyBase) / grossKobo) * 100),
    perUnitKobo,
    pricingTrail: trail.map((t) => ({ ...t, amount: t.offKobo != null ? fromKobo(t.offKobo) : (t.unitKobo != null ? fromKobo(t.unitKobo) : null) })),
  };
}

function clampPercent(v, min = 0, max = 100) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, n));
}

function promoIsLive(promo, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const iso = at.toISOString().slice(0, 10);
  if (promotion_status(promo) !== 'ACTIVE') return false;
  if (promo.starts_on && String(promo.starts_on).slice(0, 10) > iso) return false;
  if (promo.ends_on && String(promo.ends_on).slice(0, 10) < iso) return false;
  return true;
}

function promotion_status(promo) {
  return String((promo && promo.status) || 'ACTIVE').toUpperCase();
}

/**
 * Suggested retail price from a cost, given a target margin PERCENT.
 *
 * margin% is expressed on SELLING price (what retailers mean), so
 *   price = cost / (1 - margin/100)
 * not cost * (1 + margin/100), which is markup and gives a different number.
 * Both are offered because suppliers quote in markup and shops think in margin.
 */
function priceFromMargin(cost, marginPercent) {
  const c = Number(cost) || 0;
  const m = clampPercent(marginPercent, 0, 99.9);
  return round2(c / (1 - m / 100));
}

function priceFromMarkup(cost, markupPercent) {
  const c = Number(cost) || 0;
  const m = Number(markupPercent) || 0;
  return round2(c * (1 + m / 100));
}

/**
 * Reprice a whole batch/branch when a client's policy is "cost plus X%".
 * Returns per-product suggested prices; the caller decides what to apply,
 * because silently rewriting 4,000 shelf prices is not a batch job.
 */
function suggestReprice({ cost, currentPrice, targetMarginPercent, minDelta = 0 }) {
  const suggested = priceFromMargin(cost, targetMarginPercent);
  const delta = round2(suggested - (Number(currentPrice) || 0));
  return {
    cost: round2(Number(cost) || 0),
    currentPrice: round2(Number(currentPrice) || 0),
    suggested,
    delta,
    worthApplying: Math.abs(delta) >= minDelta,
    marginPercentNow: Number(currentPrice) > 0
      ? round2(((Number(currentPrice) - (Number(cost) || 0)) / Number(currentPrice)) * 100)
      : null,
  };
}

module.exports = {
  DISCOUNT_KINDS, PROMOTION_TYPES,
  priceLine, clampPercent, promoIsLive,
  priceFromMargin, priceFromMarkup, suggestReprice,
};
