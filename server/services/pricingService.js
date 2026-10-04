// =====================================================================
// StockRidge — PRICING SERVICE
// =====================================================================
// Resolves ONE number — the unit price for a line — from up to six sources,
// in a fixed precedence order, and always reports WHICH source won.
//
// WHY PRECEDENCE AND PROVENANCE MATTER:
// In a Nigerian retail business a price is never one fact. It is at least:
// the cost on the batch that physically arrived, the branch's default
// selling price (Lagos and Minna differ), the customer's wholesale tier, a
// quantity break, a running promotion, and whatever the cashier negotiated.
// If the POS just picks a number, nobody can answer "why did this sell for
// ₦185,000 and that one for ₦199,000?" — and that question comes up in
// every margin review and every customer dispute.
//
// So `price_source` is stored on every sale_items row and every quote line.
//
// PRECEDENCE (highest wins), and the reasoning for the order:
//
//   1. MANUAL          an explicit price a permitted user typed. Highest
//                      because it is a deliberate human decision, and
//                      because refusing it would send the negotiation to
//                      paper. It is gated by discount authority, and it is
//                      audited with a reason.
//   2. PROMOTION       a time-boxed campaign the owner launched. Beats the
//                      standing tier price, or a promotion could never
//                      discount a wholesale customer.
//   3. QUANTITY BREAK  a tier rule with min_quantity >= qty. Beats the
//                      plain tier price because it is the more specific
//                      rule for the same tier.
//   4. TIER            the customer's standing wholesale/distributor price.
//   5. BRANCH_OVERRIDE the branch's own default selling price.
//   6. BATCH           the price of record on the stock that is actually
//                      being sold. The floor of the cascade and the only
//                      source that always exists.
//
// A price is never allowed BELOW COST without an explicit override flag.
// Selling below cost happens legitimately (clearance, a damaged unit, a
// relationship price on a bulk tender) so it is not banned — but it must be
// a decision somebody made, recorded, with a reason, because it is also
// exactly what a cashier does to split the difference with a friend.
// =====================================================================

const { round2 } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const { capabilitiesOf } = require('../lib/capabilities');

const PRICE_SOURCES = Object.freeze(['MANUAL', 'PROMOTION', 'QUANTITY_BREAK', 'TIER', 'BRANCH_OVERRIDE', 'BATCH', 'COST_PLUS']);

async function loadProductPricingContext(db, { businessUnitId, branchId, productId }) {
  const [product, category] = await Promise.all([
    db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(productId).first(),
    null,
  ]);
  if (!product) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
  const cat = product.category_id
    ? await db.prepare('SELECT * FROM product_categories WHERE id = ? AND is_deleted = 0').bind(product.category_id).first()
    : null;
  return { product, category: cat };
}

// The batch price of record: the oldest allocatable batch with stock, which
// is the batch FIFO will actually sell from. Pricing off the newest batch
// would quote a price the system then fails to honour when it consumes the
// older, differently-priced stock.
async function batchPrice(db, { branchId, productId }) {
  const row = await db.prepare(`
    SELECT selling_price_per_unit, pack_price, carton_price, pallet_price, unit_cost, id AS batch_id
    FROM stock_batches
    WHERE branch_id = ? AND product_id = ? AND is_deleted = 0 AND status = 'ACTIVE' AND quantity_remaining > 0
    ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END ASC, expiry_date ASC, received_at ASC
    LIMIT 1
  `).bind(branchId, productId).first();
  return row || null;
}

async function branchOverride(db, { branchId, productId, at = null }) {
  const date = at ? String(at).slice(0, 10) : null;
  return db.prepare(`
    SELECT * FROM product_price_overrides
    WHERE branch_id = ? AND product_id = ? AND is_deleted = 0
      AND (effective_from IS NULL OR effective_from <= COALESCE(?, date('now','+1 hour')))
      AND (effective_to   IS NULL OR effective_to   >= COALESCE(?, date('now','+1 hour')))
    ORDER BY effective_from DESC LIMIT 1
  `).bind(branchId, productId, date, date).first();
}

async function tierForCustomer(db, { businessUnitId, customerId, customerType }) {
  if (!customerId) return null;
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(customerId).first();
  if (!customer) return null;
  if (customer.tier_id) {
    const tier = await db.prepare('SELECT * FROM price_tiers WHERE id = ? AND is_deleted = 0 AND is_active = 1').bind(customer.tier_id).first();
    if (tier) return { tier, customer };
  }
  // Fall back to a tier whose code matches the customer's declared type —
  // the common case where a wholesale account was created but nobody
  // remembered to pick a tier from the dropdown.
  const type = String(customerType || customer.customer_type || '').toUpperCase();
  if (!type) return { tier: null, customer };
  const tier = await db.prepare(`
    SELECT * FROM price_tiers
    WHERE business_unit_id = ? AND is_deleted = 0 AND is_active = 1
      AND upper(code) = ?
    LIMIT 1
  `).bind(businessUnitId, type).first();
  return { tier: tier || null, customer };
}

async function tierPriceRule(db, { businessUnitId, productId, tierId, branchId, quantity }) {
  if (!tierId) return null;
  const qty = Number(quantity) || 1;
  const rows = await db.prepare(`
    SELECT * FROM product_tier_prices
    WHERE product_id = ? AND tier_id = ? AND is_deleted = 0
      AND (branch_id IS NULL OR branch_id = ?)
      AND (? IS NULL OR effective_from <= ?)
      AND (? IS NULL OR effective_to >= ?)
      AND min_quantity <= ?
      AND (max_quantity IS NULL OR max_quantity >= ?)
    ORDER BY
      -- A branch-specific rule beats a business-wide one, and a higher
      -- quantity break beats a lower one: both are "more specific wins".
      (branch_id IS NULL) ASC,
      min_quantity DESC,
      updated_at DESC
    LIMIT 1
  `).bind(
    productId, tierId, branchId,
    null, null, null, null,
    qty, qty
  ).all();
  return rows.results[0] || null;
}

function applyRule(rule, { retailPrice, costPrice, quantity }) {
  if (!rule) return null;
  const type = String(rule.price_type).toUpperCase();
  const value = Number(rule.price_value) || 0;
  if (type === 'FIXED') return { price: round2(value), rule };
  if (type === 'PERCENT_OFF_RETAIL') {
    const base = Number(retailPrice) || 0;
    return { price: round2(base * (1 - Math.min(100, Math.max(0, value)) / 100)), rule };
  }
  if (type === 'PERCENT_OFF_COST_PLUS_MARKUP') {
    const cost = Number(costPrice) || 0;
    const markup = Number(rule.markup_percent) || 0;
    const off = Math.min(100, Math.max(0, value));
    return { price: round2(cost * (1 + markup / 100) * (1 - off / 100)), rule };
  }
  return null;
}

// Active promotions that could apply. The POS shows them; it does not
// silently apply one the cashier cannot see, because a discount the
// customer was not told about is a dispute later.
async function activePromotions(db, { businessUnitId, branchId, productId, categoryId, brand, customerTierId, at = null }) {
  const now = at || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const rows = await db.prepare(`
    SELECT * FROM promotions
    WHERE business_unit_id = ? AND is_deleted = 0 AND status = 'ACTIVE'
      AND starts_at <= ? AND ends_at >= ?
      AND (used_count < COALESCE(max_uses_total, used_count + 1))
    ORDER BY created_at DESC LIMIT 50
  `).bind(businessUnitId, now, now).all();

  const matches = [];
  for (const p of rows.results) {
    if (!promotionApplies(p, { branchId, productId, categoryId, brand, customerTierId })) continue;
    matches.push(p);
  }
  return matches;
}

function promotionApplies(promo, { branchId, productId, categoryId, brand, customerTierId }) {
  const inScope = (jsonList, value) => {
    if (!jsonList) return true;
    let list;
    try { list = JSON.parse(jsonList); } catch (_) { return true; }
    if (!Array.isArray(list) || !list.length) return true;
    return list.includes(value);
  };
  if (!inScope(promo.branch_ids_json, branchId)) return false;
  const appliesTo = String(promo.applies_to).toUpperCase();
  if (appliesTo === 'ALL') return true;
  if (appliesTo === 'PRODUCT') return inScope(promo.scope_ids_json, productId);
  if (appliesTo === 'CATEGORY') return inScope(promo.scope_ids_json, categoryId);
  if (appliesTo === 'BRAND') return inScope(promo.scope_ids_json, brand);
  if (appliesTo === 'TIER') return inScope(promo.customer_tier_ids_json, customerTierId);
  return false;
}

// Best promotion price for one line. Returns the single most favourable
// applicable promotion; stacking is only allowed where the promotion says so,
// and even then it stacks on the TIER price, never on another promotion —
// two multiplicative discounts compounding is how a ₦200,000 television ends
// up at ₦90,000 through a configuration nobody reviewed.
function bestPromotion(promotions, { basePrice, quantity }) {
  let best = null;
  for (const p of promotions) {
    const minQty = Number(p.min_quantity) || 1;
    if (Number(quantity) < minQty) continue;
    let price = null;
    const type = String(p.promo_type).toUpperCase();
    const value = Number(p.value) || 0;
    if (type === 'PERCENT_OFF') price = round2(basePrice * (1 - Math.min(100, Math.max(0, value)) / 100));
    else if (type === 'FIXED_AMOUNT_OFF') price = round2(Math.max(0, basePrice - value));
    else if (type === 'BUNDLE_PRICE') price = round2((Number(p.value2) || 0) / Math.max(1, value));
    else continue;                       // BUY_N_GET_M / TIER_UNLOCK / FREE_DELIVERY are cart-level, not line-level
    if (price == null) continue;
    if (best === null || price < best.price) best = { price, promo: p };
  }
  return best;
}

// ---------------------------------------------------------------------
// THE RESOLVER
// ---------------------------------------------------------------------
// Returns { unit_price, price_source, ...trace } for ONE line. `trace` is
// the full cascade and is returned to the POS so the cashier can see WHY,
// which is the difference between a price the staff trust and a price they
// route around by using the manual override on every sale.
async function resolveUnitPrice(db, ctx, {
  businessUnitId, branchId, productId, unitType = 'BASE_UNIT', quantity = 1,
  customerId = null, customerType = null, tierId = null,
  manualPrice = null, promotionCode = null, allowBelowCost = false, at = null,
}) {
  const { product } = await loadProductPricingContext(db, { businessUnitId, branchId, productId });
  const batch = await batchPrice(db, { branchId, productId });
  const override = await branchOverride(db, { branchId, productId, at });

  const caps = capabilitiesOf(ctx.businessUnit || {});
  const resolvedTierId = tierId || (customerId ? (await tierForCustomer(db, { businessUnitId, customerId, customerType })).tier?.id || null : null);

  const costPerBase = Number((batch && batch.unit_cost) || product.default_cost_price || 0);

  // Convert every source to a price PER THE REQUESTED unit_type. A carton
  // price is stored on the batch/override; where it is absent it is derived
  // from the base price x pieces, because a cashier quoting a carton must
  // never get a worse price than buying the same quantity loose.
  const pieces = piecesForUnit(product, unitType);
  const perUnit = (basePrice, cartonPrice, packPrice, palletPrice) => {
    const u = String(unitType).toUpperCase();
    if (u === 'PACK' && packPrice != null) return round2(Number(packPrice));
    if (u === 'CARTON' && cartonPrice != null) return round2(Number(cartonPrice));
    if (u === 'PALLET' && palletPrice != null) return round2(Number(palletPrice));
    return round2((Number(basePrice) || 0) * pieces);
  };

  const trace = [];
  const push = (source, price, note) => { if (price != null) trace.push({ source, price: round2(price), note: note || null }); };

  const batchPricePerUnit = batch ? perUnit(batch.selling_price_per_unit, batch.carton_price, batch.pack_price, batch.pallet_price) : null;
  const overridePricePerUnit = override ? perUnit(override.default_selling_price, override.carton_price, override.pack_price, override.pallet_price) : null;
  const productDefault = perUnit(product.default_selling_price, null, null, null);

  push('BATCH', batchPricePerUnit, batch ? `batch ${batch.batch_id.slice(0, 8)}` : null);
  push('BRANCH_OVERRIDE', overridePricePerUnit, override ? 'branch default price' : null);
  push('COST_PLUS', product.default_selling_price > 0 ? productDefault : null, 'product default');

  let chosenPrice = batchPricePerUnit != null ? batchPricePerUnit : (overridePricePerUnit != null ? overridePricePerUnit : productDefault);
  let chosenSource = batchPricePerUnit != null ? 'BATCH' : (overridePricePerUnit != null ? 'BRANCH_OVERRIDE' : 'COST_PLUS');

  // 4. TIER
  let tierRule = null;
  if (caps.wholesale_tiers && resolvedTierId) {
    tierRule = await tierPriceRule(db, { businessUnitId, productId, tierId: resolvedTierId, branchId, quantity });
    if (tierRule) {
      const applied = applyRule(tierRule, {
        retailPrice: chosenPrice / Math.max(1, pieces),
        costPrice: costPerBase,
        quantity,
      });
      if (applied) {
        const tierPrice = round2(applied.price * pieces);
        const isBreak = (Number(tierRule.min_quantity) || 1) > 1;
        push(isBreak ? 'QUANTITY_BREAK' : 'TIER', tierPrice, `tier ${tierRule.id.slice(0, 8)}, min qty ${tierRule.min_quantity}`);
        if (tierPrice < chosenPrice) { chosenPrice = tierPrice; chosenSource = isBreak ? 'QUANTITY_BREAK' : 'TIER'; }
      }
    }
  }

  // 2. PROMOTION
  let appliedPromo = null;
  if (promotionCode || caps.wholesale_tiers || true) {
    const promos = await activePromotions(db, {
      businessUnitId, branchId, productId,
      categoryId: product.category_id, brand: product.brand,
      customerTierId: resolvedTierId, at: at ? watIso(at) : null,
    });
    const byCode = promotionCode ? promos.find((p) => String(p.code).toUpperCase() === String(promotionCode).trim().toUpperCase()) : null;
    if (promotionCode && !byCode) {
      throw new HttpError(404, `Promotion "${promotionCode}" is not active for this product at this branch right now.`, 'PROMOTION_NOT_APPLICABLE');
    }
    const candidates = byCode ? [byCode] : promos;
    const best = bestPromotion(candidates, { basePrice: chosenPrice, quantity });
    if (best) {
      push('PROMOTION', best.price, best.promo.name);
      if (best.price < chosenPrice) { chosenPrice = best.price; chosenSource = 'PROMOTION'; appliedPromo = best.promo; }
    }
  }

  // 1. MANUAL
  if (manualPrice != null && manualPrice !== '') {
    const manual = round2(Number(manualPrice));
    if (!Number.isFinite(manual) || manual < 0) {
      throw new HttpError(400, 'A manual price must be a positive amount.', 'MANUAL_PRICE_INVALID');
    }
    push('MANUAL', manual, 'entered at the counter');
    chosenPrice = manual;
    chosenSource = 'MANUAL';
  }

  // BELOW-COST GUARD
  const costForUnit = round2(costPerBase * pieces);
  if (costForUnit > 0 && chosenPrice < costForUnit) {
    if (!allowBelowCost) {
      const e = new HttpError(409,
        `That price is below cost (₦${costForUnit.toLocaleString('en-NG')} for this unit). `
        + 'Selling below cost is allowed but must be a deliberate decision — tick "sell below cost" and give a reason.',
        'PRICE_BELOW_COST');
      e.details = { cost_for_unit: costForUnit, proposed_price: chosenPrice };
      throw e;
    }
  }

  return {
    unit_price: round2(chosenPrice),
    price_source: chosenSource,
    unit_type: String(unitType).toUpperCase(),
    pieces_per_unit: pieces,
    quantity: Number(quantity) || 1,
    unit_cost: costPerBase,
    cost_for_unit: costForUnit,
    below_cost: costForUnit > 0 && chosenPrice < costForUnit,
    tier_id: resolvedTierId,
    tier_rule_id: tierRule ? tierRule.id : null,
    promotion_id: appliedPromo ? appliedPromo.id : null,
    promotion_name: appliedPromo ? appliedPromo.name : null,
    retail_reference: batchPricePerUnit != null ? batchPricePerUnit : (overridePricePerUnit != null ? overridePricePerUnit : productDefault),
    trace,
    product_id: productId,
    product_name: product.name,
    base_unit: product.base_unit,
  };
}

function piecesForUnit(product, unitType) {
  const up = Number(product.units_per_pack) > 0 ? Number(product.units_per_pack) : 1;
  const pc = Number(product.packs_per_carton) > 0 ? Number(product.packs_per_carton) : null;
  const cp = Number(product.cartons_per_pallet) > 0 ? Number(product.cartons_per_pallet) : null;
  switch (String(unitType || 'BASE_UNIT').toUpperCase()) {
    case 'PACK': return up;
    case 'CARTON': return pc ? up * pc : up;
    case 'PALLET': return (pc && cp) ? up * pc * cp : (pc ? up * pc : up);
    default: return 1;
  }
}

function watIso(at) {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19).replace('T', ' ') : null;
}

// Margin on a resolved line. Computed in kobo so a display rounding cannot
// make margin percent and margin amount disagree with each other.
function lineMargin({ quantity, unitPrice, unitCost, piecesPerUnit = 1 }) {
  const revenue = round2((Number(unitPrice) || 0) * (Number(quantity) || 0));
  const cost = (Number(unitCost) || 0) * (Number(quantity) || 0) * (Number(piecesPerUnit) || 1);
  const margin = round2(revenue - cost);
  return {
    revenue,
    cost: round2(cost),
    margin,
    margin_percent: revenue > 0 ? round2((margin / revenue) * 100) : 0,
  };
}

module.exports = {
  PRICE_SOURCES,
  loadProductPricingContext, batchPrice, branchOverride, tierForCustomer, tierPriceRule,
  applyRule, activePromotions, promotionApplies, bestPromotion,
  resolveUnitPrice, piecesForUnit, lineMargin,
};
'use strict';
