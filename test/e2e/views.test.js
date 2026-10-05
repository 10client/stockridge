'use strict';
// =====================================================================
// test/e2e/views.test.js — EVERY SCREEN ACTUALLY RENDERS
// =====================================================================
// The frontend-route contract test proves the browser only calls routes that
// exist. This one goes further: it starts a real deployment, signs in, and CALLS
// every read endpoint those screens depend on — asserting each answers 200 with
// a body the screen can read.
//
// It exists because of a bug that only a real call could find. `GET
// /api/catalogue/profiles` returned HTTP 500 "describeProfile is not defined"
// for its entire life: the import was missing, the route was never exercised,
// and the screen that used it was written against a shape nobody had ever
// received. A year of careful reading would not have caught it; one request did.
//
// A second bug of the same family lived in the same route: it passed the
// resolved profile OBJECT into a function that takes a profile CODE. Every row
// described the default vertical, because `String(object)` is "[object Object]"
// and missed every key. So this file asserts CONTENT as well as status for the
// routes where being "successfully wrong" is possible.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { provisionDeployment } = require('../../server/services/provisioningService');
const { createHttpApp } = require('../../server/app');
const { getSettings } = require('../../domain/planLimits');

let counter = 0;

async function makeWorld() {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-views-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  await migrate(db);

  const prov = await provisionDeployment(db, {
    businessName: 'Screen Test Trading',
    profileCode: 'ELECTRONICS',
    ownerName: 'Screen Owner', ownerUsername: 'screenowner', ownerPin: '12345',
    branches: [{
      name: 'Screen Branch', code: 'SC-01', city: 'Enugu', state: 'Enugu', branch_type: 'RETAIL',
      latitude: 6.4402, longitude: 7.4951, geofence_radius_meters: 150, opening_cash: 20000,
      manager: { name: 'Screen Manager', username: 'screenmanager', pin: '23456' },
      staff: [{ name: 'Screen Cashier', username: 'screencashier', pin: '34567' }],
    }],
  });

  const settings = await getSettings(db);
  const app = createHttpApp({ db, jwtSecret: 'views-test-secret', settings });

  async function call(method, url, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Device-Id': 'views-device' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await app.fetch(new Request(`http://local${url}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = { _raw: text.slice(0, 300) }; }
    return { status: res.status, json, text };
  }

  const login = await call('POST', '/api/auth/login', { body: { username: 'screenowner', pin: '12345' } });
  assert.equal(login.status, 200, `owner login failed: ${login.text.slice(0, 200)}`);

  return {
    db, file, app, call, branchId: prov.branchIds[0],
    token: login.json.token,
    cleanup: () => {
      try { db.close(); } catch (e) { /* already closed */ }
      for (const suffix of ['', '-wal', '-shm']) { const f = file + suffix; if (fs.existsSync(f)) fs.rmSync(f, { force: true }); }
    },
  };
}

/**
 * Every read endpoint a screen opens with, and what that screen needs from it.
 * `check` runs against the parsed body.
 */
const SCREENS = [
  ['dashboard', 'GET', '/api/dashboard', (b) => assert.ok(b.ok !== false)],
  ['sales list', 'GET', '/api/sales?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['products list', 'GET', '/api/products?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['stock', 'GET', '/api/stock?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['stock valuation', 'GET', '/api/stock/valuation', (b) => assert.ok(b.ok !== false)],
  ['adjustments', 'GET', '/api/adjustments?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['stocktakes', 'GET', '/api/stocktakes?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['transfers', 'GET', '/api/transfers?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['customers', 'GET', '/api/customers?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['debtors', 'GET', '/api/customers/debtors', (b) => assert.ok(b.ok !== false)],
  ['customer classes', 'GET', '/api/customer-classes', (b) => assert.ok(b.ok !== false)],
  ['suppliers', 'GET', '/api/suppliers?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['purchase orders', 'GET', '/api/purchase-orders?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['creditors', 'GET', '/api/creditors', (b) => assert.ok(Array.isArray(b.creditors))],
  ['expenses', 'GET', '/api/expenses?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['tills', 'GET', '/api/tills?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['current till', 'GET', '/api/tills/current', (b) => assert.ok(b.ok !== false)],
  ['safe', 'GET', '/api/safe', (b) => assert.ok(Array.isArray(b.data))],
  ['banking', 'GET', '/api/banking?limit=10', (b) => assert.ok(b.ok !== false)],
  ['deliveries', 'GET', '/api/deliveries?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['returns', 'GET', '/api/returns?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['warranty claims', 'GET', '/api/warranty-claims?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['deposits', 'GET', '/api/deposits?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['instalments', 'GET', '/api/instalments?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['attendance today', 'GET', '/api/attendance/today', (b) => assert.ok(Array.isArray(b.records))],
  ['attendance history', 'GET', '/api/attendance?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['devices', 'GET', '/api/attendance/devices', (b) => assert.ok(Array.isArray(b.data))],
  ['accounting accounts', 'GET', '/api/accounting/accounts', (b) => assert.ok(Array.isArray(b.data))],
  ['trial balance', 'GET', '/api/accounting/trial-balance', (b) => assert.equal(b.balances, true)],
  ['profit and loss', 'GET', '/api/accounting/profit-loss', (b) => assert.ok(typeof b.totalRevenue === 'number')],
  ['balance sheet', 'GET', '/api/accounting/balance-sheet', (b) => assert.ok(typeof b.totalAssets === 'number')],
  ['journal', 'GET', '/api/accounting/journal?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['vat', 'GET', '/api/accounting/vat', (b) => assert.ok(typeof b.netPayable === 'number')],
  ['wht', 'GET', '/api/accounting/wht', (b) => assert.ok(Array.isArray(b.entries))],
  ['reports sales', 'GET', '/api/reports/sales?group_by=day', (b) => assert.ok(Array.isArray(b.rows))],
  ['reports inventory', 'GET', '/api/reports/inventory-movement', (b) => assert.ok(Array.isArray(b.data))],
  ['reports movers', 'GET', '/api/reports/movers?kind=FAST', (b) => assert.ok(Array.isArray(b.data))],
  ['reports customers', 'GET', '/api/reports/top-customers', (b) => assert.ok(Array.isArray(b.data))],
  ['reports commission', 'GET', '/api/reports/commission', (b) => assert.ok(Array.isArray(b.data))],
  ['reports targets', 'GET', '/api/reports/targets', (b) => assert.ok(Array.isArray(b.data))],
  ['users', 'GET', '/api/users?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['sessions', 'GET', '/api/sessions', (b) => assert.ok(Array.isArray(b.data))],
  ['branches', 'GET', '/api/branches', (b) => assert.ok(Array.isArray(b.data))],
  ['businesses', 'GET', '/api/businesses', (b) => assert.ok(Array.isArray(b.data))],
  ['settings', 'GET', '/api/settings', (b) => assert.ok(b.settings && typeof b.settings === 'object')],
  ['plan', 'GET', '/api/plan', (b) => assert.ok(b.settings && b.usage)],
  ['audit', 'GET', '/api/audit?limit=10', (b) => assert.ok(Array.isArray(b.data))],
  ['sync status', 'GET', '/api/sync/status', (b) => assert.ok(Array.isArray(b.devices))],
  ['sync conflicts', 'GET', '/api/sync/conflicts', (b) => assert.ok(Array.isArray(b.data))],
  ['notifications', 'GET', '/api/notifications', (b) => assert.ok(Array.isArray(b.data))],
  ['categories', 'GET', '/api/categories', (b) => assert.ok(Array.isArray(b.data))],
  ['price lists', 'GET', '/api/price-lists', (b) => assert.ok(b.ok !== false)],
  ['profiles summary', 'GET', '/api/profiles', (b) => assert.ok(Array.isArray(b.data))],
  ['branding', 'GET', '/api/branding/full', (b) => assert.ok(b.ok !== false)],
  ['auth me', 'GET', '/api/auth/me', (b) => assert.ok(b.user && b.user.username)],
];

test('every screen the app can open answers without an error', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const failures = [];
  for (const [name, method, rawUrl, check] of SCREENS) {
    // The app always sends the ACTIVE branch (SR.state.query() adds it) because
    // stock, cash and reports belong to a specific shop and the server refuses
    // to guess when a user can see more than one. The test does the same thing
    // rather than being allowed to call the API in a way the app never does.
    const url = `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}branch_id=${encodeURIComponent(world.branchId)}`;
    const r = await world.call(method, url, { token: world.token });
    if (r.status !== 200) {
      failures.push(`${name} (${method} ${url}) → ${r.status} ${JSON.stringify(r.json).slice(0, 220)}`);
      continue;
    }
    try { check(r.json); } catch (err) { failures.push(`${name} (${method} ${url}) → 200 but the body is wrong: ${err.message}`); }
  }
  assert.deepEqual(failures, [], 'a screen would open onto an error');
});

test('the vertical profiles describe the profiles, not the default five times', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const r = await world.call('GET', '/api/catalogue/profiles', { token: world.token });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  const rows = r.json.data || [];
  assert.ok(rows.length >= 4, `expected at least four verticals, got ${rows.length}`);

  const codes = rows.map((p) => p.code);
  assert.equal(new Set(codes).size, codes.length, `two verticals share a code: ${codes.join(', ')}`);
  assert.ok(codes.includes('ELECTRONICS'), `electronics is not among the verticals: ${codes.join(', ')}`);

  // The bug this asserts against: passing a profile OBJECT where a CODE was
  // expected resolved every row to the default, so each described General Retail.
  const general = rows.filter((p) => p.code === 'GENERAL_RETAIL').length;
  assert.equal(general, 1, `${general} rows claim to be GENERAL_RETAIL — a code is being resolved wrongly`);

  const electronics = rows.find((p) => p.code === 'ELECTRONICS');
  assert.ok(electronics.categoryCount > 0, 'a vertical with no categories cannot provision a catalogue');
  assert.ok((electronics.enabledFeatures || []).length > 0, 'a vertical with no features would leave the screen empty');

  assert.ok(r.json.ladders && Object.keys(r.json.ladders).length > 0, 'unit ladders must ship with the profiles');
  assert.ok(r.json.measureAxes, 'measured axes must ship with the profiles');
});

test('a fresh deployment has one business, one branch and no trading history', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const branches = await world.call('GET', '/api/branches', { token: world.token });
  assert.equal(branches.json.data.length, 1);

  const businesses = await world.call('GET', '/api/businesses', { token: world.token });
  assert.equal(businesses.json.data.length, 1);

  const sales = await world.call('GET', '/api/sales?limit=5', { token: world.token });
  assert.equal(sales.json.data.length, 0, 'a fresh deployment must not contain demo sales');

  const products = await world.call('GET', '/api/products?limit=200', { token: world.token });
  assert.ok(products.json.data.length > 0, 'provisioning must leave a usable starter catalogue');

  const tb = await world.call('GET', '/api/accounting/trial-balance', { token: world.token });
  assert.equal(tb.json.balances, true, `a fresh ledger must balance: ${tb.json.message}`);
  assert.equal(Number(tb.json.totalDebit), 0, 'nothing has been posted yet, so both sides are zero');
});
