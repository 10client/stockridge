'use strict';
// =====================================================================
// test/e2e/multi-business.test.js — TWO BUSINESSES MUST NOT BLEED INTO EACH OTHER
// =====================================================================
// THE DEFECT THIS EXISTS FOR, found on a live deployment:
//
// `POST /api/users` resolved the BUSINESS before the BRANCH, and passed an
// options object into a parameter that expects a branch row. For the platform
// administrator — who belongs to no business and is therefore "unpinned" — the
// business then fell through to `client_settings.primary_business_id` and, when
// that was empty, to "the oldest live business".
//
// So an owner created for a branch of the SECOND business was recorded against
// the FIRST, with the second's branch attached. Scope is derived from the
// business on the user row, so that user's reports and dashboard were scoped to
// a company they did not work for — and `tools/verify-deployment.js` caught it
// only because the sales report returned zero rows for a business that had a sale.
//
// Nothing in the suite covered two businesses in one deployment, which is the
// whole point of the multi-business half of the product. Every test provisioned
// exactly one.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDeployment, ADMIN_PIN } = require('../helpers/deployment');
const { watToday } = require('../../domain/time');

/** Provision a business and return the ids the follow-on steps need. */
async function createBusiness(world, adminToken, { name, profileCode, city }) {
  const res = await world.call('POST', '/api/businesses', {
    token: adminToken,
    body: {
      name,
      profile_code: profileCode,
      vat_registered: true,
      branch: { name: `${name} Main`, city, state: 'FCT', opening_cash: 50000 },
    },
  });
  if (res.status !== 201) throw new Error(`business ${name} failed: ${res.text.slice(0, 300)}`);
  return { id: String(res.json.id), branchId: String(res.json.branch_id), name };
}

/** Create a user, sign in as them, and sell one product in ONE of the businesses. */
async function tradeAs(world, adminToken, business, label) {
  const pin = '24680';
  const username = `${label}${Date.now().toString(36).slice(-4)}`;
  const created = await world.call('POST', '/api/users', {
    token: adminToken,
    body: {
      full_name: `${label} Owner`, username, role: 'OWNER',
      pin, confirm_pin: pin, branch_id: business.branchId,
    },
  });
  if (created.status !== 201) throw new Error(`user ${label} failed: ${created.text.slice(0, 300)}`);

  const token = await world.login(username, pin);
  const scope = `business_id=${encodeURIComponent(business.id)}&branch_id=${encodeURIComponent(business.branchId)}`;

  const list = await world.call('GET', `/api/products?${scope}&limit=50`, { token });
  const catalogue = (list.json && list.json.data) || [];
  if (!catalogue.length) throw new Error(`${label}: no catalogue`);

  let product = null;
  for (const candidate of catalogue) {
    const detail = await world.call('GET', `/api/products/${candidate.id}`, { token });
    const units = (detail.json && detail.json.units) || [];
    const variants = (detail.json && detail.json.variants) || [];
    if (units.length && !variants.length) { product = { ...candidate, unit: units[0].code }; break; }
  }
  if (!product) throw new Error(`${label}: no sellable product`);

  const price = Number(product.selling_price) || 10000;
  const received = await world.call('POST', '/api/stock/receive', {
    token,
    idempotencyKey: `${label}-receive`,
    body: {
      branch_id: business.branchId, product_id: product.id, unit_code: product.unit,
      quantity: 5, cost_price: Math.round(price * 0.6), selling_price: price,
    },
  });
  if (received.status !== 201) throw new Error(`${label}: receive failed ${received.text.slice(0, 200)}`);

  const sale = await world.call('POST', '/api/sales', {
    token,
    idempotencyKey: `${label}-sale`,
    body: {
      branch_id: business.branchId,
      business_id: business.id,
      sale_type: 'RETAIL',
      sold_at: `${watToday()} 10:00:00`,
      device_id: `${label}-device`,
      payments: [{ method: 'CASH', amount: price }],
      lines: [{ product_id: product.id, quantity: 1, unit_code: product.unit, unit_price: price }],
    },
  });
  if (sale.status !== 201) throw new Error(`${label}: sale failed ${sale.text.slice(0, 300)}`);

  return { token, username, price, saleId: sale.json.saleId, product };
}

test('a user created for a branch belongs to that branch\'s business', async () => {
  const world = await freshDeployment({ label: 'multibiz' });
  try {
    const adminToken = await world.login('admin', ADMIN_PIN);

    const electronics = await createBusiness(world, adminToken, { name: 'Ridge Electronics', profileCode: 'ELECTRONICS', city: 'Abuja' });
    const furniture = await createBusiness(world, adminToken, { name: 'Ridge Furniture', profileCode: 'FURNITURE', city: 'Lagos' });

    // The second business is the interesting one: the first is what the old
    // fallback ("the oldest live business") would have chosen instead.
    const pin = '13579';
    const created = await world.call('POST', '/api/users', {
      token: adminToken,
      body: {
        full_name: 'Furniture Owner', username: 'furnowner', role: 'OWNER',
        pin, confirm_pin: pin, branch_id: furniture.branchId,
      },
    });
    assert.equal(created.status, 201, created.text.slice(0, 300));

    const ownerToken = await world.login('furnowner', pin);
    const me = await world.call('GET', '/api/auth/me', { token: ownerToken });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.business.id, furniture.id,
      'a user created for the furniture branch must belong to Ridge Furniture, not to whichever business was provisioned first');
    assert.equal(me.json.user.business.name, 'Ridge Furniture');
    assert.equal(me.json.user.branch.id, furniture.branchId);
    assert.notEqual(me.json.user.business.id, electronics.id);
  } finally {
    world.cleanup();
  }
});

test('two businesses in one deployment keep their takings apart', async () => {
  const world = await freshDeployment({ label: 'multibiz2' });
  try {
    const adminToken = await world.login('admin', ADMIN_PIN);
    const electronics = await createBusiness(world, adminToken, { name: 'Ridge Electronics', profileCode: 'ELECTRONICS', city: 'Abuja' });
    const furniture = await createBusiness(world, adminToken, { name: 'Ridge Furniture', profileCode: 'FURNITURE', city: 'Lagos' });

    const e = await tradeAs(world, adminToken, electronics, 'eo');
    const f = await tradeAs(world, adminToken, furniture, 'fo');

    // Each owner's DEFAULT report — no business_id in the query — must be their
    // own business. This is where the defect showed: the furniture owner's report
    // was scoped to the electronics business, so it was empty.
    const ownE = await world.call('GET', `/api/reports/sales?from=${watToday()}&to=${watToday()}`, { token: e.token });
    assert.equal(ownE.status, 200, ownE.text.slice(0, 200));
    assert.equal(ownE.json.totals.transactions, 1, `the electronics owner must see exactly their own sale, saw ${ownE.json.totals.transactions}`);
    assert.equal(ownE.json.totals.grossRevenue, e.price);

    const ownF = await world.call('GET', `/api/reports/sales?from=${watToday()}&to=${watToday()}`, { token: f.token });
    assert.equal(ownF.status, 200, ownF.text.slice(0, 200));
    assert.equal(ownF.json.totals.transactions, 1, `the furniture owner must see exactly their own sale, saw ${ownF.json.totals.transactions}`);
    assert.equal(ownF.json.totals.grossRevenue, f.price);

    // And an owner who runs both businesses can ask for either one explicitly.
    const askedE = await world.call('GET', `/api/reports/sales?business_id=${electronics.id}&from=${watToday()}&to=${watToday()}`, { token: f.token });
    assert.equal(askedE.status, 200);
    assert.equal(askedE.json.totals.transactions, 1,
      'an explicitly requested business must be honoured when the caller may reach it — otherwise one owner cannot run two businesses');
  } finally {
    world.cleanup();
  }
});

test('an owner cannot reach a business that is not theirs by asking for it', async () => {
  // The counterpart to the test above, and the reason the requested business is
  // gated on scope rather than simply preferred: a MANAGER is scoped by business,
  // so naming somebody else's business_id must be refused, not honoured.
  const world = await freshDeployment({ label: 'multibiz3' });
  try {
    const adminToken = await world.login('admin', ADMIN_PIN);
    const mine = await createBusiness(world, adminToken, { name: 'Ridge Electronics', profileCode: 'ELECTRONICS', city: 'Abuja' });
    const theirs = await createBusiness(world, adminToken, { name: 'Ridge Furniture', profileCode: 'FURNITURE', city: 'Lagos' });

    // A manager owns one branch, in one business.
    const pin = '48213';
    const created = await world.call('POST', '/api/users', {
      token: adminToken,
      body: {
        full_name: 'Branch Manager', username: 'mgrone', role: 'MANAGER',
        pin, confirm_pin: pin, branch_id: mine.branchId,
      },
    });
    assert.equal(created.status, 201, created.text.slice(0, 300));
    const mgrToken = await world.login('mgrone', pin);

    const me = await world.call('GET', '/api/auth/me', { token: mgrToken });
    assert.equal(me.json.user.business.id, mine.id, 'the manager belongs to the business they were created for');

    const peek = await world.call('GET', `/api/reports/sales?business_id=${theirs.id}&from=${watToday()}&to=${watToday()}`, { token: mgrToken });
    assert.equal(peek.status, 403, `naming another business must be refused, got ${peek.status}`);
    assert.equal(peek.json.code, 'BUSINESS_SCOPE_VIOLATION');
  } finally {
    world.cleanup();
  }
});
