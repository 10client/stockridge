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

test('state: an owner is not switched onto the only branch of the active business', async () => {
  // The active business having one shop is not a switch. The dashboard sends
  // whatever activeBranchId is set, and a guessed id is how branch totals
  // appeared before the owner had chosen a shop.
  const state = loadState({
    me: {
      user: { id: 'u3', username: 'solo', role: 'OWNER', fullName: 'Solo', business: { id: 'b1', name: 'One' } },
      scope: { role: 'OWNER', allBusinesses: true, allBranches: true, businessIds: null, branchIds: null, pinnedBusinessId: null, pinnedBranchId: null },
      businesses: [{ id: 'b1', name: 'One' }, { id: 'b2', name: 'Two' }],
      branches: [{ id: 'br1', business_id: 'b1', name: 'Only shop' }, { id: 'br2', business_id: 'b2', name: 'Other shop' }],
      settings: {}, featureLabels: {}, vertical: null,
    },
  });
  await state.load({ force: true });
  assert.equal(state.activeBranch(), null, 'the only branch of the active business was treated as a switch');
  assert.equal(state.query().branch_id, undefined, 'the dashboard query names a branch the owner did not switch to');
});

test('state: serial numbers are off unless the business has turned them on', async () => {
  const off = loadState({
    me: {
      user: { id: 'u9', username: 'owner', role: 'OWNER', fullName: 'Owner' },
      scope: { role: 'OWNER', allBusinesses: true, allBranches: true },
      businesses: [], branches: [], settings: { serial_tracking_enabled: 0 }, featureLabels: {}, vertical: null,
    },
  });
  await off.load({ force: true });
  assert.equal(off.usesSerialNumbers(), false, 'a business that has not asked for serials is being asked for them');

  const missing = loadState({
    me: {
      user: { id: 'u9b', username: 'owner', role: 'OWNER', fullName: 'Owner' },
      scope: { role: 'OWNER', allBusinesses: true, allBranches: true },
      businesses: [], branches: [], settings: {}, featureLabels: {}, vertical: null,
    },
  });
  await missing.load({ force: true });
  assert.equal(missing.usesSerialNumbers(), false, 'a missing switch was treated as on');

  const on = loadState({
    me: {
      user: { id: 'u9c', username: 'owner', role: 'OWNER', fullName: 'Owner' },
      scope: { role: 'OWNER', allBusinesses: true, allBranches: true },
      businesses: [], branches: [], settings: { serial_tracking_enabled: 1 }, featureLabels: {}, vertical: null,
    },
  });
  await on.load({ force: true });
  assert.equal(on.usesSerialNumbers(), true, 'turning the switch on did not reach the counter');
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

test('state: a deployment with no business yet still names itself', async () => {
  // THE SUBTITLE DEFECT. An administrator's first job on a fresh installation is to
  // create the business, so until they have, there is none — and `activeBusiness()`
  // returns null. Five screens wrote `${SR.state.activeBusiness().name}` into their
  // header, so on exactly those deployments they threw before drawing anything and
  // the screen showed "That failed. Cannot read properties of null (reading 'name')".
  // The Subscription screen sits in the administrator's own navigation, which is how
  // it was noticed.
  const state = loadState({
    me: {
      user: { id: 'a1', username: 'admin', role: 'ADMIN', fullName: 'Platform Admin' },
      scope: { role: 'ADMIN', allBusinesses: true, allBranches: true, businessIds: null, branchIds: null },
      businesses: [], branches: [],
      settings: { business_name: 'StockRidge' },
      featureLabels: {}, vertical: null,
    },
  });
  await state.load({ force: true });

  assert.equal(state.activeBusiness(), null, 'a fresh deployment really has no business — the test is meaningless otherwise');
  assert.equal(typeof state.activeBusinessName, 'function', 'a subtitle needs a helper that cannot throw');
  // THE ASSERTION THAT MATTERS: calling it must not throw, and must say something true.
  assert.equal(state.activeBusinessName(), 'StockRidge', 'with the deployment named, use that');
  assert.equal(
    state.activeBusinessName('—'), 'StockRidge',
    'the fallback is only for a deployment that is not named either',
  );
});

test('frontend: no screen dereferences a business that may not exist', () => {
  // The rule the defect broke, enforced from now on: `activeBusiness()` and
  // `activeBranch()` are ALLOWED TO RETURN NULL, so their result may be tested but
  // never dereferenced directly. One `.name` after the call is a page that cannot
  // render itself on a deployment that has not been provisioned yet.
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && entry.name !== 'state.js') files.push(full);
    }
  }(path.join(PUBLIC_DIR, 'js')));

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bactive(Business|Branch)\(\)\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      offenders.push(`${path.relative(PUBLIC_DIR, file)}: active${m[1]}().${m[2]}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    `these read a value that can be null, so the screen throws instead of rendering:\n  ${offenders.join('\n  ')}\n`
    + '    use SR.state.activeBusinessName(), or test the value before reading from it',
  );
});

test('an owner does not need a branch; a cashier does', () => {
  const state = loadState({ me: ME });
  assert.equal(state.roleNeedsBranch('OWNER'), false, 'an owner reaches every branch — the form must not demand one');
  assert.equal(state.roleNeedsBranch('ADMIN'), false, 'the deployment administrator is not pinned to a branch');
  assert.equal(state.roleNeedsBranch('MANAGER'), true, 'a manager is scoped by the branch they belong to');
  assert.equal(state.roleNeedsBranch('STAFF'), true, 'a cashier with no branch would see nothing');
});

test('a purchase-order line is not ordered until a catalogue product is picked', () => {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'views', 'purchase-orders.js'), 'utf8');
  assert.ok(/A typed name is not ordered/.test(src),
    'the raise screen no longer tells the person that a typed name was not ordered');
  assert.ok(/On this order/.test(src),
    'the raise screen no longer says, on the line itself, whether the product is on the order');
  assert.equal(src.includes("ui.warn('Add at least one item with a quantity.')"), false,
    'the old refusal is still the one a typed line hits — it drops the line and says add at least one');
});
