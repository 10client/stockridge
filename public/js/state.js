// =====================================================================
// public/js/state.js — session, scope and the reference cache
// =====================================================================
// Holds three kinds of thing, kept separate because they have different
// lifetimes:
//
//   SESSION   the token and who it belongs to. Survives a reload (sessionStorage
//             so a shared till laptop does not stay signed in across shifts),
//             dies on sign-out.
//   SCOPE     which businesses and branches this user can see. Comes from the
//             server on every sign-in — never cached across sessions, because a
//             demotion or a branch transfer must take effect immediately.
//   REFERENCE categories, units, tenders, states, the vertical profiles. Cached
//             in IndexedDB/localStorage because it changes rarely and the POS
//             needs it with no network at all.

'use strict';

const TOKEN_KEY = 'sr.token';
const USER_KEY = 'sr.user';
const SCOPE_KEY = 'sr.scope';
const CHOICE_KEY = 'sr.choice';
const REF_KEY = 'sr.reference';

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode, full quota */ }
}
function removeKey(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

export const state = {
  token: null,
  user: null,
  scope: null,
  settings: null,
  businesses: [],
  branches: [],
  reference: null,
  plan: null,
  // The ACTIVE business and branch. Distinct from the scope: an owner can see
  // everything but the POS still has to know which drawer the cash is going into.
  activeBusinessId: null,
  activeBranchId: null,
  online: navigator.onLine,
  booted: false,
};

/** Restore a session from storage. Returns true if a token was found. */
export function restoreSession() {
  state.token = readJson(TOKEN_KEY);
  state.user = readJson(USER_KEY);
  state.scope = readJson(SCOPE_KEY);
  const choice = readJson(CHOICE_KEY);
  if (choice) {
    state.activeBusinessId = choice.businessId || null;
    state.activeBranchId = choice.branchId || null;
  }
  return !!state.token;
}

export function setSession({ token, user, scope }) {
  state.token = token;
  state.user = user;
  state.scope = scope;
  writeJson(TOKEN_KEY, token);
  writeJson(USER_KEY, user);
  writeJson(SCOPE_KEY, scope);
}

export function clearSession() {
  state.token = null;
  state.user = null;
  state.scope = null;
  state.plan = null;
  [TOKEN_KEY, USER_KEY, SCOPE_KEY].forEach(removeKey);
}

/** Apply /auth/me. Chooses a sensible active business/branch when none is set. */
export function applyMe(me) {
  state.user = { ...state.user, ...me.user };
  state.scope = me.scope;
  state.settings = me.settings;
  state.businesses = me.businesses || [];
  state.branches = me.branches || [];
  state.plan = me.plan || null;
  writeJson(USER_KEY, state.user);
  writeJson(SCOPE_KEY, state.scope);

  // Keep a stored choice only if it is still in scope. A user transferred out of
  // a branch must not silently keep posting into it — which is also why the scope
  // is re-read from the server on every sign-in rather than trusted from storage.
  const validBusiness = state.businesses.some((b) => b.id === state.activeBusinessId);
  if (!validBusiness) state.activeBusinessId = state.businesses.length ? state.businesses[0].id : null;

  const inBusiness = state.branches.filter((b) => b.business_id === state.activeBusinessId);
  const validBranch = inBusiness.some((b) => b.id === state.activeBranchId);
  if (!validBranch) {
    state.activeBranchId = (state.scope && state.scope.branch_id)
      || (inBusiness.length ? inBusiness[0].id : (state.branches[0] ? state.branches[0].id : null));
  }
  persistChoice();
  return state;
}

export function persistChoice() {
  writeJson(CHOICE_KEY, { businessId: state.activeBusinessId, branchId: state.activeBranchId });
}

export function setActiveBusiness(id) {
  state.activeBusinessId = id;
  // Changing business invalidates the branch choice: a branch of the old business
  // is not a branch of the new one, and keeping it would post sales into the
  // wrong book.
  const inBusiness = state.branches.filter((b) => b.business_id === id);
  state.activeBranchId = inBusiness.length ? inBusiness[0].id : null;
  persistChoice();
}

export function setActiveBranch(id) {
  state.activeBranchId = id;
  persistChoice();
}

export function activeBusiness() {
  return state.businesses.find((b) => b.id === state.activeBusinessId) || state.businesses[0] || null;
}
export function activeBranch() {
  return state.branches.find((b) => b.id === state.activeBranchId) || null;
}
export function branchesOfActiveBusiness() {
  return state.branches.filter((b) => b.business_id === state.activeBusinessId);
}

// ---------------------------------------------------------------------
// capability checks — mirror the server's rules so the UI can hide what
// the user cannot do, rather than showing a button that always 403s.
// ---------------------------------------------------------------------
const RANK = { STAFF: 1, MANAGER: 2, OWNER: 3, ADMIN: 4 };

export function role() { return (state.user && state.user.role) || 'STAFF'; }
export function rank() { return RANK[role()] || 0; }
export function atLeast(r) { return rank() >= (RANK[r] || 99); }
export function isVendor() { return role() === 'ADMIN'; }
export function isPinned() { return !!(state.scope && state.scope.pinned); }
export function canSeeMultipleBranches() { return state.branches.length > 1; }
export function canSeeMultipleBusinesses() { return state.businesses.length > 1; }

/**
 * Can this user do X? The server is authoritative — this only decides what to
 * SHOW. A UI that hides the button and a server that refuses the call are two
 * independent layers, and the second is the one that matters.
 */
export const can = {
  voidSale: () => atLeast('MANAGER') || setting('staff_can_void_sales'),
  adjustStock: () => atLeast('MANAGER') || setting('staff_can_adjust_stock'),
  editPrices: () => atLeast('MANAGER') && setting('managers_can_edit_prices', true),
  approveExpenses: () => atLeast('MANAGER') && setting('managers_approve', true),
  seeSettings: () => atLeast('OWNER'),
  seePlan: () => atLeast('OWNER') || isVendor(),
  seeRegisters: () => atLeast('MANAGER'),
  seeAccounting: () => atLeast('MANAGER'),
  manageUsers: () => atLeast('MANAGER'),
  spendFromSafe: () => atLeast('MANAGER') || setting('staff_can_spend_from_safe'),
  dispatchUnpaid: () => atLeast('MANAGER') && setting('managers_can_dispatch_unpaid'),
  writeOffDebt: () => atLeast('MANAGER') && setting('managers_can_write_off_debt'),
  overridePriceFloor: () => atLeast('MANAGER') && setting('managers_can_override_price_floor', true),
};

function setting(key, fallback = false) {
  const s = state.settings || {};
  const v = s[key];
  if (v == null) return fallback;
  return Number(v) === 1 || v === true;
}
export { setting };

/** The maximum discount this user may apply without a manager. */
export function maxDiscountPercent() {
  if (atLeast('OWNER')) return 100;
  if (atLeast('MANAGER')) return Number(state.settings && state.settings.max_discount_percent) || 25;
  return Number(state.settings && state.settings.staff_max_discount_percent) || 5;
}

// ---------------------------------------------------------------------
// reference cache
// ---------------------------------------------------------------------
export function setReference(ref) {
  state.reference = ref;
  writeJson(REF_KEY, ref);
}
export function cachedReference() {
  if (state.reference) return state.reference;
  state.reference = readJson(REF_KEY);
  return state.reference;
}

// ---------------------------------------------------------------------
// money formatting — one definition, matching the server exactly
// ---------------------------------------------------------------------
export function naira(value, { kobo = true } = {}) {
  const n = Number(value) || 0;
  const s = Math.abs(n).toLocaleString('en-NG', {
    minimumFractionDigits: kobo ? 2 : 0,
    maximumFractionDigits: kobo ? 2 : 0,
  });
  return `${n < 0 ? '-' : ''}₦${s}`;
}

export function num(value, decimals = 0) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-NG', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function todayWat() {
  // West Africa Time is UTC+1 year-round with no daylight saving, so this is a
  // fixed offset. The server computes it too (shared/lib/timegeo.js) and both
  // must agree, or a sale made at 00:30 in Lagos appears under two different
  // days depending on which side of the wire you ask.
  const d = new Date(Date.now() + 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export function watClock() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(11, 19);
}
