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
//          last sync) so the POS can price a cart with no network. It runs on a
//          cursor, so a normal sync moves a few rows rather than the whole
//          catalogue.
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
    'stock_batches', 'deposits', 'instalment_plans', 'delivery_jobs', 'client_settings',
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

    const queued = await SR.store.pending({ limit: batchSize });
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
    let applied = 0; let rejected = 0; let conflicts = 0;
    const failures = [];

    for (const r of results) {
      const key = r.clientId;
      if (!key) continue;
      if (r.status === 'APPLIED' || r.status === 'ALREADY_APPLIED') {
        applied += 1;
        await SR.store.markSynced(key, r.result ? r.result.saleId || r.result.receiptNo || null : null);
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
      message: rejected ? `${rejected} refused, ${applied} applied` : `${applied} applied`,
    });
    await SR.store.purgeSynced({ olderThanHours: 48 });
    emit('change', status());
    return { ok: true, applied, rejected, retrying: conflicts, failures, server: result };
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
  async function pull({ full = false, tables = null } = {}) {
    if (!SR.api.isOnline()) return { ok: false, offline: true, rows: 0 };
    if (!SR.api.hasToken()) return { ok: false, needsAuth: true, rows: 0 };

    const since = full ? null : await SR.store.metaGet('sync_cursor', null);
    const branchId = SR.state.activeBranchId;
    let result;
    try {
      result = await SR.api.post('/api/sync/pull', {
        device_id: SR.device.current().id,
        app_version: SR.APP_VERSION,
        since: since || undefined,
        branch_id: branchId || undefined,
        tables: tables || PULL_TABLES,
      }, { timeoutMs: 60000 });
    } catch (err) {
      lastError = err.message;
      await SR.store.log({ kind: 'PULL', status: 'FAILED', count: 0, message: err.message });
      emit('change', status());
      return { ok: false, error: err, rows: 0 };
    }

    let rows = 0;
    const perTable = [];
    for (const [table, payload] of Object.entries((result && result.tables) || {})) {
      if (!payload || payload.error || !Array.isArray(payload.rows)) continue;
      await SR.store.putMany(table, payload.rows);
      rows += payload.rows.length;
      perTable.push({ table, count: payload.rows.length });
    }

    // Only advance the cursor when the whole pull succeeded. Moving it past a
    // table that errored would make those rows permanently invisible to this
    // device — it would ask for "everything since" a moment the rows never
    // arrived in.
    if (result && result.cursor && !(result.tables && Object.values(result.tables).some((t) => t && t.error))) {
      await SR.store.metaSet('sync_cursor', result.cursor);
    } else if (result && result.cursor) {
      // An errored table means the cursor is kept but flagged, so the UI can say
      // the mirror is incomplete rather than quietly pretending otherwise.
      await SR.store.metaSet('sync_incomplete_since', since || null);
    }
    await SR.store.metaSet('last_pull_at', SR.util.nowIso());
    await SR.store.metaSet('sync_truncated', (result && result.truncatedTables) || []);
    lastPullAt = SR.util.nowIso();
    await SR.store.log({
      kind: 'PULL', status: 'OK', count: rows,
      message: result && result.fullSync ? `Full sync: ${rows} rows` : `${rows} changed rows`,
    });
    emit('change', status());
    return { ok: true, rows, perTable, cursor: result && result.cursor, fullSync: Boolean(result && result.fullSync), truncated: (result && result.truncatedTables) || [] };
  }

  // -------------------------------------------------------------------
  // THE CYCLE
  // -------------------------------------------------------------------
  async function runOnce({ full = false, silent = false } = {}) {
    if (running) return running;
    running = (async () => {
      if (!SR.api.isOnline()) await SR.api.probe({ force: true });
      if (!SR.api.isOnline()) {
        running = null;
        return { ok: false, offline: true };
      }
      emit('change', status());
      let pushResult = { applied: 0, rejected: 0 };
      try { pushResult = await push(); } catch (err) { lastError = err.message; }
      // PUSH first, then pull — always. Pulling first would fetch stock figures
      // that do not include the sales this device just made.
      const pullResult = await pull({ full });
      running = null;
      emit('change', status());
      if (!silent) {
        const bits = [];
        if (pushResult.applied) bits.push(`${pushResult.applied} sent`);
        if (pushResult.rejected) bits.push(`${pushResult.rejected} refused`);
        if (pullResult.rows) bits.push(`${pullResult.rows} rows received`);
        if (bits.length) SR.ui.ok(`Synced: ${bits.join(', ')}.`);
        else SR.ui.info('Everything is already up to date.');
      }
      return { ok: true, push: pushResult, pull: pullResult };
    })();
    try { return await running; } finally { running = null; }
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
    push, pull, runOnce, start, stop, status, on,
    queueStats, discard, retryFailed,
    get lastPushAt() { return lastPushAt; },
    get lastPullAt() { return lastPullAt; },
    get lastError() { return lastError; },
  };
}(window));
