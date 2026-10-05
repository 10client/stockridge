'use strict';
// =====================================================================
// public/sw.js — THE SERVICE WORKER: WHAT IS CACHED, AND WHAT IS NOT
// =====================================================================
// The rule that keeps this honest:
//
//   THE SHELL IS CACHED. THE API IS NOT.
//
// A cached JavaScript file is a stale button. A cached API response is WRONG
// DATA — a stock figure from an hour ago, a price from before the owner raised
// it, a customer's balance before their payment. Offline reads are served from
// the device's own mirror (see js/store.js), which knows when it was last
// refreshed and says so. The service worker never pretends a server answer is
// fresh, because it has no way to know.
//
// Strategy per request class:
//
//   navigations        network-first, fall back to the cached shell  (so a deep
//                      link works offline and lands in the SPA)
//   /api/*             never cached; the request fails and the app handles it
//   /js /css /icons    cache-first with a background refresh (stale-while-
//                      revalidate) — assets are versioned by a BUILD stamp
//   everything else    network, then cache
// =====================================================================

// Bump this on every deploy. It is what makes the old cache get thrown away
// rather than served forever.
const BUILD = 'ridge-1';
const CACHE = `stockridge-${BUILD}`;

const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/util.js',
  '/js/deviceId.js',
  '/js/theme.js',
  '/js/store.js',
  '/js/api.js',
  '/js/state.js',
  '/js/ui.js',
  '/js/sync.js',
  '/js/print.js',
  '/js/barcode-label.js',
  '/js/export.js',
  '/js/views/dashboard.js',
  '/js/views/pos.js',
  '/js/views/sales.js',
  '/js/views/products.js',
  '/js/views/stock.js',
  '/js/views/stocktake.js',
  '/js/views/transfers.js',
  '/js/views/customers.js',
  '/js/views/suppliers.js',
  '/js/views/purchase-orders.js',
  '/js/views/expenses.js',
  '/js/views/till.js',
  '/js/views/deliveries.js',
  '/js/views/returns.js',
  '/js/views/instalments.js',
  '/js/views/attendance.js',
  '/js/views/accounting.js',
  '/js/views/reports.js',
  '/js/views/users.js',
  '/js/views/admin.js',
  '/js/views/plan.js',
  '/js/views/sync.js',
  '/js/views/account.js',
  '/js/app.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, so ONE missing file does not fail the whole install and
    // leave the device with no worker at all.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      event.source?.postMessage({ type: 'CACHES_CLEARED' });
    })());
  }
});

function isApi(url) { return url.pathname.startsWith('/api/'); }

function isAsset(url) {
  return /\.(?:js|css|png|jpg|jpeg|svg|webp|woff2?|ttf)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // never touch a write

  const url = new URL(request.url);

  // Same origin only. Anything else (there is nothing else, but a browser
  // extension can inject one) is left alone.
  if (url.origin !== self.location.origin) return;

  // ---- API: straight through. Never cached, never replayed from a cache.
  if (isApi(url)) return;

  // ---- Navigations: network first, cached shell on failure.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('/index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/')) || new Response(
          '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:system-ui;padding:40px;text-align:center">'
          + '<h1>StockRidge is not installed on this device yet</h1>'
          + '<p>Open the app once with a connection and it will work offline from then on.</p></body>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }
    })());
    return;
  }

  // ---- Assets: serve the cached copy immediately, refresh it in the background.
  if (isAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      const network = fetch(request).then((res) => {
        if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
        return res;
      }).catch(() => null);
      return hit || (await network) || new Response('', { status: 504 });
    })());
    return;
  }

  // ---- Anything else: network, then whatever we have.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
      return fresh;
    } catch (e) {
      const hit = await cache.match(request);
      if (hit) return hit;
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
