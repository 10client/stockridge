'use strict';
// =====================================================================
// ADMIN × STAFF — the platform and the shop floor
// =====================================================================
// These two roles are as far apart as the product gets, which is exactly why the pair
// is worth its own file: A CASHIER'S ACCOUNT IS THE ONE THAT GETS HANDED AROUND. It is
// on a shared phone at the counter, it is the one whose PIN gets shouted across a shop,
// and it is the one whose owner leaves for a competitor. Whatever it can reach, every
// other person who has ever used that device can reach.
//
// So this pair asserts the floor boundary as a LIST, not a feeling: what a cashier
// cannot read (the shop's books), what it cannot do (hire, deactivate, reconcile), what
// it deliberately CAN read (the withholding on the invoice in front of them), and what
// happens the moment the account is switched off.
// =====================================================================

const assert = require('node:assert');

function assert2(res, statuses, what) {
  const want = Array.isArray(statuses) ? statuses : [statuses];
  if (!want.includes(res.status)) {
    throw new Error(`${what} answered ${res.status} ${(res.json && (res.json.code || res.json.error)) || String(res.text).slice(0, 160)}`);
  }
}

module.exports = {
  pair: ['STAFF', 'ADMIN'],
  title: 'A cashier reaches the counter, and not one screen past it',

  async checks(audit, ctx) {
    const { d, roster, rules } = ctx;
    const admin = roster.ADMIN;
    const staff = roster.STAFF;

    audit.section('The books are not a cashier\'s to read');
    // THE RULE THIS FILE FOUND. `requireBooks` in server/routes/accounting.js now guards
    // the statements at MANAGER and above, and the reason it exists is in that file: a
    // cashier holding a phone could read the shop's profit and loss, its margins by
    // category and its trial balance. Margins are the most commercially sensitive thing
    // a shop owns, and the person most likely to be negotiating a discount or leaving
    // for a competitor is the one at the counter.
    for (const [what, path] of [
      ['the profit and loss statement', '/api/accounting/profit-loss'],
      ['the profit and loss by category', '/api/accounting/profit-loss?group_by=category'],
      ['the balance sheet', '/api/accounting/balance-sheet'],
      ['the trial balance', '/api/accounting/trial-balance'],
      ['the journal', '/api/accounting/journal?limit=20'],
    ]) {
      await audit.refusal(`a cashier cannot read ${what}`,
        () => staff.get(path),
        { expectStatus: 403, code: /ROLE_REQUIRED/, message: /manager|accounts/i });
    }
    await audit.checkAsync('a manager CAN read the same statements — the rule is a floor, not a wall', async () => {
      const res = await roster.MANAGER.get('/api/accounting/trial-balance');
      assert2(res, 200, 'a manager reading the trial balance');
    });

    audit.section('The exception is deliberate, and it is the one a cashier actually needs');
    await audit.checkAsync('a cashier CAN read the withholding position', async () => {
      const res = await staff.get('/api/accounting/wht');
      assert2(res, 200, 'a cashier reading the WHT position');
      audit.note('the WHT report is the exception `requireBooks` names: a person receiving goods has to see what was withheld from the supplier standing in front of them');
    });

    audit.section('What a cashier cannot do to other people');
    const victim = await rules.makeUser(d, {
      maker: admin, role: 'STAFF', branchId: ctx.branchA.id, full_name: 'Pair Floor Cashier',
    });
    await audit.checkAsync('the administrator can add a cashier', async () => {
      assert.ok(victim.created, `adding a cashier answered ${victim.status} ${String(victim.res.text).slice(0, 160)}`);
    });
    await rules.expectRule(audit, {
      what: 'a cashier cannot deactivate another cashier',
      allow: false,
      refusalSpeaks: /cannot|only|role/i,
      act: () => staff.put(`/api/users/${encodeURIComponent(victim.id)}`, { is_active: false }),
    });
    await rules.expectRule(audit, {
      what: "a cashier cannot reset another cashier's PIN — which would be a way to take their seat",
      allow: false,
      refusalSpeaks: /cannot|only|pin|role/i,
      act: () => staff.post(`/api/users/${encodeURIComponent(victim.id)}/reset-pin`, { new_pin: '59317' }),
    });
    await rules.expectRule(audit, {
      what: 'a cashier cannot open a branch',
      allow: false,
      refusalSpeaks: /owner|only|branch/i,
      act: () => staff.post('/api/branches', { business_id: ctx.targets.OWNER && ctx.targets.OWNER.business_id, name: 'Pair Cashier Branch', branch_type: 'RETAIL' }),
    });
    await rules.expectRule(audit, {
      what: 'a cashier cannot reconcile the safe',
      allow: false,
      refusalSpeaks: /manager|only/i,
      act: () => staff.post('/api/safe/reconcile', { counted_balance: 1000, note: 'Pair audit: a cashier should not be able to do this' }),
    });

    audit.section('Switching the account off is instant, and it is the administrator who holds the switch');
    const live = await rules.signIn(d, victim.username, victim.pin);
    await audit.checkAsync('the new cashier can sign in', async () => {
      assert.equal(live.status, 200, `the new cashier cannot sign in: ${live.status} ${String(live.text).slice(0, 160)}`);
    });
    await audit.checkAsync('deactivating them stops the token they are already holding', async () => {
      const off = await admin.put(`/api/users/${encodeURIComponent(victim.id)}`, { is_active: false });
      assert2(off, 200, 'deactivating the cashier');
      const after = await d.request('GET', '/api/auth/me', { token: live.json.token });
      assert.equal(after.status, 403,
        `the deactivated cashier's token answered ${after.status} — on a shop floor this is the whole point of the switch: the phone in the thief's hand stops working now, not when the session expires`);
      assert.equal(after.json && after.json.code, 'ACCOUNT_DEACTIVATED',
        `the refusal code was ${after.json && after.json.code}; the client shows a different screen for a deactivated account than for a bad PIN, and it can only do that if the code is right`);
    });
    await audit.checkAsync('and the cashier seat of THIS audit is untouched by it', async () => {
      const me = await staff.get('/api/auth/me');
      assert.equal(me.status, 200, `deactivating one cashier signed out the other (${me.status}) — a deactivation that reaches past the account it names is a bug with a very bad day attached`);
    });

    audit.section('The floor boundary is the same one the administrator set for them');
    await audit.checkAsync("a cashier's branch list is their branch, and nothing else", async () => {
      const res = await staff.get('/api/branches?limit=100');
      assert2(res, 200, 'the cashier reading branches');
      const rows = rules.rowsOf(res);
      assert.equal(rows.length, 1, `the cashier sees ${rows.length} branches; a cashier works in one shop`);
      assert.equal(String(rows[0].id), String(staff.branchId || ctx.branchA.id), 'the branch a cashier sees is not the branch they are pinned to');
    });
  },
};
