'use strict';
// =====================================================================
// tools/frontend-offline.js — SELL WITH NO LINE, THEN SYNC
// =====================================================================
// This is the claim the whole product rests on, and until now nothing had ever
// tested it: a shop with no internet rings up a sale, the sale is kept on the
// device, and it reaches the office when the line comes back — once, not twice.
//
// The awkward part is that "offline" has to be REAL. Unplugging a network is not
// available in a test, so this tool cuts the app's own network layer: every
// `/api/` request is made to fail exactly as a dead line fails, and the browser's
// `offline` event is fired. The app then has to do what it promises —
//
//   1. search the catalogue FROM THE DEVICE MIRROR, not the server
//   2. take the payment and complete the sale
//   3. keep it in the outbox with a local reference the customer can be shown
//   4. sync it when the line returns, exactly once
//
// The last part is the one that matters commercially. A double-posted sale
// overstates the day's takings and the stock movement; a lost one is a customer
// who paid and has no record.
//
// USAGE
//   node tools/frontend-offline.js --url=http://localhost:8787 \
//     --user=musa --pin=73914 --product=kettle
//
//   --url=          server origin (default http://localhost:8787)
//   --user= --pin=  a seat scoped to ONE branch (receiving and selling need a branch)
//   --product=      what to sell while offline (default "Anker")
//   --keep          leave the sale queued instead of syncing it (to watch the app)
//
// Requires jsdom (see tools/lib/page-harness.js).
// =====================================================================

const H = require('./lib/page-harness.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = String(flag('url', 'http://localhost:8787')).replace(/\/$/, '');
const USERNAME = flag('user', 'admin');
const PIN = flag('pin');
const PRODUCT = flag('product', 'Anker');

const problems = [];
const ok = (label, detail) => console.log(`  ✓ ${label}${detail ? `\n      ${detail}` : ''}`);
const bad = (label, detail) => { problems.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); };
const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

(async () => {
  console.log('StockRidge — sell with no line, then sync');
  console.log(`  ${BASE} as ${USERNAME}, selling "${PRODUCT}"`);
  console.log('──────────────────────────────────────────────────────────');
  if (!PIN) { console.error('\n  --pin is required.\n'); process.exit(2); }

  const page = await H.bootPage({ origin: BASE, username: USERNAME, pin: PIN, waitMs: 30000 });
  if (!page.ok) { bad('sign in and boot', page.reason); console.log('\n1 problem.'); process.exit(1); }
  const { window } = page;
  const doc = window.document;
  const $ = (sel) => doc.querySelector(sel);
  const SR = window.SR;

  const state = SR && SR.state;
  if (state) {
    const reachable = typeof state.branchesFor === 'function' ? state.branchesFor(state.activeBusinessId) : null;
    if (!state.activeBranchId && Array.isArray(reachable) && reachable.length > 1) {
      bad('this seat has a branch to sell from', `${reachable.length} branches in scope, none chosen — the app refuses by design`);
      console.log('\n1 problem.'); process.exit(1);
    }
  }

  // -------------------------------------------------------------------
  // 0. How many sales are on the server now? The count is the control: at the end
  //    there must be exactly ONE more, not two.
  // -------------------------------------------------------------------
  const listSales = async () => {
    const res = await fetch(`${BASE}/api/sales?limit=50`, { headers: { Authorization: `Bearer ${page.token}` } });
    const body = await res.json().catch(() => null);
    return (body && (body.data || body.sales)) || [];
  };
  const before = await listSales();
  const beforeCount = before.length;
  const beforeReceipts = new Set(before.map((s) => String(s.receipt_no)));
  ok('read the server before going offline', `${beforeCount} recent sale(s), newest receipt ${before[0] ? before[0].receipt_no : '—'}`);

  // -------------------------------------------------------------------
  // 1. Cut the line — for real, at the transport.
  // -------------------------------------------------------------------
  const onlineFetch = window.fetch;
  let cut = true;
  window.fetch = (url, init) => {
    const u = String(url);
    if (cut && /\/api\//.test(u)) {
      // A dead line rejects; it does not answer 500. The app must treat it as
      // "no line" and not as "the server said no".
      return Promise.reject(new window.TypeError('Failed to fetch'));
    }
    return onlineFetch(url, init);
  };
  window.dispatchEvent(new window.Event('offline'));
  await H.sleep(500);
  const onlineFlag = SR.api.isOnline();
  if (onlineFlag === false) ok('the app knows the line is down', 'api.isOnline() is false');
  else bad('the app noticed the failed connection', 'isOnline() still true after a dead line');

  // -------------------------------------------------------------------
  // 2. Sell — offline, from the device mirror.
  // -------------------------------------------------------------------
  const opened = await H.clickText(doc.getElementById('nav-list'), 'Sell', { exact: true });
  if (!opened) { bad('open the Sell screen'); console.log('\n1 problem.'); process.exit(1); }
  const scan = await H.waitUntil(() => doc.getElementById('pos-scan'), { timeout: 20000 });
  if (!scan) { bad('the Sell screen opened with no line'); console.log('\n1 problem.'); process.exit(1); }

  scan.value = PRODUCT;
  scan.dispatchEvent(new window.Event('input', { bubbles: true }));
  await H.clickText(doc, 'Find', { exact: true });

  const hit = await H.waitUntil(() => {
    const list = [...doc.querySelectorAll('.pos-hit')].filter((el) => el.tagName === 'BUTTON' && !el.disabled);
    return list.length ? list[0] : null;
  }, { timeout: 25000 });
  if (!hit) {
    bad('the catalogue is searchable from the device', `“${PRODUCT}” found nothing with the line down — the mirror is empty or unreadable`);
    console.log('\n1 problem.'); process.exit(1);
  }
  const hitText = hit.textContent.replace(/\s+/g, ' ').trim();
  const offlineNote = [...doc.querySelectorAll('.pos-hit')].some((el) => /offline/i.test(el.textContent));
  hit.click();
  ok('found the product with no line', `${hitText.slice(0, 80)}${offlineNote ? ' (the screen says it is showing device results)' : ' (from the device mirror)'}`);

  // Variants, if the screen asks.
  const chooser = await H.waitUntil(() => {
    const modal = $('#modal-root .modal');
    return modal && /which one\?/i.test((modal.querySelector('h2') || {}).textContent || '') ? modal : null;
  }, { timeout: 5000, interval: 250 });
  if (chooser) {
    const variant = [...chooser.querySelectorAll('button.pos-hit')].find((b) => !b.disabled);
    if (variant) variant.click();
  }

  const line = await H.waitUntil(() => $('.cart-line') || null, { timeout: 15000 });
  if (!line) { bad('the product reached the cart with no line'); console.log('\n1 problem.'); process.exit(1); }

  const complete = doc.getElementById('pos-complete');
  complete.click();
  const tender = await H.waitUntil(() => {
    const modal = $('#modal-root .modal');
    return modal && /take payment/i.test((modal.querySelector('h2') || {}).textContent || '') ? modal : null;
  }, { timeout: 15000 });
  if (!tender) { bad('the payment step opened with no line'); console.log('\n1 problem.'); process.exit(1); }
  const tendered = (tender.querySelector('input[type="number"]') || {}).value;
  [...tender.querySelectorAll('.numpad button')].find((b) => String(b.className).includes('btn-primary')).click();
  await H.sleep(400);

  const finish = [...tender.querySelectorAll('button')].find((b) => /^complete sale$/i.test(b.textContent.trim()));
  finish.click();

  let refusal = null;
  const receipt = await H.waitUntil(() => {
    const err = $('#toasts .t-err');
    if (err) { refusal = err.textContent.replace(/\s+/g, ' ').trim().slice(0, 200); return false; }
    const modal = $('#modal-root .modal');
    if (!modal || modal === tender) return null;
    const title = ((modal.querySelector('h2') || {}).textContent || '').trim();
    return /^(Sale |Offline sale recorded)/i.test(title) ? modal : null;
  }, { timeout: 40000, interval: 300 });

  if (!receipt) {
    bad('the sale completed with no line', refusal || 'no receipt and no message appeared');
    console.log('\n1 problem.'); process.exit(1);
  }
  const title = receipt.querySelector('h2').textContent.replace(/\s+/g, ' ').trim();
  const receiptText = (receipt.querySelector('.receipt') || receipt).textContent.replace(/\s+/g, ' ').trim();
  const isOfflineReceipt = /offline/i.test(title);
  const localRef = (receiptText.match(/Local reference\s+([A-Za-z0-9]+)/i) || [])[1] || null;
  if (isOfflineReceipt) {
    ok('the sale was recorded on the device', `${title}${localRef ? ` · local reference ${localRef}` : ''} · ${money(tendered)}`);
  } else {
    bad('the sale was kept offline', `the app produced a server receipt with the line down: ${title}`);
  }

  // -------------------------------------------------------------------
  // 3. Is it in the outbox, and does the screen say so?
  // -------------------------------------------------------------------
  const outbox = await SR.store.pending().catch(() => []);
  const queued = outbox.filter((r) => String(r.type).toUpperCase() === 'SALE');
  if (queued.length) {
    const q = queued[queued.length - 1];
    ok('it is in the outbox, waiting', `client ${String(q.client_id).slice(-8)} · ${money((q.payload || {}).payments ? q.payload.payments.reduce((a, p) => a + Number(p.amount || 0), 0) : 0)} · status ${q.status}`);
  } else {
    bad('the sale is in the outbox', `the outbox holds ${outbox.length} item(s), none of them a SALE`);
  }

  const closeBtn = receipt.querySelector('.icon-btn');
  if (closeBtn) closeBtn.click();

  if (has('keep')) {
    console.log('──────────────────────────────────────────────────────────');
    console.log('Left queued on purpose (--keep). The sale is on the device and not on the server.');
    console.log(`  outbox: ${queued.length} sale(s) waiting`);
    process.exit(problems.length ? 1 : 0);
  }

  // -------------------------------------------------------------------
  // 4. The line comes back. The app should sync by itself.
  // -------------------------------------------------------------------
  cut = false;
  window.dispatchEvent(new window.Event('online'));
  // The sync module runs on the 'net' event; give it a moment, and if it has not
  // fired, ask it to run — the point is to test the sync, not the timer.
  await H.sleep(1500);
  if (!SR.api.isOnline()) {
    // The app may still believe it is offline until a request succeeds.
    try { await SR.api.probe({ force: true }); } catch (err) { /* probe reports it */ }
  }
  let syncResult = null;
  try {
    syncResult = await SR.sync.runOnce({ silent: true });
  } catch (err) {
    bad('the sync ran', err && err.message ? err.message : String(err));
  }
  // How many the server took. The app syncs on the 'net' event by itself, so by
  // the time this explicit runOnce happens the queue is usually already drained
  // and its own counters read zero — reporting that bare zero would say "nothing
  // was sent" about a sale that is sitting in the books. Read the outbox instead:
  // a row carries a server reference once the server has acknowledged it.
  const outboxNow = await SR.store.outboxAll().catch(() => []);
  const salesQueued = outboxNow.filter((r) => String(r.type).toUpperCase() === 'SALE');
  const acknowledged = salesQueued.filter((r) => r.server_ref || String(r.status).toUpperCase() === 'SYNCED').length;
  if (syncResult && syncResult.push) {
    const p2 = syncResult.push;
    const sent = Math.max(Number(p2.applied) || 0, acknowledged);
    const note = p2.empty ? ' (the app had already synced on its own)' : '';
    ok('the device synced', `${sent} sent, ${Number(p2.rejected) || 0} refused${syncResult.pull ? `, ${syncResult.pull.rows} rows received` : ''}${note}`);
  }

  // -------------------------------------------------------------------
  // 5. Exactly one sale on the server, and the outbox is empty.
  // -------------------------------------------------------------------
  await H.sleep(1500);
  const after = await listSales();
  const fresh = after.filter((s) => !beforeReceipts.has(String(s.receipt_no)));
  const matching = fresh.filter((s) => Math.abs(Number(s.total) - Number(tendered)) < 0.01);

  if (fresh.length === 0) {
    bad('the sale reached the server', 'nothing new arrived — the queued sale was not sent');
  } else if (fresh.length > 1) {
    bad('the sale reached the server exactly once', `${fresh.length} new sales arrived for one sale made offline: ${fresh.map((s) => s.receipt_no).join(', ')}`);
  } else if (matching.length === 1) {
    ok('the sale reached the server, exactly once', `receipt ${fresh[0].receipt_no} · ${money(fresh[0].total)} · ${fresh[0].sold_at}`);
  } else {
    bad('the sale reached the server with the right value',
      `receipt ${fresh[0].receipt_no} is for ${money(fresh[0].total)}, the sale was ${money(tendered)}`);
  }

  const outboxAfter = await SR.store.pending().catch(() => []);
  const stillQueued = outboxAfter.filter((r) => String(r.type).toUpperCase() === 'SALE');
  if (stillQueued.length === 0) ok('the outbox is clear');
  else bad('the outbox is clear', `${stillQueued.length} sale(s) are still waiting`);

  console.log('──────────────────────────────────────────────────────────');
  if (problems.length) {
    console.log(`${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('Sold with no line, kept it on the device, and it synced exactly once.');
  if (page.logs.filter((l) => l.startsWith('[error]')).length) {
    const errs = page.logs.filter((l) => l.startsWith('[error]'));
    console.log(`  (the page logged ${errs.length} error(s): ${errs[0].slice(0, 140)})`);
  }
})();
