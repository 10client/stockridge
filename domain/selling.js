'use strict';
// =====================================================================
// domain/selling.js — CATEGORY SELLING
// =====================================================================
// A Nigerian pharmacy is usually a dispensary and a small supermarket in the
// same shop. The cashier still takes one payment. The record does not mix the
// two: drugs are one selling category, provisions and drinks another, toiletries
// another. PharmaRidge did this with a fixed retail_category enum. StockRidge
// already has a per-business category tree, so the split is a reading of those
// codes, not a second column and not a constraint.
//
// The same map lives in public/js/util.js for the till, which cannot require
// this file. Keep the two lists the same.

const GROUPS = Object.freeze([
  { code: 'PHARMACEUTICALS', label: 'Pharmaceuticals' },
  { code: 'FOOD_DRINKS', label: 'Food & Drinks' },
  { code: 'BEAUTY_PERSONAL_CARE', label: 'Beauty & Personal Care' },
  { code: 'ACCESSORIES', label: 'Accessories' },
  { code: 'OTHERS', label: 'Others' },
]);

const MEMBERS = Object.freeze({
  PHARMACEUTICALS: ['ALIMENTARY', 'ANALGESICS', 'ANTIPARASITIC', 'CARDIOVASCULAR', 'CONTROLLED', 'DERMATOLOGY', 'INJECTIONS', 'RESPIRATORY', 'VITAMINS', 'PHARMACEUTICALS'],
  FOOD_DRINKS: ['PROVISIONS', 'DRINKS', 'SNACKS', 'FROZEN', 'FOODSTUFFS', 'BEVERAGES', 'CONFECTIONERY', 'FOOD_DRINKS'],
  BEAUTY_PERSONAL_CARE: ['PERSONAL_CARE', 'COSMETICS', 'BEAUTY_PERSONAL_CARE'],
  ACCESSORIES: ['ACCESSORIES', 'BABY', 'BABY_PRODUCTS'],
  OTHERS: ['HOUSEHOLD', 'STATIONERY', 'OTHERS', 'PLASTICS_KITCHENWARE', 'ELECTRICALS_SMALL'],
});

const BY_CODE = new Map();
for (const group of GROUPS) {
  for (const code of MEMBERS[group.code]) BY_CODE.set(code, group);
}

function sellingGroup(category) {
  const code = String((category && (category.code || category.category_code)) || '').trim().toUpperCase();
  const name = String((category && (category.name || category.category_name)) || '').trim();
  const known = BY_CODE.get(code);
  if (known) return { code: known.code, label: known.label };
  if (code || name) return { code: code || 'OTHERS', label: name || code };
  return { code: 'OTHERS', label: 'Others' };
}

function codesFor(groupCode) {
  const key = String(groupCode || '').trim().toUpperCase();
  if (MEMBERS[key]) return MEMBERS[key].slice();
  return key ? [key] : [];
}

function groupOrder(code) {
  const i = GROUPS.findIndex((g) => g.code === code);
  return i === -1 ? GROUPS.length : i;
}

module.exports = { GROUPS, MEMBERS, sellingGroup, codesFor, groupOrder };
