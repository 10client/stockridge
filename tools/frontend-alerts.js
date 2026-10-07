'use strict';
// =====================================================================
// tools/frontend-alerts.js — THE BELL, DRIVEN AGAINST A LIVE SERVER
// =====================================================================
// The notification engine's only producer is the compliance sweep: it raises an alert
// for every permit or licence about to lapse. Those rows are the difference between a
// licence being renewed and a shop being closed, and until P11 **nothing in the product
// could show one** — the table had a writer and no reader.
//
// This tool proves the loop end to end, in a real DOM against a running server:
//
//   1. raise an alert the way the sweep does (`POST /api/compliance/notify`, or a row
//      written directly when the fixture's register has nothing expiring);
//   2. the BELL BADGE counts it;
//   3. the PANEL lists it, with the branch it belongs to and the fact that a branch
//      alert is shared;
//   4. clicking it marks it read and takes the person to the screen that fixes it;
//   5. "Mark all read" clears the badge, and the SERVER agrees (asked directly, not
//      read back off the screen).
//
// USAGE
//   node tools/frontend-alerts.js --url=http://localhost:8787 \
//     --user=owner --pin=48213 [--branch=<id>]
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
const BRANCH = flag('branch', null);

let failures = 0;
function check(label, ok, detail = '') {
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`  ${mark} ${label}${detail && !ok ? `\n      ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function settle(page, ms = 8000) {
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

(async () => {
  console.log('StockRidge — the alert bell, end to end');
  console.log(`  ${BASE}`);
  console.log('─'.repeat(58));

  const page = await H.bootPage({ origin: BASE, username: USER.username, pin: USER.pin });
  if (!page.ok) { check(`${USER.username} could sign in`, false, page.reason || 'boot failed'); process.exit(1); }
  const token = page.token || (page.window.SR && page.window.SR.api && page.window.SR.api.token && page.window.SR.api.token());
  check(`${USER.username} could sign in`, true);

  const api = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: Object.assign({ Authorization: `Bearer ${token}` }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json };
  };

  // ---- raise something to see -------------------------------------------------
  //
  // THROUGH THE REAL PRODUCER, not by writing a row: a licence is recorded for a branch
  // with an expiry inside the alert window, and the compliance sweep turns it into a
  // notification exactly as the nightly job does. A fixture that inserts a notification
  // directly would test the bell against a shape no producer creates.
  let branchId = BRANCH || (page.window.SR.state.activeBranchId && page.window.SR.state.activeBranchId());
  if (!branchId) {
    // AN OWNER WITH SEVERAL BRANCHES HAS NO ACTIVE ONE until they pick one — the same
    // shape the screens hit ("Choose which branch this applies to"). The tool picks the
    // first, which is what the person would do in the branch picker.
    const branches = await api('GET', '/api/branches?limit=5');
    const first = ((branches.json && branches.json.data) || [])[0];
    branchId = first ? first.id : null;
    if (branchId) console.log(`  · no active branch on this seat; using "${first.name}" for the fixture (a person would pick one here)`);
  }
  check('this seat has a branch to record a licence against', Boolean(branchId),
    'no branch could be resolved — pass --branch=<id>');

  const today = new Date();
  const inDays = (n) => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);
  const RECORD_TYPE = 'BUSINESS_PERMIT';
  const WANTED_EXPIRY = inDays(9);

  let restore = null;   // what to put back when this tool is done
  const created = await api('POST', '/api/compliance/records', {
    branch_id: branchId, record_type: RECORD_TYPE, expiry_date: WANTED_EXPIRY, issued_date: inDays(-356),
  });
  if (created.status === 201) {
    check('a licence was recorded for the test', true);
    restore = { id: created.json.id, action: 'delete' };
  } else if (created.status === 409) {
    // One live record per type per branch: reuse the one that is there and put its date
    // back afterwards, so the deployment ends as it was found.
    const list = await api('GET', `/api/compliance/records?branch_id=${encodeURIComponent(branchId)}&limit=50`);
    const existing = ((list.json && list.json.data) || []).find((r) => String(r.record_type).toUpperCase() === RECORD_TYPE);
    check('an existing licence of the same type can be reused', Boolean(existing), `the list answered ${list.status}`);
    if (existing) {
      const put = await api('PUT', `/api/compliance/records/${existing.id}`, { expiry_date: WANTED_EXPIRY });
      check('its expiry was moved into the alert window', put.status === 200, `PUT answered ${put.status} ${JSON.stringify(put.json).slice(0, 140)}`);
      restore = { id: existing.id, action: 'restore', expiry_date: existing.expiry_date };
    }
  } else {
    check('a licence could be recorded for the test', false,
      `POST /api/compliance/records answered ${created.status}: ${JSON.stringify(created.json).slice(0, 200)}`);
  }

  const swept = await api('POST', '/api/compliance/notify', {});
  check('the compliance sweep raised an alert for it', swept.status === 200 && Number(swept.json.created) >= 1,
    `POST /api/compliance/notify answered ${swept.status} with created=${swept.json && swept.json.created}`);
  const second = await api('POST', '/api/compliance/notify', {});
  check('and it is idempotent — running it twice does not double the alert',
    second.status === 200 && Number(second.json.created) === 0,
    `the second run created ${second.json && second.json.created}`);

  const listAfterRaise = await api('GET', '/api/notifications?limit=50');
  const unreadNow = Number(listAfterRaise.json && listAfterRaise.json.unread) || 0;
  check('there is something unread for the bell to show', unreadNow > 0, `the list reports ${unreadNow} unread`);

  // ---- the badge ---------------------------------------------------------------
  await page.window.SR.app.updateBell();
  const badge = page.window.document.getElementById('bell-count');
  check('the bell badge is visible with a count', badge && !badge.hidden && Number(badge.textContent) > 0,
    badge ? `badge hidden=${badge.hidden} text="${badge.textContent}"` : 'no badge element');
  check('the badge counts what the list returned', Number(badge && badge.textContent) === unreadNow,
    `badge says ${badge && badge.textContent}, the list says ${unreadNow}`);

  // ---- the panel ---------------------------------------------------------------
  page.window.document.getElementById('bell-btn').click();
  await H.sleep(600);
  const pop = page.window.document.getElementById('bell-pop');
  check('the panel opens', pop && !pop.hidden);
  const items = pop ? pop.querySelectorAll('.bell-item') : [];
  check('the panel lists the alerts', items.length > 0, `${items.length} rows rendered`);
  const panelText = pop ? pop.textContent.replace(/\s+/g, ' ') : '';
  check('a row says which branch it is about', /branch|Whole business|For you/i.test(panelText), panelText.slice(0, 160));
  check('a shared branch alert says so', /shared with the branch/i.test(panelText),
    'a branch alert is one work item — the panel has to say so, or two people renew the same licence');
  check('the panel explains that clearing it is not discharging it', /raises an expiry alert again/i.test(panelText));

  // ---- opening one -------------------------------------------------------------
  // THE ROUTE IS A PATH, NOT A HASH — `navigate()` uses `history.pushState`, so the
  // hash stays empty whatever happens. Read where the app actually went.
  const pathBefore = String(page.window.location.pathname || '');
  if (!items.length) {
    check('an alert row exists to open', false, 'the panel rendered no rows — nothing to drive');
  } else {
  items[0].click();
  await H.sleep(900);
  await settle(page);
  const afterClick = await api('GET', '/api/notifications?limit=50');
  check('clicking an alert marks it read on the SERVER',
    Number(afterClick.json.unread) === unreadNow - 1,
    `unread was ${unreadNow}, the server now says ${afterClick.json && afterClick.json.unread}`);
  const pathAfter = String(page.window.location.pathname || '');
  const viewText = String((page.window.document.getElementById('view') || {}).textContent || '').replace(/\s+/g, ' ');
  check('and it takes the person to the screen that fixes it',
    pathAfter !== pathBefore && /compliance|stock|customers|instalment|warranty|sync|stocktake/i.test(pathAfter),
    `path went "${pathBefore}" -> "${pathAfter}"`);
  check('the destination rendered rather than breaking on the way',
    !/cannot read propert|is not a function|is not defined|of undefined|of null/i.test(viewText),
    viewText.slice(0, 160));

  }
  // ---- mark all read -----------------------------------------------------------
  page.window.document.getElementById('bell-btn').click();
  await H.sleep(400);
  page.window.document.getElementById('bell-read-all').click();
  await H.sleep(1200);
  await page.window.SR.app.updateBell({ refreshPanel: true });
  const cleared = await api('GET', '/api/notifications?limit=50');
  check('"Mark all read" empties the badge', Number(cleared.json.unread) === 0,
    `the server still reports ${cleared.json && cleared.json.unread} unread`);
  const badgeAfter = page.window.document.getElementById('bell-count');
  check('and the badge hides itself', badgeAfter && badgeAfter.hidden, `hidden=${badgeAfter && badgeAfter.hidden}`);
  const rowsAfter = pop ? pop.querySelectorAll('.bell-item') : [];
  check('the panel keeps the history, greyed rather than emptied',
    rowsAfter.length >= items.length,
    `${items.length} rows before, ${rowsAfter.length} after — an alert that vanishes cannot be re-read`);

  // ---- put the deployment back as it was found --------------------------------
  if (restore) {
    const cleaned = restore.action === 'delete'
      ? await api('DELETE', `/api/compliance/records/${restore.id}`)
      : await api('PUT', `/api/compliance/records/${restore.id}`, { expiry_date: restore.expiry_date });
    check('the fixture licence was put back as it was found', cleaned.status === 200,
      `cleanup answered ${cleaned.status}: ${JSON.stringify(cleaned.json).slice(0, 160)}`);
  }
  const beforeFinal = await api('GET', '/api/notifications?limit=50');
  check('the alerts this tool raised are all read, so the bell is clean for the next run',
    Number(beforeFinal.json && beforeFinal.json.unread) === 0,
    `${beforeFinal.json && beforeFinal.json.unread} still unread`);

  page.window.close();
  console.log('\n' + '─'.repeat(58));
  if (failures) { console.log(`${failures} check(s) failed.\n`); process.exit(1); }
  console.log('The bell counts what the list shows, and the server agrees at every step.\n');
})().catch((err) => {
  console.error(`\nthe tool itself failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
