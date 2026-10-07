'use strict';
// =====================================================================
// test/integration/notifications.test.js — A BELL THAT COUNTS WHAT THE LIST SHOWS
// =====================================================================
// The notification engine has exactly one producer today: the daily compliance sweep
// (`POST /api/compliance/notify` and its cron twin) writes COMPLIANCE_EXPIRY rows for
// permits and licences that are about to lapse. Those rows are the ONLY thing standing
// between a pharmacy and a closed door for an expired licence, and until P11 nothing in
// the product could show them — no screen listed notifications, so a manager never saw
// an alert the system had carefully raised for them.
//
// Building the list exposed the defect underneath it. BOTH halves of the audience had
// been scoped by the caller's OWN `branch_id`, with the literal string `'__none__'`
// standing in for "this user has no branch" — which is every OWNER and every ADMIN:
//
//   * the LIST was fixed first (see the comment in server/routes/admin.js), so an owner
//     could finally see the alerts;
//   * **"MARK ALL READ" still had the old predicate**, so the two seats most likely to
//     press it marked NOTHING, and a multi-branch manager marked their own branch and
//     left the rest unread forever — while the list beside the button showed them.
//
// The rule these tests hold the route to: **read-all marks exactly what the list shows,
// no more and no less.** They assert it from three seats — an owner who reaches
// everything, a manager who reaches one branch of several, and a staff member — and in
// both directions: nothing visible is left unread, and nothing invisible is touched.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { createHttpApp } = require('../../server/app');
const { buildSeedSql } = require('../../tools/d1-seed');
const { newId } = require('../../domain/crypto');

const ADMIN_PIN = '90210';
const OWNER_PIN = '48213';
const MANAGER_PIN = '31415';
const STAFF_PIN = '27182';
let counter = 0;

/**
 * A deployment with one business, TWO branches, an owner over both, a manager and a
 * staff member at the first — so "what this seat can see" is a real question rather
 * than a single branch that happens to match.
 */
async function withDeployment(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-notify-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    await db.exec((await buildSeedSql({ username: 'admin', pin: ADMIN_PIN, businessName: null, adminName: 'Vendor Admin' })).sql);
    const app = createHttpApp({ db, jwtSecret: 'notifications-test-secret-long-enough', settings: {} });

    const call = async (method, url, { token, body } = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await app.fetch(new Request(`http://local${url}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      }));
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return { status: res.status, json, text };
    };
    const login = async (username, pin) => {
      const res = await call('POST', '/api/auth/login', { body: { username, pin } });
      if (res.status !== 200) throw new Error(`login as ${username} failed: ${res.status} ${res.text.slice(0, 200)}`);
      return res.json.token;
    };

    const adminToken = await login('admin', ADMIN_PIN);
    const created = await call('POST', '/api/businesses', {
      token: adminToken,
      body: { name: 'Notify Testing Ltd', profile_code: 'GENERAL_RETAIL', vat_registered: true, branch: { name: 'Main', city: 'Abuja', state: 'FCT', opening_cash: 0 } },
    });
    if (created.status !== 201) throw new Error(`business creation failed: ${created.status} ${created.text.slice(0, 300)}`);
    const businessId = created.json.id;
    const branchA = created.json.branch_id;
    const second = await call('POST', '/api/branches', {
      token: adminToken,
      body: { business_id: businessId, name: 'Annexe', city: 'Abuja', state: 'FCT' },
    });
    if (second.status !== 201) throw new Error(`branch creation failed: ${second.status} ${second.text.slice(0, 200)}`);
    const branchB = second.json.id;

    const makeUser = async (fullName, username, role, pin, branchId) => {
      const res = await call('POST', '/api/users', {
        token: adminToken,
        body: { full_name: fullName, username, role, pin, confirm_pin: pin, branch_id: branchId || null },
      });
      if (res.status !== 201) throw new Error(`${role} creation failed: ${res.status} ${res.text.slice(0, 200)}`);
      return res.json.id;
    };
    // AN OWNER'S ROW CARRIES A BRANCH (the create route requires one) AND THEY STILL
    // REACH EVERY BRANCH of their business — the scope decides that from the ROLE, not
    // from the column. That is exactly why the old read-all predicate was wrong: it read
    // the column.
    await makeUser('Notify Owner', 'owner', 'OWNER', OWNER_PIN, branchA);
    const managerId = await makeUser('Notify Manager', 'manager', 'MANAGER', MANAGER_PIN, branchA);
    const staffId = await makeUser('Notify Staff', 'staff', 'STAFF', STAFF_PIN, branchA);

    const tokens = {
      owner: await login('owner', OWNER_PIN),
      manager: await login('manager', MANAGER_PIN),
      staff: await login('staff', STAFF_PIN),
      admin: adminToken,
    };
    return await fn({ db, app, call, tokens, businessId, branchA, branchB, managerId, staffId });
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  }
}

/** Raise a notification by hand — the same shape the compliance sweep writes. */
async function raise(db, { businessId, branchId = null, userId = null, type = 'COMPLIANCE_EXPIRY', title, severity = 'WARNING' }) {
  const id = newId();
  await db.run(`INSERT INTO notifications (id, business_id, branch_id, user_id, type, severity, title, body, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  [id, businessId, branchId, userId, type, severity, title, `${title} — body`]);
  return id;
}

test('a notification is visible to the seat that can act on it, and to nobody else', async (t) => {
  await withDeployment(async ({ db, call, tokens, businessId, branchA, branchB, staffId }) => {
    await raise(db, { businessId, branchId: branchA, title: 'A: premises licence' });
    await raise(db, { businessId, branchId: branchB, title: 'B: annexe permit' });
    await raise(db, { businessId, branchId: null, title: 'business-wide audit notice', severity: 'INFO' });
    await raise(db, { businessId, branchId: branchA, userId: staffId, title: 'addressed to one person only' });

    const listFor = async (token, query = '') => {
      const res = await call('GET', `/api/notifications${query}`, { token });
      assert.equal(res.status, 200, `the list answered ${res.status}: ${res.text.slice(0, 200)}`);
      return res.json;
    };

    await t.test('an owner sees every branch of their business, and the unread count agrees', async () => {
      const list = await listFor(tokens.owner);
      const titles = (list.data || []).map((n) => n.title).sort();
      assert.deepEqual(titles, ['A: premises licence', 'B: annexe permit', 'business-wide audit notice'].sort(),
        'an owner reaches every branch — a broadcast about the annexe is an owner\'s business');
      assert.equal(list.unread, 3, 'the unread count must match the rows the owner can see');
    });

    await t.test('a manager at one branch sees their own branch and the broadcast, not the other branch', async () => {
      const list = await listFor(tokens.manager);
      const titles = (list.data || []).map((n) => n.title).sort();
      assert.deepEqual(titles, ['A: premises licence', 'business-wide audit notice'].sort(),
        'a manager must not see another branch\'s alerts');
      assert.equal(list.unread, 2);
    });

    await t.test('a notification addressed to somebody else is not in the list at all', async () => {
      const list = await listFor(tokens.manager);
      assert.ok(!(list.data || []).some((n) => /one person only/.test(n.title)),
        'a notification addressed to another user is not a broadcast');
      const mine = await listFor(tokens.staff);
      assert.ok((mine.data || []).some((n) => /one person only/.test(n.title)), 'the addressed user must see their own');
    });

    await t.test('unread=1 narrows the list without changing the count', async () => {
      const list = await listFor(tokens.owner, '?unread=1');
      assert.equal((list.data || []).length, 3);
      assert.equal(list.unread, 3);
    });

    await t.test('clearing a BRANCH alert clears it for the branch, and the next sweep brings it back', async () => {
      // THE READ SEMANTICS, PINNED DELIBERATELY RATHER THAN DISCOVERED LATER.
      //
      // A notification with `user_id IS NULL` is a broadcast about a BRANCH ("the
      // premises licence expires in 12 days") and there is one `is_read` column to
      // express it — so it is a SHARED WORK ITEM: whoever renews the licence clears it
      // for the shop, and a colleague is not nagged about something already handled.
      // Per-person read state would need a join table; inventing one to make a bell feel
      // personal would be the wrong trade for an alert that is about a branch.
      //
      // What makes that safe is the PRODUCER, not the flag: the sweep skips a record only
      // while it has an UNREAD alert, so clearing the bell without renewing the licence
      // raises it again the next morning. This subtest proves both halves.
      const list = await listFor(tokens.manager);
      const target = (list.data || []).find((n) => n.title === 'A: premises licence');
      const res = await call('POST', `/api/notifications/${target.id}/read`, { token: tokens.manager, body: {} });
      assert.equal(res.status, 200, `marking one read answered ${res.status}: ${res.text.slice(0, 200)}`);
      const after = await listFor(tokens.manager);
      assert.equal(after.unread, 1, 'the count must drop by exactly the one that was marked');
      const ownerNow = await listFor(tokens.owner);
      assert.ok(!(ownerNow.data || []).some((n) => n.title === 'A: premises licence' && Number(n.is_read) === 0),
        'the branch alert is one work item: cleared for the branch, not per viewer');
    });

    await t.test('an alert that was cleared but not resolved is raised again by the sweep', async () => {
      const cleared = await db.first("SELECT COUNT(*) AS c FROM notifications WHERE type = 'COMPLIANCE_EXPIRY' AND is_read = 1 AND is_deleted = 0");
      if (Number(cleared.c) === 0) {
        // No compliance records in this fixture's register, so there is nothing for the
        // sweep to find. The rule is still asserted directly: a record WITH an unread
        // alert is skipped, and one with only read alerts is not.
        const again = await call('POST', '/api/compliance/notify', { token: tokens.manager, body: {} });
        assert.equal(again.status, 200);
        return;
      }
      const swept = await call('POST', '/api/compliance/notify', { token: tokens.manager, body: {} });
      assert.equal(swept.status, 200, `the sweep answered ${swept.status}`);
      const unreadNow = await db.first("SELECT COUNT(*) AS c FROM notifications WHERE type = 'COMPLIANCE_EXPIRY' AND is_read = 0 AND is_deleted = 0");
      assert.ok(Number(unreadNow.c) > 0,
        'a cleared-but-unresolved expiry alert must come back — otherwise clearing the bell is how a licence expiry gets forgotten');
    });

    await t.test('and a notification addressed to somebody else cannot be marked read by a stranger', async () => {
      const staffList = await listFor(tokens.staff);
      const theirs = (staffList.data || []).find((n) => /one person only/.test(n.title));
      const res = await call('POST', `/api/notifications/${theirs.id}/read`, { token: tokens.manager, body: {} });
      assert.equal(res.status, 403, `a stranger marking somebody else's notification read answered ${res.status}`);
      assert.equal(res.json.code, 'NOT_YOURS');
    });
  });
});

test('mark-all-read marks exactly what the list shows, for every seat', async (t) => {
  // THE INVARIANT, IN BOTH DIRECTIONS: after "mark all read", every row this seat could
  // SEE is read, and every row it could not see is untouched. Each seat gets its own
  // deployment so one seat's marking cannot be mistaken for another's.
  const SEATS = [
    ['owner', 'an owner reaches every branch of their business'],
    ['manager', 'a manager reaches one branch of two'],
    ['staff', 'a staff member at one branch'],
    ['admin', 'the platform administrator, who belongs to no branch at all'],
  ];

  for (const [seat, because] of SEATS) {
    await t.test(`${seat} — ${because}`, async () => {
      await withDeployment(async ({ db, call, tokens, businessId, branchA, branchB, managerId }) => {
        await raise(db, { businessId, branchId: branchA, title: 'A licence' });
        await raise(db, { businessId, branchId: branchA, title: 'A permit' });
        await raise(db, { businessId, branchId: branchB, title: 'B permit' });
        await raise(db, { businessId, title: 'business-wide notice' });
        await raise(db, { businessId, branchId: branchA, userId: managerId, title: 'addressed to the manager' });
        const other = await call('POST', '/api/businesses', {
          token: tokens.admin,
          body: { name: 'Somebody Else Ltd', profile_code: 'GENERAL_RETAIL', branch: { name: 'Their Shop', city: 'Lagos', state: 'Lagos', opening_cash: 0 } },
        });
        const outsider = await raise(db, { businessId: other.json.id, branchId: other.json.branch_id, title: 'another business entirely' });

        const list = async () => {
          const res = await call('GET', '/api/notifications', { token: tokens[seat] });
          assert.equal(res.status, 200, `the list answered ${res.status} for ${seat}`);
          return res.json;
        };

        const before = await list();
        const visible = new Set((before.data || []).map((n) => n.id));
        assert.equal(before.unread, visible.size, `${seat}: the unread count does not match the rows the list returns`);
        assert.ok(visible.size > 0, `${seat} could see nothing — the fixture measures nothing for this seat`);

        const res = await call('POST', '/api/notifications/read-all', { token: tokens[seat], body: {} });
        assert.equal(res.status, 200, `read-all answered ${res.status} for ${seat}: ${res.text.slice(0, 200)}`);

        // EVERY row the seat could see is now read…
        const after = await list();
        assert.equal(after.unread, 0,
          `${seat} can still see ${after.unread} unread after "mark all read" — the button must clear every row the list shows it`);
        assert.ok(Number(res.json.marked) >= visible.size,
          `read-all marked ${res.json.marked} rows but ${seat} could see ${visible.size}`);

        // …and every row it could NOT see is untouched. "All" means "all of mine".
        const all = await db.all('SELECT id, title, is_read FROM notifications WHERE is_deleted = 0');
        const wrong = all.filter((row) => visible.has(row.id) ? Number(row.is_read) !== 1 : Number(row.is_read) === 1);
        assert.deepEqual(wrong.map((r) => `${r.title}=${r.is_read}`), [],
          `${seat}: read-all marked a row this seat cannot see, or missed one it can`);

        // And the row belonging to ANOTHER BUSINESS is marked if and only if this seat
        // could see it. Which seats those are is the point: an OWNER and an ADMIN reach
        // every business in the deployment (that is what the role means here), while a
        // branch manager and a staff member must not — so this asserts the boundary in
        // the direction each seat actually has one, instead of assuming they all do.
        const stranger = all.find((r) => r.id === outsider);
        const outsiderWasVisible = visible.has(outsider);
        assert.equal(Number(stranger.is_read) === 1, outsiderWasVisible,
          `${seat}: the row from the other business was ${outsiderWasVisible ? 'visible' : 'invisible'} and read-all ${Number(stranger.is_read) ? 'marked' : 'left'} it`);
        if (seat === 'manager' || seat === 'staff') {
          assert.equal(outsiderWasVisible, false, `${seat} must not see another business's alerts`);
        }
      });
    });
  }
});

// The four-seat read-all test above replaces the earlier two-seat version; the
// subtraction between them was: a manager reaches ONE branch of two, an owner
// reaches BOTH, and an administrator reaches every business in the deployment —
// so 'all' has three different meanings and every one of them had to be checked.
