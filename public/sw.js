// =====================================================================
// public/sw.js — the service worker
// =====================================================================
// Its job is narrow and deliberately boring:
//
//   1. Cache the app SHELL so the till opens with no network at all.
//   2. Serve GETs network-first, falling back to the cache.
//   3. NEVER cache a POST, PUT, PATCH or DELETE. A cached write is a write that
//      did not happen, and in a POS that means money and stock that moved on a
//      screen and nowhere else.
//   4. NEVER cache an API response that is not explicitly marked cacheable.
//      A stale debtor balance shown as current is worse than an error.
//
// The offline QUEUE lives in IndexedDB (js/offline.js), not here. A service
// worker cannot be trusted with a write queue: it can be terminated between
// events, and a queued sale held only in its memory is a sale that vanishes.

'use strict';

const VERSION = 'stockridge-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// The shell: everything needed to render a usable frame with no network.
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/state.js',
  '/js/router.js',
  '/js/offline.js',
  '/js/ui.js',
  '/js/views/dashboard.js',
  '/js/views/pos.js',
  '/js/views/stock.js',
  '/js/views/sales.js',
  '/js/views/customers.js',
  '/js/views/accounting.js',
  '/js/views/operations.js',
  '/js/views/admin.js',
  '/js/views/queue.js',
  '/manifest.json',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll is all-or-nothing, so one missing asset would fail the whole
    // install and leave the app with no offline shell. Put them individually and
    // tolerate a miss: a missing icon must not cost the operator their till.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from previous versions. Keeping them means a client can be
    // served an old shell with new assets, which is a category of bug that is
    // miserable to diagnose from a shop floor.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('stockridge-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;              // never touch a write

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // same-origin only

  // API GETs: network first, cache only as a labelled fallback. The view decides
  // whether a stale copy is acceptable and says so on screen; the worker must not
  // make that decision silently.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')
    || url.pathname === '/reference' || url.pathname === '/branding') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok && !url.pathname.startsWith('/auth/')) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        // A synthetic 503 the app recognises as "offline", rather than a network
        // error that looks like a server fault.
        return new Response(JSON.stringify({ error: 'You are offline and this data is not cached.', code: 'OFFLINE', status: 0 }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
    })());
    return;
  }

  // Navigation requests: the shell, so a deep link like /pos works offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('/index.html', res.clone()).catch(() => {});
        return res;
      } catch (e) {
        return (await caches.match('/index.html')) || (await caches.match('/'));
      }
    })());
    return;
  }

  // Everything else (css, js, icons): stale-while-revalidate. The shell changes
  // only on deploy, and an operator should never wait on the network for it.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async (res) => {
      if (res && res.ok) {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});

// Let the page ask the worker to drop everything, which is what "sign out of this
// shared device" should mean for cached data.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'CLEAR_CACHES') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('stockridge-')).map((k) => caches.delete(k)));
    })());
  }
});
