'use strict';
// =====================================================================
// test/audit/audit.sessions.js — WHO IS SIGNED IN, AND CUTTING THEM OFF
// =====================================================================
// `user_sessions` is keyed by `user_id`, so this product is deliberately **one active
// session per person**: signing in on a second device supersedes the first, and revoking a
// person ends every session they have. That is the right shape for a shop — a shared till
// login on a phone that has left the premises is otherwise indistinguishable from the person
// still at the counter — and it makes two things load-bearing:
//
//   1. **a missing session row must reject the token**, or "sign out" and "revoke" do nothing
//      until the twelve-hour token expires (a defect this codebase has already had once, and
//      the comment in `server/middleware/auth.js` records it);
//   2. **the revoke route is the only way to cut off a device that is not in your hand**, and
//      who may cut off whom is an authority question, not a convenience.
//
//   FRONT TO BACK  a seat signs in → it appears in the list once, with its role, branch and
//                  last action → a manager revokes a cashier → the cashier's next request is
//                  refused as `SESSION_REVOKED` → the revocation is on the trail with how many
//                  sessions it ended.
//   BACK TO FRONT  the list a manager sees contains only the people they can manage; a manager
//                  cannot revoke an owner or the vendor; a cashier cannot revoke anybody but
//                  themselves; and a second sign-in from a seat invalidates the FIRST token
//                  rather than leaving two live sessions behind.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

runAudit('sessions', async (audit, d) => {
  const owner = d.owner || d.admin;
  const manager = d.seats && d.seats.manager;
  const staff = d.seats && d.seats.staff;
  assert.ok(manager && staff, 'this audit needs a MANAGER and a STAFF seat — signing people out is about people');

  const listSessions = async (who) => {
    const res = await who.get('/api/sessions');
    assert.equal(res.status, 200, `the session list answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    return res.json.data || res.json.rows || [];
  };
  // THE IDS COME FROM THE LIST, not from the fixture: a seat Actor carries its token and the
  // user the login answered with, and the row's own `user_id` is what the revoke route takes.
  // Reading it from the list is also the check that the list is usable for the purpose it
  // exists for — you cannot revoke what you cannot name.
  const idOf = async (username) => {
    const rows = await listSessions(owner);
    const row = rows.find((r) => String(r.username) === String(username));
    return row ? String(row.user_id) : null;
  };

  // ------------------------------------------------------------------
  // FRONT TO BACK
  // ------------------------------------------------------------------
  await audit.checkAsync('every signed-in seat is listed once, with who and where they are', async () => {
    const rows = await listSessions(owner);
    assert.ok(rows.length >= 3, `the deployment lists ${rows.length} session(s) with three seats signed in`);
    const byUser = new Map();
    for (const r of rows) byUser.set(String(r.user_id), (byUser.get(String(r.user_id)) || 0) + 1);
    const doubled = [...byUser.entries()].filter(([, n]) => n > 1);
    assert.deepEqual(doubled, [], `a person is listed ${JSON.stringify(doubled)} times. ` + 'One active session per user is the design; a list that shows two is a list that lies about what revocation would end');
    const seat = rows[0];
    for (const key of ['username', 'role', 'session_id', 'issued_at', 'expires_at', 'device_id']) {
      assert.ok(seat[key] !== undefined && seat[key] !== null,
        `the session row does not carry ${key}, so the screen showing it draws an em dash at every row. ` +
        'Three columns of this screen were dead reads once already: the route sent `last_ip` and the `issued_at` timestamps while the table asked for `ip_address`, `created_at`, `expires_at` and a `device_id` that was not in the schema at all');
    }
    // The device is the id the sign-in reported, and the expiry is the one the token really has.
    assert.match(String(seat.device_id), /^audit-/, `the device on the row is ${seat.device_id}, not the id the sign-in sent`);
    const issued = Date.parse(String(seat.issued_at).replace(' ', 'T') + 'Z');
    const expires = Date.parse(String(seat.expires_at).replace(' ', 'T') + 'Z');
    assert.ok(expires > issued, `the session expires (${seat.expires_at}) at or before it was issued (${seat.issued_at})`);
    assert.ok(expires - issued <= 13 * 3600 * 1000, `a session that lives ${(expires - issued) / 3600000} hours is not the twelve-hour session the token is signed for`);
  });

  await audit.checkAsync('a manager may revoke a cashier, and the cashier is cut off immediately', async () => {
    // THE POINT OF THE FEATURE. A token that keeps working after its session row is deleted is
    // a revocation that does not revoke.
    // A FRESH SIGN-IN FOR THE CASHIER, so the token being cut off is definitely live.
    //
    // THE ID COMES FROM THE SESSION LIST, NOT FROM THE LOGIN RESPONSE. `/api/auth/login`
    // answers `{ok, token, sessionId, profile, scope}` — there is no `user` on it, and an
    // earlier version of this audit read `login.user.id` and threw on every check. It is the
    // same class of mistake `tools/frontend-figures.js` hunts in the screens: a field read
    // that the server never sends, which fails only when it is used.
    const live = await d.login({ username: staff.username, pin: staff.pin });
    const staffId = await idOf(staff.username);
    const before = await listSessions(manager);
    const target = before.find((r) => String(r.user_id) === String(staffId));
    assert.ok(target, 'the cashier is not in the manager’s session list, so there is nothing to revoke');

    const revoke = await manager.post(`/api/sessions/${encodeURIComponent(target.user_id)}/revoke`, {});
    assert.ok(revoke.status < 400, `revoking the cashier answered ${revoke.status}: ${String(revoke.text).slice(0, 220)}`);
    assert.ok(Number(revoke.json.sessionsEnded) >= 1, `the revocation ended ${revoke.json.sessionsEnded} session(s)`);

    const after = await live.get('/api/auth/me');
    assert.equal(after.status, 401,
      `the revoked cashier's token still works (${after.status}). Revocation that leaves a live token is a message, not a control`);
    assert.equal(after.json.code, 'SESSION_REVOKED', `the refusal came back as ${after.json.code}`);

    // AND THE SEAT CAN SIGN BACK IN, because a revocation is not a lock-out.
    const again = await d.login({ username: staff.username, pin: staff.pin });
    assert.equal((await again.get('/api/auth/me')).status, 200,
      'the cashier could not sign back in after being revoked — revocation must not be a deactivation');
    staff.token = again.token;
  });

  await audit.checkAsync('the revocation is on the trail, with the count', async () => {
    const revokedId = await idOf(staff.username);
    const res = await owner.get('/api/audit?action=SESSIONS_REVOKED&limit=20');
    assert.equal(res.status, 200, `the trail answered ${res.status}`);
    const rows = (res.json.data || []).filter((r) => String(r.entity_id) === String(revokedId));
    assert.ok(rows.length >= 1,
      'signing somebody out is not on the trail. Who cut off whose access, and when, is exactly what a trail is for');
    const after = String(rows[0].after_json || '');
    assert.match(after, /sessionsEnded/, `the row must say how many sessions it ended: ${after.slice(0, 140)}`);
    assert.match(after, /"self":\s*false/, 'and it must distinguish revoking somebody else from signing yourself out');
    audit.note(`trail: ${rows[0].action} by ${rows[0].username} — ${after.slice(0, 90)}`);
  });

  // ------------------------------------------------------------------
  // BACK TO FRONT
  // ------------------------------------------------------------------
  await audit.checkAsync('a manager cannot cut off an owner or the vendor', async () => {
    const ownerRow = (await listSessions(owner)).find((r) => String(r.username) === String(owner.username));
    assert.ok(ownerRow, 'the owner is not in the session list');
    const res = await manager.post(`/api/sessions/${encodeURIComponent(ownerRow.user_id)}/revoke`, {});
    assert.equal(res.status, 403, `a manager revoked the owner (${res.status}). Cutting off the person above you is not a manager's power`);
    assert.equal(res.json.code, 'ROLE_REQUIRED', `refused as ${res.json.code}`);
    assert.match(String(res.json.error || res.json.message || ''), /owner|admin/i, 'the refusal should name the role it refused');

    const admin = d.admin;
    if (admin) {
      const adminRow = (await listSessions(owner)).find((r) => String(r.username) === String(admin.username));
      if (!adminRow) {
        audit.note('the vendor seat is not in the client’s session list, so there is no row to refuse — see the scope check below');
      } else {
        const adminRes = await manager.post(`/api/sessions/${encodeURIComponent(adminRow.user_id)}/revoke`, {});
        assert.equal(adminRes.status, 403, `a manager revoked the deployment administrator (${adminRes.status})`);
      }
    }
    // And the owner is still signed in — a refused write that wrote is worse than no rule.
    const still = await owner.get('/api/auth/me');
    assert.equal(still.status, 200, 'the owner was cut off by a refused revocation');
  });

  await audit.checkAsync('a cashier cannot revoke anybody, and may sign themselves out', async () => {
    const mine = await d.login({ username: staff.username, pin: staff.pin });
    const managerId = await idOf(manager.username);
    const myId = await idOf(staff.username);
    assert.ok(myId, 'the cashier has no session row to sign out of');
    const others = await mine.post(`/api/sessions/${encodeURIComponent(managerId)}/revoke`, {});
    assert.equal(others.status, 403, `a cashier revoked their manager (${others.status})`);
    assert.equal(others.json.code, 'ROLE_REQUIRED', `refused as ${others.json.code}`);
    // Self is allowed for every role: signing yourself out is not an authority question.
    const self = await mine.post(`/api/sessions/${encodeURIComponent(myId)}/revoke`, {});
    assert.ok(self.status < 400, `a cashier could not sign themselves out (${self.status}): ${String(self.text).slice(0, 200)}`);
    const gone = await mine.get('/api/auth/me');
    assert.equal(gone.status, 401, 'signing yourself out left the token working');
    // Back in for the rest of the run.
    const back = await d.login({ username: staff.username, pin: staff.pin });
    assert.equal((await back.get('/api/auth/me')).status, 200, 'the cashier could not sign back in');
    staff.token = back.token;
  });

  await audit.checkAsync('a second sign-in replaces the first rather than adding one', async () => {
    // ONE SESSION PER PERSON, and the old token dies. Without this a shared till login stays
    // live on a device that has left the shop.
    const first = await d.login({ username: staff.username, pin: staff.pin });
    const firstToken = first.token;
    assert.equal((await first.get('/api/auth/me')).status, 200, 'the first sign-in is not live to begin with');

    const second = await d.login({ username: staff.username, pin: staff.pin });
    assert.ok(second.token && second.token !== firstToken, 'the second sign-in returned the same token');

    const old = await d.request('GET', '/api/auth/me', { token: firstToken });
    assert.equal(old.status, 401,
      `the previous token still works after a second sign-in (${old.status}). Two live tokens for one seat is how a shared login outlives the person who shared it`);
    // THE TWO REFUSALS ARE DIFFERENT ON PURPOSE, and the difference is worth asserting: a
    // revoked token says "you have been signed out", a superseded one says "this account
    // signed in somewhere else, and if that was not you, tell a manager". A single generic
    // code would hide the one a person needs to act on.
    assert.equal(old.json.code, 'SESSION_SUPERSEDED',
      `a token replaced by a newer sign-in was refused as ${old.json.code} — the message it carries tells the person their PIN may be known to somebody else`);
    assert.match(String(old.json.error || old.json.message || ''), /signed in somewhere else/i, 'the superseded refusal must say what happened');
    assert.equal((await second.get('/api/auth/me')).status, 200, 'the newest token does not work');
    staff.token = second.token;

    const rows = await listSessions(owner);
    const theirId = await idOf(staff.username);
    const theirs = rows.filter((r) => String(r.user_id) === String(theirId));
    assert.equal(theirs.length, 1, `the cashier appears ${theirs.length} time(s) in the session list after signing in twice`);
  });

  await audit.checkAsync('the screens read only the fields the route sends — both of them', async () => {
    // THIS CHECK EXISTS BECAUSE THE BUG CAME BACK. The audit trail screen read `row_hash` as
    // `hash` and three more names the API has never sent; P13 fixed it and pinned it with a
    // source scan. The two session screens were wrong in exactly the same way — they asked for
    // `ip_address`, `created_at`, `expires_at` and `device_id` while the route answered
    // `last_ip`, `issued_at` and no device at all — and nothing noticed, because a missing name
    // renders as an em dash rather than as an error. A screen and a query are two halves of one
    // contract; this is the half that was only ever checked by eye.
    const fs = require('fs');
    const path = require('path');
    const root = path.resolve(__dirname, '..', '..');
    const routeSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'admin.js'), 'utf8');
    const sql = routeSrc.match(/SELECT us\.user_id[\s\S]*?FROM user_sessions us[\s\S]*?LIMIT 200/);
    assert.ok(sql, 'the sessions query could not be found in server/routes/admin.js — this scan needs updating, not deleting');
    const sent = new Set();
    for (const m of sql[0].matchAll(/\bAS\s+([a-z_]+)/gi)) sent.add(m[1].toLowerCase());
    for (const m of sql[0].matchAll(/\bu\.([a-z_]+)|\bus\.([a-z_]+)|\bb\.([a-z_]+)/gi)) sent.add(String(m[1] || m[2] || m[3]).toLowerCase());
    assert.ok(sent.has('last_ip') && sent.has('issued_at') && sent.has('expires_at') && sent.has('device_id'),
      `the scan read the wrong query, or the fields moved: ${[...sent].sort().join(', ')}`);

    // Columns that carry no data from the row (an action button) are named here rather than
    // silently skipped, so a NEW dead read cannot hide behind a loose pattern.
    const notData = new Set(['revoke', 'actions', 'select', 'checkbox']);
    // EACH SCAN IS ANCHORED TO THE ONE TABLE IT IS ABOUT. Scanning a whole file was the first
    // version of this check and it failed on `account.js` — a screen with six tables and one
    // sessions card — by reporting another table's columns (`person`, `asked`, `act`). A scan
    // that wide would also stay green if the sessions card were deleted outright.
    const screen = (file, anchor, stop) => {
      const src = fs.readFileSync(path.join(root, file), 'utf8');
      const start = src.indexOf(anchor);
      assert.ok(start >= 0, `${file} no longer contains ${anchor} — the scan needs updating, not deleting`);
      const end = src.indexOf(stop, start + anchor.length);
      assert.ok(end > start, `${file}: could not find the end of the block (${stop}) — the scan needs updating`);
      const body = src.slice(start, end);
      const keys = [...body.matchAll(/\{\s*key:\s*'([a-z_]+)'/gi)].map((m) => m[1].toLowerCase());
      return { keys, body };
    };
    for (const [file, anchor, stop] of [
      ['public/js/views/users.js', 'function renderSessions', "\n    }"],
      ['public/js/views/account.js', "'Where you are signed in'", 'rows: sessions'],
    ]) {
      const { keys } = screen(file, anchor, stop);
      assert.ok(keys.length >= 4, `${file}: the scan found ${keys.length} column(s) in the sessions table — it is no longer looking at the table`);
      const dead = keys.filter((k) => !sent.has(k) && !notData.has(k));
      assert.deepEqual(dead, [],
        `${file} reads ${JSON.stringify(dead)} and the sessions route does not send it. The row carries: ${[...sent].sort().join(', ')}`);
      audit.note(`${file}: ${keys.length} column(s), all named by the route`);
    }
  });

  await audit.checkAsync('THE VENDOR IS NOT IN THE CLIENT’S LISTS — in either direction', async () => {
    // A session row names a person, where they are working from and when they last touched the
    // system. The deployment administrator's own session was listed to every client manager,
    // and there was nothing they could do with it: `canManageUser` refuses the revocation, so
    // it was information they could not act on and had no business holding. The staff list had
    // the same leak — the vendor's account, with every action on it answering 403, sitting in
    // the middle of the people the client CAN manage. The plan's own wording settles the rule:
    // "the ADMIN vendor seat is NOT counted — it is not part of the client's team".
    //
    // The rule is written twice, once per route, as `!atLeast(user.role, 'ADMIN') => u.role <>
    // 'ADMIN'`, so it is checked here against BOTH lists for every client seat — a rule that
    // lives in two places needs a check that says both places carry it.
    for (const [who, me] of [['owner', owner], ['manager', manager]]) {
      const rows = await listSessions(me);
      assert.ok(rows.length >= 1, `the ${who} sees no sessions at all`);
      assert.ok(!rows.some((r) => String(r.role) === 'ADMIN'),
        `the ${who} can see the deployment administrator's session`);
      audit.note(`${who} sees ${rows.length} session(s): ${[...new Set(rows.map((r) => String(r.role)))].join(', ')}`);

      const staffList = await me.get('/api/users?limit=100');
      assert.equal(staffList.status, 200, `the ${who} could not list users (${staffList.status})`);
      const staffRows = staffList.json.data || staffList.json.rows || [];
      assert.ok(staffRows.length >= 2, `the ${who} sees ${staffRows.length} user(s)`);
      assert.ok(!staffRows.some((r) => String(r.role) === 'ADMIN'),
        `the ${who}'s staff list still holds the vendor's account — a row they cannot manage, cannot reset and cannot revoke`);
    }

    // AND THE VENDOR STILL SEES THEMSELVES. Hiding the account from the administrator would
    // hide from them the session that is signed in as them, and the screen that signs them out.
    const admin = d.admin;
    if (admin) {
      const adminUsers = await admin.get('/api/users?limit=100');
      assert.equal(adminUsers.status, 200, `the deployment administrator could not list users (${adminUsers.status})`);
      const adminRows = adminUsers.json.data || adminUsers.json.rows || [];
      assert.ok(adminRows.some((r) => String(r.role) === 'ADMIN'),
        'the deployment administrator cannot see their own account in the staff list');
      audit.note(`the vendor sees ${adminRows.length} user(s), their own included`);
    }
  });
}, {
  setup: () => startDeployment({
    label: 'sessions',
    businesses: [{
      name: 'Sessions Audit Stores', profileCode: 'GENERAL_RETAIL', vatRegistered: true,
      branches: [
        { name: 'Sessions Audit Branch', code: 'SES-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 15000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'ses-owner', pin: '60951', branchIndex: 0, full_name: 'Sessions Audit Owner' },
      { as: 'manager', role: 'MANAGER', username: 'ses-manager', pin: '60952', branchIndex: 0, full_name: 'Sessions Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'ses-staff', pin: '60953', branchIndex: 0, full_name: 'Sessions Audit Counter' },
    ],
  }),
});
