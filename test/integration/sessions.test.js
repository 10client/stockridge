'use strict';
// =====================================================================
// test/integration/sessions.test.js — SIGN-OUT HAS TO ACTUALLY SIGN YOU OUT
// =====================================================================
// THIS DEFECT WAS LIVE IN A DEPLOYED WORKER, and the whole suite was green.
//
// `authenticate` checked the session row with
// `if (session && session.session_id !== payload.sid)` — which reads as "reject a
// token whose session was replaced" and actually means "accept a token whose
// session was deleted". Sign-out deletes the row. So signing out did nothing:
// the token kept working until it expired twelve hours later, and on a shared
// till the next cashier inherited the previous one's session.
//
// It was found by `tools/verify-deployment.js`, which signs out over real HTTP
// and then asks whether the token still works. Nothing in this repository had
// ever signed out and then used the token again.
//
// The lesson generalises: an authentication check has to be tested in the
// NEGATIVE direction too. "Does a good token work?" was covered everywhere.
// "Does a revoked token stop working?" was covered nowhere.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { createHttpApp } = require('../../server/app');
const { buildSeedSql } = require('../../tools/d1-seed');

let counter = 0;

async function withDeployment(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-session-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    await db.exec((await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'Vendor Admin' })).sql);
    const app = createHttpApp({ db, jwtSecret: 'session-test-secret-long-enough', settings: {} });
    const call = async (method, url, { token, body } = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await app.fetch(new Request(`http://local${url}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      }));
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return { status: res.status, json, text };
    };
    // The business is created through the real provisioning flow rather than by
    // calling the service directly: provisioning writes rows with foreign keys to
    // the business, so a business that does not exist fails the same way it would
    // in production — which is a useful thing for a test to notice.
    const login = await call('POST', '/api/auth/login', { body: { username: 'admin', pin: '48213' } });
    const created = await call('POST', '/api/businesses', {
      token: login.json.token,
      body: {
        name: 'Session Testing Co', profile_code: 'ELECTRONICS', vat_registered: true,
        branch: { name: 'Main', city: 'Abuja', state: 'FCT', opening_cash: 0 },
      },
    });
    if (created.status !== 201) throw new Error(`provisioning failed: ${created.text.slice(0, 300)}`);
    await call('POST', '/api/auth/logout', { token: login.json.token, body: {} });

    const admin = await db.first("SELECT * FROM users WHERE username = 'admin'");
    return await fn({ db, app, call, admin, businessId: created.json.id, branchId: created.json.branch_id, file });
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  }
}

async function signIn(call, username, pin) {
  const res = await call('POST', '/api/auth/login', { body: { username, pin } });
  assert.equal(res.status, 200, `sign-in must work: ${res.text.slice(0, 200)}`);
  return res.json.token;
}

test('signing out revokes the token immediately', async () => {
  await withDeployment(async ({ call }) => {
    const token = await signIn(call, 'admin', '48213');

    const before = await call('GET', '/api/auth/me', { token });
    assert.equal(before.status, 200, 'the token works while signed in');

    const out = await call('POST', '/api/auth/logout', { token, body: {} });
    assert.equal(out.status, 200);

    // The one assertion whose absence let a live defect ship.
    const after = await call('GET', '/api/auth/me', { token });
    assert.equal(after.status, 401, `a signed-out token must be refused, got ${after.status}`);
    assert.equal(after.json.code, 'SESSION_REVOKED');

    // And the message has to make sense to a cashier, not to a developer.
    assert.match(after.json.error, /signed out/i);
  });
});

test('the session row is deleted on sign-out, not merely flagged', async () => {
  // The revocation above works because the row is GONE. If a future change marks
  // the row instead, `authenticate` must be changed with it — this test fails
  // first, which is the point of asserting the mechanism and not just the effect.
  await withDeployment(async ({ call, db, admin }) => {
    const token = await signIn(call, 'admin', '48213');
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM user_sessions WHERE user_id = ?', [String(admin.id)])), 1);

    await call('POST', '/api/auth/logout', { token, body: {} });
    assert.equal(Number(await db.scalar('SELECT COUNT(*) FROM user_sessions WHERE user_id = ?', [String(admin.id)])), 0);
  });
});

test('a token is refused when its session row disappears behind its back', async () => {
  // The same defect reached by a different road: a session deleted by something
  // other than the logout route — a restore, a manual cleanup, a pruned row.
  // The token must stop, and it must stop with a clear code.
  await withDeployment(async ({ call, db, admin }) => {
    const token = await signIn(call, 'admin', '48213');
    assert.equal((await call('GET', '/api/auth/me', { token })).status, 200);

    await db.run('DELETE FROM user_sessions WHERE user_id = ?', [String(admin.id)]);

    const after = await call('GET', '/api/auth/me', { token });
    assert.equal(after.status, 401);
    assert.equal(after.json.code, 'SESSION_REVOKED');
  });
});

test('signing in elsewhere retires the first session, and says so', async () => {
  await withDeployment(async ({ call }) => {
    const first = await signIn(call, 'admin', '48213');
    const second = await signIn(call, 'admin', '48213');

    assert.equal((await call('GET', '/api/auth/me', { token: second })).status, 200, 'the newest token works');

    const stale = await call('GET', '/api/auth/me', { token: first });
    assert.equal(stale.status, 401, 'the older token must be retired');
    assert.equal(stale.json.code, 'SESSION_SUPERSEDED');
    // A cashier who did not sign in a second time needs to know that somebody
    // else used their PIN.
    assert.match(stale.json.error, /somewhere else|PIN may be known/i);
  });
});

test('a deactivated user is refused even with a valid token', async () => {
  await withDeployment(async ({ call, db, admin }) => {
    const token = await signIn(call, 'admin', '48213');
    assert.equal((await call('GET', '/api/auth/me', { token })).status, 200);

    await db.run("UPDATE users SET is_active = 0 WHERE id = ?", [String(admin.id)]);

    const after = await call('GET', '/api/auth/me', { token });
    assert.equal(after.status, 403, 'deactivation must take effect on the next request, not at token expiry');
    assert.equal(after.json.code, 'ACCOUNT_DEACTIVATED');
  });
});
