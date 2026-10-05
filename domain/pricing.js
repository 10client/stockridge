'use strict';
// =====================================================================
// domain/pricing.js — PRICE RESOLUTION, DISCOUNTS AND LINE MATH
// =====================================================================
// WHY PRICE RESOLUTION IS A SEPARATE MODULE AND NOT INLINE IN THE POS ROUTE
//
// A price in this system can come from five places, and which one wins is a
// business rule that must be identical everywhere it is applied: the POS,
// the layaway screen, the instalment screen, an exchange, a return refund,
// a printed quotation and the offline-queue replay. Inline in one route,
// those seven callers drift within a month and the same item costs two
// different amounts depending on which screen rang it up.
//
// RESOLUTION ORDER (highest precedence first):
//   1. MANUAL      — the cashier/manager typed a price. Only permitted
//                    where canEditPrices() or the staff discount cap allows.
//   2. OVERRIDE    — product_price_overrides for THIS branch. Ikeja and
//                    Onitsha are not the same market.
//   3. PRICE_LIST  — the customer's class price list (wholesale vs retail),
//                    including quantity-break rows.
//   4. BATCH       — stock_batches.selling_price_per_unit. The price of
//                    record for the actual stock being sold, which is what
//                    lets two deliveries of the same fridge coexist at
//                    different prices after a supplier increase.
//   5. PRODUCT     — products.selling_price, the fallback for a product with
//                    no stock at this branch (a special order).
//
// The chosen source is STORED on the sale line as price_source. That is not
// decoration: when an owner asks "why did we sell this below cost on
// Tuesday", the answer has to name the mechanism, and "a human typed it" is
// a different conversation from "the wholesale list says so".
// =====================================================================

const { round2, roundTo, marginPct, allocate } = require('./money');
const { toBaseUnits } = require('./uom');

const PRICE_SOURCES = Object.freeze(['BATCH', 'PRICE_LIST', 'OVERRIDE', 'MANUAL']);

/**
 * Resolve the unit price for one POS line.
 *
 * `ctx` carries everything the five sources need. Missing pieces degrade
 * gracefully rather than throwing: a walk-in with no customer row simply
 * has no price list, and a product with no stock at this branch falls
 * through to the product price.
 */
function resolveUnitPrice(ctx) {
  const {
    product, variant = null, batch = null, override = null, priceListItems = null,
    customer = null, unitCode = 'PIECE', quantity = 1, manualPrice = null, ladder = null,
  } = ctx;

  const unit = String(unitCode || 'PIECE').toUpperCase();
  const qty = Number(quantity) || 0;

  // 1. MANUAL
  if (manualPrice != null && Number.isFinite(Number(manualPrice)) && Number(manualPrice) >= 0) {
    return {
      source: 'MANUAL',
      unitPrice: round2(Number(manualPrice)),
      unitCode: unit,
      explanation: 'Price entered manually at the counter.',
    };
  }

  // 2. OVERRIDE (branch-specific)
  if (override && Number.isFinite(Number(override.default_selling_price))) {
    const overrideUnitPrice = pickOverrideUnitPrice(override, unit, ladder);
    if (overrideUnitPrice != null) {
      return {
        source: 'OVERRIDE',
        unitPrice: round2(overrideUnitPrice),
        unitCode: unit,
        explanation: `This branch's own price for this product.`,
      };
    }
  }

  // 3. PRICE LIST — including quantity breaks. The highest min_quantity row
  // that the order actually reaches wins, so a 50-carton order gets the
  // distributor price and a 2-carton order does not.
  if (Array.isArray(priceListItems) && priceListItems.length) {
    const matched = priceListItems
      .filter((item) => !item.variant_id || (variant && String(item.variant_id) === String(variant.id)))
      .filter((item) => String(item.unit_code || 'PIECE').toUpperCase() === unit)
      .filter((item) => qty >= Number(item.min_quantity || 0))
      .filter((item) => withinValidity(item))
      .sort((a, b) => Number(b.min_quantity || 0) - Number(a.min_quantity || 0));
    if (matched.length) {
      const chosen = matched[0];
      return {
        source: 'PRICE_LIST',
        unitPrice: round2(Number(chosen.price)),
        unitCode: unit,
        priceListId: chosen.price_list_id,
        explanation: Number(chosen.min_quantity || 0) > 0
          ? `Price list applies from ${Number(chosen.min_quantity).toLocaleString('en-NG')} ${unit.toLowerCase()}${unit === 'PIECE' ? '' : 's'} upward.`
          : 'Customer price list.',
      };
    }
  }

  // 4. BATCH — the price of record for this stock.
  if (batch && batch.selling_price_per_unit != null) {
    const perBase = Number(batch.selling_price_per_unit);
    const batchUnitPrice = pickBatchUnitPrice(batch, unit, perBase, ladder);
    if (batchUnitPrice != null) {
      return {
        source: 'BATCH',
        unitPrice: round2(batchUnitPrice),
        unitCode: unit,
        explanation: 'Price on the stock batch being sold.',
      };
    }
  }

  // 5. PRODUCT fallback
  const variantPrice = variant && Number.isFinite(Number(variant.selling_price)) ? Number(variant.selling_price) : null;
  const productPrice = Number((product && product.selling_price) || 0);
  const perBase = variantPrice != null ? variantPrice : productPrice;
  const factor = unitFactor(unit, ladder);
  return {
    source: 'BATCH', // no batch and no list: the catalogue price stands in
    unitPrice: round2(perBase * factor),
    unitCode: unit,
    explanation: 'Catalogue price — no stock batch or price list matched.',
    fallback: true,
  };
}

function unitFactor(unitCode, ladder) {
  const levels = (ladder && (ladder.ladder || ladder)) || [];
  const found = levels.find((l) => String(l.code || l).toUpperCase() === String(unitCode || '').toUpperCase());
  if (!found) return 1;
  return Number(found.quantityInBase || found.quantity_in_base || 1) || 1;
}

/**
 * Read an optional stored price.
 *
 * WHY THIS EXISTS. `selling_price_pack` and `selling_price_carton` are NULLABLE
 * columns, set only when a merchant has deliberately priced that level
 * differently from the ladder derivation. The code that read them used
 * `Number.isFinite(Number(col))` — and `Number(null)` is **0**, which is finite.
 * So an UNSET pack price was read as a price of ZERO.
 *
 * The consequence was silent rather than loud: a carton of 48 pieces sold for
 * ₦0.00, the sale totalled zero, the till balanced perfectly against it, and
 * the stock still went down by 48 units. Every report agreed with every other
 * report; only the bank statement disagreed. And because provisioning never
 * sets those columns, this was the DEFAULT state for every pack- or
 * carton-sold product in a fresh deployment.
 *
 * A stored 0 is still honoured — a genuinely free promotional item is a real
 * thing — but it has to have been WRITTEN as 0, not arrived as NULL.
 */
function storedPrice(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function pickOverrideUnitPrice(override, unitCode, ladder) {
  const u = String(unitCode || '').toUpperCase();
  if (u === 'PACK') {
    const pack = storedPrice(override.pack_price);
    if (pack != null) return pack;
  }
  if (u === 'CARTON') {
    const carton = storedPrice(override.carton_price);
    if (carton != null) return carton;
  }
  const factor = unitFactor(u, ladder);
  if (factor === 1) return Number(override.default_selling_price);
  // No explicit price stored for this level: derive it from the per-base
  // price so the ladder stays coherent instead of falling through to a
  // cheaper source and silently undercutting the branch's own pricing.
  return Number(override.default_selling_price) * factor;
}

function pickBatchUnitPrice(batch, unitCode, perBase, ladder) {
  const u = String(unitCode || '').toUpperCase();
  if (u === 'PACK') {
    const pack = storedPrice(batch.selling_price_pack);
    if (pack != null) return pack;
  }
  if (u === 'CARTON') {
    const carton = storedPrice(batch.selling_price_carton);
    if (carton != null) return carton;
  }
  // Derive from the per-base price through the ladder: 48 pieces at ₦150 is
  // ₦7,200 a carton. This is the branch that used to be unreachable for a NULL
  // pack or carton price, because NULL was being read as a real ₦0.
  return perBase * unitFactor(u, ladder);
}

function withinValidity(item) {
  const today = new Date().toISOString().slice(0, 10);
  if (item.valid_from && String(item.valid_from).slice(0, 10) > today) return false;
  if (item.valid_to && String(item.valid_to).slice(0, 10) < today) return false;
  return true;
}

// ---------------------------------------------------------------------
// DISCOUNTS
// ---------------------------------------------------------------------
/**
 * Apply a discount to a line.
 *
 * Two forms are accepted because both are real at a Nigerian counter:
 * a PERCENTAGE ("give him 5%") and an AMOUNT ("take ₦2,000 off"). The
 * amount form is capped at the line value so a discount can never produce
 * a negative line, which would otherwise post negative revenue and a
 * negative stock valuation in the same stroke.
 */
function applyLineDiscount({ unitPrice, quantity, discountAmount = null, discountPct = null }) {
  const gross = round2((Number(unitPrice) || 0) * (Number(quantity) || 0));
  let discount = 0;
  if (discountAmount != null && Number.isFinite(Number(discountAmount))) {
    discount = Math.max(0, round2(Number(discountAmount)));
  } else if (discountPct != null && Number.isFinite(Number(discountPct))) {
    const pct = Math.min(100, Math.max(0, Number(discountPct)));
    discount = round2((gross * pct) / 100);
  }
  if (discount > gross) discount = gross; // never negative
  return { gross, discount, net: round2(gross - discount), discountPctApplied: gross > 0 ? round2((discount / gross) * 100) : 0 };
}

/**
 * Allocate an ORDER-level discount across lines proportionally to line
 * value, with the remainder on the largest line.
 *
 * This matters for two reasons that only show up later: per-category margin
 * reporting has to be right (a discount sitting entirely on one line makes
 * that category look unprofitable), and a PARTIAL REFUND has to refund the
 * discounted price of the returned line, not its list price.
 */
function allocateOrderDiscount({ lines, totalDiscount }) {
  const discount = round2(Math.max(0, Number(totalDiscount) || 0));
  if (!discount || !lines.length) return lines.map((l) => ({ ...l, orderDiscountShare: 0 }));
  const shares = allocate(discount, lines.map((l) => Number(l.lineNet) || 0));
  return lines.map((l, i) => ({ ...l, orderDiscountShare: shares[i] }));
}

// ---------------------------------------------------------------------
// LINE MATH — the single place a sale line's money is computed
// ---------------------------------------------------------------------
/**
 * Compute one sale line end to end.
 *
 * Returns base quantity, cost, revenue, VAT component and margin, all
 * consistent with each other and with the schema's CHECK constraints.
 *
 * `costPerBaseUnit` is a SNAPSHOT. The batch cost may move tomorrow when a
 * cheaper delivery arrives; the margin history of a sale made today must
 * not move with it. That is why sale_items.cost_price_snapshot exists and
 * why this function requires it to be passed in rather than looking it up.
 */
function computeSaleLine({
  product, variant = null, batch = null, ladder = null, measure = null,
  unitCode = 'PIECE', quantity, unitPrice, priceSource = 'BATCH', priceListId = null,
  discountAmount = null, discountPct = null, costPerBaseUnit = null,
  vatEnabled = false, vatRatePercent = 0, orderDiscountShare = 0,
}) {
  const conversion = toBaseUnits({ quantity, unitCode, ladder, measure });
  if (!conversion.ok) return conversion;

  const qty = Number(quantity);
  const baseQty = conversion.baseQuantity;

  const costPerBase = costPerBaseUnit != null
    ? Number(costPerBaseUnit)
    : Number((batch && batch.cost_price_per_unit) || (product && product.cost_price) || 0);
  // FULL PRECISION on cost — see the note in uom.splitTotalCost. Rounding
  // here loses real money across a thousand-unit delivery.
  const totalCost = costPerBase * baseQty;

  const gross = round2((Number(unitPrice) || 0) * qty);
  const lineDiscount = applyLineDiscount({ unitPrice, quantity: qty, discountAmount, discountPct });
  const withOrderShare = round2(lineDiscount.net - Math.max(0, round2(Number(orderDiscountShare) || 0)));
  const lineTotal = Math.max(0, withOrderShare);

  // VAT is EXTRACTED from the inclusive line total, never added on top.
  // See domain/nigerianTax.js for why.
  const vat = vatEnabled && Number(vatRatePercent) > 0
    ? round2((lineTotal * Number(vatRatePercent)) / (100 + Number(vatRatePercent)))
    : 0;

  const revenueNetOfVat = round2(lineTotal - vat);
  const margin = round2(revenueNetOfVat - totalCost);

  return {
    ok: true,
    productId: product ? String(product.id) : null,
    variantId: variant ? String(variant.id) : null,
    batchId: batch ? String(batch.id) : null,
    productName: (variant && variant.name) || (product && product.name) || '',
    sku: (variant && variant.sku) || (product && product.sku) || null,
    categoryId: (product && product.category_id) || null,
    unitCode: conversion.unitCode,
    quantity: qty,
    quantityInBase: roundTo(baseQty, 4),
    unitPrice: round2(Number(unitPrice) || 0),
    priceSource,
    priceListId,
    discountAmount: round2(lineDiscount.discount + Math.max(0, Number(orderDiscountShare) || 0)),
    vatAmount: vat,
    lineTotal,
    revenueNetOfVat,
    costPriceSnapshot: costPerBase,
    totalCost: round2(totalCost),
    margin,
    marginPct: marginPct(totalCost, revenueNetOfVat),
    measured: Boolean(conversion.measured),
  };
}

/**
 * Totals for a whole sale, derived by SUMMING the lines — never recomputed
 * from scratch, because a second independent computation is a second chance
 * to disagree by a kobo and trip the schema CHECK.
 */
function computeSaleTotals({ lines, vatEnabled = false, vatRatePercent = 0, orderDiscount = 0, deliveryFee = 0 }) {
  const subtotal = round2(lines.reduce((a, l) => a + Number(l.lineTotal || 0), 0));
  const lineDiscounts = round2(lines.reduce((a, l) => a + Number(l.discountAmount || 0), 0));
  const vatAmount = round2(lines.reduce((a, l) => a + Number(l.vatAmount || 0), 0));
  const totalCost = round2(lines.reduce((a, l) => a + Number(l.totalCost || 0), 0));
  const discount = round2(Math.max(0, Number(orderDiscount) || 0));
  const fee = round2(Math.max(0, Number(deliveryFee) || 0));
  const total = round2(subtotal - discount + fee);
  return {
    subtotal,
    discountAmount: round2(lineDiscounts + discount),
    orderDiscount: discount,
    vatEnabled: vatEnabled ? 1 : 0,
    vatRatePercent: vatEnabled ? Number(vatRatePercent) || 0 : 0,
    vatAmount,
    deliveryFee: fee,
    total,
    totalCost,
    grossMargin: round2(total - vatAmount - fee - totalCost),
    grossMarginPct: marginPct(totalCost, total - vatAmount - fee),
    lineCount: lines.length,
    unitCount: round2(lines.reduce((a, l) => a + Number(l.quantityInBase || 0), 0)),
  };
}

/**
 * Guard rail: warn when a line sells below cost or below the product's
 * minimum margin.
 *
 * ADVISORY, NOT BLOCKING. Selling below cost is sometimes correct — clearing
 * a discontinued model, honouring a price already quoted to a customer
 * standing at the counter, matching a competitor across the road. The
 * system's job is to make sure somebody SAW it, so the warning is recorded
 * on the line and surfaced in the margin exception report, and the sale
 * still completes.
 */
function marginWarnings({ line, product, minMarginPct = null }) {
  const warnings = [];
  if (Number(line.totalCost) > 0 && Number(line.margin) < 0) {
    warnings.push({
      code: 'BELOW_COST',
      severity: 'WARNING',
      message: `Selling below cost: cost ₦${round2(line.totalCost).toLocaleString('en-NG')} against revenue ₦${round2(line.revenueNetOfVat).toLocaleString('en-NG')}.`,
    });
  }
  if (line.totalCost === 0) {
    warnings.push({
      code: 'NO_COST_RECORDED',
      severity: 'INFO',
      message: 'No cost is recorded for this product, so its margin cannot be checked. Set a cost price to make margin reporting meaningful.',
    });
  }
  const threshold = minMarginPct != null ? Number(minMarginPct) : Number(product && product.min_margin_pct);
  if (Number.isFinite(threshold) && threshold > 0 && line.marginPct != null && line.marginPct < threshold) {
    warnings.push({
      code: 'BELOW_MIN_MARGIN',
      severity: 'WARNING',
      message: `Margin is ${line.marginPct}%, below this product's ${threshold}% minimum.`,
    });
  }
  return warnings;
}

module.exports = {
  storedPrice,
  PRICE_SOURCES,
  resolveUnitPrice, applyLineDiscount, allocateOrderDiscount,
  computeSaleLine, computeSaleTotals, marginWarnings,
};
