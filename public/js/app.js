'use strict';
// =====================================================================
// public/js/app.js — THE SHELL, THE ROUTER AND THE BOOT SEQUENCE
// =====================================================================
// One page, hash-free routing over real paths, using the History API. Real paths
// because a Nigerian shop owner opens the app from a bookmark, a WhatsApp link or
// their home screen and expects /pos to say where they are; the server already
// serves an SPA fallback for any non-API path.
//
// THE BOOT SEQUENCE, and why it is in this order:
//
//   1. Open the offline store.          If this fails nothing else can work, and
//                                       the failure is reported in plain words.
//   2. Resolve the device identity.      Every later request carries it.
//   3. Restore the mirror's session.     So a shop that has no line at 7 a.m.
//                                       still opens to the till, not to a login
//                                       screen that cannot authenticate.
//   4. Try the server.                   Token still valid? Scope still the
//                                       same? Then everything is live.
//   5. Start the sync loop.              Push before pull, every time.
//
// A device that has NEVER signed in and has no line is told so honestly, with no
// pretence that it might work.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};
  const U = SR.util;
  const ui = SR.ui;

  SR.APP_VERSION = '1.0.0';
  SR.BUILD = 'ridge-1';

  // -------------------------------------------------------------------
  // ROUTES
  // -------------------------------------------------------------------
  // `nav: false` means the route is reachable but does not appear in the sidebar
  // (it is opened from another screen: a till detail, a sale receipt, a product).
  const ROUTES = [
    { path: '/dashboard', title: 'Dashboard', group: 'Today', view: 'dashboard', icon: 'grid', roles: ['STAFF', 'MANAGER', 'OWNER', 'ADMIN'] },
    { path: '/pos', title: 'Sell', group: 'Today', view: 'pos', icon: 'cart', roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/till', title: 'Till & safe', group: 'Today', view: 'till', icon: 'cash', roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/sales', title: 'Sales', group: 'Today', view: 'sales', icon: 'receipt', roles: ['STAFF', 'MANAGER', 'OWNER'] },

    { path: '/products', title: 'Catalogue', group: 'Stock', view: 'products', icon: 'tag', roles: ['MANAGER', 'OWNER'] },
    { path: '/stock', title: 'Stock', group: 'Stock', view: 'stock', icon: 'box', roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/stocktake', title: 'Stocktake', group: 'Stock', view: 'stocktake', icon: 'check', roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/transfers', title: 'Transfers', group: 'Stock', view: 'transfers', icon: 'swap', roles: ['MANAGER', 'OWNER'] },

    { path: '/purchase-orders', title: 'Purchase orders', group: 'Buying', view: 'purchase-orders', icon: 'inbox', roles: ['MANAGER', 'OWNER'] },
    { path: '/suppliers', title: 'Suppliers', group: 'Buying', view: 'suppliers', icon: 'truck', roles: ['MANAGER', 'OWNER'] },
    { path: '/expenses', title: 'Expenses', group: 'Buying', view: 'expenses', icon: 'wallet', roles: ['MANAGER', 'OWNER'] },

    { path: '/customers', title: 'Customers', group: 'Customers', view: 'customers', icon: 'users', roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/instalments', title: 'Instalments & layaway', group: 'Customers', view: 'instalments', icon: 'calendar', roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/deliveries', title: 'Deliveries & installs', group: 'Customers', view: 'deliveries', icon: 'truck', roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/returns', title: 'Returns & warranty', group: 'Customers', view: 'returns', icon: 'back', roles: ['STAFF', 'MANAGER', 'OWNER'] },

    { path: '/attendance', title: 'Attendance', group: 'People', view: 'attendance', icon: 'clock', roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/users', title: 'Staff', group: 'People', view: 'users', icon: 'idcard', roles: ['MANAGER', 'OWNER', 'ADMIN'] },

    { path: '/accounting', title: 'Accounting', group: 'Money', view: 'accounting', icon: 'ledger', roles: ['OWNER'] },
    { path: '/reports', title: 'Reports', group: 'Money', view: 'reports', icon: 'chart', roles: ['MANAGER', 'OWNER'] },

    { path: '/branches', title: 'Branches', group: 'Business', view: 'admin', icon: 'building', section: 'branches', roles: ['MANAGER', 'OWNER', 'ADMIN'] },
    { path: '/businesses', title: 'Businesses', group: 'Business', view: 'admin', icon: 'briefcase', section: 'businesses', roles: ['OWNER', 'ADMIN'] },
    { path: '/plan', title: 'Subscription', group: 'Business', view: 'plan', icon: 'star', roles: ['OWNER', 'ADMIN'] },
    { path: '/settings', title: 'Settings', group: 'Business', view: 'admin', icon: 'gear', section: 'settings', roles: ['OWNER', 'ADMIN'] },
    { path: '/audit', title: 'Audit trail', group: 'Business', view: 'admin', icon: 'shield', section: 'audit', roles: ['MANAGER', 'OWNER'] },
    { path: '/compliance', title: 'Compliance & licences', group: 'Business', view: 'compliance', icon: 'shield', roles: ['MANAGER', 'OWNER', 'ADMIN'] },
    { path: '/sync', title: 'Sync & offline', group: 'Business', view: 'sync', icon: 'refresh', roles: ['STAFF', 'MANAGER', 'OWNER', 'ADMIN'] },
    { path: '/account', title: 'My account', group: 'Business', view: 'account', icon: 'user', nav: false, roles: ['STAFF', 'MANAGER', 'OWNER', 'ADMIN'] },

    // Detail screens, reached from another screen.
    { path: '/sales/:id', view: 'sales', nav: false, roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/products/:id', view: 'products', nav: false, roles: ['MANAGER', 'OWNER'] },
    { path: '/customers/:id', view: 'customers', nav: false, roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/tills/:id', view: 'till', nav: false, roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/deliveries/:id', view: 'deliveries', nav: false, roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/instalments/:id', view: 'instalments', nav: false, roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/suppliers/:id', view: 'suppliers', nav: false, roles: ['MANAGER', 'OWNER'] },
    { path: '/purchase-orders/:id', view: 'purchase-orders', nav: false, roles: ['MANAGER', 'OWNER'] },
    { path: '/stocktakes/:id', view: 'stocktake', nav: false, roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/transfers/:id', view: 'transfers', nav: false, roles: ['MANAGER', 'OWNER'] },
  ];

  const ICONS = {
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    cart: 'M4 5h2l2.5 11h10L21 8H7M10 20a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z',
    cash: 'M2 7h20v10H2zM12 15a3 3 0 100-6 3 3 0 000 6z',
    receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
    tag: 'M3 12l9-9h7v7l-9 9zM15 7h.01',
    box: 'M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4M3 17l9 4 9-4',
    check: 'M4 12l5 5L20 6',
    swap: 'M4 8h13l-3-3M20 16H7l3 3',
    inbox: 'M3 12h5l2 3h4l2-3h5M3 12l3-8h12l3 8v8H3z',
    truck: 'M2 7h11v9H2zM13 10h4l4 3v3h-8M6 19a2 2 0 100-4 2 2 0 000 4zm11 0a2 2 0 100-4 2 2 0 000 4z',
    wallet: 'M3 7h16a2 2 0 012 2v8a2 2 0 01-2 2H3zM3 7V6a2 2 0 012-2h11M17 13h.01',
    users: 'M9 11a4 4 0 100-8 4 4 0 000 8zm7 0a3 3 0 100-6 3 3 0 000 6zM2 21v-2a5 5 0 015-5h4a5 5 0 015 5v2M16 21v-2a5 5 0 00-2-4',
    calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    back: 'M9 14l-4-4 4-4M5 10h9a5 5 0 015 5v4',
    clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l4 2',
    idcard: 'M3 5h18v14H3zM8 12a2 2 0 100-4 2 2 0 000 4zM5 16a3 3 0 016 0M14 9h5M14 13h5',
    ledger: 'M5 3h13a2 2 0 012 2v16H7a2 2 0 01-2-2zM9 7h8M9 11h8M9 15h5',
    chart: 'M4 19V9m5 10V5m5 14v-7m5 7V8',
    building: 'M4 21V5l8-3 8 3v16M9 21v-5h6v5M8 9h2M14 9h2M8 13h2M14 13h2',
    briefcase: 'M3 8h18v12H3zM8 8V6a2 2 0 012-2h4a2 2 0 012 2v2M3 13h18',
    star: 'M12 3l3 6 6.5 1-4.8 4.6 1.2 6.4L12 18l-5.9 3 1.2-6.4L2.5 10 9 9z',
    gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1A1.7 1.7 0 006 19.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 13.6H3a2 2 0 110-4h.1A1.7 1.7 0 004.7 6L4.6 6a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010.4 2V2a2 2 0 114 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 001.2 2.9H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
    shield: 'M12 3l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6zM9 12l2 2 4-4',
    refresh: 'M20 11A8 8 0 005.6 6.6L4 8M4 13a8 8 0 0014.4 4.4L20 16M4 4v4h4M20 20v-4h-4',
    user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1',
  };

  function iconPath(name) { return ICONS[name] || ICONS.grid; }
  function icon(name, size = 18) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${iconPath(name)}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  // -------------------------------------------------------------------
  // ROUTER
  // -------------------------------------------------------------------
  let currentRoute = null;
  let currentParams = {};
  let currentQuery = {};
  let cleanupFns = [];

  /** Match `/sales/:id` etc. The server's compilePath uses the same shape. */
  function matchRoute(pathname) {
    if (pathname === '/' || pathname === '') pathname = '/dashboard';
    for (const route of ROUTES) {
      const keys = [];
      const source = route.path.split('/').map((seg) => {
        if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('/');
      const m = new RegExp(`^${source}/?$`).exec(pathname);
      if (!m) continue;
      const params = {};
      keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    return null;
  }

  function allowed(route) {
    if (!route.roles) return true;
    return route.roles.includes(String((SR.state.user && SR.state.user.role) || '').toUpperCase());
  }

  function navigate(path, { replace = false, silent = false } = {}) {
    const url = new URL(path, global.location.origin);
    if (replace) history.replaceState({}, '', url.pathname + url.search);
    else history.pushState({}, '', url.pathname + url.search);
    if (!silent) render();
  }

  function readLocation() {
    const url = new URL(global.location.href);
    return { path: url.pathname, query: Object.fromEntries(url.searchParams.entries()) };
  }

  async function render() {
    const { path, query } = readLocation();
    const hit = matchRoute(path);
    closeNav();

    if (!SR.state.user) { showLogin(); return; }

    if (!hit) {
      showShell();
      renderNotFound(path);
      return;
    }
    if (!allowed(hit.route)) {
      showShell();
      ui.warn('Your role does not include that screen.');
      setActiveNav(null);
      ui.mount('#view', ui.empty({
        title: 'Not available to your role',
        message: `${hit.route.title || 'That screen'} is for ${(hit.route.roles || []).join(', ')}. You are signed in as ${SR.state.user.role}.`,
        action: { label: 'Back to the dashboard', run: () => navigate('/dashboard') },
        mark: 'lock',
      }));
      return;
    }

    // Tear down whatever the previous screen left running (intervals, listeners).
    for (const fn of cleanupFns) { try { fn(); } catch (e) { /* fine */ } }
    cleanupFns = [];
    currentRoute = hit.route;
    currentParams = hit.params;
    currentQuery = query;

    showShell();
    setActiveNav(hit.route);

    const view = SR.views[hit.route.view];
    if (!view || typeof view.render !== 'function') {
      renderNotFound(path);
      return;
    }

    const host = document.getElementById('view');
    host.replaceChildren();
    const context = {
      route: hit.route,
      params: hit.params,
      query,
      navigate,
      view: hit.route.view,
      onCleanup: (fn) => cleanupFns.push(fn),
      setTitle: (t) => { document.title = `${t} · StockRidge`; },
    };

    try {
      const node = await view.render(context);
      if (!host.contains(node) && node) host.replaceChildren(node);
      else if (!node) { /* the view rendered in place */ }
      document.title = `${hit.route.title || 'StockRidge'} · StockRidge`;
      host.scrollTop = 0;
    } catch (err) {
      if (err && err.isAuth) { handleAuthFailure(); return; }
      host.replaceChildren();
      host.appendChild(ui.errorBlock(err, { retry: { label: 'Try again', run: () => render() } }));
      if (err && err.code !== 'OFFLINE') console.error(`[view:${hit.route.view}]`, err);
    }
  }

  function renderNotFound(path) {
    ui.mount('#view', ui.empty({
      title: 'No such screen',
      message: `${path} is not a page in StockRidge.`,
      action: { label: 'Go to the dashboard', run: () => navigate('/dashboard') },
      mark: 'search',
    }));
  }

  // -------------------------------------------------------------------
  // SHELL
  // -------------------------------------------------------------------
  function showBoot(show = true) {
    document.getElementById('boot').hidden = !show;
  }
  function setBootLine(text, progress = null) {
    const line = document.getElementById('boot-line');
    if (line) line.textContent = text;
    if (progress !== null) {
      const fill = document.getElementById('boot-fill');
      if (fill) fill.style.width = `${U.clamp(progress, 4, 100)}%`;
    }
  }
  function bootError(message, detail) {
    const boot = document.getElementById('boot');
    boot.hidden = false;
    boot.classList.add('is-error');
    setBootLine(message, 100);
    const line = document.getElementById('boot-line');
    if (detail) {
      const p = document.createElement('p');
      p.style.cssText = 'font-size:.78rem;color:#ffd9d2;margin-top:10px;word-break:break-word';
      p.textContent = detail;
      line.after(p);
    }
    const retry = document.createElement('button');
    retry.className = 'btn btn-primary';
    retry.textContent = 'Try again';
    retry.style.marginTop = '16px';
    retry.addEventListener('click', () => global.location.reload());
    line.after(retry);
  }

  function showLogin() {
    showBoot(false);
    document.getElementById('shell').hidden = true;
    document.getElementById('login-screen').hidden = false;
    const u = document.getElementById('login-username');
    if (u && !u.value) setTimeout(() => u.focus(), 60);
    updateNetChrome();
  }

  function showShell() {
    showBoot(false);
    document.getElementById('login-screen').hidden = true;
    document.getElementById('shell').hidden = false;
    // paintIdentity() is decoration: the header, the chips, the user menu. The
    // navigation is the way out of a screen. When a bug in a five-line header
    // update threw, this ran in order and the throw took the whole sidebar with
    // it — every role, every deployment, an empty nav and no way to move.
    // Decoration must never be able to remove navigation.
    try {
      paintIdentity();
    } catch (err) {
      console.error('[chrome] identity paint failed', err);
    }
    buildNav();
    updateNetChrome();
  }

  function paintIdentity() {
    const user = SR.state.user;
    const settings = SR.state.settings || {};
    const brandName = settings.business_name || 'StockRidge';
    const active = SR.state.activeBusiness();
    const name = (active && active.name) || (user && user.business && user.business.name) || brandName;

    setText('brand-name', brandName);
    setText('brand-sub', name);
    setText('nav-business', active ? active.name : '');
    setText('user-initials', U.initials(user && user.fullName));
    setText('menu-name', (user && user.fullName) || '—');
    setText('menu-meta', user ? `${user.roleLabel || user.role}${user.branch ? ` · ${user.branch.name}` : ''}` : '—');
    setText('branch-chip-name', SR.state.activeBranchName());
    setText('build-tag', `v${SR.APP_VERSION}`);
    // The branch chip is only a control when there is a choice to make.
    const chip = document.getElementById('branch-chip');
    if (chip) {
      const multiple = SR.state.branches().length > 1 && SR.state.canSeeAllBranches();
      chip.disabled = !multiple;
      chip.title = multiple ? 'Switch branch' : 'You are pinned to this branch';
      chip.style.cursor = multiple ? 'pointer' : 'default';
    }
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text === null || text === undefined ? '' : String(text);
  }

  function buildNav() {
    const list = document.getElementById('nav-list');
    if (!list) return;
    const role = String((SR.state.user && SR.state.user.role) || '').toUpperCase();
    const groups = new Map();
    for (const route of ROUTES) {
      if (route.nav === false) continue;
      if (!route.roles || !route.roles.includes(role)) continue;
      const group = route.group || 'Other';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(route);
    }
    const frag = document.createDocumentFragment();
    for (const [group, routes] of groups) {
      frag.appendChild(ui.h('div', { class: 'nav-group' }, group));
      for (const route of routes) {
        const btn = ui.h('button', {
          class: 'nav-item',
          dataset: { path: route.path },
          onClick: () => navigate(route.path),
          html: `${icon(route.icon)}<span>${U.esc(route.title)}</span>`,
        });
        frag.appendChild(btn);
      }
    }
    list.replaceChildren(frag);
    setActiveNav(currentRoute);
  }

  function setActiveNav(route) {
    for (const el of document.querySelectorAll('.nav-item')) {
      el.classList.toggle('is-active', Boolean(route) && el.dataset.path === route.path);
    }
  }

  function closeNav() {
    const nav = document.getElementById('sidenav');
    const scrim = document.getElementById('scrim');
    if (nav) nav.classList.remove('is-open');
    if (scrim) scrim.hidden = true;
    const toggle = document.getElementById('nav-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  // -------------------------------------------------------------------
  // NETWORK / QUEUE CHROME
  // -------------------------------------------------------------------
  function updateNetChrome() {
    const chip = document.getElementById('net-chip');
    const text = document.getElementById('net-chip-text');
    const bar = document.getElementById('offline-bar');
    if (!chip || !text) return;
    const online = SR.api.isOnline();
    const syncing = SR.sync && SR.sync.status().running;
    const state = syncing ? 'syncing' : (online ? 'online' : 'offline');
    chip.dataset.state = state;
    text.textContent = syncing ? 'Syncing' : (online ? 'Online' : 'Offline');
    if (bar) {
      bar.hidden = online;
      const t = document.getElementById('offline-bar-text');
      if (t) {
        t.textContent = SR.state.user
          ? 'Everything you do is saved on this device and sent automatically when the line returns.'
          : 'Sign in once with a connection to use this device offline.';
      }
    }
    const loginNet = document.getElementById('login-net');
    if (loginNet) loginNet.textContent = online ? 'Connected' : 'No connection';
    const hint = document.getElementById('login-offline-hint');
    if (hint) {
      // Only promise an offline sign-in if this device actually has a session to
      // fall back on.
      SR.store.metaGet('me').then((cached) => { hint.hidden = online || !cached; }).catch(() => { hint.hidden = true; });
    }
  }

  async function updateQueueChrome() {
    const chip = document.getElementById('queue-chip');
    const count = document.getElementById('queue-count');
    if (!chip || !count) return;
    try {
      const stats = await SR.sync.queueStats();
      count.textContent = String(stats.pending + stats.failed);
      chip.hidden = stats.pending + stats.failed === 0 && stats.synced === 0;
      const bad = stats.failed > 0;
      chip.classList.toggle('chip-queue', !bad);
      if (bad) {
        chip.dataset.failed = 'true';
        chip.textContent = `${stats.failed} failed · ${stats.pending} queued`;
      }
    } catch (e) { /* the store may be mid-upgrade */ }
  }

  // -------------------------------------------------------------------
  // AUTH
  // -------------------------------------------------------------------
  function handleAuthFailure() {
    SR.api.setToken(null);
    SR.state.clear();
    SR.sync.stop();
    showLogin();
    ui.warn('Your session has ended. Sign in again to continue.');
  }

  async function doLogin(ev) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const usernameEl = document.getElementById('login-username');
    const pinEl = document.getElementById('login-pin');
    const errEl = document.getElementById('login-error');
    const submit = document.getElementById('login-submit');
    errEl.hidden = true;

    const username = String(usernameEl.value || '').trim().toLowerCase();
    const pin = String(pinEl.value || '').trim();
    if (!username || !pin) {
      errEl.textContent = 'Enter your username and PIN.';
      errEl.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const result = await SR.api.login({ username, pin });
      SR.api.setToken(result.token);
      void form;
      await SR.state.load({ force: true });
      // The mirror is refreshed straight away so a device that loses its line
      // after signing in still has the catalogue and today's prices.
      SR.sync.start();
      SR.sync.runOnce({ silent: true }).catch(() => {});
      navigate('/dashboard', { replace: true });
      ui.ok(`Welcome, ${result.user ? result.user.fullName : username}.`);
    } catch (err) {
      if (err && err.isOffline) {
        // An offline sign-in is allowed ONLY where this device already holds a
        // session for this username — otherwise the PIN would be checked against
        // nothing at all, which is not a login, it is a bypass.
        const cached = await SR.store.metaGet('me');
        if (cached && cached.user && String(cached.user.username).toLowerCase() === username) {
          await SR.state.loadFromMirror();
          SR.sync.start();
          navigate('/dashboard', { replace: true });
          ui.warn('Signed in offline from this device. Your work will sync when the line returns.');
          return;
        }
        errEl.textContent = 'You are offline and this device has no saved session for that username. Connect once and sign in.';
      } else {
        errEl.textContent = err.message || 'Sign-in failed.';
      }
      errEl.hidden = false;
      pinEl.select();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
      updateNetChrome();
    }
  }

  async function doLogout() {
    const pending = await SR.sync.queueStats().catch(() => ({ pending: 0, failed: 0 }));
    if (pending.pending > 0) {
      const go = await ui.confirmDialog({
        title: 'Work still waiting to sync',
        message: `There ${pending.pending === 1 ? 'is 1 item' : `are ${pending.pending} items`} on this device that the server has not seen yet.`,
        detail: 'Signing out does not delete them, but the next person to sign in on this device will send them. If this is a shared counter till, sync first.',
        confirmLabel: 'Sync now, then sign out',
        cancelLabel: 'Stay signed in',
      });
      if (!go) return;
      try {
        await SR.sync.runOnce({ silent: true });
      } catch (e) { /* the queue survives either way */ }
    }
    await SR.api.logout();
    SR.state.clear();
    SR.sync.stop();
    closeUserMenu();
    showLogin();
    ui.info('Signed out.');
  }

  // -------------------------------------------------------------------
  // USER MENU
  // -------------------------------------------------------------------
  function openUserMenu() {
    const pop = document.getElementById('user-menu-pop');
    const btn = document.getElementById('user-menu');
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeUserMenu() {
    const pop = document.getElementById('user-menu-pop');
    const btn = document.getElementById('user-menu');
    if (pop) pop.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  function toggleUserMenu() {
    const pop = document.getElementById('user-menu-pop');
    if (pop.hidden) openUserMenu(); else closeUserMenu();
  }

  // -------------------------------------------------------------------
  // BRANCH SWITCHER
  // -------------------------------------------------------------------
  function openBranchPicker() {
    const body = ui.h('div', {});
    body.appendChild(ui.h('p', { class: 'hint' }, 'Every number on every screen belongs to the branch you pick here. Stock, cash and reports do not mix between shops.'));
    const list = ui.h('div', { class: 'stack' });
    for (const branch of SR.state.branches()) {
      const isActive = String(branch.id) === String(SR.state.activeBranchId);
      const row = ui.h('button', {
        class: `nav-item ${isActive ? 'is-active' : ''}`,
        style: { justifyContent: 'flex-start' },
        onClick: () => {
          const res = SR.state.setBranch(branch.id);
          if (!res.ok) { ui.warn(res.reason); return; }
          m.close();
          paintIdentity();
          ui.ok(`Now working in ${branch.name}.`);
          render();
        },
      });
      row.appendChild(ui.h('span', { class: 'grow', style: { textAlign: 'left' } },
        ui.h('strong', {}, branch.name),
        ui.h('div', { class: 'hint' }, `${branch.business_name || ''} · ${branch.city || ''} ${branch.state || ''}${branch.is_active ? '' : ' · INACTIVE'}`)));
      if (isActive) row.appendChild(ui.badge('Current', 'badge-good'));
      list.appendChild(row);
    }
    body.appendChild(list);
    const m = ui.openModal({ title: 'Which branch?', body, size: 'narrow' });
  }

  // -------------------------------------------------------------------
  // BOOT
  // -------------------------------------------------------------------
  async function boot() {
    showBoot(true);
    SR.theme.init();

    // 1. the offline store
    setBootLine('Opening the offline store…', 10);
    try {
      await SR.store.open();
      await SR.store.requestPersistence();
    } catch (err) {
      bootError('StockRidge cannot store data on this device.', err.message);
      return;
    }

    // 2. the device identity
    setBootLine('Identifying this device…', 25);
    try { await SR.device.get(); } catch (e) { /* a default id is better than no app */ }
    await SR.print.loadPrefs().catch(() => {});

    // 3. a session that may already exist
    setBootLine('Checking for a saved session…', 45);
    const hasToken = SR.api.hasToken();
    let restored = false;
    if (hasToken) {
      try {
        await SR.state.load({ force: true });
        restored = true;
      } catch (err) {
        if (err && err.isAuth) {
          SR.api.setToken(null);
        } else {
          // The server could not be reached. Fall back to the mirror, because a
          // counter at 7 a.m. with no line still has a day's work to do.
          const cached = await SR.state.loadFromMirror();
          restored = Boolean(cached);
        }
      }
    }

    // 4. a look at the server, either way
    setBootLine(restored ? 'Syncing…' : 'Looking for the server…', 70);
    const reachable = await SR.api.probe({ force: true });
    if (restored && reachable) {
      SR.sync.start();
      await SR.sync.runOnce({ silent: true }).catch(() => {});
    } else if (restored) {
      SR.sync.start(); // it will fire the moment the line returns
    }

    // 5. draw
    setBootLine('Ready.', 100);
    wireChrome();
    if (SR.state.user) {
      showShell();
      await render();
    } else {
      showLogin();
    }
    updateQueueChrome();

    SR.sync.on('change', () => { updateNetChrome(); updateQueueChrome(); });
    SR.api.on('net', () => { updateNetChrome(); updateQueueChrome(); });
    SR.api.on('auth', () => handleAuthFailure());
    SR.state.on('branch', () => { paintIdentity(); void updateQueueChrome(); });
    SR.state.on('business', () => paintIdentity());
  }

  function wireChrome() {
    document.getElementById('nav-toggle').addEventListener('click', () => {
      const nav = document.getElementById('sidenav');
      const scrim = document.getElementById('scrim');
      const open = !nav.classList.contains('is-open');
      nav.classList.toggle('is-open', open);
      scrim.hidden = !open;
      document.getElementById('nav-toggle').setAttribute('aria-expanded', String(open));
    });
    document.getElementById('nav-close').addEventListener('click', closeNav);
    document.getElementById('scrim').addEventListener('click', closeNav);
    document.getElementById('theme-toggle').addEventListener('click', () => SR.theme.toggle());
    document.getElementById('login-theme').addEventListener('click', () => SR.theme.toggle());
    document.getElementById('branch-chip').addEventListener('click', () => {
      if (SR.state.branches().length > 1 && SR.state.canSeeAllBranches()) openBranchPicker();
      else ui.info(`You are pinned to ${SR.state.activeBranchName()}. An owner can move you to another branch.`);
    });
    document.getElementById('queue-chip').addEventListener('click', () => navigate('/sync'));
    document.getElementById('user-menu').addEventListener('click', (ev) => { ev.stopPropagation(); toggleUserMenu(); });
    document.getElementById('menu-logout').addEventListener('click', doLogout);
    document.getElementById('nav-signout').addEventListener('click', doLogout);
    document.getElementById('menu-print-test').addEventListener('click', () => {
      closeUserMenu();
      SR.print.preview(SR.print.testPage({ brand: (SR.state.settings || {}).business_name || 'StockRidge' }), { title: 'Printer test' });
    });
    for (const el of document.querySelectorAll('[data-go]')) {
      el.addEventListener('click', () => { closeUserMenu(); navigate(el.dataset.go); });
    }
    document.addEventListener('click', (ev) => {
      const pop = document.getElementById('user-menu-pop');
      if (pop && !pop.hidden && !pop.contains(ev.target) && ev.target.id !== 'user-menu') closeUserMenu();
    });

    document.getElementById('login-form').addEventListener('submit', doLogin);
    document.getElementById('login-reveal').addEventListener('click', () => {
      const pin = document.getElementById('login-pin');
      const btn = document.getElementById('login-reveal');
      const show = pin.type === 'password';
      pin.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
    });

    global.addEventListener('popstate', () => render());

    // A queued sale must not be lost to a stray back-navigation on the POS.
    global.addEventListener('beforeunload', (ev) => {
      if (currentRoute && currentRoute.view === 'pos') {
        // Only warn when there is something to lose: an empty cart leaving is
        // fine, and warning on it trains people to dismiss the warning.
        const cart = SR.state.loadCart();
        if (cart && Array.isArray(cart.lines) && cart.lines.length) {
          ev.preventDefault();
          ev.returnValue = '';
        }
      }
    });

    // Anything the POS queued while the tab was hidden should go out promptly.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { updateNetChrome(); updateQueueChrome(); }
    });
  }

  // -------------------------------------------------------------------
  SR.views = SR.views || {};
  SR.app = {
    ROUTES, ICONS, icon, iconPath,
    boot, render, navigate, matchRoute, allowed,
    showLogin, showShell, paintIdentity, buildNav, setActiveNav, closeNav,
    updateNetChrome, updateQueueChrome, handleAuthFailure, doLogout,
    openModal: ui.openModal,
    get route() { return currentRoute; },
    get params() { return currentParams; },
    get query() { return currentQuery; },
    onCleanup: (fn) => cleanupFns.push(fn),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot().catch((e) => bootError('StockRidge failed to start.', e.message)));
  else boot().catch((e) => bootError('StockRidge failed to start.', e.message));
}(window));
