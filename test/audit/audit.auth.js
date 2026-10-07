'use strict';
// =====================================================================
// test/audit/audit.auth.js — THE SIGN-IN FURNITURE
// =====================================================================
// Six routes nobody had exercised: signing out, changing your own PIN, the lockout state, the
// owner's override of a lockout, the attempts log, and the cheap token check the service worker
// uses on resume. They are the security furniture of the product, and every one of them is a
// control an owner or an attacker ends up arguing about.
//
//   FRONT TO BACK  you sign out and your token is dead on the next request; you change your PIN
//                  and the old PIN stops working while YOU stay signed in here; somebody fails
//                  eight times and is locked out — including with the CORRECT PIN, which is the
//                  whole point of a lockout; the owner clears it with a reason and it is on the
//                  trail with the state before the override; the attempts log shows the failures
//                  and the policy numbers behind them.
//   BACK TO FRONT  the lockout state and the attempts log are manager-and-owner reading only;
//                  clearing a lockout is owner-only WITH a reason (an attacker who talks a
//                  manager into unlocking gets eight more attempts); a reused PIN is refused;
//                  and — the one that matters most — `/api/auth/verify` cannot be a way around
//                  revocation, because the service worker asks it whether to flush the offline
//                  queue: a "yes" there replays a hundred queued sales against a dead session.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

runAudit('auth', async (audit, d) => {
  const owner = d.owner;
  const manager = d.seats.manager;
  const staff = d.seats.staff;

  // THE SEATS THIS AUDIT SIGNS IN AND OUT OF. They are read from the fixture rather than typed,
  // because a live run suffixes every username (`au-pin-3f9x`) so that a second run against the
  // same deployment can create its own: a hard-coded name would make this file pass locally and
  // fail live, which is the one thing the harness exists to prevent.
  const lockSeat = d.seats && d.seats.lockedOut;
  const logoutSeat = d.seats && d.seats.signsOut;
  const pinSeat = d.seats && d.seats.changesPin;
  const verifySeat = d.seats && d.seats.checksToken;
  if (!lockSeat || !logoutSeat || !pinSeat || !verifySeat) {
    // Read-only live targets create no seats. Stand down and NAME what was not run, so a green
    // result is not read as coverage it has not earned.
    audit.skip('this target is read-only, so the seats this audit signs in, locks out and changes PINs on could not be created',
      'set AUDIT_WRITE=1 to run the sign-in, lockout, unlock, change-PIN and verify checks against it');
    return;
  }
  const idOf = async (username) => {
    const rows = (await owner.get('/api/users?limit=100')).json.data || [];
    const row = rows.find((r) => r.username === username);
    return row ? String(row.id) : null;
  };
  const victimId = await idOf(lockSeat.username);
  assert.ok(victimId, 'the lockout seat is not in the staff list');

  // ------------------------------------------------------------------
  // FRONT TO BACK
  // ------------------------------------------------------------------
  await audit.checkAsync('signing out kills the token on the next request, and is on the trail', async () => {
    const fresh = logoutSeat;
    assert.equal((await fresh.get('/api/auth/me')).status, 200, 'the seat is not signed in to begin with');

    const out = await fresh.post('/api/auth/logout', {});
    assert.ok(out.status < 400, `signing out answered ${out.status}: ${String(out.text).slice(0, 160)}`);

    const after = await fresh.get('/api/auth/me');
    assert.equal(after.status, 401,
      `the token still works after signing out (${after.status}). The row is deleted by design — a missing session row IS a revoked token — and this is where that rule is worth money: a shared till must not leave a live session behind`);
    assert.equal(after.json.code, 'SESSION_REVOKED', `refused as ${after.json.code}`);

    const trail = await owner.get('/api/audit?action=LOGOUT&limit=10');
    const logoutId = await idOf(logoutSeat.username);
    const rows = (trail.json.data || []).filter((r) => String(r.entity_id) === String(logoutId));
    assert.ok(rows.length >= 1, 'signing out is not on the trail');
  });

  await audit.checkAsync('changing your PIN ends the old session, keeps you signed in here, and swaps the PIN', async () => {
    // THE FIX THIS AUDIT WAS WRITTEN AROUND. `DELETE ... WHERE session_id <> ?` bound the raw
    // BEARER TOKEN against a `session_id`, so it never matched and the condition deleted every
    // row: changing your PIN signed you out of the device in your hand, while the message said
    // "sign in again on any other device you were using".
    const seat = pinSeat;
    const before = seat.token;

    const wrong = await seat.post('/api/auth/change-pin', { currentPin: '00000', newPin: '71344' });
    assert.equal(wrong.status, 401, `a wrong current PIN was accepted (${wrong.status})`);
    assert.equal(wrong.json.code, 'BAD_CREDENTIALS', `refused as ${wrong.json.code}`);

    const same = await seat.post('/api/auth/change-pin', { currentPin: seat.pin, newPin: seat.pin });
    assert.equal(same.status, 400, `reusing the same PIN was accepted (${same.status}) — it spends the change without changing anything`);
    assert.equal(same.json.code, 'PIN_UNCHANGED', `refused as ${same.json.code}`);

    const weak = await seat.post('/api/auth/change-pin', { currentPin: seat.pin, newPin: '12' });
    assert.ok(weak.status >= 400, `a two-digit PIN was accepted (${weak.status})`);

    const ok = await seat.post('/api/auth/change-pin', { currentPin: seat.pin, newPin: '71344' });
    assert.ok(ok.status < 400, `changing the PIN answered ${ok.status}: ${String(ok.text).slice(0, 200)}`);
    assert.ok(ok.json.token, 'the route did not return a token for the fresh session — the app has nothing to keep, so the person is signed out of the device in their hand');
    assert.notEqual(ok.json.token, before, 'the "fresh" token is the same one as before the change');
    audit.note(`message: ${ok.json.message}`);

    const oldToken = await d.request('GET', '/api/auth/me', { token: before });
    assert.equal(oldToken.status, 401,
      `the token from before the PIN change still works (${oldToken.status}). A PIN change is how you take a copied session away from somebody — every token that existed before it must be dead`);
    // SUPERSEDED RATHER THAN REVOKED, and the difference is the fix working: the row is not
    // deleted and left absent, it is REPLACED by the fresh session, so the old token is refused
    // as a token for a session that has been signed in over. The person reading the screen gets
    // the message that matters — "if that was not you, your PIN may be known to somebody else".
    assert.equal(oldToken.json.code, 'SESSION_SUPERSEDED', `the pre-change token was refused as ${oldToken.json.code}`);

    const newToken = await d.request('GET', '/api/auth/me', { token: ok.json.token });
    assert.equal(newToken.status, 200,
      `the token the change handed back does not work (${newToken.status}) — the honest user is thrown out along with the attacker, which is what the message promises is not happening`);
    assert.equal(newToken.json.user.username, seat.username, 'the fresh token belongs to somebody else');

    // And exactly one session exists — the new one — which is what the single-row design means.
    // READ BEFORE THE TWO SIGN-INS BELOW: each of them starts a session of its own and replaces
    // the row, so a comparison made afterwards would be asserting about a session nobody was
    // talking about. (Written the other way first, and it failed on two perfectly good ids.)
    const sessions = (await owner.get('/api/sessions')).json.data || [];
    const theirs = sessions.filter((r) => String(r.username) === seat.username);
    assert.equal(theirs.length, 1, `the seat has ${theirs.length} session row(s) after the change`);
    assert.equal(String(theirs[0].session_id), String(ok.json.sessionId),
      `the live row carries session ${JSON.stringify(theirs[0].session_id)} and the route issued ${JSON.stringify(ok.json.sessionId)} — a token for a session that is not the row is a token that will be refused on its next request`);

    // The PIN really changed: the old one is out, the new one is in.
    const oldPin = await d.request('POST', '/api/auth/login', { body: { username: seat.username, pin: seat.pin } });
    assert.equal(oldPin.status, 401, `the OLD PIN still signs in (${oldPin.status})`);
    const newPin = await d.request('POST', '/api/auth/login', { body: { username: seat.username, pin: '71344' } });
    assert.equal(newPin.status, 200, `the new PIN does not sign in (${newPin.status})`);

    const trail = await owner.get('/api/audit?action=USER_PIN_RESET&limit=20');
    const pinUserId = await idOf(seat.username);
    const row = (trail.json.data || []).find((r) => String(r.entity_id) === String(pinUserId));
    assert.ok(row, 'changing a PIN is not on the trail');
  });

  await audit.checkAsync('eight wrong PINs lock the username — including against the CORRECT PIN', async () => {
    // A LOCKOUT THAT STILL ACCEPTS THE RIGHT PIN IS NOT A LOCKOUT: it is a delay, and the
    // attacker simply keeps guessing. This is the check that says so.
    // THE NINTH REQUEST IS THE FIRST REFUSED. The throttle counts the failures already recorded
    // and is asked BEFORE the attempt is checked, so eight wrong PINs leave eight failure rows
    // and the lock bites on the request after them. Asserting on the eighth would be asserting
    // on an off-by-one in my own test, not on the product's.
    let locked = null;
    const failuresBefore = [];
    for (let i = 1; i <= 12; i += 1) {
      const res = await d.request('POST', '/api/auth/login', { body: { username: lockSeat.username, pin: '00000' } });
      if (res.status === 429) { locked = res; break; }
      assert.equal(res.status, 401, `attempt ${i} answered ${res.status}: ${String(res.text).slice(0, 140)}`);
      failuresBefore.push(res);
    }
    assert.ok(locked, 'twelve wrong PINs did not lock the username');
    assert.equal(failuresBefore.length, 8, `${failuresBefore.length} wrong PINs were accepted as failures before the lockout — the policy says eight`);

    const withCorrectPin = await d.request('POST', '/api/auth/login', { body: { username: lockSeat.username, pin: lockSeat.pin } });
    assert.equal(withCorrectPin.status, 429,
      `the CORRECT PIN was accepted while the username was locked out (${withCorrectPin.status}). A lockout that lets a correct guess through protects nobody`);
    assert.equal(withCorrectPin.json.code, 'LOGIN_LOCKED', `refused as ${withCorrectPin.json.code}`);
    // `fetch` lower-cases header names and the harness hands them over as a plain object, so
    // the lookup is case-insensitive rather than exact — reading `Retry-After` off it found
    // nothing and the check failed on the harness's key casing, not on the product.
    const h = locked.headers || {};
    const retryAfter = Number(h['retry-after'] || h['Retry-After'] || 0);
    assert.ok(retryAfter > 0, `the lockout does not say how long it lasts — a person who cannot sign in is owed that (headers: ${JSON.stringify(h)})`);

    // The lock state is readable by a manager, and it says the things the screen needs.
    const state = await manager.get(`/api/auth/lock-state?username=${encodeURIComponent(lockSeat.username)}`);
    assert.equal(state.status, 200, `the lock state answered ${state.status}: ${String(state.text).slice(0, 160)}`);
    // THE FIELD NAMES ARE THE ROUTE'S: `failed_attempts` and `last_failed_at`, not the
    // `failures` a reader would guess. The screen that shows a lockout reads these names, so
    // they are asserted rather than assumed.
    assert.equal(state.json.is_locked, true, `the lock state says the username is not locked: ${JSON.stringify(state.json)}`);
    assert.ok(Number(state.json.failed_attempts) >= 8, `the lock state reports ${state.json.failed_attempts} failure(s) (shape: ${JSON.stringify(state.json)})`);
    assert.equal(Number(state.json.attempts_before_lock), 0, `the lock state offers ${state.json.attempts_before_lock} more attempt(s) on a locked username`);
    assert.ok(state.json.last_failed_at, 'the lock state does not say when the last failure was');
    audit.note(`locked: ${state.json.failed_attempts} failure(s), last ${state.json.last_failed_at}`);

    // AND THE CONTROLS THAT CLEAR IT ARE ON A SCREEN. The route is owner-only and audited — and
    // until this stage NOTHING in the app called it, so an owner with a locked-out cashier at
    // the counter could not clear the lockout from the product at all. Both halves are checked:
    // the route refuses the wrong people (below), and the staff screen offers it to the right
    // ones (here).
    const fs = require('fs');
    const viewSrc = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'js', 'views', 'users.js'), 'utf8');
    assert.match(viewSrc, /\/api\/auth\/lock-state/, 'no screen reads the lock state, so nobody can see who is locked out');
    assert.match(viewSrc, /\/api\/auth\/unlock/, 'no screen calls the unlock route, so the owner cannot clear a lockout from the product');
  });

  await audit.checkAsync('the attempts log is the owner’s, and it names the failures behind the policy', async () => {
    const byManager = await manager.get('/api/auth/attempts');
    assert.equal(byManager.status, 403, `a manager read the sign-in attempts log (${byManager.status})`);

    const res = await owner.get(`/api/auth/attempts?username=${encodeURIComponent(lockSeat.username)}&limit=20`);
    assert.equal(res.status, 200, `the attempts log answered ${res.status}: ${String(res.text).slice(0, 160)}`);
    // READ BEFORE THE UNLOCK CHECK, DELIBERATELY: clearing a lockout deletes the failure rows
    // that feed the throttle (`clearLoginLock`), so a log read afterwards would be empty and
    // this check would be asserting on the cleanup rather than on the record. The failures stay
    // on the audit trail either way — that is the difference between the throttle's ledger and
    // the trail, and it is why the unlock row is checked separately.
    const rows = res.json.data || [];
    assert.ok(rows.length >= 8, `the log holds ${rows.length} attempt(s) for a username that failed eight times`);
    const failures = rows.filter((r) => !Number(r.succeeded));
    assert.ok(failures.length >= 8, `${failures.length} failure(s) recorded`);
    for (const key of ['username', 'succeeded', 'attempted_at']) {
      assert.ok(failures[0][key] !== undefined, `an attempt row does not carry ${key}, so the screen cannot show it`);
    }
    // The policy numbers the screen prints come from the same constants the throttle enforces.
    // AND THE SCREEN READS THE FIELDS THIS ROUTE ACTUALLY SENDS. Three of the four columns in
    // that table came from a guess when it was first written, and a wrong name renders an em
    // dash rather than an error — the defect this codebase has now found on four screens. The
    // scan is anchored to the attempts table so it cannot pass by scanning a different one.
    const fsAttempts = require('fs');
    const path = require('path');
    const viewSrcAttempts = fsAttempts.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'views', 'users.js'), 'utf8');
    assert.match(viewSrcAttempts, /\/api\/auth\/attempts/, 'no screen reads the attempts log, so the failures behind a lockout are invisible to the owner');
    const routeSrc = fsAttempts.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', 'loginThrottle.js'), 'utf8');
    const attemptSelect = routeSrc.match(/SELECT ([a-z_,\s]+) FROM login_attempts/);
    assert.ok(attemptSelect, 'the attempts SELECT could not be found in loginThrottle.js — this scan needs updating, not deleting');
    const sent = new Set(attemptSelect[1].split(',').map((x) => x.trim()).filter(Boolean));
    assert.ok(sent.has('attempted_at') && sent.has('succeeded') && sent.has('ip_address') && sent.has('user_agent'),
      `the scan read the wrong query: ${[...sent].join(', ')}`);
    const tableBody = viewSrcAttempts.slice(viewSrcAttempts.indexOf("title: 'Recent sign-in attempts'"), viewSrcAttempts.indexOf('rows,', viewSrcAttempts.indexOf("title: 'Recent sign-in attempts'")));
    const keys = [...tableBody.matchAll(/\{\s*key:\s*'([a-z_]+)'/gi)].map((m) => m[1]);
    assert.ok(keys.length >= 4, `the scan found ${keys.length} column(s) in the attempts table`);
    const dead = keys.filter((k) => !sent.has(k));
    assert.deepEqual(dead, [], `the attempts table reads ${JSON.stringify(dead)} and the route sends ${[...sent].join(', ')}`);

    const policy = res.json.policy || {};
    assert.equal(Number(policy.maxFailedAttempts), 8, `the log advertises ${policy.maxFailedAttempts} attempts before a lockout`);
    assert.ok(Number(policy.lockoutMinutes) > 0, 'the log does not say how long a lockout lasts');
    audit.note(`attempts: ${rows.length} row(s), policy ${JSON.stringify(policy)}`);
  });

  await audit.checkAsync('the lockout is nobody’s to clear but the owner’s, with a reason, and it is on the trail', async () => {
    const byStaff = await staff.get(`/api/auth/lock-state?username=${encodeURIComponent(lockSeat.username)}`);
    assert.equal(byStaff.status, 403, `a cashier read a colleague's lockout state (${byStaff.status})`);
    assert.equal(byStaff.json.code, 'ROLE_REQUIRED', `refused as ${byStaff.json.code}`);

    const byManager = await manager.post('/api/auth/unlock', { username: lockSeat.username, reason: 'they say it is them' });
    assert.equal(byManager.status, 403,
      `a manager cleared a security lockout (${byManager.status}). An attacker who persuades a manager gets another eight attempts, which is why this belongs to the proprietor`);
    assert.equal(byManager.json.code, 'ROLE_REQUIRED', `refused as ${byManager.json.code}`);

    const noReason = await owner.post('/api/auth/unlock', { username: lockSeat.username, reason: 'no' });
    assert.equal(noReason.status, 400, `a two-character reason was accepted (${noReason.status})`);
    assert.equal(noReason.json.code, 'REASON_REQUIRED', `refused as ${noReason.json.code}`);

    const stillLocked = await d.request('POST', '/api/auth/login', { body: { username: lockSeat.username, pin: lockSeat.pin } });
    assert.equal(stillLocked.status, 429, 'a refused unlock cleared the lock anyway');

    const cleared = await owner.post('/api/auth/unlock', { username: lockSeat.username, reason: 'the cashier is at the counter and I know it is them' });
    assert.ok(cleared.status < 400, `the owner could not clear the lockout (${cleared.status}): ${String(cleared.text).slice(0, 200)}`);

    const back = await d.request('POST', '/api/auth/login', { body: { username: lockSeat.username, pin: lockSeat.pin } });
    assert.equal(back.status, 200, `the correct PIN still does not work after the owner cleared the lockout (${back.status})`);

    const trail = await owner.get('/api/audit?action=LOGIN_LOCK_CLEARED&limit=10');
    const rows = trail.json.data || [];
    assert.ok(rows.length >= 1, 'clearing a security lockout is not on the trail');
    const row = rows.find((r) => String(r.entity_id) === lockSeat.username);
    assert.ok(row, `no trail row names the username: ${JSON.stringify(rows.map((r) => r.entity_id))}`);
    assert.match(String(row.after_json || ''), /reason/, 'the override does not record WHY, which is the one thing an owner will be asked later');
    assert.match(String(row.before_json || ''), /failures|is_locked/, 'the override does not record the state it overrode');
    });

  await audit.checkAsync('verify answers the service worker, and is not a way around a revoked session', async () => {
    // THE SERVICE WORKER ASKS THIS BEFORE FLUSHING THE OFFLINE QUEUE. A "yes" for a dead session
    // replays a hundred queued sales into a refusal, so the cheap check has to be as strict about
    // the session row as the expensive one.
    const noToken = await d.request('GET', '/api/auth/verify');
    assert.equal(noToken.status, 401, `verify with no token answered ${noToken.status}`);
    assert.equal(noToken.json.code, 'NO_TOKEN', `refused as ${noToken.json.code}`);

    const seat = verifySeat;
    const good = await seat.get('/api/auth/verify');
    assert.equal(good.status, 200, `verify answered ${good.status} for a live token`);
    assert.equal(good.json.username, seat.username, 'verify does not say who the token belongs to');
    assert.ok(good.json.scope && typeof good.json.scope === 'object', 'verify does not answer the scope, which is what the caller decides with');

    // The owner revokes the session behind the token; verify must change its answer.
    const rows = (await owner.get('/api/sessions')).json.data || [];
    const row = rows.find((r) => String(r.username) === seat.username);
    assert.ok(row, 'the seat has no session row to revoke');
    const revoked = await owner.post(`/api/sessions/${encodeURIComponent(row.user_id)}/revoke`, {});
    assert.ok(revoked.status < 400, `the owner could not revoke the session (${revoked.status})`);

    const dead = await seat.get('/api/auth/verify');
    assert.equal(dead.status, 401,
      `verify still says the revoked token is good (${dead.status}). The offline queue would be flushed against a dead session — the exact replay this route exists to prevent`);
    assert.equal(dead.json.code, 'SESSION_REVOKED', `refused as ${dead.json.code}`);
  });
}, {
  setup: () => startDeployment({
    label: 'auth',
    businesses: [{
      name: 'Sign-in Audit Stores', profileCode: 'GENERAL_RETAIL', vatRegistered: true,
      branches: [
        { name: 'Sign-in Audit Branch', code: 'AU-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 9000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'au-owner', pin: '71340', branchIndex: 0, full_name: 'Sign-in Audit Owner' },
      { as: 'manager', role: 'MANAGER', username: 'au-manager', pin: '71346', branchIndex: 0, full_name: 'Sign-in Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'au-staff', pin: '71347', branchIndex: 0, full_name: 'Sign-in Audit Counter' },
      // The seats this audit signs in and out of, changes the PIN of, locks and verifies.
      { as: 'lockedOut', role: 'STAFF', username: 'au-locked', pin: '71341', branchIndex: 0, full_name: 'Locked Out' },
      { as: 'signsOut', role: 'STAFF', username: 'au-logout', pin: '71342', branchIndex: 0, full_name: 'Signs Out' },
      { as: 'changesPin', role: 'STAFF', username: 'au-pin', pin: '71343', branchIndex: 0, full_name: 'Changes The PIN' },
      { as: 'checksToken', role: 'STAFF', username: 'au-verify', pin: '71345', branchIndex: 0, full_name: 'Checks The Token' },
    ],
  }),
});
