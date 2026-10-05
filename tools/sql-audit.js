'use strict';
// =====================================================================
// tools/sql-audit.js — STATIC AUDIT OF EVERY HAND-WRITTEN STATEMENT
// =====================================================================
// WHY THIS TOOL EXISTS
//
// StockRidge writes its SQL by hand. That is deliberate: an ORM would hide
// the exact statement that runs, and the statements here carry CHECK
// constraints, partial unique indexes and WAT date arithmetic that need to be
// visible. The cost is a whole class of bug that no type checker catches —
// a column list and a VALUES list that disagree.
//
// SQLite reports those as "34 values for 32 columns", which names no
// statement. In a sale that queues thirty writes, that message is nearly
// useless. Three such mismatches existed in the sale path before this tool was
// written, and every one of them meant the flow had never actually run.
//
// So this audits the source statically: for every INSERT it finds, it counts
// the columns and the value slots and reports any disagreement. It runs in CI
// and before a release, and it costs milliseconds.
//
// WHAT IT DOES NOT DO
//
// It cannot count the parameters a JS expression array will actually supply —
// that needs evaluation, not parsing. `server/lib/db.js` covers that at
// runtime instead: every statement failure is rethrown naming the SQL, the
// placeholder count and the value count. Between the two, a mismatch is caught
// either before the code ships or at the exact line that caused it.
//
// Usage: node tools/sql-audit.js [--strict]
//   --strict  exit non-zero on any finding (for CI)
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['server', 'domain', 'worker', 'tools'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.data', 'dist', 'build']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      yield full;
    }
  }
}

/**
 * Split a comma-separated list at depth zero.
 *
 * Naive `split(',')` breaks on `datetime('now', '-1 days')`, on `CASE WHEN a
 * THEN b, c END`, and on `MAX(0, x)`. Everything inside parentheses, brackets
 * or a quoted string is skipped.
 */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      // A `${...}` hole inside a template literal can contain anything,
      // including NESTED template literals with commas in them — `\`a${x ? \`b, c\` : ''}\``
      // is one value, not two. Treating the inner backtick as the end of the
      // outer literal splits the argument list, which reported a correct
      // statement as having one value too many.
      if (quote === '`' && ch === '$' && text[i + 1] === '{') {
        let braces = 0;
        let j = i + 1;
        for (; j < text.length; j += 1) {
          const c = text[j];
          if (c === '\\') { j += 1; continue; }
          if (c === '`' || c === "'" || c === '"') {
            const inner = c;
            j += 1;
            while (j < text.length) { if (text[j] === '\\') { j += 1; } else if (text[j] === inner) break; j += 1; }
            continue;
          }
          if (c === '{') braces += 1;
          else if (c === '}') { braces -= 1; if (braces === 0) break; }
        }
        current += text.slice(i, j + 1);
        i = j;
        continue;
      }
      current += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    // Comments are skipped, not counted. A comma inside a `//` comment sits at
    // depth zero and splits a parameter list that has nothing wrong with it —
    // which is how this tool reported a correct 23-value INSERT as having 25.
    if (ch === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl - 1; continue; }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; current += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; current += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Find the closing paren matching the open paren at `start`. */
function matchParen(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Count the value slots in each row of a VALUES clause.
 *
 * `text` starts AT the `(` that follows VALUES. A single-row insert yields one
 * count; `VALUES (a,b),(c,d)` yields two, and every row must match the column
 * count.
 *
 * THE TRAP THIS AVOIDS: the paren in `datetime('now')` or `MAX(0, x)` is not a
 * row boundary. Treating it as one reports a healthy statement as having a
 * one-value row — which is exactly what the first version of this tool did,
 * producing 143 false findings and hiding the three real ones. A row group is
 * only ever the paren immediately after VALUES, or one that follows a
 * top-level comma.
 */
function countValueSlots(text) {
  const rows = [];
  let i = 0;
  const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  skipWs();
  while (i < text.length && text[i] === '(') {
    const end = matchParen(text, i);
    if (end < 0) break;
    rows.push(splitTopLevel(text.slice(i + 1, end)).length);
    i = end + 1;
    skipWs();
    if (text[i] !== ',') break;
    i += 1;
    skipWs();
    if (text[i] !== '(') break; // a trailing comma is not another row
  }
  return rows;
}

/**
 * Find SELECT statements that do not specify an order.
 *
 * WHY THIS IS A BUG AND NOT A STYLE PREFERENCE
 *
 * Every primary key in this schema is a random hex string, not an INTEGER
 * rowid alias. A `SELECT ... WHERE is_deleted = 0` with no ORDER BY is free to
 * return rows in whatever order the chosen index or scan produces, and that
 * order depends on those random ids. It therefore varies between runs of the
 * same query over the same logical data.
 *
 * Two consequences were observed while building the seed:
 *   - `selectBatchesFifo` broke receipt-time ties on `id`, so FIFO cost
 *     allocation picked a different batch each run and margin history was not
 *     reproducible.
 *   - the branch list came back in a different order per run, so each branch
 *     drew a different slice of the seeded random stream and the whole fixture
 *     changed shape.
 *
 * In production the same defect shows up as a list that reorders itself on
 * refresh, and — worse — as pagination that skips or repeats rows, because
 * LIMIT/OFFSET over an unordered result set has no defined meaning.
 *
 * Excluded, because order genuinely does not matter:
 *   - single-aggregate queries (COUNT/SUM/MAX/MIN/AVG/EXISTS) returning one row
 *   - lookups pinned to a unique key (`WHERE id = ?`), which return at most one
 */
const AGGREGATE_ONLY = /^SELECT\s+(?:DISTINCT\s+)?(?:COUNT|SUM|MAX|MIN|AVG|TOTAL|EXISTS|GROUP_CONCAT)\s*\(/i;

/**
 * A WHERE clause that pins at most one row, so order cannot matter.
 *
 * Covers the primary key and every UNIQUE column in the schema. A lookup on one
 * of these returns zero or one row and is not a finding.
 */
// A pin may be a bound `?` or a literal (`WHERE id = 1`); either way the query
// can return at most one row, so order is meaningless.
// A WHERE clause that pins the query to at most one row, because the column it
// tests is a primary key or carries a UNIQUE index. The bare `id` is by far the
// most common; the named ones are the human references that the schema also
// makes unique (receipt numbers, serial numbers, job numbers, codes).
//
// `${spec.pk} = ?` appears where the table name is a variable (the sync module's
// whitelist). It is a primary-key test too, so the template is accepted.
const PIN_COLUMNS = 'id|key|device_id|username|barcode|serial_no|claim_code|session_id|plan_no|receipt_no|job_no'
  + '|reference|code|token|idempotency_key|user_id|sku|po_number|invoice_no|entry_no|email';
const UNIQUE_PIN = new RegExp(
  'WHERE[^]*?(?:'
  // A column name, optionally table-qualified: `s.id`, `p.sku`.
  + `\\b${PIN_COLUMNS}\\b`
  // A primary key injected through a template literal, as the sync whitelist
  // does with `${spec.pk}`. There is no word boundary before `$`, so it needs
  // its own alternative rather than riding on the column list above.
  + '|\\$\\{[^}]*\\}'
  + ')\\s*=\\s*(?:\\?|\\d+|\'[^\']*\')',
  'i',
);

// A query with no GROUP BY that returns only aggregates yields EXACTLY ONE row,
// always. `db.first()` on it is not "an arbitrary row" — it is "the row". The
// checker used to flag `SELECT COALESCE(SUM(x),0) AS total ...` as arbitrary for
// every dashboard tile in the app, which buried the handful of findings that
// were real under eighteen that could not be.
const ROW_AGGREGATE = /^SELECT\s+(?:[^;]*?\b(?:SUM|COUNT|MIN|MAX|AVG|TOTAL|GROUP_CONCAT)\s*\()/i;

/** Introspection and bookkeeping tables, where row order is meaningless. */
const NON_DOMAIN_TABLE = /\b(?:sqlite_master|sqlite_sequence|_migrations|pragma_)\b/i;

function auditUnorderedSelects(source, relPath) {
  const findings = [];
  const candidates = [];
  const backtick = /`([^`]*)`/g;
  let m;
  while ((m = backtick.exec(source)) !== null) candidates.push({ text: m[1], at: m.index });
  const quoted = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  while ((m = quoted.exec(source)) !== null) {
    const text = m[1] != null ? m[1] : m[2];
    if (text && /SELECT/i.test(text)) candidates.push({ text, at: m.index });
  }

  for (const cand of candidates) {
    const flat = cand.text.replace(/\s+/g, ' ').trim();
    if (!/\bSELECT\b/i.test(flat)) continue;
    if (/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b/i.test(flat)) continue;
    if (/\bORDER BY\b/i.test(flat)) continue;
    const afterSelect = flat.slice(flat.search(/\bSELECT\b/i));
    if (AGGREGATE_ONLY.test(afterSelect)) continue;
    if (NON_DOMAIN_TABLE.test(flat)) continue;
    if (UNIQUE_PIN.test(flat)) continue;
    // Aggregates with no GROUP BY cannot return more than one row.
    if (ROW_AGGREGATE.test(afterSelect) && !/\bGROUP BY\b/i.test(flat)) continue;

    // Is this the query behind a db.first()? Look back through the surrounding
    // source for the call that received it. `first` promises "the" row, so an
    // unpinned, unordered query behind it returns an arbitrary one — and the
    // caller has no way to tell.
    const context = source.slice(Math.max(0, cand.at - 160), cand.at);
    const viaFirst = /\bfirst\s*\(\s*$/.test(context);
    const single = /\bLIMIT\s+1\b/i.test(flat) || viaFirst;
    if (!single) continue; // list queries are advisory only; see --verbose

    findings.push({
      file: relPath,
      line: source.slice(0, cand.at).split('\n').length,
      severity: 'HIGH',
      kind: viaFirst
        ? 'db.first() on an unordered, unpinned query returns an arbitrary row'
        : 'LIMIT 1 with no ORDER BY picks an arbitrary row',
      sql: flat.slice(0, 150),
    });
  }
  return findings;
}

/**
 * Count the top-level elements of the array literal that supplies a statement's
 * parameters.
 *
 * Returns null when the argument is not a literal array (a variable, a spread,
 * a function call) — the audit would rather say nothing than guess. Elements are
 * assumed to contribute exactly one parameter, which is true for every call site
 * in this codebase: a `?` is never bound to a nested array.
 */
/**
 * The index of the `)` that closes the `(` at `openIndex`, IGNORING characters
 * inside string and template literals and comments.
 *
 * The naive version of this counts a `)` inside `datetime('now')` as closing the
 * call, which made the placeholder audit report twelve mismatches in code that
 * was correct — every one of them a statement containing a function call in its
 * SQL. A tool that cries wolf is worse than no tool, so it has to understand the
 * text it is reading.
 */
function matchParenCode(source, openIndex) {
  return matchDelimiter(source, openIndex, '(', ')');
}

/**
 * The literal-aware way to find the delimiter that closes the one at
 * `openIndex`. Used for calls (parens) AND for array literals (brackets) —
 * matching an array with a paren matcher returns the first `)` inside it, which
 * is how this tool once reported a perfectly correct three-value statement as
 * having one value.
 */
function matchDelimiter(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '/' && source[i + 1] === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          // A ${...} hole can contain braces and parens of its own; skip it by
          // balancing braces.
          let braces = 1;
          i += 2;
          while (i < source.length && braces > 0) {
            if (source[i] === '{') braces += 1;
            else if (source[i] === '}') braces -= 1;
            i += 1;
          }
          continue;
        }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === openChar) { depth += 1; i += 1; continue; }
    if (ch === closeChar) { depth -= 1; if (depth === 0) return i; i += 1; continue; }
    i += 1;
  }
  return -1;
}

function countParamElements(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('[')) return null;
  const close = matchDelimiter(trimmed, 0, '[', ']');
  if (close < 0) return null;
  const inner = trimmed.slice(1, close).trim();
  if (!inner) return 0;
  return splitTopLevel(inner).length;
}

/**
 * Every literal statement call — `db.run(\`SQL\`, [...])`, `tx.queue(...)` — whose
 * placeholder count does not match the number of values handed to it.
 *
 * WHY THIS IS SEPARATE FROM THE COLUMN/VALUE AUDIT
 *
 * The column/value audit compares an INSERT's column list to its VALUES tuple,
 * which catches a forgotten column. It cannot catch a VALUES tuple that has one
 * MORE `?` than the params array has values — that mismatch is invisible in the
 * SQL text alone, and SQLite reports it as "Too few parameter values were
 * provided … the statement has 8 placeholder(s) but received 7 value(s)", naming
 * no statement. One such statement shipped in POST /api/stocktakes, where it
 * made OPENING ANY STOCKTAKE fail with a 500, and it survived every test until
 * a route was executed end to end.
 *
 * Template literals with interpolations are skipped: their placeholder count
 * cannot be known without evaluating the expression.
 */
function auditPlaceholders(source, relPath) {
  const findings = [];
  const callRe = /\b(?:db\.(?:run|all|first|scalar)|tx\.queue)\s*\(\s*(`(?:[^`\\]|\\.)*`)/g;
  let m;
  while ((m = callRe.exec(source)) !== null) {
    const literal = m[1];
    const sql = literal.slice(1, -1);
    if (sql.includes('${')) continue;          // dynamic: not statically knowable
    // m[0] ends at the closing backtick, NOT at the open paren, so the paren has
    // to be located inside the match. Using m[0].length - 1 here pointed at the
    // backtick and made every finding wrong.
    const openParen = m.index + m[0].indexOf('(');
    const closeParen = matchParenCode(source, openParen);
    if (closeParen < 0) continue;
    const args = splitTopLevel(source.slice(openParen + 1, closeParen));
    const params = countParamElements(args[1]);
    if (params === null) continue;             // not a literal array: skip
    const placeholders = (sql.match(/\?/g) || []).length;
    if (placeholders !== params) {
      findings.push({
        file: relPath,
        line: source.slice(0, m.index).split('\n').length,
        placeholders,
        params,
        statement: sql.replace(/\s+/g, ' ').trim().slice(0, 140),
      });
    }
  }
  return findings;
}

function auditFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const findings = [];
  const re = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][\w]*)\s*\(/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    const table = m[1];
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchParen(source, openParen);
    if (closeParen < 0) continue;
    const columns = splitTopLevel(source.slice(openParen + 1, closeParen));

    // Skip `INSERT INTO t DEFAULT VALUES`, select-driven inserts, and the
    // `INSERT ... SELECT` form: none of them has a VALUES tuple to count.
    const rest = source.slice(closeParen + 1, closeParen + 600);
    const valuesMatch = /\bVALUES\b/i.exec(rest);
    if (!valuesMatch) continue;
    let cursor = closeParen + 1 + valuesMatch.index + valuesMatch[0].length;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== '(') continue; // VALUES ? or DEFAULT VALUES
    const rows = countValueSlots(source.slice(cursor));
    if (!rows.length) continue;

    const line = source.slice(0, m.index).split('\n').length;
    for (const [idx, count] of rows.entries()) {
      if (count !== columns.length) {
        findings.push({
          file: path.relative(ROOT, file), line, table,
          columns: columns.length, values: count, row: rows.length > 1 ? idx + 1 : null,
          columnList: columns.join(', '),
        });
      }
    }
  }
  return findings;
}

function main() {
  const strict = process.argv.includes('--strict');
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) files.push(...walk(full));
  }

  let scanned = 0;
  let inserts = 0;
  const findings = [];
  const placeholders = [];
  const unordered = [];
  const checkOrder = !process.argv.includes('--no-order-check');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    scanned += 1;
    inserts += (source.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO/gi) || []).length;
    findings.push(...auditFile(file));
    placeholders.push(...auditPlaceholders(source, path.relative(ROOT, file)));
    if (checkOrder) unordered.push(...auditUnorderedSelects(source, path.relative(ROOT, file)));
  }

  console.log('StockRidge SQL audit');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`files scanned : ${scanned}`);
  console.log(`INSERT statements: ${inserts}`);

  console.log(`column/value  : ${findings.length ? findings.length + ' MISMATCH(ES)' : 'none — every column list matches its VALUES list'}`);
  console.log(`parameters    : ${placeholders.length ? placeholders.length + ' MISMATCH(ES)' : 'none — every literal statement binds as many values as it has placeholders'}`);
  console.log(`arbitrary-row : ${unordered.length || 'none — every single-row query is ordered or uniquely pinned'}`);

  if (placeholders.length) {
    console.log('──────────────────────────────────────────────────────────');
    console.log(`placeholder/value mismatches (${placeholders.length})`);
    for (const f of placeholders) {
      console.log(`  ${f.file}:${f.line} — ${f.placeholders} placeholder(s) but ${f.params} value(s)`);
      console.log(`      ${f.statement}`);
    }
  }

  if (unordered.length) {
    const high = unordered;
    console.log('──────────────────────────────────────────────────────────');
    console.log(`single-row queries that pick an arbitrary row (${high.length})`);
    const grouped = new Map();
    for (const f of unordered) {
      const key = `${f.file}:${f.line}`;
      if (!grouped.has(key)) grouped.set(key, f);
    }
    for (const f of [...grouped.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'HIGH' ? -1 : 1))) {
      console.log(`  [${f.severity}] ${f.file}:${f.line} — ${f.kind}`);
      console.log(`           ${f.sql}`);
    }
  }

  if (!findings.length) {
    console.log('──────────────────────────────────────────────────────────');
    if (strict && (placeholders.length || unordered.some((f) => f.severity === 'HIGH'))) return 1;
    return 0;
  }

  console.log(`findings      : ${findings.length}`);
  console.log('──────────────────────────────────────────────────────────');
  for (const f of findings) {
    console.log(`\n${f.file}:${f.line}  INSERT INTO ${f.table}${f.row ? ` (row ${f.row})` : ''}`);
    console.log(`  ${f.columns} column(s) but ${f.values} value(s)`);
    console.log(`  columns: ${f.columnList}`);
  }
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('A column/value mismatch means the statement has never run successfully.');
  console.log('SQLite would report it as "N values for M columns", naming no statement.');
  return strict ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { auditFile, splitTopLevel, matchParen, countValueSlots };
