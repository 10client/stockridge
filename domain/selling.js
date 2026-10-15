'use strict';
// =====================================================================
// domain/selling.js — CATEGORY SELLING
// =====================================================================
// A Nigerian pharmacy is usually a dispensary and a supermarket in the same
// shop. The cashier still takes one payment. The books do not mix the two
// sides: drugs are pharmaceuticals, and everything else on the shelf is
// non-pharmaceutical. The shelf categories (Analgesics, Provisions, Drinks)
// stay as they are. This file only reads them.
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

function categoryCode(category) {
  return String((category && (category.code || category.category_code)) || '').trim().toUpperCase();
}

function sellingGroup(category) {
  if (DRUGS.has(categoryCode(category))) return { code: 'PHARMACEUTICALS', label: 'Pharmaceuticals' };
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

/**
 * A predicate on a category-code column. The column name is chosen by the
 * caller (`pc.code`), never by the request. Non-pharmaceuticals is everything
 * that is not a drug code, including a shelf with no category yet.
 */
function codeClause(column, groupCode) {
  const key = String(groupCode || '').trim().toUpperCase();
  const marks = PHARMACEUTICAL_CODES.map(() => '?').join(',');
  if (key === 'PHARMACEUTICALS') {
    return { sql: `${column} IN (${marks})`, params: PHARMACEUTICAL_CODES.slice() };
  }
  if (key === 'NON_PHARMACEUTICALS') {
    return { sql: `(${column} IS NULL OR ${column} NOT IN (${marks}))`, params: PHARMACEUTICAL_CODES.slice() };
  }
  return { sql: '1 = 1', params: [] };
}

/** A predicate on a products alias `p`. */
function productWhere(groupCode) {
  const key = String(groupCode || '').trim().toUpperCase();
  const marks = PHARMACEUTICAL_CODES.map(() => '?').join(',');
  const params = PHARMACEUTICAL_CODES.slice();
  if (key === 'PHARMACEUTICALS') {
    return {
      sql: `EXISTS (SELECT 1 FROM product_categories pcg WHERE pcg.id = p.category_id AND pcg.is_deleted = 0 AND pcg.code IN (${marks}))`,
      params,
    };
  }
  if (key === 'NON_PHARMACEUTICALS') {
    return {
      sql: `(p.category_id IS NULL OR NOT EXISTS (SELECT 1 FROM product_categories pcg WHERE pcg.id = p.category_id AND pcg.is_deleted = 0 AND pcg.code IN (${marks})))`,
      params,
    };
  }
  return { sql: '1 = 1', params: [] };
}

module.exports = {
  GROUPS, PHARMACEUTICAL_CODES, sellingGroup, codesFor, groupOrder, codeClause, productWhere,
};
