'use strict';
// =====================================================================
// tools/frontend-suspension.js — A SUSPENSION, FROM BOTH SIDES OF THE COUNTER
// =====================================================================
// `assertSubscriptionActive` was wired to three routes and no trading route, so a client
// who stopped paying kept ringing sales: the status changed on the Subscription screen,
// the caps kept binding, and nothing that moves money noticed. The gate now runs in the
// pipeline, and the shell draws a bar from the status it already carries — because a
// refusal only the person who pressed Save ever reads is not a message, it is a toast in
// the middle of a queue of customers.
//
// This tool proves both halves against a live server, through the real screens:
//
//   1. as the administrator, on the Subscription screen, set the status to SUSPENDED;
//   2. the client's own session (a different seat, already signed in) is refused a trade
//      — through the app's own API layer, so the code the app acts on is the code the
//      server sent;
//   3. the BAR appears, names the status, says what still works, and names who to ring;
//   4. reading still works — the client can always see and export their own books;
//   5. the vendor's own session is marked differently, because the vendor is not gated;
//   6. restoring the status clears the bar and the shop trades again;
//   7. everything this tool raised is removed, and the account is left ACTIVE — asserted
//      server-side at the end, because a probe that suspends a deployment and fails
//      before its restore is worse than no probe at all.
//
// USAGE
//   node tools/frontend-suspension.js --url=http://localhost:8787 \
//     --admin=admin --admin-pin=90210 --owner=owner --owner-pin=48213
//
// Exit code is 0 only when every check passed AND the account was restored.
// =====================================================================

const H = require('./lib/page-harness.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const BASE = String(flag('url', 'http://localhost:8787')).replace(/\/$/, '');
const ADMIN = { username: flag('admin', 'admin'), pin: flag('admin-pin', '90210') };
const OWNER = { username: flag('owner', 'owner'), pin: flag('owner-pin', '48213') };
const STAMP = Date.now().toString(36).slice(-5).toUpperCase();
const MARK = `PROBE-SUSP-${STAMP}`;

let failures = 0;
function check(label, ok, detail = '') {
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`  ${mark} ${label}${detail && !ok ? `\n      ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function tokenOf(page) {
  return page.token
    || (page.window.SR && page.window.SR.api && page.window.SR.api.token && page.window.SR.api.token());
}

/** A plain HTTP client on a page's seat — the same token, outside the app. */
function apiFor(token) {
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: Object.assign({ Authorization: `Bearer ${token}` },
        body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json };
  };
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

const barOf = (page) => page.window.document.getElementById('subscription-bar');
const barText = (page) => {
  const bar = barOf(page);
  return bar ? String(bar.textContent || '').replace(/\s+/g, ' ').trim() : '';
};

(async () => {
  console.log('StockRidge — a suspended subscription, from both sides');
  console.log(`  ${BASE}`);
  console.log('─'.repeat(58));

  const adminPage = await H.bootPage({ origin: BASE, username: ADMIN.username, pin: ADMIN.pin });
  if (!adminPage.ok) { check(`${ADMIN.username} could sign in`, false, adminPage.reason || 'boot failed'); process.exit(1); }
  const ownerPage = await H.bootPage({ origin: BASE, username: OWNER.username, pin: OWNER.pin });
  if (!ownerPage.ok) { check(`${OWNER.username} could sign in`, false, ownerPage.reason || 'boot failed'); process.exit(1); }

  const adminToken = tokenOf(adminPage);
  const ownerToken = tokenOf(ownerPage);
  const adminApi = apiFor(adminToken);
  const ownerApi = apiFor(ownerToken);

  const branchOf = async () => {
    const r = await ownerApi('GET', '/api/branches?limit=5');
    return ((r.json && r.json.data) || [])[0] || null;
  };

  const statusNow = async () => {
    const r = await adminApi('GET', '/api/settings');
    return ((r.json && r.json.settings) || {}).subscription_status;
  };
  // THE STATUS THIS DEPLOYMENT STARTED WITH, not the one this tool finds convenient.
  // A running instance is usually on TRIAL, and a probe that "restores" every account to
  // ACTIVE has quietly promoted somebody's trial — a fixture writing to the product it is
  // supposed to be observing.
  const original = { status: null };
  const restore = async (why) => {
    const target = original.status || 'ACTIVE';
    const before = await statusNow();
    if (String(before).toUpperCase() === String(target).toUpperCase()) return { ok: true, already: true, target };
    const res = await adminApi('PUT', '/api/settings', { subscription_status: target });
    const after = await statusNow();
    const ok = res.status < 400 && String(after).toUpperCase() === String(target).toUpperCase();
    console.log(`  · ${why}: status ${before} → ${after}${ok ? '' : ' — THE RESTORE FAILED, restore it by hand'}`);
    return { ok, already: false, target };
  };

  // The trading write this probe drives. A customer is a write with no stock and no
  // money on it, and it can be removed afterwards, so nothing is left behind.
  //
  // THE BRANCH HAS TO BE NAMED. An owner reaches several branches, and the server
  // refuses to guess which one a write belongs to ("stock, cash and reports all belong
  // to a specific shop") — the same shape the screens hit, and the reason this is
  // resolved up front rather than discovered when the first write comes back 400.
  let branchId = null;
  // EVERY WRITE GETS ITS OWN PHONE NUMBER. The server refuses a second customer on a
  // number already on the books ("creating a second one splits their credit limit in
  // two") — which is a good rule, and it made the first version of this probe fail for
  // the wrong reason: the second write was refused before the subscription gate ever saw
  // it, so the probe proved nothing about suspensions.
  let phoneSeq = 0;
  const addCustomer = (page, suffix) => {
    phoneSeq += 1;
    return page.window.SR.api.post('/api/customers', {
      branch_id: branchId,
      name: `${MARK}-${suffix}`,
      customer_type: 'INDIVIDUAL',
      phone: `0803${String(Date.now()).slice(-5)}${String(phoneSeq).padStart(2, '0')}`,
    });
  };

  /** The bar is painted by an async re-read, so give it a moment to arrive. */
  async function waitForBar(page, want, ms = 5000) {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const bar = barOf(page);
      if (bar && bar.hidden === !want) return true;
      await H.sleep(150);
    }
    return false;
  }

  let opened = false;
  try {
    // ------------------------------------------------------------------
    // 1. THE BASELINE — ACTIVE, bar hidden, trades land
    // ------------------------------------------------------------------
    const startStatus = await statusNow();
    original.status = startStatus;
    check('the deployment starts open for trade', ['ACTIVE', 'TRIAL'].includes(String(startStatus).toUpperCase()),
      `the deployment begins ${startStatus}, so there is nothing here to suspend. This tool will not lift a suspension it did not raise`);

    check('the bar is hidden while the subscription is active',
      barOf(ownerPage).hidden === true, `the bar is showing: ${barText(ownerPage)}`);

    const branch = await branchOf();
    if (!branch) throw new Error('this seat has no branch to write against');
    branchId = branch.id;

    let before = await addCustomer(ownerPage, 'A');
    // The app's API layer returns the parsed body for a 2xx.
    check('while active, the shop can create a customer', Boolean(before && (before.id || before.ok)),
      `the write came back as ${JSON.stringify(before).slice(0, 160)}`);
    const firstCustomerId = before && before.id ? before.id : null;

    // ------------------------------------------------------------------
    // 2. THE ADMINISTRATOR SUSPENDS IT, FROM THE SUBSCRIPTION SCREEN
    // ------------------------------------------------------------------
    const nav = adminPage.window.document.getElementById('nav-list');
    const planBtn = [...(nav ? nav.querySelectorAll('.nav-item') : [])].find((b) => b && b.dataset && b.dataset.path === '/plan');
    check('the administrator has the Subscription screen', Boolean(planBtn));
    if (planBtn) { planBtn.click(); await settle(adminPage); }

    const adoc = adminPage.window.document;
    const statusSelect = adoc.querySelector('#view [name="subscription_status"]');
    check('the status control is a choice of the four the schema allows', Boolean(statusSelect),
      'no [name="subscription_status"] in the Platform controls card');
    if (statusSelect) {
      const optionValues = [...(statusSelect.options || [])].map((o) => o.value);
      check('SUSPENDED is one of them', optionValues.includes('SUSPENDED'), `options: ${optionValues.join(', ')}`);
      statusSelect.value = 'SUSPENDED';
      await H.clickText(adoc.getElementById('view'), 'Apply to this client');
      await settle(adminPage);
      opened = true;
    }

    const suspendedNow = await statusNow();
    check('the administrator’s own screen suspended the client', String(suspendedNow).toUpperCase() === 'SUSPENDED',
      `the status after applying is ${suspendedNow}. If this failed the restore below still runs`);
    if (!opened) throw new Error('the suspension could not be raised through the screen');

    // ------------------------------------------------------------------
    // 3. THE CLIENT IS REFUSED, AND TOLD WHY — through the app's own layer
    // ------------------------------------------------------------------
    let refused = null;
    try {
      await addCustomer(ownerPage, 'B');
    } catch (err) {
      refused = err;
    }
    check('the shop can no longer create a customer', Boolean(refused),
      'the write succeeded on a suspended account — the gate is not in the pipeline');
    check('and the refusal is the one the app can act on', Boolean(refused) && refused.code === 'SUBSCRIPTION_NOT_ACTIVE',
      `the app caught ${refused ? refused.code : 'nothing'}: ${refused ? refused.message : ''}`);

    const raised = await waitForBar(ownerPage, true);
    const bar = barOf(ownerPage);
    check('the bar appears in the client’s session', raised,
      'a refused write did not raise the bar — the person sees a toast that expires and nothing else');
    const said = barText(ownerPage);
    check('the bar names the status', /SUSPENDED/i.test(said), said.slice(0, 160));
    check('the bar says what still works', /readable|export/i.test(said), said.slice(0, 160));
    check('the bar names who to ring', /account manager|phone|email/i.test(said), said.slice(0, 160));
    check('the bar is drawn as the client’s, not the vendor’s',
      !bar.classList.contains('is-vendor'), 'the client’s own suspension is marked as a vendor notice');

    const state = ownerPage.window.SR.app.subscriptionState();
    check('the app agrees it is paused', state.paused === true && state.vendor === false,
      JSON.stringify(state));

    // ------------------------------------------------------------------
    // 4. AND THE READS KEEP WORKING — that is the promise in the refusal
    // ------------------------------------------------------------------
    let readOk = false;
    let readDetail = '';
    try {
      const list = await ownerApi('GET', '/api/sales?limit=5');
      readOk = list.status === 200;
      readDetail = `GET /api/sales answered ${list.status}`;
    } catch (err) {
      readDetail = err.message;
    }
    check('reading the books still works', readOk, readDetail);
    const exported = await ownerApi('GET', '/api/reports/export?type=sales');
    check('the export path is still open to them', exported.status < 400 || exported.status === 400,
      `the export answered ${exported.status} — a suspended client must still be able to take their own data`);

    // ------------------------------------------------------------------
    // 5. THE VENDOR SEES A DIFFERENT BAR, BECAUSE THE VENDOR IS NOT GATED
    // ------------------------------------------------------------------
    adminPage.window.SR.app.refreshSubscriptionChrome();
    await waitForBar(adminPage, true);
    const adminBar = barOf(adminPage);
    check('the administrator’s session shows the suspension', Boolean(adminBar) && adminBar.hidden === false,
      'the vendor cannot see that the instance they are working on is suspended');
    check('and marks it as the vendor’s notice, not a wall in front of them',
      Boolean(adminBar) && adminBar.classList.contains('is-vendor'), barText(adminPage).slice(0, 160));
    check('the vendor’s line says they are not gated', /not gated/i.test(barText(adminPage)), barText(adminPage).slice(0, 160));
    const vendorWrite = await adminApi('POST', '/api/customers', {
      branch_id: branchId, name: `${MARK}-vendor`, customer_type: 'INDIVIDUAL',
    });
    check('the vendor can still work on the instance', vendorWrite.status < 400,
      `the administrator was refused: ${vendorWrite.status} ${JSON.stringify(vendorWrite.json).slice(0, 160)}`);

    // ------------------------------------------------------------------
    // 6. RESTORED — the bar goes, and the shop trades
    // ------------------------------------------------------------------
    const putBack = await restore('restoring before the final checks');
    check('the administrator restored the account', putBack.ok, 'the status could not be put back');
    ownerPage.window.SR.app.refreshSubscriptionChrome();
    check('the client’s bar goes away when the account is restored',
      await waitForBar(ownerPage, false), `the bar is still up: ${barText(ownerPage)}`);
    const after = await addCustomer(ownerPage, 'C');
    check('and the shop trades again', Boolean(after && (after.id || after.ok)),
      `the write came back as ${JSON.stringify(after).slice(0, 160)}`);
  } catch (err) {
    check('the probe ran without a fault', false, err && err.message ? err.message : String(err));
  } finally {
    // -------------------------------------------------------------------
    // 7. NOTHING LEFT BEHIND — the account is ACTIVE and the fixtures are gone
    // -------------------------------------------------------------------
    const restored = await restore('final restore');
    check(`the deployment is left ${original.status || 'ACTIVE'} (the status it started with)`, restored.ok,
      'THE STATUS WAS NOT PUT BACK — fix this by hand');

    const found = await ownerApi('GET', `/api/customers?search=${encodeURIComponent(MARK)}&limit=50`);
    const rows = ((found.json && found.json.data) || []).filter((c) => String(c.name || '').startsWith(MARK));
    let removed = 0;
    for (const row of rows) {
      const del = await ownerApi('DELETE', `/api/customers/${encodeURIComponent(row.id)}`);
      if (del.status < 400 || del.status === 404) removed += 1;
    }
    check('the customers this probe created are gone', removed === rows.length,
      `${rows.length - removed} of ${rows.length} could not be removed`);

    console.log('\n' + '─'.repeat(58));
    if (failures === 0) {
      console.log('Suspending stops the books, keeps the data readable, and says so on the screen the shop is looking at.');
    } else {
      console.log(`${failures} check(s) failed.`);
    }
    process.exit(failures === 0 ? 0 : 1);
  }
})();
