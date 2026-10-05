'use strict';
// =====================================================================
// tools/frontend-roles.js — EVERY ROLE, EVERY CAPABILITY, BOTH WAYS
// =====================================================================
// THE QUESTION THIS ANSWERS
//
// "Does each kind of user actually get what the system says they get — and are
// they actually stopped from what it says they may not do?"
//
// Both halves matter, and the second half is the one nobody tests. A capability
// that is missing is a bug the user reports. A capability that is NOT REFUSED is
// a bug nobody reports — a cashier who can read the profit figures, a manager who
// can change the VAT rate — until an auditor finds it. So this tool probes both
// directions on the live server:
//
//   * the navigation the role is given, against the route table the app declares
//   * every guarded GET endpoint the server registers, called with that role's
//     token: a refusal where the guard demands more authority, a real answer
//     where it does not
//
// WHY IT IS NOT PART OF `npm run verify`
//
// It needs four real seats on a real deployment. CI has no such seats, and a test
// that has to be maintained to keep passing stops being run. It runs against the
// demo database locally and against staging, where the four roles really exist.
//
// WHY ONLY GET
//
// Probing a guarded POST would create the thing it protects: a sale, a stock
// adjustment, a VAT change. A probe that edits the books to prove it may not edit
// the books has defeated itself. GET probes are read-only, so this tool is safe
// against a live deployment — and it says so rather than implying coverage it
// does not have.
//
//   node tools/frontend-roles.js --url=… --seat=admin:1234 [--seat=owner:48213 …]
//   node tools/frontend-roles.js --url=… --seat=liveseat:48213 --walk
//
// `--walk` also opens every destination that role's navigation offers, using the
// shared walk from tools/lib/page-harness.js, and reports any screen that fails
// to draw itself.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const H = require('./lib/page-harness.js');

const ROOT = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'server', 'routes');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const all = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.split('=').slice(1).join('='));

const BASE = String(flag('url', 'http://localhost:8787')).replace(/\/$/, '');
const WALK = args.includes('--walk');
const LIST = args.includes('--list');
// Calling a guarded WRITE is opt-in, and must never be used on a customer's live
// deployment: a route that lets the role through will have been handed an empty
// body, which a well-built handler rejects without writing — but "well-built" is
// the very assumption under test, so the risk is the caller's to accept.
const DEEP = args.includes('--deep-writes');
const ROLE_ORDER = ['STAFF', 'MANAGER', 'OWNER', 'ADMIN'];

/**
 * THE INDEPENDENT TRUTH.
 *
 * The expectations above are extracted from the server's own source, which is
 * exactly what makes them complete — and exactly what makes them fragile: delete
 * a guard and the expectation disappears with it, so the probe goes quiet on the
 * boundary that just opened. (Found by doing precisely that: removing the
 * /api/plan guard produced "no problems".)
 *
 * So the boundaries that matter most are ALSO written down here, by hand, from
 * the role table in domain/roles.js rather than from the routes. A role below one
 * of these MUST be refused: below-guard requests are safe to send even for
 * writes, because an empty body can only be refused (the guard) or rejected as
 * invalid (the handler) — it cannot create anything valid out of nothing.
 */
const CRITICAL = [
  { method: 'GET', path: '/api/plan', minRole: 'OWNER', why: 'the subscription position belongs to the owner' },
  { method: 'GET', path: '/api/audit', minRole: 'MANAGER', why: 'the audit trail names who did what' },
  { method: 'GET', path: '/api/audit/verify', minRole: 'OWNER', why: 'the chain is the integrity claim itself' },
  { method: 'GET', path: '/api/auth/attempts', minRole: 'OWNER', why: 'failed sign-in attempts are a security read' },
  { method: 'PUT', path: '/api/settings', minRole: 'OWNER', why: 'the control switches, including who may write off stock' },
  { method: 'POST', path: '/api/users', minRole: 'ADMIN', why: 'creating any user, in any role' },
  { method: 'POST', path: '/api/businesses', minRole: 'ADMIN', why: 'creating a tenant' },
  { method: 'POST', path: '/api/accounting/journal', minRole: 'OWNER', why: 'writing to the ledger' },
  { method: 'POST', path: '/api/stock/receive', minRole: 'MANAGER', why: 'receiving stock moves the weighted-average cost' },
  { method: 'POST', path: '/api/transfers', minRole: 'MANAGER', why: 'moving stock between branches' },
  { method: 'POST', path: '/api/customer-classes', minRole: 'OWNER', why: 'the price tiers a customer is charged on' },
  { method: 'POST', path: '/api/auth/unlock', minRole: 'OWNER', why: 'clearing a throttled account' },
];

/**
 * The seats to probe. `--seat=username:pin[:ROLE]`.
 *
 * The role is optional and, when given, is only used to label the report — the
 * role this probe actually tests is the one the SERVER says the seat holds, from
 * /api/auth/me. Trusting the caller's label would let the report describe a role
 * the token does not have, which is the sort of thing this tool exists to catch.
 */
function seatsFromArgs() {
  const seats = all('seat').map((s) => {
    const [username, pin, role] = s.split(':');
    return { username, pin, role: role || null };
  });
  if (seats.length) return seats;
  // The demo database's four seats, when none are named.
  return [
    { username: 'admin', pin: '90210', role: 'ADMIN' },
    { username: 'owner', pin: '48213', role: 'OWNER' },
    { username: 'emeka', pin: '73914', role: 'MANAGER' },
    { username: 'blessing', pin: '26480', role: 'STAFF' },
  ];
}

// ---------------------------------------------------------------------
// 1. WHAT THE SERVER SAYS IT GUARDS
// ---------------------------------------------------------------------
/**
 * Read every route registration out of server/routes/*.js and find the authority
 * it demands.
 *
 * The convention in this codebase is exact and worth relying on: a route is
 * registered as `app.get(`${base}/thing`, async (ctx) => {` and, when guarded,
 * the first thing inside it asks `atLeast(user.role, 'ROLE')`. Reading that gives
 * the guard level per route WITHOUT a second table that could disagree with the
 * code — the map is derived from the file the server itself runs.
 *
 * A route with no guard in its handler is open to any signed-in user, which is
 * what the app's own role table says for its screens.
 */
function readRouteTable() {
  const table = [];
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'))) {
    const full = path.join(ROUTES_DIR, file);
    const src = fs.readFileSync(full, 'utf8');
    // `mount(app, base = '/api')`, and the branding file's two mounts
    // (`mountPublic`/`mountGuarded`) which default to '/api/branding'.
    const base = (src.match(/function mount\w*\(\s*app\s*,\s*base\s*=\s*'([^']+)'/) || [])[1] || '/api';
    const regs = [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*`\$\{base\}([^`]*)`/g)];
    regs.forEach((m, i) => {
      const method = m[1].toUpperCase();
      const routePath = base + m[2];
      const from = m.index;
      const to = i + 1 < regs.length ? regs[i + 1].index : src.length;
      const body = src.slice(from, to);
      // A GUARD is an authority demand that REFUSES. The codebase's guard idiom
      // is `if (!atLeast(user.role, 'X')) throw new HttpError(…)`, and the
      // difference matters: `atLeast(user.role, 'OWNER') ? featureLabels : null`
      // is not a guard, it is a route deciding how much of a PUBLIC answer to
      // give. Reading those as guards produced four false accusations on the
      // first run — /api/settings, /api/dashboard, /api/tills/current and
      // /api/branding/full — every one of which is a route that deliberately
      // serves everybody and simply says less when you are junior.
      //
      // So: a demand counts only when a `throw` follows it. That is the shape a
      // refusal actually takes.
      const guard = /!\s*atLeast(?:Any)?\(\s*(?:ctx\.get\('user'\)\.role|user\.role|role)\s*,\s*('([A-Z]+)'|\[([^\]]+)\])\s*\)([\s\S]{0,200}?)throw/;
      let minRole = 'ANY';
      let evidence = '';
      const at = body.match(guard);
      const any = at && !at[2] ? at : null;
      if (at && at[2]) { minRole = at[2]; evidence = at[0].replace(/\s+/g, ' ').slice(0, 70); }
      else if (any) {
        const roles = [...String(any[3]).matchAll(/'([A-Z]+)'/g)].map((r) => r[1]);
        // An "any of these" list is represented by its LOWEST role for the
        // purpose of "who is refused": everyone below it is refused for certain.
        minRole = roles.sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))[0] || 'ANY';
        evidence = `any of ${roles.join('/')}`;
      }
      table.push({ method, path: routePath, minRole, evidence, file: path.relative(ROOT, full) });
    });
  }
  return table;
}

/** The navigation the app declares for a role, from its own route table. */
function readNavRoutes() {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const routes = [];
  for (const m of app.matchAll(/\{ path: '([^']+)', title: '([^']+)'[^\n]*?roles: \[([^\]]*)\]([^\n]*)\}/g)) {
    const roles = [...m[3].matchAll(/'([A-Z]+)'/g)].map((r) => r[1]);
    routes.push({ path: m[1], title: m[2], roles, nav: !/nav:\s*false/.test(m[0]) });
  }
  return routes;
}

// ---------------------------------------------------------------------
// 2. LIVE PROBES
// ---------------------------------------------------------------------
async function login(username, pin) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  const body = await res.json().catch(() => null);
  if (!body || !body.token) return { ok: false, status: res.status, body };
  return { ok: true, token: body.token };
}

async function me(token) {
  const res = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => null);
  return body || {};
}

/**
 * Call one endpoint and say what happened, in the only terms this probe cares
 * about: refused, answered, or broken.
 */
async function probe(token, endpoint, branchId, { body = null } = {}) {
  const url = new URL(BASE + endpoint.path);
  if (branchId && !url.searchParams.has('branch_id')) url.searchParams.set('branch_id', branchId);
  // A path with a parameter (/api/sales/:id) cannot be called as written; the
  // probe says so rather than inventing an id and hoping.
  if (/:/.test(endpoint.path)) return { status: 0, verdict: 'SKIPPED', note: 'the path needs an id' };
  let res;
  try {
    res = await fetch(url, {
      method: endpoint.method,
      headers: Object.assign({ Authorization: `Bearer ${token}` },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { status: 0, verdict: 'ERROR', note: err && err.message ? err.message : String(err) };
  }
  const text = await res.text();
  if (res.status === 403) return { status: 403, verdict: 'REFUSED' };
  if (res.status >= 500) return { status: res.status, verdict: 'BROKEN', note: text.slice(0, 160) };
  // 401 means the TOKEN was rejected, which is not a role decision.
  if (res.status === 401) return { status: 401, verdict: 'UNAUTHENTICATED', note: text.slice(0, 120) };
  // 404 means THIS PROBE has the wrong path — it is not a statement about the
  // role, and counting it either way would invent a defect out of a typo in a
  // regex. It is reported as what it is: coverage the probe could not reach.
  if (res.status === 404) return { status: 404, verdict: 'NOT_FOUND' };
  if (res.status >= 400) {
    // A validation refusal. For a WRITE this is a fine outcome — nothing was
    // created — and it is the common one, because most handlers validate the
    // body before they ask about authority (POST /api/users does exactly that:
    // it requires `role` before it calls canManageUser). For a GET there is no
    // body to validate, so a 4xx here is recorded separately rather than as an
    // answer the role was entitled to.
    return { status: res.status, verdict: 'REJECTED_INPUT', note: text.slice(0, 120) };
  }
  return { status: res.status, verdict: 'ANSWERED' };
}

function rank(role) { return ROLE_ORDER.indexOf(String(role || '').toUpperCase()) + 1; }

// A page that throws while nobody is looking must not take the probe with it.
// Before this existed, one screen on staging threw after the walk had moved on,
// the exception landed outside jsdom, and the tool died with a stack trace that
// named a DOM helper instead of the screen.
const lateFaults = [];
process.on('uncaughtException', (err) => {
  const message = err && err.message ? err.message : String(err);
  lateFaults.push(message);
  console.log(`      ! a screen threw after the walk had moved on: ${message.slice(0, 160)}`);
  if (lateFaults.length > 8) {
    console.log('      ! too many late faults — stopping');
    process.exit(1);
  }
});

(async () => {
  const seats = seatsFromArgs();
  const routes = readRouteTable();
  const navRoutes = readNavRoutes();
  const guarded = routes.filter((r) => r.minRole !== 'ANY');
  const getRoutes = guarded.filter((r) => r.method === 'GET');
  const writeRoutes = guarded.filter((r) => r.method !== 'GET');
  const probedRoutes = DEEP ? guarded : getRoutes;
  // Critical boundaries are always probed, even the writes — see the note on
  // CRITICAL: below-guard requests cannot create anything.
  const criticalSet = new Map();
  for (const c of CRITICAL) criticalSet.set(`${c.method} ${c.path}`, c);

  console.log('StockRidge — role capability probe');
  console.log(`  ${BASE}`);
  console.log('─'.repeat(58));
  console.log(`  ${routes.length} route(s) registered · ${guarded.length} carry a role guard`);
  console.log(`  per seat: ${getRoutes.length} guarded GET(s) called` +
    (DEEP ? ` + ${writeRoutes.length} guarded write(s), empty-bodied (OPT-IN — never against a customer's live deployment)` : ''));
  if (!DEEP) console.log('  (add --deep-writes to also call guarded writes with an empty body; a refusal is expected below the guard)');
  console.log(`  ${navRoutes.filter((r) => r.nav).length} navigation destination(s) declared`);
  if (!WALK) console.log('  (add --walk to open every destination each role is offered)');
  console.log('');

  if (LIST) {
    console.log('  every guarded endpoint, from the server’s own source:');
    for (const r of guarded) {
      console.log(`    ${r.method.padEnd(6)} ${String(r.minRole).padEnd(8)} ${r.path}  (${r.file})`);
    }
    console.log('');
  }

  const problems = [];
  const seatReports = [];

  for (const seat of seats) {
    const auth = await login(seat.username, seat.pin);
    if (!auth.ok) {
      problems.push(`${seat.username}: sign-in failed (http ${auth.status}) — ${JSON.stringify(auth.body).slice(0, 120)}`);
      console.log(`  ✗ ${seat.username} — could not sign in (http ${auth.status})`);
      continue;
    }
    const who = await me(auth.token);
    const role = String((who.user && who.user.role) || seat.role || 'UNKNOWN').toUpperCase();
    const label = `${seat.username} (${role})`;

    // ---- the navigation this role is offered
    let nav = [];
    let walk = [];
    if (WALK) {
      const page = await H.bootPage({ origin: BASE, token: auth.token, waitMs: 30000 });
      if (!page.ok) {
        problems.push(`${label}: the app did not boot — ${page.reason || page.settled.state}`);
      } else {
        const doc = page.window.document;
        const navEl = doc.getElementById('nav-list');
        nav = navEl ? [...navEl.querySelectorAll('.nav-item')].map((b) => b.textContent.trim()) : [];
        walk = await H.walkNav(page, { settleMs: 15000 });
        // The window is deliberately NOT closed. A view that is still waiting on a
        // request when the walk ends resumes into a torn-down document, `h()` has
        // no `document` to build into, and the throw lands OUTSIDE jsdom — killing
        // this process and hiding whatever the screen was about to say. Letting the
        // page live out the rest of its request costs a little memory and buys the
        // truth.
      }
    }

    // ---- every guarded GET, called with this role's token
    const branchId = who.user && who.user.branch ? who.user.branch.id : null;
    const outcomes = { REFUSED: 0, ANSWERED: 0, BROKEN: 0, UNAUTHENTICATED: 0, ERROR: 0, NOT_FOUND: 0, SKIPPED: 0, REJECTED_INPUT: 0 };
    const wrongWay = [];
    const broken = [];
    // The call list is the UNION of what the source says is guarded and what the
    // independent table says must be guarded — because the two fail in opposite
    // directions. A guard that exists in the source but does not run is caught by
    // the source entry; a guard DELETED from the source (so the source entry is
    // gone with it) is caught by the independent entry, which is the whole reason
    // the independent table exists.
    //
    // Critical writes are only sent when this role is BELOW the boundary: that is
    // the only case where the answer must be a refusal, and an empty body cannot
    // create anything if the guard is doing its job.
    const callList = [];
    const seen = new Set();
    for (const r of probedRoutes) { callList.push(r); seen.add(`${r.method} ${r.path}`); }
    for (const c of CRITICAL) {
      const key = `${c.method} ${c.path}`;
      if (seen.has(key)) continue;
      if (c.method !== 'GET' && rank(c.minRole) <= rank(role)) continue;
      callList.push({ method: c.method, path: c.path, minRole: c.minRole, evidence: 'the independent boundary table', fromCritical: true });
      seen.add(key);
    }
    for (const ep of callList) {
      const result = await probe(auth.token, ep, branchId, { body: ep.method === 'GET' ? null : {} });
      const below = rank(ep.minRole || 'ANY') > rank(role);
      if (result.verdict === 'ANSWERED' && below) {
        // THE DANGEROUS DIRECTION, and the only truly unambiguous one: the
        // request SUCCEEDED for a role the boundary excludes. For a write that
        // means something was created, which is why a 2xx is the signal and a
        // validation refusal is not.
        const critical = criticalSet.get(`${ep.method} ${ep.path}`);
        wrongWay.push(`${ep.method} ${ep.path} was served http ${result.status} to ${role}`
          + (critical ? `, and ${critical.why} — it must require ${ep.minRole}` : `, which needs ${ep.minRole} (${ep.evidence || 'guard in source'})`));
      }
      if (result.verdict === 'REFUSED' && rank(ep.minRole || 'ANY') <= rank(role)) {
        wrongWay.push(`${ep.method} ${ep.path} needs only ${ep.minRole} yet refused ${role}`);
      }
      outcomes[result.verdict] = (outcomes[result.verdict] || 0) + 1;
      const demands = rank(ep.minRole);
      const has = rank(role);
      // The independent table has already reported this pair if it is critical.
      if (result.verdict === 'ANSWERED' && demands > has && !criticalSet.has(`${ep.method} ${ep.path}`)) {
        wrongWay.push(`${ep.method} ${ep.path} needs ${ep.minRole} (${ep.evidence}) but ${role} was served http ${result.status}`);
      }
      if (result.verdict === 'REFUSED' && demands <= has) {
        wrongWay.push(`${ep.method} ${ep.path} needs only ${ep.minRole} yet refused ${role}`);
      }
      if (result.verdict === 'BROKEN') broken.push(`${ep.method} ${ep.path} → http ${result.status}: ${result.note}`);
    }

    seatReports.push({ label, role, nav, walk, outcomes, wrongWay, broken, called: callList.length });

    console.log(`  ${wrongWay.length || broken.length ? '✗' : '✓'} ${label}`);
    console.log(`      guarded endpoint(s) called: ${callList.length} — ` +
      `${outcomes.ANSWERED} answered, ${outcomes.REFUSED} refused, ${outcomes.BROKEN} broken` +
      `${outcomes.UNAUTHENTICATED ? `, ${outcomes.UNAUTHENTICATED} unauthenticated` : ''}` +
      `${outcomes.NOT_FOUND ? `, ${outcomes.NOT_FOUND} not found (the extracted path is not the mounted one)` : ''}` +
      `${outcomes.SKIPPED ? `, ${outcomes.SKIPPED} skipped (the path needs an id)` : ''}` +
      `, ${CRITICAL.filter((c) => c.method === 'GET' || rank(c.minRole) > rank(role)).length} of ${CRITICAL.length} critical boundaries checked`
      + `${outcomes.REJECTED_INPUT ? ` (${outcomes.REJECTED_INPUT} refused before acting: bad input)` : ''}`);
    if (WALK) {
      const faults = walk.filter((w) => w.fault || w.thrown || w.chars === 0);
      console.log(`      navigation: ${nav.length} destination(s)${nav.length ? ` — ${nav.join(' · ')}` : ''}`);
      for (const f of faults) {
        console.log(`        ✗ ${f.label}: ${f.thrown || f.alert || 'rendered nothing'}`);
      }
      if (faults.length) {
        problems.push(...faults.map((f) => `${label}: the ${f.label} screen (${f.path || '?'}) ${f.thrown ? `threw: ${f.thrown}` : `failed to render — ${f.alert || 'nothing rendered'}`}`));
      }
      // The nav a role is offered must match the route table FOR THAT ROLE.
      const shouldSee = navRoutes.filter((r) => r.nav && r.roles.includes(role)).map((r) => r.title);
      const missing = shouldSee.filter((title) => !nav.some((n) => n.toLowerCase() === title.toLowerCase()));
      const extra = nav.filter((n) => !shouldSee.some((title) => title.toLowerCase() === n.toLowerCase()));
      if (missing.length) problems.push(`${label}: the app declares these destinations for ${role} but the sidebar omits them: ${missing.join(', ')}`);
      if (extra.length) problems.push(`${label}: the sidebar offers destinations no route grants ${role}: ${extra.join(', ')}`);
      console.log(`      declared for ${role}: ${shouldSee.length}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}${extra.length ? ` (UNSCOPED: ${extra.join(', ')})` : ''}`);
    }
    for (const w of wrongWay) console.log(`        ✗ ${w}`);
    for (const b of broken) console.log(`        ✗ ${b}`);
    problems.push(...wrongWay.map((w) => `${label}: ${w}`));
    problems.push(...broken.map((b) => `${label}: ${b}`));
  }

  for (const f of lateFaults) problems.push(`a screen threw asynchronously: ${f.slice(0, 160)}`);

  console.log('─'.repeat(58));
  if (problems.length) {
    console.log(`${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log(`${seats.length} seat(s) probed, both directions: no problems.`);
  }

  // A machine-readable tail, so a deploy check can consume this later.
  try {
    const summaryPath = path.join(ROOT, '.data', 'role-probe.json');
    fs.writeFileSync(summaryPath, JSON.stringify({ base: BASE, at: new Date().toISOString(), routes: routes.length, guardedGets: getRoutes.length, seats: seatReports, problems }, null, 2));
    console.log(`  written: ${path.relative(ROOT, summaryPath)}`);
  } catch (err) { /* a report that cannot be written is not a failed probe */ }

  process.exit(problems.length ? 1 : 0);
})();
