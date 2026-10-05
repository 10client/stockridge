'use strict';
// =====================================================================
// tools/frontend-smoke.js — RUN THE REAL FRONTEND AND LOOK AT IT
// =====================================================================
// Every other test in this repository asks whether the API behaves. This one asks
// whether a PERSON can use the app: it loads `public/index.html` in a DOM, runs
// the real scripts in the real order, signs in against a real server, and reports
// what the browser would show.
//
// WHY IT EXISTS
//
// A defect lived in the frontend for as long as the frontend has existed and no
// test could see it:
//
//   SR.state = Object.assign(state, { businesses, branches, … })   // functions
//   state.branches = data.branches;                                // ARRAY again
//
// so `SR.state.branches()` threw the moment a session loaded. `app.js` calls it
// inside `paintIdentity()`, and `showShell()` ran that BEFORE `buildNav()`, so
// the shell rendered with an EMPTY SIDEBAR for every role on every deployment.
// The API was perfect throughout. 272 tests passed.
//
// Static frontend tests check that views and routes exist. They cannot see a key
// that is silently both an array and a function. Only running it can.
//
// REQUIREMENT
//
// jsdom, which is deliberately NOT a dependency of this project — it is a
// development instrument, and the application itself ships with no build step.
// Install it when you need this tool:
//
//   npm install --no-save jsdom fake-indexeddb
//
// USAGE
//   node tools/frontend-smoke.js --url=https://sample.stockridge.workers.dev \
//     --user=admin --pin=48213
//
//   node tools/frontend-smoke.js --url=http://localhost:8787 --all-roles
//
// Options
//   --url=      server origin (default http://localhost:8787)
//   --user= --pin=   one sign-in to check
//   --all-roles      sign in as ADMIN, OWNER, MANAGER and STAFF in turn, using the
//                    demo deployment's credentials (they exist only in a seeded
//                    development database)
//   --expect-nav=N   fail unless the nav has at least N items (default 1)
//
// Exit code is 0 only when every check passed.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = String(flag('url', 'http://localhost:8787')).replace(/\/$/, '');
const EXPECT_NAV = Number(flag('expect-nav', 1));

/** The demo deployment's seats. Only a seeded development database has these. */
const DEMO_SEATS = [
  { label: 'ADMIN', username: 'admin', pin: '90210' },
  { label: 'OWNER', username: 'owner', pin: '48213' },
  { label: 'MANAGER', username: 'emeka', pin: '73914' },
  { label: 'STAFF', username: 'blessing', pin: '26480' },
];

function loadJsdom() {
  try {
    // eslint-disable-next-line global-require
    return { JSDOM: require('jsdom').JSDOM, VirtualConsole: require('jsdom').VirtualConsole };
  } catch (err) {
    console.error('\n  This tool needs jsdom, which is not a dependency of the project:\n');
    console.error('      npm install --no-save jsdom fake-indexeddb\n');
    process.exit(2);
  }
}

/**
 * Boot the real frontend against `origin` and report what the user would see.
 *
 * Everything here exists because the app genuinely needs it to start: the offline
 * store is IndexedDB, the theme asks matchMedia, and the scripts are plain
 * <script> tags with no bundler and no module system.
 */
async function inspect({ origin, username, pin }) {
  const { JSDOM, VirtualConsole } = loadJsdom();
  const logs = [];
  const vc = new VirtualConsole();
  for (const level of ['error', 'warn', 'log']) vc.on(level, (...a) => logs.push(`[${level}] ${a.join(' ').slice(0, 220)}`));

  // Sign in out of band, so the page boots the way a returning user's does.
  const login = await (await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  })).json();
  if (!login.token) return { ok: false, reason: `sign-in failed: ${JSON.stringify(login).slice(0, 160)}`, logs };

  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), {
    url: `${origin}/`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  });
  const { window } = dom;

  // The gaps jsdom leaves, none of which are application bugs.
  const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
  window.indexedDB = indexedDB;
  window.IDBKeyRange = IDBKeyRange;
  if (!window.structuredClone) window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  if (!window.matchMedia) {
    window.matchMedia = (q) => ({
      matches: false, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    });
  }
  window.scrollTo = () => {};

  // Send the page's requests to the real server, with its token attached.
  const realFetch = globalThis.fetch;
  window.fetch = (url, init = {}) => {
    const u = String(url).startsWith('http') ? String(url) : `${origin}/${String(url).replace(/^\//, '')}`;
    const headers = Object.assign({}, init.headers || {});
    if (/\/api\//.test(u) && !headers.Authorization && window.SR && window.SR.api && window.SR.api.token) {
      headers.Authorization = `Bearer ${window.SR.api.token}`;
    }
    return realFetch(u, { ...init, headers });
  };
  window.localStorage.setItem('sr.token', login.token);

  // Load the page's own scripts, in the page's own order. Reading the order from
  // the HTML is the point: a script the page forgets to include is exactly the
  // kind of thing this tool should notice.
  const scripts = [...window.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  const missing = [];
  for (const src of scripts) {
    const file = path.join(PUBLIC_DIR, src.replace(/^\//, ''));
    if (!fs.existsSync(file)) { missing.push(src); continue; }
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(file, 'utf8');
    window.document.body.appendChild(el);
  }

  await new Promise((r) => { setTimeout(r, 6000); });

  const nav = window.document.getElementById('nav-list');
  const items = nav ? [...nav.querySelectorAll('.nav-item')].map((b) => b.textContent.trim()) : [];
  const boot = window.document.getElementById('boot');
  const bootLine = boot ? boot.textContent.replace(/\s+/g, ' ').trim() : '';
  const view = window.document.getElementById('view');
  const state = window.SR && window.SR.state;

  return {
    ok: true,
    role: state && state.user ? state.user.role : null,
    username: state && state.user ? state.user.username : null,
    navItems: items,
    bootLine,
    bootFailed: /failed to start/i.test(bootLine),
    viewText: view ? view.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) : '',
    // The precise thing that was broken: an accessor that stops being callable.
    accessors: state ? {
      branches: typeof state.branches, businesses: typeof state.businesses,
      activeBranch: typeof state.activeBranch, activeBusiness: typeof state.activeBusiness,
      branchesFor: typeof state.branchesFor,
    } : null,
    missing,
    logs,
  };
}

function report(seat, result) {
  const problems = [];
  if (!result || !result.ok) return [`${seat.label}: ${result && result.reason ? result.reason : 'did not boot'}`];
  if (result.missing.length) problems.push(`${seat.label}: script(s) referenced by index.html are missing: ${result.missing.join(', ')}`);
  if (!result.username) problems.push(`${seat.label}: the app never loaded a session (still on the login screen?)`);
  if (result.bootFailed) problems.push(`${seat.label}: the boot screen reports a failure — ${result.bootLine.slice(0, 200)}`);
  if (result.navItems.length < EXPECT_NAV) {
    problems.push(`${seat.label}: the navigation has ${result.navItems.length} item(s), expected at least ${EXPECT_NAV}`);
  }
  for (const [name, kind] of Object.entries(result.accessors || {})) {
    if (kind !== 'function') problems.push(`${seat.label}: SR.state.${name} is ${kind}, not a function — this is what empties the sidebar`);
  }

  const mark = problems.length ? '  ✗' : '  ✓';
  console.log(`${mark} ${seat.label} (${seat.username})`);
  console.log(`      nav ${result.navItems.length}: ${result.navItems.join(' · ') || '(EMPTY)'}`);
  console.log(`      view: ${result.viewText || '(empty)'}`);
  if (problems.length) for (const p of problems) console.log(`      ${p}`);

  // A failed boot usually explains itself in the page's own console.
  const errors = (result.logs || []).filter((l) => l.startsWith('[error]') || l.startsWith('[warn]'));
  if (errors.length) for (const e of errors.slice(0, 5)) console.log(`      ${e}`);

  return problems;
}

(async () => {
  console.log('StockRidge — frontend smoke');
  console.log(`  ${BASE}`);
  console.log('──────────────────────────────────────────────────────────');

  const seats = has('all-roles')
    ? DEMO_SEATS
    : [{ label: 'default', username: flag('user', 'admin'), pin: flag('pin') }];

  if (seats.some((s) => !s.pin)) {
    console.error('\n  --pin is required (or use --all-roles against a seeded demo deployment).\n');
    process.exit(2);
  }

  const problems = [];
  for (const seat of seats) {
    let result = null;
    try {
      result = await inspect({ origin: BASE, username: seat.username, pin: seat.pin });
    } catch (err) {
      result = { ok: false, reason: `the harness itself threw: ${err && err.message}` };
    }
    problems.push(...report(seat, result));
  }

  console.log('──────────────────────────────────────────────────────────');
  if (problems.length) {
    console.log(`${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(`${seats.length} seat(s) checked, no problems.`);
  }
  console.log('');
  process.exit(problems.length ? 1 : 0);
})();
