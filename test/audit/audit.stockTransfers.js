'use strict';
// =====================================================================
// test/audit/audit.stockTransfers.js — MOVING STOCK BETWEEN SHOPS
// =====================================================================
// Reported: a transfer could be sent and then NEVER RECEIVED. The receiving branch's screen had no
// Book-in button anywhere, and behind it the API had a status vocabulary the screen had never
// heard of. The cause was not a missing feature — it was two halves of one product disagreeing
// about five words:
//
//   the table:  INITIATED · IN_TRANSIT · PARTIALLY_RECEIVED · RECEIVED · CANCELLED
//   the screen: DRAFT · SENT · RECEIVED · CANCELLED          ← 'SENT' has never existed
//
// Every comparison on the receiving screen was against 'SENT', so the "waiting to be booked in"
// card was always empty, the status filter matched nothing, and `canReceive` was false for
// everybody. This audit holds the three copies of that vocabulary together — the migration, the
// route, the screen — and walks the two-way flow with a real partial delivery, because that is
// where a single literal hides.
//
//   FRONT TO BACK  a manager dispatches → the stock leaves their branch and is sellable nowhere →
//                  the receiving branch books part of it in → the balance arrives → RECEIVED
//   BACK TO FRONT  an unknown status filter is refused, not answered with an empty list → more
//                  than is outstanding is refused → the wrong branch cannot book it in → a
//                  transfer that never arrives can be cancelled, and the stock comes back →
//                  a cancelled transfer cannot then be received
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const ROOT = path.join(__dirname, '..', '..');
const TAG = Date.now().toString(36).slice(-5).toUpperCase();

runAudit('stockTransfers', async (audit, d) => {
  const owner = d.owner;
  const manager = d.seats.manager || owner;      // sends, from branch 0
  const receiver = d.seats.staff || owner;       // books in, at branch 1
  const receiverManager = d.seats.receiverManager || receiver; // manages the receiving branch
  const from = d.branches[0];
  const to = d.branches[1];
  assert.ok(to, `the fixture built ${d.branches.length} branch(es) — a transfer needs two`);

  // Stock at the sending branch, so there is something to send.
  const product = await audit.captureAsync('stock to send: a product on the shelf at the sending branch', async () => {
    const list = await owner.get('/api/products?limit=100');
    const pick = ((list.json && list.json.data) || []).find((p) => !Number(p.requires_serial) && Number(p.selling_price) > 0);
    assert.ok(pick, 'the vertical provisioned no ordinary product — the starter catalogue is missing');
    const rec = await owner.post('/api/stock/receive', {
      branch_id: from.id, product_id: pick.id, quantity: 10, unit_code: pick.default_unit_code || 'PIECE',
      cost_price: Number(pick.cost_price || 100), selling_price: Number(pick.selling_price),
      reference: `AUD-XFER-${TAG}`,
    });
    assert.ok(rec.status < 400, `stocking the sending branch answered ${rec.status}: ${String(rec.text).slice(0, 200)}`);
    return pick;
  });

  const onShelf = async (actor, branchId) => {
    const res = await actor.get('/api/stock?limit=200');
    const rows = ((res.json && res.json.data) || []).filter((r) => String(r.branch_id) === String(branchId) && String(r.product_id) === String(product.id));
    return rows.reduce((a, r) => a + Number(r.on_shelf || 0), 0);
  };

  // ------------------------------------------------------------------
  // FRONT TO BACK — SEND
  // ------------------------------------------------------------------
  const sent = await audit.captureAsync('a manager sends three units to the other branch', async () => {
    const before = await onShelf(manager, from.id);
    const res = await manager.post('/api/transfers', {
      from_branch_id: from.id, to_branch_id: to.id, reference: `TRF-AUD-${TAG}`,
      items: [{ product_id: product.id, quantity: 3 }],
    });
    assert.ok(res.status < 400, `sending a transfer answered ${res.status}: ${String(res.text).slice(0, 220)}`);
    // The create route answers the id and the reference, NOT the row — so the status is read from
    // the detail, which is the same screen the sender lands on. (The audit's first version
    // asserted `res.json.status` and read `undefined`: a response shape guessed at, not read.)
    assert.ok(res.json.id, `sending answered no id: ${String(res.text).slice(0, 200)}`);

    const detail = await manager.get(`/api/transfers/${encodeURIComponent(res.json.id)}`);
    assert.equal(detail.status, 200, `reading the transfer back answered ${detail.status}`);
    const t = detail.json.transfer;
    assert.equal(t.status, 'IN_TRANSIT', `a dispatched transfer is ${t.status}`);
    // THE VOCABULARY THE SCREEN MUST USE — the route answers it, so the client has no excuse.
    assert.deepEqual(detail.json.statuses, ['INITIATED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
      `the route advertises ${JSON.stringify(detail.json.statuses)}`);
    assert.deepEqual(detail.json.receivable, ['IN_TRANSIT', 'PARTIALLY_RECEIVED'],
      `a transfer bookable in these states: ${JSON.stringify(detail.json.receivable)}`);

    const after = await onShelf(manager, from.id);
    assert.equal(after, before - 3, `the sending branch had ${before} and now has ${after} — three units left it`);
    // AND IT IS SELLABLE NOWHERE YET: the receiving branch has it only when it books it in.
    assert.equal(await onShelf(receiver, to.id), 0, 'the destination can already count stock it has not booked in');
    // THE LINE'S OWN ID, WHICH IS WHAT A BOOKING IS KEYED BY. The route keys a partial receipt by
    // `item_id` — those ids only exist in the database, which is why the detail route exists at
    // all. The audit's first version posted the TRANSFER id here: no line matched the override,
    // every line fell back to its full sent quantity, and a booking of "one of three" came back
    // RECEIVED with all three on the shelf. A wrong id looked exactly like a working product.
    const item = (detail.json.items || [])[0];
    assert.ok(item && item.id, 'the transfer detail answered no line to book in');
    return { transfer: t, item };
  });

  // ------------------------------------------------------------------
  // FRONT TO BACK — BOOK IN, IN TWO DELIVERIES
  // ------------------------------------------------------------------
  await audit.checkAsync('part of the delivery arrives, the balance follows, and nothing is counted twice', async () => {
    if (!sent) { audit.skip('the transfer was never dispatched, so there is nothing to book in'); return; }
    // THE FIRST LOAD: one of the three.
    const part = await receiver.post(`/api/transfers/${encodeURIComponent(sent.transfer.id)}/receive`, {
      items: [{ item_id: sent.item.id, quantity_received_base: 1 }],
    });
    assert.ok(part.status < 400, `booking in one unit answered ${part.status}: ${String(part.text).slice(0, 220)}`);
    assert.equal(part.json.status, 'PARTIALLY_RECEIVED', `booking in 1 of 3 left the transfer ${part.json.status}, so the balance can never be booked`);
    assert.match(String(part.json.message || ''), /outstanding/i, `the message does not say what is still to come: ${part.json.message}`);
    assert.equal(await onShelf(receiver, to.id), 1, 'the one unit that arrived is not on the receiving branch\'s shelf');

    const mid = await receiver.get(`/api/transfers/${encodeURIComponent(sent.transfer.id)}`);
    const line = mid.json.items[0];
    assert.equal(Number(line.quantity_received), 1, `the line says ${line.quantity_received} received after one unit`);
    assert.equal(Number(mid.json.summary.unitsReceived), 1, `the summary says ${mid.json.summary.unitsReceived} received`);
    assert.equal(Number(mid.json.summary.shortfall), 2, `the shortfall on the transfer is ${mid.json.summary.shortfall}, not 2`);

    // MORE THAN IS OUTSTANDING IS REFUSED. Two arrived and one is already in: the line owes two,
    // so a client that sends "3 arrived" — the whole manifest — must be refused rather than
    // booking the first load in twice.
    const greedy = await receiver.post(`/api/transfers/${encodeURIComponent(sent.transfer.id)}/receive`, {
      items: [{ item_id: sent.item.id, quantity_received_base: 3 }],
    });
    assert.equal(greedy.status, 400, `booking in 3 when 2 are outstanding answered ${greedy.status}`);
    assert.equal(greedy.json.code, 'OVER_RECEIPT', `refused as ${greedy.json.code}`);
    assert.match(String(greedy.json.error || ''), /already booked in/i, `the refusal does not say what is already in: ${String(greedy.json.error).slice(0, 180)}`);
    assert.equal(await onShelf(receiver, to.id), 1, 'a refused booking changed the shelf');

    // THE BALANCE.
    const rest = await receiver.post(`/api/transfers/${encodeURIComponent(sent.transfer.id)}/receive`, {
      items: [{ item_id: sent.item.id, quantity_received_base: 2 }],
    });
    assert.ok(rest.status < 400, `booking in the balance answered ${rest.status}: ${String(rest.text).slice(0, 200)}`);
    assert.equal(rest.json.status, 'RECEIVED', `after the balance the transfer is ${rest.json.status}`);
    assert.equal(await onShelf(receiver, to.id), 3, 'the three units are not all on the receiving branch\'s shelf');
    audit.note(`1 of 3, then the balance: ${rest.json.status}, transfer price ₦${Number(rest.json.receivedValue || 0).toLocaleString('en-NG')}`);

    // ALREADY RECEIVED IS NOT RECEIVABLE AGAIN.
    const again = await receiver.post(`/api/transfers/${encodeURIComponent(sent.transfer.id)}/receive`, {
      items: [{ item_id: sent.item.id, quantity_received_base: 1 }],
    });
    assert.equal(again.status, 409, `booking into a fully received transfer answered ${again.status}`);
    assert.equal(again.json.code, 'ALREADY_RECEIVED', `refused as ${again.json.code}`);
  });

  // ------------------------------------------------------------------
  // BACK TO FRONT — REFUSALS AND AUTHORITY
  // ------------------------------------------------------------------
  await audit.checkAsync('an unknown status filter is refused, and the vocabulary is one vocabulary', async () => {
    const bad = await owner.get('/api/transfers?status=SENT');
    assert.equal(bad.status, 400, `filtering by 'SENT' — a status nothing can have — answered ${bad.status} instead of refusing`);
    assert.equal(bad.json.code, 'UNKNOWN_STATUS', `refused as ${bad.json.code}`);
    assert.match(String(bad.json.error || ''), /IN_TRANSIT/, 'the refusal should name the statuses this system does have');

    // THREE COPIES, ONE VOCABULARY. The migration is the authority; the route is what the client
    // is told; the screen is what a person reads and clicks. This is the check that would have
    // caught the reported bug on the day it was written.
    const schema = fs.readFileSync(path.join(ROOT, 'schema', 'migrations', '0001_initial_schema.sql'), 'utf8');
    const check = /CREATE TABLE[^;]*stock_transfers[\s\S]*?CHECK \(status IN \(([^)]*)\)\)/.exec(schema);
    assert.ok(check, 'the stock_transfers status CHECK constraint is gone from the schema');
    const fromSchema = check[1].split(',').map((w) => w.trim().replace(/'/g, ''));
    const listed = await owner.get('/api/transfers?limit=1');
    assert.deepEqual(listed.json.statuses, fromSchema,
      `the route offers ${JSON.stringify(listed.json.statuses)} and the table allows ${JSON.stringify(fromSchema)}`);

    const view = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'transfers.js'), 'utf8');
    const code = view
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
    const literals = new Set([...code.matchAll(/'([A-Z][A-Z_]{4,})'/g)].map((m) => m[1]).filter((w) => fromSchema.includes(w)));
    for (const status of literals) assert.ok(fromSchema.includes(status), `the screen uses the status ${status}`);
    for (const ghost of ['SENT', 'DRAFT']) {
      assert.doesNotMatch(code, new RegExp(`['"]${ghost}['"]`),
        `the screen still compares against '${ghost}' — a status this table cannot contain, which is what hid the Book-in button from every receiving branch`);
    }
    // AND IT TAKES THE VOCABULARY FROM THE ANSWER rather than assuming its own copy is current.
    assert.match(code, /data\.receivable/, 'the screen no longer reads which statuses are bookable from the API answer');
    assert.match(code, /learnStatuses/, 'the screen no longer learns the vocabulary from the server');
    audit.note(`vocabulary held together across the migration, the route and the screen: ${fromSchema.join(', ')}`);
  });

  await audit.checkAsync('only the branch it is addressed to can book a transfer in', async () => {
    if (!sent) { audit.skip('the first transfer never left, so this check cannot set up its two'); return; }
    const second = await manager.post('/api/transfers', {
      from_branch_id: from.id, to_branch_id: to.id, reference: `TRF-AUD2-${TAG}`,
      items: [{ product_id: product.id, quantity: 2 }],
    }, { idempotencyKey: `aud-send2-${TAG}` });
    assert.ok(second.status < 400, `the second transfer answered ${second.status}: ${String(second.text).slice(0, 160)}`);
    const line = (await manager.get(`/api/transfers/${encodeURIComponent(second.json.id)}`)).json.items[0];

    // THE SENDER CANNOT RECEIVE ITS OWN DISPATCH, and neither can a branch it was not sent to.
    const wrong = await manager.post(`/api/transfers/${encodeURIComponent(second.json.id)}/receive`, {
      items: [{ item_id: line.id, quantity_received_base: 2 }],
    });
    assert.equal(wrong.status, 403, `the sending branch booked in its own transfer (${wrong.status})`);
    assert.equal(wrong.json.code, 'BRANCH_SCOPE_VIOLATION', `refused as ${wrong.json.code}`);
    assert.match(String(wrong.json.error || ''), /only the receiving branch/i, `the refusal should say whose it is: ${String(wrong.json.error).slice(0, 140)}`);

    // ---- AND THE ONE THAT NEVER ARRIVED CAN BE CANCELLED, WITH ITS STOCK BACK ----
    const beforeCancel = await onShelf(manager, from.id);
    const cancel = await manager.post(`/api/transfers/${encodeURIComponent(second.json.id)}/cancel`, { reason: 'the truck turned back at Ore' });
    assert.ok(cancel.status < 400, `cancelling answered ${cancel.status}: ${String(cancel.text).slice(0, 220)}`);
    assert.equal(cancel.json.status, 'CANCELLED', `the cancelled transfer is ${cancel.json.status}`);
    assert.equal(Number(cancel.json.returnedUnits), 2, `cancelling returned ${cancel.json.returnedUnits} unit(s), not 2`);
    assert.equal(await onShelf(manager, from.id), beforeCancel + 2,
      `the sending branch had ${beforeCancel} before cancelling and has ${await onShelf(manager, from.id)} after — the stock did not come back`);
    assert.equal(await onShelf(receiver, to.id), 3, 'cancelling a transfer moved stock that was already booked in somewhere else');

    // A CANCELLED TRANSFER CANNOT THEN BE BOOKED IN, and cannot be cancelled twice.
    const tooLate = await receiver.post(`/api/transfers/${encodeURIComponent(second.json.id)}/receive`, {
      items: [{ item_id: line.id, quantity_received_base: 2 }],
    });
    assert.equal(tooLate.status, 409, `booking into a cancelled transfer answered ${tooLate.status}`);
    assert.equal(tooLate.json.code, 'TRANSFER_CANCELLED', `refused as ${tooLate.json.code}`);
    const twice = await manager.post(`/api/transfers/${encodeURIComponent(second.json.id)}/cancel`, { reason: 'again' });
    assert.equal(twice.status, 409, `cancelling twice answered ${twice.status}`);
    assert.equal(twice.json.code, 'ALREADY_CANCELLED', `refused as ${twice.json.code}`);

    // THE RECEIVING BRANCH CANNOT CANCEL WHAT IT DID NOT SEND — its answer to "it never came" is
    // to leave it outstanding, not to rewrite the sender's records.
    const third = await manager.post('/api/transfers', {
      from_branch_id: from.id, to_branch_id: to.id, reference: `TRF-AUD3-${TAG}`,
      items: [{ product_id: product.id, quantity: 1 }],
    }, { idempotencyKey: `aud-send3-${TAG}` });
    // ASKED BY A MANAGER AT THE RECEIVING BRANCH, deliberately: a cashier is refused earlier for
    // having no standing to cancel anything (ROLE_REQUIRED), which would prove the wrong rule.
    // The rule under test is BRANCH — it left the sender, and it is theirs until it is booked in.
    const notYours = await receiverManager.post(`/api/transfers/${encodeURIComponent(third.json.id)}/cancel`, { reason: 'it never arrived' });
    assert.equal(notYours.status, 403, `a manager at the receiving branch cancelled the sender's transfer (${notYours.status})`);
    assert.equal(notYours.json.code, 'BRANCH_SCOPE_VIOLATION', `refused as ${notYours.json.code}`);
    // The refusal NAMES THE BRANCH, not the concept: "Only Transfer Audit Main can cancel this
    // transfer — the stock left there and it is theirs until TRF-… is booked in."
    assert.match(String(notYours.json.error || ''), new RegExp(String(from.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `the refusal does not name the branch whose transfer it is: ${String(notYours.json.error).slice(0, 170)}`);

    // AND BOTH ENDS ARE ON THE TRAIL.
    const trail = await owner.get('/api/audit?entity_type=STOCK_TRANSFER&limit=50');
    const actions = (trail.json.data || []).map((r) => r.action);
    assert.ok(actions.includes('TRANSFER_INITIATED'), `the trail has no TRANSFER_INITIATED: ${[...new Set(actions)].join(', ')}`);
    assert.ok(actions.includes('TRANSFER_RECEIVED'), 'the trail has no TRANSFER_RECEIVED');
    assert.ok(actions.includes('TRANSFER_CANCELLED'), 'the trail has no TRANSFER_CANCELLED — a cancelled transfer with stock moving back is not on the record');
  });
}, {
  setup: () => startDeployment({
    label: 'stocktransfers',
    businesses: [{
      name: 'Transfer Audit Depot', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Transfer Audit Main', code: 'XT-1', city: 'Abuja', state: 'FCT', branch_type: 'WAREHOUSE', opening_cash: 30000 },
        { name: 'Transfer Audit Shop', code: 'XT-2', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 15000 },
      ],
    }],
    seats: [
      // A seat must name a branch: the API refuses a user with no scope ("a user with no branch
      // has no scope, so they would see nothing"), which is right — and the owner here is given
      // the SENDING branch, the one they would cancel from.
      { as: 'owner', role: 'OWNER', username: 'xt-owner', pin: '95171', branchIndex: 0, full_name: 'Transfer Audit Owner' },
      { as: 'manager', role: 'MANAGER', username: 'xt-manager', pin: '95172', branchIndex: 0, full_name: 'Transfer Audit Sender' },
      { as: 'staff', role: 'STAFF', username: 'xt-staff', pin: '95173', branchIndex: 1, full_name: 'Transfer Audit Receiver' },
      { as: 'receiverManager', role: 'MANAGER', username: 'xt-recv-mgr', pin: '95174', branchIndex: 1, full_name: 'Transfer Audit Receiver Manager' },
    ],
  }),
});
