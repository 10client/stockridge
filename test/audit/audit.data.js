'use strict';
// =====================================================================
// test/audit/audit.data.js — DATA MANAGEMENT, BOTH DIRECTIONS
// =====================================================================
// BACK TO FRONT: call the endpoints the Plan screen calls, with the arguments the
// screen sends, and assert the contract the screen renders — not merely that the
// route answers.
//
// FRONT TO BACK: assert that the numbers the screen puts in front of a proprietor
// are TRUE of the database behind them: the retention rules report a window AND a
// count, the storage estimate says out loud that it is an estimate, the purge
// modes each carry the phrase a person must type, and the warning that deletion is
// permanent travels in the RESPONSE rather than only in the browser that rendered
// a modal.
//
// WHY A REFUSAL IS A CHECK AND NOT A NUISANCE. The whole feature is a decision
// about the business's records. If any seat can open it, then a cashier on a
// stolen phone can read how full the database is and which records could be let
// go — and, once G1c lands, call the endpoint that lets them go.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const num = (v) => (v == null ? null : Number(v));

runAudit('data', async (audit, d) => {
  const owner = d.owner || d.admin;
  // SEATS LIVE AT `d.seats.<as>` — the fixture's `as` key, not `d.manager`. Getting
  // this wrong does not fail loudly: `d.manager` is undefined, the role check below
  // skips, and the run reports "2 reported" instead of proving that a manager CAN
  // read it and a STAFF seat CANNOT. A skip here is the difference between a
  // permission boundary being tested and being assumed.
  const manager = (d.seats && d.seats.manager) || null;
  const staff = (d.seats && d.seats.staff) || null;

  // ===================================================================
  audit.section('A proprietor can see how full the shop is');
  // ===================================================================
  const status = await audit.captureAsync('the data-management status, as the Plan screen asks for it', async () => {
    const res = await owner.get('/api/data-management/status');
    assert.equal(res.status, 200, `status answered ${res.status} ${String(res.text).slice(0, 200)}`);
    return res.json;
  });

  await audit.check('the status reports capacity, the plan ceiling it is measured against, and a verdict', () => {
    const st = status.storage;
    assert.ok(st, 'no storage section in the response');
    assert.equal(st.available, true, `capacity could not be estimated: ${st.error || st.message}`);
    assert.ok(num(st.bytes) > 0, `bytes is ${st.bytes}`);
    assert.ok(num(st.megabytes) > 0, `megabytes is ${st.megabytes}`);
    assert.ok(num(st.limit_megabytes) > 0, `limit_megabytes is ${st.limit_megabytes} — a percentage with no ceiling is not a warning`);
    assert.ok(['OK', 'WARNING', 'CRITICAL'].includes(st.status), `status is "${st.status}"`);
    assert.ok(num(st.percent_used) >= 0 && num(st.percent_used) < 100,
      `percent_used is ${st.percent_used} on a working deployment`);
    audit.note(`${st.megabytes} MB of ${st.limit_megabytes} MB estimated (${st.percent_used}%) → ${st.status}`);
  });

  await audit.check('and it says in words that the figure is an estimate, with its assumptions attached', () => {
    // A proprietor acting on a measurement that was actually a model is the
    // failure this note prevents. Cloudflare does not expose a D1 database's size
    // to the Worker reading it, so the figure cannot be anything else.
    const a = status.storage.assumption;
    assert.ok(a, 'no assumptions attached to the estimate');
    assert.match(String(a.note || ''), /estimate/i, `the assumption note does not say it is an estimate: "${a.note}"`);
    assert.ok(num(a.emptySchemaBytes) > 0, 'the fixed floor of an empty schema is not reported — an estimate without it under-warns');
    assert.ok(num(a.overhead) >= 1, `the overhead factor is ${a.overhead}`);
    audit.note(`floor ${a.emptySchemaMegabytes} MB, overhead ×${a.overhead}`);
  });

  await audit.check('the message a proprietor reads is about the business, not about a database', () => {
    const msg = String(status.storage.message || '');
    assert.ok(msg.length > 20, `the message is "${msg}"`);
    if (status.storage.status === 'OK') assert.match(msg, /room|plenty/i, `status OK but the message says "${msg}"`);
    else assert.match(msg, /record|sales|upgrade|full/i, `status ${status.storage.status} but the message never says what it means for the shop: "${msg}"`);
  });

  // ===================================================================
  audit.section('What housekeeping would let go, and what it never touches');
  // ===================================================================
  await audit.check('every retention rule reports its window AND what it would remove right now', () => {
    const rules = (status.retention && status.retention.rules) || [];
    assert.ok(rules.length >= 3, `only ${rules.length} retention rule(s) reported`);
    for (const r of rules) {
      assert.ok(r.name, 'a rule with no name');
      assert.ok(Number(r.retainDays) > 0, `"${r.name}" has no window: ${r.retainDays}`);
      assert.equal(r.error, null, `"${r.name}" could not be counted: ${r.error}`);
      assert.ok(r.wouldRemove == null || Number(r.wouldRemove) >= 0, `"${r.name}" would remove ${r.wouldRemove}`);
      assert.ok(r.what && r.what.length > 10, `"${r.name}" does not say what it is`);
    }
    audit.note(rules.map((r) => `${r.name}: ${r.retainDays}d, ${r.wouldRemove} now`).join(' · '));
  });

  await audit.check('the rules name the windows this deployment actually uses', () => {
    const windows = (status.retention && status.retention.windows) || {};
    assert.ok(Number(windows.syncChangeLog) > 0, 'no window for the sync log');
    assert.ok(Number(windows.loginAttempts) > 0, 'no window for sign-in attempts');
    assert.ok(Number(windows.reviewedConflicts) > 0, 'no window for reviewed conflicts');
    // The reviewed/ unreviewed distinction is the one that must not be lost in
    // translation: an unreviewed conflict is an unanswered question about a
    // customer record and is never removed at any age.
    const reviewed = ((status.retention.rules) || []).find((r) => /conflict/i.test(r.name));
    assert.ok(reviewed, 'no rule mentions conflicts');
    assert.match(String(reviewed.what), /unreviewed/i,
      `the conflict rule does not say unreviewed conflicts are kept: "${reviewed.what}" — that sentence is the difference between housekeeping and data loss`);
  });

  await audit.check('and the response itself warns that deletion is permanent', () => {
    const notice = String(status.retention_notice || '');
    assert.ok(notice.length > 60, `the retention notice is "${notice}"`);
    assert.match(notice, /permanent|export|backup/i, `the notice does not warn about permanence or exports: "${notice}"`);
    // IN THE RESPONSE, NOT ONLY IN THE SCREEN. A script or a future mobile client
    // must receive the warning too.
    audit.note('the warning travels with the API response, not only with the rendered modal');
  });

  // ===================================================================
  audit.section('The modes a purge will offer, and the phrase each one needs');
  // ===================================================================
  await audit.check('every mode carries a label, a description, what it keeps, and a confirmation phrase', () => {
    const modes = status.modes || [];
    assert.ok(modes.length >= 4, `only ${modes.length} mode(s) offered`);
    const codes = modes.map((m) => m.code);
    for (const expected of ['PERIOD', 'ALL_BUSINESS_DATA', 'FULL_SETUP_RESET']) {
      assert.ok(codes.includes(expected), `mode ${expected} is missing — the schema's own CHECK allows it, so a screen that omits it hides a capability the database has`);
    }
    for (const m of modes) {
      assert.ok(m.phrase && m.phrase.length > 8, `mode ${m.code} has no confirmation phrase`);
      assert.equal(m.confirmation_phrase, m.phrase, `mode ${m.code} reports two different phrases`);
      assert.ok(m.description && m.description.length > 30, `mode ${m.code} does not describe itself`);
      if (m.keeps) assert.ok(String(m.keeps).length > 20, `mode ${m.code} says it keeps "${m.keeps}" without saying what that means`);
      if (m.needs_dates) assert.ok(String(m.description).match(/range|period|date/i), `mode ${m.code} needs dates but does not say so`);
    }
    audit.note(modes.map((m) => m.code).join(', '));
  });

  await audit.check('no two modes share a phrase — typing one must not trigger another', () => {
    const phrases = (status.modes || []).map((m) => String(m.phrase).toUpperCase());
    assert.equal(new Set(phrases).size, phrases.length, `duplicate confirmation phrases: ${phrases.join(' | ')}`);
  });

  // ===================================================================
  audit.section('Who may look, and who may not');
  // ===================================================================
  if (manager) {
    await audit.checkAsync('a manager can see it: being unable to answer "are we about to run out of room?" is how a proprietor is told too late', async () => {
      const res = await manager.get('/api/data-management/status');
      assert.equal(res.status, 200, `a manager was answered ${res.status} ${String(res.text).slice(0, 160)}`);
      assert.ok(res.json && res.json.storage, 'a manager got a response with no capacity in it');
    });
  } else {
    audit.skip('a manager can see it', 'this run has no manager seat');
  }

  if (staff) {
    await audit.checkAsync('but a STAFF seat cannot — capacity and retention are the owner\u2019s business', async () => {
      const res = await staff.get('/api/data-management/status');
      assert.equal(res.status, 403,
        `a staff seat was answered ${res.status} for the data-management controls. Reading them is one decision; acting on them is another, and a cashier on a stolen phone should hold neither`);
      assert.match(String((res.json || {}).code || ''), /ROLE_REQUIRED/, `refused as ${(res.json || {}).code}`);
    });
    await audit.checkAsync('and cannot read the cleanup history either', async () => {
      const res = await staff.get('/api/data-management/history');
      assert.equal(res.status, 403, `a staff seat read the cleanup history (${res.status})`);
    });
  } else {
    audit.skip('a STAFF seat cannot read the controls', 'this run has no staff seat');
  }

  // ===================================================================
  audit.section('The cleanup history, as the screen reads it');
  // ===================================================================
  await audit.checkAsync('the history answers the Plan screen\u2019s own request, with paging', async () => {
    // The screen sends `?limit=20`. A contract that only works at the default is
    // a contract that breaks the first time somebody pages.
    const res = await owner.get('/api/data-management/history?limit=20');
    assert.equal(res.status, 200, `history answered ${res.status} ${String(res.text).slice(0, 160)}`);
    const rows = (res.json && (res.json.data || res.json.rows)) || [];
    assert.ok(Array.isArray(rows), 'history did not return a list');
    assert.ok(res.json.paging, 'history returned no paging envelope — a list that cannot be paged is a list that hides its own tail');
    assert.equal(res.json.paging.limit, 20, `the server applied a limit of ${res.json.paging.limit} to a request for 20`);
    for (const row of rows) {
      assert.ok(row.mode, 'a cleanup row with no mode');
      assert.ok(row.created_at, 'a cleanup row with no date');
    }
    audit.note(`${rows.length} cleanup run(s) on record`);
  });

  await audit.checkAsync('a cleanup run appears in the history with what it removed', async () => {
    // There is no purge endpoint yet (G1c), so the row is written directly — which
    // is honest about what is being tested: the READER, against the schema's real
    // CHECK constraint on `mode`, not a hypothetical shape.
    if (!d.dbFile || d.live) {
      audit.skip('a cleanup run appears in the history', 'this target is not this audit\u2019s database, so a fixture row cannot be written');
      return;
    }
    const Database = require('better-sqlite3');
    const db = new Database(d.dbFile);
    const me = await owner.get('/api/auth/me');
    const userId = String(((me.json || {}).user || {}).id);
    const summary = JSON.stringify({ sync_change_log: 412, login_attempts: 96, sync_conflicts: 3 });
    db.prepare(`INSERT INTO data_cleanup_log (id, mode, initiated_by, initiated_by_username, start_date, end_date, deleted_summary_json, created_at)
                VALUES (?,?,?,?,?,?,?, datetime('now'))`)
      .run('audit-cleanup-' + Date.now().toString(36), 'CLEAR_OPERATIONAL_KEEP_ACCOUNTING', userId, 'audit-owner', null, null, summary);
    db.close();

    const res = await owner.get('/api/data-management/history?limit=5');
    const rows = (res.json && (res.json.data || res.json.rows)) || [];
    const mine = rows.find((r) => r.mode === 'CLEAR_OPERATIONAL_KEEP_ACCOUNTING');
    assert.ok(mine, `the run just written is not in the history (${rows.length} row(s) returned)`);
    assert.ok(mine.summary && mine.summary.sync_change_log === 412,
      `the summary did not survive the round trip: ${JSON.stringify(mine.summary)}`);
    audit.note('a run reads back with its mode, its author and its summary');
  });

  // ===================================================================
  audit.section('Nothing the shop must keep was in reach');
  // ===================================================================
  await audit.check('the retention module names its tables and never the trading record', () => {
    // A STATIC CHECK, and the most important one in this file. The destructive
    // module is three statements today; the next person to add a fourth should be
    // stopped here rather than by a client's accountant.
    const { retentionStatements } = require('../../server/lib/retention');
    const sql = retentionStatements().map((s) => s.sql).join(' ').toUpperCase();
    for (const forbidden of ['sales', 'sale_items', 'sale_payments', 'GL_JOURNAL', 'STOCK_MOVEMENTS', 'STOCK_BATCHES', 'AUDIT_LOG', 'EXPENSES', 'CUSTOMERS', 'WHT_ENTRIES']) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(sql),
        `retention now mentions ${forbidden}. The trading record is not housekeeping: it is how the shop answers a tax officer, a supplier and a court. If this is deliberate, it is not a change to make inside a test's tolerance — it is a conversation`);
    }
    assert.ok(/SYNC_CHANGE_LOG|SYNC_CONFLICTS|LOGIN_ATTEMPTS/.test(sql), 'retention no longer mentions any table it is supposed to prune');
  });

  audit.note('capacity, retention and history are readable by a manager and above; a staff seat is refused in both directions');
}, {
  setup: () => startDeployment({
    label: 'data',
    businesses: [{
      name: 'Data Management Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [{ name: 'Records Shop', code: 'REC-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 25000 }],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'data-manager', pin: '61592', branchIndex: 0, full_name: 'Data Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'data-staff', pin: '58274', branchIndex: 0, full_name: 'Data Audit Staff' },
    ],
  }),
});
