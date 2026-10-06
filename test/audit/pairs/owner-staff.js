'use strict';
// =====================================================================
// OWNER × STAFF — the whole hierarchy, in one file
// =====================================================================
// There is no role between these two, so every boundary in the product is crossed by
// this pair at once. It is the pair a client will actually try to abuse ("just tell me
// your PIN, I need to check something on the report") and the pair where the product's
// answer has to be both firm and USABLE — because the alternative to a working boundary
// is a shared PIN, and a shared PIN is a shop where nobody can be asked about a
// shortage.
//
// So this file walks the whole distance: what the cashier may do with the owner's
// records (read the ones in their own branch, and nothing more), what the owner may do
// to the cashier (hire, move, reset, disable — the entire lifecycle), and the two
// deliberate exceptions where the floor is allowed to read something that smells like
// management: the withholding on the invoices in front of them, and their own branch's
// customer list.
// =====================================================================

const assert = require('node:assert');

function assert2(res, statuses, what) {
  const want = Array.isArray(statuses) ? statuses : [statuses];
  if (!want.includes(res.status)) {
    throw new Error(`${what} answered ${res.status} ${(res.json && (res.json.code || res.json.error)) || String(res.text).slice(0, 160)}`);
  }
}

module.exports = {
  pair: ['STAFF', 'OWNER'],
  title: 'The owner is the whole hierarchy; a cashier is one counter',

  async checks(audit, ctx) {
    const { d, roster, rules } = ctx;
    const owner = roster.OWNER;
    const staff = roster.STAFF;

    audit.section('What the cashier may read of the owner\'s business, and where it stops');
    await audit.checkAsync("the cashier sees the owner's own customer row — it is in their branch", async () => {
      const row = ctx.row('OWNER');
      assert.ok(row && row.id, 'the owner could not create a fixture customer to look for');
      const res = await staff.get('/api/customers?limit=200');
      assert2(res, 200, 'the cashier reading customers');
      const rows = rules.rowsOf(res);
      assert(rows.some((r) => String(r.id) === String(row.id)),
        `the cashier cannot see a customer the OWNER created in their own branch (${row.branchId}) — an owner's walk-in customer has to appear at the counter, or the counter serves them twice and the shop's own records disagree with themselves`);
    });
    await audit.checkAsync('and nothing at all from the other branch', async () => {
      const res = await staff.get('/api/customers?limit=200');
      const rows = rules.rowsOf(res);
      const foreign = rows.filter((r) => r.branch_id && String(r.branch_id) !== String(staff.branchId));
      assert.equal(foreign.length, 0, `${foreign.length} row(s) from another branch are on the cashier's screen`);
    });

    audit.section('The two exceptions, named — because a blanket refusal would be the wrong answer');
    await audit.checkAsync('the cashier CAN read the withholding position', async () => {
      const res = await staff.get('/api/accounting/wht');
      assert2(res, 200, 'the cashier reading the WHT position');
    });
    for (const [what, path] of [
      ['the trial balance', '/api/accounting/trial-balance'],
      ['the profit and loss', '/api/accounting/profit-loss'],
    ]) {
      await audit.refusal(`and CANNOT read ${what}`, () => staff.get(path), { expectStatus: 403, code: /ROLE_REQUIRED/ });
    }

    audit.section('The owner holds the switch on a cashier\'s whole working life');
    const life = await rules.makeUser(d, {
      maker: owner, role: 'STAFF', branchId: ctx.branchA.id, full_name: 'Pair Lifecycle Cashier',
    });
    await audit.checkAsync('the owner hires a cashier', async () => {
      assert.ok(life.created, `hiring answered ${life.status} ${String(life.res.text).slice(0, 200)}`);
    });
    await rules.expectRule(audit, {
      what: 'the cashier cannot hire, edit or disable anybody — including themselves out of trouble',
      allow: false,
      refusalSpeaks: /cannot|only|role/i,
      act: () => staff.put(`/api/users/${encodeURIComponent(life.id)}`, { is_active: false }),
    });
    const destination = ctx.otherBranchFor(life);
    if (!destination) {
      audit.skip('the owner moves the cashier to the other branch, and their world moves with them', 'this deployment has one branch for that business');
    } else {
      await audit.checkAsync('the owner moves the cashier to the other branch, and their world moves with them', async () => {
        const res = await owner.put(`/api/users/${encodeURIComponent(life.id)}`, { branch_id: destination.id });
        assert2(res, 200, `the owner moving the cashier to ${destination.name}`);
        // THE HANDOVER FIRST (stage G3): the cashier does not move until the branch
        // that receives them agrees. Asserted here rather than assumed, because the
        // interesting failure is a move that quietly took effect anyway.
        assert.ok(res.json && res.json.pendingTransfer, `${destination.name} was not asked before the cashier was moved into it`);
        const accept = await owner.post(`/api/users/transfers/${encodeURIComponent(res.json.pendingTransfer.id)}/accept`, {});
        assert2(accept, 200, `answering the transfer into ${destination.name}`);
        const back = await rules.signIn(d, life.username, life.pin);
        assert.equal(back.status, 200, 'the moved cashier cannot sign in');
        const list = await d.request('GET', '/api/branches?limit=100', { token: back.json.token });
        const rows = rules.rowsOf(list);
        assert.equal(rows.length, 1, `the moved cashier sees ${rows.length} branches`);
        assert.equal(String(rows[0].id), String(destination.id),
          `the cashier was moved to ${destination.name} and still sees the branch they came from — a move that does not move the scope is an owner who believes the cashier is somewhere they are not`);
        life.token = back.json.token;
      });
    }

    audit.section('A reset PIN has to work for the person standing at the counter');
    let issued = null;
    // A SESSION THIS CHECK MAKES ITSELF, so `sessionsEnded` is a fact about the reset and
    // not a fact about whether an earlier check happened to sign this person in. The live
    // run found the difference: the move probe above stood down on a single-branch
    // deployment, so nobody had signed in as this cashier, and the reset was reported as
    // not ending any session — which was true and had nothing to do with the reset.
    const preSignIn = await rules.signIn(d, life.username, life.pin);
    await audit.checkAsync('the owner resets the cashier\'s PIN and is told what it is', async () => {
      assert.equal(preSignIn.status, 200, `the cashier could not be signed in before the reset: ${preSignIn.status}`);
      const res = await owner.post(`/api/users/${encodeURIComponent(life.id)}/reset-pin`, { new_pin: '58214' });
      assert2(res, 200, 'the owner resetting the cashier\'s PIN');
      issued = res.json;
      assert.equal(String(issued.pin), '58214', `the owner asked for one PIN and was told another: ${issued.pin}`);
      assert.ok(Number(issued.sessionsEnded) >= 1, 'the reset did not end the sessions the cashier was holding');
    });
    await audit.checkAsync('the cashier signs in with it, and the old PIN is dead', async () => {
      const dead = await rules.signIn(d, life.username, life.pin);
      assert.equal(dead.status, 401, `the cashier's OLD PIN still signs in (${dead.status}) after a reset — the reset is the only thing standing between a departed cashier and the till`);
      const live = await rules.signIn(d, life.username, issued.pin);
      assert.equal(live.status, 200, `the PIN the owner was told does not sign the cashier in: ${live.status} ${String(live.text).slice(0, 160)}`);
    });

    audit.section('The drawer: a cashier closes it, and only a manager or above signs it off');
    let tillId = null;
    await audit.checkAsync('the cashier opens a drawer', async () => {
      const res = await staff.post('/api/tills/open', { branch_id: staff.branchId || ctx.branchA.id, opening_cash: 15000, device_id: 'audit-roles-owner-staff' });
      if (res.status === 200 || res.status === 201) { tillId = res.json.id; return; }
      // An already-open till is a SHOP STATE, not a defect — this seat opened one in an
      // earlier section. The id is then read from the product rather than invented.
      // THE OPEN TILL COMES BACK NESTED, AS `till`, BESIDE `expectedCashNow` — and this
      // file's first draft looked for a flat `id` and then for `data.id`, found neither,
      // and reported "the product does not name it" about a response that named it twice
      // over. Read the key the endpoint actually uses.
      const current = await staff.get('/api/tills/current');
      tillId = current.json && ((current.json.till && current.json.till.id) || current.json.id);
      assert.ok(tillId,
        `a till is already open for this cashier (${res.status}) and /api/tills/current did not name it: ${String(current.text).slice(0, 200)}`);
    });
    if (tillId) {
      await audit.checkAsync('the cashier closes it', async () => {
        // COUNTED FROM THE PRODUCT'S OWN FIGURE. Counting a fixed 15,000 against a drawer
        // that took sales in an earlier section invents a variance on every run, and on a
        // live deployment it invents it in the client's books. `expectedCashNow` is what
        // the till says is in the drawer; the audit counts exactly that.
        const now = await staff.get(`/api/tills/current?branch_id=${encodeURIComponent(staff.branchId || ctx.branchA.id)}`);
        const expected = now.json && now.json.expectedCashNow != null ? Number(now.json.expectedCashNow) : 15000;
        audit.note(`the drawer says it holds ${expected}; the audit files that count`);
        const res = await staff.post(`/api/tills/${encodeURIComponent(tillId)}/close`, { counted_cash: expected, to_safe: 0 });
        assert.ok(res.status === 200 || res.status === 201 || res.status === 409,
          `closing the drawer answered ${res.status} ${String(res.text).slice(0, 200)}`);
      });
      await audit.refusal('the cashier cannot sign off their own drawer — the whole point of a review',
        () => staff.post(`/api/tills/${encodeURIComponent(tillId)}/review`, { accepted: true, note: 'Pair audit: a cashier reviewing themselves' }),
        { expectStatus: 403, code: /ROLE_REQUIRED/ });
      await audit.checkAsync('and the owner can — which is why a small shop still has a review', async () => {
        const res = await owner.post(`/api/tills/${encodeURIComponent(tillId)}/review`, { accepted: true, note: 'Pair audit: signed off by the owner' });
        assert.ok(res.status === 200 || res.status === 201 || res.status === 409,
          `the owner signing the drawer off answered ${res.status} ${String(res.text).slice(0, 240)}`);
        audit.note('a 409 here is the product saying the drawer was already reviewed — a state, not a failure');
      });
    } else {
      audit.skip('the drawer sign-off boundary is asserted');
    }

    audit.section('And the cashier cannot reach the till\'s paperwork at all');
    await rules.expectRule(audit, {
      what: 'a cashier cannot reconcile the safe',
      allow: false,
      refusalSpeaks: /manager|only/i,
      act: () => staff.post('/api/safe/reconcile', { counted_balance: 5000, note: 'Pair audit: a cashier trying to reconcile' }),
    });
  },
};
