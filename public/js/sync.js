'use strict';
// =====================================================================
// public/js/sync.js — THE OFFLINE-FIRST ENGINE
// =====================================================================
// Two directions, and they are not symmetric:
//
//   PUSH — the outbox. Everything the shop did while the line was down, replayed
//          against the real endpoints with the idempotency key it was created
//          with. A 4xx is a decision and moves to FAILED; a 5xx or a timeout is a
//          hiccup and stays PENDING for the next attempt.
//
//   PULL — the mirror. Reference data (catalogue, prices, customers, stock as at
//          last sync, and the purchase orders that stock was received on) so the
//          POS can price a cart with no network. It runs on a cursor, so a normal
//          sync moves a few rows rather than the whole catalogue.
//
//          An installed PWA cannot open a native SQLite file. This IndexedDB
//          mirror is the on-device database: stock quantities, prices, customers,
//          received orders, and the outbox. The browser is asked to keep it.
//
// ORDER MATTERS. A device's queued sale must reach the server BEFORE that device
// pulls a fresh mirror, or the pull would overwrite the local stock figures with
// numbers that do not include the sale, and the cashier would see stock that has
// already been sold. So: push, then pull. Always.
//
// WHAT IS NEVER REQUEUED: a PULL. A stale read presented as current is worse than
// an honest "you are offline", and the app says so on every screen that reads.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};

  const PULL_TABLES = [
    'businesses', 'branches', 'users', 'customer_classes', 'customers',
    'product_categories', 'products', 'product_units', 'product_variants', 'product_barcodes',
    'price_lists', 'price_list_items', 'product_price_overrides', 'suppliers',
    'stock_batches', 'purchase_orders', 'purchase_order_items', 'product_measures', 'deposits', 'instalment_plans', 'delivery_jobs', 'client_settings',
    'branch_compliance_records', 'branch_safe_ledger',
    'sales', 'sale_items', 'sale_payments', 'sale_serials', 'sale_returns', 'sale_return_items',
    'customer_bills', 'bill_holds', 'sale_issues', 'change_owed', 'till_sessions', 'serial_numbers',
  ];
  const SALES_TABLES = ['sales', 'sale_items', 'sale_payments', 'sale_serials', 'sale_returns', 'sale_return_items', 'customer_bills', 'bill_holds', 'sale_issues', 'change_owed', 'till_sessions', 'serial_numbers'];

  const AUTO_INTERVAL_MS = 3 * 60 * 1000;
  const WAITING_RETRY_MS = 20 * 1000;
  const DEBOUNCE_AFTER_QUEUE_MS = 2500;
  const COUNTER_COPY_MS = 10 * 60 * 1000;
  const VERTICAL_COPY_MS = 15 * 60 * 1000;
  const SALES_FULL_MS = 6 * 60 * 60 * 1000;
  const DETAIL_BATCH = 24;

  let running = null;
  let timer = null;
  let debounceTimer = null;
  const listeners = new Map();

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }
  function emit(event, detail) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) { try { fn(detail); } catch (e) { /* keep going */ } }
  }

  function status() {
    return {
      online: SR.api.isOnline(),
      running: Boolean(running),
      lastPushAt: lastPushAt,
      lastPullAt: lastPullAt,
      lastError: lastError,
    };
  }
  let lastPushAt = null;
  let lastPullAt = null;
  let lastError = null;

  // -------------------------------------------------------------------
  // PUSH
  // -------------------------------------------------------------------
  /**
   * Send the outbox.
   *
   * Batched at 100 and never more: the server caps a sync at 500 items, and a
   * device that has been offline for a week must be able to make visible
   * progress rather than sit on one enormous request that times out at the
   * counter. Results are applied per item, so one rejected sale does not hold up
   * the ninety-nine behind it.
   */
  async function push({ batchSize = 100 } = {}) {
    if (!SR.api.isOnline()) return { ok: false, offline: true, applied: 0, rejected: 0 };
    if (!SR.api.hasToken()) {
      emit('needs-sign-in', { waiting: true });
      return { ok: false, offline: false, needsAuth: true, applied: 0, rejected: 0 };
    }

    const me = SR.state.user && SR.state.user.id;
    const queued = (await SR.store.pending()).filter((item) => !me || !item.user_id || item.user_id === me).slice(0, batchSize);
    if (!queued.length) return { ok: true, applied: 0, rejected: 0, empty: true };

    const branchId = SR.state.activeBranchId;
    const body = {
      device_id: SR.device.current().id,
      app_version: SR.APP_VERSION,
      client_time: new Date().toISOString(),
      pending_push_count: queued.length,
      // The branch travels with the push so a row created on this device is born
      // in the shop it was created in. The server refuses to take it from the
      // payload of any individual item.
      branch_id: branchId || undefined,
      operations: queued.map((item) => ({
        type: item.type,
        client_id: item.client_id,
        idempotency_key: item.client_id,
        occurred_at: item.occurred_at,
        params: item.path_params || undefined,
        payload: stripInternal(item.payload || {}),
      })),
    };

    let result;
    try {
      result = await SR.api.post('/api/sync/push', body, { timeoutMs: 45000, quiet: true });
    } catch (err) {
      lastError = err.message;
      const deadToken = err && (err.code === 'TOKEN_EXPIRED' || err.code === 'BAD_TOKEN' || err.code === 'NO_TOKEN' || err.code === 'SESSION_SUPERSEDED');
      if (deadToken) emit('needs-sign-in', { waiting: true, code: err.code });
      // A machine-level failure (offline, timeout, 5xx) leaves everything in the
      // queue for the next attempt.
      if (err.retryable || err.isOffline || err.isAuth) {
        await SR.store.log({ kind: 'PUSH', status: 'FAILED', count: queued.length, message: err.message });
        emit('change', status());
        return { ok: false, error: err, applied: 0, rejected: 0 };
      }
      // A refusal that will not improve on its own (a rejected payload, a schema
      // fault, a 400 from the server's own bookkeeping). The queue keeps its items —
      // nothing is thrown away — but each one now carries the reason, so the Sync
      // screen can say why they are sitting there instead of showing a count that
      // never moves and no explanation.
      await SR.store.log({ kind: 'PUSH', status: 'FAILED', count: queued.length, message: err.message });
      for (const item of queued) {
        await SR.store.updateOutbox(item.client_id, {
          last_code: err.code || 'PUSH_REFUSED',
          last_error: err.message || 'The server refused this batch.',
        }).catch(() => {});
      }
      emit('change', status());
      throw err;
    }

    const results = (result && result.results && result.results.operations) || [];
    let applied = 0; let rejected = 0; let conflicts = 0; let quarantined = 0;
    const failures = [];

    for (const r of results) {
      const key = r.clientId;
      if (!key) continue;
      if (r.status === 'APPLIED' || r.status === 'ALREADY_APPLIED') {
        applied += 1;
        const item = queued.find((q) => q.client_id === key);
        const payload = (item && item.payload) || {};
        const claim = r.result && r.result.claimCode;
        if (claim && SR.store.saveLocalClaim) {
          const owed = Number(r.result.changeOwed || payload.change_owed_amount) || 0;
          if (owed > 0) {
            await SR.store.saveLocalClaim({
              claim_code: claim,
              amount: owed,
              customer_name: payload.walk_in_name || payload.customer_name || 'Walk-in customer',
              customer_phone: payload.walk_in_phone || payload.customer_phone || null,
              sale_id: r.result.saleId || null,
              receipt_no: r.result.receiptNo || null,
              expires_at: r.result.claimExpiresAt || null,
              synced: 1,
              status: payload.claim_already_redeemed ? 'REDEEMED' : 'OUTSTANDING',
            }).catch(() => {});
          }
          if (!payload.claim_code && SR.ui && SR.ui.ok) {
            SR.ui.ok(`A queued sale left change owed. Collection code ${claim}.`);
          }
        }
        await SR.store.markSynced(key, r.result ? r.result.saleId || r.result.receiptNo || null : null);
      } else if (r.status === 'QUARANTINED') {
        // THE SERVER WILL QUARANTINE IT AGAIN EVERY TIME, SO IT MUST NOT BE RETRIED.
        //
        // This is the one outcome where "leave it and try later" is the wrong
        // answer: the operation is dated before a data cleanup, so it can never be
        // applied — retrying it forever would show the counter a queue that never
        // drains. It is marked FAILED, which puts it in front of a person on the Sync
        // screen, with the server's own sentence about why.
        quarantined += 1;
        await SR.store.markFailed(key, { code: r.code || 'STALE_AFTER_CLEANUP', message: r.message });
        failures.push({ key, code: r.code || 'STALE_AFTER_CLEANUP', message: r.message, quarantined: true });
      } else if (r.status === 'REJECTED' || r.status === 'ERROR') {
        if (r.retryable) {
          conflicts += 1;
          await SR.store.updateOutbox(key, {
            status: 'RETRY',
            attempts: null,
            last_code: r.code || 'RETRY',
            last_error: r.message || 'The server could not apply this yet.',
          });
        } else {
          rejected += 1;
          await SR.store.markFailed(key, { code: r.code, message: r.message });
          failures.push({ key, code: r.code, message: r.message });
        }
      }
    }

    // An item the server never mentioned — a protocol mismatch — is left PENDING
    // rather than assumed applied. Assuming would lose a sale silently.
    const mentioned = new Set(results.map((r) => r.clientId));
    for (const item of queued) {
      if (mentioned.has(item.client_id)) continue;
      await SR.store.updateOutbox(item.client_id, { last_error: 'The server did not report on this item; it will be retried.' });
    }

    lastPushAt = new Date().toISOString();
    lastError = failures.length ? failures[0].message : null;
    await SR.store.log({
      kind: 'PUSH', status: rejected ? 'PARTIAL' : 'OK',
      count: queued.length, applied, rejected,
      message: `${applied} applied${rejected ? `, ${rejected} refused` : ''}${quarantined ? `, ${quarantined} quarantined after a cleanup` : ''}`,
    });
    await SR.store.purgeSynced({ olderThanHours: 48 });
    emit('change', status());
    return { ok: true, applied, rejected, retrying: conflicts, quarantined, failures, server: result };
  }

  /** Strip the fields this client added for its own bookkeeping. */
  function stripInternal(payload) {
    const copy = Object.assign({}, payload);
    delete copy._path;
    delete copy._label;
    return copy;
  }

  // -------------------------------------------------------------------
  // PULL
  // -------------------------------------------------------------------
  /**
   * Refresh the mirror.
   *
   * `full: true` ignores the cursor and re-fetches everything, which is what a
   * device does the first time and after an admin asks it to "re-download
   * everything" from the Sync screen.
   */
  function pullFailureReason(err) {
    const msg = String((err && (err.message || err.code)) || err || '');
    if (/did not answer|could not be reached|in time|timed out|timeout|failed to fetch|shop_read_failed/i.test(msg)) {
      return 'The shop did not finish sending the catalogue. Leave the till open and connected so it can try again.';
    }
    if (err && (err.isAuth || err.code === 'SESSION_SUPERSEDED' || err.code === 'NO_TOKEN')) {
      return 'The shop did not accept this session, so the catalogue was not copied.';
    }
    return msg || 'The catalogue download did not finish.';
  }

  async function rememberPullError(reason) {
    lastError = reason;
    try { await SR.store.metaSet('sync_pull_error', reason); } catch (err) { /* the chip still has lastError */ }
    if (/did not accept this session/i.test(String(reason || ''))) {
      try { await SR.store.metaSet('sales_copy_at', null); } catch (err) { /* Saved must not survive a refused session */ }
    }
  }

  function catalogueVisible(row) {
    return row && !Number(row.is_deleted) && Number(row.is_active) !== 0;
  }

  async function countCatalogueProducts() {
    const rows = await SR.store.all('products').catch(() => []);
    return (rows || []).filter(catalogueVisible).length;
  }

  // The catalogue screen is the count the shop actually has. A till that
  // stored 20 and then said Saved, while that screen has 50, was using an
  // old copy. Ask the shop, and if this till is short, download the names
  // again with no cursor before anyone is told they can disconnect.
  async function ensureCatalogue() {
    if (!SR.api.isOnline() || !SR.api.hasToken()) return null;
    let data;
    try {
      data = await SR.api.get('/api/products', { query: SR.state.query({ limit: 1 }), timeoutMs: 25000 });
    } catch (err) {
      await rememberPullError(pullFailureReason(err));
      return { refused: true };
    }
    const shopCount = data && data.paging ? Number(data.paging.total) : null;
    if (!Number.isFinite(shopCount)) return null;
    await SR.store.metaSet('shop_product_count', shopCount);
    let localCount = await countCatalogueProducts();
    if (localCount < shopCount) {
      const refill = await pullRequest({
        full: true,
        tables: ['products', 'product_categories', 'product_units', 'product_variants', 'product_barcodes', 'product_measures'],
        saveCursor: false,
        stamp: false,
      });
      if (!refill || !refill.ok) return { refused: true, short: true, shopCount, localCount };
      localCount = await countCatalogueProducts();
    }
    if (localCount < shopCount) {
      await rememberPullError('The shop has ' + shopCount + ' products. This till stored ' + localCount + ', so the catalogue was not copied in full.');
      return { refused: false, short: true, shopCount, localCount };
    }
    return { refused: false, short: false, shopCount, localCount };
  }

  async function pull({ full = false, tables = null } = {}) {
    if (!SR.api.isOnline()) {
      const products = await SR.store.all('products').catch(() => []);
      const stock = await SR.store.all('stock_batches').catch(() => []);
      if (!products.length && !stock.length) {
        await rememberPullError('The shop did not answer, so the catalogue was not copied onto this till.');
      }
      return { ok: false, offline: true, rows: 0 };
    }
    if (!SR.api.hasToken()) return { ok: false, needsAuth: true, rows: 0 };
    if (tables) return pullRequest({ full, tables, saveCursor: true, stamp: true });

    // One request for the whole catalogue was cut off before a row was stored,
    // and the chip then said Not saved. Write each group as it arrives. The
    // names come first, then the shelf, then the rest. A later miss keeps what
    // already landed.
    const groups = [
      ['products', 'product_categories', 'product_units', 'product_variants', 'product_barcodes'],
      ['price_lists', 'price_list_items', 'product_price_overrides', 'stock_batches', 'purchase_orders'],
      ['businesses', 'branches', 'users', 'customer_classes', 'customers', 'suppliers', 'deposits', 'instalment_plans', 'delivery_jobs', 'client_settings', 'branch_compliance_records', 'branch_safe_ledger'],
    ];
    let rows = 0;
    let cursor = null;
    let truncated = [];
    let softErrors = [];
    let failed = null;
    for (const group of groups) {
      let result = await pullRequest({ full, tables: group, saveCursor: false, stamp: false });
      if (!result.ok && result.fast) result = await pullRequest({ full, tables: group, saveCursor: false, stamp: false });
      rows += result.rows || 0;
      if (result.cursor) cursor = result.cursor;
      if (result.truncated && result.truncated.length) truncated = truncated.concat(result.truncated);
      if (result.softErrors && result.softErrors.length) softErrors = softErrors.concat(result.softErrors);
      if (!result.ok) { failed = result; break; }
    }
    if (failed) {
      try { await SR.store.metaSet('sync_incomplete_since', await SR.store.metaGet('sync_cursor', null)); } catch (err) { /* the error sentence is already stored */ }
      emit('change', status());
      return { ok: false, rows, error: failed.error };
    }
    const catalogue = await ensureCatalogue();
    if (catalogue && (catalogue.refused || catalogue.short)) {
      try { await SR.store.metaSet('sync_incomplete_since', await SR.store.metaGet('sync_cursor', null)); } catch (err) { /* the sentence is already stored */ }
      emit('change', status());
      return { ok: false, rows, error: new Error(lastError || 'The catalogue was not copied in full.') };
    }
    if (cursor) await SR.store.metaSet('sync_cursor', cursor);
    const savedAt = SR.util.nowIso();
    await SR.store.metaSet('last_pull_at', savedAt);
    await SR.store.metaSet('sync_truncated', truncated);
    await SR.store.metaSet('sync_pull_error', null);
    lastError = null;
    await SR.store.metaSet('sync_incomplete_since', softErrors.length ? (await SR.store.metaGet('sync_cursor', null)) : null);
    const products = await SR.store.all('products').catch(() => []);
    const stock = await SR.store.all('stock_batches').catch(() => []);
    await SR.store.metaSet('catalogue_empty', products.length === 0 && stock.length === 0);
    lastPullAt = savedAt;
    emit('change', status());
    return { ok: true, rows, cursor, truncated };
  }

  async function replayUnsyncedShelf() {
    if (!SR.shelf || !SR.store || !SR.store.pending) return;
    const pending = await SR.store.pending().catch(() => []);
    const writes = pending.filter((row) => row && (row.type === 'SALE' || row.type === 'STOCK_ADJUST') && row.payload);
    if (!writes.length) return;
    writes.sort((a, b) => String(a.occurred_at || a.at || '').localeCompare(String(b.occurred_at || b.at || '')));
    const units = await SR.store.all('product_units').catch(() => []);
    const unitsByProduct = new Map();
    for (const row of units) {
      const id = String(row.product_id);
      const list = unitsByProduct.get(id) || [];
      list.push(row);
      unitsByProduct.set(id, list);
    }
    let batches = await SR.store.all('stock_batches').catch(() => []);
    const changed = new Map();
    for (const item of writes) {
      const payload = item.payload || {};
      const asOf = String(item.occurred_at || payload.sold_at || '').slice(0, 10);
      const next = item.type === 'SALE'
        ? SR.shelf.consumeLines(batches, payload.lines || [], {
          unitsByProduct,
          asOf: asOf || null,
          holds: payload.stock_holds || payload.stockHolds || [],
        })
        : SR.shelf.adjustLine(batches, payload, unitsByProduct.get(String(payload.product_id)) || []);
      if (!next.length) continue;
      for (const row of next) {
        changed.set(String(row.id), row);
        const index = batches.findIndex((batch) => String(batch.id) === String(row.id));
        if (index >= 0) batches[index] = row;
        else batches.push(row);
      }
    }
    if (changed.size) await SR.store.putMany('stock_batches', [...changed.values()]);
  }

  async function pullRequest({ full = false, tables = null, saveCursor = true, stamp = true } = {}) {
    const since = full ? null : await SR.store.metaGet('sync_cursor', null);
    const branchId = SR.state.activeBranchId;
    // The shelf is copied in full the first time and about every 15 minutes.
    // A cursor still brings a receipt that moved updated_at. Coming back
    // online inside that window does not read every carton again.
    const asking = tables || PULL_TABLES;
    const fullTables = [];
    const shelfAt = await SR.store.metaGet('shelf_full_at').catch(() => null);
    const shelfDue = Boolean(full || copyDue(shelfAt, Date.now(), 15 * 60 * 1000));
    if (shelfDue && asking.includes('stock_batches')) fullTables.push('stock_batches');
    if (shelfDue && asking.includes('purchase_orders')) fullTables.push('purchase_orders');
    const pulledSales = await SR.store.metaGet('pulled_sales_tables').catch(() => null);
    const gap = await SR.store.metaGet('pull_gap').catch(() => []);
    const gapNames = Array.isArray(gap) ? gap : [];
    if (!pulledSales || gapNames.some((name) => SALES_TABLES.includes(name))) {
      for (const name of SALES_TABLES) if (asking.includes(name) && !fullTables.includes(name)) fullTables.push(name);
    }
    let result;
    const started = Date.now();
    try {
      result = await SR.api.post('/api/sync/pull', {
        device_id: SR.device.current().id,
        app_version: SR.APP_VERSION,
        since: since || undefined,
        branch_id: branchId || undefined,
        include_all_branches: true,
        include_all_businesses: true,
        tables: asking,
        full_tables: fullTables.length ? fullTables : undefined,
      }, { timeoutMs: 70000 });
    } catch (err) {
      const reason = pullFailureReason(err);
      await rememberPullError(reason);
      await SR.store.log({ kind: 'PULL', status: 'FAILED', count: 0, message: reason }).catch(() => {});
      emit('change', status());
      return { ok: false, error: err, rows: 0, fast: Date.now() - started < 8000 };
    }
    if (!result || !result.tables) {
      const reason = 'The shop answered without a catalogue, so nothing was written.';
      await rememberPullError(reason);
      return { ok: false, error: new Error(reason), rows: 0, fast: false };
    }
    const blocking = Object.entries(result.tables).filter(([name, item]) => item && item.error && (name === 'products' || name === 'stock_batches'));
    if (blocking.length) {
      const reason = 'A catalogue table did not download (' + blocking[0][1].error + '). What already arrived is kept.';
      await rememberPullError(reason);
      return { ok: false, error: new Error(reason), rows: 0, fast: false };
    }
    const softErrors = Object.entries(result.tables).filter(([, item]) => item && item.error).map(([name]) => name);

    let rows = 0;
    let sent = 0;
    let acknowledged = false;
    const perTable = [];
    try {
      for (const [table, payload] of Object.entries(result.tables || {})) {
        if (!payload || !Array.isArray(payload.rows)) continue;
        sent += payload.rows.length;
        const wrote = await SR.store.putMany(table, payload.rows);
        if (wrote != null) acknowledged = true;
        rows += Number(wrote) || 0;
        perTable.push({ table, count: Number(wrote) || 0 });
        if (table === 'stock_batches') {
          if (SR.store && SR.store.engine === 'sqlite' && SR.store.replayShelf) await SR.store.replayShelf().catch(() => {});
          else await replayUnsyncedShelf().catch(() => {});
        }
      }
    } catch (err) {
      const reason = pullFailureReason(err);
      await rememberPullError(reason);
      return { ok: false, error: err, rows, fast: false };
    }
    if (sent > 0 && rows === 0 && !acknowledged) {
      const reason = 'The shop sent catalogue rows, but this till could not store them.';
      await rememberPullError(reason);
      return { ok: false, error: new Error(reason), rows: 0, fast: false };
    }

    // Only advance the cursor when the whole pull succeeded. Moving it past a
    // table that errored would make those rows permanently invisible to this
    // device — it would ask for "everything since" a moment the rows never
    // arrived in. A shelf-only prefetch must not move it either: that request
    // does not carry the catalogue.
    const tableErrors = Object.entries((result && result.tables) || {}).filter(([, item]) => item && item.error);
    const hardErrors = tableErrors.filter(([, item]) => item.error !== 'not_syncable');
    const gaps = tableErrors.filter(([, item]) => item.error === 'not_syncable').map(([name]) => name);
    await SR.store.metaSet('pull_gap', gaps);
    if (result && result.tables && result.tables.sales && !result.tables.sales.error) {
      await SR.store.metaSet('pulled_sales_tables', true);
    }
    if (shelfDue && result.tables && result.tables.stock_batches && !result.tables.stock_batches.error) {
      await SR.store.metaSet('shelf_full_at', new Date().toISOString());
    }
    if (saveCursor && result && result.cursor && !hardErrors.length) {
      await SR.store.metaSet('sync_cursor', result.cursor);
      if (fullTables.includes('purchase_orders') && result.tables && result.tables.purchase_orders && !result.tables.purchase_orders.error) {
        await SR.store.metaSet('pulled_purchase_orders', true);
      }
    } else if (saveCursor && result && result.cursor) {
      // An errored table means the cursor is kept but flagged, so the UI can say
      // the mirror is incomplete rather than quietly pretending otherwise.
      await SR.store.metaSet('sync_incomplete_since', since || null);
    }
    if (stamp) {
      const savedAt = SR.util.nowIso();
      await SR.store.metaSet('last_pull_at', savedAt);
      await SR.store.metaSet('sync_truncated', (result && result.truncatedTables) || []);
      await SR.store.metaSet('sync_pull_error', null);
      lastPullAt = savedAt;
    }
    await SR.store.log({
      kind: 'PULL', status: 'OK', count: rows,
      message: result && result.fullSync ? `Full sync: ${rows} rows` : `${rows} changed rows`,
    });
    emit('change', status());
    return { ok: true, rows, perTable, cursor: result && result.cursor, fullSync: Boolean(result && result.fullSync), truncated: (result && result.truncatedTables) || [], softErrors };
  }

  // The live shop already answers GET /api/sales. Copy that book into the
  // same tables the pull writes, so a till built before the shop knows the
  // new tables still has the receipts, the lines, and the payments offline.
  function rowsOf(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.records)) return data.records;
    if (Array.isArray(data.rows)) return data.rows;
    if (Array.isArray(data.vehicles)) return data.vehicles;
    if (Array.isArray(data.assets)) return data.assets;
    return [];
  }

  async function businessesInScope() {
    const seen = new Map();
    const local = await SR.store.all('businesses').catch(() => []);
    const live = (SR.state && SR.state.businesses) ? SR.state.businesses() : [];
    for (const row of [...live, ...(local || [])]) {
      if (row && row.id != null) seen.set(String(row.id), row);
    }
    if (!seen.size && SR.state && SR.state.activeBusinessId) {
      seen.set(String(SR.state.activeBusinessId), { id: SR.state.activeBusinessId });
    }
    return [...seen.values()];
  }

  async function copyPaged(path, query, pages) {
    const out = [];
    let offset = 0;
    for (let page = 0; page < (pages || 4); page += 1) {
      const data = await SR.api.get(path, { query: Object.assign({ limit: 200, offset }, query || {}), timeoutMs: 20000 }).catch(() => null);
      const rows = rowsOf(data).filter((row) => row && row.id != null);
      out.push(...rows);
      if (!rows.length || !data || !data.paging || !data.paging.hasMore) break;
      offset = data.paging.nextOffset == null ? offset + rows.length : data.paging.nextOffset;
    }
    return out;
  }

  function copyDue(lastAt, now, minMs) {
    if (!lastAt) return true;
    const then = Date.parse(String(lastAt).replace(' ', 'T'));
    if (!Number.isFinite(then)) return true;
    return (Number(now) || 0) - then >= Number(minMs);
  }

  function dayBefore(iso) {
    const day = String(iso || '').slice(0, 10);
    const then = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(then)) return '2020-01-01';
    return new Date(then - 86400000).toISOString().slice(0, 10);
  }

  function saleFingerprint(row) {
    if (!row) return '';
    return [row.status, row.settlement, row.payment_method, row.total, row.amount_paid, row.balance_due, row.item_count, row.voided_at, row.change_owed, row.notes]
      .map((value) => (value == null ? '' : String(value))).join('|');
  }

  async function changedOnly(table, rows) {
    const out = [];
    for (const row of rows || []) {
      if (!row || row.id == null) continue;
      const next = row.updated_at == null || row.updated_at === '' ? null : String(row.updated_at);
      if (!next || !SR.store || !SR.store.get) { out.push(row); continue; }
      const local = await SR.store.get(table, row.id).catch(() => null);
      const prev = local && local.updated_at != null && local.updated_at !== '' ? String(local.updated_at) : null;
      if (prev !== next) out.push(row);
    }
    return out;
  }

  async function saveRows(table, rows) {
    const list = await changedOnly(table, rows);
    if (!list.length || !SR.store || !SR.store.putMany) return 0;
    const wrote = await SR.store.putMany(table, list);
    return Number(wrote) || list.length;
  }

  async function takeChanged(table, rows, cap) {
    const book = await SR.store.metaGet('detail_done_' + table).catch(() => null) || {};
    const out = [];
    for (const row of rows || []) {
      if (!row || row.id == null) continue;
      const next = row.updated_at == null || row.updated_at === '' ? 'listed' : String(row.updated_at);
      if (book[String(row.id)] === next) continue;
      out.push(row);
    }
    return out.slice(0, cap);
  }

  async function markDetailed(table, rows) {
    if (!SR.store || !rows || !rows.length) return;
    const book = await SR.store.metaGet('detail_done_' + table).catch(() => null) || {};
    for (const row of rows) {
      if (!row || row.id == null) continue;
      book[String(row.id)] = row.updated_at == null || row.updated_at === '' ? 'listed' : String(row.updated_at);
    }
    const trimmed = {};
    for (const id of Object.keys(book).slice(-1500)) trimmed[id] = book[id];
    await SR.store.metaSet('detail_done_' + table, trimmed);
  }

  function stamp(row, businessId) {
    if (!row || row.id == null) return null;
    if (row.business_id == null && businessId) row.business_id = businessId;
    return row;
  }

  // Every vertical's own books, through the shop routes that are already live.
  // A phone shop's hire route answers 403. That is not a missing catalogue.
  // The full row is stored. Turso stays behind the Worker.
  async function copyVerticalBooks() {
    const now = Date.now();
    const last = await SR.store.metaGet('vertical_copy_at').catch(() => null);
    if (!copyDue(last, now, VERTICAL_COPY_MS)) return 0;
    const first = !last;
    const listPages = first ? 4 : 1;
    const from = first ? '2020-01-01' : dayBefore(last);
    let wrote = 0;
    const businesses = await businessesInScope();
    if (!businesses.length) return 0;
    const to = (SR.util && SR.util.todayWat) ? SR.util.todayWat() : new Date().toISOString().slice(0, 10);
    for (const business of businesses) {
      const q = { business_id: business.id };
      const agreements = (await copyPaged('/api/agreements', q, listPages)).map((row) => stamp(row, business.id));
      const agreeTargets = await takeChanged('asset_agreements', agreements, first ? 40 : 8);
      wrote += await saveRows('asset_agreements', agreements);
      const lines = [];
      const agreementSchedule = [];
      const agreeDone = [];
      for (let i = 0; i < agreeTargets.length; i += 4) {
        const chunk = agreeTargets.slice(i, i + 4);
        const details = await Promise.all(chunk.map((row) => SR.api.get('/api/agreements/' + encodeURIComponent(row.id), { timeoutMs: 15000 }).catch(() => null)));
        for (let n = 0; n < details.length; n += 1) {
          const detail = details[n];
          if (!detail) continue;
          agreeDone.push(chunk[n]);
          if (detail.agreement) await saveRows('asset_agreements', [stamp(detail.agreement, business.id)]);
          for (const row of detail.lines || []) if (row && row.id != null) lines.push(stamp(row, business.id));
          for (const row of detail.schedule || []) if (row && row.id != null) agreementSchedule.push(stamp(row, business.id));
        }
      }
      await markDetailed('asset_agreements', agreeDone);
      wrote += await saveRows('asset_agreement_lines', lines);
      wrote += await saveRows('asset_agreement_schedule', agreementSchedule);

      const jobs = [];
      const statuses = first ? [undefined, 'DELIVERED', 'CANCELLED', 'RETURNED', 'ASSIGNED', 'IN_TRANSIT'] : [undefined];
      for (const status of statuses) {
        jobs.push(...await copyPaged('/api/deliveries', Object.assign({ status }, q), first ? 3 : 1));
      }
      const jobTargets = await takeChanged('delivery_jobs', jobs, first ? 30 : 8);
      wrote += await saveRows('delivery_jobs', jobs.map((row) => stamp(row, business.id)));
      const jobItems = [];
      const installs = [];
      const jobDone = [];
      for (let i = 0; i < jobTargets.length; i += 4) {
        const chunk = jobTargets.slice(i, i + 4);
        const details = await Promise.all(chunk.map((row) => SR.api.get('/api/deliveries/' + encodeURIComponent(row.id), { timeoutMs: 15000 }).catch(() => null)));
        for (let n = 0; n < details.length; n += 1) {
          const detail = details[n];
          if (!detail) continue;
          jobDone.push(chunk[n]);
          if (detail.job) await saveRows('delivery_jobs', [stamp(detail.job, business.id)]);
          for (const row of detail.items || []) if (row && row.id != null) jobItems.push(row);
          for (const row of detail.installations || []) if (row && row.id != null) installs.push(stamp(row, business.id));
        }
      }
      await markDetailed('delivery_jobs', jobDone);
      wrote += await saveRows('delivery_job_items', jobItems);
      wrote += await saveRows('installation_jobs', installs);

      wrote += await saveRows('warranty_claims', (await copyPaged('/api/warranty-claims', q, listPages)).map((row) => stamp(row, business.id)));
      wrote += await saveRows('sale_returns', (await copyPaged('/api/returns', q, listPages)).map((row) => stamp(row, business.id)));
      wrote += await saveRows('deposits', (await copyPaged('/api/deposits', q, listPages)).map((row) => stamp(row, business.id)));
      const plans = (await copyPaged('/api/instalments', q, listPages)).map((row) => stamp(row, business.id));
      const planTargets = await takeChanged('instalment_plans', plans, first ? 30 : 8);
      wrote += await saveRows('instalment_plans', plans);
      const planLines = [];
      const planPays = [];
      const planDone = [];
      for (let i = 0; i < planTargets.length; i += 4) {
        const chunk = planTargets.slice(i, i + 4);
        const details = await Promise.all(chunk.map((row) => SR.api.get('/api/instalments/' + encodeURIComponent(row.id), { timeoutMs: 15000 }).catch(() => null)));
        for (let n = 0; n < details.length; n += 1) {
          const detail = details[n];
          if (!detail) continue;
          planDone.push(chunk[n]);
          if (detail.plan) await saveRows('instalment_plans', [stamp(detail.plan, business.id)]);
          for (const row of detail.schedule || []) if (row && row.id != null) planLines.push(row);
          for (const row of detail.payments || []) if (row && row.id != null) planPays.push(row);
        }
      }
      await markDetailed('instalment_plans', planDone);
      wrote += await saveRows('instalment_schedule', planLines);
      wrote += await saveRows('instalment_payments', planPays);

      wrote += await saveRows('product_recalls', (await copyPaged('/api/recalls', q, first ? 3 : 1)).map((row) => stamp(row, business.id)));
      const transfers = (await copyPaged('/api/transfers', q, listPages)).map((row) => stamp(row, business.id));
      const transferTargets = await takeChanged('stock_transfers', transfers, first ? 20 : 6);
      wrote += await saveRows('stock_transfers', transfers);
      const transferItems = [];
      const transferDone = [];
      for (let i = 0; i < transferTargets.length; i += 4) {
        const chunk = transferTargets.slice(i, i + 4);
        const details = await Promise.all(chunk.map((row) => SR.api.get('/api/transfers/' + encodeURIComponent(row.id), { timeoutMs: 15000 }).catch(() => null)));
        for (let n = 0; n < details.length; n += 1) {
          const detail = details[n];
          if (!detail) continue;
          transferDone.push(chunk[n]);
          const items = (detail.items || detail.lines) || [];
          for (const row of items) if (row && row.id != null) transferItems.push(row);
        }
      }
      await markDetailed('stock_transfers', transferDone);
      wrote += await saveRows('stock_transfer_items', transferItems);

      const counts = (await copyPaged('/api/stocktakes', q, first ? 3 : 1)).map((row) => stamp(row, business.id));
      const countTargets = await takeChanged('stocktake_sessions', counts, first ? 15 : 4);
      wrote += await saveRows('stocktake_sessions', counts);
      const countLines = [];
      const countDone = [];
      for (let i = 0; i < countTargets.length; i += 3) {
        const chunk = countTargets.slice(i, i + 3);
        const details = await Promise.all(chunk.map((row) => SR.api.get('/api/stocktakes/' + encodeURIComponent(row.id), { timeoutMs: 15000 }).catch(() => null)));
        for (let n = 0; n < details.length; n += 1) {
          const detail = details[n];
          if (!detail) continue;
          countDone.push(chunk[n]);
          const lines = (detail.lines || detail.items) || [];
          for (const row of lines) if (row && row.id != null) countLines.push(row);
        }
      }
      await markDetailed('stocktake_sessions', countDone);
      wrote += await saveRows('stocktake_lines', countLines);

      wrote += await saveRows('stock_adjustments', (await copyPaged('/api/adjustments', Object.assign({ from, to }, q), listPages)).map((row) => stamp(row, business.id)));
      wrote += await saveRows('expenses', (await copyPaged('/api/expenses', Object.assign({ from, to }, q), first ? 6 : 1)).map((row) => stamp(row, business.id)));
      wrote += await saveRows('branch_compliance_records', (await copyPaged('/api/compliance/records', q, first ? 3 : 1)).map((row) => stamp(row, business.id)));
      wrote += await saveRows('creditor_ledger', (await copyPaged('/api/creditors', q, first ? 3 : 1)).map((row) => stamp(row, business.id)));
      wrote += await saveRows('debtor_ledger', (await copyPaged('/api/customers/debtors', q, first ? 3 : 1)).map((row) => stamp(row, business.id)));
      wrote += await saveRows('controlled_substance_register', (await copyPaged('/api/pharmacy/register', q, first ? 2 : 1)).map((row) => stamp(row, business.id)));

      const fleet = await SR.api.get('/api/dispatch', { query: q, timeoutMs: 15000 }).catch(() => null);
      wrote += await saveRows('delivery_vehicles', rowsOf(fleet).map((row) => stamp(row, business.id)));
      const duties = await SR.api.get('/api/dispatch/duties', { query: Object.assign({ active: 0, mine: 0 }, q), timeoutMs: 15000 }).catch(() => null);
      wrote += await saveRows('vehicle_duties', rowsOf(duties).map((row) => stamp(row, business.id)));
      const plant = await SR.api.get('/api/plant', { query: q, timeoutMs: 20000 }).catch(() => null);
      const assets = ((plant && plant.assets) || []).map((row) => row && row.id != null ? {
        id: row.id,
        business_id: business.id,
        name: row.name,
        kind: row.kind,
        acquired_at: row.acquiredAt || row.acquired_at,
        purchase_price: row.purchasePrice != null ? row.purchasePrice : row.purchase_price,
        supplier_name: row.supplierName || row.supplier_name,
        serial_no: row.serialNo || row.serial_no,
        status: row.status,
        stopped_at: row.stoppedAt || row.stopped_at,
        stopped_reason: row.stoppedReason || row.stopped_reason,
        notes: row.notes,
        is_deleted: row.retired ? 1 : 0,
        maintenance_total: row.maintenanceTotal,
        updated_at: row.updatedAt || row.updated_at || [row.status, row.purchasePrice, row.stoppedAt, row.retired ? 1 : 0].join('|'),
      } : null).filter(Boolean);
      wrote += await saveRows('plant_assets', assets);
    }

    await SR.store.metaSet('vertical_copy_at', new Date().toISOString());
    return wrote;
  }

  async function copyProductDetails() {
    if (!SR.store || !SR.store.all) return 0;
    const products = await SR.store.all('products').catch(() => []);
    const detailStamps = await SR.store.metaGet('product_detail_stamps').catch(() => null) || {};
    const needsDetail = (products || []).filter((row) => row && row.id != null && (
      row.nafdac_catalog_id || Number(row.is_controlled) || Number(row.requires_serial) || Number(row.offers_hire) || Number(row.offers_lease) || row.stock_role === 'INPUT'
    )).filter((row) => String(detailStamps[row.id] || '') !== String(row.updated_at || row.id)).slice(0, 12);
    if (!needsDetail.length) return 0;
    let wrote = 0;
    const registrations = [];
    for (let i = 0; i < needsDetail.length; i += 4) {
      const chunk = needsDetail.slice(i, i + 4);
      const details = await Promise.all(chunk.map((row) => SR.api.get('/api/products/' + encodeURIComponent(row.id), { timeoutMs: 15000 }).catch(() => null)));
      for (const detail of details) {
        if (!detail || !detail.product || detail.product.id == null) continue;
        wrote += await saveRows('products', [detail.product]);
        for (const row of detail.registrations || []) if (row && row.id != null) registrations.push(row);
        for (const row of detail.units || []) if (row && row.id != null) wrote += await saveRows('product_units', [row]);
        for (const row of detail.variants || []) if (row && row.id != null) wrote += await saveRows('product_variants', [row]);
        for (const row of detail.barcodes || []) if (row && row.id != null) wrote += await saveRows('product_barcodes', [row]);
        const measures = Array.isArray(detail.measures) ? detail.measures : (detail.measures ? [detail.measures] : []);
        for (const row of measures) if (row && row.id != null) wrote += await saveRows('product_measures', [row]);
        detailStamps[detail.product.id] = String(detail.product.updated_at || detail.product.id);
      }
    }
    wrote += await saveRows('product_registrations', registrations);
    await SR.store.metaSet('product_detail_stamps', detailStamps);
    return wrote;
  }

  async function copyCounterBooks() {
    const query = (extra) => (SR.state && SR.state.query ? SR.state.query(extra) : extra);
    let wrote = 0;
    const current = await SR.api.get('/api/tills/current', { query: query({}), timeoutMs: 15000 }).catch(() => null);
    if (current && current.till && current.till.id != null) wrote += await saveRows('till_sessions', [current.till]);
    const today = await SR.api.get('/api/attendance/today', { query: query({}), timeoutMs: 15000 }).catch(() => null);
    const liveAttendance = [];
    for (const row of (today && (today.records || today.data)) || []) if (row && row.id != null) liveAttendance.push(row);
    if (today && today.myOpen && today.myOpen.id != null) liveAttendance.push(today.myOpen);
    wrote += await saveRows('staff_attendance', liveAttendance);
    const last = await SR.store.metaGet('counter_copy_at').catch(() => null);
    if (!copyDue(last, Date.now(), COUNTER_COPY_MS)) return wrote;
    const to = (SR.util && SR.util.todayWat) ? SR.util.todayWat() : new Date().toISOString().slice(0, 10);
    const from = last ? dayBefore(last) : '2020-01-01';
    const tills = [];
    for (const status of ['OPEN', undefined]) {
      const data = await SR.api.get('/api/tills', { query: query({ status, from, to, limit: 200 }), timeoutMs: 20000 }).catch(() => null);
      for (const row of (data && data.data) || []) if (row && row.id != null) tills.push(row);
    }
    wrote += await saveRows('till_sessions', tills);
    const history = await SR.api.get('/api/attendance', { query: query({ from, to, limit: 200 }), timeoutMs: 20000 }).catch(() => null);
    wrote += await saveRows('staff_attendance', (history && history.data) || []);
    const owed = [];
    let offset = 0;
    const pages = last ? 1 : 6;
    for (let page = 0; page < pages; page += 1) {
      const data = await SR.api.get('/api/change-owed', { query: query({ status: 'ALL', limit: 200, offset }), timeoutMs: 20000 }).catch(() => null);
      const rows = (data && data.data) || [];
      owed.push(...rows.filter((row) => row && row.id != null));
      if (!rows.length || !data.paging || !data.paging.hasMore) break;
      offset = data.paging.nextOffset == null ? offset + rows.length : data.paging.nextOffset;
    }
    wrote += await saveRows('change_owed', owed);
    await SR.store.metaSet('counter_copy_at', new Date().toISOString());
    return wrote;
  }

  async function copySalesBook() {
    if (!SR.api.isOnline()) return { ok: false, count: 0, wrote: 0 };
    const prior = await SR.store.metaGet('sales_copy_at').catch(() => null);
    const fullAt = await SR.store.metaGet('sales_full_at').catch(() => null);
    const left = await SR.store.metaGet('sales_detail_left').catch(() => null) || [];
    const fullDue = !prior || copyDue(fullAt, Date.now(), SALES_FULL_MS);
    const to = (SR.util && SR.util.todayWat) ? SR.util.todayWat() : new Date().toISOString().slice(0, 10);
    const headers = [];
    let wrote = 0;
    const listAt = await SR.store.metaGet('sales_list_at').catch(() => null);
    const listDue = fullDue || copyDue(listAt, Date.now(), 10 * 60 * 1000);
    if (listDue) {
      const from = fullDue ? '2020-01-01' : dayBefore(prior);
      const pages = fullDue ? 12 : 2;
      let offset = 0;
      for (let page = 0; page < pages; page += 1) {
        const data = await SR.api.get('/api/sales', { query: { from, to, limit: 500, offset }, timeoutMs: 25000 });
        const rows = (data && data.data) || [];
        headers.push(...rows.filter((row) => row && row.id != null));
        if (!rows.length || !data.paging || !data.paging.hasMore) break;
        offset = data.paging.nextOffset == null ? offset + rows.length : data.paging.nextOffset;
      }
      await SR.store.metaSet('sales_list_at', new Date().toISOString());
      if (fullDue) await SR.store.metaSet('sales_full_at', new Date().toISOString());
    }
    const fps = await SR.store.metaGet('sale_list_fp').catch(() => null) || {};
    const headerFp = await SR.store.metaGet('sale_header_fp').catch(() => null) || {};
    const freshHeaders = headers.filter((row) => headerFp[row.id] !== saleFingerprint(row));
    wrote += await saveRows('sales', freshHeaders);
    for (const row of freshHeaders) headerFp[row.id] = saleFingerprint(row);
    const queued = headers.filter((row) => fps[row.id] !== saleFingerprint(row)).map((row) => ({ id: row.id, fp: saleFingerprint(row), tries: 0 }));
    const seen = new Set(queued.map((row) => row.id));
    const pending = queued.concat((left || []).filter((row) => row && row.id != null && !seen.has(row.id)));
    const batch = pending.slice(0, DETAIL_BATCH);
    const rest = pending.slice(DETAIL_BATCH, 200);
    const items = [];
    const payments = [];
    const serials = [];
    const owed = [];
    const prescriptions = [];
    const register = [];
    const failed = [];
    for (let i = 0; i < batch.length; i += 4) {
      const chunk = batch.slice(i, i + 4);
      const details = await Promise.all(chunk.map((row) => SR.api.get('/api/sales/' + encodeURIComponent(row.id), { timeoutMs: 20000 }).catch(() => null)));
      for (let n = 0; n < details.length; n += 1) {
        const detail = details[n];
        const asked = chunk[n];
        if (!detail || !detail.sale || detail.sale.id == null) {
          if ((asked.tries || 0) < 2) failed.push(Object.assign({}, asked, { tries: (asked.tries || 0) + 1 }));
          continue;
        }
        wrote += await saveRows('sales', [detail.sale]);
        fps[asked.id] = asked.fp;
        for (const row of detail.items || []) if (row && row.id != null) items.push(row);
        for (const row of detail.payments || []) if (row && row.id != null) payments.push(row);
        for (const row of detail.serials || []) if (row && row.id != null) serials.push(row);
        for (const row of detail.changeOwed || []) if (row && row.id != null) owed.push(row);
        for (const row of detail.prescriptions || []) if (row && row.id != null) prescriptions.push(row);
        for (const row of detail.controlledRegister || []) if (row && row.id != null) register.push(row);
      }
    }
    wrote += await saveRows('sale_items', items);
    wrote += await saveRows('sale_payments', payments);
    wrote += await saveRows('sale_serials', serials);
    wrote += await saveRows('change_owed', owed);
    wrote += await saveRows('prescriptions', prescriptions);
    wrote += await saveRows('controlled_substance_register', register);
    const billsAt = await SR.store.metaGet('bills_copy_at').catch(() => null);
    if (copyDue(billsAt, Date.now(), fullDue ? 0 : 15 * 60 * 1000)) {
      const bills = [];
      const statuses = fullDue || !billsAt ? ['OPEN', 'PAYING', 'PAID', 'CANCELLED'] : ['OPEN', 'PAYING'];
      for (const status of statuses) {
        const data = await SR.api.get('/api/bills', { query: { status }, timeoutMs: 20000 }).catch(() => null);
        for (const row of (data && data.data) || []) if (row && row.id != null) bills.push(row);
      }
      wrote += await saveRows('customer_bills', bills);
      await SR.store.metaSet('bills_copy_at', new Date().toISOString());
    }
    const savedAt = SR.util.nowIso();
    function trimMap(map) {
      const trimmed = {};
      for (const id of Object.keys(map).slice(-1000)) trimmed[id] = map[id];
      return trimmed;
    }
    await SR.store.metaSet('sales_detail_left', failed.concat(rest).slice(0, 200));
    await SR.store.metaSet('sale_list_fp', trimMap(fps));
    await SR.store.metaSet('sale_header_fp', trimMap(headerFp));
    await SR.store.metaSet('sales_copy_at', savedAt);
    if (fullDue) await SR.store.metaSet('sales_copy_count', headers.length);
    return { ok: true, count: headers.length, wrote };
  }

  // -------------------------------------------------------------------
  // THE CYCLE
  // -------------------------------------------------------------------
  function sessionBlipError(err) {
    return Boolean(err && (err.isAuth || err.code === 'SESSION_SUPERSEDED' || err.code === 'NO_TOKEN' || err.status === 401));
  }

  async function runOnce({ full = false, silent = false, catchUp = false } = {}) {
    if (running) return running;
    running = (async () => {
      let refresh = false;
      SR._uploading = true;
      const waitingNow = await SR.store.outboxCount().catch(() => 0);
      if ((waitingNow > 0 || catchUp) && SR.api.holdCatchUp) SR.api.holdCatchUp(180000);
      try {
        if (!SR.api.isOnline()) await SR.api.probe({ force: true });
        if (!SR.api.isOnline()) {
          refresh = false;
          await pull({ full });
          return { ok: false, offline: true };
        }
        emit('change', status());
        let pushResult = { applied: 0, rejected: 0 };
        try { pushResult = await push(); } catch (err) {
          lastError = err.message;
        }
        if (pushResult.applied) refresh = true;
        const pushBlip = Boolean(pushResult && pushResult.error && sessionBlipError(pushResult.error));
        if (pushBlip) {
          SR._pushBlips = (SR._pushBlips || 0) + 1;
          if (SR.api.holdCatchUp) SR.api.holdCatchUp(180000);
        } else if (pushResult && pushResult.applied) {
          SR._pushBlips = 0;
        }
        // PUSH first, then pull — always. Pulling first would fetch stock figures
        // that do not include the sales this device just made. A refused upload
        // is not a reason to open the rest of the shop, or to sign the till out.
        let pullResult = { ok: false, rows: 0 };
        if (pushBlip) {
          if (SR._pushBlips <= 3 && !SR._pushRetry) {
            SR._pushRetry = setTimeout(() => {
              SR._pushRetry = null;
              runOnce({ silent: true, catchUp: true }).catch(() => {});
            }, 5000);
          }
          return { ok: false, push: pushResult, pull: pullResult, refresh: false };
        }
        try { pullResult = await pull({ full }); } catch (err) {
          if (!(SR._catchingUp && sessionBlipError(err))) await rememberPullError(pullFailureReason(err));
        }
        if (pullResult && pullResult.rows) refresh = true;
        if (SR.api.isOnline()) {
          if (pullResult && pullResult.ok) {
            try {
              const salesCopy = await copySalesBook();
              if (salesCopy && salesCopy.wrote) refresh = true;
            } catch (err) {
              if (!(SR._catchingUp && sessionBlipError(err))) await rememberPullError(pullFailureReason(err));
            }
          }
          try {
            if (await copyCounterBooks()) refresh = true;
          } catch (err) {
            if (!(SR._catchingUp && sessionBlipError(err))) await rememberPullError(pullFailureReason(err));
          }
          try {
            if (await copyVerticalBooks()) refresh = true;
          } catch (err) { /* a feature this vertical does not use is not a short catalogue */ }
          try {
            if (await copyProductDetails()) refresh = true;
          } catch (err) { /* a product this vertical does not register is not a short catalogue */ }
        }
        if (!silent) {
          const bits = [];
          if (pushResult.applied) bits.push(`${pushResult.applied} sent`);
          if (pushResult.rejected) bits.push(`${pushResult.rejected} refused`);
          if (pullResult.rows) bits.push(`${pullResult.rows} rows received`);
          if (bits.length) SR.ui.ok(`Synced: ${bits.join(', ')}.`);
          else if (pullResult && pullResult.ok) SR.ui.info('Everything is already up to date.');
        }
        return { ok: true, push: pushResult, pull: pullResult, refresh };
      } finally {
        SR._uploading = false;
        running = null;
        emit('change', status());
        if (refresh && SR.state && SR.state.user) emit('settled', { refresh: true });
      }
    })();
    try { return await running; } finally {
      running = null;
      emit('change', status());
    }
  }

  async function releaseHoldWhenSent() {
    const waiting = await SR.store.outboxCount().catch(() => 1);
    if (waiting > 0) {
      if (SR.api.holdCatchUp) SR.api.holdCatchUp(180000);
      return;
    }
    if (SR.api.holdCatchUp) SR.api.holdCatchUp(30000, { shorten: true });
  }

  async function resumeAfterLine() {
    if (SR.api.holdCatchUp) SR.api.holdCatchUp(180000);
    else SR._catchingUp = true;
    try {
      const up = await SR.api.probe({ force: true }).catch(() => false);
      if (!up) return { ok: false, offline: true, role: 'follower' };
      if (running) await running.catch(() => {});
      return await runOnce({ silent: true, catchUp: true });
    } finally {
      // Do not drop the hold while sales are still waiting. A page refresh
      // after the cycle is not a sign-out either.
      setTimeout(() => { releaseHoldWhenSent().catch(() => {}); }, 30000);
    }
  }

  async function waitingForMe() {
    const me = SR.state && SR.state.user && SR.state.user.id;
    const list = await SR.store.pending().catch(() => []);
    return list.filter((item) => !me || !item.user_id || String(item.user_id) === String(me)).length;
  }

  async function catchUpWaiting() {
    const waiting = await waitingForMe().catch(() => 0);
    if (!waiting) return { ok: true, empty: true };
    if (!SR.api.isOnline()) {
      const up = await SR.api.probe({ force: true }).catch(() => false);
      if (!up) return { ok: false, offline: true };
    }
    if (!SR.api.hasToken()) {
      emit('needs-sign-in', { waiting });
      return { ok: false, needsAuth: true };
    }
    if (running) return running;
    return runOnce({ silent: true, catchUp: true });
  }

  function start({ intervalMs = AUTO_INTERVAL_MS } = {}) {
    stop();
    timer = setInterval(() => {
      if (!SR.api.hasToken()) return;
      runOnce({ silent: true }).catch(() => {});
    }, intervalMs);
    // A sale must not wait for the three-minute pass, or for a sign-out and a
    // fresh sign-in. While this account has rows waiting, ask the shop and send
    // them. An empty queue does not add a pull.
    waitTimer = setInterval(() => {
      catchUpWaiting().catch(() => {});
    }, WAITING_RETRY_MS);
    // Coming back online is the follower catching up to the leader. Turso stays
    // behind the Worker. This till never opens it. The person stays signed in.
    // Push the local outbox first, then copy the leader's catalogue. Do not
    // start that in the same tick as the line returning: the first answer was
    // being read as a sign-out.
    SR.api.on('net', ({ online }) => {
      if (!online) return;
      setTimeout(() => resumeAfterLine().catch(() => {}), 1500);
    });
    SR.api.on('queue', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runOnce({ silent: true }).catch(() => {}), DEBOUNCE_AFTER_QUEUE_MS);
    });
    if (document.visibilityState === 'visible') runOnce({ silent: true }).catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && SR.api.hasToken()) runOnce({ silent: true }).catch(() => {});
    });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = null;
  }

  async function queueStats() {
    const list = await SR.store.outboxAll();
    const byStatus = { PENDING: 0, RETRY: 0, FAILED: 0, SYNCED: 0 };
    for (const item of list) byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    return {
      total: list.length,
      pending: byStatus.PENDING + byStatus.RETRY,
      failed: byStatus.FAILED,
      synced: byStatus.SYNCED,
      byStatus,
      items: list,
    };
  }

  /** Discard a queue item that a human has decided is not worth keeping. */
  async function discard(clientId) {
    await SR.store.removeOutbox(clientId);
    emit('change', status());
    return true;
  }

  /** Retry every FAILED item — used after the reason for refusal is understood. */
  async function retryFailed() {
    const list = await SR.store.outboxAll();
    const failed = list.filter((i) => i.status === 'FAILED');
    for (const item of failed) await SR.store.requeue(item.client_id);
    emit('change', status());
    return failed.length;
  }

  let shopCountCheckedAt = 0;
  function refreshShopCount() {
    if (!SR.api.isOnline() || !SR.api.hasToken()) return;
    if (Date.now() - shopCountCheckedAt < 20000) return;
    shopCountCheckedAt = Date.now();
    SR.api.get('/api/products', { query: SR.state.query({ limit: 1 }), timeoutMs: 20000 }).then(async (data) => {
      const shopCount = data && data.paging ? Number(data.paging.total) : null;
      if (!Number.isFinite(shopCount)) return;
      await SR.store.metaSet('shop_product_count', shopCount);
      const localCount = await countCatalogueProducts();
      if (localCount < shopCount) {
        const current = await SR.store.metaGet('sync_pull_error').catch(() => null);
        if (!current || /not copied in full/.test(String(current))) {
          await rememberPullError('The shop has ' + shopCount + ' products. This till stored ' + localCount + ', so the catalogue was not copied in full.');
        }
        if (!running) runOnce({ silent: true }).catch(() => {});
      } else {
        const current = await SR.store.metaGet('sync_pull_error').catch(() => null);
        if (current && /not copied in full/.test(String(current))) {
          await SR.store.metaSet('sync_pull_error', null);
          if (lastError && /not copied in full/.test(String(lastError))) lastError = null;
        }
      }
      emit('change', status());
    }).catch(async (err) => {
      if (err && (err.isAuth || err.code === 'SESSION_SUPERSEDED' || err.code === 'NO_TOKEN' || err.status === 401)) {
        await rememberPullError(pullFailureReason(err));
        emit('change', status());
      }
    });
  }

  async function saveFacts() {
    refreshShopCount();
    const syncStatus = status();
    const stats = await queueStats().catch(() => ({ pending: 0, failed: 0 }));
    const products = await SR.store.all('products').catch(() => []);
    const stock = await SR.store.all('stock_batches').catch(() => []);
    const visibleProducts = (products || []).filter(catalogueVisible).length;
    const shopProductCount = Number(await SR.store.metaGet('shop_product_count').catch(() => 0)) || 0;
    const storedError = await SR.store.metaGet('sync_pull_error').catch(() => null);
    const memoryError = syncStatus.lastError ? String(syncStatus.lastError.message || syncStatus.lastError) : '';
    const pullError = storedError || (/did not accept this session|not copied in full|was not copied/i.test(memoryError) ? memoryError : '');
    return {
      running: syncStatus.running,
      online: SR.api.isOnline(),
      pending: stats.pending,
      failed: stats.failed,
      lastPullAt: await SR.store.metaGet('last_pull_at').catch(() => null),
      truncated: await SR.store.metaGet('sync_truncated').catch(() => []),
      incomplete: await SR.store.metaGet('sync_incomplete_since').catch(() => null),
      pullError,
      catalogueEmpty: await SR.store.metaGet('catalogue_empty').catch(() => null),
      salesCopied: Boolean(await SR.store.metaGet('sales_copy_at').catch(() => null)),
      stockRows: (stock || []).length,
      productRows: (products || []).length,
      visibleProducts,
      shopProductCount,
    };
  }

  SR.sync = {
    PULL_TABLES, AUTO_INTERVAL_MS,
    push, pull, replayUnsyncedShelf, runOnce, resumeAfterLine, catchUpWaiting, start, stop, status, on,
    queueStats, discard, retryFailed, saveFacts,
    get lastPushAt() { return lastPushAt; },
    get lastPullAt() { return lastPullAt; },
    get lastError() { return lastError; },
  };
}(window));
