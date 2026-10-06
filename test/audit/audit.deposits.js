'use strict';
// =====================================================================
// test/audit/audit.deposits.js — GOODS SET ASIDE, AND SOMEBODY ELSE'S MONEY
// =====================================================================
// `tools/flow-coverage.js` listed deposits as 0 of 5 routes exercised. A deposit is the only
// flow where the shop holds stock it has not been paid for in full AND money it does not
// own, and the failures are all quiet ones:
//
//   * THE HELD UNIT IS SOLD TO SOMEBODY ELSE. The customer who paid a deposit arrives and
//     the goods are gone.
//   * THE MONEY WALKS OUT UNRECORDED. A cancelled layaway refunds cash and the books still
//     show a liability, or the reverse.
//   * THE GOODS LEAVE UNPAID. A completion that ignores the outstanding balance hands over
//     stock on a promise.
//
// So this audit opens a real layaway, watches the reservation, refuses an overpayment, pays
// it off, cancels a second one, and completes a third — reading the shelf, the deposit book
// and the sale back from the deployment at every step:
//
//   FRONT TO BACK  open it → the unit is RESERVED (still on the shelf, not sellable).
//   BACK TO FRONT  pay it off → complete it → a real sale, the shelf drops, the hold goes.
//   AND THE REFUSALS an overpayment, a completion with a balance outstanding, and a staff
//                  cancel are all refused — with the reserved unit untouched afterwards.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `₦${round2(n).toLocaleString('en-NG')}`;

runAudit('deposits', async (audit, d) => {
  const owner = d.owner || d.admin;
  const staff = (d.seats && d.seats.staff) || null;
  const manager = (d.seats && d.seats.manager) || null;
  if (!staff || !manager) throw new Error('the deposits fixture needs a STAFF and a MANAGER seat — cancelling a layaway decides whether somebody gets their money back');
  const branch = (d.branches || [])[0];
  assert.ok(branch, 'the deposits fixture has no branch to hold goods at');

  const stockAt = async () => {
    // THE PRODUCT ID IS CHECKED, NOT TRUSTED. The first version of this reader closed over
    // an object that held the product under a key (`product.product.id`), so `product.id` was
    // `undefined`, no row ever matched, and every reading came back 0 — the same silent-zero
    // trap that cost P2 an afternoon. A reader that cannot say what it is reading fails here.
    assert.ok(product && product.product && product.product.id,
      'the stock reader was asked for a product id before a product was chosen');
    const wantedId = String(product.product.id);
    const res = await owner.get(`/api/stock?branch_id=${encodeURIComponent(branch.id)}&limit=200`);
    assert.equal(res.status, 200, `the stock list answered ${res.status}`);
    assert.ok(Array.isArray(res.json && res.json.data),
      `the stock list did not answer with rows under \`data\` (keys: ${Object.keys(res.json || {}).join(', ')})`);
    const rows = (res.json.data || []).filter((r) => String(r.product_id) === wantedId);
    return {
      onShelf: rows.reduce((a, r) => a + Number(r.on_shelf || 0), 0),
      reserved: rows.reduce((a, r) => a + Number(r.reserved || 0), 0),
      available: rows.reduce((a, r) => a + Number(r.available || 0), 0),
    };
  };
  const depositRow = async (id) => {
    for (const status of ['', '&status=COMPLETED', '&status=CANCELLED', '&status=FORFEITED']) {
      const res = await owner.get(`/api/deposits?limit=200${status}`);
      assert.equal(res.status, 200, `the deposits book answered ${res.status} ${String(res.text).slice(0, 160)}`);
      const rows = res.json.data || res.json.deposits || [];
      assert.ok(Array.isArray(rows), `the deposits book did not answer with a list (keys: ${Object.keys(res.json || {}).join(', ')})`);
      const row = rows.filter((r) => String(r.id) === String(id))[0];
      if (row) return row;
    }
    return null;
  };

  // -----------------------------------------------------------------
  const product = await audit.captureAsync('a product to hold, and a customer to hold it for', async () => {
    const res = await owner.get('/api/products?limit=200');
    const rows = (res.json.data || res.json.products || []);
    const pick = rows.filter((p) => Number(p.selling_price) > 0)[0];
    assert.ok(pick, 'the catalogue has no priced product — the starter catalogue is missing and this audit cannot trade');
    const cust = await owner.post('/api/customers', {
      name: `Deposit Audit Customer ${Date.now().toString(36).slice(-4)}`,
      phone: '08031234567',
      customer_type: 'INDIVIDUAL',
    });
    assert.ok(cust.status < 400, `creating the customer answered ${cust.status}: ${String(cust.text).slice(0, 200)}`);
    const customerId = cust.json.id || (cust.json.customer && cust.json.customer.id);
    assert.ok(customerId, 'the customer was created and the answer carries no id');
    return { product: pick, customerId };
  });
  const unitPrice = round2(product.product.selling_price);
  audit.note(`${product.product.sku} ${product.product.name} at ${money(unitPrice)} — held for one customer at ${branch.name}`);

  const HELD = 3;
  const total = round2(HELD * unitPrice);
  const firstDeposit = round2(total * 0.4);
  audit.note(`the layaway below is ${HELD} unit(s) = ${money(total)}, opened with 40% down`);

  await audit.checkAsync('stock on the shelf to hold', async () => {
    const adj = await owner.post('/api/stock/adjust', {
      branch_id: branch.id, product_id: product.product.id, quantity: 6,
      adjustment_type: 'FOUND', reason: 'Deposits audit — stock to hold and to sell',
    });
    assert.ok(adj.status < 400, `stocking the shelf answered ${adj.status}: ${String(adj.text).slice(0, 200)}`);
    const held = await stockAt();
    assert.ok(held.available >= HELD, `${branch.name} shows ${held.available} unit(s) available — the hold below is for ${HELD}`);
  });

  // ===================================================================
  audit.section('Holding it — the unit is set aside and cannot be sold to anybody else');
  // ===================================================================
  const layaway = await audit.captureAsync('a layaway opened with 40% down', async () => {
    const before = await stockAt();
    const res = await owner.post('/api/deposits', {
      branch_id: branch.id,
      product_id: product.product.id,
      customer_id: product.customerId,
      deposit_type: 'LAYAWAY',
      quantity: HELD,
      unit_price: unitPrice,
      deposit_amount: firstDeposit,
      method: 'CASH',
    }, { idempotencyKey: `deposits-open-${Date.now().toString(36)}` });
    assert.ok(res.status === 201 || res.status === 200, `opening the layaway answered ${res.status}: ${String(res.text).slice(0, 280)}`);
    assert.equal(round2(res.json.balanceDue), round2(total - firstDeposit),
      `the layaway was opened for ${money(total)} with ${money(firstDeposit)} down, so ${money(round2(total - firstDeposit))} is outstanding; the answer says ${money(res.json.balanceDue)}`);

    // FRONT TO BACK: RESERVED, NOT GONE. The unit is still on the shelf — the shop has it —
    // but it can no longer be sold to the next person through the door.
    const after = await stockAt();
    assert.equal(after.onShelf, before.onShelf,
      `the shelf went from ${before.onShelf} to ${after.onShelf} when a hold was placed. A layaway does not take the goods off the shelf — it stops them being sold`);
    assert.ok(after.reserved >= before.reserved + HELD,
      `${HELD} unit(s) were put on hold and the reserved figure went ${before.reserved} → ${after.reserved}. A hold that does not reserve is a promise the shop can sell away at any moment`);
    assert.equal(round2(after.available), round2(after.onShelf - after.reserved),
      `the stock list says ${after.available} available against ${after.onShelf} on the shelf and ${after.reserved} reserved — the three figures disagree, and the available one is what every sale trusts`);

    const row = await depositRow(res.json.id);
    assert.ok(row, 'the layaway is not in the deposits book');
    assert.equal(String(row.status), 'ACTIVE', `a fresh layaway is ${row.status}`);
    return { id: res.json.id, expiresAt: res.json.expiresAt, before, after };
  });
  audit.note(`layaway ${layaway.id.slice(0, 8)} holds ${HELD} unit(s); expires ${String(layaway.expiresAt).slice(0, 10)}`);

  await audit.checkAsync('the held unit cannot be sold to somebody else', async () => {
    // THE POINT OF THE HOLD. A sale of everything available has to come up short, because
    // the held units are not available to sell.
    const now = await stockAt();
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: product.product.id, quantity: now.available + 1 }],
      payments: [{ method: 'CASH', amount: round2((now.available + 1) * unitPrice) }],
      device_id: 'audit-deposits',
    });
    assert.ok(res.status >= 400 && res.status < 500,
      `${now.available + 1} unit(s) were sold while only ${now.available} were available (${HELD} of them promised to a customer who has paid): ${res.status} ${String(res.text).slice(0, 200)}. A hold the shop can sell past is not a hold`);
    const stillHeld = await stockAt();
    assert.equal(stillHeld.reserved, now.reserved, 'a refused sale changed the reserved figure');
  });

  // ===================================================================
  audit.section('Paying it off — and the overpayment that is refused');
  // ===================================================================
  await audit.checkAsync('paying more than is outstanding is refused, and changes nothing', async () => {
    const row = await depositRow(layaway.id);
    const outstanding = round2(Number(row.balance_due));
    const res = await staff.post(`/api/deposits/${encodeURIComponent(layaway.id)}/payments`,
      { amount: round2(outstanding + 5000), method: 'CASH' });
    assert.ok(res.status >= 400 && res.status < 500,
      `${money(round2(outstanding + 5000))} was accepted against ${money(outstanding)} outstanding: ${res.status} ${String(res.text).slice(0, 200)}. Money in credit for goods the customer has not collected is money the shop cannot account for`);
    assert.equal(res.json.code, 'OVERPAYMENT', `the refusal came back as ${res.json.code}`);
    const after = await depositRow(layaway.id);
    assert.equal(round2(Number(after.balance_due)), outstanding,
      `the refused overpayment moved the balance from ${money(outstanding)} to ${money(after.balance_due)}`);
  });

  await audit.checkAsync('paying the balance off marks it paid in full, and still does not release the goods', async () => {
    const row = await depositRow(layaway.id);
    const outstanding = round2(Number(row.balance_due));
    const before = await stockAt();
    const res = await staff.post(`/api/deposits/${encodeURIComponent(layaway.id)}/payments`,
      { amount: outstanding, method: 'CASH' }, { idempotencyKey: `deposits-pay-${Date.now().toString(36)}` });
    assert.ok(res.status < 400, `paying the balance answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.equal(Boolean(res.json.fullyPaid), true,
      `after paying ${money(outstanding)} the deposit answers fullyPaid=${res.json.fullyPaid}. A layaway paid in full that does not know it is a layaway nobody releases`);
    assert.equal(round2(res.json.balanceDue), 0, `the balance after paying it off is ${money(res.json.balanceDue)}`);

    // AND THE GOODS ARE STILL SET ASIDE: paying does not hand them over. The sale that
    // releases the stock is a separate, deliberate act with a receipt behind it.
    const after = await stockAt();
    assert.equal(after.onShelf, before.onShelf,
      'the shelf moved when the last payment was taken — a payment is not a collection');
    assert.ok(after.reserved >= HELD,
      `the reservation went to ${after.reserved} once the deposit was paid in full; the goods are only released by the sale that hands them over`);
  });

  // ===================================================================
  audit.section('Completing it — a real sale, the shelf drops, the hold goes');
  // ===================================================================
  await audit.checkAsync('completing it rings the sale, takes the stock and releases the hold', async () => {
    const before = await stockAt();
    const res = await owner.post(`/api/deposits/${encodeURIComponent(layaway.id)}/complete`, {});
    assert.ok(res.status < 400, `completing the layaway answered ${res.status}: ${String(res.text).slice(0, 300)}`);

    const after = await stockAt();
    assert.equal(after.onShelf, before.onShelf - HELD,
      `${branch.name} held ${before.onShelf} and ${HELD} unit(s) were collected, so it should hold ${before.onShelf - HELD}; it holds ${after.onShelf}. Goods handed over that still show on the shelf are goods the shop will sell twice`);
    assert.equal(after.reserved, round2(before.reserved - HELD),
      `the hold went ${before.reserved} → ${after.reserved} when the goods were collected; a reservation left behind is stock nobody can ever sell`);

    // BACK TO FRONT: the deposit is closed and it POINTS AT the sale that closed it.
    const row = await depositRow(layaway.id);
    assert.ok(row, 'the completed layaway is not in the book at all');
    assert.equal(String(row.status), 'COMPLETED', `the deposit is ${row.status} after the goods were collected`);
    assert.ok(row.completed_sale_id, 'the completed deposit does not say which sale it became — the receipt and the layaway cannot be tied together, which is exactly what a customer dispute turns on');

    const saleRes = await owner.get(`/api/sales/${encodeURIComponent(row.completed_sale_id)}`);
    assert.equal(saleRes.status, 200, `the sale the deposit became answered ${saleRes.status}`);
    const sale = saleRes.json.sale || saleRes.json;
    assert.equal(round2(Number(sale.total)), total,
      `the sale created from the layaway totals ${money(sale.total)} against the ${money(total)} that was agreed. The price the customer was quoted is the price they pay`);
  });

  // ===================================================================
  audit.section('The refusals — money the shop must not hand over, and goods it must not release');
  // ===================================================================
  await audit.checkAsync('goods cannot leave on a promise: completing with a balance outstanding is refused', async () => {
    const opened = await owner.post('/api/deposits', {
      branch_id: branch.id,
      product_id: product.product.id,
      customer_id: product.customerId,
      deposit_type: 'LAYAWAY',
      quantity: 1,
      unit_price: unitPrice,
      deposit_amount: round2(unitPrice * 0.25),
      method: 'CASH',
    });
    assert.ok(opened.status < 400, `opening a second layaway answered ${opened.status}: ${String(opened.text).slice(0, 220)}`);

    const before = await stockAt();
    const res = await owner.post(`/api/deposits/${encodeURIComponent(opened.json.id)}/complete`, {});
    assert.ok(res.status >= 400 && res.status < 500,
      `a layaway 25% paid was completed and the goods released: ${res.status} ${String(res.text).slice(0, 240)}`);
    assert.ok(/outstanding|balance/i.test(String(res.json.error || '')),
      `the refusal does not mention the money still owed: ${res.json.error}`);
    const after = await stockAt();
    assert.equal(after.onShelf, before.onShelf, 'a refused completion still took the goods off the shelf');

    // AND A MANAGER CAN OVERRIDE IT — deliberately, and the sale carries the balance as a
    // credit sale rather than pretending it was paid.
    // AND THE OVERRIDE NEEDS A REASON ON THE RECORD: the customer has no credit limit, so
    // the sale engine asks why the shop is carrying them. Two real defects lived in this
    // one call — the route rang a RETAIL sale (UNDERPAID, the override unusable) and then
    // dropped the credit-override reason entirely.
    const forced = await manager.post(`/api/deposits/${encodeURIComponent(opened.json.id)}/complete`,
      { allow_outstanding: true, credit_override_reason: 'Audit: the customer is known to the shop and the balance was agreed at the counter.' });
    assert.ok(forced.status < 400,
      `a MANAGER overriding the balance answered ${forced.status}: ${String(forced.text).slice(0, 260)}. The override exists precisely so that a shop can hand goods over to somebody it trusts, on the record`);
    const released = await stockAt();
    assert.equal(released.onShelf, before.onShelf - 1, 'the override completed but the goods did not leave the shelf');
  });

  await audit.checkAsync('a STAFF member cannot cancel a layaway, and cancelling returns the reservation', async () => {
    const opened = await owner.post('/api/deposits', {
      branch_id: branch.id,
      product_id: product.product.id,
      customer_id: product.customerId,
      deposit_type: 'RESERVATION',
      quantity: 1,
      unit_price: unitPrice,
      deposit_amount: round2(unitPrice * 0.25),
      method: 'CASH',
    });
    assert.ok(opened.status < 400, `opening the reservation answered ${opened.status}: ${String(opened.text).slice(0, 220)}`);

    const refused = await staff.post(`/api/deposits/${encodeURIComponent(opened.json.id)}/cancel`,
      { forfeit: false, reason: 'The customer asked for their money back at the counter.' });
    assert.equal(refused.status, 403,
      `a STAFF member cancelled a customer's deposit and decided whether they get their money back: ${refused.status} ${String(refused.text).slice(0, 200)}`);
    assert.equal(refused.json.code, 'ROLE_REQUIRED', `the refusal came back as ${refused.json.code}`);

    const before = await stockAt();
    const reasonShort = await manager.post(`/api/deposits/${encodeURIComponent(opened.json.id)}/cancel`,
      { forfeit: false, reason: 'nope' });
    assert.equal(reasonShort.status, 400, 'a two-word reason was accepted for keeping or returning somebody else\'s money');

    const res = await manager.post(`/api/deposits/${encodeURIComponent(opened.json.id)}/cancel`,
      { forfeit: false, reason: 'Customer changed their mind; the deposit was returned in full at the counter.', refund_method: 'CASH' });
    assert.ok(res.status < 400, `cancelling the reservation answered ${res.status}: ${String(res.text).slice(0, 260)}`);
    const after = await stockAt();
    assert.equal(after.reserved, round2(before.reserved - 1),
      `the reservation was released and the reserved figure went ${before.reserved} → ${after.reserved}. A cancelled hold that keeps its reservation is stock nobody can ever sell again`);
    assert.equal(after.onShelf, before.onShelf, 'cancelling a hold changed what is physically on the shelf');

    const row = await depositRow(opened.json.id);
    assert.ok(row && String(row.status) === 'CANCELLED',
      `the cancelled deposit reads ${row ? row.status : 'absent'}. A cancellation the book does not show is money the shop cannot account for`);
  });
}, {
  setup: () => startDeployment({
    label: 'deposits',
    businesses: [{
      name: 'Deposits Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Deposits Counter', code: 'DEP-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 60000 },
      ],
    }],
    seats: [
      { as: 'staff', role: 'STAFF', username: 'dep-staff', pin: '60511', branchIndex: 0, full_name: 'Deposits Audit Staff' },
      { as: 'manager', role: 'MANAGER', username: 'dep-manager', pin: '60512', branchIndex: 0, full_name: 'Deposits Audit Manager' },
    ],
  }),
});
