'use strict';
// =====================================================================
// test/integration/settings.test.js — A SETTING SAVES, AND IT DOES SOMETHING
// =====================================================================
// The Settings screen is the last place a defect can hide behind a success
// message. A control whose key is wrong does not fail: the request is accepted,
// the toast says "Settings saved", and the system behaves exactly as before. The
// owner has no way to tell the difference between "the system obeys me" and "the
// system has ignored me for a year".
//
// This file asserts the round trip for the settings that had no home until now,
// and then asserts the BEHAVIOUR each one governs — because a value that is stored
// and not read is the same lie in a different place:
//
//   `credit_grace_days`              how late a debtor must be before the counter
//                                    warns, measured from the DUE DATE
//   `instalment_default_after_days`  days of arrears that make a plan a failure
//   `instalment_default_after_missed` how many missed instalments do the same
//   `receipt_footer_text`            the line printed on every receipt, settable
//                                    only from the branding screen before
//
// Plus the two ways the write path lied: a key that is not a setting was silently
// ignored, and a settings key that does not exist could be READ by a route, where
// the expression is `undefined` and whatever the code decided after `||` wins.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.SETTINGS_PORT || 8821);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(ROOT, '.data', 'settings-test.db');

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

test('settings: the round trip, and the behaviour behind it', async (t) => {
  for (const suffix of ['', '-wal', '-shm', '.jwt']) {
    try { fs.rmSync(DB_FILE + suffix, { force: true }); } catch (e) { /* absent is fine */ }
  }
  const { openDatabase, migrate } = require(path.join(ROOT, 'server/lib/db'));
  const provisioning = require(path.join(ROOT, 'server/services/provisioningService'));
  const { newId } = require(path.join(ROOT, 'domain/crypto'));
  const { addDays, watToday } = require(path.join(ROOT, 'domain/time'));

  const db = openDatabase({ file: DB_FILE });
  await migrate(db);
  await provisioning.provisionDeployment(db, {
    businessName: 'Settings Electronics Ltd',
    profileCode: 'ELECTRONICS',
    ownerName: 'Settings Owner', ownerUsername: 'st-owner', ownerPin: '12345',
    adminUsername: 'st-admin', adminPin: '12345',
    branches: [
      { name: 'Wuse Store', code: 'ST-WUS', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 30000,
        manager: { name: 'Wuse Manager', username: 'st-manager', pin: '22222', job_title: 'Branch Manager' } },
    ],
  });
  const branch = await db.first("SELECT * FROM branches WHERE code = 'ST-WUS'");
  const business = await db.first("SELECT * FROM businesses WHERE name = 'Settings Electronics Ltd'");
  const owner = await db.first("SELECT * FROM users WHERE username = 'st-owner'");

  // A CUSTOMER ON 30-DAY TERMS. The due date is the point of the middle subtest:
  // the charge was raised TODAY, so it cannot be overdue — but the money was due
  // fifteen days AGO, so it is overdue by fifteen days, and the grace period is
  // compared against that, not against the date of the sale.
  const customerId = newId();
  await db.run(`INSERT INTO customers (id, business_id, branch_id, name, phone, credit_limit, credit_balance,
                                       created_at, updated_at, is_deleted)
                VALUES (?,?,?,?,?,?,?, datetime('now'), datetime('now'), 0)`,
  [customerId, business.id, branch.id, 'Alhaji Bello Interiors', '08030000000', 500000, 120000]);
  const saleId = newId();
  await db.run(`INSERT INTO sales (id, business_id, branch_id, receipt_no, customer_id, customer_name, sale_type,
                                   status, subtotal, total, amount_paid, balance_due, due_date, payment_method,
                                   sold_at, created_at, updated_at, is_deleted)
                VALUES (?,?,?,?,?,?, 'CREDIT', 'COMPLETED', ?, ?, ?, ?, ?, 'CREDIT', ?, datetime('now'), datetime('now'), 0)`,
  [saleId, business.id, branch.id, 'ST-000001', customerId, 'Alhaji Bello Interiors',
    120000, 120000, 0, 120000, addDays(watToday(), -15), `${watToday()} 09:30:00`]);
  await db.run(`INSERT INTO debtor_ledger (id, branch_id, business_id, customer_id, entry_type, reference_id,
                                           amount, balance_after, due_date, notes, created_at, updated_at, is_deleted)
                VALUES (?,?,?,?, 'SALE', ?, ?, ?, ?, 'Credit sale', datetime('now'), datetime('now'), 0)`,
  [newId(), branch.id, business.id, customerId, saleId, 120000, 120000, addDays(watToday(), -15)]);
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
  for (const [who, username, pin] of [['owner', 'st-owner', '12345'], ['manager', 'st-manager', '22222']]) {
    const r = await req('POST', '/api/auth/login', { body: { username, pin } });
    assert.equal(r.status, 200, `${username} could not sign in: ${r.text.slice(0, 200)}`);
    tokens[who] = r.json.token;
  }

  const settings = async (token = tokens.owner) => (await req('GET', '/api/settings', { token })).json.settings;

  // -------------------------------------------------------------------
  await t.test('the three settings the code always read are real, and can be set', async () => {
    const before = await settings();
    assert.equal(Number(before.credit_grace_days), 0, 'the default grace is the fallback the code was already using');
    assert.equal(Number(before.instalment_default_after_days), 60);
    assert.equal(Number(before.instalment_default_after_missed), 3);

    const saved = await req('PUT', '/api/settings', {
      token: tokens.owner,
      body: { credit_grace_days: 30, instalment_default_after_days: 90, instalment_default_after_missed: 4 },
    });
    assert.equal(saved.status, 200, saved.text.slice(0, 300));

    const after = await settings();
    assert.equal(Number(after.credit_grace_days), 30);
    assert.equal(Number(after.instalment_default_after_days), 90);
    assert.equal(Number(after.instalment_default_after_missed), 4);

    // THE CHANGE IS NAMED, WITH ITS PREVIOUS VALUE. "Who decided a debtor may be
    // thirty days late?" has to be answerable, and the answer is in this response
    // and in the audit trail behind it.
    assert.equal(Number(saved.json.changes.credit_grace_days.from), 0, 'the change names what the value was');
    assert.equal(Number(saved.json.changes.credit_grace_days.to), 30, 'the change names what the value became');
    assert.match(String(saved.json.message), /credit grace days/i, 'the success message names the setting that changed');

    const audit = await req('GET', '/api/audit?action=SETTINGS_UPDATED', { token: tokens.owner });
    const rows = audit.json.data || [];
    assert.ok(rows.length > 0, 'a settings change must appear in the audit trail');
  });

  await t.test('the grace period changes when the counter warns, measured from the DUE date', async () => {
    // Fifteen days late, so with a grace of 0 the warning is raised...
    await req('PUT', '/api/settings', { token: tokens.owner, body: { credit_grace_days: 0 } });
    const warned = await req('GET', `/api/customers/${customerId}`, { token: tokens.owner });
    assert.equal(warned.status, 200, warned.text.slice(0, 200));
    assert.ok(warned.json.credit.warning,
      'fifteen days past the due date with no grace period must raise the warning');

    // ...and with a grace of 30 it is not, because fifteen is inside it.
    await req('PUT', '/api/settings', { token: tokens.owner, body: { credit_grace_days: 30 } });
    const quiet = await req('GET', `/api/customers/${customerId}`, { token: tokens.owner });
    assert.equal(quiet.json.credit.warning, null,
      'a debtor inside the grace period is not flagged — the owner said thirty days is acceptable');

    // AND IT IS THE DUE DATE, NOT THE SALE DATE. The charge was raised today; only
    // the due date is in the past. If the ageing fell back to `created_at` this
    // warning could not exist at all.
    await req('PUT', '/api/settings', { token: tokens.owner, body: { credit_grace_days: 0 } });
    const again = await req('GET', `/api/customers/${customerId}`, { token: tokens.owner });
    assert.ok(again.json.credit.warning, 'the warning must come back when the grace period is removed');

    // The debtors list and the customer page must agree — they used to differ, the
    // list dropping the setting and the page applying it.
    // The debtors book answers with `debtors`, not `data` — every list on this API
    // says `data` except the two books (debtors, creditors) and the reports, which
    // say what they are.
    const list = await req('GET', '/api/customers/debtors', { token: tokens.owner });
    const row = (list.json.debtors || []).find((c) => String(c.id) === String(customerId));
    assert.ok(row, 'the debtor must appear on the debtors list');
    assert.equal(Boolean(row.warning), Boolean(again.json.credit.warning),
      'the debtors list and the customer page disagree about whether this debt is a problem');
  });

  await t.test('the instalment thresholds reach the trigger', async () => {
    const { defaultTrigger } = require(path.join(ROOT, 'domain/instalments'));
    // Read back through the API, which is the whole point: these are the numbers a
    // route hands the domain, not numbers this test made up.
    await req('PUT', '/api/settings', {
      token: tokens.owner,
      body: { instalment_default_after_days: 90, instalment_default_after_missed: 4 },
    });
    const s = await settings();
    const plan = { daysOverdue: 89, overdueCount: 3 };
    assert.equal(defaultTrigger({ plan, settings: s, today: watToday() }), null,
      '89 days of arrears with a 90-day threshold and 3 misses of 4 must not trigger');
    const fired = defaultTrigger({ plan: { daysOverdue: 90, overdueCount: 0 }, settings: s, today: watToday() });
    assert.ok(fired && fired.code === 'PLAN_DEFAULT_TRIGGERED', '90 days of arrears must trigger at a 90-day threshold');

    // The DEFAULT really is the default: a deployment that has never touched these
    // behaves the way the domain's fallbacks always did.
    const fallback = defaultTrigger({ plan: { daysOverdue: 60, overdueCount: 0 }, settings: {}, today: watToday() });
    assert.ok(fallback, '60 days of arrears triggers with no settings at all — the documented fallback');
  });

  await t.test('the receipt footer is settable from settings, and reaches the receipt', async () => {
    const saved = await req('PUT', '/api/settings', {
      token: tokens.owner,
      body: { receipt_footer_text: 'Thank you — goods exchanged within 7 days with this receipt.' },
    });
    assert.equal(saved.status, 200, saved.text.slice(0, 300));
    const s = await settings();
    assert.match(String(s.receipt_footer_text), /goods exchanged within 7 days/);

    // The branding endpoint reads the same column, and the client reads it from
    // there for the printed receipt — the two must not be able to disagree.
    const branding = await req('GET', '/api/branding', { token: tokens.owner });
    assert.match(String(branding.json.receiptFooter || ''), /goods exchanged within 7 days/,
      'the settings screen and the branding endpoint read different values for the receipt footer');
  });

  await t.test('a key that is not a setting is refused, not silently ignored', async () => {
    // The name the screen used to send. It must be an error, because the alternative
    // is an owner who believes their receipt footer is set.
    const wrong = await req('PUT', '/api/settings', { token: tokens.owner, body: { receipt_footer: 'ignored?' } });
    assert.equal(wrong.status, 400, `a misspelled setting was accepted: ${wrong.text.slice(0, 200)}`);
    assert.equal(wrong.json.code, 'UNKNOWN_SETTING');
    assert.match(wrong.json.error, /receipt_footer/);

    // And nothing else in the same request is applied either — a partial write
    // reported as a failure is worse than either.
    const mixed = await req('PUT', '/api/settings', {
      token: tokens.owner,
      body: { receipt_footer: 'x', vat_rate_percent: 12.5 },
    });
    assert.equal(mixed.status, 400);
    assert.equal(Number((await settings()).vat_rate_percent), 7.5, 'a refused request must have changed nothing');
  });

  await t.test('only an owner may change settings, and a manager is told so', async () => {
    const r = await req('PUT', '/api/settings', { token: tokens.manager, body: { vat_rate_percent: 12.5 } });
    assert.equal(r.status, 403, `a manager changed settings: ${r.text.slice(0, 200)}`);
    assert.equal(r.json.code, 'ROLE_REQUIRED');
  });

  await t.test('every value survives a restart, because it is a column and not a cache', async () => {
    await req('PUT', '/api/settings', {
      token: tokens.owner,
      body: { credit_grace_days: 14, instalment_default_after_days: 45, instalment_default_after_missed: 2 },
    });
    const check = openDatabase({ file: DB_FILE });
    const row = await check.first('SELECT credit_grace_days, instalment_default_after_days, instalment_default_after_missed FROM client_settings WHERE id = 1');
    await check.close();
    assert.equal(Number(row.credit_grace_days), 14);
    assert.equal(Number(row.instalment_default_after_days), 45);
    assert.equal(Number(row.instalment_default_after_missed), 2);
  });
});
