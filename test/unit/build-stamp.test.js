'use strict';
// =====================================================================
// test/unit/build-stamp.test.js — THE FIX MUST BE IN THE FILE THE BROWSER LOADS
// =====================================================================
// THE DEFECT THIS EXISTS FOR, reported from staging:
//
//     "on staging i tried to receive a purchase order of an iphone then this was the message
//      '…is serial-tracked, so each unit needs its own serial number: 10 expected … 0 given.'
//      why is this i dont see a place for inputing the serial numbers"
//
// The serial box had been built, committed and deployed. Staging's API answered
// `requires_serial: 1` for that very line and the deployed worker served the fixed file — but the
// screen was built from the PREVIOUS `purchase-orders.js`, because the service worker serves /js
// STALE-WHILE-REVALIDATE under its bare path: the cached copy goes out immediately and the new file
// only lands in the cache for the load after that. On a till that is never reloaded twice, the
// "next load" never comes, and a shipped fix looks like a fix that never happened.
//
// The cure is the one this project already reached for twice: the build stamp. Not only as a
// constant inside two files, but ON EVERY ASSET URL — `purchase-orders.js?v=ridge-…`. A URL carrying
// this deploy's stamp cannot be answered out of a cache keyed by the last one, so the new files
// arrive on the FIRST load after the deploy, even when an older worker is still in control.
//
// These tests are the guard on that. Every one of them runs the tool against a THROWAWAY COPY of the
// tree: stamping writes the current minute into the files, so running it here would leave the real
// ones carrying a stamp nobody deployed — a test that dirties the tree it is testing is worse than
// no test.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'public', 'index.html');
const SW = path.join(ROOT, 'public', 'sw.js');
const APP = path.join(ROOT, 'public', 'js', 'app.js');

const URL_STAMP = /[?&]v=(ridge-[0-9]{8}-[0-9]{4}-[0-9a-z]+)/;

/** Every local script/style the page names. */
function assetUrls(html) {
  return (html.match(/(?:src|href)="\/(?:js|css)\/[^"]+"/g) || []).map((t) => t.slice(8, -1));
}

/** A copy of the pieces `stamp-build` writes, in a temp directory. */
function fakeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-build-'));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(path.join(root, 'public', 'js'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'stamp-build.js'), path.join(root, 'tools', 'stamp-build.js'));
  fs.copyFileSync(INDEX, path.join(root, 'public', 'index.html'));
  fs.copyFileSync(SW, path.join(root, 'public', 'sw.js'));
  fs.copyFileSync(APP, path.join(root, 'public', 'js', 'app.js'));
  return { dir, root };
}

function run(root, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'tools', 'stamp-build.js'), ...args], { cwd: root, encoding: 'utf8' });
}

test('every script and stylesheet the page names carries a build stamp', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const urls = assetUrls(html);
  assert.ok(urls.length > 30, `expected the page to name its whole bundle, found ${urls.length} asset(s)`);
  const bare = urls.filter((u) => !URL_STAMP.test(u));
  assert.equal(bare.length, 0,
    `${bare.length} asset URL(s) carry no stamp, starting with ${bare[0]} — those can be answered from the previous deploy's cache`);
});

test('the service worker precaches the same stamped URLs the page asks for', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const sw = fs.readFileSync(SW, 'utf8');
  const shell = (/const SHELL = \[([\s\S]*?)\];/.exec(sw) || [])[1] || '';
  const precached = shell.match(/'\/(?:js|css)\/[^']*'/g) || [];
  assert.ok(precached.length > 30, `expected the shell list to hold the bundle, found ${precached.length}`);

  const pageStamps = new Set(assetUrls(html).map((u) => (URL_STAMP.exec(u) || [])[1]));
  const shellStamps = new Set(precached.map((u) => (URL_STAMP.exec(u) || [])[1]));
  assert.equal(pageStamps.size, 1, `the page names ${pageStamps.size} different stamps — a half-updated bundle`);
  assert.equal(shellStamps.size, 1, `the precache list names ${shellStamps.size} different stamps`);
  // Offline is the point of the precache: a device that loads the new page offline must ask for
  // URLs that are already stored. Different stamps would mean the offline shell is the last build.
  assert.deepEqual([...shellStamps], [...pageStamps],
    'the page and the precache list disagree about the build — an offline load would mix two builds');
});

test('the page, the worker and the app all carry the same stamp', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const sw = fs.readFileSync(SW, 'utf8');
  const app = fs.readFileSync(APP, 'utf8');
  const fromHtml = (URL_STAMP.exec(html) || [])[1];
  const fromSw = (/const BUILD = '([^']+)';/.exec(sw) || [])[1];
  const fromApp = (/SR\.BUILD = '([^']+)';/.exec(app) || [])[1];
  assert.ok(fromHtml && fromSw && fromApp, `a file is missing its stamp: html=${fromHtml} sw=${fromSw} app=${fromApp}`);
  assert.equal(fromHtml, fromSw, `the page names ${fromHtml} and the service worker is ${fromSw}`);
  assert.equal(fromSw, fromApp, `the service worker is ${fromSw} and the app is ${fromApp}`);
});

test('the stamp is the deploy identity, and re-stamping is idempotent', () => {
  const { buildStamp } = require(path.join(ROOT, 'tools', 'stamp-build'));
  assert.match(buildStamp(new Date('2026-10-07T14:34:00Z')), /^ridge-20261007-1434-[0-9a-z]+$/,
    'the stamp is the deploy\'s minute and commit — the thing that makes an old URL unreachable');

  const { dir, root } = fakeTree();
  try {
    const page = path.join(root, 'public', 'index.html');
    const before = fs.readFileSync(page, 'utf8');
    const first = run(root);
    assert.equal(first.status, 0, `stamp-build failed: ${first.stdout}${first.stderr}`);
    const afterOne = fs.readFileSync(page, 'utf8');
    const second = run(root);
    assert.equal(second.status, 0, `stamp-build failed on the second run: ${second.stdout}${second.stderr}`);
    const afterTwo = fs.readFileSync(page, 'utf8');

    assert.ok(!/\?v=[^"']*\?v=/.test(afterTwo), 'a URL carries two stamps — the replacement is not idempotent');
    assert.equal((afterTwo.match(/\?v=/g) || []).length, (before.match(/\?v=/g) || []).length,
      'stamping changed the number of stamped URLs — a URL was added or lost');
    // The second run stands in for the next deploy: re-stamping everything must leave the whole
    // tree consistent, which is what the deploy relies on.
    const check = run(root, ['--check']);
    assert.equal(check.status, 0, `after two runs the tree is inconsistent:\n${check.stdout}${check.stderr}`);
    assert.match(check.stdout, /all say ridge-/, `--check did not report agreement: ${check.stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--check refuses a tree whose page and worker disagree', () => {
  const clean = run(ROOT, ['--check']);
  assert.equal(clean.status, 0, `the checked-in tree is not consistent:\n${clean.stdout}${clean.stderr}`);

  // And it can fail: an unstamped page is exactly the state that produced the report.
  const { dir, root } = fakeTree();
  try {
    const page = path.join(root, 'public', 'index.html');
    const html = fs.readFileSync(page, 'utf8');
    const stripped = html.replace(/\?v=ridge-[0-9a-z-]+/g, '');
    assert.notEqual(stripped, html, 'the page carried no stamp to strip — the earlier tests would have caught this');
    fs.writeFileSync(page, stripped);

    const res = run(root, ['--check']);
    assert.notEqual(res.status, 0, 'stamp-build --check passed a page with no stamps on its assets');
    assert.match(`${res.stdout}${res.stderr}`, /no build stamp/i,
      `the refusal does not say what is wrong: ${res.stdout}${res.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a running screen is told when the server has moved on', () => {
  // The other half of the cure: the page cannot reload itself the moment a deploy lands, so it has
  // to notice and say so. `app.js` asks `/sw.js` — the one file that carries the stamp and is never
  // served from the app's own cache — and offers the reload rather than performing it.
  const app = fs.readFileSync(APP, 'utf8');
  assert.match(app, /function liveBuild\(/, 'the app no longer asks what build the server is serving');
  assert.match(app, /fetch\('\/sw\.js', \{ cache: 'no-store' \}\)/, 'the build check must bypass the HTTP cache or it proves nothing');
  assert.match(app, /function offerNewBuild\(/, 'nothing offers the reload when a new build is live');
  assert.match(app, /reload to use it/i, 'the offer does not say what the reload is for');
  assert.match(app, /setInterval\(\(\) => \{ void offerNewBuild\(\); \}, 10 \* 60 \* 1000\)/,
    'the running screen never asks again after the first check');
  assert.match(app, /liveBuild, offerNewBuild,/, 'the build check is not reachable from the app object');
});
