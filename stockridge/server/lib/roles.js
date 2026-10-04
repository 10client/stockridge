// =====================================================================
// StockRidge — ROLES & AUTHORITY
// =====================================================================
// The role model is carried over from PharmaRidge essentially unchanged,
// because its audit found the failure modes are about the SEAMS between
// roles, not the roles themselves. Kept verbatim in principle:
//
//   ADMIN   vendor/platform seat. Not client staff. Never counted against
//           the staff limit, always bypasses the subscription gate (the
//           vendor can never be locked out of a client's instance), hidden
//           from the client's own Users screen.
//   OWNER   the proprietor. Full operational access + visibility of their
//           own plan usage and governance switches.
//   MANAGER one stored role, two job titles decided ENTIRELY by branch_id:
//             branch_id IS NULL -> General Manager (every branch)
//             branch_id IS SET  -> Branch Manager (exactly one branch)
//           DELIBERATELY NOT TWO ENUM VALUES. branch_id is already the
//           single source of truth for every authorisation decision; a
//           second fact encoding the same thing could disagree with the
//           first (a BRANCH_MANAGER with a NULL branch_id, or a MANAGER
//           pinned to a branch they were told they cannot see).
//   STAFF   cashier/salesperson/storekeeper. One branch. Handles cash all
//           day, so every allowance and audit view is designed around it.
//
// WHAT IS NEW: business_unit_id is now an OUTER scope above branch_id.
// Every authority question is answered in two steps — which business, then
// which branch — and a user who is OWNER of one unit must not thereby see
// another unit's cash. That cross-unit leak is the multi-business analogue
// of the cross-branch leak the original audit found, so it gets the same
// treatment: one function, called everywhere, tested adversarially.
// =====================================================================

const ROLES = Object.freeze(['ADMIN', 'OWNER', 'MANAGER', 'STAFF']);
const ROLE_RANK = Object.freeze({ ADMIN: 4, OWNER: 3, MANAGER: 2, STAFF: 1 });

function rankOf(role) { return ROLE_RANK[String(role || '').toUpperCase()] || 0; }
function isRole(r) { return ROLES.includes(String(r || '').toUpperCase()); }

// True when `actor` outranks `target`. Equal rank is NOT outranking —
// a manager may not edit a peer manager, because peers are exactly the
// people a collusion pattern needs to be able to modify.
function outranks(actorRole, targetRole) { return rankOf(actorRole) > rankOf(targetRole); }
function atLeast(role, minimum) { return rankOf(role) >= rankOf(minimum); }

// The job title is DERIVED, never stored. Storing it would create a second
// fact that can disagree with branch_id.
function jobTitleOf(user) {
  if (!user) return '';
  const role = String(user.role || '').toUpperCase();
  if (user.job_title) return user.job_title;
  switch (role) {
    case 'ADMIN': return 'Platform Administrator';
    case 'OWNER': return 'Business Owner';
    case 'MANAGER': return user.branch_id ? 'Branch Manager' : 'General Manager';
    case 'STAFF': return 'Sales / Counter Staff';
    default: return role;
  }
}

function managerKindOf(user) {
  if (!user || String(user.role).toUpperCase() !== 'MANAGER') return null;
  return user.branch_id ? 'BRANCH' : 'GENERAL';
}

// ---------------------------------------------------------------------
// BRANCH SCOPING — the single most load-bearing function in the product
// ---------------------------------------------------------------------
// Three distinct questions, three distinct answers, and conflating them is
// how the original cross-branch bugs happened:
//
//   resolveScopedBranchId(user, requested)
//     "Which branch may this user READ?" Returns the branch they are pinned
//     to, or the one they asked for if they are org-wide, or null for
//     "everything". Used to filter queries.
//
//   resolveMutationBranchId(user, requested, branchExists)
//     "Which branch will this row be WRITTEN into?" For a pinned user the
//     answer is ALWAYS their own branch, regardless of what the body says.
//     A body-supplied branch_id from a pinned user is not a request, it is
//     an attempted cross-branch write.
//
//   assertBranchAccess(user, branchId)
//     "May this user touch this specific branch at all?" Throws 403.
//
// The reason these are separate: applying the INSERT rule to an UPDATE
// REPARENTS a row that already belongs to another branch, because the
// incoming branch_id is simply replaced with the actor's own. That was
// reproduced live in the original audit — a Lagos device pushed a customer
// belonging to Minna, the push returned 200 "updated: 1", the customer was
// moved into Lagos, and their Minna debt stayed recorded against Minna
// while the customer appeared in the Lagos list. Updates must be scoped by
// the ROW's existing branch, never by the writer's.

function resolveScopedBranchId(user, requestedBranchId) {
  if (!user) return null;
  const role = String(user.role || '').toUpperCase();
  if (role === 'ADMIN') return requestedBranchId || null;       // vendor sees everything
  if (user.branch_id) return user.branch_id;                    // pinned: always their own
  if (role === 'OWNER') return requestedBranchId || null;
  if (role === 'MANAGER') return requestedBranchId || null;     // General Manager
  return user.branch_id || null;                                // STAFF must be pinned
}

function resolveMutationBranchId(user, requestedBranchId, { branchActive = true } = {}) {
  const role = String(user.role || '').toUpperCase();
  if (role === 'ADMIN') {
    if (!requestedBranchId) {
      const e = new Error('A branch must be specified for this operation.');
      e.status = 400; e.code = 'BRANCH_REQUIRED'; throw e;
    }
    return requestedBranchId;
  }
  if (user.branch_id) {
    // A pinned user writes into their own branch. If they named a DIFFERENT
    // one, that is not a silent correction — it is refused, because a
    // cashier at Ikeja naming a Lekki branch is either confused or
    // attacking, and guessing which is not the server's job.
    if (requestedBranchId && requestedBranchId !== user.branch_id) {
      const e = new Error('You can only record activity for your own branch. Ask a general manager if this belongs elsewhere.');
      e.status = 403; e.code = 'CROSS_BRANCH_WRITE'; throw e;
    }
    if (!branchActive) {
      const e = new Error('Your branch is not active, so new records cannot be created for it.');
      e.status = 403; e.code = 'BRANCH_INACTIVE'; throw e;
    }
    return user.branch_id;
  }
  if (!requestedBranchId) {
    const e = new Error('Choose which branch this belongs to.');
    e.status = 400; e.code = 'BRANCH_REQUIRED'; throw e;
  }
  return requestedBranchId;
}

function assertBranchAccess(user, branchId) {
  if (!branchId) return true;                                  // org-wide query
  const role = String(user.role || '').toUpperCase();
  if (role === 'ADMIN' || role === 'OWNER') return true;
  if (role === 'MANAGER' && !user.branch_id) return true;       // General Manager
  if (user.branch_id && user.branch_id === branchId) return true;
  const e = new Error('You do not have access to that branch.');
  e.status = 403; e.code = 'BRANCH_ACCESS_DENIED';
  throw e;
}

// Business-unit scope. ADMIN spans units; everyone else is confined to the
// units they hold access in.
function resolveScopedUnitId(user, requestedUnitId, accessibleUnitIds = []) {
  const role = String(user.role || '').toUpperCase();
  if (role === 'ADMIN') return requestedUnitId || null;
  if (requestedUnitId) {
    if (!accessibleUnitIds.includes(requestedUnitId)) {
      const e = new Error('You do not have access to that business.');
      e.status = 403; e.code = 'UNIT_ACCESS_DENIED'; throw e;
    }
    return requestedUnitId;
  }
  if (accessibleUnitIds.length === 1) return accessibleUnitIds[0];
  // Several units and none chosen: the caller must disambiguate rather than
  // silently defaulting to the first, which is how a report quietly shows
  // the wrong company.
  return null;
}

function assertUnitAccess(user, unitId, accessibleUnitIds) {
  if (String(user.role || '').toUpperCase() === 'ADMIN') return true;
  if (unitId && !accessibleUnitIds.includes(unitId)) {
    const e = new Error('You do not have access to that business.');
    e.status = 403; e.code = 'UNIT_ACCESS_DENIED'; throw e;
  }
  return true;
}

// ---------------------------------------------------------------------
// ROUTE GUARDS
// ---------------------------------------------------------------------
// Declarative guards so a route reads as a statement of policy. Every one
// of them is ALSO enforced in the service layer for anything money- or
// stock-moving: a guard that only lives on the route is one forgotten
// route away from being no guard at all.
const GUARDS = Object.freeze({
  any: { roles: ROLES },
  adminOnly: { roles: ['ADMIN'] },
  ownerOnly: { roles: ['ADMIN', 'OWNER'] },
  ownerOrManager: { roles: ['ADMIN', 'OWNER', 'MANAGER'] },
  managerUp: { roles: ['ADMIN', 'OWNER', 'MANAGER'] },
  staffUp: { roles: ROLES },
  finance: { roles: ['ADMIN', 'OWNER', 'MANAGER'] },
});

function assertRole(user, allowedRoles, { action = 'do that' } = {}) {
  if (!user) {
    const e = new Error('Sign in to continue.'); e.status = 401; e.code = 'UNAUTHENTICATED'; throw e;
  }
  if (!allowedRoles || !allowedRoles.includes(String(user.role || '').toUpperCase())) {
    const e = new Error(`Your role (${jobTitleOf(user)}) is not permitted to ${action}.`);
    e.status = 403; e.code = 'ROLE_FORBIDDEN';
    throw e;
  }
  return true;
}

module.exports = {
  ROLES, ROLE_RANK, GUARDS,
  rankOf, isRole, outranks, atLeast, jobTitleOf, managerKindOf,
  resolveScopedBranchId, resolveMutationBranchId, assertBranchAccess,
  resolveScopedUnitId, assertUnitAccess, assertRole,
};
