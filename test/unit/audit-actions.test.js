'use strict';
// =====================================================================
// test/unit/audit-actions.test.js — THE AUDIT VOCABULARY AND ITS WRITERS
// =====================================================================
// `AUDIT_ACTIONS` in `server/lib/audit.js` is the vocabulary the trail is read by: the names
// an auditor greps the log for. Nothing checked it against the code that writes the log, and
// the two had drifted almost completely apart:
//
//   · **50 actions were written by routes and were not in the vocabulary** — including
//     `SESSIONS_REVOKED` (a security event), `CUSTOMER_DELETED`, `MANUAL_JOURNAL_POSTED` and
//     every compliance-register action. The trail used names the vocabulary said did not
//     exist;
//   · **31 names sat in the vocabulary that nothing has ever written** — `USER_ROLE_CHANGED`,
//     `VAT_CHANGED`, `EXPORT_TAKEN`, `SESSION_SUPERSEDED` — names an auditor would search for
//     and find nothing, because the trail records those events inside a broader action or not
//     at all. That is a real gap; hiding it in a vocabulary that pretends otherwise is worse
//     than naming it, so the names are now kept in a second, labelled list.
//
// This file asserts the relationship in both directions, and one invariant that is easy to
// get wrong: the extractor blanks comments and string bodies before scanning, and that
// blanking MUST NOT CHANGE THE LENGTH. It did — block comments were skipped without being
// re-emitted, so every index drifted two characters per comment, and the tool cheerfully
// reported `CANCELLED`, `CATEGORY` and `AUDIT_LOG` as audit actions. They are entity types,
// read out of unrelated code twenty-eight characters away. The first assertion here is that
// invariant, because a scan whose indices drift is a scan whose answer is fiction.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ACTIONS = require('../../tools/audit-actions.js');
const { AUDIT_ACTIONS, AUDIT_ACTIONS_RESERVED } = require('../../server/lib/audit.js');

const ROOT = path.resolve(__dirname, '..', '..');

test('the scan is sound before it is believed', async (t) => {
  await t.test('blanking comments and strings preserves every index', () => {
    for (const rel of ['server/lib/audit.js', 'server/routes/admin.js', 'server/routes/sales.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.equal(ACTIONS.lengthPreserving(src), true, `${rel}: ${ACTIONS.lengthPreserving(src)}`);
    }
  });

  await t.test('and it reads the original text for the names, not the blanked one', () => {
    // A ternary contributes BOTH of its names: `action: planChanges.length ? 'PLAN_LIMITS_CHANGED'
    // : 'SETTINGS_UPDATED'` is one expression, and a first version of the tool saw neither.
    const written = ACTIONS.writtenActions();
    assert.ok(written.has('PLAN_LIMITS_CHANGED'), 'the ternary on PLAN_LIMITS_CHANGED is not being read');
    assert.ok(written.has('SETTINGS_UPDATED'), 'the ternary on SETTINGS_UPDATED is not being read');
    assert.ok(written.size > 50, `only ${written.size} actions found across server/, domain/ and worker/ — the scan is not seeing the writers`);
  });
});

test('every action the code records is in the vocabulary', async (t) => {
  const written = ACTIONS.writtenActions();
  const declared = new Set(AUDIT_ACTIONS);
  const unknown = [...written.keys()].filter((a) => !declared.has(a)).sort();

  await t.test('no route writes a name the vocabulary does not admit', () => {
    assert.deepEqual(unknown, [],
      `written but not declared: ${unknown.join(', ')}.\nRun \`node tools/audit-actions.js --write\` to reconcile, then commit the result with a note about what changed`);
  });

  await t.test('and the actions that matter are among them', () => {
    for (const name of ['SESSIONS_REVOKED', 'CUSTOMER_DELETED', 'MANUAL_JOURNAL_POSTED', 'USER_PIN_RESET', 'USER_DEACTIVATED', 'SALE_VOIDED', 'STOCKTAKE_COMMITTED']) {
      assert.ok(declared.has(name), `${name} is not in the vocabulary, so an auditor cannot name it`);
    }
  });
});

test('and nothing in the vocabulary is a name nothing writes', async (t) => {
  const written = new Set(ACTIONS.writtenActions().keys());

  await t.test('the declared list is exactly what the code writes', () => {
    const ghosts = AUDIT_ACTIONS.filter((a) => !written.has(a)).sort();
    assert.deepEqual(ghosts, [],
      `declared but never written by any route, domain or worker file: ${ghosts.join(', ')}.\n`
      + 'Either the route that should record it does not, or the name belongs in AUDIT_ACTIONS_RESERVED with a note about what is recorded instead');
  });

  await t.test('the reserved list is disjoint from it, and still unwritten', () => {
    const overlap = AUDIT_ACTIONS_RESERVED.filter((a) => AUDIT_ACTIONS.includes(a));
    assert.deepEqual(overlap, [], `these are in both lists: ${overlap.join(', ')}`);
    const nowWritten = AUDIT_ACTIONS_RESERVED.filter((a) => written.has(a));
    assert.deepEqual(nowWritten, [],
      `now written, so they belong in AUDIT_ACTIONS: ${nowWritten.join(', ')}. Run \`node tools/audit-actions.js --write\``);
  });

  await t.test('the gap it names is the gap that exists', () => {
    // These four are the distinctions the trail does NOT make, and they are named rather than
    // hidden. If one of them starts being recorded, this test fails until it is moved — which
    // is the point of writing the gap down.
    for (const name of ['USER_ROLE_CHANGED', 'VAT_CHANGED', 'EXPORT_TAKEN', 'SESSION_SUPERSEDED']) {
      assert.ok(AUDIT_ACTIONS_RESERVED.includes(name),
        `${name} has left the reserved list: either it is now recorded (move it to AUDIT_ACTIONS) or the note about the gap has been lost`);
    }
  });
});
