'use strict';
// =====================================================================
// ADMIN × OWNER — the platform's hand and the tenant's hand
// =====================================================================
// The administrator exists for the things a TENANT cannot do from inside its own books:
// creating the business in the first place, adding the account that owns it, and being
// the one seat an owner can never lock out. The owner exists for everything after that:
// branches, staff, settings, prices.
//
// Both directions here are about that line. The administrator may reach into the
// tenant — and the owner may not reach up. What is finally worth proving is that
// NEITHER of them can quietly become the other: an owner who could grant themselves
// administrator rights has a deployment where the audit trail means nothing, and an
// administrator who cannot create the second owner leaves the client with one key.
// =====================================================================

const assert = require('node:assert');

function assert2(res, statuses, what) {
  const want = Array.isArray(statuses) ? statuses : [statuses];
  if (!want.includes(res.status)) {
    throw new Error(`${what} answered ${res.status} ${(res.json && (res.json.code || res.json.error)) || String(res.text).slice(0, 160)}`);
  }
}

module.exports = {
  pair: ['OWNER', 'ADMIN'],
  title: 'An administrator reaches into a tenant; a tenant cannot reach up',

  async checks(audit, ctx) {
    const { d, roster, rules } = ctx;
    const admin = roster.ADMIN;
    const owner = roster.OWNER;

    audit.section('The administrator can build inside a tenant, and the tenant sees it at once');
    const branchName = `Pair Provisioned ${Date.now().toString(36).slice(-4)}`;
    const made = await admin.post('/api/branches', {
      business_id: (ctx.targets.OWNER && ctx.targets.OWNER.business_id) || owner.businessId,
      name: branchName, code: `PAIR-PROV-${Date.now().toString(36).slice(-4).toUpperCase()}`, branch_type: 'RETAIL', city: 'Abuja', state: 'FCT',
    });
    // A PLAN LIMIT IS A SHOP STATE, NOT A DEFECT. `402 MAX_BRANCHES_REACHED` means the
    // subscription this deployment runs on has as many branches as it paid for — the
    // product refusing correctly, and the audit reporting it rather than calling it a bug.
    if (made.status === 402 || (made.json && /MAX_BRANCHES|PLAN/i.test(String(made.json.code)))) {
      audit.skip('an administrator can open a branch inside a business they do not own',
        `this deployment is at its plan's branch limit (${(made.json && made.json.code) || made.status}) — the limit is the product working, not a fault`);
    } else {
    await audit.checkAsync('an administrator can open a branch inside a business they do not own', async () => {
      assert2(made, [200, 201], 'the administrator opening a branch');
      // REGISTERED, SO THE RUN CLOSES IT AGAIN. The first live run left two branches open
      // on staging because nothing put them back, and a branch is the one row in this
      // product that cannot be deleted — only deactivated. A test that cleans up after
      // itself is a test a client will let you run against their shop.
      const madeId = made.json && (made.json.id || made.json.branch_id);
      if (madeId) ctx.openedBranches.push({ id: madeId, name: branchName });
    });
    }
    await audit.checkAsync('and the owner sees it immediately, without being told', async () => {
      const res = await owner.get('/api/branches?limit=100');
      assert2(res, 200, 'the owner reading branches');
      const rows = rules.rowsOf(res);
      assert(rows.some((b) => String(b.name) === branchName),
        `the owner cannot see "${branchName}", which the administrator just created in their business — a branch nobody at the shop can see is a branch nobody will staff`);
      audit.note(`the tenant went from ${ctx.d.branches.length} to ${rows.length} branches, and the owner's own screen is where the change lands`);
    });

    audit.section('A tenant cannot mint itself a platform');
    await rules.expectRule(audit, {
      what: 'an owner cannot create a second business (that is the platform\'s job)',
      allow: false,
      refusalSpeaks: /administrator|admin|only/i,
      act: () => owner.post('/api/businesses', { name: `Pair Tenant ${Date.now().toString(36).slice(-4)}`, profile_code: 'ELECTRONICS' }),
    });
    await rules.expectRule(audit, {
      what: 'an owner cannot rename the administrator',
      allow: false,
      refusalSpeaks: /cannot|only|role|administrator/i,
      act: () => owner.put(`/api/users/${encodeURIComponent(admin.userId || (admin.user && admin.user.id))}`, { full_name: 'Pair Renamed Admin' }),
    });
    await rules.expectRule(audit, {
      what: "an owner cannot reset the administrator's PIN",
      allow: false,
      refusalSpeaks: /cannot|only|pin|role/i,
      act: () => owner.post(`/api/users/${encodeURIComponent(admin.userId || (admin.user && admin.user.id))}/reset-pin`, { new_pin: '75021' }),
    });
    await rules.expectRule(audit, {
      what: "an owner cannot grant themselves administrator rights",
      allow: false,
      // 400 SELF_CHANGE_FORBIDDEN, because the self-change guard fires before the rank
      // rules do — and it is the better answer: nobody edits their own role by this path,
      // whatever the role, so there is no path to promotion by way of one's own row.
      refuseStatus: [400],
      refusalCode: 'SELF_CHANGE_FORBIDDEN',
      refusalSpeaks: /cannot|only|administrator|role|self/i,
      act: () => owner.put(`/api/users/${encodeURIComponent(owner.userId || (owner.user && owner.user.id))}`, { role: 'ADMIN' }),
    });

    audit.section('An administrator can disable a tenant seat — and put it back');
    // THE LIFECYCLE PROBE, on a DISPOSABLE owner-shaped seat rather than on the fixture
    // owner: a check that deactivates the seat every later check signs in as is a check
    // that breaks the suite when it fails. The person deactivated here is one this run
    // created, and the seat used to do the deactivating is the administrator's.
    const disposable = await rules.makeUser(d, {
      maker: admin, role: 'MANAGER', branchId: ctx.branchA.id, full_name: 'Pair Lifecycle Manager',
    });
    await audit.checkAsync('the administrator creates a manager, who can sign in', async () => {
      assert.ok(disposable.created, `creating the disposable manager answered ${disposable.status}`);
      const inRes = await rules.signIn(d, disposable.username, disposable.pin);
      assert.equal(inRes.status, 200, `the new manager cannot sign in: ${inRes.status} ${String(inRes.text).slice(0, 160)}`);
      disposable.token = inRes.json.token;
    });
    await audit.checkAsync('deactivating them ends the session they are holding', async () => {
      const off = await admin.put(`/api/users/${encodeURIComponent(disposable.id)}`, { is_active: false });
      assert2(off, 200, 'the administrator deactivating the manager');
      // 403 ACCOUNT_DEACTIVATED, NOT 401, and the product's choice is the right one: the
      // token is genuine and the person is known — what they no longer have is a right to
      // be here. A 401 would tell the app to show a sign-in screen, and signing in would
      // fail again with the same reason. This answers the question the person actually
      // has, and the message names who to ask. What matters either way is on the next
      // line: THE TOKEN THEY ARE HOLDING STOPS WORKING.
      const after = await d.request('GET', '/api/auth/me', { token: disposable.token });
      assert.equal(after.status, 403,
        `a deactivated account's existing token answered ${after.status} — the person is off the payroll and still reading the shop's books on the device in their pocket`);
      assert.equal(after.json && after.json.code, 'ACCOUNT_DEACTIVATED',
        `the dead session was refused with ${after.json && after.json.code}; a client cannot tell "you were let go" from "your PIN is wrong" without the code`);
      assert.match(String(after.json && after.json.error), /deactivated|reactivate/i,
        'the refusal does not tell the person what happened or who to ask');
      const back = await rules.signIn(d, disposable.username, disposable.pin);
      assert.ok(back.status >= 400, `a deactivated account signed in again (${back.status}) — deactivation has to mean the door is shut, not that the row says so`);
    });
    await audit.checkAsync('reactivating them lets them back in — a disabled account is not a deleted one', async () => {
      const on = await admin.put(`/api/users/${encodeURIComponent(disposable.id)}`, { is_active: true });
      assert2(on, 200, 'the administrator reactivating the manager');
      const back = await rules.signIn(d, disposable.username, disposable.pin);
      assert.equal(back.status, 200, `a reactivated manager still cannot sign in: ${back.status} ${String(back.text).slice(0, 160)}`);
    });
    await audit.checkAsync('and the administrator still holds a working session through all of it', async () => {
      const me = await admin.get('/api/auth/me');
      assert.equal(me.status, 200, `the administrator's own session broke (${me.status}) while they were managing somebody else's`);
    });

    audit.section('Both of them may change how the business behaves — that is what an owner is for');
    const flag = await owner.put('/api/settings', { managers_can_edit_prices: 1 });
    await audit.checkAsync('an owner can change a business setting', async () => {
      assert2(flag, 200, "the owner changing a setting");
    });
    const adminFlag = await admin.put('/api/settings', { managers_can_edit_prices: 1 });
    await audit.checkAsync('and so can the administrator, on the tenant\'s behalf', async () => {
      assert2(adminFlag, 200, 'the administrator changing the same setting');
    });
  },
};
