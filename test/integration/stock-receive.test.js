'use strict';
// =====================================================================
// test/integration/stock-receive.test.js — PUTTING STOCK ON THE SHELF
// =====================================================================
// Receiving is where a shop's money enters the books: the cost recorded against a
// batch is the cost of every unit sold from it, and it feeds the margin, the stock
// valuation and the VAT on each later sale.
//
// Driving the receiving SCREEN for the first time found three things that no test
// had ever touched:
//
//   1. The form sent `cost_price_per_unit`; the endpoint reads `cost_price`. Every
//      attempt to receive stock from the screen was answered "Cost price is
//      required" — receiving was impossible from the UI at all.
//   2. The form sent `freight_per_unit`; the endpoint reads `freight_cost` as a
//      consignment total. Silently zero: carriage was never capitalised into cost.
//   3. `weightedAverageCost` read `cost_price_per_unit` while both of its callers
//      pass `{ quantity, cost }`, so receiving into a product that already had
//      stock averaged every cost as zero and wrote `products.cost_price = 0`.
//
// This file tests the endpoint the way a client calls it, and the arithmetic the
// callers actually hand it.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { createHttpApp } = require('../../server/app');
const { buildSeedSql } = require('../../tools/d1-seed');
const { weightedAverageCost } = require('../../domain/uom');

let counter = 0;

async function withShop(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-receive-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    await db.exec((await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'Vendor Admin' })).sql);
    const app = createHttpApp({ db, jwtSecret: 'receive-secret-long-enough', settings: {} });
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
        name: 'Receive Testing Ltd', profile_code: 'WHOLESALE_RETAIL', vat_registered: true,
        branch: { name: 'Store', city: 'Abuja', state: 'FCT', opening_cash: 0 },
      },
    });
    assert.equal(created.status, 201, `provisioning failed: ${created.text.slice(0, 300)}`);

    const pin = '48213';
    await call('POST', '/api/users', {
      token: admin.json.token,
      body: {
        full_name: 'Receiving Owner', username: 'rcvowner', role: 'OWNER',
        pin, confirm_pin: pin, branch_id: created.json.branch_id,
      },
    });
    const login = await call('POST', '/api/auth/login', { body: { username: 'rcvowner', pin } });
    assert.equal(login.status, 200, login.text.slice(0, 200));

    return await fn({
      db, call, token: login.json.token,
      businessId: created.json.id, branchId: created.json.branch_id,
    });
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  }
}

/** A product whose ladder sells by the carton, so the unit factor is not 1. */
async function cartonProduct(db, businessId) {
  const product = await db.first(`SELECT * FROM products WHERE business_id = ? AND is_deleted = 0 ORDER BY sku LIMIT 1`, [businessId]);
  const base = await db.first('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC LIMIT 1', [product.id]);
  let upper = await db.first('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 AND id <> ? ORDER BY quantity_in_base DESC LIMIT 1', [product.id, base.id]);
  if (!upper) {
    await db.run(`INSERT INTO product_units (id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at)
      VALUES ('pu_rcv_carton',?,1,'CARTON','Carton','Cartons',12,1,1, datetime('now'), datetime('now'))`, [product.id]);
    upper = { id: 'pu_rcv_carton', code: 'CARTON', quantity_in_base: 12 };
  } else {
    await db.run('UPDATE product_units SET quantity_in_base = 12 WHERE id = ?', [upper.id]);
  }
  return { product, base, upper };
}

const onHand = async (db, productId, branchId) => Number(await db.scalar(
  'SELECT COALESCE(SUM(quantity - quantity_reserved), 0) FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0',
  [productId, branchId]) || 0);

test('receiving accepts the payload the SCREEN sends', async () => {
  await withShop(async ({ db, call, token, businessId, branchId }) => {
    const { product } = await cartonProduct(db, businessId);

    // The exact shape the receiving form posts, field names included. Before the
    // fix this returned 400 "Cost price is required" and no shop could receive
    // anything from the interface.
    const res = await call('POST', '/api/stock/receive', {
      token,
      body: {
        branch_id: branchId,
        business_id: businessId,
        product_id: product.id,
        batch_no: 'GRN-TEST-1',
        quantity: 3,
        unit_code: 'CARTON',
        cost_price: 120000,
        freight_cost: 30000,
        selling_price: 150000,
        warehouse_zone: 'Aisle 1',
      },
    });
    assert.equal(res.status, 201, `the screen's own payload was refused: ${res.text.slice(0, 300)}`);
    assert.ok(res.json.batchId, 'a receipt must name the batch it created');

    // Three cartons of twelve is thirty-six base units, not three.
    assert.equal(await onHand(db, product.id, branchId), 36, 'stock must rise by the unit factor');

    const batch = await db.first('SELECT * FROM stock_batches WHERE id = ?', [res.json.batchId]);
    // Cost is per the RECEIVED unit, and freight is capitalised across the receipt
    // rather than expensed:
    //   3 cartons × ₦120,000              = ₦360,000
    //   + ₦30,000 clearing over 36 pieces = ₦833.33 a piece
    //   → ₦10,833.33 a piece, and ₦130,000 a carton
    const perBase = Number(batch.cost_price_per_unit);
    assert.ok(Math.abs(perBase - 10833.333333) < 0.01,
      `landed cost per base unit should be 10833.33 (a carton costs 130000 with the clearing), got ${perBase}`);
    assert.equal(Number(batch.quantity), 36, 'three cartons of twelve is thirty-six pieces');
    assert.equal(Number(batch.selling_price_per_unit), 12500, 'the selling price is per base unit too: 150000 a carton ÷ 12');
  });
});

test('the older field names still work, so nothing already written is lost', async () => {
  await withShop(async ({ db, call, token, businessId, branchId }) => {
    const { product } = await cartonProduct(db, businessId);
    const res = await call('POST', '/api/stock/receive', {
      token,
      body: {
        branch_id: branchId, business_id: businessId, product_id: product.id,
        quantity: 1, unit_code: 'CARTON',
        cost_price_per_unit: 60000, freight_per_unit: 6000,
      },
    });
    assert.equal(res.status, 201, `the legacy payload must still be accepted: ${res.text.slice(0, 300)}`);
    const batch = await db.first('SELECT * FROM stock_batches WHERE id = ?', [res.json.batchId]);
    assert.equal(Number(batch.cost_price_per_unit), 5500, 'per carton 66000 ÷ 12 = 5500 per base unit');
  });
});

test('receiving a unit NAME works, because a caller may hold one', async () => {
  await withShop(async ({ db, call, token, businessId, branchId }) => {
    const { product, base } = await cartonProduct(db, businessId);
    // The receiving form used to fill its unit box from `base_unit_name`, which is
    // the receipt word ("unit", "piece") rather than the ladder code.
    const res = await call('POST', '/api/stock/receive', {
      token,
      body: {
        branch_id: branchId, business_id: businessId, product_id: product.id,
        quantity: 5, unit_code: product.base_unit_name,
        cost_price: 1000, selling_price: 1500,
      },
    });
    assert.equal(res.status, 201, `a unit named "${product.base_unit_name}" must resolve: ${res.text.slice(0, 300)}`);
    assert.equal(await onHand(db, product.id, branchId), 5, 'five of the base unit is five base units');
    assert.equal(base.code, 'PIECE');
  });
});

test('receiving does not zero the product cost it just averaged', async () => {
  await withShop(async ({ db, call, token, businessId, branchId }) => {
    const { product } = await cartonProduct(db, businessId);

    const first = await call('POST', '/api/stock/receive', {
      token,
      body: {
        branch_id: branchId, business_id: businessId, product_id: product.id,
        quantity: 10, unit_code: 'PIECE', cost_price: 1000,
      },
    });
    assert.equal(first.status, 201, first.text.slice(0, 200));
    let cost = Number(await db.scalar('SELECT cost_price FROM products WHERE id = ?', [product.id]));
    assert.equal(cost, 1000, 'the catalogue cost must follow the receipt');

    // A second receipt into stock that is already there. `weightedAverageCost` was
    // handed { quantity, cost } and read cost_price_per_unit, so every cost averaged
    // as zero here and the product's cost was reset to 0.
    const second = await call('POST', '/api/stock/receive', {
      token,
      body: {
        branch_id: branchId, business_id: businessId, product_id: product.id,
        quantity: 10, unit_code: 'PIECE', cost_price: 2000,
      },
    });
    assert.equal(second.status, 201, second.text.slice(0, 200));
    cost = Number(await db.scalar('SELECT cost_price FROM products WHERE id = ?', [product.id]));
    assert.equal(cost, 1500, `ten at 1000 and ten at 2000 average to 1500, not ${cost}`);

    // And the batch costs that fed that average are intact, per base unit.
    const batches = await db.all('SELECT cost_price_per_unit FROM stock_batches WHERE product_id = ? AND is_deleted = 0 ORDER BY received_at', [product.id]);
    assert.deepEqual(batches.map((b) => Number(b.cost_price_per_unit)), [1000, 2000]);
  });
});

test('the weighted average reads the shape its callers pass', () => {
  // The shape the receiving endpoints assemble in memory.
  assert.equal(weightedAverageCost([{ quantity: 10, cost: 100 }, { quantity: 30, cost: 140 }]), 130);
  // The shape a database row has.
  assert.equal(weightedAverageCost([{ quantity: 10, cost_price_per_unit: 100 }, { quantity: 30, cost_price_per_unit: 140 }]), 130);
  // A real cost of zero is a cost, not a missing value.
  assert.equal(weightedAverageCost([{ quantity: 5, cost: 0 }]), 0);
  assert.equal(weightedAverageCost([]), 0);
  assert.equal(weightedAverageCost([{ quantity: 0, cost: 500 }]), 0, 'nothing on hand has no average');
});
