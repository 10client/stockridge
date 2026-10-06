'use strict';
// =====================================================================
// test/audit/audit.warranty.js — A UNIT COMES BACK, AND WHAT IT COSTS
// =====================================================================
// `tools/flow-coverage.js` listed warranty-claims at 0/3: the last flow in the product with
// no audit at all. Auditing it is why the serial register got a writer first — a claim needs a
// serial number on file, and until P6a nothing in the product could record one, so every claim
// ever attempted answered `404 SERIAL_NOT_FOUND` and the three routes below were unreachable.
//
// The claims flow is where a shop's promises become money:
//
//   * A CLAIM NOBODY CAN CLOSE. The unit is in the customer's kitchen, the fault is recorded,
//     and the repair, the replacement or the refund never happens — because the route that
//     records it cannot run.
//   * A RECOVERY NOBODY CHASES. Most warranty work in Nigeria is a pass-through to the
//     importer. If the cost to the business and the recovery from the supplier are not kept
//     apart, a shop cannot tell a service from a loss.
//
// So this audit sells three appliances, brings them back one at a time, and reads the register,
// the ledger and the sale back:
//
//   FRONT TO BACK  open a claim on a sold unit → it is on the list, the unit says so, the cover
//                  is right. Repair it → closed, costed, recovered, and posted to the books.
//                  Replace one → the returned unit leaves circulation and its replacement
//                  inherits the remaining cover. Refund one → the sale carries the annotation.
//   BACK TO FRONT  read the list (open, closed, in-warranty, searched), read the unit's own
//                  lookup and its note, read the trial balance, read the sale.
//   AND THE REFUSALS a claim on a serial nobody has seen, a fault described in three words, a
//                  resolution nobody recognises, a rejection with no reason, a recovery larger
//                  than the cost, a recovery with no supplier reference, a second resolution.
//   AND THE OUT-OF-WARRANTY half: a unit with no cover at all is still repairable — as a paid
//                  job — and the claim has to say so before any work starts.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `₦${round2(n).toLocaleString('en-NG')}`;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const MARK = Date.now().toString(36).toUpperCase().slice(-6);
const SERIAL = (n) => `WAR-${MARK}-${String(n).padStart(3, '0')}`;

runAudit('warranty', async (audit, d) => {
  const owner = d.owner || d.admin;
  const manager = (d.seats && d.seats.manager) || null;
  const staff = (d.seats && d.seats.staff) || null;
  if (!manager || !staff) throw new Error('the warranty fixture needs a MANAGER seat (only a manager may resolve a claim) and a STAFF seat to try it with');
  const branch = (d.branches || [])[0];
  assert.ok(branch, 'the warranty fixture has no branch to trade at');

  // ===================================================================
  // THREE APPLIANCES, SOLD — THE UNITS A CLAIM IS ABOUT
  // ===================================================================
  const product = await audit.captureAsync('a covered appliance, received with serials and sold', async () => {
    const made = await manager.post('/api/products', {
      name: `Audit Warranty Appliance ${MARK}`, sku: `AUD-WAR-${MARK}`,
      base_unit_name: 'piece', cost_price: 180000, selling_price: 250000,
      warranty_months: 12, warranty_type: 'CARRY_IN', requires_serial: 1,
      is_returnable: 1, return_window_days: 30,
    });
    assert.ok(made.status < 400, `creating the product answered ${made.status}: ${String(made.text).slice(0, 240)}`);
    const id = made.json.id || (made.json.product && made.json.product.id);
    assert.ok(id, 'the product was created and the answer carries no id');
    d.trackRestore(`product ${MARK}`, async () => {
      const del = await manager.del(`/api/products/${encodeURIComponent(id)}`);
      if (del.status < 300 || del.status === 404) return true;
      const off = await manager.put(`/api/products/${encodeURIComponent(id)}`, { is_active: 0 });
      return off.status < 300;
    });
    const received = await manager.post('/api/stock/receive', {
      branch_id: branch.id, product_id: id, quantity: 3, unit_code: 'PIECE', cost_price: 180000,
      selling_price: 250000, batch_no: `WAR-${MARK}`,
      serials: [SERIAL(1), SERIAL(2), SERIAL(3)],
    });
    assert.ok(received.status < 400, `receiving three covered units answered ${received.status}: ${String(received.text).slice(0, 240)}`);
    assert.equal(Number(received.json.serialCount), 3, `the receipt filed ${received.json.serialCount} of three serials`);
    return { id, name: `Audit Warranty Appliance ${MARK}` };
  });

  const uncovered = await audit.captureAsync('an appliance with no warranty at all, sold', async () => {
    const made = await manager.post('/api/products', {
      name: `Audit Uncovered Item ${MARK}`, sku: `AUD-UNW-${MARK}`,
      base_unit_name: 'piece', cost_price: 20000, selling_price: 35000,
      // No warranty is offered on this one, which is a legitimate way to sell — and the
      // claim opened on it has to say so plainly rather than quietly applying cover.
      warranty_months: 0, requires_serial: 1,
    });
    assert.ok(made.status < 400, `creating the uncovered product answered ${made.status}: ${String(made.text).slice(0, 240)}`);
    const id = made.json.id || (made.json.product && made.json.product.id);
    d.trackRestore(`product uncovered ${MARK}`, async () => {
      const del = await manager.del(`/api/products/${encodeURIComponent(id)}`);
      if (del.status < 300 || del.status === 404) return true;
      const off = await manager.put(`/api/products/${encodeURIComponent(id)}`, { is_active: 0 });
      return off.status < 300;
    });
    const received = await manager.post('/api/stock/receive', {
      branch_id: branch.id, product_id: id, quantity: 1, unit_code: 'PIECE', cost_price: 20000,
      selling_price: 35000, batch_no: `UNW-${MARK}`, serials: [SERIAL(9)],
    });
    assert.ok(received.status < 400, `receiving the uncovered unit answered ${received.status}: ${String(received.text).slice(0, 240)}`);
    return { id, name: `Audit Uncovered Item ${MARK}` };
  });

  const customerName = `Warranty Audit Customer ${MARK}`;
  const customer = await audit.captureAsync('a customer whose appliances come back', async () => {
    const res = await owner.post('/api/customers', {
      name: customerName, phone: `0806${String(Date.now()).slice(-7)}`,
      customer_type: 'INDIVIDUAL', address: '9 Warranty Way, Wuse 2, Abuja',
    });
    assert.ok(res.status < 400, `creating the customer answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const id = res.json.id || (res.json.customer && res.json.customer.id);
    assert.ok(id, 'the customer was created and the answer carries no id');
    d.trackCustomer(id);
    return { id, name: customerName };
  });

  const sell = async (productId, price, serialNo, tag) => {
    const res = await manager.post('/api/sales', {
      branch_id: branch.id, customer_id: customer.id,
      lines: [{ product_id: productId, quantity: 1, serial_numbers: [serialNo] }],
      payments: [{ method: 'CASH', amount: price, cash_tendered: price }],
      device_id: 'audit-warranty',
    }, { idempotencyKey: `war-${tag}-${MARK}` });
    assert.ok(res.status < 400, `selling ${serialNo} answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    return { id: res.json.id || res.json.saleId, receiptNo: res.json.receiptNo || res.json.receipt_no };
  };

  const firstSale = await audit.captureAsync('the first covered appliance sold over the counter', async () => sell(product.id, 250000, SERIAL(1), 's1'));
  const secondSale = await audit.captureAsync('a second covered appliance, to be replaced', async () => sell(product.id, 250000, SERIAL(2), 's2'));
  await audit.captureAsync('an uncovered appliance sold with no warranty offered', async () => sell(uncovered.id, 35000, SERIAL(9), 's9'));

  const serialEnds = await audit.captureAsync('when the first unit’s cover runs out', async () => {
    const res = await owner.get(`/api/serials/${encodeURIComponent(SERIAL(1))}`);
    assert.equal(res.status, 200, `the serial lookup answered ${res.status}`);
    assert.equal(res.json.inWarranty, true, 'a unit sold today with twelve months of cover is not under warranty');
    return String(res.json.serial.warranty_ends_at).slice(0, 10);
  });
  audit.note(`${SERIAL(1)}: sold today, covered to ${serialEnds}`);

  // ===================================================================
  // FRONT TO BACK — A UNIT COMES BACK
  // ===================================================================
  audit.section('The customer brings the freezer back');

  await audit.checkAsync('a claim on a serial nobody has seen is refused, and says what to do instead', async () => {
    const res = await manager.post('/api/warranty-claims', {
      branch_id: branch.id, customer_id: customer.id,
      serial_no: `NEVER-SOLD-${MARK}`,
      fault_reported: 'The freezer stopped cooling after two days of use.',
    });
    assert.equal(res.status, 404,
      `a claim was opened for a serial that is not in the system: ${res.status}. That is how a stolen or parallel-imported unit is laundered into free warranty work`);
    assert.equal(res.json.code, 'SERIAL_NOT_FOUND', `the refusal came back as ${res.json.code}`);
    assert.ok(/out-of-warranty repair/i.test(String(res.json.error || res.json.message || '')),
      `the refusal does not offer the alternative (a paid repair): ${String(res.json.error || res.json.message).slice(0, 240)}`);
  });

  await audit.checkAsync('"not working" is not a fault description', async () => {
    const res = await manager.post('/api/warranty-claims', {
      branch_id: branch.id, customer_id: customer.id, serial_no: SERIAL(1), fault_reported: 'Not working',
    });
    assert.equal(res.status, 400, `a two-word fault description opened a claim: ${res.status}`);
    assert.equal(res.json.code, 'FAULT_DESCRIPTION_REQUIRED', `the refusal came back as ${res.json.code}`);
  });

  const claim = await audit.captureAsync('a claim opened on the unit, in the customer’s own words', async () => {
    const res = await manager.post('/api/warranty-claims', {
      branch_id: branch.id, customer_id: customer.id, serial_no: SERIAL(1),
      fault_reported: 'The freezer runs but does not get cold. The compressor hums and stops after a few minutes.',
      notes: 'Unit brought to the counter by the customer.',
    });
    assert.ok(res.status === 201 || res.status === 200, `opening the claim answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    assert.ok(res.json.claimNo, 'the claim was opened and the answer carries no claim number');
    assert.equal(res.json.inWarranty, true, 'the claim does not recognise the cover the unit has');
    assert.equal(String(res.json.warrantyEnds), serialEnds,
      `the claim says the cover ends ${res.json.warrantyEnds} and the unit says ${serialEnds}. Two answers to "is this in warranty" is how a customer is told no at one counter and yes at the next`);
    assert.ok(/IS in warranty/i.test(String(res.json.message)),
      `the confirmation does not tell the counter that cover applies: ${String(res.json.message).slice(0, 240)}`);
    return { id: res.json.id, claimNo: res.json.claimNo };
  });

  await audit.checkAsync('the claim is on the board, with the unit, the customer and the receipt', async () => {
    const res = await owner.get('/api/warranty-claims?limit=100');
    assert.equal(res.status, 200, `the claims list answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const row = (res.json.data || []).filter((r) => String(r.id) === String(claim.id))[0];
    assert.ok(row, `${claim.claimNo} was opened and is not on the list`);
    assert.equal(String(row.status), 'OPEN', `the claim is listed as ${row.status}`);
    assert.equal(String(row.serial_no), SERIAL(1), `the claim is against ${row.serial_no}, not the unit it was opened for`);
    assert.equal(String(row.receipt_no), String(firstSale.receiptNo), `the claim is against receipt ${row.receipt_no}, not the one the unit was sold on`);
    assert.equal(String(row.customer_name), customerName, `the claim names "${row.customer_name}" as the customer`);
    assert.equal(Number(row.in_warranty), 1, 'the claim does not carry the in-warranty verdict');
  });

  await audit.checkAsync('the unit itself now says it has a claim against it', async () => {
    const res = await owner.get(`/api/serials/${encodeURIComponent(SERIAL(1))}`);
    assert.equal(Number(res.json.serial.claim_count), 1, `the unit reports ${res.json.serial.claim_count} claim(s)`);
    assert.equal(String(res.json.serial.latest_claim_status), 'OPEN', `the unit's latest claim is ${res.json.serial.latest_claim_status}`);
    assert.ok(String(res.json.serial.notes || '').includes(claim.claimNo),
      `the claim reference is not written on the unit's own record. Without it, a technician holding the unit cannot find the claim it came in for`);
  });

  // ===================================================================
  // THE REFUSALS A MANAGER MEETS ON THE FORM
  // ===================================================================
  audit.section('What the resolution form will not accept');

  await audit.checkAsync('a STAFF member cannot close a claim', async () => {
    const res = await staff.post(`/api/warranty-claims/${encodeURIComponent(claim.id)}/resolve`, {
      resolution: 'REPAIRED', fault_found: 'Gas leak at the joint.', cost_to_business: 5000,
    });
    assert.equal(res.status, 403, `a STAFF member resolved a claim: ${res.status} ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'ROLE_REQUIRED', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('a resolution nobody recognises is refused', async () => {
    const res = await manager.post(`/api/warranty-claims/${encodeURIComponent(claim.id)}/resolve`, {
      resolution: 'FIXED_IT', fault_found: 'Gas leak at the joint.',
    });
    assert.equal(res.status, 400, `the resolution FIXED_IT was accepted: ${res.status}`);
    assert.equal(res.json.code, 'NOT_ALLOWED', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('a rejected claim needs a written reason a customer can be given', async () => {
    const noReason = await manager.post(`/api/warranty-claims/${encodeURIComponent(claim.id)}/resolve`, {
      resolution: 'REJECTED', resolution_notes: 'No',
    });
    assert.equal(noReason.status, 400, `a claim was rejected with the note "No": ${noReason.status}`);
    assert.equal(noReason.json.code, 'REJECTION_REASON_REQUIRED', `the refusal came back as ${noReason.json.code}`);
  });

  await audit.checkAsync('a recovery larger than the cost, and one with no supplier reference, are both refused', async () => {
    const tooMuch = await manager.post(`/api/warranty-claims/${encodeURIComponent(claim.id)}/resolve`, {
      resolution: 'SUPPLIER_RETURN', fault_found: 'Compressor failure.', cost_to_business: 40000, supplier_recovery_amount: 60000,
    });
    assert.equal(tooMuch.status, 400,
      `a supplier recovery of ${money(60000)} against a ${money(40000)} cost was accepted: ${tooMuch.status}. A supplier does not pay more than the claim is worth`);
    assert.equal(tooMuch.json.code, 'RECOVERY_EXCEEDS_COST', `the refusal came back as ${tooMuch.json.code}`);

    const noRef = await manager.post(`/api/warranty-claims/${encodeURIComponent(claim.id)}/resolve`, {
      resolution: 'SUPPLIER_RETURN', fault_found: 'Compressor failure.', cost_to_business: 40000, supplier_recovery_amount: 40000,
    });
    assert.equal(noRef.status, 400, `a recovery with no supplier reference was accepted: ${noRef.status}`);
    assert.equal(noRef.json.code, 'SUPPLIER_REF_REQUIRED', `the refusal came back as ${noRef.json.code}`);
  });

  // ===================================================================
  // FRONT TO BACK — THE REPAIR, AND WHAT IT COST
  // ===================================================================
  audit.section('Repaired, costed, and recovered from the importer');

  const booksBefore = await audit.captureAsync('the books before the repair is paid for', async () => {
    const res = await owner.get('/api/accounting/trial-balance');
    assert.equal(res.status, 200, `the trial balance answered ${res.status}`);
    const find = (code) => (res.json.accounts || []).find((a) => a.code === code);
    return {
      warrantyExpense: round2(Number((find('5200') || {}).balance || 0)),
      recoverable: round2(Number((find('1200') || {}).balance || 0)),
      cash: round2(Number((find('1000') || {}).balance || 0)),
      balanced: res.json.balances,
    };
  });

  await audit.checkAsync('the repair closes the claim, keeps the two figures apart, and posts both to the books', async () => {
    const res = await manager.post(`/api/warranty-claims/${encodeURIComponent(claim.id)}/resolve`, {
      resolution: 'REPAIRED', fault_found: 'Gas leak at the compressor joint — recharged and sealed.',
      cost_to_business: 40000, supplier_recovery_amount: 40000, supplier_claim_ref: `SUP-${MARK}`,
      resolution_notes: 'Repaired at the counter, returned to the customer the same day.',
    });
    assert.ok(res.status < 400, `resolving the claim answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    assert.equal(round2(res.json.costToBusiness), 40000, `the claim closed at a cost of ${money(res.json.costToBusiness)}`);
    assert.equal(round2(res.json.supplierRecovery), 40000, `the recovery is recorded as ${money(res.json.supplierRecovery)}`);
    assert.equal(round2(res.json.netCost), 0,
      `the net cost of the claim is ${money(res.json.netCost)} and should be zero — a repair that costs what it recovers is a service, and a shop that cannot see that difference cannot price one`);

    const books = await owner.get('/api/accounting/trial-balance');
    const find = (code) => (books.json.accounts || []).find((a) => a.code === code);
    const expenseNow = round2(Number((find('5200') || {}).balance || 0));
    const recoverableNow = round2(Number((find('1200') || {}).balance || 0));
    assert.equal(round2(expenseNow - booksBefore.warrantyExpense), 40000,
      `the warranty expense account moved by ${money(round2(expenseNow - booksBefore.warrantyExpense))} against a ${money(40000)} repair`);
    assert.equal(round2(recoverableNow - booksBefore.recoverable), 40000,
      `the recoverable-from-supplier account moved by ${money(round2(recoverableNow - booksBefore.recoverable))} against a ${money(40000)} claim`);
    assert.equal(books.json.balances, true,
      'the books do not balance after a warranty posting — every other report is now suspect');
  });

  await audit.checkAsync('a closed claim leaves the open board and is found by asking for closed ones', async () => {
    const open = await owner.get('/api/warranty-claims?limit=100');
    assert.equal((open.json.data || []).filter((r) => String(r.id) === String(claim.id)).length, 0,
      `${claim.claimNo} is closed and still on the open board`);
    const closed = await owner.get(`/api/warranty-claims?status=CLOSED&limit=100`);
    const row = (closed.json.data || []).filter((r) => String(r.id) === String(claim.id))[0];
    assert.ok(row, `${claim.claimNo} is closed and cannot be found by asking for closed claims`);
    assert.equal(String(row.resolution), 'REPAIRED', `the closed claim records the outcome as ${row.resolution}`);
    assert.equal(Number(row.cost_to_business), 40000, `the closed claim records a cost of ${money(row.cost_to_business)}`);
    assert.equal(String(row.supplier_claim_ref), `SUP-${MARK}`, `the supplier reference is recorded as ${row.supplier_claim_ref}`);
    assert.ok(row.fault_found, 'the closed claim does not record what was actually wrong');
    assert.ok(row.resolved_at, 'the closed claim does not record when it was resolved');
  });

  await audit.checkAsync('a claim cannot be resolved twice', async () => {
    const res = await manager.post(`/api/warranty-claims/${encodeURIComponent(claim.id)}/resolve`, {
      resolution: 'REPAIRED', fault_found: 'Same fault again.', cost_to_business: 10000,
    });
    assert.equal(res.status, 409, `a closed claim was resolved again: ${res.status}`);
    assert.equal(res.json.code, 'ALREADY_RESOLVED', `the refusal came back as ${res.json.code}`);
  });

  // ===================================================================
  // A REPLACEMENT, AND A UNIT WITH NO COVER AT ALL
  // ===================================================================
  audit.section('Replaced, and repaired at the customer’s own cost');

  const replaceClaim = await audit.captureAsync('a second claim, on the unit that will be replaced', async () => {
    const res = await manager.post('/api/warranty-claims', {
      branch_id: branch.id, customer_id: customer.id, serial_no: SERIAL(2),
      fault_reported: 'The door seal is split and the unit ices up solid within a day.',
    });
    assert.ok(res.status < 400, `opening the second claim answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    return { id: res.json.id, claimNo: res.json.claimNo };
  });

  await audit.checkAsync('a replacement: the returned unit leaves circulation and its successor inherits the cover', async () => {
    const replacement = await owner.get(`/api/serials/${encodeURIComponent(SERIAL(3))}`);
    assert.equal(String(replacement.json.serial.status), 'IN_STOCK', `${SERIAL(3)} is not on the shelf to be issued as a replacement`);

    const res = await manager.post(`/api/warranty-claims/${encodeURIComponent(replaceClaim.id)}/resolve`, {
      resolution: 'REPLACED', fault_found: 'Door seal split; the cabinet ices up. Uneconomic to repair.',
      replacement_serial_id: replacement.json.serial.id,
      resolution_notes: 'New unit issued from stock; the customer keeps the original cover end date.',
    });
    assert.ok(res.status < 400, `resolving as REPLACED answered ${res.status}: ${String(res.text).slice(0, 300)}`);

    const oldUnit = await owner.get(`/api/serials/${encodeURIComponent(SERIAL(2))}`);
    assert.equal(String(oldUnit.json.serial.status), 'TRANSFERRED',
      `the returned unit is ${oldUnit.json.serial.status}. A unit that has gone back to the supplier must not read as sold, or it will be sold again`);

    const newUnit = await owner.get(`/api/serials/${encodeURIComponent(SERIAL(3))}`);
    assert.equal(String(newUnit.json.serial.status), 'SOLD', `the replacement unit is ${newUnit.json.serial.status}, not SOLD`);
    assert.equal(String(newUnit.json.serial.warranty_ends_at).slice(0, 10), serialEnds,
      `the replacement's cover ends ${newUnit.json.serial.warranty_ends_at} and the unit it replaced was covered to ${serialEnds}. A replacement restarts the clock only if the shop promised that — inheriting is what keeps the original promise`);
    assert.ok(String(newUnit.json.serial.notes || '').includes(replaceClaim.claimNo),
      'the replacement unit does not record which claim it was issued under');
  });

  await audit.checkAsync('a unit with no warranty can still be repaired — and the claim says so before any work starts', async () => {
    const opened = await manager.post('/api/warranty-claims', {
      branch_id: branch.id, customer_id: customer.id, serial_no: SERIAL(9),
      fault_reported: 'The element has failed. No warranty was offered on this item.',
    });
    assert.ok(opened.status < 400, `opening a claim on an uncovered unit answered ${opened.status}: ${String(opened.text).slice(0, 240)}`);
    assert.equal(opened.json.inWarranty, false,
      'a unit sold with no warranty is recorded as in warranty — the shop would be paying for a repair it never promised');
    assert.ok(/OUT of warranty/i.test(String(opened.json.message)),
      `the confirmation does not tell the counter the unit is out of cover: ${String(opened.json.message).slice(0, 240)}`);
    assert.ok(/paid|pay|repair/i.test(String(opened.json.message)),
      'the confirmation does not mention that the work can still be done as a paid job');

    const resolved = await manager.post(`/api/warranty-claims/${encodeURIComponent(opened.json.id)}/resolve`, {
      resolution: 'PAID_REPAIR', fault_found: 'Heating element failed. Replaced and charged to the customer.',
      cost_to_business: 12000, resolution_notes: 'Customer paid ₦35,000 at the counter for parts and labour.',
    });
    assert.ok(resolved.status < 400,
      `resolving the out-of-warranty claim as a paid repair answered ${resolved.status}: ${String(resolved.text).slice(0, 300)}. This is the outcome the schema did not have an entry for: the old CHECK constraint permitted REPAIR/REPLACE/REFUND/REJECT/OUT_OF_WARRANTY and the API writes REPAIRED/REPLACED/REFUNDED/REJECTED/SUPPLIER_RETURN/PAID_REPAIR — not one value in common, so EVERY resolution this route accepted was refused by SQLite and the whole flow answered 400 CHECK_FAILED`);
  });

  // ===================================================================
  // BACK TO FRONT — THE BOOKS OF CLAIMS
  // ===================================================================
  audit.section('Reading it all back');

  await audit.checkAsync('the list answers the questions a service desk asks', async () => {
    const all = await owner.get('/api/warranty-claims?status=CLOSED&limit=200');
    const rows = all.json.data || [];
    assert.ok(rows.length >= 3, `the closed board holds ${rows.length} claim(s) against three resolved`);
    // ASKED FOR THE CLOSED BOARD: the default list is open claims only, and every claim this
    // run opened is now closed. Searching the open board and reporting "not found" would be
    // the audit reading its own filter rather than the product.
    const searched = await owner.get(`/api/warranty-claims?status=CLOSED&q=${encodeURIComponent(replaceClaim.claimNo)}&limit=20`);
    assert.equal((searched.json.data || []).length, 1, `searching for ${replaceClaim.claimNo} found ${(searched.json.data || []).length} claim(s)`);
    const bySerial = await owner.get(`/api/warranty-claims?status=CLOSED&q=${encodeURIComponent(SERIAL(1))}&limit=20`);
    assert.ok((bySerial.json.data || []).length >= 1, `searching the claims by serial ${SERIAL(1)} found none`);

    const covered = await owner.get('/api/warranty-claims?in_warranty=1&status=CLOSED&limit=200');
    for (const row of (covered.json.data || [])) {
      assert.equal(Number(row.in_warranty), 1, `a claim filtered as in-warranty carries in_warranty=${row.in_warranty}`);
    }
    const outOfCover = await owner.get('/api/warranty-claims?status=CLOSED&limit=200');
    const paid = (outOfCover.json.data || []).filter((r) => String(r.resolution) === 'PAID_REPAIR')[0];
    assert.ok(paid, 'the paid repair is not on the closed board');
    assert.equal(Number(paid.in_warranty), 0, 'the paid repair is recorded as in warranty');
  });

  await audit.checkAsync('the repair left the unit’s own record able to answer a counter question', async () => {
    const res = await owner.get(`/api/serials/${encodeURIComponent(SERIAL(1))}`);
    assert.equal(Number(res.json.serial.claim_count), 1, `the repaired unit reports ${res.json.serial.claim_count} claim(s)`);
    assert.equal(String(res.json.serial.latest_claim_status), 'CLOSED', `the repaired unit's claim is ${res.json.serial.latest_claim_status}`);
    assert.equal(res.json.inWarranty, true, 'the repaired unit is still under its original cover and the lookup says otherwise');
  });

  await audit.checkAsync('the sale carried by a refunded unit records the refund', async () => {
    // THE REFUND BRANCH ANNOTATES THE ORIGINAL SALE, and the annotation is what a shop reads
    // when the customer comes back about the money. It is checked last because the refund is
    // the one resolution that reaches back past the claim.
    const opened = await manager.post('/api/warranty-claims', {
      branch_id: branch.id, customer_id: customer.id, serial_no: SERIAL(3),
      fault_reported: 'The replacement unit failed as well — customer has asked for their money back.',
    });
    assert.ok(opened.status < 400, `opening the refund claim answered ${opened.status}: ${String(opened.text).slice(0, 240)}`);
    const resolved = await manager.post(`/api/warranty-claims/${encodeURIComponent(opened.json.id)}/resolve`, {
      resolution: 'REFUNDED', fault_found: 'Second unit failed; refund agreed with the customer.',
      cost_to_business: 250000, resolution_notes: 'Refunded in full at the counter, unit returned to stock as defective.',
    });
    assert.ok(resolved.status < 400, `resolving as REFUNDED answered ${resolved.status}: ${String(resolved.text).slice(0, 300)}`);

    const sale = await owner.get(`/api/sales/${encodeURIComponent(secondSale.id)}`);
    assert.equal(sale.status, 200, `the sale answered ${sale.status}`);
    const notes = String((sale.json.sale && sale.json.sale.notes) || sale.json.notes || '');
    assert.ok(notes.includes(opened.json.claimNo),
      `the sale the replaced unit came from does not mention the refund (claim ${opened.json.claimNo}). The customer asking "when was I refunded" has to be answerable from the sale`);
  });
}, {
  setup: () => startDeployment({
    label: 'warranty',
    businesses: [{
      name: 'Warranty Audit Appliances', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [{ name: 'Warranty Audit Branch', code: 'WAR-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 60000 }],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'war-manager', pin: '60701', branchIndex: 0, full_name: 'Warranty Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'war-staff', pin: '60702', branchIndex: 0, full_name: 'Warranty Audit Counter' },
    ],
  }),
});
