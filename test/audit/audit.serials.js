'use strict';
// =====================================================================
// test/audit/audit.serials.js — THE SERIAL REGISTER, AND HOW A UNIT'S STORY STARTS
// =====================================================================
// `tools/flow-coverage.js` listed warranty-claims at 0/3. Auditing the claims routes is
// what this stage set out to do, and the first thing found was that no claim could exist:
// `POST /api/warranty-claims` needs a serial number on file, and NOTHING IN THE PRODUCT
// COULD PUT ONE THERE.
//
//   * `serial_numbers` had no writer anywhere in the server — not goods-received, not a
//     purchase-order receipt, not a transfer. The only INSERTs in the repository were in a
//     test. The schema's own comment says a serial is what makes a warranty provable two
//     years later; there was no way to record one.
//   * The sale engine demands one serial per unit for a serial-tracked product and refuses
//     any serial "not in this system", so a serial-tracked product could be received as
//     anonymous quantity and then NEVER SOLD AT ALL.
//   * `serial_tracking_enabled` — "Capture serial numbers for products that track them" —
//     was shown to every administrator and read by nothing, so switching it off changed
//     nothing and switching it on did nothing either.
//
// So this audit proves the beginning of the chain, in both directions:
//
//   FRONT TO BACK  flag a product as serial-tracked → receive it → the register holds one
//                  row per unit, each with the batch it came in on and a first link in its
//                  hash chain → sell one → it leaves as SOLD against a receipt and a
//                  customer, with the warranty dates the sale started.
//   BACK TO FRONT  read the register (filtered, counted), read the unit by its own number,
//                  read the chain length, and read the warranty clock off the register
//                  rather than off a claim.
//   AND THE REFUSALS a receipt with no serials, with the wrong NUMBER of serials, with the
//                  same serial twice, with a serial already on file, with serials for a
//                  product that does not track them; a sale with no serial, with a serial
//                  that does not exist, and a second sale of a unit already sold.
//   AND THE SWITCH the feature switched off means both halves stop demanding serials — the
//                  trap this used to be, where a flagged product could not be received or
//                  sold, and the setting that was supposed to control it controlled nothing.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `₦${round2(n).toLocaleString('en-NG')}`;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
// A serial that no other run, and no other shop, can be holding.
const MARK = Date.now().toString(36).toUpperCase().slice(-6);
const SERIAL = (n) => `AUD-${MARK}-${String(n).padStart(3, '0')}`;

runAudit('serials', async (audit, d) => {
  const owner = d.owner || d.admin;
  const manager = (d.seats && d.seats.manager) || null;
  const staff = (d.seats && d.seats.staff) || null;
  if (!manager || !staff) throw new Error('the serials fixture needs a MANAGER seat (goods-received is MANAGER+) and a STAFF seat to try it with');
  const branch = (d.branches || [])[0];
  assert.ok(branch, 'the serials fixture has no branch to receive at');

  // ===================================================================
  // A PRODUCT THAT IDENTIFIES EACH UNIT
  // ===================================================================
  const product = await audit.captureAsync('a serial-tracked appliance to receive and sell', async () => {
    const res = await manager.post('/api/products', {
      name: `Audit Serialised Freezer ${MARK}`,
      sku: `AUD-SER-${MARK}`,
      base_unit_name: 'piece',
      cost_price: 180000, selling_price: 250000,
      warranty_months: 12, warranty_type: 'CARRY_IN',
      requires_serial: 1, is_returnable: 1, return_window_days: 7,
    });
    assert.ok(res.status < 400, `creating a serial-tracked product answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const id = res.json.id || (res.json.product && res.json.product.id);
    assert.ok(id, 'the product was created and the answer carries no id');
    // A PRODUCT THIS RUN CREATED IS A PRODUCT THIS RUN REMOVES. On a live deployment the
    // catalogue belongs to somebody, and an "Audit Serialised Freezer" left on it is a
    // fixture on a client's shelf. DELETE refuses while stock remains, which is why it is
    // tried at the end (after the units are sold) and the outcome is reported either way.
    d.trackRestore(`product ${MARK}`, async () => {
      const del = await manager.del(`/api/products/${encodeURIComponent(id)}`);
      if (del.status < 300 || del.status === 404) return true;
      const off = await manager.put(`/api/products/${encodeURIComponent(id)}`, { is_active: 0 });
      return off.status < 300;
    });
    return { id, name: `Audit Serialised Freezer ${MARK}` };
  });
  const price = 250000;

  const customerName = `Serial Audit Customer ${MARK}`;
  const customer = await audit.captureAsync('a customer to buy a unit', async () => {
    const res = await owner.post('/api/customers', {
      name: customerName, phone: `0808${String(Date.now()).slice(-7)}`,
      customer_type: 'INDIVIDUAL', address: '4 Serial Close, Wuse 2, Abuja',
    });
    assert.ok(res.status < 400, `creating the customer answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const id = res.json.id || (res.json.customer && res.json.customer.id);
    assert.ok(id, 'the customer was created and the answer carries no id');
    d.trackCustomer(id);
    return { id, name: customerName };
  });

  // ===================================================================
  // FRONT TO BACK — THE GOODS ARRIVE AND THE UNITS GET THEIR NUMBERS
  // ===================================================================
  audit.section('Three freezers arrive, and each one leaves the van with a number');

  await audit.checkAsync('a STAFF member cannot receive stock at all, so no serial is filed by a cashier', async () => {
    const res = await staff.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 1, unit_code: 'PIECE', cost_price: 180000,
      serials: [SERIAL(1)],
    });
    assert.equal(res.status, 403, `a STAFF member received stock: ${res.status} ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'ROLE_REQUIRED', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('a receipt with no serial numbers is refused, and asks for them by count', async () => {
    const res = await manager.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 3, unit_code: 'PIECE', cost_price: 180000,
      batch_no: `NO-SERIALS-${MARK}`,
    });
    assert.equal(res.status, 400,
      `receiving three serial-tracked units with no serial numbers answered ${res.status}. If this is allowed the shop has stock it can never sell: the till demands one serial per unit and refuses a number that is not on file, so the goods sit on the shelf until somebody finds this form again`);
    assert.equal(res.json.code, 'SERIALS_REQUIRED', `the refusal came back as ${res.json.code}`);
    assert.ok(/3 expected/i.test(String(res.json.error || res.json.message || '')),
      `the refusal does not say how many were expected: ${String(res.json.error || res.json.message).slice(0, 200)}`);
  });

  await audit.checkAsync('a receipt with the wrong NUMBER of serials is refused too', async () => {
    const res = await manager.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 3, unit_code: 'PIECE', cost_price: 180000,
      serials: [SERIAL(1), SERIAL(2)],
    });
    assert.equal(res.status, 400, `two serials for three units answered ${res.status}`);
    assert.equal(res.json.code, 'SERIALS_REQUIRED', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('the same serial twice in one delivery is refused before anything is written', async () => {
    const res = await manager.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 2, unit_code: 'PIECE', cost_price: 180000,
      serials: [SERIAL(1), SERIAL(1)],
    });
    assert.equal(res.status, 400, `the same serial twice answered ${res.status}`);
    assert.equal(res.json.code, 'DUPLICATE_SERIAL_IN_REQUEST', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('serials for a product that does not track them are refused', async () => {
    const plain = await audit.captureAsync('an ordinary product, to try serials on', async () => {
      const res = await manager.post('/api/products', {
        name: `Audit Plain Item ${MARK}`, sku: `AUD-PLN-${MARK}`,
        base_unit_name: 'piece', cost_price: 1000, selling_price: 1500,
      });
      assert.ok(res.status < 400, `creating an ordinary product answered ${res.status}`);
      const id = res.json.id || (res.json.product && res.json.product.id);
      d.trackRestore(`product plain ${MARK}`, async () => {
        const del = await manager.del(`/api/products/${encodeURIComponent(id)}`);
        return del.status < 300 || del.status === 404;
      });
      return { id };
    });
    const res = await manager.post('/api/stock/receive', {
      branch_id: branch.id, product_id: plain.id, quantity: 1, unit_code: 'PIECE', cost_price: 1000,
      serials: [SERIAL(9)],
    });
    assert.equal(res.status, 400, `serials on an ordinary product answered ${res.status}`);
    assert.equal(res.json.code, 'SERIALS_NOT_EXPECTED', `the refusal came back as ${res.json.code}`);
  });

  const receipt = await audit.captureAsync('three freezers received, one serial each', async () => {
    const res = await manager.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id,
      quantity: 3, unit_code: 'PIECE', cost_price: 180000, freight_cost: 45000,
      batch_no: `SER-${MARK}`, selling_price: price,
      // The phone-shaped form: a plain string, or an object with its second identity.
      serials: [SERIAL(1), { serial_no: SERIAL(2), imei: `35${String(Date.now()).slice(-13)}` }, SERIAL(3)],
    });
    assert.ok(res.status < 400, `receiving three units with their serials answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    assert.equal(Number(res.json.serialCount), 3,
      `the receipt filed ${res.json.serialCount} serial number(s) for three units — the register and the delivery must agree, or a unit on the shelf has no identity`);
    assert.equal((res.json.serials || []).length, 3, `the receipt echoed ${(res.json.serials || []).length} serial(s)`);
    return { batchId: res.json.batchId, serials: res.json.serials };
  });

  await audit.checkAsync('receiving the same serial again is refused, and names where it already is', async () => {
    const res = await manager.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 1, unit_code: 'PIECE', cost_price: 180000,
      serials: [SERIAL(1)],
    });
    assert.equal(res.status, 409,
      `a second goods-received of ${SERIAL(1)} answered ${res.status}. Two rows for one serial is either a double-receipt or a duplicated label, and both end with two units claiming one warranty`);
    assert.equal(res.json.code, 'SERIAL_ALREADY_RECEIVED', `the refusal came back as ${res.json.code}`);
    assert.ok(String(res.json.error || res.json.message || '').includes(SERIAL(1)),
      'the refusal does not name the serial that is already on file');
  });

  // ===================================================================
  // BACK TO FRONT — THE REGISTER ANSWERS FOR THE UNITS IT HOLDS
  // ===================================================================
  audit.section('The register: what the shop has identified, and where each unit is');

  await audit.checkAsync('the register lists one row per unit, un-sold, with the batch it came in on', async () => {
    const res = await owner.get(`/api/serials?product_id=${encodeURIComponent(product.id)}&limit=50`);
    assert.equal(res.status, 200, `the register answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const rows = res.json.data || [];
    assert.equal(rows.length, 3, `the register lists ${rows.length} unit(s) of a product that was received three times`);
    for (const n of [1, 2, 3]) {
      const row = rows.filter((r) => String(r.serial_no) === SERIAL(n))[0];
      assert.ok(row, `${SERIAL(n)} is not in the register — a goods receipt that files a serial nobody can find again is a number in a table, not a record of a unit`);
      assert.equal(row.sale_id == null || row.receipt_no == null, true, `${SERIAL(n)} is listed as sold before it was`);
      assert.equal(String(row.status), 'IN_STOCK', `${SERIAL(n)} is listed ${row.status}, not IN_STOCK`);
      assert.equal(String(row.batch_id || ''), String(receipt.batchId), `${SERIAL(n)} is not filed against the batch it arrived on`);
      assert.ok(row.batch_no, `${SERIAL(n)} has no batch number to show`);
      assert.equal(String(row.branch_id), String(branch.id), `${SERIAL(n)} is filed at the wrong branch`);
    }
    assert.equal(Number(res.json.counts.unsold), 3, `the register counts ${res.json.counts.unsold} un-sold units against three on the shelf`);
    assert.equal(Number(res.json.counts.sold), 0, `the register counts ${res.json.counts.sold} sold units before anything was sold`);
  });

  await audit.checkAsync('a unit can be looked up by its own number, and answers where it is', async () => {
    const res = await owner.get(`/api/serials/${encodeURIComponent(SERIAL(2))}`);
    assert.equal(res.status, 200, `the serial lookup answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const s = res.json.serial;
    assert.equal(String(s.serial_no), SERIAL(2), `the lookup for ${SERIAL(2)} answered about ${s.serial_no}`);
    assert.equal(String(s.product_id), String(product.id), 'the lookup answered about another product');
    assert.equal(s.in_warranty == null ? false : true, false, 'a unit that has not been sold is not under warranty yet');
    assert.ok(/not yet sold/i.test(String(res.json.message)),
      `the lookup does not say the unit is still in stock: ${res.json.message}`);
  });

  await audit.checkAsync('the IMEI came through on the unit that had one', async () => {
    const res = await owner.get(`/api/serials/${encodeURIComponent(SERIAL(2))}`);
    assert.ok(res.json.serial.imei,
      'the IMEI given at receipt is not on the unit. For a phone or an appliance it is the second identity — the one the networks and the police ask for');
    const search = await owner.get(`/api/serials?q=${encodeURIComponent(res.json.serial.imei)}&limit=10`);
    assert.equal((search.json.data || []).length, 1, `searching the register by IMEI found ${(search.json.data || []).length} unit(s)`);
  });

  await audit.checkAsync('searching the register finds a unit by a fragment of its number', async () => {
    const res = await owner.get(`/api/serials?q=${encodeURIComponent(`AUD-${MARK}-00`)}&limit=50`);
    assert.equal(res.status, 200, `the register search answered ${res.status}`);
    assert.ok((res.json.data || []).length >= 3, `searching for a shared prefix found ${(res.json.data || []).length} unit(s) of three`);
  });

  await audit.checkAsync('each unit carries the first link of its own history', async () => {
    const res = await owner.get(`/api/serials?product_id=${encodeURIComponent(product.id)}&limit=50`);
    const row = (res.json.data || []).filter((r) => String(r.serial_no) === SERIAL(1))[0];
    assert.ok(row, `${SERIAL(1)} is not in the register`);
    assert.equal(Number(row.event_count), 1,
      `the unit has ${row.event_count} event(s) in its chain — a unit that was received has exactly one, and a chain that starts at the sale cannot show where the unit came from`);
  });

  // ===================================================================
  // FRONT TO BACK — ONE UNIT LEAVES, AND ITS STORY GROWS A LINK
  // ===================================================================
  audit.section('One freezer goes over the counter, and its warranty starts');

  await audit.checkAsync('a sale without the serial is refused, and names how many are needed', async () => {
    const res = await manager.post('/api/sales', {
      branch_id: branch.id, customer_id: customer.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: price, cash_tendered: price }],
    }, { idempotencyKey: `ser-no-serial-${MARK}` });
    assert.ok(res.status >= 400,
      `a serial-tracked unit was sold with no serial number: ${res.status} ${String(res.text).slice(0, 240)}. The unit would leave with nothing tying it to a warranty or to a customer`);
    assert.equal(res.json.code, 'SALE_PREPARATION_FAILED', `the refusal came back as ${res.json.code}`);
    const problems = res.json.problems || res.json.fields || [];
    assert.ok(JSON.stringify(problems).includes('SERIALS_REQUIRED') || JSON.stringify(res.json).includes('serial-tracked'),
      `the refusal does not say that a serial number is what is missing: ${JSON.stringify(problems).slice(0, 240)}`);
  });

  await audit.checkAsync('a serial that is not on file is refused — the till does not invent one', async () => {
    const res = await manager.post('/api/sales', {
      branch_id: branch.id, customer_id: customer.id,
      lines: [{ product_id: product.id, quantity: 1, serial_numbers: [`NOT-ON-FILE-${MARK}`] }],
      payments: [{ method: 'CASH', amount: price, cash_tendered: price }],
    }, { idempotencyKey: `ser-ghost-${MARK}` });
    assert.ok(res.status >= 400,
      `a unit was sold against a serial that is not in the system: ${res.status}. That is how a stolen or parallel-imported unit is laundered into a warranty`);
    assert.ok(String(res.text).includes('NOT-ON-FILE') || String(res.text).includes('not in this system'),
      `the refusal does not name the serial or say it is unknown: ${String(res.text).slice(0, 240)}`);
  });

  const sale = await audit.captureAsync('one freezer sold over the counter, by serial', async () => {
    const res = await manager.post('/api/sales', {
      branch_id: branch.id, customer_id: customer.id,
      lines: [{ product_id: product.id, quantity: 1, serial_numbers: [SERIAL(1)] }],
      payments: [{ method: 'CASH', amount: price, cash_tendered: price }],
      device_id: 'audit-serials',
    }, { idempotencyKey: `ser-sale-${MARK}` });
    assert.ok(res.status < 400, `the sale answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    assert.ok(res.json.receiptNo || res.json.receipt_no, 'the sale answered without a receipt number');
    return { id: res.json.id || res.json.saleId, receiptNo: res.json.receiptNo || res.json.receipt_no };
  });

  await audit.checkAsync('the unit left as SOLD, against the receipt, the customer and the counter', async () => {
    const res = await owner.get(`/api/serials/${encodeURIComponent(SERIAL(1))}`);
    const s = res.json.serial;
    assert.equal(String(s.status), 'SOLD', `${SERIAL(1)} is ${s.status} after being sold`);
    assert.equal(String(s.receipt_no), String(sale.receiptNo), `${SERIAL(1)} is against receipt ${s.receipt_no}, not the ${sale.receiptNo} it was sold on`);
    assert.equal(String(s.customer_id), String(customer.id), `${SERIAL(1)} is not against the customer who bought it`);
    assert.equal(String(s.sold_at).slice(0, 10), day(0), `${SERIAL(1)} was sold at ${s.sold_at}`);
    assert.equal(res.json.inWarranty, true,
      `${SERIAL(1)} is not under warranty the day it was sold, against ${s.warranty_months} months on the product. Warranty is read off the unit, and a customer turned away on day one is the claim this register exists to prevent`);
    assert.equal(String(s.warranty_starts_at).slice(0, 10), day(0), `the warranty starts ${s.warranty_starts_at}`);
    assert.equal(String(s.warranty_ends_at).slice(0, 10), day(365), `the warranty ends ${s.warranty_ends_at} against a 12-month term from today`);
    assert.ok(Number(res.json.daysOfWarrantyLeft) >= 364, `the lookup says ${res.json.daysOfWarrantyLeft} day(s) of cover are left`);
  });

  await audit.checkAsync('the unit’s chain now holds the receipt AND the sale', async () => {
    const res = await owner.get(`/api/serials?product_id=${encodeURIComponent(product.id)}&limit=50`);
    const row = (res.json.data || []).filter((r) => String(r.serial_no) === SERIAL(1))[0];
    assert.equal(Number(row.event_count), 2,
      `the sold unit has ${row.event_count} event(s) in its chain and should have two — received, then sold. The chain is what makes a unit's history evidence rather than a claim`);
  });

  await audit.checkAsync('the register now counts one sold and two still on the shelf', async () => {
    const res = await owner.get(`/api/serials?product_id=${encodeURIComponent(product.id)}&limit=50`);
    assert.equal(Number(res.json.counts.sold), 1, `the register counts ${res.json.counts.sold} sold`);
    assert.equal(Number(res.json.counts.unsold), 2, `the register counts ${res.json.counts.unsold} un-sold`);
    assert.equal(Number(res.json.counts.in_warranty), 1, `the register counts ${res.json.counts.in_warranty} unit(s) in warranty`);
    const soldFilter = await owner.get(`/api/serials?product_id=${encodeURIComponent(product.id)}&sold=yes&limit=50`);
    assert.equal((soldFilter.json.data || []).length, 1, `filtering for sold units found ${(soldFilter.json.data || []).length}`);
    const unsoldFilter = await owner.get(`/api/serials?product_id=${encodeURIComponent(product.id)}&sold=no&limit=50`);
    assert.equal((unsoldFilter.json.data || []).length, 2, `filtering for un-sold units found ${(unsoldFilter.json.data || []).length}`);
  });

  await audit.checkAsync('selling the same unit twice is refused', async () => {
    const res = await manager.post('/api/sales', {
      branch_id: branch.id, customer_id: customer.id,
      lines: [{ product_id: product.id, quantity: 1, serial_numbers: [SERIAL(1)] }],
      payments: [{ method: 'CASH', amount: price, cash_tendered: price }],
    }, { idempotencyKey: `ser-double-${MARK}` });
    assert.ok(res.status >= 400,
      `the same unit was sold twice: ${res.status}. One unit, two warranties, two customers — and the second one finds out at the counter`);
    assert.ok(/already/i.test(String(res.text)), `the refusal does not say the unit is already sold: ${String(res.text).slice(0, 240)}`);
  });

  // ===================================================================
  // THE OTHER INTAKE — GOODS BOUGHT ON A PURCHASE ORDER
  // ===================================================================
  // Two routes receive goods, and the first version of this capture lived in only one of
  // them: the direct goods-received route, which is what a shop uses when a load arrives
  // with no paperwork. Appliances are bought on a purchase order, so the ordinary path was
  // the one still unable to register a unit — the same dead end one route over.
  audit.section('The same numbers, arriving against an order');

  await audit.checkAsync('a purchase-order receipt without serials is refused, and a line with them is filed', async () => {
    const supplier = await audit.captureAsync('a supplier to order from', async () => {
      const res = await owner.post('/api/suppliers', {
        name: `Serial Audit Supplier ${MARK}`, phone: `0809${String(Date.now()).slice(-7)}`,
        supplier_type: 'DISTRIBUTOR', payment_terms_days: 30,
      });
      assert.ok(res.status < 400, `creating the supplier answered ${res.status}: ${String(res.text).slice(0, 200)}`);
      const id = res.json.id || (res.json.supplier && res.json.supplier.id);
      assert.ok(id, 'the supplier was created and the answer carries no id');
      d.trackSupplier(id);
      return { id };
    });

    const po = await audit.captureAsync('a purchase order for two freezers', async () => {
      const res = await manager.post('/api/purchase-orders', {
        branch_id: branch.id, supplier_id: supplier.id,
        items: [{ product_id: product.id, quantity: 2, expected_unit_cost: 185000 }],
        notes: 'Serial audit — received with serial numbers.',
      });
      assert.ok(res.status < 400, `raising the purchase order answered ${res.status}: ${String(res.text).slice(0, 240)}`);
      const id = res.json.id || res.json.purchase_order_id || (res.json.purchase_order && res.json.purchase_order.id);
      assert.ok(id, 'the order was raised and the answer carries no id');
      return { id, number: res.json.po_number || res.json.poNumber || null };
    });

    const lines = await audit.captureAsync('the order read back with its line', async () => {
      const res = await owner.get(`/api/purchase-orders/${encodeURIComponent(po.id)}`);
      const items = res.json.items || res.json.data || [];
      assert.ok(Array.isArray(items) && items.length === 1, `the order read back with ${Array.isArray(items) ? items.length : 'no'} line(s)`);
      return items[0];
    });

    const noSerials = await manager.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/receive`, {
      receipts: [{ item_id: lines.id, quantity_received: 2 }], on_credit: 370000,
    });
    assert.equal(noSerials.status, 400,
      `receiving two serial-tracked units against an order with no serial numbers answered ${noSerials.status}. Appliances are bought on orders, so this is the path a shop actually uses — and stock that arrives here has to be sellable`);
    assert.equal(noSerials.json.code, 'SERIALS_REQUIRED', `the refusal came back as ${noSerials.json.code}`);

    const res = await manager.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/receive`, {
      receipts: [{ item_id: lines.id, quantity_received: 2, serials: [SERIAL(11), SERIAL(12)] }],
      on_credit: 370000,
    });
    assert.ok(res.status < 400, `receiving the order with its serials answered ${res.status}: ${String(res.text).slice(0, 300)}`);
    assert.equal(Number(res.json.serialCount), 2, `the receipt filed ${res.json.serialCount} serial number(s) for two units`);

    const register = await owner.get(`/api/serials?product_id=${encodeURIComponent(product.id)}&q=${encodeURIComponent(SERIAL(11))}&limit=10`);
    const row = (register.json.data || [])[0];
    assert.ok(row, `${SERIAL(11)} was received against a purchase order and is not in the register`);
    assert.equal(String(row.status), 'IN_STOCK', `${SERIAL(11)} came in as ${row.status}`);
    assert.equal(String(row.branch_id), String(branch.id), `${SERIAL(11)} is filed at the wrong branch`);
    assert.equal(Number(row.event_count), 1, `${SERIAL(11)} has ${row.event_count} event(s) in its chain and should have exactly one`);
  });

  // ===================================================================
  // THE SWITCH — WHAT TURNING SERIAL CAPTURE OFF HAS TO MEAN
  // ===================================================================
  audit.section('The switch in Settings, which used to control nothing');

  const switchedOff = await audit.captureAsync('serial capture switched off for the deployment', async () => {
    if (d.live && !d.writable) return null;
    const was = d.settings || {};
    d.trackRestore('serial capture setting', async () => {
      const back = await owner.put('/api/settings', { serial_tracking_enabled: Number(was.serial_tracking_enabled) === 0 ? 0 : 1 });
      return back.status < 300;
    });
    const res = await owner.put('/api/settings', { serial_tracking_enabled: 0 });
    assert.equal(res.status, 200, `switching serial capture off answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    return true;
  });

  if (switchedOff) {
    await audit.checkAsync('with the switch off, a serial-tracked product is received and sold as ordinary stock', async () => {
      // BOTH HALVES. The demand for serials lives in two places — the goods receipt and the
      // sale engine — and a switch that turns off only one of them is the trap this was
      // before: received with no serials, then refused at the till for not having them.
      const inRes = await owner.post('/api/stock/receive', {
        branch_id: branch.id, product_id: product.id, quantity: 1, unit_code: 'PIECE', cost_price: 180000,
        batch_no: `SWITCH-OFF-${MARK}`,
      });
      assert.ok(inRes.status < 400,
        `with serial capture switched off, receiving a serial-tracked product answered ${inRes.status}: ${String(inRes.text).slice(0, 240)}. A shop that has decided not to identify units individually has to be able to receive its stock`);
      assert.equal(Number(inRes.json.serialCount || 0), 0, 'serials were filed with the feature switched off');

      const saleRes = await owner.post('/api/sales', {
        branch_id: branch.id, customer_id: customer.id,
        lines: [{ product_id: product.id, quantity: 1 }],
        payments: [{ method: 'CASH', amount: price, cash_tendered: price }],
      }, { idempotencyKey: `ser-off-sale-${MARK}` });
      assert.ok(saleRes.status < 400,
        `with serial capture switched off, selling the product answered ${saleRes.status}: ${String(saleRes.text).slice(0, 240)}. The unit must be sellable — the alternative is stock on the shelf that the till refuses to sell`);
      audit.note('with the switch off the product was received and sold with no serial, as the setting says');
    });
  }

  await audit.checkAsync('switching it back on restores the demand on both halves', async () => {
    const back = await (d.admin || owner).put('/api/settings', {
      serial_tracking_enabled: Number((d.settings || {}).serial_tracking_enabled) === 0 ? 0 : 1,
    });
    const res = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 1, unit_code: 'PIECE', cost_price: 180000,
      batch_no: `SWITCH-BACK-${MARK}`,
    });
    assert.equal(res.status, 400,
      `with serial capture switched back on, a serial-tracked receipt without serials answered ${res.status} — the demand did not come back, so switching the feature on does nothing`);
    assert.equal(res.json.code, 'SERIALS_REQUIRED', `the refusal came back as ${res.json.code}`);
    if (back.status >= 300) audit.note(`switching the setting back answered ${back.status} — the restore at the end of the run will try again`);
  });
}, {
  setup: () => startDeployment({
    label: 'serials',
    businesses: [{
      name: 'Serial Audit Appliances', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [{ name: 'Serial Audit Branch', code: 'SER-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 50000 }],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'ser-manager', pin: '60601', branchIndex: 0, full_name: 'Serial Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'ser-staff', pin: '60602', branchIndex: 0, full_name: 'Serial Audit Counter' },
    ],
  }),
});
