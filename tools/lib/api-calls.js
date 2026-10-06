'use strict';
// =====================================================================
// test/helpers/api-calls.js — WHAT THE BROWSER ASKS THE SERVER FOR
// =====================================================================
// Every `/api` call in the client source, as `{ method, pathname, … }`, read
// statically. Two contract tests compare these against the server's route table:
//
//   frontend-contract.test.js   does the endpoint exist, with the right method
//   frontend-routes.test.js     the same, plus the reverse direction
//   capability-audit.js         which routes no screen ever asks for
//
// THIS FILE EXISTS BECAUSE THERE WERE TWO READERS AND THEY DISAGREED.
//
// Each test grew its own extractor. Both were regexes that stopped at the first
// quote or backtick, so a TEMPLATE LITERAL CONTAINING ANOTHER TEMPLATE was read
// as a truncated mess:
//
//     SR.api.get(`/api/compliance/checklist${branchId ? `?branch_id=${x}` : ''}`)
//
// The first extractor reported `/api/compliance/checklist${branchId ? ` as a
// route the server does not have; the second reported it too, in different words,
// after the first had been fixed — and a THIRD reader inside capability-audit.js
// then listed `/api/compliance/alerts` as a route no screen calls, which is the
// same mistake wearing a different hat. Fixing one copy left the others wrong.
// That is the whole argument for one reader: the client source is data, and
// several readers of the same data drift apart in silence.
//
// WHAT IS HANDLED, and each of these was a real false report before it was:
//
//   quotes and backticks, including NESTED templates and ternaries inside `${}`
//   a placeholder occupying a whole segment  →  `*`   (`/api/tills/${id}/close`)
//   a placeholder glued to a segment        →  dropped (it carries a query string:
//                                               `checklist${qs}` is not `checklist*`)
//   `?query=…`                              →  stripped; a query string is not
//                                               part of a route path
//   `SR.api.del(...)`                       →  DELETE on the wire, not `DEL`
//   `SR.api.request('POST', …)`             →  the method is the first argument
//
// It is static on purpose: a request cannot distinguish "route missing" from "you
// sent no body" without a fake database that reimplements half the app.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

/** The HTTP verb behind each helper's name. `del` is DELETE, not DEL. */
const HELPER_VERB = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE', delete: 'DELETE' };

/** Every .js file under a directory, recursively. */
function jsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Read the string or template literal starting at `from`.
 *
 * A scanner rather than a character class, because a template literal may contain
 * backticks of its own. Returns `{ text, end }`, or null when this is not a
 * literal.
 */
function readLiteral(source, from) {
  const open = source[from];
  if (open !== '`' && open !== "'" && open !== '"') return null;
  if (open !== '`') {
    const close = source.indexOf(open, from + 1);
    if (close === -1) return null;
    return { text: source.slice(from + 1, close), end: close + 1, template: false };
  }
  let i = from + 1;
  let out = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { out += ch + (source[i + 1] || ''); i += 2; continue; }
    if (ch === '`') return { text: out, end: i + 1, template: true };
    if (ch === '$' && source[i + 1] === '{') {
      // Walk the interpolation to its matching brace, counting nested braces and
      // stepping over nested literals — including backticks.
      let j = i + 2;
      let braces = 1;
      while (j < source.length && braces > 0) {
        const c = source[j];
        if (c === '{') { braces += 1; j += 1; continue; }
        if (c === '}') { braces -= 1; j += 1; continue; }
        if (c === '`' || c === "'" || c === '"') {
          const sub = readLiteral(source, j);
          if (sub) { j = sub.end; continue; }
        }
        j += 1;
      }
      // A hole that occupies a WHOLE SEGMENT is one unknown segment (`*`); a hole
      // glued to the end of a segment is dropped.
      const prev = out.slice(-1);
      out += (prev === '/' || prev === '') ? '*' : '';
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return null;
}

/**
 * Every `SR.api.<verb>(<literal>)` call in the client source.
 *
 * Returns `{ file, line, method, pathname, raw, sourceHint }`, where `pathname` is
 * the route-shaped path: whole-segment holes as `*`, query strings removed.
 */
function apiCalls({ dir = path.join(ROOT, 'public', 'js') } = {}) {
  const calls = [];
  for (const file of jsFiles(dir)) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    const patterns = [
      /SR\.api\.(get|post|put|patch|del|delete)\s*\(\s*/g,
      /SR\.api\.request\s*\(\s*'([A-Z]+)'\s*,\s*/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(source)) !== null) {
        // Line number, for a failure message somebody can act on.
        const line = source.slice(0, m.index).split('\n').length;
        const isRequest = re.source.includes('request');
        const read = readLiteral(source, re.lastIndex);
        if (!read) continue;
        const literal = read.text;
        if (!literal.startsWith('/api')) continue;
        const method = isRequest
          ? String(m[1]).toUpperCase()
          : (HELPER_VERB[m[1]] || String(m[1]).toUpperCase());
        // The query is stripped AFTER the holes are resolved: the first `?` in a
        // template may be a ternary inside an interpolation, not a query string.
        const pathname = literal.replace(/\?[^`]*$/, '').replace(/\/+$/, '') || '/api';
        calls.push({
          file: path.relative(ROOT, file),
          line,
          method,
          pathname,
          raw: literal.slice(0, 90),
          sourceHint: (lines[line - 1] || '').trim(),
        });
      }
    }
  }
  return calls;
}

/** Server-side route pattern as a matcher: `:param` is one segment, `*` is the rest. */
function patternMatches(pattern, pathname) {
  const p = String(pattern).split('/');
  const q = String(pathname).split('/');
  for (let i = 0; i < Math.max(p.length, q.length); i += 1) {
    const seg = p[i];
    if (seg === undefined) return false;
    if (seg.startsWith(':')) continue;
    if (seg === '*') return true;
    if (seg !== q[i]) return false;
  }
  return true;
}

module.exports = { ROOT, jsFiles, readLiteral, apiCalls, patternMatches, HELPER_VERB };
