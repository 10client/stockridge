'use strict';
// =====================================================================
// tools/capability-audit.js — WHAT THE SCHEMA CAN DO, AND WHAT USES IT
// =====================================================================
// THE QUESTION
//
// "Every capability in the schema, fully used by every kind of user."
//
// The schema in this repository is large on purpose: 76 tables and 22 views carry
// instalment plans, layaway holds, warranty and serial tracking, wholesale price
// tiers, delivery and installation jobs, the debtor ledger, branch safes,
// geofenced attendance, the hash-chained audit registers, the double-entry ledger
// and the WHT schedule. A table that nothing writes is a capability a customer
// cannot use. A table that nothing reads is storage nobody looks at — which for a
// business application usually means a flow that was built and then never wired
// to anything. Neither shows up in a test suite, because a test can only fail on
// code that exists.
//
// So this walks the schema and, for every table, asks:
//
//   created?   does any code INSERT into it (or does a seed)?
//   updated?   does any code UPDATE or DELETE from it?
//   read?      does any code SELECT from it?
//   seeded?    does a migration or a seed tool put rows in it (reference data)?
//   exposed?   does a registered API route touch it?
//   reached?   does the frontend ever call that route?
//
// WHAT IT IS NOT
//
// It is a finding tool, not a linter with opinions about style. It fails (exit 1)
// only on the one verdict that is never defensible: a table that no code and no
// seed ever touches at all — a capability that exists on paper and nowhere else.
// Everything else is reported for a person to decide about, because "written but
// never read" is sometimes exactly right (an append-only register is written and
// read by a report, and a queue is read by an external process).
//
// Usage: node tools/capability-audit.js [--json] [--all]
//   --json  machine-readable output
//   --all   list every table, not just the ones with something to say
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const SHOW_ALL = ARGS.includes('--all');
const STRICT = ARGS.includes('--strict');

const SCAN_DIRS = ['server', 'domain', 'worker', 'tools', 'public/js'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.data', 'dist', 'build', 'uploads']);
const SEED_FILES = ['schema', 'tools/seed.js', 'tools/reseed.js', 'tools/d1-seed.js'];

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.(js|mjs|sql)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Everything the application says, by file. */
function sources() {
  const files = [];
  for (const dir of SCAN_DIRS) files.push(...walk(path.join(ROOT, dir)));
  return files.map((file) => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));
}

/** The schema itself: tables and views, with the comment above each if there is one. */
function schemaObjects() {
  const migrations = walk(path.join(ROOT, 'schema'));
  const tables = new Map();
  const views = new Map();
  for (const file of migrations) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)\s*[(AS]/gi)) {
      const name = m[1];
      const isView = /CREATE\s+VIEW/i.test(m[0]);
      // The comment immediately above is the table's stated purpose; keeping it
      // makes the report readable instead of a wall of identifiers.
      const before = text.slice(0, m.index).split('\n').slice(-6);
      const comment = before.filter((l) => /^\s*--/.test(l)).map((l) => l.replace(/^\s*--\s?/, '')).join(' ').slice(0, 120);
      (isView ? views : tables).set(name, { name, comment, file: path.relative(ROOT, file) });
    }
  }
  return { tables, views };
}

const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How a table is used across the codebase, statement by statement. */
function usageOf(name, srcs, seedSrcs) {
  const t = re(name);
  const count = (text, pattern) => (text.match(pattern) || []).length;
  const joined = srcs.map((s) => s.text).join('\n');
  const seeds = seedSrcs.map((s) => s.text).join('\n');

  const inserts = count(joined, new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${t}\\b`, 'gi'));
  // SOME TABLES ARE WRITTEN WITHOUT THEIR NAME EVER APPEARING IN SQL.
  //
  // The hash-chained registers (the audit log and its siblings) are appended
  // through a generic helper that takes the table name as an ARGUMENT:
  // `appendChained(db, { table: 'audit_log', … })`. A scan for INSERT statements
  // therefore reported `audit_log` as "read but never created" — a false finding
  // about the one table whose completeness is a security claim. A named table in a
  // helper call is a write site just as much as an INSERT is.
  const chained = count(joined, new RegExp(`table:\\s*'${t}'`, 'g'));
  const updates = count(joined, new RegExp(`UPDATE\\s+${t}\\b`, 'gi'));
  const deletes = count(joined, new RegExp(`DELETE\\s+FROM\\s+${t}\\b`, 'gi'));
  const selects = count(joined, new RegExp(`(?:FROM|JOIN)\\s+${t}\\b`, 'gi'));
  const seeded = count(seeds, new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${t}\\b`, 'gi'));

  // Which route handlers touch it, and which files mention it at all.
  const files = srcs.filter((s) => new RegExp(`\\b${t}\\b`).test(s.text)).map((s) => s.file);
  const routes = [];
  for (const s of srcs) {
    if (!/^server[\\/]routes[\\/]/.test(s.file.replace(/\//g, path.sep))) continue;
    const regs = [...s.text.matchAll(/app\.(get|post|put|patch|delete)\(\s*`\$\{base\}([^`]*)`/g)];
    regs.forEach((m, i) => {
      const to = i + 1 < regs.length ? regs[i + 1].index : s.text.length;
      const body = s.text.slice(m.index, to);
      if (new RegExp(`\\b${t}\\b`).test(body)) routes.push(`${m[1].toUpperCase()} /api${m[2]}`);
    });
  }
  return { inserts: inserts + chained, updates, deletes, selects, seeded, chained, files, routes };
}

/**
 * Every API path the frontend writes, with `${…}` and `:param` normalised away.
 *
 * TWO READERS, UNIONED, and that is deliberate:
 *
 *   the TEXT SCAN finds an `/api/...` string anywhere in the client — including
 *   one that is not passed to `SR.api` at all, such as a path stored in an
 *   offline queue entry.
 *
 *   the SHARED READER (tools/lib/api-calls.js) parses the actual calls, so it
 *   handles what a character-class regex cannot: a nested template literal, a
 *   `?query` that is really a ternary, `SR.api.del` meaning DELETE.
 *
 * The text scan alone listed `GET /api/compliance/alerts` as a route no screen
 * asks for, because the call that asks for it is
 *     SR.api.get(`/api/compliance/alerts${branchId ? `?branch_id=…` : ''}`)
 * and the scan stopped at the inner backtick. An audit that reports a live route
 * as dead is one people stop reading.
 */
function frontendPaths(srcs) {
  const paths = new Set();
  for (const s of srcs) {
    if (!s.file.startsWith('public')) continue;
    for (const m of s.text.matchAll(/['"`](\/api\/[^'"`\s]*)/g)) {
      const clean = m[1].split('?')[0].replace(/\$\{[^}]*\}/g, '*').replace(/:[A-Za-z_]\w*/g, '*').replace(/\/$/, '');
      if (clean) paths.add(clean);
    }
  }
  try {
    for (const call of require('./lib/api-calls.js').apiCalls()) {
      paths.add(call.pathname.replace(/:[A-Za-z_]\w*/g, '*'));
    }
  } catch (err) {
    console.error(`[capability-audit] the API-call reader could not be loaded: ${err && err.message ? err.message : err}`);
  }
  return paths;
}

/** Registered routes, normalised the same way, so the two can be compared. */
function registeredRoutes(srcs) {
  const out = [];
  for (const s of srcs) {
    if (!/^server[\\/]routes[\\/]/.test(s.file.replace(/\//g, path.sep))) continue;
    const base = (s.text.match(/function mount\w*\(\s*app\s*,\s*base\s*=\s*'([^']+)'/) || [])[1] || '/api';
    for (const m of s.text.matchAll(/app\.(get|post|put|patch|delete)\(\s*`\$\{base\}([^`]*)`/g)) {
      out.push({ method: m[1].toUpperCase(), path: (base + m[2]).replace(/:[A-Za-z_]\w*/g, '*').replace(/\/$/, ''), file: s.file });
    }
  }
  return out;
}

function main() {
  const srcs = sources();
  const { tables, views } = schemaObjects();
  const seedSrcs = srcs.filter((s) => SEED_FILES.some((p) => s.file.startsWith(p)));
  const codeSrcs = srcs.filter((s) => !SEED_FILES.some((p) => s.file.startsWith(p)));
  const fePaths = frontendPaths(srcs);

  const rows = [];
  for (const [name, meta] of tables) {
    const use = usageOf(name, codeSrcs, seedSrcs);
    const written = use.inserts + use.updates + use.deletes > 0;
    const read = use.selects > 0;
    const exposed = use.routes.length > 0;
    // A route is "reached" when the frontend asks for its path. Normalisation
    // makes /api/stock/:id/batches and `/api/stock/${id}/batches` the same string.
    const reachedRoutes = use.routes.filter((r) => {
      const norm = r.replace(/^[A-Z]+ /, '').replace(/:[A-Za-z_]\w*/g, '*').replace(/\/$/, '');
      return [...fePaths].some((p) => p === norm || p.startsWith(norm + '/') || norm.startsWith(p));
    });
    let verdict = 'used';
    if (!written && !read && !use.seeded) verdict = 'DEAD';            // nowher
    else if (!written && !use.seeded) verdict = 'read-only, never created';
    else if (written && !read) verdict = 'written, never read';
    else if (written && read && !exposed) verdict = 'internal only';
    else if (exposed && !reachedRoutes.length) verdict = 'no screen calls it';
    rows.push({
      name, ...meta, ...use,
      written, read, exposed,
      reached: reachedRoutes.length,
      reachedRoutes,
      verdict,
    });
  }

  // ---- routes nothing in the frontend asks for
  const routes = registeredRoutes(srcs);
  const orphanRoutes = routes.filter((r) => ![...fePaths].some((p) => p === r.path || p.startsWith(r.path + '/') || r.path.startsWith(p + '/')));

  const dead = rows.filter((r) => r.verdict === 'DEAD');
  const neverCreated = rows.filter((r) => r.verdict === 'read-only, never created');
  const neverRead = rows.filter((r) => r.verdict === 'written, never read');
  const internalOnly = rows.filter((r) => r.verdict === 'internal only');
  const noScreen = rows.filter((r) => r.verdict === 'no screen calls it');

  if (AS_JSON) {
    console.log(JSON.stringify({
      tables: rows.length, views: views.size, routes: routes.length,
      findings: { dead: dead.map((r) => r.name), neverCreated: neverCreated.map((r) => r.name), neverRead: neverRead.map((r) => r.name), internalOnly: internalOnly.map((r) => r.name), noScreen: noScreen.map((r) => r.name), orphanRoutes: orphanRoutes.map((r) => `${r.method} ${r.path}`) },
      rows,
    }, null, 2));
  } else {
    const line = '─'.repeat(66);
    console.log('StockRidge — capability audit: the schema against what uses it');
    console.log(line);
    console.log(`  ${rows.length} table(s) · ${views.size} view(s) · ${routes.length} registered route(s)`);
    console.log(`  ${[...fePaths].filter((p) => p.startsWith('/api')).length} API path(s) written by the frontend`);
    console.log('');

    const section = (title, list, note, detail) => {
      console.log(`  ${title}: ${list.length}`);
      if (note) console.log(`    ${note}`);
      for (const item of list.slice(0, 14)) console.log(`    · ${detail(item)}`);
      if (list.length > 14) console.log(`    · …and ${list.length - 14} more (--all)`);
      console.log('');
    };

    section('Tables that exist and nothing creates (not even a seed)', dead,
      'A capability in the schema with no way in. This is the one that fails the audit.', (r) => `${r.name}  (${r.file})`);
    section('Tables read but never created', neverCreated,
      'Something reads them, so a flow expects rows; nothing in the codebase writes them.', (r) => `${r.name}  — ${r.selects} read site(s), ${r.routes.length} route(s)`);
    section('Tables created but never read', neverRead,
      'Written and then never looked at: usually a flow that was built and never wired to a report.', (r) => `${r.name}  — ${r.inserts} insert / ${r.updates} update, 0 read`);
    section('Tables reachable only from code, not from any route', internalOnly,
      'Used by services and jobs rather than exposed through the API. Often correct — check each.', (r) => `${r.name}  — ${r.files.slice(0, 3).join(', ')}`);
    section('Tables exposed by a route that no screen calls', noScreen,
      'The endpoint exists and the frontend never asks for it: an unused API, or a screen with a missing call.', (r) => `${r.name}  — ${r.routes.slice(0, 2).join(', ')}`);
    section('Routes no frontend code asks for', orphanRoutes,
      'Reachable by API clients and by the sync engine; listed so the count is never a surprise.', (r) => `${r.method.padEnd(6)} ${r.path}`);

    if (SHOW_ALL) {
      console.log('  every table:');
      for (const r of rows) {
        console.log(`    ${r.name.padEnd(34)} ${String(r.verdict).padEnd(28)} ins ${String(r.inserts).padStart(3)} upd ${String(r.updates).padStart(3)} sel ${String(r.selects).padStart(3)} routes ${String(r.routes.length).padStart(2)}`);
      }
      console.log('');
    }
    console.log(line);
    console.log(dead.length
      ? `${dead.length} table(s) no code or seed touches — a capability that exists on paper only.`
      : 'No table is unreachable: every one is created by code, by a seed, or by both.');
  }

  // ---- the baseline, in the style of tools/name-audit-baseline.json
  //
  // Eight tables in this schema are declared and reachable by nothing yet. Every
  // one is a capability somebody planned and has not wired up, and each is written
  // down here with what it is FOR, so the list is a to-do rather than a pile of
  // noise — and so that a NINTH one, added by accident in a future migration,
  // fails the build instead of joining a silently growing pile.
  const baselineFile = path.join(__dirname, 'capability-baseline.json');
  let baseline = { entries: [] };
  try { baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')); } catch (err) { /* none yet */ }
  const known = new Set((baseline.entries || []).map((e) => e.table));
  const fresh = dead.filter((r) => !known.has(r.name));

  if (!AS_JSON && STRICT) {
    console.log(`  ${dead.length - fresh.length} baselined capability gap(s) in tools/capability-baseline.json`);
    if (fresh.length) {
      console.log(`  ${fresh.length} NEW table(s) that nothing creates — add a flow, or record the decision in the baseline:`);
      for (const r of fresh) console.log(`    · ${r.name}  (${r.file})`);
    } else {
      console.log('  no new unreachable capability. Every table either has a writer or is a recorded decision.');
    }
  }

  process.exit(fresh.length ? 1 : 0);
}

main();
