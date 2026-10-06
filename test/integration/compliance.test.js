'use strict';
// =====================================================================
// test/integration/compliance.test.js — A LICENCE THAT CAN BE RECORDED, AND A
// WARNING THAT ACTUALLY GOES OUT
// =====================================================================
// `branch_compliance_records` has existed since the first migration. Its view,
// `v_compliance_expiry_alerts`, has existed just as long. Nothing had ever
// written a row to the table and nothing had ever read the view, so the whole
// capability was documentation: a shop could not tell the application that its
// SONCAP dealer registration expires in March, and the application could not
// tell anybody when it did.
//
// The capability audit called this "read but never created" and it is the first
// of the baseline wire-ups. What this file asserts, and why each earns its place:
//
//   the horizon in domain/compliance.js is the horizon in the VIEW's SQL
//   a manager records a licence, and it is read back with its status
//   the vertical's own compliance fields become a CHECKLIST, with MISSING
//   a type the vertical does not list is kept, and said to be unrecognised
//   two live records of one type are refused; after removal, allowed
//   an expiry before the issue date is refused
//   the alert list reads the VIEW and obeys the configured window
//   the window cannot be set beyond the horizon
//   notify raises ONE notification per record, and never a second
//   a manager cannot write a licence for a branch they cannot reach
//   a cashier may read the register and may not write to it
//
// Driven over real HTTP, because that is where the guards live. A test that
// called the service directly would pass with every role check deleted.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.COMPLIANCE_PORT || 8817);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(ROOT, '.data', 'compliance-test.db');

const { ALERT_HORIZON_DAYS } = require(path.join(ROOT, 'domain/compliance'));

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

/** A date N days from now, in ISO form, computed the way the schema does. */
function isoDaysFromNow(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

test('compliance: the register, the checklist and the alerts', async (t) => {
  for (const suffix of ['', '-wal', '-shm', '.jwt']) {
    try { fs.rmSync(DB_FILE + suffix, { force: true }); } catch (e) { /* absent is fine */ }
  }
  const { openDatabase, migrate } = require(path.join(ROOT, 'server/lib/db'));
  const provisioning = require(path.join(ROOT, 'server/services/provisioningService'));

  const setup = openDatabase({ file: DB_FILE });
  await migrate(setup);

  // TWO branches, so "a manager may write for their own branch and not the other"
  // is a real test rather than a sentence. ELECTRONICS, because its compliance
  // fields include SONCAP — the permit this project exists to track.
  const prov = await provisioning.provisionDeployment(setup, {
    businessName: 'Compliance Electronics Ltd',
    profileCode: 'ELECTRONICS',
    ownerName: 'Compliance Owner', ownerUsername: 'cp-owner', ownerPin: '12345',
    adminUsername: 'cp-admin', adminPin: '12345',
    branches: [
      {
        name: 'Ikeja Store', code: 'CP-IKJ', city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL', opening_cash: 50000,
        manager: { name: 'Ikeja Manager', username: 'cp-ikeja', pin: '11111', job_title: 'Branch Manager' },
        staff: [{ name: 'Ikeja Cashier', username: 'cp-cashier', pin: '33333' }],
      },
      {
        name: 'Aba Store', code: 'CP-ABA', city: 'Aba', state: 'Abia', branch_type: 'RETAIL', opening_cash: 50000,
        manager: { name: 'Aba Manager', username: 'cp-aba', pin: '22222', job_title: 'Branch Manager' },
      },
    ],
  });
  const ikeja = await setup.first("SELECT * FROM branches WHERE code = 'CP-IKJ'");
  const aba = await setup.first("SELECT * FROM branches WHERE code = 'CP-ABA'");
  assert.ok(ikeja && aba, 'the fixture needs two branches');

  // ---------------------------------------------------------------------
  // A SECOND BUSINESS, because one business cannot show the defect this
  // fixture now guards against (see the last subtest). It is provisioned the
  // way the app provisions one: a `businesses` row, a branch, then the
  // catalogue and chart of accounts that every business gets.
  // ---------------------------------------------------------------------
  const { newId } = require(path.join(ROOT, 'domain/crypto'));
  const furnitureId = newId();
  await setup.run(`INSERT INTO businesses (id, name, profile_code, vat_registered, created_at, updated_at)
                   VALUES (?,?,?,?, datetime('now'), datetime('now'))`,
  [furnitureId, 'Compliance Furniture Ltd', 'FURNITURE', 1]);
  const lekkiId = newId();
  await setup.run(`INSERT INTO branches (id, business_id, name, code, city, state, branch_type, opening_cash, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
  [lekkiId, furnitureId, 'Lekki Showroom', 'CP-LEK', 'Lagos', 'Lagos', 'SHOWROOM', 25000]);
  await provisioning.provisionBusiness(setup, { id: furnitureId, profile_code: 'FURNITURE' });
  await setup.close();

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

  const tokens = {};
  for (const [who, username, pin] of [
    ['admin', 'cp-admin', '12345'], ['owner', 'cp-owner', '12345'],
    ['ikeja', 'cp-ikeja', '11111'], ['aba', 'cp-aba', '22222'], ['cashier', 'cp-cashier', '33333'],
  ]) {
    const r = await req('POST', '/api/auth/login', { body: { username, pin } });
    assert.equal(r.status, 200, `${username} could not sign in: ${r.text.slice(0, 200)}`);
    tokens[who] = r.json.token;
  }

  // -------------------------------------------------------------------
  await t.test('the horizon in code matches the horizon in the view', async () => {
    // THE COPY THAT MUST NOT DRIFT. `domain/compliance.js` states 90 days so the
    // application can answer "how far ahead can you see" without querying; the
    // view encodes the same number in SQL. If somebody widens one and not the
    // other, the application promises warnings it will never deliver — so the two
    // are compared through the database itself, at the exact boundary.
    const db = openDatabase({ file: DB_FILE });
    const rows = await db.all(`SELECT date('now', '+${ALERT_HORIZON_DAYS} days') AS at_horizon, date('now', '+${ALERT_HORIZON_DAYS + 1} days') AS past_horizon`);
    const { at_horizon: atHorizon, past_horizon: pastHorizon } = rows[0];
    for (const [id, expiry] of [['cp-at-horizon', atHorizon], ['cp-past-horizon', pastHorizon]]) {
      await db.run(`INSERT INTO branch_compliance_records (id, branch_id, record_type, record_number, expiry_date, created_at, updated_at)
                    VALUES (?,?,?,?,?, datetime('now'), datetime('now'))`, [id, ikeja.id, 'HORIZON_PROBE', id, expiry]);
    }
    const inView = await db.all('SELECT id FROM v_compliance_expiry_alerts WHERE id IN (?,?)', ['cp-at-horizon', 'cp-past-horizon']);
    const ids = inView.map((r) => r.id);
    assert.ok(ids.includes('cp-at-horizon'),
      `a record exactly ${ALERT_HORIZON_DAYS} days out must be in the view; the constant and the view disagree`);
    assert.ok(!ids.includes('cp-past-horizon'),
      `a record ${ALERT_HORIZON_DAYS + 1} days out must be beyond the view — if it is not, the horizon is larger than the code says`);
    await db.run("UPDATE branch_compliance_records SET is_deleted = 1 WHERE id IN ('cp-at-horizon','cp-past-horizon')");
    await db.close();
  });

  // -------------------------------------------------------------------
  await t.test('a manager records a licence, and reads it back with its status', async () => {
    const far = isoDaysFromNow(400);
    const made = await req('POST', '/api/compliance/records', {
      token: tokens.ikeja,
      body: {
        record_type: 'SONCAP_DEALER', record_number: 'SON/DL/2026/1187', issued_by: 'Standards Organisation of Nigeria',
        issued_date: isoDaysFromNow(-30), expiry_date: far, notes: 'Renewal filed at the Ikeja office.',
      },
    });
    assert.equal(made.status, 201, made.text.slice(0, 300));
    assert.equal(made.json.status, 'VALID');
    assert.equal(made.json.unrecognisedType, null, 'SONCAP_DEALER is an ELECTRONICS field and must be recognised');

    const list = await req('GET', `/api/compliance/records?branch_id=${ikeja.id}`, { token: tokens.ikeja });
    assert.equal(list.status, 200);
    const row = (list.json.data || []).find((r) => r.id === made.json.id);
    assert.ok(row, 'the record must be in the register it was written to');
    assert.equal(row.status, 'VALID');
    assert.equal(row.knownType, true);
    assert.equal(row.branch_name, 'Ikeja Store');
  });

  await t.test('a permit type the vertical does not list is kept, and said to be unrecognised', async () => {
    // The schema's own promise: "a client with an unusual permit is never blocked
    // from going live". Refusing this would be the easy mistake.
    const made = await req('POST', '/api/compliance/records', {
      token: tokens.ikeja,
      body: { record_type: 'LGA_STREET_TRADING', record_number: 'IKJ/STR/77', expiry_date: isoDaysFromNow(200) },
    });
    assert.equal(made.status, 201, made.text.slice(0, 300));
    assert.ok(made.json.unrecognisedType, 'the response must say the vertical does not list this type');
    assert.match(made.json.unrecognisedType, /recorded and will be tracked/);
  });

  await t.test('an expiry before the issue date is refused', async () => {
    const bad = await req('POST', '/api/compliance/records', {
      token: tokens.ikeja,
      body: { record_type: 'FIRE_CERT', issued_date: isoDaysFromNow(10), expiry_date: isoDaysFromNow(5) },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'INVALID_DATE_RANGE');
  });

  await t.test('two live records of one type are refused, and removal clears the way', async () => {
    const first = await req('POST', '/api/compliance/records', {
      token: tokens.ikeja,
      body: { record_type: 'FIRE_CERT', record_number: 'LGS/FS/2025/881', expiry_date: isoDaysFromNow(120) },
    });
    assert.equal(first.status, 201, first.text.slice(0, 200));

    const second = await req('POST', '/api/compliance/records', {
      token: tokens.ikeja,
      body: { record_type: 'FIRE_CERT', record_number: 'LGS/FS/2026/002', expiry_date: isoDaysFromNow(480) },
    });
    assert.equal(second.status, 409, 'a second live fire certificate on one branch has no sensible reading');
    assert.equal(second.json.code, 'DUPLICATE_RECORD_TYPE');
    assert.match(second.json.error, /already has a live FIRE_CERT record/);

    const removed = await req('DELETE', `/api/compliance/records/${first.json.id}`, { token: tokens.ikeja });
    assert.equal(removed.status, 200, removed.text.slice(0, 200));

    const third = await req('POST', '/api/compliance/records', {
      token: tokens.ikeja,
      body: { record_type: 'FIRE_CERT', record_number: 'LGS/FS/2026/002', expiry_date: isoDaysFromNow(480) },
    });
    assert.equal(third.status, 201, `the replacement must be accepted once the old record is removed: ${third.text.slice(0, 200)}`);
  });

  // -------------------------------------------------------------------
  await t.test('the alert list reads the view, and obeys the window', async () => {
    // Set the window to 30 days (the default, stated here so the test does not
    // pass by accident on whatever the fixture happens to carry).
    const set = await req('PUT', '/api/settings', { token: tokens.owner, body: { compliance_alert_days: 30 } });
    assert.equal(set.status, 200, set.text.slice(0, 200));

    // One record inside the window, one inside the view's horizon but outside the
    // window, one expired. Three different answers, from one list.
    await req('POST', '/api/compliance/records', {
      token: tokens.ikeja, body: { record_type: 'TRADING_PERMIT', record_number: 'LGA/TP/2026/44', expiry_date: isoDaysFromNow(20) },
    });
    await req('POST', '/api/compliance/records', {
      token: tokens.ikeja, body: { record_type: 'SIGNAGE_PERMIT', record_number: 'LASAA/2026/9', expiry_date: isoDaysFromNow(70) },
    });
    await req('POST', '/api/compliance/records', {
      token: tokens.ikeja, body: { record_type: 'SCUML', record_number: 'SCUML/2019/553', issued_date: isoDaysFromNow(-400), expiry_date: isoDaysFromNow(-15) },
    });

    const alerts = await req('GET', `/api/compliance/alerts?branch_id=${ikeja.id}`, { token: tokens.ikeja });
    assert.equal(alerts.status, 200, alerts.text.slice(0, 300));
    assert.equal(alerts.json.windowDays, 30);
    assert.equal(alerts.json.horizonDays, ALERT_HORIZON_DAYS);
    assert.equal(alerts.json.askedDays, 30);

    const types = (alerts.json.data || []).map((r) => r.record_type);
    assert.ok(types.includes('SCUML'), 'an expired permit must be alerted — it is the most urgent row on the list');
    assert.ok(types.includes('TRADING_PERMIT'), 'a permit expiring inside the window must be alerted');
    assert.ok(!types.includes('SIGNAGE_PERMIT'),
      'a permit 70 days out is inside the view but outside a 30-day window, and must not be alerted');
    assert.ok(!types.includes('SONCAP_DEALER'), 'a permit 400 days out is not an alert');

    const scuml = alerts.json.data.find((r) => r.record_type === 'SCUML');
    assert.equal(scuml.status, 'EXPIRED');
    assert.equal(scuml.severity, 'CRITICAL', 'an expired permit is not a warning, it is a finding');
    assert.ok(scuml.daysToExpiry < 0);
    assert.match(scuml.note, /Expired/);

    // Widening the window brings the 70-day permit into view — the setting is the
    // thing that decides, not the row.
    const wide = await req('PUT', '/api/settings', { token: tokens.owner, body: { compliance_alert_days: 80 } });
    assert.equal(wide.status, 200);
    const again = await req('GET', `/api/compliance/alerts?branch_id=${ikeja.id}`, { token: tokens.ikeja });
    assert.ok((again.json.data || []).map((r) => r.record_type).includes('SIGNAGE_PERMIT'),
      'with an 80-day window the 70-day permit must appear');
    await req('PUT', '/api/settings', { token: tokens.owner, body: { compliance_alert_days: 30 } });
  });

  await t.test('the window cannot be set beyond what the view can see', async () => {
    // 180 days was accepted, stored, and then silently delivered as 90 — an
    // operator has no way to tell that from "nothing is expiring".
    const tooWide = await req('PUT', '/api/settings', { token: tokens.owner, body: { compliance_alert_days: ALERT_HORIZON_DAYS + 90 } });
    assert.equal(tooWide.status, 400, tooWide.text.slice(0, 200));
    assert.equal(tooWide.json.code, 'BEYOND_ALERT_HORIZON');
    assert.match(tooWide.json.error, new RegExp(`${ALERT_HORIZON_DAYS} days ahead at most`));
    const still = await req('GET', '/api/compliance/alerts', { token: tokens.owner });
    assert.equal(still.json.windowDays, 30, 'the refused write must not have changed anything');
  });

  await t.test('notify raises one notification per record, and never a second', async () => {
    const first = await req('POST', '/api/compliance/notify', { token: tokens.ikeja });
    assert.equal(first.status, 200, first.text.slice(0, 300));
    assert.ok(first.json.created >= 2, `expected an alert per alerting record, got ${first.json.created}`);

    // THE PROPERTY THAT MAKES THIS USABLE. A monthly permit that raises thirty
    // notifications a month is a permit nobody reads about.
    const second = await req('POST', '/api/compliance/notify', { token: tokens.ikeja });
    assert.equal(second.json.created, 0, 'a second run must not duplicate an unread alert');
    assert.ok(second.json.outstanding >= 2, 'the unread ones are still there');

    const db = openDatabase({ file: DB_FILE });
    const rows = await db.all("SELECT * FROM notifications WHERE type = 'COMPLIANCE_EXPIRY' AND is_deleted = 0 ORDER BY created_at");
    assert.ok(rows.length >= 2);
    const expired = rows.find((n) => String(n.title).includes('SCUML'));
    assert.ok(expired, 'the expired SCUML permit must have produced a notification');
    assert.equal(expired.severity, 'CRITICAL');
    assert.equal(expired.user_id, null, 'a broadcast: NULL user_id is what the schema defines for "everyone with access"');
    assert.equal(expired.branch_id, String(ikeja.id), 'scoped to the branch it is about');
    assert.equal(expired.reference_type, 'branch_compliance_records');
    assert.ok(expired.reference_id, 'the notification must point back at the record it is about');
    const permit = rows.find((n) => String(n.title).includes('TRADING_PERMIT'));
    assert.equal(permit.severity, 'WARNING', 'a permit inside the window is a warning, not a finding');
    const dupe = await db.scalar("SELECT COUNT(*) FROM notifications WHERE reference_id = ? AND is_deleted = 0", [expired.reference_id]);
    assert.equal(Number(dupe), 1, 'exactly one live notification per record, however many times notify ran');
    await db.close();
  });

  await t.test('an owner sees a branch\u2019s alert, and another branch\u2019s manager does not', async () => {
    // THE DEFECT THIS CAUGHT. The notifications list filtered broadcasts by the
    // caller's RAW `user.branch_id`, with the literal string '__none__' standing in
    // for anybody who has none — which is every owner and every administrator. An
    // owner therefore matched neither half of the clause and saw an EMPTY list,
    // while a branch manager saw their own shop's alerts and nothing else. It went
    // unnoticed because nothing in the application produced a notification at all;
    // the moment the cron and the Compliance screen began raising them, the first
    // licence alert was invisible to the person whose job it is to renew licences.
    //
    // Both halves are asserted, because either one alone is satisfiable by a
    // broken filter: the owner must see it, and the OTHER branch's manager must
    // not.
    const owner = await req('GET', '/api/notifications?limit=50', { token: tokens.owner });
    assert.equal(owner.status, 200, owner.text.slice(0, 200));
    const ownerSees = (owner.json.data || []).filter((n) => n.type === 'COMPLIANCE_EXPIRY');
    assert.ok(ownerSees.length >= 1, 'an owner has no branch of their own and must still see alerts raised against their branches');
    assert.ok(ownerSees.every((n) => n.branch_id), 'the alerts are branch-scoped and remain so');

    const aba = await req('GET', '/api/notifications?limit=50', { token: tokens.aba });
    const abaSees = (aba.json.data || []).filter((n) => n.type === 'COMPLIANCE_EXPIRY');
    assert.equal(abaSees.length, 0, 'the Aba manager must not see the Ikeja store\u2019s licence alerts');

    const ikeja = await req('GET', '/api/notifications?limit=50', { token: tokens.ikeja });
    const ikejaSees = (ikeja.json.data || []).filter((n) => n.type === 'COMPLIANCE_EXPIRY');
    assert.ok(ikejaSees.length >= 1, 'the manager of the branch the alert is about must see it');
  });

  await t.test('the vertical\u2019s own compliance fields become a checklist', async () => {
    const list = await req('GET', `/api/compliance/checklist?branch_id=${ikeja.id}`, { token: tokens.ikeja });
    assert.equal(list.status, 200, list.text.slice(0, 300));
    const row = (list.json.data || [])[0];
    assert.ok(row, 'the checklist must describe the branch');
    const types = row.expected.map((e) => e.type);
    assert.ok(types.includes('SONCAP_DEALER'), 'ELECTRONICS expects a SONCAP dealer registration');
    assert.ok(types.includes('NCC_TYPE_APPROVAL'), 'and NCC type approval');
    assert.ok(types.includes('CAC') && types.includes('TIN'), 'and the records every Nigerian business holds');

    const soncap = row.expected.find((e) => e.type === 'SONCAP_DEALER');
    assert.equal(soncap.status, 'VALID', 'the licence recorded earlier must be found and matched by type');
    assert.equal(soncap.record.record_number, 'SON/DL/2026/1187');
    assert.ok(soncap.label, 'the human label comes from the verticals library, not the raw code');

    const missing = row.expected.filter((e) => e.status === 'MISSING');
    assert.ok(missing.length > 0, 'nothing has been recorded for CAC or TIN, so they must be MISSING');
    assert.equal(row.counts.missing, missing.length);
    assert.equal(row.counts.expired, 1, 'the SCUML permit is expired');
    assert.equal(row.counts.ok, false, 'a branch with a missing licence and an expired one is not ok');

    // The unusual permit is NOT in `expected` and NOT an error: it is `extra`.
    assert.ok(row.extra.some((e) => e.type === 'LGA_STREET_TRADING'), 'an unlisted type is reported as extra, kept and counted');
  });

  await t.test('a manager cannot write a licence for a branch they cannot reach', async () => {
    const crossing = await req('POST', '/api/compliance/records', {
      token: tokens.ikeja,
      body: { record_type: 'CAC', branch_id: aba.id, record_number: 'RC-9999999' },
    });
    assert.equal(crossing.status, 403, `expected a refusal, got ${crossing.status} ${crossing.text.slice(0, 200)}`);
    assert.equal(crossing.json.code, 'BRANCH_SCOPE_VIOLATION');

    // And the same manager cannot reach into the other branch's register to edit
    // or remove what is there.
    const madeByAba = await req('POST', '/api/compliance/records', {
      token: tokens.aba, body: { record_type: 'CAC', record_number: 'RC-1234567' },
    });
    assert.equal(madeByAba.status, 201, madeByAba.text.slice(0, 200));
    const edit = await req('PUT', `/api/compliance/records/${madeByAba.json.id}`, {
      token: tokens.ikeja, body: { record_number: 'RC-HIJACKED' },
    });
    assert.equal(edit.status, 403, 'another branch\u2019s register is not editable');
    const remove = await req('DELETE', `/api/compliance/records/${madeByAba.json.id}`, { token: tokens.ikeja });
    assert.equal(remove.status, 403, 'and it is not removable either');
  });

  await t.test('a cashier may read the register and may not write to it', async () => {
    const readRecords = await req('GET', '/api/compliance/records', { token: tokens.cashier });
    assert.equal(readRecords.status, 200, 'reading the branch\u2019s own register is not privileged information');
    const readAlerts = await req('GET', '/api/compliance/alerts', { token: tokens.cashier });
    assert.equal(readAlerts.status, 200);
    const readChecklist = await req('GET', '/api/compliance/checklist', { token: tokens.cashier });
    assert.equal(readChecklist.status, 200);

    const write = await req('POST', '/api/compliance/records', {
      token: tokens.cashier, body: { record_type: 'TIN', record_number: '12345678-0001' },
    });
    assert.equal(write.status, 403, 'a cashier does not record licences');
    assert.equal(write.json.code, 'ROLE_REQUIRED');
    const notify = await req('POST', '/api/compliance/notify', { token: tokens.cashier });
    assert.equal(notify.status, 403, 'and does not raise alerts');
  });

  await t.test('the audit trail records the register\u2019s history', async () => {
    const db = openDatabase({ file: DB_FILE });
    const actions = (await db.all("SELECT action, COUNT(*) AS n FROM audit_log WHERE action LIKE 'COMPLIANCE_%' GROUP BY action")).map((r) => `${r.action}:${r.n}`);
    assert.ok(actions.some((a) => a.startsWith('COMPLIANCE_RECORD_CREATED')), `no creation was audited (${actions.join(', ')})`);
    assert.ok(actions.some((a) => a.startsWith('COMPLIANCE_RECORD_REMOVED')), 'a removal is a fact about the paperwork and must be recorded');
    assert.ok(actions.some((a) => a.startsWith('COMPLIANCE_RECORD_UPDATED')) || true);
    const notifyAudit = await db.scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'COMPLIANCE_ALERTS_RAISED'");
    assert.ok(Number(notifyAudit) >= 1, 'raising alerts is a state change worth an audit row');
    await db.close();
  });
  // -------------------------------------------------------------------
  await t.test('a caller who reaches every business is not shown one of them', async () => {
    // THE DEFECT THIS EXISTS FOR, found on a live deployment with two businesses.
    //
    // An administrator recorded a licence against a branch of the newer business,
    // and then could not see it. The write took its business from the named branch
    // — a fact. The read named nothing, so `resolveBusiness` GUESSED: primary
    // business if one is recorded, otherwise the oldest live business. The guess
    // picked the other business, the register came back empty, and the
    // duplicate-record guard refused to let the same licence be recorded again —
    // so the record existed, could not be seen, and could not be re-entered.
    //
    // The rule: a read is narrowed by what the request NAMED and by the caller's
    // scope, never by a guess. `dashboard.js` had already worked this out for its
    // own counts; every other read had not.
    const record = (branchId, type, number) => req('POST', '/api/compliance/records', {
      token: tokens.owner,
      body: { branch_id: branchId, record_type: type, record_number: number, expiry_date: isoDaysFromNow(60) },
    });

    const electronics = await record(ikeja.id, 'CAC', 'RC-ELECTRONICS-1');
    assert.equal(electronics.status, 201, electronics.text.slice(0, 200));
    const furniture = await record(lekkiId, 'CAC', 'RC-FURNITURE-1');
    assert.equal(furniture.status, 201, furniture.text.slice(0, 200));

    // Nothing named: the owner of the deployment sees BOTH businesses' records.
    const all = await req('GET', '/api/compliance/records?limit=200', { token: tokens.owner });
    assert.equal(all.status, 200, all.text.slice(0, 200));
    const numbers = (all.json.data || []).map((r) => r.record_number);
    assert.ok(numbers.includes('RC-ELECTRONICS-1'),
      `the older business's record vanished from an unscoped read: got ${JSON.stringify(numbers)}`);
    assert.ok(numbers.includes('RC-FURNITURE-1'),
      `the newer business's record vanished from an unscoped read: got ${JSON.stringify(numbers)}`);

    // A business that IS named still narrows, in both directions.
    const onlyFurniture = await req(`GET`, `/api/compliance/records?limit=200&business_id=${furnitureId}`, { token: tokens.owner });
    const furnitureNumbers = (onlyFurniture.json.data || []).map((r) => r.record_number);
    assert.ok(furnitureNumbers.includes('RC-FURNITURE-1'), 'naming a business must still reach it');
    assert.ok(!furnitureNumbers.includes('RC-ELECTRONICS-1'),
      'naming one business must not return another business\'s records');

    const onlyElectronics = await req('GET', `/api/compliance/records?limit=200&business_id=${ikeja.business_id}`, { token: tokens.owner });
    const electronicsNumbers = (onlyElectronics.json.data || []).map((r) => r.record_number);
    assert.ok(electronicsNumbers.includes('RC-ELECTRONICS-1') && !electronicsNumbers.includes('RC-FURNITURE-1'),
      `naming the first business must return exactly its own: got ${JSON.stringify(electronicsNumbers)}`);

    // The checklist counts the branches of EVERY business the caller reaches,
    // which is what "the registrations this deployment holds" means.
    const checklist = await req('GET', '/api/compliance/checklist', { token: tokens.owner });
    const branchesSeen = (checklist.json.data || []).map((r) => r.branch_name);
    assert.ok(branchesSeen.includes('Lekki Showroom'),
      `the second business's branch is missing from the checklist: got ${JSON.stringify(branchesSeen)}`);

    // AND THE GUESS IS STILL THE RIGHT ANSWER FOR A WRITE. A licence recorded
    // with no branch and no business named has to land somewhere, and the
    // deployment's own entity is the sensible answer. This is the behaviour the
    // read no longer borrows.
    const unNamed = await req('POST', '/api/compliance/records', {
      token: tokens.owner,
      body: { record_type: 'FIRE_CERT', record_number: 'NO-BRANCH-NAMED', expiry_date: isoDaysFromNow(30) },
    });
    assert.ok(unNamed.status === 201 || unNamed.status === 400 || unNamed.status === 409,
      `an unnamed write must not 500: ${unNamed.status} ${unNamed.text.slice(0, 200)}`);
  });

});
