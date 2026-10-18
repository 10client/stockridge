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
//   OWNER   — ONE stored role, not two. The businesses on the row are the fact,
//             the same way a manager's branch is the fact. A CO_OWNER value
//             would be a second fact that can disagree with what they can reach.
//               Proprietor   business_id IS NULL — every business, every branch,
//                            including a business or branch opened later.
//                            Settings and the trading name are theirs.
//               Co-owner     business_id IS SET  — that business, plus any
//                            user_business_access grants. Every branch of those
//                            businesses, and not a business left unticked.
//                            Owner-level work inside that set. Not the
//                            deployment settings, and not another co-owner.
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

/**
 * The proprietor is an owner with no business on the row. That empty pin is
 * what makes them reach every business, including one opened tomorrow.
 * A co-owner is the same stored role with a business on the row.
 */
function isProprietor(user) {
  if (!user) return false;
  if (String(user.role || '').toUpperCase() !== 'OWNER') return false;
  // A co-owner always carries a grant, including for the business on their
  // row. An owner with no grant still owns every business — that is how an
  // owner added before co-owners existed stays the proprietor without a
  // rewrite of their row.
  if (user.owner_limited === true) return false;
  if (user.owner_limited === false) return true;
  if (user.grant_count != null) return Number(user.grant_count) === 0;
  return !user.business_id;
}

function isCoOwner(user) {
  if (!user) return false;
  if (String(user.role || '').toUpperCase() !== 'OWNER' || !user.business_id) return false;
  if (user.owner_limited === true) return true;
  if (user.owner_limited === false) return false;
  if (user.grant_count != null) return Number(user.grant_count) > 0;
  return false;
}

/** Admin, or the proprietor. A co-owner does not appoint another co-owner. */
function canAppointCoOwner(actor) {
  if (!actor) return false;
  if (String(actor.role || '').toUpperCase() === 'ADMIN') return true;
  return isProprietor(actor);
}

/**
 * Deployment-wide settings, the trading name, the logo. A co-owner of one
 * business must not rename the receipt every other business prints.
 */
function canChangeDeployment(user) {
  if (!user) return false;
  if (String(user.role || '').toUpperCase() === 'ADMIN') return true;
  return isProprietor(user);
}

function roleLabel(role, user) {
  const r = String(role || '').toUpperCase();
  if (r === 'MANAGER') return managerJobTitle(user) || 'Manager';
  if (r === 'OWNER') return isCoOwner(user) ? 'Co-owner' : 'Owner';
  return { ADMIN: 'Platform Administrator', STAFF: 'Staff' }[r] || r;
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
  // Both are stored as OWNER, so rank alone would refuse the proprietor
  // editing the co-owner they appointed. A co-owner does not edit the
  // proprietor, and two co-owners do not edit each other.
  if (isProprietor(actor) && isCoOwner(target)) return true;
  return outranks(actor.role, target.role);
}

/** PIN reset follows exactly the same authority as editing the user. */
function canResetPin(actor, target) {
  return canManageUser(actor, target);
}

/** Promotion/demotion authority: only strictly higher rank. */
/**
 * Who may rename a category or move a product between categories.
 * Owner, the platform administrator, or a general manager. A branch manager
 * is a manager with a branch, and that is not this job. No fifth stored role.
 */
function canOrganizeCatalogue(user) {
  if (!user) return false;
  const role = String(user.role || '').toUpperCase();
  if (role === 'ADMIN' || role === 'OWNER') return true;
  return role === 'MANAGER' && !user.branch_id;
}

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
  isProprietor, isCoOwner, canAppointCoOwner, canChangeDeployment,
  canManageUser, canResetPin, canChangeRole, canOrganizeCatalogue,
  NAVIGATION_BY_ROLE, navigationFor,
};
