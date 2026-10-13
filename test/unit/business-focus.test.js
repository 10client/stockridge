'use strict';
// The side nav has to scroll inside a locked shell, and a named business has to
// narrow a list an owner is allowed to see in full. Both are easy to regress:
// a min-height of auto on the grid item makes overflow never engage, and an
// owner scope adds no business clause, so a list that only used that clause
// kept showing every business under a heading that named one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scopeFilter, resolveBranch, resolveBusiness } = require('../../server/lib/respond');
const { Context } = require('../../server/lib/http');
const { modulesOf } = require('../../domain/modules');

const root = path.resolve(__dirname, '..', '..');

test('a named business narrows an owner list and does not replace the security rule', () => {
  const unnamed = scopeFilter({ allBusinesses: true, allBranches: true }, { alias: 's' });
  assert.equal(unnamed.sql, '', 'an owner who named nothing must still see the group');

  const focused = scopeFilter({ allBusinesses: true, allBranches: true, focusBusinessId: 'biz-b' }, { alias: 's' });
  assert.match(focused.sql, /s\.business_id = \?/);
  assert.deepEqual(focused.params, ['biz-b']);
  assert.match(focused.sql, /IS NULL/, 'a shared row must not vanish from a focused list');

  const cashier = scopeFilter({
    allBusinesses: false,
    allBranches: false,
    businessIds: new Set(['biz-a']),
    branchIds: new Set(['br1']),
    focusBusinessId: 'biz-b',
  }, { alias: 's' });
  assert.match(cashier.sql, /biz-a|IN \(\?\)/);
  assert.ok(cashier.params.includes('biz-a'), 'focus must not drop the businesses they are allowed to see');
  assert.ok(cashier.params.includes('biz-b'));

  const count = scopeFilter({ allBusinesses: true, allBranches: true, focusBusinessId: 'biz-b' }, { alias: 'b', ignoreFocus: true });
  assert.equal(count.sql, '', 'counting reachable shops must not treat a focused business as the only shop they can reach');
});

test('a named dispensary is not judged as the owner home shop', async () => {
  const branches = [
    { id: 'br-elec', business_id: 'biz-elec', name: 'Head office', is_deleted: 0, is_active: 1 },
    { id: 'br-pharma', business_id: 'biz-pharma', name: 'pharmaHq', is_deleted: 0, is_active: 1 },
  ];
  const businesses = [
    { id: 'biz-elec', name: 'electronica', profile_code: 'ELECTRONICS', is_deleted: 0 },
    { id: 'biz-pharma', name: 'pharmaridge', profile_code: 'PHARMACEUTICAL', is_deleted: 0 },
  ];
  const db = {
    async first(sql, params) {
      const id = String(params && params[0]);
      if (sql.includes('FROM branches')) return branches.find((b) => b.id === id) || null;
      if (sql.includes('FROM businesses')) return businesses.find((b) => b.id === id) || null;
      return null;
    },
    async all() { return branches.map((b) => ({ id: b.id })); },
  };
  const scope = {
    role: 'OWNER', allBusinesses: true, allBranches: true,
    businessIds: null, branchIds: null,
    pinnedBranchId: 'br-elec', pinnedBusinessId: 'biz-elec',
  };
  function ctxFor(businessId) {
    const url = businessId
      ? `http://localhost/api/pharmacy/register?business_id=${businessId}`
      : 'http://localhost/api/pharmacy/register';
    const ctx = new Context({ method: 'GET', url, headers: new Headers(), body: null, env: {}, params: {} });
    ctx.set('scope', scope);
    ctx.set('user', { id: 'owner', role: 'OWNER' });
    return ctx;
  }

  const named = ctxFor('biz-pharma');
  const branch = await resolveBranch(db, named, { required: false });
  assert.equal(branch, null, 'the electronics pin was used as the pharmaceutical shop');
  const business = await resolveBusiness(db, named, branch || undefined, { required: false });
  assert.equal(business.id, 'biz-pharma');
  const modules = modulesOf(business.profile_code, null);
  assert.equal(modules.dispensing, true, 'the controlled register was refused for a dispensary');
  assert.equal(modules.nafdac, true, 'the Greenbook was refused for a pharmaceutical business');

  const home = ctxFor(null);
  const pinned = await resolveBranch(db, home, { required: false });
  assert.equal(pinned && pinned.id, 'br-elec', 'a request that names no business must still use the home shop');
});

test('the side nav scrolls its list, and the shell does not clip login', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  assert.match(css, /\.shell \{[\s\S]*height: 100dvh;[\s\S]*overflow: hidden;/, 'the shell is not locked to the viewport');
  assert.match(css, /\.nav-list \{[\s\S]*overflow-y: auto;/, 'the nav list does not scroll');
  assert.match(css, /\.sidenav \{[\s\S]*min-height: 0;/, 'the nav can still grow the page');
  assert.doesNotMatch(css, /body \{[^}]*overflow:\s*hidden/, 'body overflow hidden would clip the login screen');
  assert.match(html, /id="business-switch"/);
  assert.match(html, /id="business-chip"/);
  assert.match(app, /openBusinessPicker/);
  assert.match(app, /setBusiness\(/);
  assert.match(app, /guardWorkingBusiness/);
});
