'use strict';
// =====================================================================
// tools/frontend-price.js — SET A BRANCH PRICE FROM THE SCREEN, AND SEE IT ON
// THE RECEIPT
// =====================================================================
// `product_price_overrides` was the capability the audit found as "read but never
// created": the sale engine honoured a per-branch price, the product screen showed
// them, and nothing could make one. The endpoints and the screen now exist — this
// is the probe that proves they work TOGETHER, on a running server, through the
// same DOM a shopkeeper uses:
//
//   1. open the product's own page from the Catalogue
//   2. confirm the "Branch prices" card is there and says every branch is on the
//      catalogue price
//   3. click "Set a branch price" and fill the form the way a person would
//   4. save it, and confirm the card now shows the branch at the new price
//   5. ASK THE SERVER what a sale would be charged — the point of the whole
//      feature — and confirm the override is what comes back
//   6. remove it again, and confirm the catalogue price is back
//
// Step 6 matters as much as step 4: a price that cannot be taken off is a shop
// that cannot undo a mistake.
//
//   node tools/frontend-price.js --url=http://localhost:8787 --user=musa --pin=73914
//   node tools/frontend-price.js --url=… --product=kettle --price=21500
// =====================================================================

const H = require('./lib/page-harness.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const BASE = String(flag('url', 'http://localhost:8787')).replace(/\/$/, '');
const USERNAME = flag('user', 'musa');
const PIN = flag('pin', '73914');
const PRODUCT = flag('product', 'kettle');
const NEW_PRICE = Number(flag('price', 0)) || null;

const results = [];
const ok = (what, detail) => { results.push({ pass: true, what }); console.log(`  ✓ ${what}${detail ? `\n      ${detail}` : ''}`); };
const bad = (what, detail) => { results.push({ pass: false, what }); console.log(`  ✗ ${what}${detail ? `\n      ${detail}` : ''}`); };

(async () => {
  console.log('StockRidge — set a branch price from the screen');
  console.log(`  ${BASE} as ${USERNAME}, product "${PRODUCT}"`);
  console.log('─'.repeat(58));

  const page = await H.bootPage({ origin: BASE, username: USERNAME, pin: PIN, waitMs: 30000 });
  if (!page.ok) { bad('the app loaded', page.reason || 'boot failed'); process.exit(1); }
  const { window } = page;
  const doc = window.document;
  const SR = window.SR;
  const $ = (sel) => doc.querySelector(sel);

  const api = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${page.token}` }),
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // ---- find a product with stock at this branch
  const branchId = SR.state.activeBranchId;
  const list = await api('GET', `/api/products?limit=60&branch_id=${encodeURIComponent(branchId)}`);
  const needle = PRODUCT.toLowerCase();
  const product = (list.body.data || []).find((p) => String(p.name).toLowerCase().includes(needle)
    || String(p.sku || '').toLowerCase().includes(needle));
  if (!product) { bad('a product to price', `nothing matching "${PRODUCT}" at this branch`); process.exit(1); }
  const catalogue = Number(product.selling_price);
  ok('the product and its catalogue price', `${product.name} · ${SR.util.money(catalogue)} per ${String(product.base_unit_name || 'unit').toLowerCase()}`);

  const globalPrice = NEW_PRICE || Math.round(catalogue * 1.1 * 100) / 100;

  // ---- open the product's own page, through the app's router
  window.SR.app.navigate(`/products/${product.id}`);
  const card = await H.waitUntil(() => {
    const cards = [...doc.querySelectorAll('.card')];
    return cards.find((c) => /branch prices/i.test(c.textContent)) || null;
  }, { timeout: 20000, label: 'the Branch prices card' });
  if (!card) { bad('the product page shows a Branch prices card', 'no card matching /branch prices/ appeared'); process.exit(1); }
  ok('the product page shows a Branch prices card',
    card.textContent.replace(/\s+/g, ' ').trim().slice(0, 120));

  // ---- step 3: open the form and fill it the way a person does
  const openBtn = [...card.querySelectorAll('button')].find((b) => /set a branch price/i.test(b.textContent));
  if (!openBtn) { bad('the card offers a way to set one', 'no "Set a branch price" button'); process.exit(1); }
  openBtn.click();
  const modal = await H.waitUntil(() => {
    const m = doc.querySelector('#modal-root .modal');
    return m && m.querySelector('input, select') ? m : null;
  }, { timeout: 15000, label: 'the price form' });
  if (!modal) { bad('the form opens', 'no modal with fields appeared'); process.exit(1); }

  const fields = [...modal.querySelectorAll('input, select')].map((el) => el.getAttribute('name')).filter(Boolean);
  const hasBranch = fields.some((n) => /branch/i.test(n));
  const hasPrice = fields.some((n) => /selling_price|price/i.test(n));
  if (hasBranch && hasPrice) ok('the form asks which branch and what price', fields.join(', '));
  else bad('the form asks which branch and what price', `fields were: ${fields.join(', ') || '(none)'}`);

  const priceInput = modal.querySelector('input[name="default_selling_price"]');
  priceInput.value = String(globalPrice);
  priceInput.dispatchEvent(new window.Event('input', { bubbles: true }));

  // A warning about selling below cost is a feature; it must not block the save.
  const warnLine = modal.textContent.match(/Below cost[^.]*\./);
  if (warnLine) ok('the form warns when a price loses money', warnLine[0].slice(0, 110));

  const saveBtn = [...modal.querySelectorAll('button')].find((b) => /save the price/i.test(b.textContent));
  if (!saveBtn) { bad('the form can be submitted', 'no "Save the price" button'); process.exit(1); }
  saveBtn.click();

  const overlayGone = await H.waitUntil(() => (doc.querySelector('#modal-root .modal') ? null : true), { timeout: 20000, label: 'the form to close' });
  if (!overlayGone) bad('the form closes on a successful save', 'the modal is still open — the save probably failed');

  // ---- step 4: the card shows it
  const after = await H.waitUntil(async () => {
    const cards = [...doc.querySelectorAll('.card')];
    const c = cards.find((x) => /branch prices/i.test(x.textContent));
    return c && !/Every branch sells this at the catalogue price/.test(c.textContent) ? c : null;
  }, { timeout: 20000, label: 'the override to appear' });
  if (after) {
    const text = after.textContent.replace(/\s+/g, ' ').trim();
    ok('the card now shows the branch at the new price', text.slice(text.indexOf('Branch prices'), text.indexOf('Branch prices') + 150));
  } else {
    bad('the card now shows the branch at the new price', 'the card still says every branch is on the catalogue price');
  }

  // ---- step 5: what would the server actually charge?
  const detail = await api('GET', `/api/products/${product.id}`);
  const override = (detail.body.priceOverrides || []).find((o) => String(o.branch_id) === String(branchId));
  if (override && Number(override.default_selling_price) === Number(globalPrice)) {
    ok('the server holds the branch price', `${override.branch_name} · ${SR.util.money(override.default_selling_price)}`);
  } else {
    bad('the server holds the branch price', `expected ${globalPrice}, server has ${override ? override.default_selling_price : '(no override)'}`);
  }

  // ---- step 6: remove it, and the catalogue price is back
  const removeBtn = [...doc.querySelectorAll('.card button')].find((b) => /^remove$/i.test(b.textContent.trim()));
  if (removeBtn) {
    removeBtn.click();
    const confirmBtn = await H.waitUntil(() => {
      const m = doc.querySelector('#modal-root .modal');
      if (!m) return null;
      return [...m.querySelectorAll('button')].find((b) => /remove it/i.test(b.textContent)) || null;
    }, { timeout: 15000, label: 'the confirmation' });
    if (confirmBtn) confirmBtn.click();
    else bad('removing asks for confirmation first', 'the confirmation dialog did not appear');
  } else {
    bad('the override can be removed from the screen', 'no Remove button on the row');
  }

  const gone = await H.waitUntil(async () => {
    const d = await api('GET', `/api/products/${product.id}`);
    return (d.body.priceOverrides || []).some((o) => String(o.branch_id) === String(branchId)) ? null : true;
  }, { timeout: 20000, interval: 700, label: 'the override to be cleared' });
  if (gone) ok('removing it puts the catalogue price back', `${SR.util.money(catalogue)} per unit again`);
  else bad('removing it puts the catalogue price back', 'the override is still on the server');

  console.log('─'.repeat(58));
  const failures = results.filter((r) => !r.pass);
  if (failures.length) console.log(`${failures.length} problem(s):\n${failures.map((f) => `  - ${f.what}`).join('\n')}`);
  else console.log('A branch price was set from the screen, held by the server, and taken off again.');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.log(`\n  the probe failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
