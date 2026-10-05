'use strict';
// =====================================================================
// test/e2e/api.test.js — THE API SURFACE, EXERCISED OVER REAL HTTP
// =====================================================================
// The unit and integration tests call the services directly. Those pass while
// the HTTP layer is broken, because they never go through it. This file boots
// the actual server on a real port and drives it with fetch, which is the only
// way to catch the class of bug that hides in the seam: a middleware pattern
// that matches nothing, a route mounted under the wrong prefix, a guard that
// never runs, a response shape the client cannot parse.
//
// It found one already: `app.use('/api/*', ...)` compiled to a pattern matching
// only the literal path "/api*", so the auth guard was bypassed on every
// endpoint and ctx.user/ctx.scope were undefined inside all of them.
//
// Run with: node --test test/e2e/
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { newId } = require(path.join(ROOT, 'domain/crypto'));
const PORT = Number(process.env.E2E_PORT || 8811);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(ROOT, '.data', 'e2e.db');

let child = null;

async function req(method, urlPath, { token, body, headers } = {}) {
  const h = Object.assign({}, headers || {});
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + urlPath, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { _raw: text }; }
  return { status: res.status, json, headers: res.headers, text };
}

test('the API surface over real HTTP', async (t) => {
  // ---- build a throwaway database so the demo seed is never touched
  for (const suffix of ['', '-wal', '-shm', '.jwt']) {
    try { fs.rmSync(DB_FILE + suffix, { force: true }); } catch (e) { /* absent is fine */ }
  }
  const { openDatabase, migrate } = require(path.join(ROOT, 'server/lib/db'));
  const provisioning = require(path.join(ROOT, 'server/services/provisioningService'));

  const setup = openDatabase({ file: DB_FILE });
  await migrate(setup);
  // provisionDeployment does the whole bootstrap in one call: the settings row,
  // the WHT schedule as data, the business, its catalogue derived from the
  // vertical profile, the owner, the branch and the branch's manager and staff.
  const prov = await provisioning.provisionDeployment(setup, {
    businessName: 'E2E Appliances',
    profileCode: 'ELECTRONICS',
    ownerName: 'E2E Owner', ownerUsername: 'e2eowner', ownerPin: '12345',
    adminUsername: 'e2eadmin', adminPin: '12345',
    branches: [{
      name: 'E2E Main', code: 'E2E', city: 'Lagos', state: 'Lagos',
      branch_type: 'RETAIL', opening_cash: 50000,
      geofence_radius_meters: 200, attendance_mode: 'GEOLOCATION',
      manager: { name: 'E2E Manager', username: 'e2emanager', pin: '12345' },
      staff: [{ name: 'E2E Staff', username: 'e2estaff', pin: '12345' }],
    }],
  });
  const realBranchId = (prov.branchIds && prov.branchIds[0])
    || (await setup.first('SELECT id FROM branches ORDER BY created_at LIMIT 1')).id;
  // Give the branch some stock so a sale can actually complete: a receipt posts
  // a batch, updates the weighted-average cost and moves the ledger, exactly as
  // the goods-received route does in production.
  const product = await setup.first('SELECT * FROM products WHERE is_deleted = 0 ORDER BY name LIMIT 1');
  const ownerId = await setup.scalar("SELECT id FROM users WHERE role = 'OWNER' AND is_deleted = 0 LIMIT 1");
  if (product) {
    const { newId: nid } = require(path.join(ROOT, 'domain/crypto'));
    const { buildLadder, weightedAverageCost } = require(path.join(ROOT, 'domain/uom'));
    await setup.run(`INSERT INTO stock_batches (
        id, branch_id, business_id, product_id, batch_no, cost_price_per_unit, selling_price_per_unit,
        quantity, quantity_reserved, initial_quantity, received_at, received_by, status, created_at, updated_at)
      VALUES (?,?,?,?, 'E2E-BATCH', ?, ?, 200, 0, 200, datetime('now'), ?, 'ACTIVE', datetime('now'), datetime('now'))`, [
      nid(), realBranchId, product.business_id, product.id,
      Math.max(1, Number(product.cost_price) || 1000), Math.max(2, Number(product.selling_price) || 1500), ownerId,
    ]);
  }
  await setup.close();

  // ---- boot the real server against it
  child = spawn(process.execPath, [path.join(ROOT, 'server/app.js'), `--port=${PORT}`, `--db=${DB_FILE}`], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  let up = false;
  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch (e) { /* not listening yet */ }
  }

  t.after(async () => {
    if (child) { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 200)); }
  });

  assert.ok(up, `server did not start.\n${serverLog.slice(-2000)}`);

  // -------------------------------------------------------------------
  await t.test('health is reachable without a token', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });

  await t.test('a guarded endpoint refuses an anonymous caller', async () => {
    // THE REGRESSION THAT MATTERS. Before the middleware pattern was fixed this
    // returned 200 with data, because the guard never ran.
    const r = await req('GET', '/api/dashboard');
    assert.equal(r.status, 401, `expected 401, got ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    assert.equal(r.json.code, 'NO_TOKEN');
  });

  await t.test('login is itself unguarded, and a bad PIN is refused', async () => {
    const bad = await req('POST', '/api/auth/login', { body: { username: 'e2emanager', pin: '99999' } });
    assert.ok(bad.status === 401 || bad.status === 403, `expected a refusal, got ${bad.status}`);
    const good = await req('POST', '/api/auth/login', { body: { username: 'e2emanager', pin: '12345' } });
    assert.equal(good.status, 200, JSON.stringify(good.json).slice(0, 300));
    assert.ok(good.json.token, 'login must return a token');
  });

  const login = await req('POST', '/api/auth/login', { body: { username: 'e2eadmin', pin: '12345' } });
  const token = login.json.token;
  assert.ok(token, 'admin login must succeed');
  const mgrLogin = await req('POST', '/api/auth/login', { body: { username: 'e2emanager', pin: '12345' } });
  const mgrToken = mgrLogin.json.token;
  assert.ok(mgrToken, 'manager login must succeed');
  const staffLogin = await req('POST', '/api/auth/login', { body: { username: 'e2estaff', pin: '12345' } });
  const staffToken = staffLogin.json.token;
  assert.ok(staffToken, 'staff login must succeed');

  await t.test('auth/me returns the live user and their scope', async () => {
    const r = await req('GET', '/api/auth/me', { token });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.username, 'e2eadmin');
  });

  await t.test('a manager is pinned to their branch and cannot widen it', async () => {
    const me = await req('GET', '/api/auth/me', { token: mgrToken });
    const ownBranch = (me.json.user.branch && me.json.user.branch.id) || null;
    assert.ok(ownBranch, 'a branch manager must have a branch');
    // Ask for a branch that is emphatically NOT theirs. The contract is that the
    // request is either refused outright or ignored — never honoured. Honouring
    // it would be one shop's manager reading another shop's stock, which is the
    // single worst thing this scoping layer exists to prevent.
    const r = await req('GET', '/api/stock?branch_id=not-my-branch-at-all&limit=50', { token: mgrToken });
    assert.ok(r.status === 200 || (r.status >= 400 && r.status < 500), `unexpected ${r.status}`);
    if (r.status === 200) {
      for (const row of r.json.data || []) {
        assert.equal(String(row.branch_id), String(ownBranch), 'a manager must only ever see their own branch');
      }
      assert.ok(!r.text.includes('not-my-branch-at-all'), 'the requested branch must not be honoured');
    }
  });

  // -------------------------------------------------------------------
  // EVERY GET ENDPOINT must answer 2xx for an admin, or 4xx for a documented
  // reason. A 500 means the route referenced a column or a helper that does not
  // exist — which is exactly what happened to eleven of these on first run.
  // -------------------------------------------------------------------
  const BID = encodeURIComponent(realBranchId);
  // Raw (unencoded) ids for request BODIES; `BID` is for query strings only.
  const RAW_BRANCH = realBranchId;
  const BIZ = product.business_id;
  const GETS = [
    '/api/dashboard', '/api/dashboard/summary',
    `/api/stock?branch_id=${BID}`, `/api/stock/valuation?branch_id=${BID}`, `/api/stock/expiring?branch_id=${BID}`,
    '/api/sales?limit=5', '/api/customers?limit=5', '/api/customers/debtors', '/api/creditors',
    `/api/tills?limit=5`, `/api/tills/current?branch_id=${BID}`, `/api/safe?branch_id=${BID}`,
    '/api/expenses?limit=5', '/api/transfers?limit=5', '/api/stocktakes?limit=5', '/api/adjustments?limit=5',
    `/api/products?limit=5&branch_id=${BID}`, '/api/categories', '/api/price-lists', '/api/suppliers?limit=5',
    '/api/accounting/accounts', '/api/accounting/journal?limit=5', '/api/accounting/trial-balance',
    '/api/accounting/profit-loss', '/api/accounting/balance-sheet', '/api/accounting/vat', '/api/accounting/wht',
    '/api/reports/sales', '/api/reports/sales?group_by=PRODUCT', '/api/reports/sales?group_by=BRANCH',
    '/api/reports/sales?group_by=CATEGORY', '/api/reports/sales?group_by=PAYMENT_METHOD',
    '/api/reports/inventory-movement', '/api/reports/movers?kind=FAST', '/api/reports/movers?kind=DEAD',
    '/api/reports/movers?kind=SLOW', '/api/reports/movers?kind=SHRINKAGE',
    '/api/reports/top-customers', '/api/reports/commission', '/api/reports/targets',
    '/api/attendance/today', '/api/attendance?limit=5', '/api/attendance/devices',
    '/api/returns?limit=5', '/api/warranty-claims?limit=5', '/api/deposits?limit=5', '/api/instalments?limit=5',
    '/api/businesses', '/api/branches', '/api/users?limit=5', '/api/settings', '/api/plan',
    '/api/audit?limit=5', '/api/audit/verify', '/api/notifications', '/api/sync/status', '/api/sync/conflicts',
    '/api/deliveries?limit=5', '/api/profiles', '/api/branding', '/api/sessions',
  ];
  for (const p of GETS) {
    // eslint-disable-next-line no-await-in-loop
    await t.test(`GET ${p}`, async () => {
      const r = await req('GET', p, { token });
      assert.ok(
        r.status >= 200 && r.status < 300,
        `GET ${p} -> HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 400)}`,
      );
    });
  }

  await t.test('CSV export returns a parseable file with a BOM', async () => {
    const res = await fetch(`${BASE}/api/reports/export?report=SALES`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/csv/);
    assert.match(res.headers.get('content-disposition') || '', /\.csv/, 'the browser must download it, not render it');
    // Checked on the WIRE BYTES, not on `res.text()`.
    //
    // The WHATWG text decoder strips a leading BOM — that is the standard, and
    // it is why `text()` can never prove the BOM is there. Excel is not so
    // forgiving: without EF BB BF it guesses a legacy codepage and turns ₦ into
    // mojibake. `arrayBuffer()` is the only honest witness.
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xEF, 0xBB, 0xBF], 'the CSV must start with a UTF-8 BOM on the wire');
    const body = new TextDecoder('utf-8').decode(bytes);
    assert.match(body, /Receipt,Date \(WAT\)/, 'the file must start with the sales headers');
    assert.ok(body.split('\r\n').length >= 2, 'the file must contain rows, not just a header');
  });

  // -------------------------------------------------------------------
  // A REAL SALE, end to end, through the HTTP surface.
  // -------------------------------------------------------------------
  let saleId = null;
  let receiptNo = null;
  await t.test('a till can be opened', async () => {
    const r = await req('POST', '/api/tills/open', { token: mgrToken, body: { opening_cash: 20000 } });
    assert.equal(r.status, 201, JSON.stringify(r.json).slice(0, 400));
    assert.ok(r.json.id);
  });

  await t.test('opening a second till for the same user is refused', async () => {
    const r = await req('POST', '/api/tills/open', { token: mgrToken, body: { opening_cash: 20000 } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'TILL_ALREADY_OPEN');
  });

  await t.test('preview prices a cart without writing anything', async () => {
    const products = await req('GET', `/api/products?limit=5&branch_id=${BID}`, { token: mgrToken });
    const product = (products.json.data || [])[0];
    assert.ok(product, 'the seeded catalogue must contain a product');
    const before = await req('GET', `/api/stock?branch_id=${BID}`, { token: mgrToken });
    const r = await req('POST', '/api/sales/preview', {
      token: mgrToken,
      body: { lines: [{ product_id: product.id, quantity: 1 }] },
    });
    assert.ok(r.status === 200 || r.status === 422, `preview returned ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
    const after = await req('GET', `/api/stock?branch_id=${BID}`, { token: mgrToken });
    // A preview must not move stock. Comparing the whole payload is the point:
    // a preview that decremented stock would be indistinguishable from a sale.
    assert.equal(
      JSON.stringify(before.json.data), JSON.stringify(after.json.data),
      'preview must not change stock',
    );
  });

  await t.test('a sale completes, decrements stock and posts to the ledger', async () => {
    const products = await req('GET', `/api/products?limit=20&branch_id=${BID}`, { token: mgrToken });
    const stock = await req('GET', `/api/stock?branch_id=${BID}&limit=200`, { token: mgrToken });
    const stockByProduct = new Map((stock.json.data || []).map((s) => [String(s.product_id), s]));
    // Find something actually on the shelf, rather than assuming the first
    // product in the catalogue has stock.
    const sellable = (products.json.data || []).find((p) => {
      const s = stockByProduct.get(String(p.id));
      return s && Number(s.available) > 0;
    });
    assert.ok(sellable, 'the seeded branch must hold sellable stock');

    const before = stockByProduct.get(String(sellable.id));
    const r = await req('POST', '/api/sales', {
      token: mgrToken,
      headers: { 'Idempotency-Key': 'e2e-sale-1' },
      body: { lines: [{ product_id: sellable.id, quantity: 1 }], payments: [{ method: 'CASH', amount: Number(sellable.selling_price) }] },
    });
    assert.equal(r.status, 201, `sale failed: ${JSON.stringify(r.json).slice(0, 600)}`);
    assert.ok(r.json.saleId && r.json.receiptNo);
    saleId = r.json.saleId; receiptNo = r.json.receiptNo;

    const after = await req('GET', `/api/stock?branch_id=${BID}`, { token: mgrToken });
    const now = (after.json.data || []).find((s) => String(s.product_id) === String(sellable.id));
    assert.ok(now, 'the product must still appear in stock');
    assert.ok(Number(now.on_shelf) < Number(before.on_shelf), 'stock must have decreased');

    const detail = await req('GET', `/api/sales/${saleId}`, { token: mgrToken });
    assert.equal(detail.status, 200);
    assert.ok(detail.json.journal && detail.json.journal.length >= 2, 'the sale must post a journal entry');
    const debit = detail.json.journal.reduce((a, l) => a + Number(l.debit || 0), 0);
    const credit = detail.json.journal.reduce((a, l) => a + Number(l.credit || 0), 0);
    assert.ok(Math.abs(debit - credit) < 0.01, `the journal must balance: ${debit} vs ${credit}`);
  });

  await t.test('replaying the same idempotency key does not sell twice', async () => {
    const products = await req('GET', `/api/products?limit=20&branch_id=${BID}`, { token: mgrToken });
    const stock = await req('GET', `/api/stock?branch_id=${BID}&limit=200`, { token: mgrToken });
    const byId = new Map((stock.json.data || []).map((s) => [String(s.product_id), s]));
    const sellable = (products.json.data || []).find((p) => byId.get(String(p.id)) && Number(byId.get(String(p.id)).available) > 0);
    const r = await req('POST', '/api/sales', {
      token: mgrToken,
      headers: { 'Idempotency-Key': 'e2e-sale-1' },
      body: { lines: [{ product_id: sellable.id, quantity: 1 }], payments: [{ method: 'CASH', amount: Number(sellable.selling_price) }] },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.saleId, saleId, 'the replay must return the ORIGINAL sale, not create a second');
    assert.equal(r.json.replayed, true, 'the response must say it was replayed');
  });

  await t.test('a sale can be looked up by receipt number', async () => {
    const r = await req('GET', `/api/sales/by-receipt/${encodeURIComponent(receiptNo)}`, { token: mgrToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.sale.id, saleId);
  });

  await t.test('voiding returns the stock and reverses the ledger', async () => {
    const before = await req('GET', `/api/stock?branch_id=${BID}&limit=200`, { token: mgrToken });
    const r = await req('POST', `/api/sales/${saleId}/void`, { token: mgrToken, body: { reason: 'E2E test void — wrong item scanned' } });
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 400));
    const after = await req('GET', `/api/stock?branch_id=${BID}&limit=200`, { token: mgrToken });
    const sum = (d) => (d.json.data || []).reduce((a, x) => a + Number(x.on_shelf), 0);
    assert.ok(sum(after) >= sum(before), 'voiding must put stock back');
    const detail = await req('GET', `/api/sales/${saleId}`, { token: mgrToken });
    assert.equal(detail.json.sale.status, 'VOIDED');
  });

  await t.test('voiding without a real reason is refused', async () => {
    const r = await req('POST', `/api/sales/${saleId}/void`, { token: mgrToken, body: { reason: 'no' } });
    assert.ok(r.status >= 400, 'a two-character reason must be refused');
  });

  // -------------------------------------------------------------------
  await t.test('a staff member cannot open an instalment plan', async () => {
    const r = await req('POST', '/api/instalments', {
      token: staffToken,
      body: { customer_id: newId(), principal: 100000, tenure_months: 6 },
    });
    assert.equal(r.status, 403);
  });

  await t.test('a staff member cannot create a business', async () => {
    const r = await req('POST', '/api/businesses', { token: staffToken, body: { name: 'Nope' } });
    assert.equal(r.status, 403);
  });

  await t.test('a staff member cannot read the audit trail', async () => {
    const r = await req('GET', '/api/audit?limit=5', { token: staffToken });
    assert.equal(r.status, 403);
  });

  await t.test('settings refuse a contradictory flag combination', async () => {
    const r = await req('PUT', '/api/settings', {
      token, body: { staff_can_void_sales: 1, staff_void_window_minutes: 0 },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'CONTRADICTORY_SETTINGS');
  });

  await t.test('the trial balance still balances after trading', async () => {
    const r = await req('GET', '/api/accounting/trial-balance', { token });
    assert.equal(r.status, 200, `the books must balance: ${JSON.stringify(r.json).slice(0, 300)}`);
    assert.equal(r.json.balances, true);
  });

  await t.test('the audit chain verifies', async () => {
    const r = await req('GET', '/api/audit/verify', { token });
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 400));
    assert.equal(r.json.ok, true);
  });

  // -------------------------------------------------------------------
  // THE HAPPY PATH, WHICH NOTHING TESTED.
  //
  // Every sync test above and below pushes something that is REFUSED, so
  // `rejected > 0` on every one of them — and the bookkeeping row wrote 'PARTIAL'.
  // The row for a clean push wrote 'OK', which the column's CHECK does not allow,
  // so the one request that mattered — a device coming back online with sales it
  // made offline — answered 400 *after* applying the sale. The device never learned
  // it had succeeded: the outbox stayed full and re-sent for ever, and the shop was
  // told its work was still waiting when it was already in the books.
  //
  // A test that never applies anything cannot see that.
  await t.test('sync APPLIES an operation that is valid, and answers 200', async () => {
    const products = await req('GET', `/api/products?limit=20&branch_id=${BID}`, { token: mgrToken });
    const product = (products.json.data || []).find((p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
    assert.ok(product, 'the fixture needs a plain product to sell');

    const qty = 2;
    const total = Number(product.selling_price) * qty;
    const push = await req('POST', '/api/sync/push', {
      token: mgrToken,
      body: {
        device_id: 'e2e-offline-device',
        branch_id: RAW_BRANCH,
        operations: [{
          type: 'SALE',
          client_id: 'op_happy_path_1',
          idempotency_key: 'op_happy_path_1',
          occurred_at: new Date().toISOString(),
          payload: {
            branch_id: RAW_BRANCH,
            business_id: BIZ,
            sale_type: 'RETAIL',
            sold_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
            device_id: 'e2e-offline-device',
            client_id: 'op_happy_path_1',
            lines: [{ product_id: product.id, quantity: qty, unit_code: product.default_unit_code || 'PIECE' }],
            payments: [{ method: 'CASH', amount: total }],
          },
        }],
      },
    });
    assert.equal(push.status, 200, `a clean push must not fail: ${push.text.slice(0, 300)}`);
    assert.equal(push.json.applied, 1, `the server reported ${push.json.applied} applied`);
    assert.equal(push.json.rejected, 0);
    const op = push.json.results.operations[0];
    assert.equal(op.status, 'APPLIED', `the operation was ${op.status}: ${JSON.stringify(op).slice(0, 240)}`);
    assert.ok(op.result && op.result.saleId, 'the result must name the sale it created');

    // The sale is really in the books.
    const sale = await req('GET', `/api/sales/${op.result.saleId}`, { token: mgrToken });
    assert.equal(sale.status, 200, JSON.stringify(sale.json).slice(0, 200));
    assert.equal(Number(sale.json.sale.total), total);

    // ...and pushing it AGAIN — which is exactly what a device does when its outbox
    // was never cleared — applies it once, not twice. This is the property the shop
    // depends on: one sale, one receipt, one stock movement.
    const again = await req('POST', '/api/sync/push', {
      token: mgrToken,
      body: {
        device_id: 'e2e-offline-device',
        branch_id: RAW_BRANCH,
        operations: [{
          type: 'SALE', client_id: 'op_happy_path_1', idempotency_key: 'op_happy_path_1',
          occurred_at: new Date().toISOString(),
          payload: {
            branch_id: RAW_BRANCH, business_id: BIZ, sale_type: 'RETAIL',
            sold_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
            device_id: 'e2e-offline-device', client_id: 'op_happy_path_1',
            lines: [{ product_id: product.id, quantity: qty, unit_code: product.default_unit_code || 'PIECE' }],
            payments: [{ method: 'CASH', amount: total }],
          },
        }],
      },
    });
    assert.equal(again.status, 200, again.text.slice(0, 200));
    assert.equal(again.json.results.operations[0].status, 'ALREADY_APPLIED',
      'a re-sent operation must be recognised, not replayed');
    assert.equal(again.json.results.operations[0].result.saleId, op.result.saleId, 'the SAME sale, not a new one');
  });

  await t.test('sync refuses an operation type it does not know', async () => {
    const r = await req('POST', '/api/sync/push', {
      token: mgrToken,
      body: { device_id: 'e2e-device', operations: [{ type: 'DELETE_EVERYTHING', idempotency_key: 'k1' }] },
    });
    assert.ok(r.status === 207 || r.status === 200);
    const op = r.json.results.operations[0];
    assert.equal(op.status, 'REJECTED');
    assert.equal(op.code, 'UNKNOWN_OPERATION');
  });

  await t.test('sync refuses to write a non-whitelisted table', async () => {
    const r = await req('POST', '/api/sync/push', {
      token: mgrToken,
      body: { device_id: 'e2e-device', mutations: [{ table: 'gl_journal_lines', id: 'x', data: { debit: 1 } }] },
    });
    const m = r.json.results.mutations[0];
    assert.equal(m.status, 'REJECTED');
    assert.equal(m.code, 'TABLE_NOT_SYNCABLE');
  });

  await t.test('sync will not let a device move a row into another branch', async () => {
    // THE TENANT-ISOLATION GUARD. Force-scoping branch_id on an UPDATE would
    // reparent another branch's row instead of refusing the write.
    const other = await req('GET', '/api/branches', { token });
    const r = await req('POST', '/api/sync/push', {
      token: mgrToken,
      body: {
        device_id: 'e2e-device',
        mutations: [{ table: 'customers', id: newId(), op: 'UPDATE', data: { name: 'Hijacked', branch_id: 'somewhere-else' }, base_updated_at: '2000-01-01' }],
      },
    });
    const m = r.json.results.mutations[0];
    assert.ok(['REJECTED', 'SKIPPED'].includes(m.status), `expected a refusal, got ${m.status}`);
    assert.ok(
      m.code === 'SCOPE_COLUMN_FORBIDDEN' || m.code === 'OUT_OF_SCOPE',
      `expected a scope refusal, got ${m.code}`,
    );
    void other;
  });

  await t.test('a device can pull the catalogue but never the PIN hashes', async () => {
    const r = await req('POST', '/api/sync/pull', { token: mgrToken, body: { device_id: 'e2e-device' } });
    assert.equal(r.status, 200);
    assert.ok(r.json.cursor, 'a pull must return the cursor for the next one');
    const users = r.json.tables.users;
    assert.ok(users, 'users must be mirrored so the offline UI can show names');
    for (const u of users.rows) {
      assert.equal(u.pin_hash, undefined, 'a PIN hash must never leave the server');
    }
    assert.ok(r.json.tables.products.rows.length > 0, 'the catalogue must mirror');
  });

  await t.test('a device cannot pull the ledger or the audit log', async () => {
    const r = await req('POST', '/api/sync/pull', { token: mgrToken, body: { device_id: 'e2e-device', tables: ['gl_journal_lines', 'audit_log'] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.tables.gl_journal_lines.error, 'not_syncable');
    assert.equal(r.json.tables.audit_log.error, 'not_syncable');
  });

  await t.test('the till can be closed and reports a variance', async () => {
    const current = await req('GET', `/api/tills/current?branch_id=${BID}`, { token: mgrToken });
    const tillId = current.json.till.id;
    const noCount = await req('POST', `/api/tills/${tillId}/close`, { token: mgrToken, body: {} });
    assert.equal(noCount.status, 400, 'closing without a physical count must be refused');
    const r = await req('POST', `/api/tills/${tillId}/close`, {
      token: mgrToken, body: { counted_cash: 100, variance_reason: 'E2E: drawer was short' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    assert.notEqual(r.json.variance, 0);
    const again = await req('POST', `/api/tills/${tillId}/close`, { token: mgrToken, body: { counted_cash: 100 } });
    assert.equal(again.status, 409, 'a closed till must never be re-closed');
  });
});
