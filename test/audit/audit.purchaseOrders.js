'use strict';
// =====================================================================
// test/audit/audit.purchaseOrders.js — ORDERING, AND TAKING DELIVERY
// =====================================================================
// The purchase order is the one document where the shop commits money before it has anything to
// show for it: a signed price, a promised date, a supplier expecting a call. `POST
// /api/purchase-orders/*/cancel` was the last route in the product with NO audit anywhere — the
// coverage report said so for weeks — which means the path that UNDOES a commitment was the one
// path nobody had walked.
//
//   FRONT TO BACK  a manager orders two lines from a supplier → the order is DRAFT/PENDING and
//                  the supplier's outstanding balance carries it → part of it arrives and the
//                  order becomes PARTIALLY_RECEIVED with the balance still owed → the rest
//                  arrives and it closes → the two receipts are on the order's own history.
//   BACK TO FRONT  more than is outstanding is refused → an order that has taken delivery cannot
//                  be cancelled (the goods exist and the debt is real) → a cancellation needs a
//                  reason a supplier could be shown → a cashier cannot cancel → an order that IS
//                  cancelled cannot then be received, and the commitment comes off the supplier's
//                  balance. And the screen offers exactly the controls the API will accept.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const ROOT = path.join(__dirname, '..', '..');
const TAG = Date.now().toString(36).slice(-5).toUpperCase();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

runAudit('purchaseOrders', async (audit, d) => {
  const owner = d.owner;
  const manager = d.seats.manager || owner;
  const staff = d.seats.staff || null;
  const branch = d.branchFor(owner) || d.branches[0];

  const product = await audit.captureAsync('a product to order, and a supplier to order it from', async () => {
    const list = await owner.get('/api/products?limit=100');
    const pick = ((list.json && list.json.data) || []).find((p) => !Number(p.requires_serial) && Number(p.selling_price) > 0);
    assert.ok(pick, 'the vertical provisioned no ordinary product — the starter catalogue is missing');
    const sup = await manager.post('/api/suppliers', {
      name: `PO Audit Supplies ${TAG}`, contact_person: 'Ada Okon', phone: '08031234567',
    });
    assert.ok(sup.status < 400, `adding a supplier answered ${sup.status}: ${String(sup.text).slice(0, 200)}`);
    return { pick, supplier: { id: sup.json.id, name: `PO Audit Supplies ${TAG}` } };
  });
  const { pick, supplier } = product;

  const order = (qty, unitCost) => ({
    supplier_id: supplier.id, branch_id: branch.id,
    items: [{ product_id: pick.id, quantity: qty, unit_code: pick.default_unit_code || 'PIECE', expected_unit_cost: unitCost }],
    expected_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    notes: `audit order ${TAG}`,
  });

  // ------------------------------------------------------------------
  // FRONT TO BACK — THE ORDER
  // ------------------------------------------------------------------
  const po = await audit.captureAsync('a manager orders six units from the supplier', async () => {
    const res = await manager.post('/api/purchase-orders', order(6, 1000));
    assert.ok(res.status < 400, `ordering answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const id = res.json.id || res.json.poId || (res.json.po && res.json.po.id);
    assert.ok(id, `ordering answered no id: ${String(res.text).slice(0, 200)}`);
    const detail = await manager.get(`/api/purchase-orders/${encodeURIComponent(id)}`);
    assert.equal(detail.status, 200, `reading the order back answered ${detail.status}`);
    const line = (detail.json.items || [])[0];
    assert.ok(line && line.id, 'the order has no line to receive against');
    return { id, line, po_number: detail.json.po.po_number };
  });

  await audit.checkAsync('the order is open, it names the supplier, and it is on the record', async () => {
    const res = await owner.get(`/api/purchase-orders/${encodeURIComponent(po.id)}`);
    const header = res.json.po || {};
    assert.ok(['DRAFT', 'PENDING'].includes(String(header.status)), `a new order is ${header.status} — neither draft nor pending`);
    assert.equal(Number(header.total), 6000, `six units at ₦1,000 is ₦${header.total}`);
    assert.equal(header.supplier_name, supplier.name, `the order names ${header.supplier_name}`);
    assert.equal(String(header.branch_id), String(branch.id), 'the order is not filed against the branch that will take delivery');
    assert.equal(Number(po.line.quantity_in_base), 6, `the line covers ${po.line.quantity_in_base} units`);
    assert.equal(Number(po.line.quantity_received || 0), 0, 'a brand-new order already has units received against it');

    // THE SUPPLIER'S PAGE CARRIES IT — an order nobody records is a promise the books do not
    // know about, which is how a shop double-orders. The detail answers its orders by name
    // (`purchaseOrders`), so the check reads the ORDER rather than a summed figure that could be
    // right for the wrong reason.
    const sup = await owner.get(`/api/suppliers/${encodeURIComponent(supplier.id)}`);
    assert.equal(sup.status, 200, `the supplier answered ${sup.status}`);
    const orders = sup.json.purchaseOrders || [];
    const mine = orders.find((o) => String(o.id) === String(po.id));
    assert.ok(mine, `the open order is not among the ${orders.length} order(s) on the supplier's page`);
    assert.equal(Number(mine.total), 6000, `the supplier's copy of the order totals ₦${mine.total}`);
    audit.note(`supplier page: ${orders.length} order(s), our ₦${mine.total} open, ledger balance ₦${sup.json.supplier.balance_owed}`);

    const trail = await owner.get('/api/audit?action=PO_CREATED&limit=20');
    assert.ok((trail.json.data || []).some((r) => String(r.entity_id) === String(po.id)), 'the order is not on the audit trail');
  });

  // ------------------------------------------------------------------
  // FRONT TO BACK — PART, THEN THE REST
  // ------------------------------------------------------------------
  await audit.checkAsync('part of the order arrives, the balance stays open, then it closes', async () => {
    const part = await manager.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/receive`, {
      receipts: [{ item_id: po.line.id, quantity_received: 2, cost_per_unit: 1000 }],
    });
    assert.ok(part.status < 400, `receiving two units answered ${part.status}: ${String(part.text).slice(0, 240)}`);

    const mid = await owner.get(`/api/purchase-orders/${encodeURIComponent(po.id)}`);
    assert.equal(String(mid.json.po.status), 'PARTIALLY_RECEIVED', `after a part delivery the order is ${mid.json.po.status}`);
    const midLine = (mid.json.items || [])[0];
    assert.equal(Number(midLine.quantity_received), 2, `the line says ${midLine.quantity_received} received`);
    assert.equal(Number(mid.json.totals.receivedValue), 2000, `two units at ₦1,000 is ₦2,000 of goods received, and the order says ₦${mid.json.totals.receivedValue}`);

    // THE STOCK IS ON THE SHELF, from the supplier's delivery.
    const stock = await owner.get('/api/stock?limit=200');
    const onShelf = ((stock.json && stock.json.data) || [])
      .filter((r) => String(r.branch_id) === String(branch.id) && String(r.product_id) === String(pick.id))
      .reduce((a, r) => a + Number(r.on_shelf || 0), 0);
    assert.equal(onShelf, 2, `the branch shows ${onShelf} on the shelf after taking two`);

    // MORE THAN IS OUTSTANDING IS REFUSED — the order owes four, so five is not a delivery.
    const greedy = await manager.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/receive`, {
      receipts: [{ item_id: po.line.id, quantity_received: 5 }],
    });
    assert.equal(greedy.status, 400, `receiving 5 of an outstanding 4 answered ${greedy.status}`);
    assert.equal(greedy.json.code, 'OVER_RECEIPT', `refused as ${greedy.json.code}`);

    // ---- AND AN ORDER THAT HAS TAKEN DELIVERY CANNOT BE CANCELLED ----
    // The goods exist and the debt is real: the way out is a return or a reduced order, not a
    // cancellation that would erase the receipt.
    const tooLate = await manager.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/cancel`, { reason: 'changed our mind' });
    assert.equal(tooLate.status, 409, `cancelling a partly received order answered ${tooLate.status}`);
    assert.equal(tooLate.json.code, 'PO_PARTLY_RECEIVED', `refused as ${tooLate.json.code}`);
    assert.match(String(tooLate.json.error || ''), /already been received|goods exist/i, `the refusal should explain what the goods are: ${String(tooLate.json.error).slice(0, 180)}`);

    // THE REST.
    const rest = await manager.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/receive`, {
      receipts: [{ item_id: po.line.id, quantity_received: 4, cost_per_unit: 1000 }],
    });
    assert.ok(rest.status < 400, `receiving the balance answered ${rest.status}: ${String(rest.text).slice(0, 240)}`);
    const done = await owner.get(`/api/purchase-orders/${encodeURIComponent(po.id)}`);
    assert.equal(String(done.json.po.status), 'RECEIVED', `after the balance the order is ${done.json.po.status}`);
    assert.equal(Number((done.json.items || [])[0].quantity_received), 6, 'the two deliveries do not add up to the six ordered');
    assert.ok((done.json.receipts || []).length >= 2, `the order's history holds ${(done.json.receipts || []).length} receipt(s) — two deliveries should be two records`);
    audit.note(`${po.po_number}: 2 then 4, status ${done.json.po.status}, ${(done.json.receipts || []).length} receipts on the history`);

    // THE LONGER WAY OUT IS REFUSED TOO, and for the same reason.
    const afterFull = await manager.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/cancel`, { reason: 'no longer needed' });
    assert.equal(afterFull.status, 409, `cancelling a fully received order answered ${afterFull.status}`);
  });

  // ------------------------------------------------------------------
  // BACK TO FRONT — CANCELLING A COMMITMENT
  // ------------------------------------------------------------------
  await audit.checkAsync('an order that never arrived can be cancelled, with a reason a supplier could be shown', async () => {
    const second = await manager.post('/api/purchase-orders', order(3, 1200));
    assert.ok(second.status < 400, `the second order answered ${second.status}: ${String(second.text).slice(0, 200)}`);
    const id = second.json.id || second.json.poId;
    const detail = await manager.get(`/api/purchase-orders/${encodeURIComponent(id)}`);
    const line = (detail.json.items || [])[0];

    // A REASON IS REQUIRED, AND IT HAS TO SAY SOMETHING. The commitment was already recorded and
    // a supplier will ask — "x" is not an answer anybody can be shown.
    // NO REASON IS A MISSING FIELD; A TWO-LETTER REASON IS NOT AN ANSWER. The two refusals have
    // different codes on purpose — one says "tell me why", the other says "that is not why".
    const silent = await manager.post(`/api/purchase-orders/${encodeURIComponent(id)}/cancel`, {});
    assert.equal(silent.status, 400, `cancelling with no reason answered ${silent.status}`);
    assert.equal(silent.json.code, 'MISSING_FIELD', `refused as ${silent.json.code}`);
    const tooShort = await manager.post(`/api/purchase-orders/${encodeURIComponent(id)}/cancel`, { reason: 'no' });
    assert.equal(tooShort.status, 400, `cancelling with a two-letter reason answered ${tooShort.status}`);
    assert.equal(tooShort.json.code, 'REASON_REQUIRED', `a two-letter reason is refused as ${tooShort.json.code}`);
    assert.match(String(tooShort.json.error || ''), /supplier/i, `the refusal should say who will ask: ${String(tooShort.json.error).slice(0, 140)}`);

    // A CASHIER HAS NO STANDING TO UNDO A COMMITMENT.
    if (staff) {
      const notStaff = await staff.post(`/api/purchase-orders/${encodeURIComponent(id)}/cancel`, { reason: 'the price moved on us' });
      assert.equal(notStaff.status, 403, `a cashier cancelled a purchase order (${notStaff.status})`);
      assert.equal(notStaff.json.code, 'ROLE_REQUIRED', `refused as ${notStaff.json.code}`);
    }

    const before = await owner.get(`/api/suppliers/${encodeURIComponent(supplier.id)}`);
    // THE LEDGER BALANCE, not a list of orders: the route posts a credit against the commitment
    // when the order is created and reverses it on cancellation, and this is the figure a shop
    // reads as "what we owe this supplier".
    const owedBefore = Number(before.json.supplier.balance_owed || 0);
    audit.note(`supplier ledger before the cancellation: ₦${owedBefore}`);

    const cancelled = await manager.post(`/api/purchase-orders/${encodeURIComponent(id)}/cancel`, { reason: 'the supplier could not hold the price we agreed' });
    assert.ok(cancelled.status < 400, `cancelling answered ${cancelled.status}: ${String(cancelled.text).slice(0, 220)}`);

    const after = await owner.get(`/api/purchase-orders/${encodeURIComponent(id)}`);
    assert.equal(String(after.json.po.status), 'CANCELLED', `the cancelled order is ${after.json.po.status}`);
    assert.match(String(after.json.po.notes || ''), /Cancelled/i, 'the cancellation is not on the order itself — the supplier conversation is not documented');

    // THE COMMITMENT COMES OFF THE SUPPLIER'S BALANCE, or the shop's payable is wrong by the
    // whole order for ever.
    const owed = await owner.get(`/api/suppliers/${encodeURIComponent(supplier.id)}`);
    const owedAfter = Number(owed.json.supplier.balance_owed || 0);
    assert.equal(round2(owedBefore - owedAfter), 3600, `the supplier's ledger moved by ₦${round2(owedBefore - owedAfter)} when a ₦3,600 commitment was cancelled`);
    // AND THE ORDER LEAVES THE OPEN LIST — an order that stays "outstanding" after being
    // cancelled is a commitment the shop keeps paying attention to for no reason.
    const openIds = (owed.json.purchaseOrders || []).filter((o) => !['RECEIVED', 'CANCELLED'].includes(String(o.status))).map((o) => String(o.id));
    assert.ok(!openIds.includes(String(id)), 'the cancelled order is still counted among the supplier\'s open orders');

    // AND NOTHING CAN BE RECEIVED AGAINST IT.
    const tooLate = await manager.post(`/api/purchase-orders/${encodeURIComponent(id)}/receive`, {
      receipts: [{ item_id: line.id, quantity_received: 3, cost_per_unit: 1200 }],
    });
    assert.ok(tooLate.status >= 400, `receiving against a cancelled order answered ${tooLate.status}`);
    const twice = await manager.post(`/api/purchase-orders/${encodeURIComponent(id)}/cancel`, { reason: 'cancelling again' });
    assert.equal(twice.status, 409, `cancelling twice answered ${twice.status}`);
    assert.equal(twice.json.code, 'ALREADY_CANCELLED', `refused as ${twice.json.code}`);

    const trail = await owner.get('/api/audit?action=PO_CANCELLED&limit=20');
    assert.ok((trail.json.data || []).some((r) => String(r.entity_id) === String(id)), 'the cancellation is not on the audit trail');
    assert.ok((trail.json.data || []).length >= 1, 'no cancellation is on the trail at all');
  });

  // ------------------------------------------------------------------
  // THE SCREEN AND THE API, ON THE SAME CONTROL
  // ------------------------------------------------------------------
  await audit.checkAsync('the screen offers exactly the controls the API will accept', async () => {
    const view = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'purchase-orders.js'), 'utf8');
    const code = view
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

    // THE VOCABULARY: the route declares PO_STATUSES; the screen must speak the same five words.
    const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'finance.js'), 'utf8');
    const declared = /const PO_STATUSES = \[([^\]]*)\]/.exec(route);
    assert.ok(declared, 'PO_STATUSES is gone from the finance route');
    const words = declared[1].split(',').map((w) => w.trim().replace(/'/g, ''));
    for (const w of words) {
      if (w === 'DRAFT') continue; // the screen lists it as a filter option; every word must appear somewhere
      assert.ok(code.includes(`'${w}'`) || code.includes(`['${w}'`) || code.includes(`value: '${w}'`), `the screen never mentions the status ${w}`);
    }
    // AND NOTHING INVENTED — the ghost statuses from the transfer bug.
    for (const ghost of ['SENT', 'IN_PROGRESS', 'COMPLETE']) {
      assert.doesNotMatch(code, new RegExp(`['"]${ghost}['"]`), `the screen compares against '${ghost}', which this API cannot write`);
    }

    // THE CANCEL BUTTON IS GATED TO WHAT THE ROUTE ACCEPTS: an order that has taken delivery
    // cannot be cancelled, and offering the button anyway walks a person through a dialog and a
    // reason only to be refused.
    assert.match(code, /canCancelOrder/, 'the cancel control is no longer gated');
    assert.match(code, /quantity_received/, 'the screen no longer looks at whether anything was received before offering a cancellation');
    assert.match(code, /nothingReceived/, 'the cancel gate no longer checks for deliveries');

    // THE RECEIVE FORM ASKS FOR THE OUTSTANDING BALANCE, not the whole order.
    assert.match(code, /outstanding/, 'the receive path no longer considers what is outstanding');
    assert.match(code, /quantity_received/, 'the receive path no longer subtracts what has already arrived');
    // A REASON, because the route requires one.
    assert.match(code, /reason/, 'the cancel path no longer sends a reason, which the route requires');
  });
}, {
  setup: () => startDeployment({
    label: 'purchaseorders',
    businesses: [{
      name: 'PO Audit Trading', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'PO Audit Warehouse', code: 'PO-1', city: 'Abuja', state: 'FCT', branch_type: 'WAREHOUSE', opening_cash: 40000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'po-owner', pin: '96171', branchIndex: 0, full_name: 'PO Audit Owner' },
      { as: 'manager', role: 'MANAGER', username: 'po-manager', pin: '96172', branchIndex: 0, full_name: 'PO Audit Buyer' },
      { as: 'staff', role: 'STAFF', username: 'po-staff', pin: '96173', branchIndex: 0, full_name: 'PO Audit Storeman' },
    ],
  }),
});
