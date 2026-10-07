'use strict';
// =====================================================================
// test/audit/audit.notifications.js — THE BELL, AUDITED IN BOTH DIRECTIONS
// =====================================================================
// The notification engine has one producer — the compliance sweep — and its alerts are
// the difference between a licence renewed and a shop closed for trading without one.
// For most of this product's life the table had a writer and no reader, and the two
// routes that would have shown nothing were exercised by nothing.
//
//   FRONT TO BACK  a licence is recorded for a branch with an expiry inside the alert
//                  window → the sweep turns it into an alert → the list holds it → the
//                  unread count agrees → marking it read moves the count and nothing else.
//   BACK TO FRONT  the unread count is asked for on its own, then the rows; the two must
//                  describe the same set, which is the defect this run was written to
//                  catch (read-all scoped by the caller's own branch, so it cleared
//                  nothing for an owner and only one branch for a manager).
//   AND THE REFUSALS  a staff member raising alerts; a stranger marking somebody else's
//                  notification read; a notification that does not exist.
//   AND THE SCOPE  a manager at one branch does not see the other branch's alerts.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const stamp = () => Date.now().toString(36).slice(-5).toUpperCase();

runAudit('notifications', async (audit, d) => {
  const owner = d.owner || d.admin;
  const manager = d.seats && d.seats.manager;
  const staff = d.seats && d.seats.staff;
  if (!manager || !staff) throw new Error('the notifications fixture needs a MANAGER and a STAFF seat');
  const branch = (d.branches || [])[0];
  const annexe = (d.branches || [])[1] || null;
  assert.ok(branch, 'the notifications fixture has no branch');

  // Each run uses its OWN record type, so a deployment that already holds a premises
  // permit (the demo does) is not a duplicate and the fixture needs no cleanup of
  // somebody else's row.
  const type = `AUD_NOTIFY_${stamp()}`;

  const bell = async (who, query = '') => {
    const res = await who.get(`/api/notifications${query}`);
    assert.equal(res.status, 200, `the notification list answered ${res.status} ${String(res.text).slice(0, 200)}`);
    return res.json;
  };
  const unreadCount = async (who) => {
    const res = await who.get('/api/notifications?unread=1&limit=1');
    assert.equal(res.status, 200, `the unread count answered ${res.status}`);
    return Number(res.json.unread);
  };

  // ------------------------------------------------------------------
  // FRONT TO BACK — a licence becomes an alert
  // ------------------------------------------------------------------
  const raised = await audit.captureAsync('a licence is recorded for the branch, expiring inside the alert window', async () => {
    const res = await owner.post('/api/compliance/records', {
      branch_id: branch.id,
      record_type: type,
      record_number: `AUD-${type}-1`,
      issued_date: day(-400),
      expiry_date: day(9),
    });
    assert.ok(res.status < 400, `recording the licence answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    d.trackRestore(`licence ${type}`, async () => {
      const del = await owner.del(`/api/compliance/records/${encodeURIComponent(res.json.id)}`);
      return del.status < 300 || del.status === 404;
    });
    return res.json.id;
  });

  await audit.checkAsync('the sweep turns it into an alert, and only once', async () => {
    const first = await manager.post('/api/compliance/notify', {});
    assert.ok(first.status < 400, `the sweep answered ${first.status}: ${String(first.text).slice(0, 240)}`);
    assert.ok(Number(first.json.created) >= 1,
      `the sweep created ${first.json.created} alert(s) for a licence expiring in 9 days. An expiry nobody is told about is a diary entry`);
    const again = await manager.post('/api/compliance/notify', {});
    assert.equal(Number(again.json.created), 0,
      `a second sweep created ${again.json.created} more — an alert list that grows every morning is one nobody reads`);
  });

  await audit.checkAsync('the alert is in the list, with the branch and the type on it', async () => {
    const list = await bell(manager, '?limit=50');
    const rows = list.data || list.rows || [];
    const mine = rows.filter((n) => String(n.type) === 'COMPLIANCE_EXPIRY' && String(n.reference_id) === String(raised));
    assert.equal(mine.length, 1, `the sweep raised an alert for this licence and the list holds ${mine.length} of them (${rows.length} row(s) total)`);
    const alert = mine[0];
    assert.equal(String(alert.branch_id), String(branch.id), 'the alert must name the branch it is about');
    assert.equal(Number(alert.is_read), 0, 'a freshly raised alert is unread');
    assert.ok(alert.title && /day|expir/i.test(alert.title), `the title reads "${alert.title}" — it has to say what is expiring and when`);
    assert.ok(['WARNING', 'CRITICAL'].includes(String(alert.severity)), `severity is ${alert.severity}`);
  });

  await audit.checkAsync('the unread count and the unread rows describe the same set', async () => {
    // THE COUNT AND THE LIST MUST AGREE — a badge that says three over a panel showing two
    // is how a person learns to distrust the badge.
    const count = await unreadCount(manager);
    const unreadRows = await bell(manager, '?unread=1&limit=100');
    const rows = unreadRows.data || unreadRows.rows || [];
    assert.equal(rows.length, count,
      `the count says ${count} unread and the unread list returns ${rows.length} row(s). Both halves are built from the same scope, and this is the check that says so`);
    assert.equal(Number(unreadRows.unread), count, 'the list carries its own unread total and it disagrees with the count route');
  });

  await audit.checkAsync('marking one read moves the count by exactly one', async () => {
    const list = await bell(manager, '?unread=1&limit=50');
    const rows = list.data || list.rows || [];
    assert.ok(rows.length >= 1, 'there is nothing unread to mark — the earlier checks did not leave an alert behind');
    const before = await unreadCount(manager);
    const target = rows[0];
    const res = await manager.post(`/api/notifications/${encodeURIComponent(target.id)}/read`, {});
    assert.equal(res.status, 200, `marking one read answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const after = await unreadCount(manager);
    assert.equal(after, before - 1,
      `the count went ${before} → ${after} after marking one notification read. It has to move by exactly one, or the number is not a count`);
    const again = await manager.post(`/api/notifications/${encodeURIComponent(target.id)}/read`, {});
    assert.equal(again.status, 200, 'marking the same one read twice is not an error');
    assert.equal(await unreadCount(manager), after, 'and the second mark does not move the count again');
  });

  // ------------------------------------------------------------------
  // BACK TO FRONT — clearing the board
  // ------------------------------------------------------------------
  await audit.checkAsync('mark-all-read clears everything this seat can see, and says so', async () => {
    // This is the defect the audit exists for. The route used to scope its audience by
    // the caller's OWN `branch_id` — with `'__none__'` for a caller who has none, which
    // is every owner and administrator — so "mark all read" marked NOTHING for the two
    // seats most likely to press it, while the list beside it showed them plenty.
    const before = await unreadCount(manager);
    const res = await manager.post('/api/notifications/read-all', {});
    assert.equal(res.status, 200, `read-all answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    assert.equal(Number(res.json.unread), 0,
      `after "mark all read" the seat can still see ${res.json.unread} unread. A button that clears fewer rows than the list shows is the defect this check was written for`);
    assert.ok(Number(res.json.marked) >= before,
      `read-all reported ${res.json.marked} marked against ${before} unread — the two have to agree`);
    const after = await unreadCount(manager);
    assert.equal(after, 0, `the count still reads ${after}`);
    const rows = await bell(manager, '?unread=1&limit=50');
    assert.equal((rows.data || rows.rows || []).length, 0, 'the unread list is still returning rows after read-all');
  });

  await audit.checkAsync('the alert is not deleted — it is greyed', async () => {
    // Clearing a bell is not discharging an obligation, and the history has to remain
    // readable: the same alert must still be in the list, marked read.
    const list = await bell(manager, '?limit=100');
    const rows = list.data || list.rows || [];
    const mine = rows.filter((n) => String(n.reference_id) === String(raised) || String(n.type) === 'COMPLIANCE_EXPIRY');
    assert.ok(mine.length >= 1, 'the alerts vanished from the list — read is not deleted');
    assert.ok(mine.every((n) => Number(n.is_read) === 1), 'every one of them should be read now');
  });

  await audit.checkAsync('an alert cleared but NOT resolved comes back on the next sweep', async () => {
    // What makes a shared read flag safe. The sweep skips a record only while it has an
    // UNREAD alert, so clearing the bell without renewing the licence raises it again —
    // the obligation outlives the notification.
    const swept = await manager.post('/api/compliance/notify', {});
    assert.ok(swept.status < 400, `the sweep answered ${swept.status}`);
    assert.ok(Number(swept.json.created) >= 1,
      `the sweep created ${swept.json.created} alert(s) for a licence that is still expiring. Clearing a notification has to leave the obligation standing, or the bell becomes a way of forgetting things`);
    const unread = await unreadCount(manager);
    assert.ok(unread >= 1, `the count reads ${unread} after the re-raise`);
  });

  // ------------------------------------------------------------------
  // THE REFUSALS
  // ------------------------------------------------------------------
  await audit.checkAsync('a notification that does not exist is refused, not silently accepted', async () => {
    const res = await manager.post('/api/notifications/does-not-exist/read', {});
    assert.equal(res.status, 404, `marking a missing notification read answered ${res.status}`);
    assert.equal(res.json.code, 'NOTIFICATION_NOT_FOUND', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('a staff member cannot raise alerts', async () => {
    const res = await staff.post('/api/compliance/notify', {});
    assert.equal(res.status, 403, `a staff member running the compliance sweep answered ${res.status}`);
    assert.equal(res.json.code, 'ROLE_REQUIRED', `the refusal came back as ${res.json.code}`);
  });

  // ------------------------------------------------------------------
  // THE SCOPE
  // ------------------------------------------------------------------
  if (annexe) {
    await audit.checkAsync('one branch’s alerts are not another branch’s business', async () => {
      // A SECOND BRANCH, a licence on it, and a manager who is not there: the alert is
      // raised by the sweep and must not appear in the first manager's list.
      const secondType = `${type}_B`;
      const opened = await owner.post('/api/compliance/records', {
        branch_id: annexe.id, record_type: secondType, record_number: `AUD-${secondType}-1`,
        issued_date: day(-400), expiry_date: day(8),
      });
      assert.ok(opened.status < 400, `recording the annexe licence answered ${opened.status}: ${String(opened.text).slice(0, 220)}`);
      d.trackRestore(`licence ${secondType}`, async () => {
        const del = await owner.del(`/api/compliance/records/${encodeURIComponent(opened.json.id)}`);
        return del.status < 300 || del.status === 404;
      });

      const swept = await owner.post('/api/compliance/notify', {});
      assert.ok(swept.status < 400, `the sweep answered ${swept.status}`);
      await manager.post('/api/notifications/read-all', {});

      const list = await bell(manager, '?limit=100');
      const rows = list.data || list.rows || [];
      const theirs = rows.filter((n) => String(n.branch_id) === String(annexe.id));
      assert.deepEqual(theirs.map((n) => n.title), [],
        `a manager at ${branch.name} can read an alert about ${annexe.name}: ${theirs.map((n) => n.title).join('; ')}. Branch alerts belong to the branch`);

      // And an owner, who reaches both, does see it — otherwise "the sweep raised it" is
      // a claim about a row nobody can reach.
      const ownerList = await bell(owner, '?limit=100');
      const ownerRows = ownerList.data || ownerList.rows || [];
      assert.ok(ownerRows.some((n) => String(n.branch_id) === String(annexe.id)),
        'the owner reaches every branch of the business and must see the annexe alert the manager cannot');
    });
  }

  await audit.checkAsync('the board is left clear for the next run', async () => {
    const res = await owner.post('/api/notifications/read-all', {});
    assert.equal(res.status, 200, `read-all answered ${res.status}`);
    assert.equal(Number(res.json.unread), 0, `the owner still sees ${res.json.unread} unread`);
  });
}, {
  setup: () => startDeployment({
    label: 'notifications',
    businesses: [{
      name: 'Notify Audit Stores', profileCode: 'GENERAL_RETAIL', vatRegistered: true,
      branches: [
        { name: 'Notify Audit Branch', code: 'NTF-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000 },
        { name: 'Notify Audit Annexe', code: 'NTF-2', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 10000 },
      ],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'ntf-manager', pin: '60911', branchIndex: 0, full_name: 'Notify Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'ntf-staff', pin: '60912', branchIndex: 0, full_name: 'Notify Audit Counter' },
    ],
  }),
});
