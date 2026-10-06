'use strict';
// =====================================================================
// test/audit/suite.js — THE SUITE CHECKS ITSELF FIRST
// =====================================================================
// PharmaRidge shipped a "restored test-artifact integrity check": every recovered
// test file must parse, the core entrypoints must be present, and package.json
// must be wired to them. It existed because their test suite arrived as one
// concatenated text file and had to be provably whole before anybody trusted a
// green run.
//
// StockRidge needs the same guard for a different reason, and it is the reason
// worth writing down: AN AUDIT THAT IS NOT RUN IS AN AUDIT THAT PASSES. A file
// named `audit.money.js` sitting in the tree looks like coverage. If the runner
// does not pick it up — wrong directory, a typo in the name, a `package.json`
// script that calls something else — nothing anywhere fails, and the project's
// confidence grows while its evidence does not.
//
// So this runs FIRST, is fast, and refuses the suite if:
//
//   * an audit file does not parse
//   * a file in `test/audit/` is neither an audit nor declared exempt
//   * an audit does not use the shared harness (a fourth way to run an audit)
//   * package.json does not name the runner
//   * the runner cannot see the audit the file list says exists
//   * the harness's own helpers are broken (it is exercised for real, not read)
//   * the live-target environment variables are half-set, which would send an
//     audit at a stranger's deployment with the wrong seat
//
// It is deliberately a plain script with an exit code, not a `node:test` file: it
// guards the audits, and the audits are not part of `npm test` — they need a live
// server and a database, and a suite that needs a server is a suite that stops
// being run on every commit.
// =====================================================================

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'test', 'audit');

let passed = 0;
const failures = [];
function check(what, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${what}`);
  } catch (err) {
    failures.push({ what, message: err && err.message ? err.message : String(err) });
    console.log(`  ✗ ${what}\n      ${err && err.message ? err.message : err}`);
  }
}

console.log('\nStockRidge — the audit suite checks itself');
console.log('='.repeat(64));

/** Files in test/audit/ that are not audits, with the reason. Nothing else is allowed. */
const NOT_AN_AUDIT = Object.freeze({
  'suite.js': 'this file — the guard, not an audit',
  'probe-catalog-write.js': 'a one-shot reproduction, run by hand against a named deployment with AUDIT_BASE/AUDIT_USER/AUDIT_PIN — it asserts nothing and leaves a PROBE- product behind, so it must NOT run in a suite. Declared here so the guard above still means "every file in this directory is accounted for"',
});

const files = fs.readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => e.name).sort();
const audits = files.filter((f) => /^audit\..+\.js$/.test(f));

console.log('\nEvery file in test/audit/ is accounted for');
check(`the directory holds ${audits.length} audit(s) and the guard`, () => {
  assert.ok(audits.length >= 1, 'no audit.*.js files at all');
  for (const f of files) {
    assert.ok(/^audit\..+\.js$/.test(f) || f in NOT_AN_AUDIT,
      `${f} is neither an audit (audit.<name>.js) nor listed in NOT_AN_AUDIT — a file here that nothing runs is a claim with no evidence behind it`);
  }
});

console.log('\nEvery audit parses, and uses the shared harness');
for (const file of audits) {
  const name = file.replace(/^audit\./, '').replace(/\.js$/, '');
  const full = path.join(DIR, file);
  check(`audit.${name} parses`, () => {
    const parsed = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${file} does not parse:\n${parsed.stderr}`);
  });
  check(`audit.${name} reports through the harness`, () => {
    const src = fs.readFileSync(full, 'utf8');
    assert.match(src, /require\(['"]\.\/lib\/harness['"]\)/,
      `${file} does not use test/audit/lib/harness.js. One way to report means the runner can run anything here without knowing what it does, and a reader can read the output of anything here without learning a new format.`);
    assert.match(src, /runAudit\(/, `${file} never calls runAudit(), so it has no banner, no summary and no exit code`);
    assert.match(src, /assert\./, `${file} asserts nothing`);
  });
}

console.log('\nThe harness itself works — exercised, not read');
check('the report counts a pass and a failure, and exits accordingly', () => {
  const probe = `
    const { Audit } = require(${JSON.stringify(path.join(DIR, 'lib', 'harness.js'))});
    const a = new Audit('probe');
    a.pass('a pass');
    const t = a.check('a true check', () => { if (1 !== 1) throw new Error('no'); });
    const f = a.check('a false check', () => { throw new Error('this one must fail'); });
    const r = a.report();
    if (!t || f || r.failed !== 1 || r.total !== 3) { console.error('WRONG', JSON.stringify(r)); process.exit(1); }
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.equal(res.status, 0, `the harness miscounted:\n${res.stdout}\n${res.stderr}`);
});

check('a refusal is asserted by status AND by code, not by "it failed"', async () => {
  const src = fs.readFileSync(path.join(DIR, 'lib', 'harness.js'), 'utf8');
  assert.match(src, /async refusal\(/, 'the harness has no refusal(): half of what this system does is say no, and "it said no" is an assertion');
  assert.match(src, /expectStatus/, 'refusal() does not distinguish a wrong-reason refusal from a right one');
});

console.log('\npackage.json and the runner are wired to each other');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('a script runs the audits', () => {
  const script = pkg.scripts && (pkg.scripts['test:audits'] || pkg.scripts.audits);
  assert.ok(script, 'no `test:audits` script — the audits are runnable by hand and by nothing else');
  assert.match(script, /run-audits\.sh/, `test:audits runs "${script}" rather than the runner`);
});
check('the runner exists and is executable by bash', () => {
  const runner = path.join(ROOT, 'test', 'run-audits.sh');
  assert.ok(fs.existsSync(runner), 'test/run-audits.sh is missing');
  const src = fs.readFileSync(runner, 'utf8');
  assert.match(src, /^#!\/usr\/bin\/env bash/, 'the runner has no shebang');
  assert.match(src, /--one=/, 'the runner cannot run a single audit, so a failure means re-running the whole suite');
});
check('the runner can see every audit the directory holds', () => {
  const res = spawnSync('bash', [path.join(ROOT, 'test', 'run-audits.sh'), '--list'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(res.status, 0, `--list failed:\n${res.stderr}`);
  for (const file of audits) {
    const name = file.replace(/^audit\./, '').replace(/\.js$/, '');
    assert.match(res.stdout, new RegExp(`\\b${name}\\b`),
      `the runner does not list audit.${name} — the file exists and nothing will run it`);
  }
});

console.log('\nThe live target is either set properly or not set at all');
check('AUDIT_BASE is a URL, and is accompanied by a seat', () => {
  const base = process.env.AUDIT_BASE;
  if (!base) return; // not targeting live: nothing to get wrong
  assert.match(base, /^https?:\/\//, `AUDIT_BASE="${base}" is not a URL`);
  const user = process.env.AUDIT_USER;
  assert.ok(user, 'AUDIT_BASE is set and AUDIT_USER is not — the audit would try to sign in as "admin" against somebody else\'s deployment');
  const pin = process.env.AUDIT_PIN;
  assert.ok(pin, 'AUDIT_BASE is set and AUDIT_PIN is not');
  assert.ok(!/localhost|127\.0\.0\.1/.test(base),
    'AUDIT_BASE points at localhost: that is what running without AUDIT_BASE already does, and setting it anyway suggests the wrong thing was meant');
});

console.log('\nWhat this suite cannot check, and who does');
for (const [what, who] of [
  ['that an audit asserts the RIGHT thing', 'the audit\'s own negative control, recorded in STATUS.md'],
  ['that every audit has been run against a live deployment', 'the checkpoint discipline — a green local run is not a live proof'],
  ['that a green audit is still a green audit after the code moves', 'someone running `bash test/run-audits.sh`'],
]) console.log(`  · ${what} — ${who}`);

console.log('\n' + '='.repeat(64));
if (failures.length) {
  console.log(`The audit suite is not fit to run: ${failures.length} problem(s) of ${passed + failures.length} checks`);
  for (const f of failures) console.log(`  ✗ ${f.what}\n      ${f.message}`);
  process.exit(1);
}
console.log(`Audit suite is fit to run: ${passed} checks passed, ${audits.length} audit(s) wired.`);
