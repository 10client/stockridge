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
    'stock_batches', 'purchase_orders', 'deposits', 'instalment_plans', 'delivery_jobs', 'client_settings',
    'branch_compliance_records', 'branch_safe_ledger',
  ];

  const AUTO_INTERVAL_MS = 3 * 60 * 1000;
  const DEBOUNCE_AFTER_QUEUE_MS = 2500;

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
    if (!SR.api.hasToken()) return { ok: false, offline: false, needsAuth: true, applied: 0, rejected: 0 };

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
      result = await SR.api.post('/api/sync/push', body, { timeoutMs: 45000 });
    } catch (err) {
      lastError = err.message;
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
    if (cursor) await SR.store.metaSet('sync_cursor', cursor);
    const savedAt = SR.util.nowIso();
    await SR.store.metaSet('last_pull_at', savedAt);
    await SR.store.metaSet('sync_truncated', truncated);
    await SR.store.metaSet('sync_pull_error', null);
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
    // Stock and the orders it came from are always pulled in full. A cursor
    // from before a receipt must not hide the cartons that are on the shelf.
    const asking = tables || PULL_TABLES;
    const fullTables = [];
    if (asking.includes('stock_batches')) fullTables.push('stock_batches');
    if (asking.includes('purchase_orders')) fullTables.push('purchase_orders');
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
    const perTable = [];
    try {
      for (const [table, payload] of Object.entries(result.tables || {})) {
        if (!payload || !Array.isArray(payload.rows)) continue;
        sent += payload.rows.length;
        const wrote = await SR.store.putMany(table, payload.rows);
        rows += Number(wrote) || 0;
        perTable.push({ table, count: Number(wrote) || 0 });
        if (table === 'stock_batches') await replayUnsyncedShelf().catch(() => {});
      }
    } catch (err) {
      const reason = pullFailureReason(err);
      await rememberPullError(reason);
      return { ok: false, error: err, rows, fast: false };
    }
    if (sent > 0 && rows === 0) {
      const reason = 'The shop sent catalogue rows, but this till could not store them.';
      await rememberPullError(reason);
      return { ok: false, error: new Error(reason), rows: 0, fast: false };
    }

    // Only advance the cursor when the whole pull succeeded. Moving it past a
    // table that errored would make those rows permanently invisible to this
    // device — it would ask for "everything since" a moment the rows never
    // arrived in. A shelf-only prefetch must not move it either: that request
    // does not carry the catalogue.
    if (saveCursor && result && result.cursor && !(result.tables && Object.values(result.tables).some((t) => t && t.error))) {
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

  // -------------------------------------------------------------------
  // THE CYCLE
  // -------------------------------------------------------------------
  async function runOnce({ full = false, silent = false } = {}) {
    if (running) return running;
    running = (async () => {
      try {
        if (!SR.api.isOnline()) await SR.api.probe({ force: true });
        if (!SR.api.isOnline()) {
          await pull({ full });
          return { ok: false, offline: true };
        }
        emit('change', status());
        let pushResult = { applied: 0, rejected: 0 };
        try { pushResult = await push(); } catch (err) { lastError = err.message; }
        // PUSH first, then pull — always. Pulling first would fetch stock figures
        // that do not include the sales this device just made. A failed pull must
        // not leave the chip on Saving, and must not throw away a sale already
        // written on this till.
        let pullResult = { ok: false, rows: 0 };
        try { pullResult = await pull({ full }); } catch (err) { lastError = err.message; }
        if (!silent) {
          const bits = [];
          if (pushResult.applied) bits.push(`${pushResult.applied} sent`);
          if (pushResult.rejected) bits.push(`${pushResult.rejected} refused`);
          if (pullResult.rows) bits.push(`${pullResult.rows} rows received`);
          if (bits.length) SR.ui.ok(`Synced: ${bits.join(', ')}.`);
          else if (pullResult && pullResult.ok) SR.ui.info('Everything is already up to date.');
        }
        return { ok: true, push: pushResult, pull: pullResult };
      } finally {
        running = null;
        emit('change', status());
      }
    })();
    try { return await running; } finally {
      running = null;
      emit('change', status());
    }
  }

  function start({ intervalMs = AUTO_INTERVAL_MS } = {}) {
    stop();
    timer = setInterval(() => {
      if (!SR.api.hasToken()) return;
      runOnce({ silent: true }).catch(() => {});
    }, intervalMs);
    // Coming back online is the moment that matters most: run immediately rather
    // than waiting out the interval.
    SR.api.on('net', ({ online }) => { if (online) runOnce({ silent: true }).catch(() => {}); });
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

  SR.sync = {
    PULL_TABLES, AUTO_INTERVAL_MS,
    push, pull, replayUnsyncedShelf, runOnce, start, stop, status, on,
    queueStats, discard, retryFailed,
    get lastPushAt() { return lastPushAt; },
    get lastPullAt() { return lastPullAt; },
    get lastError() { return lastError; },
  };
}(window));
