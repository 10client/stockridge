'use strict';
// =====================================================================
// test/integration/sale-units.test.js — THE UNIT A TILL ACTUALLY SENDS
// =====================================================================
// A cashier could not sell a single appliance. Search worked, the cart worked, the
// payment was taken — and then:
//
//   Line 1 ("Anker 20000mAh Power Bank"): Unknown unit "UNIT".
//   This product is sold in: PIECE, CARTON.
//
// The appliance ladder names its base unit **"Unit"** under the code **PIECE**.
// The product row carries `base_unit_name` ("unit") because that is the word a
// receipt prints, and `public/js/views/pos.js` sent it as if it were a code —
// uppercased to `UNIT`, which is not in the ladder.
//
// Every test in this repository passed while that was true, because every test
// sent `unit_code: 'PIECE'`: the hand-written payload was more correct than the
// application. Nothing called the sale endpoint the way the till calls it.
//
// So this file tests the SALE PATH AS THE CLIENT DRIVES IT:
//   1. the product list tells a screen which code to sell in (`default_unit_code`)
//   2. a sale whose unit is a NAME resolves to that unit's code
//   3. a code still resolves to itself — the old behaviour is not broken
//   4. a unit that genuinely does not exist is still refused, and the refusal
//      names both the codes and the words, so the next person can see why
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { createHttpApp } = require('../../server/app');
const { buildSeedSql } = require('../../tools/d1-seed');
const uom = require('../../domain/uom');

let counter = 0;

/**
 * A fresh deployment with one business, created through the real provisioning
 * flow — the same way a client's first morning does.
 */
async function withShop(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-units-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    await db.exec((await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'Vendor Admin' })).sql);
    const app = createHttpApp({ db, jwtSecret: 'sale-units-secret-long-enough', settings: {} });
    const call = async (method, url, { token, body } = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await app.fetch(new Request(`http://local${url}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      }));
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return { status: res.status, json, text };
    };

    const admin = await call('POST', '/api/auth/login', { body: { username: 'admin', pin: '48213' } });
    const created = await call('POST', '/api/businesses', {
      token: admin.json.token,
      body: {
        name: 'Unit Path Electronics', profile_code: 'ELECTRONICS', vat_registered: true,
        branch: { name: 'Main', city: 'Abuja', state: 'FCT', opening_cash: 50000 },
      },
    });
    assert.equal(created.status, 201, `provisioning failed: ${created.text.slice(0, 300)}`);
    const businessId = created.json.id;
    const branchId = created.json.branch_id;

    // The owner is created through the API too: a role decides what a sale is
    // allowed to be, and creating the row directly would skip that.
    const ownerPin = '48213';
    const owner = await call('POST', '/api/users', {
      token: admin.json.token,
      body: {
        full_name: 'Unit Path Owner', username: 'unitowner', role: 'OWNER',
        pin: ownerPin, confirm_pin: ownerPin, branch_id: branchId,
      },
    });
    assert.equal(owner.status, 201, `creating the owner failed: ${owner.text.slice(0, 300)}`);
    const signIn = await call('POST', '/api/auth/login', { body: { username: 'unitowner', pin: ownerPin } });
    assert.equal(signIn.status, 200, `owner sign-in failed: ${signIn.text.slice(0, 200)}`);
    const token = signIn.json.token;

    return await fn({ db, call, token, businessId, branchId });
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  }
}

/** Put stock on the shelf so a sale has something to decrement. */
async function stockUp(db, { businessId, branchId, productId, quantity = 10, cost = 20000, price = 34000 }) {
  const id = `batch_${productId.slice(-6)}`;
  await db.run(`INSERT INTO stock_batches (
      id, branch_id, business_id, product_id, batch_no, cost_price_per_unit, selling_price_per_unit,
      quantity, quantity_reserved, initial_quantity, received_at, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?, datetime('now'), 'ACTIVE', datetime('now'), datetime('now'))`,
  [id, branchId, businessId, productId, 'B-UNIT', cost, price, quantity, quantity]);
  return id;
}

/** An appliance whose ladder names its base unit something other than its code. */
async function applianceWithNamedBaseUnit(db, businessId) {
  const product = await db.first(`SELECT * FROM products WHERE business_id = ? AND is_deleted = 0 ORDER BY sku LIMIT 1`, [businessId]);
  assert.ok(product, 'provisioning produced no products');
  const ladder = await db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY level ASC', [product.id]);
  assert.ok(ladder.length, 'the product has no unit ladder');
  return { product, ladder };
}

test('the product list tells a screen which unit CODE to sell in', async () => {
  await withShop(async ({ call, token, businessId }) => {
    const res = await call('GET', '/api/products?limit=5', { token });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const rows = res.json.data || [];
    assert.ok(rows.length, 'the provisioned catalogue is empty');

    for (const row of rows) {
      assert.ok(row.default_unit_code, `${row.sku}: no default_unit_code — a till would have to guess`);
      // The guess it used to make must still work too, and it must be the same
      // answer: `base_unit_name` is the receipt word, not a code.
      const ladder = await call('GET', `/api/catalog/products/${row.id}`, { token });
      if (ladder.status === 200) {
        assert.equal(String(row.default_unit_code).toUpperCase(), String(row.default_unit_code));
      }
    }

    // The price a screen should charge for one of that unit. Without the factor a
    // till prices a carton of water at the price of a bottle — it quoted ₦300 for
    // ₦14,400 of water, and the sale was then refused for the short payment.
    for (const row of rows) {
      assert.ok(row.default_unit_factor != null, `${row.sku}: no default_unit_factor — a till cannot price in that unit`);
      assert.ok(Number(row.default_unit_factor) > 0, `${row.sku}: the factor must be positive`);
    }

    // The specific shape that broke: a base unit whose NAME differs from its CODE.
    const named = [];
    for (const row of rows) {
      if (String(row.base_unit_name).toUpperCase() !== String(row.default_unit_code).toUpperCase()) named.push(row);
    }
    assert.ok(named.length, `the appliance catalogue no longer contains a product whose base unit name differs from its code,
      so this test is no longer testing the thing that broke (${businessId})`);
  });
});

test('the catalogue reports a factor for a unit that is more than one base unit', async () => {
  await withShop(async ({ call, token, db, businessId }) => {
    // Build the carton-of-water shape deliberately: a base unit, and a default sell
    // unit that holds twelve of them.
    const product = await db.first(`SELECT * FROM products WHERE business_id = ? AND is_deleted = 0 ORDER BY sku LIMIT 1`, [businessId]);
    const base = await db.first('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC LIMIT 1', [product.id]);
    let upper = await db.first('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 AND id <> ? ORDER BY quantity_in_base DESC LIMIT 1', [product.id, base.id]);
    if (!upper) {
      upper = { id: 'pu_test_carton', code: 'CARTON', name: 'Carton' };
      await db.run(`INSERT INTO product_units (id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at)
        VALUES (?,?,1,'CARTON','Carton','Cartons',12,1,1, datetime('now'), datetime('now'))`, [upper.id, product.id]);
    } else {
      await db.run('UPDATE product_units SET quantity_in_base = 12, is_sellable = 1, is_default_sell = 1 WHERE id = ?', [upper.id]);
    }
    await db.run('UPDATE product_units SET is_default_sell = 0 WHERE product_id = ? AND id <> ?', [product.id, upper.id]);

    const res = await call('GET', `/api/products?q=${encodeURIComponent(product.name)}&limit=5`, { token });
    const row = (res.json.data || []).find((r) => String(r.id) === String(product.id));
    assert.ok(row, 'the product did not come back from the catalogue list');
    assert.equal(row.default_unit_code, upper.code, 'the till must be told which unit to sell in');
    assert.equal(Number(row.default_unit_factor), 12,
      `the default unit (${row.default_unit_code}) holds twelve base units — a till not told this prices a carton at the price of one`);
  });
});

test('a sale whose unit is a NAME is accepted, and is stored as the unit CODE', async () => {
  await withShop(async ({ db, call, token, businessId, branchId }) => {
    const { product } = await applianceWithNamedBaseUnit(db, businessId);
    await stockUp(db, { businessId, branchId, productId: product.id });

    const word = String(product.base_unit_name || '').toUpperCase();
    assert.notEqual(word, 'PIECE', 'this product no longer reproduces the defect');

    // EXACTLY what the till sent: the base unit's word.
    const res = await call('POST', '/api/sales', {
      token,
      body: {
        branch_id: branchId, business_id: businessId, sale_type: 'RETAIL',
        sold_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        device_id: 'unit-test-device',
        lines: [{ product_id: product.id, quantity: 1, unit_code: product.base_unit_name }],
        payments: [{ method: 'CASH', amount: Number(product.selling_price) }],
      },
    });
    assert.equal(res.status, 201, `the till's own payload was refused: ${res.text.slice(0, 300)}`);

    const item = await db.first('SELECT * FROM sale_items WHERE sale_id = ?', [res.json.saleId]);
    assert.equal(item.unit_code, 'PIECE', 'the sale must be recorded in the ladder\'s code, not the word it arrived as');
    assert.equal(Number(item.quantity_in_base), 1, 'one unit of a base unit is one base unit');
  });
});

test('a sale that uses the CODE still works — the old path is not broken', async () => {
  await withShop(async ({ db, call, token, businessId, branchId }) => {
    const { product } = await applianceWithNamedBaseUnit(db, businessId);
    await stockUp(db, { businessId, branchId, productId: product.id });

    const res = await call('POST', '/api/sales', {
      token,
      body: {
        branch_id: branchId, business_id: businessId, sale_type: 'RETAIL',
        sold_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        device_id: 'unit-test-device',
        lines: [{ product_id: product.id, quantity: 2, unit_code: 'PIECE' }],
        payments: [{ method: 'CASH', amount: Number(product.selling_price) * 2 }],
      },
    });
    assert.equal(res.status, 201, res.text.slice(0, 300));
    const item = await db.first('SELECT * FROM sale_items WHERE sale_id = ?', [res.json.saleId]);
    assert.equal(item.unit_code, 'PIECE');
    assert.equal(Number(item.quantity_in_base), 2);
  });
});

test('a unit that does not exist is still refused, and the refusal names codes AND words', async () => {
  await withShop(async ({ db, call, token, businessId, branchId }) => {
    const { product } = await applianceWithNamedBaseUnit(db, businessId);
    await stockUp(db, { businessId, branchId, productId: product.id });

    const res = await call('POST', '/api/sales', {
      token,
      body: {
        branch_id: branchId, business_id: businessId, sale_type: 'RETAIL',
        sold_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        device_id: 'unit-test-device',
        lines: [{ product_id: product.id, quantity: 1, unit_code: 'HECTARE' }],
        payments: [{ method: 'CASH', amount: Number(product.selling_price) }],
      },
    });
    assert.ok(res.status >= 400, `a nonsense unit must be refused: ${res.text.slice(0, 200)}`);
    assert.match(res.text, /PIECE/, 'the refusal must name the codes the product is sold in');
    assert.match(res.text, /\(Unit\)/, 'the refusal must name the words too, so a caller can see which is which');
  });
});

test('unit resolution: by code, by name, by plural, and ambiguous names refused', () => {
  const ladder = [
    { code: 'PIECE', name: 'Unit', plural_name: 'Units', level: 0, quantity_in_base: 1, is_sellable: 1, is_default_sell: 1 },
    { code: 'CARTON', name: 'Carton', plural_name: 'Cartons', level: 1, quantity_in_base: 4, is_sellable: 1, is_default_sell: 0 },
  ];

  const byCode = uom.toBaseUnits({ quantity: 1, unitCode: 'piece', ladder });
  assert.equal(byCode.ok, true);
  assert.equal(byCode.unitCode, 'PIECE');
  assert.equal(byCode.resolvedFrom, 'code');

  // The defect: the appliance ladder's base unit is NAMED "Unit", CODED "PIECE".
  const byName = uom.toBaseUnits({ quantity: 1, unitCode: 'Unit', ladder });
  assert.equal(byName.ok, true, 'a unit name must resolve — this is the exact payload that failed');
  assert.equal(byName.unitCode, 'PIECE');
  assert.equal(byName.resolvedFrom, 'name');

  const byPlural = uom.toBaseUnits({ quantity: 1, unitCode: 'Units', ladder });
  assert.equal(byPlural.ok, true);
  assert.equal(byPlural.unitCode, 'PIECE');

  const carton = uom.toBaseUnits({ quantity: 2, unitCode: 'Carton', ladder });
  assert.equal(carton.ok, true);
  assert.equal(carton.baseQuantity, 8, '2 cartons of 4 is 8 base units');

  const unknown = uom.toBaseUnits({ quantity: 1, unitCode: 'HECTARE', ladder });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_UNIT');

  // When a word names two levels, refusing is the correct answer: guessing
  // between them is the bug, not the fix.
  const ambiguous = uom.toBaseUnits({
    quantity: 1,
    unitCode: 'Crate',
    ladder: [
      { code: 'PIECE', name: 'Crate', level: 0, quantity_in_base: 1, is_sellable: 1, is_default_sell: 1 },
      { code: 'CRATE4', name: 'Crate', level: 1, quantity_in_base: 4, is_sellable: 1, is_default_sell: 0 },
    ],
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'AMBIGUOUS_UNIT');
});
