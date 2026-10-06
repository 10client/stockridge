'use strict';
// =====================================================================
// domain/roles.js — ROLE HIERARCHY AND AUTHORITY RULES
// =====================================================================
// FOUR STORED ROLES. NOT FIVE, AND DELIBERATELY SO.
//
//   ADMIN   — the software vendor / platform administrator. Exactly one
//             deployment-wide seat, normally 1-2 people at StockRidge (the
//             company selling the software), NOT part of the client's own
//             staff. Sets and enforces the client's plan limits and this
//             deployment's branding via /api/admin/*. Never counted against
//             the client's staff limit, always bypasses the subscription
//             gate (so the vendor can never be locked out of their own
//             client's instance), and hidden from the ordinary Users screen
//             the client's own staff use to manage their team.
//
//   OWNER   — the proprietor. Full operational access identical to MANAGER
//             (every business, every branch, all reports) PLUS visibility of
//             their own subscription/plan usage via /api/dashboard/plan, and
//             SOLE authority over the OWNER-controlled permission switches in
//             client_settings. Distinct from MANAGER mainly so a client can
//             have day-to-day managers who run operations without being the
//             person accountable for the commercial relationship with the
//             vendor.
//
//   MANAGER — day-to-day operations admin. ONE STORED ROLE, NOT TWO:
//               General Manager   branch_id IS NULL — every branch
//               Branch Manager    branch_id IS SET   — exactly one branch
//
//             A separate BRANCH_MANAGER role value would be a SECOND fact
//             encoding the same thing, and the two could then disagree: a
//             BRANCH_MANAGER row with a NULL branch_id, or a MANAGER row with
//             a branch_id that some code path forgot to check. branch_id is
//             already the single source of truth for every authorisation
//             decision in the codebase, so the job title is DERIVED from it
//             and cannot contradict it.
//
//   STAFF   — cashier / sales rep / storekeeper. Always pinned to one branch.
//
// The hierarchy is a total order. Every "may X act on Y" question in the app
// resolves through rankOf(), so a new rule cannot accidentally invent a
// second ordering.
// =====================================================================

const ROLES = Object.freeze({
  ADMIN: 'ADMIN',
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  STAFF: 'STAFF',
});

const ROLE_RANK = Object.freeze({ ADMIN: 4, OWNER: 3, MANAGER: 2, STAFF: 1 });

const ROLE_ORDER = Object.freeze(['STAFF', 'MANAGER', 'OWNER', 'ADMIN']);

function rankOf(role) {
  return ROLE_RANK[String(role || '').toUpperCase()] || 0;
}

function isRole(value) {
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, String(value || '').toUpperCase());
}

/** Strictly outranks. Equal rank returns false — a manager cannot act on a peer. */
function outranks(actorRole, targetRole) {
  return rankOf(actorRole) > rankOf(targetRole);
}

function atLeast(actorRole, minimumRole) {
  return rankOf(actorRole) >= rankOf(minimumRole);
}

/**
 * The job title shown in the UI for a MANAGER, derived ENTIRELY from
 * whether the row carries a branch_id. Never stored, so it cannot drift
 * out of agreement with the fact it describes.
 */
function managerJobTitle(user) {
  if (!user || String(user.role).toUpperCase() !== 'MANAGER') return user && user.job_title ? user.job_title : null;
  const derived = user.branch_id ? 'Branch Manager' : 'General Manager';
  // A user-supplied job_title wins for display ("Operations Supervisor")
  // but the AUTHORITY is always the derived one — the label is cosmetic.
  return user.job_title || derived;
}

function roleLabel(role, user) {
  const r = String(role || '').toUpperCase();
  if (r === 'MANAGER') return managerJobTitle(user) || 'Manager';
  return { ADMIN: 'Platform Administrator', OWNER: 'Owner', STAFF: 'Staff' }[r] || r;
}

/**
 * Who may create / edit / deactivate a user of a given role.
 *
 * The rule is: strictly outrank, OR be the OWNER/ADMIN acting on a MANAGER
 * or below. A manager may never edit a PEER manager — two general managers
 * editing each other is how a branch ends up with no manager and nobody
 * able to say who removed them.
 */
function canManageUser(actor, target) {
  if (!actor || !target) return false;
  if (String(actor.id) === String(target.id)) return false; // nobody edits their own role via this path
  if (String(actor.role).toUpperCase() === 'ADMIN') return true;
  if (String(target.role).toUpperCase() === 'ADMIN') return false; // only ADMIN touches ADMIN
  return outranks(actor.role, target.role);
}

/** PIN reset follows exactly the same authority as editing the user. */
function canResetPin(actor, target) {
  return canManageUser(actor, target);
}

/** Promotion/demotion authority: only strictly higher rank. */
function canChangeRole(actor, target, newRole) {
  if (!canManageUser(actor, target)) return false;
  if (!isRole(newRole)) return false;
  if (String(newRole).toUpperCase() === 'ADMIN') return String(actor.role).toUpperCase() === 'ADMIN';
  return rankOf(newRole) < rankOf(actor.role);
}

/**
 * Which screens a role can even see. Enforced in the router AND in the
 * navigation, so the two cannot disagree — a nav item that leads to a 403
 * is a support ticket.
 */
const NAVIGATION_BY_ROLE = Object.freeze({
  ADMIN: ['admin', 'businesses', 'branches', 'users', 'plan', 'settings', 'data-management', 'sync', 'compliance'],
  OWNER: ['dashboard', 'pos', 'sales', 'products', 'stock', 'customers', 'purchase-orders', 'suppliers',
    'transfers', 'stocktake', 'till', 'safe', 'expenses', 'debtors', 'creditors', 'instalments', 'layaway',
    'warranty', 'deliveries', 'attendance', 'accounting', 'wht', 'reports', 'change-owed', 'recalls',
    'businesses', 'branches', 'users', 'plan', 'settings', 'sync', 'audit', 'compliance'],
  MANAGER: ['dashboard', 'pos', 'sales', 'products', 'stock', 'customers', 'purchase-orders', 'suppliers',
    'transfers', 'stocktake', 'till', 'safe', 'expenses', 'debtors', 'creditors', 'instalments', 'layaway',
    'warranty', 'deliveries', 'attendance', 'accounting', 'wht', 'reports', 'change-owed', 'recalls',
    'branches', 'users', 'sync', 'audit', 'compliance'],
  STAFF: ['dashboard', 'pos', 'sales', 'stock', 'customers', 'stocktake', 'till', 'deliveries', 'layaway',
    'warranty', 'change-owed', 'attendance'],
});

function navigationFor(role) {
  return NAVIGATION_BY_ROLE[String(role || '').toUpperCase()] || [];
}

module.exports = {
  ROLES, ROLE_RANK, ROLE_ORDER,
  rankOf, isRole, outranks, atLeast,
  managerJobTitle, roleLabel,
  canManageUser, canResetPin, canChangeRole,
  NAVIGATION_BY_ROLE, navigationFor,
};
