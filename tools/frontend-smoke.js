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
//   npm install --no-save jsdom@29.1.1 fake-indexeddb@6.2.5
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
//   --dump           print the DOM state, the visible screen and the page's own
//                    console, for working out WHY a seat did not render
//   --wait=N         ms to wait for the app to settle (default 30000). The tool
//                    polls; it does not sleep a fixed time and hope.
//   --walk           open every destination in the navigation, in turn, and report
//                    what each screen renders. Catches a view that throws behind a
//                    working sidebar.
//
// Exit code is 0 only when every check passed.
// =====================================================================

// The booting itself lives in tools/lib/page-harness.js, shared with
// tools/frontend-sale.js. This file is only about what to look at afterwards.
const H = require('./lib/page-harness.js');

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

/**
 * Does this screen's own error message describe a FAULT rather than a refusal?
 *
 * A refusal is the app working: "Open a till first", "Only an owner can see this".
 * A fault is the app broken: a null dereference, an undefined function, a value
 * that was never there. Both render as a red block with the same heading, so the
 * difference has to be read out of the text.
 *
 * This test exists because a fault hid behind that heading. The Subscription
 * screen read `activeBusiness().name` for its subtitle, which is null on any
 * deployment that has no business yet — so it threw, rendered "That failed.
 * Cannot read properties of null (reading 'name')", and the walk called it a
 * deliberate refusal and moved on. A screen that cannot draw itself is never
 * deliberate, and it must not be able to pass a walk.
 */
const FAULT_TEXT = /cannot read propert|is not a function|is not defined|of undefined|of null|undefined is not|not iterable|before initialization|out of range|Invalid time value|Cannot convert/i;
function isFault(alertText) {
  return Boolean(alertText) && FAULT_TEXT.test(alertText);
}

/**
 * Boot the real frontend against `origin` and report what the user would see.
 *
 * The booting is the harness's job (tools/lib/page-harness.js). What is left here
 * is the part that is specific to this tool: what the DOM looks like once it is up.
 */
async function inspect({ origin, username, pin }) {
  const page = await H.bootPage({
    origin, username, pin, waitMs: Number(flag('wait', 30000)),
  });
  if (!page.ok) return { ok: false, reason: page.reason, logs: page.logs };

  const { window, logs, missing, settleMs, settled } = page;
  if (settled.state !== 'ready') {
    logs.push(`[wait] gave up: ${settled.items || 0} nav item(s), view ${settled.viewChars || 0} char(s)`);
  }

  const nav = window.document.getElementById('nav-list');
  const items = nav ? [...nav.querySelectorAll('.nav-item')].map((b) => b.textContent.trim()) : [];

  // -------------------------------------------------------------------
  // --walk: visit every destination and see what comes up
  // -------------------------------------------------------------------
  // The shell rendering proves the navigation EXISTS. It says nothing about
  // whether the 25 screens behind it render — a view that throws on open would
  // still leave a perfect sidebar. This clicks each one, waits for the view to
  // settle, and reports what a person would see.
  //
  // A screen whose view stays EMPTY, or whose render throws, is a defect. A
  // screen that deliberately refuses ("open a till first") is not: it rendered,
  // and it told the truth. Both are reported; only the first counts as a problem.
  const walk = [];
  if (has('walk') && nav) {
    for (const btn of [...nav.querySelectorAll('.nav-item')]) {
      const label = btn.textContent.trim();
      const path = btn.dataset ? btn.dataset.path : '';
      const logStart = logs.length;
      const started = Date.now();
      let thrown = null;
      try {
        btn.click();
      } catch (err) {
        thrown = String((err && err.message) || err);
      }
      // Settle: non-empty text that has stopped changing.
      const deadline = Date.now() + 15000;
      let text = '';
      let stableSince = 0;
      while (!thrown && Date.now() < deadline) {
        const v = window.document.getElementById('view');
        const now = v ? v.textContent.replace(/\s+/g, ' ').trim() : '';
        if (now.length > 0 && now === text) {
          if (Date.now() - stableSince > 400) break;
        } else {
          text = now;
          stableSince = Date.now();
        }
        await new Promise((r) => { setTimeout(r, 250); });
      }
      const view = window.document.getElementById('view');
      const alert = view ? view.querySelector('.alert-danger') : null;
      walk.push({
        label,
        path,
        ms: Date.now() - started,
        chars: text.length,
        snippet: text.slice(0, 90),
        alert: alert ? alert.textContent.replace(/\s+/g, ' ').trim().slice(0, 110) : null,
        newLogs: logs.slice(logStart).filter((l) => l.startsWith('[error]')).slice(0, 2),
        thrown,
      });
    }
    // Leave the app where it was, so the boot report describes the same screen.
    if (nav.querySelector('.nav-item')) nav.querySelector('.nav-item').click();
    await new Promise((r) => { setTimeout(r, 1500); });
  }
  const boot = window.document.getElementById('boot');
  const bootLine = boot ? boot.textContent.replace(/\s+/g, ' ').trim() : '';
  const view = window.document.getElementById('view');
  const state = window.SR && window.SR.state;

  // A snapshot of what the user is actually looking at. `--dump` prints it; it is
  // the difference between "the navigation is empty" and knowing WHY it is empty.
  const dump = {
    title: window.document.title,
    bodyText: window.document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 600),
    // Which top-level screen is visible, and whether the app considers itself
    // past the login screen at all.
    screens: ['login', 'shell', 'boot'].map((id) => {
      const el = window.document.getElementById(id);
      if (!el) return `${id}: absent`;
      const style = el.getAttribute('style') || '';
      return `${id}: ${el.classList.contains('hidden') ? 'hidden' : 'shown'}${style ? ` (${style.slice(0, 60)})` : ''}`;
    }),
    settleMs,
    navListPresent: !!nav,
    viewPresent: !!view,
    location: window.location.pathname,
    srKeys: window.SR ? Object.keys(window.SR).join(',') : '(no SR)',
    sessionUser: state && state.user ? { role: state.user.role, branch: state.user.branch || null } : null,
  };

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
    walk,
    dump,
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

  if (has('dump')) {
    console.log('  ── dump ──');
    for (const [k, v] of Object.entries(result.dump || {})) {
      console.log(`      ${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`);
    }
    console.log('      logs:');
    for (const l of (result.logs || []).slice(-12)) console.log(`        ${l}`);
    console.log('  ──────────');
  }

  const mark = problems.length ? '  ✗' : '  ✓';
  console.log(`${mark} ${seat.label} (${seat.username})`);
  console.log(`      nav ${result.navItems.length}: ${result.navItems.join(' · ') || '(EMPTY)'}`);
  console.log(`      view: ${result.viewText || '(empty)'}`);
  if (problems.length) for (const p of problems) console.log(`      ${p}`);

  if (result.walk && result.walk.length) {
    console.log(`      walk: ${result.walk.length} destination(s)`);
    for (const w of result.walk) {
      // Empty view, a throw, or a console error is a dead screen. A deliberate
      // refusal is not — it rendered, and it explained itself.
      const dead = w.thrown || w.chars === 0;
      const mark = dead ? '✗' : w.alert ? '!' : '·';
      console.log(`        ${mark} ${w.label.padEnd(18)} ${String(w.chars).padStart(5)} char  ${w.snippet || '(nothing rendered)'}`);
      if (w.thrown) console.log(`            threw: ${w.thrown}`);
      if (w.alert) console.log(`            says : ${w.alert}`);
      for (const l of w.newLogs || []) console.log(`            ${l}`);
      if (dead) problems.push(`${seat.label}: the ${w.label} screen rendered nothing${w.thrown ? ` (${w.thrown})` : ''}`);
      // A screen that drew an error block because IT broke, rather than because it
      // refused to do what was asked, is a defect — and it used to pass unnoticed.
      if (!dead && isFault(w.alert)) {
        problems.push(`${seat.label}: the ${w.label} screen (${w.path || '?'}) failed to render itself — ${w.alert}`);
      }
    }
  }

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
