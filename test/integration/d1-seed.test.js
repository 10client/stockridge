'use strict';
// =====================================================================
// test/integration/d1-seed.test.js — THE CLOUDFLARE SEED, CHECKED BEFORE DEPLOY
// =====================================================================
// tools/d1-seed.js emits SQL as text. Everything about that text is invisible
// until it reaches a real D1 database on a real account — a quoting mistake, a
// column that does not exist, a NOT NULL without a value. Discovering it from a
// failed deploy, with a half-seeded production database, is the worst possible
// way to find out.
//
// So the SQL is executed here against a local SQLite built from the SAME
// migrations, and the result is asserted: one administrator, no businesses, the
// withholding schedule, and — because deploys get retried — idempotent.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { buildSeedSql } = require('../../tools/d1-seed');
const { verifyPin } = require('../../domain/crypto');

let counter = 0;

async function withDb(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-d1seed-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  await migrate(db);
  try {
    return await fn(db);
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  }
}

test('the D1 seed SQL applies to a fresh schema and leaves exactly one administrator', async () => {
  await withDb(async (db) => {
    const seed = await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'StockRidge Platform Administrator' });

    // A single exec() of the whole file is what `wrangler d1 execute --file`
    // effectively does: statement after statement, in order.
    await db.exec(seed.sql);

    const users = await db.all('SELECT username, role, business_id, branch_id, is_active FROM users WHERE is_deleted = 0');
    assert.equal(users.length, 1, `a seeded deployment must have exactly one user, found ${users.length}`);
    assert.equal(users[0].role, 'ADMIN');
    assert.equal(users[0].username, 'admin');
    assert.equal(users[0].business_id, null, 'the platform administrator must not belong to a client business');
    assert.equal(users[0].branch_id, null);
    assert.equal(Number(users[0].is_active), 1);

    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM businesses WHERE is_deleted = 0')), 0, 'no demo business');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM products WHERE is_deleted = 0')), 0, 'no demo catalogue');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM sales')), 0, 'no demo sales');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM branches WHERE is_deleted = 0')), 0, 'no demo branch');

    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM client_settings')), 1, 'the settings row must exist');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM wht_rates')), seed.rateCount, 'the withholding schedule must be seeded');
    assert.equal(seed.rateCount, 10);
    const supply = await db.first("SELECT rate_percent FROM wht_rates WHERE code = 'SUPPLY_OF_GOODS'");
    assert.equal(Number(supply.rate_percent), 2, 'the 2024 Regulations reduced supply of goods to 2%');
  });
});

test('the PIN in the seed SQL is the PIN that signs in', async () => {
  await withDb(async (db) => {
    const seed = await buildSeedSql({ username: 'admin', pin: '73914', businessName: null, adminName: 'Vendor Administrator' });
    await db.exec(seed.sql);

    const row = await db.first("SELECT pin_hash FROM users WHERE username = 'admin'");
    assert.ok(row && row.pin_hash, 'the administrator must have a PIN hash');

    // verifyPin() returns a BOOLEAN, not a result object. Asserting `good.ok !==
    // false` passed on `undefined` — a test that would have gone green on a
    // verifyPin that returned nothing at all.
    assert.equal(await verifyPin('73914', row.pin_hash), true, 'the seeded PIN must verify');
    assert.equal(await verifyPin('73915', row.pin_hash), false, 'a wrong PIN must not verify');
  });
});

test('running the seed twice changes nothing and never resets a PIN', async () => {
  await withDb(async (db) => {
    const first = await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'A' });
    await db.exec(first.sql);
    const before = await db.first("SELECT id, pin_hash FROM users WHERE username = 'admin'");

    // A second run, with a DIFFERENT pin: a deploy that retries must not hand a
    // new PIN to somebody who has already changed theirs.
    const second = await buildSeedSql({ username: 'admin', pin: '99999', businessName: null, adminName: 'B' });
    await db.exec(second.sql);

    const after = await db.first("SELECT id, pin_hash FROM users WHERE username = 'admin'");
    assert.equal(String(after.id), String(before.id), 'the administrator must not be duplicated');
    assert.equal(after.pin_hash, before.pin_hash, 'a re-run must not reset the PIN');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM users')), 1);
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM wht_rates')), first.rateCount, 'rates must not be duplicated');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM client_settings')), 1);
  });
});

test('a freshly seeded deployment can create its first business', async () => {
  // The point of the whole arrangement: an empty deployment must be USABLE. If
  // the administrator cannot create a business, "one admin account and nothing
  // else" is not a fresh start, it is a dead end.
  const { createHttpApp } = require('../../server/app');
  const { getSettings } = require('../../domain/planLimits');

  await withDb(async (db) => {
    const seed = await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'Vendor Administrator' });
    await db.exec(seed.sql);

    const app = createHttpApp({ db, jwtSecret: 'seed-test-secret', settings: await getSettings(db) });
    const call = async (method, url, { token, body } = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await app.fetch(new Request(`http://local${url}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      }));
      return { status: res.status, json: JSON.parse((await res.text()) || '{}') };
    };

    const login = await call('POST', '/api/auth/login', { body: { username: 'admin', pin: '48213' } });
    assert.equal(login.status, 200, `the seeded administrator must be able to sign in: ${JSON.stringify(login.json).slice(0, 200)}`);

    const created = await call('POST', '/api/businesses', {
      token: login.json.token,
      body: {
        name: 'Client Trading Company',
        profile_code: 'BUILDING_MATERIALS',
        vat_registered: true,
        branch: { name: 'First Branch', city: 'Aba', state: 'Abia', opening_cash: 0 },
      },
    });
    assert.equal(created.status, 201, `the client's first business must be creatable: ${JSON.stringify(created.json).slice(0, 300)}`);

    const products = await db.scalar('SELECT COUNT(*) FROM products WHERE business_id = ? AND is_deleted = 0', [String(created.json.id)]);
    assert.ok(Number(products) > 0, 'provisioning must build a starter catalogue for the chosen vertical');
  });
});

test('the seeded hash uses the iteration count every runtime can compute', async () => {
  // THE DEPLOYMENT-BREAKING ONE.
  //
  // The Workers WebCrypto implementation REFUSES a PBKDF2 iteration count above
  // 100,000, and it refuses by throwing — which verifyPin turns into `false`.
  // A seed written at 120,000 iterations therefore produced a deployment where
  // the schema, the administrator row and the hash format were all correct, and
  // every sign-in answered 401. On Node the same hash verified perfectly, so
  // every local test passed.
  //
  // Two assertions guard it: the count in the emitted SQL is the shared
  // constant, and the constant is inside the platform ceiling on both runtimes.
  const { PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS } = require('../../domain/crypto');

  assert.ok(
    PBKDF2_ITERATIONS <= 100000,
    `PBKDF2_ITERATIONS is ${PBKDF2_ITERATIONS}; the Cloudflare Workers WebCrypto implementation refuses anything above 100000, `
    + 'so any hash written above it can never be verified by the deployed Worker',
  );
  assert.equal(PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS, 'hashing must use the platform ceiling, not a separate lower value');

  await withDb(async (db) => {
    const seed = await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'A' });
    await db.exec(seed.sql);

    const row = await db.first("SELECT pin_hash FROM users WHERE username = 'admin'");
    const parts = String(row.pin_hash).split('$');
    assert.equal(parts.length, 5, 'the stored format is pbkdf2$sha256$iterations$salt$hash');
    assert.equal(Number(parts[2]), PBKDF2_ITERATIONS, 'the stored hash must carry the shared iteration count');
    assert.ok(!/\$120000\$/.test(seed.sql), 'the seed SQL must not contain a hard-coded 120000 iteration count');
  });
});

test('--reset rewrites the administrator PIN without duplicating the row', async () => {
  // Needed for real deployments, not just for tests: a hash written by a runtime
  // the deployment cannot verify has to be replaceable, and a business whose only
  // administrator has lost their PIN has to have a way back in.
  await withDb(async (db) => {
    const first = await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'A' });
    await db.exec(first.sql);
    const original = await db.first("SELECT id, pin_hash FROM users WHERE username = 'admin'");

    // Pretend the administrator changed their PIN in the app.
    await db.run("UPDATE users SET pin_hash = 'pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$" + '0'.repeat(64) + "' WHERE username = 'admin'");

    // A plain re-run must leave that alone.
    await db.exec((await buildSeedSql({ username: 'admin', pin: '99999', businessName: null, adminName: 'B' })).sql);
    const untouched = await db.first("SELECT id, pin_hash FROM users WHERE username = 'admin'");
    assert.ok(/^pbkdf2\$sha256\$100000\$AAAAAAAA/.test(untouched.pin_hash), 'sanity: the PIN changed in the app is still the changed one');
    assert.equal(String(untouched.id), String(original.id), 'a plain re-run must not duplicate the administrator');

    // --reset DOES rewrite it.
    await db.exec((await buildSeedSql({ username: 'admin', pin: '55555', businessName: null, adminName: 'B', reset: true })).sql);
    const reset = await db.first("SELECT id, pin_hash FROM users WHERE username = 'admin'");
    assert.equal(String(reset.id), String(original.id), 'reset must update the row, not insert a second one');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM users')), 1, 'still exactly one user');
    assert.equal(await verifyPin('55555', reset.pin_hash), true, 'the reset PIN must verify');
    assert.equal(await verifyPin('48213', reset.pin_hash), false, 'the old PIN must stop working');
  });
});

test('--reset finds an administrator whose stored username differs in case', async () => {
  // The lookup is by lower(username) everywhere else in the app, so the reset
  // path must not be the one place that misses "Admin".
  await withDb(async (db) => {
    await db.run(`INSERT INTO users (id, business_id, branch_id, full_name, username, pin_hash, role, is_active, created_at, updated_at)
      VALUES ('legacyadmin', NULL, NULL, 'Legacy Admin', 'Admin', 'pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$${'0'.repeat(64)}', 'ADMIN', 1, datetime('now'), datetime('now'))`);

    await db.exec((await buildSeedSql({ username: 'admin', pin: '31337', businessName: null, adminName: 'B', reset: true })).sql);

    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM users')), 1, 'the case-different row must be updated, not joined by a second one');
    const row = await db.first("SELECT pin_hash FROM users WHERE lower(username) = 'admin'");
    assert.equal(await verifyPin('31337', row.pin_hash), true);
  });
});
