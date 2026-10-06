'use strict';
// =====================================================================
// test/e2e/repaired-flows.test.js — THE FOUR STATEMENTS THAT COULD NEVER RUN
// =====================================================================
// A static audit of every hand-written statement (tools/sql-audit.js) found four
// INSERTs whose VALUES tuple had one more placeholder than the array supplied
// values. Each was in a real flow — a return, a sales target, funding a till
// float from the safe, and moving cash to the safe on till close — and each
// would have failed at the counter with:
//
//   "Too few parameter values were provided … the statement has N placeholder(s)
//    but received M value(s)"
//
// which names no statement, no screen and no fix.
//
// They had never run. Every one of them was written, reviewed, committed and
// tested-by-reading. So this file does the only thing that proves they work now:
// it drives each flow end to end and asserts the outcome, not the SQL.
//
// The two cash movements are tested through the ACTUAL safe balance, because the
// bug in one of them was a missing till_session_id and the row would have looked
// fine while pointing at the wrong session.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { tradingDeployment } = require('../helpers/deployment');
const { watToday, addDays, watNow } = require('../../domain/time');

test('a return can be raised and approved', async (t) => {
  const world = await tradingDeployment({ label: 'return', quantity: 5 });
  t.after(world.cleanup);

  assert.ok(world.saleItemId, 'the sale must come back with at least one line to return');

  const created = await world.call('POST', '/api/returns', {
    token: world.ownerToken,
    body: {
      sale_id: world.saleId,
      reason_code: 'DEFECTIVE',
      refund_method: 'CASH',
      // DEFECTIVE rather than RESALABLE: a broken unit must not go back on the
      // shelf, and the restock branch is where the second half of the bug lived.
      restock: false,
      items: [{ sale_item_id: world.saleItemId, quantity: 1, condition: 'DEFECTIVE', notes: 'screen came cracked' }],
    },
  });
  assert.equal(created.status, 201, `raising the return failed: ${created.text.slice(0, 400)}`);
  assert.ok(created.json.id, 'a return must come back with an id');
  assert.ok(Number(created.json.refundTotal) > 0, `a refund must have a value: ${created.text.slice(0, 200)}`);

  // A return raised by an owner may be approved on the spot — the approval
  // route is how a return that was HELD gets released, and it refuses to run
  // twice (409 NOT_PENDING). So the test approves only when the return is
  // actually waiting, and otherwise asserts the auto-approval, which is the
  // same outcome reached without the second request.
  const createdRow = await world.db.first('SELECT status FROM sale_returns WHERE id = ?', [String(created.json.id)]);
  if (createdRow.status === 'PENDING_APPROVAL') {
    const approved = await world.call('POST', `/api/returns/${created.json.id}/approve`, {
      token: world.ownerToken,
      body: { approved: true, note: 'Confirmed defective on inspection.' },
    });
    assert.equal(approved.status, 200, `approving the return failed: ${approved.text.slice(0, 500)}`);
  } else {
    assert.equal(createdRow.status, 'APPROVED', `a return in an unexpected state: ${createdRow.status}`);
  }

  const row = await world.db.first('SELECT * FROM sale_returns WHERE id = ?', [String(created.json.id)]);
  assert.equal(row.status, 'APPROVED', `expected the return to be APPROVED, got ${row.status}`);
  assert.ok(Number(row.refund_amount) > 0, 'the return row must carry the refund it authorised');

  // The line rows are what the repaired statement wrote. A return with no lines
  // is a refund with nothing behind it.
  const lines = await world.db.all('SELECT * FROM sale_return_items WHERE sale_return_id = ? AND is_deleted = 0', [String(created.json.id)]);
  assert.equal(lines.length, 1, `expected one return line, found ${lines.length}`);
  assert.equal(lines[0].condition, 'DEFECTIVE');
  assert.ok(lines[0].refund_amount != null, 'the line must record what it refunded');

  // A DEFECTIVE return must NOT restock: the unit is still unsellable.
  const batches = await world.db.scalar(
    'SELECT COALESCE(SUM(quantity),0) FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0',
    [String(world.product.id), String(world.branchId)],
  );
  assert.equal(Number(batches), world.quantity - 1, 'a defective return must not put stock back on the shelf');
});

test('a sales target can be set, and it shows up in the target report', async (t) => {
  const world = await tradingDeployment({ label: 'target' });
  t.after(world.cleanup);

  const periodStart = `${watToday().slice(0, 7)}-01`;
  const periodEnd = addDays(periodStart, 30);

  const created = await world.call('POST', '/api/reports/targets', {
    token: world.ownerToken,
    body: {
      period_type: 'MONTHLY',
      period_start: periodStart,
      period_end: periodEnd,
      target_revenue: 5000000,
      target_units: 60,
      target_margin: 1200000,
    },
  });
  assert.equal(created.status, 201, `setting a target failed: ${created.text.slice(0, 500)}`);
  assert.ok(created.json.id, 'a target must come back with an id');

  const row = await world.db.first('SELECT * FROM sales_targets WHERE id = ?', [String(created.json.id)]);
  assert.equal(Number(row.target_revenue), 5000000);
  assert.ok(row.created_at, 'a target must be timestamped — created_at was the column the extra placeholder was stealing');

  const listed = await world.call('GET', `/api/reports/targets?${world.scope}`, { token: world.ownerToken });
  assert.equal(listed.status, 200, listed.text.slice(0, 200));
  assert.ok(Array.isArray(listed.json.data), 'the target report must return rows');
});

test('a till float can be funded from the safe, and cash can be returned to it on close', async (t) => {
  const world = await tradingDeployment({ label: 'safe' });
  t.after(world.cleanup);

  const safeBalance = async () => {
    const r = await world.call('GET', `/api/safe?${world.scope}`, { token: world.ownerToken });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    return Number((r.json.balance && (r.json.balance.balance ?? r.json.balance)) || r.json.balance_after || 0);
  };

  // ---- put money in the safe first, or funding a float has nothing to draw on
  const deposit = await world.call('POST', '/api/safe/entries', {
    token: world.ownerToken,
    body: { branch_id: world.branchId, entry_type: 'DEPOSIT', amount: 50000, note: 'Owner top-up for the float' },
  });
  assert.equal(deposit.status, 201, `safe deposit failed: ${deposit.text.slice(0, 400)}`);
  const afterDeposit = await safeBalance();
  assert.ok(afterDeposit >= 50000, `the safe should hold at least ₦50,000 after a deposit, holds ${afterDeposit}`);

  // ---- open a till funded from the safe: the repaired TILL_FUND statement
  const till = await world.call('POST', '/api/tills/open', {
    token: world.ownerToken,
    body: { branch_id: world.branchId, opening_cash: 20000, from_safe: true, device_id: 'safe-test-device' },
  });
  assert.equal(till.status, 201, `opening a till funded from the safe failed: ${till.text.slice(0, 500)}`);
  const tillId = String(till.json.id || (till.json.till && till.json.till.id));

  const fund = await world.db.first(
    "SELECT * FROM branch_safe_ledger WHERE entry_type = 'TILL_FUND' AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1",
  );
  assert.ok(fund, 'funding a float from the safe must write a safe-ledger row');
  assert.equal(Number(fund.amount), -20000, 'money leaving the safe is recorded negative');
  assert.equal(String(fund.till_session_id), tillId, 'the safe movement must point at the till session it funded');
  assert.equal(String(fund.reference_id), tillId, 'and at the same session from the ledger side');

  // ---- ring up a sale in this till so there is cash to move back
  const saleTwo = await world.call('POST', '/api/sales', {
    token: world.ownerToken,
    body: {
      branch_id: world.branchId,
      business_id: world.businessId,
      sale_type: 'RETAIL',
      sold_at: watNow(),
      device_id: 'safe-test-device',
      payments: [{ method: 'CASH', amount: world.price }],
      lines: [{ product_id: world.product.id, variant_id: world.variantId || undefined, quantity: 1, unit_code: world.baseUnit, unit_price: world.price }],
    },
  });
  assert.equal(saleTwo.status, 201, `the second sale failed: ${saleTwo.text.slice(0, 300)}`);

  // ---- close the till, moving everything back to the safe: the repaired
  //      TILL_RETURN statement
  const counted = 20000 + world.price;
  const closed = await world.call('POST', `/api/tills/${tillId}/close`, {
    token: world.ownerToken,
    body: { counted_cash: counted, to_safe: counted, device_id: 'safe-test-device' },
  });
  assert.equal(closed.status, 200, `closing the till failed: ${closed.text.slice(0, 600)}`);

  const back = await world.db.first(
    "SELECT * FROM branch_safe_ledger WHERE entry_type = 'TILL_RETURN' AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1",
  );
  assert.ok(back, 'moving cash to the safe on till close must write a safe-ledger row');
  assert.equal(Number(back.amount), counted, 'money arriving in the safe is recorded positive');
  assert.equal(String(back.till_session_id), tillId, 'the safe movement must point at the till session it came from');

  // ---- and the safe balance is what the ledger says: deposit − float + return
  const finalBalance = await safeBalance();
  assert.equal(finalBalance, 50000 - 20000 + counted, `the safe should hold ₦${50000 - 20000 + counted}, it holds ₦${finalBalance}`);

  const tillRow = await world.db.first('SELECT * FROM till_sessions WHERE id = ?', [tillId]);
  assert.equal(tillRow.status, 'CLOSED');
  assert.equal(Number(tillRow.counted_cash), counted);
  assert.equal(Number(tillRow.variance), 0, 'a till closed at its expected count has no variance');
});
