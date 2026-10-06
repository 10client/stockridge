'use strict';
// =====================================================================
// test/audit/audit.sync.js — THE OFFLINE-FIRST PROMISE, KEPT
// =====================================================================
// StockRidge is sold as an offline-first PWA because that is what a Nigerian shop
// actually needs: NEPA takes the light, the MTN data drops, and the counter has to keep
// selling. Which means the product makes a promise that no online demo can show — that a
// DAY OF QUEUED WORK CAN BE REPLAYED WITHOUT DOUBLING, WITHOUT OVERWRITING SOMEBODY
// ELSE'S EDIT, AND WITHOUT LEAKING ONE BRANCH'S ROWS INTO ANOTHER'S.
//
// Every one of those three is invisible from the UI and invisible to the unit tests. So
// this audit does what a phone does: it queues operations, pushes them, pushes them
// AGAIN, edits a row that somebody else has since changed, and then reads back what
// actually happened.
//
// WHAT IT ASSERTS THAT MATTERS MOST
//
//   * a sale queued offline lands EXACTLY ONCE, even when the push is retried — the
//     failure this prevents is a shop that sells one generator and banks two;
//   * the losing side of a concurrent edit is CAPTURED, not dropped — losing a cashier's
//     edit silently is how a shop stops trusting the app and goes back to paper;
//   * a device cannot write the column that decides who can see a row, cannot write a
//     row of another branch, and cannot write a table that has its own rules;
//   * the same Idempotency-Key twice is the same answer, and the same key with a
//     DIFFERENT body is refused rather than silently discarding the second action.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * THE SHAPE OF A PUSH RESPONSE, learned by reading one.
 *
 * `{ ok, applied, rejected, conflicts, clockSkewMinutes, results: { operations, mutations },
 *    cursor, message }` — and **207** when something was refused. 207 (Multi-Status) is the
 * right answer and it is not 200: a device has to be able to tell "my whole queue landed"
 * from "three items need a person", and the per-item list is the only thing that says which.
 * The first draft of this file asserted 200 everywhere and reported a working product as
 * broken — the mirror image of the usual mistake.
 */
const items = (res, kind) => ((res && res.json && res.json.results && res.json.results[kind]) || []);
const partial = (res) => res && (res.status === 200 || res.status === 207);
const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

runAudit('sync', async (audit, d) => {
  const o = d.owner || d.admin;
  const branch = d.branchFor(o);
  const device = `audit-sync-${Date.now().toString(36).slice(-5)}`;
  // Declared at the top, because a `let` further down is in the temporal dead zone for
  // every line above it — and "Cannot access 'conflictId' before initialization" is a
  // message that reads like a broken product rather than a mis-ordered audit.
  let saleRecorded = null;
  let conflictId = null;

  // ===================================================================
  audit.section('A push has to say which device it came from');
  // THE DEVICE IS CLEARED EXPLICITLY, AND THE TWO-WAY IS ASSERTED BY NAME.
  //
  // The harness sends `X-Device-Id: audit-device` on every request by default (see
  // test/audit/lib/deployment.js), so a probe that simply omits `device_id` is measured
  // against the header and the product correctly accepts it. The first draft reported
  // "200, expected 400" about a request that named a device all along.
  //
  // `twoWay` is for "it works, and here is the effect"; a refusal is asserted with
  // `refusal`, which is the helper that also checks the CODE and the MESSAGE. Both halves
  // are here, because a push refused for the wrong reason is not a rule.
  await audit.refusal('a push that names no device is refused, and the refusal says why',
    () => o.post('/api/sync/push', { mutations: [{ table: 'customers', id: 'x', data: { notes: 'x' } }] }, { device: '' }),
    { expectStatus: 400, code: /DEVICE_ID_REQUIRED/, message: /device/i });
  await audit.checkAsync('and the same push WITH a device is accepted — the rule is the device, not the push', async () => {
    const res = await o.post('/api/sync/push', {
      mutations: [{ table: 'customers', id: 'no-such-row-device-probe', data: { notes: 'probe' } }],
    }, { device: `${device}-probe` });
    assert.ok(res.status === 200 || res.status === 207,
      `with a device named it answered ${res.status} ${String(res.text).slice(0, 160)} — a device whose id is fine but whose queue carries one dead row must still get an answer`);
  });
  await audit.refusal('an empty push is refused rather than counted as success',
    () => o.post('/api/sync/push', { device_id: device }),
    { expectStatus: 400, code: /EMPTY_SYNC/, message: /sync|nothing/i });
  await audit.refusal(`${500 + 1} items in one push is refused — an unbounded queue holds a transaction open at the counter`,
    () => o.post('/api/sync/push', {
      device_id: device,
      mutations: Array.from({ length: 501 }, (_, i) => ({ table: 'customers', id: `bulk-${i}`, data: { notes: 'x' } })),
    }),
    { expectStatus: 400, code: /SYNC_BATCH_TOO_LARGE/, message: /500|batches|limit/i });

  // ===================================================================
  audit.section('A device is visible to the shop before it matters');
  // ===================================================================
  const heartbeat = await audit.checkAsync('a device can say it is alive', async () => {
    // A HEARTBEAT NEEDS A BRANCH, and the product is right to insist: it records
    // `branch_sync_status` per branch, and an owner who covers four shops has not said
    // which one the device is sitting in. "The system will not guess" is its message.
    const res = await o.post('/api/sync/heartbeat', {
      branch_id: branch.id, device_id: device, app_version: 'audit-1.0', pending_push_count: 3,
    });
    assert.ok(res.status === 200 || res.status === 201, `the heartbeat answered ${res.status} ${res.text.slice(0, 200)}`);
    return res.json;
  });
  await audit.checkAsync('and the shop can see which devices are syncing', async () => {
    const res = await o.get('/api/sync/status');
    assert.equal(res.status, 200, `GET /api/sync/status answered ${res.status}`);
    const rows = res.json.devices || [];
    assert.ok(rows.some((r) => String(r.device_id) === device),
      `the device that just sent a heartbeat is not in the status list (${rows.length} device(s) known) — "which tills are actually syncing" is the first question when a shop reports a missing sale`);
    const row = rows.find((r) => String(r.device_id) === device);
    assert.equal(Number(row.pending_push_count), 3,
      `the status says the device has ${row.pending_push_count} pending pushes and the heartbeat sent 3 — a device with a stuck queue is the thing this figure exists to reveal`);
  });

  await audit.checkAsync('TWO devices in one branch are both visible, which is the ordinary case', async () => {
    // THE CHECK THAT FOUND MIGRATION 0006. `branch_sync_status` was keyed on `branch_id`
    // ALONE and no upsert ever wrote `device_id`, so a branch could only ever show the FIRST
    // device that synced there: the counter phone and the manager's phone are two devices,
    // and "which one is stuck, and how much has it got queued?" was unanswerable for the
    // second one — with its pending count attributed to the other phone.
    const second = `${device}-second`;
    const hb = await o.post('/api/sync/heartbeat', {
      branch_id: branch.id, device_id: second, app_version: 'audit-1.0', pending_push_count: 7,
    });
    assert.ok(hb.status === 200 || hb.status === 201, `the second device's heartbeat answered ${hb.status}`);
    const res = await o.get('/api/sync/status');
    const rows = res.json.devices || [];
    const ids = rows.map((r) => String(r.device_id));
    assert.ok(ids.includes(device), `the first device is missing from the status list (${ids.length} device(s): ${ids.join(', ')})`);
    assert.ok(ids.includes(second),
      `a second device in the same branch sent a heartbeat and the status list does not know it (${ids.length} device(s): ${ids.join(', ')}). A shop with a counter phone and a manager's phone is the ordinary case, and "which phone is stuck" is the question this list exists to answer`);
    const mine = rows.filter((r) => String(r.device_id) === second);
    assert.equal(mine.length, 1, `the second device appears ${mine.length} times — a heartbeat must update its own row, not add one per call`);
    assert.equal(Number(mine[0].pending_push_count), 7,
      `the second device's queue reads ${mine[0].pending_push_count} and it reported 7 — one device's backlog attributed to another is how a stuck phone stays invisible`);
  });

  // ===================================================================
  audit.section('A day of queued work replays through the real endpoints');
  // ===================================================================
  const product = await audit.captureAsync('a priced product to sell from a queued operation', async () => {
    const res = await o.get('/api/products?limit=5');
    const rows = (res.json && res.json.data) || [];
    const priced = rows.find((r) => Number(r.selling_price) > 0);
    if (!priced) throw new Error(`no priced product in the catalogue (${rows.length} rows)`);
    return priced;
  });
  const unitPrice = Number(product.selling_price);

  const stocked = await audit.checkAsync('stock is received, so the queued sale has something to sell', async () => {
    if (d.live && !d.writable) { audit.skip('read-only target: no stock could be received'); return false; }
    const res = await o.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 5,
      unit_code: product.default_unit_code || 'PIECE',
      cost_price: round2(unitPrice * 0.7), selling_price: unitPrice,
      reference: `SYN-GRN-${Date.now().toString(36)}`,
    });
    assert.equal(res.status, 201, `receiving stock answered ${res.status}: ${res.text.slice(0, 240)}`);
    return true;
  });

  if (!stocked) {
    audit.skip('the queued-sale replay is asserted', 'no stock could be put on the shelf on this target');
    return;
  }

  const saleClientId = `sync-sale-${Date.now().toString(36)}`;
  const queuedPayload = {
    branch_id: branch.id,
    lines: [{ product_id: product.id, quantity: 1 }],
    payments: [{ method: 'CASH', amount: unitPrice, cash_tendered: unitPrice }],
    device_id: device,
  };

  const salesBefore = await audit.captureAsync('how many sales the branch has rung so far', async () => {
    const res = await o.get(`/api/sales?limit=200&branch_id=${branch.id}`);
    return { rows: (res.json && res.json.data) || [] };
  });

  const firstPush = await audit.captureAsync('a queued sale, pushed for the first time', async () => {
    const res = await o.post('/api/sync/push', {
      device_id: device,
      operations: [{ type: 'SALE', client_id: saleClientId, payload: queuedPayload }],
    });
    if (!partial(res)) throw new Error(`the push answered ${res.status} ${res.text.slice(0, 300)}`);
    return Object.assign({ _raw: res }, res.json);
  });

  await audit.check('the queued sale is applied, not just acknowledged', () => {
    assert.ok(firstPush, 'the push did not answer');
    const item = items(firstPush._raw, 'operations')[0];
    assert.ok(item, `the push answered with no per-operation result: ${JSON.stringify(firstPush).slice(0, 300)}`);
    assert.equal(String(item.status), 'APPLIED',
      `the queued sale came back ${item.status} ${item.code || ''} — ${item.message || 'no reason given'}. A device that queues a day of work and is told nothing useful will keep the queue forever`);
    assert.ok(firstPush.applied >= 1, `the push reports ${firstPush.applied} applied`);
  });

  await audit.checkAsync('and it is a real sale in the shop, not a row in a sync log', async () => {
    const res = await o.get(`/api/sales?limit=200&branch_id=${branch.id}`);
    const rows = (res.json && res.json.data) || [];
    const before = new Set((salesBefore && salesBefore.rows || []).map((r) => String(r.id)));
    const fresh = rows.filter((r) => !before.has(String(r.id)));
    assert.equal(fresh.length, 1, `the branch gained ${fresh.length} sale(s) from a single queued operation`);
    assert.equal(round2(fresh[0].totals ? fresh[0].totals.total : fresh[0].total), round2(unitPrice),
      `the replayed sale totals ${money(fresh[0].totals ? fresh[0].totals.total : fresh[0].total)} against ${money(unitPrice)} queued`);
    saleRecorded = fresh[0];
  });

  // ---- THE RETRY. This is the whole point of the section.
  const secondPush = await audit.captureAsync('the SAME queued sale, pushed again after a timeout', async () => {
    const res = await o.post('/api/sync/push', {
      device_id: device,
      operations: [{ type: 'SALE', client_id: saleClientId, payload: queuedPayload }],
    });
    if (!partial(res)) throw new Error(`the retry answered ${res.status} ${res.text.slice(0, 300)}`);
    return Object.assign({ _raw: res }, res.json);
  });

  await audit.checkAsync('a retried push does not ring the sale a second time', async () => {
    assert.ok(secondPush, 'the retry did not answer');
    const res = await o.get(`/api/sales?limit=200&branch_id=${branch.id}`);
    const rows = (res.json && res.json.data) || [];
    const before = new Set((salesBefore && salesBefore.rows || []).map((r) => String(r.id)));
    const fresh = rows.filter((r) => !before.has(String(r.id)));
    assert.equal(fresh.length, 1,
      `the branch now has ${fresh.length} sale(s) from one queued operation sent twice. This is the failure the whole offline promise rests on: a shop that sells one appliance and banks two of them, discovered at stocktake a month later`);
    const item = items(secondPush._raw, 'operations')[0] || {};
    audit.note(`the retry answered ${item.status}${item.code ? ` (${item.code})` : ''}: ${String(item.message || '').slice(0, 120)}`);
  });

  // ===================================================================
  audit.section('The same Idempotency-Key twice is the same answer');
  // ===================================================================
  const key = `idem-${Date.now().toString(36)}`;
  const expenseBody = {
    branch_id: branch.id, category: 'DIESEL_FUEL', amount: 1200,
    description: 'Audit: a retried expense must not be paid twice', payment_method: 'CASH',
  };
  const firstExpense = await audit.captureAsync('an expense sent with an Idempotency-Key', async () => {
    const res = await o.post('/api/expenses', expenseBody, { idempotencyKey: key });
    if (res.status !== 200 && res.status !== 201) throw new Error(`the expense answered ${res.status} ${res.text.slice(0, 240)}`);
    return { status: res.status, body: res.json };
  });
  await audit.checkAsync('the same key with the same body replays the same answer', async () => {
    assert.ok(firstExpense, 'the first expense did not succeed');
    const res = await o.post('/api/expenses', expenseBody, { idempotencyKey: key });
    assert.equal(res.status, firstExpense.status,
      `the retry answered ${res.status} where the original answered ${firstExpense.status}; a replayed request must not look like a different outcome to a client`);
    const id1 = firstExpense.body && (firstExpense.body.id || firstExpense.body.expenseId);
    const id2 = res.json && (res.json.id || res.json.expenseId);
    assert.equal(String(id2), String(id1), `the retry produced a different record (${id2} vs ${id1})`);
  });
  await audit.checkAsync('the same key with a DIFFERENT body is refused, not silently discarded', async () => {
    const res = await o.post('/api/expenses', Object.assign({}, expenseBody, { amount: 9999 }), { idempotencyKey: key });
    assert.ok(res.status >= 400 && res.status < 500,
      `reusing a key for a different request answered ${res.status}. The second action is either applied (double spend) or dropped (money reported as recorded and never spent) — there is no third outcome, and both are worse than a refusal`);
    assert.match(String(res.json && (res.json.error || res.json.message)), /key|different|already/i,
      `the refusal does not explain the key: "${res.json && (res.json.error || res.json.message)}"`);
    const list = await o.get(`/api/expenses?limit=100&branch_id=${branch.id}`);
    const rows = (list.json && list.json.data) || [];
    const ninetynine = rows.filter((r) => round2(Number(r.amount)) === 9999 && String(r.description || '').includes('retried expense'));
    assert.equal(ninetynine.length, 0, 'the second request WAS applied despite being refused — worse than either outcome above');
  });
  await audit.refusal('an absurdly long key is refused rather than stored',
    () => o.post('/api/expenses', expenseBody, { idempotencyKey: 'k'.repeat(129) }),
    { expectStatus: 400, code: /IDEMPOTENCY/, message: /128|too long/i });

  // ===================================================================
  audit.section('Two people, one row: the server wins and the loser is CAPTURED');
  // ===================================================================
  const subject = await audit.captureAsync('a customer two people will edit at once', async () => {
    const res = await o.post('/api/customers', {
      name: `Audit Sync Subject ${Date.now().toString(36).slice(-4)}`,
      phone: '08039998888', branch_id: branch.id, notes: 'audit.sync fixture',
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`creating the customer answered ${res.status} ${res.text.slice(0, 200)}`);
    d.trackCustomer(res.json.id);
    return res.json;
  });

  const asDeviceSaw = await audit.captureAsync('the row exactly as the device last saw it', async () => {
    const res = await o.get(`/api/customers/${encodeURIComponent(subject.id)}`);
    if (res.status !== 200) throw new Error(`reading the customer answered ${res.status}`);
    return res.json.customer || res.json.data || res.json;
  });

  await audit.checkAsync('the server row moves on while the device is offline', async () => {
    // PAST THE CLOCK TICK, ON PURPOSE, AND THE REASON IS A FINDING.
    //
    // `updated_at` is written with `datetime('now')` — SECOND precision, everywhere in the
    // product. LWW decides "the server changed after this device last saw it" by comparing
    // those strings, so an edit made in the SAME SECOND as the device's last read is
    // indistinguishable from no edit at all, and the device's version is applied over it.
    // That is a real (narrow) window on a schema-wide decision, recorded in STATUS.md rather
    // than papered over: a second edit by a human and a push from another phone inside one
    // second is possible, and the loser is told nothing.
    //
    // The audit waits a second so it measures the CONFLICT PATH rather than the tie-break.
    await new Promise((r) => setTimeout(r, 1200));
    const res = await o.put(`/api/customers/${encodeURIComponent(subject.id)}`, { city: 'Abuja' });
    assert.equal(res.status, 200, `the server-side edit answered ${res.status} ${res.text.slice(0, 200)}`);
    // The device is now editing a version that no longer exists. This is the ordinary
    // Nigerian shop: one person edits on the office laptop, another on the phone that has
    // been offline since morning.
  });

  const conflictPush = await audit.captureAsync('the device pushes its own version of the same row', async () => {
    const res = await o.post('/api/sync/push', {
      device_id: device,
      mutations: [{
        table: 'customers', id: subject.id,
        data: { notes: 'Edited offline by the cashier' },
        base_updated_at: asDeviceSaw.updated_at,
        client_updated_at: new Date().toISOString(),
      }],
    });
    if (!partial(res)) throw new Error(`the conflicting push answered ${res.status} ${res.text.slice(0, 300)}`);
    return Object.assign({ _raw: res }, res.json);
  });

  await audit.checkAsync('the offline edit loses, and the product says so instead of pretending', async () => {
    assert.ok(conflictPush, 'the conflicting push did not answer');
    const item = items(conflictPush._raw, 'mutations')[0] || {};
    assert.equal(String(item.status), 'CONFLICT',
      `the stale edit came back ${item.status} ${item.code || ''} — either the server's newer version was overwritten by a phone that had been offline all morning, or the device's work was dropped without being told`);
    assert.equal(String(item.code), 'SERVER_WON', `the conflict came back as ${item.code}`);
    assert.ok(item.serverVersion, 'the refusal does not carry the server version, so the device cannot refetch and merge');
  });

  await audit.checkAsync('the server row still holds the server\'s value', async () => {
    const res = await o.get(`/api/customers/${encodeURIComponent(subject.id)}`);
    const row = res.json.customer || res.json.data || res.json;
    assert.equal(String(row.city), 'Abuja', `the row's city is "${row.city}" — the phone rewrote a row it had not seen`);
    assert.notEqual(String(row.notes || ''), 'Edited offline by the cashier',
      'the stale note was written anyway: the conflict was detected and then applied');
  });

  await audit.checkAsync('and the losing version is stored, not thrown away', async () => {
    const res = await o.get('/api/sync/conflicts?limit=50');
    assert.equal(res.status, 200, `GET /api/sync/conflicts answered ${res.status}`);
    const rows = res.json.data || res.json.conflicts || [];
    const ours = rows.find((c) => String(c.row_id) === String(subject.id) && String(c.table_name) === 'customers');
    assert.ok(ours, `the conflict was detected but not recorded (${rows.length} row(s) listed) — a device's work that vanishes without a trace is how a shop concludes the app loses data`);
    const losing = typeof ours.losing_version_json === 'string' ? JSON.parse(ours.losing_version_json) : ours.losing_version_json;
    assert.match(JSON.stringify(losing), /Edited offline by the cashier/,
      'the captured losing version does not contain what the device actually tried to write — the record is then useless for deciding whether to re-queue it');
    conflictId = ours.id;
  });

  await audit.checkAsync('a manager can close the conflict, and closing it says who decided', async () => {
    if (!conflictId) { audit.skip('the conflict could not be resolved because none was recorded'); return; }
    const res = await o.post(`/api/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
      decision: 'SERVER_KEPT', resolution: 'The office edit is the correct address; the cashier was told.',
    });
    assert.equal(res.status, 200, `resolving answered ${res.status} ${res.text.slice(0, 200)}`);
    const again = await o.post(`/api/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
      decision: 'SERVER_KEPT', resolution: 'Resolving it a second time.',
    });
    assert.equal(again.status, 409, `resolving the same conflict twice answered ${again.status} — the review is a decision, and a decision has one author and one time`);
  });

  // ===================================================================
  audit.section('What a device may NOT write, and why each guard exists');
  // ===================================================================
  const guardPush = await audit.captureAsync('one push carrying three forbidden mutations and one good one', async () => {
    const res = await o.post('/api/sync/push', {
      device_id: device,
      mutations: [
        { table: 'customers', id: subject.id, data: { branch_id: 'some-other-branch', notes: 'scope grab' } },
        { table: 'sales', id: 'made-up-sale', data: { total: 1 } },
        { table: 'customers', id: 'no-such-row', data: { notes: 'ghost' } },
        { table: 'notifications', id: 'no-such-notification', data: { is_read: 1 } },
      ],
    });
    if (!partial(res)) throw new Error(`the mixed push answered ${res.status} ${res.text.slice(0, 300)}`);
    return Object.assign({ _raw: res }, res.json);
  });

  await audit.check('a device cannot write the column that decides who sees the row', () => {
    const item = items(guardPush && guardPush._raw, 'mutations')[0] || {};
    assert.equal(String(item.status), 'REJECTED', `writing customers.branch_id from a device came back ${item.status} — a device that can set that column can move a row into another branch and read it there`);
    assert.equal(String(item.code), 'SCOPE_COLUMN_FORBIDDEN', `it was refused as ${item.code}`);
  });
  await audit.check('a device cannot write a table that has its own rules', () => {
    const item = items(guardPush && guardPush._raw, 'mutations')[1] || {};
    assert.equal(String(item.status), 'REJECTED', `writing sales from a device came back ${item.status} — a sale has a till, a VAT treatment and a stock movement, and bypassing the sale endpoint skips all three`);
    assert.equal(String(item.code), 'TABLE_NOT_SYNCABLE', `it was refused as ${item.code}`);
  });
  await audit.check('a mutation for a row that does not exist is skipped, with a reason', () => {
    const item = items(guardPush && guardPush._raw, 'mutations')[2] || {};
    assert.ok(['SKIPPED', 'REJECTED'].includes(String(item.status)),
      `a mutation for a non-existent row came back ${item.status} ${item.code || ''} — it must not be treated as an insert, since that is how a device resurrects a deleted row`);
  });
  await audit.check('and the guards do not stop the rest of the batch', () => {
    assert.ok(guardPush, 'the push did not answer');
    assert.equal(items(guardPush._raw, 'mutations').length, 4, 'the push did not answer once per mutation — a device needs a result for every item it queued, not just the failures, and one 500 for the batch gives it none of them');
  });

  // ===================================================================
  audit.section('Pull: what a device gets back, and what it must never get');
  // ===================================================================
  await audit.checkAsync('a pull answers with rows and a cursor to carry forward', async () => {
    const res = await o.post('/api/sync/pull', { device_id: device, tables: ['products', 'customers'] });
    assert.equal(res.status, 200, `the pull answered ${res.status} ${res.text.slice(0, 200)}`);
    const body = res.json || {};
    const tables = body.data || body.tables || {};
    assert.ok(Object.keys(tables).length >= 1, `a full pull returned no tables at all: ${JSON.stringify(body).slice(0, 200)}`);
    assert.ok(body.since || body.cursor || body.serverTime || body.server_time,
      'the pull answers with no cursor and no server time, so a device has nothing to ask "what changed since" with');
    audit.note(`pulled ${Object.entries(tables).map(([t, rows]) => `${t}:${Array.isArray(rows) ? rows.length : (rows && rows.rows ? rows.rows.length : '?')}`).join(' ')}`);
  });

  if (d.seats.manager) {
    await audit.checkAsync("a branch-pinned pull does not carry another branch's customers", async () => {
      const res = await d.seats.manager.post('/api/sync/pull', { device_id: `${device}-mgr`, tables: ['customers'] });
      assert.equal(res.status, 200, `the manager's pull answered ${res.status}`);
      const body = res.json || {};
      const tables = body.data || body.tables || {};
      const rows = Array.isArray(tables.customers) ? tables.customers : ((tables.customers && tables.customers.rows) || []);
      const foreign = rows.filter((r) => r.branch_id && String(r.branch_id) !== String(d.seats.manager.branchId));
      assert.equal(foreign.length, 0,
        `a device pinned to one branch pulled ${foreign.length} customer row(s) belonging to another — the offline mirror is then a copy of somebody else's shop, sitting on a phone that leaves the building`);
    });
  } else {
    audit.skip('the branch scope of a pull is asserted', 'no branch-pinned seat was created on this target');
  }

  // ===================================================================
  audit.section('The branch-batch cap, and a device that is honest about being stuck');
  // ===================================================================
  await audit.checkAsync('an operation type the product does not replay is refused per-item, not fatally', async () => {
    const res = await o.post('/api/sync/push', {
      device_id: device,
      operations: [{ type: 'DELETE_EVERYTHING', client_id: 'nope', payload: {} }],
    });
    assert.ok(partial(res),
      `an unknown operation type failed the whole push (${res.status}). One bad item must not strand a device's entire queue — that is a day of sales stuck behind a malformed row`);
    const item = items(res, 'operations')[0] || {};
    assert.equal(String(item.code), 'UNKNOWN_OPERATION', `the item was refused as ${item.code}`);
    assert.match(String(item.message), /online|device/i, 'the refusal does not tell the device what to do with that item');
  });

  await audit.checkAsync('an operation with no idempotency key is refused, with the reason stated', async () => {
    const res = await o.post('/api/sync/push', {
      device_id: device,
      operations: [{ type: 'SALE', payload: queuedPayload }],
    });
    assert.ok(partial(res), `the push answered ${res.status}`);
    const item = items(res, 'operations')[0] || {};
    assert.equal(String(item.code), 'IDEMPOTENCY_KEY_REQUIRED',
      `an operation with no key came back ${item.code || item.status} — without a key a retried sync applies it twice, which is the exact failure this whole module exists to prevent`);
  });

  audit.note('the sync surface keeps its promise: replay is idempotent, conflicts are captured with both versions, and a device cannot write its way out of its branch');
}, {
  setup: () => startDeployment({
    label: 'sync',
    businesses: [{
      name: 'Sync Audit Appliances', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Sync Main Shop', code: 'SYN-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 40000 },
        { name: 'Sync Second Shop', code: 'SYN-2', city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL', opening_cash: 0 },
      ],
    }],
    seats: [{ as: 'manager', role: 'MANAGER', username: 'sync-manager', pin: '73041', branchIndex: 0, full_name: 'Sync Audit Manager' }],
  }),
});
