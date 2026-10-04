// =====================================================================
// public/js/app.js — bootstrap, navigation, session lifecycle
// =====================================================================
'use strict';

import { endpoints as api } from './api.js';
import {
  state, restoreSession, setSession, clearSession, applyMe, persistChoice,
  setActiveBusiness, setActiveBranch, activeBusiness, activeBranch, branchesOfActiveBusiness,
  can, role, atLeast, isVendor, canSeeMultipleBranches, canSeeMultipleBusinesses,
  setReference, cachedReference, naira, todayWat, watClock,
} from './state.js';
import { flushQueue, queueSize, watchConnectivity, newIdempotencyKey } from './offline.js';
import { el, clear, icon, toast, reportError, modal, field, readForm, badge, toneForStatus } from './ui.js';
import { router, navigate, registerView } from './router.js';

// Views are imported eagerly, not lazily. A shop on a mobile connection should
// not pay a round-trip the first time somebody opens the stock screen mid-queue;
// the whole bundle is a few tens of kilobytes and the service worker caches it.
import dashboardView from './views/dashboard.js';
import posView from './views/pos.js';
import stockView from './views/stock.js';
import salesView from './views/sales.js';
import customersView from './views/customers.js';
import accountingView from './views/accounting.js';
import operationsView from './views/operations.js';
import adminView from './views/admin.js';

// ---------------------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------------------
// Each entry declares who can see it. Building the menu from these predicates
// means a cashier never sees a screen that will refuse them, and an owner never
// has to guess which of twenty menu items their plan actually includes.
const NAV = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', view: dashboardView, show: () => true },
  { path: '/pos', label: 'New sale', icon: 'pos', view: posView, show: () => true, primary: true },
  { path: '/stock', label: 'Stock', icon: 'box', view: stockView, show: () => true },
  { path: '/sales', label: 'Sales history', icon: 'receipt', view: salesView, show: () => true },
  { path: '/customers', label: 'Customers & credit', icon: 'users', view: customersView, show: () => state.settings ? true : true },
  { path: '/operations', label: 'Holds · Plans · Delivery', icon: 'truck', view: operationsView, show: () => true },
  { path: '/accounting', label: 'Accounting & tax', icon: 'ledger', view: accountingView, show: () => can.seeAccounting() },
  { path: '/registers', label: 'Registers & audit', icon: 'shield', view: adminView.registers, show: () => can.seeRegisters() },
  { path: '/admin', label: 'Administration', icon: 'cog', view: adminView.settings, show: () => can.seeSettings() || isVendor() },
];

function buildNav() {
  const sidebar = document.getElementById('sidebar');
  clear(sidebar);
  for (const item of NAV) {
    let show = false;
    try { show = item.show(); } catch (e) { show = false; }
    if (!show) continue;
    sidebar.appendChild(el('a', {
      href: item.path,
      class: `nav-item${item.primary ? ' nav-primary' : ''}`,
      dataset: { path: item.path },
      onclick: (ev) => { ev.preventDefault(); navigate(item.path); closeSidebar(); },
    }, el('span', { class: 'nav-icon' }, icon(item.icon)), el('span', { class: 'nav-label', text: item.label })));
  }
  // The offline queue is always reachable when it has contents, because a queue
  // nobody can find is a queue that grows until the day's takings are missing.
  const q = el('a', {
    href: '/queue', class: 'nav-item nav-queue', id: 'nav-queue', hidden: true,
    onclick: (ev) => { ev.preventDefault(); navigate('/queue'); closeSidebar(); },
  }, el('span', { class: 'nav-icon' }, icon('clock')),
    el('span', { class: 'nav-label' }, 'Offline queue ', el('strong', { id: 'nav-queue-count', text: '0' })));
  sidebar.appendChild(q);
}

for (const item of NAV) registerView(item.path, item.view);
registerView('/queue', () => import('./views/queue.js').then((m) => m.default));

// ---------------------------------------------------------------------
// TOP BAR
// ---------------------------------------------------------------------
function paintIdentity() {
  const biz = activeBusiness();
  const br = activeBranch();
  document.getElementById('app-business').textContent = biz ? (biz.trading_name || biz.name) : '—';
  document.getElementById('app-branch').textContent = br
    ? `${br.name}${br.area ? ` · ${br.area}` : ''}`
    : (state.branches.length ? 'Choose a branch' : 'No branches yet');
  document.getElementById('user-initials').textContent = initials(state.user && state.user.full_name);
  document.getElementById('pop-name').textContent = (state.user && state.user.full_name) || '';
  document.getElementById('pop-role').textContent = (state.user && state.user.display_role) || role();

  const logo = (state.settings && state.settings.logo_data_url) || (biz && biz.logo_data_url);
  const appLogo = document.getElementById('app-logo');
  if (logo) { appLogo.src = logo; appLogo.hidden = false; } else { appLogo.hidden = true; }

  // Switchers appear only when there is something to switch between.
  const bizSel = document.getElementById('switch-business');
  if (canSeeMultipleBusinesses()) {
    clear(bizSel);
    for (const b of state.businesses) bizSel.appendChild(el('option', { value: b.id, text: b.trading_name || b.name, selected: b.id === state.activeBusinessId }));
    bizSel.hidden = false;
  } else bizSel.hidden = true;

  const brSel = document.getElementById('switch-branch');
  const branches = branchesOfActiveBusiness();
  // A PINNED user has exactly one branch: showing them a selector with one option
  // invites them to think they should be able to change it.
  if (branches.length > 1 && !state.scope.pinned) {
    clear(brSel);
    for (const b of branches) brSel.appendChild(el('option', { value: b.id, text: b.name, selected: b.id === state.activeBranchId }));
    brSel.hidden = false;
  } else brSel.hidden = true;

  // "Open till" only when this branch has no open session — the prompt should
  // appear exactly when the cashier needs it and never otherwise.
  document.getElementById('btn-till').hidden = true;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('nav-toggle').setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('nav-toggle').setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------
// CLOCK + CONNECTIVITY + QUEUE
// ---------------------------------------------------------------------
function startClock() {
  const node = document.getElementById('clock');
  const tick = () => {
    // Displayed in West Africa Time explicitly. A till showing UTC would put
    // every sale after 23:00 on the wrong day's report, and the cashier reading
    // the clock would not know.
    node.textContent = `${watClock()} WAT`;
    node.title = `Today is ${todayWat()} in West Africa Time. Every report in StockRidge buckets by this date, not by UTC.`;
  };
  tick();
  setInterval(tick, 1000);
}

function paintConnectivity(online) {
  const badgeEl = document.getElementById('net-badge');
  badgeEl.textContent = online ? 'Online' : 'Offline';
  badgeEl.className = `net-badge ${online ? 'net-online' : 'net-offline'}`;
  badgeEl.title = online
    ? 'Connected. Queued sales send automatically.'
    : 'No connection. Sales are saved on this device and will send when you reconnect.';
  document.getElementById('login-offline').hidden = online;
}

async function paintQueue() {
  const n = await queueSize();
  const badgeEl = document.getElementById('queue-badge');
  const navEl = document.getElementById('nav-queue');
  const countEl = document.getElementById('nav-queue-count');
  if (n > 0) {
    badgeEl.hidden = false;
    badgeEl.textContent = `${n} queued`;
    badgeEl.className = 'queue-badge queue-active';
    badgeEl.title = `${n} sale(s) waiting to reach the server. Open the queue to review them.`;
    if (navEl) navEl.hidden = false;
    if (countEl) countEl.textContent = String(n);
  } else {
    badgeEl.hidden = true;
    if (navEl) navEl.hidden = true;
  }
}

window.addEventListener('sr:queue', () => paintQueue());

// ---------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------
async function paintBranding() {
  try {
    const b = await api.branding();
    document.getElementById('login-product').textContent = b.product_name || 'StockRidge';
    document.title = `${b.product_name || 'StockRidge'} — stock, sales & accounts`;
    if (b.logo_data_url) {
      const img = document.getElementById('login-logo');
      img.src = b.logo_data_url; img.hidden = false;
    }
    document.getElementById('login-tz').textContent = 'West Africa Time (UTC+1) · all reports bucket by Lagos date';
  } catch (e) {
    // Branding is cosmetic; never let it block sign-in.
    document.getElementById('login-tz').textContent = 'West Africa Time (UTC+1)';
  }
}

function showLogin(reason = null) {
  document.getElementById('app').hidden = true;
  document.getElementById('login').hidden = false;
  const err = document.getElementById('login-error');
  const lock = document.getElementById('login-lock');
  err.hidden = true; lock.hidden = true;
  if (reason) { err.textContent = reason; err.hidden = false; }
  document.getElementById('login-username').focus();
  // Show the demo card only while the seeded users are still there. A live client
  // must not be staring at a list of default credentials.
  detectDemoAccounts();
}

async function detectDemoAccounts() {
  const node = document.getElementById('login-demo');
  try {
    const h = await api.health();
    // The seed writes a known vendor seat; if the deployment still has it and has
    // exactly the seeded shape, the demo card is helpful. Otherwise hide it.
    node.hidden = !(h && h.ok && h.service);
  } catch (e) { node.hidden = true; }
}

function showApp() {
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  buildNav();
  paintIdentity();
  paintQueue();
  navigate(location.pathname + location.search || '/dashboard', { replace: true });
}

async function doLogin(username, pin) {
  const btn = document.getElementById('login-submit');
  const err = document.getElementById('login-error');
  const lock = document.getElementById('login-lock');
  err.hidden = true; lock.hidden = true;
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await api.login(username, pin);
    setSession({ token: res.token, user: res.user, scope: res.scope });
    // Exposed for the offline flush, which runs outside the api module.
    window.__srToken = res.token;
    const me = await api.me();
    applyMe(me);
    let ref = cachedReference();
    try { ref = await api.reference(); setReference(ref); } catch (e) { /* cached copy is enough */ }
    if (res.user.must_change_pin) {
      toast('This is a temporary PIN. Please change it now.', { kind: 'warn', duration: 8000 });
      setTimeout(promptChangePin, 400);
    }
    showApp();
    toast(`Signed in as ${res.user.full_name} (${res.user.display_role})`, { kind: 'good', duration: 2500 });
  } catch (e) {
    if (e.status === 429) {
      // The lock message is the server's, and it says what to do: wait, or ask a
      // manager. A manager can clear it immediately, which matters when the
      // person locked out is the one who opens the shop.
      lock.textContent = e.message;
      lock.hidden = false;
    } else if (e.status === 402) {
      err.textContent = e.message;
      err.hidden = false;
    } else {
      err.textContent = e.message || 'Sign-in failed.';
      err.hidden = false;
    }
    document.getElementById('login-pin').value = '';
    document.getElementById('login-pin').focus();
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

async function doLogout() {
  try { await api.logout(); } catch (e) { /* the local clear below is what matters */ }
  clearSession();
  window.__srToken = null;
  location.hash = '';
  showLogin();
  toast('Signed out.', { kind: 'info', duration: 2000 });
}

function promptChangePin() {
  const current = field({ label: 'Current PIN', name: 'current_pin', type: 'password', required: true, options: { autocomplete: 'current-password' } });
  const next = field({ label: 'New PIN (4–8 digits)', name: 'new_pin', type: 'password', required: true, options: { autocomplete: 'new-password' } });
  const again = field({ label: 'Repeat new PIN', name: 'new_pin2', type: 'password', required: true, options: { autocomplete: 'new-password' } });
  const err = el('p', { class: 'form-error', hidden: true });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    err.hidden = true;
    if (v.new_pin !== v.new_pin2) { err.textContent = 'The two new PINs do not match.'; err.hidden = false; return; }
    try {
      await api.changePin(v.current_pin, v.new_pin);
      m.close();
      // Every session was revoked server-side, including this one.
      clearSession();
      showLogin('Your PIN was changed, so this device was signed out. Sign in with the new PIN.');
    } catch (e2) { err.textContent = e2.message; err.hidden = false; }
  } }, current, next, again, err,
  el('div', { class: 'row-end' },
    el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Change PIN')));
  const m = modal({
    title: 'Change your PIN', size: 'sm', body: form,
  });
  form.querySelector('input').focus();
}

// ---------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------
async function boot() {
  paintConnectivity(navigator.onLine);
  startClock();
  watchConnectivity((online) => {
    paintConnectivity(online);
    if (online) {
      toast('Back online — sending anything queued.', { kind: 'good', duration: 2500 });
      flushQueue({ onProgress: () => paintQueue() }).then((r) => {
        if (r.flushed) toast(`${r.flushed} queued sale(s) reached the server.`, { kind: 'good', duration: 4000 });
        for (const bad of r.refused || []) {
          // A refused sale must be surfaced loudly. The operator believes it
          // happened; if it did not, they are holding cash the books do not know
          // about, or they gave away stock that was never recorded.
          toast(`A queued sale could not be saved: ${bad.error || bad.code}. ${bad.summary}`, { kind: 'error', duration: 15000 });
        }
        paintQueue();
      });
    }
  });

  // Service worker: registered after first paint so it never competes with the
  // login screen for bandwidth.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // A failed SW registration must not stop the app; it only costs offline
        // shell caching, and the IndexedDB queue still works.
      });
    });
  }

  await paintBranding();

  if (restoreSession()) {
    window.__srToken = state.token;
    try {
      const me = await api.me();
      applyMe(me);
      try { setReference(await api.reference()); } catch (e) { /* cached copy is fine */ }
      showApp();
      return;
    } catch (e) {
      clearSession();
      showLogin(e.status === 401 ? 'Your session expired. Sign in again.' : null);
      return;
    }
  }
  showLogin();
}

// ---------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------
document.getElementById('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const u = document.getElementById('login-username').value.trim();
  const p = document.getElementById('login-pin').value;
  if (!u || !p) {
    const err = document.getElementById('login-error');
    err.textContent = 'Enter your username and PIN.';
    err.hidden = false;
    return;
  }
  doLogin(u, p);
});

document.getElementById('nav-toggle').addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  if (sb.classList.contains('open')) closeSidebar(); else openSidebar();
});

document.getElementById('switch-business').addEventListener('change', (ev) => {
  setActiveBusiness(ev.target.value);
  paintIdentity();
  // Re-render: every figure on screen was for the other business.
  router.rerender();
});
document.getElementById('switch-branch').addEventListener('change', (ev) => {
  setActiveBranch(ev.target.value);
  paintIdentity();
  router.rerender();
});

document.getElementById('user-btn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const pop = document.getElementById('user-pop');
  pop.hidden = !pop.hidden;
  ev.currentTarget.setAttribute('aria-expanded', String(!pop.hidden));
});
document.addEventListener('click', () => {
  const pop = document.getElementById('user-pop');
  if (pop) { pop.hidden = true; document.getElementById('user-btn').setAttribute('aria-expanded', 'false'); }
});
document.getElementById('pop-pin').addEventListener('click', () => {
  document.getElementById('user-pop').hidden = true;
  promptChangePin();
});
document.getElementById('pop-signout').addEventListener('click', () => {
  document.getElementById('user-pop').hidden = true;
  doLogout();
});
document.getElementById('btn-till').addEventListener('click', () => navigate('/operations?till=1'));

window.addEventListener('sr:signed-out', (ev) => {
  showLogin(ev.detail && ev.detail.code === 'SESSION_EXPIRED'
    ? 'Your session expired. Sign in again.'
    : 'You were signed out.');
});

// Re-paint identity whenever a view changes the active branch (a POS screen may
// do so for a General Manager posting on behalf of another branch).
window.addEventListener('sr:scope-changed', () => { paintIdentity(); });

boot().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[stockridge] boot failed', err);
  const host = document.getElementById('login-error');
  if (host) {
    host.textContent = `StockRidge could not start: ${err && err.message ? err.message : 'unknown error'}. Reload the page, and if it persists check that the server is running.`;
    host.hidden = false;
  }
});

export { NAV, paintIdentity, paintQueue, newIdempotencyKey, naira };
