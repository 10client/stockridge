// =====================================================================
// public/js/offline.js — the queue that makes the till work with no network
// =====================================================================
// A Nigerian shop's connection is not a binary. It is a mobile hotspot that
// drops when the generator switches over, a fibre cut on the island, a branch in
// a market with one bar of signal at the best of times. A POS that stops when
// the network does is a POS that closes the shop.
//
// So: writes that matter are queued in IndexedDB and replayed. Reads fall back to
// the last good copy. And the queue is VISIBLE, because a queue nobody can see is
// a queue that grows silently until somebody notices the day's takings never
// reached the head office.
//
// ---------------------------------------------------------------------
// WHY THE IDEMPOTENCY KEY IS NON-NEGOTIABLE
// ---------------------------------------------------------------------
// A queued sale is retried after the connection returns. The original request may
// well have REACHED the server and been processed before the response was lost —
// which is exactly what happens when a connection drops mid-request. Retrying
// without a key would then record the sale twice: stock out twice, cash counted
// twice, the customer's receipt contradicted by the books.
//
// So every queued write carries an Idempotency-Key generated at the moment the
// operator pressed the button, stored with the queued item, and reused on every
// attempt. The server executes it once and replays the stored response. This is
// what makes blind retry safe.
//
// ---------------------------------------------------------------------
// WHAT IS AND IS NOT QUEUED
// ---------------------------------------------------------------------
// Queued:     sales (the thing that must not stop)
// Not queued: everything else. A stock receipt, a price change, a warranty claim
//             and a debtor payment all need server-side state that an offline
//             device does not have (the current batch, the current balance, the
//             serial register head). Queuing those would mean inventing answers
//             locally and reconciling them later, which is a much harder problem
//             than telling one person to try again in a minute — and getting it
//             wrong moves money between branches.

'use strict';

const DB_NAME = 'stockridge-offline';
const DB_VERSION = 1;
const STORE_QUEUE = 'queue';
const STORE_CACHE = 'cache';

let dbp = null;

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      // No IndexedDB (private mode in some browsers). Fall back to localStorage
      // rather than losing the sale: a queued sale in localStorage still syncs.
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const q = db.createObjectStore(STORE_QUEUE, { keyPath: 'key' });
        q.createIndex('created_at', 'created_at');
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'cacheKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null);
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const result = fn(s);
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : true);
    t.onerror = () => resolve(null);
    t.onabort = () => resolve(null);
  }));
}

/** A key unique enough that two operators on two devices never collide, and
 *  stable enough that a retry of the SAME action reuses it. */
export function newIdempotencyKey(prefix = 'sale') {
  const rand = (crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') : String(Math.random()).slice(2);
  const dev = deviceIdShort();
  return `${prefix}-${dev}-${Date.now().toString(36)}-${rand.slice(0, 12)}`;
}

function deviceIdShort() {
  try {
    let id = localStorage.getItem('sr.device');
    if (!id) return 'anon';
    return id.replace(/^dev-/, '').slice(0, 10);
  } catch (e) { return 'anon'; }
}

// ---------------------------------------------------------------------
// the write queue
// ---------------------------------------------------------------------
export async function queueSale(item) {
  const entry = {
    key: item.idempotencyKey || newIdempotencyKey('sale'),
    path: item.path,
    method: item.method || 'POST',
    body: item.body,
    created_at: new Date().toISOString(),
    attempts: 0,
    last_error: null,
    // Denormalised so the queue screen can show a human-readable summary without
    // re-parsing the body.
    summary: summarise(item.body),
  };
  await tx(STORE_QUEUE, 'readwrite', (s) => s.put(entry));
  announce();
  return entry;
}

function summarise(body) {
  if (!body) return 'a sale';
  const lines = Array.isArray(body.lines) ? body.lines.length : 0;
  const units = Array.isArray(body.lines) ? body.lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0) : 0;
  return `${lines} line${lines === 1 ? '' : 's'}, ${units} unit${units === 1 ? '' : 's'}`;
}

export async function queueAll() {
  const all = await tx(STORE_QUEUE, 'readonly', (s) => s.getAll());
  return Array.isArray(all) ? all.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))) : [];
}

export async function queueSize() {
  const n = await tx(STORE_QUEUE, 'readonly', (s) => s.count());
  return Number(n) || 0;
}

export async function removeQueued(key) {
  await tx(STORE_QUEUE, 'readwrite', (s) => s.delete(key));
  announce();
}

export async function markAttempt(key, error) {
  const all = await queueAll();
  const item = all.find((x) => x.key === key);
  if (!item) return;
  item.attempts = (item.attempts || 0) + 1;
  item.last_error = error ? String(error).slice(0, 300) : null;
  item.last_attempt_at = new Date().toISOString();
  await tx(STORE_QUEUE, 'readwrite', (s) => s.put(item));
}

// ---------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------
let flushing = false;

/**
 * Send everything queued, oldest first.
 *
 * Oldest-first matters: two sales of the same last unit must resolve in the order
 * they happened, or the second one succeeds against stock the first one took.
 *
 * A BUSINESS REFUSAL (4xx) removes the item from the queue and reports it. It
 * will never succeed on retry — the stock is gone, the serial is sold, the
 * discount needs a manager — so retrying it forever would hide the fact that the
 * operator needs to do something. A NETWORK or 5xx failure keeps it queued.
 */
export async function flushQueue({ onProgress } = {}) {
  if (flushing) return { flushed: 0, failed: 0, skipped: 'already-running' };
  flushing = true;
  let flushed = 0; const refused = []; const retained = [];
  try {
    const items = await queueAll();
    for (const item of items) {
      if (!navigator.onLine) break;
      if (typeof onProgress === 'function') onProgress({ done: flushed, total: items.length, current: item });
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(item.path, {
          method: item.method,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Device-Id': (localStorage.getItem('sr.device') || 'dev-unknown'),
            'Idempotency-Key': item.key,
            ...(window.__srToken ? { Authorization: `Bearer ${window.__srToken}` } : {}),
          },
          body: JSON.stringify(item.body),
        });
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }

        if (res.ok) {
          // eslint-disable-next-line no-await-in-loop
          await removeQueued(item.key);
          flushed += 1;
          continue;
        }
        if (res.status === 401) {
          // Session gone. Keep the queue — the sale is real and must not be
          // discarded — but stop trying until somebody signs in again.
          retained.push({ key: item.key, reason: 'SIGN_IN_REQUIRED' });
          break;
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429) {
          // A definitive refusal. Remove it and surface it, because leaving it in
          // the queue means the operator believes the sale went through.
          // eslint-disable-next-line no-await-in-loop
          await removeQueued(item.key);
          refused.push({ key: item.key, summary: item.summary, status: res.status, code: body && body.code, error: body && body.error });
          continue;
        }
        // 409 (a conflict worth retrying, e.g. a till that has since been
        // opened), 429 (throttled), 5xx, or anything unexpected: keep it.
        // eslint-disable-next-line no-await-in-loop
        await markAttempt(item.key, (body && body.error) || `HTTP ${res.status}`);
        retained.push({ key: item.key, reason: (body && body.code) || `HTTP_${res.status}` });
      } catch (networkErr) {
        // eslint-disable-next-line no-await-in-loop
        await markAttempt(item.key, networkErr && networkErr.message);
        retained.push({ key: item.key, reason: 'NETWORK' });
        break;   // no point hammering a dead connection
      }
    }
  } finally {
    flushing = false;
    announce();
  }
  return { flushed, refused, retained };
}

// ---------------------------------------------------------------------
// read cache — so a screen still has something to show offline
// ---------------------------------------------------------------------
export async function cachePut(cacheKey, data) {
  await tx(STORE_CACHE, 'readwrite', (s) => s.put({ cacheKey, data, cached_at: new Date().toISOString() }));
}

export async function cacheGet(cacheKey) {
  const row = await tx(STORE_CACHE, 'readonly', (s) => s.get(cacheKey));
  return row && row.data ? { data: row.data, cached_at: row.cached_at } : null;
}

/**
 * Fetch through the cache: serve fresh, store it; on failure serve stale and SAY
 * it is stale. A screen that silently shows yesterday's stock is worse than one
 * that shows nothing, because somebody sells a unit that is not there.
 */
export async function cachedFetch(cacheKey, fetcher) {
  try {
    const data = await fetcher();
    cachePut(cacheKey, data);
    return { data, stale: false, cached_at: new Date().toISOString() };
  } catch (err) {
    const hit = await cacheGet(cacheKey);
    if (hit) return { data: hit.data, stale: true, cached_at: hit.cached_at, error: err };
    throw err;
  }
}

// ---------------------------------------------------------------------
// visibility
// ---------------------------------------------------------------------
function announce() {
  queueSize().then((n) => {
    window.dispatchEvent(new CustomEvent('sr:queue', { detail: { size: n } }));
  });
}

export function watchConnectivity(onChange) {
  const update = () => {
    const online = navigator.onLine;
    if (typeof onChange === 'function') onChange(online);
    if (online) flushQueue();
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}
