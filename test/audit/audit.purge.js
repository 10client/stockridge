'use strict';
// =====================================================================
// test/audit/audit.purge.js — THE CLEANUP, AUDITED WITHOUT CLEANING
// =====================================================================
// AN AUDIT THAT DELETES A CLIENT'S DATA TO PROVE THAT DELETING WORKS IS NOT AN
// AUDIT. So this one goes right up to the edge and stops: it proves that the
// refusals refuse, that the preview counts and changes nothing, and that the two
// declarations and the typed phrase are all genuinely required — WITHOUT running a
// single real cleanup against the deployment it is pointed at.
//
// That restraint is itself the thing worth checking, and it is checked in the last
// section: the cleanup-log row count is read before and after, and the run fails if
// it moved. A future version of this file that grew a "let us just try one" step
// would be caught by its own assertion.
//
// BACK TO FRONT: every request below is the one the Subscription screen's cleanup
// modal sends, with the body shape that modal builds.
// FRONT TO BACK: the phrases the live deployment advertises are the phrases the
// endpoint actually demands, character for character — a screen showing one phrase
// while the server waits for another is a feature nobody can use and everybody
// blames on "the delete button that does not work".
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const num = (v) => (v == null ? null : Number(v));

runAudit('purge', async (audit, d) => {
  const owner = d.owner || d.admin;
  // SEATS LIVE AT `d.seats.<as>`. An undefined seat would make the role checks
  // below SKIP, and a skipped permission check reads exactly like a passing one.
  const manager = (d.seats && d.seats.manager) || null;
  const staff = (d.seats && d.seats.staff) || null;

  const historyCount = async (seat) => {
    const res = await seat.get('/api/data-management/history?limit=1');
    assert.equal(res.status, 200, `history answered ${res.status} ${String(res.text).slice(0, 160)}`);
    return num(res.json.total);
  };

  const logBefore = await historyCount(owner);
  audit.note(`the deployment has ${logBefore} cleanup run(s) on record, and this audit will leave it with the same number`);

  // ===================================================================
  audit.section('The screen and the endpoint agree on the phrase');
  // ===================================================================
  const status = await audit.captureAsync('the cleanup modes as the modal receives them', async () => {
    const res = await owner.get('/api/data-management/status');
    assert.equal(res.status, 200, `status answered ${res.status} ${String(res.text).slice(0, 200)}`);
    return res.json;
  });

  const modes = (status.modes || []);
  await audit.check('every mode carries a label, a description, what it keeps, and the phrase a person must type', () => {
    assert.ok(modes.length >= 5, `only ${modes.length} mode(s) advertised`);
    for (const m of modes) {
      assert.ok(m.code, 'a mode with no code');
      assert.ok(m.label, `${m.code} has no label`);
      assert.ok(m.description, `${m.code} has no description — a destructive choice with no explanation`);
      assert.ok(m.keeps, `${m.code} does not say what survives`);
      assert.ok(m.phrase && m.phrase.length >= 8, `${m.code} has no phrase to type`);
      assert.equal(m.confirmation_phrase, m.phrase, `${m.code} advertises two different phrases`);
    }
    audit.note(`phrases: ${modes.map((m) => m.phrase).join(' · ')}`);
  });

  await audit.check('the warning that deletion is permanent travels in the response, not only in the browser', () => {
    const notice = String(status.retention_notice || '');
    assert.ok(notice.length > 60, 'the retention notice is missing from the API response');
    assert.ok(/permanent/i.test(notice), 'the notice does not say the deletion is permanent');
    audit.note(`notice present, ${notice.length} characters, and it mentions permanence`);
  });

  // ===================================================================
  audit.section('The door: only the owner, and only with the phrase typed');
  // ===================================================================
  await audit.checkAsync('a manager cannot preview a cleanup — running the shop is not the same as owning it', async () => {
    assert.ok(manager, 'the fixture has no manager seat, so this check would prove nothing');
    const res = await manager.post('/api/data-management/purge/preview', { mode: 'ALL_BUSINESS_DATA' });
    assert.equal(res.status, 403, `a manager could preview: ${res.status} ${String(res.text).slice(0, 160)}`);
    assert.equal(res.json.code, 'ROLE_REQUIRED');
  });

  await audit.checkAsync('and cannot run one either', async () => {
    assert.ok(manager, 'the fixture has no manager seat');
    const res = await manager.post('/api/data-management/purge', {
      mode: 'ALL_BUSINESS_DATA', phrase: 'CLEAR ALL BUSINESS DATA', export_confirmed: true, retention_acknowledged: true,
    });
    assert.equal(res.status, 403, `a manager could reach the cleanup endpoint: ${res.status}`);
    assert.equal(res.json.code, 'ROLE_REQUIRED');
  });

  await audit.checkAsync('a cashier is refused the same way', async () => {
    assert.ok(staff, 'the fixture has no staff seat');
    const res = await staff.post('/api/data-management/purge', {
      mode: 'ALL_BUSINESS_DATA', phrase: 'CLEAR ALL BUSINESS DATA', export_confirmed: true, retention_acknowledged: true,
    });
    assert.equal(res.status, 403, `a cashier reached the cleanup endpoint: ${res.status}`);
  });

  await audit.checkAsync('a phrase that is correct in every way except the letters is refused, and the refusal names the phrase', async () => {
    const res = await owner.post('/api/data-management/purge', {
      mode: 'ALL_BUSINESS_DATA', phrase: 'clear all business data', export_confirmed: true, retention_acknowledged: true,
    });
    assert.equal(res.status, 428, `a lowercase phrase was accepted: ${res.status} ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'PHRASE_REQUIRED');
    const fields = res.json.fields || {};
    assert.equal(fields.expected_phrase, 'CLEAR ALL BUSINESS DATA',
      'the refusal does not tell the operator which phrase to type, so the screen can only say "try again"');
  });

  await audit.checkAsync('the right phrase with no export declared is still refused', async () => {
    const res = await owner.post('/api/data-management/purge', {
      mode: 'ALL_BUSINESS_DATA', phrase: 'CLEAR ALL BUSINESS DATA', retention_acknowledged: true,
    });
    assert.equal(res.status, 428, `a cleanup ran with no export declared: ${res.status}`);
    assert.equal(res.json.code, 'CONFIRMATION_REQUIRED');
  });

  await audit.checkAsync('and the right phrase with the export declared but the notice unacknowledged is refused too', async () => {
    const res = await owner.post('/api/data-management/purge', {
      mode: 'ALL_BUSINESS_DATA', phrase: 'CLEAR ALL BUSINESS DATA', export_confirmed: true,
    });
    assert.equal(res.status, 428, `a cleanup ran with the retention notice unacknowledged: ${res.status}`);
    assert.equal(res.json.code, 'CONFIRMATION_REQUIRED');
  });

  await audit.checkAsync('a period cleanup with no period is refused, and one that ends before it starts is refused', async () => {
    const missing = await owner.post('/api/data-management/purge', {
      mode: 'PERIOD', phrase: 'DELETE SELECTED PERIOD', export_confirmed: true, retention_acknowledged: true,
    });
    assert.equal(missing.status, 400, `a period cleanup ran with no period: ${missing.status}`);
    assert.equal(missing.json.code, 'DATES_REQUIRED');
    const backwards = await owner.post('/api/data-management/purge', {
      mode: 'PERIOD', phrase: 'DELETE SELECTED PERIOD', export_confirmed: true, retention_acknowledged: true,
      start_date: '2026-03-01', end_date: '2026-02-01',
    });
    assert.equal(backwards.status, 400, `a backwards period was accepted: ${backwards.status}`);
    assert.equal(backwards.json.code, 'INVALID_PERIOD');
  });

  // ===================================================================
  audit.section('The preview counts, and touches nothing');
  // ===================================================================
  const preview = await audit.captureAsync('the preview, exactly as the modal asks for it', async () => {
    const res = await owner.post('/api/data-management/purge/preview', { mode: 'ALL_BUSINESS_DATA' });
    assert.equal(res.status, 200, `preview answered ${res.status} ${String(res.text).slice(0, 200)}`);
    return res.json;
  });

  await audit.check('the preview says it is a dry run, holds a real count, and repeats the phrase', () => {
    assert.equal(preview.dry_run, true, 'the preview does not identify itself as a dry run');
    assert.ok(preview.would_remove && typeof preview.would_remove === 'object', 'the preview carries no per-table counts');
    assert.ok(num(preview.total) >= 0, `total is ${preview.total}`);
    assert.ok(preview.phrase, 'the preview does not carry the phrase, so the modal must invent it');
    const phraseForMode = (modes.find((m) => m.code === preview.mode) || {}).phrase;
    assert.equal(preview.phrase, phraseForMode, 'the preview and the status disagree about the phrase');
    audit.note(`would remove ${preview.total} row(s) across ${Object.keys(preview.would_remove).length} table(s)`);
  });

  await audit.check('the preview names the tables that are never removed, so the modal can say what always stays', () => {
    const kept = preview.kept_tables || [];
    for (const t of ['businesses', 'audit_log', 'data_cleanup_log', 'client_settings']) {
      assert.ok(kept.includes(t), `${t} is not listed as never removed`);
    }
  });

  // ===================================================================
  audit.section('The audit itself left the deployment alone');
  // ===================================================================
  await audit.checkAsync('no cleanup was recorded — every refusal above stopped before the log', async () => {
    const after = await historyCount(owner);
    assert.equal(after, logBefore,
      `this audit changed the deployment's cleanup history (${logBefore} → ${after}). Every refusal above is supposed to stop before anything is written, and this audit is not supposed to run a real cleanup at all.`);
  });

  await audit.checkAsync('and the trading data the preview counted is still there', async () => {
    // The count is a proxy for "nothing was deleted", taken after the fact. If a
    // refusal had slipped through, the counts would have moved and the check above
    // would already have failed — this one says the same thing about the DATA, so a
    // future endpoint that logged nothing and deleted anyway is still caught.
    const again = await owner.post('/api/data-management/purge/preview', { mode: 'ALL_BUSINESS_DATA' });
    assert.equal(again.status, 200);
    assert.equal(num(again.json.total), num(preview.total),
      `the same preview counted ${preview.total} row(s) before this audit's refusals and ${again.json.total} after — something was deleted`);
  });

  // ===================================================================
  audit.section('A device that was offline during a cleanup will be told, not trusted');
  // ===================================================================
  await audit.checkAsync('a sync push reports how many queued operations it quarantined', async () => {
    // The replay path quarantines an operation dated before the last cleanup rather
    // than applying it, because applying it would re-create rows the owner deleted.
    // An empty push is enough to prove the FIELD exists — a device that has to parse
    // "quarantined" out of a human sentence will get it wrong on the day it matters.
    const res = await owner.post('/api/sync/push', { device_id: 'audit-purge-device', operations: [], mutations: [] });
    if (res.status === 400 && res.json && res.json.code === 'EMPTY_SYNC') {
      audit.note('the deployment refuses an empty sync before it reaches the counters; the quarantine field is asserted by test/integration/data-management-purge.test.js instead');
      return;
    }
    assert.ok(res.status < 500, `sync push answered ${res.status} ${String(res.text).slice(0, 160)}`);
    assert.ok(res.json && Object.prototype.hasOwnProperty.call(res.json, 'quarantined'),
      'the sync answer does not carry a quarantined count, so a device cannot tell a replay that was stored from one that was applied');
    assert.equal(num(res.json.quarantined), 0, 'a clean deployment reported quarantined operations');
    assert.equal(num(res.json.conflicts), 0, 'a clean deployment reported sync conflicts');
  });
}, {
  // THE FIXTURE NEEDS A MANAGER AND A CASHIER, because the two checks that matter
  // most here are the ones that prove a NON-OWNER is refused. Owner and administrator
  // seats come from `AUDIT_OWNER_USER`/`AUDIT_OWNER_PIN` on the environment.
  setup: () => startDeployment({
    label: 'purge',
    businesses: [{
      name: 'Cleanup Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [{ name: 'Records Shop', code: 'CLN-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 25000 }],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'purge-manager', pin: '39471', branchIndex: 0, full_name: 'Cleanup Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'purge-staff', pin: '52718', branchIndex: 0, full_name: 'Cleanup Audit Cashier' },
    ],
  }),
});
