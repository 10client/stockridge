'use strict';
// =====================================================================
// test/audit/audit.fulfilment.js — A PLAN TO BE REPAID, AND GOODS TO BE DELIVERED
// =====================================================================
// `tools/flow-coverage.js` listed instalments (0/4) and deliveries (0/4) as never exercised
// by a live audit. They are the two flows where the shop's obligation OUTLIVES the sale:
//
//   * THE LOAN IS FORGOTTEN. An instalment plan is a debt with a schedule, and a payment
//     that is taken but not allocated leaves the customer owing money they have paid.
//   * THE GOODS NEVER ARRIVE. A delivery job is work: a job that sits on the board, or is
//     closed without proof, is a customer who paid a delivery fee and is still waiting.
//
// So this audit opens a plan and pays it down, and rings a delivery sale and drives it to
// the door, reading the deployment's own figures at every step:
//
//   FRONT TO BACK  open a plan → pay → the schedule row is PAID and the balance falls.
//                  ring a delivery sale → the job appears on the board with its items.
//   BACK TO FRONT  read the plan from the list and the detail, and the overdue summary.
//                  drive the job to DELIVERED, book the installation, complete it, and read
//                  the warranty that starts at commissioning.
//   AND THE REFUSALS a payment that cannot be allocated, a staff plan, a staff status
//                  reversal, a failed drop with no note, and a second installation job.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `₦${round2(n).toLocaleString('en-NG')}`;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

runAudit('fulfilment', async (audit, d) => {
  const owner = d.owner || d.admin;
  const staff = (d.seats && d.seats.staff) || null;
  const manager = (d.seats && d.seats.manager) || null;
  if (!staff || !manager) throw new Error('the fulfilment fixture needs a STAFF and a MANAGER seat — a loan only a manager may open, and a delivery board a driver has to work');
  const branch = (d.branches || [])[0];
  assert.ok(branch, 'the fulfilment fixture has no branch to trade at');

  const product = await audit.captureAsync('a product to sell, deliver and install', async () => {
    const res = await owner.get('/api/products?limit=200');
    assert.equal(res.status, 200, `the catalogue answered ${res.status}`);
    const rows = (res.json.data || res.json.products || []);
    const pick = rows.filter((p) => Number(p.selling_price) > 0)[0];
    assert.ok(pick, 'the catalogue has no priced product — the starter catalogue is missing');
    // INSTALLATION IS A PROPERTY OF THE PRODUCT, and the route refuses an installation job
    // for anything not flagged ("If it does, tick that on the product first — the flag is
    // what makes warranty start at commissioning rather than at sale").
    const flagged = await owner.put(`/api/products/${encodeURIComponent(pick.id)}`, { requires_installation: 1 });
    assert.ok(flagged.status < 400, `flagging the product as needing installation answered ${flagged.status}: ${String(flagged.text).slice(0, 200)}`);
    return pick;
  });
  const unitPrice = round2(product.selling_price);
  audit.note(`${product.sku} ${product.name} at ${money(unitPrice)} — ${branch.name}`);

  // THE NAME IS BUILT HERE, NOT READ BACK OUT OF THE ANSWER. The route replies with a
  // message, not the record, so `res.json.name` was undefined and the fixture fell back to
  // 'Fulfilment Audit Customer' — a name the customer does not actually carry, which then
  // failed a comparison against the deployment's own stored name. One name, used everywhere.
  const customerName = `Fulfilment Audit Customer ${Date.now().toString(36).slice(-4)}`;
  const customer = await audit.captureAsync('a customer to owe the shop and to receive goods', async () => {
    const res = await owner.post('/api/customers', {
      name: customerName,
      phone: `0807${String(Date.now()).slice(-7)}`,
      customer_type: 'INDIVIDUAL',
      address: '12 Fulfilment Close, Wuse 2, Abuja',
    });
    assert.ok(res.status < 400, `creating the customer answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const id = res.json.id || (res.json.customer && res.json.customer.id);
    assert.ok(id, 'the customer was created and the answer carries no id');
    d.trackCustomer(id);
    return { id, name: customerName };
  });

  await audit.checkAsync('stock on the shelf to sell and deliver', async () => {
    const adj = await owner.post('/api/stock/adjust', {
      branch_id: branch.id, product_id: product.id, quantity: 4,
      adjustment_type: 'FOUND', reason: 'Fulfilment audit — stock to sell, deliver and install',
    });
    assert.ok(adj.status < 400, `stocking the shelf answered ${adj.status}: ${String(adj.text).slice(0, 200)}`);
  });

  // ===================================================================
  audit.section('A plan to be repaid — the schedule is the contract');
  // ===================================================================
  const PRINCIPAL = round2(unitPrice * 2);
  const TENURE = 4;
  const INTEREST = 10;
  const plan = await audit.captureAsync('a manager opens an instalment plan', async () => {
    // OPENED BY A MANAGER, because it is a loan: "Only a manager or above can open an
    // instalment plan. It is a loan, and the business carries the risk until it is repaid."
    const res = await manager.post('/api/instalments', {
      branch_id: branch.id,
      customer_id: customer.id,
      principal: PRINCIPAL,
      deposit_amount: round2(PRINCIPAL * 0.2),
      tenure_months: TENURE,
      frequency: 'MONTHLY',
      interest_percent: INTEREST,
      schedule_start: day(0),
    }, { idempotencyKey: `fulfilment-plan-${Date.now().toString(36)}` });
    assert.ok(res.status === 201 || res.status === 200, `opening the plan answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    const id = res.json.id || res.json.planId || (res.json.plan && res.json.plan.id);
    assert.ok(id, 'the plan was opened and the answer carries no id');
    return { id, planNo: res.json.planNo || res.json.plan_no, schedule: res.json.schedule || [] };
  });
  audit.note(`plan ${plan.planNo || plan.id.slice(0, 8)} for ${money(PRINCIPAL)} over ${TENURE} months at ${INTEREST}%`);

  await audit.checkAsync('a STAFF member cannot open a plan — it is a loan', async () => {
    const res = await staff.post('/api/instalments', {
      branch_id: branch.id, customer_id: customer.id, principal: 10000,
      tenure_months: 3, frequency: 'MONTHLY', interest_percent: 5,
    });
    assert.equal(res.status, 403,
      `a STAFF member opened an instalment plan: ${res.status} ${String(res.text).slice(0, 200)}. A loan the business carries has to be the business's decision`);
    assert.equal(res.json.code, 'ROLE_REQUIRED', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('the schedule adds up to what was agreed', async () => {
    assert.ok(Array.isArray(plan.schedule) && plan.schedule.length > 0,
      'the plan was opened and came back with no schedule — an instalment plan with no instalments is a loan with no due dates');
    const totalDue = round2(plan.schedule.reduce((a, r) => a + Number(r.amountDue != null ? r.amountDue : r.amount_due), 0));
    const read = await owner.get(`/api/instalments/${encodeURIComponent(plan.id)}`);
    assert.equal(read.status, 200, `reading the plan back answered ${read.status} ${String(read.text).slice(0, 200)}`);
    const detail = read.json.plan || read.json;
    const payable = round2(Number(detail.total_payable));
    assert.equal(round2(Number(detail.principal)), PRINCIPAL, `the plan's principal is ${money(detail.principal)} against ${money(PRINCIPAL)} agreed`);
    assert.ok(totalDue <= payable,
      `the schedule's instalments total ${money(totalDue)} which is MORE than the ${money(payable)} total payable. A customer asked for more than the contract says is a customer who stops paying`);
    assert.equal(round2(Number(detail.interest_amount)), round2(payable - PRINCIPAL),
      `the interest recorded (${money(detail.interest_amount)}) is not the difference between the total payable (${money(payable)}) and the principal (${money(PRINCIPAL)}) — interest that does not reconcile is interest nobody can explain`);
    assert.equal(String(detail.status), 'ACTIVE', `a fresh plan is ${detail.status}`);
    assert.equal(read.json.schedule.length, plan.schedule.length, `the detail lists ${read.json.schedule.length} instalment(s) against ${plan.schedule.length} on the plan`);
    // THE DETAIL ANSWERS UNDER `progress` (`server/routes/afterSales.js:1452`), NOT `summary`
    // — the list has a summary, the detail has progress. Read them by name and say so when
    // they are missing, rather than reading `undefined` and reporting a product defect (the
    // P2 lesson, which has now caught four of my own readers).
    assert.ok(read.json.progress,
      `the plan detail came back with no progress block (keys: ${Object.keys(read.json || {}).join(', ')})`);
    assert.equal(Number(read.json.progress.instalmentsTotal), plan.schedule.length,
      `the progress block counts ${read.json.progress.instalmentsTotal} instalment(s) against ${plan.schedule.length} on the schedule`);
    assert.equal(Number(read.json.progress.instalmentsPaid), 0, `a fresh plan already shows ${read.json.progress.instalmentsPaid} instalment(s) paid`);
  });

  await audit.checkAsync('the plan is on the book, with its balance, and reading it does not move it', async () => {
    const res = await owner.get('/api/instalments?limit=200');
    assert.equal(res.status, 200, `the plans list answered ${res.status} ${String(res.text).slice(0, 200)}`);
    const rows = res.json.data || res.json.plans || [];
    assert.ok(Array.isArray(rows), `the plans list did not answer with rows under \`data\` (keys: ${Object.keys(res.json || {}).join(', ')})`);
    const row = rows.filter((r) => String(r.id) === String(plan.id))[0];
    assert.ok(row, `plan ${plan.planNo} is not in the plans list`);
    assert.equal(round2(Number(row.outstanding)), round2(round2(Number(row.total_payable)) - round2(Number(row.deposit_amount))),
      `the plan shows ${money(row.outstanding)} outstanding against a total payable of ${money(row.total_payable)} — the deposit taken at opening was not knocked off the balance`);
    assert.equal(Boolean(row.overdue), false, 'a plan whose first instalment is due today is already marked overdue');
    const again = await owner.get(`/api/instalments/${encodeURIComponent(plan.id)}`);
    assert.equal(round2(Number((again.json.plan || again.json).outstanding)), round2(Number(row.outstanding)),
      'reading the plan twice gave two different balances — a read is not allowed to move money');
  });

  await audit.checkAsync('a payment that cannot be allocated is refused, and changes nothing', async () => {
    const before = await owner.get(`/api/instalments/${encodeURIComponent(plan.id)}`);
    const owed = round2(Number((before.json.plan || before.json).outstanding));
    const res = await manager.post(`/api/instalments/${encodeURIComponent(plan.id)}/payments`,
      { amount: round2(owed + 50000), method: 'CASH' });
    assert.ok(res.status >= 400 && res.status < 500,
      `a payment of ${money(round2(owed + 50000))} against ${money(owed)} outstanding was accepted: ${res.status} ${String(res.text).slice(0, 240)}. Absorbing an overpayment silently leaves the customer with credit nobody knows about`);
    const after = await owner.get(`/api/instalments/${encodeURIComponent(plan.id)}`);
    assert.equal(round2(Number((after.json.plan || after.json).outstanding)), owed,
      'a refused payment still moved the balance');
  });

  const paid = await audit.captureAsync('the first instalment is paid', async () => {
    const detail = await owner.get(`/api/instalments/${encodeURIComponent(plan.id)}`);
    const schedule = detail.json.schedule || [];
    const first = schedule.filter((r) => String(r.status) !== 'PAID').sort((a, b) => Number(a.seq) - Number(b.seq))[0];
    assert.ok(first, 'every instalment on the plan is already paid');
    const due = round2(Number(first.amount_due));
    const before = round2(Number((detail.json.plan || detail.json).outstanding));
    const res = await manager.post(`/api/instalments/${encodeURIComponent(plan.id)}/payments`,
      { amount: due, method: 'CASH' }, { idempotencyKey: `fulfilment-pay-${Date.now().toString(36)}` });
    assert.ok(res.status < 400, `paying the first instalment answered ${res.status}: ${String(res.text).slice(0, 260)}`);

    // FRONT TO BACK: the schedule row is PAID, the balance came down by what was paid, and
    // the next due date moved on.
    const after = await owner.get(`/api/instalments/${encodeURIComponent(plan.id)}`);
    const row = (after.json.schedule || []).filter((r) => String(r.id) === String(first.id))[0];
    assert.ok(row, 'the paid instalment is not in the schedule any more');
    assert.equal(String(row.status), 'PAID', `the first instalment is ${row.status} after being paid in full — a plan whose schedule does not show the payment is a customer who will be chased for money they have paid`);
    assert.equal(round2(Number(row.amount_paid)), due, `the schedule row records ${money(row.amount_paid)} paid against ${money(due)}`);
    assert.equal(round2(Number((after.json.plan || after.json).outstanding)), round2(before - due),
      `the balance went ${money(before)} → ${money((after.json.plan || after.json).outstanding)} for a payment of ${money(due)}`);
    assert.equal(Number(after.json.progress.instalmentsPaid), 1, `the progress block says ${after.json.progress.instalmentsPaid} instalment(s) paid after one payment`);
    return { due, before };
  });
  audit.note(`${money(paid.due)} paid — the schedule moved, not just the balance`);

  await audit.checkAsync('an overdue plan is visible as overdue, with the money on it', async () => {
    // A SECOND PLAN, BACKDATED. The list's own summary is what a manager works from, and an
    // overdue plan that is not in it is a debt nobody chases.
    // THE DEPOSIT MINIMUM IS THE BUSINESS'S RULE (`instalment_min_deposit_pct`), and it is
    // enforced here rather than worked around: the first version of this check sent a zero
    // deposit, was refused with INVALID_PLAN, and I read the refusal as a problem with the
    // backdated start date. A deposit is a requirement of the flow, not an obstacle to it.
    const res = await manager.post('/api/instalments', {
      branch_id: branch.id, customer_id: customer.id,
      principal: 20000, deposit_amount: 4000, tenure_months: 3,
      frequency: 'MONTHLY', interest_percent: 0,
      schedule_start: day(-70),
    });
    assert.ok(res.status < 400, `opening a backdated plan answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const lateId = res.json.id || res.json.planId || (res.json.plan && res.json.plan.id);
    const detail = await owner.get(`/api/instalments/${encodeURIComponent(lateId)}`);
    const late = detail.json.plan || detail.json;
    assert.equal(String(late.status), 'ACTIVE', `a plan 70 days past its first instalment reads ${late.status}`);
    assert.ok(String(late.next_due_date) <= day(0),
      `a plan whose first instalment was due ${day(-70)} shows its next due date as ${late.next_due_date}`);

    const list = await owner.get('/api/instalments?limit=200');
    const row = (list.json.data || []).filter((r) => String(r.id) === String(lateId))[0];
    assert.ok(row, 'the backdated plan is not in the plans list');
    assert.equal(Boolean(row.overdue), true,
      `the plan is ${row.days_overdue} day(s) past due and the list says overdue=${row.overdue}. An overdue plan the board does not flag is a debt nobody chases`);
    assert.ok(Number(row.days_overdue) > 60, `the plan is 70 days late and the list says ${row.days_overdue} day(s) overdue`);
    assert.ok(Number(list.json.summary.overdue) >= 1 && Number(list.json.summary.overdueValue) >= row.outstanding,
      `the summary says ${list.json.summary.overdue} overdue plan(s) worth ${money(list.json.summary.overdueValue)} while the list itself contains one worth ${money(row.outstanding)}`);

    // AND THE FILTER AGREES WITH THE FLAG — two readings of the same fact.
    const only = await owner.get('/api/instalments?overdue_only=1&limit=200');
    const flagged = (only.json.data || []).every((r) => Boolean(r.overdue));
    assert.ok(flagged, 'overdue_only returned a plan the list does not call overdue');
    assert.ok((only.json.data || []).some((r) => String(r.id) === String(lateId)),
      'overdue_only left out the plan that is 70 days late');
    // The plan that was paid on time must NOT be in the overdue list.
    assert.ok(!(only.json.data || []).some((r) => String(r.id) === String(plan.id)),
      'a plan whose instalments are all on time was returned by overdue_only');
  });

  // ===================================================================
  audit.section('A delivery to be made — the board is the work');
  // ===================================================================
  const DELIVERY_FEE = 3500;
  const delivery = await audit.captureAsync('a sale that has to be delivered', async () => {
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: round2(unitPrice + DELIVERY_FEE) }],
      customer_id: customer.id,
      delivery_required: true,
      delivery_fee: DELIVERY_FEE,
      delivery_address: '12 Fulfilment Close, Wuse 2, Abuja',
      device_id: 'audit-fulfilment',
    }, { idempotencyKey: `fulfilment-sale-${Date.now().toString(36)}` });
    assert.ok(res.status === 201 || res.status === 200, `the delivery sale answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    const saleId = res.json.saleId || res.json.id || (res.json.sale && res.json.sale.id);
    assert.ok(saleId, 'the sale was rung and the answer carries no id');

    // FRONT TO BACK: the sale created a JOB. A delivery fee taken with no job behind it is a
    // customer who has paid to have nothing happen.
    const back = await owner.get(`/api/sales/${encodeURIComponent(saleId)}`);
    const jobs = back.json.delivery || back.json.deliveries || [];
    assert.ok(Array.isArray(jobs) && jobs.length > 0,
      `the sale was rung with delivery_required and has no delivery job (keys: ${Object.keys(back.json || {}).join(', ')})`);
    const job = jobs[0];
    assert.equal(round2(Number(job.fee != null ? job.fee : job.delivery_fee)), DELIVERY_FEE,
      `the job carries a fee of ${money(job.fee != null ? job.fee : job.delivery_fee)} against the ${money(DELIVERY_FEE)} charged on the receipt`);
    assert.equal(String(job.status), 'PENDING', `a new delivery job is ${job.status}`);
    return { saleId, jobId: job.id, jobNo: job.job_no || job.jobNo };
  });
  audit.note(`delivery ${delivery.jobNo || String(delivery.jobId).slice(0, 8)} raised on the sale`);

  await audit.checkAsync('the job is on the board with its items and the address to go to', async () => {
    const list = await owner.get('/api/deliveries?limit=100');
    assert.equal(list.status, 200, `the delivery board answered ${list.status} ${String(list.text).slice(0, 200)}`);
    const rows = list.json.data || list.json.deliveries || [];
    assert.ok(Array.isArray(rows), `the delivery board did not answer with rows under \`data\` (keys: ${Object.keys(list.json || {}).join(', ')})`);
    const row = rows.filter((r) => String(r.id) === String(delivery.jobId))[0];
    assert.ok(row, `delivery ${delivery.jobNo} is not on the board. A delivery nobody can see is a delivery nobody makes`);
    assert.ok(Number(row.item_count) >= 1, `the job is on the board with ${row.item_count} item(s)`);

    const res = await owner.get(`/api/deliveries/${encodeURIComponent(delivery.jobId)}`);
    assert.equal(res.status, 200, `reading the job back answered ${res.status} ${String(res.text).slice(0, 200)}`);
    const items = res.json.items || [];
    assert.equal(items.length, 1, `the job read back with ${items.length} item(s) against a one-line sale`);
    assert.equal(String(items[0].product_id), String(product.id), 'the job is carrying a different product than the one sold');
    // THE JOB IS UNDER `job` (`server/routes/sales.js:881` answers `{ ok, job, items,
    // installations }`), and its name comes from the joined customer. Reading the name off
    // the top level gave "undefined" — a reader mistake, not a job with no customer.
    const job = res.json.job || res.json;
    assert.equal(String(job.customer_name || ''), customer.name,
      `the job is addressed to "${job.customer_name}" (keys: ${Object.keys(res.json || {}).join(', ')})`);
    assert.ok(String(job.delivery_address || '').includes('Fulfilment Close'),
      `the job's address is "${job.delivery_address}" — a driver cannot deliver to a job with no address`);
  });

  await audit.checkAsync('a failed drop has to say what went wrong', async () => {
    // TWO GUARDS, TWO ANSWERS: no note at all is a missing field, a note too short to say
    // anything is NOTE_REQUIRED. (The first version of this check expected NOTE_REQUIRED for
    // an absent note; the product answers MISSING_FIELD, and both refusals are correct.)
    const res = await staff.post(`/api/deliveries/${encodeURIComponent(delivery.jobId)}/status`, { status: 'FAILED' });
    assert.equal(res.status, 400,
      `a FAILED delivery was recorded with no note: ${res.status} ${String(res.text).slice(0, 200)}. A failed drop with no reason cannot be chased or charged back to the transporter`);
    assert.equal(res.json.code, 'MISSING_FIELD', `a FAILED drop with no note came back as ${res.json.code}`);
    const short = await staff.post(`/api/deliveries/${encodeURIComponent(delivery.jobId)}/status`, { status: 'FAILED', note: 'no' });
    assert.equal(short.status, 400, `a two-letter note was accepted for a failed delivery: ${short.status}`);
    assert.equal(short.json.code, 'NOTE_REQUIRED', `a note too short to say anything came back as ${short.json.code}`);
    const still = await owner.get(`/api/deliveries/${encodeURIComponent(delivery.jobId)}`);
    assert.equal(String((still.json.job || still.json).status), 'PENDING', 'a refused status change still moved the job');
  });

  await audit.checkAsync('a STAFF member cannot walk a delivered job backwards', async () => {
    // Forward first, as a driver would. A driver is exactly who does this, so a STAFF seat
    // must be allowed to move a delivery forward.
    const onTheRoad = await staff.post(`/api/deliveries/${encodeURIComponent(delivery.jobId)}/status`, { status: 'IN_TRANSIT' });
    assert.ok(onTheRoad.status < 400, `moving the job to IN_TRANSIT answered ${onTheRoad.status}: ${String(onTheRoad.text).slice(0, 200)}`);

    // AND THE SALE SAYS SO: goods on the road are PENDING_DELIVERY, not completed. The sale
    // is what the books and the reports read, so it has to move with the van.
    const midSale = await owner.get(`/api/sales/${encodeURIComponent(delivery.saleId)}`);
    const midRow = midSale.json.sale || midSale.json;
    assert.equal(String(midRow.status), 'PENDING_DELIVERY',
      `the goods are in transit and the sale reads "${midRow.status}" — a sale the shop counts as finished while the customer is still waiting for it`);

    const delivered = await staff.post(`/api/deliveries/${encodeURIComponent(delivery.jobId)}/status`,
      { status: 'DELIVERED', proof_of_delivery: 'Signed by the customer at the gate.', delivered_to: 'Fulfilment Audit Customer' });
    assert.ok(delivered.status < 400, `marking the job DELIVERED answered ${delivered.status}: ${String(delivered.text).slice(0, 240)}`);

    const backwards = await staff.post(`/api/deliveries/${encodeURIComponent(delivery.jobId)}/status`, { status: 'PENDING' });
    assert.equal(backwards.status, 403,
      `a STAFF member moved a delivered job back to PENDING: ${backwards.status} ${String(backwards.text).slice(0, 200)}. Reversing a delivery status hides a failed drop`);
    assert.equal(backwards.json.code, 'STATUS_REVERSAL', `the refusal came back as ${backwards.json.code}`);

    // BACK TO FRONT: read the job and the sale, and see the drop recorded.
    const res = await owner.get(`/api/deliveries/${encodeURIComponent(delivery.jobId)}`);
    const job = res.json.job || res.json;
    assert.equal(String(job.status), 'DELIVERED', `the job reads ${job.status} after a successful drop`);
    assert.ok(job.delivered_at, 'a delivered job carries no delivered_at — the drop cannot be dated');
    const sale = await owner.get(`/api/sales/${encodeURIComponent(delivery.saleId)}`);
    const saleRow = sale.json.sale || sale.json;
    // DELIVERED IN THE VAN IS COMPLETED IN THE BOOKS: the route maps it deliberately
    // ("const saleStatus = status === 'DELIVERED' ? 'COMPLETED' : 'PENDING_DELIVERY'").
    assert.equal(String(saleRow.status), 'COMPLETED',
      `the goods were delivered and the sale still reads "${saleRow.status}" — the receipt and the delivery disagree`);
  });

  await audit.checkAsync('an installation is booked for the unit, and only one at a time', async () => {
    const res = await manager.post(`/api/deliveries/${encodeURIComponent(delivery.jobId)}/installation`, {
      product_id: product.id, fee: 5000, fee_collected: 5000, scheduled_at: day(1),
    });
    assert.ok(res.status < 400, `booking the installation answered ${res.status}: ${String(res.text).slice(0, 260)}`);
    const installationId = res.json.id || res.json.installationId || (res.json.installation && res.json.installation.id);
    assert.ok(installationId, 'the installation was booked and the answer carries no id');

    const again = await manager.post(`/api/deliveries/${encodeURIComponent(delivery.jobId)}/installation`,
      { product_id: product.id, fee: 5000 });
    assert.equal(again.status, 409,
      `a second installation job was booked for the same unit: ${again.status} ${String(again.text).slice(0, 200)}. Two open jobs for one unit is how a technician gets dispatched twice`);
    assert.equal(again.json.code, 'INSTALLATION_ALREADY_BOOKED', `the refusal came back as ${again.json.code}`);

    const detail = await owner.get(`/api/deliveries/${encodeURIComponent(delivery.jobId)}`);
    const jobs = detail.json.installations || [];
    assert.equal(jobs.length, 1, `the job shows ${jobs.length} installation job(s)`);
    return { installationId };
  });

  await audit.checkAsync('completing the installation starts the warranty, and says so', async () => {
    const booked = await owner.get(`/api/deliveries/${encodeURIComponent(delivery.jobId)}`);
    const installationId = (booked.json.installations || [])[0].id;

    const done = await manager.post(`/api/installations/${encodeURIComponent(installationId)}/complete`, {
      completed_at: day(-10), warranty_months: 12, starts_warranty: true,
      parts_cost: 0, note: 'Commissioned on site; the customer signed the job sheet.',
    });
    assert.ok(done.status < 400, `completing the installation answered ${done.status}: ${String(done.text).slice(0, 260)}`);

    const again = await manager.post(`/api/installations/${encodeURIComponent(installationId)}/complete`, {});
    assert.equal(again.status, 409,
      `an installation was completed twice: ${again.status}. Completing it again would restart the warranty a second time and move the date it ends`);
    assert.equal(again.json.code, 'ALREADY_COMPLETED', `the refusal came back as ${again.json.code}`);

    const res = await owner.get(`/api/deliveries/${encodeURIComponent(delivery.jobId)}`);
    const job = (res.json.installations || [])[0];
    assert.equal(String(job.status), 'COMPLETED', `the installation reads ${job.status}`);
    assert.equal(String(job.warranty_starts_at), day(-10),
      `the warranty starts ${job.warranty_starts_at} against a commissioning date of ${day(-10)}. Warranty that starts at the sale instead of at commissioning takes the cover off the customer before they have the goods working`);
    assert.ok(String(job.warranty_ends_at) > String(job.warranty_starts_at),
      `the warranty ends ${job.warranty_ends_at}, which is not after it starts (${job.warranty_starts_at})`);
    assert.ok(String(job.notes || '').includes('Commissioned'),
      'the technician\'s note was not kept on the installation job');
  });

  await audit.checkAsync('a cancellation puts the goods back on the shelf', async () => {
    // A SECOND DELIVERY, CANCELLED AFTER THE SALE — the customer changes their mind before
    // the van leaves. The stock came off the shelf at the sale and has to come back, or the
    // shop shows a unit that walked out of the door.
    const listed = await owner.get(`/api/stock?branch_id=${encodeURIComponent(branch.id)}&limit=200`);
    const before = ((listed.json.data || []).filter((r) => String(r.product_id) === String(product.id))[0] || {}).on_shelf || 0;

    const sale = await owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: round2(unitPrice + DELIVERY_FEE) }],
      customer_id: customer.id,
      delivery_required: true, delivery_fee: DELIVERY_FEE,
      delivery_address: '12 Fulfilment Close, Wuse 2, Abuja',
      device_id: 'audit-fulfilment',
    });
    assert.ok(sale.status < 400, `the second delivery sale answered ${sale.status}: ${String(sale.text).slice(0, 240)}`);
    const saleId = sale.json.saleId || sale.json.id;
    const back = await owner.get(`/api/sales/${encodeURIComponent(saleId)}`);
    const jobId = ((back.json.delivery || back.json.deliveries || [])[0] || {}).id;
    assert.ok(jobId, 'the second sale has no delivery job');

    const mid = await owner.get(`/api/stock?branch_id=${encodeURIComponent(branch.id)}&limit=200`);
    const atSale = ((mid.json.data || []).filter((r) => String(r.product_id) === String(product.id))[0] || {}).on_shelf || 0;
    assert.equal(round2(atSale), round2(before - 1), `the shelf went ${before} → ${atSale} on a one-unit sale`);

    const cancelled = await manager.post(`/api/deliveries/${encodeURIComponent(jobId)}/status`,
      { status: 'CANCELLED', note: 'The customer cancelled before the van left the yard.' });
    assert.ok(cancelled.status < 400, `cancelling the delivery answered ${cancelled.status}: ${String(cancelled.text).slice(0, 260)}`);

    const after = await owner.get(`/api/stock?branch_id=${encodeURIComponent(branch.id)}&limit=200`);
    const now = ((after.json.data || []).filter((r) => String(r.product_id) === String(product.id))[0] || {}).on_shelf || 0;
    assert.equal(round2(now), round2(before),
      `the delivery was cancelled and the shelf reads ${now} against ${before} before the sale. Goods on a cancelled delivery that never come back are goods the shop has given away`);
  });

  // AND THE FIXTURE LEAVES THE BOOK AS IT FOUND IT: the customer's balance is settled so the
  // debtor can be retired (a customer who owes money cannot be deleted — see P3's live leg).
  await audit.checkAsync('the fixture settles what it owes so it can be taken off the book', async () => {
    const who = await owner.get(`/api/customers/${encodeURIComponent(customer.id)}`);
    const person = who.json.customer || who.json;
    const owed = round2(Number(person.credit_balance));
    if (owed > 0) {
      const settled = await manager.post(`/api/customers/${encodeURIComponent(customer.id)}/payments`,
        { amount: owed, method: 'CASH' }, { idempotencyKey: `fulfilment-settle-${Date.now().toString(36)}` });
      assert.ok(settled.status < 400, `settling the fixture's balance answered ${settled.status}: ${String(settled.text).slice(0, 200)}`);
    } else {
      audit.note('the fixture owes nothing — nothing to settle');
    }
    const removed = await manager.del(`/api/customers/${encodeURIComponent(customer.id)}`);
    assert.ok(removed.status < 300,
      `the settled fixture customer could not be removed: ${removed.status} ${String(removed.text).slice(0, 200)}`);
    if (Array.isArray(d.created.customers)) d.created.customers = d.created.customers.filter((c) => String(c.id) !== String(customer.id));
  });
}, {
  setup: () => startDeployment({
    label: 'fulfilment',
    businesses: [{
      name: 'Fulfilment Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Fulfilment Counter', code: 'FUL-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 80000 },
      ],
    }],
    seats: [
      { as: 'staff', role: 'STAFF', username: 'ful-staff', pin: '60521', branchIndex: 0, full_name: 'Fulfilment Audit Driver' },
      { as: 'manager', role: 'MANAGER', username: 'ful-manager', pin: '60522', branchIndex: 0, full_name: 'Fulfilment Audit Manager' },
    ],
  }),
});
