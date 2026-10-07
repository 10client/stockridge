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
  SR.BUILD = 'ridge-20261007-1235-dd90aa3';

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
    // The nav has listed 'change-owed' for every role since the navigation was written;
    // this is the screen it was pointing at.
    { path: '/change-owed', title: 'Change owed', group: 'Customers', view: 'change-owed', icon: 'cash', roles: ['STAFF', 'MANAGER', 'OWNER'] },
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
    // ARROWS FOR A FIGURE THAT MOVED. A trend is a fact about a number, and the number it
    // is a fact about is usually one line up: the arrow has to be the one the figure
    // actually went, or it is decoration that lies at a glance.
    trendUp: 'M12 19V6M5 12l7-6 7 6',
    trendDown: 'M12 5v13M19 12l-7 6-7-6',
    trendFlat: 'M5 12h14',
    // A COUNT WITH NO UNIT: transactions, lines, seats, claims.
    hash: 'M5 9h14M5 15h14M10 4l-2 16M16 4l-2 16',
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

  /**
   * THE SHOP'S NAME AT THE FRONT DOOR, BEFORE ANYBODY HAS SIGNED IN.
   *
   * `GET /api/branding` is public for exactly this, and nothing called it: the sign-in screen
   * showed the hardcoded vendor name "StockRidge" while the router's own comment promised
   * "a cashier at Ridge Furniture Palace should see their shop's name, not the vendor's".
   * A white-label product that shows someone else's brand at the front door is not
   * white-labelled.
   *
   * TWO SOURCES, IN THIS ORDER: the last branding this device saw (cached, so a cold start on
   * a dead line still shows the client's name — this is an offline-first product), then the
   * server. A failure changes nothing: the shell's markup is the fallback.
   */
  async function paintLoginBrand() {
    const apply = (b) => {
      if (!b || !b.name) return;
      setText('login-brand-name', b.name);
      setText('login-brand-sub', b.receiptFooter || 'Multi-branch stock, sales and accounting');
      document.title = b.name;
      const img = document.getElementById('login-brand-logo');
      const mark = document.getElementById('login-brand-mark');
      if (img && mark) {
        const hasLogo = Boolean(b.logoDataUrl);
        img.hidden = !hasLogo;
        mark.hidden = hasLogo;
        if (hasLogo) img.src = b.logoDataUrl;
      }
    };
    try {
      const cached = JSON.parse(localStorage.getItem('sr.brand') || 'null');
      if (cached) apply(cached);
    } catch (err) { /* a corrupt cache is not a reason to show nothing */ }
    try {
      const fresh = await SR.api.get('/api/branding');
      if (fresh && fresh.name) {
        apply(fresh);
        try { localStorage.setItem('sr.brand', JSON.stringify(fresh)); } catch (err) { /* full or blocked storage */ }
      }
    } catch (err) { /* offline, or the deployment has no settings row yet: the shell's markup stands */ }
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
    // Decoration too: it reads ids the shell owns, and a throw here would take the
    // rest of `showShell` with it.
    try { updateSubscriptionChrome(); } catch (err) { console.error('[chrome] subscription paint failed', err); }
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
  // SUBSCRIPTION CHROME
  // -------------------------------------------------------------------
  // A SUSPENSION IS A DECISION, NOT A NETWORK STATE.
  //
  // The server refuses every trading write on a suspended account with a message that
  // names the status, says that reading and exporting still work, and gives the contact
  // line. Before this bar, the only person who ever read that message was the one who
  // happened to press Save — everyone else met it as a toast in the middle of a queue of
  // customers, with the reason gone in nine seconds.
  //
  // The status and the contact line are already in the settings the app loads at boot
  // (`publicSettings`), and they are mirrored for offline use, so this costs no request.
  // The vendor seat is marked differently rather than hidden: an administrator working on
  // a suspended client's instance is not gated by it, and a red bar saying "your service
  // is paused" to the person fixing it would be a lie.
  const PAUSED_STATUSES = ['SUSPENDED', 'EXPIRED'];

  function subscriptionState() {
    const st = SR.state.settings || {};
    const user = SR.state.user || {};
    const status = String(st.subscription_status || 'ACTIVE').toUpperCase();
    const contact = [st.admin_contact_name, st.admin_contact_phone, st.admin_contact_email]
      .filter(Boolean).join(', ') || 'your StockRidge account manager';
    return {
      status,
      paused: PAUSED_STATUSES.includes(status),
      vendor: String(user.role || '').toUpperCase() === 'ADMIN',
      owner: ['OWNER', 'ADMIN'].includes(String(user.role || '').toUpperCase()),
      renewal: st.subscription_renewal_date || null,
      contact,
      signedIn: Boolean(user && user.id),
    };
  }

  function subscriptionLine(st) {
    const when = st.renewal ? ` (renewal date ${st.renewal})` : '';
    if (st.vendor) {
      return `This client's subscription is ${st.status}${when}. You are not gated by it — the client cannot sell, buy, move stock, take payments or record expenses until it is restored.`
        + ` Restore it on the Subscription screen.`;
    }
    return `The subscription is ${st.status}${when}. Everything here is still readable and exportable —`
      + ` imports, sales, purchases, stock movements, payments and expenses are paused until it is restored.`
      + ` Please contact ${st.contact} to restore service.`;
  }

  /**
   * Paint the bar from the settings already in hand. Called on boot, on every
   * `loaded`, and whenever the server refuses a write for this reason — a shop whose
   * cached copy says ACTIVE must still be told the moment a write is refused.
   */
  function updateSubscriptionChrome() {
    const bar = document.getElementById('subscription-bar');
    if (!bar) return;
    const st = subscriptionState();
    const show = st.signedIn && st.paused;
    bar.hidden = !show;
    if (!show) return;
    bar.classList.toggle('is-vendor', st.vendor);
    setText('subscription-bar-title', st.vendor ? 'Client suspended.' : (st.status === 'EXPIRED' ? 'Subscription expired.' : 'Service paused.'));
    setText('subscription-bar-text', subscriptionLine(st));
    const link = document.getElementById('subscription-bar-link');
    if (link) {
      const reachable = st.owner;   // the Subscription screen is OWNER+ only
      link.hidden = !reachable;
      link.textContent = st.vendor ? 'Subscription' : 'See what is affected';
    }
  }

  /** Re-read the settings row and repaint. Cheap, and only ever called on a refusal. */
  async function refreshSubscriptionChrome() {
    try {
      const res = await SR.api.get('/api/settings');
      if (res && res.settings) SR.state.settings = res.settings;
    } catch (err) {
      // Offline, or the read itself failed: the cached copy is what the bar draws from
      // and it is better than nothing. Never throw out of a chrome repaint.
    }
    updateSubscriptionChrome();
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
  // ALERTS
  // -------------------------------------------------------------------
  //
  // THE BELL READS THE LIST, NOT A COUNT. `GET /api/notifications` returns the rows the
  // caller can see plus the unread total, and both come from the SAME scope — which is
  // the rule this screen depends on, because a badge showing three and a panel showing
  // two is how a person learns to distrust the badge.
  //
  // Nothing is mirrored for offline: an alert about a permit expiring is a fact from the
  // office, and a stale alert list on a till that has been offline for a week is worse
  // than saying "you are offline". Reads are never queued in this app, and this is a read.
  let bellItems = [];
  let bellPollTimer = null;

  async function updateBell({ refreshPanel = false } = {}) {
    const btn = document.getElementById('bell-btn');
    const badge = document.getElementById('bell-count');
    if (!btn || !badge) return;
    try {
      const res = await SR.api.get('/api/notifications', { query: { limit: 25 } });
      bellItems = (res && (res.data || res.rows)) || [];
      const unread = Number(res && res.unread) || 0;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.hidden = unread === 0;
      btn.dataset.unread = String(unread);
      btn.title = unread ? `${unread} unread alert(s)` : 'No unread alerts';
      const pop = document.getElementById('bell-pop');
      if (refreshPanel && pop && !pop.hidden) paintBellPanel(bellItems, unread);
    } catch (err) {
      // Offline, or the deployment is mid-deploy. The badge keeps whatever it had rather
      // than claiming there is nothing to see.
      btn.title = err && err.isOffline ? 'Alerts need a connection' : 'Alerts could not be checked';
    }
  }

  function bellMetaFor(n) {
    const bits = [];
    if (n.branch_name) bits.push(n.branch_name);
    else if (n.user_id) bits.push('For you');
    else bits.push('Whole business');
    // A branch alert is a shared work item — one `is_read` column, cleared for the shop
    // by whoever deals with it, and raised again by the daily sweep until the record
    // itself is renewed. Said out loud so two people do not both go and renew the same
    // licence, and so nobody is surprised that clearing it cleared it for a colleague.
    if (!n.user_id && n.branch_name) bits.push('shared with the branch');
    bits.push(U.dateTime(n.created_at, { zone: 'wat' }));
    return bits.join(' · ');
  }

  /** Where an alert's subject lives, so a row can be acted on rather than only read. */
  const BELL_ROUTES = {
    COMPLIANCE_EXPIRY: '/compliance',
    LOW_STOCK: '/stock?filter=low',
    EXPIRY: '/stock?filter=expiring',
    CREDIT_OVERDUE: '/customers?tab=debtors',
    INSTALLMENT_DUE: '/instalments',
    WARRANTY_EXPIRING: '/returns?tab=warranty',
    SYNC_CONFLICT: '/sync',
    STOCKTAKE_VARIANCE: '/stocktake',
  };

  function paintBellPanel(items, unread) {
    const list = document.getElementById('bell-list');
    const sub = document.getElementById('bell-sub');
    const foot = document.getElementById('bell-foot-note');
    if (!list) return;
    if (sub) sub.textContent = unread ? `${unread} unread` : 'nothing unread';
    if (foot) foot.textContent = 'The daily sweep raises an expiry alert again until the record is renewed.';
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(ui.h('div', { class: 'bell-empty' }, 'Nothing needs your attention.'));
      return;
    }
    for (const n of items) {
      const read = Number(n.is_read) === 1;
      const row = ui.h('button', {
        class: `bell-item ${read ? 'is-read' : ''}`,
        onClick: () => openAlert(n),
      });
      const top = ui.h('div', { class: 'bell-row' },
        ui.h('span', { class: `bell-dot sev-${String(n.severity || 'INFO').toUpperCase()}` }),
        ui.h('div', {},
          ui.h('div', { class: 'bell-title' }, n.title || 'Alert'),
          n.body ? ui.h('div', { class: 'bell-body' }, n.body) : null));
      row.appendChild(top);
      row.appendChild(ui.h('div', { class: 'bell-meta' }, bellMetaFor(n)));
      list.appendChild(row);
    }
  }

  async function openAlert(n) {
    try {
      if (!Number(n.is_read)) await SR.api.post(`/api/notifications/${encodeURIComponent(n.id)}/read`, {});
    } catch (err) { /* the alert is still worth acting on if marking it fails */ }
    await updateBell({ refreshPanel: true });
    const target = BELL_ROUTES[String(n.type || '').toUpperCase()];
    if (target) { closeBell(); navigate(target); }
  }

  async function markAllRead() {
    const btn = document.getElementById('bell-read-all');
    if (btn) { btn.disabled = true; btn.textContent = 'Marking…'; }
    try {
      const res = await SR.api.post('/api/notifications/read-all', {});
      ui.ok((res && res.message) || 'Alerts marked read.');
    } catch (err) {
      ui.apiError(err);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Mark all read'; }
      await updateBell({ refreshPanel: true });
    }
  }

  function openBell() {
    const pop = document.getElementById('bell-pop');
    const btn = document.getElementById('bell-btn');
    if (!pop) return;
    closeUserMenu();
    paintBellPanel(bellItems, Number(btn && btn.dataset.unread) || 0);
    pop.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }
  function closeBell() {
    const pop = document.getElementById('bell-pop');
    const btn = document.getElementById('bell-btn');
    if (pop) pop.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  function toggleBell() {
    const pop = document.getElementById('bell-pop');
    if (!pop) return;
    if (pop.hidden) { openBell(); void updateBell({ refreshPanel: true }); } else closeBell();
  }

  function startBellPolling() {
    void updateBell();
    if (bellPollTimer) clearInterval(bellPollTimer);
    // Every five minutes: an expiry alert is not a second-by-second fact, and the sweep
    // that raises them runs daily.
    bellPollTimer = setInterval(() => { void updateBell({ refreshPanel: true }); }, 5 * 60 * 1000);
  }

  // -------------------------------------------------------------------
  // AUTH
  // -------------------------------------------------------------------
  function handleAuthFailure() {
    SR.api.setToken(null);
    SR.state.clear();
    SR.sync.stop();
    // No token, no alerts — and a poll that keeps running after sign-out is a poll that
    // keeps 401-ing, which the API layer would report as the session having ended again.
    if (bellPollTimer) { clearInterval(bellPollTimer); bellPollTimer = null; }
    const badge = document.getElementById('bell-count');
    if (badge) { badge.hidden = true; badge.textContent = '0'; }
    closeBell();
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
      updateSubscriptionChrome();
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
    // Two panels anchored to the same corner of the same bar: opening one has to close
    // the other, or they overlap and the lower one wins on z-index by accident.
    closeBell();
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
        updateSubscriptionChrome();
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
    // Before the login screen is shown, so the client's name is painted rather than replaced
    // a moment later in front of somebody typing their PIN.
    await paintLoginBrand().catch(() => {});
    if (SR.state.user) {
      showShell();
      await render();
    } else {
      showLogin();
    }
    updateQueueChrome();

    startBellPolling();
    SR.sync.on('change', () => { updateNetChrome(); updateQueueChrome(); });
    SR.api.on('net', () => { updateNetChrome(); updateQueueChrome(); updateSubscriptionChrome(); });
    // A REFUSED WRITE IS THE MOST RELIABLE SIGNAL THERE IS. The cached settings can be
    // minutes or days old (they are mirrored for offline use); a 402 naming the
    // suspension is the server saying it just now. Re-read and repaint rather than trust
    // the copy.
    SR.api.on('plan', () => { refreshSubscriptionChrome(); });
    const subLink = document.getElementById('subscription-bar-link');
    if (subLink) subLink.addEventListener('click', () => navigate('/plan'));
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
    document.getElementById('bell-btn').addEventListener('click', (ev) => { ev.stopPropagation(); toggleBell(); });
    document.getElementById('bell-read-all').addEventListener('click', (ev) => { ev.stopPropagation(); void markAllRead(); });
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
      const bellPop = document.getElementById('bell-pop');
      if (bellPop && !bellPop.hidden && !bellPop.contains(ev.target) && ev.target.id !== 'bell-btn') closeBell();
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
      if (document.visibilityState === 'visible') { updateNetChrome(); updateQueueChrome(); void updateBell({ refreshPanel: true }); }
    });
  }

  // -------------------------------------------------------------------
  SR.views = SR.views || {};
  SR.app = {
    ROUTES, ICONS, icon, iconPath,
    boot, render, navigate, matchRoute, allowed,
    showLogin, showShell, paintIdentity, paintLoginBrand, buildNav, setActiveNav, closeNav,
    updateBell, openBell, closeBell, markAllRead,
    updateNetChrome, updateQueueChrome, handleAuthFailure, doLogout,
    updateSubscriptionChrome, refreshSubscriptionChrome, subscriptionState,
    openModal: ui.openModal,
    get route() { return currentRoute; },
    get params() { return currentParams; },
    get query() { return currentQuery; },
    onCleanup: (fn) => cleanupFns.push(fn),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot().catch((e) => bootError('StockRidge failed to start.', e.message)));
  else boot().catch((e) => bootError('StockRidge failed to start.', e.message));
}(window));
