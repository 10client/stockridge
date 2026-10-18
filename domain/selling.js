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
  // NAFDAC catalogue shelves. A registration is filed under one of these so the
  // catalogue can list the products under the category, the same as provisions.
  'NERVOUS_SYSTEM', 'ANTI_INFECTIVES', 'MUSCULOSKELETAL', 'BLOOD', 'GENITO_URINARY',
  'SENSORY', 'ANTINEOPLASTIC', 'VETERINARY', 'SYSTEMIC_HORMONES', 'MEDICAL_DEVICE',
  'VACCINES', 'HERBAL', 'PHARMA_OTHER', 'PHARMA_VARIOUS',
]);

// The Greenbook names its shelves differently from the shop. The shop name is
// what the catalogue shows. The code is what keeps the side pharmaceutical.
const NAFDAC_SHELVES = Object.freeze({
  'nervous system': { code: 'NERVOUS_SYSTEM', name: 'Nervous system' },
  'anti-infectives (systemic)': { code: 'ANTI_INFECTIVES', name: 'Anti-infectives' },
  'alimentary & metabolism': { code: 'ALIMENTARY', name: 'Alimentary' },
  'antiparasitic': { code: 'ANTIPARASITIC', name: 'Antiparasitic' },
  'cardiovascular': { code: 'CARDIOVASCULAR', name: 'Cardiovascular' },
  'dermatological': { code: 'DERMATOLOGY', name: 'Dermatology' },
  'musculoskeletal': { code: 'MUSCULOSKELETAL', name: 'Musculoskeletal' },
  'other': { code: 'PHARMA_OTHER', name: 'Other medicines' },
  'respiratory': { code: 'RESPIRATORY', name: 'Respiratory' },
  'blood & blood forming': { code: 'BLOOD', name: 'Blood and blood forming' },
  'genito-urinary & sex hormones': { code: 'GENITO_URINARY', name: 'Genito-urinary' },
  'sensory organs': { code: 'SENSORY', name: 'Sensory organs' },
  'antineoplastic & immunomodulating': { code: 'ANTINEOPLASTIC', name: 'Antineoplastic' },
  'veterinary': { code: 'VETERINARY', name: 'Veterinary' },
  'systemic hormones': { code: 'SYSTEMIC_HORMONES', name: 'Systemic hormones' },
  'medical device': { code: 'MEDICAL_DEVICE', name: 'Medical devices' },
  'various': { code: 'PHARMA_VARIOUS', name: 'Various' },
  'herbal & nutraceutical': { code: 'VITAMINS', name: 'Vitamins and supplements' },
  'vaccines & biologics': { code: 'VACCINES', name: 'Vaccines and biologics' },
});

function shelfForNafdacCategory(name) {
  const key = String(name || '').trim().toLowerCase();
  if (NAFDAC_SHELVES[key]) return NAFDAC_SHELVES[key];
  const code = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'PHARMA_OTHER';
  return { code, name: String(name || 'Other medicines').trim().slice(0, 120) || 'Other medicines' };
}

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
  GROUPS, PHARMACEUTICAL_CODES, NAFDAC_SHELVES, shelfForNafdacCategory,
  sellingGroup, codesFor, groupOrder, codeClause, productWhere, saleLineWhere,
};
