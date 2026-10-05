'use strict';
// =====================================================================
// test/helpers/deployment.js — A DEPLOYMENT A TEST CAN ACTUALLY TRADE IN
// =====================================================================
// Several end-to-end tests need the same thing before they can test anything:
// a fresh deployment, one administrator, one business with a catalogue, one
// owner, one product on the shelf and one sale behind it.
//
// That setup is about sixty lines of HTTP calls. Duplicating it in each file
// would mean the day the business-creation contract changes, three tests fail
// for the same reason and one of them gets "fixed" differently. So it lives
// here, and each test asserts the parts it cares about.
//
// Everything goes through the HTTP surface rather than the services, on purpose:
// the bugs this suite has caught were all in the plumbing BETWEEN a screen and a
// service — a missing import, a wrong payload key, a placeholder count — and a
// service-level helper would have hidden every one of them.
// =====================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { provisionPlatform } = require('../../server/services/provisioningService');
const { createHttpApp } = require('../../server/app');
const { getSettings } = require('../../domain/planLimits');
const { watToday } = require('../../domain/time');

let counter = 0;

const ADMIN_PIN = '90210';
const OWNER_PIN = '48213';

/** A deployment with exactly one administrator in it: no business, no branch. */
async function freshDeployment({ label = 'helper' } = {}) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-${label}-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  await migrate(db);
  await provisionPlatform(db, { adminUsername: 'admin', adminPin: ADMIN_PIN });

  const settings = await getSettings(db);
  const app = createHttpApp({ db, jwtSecret: `${label}-secret`, settings });

  async function call(method, url, { token, body, idempotencyKey } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Device-Id': `${label}-device` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await app.fetch(new Request(`http://local${url}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = { _raw: text.slice(0, 400) }; }
    return { status: res.status, json, text };
  }

  return {
    db,
    file,
    app,
    call,
    async login(username, pin) {
      const r = await call('POST', '/api/auth/login', { body: { username, pin } });
      if (r.status !== 200) throw new Error(`login failed for ${username}: ${r.text.slice(0, 200)}`);
      return r.json.token;
    },
    cleanup() {
      try { db.close(); } catch (e) { /* already closed */ }
      for (const suffix of ['', '-wal', '-shm']) {
        const f = file + suffix;
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
    },
  };
}

/**
 * A deployment with a trading business: admin → business → owner → one product
 * on the shelf → one completed cash sale.
 *
 * Returns everything a follow-on test needs to act on: ids, the tokens, the
 * product, the sale and its first line.
 */
async function tradingDeployment({ label = 'trade', profileCode = 'ELECTRONICS', quantity = 10 } = {}) {
  const world = await freshDeployment({ label });
  const adminToken = await world.login('admin', ADMIN_PIN);

  const created = await world.call('POST', '/api/businesses', {
    token: adminToken,
    body: {
      name: `Test Trading ${counter}`,
      profile_code: profileCode,
      vat_registered: true,
      branch: { name: 'Main Branch', city: 'Abuja', state: 'FCT', opening_cash: 100000 },
    },
  });
  if (created.status !== 201) throw new Error(`business creation failed: ${created.text.slice(0, 300)}`);
  const businessId = created.json.id;
  const branchId = created.json.branch_id;

  const ownerRes = await world.call('POST', '/api/users', {
    token: adminToken,
    body: {
      full_name: 'Test Owner', username: 'owner', role: 'OWNER',
      pin: OWNER_PIN, confirm_pin: OWNER_PIN, branch_id: branchId,
    },
  });
  if (ownerRes.status !== 201) throw new Error(`owner creation failed: ${ownerRes.text.slice(0, 300)}`);
  const ownerToken = await world.login('owner', OWNER_PIN);

  const scope = `branch_id=${encodeURIComponent(branchId)}&business_id=${encodeURIComponent(businessId)}`;

  // A product with NO variants, so a sale is a sale and not a variant question.
  const list = await world.call('GET', `/api/products?${scope}&limit=50`, { token: ownerToken });
  let product = null;
  let baseUnit = null;
  let variantId = null;
  for (const candidate of (list.json.data || [])) {
    const detail = await world.call('GET', `/api/products/${candidate.id}`, { token: ownerToken });
    const variants = detail.json.variants || [];
    const units = detail.json.units || [];
    if (units.length && (!variants.length || !product)) {
      product = candidate;
      baseUnit = units[0].code;
      variantId = variants.length ? variants[0].id : null;
      if (!variants.length) break;
    }
  }
  if (!product) throw new Error('the starter catalogue contained no sellable product');

  const price = Number(product.selling_price) || 10000;
  const received = await world.call('POST', '/api/stock/receive', {
    token: ownerToken,
    body: {
      branch_id: branchId,
      product_id: product.id,
      variant_id: variantId || undefined,
      unit_code: baseUnit,
      quantity,
      cost_price: Math.max(1, Math.round(price * 0.7)),
      selling_price: price,
    },
    idempotencyKey: `${label}-receive`,
  });
  if (received.status !== 201) throw new Error(`stock receive failed: ${received.text.slice(0, 300)}`);

  const sale = await world.call('POST', '/api/sales', {
    token: ownerToken,
    idempotencyKey: `${label}-sale`,
    body: {
      branch_id: branchId,
      business_id: businessId,
      sale_type: 'RETAIL',
      sold_at: `${watToday()} 12:00:00`,
      device_id: `${label}-device`,
      payments: [{ method: 'CASH', amount: price }],
      lines: [{ product_id: product.id, variant_id: variantId || undefined, quantity: 1, unit_code: baseUnit, unit_price: price }],
    },
  });
  if (sale.status !== 201) throw new Error(`sale failed: ${sale.text.slice(0, 400)}`);

  const saleDetail = await world.call('GET', `/api/sales/${sale.json.saleId}`, { token: ownerToken });
  const firstItem = (saleDetail.json.items || [])[0] || null;

  return {
    ...world,
    adminToken,
    ownerToken,
    businessId,
    branchId,
    scope,
    product,
    baseUnit,
    variantId,
    price,
    saleId: sale.json.saleId,
    receiptNo: sale.json.receiptNo,
    saleItemId: firstItem ? firstItem.id : null,
    quantity,
  };
}

module.exports = { freshDeployment, tradingDeployment, ADMIN_PIN, OWNER_PIN };
