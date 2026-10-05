'use strict';
// =====================================================================
// tools/name-audit.js — NAMES THAT ARE USED BUT NEVER DEFINED
// =====================================================================
// A missing name is invisible to every tool this project already has:
//
//   * `node --check` parses the file and never resolves an identifier.
//   * A unit or integration test that does not call that exact route passes.
//   * A code review reads `describeProfile(code)` and sees a function being
//     called, which is exactly what it is.
//
// It only fails when somebody uses the feature — and it fails as a 500 with the
// name in the message, which is at least honest, but arrives as "the returns
// screen is broken" rather than "line 517 forgot an import".
//
// Three of these had shipped in this codebase: `describeProfile` (catalogue
// profiles), `ROLES` spread as if it were an array (creating any user), and
// `newId` in the sales-target route. All three read perfectly.
//
// So this walks the source, strips comments and string/template literals (which
// is what makes it tolerable — every SQL function call disappears with them),
// and reports any identifier called as a function that the file neither imports
// nor declares. It is deliberately crude and deliberately biased against false
// positives: anything destructured anywhere in the file counts as declared.
//
// Usage: node tools/name-audit.js [--strict]
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['server', 'domain'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.data', 'dist', 'build', 'migrations']);

// Names provided by the runtime on both Node and Workers. A name that is not on
// this list and is not declared in the file is a bug.
const GLOBALS = new Set([
  'require', 'module', 'exports', 'console', 'process', 'globalThis', 'Buffer', '__dirname', '__filename',
  'JSON', 'Math', 'Date', 'Object', 'Array', 'Number', 'String', 'Boolean', 'BigInt', 'Symbol', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Proxy', 'Reflect', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Intl', 'Function', 'AsyncFunction',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'structuredClone', 'fetch', 'Headers', 'Request', 'Response', 'URL', 'URLSearchParams', 'FormData', 'AbortController',
  'crypto', 'atob', 'btoa', 'TextEncoder', 'TextDecoder', 'caches', 'WebSocket', 'localStorage', 'navigator', 'window',
  'document', 'self', 'location', 'history', 'performance', 'matchMedia', 'Notification', 'indexedDB', 'IDBKeyRange',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'getComputedStyle', 'alert', 'confirm', 'prompt',
  'requestAnimationFrame', 'cancelAnimationFrame', 'print', 'open', 'close', 'focus', 'scrollTo',
  'BigInt64Array', 'BigUint64Array', 'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'await', 'yield', 'case',
]);

// SQL functions, which appear inside interpolated template holes where SQL text
// and JavaScript cannot be told apart by any lexer. Listing them by name is
// honest: they are not JavaScript, and none of them is ever a JS identifier here.
const SQL_FUNCTIONS = new Set([
  'COUNT', 'SUM', 'COALESCE', 'IFNULL', 'NULLIF', 'MAX', 'MIN', 'AVG', 'ROUND', 'ABS', 'IN', 'NOT', 'AND', 'OR',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'VALUES', 'datetime', 'date', 'time', 'strftime', 'julianday', 'unixepoch',
  'LENGTH', 'LOWER', 'UPPER', 'SUBSTR', 'printf', 'CAST', 'GROUP_CONCAT', 'ROW_NUMBER', 'EXISTS', 'TYPEOF',
  'DISTINCT', 'CURRENT_TIMESTAMP', 'randomblob', 'hex', 'lower', 'upper', 'json_extract', 'INSTR', 'TRIM', 'REPLACE',
]);

const RESERVED_CALL_LIKE = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'yield', 'in', 'of', 'do', 'else', 'function', 'class', 'super', 'import', 'export', 'void', 'delete', 'instanceof', 'default', 'case', 'try', 'throw', 'with', 'extends', 'static', 'get', 'set', 'async']);

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) yield full;
  }
}

/** Remove comments and every kind of string literal, preserving line breaks. */
function stripLiterals(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  // The last significant character decides whether a `/` opens a REGEX or is
  // division. This is the standard heuristic: after a value (identifier, number,
  // closing bracket) a slash divides; anywhere else it opens a regex. Without it,
  // `/^\d{4}$/` and `/['"]/` were read as strings starting at the first quote
  // inside them, and the rest of the file disappeared into "a string".
  let last = '';
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { while (i < n && source[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next !== '/' && next !== '*' && !/[\w$)\]}'"]/.test(last || '')) {
      // A regex literal: skip to the closing slash, honouring escapes and classes.
      i += 1;
      let inClass = false;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) { i += 1; break; }
        else if (source[i] === '\n') break;
        i += 1;
      }
      while (i < n && /[a-z]/.test(source[i])) i += 1; // flags
      out += ' ';
      last = ')';
      continue;
    }
    if (ch === '/' && next === '*') { i += 2; while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') out += '\n'; i += 1; } i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '\n') out += '\n';
        if (source[i] === quote) { i += 1; break; }
        // Keep `${ ... }` holes: they contain real code with real names.
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          let braces = 1;
          out += ' ';
          i += 2;
          while (i < n && braces > 0) {
            if (source[i] === '{') braces += 1;
            else if (source[i] === '}') braces -= 1;
            if (braces > 0) out += source[i];
            i += 1;
          }
          // `continue` rather than falling through: `i` is already past the
          // hole's closing brace, and the bottom increment would step over the
          // next character. When that character is the template's closing
          // backtick — `\`${field} is required\`` does exactly this — the literal
          // never closes and the scanner swallows the rest of the file.
          continue;
        }
        i += 1;
      }
      // A literal becomes a single space so `a"b"` does not fuse into `ab`.
      out += ' ';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) last = ch;
    i += 1;
  }
  return out;
}

/** Every name the file brings into scope, however it does it. */
function declaredNames(code) {
  const names = new Set();

  // import { a, b as c } from '...' / import a from '...' / import * as ns
  for (const m of code.matchAll(/\bimport\s+([^;]+?)\s+from\s+/g)) {
    for (const part of m[1].split(',')) {
      const cleaned = part.replace(/[{}*]/g, '').trim();
      if (!cleaned) continue;
      const asMatch = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(cleaned);
      if (asMatch) { names.add(asMatch[2]); continue; }
      const bare = cleaned.split(/\s+/)[0];
      if (/^[\w$]+$/.test(bare)) names.add(bare);
    }
  }

  // const/let/var declarations, including destructuring — and including the
  // MULTI-LINE import lists this codebase uses, which a `[^\n]+` pattern misses
  // entirely (it captured only the first line of a fifteen-name require).
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*(?:=|\bof\b|\bin\b)/gs)) {
    const target = m[1].trim();
    if (target.startsWith('{')) {
      for (const part of target.slice(1, target.lastIndexOf('}')).split(',')) {
        const key = part.split(':').pop().trim().split('=')[0].trim();
        if (/^[\w$]+$/.test(key)) names.add(key);
      }
    } else if (target.startsWith('[')) {
      for (const part of target.slice(1, target.lastIndexOf(']')).split(',')) {
        const key = part.split('=')[0].trim();
        if (/^[\w$]+$/.test(key)) names.add(key);
      }
    } else if (/^[\w$]+$/.test(target)) {
      names.add(target);
    } else {
      // `const a = ..., b = ...` on one line
      for (const part of target.split(',')) {
        const key = part.trim().split('=')[0].trim();
        if (/^[\w$]+$/.test(key)) names.add(key);
      }
    }
  }

  // function declarations, classes, function expressions with a name
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([\w$]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:get|set)\s+([\w$]+)\s*\(/g)) names.add(m[1]);
  // Object-literal method shorthand and object keys: `{ handler(ctx) { ... } }`.
  for (const m of code.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([\w$]+)/g)) names.add(m[1]);

  // EVERY destructured or plain parameter anywhere. Deliberately generous:
  // treating a name as declared when it is not only risks a missed finding,
  // while the reverse makes the tool cry wolf.
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const raw = part.trim();
      if (!raw) continue;
      const braced = /\{([^}]*)\}/.exec(raw);
      if (braced) {
        for (const inner of braced[1].split(',')) {
          const key = inner.split(':').pop().split('=')[0].trim();
          if (/^[\w$]+$/.test(key)) names.add(key);
        }
        continue;
      }
      const key = raw.split('=')[0].replace(/\.\.\./, '').trim();
      if (/^[\w$]+$/.test(key)) names.add(key);
    }
  }
  for (const m of code.matchAll(/\b(?:for|of)\s*\(\s*(?:const|let|var)?\s*\{?([\w$]+)/g)) names.add(m[1]);

  return names;
}

/** Index of the `)` matching the `(` at `openIndex`, ignoring nothing but nesting. */
function matchParen(text, openIndex) {
  if (openIndex < 0) return -1;
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Every identifier used in call position, or after `new`. */
function calledNames(code) {
  const found = new Map();
  // The lookbehind matters: without it, `parts.join()` reports `join` as an
  // undefined function, and the tool becomes 900 findings of noise that hide the
  // three that matter.
  const re = /(?<![.\w$])(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    if (RESERVED_CALL_LIKE.has(name)) continue;
    // A name followed by `( ... ) {` is a METHOD DEFINITION, not a call —
    // `first(sql, bind) {` inside an object literal, or `constructor() {` in a
    // class. Skipping those is what keeps this tool from reporting the database
    // adapter's own methods as undefined.
    const close = matchParen(code, code.indexOf('(', m.index));
    const after = close < 0 ? '' : code.slice(close + 1).replace(/^\s+/, '')[0];
    if (after === '{') continue;
    if (!found.has(name)) {
      found.set(name, code.slice(0, m.index).split('\n').length);
    }
  }
  // Also names used as values without being called: `x ?? y`, `typeof x`.
  return found;
}

function auditFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripLiterals(raw);
  const declared = declaredNames(code);
  const findings = [];
  for (const [name, line] of calledNames(code)) {
    if (declared.has(name) || GLOBALS.has(name) || SQL_FUNCTIONS.has(name)) continue;
    // `Foo.bar()` — the head is a member, not a bare call; skip those, since
    // the receiver is a value the file already had to declare.
    findings.push({ name, line });
  }
  return findings;
}

/**
 * A documented list of findings this scanner cannot get right, with the reason
 * for each.
 *
 * Every one is text inside a template interpolation hole — a space in a
 * customer-facing message that happens to read like a call — or a declaration
 * past a template the scanner mis-lexes. They are listed rather than silenced
 * because a baseline that is written down can be audited, and because the value
 * of this tool is the NEXT finding, not the ones already understood.
 */
function loadBaseline() {
  const file = path.join(__dirname, 'name-audit-baseline.json');
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed.entries || []).map((e) => `${e.file}|${e.name}`);
  } catch (e) {
    console.error('name-audit: the baseline file is not valid JSON:', e.message);
    return [];
  }
}

function main() {
  const strict = process.argv.includes('--strict');
  const files = [];
  for (const dir of SCAN_DIRS) files.push(...walk(path.join(ROOT, dir)));

  const baseline = new Set(loadBaseline());
  let scanned = 0;
  let known = 0;
  const findings = [];
  for (const file of files) {
    scanned += 1;
    const rel = path.relative(ROOT, file);
    for (const f of auditFile(file)) {
      if (baseline.has(`${rel}|${f.name}`)) { known += 1; continue; }
      findings.push({ ...f, file: rel });
    }
  }

  console.log('StockRidge name audit');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`files scanned : ${scanned}`);
  console.log(`baselined     : ${known} known false positive(s), listed in tools/name-audit-baseline.json`);

  if (!findings.length) {
    console.log('undefined     : none — every function called is imported or declared in its file');
    console.log('──────────────────────────────────────────────────────────');
    return 0;
  }

  console.log(`undefined     : ${findings.length} name(s) called but never defined`);
  console.log('──────────────────────────────────────────────────────────');
  for (const f of findings) console.log(`  ${f.file}:${f.line} — ${f.name}()`);
  console.log('');
  console.log('Each of these is a 500 waiting for the one user who opens that screen.');
  return 1;
}

module.exports = { auditFile, stripLiterals, declaredNames, calledNames };

if (require.main === module) {
  const code = main();
  if (code && !process.argv.includes('--strict')) {
    // Run interactively (no --strict): report and exit 0 so it can be piped into
    // a pager without pretending the shell failed.
    process.exit(0);
  }
  process.exit(process.argv.includes('--strict') ? code : 0);
}
