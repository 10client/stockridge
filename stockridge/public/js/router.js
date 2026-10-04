// =====================================================================
// public/js/router.js — hash-free history routing for the SPA shell
// =====================================================================
// Real paths (/pos, /stock) rather than #/pos, because the server already
// serves the shell for any unknown GET and a shop's staff bookmark these.

'use strict';

const routes = new Map();
let current = { path: null, view: null, params: {} };
let mounted = null;

export function registerView(path, loader) {
  routes.set(path, loader);
}

function parse(url) {
  const u = new URL(url, location.origin);
  return { path: u.pathname.replace(/\/$/, '') || '/', query: Object.fromEntries(u.searchParams.entries()) };
}

async function resolve(path) {
  let normalized = path.replace(/\/$/, '') || '/';
  if (normalized === '/' || normalized === '/login') {
    normalized = '/dashboard';
  }
  const loader = routes.get(normalized);
  if (!loader) return null;
  // A view may be a function or a promise for a module (dynamic import).
  const v = typeof loader === 'function' ? await loader() : await loader;
  return v && v.default ? v.default : v;
}

export async function navigate(url, { replace = false } = {}) {
  const { path, query } = parse(url);
  if (replace) history.replaceState({ path }, '', url);
  else history.pushState({ path }, '', url);
  await render(path, query);
}

export async function render(pathname, query) {
  const host = document.getElementById('view');
  if (!host) return;
  const view = await resolve(pathname);

  // Highlight the active nav item.
  for (const a of document.querySelectorAll('.nav-item')) {
    a.classList.toggle('active', a.dataset.path === pathname);
  }

  if (!view) {
    host.textContent = '';
    host.appendChild(notFound(pathname));
    current = { path: pathname, view: null, params: query };
    return;
  }

  // Give the outgoing view a chance to stop its timers and listeners. A view
  // that leaves an interval running keeps fetching into a detached node, which
  // on a till left open for twelve hours is a slow leak and a busy network.
  if (mounted && typeof mounted.unmount === 'function') {
    try { mounted.unmount(); } catch (e) { /* best effort */ }
  }
  mounted = null;

  host.textContent = '';
  host.scrollTop = 0;
  const ctx = { host, query, params: query, path: pathname, navigate, rerender: () => render(pathname, query) };
  try {
    const instance = await view(ctx);
    mounted = instance && typeof instance.unmount === 'function' ? instance : null;
  } catch (err) {
    host.textContent = '';
    host.appendChild(renderFailure(pathname, err));
  }
  current = { path: pathname, view, params: query };
  host.focus({ preventScroll: true });
}

function notFound(path) {
  const d = document.createElement('div');
  d.className = 'empty-state';
  const h = document.createElement('h3');
  h.textContent = 'No screen at that address';
  const p = document.createElement('p');
  p.textContent = `Nothing is mapped to ${path}. It may have been renamed, or your role may not include it.`;
  const b = document.createElement('button');
  b.className = 'btn btn-primary';
  b.textContent = 'Back to the dashboard';
  b.addEventListener('click', () => navigate('/dashboard'));
  d.append(h, p, b);
  return d;
}

function renderFailure(path, err) {
  const d = document.createElement('div');
  d.className = 'empty-state empty-state-error';
  const h = document.createElement('h3');
  h.textContent = 'This screen could not be shown';
  const p = document.createElement('p');
  // The real message goes to the console; the screen says what to do. A raw
  // stack trace on a cashier's screen is noise, and on a customer-facing till it
  // is an information leak.
  p.textContent = err && err.status === 0
    ? 'You appear to be offline and this screen has no cached copy. Reconnect and try again — sales you already made are saved on this device.'
    : 'Something went wrong while loading it. Try again; if it keeps happening, note the message below and tell your manager.';
  d.append(h, p);
  if (err && err.message) {
    const pre = document.createElement('pre');
    pre.className = 'error-detail';
    pre.textContent = err.message;
    d.appendChild(pre);
  }
  const b = document.createElement('button');
  b.className = 'btn btn-primary';
  b.textContent = 'Try again';
  b.addEventListener('click', () => render(path, {}));
  d.appendChild(b);
  // eslint-disable-next-line no-console
  console.error(`[router] ${path} failed`, err);
  return d;
}

export const router = {
  get current() { return current; },
  rerender: () => render(parse(location.href).path, parse(location.href).query),
  navigate,
};

window.addEventListener('popstate', (ev) => {
  const { path, query } = parse(location.href);
  render(path, query);
});

export default router;
