'use strict';
// =====================================================================
// tools/audit-actions.js — THE AUDIT VOCABULARY, RECONCILED WITH ITS WRITERS
// =====================================================================
// `server/lib/audit.js` declares `AUDIT_ACTIONS`: the names the trail is allowed to use.
// It is the vocabulary an auditor reads the log by, and until now nothing checked it
// against the code that writes the log — and the two had drifted almost completely apart.
//
//   · 38 actions were written by routes and were NOT in the vocabulary, including
//     `SESSIONS_REVOKED` (a security event), `CUSTOMER_DELETED`, `MANUAL_JOURNAL_POSTED`
//     and every compliance-register action;
//   · 41 names sat in the vocabulary that NO route has ever written — `SALE_REFUNDED`,
//     `EXPENSE_CREATED`, `USER_ROLE_CHANGED`, `PERMISSION_CHANGED` — names an auditor would
//     grep for and find nothing, while the actions that really happened were recorded under
//     names the vocabulary did not admit existed;
//   · and `SETTINGS_UPDATED` / `PLAN_LIMITS_CHANGED` are written by a TERNARY
//     (`action: planChanges.length ? 'PLAN_LIMITS_CHANGED' : 'SETTINGS_UPDATED'`), which is
//     why a naive grep for `action: '…'` reports them as never written. Every literal in the
//     action expression counts, not just the first one.
//
// This tool reads the writers and the vocabulary and reports the difference in both
// directions; `--write` reconciles the vocabulary to the writers, preserving the existing
// grouping and comments and adding the rest, so the list is a maintained contract rather
// than a wish. `test/unit/audit-actions.test.js` asserts the two agree, which is what stops
// the drift coming back.
//
//   node tools/audit-actions.js            # report the difference, exit 1 if there is any
//   node tools/audit-actions.js --write    # rewrite AUDIT_ACTIONS to match the writers
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AUDIT_LIB = path.join(ROOT, 'server/lib/audit.js');
const SCAN_DIRS = ['server', 'domain', 'worker'];
const WRITERS = /\b(?:record|recordFromCtx|recordDenied)\s*\(/g;

/** Every .js file under the scanned directories, excluding node_modules. */
function sourceFiles(dirs) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  return out;
}

/** Strip comments and string bodies so a name mentioned in prose is not read as a write. */
function codeOnly(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      if (ch === '\\') { out += '  '; i += 2; continue; }
      if (ch === quote) { quote = null; out += ch; i += 1; continue; }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; } continue; }
    if (ch === '/' && next === '*') {
      let end = src.indexOf('*/', i + 2);
      if (end < 0) end = src.length;
      // THE BLANkING MUST NOT CHANGE THE LENGTH. It skipped the two characters of `*/`
      // without emitting anything, so every block comment pulled the rest of the file two
      // characters to the left — and every index computed on the blanked text then pointed
      // somewhere else in the original. That is how this tool's first run reported
      // `CANCELLED`, `CATEGORY` and `AUDIT_LOG` as audit actions: entity types read out of
      // unrelated code, twenty-eight characters away. `lengthPreserving()` below asserts it.
      for (let k = i; k < end + 2 && k < src.length; k += 1) out += src[k] === '\n' ? '\n' : ' ';
      i = Math.min(end + 2, src.length);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The text of one `action:` value — from the key to the end of the expression.
 *
 * The end is the first `,` at brace depth zero, or the closing brace of the object, and
 * the scan skips over STRING LITERALS so a comma inside `'a, b'` does not end it. That is
 * what makes a ternary visible: `planChanges.length ? 'PLAN_LIMITS_CHANGED' : 'SETTINGS_UPDATED'`
 * is one expression and yields two names.
 */
function actionExpression(text, from) {
  let depth = 0;
  let i = from;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i += 1; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) break;
    i += 1;
  }
  return text.slice(from, i);
}

/** Every audit action name the code writes, and where. */
function writtenActions() {
  const found = new Map();
  for (const file of sourceFiles(SCAN_DIRS)) {
    const raw = fs.readFileSync(file, 'utf8');
    const text = codeOnly(raw);
    const rel = path.relative(ROOT, file);
    // Inside a writer call, every `action:` expression contributes each ALL-CAPS literal.
    WRITERS.lastIndex = 0;
    let call;
    while ((call = WRITERS.exec(text))) {
      // The call's argument window, to the matching close paren.
      let depth = 1;
      let i = call.index + call[0].length;
      let quote = null;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (quote) {
          if (ch === '\\') { i += 2; continue; }
          if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        else if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        i += 1;
      }
      const window = text.slice(call.index, i);
      let m;
      const keyRe = /\baction:\s*/g;
      while ((m = keyRe.exec(window))) {
        // THE OFFSET IS ABSOLUTE. `m.index` is relative to the window, and reading `raw`
        // with it pointed the extractor at an unrelated part of the file — which is how a
        // first run of this tool reported `CANCELLED`, `CATEGORY` and `AUDIT_LOG` as audit
        // actions: they are entity TYPES, and they were read from somewhere else entirely.
        // The expression is taken from the original text (where string literals still
        // exist) at the absolute position, so a ternary contributes both of its names.
        const expr = actionExpression(raw, call.index + m.index + m[0].length);
        for (const lit of expr.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) {
          const name = lit[1];
          if (!found.has(name)) found.set(name, new Set());
          found.get(name).add(rel);
        }
      }
    }
  }
  return found;
}

/** The names of one `Object.freeze([...])` block, in the order they appear. */
function blockNames(name) {
  const src = fs.readFileSync(AUDIT_LIB, 'utf8');
  const start = src.indexOf(`const ${name} = Object.freeze([`);
  if (start < 0) return null;
  const end = src.indexOf(']);', start);
  return [...src.slice(start, end).matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)].map((m) => m[1]);
}

/** The names the trail may actually use: the ones the code writes. */
function declaredActions() {
  const names = blockNames('AUDIT_ACTIONS');
  if (!names) throw new Error('AUDIT_ACTIONS is no longer declared in server/lib/audit.js');
  return names;
}

/**
 * Names the vocabulary RESERVES for events this product does not distinguish yet — a role
 * change is recorded inside `USER_UPDATED`, a VAT change inside `SETTINGS_UPDATED`, an
 * export is not recorded at all. They are kept, separately and labelled, because deleting
 * them would erase the record that the difference is known.
 */
function reservedActions() {
  return blockNames('AUDIT_ACTIONS_RESERVED') || [];
}

/** Both declaration blocks, so `--write` can replace them in place. */
function declarationBlocks() {
  const src = fs.readFileSync(AUDIT_LIB, 'utf8');
  const blocks = [];
  for (const name of ['AUDIT_ACTIONS', 'AUDIT_ACTIONS_RESERVED']) {
    const start = src.indexOf(`const ${name} = Object.freeze([`);
    if (start < 0) continue;
    const end = src.indexOf(']);', start) + 3;
    blocks.push({ name, start, end });
  }
  return { src, blocks };
}

function freezeBlock(name, names, comments) {
  const lines = [...comments];
  const perLine = 12;
  for (let i = 0; i < names.length; i += perLine) {
    lines.push(`  ${names.slice(i, i + perLine).map((n) => `'${n}'`).join(', ')},`);
  }
  return `const ${name} = Object.freeze([\n${lines.join('\n')}\n]);`;
}

/**
 * Rewrite the two blocks: what the code writes, and the names it reserves. Both are sorted
 * so a diff shows a real change rather than a reordering, and the reserved block is only
 * ever names that are NOT written — the split is the point.
 */
function writeDeclaration(written, reserved, { writtenComments = [], reservedComments = [] } = {}) {
  const { src, blocks } = declarationBlocks();
  const byName = new Map(blocks.map((b) => [b.name, b]));
  const head = byName.get('AUDIT_ACTIONS');
  if (!head) throw new Error('AUDIT_ACTIONS is no longer declared in server/lib/audit.js');
  const tail = byName.get('AUDIT_ACTIONS_RESERVED');

  const w = [...new Set(written)].sort();
  const r = [...new Set(reserved)].filter((n) => !w.includes(n)).sort();
  // IF THE RESERVED BLOCK DOES NOT EXIST YET IT IS CREATED, right after the vocabulary —
  // the first run of a tool that only ever replaced an existing block silently dropped 31
  // names on the floor, which is the opposite of reconciliation.
  const out = src.slice(0, head.start)
    + freezeBlock('AUDIT_ACTIONS', w, writtenComments)
    + (tail
      ? src.slice(head.end, tail.start) + freezeBlock('AUDIT_ACTIONS_RESERVED', r, reservedComments) + src.slice(tail.end)
      : '\n\n' + freezeBlock('AUDIT_ACTIONS_RESERVED', r, reservedComments) + src.slice(head.end));
  fs.writeFileSync(AUDIT_LIB, out, 'utf8');
  return { written: w, reserved: r };
}

/** The blanking above is only sound if it preserves every index. Assert it. */
function lengthPreserving(src) {
  const out = codeOnly(src);
  return out.length === src.length ? true : `blanked ${src.length} chars into ${out.length} — indices drift by ${src.length - out.length}`;
}

module.exports = { writtenActions, declaredActions, reservedActions, writeDeclaration, sourceFiles, codeOnly, actionExpression, lengthPreserving };

if (require.main === module) {
  const WRITE = process.argv.includes('--write');
  const written = writtenActions();
  const declared = declaredActions();
  const reserved = reservedActions();
  const declaredSet = new Set(declared);
  const writtenSet = new Set(written.keys());

  const missing = [...writtenSet].filter((a) => !declaredSet.has(a)).sort();
  // BOTH BLOCKS COUNT AS DECLARED. Reading only `AUDIT_ACTIONS` here meant the second run of
  // `--write` computed "declared but unwritten" from the block it had just emptied, and the
  // 31 reserved names were dropped on the floor by the tool whose job is to keep them.
  const allDeclared = [...new Set([...declared, ...reserved])];
  const reservedSet = new Set(reserved);
  const unused = allDeclared.filter((a) => !writtenSet.has(a)).sort();
  // TWO KINDS OF "DECLARED BUT UNWRITTEN", and conflating them is what made this tool exit 1
  // on a reconciled vocabulary. A name in `AUDIT_ACTIONS` that nothing writes is a defect — the
  // vocabulary promises an action that does not exist. A name in `AUDIT_ACTIONS_RESERVED` that
  // nothing writes is the POINT of that block: it is a difference this product knows about and
  // has not implemented yet, kept labelled so the knowledge is not lost. Only the first kind
  // can fail a build.
  const unusedActive = unused.filter((a) => !reservedSet.has(a)).sort();
  const reservedUnwritten = unused.filter((a) => reservedSet.has(a)).sort();
  const reservedStale = reserved.filter((a) => writtenSet.has(a)).sort();

  console.log(`audit vocabulary: ${declaredSet.size} declared, ${reserved.length} reserved, ${writtenSet.size} written by the code`);
  const declaredButUnwritten = unused.length;
  if (reservedStale.length) {
    console.log(`\nRESERVED BUT NOW WRITTEN (${reservedStale.length}) — move them into the vocabulary: ${reservedStale.join(', ')}`);
  }
  if (missing.length) {
    console.log(`\nWRITTEN BUT NOT DECLARED (${missing.length}) — the trail uses names the vocabulary does not admit exist:`);
    for (const a of missing) console.log(`  ${a.padEnd(28)} ${[...written.get(a)].slice(0, 2).join(', ')}`);
  }
  if (unusedActive.length) {
    console.log(`\nDECLARED BUT NEVER WRITTEN (${unusedActive.length}) — names an auditor would grep for and find nothing:`);
    console.log('  ' + unusedActive.join('\n  '));
  }
  if (reservedUnwritten.length) {
    console.log(`\nRESERVED, CARRIED FOR THE RECORD (${reservedUnwritten.length}) — differences this product knows about and has not implemented. Not a failure:`);
    console.log('  ' + reservedUnwritten.join('\n  '));
  }
  if (!missing.length && !unusedActive.length && !reservedStale.length) {
    console.log('\nthe vocabulary and the writers agree: every name the trail uses is listed, and every name listed is either written or reserved on purpose.');
  }

  if (WRITE) {
    const kept = [
      '  // THE NAMES THE TRAIL MAY USE, reconciled with the code that writes it by',
      '  // `tools/audit-actions.js` and held there by `test/unit/audit-actions.test.js`.',
      '  //',
      '  // An action that is not in this list is an action an auditor cannot name, and a name',
      '  // in this list that nothing writes is a name they will search for and never find. Both',
      '  // were true of this list before it was reconciled: 50 actions were written under names',
      '  // it did not contain (`SESSIONS_REVOKED`, `CUSTOMER_DELETED`, every compliance action)',
      '  // and 31 names in it had never been written by anything.',
    ];
    const keptReserved = [
      '  // RESERVED: names for events this product does not distinguish yet. Kept, separately and',
      '  // labelled, because deleting them would erase the record that the difference is known.',
      '  // A role change is recorded inside USER_UPDATED; the VAT rate inside SETTINGS_UPDATED; a',
      '  // bulk export is not recorded at all; a superseded session is not recorded at all. An',
      '  // auditor reading the trail cannot tell those apart today, and this list is how that is',
      '  // said out loud instead of hidden behind a vocabulary that pretends otherwise.',
    ];
    const out = writeDeclaration([...writtenSet], [...unused], { writtenComments: kept, reservedComments: keptReserved });
    console.log(`\nrewrote the vocabulary: ${out.written.length} written, ${out.reserved.length} reserved`);
    process.exit(0);
  }
  process.exit(missing.length || unusedActive.length || reservedStale.length ? 1 : 0);
}
