'use strict';
// =====================================================================
// test/audit/lib/role-rules.js — THE MATRIX, READ FROM THE PRODUCT'S OWN RULES
// =====================================================================
// A ROLE MATRIX IS A CLAIM, AND A CLAIM NEEDS A WITNESS.
//
// `domain/roles.js` says who outranks whom: ADMIN above OWNER above MANAGER above
// STAFF, with three named consequences — who may be managed, whose PIN may be reset,
// and whose role may be changed into what. Every route in `server/routes/admin.js`
// then re-asks those questions at the door.
//
// The failure mode this file exists for is not a missing check. It is a check that
// DISAGREES WITH THE RULE IT IMPLEMENTS. `canManageUser` says an owner cannot touch an
// administrator; a route that hand-rolls `if (role === 'ADMIN')` somewhere else can
// easily say otherwise, and the two answers will never be compared because each is
// only ever exercised by its own author. So this library does not restate the rules.
// It CALLS THEM — the same module the server calls — and then holds the API to the
// answer. If somebody changes `domain/roles.js`, the expectation moves with it and the
// audit tests the new rule; if somebody changes a route and forgets the domain file,
// the audit goes red. That is the whole design.
//
// It is deliberately not an audit itself: nothing in `test/audit/` may be a file
// nothing runs (`test/audit/suite.js` refuses those). It is a library, and the
// per-pair audits under `test/audit/pairs/` are what run it.
// =====================================================================

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const roles = require(path.join(ROOT, 'domain', 'roles.js'));

const { ROLE_ORDER, ROLE_RANK, rankOf, outranks, atLeast, canManageUser, canResetPin, canChangeRole, roleLabel } = roles;

/** Every unordered pair of distinct roles — the shape of `test/audit/pairs/`. */
function rolePairs() {
  const out = [];
  for (let i = 0; i < ROLE_ORDER.length; i += 1) {
    for (let j = i + 1; j < ROLE_ORDER.length; j += 1) out.push([ROLE_ORDER[i], ROLE_ORDER[j]]);
  }
  return out;
}

/**
 * Turn a rule call into the pair of sentences the audit prints.
 *
 * `allow` is the domain's answer, computed by running the product's own function. The
 * caller supplies a closure that performs the HTTP call, so a single helper serves
 * creating a user, editing one, resetting a PIN and changing a role.
 */
async function expectRule(audit, { what, allow, act, refusalCode = 'ROLE_REQUIRED', refusalSpeaks = null, allowStatus = null, refuseStatus = [403] }) {
  return audit.checkAsync(what, async () => {
    const res = await act();
    if (allow) {
      const ok = allowStatus ? allowStatus.includes(res.status) : res.status >= 200 && res.status < 300;
      if (!ok) {
        throw new Error(
          `${res.status} ${(res.json && (res.json.code || res.json.error)) || res.text.slice(0, 160)} — the rule in domain/roles.js ALLOWS this, so this refusal is the product breaking its own hierarchy: the screen the rule was written for will not work`);
      }
      return;
    }
    if (res.status >= 200 && res.status < 300) {
      throw new Error(
        `it answered ${res.status} and went through. The rule in domain/roles.js REFUSES this, so a ${'seat'} just did something the product says it cannot do — and nothing downstream will ever re-check it`);
    }
    if (!refuseStatus.includes(res.status)) {
      throw new Error(`it was refused with ${res.status} ${(res.json && res.json.code) || ''}, not ${refuseStatus.join('/')} — and a 500 here reads to the shop as a broken app rather than a rule`);
    }
    const code = res.json && res.json.code;
    if (code && code !== refusalCode && !/ROLE|ADMIN|SCOPE/.test(String(code))) {
      throw new Error(`it was refused with code ${code}; the role rules answer ${refusalCode}`);
    }
    const said = String((res.json && (res.json.error || res.json.message)) || '');
    if (!said) throw new Error('it was refused with no message — a refusal has to tell the person what to do instead');
    if (refusalSpeaks && !refusalSpeaks.test(said)) {
      throw new Error(`refused with "${said}", which does not say why. The person being refused is a shopkeeper, not a developer`);
    }
  });
}

/** A stable, human label for an actor/target pair used in check text. */
function label(actorRole, targetRole) {
  return `${roleLabel(actorRole)} acting on a ${roleLabel(targetRole)}`;
}

/** Rows a list endpoint returned, whatever this endpoint calls its array. */
function rowsOf(res) {
  if (!res || !res.json) return [];
  const j = res.json;
  for (const key of ['data', 'rows', 'items', 'users', 'products', 'customers', 'sales', 'expenses']) {
    if (Array.isArray(j[key])) return j[key];
  }
  return Array.isArray(j) ? j : [];
}

/**
 * MAKE SOMEBODY TO TEST WITH, through the real endpoint, and remember them.
 *
 * A pair file regularly needs a THIRD person — a disposable cashier to deactivate, a
 * fresh manager who has never signed in — because probing a boundary by deactivating
 * one of the seats the rest of the suite still needs is how an audit breaks itself.
 * Everything created here is tracked, so a run against a live deployment retires it.
 */
async function makeUser(d, { maker, role, full_name, branchId = null, pin = '73041' }) {
  const username = `audit-pair-${String(role).toLowerCase()}-${Date.now().toString(36).slice(-6)}`;
  const res = await maker.post('/api/users', {
    username, pin, full_name: full_name || `Audit ${role} ${username.slice(-4)}`,
    role, branch_id: branchId || undefined,
  });
  const id = res.json && (res.json.id || res.json.userId || (res.json.user && res.json.user.id));
  if (id) d.trackUser(id);
  // THE BRANCH COMES BACK WITH THE PERSON. Without it a pair file cannot ask "where is
  // this person NOW", and a move probe then moves somebody to the branch they are already
  // in — which the product refuses with 400 NO_CHANGES, correctly, while the audit reads
  // it as the move being broken.
  return { id, username, pin, role, branchId, status: res.status, res, created: res.status === 200 || res.status === 201 };
}

/** Sign in through the raw endpoint: the response, not an Actor. Nothing throws here. */
function signIn(d, username, pin) {
  return d.request('POST', '/api/auth/login', { body: { username, pin } });
}

module.exports = {
  ROOT,
  ROLE_ORDER, ROLE_RANK, rankOf, outranks, atLeast, canManageUser, canResetPin, canChangeRole, roleLabel,
  rolePairs, expectRule, label, rowsOf, makeUser, signIn,
};
