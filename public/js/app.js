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
  SR.BUILD = 'ridge-20261018-0648-50580e7';

  // -------------------------------------------------------------------
  // INSTALL
  // -------------------------------------------------------------------
  // The top bar offers Download only when this visit can still install: the
  // browser has handed us a prompt, or it is Safari. The sidebar Install button
  // is a different question. Deleting the home-screen icon does not uninstall
  // the app, and a browser that still has that old copy will not fire
  // `beforeinstallprompt` again — so a button that waits for that event is
  // hidden at the only moment someone needs to put the icon back. The sidebar
  // button stays for every browser that can install, including inside an
  // already-installed window, and the steps say how to clear the leftover copy.
  let installPrompt = null;
  let browserOfferedInstall = false;

  function runningAsInstalledApp() {
    try {
      if (navigator.standalone === true) return true;
      return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].some((mode) =>
        window.matchMedia(`(display-mode: ${mode})`).matches);
    } catch (e) {
      return false;
    }
  }

  function iosDevice() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/i.test(ua)) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }

  function inAppBrowser() {
    return /FBAN|FBAV|Instagram|Line\/|Twitter|LinkedInApp|Snapchat|TikTok|musical_ly|WhatsApp/i.test(navigator.userAgent || '');
  }

  function safariCanInstall() {
    if (inAppBrowser() || !window.isSecureContext) return false;
    if (iosDevice()) return true;
    const ua = navigator.userAgent || '';
    return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|Android/i.test(ua);
  }

  function chromiumCanInstall() {
    if (inAppBrowser() || !window.isSecureContext) return false;
    const ua = navigator.userAgent || '';
    if (/Firefox|FxiOS/i.test(ua)) return false;
    return /Chrome|Chromium|CriOS|Edg|EdgiOS|SamsungBrowser|OPR|Opera/i.test(ua);
  }

  function installCompatible() {
    if (runningAsInstalledApp()) return false;
    if (installPrompt || browserOfferedInstall) return true;
    return safariCanInstall();
  }

  /** The sidebar button is the way back after a deleted icon. It does not wait
   *  for a prompt the browser will refuse to send while the old install remains. */
  function sidebarInstallVisible() {
    if (inAppBrowser() || !window.isSecureContext) return false;
    return chromiumCanInstall() || safariCanInstall() || Boolean(installPrompt);
  }

  function paintInstallButton() {
    const fresh = installCompatible();
    const top = document.getElementById('install-btn');
    const login = document.getElementById('login-install');
    const nav = document.getElementById('nav-install');
    if (top) top.hidden = !fresh;
    if (login) login.hidden = !fresh;
    if (nav) nav.hidden = !sidebarInstallVisible();
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep the prompt for our button. The browser's own banner would otherwise
    // consume it, and a till that already has a Download control does not need both.
    event.preventDefault();
    installPrompt = event;
    browserOfferedInstall = true;
    paintInstallButton();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    browserOfferedInstall = false;
    paintInstallButton();
  });
  try {
    const installedMq = window.matchMedia('(display-mode: standalone)');
    if (installedMq && installedMq.addEventListener) installedMq.addEventListener('change', paintInstallButton);
  } catch (e) { /* the next paint still hides the button once the app is standalone */ }

  function openInstallHelp() {
    const ios = iosDevice();
    const macSafari = !ios && safariCanInstall();
    const body = ui.h('div', { class: 'stack' });
    const steps = ui.h('ol', { class: 'install-steps' });
    if (ios || macSafari) {
      body.appendChild(ui.h('p', {}, ios
        ? 'This device can keep StockRidge on the Home Screen. The browser does not open a download window, so it takes three taps.'
        : 'This Mac can keep StockRidge in the Dock. Safari does not open a download window, so it takes three clicks.'));
      steps.appendChild(ui.h('li', {}, ios ? 'Tap the Share button — the square with an arrow pointing up.' : 'Click the Share button in the toolbar.'));
      steps.appendChild(ui.h('li', {}, ios ? 'Scroll the sheet and tap Add to Home Screen.' : 'Choose Add to Dock.'));
      steps.appendChild(ui.h('li', {}, 'Confirm. The icon then opens StockRidge on its own, and it keeps working offline.'));
      if (/CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent || '')) {
        body.appendChild(ui.h('p', { class: 'hint' }, 'If Add to Home Screen is not in the sheet, open this page in Safari and use Share there.'));
      }
    } else {
      body.appendChild(ui.h('p', {}, 'If you installed StockRidge and then deleted the icon, the browser may still be holding that copy. It will not offer a new install until the old one is removed.'));
      steps.appendChild(ui.h('li', {}, 'Open the browser menu. If Install app is there, choose it and confirm.'));
      steps.appendChild(ui.h('li', {}, 'If the menu says Open in app instead, the old copy is still installed. On a phone, open Settings, then Apps, find StockRidge and uninstall it. On a computer, type chrome://apps or edge://apps in the address bar, find StockRidge, and remove it.'));
      steps.appendChild(ui.h('li', {}, 'Come back to this page and tap Install again. That puts the icon back, and the till keeps working offline.'));
    }
    body.appendChild(steps);
    closeNav();
    ui.openModal({ title: 'Install StockRidge', body, size: 'narrow' });
  }

  async function downloadApp() {
    const prompt = installPrompt;
    // A window that is already the installed app will not be given a prompt.
    // Falling through shows how to remove the leftover copy and install again.
    if (prompt && !runningAsInstalledApp()) {
      // prompt() has to run inside the tap. Anything awaited before it, and the
      // browser treats the download as not requested by the person.
      installPrompt = null;
      const buttons = ['install-btn', 'nav-install', 'login-install']
        .map((id) => document.getElementById(id)).filter(Boolean);
      buttons.forEach((el) => { el.disabled = true; });
      try {
        prompt.prompt();
        const result = await prompt.userChoice;
        if (result && result.outcome === 'accepted') {
          browserOfferedInstall = false;
          ui.ok('StockRidge is downloading onto this device.');
        }
      } catch (e) {
        openInstallHelp();
      } finally {
        buttons.forEach((el) => { el.disabled = false; });
        paintInstallButton();
      }
      return;
    }
    openInstallHelp();
  }

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
    { path: '/sales/issues', title: 'Flagged sales', group: 'Today', view: 'sales', icon: 'receipt', roles: ['STAFF', 'MANAGER', 'OWNER'] },
    { path: '/hire-book', title: 'Hire book', group: 'Today', view: 'hire-book', icon: 'calendar', roles: ['STAFF', 'MANAGER', 'OWNER'], module: 'hireBook' },

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
    { path: '/instalments', title: 'Instalments & layaway', group: 'Customers', view: 'instalments', icon: 'calendar', roles: ['STAFF', 'MANAGER', 'OWNER'], module: 'instalments' },
    { path: '/deliveries', title: 'Deliveries & installs', group: 'Customers', view: 'deliveries', icon: 'truck', roles: ['STAFF', 'MANAGER', 'OWNER'], module: 'deliveries' },
    { path: '/fleet', title: 'Vehicles', group: 'Today', view: 'fleet', icon: 'truck', roles: ['STAFF', 'MANAGER', 'OWNER', 'ADMIN'], module: 'dispatch' },
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
    { path: '/fleet/:id', view: 'fleet', nav: false, roles: ['STAFF', 'MANAGER', 'OWNER', 'ADMIN'], module: 'dispatch' },
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
    if (route.module && !(SR.state.moduleOn && SR.state.moduleOn(route.module))) return false;
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

  let renderToken = 0;

  async function render() {
    const token = ++renderToken;
    const { path, query } = readLocation();
    const hit = matchRoute(path);
    closeNav();

    if (!SR.state.user) { ui.endPageNow(); showLogin(); return; }

    if (!hit) {
      showShell();
      const seq = ui.beginPage('Opening');
      renderNotFound(path);
      if (token === renderToken) await ui.endPage(seq);
      return;
    }
    if (!allowed(hit.route)) {
      showShell();
      const wrongModule = hit.route.module && !(SR.state.moduleOn && SR.state.moduleOn(hit.route.module));
      const seq = ui.beginPage(hit.route.title || 'Opening');
      ui.warn(wrongModule ? 'That belongs to another kind of business.' : 'Your role does not include that screen.');
      setActiveNav(null);
      ui.mount('#view', ui.empty({
        title: wrongModule ? 'Not part of this business' : 'Not available to your role',
        message: wrongModule
          ? `${hit.route.title || 'That screen'} is only there for a business that uses it. Switch to that business, or stay on the screens this one has.`
          : `${hit.route.title || 'That screen'} is for ${(hit.route.roles || []).join(', ')}. You are signed in as ${SR.state.user.role}.`,
        action: { label: 'Back to the dashboard', run: () => navigate('/dashboard') },
        mark: 'lock',
      }));
      if (token === renderToken) await ui.endPage(seq);
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
      const seq = ui.beginPage(hit.route.title || 'Opening');
      renderNotFound(path);
      await ui.endPage(seq);
      return;
    }

    const host = document.getElementById('view');
    const quick = hit.route.view === 'pos' || hit.route.view === 'till';
    const pageSeq = ui.beginPage(hit.route.title || 'Opening', { quick });
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
      if (token !== renderToken) return;
      if (!host.contains(node) && node) host.replaceChildren(node);
      else if (!node) { /* the view rendered in place */ }
      document.title = `${hit.route.title || 'StockRidge'} · StockRidge`;
      host.scrollTop = 0;
    } catch (err) {
      if (token !== renderToken) return;
      if (err && err.isAuth) { void handleAuthFailure({ reason: err.code, token: err.token, message: err.message }); return; }
      host.replaceChildren();
      host.appendChild(ui.errorBlock(err, { retry: { label: 'Try again', run: () => render() } }));
      if (err && err.code !== 'OFFLINE') console.error(`[view:${hit.route.view}]`, err);
    } finally {
      if (token === renderToken) await ui.endPage(pageSeq);
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
  // The stamp has to travel with the file. The service worker precaches the
  // stamped URL, and a bare path is a different cache key — offline, that is a
  // missing logo. A cached branding payload from before this mark existed must
  // not send the till back to the old wordmark either.
  function defaultMarkUrl(b) {
    const fromApi = b && b.defaultLogoUrl;
    const chosen = (fromApi && String(fromApi).indexOf('/brand/mark') === 0) ? String(fromApi) : '/brand/mark.svg';
    if (!SR.BUILD || /[?&]v=/.test(chosen)) return chosen;
    return chosen + '?v=' + SR.BUILD;
  }

  function applyBrandMark(b) {
    const custom = b && b.logoDataUrl ? b.logoDataUrl : '';
    const name = (b && b.name) || 'StockRidge';
    const img = document.getElementById('login-brand-logo');
    const brand = document.getElementById('login-brand');
    const nameEl = document.getElementById('login-brand-name');
    if (img) {
      img.hidden = false;
      img.src = custom || defaultMarkUrl(b);
      img.alt = name;
      img.classList.toggle('is-custom', Boolean(custom));
    }
    if (brand) brand.classList.toggle('is-custom', Boolean(custom));
    setText('login-brand-name', name);
    // The default mark is an icon. It does not contain the words, so the trading
    // name stays in type even when the shop has not renamed itself.
    if (nameEl) nameEl.hidden = false;
    const appMark = document.getElementById('app-mark');
    if (appMark) {
      appMark.src = custom || defaultMarkUrl(b);
      appMark.alt = name;
      appMark.classList.toggle('is-custom', Boolean(custom));
    }
  }

  async function paintLoginBrand() {
    const apply = (b) => {
      if (!b || !b.name) return;
      setText('login-brand-sub', b.receiptFooter || 'Multi-branch stock, sales and accounting');
      document.title = b.name;
      applyBrandMark(b);
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

  const TILL_KEY = 'sr.till';
  function readTill() {
    try { return JSON.parse(localStorage.getItem(TILL_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeTill(value) {
    try {
      if (value) localStorage.setItem(TILL_KEY, JSON.stringify({ username: value.username || '', remember: Boolean(value.remember) }));
      else localStorage.removeItem(TILL_KEY);
    } catch (e) { /* private mode: the session still lives for this tab */ }
  }
  function applyRememberedLogin() {
    const till = readTill();
    const u = document.getElementById('login-username');
    const box = document.getElementById('login-remember');
    if (u && till && till.username && !u.value) u.value = till.username;
    if (box) box.checked = !till || till.remember !== false;
  }

  function showLogin() {
    ui.endPageNow();
    showBoot(false);
    document.getElementById('shell').hidden = true;
    document.getElementById('login-screen').hidden = false;
    paintDisplacedNotice();
    applyRememberedLogin();
    const u = document.getElementById('login-username');
    if (u && !u.value) setTimeout(() => u.focus(), 60);
    updateNetChrome();
    paintInstallButton();
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
    paintInstallButton();
  }

  function paintIdentity() {
    const user = SR.state.user;
    const settings = SR.state.settings || {};
    const brandName = settings.business_name || 'StockRidge';
    const active = SR.state.activeBusiness();
    const name = (active && active.name) || (user && user.business && user.business.name) || brandName;
    const working = SR.state.activeBusinessName(name);
    const canBiz = SR.state.canSwitchBusiness();
    const canBranch = SR.state.canSwitchBranch();

    setText('brand-name', brandName);
    setText('brand-sub', working);
    applyBrandMark({ name: brandName, logoDataUrl: settings.logo_data_url || '' });
    setText('nav-business', working);
    setText('business-chip-name', working);
    setText('user-initials', U.initials(user && user.fullName));
    setText('menu-name', (user && user.fullName) || '—');
    const coOwner = user && (user.coOwner || user.roleLabel === 'Co-owner');
    const reach = user && user.branch
      ? ` · ${user.branch.name}`
      : (coOwner ? ` · ${SR.state.businesses().length} business${SR.state.businesses().length === 1 ? '' : 'es'}` : '');
    setText('menu-meta', user ? `${user.roleLabel || user.role}${reach}` : '—');
    setText('branch-chip-name', SR.state.activeBranchName());
    setText('build-tag', `v${SR.APP_VERSION}`);
    const bizSwitch = document.getElementById('business-switch');
    const bizHint = document.getElementById('business-switch-hint');
    if (bizSwitch) {
      bizSwitch.classList.toggle('is-switch', canBiz);
      bizSwitch.disabled = !canBiz;
      bizSwitch.title = canBiz ? 'Switch business' : (working || 'Business');
    }
    if (bizHint) bizHint.hidden = !canBiz;
    const bizChip = document.getElementById('business-chip');
    if (bizChip) {
      bizChip.hidden = !canBiz;
      bizChip.disabled = !canBiz;
      bizChip.title = canBiz ? 'Switch business' : working;
    }
    const sendMsg = document.getElementById('bell-send');
    if (sendMsg) {
      const role = String((user && user.role) || '').toUpperCase();
      sendMsg.hidden = role !== 'OWNER' && role !== 'ADMIN';
    }
    // The branch chip is only a control when there is a choice to make.
    const chip = document.getElementById('branch-chip');
    if (chip) {
      chip.disabled = !canBranch;
      chip.title = canBranch ? 'Switch branch' : 'You are pinned to this branch';
      chip.style.cursor = canBranch ? 'pointer' : 'default';
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
      if (route.module && !(SR.state.moduleOn && SR.state.moduleOn(route.module))) continue;
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
          : 'Sign in once with a connection. After that this till sells from the stock last recorded here.';
      }
    }
    const loginNet = document.getElementById('login-net');
    if (loginNet) loginNet.textContent = online ? 'Connected' : 'No connection';
    const hint = document.getElementById('login-offline-hint');
    const cont = document.getElementById('login-offline-continue');
    if (hint || cont) {
      // Only promise an offline sign-in if this device actually has a session to
      // fall back on, and only auto-continue when the till was asked to stay signed in.
      SR.store.metaGet('me').then((cached) => {
        const till = readTill();
        const canContinue = Boolean(cached && cached.user && till && till.remember);
        if (hint) hint.hidden = online || !cached;
        if (cont) cont.hidden = online || !canContinue;
      }).catch(() => {
        if (hint) hint.hidden = true;
        if (cont) cont.hidden = true;
      });
    }
  }

  /**
   * The count lives in `#queue-count` and must survive every refresh.
   *
   * A refused sale used to replace the chip's text, which deleted that span. The
   * next refresh then returned early (`if (!count) return`), so the number froze.
   * On a phone the chip's own words are `font-size: 0` and only `#queue-count`
   * is visible — wiping the span hides the count entirely.
   */
  function ensureQueueChip() {
    const chip = document.getElementById('queue-chip');
    if (!chip) return null;
    let count = document.getElementById('queue-count');
    let label = document.getElementById('queue-label');
    if (!count || !label) {
      chip.replaceChildren();
      count = document.createElement('span');
      count.id = 'queue-count';
      label = document.createElement('span');
      label.id = 'queue-label';
      label.textContent = ' queued';
      chip.append(count, label);
    }
    chip.classList.add('chip-queue');
    return { chip, count, label };
  }

  async function updateQueueChrome() {
    const parts = ensureQueueChip();
    if (!parts) return;
    const { chip, count, label } = parts;
    try {
      const stats = await SR.sync.queueStats();
      const waiting = Number(stats.pending || 0) + Number(stats.failed || 0);
      count.textContent = String(waiting);
      // Nothing waiting means nothing to count. A sale that has already uploaded
      // is not queued, and leaving "0 queued" up trained people to ignore the chip.
      chip.hidden = waiting === 0;
      const bad = Number(stats.failed || 0) > 0;
      chip.classList.toggle('is-failed', bad);
      if (bad) chip.dataset.failed = 'true';
      else delete chip.dataset.failed;
      label.textContent = bad ? ' need attention' : ' queued';
      chip.title = bad
        ? `${stats.failed} refused, ${stats.pending} still waiting to upload`
        : `${waiting} waiting to upload`;
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
    if (String(n.type || '').toUpperCase() === 'MESSAGE') bits.push('Message');
    if (n.business_name) bits.push(n.business_name);
    if (n.branch_name) bits.push(n.branch_name);
    else if (n.user_id) bits.push('For you');
    else bits.push('Whole business');
    // A branch alert is a shared work item — one `is_read` column, cleared for the shop
    // by whoever deals with it, and raised again by the daily sweep until the record
    // itself is renewed. Said out loud so two people do not both go and renew the same
    // licence, and so nobody is surprised that clearing it cleared it for a colleague.
    if (!n.user_id && n.branch_name) bits.push('shared with the branch');
    bits.push(U.watClock(n.created_at));
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
    if (foot) {
      foot.textContent = 'A message stays here until you mark it read. An expiry alert is raised again until the record is renewed.';
    }
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

  /**
   * A message is a notification, not a chat.
   *
   * An administrator writes to the owners of the business they are working in.
   * An owner writes to one staff member or manager, or to all staff, all managers,
   * or both. Each recipient gets their own unread row, so marking it read does not
   * clear it for anyone else, and the sender does not see their own message as an
   * alert.
   */
  async function openMessageComposer() {
    const role = String((SR.state.user && SR.state.user.role) || '').toUpperCase();
    const isAdmin = role === 'ADMIN';
    if (!isAdmin && role !== 'OWNER') {
      ui.warn('Only an owner or the administrator can send a message.');
      return;
    }
    if (!SR.api.isOnline()) {
      ui.warn('Sending a message needs a connection. It appears in their notifications once it is sent.');
      return;
    }
    if (!SR.state.activeBusinessId) {
      ui.warn('Choose the business first, so the message goes to the right people.');
      openBusinessPicker();
      return;
    }
    closeBell();
    const bizName = SR.state.activeBusinessName();
    const body = ui.h('div', { class: 'stack' });
    body.appendChild(ui.h('p', { class: 'hint' }, isAdmin
      ? `This goes to the owners of ${bizName}, and each of them sees it in their notifications.`
      : `This appears in the notifications of the people you choose at ${bizName}.`));

    const audience = ui.h('select', { name: 'audience' });
    const choices = isAdmin
      ? [['OWNERS', 'All owners of this business'], ['USER', 'One owner']]
      : [['USER', 'One person'], ['STAFF', 'All staff'], ['MANAGERS', 'All managers'], ['STAFF_AND_MANAGERS', 'Staff and managers']];
    for (const [value, label] of choices) audience.appendChild(ui.h('option', { value }, label));

    const personWrap = ui.h('div', { class: 'span-2' });
    const person = ui.h('select', { name: 'user_id' });
    person.appendChild(ui.h('option', { value: '' }, 'Loading people…'));
    personWrap.appendChild(ui.h('label', { class: 'ctl' }, isAdmin ? 'Which owner' : 'Who'));
    personWrap.appendChild(person);

    const form = ui.h('div', { class: 'form-grid' },
      ui.h('div', { class: 'span-2' },
        ui.h('label', { class: 'ctl' }, 'Send to'),
        audience),
      personWrap,
      ui.field({ label: 'Subject', name: 'title', required: true, span: true, placeholder: 'A short subject' }),
      ui.field({ label: 'Message', name: 'body', type: 'textarea', required: true, rows: 5, span: true, placeholder: 'What they should know' }));
    const titleInput = form.querySelector('[name=title]');
    const bodyInput = form.querySelector('[name=body]');
    if (titleInput) titleInput.maxLength = 120;
    if (bodyInput) bodyInput.maxLength = 1000;
    body.appendChild(form);

    function syncPerson() {
      const one = audience.value === 'USER';
      personWrap.hidden = !one;
      person.required = one;
    }
    audience.addEventListener('change', syncPerson);
    syncPerson();

    const cancel = ui.h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const send = ui.h('button', { class: 'btn btn-primary', type: 'button', onClick: () => submit() }, 'Send');
    const modal = ui.openModal({ title: 'Send a message', body, footer: [cancel, send] });
    cancel.addEventListener('click', () => modal.close());

    try {
      // An owner reaches every business. Passing the focused business_id
      // hides the proprietor of a second plant, which is why the administrator
      // saw "no owner" and the send found nobody.
      const q = isAdmin
        ? { limit: 500, active: '1', role: 'OWNER' }
        : SR.state.query({ limit: 500, active: '1' });
      const res = await SR.api.get('/api/users', { query: q });
      const rows = ((res && (res.data || res.rows)) || []).filter((u) => {
        if (!u || String(u.id) === String(SR.state.user && SR.state.user.id)) return false;
        const r = String(u.role || '').toUpperCase();
        if (!isAdmin) return r === 'STAFF' || r === 'MANAGER';
        if (r !== 'OWNER') return false;
        // The proprietor owns every business. A co-owner only if this business is one of theirs.
        if (!u.business_id) return true;
        const here = String(SR.state.activeBusinessId || '');
        if (String(u.business_id) === here) return true;
        return String(u.owned_business_ids || '').split(',').map((id) => id.trim()).includes(here);
      });
      person.replaceChildren();
      if (!rows.length) {
        person.appendChild(ui.h('option', { value: '' }, isAdmin ? 'No owner account yet' : 'No staff or managers'));
      } else {
        person.appendChild(ui.h('option', { value: '' }, 'Choose someone'));
        for (const u of rows) {
          const who = `${u.full_name || u.username} · ${U.titleCase(u.roleLabel || u.role)}${u.owned_businesses ? ` · ${u.owned_businesses}` : (u.branch_name ? ` · ${u.branch_name}` : '')}`;
          person.appendChild(ui.h('option', { value: u.id }, who));
        }
      }
    } catch (err) {
      person.replaceChildren(ui.h('option', { value: '' }, 'Could not load people'));
    }

    async function submit() {
      const title = titleInput ? titleInput.value.trim() : '';
      const text = bodyInput ? bodyInput.value.trim() : '';
      if (!title || !text) {
        ui.warn('Write a subject and a message.');
        return;
      }
      if (audience.value === 'USER' && !person.value) {
        ui.warn(isAdmin ? 'Choose which owner should receive it.' : 'Choose who should receive it.');
        return;
      }
      const payload = {
        title,
        body: text,
        audience: audience.value,
        business_id: SR.state.activeBusinessId,
      };
      if (audience.value === 'USER') payload.user_id = person.value;
      try {
        const res = await SR.api.post('/api/notifications', payload);
        ui.ok((res && res.message) || 'Sent. They will see it in their notifications.');
        modal.close();
      } catch (err) {
        ui.apiError(err);
      }
    }
  }

  function startBellPolling() {
    void updateBell();
    if (bellPollTimer) clearInterval(bellPollTimer);
    // A minute, not five. Expiry alerts are raised daily, but a message from the
    // owner or the administrator has to show up in the bell while the till is open,
    // not the next time somebody thinks to look.
    bellPollTimer = setInterval(() => { void updateBell({ refreshPanel: true }); }, 60 * 1000);
  }

  // -------------------------------------------------------------------
  // AUTH
  // -------------------------------------------------------------------
  function displacedNotice() {
    return 'This account is signed in on another device, so this one has been signed out. Sign in here only if this should be the device that uses the account.';
  }

  function paintDisplacedNotice() {
    const form = document.getElementById('login-form');
    if (!form) return;
    let note = document.getElementById('login-displaced');
    let displaced = false;
    try { displaced = sessionStorage.getItem('sr.displaced') === '1'; } catch (e) { /* private mode */ }
    if (!displaced) {
      if (note) note.remove();
      return;
    }
    if (!note) {
      note = document.createElement('div');
      note.id = 'login-displaced';
      note.className = 'alert alert-warn';
      note.style.marginBottom = '12px';
      form.prepend(note);
    }
    note.textContent = displacedNotice();
  }

  async function stampDisplacedQueue() {
    const me = await SR.store.metaGet('me').catch(() => null);
    const userId = (SR.state.user && SR.state.user.id) || (me && me.user && me.user.id);
    if (!userId) return;
    const rows = await SR.store.outboxAll().catch(() => []);
    for (const row of rows) {
      if (row.status === 'SYNCED') continue;
      if (row.user_id && row.user_id !== userId) continue;
      await SR.store.updateOutbox(row.client_id, { user_id: row.user_id || userId, held_reason: 'DISPLACED' });
    }
  }

  async function handleAuthFailure(detail) {
    const failedToken = detail && detail.token;
    const current = SR.api.loadToken();
    // Another tab on this same device just signed in. Its token is the live one.
    // Signing out here would throw away the session the person just started.
    if (failedToken && current && failedToken !== current) {
      global.location.reload();
      return;
    }
    const superseded = detail && detail.reason === 'SESSION_SUPERSEDED';
    if (superseded) {
      try { sessionStorage.setItem('sr.displaced', '1'); } catch (e) { /* the login screen still says it */ }
      await stampDisplacedQueue();
    }
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
    ui.warn(superseded ? (detail.message || displacedNotice()) : 'Your session has ended. Sign in again to continue.');
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
    const rememberEl = document.getElementById('login-remember');
    const remember = !rememberEl || rememberEl.checked;
    if (!username || !pin) {
      errEl.textContent = 'Enter your username and PIN.';
      errEl.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const result = await SR.api.login({ username, pin, remember });
      writeTill({ username, remember });
      try { sessionStorage.removeItem('sr.displaced'); } catch (e) { /* fine */ }
      SR.api.setToken(result.token, { remember });
      void form;
      await SR.state.load({ force: true });
      updateSubscriptionChrome();
      // The mirror is refreshed straight away so a device that loses its line
      // after signing in still has the catalogue and today's prices.
      SR.sync.start();
      SR.sync.runOnce({ silent: true }).catch(() => {});
      navigate('/dashboard', { replace: true });
      ui.ok(result.otherDevice
        ? `Welcome. This account was signed in on another device — that device has been signed out.`
        : `Welcome, ${(result.profile && result.profile.fullName) || (result.user && result.user.fullName) || username}.`);
    } catch (err) {
      if (err && err.isOffline) {
        // An offline sign-in is allowed ONLY where this device already holds a
        // session for this username — otherwise the PIN would be checked against
        // nothing at all, which is not a login, it is a bypass.
        const cached = await SR.store.metaGet('me');
        if (cached && cached.user && String(cached.user.username).toLowerCase() === username) {
          writeTill({ username, remember });
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

  async function doLogout(ev) {
    const btn = ev && ev.currentTarget;
    if (btn) btn.disabled = true;
    try {
    const pending = await SR.sync.queueStats().catch(() => ({ pending: 0, failed: 0 }));
    if (pending.pending > 0) {
      const go = await ui.confirmDialog({
        title: 'Work still waiting to sync',
        message: `There ${pending.pending === 1 ? 'is 1 item' : `are ${pending.pending} items`} on this device that the server has not seen yet.`,
        detail: 'Signing out does not delete them. Sales recorded by this account stay on this device and upload when this account signs in here again. They are not sent as the next person. Sync first if the line is up.',
        confirmLabel: 'Sync now, then sign out',
        cancelLabel: 'Stay signed in',
      });
      if (!go) return;
      try {
        await SR.sync.runOnce({ silent: true });
      } catch (e) { /* the queue survives either way */ }
    }
    await SR.api.logout();
    const till = readTill();
    if (till) writeTill({ username: till.username, remember: false });
    SR.state.clear();
    SR.sync.stop();
    closeUserMenu();
    showLogin();
    ui.info('Signed out.');
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
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
  function branchLabel(branch) {
    const biz = SR.state.businesses().find((b) => String(b.id) === String(branch.business_id));
    const bizName = branch.business_name || (biz && biz.name) || '';
    return `${bizName} · ${branch.city || ''} ${branch.state || ''}${branch.is_active ? '' : ' · INACTIVE'}`.replace(/^\s*·\s*/, '').trim();
  }

  function openBranchPicker() {
    const body = ui.h('div', {});
    const inOne = SR.state.activeBusiness();
    body.appendChild(ui.h('p', { class: 'hint' }, inOne
      ? `Shops of ${inOne.name}. Stock, cash and a sale belong to one shop. Another business is on the business switch.`
      : 'Picking a shop also enters that shop\'s business, so the two cannot disagree.'));
    const list = ui.h('div', { class: 'stack' });
    const pinned = SR.state.user && SR.state.user.branch && SR.state.user.branch.id;
    const choices = inOne ? SR.state.branchesFor(inOne.id) : SR.state.branches();
    if (SR.state.canSeeAllBranches() && !pinned) {
      const onAll = !SR.state.activeBranchId;
      const all = ui.h('button', {
        class: `nav-item ${onAll ? 'is-active' : ''}`,
        style: { justifyContent: 'flex-start' },
        onClick: () => {
          const res = SR.state.setBranch(null);
          if (!res.ok) { ui.warn(res.reason); return; }
          m.close();
          paintIdentity();
          const bizNow = SR.state.activeBusiness();
          ui.ok(bizNow ? `Now working across every shop of ${bizNow.name}.` : 'Now working across all branches.');
          render();
        },
      });
      all.appendChild(ui.h('span', { class: 'grow', style: { textAlign: 'left' } },
        ui.h('strong', {}, 'All branches'),
        ui.h('div', { class: 'hint' }, 'Group totals. Pick a shop below to see that branch\'s totals.')));
      if (onAll) all.appendChild(ui.badge('Current', 'badge-good'));
      list.appendChild(all);
    }
    for (const branch of choices) {
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
        ui.h('div', { class: 'hint' }, branchLabel(branch))));
      if (isActive) row.appendChild(ui.badge('Current', 'badge-good'));
      list.appendChild(row);
    }
    body.appendChild(list);
    const m = ui.openModal({ title: 'Which branch?', body, size: 'narrow' });
  }

  /**
   * A new record has to belong to one business. All businesses is a read of the
   * group; filing a product or a customer there would land on whichever entity
   * the server guessed. Refuse that, and open the switch so the choice is made.
   */
  function guardWorkingBusiness() {
    if (SR.state.activeBusinessId) return true;
    if (!SR.state.canSwitchBusiness()) return true;
    ui.warn('Pick a business first. All businesses is the group, and a new record has to belong to one.');
    openBusinessPicker();
    return false;
  }

  function openBusinessPicker() {
    if (!SR.state.canSwitchBusiness()) {
      ui.info('You only reach one business.');
      return;
    }
    const body = ui.h('div', {});
    body.appendChild(ui.h('p', { class: 'hint' }, 'Switching business changes the books on every screen: sales, customers, stock and the dashboard. It does not guess a shop. If the shop you were in belongs to another business, you pick the next shop yourself. All businesses is the group, with no shop chosen.'));
    const list = ui.h('div', { class: 'stack' });
    const onAll = !SR.state.activeBusinessId;
    const pinned = SR.state.user && SR.state.user.branch && SR.state.user.branch.id;
    if (!pinned) {
      const all = ui.h('button', {
        class: `nav-item ${onAll ? 'is-active' : ''}`,
        type: 'button',
        style: { justifyContent: 'flex-start' },
        onClick: () => {
          const res = SR.state.setBusiness(null, { all: true });
          if (!res.ok) { ui.warn(res.reason); return; }
          m.close();
          closeNav();
          paintIdentity();
          ui.ok('Now working across all businesses.');
          render();
        },
      });
      all.appendChild(ui.h('span', { class: 'grow', style: { textAlign: 'left' } },
        ui.h('strong', {}, 'All businesses'),
        ui.h('div', { class: 'hint' }, 'Group totals. Pick a business below to work in its books.')));
      if (onAll) all.appendChild(ui.badge('Current', 'badge-good'));
      list.appendChild(all);
    }
    for (const biz of SR.state.businesses()) {
      const isActive = String(biz.id) === String(SR.state.activeBusinessId);
      const shops = SR.state.branchesFor(biz.id);
      const row = ui.h('button', {
        class: `nav-item ${isActive ? 'is-active' : ''}`,
        type: 'button',
        style: { justifyContent: 'flex-start' },
        onClick: () => {
          const hadBranch = SR.state.activeBranchId;
          const res = SR.state.setBusiness(biz.id);
          if (!res.ok) { ui.warn(res.reason); return; }
          m.close();
          closeNav();
          paintIdentity();
          ui.ok(hadBranch && !SR.state.activeBranchId
            ? `Now working in ${biz.name}. Pick a shop before you sell or count stock — none was guessed.`
            : `Now working in ${biz.name}.`);
          render();
        },
      });
      row.appendChild(ui.h('span', { class: 'grow', style: { textAlign: 'left' } },
        ui.h('strong', {}, biz.name),
        ui.h('div', { class: 'hint' }, `${shops.length} shop${shops.length === 1 ? '' : 's'}${Number(biz.is_active) === 0 ? ' · INACTIVE' : ''}`)));
      if (isActive) row.appendChild(ui.badge('Current', 'badge-good'));
      list.appendChild(row);
    }
    body.appendChild(list);
    const m = ui.openModal({ title: 'Which business?', body, size: 'narrow' });
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
          // A real refusal from the server. An offline miss is not one of those:
          // the till keeps the last session and sells from the stock it holds.
          // A remembered 30-day token must not keep a displaced device signed in
          // once the server can be reached. Offline, the till still sells, and
          // the queue stays tagged to this account so the next person does not
          // upload it as themselves.
          const reachable = await SR.api.probe({ force: true });
          if (reachable) {
            if (err.code === 'SESSION_SUPERSEDED') {
              try { sessionStorage.setItem('sr.displaced', '1'); } catch (e) { /* fine */ }
              await stampDisplacedQueue();
            }
            SR.api.setToken(null);
          } else restored = Boolean(await SR.state.loadFromMirror());
        } else {
          // The server could not be reached. Fall back to the mirror, because a
          // counter at 7 a.m. with no line still has a day's work to do.
          const cached = await SR.state.loadFromMirror();
          restored = Boolean(cached);
        }
      }
    }
    if (!restored) {
      const till = readTill();
      const reachable = SR.api.isOnline() ? true : await SR.api.probe({ force: true });
      if (till && till.remember && !reachable) {
        restored = Boolean(await SR.state.loadFromMirror());
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
    // A sale queued offline never passes through the sync engine, so `change` does
    // not fire. `queue` is what `store.enqueue` emits the moment the row is stored.
    SR.api.on('queue', () => { void updateQueueChrome(); });
    SR.api.on('net', () => { updateNetChrome(); updateQueueChrome(); updateSubscriptionChrome(); });
    // A REFUSED WRITE IS THE MOST RELIABLE SIGNAL THERE IS. The cached settings can be
    // minutes or days old (they are mirrored for offline use); a 402 naming the
    // suspension is the server saying it just now. Re-read and repaint rather than trust
    // the copy.
    SR.api.on('plan', () => { refreshSubscriptionChrome(); });
    const subLink = document.getElementById('subscription-bar-link');
    if (subLink) subLink.addEventListener('click', () => navigate('/plan'));
    SR.api.on('auth', (detail) => { void handleAuthFailure(detail || {}); });
    SR.state.on('branch', () => { paintIdentity(); void updateQueueChrome(); });
    SR.state.on('business', () => {
      paintIdentity();
      buildNav();
      if (currentRoute && currentRoute.module && !(SR.state.moduleOn && SR.state.moduleOn(currentRoute.module))) navigate('/dashboard');
    });
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
    function paintThemeSwitches() {
      const on = SR.theme.current() === 'dark';
      for (const id of ['theme-toggle', 'login-theme']) {
        const el = document.getElementById(id);
        if (el) el.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }
    paintThemeSwitches();
    SR.theme.onChange(paintThemeSwitches);
    document.getElementById('theme-toggle').addEventListener('click', () => SR.theme.toggle());
    document.getElementById('login-theme').addEventListener('click', () => SR.theme.toggle());
    document.getElementById('branch-chip').addEventListener('click', () => {
      if (SR.state.canSwitchBranch()) openBranchPicker();
      else ui.info(`You are pinned to ${SR.state.activeBranchName()}. An owner can move you to another branch.`);
    });
    const businessChip = document.getElementById('business-chip');
    if (businessChip) businessChip.addEventListener('click', () => openBusinessPicker());
    const businessSwitch = document.getElementById('business-switch');
    if (businessSwitch) businessSwitch.addEventListener('click', () => openBusinessPicker());
    document.getElementById('queue-chip').addEventListener('click', () => navigate('/sync'));
    for (const id of ['install-btn', 'nav-install', 'login-install']) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => { void downloadApp(); });
    }
    paintInstallButton();
    document.getElementById('bell-btn').addEventListener('click', (ev) => { ev.stopPropagation(); toggleBell(); });
    document.getElementById('bell-read-all').addEventListener('click', (ev) => { ev.stopPropagation(); void markAllRead(); });
    const bellSend = document.getElementById('bell-send');
    if (bellSend) bellSend.addEventListener('click', (ev) => { ev.stopPropagation(); closeBell(); void openMessageComposer(); });
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
    const offlineContinue = document.getElementById('login-offline-continue');
    if (offlineContinue) offlineContinue.addEventListener('click', async () => {
      if (SR.api.isOnline()) return;
      const till = readTill();
      if (!till || !till.remember) {
        ui.warn('Sign in once while connected, and leave “Keep this till signed in” ticked.');
        return;
      }
      const cached = await SR.state.loadFromMirror();
      if (!cached) {
        ui.warn('This device has no saved till yet. Connect once and sign in.');
        return;
      }
      SR.sync.start();
      showShell();
      const pos = { path: '/pos', roles: ['STAFF', 'MANAGER', 'OWNER'] };
      navigate(allowed(pos) ? '/pos' : '/dashboard', { replace: true });
      ui.warn('Selling from the stock last recorded on this device. It will sync when the line returns.');
    });
    document.getElementById('login-reveal').addEventListener('change', (ev) => {
      const pin = document.getElementById('login-pin');
      if (pin) pin.type = ev.target.checked ? 'text' : 'password';
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
      if (document.visibilityState === 'visible') {
        updateNetChrome(); updateQueueChrome(); void updateBell({ refreshPanel: true });
        void offerNewBuild();
      }
    });

    // ---- AND THE TAB IS TOLD WHEN A NEW BUILD IS DEPLOYED.
    //
    // Every asset URL carries the deploy's stamp, so the NEXT load is always the new build — but a
    // till that is never closed never loads. That is how a fixed screen came back reported as
    // broken twice: the fix was on the server, the browser kept its copy, and the person reporting
    // the bug was looking at the old file with no way to know. So the app asks what is deployed,
    // a few times an hour and whenever the tab wakes up, and offers the reload itself.
    offerNewBuild();
    setInterval(() => { void offerNewBuild(); }, 10 * 60 * 1000);
    global.addEventListener('online', () => { void offerNewBuild(); });
  }

  let askingForBuild = false;
  /**
   * Is the server serving a different build from the one running here? If so, say so — once, with a
   * button — rather than reloading a cashier mid-sale.
   *
   * `/sw.js` is asked for because it is the one file that carries the deploy's stamp and is never
   * served from the app's own cache (`cache: 'no-store'`, and it is not an asset path the service
   * worker caches). An offline device gets `null` and is told nothing, because there is nothing true
   * to tell it.
   */
  async function liveBuild() {
    try {
      const res = await fetch('/sw.js', { cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.text();
      const m = /const BUILD = '([^']+)';/.exec(body);
      return m ? m[1] : null;
    } catch (err) {
      return null; // offline, or the file is unreachable: no claim either way
    }
  }

  async function offerNewBuild() {
    if (askingForBuild || !SR.BUILD) return;
    askingForBuild = true;
    try {
      const live = await liveBuild();
      if (!live || live === SR.BUILD) return;
      if (document.getElementById('build-refresh-toast')) return;
      const node = ui.toast(`A newer version of StockRidge is on the server (${live}). Reload to use it — your queued work is safe.`, {
        type: 'warn', ms: 0, action: { label: 'Reload now', run: () => { global.location.reload(); } },
      });
      if (node) node.id = 'build-refresh-toast';
    } finally {
      askingForBuild = false;
    }
  }

  // -------------------------------------------------------------------
  SR.views = SR.views || {};
  SR.app = {
    ROUTES, ICONS, icon, iconPath,
    boot, render, navigate, matchRoute, allowed,
    showLogin, showShell, paintIdentity, paintLoginBrand, buildNav, setActiveNav, closeNav,
    openBranchPicker, openBusinessPicker, guardWorkingBusiness,
    updateBell, openBell, closeBell, markAllRead, openMessageComposer,
    updateNetChrome, updateQueueChrome, handleAuthFailure, doLogout,
    updateSubscriptionChrome, refreshSubscriptionChrome, subscriptionState,
    liveBuild, offerNewBuild,
    openModal: ui.openModal,
    get route() { return currentRoute; },
    get params() { return currentParams; },
    get query() { return currentQuery; },
    onCleanup: (fn) => cleanupFns.push(fn),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot().catch((e) => bootError('StockRidge failed to start.', e.message)));
  else boot().catch((e) => bootError('StockRidge failed to start.', e.message));
}(window));
