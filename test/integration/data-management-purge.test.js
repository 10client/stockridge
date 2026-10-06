'use strict';
// =====================================================================
// test/integration/data-management-purge.test.js — THE DOOR, NOT THE ENGINE
// =====================================================================
// `purge.test.js` proves the deletion plan against a fully-seeded database. This
// file proves the ENDPOINT: who may call it, what proof it demands, that a preview
// deletes nothing, that a real run leaves a receipt, and that a deployment with no
// business refuses instead of quietly succeeding at nothing.
//
// The distinction is the whole point of the file. A correct plan behind an open door
// is a shop that can be emptied by a mistyped URL, and a door in front of an
// incorrect plan is a shop that loses the wrong rows with every confirmation in
// place. Both have to be tested, and they are tested separately so a failure says
// which one broke.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PURGE_HTTP_PORT || 8833);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(ROOT, '.data', 'purge-http-test.db');

let child = null;

async function req(method, urlPath, { token, body } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + urlPath, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { _raw: text }; }
  return { status: res.status, json, text };
}

const ALL = 'ALL_BUSINESS_DATA';
const ALL_PHRASE = 'CLEAR ALL BUSINESS DATA';

test('data cleanup: who may run it, what it asks first, and what it leaves behind', async (t) => {
  for (const suffix of ['', '-wal', '-shm', '.jwt']) {
    try { fs.rmSync(DB_FILE + suffix, { force: true }); } catch (e) { /* absent is fine */ }
  }
  const { openDatabase, migrate } = require(path.join(ROOT, 'server/lib/db'));
  const provisioning = require(path.join(ROOT, 'server/services/provisioningService'));
  const { seedEverything } = require('./lib/purge-fixture');
  const { newId } = require(path.join(ROOT, 'domain/crypto'));

  const db = openDatabase({ file: DB_FILE });
  await migrate(db);
  await provisioning.provisionDeployment(db, {
    businessName: 'Purge Electronics Ltd',
    profileCode: 'ELECTRONICS',
    ownerName: 'Purge Owner', ownerUsername: 'pg-owner', ownerPin: '11111',
    adminUsername: 'pg-admin', adminPin: '99999',
    branches: [
      {
        name: 'Wuse Store', code: 'PG-WUS', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000,
        manager: { name: 'Wuse Manager', username: 'pg-manager', pin: '22222', job_title: 'Branch Manager' },
        staff: [{ name: 'Wuse Cashier', username: 'pg-staff', pin: '33333' }],
      },
      {
        name: 'Garki Depot', code: 'PG-GAR', city: 'Abuja', state: 'FCT', branch_type: 'WAREHOUSE', opening_cash: 5000,
      },
    ],
  });
  const business = await db.first("SELECT * FROM businesses WHERE name = 'Purge Electronics Ltd'");
  const branches = await db.all('SELECT * FROM branches WHERE business_id = ? ORDER BY code', [business.id]);
  assert.equal(branches.length, 2, 'the fixture needs two branches: a transfer between one branch and itself is refused by the schema');

  // ONE ROW IN EVERY TABLE, so the cleanup meets a database that looks like a working
  // shop rather than an empty one — the same fixture the engine tests use, for the
  // same reason.
  const seed = await seedEverything(db, { businessId: business.id, branchId: branches[0].id, secondBranchId: branches[1].id });
  assert.equal(seed.failures.length, 0, seed.failures.join('; '));
  const productsBefore = Number((await db.first('SELECT COUNT(*) AS c FROM products WHERE business_id = ?', [business.id])).c);
  assert.ok(productsBefore > 0, 'the fixture must leave something to remove');
  await db.close();

  child = spawn(process.execPath, [path.join(ROOT, 'server/app.js'), `--port=${PORT}`, `--db=${DB_FILE}`], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch (e) { /* not up yet */ }
  }
  t.after(async () => {
    if (child) { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 200)); }
  });
  assert.ok(up, `server did not start.\n${serverLog.slice(-2000)}`);

  const tokens = {};
  for (const [who, username, pin] of [
    ['owner', 'pg-owner', '11111'], ['manager', 'pg-manager', '22222'],
    ['staff', 'pg-staff', '33333'], ['admin', 'pg-admin', '99999'],
  ]) {
    const r = await req('POST', '/api/auth/login', { body: { username, pin } });
    assert.equal(r.status, 200, `${username} could not sign in: ${r.text.slice(0, 200)}`);
    tokens[who] = r.json.token;
  }

  // THE FIXTURE SEEDS ONE ROW IN EVERY TABLE, INCLUDING `data_cleanup_log` — so the
  // assertions are RELATIVE to what was there before the first call, not against zero.
  // A test that asserts zero on a seeded database fails for the fixture's reasons
  // rather than the code's.
  const logCount = async () => {
    const db2 = openDatabase({ file: DB_FILE });
    const row = await db2.first('SELECT COUNT(*) AS c FROM data_cleanup_log');
    await db2.close();
    return Number(row.c);
  };
  const dbCount = async (sql, params = []) => {
    const db2 = openDatabase({ file: DB_FILE });
    const row = await db2.first(sql, params);
    await db2.close();
    return row;
  };

  const logBefore = await logCount();
  assert.equal(logBefore, 1, 'the fixture seeds exactly one cleanup-log row; the baselines below count relative to it');

  // -------------------------------------------------------------------
  await t.test('a manager and a cashier are refused; the owner is not', async () => {
    for (const who of ['manager', 'staff']) {
      const preview = await req('POST', '/api/data-management/purge/preview', { token: tokens[who], body: { mode: ALL } });
      assert.equal(preview.status, 403, `${who} could preview a cleanup`);
      assert.equal(preview.json.code, 'ROLE_REQUIRED');
      const run = await req('POST', '/api/data-management/purge', { token: tokens[who], body: { mode: ALL, phrase: ALL_PHRASE, export_confirmed: true, retention_acknowledged: true } });
      assert.equal(run.status, 403, `${who} could run a cleanup`);
      assert.equal(run.json.code, 'ROLE_REQUIRED');
    }
    const owner = await req('POST', '/api/data-management/purge/preview', { token: tokens.owner, body: { mode: ALL } });
    assert.equal(owner.status, 200, owner.text.slice(0, 300));
    assert.ok(owner.json.total > 0, 'the owner previewed a cleanup that would remove nothing, on a seeded database');
  });

  // -------------------------------------------------------------------
  await t.test('the phrase is demanded exactly, and the refusal names it', async () => {
    const lower = await req('POST', '/api/data-management/purge', {
      token: tokens.owner,
      body: { mode: ALL, phrase: ALL_PHRASE.toLowerCase(), export_confirmed: true, retention_acknowledged: true },
    });
    assert.equal(lower.status, 428, 'a phrase in the wrong case was accepted');
    assert.equal(lower.json.code, 'PHRASE_REQUIRED');
    assert.equal(lower.json.fields.expected_phrase, ALL_PHRASE, 'the refusal must say the phrase, or it is a maze');
    assert.equal(await logCount(), logBefore, 'a refused cleanup wrote a cleanup-log entry');
  });

  // -------------------------------------------------------------------
  await t.test('the declaration of an export is demanded, and a refusal never writes the log', async () => {
    const missing = await req('POST', '/api/data-management/purge', {
      token: tokens.owner,
      body: { mode: ALL, phrase: ALL_PHRASE, retention_acknowledged: true },
    });
    assert.equal(missing.status, 428, 'a cleanup ran without the export declaration');
    assert.equal(missing.json.code, 'CONFIRMATION_REQUIRED');
    assert.equal(await logCount(), logBefore, 'a refused cleanup wrote a cleanup-log entry');
  });

  // -------------------------------------------------------------------
  await t.test('the preview counts and deletes nothing', async () => {
    const before = await dbCount('SELECT COUNT(*) AS c FROM products WHERE business_id = ?', [business.id]);
    const preview = await req('POST', '/api/data-management/purge/preview', { token: tokens.owner, body: { mode: ALL } });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.dry_run, true);
    assert.equal(preview.json.would_remove.products, Number(before.c),
      'the preview and the products table disagree, so the preview is not counting what the run would remove');
    const after = await dbCount('SELECT COUNT(*) AS c FROM products WHERE business_id = ?', [business.id]);
    assert.equal(Number(after.c), Number(before.c), 'the preview deleted rows');
    assert.equal(await logCount(), logBefore, 'the preview wrote a cleanup-log entry');
  });

  // -------------------------------------------------------------------
  await t.test('the period mode needs a period, and a backwards one is refused', async () => {
    const noDates = await req('POST', '/api/data-management/purge/preview', { token: tokens.owner, body: { mode: 'PERIOD' } });
    // The preview counts with no window at all for a dated mode, which is honest:
    // it is a count, not a deletion. The RUN is where the period becomes mandatory.
    assert.equal(noDates.status, 200, noDates.text.slice(0, 200));

    const run = await req('POST', '/api/data-management/purge', {
      token: tokens.owner,
      body: { mode: 'PERIOD', phrase: 'DELETE SELECTED PERIOD', export_confirmed: true, retention_acknowledged: true },
    });
    assert.equal(run.status, 400, 'a period cleanup ran with no period');
    assert.equal(run.json.code, 'DATES_REQUIRED');

    const backwards = await req('POST', '/api/data-management/purge', {
      token: tokens.owner,
      body: { mode: 'PERIOD', phrase: 'DELETE SELECTED PERIOD', export_confirmed: true, retention_acknowledged: true, start_date: '2026-03-01', end_date: '2026-02-01' },
    });
    assert.equal(backwards.status, 400);
    assert.equal(backwards.json.code, 'INVALID_PERIOD');
    assert.equal(await logCount(), logBefore);
  });

  // -------------------------------------------------------------------
  await t.test('a full cleanup removes, logs, audits and reports what survived', async () => {
    const run = await req('POST', '/api/data-management/purge', {
      token: tokens.owner,
      body: { mode: ALL, phrase: ALL_PHRASE, export_confirmed: true, retention_acknowledged: true },
    });
    assert.equal(run.status, 200, run.text.slice(0, 400));
    assert.equal(run.json.ok, true, 'the cleanup reported a failure');
    assert.deepEqual(run.json.failed, [], run.json.failed.map((f) => `${f.table}: ${f.error}`).join('; '));
    assert.ok(run.json.total > 0, 'a cleanup on a seeded database removed nothing');

    const left = await dbCount('SELECT COUNT(*) AS c FROM products WHERE business_id = ?', [business.id]);
    assert.equal(Number(left.c), 0, 'products survived a full business clear');

    // WHAT THE SHOP IS LEFT WITH, counted after the fact.
    const continuity = run.json.continuity || {};
    for (const key of ['stock_batches', 'stock_base_units', 'stocked_products', 'team_seats_remaining']) {
      assert.equal(typeof continuity[key], 'number', `the cleanup did not report ${key}`);
    }

    const logged = await dbCount('SELECT * FROM data_cleanup_log ORDER BY created_at DESC LIMIT 1');
    assert.ok(logged && logged.id, 'the cleanup was not written to the cleanup log');
    assert.equal(logged.mode, ALL);
    assert.equal(logged.initiated_by_username, 'pg-owner');
    const summary = JSON.parse(logged.deleted_summary_json);
    assert.equal(summary.total, run.json.total, 'the log and the answer disagree about how much was removed');
    assert.ok(summary.continuity, 'the log kept no record of what survived');

    const audit = await dbCount("SELECT * FROM audit_log WHERE action = 'DATA_CLEANUP_RUN' ORDER BY created_at DESC LIMIT 1");
    assert.ok(audit && audit.id, 'the cleanup was not written to the audit trail');
    const after = JSON.parse(audit.after_json || '{}');
    assert.equal(after.mode, ALL);
    assert.equal(after.phrase_confirmed, ALL_PHRASE, 'the audit trail did not record what the operator typed');
    assert.equal(after.export_confirmed, true);
  });

  // -------------------------------------------------------------------
  await t.test('a queued operation dated before a cleanup is quarantined, and one dated after it is not', async () => {
    // THE TWO-WAY PROBE THIS FEATURE LIVES OR DIES BY.
    //
    // A device that was offline while a cleanup ran is holding operations describing a
    // shop that no longer exists. Applying them would re-create rows the owner deleted
    // — days later, from a queue nobody is watching, in a shape that looks exactly
    // like ordinary trade in the audit trail.
    //
    // The cleanup is recorded directly rather than run, ON PURPOSE: this test is about
    // what happens to the QUEUE afterwards, and running a real purge first would make
    // the failure impossible to read.
    // TIMES RELATIVE TO THE SERVER'S CLOCK, not to a written-down date. The first
    // version of this test hard-coded the afternoon of a day whose morning it was
    // running in, and the sale engine — correctly — refused the "fresh" replay for
    // being in the future. A test that has to be told what time it is has a bug.
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
    const watermark = iso(2 * 3600 * 1000);        // a cleanup two hours ago
    const staleAt = iso(3 * 3600 * 1000);          // queued three hours ago → before it
    // THE BOUNDARY IS "AFTER THE MOST RECENT CLEANUP", AND THE SUBTESTS ABOVE HAVE JUST
    // WRITTEN ONE. So the fresh stamp is a few seconds AHEAD of now rather than a minute
    // behind it: the last cleanup row in the log was written a moment ago, and an
    // operation one minute old is — correctly — still stale against it. The sale engine
    // tolerates ten minutes of clock skew, so this lands in the ordinary replay path and
    // is refused for its own (nonsense) product, which is not what is being tested here.
    const freshAt = iso(-5 * 1000);
    const dbx = openDatabase({ file: DB_FILE });
    await dbx.run(`INSERT INTO data_cleanup_log (mode, initiated_by, initiated_by_username, deleted_summary_json, created_at)
                   VALUES ('ALL_BUSINESS_DATA', ?, 'pg-owner', '{\"test\":true}', ?)`, [newId(), watermark]);
    const salesBefore = Number((await dbx.first('SELECT COUNT(*) AS c FROM sales')).c);
    await dbx.close();

    const stale = {
      type: 'SALE', client_id: 'queued-stale-1', idempotency_key: 'queued-stale-1',
      occurred_at: staleAt,
      payload: { branch_id: branches[0].id, items: [{ product_id: 'anything', quantity: 1, unit_price: 100 }], payment_method: 'CASH' },
    };
    const push = await req('POST', '/api/sync/push', {
      token: tokens.owner,
      body: { device_id: 'purge-http-device', operations: [stale], mutations: [] },
    });
    assert.equal(push.status, 200, push.text.slice(0, 300));
    assert.equal(push.json.quarantined, 1, `the stale replay was not quarantined: ${push.text.slice(0, 300)}`);
    const entry = (push.json.results.operations || [])[0] || {};
    assert.equal(entry.status, 'QUARANTINED');
    assert.equal(entry.code, 'STALE_AFTER_CLEANUP');
    assert.ok(/cleanup/i.test(entry.message), 'the device is not told why its queued sale was refused');

    const stored = await dbCount("SELECT * FROM sync_conflicts WHERE table_name = 'offline_queue' ORDER BY detected_at DESC LIMIT 1");
    assert.ok(stored && stored.id, 'the quarantined operation was discarded instead of stored for a manager to review');
    assert.ok(/queued-stale-1/.test(stored.row_id), 'the stored conflict does not identify the queued operation');
    const kept = JSON.parse(stored.losing_version_json);
    assert.equal(kept.type, 'SALE', 'the device\'s own operation was not preserved');
    const salesAfter = await dbCount('SELECT COUNT(*) AS c FROM sales');
    assert.equal(Number(salesAfter.c), salesBefore, 'the quarantined replay was applied anyway — it re-created trading data after a cleanup');

    // AND THE OTHER DIRECTION: an operation dated AFTER the cleanup is not quarantined.
    // It is replayed like any other queue item, which is what makes this a boundary
    // rather than a blanket refusal of everything offline.
    const fresh = Object.assign({}, stale, {
      client_id: 'queued-fresh-1', idempotency_key: 'queued-fresh-1', occurred_at: freshAt,
    });
    const push2 = await req('POST', '/api/sync/push', {
      token: tokens.owner,
      body: { device_id: 'purge-http-device', operations: [fresh], mutations: [] },
    });
    // 200 OR 207 — the operation is deliberately nonsense (a product that does not
    // exist), so the sale engine refusing it is the expected outcome and 207 is the
    // honest answer. What is being asserted is what did NOT happen to it.
    assert.ok(push2.status === 200 || push2.status === 207, push2.text.slice(0, 300));
    assert.equal(push2.json.quarantined, 0, 'an operation dated after the cleanup was quarantined');
    const entry2 = (push2.json.results.operations || [])[0] || {};
    assert.notEqual(entry2.status, 'QUARANTINED', 'a fresh replay was quarantined as if it were stale');
  });

  await t.test('the platform administrator may act, and the run is attributed to their seat', async () => {
    // THE VENDOR'S SEAT IS DELIBERATELY INCLUDED. It is the seat that has to be able
    // to help a client who can no longer help themselves — a proprietor who has lost
    // their PIN, a business whose data must go at the client's written request. What
    // makes that safe is not exclusion but ATTRIBUTION: the run names the seat that
    // ran it, in the cleanup log and the audit trail, so a platform cleanup is never
    // indistinguishable from the client's own.
    const before = await logCount();
    const run = await req('POST', '/api/data-management/purge', {
      token: tokens.admin,
      body: { mode: 'CLEAR_OPERATIONAL_KEEP_ACCOUNTING', phrase: 'CLEAR OPERATIONS KEEP ACCOUNTING', export_confirmed: true, retention_acknowledged: true },
    });
    assert.equal(run.status, 200, run.text.slice(0, 300));
    assert.equal(run.json.ok, true);
    // THE ROW FOR THIS MODE, not simply the newest one: this test file records a
    // cleanup of its own above (the quarantine watermark), and "newest row" then
    // answers with the wrong run — which is the kind of test bug that quietly
    // asserts nothing.
    const logged = await dbCount("SELECT * FROM data_cleanup_log WHERE mode = 'CLEAR_OPERATIONAL_KEEP_ACCOUNTING' ORDER BY rowid DESC LIMIT 1");
    assert.equal(logged.initiated_by_username, 'pg-admin', 'a platform cleanup was not attributed to the platform seat');
    assert.equal(await logCount(), before + 1, 'the run was not written to the cleanup log exactly once');
  });
});
