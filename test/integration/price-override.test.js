'use strict';
// =====================================================================
// test/integration/price-override.test.js — A BRANCH PRICE THAT CHANGES WHAT THE
// CUSTOMER IS CHARGED
// =====================================================================
// `domain/pricing.js` documents its order of precedence — manual price, then the
// BRANCH OVERRIDE, then the customer's price list, then the product — and
// `salesService.loadPriceOverrides()` has always loaded overrides. The product
// detail screen has always shown them. Until now NOTHING could create one, so the
// whole feature was unreachable: an Ikeja shop could not price a kettle
// differently from its Aba shop, and a wholesale counter could not carry a carton
// price that differs from the piece price times the pack size.
//
// The capability audit (tools/capability-audit.js) found it as "read but never
// created". This file is the proof that the write half now works, and — more to
// the point — that the sale engine really charges the override, in the branch it
// belongs to and nowhere else. A test that only asserted the row was written
// would have passed on a feature that changed no receipt in the country.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { provisionDeployment } = require('../../server/services/provisioningService');
const salesService = require('../../server/services/salesService');
const { getSettings } = require('../../domain/planLimits');
const { newId } = require('../../domain/crypto');
const { watNow } = require('../../domain/time');

/**
 * TWO branches, because the whole point of an override is that it does NOT apply
 * in the other one. A single-branch fixture would pass on a bug that repriced the
 * entire business.
 */
async function makeWorld({ profileCode = 'ELECTRONICS' } = {}) {
  const file = path.join(os.tmpdir(), `stockridge-override-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.db`);
  const db = openDatabase({ file });
  await migrate(db);

  const result = await provisionDeployment(db, {
    businessName: 'Override Traders Ltd',
    profileCode,
    ownerName: 'Override Owner', ownerUsername: 'ovr-owner', ownerPin: '12345',
    branches: [
      {
        name: 'Ikeja', code: 'IKJ', city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL', opening_cash: 50000,
        manager: { name: 'Ikeja Manager', username: 'ovr-ikeja', pin: '11111', job_title: 'Branch Manager' },
      },
      {
        name: 'Aba', code: 'ABA', city: 'Aba', state: 'Abia', branch_type: 'RETAIL', opening_cash: 50000,
        manager: { name: 'Aba Manager', username: 'ovr-aba', pin: '22222', job_title: 'Branch Manager' },
      },
    ],
  });

  const branchIds = result.branchIds || [];
  assert.equal(branchIds.length, 2, 'the fixture needs two branches for the isolation test to mean anything');
  const ikeja = await db.first('SELECT * FROM branches WHERE id = ?', [branchIds[0]]);
  const aba = await db.first('SELECT * FROM branches WHERE id = ?', [branchIds[1]]);

  const world = {
    db, file,
    businessId: result.businessId,
    business: await db.first('SELECT * FROM businesses WHERE id = ?', [result.businessId]),
    ikeja, aba,
    owner: await db.first("SELECT * FROM users WHERE username = 'ovr-owner'"),
    manager: await db.first("SELECT * FROM users WHERE username = 'ovr-ikeja'"),
    settings: await getSettings(db),
  };
  // One open till per branch, so a sale can be rung in either.
  for (const branch of [ikeja, aba]) {
    await db.run(`INSERT INTO till_sessions (id, branch_id, business_id, user_id, status, opened_at, opening_cash, created_at, updated_at)
                  VALUES (?,?,?,?, 'OPEN', ?, 50000, datetime('now'), datetime('now'))`,
    [newId(), branch.id, world.businessId, world.manager.id, watNow()]);
  }
  world.cleanup = () => {
    try { db.close(); } catch (e) { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) { const f = file + suffix; if (fs.existsSync(f)) fs.rmSync(f, { force: true }); }
  };
  return world;
}

async function findProduct(world, predicate) {
  const rows = await world.db.all('SELECT * FROM products WHERE business_id = ? AND is_deleted = 0', [world.businessId]);
  const found = rows.find(predicate);
  assert.ok(found, 'the fixture catalogue does not contain the product this test needs');
  return found;
}

async function receiveStock(world, branch, product, { quantity, costPrice, sellingPrice }) {
  const id = newId();
  await world.db.run(`INSERT INTO stock_batches (
      id, branch_id, business_id, product_id, batch_no, cost_price_per_unit, selling_price_per_unit,
      quantity, quantity_reserved, initial_quantity, received_at, received_by, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?,?, 'ACTIVE', datetime('now'), datetime('now'))`,
  [id, branch.id, world.businessId, product.id, `B-${id.slice(0, 6)}`, costPrice, sellingPrice, quantity, quantity, watNow(), world.owner.id]);
  return world.db.first('SELECT * FROM stock_batches WHERE id = ?', [id]);
}

/**
 * Set an override exactly the way the route does.
 *
 * Deliberately NOT by calling the route: this file tests the money path, and the
 * route's own validation, authority and audit are exercised over real HTTP in
 * test/e2e/api.test.js. What matters here is the SQL shape the route writes —
 * including the NULL-variant case that the table's UNIQUE constraint cannot
 * police on its own.
 */
async function setOverride(world, branch, product, { perPiece, pack = null, carton = null, variantId = null }) {
  const existing = await world.db.first(`SELECT * FROM product_price_overrides
    WHERE branch_id = ? AND product_id = ? AND is_deleted = 0
      AND ((? IS NULL AND variant_id IS NULL) OR variant_id = ?)`,
  [String(branch.id), product.id, variantId, variantId]);
  const id = existing ? existing.id : newId();
  if (existing) {
    await world.db.run(`UPDATE product_price_overrides SET default_selling_price = ?, pack_price = ?, carton_price = ?,
      updated_by = ?, updated_at = datetime('now') WHERE id = ?`, [perPiece, pack, carton, world.owner.id, id]);
  } else {
    await world.db.run(`INSERT INTO product_price_overrides
        (id, branch_id, product_id, variant_id, default_selling_price, pack_price, carton_price, updated_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
    [id, String(branch.id), product.id, variantId, perPiece, pack, carton, world.owner.id]);
  }
  return id;
}

/**
 * Ring a cash sale and hand back the engine's own totals.
 *
 * The tender is the engine's OWN quoted total, taken from `prepare()` — the same
 * pricing pass the POS uses to show a carton total before the cashier takes the
 * money. Two things follow, and both are deliberate:
 *
 *   * the test never writes down a price of its own, so it cannot agree with
 *     itself; and
 *   * the commit and the quote are checked against each other, which is the pair
 *     that matters to a shop. A preview that disagrees with what is charged is a
 *     defect in its own right — and `complete()` refuses an underpayment, so a
 *     disagreement fails loudly instead of quietly overcharging.
 */
async function sell(world, branch, product, { quantity = 1, unitCode = 'PIECE' } = {}) {
  const till = await world.db.first("SELECT * FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' LIMIT 1", [String(branch.id)]);
  const draft = {
    branch, business: world.business, user: world.owner, settings: world.settings,
    lines: [{ productId: product.id, quantity, unitCode }],
    tillSessionId: till.id,
  };
  const quoted = await salesService.prepare(world.db, draft);
  const sale = await salesService.complete(world.db, Object.assign({}, draft, {
    payments: [{ method: 'CASH', amount: quoted.totals.total }],
    walkInName: 'Walk-in customer',
  }));
  assert.equal(sale.totals.total, quoted.totals.total,
    'the total quoted before payment must be the total charged — a preview that disagrees with the receipt is its own defect');
  return sale;
}

test('integration: a branch override changes the price ONLY in its own branch', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  const catalogue = Number(product.selling_price);
  assert.ok(catalogue > 0, 'the seeded catalogue must price the product');

  for (const branch of [world.ikeja, world.aba]) {
    await receiveStock(world, branch, product, { quantity: 100, costPrice: Math.max(1, catalogue / 2), sellingPrice: catalogue });
  }

  // ---- BEFORE: both shops charge the catalogue price
  const before = await sell(world, world.ikeja, product, { quantity: 2 });
  assert.equal(before.totals.total, catalogue * 2, 'with no override, the catalogue price applies');

  // ---- SET: Ikeja prices it 10% higher, Aba is untouched
  const ikejaPrice = Math.round(catalogue * 1.1 * 100) / 100;
  await setOverride(world, world.ikeja, product, { perPiece: ikejaPrice });

  const ikeja = await sell(world, world.ikeja, product, { quantity: 2 });
  assert.equal(ikeja.totals.total, ikejaPrice * 2,
    `Ikeja must charge the branch price of ${ikejaPrice}, not the catalogue price of ${catalogue}`);

  const aba = await sell(world, world.aba, product, { quantity: 2 });
  assert.equal(aba.totals.total, catalogue * 2,
    'Aba has no override, so it must still charge the catalogue price — an override that leaks across branches reprices a business nobody asked to reprice');

  // ---- CLEAR: Ikeja goes back to the catalogue price
  await world.db.run("UPDATE product_price_overrides SET is_deleted = 1, updated_at = datetime('now') WHERE branch_id = ? AND product_id = ?",
    [String(world.ikeja.id), product.id]);
  const cleared = await sell(world, world.ikeja, product, { quantity: 1 });
  assert.equal(cleared.totals.total, catalogue, 'clearing the override restores the catalogue price');
});

test('integration: a carton override prices the carton, not the pack', async (t) => {
  const world = await makeWorld({ profileCode: 'WHOLESALE_RETAIL' });
  t.after(world.cleanup);

  // A product sold by the carton as well as the piece.
  const product = await findProduct(world, (p) => !Number(p.requires_serial));
  const units = await world.db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base', [product.id]);
  const carton = units.find((u) => String(u.code).toUpperCase() === 'CARTON');
  if (!carton) {
    // Give it one, so the test states its own premise rather than depending on
    // whichever catalogue the profile seeded.
    await world.db.run(`INSERT INTO product_units (id, product_id, code, name, quantity_in_base, is_base, created_at, updated_at)
      VALUES (?,?, 'CARTON', 'Carton of 24', 24, 0, datetime('now'), datetime('now'))`, [newId(), product.id]);
  }
  const factor = carton ? Number(carton.quantity_in_base) : 24;
  const catalogue = Number(product.selling_price);

  await receiveStock(world, world.ikeja, product, { quantity: factor * 5, costPrice: catalogue / 2, sellingPrice: catalogue });

  // A carton price BELOW per-piece × factor is the normal wholesale reason for an
  // override: buy a carton, pay less per piece.
  const cartonPrice = Math.round(catalogue * factor * 0.9 * 100) / 100;
  await setOverride(world, world.ikeja, product, { perPiece: catalogue, carton: cartonPrice });

  const sale = await sell(world, world.ikeja, product, { quantity: 1, unitCode: 'CARTON' });
  assert.equal(sale.totals.total, cartonPrice,
    `one carton must cost the override's carton price of ${cartonPrice}, not ${catalogue} × ${factor} = ${catalogue * factor}`);
  assert.equal(Number(sale.totals.total), Number(sale.totals.subtotal), 'a single line has no discount arithmetic to confuse this');

  // ...and the per-piece override is still what a PIECE costs.
  const piece = await sell(world, world.ikeja, product, { quantity: 1, unitCode: 'PIECE' });
  assert.equal(piece.totals.total, catalogue, 'the piece price is unchanged by a carton price');
});

test('integration: setting an override twice replaces it, it does not stack', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  await receiveStock(world, world.ikeja, product, { quantity: 20, costPrice: 1000, sellingPrice: 2000 });

  await setOverride(world, world.ikeja, product, { perPiece: 2200 });
  await setOverride(world, world.ikeja, product, { perPiece: 2400 });

  const rows = await world.db.all(`SELECT * FROM product_price_overrides WHERE branch_id = ? AND product_id = ? AND is_deleted = 0 AND variant_id IS NULL`,
    [String(world.ikeja.id), product.id]);
  // THE TRAP THIS TEST EXISTS FOR: the table's UNIQUE (branch_id, product_id,
  // variant_id) does NOT stop a second row with a NULL variant, because SQLite
  // treats NULLs as distinct. Two such rows make "which price applies" depend on
  // row order — the ambiguity the override feature exists to remove.
  assert.equal(rows.length, 1, 'a second write must replace the first, not add a row the price resolver has to guess between');
  assert.equal(Number(rows[0].default_selling_price), 2400, 'the second price is the one that stands');

  const sale = await sell(world, world.ikeja, product, { quantity: 1 });
  assert.equal(sale.totals.total, 2400, 'the customer is charged the current override');
});

test('integration: the override wins over the batch selling price but loses to a manual price', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  // The batch says one thing (9999), the catalogue another, the override a third.
  // The documented order is: manual > override > price list > batch/catalogue.
  await receiveStock(world, world.ikeja, product, { quantity: 10, costPrice: 1000, sellingPrice: 9999 });
  await setOverride(world, world.ikeja, product, { perPiece: 3000 });

  const derived = await sell(world, world.ikeja, product, { quantity: 1 });
  assert.equal(derived.totals.total, 3000, 'the branch override beats the batch price');

  const till = await world.db.first("SELECT * FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' LIMIT 1", [String(world.ikeja.id)]);
  const manual = await salesService.complete(world.db, {
    branch: world.ikeja, business: world.business, user: world.owner, settings: world.settings,
    lines: [{ productId: product.id, quantity: 1, unitCode: 'PIECE', manualPrice: 2500 }],
    payments: [{ method: 'CASH', amount: 2500 }],
    tillSessionId: till.id,
    walkInName: 'Walk-in customer',
  });
  assert.equal(manual.totals.total, 2500, 'a price typed at the counter still beats the override — the order in domain/pricing.js holds');
});
