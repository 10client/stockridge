'use strict';
// =====================================================================
// tools/service-args-audit.js — CALL SITES THAT PASS THE WRONG KEY NAMES
// =====================================================================
// This checker exists because of a bug that no other tool saw.
//
// A route called:
//
//     await salesService.voidSale(db, { sale: saleId, reason });
//
// but the service reads `saleId`:
//
//     async function voidSale(db, { saleId, reason, userId }) { ... }
//
// `saleId` was therefore `undefined`, three layers down a lookup with
// `WHERE id = undefined` found nothing, and the route answered a perfectly calm
// 404 — "That sale does not exist" — for a sale that was right there. There was
// no type error, no stack trace pointing at the call, and `node --check` is
// happy with both files. Five different places in the codebase throw the same
// SALE_NOT_FOUND text, so reading the error told us nothing either.
//
// `undefined` is the failure mode this project has to defend against hardest,
// because JavaScript never complains about it. So this tool reads the SHAPE of
// every service function's options object and compares it with the keys each
// call site actually passes.
//
// HOW IT WORKS
//   1. Parse `server/services/*.js` for exported functions whose second (or
//      first non-db) parameter is a destructuring pattern. Those parameter names
//      are the keys the function will read.
//   2. Parse every `require`d alias in the calling files so `salesService` and
//      `svc` are both recognised.
//   3. Find `<alias>.<fn>(db, { ... })` calls, collect the object's top-level
//      keys, and report any key the function cannot read.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   It is not a type checker and does not try to be. A key it cannot see through
//   (a spread, a computed name, a passed variable) makes the call UNCHECKED
//   rather than an error — a false accusation costs more than a miss, because it
//   teaches people to ignore the tool.
//
// Run: node tools/service-args-audit.js [--strict]
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');

// ---------------------------------------------------------------------
// 1. What each service function reads
// ---------------------------------------------------------------------
/** Extract the top-level keys of a destructuring pattern source. */
function destructuredKeys(pattern) {
  const keys = [];
  // Strip the enclosing braces: `{ a, b }` becomes ` a, b ` so that the
  // top-level comma scan below starts at depth 0. Without this the whole
  // pattern accumulates as one chunk, no key survives the identifier test, and
  // the tool reports every call site as passing keys the function "cannot read"
  // — the loudest possible way for a checker to be useless.
  let text = String(pattern || '').trim();
  // A default on the WHOLE pattern — `{ a, b } = {}` — must be removed BEFORE
  // the trailing brace is stripped, or `endsWith('}')` eats the wrong one and
  // the scan silently truncates the key list. (This tool shipped with that bug
  // for one run and reported two correct call sites as broken.)
  text = text.replace(/\}\s*=\s*\{[^{}]*\}\s*$/, '}');
  if (text.startsWith('{')) text = text.slice(1);
  if (text.endsWith('}')) text = text.slice(0, -1);
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { push(current); current = ''; continue; }
    current += ch;
  }
  push(current);

  function push(part) {
    const trimmed = part.trim();
    if (!trimmed) return;
    // `{ a, b: c, d = 1, ...rest }` — the KEY is what the caller must send.
    const name = trimmed.split(':')[0].split('=')[0].trim();
    if (!name || name.startsWith('...')) return;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
    keys.push(name);
  }
  return keys;
}

/** What a service module's functions read. */
function serviceShapes() {
  const dir = path.join(ROOT, 'server', 'services');
  const shapes = new Map();   // 'salesService.voidSale' -> Set(keys) | null (positional)

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const moduleName = file.replace(/\.js$/, '');
    const source = fs.readFileSync(path.join(dir, file), 'utf8');

    // Declarations, including `async function` and `const fn = (...) =>`.
    const declRe = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
    let m;
    while ((m = declRe.exec(source)) !== null) {
      const name = m[1];
      const params = splitTopLevel(m[2]);
      // The options object is the first destructured parameter after a db/env.
      const optionsParam = params.find((p) => p.trim().startsWith('{'));
      shapes.set(`${moduleName}.${name}`, optionsParam ? new Set(destructuredKeys(optionsParam)) : null);
    }

    // Also `const x = async (db, { a }) => {}`.
    const arrowRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
    while ((m = arrowRe.exec(source)) !== null) {
      const params = splitTopLevel(m[2]);
      const optionsParam = params.find((p) => p.trim().startsWith('{'));
      if (optionsParam) shapes.set(`${moduleName}.${m[1]}`, new Set(destructuredKeys(optionsParam)));
    }
  }

  // Only the functions the module actually exports are callable from outside.
  const exported = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const moduleName = file.replace(/\.js$/, '');
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const exportBlock = /module\.exports\s*=\s*\{([\s\S]*?)\};/.exec(source);
    if (!exportBlock) continue;
    for (const entry of exportBlock[1].split(',')) {
      const name = entry.split(':')[0].trim();
      if (!name || name.startsWith('//')) continue;
      const key = `${moduleName}.${name}`;
      if (shapes.has(key)) exported.set(key, shapes.get(key));
    }
  }
  return exported;
}

/** Split a parameter list on top-level commas. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0; let current = '';
  for (const ch of text) {
    if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------
// 2. What the call sites pass
// ---------------------------------------------------------------------
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js') && !full.includes(`${path.sep}tools${path.sep}service-args-audit.js`)) {
      out.push(full);
    }
  }
  return out;
}

/** The object literal passed as the options argument, or null if not literal. */
function optionsLiteral(source, callIndex) {
  // Find the `(` after the function name, then the first `{` inside.
  const open = source.indexOf('(', callIndex);
  if (open === -1) return null;
  let depth = 0; let objStart = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === '{' && objStart === -1 && depth === 1) objStart = i;
  }
  if (objStart === -1) return null;

  let d = 0;
  for (let i = objStart; i < source.length; i += 1) {
    const ch = source[i];
    if ('{[('.includes(ch)) d += 1;
    else if ('}])'.includes(ch)) {
      d -= 1;
      if (d === 0) return source.slice(objStart, i + 1);
    }
  }
  return null;
}

function run() {
  const services = serviceShapes();
  const findings = [];
  const checked = [];
  let unchecked = 0;

  // The Node backend and the Cloudflare Worker both import the same services, so
  // both trees are scanned. `worker/` may not exist yet during early work.
  const roots = ['server', 'worker'].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
  const files = roots.flatMap((dir) => walk(dir));

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(ROOT, file);

    // Aliases: `const salesService = require('.../salesService')`
    const aliases = new Map();
    const aliasRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\((['"`])([^'"`]+)\2\)/g;
    let m;
    while ((m = aliasRe.exec(source)) !== null) {
      const target = path.basename(m[3], '.js');
      if (services.size && [...services.keys()].some((k) => k.startsWith(`${target}.`))) aliases.set(m[1], target);
    }
    if (!aliases.size) continue;

    for (const [alias, moduleName] of aliases) {
      const callRe = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
      while ((m = callRe.exec(source)) !== null) {
        const fn = m[1];
        const key = `${moduleName}.${fn}`;
        if (!services.has(key)) continue;
        const allowed = services.get(key);
        if (!allowed) continue;               // positional options: nothing to compare
        const literal = optionsLiteral(source, source.indexOf(m[0], m.index));
        const line = source.slice(0, m.index).split('\n').length;
        if (literal === null) { unchecked += 1; continue; }
        const body = literal.slice(1, -1);
        const keys = [];
        for (const part of splitTopLevel(body)) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('...')) { keys.push('...'); continue; }
          const k = trimmed.split(':')[0].split('=')[0].trim().replace(/^['"]|['"]$/g, '');
          if (/^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k);
          else keys.push('(computed)');
        }
        const spread = keys.includes('...') || keys.includes('(computed)');
        const unknown = keys.filter((k) => !k.startsWith('(') && k !== '...' && !allowed.has(k) && !/^\d/.test(k));
        checked.push({ call: `${moduleName}.${fn}`, file: relative, line });
        if (unknown.length && !spread) {
          findings.push({
            file: relative, line, call: `${moduleName}.${fn}`,
            unknown,
            allowed: [...allowed].sort(),
          });
        }
      }
    }
  }

  if (findings.length) {
    console.error(`\nservice-args-audit: ${findings.length} call site(s) pass a key the service cannot read.\n`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  →  ${f.call}(db, { … })`);
      console.error(`    passes:  ${f.unknown.join(', ')}`);
      console.error(`    reads:   ${f.allowed.join(', ')}`);
      console.error('    A key the function does not destructure is `undefined` inside it — no error, no trace, usually a silent 404.\n');
    }
    console.error(`Checked ${checked.length} options-object call site(s); ${unchecked} could not be resolved statically (spread, variable, or computed).`);
    process.exit(1);
  }

  console.log(`service-args-audit: OK — ${checked.length} options call site(s) checked against ${services.size} service functions.`);
  if (unchecked) console.log(`  ${unchecked} call site(s) could not be resolved statically and were skipped rather than guessed.`);
  if (STRICT && unchecked > 0) {
    console.log('  --strict: unresolved call sites are tolerated because a false accusation is worse than a miss; they are listed above only for review.');
  }
}

run();
