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
const NAV_SECTIONS = [
  {
    title: 'Operations',
    items: [
      { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', view: dashboardView, show: () => true },
      { path: '/pos', label: 'Point of Sale', icon: 'pos', view: posView, show: () => true, primary: true },
      { path: '/operations', label: 'Holds & Orders', icon: 'truck', view: operationsView, show: () => true },
    ],
  },
  {
    title: 'Inventory & Sales',
    items: [
      { path: '/stock', label: 'Stock & Batches', icon: 'box', view: stockView, show: () => true },
      { path: '/sales', label: 'Sales History', icon: 'receipt', view: salesView, show: () => true },
      { path: '/customers', label: 'Customers & Credit', icon: 'users', view: customersView, show: () => true },
    ],
  },
  {
    title: 'Finance & Governance',
    items: [
      { path: '/accounting', label: 'Accounting & Tax', icon: 'ledger', view: accountingView, show: () => can.seeAccounting() },
      { path: '/registers', label: 'Registers & Audit', icon: 'shield', view: adminView.registers, show: () => can.seeRegisters() },
      { path: '/admin', label: 'Administration', icon: 'cog', view: adminView.settings, show: () => can.seeSettings() || isVendor() },
    ],
  },
];

function buildNav() {
  const sidebar = document.getElementById('sidebar');
  clear(sidebar);

  for (const section of NAV_SECTIONS) {
    const visibleItems = section.items.filter((item) => {
      try { return item.show(); } catch (e) { return false; }
    });
    if (!visibleItems.length) continue;

    sidebar.appendChild(el('div', { class: 'nav-section', text: section.title }));
    for (const item of visibleItems) {
      sidebar.appendChild(el('a', {
        href: item.path,
        class: `nav-item${item.primary ? ' nav-primary' : ''}`,
        dataset: { path: item.path },
        onclick: (ev) => { ev.preventDefault(); navigate(item.path); closeSidebar(); },
      }, el('span', { class: 'nav-icon' }, icon(item.icon)), el('span', { class: 'nav-label', text: item.label })));
    }
  }

  // Offline queue indicator in sidebar
  const q = el('a', {
    href: '/queue', class: 'nav-item nav-queue', id: 'nav-queue', hidden: true,
    onclick: (ev) => { ev.preventDefault(); navigate('/queue'); closeSidebar(); },
  }, el('span', { class: 'nav-icon' }, icon('clock')),
    el('span', { class: 'nav-label' }, 'Offline queue ', el('strong', { id: 'nav-queue-count', text: '0' })));
  sidebar.appendChild(q);
}

for (const section of NAV_SECTIONS) {
  for (const item of section.items) registerView(item.path, item.view);
}
registerView('/queue', () => import('./views/queue.js').then((m) => m.default));

// ---------------------------------------------------------------------
// TOP BAR IDENTITY
// ---------------------------------------------------------------------
function paintIdentity() {
  const biz = activeBusiness();
  const br = activeBranch();
  document.getElementById('app-business').textContent = biz ? (biz.trading_name || biz.name) : 'StockRidge Platform';
  document.getElementById('app-branch').textContent = br
    ? `${br.name}${br.area ? ` · ${br.area}` : ''}`
    : (state.branches.length ? 'Select a branch' : 'All locations');
  document.getElementById('user-initials').textContent = initials(state.user && state.user.full_name);
  document.getElementById('pop-name').textContent = (state.user && state.user.full_name) || '';
  document.getElementById('pop-role').textContent = (state.user && state.user.display_role) || role();

  const logo = (state.settings && state.settings.logo_data_url) || (biz && biz.logo_data_url);
  const appLogo = document.getElementById('app-logo');
  if (logo) { appLogo.src = logo; appLogo.hidden = false; } else { appLogo.hidden = true; }

  // Switchers
  const bizSel = document.getElementById('switch-business');
  if (canSeeMultipleBusinesses() && state.businesses.length > 0) {
    clear(bizSel);
    for (const b of state.businesses) bizSel.appendChild(el('option', { value: b.id, text: b.trading_name || b.name, selected: b.id === state.activeBusinessId }));
    bizSel.hidden = false;
  } else bizSel.hidden = true;

  const brSel = document.getElementById('switch-branch');
  const branches = branchesOfActiveBusiness();
  if (branches.length > 1 && !state.scope.pinned) {
    clear(brSel);
    for (const b of branches) brSel.appendChild(el('option', { value: b.id, text: b.name, selected: b.id === state.activeBranchId }));
    brSel.hidden = false;
  } else brSel.hidden = true;

  document.getElementById('btn-till').hidden = true;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'AD';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  const scrim = document.getElementById('nav-scrim');
  if (scrim) scrim.classList.add('open');
  document.getElementById('nav-toggle').setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  const scrim = document.getElementById('nav-scrim');
  if (scrim) scrim.classList.remove('open');
  document.getElementById('nav-toggle').setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------
// CLOCK + CONNECTIVITY + QUEUE
// ---------------------------------------------------------------------
function startClock() {
  const node = document.getElementById('clock');
  const tick = () => {
    node.textContent = `${watClock()} WAT`;
    node.title = `Today is ${todayWat()} in West Africa Time (UTC+1).`;
  };
  tick();
  setInterval(tick, 1000);
}

function paintConnectivity(online) {
  const badgeEl = document.getElementById('net-badge');
  badgeEl.textContent = online ? 'Online' : 'Offline';
  badgeEl.className = `net-badge ${online ? 'net-online' : 'net-offline'}`;
  badgeEl.title = online
    ? 'Connected. Operations save in real time.'
    : 'No connection. Sales are cached securely on this terminal.';
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
    badgeEl.title = `${n} pending item(s) waiting for server sync.`;
    if (navEl) navEl.hidden = false;
    if (countEl) countEl.textContent = String(n);
  } else {
    badgeEl.hidden = true;
    if (navEl) navEl.hidden = true;
  }
}

window.addEventListener('sr:queue', () => paintQueue());

// ---------------------------------------------------------------------
// LOGIN & AUTH
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
    document.getElementById('login-tz').textContent = 'West Africa Time (UTC+1) · Lagos';
  } catch (e) {
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
  detectDemoAccounts();
}

async function detectDemoAccounts() {
  const node = document.getElementById('login-demo');
  try {
    const h = await api.health();
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
    window.__srToken = res.token;
    const me = await api.me();
    applyMe(me);
    let ref = cachedReference();
    try { ref = await api.reference(); setReference(ref); } catch (e) {}
    if (res.user.must_change_pin) {
      toast('Temporary PIN detected. Please change your PIN.', { kind: 'warn', duration: 8000 });
      setTimeout(promptChangePin, 400);
    }
    showApp();
    toast(`Welcome back, ${res.user.full_name}`, { kind: 'good', duration: 2500 });
  } catch (e) {
    if (e.status === 429) {
      lock.textContent = e.message;
      lock.hidden = false;
    } else if (e.status === 402) {
      err.textContent = e.message;
      err.hidden = false;
    } else {
      err.textContent = e.message || 'Incorrect credentials.';
      err.hidden = false;
    }
    document.getElementById('login-pin').value = '';
    document.getElementById('login-pin').focus();
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

async function doLogout() {
  try { await api.logout(); } catch (e) {}
  clearSession();
  window.__srToken = null;
  location.hash = '';
  showLogin();
  toast('Signed out successfully.', { kind: 'info', duration: 2000 });
}

function promptChangePin() {
  const current = field({ label: 'Current PIN', name: 'current_pin', type: 'password', required: true, options: { autocomplete: 'current-password' } });
  const next = field({ label: 'New PIN (4–8 digits)', name: 'new_pin', type: 'password', required: true, options: { autocomplete: 'new-password' } });
  const again = field({ label: 'Confirm New PIN', name: 'new_pin2', type: 'password', required: true, options: { autocomplete: 'new-password' } });
  const err = el('p', { class: 'form-error', hidden: true });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    err.hidden = true;
    if (v.new_pin !== v.new_pin2) { err.textContent = 'New PINs do not match.'; err.hidden = false; return; }
    try {
      await api.changePin(v.current_pin, v.new_pin);
      m.close();
      clearSession();
      showLogin('PIN updated. Please sign in with your new PIN.');
    } catch (e2) { err.textContent = e2.message; err.hidden = false; }
  } }, current, next, again, err,
  el('div', { class: 'row-end' },
    el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save PIN')));
  const m = modal({ title: 'Change Security PIN', size: 'sm', body: form });
  form.querySelector('input').focus();
}

// ---------------------------------------------------------------------
// BOOTSTRAP
// ---------------------------------------------------------------------
async function boot() {
  if (window.Theme) {
    window.Theme.mount('login-theme-toggle');
    window.Theme.mount('theme-toggle');
  }

  paintConnectivity(navigator.onLine);
  startClock();
  watchConnectivity((online) => {
    paintConnectivity(online);
    if (online) {
      toast('Network restored — syncing queued sales.', { kind: 'good', duration: 2500 });
      flushQueue({ onProgress: () => paintQueue() }).then((r) => {
        if (r.flushed) toast(`${r.flushed} sale(s) synced to server.`, { kind: 'good', duration: 4000 });
        for (const bad of r.refused || []) {
          toast(`Sync failure: ${bad.error || bad.code}.`, { kind: 'error', duration: 12000 });
        }
        paintQueue();
      });
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  await paintBranding();

  if (restoreSession()) {
    window.__srToken = state.token;
    try {
      const me = await api.me();
      applyMe(me);
      try { setReference(await api.reference()); } catch (e) {}
      showApp();
      return;
    } catch (e) {
      clearSession();
      showLogin(e.status === 401 ? 'Session expired. Please sign in again.' : null);
      return;
    }
  }
  showLogin();
}

// ---------------------------------------------------------------------
// EVENT WIRING
// ---------------------------------------------------------------------
document.getElementById('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const u = document.getElementById('login-username').value.trim();
  const p = document.getElementById('login-pin').value;
  if (!u || !p) {
    const err = document.getElementById('login-error');
    err.textContent = 'Please enter both username and PIN.';
    err.hidden = false;
    return;
  }
  doLogin(u, p);
});

document.getElementById('nav-toggle').addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  if (sb.classList.contains('open')) closeSidebar(); else openSidebar();
});

const scrim = document.getElementById('nav-scrim');
if (scrim) scrim.addEventListener('click', closeSidebar);

document.getElementById('switch-business').addEventListener('change', (ev) => {
  setActiveBusiness(ev.target.value);
  paintIdentity();
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
    ? 'Session expired. Please sign in.'
    : 'You have been signed out.');
});

window.addEventListener('sr:scope-changed', () => { paintIdentity(); });

boot().catch((err) => {
  console.error('[stockridge] boot failed', err);
  const host = document.getElementById('login-error');
  if (host) {
    host.textContent = `Application initialization error: ${err && err.message ? err.message : 'Unknown'}.`;
    host.hidden = false;
  }
});

export { paintIdentity, paintQueue, newIdempotencyKey, naira };
