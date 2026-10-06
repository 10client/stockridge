'use strict';
// =====================================================================
// test/audit/audit.reports.js — THE NUMBERS A SHOP DECIDES ON
// =====================================================================
// `tools/flow-coverage.js` listed reports at 0/8 — the largest flow with no audit at all, and
// the one where being wrong is quietest. A report does not throw, does not refuse, and does not
// look broken when it is wrong: it answers 200 with a figure, and somebody orders stock, pays
// commission or files a return on it.
//
// So this audit does not test that the routes answer. It tests that they AGREE — with the trade
// this run can see, and with each other:
//
//   FRONT TO BACK  ring the trade: three sales (one voided), a damage write-off, an expense, a
//                  sales target.
//   BACK TO FRONT  read every report and hold each figure against the trade it is reporting:
//                  revenue per product, cost, margin, the void that must be excluded, the
//                  shrinkage the write-off created, the debtor the credit sale created, the
//                  commission the net revenue implies, the target's attainment.
//   AND EACH OTHER the export must equal the screen (the product's own comment says an export
//                  that disagrees with the screen is worse than no export), the commission
//                  report's revenue must equal the sales report's, and the target's actual must
//                  equal the sales that user actually made.
//   AND THE REFUSALS  an unknown group-by, mover kind or export name; a staff member setting a
//                  target; a target that measures nothing; a period that ends before it starts.
//   AND THE SCOPE   a cashier at another branch must not see this branch's takings in any
//                  report — the leak that would matter most.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `₦${round2(n).toLocaleString('en-NG')}`;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const MARK = Date.now().toString(36).toUpperCase().slice(-6);

/**
 * RFC-4180 CSV reader, for the same reason the writer exists: a report that opens broken is a
 * report nobody trusts, and an audit that checks a CSV with `includes()` is not checking it.
 */
function parseCsv(text) {
  const body = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
}

/** Sum a named column over the data rows of a CSV. */
function csvSum(parsed, column) {
  const head = parsed[0];
  const at = head.indexOf(column);
  assert.ok(at >= 0, `the export has no "${column}" column — it has: ${head.join(', ')}`);
  return round2(parsed.slice(1).reduce((a, r) => a + (Number(r[at]) || 0), 0));
}

/** The rows of a CSV whose named column equals one of a set of values. */
function csvRows(parsed, column, values) {
  const at = parsed[0].indexOf(column);
  if (at < 0) return [];
  const want = values.map(String);
  return parsed.slice(1).filter((r) => want.includes(String(r[at])));
}

runAudit('reports', async (audit, d) => {
  const owner = d.owner || d.admin;
  const manager = (d.seats && d.seats.manager) || null;
  const elsewhere = (d.seats && d.seats.elsewhere) || null;
  if (!manager || !elsewhere) throw new Error('the reports fixture needs a MANAGER seat (to trade as) and a STAFF seat at a second branch (to prove the takings are not visible across branches)');
  const branch = (d.branches || [])[0];
  const other = (d.branches || [])[1] || null;
  assert.ok(branch && other, 'the reports fixture needs two branches');

  // ===================================================================
  // THE TRADE THIS RUN CAN SEE
  // ===================================================================
  const product = await audit.captureAsync('a product with a known cost, to trade in', async () => {
    const res = await owner.post('/api/products', {
      name: `Audit Report Widget ${MARK}`, sku: `AUD-RPT-${MARK}`,
      base_unit_name: 'piece', cost_price: 1000, selling_price: 2000,
    });
    assert.ok(res.status < 400, `creating the product answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const id = res.json.id || (res.json.product && res.json.product.id);
    assert.ok(id, 'the product was created and the answer carries no id');
    d.trackRestore(`product ${MARK}`, async () => {
      const del = await manager.del(`/api/products/${encodeURIComponent(id)}`);
      if (del.status < 300 || del.status === 404) return true;
      const off = await manager.put(`/api/products/${encodeURIComponent(id)}`, { is_active: 0 });
      return off.status < 300;
    });
    const received = await manager.post('/api/stock/receive', {
      branch_id: branch.id, product_id: id, quantity: 12, unit_code: 'PIECE',
      cost_price: 1000, selling_price: 2000, batch_no: `RPT-${MARK}`,
    });
    assert.ok(received.status < 400, `stocking the shelf answered ${received.status}: ${String(received.text).slice(0, 240)}`);
    return { id, name: `Audit Report Widget ${MARK}` };
  });
  const PRICE = 2000;
  const COST = 1000;

  // VAT ON, WITH THE SHOP'S OWN SETTINGS PUT BACK AT THE END. Without it the net-revenue and
  // commission checks below assert nothing — 5% of gross and 5% of net are the same number when
  // there is no tax in the price, and "commission is paid on net" is exactly the rule that goes
  // wrong when VAT is switched on in a live shop.
  await audit.captureAsync('VAT switched on, as a registered shop would have it', async () => {
    if (d.live && !d.writable) return null;
    const was = d.settings || {};
    d.trackRestore('VAT settings', async () => {
      const res = await owner.put('/api/settings', {
        vat_enabled: Number(was.vat_enabled) === 1 ? 1 : 0,
        vat_rate_percent: was.vat_rate_percent == null ? 7.5 : Number(was.vat_rate_percent),
      });
      return res.status < 300;
    });
    const res = await owner.put('/api/settings', { vat_enabled: 1, vat_rate_percent: 7.5 });
    assert.equal(res.status, 200, `switching VAT on answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    return true;
  });

  const customerName = `Report Audit Customer ${MARK}`;
  const customer = await audit.captureAsync('a customer who buys on credit', async () => {
    const res = await owner.post('/api/customers', {
      // THE BRANCH IS NAMED. The administrator reaches both branches and the route refuses
      // to guess which one a new debtor belongs to — the same "an owner with two businesses"
      // trap the sales report itself documents.
      branch_id: branch.id,
      name: customerName, phone: `0805${String(Date.now()).slice(-7)}`,
      customer_type: 'INDIVIDUAL', address: '7 Report Row, Wuse 2, Abuja',
      credit_limit: 500000, payment_terms_days: 30,
    });
    assert.ok(res.status < 400, `creating the customer answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const id = res.json.id || (res.json.customer && res.json.customer.id);
    assert.ok(id, 'the customer was created and the answer carries no id');
    d.trackCustomer(id);
    return { id, name: customerName };
  });

  // The seat that trades is the one the TARGET is set for, so the target's own attainment can be
  // checked against a figure this audit knows exactly — no other person's sales can land on a
  // user this run just created.
  const seat = await audit.captureAsync('a commission rate on the seat that trades', async () => {
    // LOOKED UP BY USERNAME, NOT READ OFF THE SEAT. `d.seats.<as>.user` is null on a local
    // deployment (only a live sign-in returns the user object), so reading it here left the
    // commission and target half of this audit measuring nothing.
    const list = await owner.get(`/api/users?q=${encodeURIComponent(manager.username)}&limit=20`);
    const row = (list.json.data || []).filter((u) => String(u.username) === String(manager.username))[0];
    assert.ok(row, `the seat ${manager.username} is not in the user list, so its commission rate cannot be set`);
    const res = await owner.put(`/api/users/${encodeURIComponent(row.id)}`, { commission_rate_pct: 5 });
    assert.ok(res.status < 400, `setting a 5% commission rate answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    audit.note(`commission set at 5% on ${manager.username}`);
    return { id: row.id, username: manager.username };
  });

  const cashSale = await audit.captureAsync('a cash sale of three widgets', async () => {
    const res = await manager.post('/api/sales', {
      branch_id: branch.id, customer_id: customer.id,
      lines: [{ product_id: product.id, quantity: 3 }],
      payments: [{ method: 'CASH', amount: 3 * PRICE, cash_tendered: 3 * PRICE }],
      device_id: 'audit-reports',
    }, { idempotencyKey: `rpt-cash-${MARK}` });
    assert.ok(res.status < 400, `the cash sale answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    return { id: res.json.id || res.json.saleId, receiptNo: res.json.receiptNo || res.json.receipt_no, total: round2(res.json.total) };
  });

  const creditSale = await audit.captureAsync('a credit sale of two widgets', async () => {
    const res = await manager.post('/api/sales', {
      branch_id: branch.id, customer_id: customer.id, sale_type: 'CREDIT',
      lines: [{ product_id: product.id, quantity: 2 }],
      payments: [{ method: 'CREDIT', amount: 2 * PRICE }],
      device_id: 'audit-reports',
    }, { idempotencyKey: `rpt-credit-${MARK}` });
    assert.ok(res.status < 400, `the credit sale answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    return { id: res.json.id || res.json.saleId, receiptNo: res.json.receiptNo || res.json.receipt_no, balanceDue: round2(res.json.balanceDue) };
  });

  const voided = await audit.captureAsync('a sale that is then voided', async () => {
    const made = await manager.post('/api/sales', {
      branch_id: branch.id, customer_id: customer.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: PRICE, cash_tendered: PRICE }],
      device_id: 'audit-reports',
    }, { idempotencyKey: `rpt-void-${MARK}` });
    assert.ok(made.status < 400, `the sale to be voided answered ${made.status}: ${String(made.text).slice(0, 240)}`);
    const id = made.json.id || made.json.saleId;
    // A VOID IS THE CASE THAT MOST OFTEN LEAKS INTO A REPORT: the money never happened, and a
    // report that counts it overstates the day and the commission with it.
    const res = await manager.post(`/api/sales/${encodeURIComponent(id)}/void`, {
      reason: 'Audit: voided deliberately to prove the reports exclude it',
    });
    assert.ok(res.status < 400, `voiding the sale answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    return { id, receiptNo: made.json.receiptNo || made.json.receipt_no, total: PRICE };
  });

  // ===================================================================
  // EVERY REPORT READ NAMES THE BRANCH THIS RUN TRADED AT
  // ===================================================================
  // The reports resolve the branch from the caller when the request names none — right for a
  // cashier, wrong for this audit: on a live deployment the administrator's resolved branch
  // ("Verify Branch") is NOT the fixture's (`branches[0]`, another audit's branch), so an unpinned
  // read reports on a shop this run never traded in. Locally the two coincide, which is exactly
  // how a live-only false failure is born.
  const SC = (query, path = 'sales') => `/api/reports/${path}?${query}&branch_id=${encodeURIComponent(branch.id)}`;

  const expected = {
    units: 5,                       // 3 cash + 2 credit; the voided unit is not sold
    gross: round2(5 * PRICE),       // 10,000
    cogs: round2(5 * COST),         // 5,000
    transactions: 2,
    outstanding: 2 * PRICE,
  };
  audit.note(`trade written: ${expected.transactions} live sales, ₦${expected.gross} gross, ₦${expected.outstanding} on credit, 1 void of ₦${PRICE}`);

  // ===================================================================
  // THE SALES REPORT
  // ===================================================================
  await audit.checkAsync('the product line reports the revenue, the cost and the margin of the sales made', async () => {
    const res = await owner.get(SC('group_by=PRODUCT&days=7'));
    assert.equal(res.status, 200, `the sales report answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const row = (res.json.rows || []).filter((r) => String(r.label).includes(MARK) || String(r.key) === String(product.id))[0];
    assert.ok(row, `the product just sold is not on the product report. Products: ${(res.json.rows || []).map((r) => r.label).slice(0, 8).join(', ')}`);
    assert.equal(Number(row.transactions), expected.transactions,
      `the report counts ${row.transactions} transaction(s) for the product against the ${expected.transactions} that were not voided. A voided sale is money that never happened, and counting it overstates the day`);
    assert.equal(round2(row.grossRevenue), expected.gross, `gross revenue reads ${money(row.grossRevenue)} against ${money(expected.gross)} sold`);
    assert.equal(round2(row.cogs), expected.cogs, `cost of goods reads ${money(row.cogs)} against ${money(expected.cogs)} of stock at the batch cost`);
    assert.equal(round2(row.grossMargin), round2(row.netRevenue - row.cogs),
      'the margin does not equal net revenue less cost — the two halves of the same figure disagree');
    assert.equal(round2(row.vat + row.netRevenue), round2(row.grossRevenue),
      `VAT (${money(row.vat)}) and net revenue (${money(row.netRevenue)}) do not add up to gross (${money(row.grossRevenue)})`);
    assert.ok(res.json.note && /FIRS/i.test(res.json.note),
      'the report does not say that the gross figure includes VAT collected for FIRS — the single most common misreading of a Nigerian retail report');
  });

  await audit.checkAsync('the day’s grouping carries the same money as the product grouping', async () => {
    const res = await owner.get(SC('group_by=DAY&days=7'));
    const today = (res.json.rows || []).filter((r) => String(r.key) === day(0))[0];
    assert.ok(today, `today (${day(0)}) is not on the daily report. Rows: ${(res.json.rows || []).map((r) => r.key).join(', ')}`);
    assert.ok(round2(today.grossRevenue) >= expected.gross,
      `today's gross revenue reads ${money(today.grossRevenue)} against at least ${money(expected.gross)} of trade this run just wrote to this branch`);
    const productReport = await owner.get(SC('group_by=PRODUCT&days=7'));
    const mine = (productReport.json.rows || []).filter((r) => String(r.label).includes(MARK))[0];
    assert.ok(round2(mine.grossRevenue) <= round2(today.grossRevenue),
      `the product grouping reports ${money(mine.grossRevenue)} of a product sold today while the day total is ${money(today.grossRevenue)} — a line cannot exceed its day`);
    assert.equal(Number(res.json.totals.transactions) >= expected.transactions, true,
      `the day report totals ${res.json.totals.transactions} transaction(s), fewer than the ${expected.transactions} this run wrote`);
  });

  await audit.checkAsync('the cash sale and the credit sale land in different places', async () => {
    const res = await owner.get(SC('group_by=SALE_TYPE&days=7'));
    assert.equal(res.status, 200, `the report by sale type answered ${res.status}`);
    const rows = res.json.rows || [];
    const credit = rows.filter((r) => String(r.key).toUpperCase() === 'CREDIT')[0];
    assert.ok(credit, `there is no CREDIT row on the report by sale type. Rows: ${rows.map((r) => r.key).join(', ')}`);
    assert.ok(round2(credit.grossRevenue) >= expected.outstanding,
      `the credit row reports ${money(credit.grossRevenue)} against ${money(expected.outstanding)} sold on credit just now`);
    // OUTSTANDING IS THE FIGURE THAT MATTERS ON A CREDIT SALE: the goods left and the money has not.
    assert.ok(round2(credit.outstanding) >= expected.outstanding,
      `the credit row reports ${money(credit.outstanding)} outstanding against ${money(expected.outstanding)} that has not been paid`);
    const cash = rows.filter((r) => String(r.key).toUpperCase() === 'RETAIL')[0];
    if (cash) {
      assert.equal(round2(cash.outstanding), 0,
        `the retail counter row reports ${money(cash.outstanding)} outstanding — a cash sale that leaves a balance is either a data error or an unpaid debt nobody recorded as one`);
    }
  });

  await audit.checkAsync('the void is counted separately and excluded from the takings', async () => {
    const res = await owner.get(SC('group_by=DAY&days=7'));
    assert.equal(res.status, 200, `the sales report answered ${res.status}`);
    assert.ok(Number(res.json.voided.count) >= 1,
      `the report says ${res.json.voided.count} sale(s) were voided and this run voided one — a void that does not appear anywhere is a void nobody is watching for`);
    assert.ok(round2(res.json.voided.value) >= PRICE,
      `voided value reads ${money(res.json.voided.value)} against at least ${money(PRICE)}`);
    const productReport = await owner.get(SC('group_by=PRODUCT&days=7'));
    const mine = (productReport.json.rows || []).filter((r) => String(r.label).includes(MARK))[0];
    assert.equal(round2(mine.grossRevenue), expected.gross,
      `the product reports ${money(mine.grossRevenue)}: if the voided sale were counted it would be ${money(round2(expected.gross + PRICE))}. The two figures are the whole test`);
  });

  await audit.checkAsync('the cashier’s own line carries the trade they rang', async () => {
    const res = await owner.get(SC('group_by=CASHIER&days=7'));
    assert.equal(res.status, 200, `the report by cashier answered ${res.status}`);
    const row = (res.json.rows || []).filter((r) => String(r.key) === String(seat.id))[0];
    assert.ok(row, `the seat that rang the sales is not on the cashier report (${(res.json.rows || []).length} row(s))`);
    assert.equal(Number(row.transactions), expected.transactions, `the cashier's row counts ${row.transactions} transaction(s) against ${expected.transactions}`);
    assert.equal(round2(row.grossRevenue), expected.gross, `the cashier's row reads ${money(row.grossRevenue)} against ${money(expected.gross)}`);
  });

  await audit.checkAsync('an unknown grouping is refused, not silently ignored', async () => {
    const res = await owner.get('/api/reports/sales?group_by=NONSENSE');
    assert.equal(res.status, 400, `an unknown group_by answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'NOT_ALLOWED', `the refusal came back as ${res.json.code}`);
  });

  // ===================================================================
  // INVENTORY, MOVERS, SHRINKAGE
  // ===================================================================
  const writeOff = await audit.captureAsync('one widget damaged and written off', async () => {
    const res = await manager.post('/api/stock/adjust', {
      branch_id: branch.id, product_id: product.id, quantity: 1,
      adjustment_type: 'DAMAGE', reason: 'Audit: cracked casing found on the shelf',
    });
    assert.ok(res.status < 400, `writing off a damaged unit answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    return { value: round2(res.json.totalValue || res.json.total_value || COST) };
  });

  await audit.checkAsync('inventory movement reports units in, units out and what is left', async () => {
    const res = await owner.get(SC('days=7', 'inventory-movement'));
    assert.equal(res.status, 200, `the inventory report answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const row = (res.json.data || []).filter((r) => String(r.product_id || r.id) === String(product.id))[0];
    assert.ok(row, `the product is not on the inventory movement report (${(res.json.data || []).length} row(s))`);
    // 12 received, 5 sold, 1 written off, 6 left. Every one of those numbers is a claim the
    // report makes about the same shelf, and they have to reconcile with each other.
    const onHand = round2(Number(row.on_hand_quantity != null ? row.on_hand_quantity : row.on_hand));
    const sold = round2(Number(row.units_sold));
    assert.equal(sold, expected.units, `the report says ${sold} unit(s) left and ${expected.units} were sold`);
    assert.equal(onHand, 6, `the report says ${onHand} unit(s) are on the shelf: 12 received, ${expected.units} sold, 1 written off leaves 6`);
    assert.ok(Number(row.adjustment_units || 0) <= 0 || Number(row.adjustment_units) === 1,
      `the report shows ${row.adjustment_units} of adjustment, and the only one this run made took a unit off the shelf`);
    assert.ok(res.json.range && res.json.range.from && res.json.range.to, 'the report does not say which period it covers');
  });

  await audit.checkAsync('the fast-mover report names the product that sold', async () => {
    const res = await owner.get(SC('kind=FAST&days=7', 'movers'));
    assert.equal(res.status, 200, `the movers report answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const row = (res.json.data || []).filter((r) => String(r.product_id) === String(product.id))[0];
    assert.ok(row, 'a product that sold five units in a week is not on the fast-mover report');
    assert.equal(round2(row.units_sold), expected.units, `the mover row says ${row.units_sold} unit(s) sold against ${expected.units}`);
    assert.equal(round2(row.gross_margin), round2(row.revenue - row.cogs), 'the mover row margin does not equal its revenue less its cost');
    assert.ok(row.days_of_cover != null, 'the mover row does not say how many days of cover are left, which is the number the reorder decision is made on');
  });

  await audit.checkAsync('the shrinkage report carries the write-off and its value', async () => {
    const res = await owner.get(SC('kind=SHRINKAGE&days=7', 'movers'));
    assert.equal(res.status, 200, `the shrinkage report answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const row = (res.json.data || []).filter((r) => String(r.product_id) === String(product.id))[0];
    assert.ok(row, 'the unit written off as damaged today is not on the shrinkage report — a write-off no report shows is a write-off nobody reviews');
    assert.equal(round2(row.units_lost), 1, `the shrinkage row says ${row.units_lost} unit(s) lost against the one written off`);
    assert.equal(round2(row.value_lost), round2(writeOff.value), `the shrinkage row values the loss at ${money(row.value_lost)} against ${money(writeOff.value)}`);
    assert.ok(Number(row.entries) >= 1, 'the shrinkage row does not say how many entries make it up');
  });

  await audit.checkAsync('the dead-stock report is the one list a product that just sold must NOT be on', async () => {
    const res = await owner.get(SC('kind=DEAD&days=7', 'movers'));
    assert.equal(res.status, 200, `the dead-stock report answered ${res.status}`);
    const row = (res.json.data || []).filter((r) => String(r.product_id) === String(product.id))[0];
    assert.ok(!row, `a product that sold ${expected.units} units today is reported as dead stock — the shop would discount or transfer stock that is moving`);
    assert.ok(res.json.summary && typeof res.json.summary.message === 'string', 'the dead-stock report gives no summary sentence');
  });

  await audit.checkAsync('an unknown mover kind is refused', async () => {
    const res = await owner.get('/api/reports/movers?kind=NONSENSE');
    assert.equal(res.status, 400, `an unknown kind answered ${res.status}`);
    assert.equal(res.json.code, 'NOT_ALLOWED', `the refusal came back as ${res.json.code}`);
  });

  // ===================================================================
  // CUSTOMERS, COMMISSION, TARGETS
  // ===================================================================
  await audit.checkAsync('the top-customers report carries the credit the customer took', async () => {
    const res = await owner.get(SC('days=7', 'top-customers'));
    assert.equal(res.status, 200, `the customer report answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const row = (res.json.data || []).filter((r) => String(r.id) === String(customer.id))[0];
    assert.ok(row, 'the customer who bought today is not on the report');
    assert.equal(Number(row.purchases), expected.transactions, `the report says ${row.purchases} purchase(s) against ${expected.transactions} sales`);
    assert.equal(round2(row.revenue), expected.gross, `the customer's revenue reads ${money(row.revenue)} against ${money(expected.gross)}`);
    assert.equal(round2(row.outstanding), expected.outstanding, `the customer owes ${money(expected.outstanding)} and the report says ${money(row.outstanding)}`);
    assert.equal(round2(row.averagePurchase), round2(expected.gross / expected.transactions), `the average purchase is ${money(row.averagePurchase)}`);
    assert.ok(res.json.concentration && Number(res.json.concentration.top5Pct) > 0,
      'the report does not say how concentrated the revenue is — the top-five share is what tells an owner how exposed they are to one customer');
  });

  await audit.checkAsync('commission is paid on net revenue, and matches the sales report', async () => {
    const res = await owner.get(SC('days=7', 'commission'));
    assert.equal(res.status, 200, `the commission report answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const row = (res.json.data || []).filter((r) => String(r.id) === String(seat.id))[0];
    assert.ok(row, 'the seat that made the sales is not on the commission report');
    assert.equal(Number(row.commission_rate_pct), 5, `the commission rate reads ${row.commission_rate_pct}% against the 5% set on the seat`);
    assert.equal(round2(row.commission), round2(Number(row.net_revenue) * 0.05),
      `the commission is ${money(row.commission)} and 5% of the net revenue ${money(row.net_revenue)} is ${money(round2(Number(row.net_revenue) * 0.05))}. Commission on gross would pay staff out of VAT that was never the business's money`);
    assert.ok(round2(row.net_revenue) < round2(row.revenue),
      `net revenue (${money(row.net_revenue)}) is not below gross (${money(row.revenue)}) — the VAT was not taken out before the commission was calculated`);
    assert.equal(Number(row.voids) >= 1, true, `the seat that voided a sale shows ${row.voids} void(s)`);
    // THE TWO REPORTS MUST AGREE ABOUT THE SAME PERIOD: the commission report derives its
    // revenue from the same sales as the sales report, and if they disagree one of them is
    // wrong — which one, nobody at the counter can tell.
    const sales = await owner.get(SC('group_by=DAY&days=7'));
    const mine = (sales.json.rows || []).filter((r) => String(r.key) === day(0))[0];
    assert.ok(mine, 'today is not on the sales report');
    assert.ok(round2(mine.grossRevenue) >= round2(row.revenue),
      `the sales report says ${money(mine.grossRevenue)} was taken today and the commission report says the seat took ${money(row.revenue)} — the seat's share cannot exceed the day`);
  });

  const target = await audit.captureAsync('a daily target for the seat, for the amount it sold', async () => {
    const res = await manager.post('/api/reports/targets', {
      period_type: 'DAILY', period_start: day(0), period_end: day(0),
      target_revenue: expected.gross, user_id: seat.id,
      branch_id: branch.id,
    });
    assert.ok(res.status === 201 || res.status === 200, `setting a target answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.ok(res.json.id, 'the target was set and the answer carries no id');
    d.trackRestore(`target ${MARK}`, async () => {
      const del = await manager.del(`/api/reports/targets/${encodeURIComponent(res.json.id)}`);
      return del.status < 300 || del.status === 404;
    });
    return { id: res.json.id };
  });

  await audit.checkAsync('the target’s attainment is the trade that seat actually did', async () => {
    const res = await owner.get('/api/reports/targets');
    assert.equal(res.status, 200, `the target report answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const row = (res.json.data || []).filter((r) => String(r.id) === String(target.id))[0];
    assert.ok(row, 'the target just set is not on the target report');
    assert.equal(round2(row.actual_revenue), expected.gross,
      `the target says the seat has taken ${money(row.actual_revenue)} against ${money(expected.gross)} of sales this run made on that seat. A target measured against the wrong trade is worse than no target: it is a performance conversation about somebody else's numbers`);
    assert.equal(Number(row.sales), expected.transactions, `the target counts ${row.sales} sale(s) against ${expected.transactions}`);
    assert.equal(round2(row.attainment_pct), 100, `attainment reads ${row.attainment_pct}% against a target of exactly what was sold`);
    assert.equal(row.on_track, true, 'a seat that has hit its daily target on the day is not "on track", which is the flag a manager reads');
    assert.ok(row.time_elapsed_pct != null && row.days_left != null,
      'the target does not say how much of the period has gone by — 40% of target with 80% of the month gone is a different situation from 40% with 20% gone');
  });

  await audit.checkAsync('a target that measures nothing, and one that ends before it starts, are both refused', async () => {
    const empty = await manager.post('/api/reports/targets', {
      period_type: 'MONTHLY', period_start: day(0), period_end: day(30),
    });
    assert.equal(empty.status, 400, `an empty target was accepted: ${empty.status}`);
    assert.equal(empty.json.code, 'EMPTY_TARGET', `the refusal came back as ${empty.json.code}`);

    const backwards = await manager.post('/api/reports/targets', {
      period_type: 'MONTHLY', period_start: day(10), period_end: day(1), target_revenue: 50000,
    });
    assert.equal(backwards.status, 400, `a target ending before it starts was accepted: ${backwards.status}`);
    assert.equal(backwards.json.code, 'INVALID_RANGE', `the refusal came back as ${backwards.json.code}`);
  });

  await audit.checkAsync('a staff member cannot set a target on themselves or anyone else', async () => {
    const res = await elsewhere.post('/api/reports/targets', {
      period_type: 'MONTHLY', period_start: day(0), period_end: day(30), target_revenue: 1000000,
    });
    assert.equal(res.status, 403, `a STAFF member set a sales target: ${res.status} ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'ROLE_REQUIRED', `the refusal came back as ${res.json.code}`);
  });

  // ===================================================================
  // THE EXPORT MUST EQUAL THE SCREEN
  // ===================================================================
  audit.section('The download and the screen have to say the same thing');

  const expense = await audit.captureAsync('an expense to appear on the expense export', async () => {
    const res = await manager.post('/api/expenses', {
      branch_id: branch.id, category: 'RENT', amount: 50000,
      description: `Audit report run ${MARK} — shop rent`, expense_date: day(0),
      paid_from: 'BANK', payment_method: 'BANK_TRANSFER', reference: `AUD-RPT-${MARK}`,
    });
    assert.ok(res.status < 400, `recording the expense answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    return { amount: 50000 };
  });

  await audit.checkAsync('the sales export carries every row the screen reports, and the same money', async () => {
    const res = await owner.get(SC('report=SALES&days=7', 'export'));
    assert.equal(res.status, 200, `the sales export answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    // THE BYTES, NOT THE DECODED TEXT: reading a body as text strips a leading BOM by
    // standard, so a check against `res.text` would fail on a file that is perfectly correct.
    assert.ok(res.bytes[0] === 0xEF && res.bytes[1] === 0xBB && res.bytes[2] === 0xBF,
      `the CSV does not begin with a UTF-8 byte-order mark (got ${res.bytes.slice(0, 3).toString('hex')}), so Excel on a Windows machine will read ₦ as mojibake`);
    assert.ok(/text\/csv/i.test(String(res.headers['content-type'] || '')), `the export arrived as ${res.headers['content-type']} instead of a CSV download`);
    assert.ok(/attachment/i.test(String(res.headers['content-disposition'] || '')), 'the export is not offered as a download');
    const parsed = parseCsv(res.text);
    assert.ok(parsed.length >= 1, 'the export has no rows at all');
    assert.ok(parsed[0].includes('Receipt') && parsed[0].includes('Total'),
      `the export's header row is ${parsed[0].join(', ')}`);
    const mine = csvRows(parsed, 'Receipt', [cashSale.receiptNo, creditSale.receiptNo]);
    assert.equal(mine.length, 2, `the export carries ${mine.length} of this run's 2 live sales — an export that drops a sale is a filed return that is short`);
    const voidedRow = csvRows(parsed, 'Receipt', [voided.receiptNo]);
    assert.equal(voidedRow.length, 1, 'the voided sale is missing from the export entirely — the export shows every movement, including the ones that did not count');
    assert.ok(String(voidedRow[0][parsed[0].indexOf('Status')]).toUpperCase().includes('VOID'),
      `the voided sale's row reads status "${voidedRow[0][parsed[0].indexOf('Status')]}"`);
    const totalAt = parsed[0].indexOf('Total');
    const sum = round2(mine.reduce((a, r) => a + Number(r[totalAt]), 0));
    assert.equal(sum, expected.gross, `the two exported sales total ${money(sum)} against ${money(expected.gross)} rung up`);
  });

  await audit.checkAsync('the line-level export’s margin agrees with the margin the sales report shows', async () => {
    const res = await owner.get(SC('report=SALES_DETAIL&days=7', 'export'));
    assert.equal(res.status, 200, `the line export answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const parsed = parseCsv(res.text);
    assert.ok(parsed[0].includes('Margin'), `the line export has no Margin column: ${parsed[0].join(', ')}`);
    const mine = csvRows(parsed, 'SKU', [`AUD-RPT-${MARK}`]);
    assert.equal(mine.length, expected.transactions, `the line export carries ${mine.length} line(s) of this product against ${expected.transactions} sold`);
    const marginAt = parsed[0].indexOf('Margin');
    const margin = round2(mine.reduce((a, r) => a + Number(r[marginAt]), 0));

    const screen = await owner.get(SC('group_by=PRODUCT&days=7'));
    const row = (screen.json.rows || []).filter((r) => String(r.label).includes(MARK))[0];
    assert.equal(margin, round2(row.grossMargin),
      `the download reports ${money(margin)} of margin on this product and the screen reports ${money(row.grossMargin)}. An export that disagrees with the screen is worse than no export, because it is the one that gets filed`);
  });

  await audit.checkAsync('the debtor export carries the balance the credit sale left, and the stock export the shelf', async () => {
    const debtors = parseCsv((await owner.get(SC('report=DEBTORS', 'export'))).text);
    assert.ok(debtors[0].includes('Customer'), `the debtor export header is ${debtors[0].join(', ')}`);
    const row = csvRows(debtors, 'Customer', [customerName])[0];
    assert.ok(row, `the customer owing ${money(expected.outstanding)} is not on the debtor export`);
    assert.equal(round2(Number(row[debtors[0].indexOf('Balance')])), expected.outstanding,
      `the debtor export says the customer owes ${money(row[debtors[0].indexOf('Balance')])} against ${money(expected.outstanding)}`);

    const stock = parseCsv((await owner.get(SC('report=STOCK', 'export'))).text);
    const stockRow = csvRows(stock, 'SKU', [`AUD-RPT-${MARK}`])[0];
    assert.ok(stockRow, 'the product received this run is not on the stock export');
    const qty = Number(stockRow[stock[0].indexOf('Qty')]);
    assert.equal(round2(qty), 6, `the stock export says ${qty} unit(s) on the shelf against 12 received, ${expected.units} sold and 1 written off`);

    const expenses = parseCsv((await owner.get(SC('report=EXPENSES&days=7', 'export'))).text);
    const expAt = expenses[0].indexOf('Gross');
    const expRow = csvRows(expenses, 'Reference', [`AUD-RPT-${MARK}`])[0] || (expenses.slice(1).filter((r) => r.some((c) => String(c).includes(`Audit report run ${MARK}`)))[0]);
    assert.ok(expRow, `the expense recorded this run is not on the expense export. Header: ${expenses[0].join(', ')}`);
    assert.equal(round2(Number(expRow[expAt])), expense.amount, `the expense export shows ${money(expRow[expAt])} against ${money(expense.amount)} recorded`);

    const adjustments = parseCsv((await owner.get(SC('report=ADJUSTMENTS&days=7', 'export'))).text);
    const adjRow = csvRows(adjustments, 'Product', [product.name])[0];
    assert.ok(adjRow, `the write-off is not on the adjustment export. Header: ${adjustments[0].join(', ')}`);
    assert.ok(String(adjRow.join(' ')).includes('DAMAGE'), `the adjustment export shows the write-off as ${adjRow[adjustments[0].indexOf('Type')]}`);
  });

  await audit.checkAsync('an unknown export name is refused rather than answered with the wrong report', async () => {
    const res = await owner.get('/api/reports/export?report=NONSENSE');
    assert.equal(res.status, 400,
      `an unknown report name answered ${res.status}. A download that quietly returns the sales ledger when asked for something else is how the wrong figures reach an accountant`);
    assert.equal(res.json.code, 'NOT_ALLOWED', `the refusal came back as ${res.json.code}`);
  });

  // ===================================================================
  // THE SCOPE — TAKINGS ARE NOT FOR EVERYBODY
  // ===================================================================
  await audit.checkAsync('a cashier at another branch cannot see this branch’s takings in any report', async () => {
    // THESE READS NAME NO BRANCH ON PURPOSE. The question is what a cashier at another shop sees
    // by DEFAULT — pinning the request to this branch would make the product refuse a scope
    // violation and the check would pass without proving anything. And the rows are identified by
    // the CUSTOMER and the SKU rather than by receipt number: receipts are numbered per branch, so
    // a cashier's own shop legitimately has a receipt with the same number, which is how an
    // earlier version of this check reported a leak that was not there.
    const productReport = await elsewhere.get('/api/reports/sales?group_by=PRODUCT&days=7');
    assert.equal(productReport.status, 200, `the sales report as another branch's staff answered ${productReport.status}`);
    const leaked = (productReport.json.rows || []).filter((r) => String(r.label).includes(MARK));
    assert.equal(leaked.length, 0,
      `a cashier pinned to ${other.name} can see the takings of a product sold at ${branch.name}: ${leaked.map((r) => `${r.label} ${money(r.grossRevenue)}`).join(', ')}. Branch scope is what stops every counter reading every other counter's day`);

    const movers = await elsewhere.get('/api/reports/movers?kind=FAST&days=7');
    const moverRow = (movers.json.data || []).filter((r) => String(r.product_id) === String(product.id))[0];
    assert.ok(!moverRow, `the mover report leaks ${branch.name}'s trade to a cashier at ${other.name}`);

    const exportRes = await elsewhere.get('/api/reports/export?report=SALES&days=7');
    const leakedSales = csvRows(parseCsv(exportRes.text), 'Customer', [customerName]);
    assert.equal(leakedSales.length, 0,
      `the sales EXPORT gives a cashier at ${other.name} a sale to ${customerName} at ${branch.name}. A download is the easiest leak there is: one tap and the whole day's takings leave the shop`);
    const detail = await elsewhere.get('/api/reports/export?report=SALES_DETAIL&days=7');
    const leakedLines = csvRows(parseCsv(detail.text), 'SKU', [`AUD-RPT-${MARK}`]);
    assert.equal(leakedLines.length, 0, `the line-level export leaks ${branch.name}'s sales of product ${MARK} to another branch's cashier`);
  });
}, {
  setup: () => startDeployment({
    label: 'reports',
    businesses: [{
      name: 'Reports Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Reports Audit Branch', code: 'RPT-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 30000 },
        { name: 'Reports Audit Annexe', code: 'RPT-2', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 10000 },
      ],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'rpt-manager', pin: '60901', branchIndex: 0, full_name: 'Reports Audit Manager' },
      { as: 'elsewhere', role: 'STAFF', username: 'rpt-elsewhere', pin: '60902', branchIndex: 1, full_name: 'Reports Audit Other Branch' },
    ],
  }),
});
