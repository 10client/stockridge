'use strict';
// =====================================================================
// test/audit/audit.createFlows.js — THE THREE DOORS THAT MAKE A DEPLOYMENT
// =====================================================================
// `POST /api/businesses`, `POST /api/branches` and `POST /api/users` are the only routes a
// brand-new client uses before they can do anything else, and all three were reported broken from
// the screen: "while creating staffs and branch and business it is either name required or
// something — cross check the flow and fully align it from the front to the back end". And
// receiving a purchase order for a serial-tracked product "popped and there is no input for serial
// number".
//
// Every one of those three complaints was real, and every one was a place where the message the
// screen showed disagreed with what the database did:
//
//   * the business message counted `result.summary`, which does not exist, so a working
//     provisioning run reported "0 categories, 0 ledger accounts, 0 customer classes, 0 starter
//     products" while the rows were all there;
//   * the role chooser offered an owner "Owner" and "Administrator" — both refused by the route —
//     and a branch field labelled "owner or admin only" that left STAFF creates without the branch
//     the route requires;
//   * the receive form had no box for serial numbers at all, so the delivery the route demands
//     numbers for could not be recorded, and the refusal arrived with nowhere to type.
//
// So this audit walks the three creates and the serial receipt in BOTH directions, and its
// sharpest assertions are the ones that compare a sentence to the rows it claims to describe:
// a message that lies about a working database is worse than an error, because the next thing the
// administrator does is look for what went missing.
// =====================================================================

const path = require('node:path');
const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const TAG = Date.now().toString(36).slice(-5).toUpperCase();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

runAudit('createFlows', async (audit, d) => {
  const admin = d.admin;
  const owner = d.owner || d.admin;
  const manager = d.seats.manager || owner;
  const branch = d.branchFor(owner) || d.branches[0];
  assert.ok(admin, 'this audit needs the deployment administrator seat');
  assert.ok(owner, 'this audit needs an owner seat');

  // ------------------------------------------------------------------
  // FRONT TO BACK — A BUSINESS, AND A SENTENCE THAT MATCHES THE ROWS
  // ------------------------------------------------------------------
  const made = await audit.captureAsync('an administrator creates a business from the form\'s own fields', async () => {
    const listBefore = await admin.get('/api/businesses?limit=50');
    const before = ((listBefore.json && listBefore.json.data) || []).length;
    const res = await admin.post('/api/businesses', {
      name: `Audit Co ${TAG}`,
      legal_name: `Audit Co ${TAG} Ltd`,
      profile_code: 'ELECTRONICS',
      branch: { name: `Audit Co ${TAG} — Main`, city: 'Abuja', state: 'FCT' },
    });
    assert.ok(res.status < 400, `creating a business answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    return { id: res.json.id, message: String(res.json.message || ''), before };
  });

  await audit.checkAsync('the new business is listed, and it was provisioned with real rows', async () => {
    const res = await admin.get('/api/businesses?limit=50');
    const rows = (res.json && res.json.data) || [];
    assert.equal(rows.length, made.before + 1, `the business list went from ${made.before} to ${rows.length}`);
    assert.ok(rows.some((b) => String(b.id) === String(made.id)), 'the business that was just created is not in the list');
  });

  // THE SENTENCE IS THE FEATURE. The route used to read a field the service never returns, and the
  // administrator was told a working provisioning run had provisioned nothing. Every number the
  // message claims is now compared to the rows that exist — counted through the API, scoped to the
  // new business, exactly as the app's own screens count them.
  await audit.checkAsync('every count in the message equals the rows that actually exist', async () => {
    const counters = [
      { label: 'categories', table: 'categories', url: `/api/categories?business_id=${made.id}&limit=200` },
      { label: 'ledger accounts', table: 'gl_accounts', url: `/api/accounting/accounts?business_id=${made.id}&limit=500` },
      { label: 'customer classes', table: 'customer_classes', url: `/api/customer-classes?business_id=${made.id}&limit=200` },
      { label: 'starter products', table: 'products', url: `/api/products?business_id=${made.id}&limit=200` },
    ];
    for (const c of counters) {
      const claimed = Number((new RegExp(`(\\d+) ${c.label}`).exec(made.message) || [])[1]);
      assert.ok(Number.isFinite(claimed), `the message never names ${c.label}: "${made.message}"`);
      const res = await admin.get(c.url);
      const rows = (res.json && res.json.data) || [];
      assert.equal(claimed, rows.length,
        `the message says ${claimed} ${c.label} and ${c.table} holds ${rows.length} — a sentence about a working database must be true`);
      assert.ok(rows.length > 0, `${c.label} came back empty — the vertical provisioned nothing`);
    }
    // A vertical that seeds no products exists (GENERAL_RETAIL), so the products line is only
    // asserted when the message claims a non-zero number. It did, above.
    assert.ok(/with its first branch/.test(made.message), `the message does not name the branch it built: "${made.message}"`);
  });

  // ------------------------------------------------------------------
  // FRONT TO BACK — A BRANCH, AND THE CODE IT DERIVES
  // ------------------------------------------------------------------
  // THE BUSINESS IS NAMED, NOT GUESSED. The route has always honoured a `business_id` in the body
  // (`resolveBusiness`, scope-checked), but the branch form never sent one — so an owner running
  // several businesses got whichever business the server resolved on its own. The branch is opened
  // here under the business created at the top of this audit, and the row must say so: a branch in
  // the wrong set of books is a branch nobody can find.
  const newBranch = await audit.captureAsync('an owner opens a branch under a named business', async () => {
    const res = await owner.post('/api/branches', {
      name: `Audit Branch ${TAG}`, city: 'Kano', state: 'Kano', business_id: made.id,
    });
    assert.ok(res.status < 400, `opening a branch answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    return { id: res.json.id || (res.json.branch && res.json.branch.id), message: String(res.json.message || '') };
  });

  await audit.checkAsync('the branch is open, named, coded, and filed under the business that was asked for', async () => {
    const res = await owner.get('/api/branches?limit=200');
    const row = ((res.json && res.json.data) || []).find((b) => String(b.id) === String(newBranch.id));
    assert.ok(row, 'the branch that was just opened is not in the branch list');
    assert.ok(row.code, 'the branch has no code — codes appear on receipt numbers and transfer references');
    assert.equal(String(row.is_active), '1', 'a branch created a moment ago is not active');
    assert.equal(String(row.business_id), String(made.id),
      `the branch was filed under ${row.business_name || row.business_id} — not the business that was asked for`);
    assert.ok(/Audit Co/.test(String(row.business_name || '')),
      `the branch names its business as "${row.business_name}" — every branch belongs to one set of books`);
  });

  // ------------------------------------------------------------------
  // FRONT TO BACK — A PERSON, WHO CAN THEN SIGN IN, AND ONLY SEES THEIR BRANCH
  // ------------------------------------------------------------------
  const person = await audit.captureAsync('an owner adds a manager at a known branch', async () => {
    const pin = '7364';
    const res = await owner.post('/api/users', {
      full_name: `Audit Person ${TAG}`, username: `audit${TAG.toLowerCase()}`,
      role: 'MANAGER', branch_id: branch.id, pin, confirm_pin: pin, phone: '08031234567',
    });
    assert.ok(res.status < 400, `adding someone answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    return { id: res.json.id, username: `audit${TAG.toLowerCase()}`, pin, message: String(res.json.message || '') };
  });

  await audit.checkAsync('the person who was just created can sign in with the PIN they were given', async () => {
    const signIn = await fetch(`${d.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: person.username, pin: person.pin }),
    });
    const body = await signIn.json();
    assert.equal(signIn.status, 200, `the new person cannot sign in: ${signIn.status} ${String(JSON.stringify(body)).slice(0, 200)}`);
    assert.ok(body.token, 'signing in answered no token');
    // The sign-in answer carries the client's whole profile under `profile` — deliberately small,
    // and the place the screen reads the role and branch from, so that is what is asserted.
    const profile = body.profile || {};
    assert.equal(String(profile.role), 'MANAGER', `the person was created as ${profile.role}, not the MANAGER that was asked for`);
    assert.equal(String(profile.branchId), String(branch.id), 'the person was created at a different branch from the one asked for');
  });

  // ------------------------------------------------------------------
  // BACK TO FRONT — THE ROLES THE FORM OFFERS MUST BE THE ROLES THE ROUTE TAKES
  // ------------------------------------------------------------------
  await audit.checkAsync('a role the caller could not create is refused, in a sentence that names the rule', async () => {
    const pin = '8361';
    const res = await owner.post('/api/users', {
      full_name: `Audit Owner ${TAG}`, username: `auditown${TAG.toLowerCase()}`,
      role: 'OWNER', branch_id: branch.id, pin, confirm_pin: pin,
    });
    assert.equal(res.status, 403, `an owner creating an owner answered ${res.status}, not 403`);
    assert.equal(res.json && res.json.code, 'ROLE_REQUIRED', `the refusal is coded ${res.json && res.json.code}`);
    assert.ok(/cannot create/i.test(String(res.json.error || res.json.message || '')),
      'the refusal does not say who may create whom');
  });

  await audit.checkAsync('a branch is required of every role but the deployment administrator', async () => {
    const pin = '9283';
    const staffNoBranch = await owner.post('/api/users', {
      full_name: `Audit NoBranch ${TAG}`, username: `auditnb${TAG.toLowerCase()}`,
      role: 'STAFF', pin, confirm_pin: pin,
    });
    assert.equal(staffNoBranch.status, 400, `a staff member with no branch answered ${staffNoBranch.status}, not 400`);
    assert.equal(staffNoBranch.json && staffNoBranch.json.code, 'BRANCH_REQUIRED',
      `the refusal is coded ${staffNoBranch.json && staffNoBranch.json.code}`);

    // ...and the administrator, who has no branch of their own, is allowed one with anybody.
    const pin2 = '6197';
    const asAdmin = await admin.post('/api/users', {
      full_name: `Audit Staff ${TAG}`, username: `auditst${TAG.toLowerCase()}`,
      role: 'STAFF', branch_id: branch.id, pin: pin2, confirm_pin: pin2,
    });
    assert.ok(asAdmin.status < 400,
      `the administrator could not add a staff member: ${asAdmin.status} ${String(asAdmin.text).slice(0, 200)}`);
  });

  // AN OWNER IS NOT PINNED TO A BRANCH. The proprietor is provisioned with branch_id null and
  // reaches every branch by role. The create form used to demand a branch of them anyway, so on
  // a deployment with no branch the chooser was empty and the save said add a branch — even for
  // the owner. A cashier still cannot be created without one; that was asserted just above.
  await audit.checkAsync('an owner can be added with no branch, and reaches every branch', async () => {
    const pin = '4618';
    const username = `auditpr${TAG.toLowerCase()}`;
    const res = await admin.post('/api/users', {
      full_name: `Audit Proprietor ${TAG}`, username, role: 'OWNER',
      business_id: made.id, pin, confirm_pin: pin,
    });
    assert.ok(res.status < 400, `adding an owner with no branch answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.ok(/every branch/i.test(String(res.json && res.json.message || '')),
      `the message does not say an owner reaches every branch: "${res.json && res.json.message}"`);
    const list = await admin.get('/api/users?limit=200');
    const row = ((list.json && list.json.data) || []).find((u) => u.username === username);
    assert.ok(row, 'the owner is not in the staff list');
    assert.ok(row.branch_id == null, `the owner was pinned to ${row.branch_name || row.branch_id} even though none was asked for`);
    assert.equal(String(row.business_id), String(made.id), 'the owner was filed under a different business from the one asked for');
    assert.equal(String(row.role), 'OWNER');
  });

  // ------------------------------------------------------------------
  // FRONT TO BACK — RECEIVING AN ORDER FOR A SERIAL-TRACKED PRODUCT
  // ------------------------------------------------------------------
  // The report was "on receiving a purchase order for a product this popped and there is no input
  // for serial number". The route always demanded one number per unit; the screen had nowhere to
  // type them. Both directions are asserted here: without the numbers the delivery is refused by
  // name, with them the units and the numbers land.
  const serialGoods = await audit.captureAsync('a serial-tracked product, ordered on a purchase order', async () => {
    const list = await manager.get('/api/products?limit=200');
    const pick = ((list.json && list.json.data) || []).find((p) => Number(p.requires_serial) === 1 && Number(p.selling_price) > 0);
    assert.ok(pick, 'the catalogue has no serial-tracked product to receive — the audit cannot prove the flow');
    const sup = await manager.post('/api/suppliers', { name: `Serial Supplies ${TAG}`, phone: '08031234567' });
    assert.ok(sup.status < 400, `adding a supplier answered ${sup.status}: ${String(sup.text).slice(0, 200)}`);
    const po = await manager.post('/api/purchase-orders', {
      supplier_id: sup.json.id, branch_id: branch.id,
      items: [{ product_id: pick.id, quantity: 2, expected_unit_cost: 1500 }],
    });
    assert.ok(po.status < 400, `ordering answered ${po.status}: ${String(po.text).slice(0, 240)}`);
    const detail = await manager.get(`/api/purchase-orders/${po.json.id}`);
    const line = (detail.json.items || [])[0];
    assert.ok(line, 'the order has no line to receive against');
    assert.equal(Number(line.requires_serial), 1,
      'the order line does not say the product is serial-tracked — the receive screen cannot know to ask for numbers');
    return { poId: po.json.id, line, product: pick, supplierId: sup.json.id };
  });

  await audit.checkAsync('serial numbers are a setting, and this check turns them on', async () => {
    const on = await owner.put('/api/settings', { serial_tracking_enabled: 1 });
    assert.equal(on.status, 200, `turning serial numbers on answered ${on.status}: ${String(on.text).slice(0, 180)}`);
  });

  await audit.checkAsync('a delivery of a serial-tracked line with no numbers is refused, and says how many are wanted', async () => {
    const res = await manager.post(`/api/purchase-orders/${serialGoods.poId}/receive`, {
      receipts: [{ item_id: serialGoods.line.id, quantity_received: 2 }],
    });
    assert.equal(res.status, 400, `receiving with no serial numbers answered ${res.status}, not 400`);
    assert.equal(res.json && res.json.code, 'SERIALS_REQUIRED', `the refusal is coded ${res.json && res.json.code}`);
    const said = String(res.json.error || res.json.message || '');
    assert.ok(/serial-tracked/i.test(said), `the refusal does not name the reason: "${said}"`);
    assert.ok(/2 expected/i.test(said), `the refusal does not say how many are expected: "${said}"`);
  });

  await audit.checkAsync('the numbers cannot be filed against a product that has no register', async () => {
    const list = await manager.get('/api/products?limit=200');
    const plain = ((list.json && list.json.data) || []).find((p) => !Number(p.requires_serial) && Number(p.selling_price) > 0);
    assert.ok(plain, 'the catalogue has no ordinary product to contrast with');
    const po = await manager.post('/api/purchase-orders', {
      supplier_id: serialGoods.supplierId, branch_id: branch.id,
      items: [{ product_id: plain.id, quantity: 1, expected_unit_cost: 800 }],
    });
    const detail = await manager.get(`/api/purchase-orders/${po.json.id}`);
    const line = (detail.json.items || [])[0];
    const res = await manager.post(`/api/purchase-orders/${po.json.id}/receive`, {
      receipts: [{ item_id: line.id, quantity_received: 1, serials: ['NOT-TRACKED-1'] }],
    });
    assert.equal(res.status, 400, `a number on an untracked line answered ${res.status}, not 400`);
    assert.equal(res.json && res.json.code, 'SERIALS_NOT_EXPECTED',
      `the refusal is coded ${res.json && res.json.code} — numbers must not be silently dropped`);
  });

  const receipt = await audit.captureAsync('the same delivery, with one number per unit', async () => {
    const numbers = [`AUD-${TAG}-1`, `AUD-${TAG}-2`];
    const res = await manager.post(`/api/purchase-orders/${serialGoods.poId}/receive`, {
      receipts: [{ item_id: serialGoods.line.id, quantity_received: 2, serials: numbers, batch_no: `AUD-${TAG}-B` }],
    });
    assert.ok(res.status < 400, `receiving with the numbers answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    return { numbers, body: res.json };
  });

  await audit.checkAsync('the units are on the shelf and every number is on the register', async () => {
    // READ BACK BY A MANAGER, on purpose: `serial_numbers` has no `business_id` column, so a
    // scope filter on that column is a 500 for every manager and staff member — the two roles that
    // actually open the warranty register — while an owner's all-business scope never adds the
    // clause. A list only an owner can read is not a list.
    const register = await manager.get('/api/serials?limit=200');
    assert.equal(register.status, 200,
      `the serial register answered ${register.status} for a manager: ${String(register.text).slice(0, 200)}`);
    const rows = (register.json && register.json.data) || [];
    for (const number of receipt.numbers) {
      const row = rows.find((r) => String(r.serial_no) === number);
      assert.ok(row, `${number} was accepted and is not on the serial register`);
      assert.equal(String(row.status), 'IN_STOCK', `${number} is ${row.status}, not IN_STOCK`);
      assert.equal(String(row.branch_id), String(branch.id), `${number} is filed against another branch`);
      assert.ok(row.batch_id, `${number} is not tied to the batch it arrived in`);
    }
    const detail = await manager.get(`/api/purchase-orders/${serialGoods.poId}`);
    assert.equal(String(detail.json.po.status), 'RECEIVED', `the order is ${detail.json.po.status} after its two units arrived`);
    // The line is where the received quantity lives; the header's `units_received` is a roll-up the
    // list endpoint computes, and the detail does not carry it.
    const line = (detail.json.items || [])[0] || {};
    assert.equal(Number(line.quantity_received), 2, `the line counts ${line.quantity_received} units received, not 2`);
    assert.equal(Number(detail.json.totals && detail.json.totals.receivedValue), 3000,
      `the order reports ${detail.json.totals && detail.json.totals.receivedValue} of goods received, not ₦3,000`);
  });

  // ------------------------------------------------------------------
  // THE PLAN CAPS BIND AT THE DOOR, NOT AFTER IT
  // ------------------------------------------------------------------
  await audit.checkAsync('the branch cap refuses before a branch is written, and names the plan', async () => {
    const settings = await admin.get('/api/settings');
    const before = settings.json.settings || settings.json.data || settings.json;
    const used = ((await admin.get('/api/branches?limit=200')).json.data || []).length;
    const put = await admin.put('/api/settings', { max_branches: used });
    assert.ok(put.status < 400, `tightening the branch cap answered ${put.status}: ${String(put.text).slice(0, 200)}`);
    const refused = await owner.post('/api/branches', { name: `Audit Over Cap ${TAG}`, business_id: branch.business_id });
    assert.equal(refused.status, 402, `a branch over the cap answered ${refused.status}, not 402 (a plan cap is a payment question)`);
    assert.equal(refused.json && refused.json.code, 'MAX_BRANCHES_REACHED', `the refusal is coded ${refused.json && refused.json.code}`);
    assert.ok(/plan/i.test(String(refused.json.error || refused.json.message || '')), 'the refusal does not name the plan');
    // put the cap back exactly as it was found
    const restore = await admin.put('/api/settings', { max_branches: Number(before.max_branches) });
    assert.ok(restore.status < 400, `restoring the branch cap answered ${restore.status}`);
  });

  void round2;
}, {
  setup: () => startDeployment({
    label: 'create-flows',
    businesses: [{
      name: 'Create Flow Trading', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Create Flow Main', code: 'CF-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 25000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'cf-owner', pin: '70241', branchIndex: 0, full_name: 'Create Flow Owner' },
      { as: 'manager', role: 'MANAGER', username: 'cf-manager', pin: '70242', branchIndex: 0, full_name: 'Create Flow Manager' },
      { as: 'staff', role: 'STAFF', username: 'cf-staff', pin: '70243', branchIndex: 0, full_name: 'Create Flow Counter' },
    ],
  }),
});

module.exports = { TAG };
