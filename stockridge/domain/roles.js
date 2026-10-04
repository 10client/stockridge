// =====================================================================
// StockRidge — ROLES, AUTHORITY & BRANCH SCOPING
// =====================================================================
// Reconstructed from PharmaRidge's role model, which was hard-won: the
// header of its schema records that a BRANCH_MANAGER role was deliberately
// NOT added because branch_id was already the single source of truth, and
// a second fact encoding the same thing is a fact that can disagree with
// the first. That reasoning carries over intact.
//
// THE ROLE HIERARCHY (highest to lowest privilege)
// ------------------------------------------------
//   ADMIN   The platform vendor's support seat. One deployment-wide seat
//           (the people who SOLD the software), NOT part of the client's
//           own staff. Sets plan limits, feature toggles, subscription
//           status and white-label branding. Never counted against the
//           client's staff cap, always bypasses the subscription gate (so
//           the vendor can never be locked out of their own client's
//           instance), and is hidden from the client's own Users screen.
//
//   OWNER   The proprietor. Full operational access identical to MANAGER,
//           PLUS visibility of their own subscription/plan usage and
//           PLUS sole authority over the governance switches (what their
//           managers and cashiers may do). Distinct from MANAGER so a
//           client can employ day-to-day managers without handing the
//           commercial relationship to them.
//
//   MANAGER One stored role, two job titles, decided ENTIRELY by whether
//           the account carries a branch_id:
//             General Manager  branch_id IS NULL — every branch
//             Branch Manager   branch_id IS SET  — exactly one branch, and
//                              cannot see any other branch's cash, stock,
//                              staff or reports
//
//   STAFF   A cashier / storekeeper / sales rep, always pinned to one
//           branch. Handles cash all day, so the narrow-allowance model
//           below governs everything destructive they can do.
//
// ---------------------------------------------------------------------
// THE NARROW-ALLOWANCE PRINCIPLE
// ---------------------------------------------------------------------
// A cashier holding both void and write-off powers can run the two classic
// retail-theft patterns unaided:
//   VOID      — sell for cash, void the sale, keep the note. The books show
//               no sale; the stock is already gone.
//   WRITE-OFF — take the goods, record them as DAMAGE. Shrinkage looks like
//               breakage.
// Both were reproducible on PharmaRidge before gates existed.
//
// But a flat ban is wrong too: a mis-keyed sale at a busy counter is
// common, and a lone cashier on a night shift must be able to correct it
// without phoning the owner. So each destructive power is a NARROW,
// OWNER-SET ALLOWANCE bounded by a window and a cap:
//   staff_can_void_sales + staff_void_window_minutes
//   staff_can_adjust_stock + staff_adjustment_max_units
//   staff_can_spend_from_safe + staff_safe_spend_max
// The window and the cap cover "I just rang that up wrong" and "I dropped
// a screen" without covering "I am reversing yesterday's takings" or "a
// whole pallet went missing".
//
// Pure data + pure predicates. Both backends import this one file, so the
// Node and Workers authority matrices cannot drift apart.
// =====================================================================

const ROLES = Object.freeze(['ADMIN', 'OWNER', 'MANAGER', 'STAFF']);

// Numeric rank for "outranks" comparisons. Higher = more authority.
const ROLE_RANK = Object.freeze({ ADMIN: 40, OWNER: 30, MANAGER: 20, STAFF: 10 });

const JOB_TITLES = Object.freeze({
  ADMIN: 'Platform Administrator',
  OWNER: 'Owner / Proprietor',
  MANAGER_GENERAL: 'General Manager',
  MANAGER_BRANCH: 'Branch Manager',
  STAFF: 'Sales / Store Staff',
});

function isRole(r) {
  return ROLES.includes(r);
}

function rankOf(role) {
  return ROLE_RANK[role] || 0;
}

function outranks(a, b) {
  return rankOf(a) > rankOf(b);
}

// The two-titles-one-role resolution. branch_id is the ONLY input; there is
// no second stored fact to disagree with it.
function jobTitleOf(user) {
  if (!user) return '';
  if (user.job_title) return user.job_title;
  if (user.role === 'MANAGER') return user.branch_id ? JOB_TITLES.MANAGER_BRANCH : JOB_TITLES.MANAGER_GENERAL;
  return JOB_TITLES[user.role] || '';
}

function isGeneralManager(user) {
  return Boolean(user) && user.role === 'MANAGER' && !user.branch_id;
}

function isBranchManager(user) {
  return Boolean(user) && user.role === 'MANAGER' && Boolean(user.branch_id);
}

function isClientStaff(user) {
  // ADMIN is the vendor's seat, never part of the client's own headcount.
  return Boolean(user) && user.role !== 'ADMIN';
}

// ---------------------------------------------------------------------
// BRANCH SCOPING
// ---------------------------------------------------------------------
// Three distinct questions, three distinct functions. Collapsing them is
// how a Branch Manager ends up able to read a sibling branch's till, or how
// an offline device ends up able to REPARENT another branch's customer
// record (a real cross-branch data-corruption bug found on PharmaRidge's
// sync push).

// 1. Which branch is this user PINNED to, if any? null = org-wide.
function pinnedBranchIdOf(user) {
  if (!user) return null;
  if (user.role === 'STAFF') return user.branch_id || null;
  if (isBranchManager(user)) return user.branch_id;
  return null; // ADMIN, OWNER, General Manager see everything
}

// 2. For a READ: which branch does the request resolve to?
//    A pinned user always resolves to their own branch and any branch_id
//    they supplied is IGNORED (not rejected — a client that sends its own
//    branch id on every request should not error). An org-wide user may
//    select any branch, or null for "all branches (total)".
function resolveScopedBranchId(user, requestedBranchId) {
  const pinned = pinnedBranchIdOf(user);
  if (pinned) return pinned;
  return requestedBranchId || null;
}

// 3. For a WRITE: which branch will the new row belong to?
//    A pinned user may ONLY create rows in their own branch. Force-scoping
//    here is correct for INSERT.
function resolveMutationBranchId(user, requestedBranchId) {
  const pinned = pinnedBranchIdOf(user);
  if (pinned) return pinned;
  if (!requestedBranchId) {
    throw Object.assign(new Error('Choose which branch this record belongs to.'), {
      status: 400, code: 'BRANCH_REQUIRED',
    });
  }
  return requestedBranchId;
}

// 4. May this user touch a row that already belongs to `rowBranchId`?
//    Used on UPDATE/DELETE, where force-scoping would be WRONG: replacing
//    the incoming branch_id with the pusher's own silently reparents a row
//    that belongs to another branch, and any money attached to it stays
//    recorded against the original branch while the record itself moves.
function assertBranchAccess(user, rowBranchId) {
  const pinned = pinnedBranchIdOf(user);
  if (!pinned) return { ok: true };
  if (rowBranchId && String(rowBranchId) === String(pinned)) return { ok: true };
  return {
    ok: false,
    status: 403,
    code: 'BRANCH_SCOPE_DENIED',
    error: `This record belongs to another branch. As a ${jobTitleOf(user)} you can only work with your own branch's records.`,
  };
}

// Is this user allowed to see ALL branches at once (the "All Branches
// (Total)" switcher on the dashboard)?
function canViewAllBranches(user) {
  return pinnedBranchIdOf(user) === null;
}

// ---------------------------------------------------------------------
// CAPABILITY MATRIX
// ---------------------------------------------------------------------
// Every mutating capability in the app has exactly one entry here. Routes
// call can(user, capability) rather than hand-rolling `role === 'X'`
// checks, so a permission change is a one-line edit and a missed check is
// impossible to write by accident.
//
// 'OWNER+' means OWNER or ADMIN. 'MANAGER+' means MANAGER, OWNER or ADMIN.
// Capabilities marked STAFF are additionally gated by the narrow
// allowances in client_settings — see assertStaffMayVoid() etc. below.
const CAPABILITIES = Object.freeze({
  // --- read scopes ---------------------------------------------------
  'read.ownBranch': { min: 'STAFF' },
  'read.allBranches': { min: 'MANAGER', requiresOrgWide: true },
  'read.reports': { min: 'MANAGER' },
  'read.financials': { min: 'MANAGER' },
  'read.gl': { min: 'MANAGER' },
  'read.auditLog': { min: 'MANAGER' },
  'read.planUsage': { min: 'OWNER' },
  'read.vendorAdmin': { min: 'ADMIN' },

  // --- POS / trading --------------------------------------------------
  'pos.sell': { min: 'STAFF' },
  'pos.applyDiscount': { min: 'STAFF' },
  'pos.overridePrice': { min: 'MANAGER' },
  'pos.voidSale': { min: 'STAFF', allowance: 'staff_can_void_sales' },
  'pos.sellOnCredit': { min: 'MANAGER' },
  'pos.refund': { min: 'MANAGER' },
  'pos.openPrice': { min: 'MANAGER' },
  'pos.negativeStock': { min: 'MANAGER' },

  // --- stock ----------------------------------------------------------
  'stock.receive': { min: 'STAFF' },
  'stock.adjust': { min: 'STAFF', allowance: 'staff_can_adjust_stock' },
  'stock.transferRequest': { min: 'STAFF' },
  'stock.transferApprove': { min: 'MANAGER' },
  'stock.stocktakeCount': { min: 'STAFF' },   // walking the shelves IS their job
  'stock.stocktakeCommit': { min: 'STAFF', varianceGate: true }, // gated by variance size, not by role alone
  'stock.serialAssign': { min: 'STAFF' },

  // --- catalogue / pricing -------------------------------------------
  'catalog.createProduct': { min: 'MANAGER' },
  'catalog.editProduct': { min: 'MANAGER' },
  'catalog.deleteProduct': { min: 'OWNER' },
  'catalog.editPrice': { min: 'MANAGER', permission: 'managers_can_edit_prices' },
  'catalog.priceOverride': { min: 'MANAGER', permission: 'managers_can_edit_prices' },
  'catalog.import': { min: 'OWNER' },
  'catalog.export': { min: 'MANAGER' },

  // --- purchasing -----------------------------------------------------
  'purchasing.createPo': { min: 'MANAGER' },
  'purchasing.approvePo': { min: 'OWNER' },
  'purchasing.receivePo': { min: 'STAFF' },
  'purchasing.cancelPo': { min: 'MANAGER' },
  'purchasing.manageSuppliers': { min: 'MANAGER' },

  // --- customers & credit --------------------------------------------
  'customers.manage': { min: 'STAFF' },
  'customers.setCreditLimit': { min: 'MANAGER' },
  'customers.recordPayment': { min: 'STAFF' },
  'customers.writeOffDebt': { min: 'OWNER' },
  'instalments.createPlan': { min: 'MANAGER' },
  'instalments.recordPayment': { min: 'STAFF' },
  'instalments.restructure': { min: 'MANAGER' },
  'instalments.writeOff': { min: 'OWNER' },
  'layaway.manage': { min: 'STAFF' },
  'holds.manage': { min: 'STAFF' },

  // --- fulfilment -----------------------------------------------------
  'fulfilment.createJob': { min: 'STAFF' },
  'fulfilment.assignJob': { min: 'MANAGER' },
  'fulfilment.completeJob': { min: 'STAFF' },
  'fulfilment.setDeliveryFees': { min: 'MANAGER' },
  'warranty.createClaim': { min: 'STAFF' },
  'warranty.approveClaim': { min: 'MANAGER' },
  'warranty.writeOffClaim': { min: 'OWNER' },

  // --- cash -----------------------------------------------------------
  'till.open': { min: 'STAFF' },
  'till.close': { min: 'STAFF' },
  'till.reconcileOverride': { min: 'MANAGER' },
  'safe.deposit': { min: 'STAFF' },
  'safe.withdraw': { min: 'STAFF', allowance: 'staff_can_spend_from_safe' },
  'safe.viewLedger': { min: 'MANAGER' },
  'expenses.create': { min: 'STAFF' },
  'expenses.approve': { min: 'MANAGER', permission: 'managers_can_approve_expenses' },

  // --- people ---------------------------------------------------------
  'users.view': { min: 'MANAGER' },
  'users.createStaff': { min: 'MANAGER' },
  'users.editStaff': { min: 'MANAGER' },
  'users.createManager': { min: 'OWNER' },
  'users.editManager': { min: 'OWNER' },
  'users.editOwner': { min: 'OWNER', selfOnly: true },
  'users.resetPin': { min: 'MANAGER' },
  'users.clearLoginLock': { min: 'MANAGER' },
  'users.deactivate': { min: 'OWNER' },
  'attendance.clockIn': { min: 'STAFF' },
  'attendance.overrideFlag': { min: 'MANAGER' },
  'attendance.viewAll': { min: 'MANAGER' },

  // --- branches & settings -------------------------------------------
  'branches.manage': { min: 'OWNER' },
  'settings.tax': { min: 'OWNER' },
  'settings.governance': { min: 'OWNER' },
  'settings.branchPreferences': { min: 'MANAGER' },
  'settings.branding': { min: 'ADMIN' },
  'settings.planLimits': { min: 'ADMIN' },
  'data.export': { min: 'OWNER' },
  'data.cleanup': { min: 'ADMIN' },
  'sync.reviewConflicts': { min: 'MANAGER' },
  'reports.accounting': { min: 'OWNER' },
});

// Resolve a capability for a user, taking into account:
//   * the role floor,
//   * org-wide vs branch-pinned (read.allBranches),
//   * OWNER-set governance permissions (managers_can_*),
//   * narrow STAFF allowances (staff_can_*, checked at call time with the
//     specific amount/window because those are per-action, not per-role).
// Returns { ok:true } or { ok:false, status, code, error }.
function can(user, capability, ctx = {}) {
  const def = CAPABILITIES[capability];
  if (!def) {
    // An unknown capability is a PROGRAMMING error, not a user error. Fail
    // CLOSED and loudly — silently allowing an unlisted capability is how
    // an authorisation hole ships.
    return {
      ok: false, status: 500, code: 'UNKNOWN_CAPABILITY',
      error: `Internal error: capability "${capability}" is not defined. Refused.`,
    };
  }
  if (!user || !isRole(user.role)) {
    return { ok: false, status: 401, code: 'UNAUTHENTICATED', error: 'Sign in to continue.' };
  }

  // ADMIN (vendor seat) always passes. It must never be lockable out of a
  // client's own instance by that client's settings.
  if (user.role === 'ADMIN') return { ok: true };

  if (rankOf(user.role) < rankOf(def.min)) {
    return {
      ok: false, status: 403, code: 'INSUFFICIENT_ROLE',
      error: `${jobTitleOf(user)} accounts cannot do this. It requires ${JOB_TITLES[def.min] || def.min} or above.`,
    };
  }

  if (def.requiresOrgWide && !canViewAllBranches(user)) {
    return {
      ok: false, status: 403, code: 'BRANCH_SCOPE_DENIED',
      error: 'A Branch Manager sees only their own branch. This view is organisation-wide.',
    };
  }

  // OWNER-set governance switch over MANAGERs. OWNER and ADMIN are never
  // restricted by these — a switch that could lock the proprietor out of
  // their own books is a footgun.
  if (def.permission && user.role === 'MANAGER' && ctx.settings) {
    const allowed = Number(ctx.settings[def.permission]);
    if (allowed === 0) {
      return {
        ok: false, status: 403, code: 'PERMISSION_DISABLED_BY_OWNER',
        error: `The owner has disabled this for managers (${def.permission}). Ask them to enable it in My Plan → Manager permissions.`,
      };
    }
  }

  return { ok: true };
}

// Narrow STAFF allowances. Each returns null when permitted, or a
// refusal object. They are separate from can() because they need the
// specific amount, the specific record's age, and the till state — facts
// that only exist at the moment of the action.

function assertStaffMayVoid(user, settings, { sale, now = new Date() } = {}) {
  if (user.role !== 'STAFF') return null;                 // managers are gated by 'pos.voidSale' instead
  if (!settings || Number(settings.staff_can_void_sales) === 0) {
    return {
      ok: false, status: 403, code: 'STAFF_VOID_DISABLED',
      error: 'Your account is not allowed to void sales. Ask a manager to void it.',
    };
  }
  if (!sale) return null;

  // Only their OWN sale. A cashier voiding a colleague's sale is how two
  // people cover for each other, and it also destroys the void-rate
  // signal the audit view depends on.
  if (sale.created_by && user.id && String(sale.created_by) !== String(user.id)) {
    return {
      ok: false, status: 403, code: 'STAFF_VOID_NOT_OWN_SALE',
      error: 'You can only void a sale you rang up yourself. Ask the cashier who made it, or a manager.',
    };
  }

  // Only while the till is still open. Once the shift is closed and the
  // cash counted, a void changes a figure someone has already reconciled —
  // that is a manager's decision, not a correction.
  if (sale.till_session_id && sale.till_closed) {
    return {
      ok: false, status: 403, code: 'STAFF_VOID_TILL_CLOSED',
      error: 'This sale belongs to a till session that has already been closed. A manager must reverse it.',
    };
  }

  const windowMinutes = Math.max(0, Number(settings.staff_void_window_minutes) || 0);
  if (windowMinutes > 0 && sale.created_at) {
    const ageMs = now.getTime() - Date.parse(String(sale.created_at).replace(' ', 'T') + (String(sale.created_at).endsWith('Z') ? '' : 'Z'));
    if (Number.isFinite(ageMs) && ageMs > windowMinutes * 60 * 1000) {
      return {
        ok: false, status: 403, code: 'STAFF_VOID_WINDOW_EXPIRED',
        error: `The ${windowMinutes}-minute window for correcting your own sale has passed. A manager can still void it.`,
      };
    }
  }
  return null;
}

function assertStaffMayAdjust(user, settings, { units = 0 } = {}) {
  if (user.role !== 'STAFF') return null;
  if (!settings || Number(settings.staff_can_adjust_stock) === 0) {
    return {
      ok: false, status: 403, code: 'STAFF_ADJUST_DISABLED',
      error: 'Your account is not allowed to write off stock. Ask a manager to record it.',
    };
  }
  const cap = Math.max(0, Number(settings.staff_adjustment_max_units) || 0);
  const n = Math.abs(Number(units) || 0);
  if (cap > 0 && n > cap) {
    return {
      ok: false, status: 403, code: 'STAFF_ADJUST_OVER_CAP',
      error: `A cashier may write off up to ${cap.toLocaleString('en-NG')} unit${cap === 1 ? '' : 's'} per adjustment; this one is ${n.toLocaleString('en-NG')}. Ask a manager to post it.`,
      allowance: cap, requested: n,
    };
  }
  return null;
}

function assertStaffMaySpendFromSafe(user, settings, { amount = 0 } = {}) {
  if (user.role !== 'STAFF') return null;
  if (!settings || Number(settings.staff_can_spend_from_safe) === 0) {
    return {
      ok: false, status: 403, code: 'STAFF_SAFE_DISABLED',
      error: 'Your account cannot take money from the branch safe. Ask a manager.',
    };
  }
  // A cap of 0 means NO CAP, deliberately: the client asked to be able to
  // set "no limit", so this reads as unlimited and never as "zero allowed".
  // The can/cannot decision is the boolean above, not this number.
  const cap = Math.max(0, Number(settings.staff_safe_spend_max) || 0);
  if (cap > 0 && Number(amount) > cap) {
    return {
      ok: false, status: 403, code: 'STAFF_SAFE_OVER_CAP',
      error:
        `A cashier may draw up to ₦${cap.toLocaleString('en-NG')} from the safe in one purchase ` +
        `(this one needs ₦${(Math.round(Number(amount) * 100) / 100).toLocaleString('en-NG')}). Ask a manager to record it.`,
      allowance: cap, requested: Number(amount),
    };
  }
  return null;
}

// A stocktake COMMIT moves stock by the variance, so the staff cap applies
// to the LARGEST variance about to be posted — not to the counting itself.
// Counting stays open to cashiers because walking the shelves is exactly
// their job, and requiring a manager to hold the clipboard makes the
// feature unusable. A count that matches (or is off by a unit or two)
// closes normally; anything bigger needs a manager, who can close the very
// same session with the counts already recorded.
function assertStaffMayCommitStocktake(user, settings, { variances = [] } = {}) {
  if (user.role !== 'STAFF') return null;
  const largest = (variances || []).reduce((max, v) => Math.max(max, Math.abs(Number(v && v.variance) || 0)), 0);
  return assertStaffMayAdjust(user, settings, { units: largest });
}

// ---------------------------------------------------------------------
// USER LIFECYCLE — the seams BETWEEN roles
// ---------------------------------------------------------------------
// Transfers (staff moving branch), promotions (staff → manager) and
// turnover (deactivation) are where authority leaks, because each one
// changes what a token means. Two invariants:
//   1. A token minted BEFORE a demotion or branch transfer must not keep
//      its old authority. The session carries an `imt` (issued-at, millis)
//      claim precisely so a credential change in the same second is still
//      distinguishable — a second-resolution `iat` cannot decide whether a
//      token was minted before or after a change that happened at N.4 vs
//      N.9, and one of the two answers is always wrong.
//   2. A transfer is a PENDING request until the receiving branch's
//      manager accepts it, and only ONE may be open per user at a time.
const USER_TRANSFER_STATUSES = Object.freeze(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED']);

function isTokenStaleAgainstCredentialChange(tokenImtMs, credentialChangedAtIso) {
  if (!tokenImtMs || !credentialChangedAtIso) return false;
  const changed = Date.parse(credentialChangedAtIso);
  if (!Number.isFinite(changed)) return false;
  return Number(tokenImtMs) < changed;
}

module.exports = {
  ROLES,
  ROLE_RANK,
  JOB_TITLES,
  CAPABILITIES,
  USER_TRANSFER_STATUSES,
  isRole,
  rankOf,
  outranks,
  jobTitleOf,
  isGeneralManager,
  isBranchManager,
  isClientStaff,
  pinnedBranchIdOf,
  resolveScopedBranchId,
  resolveMutationBranchId,
  assertBranchAccess,
  canViewAllBranches,
  can,
  assertStaffMayVoid,
  assertStaffMayAdjust,
  assertStaffMaySpendFromSafe,
  assertStaffMayCommitStocktake,
  isTokenStaleAgainstCredentialChange,
};
