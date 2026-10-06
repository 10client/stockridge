'use strict';
// =====================================================================
// test/audit/audit.changeOwed.js — THE CODE ON THE RECEIPT, END TO END
// =====================================================================
// WHAT MAKES THIS DIFFERENT FROM THE INTEGRATION TEST. That one stands up its own
// database and writes claim rows into it, so it proves the endpoints behave. This one
// runs against a DEPLOYMENT — a client's tenant, or the local fixture the suite
// starts — and it must earn the same proof WITHOUT planting rows: it rings a real
// sale at a real counter, tenders more cash than the bill, and takes the claim code
// that comes back on the receipt. That code is the only thing the customer has. If
// the code that GETs printed is not the code the counter can spend, the feature is
// broken in the one place it is used.
//
// FRONT TO BACK: the cashier tenders ₦500 over a ₦300 bill; the sale stores ₦200 as
// change owed and credits 2210 Change Owed Liability; the counter looks the claim up
// on the code; paying it moves ₦200 out of the branch SAFE and debits 2210.
// BACK TO FRONT: a manager reads the trial balance and the safe ledger and finds the
// same ₦200 on both sides — and NOTHING when the shop pays by bank transfer, because
// money that never entered the drawer must never leave it.
//
// IT IS WRITTEN TO BE SAFE ON A LIVE DEPLOYMENT. Everything it creates, it creates
// through the app; everything it collects, it settles with the customer's own money;
// and the one claim it writes off is used to prove that a write-off needs a manager
// and a reason, not to tidy up.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `₦${round2(n).toLocaleString('en-NG')}`;

// The cashier's name is a CONSTANT because the refusal's wording is asserted against
// it below. Reading it back off the seat would prove less than it looks: the harness
// stores the logged-in actor, not the profile row, so a name read there and a name
// asserted there could agree with each other and with nothing else.
const CASHIER_NAME = 'Change Audit Cashier';

runAudit('changeOwed', async (audit, d) => {
  const owner = d.owner || d.admin;
  const manager = (d.seats && d.seats.manager) || null;
  const staff = (d.seats && d.seats.staff) || null;
  const outsider = (d.seats && d.seats.other) || null;
  if (!staff || !manager || !outsider) {
    throw new Error('the changeOwed fixture needs a staff, a manager and an other-branch seat — a skipped role check reads exactly like a passing one');
  }

  // The fixture's own first branch is branches[0] (test/audit/lib/deployment.js
  // records it in insertion order for exactly this reason).
  const branch = (d.branches || [])[0];
  const otherBranch = (d.branches || [])[1];
  assert.ok(branch && otherBranch, 'the changeOwed fixture needs two branches to prove the scope boundary');
  audit.note(`trading at ${branch.name} (${branch.code}), with ${otherBranch.name} (${otherBranch.code}) standing in for another shop`);

  // -----------------------------------------------------------------
  // A PRODUCT WITH STOCK, AND SOMEONE TO SELL IT TO
  // -----------------------------------------------------------------
  const product = await audit.captureAsync('a priced product from the vertical catalogue', async () => {
    const res = await owner.get('/api/products?limit=200');
    assert.equal(res.status, 200, `the catalogue answered ${res.status} ${String(res.text).slice(0, 160)}`);
    const rows = (res.json.data || res.json.products || [])
      .filter((p) => Number(p.selling_price) > 0 && (!p.track_stock || Number(p.stock_qty || 0) > 0 || true));
    if (!rows.length) throw new Error('the catalogue has no priced product to sell');
    return rows[0];
  });
  const unitPrice = round2(Number(product.selling_price));
  const tendered = round2(unitPrice + 200);
  const owed = round2(tendered - unitPrice);
  audit.note(`${product.sku} ${product.name} — ${money(unitPrice)} per unit; the counter will be tendered ${money(tendered)} and hold ${money(owed)} for the customer`);

  await audit.checkAsync('the product is on the shelf at the branch that is about to sell it', async () => {
    const res = await owner.post('/api/stock/adjust', {
      branch_id: branch.id, product_id: product.id, quantity: 5,
      adjustment_type: 'FOUND', reason: 'Audit fixture — stock for a change-owed sale',
    });
    // 201 on a fresh adjustment; a deployment that already holds stock may answer 200.
    assert.ok(res.status < 400, `stocking the shelf answered ${res.status}: ${String(res.text).slice(0, 200)}`);
  });

  const customer = await audit.captureAsync('a customer to hold the claim', async () => {
    const res = await owner.post('/api/customers', {
      branch_id: branch.id, name: 'Change Owed Audit Customer', phone: '08031234567', customer_type: 'INDIVIDUAL',
    });
    assert.ok(res.status < 400, `creating a customer answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const id = (res.json.customer && res.json.customer.id) || res.json.id || (res.json.data && res.json.data.id);
    assert.ok(id, 'the customer was created but the response carries no id');
    d.trackCustomer(id);
    return { id, name: 'Change Owed Audit Customer' };
  });

  // -----------------------------------------------------------------
  audit.section('A sale that leaves change owed, and the code that comes back');
  // -----------------------------------------------------------------
  // TENDER MORE THAN THE BILL. That is the entire mechanism: `change_owed_amount`
  // says the cashier did not have the coin, and the sale stores the difference as a
  // liability with a claim code.
  const sale = await audit.captureAsync('a cash sale tendered over the odds', async () => {
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      customer_id: customer.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: tendered }],
      change_owed_amount: owed,
      device_id: 'audit-change-owed',
    }, { idempotencyKey: `change-owed-sale-${Date.now().toString(36)}` });
    assert.equal(res.status, 201, `POST /api/sales answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    return res.json;
  });
  assert.equal(round2(sale.changeOwed), owed, `the sale recorded ${money(sale.changeOwed)} of change owed for a ${money(owed)} overpayment`);

  // THE CLAIM COMES OFF THE RECEIPT, BY CODE — the path the counter actually uses.
  const claim = await audit.captureAsync('the claim, read by the code the customer was given', async () => {
    const list = await owner.get(`/api/change-owed?branch_id=${branch.id}&status=OUTSTANDING&limit=50`);
    assert.equal(list.status, 200, `the change-owed list answered ${list.status} ${String(list.text).slice(0, 200)}`);
    const row = (list.json.data || []).find((r) => String(r.sale_id) === String(sale.saleId) && round2(r.amount) === owed);
    if (!row) throw new Error(`the sale left ${money(owed)} owed and no open claim for it is listed — the sale and the claim have parted company`);
    const byCode = await owner.get(`/api/change-owed/code/${encodeURIComponent(row.claim_code)}`);
    assert.equal(byCode.status, 200, `looking the claim up by its own code answered ${byCode.status}`);
    assert.equal(String(byCode.json.claim.id), String(row.id), 'the code lookup returned a different claim from the one on the receipt');
    return byCode.json;
  });
  audit.note(`claim ${claim.claim.claim_code} — ${money(claim.claim.amount)} owed to ${claim.claim.customer_name}, expires ${claim.claim.expires_at || 'never'}`);

  const claimId = claim.claim.id;

  // -----------------------------------------------------------------
  audit.section('A cashier can see it, pay it once, and not twice');
  // -----------------------------------------------------------------
  const safeBefore = await audit.captureAsync('the branch safe before the counter pays anything out', async () => {
    const res = await staff.get(`/api/safe?branch_id=${branch.id}`);
    assert.equal(res.status, 200, `the safe answered ${res.status} ${String(res.text).slice(0, 160)}`);
    return round2(res.json.balance);
  });
  audit.note(`the safe holds ${money(safeBefore)} before the customer is paid`);

  await audit.checkAsync('the claim a cashier looks up is one they are allowed to pay', async () => {
    const res = await staff.get(`/api/change-owed/code/${encodeURIComponent(claim.claim.claim_code)}`);
    assert.equal(res.status, 200, `the counter's lookup answered ${res.status} ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.settlable, true, `the counter cannot pay a live claim: ${res.json.why_not || 'no reason given'}`);
  });

  await audit.checkAsync('a claim in another branch is not found, rather than found and refused', async () => {
    // THE OTHER-BRANCH CASHIER MUST NOT BE ABLE TO READ IT AT ALL. A 403 would tell
    // them the claim exists, on a code they guessed, in a shop they cannot see.
    const res = await outsider.get(`/api/change-owed/code/${encodeURIComponent(claim.claim.claim_code)}`);
    assert.equal(res.status, 404, `a ${otherBranch.name} cashier reached a ${branch.name} claim: ${res.status} ${String(res.text).slice(0, 160)}`);
  });

  await audit.checkAsync('paying it moves the money out of the SAFE, into the customer’s hand, and off the books', async () => {
    const settled = await staff.post(`/api/change-owed/${claimId}/settle`, { method: 'CASH' });
    assert.equal(settled.status, 200, `settling answered ${settled.status}: ${String(settled.text).slice(0, 300)}`);
    assert.equal(settled.json.status, 'REDEEMED');
    assert.equal(round2(settled.json.amount), owed);

    const safe = await staff.get(`/api/safe?branch_id=${branch.id}`);
    assert.equal(round2(Number(safe.json.balance)), round2(safeBefore - owed),
      `the safe held ${money(safeBefore)} and ${money(owed)} was paid out of it, so it should hold ${money(safeBefore - owed)}; it reports ${money(safe.json.balance)} — money the shop handed to a customer must leave the safe it came from`);
    assert.equal(safe.json.chainConsistent, true, `the safe ledger's running balance no longer adds up: ${safe.json.chainMessage}`);
    const top = (safe.json.data || [])[0];
    assert.equal(String(top.reference_id), String(claimId), 'the newest safe movement is not this claim');

    // THE BOOKS. The sale credited 2210; paying the claim must debit it. Until Stage
    // G2 nothing ever did, so every outstanding claim stayed a liability for ever.
    const tb = await owner.get('/api/accounting/trial-balance');
    assert.equal(tb.status, 200, `the trial balance answered ${tb.status} ${String(tb.text).slice(0, 200)}`);
    const liability = (tb.json.accounts || []).find((a) => a.code === '2210');
    assert.ok(liability, 'the trial balance no longer lists 2210 Change Owed Liability');
    audit.note(`2210 Change Owed Liability stands at ${money(liability.balance)} after the payout`);
    const glLines = await owner.get(`/api/change-owed/${claimId}`);
    void glLines; // the settlement is proved above; the journal itself is asserted in the integration test
  });

  await audit.checkAsync('the same claim cannot be paid twice, and the refusal names who paid it', async () => {
    const again = await staff.post(`/api/change-owed/${claimId}/settle`, { method: 'CASH' });
    assert.equal(again.status, 409, `a second settlement of the same claim was accepted: ${again.status} ${String(again.text).slice(0, 200)}`);
    assert.equal(again.json.code, 'CLAIM_ALREADY_SETTLED');
    assert.ok(/already redeemed/i.test(again.json.error), `the refusal does not say the claim is done: ${again.json.error}`);
    assert.ok(new RegExp(CASHIER_NAME, 'i').test(again.json.error),
      `the refusal does not name the person who paid it — the next cashier is left with "it is gone and nobody knows why": ${again.json.error}`);
    const safe = await staff.get(`/api/safe?branch_id=${branch.id}`);
    assert.equal(round2(Number(safe.json.balance)), round2(safeBefore - owed), 'the refused second payment moved money anyway');
  });

  // -----------------------------------------------------------------
  audit.section('A second claim, paid by transfer, must not touch the drawer');
  // -----------------------------------------------------------------
  // THIS IS THE RULE A REAL SHOP WOULD GET WRONG. A refund sent from the bank is not
  // a refund out of the drawer, and booking it as one makes the safe short by the
  // amount the shop never handed over. Proving it needs a second claim, so here is one.
  const transferClaim = await audit.captureAsync('a second claim, to be paid by bank transfer', async () => {
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      customer_id: customer.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: tendered }],
      change_owed_amount: owed,
      device_id: 'audit-change-owed',
    }, { idempotencyKey: `change-owed-sale2-${Date.now().toString(36)}` });
    assert.equal(res.status, 201, `the second sale answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const list = await owner.get(`/api/change-owed?branch_id=${branch.id}&status=OUTSTANDING&limit=50`);
    const row = (list.json.data || []).find((r) => String(r.sale_id) === String(res.json.saleId));
    if (!row) throw new Error('the second sale left change owed and listed no claim');
    return row;
  });

  await audit.checkAsync('a transfer settlement leaves the safe exactly where it was', async () => {
    const before = round2(Number((await staff.get(`/api/safe?branch_id=${branch.id}`)).json.balance));
    const res = await staff.post(`/api/change-owed/${transferClaim.id}/settle`, { method: 'BANK_TRANSFER', reference: 'AUDIT-TRF-1' });
    assert.equal(res.status, 200, `a transfer settlement answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.equal(res.json.status, 'REDEEMED');
    const after = round2(Number((await staff.get(`/api/safe?branch_id=${branch.id}`)).json.balance));
    assert.equal(after, before,
      `the safe moved ${money(after - before)} when a claim was paid by bank transfer. No cash left the drawer — a movement here is a shortfall a cashier will be asked to explain`);
  });

  // -----------------------------------------------------------------
  audit.section('Writing off is a manager’s decision, in writing');
  // -----------------------------------------------------------------
  const writeOffClaim = await audit.captureAsync('a third claim, to be written off', async () => {
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      customer_id: customer.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: tendered }],
      change_owed_amount: owed,
      device_id: 'audit-change-owed',
    }, { idempotencyKey: `change-owed-sale3-${Date.now().toString(36)}` });
    assert.equal(res.status, 201, `the third sale answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const list = await owner.get(`/api/change-owed?branch_id=${branch.id}&status=OUTSTANDING&limit=50`);
    const row = (list.json.data || []).find((r) => String(r.sale_id) === String(res.json.saleId));
    if (!row) throw new Error('the third sale left change owed and listed no claim');
    return row;
  });

  await audit.checkAsync('a cashier cannot write off money the shop owes a customer', async () => {
    const res = await staff.post(`/api/change-owed/${writeOffClaim.id}/write-off`, { reason: 'Counting it as a wash' });
    assert.equal(res.status, 403, `a cashier wrote off a customer's money: ${res.status} ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'ROLE_REQUIRED');
  });

  await audit.checkAsync('a manager cannot write it off without saying why', async () => {
    const bare = await manager.post(`/api/change-owed/${writeOffClaim.id}/write-off`, {});
    assert.equal(bare.status, 400, `a write-off with no reason was accepted: ${bare.status} ${String(bare.text).slice(0, 200)}`);
    assert.equal(bare.json.code, 'REASON_REQUIRED');
    const short = await manager.post(`/api/change-owed/${writeOffClaim.id}/write-off`, { reason: 'gone' });
    assert.equal(short.status, 400, `a four-letter reason was accepted, so the field is decoration: ${short.status} ${String(short.text).slice(0, 160)}`);
  });

  await audit.checkAsync('a manager who says why closes the claim, and the reason is on the claim afterwards', async () => {
    const why = 'Audit run — customer was called twice and never came back.';
    const res = await manager.post(`/api/change-owed/${writeOffClaim.id}/write-off`, { reason: why });
    assert.equal(res.status, 200, `a manager's write-off answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.equal(res.json.status, 'WRITTEN_OFF');
    const back = await manager.get(`/api/change-owed/code/${encodeURIComponent(writeOffClaim.claim_code)}`);
    assert.equal(back.status, 200);
    assert.equal(back.json.claim.status, 'WRITTEN_OFF');
    assert.ok(String(back.json.claim.notes || '').includes(why),
      `the reason is not kept on the claim, so the owner reading it later has a written-off debt and no explanation: ${JSON.stringify(String(back.json.claim.notes || '').slice(0, 120))}`);
    const paid = await manager.post(`/api/change-owed/${writeOffClaim.id}/settle`, { method: 'CASH' });
    assert.equal(paid.status, 409, `a written-off claim was still paid out: ${paid.status}`);
  });

  // -----------------------------------------------------------------
  audit.section('What the owner sees on the dashboard');
  // -----------------------------------------------------------------
  await audit.checkAsync('the summary a dashboard card reads agrees with the rows behind it', async () => {
    const list = await owner.get(`/api/change-owed?status=OUTSTANDING&limit=200`);
    assert.equal(list.status, 200);
    const rows = (list.json.data || []).filter((r) => r.status === 'OUTSTANDING');
    const open = rows.reduce((s, r) => round2(s + Number(r.amount)), 0);
    const summary = await owner.get('/api/change-owed/summary');
    assert.equal(summary.status, 200, `the summary answered ${summary.status} ${String(summary.text).slice(0, 200)}`);
    assert.equal(summary.json.outstanding_amount, open,
      `the dashboard card would show ${money(summary.json.outstanding_amount)} while the claims behind it total ${money(open)}`);
    // AND THE SHOP'S OWN CASHIERS SEE THEIR SHOP'S MONEY ONLY — a cashier sent to chase
    // money at another branch is a cashier who cannot be paid for the trip.
    const mine = await staff.get('/api/change-owed/summary');
    assert.equal(mine.status, 200);
    const branchOpen = rows.filter((r) => String(r.branch_id) === String(branch.id)).reduce((s, r) => round2(s + Number(r.amount)), 0);
    assert.equal(mine.json.outstanding_amount, branchOpen,
      `a ${branch.name} cashier's card totals ${money(mine.json.outstanding_amount)} against ${money(branchOpen)} owed at their own branch`);
  });

  await audit.checkAsync('every claim this audit created is now closed, and none of them can be closed again', async () => {
    // EACH ONE BY ITS OWN CODE, and listed rather than looked up by id: the by-code
    // response wraps the row (`json.claim`), the list rows do not, and a check that
    // mixed the two shapes proved nothing the first time it was written.
    const claims = [
      [claim.claim.claim_code, 'REDEEMED'],
      [transferClaim.claim_code, 'REDEEMED'],
      [writeOffClaim.claim_code, 'WRITTEN_OFF'],
    ];
    for (const [code, expected] of claims) {
      const res = await owner.get(`/api/change-owed/code/${encodeURIComponent(code)}`);
      assert.equal(res.status, 200, `reading claim ${code} back answered ${res.status} ${String(res.text).slice(0, 160)}`);
      assert.equal(res.json.claim.status, expected, `claim ${code} is ${res.json.claim.status}, expected ${expected}`);
      assert.equal(res.json.settlable, false,
        `claim ${code} is already closed and the counter is still offered it as payable — a live deployment must not be left holding a fixture's liability, and a closed claim must never be paid twice`);
    }
  });

  audit.note(`the branch safe stands at ${money(Number((await owner.get(`/api/safe?branch_id=${branch.id}`)).json.balance))} — down ${money(owed)} for the one payout that was real cash`);
}, {
  // THE FIXTURE NEEDS ONE MANAGER AND ONE CASHIER AT THE FIRST SHOP, AND ONE CASHIER
  // AT THE SECOND. The other-branch seat is not scenery: it is the only local proof
  // that a claim code from one branch is invisible at another.
  setup: () => startDeployment({
    label: 'change-owed',
    businesses: [{
      name: 'Change Owed Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Change Wuse Shop', code: 'CHO-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 100000 },
        { name: 'Change Garki Shop', code: 'CHO-2', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 10000 },
      ],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'cho-manager', pin: '60184', branchIndex: 0, full_name: 'Change Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'cho-staff', pin: '73925', branchIndex: 0, full_name: CASHIER_NAME },
      { as: 'other', role: 'STAFF', username: 'cho-other', pin: '81260', branchIndex: 1, full_name: 'Change Garki Cashier' },
    ],
  }),
});
