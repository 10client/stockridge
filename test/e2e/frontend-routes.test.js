'use strict';
// =====================================================================
// test/e2e/frontend-routes.test.js — EVERY CALL THE APP MAKES MUST EXIST
// =====================================================================
// This test exists because of a bug that no amount of careful reading would
// have caught.
//
// `public/js/views/suppliers.js` called `GET /api/suppliers/:id` for its detail
// screen. The route did not exist. The screen was written, reviewed, committed
// and never opened against a real server — and when it finally was, the user
// got "No such route" on a page that looked finished.
//
// The frontend and the backend are two halves of one contract written in two
// different files by the same hand, and nothing made them agree. This test makes
// them agree: it reads every API call the browser code contains, reads every
// route the server registers, and fails with the file, the line and the source
// text of any call the server cannot answer.
//
// It deliberately does NOT send requests. A request cannot distinguish "route
// missing" from "you sent no body" without a fake database that reimplements
// half the app, and a test that needs maintenance every time a handler changes
// stops being run. A static comparison of the two route tables has no such
// failure mode: it is either a real route or it is not.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createHttpApp } = require('../../server/app');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_JS = path.join(ROOT, 'public', 'js');
const TOOLS = path.join(ROOT, 'tools');

/** Every .js file under public/js, recursively. */
function jsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Build the app's route table with a stub database.
 *
 * Registration does not touch the database — that only happens when a handler
 * runs — so a stub is enough, and it keeps this test independent of migrations
 * and seeding.
 */
function registeredRoutes() {
  const stub = {
    all: async () => [],
    first: async () => null,
    run: async () => ({}),
    scalar: async () => 0,
    transaction: async (fn) => fn({
      queue() {}, idFor: () => 'x', run: async () => ({}), first: async () => null, all: async () => [],
    }),
  };
  const app = createHttpApp({ db: stub, jwtSecret: 'route-contract', settings: {} });
  return app.routes.map((r) => ({ method: r.method.toUpperCase(), pattern: r.pattern }));
}

/**
 * Pull every `/api/...` call out of the browser code.
 *
 * Handles the four shapes the app actually uses:
 *   SR.api.get('/api/sales', { … })
 *   SR.api.post(`/api/tills/${id}/close`)
 *   SR.api.del('/api/products/' + id)
 *   SR.api.request('GET', '/api/health')
 *
 * A template placeholder becomes `*`, which matches exactly one path segment —
 * the same thing the server's `:param` matches.
 */
function apiCalls() {
  const calls = [];
  for (const file of jsFiles(PUBLIC_JS)) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');

    const patterns = [
      /SR\.api\.(get|post|put|patch|del)\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g,
      /SR\.api\.request\s*\(\s*'([A-Z]+)'\s*,\s*(`[^`]*`|'[^']*'|"[^"]*")/g,
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(source)) !== null) {
        const isRequest = re.source.includes('request');
        // `SR.api.del` is DELETE on the wire. Uppercasing the helper's own name
        // produced "DEL", which matches no route the server registers — so the
        // first view to use the helper looked like a call to a route that does not
        // exist. The helper names and the HTTP verbs are not the same vocabulary.
        const HELPER_VERB = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };
        const method = isRequest ? String(m[1]).toUpperCase() : (HELPER_VERB[m[1]] || String(m[1]).toUpperCase());
        const raw = isRequest ? m[2] : m[2];
        const line = source.slice(0, m.index).split('\n').length;
        const literal = raw.slice(1, -1);
        if (!literal.startsWith('/api')) continue;
        // `${…}` in a template literal is one segment of unknown content.
        // A QUERY STRING IS NOT PART OF A ROUTE PATH: `/thing?branch_id=7` is the
        // route `/thing` with a parameter, and comparing the two as strings
        // reports a route that plainly exists as missing. (It did — for
        // `/api/products/:id/price-override?branch_id=…`.)
        const pattern = literal.replace(/\?[^`]*$/, '').replace(/\$\{[^}]*\}/g, '*');
        calls.push({
          method,
          pattern,
          literal,
          file: path.relative(ROOT, file),
          line,
          source: (lines[line - 1] || '').trim(),
        });
      }
    }
  }
  return calls;
}

/** Does a registered pattern match a call pattern, segment for segment? */
function matches(serverPattern, callPattern) {
  const a = serverPattern.split('/');
  const b = callPattern.split('/');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const s = a[i];
    const c = b[i];
    if (s === '*') return true;                 // splat swallows the rest
    if (s === undefined || c === undefined) return false;
    if (s.startsWith(':')) continue;            // exactly one segment, any value
    if (c === '*') continue;                    // a value the client composes
    if (s.toLowerCase() !== c.toLowerCase()) return false;
  }
  return true;
}

test('every /api call in the browser code has a route on the server', () => {
  const routes = registeredRoutes();
  const calls = apiCalls();

  assert.ok(calls.length > 80, `expected the frontend to make more than 80 API calls, found ${calls.length}`);

  const missing = [];
  for (const call of calls) {
    const hit = routes.some((r) => r.method === call.method && matches(r.pattern, call.pattern));
    if (!hit) missing.push(call);
  }

  assert.deepEqual(
    missing.map((c) => `${c.file}:${c.line}  ${c.method} ${c.pattern}\n      ${c.source}`),
    [],
    'the browser calls API routes the server does not register',
  );
});

test('no route is registered twice — a later registration is dead code', () => {
  const routes = registeredRoutes();
  const seen = new Map();
  const duplicates = [];
  for (const r of routes) {
    const key = `${r.method} ${r.pattern}`;
    if (seen.has(key)) duplicates.push(key);
    else seen.set(key, true);
  }
  assert.deepEqual(duplicates, [], 'two modules register the same method and path; only the first can ever run');
});

test('every view the router can reach is implemented', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const views = new Set();
  for (const m of app.matchAll(/view:\s*'([a-z0-9-]+)'/g)) views.add(m[1]);

  const missing = [];
  for (const name of views) {
    const file = path.join(PUBLIC_JS, 'views', `${name}.js`);
    if (!fs.existsSync(file)) { missing.push(`${name} (no public/js/views/${name}.js)`); continue; }
    const source = fs.readFileSync(file, 'utf8');
    const exportName = name.replace(/-/g, '');
    // The registration key must match what the router looks up.
    if (!new RegExp(`SR\\.views\\.${name.replace(/-/g, '\\-')}\\s*=`).test(source)
      && !new RegExp(`SR\\.views\\[['"]${name}['"]\\]\\s*=`).test(source)) {
      missing.push(`${name} (registered as something else — the router calls SR.views.${name}, but the file never assigns it${exportName !== name ? `; note the hyphen: "${name}" is not "${exportName}"` : ''})`);
    }
  }
  assert.deepEqual(missing, [], 'the router can navigate to a view that is not implemented');
});

test('every view file is syntactically valid JavaScript', () => {
  const viewDir = path.join(PUBLIC_JS, 'views');
  const broken = [];
  for (const file of fs.readdirSync(viewDir).filter((f) => f.endsWith('.js'))) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(fs.readFileSync(path.join(viewDir, file), 'utf8'));
    } catch (e) {
      broken.push(`${file}: ${e.message}`);
    }
  }
  assert.deepEqual(broken, [], 'a view file does not parse — the browser would fail to load it');
});

test('no screen wraps its payload in { body: … }', () => {
  // THE DEFECT CLASS, found by building one instance of it and then looking for
  // its siblings.
  //
  // `SR.api.post(path, payload)` takes the payload as the SECOND argument:
  //
  //     const post = (path, body, opts) => request('POST', path, Object.assign({ body }, opts));
  //
  // so `SR.api.post('/api/thing', { body: { id: 7 } })` sends the JSON
  // `{"body":{"id":7}}` — and the server, reading `body.id`, sees nothing and
  // answers "id is required". The screen looks finished, the code reads plausibly,
  // and the flow has never worked.
  //
  // SEVEN screens were doing this: changing your own PIN, marking a WHT entry as
  // remitted, adding a ledger account, creating and editing a branch, editing a
  // business, and a manager's till review. Proved live before fixing: the wrapped
  // PIN change answered "Current PIN is required", while the plain one reached the
  // real validation ("PIN cannot be one repeated digit").
  //
  // Written as a small parser rather than a regex, because a regex spanning the
  // file happily matched a `body:` belonging to a LATER call and reported eight
  // perfectly good multi-line calls as offenders.
  const offenders = [];
  for (const file of jsFiles(PUBLIC_JS)) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    const call = /SR\.api\.(post|put|patch)\s*\(/g;
    let m;
    while ((m = call.exec(source)) !== null) {
      // Walk to the matching close paren, so only THIS call's arguments are read.
      let i = m.index + m[0].length;
      let depth = 1;
      let inString = null;
      while (i < source.length && depth > 0) {
        const ch = source[i];
        if (inString) {
          if (ch === '\\') i += 1;
          else if (ch === inString) inString = null;
        } else if (ch === '`' || ch === '\'' || ch === '"') inString = ch;
        else if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        i += 1;
      }
      const args = source.slice(m.index + m[0].length, i - 1);
      // The SECOND argument is what carries the payload: everything between the
      // first top-level comma and the end.
      let depth2 = 0; let splitAt = -1; let q = null;
      for (let j = 0; j < args.length; j += 1) {
        const ch = args[j];
        if (q) { if (ch === '\\') j += 1; else if (ch === q) q = null; continue; }
        if (ch === '`' || ch === '\'' || ch === '"') { q = ch; continue; }
        if (ch === '(' || ch === '{' || ch === '[') depth2 += 1;
        else if (ch === ')' || ch === '}' || ch === ']') depth2 -= 1;
        else if (ch === ',' && depth2 === 0) { splitAt = j; break; }
      }
      if (splitAt === -1) continue;
      const second = args.slice(splitAt + 1).trim();
      if (!/^\{\s*body\s*:/.test(second)) continue;
      const line = source.slice(0, m.index).split('\n').length;
      offenders.push(`${path.relative(ROOT, file)}:${line}  ${(lines[line - 1] || '').trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'these send {"body":{…}} to the server, so the fields inside never arrive:\n  ' + offenders.join('\n  ')
    + '\n    pass the payload directly: SR.api.post(path, payload) — the option object is for SR.api.request',
  );
});


test('no tool wraps its payload in { body: … } either', () => {
  // The same defect as the test above, in the tools rather than the screens — and
  // it was found the only way it could be: `tools/frontend-access.js`, the probe
  // written TO CATCH this class, created its second business as
  // `api('POST', '/api/businesses', { body: { name: … } })`, and the live run
  // answered `400 {"error":"name is required.","code":"MISSING_FIELD"}`.
  //
  // The screens have `SR.api.post|put|patch`, a fixed set of names, so the check
  // above is a list. Tools each bring their own helper, so this one reads the
  // helpers out of the file first: a function whose body JSON-stringifies a
  // parameter called `body` takes the payload as that parameter, and a call that
  // wraps the payload in a `body` KEY hands it a lie.
  //
  // Proved to fire before being trusted: reintroducing the wrapper in a copy of
  // the probe is reported at the exact line.
  const offenders = [];
  const files = [...jsFiles(PUBLIC_JS), ...jsFiles(TOOLS)];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // Which names in this file take the payload directly?
    const helpers = new Set();
    for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g)) {
      const tail = source.slice(m.index + m[0].length, m.index + m[0].length + 700);
      if (/JSON\.stringify\(\s*body\s*\)/.test(tail)) helpers.add(m[1]);
    }
    for (const name of helpers) {
      const call = new RegExp(`\\b${name}\\s*\\(`, 'g');
      let m;
      while ((m = call.exec(source)) !== null) {
        const open = m.index + m[0].length - 1;
        let i = open + 1; let depth = 1; let q = null;
        while (i < source.length && depth > 0) {
          const ch = source[i];
          if (q) { if (ch === '\\') i += 1; else if (ch === q) q = null; }
          else if (ch === '`' || ch === "'" || ch === '"') q = ch;
          else if (ch === '(') depth += 1;
          else if (ch === ')') depth -= 1;
          i += 1;
        }
        const args = source.slice(open + 1, i - 1);
        // Only the LAST argument is the payload for these helpers; an earlier one
        // is a method or a path.
        let depth2 = 0; let q2 = null; let last = 0;
        for (let j = 0; j < args.length; j += 1) {
          const ch = args[j];
          if (q2) { if (ch === '\\') j += 1; else if (ch === q2) q2 = null; continue; }
          if (ch === '`' || ch === "'" || ch === '"') { q2 = ch; continue; }
          if ('{(['.includes(ch)) depth2 += 1;
          else if (')}]'.includes(ch)) depth2 -= 1;
          else if (ch === ',' && depth2 === 0) last = j + 1;
        }
        const payload = args.slice(last).trim();
        if (!/^\{\s*body\s*:/.test(payload)) continue;
        const line = source.slice(0, m.index).split('\n').length;
        const text = (source.split('\n')[line - 1] || '').trim().slice(0, 100);
        offenders.push(`${path.relative(ROOT, file)}:${line}  ${name}(…)  ${text}`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'these tools send {"body":{…}}, so the fields inside never arrive:\n  ' + offenders.join('\n  ')
    + '\n    pass the payload directly, the way the helper takes it',
  );
});
