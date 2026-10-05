'use strict';
// =====================================================================
// test/unit/frontend-state.test.js — THE STATE SURFACE HAS TO SURVIVE A LOAD
// =====================================================================
// THE DEFECT THIS EXISTS FOR, found only by running the real frontend in a DOM:
//
//   const state = { businesses: [], branches: [] };
//   SR.state = Object.assign(state, { businesses, branches, … });   // functions
//   …
//   state.branches = data.branches;                                  // ARRAY again
//
// The merge put the accessor FUNCTION on the key; `load()` put the ARRAY back on
// the same key. From the first session load onward, `SR.state.branches` was an
// array and `SR.state.branches()` threw "is not a function".
//
// `app.js` calls it inside `paintIdentity()`, and `showShell()` ran
// `paintIdentity()` BEFORE `buildNav()`. So the throw skipped the navigation
// build: the shell rendered with an EMPTY SIDEBAR for every role, on every
// deployment — including the platform administrator, whose whole job is to create
// the first business.
//
// Nothing caught it. `node --test` never loads the browser code; the static
// frontend tests check that views exist and that routes are registered. A key
// that is silently both an array and a function is invisible to all of it.
//
// This test runs `public/js/state.js` for real, in a stub window, and asserts the
// accessors are still callable AFTER a load. It also checks, statically, that
// every `SR.state.<name>(…)` call in the frontend names something the state
// module actually defines.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const STATE_SRC = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'state.js'), 'utf8');

/** A window just real enough for state.js: the module only touches these. */
function makeWindow({ me = {} } = {}) {
  const stored = new Map();
  const window = {
    SR: {
      util: {
        nowIso: () => '2026-10-05T12:00:00.000Z',
        clamp: (v, a, b) => Math.min(Math.max(v, a), b),
        esc: (s) => String(s),
      },
      api: {
        me: async () => me,
        on() {}, emit() {},
      },
      store: {
        putMany: async () => {},
        all: async () => [],
        metaSet: async () => {},
        metaGet: async () => null,
      },
    },
    localStorage: {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, String(v)),
      removeItem: (k) => stored.delete(k),
    },
  };
  return window;
}

/** Load public/js/state.js into a stub window and hand back the state object. */
function loadState(options) {
  const window = makeWindow(options);
  // The file is an IIFE taking `window`; running it with new Function keeps this
  // test free of a DOM dependency while still executing the real source.
  // eslint-disable-next-line no-new-func
  new Function('window', STATE_SRC)(window);
  return window.SR.state;
}

const ME = {
  // The shape /api/auth/me returns: `branch` is an OBJECT, and it is what
  // resolveActive() reads to pin the active branch.
  user: {
    id: 'u1', username: 'owner', role: 'OWNER', fullName: 'Test Owner',
    business: { id: 'b1', name: 'Ridge Electronics' },
    branch: { id: 'br1', name: 'Main' },
  },
  scope: { role: 'OWNER', allBusinesses: true, allBranches: true, businessIds: null, branchIds: null, pinnedBusinessId: 'b1', pinnedBranchId: 'br1' },
  businesses: [{ id: 'b1', name: 'Ridge Electronics', profile_code: 'ELECTRONICS' }],
  branches: [{ id: 'br1', business_id: 'b1', name: 'Main' }, { id: 'br2', business_id: 'b1', name: 'Second' }],
  settings: { business_name: 'Ridge Electronics' },
  featureLabels: {},
  vertical: { profile_code: 'ELECTRONICS' },
};

test('state: the row accessors are still functions after a load', async () => {
  const state = loadState({ me: ME });

  assert.equal(typeof state.branches, 'function', 'branches() must be a function before any load');
  assert.equal(typeof state.businesses, 'function', 'businesses() must be a function before any load');

  await state.load({ force: true });

  // THE ASSERTION THAT WOULD HAVE CAUGHT IT. `load()` writes the rows; the
  // accessors have to survive that write.
  assert.equal(
    typeof state.branches, 'function',
    'load() overwrote the branches() accessor with the raw array — this empties the sidebar for every role',
  );
  assert.equal(typeof state.businesses, 'function', 'load() overwrote the businesses() accessor');
  assert.equal(typeof state.branchesFor, 'function');
  assert.equal(typeof state.activeBusiness, 'function');
  assert.equal(typeof state.activeBranch, 'function');
});

test('state: the accessors return the rows the server sent', async () => {
  const state = loadState({ me: ME });
  await state.load({ force: true });

  assert.equal(state.branches().length, 2);
  assert.equal(state.branches()[0].name, 'Main');
  assert.equal(state.businesses().length, 1);
  assert.equal(state.businesses()[0].name, 'Ridge Electronics');
  assert.equal(state.branchesFor('b1').length, 2);
  assert.equal(state.activeBusiness().id, 'b1', 'the only business in reach becomes active');
  assert.equal(state.activeBranch().id, 'br1', 'a user pinned to a branch gets that branch');
});

test('state: an owner with several branches and no pin is asked, not guessed at', async () => {
  // The counterpart, and the reason the test above pins a branch: when somebody
  // reaches more than one branch and is not pinned to any, the app must NOT
  // choose. Every sale, stock movement and cash entry carries a branch, so
  // guessing posts a shop's takings against the wrong shop.
  const state = loadState({
    me: {
      ...ME,
      user: { id: 'u2', username: 'multiowner', role: 'OWNER', fullName: 'Multi Owner' },
    },
  });
  await state.load({ force: true });

  assert.equal(state.branches().length, 2, 'both branches are reachable');
  assert.equal(state.activeBranch(), null, 'no branch is chosen for them');
  assert.equal(state.activeBusiness().id, 'b1', 'the business is still resolved');
  assert.equal(typeof state.activeBranchName(), 'string', 'the chip still has something to show');
});

test('state: an administrator with no business loads without throwing', async () => {
  // The case the user hit: an ADMIN belongs to no business and no branch, so
  // every list is empty and every accessor still has to be callable. A guard that
  // only holds when there is data is not a guard.
  const state = loadState({
    me: {
      user: { id: 'a1', username: 'admin', role: 'ADMIN', fullName: 'Platform Administrator' },
      scope: { role: 'ADMIN', allBusinesses: true, allBranches: true, businessIds: null, branchIds: null, pinnedBusinessId: null, pinnedBranchId: null },
      businesses: [], branches: [], settings: {}, featureLabels: {}, vertical: null,
    },
  });

  await state.load({ force: true });
  assert.equal(typeof state.branches, 'function');
  assert.deepEqual(state.branches(), []);
  assert.deepEqual(state.businesses(), []);
  assert.equal(state.activeBusiness(), null);
  assert.equal(state.activeBranch(), null);
  // activeBranchName() is read by paintIdentity() for the branch chip.
  assert.equal(typeof state.activeBranchName(), 'string');
});

test('frontend: every SR.state.<name>() call names something the state module defines', () => {
  // The same class of bug one typo away: `SR.state.canSeeEverything()` would
  // throw exactly where `SR.state.branches()` did — inside chrome painting, which
  // used to take the navigation with it. Static, cheap, and it covers every view.
  const defined = new Set();
  const assign = STATE_SRC.match(/SR\.state = Object\.assign\(state, \{([\s\S]*?)\}\);/);
  assert.ok(assign, 'the state module must still merge its public surface with Object.assign');
  for (const raw of assign[1].split(',')) {
    const name = raw.trim().split(/\s|:/)[0];
    if (name) defined.add(name);
  }
  // Reading rows is allowed through the state object's own fields too.
  for (const field of ['user', 'scope', 'settings', 'featureLabels', 'vertical', 'activeBranchId', 'activeBusinessId']) defined.add(field);

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(PUBLIC_DIR, 'js'));

  const unknown = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bSR\.state\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!defined.has(m[1])) unknown.push(`${path.relative(PUBLIC_DIR, file)}: SR.state.${m[1]}()`);
    }
  }
  assert.deepEqual(
    unknown, [],
    `the frontend calls state methods that do not exist:\n  ${unknown.join('\n  ')}`,
  );
});

test('frontend: the navigation is built from routes every role can reach', () => {
  // An empty sidebar can also be caused by role filtering: if no route lists a
  // role, that role gets no navigation at all. ADMIN is the one that matters,
  // because an administrator's first job is creating the client's business.
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js'), 'utf8');
  const routes = [...app.matchAll(/\{ path: '([^']+)',[^}]*nav: false[^}]*\}/g)];
  const navRoutes = [...app.matchAll(/\{ path: '([^']+)',(?![\s\S]{0,200}?nav: false)[\s\S]{0,300}?roles: \[([^\]]*)\]/g)]
    .filter((m) => !/nav:\s*false/.test(m[0]));

  assert.ok(navRoutes.length > 5, `expected a populated route table, found ${navRoutes.length} nav routes`);
  assert.ok(routes.length > 5, 'detail routes are still marked nav:false');

  const rolesInTemplate = (app.match(/const ROUTES = \[([\s\S]*?)\n  \];/) || [])[1] || '';
  for (const role of ['ADMIN', 'OWNER', 'MANAGER', 'STAFF']) {
    const count = [...rolesInTemplate.matchAll(new RegExp(`roles: \\[[^\\]]*'${role}'`, 'g'))].length;
    assert.ok(count > 0, `${role} appears in no route's roles list, so that role would see an empty sidebar`);
  }
});
