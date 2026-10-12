'use strict';
// Pharmaceutical and supermarket verticals, against the real schema.
// The Greenbook is reference data. It is not the shared Nigerian-market list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { provisionDeployment } = require('../../server/services/provisioningService');
const salesService = require('../../server/services/salesService');
const glService = require('../../server/services/glService');
const { computeRowHash } = require('../../domain/hashChain');
const { getSettings } = require('../../domain/planLimits');
const { newId } = require('../../domain/crypto');
const { watNow } = require('../../domain/time');

let fixtureCounter = 0;

async function makeWorld(profileCode) {
  fixtureCounter += 1;
  const file = path.join(os.tmpdir(), `stockridge-pharma-${process.pid}-${fixtureCounter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  await migrate(db);
  const result = await provisionDeployment(db, {
    businessName: `${profileCode} Ltd`,
    profileCode,
    ownerName: 'Test Owner',
    ownerUsername: `owner-${fixtureCounter}`,
    ownerPin: '12345',
    branches: [{
      name: 'Main', code: `BR-${fixtureCounter}`, city: 'Abuja', state: 'FCT', branch_type: 'RETAIL',
      opening_cash: 50000,
      manager: { name: 'Manager', username: `manager-${fixtureCounter}`, pin: '23456', job_title: 'Manager' },
    }],
  });
  await db.run('UPDATE client_settings SET vat_enabled = 1, vat_rate_percent = 7.5 WHERE id = 1');
  const world = {
    db, file,
    businessId: result.businessId,
    branchId: result.branchIds[0],
    business: await db.first('SELECT * FROM businesses WHERE id = ?', [result.businessId]),
    branch: await db.first('SELECT * FROM branches WHERE id = ?', [result.branchIds[0]]),
    manager: await db.first('SELECT * FROM users WHERE username = ?', [`manager-${fixtureCounter}`]),
    settings: await getSettings(db),
  };
  world.tillId = newId();
  await db.run(`INSERT INTO till_sessions (id, branch_id, business_id, user_id, status, opened_at, opening_cash, created_at, updated_at)
                VALUES (?,?,?,?, 'OPEN', ?, 50000, datetime('now'), datetime('now'))`,
  [world.tillId, world.branchId, world.businessId, world.manager.id, watNow()]);
  world.cleanup = () => {
    try { db.close(); } catch (e) { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      const f = file + suffix;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  };
  return world;
}

async function receive(world, product, { quantity, costPrice, sellingPrice, expiryDate = null }) {
  const batchId = newId();
  await world.db.run(`INSERT INTO stock_batches (
      id, branch_id, business_id, product_id, batch_no, cost_price_per_unit, selling_price_per_unit,
      quantity, quantity_reserved, initial_quantity, expiry_date, received_at, received_by, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?, 'ACTIVE', datetime('now'), datetime('now'))`, [
    batchId, world.branchId, world.businessId, product.id, `B-${batchId.slice(0, 6)}`,
    costPrice, sellingPrice, quantity, quantity, expiryDate, watNow(), world.manager.id,
  ]);
  return world.db.first('SELECT * FROM stock_batches WHERE id = ?', [batchId]);
}

function saleArgs(world, product, extra = {}) {
  return {
    branch: world.branch,
    business: world.business,
    user: world.manager,
    settings: world.settings,
    tillSessionId: world.tillId,
    walkInName: 'Walk-in',
    lines: [{ productId: product.id, quantity: 1, unitCode: extra.unitCode || 'TABLET', ...extra.line }],
    payments: [{ method: 'CASH', amount: extra.amount }],
  };
}

test('integration: the Greenbook is loaded and a pharmacy can dispense from it', async (t) => {
  const world = await makeWorld('PHARMACEUTICAL');
  t.after(world.cleanup);

  assert.equal(await world.db.scalar('SELECT COUNT(*) FROM nafdac_catalog'), 6801);
  const listed = await world.db.first("SELECT ingredient_name, dispensing_type, is_controlled FROM nafdac_catalog WHERE nafdac_reg_no = 'A4-6238' LIMIT 1");
  assert.equal(listed.ingredient_name, 'Artemether; Lumefantrine');
  assert.equal(listed.dispensing_type, 'OTC');

  const dolburg = await world.db.first("SELECT * FROM products WHERE sku = 'PH-CTL-001'");
  assert.equal(dolburg.dispensing_class, 'POM');
  assert.equal(Number(dolburg.is_controlled), 1);
  assert.ok(dolburg.nafdac_catalog_id, 'the starter row is linked to the Greenbook, not invented');
  await receive(world, dolburg, { quantity: 20, costPrice: 1200, sellingPrice: 2400, expiryDate: '2027-12-31' });

  await assert.rejects(
    () => salesService.complete(world.db, saleArgs(world, dolburg, { amount: 2400 })),
    (e) => e.code === 'PRESCRIPTION_REQUIRED',
  );
  await assert.rejects(
    () => salesService.complete(world.db, saleArgs(world, dolburg, {
      amount: 2400,
      line: { prescription: { prescriber_name: 'Dr Ada' }, controlledKyc: {} },
    })),
    (e) => e.code === 'CONTROLLED_KYC_REQUIRED',
  );

  const first = await salesService.complete(world.db, saleArgs(world, dolburg, {
    amount: 2400,
    line: {
      prescription: { prescriber_name: 'Dr Ada', patient_name: 'Bola' },
      controlledKyc: { buyer_name: 'Bola Ade', buyer_phone: '08031112222' },
    },
  }));
  const rx = await world.db.first('SELECT * FROM prescriptions WHERE sale_id = ?', [first.saleId]);
  assert.equal(rx.prescriber_name, 'Dr Ada');
  assert.equal(rx.patient_name, 'Bola');
  const entry = await world.db.first('SELECT * FROM controlled_substance_register WHERE sale_id = ?', [first.saleId]);
  assert.equal(entry.entry_type, 'DISPENSE');
  assert.equal(entry.buyer_name, 'Bola Ade');
  assert.equal(entry.prev_hash, null);
  const fields = {
    entry_type: 'DISPENSE',
    business_id: String(world.businessId),
    branch_id: String(world.branchId),
    product_id: String(dolburg.id),
    quantity_dispensed: Number(entry.quantity_dispensed),
    buyer_name: entry.buyer_name,
    buyer_phone: entry.buyer_phone,
    buyer_id_type: entry.buyer_id_type,
    buyer_id_number: entry.buyer_id_number,
    dispensed_by: entry.dispensed_by,
    sale_id: entry.sale_id,
    sale_item_id: entry.sale_item_id,
    prescription_id: entry.prescription_id,
    notes: entry.notes,
  };
  assert.equal(entry.entry_hash, await computeRowHash(null, fields));

  const second = await salesService.complete(world.db, saleArgs(world, dolburg, {
    amount: 2400,
    line: {
      prescription: { prescriber_name: 'Dr Ada' },
      controlledKyc: { buyer_name: 'Chidi Obi', buyer_phone: '08032223333' },
    },
  }));
  const next = await world.db.first('SELECT * FROM controlled_substance_register WHERE sale_id = ?', [second.saleId]);
  assert.equal(next.prev_hash, entry.entry_hash);

  await salesService.voidSale(world.db, {
    saleId: first.saleId, user: world.manager, settings: world.settings, reason: 'Wrong patient',
  });
  const rows = await world.db.all(
    'SELECT entry_type FROM controlled_substance_register WHERE sale_id = ? ORDER BY created_at, id',
    [first.saleId],
  );
  assert.deepEqual(rows.map((r) => r.entry_type), ['DISPENSE', 'VOID']);

  const otc = await world.db.first("SELECT * FROM products WHERE sku = 'PH-OTC-001'");
  await receive(world, otc, { quantity: 5, costPrice: 900, sellingPrice: 1600, expiryDate: '2027-06-01' });
  const otcSale = await salesService.complete(world.db, saleArgs(world, otc, { amount: 1600, unitCode: 'PIECE' }));
  assert.equal(otcSale.totals.total, 1600);
  assert.equal(await world.db.scalar('SELECT COUNT(*) FROM prescriptions WHERE sale_id = ?', [otcSale.saleId]), 0);
});

test('integration: a supermarket sells by aisle and refuses expired stock', async (t) => {
  const world = await makeWorld('SUPERMARKET');
  t.after(world.cleanup);

  const names = (await world.db.all(
    'SELECT name FROM product_categories WHERE business_id = ? AND is_deleted = 0 ORDER BY sort_order',
    [world.businessId],
  )).map((r) => r.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));

  const milk = await world.db.first("SELECT * FROM products WHERE sku = 'SM-PR-001'");
  const drink = await world.db.first("SELECT * FROM products WHERE sku = 'SM-DR-002'");
  assert.equal(milk.dispensing_class, null);
  await receive(world, milk, { quantity: 10, costPrice: 450, sellingPrice: 750, expiryDate: '2027-01-01' });
  await receive(world, drink, { quantity: 10, costPrice: 200, sellingPrice: 400 });
  await salesService.complete(world.db, saleArgs(world, milk, { amount: 750, unitCode: 'PIECE' }));
  await salesService.complete(world.db, saleArgs(world, drink, { amount: 400, unitCode: 'PIECE' }));
  const byCategory = await glService.revenueByCategory(world.db, {
    businessId: world.businessId, startDate: '2020-01-01', endDate: '2099-12-31',
  });
  const got = byCategory.map((r) => r.category_name).sort();
  assert.ok(got.includes('Provisions'), `category sales missing provisions: ${got.join(', ')}`);
  assert.ok(got.includes('Drinks'), `category sales missing drinks: ${got.join(', ')}`);

  const frozen = await world.db.first("SELECT * FROM products WHERE sku = 'SM-FZ-001'");
  await receive(world, frozen, { quantity: 4, costPrice: 2800, sellingPrice: 4200, expiryDate: '2020-01-01' });
  await assert.rejects(
    () => salesService.complete(world.db, saleArgs(world, frozen, { amount: 4200, unitCode: 'PIECE' })),
    (e) => e.code === 'SALE_PREPARATION_FAILED' && e.problems.some((p) => p.code === 'EXPIRED_STOCK'),
  );
});
