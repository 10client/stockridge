'use strict';
// =====================================================================
// test/audit/audit.transfers.js — A MOVE, FROM BOTH ENDS
// =====================================================================
// The integration test proves the rules against its own database. This one proves them
// against a DEPLOYMENT, and it is pointed at the thing that actually goes wrong in a
// shop: somebody believes a member of staff has been moved, and they have not.
//
// FRONT TO BACK: an owner asks for a cashier to move; the deployment answers that the
// move is a QUESTION; the cashier signs in and can still see only the shop they came
// from; the branch receiving them is the one shown the decision; and when they agree
// the cashier's own next sign-in lands in the new branch.
//
// BACK TO FRONT: the history has a row for the creation and a row for the move, the
// coverage question answers for a PAST date using those rows rather than today's rota,
// and a refusal leaves the assignment exactly as it was with the reason kept.
//
// ITS OWN FIXTURE IS RETIRED: the seats it creates go through `d.seat()`, which the
// harness removes at the end, and the transfers it leaves behind are cancelled or
// resolved — a live deployment must not be left holding somebody else's question.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

// THE SEAT'S OWN USERNAME, READ FROM THE SEAT, NOT FROM THE FIXTURE.
//
// On a live deployment the harness SUFFIXES every username it creates so two audits
// cannot collide on a shared tenant (`trf-cashier` becomes `trf-cashier-gad02zc`). A
// constant here signed in as the name the fixture asked for and got 401 BAD_CREDENTIALS
// against staging — a failure that looks like a broken transfer and is a broken
// assumption in the test. The PIN is safe as a constant because it is passed through
// unchanged. What IS worth stating: the profile row's `full_name` is NOT on the actor,
// which is why nothing here asserts against a name.

runAudit('transfers', async (audit, d) => {
  const owner = d.owner || d.admin;
  const manager = (d.seats && d.seats.manager) || null;
  const mover = (d.seats && d.seats.mover) || null;
  if (!manager || !mover) {
    throw new Error('the transfers fixture needs a manager seat and a cashier to move — a skipped permission check reads exactly like a passing one');
  }

  const branches = d.branches || [];
  assert.ok(branches.length >= 2, `this audit needs a second branch to move somebody to and the deployment offers ${branches.length} — see ctx.otherBranchFor()`);
  const home = branches[0];
  const destination = branches[1];
  audit.note(`moving ${mover.username} from ${home.name} to ${destination.name}, and asking ${destination.name} to agree`);

  const branchOf = async (actor) => {
    const me = await d.request('GET', '/api/auth/me', { token: actor.token });
    assert.equal(me.status, 200, `auth/me answered ${me.status}`);
    const b = me.json && me.json.user && me.json.user.branch;
    return b ? String(b.id) : null;
  };
  const historyOf = async (id) => {
    const res = await owner.get(`/api/users/${encodeURIComponent(id)}/assignment-history`);
    assert.equal(res.status, 200, `the history answered ${res.status} ${String(res.text).slice(0, 200)}`);
    return res.json;
  };

  // ===================================================================
  audit.section('Somebody new already has a history, because their creation wrote one');
  // ===================================================================
  await audit.checkAsync('a cashier created through the app has an assignment from the day they were created', async () => {
    const res = await historyOf(mover.userId);
    assert.ok(res.data && res.data.length >= 1,
      `${mover.username} has ${(res.data || []).length} assignment rows. A history that starts at somebody's first transfer cannot answer "who could see this till in March?" for the majority of staff, who never transfer at all`);
    const first = res.data[res.data.length - 1];
    assert.equal(String(first.to_branch_id), String(home.id), 'the first assignment row does not name the branch they were created at');
    assert.ok(first.changed_by_name || first.changed_by, 'the creation row does not say who created them');
  });

  // ===================================================================
  audit.section('Asking does not move anybody — that is the whole point');
  // ===================================================================
  const asked = await audit.captureAsync('the owner asks for the move', async () => {
    const res = await owner.post(`/api/users/${encodeURIComponent(mover.userId)}/transfer`, {
      to_branch_id: destination.id,
      reason: 'Audit run — testing that a move is a question before it is a fact.',
    });
    assert.equal(res.status, 201, `asking for a transfer answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.ok(res.json.transfer && res.json.transfer.id, 'the answer carries no transfer row');
    return res.json;
  });
  audit.note(`transfer ${asked.transfer.id} is pending; ${mover.username} is still at ${home.name}`);

  await audit.checkAsync('the person asked about keeps working exactly where they are', async () => {
    const still = await branchOf(mover);
    assert.equal(still, String(home.id),
      `${mover.username} was asked about and moved already. A pending question that changes what somebody can see is not a question, and the branch that receives them has been told nothing`);
    const mine = await d.request('GET', '/api/users/transfers/pending/mine', { token: mover.token });
    assert.equal(mine.status, 200, `the person being moved cannot read their own pending list: ${mine.status}`);
    assert.ok((mine.json.data || []).some((t) => String(t.id) === String(asked.transfer.id)),
      'the cashier who is being moved cannot see that the move is still a question');
  });

  await audit.checkAsync('a second question about the same person is refused while the first is open', async () => {
    // THE SAME QUESTION AGAIN, not a different one: asking to move them to the branch
    // they are already at is refused as ALREADY_THERE, which is a different refusal and
    // would prove nothing about two open questions.
    const res = await owner.post(`/api/users/${encodeURIComponent(mover.userId)}/transfer`, { to_branch_id: destination.id });
    assert.equal(res.status, 409, `a second open transfer was accepted: ${res.status} ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'TRANSFER_ALREADY_PENDING');
  });

  // ===================================================================
  audit.section('The branch receiving somebody is the one that decides');
  // ===================================================================
  await audit.checkAsync('the manager at the branch they would be leaving cannot answer it', async () => {
    const res = await manager.post(`/api/users/transfers/${encodeURIComponent(asked.transfer.id)}/accept`, {});
    // The manager seat is pinned to the first branch — the one LOSING the cashier.
    if (String((d.seats.manager.pinnedBranchId) || '') === String(destination.id)) {
      audit.skip('the sending branch cannot answer a transfer', 'this deployment pinned the manager to the receiving branch');
      return;
    }
    assert.equal(res.status, 403, `${manager.username} accepted a transfer into a branch they do not manage: ${res.status} ${String(res.text).slice(0, 200)}`);
  });

  await audit.checkAsync('the cashier cannot accept their own transfer', async () => {
    const res = await d.request('POST', `/api/users/transfers/${encodeURIComponent(asked.transfer.id)}/accept`, { token: mover.token });
    assert.equal(res.status, 403, `a cashier accepted their own move: ${res.status}`);
    assert.equal(res.json.code, 'SELF_DECISION');
    assert.equal(await branchOf(mover), String(home.id), 'somebody moved the cashier while deciding whether they could');
  });

  // ===================================================================
  audit.section('Accepted — and the scope really moves');
  // ===================================================================
  await audit.checkAsync('the owner answers, the cashier moves, and their next sign-in lands there', async () => {
    const res = await owner.post(`/api/users/transfers/${encodeURIComponent(asked.transfer.id)}/accept`, {});
    assert.equal(res.status, 200, `accepting answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.equal(res.json.status, 'ACCEPTED');
    assert.equal(await branchOf(mover), String(destination.id),
      `the transfer was accepted and ${mover.username} still resolves to their old branch — an accepted move that does not move the scope is an owner who believes the cashier is somewhere they are not`);

    // A FRESH SIGN-IN, because that is what the person actually does next.
    const back = await d.login({ username: mover.username, pin: mover.pin });
    assert.ok(back, `the moved cashier cannot sign in at all after the move`);
    const list = await d.request('GET', '/api/branches?limit=100', { token: back.token });
    const rows = ((list.json && (list.json.data || list.json.branches)) || []);
    assert.equal(rows.length, 1, `the moved cashier sees ${rows.length} branch(es); a cashier is scoped to exactly one`);
    assert.equal(String(rows[0].id), String(destination.id), `the cashier signs in and still sees ${rows[0].name}`);
    mover.token = back.token;
  });

  await audit.checkAsync('the history kept both ends of the move and who decided it', async () => {
    const res = await historyOf(mover.userId);
    const row = (res.data || [])[0];
    assert.equal(String(row.from_branch_id), String(home.id), 'the newest history row does not say where they came from');
    assert.equal(String(row.to_branch_id), String(destination.id), 'the newest history row does not say where they went');
    assert.ok(row.changed_by_name || row.changed_by_username || row.changed_by, 'the history does not record who decided the move');
    assert.ok(res.pending === null, 'the history still reports a pending transfer after one was accepted');
  });

  // ===================================================================
  audit.section('A past date answers with the past, not with today');
  // ===================================================================
  await audit.checkAsync('who could see each branch on a date before the move', async () => {
    const past = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const then = await owner.get(`/api/assignment-history?branch_id=${encodeURIComponent(destination.id)}&at=${past}`);
    assert.equal(then.status, 200, `the coverage answer failed: ${then.status} ${String(then.text).slice(0, 200)}`);
    const thenNames = (then.json.data || []).map((r) => r.username);
    assert.ok(!thenNames.includes(mover.username),
      `${mover.username} moved to ${destination.name} today and is listed as having been there on ${past}. "Who could see the till on that day" read from today's rota is the answer that gets an innocent person questioned`);

    const now = await owner.get(`/api/assignment-history?branch_id=${encodeURIComponent(destination.id)}&at=${new Date().toISOString().slice(0, 10)}`);
    const nowNames = (now.json.data || []).map((r) => r.username);
    assert.ok(nowNames.includes(mover.username), `${mover.username} works at ${destination.name} today and is missing from today's coverage`);
  });

  await audit.checkAsync('a date that is not a date is refused with a sentence a person can act on', async () => {
    const res = await owner.get(`/api/assignment-history?branch_id=${encodeURIComponent(destination.id)}&at=last%20Tuesday`);
    assert.equal(res.status, 400, `"last Tuesday" was accepted as a date: ${res.status}`);
    assert.equal(res.json.code, 'INVALID_DATE');
    assert.ok(/YYYY-MM-DD/.test(res.json.error), `the refusal does not say what format to use: ${res.json.error}`);
  });

  // ===================================================================
  audit.section('Refused — nobody moves, and the refusal is kept');
  // ===================================================================
  await audit.checkAsync('send them back, refuse it, and check they did not move', async () => {
    const back = await owner.post(`/api/users/${encodeURIComponent(mover.userId)}/transfer`, { to_branch_id: home.id, reason: 'Audit run — this one will be refused.' });
    assert.equal(back.status, 201, `asking again answered ${back.status}: ${String(back.text).slice(0, 200)}`);
    const id = back.json.transfer.id;

    const refused = await owner.post(`/api/users/transfers/${encodeURIComponent(id)}/reject`, { reason: 'Audit run: no counter free for another cashier this quarter.' });
    assert.equal(refused.status, 200, `refusing answered ${refused.status}: ${String(refused.text).slice(0, 200)}`);
    assert.equal(refused.json.status, 'REJECTED');
    assert.equal(await branchOf(mover), String(destination.id), 'a refused transfer moved the person anyway');

    const mine = await d.request('GET', '/api/users/transfers/pending/mine', { token: mover.token });
    assert.ok(!(mine.json.data || []).some((t) => String(t.id) === String(id)),
      'a refused transfer is still listed as pending for the person it concerned');

    // AND NOTHING IS LEFT OPEN ON THE DEPLOYMENT when this audit walks away.
    const pending = await owner.get('/api/users/transfers/pending?limit=100');
    const stillOpen = (pending.json.data || []).filter((t) => String(t.user_id) === String(mover.userId));
    assert.equal(stillOpen.length, 0, `this audit left ${stillOpen.length} question(s) open on the deployment`);
  });
}, {
  // A MANAGER AT THE FIRST BRANCH AND A CASHIER TO MOVE. The manager is the SENDING
  // branch on purpose: the check that matters is that the branch losing somebody does
  // not get to decide it. The second branch's decision is taken by the owner, who may
  // answer for any of their branches.
  setup: () => startDeployment({
    label: 'transfers',
    businesses: [{
      name: 'Transfer Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: false,
      branches: [
        { name: 'Transfer Wuse Shop', code: 'TRF-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 30000 },
        { name: 'Transfer Minna Shop', code: 'TRF-2', city: 'Minna', state: 'Niger', branch_type: 'RETAIL', opening_cash: 10000 },
      ],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'trf-manager', pin: '41072', branchIndex: 0, full_name: 'Transfer Audit Manager' },
      { as: 'mover', role: 'STAFF', username: 'trf-cashier', pin: '58319', branchIndex: 0, full_name: 'Transfer Audit Cashier' },
    ],
  }),
});
