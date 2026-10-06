'use strict';
// =====================================================================
// test/e2e/frontend-contract.test.js — EVERY ENDPOINT THE UI CALLS MUST EXIST
// =====================================================================
// This test exists because of a bug that nothing else caught.
//
// The supplier screen fetched GET /api/suppliers/:id. That route did not exist —
// only GET /api/suppliers did. The server answered 404, the UI showed "not
// found", and every static check passed: `node --check` sees a valid string, the
// API tests never call it, and the screen looks fine until somebody opens a
// supplier and the page is empty.
//
// A missing route is a class of bug, not an incident, so it is tested as a
// class: the frontend's API calls are extracted from source and every one of
// them must match a route the server actually registers, with the right METHOD.
// The route table is read from the live app object, so it cannot drift from what
// the router really does.
//
// It is deliberately a source-level check rather than a request-level one: it
// runs in milliseconds, needs no database, and reports the file and line of the
// offending call — which is what you want when it fails.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { createHttpApp } = require(path.join(ROOT, 'server/app'));

// ---------------------------------------------------------------------
// 1. What the server actually registers
// ---------------------------------------------------------------------
function serverRoutes() {
  // The DB is never touched by route registration, so a stub is enough and this
  // test stays independent of any file on disk.
  const app = createHttpApp({
    db: {
      async all() { return []; }, async first() { return null; }, async run() {},
      async scalar() { return 0; }, async transaction(fn) { return fn({ queue() {}, idFor() { return 'x'; } }); },
    },
    jwtSecret: 'frontend-contract-test-secret',
    settings: {},
  });
  const routes = (app && app.routes) || [];
  return routes
    .filter((r) => r.pattern.startsWith('/api'))
    .map((r) => ({ method: r.method, pattern: r.pattern }));
}

/** Turn `/api/sales/:id/void` into a matcher, treating `:x` and `*` as wildcards. */
const { patternMatches } = require('../../tools/lib/api-calls.js');

// ---------------------------------------------------------------------
// 2. What the frontend asks for
// ---------------------------------------------------------------------
/**
 * Extract every `SR.api.<verb>(<literal>)` call from the client source.
 *
 * Both quote styles are covered, and a template literal's `${...}` becomes a
 * single-segment wildcard, so `/api/sales/${id}/void` is checked as
 * `/api/sales/:id/void` — the shape the router stores.
 */
// THE READER IS SHARED, and that is the fix rather than the tidying.
//
// This file used to carry its own extractor, and so did frontend-routes.test.js.
// Both were regexes that stopped at the first backtick, so a template literal
// containing another template was read as a truncated path and reported as a
// missing route. The first copy was fixed and this one stayed wrong, which is
// exactly why there is now one reader for both tests: see test/helpers/api-calls.js.
const { apiCalls } = require('../../tools/lib/api-calls.js');

function frontendCalls() {
  return apiCalls().map((c) => ({ ...c, pathname: c.pathname.replace(/\*/g, ':wildcard') }));
}

test('every endpoint the frontend calls exists on the server, with the right method', () => {
  const routes = serverRoutes();
  assert.ok(routes.length > 60, `expected the full API surface to register, got ${routes.length} routes`);

  const calls = frontendCalls();
  assert.ok(calls.length > 80, `expected the frontend to make a substantial number of calls, found ${calls.length}`);

  const missing = [];
  for (const call of calls) {
    const hit = routes.some((r) => r.method === call.method && patternMatches(r.pattern, call.pathname));
    if (!hit) missing.push(call);
  }

  if (missing.length) {
    const detail = missing.map((c) => `  ${c.method} ${c.raw}\n    at ${c.file}:${c.line}\n    ${c.sourceHint.trim()}`).join('\n');
    assert.fail(
      `${missing.length} frontend call(s) hit no server route:\n${detail}\n\n` +
      'Either the path is misspelled in the view, or the route was never added to server/routes/*.js.',
    );
  }
});

test('the frontend never calls an endpoint with the wrong HTTP method', () => {
  // A path that exists under a different verb is the same failure wearing a hat:
  // POST /api/suppliers/:id/payments exists, GET does not, and a view that reads
  // with the wrong verb gets a 404 nobody can explain.
  const routes = serverRoutes();
  const byPath = new Map();
  for (const r of routes) {
    if (!byPath.has(r.pattern)) byPath.set(r.pattern, new Set());
    byPath.get(r.pattern).add(r.method);
  }
  const wrong = [];
  for (const call of frontendCalls()) {
    const pathExists = [...byPath.keys()].some((p) => patternMatches(p, call.pathname));
    const methodOk = routes.some((r) => r.method === call.method && patternMatches(r.pattern, call.pathname));
    if (pathExists && !methodOk) {
      const verbs = [...byPath.entries()].filter(([p]) => patternMatches(p, call.pathname)).map(([, s]) => [...s].join('/'));
      wrong.push(`${call.file}:${call.line} — ${call.method} ${call.raw} (the path exists for ${verbs.join(', ')})`);
    }
  }
  assert.deepEqual(wrong, [], `frontend calls using the wrong verb:\n${wrong.join('\n')}`);
});

test('no two routes claim the same method and pattern', () => {
  const seen = new Map();
  for (const r of serverRoutes()) {
    const key = `${r.method} ${r.pattern}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(dupes, [], `duplicate route registrations (only the first would ever run): ${dupes.join(', ')}`);
});
