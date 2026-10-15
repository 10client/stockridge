'use strict';
// =====================================================================
// domain/selling.js — CATEGORY SELLING
// =====================================================================
// A Nigerian pharmacy is usually a dispensary and a supermarket in the same
// shop. The cashier still takes one payment. The books do not mix the two
// sides. A product is pharmaceutical when it comes from the NAFDAC catalogue,
// or when the shop adds it under a pharmaceutical category. Anything else —
// including a food item that merely has a NAFDAC number — is not.
//
// The same map lives in public/js/util.js for the till, which cannot require
// this file. Keep the two lists the same.

const GROUPS = Object.freeze([
  { code: 'PHARMACEUTICALS', label: 'Pharmaceuticals' },
  { code: 'NON_PHARMACEUTICALS', label: 'Non-pharmaceuticals' },
]);

const PHARMACEUTICAL_CODES = Object.freeze([
  'ALIMENTARY', 'ANALGESICS', 'ANTIPARASITIC', 'CARDIOVASCULAR', 'CONTROLLED',
  'DERMATOLOGY', 'INJECTIONS', 'RESPIRATORY', 'VITAMINS', 'PHARMACEUTICALS',
]);

const DRUGS = new Set(PHARMACEUTICAL_CODES);

function categoryCode(item) {
  return String((item && (item.code || item.category_code || item.categoryCode || item.product_category_code)) || '').trim().toUpperCase();
}

function fromNafdacCatalogue(item) {
  if (!item) return false;
  const id = item.nafdac_catalog_id != null ? item.nafdac_catalog_id
    : (item.nafdacCatalogId != null ? item.nafdacCatalogId : item.product_nafdac_catalog_id);
  if (id == null || id === '') return false;
  const n = Number(id);
  return Number.isFinite(n) ? n > 0 : true;
}

/**
 * A product is pharmaceutical when it was copied from the NAFDAC catalogue,
 * or when the shop added it under a pharmaceutical category. A registration
 * number on soap or rice is not the catalogue, and does not move the side.
 */
function sellingGroup(item) {
  if (fromNafdacCatalogue(item) || DRUGS.has(categoryCode(item))) {
    return { code: 'PHARMACEUTICALS', label: 'Pharmaceuticals' };
  }
  return { code: 'NON_PHARMACEUTICALS', label: 'Non-pharmaceuticals' };
}

function codesFor(groupCode) {
  const key = String(groupCode || '').trim().toUpperCase();
  if (key === 'PHARMACEUTICALS') return PHARMACEUTICAL_CODES.slice();
  return key ? [key] : [];
}

function groupOrder(code) {
  const i = GROUPS.findIndex((g) => g.code === code);
  return i === -1 ? GROUPS.length : i;
}

function marks() {
  return PHARMACEUTICAL_CODES.map(() => '?').join(',');
}

/**
 * A predicate on a category-code column. Used only where the row is a
 * category, not a product. A product uses productWhere, because a Greenbook
 * copy is pharmaceutical even when its shelf category is not.
 */
function codeClause(column, groupCode) {
  const key = String(groupCode || '').trim().toUpperCase();
  if (key === 'PHARMACEUTICALS') {
    return { sql: `${column} IN (${marks()})`, params: PHARMACEUTICAL_CODES.slice() };
  }
  if (key === 'NON_PHARMACEUTICALS') {
    return { sql: `(${column} IS NULL OR ${column} NOT IN (${marks()}))`, params: PHARMACEUTICAL_CODES.slice() };
  }
  return { sql: '1 = 1', params: [] };
}

/** A predicate on a products alias `p`. */
function productWhere(groupCode) {
  const key = String(groupCode || '').trim().toUpperCase();
  const params = PHARMACEUTICAL_CODES.slice();
  const filedUnder = `EXISTS (SELECT 1 FROM product_categories pcg WHERE pcg.id = p.category_id AND pcg.is_deleted = 0 AND pcg.code IN (${marks()}))`;
  if (key === 'PHARMACEUTICALS') {
    return { sql: `(p.nafdac_catalog_id IS NOT NULL OR ${filedUnder})`, params };
  }
  if (key === 'NON_PHARMACEUTICALS') {
    return { sql: `(p.nafdac_catalog_id IS NULL AND NOT ${filedUnder})`, params };
  }
  return { sql: '1 = 1', params: [] };
}

/**
 * A predicate for a sale line joined as `si`, its product `p`, and its
 * category `pc`. The catalogue link is on the product. The shelf the shop
 * chose is the category snapshot on the line.
 */
function saleLineWhere(groupCode) {
  const key = String(groupCode || '').trim().toUpperCase();
  const params = PHARMACEUTICAL_CODES.slice();
  const pharma = `(p.nafdac_catalog_id IS NOT NULL OR pc.code IN (${marks()}))`;
  if (key === 'PHARMACEUTICALS') return { sql: pharma, params };
  if (key === 'NON_PHARMACEUTICALS') return { sql: `(p.nafdac_catalog_id IS NULL AND (pc.code IS NULL OR pc.code NOT IN (${marks()})))`, params };
  return { sql: '1 = 1', params: [] };
}

module.exports = {
  GROUPS, PHARMACEUTICAL_CODES, sellingGroup, codesFor, groupOrder, codeClause, productWhere, saleLineWhere,
};
