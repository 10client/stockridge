'use strict';
// =====================================================================
// test/integration/storage.test.js — THE MODEL IS CHECKED, NOT BELIEVED
// =====================================================================
// Two promises are made in comments elsewhere in this tree, and both are
// assertions here rather than good intentions:
//
//   1. server/lib/storage.js says its floor (EMPTY_SCHEMA_BYTES) was MEASURED,
//      and that a migration doubling the schema re-opens the question. This test
//      rebuilds an empty database from the migrations, measures it, and fails if
//      the constant has drifted more than 25%. A model is only as good as the
//      last time somebody checked it.
//
//   2. server/lib/retention.js keeps a DELETE and a COUNT of the same predicate
//      side by side, because the status screen reports the count to a proprietor
//      who then decides whether to act. This test PREVIEWS, RUNS, and asserts the
//      two agree — so a screen can never say "would remove 4,000 rows" about a
//      rule that removes none.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { buildSeedSql } = require('../../tools/d1-seed');
const { estimate, EMPTY_SCHEMA_BYTES, D1_FREE_LIMIT_BYTES } = require('../../server/lib/storage');
const { runRetention, retentionPreview, RETENTION_DAYS } = require('../../server/lib/retention');

let counter = 0;

async function withDb(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-storage-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    await db.exec((await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'A' })).sql);
    return await fn(db, file);
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(file + suffix, { force: true }); } catch (e) { /* nothing to remove */ }
    }
  }
}

test('the empty-schema floor is still what the model says it is', async () => {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-floor-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    db.raw.exec('VACUUM');
    const measured = fs.statSync(file).size;
    const drift = Math.abs(measured - EMPTY_SCHEMA_BYTES) / EMPTY_SCHEMA_BYTES;
    const tables = db.raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get().c;
    assert.ok(drift <= 0.25,
      `an empty migrated database now measures ${measured} bytes (${tables} tables), but storage.js budgets ${EMPTY_SCHEMA_BYTES} — a ${(drift * 100).toFixed(1)}% drift. Re-measure and update EMPTY_SCHEMA_BYTES: the floor exists so the estimate warns a proprietor BEFORE writes fail, and an estimate that under-warns is the one failure mode this whole model cannot afford`);
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(file + suffix, { force: true }); } catch (e) { /* nothing */ } }
  }
});

test('the estimate describes itself as an estimate, and names its assumptions', async () => {
  await withDb(async (db) => {
    const e = await estimate(db);
    assert.equal(e.available, true, 'an empty database must still produce an estimate');
    assert.ok(e.bytes >= EMPTY_SCHEMA_BYTES, `the estimate (${e.bytes}) is below the measured empty-schema floor (${EMPTY_SCHEMA_BYTES}) — the floor is not being added`);
    assert.equal(e.limit_bytes, D1_FREE_LIMIT_BYTES);
    assert.ok(['OK', 'WARNING', 'CRITICAL'].includes(e.status), `unexpected status ${e.status}`);
    assert.equal(e.status, 'OK', 'a freshly seeded database is not near any ceiling');
    assert.match(e.assumption.note, /estimate/i,
      'the model must say out loud that it is an estimate: PharmaRidge recorded that D1 does not expose a database size to the Worker, and a proprietor acting on a number presented as a measurement is the failure this note prevents');
    assert.ok(e.assumption.emptySchemaBytes > 0);
  });
});

test('rows move the estimate, and the biggest tables are named', async () => {
  await withDb(async (db) => {
    const before = await estimate(db);
    const business = await db.first('SELECT id FROM businesses LIMIT 1');
    const branch = await db.first('SELECT id FROM branches LIMIT 1');
    const id = () => Math.random().toString(16).slice(2, 18);
    // 500 audit rows: the estimate must see them, and must name the table.
    for (let i = 0; i < 500; i += 1) {
      // `row_hash` is NOT NULL because the audit log is hash-chained: a row
      // without one is a row nothing can verify. The test supplies a value rather
      // than relaxing the constraint — the chain is the point of the table.
      await db.run(`INSERT INTO audit_log (id, business_id, branch_id, action, entity_type, entity_id, row_hash, created_at)
                    VALUES (?,?,?,?,?,?,?, datetime('now'))`,
      [id(), business ? business.id : null, branch ? branch.id : null, 'TEST_EVENT', 'TEST', id(), `test-hash-${i}`]);
    }
    const after = await estimate(db);
    assert.ok(after.bytes > before.bytes,
      `500 audit rows did not change the estimate (${before.bytes} → ${after.bytes}); the model is not reading the tables it names`);
    const named = after.largest.map((t) => t.table);
    assert.ok(named.includes('audit_log'),
      `audit_log has 500 rows and is not among the biggest contributors (${named.join(', ')}) — "why is it that big?" has no answer without this list`);
  });
});

test('the retention preview reports what the run actually removes', async () => {
  // THE ANTI-DRIFT TEST. The status screen shows `wouldRemove`; this proves the
  // number is the one the housekeeping run acts on.
  await withDb(async (db) => {
    const userId = String((await db.first("SELECT id FROM users WHERE username = 'admin'")).id);
    const insertAttempt = "INSERT INTO login_attempts (id, username, user_id, succeeded, attempted_at) VALUES (?,?,?,0, datetime('now'))";
    const insertLog = "INSERT INTO sync_change_log (id, device_id, direction, status, synced_at) VALUES (?,?,?,?, datetime('now'))";
    for (let i = 0; i < 3; i += 1) {
      await db.run(insertAttempt, [`old-attempt-${i}`, 'admin', userId]);
      await db.run(`UPDATE login_attempts SET attempted_at = datetime('now', ?) WHERE id = ?`, [`-${RETENTION_DAYS.loginAttempts + 2} days`, `old-attempt-${i}`]);
      await db.run(insertLog, [`old-log-${i}`, 'device-1', 'PUSH', 'SUCCESS']);
      await db.run(`UPDATE sync_change_log SET synced_at = datetime('now', ?) WHERE id = ?`, [`-${RETENTION_DAYS.syncChangeLog + 2} days`, `old-log-${i}`]);
    }
    await db.run(insertAttempt, ['fresh-attempt', 'admin', userId]);
    await db.run(insertLog, ['fresh-log', 'device-1', 'PUSH', 'SUCCESS']);

    const preview = await retentionPreview(db);
    for (const rule of preview) {
      assert.equal(rule.error, null, `${rule.name} could not be counted: ${rule.error}`);
    }
    const byName = Object.fromEntries(preview.map((r) => [r.name, r.wouldRemove]));
    assert.equal(byName['login attempts'], 3, `the preview said ${byName['login attempts']} sign-in attempts would go, but 3 are past the window`);
    assert.equal(byName['sync change log'], 3, `the preview said ${byName['sync change log']} sync rows would go, but 3 are past the window`);
    assert.equal(byName['reviewed sync conflicts'], 0, 'nothing has been reviewed, so nothing may be removed');

    const run = await runRetention(db);
    assert.equal(run.pruned['login attempts'], byName['login attempts'], 'the run removed a different number of sign-in attempts than the preview promised');
    assert.equal(run.pruned['sync change log'], byName['sync change log'], 'the run removed a different number of sync rows than the preview promised');
    assert.equal(run.pruned['reviewed sync conflicts'], 0);

    const attemptRows = await db.all('SELECT id FROM login_attempts');
    assert.deepEqual(attemptRows.map((r) => r.id), ['fresh-attempt'], 'the fresh sign-in attempt must survive the run');
    const logRows = await db.all('SELECT id FROM sync_change_log');
    assert.deepEqual(logRows.map((r) => r.id), ['fresh-log'], 'the fresh sync row must survive the run');
  });
});
