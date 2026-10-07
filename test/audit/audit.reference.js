'use strict';
// =====================================================================
// test/audit/audit.reference.js — THE LISTS A SHOP IS SET UP FROM
// =====================================================================
// Nine routes that decide what the product can even talk about: the business verticals, the
// category tree, the customer classes, the barcode scan a cashier uses at the counter, and the
// stock adjustments the shop makes when the count disagrees with the shelf. Every one of them
// read 0% in the coverage report — not because they are unimportant, but because nothing had
// exercised them end to end.
//
//   FRONT TO BACK  a manager adds a category and it appears with its product count → an owner
//                  creates a customer class with a discount and terms and it appears with them →
//                  a cashier scans a barcode and gets the product, not a list → an adjustment
//                  shows up in the adjustments ledger with its reason and its author.
//   BACK TO FRONT  a staff member cannot add a category and a manager cannot create a customer
//                  class (a class sets the terms for everybody in it) → a class that cannot buy
//                  on credit may not carry a credit limit → a scan with no code is refused rather
//                  than answered with a list → the vertical list describes the vertical it names,
//                  and asking for one this system does not have is a 404, not a silent default.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

runAudit('reference', async (audit, d) => {
  const owner = d.owner;
  const branch = d.branchFor(d.owner || d.admin) || d.branches[0];
  const manager = d.seats && d.seats.manager;
  const staff = d.seats && d.seats.staff;

  const product = await audit.captureAsync('a product from the vertical catalogue', async () => {
    const res = await owner.get('/api/products?limit=50');
    const rows = (res.json && res.json.data) || [];
    const pick = rows.find((p) => Number(p.selling_price) > 0);
    assert.ok(pick, `the catalogue has no priced product (${rows.length} row(s)) — the starter catalogue is missing`);
    return pick;
  });

  // ------------------------------------------------------------------
  // THE VERTICALS
  // ------------------------------------------------------------------
  await audit.checkAsync('the verticals describe themselves, and an unknown one is a 404', async () => {
    const list = await owner.get('/api/profiles');
    assert.equal(list.status, 200, `the vertical list answered ${list.status}`);
    const rows = list.json.data || [];
    assert.ok(rows.length >= 4, `the deployment offers ${rows.length} vertical(s); the product ships four`);
    for (const row of rows) {
      assert.ok(row.profile_code || row.code, `a vertical is listed without a code: ${JSON.stringify(row).slice(0, 120)}`);
      const named = row.name || row.label || (row.profile && (row.profile.label || row.profile.name));
      assert.ok(named, `the vertical ${row.profile_code || row.code} is listed without a name to choose it by: ${JSON.stringify(row).slice(0, 140)}`);
    }
    // EACH ROW DESCRIBES ITS OWN CODE. `describeProfile(profile)` was once passed the RESOLVED
    // profile object where a code was wanted, so `String(object)` was "[object Object]" and every
    // row described the default vertical — a list where all four answers are identical.
    const names = rows.map((r) => JSON.stringify(r.name));
    assert.ok(new Set(names).size >= 3, `the verticals are named ${names.join(', ')} — a list where every entry says the same thing describes nothing`);
    audit.note(`${rows.length} vertical(s): ${rows.map((r) => r.profile_code || r.code).join(', ')}`);

    // AND THE CATALOGUE NAMESPACE AGREES WITH THE ADMIN ONE. Two routes, one list: if they drift,
    // the screen a person uses depends on which one it happens to call.
    const viaCatalogue = await owner.get('/api/catalogue/profiles');
    assert.equal(viaCatalogue.status, 200, `the catalogue's vertical list answered ${viaCatalogue.status}`);
    const other = viaCatalogue.json.data || viaCatalogue.json.profiles || [];
    assert.equal(other.length, rows.length,
      `the two vertical lists disagree: ${rows.length} from /api/profiles and ${other.length} from /api/catalogue/profiles`);

    // ONE VERTICAL, BY CODE.
    const code = rows[0].profile_code || rows[0].code;
    const one = await owner.get(`/api/profiles/${encodeURIComponent(code)}`);
    assert.equal(one.status, 200, `asking for the ${code} vertical answered ${one.status}`);
    assert.ok(one.json.profile_code === code || one.json.code === code,
      `asking for ${code} answered about ${one.json.profile_code || one.json.code}`);

    // A VERTICAL THIS SYSTEM DOES NOT HAVE IS A 404, NOT A SILENT DEFAULT. `getProfile` used to
    // fall back to GENERAL_RETAIL, which made the 404 below dead code and would have handed a
    // client the wrong category tree and the wrong compliance rules without saying so.
    const unknown = await owner.get('/api/profiles/NOT_A_VERTICAL');
    assert.equal(unknown.status, 404, `an unknown vertical answered ${unknown.status} instead of 404 — a silent default vertical is a wrong shop`);
    assert.equal(unknown.json.code, 'UNKNOWN_PROFILE', `refused as ${unknown.json.code}`);
    assert.match(String(unknown.json.error || ''), /GENERAL_RETAIL/, 'the refusal should name the verticals this system does have');
  });

  // ------------------------------------------------------------------
  // THE CATEGORY TREE
  // ------------------------------------------------------------------
  await audit.checkAsync('a manager adds a category, and it appears with its product count', async () => {
    const before = await owner.get('/api/categories');
    assert.equal(before.status, 200, `the category list answered ${before.status}`);
    const rows = before.json.data || [];
    assert.ok(rows.length >= 3, `the vertical provisioned ${rows.length} category/ies`);
    const first = rows[0];
    assert.ok(first.product_count !== undefined, `a category is listed without a product_count (${Object.keys(first).join(', ')}) — the screen shows it beside the name`);

    if (!manager) { audit.skip('no manager seat on this target'); return; }
    const code = `AUDIT_CAT_${Date.now().toString(36).slice(-5).toUpperCase()}`;
    const created = await manager.post('/api/categories', { name: `Audit Category ${code.slice(-5)}`, code });
    assert.ok(created.status < 400, `adding a category answered ${created.status}: ${String(created.text).slice(0, 200)}`);
    assert.equal(created.json.code, code, `the route created ${created.json.code} and was asked for ${code}`);

    const after = await owner.get('/api/categories');
    const found = (after.json.data || []).find((c) => c.code === code);
    assert.ok(found, 'the new category is not in the list it was just added to');
    assert.equal(Number(found.product_count), 0, `a new category reports ${found.product_count} product(s)`);

    // THE SAME CODE TWICE IS A REFUSAL, not a second row with the same meaning.
    const dupe = await manager.post('/api/categories', { name: 'Audit Category Again', code });
    assert.equal(dupe.status, 409, `a duplicate category code was accepted (${dupe.status})`);
    assert.equal(dupe.json.code, 'DUPLICATE_CATEGORY', `refused as ${dupe.json.code}`);

    // A CASHIER CANNOT RESHAPE THE CATALOGUE.
    if (staff) {
      const notStaff = await staff.post('/api/categories', { name: 'Staff Category', code: `${code}_S` });
      assert.equal(notStaff.status, 403, `a cashier added a category (${notStaff.status})`);
      assert.equal(notStaff.json.code, 'ROLE_REQUIRED', `refused as ${notStaff.json.code}`);
    }

    const trail = await owner.get('/api/audit?action=CATEGORY_CREATED&limit=10');
    assert.ok((trail.json.data || []).some((r) => String(r.entity_id) === String(created.json.id)),
      'adding a category is not on the trail with the row it created');
  });

  // ------------------------------------------------------------------
  // THE CUSTOMER CLASSES
  // ------------------------------------------------------------------
  await audit.checkAsync('customer classes carry their terms, and a contradictory one is refused', async () => {
    const before = await owner.get('/api/customer-classes');
    assert.equal(before.status, 200, `the class list answered ${before.status}`);
    const rows = before.json.data || [];
    assert.ok(rows.length >= 2, `the deployment ships ${rows.length} customer class(es) — the system ones are part of the product`);
    assert.ok(rows.some((c) => Number(c.is_system)), 'no system class is listed, so the classes the product depends on are missing');
    for (const c of rows) {
      assert.ok(c.name, 'a class is listed without a name');
      assert.ok('customer_count' in c, `a class is listed without its customer count: ${Object.keys(c).join(', ')}`);
    }

    const code = `AUD_${Date.now().toString(36).slice(-5).toUpperCase()}`;
    const created = await owner.post('/api/customer-classes', {
      name: `Audit Trade ${code.slice(-5)}`, code, discount_pct: 7.5, credit_allowed: true, default_credit_limit: 250000, payment_terms_days: 30,
    });
    assert.ok(created.status < 400, `creating a class answered ${created.status}: ${String(created.text).slice(0, 220)}`);

    const after = await owner.get('/api/customer-classes');
    const found = (after.json.data || []).find((c) => c.code === code);
    assert.ok(found, 'the new class is not in the list');
    assert.equal(Number(found.discount_pct), 7.5, `the class discount came back as ${found.discount_pct}`);
    assert.equal(Number(found.credit_allowed), 1, 'the class says credit is not allowed');
    assert.equal(Number(found.default_credit_limit), 250000, `the class credit limit came back as ${found.default_credit_limit}`);
    assert.equal(Number(found.payment_terms_days), 30, `the class payment terms came back as ${found.payment_terms_days}`);

    // A CLASS THAT CANNOT BUY ON CREDIT CANNOT CARRY A CREDIT LIMIT. The route refuses it, and
    // that refusal is the difference between a term and a decoration.
    const contradictory = await owner.post('/api/customer-classes', {
      name: 'Audit No Credit', code: `${code}_X`, credit_allowed: false, default_credit_limit: 50000,
    });
    assert.equal(contradictory.status, 400, `a class refusing credit but carrying a ₦50,000 limit was accepted (${contradictory.status})`);
    assert.equal(contradictory.json.code, 'CONTRADICTORY_CLASS', `refused as ${contradictory.json.code}`);

    const dupe = await owner.post('/api/customer-classes', { name: 'Audit Trade Again', code });
    assert.equal(dupe.status, 409, `a duplicate class code was accepted (${dupe.status})`);

    // ONLY AN OWNER SETS TERMS FOR EVERYBODY IN A CLASS.
    if (manager) {
      const notManager = await manager.post('/api/customer-classes', { name: 'Manager Class', code: `${code}_M` });
      assert.equal(notManager.status, 403,
        `a manager created a customer class (${notManager.status}). A class sets the discount and the credit terms for every customer in it, which is an owner's decision`);
      assert.equal(notManager.json.code, 'ROLE_REQUIRED', `refused as ${notManager.json.code}`);
    }

    const trail = await owner.get('/api/audit?action=CUSTOMER_CLASS_CREATED&limit=10');
    assert.ok((trail.json.data || []).some((r) => String(r.entity_id) === String(created.json.id)),
      'creating a customer class is not on the trail with the row it created');
  });

  // ------------------------------------------------------------------
  // THE SCAN AT THE COUNTER
  // ------------------------------------------------------------------
  await audit.checkAsync('the counter scan finds one product, and refuses to guess', async () => {
    const sku = product.sku;
    const scanned = await owner.get(`/api/catalogue/scan?code=${encodeURIComponent(sku)}&branch_id=${encodeURIComponent(branch.id)}`);
    assert.equal(scanned.status, 200, `scanning ${sku} answered ${scanned.status}: ${String(scanned.text).slice(0, 200)}`);
    // IT MUST ANSWER THE PRODUCT, not a list of candidates: a cashier scanning at the counter has
    // no way to choose between three rows with a barcode gun.
    const body = scanned.json;
    const found = body.product || body.data || body;
    assert.ok(found && String(found.sku) === String(sku),
      `scanning ${sku} answered ${JSON.stringify(body).slice(0, 200)} — the scan must resolve to the product, not a result set`);

    // NO CODE IS NOT THE WHOLE CATALOGUE.
    const empty = await owner.get('/api/catalogue/scan');
    assert.equal(empty.status, 400, `a scan with no code answered ${empty.status}`);
    assert.equal(empty.json.code, 'MISSING_FIELD', `refused as ${empty.json.code}`);

    // A CODE NOTHING CARRIES IS A 404, and the message has to be usable by the person holding
    // the gun — "not found" is not enough when the answer is "it is not in THIS branch".
    const missing = await owner.get(`/api/catalogue/scan?code=NO-SUCH-BARCODE-${Date.now().toString(36)}&branch_id=${encodeURIComponent(branch.id)}`);
    assert.ok(missing.status === 404, `scanning an unknown code answered ${missing.status}`);
    audit.note(`unknown scan: ${missing.status} ${String(missing.json.error || '').slice(0, 90)}`);
  });

  // ------------------------------------------------------------------
  // THE ADJUSTMENTS LEDGER
  // ------------------------------------------------------------------
  await audit.checkAsync('an adjustment appears in the ledger, with its reason and its author', async () => {
    // STOCK ON THE SHELF FIRST, because an adjustment takes stock away and there has to be some.
    const received = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 10, unit_code: product.default_unit_code || 'PIECE',
      cost_price: Number(product.cost_price || product.selling_price * 0.6), selling_price: Number(product.selling_price),
      reference: `AUDIT-REF-${Date.now().toString(36)}`,
    });
    assert.ok(received.status < 400, `receiving stock answered ${received.status}: ${String(received.text).slice(0, 200)}`);

    const before = await owner.get(`/api/adjustments?branch_id=${encodeURIComponent(branch.id)}&limit=50`);
    assert.equal(before.status, 200, `the adjustments ledger answered ${before.status}: ${String(before.text).slice(0, 200)}`);
    const beforeRows = before.json.data || before.json.rows || [];
    assert.ok(Array.isArray(before.json.byType) || before.json.byType === undefined,
      'the ledger answers a byType block that is not a list');

    const reason = `reference audit ${Date.now().toString(36)}`;
    const adj = await owner.post('/api/stock/adjust', {
      branch_id: branch.id, product_id: product.id, quantity: -2, adjustment_type: 'DAMAGE',
      reason, unit_code: product.default_unit_code || 'PIECE',
    }, { idempotencyKey: `ref-adj-${Date.now().toString(36)}` });
    assert.ok(adj.status < 400, `adjusting stock answered ${adj.status}: ${String(adj.text).slice(0, 220)}`);

    const after = await owner.get(`/api/adjustments?branch_id=${encodeURIComponent(branch.id)}&limit=50`);
    const rows = after.json.data || after.json.rows || [];
    assert.ok(rows.length > beforeRows.length, `the ledger holds ${rows.length} row(s) and held ${beforeRows.length} before an adjustment was made`);
    const mine = rows.find((r) => String(r.reason || '').includes(reason) || String(r.id) === String(adj.json.id || adj.json.adjustmentId));
    assert.ok(mine, `the adjustment is not in the ledger by its reason or its id: ${JSON.stringify(rows.slice(0, 2)).slice(0, 200)}`);
    // THE LEDGER HAS TO SAY WHO AND WHERE. An adjustment is stock leaving the shelf with nothing
    // sold: without the author and the branch, the number is a mystery in a report.
    for (const key of ['product_name', 'branch_name', 'created_by_name', 'adjustment_type']) {
      assert.ok(mine[key] !== undefined && mine[key] !== null,
        `the ledger row does not carry ${key} (${Object.keys(mine).join(', ')}) — an adjustment nobody is named against cannot be argued about`);
    }
    assert.equal(String(mine.adjustment_type).toUpperCase(), 'DAMAGE', `the row says ${mine.adjustment_type}`);
    audit.note(`${mine.adjustment_type} of ${mine.product_name} at ${mine.branch_name} by ${mine.created_by_name} — ${money(mine.total_value)}`);

    // AND THE FILTER FINDS IT BY TYPE, which is how the screen narrows the list.
    const typed = await owner.get(`/api/adjustments?branch_id=${encodeURIComponent(branch.id)}&type=DAMAGE&limit=50`);
    assert.equal(typed.status, 200, `filtering the ledger by type answered ${typed.status}`);
    const typedRows = typed.json.data || typed.json.rows || [];
    assert.ok(typedRows.every((r) => String(r.adjustment_type).toUpperCase() === 'DAMAGE'),
      'the type filter returned rows of another type');
    assert.ok(typedRows.some((r) => String(r.id) === String(mine.id)), 'the type filter lost the adjustment it was meant to find');
  });
}, {
  setup: () => startDeployment({
    label: 'reference',
    businesses: [{
      name: 'Reference Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Reference Audit Branch', code: 'RF-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 12000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'rf-owner', pin: '93171', branchIndex: 0, full_name: 'Reference Audit Owner' },
      { as: 'manager', role: 'MANAGER', username: 'rf-manager', pin: '93172', branchIndex: 0, full_name: 'Reference Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'rf-staff', pin: '93173', branchIndex: 0, full_name: 'Reference Audit Counter' },
    ],
  }),
});
