'use strict';
// =====================================================================
// public/js/state.js — WHO IS SIGNED IN, AND WHICH SHOP THEY ARE IN
// =====================================================================
// Two facts drive every screen in this app:
//
//   * WHO   — the user, their role, and the navigation that role is allowed.
//   * WHERE — the active business and the active branch.
//
// The second one is the dangerous one. A manager pinned to the Ikeja branch must
// not be able to look at the Abuja branch by editing a URL, so the branch
// selection here is only ever a CHOSEN value WITHIN what `/api/auth/me` said is
// permitted. The server re-derives its own scope on every request regardless —
// this is a convenience, not the guard — but a UI that offered a branch the
// server would refuse produces a confusing 403 instead of a working screen, so
// the list is filtered client-side too.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};

  const ACTIVE_BRANCH_KEY = 'sr.activeBranch';
  const ACTIVE_BUSINESS_KEY = 'sr.activeBusiness';
  const CACHE_TTL_MS = 5 * 60 * 1000;

  const listeners = new Map();

  // ---------------------------------------------------------------------
  // RAW ROWS AND ACCESSORS MUST NOT SHARE A NAME.
  //
  // This object is later merged with `Object.assign(state, { businesses, branches, … })`
  // so that `SR.state.branches()` is the reader. That assignment puts the
  // FUNCTION on the key. But `load()` then did `state.branches = data.branches`,
  // which puts the ARRAY back on the same key — so from the moment a session
  // loaded, `SR.state.branches` was an array and `SR.state.branches()` threw
  // "is not a function".
  //
  // `app.js` calls it inside `paintIdentity()`, which `showShell()` runs BEFORE
  // `buildNav()`. The throw therefore skipped the navigation build entirely: the
  // shell rendered with an EMPTY SIDEBAR for every role, on every deployment,
  // including the platform administrator who has no business to load. One
  // overwritten key, and the whole app looked broken.
  //
  // The rows now live under `*Rows`, which no accessor borrows, and the
  // accessors are the only public way to read them.
  // ---------------------------------------------------------------------
  const state = {
    user: null,
    scope: null,
    businessRows: [],
    branchRows: [],
    vertical: null,
    settings: {},
    featureLabels: {},
    activeBusinessId: null,
    activeBranchId: null,
    loadedAt: 0,
    cart: null,          // the in-progress POS cart, restored on reload
    lastReceipt: null,   // the sale just completed, for the receipt screen
  };

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }
  function emit(event, detail) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) { try { fn(detail); } catch (e) { /* keep going */ } }
  }

  function readLocal(key) {
    try { return localStorage.getItem(key) || null; } catch (e) { return null; }
  }
  function writeLocal(key, value) {
    try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch (e) { /* fine */ }
  }

  // -------------------------------------------------------------------
  // role helpers
  // -------------------------------------------------------------------
  const ROLE_RANK = { STAFF: 1, MANAGER: 2, OWNER: 3, ADMIN: 4 };
  function rank(role) { return ROLE_RANK[String(role || '').toUpperCase()] || 0; }
  function atLeast(role) { return rank(state.user && state.user.role) >= rank(role); }
  function isRole(role) { return String((state.user && state.user.role) || '').toUpperCase() === String(role).toUpperCase(); }
  function isAdmin() { return isRole('ADMIN'); }
  function isOwner() { return isRole('OWNER'); }
  function isManager() { return isRole('MANAGER'); }
  function isStaff() { return isRole('STAFF'); }
  /** A general manager has no branch pin: they cover every branch of a business. */
  function isGeneralManager() { return isManager() && !(state.user && state.user.branch && state.user.branch.id); }
  function canSeeAllBranches() { return Boolean(state.scope && state.scope.allBranches); }

  /** May this user act on a screen? `min` is a role name. */
  function can(min) { return atLeast(min); }

  /**
   * May this user manage THAT user — reset their PIN, change their role, end their session?
   *
   * THE SERVER DECIDES (`canManageUser`, domain/roles.js) AND THIS MIRRORS IT. It exists so a
   * button is not offered where the route would answer 403 — a screen that offers an action it
   * cannot deliver teaches people the product is broken. The mirror is not the authority: every
   * call is checked again server-side, and a disagreement shows up as a refusal through
   * `ui.apiError`, which is the safe direction for the screen to be wrong in.
   *
   * Two deliberate differences from `atLeast`, both taken from the route: signing YOURSELF out
   * is always allowed (it is not an authority question), and the deployment administrator
   * cannot be managed by anyone but themselves.
   */
  function canManageUser(target) {
    if (!target) return false;
    const me = state.user || {};
    const targetRole = String(target.role || '').toUpperCase();
    const targetId = String(target.id != null ? target.id : target.user_id);
    if (targetId !== 'undefined' && targetId === String(me.id)) return true; // your own session
    if (targetRole === 'ADMIN') return false;
    if (!atLeast('MANAGER')) return false;
    return rank(me.role) > rank(targetRole);
  }

  /**
   * May this user CREATE somebody at that role?
   *
   * THE SERVER DECIDES (`canManageUser(actor, { role })` in `POST /api/users`) AND THIS MIRRORS
   * IT. The create form offered all four roles to everybody, so an owner picking "Owner" — a
   * perfectly ordinary thing for an owner to try — was refused with "You are a Owner and cannot
   * create a Owner. Only somebody above that role can." after filling the whole form. A chooser
   * should offer what it can deliver.
   *
   * The rule, read off the route: the deployment administrator may create anything; nobody
   * creates an administrator but them; and otherwise only strictly higher ranks can be created.
   */
  function canCreateRole(role) {
    const me = state.user || {};
    const mine = String(me.role || '').toUpperCase();
    const wanted = String(role || '').toUpperCase();
    if (!wanted) return false;
    if (mine === 'ADMIN') return true;
    if (wanted === 'ADMIN') return false;
    return rank(mine) > rank(wanted);
  }

  /**
   * Does a person at this role need a branch?
   *
   * AN OWNER DOES NOT. An owner reaches every branch by role — `allBranches` is true for OWNER
   * whether or not the row carries a branch_id — and a business is provisioned with its proprietor
   * unpinned. Requiring a branch of an owner made the form say "add a branch" on a deployment that
   * had none, and on one that had them it pinned a person whose scope does not come from a pin.
   * Only a cashier or a manager is scoped by the branch they belong to. The deployment
   * administrator is not pinned either.
   */
  function roleNeedsBranch(role) {
    const r = String(role || '').toUpperCase();
    return r !== 'ADMIN' && r !== 'OWNER';
  }

  // -------------------------------------------------------------------
  // feature flags
  // -------------------------------------------------------------------
  function feature(key) {
    const raw = state.settings ? state.settings[key] : undefined;
    if (raw === undefined || raw === null) return true;
    return Boolean(Number(raw));
  }

  /**
   * Does this business identify units by serial number?
   *
   * Off unless the owner has turned the switch on. `feature()` treats a missing
   * setting as on, which is the right answer for a module that ships enabled and
   * the wrong one here: a shop that has not chosen serials must not be asked for
   * them at the counter, on a goods receipt, or on the slip.
   */
  function usesSerialNumbers() {
    return Number(state.settings && state.settings.serial_tracking_enabled) === 1;
  }
  function featureLabel(key) { return state.featureLabels[key] || key; }

  // -------------------------------------------------------------------
  // active business / branch
  // -------------------------------------------------------------------
  function businesses() { return state.businessRows || []; }
  function branches() { return state.branchRows || []; }

  function branchesFor(businessId) {
    if (!businessId) return branches();
    return branches().filter((b) => String(b.business_id) === String(businessId));
  }

  function activeBusiness() {
    return businesses().find((b) => String(b.id) === String(state.activeBusinessId)) || businesses()[0] || null;
  }
  function activeBranch() {
    return branches().find((b) => String(b.id) === String(state.activeBranchId)) || null;
  }
  function activeBranchName() {
    const b = activeBranch();
    return b ? b.name : (canSeeAllBranches() ? 'All branches' : '—');
  }
  /**
   * The active business's NAME, or a phrase that is still true when there is none.
   *
   * `activeBusiness()` returns null on a deployment that has no business yet — the
   * state every fresh installation starts in, and the state an administrator is in
   * for as long as it takes them to run the first provisioning. Five screens wrote
   * `${SR.state.activeBusiness().name}` straight into their page subtitle, so on
   * exactly those deployments they threw `Cannot read properties of null` and the
   * screen showed "That failed." instead of rendering. The Subscription screen is
   * in the administrator's own navigation, which is how it was noticed.
   *
   * A subtitle is not a place to make a decision about whether a page may exist:
   * it must never be able to fail the page it introduces.
   */
  function activeBusinessName(fallback = 'No business yet') {
    const b = activeBusiness();
    if (b && b.name) return b.name;
    const settings = state.settings || {};
    return settings.business_name || fallback;
  }

  /**
   * Choose the branch every subsequent request will name.
   *
   * A user pinned to one branch has no choice to make, and is never shown one.
   * A user with several branches must choose explicitly — the app does not guess,
   * because guessing is how stock gets received into the wrong shop — but the
   * choice is REMEMBERED per device so a counter till does not re-ask all day.
   */
  function setBranch(branchId, { persist = true, silent = false } = {}) {
    const id = branchId ? String(branchId) : null;
    if (id && !branches().some((b) => String(b.id) === id)) {
      // Never let a stale localStorage value or a typed URL put the app into a
      // branch this user cannot see.
      return { ok: false, reason: 'That branch is not one you have access to.' };
    }
    state.activeBranchId = id;
    if (persist) writeLocal(ACTIVE_BRANCH_KEY, id);
    if (!silent) emit('branch', { branchId: id, branch: activeBranch() });
    return { ok: true };
  }

  function setBusiness(businessId, { persist = true, silent = false } = {}) {
    const id = businessId ? String(businessId) : null;
    if (id && !businesses().some((b) => String(b.id) === id)) {
      return { ok: false, reason: 'That business is not one you have access to.' };
    }
    state.activeBusinessId = id;
    if (persist) writeLocal(ACTIVE_BUSINESS_KEY, id);
    // The branch belongs to a business; switching legal entity must not leave
    // the app pointing at a branch of the old one.
    const forBiz = branchesFor(id);
    const stillValid = forBiz.some((b) => String(b.id) === String(state.activeBranchId));
    if (!stillValid) {
      const pinned = state.user && state.user.branch && state.user.branch.id;
      const ownerChooses = canSeeAllBranches() && !pinned && branches().length > 1;
      const next = pinned && forBiz.some((b) => String(b.id) === String(pinned))
        ? pinned
        : (ownerChooses ? null : (forBiz.length === 1 ? forBiz[0].id : null));
      state.activeBranchId = next ? String(next) : null;
      writeLocal(ACTIVE_BRANCH_KEY, state.activeBranchId);
    }
    if (!silent) emit('business', { businessId: id, business: activeBusiness() });
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------
  /** Populate everything from `/api/auth/me`. Throws if the session is dead. */
  async function load({ force = false } = {}) {
    if (!force && state.user && Date.now() - state.loadedAt < CACHE_TTL_MS) return state;
    const data = await SR.api.me();
    state.user = data.user || null;
    state.scope = data.scope || null;
    state.businessRows = data.businesses || [];
    state.branchRows = data.branches || [];
    state.vertical = data.vertical || null;
    state.settings = data.settings || {};
    state.featureLabels = data.featureLabels || {};
    state.loadedAt = Date.now();

    // Mirror the reference data so the offline screens have names to show.
    await SR.store.putMany('businesses', state.businessRows).catch(() => {});
    await SR.store.putMany('branches', state.branchRows).catch(() => {});
    await SR.store.putMany('client_settings', state.settings && state.settings.id ? [state.settings] : []).catch(() => {});
    await SR.store.metaSet('me', {
      user: state.user, scope: state.scope, settings: state.settings,
      featureLabels: state.featureLabels, vertical: state.vertical, at: SR.util.nowIso(),
    }).catch(() => {});

    resolveActive();
    emit('loaded', state);
    return state;
  }

  /** Restore the signed-in shell from the mirror when the server is unreachable. */
  async function loadFromMirror() {
    const cached = await SR.store.metaGet('me');
    if (!cached || !cached.user) return null;
    state.user = cached.user;
    state.scope = cached.scope;
    state.settings = cached.settings || {};
    state.featureLabels = cached.featureLabels || {};
    state.vertical = cached.vertical || null;
    state.businessRows = await SR.store.all('businesses').catch(() => []);
    state.branchRows = await SR.store.all('branches').catch(() => []);
    state.loadedAt = Date.now();
    resolveActive();
    emit('loaded', state);
    return state;
  }

  function resolveActive() {
    const pinned = state.user && state.user.branch && state.user.branch.id;
    const rememberedBusiness = readLocal(ACTIVE_BUSINESS_KEY);
    const rememberedBranch = readLocal(ACTIVE_BRANCH_KEY);

    // Business: the remembered one if it is still reachable, else the only one,
    // else the first, else nothing (a multi-entity owner picks).
    const bizIds = businesses().map((b) => String(b.id));
    if (rememberedBusiness && bizIds.includes(String(rememberedBusiness))) {
      state.activeBusinessId = String(rememberedBusiness);
    } else if (state.user && state.user.business && bizIds.includes(String(state.user.business.id))) {
      state.activeBusinessId = String(state.user.business.id);
    } else if (bizIds.length === 1) {
      state.activeBusinessId = bizIds[0];
    } else if (state.vertical && state.vertical.profile_code) {
      const match = businesses().find((b) => b.profile_code === state.vertical.profile_code);
      state.activeBusinessId = match ? String(match.id) : (bizIds[0] || null);
    } else {
      state.activeBusinessId = bizIds[0] || null;
    }

    const forBiz = branchesFor(state.activeBusinessId);

    // Branch: a pinned user gets their own, always. A remembered branch is a
    // switch they already made. An owner who can see more than one branch is
    // NOT switched onto the only shop of the active business — that guess is
    // how the dashboard showed a branch's totals before anybody had switched.
    const ownerChooses = canSeeAllBranches() && !pinned && branches().length > 1;
    if (pinned && branches().some((b) => String(b.id) === String(pinned))) {
      state.activeBranchId = String(pinned);
    } else if (rememberedBranch && branches().some((b) => String(b.id) === String(rememberedBranch))) {
      state.activeBranchId = String(rememberedBranch);
    } else if (ownerChooses) {
      state.activeBranchId = null;
    } else if (forBiz.length === 1) {
      state.activeBranchId = String(forBiz[0].id);
    } else if (branches().length === 1) {
      state.activeBranchId = String(branches()[0].id);
    } else {
      state.activeBranchId = null;
    }

    // Keep the business in step with the branch: the branch knows its owner.
    const branch = branches().find((b) => String(b.id) === String(state.activeBranchId));
    if (branch && branch.business_id && String(branch.business_id) !== String(state.activeBusinessId)
        && bizIds.includes(String(branch.business_id))) {
      state.activeBusinessId = String(branch.business_id);
    }
  }

  /** Every list request needs a branch. Callers should use this rather than
   *  inventing a query string, so the "which shop?" decision is made once. */
  function query(extra = {}) {
    const q = Object.assign({}, extra);
    if (state.activeBusinessId) q.business_id = state.activeBusinessId;
    if (state.activeBranchId) q.branch_id = state.activeBranchId;
    return q;
  }

  function clear() {
    state.user = null; state.scope = null; state.businessRows = []; state.branchRows = [];
    state.vertical = null; state.settings = {}; state.featureLabels = {};
    state.activeBranchId = null; state.activeBusinessId = null; state.loadedAt = 0;
    state.cart = null;
    emit('cleared', null);
  }

  // -------------------------------------------------------------------
  // POS cart — persisted, because a flat battery must not lose a cart
  // -------------------------------------------------------------------
  function saveCart(cart) {
    state.cart = cart;
    try { localStorage.setItem('sr.cart', JSON.stringify(cart)); } catch (e) { /* fine */ }
  }
  function loadCart() {
    if (state.cart) return state.cart;
    try {
      const raw = localStorage.getItem('sr.cart');
      state.cart = raw ? JSON.parse(raw) : null;
    } catch (e) { state.cart = null; }
    return state.cart;
  }
  function clearCart() {
    state.cart = null;
    try { localStorage.removeItem('sr.cart'); } catch (e) { /* fine */ }
  }

  SR.state = Object.assign(state, {
    on, emit, load, loadFromMirror, clear,
    rank, atLeast, isRole, isAdmin, isOwner, isManager, isStaff, isGeneralManager, canManageUser,
    canCreateRole, roleNeedsBranch,
    canSeeAllBranches, can, usesSerialNumbers,
    feature, featureLabel,
    businesses, branches, branchesFor, activeBusiness, activeBranch, activeBranchName, activeBusinessName,
    setBranch, setBusiness, query,
    saveCart, loadCart, clearCart,
  });
}(window));
