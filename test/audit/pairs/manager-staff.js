'use strict';
// =====================================================================
// MANAGER × STAFF — the pair that runs a shop all day
// =====================================================================
// Every other pair in this directory is about a boundary somebody drew. This one is
// about the two roles that spend the day TOGETHER: the manager who is answerable for
// the branch, and the cashier who is standing at its counter. Almost every rule in the
// product's settings table decides what this pair may do to each other's work —
// `managers_can_void_sales`, `managers_can_approve_expenses`, `managers_can_edit_prices`
// — and none of those flags mean anything if the routes do not enforce them.
//
// It is also the pair where "refuse everything" is most obviously not a fix. A manager
// who cannot approve the cashier's expense, or void a sale the cashier mistyped, is a
// shop where nothing gets done. So EVERY rule below is probed in both directions: the
// cashier is refused, AND the manager is allowed, in the same check.
// =====================================================================

const assert = require('node:assert');

function assert2(res, statuses, what) {
  const want = Array.isArray(statuses) ? statuses : [statuses];
  if (!want.includes(res.status)) {
    throw new Error(`${what} answered ${res.status} ${(res.json && (res.json.code || res.json.error)) || String(res.text).slice(0, 160)}`);
  }
}

module.exports = {
  pair: ['MANAGER', 'STAFF'],
  title: 'A manager and a cashier, on the same day, in the same branch',

  async checks(audit, ctx) {
    const { d, roster, rules } = ctx;
    const manager = roster.MANAGER;
    const staff = roster.STAFF;
    const branch = ctx.branchA;

    audit.section('The manager hires the cashier, and the cashier cannot hire');
    const hired = await rules.makeUser(d, {
      maker: manager, role: 'STAFF', branchId: branch.id, full_name: 'Pair Hired Cashier',
    });
    await audit.checkAsync('a manager can add a cashier to their own branch', async () => {
      assert.ok(hired.created, `the manager adding a cashier answered ${hired.status} ${String(hired.res.text).slice(0, 200)}`);
      const inRes = await rules.signIn(d, hired.username, hired.pin);
      assert.equal(inRes.status, 200, `the cashier the manager hired cannot sign in: ${inRes.status} ${String(inRes.text).slice(0, 160)}`);
      hired.token = inRes.json.token;
    });
    await rules.expectRule(audit, {
      what: 'a cashier cannot add anybody, not even another cashier',
      allow: false,
      refusalSpeaks: /cannot|only|role/i,
      act: () => staff.post('/api/users', { username: `pair-nobody-${Date.now().toString(36).slice(-5)}`, pin: '73041', full_name: 'Pair Nobody', role: 'STAFF', branch_id: branch.id }),
    });

    audit.section('Stock on the shelf, so there is something to sell');
    const product = await audit.captureAsync('a priced product from the catalogue', async () => {
      const res = await manager.get('/api/products?limit=5');
      const rows = (res.json && res.json.data) || [];
      const priced = rows.find((r) => Number(r.selling_price) > 0);
      if (!priced) throw new Error(`the catalogue has no priced product (${rows.length} rows)`);
      return priced;
    });
    const unitPrice = Number(product.selling_price);
    await audit.checkAsync('the manager receives stock into the branch', async () => {
      // A RECEIPT WITHOUT ITS COSTS IS REFUSED (MISSING_FIELD), and quite right: cost and
      // selling price are what the stock is worth and what it may be sold for, and a
      // receipt that leaves them out would put goods on a shelf at a price nobody set.
      const res = await manager.post('/api/stock/receive', {
        branch_id: branch.id, product_id: product.id, quantity: 5,
        unit_code: product.default_unit_code || 'PIECE',
        cost_price: round2(unitPrice * 0.7), selling_price: unitPrice,
        reference: `PAIR-GRN-${Date.now().toString(36)}`,
      });
      assert2(res, [200, 201], 'the manager receiving stock');
    });

    audit.section('The discount rule: a cashier may discount, but has to say why');
    // sales.js: `discountAmount > 0 && !discountReason && !atLeast(user.role,'MANAGER')`.
    // The rule is not "cashiers cannot discount" — it is "a discount without a reason is
    // a manager's decision", which is how a shop keeps a record of what it gave away.
    const ring = (actor, body) => actor.post('/api/sales', Object.assign({
      branch_id: branch.id, lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: Number(body.expectedTotal != null ? body.expectedTotal : unitPrice) }],
      device_id: 'audit-roles-pair',
    }, body), { idempotencyKey: `pair-sale-${Math.random().toString(36).slice(2, 10)}` });

    const staffNoReason = await ring(staff, { discount_amount: 500 });
    await audit.checkAsync('a cashier discounting without a reason is refused, and the refusal says why', async () => {
      assert.ok(staffNoReason.status >= 400, `a cashier's unexplained discount answered ${staffNoReason.status} — the reason field is the only record the shop has of what it gave away`);
      assert.ok(staffNoReason.status < 500, `it was refused with a server error (${staffNoReason.status}) rather than a rule`);
      assert.match(String(staffNoReason.json && (staffNoReason.json.error || staffNoReason.json.message)), /reason|manager|discount/i,
        `the refusal does not mention the reason or the manager: "${staffNoReason.json && (staffNoReason.json.error || staffNoReason.json.message)}"`);
    });
    await audit.checkAsync('a manager may discount without one — the rule is a floor on the cashier, not a wall in front of the shop', async () => {
      const total = round2(unitPrice - 500);
      const res = await ring(manager, { discount_amount: 500, expectedTotal: total });
      assert.equal(res.status, 201, `a manager discounting was answered ${res.status} ${String(res.text).slice(0, 200)}`);
    });

    audit.section('Voiding: your own mistake is yours to fix, somebody else\'s is not');
    const staffSale = await ring(staff, {});
    await audit.checkAsync('the cashier rings a sale', async () => {
      assert.equal(staffSale.status, 201, `the sale answered ${staffSale.status} ${String(staffSale.text).slice(0, 240)}`);
    });
    const managerSale = await ring(manager, {});
    await audit.checkAsync('and the manager rings one', async () => {
      assert.equal(managerSale.status, 201, `the sale answered ${managerSale.status} ${String(managerSale.text).slice(0, 240)}`);
    });
    if (staffSale.status === 201 && managerSale.status === 201) {
      await audit.checkAsync('the cashier cannot void the manager\'s sale', async () => {
        const res = await staff.post(`/api/sales/${encodeURIComponent(managerSale.json.saleId)}/void`, { reason: 'Pair audit: a cashier should not reach another person\'s sale' });
        assert.equal(res.status, 403, `voiding the manager's sale answered ${res.status} ${String(res.text).slice(0, 200)} — sales.js allows it only for the person who rang it or a manager`);
      });
      await audit.checkAsync('the manager can void the cashier\'s sale', async () => {
        const res = await manager.post(`/api/sales/${encodeURIComponent(staffSale.json.saleId)}/void`, { reason: 'Pair audit: the wrong line was rung' });
        assert.ok(res.status === 200 || res.status === 201, `the manager voiding the cashier's sale answered ${res.status} ${String(res.text).slice(0, 240)}`);
      });
    } else {
      audit.skip('the void boundary is asserted', 'one of the two sales could not be rung');
    }

    audit.section('An expense the cashier raises is the manager\'s to approve');
    const expense = await audit.captureAsync('an expense raised by the cashier', async () => {
      const res = await staff.post('/api/expenses', {
        branch_id: branch.id, category: 'DIESEL_FUEL', amount: 2500,
        description: 'Pair audit: generator diesel, raised at the counter',
        payment_method: 'CASH',
      });
      if (res.status !== 200 && res.status !== 201) throw new Error(`the cashier's expense answered ${res.status} ${String(res.text).slice(0, 240)}`);
      return res.json;
    });
    await audit.checkAsync('the cashier\'s expense is PENDING_APPROVAL, not money already spent', async () => {
      assert.ok(expense, 'no expense could be raised');
      const status = String(expense.status || (expense.expense && expense.expense.status) || '');
      assert.equal(status, 'PENDING_APPROVAL',
        `the cashier's expense came back ${status || 'with no status'} — a cashier who can spend without approval is a drawer that empties itself`);
    });
    if (expense) {
      const id = expense.id || (expense.expense && expense.expense.id);
      await rules.expectRule(audit, {
        what: 'the cashier cannot approve their own expense',
        allow: false,
        refusalSpeaks: /manager|only/i,
        act: () => staff.post(`/api/expenses/${encodeURIComponent(id)}/approve`, { approved: true }),
      });
      await audit.checkAsync('and the manager can, which is the only reason the counter still works', async () => {
        const res = await manager.post(`/api/expenses/${encodeURIComponent(id)}/approve`, { approved: true });
        assert.ok(res.status === 200 || res.status === 201, `the manager approving the cashier's expense answered ${res.status} ${String(res.text).slice(0, 240)}`);
        const again = await manager.post(`/api/expenses/${encodeURIComponent(id)}/approve`, { approved: true });
        assert.equal(again.status, 409, `approving the same expense twice answered ${again.status} — money must not be able to leave twice because a button was pressed twice`);
      });
    }

    audit.section('The drawer belongs to the person who opened it');
    await audit.checkAsync('the cashier opens a till', async () => {
      const res = await staff.post('/api/tills/open', { branch_id: branch.id, opening_cash: 20000, device_id: 'audit-roles-pair' });
      // 201: a till is a thing that did not exist before the call. The money audit learned
      // the same lesson in the other direction — the id comes back FLAT as `id`.
      assert2(res, [200, 201], 'opening a till');
      staff.tillId = res.json.id;
    });
    if (staff.tillId) {
      await audit.checkAsync('a second cashier cannot close somebody else\'s drawer', async () => {
        const res = await hired.token
          ? await d.request('POST', `/api/tills/${encodeURIComponent(staff.tillId)}/close`, { token: hired.token, body: { counted_cash: 0 } })
          : null;
        assert.ok(res, 'the second cashier seat was not available');
        assert.equal(res.status, 403,
          `another cashier closing a drawer they never opened answered ${res.status} ${String(res.text).slice(0, 200)} — till.js allows it for the owner of the drawer or a manager, and a drawer anybody can close is a shortage nobody can be asked about`);
      });
    }
  },
};

function round2(n) { return Math.round(Number(n) * 100) / 100; }
