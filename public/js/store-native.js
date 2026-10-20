'use strict';
// =====================================================================
// public/js/store-native.js — SQLITE WHEN A SHELL IS WRAPPING THE UI
// =====================================================================
// The browser path stays IndexedDB. A desktop shell (and, later, an Android
// shell) exposes the same methods on window.stockridgeNative.store before
// this file runs. Views keep calling SR.store. They do not learn which
// engine answered.
//
// The first open copies an existing IndexedDB mirror and outbox across,
// once. After that the file on disk is the till. The cloud is still reached
// only through the Worker sync endpoints.
(function (global) {
  const SR = global.SR = global.SR || {};
  const native = global.stockridgeNative && global.stockridgeNative.store;
  if (!native || !SR.store || !SR.store.exportAll || SR.store.engine === 'sqlite') return;

  const idb = SR.store;
  let opening = null;

  function stripSecrets(row) {
    if (!row || typeof row !== 'object') return row;
    const forbidden = ['pin_hash', 'jwt_secret', 'password', 'password_hash', 'secret'];
    let dirty = false;
    for (const field of forbidden) { if (field in row) { dirty = true; break; } }
    if (!dirty) return row;
    const copy = Object.assign({}, row);
    for (const field of forbidden) delete copy[field];
    return copy;
  }

  async function open() {
    if (opening) return opening;
    opening = (async () => {
      const flag = await native.metaGet('idb_imported');
      if (!flag) {
        try {
          const backup = await idb.exportAll();
          const rows = (backup && backup.rows) || [];
          const outbox = (backup && backup.outbox) || [];
          const meta = (backup && backup.meta) || [];
          if (rows.length || outbox.length || meta.length) {
            await native.importAll(backup, { replace: false });
          }
          await native.metaSet('idb_imported', {
            at: new Date().toISOString(),
            rows: rows.length,
            outbox: outbox.length,
          });
        } catch (err) {
          await native.metaSet('idb_import_error', String((err && err.message) || err));
        }
      }
      return true;
    })();
    return opening;
  }

  async function ready() {
    await open();
  }

  async function all(table, opts) {
    await ready();
    const options = opts || {};
    let list = await native.all(table);
    if (options.where) list = list.filter(options.where);
    if (options.orderBy && SR.util && SR.util.by) list.sort(SR.util.by(options.orderBy, options.dir || 1));
    if (options.limit) list = list.slice(0, options.limit);
    return list;
  }

  async function get(table, id) {
    await ready();
    return native.get(table, id);
  }

  async function putMany(table, rows) {
    await ready();
    const list = (rows || []).filter((row) => row && row.id != null).map(stripSecrets);
    if (!list.length) return 0;
    return native.putMany(table, list);
  }

  async function enqueue({ type, payload, pathParams = null, label = null, ref = null, occurredAt = null, deviceId = null }) {
    await ready();
    const clientId = SR.util.localId('op');
    const record = {
      client_id: clientId,
      type: String(type).toUpperCase(),
      payload: payload || {},
      path_params: pathParams || null,
      label: label || type,
      ref: ref || null,
      occurred_at: occurredAt || SR.util.nowWatSql(),
      device_id: deviceId || (SR.device && SR.device.current().id),
      user_id: (SR.state && SR.state.user && SR.state.user.id) || null,
      status: 'PENDING',
      attempts: 0,
      last_error: null,
      last_code: null,
      server_ref: null,
      at: new Date().toISOString(),
      synced_at: null,
    };
    await native.outboxPut(record);
    try {
      if (SR.api && SR.api.emit) SR.api.emit('queue', { clientId, type: record.type });
    } catch (err) { /* the sale is already stored */ }
    return record;
  }

  async function rememberShopPrice(priced) {
    if (!priced || !(Number(priced.selling_price) > 0) || !priced.product_id) return;
    if (priced.catalogue) {
      const row = await get('products', priced.product_id);
      if (row && !(Number(row.selling_price) > 0)) {
        await putMany('products', [Object.assign({}, row, { selling_price: Number(priced.selling_price) })]);
      }
    }
    if (priced.override_id && priced.branch_id) {
      await putMany('product_price_overrides', [{
        id: String(priced.override_id),
        branch_id: String(priced.branch_id),
        product_id: String(priced.product_id),
        variant_id: null,
        default_selling_price: Number(priced.selling_price),
        is_deleted: 0,
      }]);
    }
  }

  async function saveLocalClaim(claim) {
    const code = String(claim.claim_code || '').trim().toUpperCase();
    if (!code) return null;
    const row = Object.assign({
      id: `local-${code}`,
      claim_code: code,
      status: 'OUTSTANDING',
      issued_here: 1,
      synced: 0,
      created_at: new Date().toISOString(),
    }, claim, { id: `local-${code}`, claim_code: code, issued_here: 1 });
    await putMany('change_owed', [row]);
    return row;
  }

  async function localClaims() {
    return all('change_owed', { where: (row) => Number(row.issued_here) === 1 && !Number(row.is_deleted) });
  }

  async function findLocalClaim(code) {
    const wanted = String(code || '').trim().toUpperCase();
    if (!wanted) return null;
    const rows = await localClaims();
    return rows.find((row) => String(row.claim_code || '').toUpperCase() === wanted) || null;
  }

  SR.store = {
    engine: 'sqlite',
    DB_NAME: 'stockridge',
    DB_VERSION: 1,
    OUTBOX_CAP: idb.OUTBOX_CAP,
    open,
    putMany,
    all,
    first: async (table, predicate) => (await all(table)).find(predicate) || null,
    get,
    remove: async (table, id) => { await ready(); return native.remove(table, id); },
    rememberShopPrice,
    clearTable: async (table) => { await ready(); return native.clearTable(table); },
    clearAll: async () => { await ready(); return native.clearAll(); },
    tableStats: async () => { await ready(); return native.tableStats(); },
    saveLocalClaim,
    localClaims,
    findLocalClaim,
    enqueue,
    pending: async (opts) => { await ready(); return native.pending(opts && opts.limit); },
    outboxAll: async () => { await ready(); return native.outboxAll(); },
    outboxCount: async () => { await ready(); return native.outboxCount(); },
    updateOutbox: async (clientId, patch) => { await ready(); return native.outboxUpdate(clientId, patch); },
    removeOutbox: async (clientId) => { await ready(); return native.outboxDelete(clientId); },
    markFailed: async (clientId, detail) => { await ready(); return native.markFailed(clientId, detail || {}); },
    markSynced: async (clientId, serverRef) => { await ready(); return native.markSynced(clientId, serverRef); },
    purgeSynced: async (opts) => { await ready(); return native.purgeSynced(opts && opts.olderThanHours); },
    requeue: async (clientId) => { await ready(); return native.requeue(clientId); },
    metaGet: async (key, fallback) => {
      await ready();
      const value = await native.metaGet(key);
      return value == null ? (fallback == null ? null : fallback) : value;
    },
    metaSet: async (key, value) => { await ready(); return native.metaSet(key, value); },
    metaAll: async () => { await ready(); return native.metaAll(); },
    log: async (entry) => { await ready(); return native.logPut(entry); },
    logAll: async (opts) => { await ready(); return native.logAll(opts && opts.limit); },
    logClear: async () => { await ready(); return native.logClear(); },
    exportAll: async () => {
      await ready();
      const backup = await native.exportAll();
      backup.device = SR.device && SR.device.current ? SR.device.current() : null;
      return backup;
    },
    importAll: async (backup, opts) => { await ready(); return native.importAll(backup, opts || {}); },
    estimate: async () => {
      await ready();
      const info = await native.info();
      return { usage: info.bytes || 0, quota: 0, engine: 'sqlite', file: info.file };
    },
    requestPersistence: async () => true,
  };
}(window));
