'use strict';
// =====================================================================
// test/integration/platform-admin.test.js — THE PLAN IS NOT THE CLIENT'S TO WRITE
// =====================================================================
// Two defects, both invisible from a screen and both worth money.
//
//   1. THE CLIENT COULD REWRITE THEIR OWN COMMERCIAL TERMS. `PUT /api/settings` is
//      guarded by `atLeast(user.role, 'OWNER')`, and the six settings that decide
//      what the client has bought — the three caps, the plan name, the subscription
//      status, the renewal date — were writable through it like any other column. An
//      owner could raise their own branch cap, rename their plan, set their own
//      status back to ACTIVE after a suspension, or move their renewal date, with a
//      queued offline write if a plain call was too visible. The screen hid the
//      inputs ("commercial: … not by the client") while the API accepted the keys.
//      Hiding a field is not a permission.
//
//   2. THE VENDOR'S OWN BYPASS COULD NEVER FIRE. `assertSubscriptionActive` returns
//      early for ADMIN — "the vendor can never be locked out of their own client's
//      instance, including while helping that client resolve the very suspension in
//      question" — and all three call sites passed only `settings`, so `user` was
//      undefined and a suspended client could not even be helped by the person they
//      had just telephoned.
//
// This file also pins the two readings the plan screen depends on: **0 means
// unlimited** (the screen has always said so; the server used to read it as "none"),
// and the plan name is quoted in the refusal a client sees.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { createHttpApp } = require('../../server/app');
const { buildSeedSql } = require('../../tools/d1-seed');

const ADMIN_PIN = '90210';
const OWNER_PIN = '48213';
let counter = 0;

/**
 * One deployment with an administrator, one business, one branch and one owner —
 * all created through the real HTTP surface, because the point of these tests is the
 * seam between the route and the rule.
 */
async function withDeployment(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-planadmin-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    await db.exec((await buildSeedSql({ username: 'admin', pin: ADMIN_PIN, businessName: null, adminName: 'Vendor Admin' })).sql);
    const app = createHttpApp({ db, jwtSecret: 'platform-admin-test-secret-long-enough', settings: {} });

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
    const login = async (username, pin) => {
      const res = await call('POST', '/api/auth/login', { body: { username, pin } });
      if (res.status !== 200) throw new Error(`login as ${username} failed: ${res.status} ${res.text.slice(0, 200)}`);
      return res.json.token;
    };

    const adminToken = await login('admin', ADMIN_PIN);
    const created = await call('POST', '/api/businesses', {
      token: adminToken,
      body: {
        name: 'Plan Audit Stores', profile_code: 'ELECTRONICS', vat_registered: true,
        branch: { name: 'Plan Audit Branch', city: 'Abuja', state: 'FCT', opening_cash: 0 },
      },
    });
    if (created.status !== 201) throw new Error(`business creation failed: ${created.status} ${created.text.slice(0, 300)}`);
    const businessId = created.json.id;
    const branchId = created.json.branch_id;

    const ownerCreated = await call('POST', '/api/users', {
      token: adminToken,
      body: { full_name: 'Plan Owner', username: 'plan-owner', role: 'OWNER', pin: OWNER_PIN, confirm_pin: OWNER_PIN, branch_id: branchId },
    });
    if (ownerCreated.status !== 201) throw new Error(`owner creation failed: ${ownerCreated.status} ${ownerCreated.text.slice(0, 300)}`);
    const ownerToken = await login('plan-owner', OWNER_PIN);

    return await fn({ db, app, call, adminToken, ownerToken, businessId, branchId });
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  }
}

test('the plan belongs to the platform administrator, and the caps actually bind', async (t) => {
  await withDeployment(async ({ call, adminToken, ownerToken, businessId, branchId }) => {
    const putSettings = (token, body) => call('PUT', '/api/settings', { token, body });
    const settings = (token) => call('GET', '/api/settings', { token });

    await t.test('an owner cannot raise their own ceiling', async () => {
      for (const field of ['max_branches', 'max_staff', 'max_businesses', 'subscription_plan']) {
        const res = await putSettings(ownerToken, { [field]: 99 });
        assert.equal(res.status, 403, `an owner was allowed to write ${field}`);
        assert.equal(res.json.code, 'PLATFORM_ADMIN_REQUIRED');
        assert.deepEqual(Object.keys(res.json.fields || {}), [field], 'the refusal must name the field it refused');
      }
      const status = await putSettings(ownerToken, { subscription_status: 'ACTIVE' });
      assert.equal(status.status, 403, 'an owner set their own subscription status');
      const after = await settings(ownerToken);
      assert.equal(after.json.settings.max_branches, 5, 'the refused write must not have landed');
    });

    await t.test('an owner can still change their own business settings', async () => {
      // The guard has to be narrow. If this fails, the plan rule has been tightened
      // into "owners cannot configure their shop", which is not the rule.
      const res = await putSettings(ownerToken, { receipt_footer_text: 'Thank you — Plan Audit Stores' });
      assert.equal(res.status, 200, `an owner could not set the receipt footer: ${res.text.slice(0, 200)}`);
    });

    await t.test('the administrator sets a cap, and the client cannot exceed it', async () => {
      const lowered = await putSettings(adminToken, { max_branches: 1 });
      assert.equal(lowered.status, 200, `the administrator could not set the branch cap: ${lowered.text.slice(0, 200)}`);
      assert.equal(lowered.json.settings.max_branches, 1);

      // One branch exists. The second must be refused, and the refusal has to be
      // usable: the number, the plan name and who to ask.
      const second = await call('POST', '/api/branches', {
        token: ownerToken,
        body: { business_id: businessId, name: 'Second Branch', city: 'Abuja', state: 'FCT' },
      });
      assert.equal(second.status, 402, `a branch was created past the cap: ${second.status} ${second.text.slice(0, 200)}`);
      assert.equal(second.json.code, 'MAX_BRANCHES_REACHED');
      assert.match(second.json.error, /1 branch/, 'the refusal must name the cap the administrator set');
      assert.match(second.json.error, /Standard/, 'the refusal must name the plan');
    });

    await t.test('a cap of zero means unlimited — the reading the plan screen has always shown', async () => {
      const unlimited = await putSettings(adminToken, { max_branches: 0 });
      assert.equal(unlimited.status, 200);
      const second = await call('POST', '/api/branches', {
        token: ownerToken,
        body: { business_id: businessId, name: 'Second Branch', city: 'Abuja', state: 'FCT' },
      });
      assert.equal(second.status, 201, `0 branches should mean unlimited, not none: ${second.status} ${second.text.slice(0, 200)}`);
      const usage = await call('GET', '/api/plan', { token: ownerToken });
      assert.equal(usage.status, 200);
      assert.equal(usage.json.usage.branches.unlimited, true, 'the usage should say the branch cap is unlimited');
      assert.equal(usage.json.usage.branches.remaining, null, 'an unlimited cap has no remainder');
    });

    await t.test('a cap below what is in use lands, and says so', async () => {
      // Two branches exist. Setting 1 must not silently trap anyone: it succeeds and
      // the response carries the consequence.
      const res = await putSettings(adminToken, { max_branches: 1 });
      assert.equal(res.status, 200);
      assert.ok((res.json.warnings || []).some((w) => /already in use/.test(w)),
        `a cap below current usage must warn, got ${JSON.stringify(res.json.warnings)}`);
      const usage = await call('GET', '/api/plan', { token: ownerToken });
      assert.equal(usage.json.usage.branches.used, 2, 'nothing is removed by lowering a cap');
    });

    await t.test('the plan name the administrator sets is the one the client is shown', async () => {
      const renamed = await putSettings(adminToken, { subscription_plan: 'Growth 2026' });
      assert.equal(renamed.status, 200);
      await putSettings(adminToken, { max_branches: 1 });
      const refused = await call('POST', '/api/branches', {
        token: ownerToken,
        body: { business_id: businessId, name: 'Third Branch', city: 'Abuja', state: 'FCT' },
      });
      assert.equal(refused.status, 402);
      assert.match(refused.json.error, /Growth 2026/, 'the refusal must quote the current plan name');
    });
  });
});

test('a suspension means something, and never locks the vendor out', async (t) => {
  await withDeployment(async ({ call, adminToken, ownerToken, businessId, branchId }) => {
    const put = (token, body) => call('PUT', '/api/settings', { token, body });

    await t.test('the vendor can still work on a suspended account', async () => {
      const suspended = await put(adminToken, { subscription_status: 'SUSPENDED' });
      assert.equal(suspended.status, 200, `the administrator could not suspend: ${suspended.text.slice(0, 200)}`);

      // The client's new branch is refused…
      const clientBranch = await call('POST', '/api/branches', {
        token: ownerToken,
        body: { business_id: businessId, name: 'While Suspended', city: 'Abuja', state: 'FCT' },
      });
      assert.equal(clientBranch.status, 402, 'a suspended client created a branch');
      assert.equal(clientBranch.json.code, 'SUBSCRIPTION_NOT_ACTIVE');

      // …and the vendor's is not. This is the bypass that was written and never wired.
      const vendorBranch = await call('POST', '/api/branches', {
        token: adminToken,
        body: { business_id: businessId, name: 'Vendor Recovery Branch', city: 'Abuja', state: 'FCT' },
      });
      assert.equal(vendorBranch.status, 201,
        `the platform administrator was locked out of their own client's instance: ${vendorBranch.status} ${vendorBranch.text.slice(0, 200)}`);
    });

    await t.test('reading and exporting still work while suspended', async () => {
      // The whole point of the gate: a shop that has not paid can still get its books
      // out. A client locked away from their own data does not pay, they leave.
      const plan = await call('GET', '/api/plan', { token: ownerToken });
      assert.equal(plan.status, 200, 'a suspended client must still be able to read their plan');
      const sales = await call('GET', '/api/reports/sales?group_by=DAY&days=7', { token: ownerToken });
      assert.equal(sales.status, 200, 'a suspended client must still be able to read their reports');
      const audit = await call('GET', '/api/audit?limit=5', { token: adminToken });
      assert.equal(audit.status, 200, 'the audit trail must be readable while suspended');
    });

    await t.test('reinstating restores the client immediately', async () => {
      const active = await put(adminToken, { subscription_status: 'ACTIVE' });
      assert.equal(active.status, 200);
      const branch = await call('POST', '/api/branches', {
        token: ownerToken,
        body: { business_id: businessId, name: 'After Reinstatement', city: 'Abuja', state: 'FCT' },
      });
      assert.equal(branch.status, 201, `a reinstated client still could not create: ${branch.status} ${branch.text.slice(0, 200)}`);
    });

    await t.test('a typo in the status cannot silently suspend a whole client', async () => {
      const typo = await put(adminToken, { subscription_status: 'SUSPENDEDD' });
      assert.equal(typo.status, 400, 'an invalid status must be refused, not stored');
      assert.equal(typo.json.code, 'INVALID_SUBSCRIPTION_STATUS');
      const check = await call('GET', '/api/plan', { token: ownerToken });
      assert.equal(check.json.settings.status, 'ACTIVE', 'the refused status must not have landed');
    });

    await t.test('a renewal date is a date, or nothing', async () => {
      const bad = await put(adminToken, { subscription_renewal_date: 'next Tuesday' });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.code, 'INVALID_DATE');
      const good = await put(adminToken, { subscription_renewal_date: '2026-12-31' });
      assert.equal(good.status, 200);
      assert.equal(good.json.settings.subscription_renewal_date, '2026-12-31');
      const cleared = await put(adminToken, { subscription_renewal_date: '' });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.json.settings.subscription_renewal_date, null, 'clearing a date must store null, not an empty string');
    });

    await t.test('a plan needs a name, because the name is printed at a client', async () => {
      const blank = await put(adminToken, { subscription_plan: '   ' });
      assert.equal(blank.status, 400);
      assert.equal(blank.json.code, 'PLAN_NAME_REQUIRED');
    });
  });
});

test('a plan change is in the audit trail as a plan change', async (t) => {
  await withDeployment(async ({ call, adminToken, ownerToken }) => {
    await call('PUT', '/api/settings', { token: adminToken, body: { max_staff: 7 } });
    await call('PUT', '/api/settings', { token: ownerToken, body: { receipt_footer_text: 'Plan Audit' } });

    const trail = await call('GET', '/api/audit?limit=50', { token: adminToken });
    assert.equal(trail.status, 200, `the audit trail answered ${trail.status}`);
    const rows = trail.json.data || trail.json.rows || [];
    const planRow = rows.find((r) => r.action === 'PLAN_LIMITS_CHANGED');
    assert.ok(planRow, `no PLAN_LIMITS_CHANGED row in ${rows.map((r) => r.action).join(', ')}`);
    // The audit row carries before_json / after_json — the columns are the source of
    // truth for the diff, and the action is what makes the plan change findable.
    assert.match(String(planRow.after_json || ''), /"max_staff":7/, 'the plan change must record what it became');
    assert.match(String(planRow.before_json || ''), /"max_staff":25/, 'and what it was');

    // And the ordinary settings write is still recorded as one — the split is a
    // classification, not a replacement.
    assert.ok(rows.some((r) => r.action === 'SETTINGS_UPDATED'), 'an ordinary settings write is still a SETTINGS_UPDATED');

    // The chain is meant to still verify after all of this.
    const verify = await call('GET', '/api/audit/verify', { token: adminToken });
    assert.equal(verify.status, 200);
    assert.equal(verify.json.ok, true, `the audit chain broke: ${verify.text.slice(0, 200)}`);
  });
});
