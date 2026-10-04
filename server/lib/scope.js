// =====================================================================
// server/lib/scope.js — TENANCY AND AUTHORITY (the module everything else asks)
// =====================================================================
//
// EVERY authorisation decision in StockRidge routes through this file. There is
// deliberately no second place where "can this user see that?" is answered,
// because two places means two answers, and the gap between them is the bug.
//
// ---------------------------------------------------------------------
// THE SCOPE MODEL
// ---------------------------------------------------------------------
//   ADMIN    the vendor/platform seat. Everything. Not client staff, not
//            counted against plan limits, always bypasses the subscription gate
//            (so the vendor can never be locked out of their own client's
//            instance), hidden from the client's Users screen.
//   OWNER    every business in the deployment. Plus their own subscription and
//            plan usage. Cannot touch platform-level admin functions.
//   MANAGER  branch_id IS NULL  -> every branch of their business (General Manager)
//            branch_id IS SET   -> exactly ONE branch (Branch Manager)
//   STAFF    exactly ONE branch, always.
//
// ONE STORED ROLE FOR BOTH MANAGER SHAPES, ON PURPOSE. branch_id is already the
// single source of truth for every authorisation decision here. A separate
// BRANCH_MANAGER enum value would be a SECOND fact encoding the same thing, and
// the two could then disagree: a BRANCH_MANAGER row with a NULL branch_id, or a
// MANAGER pinned to a branch whom some code path treated as org-wide because it
// only checked the role. One fact, one place, no possible disagreement.
//
// ---------------------------------------------------------------------
// THE BUG THIS MODULE EXISTS TO PREVENT
// ---------------------------------------------------------------------
// Reproduced end-to-end against a live system during the pre-launch audit of
// the pharmacy product, and the reason `forceBranchScope` below behaves
// differently for INSERT and UPDATE:
//
//   A generic sync upsert forced `branch_id` to the pusher's own branch. That is
//   correct for an INSERT — a device may only create records in its own branch.
//   Applied to an UPDATE it does something quite different: it REPARENTS a row
//   that already belongs to another branch, because the incoming branch_id
//   simply replaces the stored one.
//
//   Live result: a Lagos device pushed a customer id belonging to MINNA. The
//   push returned 200 "updated: 1". The customer's name and phone were
//   overwritten with the Lagos device's values and the row was MOVED into Lagos.
//   Worse, that customer owed Minna ₦110: after the push the DEBT stayed
//   recorded against Minna while the CUSTOMER appeared in the Lagos list,
//   visible to a Lagos cashier who could read their balance. One branch's debtor
//   silently became another branch's customer.
//
// So:
//   * INSERT  — branch_id is FORCED to the caller's scope; a supplied value that
//               disagrees is REJECTED, not silently rewritten.
//   * UPDATE  — the row's EXISTING branch is checked against the caller's scope
//               FIRST. If it is not in scope, the write is refused. branch_id may
//               never be changed by a generic update at all: reparenting is an
//               explicit, logged, separately-authorised transfer operation,
//               because it moves money and stock between books.

'use strict';

const V = require('../../shared/lib/validate');

const ROLES = Object.freeze(['ADMIN', 'OWNER', 'MANAGER', 'STAFF']);
const ROLE_RANK = Object.freeze({ ADMIN: 4, OWNER: 3, MANAGER: 2, STAFF: 1 });

function rank(role) { return ROLE_RANK[String(role || '').toUpperCase()] || 0; }
function outranks(a, b) { return rank(a) > rank(b); }

class ForbiddenError extends Error {
  constructor(message, { code = 'FORBIDDEN', status = 403 } = {}) {
    super(message);
    this.name = 'ForbiddenError';
    this.status = status;
    this.code = code;
  }
}

function forbidden(message, code) { throw new ForbiddenError(message, { code: code || 'FORBIDDEN' }); }

// ---------------------------------------------------------------------
// the scope object
// ---------------------------------------------------------------------
/**
 * Build the scope descriptor for a signed-in user.
 *
 * Everything downstream reads THIS object rather than re-deriving from the user
 * row, so there is exactly one interpretation of "what can they see".
 *
 * @returns {{
 *   userId:string, role:string, rank:number,
 *   allBusinesses:boolean, businessId:string|null, businessIds:string[]|null,
 *   allBranches:boolean, branchId:string|null, branchIds:string[]|null,
 *   pinned:boolean, isVendor:boolean
 * }}
 */
function scopeOf(user, { knownBusinessIds = null, knownBranchIds = null } = {}) {
  const role = String((user && user.role) || '').toUpperCase();
  const businessId = user && user.business_id ? String(user.business_id) : null;
  const branchId = user && user.branch_id ? String(user.branch_id) : null;

  const isAdmin = role === 'ADMIN';
  const isOwner = role === 'OWNER';
  const allBusinesses = isAdmin || (isOwner && !businessId);
  const allBranches = isAdmin || isOwner || (role === 'MANAGER' && !branchId);

  return {
    userId: user ? String(user.id) : null,
    username: user ? user.username : null,
    fullName: user ? user.full_name : null,
    role,
    rank: rank(role),
    isVendor: isAdmin,
    // BUSINESS SCOPE
    allBusinesses,
    businessId: allBusinesses ? null : businessId,
    businessIds: allBusinesses ? (knownBusinessIds ? [...knownBusinessIds] : null) : (businessId ? [businessId] : []),
    // BRANCH SCOPE
    allBranches,
    branchId: allBranches ? null : branchId,
    branchIds: allBranches ? (knownBranchIds ? [...knownBranchIds] : null) : (branchId ? [branchId] : []),
    // `pinned` is the single boolean the rest of the app uses to decide whether
    // a branch switcher is shown, whether cross-branch reports are allowed, and
    // whether a transfer needs approval from the other side.
    pinned: !allBranches,
  };
}

/**
 * Load a user and build their scope, resolving the id lists from the database.
 * The id lists are needed to build SQL `IN (...)` clauses; resolving them once
 * here means no route has to decide for itself which branches are in scope.
 */
async function loadScope(db, user) {
  const businesses = user.role === 'ADMIN'
    ? await db.prepare('SELECT id FROM businesses WHERE is_deleted = 0').all()
    : user.role === 'OWNER' && !user.business_id
      ? await db.prepare('SELECT id FROM businesses WHERE is_deleted = 0').all()
      : await db.prepare('SELECT id FROM businesses WHERE id = ? AND is_deleted = 0').bind(user.business_id || '__none__').all();

  let branches;
  if (user.role === 'ADMIN' || (user.role === 'OWNER' && !user.business_id)) {
    branches = await db.prepare('SELECT id FROM branches WHERE is_deleted = 0').all();
  } else if (user.branch_id) {
    branches = await db.prepare('SELECT id FROM branches WHERE id = ? AND is_deleted = 0').bind(user.branch_id).all();
  } else {
    branches = await db.prepare(
      'SELECT id FROM branches WHERE business_id = ? AND is_deleted = 0'
    ).bind(user.business_id || '__none__').all();
  }

  return scopeOf(user, {
    knownBusinessIds: businesses.map((b) => b.id),
    knownBranchIds: branches.map((b) => b.id),
  });
}

// ---------------------------------------------------------------------
// ACCESS CHECKS
// ---------------------------------------------------------------------
function canAccessBusiness(scope, businessId) {
  if (!businessId) return scope.allBusinesses;
  if (scope.allBusinesses) return true;
  return scope.businessId === String(businessId)
    || (Array.isArray(scope.businessIds) && scope.businessIds.includes(String(businessId)));
}

function canAccessBranch(scope, branchId) {
  if (!branchId) return scope.allBranches;
  if (scope.allBranches) {
    // An org-wide manager may still be limited to ONE BUSINESS. A branch of
    // another business is out of scope even though the user is not pinned to a
    // branch. That check happens in assertBranchAccess, which loads the branch.
    return true;
  }
  return scope.branchId === String(branchId)
    || (Array.isArray(scope.branchIds) && scope.branchIds.includes(String(branchId)));
}

/**
 * Assert access to a branch, resolving it from the database so the BUSINESS
 * boundary is enforced too.
 *
 * Returns the branch row, because almost every caller needs it immediately
 * afterwards and a second query for the same row is a second chance to forget
 * the check.
 */
async function assertBranchAccess(db, scope, branchId, { action = 'access' } = {}) {
  if (!branchId) forbidden(`A branch is required to ${action} this.`, 'BRANCH_REQUIRED');
  const branch = await db.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0').bind(String(branchId)).first();
  if (!branch) forbidden(`Branch not found.`, 'BRANCH_NOT_FOUND');

  if (!scope.allBusinesses && String(branch.business_id) !== String(scope.businessId)) {
    // Deliberately the SAME message as "not found". Telling a Branch Manager of
    // Business A that a branch of Business B exists but is forbidden leaks the
    // existence and identity of another tenant's locations, which is exactly the
    // cross-tenant disclosure this module is here to prevent.
    forbidden('Branch not found.', 'BRANCH_NOT_FOUND');
  }
  if (!scope.allBranches && String(scope.branchId) !== String(branch.id)) {
    forbidden(
      `You are signed in to one branch only, so you cannot ${action} another branch's records.`,
      'BRANCH_OUT_OF_SCOPE'
    );
  }
  return branch;
}

async function assertBusinessAccess(db, scope, businessId, { action = 'access' } = {}) {
  if (!businessId) forbidden(`A business is required to ${action} this.`, 'BUSINESS_REQUIRED');
  const business = await db.prepare('SELECT * FROM businesses WHERE id = ? AND is_deleted = 0').bind(String(businessId)).first();
  if (!business) forbidden('Business not found.', 'BUSINESS_NOT_FOUND');
  if (!canAccessBusiness(scope, business.id)) {
    // Same reasoning as above: do not confirm the existence of another tenant.
    forbidden('Business not found.', 'BUSINESS_NOT_FOUND');
  }
  return business;
}

/** Assert a minimum role. ADMIN and OWNER pass a MANAGER gate. */
function assertRole(scope, minimum, { action = 'do this' } = {}) {
  if (rank(scope.role) < rank(minimum)) {
    forbidden(
      `Only a ${minimum.toLowerCase()} or above can ${action}.`,
      `ROLE_REQUIRED_${minimum}`
    );
  }
  return true;
}

// ---------------------------------------------------------------------
// THE BRANCH A USER'S WRITE SHOULD LAND IN
// ---------------------------------------------------------------------
/**
 * Which branch does a mutation by this user belong to?
 *
 *   pinned user      -> their own branch, always. A value that disagrees is
 *                       REJECTED rather than silently rewritten, because
 *                       silently rewriting means a bug in the caller is hidden
 *                       and the record lands somewhere nobody expected.
 *   org-wide user    -> the branch they asked for (validated to exist and to be
 *                       inside their business scope), because a General Manager
 *                       legitimately records a sale "on behalf of" Kano.
 */
function resolveMutationBranchId(scope, requestedBranchId) {
  if (scope.pinned) {
    if (requestedBranchId && String(requestedBranchId) !== String(scope.branchId)) {
      forbidden(
        'You are signed in to one branch, so this record can only be created in that branch. '
        + 'If it belongs elsewhere, someone signed in there must enter it.',
        'BRANCH_MISMATCH'
      );
    }
    return scope.branchId;
  }
  if (!requestedBranchId) {
    forbidden('Choose which branch this belongs to.', 'BRANCH_REQUIRED');
  }
  return String(requestedBranchId);
}

/**
 * Force the branch scope onto a row being WRITTEN.
 *
 * THE INSERT/UPDATE ASYMMETRY IS THE WHOLE POINT — see the header comment for
 * the live reproduction. Callers MUST pass `existingRow` when updating.
 *
 * @param {object} scope
 * @param {object} payload      the fields about to be written
 * @param {object} [options]
 * @param {object} [options.existingRow]  the row as it currently stands (UPDATE)
 * @param {boolean} [options.allowReparent] explicit, logged, separately
 *                authorised transfers only. Defaults to false.
 */
function forceBranchScope(scope, payload, { existingRow = null, allowReparent = false, field = 'branch_id' } = {}) {
  const out = { ...(payload || {}) };
  const incoming = out[field] != null ? String(out[field]) : null;

  if (existingRow) {
    // ---- UPDATE -------------------------------------------------------
    const current = existingRow[field] != null ? String(existingRow[field]) : null;

    // 1. Is the row we are about to change even ours to change?
    if (current && !canAccessBranch(scope, current)) {
      forbidden(
        'That record belongs to another branch, so it cannot be changed from here.',
        'ROW_OUT_OF_SCOPE'
      );
    }
    // 2. Reparenting is never implicit.
    if (incoming && current && incoming !== current) {
      if (!allowReparent) {
        forbidden(
          `This update would move the record from one branch to another. Moving stock or a customer `
          + `between branches is a transfer, not an edit — it changes which book the money is in.`,
          'REPARENT_NOT_ALLOWED'
        );
      }
      if (scope.pinned) {
        forbidden('A user signed in to one branch cannot move records between branches.', 'REPARENT_NOT_ALLOWED');
      }
    }
    // 3. Preserve the existing branch (unless explicitly reparented).
    out[field] = (allowReparent && incoming) ? incoming : (current != null ? current : (scope.pinned ? scope.branchId : incoming));
    return out;
  }

  // ---- INSERT ---------------------------------------------------------
  if (scope.pinned) {
    if (incoming && incoming !== String(scope.branchId)) {
      forbidden(
        'You are signed in to one branch, so this record can only be created in that branch.',
        'BRANCH_MISMATCH'
      );
    }
    out[field] = scope.branchId;
    return out;
  }
  if (!incoming) {
    // An org-wide user must say where. Defaulting to "the first branch" would
    // put a Kano sale in the Lagos book, which is the same class of error the
    // UPDATE path guards against.
    forbidden('Choose which branch this record belongs to.', 'BRANCH_REQUIRED');
  }
  out[field] = incoming;
  return out;
}

// ---------------------------------------------------------------------
// SQL HELPERS  (build the WHERE clause once, correctly, everywhere)
// ---------------------------------------------------------------------
/**
 * A SQL fragment plus its bind values restricting a query to the caller's
 * branches.
 *
 * Returns { sql: '', params: [] } for an unrestricted user so callers can
 * concatenate unconditionally instead of branching on role — a branch on role in
 * every query is a branch that will eventually be written incorrectly in one of
 * them.
 *
 * @param {string} column  e.g. 'branch_id' or 's.branch_id'
 */
function branchFilter(scope, column = 'branch_id') {
  if (scope.allBranches && !scope.businessId) return { sql: '', params: [] };
  if (scope.allBranches && scope.businessId) {
    // Org-wide inside ONE business: filter by business, not by branch, so a
    // branch created tomorrow is automatically in scope.
    return { sql: ` AND ${column} IN (SELECT id FROM branches WHERE business_id = ? AND is_deleted = 0)`, params: [scope.businessId] };
  }
  const ids = scope.branchIds && scope.branchIds.length ? scope.branchIds : [scope.branchId].filter(Boolean);
  if (!ids.length) return { sql: ' AND 1 = 0', params: [] };   // no branches in scope: see nothing
  return { sql: ` AND ${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** Same, for a table keyed by business_id rather than branch_id. */
function businessFilter(scope, column = 'business_id') {
  if (scope.allBusinesses) return { sql: '', params: [] };
  const ids = scope.businessIds && scope.businessIds.length ? scope.businessIds : [scope.businessId].filter(Boolean);
  if (!ids.length) return { sql: ' AND 1 = 0', params: [] };
  return { sql: ` AND ${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/**
 * The list of branch ids to constrain a report to, honouring an explicit
 * `?branch_id=` filter ONLY if it is inside the caller's scope.
 *
 * An out-of-scope branch_id is REFUSED rather than ignored. Ignoring it would
 * return the caller's own data while they believe they are looking at someone
 * else's, which is a report that lies about what it is showing.
 */
function resolveReportBranches(scope, requestedBranchId) {
  if (!requestedBranchId || requestedBranchId === 'ALL') {
    return { branchIds: scope.branchIds, unrestricted: scope.allBranches && !scope.businessId, businessId: scope.businessId };
  }
  const want = String(requestedBranchId);
  if (!canAccessBranch(scope, want)) {
    forbidden('That branch is not in your scope, so its report cannot be shown.', 'BRANCH_OUT_OF_SCOPE');
  }
  return { branchIds: [want], unrestricted: false, businessId: scope.businessId };
}

// ---------------------------------------------------------------------
// PERMISSIONS DRIVEN BY OWNER-SET SWITCHES
// ---------------------------------------------------------------------
/**
 * Assert one of the OWNER-controlled MANAGER permissions.
 *
 * OWNER and ADMIN are never restricted by these: a switch that could lock the
 * proprietor out of their own books would be a footgun. Fail-open defaults match
 * the migration's DEFAULT 1, so a missing settings row never silently strips
 * managers of authority mid-shift.
 */
async function assertManagerPermission(db, scope, permission, { action = 'do this' } = {}) {
  if (scope.rank >= rank('OWNER')) return true;
  const settings = await db.prepare('SELECT * FROM client_settings WHERE id = 1').first();
  const value = settings && settings[permission] != null ? Number(settings[permission]) : 1;
  if (value !== 1) {
    forbidden(
      `The owner has disabled "${permission.replace(/_/g, ' ')}" for managers, so you cannot ${action}. `
      + 'Ask the owner to enable it in My Plan → Manager permissions.',
      'MANAGER_PERMISSION_DISABLED'
    );
  }
  return true;
}

/**
 * May a STAFF member void this sale?
 *
 * NOT A FLAT BAN, and not a free hand either. A mis-keyed sale at a busy counter
 * is common and a lone cashier on a late shift must be able to correct it, so
 * the allowance is NARROW: their OWN sale, within a time window, while the till
 * is still open. The window and the ownership rule are what make it safe — they
 * cover "I just rang that up wrong" without covering "I am reversing yesterday's
 * takings".
 */
async function assertStaffCanVoid(db, scope, sale, settings = null) {
  if (scope.rank >= rank('MANAGER')) {
    await assertManagerPermission(db, scope, 'managers_can_void_sales', { action: 'void a sale' });
    return { allowed: true, requiresApproval: false, reason: 'manager' };
  }
  const s = settings || await db.prepare('SELECT * FROM client_settings WHERE id = 1').first();
  if (!s || !Number(s.staff_can_void_sales)) {
    forbidden('A manager must approve this void. Cashier voids are disabled by the owner.', 'VOID_NOT_PERMITTED');
  }
  if (String(sale.sold_by) !== String(scope.userId)) {
    forbidden(
      'You may only void a sale you rang up yourself. Ask the cashier who made it, or a manager.',
      'VOID_NOT_OWN_SALE'
    );
  }
  const windowMinutes = Math.max(0, Number(s.staff_void_window_minutes) || 0);
  const ageMs = Date.now() - Date.parse(`${String(sale.created_at).replace(' ', 'T')}Z`);
  if (windowMinutes > 0 && ageMs > windowMinutes * 60000) {
    forbidden(
      `A cashier may only void within ${windowMinutes} minute(s) of the sale. This one is older — a manager must void it.`,
      'VOID_WINDOW_EXPIRED'
    );
  }
  if (sale.till_session_id) {
    const till = await db.prepare('SELECT status FROM till_sessions WHERE id = ?').bind(sale.till_session_id).first();
    if (till && till.status !== 'OPEN') {
      forbidden('The till this sale was rung on has been closed. A manager must void it.', 'VOID_TILL_CLOSED');
    }
  }
  return { allowed: true, requiresApproval: false, reason: 'own_sale_within_window' };
}

/**
 * May a STAFF member post a stock adjustment of this size?
 *
 * COUNTING a stocktake stays open to cashiers — walking the shelves is exactly
 * their job, and requiring a manager to hold the clipboard would make the
 * feature unusable. It is COMMITTING the variance that moves stock, so the cap
 * applies to the largest variance about to be posted. A count that matches the
 * system (or is off by a unit or two) closes normally; anything bigger needs a
 * manager, who can then close the very same session with the counts already
 * recorded.
 */
async function assertStaffCanAdjust(db, scope, largestVarianceUnits, settings = null) {
  if (scope.rank >= rank('MANAGER')) return { allowed: true, requiresApproval: false };
  const s = settings || await db.prepare('SELECT * FROM client_settings WHERE id = 1').first();
  if (!s || !Number(s.staff_can_adjust_stock)) {
    forbidden('A manager must approve this stock adjustment. Cashier adjustments are disabled by the owner.', 'ADJUST_NOT_PERMITTED');
  }
  const cap = Math.max(0, Number(s.staff_adjustment_max_units) || 0);
  const size = Math.abs(Number(largestVarianceUnits) || 0);
  if (cap > 0 && size > cap) {
    forbidden(
      `A cashier may adjust at most ${cap} unit(s) at a time; this variance is ${size}. `
      + 'A manager must commit it.',
      'ADJUSTMENT_OVER_CAP'
    );
  }
  return { allowed: true, requiresApproval: false, cap };
}

/** May a STAFF member spend this much from the branch safe? */
async function assertStaffCanSpendFromSafe(db, scope, amount, settings = null) {
  if (scope.rank >= rank('MANAGER')) return { allowed: true };
  const s = settings || await db.prepare('SELECT * FROM client_settings WHERE id = 1').first();
  if (!s || !Number(s.staff_can_spend_from_safe)) {
    forbidden('A manager must approve spending from the safe.', 'SAFE_SPEND_NOT_PERMITTED');
  }
  // 0 means NO CAP — a deliberate client request. It is read as unlimited,
  // never as "zero allowed": the can/cannot decision is the boolean above.
  const cap = Number(s.staff_safe_spend_max);
  if (cap > 0 && Number(amount) > cap) {
    forbidden(
      `A cashier may draw at most ${cap.toLocaleString('en-NG')} from the safe in one purchase; this is ${Number(amount).toLocaleString('en-NG')}.`,
      'SAFE_SPEND_OVER_CAP'
    );
  }
  return { allowed: true, cap: cap > 0 ? cap : null };
}

/**
 * May this user apply a discount of this size?
 * The staff cap is a percentage; the global cap applies to everyone below OWNER.
 */
async function assertDiscountAuthority(db, scope, discountPercent, settings = null) {
  const s = settings || await db.prepare('SELECT * FROM client_settings WHERE id = 1').first();
  const pct = Number(discountPercent) || 0;
  if (pct <= 0) return { allowed: true, requiresApproval: false };

  const globalMax = s && s.max_discount_percent != null ? Number(s.max_discount_percent) : 25;
  if (scope.rank >= rank('OWNER')) return { allowed: true, requiresApproval: false };

  if (scope.rank === rank('STAFF')) {
    const staffMax = s && s.staff_max_discount_percent != null ? Number(s.staff_max_discount_percent) : 5;
    if (pct > staffMax) {
      return { allowed: false, requiresApproval: true, code: 'DISCOUNT_NEEDS_MANAGER',
        message: `A cashier may discount up to ${staffMax}%. This is ${pct}% — a manager must approve it.` };
    }
  }
  if (pct > globalMax) {
    return { allowed: scope.rank >= rank('OWNER'), requiresApproval: true, code: 'DISCOUNT_OVER_GLOBAL_LIMIT',
      message: `${pct}% exceeds the ${globalMax}% maximum discount. Only the owner can approve it.` };
  }
  return { allowed: true, requiresApproval: false };
}

// ---------------------------------------------------------------------
// ENTITY-LEVEL AUTHORITY  (who may modify whom)
// ---------------------------------------------------------------------
/**
 * May `actor` modify `target`?
 *
 * Mirrors the role ladder with two rules that matter commercially:
 *   * nobody may modify a PEER at their own rank — a Branch Manager editing
 *     another Branch Manager, or resetting their PIN, is a peer account
 *     takeover.
 *   * ADMIN is the vendor seat and is invisible to client staff: a client OWNER
 *     cannot disable, re-PIN or read the vendor's own account.
 */
function assertCanModifyUser(actorScope, target) {
  const targetRole = String((target && target.role) || '').toUpperCase();
  if (!target) forbidden('That user does not exist.', 'USER_NOT_FOUND');

  if (targetRole === 'ADMIN' && !actorScope.isVendor) {
    // Do not even confirm the account exists.
    forbidden('That user does not exist.', 'USER_NOT_FOUND');
  }
  if (actorScope.isVendor) return true;   // the vendor seat manages everything
  if (rank(actorScope.role) <= rank(targetRole)) {
    forbidden(
      `You cannot modify a ${targetRole.toLowerCase()} account. Only someone more senior can.`,
      'CANNOT_MODIFY_PEER_OR_SENIOR'
    );
  }
  // A pinned Branch Manager may only modify staff of their OWN branch.
  if (actorScope.pinned && target.branch_id && String(target.branch_id) !== String(actorScope.branchId)) {
    forbidden('That user belongs to another branch.', 'USER_OUT_OF_SCOPE');
  }
  if (actorScope.businessId && target.business_id && String(target.business_id) !== String(actorScope.businessId)) {
    forbidden('That user does not exist.', 'USER_NOT_FOUND');
  }
  return true;
}

/** May this user create a user with the given role and branch? */
function assertCanCreateUser(actorScope, { role, branchId, businessId }) {
  const newRole = String(role || '').toUpperCase();
  if (!ROLES.includes(newRole)) V.fail(`Role must be one of: ${ROLES.join(', ')}`, 'INVALID_ROLE', 'role');
  if (newRole === 'ADMIN') {
    if (!actorScope.isVendor) forbidden('Only the platform administrator can create an ADMIN seat.', 'CANNOT_CREATE_ADMIN');
    return true;
  }
  if (actorScope.isVendor) return true;
  if (rank(actorScope.role) <= rank(newRole)) {
    forbidden(`You cannot create a ${newRole.toLowerCase()} account — that would be creating a peer or a superior.`, 'CANNOT_CREATE_ROLE');
  }
  if (newRole === 'STAFF' || newRole === 'MANAGER') {
    if (!branchId && newRole === 'STAFF') V.fail('A staff member must be assigned to a branch.', 'BRANCH_REQUIRED', 'branch_id');
    if (branchId && !canAccessBranch(actorScope, branchId)) forbidden('That branch is not in your scope.', 'BRANCH_OUT_OF_SCOPE');
  }
  if (businessId && !canAccessBusiness(actorScope, businessId)) forbidden('That business is not in your scope.', 'BUSINESS_OUT_OF_SCOPE');
  return true;
}

/** The job title shown for a MANAGER, decided entirely by branch_id. */
function managerJobTitle(user) {
  return user && user.branch_id ? 'Branch Manager' : 'General Manager';
}

function displayRole(user) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === 'MANAGER') return managerJobTitle(user);
  if (role === 'OWNER') return 'Owner';
  if (role === 'ADMIN') return 'Platform Administrator';
  return (user && user.job_title) || 'Staff';
}

module.exports = {
  ROLES, ROLE_RANK, rank, outranks,
  ForbiddenError, forbidden,
  scopeOf, loadScope,
  canAccessBusiness, canAccessBranch,
  assertBranchAccess, assertBusinessAccess, assertRole,
  resolveMutationBranchId, forceBranchScope,
  branchFilter, businessFilter, resolveReportBranches,
  assertManagerPermission, assertStaffCanVoid, assertStaffCanAdjust,
  assertStaffCanSpendFromSafe, assertDiscountAuthority,
  assertCanModifyUser, assertCanCreateUser,
  managerJobTitle, displayRole,
};
'use strict';
