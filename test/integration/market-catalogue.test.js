'use strict';
// Adding from the Nigerian market copies a name into the shop's catalogue
// with no price. Serial numbers stay off unless that add said otherwise,
// and the till's receive rule follows that choice once the shop uses serials.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { createHttpApp } = require('../../server/app');
const { buildSeedSql } = require('../../tools/d1-seed');
const market = require('../../domain/nigeriaMarket');

let counter = 0;

async function withShop(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-market-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    await db.exec((await buildSeedSql({ username: 'admin', pin: '48213', businessName: null, adminName: 'Vendor Admin' })).sql);
    const app = createHttpApp({ db, jwtSecret: 'market-secret-long-enough', settings: {} });
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
        name: 'Market Testing Ltd', profile_code: 'WHOLESALE_RETAIL', vat_registered: true,
        branch: { name: 'Store', city: 'Abuja', state: 'FCT', opening_cash: 0 },
      },
    });
    assert.equal(created.status, 201, created.text.slice(0, 300));
    const pin = '48213';
    await call('POST', '/api/users', {
      token: admin.json.token,
      body: {
        full_name: 'Market Owner', username: 'mktowner', role: 'OWNER',
        pin, confirm_pin: pin, branch_id: created.json.branch_id,
      },
    });
    const login = await call('POST', '/api/auth/login', { body: { username: 'mktowner', pin } });
    assert.equal(login.status, 200, login.text.slice(0, 200));
    return await fn({ db, call, token: login.json.token, businessId: created.json.id, branchId: created.json.branch_id });
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  }
}

test('the market list has no prices, and adding a good copies it without one', async () => {
  await withShop(async ({ db, call, token, businessId, branchId }) => {
    const list = await call('GET', '/api/market-catalogue?q=mama%20gold&limit=5', { token });
    assert.equal(list.status, 200, list.text.slice(0, 200));
    assert.ok(list.json.count >= 2000, `the inbuilt list is ${list.json.count}, not thousands`);
    assert.equal(list.json.prices, false);
    const row = list.json.data[0];
    assert.ok(row && row.sku, 'the search returned nothing for Mama Gold');
    assert.equal('selling_price' in row, false, 'the market list quoted a price');
    assert.equal('price' in row, false);
    assert.equal('cost_price' in row, false);

    const plain = market.ITEMS.find((item) => item.category === 'NG_RICE');
    const serialItem = market.ITEMS.find((item) => item.category === 'NG_PHONE');
    const added = await call('POST', '/api/market-catalogue/adopt', {
      token,
      body: {
        business_id: businessId,
        items: [
          { sku: plain.sku, serial: false },
          { sku: serialItem.sku, serial: true },
        ],
      },
    });
    assert.equal(added.status, 201, added.text.slice(0, 400));
    assert.equal(added.json.prices, false);
    assert.equal(added.json.added.length, 2);

    const stored = await db.all('SELECT sku, selling_price, cost_price, requires_serial FROM products WHERE business_id = ? AND sku IN (?, ?)', [businessId, plain.sku, serialItem.sku]);
    const bySku = new Map(stored.map((r) => [r.sku, r]));
    assert.equal(Number(bySku.get(plain.sku).selling_price), 0, 'a market good was given a selling price');
    assert.equal(Number(bySku.get(plain.sku).cost_price), 0);
    assert.equal(Number(bySku.get(plain.sku).requires_serial), 0, 'serial was switched on without being asked');
    assert.equal(Number(bySku.get(serialItem.sku).requires_serial), 1, 'the serial switch on the add did not stick');

    const again = await call('POST', '/api/market-catalogue/adopt', {
      token,
      body: { business_id: businessId, items: [{ sku: plain.sku }] },
    });
    assert.equal(again.status, 200, again.text.slice(0, 200));
    assert.deepEqual(again.json.already, [plain.sku]);
    const copies = await db.scalar('SELECT COUNT(*) FROM products WHERE business_id = ? AND sku = ? AND is_deleted = 0', [businessId, plain.sku]);
    assert.equal(Number(copies), 1, 'adding the same good twice created two rows');

    // Shop serials are off, so even the marked phone can be received without a number.
    const phone = bySku.get(serialItem.sku);
    const off = await call('POST', '/api/stock/receive', {
      token,
      body: {
        branch_id: branchId, product_id: added.json.added.find((a) => a.sku === serialItem.sku).id,
        quantity: 1, unit_code: 'PIECE', cost_price: 1000, selling_price: 1500, reference: 'MKT-OFF',
      },
    });
    assert.ok(off.status < 400, `shop serials are off, but receiving was refused: ${off.text.slice(0, 220)}`);

    const on = await call('PUT', '/api/settings', { token, body: { serial_tracking_enabled: 1 } });
    assert.equal(on.status, 200, on.text.slice(0, 200));
    const refused = await call('POST', '/api/stock/receive', {
      token,
      body: {
        branch_id: branchId, product_id: added.json.added.find((a) => a.sku === serialItem.sku).id,
        quantity: 1, unit_code: 'PIECE', cost_price: 1000, selling_price: 1500, reference: 'MKT-ON',
      },
    });
    assert.equal(refused.status, 400, `a serial-on product was received with no number: ${refused.text.slice(0, 200)}`);
    assert.equal(refused.json.code, 'SERIALS_REQUIRED');

    const riceId = added.json.added.find((a) => a.sku === plain.sku).id;
    const rice = await call('POST', '/api/stock/receive', {
      token,
      body: {
        branch_id: branchId, product_id: riceId, quantity: 1, unit_code: 'BAG',
        cost_price: 1000, selling_price: 1500, reference: 'MKT-RICE',
      },
    });
    assert.ok(rice.status < 400, `a product with serial off was refused after the shop turned serials on: ${rice.text.slice(0, 220)}`);
    void phone;
  });
});
