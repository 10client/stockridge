'use strict';
// =====================================================================
// OWNER × MANAGER — the person who owns the business and the person who runs it
// =====================================================================
// In a Nigerian SME these are often the same human being on different days, and the
// product must still be able to tell them apart: the owner of a two-branch appliance
// shop who promotes a long-serving manager wants that manager to run the Lagos branch
// completely — stock, staff, cash, prices — and does NOT want them to be able to change
// what staff are allowed to do, move somebody to another branch, or file tax.
//
// That is a set of lines drawn through the middle of "management", and every one of
// them is asserted in both directions here: the manager is refused, the owner is
// allowed, in the same check. A product that fails either half is a product a client
// will work around — with a shared owner PIN, which is where this whole discipline
// starts to fall apart.
// =====================================================================

const assert = require('node:assert');

function assert2(res, statuses, what) {
  const want = Array.isArray(statuses) ? statuses : [statuses];
  if (!want.includes(res.status)) {
    throw new Error(`${what} answered ${res.status} ${(res.json && (res.json.code || res.json.error)) || String(res.text).slice(0, 160)}`);
  }
}

module.exports = {
  pair: ['MANAGER', 'OWNER'],
  title: 'An owner hands a branch to a manager, and keeps three things',

  async checks(audit, ctx) {
    const { d, roster, rules } = ctx;
    const owner = roster.OWNER;
    const manager = roster.MANAGER;

    audit.section('The owner appoints a manager, and the appointment is pinned to a branch');
    const home = ctx.branchB || ctx.branchA;
    const appointed = await rules.makeUser(d, {
      maker: owner, role: 'MANAGER', branchId: home.id, full_name: 'Pair Appointed Manager',
    });
    await audit.checkAsync('an owner can appoint a manager to a branch', async () => {
      assert.ok(appointed.created, `appointing a manager answered ${appointed.status} ${String(appointed.res.text).slice(0, 200)}`);
      const inRes = await rules.signIn(d, appointed.username, appointed.pin);
      assert.equal(inRes.status, 200, `the appointed manager cannot sign in: ${inRes.status} ${String(inRes.text).slice(0, 160)}`);
      const me = await inRes ? await d.request('GET', '/api/auth/me', { token: inRes.json.token }) : null;
      const pinned = me && me.json && me.json.user && me.json.user.branch && me.json.user.branch.id;
      assert.equal(String(pinned), String(home.id),
        `the appointed manager was created against ${home.name} and their session says ${pinned} — a manager who lands in the wrong branch is a manager with somebody else's stock on their screen`);
    });

    audit.section('Three things a manager does not get');
    await rules.expectRule(audit, {
      what: 'a manager cannot change what staff are allowed to do',
      allow: false,
      refusalSpeaks: /owner|settings|staff/i,
      act: () => manager.put('/api/settings', { managers_can_void_sales: 0 }),
    });
    // THE TARGET HAS TO BE SOMEBODY THE MANAGER COULD OTHERWISE EDIT. The first draft
    // pointed this at the other MANAGER and the rank rule refused it first — correctly,
    // with "You are a Manager and cannot edit a Manager" — so the check proved the rank
    // boundary a second time and never reached the branch rule it was written for. A
    // cashier is inside the manager's reach, which makes the ONLY reason left for a
    // refusal the one being tested.
    const mover = await rules.makeUser(d, {
      maker: manager, role: 'STAFF', branchId: ctx.branchA.id, full_name: 'Pair Movable Cashier',
    });
    const refusalDestination = ctx.otherBranchFor(mover) || ctx.branchB;
    if (!refusalDestination) {
      audit.skip('a manager cannot move even their own cashier to another branch', 'this deployment has one branch for that business, so there is no move to refuse');
    } else {
      await rules.expectRule(audit, {
        what: 'a manager cannot move even their own cashier to another branch',
        allow: false,
        refusalSpeaks: /owner|branch/i,
        act: () => manager.put(`/api/users/${encodeURIComponent(mover.id)}`, { branch_id: refusalDestination.id }),
      });
    }
    await rules.expectRule(audit, {
      what: 'a manager cannot file tax as remitted to FIRS',
      allow: false,
      refusalSpeaks: /owner|remitted/i,
      act: () => manager.post('/api/accounting/wht/does-not-exist/remitted', { reference: 'PAIR-FIRS-1', remitted_at: '2026-01-01' }),
    });
    await rules.expectRule(audit, {
      what: 'a manager cannot appoint another manager',
      allow: false,
      refusalSpeaks: /cannot|only|role/i,
      act: () => manager.post('/api/users', { username: `pair-mgr2-${Date.now().toString(36).slice(-5)}`, pin: '73041', full_name: 'Pair Second Manager', role: 'MANAGER', branch_id: ctx.branchA.id }),
    });

    audit.section('And the same three actions, in the owner\'s hands, all work');
    await audit.checkAsync('the owner CAN change what staff are allowed to do', async () => {
      const res = await owner.put('/api/settings', { managers_can_void_sales: 1 });
      assert2(res, 200, 'the owner changing a staff-flag setting');
    });
    const toBranch = ctx.otherBranchFor(home.id);
    if (!toBranch) {
      audit.skip('the owner can move a colleague to another branch', 'this deployment has one branch for that business, so there is nowhere to move them to');
    } else {
      await audit.checkAsync('the owner CAN move a colleague to another branch, and the move is real', async () => {
        const res = await owner.put(`/api/users/${encodeURIComponent(appointed.id)}`, { branch_id: toBranch.id });
        assert2(res, 200, `the owner moving the manager to ${toBranch.name}`);
        const back = await rules.signIn(d, appointed.username, appointed.pin);
        assert.equal(back.status, 200, 'the moved manager cannot sign in after the move');
        const me = await d.request('GET', '/api/auth/me', { token: back.json.token });
        const pinned = me.json && me.json.user && me.json.user.branch && me.json.user.branch.id;
        assert.equal(String(pinned), String(toBranch.id),
          `after being moved to ${toBranch.name} the manager's session still says ${pinned} — the move did not take, or it took on the row and not on the session`);
      });
    }
    const branchRes = await owner.post('/api/branches', {
      business_id: ctx.targets.OWNER && ctx.targets.OWNER.business_id,
      name: `Pair Owner Branch ${Date.now().toString(36).slice(-4)}`, code: `PAIR-OWN-${Date.now().toString(36).slice(-3).toUpperCase()}`, branch_type: 'RETAIL', city: 'Abuja', state: 'FCT',
    });
    if (branchRes.status === 402) {
      // The plan says how many branches this business may have, and a deployment at that
      // limit is a working product with a paid-for ceiling — reported, not failed.
      audit.skip('the owner CAN open a branch', `this deployment is at its plan's branch limit (${(branchRes.json && branchRes.json.code) || branchRes.status})`);
    } else {
      await audit.checkAsync('the owner CAN open a branch', async () => {
        assert2(branchRes, [200, 201], 'the owner opening a branch');
        const madeId = branchRes.json && (branchRes.json.id || branchRes.json.branch_id);
        if (madeId) ctx.openedBranches.push({ id: madeId, name: branchRes.json.name || "the owner's new branch" });
      });
    }

    audit.section('Both of them run the shop, so both of them see its numbers');
    // The statements read at MANAGER and above (server/routes/accounting.js). That is a
    // DECISION, and this pair is where it is written down from the tenant's side: the
    // owner is not the only person who has to answer for the branch's margin, and a
    // product that hid the branch's own books from the person running it would send them
    // back to a notebook.
    for (const [who, actor] of [['the owner', owner], ['the manager', manager]]) {
      await audit.checkAsync(`${who} can read the branch's trading position`, async () => {
        const res = await actor.get('/api/accounting/trial-balance');
        assert2(res, 200, `${who} reading the trial balance`);
      });
    }
    await audit.checkAsync('but the manager\'s records stop at their branch', async () => {
      const res = await manager.get('/api/customers?limit=200');
      assert2(res, 200, 'the manager reading customers');
      const rows = rules.rowsOf(res);
      const foreign = rows.filter((r) => r.branch_id && String(r.branch_id) !== String(manager.branchId));
      assert.equal(foreign.length, 0,
        `the manager's customer list carries ${foreign.length} row(s) from another branch — the branch on the token is the scope, and every screen reads it`);
    });
  },
};
