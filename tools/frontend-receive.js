'use strict';
// =====================================================================
// tools/frontend-receive.js — RECEIVE STOCK THROUGH THE REAL SCREEN
// =====================================================================
// The other half of the counter. `frontend-sale.js` takes stock out; this puts it
// in — and receiving is where a shop's money actually enters the books: the cost
// per unit recorded here is the cost used for every unit of that batch until it is
// sold, and it is what the margin, the valuation and the VAT on a sale are all
// derived from. A receiving screen that records the wrong quantity, or the right
// quantity in the wrong unit, silently misprices the whole batch.
//
// What it does, exactly as a storekeeper does:
//
//   Stock → Receive stock → type the product → pick it from the suggestions
//         → confirm the quantity and cost → Receive → read the confirmation
//
// Then it asks the SERVER what happened, in base units:
//
//   · did stock actually go up, and by the quantity times the chosen unit's factor?
//   · is the batch there, at the cost that was typed?
//
// The unit check is the point. "3 cartons" of a 48-piece product must raise stock
// by 144, not by 3 — receiving in the wrong unit is invisible until a stocktake
// months later.
//
// USAGE
//   node tools/frontend-receive.js --url=http://localhost:8787 \
//     --user=musa --pin=73914 --product=kettle --qty=3
//
//   --url=          server origin (default http://localhost:8787)
//   --user= --pin=  the seat to receive as (needs STAFF or above)
//   --product=      what to type into the product box (default "Anker")
//   --qty=          how many to receive (default 3)
//   --cost=         cost per unit; omitted means "accept what the form offers"
//
// Requires jsdom (see tools/lib/page-harness.js).
// =====================================================================

const H = require('./lib/page-harness.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const BASE = String(flag('url', 'http://localhost:8787')).replace(/\/$/, '');
const USERNAME = flag('user', 'admin');
const PIN = flag('pin');
const PRODUCT = flag('product', 'Anker');
const QTY = Number(flag('qty', 3));
const COST = flag('cost');

const problems = [];
const ok = (label, detail) => console.log(`  ✓ ${label}${detail ? `\n      ${detail}` : ''}`);
const bad = (label, detail) => { problems.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); };
const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

(async () => {
  console.log('StockRidge — receive stock through the UI');
  console.log(`  ${BASE} as ${USERNAME}, ${QTY} × "${PRODUCT}"`);
  console.log('──────────────────────────────────────────────────────────');
  if (!PIN) { console.error('\n  --pin is required.\n'); process.exit(2); }

  const page = await H.bootPage({ origin: BASE, username: USERNAME, pin: PIN, waitMs: 30000 });
  if (!page.ok) { bad('sign in and boot', page.reason); console.log('\n1 problem.'); process.exit(1); }
  const { window } = page;
  const doc = window.document;
  const $ = (sel) => doc.querySelector(sel);

  // A seat that can reach more than one branch and has not chosen one is correctly
  // refused — say so rather than reporting it as a fault.
  const state = window.SR && window.SR.state;
  if (state) {
    const reachable = typeof state.branchesFor === 'function' ? state.branchesFor(state.activeBusinessId) : null;
    if (!state.activeBranchId && Array.isArray(reachable) && reachable.length > 1) {
      bad('this seat has a branch to receive into', `${reachable.length} branches in scope, none chosen — the app refuses by design`);
      console.log('\n1 problem.'); process.exit(1);
    }
  }
  const branchId = state ? state.activeBranchId : null;

  // -------------------------------------------------------------------
  // 1. Open Stock from the navigation and start a receipt.
  // -------------------------------------------------------------------
  const opened = await H.clickText(doc.getElementById('nav-list'), 'Stock', { exact: true });
  if (!opened) { bad('find Stock in the navigation'); console.log('\n1 problem.'); process.exit(1); }
  // The demo owner reaches two branches with none chosen, and the screen then asks
  // which one — answer it, as a person would, rather than failing here.
  const branchAsk = await H.waitUntil(() => {
    const modal = $('#modal-root .modal');
    if (!modal) return null;
    const title = ((modal.querySelector('h2') || {}).textContent || '');
    return /which branch/i.test(title) ? modal : null;
  }, { timeout: 4000, interval: 250 });
  if (branchAsk) {
    const first = [...branchAsk.querySelectorAll('button.pos-hit, button')]
      .find((b) => !b.disabled && !/cancel|close/i.test(b.textContent.trim()));
    if (first) { first.click(); await H.sleep(1200); }
  }

  const receiveBtn = await H.waitUntil(() => H.findByText(doc, 'Receive stock', { exact: true, tag: 'button' })[0] || null,
    { timeout: 20000 });
  if (!receiveBtn) { bad('the Stock screen offers Receive stock'); console.log('\n1 problem.'); process.exit(1); }
  receiveBtn.click();

  const modal = await H.waitUntil(() => {
    const m = $('#modal-root .modal');
    return m && /^receive stock$/i.test(((m.querySelector('h2') || {}).textContent || '').trim()) ? m : null;
  }, { timeout: 15000 });
  if (!modal) { bad('the receive form opened'); console.log('\n1 problem.'); process.exit(1); }
  ok('opened the receive form from the Stock screen');

  // -------------------------------------------------------------------
  // 2. Pick the product the way a storekeeper does — type, then click.
  // -------------------------------------------------------------------
  const productInput = modal.querySelector('[name="product_id"]');
  if (!productInput) { bad('the form has a product box'); console.log('\n1 problem.'); process.exit(1); }
  productInput.value = PRODUCT;
  productInput.dispatchEvent(new window.Event('input', { bubbles: true }));

  const hit = await H.waitUntil(() => {
    const list = [...modal.querySelectorAll('button.pos-hit')];
    return list.length ? list[0] : null;
  }, { timeout: 20000 });
  if (!hit) {
    bad('the product search found something', `“${PRODUCT}” returned no suggestion`);
    console.log('\n1 problem.'); process.exit(1);
  }
  const productName = hit.textContent.replace(/\s+/g, ' ').trim().slice(0, 70);
  hit.click();

  // Picking a product loads its unit ladder (and its price) from the server, so the
  // form fills a beat later. Watch it fill rather than reading empty boxes — a shop
  // keeper waits for the form too.
  await H.waitUntil(() => {
    const cost = modal.querySelector('[name="cost_price_per_unit"]');
    const unit = modal.querySelector('[name="unit_code"]');
    return (cost && Number(cost.value) > 0) || (unit && unit.options && unit.options.length > 1);
  }, { timeout: 15000, interval: 250 });

  // -------------------------------------------------------------------
  // 3. Read back what the form decided, BEFORE submitting.
  // -------------------------------------------------------------------
  const read = (name) => {
    const el = modal.querySelector(`[name="${name}"]`);
    return el ? String(el.value || '') : '';
  };
  const unitField = read('unit_code');
  const costField = read('cost_price_per_unit');
  const sellField = read('selling_price');
  if (!unitField) bad('the form fills in a unit', 'the unit box is empty, so the quantity would be interpreted as PIECE');

  // What the API knows about this product, so the assertion below is about the
  // product's own ladder rather than an assumption.
  const findProduct = async () => {
    const res = await fetch(`${BASE}/api/products?q=${encodeURIComponent(PRODUCT)}&limit=20`, {
      headers: { Authorization: `Bearer ${page.token}` },
    });
    const body = await res.json().catch(() => null);
    return (body && body.data ? body.data : []).find((p) => productName.startsWith(String(p.name).slice(0, 12))) || (body && body.data ? body.data[0] : null);
  };
  const product = await findProduct();
  if (!product) { bad('the product the screen chose is in the API', 'it was in the suggestions but not in the list'); }
  const before = product ? Number(product.on_hand || 0) : null;

  // The factor for the unit the form is using — from the product's ladder.
  let factor = 1;
  if (product) {
    const detail = await fetch(`${BASE}/api/products/${encodeURIComponent(product.id)}`, {
      headers: { Authorization: `Bearer ${page.token}` },
    }).then((r) => r.json()).catch(() => null);
    const units = (detail && detail.units) || [];
    const match = units.find((u) => String(u.code).toUpperCase() === unitField.toUpperCase());
    const def = units.find((u) => Number(u.is_default_sell) === 1) || units[0];
    factor = Number((match || def || {}).quantity_in_base) || 1;
  }

  ok('chose the product and the form filled itself in',
    `${product ? product.name : productName} · unit ${unitField || '(blank)'} (= ${factor} base unit${factor === 1 ? '' : 's'}) · cost ${money(costField)} · sells at ${money(sellField)}`);

  // -------------------------------------------------------------------
  // 4. Confirm the quantity and cost, then submit.
  // -------------------------------------------------------------------
  const qtyInput = modal.querySelector('[name="quantity"]');
  qtyInput.value = String(QTY);
  qtyInput.dispatchEvent(new window.Event('change', { bubbles: true }));

  const costInput = modal.querySelector('[name="cost_price_per_unit"]');
  const typeCost = (value) => {
    costInput.value = String(value);
    costInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  if (COST != null && COST !== '') typeCost(COST);

  // The form deliberately leaves the cost empty when the product's cost is unknown,
  // so that a batch is never booked at zero by default. A tool has no invoice to
  // read, so it types one and says so — the defect it is reporting is that the
  // product has no cost, not that the form refused it.
  if (read('cost_price_per_unit') === '') {
    typeCost(1000);
    bad('the product has a known cost to prefill', 'the form offered no cost, so the tool typed one; check the product');
  }
  const costUsed = Number(read('cost_price_per_unit'));

  const submit = [...modal.querySelectorAll('button')].find((b) => /^receive$/i.test(b.textContent.trim()));
  if (!submit) { bad('the form can be submitted'); console.log('\n1 problem.'); process.exit(1); }
  submit.click();

  // Either a confirmation toast, or a refusal that says why.
  let refusal = null;
  const done = await H.waitUntil(() => {
    const err = $('#toasts .t-err');
    if (err) { refusal = err.textContent.replace(/\s+/g, ' ').trim().slice(0, 220); return false; }
    const toast = $('#toasts .t-ok');
    if (toast) return toast.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
    const stillOpen = $('#modal-root .modal');
    if (!stillOpen) return 'the form closed without a message';
    return null;
  }, { timeout: 30000, interval: 300 });

  if (refusal || !done) {
    bad('the receipt was accepted', refusal || 'no confirmation appeared');
    console.log('\n1 problem.'); process.exit(1);
  }
  ok('recorded the receipt', done);

  // -------------------------------------------------------------------
  // 5. Ask the server what actually happened.
  // -------------------------------------------------------------------
  await H.sleep(800);
  const after = await findProduct();
  if (!product || !after) {
    bad('the stock movement can be checked', 'the product could not be re-read');
  } else {
    const expected = QTY * factor;
    const actual = Number(after.on_hand || 0) - Number(before || 0);
    const detail = `on hand ${before} → ${after.on_hand} (received ${QTY} × ${unitField} = ${expected} base units)`;
    if (Math.abs(actual - expected) < 0.001) ok('stock went up by exactly what was received', detail);
    else bad('stock went up by what was received', `${detail}; the server moved ${actual} base units`);

    // The cost that was typed is the cost of the BATCH — the figure every margin and
    // every valuation of this stock is derived from, for every unit sold from it.
    const batches = await fetch(`${BASE}/api/stock/${encodeURIComponent(after.id)}/batches`, {
      headers: { Authorization: `Bearer ${page.token}` },
    }).then((r) => r.json()).catch(() => null);
    const rows = (batches && (batches.data || batches.batches)) || [];
    if (!rows.length) {
      bad('the batch can be read back', 'no batches came back for this product');
    } else if (!Number.isFinite(costUsed)) {
      bad('the cost that was typed is known', 'the cost box was empty and could not be read back');
    } else {
      // The batch this receipt created: the one whose quantity is the quantity
      // received (in base units). Matching on id would be better, but the endpoint's
      // response is about the product, and this tool only knows what the screen did.
      const received = rows.filter((b) => Math.abs(Number(b.quantity) - QTY * factor) < 0.001);
      const batch = received[received.length - 1] || rows[0];
      const costPerBase = Number(batch.cost_price_per_unit != null ? batch.cost_price_per_unit : batch.cost);
      const expectedPerBase = factor > 1 ? costUsed / factor : costUsed;
      const label = `${money(costUsed)} per ${unitField} should be ${money(expectedPerBase)} per base unit`;
      if (Math.abs(costPerBase - expectedPerBase) < Math.max(0.01, expectedPerBase * 0.01)) {
        ok('the batch carries the cost that was typed', `${label}; the batch records ${money(costPerBase)}`);
      } else {
        bad('the batch carries the cost that was typed', `${label}, but the batch records ${money(costPerBase)}`);
      }
    }
  }

  console.log('──────────────────────────────────────────────────────────');
  if (problems.length) {
    console.log(`${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('Received stock through the Stock screen, start to confirmation, with no problems.');
  if (branchId) console.log(`  (branch ${branchId})`);
})();
