// =====================================================================
// StockRidge — OFFLINE SYNC
// =====================================================================
// The product is offline-first because a Nigerian shop floor loses
// connectivity routinely, and a POS that stops working when the network does
// is a POS that will be switched off. So the PWA queues writes locally and
// replays them; this module is the server side of that contract.
//
// WHAT SYNCS AT THE ROW LEVEL, AND WHAT DOES NOT — and the reason is not
// convenience:
//
//   ROW-LEVEL PUSH (last-write-wins on updated_at): customers, suppliers,
//   delivery addresses, notes. Reference data where two branches editing the
//   same record is rare and the loss from LWW is a phone number.
//
//   NEVER ROW-LEVEL: sales, stock movements, ledgers, till sessions,
//   instalment payments, adjustments. These are FACTS, not STATE. Merging
//   two versions of a fact is meaningless — the correct model is that each
//   device APPENDS its own facts and the server orders them. So an offline
//   sale is replayed as a NEW createSale() call carrying its own
//   pre-allocated id and Idempotency-Key, not as an upsert of a sales row.
//   That distinction is why a replayed sale still decrements stock, still
//   posts to the GL, still honours the credit limit and still writes the
//   serial custody register: it goes through the same code path as an online
//   one, which an upsert would bypass entirely.
//
// THE CROSS-BRANCH WRITE HOLE, found and fixed in the original audit and
// designed out here rather than patched:
//
//   A force-scope of "replace branch_id with the pusher's own" is correct
//   for an INSERT and catastrophic for an UPDATE — it REPARENTS a row that
//   already belongs to another branch. Reproduced live: a Lagos device
//   pushed a customer belonging to Minna, the push returned 200 "updated: 1",
//   the name and phone were overwritten with Lagos's values, the row MOVED
//   into Lagos, and the customer's ₦110 debt stayed recorded against Minna
//   while the customer appeared in the Lagos list — visible to a Lagos
//   cashier who could read a balance that was not theirs to see.
//
//   So: an INSERT is scoped to the pusher's branch. An UPDATE is scoped by
//   the ROW's existing branch, and a push that would move a row between
//   branches is REFUSED and recorded as a conflict, not silently applied.
//
// CONFLICT VISIBILITY: LWW discards a losing write. sync_conflicts stores the
// DISCARDED version before it is overwritten, so "two branches edited the
// same customer offline and one lost" is a reviewable event rather than a
// silent data loss. This does not prevent the overwrite (a CRDT merge is a
// much larger undertaking); it closes the "nobody would ever know" gap.
// =====================================================================

const { newId, watNowIso } = require('../../shared/ids');
const { HttpError } = require('../lib/http');
const { resolveMutationBranchId, assertBranchAccess } = require('../lib/roles');
const { getUnitSettings } = require('../lib/planLimits');

// Tables eligible for row-level push, with the columns that may be written
// by a client. An allowlist, not a denylist: a new column added to a
// syncable table is NOT automatically client-writable, which is the safe
// default. A column that controls money, authority or scope is deliberately
// absent from every list below.
const SYNCABLE = Object.freeze({
  customers: {
    columns: ['first_name', 'last_name', 'full_name', 'customer_type', 'phone', 'phone_national', 'alt_phone',
      'email', 'address', 'state', 'lga', 'city', 'delivery_address', 'delivery_state', 'delivery_city',
      'delivery_landmark', 'delivery_instructions', 'company_name', 'contact_person', 'occupation',
      'id_type', 'id_number', 'notes', 'is_active'],
    // NEVER client-writable, and the reason for each is a real attack:
    //   credit_limit / credit_enabled  — a cashier could raise their own
    //                                    customer's ceiling and walk out with stock
    //   tier_id                        — a tier change silently re-prices every
    //                                    future sale to that customer
    //   total_purchases / loyalty_points — derived from sales; a writable copy
    //                                    is a second source of truth
    //   home_branch_id                 — reparenting the relationship moves the
    //                                    debtor book between branches
    scopeColumn: 'home_branch_id',
    unitColumn: 'business_unit_id',
  },
  suppliers: {
    columns: ['name', 'supplier_type', 'contact_name', 'phone', 'alt_phone', 'email', 'address', 'state',
      'country', 'tin', 'rc_number', 'bank_name', 'bank_account_name', 'bank_account_no',
      'payment_terms_days', 'lead_time_days', 'rating', 'notes', 'is_active'],
    // credit_limit excluded: how much WE may owe a supplier is an owner
    // decision, not something a field device should be able to raise.
    scopeColumn: null,
    unitColumn: 'business_unit_id',
  },
  delivery_vehicles: {
    columns: ['plate_number', 'vehicle_type', 'capacity_kg', 'capacity_volume_m3', 'driver_name',
      'driver_phone', 'is_third_party', 'cost_per_trip', 'cost_per_km', 'is_active'],
    scopeColumn: 'branch_id',
    unitColumn: 'business_unit_id',
  },
});

// Heartbeat. Cheap, frequent, and the only signal the manager has that a
// branch is alive. A branch that has not beat in 24h is closed, offline or
// broken — all three need a human.
async function heartbeat(db, ctx, { branchId, deviceId = null, appVersion = null, pendingPushCount = 0, queueOldestAt = null, lastError = null }) {
  const businessUnitId = ctx.businessUnitId;
  const settings = await getUnitSettings(db, businessUnitId);
  if (settings.offline_sync_enabled === 0) {
    throw new HttpError(403, 'Offline sync is not enabled for this business.', 'SYNC_DISABLED');
  }
  const bid = branchId || ctx.user.branch_id;
  if (!bid) throw new HttpError(400, 'A branch is required.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, bid);

  const ts = watNowIso();
  const existing = await db.prepare('SELECT branch_id FROM branch_sync_status WHERE branch_id = ?').bind(bid).first();
  if (existing) {
    await db.prepare(`
      UPDATE branch_sync_status
      SET device_id = COALESCE(?, device_id), app_version = COALESCE(?, app_version),
          last_heartbeat_at = ?, pending_push_count = ?, queue_oldest_at = ?,
          last_sync_error = ?, updated_at = ?
      WHERE branch_id = ?
    `).bind(deviceId, appVersion, ts, Math.max(0, Number(pendingPushCount) || 0), queueOldestAt, lastError ? String(lastError).slice(0, 500) : null, ts, bid).run();
  } else {
    await db.prepare(`
      INSERT INTO branch_sync_status (branch_id, business_unit_id, device_id, app_version, last_heartbeat_at,
        pending_push_count, queue_oldest_at, last_sync_error, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(bid, businessUnitId, deviceId, appVersion, ts, Math.max(0, Number(pendingPushCount) || 0), queueOldestAt,
      lastError ? String(lastError).slice(0, 500) : null, ts).run();
  }

  await logSync(db, { businessUnitId, branchId: bid, deviceId, direction: 'HEARTBEAT', status: 'SUCCESS', rowCount: 0 });
  return { ok: true, server_time: ts, branch_id: bid, pending_push_count: Math.max(0, Number(pendingPushCount) || 0) };
}

// PUSH. Row-level upsert for reference data only.
async function push(db, ctx, { branchId, deviceId = null, changes }) {
  const businessUnitId = ctx.businessUnitId;
  const settings = await getUnitSettings(db, businessUnitId);
  if (settings.offline_sync_enabled === 0) throw new HttpError(403, 'Offline sync is not enabled for this business.', 'SYNC_DISABLED');

  const pusherBranchId = branchId || ctx.user.branch_id;
  if (!pusherBranchId) throw new HttpError(400, 'A branch is required.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, pusherBranchId);
  if (!Array.isArray(changes)) throw new HttpError(400, 'Send the changed rows as an array.', 'SYNC_CHANGES_REQUIRED');
  if (changes.length > 500) {
    throw new HttpError(400, 'Push at most 500 rows per request. A larger batch will time out on a mobile connection and the whole push would have to be retried.', 'SYNC_TOO_MANY_CHANGES');
  }

  const results = { inserted: 0, updated: 0, skipped_stale: 0, refused: 0, failed: 0 };
  const refusals = [];
  const failures = [];
  const conflicts = [];
  const ts = watNowIso();

  for (const change of changes) {
    const tableName = String(change.table || '').toLowerCase();
    const spec = SYNCABLE[tableName];
    if (!spec) {
      results.refused += 1;
      refusals.push({ table: tableName, id: change.id, reason: `${tableName} is not row-syncable. Sales, stock and ledgers are facts, not state — replay them as new transactions with an Idempotency-Key.` });
      continue;
    }
    if (!change.id) {
      results.failed += 1; failures.push({ table: tableName, reason: 'no row id' }); continue;
    }
    const row = change.data && typeof change.data === 'object' ? change.data : {};

    // Filter to the allowlisted columns. Anything else is dropped silently
    // rather than erroring, because a client on an older app version will
    // send columns this server does not know about and refusing the whole
    // push over one unknown field would strand the rest of the queue.
    const patch = {};
    for (const col of spec.columns) {
      if (Object.prototype.hasOwnProperty.call(row, col)) {
        const v = row[col];
        patch[col] = v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
    }

    const existing = await db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).bind(String(change.id)).first();

    if (!existing) {
      // ---- INSERT ----
      // Scoped to the PUSHER's branch. A device may only create records in
      // its own branch; this is the correct rule for an insert.
      let scopedBranch = null;
      if (spec.scopeColumn) {
        try {
          scopedBranch = resolveMutationBranchId(ctx.user, row[spec.scopeColumn] || pusherBranchId);
        } catch (e) {
          results.refused += 1; refusals.push({ table: tableName, id: change.id, reason: e.message }); continue;
        }
      }
      if (existing === null && spec.unitColumn) patch[spec.unitColumn] = businessUnitId;
      if (scopedBranch && spec.scopeColumn) patch[spec.scopeColumn] = scopedBranch;
      patch.id = String(change.id);
      patch.updated_at = ts;
      if (!('is_deleted' in patch)) patch.is_deleted = 0;
      if (!('created_at' in patch)) patch.created_at = ts;

      const cols = Object.keys(patch);
      try {
        await db.prepare(`INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .bind(...cols.map((c) => patch[c])).run();
        results.inserted += 1;
      } catch (e) {
        results.failed += 1;
        failures.push({ table: tableName, id: change.id, reason: e.message });
      }
      continue;
    }

    // ---- UPDATE ----
    // Scoped by the ROW's existing branch, NEVER by the writer's. This is the
    // fix for the reparenting hole described in the header comment.
    if (spec.scopeColumn && existing[spec.scopeColumn] && existing[spec.scopeColumn] !== pusherBranchId) {
      // Cross-branch write. Refuse and record, because the two branches
      // genuinely disagree and a human needs to decide.
      results.refused += 1;
      refusals.push({
        table: tableName, id: change.id,
        reason: `That record belongs to another branch. A push cannot move a row between branches — doing so would move its debts and its history with it.`,
        owner_branch_id: existing[spec.scopeColumn],
      });
      await recordConflict(db, {
        businessUnitId, tableName, rowId: String(change.id), branchId: pusherBranchId, deviceId,
        losing: existing, winning: { ...existing, ...patch }, resolutionNote: 'CROSS_BRANCH_WRITE_REFUSED',
      });
      continue;
    }
    if (spec.unitColumn && existing[spec.unitColumn] && existing[spec.unitColumn] !== businessUnitId) {
      results.refused += 1;
      refusals.push({ table: tableName, id: change.id, reason: 'That record belongs to a different business.' });
      continue;
    }

    // LAST-WRITE-WINS on updated_at. A push older than the stored row is a
    // stale replay — skip it rather than resurrecting an old version, which
    // is what happens if you compare on client clocks alone.
    const storedAt = existing.updated_at ? Date.parse(String(existing.updated_at).replace(' ', 'T') + 'Z') : 0;
    const incomingAt = row.updated_at ? Date.parse(String(row.updated_at).replace(' ', 'T') + 'Z') : null;
    if (incomingAt && Number.isFinite(storedAt) && Number.isFinite(incomingAt) && incomingAt < storedAt) {
      results.skipped_stale += 1;
      continue;
    }

    // A real overwrite of a concurrently-edited row: record what is being
    // discarded BEFORE discarding it.
    const meaningfulChange = Object.keys(patch).some((k) => String(existing[k] ?? '') !== String(patch[k] ?? ''));
    if (meaningfulChange && incomingAt && Number.isFinite(storedAt) && Math.abs(storedAt - incomingAt) < 3600000) {
      conflicts.push({ table: tableName, id: change.id });
      await recordConflict(db, {
        businessUnitId, tableName, rowId: String(change.id), branchId: pusherBranchId, deviceId,
        losing: existing, winning: { ...existing, ...patch },
      });
    }

    patch.updated_at = ts;
    const cols = Object.keys(patch);
    try {
      await db.prepare(`UPDATE ${tableName} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .bind(...cols.map((c) => patch[c]), String(change.id)).run();
      results.updateded = (results.updated || 0);
      results.updated += 1;
    } catch (e) {
      results.failed += 1; failures.push({ table: tableName, id: change.id, reason: e.message });
    }
  }

  const status = results.failed ? 'PARTIAL' : 'SUCCESS';
  await db.prepare(`
    UPDATE branch_sync_status SET last_push_at = ?, pending_push_count = 0, last_sync_error = ?, device_id = COALESCE(?, device_id), updated_at = ?
    WHERE branch_id = ?
  `).bind(ts, results.failed ? `${results.failed} row(s) failed` : null, deviceId, ts, pusherBranchId).run();
  await logSync(db, {
    businessUnitId, branchId: pusherBranchId, deviceId, direction: 'PUSH', status,
    rowCount: results.inserted + results.updated,
    error: results.failed ? `${results.failed} failed, ${results.refused} refused` : null,
  });

  return {
    ok: results.failed === 0,
    server_time: ts,
    ...results,
    refusals: refusals.slice(0, 20),
    failures: failures.slice(0, 20),
    conflicts_recorded: conflicts.length,
    // Telling the client what to do next is the difference between a queue
    // that drains and a queue that retries the same refused row forever.
    advisory: results.refused
      ? `${results.refused} row(s) were refused and will be refused again on retry — remove them from the queue and raise them with a manager.`
      : null,
  };
}

// PULL. Everything the device needs to operate offline, scoped to its own
// branch, since a change_at cursor.
async function pull(db, ctx, { branchId, deviceId = null, since = null, tables = null }) {
  const businessUnitId = ctx.businessUnitId;
  const bid = branchId || ctx.user.branch_id;
  if (!bid) throw new HttpError(400, 'A branch is required.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, bid);

  const sinceSql = since ? 'AND updated_at > ?' : '';
  const sinceParam = since ? [String(since)] : [];
  const out = {};

  const wanted = Array.isArray(tables) && tables.length ? tables : ['products', 'product_categories', 'price_tiers', 'customers', 'suppliers', 'branches', 'promotions', 'product_barcodes'];

  const scopes = {
    // Business-wide reference data: every branch needs all of it.
    products: { sql: 'business_unit_id = ?', params: [businessUnitId] },
    product_categories: { sql: 'business_unit_id = ?', params: [businessUnitId] },
    price_tiers: { sql: 'business_unit_id = ?', params: [businessUnitId] },
    product_barcodes: { sql: 'business_unit_id = ?', params: [businessUnitId] },
    promotions: { sql: 'business_unit_id = ?', params: [businessUnitId] },
    suppliers: { sql: 'business_unit_id = ?', params: [businessUnitId] },
    product_tier_prices: { sql: 'business_unit_id = ?', params: [businessUnitId] },
    product_price_overrides: { sql: 'business_unit_id = ? AND branch_id = ?', params: [businessUnitId, bid] },
    // Branch-scoped: a cashier must never receive another branch's cash or
    // stock data on their device, because a synced copy is a readable copy.
    branches: { sql: 'business_unit_id = ?', params: [businessUnitId] },
    customers: { sql: 'business_unit_id = ? AND (home_branch_id = ? OR home_branch_id IS NULL)', params: [businessUnitId, bid] },
    stock_batches: { sql: 'business_unit_id = ? AND branch_id = ?', params: [businessUnitId, bid] },
    product_serials: { sql: 'business_unit_id = ? AND branch_id = ?', params: [businessUnitId, bid] },
    layaway_holds: { sql: 'business_unit_id = ? AND branch_id = ?', params: [businessUnitId, bid] },
    payment_plans: { sql: 'business_unit_id = ? AND branch_id = ?', params: [businessUnitId, bid] },
    change_owed: { sql: 'business_unit_id = ?', params: [businessUnitId] },   // payable at ANY branch by design
    users: null,                                                             // never synced to a device
  };

  for (const t of wanted) {
    if (!Object.prototype.hasOwnProperty.call(scopes, t)) continue;
    const scope = scopes[t];
    if (!scope) continue;
    const rows = await db.prepare(`
      SELECT * FROM ${t} WHERE is_deleted = 0 AND ${scope.sql} ${sinceSql}
      ORDER BY updated_at ASC LIMIT 5000
    `).bind(...scope.params, ...sinceParam).all();
    // Strip anything a device should not hold even within its own branch.
    out[t] = rows.results.map((r) => stripSensitive(t, r));
  }

  const ts = watNowIso();
  const total = Object.values(out).reduce((a, list) => a + list.length, 0);
  await db.prepare(`
    UPDATE branch_sync_status SET last_pull_at = ?, device_id = COALESCE(?, device_id), updated_at = ? WHERE branch_id = ?
  `).bind(ts, deviceId, ts, bid).run();
  await logSync(db, { businessUnitId, branchId: bid, deviceId, direction: 'PULL', status: 'SUCCESS', rowCount: total });

  return { ok: true, server_time: ts, since: since || null, counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])), data: out };
}

// Column-level stripping. A synced row is a row sitting in a browser's
// storage on a shop-floor laptop, so anything that is a credential, a
// cross-branch financial figure or another customer's data does not go.
const STRIP_COLUMNS = Object.freeze({
  customers: ['credit_limit', 'kyc_status', 'kyc_verified_by'],
  users: ['pin_hash'],
  suppliers: ['bank_account_no', 'credit_limit'],
  payment_plans: ['guarantor_id_no'],
  '*': [],
});

function stripSensitive(table, row) {
  const cols = STRIP_COLUMNS[table] || [];
  if (!cols.length) return row;
  const out = { ...row };
  for (const c of cols) delete out[c];
  return out;
}

async function recordConflict(db, { businessUnitId, tableName, rowId, branchId, deviceId, losing, winning, resolutionNote = null }) {
  try {
    await db.prepare(`
      INSERT INTO sync_conflicts (id, business_unit_id, table_name, row_id, branch_id, device_id,
        losing_version_json, winning_version_json, detected_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(newId(), businessUnitId, tableName, String(rowId), branchId || null, deviceId || null,
      safeStringify(losing), safeStringify(winning), watNowIso()).run();
  } catch (e) {
    // Conflict recording must never break the push it is describing.
    console.error('[syncService] conflict record failed:', e && e.message);
  }
}

function safeStringify(v) {
  try {
    const clone = { ...(v || {}) };
    for (const k of ['pin_hash', 'bank_account_no']) delete clone[k];
    return JSON.stringify(clone).slice(0, 20000);
  } catch (_) { return '{}'; }
}

async function logSync(db, { businessUnitId, branchId, deviceId, direction, tableName = null, rowCount = 0, status = 'SUCCESS', error = null, durationMs = null }) {
  try {
    await db.prepare(`
      INSERT INTO sync_change_log (id, business_unit_id, branch_id, device_id, direction, table_name, row_count,
        status, error_message, duration_ms, synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).bind(newId(), businessUnitId || null, branchId || null, deviceId || null, direction, tableName,
      rowCount, status, error ? String(error).slice(0, 500) : null, durationMs, watNowIso()).run();
  } catch (e) { console.error('[syncService] log write failed:', e && e.message); }
}

async function overview(db, { businessUnitId, branchId = null }) {
  const rows = await db.prepare(`
    SELECT * FROM v_branch_sync_overview WHERE business_unit_id = ? ${branchId ? 'AND branch_id = ?' : ''}
    ORDER BY CASE sync_health WHEN 'STALE' THEN 0 WHEN 'ERROR' THEN 1 WHEN 'NEVER_SYNCED' THEN 2 WHEN 'PENDING' THEN 3 ELSE 4 END, branch_name
  `).bind(businessUnitId, ...(branchId ? [branchId] : [])).all();
  return rows.results;
}

async function conflicts(db, { businessUnitId, unreviewedOnly = true, limit = 100 }) {
  const rows = await db.prepare(`
    SELECT sc.*, b.name AS branch_name, u.full_name AS reviewed_by_name
    FROM sync_conflicts sc
    LEFT JOIN branches b ON b.id = sc.branch_id
    LEFT JOIN users u ON u.id = sc.reviewed_by
    WHERE sc.business_unit_id = ? ${unreviewedOnly ? 'AND sc.reviewed_by IS NULL' : ''}
    ORDER BY sc.detected_at DESC LIMIT ?
  `).bind(businessUnitId, Math.min(500, Number(limit) || 100)).all();
  return rows.results;
}

async function reviewConflict(db, ctx, { conflictId, resolution, note = null }) {
  const c = await db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').bind(conflictId).first();
  if (!c) throw new HttpError(404, 'That sync conflict was not found.', 'CONFLICT_NOT_FOUND');
  if (c.business_unit_id !== ctx.businessUnitId) throw new HttpError(403, 'That conflict belongs to another business.', 'CONFLICT_WRONG_BUSINESS');
  const r = String(resolution || '').toUpperCase();
  if (!['KEEP_WINNER', 'RESTORE_LOSER', 'MERGED', 'IGNORED'].includes(r)) {
    throw new HttpError(400, 'Resolution must be KEEP_WINNER, RESTORE_LOSER, MERGED or IGNORED.', 'CONFLICT_RESOLUTION_INVALID');
  }
  if (r === 'RESTORE_LOSER' || r === 'MERGED') {
    // Restoring is a write to the syncable table and must go through the same
    // branch-scope guard as a push, or reviewing a conflict becomes the one
    // path that can reparent a row.
    const spec = SYNCABLE[c.table_name];
    if (!spec) throw new HttpError(409, `${c.table_name} cannot be restored through sync — restore it on the screen that owns it.`, 'CONFLICT_NOT_RESTORABLE');
    const payload = r === 'RESTORE_LOSER' ? JSON.parse(c.losing_version_json || '{}') : JSON.parse(c.winning_version_json || '{}');
    const patch = {};
    for (const col of spec.columns) if (Object.prototype.hasOwnProperty.call(payload, col)) patch[col] = payload[col];
    const cols = Object.keys(patch);
    if (cols.length) {
      await db.prepare(`UPDATE ${c.table_name} SET ${cols.map((x) => `${x} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...cols.map((x) => patch[x]), watNowIso(), c.row_id).run();
    }
  }
  await db.prepare('UPDATE sync_conflicts SET resolution = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?')
    .bind(r, ctx.user.id, watNowIso(), note ? String(note).slice(0, 500) : null, conflictId).run();
  return { ok: true, id: conflictId, resolution: r };
}

// Housekeeping. sync_change_log grows with every heartbeat — at one beat per
// minute per branch that is ~1.4k rows per branch per day, and a table that
// is never pruned becomes the slowest query in the product within a year.
async function pruneSyncLog(db, { keepDays = 90 } = {}) {
  const res = await db.prepare(`DELETE FROM sync_change_log WHERE synced_at < datetime('now','+1 hour', ?)`)
    .bind(`-${keepDays} days`).run();
  return (res && res.meta && res.meta.changes) || 0;
}

module.exports = {
  SYNCABLE, STRIP_COLUMNS,
  heartbeat, push, pull, overview, conflicts, reviewConflict, pruneSyncLog,
  recordConflict, logSync, stripSensitive,
};
'use strict';
