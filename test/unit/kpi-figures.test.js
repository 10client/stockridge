'use strict';
// =====================================================================
// test/unit/kpi-figures.test.js — THE RULE THAT PUTS AN ICON ON A FIGURE
// =====================================================================
// `tools/frontend-figures.js` proves the rule in a real DOM against a live server. This
// file is the half that runs in `npm run verify`, with no browser and no deployment: it
// reads `public/js/ui.js` and `public/js/app.js` and refuses the four ways the rule can be
// undone by a later change —
//
//   1. an icon name that does not exist (`iconPath` silently answers `grid`, so a typo
//      renders a grey square that looks like a considered choice);
//   2. a money rule that has been reordered so a naira figure can be drawn as people,
//      a percentage or a date;
//   3. a `kpi()` that has stopped deriving an icon for a figure that has none;
//   4. a trend that draws an arrow when the server sent nothing to compare against.
//
// It is deliberately source-level, for the same reason `frontend-wire.test.js` is: the
// defect is a disagreement inside one file, and no runtime test of the file alone sees it.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'public/js/ui.js'), 'utf8');

/** The single line that mentions `needle`, so an assertion is about a rule and not about
 *  how the file happens to be wrapped. */
function lineWith(src, needle) {
  const line = src.split('\n').find((l) => l.includes(needle));
  assert.ok(line, `no line in the source mentions ${needle}`);
  return line.trim();
}

/** The icon names the app can actually draw. */
function iconNames() {
  const start = APP.indexOf('const ICONS = {');
  assert.ok(start > -1, 'public/js/app.js no longer declares ICONS where this test can find it');
  const end = APP.indexOf('\n  };', start);
  const body = APP.slice(start, end);
  return new Set([...body.matchAll(/^\s{4}([A-Za-z][\w]*):\s*'/gm)].map((m) => m[1]));
}

test('every icon the UI names is an icon the app can draw', async (t) => {
  const names = iconNames();
  assert.ok(names.size > 20, `only ${names.size} icons found — the parse is broken, not the app`);

  await t.test('the trend arrows exist', () => {
    for (const want of ['trendUp', 'trendDown', 'trendFlat']) {
      assert.ok(names.has(want), `ICONS has no "${want}" — a trend arrow that cannot be drawn is a trend that is not shown`);
    }
  });

  await t.test('a count icon exists for a figure with no unit', () => {
    assert.ok(names.has('hash'), 'ICONS has no "hash", so a plain count has no icon of its own');
  });

  await t.test('every icon name the figure rules can return is drawable', () => {
    // The names inside the two rule tables in ui.js.
    const start = UI.indexOf('const MONEY_ICON_RULES = [');
    const end = UI.indexOf('function kpi(', start);
    const rules = UI.slice(start, end);
    const used = new Set([...rules.matchAll(/,\s*'([a-zA-Z]+)'\]/g)].map((m) => m[1]));
    assert.ok(used.size >= 5, `the rule tables name only ${used.size} icon(s) — the parse is broken`);
    for (const name of used) {
      assert.ok(names.has(name), `the figure rules can return "${name}", which the app cannot draw`);
    }
  });
});

test('a money figure can never be drawn as something that is not money', async (t) => {
  const start = UI.indexOf('const MONEY_ICON_RULES = [');
  const end = UI.indexOf('const FIGURE_RULES = [');
  assert.ok(start > -1 && end > start, 'the money rules are no longer where this test can read them');
  const moneyRules = UI.slice(start, end);
  const moneyIcons = new Set([...moneyRules.matchAll(/,\s*'([a-zA-Z]+)'\]/g)].map((m) => m[1]));

  await t.test('the money chain stays inside the money vocabulary', () => {
    for (const icon of moneyIcons) {
      assert.ok(['cash', 'wallet', 'ledger', 'receipt', 'box'].includes(icon),
        `the money rules can return "${icon}". A naira figure is money: people, charts and calendars describe other things`);
    }
  });

  await t.test('a receivable is the ledger, not the people who owe it', () => {
    const rule = lineWith(moneyRules, 'owed|');
    assert.ok(/'ledger'/.test(rule),
      `the rule for a figure that is owed is "${rule}" — it must be the ledger. "Owed to us ₦34,579,273.97" was drawn with the head-count icon`);
  });

  await t.test('cash in the drawer is not drawn as stock', () => {
    const rule = lineWith(moneyRules, 'drawer');
    assert.ok(/'wallet'/.test(rule),
      `the rule for a drawer figure is "${rule}" — it must be the wallet. "Expected in drawer" was drawn with the stock box`);
  });

  await t.test('the money rules run before the general ones', () => {
    assert.ok(UI.indexOf('if (money) {') < UI.indexOf('if (money)') + 1);
    const moneyBlock = UI.indexOf('if (money) {');
    const generalBlock = UI.indexOf('for (const [re, name] of FIGURE_RULES)');
    assert.ok(moneyBlock > -1 && generalBlock > moneyBlock,
      'the general figure rules now run before the money ones, so a money tile can be sent to the chart or the calendar');
  });
});

test('a tile with no icon gets one derived from its own figure', async (t) => {
  await t.test('kpi() derives when the caller passed nothing', () => {
    assert.match(UI, /const chosen = icon || iconForFigure\(\{ label, value \}\)/,
      'ui.kpi no longer derives an icon from the figure, so a tile written without one is blank again');
  });

  await t.test('an explicit icon still wins', () => {
    const idx = UI.indexOf('const chosen = icon || iconForFigure(');
    assert.ok(idx > -1);
    assert.ok(UI.indexOf('icon ||', idx) === idx + 'const chosen = '.length,
      'the explicit icon must be tried first: a caller who names an icon knows more than the heuristics do');
  });

  await t.test('a figure that is a word, a status or a dash gets nothing', () => {
    const start = UI.indexOf('function iconForFigure');
    const end = UI.indexOf('function trendChip', start);
    const body = UI.slice(start, end);
    assert.ok(body.includes('!/\\d/.test(v)) return null'),
      'the derivation must return null for a value that is not a number — a status is not a figure');
  });

  await t.test('and never the fallback square', () => {
    const start = UI.indexOf('function iconForFigure');
    const end = UI.indexOf('function trendChip', start);
    const body = UI.slice(start, end);
    assert.ok(!/return 'grid'/.test(body),
      "iconForFigure returns 'grid' — that is the silent fallback `iconPath` uses for a name it does not know, and it reads as a design choice");
  });
});

test('an arrow is only drawn when there is something to compare against', async (t) => {
  const start = UI.indexOf('function trendChip');
  const end = UI.indexOf('function kpi(', start);
  const body = UI.slice(start, end);

  await t.test('a missing comparison draws nothing at all', () => {
    assert.match(body, /if \(!hasPct && !hasChange\) return null;/,
      'the chip must return null when the server sent neither a percentage nor a delta — an arrow is a statement about a comparison');
    assert.match(body, /const hasChange = change !== null && Number\.isFinite\(change\) && change !== 0;/,
      'a delta of exactly zero is not a comparison: "flat ₦0" on a quiet morning tells nobody anything');
  });

  await t.test('the direction comes from the sign of the figure', () => {
    assert.match(body, /hasPct \? \(pct > 0 \? 'up' : \(pct < 0 \? 'down' : 'flat'\)\)/,
      'the arrow must be chosen from the sign of the percentage the server sent, with a real 0% reading as flat');
    assert.match(body, /: \(change > 0 \? 'up' : 'down'\)/,
      'and from the sign of the absolute change when there is no percentage — a delta of zero never reaches here');
  });

  await t.test('the arrow follows the figure while the colour follows the meaning', () => {
    assert.match(body, /trend\.goodWhen \|\| 'up'/,
      'goodWhen is what separates "takings are up, good" from "debt is up, bad": without it every rise reads well');
    assert.match(body, /is-\$\{good\}/, 'the chip must carry the good/bad class the stylesheet colours');
  });
});
