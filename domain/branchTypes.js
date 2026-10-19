'use strict';
// A branch type is how that shop trades, not a second set of books.
// RENTAL uses the hire and lease accounts that already exist: the fee is
// income, the deposit is a liability, and the goods stay in stock until sold.

const BRANCH_TYPES = Object.freeze(['RETAIL', 'WHOLESALE', 'WAREHOUSE', 'SHOWROOM', 'RENTAL', 'MIXED']);

const BRANCH_TYPE_LABELS = Object.freeze({
  RETAIL: 'Retail',
  WHOLESALE: 'Wholesale',
  WAREHOUSE: 'Warehouse',
  SHOWROOM: 'Showroom',
  RENTAL: 'Rental services',
  MIXED: 'Mixed',
});

// A hire or lease business opens as a rental yard unless the caller picks
// another type. Sell-and-lease stays mixed: it sells units as well as letting them.
const RENTAL_PROFILES = new Set(['EVENT_RENTAL', 'EQUIPMENT_RENTAL', 'LEASING']);

function defaultBranchType(profileCode) {
  return RENTAL_PROFILES.has(String(profileCode || '').toUpperCase()) ? 'RENTAL' : 'RETAIL';
}

function branchTypeLabel(code) {
  const key = String(code || 'RETAIL').toUpperCase();
  return BRANCH_TYPE_LABELS[key] || key;
}

module.exports = {
  BRANCH_TYPES,
  BRANCH_TYPE_LABELS,
  RENTAL_PROFILES,
  defaultBranchType,
  branchTypeLabel,
};
