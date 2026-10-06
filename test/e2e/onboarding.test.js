'use strict';
// =====================================================================
// test/e2e/onboarding.test.js — A CLIENT'S FIRST HOUR, END TO END
// =====================================================================
// The single most valuable test in this repository, because it is the only one
// that exercises the path a REAL client walks on their first day:
//
//   1. A fresh deployment with nothing in it but one administrator.
//   2. That administrator signs in and creates a business from the app's own
//      screen, choosing a vertical.
//   3. Provisioning builds the categories, the chart of accounts, the customer
//      classes, the price lists and a starter catalogue.
//   4. The administrator creates the OWNER and hands the business over.
//   5. The owner signs in and finds: a dashboard, a catalogue with real products,
//      their branch, a till to open, and a ledger that balances.
//   6. The owner rings up a sale through the same payload the POS screen sends,
//      and the books still balance afterwards.
//
// Every one of those steps has been broken at least once during development —
// `POST /api/businesses` was written against a service signature that did not
// exist (`provisionBusiness` was handed a wrapper object instead of a business
// row), and it failed on a foreign key the first time anybody called it. This
// test is what would have caught it the same hour.
//
// It is deliberately written against the HTTP surface, not the services: a
// service-level test would have passed while the route, the payload shape and
// the response keys were all wrong.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { provisionPlatform } = require('../../server/services/provisioningService');
const { createHttpApp } = require('../../server/app');
const { getSettings } = require('../../domain/planLimits');
const { watToday, watNow } = require('../../domain/time');

let counter = 0;
const ADMIN_PIN = '90210';
const OWNER_PIN = '48213';

/** A signed-out, empty deployment with one administrator. */
async function makeDeployment() {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-onboard-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  await migrate(db);
  const provisioned = await provisionPlatform(db, { adminUsername: 'admin', adminPin: ADMIN_PIN });

  const settings = await getSettings(db);
  const app = createHttpApp({ db, jwtSecret: 'onboarding-secret', settings });

  async function call(method, url, { token, body, idempotencyKey } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Device-Id': 'onboarding-device' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await app.fetch(new Request(`http://local${url}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = { _raw: text.slice(0, 400) }; }
    return { status: res.status, json, text };
  }

  return {
    db, file, app, call, provisioned,
    login: async (username, pin) => {
      const r = await call('POST', '/api/auth/login', { body: { username, pin } });
      assert.equal(r.status, 200, `login failed for ${username}: ${r.text.slice(0, 200)}`);
      return r.json.token;
    },
    cleanup: () => {
      try { db.close(); } catch (e) { /* already closed */ }
      for (const suffix of ['', '-wal', '-shm']) { const f = file + suffix; if (fs.existsSync(f)) fs.rmSync(f, { force: true }); }
    },
  };
}

test('a fresh deployment contains exactly one administrator and no trading data', async (t) => {
  const world = await makeDeployment();
  t.after(world.cleanup);

  const users = await world.db.all('SELECT username, role, business_id, branch_id FROM users WHERE is_deleted = 0');
  assert.equal(users.length, 1, 'a fresh deployment must have exactly one user');
  assert.equal(users[0].role, 'ADMIN');
  assert.equal(users[0].username, 'admin');
  assert.equal(users[0].business_id, null, 'the vendor administrator belongs to no client business');
  assert.equal(users[0].branch_id, null);

  for (const table of ['businesses', 'branches', 'products', 'sales', 'sale_items', 'customers', 'stock_batches', 'gl_journal_entries', 'till_sessions']) {
    const n = await world.db.scalar(`SELECT COUNT(*) FROM ${table} WHERE is_deleted = 0`);
    assert.equal(Number(n), 0, `${table} must be empty on a fresh deployment, found ${n}`);
  }

  // The things a deployment DOES need before anybody signs in: the settings row
  // and the withholding schedule, which is data rather than code.
  assert.ok(Number(await world.db.scalar('SELECT COUNT(*) FROM client_settings')) === 1, 'the settings row must exist');
  assert.equal(Number(await world.db.scalar('SELECT COUNT(*) FROM wht_rates')), 10, 'the 2024 withholding schedule must be seeded');

  // And the administrator can actually get in.
  const token = await world.login('admin', ADMIN_PIN);
  const me = await world.call('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'ADMIN');
});

test('the administrator creates the client business through the app, and provisioning works', async (t) => {
  const world = await makeDeployment();
  t.after(world.cleanup);

  const token = await world.login('admin', ADMIN_PIN);

  const created = await world.call('POST', '/api/businesses', {
    token,
    body: {
      name: 'Kano Home Appliances',
      legal_name: 'Kano Home Appliances Nigeria Ltd',
      profile_code: 'ELECTRONICS',
      cac_reg_no: 'RC 1234567',
      tin: '12345678-0001',
      vat_registered: true,
      contact_name: 'Hauwa Yakubu',
      contact_phone: '08030000000',
      seed_catalogue: true,
      branch: { name: 'Kano City', city: 'Kano', state: 'Kano', opening_cash: 50000 },
    },
  });
  assert.equal(created.status, 201, `creating the business failed: ${created.text.slice(0, 400)}`);
  assert.ok(created.json.id, 'the created business must return its id');
  assert.ok(created.json.branch_id, 'a business with no branch cannot trade — the first branch must be created with it');
  assert.ok(/provisioned/i.test(created.json.message || ''), `the message should say what was built: ${created.json.message}`);

  const businessId = created.json.id;
  const branchId = created.json.branch_id;

  // The derived rows that make the deployment usable on day one. Without the
  // chart of accounts the first sale cannot post; without a category the first
  // product cannot be added; without price lists there are no trade tiers.
  const derived = {
    product_categories: await world.db.scalar('SELECT COUNT(*) FROM product_categories WHERE business_id = ? AND is_deleted = 0', [businessId]),
    gl_accounts: await world.db.scalar('SELECT COUNT(*) FROM gl_accounts WHERE business_id = ? AND is_deleted = 0', [businessId]),
    customer_classes: await world.db.scalar('SELECT COUNT(*) FROM customer_classes WHERE business_id = ? AND is_deleted = 0', [businessId]),
    price_lists: await world.db.scalar('SELECT COUNT(*) FROM price_lists WHERE business_id = ? AND is_deleted = 0', [businessId]),
    products: await world.db.scalar('SELECT COUNT(*) FROM products WHERE business_id = ? AND is_deleted = 0', [businessId]),
  };
  for (const [table, n] of Object.entries(derived)) {
    assert.ok(Number(n) > 0, `provisioning produced no ${table} — the business would not be usable`);
  }

  // The catalogue must be a real catalogue: a unit ladder per product, because a
  // product with no units cannot be sold in anything.
  const noLadder = await world.db.scalar(`SELECT COUNT(*) FROM products p
      WHERE p.business_id = ? AND p.is_deleted = 0
        AND NOT EXISTS (SELECT 1 FROM product_units u WHERE u.product_id = p.id AND u.is_deleted = 0)`, [businessId]);
  assert.equal(Number(noLadder), 0, `${noLadder} product(s) have no unit ladder and could never be sold`);

  // A brand-new business has NO stock: it must not inherit anybody else's shelf.
  const batches = await world.db.scalar('SELECT COUNT(*) FROM stock_batches WHERE business_id = ? AND is_deleted = 0', [businessId]);
  assert.equal(Number(batches), 0, 'a new branch starts empty — stock arrives by purchase, not by magic');

  // The branch is real, and it knows the business it belongs to.
  const branches = await world.call('GET', '/api/branches', { token });
  assert.equal(branches.json.data.length, 1);
  assert.equal(String(branches.json.data[0].id), String(branchId));
  assert.equal(String(branches.json.data[0].business_id), String(businessId));

  // Creating a second business of the same profile must not duplicate anything.
  const again = await world.call('POST', '/api/businesses', {
    token,
    body: { name: 'Second Shop', profile_code: 'ELECTRONICS', seed_catalogue: true, branch: { name: 'Second Branch' } },
  });
  assert.equal(again.status, 201, again.text.slice(0, 300));
  const secondBusinessId = again.json.id;
  const secondProducts = await world.db.scalar('SELECT COUNT(*) FROM products WHERE business_id = ? AND is_deleted = 0', [secondBusinessId]);
  assert.ok(Number(secondProducts) > 0, 'the second business must get its own catalogue, not share the first');
  const sharedAccounts = await world.db.scalar('SELECT COUNT(*) FROM gl_accounts WHERE business_id = ? AND is_deleted = 0', [secondBusinessId]);
  assert.ok(Number(sharedAccounts) > 0, 'each business needs its own books');
});

test('the owner signs in and can trade — a sale posts and the ledger still balances', async (t) => {
  const world = await makeDeployment();
  t.after(world.cleanup);

  const adminToken = await world.login('admin', ADMIN_PIN);
  const created = await world.call('POST', '/api/businesses', {
    token: adminToken,
    body: { name: 'Lekki Furniture', profile_code: 'FURNITURE', vat_registered: true, branch: { name: 'Lekki', city: 'Lagos', state: 'Lagos', opening_cash: 100000 } },
  });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  const businessId = created.json.id;
  const branchId = created.json.branch_id;

  // ---- the administrator hands over to an owner
  const owner = await world.call('POST', '/api/users', {
    token: adminToken,
    body: {
      full_name: 'Chidi Okonkwo', username: 'chidi', role: 'OWNER',
      pin: OWNER_PIN, confirm_pin: OWNER_PIN, branch_id: branchId, job_title: 'Proprietor',
    },
  });
  assert.equal(owner.status, 201, `creating the owner failed: ${owner.text.slice(0, 300)}`);

  const ownerToken = await world.login('chidi', OWNER_PIN);
  const me = await world.call('GET', '/api/auth/me', { token: ownerToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'OWNER');
  assert.ok(me.json.user.branch, 'the owner must come back with their branch attached');

  // ---- the screens the owner opens first all answer
  const branchQuery = `branch_id=${encodeURIComponent(branchId)}&business_id=${encodeURIComponent(businessId)}`;
  for (const url of ['/api/dashboard', '/api/products', '/api/customers', '/api/stock', '/api/branches', '/api/accounting/trial-balance']) {
    const r = await world.call('GET', `${url}?${branchQuery}`, { token: ownerToken });
    assert.equal(r.status, 200, `${url} failed for the owner: ${r.text.slice(0, 200)}`);
  }

  // ---- stock arrives: receive one product so there is something to sell
  const products = await world.call('GET', `/api/products?${branchQuery}&limit=5`, { token: ownerToken });
  assert.ok(products.json.data.length > 0, 'the starter catalogue must contain products');
  const product = products.json.data[0];
  const productDetail = await world.call('GET', `/api/products/${product.id}`, { token: ownerToken });
  assert.equal(productDetail.status, 200);
  const units = productDetail.json.units || [];
  assert.ok(units.length > 0, 'a product must come back with its unit ladder');
  const baseUnit = units[0].code;
  const price = Number(product.selling_price || 0);
  assert.ok(price > 0, 'a starter product must have a selling price');

  // A FURNITURE product comes in variants (fabric, finish, size) because the
  // profile says furniture does. That is not decoration: a sofa without a fabric
  // is not a sellable unit and the sale route refuses one, naming the product.
  // Most of the test then has to carry the choice — the receipt, the batch and
  // the sale all have to agree on WHICH sofa moved.
  const variants = productDetail.json.variants || [];
  const variantId = variants.length ? variants[0].id : null;
  if (variantId) {
    const refused = await world.call('POST', '/api/sales', {
      token: ownerToken,
      body: {
        branch_id: branchId, business_id: businessId, sale_type: 'RETAIL',
        sold_at: watNow(), device_id: 'onboarding-device',
        payments: [{ method: 'CASH', amount: price }],
        lines: [{ product_id: product.id, quantity: 1, unit_code: baseUnit, unit_price: price }],
      },
    });
    assert.equal(refused.status, 400, 'selling a variant product with no variant chosen must be refused');
    assert.equal(refused.json.code, 'SALE_PREPARATION_FAILED', `expected the variant guard, got ${refused.json.code}`);
  }

  // ONE product per call, and the body is FLAT — not `items: [...]`. That is the
  // contract of POST /api/stock/receive: a goods receipt is signed per line,
  // because the cost it carries becomes the cost basis for everything sold from
  // that batch. (This assertion was written as `items: [...]` first and the route
  // refused it with "Product is required", which is exactly the kind of mismatch
  // that a screen would have shipped with.)
  const received = await world.call('POST', '/api/stock/receive', {
    token: ownerToken,
    body: {
      branch_id: branchId,
      product_id: product.id,
      variant_id: variantId || undefined,
      unit_code: baseUnit,
      quantity: 10,
      // Cost is PER THE UNIT RECEIVED, converted to base units by the route.
      cost_price: Number(product.cost_price || Math.max(1, price * 0.7)),
      selling_price: price,
      paid_now: 0,
      on_credit: 10,
      notes: 'Opening stock for the first day of trade',
    },
    idempotencyKey: 'onboard-receive-1',
  });
  assert.equal(received.status, 201, `receiving stock failed: ${received.text.slice(0, 400)}`);
  assert.equal(Number(received.json.quantityBase), 10, `expected 10 base units on the shelf, got ${received.json.quantityBase}`);
  assert.ok(received.json.landedCostPerBase > 0, 'the receipt must report what each unit cost to land');

  const onHand = await world.db.scalar(
    'SELECT COALESCE(SUM(quantity),0) FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0',
    [product.id, String(branchId)],
  );
  void variantId;
  assert.equal(Number(onHand), 10, 'the received stock must be on the shelf');

  // ---- a sale, using exactly the payload the POS screen builds
  const sale = await world.call('POST', '/api/sales', {
    token: ownerToken,
    idempotencyKey: 'onboard-sale-1',
    body: {
      branch_id: branchId,
      business_id: businessId,
      sale_type: 'RETAIL',
      sold_at: watNow(),
      device_id: 'onboarding-device',
      payments: [{ method: 'CASH', amount: price }],
      lines: [{ product_id: product.id, variant_id: variantId || undefined, quantity: 1, unit_code: baseUnit, unit_price: price }],
    },
  });
  assert.equal(sale.status, 201, `the sale failed: ${sale.text.slice(0, 500)}`);
  // The sale response is camelCase (`receiptNo`, and the money under `totals`)
  // because it is consumed by the POS screen, not by a SQL reader. Asserting
  // `receipt_no` here raised "a sale must come back with a receipt number" on a
  // sale that had, in fact, been recorded perfectly — the assertion was wrong,
  // not the sale.
  assert.ok(sale.json.receiptNo, 'a sale must come back with a receipt number');
  assert.equal(Number(sale.json.totals.total), price, `the sale total should be the price for one unit, got ${sale.json.totals && sale.json.totals.total}`);

  // ---- and the books still balance, with the sale in them
  const tb = await world.call('GET', `/api/accounting/trial-balance?${branchQuery}`, { token: ownerToken });
  assert.equal(tb.json.balances, true, `the ledger does not balance after a sale: ${tb.json.message}`);
  assert.ok(Number(tb.json.totalDebit) > 0, 'a sale must post to the ledger');

  // ---- the till the owner is told to open actually opens
  const till = await world.call('POST', '/api/tills/open', {
    token: ownerToken,
    body: { opening_cash: 20000, branch_id: branchId },
  });
  assert.equal(till.status, 201, `opening a till failed: ${till.text.slice(0, 300)}`);
  const current = await world.call('GET', `/api/tills/current?${branchQuery}`, { token: ownerToken });
  assert.equal(current.status, 200);
  assert.ok(current.json.till, 'the open till must be returned');
  assert.equal(Number(current.json.till.opening_cash), 20000);

  // ---- stocktake can be started on a shelf that now has stock
  const stocktake = await world.call('POST', '/api/stocktakes', {
    token: ownerToken,
    body: { scope: 'FULL', branch_id: branchId, notes: 'Opening count' },
  });
  assert.equal(stocktake.status, 201, `opening a stocktake failed: ${stocktake.text.slice(0, 300)}`);
  assert.ok(Number(stocktake.json.lines) > 0, 'a stocktake over a shelf with stock must have lines to count');
});

test('the owner cannot be handed a business the administrator never created', async (t) => {
  const world = await makeDeployment();
  t.after(world.cleanup);

  const token = await world.login('admin', ADMIN_PIN);
  // A branch that does not exist must be refused rather than silently nulled.
  const bad = await world.call('POST', '/api/users', {
    token,
    body: { full_name: 'Nobody', username: 'nobody', role: 'OWNER', pin: '11223', confirm_pin: '11223', branch_id: 'branch-that-does-not-exist' },
  });
  assert.ok(bad.status >= 400 && bad.status < 500, `expected a refusal, got ${bad.status}: ${bad.text.slice(0, 200)}`);
  assert.equal(Number(await world.db.scalar("SELECT COUNT(*) FROM users WHERE username = 'nobody'")), 0, 'a refused user must not be created');
});
