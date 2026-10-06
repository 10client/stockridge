'use strict';
// =====================================================================
// test/unit/test-hygiene.test.js — THE TESTS AGAINST THE WALL CLOCK
// =====================================================================
// A suite that fails between midnight and ten in the morning is worse than no
// suite: it teaches everyone to re-run it, and then a real failure gets re-run
// too.
//
// This was not hypothetical. Five e2e tests stamped their sales at a FIXED HOUR
// OF TODAY:
//
//     sold_at: `${watToday()} 10:00:00`
//
// which is a sensible-looking way to make a report deterministic — the sale lands
// on today's books whatever time the suite runs — and it is a landmine. A sale
// cannot be stamped in the future: the sales service allows a few minutes of
// device clock drift and refuses the rest ("That sale is stamped 296 minutes in
// the future, beyond the 10-minute tolerance for device clock drift"). Run the
// suite at 05:04 West Africa Time and every one of those sales is refused, so the
// takings, return, target and safe tests all fail — for a reason that has nothing
// to do with the code they are testing. CI runs at whatever hour it runs.
//
// Two more sent `new Date().toISOString()` — UTC — where the schema stores West
// Africa Time. That is an hour in the past for most of the day and the PREVIOUS
// DAY between 23:00 and midnight UTC, so a test asserting "this sale is on
// today's books" fails for one hour a day.
//
// The rule below is exact, and it is the rule they broke: a sale timestamp written
// by a test must be `watNow()`, or a date that is explicitly in the past.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test');

function testFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('a test never stamps a sale at a fixed hour of today, or in UTC', () => {
  // Proved to fire before being trusted: putting `${watToday()} 10:00:00` back
  // into one of the e2e files is reported at the exact line. It reported FALSE
  // positives on its first run — a line with a field after the timestamp, and its
  // own source text — so the value is read as everything up to the first comma,
  // and this file is skipped by the UTC scan, which would otherwise match the
  // regex written on the line below.
  const SELF = path.basename(__filename);
  const offenders = [];
  for (const file of testFiles(TEST_DIR)) {
    if (path.basename(file) === SELF) continue;
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      const at = line.indexOf('sold_at:');
      if (at === -1) return;
      // Everything after the colon, up to the first comma that ends the value.
      // `watNow(), device_id: 'x'` must read as `watNow()`, not as a whole line.
      const rest = line.slice(at + 'sold_at:'.length).trim();
      let depth = 0; let q = null; let value = rest;
      for (let j = 0; j < rest.length; j += 1) {
        const ch = rest[j];
        if (q) { if (ch === '\\') j += 1; else if (ch === q) q = null; continue; }
        if (ch === '`' || ch === "'" || ch === '"') { q = ch; continue; }
        if ('({['.includes(ch)) depth += 1;
        else if (')}]'.includes(ch)) depth -= 1;
        else if (ch === ',' && depth === 0) { value = rest.slice(0, j).trim(); break; }
      }
      if (value === 'watNow()') return;
      if (/addDays\(\s*watToday\(\)/.test(value)) return;      // a deliberate past date
      if (/^[`'"]20\d\d-\d\d-\d\d/.test(value)) return;          // a hard-coded past date
      offenders.push(`${path.relative(ROOT, file)}:${i + 1}  sold_at: ${value}`);
    });
    if (/sold_at[^\n]*toISOString/.test(source)) {
      const line = source.slice(0, source.search(/sold_at[^\n]*toISOString/)).split('\n').length;
      offenders.push(`${path.relative(ROOT, file)}:${line}  sold_at: …toISOString() — that is UTC where the schema stores WAT`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'these stamp a sale at a time that depends on WHEN the suite runs:\n  ' + offenders.join('\n  ')
    + '\n    use watNow() for "now", or addDays(watToday(), -N) for a deliberate past date',
  );
});
