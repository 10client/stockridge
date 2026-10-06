'use strict';
// =====================================================================
// server/routes/sync.js — OFFLINE-FIRST RECONCILIATION
// =====================================================================
// The PWA works with no network: a phone in a Lagos shop on a bad MTN signal
// still rings up sales, and those sales are queued locally and replayed later.
// This module is what makes that safe.
//
// THE CENTRAL DECISION: offline work is queued as OPERATIONS, never as ROWS.
//
// An offline sale is stored on the device as "this cart, these payments, at this
// time" and replayed through POST /api/sales. It is NOT stored as a `sales` row
// and an `sale_items` row to be written directly. The difference is everything:
//
//   * A sale written as rows would skip FIFO batch selection, so the stock
//     decrement would not know which batch to take from.
//   * It would skip the ledger, so the books would not balance.
//   * It would skip the receipt-number sequence, so two devices offline at once
//     would both claim receipt 0042.
//   * It would skip the credit-limit check, because that needs the customer's
//     CURRENT balance, which the device cannot know.
//
// Replaying the OPERATION through the real endpoint means an offline sale is
// subject to exactly the same rules as an online one. The engine stays the only
// writer.
//
// LAST-WRITE-WINS APPLIES ONLY to a small whitelist of descriptive tables, and
// even there it CAPTURES the losing version rather than discarding it, because
// "the other device's edit vanished" is unanswerable without it.
//
// TENANT ISOLATION — the trap this must not fall into:
// Force-scoping `branch_id` on INSERT is correct. Doing the same on UPDATE is
// not: it REPARENTS another branch's row into the caller's branch instead of
// refusing the write. So an UPDATE first verifies the row is already in scope,
// and `branch_id`/`business_id` are never taken from client data.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, readBusinessId, pagination, listResponse, strField, boolField } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday } = require('../../domain/time');

/**
 * Tables whose rows a device may write directly, and the columns it may write.
 *
 * Deliberately tiny. Anything that moves stock, touches money, or posts to the
 * ledger must come through its own endpoint so the engine runs. A whitelist that
 * grew to include `sales` would be a second, unguarded sale path.
 */
const LWW_TABLES = {
  customers: {
    pk: 'id',
    // Contact and descriptive fields only. `credit_balance` is a cache of the
    // debtor ledger and `credit_limit` is an authority decision — neither may be
    // written by a device, or an offline edit could erase a debt.
    columns: ['name', 'company_name', 'phone', 'alt_phone', 'email', 'address', 'city', 'state', 'tin', 'cac_reg_no', 'notes', 'customer_type'],
    scopeColumn: 'branch_id',
  },
  notifications: {
    pk: 'id', columns: ['is_read', 'read_at'], scopeColumn: 'branch_id',
  },
  delivery_jobs: {
    // A driver in the field updating a drop status is the canonical offline
    // write. Money columns are excluded: the fee is set when the job is created.
    pk: 'id', columns: ['status', 'driver_name', 'driver_phone', 'delivered_at', 'delivered_to', 'proof_of_delivery', 'notes', 'attempts'],
    scopeColumn: 'branch_id',
  },
  stocktake_lines: {
    // Counts are taken offline on a clipboard or a phone in a warehouse with no
    // signal. The COMMIT that turns counts into adjustments is NOT syncable — it
    // must run online, because it posts to the ledger.
    //
    // A count line carries no branch_id of its own: it belongs to a session which
    // belongs to a branch. "No branch column therefore no restriction" would let
    // a device at one branch edit another branch's counts, so the branch is
    // resolved through the parent session before the write is allowed.
    pk: 'id', columns: ['counted_qty', 'variance', 'counted_by', 'counted_at', 'notes'], scopeColumn: null,
    resolveBranch: {
      column: 'stocktake_id',
      sql: 'SELECT branch_id FROM stocktake_sessions WHERE id = ?',
      result: 'branch_id',
    },
  },
};

/** Operations a device may replay, mapped to the endpoint that owns them. */
const REPLAYABLE = {
  SALE: { method: 'POST', path: '/api/sales' },
  SALE_VOID: { method: 'POST', path: '/api/sales/:id/void' },
  SALE_PAYMENT: { method: 'POST', path: '/api/sales/:id/pay' },
  CUSTOMER_PAYMENT: { method: 'POST', path: '/api/customers/:id/payments' },
  STOCK_ADJUST: { method: 'POST', path: '/api/stock/adjust' },
  CLOCK_IN: { method: 'POST', path: '/api/attendance/clock-in' },
  CLOCK_OUT: { method: 'POST', path: '/api/attendance/clock-out' },
  STOCKTAKE_COUNTS: { method: 'POST', path: '/api/stocktakes/:id/counts' },
  DELIVERY_STATUS: { method: 'POST', path: '/api/deliveries/:id/status' },
  DEPOSIT_PAYMENT: { method: 'POST', path: '/api/deposits/:id/payments' },
  INSTALMENT_PAYMENT: { method: 'POST', path: '/api/instalments/:id/payments' },
  EXPENSE: { method: 'POST', path: '/api/expenses' },
};

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // PUSH
  // -------------------------------------------------------------------
  /**
   * Push a device's offline queue.
   *
   * Two channels in one request, applied in this order:
   *   1. OPERATIONS, replayed through the real endpoints with the device's
   *      Idempotency-Key, so a retry cannot double-apply them.
   *   2. ROW MUTATIONS, LWW over the whitelist.
   *
   * The response reports the outcome of EACH item rather than failing the whole
   * batch. A queue of forty offline sales where one has an expired credit limit
   * must still post the other thirty-nine — refusing the batch would strand real
   * takings on a phone until somebody worked out which sale was the problem.
   */
  app.post(`${base}/sync/push`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    // The branch is OPTIONAL here, deliberately.
    //
    // An OPERATION replayed from a device goes back through its own endpoint, so
    // that endpoint resolves (and enforces) its own branch. Requiring one up
    // front would fail an entire queue — a cashier's whole day of sales — because
    // of one malformed item, and would leave the platform administrator (who has
    // no pinned branch) unable to sync at all.
    //
    // A ROW MUTATION does need a branch, because a new row is born in the branch
    // that created it; where there is none, that single mutation is refused and
    // the rest of the batch still runs.
    const branch = await resolveBranch(db, ctx, { required: false });
    const business = await resolveBusiness(db, ctx, branch);
    const deviceId = strField(body.device_id || body.deviceId || ctx.req.header('X-Device-Id'), { field: 'Device', maxLength: 120 });
    if (!deviceId) {
      throw new HttpError('A sync push must identify the device it came from. Two devices syncing the same queue is how a sale gets recorded twice.', { status: 400, code: 'DEVICE_ID_REQUIRED' });
    }
    const appVersion = strField(body.app_version || body.appVersion, { field: 'App version', maxLength: 40 });
    const clientTime = strField(body.client_time || body.clientTime, { field: 'Client time', maxLength: 40 });

    const operations = Array.isArray(body.operations) ? body.operations : [];
    const mutations = Array.isArray(body.mutations) ? body.mutations : [];
    if (!operations.length && !mutations.length) {
      throw new HttpError('Nothing to sync. Send `operations` and/or `mutations`.', { status: 400, code: 'EMPTY_SYNC' });
    }
    if (operations.length + mutations.length > 500) {
      // A cap, because an unbounded queue replayed in one request holds a
      // transaction open long enough to block the counter.
      throw new HttpError(`That is ${operations.length + mutations.length} items; the limit per sync is 500. Split it into batches — a huge queue is usually a device that has not synced in days and should be checked.`, { status: 400, code: 'SYNC_BATCH_TOO_LARGE' });
    }

    // Skew between the device clock and the server is recorded, not corrected.
    // A device whose clock is wrong will produce `sold_at` values in the future,
    // which the sale engine already refuses; silently rewriting the client's
    // timestamps would hide a misconfigured phone.
    let clockSkewMinutes = null;
    if (clientTime) {
      const c = Date.parse(clientTime);
      if (Number.isFinite(c)) clockSkewMinutes = Math.round((c - Date.now()) / 60000);
    }

    const results = { operations: [], mutations: [] };
    let applied = 0; let rejected = 0; let conflicts = 0;

    // ---- 1. OPERATIONS: replayed through the real HTTP endpoints.
    //
    // Going through `app.handle` rather than calling the service directly means
    // the operation passes through the SAME middleware — auth, settings load,
    // idempotency — as an online request. Calling the service directly would be a
    // second entry point with a second set of guarantees.
    for (const op of operations) {
      const kind = String(op.type || op.kind || '').toUpperCase();
      const route = REPLAYABLE[kind];
      if (!route) {
        results.operations.push({ clientId: op.client_id || op.clientId || null, type: kind, status: 'REJECTED', code: 'UNKNOWN_OPERATION', message: `“${kind}” cannot be synced from a device. It has to be done online.` });
        rejected += 1;
        continue;
      }
      const key = strField(op.idempotency_key || op.idempotencyKey || op.client_id || op.clientId, { field: 'Idempotency key', maxLength: 128 });
      if (!key) {
        results.operations.push({ clientId: null, type: kind, status: 'REJECTED', code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Every queued operation needs an idempotency key, or a retried sync would apply it twice.' });
        rejected += 1;
        continue;
      }

      // Substitute the path parameters. A missing one is a device-side bug and
      // is reported against that operation only.
      let path = route.path;
      const params = op.params || op.pathParams || {};
      let missingParam = null;
      path = path.replace(/:([A-Za-z_][\w]*)/g, (_, name) => {
        const v = params[name];
        if (v === undefined || v === null || String(v) === '') { missingParam = name; return ''; }
        return encodeURIComponent(String(v));
      });
      if (missingParam) {
        results.operations.push({ clientId: key, type: kind, status: 'REJECTED', code: 'MISSING_PATH_PARAM', message: `The queued ${kind} has no ${missingParam}, so it cannot be replayed.` });
        rejected += 1;
        continue;
      }

      // `sold_at` is carried from the device so the sale lands in the till and
      // the trading day it actually happened in, not the day the phone found a
      // signal. The engine validates the window and requires manager authority
      // beyond it.
      const payload = Object.assign({}, op.payload || op.data || op.body || {});
      payload.device_id = payload.device_id || deviceId;
      if (op.occurred_at || op.occurredAt) payload.sold_at = payload.sold_at || op.occurred_at || op.occurredAt;

      try {
        // Replayed through `app.fetch`, the same entry point the HTTP server uses.
        // The Authorization header is forwarded rather than the user object being
        // injected, so the replayed request re-authenticates and re-derives its
        // scope exactly as an online one would — an operation queued by a cashier
        // must still be refused if that cashier has since been deactivated.
        const res = await ctx.env.app.fetch(route.method, path, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: ctx.req.header('Authorization') || '',
            'Idempotency-Key': key,
            'X-Device-Id': deviceId,
            'X-Sync-Replay': '1',
          },
          body: JSON.stringify(payload),
          env: ctx.env,
        });
        const status = res.status;
        // A web Response's body is a stream, not a string, so it has to be read.
        const raw = await res.text().catch(() => '');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
        const replayed = res.headers && res.headers.get ? res.headers.get('Idempotency-Replayed') : null;
        if (status >= 200 && status < 300) {
          applied += 1;
          results.operations.push({
            clientId: key, type: kind, status: replayed === 'true' ? 'ALREADY_APPLIED' : 'APPLIED',
            httpStatus: status,
            message: (parsed && parsed.message) || 'Applied.',
            result: parsed && parsed.saleId ? { saleId: parsed.saleId, receiptNo: parsed.receiptNo } : undefined,
            warnings: (parsed && parsed.warnings) || [],
          });
        } else {
          rejected += 1;
          results.operations.push({
            clientId: key, type: kind, status: 'REJECTED', httpStatus: status,
            code: (parsed && parsed.code) || 'REJECTED',
            message: (parsed && (parsed.message || parsed.error)) || `The server refused this ${kind.toLowerCase()} (HTTP ${status}).`,
            // Whether the device should keep retrying. A 4xx is a decision the
            // server made and will make again; retrying it forever fills the
            // queue and hides the item a human needs to look at.
            retryable: status >= 500,
            problems: (parsed && parsed.problems) || [],
          });
        }
      } catch (e) {
        rejected += 1;
        results.operations.push({
          clientId: key, type: kind, status: 'ERROR', code: e.code || 'REPLAY_FAILED',
          message: e.message || 'The operation could not be replayed.',
          retryable: true,
        });
      }
    }

    // ---- 2. ROW MUTATIONS: LWW over the whitelist.
    for (const m of mutations) {
      const table = String(m.table || '').toLowerCase();
      const spec = LWW_TABLES[table];
      const rowId = m.id || m.row_id || (m.data && m.data.id);
      if (!spec) {
        results.mutations.push({ table, id: rowId || null, status: 'REJECTED', code: 'TABLE_NOT_SYNCABLE', message: `“${table}” cannot be written from a device. It has to go through its own endpoint so the rules around it actually run.` });
        rejected += 1;
        continue;
      }
      if (!rowId) {
        results.mutations.push({ table, id: null, status: 'REJECTED', code: 'MISSING_ID', message: 'A row mutation needs its id.' });
        rejected += 1;
        continue;
      }
      const op = String(m.op || 'UPSERT').toUpperCase();
      const clientUpdatedAt = m.client_updated_at || m.clientUpdatedAt || m.updated_at || null;
      const baseUpdatedAt = m.base_updated_at || m.baseUpdatedAt || null;

      const existing = await db.first(`SELECT * FROM ${table} WHERE ${spec.pk} = ? AND is_deleted = 0`, [String(rowId)]);

      if (op === 'DELETE') {
        if (!existing) { results.mutations.push({ table, id: rowId, status: 'SKIPPED', code: 'ALREADY_GONE', message: 'That row no longer exists.' }); continue; }
        if (!await inScopeAsync(ctx.get('scope'), existing, db, spec)) {
          results.mutations.push({ table, id: rowId, status: 'REJECTED', code: 'OUT_OF_SCOPE', message: 'That row belongs to another branch. It was left alone.' });
          rejected += 1;
          continue;
        }
        await db.run(`UPDATE ${table} SET is_deleted = 1, updated_at = datetime('now') WHERE ${spec.pk} = ?`, [String(rowId)]);
        applied += 1;
        results.mutations.push({ table, id: rowId, status: 'APPLIED', message: 'Removed.' });
        continue;
      }

      const data = m.data || m.fields || {};
      // Only whitelisted columns, and NEVER the scope columns. Taking branch_id
      // from client data would let a device move a row into another branch, which
      // is the tenant-isolation failure this whole module exists to avoid.
      //
      // The check runs over EVERY key the device sent, not just the whitelisted
      // ones. Testing against the whitelist alone would let `branch_id` through
      // unnoticed wherever it happened to be absent from that table's column
      // list — a silence, not a refusal, and the row would be written anyway.
      const sets = []; const params = []; const rejectedCols = [];
      for (const col of Object.keys(data)) {
        if (col !== spec.scopeColumn && col !== 'business_id') continue;
        rejectedCols.push(col);
      }
      for (const col of spec.columns) {
        if (data[col] === undefined) continue;
        if (rejectedCols.includes(col)) continue;
        sets.push(`${col} = ?`);
        params.push(normaliseValue(data[col]));
      }
      if (rejectedCols.length) {
        results.mutations.push({ table, id: rowId, status: 'REJECTED', code: 'SCOPE_COLUMN_FORBIDDEN', message: `${table}.${rejectedCols.join(', ')} cannot be set from a device — it decides who can see the row.` });
        rejected += 1;
        continue;
      }
      if (!sets.length) {
        results.mutations.push({ table, id: rowId, status: 'SKIPPED', code: 'NO_SYNCABLE_FIELDS', message: 'None of the fields sent can be written from a device.' });
        continue;
      }

      if (existing) {
        // ---- TENANT CHECK BEFORE WRITE. This is the guard that a blind
        // force-scope would skip: the row is verified to be in the caller's scope
        // and left untouched if it is not, rather than being reparented into it.
        if (!await inScopeAsync(ctx.get('scope'), existing, db, spec)) {
          results.mutations.push({ table, id: rowId, status: 'REJECTED', code: 'OUT_OF_SCOPE', message: 'That row belongs to another branch, so it was left exactly as it was. It has NOT been moved into your branch.' });
          rejected += 1;
          continue;
        }
        // ---- LWW. The server row wins when it changed after the device's base
        // version, and the device's version is CAPTURED rather than dropped.
        const serverUpdatedAt = existing.updated_at || null;
        const deviceLost = baseUpdatedAt && serverUpdatedAt && String(serverUpdatedAt) > String(baseUpdatedAt);
        if (deviceLost) {
          conflicts += 1;
          await db.run(`INSERT INTO sync_conflicts (
              id, table_name, row_id, branch_id, device_id, losing_version_json, winning_version_json, detected_at)
            VALUES (?,?,?,?,?,?,?, datetime('now'))`, [
            newId(), table, String(rowId), branch ? String(branch.id) : (existing.branch_id || null), deviceId,
            JSON.stringify({ data, clientUpdatedAt, baseUpdatedAt }),
            JSON.stringify(existing),
          ]);
          results.mutations.push({
            table, id: rowId, status: 'CONFLICT', code: 'SERVER_WON',
            message: `That row was changed on the server after this device last saw it, so the server's version was kept. The device's version is stored under Sync → Conflicts. Refetch the row.`,
            serverVersion: existing,
          });
          continue;
        }
        sets.push("updated_at = datetime('now')");
        params.push(String(rowId));
        await db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${spec.pk} = ? AND is_deleted = 0`, params);
        applied += 1;
        results.mutations.push({ table, id: rowId, status: 'APPLIED', message: 'Updated.' });
      } else {
        // A new row is scoped to the SYNCING branch on insert, which is correct:
        // the device created it, so it belongs where the device is. With no branch
        // there is nowhere honest to put it, so this one mutation is refused and
        // the batch carries on.
        if (!branch) {
          results.mutations.push({ table, id: rowId, status: 'REJECTED', code: 'BRANCH_REQUIRED', message: 'A device creates a row in the branch it is working in, and this push named none. Send branch_id with the push, or sign in to a branch account.' });
          rejected += 1;
          continue;
        }
        const cols = [spec.pk, ...sets.map((x) => x.split(' = ')[0])];
        const vals = [String(rowId), ...params];
        if (spec.scopeColumn && !cols.includes(spec.scopeColumn)) { cols.push(spec.scopeColumn); vals.push(String(branch.id)); }
        if (!cols.includes('business_id') && table !== 'notifications') { cols.push('business_id'); vals.push(String(business.id)); }
        if (!cols.includes('created_at')) { cols.push('created_at'); vals.push(null); }
        if (!cols.includes('updated_at')) { cols.push('updated_at'); vals.push(null); }
        if (!cols.includes('is_deleted')) { cols.push('is_deleted'); vals.push(0); }
        const finalCols = []; const finalVals = [];
        for (let i = 0; i < cols.length; i += 1) {
          if (cols[i] === 'created_at' || cols[i] === 'updated_at') { finalCols.push(cols[i]); finalVals.push({ sql: "datetime('now')" }); }
          else { finalCols.push(cols[i]); finalVals.push(vals[i]); }
        }
        const placeholders = finalVals.map((v) => (v && v.sql ? v.sql : '?')).join(',');
        const bind = finalVals.filter((v) => !(v && v.sql));
        try {
          await db.run(`INSERT INTO ${table} (${finalCols.join(', ')}) VALUES (${placeholders})`, bind);
          applied += 1;
          results.mutations.push({ table, id: rowId, status: 'APPLIED', message: 'Created.' });
        } catch (e) {
          rejected += 1;
          results.mutations.push({ table, id: rowId, status: 'REJECTED', code: e.code || 'INSERT_FAILED', message: e.message || 'The row could not be created.' });
        }
      }
    }

    // ---- sync bookkeeping. Written per table so the device can show what moved.
    const touched = {};
    for (const r of results.mutations) touched[r.table] = (touched[r.table] || 0) + 1;
    const branchKey = branch ? String(branch.id) : null;
    await db.transaction(async (tx) => {
      for (const [table, count] of Object.entries(touched)) {
        tx.queue(`INSERT INTO sync_change_log (id, branch_id, device_id, direction, table_name, row_count, status, error_message, synced_at)
            VALUES (?,?,?,?,?,?, 'SUCCESS', NULL, datetime('now'))`, [newId(), branchKey, deviceId, 'PUSH', table, count]);
      }
      if (operations.length) {
        tx.queue(`INSERT INTO sync_change_log (id, branch_id, device_id, direction, table_name, row_count, status, error_message, synced_at)
            VALUES (?,?,?,?, 'OPERATIONS', ?, ?, ?, datetime('now'))`, [
          newId(), branchKey, deviceId, 'PUSH', operations.length,
          // 'SUCCESS' — not 'OK'. The column is CHECKed against
          // ('SUCCESS','PARTIAL','FAILED'), so every push in which nothing was
          // refused violated the constraint, the whole request answered 400, and
          // the device never learned that its queued work had been applied: the
          // outbox stayed full and re-sent itself for ever. The happy path was the
          // only path that broke, which is why nobody saw it.
          rejected > 0 ? 'PARTIAL' : 'SUCCESS',
          rejected > 0 ? `${rejected} of ${operations.length} operation(s) refused` : null,
        ]);
      }
      // ONE ROW PER (BRANCH, DEVICE) — migration 0006. The conflict target is the
      // table's own primary key, which is now the pair. Before 0006 it was `branch_id`
      // alone and `device_id` was never updated, so this row described the first device
      // that ever synced at the branch and no other phone could appear.
      //
      // Written only when we know WHICH branch synced: a push that named no branch has no
      // honest row to write, and inventing one would attribute this device's queue to a
      // shop it is not standing in.
      if (branchKey) {
        tx.queue(`INSERT INTO branch_sync_status (branch_id, device_id, app_version, last_heartbeat_at, last_push_at,
              pending_push_count, last_sync_error, updated_at)
            VALUES (?,?,?, datetime('now'), datetime('now'), ?, ?, datetime('now'))
            ON CONFLICT(branch_id, device_id) DO UPDATE SET
              app_version = excluded.app_version,
              last_push_at = datetime('now'),
              last_heartbeat_at = datetime('now'),
              pending_push_count = excluded.pending_push_count,
              last_sync_error = excluded.last_sync_error,
              updated_at = datetime('now')`, [
          branchKey, deviceId, appVersion,
          Number(body.pending_push_count) || 0,
          rejected > 0 ? `${rejected} item(s) refused at ${watNow()}` : null,
        ]);
      }
    });

    if (rejected > 0 || conflicts > 0) {
      // THE BRANCH IS NULL HERE AND THAT IS THE NORMAL CASE FOR A BIGGER SHOP.
      //
      // `branch` is only resolved up front when the caller covers exactly one branch: an
      // owner with two shops, or a deployment administrator, names no branch and the push
      // proceeds without one (the comments at the top of this route say so, and are right —
      // requiring one would fail a cashier's whole day over one malformed item).
      //
      // `branch.id` therefore threw `TypeError: Cannot read properties of null (reading
      // 'id')` — on the ONE branch of the code that only runs when something was refused or
      // conflicted. So the answer to "part of my queue was rejected" was a 500 with no
      // per-item detail, on every multi-branch deployment, and 500 is the one answer an
      // offline queue cannot act on: it cannot tell a bad item from a bad server, so it
      // retries the whole batch forever.
      //
      // Found by test/audit/audit.sync.js (Stage T4) — the first thing in the suite to send
      // a push with a rejected item in it from a deployment that has two branches.
      await recordFromCtx(ctx, {
        action: 'SYNC_PUSH_PARTIAL', entityType: 'SYNC', entityId: deviceId,
        branchId: branch ? String(branch.id) : null,
        businessId: business ? String(business.id) : null,
        after: { deviceId, appVersion, operations: operations.length, mutations: mutations.length, applied, rejected, conflicts, clockSkewMinutes },
      });
    }

    ctx.json({
      ok: rejected === 0,
      applied, rejected, conflicts,
      clockSkewMinutes,
      results,
      // The cursor the device should use for its next pull. Taken from the
      // server clock AFTER the push, so the device's own writes come back to it
      // on the next pull rather than being missed.
      cursor: new Date().toISOString(),
      message: rejected === 0 && conflicts === 0
        ? `${applied} item(s) synced from ${deviceId}.`
        : `${applied} applied, ${rejected} refused${conflicts ? `, ${conflicts} conflict(s)` : ''}. The refused items are listed with a reason for each — they will not apply on retry, so they need a person.`,
    }, rejected === 0 ? 200 : 207);
  });

  // -------------------------------------------------------------------
  // PULL
  // -------------------------------------------------------------------
  /**
   * Pull everything that changed since the device's cursor.
   *
   * This is what makes the offline mirror usable: a device that has the
   * catalogue, prices, customer list and settings can price a sale and check a
   * credit limit with no network. It is scoped to the caller's branch and
   * business, so a device can never pull another branch's book.
   *
   * `since` is compared against `updated_at` (UTC). A device with a skewed clock
   * still gets correct data, because the cursor it is given back is a SERVER
   * timestamp — the device never supplies its own idea of "now" as the cursor.
   */
  app.post(`${base}/sync/pull`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const body = await ctx.req.json().catch(() => ({}));
    // Optional, for the same reason as `push`: an administrator covers every
    // branch, so naming one would make a first pull on a fresh install return a
    // sixth of the catalogue. `scope` is what decides visibility below; the
    // branch only NARROWS it.
    const branch = await resolveBranch(db, ctx, { required: false });
    // `biz` is null when the caller reaches every business and named none: the pull
    // then covers them all, exactly as the branch does above for an administrator
    // ("naming one would make a first pull on a fresh install return a sixth of the
    // catalogue"). A device pinned to a branch still gets that branch.
    const biz = await readBusinessId(db, ctx, { branch });
    const scope = ctx.get('scope');
    const deviceId = strField(body.device_id || body.deviceId || ctx.req.queryParam('device_id') || ctx.req.header('X-Device-Id'), { field: 'Device', maxLength: 120 });
    const since = strField(body.since || ctx.req.queryParam('since'), { field: 'Since', maxLength: 40 });

    // A first sync has no cursor and must get everything; a later sync gets only
    // what changed. The cap on a full sync matters — a 78-product catalogue with
    // variants, units and barcodes is a few hundred rows, but an unbounded pull
    // on a slow connection is how a device gives up mid-download and ends up
    // with a half-populated mirror.
    const fullSync = !since;
    const perTableLimit = fullSync ? Number(body.limit) || 5000 : Number(body.limit) || 2000;

    const requested = Array.isArray(body.tables) && body.tables.length
      ? body.tables.map((t) => String(t).toLowerCase())
      : ['businesses', 'branches', 'users', 'customer_classes', 'customers', 'product_categories', 'products', 'product_units', 'product_variants', 'product_barcodes', 'price_lists', 'price_list_items', 'product_price_overrides', 'suppliers', 'stock_batches', 'deposits', 'instalment_plans', 'delivery_jobs', 'client_settings'];

    const out = {};
    let totalRows = 0;
    for (const table of requested) {
      // Only tables that exist and are safe to mirror. A device must not be able
      // to ask for `gl_journal_lines` or `audit_log` and receive them.
      if (!PULLABLE[table]) { out[table] = { error: 'not_syncable', rows: [] }; continue; }
      const spec = PULLABLE[table];
      const where = []; const params = [];
      if (spec.softDelete !== false) where.push('is_deleted = 0');
      if (spec.businessScoped !== false && biz) { where.push('(business_id = ? OR business_id IS NULL)'); params.push(biz); }
      if (spec.branchScoped && !scope.allBranches && scope.branchIds) {
        const ids = [...scope.branchIds];
        where.push(`(branch_id IS NULL OR branch_id IN (${ids.map(() => '?').join(',')}))`);
        params.push(...ids);
      } else if (spec.branchScoped && branch) {
        where.push('(branch_id IS NULL OR branch_id = ?)'); params.push(String(branch.id));
      }
      if (since) { where.push('updated_at > ?'); params.push(since); }
      const cols = spec.columns ? spec.columns.join(', ') : '*';
      let rows;
      try {
        rows = await db.all(`SELECT ${cols} FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${spec.orderBy || 'updated_at DESC, id'} LIMIT ?`, [...params, perTableLimit]);
      } catch (e) {
        out[table] = { error: e.message, rows: [] };
        continue;
      }
      out[table] = { rows, count: rows.length, truncated: rows.length >= perTableLimit };
      totalRows += rows.length;
    }

    // client_settings is a single global row and has no business_id, so it is
    // fetched separately: it carries the feature flags the offline UI needs to
    // know which screens to show.
    if (requested.includes('client_settings')) {
      const settings = await db.first('SELECT * FROM client_settings LIMIT 1');
      if (settings) {
        out.client_settings = { rows: [redactSettings(settings)], count: 1, truncated: false };
      }
    }

    const cursor = new Date().toISOString();
    // Only a pull that actually belongs to a branch updates that branch's
    // heartbeat row. A branchless pull would otherwise claim a shop's status.
    if (deviceId && branch) {
      await db.run(`INSERT INTO branch_sync_status (branch_id, device_id, app_version, last_pull_at, last_heartbeat_at, updated_at)
          VALUES (?,?,?, datetime('now'), datetime('now'), datetime('now'))
          ON CONFLICT(branch_id, device_id) DO UPDATE SET
            last_pull_at = datetime('now'), last_heartbeat_at = datetime('now'),
            app_version = COALESCE(excluded.app_version, app_version), updated_at = datetime('now')`,
      [branch ? String(branch.id) : null, deviceId, strField(body.app_version, { field: 'App version', maxLength: 40 })]);
    }

    ctx.json({
      ok: true, cursor, since: since || null, fullSync,
      tables: out,
      totalRows,
      message: fullSync
        ? `Full sync: ${totalRows} row(s) across ${Object.keys(out).filter((k) => out[k].count).length} table(s). This is everything this device is allowed to see.`
        : `${totalRows} row(s) changed since ${since}.`,
      // Told to the device explicitly, because a truncated table means the
      // mirror is incomplete and pricing against it could be wrong.
      truncatedTables: Object.entries(out).filter(([, v]) => v.truncated).map(([k]) => k),
    });
  });

  // -------------------------------------------------------------------
  // STATUS / CONFLICTS
  // -------------------------------------------------------------------
  app.get(`${base}/sync/status`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const where = ['1 = 1']; const params = [];
    if (!scope.allBranches && scope.branchIds) {
      const ids = [...scope.branchIds]; where.push(`branch_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
    }
    const devices = await db.all(`SELECT ss.*, b.name AS branch_name FROM branch_sync_status ss
        LEFT JOIN branches b ON b.id = ss.branch_id
        WHERE ${where.join(' AND ')} ORDER BY ss.last_heartbeat_at DESC LIMIT 200`, params);
    const recent = await db.all(`SELECT sc.*, b.name AS branch_name FROM sync_change_log sc
        LEFT JOIN branches b ON b.id = sc.branch_id
        WHERE ${where.join(' AND ').replace(/branch_id/g, 'sc.branch_id')}
        ORDER BY sc.synced_at DESC LIMIT 50`, params);
    const openConflicts = await db.scalar(`SELECT COUNT(*) FROM sync_conflicts sc WHERE sc.reviewed_at IS NULL
        ${scope.allBranches ? '' : `AND (sc.branch_id IN (${[...scope.branchIds].map(() => '?').join(',')}) OR sc.branch_id IS NULL)`}`,
    scope.allBranches ? [] : [...scope.branchIds]);
    ctx.json({
      ok: true, devices, recentChanges: recent,
      openConflicts: Number(openConflicts) || 0,
      summary: {
        devices: devices.length,
        stale: devices.filter((d) => d.last_heartbeat_at && minutesSince(d.last_heartbeat_at) > 1440).length,
        withErrors: devices.filter((d) => d.last_sync_error).length,
        pendingPush: devices.reduce((a, d) => a + Number(d.pending_push_count || 0), 0),
      },
    });
  });

  app.get(`${base}/sync/conflicts`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const where = ['1 = 1']; const params = [];
    if (!scope.allBranches && scope.branchIds) {
      const ids = [...scope.branchIds]; where.push(`(c.branch_id IS NULL OR c.branch_id IN (${ids.map(() => '?').join(',')}))`); params.push(...ids);
    }
    if (!boolField(ctx.req.queryParam('include_resolved'))) where.push('c.reviewed_at IS NULL');
    const whereSql = where.join(' AND ');
    const rows = await db.all(`SELECT c.*, b.name AS branch_name, u.full_name AS reviewer_name
        FROM sync_conflicts c LEFT JOIN branches b ON b.id = c.branch_id
        LEFT JOIN users u ON u.id = c.reviewed_by
        WHERE ${whereSql} ORDER BY c.detected_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM sync_conflicts c WHERE ${whereSql}`, params);
    ctx.json({
      ...listResponse(rows.map((r) => ({
        ...r,
        // Parsed for the UI so it can show a side-by-side diff instead of two
        // blobs of JSON. A conflict nobody can read is a conflict nobody resolves.
        losing: safeParse(r.losing_version_json),
        winning: safeParse(r.winning_version_json),
      })), { limit, offset }, total),
    });
  });

  /**
   * Resolve a conflict.
   *
   * Resolving does NOT re-apply the losing version automatically. The manager
   * looks at both, decides, and either accepts the server's version (closing the
   * conflict) or re-queues the device's version as a fresh mutation with a new
   * base — which then goes through the normal scope and LWW checks. Silently
   * overwriting the server row would recreate exactly the problem the conflict
   * record exists to surface.
   */
  app.post(`${base}/sync/conflicts/:id/resolve`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can resolve a sync conflict. It decides which of two people\'s work is kept.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const conflict = await db.first('SELECT * FROM sync_conflicts WHERE id = ?', [id]);
    if (!conflict) throw new HttpError('That conflict does not exist.', { status: 404, code: 'CONFLICT_NOT_FOUND' });
    if (conflict.reviewed_at) throw new HttpError(`That conflict was already resolved on ${conflict.reviewed_at}.`, { status: 409, code: 'ALREADY_RESOLVED' });
    const resolution = strField(body.resolution, { field: 'Resolution', maxLength: 500, required: true });
    if (resolution.length < 6) throw new HttpError('Say which version was kept and why. Two people edited the same row and one of them is going to lose their work.', { status: 400, code: 'RESOLUTION_REQUIRED' });
    const decision = String(body.decision || 'SERVER_KEPT').toUpperCase();
    if (!['SERVER_KEPT', 'DEVICE_REQUEUED', 'MERGED'].includes(decision)) {
      throw new HttpError(`“${decision}” is not a resolution. Use SERVER_KEPT, DEVICE_REQUEUED or MERGED.`, { status: 400, code: 'INVALID_DECISION' });
    }
    await db.run('UPDATE sync_conflicts SET reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?', [String(user.id), id]);
    await recordFromCtx(ctx, {
      action: 'SYNC_CONFLICT_RESOLVED', entityType: 'SYNC_CONFLICT', entityId: id, branchId: conflict.branch_id,
      before: { reviewed_at: null }, after: { decision, resolution, table: conflict.table_name, rowId: conflict.row_id },
    });
    ctx.json({
      ok: true, decision,
      message: decision === 'SERVER_KEPT'
        ? `Conflict closed — the server's version of ${conflict.table_name} ${String(conflict.row_id).slice(0, 8)} stands. The device should refetch that row.`
        : decision === 'DEVICE_REQUEUED'
          ? `Conflict closed — the device's version should be re-queued as a fresh edit. It will go through the normal checks again rather than overwriting the server row.`
          : `Conflict closed as merged. Record what was merged in the row itself.`,
    });
  });

  /** A heartbeat, so "which devices are alive?" is answerable. */
  app.post(`${base}/sync/heartbeat`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const body = await ctx.req.json().catch(() => ({}));
    const branch = await resolveBranch(db, ctx);
    const deviceId = strField(body.device_id || body.deviceId || ctx.req.header('X-Device-Id'), { field: 'Device', maxLength: 120 });
    if (!deviceId) throw new HttpError('A heartbeat must say which device it is from.', { status: 400, code: 'DEVICE_ID_REQUIRED' });
    // ONE ROW PER (BRANCH, DEVICE) — migration 0006. It used to conflict on `branch_id`
    // alone and never write `device_id` on the update path, so the second phone in a branch
    // was invisible in `/api/sync/status` and its pending count was attributed to whichever
    // device synced there first. See the migration for the whole reasoning.
    await db.run(`INSERT INTO branch_sync_status (branch_id, device_id, app_version, last_heartbeat_at, pending_push_count, updated_at)
        VALUES (?,?,?, datetime('now'), ?, datetime('now'))
        ON CONFLICT(branch_id, device_id) DO UPDATE SET
          last_heartbeat_at = datetime('now'), app_version = COALESCE(excluded.app_version, app_version),
          pending_push_count = excluded.pending_push_count, updated_at = datetime('now')`,
    [String(branch.id), deviceId, strField(body.app_version, { field: 'App version', maxLength: 40 }), Number(body.pending_push_count) || 0]);
    ctx.json({
      ok: true,
      serverTime: watNow(), serverDate: watToday(),
      // The server's clock is returned so the device can measure its own skew
      // and warn the user, rather than silently queueing sales with future
      // timestamps that the engine will then refuse.
      serverEpoch: Date.now(),
    });
  });
}

/**
 * Tables a device may PULL, and how each is scoped.
 *
 * `businessScoped` and `branchScoped` are applied as filters, never as
 * permissions: a row with a NULL branch is shared (the catalogue is the same
 * across branches) and must stay visible, while a row WITH a branch is visible
 * only inside it.
 */
const PULLABLE = {
  businesses: { businessScoped: false, branchScoped: false, orderBy: 'name' },
  branches: { businessScoped: true, branchScoped: false, orderBy: 'name' },
  users: {
    businessScoped: true, branchScoped: false, orderBy: 'full_name',
    // The PIN hash is never mirrored to a device. An offline copy of the
    // credential database is a copy that can be lifted off a lost phone, and
    // there is no offline operation that needs it — authentication is always
    // against the server or against a locally cached session.
    columns: ['id', 'business_id', 'branch_id', 'full_name', 'username', 'role', 'job_title', 'email', 'phone', 'commission_rate_pct', 'is_active', 'updated_at'],
  },
  customer_classes: { businessScoped: true, branchScoped: false, orderBy: 'name' },
  customers: { businessScoped: true, branchScoped: true, orderBy: 'name' },
  product_categories: { businessScoped: true, branchScoped: false, orderBy: 'sort_order, name' },
  products: { businessScoped: true, branchScoped: false, orderBy: 'name' },
  product_units: { businessScoped: false, branchScoped: false, orderBy: 'quantity_in_base' },
  product_variants: { businessScoped: false, branchScoped: false, orderBy: 'name' },
  product_barcodes: { businessScoped: false, branchScoped: false, orderBy: 'barcode' },
  price_lists: { businessScoped: true, branchScoped: false, orderBy: 'priority, name' },
  price_list_items: { businessScoped: false, branchScoped: false, orderBy: 'product_id' },
  product_price_overrides: { businessScoped: false, branchScoped: true, orderBy: 'product_id' },
  suppliers: { businessScoped: true, branchScoped: false, orderBy: 'name' },
  stock_batches: { businessScoped: true, branchScoped: true, orderBy: 'product_id, batch_no' },
  deposits: { businessScoped: true, branchScoped: true, orderBy: 'expires_at' },
  instalment_plans: { businessScoped: true, branchScoped: true, orderBy: 'next_due_date' },
  delivery_jobs: { businessScoped: true, branchScoped: true, orderBy: 'created_at DESC' },
  client_settings: { businessScoped: false, branchScoped: false, orderBy: 'updated_at DESC' },
};

/** Strip anything a device should not carry around. */
function redactSettings(row) {
  const out = { ...row };
  for (const k of ['logo_data_url']) delete out[k]; // large, and branding has its own public endpoint
  return out;
}

/**
 * Scope check for a row about to be written.
 *
 * Resolves the row's branch through the database when the row itself carries no
 * `branch_id` (a stocktake line belongs to a session which belongs to a branch),
 * because guessing "no branch column means no restriction" would let a device at
 * branch A edit branch B's counts.
 */
async function inScopeAsync(scope, row, db, spec) {
  if (!scope) return false;
  if (scope.allBusinesses && scope.allBranches) return true;
  if (row.branch_id) {
    if (scope.branchIds && !scope.branchIds.has(String(row.branch_id))) return false;
  } else if (spec && spec.resolveBranch) {
    const parent = await db.first(spec.resolveBranch.sql, [String(row[spec.resolveBranch.column])]);
    const parentBranch = parent && parent[spec.resolveBranch.result];
    if (parentBranch && scope.branchIds && !scope.branchIds.has(String(parentBranch))) return false;
  }
  if (row.business_id && scope.businessIds && !scope.businessIds.has(String(row.business_id))) return false;
  return true;
}

function normaliseValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function safeParse(json) {
  try { return JSON.parse(json); } catch (e) { return json; }
}

function minutesSince(iso) {
  const t = Date.parse(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : 0;
}

module.exports = { mount, LWW_TABLES, REPLAYABLE, PULLABLE };
