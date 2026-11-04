'use strict';
// =====================================================================
// public/js/role-screens.js — THE ONE SCREEN LIST
// =====================================================================
// The sidebar and the route guard both read this file. The server reads the
// same file. A second list in the router is how a cashier was offered Flagged
// sales and a manager was locked out of Accounting.
//
// Four stored roles. A co-owner is an owner with a business pin, not a fifth
// role. A branch manager is a manager with a branch pin. Those facts cut the
// list; they do not add a role value.
// =====================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  const host = root || (typeof globalThis !== 'undefined' ? globalThis : null);
  if (host) {
    host.SR = host.SR || {};
    host.SR.roleScreens = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Hire book, vehicles and sync are module or till screens added after the
  // first list. A cashier in a hire shop has to open the hire book. A cashier
  // on a dispatch till has to open vehicles. Sync is how they see whether the
  // till has caught up — hiding it made an empty shop look unsaved with no
  // way to check. Flagged sales stay with a manager: that queue is a review,
  // not a receipt the cashier is correcting.
  const NAVIGATION_BY_ROLE = Object.freeze({
    ADMIN: Object.freeze(['admin', 'businesses', 'branches', 'users', 'plan', 'settings', 'data-management', 'sync', 'compliance']),
    OWNER: Object.freeze(['dashboard', 'pos', 'sales', 'products', 'stock', 'customers', 'purchase-orders', 'suppliers',
      'transfers', 'stocktake', 'till', 'safe', 'expenses', 'debtors', 'creditors', 'instalments', 'layaway',
      'warranty', 'deliveries', 'attendance', 'accounting', 'wht', 'reports', 'change-owed', 'recalls',
      'businesses', 'branches', 'users', 'plan', 'settings', 'sync', 'audit', 'compliance',
      'hire-book', 'fleet', 'flagged']),
    MANAGER: Object.freeze(['dashboard', 'pos', 'sales', 'products', 'stock', 'customers', 'purchase-orders', 'suppliers',
      'transfers', 'stocktake', 'till', 'safe', 'expenses', 'debtors', 'creditors', 'instalments', 'layaway',
      'warranty', 'deliveries', 'attendance', 'accounting', 'wht', 'reports', 'change-owed', 'recalls',
      'branches', 'users', 'sync', 'audit', 'compliance',
      'hire-book', 'fleet', 'flagged']),
    STAFF: Object.freeze(['dashboard', 'pos', 'sales', 'stock', 'customers', 'stocktake', 'till', 'deliveries', 'layaway',
      'warranty', 'change-owed', 'attendance', 'sync', 'hire-book', 'fleet']),
  });

  // Settings, the plan and a data cleanup change the deployment, not one
  // business. A co-owner does not get them. The proprietor does, including
  // the cleanup that lives on the plan screen.
  const DEPLOYMENT_SCREENS = Object.freeze(['settings', 'plan', 'data-management']);

  function navigationFor(role) {
    return NAVIGATION_BY_ROLE[String(role || '').toUpperCase()] || [];
  }

  function applyOwnerCuts(list, { role, proprietor, coOwner } = {}) {
    const next = (list || []).slice();
    if (String(role || '').toUpperCase() !== 'OWNER') return next;
    if (coOwner && !proprietor) return next.filter((key) => !DEPLOYMENT_SCREENS.includes(key));
    if (proprietor && !next.includes('data-management')) next.push('data-management');
    return next;
  }

  return {
    NAVIGATION_BY_ROLE,
    DEPLOYMENT_SCREENS,
    navigationFor,
    applyOwnerCuts,
  };
});
