'use strict';
// =====================================================================
// test/audit/audit.money.js — FOLLOW ONE NAIRA THROUGH THE WHOLE SYSTEM
// =====================================================================
// The unit tests already prove the arithmetic of a single function: VAT extraction
// from an inclusive price, a change-owed rounding, a payment split. What no unit
// test can prove is that the SAME naira is counted the same way at every point a
// shopkeeper can look at it — and that is the thing that decides whether a real
// business can trust this system with its money.
//
// So this audit takes ₦1 and follows it:
//
//   stock received → drawer funded from the safe → a cash sale over the counter →
//   change handed back → the drawer's expected cash → the count at close → the
//   money to the safe → the money to the bank → the ledger → the trial balance →
//   the VAT return → a credit sale → a customer payment → a void → idempotency.
//
// At every hop it reads the figure back over HTTP from a DIFFERENT endpoint than the
// one that wrote it. That is the whole method, and it is not a formality: this shape
// of audit is what caught the till float inventing a bank deposit (the safe ledger
// said ₦50,000 and the general ledger said −₦50,000, while the trial balance stayed
// perfectly balanced and reported nothing wrong). A check that only asks "did the
// call succeed" passes over that. A check that asks "does the drawer hold what the
// system says it holds" cannot.
//
// WHAT IT DOES NOT DO: it never touches a database, never mocks a service and never
// computes the expected answer with the same function the server used. Every figure
// it asserts against is either arithmetic it did itself from the prices it saw, or a
// figure read back from a second endpoint.
// =====================================================================

const assert = require('node:assert');
const { runAudit } = require('./lib/harness');
// The money rounding the PRODUCT uses, so the audit's own arithmetic is done to the
// same precision the server works to. It is imported, never re-implemented: an audit
// that carries its own round2 can disagree with the product about a kobo and report a
// defect that is really a different definition of "round".
const { round2 } = require('../../domain/money');
const { startDeployment } = require('./lib/deployment');

const money = (n) => `₦${Number(n).toLocaleString('en-NG')}`;

runAudit('money', async (audit, d) => {
  const o = d.owner;
  // The branch this audit trades in — the one its own seat works at, not whichever branch
  // the deployment happened to return first. See Deployment.branchFor().
  const branch = d.branchFor(d.owner || d.admin) || d.branches[0];

  // ===================================================================
  // GET THE SHOP READY — the way a shop actually gets ready.
  // ===================================================================
  audit.section('The shop opens: VAT on, stock on the shelf, a customer on the books');

  const settings = await audit.captureAsync('VAT switched on by the owner', async () => {
    if (d.live && !d.writable) return null;
    const res = await o.put('/api/settings', { vat_enabled: 1, vat_rate_percent: 7.5 });
    if (res.status !== 200) throw new Error(`PUT /api/settings answered ${res.status} ${res.text.slice(0, 200)}`);
    return res.json.settings;
  });

  const vatOn = settings ? Number(settings.vat_enabled) === 1 : Number(d.settings && d.settings.vat_enabled) === 1;
  if (!vatOn) {
    // Without VAT the whole tax half of this audit asserts nothing. It is reported as
    // a skip rather than a pass, and the run continues so the rest still proves what
    // it can.
    audit.skip('VAT is off and could not be switched on (a read-only target)',
      'the VAT-extraction and return checks below cannot run');
  } else {
    audit.pass('VAT is on at 7.5%, so every price in this audit is VAT-inclusive');
  }

  // A PRODUCT, ON THE SHELF. The catalogue is provisioned per vertical, so the audit
  // picks whatever the seed gave it rather than inventing a product — the thing being
  // audited is the money path, and a bespoke product would be a fixture that predicts
  // the answer.
  const product = await audit.captureAsync('a product from the vertical catalogue', async () => {
    const res = await o.get('/api/products?limit=5');
    const rows = (res.json && res.json.data) || [];
    const withPrice = rows.find((r) => Number(r.selling_price) > 0);
    if (!withPrice) throw new Error(`the catalogue has no priced product to sell (${rows.length} rows)`);
    return withPrice;
  });

  const unitPrice = Number(product.selling_price);
  audit.note(`${product.sku} ${product.name} — ${money(unitPrice)} per ${String(product.base_unit_name || 'unit').toLowerCase()}`);

  // RECEIVE STOCK. A sale cannot be rung against an empty shelf, and the refusal is a
  // good refusal — so this is the real path a shop uses to put goods on the shelf.
  const receive = await audit.checkAsync('stock is received onto the shelf', async () => {
    if (d.live && !d.writable) { audit.skip('read-only target: no stock could be received'); return; }
    const res = await o.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 10, unit_code: product.default_unit_code || 'PIECE',
      cost_price: round2(unitPrice * 0.7), selling_price: unitPrice,
      reference: `AUDIT-GRN-${Date.now().toString(36)}`,
    });
    assert.equal(res.status, 201, `receiving stock answered ${res.status}: ${res.text.slice(0, 240)}`);
    assert.ok(res.json.quantityBase >= 10, `received ${res.json.quantityBase} base units of 10`);
  });

  if (receive !== true) {
    // Nothing below can work without stock. Failing everything after this would bury
    // the one real message, so the audit stops here with the reason.
    audit.skip('the rest of this audit needs stock on the shelf', 'fix the receipt above first');
    return;
  }

  // A CUSTOMER, WITH CREDIT TERMS — needed later for the credit half.
  const customer = await audit.captureAsync('a customer with a credit limit', async () => {
    if (d.live && !d.writable) return null;
    // THE BRANCH IS NAMED EXPLICITLY, AND THE BUSINESS FOLLOWS FROM IT. On a deployment
    // with more than one business, a customer created without a branch is resolved by a
    // FALLBACK — the oldest live business on the deployment — and the sale that names this
    // audit's branch is then refused with CROSS_BUSINESS_CUSTOMER. That refusal is the
    // product being right: a customer belongs to a business, and one business's counter
    // cannot extend credit in another's books. The first live write run learned it the hard
    // way, four checks later than it should have.
    const res = await o.post('/api/customers', {
      branch_id: branch.id,
      name: `Audit Customer ${Date.now().toString(36).slice(-4)}`,
      phone: '08031234567', customer_type: 'INDIVIDUAL',
      credit_limit: 1000000, payment_terms_days: 30,
    });
    if (res.status !== 201) throw new Error(`POST /api/customers answered ${res.status} ${res.text.slice(0, 240)}`);
    d.trackCustomer(res.json.id);
    return res.json;
  });

  // ===================================================================
  // THE DRAWER
  // ===================================================================
  audit.section('The drawer is funded from the safe, and the books say so');

  // WHAT THE BANK HELD BEFORE THIS AUDIT TOUCHED ANYTHING. The float check below asserts
  // that funding a drawer does not post a deposit — and on a live deployment the bank
  // account already holds the shop's real banking, so the first live run reported ₦68,500
  // of somebody's actual takings as a defect in its own float. A movement, never a total.
  const bankBeforeTheFloat = await audit.captureAsync('the bank balance before the drawer was funded', async () => {
    const res = await o.get('/api/banking');
    const row = (res.json.accounts || []).find((a) => a.code === '1020');
    return row ? Number(row.balance) : 0;
  });


  const float = 50000;

  // THE AUDIT'S OWN LEFTOVER DRAWER.
  //
  // A live run that stops half way — a lost connection, a Ctrl-C, a budget — leaves the
  // audit owner's drawer OPEN, and the next run is then refused with "You already have an
  // open till at Verification Showroom (opened 06:40:31). Close it before opening another —
  // two open drawers for one person means neither count means anything." That refusal is
  // correct, and it made this audit un-runnable on the second attempt: worse than useless
  // against a target somebody still has to trade on.
  //
  // So the audit clears its own debris first, counting exactly what the system expects so
  // there is no variance to explain. It only ever touches the drawer belonging to the
  // account it runs as, and it says in the output that it did.
  const leftover = await audit.captureAsync('any drawer this audit left open on a previous run', async () => {
    if (!(d.live && d.writable)) return null;
    const actor = d.owner || d.admin;
    // FOUND BY OWNERSHIP, NOT BY BRANCH. The drawer a previous run left open sits at
    // whatever branch that run chose — which, before branchFor() existed, could be a
    // branch of another business entirely. Asking this branch for "the open till" then
    // found nothing, the next open was refused with TILL_ALREADY_OPEN, and the audit was
    // un-runnable on a target somebody still had to trade on.
    //
    // So: list the open drawers, keep the ones belonging to THIS account, and close only
    // those. Somebody else's drawer is never touched.
    const res = await actor.get('/api/tills?status=OPEN&limit=50');
    const mine = ((res.json && res.json.data) || []).filter((t) => String(t.user_id) === String(actor.userId) && String(t.status) === 'OPEN');
    if (!mine.length) return null;
    const closedAll = [];
    for (const t of mine) {
      const expected = round2(Number(t.opening_cash || 0) + Number(t.cash_sales_total || 0) - Number(t.refund_total || 0));
      const close = await actor.post(`/api/tills/${t.id}/close?branch_id=${t.branch_id}`, { counted_cash: expected });
      if (close.status >= 300) throw new Error(`could not close the drawer this audit left open at ${t.branch_id}: ${close.status} ${close.text.slice(0, 200)}`);
      closedAll.push({ id: t.id, counted: expected });
    }
    return closedAll;
  });
  if (leftover) {
    for (const t of leftover) audit.note(`closed a drawer a previous audit run left open (${t.id}) at its expected count of ${money(t.counted)}`);
  }
  let safeBefore = await audit.captureAsync('the safe balance before the float', async () => {
    const res = await o.get(`/api/safe?branch_id=${branch.id}`);
    return res.status === 200 ? Number(res.json.balance) : null;
  });
  audit.note(`the safe holds ${money(safeBefore)} before the drawer is funded`);

  const till = await audit.captureAsync('a till opened with a float taken from the safe', async () => {
    let res = await o.post('/api/tills/open', { branch_id: branch.id, opening_cash: float, from_safe: true });
    // AN EMPTY SAFE IS NOT A DEFECT, IT IS A SHOP THAT HAS NOT BANKED YET. On a live
    // deployment the safe may hold nothing at all — the audit's own local fixture funds
    // it from provisioning — so the float is funded the way a shop would: put money into
    // the safe first, then take the float out of it. The refusal that triggers this is
    // itself a good message ("The safe at … holds ₦0, which is not enough for a ₦50,000
    // float. Take the float from the bank instead, or fund the safe first").
    if (res.status === 409 && String(res.json && res.json.code) === 'SAFE_INSUFFICIENT') {
      audit.note(`the safe was short of the float, so the audit funded it first — the product said: ${String(res.json.error).slice(0, 120)}`);
      const beforeTopUp = await o.get(`/api/safe?branch_id=${branch.id}`);
      const topUp = await o.post('/api/safe/entries', {
        branch_id: branch.id, entry_type: 'DEPOSIT', amount: round2(float + 1000),
        reason: 'OTHER', note: 'Audit: funding the safe so a drawer can be opened from it',
      });
      if (topUp.status !== 200 && topUp.status !== 201) {
        throw new Error(`could not fund the safe: ${topUp.status} ${topUp.text.slice(0, 200)}`);
      }
      res = await o.post('/api/tills/open', { branch_id: branch.id, opening_cash: float, from_safe: true });
      if (res.status === 201) {
        res.json.toppedUpTheSafe = true;
        res.json.safeBeforeToppedUp = round2(Number((beforeTopUp.json || {}).balance || 0) + float + 1000);
      }
    }
    if (res.status !== 201) throw new Error(`POST /api/tills/open answered ${res.status} ${res.text.slice(0, 240)}`);
    return res.json;
  });

  // A DRAWER IS THE SPINE OF EVERYTHING BELOW. If it could not be opened — a target with
  // no safe, a shop already trading with another drawer — the sections that depend on one
  // stand down and say so, rather than failing six checks with "the till did not open".
  const drawer = audit.check('the audit has a drawer to count', () => {
    assert.ok(till, 'no till could be opened on this target, so the drawer, count and banking checks below cannot run');
  });
  if (drawer !== true) {
    audit.skip('the drawer, the count and the banking sections are skipped', 'they all need an open till; everything that does not is asserted above and below');
  } else if (till.toppedUpTheSafe) {
    safeBefore = till.safeBeforeToppedUp;
  }

  audit.check('opening a drawer from the safe moves the safe balance by exactly the float', () => {
    assert.ok(till, 'the till did not open — nothing below can be asserted');
    assert.equal(round2(till.safeBalanceAfter), round2((safeBefore || 0) - float),
      `the safe was ${money(safeBefore)} and the float was ${money(float)}, so it should now hold ${money((safeBefore || 0) - float)}; the response says ${money(till.safeBalanceAfter)}`);
  });

  await audit.checkAsync('and the safe LEDGER agrees, read back from a different endpoint', async () => {
    const res = await o.get(`/api/safe?branch_id=${branch.id}`);
    assert.equal(round2(Number(res.json.balance)), round2((safeBefore || 0) - float),
      `GET /api/safe reports ${money(res.json.balance)}`);
    assert.equal(res.json.chainConsistent, true, `the safe ledger's running balance does not add up: ${res.json.chainMessage}`);
    const top = (res.json.data || [])[0];
    assert.ok(top && top.entry_type === 'TILL_FUND', `the newest safe entry is ${top && top.entry_type}, expected TILL_FUND`);
    assert.equal(round2(Number(top.amount)), -float, `the float entry is ${money(top.amount)} — money leaving the safe is negative`);
    assert.equal(round2(Number(top.balance_after)), round2(Number(res.json.balance)),
      'the running balance on the newest row disagrees with the derived balance');
  });

  await audit.checkAsync('the drawer reports the float it holds', async () => {
    const res = await o.get(`/api/tills/current?branch_id=${branch.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.json.till, 'no till is open, though one was just opened');
    assert.equal(round2(Number(res.json.till.opening_cash)), float, `the drawer opened with ${money(res.json.till.opening_cash)}`);
    assert.equal(round2(Number(res.json.expectedCashNow)), float,
      `a drawer with a ${money(float)} float and no sales should hold ${money(float)}; it says ${money(res.json.expectedCashNow)}`);
  });

  // -- AND THE FIX THIS AUDIT FOUND. ------------------------------------
  //
  // Funding a drawer from the safe used to post a BANKING ledger entry: debit Bank
  // Account, credit Cash in Safe — as though the float had been carried to the bank.
  // Nothing had been. The shop's bank balance was overstated by the float and "Cash
  // at Till" was left short by it, for as long as the business existed, and the trial
  // balance stayed balanced the whole time.
  await audit.checkAsync('money moving from the safe to the drawer does not land in the bank', async () => {
    const res = await o.get('/api/banking');
    assert.equal(res.status, 200);
    const bank = (res.json.accounts || []).find((a) => a.code === '1020');
    assert.ok(bank, 'the banking screen no longer lists a bank account');
    assert.equal(round2(Number(bank.balance) - Number(bankBeforeTheFloat || 0)), 0,
      `the bank account moved by ${money(Number(bank.balance) - Number(bankBeforeTheFloat || 0))} (${money(bankBeforeTheFloat)} → ${money(bank.balance)}) after a drawer was funded from the safe. No money went to the bank — a float is a move between two cash holdings inside the same building, and booking it as a deposit inflates the bank and starves the till account`);
    // THE SPLIT BETWEEN THE TWO CASH ACCOUNTS IS NOT ASSERTED HERE, AND THAT IS DELIBERATE.
    //
    // Cash in Safe can read negative on a live deployment, and this audit saw it: −₦137,000
    // in the books while the branch safe physically held ₦3,000. The reason is a design
    // decision the product states in two places (server/routes/till.js, once at the float
    // and once on the safe-entry route): only BANKING moves the general ledger, because
    // cash moving between the drawer and the safe is still cash at the branch. So the
    // OUTFLOWS from the safe are posted (banking, an expense paid from the safe) and the
    // INFLOWS are not (a deposit, the till-close sweep) — which leaves 1010 negative the
    // first time a shop banks money that reached the safe by a route the ledger never saw.
    //
    // It is a real reporting defect and it is already recorded as open work in STATUS.md
    // ("should the safe be a real general-ledger account"), together with the fix that
    // would close it: post the intra-cash moves — DR 1000 / CR 1010 for a float, the
    // reverse for a sweep — so the two cash lines move while total assets do not. It
    // changes the composition of a live balance sheet, so it is its own stage with its own
    // proof, not a line slipped into this one. What this check does own is asserted above:
    // funding a drawer must not invent a bank deposit. The figure is reported either way.
    const inSafe = (res.json.accounts || []).find((a) => a.code === '1010');
    if (inSafe) {
      audit.note(`Cash in Safe: books ${money(inSafe.balance)} vs the branch safe ledger ${money(safeBefore - float)} — the two agree only where every naira into the safe arrived through the ledger. See the open item in STATUS.md`);
    }
  });

  // ===================================================================
  // THE SALE
  // ===================================================================
  audit.section('A cash sale over the counter, and the change handed back');

  // THE AUDIT'S OWN TALLY OF WHAT THE COUNTER HAS TAKEN, accumulated as it rings. Every
  // drawer and safe figure below is compared against this, not against a hard-coded
  // number — see the note on cashIntoDrawer further down.
  let cashIntoDrawer = 0;
  let salesRung = 0;  // What the till account held before this audit rang anything — see the delta note below.
  const tillAccountBefore = d.live ? await audit.captureAsync('the till account balance before this audit traded', async () => {
    const res = await o.get('/api/banking');
    const row = (res.json.accounts || []).find((a) => a.code === '1000');
    return row ? Number(row.balance) : 0;
  }) : 0;

  const tendered = round2(unitPrice + 1500);
  const sale = await audit.captureAsync('a cash sale of one unit, tendered over the odds', async () => {
    const res = await o.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unitPrice, cash_tendered: tendered }],
      device_id: 'audit-money',
    }, { idempotencyKey: `money-sale-${Date.now().toString(36)}` });
    if (res.status !== 201) throw new Error(`POST /api/sales answered ${res.status}: ${res.text.slice(0, 300)}`);
    return res.json;
  });

  audit.check('the price came back unrounded, and the sale joins the tally', () => {
    salesRung += 1;
    cashIntoDrawer = round2(cashIntoDrawer + unitPrice);
    assert.ok(sale, 'the sale was not created — the money checks below assert nothing');
    assert.equal(round2(sale.totals.total), round2(unitPrice),
      `one unit at ${money(unitPrice)} should total ${money(unitPrice)}; the receipt says ${money(sale.totals.total)}`);
  });

  // TWO DIFFERENT THINGS, AND THE FIRST DRAFT OF THIS CHECK CONFUSED THEM.
  //
  //   change_given  — cash handed back across the counter. It never enters the drawer,
  //                   so it must not inflate what the drawer is expected to hold.
  //   changeOwed    — change the till could NOT pay, so the shop is holding the
  //                   customer's money and owes it. That is a LIABILITY, not a payment,
  //                   and it is the field the API calls `changeOwed`.
  //
  // This audit originally asserted `changeOwed === tendered - total`, which is neither
  // of those: it failed against a product that was right, and it would have passed
  // against a product that treated money owed to a customer as money received. The
  // check now asserts both figures by their real meanings.
  await audit.checkAsync('the sale records the change handed back, and owes nothing', async () => {
    assert.ok(sale, 'no sale');
    assert.equal(round2(sale.changeOwed || 0), 0,
      `${money(sale.changeOwed)} of change is still owed to the customer after a cash sale — money the shop is holding for somebody else must not be recorded as received`);
    // READ IT BACK. The creation response deliberately carries no `change_given`; the
    // figure lives on the sale record and on the payment leg, and a check that reads it
    // from the response object would pass on a field the client invented.
    const back = await o.get(`/api/sales/${sale.saleId}?branch_id=${branch.id}`);
    assert.equal(back.status, 200, `reading the sale back answered ${back.status}`);
    const row = back.json.sale || back.json;
    const leg = (back.json.payments || []).find((p) => String(p.method).toUpperCase() === 'CASH');
    const givenBack = row.change_given != null ? row.change_given : (leg && (leg.change_given != null ? leg.change_given : leg.changeGiven));
    assert.equal(round2(Number(givenBack)), round2(tendered - unitPrice),
      `the customer tendered ${money(tendered)} for a ${money(unitPrice)} sale, so ${money(tendered - unitPrice)} went back across the counter; the record says ${givenBack == null ? 'nothing at all' : money(givenBack)}. Change handed over is not takings — it left the drawer — and it has to be visible on the record or the count cannot be argued`);
  });

  // AND THE LIABILITY, EXERCISED PROPERLY: a drawer that could not make change.
  const owed = await audit.captureAsync('a sale where the drawer cannot make change', async () => {
    if (d.live && !d.writable) return null;
    const res = await o.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      // THE PAYMENT IS THE TOTAL *PLUS* WHAT THE TILL KEPT. The customer handed over
      // ₦34,500 for a ₦34,000 sale and took ₦500 of it away as a claim on the shop. The
      // money received is therefore the total plus the claim; the product caps `paid` at
      // the total and books the rest as a liability, and it refuses the sale outright with
      // UNDERPAID if only the total is recorded — which is how this audit learned the rule.
      payments: [{ method: 'CASH', amount: round2(unitPrice + 500), cash_tendered: round2(unitPrice + 500) }],
      change_owed_amount: 500,
      // A CLAIM FOR CHANGE MUST BE ATTRIBUTABLE. The product refuses an anonymous one,
      // and refuses a name typed at the counter too: change owed is the shop holding
      // somebody else's money on a claim code, and a typed name cannot be chased. So the
      // sale carries a customer record — which is what the refusal now says, after this
      // audit found it saying "needs a customer name and phone" while the code required a
      // customer to exist.
      customer_id: customer ? customer.id : undefined,
      device_id: 'audit-money',
    }, { idempotencyKey: `money-change-${Date.now().toString(36)}` });
    if (res.status !== 201) throw new Error(`the sale answered ${res.status}: ${res.text.slice(0, 240)}`);
    return res.json;
  });

  audit.check('change the shop could not pay is recorded as OWED, not as revenue', () => {
    if (owed == null) { audit.skip(d.live && !d.writable ? 'read-only target: no change-owed sale could be rung' : 'the change-owed sale failed above — see its message'); return; }
    assert.equal(round2(owed.changeOwed), 500,
      `the counter kept ${money(500)} of the customer's money because it had no change, and the receipt says ${money(owed.changeOwed)} is owed. Unrecorded, that money looks like takings`);
    // It stays in the drawer, so the drawer owes it — the count below fails if the
    // system forgets that.
    cashIntoDrawer = round2(cashIntoDrawer + unitPrice + 500);
  });

  await audit.checkAsync('the money kept for the customer is a liability in the books, not income', async () => {
    if (owed == null) { audit.skip('the change-owed sale did not record, so its liability is not asserted here'); return; }
    const res = await o.get('/api/banking');
    const tillAccount = (res.json.accounts || []).find((a) => a.code === '1000');
    // THE MOVEMENT, NOT THE BALANCE. Cash at Till is an account like any other and a live
    // deployment's already holds takings; the absolute figure reported ₦442,500 of somebody
    // else's trading as a defect in this one sale. `tillAccountBefore` is read before the
    // audit trades, so what is asserted here is what THIS counter took — including the
    // ₦500 it kept for a customer, which is exactly the money the entry must not call income.
    assert.equal(round2(Number(tillAccount.balance) - (tillAccountBefore || 0)), round2(cashIntoDrawer),
      `Cash at Till moved by ${money(Number(tillAccount.balance) - (tillAccountBefore || 0))} while the counter took ${money(cashIntoDrawer)} including the ${money(500)} it kept for a customer. Cash the shop is holding for somebody else still arrives in the drawer — it is the other side of the entry that must not be revenue`);
    const tb = await o.get('/api/accounting/trial-balance');
    assert.equal(tb.json.ok, true, `the books are out by ${money(tb.json.difference)} after holding a customer's change: ${tb.json.message}`);
  });

  // THE VAT EXTRACTION, CHECKED AGAINST ARITHMETIC THIS AUDIT DID ITSELF.
  //
  // A 7.5% VAT on a VAT-INCLUSIVE price is not 7.5% of the price — it is
  // price − price/1.075. Getting that wrong overstates the tax and understates
  // revenue by a visible amount on every single sale, and it is the single most
  // common way Nigerian retail software gets VAT wrong.
  if (vatOn) {
    audit.check('VAT is extracted FROM the inclusive price, not added on top of it', () => {
      assert.ok(sale, 'no sale');
      const expectedVat = round2(unitPrice - unitPrice / 1.075);
      assert.equal(round2(sale.vat.vatAmount), expectedVat,
        `on a ${money(unitPrice)} inclusive price the VAT is ${money(expectedVat)} (price − price ÷ 1.075). The receipt says ${money(sale.vat.vatAmount)}`);
      assert.equal(round2(sale.totals.total), round2(unitPrice),
        'the customer was charged more than the shelf price — VAT must come OUT of the ticket price, not be added to it');
      assert.equal(Number(sale.vat.vatRatePercent), 7.5, `the receipt carries a VAT rate of ${sale.vat.vatRatePercent}%`);
      assert.equal(Number(sale.vat.vatEnabled), 1, 'the receipt does not record that this sale carried VAT at all');
    });
  }

  // WHAT THE AUDIT EXPECTS THE DRAWER TO HOLD, COUNTED BY THE AUDIT.
  //
  // Every figure here is accumulated from what this audit actually rang — the amount
  // APPLIED to each sale (which is what physically stays in the drawer, because the change
  // went back over the counter) plus anything the till KEPT as change owed (which also
  // stays, and which the shop now holds for somebody else). Hard-coding the expected
  // figure instead is how the first draft of this section broke the moment a third sale
  // was added: the numbers were right for the sales it remembered and wrong for the
  // system.
  await audit.checkAsync('the drawer expects the float PLUS the cash it took, and the change is already out', async () => {
    const res = await o.get(`/api/tills/current?branch_id=${branch.id}`);
    // COUNTED, NOT REMEMBERED — AND COUNTED FROM THIS BRANCH'S OWN LIST.
    //
    // The revenue on the drawer is compared against the sales list read back over HTTP,
    // because a counter the audit keeps in its own head drifts the moment a section above
    // it rings one more sale. The list must be the TILL'S OWN sales (matched on
    // `till_session_id`) and it must be the BRANCH'S list (`?branch_id=`), which is the
    // second half of the fix this section now guards: on a live deployment the read used
    // to return every branch's trading, so this check compared one drawer's takings
    // against 41 sales it had never made. See branchFilter() in server/lib/respond.js.
    const list = await o.get(`/api/sales?branch_id=${branch.id}&limit=200`);
    const rows = ((list.json && list.json.data) || []).filter((x) => x.status !== 'VOIDED');
    const mine = rows.filter((x) => String(x.till_session_id) === String(till.id));
    const revenue = round2(mine.reduce((a, x) => a + Number(x.total || 0), 0));
    // WHAT THE DRAWER PHYSICALLY HOLDS: every sale's total, PLUS the change it kept for a
    // customer instead of handing it over. That last part reads backwards — the shop OWES
    // the ₦500 rather than earning it — but the note is in the drawer until the customer
    // comes back for it, and a count that ignored it would report a surplus that is really
    // somebody else's money. The books carry it as a claim; the count carries it as cash.
    // (Getting this the wrong way round is how this check first failed after the rewrite:
    // it subtracted the ₦500 and reported the product's correct ₦118,500 as the defect.)
    const kept = round2(mine.reduce((a, x) => a + Number(x.change_owed || 0), 0));
    const expected = round2(float + revenue + kept);
    assert.equal(round2(Number(res.json.live.revenue)), revenue,
      `the till counts ${money(res.json.live.revenue)} while the ${mine.length} un-voided sale(s) recorded against this drawer (of ${rows.length} at ${branch.name}, ${salesRung} rung by this audit) come to ${money(revenue)}`);
    assert.equal(round2(Number(res.json.expectedCashNow)), expected,
      `the drawer should hold the ${money(float)} float plus the ${money(revenue)} it took plus ${money(kept)} change it kept for a customer = ${money(expected)}. It says ${money(res.json.expectedCashNow)}. If it says ${money(float + revenue)} the change owed back to the customer was never taken out of the drawer, and the cashier will be short at the count for money they handed over`);
    const cash = (res.json.byMethod || []).find((m) => m.method === 'CASH');
    assert.ok(cash, 'the sale does not appear against the drawer by payment method');
  });

  await audit.checkAsync('the ledger knows the cash arrived, in the till account', async () => {
    const res = await o.get('/api/banking');
    const tillAccount = (res.json.accounts || []).find((a) => a.code === '1000');
    assert.ok(tillAccount, 'the banking screen no longer lists Cash at Till');
    // A DELTA, because a live deployment's ledger already holds money. The first live run
    // asserted the absolute balance and reported ₦306,000 of pre-existing takings as a
    // defect in this one sale.
    assert.equal(round2(Number(tillAccount.balance) - (tillAccountBefore || 0)), round2(cashIntoDrawer),
      `Cash at Till reads ${money(tillAccount.balance)} after ${money(cashIntoDrawer)} of cash sales. This account is what the counter has taken; the float it opened with came from the safe and is a move between two cash holdings, so it is deliberately not posted here (see the till-float check above)`);
  });

  // ===================================================================
  // THE COUNT
  // ===================================================================
  audit.section('The drawer is counted at the end of the shift');

  await audit.refusal('a drawer cannot be closed with no count at all', () => o.post(`/api/tills/${till && till.id}/close`, {
    variance_reason: 'audit probe',
  }), { expectStatus: 400, code: /COUNT_REQUIRED/, message: /counted|count/i });

  await audit.refusal('a drawer that does not balance cannot be closed without a reason', () => o.post(`/api/tills/${till && till.id}/close`, {
    counted_cash: round2(float + unitPrice - 700),
  }), { expectStatus: 400, code: /VARIANCE_REASON_REQUIRED/, message: /short|over|reason/i });

  const drawerExpected = round2(float + cashIntoDrawer);
  const closed = await audit.captureAsync('the drawer is closed against a full count', async () => {
    // The float stays in the drawer as the next shift's float; the day's takings go to
    // the safe. That is the ordinary close in a Nigerian shop, and doing it here means
    // the safe assertions below have something real to check.
    const res = await o.post(`/api/tills/${till && till.id}/close`, {
      counted_cash: drawerExpected,
      to_safe: cashIntoDrawer,
      to_safe_reason: "Audit: the day's takings to the safe",
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`closing the till answered ${res.status}: ${res.text.slice(0, 240)}`);
    return res.json;
  });

  audit.check('a full count closes the drawer with no variance', () => {
    assert.ok(closed, 'the till did not close');
    const variance = closed.variance != null ? Number(closed.variance) : null;
    if (variance == null) { audit.note('the close response does not report a variance figure; the refusal above is what pins the rule'); return; }
    assert.equal(round2(variance), 0, `a count that matches the expected cash should show no variance; the response says ${money(variance)}`);
  });

  await audit.checkAsync('the closed drawer is a signed-off record, not a working copy', async () => {
    const res = await o.get(`/api/tills/${till && till.id}?branch_id=${branch.id}`);
    assert.equal(res.status, 200, `reading the till answered ${res.status}`);
    const row = res.json.till || res.json;
    assert.equal(row.status, 'CLOSED', `the till is ${row.status} after being closed`);
  });

  await audit.checkAsync('the day\'s takings reached the safe, to the kobo', async () => {
    const res = await o.get(`/api/safe?branch_id=${branch.id}`);
    assert.equal(res.json.chainConsistent, true,
      `the safe's running balance does not add up: ${res.json.chainMessage}`);
    const expectedSafe = round2((safeBefore || 0) - float + cashIntoDrawer);
    assert.equal(round2(Number(res.json.balance)), expectedSafe,
      `the safe started at ${money(safeBefore)}, lent ${money(float)} to the drawer and took ${money(cashIntoDrawer)} back at close, so it should hold ${money(expectedSafe)}. It says ${money(res.json.balance)}`);
    const returns = (res.json.data || []).filter((e) => e.entry_type === 'TILL_RETURN');
    assert.ok(returns.length >= 1, 'the close moved cash to the safe but the safe ledger has no TILL_RETURN row for it');
    assert.equal(round2(Number(returns[0].amount)), round2(cashIntoDrawer),
      `the return row is ${money(returns[0].amount)} against ${money(cashIntoDrawer)} of takings`);
  });

  // ===================================================================
  // BANKING — the step most shops skip, and the one that proves the safe is real
  // ===================================================================
  audit.section('The takings are banked, and the bank is not invented');

  const banked = cashIntoDrawer;
  // A MOVEMENT, NOT A TOTAL. A live deployment's bank account already holds money, and the
  // first live run reported pre-existing balances as defects in its own sale.
  const bankBefore = d.live ? await audit.captureAsync('the bank balance before this audit banked anything', async () => {
    const res = await o.get('/api/banking');
    const row = (res.json.accounts || []).find((a) => a.code === '1020');
    return row ? Number(row.balance) : 0;
  }) : 0;
  const bankResult = await audit.captureAsync('the takings are banked from the safe', async () => {
    if (d.live && !d.writable) return null;
    const res = await o.post('/api/safe/entries', {
      branch_id: branch.id, entry_type: 'BANKING', amount: banked,
      reference: `AUDIT-SLIP-${Date.now().toString(36).slice(-5)}`,
      note: 'Audit: day\'s takings to the bank',
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`banking the takings answered ${res.status}: ${res.text.slice(0, 240)}`);
    return res.json;
  });

  audit.check('banking moves the money out of the safe and into the bank, and nowhere else', () => {
    if (!bankResult) {
      audit.skip(d.live && !d.writable ? 'read-only target: nothing could be banked' : 'the banking step above did not complete — see its failure for the product\'s own reason');
      return;
    }
    audit.note(`banked ${money(banked)}`);
  });

  await audit.checkAsync('the bank account grew by exactly what was banked', async () => {
    if (!bankResult) { audit.skip('the banking step did not complete, so there is nothing to read back'); return; }
    const res = await o.get('/api/banking');
    const bank = (res.json.accounts || []).find((a) => a.code === '1020');
    assert.equal(round2(Number(bank.balance) - bankBefore), round2(banked),
      `the bank moved from ${money(bankBefore)} to ${money(bank.balance)} and ${money(banked)} was banked from the safe — a live deployment's bank account already held money, so this is a movement, not a total`);
    const tillAccount = (res.json.accounts || []).find((a) => a.code === '1000');
    assert.equal(round2(Number(tillAccount.balance) - (tillAccountBefore || 0)), round2(cashIntoDrawer),
      `banking from the SAFE must not touch the till account: it moved by ${money(Number(tillAccount.balance) - (tillAccountBefore || 0))} and the counter took ${money(cashIntoDrawer)}`);
  });

  await audit.checkAsync('a banking entry with no slip reference is refused', async () => {
    if (!bankResult) { audit.skip('the banking step did not complete, so the slip reference rule is not asserted here'); return; }
    const res = await o.post('/api/safe/entries', {
      branch_id: branch.id, entry_type: 'BANKING', amount: 1000,
      note: 'Audit: an unreferenceable deposit',
    });
    assert.equal(res.status, 400,
      `a deposit with no slip number answered ${res.status}. A banking entry that cannot be matched to a bank statement is the one thing that decides whether the money actually arrived`);
    // Either code is a correct refusal — the safe route asks for the reference as a
    // required field, the till-close route refuses it as BANK_REFERENCE_REQUIRED. What
    // matters is that the message tells the shopkeeper what to write down.
    assert.match(`${res.json.code || ''} ${res.json.error || ''}`, /reference|slip/i,
      `refused as ${res.json.code} without mentioning a reference or a slip number`);
  });

  await audit.checkAsync('and the safe is lighter by what left it', async () => {
    if (!bankResult) { audit.skip('the banking step did not complete, so the safe balance is not read back here'); return; }
    const res = await o.get(`/api/safe?branch_id=${branch.id}`);
    const expectedSafe = round2((safeBefore || 0) - float + cashIntoDrawer - banked);
    assert.equal(round2(Number(res.json.balance)), expectedSafe,
      `after banking ${money(banked)} the safe should hold ${money(expectedSafe)}; it says ${money(res.json.balance)}`);
    assert.equal(res.json.chainConsistent, true, `safe chain broken after banking: ${res.json.chainMessage}`);
  });

  // ===================================================================
  // THE BOOKS
  // ===================================================================
  audit.section('The books, after all of that');

  await audit.checkAsync('the trial balance balances', async () => {
    const res = await o.get('/api/accounting/trial-balance');
    assert.ok([200, 500].includes(res.status), `the trial balance answered ${res.status}`);
    assert.equal(res.json.ok, true,
      `THE BOOKS DO NOT BALANCE: debits ${money(res.json.totalDebit)}, credits ${money(res.json.totalCredit)}, difference ${money(res.json.difference)}. Every report built on this ledger is unreliable until it is found — ${res.json.message}`);
    assert.equal(round2(Number(res.json.difference)), 0, `the trial balance reports a difference of ${money(res.json.difference)}`);
  });

  await audit.checkAsync('every journal entry has equal legs', async () => {
    // The trial balance nets the whole ledger. An entry with two unbalanced legs and
    // another that happens to offset it would still net to zero, so each ENTRY is
    // checked on its own.
    const res = await o.get('/api/accounting/journal?limit=100');
    assert.equal(res.status, 200, `the journal answered ${res.status}`);
    const rows = (res.json.data || res.json.entries || []);
    assert.ok(rows.length > 0, 'the journal is empty after a sale, a float and a closure — nothing was posted to the general ledger at all');
    const unbalanced = rows.filter((e) => e.total_debit !== undefined && round2(Number(e.total_debit) - Number(e.total_credit)) !== 0);
    assert.equal(unbalanced.length, 0,
      `${unbalanced.length} journal entr(ies) have unequal legs, the first being ${unbalanced[0] && (unbalanced[0].entry_no || unbalanced[0].id)}: debit ${money(unbalanced[0] && unbalanced[0].total_debit)} against credit ${money(unbalanced[0] && unbalanced[0].total_credit)}`);
    audit.note(`${rows.length} journal entr(ies) read, every one balanced`);
  });

  // ===================================================================
  // IDEMPOTENCY — the offline queue depends on it
  // ===================================================================
  audit.section('The same sale pushed twice is one sale');

  const key = `money-idem-${Date.now().toString(36)}`;
  const body = {
    branch_id: branch.id,
    lines: [{ product_id: product.id, quantity: 1 }],
    payments: [{ method: 'CASH', amount: unitPrice, cash_tendered: unitPrice }],
    device_id: 'audit-money',
  };
  const first = await audit.captureAsync('a sale pushed with an idempotency key', async () => {
    const res = await o.post('/api/sales', body, { idempotencyKey: key });
    if (res.status !== 201) throw new Error(`the first push answered ${res.status}: ${res.text.slice(0, 240)}`);
    return res.json;
  });
  const second = await audit.captureAsync('the identical push retried', async () => {
    const res = await o.post('/api/sales', body, { idempotencyKey: key });
    return { status: res.status, json: res.json, replayedHeader: res.headers && res.headers.get && res.headers.get('idempotency-replayed') };
  });

  audit.check('a retried sale returns the ORIGINAL sale, not a second one', () => {
    assert.ok(first && second, 'one of the two pushes did not answer');
    assert.equal(second.status, 201, `the retry answered ${second.status} instead of replaying the original 201`);
    assert.equal(second.json.saleId, first.saleId,
      `the retry created a different sale (${second.json.saleId} vs ${first.saleId}) — an offline device that retries would charge the customer twice`);
    assert.equal(second.json.receiptNo, first.receiptNo, 'the retry issued a different receipt number');
    // The flag is how the device knows it can drop the queued item. Not a detail:
    // without it the queue retries forever.
    assert.ok(second.json.replayed === true || second.replayedHeader === 'true',
      'the replay is not marked — a device cannot tell "already recorded" from "recorded just now", so its outbox never empties');
  });

  await audit.checkAsync('and the sales list holds exactly one of them', async () => {
    const res = await o.get(`/api/sales?branch_id=${branch.id}&limit=100`);
    const rows = (res.json.data || []);
    const matching = rows.filter((s) => String(s.receipt_no) === String(first.receiptNo));
    assert.equal(matching.length, 1, `${matching.length} sales carry receipt ${first.receiptNo} — a retried push was recorded twice`);
  });

  // ===================================================================
  // CREDIT AND THE DEBTOR LEDGER
  // ===================================================================
  audit.section('A credit sale, the debtor ledger, and a payment against it');

  if (!customer) {
    audit.skip('no customer could be created on this target', 'the credit half of this audit needs one whose ledger can be read back');
  } else {
    const creditSale = await audit.captureAsync('a sale on credit to a customer with a limit', async () => {
      // `sale_type: CREDIT`, not a CREDIT payment leg on a retail sale. The product
      // refuses the latter in as many words — "A CREDIT payment leg means the customer
      // is taking the goods now and paying later. Record the sale as a credit sale" —
      // and it is right to: a credit sale carries a due date, a credit decision and a
      // debtor-ledger entry, and none of those belong on a counter sale.
      const res = await o.post('/api/sales', {
        branch_id: branch.id,
        customer_id: customer.id,
        sale_type: 'CREDIT',
        lines: [{ product_id: product.id, quantity: 1 }],
        payments: [{ method: 'CREDIT', amount: unitPrice }],
        device_id: 'audit-money',
      }, { idempotencyKey: `money-credit-${Date.now().toString(36)}` });
      if (res.status !== 201) throw new Error(`the credit sale answered ${res.status}: ${res.text.slice(0, 300)}`);
      return res.json;
    });

    audit.check('a credit sale leaves the whole amount owing', () => {
      assert.ok(creditSale, 'the credit sale was not created');
      assert.equal(round2(creditSale.balanceDue), round2(unitPrice),
        `nothing was paid, so the whole ${money(unitPrice)} is owed; the receipt says ${money(creditSale.balanceDue)}`);
      assert.ok(creditSale.credit && creditSale.credit.decision, 'the sale carries no credit decision');
      audit.note(`credit decision: ${creditSale.credit.decision}${creditSale.credit.message ? ` — ${creditSale.credit.message}` : ''}`);
    });

    await audit.checkAsync('the customer appears on the debtors list owing that amount', async () => {
      const res = await o.get('/api/customers/debtors?limit=100');
      assert.equal(res.status, 200, `the debtors list answered ${res.status}`);
      const row = (res.json.debtors || res.json.data || []).find((c) => String(c.id) === String(customer.id));
      assert.ok(row, `the customer just given credit is not on the debtors list (${(res.json.debtors || []).length} rows)`);
      // `credit_balance` is the column the debtors list actually reports; the first
      // draft of this check guessed at `balance`/`outstanding` and read NaN, which is
      // the audit doing arithmetic on a field that does not exist.
      const owing = row.credit_balance ?? row.balance ?? row.outstanding ?? row.balance_due;
      assert.equal(round2(Number(owing)), round2(unitPrice),
        `the debtor ledger says ${money(owing)} against a ${money(unitPrice)} credit sale (fields: ${Object.keys(row).join(', ')})`);
    });

    await audit.checkAsync('the debtor ledger itself carries the sale as a debit', async () => {
      const res = await o.get(`/api/customers/${customer.id}/ledger?limit=50`);
      assert.equal(res.status, 200, `the customer ledger answered ${res.status}`);
      const rows = (res.json.data || res.json.entries || []);
      assert.ok(rows.length >= 1, 'the customer ledger is empty after a credit sale');
      const debit = rows.find((r) => round2(Number(r.amount || r.debit || 0)) > 0);
      assert.ok(debit, `no debit row in the customer ledger: ${JSON.stringify(rows[0]).slice(0, 200)}`);
      audit.note(`the ledger's opening row is ${debit.entry_type || debit.type || 'a debit'} of ${money(debit.amount || debit.debit)}`);
    });

    const paid = await audit.captureAsync('the customer pays the invoice off', async () => {
      const res = await o.post(`/api/sales/${creditSale && creditSale.saleId}/pay`, {
        payments: [{ method: 'CASH', amount: unitPrice }],
      });
      if (res.status !== 200 && res.status !== 201) throw new Error(`the payment answered ${res.status}: ${res.text.slice(0, 300)}`);
      return res.json;
    });

    audit.check('a payment against an invoice settles it in full', () => {
      assert.ok(paid, 'the payment was refused');
      const due = paid.balanceDue != null ? paid.balanceDue : paid.sale && paid.sale.balance_due;
      if (due == null) { audit.note('the payment response carries no balance; the debtors list below is what pins it'); return; }
      assert.equal(round2(Number(due)), 0, `${money(due)} is still showing as owed after a payment of the full ${money(unitPrice)}`);
    });

    await audit.checkAsync('and the debtors list no longer carries the customer', async () => {
      const res = await o.get('/api/customers/debtors?limit=100');
      const row = (res.json.debtors || res.json.data || []).find((c) => String(c.id) === String(customer.id));
      const owing = row ? round2(Number(row.credit_balance ?? row.balance ?? row.outstanding ?? row.balance_due)) : 0;
      assert.equal(owing, 0, `the customer still shows ${money(owing)} owing after paying in full`);
    });

    await audit.checkAsync('a paid invoice cannot be paid again', async () => {
      const res = await o.post(`/api/sales/${creditSale && creditSale.saleId}/pay`, { payments: [{ method: 'CASH', amount: 100 }] });
      assert.ok([400, 409].includes(res.status),
        `paying a settled invoice answered ${res.status} — it must be refused, or a customer is charged twice for the same debt`);
    });

    await audit.refusal('you cannot settle a credit balance with more credit', () => o.post(`/api/sales/${creditSale && creditSale.saleId}/pay`, {
      payments: [{ method: 'CREDIT', amount: 100 }],
    }), { expectStatus: 409, code: /NO_BALANCE|CREDIT_TO_SETTLE_CREDIT|SALE/ });
  }

  // ===================================================================
  // A VOID, AND WHAT IT DOES TO THE TAX
  // ===================================================================
  audit.section('A sale is voided, and the figures follow it out');

  // WHAT THE RETURN SAID BEFORE THIS SALE EXISTS. The return is group-wide and a live
  // deployment's already carries the shop's real trading, so the check is the MOVEMENT a
  // sale makes in it and then the movement its void takes back out — which is the thing
  // being asserted, stated exactly. The absolute version multiplied a per-sale VAT by the
  // number of sales in the return and went red on staging by 13 kobo, because the product
  // rounds the VAT on each sale to kobo and the audit was not: 43 × 2372.09 is 0.13 short
  // of 43 × 2372.093. The rounding is the product's, and it is right.
  const vatBefore = await audit.captureAsync('the VAT return before the sale that will be voided', async () => {
    const res = await o.get('/api/accounting/vat');
    if (res.status !== 200) return null;
    return { sales: Number(res.json.output.sales), vat: round2(Number(res.json.output.vat)) };
  });

  const voided = await audit.captureAsync('a fresh sale to void', async () => {
    const res = await o.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unitPrice, cash_tendered: unitPrice }],
      device_id: 'audit-money',
    }, { idempotencyKey: `money-void-${Date.now().toString(36)}` });
    if (res.status !== 201) throw new Error(`could not ring the sale to void: ${res.status} ${res.text.slice(0, 200)}`);
    return res.json;
  });

  const voidResult = await audit.captureAsync('that sale is voided with a reason', async () => {
    const res = await o.post(`/api/sales/${voided && voided.saleId}/void`, { reason: 'Audit: rung by mistake at the counter' });
    if (res.status !== 200 && res.status !== 201) throw new Error(`the void answered ${res.status}: ${res.text.slice(0, 240)}`);
    return res.json;
  });

  await audit.checkAsync('a voided sale is reported as voided, not deleted', async () => {
    assert.ok(voided && voidResult, 'the void did not complete');
    const res = await o.get(`/api/sales/${voided.saleId}?branch_id=${branch.id}`);
    assert.equal(res.status, 200, `a voided sale answered ${res.status} — a void is a record, not a deletion`);
    const row = res.json.sale || res.json.data || res.json;
    assert.equal(row.status, 'VOIDED', `the sale is ${row.status} after being voided`);
  });

  await audit.checkAsync('the voided sale is excluded from the VAT return', async () => {
    const res = await o.get('/api/accounting/vat');
    assert.equal(res.status, 200, `the VAT return answered ${res.status}`);
    assert.ok(res.json.output.voidedSales >= 1,
      'the VAT return does not count the voided sale at all — a void that vanishes from the return cannot be reconciled against the receipts');
    audit.note(`VAT for the period: output ${money(res.json.output.vat)} on ${res.json.output.sales} sale(s), ${res.json.output.voidedSales} voided, net ${money(res.json.netPayable)} (${res.json.position}), due ${res.json.dueBy}`);
    if (vatOn && vatBefore) {
      // THE VOID TOOK THE SALE BACK OUT, TO THE KOBO. Read before the sale was rung, and
      // again after it was voided: the return must be exactly where it started. A return
      // that keeps a voided receipt shows up here as a permanent +1 sale and its VAT.
      const expectedVat = round2(unitPrice - unitPrice / 1.075);
      assert.equal(Number(res.json.output.sales), vatBefore.sales,
        `the return reports ${res.json.output.sales} sale(s); before this audit rang the sale it was ${vatBefore.sales}. The voided receipt is still in the VAT return`);
      assert.ok(Math.abs(round2(res.json.output.vat) - vatBefore.vat) < 0.01,
        `the return reports ${money(res.json.output.vat)} of output VAT where it reported ${money(vatBefore.vat)} before the voided sale was rung — a voided receipt left in the return shows up exactly here. (The sale's own VAT was ${money(expectedVat)}, so leaving it in would read ${money(round2(vatBefore.vat + expectedVat))})`);
      assert.match(String(res.json.dueBy), /^\d{4}-\d{2}-21$/, `the return is due ${res.json.dueBy} — FIRS takes VAT and WHT on the 21st of the following month`);
    }
  });

  await audit.checkAsync('and the books still balance after a void', async () => {
    const res = await o.get('/api/accounting/trial-balance');
    assert.equal(res.json.ok, true, `the books are out by ${money(res.json.difference)} after a void: ${res.json.message}`);
  });


  // ===================================================================
  // A LIST ANSWERS FOR THE BRANCH IT NAMES
  // ===================================================================
  // THE SECOND HALF OF THE BRANCH-FILTER DEFECT, and the half that proves the fix.
  //
  // `GET /api/sales?branch_id=X` returned every branch's sales; so did the tills list, the
  // expenses list, the transfer list and the stock valuation. Nothing errored and no figure
  // looked wrong — the only symptom was a total that was larger than the shop named above
  // it, which is a number nobody questions. It is the shape of bug that survives a year of
  // use: an OWNER is the only caller who sees it, because a branch-pinned MANAGER is saved
  // from it by their own scope.
  //
  // So this section names both branches and reads a money figure back from each. The
  // fixture now carries a SECOND BRANCH THAT NEVER TRADES: the sales list for it must come
  // back empty rather than holding this branch's takings, and the valuation for it must
  // read zero units rather than this branch's stock. Before the fix both of those answered
  // with the first branch's money, which is what these checks would have caught.
  audit.section('A list answers for the branch it names, and only that branch');

  const otherBranch = (d.branches || []).find((b) => String(b.id) !== String(branch.id));
  // A SECOND SHOP OF THIS AUDIT'S OWN BUSINESS, if there is one. On a live target the other
  // branch may belong to a DIFFERENT business (staging carries two real ones), and an audit
  // has no business ringing sales in somebody else's furniture shop to prove a filter — so
  // it only trades where it owns the shop.
  const ownSecond = otherBranch && String(otherBranch.business_id) === String(branch.business_id) ? otherBranch : null;

  // SOMETHING TO LEAK, AND SOMETHING TO FIND. The check below is "the list for this branch
  // holds no other branch's sale" — and with the second shop empty, that check passed even
  // with the filter deleted from the route, which is a check that proves nothing. (It did:
  // a negative control dropped the filter from GET /api/sales and the whole suite stayed
  // green.) So the second branch receives stock and rings a sale of its own.
  const secondStock = await audit.captureAsync('stock on the shelf at the second branch', async () => {
    if (!ownSecond) return null;
    if (d.live && !d.writable) return null;
    const res = await o.post('/api/stock/receive', {
      branch_id: ownSecond.id, product_id: product.id, quantity: 5,
      cost_price: 21000, selling_price: unitPrice,
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`receiving at ${ownSecond.name} answered ${res.status}: ${res.text.slice(0, 200)}`);
    return res.json;
  });

  const secondSale = await audit.captureAsync('a sale rung at the second branch', async () => {
    if (!ownSecond || !secondStock) return null;
    const res = await o.post('/api/sales', {
      branch_id: ownSecond.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unitPrice, cash_tendered: unitPrice }],
      device_id: 'audit-money',
    }, { idempotencyKey: `money-second-${Date.now().toString(36)}` });
    if (res.status !== 201) throw new Error(`ringing a sale at ${ownSecond.name} answered ${res.status}: ${res.text.slice(0, 240)}`);
    return res.json;
  });

  audit.check('the deployment gave this audit a second branch to name', () => {
    if (!otherBranch) {
      audit.skip('this deployment has one branch, so there is no second shop to name',
        'the check that a branch you cannot reach is REFUSED still runs below — it needs the manager seat, not a second branch');
      return;
    }
  });

  if (otherBranch) {
    await audit.checkAsync('the sales list for this branch holds this branch, and nothing else', async () => {
      const res = await o.get(`/api/sales?branch_id=${branch.id}&limit=200`);
      assert.equal(res.status, 200, `the sales list answered ${res.status}`);
      const rows = res.json.data || [];
      const foreign = rows.filter((r) => r.branch_id && String(r.branch_id) !== String(branch.id));
      assert.equal(foreign.length, 0,
        `${foreign.length} of ${rows.length} row(s) in the list for ${branch.name} belong to ${[...new Set(foreign.map((r) => r.branch_name || r.branch_id))].join(', ')}. A list answered for one shop that carries another shop\'s takings is how a branch report gets signed off against the wrong money`);
      // THE POSITIVE HALF. A filter that answered with an empty list every time would pass
      // the line above, so the audit looks for the sale it just rang — matched by ID, not
      // by receipt number: receipt numbers are per branch and repeat legitimately, which is
      // what sent this audit down the wrong road in the first place.
      const ids = new Set(rows.map((r) => String(r.id)));
      assert.ok(first && ids.has(String(first.saleId)),
        `the sale this audit rang at ${branch.name} (${first && first.receiptNo}) is missing from that branch's own list`);
      if (secondSale) {
        assert.ok(!ids.has(String(secondSale.saleId)),
          `the sale rung at ${ownSecond.name} (${secondSale.receiptNo}) is in the list for ${branch.name} — the query named one branch and was answered with another's takings, which is the defect this section was written for`);
      }
    });

    await audit.checkAsync('the sales list for the other branch holds that branch, and nothing of ours', async () => {
      const res = await o.get(`/api/sales?branch_id=${otherBranch.id}&limit=200`);
      assert.equal(res.status, 200, `the sales list for ${otherBranch.name} answered ${res.status}`);
      const rows = res.json.data || [];
      const foreign = rows.filter((r) => r.branch_id && String(r.branch_id) !== String(otherBranch.id));
      assert.equal(foreign.length, 0,
        `${foreign.length} row(s) in the list for ${otherBranch.name} belong elsewhere`);
      if (secondSale) {
        const ids = new Set(rows.map((r) => String(r.id)));
        assert.ok(ids.has(String(secondSale.saleId)),
          `the sale rung at ${otherBranch.name} (${secondSale.receiptNo}) is missing from that branch's own list — a filter that answers with nothing for every branch would pass every other check here`);
        assert.ok(!ids.has(String(first && first.saleId)),
          `the list for ${otherBranch.name} carries a sale rung at ${branch.name}`);
        return;
      }
      // ON A LIVE TARGET THIS BRANCH MAY LEGITIMATELY HAVE TRADED, and on staging it has:
      // the second branch belongs to a different BUSINESS there, and it holds real sales
      // from earlier live runs. Asserting "empty" would report somebody's trading as a
      // defect. Locally the fixture owns both shops, so the branch it never traded at must
      // come back empty — which is the assertion that catches a dropped filter.
      if (d.live) {
        audit.note(`a live target, so ${otherBranch.name} may have traded: ${rows.length} row(s) returned, all of them its own`);
        return;
      }
      assert.equal(rows.length, 0,
        `${otherBranch.name} has never traded and its sales list holds ${rows.length} row(s) — this is the defect: the branch named in the query was ignored and the other shop's takings came back`);
    });

    await audit.checkAsync('the stock valuation for the other branch values that branch alone', async () => {
      const res = await o.get(`/api/stock/valuation?branch_id=${otherBranch.id}`);
      assert.equal(res.status, 200, `the valuation answered ${res.status}`);
      const rows = res.json.branches || [];
      assert.equal(rows.length, 1,
        `the valuation for ${otherBranch.name} listed ${rows.length} branch(es) (${rows.map((r) => r.branch_name).join(', ')}) — a report headed with one shop must not carry the group`);
      assert.equal(String(rows[0].branch_id), String(otherBranch.id),
        `the valuation for ${otherBranch.name} reported ${rows[0].branch_name}`);
      if (secondStock) {
        assert.ok(Number(rows[0].units) > 0,
          `${otherBranch.name} received stock in this section and its valuation reads ${rows[0].units} units — the check above needs a branch that would have shown a figure, or it passes on an empty report`);
      }
    });

    await audit.checkAsync('and the valuation for THIS branch carries the stock it received', async () => {
      const res = await o.get(`/api/stock/valuation?branch_id=${branch.id}`);
      const rows = res.json.branches || [];
      assert.equal(rows.length, 1, `the valuation for ${branch.name} listed ${rows.length} branches`);
      assert.equal(String(rows[0].branch_id), String(branch.id), `the valuation reported ${rows[0].branch_name}`);
      // The positive control for the check above: the branch that received stock must
      // value at something. Two checks that both read zero prove nothing at all.
      assert.ok(Number(rows[0].units) > 0,
        `${branch.name} received stock in the section above and its valuation reads ${rows[0].units} units — a report that answers zero for every branch would pass every check in this section`);
    });
  }

  // THE REFUSAL HALF. A branch the caller cannot reach must be refused rather than
  // answered with their own shop's rows — silently, quietly wrong is the defect being
  // replaced here, and an empty list would be the same lie in a softer voice.
  const scopeManager = d.seats && d.seats.manager;
  audit.check('the deployment gave this audit a manager seat pinned to one branch', () => {
    if (!scopeManager) {
      audit.skip(d.live && !d.writable
        ? 'this target is read-only, so no manager seat could be created'
        : 'the deployment produced no manager seat',
        'set AUDIT_WRITE=1 to assert the refusal half against this target');
      return;
    }
  });

  if (scopeManager && otherBranch) {
    await audit.checkAsync('a manager naming their own branch gets their own branch', async () => {
      const res = await scopeManager.get(`/api/sales?branch_id=${scopeManager.branchId}&limit=5`);
      assert.equal(res.status, 200,
        `a manager naming their own branch was answered ${res.status} ${res.text.slice(0, 160)} — the filter must work for the people it was written for, not only for the owner`);
      const rows = (res.json && res.json.data) || [];
      const foreign = rows.filter((r) => r.branch_id && String(r.branch_id) !== String(scopeManager.branchId));
      assert.equal(foreign.length, 0, `a manager read ${foreign.length} row(s) belonging to another branch`);
    });

    await audit.refusal('naming a branch you cannot reach is refused, not answered with your own', () => scopeManager.get(`/api/sales?branch_id=${otherBranch.id}&limit=5`),
      { expectStatus: 403, code: /BRANCH_SCOPE|SCOPE/, message: /branch/i });

    await audit.checkAsync('and branch_scope=all cannot widen what a manager sees', async () => {
      // The opt-out exists so a screen can ask for the group instead of one branch. It is
      // an opt-out from the NAMED branch, never from the scope: a manager who asks for
      // everything gets their own branch, because that is the whole of what they have.
      const res = await scopeManager.get('/api/sales?branch_scope=all&limit=20');
      const rows = (res.json && res.json.data) || [];
      const foreign = rows.filter((r) => r.branch_id && String(r.branch_id) !== String(scopeManager.branchId));
      assert.equal(foreign.length, 0,
        `a manager pinned to ${scopeManager.branchId} read ${foreign.length} row(s) from other branches with branch_scope=all`);
    });
  }

  // A NOTATION FOR WHOEVER READS THE OUTPUT NEXT.
  await audit.checkAsync('the ledger still holds no entry with unequal legs', async () => {
    const res = await o.get('/api/accounting/journal?limit=200');
    const rows = (res.json.data || res.json.entries || []);
    const bad = rows.filter((e) => e.total_debit !== undefined && round2(Number(e.total_debit) - Number(e.total_credit)) !== 0);
    assert.equal(bad.length, 0, `${bad.length} entr(ies) with unequal legs after the void`);
  });
}, {
  setup: () => startDeployment({
    label: 'money',
    owner: { name: 'Money Audit Owner', username: 'money-owner', pin: '48014' },
    admin: { username: 'money-admin', pin: '48014' },
    // TWO BRANCHES NOW, AND THE SECOND ONE IS THE POINT.
    //
    // The fixture used to be a single shop on purpose: a single-shop business is the most
    // common shape in this market, and it is the shape whose owner has no branch to name —
    // which is how this audit found resolveBranch refusing a caller who reaches exactly
    // one branch. That defect is now asserted directly (the audit names its own branch in
    // the section "A list answers for the branch it names"), so the second shop is no
    // longer covering a case that would otherwise go untested.
    //
    // What it buys is the only local proof that a `?branch_id=` filter is really applied:
    // a branch that has NEVER TRADED must answer with nothing. Before the fix it answered
    // with the first branch's takings, because every branch-filtered list in the product
    // ignored the branch it was given.
    businesses: [{
      name: 'Money Audit Appliances', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Wuse Shop', code: 'MON-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 200000 },
        { name: 'Kano Depot', code: 'MON-2', city: 'Kano', state: 'Kano', branch_type: 'RETAIL', opening_cash: 0 },
      ],
    }],
    // A seat that reaches ONE branch, for the refusal half of the same rule.
    seats: [{ as: 'manager', role: 'MANAGER', username: 'money-manager', pin: '73041', branchIndex: 0, full_name: 'Money Audit Manager' }],
  }),
});
