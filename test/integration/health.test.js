'use strict';
// =====================================================================
// test/integration/health.test.js — LIVENESS AND READINESS, IN ALL THREE STATES
// =====================================================================
// /api/health/ready was written, reviewed and never opened — no test touched it
// until the first real deployment reported `503 not_ready`, which is exactly the
// moment its answer matters most. A readiness probe is the one endpoint an
// operator reads when nothing else works, so the states it can be in have to be
// tested rather than assumed:
//
//   1. A handover deployment: schema applied, one administrator, no business.
//      This is NOT a fault. It is the state every client deployment starts in.
//   2. A trading deployment: a business exists and is active.
//   3. A broken deployment: the migrations were never applied.
//
// The distinction between 1 and 3 is the whole point of the endpoint. A probe
// that answers the same thing for "waiting for the client's first business" and
// "the schema is missing" cannot be acted on.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { createHttpApp } = require('../../server/app');
const { buildSeedSql } = require('../../tools/d1-seed');
const { provisionBusiness } = require('../../server/services/provisioningService');

let counter = 0;

async function withDb(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-health-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    return await fn(db, file);
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  }
}

function appFor(db) {
  return createHttpApp({ db, jwtSecret: 'health-test-secret-that-is-long-enough', settings: {} });
}

async function get(app, url) {
  const res = await app.fetch(new Request(`http://local${url}`));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

test('health: liveness answers without touching the database', async () => {
  // The probe takes no db at all: if the process can answer, it is up. This must
  // hold even when the database is unreachable, or a database fault restarts the
  // process instead of being reported.
  const app = createHttpApp({ db: null, jwtSecret: 'x'.repeat(32), settings: {} });
  const { status, json } = await get(app, '/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.status, 'up');
  assert.equal(json.service, 'stockridge');
  assert.ok(json.time, 'the response carries West Africa Time, not a UTC instant');
});

test('health: a freshly seeded deployment is awaiting its first business, not broken', async () => {
  await withDb(async (db) => {
    await migrate(db);
    const seed = await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'Vendor Administrator' });
    await db.exec(seed.sql);

    const { status, json } = await get(appFor(db), '/api/health/ready');

    // Not ready to trade — there is no shop — but the reason is a lifecycle
    // state a human has to move, not a fault to investigate.
    assert.equal(status, 503, 'readiness must not claim a shop can trade when no business exists');
    assert.equal(json.status, 'awaiting_first_business', 'the status must name the state, not just "not_ready"');
    assert.equal(json.businesses, 0);
    assert.equal(json.database.tables > 50, true, `the schema is applied (${json.database.tables} tables)`);
    assert.ok(json.database.migrations > 0, 'the migrations are recorded');

    // The guidance has to point at the flow that actually works. The old text
    // said `npm run db:seed`, which on a handover deployment does nothing.
    const guidance = json.problems.join(' ');
    assert.match(guidance, /create one/i, 'the problem text must tell the operator what to do');
    assert.ok(!/db:seed/.test(guidance), 'a handover deployment must not be told to re-seed demo data');
  });
});

test('health: a deployment with an active business is ready, and says how big it is', async () => {
  await withDb(async (db) => {
    await migrate(db);
    await db.exec((await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'A' })).sql);
    const app = appFor(db);

    // Through the real HTTP flow, because that is what the client does on the
    // first morning: sign in as the administrator, create the business.
    const login = await app.fetch(new Request('http://local/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', pin: '48213' }),
    }));
    assert.equal(login.status, 200);
    const token = (await login.json()).token;

    const created = await app.fetch(new Request('http://local/api/businesses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Readiness Trading Co',
        profile_code: 'ELECTRONICS',
        vat_registered: true,
        branch: { name: 'Main', city: 'Abuja', state: 'FCT', opening_cash: 0 },
      }),
    }));
    assert.equal(created.status, 201, `the first business must be creatable: ${(await created.text()).slice(0, 200)}`);

    const { status, json } = await get(app, '/api/health/ready');
    assert.equal(status, 200, `a provisioned deployment must be ready: ${JSON.stringify(json.problems)}`);
    assert.equal(json.status, 'ready');
    assert.equal(json.ok, true);
    assert.equal(json.businesses, 1);
    assert.deepEqual(json.problems, []);
  });
});

test('health: an unmigrated database reports the missing schema, not a missing business', async () => {
  await withDb(async (db) => {
    // Deliberately no migrate() — the state a deployment is in when the
    // migration step was skipped or failed.
    const { status, json } = await get(appFor(db), '/api/health/ready');
    assert.equal(status, 503);
    assert.equal(json.status, 'not_ready', 'a real fault must not be reported as the first-run state');
    assert.ok(json.problems.length > 0);
    assert.equal(
      json.problems.some((p) => /schema|migration/i.test(p)),
      true,
      `the reason must name the schema or the migrations: ${JSON.stringify(json.problems)}`,
    );
  });
});
