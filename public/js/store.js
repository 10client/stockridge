'use strict';
// =====================================================================
// public/js/store.js — THE OFFLINE MIRROR AND THE WRITE-AHEAD QUEUE
// =====================================================================
// This is the device half of StockRidge's offline-first contract. It answers
// two questions, and it answers them without a network:
//
//   1. WHAT DOES THIS SHOP LOOK LIKE RIGHT NOW?
//      A mirror of every table the server lets a device hold: the catalogue,
//      prices, stock as at the last sync, customers, suppliers, branches, users
//      (never their PIN hashes), settings. Synchronous to read, so the POS can
//      price a cart while the line is down.
//
//   2. WHAT HAVE I DONE THAT THE SERVER HAS NOT SEEN YET?
//      An outbox. A sale is written here BEFORE the cashier is told it succeeded.
//      That ordering is the whole point: if the app is killed between the two,
//      the sale is still on the device and still gets posted. If it were the
//      other way round, a completed sale could vanish.
//
// WHY IndexedDB AND NOT SQLITE-WASM
//
// The server runs real SQLite and the Cloudflare build runs D1, which is SQLite.
// The browser's own transactional store is IndexedDB, and it is the right engine
// for this half:
//
//   * it is already in every browser the shop will use, with no 1.2 MB WASM
//     download on a metered connection;
//   * it survives a reload, a browser restart and a tab crash;
//   * it is transactional, so a half-written sale cannot be read back.
//
// The adapter below is deliberately shaped like the server's `db` (all/first/
// run), so the view code that renders a mirrored list looks the same as the code
// that renders a server list. A native wrapper (Capacitor/Electron) can swap in
// a real SQLite engine behind `SR.store.adapter` without any view changing.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};

  const DB_NAME = 'stockridge';
  const DB_VERSION = 1;
  const STORE_ROWS = 'rows';       // keyPath: ['table', 'id']
  const STORE_OUTBOX = 'outbox';   // keyPath: 'client_id'
  const STORE_META = 'meta';       // keyPath: 'key'
  const STORE_LOG = 'log';         // keyPath: 'at' — recent sync results, capped

  const LOG_CAP = 400;
  const OUTBOX_CAP = 20000;        // a hard ceiling: a device that reached this
                                   // has been offline for weeks and needs a human

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error('This browser cannot store data offline. StockRidge needs IndexedDB — try Chrome, Edge, Firefox or Safari.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_ROWS)) {
          const rows = db.createObjectStore(STORE_ROWS, { keyPath: ['table', 'id'] });
          rows.createIndex('by_table', 'table', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: 'client_id' });
          outbox.createIndex('by_at', 'at', { unique: false });
          outbox.createIndex('by_status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_LOG)) {
          const log = db.createObjectStore(STORE_LOG, { keyPath: 'at' });
          log.createIndex('by_at', 'at');
        }
        void event;
      };
      req.onsuccess = () => {
        const db = req.result;
        // If another tab upgrades the schema, this tab's connection is stale and
        // every transaction would fail. Closing lets the other tab finish and the
        // next call here reopens.
        db.onversionchange = () => { try { db.close(); } catch (e) { /* gone */ } dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('The offline store could not be opened.'));
      req.onblocked = () => reject(new Error('Another StockRidge tab is holding an old version of the offline store. Close the other tabs and reload.'));
    });
    return dbPromise;
  }

  function tx(stores, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const names = Array.isArray(stores) ? stores : [stores];
      const t = db.transaction(names, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error || new Error('The offline store refused the write.'));
      t.onabort = () => reject(t.error || new Error('The offline store aborted the transaction.'));
      try {
        result = fn(names.map((n) => t.objectStore(n)), t);
      } catch (e) {
        try { t.abort(); } catch (err) { /* already gone */ }
        reject(e);
      }
    }));
  }

  function reqAsync(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // -------------------------------------------------------------------
  // MIRROR
  // -------------------------------------------------------------------

  /**
   * Replace or insert a batch of rows for one table.
   *
   * `updated_at` is preserved exactly as the server sent it — the mirror is a
   * copy, not a second source of truth, and rewriting timestamps here would
   * make the next incremental pull miss changes.
   */
  async function putMany(table, rows) {
    const list = (rows || []).filter((r) => r && r.id != null);
    if (!list.length) return 0;
    await tx(STORE_ROWS, 'readwrite', (stores) => {
      const store = stores[0];
      for (const row of list) store.put({ table, id: String(row.id), row: stripSecrets(row) });
    });
    return list.length;
  }

  /**
   * A device must never hold a credential it does not need. The server already
   * refuses to send these, and this is the second lock on the same door: a
   * server bug must not be able to put a PIN hash on a shop phone.
   */
  const FORBIDDEN_FIELDS = ['pin_hash', 'jwt_secret', 'password', 'password_hash', 'secret'];
  function stripSecrets(row) {
    let dirty = false;
    for (const f of FORBIDDEN_FIELDS) { if (f in row) { dirty = true; break; } }
    if (!dirty) return row;
    const copy = Object.assign({}, row);
    for (const f of FORBIDDEN_FIELDS) delete copy[f];
    return copy;
  }

  async function all(table, { orderBy = null, dir = 1, limit = null, where = null } = {}) {
    const db = await open();
    const rows = await reqAsync(db.transaction(STORE_ROWS, 'readonly').objectStore(STORE_ROWS).index('by_table').getAll(IDBKeyRange.only(table)));
    let list = rows.map((r) => r.row);
    if (where) list = list.filter(where);
    if (orderBy) list.sort(SR.util.by(orderBy, dir));
    if (limit) list = list.slice(0, limit);
    return list;
  }

  async function first(table, predicate) {
    const rows = await all(table);
    return rows.find(predicate) || null;
  }

  async function get(table, id) {
    const db = await open();
    const hit = await reqAsync(db.transaction(STORE_ROWS, 'readonly').objectStore(STORE_ROWS).get([table, String(id)]));
    return hit ? hit.row : null;
  }

  async function remove(table, id) {
    await tx(STORE_ROWS, 'readwrite', (stores) => { stores[0].delete([table, String(id)]); });
  }

  async function clearTable(table) {
    const rows = await all(table);
    await tx(STORE_ROWS, 'readwrite', (stores) => {
      const store = stores[0];
      for (const r of rows) store.delete([table, String(r.id)]);
    });
    return rows.length;
  }

  async function clearAll() {
    await tx([STORE_ROWS, STORE_OUTBOX], 'readwrite', (stores) => {
      stores[0].clear(); stores[1].clear();
    });
  }

  /** Which tables are mirrored, and how many rows each holds. */
  async function tableStats() {
    const db = await open();
    const rows = await reqAsync(db.transaction(STORE_ROWS, 'readonly').objectStore(STORE_ROWS).getAll());
    const counts = new Map();
    let latest = null;
    for (const r of rows) {
      counts.set(r.table, (counts.get(r.table) || 0) + 1);
      const u = r.row && r.row.updated_at;
      if (u && (!latest || String(u) > latest)) latest = String(u);
    }
    return {
      total: rows.length,
      tables: Array.from(counts.entries()).map(([table, count]) => ({ table, count })).sort((a, b) => a.table.localeCompare(b.table)),
      latestUpdatedAt: latest,
    };
  }

  // -------------------------------------------------------------------
  // OUTBOX — the write-ahead queue
  // -------------------------------------------------------------------

  /**
   * Queue one operation for the server.
   *
   * `client_id` is the idempotency key. It is generated ONCE, here, and reused
   * on every retry, which is what makes a flaky link safe: the server stores the
   * first result against the key and replays it, so a sale retried five times is
   * still one sale.
   */
  async function enqueue({ type, payload, pathParams = null, label = null, ref = null, occurredAt = null, deviceId = null }) {
    const clientId = SR.util.localId('op');
    const record = {
      client_id: clientId,
      type: String(type).toUpperCase(),
      payload: payload || {},
      path_params: pathParams || null,
      label: label || type,
      ref: ref || null,
      occurred_at: occurredAt || SR.util.nowWatSql(),
      device_id: deviceId || SR.device.current().id,
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      last_code: null,
      server_ref: null,
      at: new Date().toISOString(),
      synced_at: null,
    };
    await tx(STORE_OUTBOX, 'readwrite', (stores) => { stores[0].put(record); });
    return record;
  }

  async function pending({ limit = null } = {}) {
    const db = await open();
    const rows = await reqAsync(db.transaction(STORE_OUTBOX, 'readonly').objectStore(STORE_OUTBOX).index('by_at').getAll());
    const list = rows.filter((r) => r.status === 'PENDING' || r.status === 'RETRY');
    return limit ? list.slice(0, limit) : list;
  }

  async function outboxAll() {
    const db = await open();
    const rows = await reqAsync(db.transaction(STORE_OUTBOX, 'readonly').objectStore(STORE_OUTBOX).getAll());
    return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  async function outboxCount() {
    const list = await pending();
    return list.length;
  }

  async function updateOutbox(clientId, patch) {
    await tx(STORE_OUTBOX, 'readwrite', (stores) => {
      const store = stores[0];
      return reqAsync(store.get(clientId)).then((row) => {
        if (row) store.put(Object.assign(row, patch, { at: row.at }));
      });
    });
  }

  async function removeOutbox(clientId) {
    await tx(STORE_OUTBOX, 'readwrite', (stores) => { stores[0].delete(clientId); });
  }

  /**
   * Drop anything that can never succeed.
   *
   * The server marks a refusal `retryable: false` — a 4xx is a decision, not a
   * hiccup. Keeping those in the queue would hide a real problem underneath a
   * growing pile of retries, so they move to FAILED and stop being counted as
   * pending work. Nothing is deleted: the cashier resolves them from Sync, and
   * the row is removed only when they say so.
   */
  async function markFailed(clientId, { code, message }) {
    await updateOutbox(clientId, { status: 'FAILED', last_code: code || 'REJECTED', last_error: message || 'The server refused this.' });
  }

  async function markSynced(clientId, serverRef) {
    await updateOutbox(clientId, { status: 'SYNCED', synced_at: new Date().toISOString(), server_ref: serverRef || null });
  }

  async function purgeSynced({ olderThanHours = 48 } = {}) {
    const rows = await outboxAll();
    const cutoff = new Date(Date.now() - olderThanHours * 3600000).toISOString();
    const gone = rows.filter((r) => r.status === 'SYNCED' && String(r.synced_at || '') < cutoff);
    await tx(STORE_OUTBOX, 'readwrite', (stores) => { for (const r of gone) stores[0].delete(r.client_id); });
    return gone.length;
  }

  async function requeue(clientId) {
    await updateOutbox(clientId, { status: 'PENDING', attempts: 0, last_error: null, last_code: null });
  }

  // -------------------------------------------------------------------
  // META — small key/value facts about this device
  // -------------------------------------------------------------------

  async function metaGet(key, fallback = null) {
    const db = await open();
    const hit = await reqAsync(db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(String(key)));
    return hit ? hit.value : fallback;
  }
  async function metaSet(key, value) {
    await tx(STORE_META, 'readwrite', (stores) => { stores[0].put({ key: String(key), value }); });
    return value;
  }
  async function metaAll() {
    const db = await open();
    const rows = await reqAsync(db.transaction(STORE_META, 'readonly').objectStore(STORE_META).getAll());
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // -------------------------------------------------------------------
  // LOG — a short history of what synced, shown on the Sync screen
  // -------------------------------------------------------------------
  async function log(entry) {
    const at = new Date().toISOString();
    await tx(STORE_LOG, 'readwrite', (stores) => { stores[0].put(Object.assign({ at }, entry)); });
    const db = await open();
    const rows = await reqAsync(db.transaction(STORE_LOG, 'readonly').objectStore(STORE_LOG).getAll());
    if (rows.length > LOG_CAP) {
      const extra = rows.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, rows.length - LOG_CAP);
      await tx(STORE_LOG, 'readwrite', (stores) => { for (const r of extra) stores[0].delete(r.at); });
    }
  }
  async function logAll({ limit = 60 } = {}) {
    const db = await open();
    const rows = await reqAsync(db.transaction(STORE_LOG, 'readonly').objectStore(STORE_LOG).getAll());
    return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
  }
  async function logClear() {
    await tx(STORE_LOG, 'readwrite', (stores) => { stores[0].clear(); });
  }

  // -------------------------------------------------------------------
  // BACKUP — the whole device, as JSON
  // -------------------------------------------------------------------
  async function exportAll() {
    const db = await open();
    const [rows, outbox, meta] = await Promise.all([
      reqAsync(db.transaction(STORE_ROWS, 'readonly').objectStore(STORE_ROWS).getAll()),
      reqAsync(db.transaction(STORE_OUTBOX, 'readonly').objectStore(STORE_OUTBOX).getAll()),
      reqAsync(db.transaction(STORE_META, 'readonly').objectStore(STORE_META).getAll()),
    ]);
    return {
      format: 'stockridge-device-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      device: SR.device.current(),
      rows, outbox, meta,
    };
  }

  async function importAll(backup, { replace = false } = {}) {
    if (!backup || backup.format !== 'stockridge-device-backup') {
      throw new Error('That file is not a StockRidge device backup.');
    }
    if (replace) await clearAll();
    await tx([STORE_ROWS, STORE_OUTBOX, STORE_META], 'readwrite', (stores) => {
      for (const r of backup.rows || []) stores[0].put(r);
      for (const o of backup.outbox || []) stores[1].put(o);
      for (const m of backup.meta || []) stores[2].put(m);
    });
    return { rows: (backup.rows || []).length, outbox: (backup.outbox || []).length };
  }

  async function estimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0 };
      } catch (err) { /* not supported */ }
    }
    return { usage: 0, quota: 0 };
  }

  /** Ask the browser not to evict this origin. Best-effort: a refusal is fine,
   *  it just means a long-offline device has less headroom. */
  async function requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      try { return await navigator.storage.persist(); } catch (e) { return false; }
    }
    return false;
  }

  SR.store = {
    DB_NAME, DB_VERSION, OUTBOX_CAP,
    open, tx,
    putMany, all, first, get, remove, clearTable, clearAll, tableStats,
    enqueue, pending, outboxAll, outboxCount, updateOutbox, removeOutbox,
    markFailed, markSynced, purgeSynced, requeue,
    metaGet, metaSet, metaAll,
    log, logAll, logClear,
    exportAll, importAll, estimate, requestPersistence,
  };
}(window));
