'use strict';
// =====================================================================
// tools/frontend-sale.js — RING A SALE THROUGH THE REAL SELL SCREEN
// =====================================================================
// The verification suite proves that `POST /api/sales` works. It cannot prove that
// a cashier can REACH that endpoint with a customer standing in front of them:
// search the product, put it in the cart, take the payment, complete, and get a
// receipt. That path crosses the search box, the cart, the tender modal, the
// payment methods, the receipt renderer and the print module — and until this tool
// existed, none of it had ever been executed outside a human being's hands.
//
// This walks the counter exactly as a person does, against a real server:
//
//   Sell → type a product → Find → choose the hit → Take payment → Add (cash)
//        → Complete sale → read the receipt → confirm the sale on the server
//
// It is deliberately a SEPARATE tool from the smoke test: the smoke test asks
// whether the app renders, this asks whether it can be operated. A shop can render
// beautifully and still be unable to sell.
//
// USAGE
//   node tools/frontend-sale.js --url=https://sample.stockridge.workers.dev \
//     --user=admin --pin=48213 --product=Anker
//
//   --url=        server origin (default http://localhost:8787)
//   --user= --pin=  the seat to ring the sale as (must be able to sell)
//   --product=    what to type into the search box (default "Anker")
//   --expect-offline   accept a queued offline sale instead of a server receipt
//   --dump           on failure, print the modal, the toasts and the page console
//
// Requires jsdom (see tools/lib/page-harness.js). Exit code 0 only when a receipt
// came back and the server agrees the sale exists.
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
  console.log('StockRidge — ring a sale through the UI');
  console.log(`  ${BASE} as ${USERNAME}, searching "${PRODUCT}"`);
  console.log('──────────────────────────────────────────────────────────');

  if (!PIN) { console.error('\n  --pin is required.\n'); process.exit(2); }

  const page = await H.bootPage({ origin: BASE, username: USERNAME, pin: PIN, waitMs: 30000 });
  if (!page.ok) { bad('sign in and boot', page.reason); console.log('\n1 problem.'); process.exit(1); }
  const { window } = page;
  const doc = window.document;
  const $ = (sel) => doc.querySelector(sel);

  if (page.settled.state !== 'ready') bad('the shell rendered', `settled as ${page.settled.state}`);

  // A seat that can reach more than one branch and has not chosen one is CORRECTLY
  // refused by the app — "the system will not guess". Say so here, before driving
  // a sale that is going to be rejected for a reason that is not a defect. (The
  // local demo owner walks into this: two branches, no pin.)
  const scope = window.SR && window.SR.state;
  if (scope) {
    const branchId = scope.activeBranchId;
    const reachable = typeof scope.branchesFor === 'function' ? scope.branchesFor(scope.activeBusinessId) : null;
    if (!branchId && Array.isArray(reachable) && reachable.length > 1) {
      bad('this seat has a branch to sell from',
        `${reachable.length} branches are in scope and none is chosen, so the app refuses every sale by design. ` +
        'Run against a seat pinned to one branch.');
      console.log('\n1 problem.'); process.exit(1);
    }
  }

  // -------------------------------------------------------------------
  // 1. Open the Sell screen the way a cashier does — from the navigation.
  // -------------------------------------------------------------------
  const navHit = await H.clickText(doc.getElementById('nav-list'), 'Sell', { exact: true });
  if (!navHit) { bad('find Sell in the navigation'); console.log('\n1 problem.'); process.exit(1); }
  const scan = await H.waitUntil(() => doc.getElementById('pos-scan'), { timeout: 20000 });
  if (!scan) { bad('the Sell screen opened', 'no search box'); console.log('\n1 problem.'); process.exit(1); }
  ok('opened the Sell screen from the navigation', `title: ${doc.title}`);

  // -------------------------------------------------------------------
  // 2. Search, as a person types.
  // -------------------------------------------------------------------
  scan.value = PRODUCT;
  scan.dispatchEvent(new window.Event('input', { bubbles: true }));
  await H.clickText(doc, 'Find', { exact: true });

  const hits = await H.waitUntil(() => {
    // `.pos-hit` is used for both the real results (buttons) and the "nothing
    // matches" notice (a div). Only a button is something a cashier can choose.
    const list = [...doc.querySelectorAll('.pos-hit')].filter((el) => el.tagName === 'BUTTON' && !el.disabled);
    return list.length ? list : null;
  }, { timeout: 20000 });
  if (!hits) {
    bad('the search found something', `“${PRODUCT}” returned no sellable result`);
    console.log('\n1 problem.'); process.exit(1);
  }
  const chosen = hits[0];
  const chosenLabel = chosen.textContent.replace(/\s+/g, ' ').trim().slice(0, 90);
  ok('searched the catalogue', `${hits.length} result(s); choosing “${chosenLabel}”`);

  // -------------------------------------------------------------------
  // 3. Put it in the cart.
  // -------------------------------------------------------------------
  chosen.click();

  // A product that comes in variants (three sofa fabrics, four phone colours)
  // must be asked about BEFORE the money changes hands. The screen opens a chooser;
  // take the first variant it offers, exactly as a cashier would tap it.
  const chooser = await H.waitUntil(() => {
    const modal = $('#modal-root .modal');
    if (!modal) return null;
    const title = ((modal.querySelector('h2') || {}).textContent || '');
    return /—\s*which one\?/i.test(title) ? modal : null;
  }, { timeout: 8000, interval: 250 });
  if (chooser) {
    const variant = [...chooser.querySelectorAll('button.pos-hit')].find((b) => !b.disabled);
    if (!variant) {
      bad('a variant could be chosen', 'every variant on offer is disabled (no stock?)');
      console.log('\n1 problem.'); process.exit(1);
    }
    const label = variant.textContent.replace(/\s+/g, ' ').trim().slice(0, 70);
    variant.click();
    ok('chose a variant when the screen asked', label);
  }

  // If the default unit does not fit what is on the shelf (a wholesale branch sells
  // by the carton; this shelf holds sixteen pieces), switch to the base unit, the
  // way a cashier would when the customer wants one.
  const unitAsk = await H.waitUntil(() => {
    const line = $('.cart-line');
    if (!line) return null;
    const badge = [...line.querySelectorAll('.badge, div')].find((el) => /only .* in stock/i.test(el.textContent || ''));
    return badge ? badge : null;
  }, { timeout: 2500, interval: 300 });
  if (unitAsk) {
    const unitBtn = [...$('.cart-line').querySelectorAll('button')].find((b) => /^Unit: /.test(b.textContent.trim()));
    if (unitBtn) {
      unitBtn.click();
      const picker = await H.waitUntil(() => {
        const modal = $('#modal-root .modal');
        return modal && /sold in what\?/i.test((modal.querySelector('h2') || {}).textContent || '') ? modal : null;
      }, { timeout: 8000 });
      if (picker) {
        // The base unit first — the picker lists them smallest-factor-first, and a
        // cashier switching unit is nearly always going down to a single piece.
        const options = [...picker.querySelectorAll('button.pos-hit')].filter((b) => !b.disabled);
        const smallest = options[0];
        if (smallest) {
          const chosenUnit = smallest.querySelector('.ph-name');
          smallest.click();
          ok('switched unit to fit the shelf', chosenUnit ? chosenUnit.textContent.trim() : '');
        }
      }
    }
  }

  const cartLine = await H.waitUntil(() => $('.cart-line') || null, { timeout: 15000 });
  if (!cartLine) { bad('the product reached the cart'); console.log('\n1 problem.'); process.exit(1); }
  const cartText = cartLine.textContent.replace(/\s+/g, ' ').trim().slice(0, 100);
  const complete = await H.waitUntil(() => doc.getElementById('pos-complete'), { timeout: 10000 });
  if (!complete) { bad('the cart offers a payment step'); console.log('\n1 problem.'); process.exit(1); }
  ok('added it to the cart', cartText);

  // -------------------------------------------------------------------
  // 4. Take the payment — the tender modal, cash, exact amount.
  // -------------------------------------------------------------------
  complete.click();
  const tender = await H.waitUntil(() => {
    const modal = $('#modal-root .modal');
    if (!modal) return null;
    const title = (modal.querySelector('h2') || {}).textContent || '';
    return /take payment/i.test(title) ? modal : null;
  }, { timeout: 20000 });
  if (!tender) { bad('the payment step opened'); console.log('\n1 problem.'); process.exit(1); }
  const tenderTitle = tender.querySelector('h2').textContent.replace(/\s+/g, ' ').trim();

  // "Add" is the numpad's primary button; it adds the amount currently shown,
  // which the screen has pre-filled with the balance. This is the exact path a
  // cashier takes when the customer pays the full amount.
  const addBtn = [...tender.querySelectorAll('.numpad button')].find((b) => String(b.className).includes('btn-primary'));
  if (!addBtn) { bad('the tender modal offers a way to add the payment'); console.log('\n1 problem.'); process.exit(1); }
  const tendered = money((tender.querySelector('input[type="number"]') || {}).value);
  addBtn.click();
  const paid = await H.waitUntil(() => {
    const running = tender.querySelector('.totals');
    return running && /Paid/i.test(running.textContent) ? running.textContent : null;
  }, { timeout: 10000, interval: 200 });
  ok('took the payment', `${tenderTitle} · added ${tendered}${paid ? ` · ${paid.replace(/\s+/g, ' ').trim().slice(0, 70)}` : ''}`);

  // -------------------------------------------------------------------
  // 5. Complete the sale and read the receipt.
  // -------------------------------------------------------------------
  const finish = await H.waitUntil(() => [...tender.querySelectorAll('button')].find((b) => /^complete sale$/i.test(b.textContent.trim())) || null,
    { timeout: 10000 });
  if (!finish) { bad('the sale can be completed'); console.log('\n1 problem.'); process.exit(1); }
  finish.click();

  // Watch for EITHER outcome. A refusal arrives as a toast that the app clears
  // after eleven seconds, so a tool that waits forty and then looks misses it and
  // reports "no receipt and no message" — losing the one sentence that says why.
  // (That is exactly what happened here on the first run.)
  let refusal = null;
  const receiptModal = await H.waitUntil(() => {
    const toast = $('#toasts .t-err');
    if (toast) { refusal = toast.textContent.replace(/\s+/g, ' ').trim().slice(0, 240); return false; }
    const modal = $('#modal-root .modal');
    if (!modal || modal === tender) return null;
    const title = (modal.querySelector('h2') || {}).textContent || '';
    return /^(Sale |Offline sale recorded)/i.test(title.trim()) ? modal : null;
  }, { timeout: 40000, interval: 300 });

  if (!receiptModal) {
    // Errors reach the user as a toast (ui.apiError → `#toasts .t-err`), and a
    // refusal is a legitimate answer — so read it rather than guess.
    const toast = $('#toasts .t-err');
    const alert = $('#modal-root .alert-danger') || $('.alert-danger');
    const why = refusal
      || ((toast || alert) ? (toast || alert).textContent.replace(/\s+/g, ' ').trim().slice(0, 240) : 'no receipt and no message appeared');
    bad('the sale completed', why);
    if (has('dump')) {
      console.log('      ── dump ──');
      console.log(`      modal-root: ${($('#modal-root').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300) || '(empty)'}`);
      console.log(`      toasts    : ${($('#toasts').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300) || '(none)'}`);
      for (const l of page.logs.slice(-10)) console.log(`      ${l}`);
      console.log('      ──────────');
    }
    console.log('\n1 problem.'); process.exit(1);
  }

  const title = receiptModal.querySelector('h2').textContent.replace(/\s+/g, ' ').trim();
  const receiptText = (receiptModal.querySelector('.receipt') || receiptModal).textContent.replace(/\s+/g, ' ').trim();
  const receiptNo = (title.match(/([A-Za-z0-9-]+)\s*$/) || [])[1] || null;
  const offline = /offline/i.test(title);

  if (offline && !has('expect-offline')) {
    bad('the sale reached the server', 'the app queued it offline instead — no receipt from the server');
  } else if (offline) {
    ok('recorded the sale on the device', `${title} (expected offline)`);
  } else {
    ok('completed the sale and got a receipt', `${title} · ${receiptText.slice(0, 120)}`);
  }

  // -------------------------------------------------------------------
  // 6. Ask the server whether that receipt exists.
  //
  // The receipt is drawn from the RESPONSE, so a receipt alone proves the request
  // succeeded. Reading the sale back proves it was STORED — and the amount on the
  // server matching the amount shown is what tells us the till and the books agree.
  // -------------------------------------------------------------------
  if (!offline && receiptNo) {
    const listed = await fetch(`${BASE}/api/sales?limit=20`, {
      headers: { Authorization: `Bearer ${page.token}` },
    }).then((r) => r.json()).catch(() => null);
    const rows = (listed && (listed.data || listed.sales)) || [];
    const found = rows.find((s) => String(s.receipt_no) === String(receiptNo));
    if (found) {
      ok('the server has the sale', `receipt ${found.receipt_no} · ${money(found.total)} · status ${found.status} · ${found.sold_at}`);
    } else {
      bad('the server has the sale', `receipt ${receiptNo} is not in GET /api/sales`);
    }
  }

  // Leave the till as it was found.
  const close = receiptModal.querySelector('.icon-btn');
  if (close) close.click();

  console.log('──────────────────────────────────────────────────────────');
  if (problems.length) {
    console.log(`${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('Rang a sale through the Sell screen, start to receipt, with no problems.');
  if (page.logs.filter((l) => l.startsWith('[error]')).length) {
    const errs = page.logs.filter((l) => l.startsWith('[error]'));
    console.log(`  (the page logged ${errs.length} error(s) on the way: ${errs[0].slice(0, 140)})`);
  }
})();
