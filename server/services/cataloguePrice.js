'use strict';
// =====================================================================
// server/services/cataloguePrice.js — A RECEIPT PRICE THE TILL CAN SELL
// =====================================================================
// Receiving asks for a selling price and stores it on the batch. The till
// refuses a line whose catalogue price is still 0, before the batch price
// is ever read. A shop that typed ₦12,000 at the gate was told to set a
// price in the catalogue.
//
// The shared market list (business_id IS NULL) is not priced for every
// business. One shop's receipt must not write products.selling_price on
// that row. This branch's price override is the shop price instead. A
// product the business owns, still unpriced, gets products.selling_price.
//
// A price already set is left alone. A later delivery prices its own batch
// and does not quietly replace the price the till is already charging.

const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');

/**
 * Statements to queue inside the receipt transaction. Reads happen here,
 * before the transaction opens — the write phase may only queue.
 */
async function planCataloguePrice(db, { product, branchId, businessId, sellingPrice, userId }) {
  const price = round2(Number(sellingPrice) || 0);
  const empty = { statements: [], catalogue: false, overrideId: null, filed: false, receipt: null };
  if (!(price > 0) || !product || product.id == null || !branchId) return empty;

  const statements = [];
  const ownedHere = Boolean(product.business_id) && String(product.business_id) === String(businessId);
  const catalogueEmpty = !(Number(product.selling_price) > 0);
  let catalogue = false;
  if (ownedHere && catalogueEmpty) {
    catalogue = true;
    statements.push({
      sql: `UPDATE products SET selling_price = ?, updated_at = datetime('now')
            WHERE id = ? AND business_id = ? AND (selling_price IS NULL OR selling_price <= 0)`,
      params: [price, String(product.id), String(businessId)],
    });
  }

  // An override on an owned product would hide a later catalogue edit: the
  // till charges the override first. Only a shared market row, which must
  // not be priced for every business, gets one.
  let overrideId = null;
  if (!ownedHere && catalogueEmpty) {
    const existing = await db.first(
      `SELECT id, default_selling_price FROM product_price_overrides
        WHERE branch_id = ? AND product_id = ? AND is_deleted = 0 AND variant_id IS NULL
        ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      [String(branchId), String(product.id)],
    );
    if (!existing) {
      overrideId = newId();
      statements.push({
        sql: `INSERT INTO product_price_overrides
            (id, branch_id, product_id, variant_id, default_selling_price, updated_by, created_at, updated_at)
          VALUES (?,?,?,NULL,?,?, datetime('now'), datetime('now'))`,
        params: [overrideId, String(branchId), String(product.id), price, userId ? String(userId) : null],
      });
    }
  }

  return {
    statements,
    catalogue,
    overrideId,
    filed: catalogue || Boolean(overrideId),
    receipt: {
      product_id: String(product.id),
      branch_id: String(branchId),
      selling_price: price,
      catalogue,
      override_id: overrideId,
    },
  };
}

module.exports = { planCataloguePrice };
