'use strict';
// =====================================================================
// test/integration/read-scope.test.js — A READ IS NOT NARROWED BY A GUESS
// =====================================================================
// Found on a live deployment with two businesses: an administrator recorded a
// licence against a branch of the newer business and then could not see it. The
// WRITE took its business from the named branch — a fact. The READ named nothing,
// so `resolveBusiness` GUESSED (the recorded primary business, else the OLDEST
// live business), picked the other one, and returned an empty register. The
// duplicate-record guard then refused to record the same licence again, so the
// record existed, could not be seen, and could not be re-entered.
//
// The same narrowing sat on the chart of accounts, the journal, VAT, WHT, the
// customer classes, the creditor book, nine reports, the export and the sync
// pull: `... WHERE x.business_id = ?` fed by whatever business the platform had
// resolved. On a single-business deployment it is invisible — the guess is right
// every time. On a two-business one, half the data is missing from every list and
// nothing says so.
//
// WHAT THIS FILE ASSERTS, and what would have to break for it to pass wrongly:
//
//   * a business that is NAMED still narrows — otherwise the fix would be "show
//     everything to everyone", which is a worse bug than the one being fixed;
//   * a caller who REACHES EVERY BUSINESS and names none sees every business;
//   * the system rows (`business_id IS NULL`, the shared chart of accounts) stay
//     visible to a narrowed caller, because that is what NULL means in this schema;
//   * the sync pull that seeds a device carries the whole catalogue it can reach,
//     not one business's sixth of it.
//
// Driven over real HTTP against a real database, because the defect lived in the
// SQL that a service-level test would have mocked away.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.READ_SCOPE_PORT || 8819);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(ROOT, '.data', 'read-scope-test.db');

let child = null;

async function req(method, urlPath, { token, body } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + urlPath, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { _raw: text }; }
  return { status: res.status, json, text };
}

test('read scope: what a caller reaches, never what the platform guessed', async (t) => {
  for (const suffix of ['', '-wal', '-shm', '.jwt']) {
    try { fs.rmSync(DB_FILE + suffix, { force: true }); } catch (e) { /* absent is fine */ }
  }
  const { openDatabase, migrate } = require(path.join(ROOT, 'server/lib/db'));
  const provisioning = require(path.join(ROOT, 'server/services/provisioningService'));
  const { newId } = require(path.join(ROOT, 'domain/crypto'));
  const { watNow, watToday } = require(path.join(ROOT, 'domain/time'));

  const db = openDatabase({ file: DB_FILE });
  await migrate(db);

  // ONE deployment, TWO businesses — the shape the bug needs, and the shape a
  // Nigerian merchant grows into: electronics in the front, furniture in the back.
  await provisioning.provisionDeployment(db, {
    businessName: 'Scope Electronics Ltd',
    profileCode: 'ELECTRONICS',
    ownerName: 'Scope Owner', ownerUsername: 'sc-owner', ownerPin: '12345',
    adminUsername: 'sc-admin', adminPin: '12345',
    branches: [
      { name: 'Ikeja Store', code: 'SC-IKJ', city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL', opening_cash: 40000,
        manager: { name: 'Ikeja Manager', username: 'sc-ikeja', pin: '11111', job_title: 'Branch Manager' } },
    ],
  });

  // The second business, provisioned the way the app provisions one. Deliberately
  // the NEWER entity: the guess this test exists for falls back to the OLDEST live
  // business, so a fixture where the second business is also the older one would
  // hide the defect.
  const furnitureId = newId();
  await db.run(`INSERT INTO businesses (id, name, profile_code, vat_registered, created_at, updated_at)
                VALUES (?,?,?,?, datetime('now'), datetime('now'))`,
  [furnitureId, 'Scope Furniture Ltd', 'FURNITURE', 1]);
  const lekkiId = newId();
  await db.run(`INSERT INTO branches (id, business_id, name, code, city, state, branch_type, opening_cash, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
  [lekkiId, furnitureId, 'Lekki Showroom', 'SC-LEK', 'Lagos', 'Lagos', 'SHOWROOM', 30000]);
  await provisioning.provisionBusiness(db, { id: furnitureId, profile_code: 'FURNITURE' });

  const electronics = await db.first("SELECT id, name FROM businesses WHERE name = 'Scope Electronics Ltd'");
  const ikeja = await db.first("SELECT id FROM branches WHERE code = 'SC-IKJ'");

  // ONE SALE PER BUSINESS, written straight into the table. The VAT summary and the
  // sales report read `sales` rather than the ledger, so these two rows are what
  // those two reports must find — and a report that finds one of them is the bug.
  const soldAt = `${watToday()} 11:00:00`;
  for (const [n, bizId, branchId, total] of [
    ['SC-000001', electronics.id, ikeja.id, 115000],
    ['SC-000002', furnitureId, lekkiId, 460000],
  ]) {
    const vat = Math.round((total - total / 1.075) * 100) / 100;
    await db.run(`INSERT INTO sales (id, business_id, branch_id, receipt_no, sale_type, status, subtotal, vat_enabled, vat_rate_percent, vat_amount, total,
                                     amount_paid, balance_due, payment_method, sold_at, created_at, updated_at, is_deleted)
                  VALUES (?,?,?,?, 'RETAIL', 'COMPLETED', ?, 1, 7.5, ?, ?, ?, 0, 'CASH', ?, datetime('now'), datetime('now'), 0)`,
    // VAT-INCLUSIVE: `subtotal` is the sum of the line totals (VAT included), which is
    // what the sales table's own CHECK enforces — subtotal - discount + delivery = total.
    [newId(), bizId, branchId, n, total, vat, total, total, soldAt]);
  }

  // One supplier per business, each owed money, because the creditor book hides a
  // supplier with a zero balance and a test that cannot tell "hidden" from "not
  // reached" proves nothing.
  for (const [name, bizId] of [['Scope Electronics Supplies', electronics.id], ['Scope Timber & Foam', furnitureId]]) {
    const supplierId = newId();
    await db.run(`INSERT INTO suppliers (id, business_id, name, created_at, updated_at, is_deleted)
                  VALUES (?,?,?, datetime('now'), datetime('now'), 0)`, [supplierId, bizId, name]);
    await db.run(`INSERT INTO creditor_ledger (id, branch_id, business_id, supplier_id, entry_type, amount, balance_after, created_at, updated_at, is_deleted)
                  VALUES (?,?,?,?, 'PURCHASE', 50000, 50000, datetime('now'), datetime('now'), 0)`,
    [newId(), bizId === electronics.id ? ikeja.id : lekkiId, bizId, supplierId]);
  }
  await db.close();

  child = spawn(process.execPath, [path.join(ROOT, 'server/app.js'), `--port=${PORT}`, `--db=${DB_FILE}`], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch (e) { /* not up yet */ }
  }
  t.after(async () => {
    if (child) { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 200)); }
  });
  assert.ok(up, `server did not start.\n${serverLog.slice(-2000)}`);

  const tokens = {};
  for (const [who, username, pin] of [['owner', 'sc-owner', '12345'], ['admin', 'sc-admin', '12345'], ['manager', 'sc-ikeja', '11111']]) {
    const r = await req('POST', '/api/auth/login', { body: { username, pin } });
    assert.equal(r.status, 200, `${username} could not sign in: ${r.text.slice(0, 200)}`);
    tokens[who] = r.json.token;
  }

  const ids = (rows, key) => rows.map((r) => String(r[key]));

  // -------------------------------------------------------------------
  await t.test('the chart of accounts covers both businesses, and narrows when one is named', async () => {
    const all = await req('GET', '/api/accounting/accounts', { token: tokens.owner });
    assert.equal(all.status, 200, all.text.slice(0, 200));
    const businesses = new Set((all.json.data || []).map((a) => (a.business_id ? String(a.business_id) : 'SHARED')));
    assert.ok(businesses.has(String(electronics.id)) && businesses.has(String(furnitureId)),
      `the chart of accounts came back from one business only: ${JSON.stringify([...businesses])}`);

    const only = await req('GET', `/api/accounting/accounts?business_id=${furnitureId}`, { token: tokens.owner });
    const narrowed = (only.json.data || []);
    assert.ok(narrowed.length > 0, 'naming a business must still return that business');
    assert.ok(narrowed.every((a) => !a.business_id || String(a.business_id) === String(furnitureId)),
      'naming one business must not return another business\'s accounts');

    // AND THE ADMIN, who has neither a business nor a branch pinned, is the seat
    // that was blindest: no pin to fall back on, so the guess decided everything.
    const asAdmin = await req('GET', '/api/accounting/accounts', { token: tokens.admin });
    const adminBusinesses = new Set((asAdmin.json.data || []).map((a) => (a.business_id ? String(a.business_id) : 'SHARED')));
    assert.ok(adminBusinesses.has(String(electronics.id)) && adminBusinesses.has(String(furnitureId)),
      `the platform administrator saw one business's chart of accounts only: ${JSON.stringify([...adminBusinesses])}`);
  });

  await t.test('the VAT summary counts both businesses\' sales', async () => {
    const r = await req('GET', '/api/accounting/vat', { token: tokens.owner });
    assert.equal(r.status, 200, r.text.slice(0, 240));
    assert.equal(Number(r.json.output.sales), 2,
      `the VAT summary saw ${r.json.output.sales} sale(s) of the 2 that exist — a return filed from this would be short`);

    const one = await req('GET', `/api/accounting/vat?business_id=${furnitureId}`, { token: tokens.owner });
    assert.equal(Number(one.json.output.sales), 1, 'naming one business must report that business alone');
  });

  await t.test('the sales report and the export carry both businesses', async () => {
    const r = await req('GET', '/api/reports/sales?group_by=BRANCH', { token: tokens.owner });
    assert.equal(r.status, 200, r.text.slice(0, 240));
    assert.equal(Number(r.json.totals.transactions), 2,
      `the sales report counted ${r.json.totals.transactions} of 2 transactions`);
    const branches = (r.json.rows || []).map((x) => String(x.group_key || x.key || x.branch || ''));
    assert.ok(branches.length >= 2, `the report grouped into ${branches.length} row(s): ${JSON.stringify(r.json.rows)}`);

    const csv = await fetch(`${BASE}/api/reports/export?report=SALES`, { headers: { Authorization: `Bearer ${tokens.owner}` } });
    const text = csv.ok ? await csv.text() : '';
    assert.ok(/SC-000001/.test(text) && /SC-000002/.test(text),
      `the export carried ${/SC-000001/.test(text) ? 'one business' : 'neither business'}: ${text.slice(0, 200)}`);
  });

  await t.test('the customer classes and the creditor book cover both businesses', async () => {
    const classes = await req('GET', '/api/customer-classes', { token: tokens.owner });
    const classBusinesses = new Set((classes.json.data || []).map((c) => (c.business_id ? String(c.business_id) : 'SHARED')));
    assert.ok(classBusinesses.has(String(electronics.id)) && classBusinesses.has(String(furnitureId)),
      `customer classes came back from one business only: ${JSON.stringify([...classBusinesses])}`);

    const creditors = await req('GET', '/api/creditors', { token: tokens.owner });
    const names = ids(creditors.json.creditors || [], 'name');
    assert.ok(names.includes('Scope Electronics Supplies') && names.includes('Scope Timber & Foam'),
      `the creditor book is missing a business's suppliers: ${JSON.stringify(names)}`);

    const only = await req('GET', `/api/creditors?business_id=${furnitureId}`, { token: tokens.owner });
    const narrowedNames = ids(only.json.creditors || [], 'name');
    assert.ok(narrowedNames.includes('Scope Timber & Foam') && !narrowedNames.includes('Scope Electronics Supplies'),
      `naming one business returned the wrong creditors: ${JSON.stringify(narrowedNames)}`);
  });

  await t.test('the sync pull that seeds a device carries every business it can reach', async () => {
    const r = await req('POST', '/api/sync/pull', { token: tokens.owner, body: { tables: ['products', 'product_categories'] } });
    assert.equal(r.status, 200, r.text.slice(0, 240));
    const products = (r.json.tables && r.json.tables.products && r.json.tables.products.rows) || [];
    const productBusinesses = new Set(products.map((p) => (p.business_id ? String(p.business_id) : 'SHARED')));
    assert.ok(products.length > 0, 'the pull returned no products at all');
    assert.ok(productBusinesses.has(String(electronics.id)) && productBusinesses.has(String(furnitureId)),
      `a device onboarding as the owner received one business's catalogue: ${JSON.stringify([...productBusinesses])}`);

    const named = await req('POST', '/api/sync/pull', { token: tokens.owner, body: { tables: ['products'], business_id: furnitureId } });
    const namedRows = (named.json.tables && named.json.tables.products && named.json.tables.products.rows) || [];
    const namedBusinesses = new Set(namedRows.map((p) => (p.business_id ? String(p.business_id) : 'SHARED')));
    assert.ok(!namedBusinesses.has(String(electronics.id)),
      'a pull that named a business still carried another business\'s products');
  });

  await t.test('a branch-pinned manager is still narrowed to their own shop', async () => {
    // THE FIX MUST NOT HAVE OPENED ANYTHING UP. A manager pinned to one branch of one
    // business names nothing and reaches nothing else — and the scope filter, not a
    // guess, is what must keep them there.
    const accounts = await req('GET', '/api/accounting/accounts', { token: tokens.manager });
    const seen = new Set((accounts.json.data || []).map((a) => (a.business_id ? String(a.business_id) : 'SHARED')));
    assert.ok(!seen.has(String(furnitureId)),
      `a manager of the electronics shop reached the furniture business: ${JSON.stringify([...seen])}`);

    const creditors = await req('GET', '/api/creditors', { token: tokens.manager });
    const names = ids(creditors.json.data || [], 'name');
    assert.ok(!names.includes('Scope Timber & Foam'),
      `a manager of the electronics shop reached the furniture creditor book: ${JSON.stringify(names)}`);
  });
});
