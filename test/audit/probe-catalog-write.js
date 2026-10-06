'use strict';
// =====================================================================
// test/audit/probe-catalog-write.js — IS THE CATALOGUE WRITABLE?
// =====================================================================
// A one-shot probe, kept in the tree because it is the reproduction for a defect that
// reached all three deployments: POST /api/products answered 500 "check.ladder is not
// iterable" for every attempt, and PUT /api/products/:id answered 409 DUPLICATE for every
// ladder replacement. Both were found by T4c; both are fixed; this is how the fix is
// checked against a deployment a client actually uses.
//
//   AUDIT_BASE=https://… AUDIT_USER=… AUDIT_PIN=… node test/audit/probe-catalog-write.js
//
// It leaves ONE product behind (named PROBE-…), and prints the SKU so it can be swept:
//   tools/clean-fixtures.js --dry     (or the --clean sweep that owns PROBE- prefixes)
// =====================================================================
const base = process.env.AUDIT_BASE, user = process.env.AUDIT_USER, pin = process.env.AUDIT_PIN;
if (!base || !user || !pin) { console.log('set AUDIT_BASE, AUDIT_USER and AUDIT_PIN'); process.exit(1); }
const sku = `PROBE-${Date.now().toString(36)}`;
const body = (r) => r.text();
(async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, pin }),
  });
  const token = (await login.json()).token;
  const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const say = (label, status, text) => console.log(`${label.padEnd(34)} ${status}  ${String(text).slice(0, 120)}`);

  const create = await fetch(`${base}/api/products`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: `Probe Product ${sku}`, sku, cost_price: 100, selling_price: 150 }),
  });
  const created = await create.json().catch(() => ({}));
  say('CREATE (default ladder)', create.status, JSON.stringify(created));
  const id = created.id || (created.product && created.product.id);

  // A deployment handed over but not yet set up has NO business, and a product cannot
  // exist without one: the refusal is the correct answer, not a failed probe. The sample
  // and production deployments are deliberately left in exactly this state (one admin
  // account, no business), so the probe says so and stops rather than inventing a tenant
  // on somebody's live deployment.
  if (create.status === 400 && created.code === 'BUSINESS_REQUIRED') {
    console.log('NOTHING TO WRITE                    this deployment has no business yet — the expected handover state');
    process.exit(0);
  }

  if (id) {
    const back = await fetch(`${base}/api/products/${id}`, { headers: H });
    const detail = await back.json().catch(() => ({}));
    const units = ((detail.product && (detail.product.units || detail.product.ladder)) || detail.units || []);
    console.log('READ BACK units                    ', units.map((u) => `${u.code}×${u.quantity_in_base != null ? u.quantity_in_base : u.quantityInBase}`).join(', ') || 'NONE — this product cannot be sold');

    const edit = await fetch(`${base}/api/products/${id}`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({
        name: `Probe Product ${sku} (edited)`, selling_price: 210,
        units: [{ code: 'PIECE', name: 'Piece', quantityInBase: 1, isDefaultSell: true },
                { code: 'CARTON', name: 'Carton', quantityInBase: 12, isDefaultSell: false }],
      }),
    });
    say('EDIT (replacement ladder)', edit.status, await body(edit));

    const after = await fetch(`${base}/api/products/${id}`, { headers: H });
    const a = await after.json().catch(() => ({}));
    const u2 = ((a.product && (a.product.units || a.product.ladder)) || a.units || []);
    console.log('UNITS AFTER THE EDIT               ', u2.map((u) => `${u.code}×${u.quantity_in_base != null ? u.quantity_in_base : u.quantityInBase}`).join(', ') || 'NONE');
  }
  if (id) console.log(`LEFTOVER SKU ${sku} — sweep with the PROBE- prefix sweep`);
})().catch((e) => { console.log('PROBE FAILED', e.message); process.exit(1); });
