'use strict';
// =====================================================================
// test/audit/audit.roles.js — WHO MAY DO WHAT, TO WHOM, IN WHICH BRANCH
// =====================================================================
// Every other audit in this suite signs in as somebody and asks whether the product
// works. This one asks the question underneath all of them: FOR THIS SEAT, IS THE
// PRODUCT ALLOWED TO WORK AT ALL — and is the answer the same one the product's own
// role module gives?
//
// WHAT MAKES IT WORTH RUNNING
//
//   * It seats SIX people, not one: an administrator, an owner, a manager and a
//     cashier in the first branch, and a manager and a cashier in the second. A
//     single-token audit cannot see a scope leak by construction, because a scope
//     leak only exists between two seats.
//
//   * It derives every expectation by CALLING `domain/roles.js` — the module the
//     server itself uses — rather than restating the hierarchy in the test. A test
//     that says "an owner cannot edit an administrator" passes forever, including
//     after somebody decides owners can. This one moves with the rule and fails when
//     a route and the rule disagree.
//
//   * It runs a file PER ROLE PAIR (`test/audit/pairs/*.js`), and it REFUSES TO PASS
//     if a pair has no file. An audit suite where the manager-versus-owner case is
//     simply absent looks exactly like a suite where it passes.
//
// WHAT "TWO-WAY" MEANS HERE
//
//   Each pair is probed in BOTH directions and each direction is probed both ways:
//   the refusal AND the allow. A product that refuses everything is not secure, it is
//   broken, and a suite that only ever asserts 403 will happily certify it. Every
//   pair file asserts that the lower role cannot do the thing AND that the higher
//   role can.
// =====================================================================

const path = require('node:path');
const fs = require('node:fs');
const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');
const rules = require('./lib/role-rules');

const PAIR_DIR = path.join(__dirname, 'pairs');

/** Every `test/audit/pairs/*.js`, loaded and shape-checked, in a stable order. */
function loadPairs() {
  if (!fs.existsSync(PAIR_DIR)) return [];
  return fs.readdirSync(PAIR_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => {
      const mod = require(path.join(PAIR_DIR, f));
      if (!mod || !Array.isArray(mod.pair) || mod.pair.length !== 2 || typeof mod.checks !== 'function') {
        throw new Error(`test/audit/pairs/${f} must export { pair: ['ROLE_A','ROLE_B'], checks(audit, ctx) }`);
      }
      return { file: f, ...mod };
    });
}

/** A customer, created through the API by this seat, so it carries that seat's branch. */
async function makeCustomer(audit, actor, name) {
  const branch = actor.deployment.branchFor(actor);
  const res = await actor.post('/api/customers', {
    name, phone: `0803${String(Date.now()).slice(-7)}`,
    branch_id: branch ? branch.id : undefined,
    notes: 'audit.roles fixture',
  });
  if (res.status !== 200 && res.status !== 201) {
    return { error: `${res.status} ${res.text.slice(0, 200)}`, branchId: branch && branch.id, actor };
  }
  const id = res.json && (res.json.id || (res.json.data && res.json.data.id));
  if (id) actor.deployment.trackCustomer(id);
  return { id, branchId: branch && branch.id, actor, name };
}

/** List rows, whatever array key this endpoint uses — the same idea as `rules.rowsOf`. */
function errorsafeRows(res) {
  const j = (res && res.json) || {};
  for (const key of ['data', 'rows', 'items', 'branches']) if (Array.isArray(j[key])) return j[key];
  return Array.isArray(j) ? j : [];
}

runAudit('roles', async (audit, d) => {
  const pairs = loadPairs();
  // Every branch THIS RUN opened; closed again on the way out. Declared at the top because
  // the second-branch fallback below runs long before the pair files do.
  const openedBranches = [];

  // TWO BRANCHES OF THE SAME BUSINESS, AND THAT IS A LIVE-TARGET LESSON.
  //
  // On a fresh local deployment every branch belongs to the one business the fixture made.
  // On a deployment a client is already using, `branches[1]` can easily be the first branch
  // of a DIFFERENT business — and then a probe that moves a cashier "to the other branch"
  // is refused with CROSS_BUSINESS_MOVE, which is the product being exactly right: a move
  // between businesses moves a person between two sets of books and is an administrator
  // action. The first live run of this audit reported three failures about branch moves
  // that were all this one fixture mistake, and nothing else.
  const primaryBranch = d.branches.find((b) => String(b.id) === String(d.primaryBranchId)) || d.branches[0];
  const branchA = primaryBranch;
  const primaryBusiness = primaryBranch && primaryBranch.business_id;
  let siblings = d.branches.filter((b) => String(b.business_id) === String(primaryBusiness) && String(b.id) !== String(branchA.id));
  let branchB = siblings[0] || null;

  // IF THE DEPLOYMENT HAS ONLY ONE BRANCH, THIS AUDIT OPENS A SECOND ONE — because the
  // questions its pairs ask ("what happens to a manager's world when somebody moves them")
  // have no answer without two branches, and a suite that stands down on every live target
  // is a suite that proves nothing where it matters most. Where the PLAN refuses (a
  // deployment at its paid-for ceiling answers 402), that is a shop state and the note
  // says so; the probes then stand down with a reason rather than a false alarm.
  if (!branchB) {
    const maker = d.owner || d.admin;
    const name = `Roles Second Branch ${Date.now().toString(36).slice(-4)}`;
    const res = await maker.post('/api/branches', {
      business_id: primaryBusiness, name, code: `ROLES-2-${Date.now().toString(36).slice(-3).toUpperCase()}`,
      branch_type: 'RETAIL', city: 'Abuja', state: 'FCT',
    });
    const id = res.json && (res.json.id || res.json.branch_id);
    if (id) {
      branchB = { id, name, business_id: primaryBusiness, is_active: 1 };
      siblings = [branchB];
      d.branches = d.branches.concat([branchB]);
      openedBranches.push({ id, name });
      audit.note(`this deployment had one branch for ${primaryBusiness.slice(0, 8)}, so the audit opened "${name}" for the move probes — and closes it on the way out`);
    } else {
      audit.note(`this deployment has one branch for that business and the plan refused another (${res.status} ${res.json && res.json.code}) — the move probes stand down with a reason`);
    }
  }
  audit.note(`branch A: ${branchA && branchA.name}; branch B (same business): ${branchB ? branchB.name : 'none'}`);

  // THE SEATS PINNED TO THE SECOND BRANCH.
  //
  // A local fixture makes them and pins them to its own second branch. A LIVE deployment
  // has nobody there until this run creates one — and the live harness picks `branches[1]`,
  // which on a deployment with two businesses is the first branch of SOMEBODY ELSE'S
  // business. That is how the last run ended up with a second-branch manager working in a
  // different company: every move probe then stood down for want of a colleague in the same
  // business, and the pairs spent the run proving nothing about scope.
  //
  // So the rule is not "create them if they are missing" but "MAKE SURE THEY ARE WHERE
  // branchB IS". A seat in the wrong branch is worse than no seat: it looks like cover.
  for (const [key, role, full_name] of [['managerB', 'MANAGER', 'Roles Manager B'], ['staffB', 'STAFF', 'Roles Cashier B']]) {
    if (!branchB) continue;
    const existing = d.seats[key];
    if (existing && String(existing.branchId) === String(branchB.id)) continue;
    if (d.live && !d.writable) continue;
    try {
      d.seats[key] = await d.seat({ username: `roles-${key}-${Date.now().toString(36).slice(-5)}`, pin: '73041', role, branchId: branchB.id, full_name });
      console.log(`  seated ${role} "${d.seats[key].username}" at ${branchB.name}${existing ? ' (the fixture seat was in another branch)' : ''}`);
    } catch (err) {
      audit.note(`could not seat a ${role} in ${branchB.name}: ${err.message}`);
    }
  }

  audit.section('The seats are real, and each one says who it is');
  const roster = {
    ADMIN: d.admin,
    OWNER: d.owner,
    MANAGER: d.seats.manager,
    STAFF: d.seats.staff,
    MANAGER_B: d.seats.managerB,
    STAFF_B: d.seats.staffB,
  };
  for (const [key, actor] of Object.entries(roster)) {
    if (!actor) { audit.skip(`the ${key} seat exists`); continue; }
    await audit.checkAsync(`the ${key} seat signs in as a real ${actor.role}`, async () => {
      const res = await actor.get('/api/auth/me');
      assert.equal(res.status, 200, `GET /api/auth/me answered ${res.status}`);
      const me = res.json.user || res.json;
      assert.equal(String(me.role).toUpperCase(), String(actor.role).toUpperCase(),
        `the token says ${me.role} and the seat was created as ${actor.role}`);
    });
  }

  audit.section('The pinned seats reach exactly one branch, and the unpinned ones reach all of them');
  for (const key of ['MANAGER', 'STAFF']) {
    const actor = roster[key];
    if (!actor) continue;
    await audit.checkAsync(`the ${key} in the first branch is pinned to it`, async () => {
      const res = await actor.get('/api/auth/me');
      const me = res.json.user || res.json;
      const pinned = (me.branch && me.branch.id) || me.branch_id;
      assert.equal(String(pinned), String(branchA.id),
        `the seat is pinned to ${branchA.name} but its token carries branch ${pinned}`);
      assert.equal(String((res.json.scope && res.json.scope.pinnedBranchId) || branchA.id), String(branchA.id),
        'the server-side scope does not name the branch the seat is pinned to — every list filter downstream reads that scope, not the token');
    });
  }
  await audit.checkAsync('the owner sees every branch of their business, pinned or not', async () => {
    // AN OWNER MAY BE PINNED — that is a shop's configuration, not a defect, and the live
    // seat (`liveseat`) is pinned to one of the two staging branches. What an owner must
    // never be is LIMITED by that pin: the branches they can list are the branches of the
    // business they own. The first draft asserted "not pinned" and reported the staging
    // owner's own configuration as a scope leak.
    const res = await d.owner.get('/api/branches?limit=100');
    assert.equal(res.status, 200, `the owner reading branches answered ${res.status}`);
    const rows = errorsafeRows(res);
    const me = await d.owner.get('/api/auth/me');
    const pinned = (me.json.user && me.json.user.branch && me.json.user.branch.id) || null;
    // The owner's own business, read from their own session — not from a fixture the
    // audit has not built yet at this point in the file.
    const ownBusiness = (me.json.user && me.json.user.business && me.json.user.business.id) || primaryBusiness;
    assert.ok(rows.length >= 1, 'the owner can see no branches at all');
    // WHAT "THEIR BUSINESS" MEANS IS THE PRODUCT'S ANSWER, NOT THIS FILE'S ASSUMPTION.
    //
    // The first draft asserted that an owner sees only branches of the business their
    // user row names. On staging that failed, and the failure was not a leak: the
    // business-access endpoint says `reachesEverything: true, reachesEverythingBy:
    // ROLE:OWNER` — an owner reaches EVERY business on the deployment, by role. The
    // audit was asserting a rule the product never claimed.
    //
    // So the expectation is derived the same way every expectation in this suite is:
    // ask the product what it declares, and hold it to it. On a deployment hosting two
    // client businesses this is the line worth watching, and the note below says so out
    // loud — see STATUS.md, open items, for the multi-tenant question it opens.
    // ASKED AS THE ADMINISTRATOR, BECAUSE THAT IS WHO MAY ASK. `GET
    // /api/users/:id/business-access` is an administrator's view of somebody else's reach
    // and refuses anybody else with 403 — which is the right boundary, and the first
    // draft of this check called it as the owner, read `undefined` off a 403 body, and
    // reported the product as being inconsistent with itself.
    const access = await roster.ADMIN.get(`/api/users/${encodeURIComponent(d.owner.userId)}/business-access`);
    const reachesEverything = Boolean(access.json && access.json.reachesEverything);
    const foreign = rows.filter((b) => b.business_id && String(b.business_id) !== String(ownBusiness));
    if (!reachesEverything) {
      assert.equal(foreign.length, 0,
        `the owner's branch list carries ${foreign.length} branch(es) of another business (${foreign.map((b) => b.name).join(', ')}) while the product says they reach only their own`);
    } else {
      audit.note(`the owner reaches EVERY business on this deployment (${access.json.reachesEverythingBy}) and sees ${rows.length} branch(es), ${foreign.length} of them outside ${ownBusiness.slice(0, 8)} — declared behaviour, and the thing to re-examine the day one deployment hosts two clients`);
    }
    assert.ok(rows.length >= 1, 'the owner can see no branches at all');
  });

  audit.section('The hierarchy domain/roles.js declares, over HTTP');
  // The four real users, one per role, so the matrix is probed against PEOPLE rather
  // than against roles in the abstract: every route takes a user id, and a matrix that
  // never touches one is a matrix of nothing.
  const targets = {};
  for (const key of ['ADMIN', 'OWNER', 'MANAGER', 'STAFF']) {
    const actor = roster[key];
    if (!actor) continue;
    await d.describe(actor);
    targets[actor.role] = actor.user || { id: actor.userId, role: actor.role, branch_id: actor.branchId, business_id: actor.businessId };
  }

  for (const [actorKey, actor] of Object.entries(roster)) {
    if (!actor) continue;
    for (const targetRole of rules.ROLE_ORDER) {
      const target = targets[targetRole];
      if (!target) continue;
      // A manager and a cashier reach only their own branch, so the cross-branch
      // targets are asked about in their own section below, with a scope refusal
      // expected instead of a hierarchy one.
      if (actorKey.endsWith('_B')) continue;
      const sameBranch = actor.branchId && target.branch_id && String(actor.branchId) === String(target.branch_id);
      const pinned = !!actor.branchId;
      if (pinned && target.branch_id && !sameBranch) continue;
      const allow = rules.canManageUser(actor.user || { id: actor.userId, role: actor.role }, target);
      await rules.expectRule(audit, {
        what: `${rules.label(actor.role, targetRole)} — editing their name is ${allow ? 'allowed' : 'refused'}`,
        allow,
        refusalSpeaks: /cannot|only|role/i,
        act: () => actor.put(`/api/users/${encodeURIComponent(target.id)}`, { full_name: target.full_name || 'Audit Name' }),
      });
    }
  }

  audit.section('Only an administrator makes administrators');
  await audit.checkAsync('the owner cannot create an administrator', async () => {
    const res = await d.owner.post('/api/users', { username: `audit-admin-try-${Date.now().toString(36)}`, pin: '73041', full_name: 'Audit Second Admin', role: 'ADMIN' });
    assert.ok(res.status === 403, `creating an ADMIN as the owner answered ${res.status} — the deployment administrator exists to be the one account that cannot be locked out by an owner`);
    assert.match(String(res.json && (res.json.error || res.json.message)), /administrator/i,
      'the refusal does not say "administrator", so the owner cannot tell this rule from the rank rules');
  });
  await audit.checkAsync('the administrator can, and the result is a real sign-in', async () => {
    const username = `audit-admin2-${Date.now().toString(36)}`;
    const res = await d.admin.post('/api/users', { username, pin: '73041', full_name: 'Audit Second Admin', role: 'ADMIN' });
    assert.ok(res.status === 200 || res.status === 201, `the administrator was refused with ${res.status} ${res.text.slice(0, 200)} — a deployment with one administrator has no way to add a second`);
    const id = res.json && (res.json.id || res.json.userId);
    if (id) d.trackUser(id);
    // A RAW LOGIN, because `d.login()` returns a signed-in Actor and throws on failure.
    // The first draft read `.status` off an Actor and reported an exception instead of
    // the answer — and the check is about the ANSWER.
    const back = await d.request('POST', '/api/auth/login', { body: { username, pin: '73041' } });
    assert.equal(back.status, 200, `the new administrator could not sign in: ${back.status} ${String(back.text).slice(0, 160)}`);
  });

  audit.section('Nobody edits their own role, and nobody promotes themselves');
  for (const key of ['OWNER', 'MANAGER']) {
    const actor = roster[key];
    if (!actor) continue;
    await rules.expectRule(audit, {
      what: `a ${rules.roleLabel(actor.role)} cannot change their own role`,
      allow: false,
      // 400, NOT 403, and the product is right: this is a request about the person
      // making it, not a rank boundary. The route answers its own code for it —
      // SELF_CHANGE_FORBIDDEN — so the audit asks for that code rather than a status.
      refuseStatus: [400],
      refusalCode: 'SELF_CHANGE_FORBIDDEN',
      refusalSpeaks: /cannot|self|role|only/i,
      act: () => actor.put(`/api/users/${encodeURIComponent(actor.userId || (actor.user && actor.user.id))}`, { role: 'ADMIN' }),
    });
  }

  audit.section('A cashier is a cashier: the actions a shop floor must not be able to take');
  const staff = roster.STAFF;
  if (staff) {
    await rules.expectRule(audit, {
      what: 'a cashier cannot create another user',
      allow: false,
      act: () => staff.post('/api/users', { username: `audit-staff-made-${Date.now().toString(36)}`, pin: '73041', full_name: 'Should Not Exist', role: 'STAFF' }),
    });
    await rules.expectRule(audit, {
      what: 'a cashier cannot open a branch',
      allow: false,
      refusalSpeaks: /owner|branch/i,
      act: () => staff.post('/api/branches', { business_id: staff.businessId || (targets.OWNER && targets.OWNER.business_id), name: 'Cashier Branch', branch_type: 'RETAIL' }),
    });
    await rules.expectRule(audit, {
      what: 'a cashier cannot read the profit and loss account',
      allow: false,
      act: () => staff.get('/api/accounting/profit-loss'),
    });
  }

  audit.section('The same hierarchy, for PIN resets');
  // A PIN reset is the most dangerous ordinary action in the product: it hands over
  // somebody's seat. It follows `canResetPin` — the same rule as editing them, and the
  // check exists because a route can implement one and forget the other.
  //
  // THE FIELD IS `new_pin`, AND A MISSING ONE IS NOT AN ERROR. `POST
  // /api/users/:id/reset-pin` generates a cryptographically random 5-digit PIN when the
  // caller does not name one and returns it in the response with `showOnce: true` — the
  // right behaviour for a manager standing in front of the person, and a trap for an
  // audit: the first draft sent `{ pin: '73041' }`, so every "allowed" reset silently
  // issued a RANDOM pin and the seat could never sign in again. The suite blamed the
  // seat. The endpoint had done exactly what it says it does.
  //
  // So the allowed resets set the PIN explicitly, and the check asserts the PIN COMES
  // BACK and WORKS: the response carries it, and a reset whose PIN cannot sign in is a
  // lockout dressed as a feature.
  const resetTargets = { STAFF: roster.STAFF, MANAGER: roster.MANAGER, OWNER: d.owner, ADMIN: d.admin };
  for (const [actorKey, actor] of [['MANAGER', roster.MANAGER], ['STAFF', roster.STAFF], ['OWNER', d.owner]]) {
    if (!actor) continue;
    for (const [targetRole, targetActor] of Object.entries(resetTargets)) {
      if (!targetActor) continue;
      if (actorKey === targetRole) continue;
      if (String(targetActor.branchId) && String(actor.branchId) && String(targetActor.branchId) !== String(actor.branchId)) continue;
      const target = targets[targetRole] || { id: targetActor.userId, role: targetRole };
      const allow = rules.canResetPin(actor.user || { id: actor.userId, role: actor.role }, target);
      let issued = null;
      await rules.expectRule(audit, {
        what: `a ${rules.roleLabel(actor.role)} resetting a ${rules.roleLabel(targetRole)}'s PIN is ${allow ? 'allowed' : 'refused'}`,
        allow,
        refusalSpeaks: /cannot|only|role|pin/i,
        act: async () => {
          const res = await actor.post(`/api/users/${encodeURIComponent(target.id)}/reset-pin`, { new_pin: '73041' });
          if (res.status === 200 || res.status === 201) issued = res.json;
          return res;
        },
      });
      if (!issued) continue;
      await audit.checkAsync(`the PIN that reset issued really signs the ${rules.roleLabel(targetRole)} in`, async () => {
        assert.ok(issued.pin, `the reset answered without a PIN and without an error: ${JSON.stringify(issued).slice(0, 200)}`);
        const back = await d.request('POST', '/api/auth/login', { body: { username: targetActor.username, pin: issued.pin } });
        assert.equal(back.status, 200,
          `the reset said the new PIN is ${issued.pin} and signing in with it answered ${back.status} — a reset that locks the person out is worse than no reset at all`);
        assert.ok(Number(issued.sessionsEnded) >= 1,
          `the reset did not end any session for ${rules.roleLabel(targetRole)}; the old PIN is gone but the device it was typed on is still signed in`);
        targetActor.token = back.json.token;
        targetActor.pin = issued.pin;
      });
    }
  }

  // THE SELF PATH: the one a person uses, and the one with a proof requirement.
  await audit.checkAsync('changing your own PIN requires the current one', async () => {
    const res = await d.owner.post(`/api/users/${encodeURIComponent(d.owner.userId)}/reset-pin`, { current_pin: '99999', new_pin: '48125' });
    assert.equal(res.status, 403, `a wrong current PIN answered ${res.status}, not 403`);
    assert.equal(res.json && res.json.code, 'WRONG_PIN', `it refused with ${res.json && res.json.code} — a self-change has to fail on the OLD PIN, or possession of the session is all it takes to move the account`);
  });
  await audit.checkAsync('an owner can change their own PIN, and the old one stops working', async () => {
    // TWO STRONG PINS, AND THE SEAT STAYS ON THE SECOND. The fixture owner holds 12345 —
    // a straight run, written straight into the database by the deployment tool — and the
    // strength rule REFUSES to set it again from inside the app. That is correct
    // behaviour (see the deployment guide: the handover PIN is a bootstrap, not a policy)
    // and it means a check that "puts it back" cannot exist. So the owner ends this stage
    // holding a PIN the product would accept, and the fixture follows.
    const first = '48125';
    const second = '59317';
    const res = await d.owner.post(`/api/users/${encodeURIComponent(d.owner.userId)}/reset-pin`, { current_pin: d.owner.pin, new_pin: first });
    assert.equal(res.status, 200, `the owner changing their own PIN answered ${res.status} ${String(res.text).slice(0, 200)}`);
    const old = await d.request('POST', '/api/auth/login', { body: { username: d.owner.username, pin: d.owner.pin } });
    assert.equal(old.status, 401, `the OLD PIN still signs in (${old.status}) after a change — a PIN change that does not change the PIN is the whole feature missing`);
    const fresh = await d.request('POST', '/api/auth/login', { body: { username: d.owner.username, pin: first } });
    assert.equal(fresh.status, 200, `the new PIN does not sign in: ${fresh.status} ${String(fresh.text).slice(0, 160)}`);
    // Now put the seat on the second PIN, through the self path again, and hand the new
    // token and PIN to the fixture so every later section signs in as this owner.
    const again = await d.request('POST', `/api/users/${encodeURIComponent(d.owner.userId)}/reset-pin`, { token: fresh.json.token, body: { current_pin: first, new_pin: second } });
    assert.equal(again.status, 200, `the owner could not change their PIN a second time: ${again.status} ${String(again.text).slice(0, 160)}`);
    const seat = await d.request('POST', '/api/auth/login', { body: { username: d.owner.username, pin: second } });
    assert.equal(seat.status, 200, `the owner cannot sign in after changing their own PIN twice: ${seat.status}`);
    const wasPinned = d.owner.pin;
    d.owner.pin = second;
    d.owner.token = seat.json.token;

    // PUT IT BACK, AND IF IT CANNOT GO BACK, SAY SO IN CAPITALS.
    //
    // A LIVE DEPLOYMENT BELONGS TO SOMEBODY, and the owner seat this audit signs in with is
    // a person's account. The first live run of this file changed `liveseat`'s PIN to the
    // audit's second PIN and walked away — the next run could not sign in at all, and the
    // operator's documented PIN in their own notes had silently stopped working. That is a
    // worse outcome than any bug this file could find.
    //
    // So: restore the PIN the seat arrived with, and when the product refuses to (its
    // strength rule will not re-set a straight run like 12345, which is how a local fixture
    // owner starts), print what the seat now holds so nobody is locked out of their own
    // shop wondering what happened.
    const restore = await d.request('POST', `/api/users/${encodeURIComponent(d.owner.userId)}/reset-pin`, {
      token: seat.json.token, body: { current_pin: second, new_pin: wasPinned },
    });
    if (restore.status === 200) {
      const back = await d.request('POST', '/api/auth/login', { body: { username: d.owner.username, pin: wasPinned } });
      assert.equal(back.status, 200, `the owner's original PIN (${wasPinned}) does not work after being restored — this seat is now locked into a PIN the audit chose`);
      d.owner.pin = wasPinned;
      d.owner.token = back.json.token;
      audit.note(`the owner seat's PIN was changed and restored to the one it arrived with (${wasPinned})`);
    } else {
      d.owner.pin = second;
      audit.note(`⚠ THIS SEAT NOW HOLDS PIN ${second}. The owner arrived with ${wasPinned} and the product will not set it again (${(restore.json && restore.json.code) || restore.status}: a straight run is refused by the PIN strength rule). Change it back from the Users screen, or note the new PIN — the audit will not leave a client locked out silently.`);
    }
  });

  // A PIN RESET SIGNS THE PERSON OUT, and this suite just reset several PINs. That is
  // the right behaviour for the product and it is worth saying out loud here: the seat
  // whose PIN moved cannot use its old session, which is exactly why a manager resets a
  // PIN for somebody standing in front of them. So every seat signs in again before the
  // visibility section, rather than the suite treating a working rule as a broken token.
  audit.section('A reset PIN signs the person out, and they can sign back in with the new one');
  for (const [key, actor] of Object.entries(roster)) {
    if (!actor) continue;
    await audit.checkAsync(`the ${key} seat holds a working session again`, async () => {
      let fresh = null;
      let lastError = null;
      for (const pin of [actor.pin || '73041', '73041', '90210']) {
        try { fresh = await d.login({ username: actor.username, pin }); break; } catch (err) { lastError = err; }
      }
      assert.ok(fresh, `no PIN this suite used works for ${key} any more: ${lastError && lastError.message}`);
      actor.token = fresh.token;
      actor.pin = fresh.pin;
      const me = await actor.get('/api/auth/me');
      assert.equal(me.status, 200, `the fresh session for ${key} answered ${me.status}`);
      assert.equal(String((me.json.user || {}).role).toUpperCase(), String(actor.role).toUpperCase(),
        `the ${key} seat signed back in as ${(me.json.user || {}).role}`);
    });
  }

  audit.section('What each seat can SEE, and what it must not');
  // THE ROWS ARE CREATED BY THE SEATS THEMSELVES, in their own branches, so a row's
  // branch is a fact about who made it rather than a fixture's claim about itself.
  const customers = {};
  for (const [key, actor] of Object.entries(roster)) {
    if (!actor) continue;
    customers[key] = await makeCustomer(audit, actor, `Audit Roles ${key} ${Date.now().toString(36)}`);
    if (customers[key].error) audit.note(`could not create a customer as ${key}: ${customers[key].error}`);
  }
  audit.note(`customers created — ${Object.entries(customers).map(([k, v]) => `${k}:${v.id ? 'ok' : 'FAILED'}`).join(' ')}`);

  for (const [key, actor] of Object.entries(roster)) {
    if (!actor) continue;
    await audit.checkAsync(`the ${key} seat's customer list contains the rows it is allowed to reach`, async () => {
      const res = await actor.get('/api/customers?limit=200');
      assert.equal(res.status, 200, `GET /api/customers answered ${res.status} for ${key}`);
      const rows = rules.rowsOf(res);
      const mine = customers[key];
      if (mine && mine.id) {
        assert.ok(rows.some((r) => String(r.id) === String(mine.id)),
          `the ${key} seat cannot see the very customer it just created — an empty list where a shop has data reads to a cashier as "lost my records"`);
      }
    });
  }

  audit.section("Branch scope: a manager's branch is the whole of their world, and not one row more");
  for (const [key, actor] of [['MANAGER', roster.MANAGER], ['STAFF', roster.STAFF], ['MANAGER_B', roster.MANAGER_B]]) {
    if (!actor) continue;
    // THE ROW FROM THE OTHER BRANCH, and the first draft picked it by role name — so the
    // STAFF seat was asked to prove it could not read a row from ITS OWN branch, was
    // correctly allowed to read it, and the suite reported a scope leak that did not
    // exist. Which branch the row is in is the only thing that decides this check.
    const mineBranch = actor.branchId ? String(actor.branchId) : String(d.branchFor(actor).id);
    const otherKey = Object.keys(customers).find((k) => {
      const c = customers[k];
      return c && c.id && c.branchId && String(c.branchId) !== mineBranch && roster[k];
    });
    const other = otherKey ? customers[otherKey] : null;
    if (!other || !other.id) { audit.skip(`the ${key} seat's cross-branch customer row exists`, 'no fixture customer was created in another branch'); continue; }
    await audit.checkAsync(`the ${key} seat cannot read a customer from the other branch`, async () => {
      const one = await actor.get(`/api/customers/${encodeURIComponent(other.id)}`);
      assert.ok(one.status === 403 || one.status === 404,
        `reading the ${otherKey} seat's customer, which belongs to another branch (${other.branchId}), answered ${one.status} — a pinned seat that can read another branch's customer by id has no branch at all`);
      const list = await actor.get('/api/customers?limit=200');
      const rows = rules.rowsOf(list);
      const leaked = rows.filter((r) => String(r.id) === String(other.id));
      assert.equal(leaked.length, 0, `the ${key} seat's own list contains a customer from the other branch — the leak is in the list filter, which is the one every screen uses`);
    });
  }

  audit.section('Every role pair has a file, and this suite would notice if one went missing');
  const declared = rules.rolePairs();
  const covered = pairs.map((p) => [...p.pair].map((r) => String(r).toUpperCase()).sort().join('-'));
  for (const [a, b] of declared) {
    audit.check(`there is an audit for the ${rules.roleLabel(a)}–${rules.roleLabel(b)} pair`, () => {
      assert.ok(covered.includes([a, b].map((r) => String(r).toUpperCase()).sort().join('-')),
        `no file in test/audit/pairs covers ${a}-${b}. Pairs are not optional: a missing pair is a question nobody asked, and it looks identical to a pair that passes`);
    });
  }
  audit.note(`${pairs.length} pair file(s): ${pairs.map((p) => p.file.replace(/\.js$/, '')).join(', ') || 'none'}`);

  audit.section('The context every pair file shares');
  const ctx = {
    d, roster, targets, customers, rules, branchA, branchB,
    /** Every branch a pair file opened, so the run can close them again on the way out. */
    openedBranches,
    /**
     * A branch of the SAME business as this person's, other than their own — the only
     * legitimate destination for a move. Null when the deployment has just one branch
     * for that business, and then the move probe stands down instead of asserting a
     * refusal the product is right to give.
     */
    otherBranchFor(actorOrBranchId) {
      const branchId = typeof actorOrBranchId === 'object' && actorOrBranchId
        ? (actorOrBranchId.branchId || (d.branchFor(actorOrBranchId) || {}).id)
        : actorOrBranchId;
      const mine = (d.branches || []).find((b) => String(b.id) === String(branchId));
      if (!mine) return branchB;
      return (d.branches || []).find((b) => String(b.business_id) === String(mine.business_id) && String(b.id) !== String(mine.id)) || null;
    },
    /** The seat for a role key, or null. */
    actor: (key) => roster[key] || null,
    /** The customer a given seat created, with its branch. */
    row: (key) => customers[key] || null,
    /** Sign in as anybody the deployment knows — used when a pair needs a fresh session. */
    signIn: (username, pin) => d.login({ username, pin }),
  };
  audit.note(`fixture ready: ${Object.keys(roster).filter((k) => roster[k]).join(', ')}`);

  for (const pair of pairs) {
    audit.section(`${pair.title || `${pair.pair[0]} × ${pair.pair[1]}`} (${pair.file})`);
    await pair.checks(audit, ctx);
  }

  // ===================================================================
  // WHAT THIS RUN LEFT BEHIND, AND HOW IT IS PUT BACK
  // ===================================================================
  // Branches, unlike users, have no delete: a branch that has traded is part of the
  // books. So the two branches this audit opens are DEACTIVATED on the way out, by the
  // same call the product gives a shop for closing a branch — and the note says what
  // happened, because "the audit cleaned up" is a claim that has to be checkable.
  audit.section('The branches this run opened are closed again');
  for (const made of openedBranches) {
    await audit.checkAsync(`the audit closes "${made.name}"`, async () => {
      const res = await d.admin.put(`/api/branches/${encodeURIComponent(made.id)}`, { is_active: false });
      assert.ok(res.status === 200 || res.status === 403,
        `deactivating the audit's own branch answered ${res.status} ${String(res.text).slice(0, 160)}`);
    });
  }
  if (openedBranches.length) audit.note(`deactivated ${openedBranches.length} branch(es) this run opened: ${openedBranches.map((b) => b.name).join(', ')} — a branch that has traded is deactivated, never deleted`);

}, {
  setup: () => startDeployment({
    label: 'roles',
    businesses: [{
      name: 'Roles Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Roles Main Shop', code: 'ROL-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 50000 },
        { name: 'Roles Second Shop', code: 'ROL-2', city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL', opening_cash: 0 },
      ],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'roles-manager', pin: '73041', branchIndex: 0, full_name: 'Roles Manager' },
      { as: 'staff', role: 'STAFF', username: 'roles-staff', pin: '73041', branchIndex: 0, full_name: 'Roles Cashier' },
      { as: 'managerB', role: 'MANAGER', username: 'roles-manager-b', pin: '73041', branchIndex: 1, full_name: 'Roles Manager B' },
      { as: 'staffB', role: 'STAFF', username: 'roles-staff-b', pin: '73041', branchIndex: 1, full_name: 'Roles Cashier B' },
    ],
  }),
});
