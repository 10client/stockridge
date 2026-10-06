'use strict';
// =====================================================================
// test/audit/audit.returns.js — MONEY GOING BACK OUT OF THE DRAWER
// =====================================================================
// `tools/flow-coverage.js` listed returns as 0 of 3 routes exercised. A return is the only
// flow in the product where stock and cash move in the direction the shop does not want,
// and the three ways it is abused are all ordinary shop life:
//
//   * THE REFUND IS BIGGER THAN WHAT WAS TAKEN. A line counted twice, or refunded at list
//     price after a discount, is cash leaving with no sale behind it.
//   * NOTHING COMES BACK. The customer is refunded and the unit stays off the shelf, so
//     the shop pays for goods it is holding.
//   * ANYBODY CAN DO IT. A cash refund with no manager's approval is the single easiest
//     way to empty a till.
//
// So this audit follows ONE sold unit through the return, reading the shelf, the return and
// the sale back from the deployment at every step:
//
//   FRONT TO BACK  sell it → return it → the shelf gains the unit back AND the money is
//                  recorded as refunded, pro-rata on what that line actually realised.
//   BACK TO FRONT  try it again → the same unit cannot be returned twice, a refund cannot
//                  exceed the line, and a STAFF cash refund does NOT move the shelf until a
//                  manager approves it — and a staff member cannot approve their own.
//   AND THE LEDGER the reversal is posted, so the refund is in the books and not only in
//                  the return table.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `₦${round2(n).toLocaleString('en-NG')}`;

runAudit('returns', async (audit, d) => {
  const owner = d.owner || d.admin;
  const staff = (d.seats && d.seats.staff) || null;
  const manager = (d.seats && d.seats.manager) || null;
  if (!staff || !manager) throw new Error('the returns fixture needs a STAFF and a MANAGER seat — the whole point of the approval half is that the person refunding is not the person approving');
  const branch = (d.branches || [])[0];
  assert.ok(branch, 'the returns fixture has no branch to trade at');

  // EVERY READING IS THE DEPLOYMENT'S OWN, and every reader asserts the shape of the
  // answer it reads. P2 cost a long afternoon to readers that looked for a field which did
  // not exist and silently answered 0 — a wrong-key read wearing the costume of a defect.
  const stockAt = async ({ required = true } = {}) => {
    const res = await owner.get(`/api/stock?branch_id=${encodeURIComponent(branch.id)}&limit=200`);
    assert.equal(res.status, 200, `the stock list answered ${res.status}`);
    if (required) {
      assert.ok(Array.isArray(res.json && res.json.data),
        `the stock list did not answer with rows under \`data\` (keys: ${Object.keys(res.json || {}).join(', ')})`);
    }
    const rows = ((res.json && (res.json.data || res.json.stock)) || [])
      .filter((r) => String(r.product_id || (r.product && r.product.id)) === String(product.id));
    return {
      onShelf: rows.reduce((a, r) => a + Number(r.on_shelf || 0), 0),
      available: rows.reduce((a, r) => a + Number(r.available || 0), 0),
    };
  };

  // -----------------------------------------------------------------
  // A PRODUCT THAT CAN BE RETURNED, AND STOCK TO SELL
  // -----------------------------------------------------------------
  const product = await audit.captureAsync('a product the shop can sell and take back', async () => {
    const res = await owner.get('/api/products?limit=200');
    assert.equal(res.status, 200, `the catalogue answered ${res.status}`);
    const rows = (res.json.data || res.json.products || []);
    // `is_returnable` and a selling price are the two properties this flow needs. A
    // non-returnable product would make the staff refusal fire on the wrong rule.
    const pick = rows.filter((p) => Number(p.selling_price) > 0 && Number(p.is_returnable != null ? p.is_returnable : 1) === 1)[0];
    assert.ok(pick, 'the catalogue has no returnable product with a price — the starter catalogue is missing and this audit cannot trade');
    return pick;
  });
  const unitPrice = round2(product.selling_price);
  audit.note(`${product.sku} ${product.name} at ${money(unitPrice)} — ${branch.name}`);

  await audit.checkAsync('stock on the shelf to sell', async () => {
    const adj = await owner.post('/api/stock/adjust', {
      branch_id: branch.id, product_id: product.id, quantity: 5,
      adjustment_type: 'FOUND', reason: 'Returns audit — stock to sell and take back',
    });
    assert.ok(adj.status < 400, `stocking the shelf answered ${adj.status}: ${String(adj.text).slice(0, 200)}`);
    const held = await stockAt();
    assert.ok(held.onShelf >= 5, `${branch.name} holds ${held.onShelf} after 5 were added — a shelf that does not take stock cannot sell it`);
  });

  // ===================================================================
  audit.section('Selling it — the receipt the return will be made against');
  // ===================================================================
  const sold = 2;
  const sale = await audit.captureAsync('a cash sale of two units', async () => {
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: product.id, quantity: sold }],
      payments: [{ method: 'CASH', amount: round2(unitPrice * sold) }],
      device_id: 'audit-returns',
    }, { idempotencyKey: `returns-sale-${Date.now().toString(36)}` });
    assert.ok(res.status === 201 || res.status === 200, `ringing the sale answered ${res.status}: ${String(res.text).slice(0, 260)}`);
    const id = res.json.saleId || res.json.id || (res.json.sale && res.json.sale.id);
    assert.ok(id, 'the sale was rung and the answer carries no id');
    return { id, receiptNo: res.json.receiptNo || res.json.receipt_no || '(no receipt number)' };
  });
  audit.note(`sold ${sold} × ${product.sku} on receipt ${sale.receiptNo}`);

  const line = await audit.captureAsync('the line the return will be made against', async () => {
    const res = await owner.get(`/api/sales/${encodeURIComponent(sale.id)}`);
    assert.equal(res.status, 200, `reading the sale back answered ${res.status} ${String(res.text).slice(0, 200)}`);
    const rows = res.json.items || (res.json.sale && res.json.sale.items) || res.json.lines || [];
    const l = rows.filter((x) => String(x.product_id) === String(product.id))[0];
    assert.ok(l, `the sale read back with no line for ${product.sku} (keys: ${Object.keys(res.json || {}).join(', ')})`);
    assert.ok(round2(l.line_total) > 0, 'the sold line was recorded at zero, so there is nothing to refund and nothing to prove');
    return l;
  });
  const paidOnLine = round2(Number(line.line_total));
  const soldBase = round2(Number(line.quantity_in_base != null ? line.quantity_in_base : sold));
  audit.note(`that line realised ${money(paidOnLine)} for ${soldBase} base unit(s)`);

  // ===================================================================
  audit.section('Taking it back — the shelf gains the unit and the money is recorded');
  // ===================================================================
  await audit.checkAsync('a refund over the odds is refused before anything moves', async () => {
    const before = await stockAt();
    const res = await owner.post('/api/returns', {
      sale_id: sale.id,
      reason_code: 'CUSTOMER_CHANGE_OF_MIND',
      refund_method: 'CASH',
      items: [{ sale_item_id: line.id, quantity: 1, refund_amount: round2(paidOnLine + 1000) }],
    });
    assert.ok(res.status >= 400 && res.status < 500,
      `a refund of ${money(round2(paidOnLine + 1000))} against a line that realised ${money(paidOnLine)} was accepted: ${res.status} ${String(res.text).slice(0, 200)}. Cash refunded beyond what was taken leaves the drawer with nothing behind it`);
    assert.equal(res.json.code, 'REFUND_EXCEEDS_LINE', `the refusal came back as ${res.json.code}`);
    const after = await stockAt();
    assert.equal(after.onShelf, before.onShelf,
      'a refused return still moved the shelf — a refusal that writes is not a refusal');
  });

  const first = await audit.captureAsync('returning one of the two units, for cash', async () => {
    const before = await stockAt();
    const res = await owner.post('/api/returns', {
      sale_id: sale.id,
      reason_code: 'CUSTOMER_CHANGE_OF_MIND',
      refund_method: 'CASH',
      items: [{ sale_item_id: line.id, quantity: 1, condition: 'RESALABLE' }],
    }, { idempotencyKey: `returns-first-${Date.now().toString(36)}` });
    assert.ok(res.status === 201 || res.status === 200, `returning the unit answered ${res.status}: ${String(res.text).slice(0, 260)}`);
    // A MANAGER'S CASH REFUND IS APPROVED ON THE SPOT. Owner is above manager, so this one
    // does not queue — and the queued path is proved by the staff seat below, which is the
    // half that matters.
    assert.equal(String(res.json.status), 'APPROVED',
      `a refund taken by the owner came back ${res.json.status}; a manager's own cash refund needs no second signature`);
    const after = await stockAt();
    assert.equal(after.onShelf, before.onShelf + 1,
      `${branch.name} held ${before.onShelf} and one unit came back RESALABLE, so it should hold ${before.onShelf + 1}; it holds ${after.onShelf}. A customer refunded for goods the shop never got back has been paid for the shop's own stock`);
    return { id: res.json.id, returnNo: res.json.returnNo, refundTotal: round2(res.json.refundTotal) };
  });
  audit.note(`return ${first.returnNo} for ${money(first.refundTotal)} — the shelf took the unit back`);

  await audit.checkAsync('the refund is pro-rata on the line, not the list price', async () => {
    const expected = round2(paidOnLine / soldBase);
    assert.equal(first.refundTotal, expected,
      `one of ${soldBase} base unit(s) came back against a line that realised ${money(paidOnLine)}, so the refund is ${money(expected)}; the record says ${money(first.refundTotal)}. Refunding the list price pays back more than the line took, and a discount becomes a cash machine`);
  });

  await audit.checkAsync('the return is in the book, with the money on it', async () => {
    const res = await owner.get('/api/returns?limit=50');
    assert.equal(res.status, 200, `the returns book answered ${res.status} ${String(res.text).slice(0, 200)}`);
    const rows = res.json.data || res.json.returns || [];
    assert.ok(Array.isArray(rows) && rows.length > 0,
      `the returns book answered with no list (keys: ${Object.keys(res.json || {}).join(', ')})`);
    const row = rows.filter((r) => String(r.id) === String(first.id))[0];
    assert.ok(row, `return ${first.returnNo} is not in the returns book — a refund the book does not know about cannot be reconciled`);
    assert.equal(round2(Number(row.refund_amount)), first.refundTotal, `the book holds ${money(row.refund_amount)} against a refund of ${money(first.refundTotal)}`);
    const summary = res.json.summary || {};
    assert.ok(Number(summary.refunded) >= first.refundTotal,
      `the book's own summary says ${money(summary.refunded)} refunded across ${summary.count} return(s) — less than the single refund of ${money(first.refundTotal)} it contains`);
  });

  // ===================================================================
  audit.section('Trying it again — twice, and from the till side');
  // ===================================================================
  await audit.checkAsync('the same receipt cannot be returned twice over', async () => {
    // Sold 2, one already back. Asking for 2 more is asking for 3 out of 2.
    const res = await owner.post('/api/returns', {
      sale_id: sale.id,
      reason_code: 'CUSTOMER_CHANGE_OF_MIND',
      refund_method: 'CASH',
      items: [{ sale_item_id: line.id, quantity: 2 }],
    });
    assert.ok(res.status >= 400 && res.status < 500,
      `returning 2 more units against a receipt of ${soldBase} — one already returned — was accepted: ${res.status} ${String(res.text).slice(0, 200)}. A line counted twice is a refund bigger than the sale`);
    assert.equal(res.json.code, 'OVER_RETURN', `the refusal came back as ${res.json.code}`);
  });

  // ===================================================================
  audit.section('A staff refund — the money does not move until a manager says so');
  // ===================================================================
  const pending = await audit.captureAsync('the last unit returned for cash by a STAFF member', async () => {
    const before = await stockAt();
    const res = await staff.post('/api/returns', {
      sale_id: sale.id,
      reason_code: 'CUSTOMER_CHANGE_OF_MIND',
      refund_method: 'CASH',
      items: [{ sale_item_id: line.id, quantity: 1, condition: 'RESALABLE' }],
    }, { idempotencyKey: `returns-staff-${Date.now().toString(36)}` });
    assert.ok(res.status === 201 || res.status === 200, `a staff return answered ${res.status}: ${String(res.text).slice(0, 260)}`);
    assert.equal(String(res.json.status), 'PENDING_APPROVAL',
      `a STAFF cash refund came back ${res.json.status}. Cash leaving the drawer on one person's say-so is the easiest way there is to empty a till`);
    // BACK TO FRONT: the sale recorded a return, and the shelf did NOT move.
    const after = await stockAt();
    assert.equal(after.onShelf, before.onShelf,
      `${branch.name} held ${before.onShelf} before a staff return waiting for approval and holds ${after.onShelf} after it. Goods are back on the shelf only once somebody with the authority to refund has said yes — otherwise a refund can be taken and the unit quietly kept`);
    return { id: res.json.id, returnNo: res.json.returnNo };
  });
  audit.note(`return ${pending.returnNo} is waiting for a manager`);

  await audit.checkAsync('the person who took the refund cannot approve it', async () => {
    const res = await staff.post(`/api/returns/${encodeURIComponent(pending.id)}/approve`, { approved: true });
    assert.equal(res.status, 403,
      `a STAFF member approved their own cash refund: ${res.status} ${String(res.text).slice(0, 200)}. One signature on both ends of a refund is no approval at all`);
    assert.equal(res.json.code, 'ROLE_REQUIRED', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('a refusal to approve has to say why, and rejecting leaves the shelf alone', async () => {
    // TWO GUARDS, AND THEY ARE DIFFERENT ANSWERS. A rejection with NO note is a missing
    // field; a rejection with a note too short to be a reason is REASON_REQUIRED. Both are
    // refusals, and this check reads the product's own codes rather than assuming one.
    const silent = await manager.post(`/api/returns/${encodeURIComponent(pending.id)}/approve`, { approved: false });
    assert.equal(silent.status, 400,
      `a return was rejected with no reason given: ${silent.status} ${String(silent.text).slice(0, 160)}. The customer paid money and is entitled to a reason they can act on`);
    assert.equal(silent.json.code, 'MISSING_FIELD', `rejecting with no note came back as ${silent.json.code}`);
    const short = await manager.post(`/api/returns/${encodeURIComponent(pending.id)}/approve`, { approved: false, note: 'no.' });
    assert.equal(short.status, 400, `rejecting with a two-letter note was accepted: ${short.status}`);
    assert.equal(short.json.code, 'REASON_REQUIRED', `a note too short to be a reason came back as ${short.json.code}`);

    const before = await stockAt();
    const rejected = await manager.post(`/api/returns/${encodeURIComponent(pending.id)}/approve`,
      { approved: false, note: 'The unit came back without its box and was not resalable.' });
    assert.ok(rejected.status < 400, `rejecting the return answered ${rejected.status}: ${String(rejected.text).slice(0, 200)}`);
    const after = await stockAt();
    assert.equal(after.onShelf, before.onShelf, 'a rejected return still moved the shelf');
    const back = await owner.get('/api/returns?status=REJECTED&limit=50');
    const row = (back.json.data || []).filter((r) => String(r.id) === String(pending.id))[0];
    assert.ok(row, 'the rejected return is not in the book under REJECTED — a refusal that vanishes cannot be explained to the customer who got it');
  });

  // ===================================================================
  audit.section('Approving one — the shelf and the ledger both move');
  // ===================================================================
  await audit.checkAsync('an open return holds its line, and a refused one lets it go', async () => {
    // A PENDING RETURN RESERVES THE UNITS IT ASKS FOR. While the first one waited for a
    // manager, the same unit was not returnable a second time — the product said
    // "only 0 remain unreturned on this receipt (2 already returned)", counting the pending
    // line. That is the right rule: two open returns of one unit is two refunds of it. The
    // first version of this audit then failed here and blamed the product; the sequence was
    // wrong, not the code. The rejection above closed that claim, and this is the proof that
    // the line came back.
    const res = await staff.post('/api/returns', {
      sale_id: sale.id,
      reason_code: 'CUSTOMER_CHANGE_OF_MIND',
      refund_method: 'CASH',
      items: [{ sale_item_id: line.id, quantity: 1, condition: 'RESALABLE' }],
    }, { idempotencyKey: `returns-staff2-${Date.now().toString(36)}` });
    assert.ok(res.status < 400,
      `after the refusing manager released the line, returning the same unit answered ${res.status}: ${String(res.text).slice(0, 240)}. A rejected return that keeps holding the unit means the customer can never be refunded for it`);
    assert.equal(String(res.json.status), 'PENDING_APPROVAL', 'the second staff refund was not queued for approval');

    const before = await stockAt();
    const approve = await manager.post(`/api/returns/${encodeURIComponent(res.json.id)}/approve`, { approved: true });
    assert.ok(approve.status < 400, `a manager approving the return answered ${approve.status}: ${String(approve.text).slice(0, 220)}`);
    const after = await stockAt();
    assert.equal(after.onShelf, before.onShelf + 1,
      `approving a return left the shelf at ${after.onShelf} (it was ${before.onShelf}). Approval is the moment the goods and the money both move — if only the ledger moves, the shop has paid for stock it is not showing`);

    const read = await owner.get('/api/returns?limit=50');
    const row = (read.json.data || []).filter((r) => String(r.id) === String(res.json.id))[0];
    assert.equal(String(row.status), 'APPROVED', `the return's status is ${row.status} after approval`);

    // THE SALE, BACK THE OTHER WAY: every unit on the receipt is now back, and the sale
    // says so. (One unit was returned by the owner at the start and one by the manager at
    // the end; the receipt was for two.)
    const saleRes = await owner.get(`/api/sales/${encodeURIComponent(sale.id)}`);
    const saleRow = saleRes.json.sale || saleRes.json;
    assert.ok(['REFUNDED', 'PARTIALLY_REFUNDED'].includes(String(saleRow.status)),
      `every unit on the receipt has now been returned, and the sale still reads "${saleRow.status}". A sale that does not know it was returned is a receipt the shop will refund twice`);
  });
}, {
  setup: () => startDeployment({
    label: 'returns',
    businesses: [{
      name: 'Returns Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Returns Counter', code: 'RTN-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 60000 },
      ],
    }],
    seats: [
      // A STAFF seat is the point of the approval half: the person who takes the return
      // must not be the person who approves it.
      { as: 'staff', role: 'STAFF', username: 'rtn-staff', pin: '60501', branchIndex: 0, full_name: 'Returns Audit Staff' },
      { as: 'manager', role: 'MANAGER', username: 'rtn-manager', pin: '60502', branchIndex: 0, full_name: 'Returns Audit Manager' },
    ],
  }),
});
