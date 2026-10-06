'use strict';
// =====================================================================
// tools/flow-coverage.js — WHAT THE LIVE AUDITS ACTUALLY TOUCH
// =====================================================================
// Eleven audits, every check green, and the question nobody had asked: WHICH PART OF THE
// PRODUCT DO THEY COVER? An audit suite is a claim about coverage, and a claim that is
// never measured drifts towards whatever was easiest to write. This tool measures it.
//
// IT READS THREE SOURCES AND CROSSES THEM:
//
//   1. THE ROUTES THE SERVER REGISTERS — parsed from `server/routes/*.js`, the same way
//      tools/capability-audit.js does, so the two tools cannot disagree about the API.
//   2. THE PATHS THE FRONTEND ASKS FOR — parsed from `public/js`, which is the client
//      half of every flow.
//   3. THE PATHS A LIVE AUDIT EXERCISES — parsed from `test/audit/**`, which is the
//      evidence half. A path mentioned there is a path some audit actually requests
//      against a running deployment, not a path somebody meant to test.
//
// FRONT TO BACK: every screen's calls, and whether an audit stands behind them.
// BACK TO FRONT: every registered route, and whether anything at all reaches it.
//
// IT DOES NOT FAIL THE BUILD, and that is deliberate — see the verdicts. What it does is
// make the gap a number that can be watched stage by stage, which is the only way a
// suite of this size stays honest. Run with --json for the machine-readable form.
//
// Usage: node tools/flow-coverage.js [--json] [--all]
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const SHOW_ALL = ARGS.includes('--all');

const SKIP_DIRS = new Set(['node_modules', '.git', '.data', 'dist', 'build', 'uploads']);

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

/** Every `/api/...` literal in a file, with variables normalised to `*`. */
function apiPathsIn(text, { templates = true } = {}) {
  const out = new Set();
  // Plain string literals: '/api/sales', "/api/change-owed/12/settle".
  for (const m of text.matchAll(/['"`](\/api\/[^'"`\s]*)['"`]/g)) out.add(normalise(m[1]));
  if (templates) {
    // Template literals with expressions: `/api/users/${id}/transfer` -> /api/users/*/transfer.
    for (const m of text.matchAll(/`(\/api\/[^`]*)`/g)) out.add(normalise(m[1]));
  }
  return out;
}

/**
 * `/api/users/${encodeURIComponent(id)}/transfer` and `/api/users/:id/transfer` and
 * `/api/users/12/transfer` all have to compare equal, or every cross-reference in this
 * tool is a comparison of spelling rather than of paths.
 */
function normalise(p) {
  return String(p)
    .split('?')[0]
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/:[A-Za-z_]\w*/g, '*')
    .replace(/\/\*+/g, '/*')
    .replace(/\*+/g, '*')
    .replace(/(\*\/)+/g, '*/')
    .replace(/\/+$/, '')
    .replace(/\/\*$/, '/*')
    .replace(/\/{2,}/g, '/');
}

/**
 * THE MOUNT BASE OF EVERY ROUTER, READ FROM THE FILE THAT MOUNTS THEM.
 *
 * `${base}` is not always `/api`: the auth router is mounted at `/api/auth`, so a
 * scanner that assumes `/api` reports `POST /api/login` — a route that does not exist,
 * in a report that is supposed to be the definitive list of what does. The first version
 * of this tool did exactly that, and eight routes were wrong. The bases are read here
 * rather than guessed so the two readings cannot drift apart.
 */
function mountBases() {
  const index = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'index.js'), 'utf8');
  const bases = new Map();   // module name -> base
  // `router.mount(app, '/api')` AND `router.mountPublic(app, '/api/branding')`: branding
  // has two mounts (a public one for the sign-in screen and a guarded one), so a scanner
  // that only looked for `.mount(` reported every branding route as living at /api — and
  // then reported `/api/full`, a route that does not exist, as one that does.
  for (const m of index.matchAll(/(\w+)\.mount\w*\(app,\s*'([^']+)'/g)) bases.set(m[1], m[2]);
  // A router's own default matters too: `mount(app, base = '/api/auth', …)` says what it
  // answers when nothing overrides it.
  for (const file of walk(path.join(ROOT, 'server', 'routes'))) {
    const text = fs.readFileSync(file, 'utf8');
    const fn = text.match(/function mount\w*\(app,\s*base\s*=\s*'([^']+)'/);
    if (!fn) continue;
    const name = path.basename(file).replace(/\.js$/, '');
    if (!bases.has(name)) bases.set(name, fn[1]);
  }
  return bases;
}

/** The routes the server registers, from the source that registers them. */
function registeredRoutes(files) {
  const bases = mountBases();
  const routes = [];
  for (const file of files) {
    if (!file.includes(`${path.sep}server${path.sep}routes${path.sep}`)) continue;
    const moduleName = path.basename(file).replace(/\.js$/, '');
    const base = bases.get(moduleName) || '/api';
    const text = fs.readFileSync(file, 'utf8');
    // TWO REGISTRATION SHAPES. Most routes are `` `${base}/something` ``; a handler for
    // the mount point itself is `app.get(base, …)` — which is how `GET /api/branding`
    // and `PUT /api/branding` are written, and how the scan missed exactly those two.
    for (const m of text.matchAll(/app\.(get|post|put|patch|delete)\(\s*`\$\{base\}([^`]*)`/g)) {
      routes.push({ method: m[1].toUpperCase(), path: normalise(`${base}${m[2]}`), file: rel(file) });
    }
    for (const m of text.matchAll(/app\.(get|post|put|patch|delete)\(\s*base\s*,/g)) {
      routes.push({ method: m[1].toUpperCase(), path: normalise(base), file: rel(file) });
    }
  }
  // De-duplicated by method+path: the same route registered twice is one route.
  const seen = new Set();
  return routes.filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * DOES AN AUDIT TOUCH THIS ROUTE?
 *
 * A path is reached when the audit asks for it or for anything underneath it — a suite
 * that exercises `/api/sales/*` has covered `/api/sales/12`, and asking an audit to name
 * every id would be asking it to lie about how it works. The check is deliberately
 * generous in that direction and strict in the other: an audit that only ever GETs a
 * collection has not covered the POST that creates one, so the METHOD has to match.
 */
function coverageOf(route, evidence) {
  const hits = evidence.filter((e) => {
    if (e.method && e.method !== route.method) return false;
    return e.path === route.path
      || (route.path.endsWith('/*') && e.path.startsWith(route.path.slice(0, -1)))
      || (e.path.endsWith('/*') && (`${route.path}/`).startsWith(e.path.slice(0, -1)))
      || e.path === route.path.replace(/\/\*$/, '');
  });
  return { hits, by: [...new Set(hits.map((h) => h.audit))] };
}

/** Which screen a client path came from, and what flow that screen belongs to. */
function viewOf(file) {
  const m = file.match(/public\/js\/views\/([a-z0-9-]+)\.js$/i);
  if (m) return m[1];
  if (/public\/js\/app\.js$/.test(file)) return 'shell';
  if (/public\/js\/sync\.js$/.test(file)) return 'sync';
  return 'other';
}

/**
 * THE SECOND READING — the router's OWN list of what it registered.
 *
 * The paths above are parsed out of the source text. This one asks the running router,
 * the same way test/e2e/frontend-contract.test.js does, and the two are compared: a
 * parser that misses a mount, a base or a whole file would otherwise produce a coverage
 * report that is confidently wrong about the API it is grading. This is the same
 * discipline the purge engine uses on the schema reader, for the same reason — a number
 * nobody can check is a number that drifts.
 */
function routesFromRouter() {
  try {
    const { createHttpApp } = require(path.join(ROOT, 'server', 'app'));
    const app = createHttpApp({
      db: {
        async all() { return []; }, async first() { return null; }, async run() {},
        async scalar() { return 0; }, async transaction(fn) { return fn({ queue() {}, idFor() { return 'x'; } }); },
      },
      jwtSecret: 'flow-coverage-secret',
      settings: {},
    });
    return ((app && app.routes) || [])
      .filter((r) => r.pattern.startsWith('/api'))
      .map((r) => ({ method: r.method, path: normalise(r.pattern.replace(/:\w+/g, '*')) }));
  } catch (err) {
    return { error: err.message };
  }
}

function main() {
  const serverFiles = walk(path.join(ROOT, 'server'));
  const auditFiles = walk(path.join(ROOT, 'test', 'audit')).filter((f) => /audit\.[a-z]+\.js$/i.test(f) || f.includes(`${path.sep}pairs${path.sep}`));
  const clientFiles = walk(path.join(ROOT, 'public', 'js'));

  const routes = registeredRoutes(serverFiles);

  // WHAT EACH LIVE AUDIT REQUESTS. The method is read from the call that carries the
  // path when it is on the same line (`owner.post('/api/sales', …)`), because "an audit
  // touches this endpoint" is a weaker claim than "an audit posts to it".
  const evidence = [];
  for (const file of auditFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const name = `audit.${path.basename(file).replace(/^audit\./, '').replace(/\.js$/, '')}`;
    for (const line of text.split('\n')) {
      for (const p of apiPathsIn(line)) {
        const m = line.match(/\.(get|post|put|patch|del|delete|request)\(\s*[`'"]?\s*(\/api\/[^'"`\s]*)/i);
        let method = null;
        if (m) {
          const verb = m[1].toLowerCase();
          method = verb === 'del' || verb === 'delete' ? 'DELETE' : verb === 'request' ? null : verb.toUpperCase();
        }
        evidence.push({ path: p, method, audit: name, file: rel(file) });
      }
    }
  }

  // WHAT EACH SCREEN ASKS FOR.
  const clientPaths = new Map(); // path -> Set(view)
  for (const file of clientFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const view = viewOf(rel(file));
    for (const p of apiPathsIn(text)) {
      if (!clientPaths.has(p)) clientPaths.set(p, new Set());
      clientPaths.get(p).add(view);
    }
  }
  const reachedByClient = (route) => {
    for (const [p, views] of clientPaths) {
      if (p === route.path || p.startsWith(`${route.path}/`) || route.path.startsWith(`${p}/`)) return [...views].join(', ');
    }
    return null;
  };

  // BOTH READINGS, COMPARED. Anything in one and not the other is a defect in one of
  // them, and it is reported before the coverage numbers rather than after them.
  const fromRouter = routesFromRouter();
  const disagreements = [];
  if (Array.isArray(fromRouter)) {
    const key = (r) => `${r.method} ${r.path}`;
    const parsedSet = new Set(routes.map(key));
    const routerSet = new Set(fromRouter.map(key));
    for (const k of routerSet) if (!parsedSet.has(k)) disagreements.push(`the router has it and the text scan does not: ${k}`);
    for (const k of parsedSet) if (!routerSet.has(k)) disagreements.push(`the text scan has it and the router does not: ${k}`);
  }

  const rows = routes.map((route) => {
    const cov = coverageOf(route, evidence);
    const client = reachedByClient(route);
    return {
      method: route.method,
      path: route.path,
      file: route.file,
      audits: cov.by,
      client,
      verdict: cov.by.length ? 'audited'
        : client ? 'no audit' : 'not reached by any screen',
    };
  });

  // FLOWS: the first segment under /api, which is how a person thinks about the product
  // ("the sales flow", "the till flow") rather than how the router is organised.
  const flows = new Map();
  for (const r of rows) {
    const seg = r.path.replace(/^\/api\/?/, '').split('/')[0] || '(root)';
    const flow = flows.get(seg) || { flow: seg, routes: 0, audited: 0, screens: new Set(), audits: new Set(), uncovered: [] };
    flow.routes += 1;
    if (r.verdict === 'audited') flow.audited += 1;
    else flow.uncovered.push(`${r.method} ${r.path}`);
    if (r.client) for (const v of r.client.split(', ')) flow.screens.add(v);
    for (const a of r.audits) flow.audits.add(a);
    flows.set(seg, flow);
  }
  const flowRows = [...flows.values()].map((f) => ({
    flow: f.flow,
    routes: f.routes,
    audited: f.audited,
    percent: Math.round((f.audited / f.routes) * 100),
    screens: [...f.screens].sort(),
    audits: [...f.audits].sort(),
    uncovered: f.uncovered,
  })).sort((a, b) => (a.percent - b.percent) || (b.routes - a.routes));

  const audited = rows.filter((r) => r.verdict === 'audited').length;
  const unreached = rows.filter((r) => r.verdict === 'not reached by any screen');
  const uncovered = rows.filter((r) => r.verdict === 'no audit');
  const auditNames = [...new Set(evidence.map((e) => e.audit))].sort();

  if (AS_JSON) {
    console.log(JSON.stringify({
      routes: rows.length, audited, uncovered: uncovered.length, unreached: unreached.length,
      parserAgreement: disagreements.length ? { disagreements } : { ok: true, routes: Array.isArray(fromRouter) ? fromRouter.length : null },
      audits: auditNames,
      flows: flowRows,
      rows,
    }, null, 2));
    return;
  }

  const line = '─'.repeat(66);
  console.log('StockRidge — flow coverage: what the live audits actually touch');
  console.log(line);
  console.log(`  ${rows.length} route(s) registered · ${audited} exercised by an audit · ${uncovered.length} reached by a screen and not audited · ${unreached.length} not reached by any screen`);
  if (Array.isArray(fromRouter)) {
    console.log(disagreements.length
      ? `  PARSER DISAGREEMENT: the text scan and the router do not agree on ${disagreements.length} route(s)`
      : `  the two readings agree: the text scan and the router both list ${fromRouter.length} route(s)`);
    for (const d of disagreements.slice(0, 10)) console.log(`    ${d}`);
  } else {
    console.log(`  the router could not be built to cross-check the scan: ${fromRouter.error}`);
  }
  console.log(`  ${auditNames.length} live audits: ${auditNames.join(', ')}`);
  console.log('');
  console.log('  BY FLOW (worst covered first)');
  console.log(`  ${'flow'.padEnd(22)}${'audited'.padStart(9)}${'routes'.padStart(8)}   audits`);
  for (const f of flowRows) {
    const bar = `${f.audited}/${f.routes}`.padStart(9);
    const pct = `${f.percent}%`.padStart(5);
    console.log(`  ${f.flow.padEnd(22)}${bar}${pct}${String(f.routes).padStart(4)}   ${f.audits.join(', ') || '—'}`);
  }
  if (SHOW_ALL) {
    console.log('');
    console.log('  EVERY ROUTE');
    for (const r of [...rows].sort((a, b) => a.path.localeCompare(b.path))) {
      console.log(`  ${r.verdict === 'audited' ? '✓' : (r.verdict === 'no audit' ? '·' : ' ')} ${r.method.padEnd(6)} ${r.path.padEnd(46)} ${r.audits.join(', ') || r.verdict}`);
    }
  }
  console.log('');
  console.log('  THE GAP, IN THE ORDER IT WOULD HURT');
  for (const f of flowRows.filter((x) => x.percent < 100)) {
    console.log(`  ${f.flow}: ${f.uncovered.join('  ')}`);
  }
  console.log('');
}

// A DOCUMENT, NOT A CLAIM. `--md` writes docs/flow-coverage.md from the same numbers
// this run printed, so the written report cannot drift from the measured one — the
// failure mode of every hand-maintained coverage table ever kept.
if (ARGS.includes('--md')) {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [__filename, '--json'], { encoding: 'utf8' });
  const data = JSON.parse(out);
  const lines = [];
  lines.push('# Flow coverage — what the live audits actually touch');
  lines.push('');
  lines.push('Generated by `node tools/flow-coverage.js --md`. Do not edit by hand; the numbers come from');
  lines.push('the source, and a hand-edited copy of a generated table is a claim about a claim.');
  lines.push('');
  lines.push(`**${data.routes} routes registered** · **${data.audited} exercised by a live audit** · `);
  lines.push(`${data.uncovered} reached by a screen and not audited · ${data.unreached} not reached by any screen.`);
  lines.push('');
  lines.push(`Parser agreement: ${data.parserAgreement.ok ? `the text scan and the router both list **${data.parserAgreement.routes}** routes` : `**${data.parserAgreement.disagreements.length} disagreement(s)**`}`);
  lines.push('');
  lines.push(`Live audits: ${data.audits.map((a) => `\`${a}\``).join(', ')}.`);
  lines.push('');
  lines.push('## By flow');
  lines.push('');
  lines.push('| flow | audited | routes | screens | audits |');
  lines.push('|---|---:|---:|---|---|');
  for (const f of data.flows) {
    lines.push(`| \`${f.flow}\` | ${f.audited} (${f.percent}%) | ${f.routes} | ${f.screens.join(', ') || '—'} | ${f.audits.join(', ') || '—'} |`);
  }
  lines.push('');
  lines.push('## The gap');
  lines.push('');
  lines.push('Routes a screen calls that no live audit exercises. Ordered by flow, worst covered first.');
  lines.push('');
  for (const f of data.flows.filter((x) => x.uncovered.length)) {
    lines.push(`### \`${f.flow}\` — ${f.audited}/${f.routes}`);
    lines.push('');
    for (const r of f.uncovered) lines.push(`- \`${r}\``);
    lines.push('');
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'flow-coverage.md'), `${lines.join('\n')}\n`);
  console.log('wrote docs/flow-coverage.md');
  process.exit(0);
}

if (require.main === module) main();

module.exports = { normalise, apiPathsIn, mountBases, registeredRoutes, routesFromRouter, coverageOf };
