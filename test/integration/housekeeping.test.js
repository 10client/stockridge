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

test('device sync history is pruned at 90 days, and the shop recognises a phone that synced yesterday', async () => {
  // sync_change_log is the fastest-growing table in the schema: one row per push,
  // pull and heartbeat, per device, per day. A row from last year answers nothing.
  await withDb(async (db) => {
    const insert = "INSERT INTO sync_change_log (id, device_id, direction, status, synced_at) VALUES (?,?,?,?, datetime('now'))";
    await db.run(insert, ['log-fresh', 'device-1', 'PUSH', 'SUCCESS']);
    await db.run(insert, ['log-stale', 'device-1', 'PUSH', 'SUCCESS']);
    await db.run("UPDATE sync_change_log SET synced_at = datetime('now', ?) WHERE id = 'log-stale'", ['-91 days']);

    const result = await runHousekeeping(db);
    assert.equal(result.errors.length, 0, `housekeeping reported: ${result.errors.join('; ')}`);
    assert.equal(result.retentionPruned['sync change log'], 1, 'one row is past the 90-day window');

    const left = await db.all('SELECT id FROM sync_change_log');
    assert.deepEqual(left.map((r) => r.id), ['log-fresh'], 'yesterday must survive: the sync screen reads it');
  });
});

test('a REVIEWED conflict ages out at 180 days and an UNREVIEWED one never does', async () => {
  // The distinction is the whole feature. A reviewed conflict is a decision
  // somebody made and can be summarised; an unreviewed conflict is an unanswered
  // question about a customer's record, and it holds the only copy of the version
  // a device typed while it was offline. Deleting that would destroy the shop's
  // own data to save bytes.
  await withDb(async (db) => {
    const id = await adminId(db);
    const insert = "INSERT INTO sync_conflicts (id, table_name, row_id, losing_version_json, winning_version_json, detected_at, reviewed_by, reviewed_at) VALUES (?,?,?,?,?, datetime('now'), ?, ?)";
    await db.run(insert, ['conflict-reviewed-old', 'customers', 'row-1', '{}', '{}', id, null]);
    await db.run(insert, ['conflict-reviewed-new', 'customers', 'row-2', '{}', '{}', id, null]);
    await db.run(insert, ['conflict-unreviewed-old', 'customers', 'row-3', '{}', '{}', null, null]);
    await db.run("UPDATE sync_conflicts SET reviewed_at = datetime('now', ?) WHERE id = 'conflict-reviewed-old'", ['-181 days']);
    await db.run("UPDATE sync_conflicts SET reviewed_at = datetime('now', ?) WHERE id = 'conflict-reviewed-new'", ['-10 days']);
    await db.run("UPDATE sync_conflicts SET detected_at = datetime('now', ?) WHERE id = 'conflict-unreviewed-old'", ['-400 days']);

    const result = await runHousekeeping(db);
    assert.equal(result.errors.length, 0, `housekeeping reported: ${result.errors.join('; ')}`);
    assert.equal(result.retentionPruned['reviewed sync conflicts'], 1, 'one REVIEWED conflict is past 180 days');

    const left = await db.all('SELECT id FROM sync_conflicts ORDER BY id');
    assert.deepEqual(left.map((r) => r.id), ['conflict-reviewed-new', 'conflict-unreviewed-old'],
      'a reviewed conflict inside the window and an UNREVIEWED conflict of any age must both survive');
  });
});

test('sign-in attempts are pruned at 90 days but the throttle can still see this morning', async () => {
  await withDb(async (db) => {
    const id = await adminId(db);
    const insert = "INSERT INTO login_attempts (id, username, user_id, succeeded, attempted_at) VALUES (?,?,?,?, datetime('now'))";
    await db.run(insert, ['attempt-fresh', 'admin', id, 0]);
    await db.run(insert, ['attempt-stale', 'admin', id, 0]);
    await db.run("UPDATE login_attempts SET attempted_at = datetime('now', ?) WHERE id = 'attempt-stale'", ['-91 days']);

    const result = await runHousekeeping(db);
    assert.equal(result.errors.length, 0, `housekeeping reported: ${result.errors.join('; ')}`);
    assert.equal(result.retentionPruned['login attempts'], 1, 'one attempt is past the 90-day window');

    const left = await db.all('SELECT id FROM login_attempts');
    assert.deepEqual(left.map((r) => r.id), ['attempt-fresh'],
      'a fresh failed attempt must survive: the throttle counts these to lock an account');
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

test('the daily schedule raises a compliance alert, once, for what it should', async () => {
  // THE PRODUCER THE NOTIFICATIONS TABLE NEVER HAD.
  //
  // `notifications` has been read by a screen and a set of routes since the
  // beginning, and nothing in the application ever wrote a row — so the bell was
  // permanently empty and every alert list was forever "nothing to report". This
  // asserts the cron writes one, that it writes exactly one, and that it writes
  // it about the right record: a licence that has lapsed is CRITICAL, a licence
  // inside the owner's window is a WARNING, and a licence two years out is
  // nothing at all.
  await withDb(async (db) => {
    await db.run("INSERT INTO businesses (id, name, profile_code, is_active, created_at, updated_at) VALUES ('b1','Test Traders','GENERAL_RETAIL',1, datetime('now'), datetime('now'))");
    await db.run("INSERT INTO branches (id, business_id, name, code, is_active, created_at, updated_at) VALUES ('br1','b1','Main','MAIN',1, datetime('now'), datetime('now'))");
    // Dates computed in JavaScript, not spliced in as SQL text. The first version
    // of this test passed the literal string "date('now','-15 days')" as a BOUND
    // PARAMETER, so `expiry_date` held that sentence rather than a date, nothing
    // was ever near expiry, and the test reported that the cron raises no alerts —
    // which is exactly what it looked like the cron was doing.
    const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const mk = (id, type, expiry) => db.run(`INSERT INTO branch_compliance_records
        (id, branch_id, record_type, record_number, expiry_date, created_at, updated_at)
        VALUES (?,?,?,?,?, datetime('now'), datetime('now'))`, [id, 'br1', type, id, expiry]);

    await db.run("INSERT INTO branch_compliance_records (id, branch_id, record_type, expiry_date, created_at, updated_at) VALUES ('c-none','br1','TIN',NULL, datetime('now'), datetime('now'))");
    await mk('c-expired', 'FIRE_CERT', iso(-15));
    await mk('c-soon', 'TRADING_PERMIT', iso(10));
    await mk('c-far', 'SONCAP_DEALER', iso(700));
    // A record beyond the view's own 90-day horizon but inside a window an owner
    // might set: the statement must not invent an alert the view cannot see.
    await mk('c-beyond', 'VAT_REG', iso(200));

    const first = await runHousekeeping(db, { sessionGraceHours: SESSION_GRACE_HOURS });
    assert.equal(first.errors.length, 0, `the cron reported: ${first.errors.join('; ')}`);
    assert.equal(first.complianceAlertsRaised, 2, `expected an alert for the lapsed and the imminent licence, got ${first.complianceAlertsRaised}`);

    const rows = await db.all("SELECT * FROM notifications WHERE type = 'COMPLIANCE_EXPIRY' AND is_deleted = 0 ORDER BY severity");
    assert.equal(rows.length, 2);
    const expired = rows.find((r) => r.reference_id === 'c-expired');
    const soon = rows.find((r) => r.reference_id === 'c-soon');
    assert.ok(expired && soon, 'the two alerts must be about the two licences that need attention');
    assert.equal(expired.severity, 'CRITICAL', 'a lapsed certificate is not a warning');
    assert.equal(soon.severity, 'WARNING');
    assert.equal(expired.branch_id, 'br1');
    assert.equal(expired.business_id, 'b1', 'the business comes through the view, not a second query');
    assert.equal(expired.user_id, null, 'a broadcast, which is what a NULL user_id means on this table');
    assert.match(expired.title, /expired/i);
    assert.ok(!rows.some((r) => r.reference_id === 'c-far'), 'a licence two years out is not an alert');
    assert.ok(!rows.some((r) => r.reference_id === 'c-none'), 'a record with no expiry never alerts — the schema says a NULL expiry does not expire');
    assert.ok(!rows.some((r) => r.reference_id === 'c-beyond'), 'the view stops at 90 days and the alert list cannot see past it');

    // Idempotent, which is what makes a DAILY schedule survivable: without this a
    // monthly permit would produce thirty notifications a month.
    const second = await runHousekeeping(db, { sessionGraceHours: SESSION_GRACE_HOURS });
    assert.equal(second.complianceAlertsRaised, 0, 'a second run must not duplicate an unread alert');
    assert.equal(Number(await db.scalar("SELECT COUNT(*) FROM notifications WHERE type = 'COMPLIANCE_EXPIRY'")), 2);

    // Reading it is what allows the next one: the alert for a licence that was
    // dealt with stops being repeated, and if it lapses again the owner hears
    // about it again.
    await db.run("UPDATE notifications SET is_read = 1 WHERE reference_id = 'c-soon'");
    const third = await runHousekeeping(db, { sessionGraceHours: SESSION_GRACE_HOURS });
    assert.equal(third.complianceAlertsRaised, 1, 'a read alert is not a reason to stay silent forever');
  });
});
