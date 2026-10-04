// =====================================================================
// StockRidge — PRICING (customer tiers, wholesale breaks, price ladder)
// =====================================================================
// THE COMMERCIAL CORE OF A WHOLESALE/RETAIL BUSINESS.
//
// A pharmacy sells one price to everyone. An appliance wholesaler does
// not: the walk-in pays the shelf price, the reseller buying five units
// pays less, the dealer taking a carton pays less again, and the hotel
// fitting out 40 rooms has a negotiated contract price. Getting this
// wrong is not a rounding problem — it is the difference between a
// business that makes margin and one that gives it away at the counter.
//
// ---------------------------------------------------------------------
// THE PRICE LADDER (resolution order, first hit wins)
// ---------------------------------------------------------------------
//   1. An explicit negotiated price on the customer's own record
//      (customers.negotiated_price_percent or a per-customer contract).
//   2. A per-branch, per-tier price OVERRIDE — product_price_overrides
//      keyed by (branch_id, product_id, tier_code). Lagos wholesale and
//      Kano wholesale genuinely differ.
//   3. The tier's default discount off the retail price, taken from the
//      active business profile.
//   4. The batch's own selling_price_per_unit — the price of record for
//      THAT stock, already branch-scoped, because a shop holding two
//      consignments bought at different costs may legitimately price them
//      differently.
//   5. The product's default retail price.
//
// Every step is optional and every miss falls through to the next, so a
// newly created product with no overrides still prices correctly from its
// batch. The function returns the WHOLE ladder it walked, not just the
// winner, so the POS can show the cashier *why* a price is what it is —
// a price nobody can explain is a price somebody will override.
// =====================================================================

const { round2, applyPercentDiscount } = require('./money');
const { canonicalUnit, piecesPerUnit } = require('./uom');

// ---------------------------------------------------------------------
// SHAPE TOLERANCE
// ---------------------------------------------------------------------
// These functions accept EITHER a raw profile (verticals.getProfile('X'),
// whose tiers live at profile.pricing.customerTiers) OR a merged profile
// (verticals.mergeProfiles([...]), whose tiers are hoisted to the top
// level). Accepting both is not laziness: the POS holds a merged profile
// while a single-vertical report holds a raw one, and a tier lookup that
// only works on one shape silently returns a 0% discount on the other —
// which is a customer being charged full retail without anyone seeing an
// error. Every accessor goes through these two helpers.
function tiersOf(profile) {
  if (!profile) return [];
  if (Array.isArray(profile.customerTiers) && profile.customerTiers.length) return profile.customerTiers;
  const p = profile.pricing;
  return (p && Array.isArray(p.customerTiers)) ? p.customerTiers : [];
}

function pricingOf(profile) {
  if (!profile) return {};
  return profile.pricing || profile;
}

// A tier code is only valid if the active profile defines it. Validating
// against the profile rather than a global list is what lets Furniture's
// "PROJECT" tier and Electronics' "DEALER" tier coexist without either
// appearing in a shop that has no use for it.
function isTierCode(profile, code) {
  if (!code) return false;
  return tiersOf(profile).some((t) => t.code === String(code).toUpperCase());
}

function tierOf(profile, code) {
  const tiers = tiersOf(profile);
  const c = String(code || 'RETAIL').toUpperCase();
  return tiers.find((t) => t.code === c)
    || tiers[0]
    || { code: 'RETAIL', label: 'Retail', defaultDiscountPercent: 0 };
}

// Does this quantity qualify for the wholesale break on its own, ignoring
// the customer's declared tier? A walk-in buying 30 kettles IS a wholesale
// transaction even if nobody set them up as a dealer, and refusing them the
// price at the counter means losing the sale.
function qualifiesForWholesaleByQty(profile, totalPieces) {
  const min = Number(pricingOf(profile).wholesaleMinQty) || 0;
  return min > 0 && Number(totalPieces) >= min;
}

// Resolve the unit price for ONE line.
//
// Inputs are deliberately plain values, not DB rows, so this stays a pure
// function that can be unit-tested and reused on the client for instant
// basket re-pricing without a round trip.
function resolveLinePrice({
  retailPrice,                 // product's default retail price per base piece
  batchPrice,                  // stock_batches.selling_price_per_unit for the batch being sold
  overridePrice,               // product_price_overrides row for (branch, product, tier) or null
  customerTier = 'RETAIL',
  customerNegotiatedPercent = null,
  mergedProfile,
  unitPrice,                   // the unit the counter is selling in: PIECE/PACK/CARTON
  nesting = {},                // { unitsPerPack, packsPerCarton, cartonsPerPallet }
  quantity = 1,
  batchCostPerPiece = 0,
}) {
  const tier = tierOf(mergedProfile, customerTier);
  const pieces = piecesPerUnit(unitPrice, nesting) || 1;
  const totalPieces = Math.max(0, Number(quantity) || 0) * pieces;

  // ---- walk the ladder ------------------------------------------------
  const ladder = [];
  let basePerPiece = null;

  if (overridePrice != null && Number.isFinite(Number(overridePrice)) && Number(overridePrice) > 0) {
    basePerPiece = Number(overridePrice);
    ladder.push({ step: 'BRANCH_TIER_OVERRIDE', perPiece: basePerPiece });
  } else if (batchPrice != null && Number.isFinite(Number(batchPrice)) && Number(batchPrice) > 0) {
    basePerPiece = Number(batchPrice);
    ladder.push({ step: 'BATCH_PRICE_OF_RECORD', perPiece: basePerPiece });
  } else if (retailPrice != null && Number.isFinite(Number(retailPrice)) && Number(retailPrice) > 0) {
    basePerPiece = Number(retailPrice);
    ladder.push({ step: 'PRODUCT_RETAIL_PRICE', perPiece: basePerPiece });
  } else {
    basePerPiece = 0;
    ladder.push({ step: 'NO_PRICE_ON_RECORD', perPiece: 0 });
  }

  // ---- tier discount --------------------------------------------------
  let discountPercent = Number(tier.defaultDiscountPercent) || 0;
  let discountSource = discountPercent > 0 ? `Tier: ${tier.label}` : null;

  // A negotiated contract beats the tier default, but only ever DOWNWARD
  // for the customer's benefit — a negotiated 0% must not cancel a tier
  // discount the customer was already entitled to, or signing a contract
  // would make a dealer pay MORE.
  if (customerNegotiatedPercent != null && Number.isFinite(Number(customerNegotiatedPercent))) {
    const negotiated = Math.min(100, Math.max(0, Number(customerNegotiatedPercent)));
    if (negotiated > discountPercent) {
      discountPercent = negotiated;
      discountSource = `Negotiated contract (${negotiated}%)`;
    }
  }

  // An automatic wholesale break for a walk-in buying in volume. Applied
  // only where it IMPROVES on what the tier already gives, for the same
  // reason.
  if (qualifiesForWholesaleByQty(mergedProfile, totalPieces)) {
    const wholesaleTier = tierOf(mergedProfile, 'WHOLESALE');
    const w = Number(wholesaleTier.defaultDiscountPercent) || 0;
    if (w > discountPercent) {
      discountPercent = w;
      discountSource = `Automatic wholesale break at ${totalPieces.toLocaleString('en-NG')}+ pieces`;
    }
  }

  const discountedPerPiece = discountPercent > 0 ? applyPercentDiscount(basePerPiece, discountPercent) : round2(basePerPiece);
  if (discountPercent > 0) ladder.push({ step: 'TIER_DISCOUNT', percent: discountPercent, source: discountSource, perPiece: discountedPerPiece });

  // ---- scale to the selling unit --------------------------------------
  // FULL PRECISION per piece, rounded only for the unit price the cashier
  // sees. Rounding the piece price before multiplying by 24 would lose up
  // to ₦0.24 on every pack sold.
  const unitPriceResolved = round2(discountedPerPiece * pieces);
  const extended = round2(discountedPerPiece * totalPieces);

  const costPerPiece = Number(batchCostPerPiece) || 0;
  const costExtended = round2(costPerPiece * totalPieces);

  return {
    tier: tier.code,
    tierLabel: tier.label,
    unit: canonicalUnit(unitPrice) || 'PIECE',
    piecesPerUnit: pieces,
    totalPieces,
    basePerPiece,
    discountPercent: round2(discountPercent),
    discountSource,
    perPiece: discountedPerPiece,
    unitPrice: unitPriceResolved,
    quantity: Number(quantity) || 0,
    extended,
    costPerPiece,
    costExtended,
    grossProfit: round2(extended - costExtended),
    marginPercent: extended > 0 ? round2(((extended - costExtended) / extended) * 100) : null,
    ladder,
  };
}

// Re-price a whole basket. Returns the line results plus totals. The basket
// total is the SUM OF THE EXTENDED LINES rounded once — never the sum of
// already-rounded unit prices times quantity, which is how a 12-line basket
// drifts a kobo from its own receipt.
function priceBasket(lines, ctx) {
  const priced = (lines || []).map((l) => resolveLinePrice({ ...ctx, ...l }));
  const subtotal = round2(priced.reduce((a, l) => a + l.extended, 0));
  const cost = round2(priced.reduce((a, l) => a + l.costExtended, 0));
  return {
    lines: priced,
    subtotal,
    totalCost: cost,
    grossProfit: round2(subtotal - cost),
    marginPercent: subtotal > 0 ? round2(((subtotal - cost) / subtotal) * 100) : null,
    itemCount: priced.reduce((a, l) => a + l.totalPieces, 0),
  };
}

// A price floor. Selling below cost is a legitimate decision (clearing a
// damaged fridge, beating a competitor on a known basket item) but it must
// be a MANAGER's decision and it must be recorded, so the shrinkage report
// can distinguish "sold cheap on purpose" from "stock walked out".
function belowCostWarning(line) {
  if (!line || !Number.isFinite(line.unitPrice) || !Number.isFinite(line.costPerPiece)) return null;
  if (line.costPerPiece <= 0) return null; // no cost on record: nothing to compare against
  if (line.perPiece >= line.costPerPiece) return null;
  const loss = round2((line.costPerPiece - line.perPiece) * line.totalPieces);
  return {
    code: 'BELOW_COST',
    level: 'WARN',
    loss,
    message:
      `This line sells at ₦${line.perPiece.toFixed(2)} per piece against a cost of ₦${line.costPerPiece.toFixed(2)} — ` +
      `a loss of ₦${loss.toLocaleString('en-NG')} on the line. Manager approval required.`,
  };
}

// Price-change audit helper. A price edit is recorded with its before and
// after so the "who dropped the price of the 65-inch TV before their
// cousin came in" question is answerable from the log rather than from
// memory.
function describePriceChange({ productName, field, before, after, by, reason }) {
  return {
    entity: 'product_price',
    productName,
    field,
    before: before == null ? null : Number(before),
    after: after == null ? null : Number(after),
    by,
    reason: reason || null,
    at: new Date().toISOString(),
  };
}

module.exports = {
  isTierCode,
  tierOf,
  qualifiesForWholesaleByQty,
  resolveLinePrice,
  priceBasket,
  belowCostWarning,
  describePriceChange,
};
