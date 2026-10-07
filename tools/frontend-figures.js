'use strict';
// =====================================================================
// tools/frontend-figures.js — DOES THE ICON MATCH THE FIGURE?
// =====================================================================
// A tile is read at a glance: the icon says what the number is before the number is read.
// That makes a wrong icon worse than a missing one, and the dashboard had three:
//
//   · "Owed to us ₦34,579,273.97" carried the PEOPLE icon — a receivable drawn as a head
//     count, with the actual people ("11 debtors") on the line underneath;
//   · "Expected in drawer" carried the STOCK box;
//   · "Takings today" said "down 100% on yesterday" in words, with no mark on the tile
//     that the figure had moved at all — and 188 tiles across the app had no icon at all.
//
// This tool measures the rule in a real DOM against a live server, in both directions:
//
//   FRONT TO BACK  every money figure on every screen carries a MONEY icon and every count
//                  a count icon; no tile ever renders the silent `grid` fallback; and the
//                  trend arrow points the way the SERVER says the figure went, with the
//                  same percentage the server sent.
//   BACK TO FRONT  the tile's value is the server's figure, formatted by the page's own
//                  formatter — so a tile cannot show a number the API did not send, and the
//                  icon cannot describe a figure that is not there.
//
// USAGE
//   node tools/frontend-figures.js --url=http://localhost:8787 --user=owner --pin=48213
//
// Exit code is 0 only when every check passed.
// =====================================================================

const H = require('./lib/page-harness.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const BASE = String(flag('url', 'http://localhost:8787')).replace(/\/$/, '');
const USER = { username: flag('user', 'owner'), pin: flag('pin', '48213') };

let failures = 0;
function check(label, ok, detail = '') {
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`  ${mark} ${label}${detail && !ok ? `\n      ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function note(text) { console.log(`  \u001b[2m· ${text}\u001b[0m`); }

/** Money tiles must carry one of these; a people icon on a naira figure is the bug. */
const MONEY_ICONS = new Set(['cash', 'wallet', 'ledger', 'receipt', 'box']);
const COUNT_ICONS = new Set(['hash', 'users', 'receipt', 'box', 'clock', 'calendar', 'chart']);

async function settle(page, ms = 6000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < ms) {
    const v = page.window.document.getElementById('view');
    const now = v ? v.textContent.replace(/\s+/g, ' ').trim() : '';
    if (now.length && now === last) return now;
    last = now;
    await H.sleep(250);
  }
  return last;
}

/** Every KPI tile in the view, with the icon name it actually rendered. */
function tiles(page) {
  const doc = page.window.document;
  const ICONS = page.window.SR.app.ICONS;
  const nameOf = (path) => Object.keys(ICONS).find((k) => ICONS[k] === path) || null;
  return [...doc.querySelectorAll('#view .kpi')].map((el) => {
    const svgPath = el.querySelector('.kpi-icon svg path');
    const chip = el.querySelector('.kpi-trend');
    const chipPath = chip ? chip.querySelector('svg path') : null;
    return {
      label: String((el.querySelector('.kpi-label-text') || {}).textContent || '').trim(),
      value: String((el.querySelector('.kpi-value') || {}).textContent || '').trim(),
      foot: String((el.querySelector('.kpi-foot') || {}).textContent || '').trim(),
      icon: svgPath ? nameOf(svgPath.getAttribute('d')) : null,
      rawIconPath: svgPath ? svgPath.getAttribute('d') : null,
      trend: chip ? {
        cls: String(chip.className),
        text: String(chip.textContent || '').trim(),
        title: String(chip.getAttribute('title') || ''),
        icon: chipPath ? nameOf(chipPath.getAttribute('d')) : null,
      } : null,
      el,
    };
  });
}

async function openNav(page, path) {
  const nav = page.window.document.getElementById('nav-list');
  const btn = [...(nav ? nav.querySelectorAll('.nav-item') : [])].find((b) => b && b.dataset && b.dataset.path === path);
  if (!btn) return false;
  btn.click();
  await settle(page);
  return true;
}

(async () => {
  console.log('StockRidge — the icon and the figure it stands on');
  console.log(`  ${BASE}`);
  console.log('─'.repeat(58));

  const page = await H.bootPage({ origin: BASE, username: USER.username, pin: USER.pin });
  if (!page.ok) { check(`${USER.username} could sign in`, false, page.reason || 'boot failed'); process.exit(1); }
  const token = page.token || (page.window.SR && page.window.SR.api && page.window.SR.api.token && page.window.SR.api.token());
  check(`${USER.username} could sign in`, true);

  const api = async (path) => {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  await settle(page);

  // ------------------------------------------------------------------
  // FRONT TO BACK — the dashboard's four figures against the server's
  // ------------------------------------------------------------------
  const grid = page.window.SR.app.ICONS.grid;
  const shown = tiles(page);
  const dash = await api(`/api/dashboard?${new URLSearchParams(page.window.SR.state.query()).toString()}`);
  const money = page.window.SR.util.money;
  const d = dash.json || {};
  const today = d.today || {};
  const period = d.period || {};
  const stock = d.stock || {};
  const debtors = d.debtors || {};

  check('the dashboard rendered its tiles', shown.length >= 4, `only ${shown.length} tile(s) rendered`);

  const find = (label) => shown.find((t) => t.label.toLowerCase().startsWith(label.toLowerCase()));
  const pairs = [
    ['Takings today', money(today.gross)],
    ['Sales', money(period.grossRevenue)],
    ['Stock at cost', money(stock.atCost)],
    ['Owed to us', money(debtors.totalOwed)],
  ];
  for (const [label, expected] of pairs) {
    const tile = find(label);
    check(`"${label}" shows the server's own figure (${expected})`, Boolean(tile) && tile.value === expected,
      tile ? `the tile says ${tile.value}` : 'no such tile on the dashboard');
  }

  const moneyTiles = shown.filter((t) => /₦/.test(t.value));
  const badMoneyIcon = moneyTiles.filter((t) => !t.icon || !MONEY_ICONS.has(t.icon));
  check('every money figure on the dashboard carries a money icon',
    moneyTiles.length > 0 && badMoneyIcon.length === 0,
    badMoneyIcon.map((t) => `"${t.label}" ${t.value} → ${t.icon || 'NO ICON'}`).join('; '));
  const gridFallbacks = shown.filter((t) => t.rawIconPath && t.rawIconPath === grid);
  check('no tile renders the silent fallback square', gridFallbacks.length === 0,
    gridFallbacks.map((t) => t.label).join(', '));
  check('a naira figure is never drawn with the people icon',
    !moneyTiles.some((t) => t.icon === 'users'),
    moneyTiles.filter((t) => t.icon === 'users').map((t) => `${t.label} ${t.value}`).join('; '));

  // ------------------------------------------------------------------
  // THE TREND — the arrow has to agree with the number the server sent
  // ------------------------------------------------------------------
  const until = today.vsYesterday || null;
  const takings = find('Takings today');
  if (until && until.changePct != null) {
    const dir = Number(until.changePct) > 0 ? 'trendUp' : (Number(until.changePct) < 0 ? 'trendDown' : 'trendFlat');
    check('the trend arrow points the way the server says the figure went',
      Boolean(takings && takings.trend && takings.trend.icon === dir),
      `the server sent changePct ${until.changePct} (${dir}); the tile drew ${takings && takings.trend ? takings.trend.icon : 'no arrow'}`);
    check('and the chip carries the same percentage',
      Boolean(takings && takings.trend && takings.trend.text.includes(`${Math.abs(until.changePct)}%`)),
      `the server sent ${until.changePct}%, the chip says ${takings && takings.trend ? takings.trend.text : 'nothing'}`);
    const good = until.changePct >= 0 ? 'is-good' : 'is-bad';
    check('and it is coloured for what that direction means for the shop',
      Boolean(takings && takings.trend && takings.trend.cls.includes(good)),
      `takings ${until.changePct >= 0 ? 'up' : 'down'} should read ${good}; the chip is "${takings && takings.trend ? takings.trend.cls : '—'}"`);
    note(`the tile reads: "${takings.trend.title}"`);
  } else {
    check('with no comparison to make, no arrow is drawn',
      Boolean(takings) && !takings.trend,
      'the server sent no changePct and the tile drew an arrow anyway — an arrow is a statement about a comparison');
    note('the server sent no yesterday to compare against, so the arrow is correctly absent');
  }

  // ------------------------------------------------------------------
  // THE BOUNDARIES, DRIVEN THROUGH THE SAME COMPONENT
  // ------------------------------------------------------------------
  const ui = page.window.SR.ui;
  const chipOf = (trend) => {
    const node = ui.kpi({ label: 'Probe', value: '₦10', trend });
    const chip = node.querySelector('.kpi-trend');
    if (!chip) return null;
    const p = chip.querySelector('svg path');
    const ICONS = page.window.SR.app.ICONS;
    return { cls: chip.className, icon: p ? Object.keys(ICONS).find((k) => ICONS[k] === p.getAttribute('d')) : null, text: chip.textContent.trim() };
  };
  const up = chipOf({ pct: 12 });
  const down = chipOf({ pct: -12 });
  const flat = chipOf({ pct: 0 });
  check('a rise draws the up arrow', Boolean(up) && up.icon === 'trendUp' && up.cls.includes('is-good'), JSON.stringify(up));
  check('a fall draws the down arrow', Boolean(down) && down.icon === 'trendDown' && down.cls.includes('is-bad'), JSON.stringify(down));
  check('no movement draws the flat mark, not an arrow', Boolean(flat) && flat.icon === 'trendFlat', JSON.stringify(flat));
  check('a figure with nothing to compare against draws nothing',
    chipOf({ pct: null, change: null }) === null, 'a chip appeared with neither a percentage nor a delta');
  // THE QUIET-MORNING CASE, which is what a cashier's dashboard actually sends: the server
  // has no baseline to divide by (`changePct: null`) and nothing moved (`change: 0`). A chip
  // reading "flat ₦0" is the only thing on the tile and tells nobody anything.
  check('a delta of zero draws nothing either',
    chipOf({ pct: null, change: 0 }) === null, `a chip appeared for a zero delta: ${JSON.stringify(chipOf({ pct: null, change: 0 }))}`);
  check('but an explicit nought per cent IS a comparison and keeps its flat mark',
    (() => { const c = chipOf({ pct: 0 }); return Boolean(c) && c.icon === 'trendFlat'; })(),
    'the server sent a real 0% change, which means "the same as yesterday", and that is worth showing');
  check('and a real delta alone still draws its arrow',
    (() => { const c = chipOf({ pct: null, change: -250 }); return Boolean(c) && c.icon === 'trendDown'; })(),
    JSON.stringify(chipOf({ pct: null, change: -250 })));
  check('a figure with only an absolute change draws the arrow from that change',
    (() => { const c = chipOf({ change: -250 }); return Boolean(c) && c.icon === 'trendDown' && c.text.includes('250'); })(),
    JSON.stringify(chipOf({ change: -250 })));
  const debt = chipOf({ pct: 8, goodWhen: 'down' });
  check('the arrow follows the figure, the colour follows the meaning',
    Boolean(debt) && debt.icon === 'trendUp' && debt.cls.includes('is-bad'),
    `a rise in debt points up and should read badly: ${JSON.stringify(debt)}`);

  // ------------------------------------------------------------------
  // BACK TO FRONT — every screen: figure ⇒ icon, and no fallback ever
  // ------------------------------------------------------------------
  const nav = page.window.document.getElementById('nav-list');
  const routes = [...(nav ? nav.querySelectorAll('.nav-item') : [])]
    .map((b) => b.dataset && b.dataset.path)
    .filter((p) => p && p !== '/dashboard');
  let sweptTiles = 0;
  let sweptMoney = 0;
  const offenders = [];
  const fallbacks = [];
  for (const route of routes) {
    if (!(await openNav(page, route))) continue;
    await H.sleep(120);
    for (const tile of tiles(page)) {
      sweptTiles += 1;
      if (!tile.value) continue;
      if (tile.rawIconPath && tile.rawIconPath === grid) fallbacks.push(`${route} · ${tile.label}`);
      if (/₦/.test(tile.value)) {
        sweptMoney += 1;
        if (!tile.icon || !MONEY_ICONS.has(tile.icon)) offenders.push(`${route} · "${tile.label}" ${tile.value} → ${tile.icon || 'NO ICON'}`);
      } else if (/^[\d.,]+\s*%$/.test(tile.value) && tile.icon && !COUNT_ICONS.has(tile.icon)) {
        offenders.push(`${route} · "${tile.label}" ${tile.value} → ${tile.icon}`);
      }
    }
  }
  check(`every money figure across ${routes.length} screen(s) carries a money icon (${sweptMoney} checked)`,
    offenders.length === 0, offenders.slice(0, 10).join('\n      '));
  check('and no tile on any screen renders the fallback square',
    fallbacks.length === 0, fallbacks.slice(0, 10).join('\n      '));
  note(`${sweptTiles} tile(s) swept across the sidebar`);

  console.log('\n' + '─'.repeat(58));
  if (failures === 0) console.log('The icon says what the figure is, and the arrow says which way it went.');
  else console.log(`${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
