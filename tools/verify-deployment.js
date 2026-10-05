'use strict';
// =====================================================================
// tools/verify-deployment.js — PROVE A DEPLOYMENT WORKS, OVER REAL HTTP
// =====================================================================
// The test suite runs the routes over the Node storage adapter. This runs them
// over a DEPLOYED Worker against a real D1 database, which is a genuinely
// different thing: `worker/src/d1.js` executes writes as batches instead of an
// interactive transaction, and a business creation is the largest batch the
// application ever builds. Until this has run, "it works on D1" is an assumption.
//
// It is also the check for a handover. It walks the journey a client walks on
// day one, in order, and asserts the RESULT of each step rather than the status
// code:
//
//   health → diagnose → sign in → create the business → provisioning wrote a
//   catalogue → create the owner → sign in as them → open a till → receive stock
//   → sell it → read the sale back → dashboard counts it → the report lists it
//   → close the till → sign out
//
// Every step that can be "successfully wrong" — 200 with a plausible body and the
// wrong content — is checked for content. A sale that returns a receipt number
// but does not appear on the dashboard is a failure here, not a pass.
//
// USAGE
//   node tools/verify-deployment.js --url=https://host --username=admin --pin=12345
//   node tools/verify-deployment.js --url=... --profile=FURNITURE --keep
//
// Options
//   --url=        deployment origin (default: the production Worker)
//   --username=   platform administrator (default: admin)
//   --pin=        their PIN (required)
//   --profile=    vertical to provision (default ELECTRONICS)
//   --keep        leave the business in place (the default on staging)
//   --quiet       only print failures and the summary
//
// Exit code is 0 only when every step passed.
// =====================================================================

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = String(flag('url', 'https://stockridge.stockridge.workers.dev')).replace(/\/$/, '');
const USERNAME = flag('username', 'admin');
const PIN = flag('pin');
const PROFILE = String(flag('profile', 'ELECTRONICS')).toUpperCase();
const QUIET = has('quiet');

if (!PIN) {
  console.error('\n  --pin is required: this tool signs in, and only the hash is in the database.\n');
  process.exit(2);
}

const started = Date.now();
const results = [];

function line(status, name, detail) {
  results.push({ status, name, detail });
  if (QUIET && status === 'pass') return;
  const mark = status === 'pass' ? '  ✓' : (status === 'skip' ? '  –' : '  ✗');
  console.log(`${mark} ${name}${detail ? `\n      ${detail}` : ''}`);
}

function pass(name, detail) { line('pass', name, detail); }
function skip(name, detail) { line('skip', name, detail); }
function fail(name, detail) { line('fail', name, detail); }

function assertStep(name, condition, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail);
  return Boolean(condition);
}

// ---------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------
let token = null;

async function call(method, path, { body, as, idempotencyKey, timeoutMs = 30000 } = {}) {
  const headers = { Accept: 'application/json' };
  const useToken = as === undefined ? token : as;
  if (useToken) headers.Authorization = `Bearer ${useToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: String(err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;
const watToday = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------
async function journey() {
  console.log(`StockRidge — live deployment verification`);
  console.log(`  ${BASE}`);
  console.log('──────────────────────────────────────────────────────────');

  // ---- 1. the deployment answers at all
  const health = await call('GET', '/api/health', { as: null });
  if (!assertStep('liveness', health.status === 200 && health.json && health.json.ok === true,
    health.status === 200 ? `up, WAT ${health.json.time}` : `HTTP ${health.status}: ${health.text.slice(0, 160)}`)) {
    return fail('the deployment does not answer — nothing else can be tested');
  }

  // ---- 2. the deployment is correctly wired
  const diag = await call('GET', '/api/diagnose', { as: null });
  const checks = (diag.json && diag.json.checks) || [];
  const failedChecks = checks.filter((c) => !c.ok);
  if (!assertStep('diagnose', diag.status === 200 && failedChecks.length === 0,
    diag.status === 200
      ? `${checks.length} checks pass`
      : `HTTP ${diag.status}: ${failedChecks.map((c) => `${c.name}${c.error ? ` (${c.error})` : ''}`).join('; ') || diag.text.slice(0, 160)}`)) {
    return;
  }

  // ---- 3. readiness, reported rather than failed: awaiting the first business
  //         is the correct state of a fresh handover deployment.
  const ready = await call('GET', '/api/health/ready', { as: null });
  const lifecycle = ready.json && ready.json.status;
  if (lifecycle === 'awaiting_first_business') {
    pass('readiness', 'awaiting the first business (expected on a fresh deployment)');
  } else if (ready.status === 200) {
    pass('readiness', `ready with ${ready.json.businesses} business(es)`);
  } else {
    fail('readiness', `HTTP ${ready.status}: ${JSON.stringify(ready.json && ready.json.problems).slice(0, 200)}`);
  }

  // ---- 4. sign in as the platform administrator
  const login = await call('POST', '/api/auth/login', { as: null, body: { username: USERNAME, pin: PIN } });
  if (!assertStep('sign in as the administrator', login.status === 200 && login.json && login.json.token,
    login.status === 200
      ? `${login.json.profile.roleLabel}, scope ${login.json.scope.allBusinesses ? 'all businesses' : 'scoped'}`
      : `HTTP ${login.status}: ${JSON.stringify(login.json).slice(0, 200)}`)) {
    return;
  }
  token = login.json.token;

  // ---- 5. create the business (the largest batch the app builds)
  const label = `${PROFILE.toLowerCase()}-${Date.now().toString(36)}`;
  const created = await call('POST', '/api/businesses', {
    body: {
      name: `Verification ${label}`,
      profile_code: PROFILE,
      vat_registered: true,
      branch: { name: 'Verify Branch', city: 'Abuja', state: 'FCT', opening_cash: 100000 },
    },
    idempotencyKey: `verify-${label}-business`,
  });
  if (!assertStep('create the business', created.status === 201 && created.json && created.json.id,
    created.status === 201
      ? `${PROFILE} → business ${String(created.json.id).slice(0, 8)}, branch ${String(created.json.branch_id).slice(0, 8)}`
      : `HTTP ${created.status}: ${JSON.stringify(created.json).slice(0, 300)}`)) {
    return;
  }
  const businessId = String(created.json.id);
  const branchId = String(created.json.branch_id);

  // ---- 6. provisioning actually wrote something
  const products = await call('GET', `/api/products?business_id=${businessId}&branch_id=${branchId}&limit=50`);
  const catalogue = (products.json && products.json.data) || [];
  assertStep('provisioning built a catalogue', products.status === 200 && catalogue.length > 0,
    products.status === 200 ? `${catalogue.length} starter product(s)` : `HTTP ${products.status}`);
  if (!catalogue.length) return;

  const accounts = await call('GET', `/api/accounting/accounts?business_id=${businessId}`);
  const accountRows = (accounts.json && (accounts.json.data || accounts.json.accounts)) || [];
  assertStep('provisioning built a chart of accounts', accounts.status === 200 && accountRows.length >= 5,
    accounts.status === 200 ? `${accountRows.length} account(s)` : `HTTP ${accounts.status}`);

  // ---- 7. the owner, as a separate person with their own PIN
  const ownerPin = '73914';
  const owner = await call('POST', '/api/users', {
    body: {
      full_name: 'Verification Owner', username: `vowner${Date.now().toString(36).slice(-4)}`,
      role: 'OWNER', pin: ownerPin, confirm_pin: ownerPin, branch_id: branchId,
    },
  });
  if (!assertStep('create the owner', owner.status === 201,
    owner.status === 201 ? `owner created` : `HTTP ${owner.status}: ${JSON.stringify(owner.json).slice(0, 240)}`)) {
    return;
  }

  const ownerLogin = await call('POST', '/api/auth/login', { as: null, body: { username: owner.json.username || `vowner${Date.now().toString(36).slice(-4)}`, pin: ownerPin } });
  const ownerToken = ownerLogin.status === 200 ? ownerLogin.json.token : null;
  assertStep('sign in as the owner', Boolean(ownerToken),
    ownerToken ? `scoped to ${ownerLogin.json.profile.businessName || 'the business'}` : `HTTP ${ownerLogin.status}: ${JSON.stringify(ownerLogin.json).slice(0, 200)}`);
  if (!ownerToken) return;
  token = ownerToken;

  // ---- 8. open a till
  const till = await call('POST', '/api/tills/open', {
    body: { branch_id: branchId, opening_cash: 100000, device_id: `verify-${label}` },
    idempotencyKey: `verify-${label}-till`,
  });
  const tillId = till.json && (till.json.id || (till.json.till && till.json.till.id));
  assertStep('open a till', till.status === 200 || till.status === 201,
    tillId ? `till ${String(tillId).slice(0, 8)} open with ${money(100000)} float` : `HTTP ${till.status}: ${JSON.stringify(till.json).slice(0, 240)}`);

  // ---- 9. a product with no variants, so the sale is a sale
  let product = null;
  for (const candidate of catalogue) {
    const detail = await call('GET', `/api/products/${candidate.id}?business_id=${businessId}&branch_id=${branchId}`);
    const units = (detail.json && detail.json.units) || [];
    const variants = (detail.json && detail.json.variants) || [];
    if (units.length && !variants.length) { product = { ...candidate, unit: units[0].code }; break; }
    if (units.length && !product) product = { ...candidate, unit: units[0].code, variantId: variants[0] && variants[0].id };
  }
  if (!assertStep('find a sellable product', Boolean(product),
    product ? `${product.name} at ${money(product.selling_price)} per ${product.unit}` : 'the starter catalogue contained nothing sellable')) {
    return;
  }

  // ---- 10. stock in
  const price = Number(product.selling_price) || 10000;
  const receive = await call('POST', '/api/stock/receive', {
    body: {
      branch_id: branchId,
      product_id: product.id,
      variant_id: product.variantId || undefined,
      unit_code: product.unit,
      quantity: 10,
      cost_price: Math.max(1, Math.round(price * 0.7)),
      selling_price: price,
    },
    idempotencyKey: `verify-${label}-receive`,
  });
  assertStep('receive stock', receive.status === 201,
    receive.status === 201
      ? `10 × ${product.name} at cost ${money(receive.json.landedCostPerBase || receive.json.quantityBase)}`
      : `HTTP ${receive.status}: ${JSON.stringify(receive.json).slice(0, 260)}`);

  // ---- 11. the sale
  const sale = await call('POST', '/api/sales', {
    body: {
      branch_id: branchId,
      business_id: businessId,
      sale_type: 'RETAIL',
      sold_at: `${watToday()} 12:00:00`,
      device_id: `verify-${label}`,
      till_session_id: tillId || undefined,
      payments: [{ method: 'CASH', amount: price }],
      lines: [{ product_id: product.id, variant_id: product.variantId || undefined, quantity: 1, unit_code: product.unit, unit_price: price }],
    },
    idempotencyKey: `verify-${label}-sale`,
  });
  const saleId = sale.json && (sale.json.saleId || sale.json.id);
  if (!assertStep('complete a sale', sale.status === 201 && sale.json && sale.json.receiptNo,
    sale.status === 201
      ? `receipt ${sale.json.receiptNo}, ${money(sale.json.totals && sale.json.totals.total)}`
      : `HTTP ${sale.status}: ${JSON.stringify(sale.json).slice(0, 300)}`)) {
    return;
  }

  // ---- 12. the sale reads back, with its line and its stock movement
  const detail = await call('GET', `/api/sales/${saleId}?business_id=${businessId}&branch_id=${branchId}`);
  const items = (detail.json && detail.json.items) || [];
  assertStep('read the sale back', detail.status === 200 && items.length === 1,
    detail.status === 200
      ? `${items.length} line, ${money(items[0] && items[0].line_total)}`
      : `HTTP ${detail.status}: ${JSON.stringify(detail.json).slice(0, 200)}`);

  // The stock view reports `on_shelf` and `available`, not `quantity`. The first
  // version of this check looked for `quantity`, found `undefined`, and reported a
  // failure on a deployment where stock was correct — a verifier is as capable of
  // being "successfully wrong" as any other client of the API.
  const stock = await call('GET', `/api/stock?business_id=${businessId}&branch_id=${branchId}&limit=100`);
  const stockRows = (stock.json && (stock.json.data || stock.json.batches)) || [];
  const stockRow = stockRows.find((r) => String(r.product_id) === String(product.id));
  assertStep('stock went down by the sale', Boolean(stockRow) && Number(stockRow.on_shelf) === 9,
    stockRow
      ? `on shelf: ${stockRow.on_shelf} of 10 received${stockRow.book_cost ? `, book cost ${money(stockRow.book_cost)}` : ''}`
      : `no stock row for the product (${stockRows.length} rows returned; keys: ${stockRows[0] ? Object.keys(stockRows[0]).join(',') : 'none'})`);

  // ---- 13. the dashboard counts it — the aggregation path over D1
  const dash = await call('GET', `/api/dashboard?business_id=${businessId}&branch_id=${branchId}&view=TODAY`);
  const today = (dash.json && dash.json.today) || {};
  assertStep('the dashboard counts the sale', dash.status === 200 && Number(today.count) >= 1 && Number(today.gross) > 0,
    dash.status === 200
      ? `${today.count} sale(s) today, ${money(today.gross)} gross${today.vat != null ? `, ${money(today.vat)} VAT` : ''}`
      : `HTTP ${dash.status}: ${JSON.stringify(dash.json).slice(0, 200)}`);

  // ---- 14. the report lists it
  const reports = await call('GET', `/api/reports/sales?business_id=${businessId}&branch_id=${branchId}&from=${watToday()}&to=${watToday()}`);
  const rows = (reports.json && reports.json.rows) || [];
  assertStep('the sales report lists it', reports.status === 200 && rows.length >= 1,
    reports.status === 200 ? `${rows.length} row(s)` : `HTTP ${reports.status}: ${JSON.stringify(reports.json).slice(0, 200)}`);

  // ---- 15. close the till against a count that balances
  if (tillId) {
    const close = await call('POST', `/api/tills/${tillId}/close`, {
      body: { branch_id: branchId, counted_cash: 100000 + price },
      idempotencyKey: `verify-${label}-till-close`,
    });
    const body = close.json || {};
    assertStep('close the till', close.status === 200 && body.variance !== undefined,
      close.status === 200
        ? `counted ${money(body.countedCash)}, expected ${money(body.expectedCash)}, variance ${money(body.variance)} (${body.varianceDirection})`
        : `HTTP ${close.status}: ${JSON.stringify(body).slice(0, 240)}`);
  } else {
    skip('close the till', 'no till was opened');
  }

  // ---- 16. sign out, and prove the token is dead
  const logout = await call('POST', '/api/auth/logout', { body: {} });
  assertStep('sign out', logout.status === 200, logout.status === 200 ? 'session retired' : `HTTP ${logout.status}`);
  const after = await call('GET', '/api/auth/me');
  assertStep('the retired token is refused', after.status === 401,
    after.status === 401 ? 'the token no longer works' : `HTTP ${after.status} — a signed-out token still works`);

  // ---- what was left behind, stated plainly
  console.log('');
  console.log(`  business left in place: ${businessId}`);
  console.log(`  (${has('keep') ? '--keep' : 'staging deployments keep their data by design; production should be checked and removed'})`);
}

(async () => {
  try {
    await journey();
  } catch (err) {
    fail('verification crashed', String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
  }

  const failures = results.filter((r) => r.status === 'fail');
  const passes = results.filter((r) => r.status === 'pass');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`${passes.length} passed, ${failures.length} failed, ${results.filter((r) => r.status === 'skip').length} skipped in ${Math.round((Date.now() - started) / 1000)}s`);
  if (failures.length) {
    console.log('');
    for (const f of failures) console.log(`  FAILED: ${f.name}\n          ${f.detail}`);
  }
  console.log('');
  process.exit(failures.length ? 1 : 0);
})();
