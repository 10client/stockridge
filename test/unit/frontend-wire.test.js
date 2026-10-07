'use strict';
// =====================================================================
// test/unit/frontend-wire.test.js — A SCREEN MAY ONLY READ FIELDS THE SERVER SENDS
// =====================================================================
// THE DEFECT THIS EXISTS FOR, and it was ten defects wearing one coat.
//
// `/api/dashboard` answers with `debtors.totalOwed`. The dashboard read
// `debtors.total`. Both are plausible names; neither throws. `undefined` renders as
// "₦0" through `U.money`, as "—" through the fallback chain, or as an empty string —
// so the tile said **"Owed to us ₦0" to every shop, however much was owed**, and
// looked exactly like a quiet morning.
//
// The ten, found by reading the two files side by side:
//
//   1. `today.periodGross` → `period.grossRevenue`. The tile "Sales this period" fell
//      back to `today.sales`, which is a COUNT of sales, and printed it with a naira
//      sign: **₦4 where the shop had taken ₦34,000.**
//   2. `today.vs_yesterday_pct` → `today.vsYesterday.changePct`, so "up 12% on
//      yesterday" had never once appeared.
//   3. `debtors.total` → `debtors.totalOwed` (above).
//   4. `debtors.overdue` → `debtors.likelyBad` / `debtors.overdueInvoices`, so the
//      money that is genuinely at risk never took the colour that asks for action.
//   5. `cash.till || data.till` → `cash.myTill`. **The drawer card said "No till is
//      open" to a cashier with a till open in front of them.**
//   6. The till's fields were snake_case (`opening_cash`, `cash_sales_total`) while
//      the payload is camelCase (`openingCash`, `cashSales`).
//   7. `b.revenue || b.gross` → `b.period.gross`: every "By business" and "By branch"
//      bar was zero-length.
//   8. `a.message`, `a.kind`, `a.path` → `a.label`, `a.severity`, `a.route`: the
//      whole "Needs attention" card had a blank second line, no severity badge, and
//      every row navigated back to the dashboard.
//   9. `usage.branchesPct` → `plan.branches.used / .allowed`, so **the "your plan is
//      nearly full" warning never fired** — a client found out they had run out of
//      staff seats at the moment they tried to hire.
//  10. `stock.stockValue ?? stock.atCost` — worked only because the first name does
//      not exist. Off by a hidden fallback is still off.
//
// The rule this file enforces: **every field a screen reads from a response must be a
// field the server actually sends.** It boots a real deployment, calls the real route,
// and checks the reads it extracts from the view source against the live keys.
//
// It is deliberately source-level. The defect is a disagreement between two files,
// and no runtime test of either file alone can see it.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { tradingDeployment } = require('../helpers/deployment');

/**
 * What each screen reads out of a response, and where those reads land.
 *
 * `aliases` maps the local names a view assigns from the response to the path they
 * came from, so `today.gross` is checked against `response.today.gross` rather than
 * against the root. A view that destructures in a new way needs a line here — which
 * is the point: the mapping is small, explicit, and reviewable.
 */
const SCREENS = [
  {
    name: 'dashboard',
    file: 'public/js/views/dashboard.js',
    route: '/api/dashboard',
    aliases: {
      data: '',
      today: 'today',
      period: 'period',
      stock: 'stock',
      debtors: 'debtors',
      cash: 'cash',
      plan: 'plan',
    },
    // Names that are the view's own locals, not fields of the response.
    locals: new Set(['data', 'period']),
  },
  {
    name: 'plan',
    file: 'public/js/views/plan.js',
    route: '/api/plan',
    aliases: {
      data: '',
      s: 'settings',
      usage: 'usage',
      counts: 'counts',
      features: 'features',
      contact: 'usage.contact',
    },
    locals: new Set(['data', 'usage']),
    // The screen assigns these onto the response object from OTHER requests. They are
    // declared rather than ignored, so `data.dataCleanups` is a statement about where it
    // came from and not a hole in the check.
    merged: new Set(['dataManagement', 'dataCleanups', 'dataManagementRefused']),
    // And the blocks themselves are checked against the route that actually serves
    // them, which is stricter than skipping them — the capacity card's field names are
    // exactly as capable of drifting as any other.
    extraSources: [
      { alias: 'dm', route: '/api/data-management/status' },
    ],
  },
];

/** Strip comments and string literals, so a field named in prose is not read as a read. */
function withoutCommentsAndStrings(src) {
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
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i += 1; }
      if (i < src.length) { out += '  '; i += 2; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    out += ch; i += 1;
  }
  return out;
}

/**
 * Members of a DOM node, not of a response.
 *
 * `plan.js` names a DOM container `counts` inside its cleanup modal and the response's
 * usage block `counts` inside `render` — two different things with one name in one file,
 * which is exactly the kind of collision a source-level check has to be told about
 * rather than guess at. These names are skipped whatever the alias, because no response
 * body has ever had a `replaceChildren`.
 */
const DOM_MEMBERS = new Set([
  'replaceChildren', 'appendChild', 'append', 'remove', 'setAttribute', 'getAttribute',
  'addEventListener', 'classList', 'style', 'textContent', 'innerHTML', 'value', 'focus',
  'querySelector', 'querySelectorAll', 'children', 'firstChild', 'length', 'map', 'filter',
]);

/** Every `<alias>.<key>` read in the view, for the aliases the screen declares. */
function readsFrom(src, aliases) {
  const clean = withoutCommentsAndStrings(src);
  const reads = new Map(); // "alias.key" -> count
  for (const alias of Object.keys(aliases)) {
    const re = new RegExp(`(?<![\\w.$'"\`])${alias}\\.([a-z][A-Za-z0-9_]*)\\b`, 'g');
    for (const m of clean.matchAll(re)) {
      if (DOM_MEMBERS.has(m[1])) continue;
      const full = `${alias}.${m[1]}`;
      reads.set(full, (reads.get(full) || 0) + 1);
    }
  }
  return reads;
}

/** Resolve `a.b` through the aliases map to a path inside the response. */
function resolvePath(aliases, alias, key) {
  const base = aliases[alias];
  return base ? `${base}.${key}` : key;
}

function getPath(obj, dotted) {
  const parts = dotted.split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return { found: false, value: undefined };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

test('every field a screen reads from a response is a field the server sends', async (t) => {
  const world = await tradingDeployment({ label: 'wire' });
  try {
    for (const screen of SCREENS) {
      const src = fs.readFileSync(path.join(ROOT, screen.file), 'utf8');
      const reads = readsFrom(src, Object.assign({}, screen.aliases, ...(screen.extraSources || []).map((x) => ({ [x.alias]: '' }))));
      assert.ok(reads.size >= 20, `only ${reads.size} reads found in ${screen.file} — the extractor or the view has changed shape`);

      const extraAliases = new Set((screen.extraSources || []).map((x) => x.alias));

      // One response per source, cached: the same route is not called twice.
      const responses = new Map();
      const load = async (route) => {
        if (responses.has(route)) return responses.get(route);
        const res = await world.call('GET', `${route}${route.includes('?') ? '&' : '?'}branch_id=${encodeURIComponent(world.branchId)}`, { token: world.ownerToken });
        assert.equal(res.status, 200, `${route} answered ${res.status}: ${res.text.slice(0, 200)}`);
        responses.set(route, res.json);
        return res.json;
      };

      // The OWNER's response, which is the widest: an owner gets the plan block, the
      // group rollups and the full action list.
      const primary = await load(screen.route);

      const missing = [];
      for (const [full, count] of reads) {
        const [alias, key] = full.split('.');
        if (screen.locals.has(full)) continue;
        const extra = (screen.extraSources || []).find((x) => x.alias === alias);
        if (extra) {
          const body = await load(extra.route);
          if (!getPath(body, key).found) missing.push(`${full} (read ${count}×, ${extra.route} has no "${key}")`);
          continue;
        }
        // A key the screen merged onto the object from another request, declared above.
        if (alias === 'data' && screen.merged && screen.merged.has(key)) continue;
        if (extraAliases.has(alias)) continue;
        const dotted = resolvePath(screen.aliases, alias, key);
        if (!getPath(primary, dotted).found) missing.push(`${full} (read ${count}×, server has no "${dotted}")`);
      }

      await t.test(`${screen.name}: no read of a field the server does not send`, () => {
        assert.deepEqual(missing.sort(), [],
          `these reads would render as ₦0, "—", a zero-length bar or a blank row, and none of them would throw:\n  - ${missing.sort().join('\n  - ')}`);
      });
    }
  } finally {
    if (world.close) await world.close();
  }
});

test('the money helpers never put a naira sign on something that is not money', async (t) => {
  await t.test('a count rendered as money is the defect the dashboard had', () => {
    // `U.money` formats anything into ₦. It is the fallback chains that decide WHAT it
    // is handed, and a count of sales with a naira sign is a wrong number that looks
    // deliberate. This pins the two properties the fix depends on: money() marks a
    // value with the symbol, amount() does not, and both pass a non-number through as
    // a dash rather than inventing ₦NaN.
    const src = fs.readFileSync(path.join(ROOT, 'public/js/util.js'), 'utf8');
    const U = { SR: {} };
    const global0 = global.window;
    global.window = { SR: {} };
    try {
      // eslint-disable-next-line no-eval
      eval(src);
      const util = global.window.SR.util;
      assert.equal(util.money(45000), '₦45,000');
      assert.equal(util.amount(45000), '45,000');
      assert.equal(util.money(null), '—');
      assert.equal(util.money(undefined), '—');
      assert.equal(util.money(''), '—');
      assert.equal(util.money('not a number'), '—');
      assert.equal(util.amount(45000.5), '45,000.50');
    } finally {
      global.window = global0;
      void U;
    }
  });

  await t.test('a sale time is displayed as the wall clock it was recorded at', () => {
    // The receipt time, the sales list and the warranty date all read an hour early
    // because a WAT stamp was being converted to a true instant before being printed.
    // `parseStamp` still does that conversion — the void window needs it — so this
    // pins the two behaviours apart: DISPLAY keeps the digits, ARITHMETIC shifts.
    const src = fs.readFileSync(path.join(ROOT, 'public/js/util.js'), 'utf8');
    const global0 = global.window;
    global.window = { SR: {} };
    try {
      // eslint-disable-next-line no-eval
      eval(src);
      const util = global.window.SR.util;
      const stamp = '2026-10-06 14:30:00';           // what the server stores, WAT
      assert.equal(util.soldAt(stamp), '06 Oct 2026 14:30', 'a sale must print the time the shop saw');
      assert.equal(util.soldDate(stamp), '06 Oct 2026');
      // And the arithmetic path is a DIFFERENT call, on purpose.
      const instant = util.parseStamp(stamp, { zone: 'wat' });
      assert.equal(instant.toISOString(), '2026-10-06T13:30:00.000Z', 'the void window compares against a true instant');
    } finally {
      global.window = global0;
    }
  });
});
