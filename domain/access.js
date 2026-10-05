'use strict';
// =====================================================================
// domain/access.js — THE SINGLE SOURCE OF TRUTH FOR DATA SCOPING
// =====================================================================
// Every authorisation decision in this codebase routes through this module.
// That is not a stylistic preference; it is the fix for a class of bug that
// was reproduced live against a running server in the original build:
//
//   A Lagos device pushed a customer id belonging to MINNA. The push
//   returned 200 "updated: 1". The customer's name and phone were
//   overwritten with the Lagos device's values, and the row was MOVED into
//   Lagos. Worse, that customer owed Minna ₦110: after the push the debt
//   stayed recorded against Minna while the customer themselves appeared in
//   the LAGOS list, visible to a Lagos cashier who could read their
//   balance. One branch's debtor silently became another branch's customer.
//
// The cause was a scope check that was correct for an INSERT being reused
// for an UPDATE. Applied to an insert, "force branch_id to the caller's own
// branch" is right — a device may only create rows in its own branch.
// Applied to an update it REPARENTS a row that already belongs to somebody
// else, because the incoming branch_id is simply replaced.
//
// So this module keeps the two operations structurally different:
//   resolveMutationBranchId() — for INSERTs: the caller's scope, forced
//   assertRowAccess()        — for UPDATE/DELETE: the EXISTING row's scope,
//                              verified, and never overwritten
//
// A caller that confuses them gets a loud error, not a silent reparent.
// =====================================================================

const { rankOf, ROLES } = require('./roles');

// ---------------------------------------------------------------------
// SCOPE SHAPE
// ---------------------------------------------------------------------
// A resolved scope is a plain object:
//   { role, userId, allBusinesses, allBranches, businessIds:Set, branchIds:Set,
//     pinnedBranchId, pinnedBusinessId }
//
// `allBranches` true means "no branch filter at all" (OWNER/ADMIN/general
// MANAGER). It is NOT the same as branchIds containing every current
// branch — a branch created after login must be visible without re-login,
// which is why the flag exists rather than an enumerated set.

function buildScope(user, { businessIds = null, allBranchIds = null } = {}) {
  const role = String((user && user.role) || '').toUpperCase();
  const pinnedBranchId = user && user.branch_id ? String(user.branch_id) : null;
  const pinnedBusinessId = user && user.business_id ? String(user.business_id) : null;

  const isAdminVendor = role === ROLES.ADMIN;
  const allBusinesses = isAdminVendor || role === ROLES.OWNER || pinnedBusinessId === null;
  const allBranches = isAdminVendor || role === ROLES.OWNER || role === ROLES.MANAGER && pinnedBranchId === null;

  const scope = {
    role,
    userId: user ? String(user.id) : null,
    username: user ? user.username : null,
    fullName: user ? user.full_name : null,
    allBusinesses: Boolean(allBusinesses),
    allBranches: Boolean(allBranches),
    businessIds: allBusinesses ? null : new Set([pinnedBusinessId].concat(businessIds || []).filter(Boolean).map(String)),
    branchIds: allBranches ? null : new Set([pinnedBranchId].filter(Boolean).map(String)),
    pinnedBranchId,
    pinnedBusinessId,
  };
  // A general manager is scoped by BUSINESS even when not scoped by branch.
  if (scope.allBranches && !scope.allBusinesses && Array.isArray(allBranchIds)) {
    scope.branchIds = new Set(allBranchIds.filter((b) => scope.businessIds.has(String(b.business_id))).map((b) => String(b.id)));
    scope.allBranches = false;
  }
  return scope;
}

// ---------------------------------------------------------------------
// READ SCOPING — build a WHERE clause, never filter in JS
// ---------------------------------------------------------------------
// Filtering after the query returns would both leak row counts through
// timing and blow past D1's row limits on a busy branch. The clause is
// built into the SQL instead.

function branchFilter(scope, column = 'branch_id', { allowNull = false } = {}) {
  if (!scope) return { sql: '1 = 0', params: [] }; // no scope = no rows, fail closed
  if (scope.allBranches) return { sql: '1 = 1', params: [] };
  const ids = Array.from(scope.branchIds || []);
  if (!ids.length) return { sql: '1 = 0', params: [] };
  if (allowNull) {
    return { sql: `(${column} IS NULL OR ${column} IN (${ids.map(() => '?').join(',')}))`, params: ids };
  }
  return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function businessFilter(scope, column = 'business_id', { allowNull = true } = {}) {
  if (!scope) return { sql: '1 = 0', params: [] };
  if (scope.allBusinesses) return { sql: '1 = 1', params: [] };
  const ids = Array.from(scope.businessIds || []);
  if (!ids.length) return { sql: '1 = 0', params: [] };
  if (allowNull) {
    // NULL means "shared across the deployment" — a master catalogue product
    // or a shared customer. Those are visible to every business by design.
    return { sql: `(${column} IS NULL OR ${column} IN (${ids.map(() => '?').join(',')}))`, params: ids };
  }
  return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

// ---------------------------------------------------------------------
// READ ACCESS to one row
// ---------------------------------------------------------------------
function canReadRow(scope, row) {
  if (!scope || !row) return false;
  if (String(scope.role) === ROLES.ADMIN) return true;
  if (!scope.allBranches && row.branch_id && !scope.branchIds.has(String(row.branch_id))) return false;
  if (!scope.allBusinesses && row.business_id && !scope.businessIds.has(String(row.business_id))) return false;
  return true;
}

// ---------------------------------------------------------------------
// MUTATION SCOPING — INSERT
// ---------------------------------------------------------------------
/**
 * The branch a new row belongs to. A caller may request a branch; a scoped
 * user may only request their own. An unscoped (general) user may request
 * any branch they can read, and MUST request one for branch-scoped tables —
 * there is no sensible default when you run four shops.
 */
function resolveMutationBranchId(scope, requestedBranchId, { required = true } = {}) {
  if (!scope) throw scopeError('Not authenticated');
  if (scope.allBranches) {
    if (requestedBranchId) return String(requestedBranchId);
    if (scope.pinnedBranchId) return scope.pinnedBranchId;
    if (required) {
      throw scopeError('Choose which branch this belongs to. You have access to more than one, so the system will not guess.', 'BRANCH_REQUIRED');
    }
    return null;
  }
  const own = scope.pinnedBranchId;
  if (!requestedBranchId) return own;
  if (String(requestedBranchId) !== String(own)) {
    throw scopeError('You are signed in to one branch and cannot create records for another. Ask a general manager to do this, or sign in at the other branch.', 'BRANCH_SCOPE_VIOLATION');
  }
  return own;
}

/** Same rule on the business axis. */
function resolveMutationBusinessId(scope, requestedBusinessId, branchRow = null, { required = true } = {}) {
  if (!scope) throw scopeError('Not authenticated');
  // A branch's own business always wins: stock in the Ikeja electronics
  // shop belongs to the electronics business, whatever the caller asked for.
  if (branchRow && branchRow.business_id) return String(branchRow.business_id);
  if (scope.allBusinesses) {
    if (requestedBusinessId) return String(requestedBusinessId);
    if (scope.pinnedBusinessId) return scope.pinnedBusinessId;
    if (required) throw scopeError('Choose which business this belongs to.', 'BUSINESS_REQUIRED');
    return null;
  }
  const own = scope.pinnedBusinessId;
  if (!requestedBusinessId) return own;
  if (!scope.businessIds.has(String(requestedBusinessId))) {
    throw scopeError('You do not have access to that business.', 'BUSINESS_SCOPE_VIOLATION');
  }
  return String(requestedBusinessId);
}

// ---------------------------------------------------------------------
// MUTATION SCOPING — UPDATE / DELETE
// ---------------------------------------------------------------------
/**
 * Verify the caller may modify an EXISTING row.
 *
 * This function NEVER returns a branch_id to write. That is the whole
 * point: the row's branch is a fact about the row, and an update that
 * changes it is a transfer, which is a different operation with its own
 * audit trail (stock_transfers, pending_user_transfers). Reparenting by
 * accident is the bug this module exists to prevent.
 */
function assertRowAccess(scope, row, { entity = 'record' } = {}) {
  if (!scope) throw scopeError('Not authenticated');
  if (!row) throw scopeError(`${entity} not found`, 'NOT_FOUND', 404);
  if (String(scope.role) === ROLES.ADMIN) return { allowed: true, row };

  if (row.branch_id && !scope.allBranches && !scope.branchIds.has(String(row.branch_id))) {
    throw scopeError(
      `That ${entity} belongs to a different branch. You are signed in to one branch and cannot change another branch's records — this is what stops one shop's books being edited from another.`,
      'BRANCH_SCOPE_VIOLATION', 403,
    );
  }
  if (row.business_id && !scope.allBusinesses && !scope.businessIds.has(String(row.business_id))) {
    throw scopeError(`That ${entity} belongs to a different business you do not have access to.`, 'BUSINESS_SCOPE_VIOLATION', 403);
  }
  return { allowed: true, row };
}

/**
 * Guard specifically against a request body that tries to move a row to a
 * different branch. Called by every update route that accepts branch_id.
 */
function assertNoReparent(scope, existingRow, incomingBranchId, { entity = 'record' } = {}) {
  if (incomingBranchId == null) return;
  const current = existingRow && existingRow.branch_id ? String(existingRow.branch_id) : null;
  const requested = String(incomingBranchId);
  if (current && current !== requested) {
    if (String(scope.role) !== ROLES.ADMIN && String(scope.role) !== ROLES.OWNER) {
      throw scopeError(
        `That ${entity} belongs to another branch and cannot be moved to a different one by an update. Moving stock between branches is a TRANSFER, which keeps an audit trail on both sides; moving a customer or a sale would silently relocate a debt.`,
        'REPARENT_NOT_ALLOWED', 403,
      );
    }
  }
  assertRowAccess(scope, { branch_id: requested, business_id: existingRow && existingRow.business_id }, { entity });
}

// ---------------------------------------------------------------------
// BRANCH LISTING
// ---------------------------------------------------------------------
/** The set of branch ids a scope can act on, for validation and UI lists. */
function visibleBranchIds(scope, allBranches) {
  if (!scope) return [];
  if (scope.allBranches) return (allBranches || []).filter((b) => !b.is_deleted).map((b) => String(b.id));
  return Array.from(scope.branchIds || []);
}

function canAccessBranch(scope, branchId, allBranches = []) {
  if (!scope) return false;
  if (scope.allBranches) {
    if (!allBranches.length) return true;
    return allBranches.some((b) => String(b.id) === String(branchId) && !b.is_deleted);
  }
  return scope.branchIds.has(String(branchId));
}

function canAccessBusiness(scope, businessId) {
  if (!scope) return false;
  if (scope.allBusinesses) return true;
  return scope.businessIds.has(String(businessId));
}

/**
 * Can this user see another user's records? Same-rank peers are invisible to
 * each other for management purposes but visible in listings — the
 * distinction is between "can read" and "can manage", and roles.js owns the
 * latter.
 */
function canReadUser(scope, targetUser) {
  if (!scope || !targetUser) return false;
  if (String(scope.role) === ROLES.ADMIN) return true;
  if (String(targetUser.role) === ROLES.ADMIN) return false; // the vendor seat is hidden from the client
  if (rankOf(targetUser.role) > rankOf(scope.role)) return false;
  if (!scope.allBranches && targetUser.branch_id && !scope.branchIds.has(String(targetUser.branch_id))) return false;
  if (!scope.allBusinesses && targetUser.business_id && !scope.businessIds.has(String(targetUser.business_id))) return false;
  return true;
}

function scopeError(message, code = 'SCOPE_VIOLATION', status = 403) {
  return Object.assign(new Error(message), { status, code });
}

module.exports = {
  buildScope, branchFilter, businessFilter,
  canReadRow, canAccessBranch, canAccessBusiness, canReadUser, visibleBranchIds,
  resolveMutationBranchId, resolveMutationBusinessId,
  assertRowAccess, assertNoReparent, scopeError,
};
