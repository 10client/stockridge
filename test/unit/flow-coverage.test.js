'use strict';
// =====================================================================
// test/unit/flow-coverage.test.js — THE MAP HAS TO AGREE WITH THE TERRITORY
// =====================================================================
// `tools/flow-coverage.js` grades the audit suite: which flows a live audit exercises,
// and which it does not. That makes it a MEASURING INSTRUMENT, and an instrument that is
// quietly wrong is worse than no instrument — it reports coverage nobody has.
//
// The tool reads the API two ways on purpose (the source text, and the router's own
// route table). This test asserts they agree, exactly as the purge engine's
// parser-agreement test asserts the schema reader matches the engine. It caught two real
// defects while it was being written:
//
//   * the scan assumed every router is mounted at `/api`, so it reported `POST /api/login`
//     — a route that does not exist — and missed all eight branding routes, which live at
//     `/api/branding`;
//   * a handler for the mount point itself (`app.get(base, …)`) was invisible, which is
//     how `GET /api/branding` and `PUT /api/branding` were missing from a list of what the
//     server serves.
//
// AND THE ASSERTION IS ON THE AGREEMENT, NOT ON A NUMBER. A hard-coded count would have
// to be edited every time a route is added, and the edit would be made to whatever the
// tool happened to print — which is how a check stops checking anything.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  normalise, mountBases, registeredRoutes, routesFromRouter,
} = require(path.join(ROOT, 'tools/flow-coverage.js'));

function serverFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'server'));
  return out;
}

test('flow coverage: the two readings of the API agree', () => {
  const parsed = registeredRoutes(serverFiles());
  const fromRouter = routesFromRouter();
  assert.ok(Array.isArray(fromRouter), `the router could not be built: ${fromRouter.error}`);
  assert.ok(parsed.length > 100, `the text scan found only ${parsed.length} routes, so it is not reading the routers`);
  assert.ok(fromRouter.length > 100, `the router registered only ${fromRouter.length} routes`);

  const key = (r) => `${r.method} ${r.path}`;
  const parsedSet = new Set(parsed.map(key));
  const routerSet = new Set(fromRouter.map(key));
  const missingFromScan = [...routerSet].filter((k) => !parsedSet.has(k));
  const inventedByScan = [...parsedSet].filter((k) => !routerSet.has(k));

  assert.deepEqual(missingFromScan, [],
    `the router serves ${missingFromScan.length} route(s) the scan cannot see — every coverage number this tool reports excludes them`);
  assert.deepEqual(inventedByScan, [],
    `the scan reports ${inventedByScan.length} route(s) that do not exist, so the coverage report grades endpoints nobody can call`);
});

test('flow coverage: every router mount has a base the scan can read', () => {
  const bases = mountBases();
  for (const [name, base] of bases) {
    assert.ok(base.startsWith('/api'), `router ${name} resolves to base "${base}", which is not under /api`);
  }
  assert.ok(bases.size >= 15, `only ${bases.size} routers have a readable mount base, so the scan is falling back to /api for the rest`);
  // THE AUTH ROUTER IS THE ONE THAT PROVES THE POINT: mounted at /api/auth, so a scan
  // that assumed /api would report POST /api/login.
  assert.equal(bases.get('auth'), '/api/auth');
});

test('flow coverage: the two spellings of a parameter are one path', () => {
  // `:id` IN A ROUTE and `${id}` IN A CALL have to compare equal, or every
  // cross-reference in the tool is a comparison of spelling.
  const same = ['/api/users/:id/transfer', '/api/users/${encodeURIComponent(id)}/transfer'].map(normalise);
  assert.equal(new Set(same).size, 1, `the two spellings produced ${same.join(' | ')}`);
  assert.equal(normalise('/api/sales?limit=5'), '/api/sales');
  assert.equal(normalise('/api/sales/'), '/api/sales');
  // A CONCRETE id IS NOT NORMALISED AWAY, deliberately: the tool cannot know that "12"
  // is an id and "settle" is not, and a normaliser that guessed would also flatten
  // /api/change-owed/summary into a claim lookup. Concrete calls reach wildcard routes
  // through coverageOf() instead, which is asserted next.
  assert.equal(normalise('/api/users/12/transfer'), '/api/users/12/transfer');
});

test('flow coverage: a concrete call reaches the wildcard route that serves it', () => {
  const { coverageOf } = require(path.join(ROOT, 'tools/flow-coverage.js'));
  const route = { method: 'GET', path: '/api/sales/*' };
  const evidence = [
    { path: '/api/sales/9f2c', method: 'GET', audit: 'audit.example' },
    { path: '/api/sales/9f2c/void', method: 'POST', audit: 'audit.example' },
  ];
  const cov = coverageOf(route, evidence);
  assert.deepEqual(cov.by, ['audit.example'], 'a concrete GET did not reach the wildcard route that serves it');
  // AND THE METHOD STILL MATTERS: a suite that only ever GETs a collection has not
  // covered the POST that creates one.
  const posted = coverageOf({ method: 'POST', path: '/api/sales' }, evidence);
  assert.deepEqual(posted.by, [], 'a POST route was reported as covered by a GET');
});
