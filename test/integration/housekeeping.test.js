'use strict';
// =====================================================================
// test/integration/housekeeping.test.js — THE CRON, EXECUTED
// =====================================================================
// The Worker's scheduled handler used to contain this:
//
//   UPDATE user_sessions SET is_deleted = 1, updated_at = datetime('now')
//     WHERE is_deleted = 0 AND expires_at IS NOT NULL AND expires_at < datetime('now')
//   UPDATE branch_devices SET is_active = 0, updated_at = datetime('now')
//     WHERE is_active = 1 AND last_seen_at IS NOT NULL AND last_seen_at < datetime('now','-60 day')
//
// `user_sessions` is (user_id, session_id, issued_at, updated_at) — it has no
// `is_deleted` and no `expires_at`. `branch_devices` is (id, branch_id, device_id,
// label, registered_by, registered_at, revoked_by, revoked_at, updated_at,
// is_deleted) — it has no `is_active` and no `last_seen_at`.
//
// So the first statement threw, the try/catch turned it into one log line, the
// second never ran, and the cron had done nothing since it was scheduled. Every
// static audit passed: the SQL is perfectly well-formed, and it is only wrong
// about a schema that only answers when you execute against it.
//
// These tests execute it, against a database built from schema/migrations/.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { buildSeedSql } = require('../../tools/d1-seed');
const { housekeepingStatements, runHousekeeping, SESSION_GRACE_HOURS } = require('../../worker/src/housekeeping');
const { RETENTION_DAYS } = require('../../server/lib/idempotency');

let counter = 0;

async function withDb(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-housekeeping-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    await db.exec((await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'A' })).sql);
    return await fn(db);
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  }
}

async function adminId(db) {
  return String((await db.first("SELECT id FROM users WHERE username = 'admin'")).id);
}

test('every housekeeping statement executes against the real schema', async () => {
  // The assertion is that this does not throw. That is the whole test, and it is
  // the one that was missing: naming a column the schema lacks is a runtime error
  // no static audit in this repository can see.
  await withDb(async (db) => {
    for (const statement of housekeepingStatements()) {
      await assert.doesNotReject(
        () => db.run(statement.sql, statement.params),
        `${statement.name} must execute: ${statement.sql}`,
      );
    }
  });
});

test('an expired session is pruned and a live one is kept', async () => {
  await withDb(async (db) => {
    const id = await adminId(db);
    // The administrator is the only seeded user; a second session row is not
    // possible because user_id is the primary key, so this test drives the
    // boundary with timestamps instead.
    // NOTE: datetime('now') goes in the SQL text, not in the parameters. Bound as
    // a string it is stored literally as the text "datetime('now')", which every
    // date comparison then treats as NULL — the first version of this test did
    // exactly that and passed for the wrong reason.
    await db.run("INSERT INTO user_sessions (user_id, session_id, issued_at, updated_at) VALUES (?,?,datetime('now'),datetime('now'))",
      [id, 'live-session']);

    // A live session survives.
    let result = await runHousekeeping(db);
    assert.equal(result.errors.length, 0, `housekeeping reported: ${result.errors.join('; ')}`);
    assert.equal(result.sessionsPruned, 0, 'a session issued now must not be pruned');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM user_sessions')), 1);

    // Backdate it beyond the grace window — the token it belongs to has expired.
    await db.run('UPDATE user_sessions SET issued_at = datetime(\'now\', ?) WHERE user_id = ?',
      [`-${SESSION_GRACE_HOURS + 1} hours`, id]);

    result = await runHousekeeping(db);
    assert.equal(result.errors.length, 0, `housekeeping reported: ${result.errors.join('; ')}`);
    assert.equal(result.sessionsPruned, 1, 'a session older than the token TTL is dead weight and must go');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM user_sessions')), 0);
  });
});

test('idempotency keys are pruned at the retention window and not before', async () => {
  // These rows exist so that a retried sale applies once. They are also one row
  // per write, forever — the retention rule lived in idempotency.js and was never
  // called by anything until housekeeping picked it up.
  await withDb(async (db) => {
    const id = await adminId(db);
    const insert = "INSERT INTO idempotency_keys (idempotency_key, user_id, method, path, request_hash, status, created_at) VALUES (?,?,?,?,?, 'COMPLETED', datetime('now'))";
    await db.run(insert, ['fresh-key', id, 'POST', '/api/sales', 'hash']);
    await db.run(insert, ['stale-key', id, 'POST', '/api/sales', 'hash']);
    await db.run("UPDATE idempotency_keys SET created_at = datetime('now', ?) WHERE idempotency_key = 'stale-key'",
      [`-${RETENTION_DAYS + 1} days`]);

    const result = await runHousekeeping(db);
    assert.equal(result.errors.length, 0, `housekeeping reported: ${result.errors.join('; ')}`);
    assert.equal(result.idempotencyKeysPruned, 1, `one key is past the ${RETENTION_DAYS}-day window`);

    const left = await db.all('SELECT idempotency_key FROM idempotency_keys');
    assert.deepEqual(left.map((r) => r.idempotency_key), ['fresh-key'], 'the fresh key must survive');
  });
});

test('housekeeping reports its failures instead of throwing', async () => {
  // A cron that throws takes its own evidence with it, and the platform retries
  // the same failing work. The handler has to survive a broken statement and say
  // what broke — which is how this defect should have been visible the first time
  // it ran, rather than as a line nobody reads.
  const broken = {
    run: async (sql) => {
      if (/user_sessions/.test(sql)) throw new Error('no such column: nonsense');
      return { changes: 3 };
    },
    // prune() needs a run that succeeds.
  };
  const result = await runHousekeeping(broken);
  assert.equal(result.errors.length, 1, 'the failure must be reported, not thrown');
  assert.match(result.errors[0], /no such column/);
  assert.equal(result.sessionsPruned, 0);
  assert.equal(result.idempotencyKeysPruned, 3, 'the statements after a failure must still run');
});
