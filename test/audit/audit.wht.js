'use strict';
// =====================================================================
// test/audit/audit.wht.js — TAX, WHERE BEING WRONG IS A PENALTY
// =====================================================================
// Two taxes touch a Nigerian retailer every month:
//
//   VAT   — 7.5%, charged OUT of the ticket price (prices in this market are
//           quoted inclusive), reported to FIRS by the 21st of the following month.
//   WHT   — deducted from what the business pays a supplier, at a rate that depends
//           on WHAT was supplied, and remitted to FIRS by the same 21st.
//
// Both are places where being wrong is not a rounding error. Under-deduct WHT and the
// business owes the tax itself, plus interest and a penalty, and the supplier still
// wants their money. Extract VAT the wrong way round — 7.5% of an inclusive price
// instead of price − price/1.075 — and every receipt in the shop overstates the tax and
// understates revenue, invisibly, forever.
//
// So this audit checks the two things a shopkeeper is never able to check for
// themselves: that the arithmetic matches the law's definition, and that the figure
// a return would report reconciles with the receipts behind it.
//
// WHAT IT DOES NOT DO: it does not assert its own idea of the rates. The rates are DATA
// in this system (`wht_rates`, seeded from the 2024 Regulations), and the audit compares
// what the API serves against what the data module holds — so a rate that changes in the
// database shows up here rather than being silently overruled by a number typed into a
// test.
// =====================================================================

const assert = require('node:assert');
const { runAudit } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');
const { round2 } = require('../../domain/money');
const { WHT_SCHEDULE_2024, WHT_REMITTANCE_DAY_OF_MONTH, extractVatFromInclusive, whtRemittanceDueDate } = require('../../domain/nigerianTax');

const money = (n) => `₦${Number(n).toLocaleString('en-NG')}`;

runAudit('wht', async (audit, d) => {
  const o = d.owner;
  const branch = d.branches[0];
  const manager = d.seats && d.seats.manager;
  const staff = d.seats && d.seats.staff;

  // ===================================================================
  // THE RATES ARE DATA
  // ===================================================================
  audit.section('The withholding rates are data, and the data is served');

  const wht = await audit.captureAsync('the WHT position for the period', async () => {
    const res = await o.get('/api/accounting/wht');
    if (res.status !== 200) throw new Error(`GET /api/accounting/wht answered ${res.status}: ${res.text.slice(0, 240)}`);
    return res.json;
  });

  audit.check('the schedule is served, and matches the schedule this system seeds', () => {
    assert.ok(wht, 'the WHT report did not answer');
    const served = wht.schedule || [];
    assert.ok(served.length >= 5, `the API serves ${served.length} withholding rate(s)`);
    // COMPARED AGAINST THE DATA, NOT AGAINST A NUMBER IN THIS FILE. If somebody edits a
    // rate in the database — which is the whole point of it being a table — that shows up
    // as a difference here rather than being overruled by a test that "knows" the answer.
    const byCode = new Map(served.map((r) => [String(r.code), r]));
    for (const seed of WHT_SCHEDULE_2024) {
      const row = byCode.get(seed.code);
      assert.ok(row, `${seed.code} (${seed.name}) is missing from the served schedule`);
      assert.equal(Number(row.rate_percent), Number(seed.rate_percent),
        `${seed.code} is served at ${row.rate_percent}% and the seeded Regulations rate is ${seed.rate_percent}%`);
      assert.ok(row.direction, `${seed.code} carries no direction — PAYABLE and RECEIVABLE are different taxes and must never be netted`);
      assert.ok(String(row.note || '').length > 20,
        `${seed.code} carries no note. The rate is the easy half; whether it APPLIES is where a business gets it wrong`);
    }
    audit.note(`${served.length} rate(s) served: ${served.map((r) => `${r.code} ${r.rate_percent}%`).join(', ')}`);
  });

  audit.check('the supply-of-goods rate carries its exemption, which is the expensive trap', () => {
    const row = (wht && wht.schedule || []).find((r) => r.code === 'SUPPLY_OF_GOODS');
    assert.ok(row, 'there is no supply-of-goods rate at all');
    assert.match(String(row.note), /manufactur/i,
      'the supply-of-goods note does not mention the manufacturer exemption. Goods a supplier MANUFACTURES itself are not liable to the 2% deduction — a shop that withholds anyway hands FIRS money that was never owed and has to chase it back');
    audit.note(`supply of goods: ${row.rate_percent}% — ${String(row.note).slice(0, 96)}…`);
  });

  audit.check('the remittance date is the 21st, and it is attached to the figure', () => {
    assert.ok(wht, 'no WHT report');
    const summary = wht.summary || {};
    assert.equal(Number(summary.remittanceDay), Number(WHT_REMITTANCE_DAY_OF_MONTH),
      `the report says remittance is due on the ${summary.remittanceDay}th and the system's own constant says the ${WHT_REMITTANCE_DAY_OF_MONTH}st`);
    const expected = whtRemittanceDueDate(new Date().toISOString().slice(0, 7));
    assert.equal(String(summary.nextRemittanceDue), String(expected),
      `for this month the next remittance date should be ${expected}; the report says ${summary.nextRemittanceDue}. A tax liability with no date on it is a liability nobody pays on time`);
  });

  // ===================================================================
  // THE DEDUCTION
  // ===================================================================
  audit.section('A supplier is paid, and the tax is withheld from the gross');

  const supplier = await audit.captureAsync('a supplier on the books', async () => {
    if (d.live && !d.writable) return null;
    const res = await o.post('/api/suppliers', {
      // The branch is named so the supplier lands in the business this audit is trading
      // in — see the note on the customer in audit.money.js.
      branch_id: branch.id,
      name: `Audit Distributors ${Date.now().toString(36).slice(-4)}`,
      contact_person: 'Audit Contact', phone: '08031234567', tin: '12345678-0001',
      is_manufacturer: false, city: 'Abuja', state: 'FCT',
    });
    if (res.status !== 201) throw new Error(`POST /api/suppliers answered ${res.status}: ${res.text.slice(0, 240)}`);
    d.trackSupplier(res.json.id);
    return res.json;
  });

  const gross = 200000;
  const goodsRate = Number(((wht && wht.schedule || []).find((r) => r.code === 'SUPPLY_OF_GOODS') || {}).rate_percent || 2);
  const expectedWht = round2(gross * (goodsRate / 100));
  const expectedNet = round2(gross - expectedWht);

  const bankBefore = await audit.captureAsync('the bank balance before the payment', async () => {
    const res = await o.get('/api/banking');
    const bank = (res.json.accounts || []).find((a) => a.code === '1020');
    return bank ? Number(bank.balance) : null;
  });

  // WHAT WAS ALREADY OWED TO FIRS BEFORE THIS PAYMENT. A live deployment carries
  // withholdings from its own trading and from earlier audit runs (staging had ₦12,000
  // outstanding), and the assertion below used to be an ABSOLUTE: "the unremitted total
  // equals this one withholding". On a fresh local database that is true; on a live one it
  // reports the shop's real tax debt as a defect in the audit's own ₦8,000. The same
  // mistake the money audit made with the bank balance, in a different report.
  const unremittedBeforePayment = await audit.captureAsync('what was already owed to FIRS before this payment', async () => {
    const res = await o.get('/api/accounting/wht');
    if (res.status !== 200) return null;
    return round2(Number(res.json.summary && res.json.summary.unremittedTotal));
  });

  const payment = await audit.captureAsync(`a ${money(gross)} payment with withholding at ${goodsRate}%`, async () => {
    if (!supplier) return null;
    const res = await o.post(`/api/suppliers/${supplier.id}/payments`, {
      branch_id: branch.id, amount: gross, method: 'BANK_TRANSFER',
      reference: `AUDIT-WHT-${Date.now().toString(36).slice(-5)}`, wht_code: 'SUPPLY_OF_GOODS',
      notes: 'Audit: supplier settlement with withholding',
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`the supplier payment answered ${res.status}: ${res.text.slice(0, 300)}`);
    return res.json;
  });

  if (!supplier) {
    audit.skip('read-only target: no supplier could be created', 'the deduction, the ledger and the remittance below all need one');
  } else {
    audit.check(`the tax is withheld from the gross: ${money(expectedWht)} on ${money(gross)}`, () => {
      assert.ok(payment, 'the payment did not succeed');
      // The response carries `gross`, `net`, `whtAmount` and `balanceAfter` flat (and a
      // message a human reads). The first draft looked for `wht.whtAmount` and reported
      // "the response says nothing" about a response that said ₦4,000 in three places.
      const reported = payment.whtAmount != null ? payment.whtAmount : (payment.wht && payment.wht.whtAmount);
      assert.equal(round2(Number(reported)), expectedWht,
        `at ${goodsRate}% of ${money(gross)} the deduction is ${money(expectedWht)}; the response says ${reported == null ? 'nothing' : money(reported)}. Withholding the wrong way round — computing on the net — is the most common WHT failure there is, and it is the business's own liability`);
      assert.equal(round2(Number(payment.net)), expectedNet, `the response says ${money(payment.net)} is being paid, against ${money(expectedNet)} expected`);
      assert.match(String(payment.message || ''), /FIRS|WHT|withhold/i,
        `the confirmation does not mention the tax it just withheld: "${payment.message}". The person paying has to be told, or the deduction looks like an underpayment to the supplier`);
    });

    await audit.checkAsync('only the NET leaves the bank; the tax is not cash', async () => {
      const res = await o.get('/api/banking');
      const bank = (res.json.accounts || []).find((a) => a.code === '1020');
      assert.equal(round2(Number(bank.balance) - (bankBefore || 0)), round2(-expectedNet),
        `the bank moved by ${money(Number(bank.balance) - (bankBefore || 0))} on a ${money(gross)} invoice. What leaves the account is the gross LESS the withholding = ${money(expectedNet)}; the ${money(expectedWht)} withheld is owed to FIRS, and it never left the account`);
    });

    await audit.checkAsync('the supplier is credited with the WHOLE invoice, not the cash that moved', async () => {
      // The distinction decides whether the supplier is chased for tax the shop already
      // holds on their behalf. The debt is discharged by the gross.
      const res = await o.get('/api/creditors?limit=100');
      assert.equal(res.status, 200, `the creditors list answered ${res.status}`);
      const row = (res.json.creditors || res.json.data || []).find((s) => String(s.id) === String(supplier.id));
      if (!row) { audit.skip('the supplier has no creditor row yet (nothing was owed before the payment), so the balance cannot be read'); return; }
      const owed = Number(row.owed != null ? row.owed : (row.owed_amount != null ? row.owed_amount : (row.balance != null ? row.balance : row.balance_due)));
      assert.equal(round2(owed), round2(-gross),
        `the supplier's account reads ${money(owed)} after a ${money(gross)} payment against a ${money(gross)} invoice — it should be settled in full. Crediting only ${money(expectedNet)} leaves the shop believing it still owes the supplier ${money(expectedWht)}, and the shop will pay it twice`);
    });

    const after = await audit.captureAsync('the WHT the business now owes FIRS', async () => {
      const res = await o.get('/api/accounting/wht');
      return res.json;
    });

    audit.check('the deduction is recorded as PAYABLE, with the rate that produced it', () => {
      assert.ok(after, 'the WHT report did not answer');
      const rows = (after.entries || []).filter((r) => r.direction === 'PAYABLE');
      assert.ok(rows.length >= 1, 'the payment created no PAYABLE withholding entry');
      const row = rows[0];
      assert.equal(round2(Number(row.gross_amount)), round2(gross), `the entry records a gross of ${money(row.gross_amount)}`);
      assert.equal(round2(Number(row.wht_amount)), expectedWht, `the entry records ${money(row.wht_amount)} withheld`);
      assert.equal(round2(Number(row.net_amount)), expectedNet, `the entry records ${money(row.net_amount)} paid`);
      assert.equal(String(row.rate_code), 'SUPPLY_OF_GOODS', `the entry was recorded under ${row.rate_code}`);
      assert.equal(Number(row.rate_percent), goodsRate, `the entry carries a rate of ${row.rate_percent}%`);
      // THE MOVEMENT, and the entry's own presence. What matters is that withholding
      // ₦X added exactly ₦X to what the business owes FIRS — a live deployment's report
      // already holds its own outstanding tax, and that is not this audit's business.
      const grewBy = round2(Number(after.summary.unremittedTotal) - Number(unremittedBeforePayment || 0));
      assert.equal(grewBy, expectedWht,
        `the business owed FIRS ${money(unremittedBeforePayment || 0)} before this payment and ${money(after.summary.unremittedTotal)} after — a movement of ${money(grewBy)} against the ${money(expectedWht)} just withheld. This figure is what the business owes and has not sent; a withholding that does not appear here is tax the shop will never remit`);
      audit.note(`withheld ${money(row.wht_amount)} at ${row.rate_percent}% — ${after.message}`);
    });

    // THE WHT_EXCEEDS_PAYMENT GUARD IS NOT REACHABLE THROUGH THE SCHEDULE, and saying so
    // is more honest than a check that pretends to test it. The highest rate the 2024
    // Regulations set is 15%, so a deduction can never swallow a payment that is bigger
    // than itself. The guard stays in the service as a backstop for a rate edited in the
    // database to something absurd; a probe that asserted the guard fired would have to
    // first corrupt the rate table, which is a test of the corruption, not of the guard.
    audit.note('the "withholding exceeds the payment" guard is unreachable while the highest scheduled rate is 15% — it is a backstop, not a rule with a screen');

    await audit.refusal('a rate code the tax tables do not have is refused', () => o.post(`/api/suppliers/${supplier.id}/payments`, {
      branch_id: branch.id, amount: 50000, method: 'BANK_TRANSFER', reference: 'AUDIT-BADCODE', wht_code: 'MADE_UP_CODE_2026',
    }), { expectStatus: 400, code: /WHT|RATE|UNKNOWN/ });
  }

  // ===================================================================
  // THE ADVISORY THAT SAVES THE MONEY
  // ===================================================================
  audit.section('The manufacturer exemption is raised, not enforced');

  const manufacturer = await audit.captureAsync('a supplier recorded as a manufacturer', async () => {
    if (d.live && !d.writable) return null;
    const res = await o.post('/api/suppliers', {
      branch_id: branch.id,
      name: `Audit Manufacturers ${Date.now().toString(36).slice(-4)}`,
      tin: '87654321-0001', is_manufacturer: true, city: 'Nnewi', state: 'Anambra',
    });
    if (res.status !== 201) throw new Error(`POST /api/suppliers answered ${res.status}: ${res.text.slice(0, 240)}`);
    d.trackSupplier(res.json.id);
    return res.json;
  });

  if (manufacturer) {
    const warned = await audit.captureAsync('a payment to a manufacturer that withholds anyway', async () => {
      const res = await o.post(`/api/suppliers/${manufacturer.id}/payments`, {
        branch_id: branch.id, amount: 100000, method: 'BANK_TRANSFER',
        reference: `AUDIT-MFR-${Date.now().toString(36).slice(-5)}`, wht_code: 'SUPPLY_OF_GOODS',
      });
      if (res.status !== 200 && res.status !== 201) throw new Error(`the payment answered ${res.status}: ${res.text.slice(0, 300)}`);
      return res.json;
    });

    audit.check('withholding from a manufacturer is allowed, and objected to in writing', () => {
      const text = JSON.stringify(warned).toLowerCase();
      assert.match(text, /manufactur/,
        `the payment went through with no mention of the manufacturer exemption: ${JSON.stringify(warned).slice(0, 300)}. Goods a supplier manufactures itself are exempt from the 2% goods deduction — the system must say so, because the shopkeeper is the only person who knows what the supplier makes`);
    });
  } else {
    audit.skip('read-only target: no manufacturer could be created', 'the exemption advisory is not asserted');
  }

  // ===================================================================
  // REMITTANCE
  // ===================================================================
  audit.section('Remitting to FIRS is an owner\'s act, and it is dated');

  const unremitted = await audit.captureAsync('an unremitted entry to remit', async () => {
    const res = await o.get('/api/accounting/wht');
    const rows = (res.json.entries || []).filter((r) => r.direction === 'PAYABLE' && !r.remitted_at);
    return rows.length ? rows[0] : null;
  });

  if (!unremitted) {
    audit.skip('there is nothing unremitted to file', 'the remittance checks below have no entry to work with');
  } else {
    if (manager) {
      await audit.refusal('a manager cannot declare tax remitted to FIRS', () => manager.post(`/api/accounting/wht/${unremitted.id}/remitted`, {
        reference: 'AUDIT-MGR-FIRS-1', remitted_at: new Date().toISOString().slice(0, 10),
      }), { expectStatus: 403, code: /ROLE|OWNER/i });
    } else {
      audit.skip('no manager seat was created', 'the role boundary on remittance is not asserted');
    }

    await audit.refusal('the FIRS reference is required — an untraceable remittance is not a remittance', () => o.post(`/api/accounting/wht/${unremitted.id}/remitted`, {
      remitted_at: new Date().toISOString().slice(0, 10),
    }), { expectStatus: 400, code: /REFERENCE|MISSING/ });

    // MEASURED AROUND THE ACT. The first draft compared against a total captured at the
    // start of the audit — before two other payments had been made — and reported a
    // tax-accounting defect that was arithmetic in the audit.
    const unremittedBefore = await audit.captureAsync('what is unremitted immediately before filing', async () => {
      const res = await o.get('/api/accounting/wht');
      return round2(Number(res.json.summary.unremittedTotal));
    });

    const filed = await audit.captureAsync('the owner marks it remitted with the FIRS reference', async () => {
      const res = await o.post(`/api/accounting/wht/${unremitted.id}/remitted`, {
        reference: `AUDIT-FIRS-${Date.now().toString(36).slice(-5)}`,
        remitted_at: new Date().toISOString().slice(0, 10),
      });
      if (res.status !== 200 && res.status !== 201) throw new Error(`marking it remitted answered ${res.status}: ${res.text.slice(0, 300)}`);
      return res.json;
    });

    await audit.checkAsync('the liability moves from unremitted to filed, and does not simply vanish', async () => {
      assert.ok(filed, 'the remittance did not complete');
      const res = await o.get('/api/accounting/wht');
      const before = round2(Number(unremittedBefore));
      const nowUnremitted = round2(Number(res.json.summary.unremittedTotal));
      const remitted = round2(Number(res.json.summary.remittedTotal));
      const filedAmount = round2(Number(unremitted.wht_amount));
      assert.equal(round2(nowUnremitted), round2(before - filedAmount),
        `unremitted went from ${money(before)} to ${money(nowUnremitted)} after filing ${money(filedAmount)}. Tax that disappears instead of moving to "remitted" leaves a business unable to prove it paid`);
      assert.ok(remitted >= filedAmount,
        `the remitted total is ${money(remitted)}, which does not include the ${money(filedAmount)} just filed`);
      const row = (res.json.entries || []).find((r) => String(r.id) === String(unremitted.id));
      assert.ok(row && row.remitted_at, 'the entry carries no remittance date');
      audit.note(`unremitted now ${money(nowUnremitted)}, remitted ${money(remitted)}`);
    });
  }

  // ===================================================================
  // VAT — EXTRACTED, REPORTED, AND RECONCILED
  // ===================================================================
  audit.section('VAT comes out of the ticket price, and the return reconciles');

  // THE BUSINESS HAS TO BE REGISTERED, not just switched on. Two facts live behind VAT —
  // the business's registration and the settings toggle that makes the counter charge it —
  // and input VAT is only recoverable when BOTH are true. The seeded fixture sets the
  // registration at provisioning (see provisioningService), and this asserts it is really
  // set, because a fixture that believes it is registered while the database says
  // otherwise turns the input-VAT check below into a false alarm.
  const registered = await audit.captureAsync('the business is registered for VAT', async () => {
    const res = await o.get('/api/businesses?limit=5');
    const row = ((res.json && res.json.data) || [])[0];
    if (!row) return null;
    if (Number(row.vat_registered)) return row;
    if (d.live && !d.writable) return row;
    const wasRegistered = Number(row.vat_registered) === 1;
    d.trackRestore('the business VAT registration flag', async () => {
      const back = await o.put(`/api/businesses/${row.id}`, { vat_registered: wasRegistered });
      return back.status < 300;
    });
    const put = await o.put(`/api/businesses/${row.id}`, { vat_registered: true });
    return put.status === 200 ? put.json.business || { vat_registered: 1 } : row;
  });

  const settings = await audit.captureAsync('VAT switched on at 7.5%', async () => {
    if (d.live && !d.writable) return null;
    // READ THE SHOP'S OWN SETTINGS FIRST — see the note in audit.money.js: a live deployment's
    // tax switch is the client's, not the audit's, and it goes back as it was.
    const wasVat = d.settings || {};
    d.trackRestore('VAT settings', async () => {
      const res = await o.put('/api/settings', {
        vat_enabled: Number(wasVat.vat_enabled) === 1 ? 1 : 0,
        vat_rate_percent: wasVat.vat_rate_percent == null ? 7.5 : Number(wasVat.vat_rate_percent),
      });
      return res.status < 300;
    });
    const res = await o.put('/api/settings', { vat_enabled: 1, vat_rate_percent: 7.5 });
    if (res.status !== 200) throw new Error(`PUT /api/settings answered ${res.status}: ${res.text.slice(0, 240)}`);
    return res.json.settings;
  });
  const vatOn = settings ? Number(settings.vat_enabled) === 1 : Number(d.settings && d.settings.vat_enabled) === 1;
  const rate = settings ? Number(settings.vat_rate_percent) : 7.5;

  if (!vatOn) {
    audit.skip('VAT is off on this target and could not be switched on', 'the return below cannot be reconciled against anything');
  } else {
    const product = await audit.captureAsync('a product to sell', async () => {
      const res = await o.get('/api/products?limit=5');
      const row = ((res.json && res.json.data) || []).find((p) => Number(p.selling_price) > 0);
      if (!row) throw new Error('the catalogue has no priced product');
      return row;
    });

    const received = await audit.captureAsync('stock on the shelf', async () => {
      if (d.live && !d.writable) return null;
      const res = await o.post('/api/stock/receive', {
        branch_id: branch.id, product_id: product.id, quantity: 5,
        unit_code: product.default_unit_code || 'PIECE',
        cost_price: round2(Number(product.selling_price) * 0.7), selling_price: Number(product.selling_price),
        reference: `AUDIT-VAT-GRN-${Date.now().toString(36).slice(-5)}`,
      });
      if (res.status !== 201) throw new Error(`receiving stock answered ${res.status}: ${res.text.slice(0, 240)}`);
      return res.json;
    });

    const grossPrice = Number(product.selling_price);
    // `extractVatFromInclusive` returns { gross, vat, net, ratePercent } — the first draft
    // read `.vatAmount`, got undefined, and reported that the product charged zero VAT on
    // a receipt that was correct to the kobo.
    const ticketVat = round2(extractVatFromInclusive({ grossAmount: grossPrice, ratePercent: rate }).vat);

    const sale = await audit.captureAsync('a sale at the ticket price', async () => {
      if (!received) return null;
      const res = await o.post('/api/sales', {
        branch_id: branch.id, lines: [{ product_id: product.id, quantity: 1 }],
        payments: [{ method: 'CASH', amount: grossPrice, cash_tendered: grossPrice }],
        device_id: 'audit-wht',
      }, { idempotencyKey: `wht-vat-${Date.now().toString(36)}` });
      if (res.status !== 201) throw new Error(`the sale answered ${res.status}: ${res.text.slice(0, 300)}`);
      return res.json;
    });

    audit.check('the customer pays the ticket price and the tax is taken out of it', () => {
      assert.ok(sale, 'the sale was not recorded');
      assert.equal(round2(sale.totals.total), round2(grossPrice),
        `the ticket said ${money(grossPrice)} and the receipt says ${money(sale.totals.total)} — VAT in this market comes OUT of a quoted price, it is not added at the till`);
      assert.equal(round2(sale.vat.vatAmount), ticketVat,
        `VAT on a ${money(grossPrice)} inclusive price is ${money(ticketVat)} (price − price ÷ 1.075); the receipt says ${money(sale.vat.vatAmount)}. The add-on mistake overstates the tax by ${money(round2(grossPrice * rate / 100) - ticketVat)} on this one sale alone`);
    });

    await audit.checkAsync('the VAT return reconciles with the receipts behind it', async () => {
      const res = await o.get('/api/accounting/vat');
      assert.equal(res.status, 200, `the VAT return answered ${res.status}`);
      const out = res.json.output;
      assert.ok(out.sales >= 1, 'the return counts no sales at all');
      assert.equal(round2(Number(out.vat)), round2(ticketVat * out.sales),
        `the return reports ${money(out.vat)} of output VAT across ${out.sales} VAT-bearing sale(s) at ${money(grossPrice)} each; the tax on ${out.sales} of them is ${money(round2(ticketVat * out.sales))}`);
      assert.ok(String(res.json.dueBy).endsWith(`-${String(WHT_REMITTANCE_DAY_OF_MONTH).padStart(2, '0')}`),
        `the return is due ${res.json.dueBy}. VAT and WHT are both filed by the 21st of the following month — a return with the wrong date on it is a return that gets filed late`);
      assert.ok(['PAYABLE', 'RECOVERABLE', 'NIL'].includes(res.json.position), `the return's position is "${res.json.position}"`);
      audit.note(`output ${money(res.json.output.vat)} on ${res.json.output.sales} sale(s), input ${money(res.json.input.vat)} on ${res.json.input.entries} expense(s), net ${money(res.json.netPayable)} ${res.json.position}, due ${res.json.dueBy}`);
    });

    const expense = await audit.captureAsync('a business expense carrying input VAT', async () => {
      if (d.live && !d.writable) return null;
      const res = await o.post('/api/expenses', {
        branch_id: branch.id, category: 'RENT', amount: 107500, vat_amount: 7500,
        description: 'Audit: shop rent with input VAT', expense_date: new Date().toISOString().slice(0, 10),
        paid_from: 'BANK', payment_method: 'BANK_TRANSFER', reference: `AUDIT-EXP-${Date.now().toString(36).slice(-5)}`,
      });
      if (res.status !== 200 && res.status !== 201) throw new Error(`the expense answered ${res.status}: ${res.text.slice(0, 300)}`);
      return res.json;
    });

    if (expense) {
      await audit.checkAsync('input VAT on an expense reduces what is payable', async () => {
        const res = await o.get('/api/accounting/vat');
        assert.ok(Number(res.json.input.vat) >= 7500,
          `the return shows ${money(res.json.input.vat)} of input VAT after a registered business recorded ${money(7500)} on a rent invoice. A registered business recovers input VAT; ignoring it overstates what is owed to FIRS by exactly that much`);
        const expected = round2(Number(res.json.output.vat) - Number(res.json.input.vat));
        assert.equal(round2(Number(res.json.netPayable)), expected,
          `net payable is ${money(res.json.netPayable)} and output less input is ${money(expected)}`);
      });
    } else {
      audit.skip('read-only target: no expense could be recorded', 'the input-VAT credit is not asserted');
    }

    // VAT OFF IS NOT VAT FREE — it is the business's own liability, so the switch has to
    // actually change the receipt.
    const off = await audit.captureAsync('VAT switched off', async () => {
      if (d.live && !d.writable) return null;
      const res = await o.put('/api/settings', { vat_enabled: 0 });
      return res.status === 200 ? res.json.settings : null;
    });
    if (off) {
      await audit.checkAsync('with VAT switched off the counter charges none, and the return does not grow', async () => {
        // Read the position BEFORE the VAT-free sale, so the comparison is a delta rather
        // than an absolute — the earlier VAT-bearing sale is legitimately still in the
        // return, and the first draft of this check forgot that and described a defect the
        // product did not have.
        const before = await o.get('/api/accounting/vat');
        const res = await o.post('/api/sales', {
          branch_id: branch.id, lines: [{ product_id: product.id, quantity: 1 }],
          payments: [{ method: 'CASH', amount: grossPrice, cash_tendered: grossPrice }],
          device_id: 'audit-wht',
        }, { idempotencyKey: `wht-vat-off-${Date.now().toString(36)}` });
        assert.equal(res.status, 201, `the sale answered ${res.status}`);
        assert.equal(round2(res.json.vat.vatAmount), 0,
          `the receipt charges ${money(res.json.vat.vatAmount)} of VAT with the setting off — a business that is not registered must not be collecting tax it cannot remit`);
        const back = await o.get('/api/accounting/vat');
        assert.equal(round2(Number(back.json.output.vat)), round2(Number(before.json.output.vat)),
          `output VAT moved from ${money(before.json.output.vat)} to ${money(back.json.output.vat)} because of a sale that charged none`);
        assert.equal(Number(back.json.output.sales), Number(before.json.output.sales),
          'the number of VAT-bearing sales rose after a sale that carried no VAT');
      });
      // Put it back as it was FOUND, not as the audit left it: on a live deployment the
      // registered state may have been off (a business that is not VAT-registered), and
      // switching it on here would have been a quiet change to somebody's tax position.
      await o.put('/api/settings', {
        vat_enabled: Number((d.settings || {}).vat_enabled) === 1 ? 1 : 0,
        vat_rate_percent: (d.settings || {}).vat_rate_percent == null ? 7.5 : Number(d.settings.vat_rate_percent),
      });
    }
  }

  // ===================================================================
  // WHO MAY TOUCH THE TAX AT ALL
  // ===================================================================
  audit.section('The tax tables are not a clerk\'s business');

  if (!staff) {
    audit.skip('no staff seat was created', 'the floor-level boundary on tax is not asserted');
  } else {
    // READING THE POSITION IS NOT A PRIVILEGE; FILING IT IS. A shop-floor account may
    // need to see what has been withheld on the invoices in front of them, and hiding it
    // would only push the arithmetic onto paper. What must never be possible is declaring
    // to FIRS that money has been sent.
    await audit.checkAsync('the tax position is readable by the people who have to act on it', async () => {
      const res = await staff.get('/api/accounting/wht');
      assert.equal(res.status, 200, `a staff member got ${res.status} reading the withholding position`);
    });

    if (unremitted) {
      await audit.refusal('a staff member cannot declare tax remitted to FIRS', () => staff.post(`/api/accounting/wht/${unremitted.id}/remitted`, {
        reference: 'AUDIT-STAFF-FIRS-1', remitted_at: new Date().toISOString().slice(0, 10),
      }), { expectStatus: 403, code: /ROLE|OWNER/i });
    } else {
      audit.skip('nothing was left unremitted for the staff seat to try to file', 'the filing boundary is asserted for a manager above instead');
    }
  }
}, {
  setup: () => startDeployment({
    label: 'wht',
    owner: { name: 'WHT Audit Owner', username: 'wht-owner', pin: '48014' },
    admin: { username: 'wht-admin', pin: '48014' },
    businesses: [{
      name: 'WHT Audit Electricals', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [{ name: 'Karu Shop', code: 'WHT-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 100000 }],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'wht-manager', pin: '73041', branchIndex: 0, full_name: 'WHT Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'wht-staff', pin: '73041', branchIndex: 0, full_name: 'WHT Audit Staff' },
    ],
  }),
});
