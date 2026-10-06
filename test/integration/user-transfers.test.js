'use strict';
// =====================================================================
// test/integration/user-transfers.test.js — A MOVE IS A QUESTION FIRST
// =====================================================================
// The defect this closes is not an error message: it is a cashier who could see a shop
// they had never worked in. `users.branch_id` is what a person can see, and until
// stage G3 a single PUT moved it with nobody at the receiving branch involved.
//
// So the things asserted here are about where somebody IS and IS NOT:
//
//   * asking does not move anybody — the person keeps working where they are, which is
//     what makes the question a question;
//   * the RECEIVING branch decides; the sending branch does not, and neither does the
//     person being moved;
//   * when it IS accepted the scope really changes, and the change is written down;
//   * a refusal keeps the person where they are AND keeps the reason, because that
//     reason is what an owner reads three months later;
//   * the history answers "who could see the Minna till on 14 March?" — including for
//     people who have never transferred, whose first row is their creation.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.USER_TRANSFERS_PORT || 8846);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(ROOT, '.data', 'user-transfers-test.db');

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

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('staff transfers: asked, answered, recorded', async (t) => {
  for (const suffix of ['', '-wal', '-shm', '.jwt']) {
    try { fs.rmSync(DB_FILE + suffix, { force: true }); } catch (e) { /* absent is fine */ }
  }
  const { openDatabase, migrate } = require(path.join(ROOT, 'server/lib/db'));
  const provisioning = require(path.join(ROOT, 'server/services/provisioningService'));

  const db = openDatabase({ file: DB_FILE });
  await migrate(db);
  await provisioning.provisionDeployment(db, {
    businessName: 'Two Shops Ltd',
    profileCode: 'ELECTRONICS',
    ownerName: 'Two Shops Owner', ownerUsername: 'ts-owner', ownerPin: '11001',
    branches: [
      {
        name: 'Wuse Shop', code: 'TS-WUS', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000,
        manager: { name: 'Wuse Manager', username: 'ts-wuse-mgr', pin: '22002', job_title: 'Branch Manager' },
        staff: [{ name: 'Moving Cashier', username: 'ts-cashier', pin: '33003' }],
      },
      {
        name: 'Minna Shop', code: 'TS-MIN', city: 'Minna', state: 'Niger', branch_type: 'RETAIL', opening_cash: 5000,
        manager: { name: 'Minna Manager', username: 'ts-minna-mgr', pin: '44004', job_title: 'Branch Manager' },
      },
    ],
  });
  const business = await db.first("SELECT * FROM businesses WHERE name = 'Two Shops Ltd'");
  const wuse = await db.first("SELECT * FROM branches WHERE code = 'TS-WUS'");
  const minna = await db.first("SELECT * FROM branches WHERE code = 'TS-MIN'");
  const cashier = await db.first("SELECT * FROM users WHERE username = 'ts-cashier'");
  const owner = await db.first("SELECT * FROM users WHERE username = 'ts-owner'");

  // AND THE HISTORY STARTS AT CREATION, which is the whole reason the back-to-front
  // query below can answer for somebody who has never moved.
  // The platform administrator is created HERE, while the connection is open — the
  // first version of this test called provisionPlatform after db.close() and got
  // "The database connection is not open".
  await provisioning.provisionPlatform(db, { adminUsername: 'ts-admin', adminPin: '99009' });

  // AND THE FIXTURE IS BACKDATED — EVERY ROW, not only the cashier's. A person created
  // this afternoon cannot honestly be reported as having been at a shop last month, so
  // the assignment rows say this business was set up sixty days ago. "45 days ago"
  // then has real answers for every user, and "90 days ago" has none, which is the
  // other half of the proof: the history reports what it recorded and does not project
  // today's rota backwards onto dates before anybody existed.
  await db.run("UPDATE user_assignment_history SET changed_at = datetime('now', '-60 days')");

  const bornRows = await db.all('SELECT * FROM user_assignment_history WHERE user_id = ? ORDER BY changed_at, rowid', [cashier.id]);
  assert.equal(bornRows.length, 1, `a provisioned cashier has ${bornRows.length} assignment rows; their creation should have written the first`);
  assert.equal(String(bornRows[0].to_branch_id), String(wuse.id));
  assert.equal(bornRows[0].from_branch_id, null, 'the first assignment row should say they came from nowhere');
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
    ['owner', 'ts-owner', '11001'], ['wuseManager', 'ts-wuse-mgr', '22002'],
    ['minnaManager', 'ts-minna-mgr', '44004'], ['cashier', 'ts-cashier', '33003'],
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
  const branchOf = async () => String((await peek('SELECT branch_id FROM users WHERE id = ?', [cashier.id])).branch_id);
  const scopeBranch = async (token) => {
    const me = await req('GET', '/api/auth/me', { token });
    assert.equal(me.status, 200, `auth/me answered ${me.status}`);
    return String(((me.json.scope || {}).pinnedBranchId) || '');
  };

  // -------------------------------------------------------------------
  await t.test('the owner asks, and the cashier does not move', async () => {
    const asked = await req('PUT', `/api/users/${cashier.id}`, { token: tokens.owner, body: { branch_id: minna.id } });
    assert.equal(asked.status, 200, asked.text.slice(0, 300));
    assert.ok(asked.json.pendingTransfer, 'the answer carries no transfer, so the screen cannot tell that a question was asked');
    assert.ok(/question for that branch/.test(asked.json.message), `the message does not say the move is a question: ${asked.json.message}`);

    assert.equal(await branchOf(), String(wuse.id), 'ASKING MOVED THEM. The person must stay where they are until the receiving branch agrees — a question that moves somebody is not a question');
    assert.equal(await scopeBranch(tokens.cashier), String(wuse.id), 'the cashier can see the new branch before anybody agreed to receive them');

    const again = await req('PUT', `/api/users/${cashier.id}`, { token: tokens.owner, body: { branch_id: minna.id } });
    assert.equal(again.status, 409, `a second request while one is open was accepted: ${again.status}`);
    assert.equal(again.json.code, 'TRANSFER_ALREADY_PENDING');

    const sameBranch = await req('PUT', `/api/users/${cashier.id}`, { token: tokens.owner, body: { branch_id: wuse.id } });
    assert.ok(sameBranch.status === 200 || sameBranch.status === 400, `moving somebody to the branch they are already at answered ${sameBranch.status}`);
    assert.equal(await branchOf(), String(wuse.id));
  });

  // -------------------------------------------------------------------
  await t.test('the receiving branch sees it, the sending branch does not, and the cashier sees their own', async () => {
    const mine = await req('GET', '/api/users/transfers/pending?limit=50', { token: tokens.minnaManager });
    assert.equal(mine.status, 200, mine.text.slice(0, 200));
    assert.equal(mine.json.data.length, 1, `the Minna manager has ${mine.json.data.length} transfers waiting; the one into Minna should be there`);
    assert.equal(mine.json.data[0].username, 'ts-cashier');
    assert.equal(String(mine.json.data[0].to_branch_id), String(minna.id));
    assert.ok(mine.json.data[0].from_branch_name === 'Wuse Shop', 'the pending row does not say where the person is coming from');

    const sending = await req('GET', '/api/users/transfers/pending?limit=50', { token: tokens.wuseManager });
    assert.equal(sending.status, 200);
    assert.equal(sending.json.data.length, 0, 'the sending branch is being asked to decide a transfer INTO another branch');

    const asCashier = await req('GET', '/api/users/transfers/pending?limit=50', { token: tokens.cashier });
    assert.equal(asCashier.status, 403, `a cashier can list transfers waiting for a decision: ${asCashier.status}`);

    const concernsMe = await req('GET', '/api/users/transfers/pending/mine', { token: tokens.cashier });
    assert.equal(concernsMe.status, 200, concernsMe.text.slice(0, 200));
    assert.equal(concernsMe.json.data.length, 1, 'the person being moved cannot see that the move is still a question');
  });

  // -------------------------------------------------------------------
  await t.test('only the receiving manager may answer, and not the person being moved', async () => {
    const open = await peek("SELECT * FROM pending_user_transfers WHERE status = 'PENDING'");
    const asSendingManager = await req('POST', `/api/users/transfers/${open.id}/accept`, { token: tokens.wuseManager, body: {} });
    assert.equal(asSendingManager.status, 403, `the manager LOSING a cashier accepted the transfer: ${asSendingManager.status} ${asSendingManager.text.slice(0, 160)}`);

    const asSelf = await req('POST', `/api/users/transfers/${open.id}/accept`, { token: tokens.cashier, body: {} });
    assert.equal(asSelf.status, 403, `a cashier accepted their own transfer: ${asSelf.status}`);
    assert.equal(asSelf.json.code, 'SELF_DECISION');
    assert.equal(await branchOf(), String(wuse.id));

    // (The OWNER may decide too, and that is tested below on its own request — leaving
    // an accept here would have answered the transfer the next subtest needs open, and
    // the failure would have looked like a missing row rather than a stray call.)
  });

  // -------------------------------------------------------------------
  await t.test('the receiving manager accepts, the scope really changes, and the history says so', async () => {
    const open = await peek("SELECT * FROM pending_user_transfers WHERE status = 'PENDING'");
    const accepted = await req('POST', `/api/users/transfers/${open.id}/accept`, { token: tokens.minnaManager, body: {} });
    assert.equal(accepted.status, 200, accepted.text.slice(0, 300));
    assert.equal(accepted.json.status, 'ACCEPTED');
    assert.ok(/now works at Minna Shop/.test(accepted.json.message), `the confirmation does not name the new branch: ${accepted.json.message}`);

    assert.equal(await branchOf(), String(minna.id), 'the transfer was accepted and the user did not move');
    assert.equal(await scopeBranch(tokens.cashier), String(minna.id), 'the accepted cashier still cannot see the branch they now work at');

    const row = await peek("SELECT * FROM user_assignment_history WHERE user_id = ? ORDER BY changed_at DESC, rowid DESC LIMIT 1", [cashier.id]);
    assert.equal(String(row.from_branch_id), String(wuse.id), 'the history does not say where they came FROM');
    assert.equal(String(row.to_branch_id), String(minna.id), 'the history does not say where they went');
    assert.equal(String(row.changed_by), String((await peek("SELECT id FROM users WHERE username = 'ts-minna-mgr'")).id),
      'the history does not record WHO accepted the move');

    const twice = await req('POST', `/api/users/transfers/${open.id}/accept`, { token: tokens.minnaManager, body: {} });
    assert.equal(twice.status, 409, 'a resolved transfer was accepted a second time');
    assert.equal(twice.json.code, 'TRANSFER_NOT_PENDING');
  });

  // -------------------------------------------------------------------
  await t.test('a refusal keeps the person where they are and keeps the reason', async () => {
    // Send them back. The Wuse branch is now the receiving branch, so its manager decides.
    const asked = await req('PUT', `/api/users/${cashier.id}`, { token: tokens.owner, body: { branch_id: wuse.id } });
    assert.equal(asked.status, 200, asked.text.slice(0, 240));
    const open = await peek("SELECT * FROM pending_user_transfers WHERE status = 'PENDING'");
    const refused = await req('POST', `/api/users/transfers/${open.id}/reject`, { token: tokens.wuseManager, body: { reason: 'We do not have a counter for another cashier this quarter.' } });
    assert.equal(refused.status, 200, refused.text.slice(0, 240));
    assert.equal(refused.json.status, 'REJECTED');
    assert.equal(await branchOf(), String(minna.id), 'a refused transfer moved the person anyway');

    const kept = await peek('SELECT status, reason, resolved_by FROM pending_user_transfers WHERE id = ?', [open.id]);
    assert.equal(kept.status, 'REJECTED');
    assert.ok(/do not have a counter/.test(String(kept.reason)), `the refusal reason was not kept: ${kept.reason}`);
    assert.ok(kept.resolved_by, 'the refusal records nobody');

    // And a refused question can be asked again — the unique index only covers PENDING.
    const again = await req('PUT', `/api/users/${cashier.id}`, { token: tokens.owner, body: { branch_id: wuse.id } });
    assert.equal(again.status, 200, `a fresh request after a refusal answered ${again.status}`);

    // The cashier themselves withdraws it.
    const openNow = await peek("SELECT * FROM pending_user_transfers WHERE status = 'PENDING'");
    const cancelled = await req('POST', `/api/users/transfers/${openNow.id}/cancel`, { token: tokens.cashier, body: { reason: 'I am staying in Minna for now.' } });
    assert.equal(cancelled.status, 200, cancelled.text.slice(0, 200));
    assert.equal(cancelled.json.status, 'CANCELLED');
    assert.equal(await branchOf(), String(minna.id));
    const stillOpen = await peek("SELECT COUNT(*) AS c FROM pending_user_transfers WHERE status = 'PENDING'");
    assert.equal(Number(stillOpen.c), 0, 'a withdrawn transfer is still open');
  });

  // -------------------------------------------------------------------
  await t.test('the back-to-front question: who could see this branch on that day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const minnaToday = await req('GET', `/api/assignment-history?branch_id=${minna.id}&at=${today}`, { token: tokens.owner });
    assert.equal(minnaToday.status, 200, minnaToday.text.slice(0, 240));
    const names = minnaToday.json.data.map((r) => r.username);
    assert.ok(names.includes('ts-cashier'), `the cashier who works at Minna today is missing from "who could see Minna today": ${names.join(', ')}`);
    assert.ok(names.includes('ts-minna-mgr'), 'the branch manager is missing from their own branch');
    assert.ok(!names.includes('ts-wuse-mgr'), 'a manager from the other branch is listed as having been at Minna');

    const longAgo = daysAgo(45);
    const minnaThen = await req('GET', `/api/assignment-history?branch_id=${minna.id}&at=${longAgo}`, { token: tokens.owner });
    assert.equal(minnaThen.status, 200);
    const thenNames = (minnaThen.json.data || []).map((r) => r.username);
    assert.ok(!thenNames.includes('ts-cashier'),
      `the cashier moved to Minna today and is listed as having been at Minna on ${longAgo}. "Who could see the till on that day" must be answered from the history, not from today's rota`);

    // 45 DAYS AGO THE CASHIER WAS AT WUSE — their assignment row was backdated to 60
    // days ago by the fixture, so the history has an answer for that date. This is the
    // assertion the feature exists for: the same person, asked about a past date,
    // resolves to the branch they were actually at.
    const wuseThen = await req('GET', `/api/assignment-history?branch_id=${wuse.id}&at=${longAgo}`, { token: tokens.owner });
    assert.equal(wuseThen.status, 200);
    const wuseNames = (wuseThen.json.data || []).map((r) => r.username);
    assert.ok(wuseNames.includes('ts-cashier'), `the cashier was at Wuse on ${longAgo} and is missing from that day's list`);
    assert.ok(wuseNames.includes('ts-wuse-mgr'));

    // AND BEFORE THEY EXISTED, NOBODY IS INVENTED. Every fixture user was created in
    // this run, so a date before the backdated row must return nobody at all — the
    // history answers about the past it recorded and does not project backwards.
    const beforeAnyone = await req('GET', `/api/assignment-history?branch_id=${wuse.id}&at=${daysAgo(90)}`, { token: tokens.owner });
    assert.equal(beforeAnyone.status, 200);
    assert.equal(beforeAnyone.json.count, 0,
      `a date before every user existed returned ${beforeAnyone.json.count} person(s), so the history is projecting the present onto the past`);
    assert.ok(/assignment history/.test(beforeAnyone.json.note), 'the coverage answer does not say what it was read from');

    const asManager = await req('GET', `/api/assignment-history?branch_id=${minna.id}&at=${today}`, { token: tokens.wuseManager });
    assert.equal(asManager.status, 403, `a manager read another branch's coverage: ${asManager.status}`);

    const badDate = await req('GET', `/api/assignment-history?branch_id=${minna.id}&at=last%20Tuesday`, { token: tokens.owner });
    assert.equal(badDate.status, 400, 'a date that is not a date was accepted');
    assert.equal(badDate.json.code, 'INVALID_DATE');
  });

  // -------------------------------------------------------------------
  await t.test('the owner may answer a transfer for any of their branches', async () => {
    // The receiving branch's manager is the person who SHOULD decide, and the owner
    // outranks them: a business with one manager — usually the owner — must not be
    // unable to move its own staff. This is asserted on its own request rather than
    // borrowed from the one above, so it proves what it claims.
    const asked = await req('PUT', `/api/users/${cashier.id}`, { token: tokens.owner, body: { branch_id: wuse.id } });
    assert.equal(asked.status, 200, asked.text.slice(0, 240));
    const open = await peek("SELECT * FROM pending_user_transfers WHERE status = 'PENDING'");
    const accepted = await req('POST', `/api/users/transfers/${open.id}/accept`, { token: tokens.owner, body: {} });
    assert.equal(accepted.status, 200, `the owner could not answer a transfer into their own branch: ${accepted.status} ${accepted.text.slice(0, 200)}`);
    assert.equal(await branchOf(), String(wuse.id), 'the owner accepted and nobody moved');
    const row = await peek("SELECT * FROM user_assignment_history WHERE user_id = ? ORDER BY changed_at DESC, rowid DESC LIMIT 1", [cashier.id]);
    assert.equal(String(row.changed_by), String(owner.id), 'the history does not record the owner as the person who decided');
  });

  // -------------------------------------------------------------------
  await t.test('an administrator moves somebody directly, and even that is written down', async () => {
    const adminLogin = await req('POST', '/api/auth/login', { body: { username: 'ts-admin', pin: '99009' } });
    assert.equal(adminLogin.status, 200, adminLogin.text.slice(0, 160));

    const res = await req('PUT', `/api/users/${cashier.id}`, { token: adminLogin.json.token, body: { branch_id: minna.id } });
    assert.equal(res.status, 200, res.text.slice(0, 240));
    assert.ok(!res.json.pendingTransfer, 'the platform administrator was made to wait for a branch to agree, which is not what an administrator is for');
    assert.equal(await branchOf(), String(minna.id), 'the administrator moved somebody and nothing happened');

    const row = await peek("SELECT * FROM user_assignment_history WHERE user_id = ? ORDER BY changed_at DESC, rowid DESC LIMIT 1", [cashier.id]);
    assert.equal(String(row.to_branch_id), String(minna.id));
    assert.ok(/without a handover/.test(String(row.reason)), `the administrator's own move is unexplained in the history: ${row.reason}`);

    const history = await req('GET', `/api/users/${cashier.id}/assignment-history`, { token: tokens.owner });
    assert.equal(history.status, 200, history.text.slice(0, 200));
    assert.ok(history.json.data.length >= 3, `the cashier's history has ${history.json.data.length} rows for two moves and a creation`);
    for (const h of history.json.data) {
      assert.ok('from_branch_name' in h && 'to_branch_name' in h, 'a history row does not name its branches');
    }

    const asStaff = await req('GET', `/api/users/${cashier.id}/assignment-history`, { token: tokens.cashier });
    assert.equal(asStaff.status, 403, `a cashier read another user's assignment history: ${asStaff.status}`);
  });
});
