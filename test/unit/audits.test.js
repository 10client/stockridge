'use strict';
// =====================================================================
// test/unit/audits.test.js — THE STATIC AUDITS ARE PART OF THE SUITE
// =====================================================================
// Three hand-written-statement and hand-written-call defects reached a running
// system in one session, and none of them was visible to the test suite, because
// the suite only exercised the routes somebody had already thought to call:
//
//   * GET  /api/catalogue/profiles  → 500  describeProfile is not defined
//   * POST /api/users               → 500  ROLES is not iterable
//   * POST /api/stocktakes          → 500  the statement has 8 placeholder(s)
//                                           but received 7 value(s)
//
// Each has a static check now. Running them as part of `npm test` is what makes
// them a guard rather than a tool somebody remembers to run before a release.
// Found here as child processes, on purpose: the tools are ALSO usable by hand,
// and a test that reimplements them would stop testing the thing people run.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function run(tool, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(ROOT, 'tools', tool), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status == null ? 1 : err.status, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

test('every hand-written INSERT has as many values as columns', () => {
  const r = run('sql-audit.js', ['--strict']);
  assert.equal(r.code, 0, `sql-audit found a structural problem:\n${r.stdout}`);
});

test('every hand-written statement binds as many values as it has placeholders', () => {
  const r = run('sql-audit.js', ['--strict']);
  assert.equal(r.code, 0, `sql-audit found a placeholder mismatch:\n${r.stdout}`);
  assert.match(r.stdout, /parameters\s+:\s+none/, 'the placeholder check must have run, not been skipped');
});

test('no function is called that its file neither imports nor declares', () => {
  const r = run('name-audit.js', ['--strict']);
  assert.equal(r.code, 0, `name-audit found a name that is never defined:\n${r.stdout}`);
});

test('every service is called with the option keys it actually reads', () => {
  const r = run('service-args-audit.js');
  assert.equal(r.code, 0, `service-args-audit found a mismatched call:\n${r.stdout}`);
  assert.match(r.stdout, /OK/, 'the options audit must have run');
});

// The fourth check — that every /api path the BROWSER calls exists on the server,
// and that no route is registered twice — lives in test/e2e/frontend-routes.js.
// It is a test rather than a tool because it compares two things that only exist
// in this repository, and it needs a stub app instance to read the route table.
