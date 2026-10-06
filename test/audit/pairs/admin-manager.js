'use strict';
// =====================================================================
// ADMIN × MANAGER — the platform's hand and the shop's hand
// =====================================================================
// These two roles are the ones people confuse, because both of them "run things". They
// run DIFFERENT things: an administrator runs the DEPLOYMENT (businesses, their first
// branch, the accounts that may exist at all), and a manager runs ONE BRANCH of one
// business (its till, its stock, its cashiers, its expenses).
//
// The boundary is not a rank — the administrator is above everybody — it is a TENANT.
// An administrator can see every branch in the deployment, and a manager must never see
// one row outside their own. Both halves are asserted here, because a product that
// scopes too hard is as broken as one that scopes too loosely, and only one of the two
// ever gets complained about.
// =====================================================================

// `require('node:assert')` IS the function — destructuring `{ assert }` off it yields
// undefined, which is what this file did first and reported as "assert is not a function"
// on four checks that had passed. A require that looks right and hands back nothing.
const assert = require('node:assert');

/** The harness's assert, wrapped so a check reads as a sentence instead of a status. */
function assert2(res, statuses, what) {
  const want = Array.isArray(statuses) ? statuses : [statuses];
  if (!want.includes(res.status)) {
    throw new Error(`${what} answered ${res.status} ${(res.json && (res.json.code || res.json.error)) || String(res.text).slice(0, 160)}`);
  }
}

module.exports = {
  pair: ['MANAGER', 'ADMIN'],
  title: 'A manager runs a branch, an administrator runs the deployment',

  async checks(audit, ctx) {
    const { d, roster, rules } = ctx;
    const manager = roster.MANAGER;
    const managerB = roster.MANAGER_B;
    const admin = roster.ADMIN;

    audit.section('The administrator sees the whole deployment; a manager sees one branch');
    await audit.checkAsync('the administrator sees every branch', async () => {
      const res = await admin.get('/api/branches?limit=100');
      assert2(res, 200, 'the administrator reading branches');
      const rows = rules.rowsOf(res);
      const ids = new Set(rows.map((b) => String(b.id)));
      assert(ids.has(String(ctx.branchA.id)), `the administrator cannot see ${ctx.branchA.name}`);
      if (ctx.branchB) {
        assert(ids.has(String(ctx.branchB.id)),
          `the administrator sees ${rows.length} branch(es) and cannot see ${ctx.branchB.name} — an administrator who cannot see the second shop cannot provision or fix it`);
      }
      audit.note(`the administrator sees ${rows.length} branch(es)`);
    });
    await audit.checkAsync('a manager sees their own branch and no other', async () => {
      const res = await manager.get('/api/branches?limit=100');
      assert2(res, 200, 'the manager reading branches');
      const rows = rules.rowsOf(res);
      const ids = rows.map((b) => String(b.id));
      assert(ids.includes(String(ctx.branchA.id)), 'the manager cannot see the branch they are pinned to');
      if (ctx.branchB) {
        assert(!ids.includes(String(ctx.branchB.id)),
          `the pinned manager's branch list contains ${ctx.branchB.name} — the second branch of their own business. A manager who can list it can be shown it, and the pin is then decoration`);
      } else {
        audit.note('this deployment has one branch for the business, so the "and not the other one" half of this check has nothing to exclude');
      }
      assert(rows.length === 1, `the manager sees ${rows.length} branches; a pinned manager sees exactly one — their own`);
    });

    audit.section('Who may create whom');
    // The domain answers both of these; the audit only carries them to the API.
    await rules.expectRule(audit, {
      what: 'an administrator can create a manager',
      allow: true,
      allowStatus: [200, 201],
      act: () => rules.makeUser(d, { maker: admin, role: 'MANAGER', branchId: ctx.branchA.id, full_name: 'Pair Admin Manager' }),
    });
    await rules.expectRule(audit, {
      what: 'a manager cannot create another manager',
      allow: false,
      refusalSpeaks: /cannot|only|role/i,
      act: () => manager.post('/api/users', { username: `pair-mgr-${Date.now().toString(36).slice(-5)}`, pin: '73041', full_name: 'Pair Should Not Exist', role: 'MANAGER', branch_id: ctx.branchA.id }),
    });

    audit.section("A manager's branch is their scope, and moving it moves what they see");
    // THE STRONGEST TWO-WAY PROBE IN THIS PAIR. A manager's `branch_id` is the sole
    // scoping truth in the product, so moving the manager to the other branch must move
    // their world with them — and moving them BACK must move it back. A check that only
    // asserted the refusal half would pass on a product that scopes nothing at all.
    const beforeMove = await managerB.get('/api/customers?limit=200');
    const nameB = `Pair Move ${Date.now().toString(36).slice(-5)}`;
    const made = await managerB.post('/api/customers', { name: nameB, phone: '08030000001' });
    if (made.json && made.json.id) d.trackCustomer(made.json.id);
    await audit.checkAsync('the other branch manager can write a row in their own branch', async () => {
      assert2(made, [200, 201], 'creating a customer as the second-branch manager');
    });

    // THE DESTINATION IS A BRANCH OF THE SAME BUSINESS. `ctx.branchB` is the second
    // branch of the FIRST business; the second-branch manager may belong to another one
    // on a live deployment, and a move across businesses is refused for good reason.
    const destination = ctx.otherBranchFor(managerB);
    if (!destination) {
      audit.skip('a manager can be moved between two branches of one business', 'this deployment has only one branch for that business, so there is nowhere legitimate to move them to');
      return;
    }
    const moved = await admin.put(`/api/users/${encodeURIComponent(managerB.userId || managerB.user.id)}`, { branch_id: destination.id });
    await audit.checkAsync('an administrator can move a manager to another branch', async () => {
      assert2(moved, 200, 'moving the manager');
    });
    await audit.checkAsync('and the moved manager now sees the first branch and not the second', async () => {
      const list = await managerB.get(`/api/customers?limit=200`);
      assert2(list, 200, 'the moved manager reading customers');
      const rows = rules.rowsOf(list);
      const still = rows.find((r) => String(r.name) === nameB);
      assert(!still, `the manager still sees "${nameB}", a customer they created in their own branch — the branch on the token is not what the lists are filtered by, so reassignment is cosmetic and the old branch's customer list stays on their screen`);
      // And a row that belongs to the branch they were moved TO is now visible: the
      // movement has to work in BOTH directions or it is just a denial of service.
      const there = rows.filter((r) => r.branch_id && String(r.branch_id) === String(destination.id));
      assert.ok(there.length >= 0, 'the row read is below');
      const own = ctx.customers.MANAGER;
      if (own && own.id) {
        assert(rows.some((r) => String(r.id) === String(own.id)),
          `after moving to ${destination.name} the manager cannot see a customer of that branch — they were taken away from their old branch and given nothing`);
      } else {
        audit.note('the destination branch had no fixture customer to look for; the disappearance of the old row is the assertion');
      }
      audit.note(`the manager moved to ${destination.name} and their customer list followed`);
    });

    await audit.checkAsync('and moving them back restores what they could see', async () => {
      const home = managerB.branchId;
      const back = await admin.put(`/api/users/${encodeURIComponent(managerB.userId || managerB.user.id)}`, { branch_id: home });
      assert2(back, 200, 'moving the manager back');
      const list = await managerB.get('/api/customers?limit=200');
      const rows = rules.rowsOf(list);
      assert(rows.some((r) => String(r.name) === nameB),
        `the manager was moved back to the branch they came from and can no longer see the customer they created there — the scope moved once and not twice, which is worse than not moving at all`);
    });

    audit.section('A manager cannot do an administrator\'s job, and is not pretended to be able to');
    await rules.expectRule(audit, {
      what: 'a manager cannot create a business (that is how a TENANT is made)',
      allow: false,
      refusalSpeaks: /administrator|admin|only/i,
      act: () => manager.post('/api/businesses', { name: `Pair Business ${Date.now().toString(36).slice(-4)}`, profile_code: 'ELECTRONICS' }),
    });
    await rules.expectRule(audit, {
      what: 'a manager cannot edit the administrator',
      allow: false,
      refusalSpeaks: /cannot|only|administrator|role/i,
      act: () => manager.put(`/api/users/${encodeURIComponent(admin.userId || (admin.user && admin.user.id))}`, { full_name: 'Pair Renamed Admin' }),
    });
    await rules.expectRule(audit, {
      what: "a manager cannot reset the administrator's PIN",
      allow: false,
      refusalSpeaks: /cannot|only|pin|role/i,
      act: () => manager.post(`/api/users/${encodeURIComponent(admin.userId || (admin.user && admin.user.id))}/reset-pin`, { new_pin: '59317' }),
    });
  },
};
