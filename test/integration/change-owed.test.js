'use strict';
// =====================================================================
// test/integration/change-owed.test.js — THE MONEY FINDS ITS WAY HOME
// =====================================================================
// The gap this closes was not a crash: it was a liability that only ever grew.
// A sale that leaves change owed writes a row, the row is shown on the sale detail,
// and until now nothing could mark it paid. So this file tests the money, not the
// screen:
//
//   * handing ₦300 back settles the claim ONCE, and a second attempt is refused with
//     the status, the time and the person — a double-tap and a second cashier on the
//     same code are the same event to the ledger;
//   * the cash leaves the SAFE and the books follow it (DR 2210 Change Owed Liability
//     / CR cash), so the books stop claiming the liability after the money has gone;
//   * an EXPIRED claim cannot be settled by a cashier and CAN be by a manager, whose
//     decision is recorded;
//   * a WRITE-OFF needs a manager and a reason, and the reason is kept.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.CHANGE_OWED_PORT || 8844);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(ROOT, '.data', 'change-owed-test.db');

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

test('change owed: settled once, written off only with a reason', async (t) => {
  for (const suffix of ['', '-wal', '-shm', '.jwt']) {
    try { fs.rmSync(DB_FILE + suffix, { force: true }); } catch (e) { /* absent is fine */ }
  }
  const { openDatabase, migrate } = require(path.join(ROOT, 'server/lib/db'));
  const provisioning = require(path.join(ROOT, 'server/services/provisioningService'));
  const { newId } = require(path.join(ROOT, 'domain/crypto'));

  const db = openDatabase({ file: DB_FILE });
  await migrate(db);
  await provisioning.provisionDeployment(db, {
    businessName: 'Change Owed Stores Ltd',
    profileCode: 'ELECTRONICS',
    ownerName: 'Change Owner', ownerUsername: 'co-owner', ownerPin: '11111',
    branches: [
      {
        name: 'Wuse Store', code: 'CO-WUS', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 50000,
        manager: { name: 'Wuse Manager', username: 'co-manager', pin: '22222', job_title: 'Branch Manager' },
        staff: [{ name: 'Wuse Cashier', username: 'co-staff', pin: '33333' }],
      },
      {
        name: 'Garki Store', code: 'CO-GAR', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 10000,
        staff: [{ name: 'Garki Cashier', username: 'co-other', pin: '44444' }],
      },
    ],
  });
  const business = await db.first("SELECT * FROM businesses WHERE name = 'Change Owed Stores Ltd'");
  const wuse = await db.first("SELECT * FROM branches WHERE code = 'CO-WUS'");
  const garki = await db.first("SELECT * FROM branches WHERE code = 'CO-GAR'");
  const owner = await db.first("SELECT * FROM users WHERE username = 'co-owner'");

  // TWO CLAIMS: one fresh, one already past its window. Written directly because the
  // money path that CREATES them (a sale with change owed) is covered by the sales
  // tests; this file is about what can be done with them afterwards.
  const freshId = newId();
  const staleId = newId();
  await db.run(`INSERT INTO change_owed (id, branch_id, business_id, customer_name, customer_phone, amount, claim_code,
                                         status, expires_at, created_by, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?, 'OUTSTANDING', date('now', '+20 days'), ?, datetime('now'), datetime('now'))`,
  [freshId, wuse.id, business.id, 'Alhaji Bello', '08030000000', 300, 'AB12CD34', owner.id]);
  await db.run(`INSERT INTO change_owed (id, branch_id, business_id, customer_name, amount, claim_code,
                                         status, expires_at, created_by, created_at, updated_at)
                VALUES (?,?,?,?,?,?, 'OUTSTANDING', date('now', '-3 days'), ?, datetime('now'), datetime('now'))`,
  [staleId, wuse.id, business.id, 'Madam Ngozi', 1500, 'ZZ99YY88', owner.id]);
  // and one in the OTHER branch, to prove the boundary
  const otherId = newId();
  await db.run(`INSERT INTO change_owed (id, branch_id, business_id, customer_name, amount, claim_code,
                                         status, expires_at, created_by, created_at, updated_at)
                VALUES (?,?,?,?,?,?, 'OUTSTANDING', date('now', '+20 days'), ?, datetime('now'), datetime('now'))`,
  [otherId, garki.id, business.id, 'Garki Walk-in', 700, 'GG11HH22', owner.id]);
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
  for (const [who, username, pin] of [
    ['owner', 'co-owner', '11111'], ['manager', 'co-manager', '22222'],
    ['staff', 'co-staff', '33333'], ['other', 'co-other', '44444'],
  ]) {
    const r = await req('POST', '/api/auth/login', { body: { username, pin } });
    assert.equal(r.status, 200, `${username} could not sign in: ${r.text.slice(0, 200)}`);
    tokens[who] = r.json.token;
  }

  const peek = async (sql, params = []) => {
    const db2 = openDatabase({ file: DB_FILE });
    const row = await db2.first(sql, params);
    await db2.close();
    return row;
  };

  // -------------------------------------------------------------------
  await t.test('the counter can see what the shop owes, and a customer can claim it by code', async () => {
    const list = await req('GET', '/api/change-owed', { token: tokens.staff });
    assert.equal(list.status, 200, list.text.slice(0, 300));
    const codes = list.json.data.map((r) => r.claim_code);
    assert.ok(codes.includes('AB12CD34'), 'the Wuse claim is missing from the list');
    assert.ok(!codes.includes('GG11HH22'), 'a claim from another branch is visible to a Wuse cashier');
    for (const row of list.json.data) {
      assert.ok(['expired', 'days_left'].every((k) => k in row), 'the list does not say how close each claim is to expiry');
    }

    const claim = await req('GET', '/api/change-owed/code/ab12cd34', { token: tokens.staff });
    assert.equal(claim.status, 200, `a claim by code answered ${claim.status} ${claim.text.slice(0, 200)}`);
    assert.equal(claim.json.claim.amount, 300);
    assert.equal(claim.json.settlable, true);

    const stale = await req('GET', '/api/change-owed/code/ZZ99YY88', { token: tokens.staff });
    assert.equal(stale.status, 200);
    assert.equal(stale.json.settlable, false, 'an expired claim is offered to a cashier as settlable');
    assert.ok(/expired/i.test(stale.json.why_not || ''), 'the refusal does not say the claim expired');

    const nowhere = await req('GET', '/api/change-owed/code/GG11HH22', { token: tokens.staff });
    assert.equal(nowhere.status, 404, 'a cashier could read another branch\u2019s claim by guessing its code');
  });

  // -------------------------------------------------------------------
  await t.test('a cashier hands the money over, and the safe and the books follow it', async () => {
    const before = await peek('SELECT COALESCE(SUM(amount), 0) AS balance FROM branch_safe_ledger WHERE branch_id = ? AND is_deleted = 0', [wuse.id]);
    const settle = await req('POST', `/api/change-owed/${freshId}/settle`, { token: tokens.staff, body: { method: 'CASH' } });
    assert.equal(settle.status, 200, settle.text.slice(0, 300));
    assert.equal(settle.json.status, 'REDEEMED');
    assert.equal(settle.json.amount, 300);

    const row = await peek('SELECT status, redeemed_by, redeemed_at, notes FROM change_owed WHERE id = ?', [freshId]);
    assert.equal(row.status, 'REDEEMED');
    assert.equal(String(row.redeemed_by), String((await peek("SELECT id FROM users WHERE username = 'co-staff'")).id),
      'the claim does not record which seat paid the money out');
    assert.ok(row.redeemed_at, 'the claim has no redemption time');
    assert.ok(/Redeemed CASH/.test(String(row.notes)), `the note does not say how it was paid: ${row.notes}`);

    const after = await peek('SELECT COALESCE(SUM(amount), 0) AS balance FROM branch_safe_ledger WHERE branch_id = ? AND is_deleted = 0', [wuse.id]);
    assert.equal(Number(after.balance), Number(before.balance) - 300, 'the cash did not leave the safe ledger');
    const movement = await peek("SELECT * FROM branch_safe_ledger WHERE reference_id = ? AND reference_type = 'CHANGE_OWED'", [freshId]);
    assert.ok(movement, 'no safe movement was recorded against the claim');
    assert.equal(Number(movement.amount), -300, 'the safe movement is not a withdrawal');
    assert.equal(Number(movement.balance_after), Number(after.balance));

    // THE BOOKS: the sale credited 2210 when the change was first owed, so settling
    // must debit it. If it does not, the liability stays on the balance sheet for ever.
    const gl = await peek(`SELECT COUNT(*) AS c FROM gl_journal_lines WHERE account_id = (SELECT id FROM gl_accounts WHERE business_id = ? AND code = '2210') AND debit > 0`, [business.id]);
    assert.ok(Number(gl.c) >= 1, 'settling did not debit the Change Owed Liability account');
  });

  // -------------------------------------------------------------------
  await t.test('the same claim cannot be settled twice, and the refusal says by whom and when', async () => {
    const again = await req('POST', `/api/change-owed/${freshId}/settle`, { token: tokens.staff, body: { method: 'CASH' } });
    assert.equal(again.status, 409, `a second settlement was accepted: ${again.status} ${again.text.slice(0, 200)}`);
    assert.equal(again.json.code, 'CLAIM_ALREADY_SETTLED');
    assert.ok(/already redeemed/i.test(again.json.error), `the refusal does not name the status: ${again.json.error}`);
    assert.ok(/cashier/i.test(again.json.error), `the refusal does not name the person who paid it: ${again.json.error}`);

    // And it did not pay a second time.
    const movements = await peek("SELECT COUNT(*) AS c FROM branch_safe_ledger WHERE reference_id = ? AND reference_type = 'CHANGE_OWED'", [freshId]);
    assert.equal(Number(movements.c), 1, 'the second attempt moved money out of the safe again');
  });

  // -------------------------------------------------------------------
  await t.test('an expired claim is refused to a cashier and authorised by a manager, and the override is recorded', async () => {
    const denied = await req('POST', `/api/change-owed/${staleId}/settle`, { token: tokens.staff, body: { method: 'CASH' } });
    assert.equal(denied.status, 409, `a cashier settled an expired claim: ${denied.status}`);
    assert.equal(denied.json.code, 'CLAIM_EXPIRED');

    const forced = await req('POST', `/api/change-owed/${staleId}/settle`, { token: tokens.staff, body: { method: 'CASH', accept_expired: true } });
    assert.equal(forced.status, 403, 'a cashier authorised an expired claim by asking nicely');
    assert.equal(forced.json.code, 'ROLE_REQUIRED');

    const manager = await req('POST', `/api/change-owed/${staleId}/settle`, { token: tokens.manager, body: { method: 'CASH', accept_expired: true } });
    assert.equal(manager.status, 200, manager.text.slice(0, 300));
    assert.equal(manager.json.expired_override, true, 'the answer does not say an expiry was overridden');
    const row = await peek('SELECT status, notes FROM change_owed WHERE id = ?', [staleId]);
    assert.equal(row.status, 'REDEEMED');
    assert.ok(/expired claim, manager override/.test(String(row.notes)), 'the override is not recorded on the claim itself');
  });

  // -------------------------------------------------------------------
  await t.test('a write-off needs a manager and a reason that is kept', async () => {
    const noReason = await req('POST', `/api/change-owed/${otherId}/write-off`, { token: tokens.owner, body: {} });
    assert.equal(noReason.status, 400, 'a write-off with no reason was accepted');
    assert.equal(noReason.json.code, 'REASON_REQUIRED');

    // FOUR CHARACTERS IS NOT A REASON. "gone" used to be accepted, which made the
    // field decoration — the floor is 12 characters and the refusal says so, so the
    // screen and the endpoint can enforce the same rule.
    for (const tooShort of ['no', 'gone']) {
      const res = await req('POST', `/api/change-owed/${otherId}/write-off`, { token: tokens.owner, body: { reason: tooShort } });
      assert.equal(res.status, 400, `"${tooShort}" was accepted as a write-off reason: ${res.status} ${res.text.slice(0, 160)}`);
      assert.equal(res.json.code, 'REASON_REQUIRED');
      assert.ok(/12 characters/.test(res.json.error), `the refusal does not say how long the reason must be: ${res.json.error}`);
    }

    const asStaff = await req('POST', `/api/change-owed/${otherId}/write-off`, { token: tokens.other, body: { reason: 'The customer never came back for it.' } });
    // The OTHER branch's cashier cannot see the claim at all; a Wuse cashier asking is
    // the role test. Both answers are refusals, and the role one is what is asserted
    // here because it is the rule that protects the money.
    assert.equal(asStaff.status, 403, `a cashier wrote off money the shop owes: ${asStaff.status}`);

    // 404, NOT 403, AND DELIBERATELY: a claim in a branch the caller cannot see is not
    // FOUND, rather than found and refused. A 403 would confirm that a claim exists on
    // a code they guessed, which is a slower way of publishing another shop's figures.
    const wrongBranch = await req('POST', `/api/change-owed/${otherId}/write-off`, { token: tokens.manager, body: { reason: 'Wrong branch on purpose.' } });
    assert.equal(wrongBranch.status, 404, `a Wuse manager could reach a Garki claim: ${wrongBranch.status} ${wrongBranch.text.slice(0, 160)}`);

    const done = await req('POST', `/api/change-owed/${otherId}/write-off`, { token: tokens.owner, body: { reason: 'Customer was called twice and did not come back.' } });
    assert.equal(done.status, 200, done.text.slice(0, 300));
    assert.equal(done.json.status, 'WRITTEN_OFF');
    const row = await peek('SELECT status, notes, redeemed_by FROM change_owed WHERE id = ?', [otherId]);
    assert.equal(row.status, 'WRITTEN_OFF');
    assert.ok(/Customer was called twice/.test(String(row.notes)), 'the reason was not kept on the claim');
    assert.ok(row.redeemed_by, 'the write-off does not record who decided it');

    const twice = await req('POST', `/api/change-owed/${otherId}/write-off`, { token: tokens.owner, body: { reason: 'Again.' } });
    assert.equal(twice.status, 409, 'a written-off claim can be written off again');

    const settled = await req('POST', `/api/change-owed/${otherId}/settle`, { token: tokens.owner, body: { method: 'CASH' } });
    assert.equal(settled.status, 409, 'a written-off claim can still be paid out');
  });

  // -------------------------------------------------------------------
  await t.test('a part payment is refused rather than leaving a second claim on one code', async () => {
    const partId = require(path.join(ROOT, 'domain/crypto')).newId();
    const db2 = openDatabase({ file: DB_FILE });
    await db2.run(`INSERT INTO change_owed (id, branch_id, business_id, customer_name, amount, claim_code,
                                            status, expires_at, created_by, created_at, updated_at)
                   VALUES (?,?,?,?,?,?, 'OUTSTANDING', date('now', '+10 days'), ?, datetime('now'), datetime('now'))`,
    [partId, wuse.id, business.id, 'Mrs Adeyemi', 900, 'PP44QQ55', owner.id]);
    await db2.close();

    const partial = await req('POST', `/api/change-owed/${partId}/settle`, { token: tokens.staff, body: { method: 'CASH', amount: 400 } });
    assert.equal(partial.status, 400, `a part payment was accepted: ${partial.status} ${partial.text.slice(0, 200)}`);
    assert.equal(partial.json.code, 'PART_SETTLEMENT');
    const row = await peek('SELECT status FROM change_owed WHERE id = ?', [partId]);
    assert.equal(row.status, 'OUTSTANDING', 'the refused part payment still changed the claim');

    const whole = await req('POST', `/api/change-owed/${partId}/settle`, { token: tokens.staff, body: { method: 'BANK_TRANSFER', reference: 'TRF-88213' } });
    assert.equal(whole.status, 200, whole.text.slice(0, 300));
    const movement = await peek("SELECT COUNT(*) AS c FROM branch_safe_ledger WHERE reference_id = ? AND reference_type = 'CHANGE_OWED'", [partId]);
    assert.equal(Number(movement.c), 0, 'a bank transfer moved cash out of the safe drawer');
  });

  // -------------------------------------------------------------------
  await t.test('the summary the dashboard card reads agrees with the rows behind it', async () => {
    // FRESH CLAIMS, because by this point every claim above has been settled or
    // written off — and a card whose breakdown is empty proves nothing about the
    // breakdown. One in Wuse, one in Garki, so the branch split has something to split.
    const db3 = openDatabase({ file: DB_FILE });
    for (const [id, branch, name, amount, code] of [
      [newId(), wuse.id, 'Mrs Adeyemi', 250, 'SM11AA22'],
      [newId(), garki.id, 'Garki Walk-in', 400, 'SM33BB44'],
    ]) {
      await db3.run(`INSERT INTO change_owed (id, branch_id, business_id, customer_name, amount, claim_code,
                                               status, expires_at, created_by, created_at, updated_at)
                     VALUES (?,?,?,?,?,?, 'OUTSTANDING', date('now', '+14 days'), ?, datetime('now'), datetime('now'))`,
      [id, branch, business.id, name, amount, code, owner.id]);
    }
    await db3.close();

    const summary = await req('GET', '/api/change-owed/summary', { token: tokens.owner });
    assert.equal(summary.status, 200, summary.text.slice(0, 300));
    const rows = await peek(`SELECT COUNT(*) AS claims, COALESCE(SUM(amount), 0) AS amount FROM change_owed WHERE status = 'OUTSTANDING' AND is_deleted = 0`);
    assert.equal(summary.json.outstanding_claims, Number(rows.claims), 'the card and the table disagree about how many claims are open');
    assert.equal(summary.json.outstanding_amount, Number(rows.amount), 'the card and the table disagree about how much is owed');
    assert.equal(summary.json.outstanding_amount, 650, `the card reads ${summary.json.outstanding_amount} against the ₦650 written above`);
    assert.ok(Array.isArray(summary.json.by_branch) && summary.json.by_branch.length === 2,
      `the branch breakdown has ${summary.json.by_branch && summary.json.by_branch.length} row(s) for two branches with money owed`);
    assert.ok(summary.json.by_branch.every((b) => b.branch_name && Number(b.amount) > 0), 'a breakdown row names no branch or no money');
    assert.ok(summary.json.next_expiry, 'the card does not say when the nearest claim expires');

    // AND THE BOUNDARY: the Wuse cashier's card counts Wuse only. A dashboard that
    // tells a cashier about money owed by a shop they cannot serve is a number they
    // will chase and cannot pay.
    const asStaff = await req('GET', '/api/change-owed/summary', { token: tokens.staff });
    assert.equal(asStaff.status, 200);
    assert.equal(asStaff.json.outstanding_amount, 250, `a Wuse cashier's card totals ₦${asStaff.json.outstanding_amount} instead of the ₦250 owed at their branch`);
    assert.equal(asStaff.json.by_branch.length, 1);
  });
});
