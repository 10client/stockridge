'use strict';
// =====================================================================
// test/integration/sales.test.js — THE SALE PATH, END TO END
// =====================================================================
// The unit tests prove the domain maths is right. They cannot prove that a
// sale actually works, because a sale is not maths — it is an ordering of
// reads and writes across eleven tables inside one transaction.
//
// These tests drive the REAL services against a REAL SQLite database built by
// the REAL migration and the REAL provisioning path. Nothing is stubbed. If
// the schema, the vertical profiles, the chart of accounts, the sale engine
// and the general ledger disagree with each other, it fails here.
//
// What is asserted, and why each one earns its place:
//
//   stock decrements in base units and never goes negative
//   a carton sale consumes forty-eight pieces, not one
//   FIFO takes the cheapest/oldest batch first and costs the line from it
//   VAT is EXTRACTED from an inclusive total, never added to it
//   the general ledger balances to the kobo on every single sale
//   a credit sale writes the debtor ledger and the customer balance together
//   a void restores stock to the ORIGINAL batch, so real cost survives
//   a void reverses the ledger rather than deleting it
//   a backdated sale lands on its own day and does not move a counted till
//   a serial sale starts the warranty clock on the sale date and chains
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { provisionDeployment } = require('../../server/services/provisioningService');
const salesService = require('../../server/services/salesService');
const glService = require('../../server/services/glService');
const { getSettings } = require('../../domain/planLimits');
const { newId } = require('../../domain/crypto');
const { round2 } = require('../../domain/money');
const { watNow, addDays, addMonths, watToday } = require('../../domain/time');

// ---------------------------------------------------------------------
// FIXTURE
// ---------------------------------------------------------------------
let fixtureCounter = 0;

/**
 * A provisioned deployment in a throwaway file.
 *
 * Not `:memory:`, because better-sqlite3 gives each connection its own memory
 * database and a second connection would see an empty schema. A temp file
 * behaves like production and costs nothing.
 */
async function makeWorld({ profileCode = 'ELECTRONICS', vat = true } = {}) {
  fixtureCounter += 1;
  const file = path.join(os.tmpdir(), `stockridge-test-${process.pid}-${fixtureCounter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  await migrate(db);

  const result = await provisionDeployment(db, {
    businessName: 'Test Traders Ltd',
    profileCode,
    ownerName: 'Test Owner',
    ownerUsername: 'owner',
    ownerPin: '12345',
    branches: [{
      name: 'Test Branch', code: 'TB-01', city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL',
      latitude: 6.6018, longitude: 3.3515, opening_cash: 100000,
      manager: { name: 'Test Manager', username: 'manager', pin: '23456', job_title: 'Branch Manager' },
      staff: [{ name: 'Test Cashier', username: 'cashier', pin: '34567', job_title: 'Sales / Cashier' }],
    }],
  });

  if (vat) await db.run('UPDATE client_settings SET vat_enabled = 1, vat_rate_percent = 7.5 WHERE id = 1');

  const world = {
    db, file,
    businessId: result.businessId,
    branchId: result.branchIds[0],
    business: await db.first('SELECT * FROM businesses WHERE id = ?', [result.businessId]),
    branch: await db.first('SELECT * FROM branches WHERE id = ?', [result.branchIds[0]]),
    manager: await db.first("SELECT * FROM users WHERE username = 'manager'"),
    cashier: await db.first("SELECT * FROM users WHERE username = 'cashier'"),
    owner: await db.first("SELECT * FROM users WHERE username = 'owner'"),
    settings: await getSettings(db),
  };

  // Every test needs an open till and stock on the shelf.
  world.tillId = newId();
  await db.run(`INSERT INTO till_sessions (id, branch_id, business_id, user_id, status, opened_at, opening_cash, created_at, updated_at)
                VALUES (?,?,?,?, 'OPEN', ?, 100000, datetime('now'), datetime('now'))`,
  [world.tillId, world.branchId, world.businessId, world.manager.id, watNow()]);
  world.till = await db.first('SELECT * FROM till_sessions WHERE id = ?', [world.tillId]);

  world.cleanup = () => { try { db.close(); } catch (e) { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) { const f = file + suffix; if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } };
  return world;
}

/** Put stock on the shelf for a product, returning the batch row. */
async function receiveStock(world, product, { quantity, costPrice, sellingPrice, variantId = null, expiryDate = null, receivedAt = null, zone = 'Aisle A' }) {
  const batchId = newId();
  await world.db.run(`INSERT INTO stock_batches (
      id, branch_id, business_id, product_id, variant_id, batch_no, cost_price_per_unit,
      selling_price_per_unit, quantity, quantity_reserved, initial_quantity, expiry_date,
      received_at, received_by, status, warehouse_zone, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?, 'ACTIVE', ?, datetime('now'), datetime('now'))`,
  [batchId, world.branchId, world.businessId, product.id, variantId, `B-${batchId.slice(0, 6)}`,
    costPrice, sellingPrice, quantity, quantity, expiryDate, receivedAt || watNow(), world.manager.id, zone]);
  return world.db.first('SELECT * FROM stock_batches WHERE id = ?', [batchId]);
}

async function findProduct(world, predicate) {
  const rows = await world.db.all('SELECT * FROM products WHERE business_id = ? AND is_deleted = 0', [world.businessId]);
  const found = rows.find(predicate);
  assert.ok(found, 'fixture catalogue does not contain the product this test needs');
  return found;
}

/** The trial balance must balance after every single test that writes. */
async function assertBooksBalance(world, label) {
  const tb = await glService.trialBalance(world.db, { businessId: world.businessId });
  assert.equal(tb.balances, true,
    `${label}: trial balance does not balance — debits ${tb.totalDebit} vs credits ${tb.totalCredit}, difference ${tb.difference}`);
  return tb;
}

// ---------------------------------------------------------------------
test('integration: provisioning builds a usable business', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const counts = {
    categories: await world.db.scalar('SELECT COUNT(*) FROM product_categories WHERE business_id = ?', [world.businessId]),
    accounts: await world.db.scalar('SELECT COUNT(*) FROM gl_accounts WHERE business_id = ?', [world.businessId]),
    classes: await world.db.scalar('SELECT COUNT(*) FROM customer_classes WHERE business_id = ?', [world.businessId]),
    lists: await world.db.scalar('SELECT COUNT(*) FROM price_lists WHERE business_id = ?', [world.businessId]),
    products: await world.db.scalar('SELECT COUNT(*) FROM products WHERE business_id = ?', [world.businessId]),
    units: await world.db.scalar('SELECT COUNT(*) FROM product_units u JOIN products p ON p.id = u.product_id WHERE p.business_id = ?', [world.businessId]),
    wht: await world.db.scalar('SELECT COUNT(*) FROM wht_rates'),
  };
  assert.ok(counts.categories >= 10, `expected a category tree, got ${counts.categories}`);
  assert.ok(counts.accounts >= 40, `expected a full chart of accounts, got ${counts.accounts}`);
  assert.equal(counts.lists, 2, 'a business needs both a retail and a wholesale price list');
  assert.ok(counts.products >= 15, `expected a seeded catalogue, got ${counts.products}`);
  assert.ok(counts.units >= counts.products, 'every product needs at least one unit level');
  assert.equal(counts.wht, 10, 'the 2024 WHT schedule has ten categories');

  // The unit ladder and the product row must name the same base unit, or a
  // receipt says "3 length" while the stock sheet says "3 metre".
  const mismatched = await world.db.all(`
    SELECT p.sku, p.base_unit_name, u.name AS level0
    FROM products p JOIN product_units u ON u.product_id = p.id AND u.level = 0
    WHERE lower(u.name) <> p.base_unit_name`);
  assert.deepEqual(mismatched, [], 'base_unit_name disagrees with unit ladder level 0');

  const orphaned = await world.db.all('SELECT sku FROM products WHERE business_id = ? AND category_id IS NULL', [world.businessId]);
  assert.deepEqual(orphaned, [], 'every seeded product must land in a declared category');
});

test('integration: provisioning is idempotent', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const { provisionBusiness } = require('../../server/services/provisioningService');

  const before = {
    products: await world.db.scalar('SELECT COUNT(*) FROM products'),
    accounts: await world.db.scalar('SELECT COUNT(*) FROM gl_accounts'),
    categories: await world.db.scalar('SELECT COUNT(*) FROM product_categories'),
  };
  // Re-running must add nothing. Provisioning is retried after a dropped
  // connection, and a duplicated catalogue is worse than a missing one.
  const summary = await provisionBusiness(world.db, world.business, { withCatalogue: true });
  const after = {
    products: await world.db.scalar('SELECT COUNT(*) FROM products'),
    accounts: await world.db.scalar('SELECT COUNT(*) FROM gl_accounts'),
    categories: await world.db.scalar('SELECT COUNT(*) FROM product_categories'),
  };
  assert.deepEqual(after, before, 'a second provisioning run changed the data');
  assert.equal(summary.categories, 0);
  assert.equal(summary.accounts, 0);
  assert.equal(summary.products, 0);
  assert.ok(summary.skipped.length > 0, 'the run should report what it skipped');
});

test('integration: a cash sale decrements stock, books VAT and balances the ledger', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  // A non-serialised product keeps the first test focused on money and stock.
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  const batch = await receiveStock(world, product, { quantity: 50, costPrice: 10000, sellingPrice: 15000 });

  const stockBefore = Number(batch.quantity);
  const result = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: product.id, quantity: 3, unitCode: 'PIECE' }],
    payments: [{ method: 'CASH', amount: 45000 }],
    tillSessionId: world.tillId,
    walkInName: 'Walk-in customer',
  });

  assert.equal(result.totals.subtotal, 45000, 'three units at 15,000');
  // VAT is EXTRACTED from the inclusive total: the customer still pays 45,000.
  // 45000 * 7.5/107.5 = 3139.53. If VAT were ADDED the total would be 48,375
  // and the shop would be charging tax on top of a shelf price that already
  // contained it.
  assert.equal(result.totals.total, 45000, 'enabling VAT must not change what the customer pays');
  assert.equal(result.vat.vatAmount, 3139.53, 'VAT extracted from an inclusive total');
  assert.equal(result.vat.vatEnabled, 1);

  const batchAfter = await world.db.first('SELECT * FROM stock_batches WHERE id = ?', [batch.id]);
  assert.equal(Number(batchAfter.quantity), stockBefore - 3, 'stock decremented in base units');

  const sale = await world.db.first('SELECT * FROM sales WHERE id = ?', [result.saleId]);
  assert.equal(Number(sale.total), 45000);
  assert.equal(Number(sale.amount_paid), 45000);
  assert.equal(Number(sale.balance_due), 0);
  assert.equal(sale.payment_method, 'CASH');
  assert.equal(sale.status, 'COMPLETED');
  assert.equal(Number(sale.vat_amount), 3139.53);
  // sold_at is West Africa Time, which is what every daily report buckets on.
  assert.equal(sale.sold_at.slice(0, 10), watToday(), 'a sale recorded now lands on today in WAT');

  // Margin is snapshot from the batch cost, not recomputed later from a
  // product row whose cost may have moved.
  const item = await world.db.first('SELECT * FROM sale_items WHERE sale_id = ?', [result.saleId]);
  assert.equal(Number(item.cost_price_snapshot), 10000);
  assert.equal(Number(item.line_total), 45000);
  // MARGIN IS NET OF VAT, and that is the figure an owner needs. On a ₦45,000
  // VAT-inclusive sale of goods costing ₦30,000 the shop keeps ₦41,860.47 and
  // hands ₦3,139.53 to FIRS, so it made ₦11,860.47 — not the ₦15,000 that
  // subtracting cost from the shelf price would suggest. Reporting the gross
  // figure overstates profit by the tax the shop never owned, which is exactly
  // the number that makes a marginal business look safe until the VAT return
  // falls due.
  assert.equal(round2(Number(item.margin)), round2(45000 - 3139.53 - 30000));
  assert.equal(round2(Number(item.margin)), 11860.47);

  // The till absorbed the sale.
  const till = await world.db.first('SELECT * FROM till_sessions WHERE id = ?', [world.tillId]);
  assert.equal(Number(till.cash_sales_total), 45000);
  assert.equal(Number(till.grand_total), 45000);
  assert.equal(till.sale_count, 1);

  // Revenue and VAT payable are separate ledger facts: the VAT is FIRS's
  // money, held in trust, and must never be reported as the shop's income.
  const lines = await world.db.all(`
    SELECT a.code, l.debit, l.credit FROM gl_journal_lines l
    JOIN gl_accounts a ON a.id = l.account_id
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE e.source_id = ? ORDER BY a.code`, [result.saleId]);
  const byCode = {};
  for (const l of lines) byCode[l.code] = { debit: Number(l.debit), credit: Number(l.credit) };
  assert.equal(byCode['1000'].debit, 45000, 'cash received');
  assert.equal(round2(byCode['4000'].credit), round2(45000 - 3139.53), 'revenue is net of VAT');
  assert.equal(byCode['2100'].credit, 3139.53, 'VAT payable to FIRS');
  assert.equal(byCode['5000'].debit, 30000, 'cost of goods sold');
  assert.equal(byCode['1100'].credit, 30000, 'inventory relieved at cost');

  await assertBooksBalance(world, 'after a cash sale');
});

test('integration: a carton sale consumes its full base-unit quantity', async (t) => {
  const world = await makeWorld({ profileCode: 'WHOLESALE_RETAIL' });
  t.after(world.cleanup);

  // FMCG ladder: PIECE(1) -> PACK(6) -> CARTON(48). Selling one carton must
  // remove forty-eight pieces, not one. Getting this wrong is the single most
  // damaging stock bug in a wholesale business, because the shelf count looks
  // fine while the warehouse is empty.
  const products = await world.db.all(`
    SELECT p.* FROM products p JOIN product_units u ON u.product_id = p.id AND u.code = 'CARTON'
    WHERE p.business_id = ? AND p.is_deleted = 0 AND p.requires_serial = 0 LIMIT 1`, [world.businessId]);
  assert.ok(products.length, 'the wholesale catalogue must contain a carton-packed product');
  const cartonProduct = products[0];

  const ladder = await world.db.all('SELECT * FROM product_units WHERE product_id = ? ORDER BY quantity_in_base', [cartonProduct.id]);
  const carton = ladder.find((u) => u.code === 'CARTON');
  assert.equal(Number(carton.quantity_in_base), 48);

  const batch = await receiveStock(world, cartonProduct, { quantity: 200, costPrice: 100, sellingPrice: 150 });
  // 150 per piece x 48 pieces per carton x 2 cartons. The batch stores no
  // explicit carton price, so the ladder must derive it: reading that NULL as
  // zero (which it once did) sold the carton for nothing.
  const expectedTotal = round2(150 * 48 * 2);
  assert.equal(expectedTotal, 14400);
  const result = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: cartonProduct.id, quantity: 2, unitCode: 'CARTON' }],
    payments: [{ method: 'CASH', amount: expectedTotal }],
    tillSessionId: world.tillId,
  });
  assert.equal(result.totals.total, expectedTotal, 'a carton sale prices through the ladder, not at zero');
  const cartonItem = await world.db.first('SELECT unit_price FROM sale_items WHERE sale_id = ?', [result.saleId]);
  assert.equal(Number(cartonItem.unit_price), 7200, 'the price per CARTON is 48 x the per-piece price');

  const item = await world.db.first('SELECT * FROM sale_items WHERE sale_id = ?', [result.saleId]);
  assert.equal(Number(item.quantity), 2, 'the customer bought two cartons');
  assert.equal(item.unit_code, 'CARTON');
  assert.equal(Number(item.quantity_in_base), 96, 'two cartons is ninety-six pieces');

  const after = await world.db.first('SELECT quantity FROM stock_batches WHERE id = ?', [batch.id]);
  assert.equal(Number(after.quantity), 200 - 96, 'stock decremented in base units, not in cartons');
  await assertBooksBalance(world, 'after a carton sale');
});

test('integration: FIFO consumes the oldest batch and costs the line from it', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));

  // Two batches at different costs. The line's cost snapshot must be the
  // WEIGHTED cost of the units actually consumed — not the newest price, not
  // an average of the two batches, and not the product's list cost.
  const older = await receiveStock(world, product, { quantity: 4, costPrice: 9000, sellingPrice: 14000, receivedAt: '2026-08-01 09:00:00' });
  const newer = await receiveStock(world, product, { quantity: 10, costPrice: 11000, sellingPrice: 14000, receivedAt: '2026-09-01 09:00:00' });

  const result = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: product.id, quantity: 6, unitCode: 'PIECE' }],
    payments: [{ method: 'CASH', amount: 14000 * 6 }],
    tillSessionId: world.tillId,
  });

  const olderAfter = await world.db.first('SELECT quantity FROM stock_batches WHERE id = ?', [older.id]);
  const newerAfter = await world.db.first('SELECT quantity FROM stock_batches WHERE id = ?', [newer.id]);
  assert.equal(Number(olderAfter.quantity), 0, 'the older batch is consumed first, and fully');
  assert.equal(Number(newerAfter.quantity), 8, 'the remainder comes from the newer batch');

  // 4 units at 9,000 plus 2 units at 11,000 = 58,000 over 6 units.
  const item = await world.db.first('SELECT * FROM sale_items WHERE sale_id = ?', [result.saleId]);
  const expectedCost = round2((4 * 9000 + 2 * 11000) / 6);
  assert.equal(round2(Number(item.cost_price_snapshot)), expectedCost,
    'the cost snapshot must be the batch-weighted cost of the units consumed');

  const cogs = await world.db.scalar(`
    SELECT SUM(l.debit) FROM gl_journal_lines l
    JOIN gl_accounts a ON a.id = l.account_id
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE e.source_id = ? AND a.code = '5000'`, [result.saleId]);
  assert.equal(round2(Number(cogs)), 58000, 'COGS posted at the real consumed cost');
  await assertBooksBalance(world, 'after a FIFO sale');
});

test('integration: a credit sale writes the debtor ledger and the customer balance together', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  await receiveStock(world, product, { quantity: 20, costPrice: 10000, sellingPrice: 15000 });

  const classes = await world.db.all('SELECT * FROM customer_classes WHERE business_id = ? AND credit_allowed = 1', [world.businessId]);
  assert.ok(classes.length, 'the profile must offer a credit-capable customer class');
  const cls = classes[0];

  const customerId = newId();
  await world.db.run(`INSERT INTO customers (id, business_id, branch_id, customer_class_id, customer_type, name, phone,
      credit_limit, credit_balance, payment_terms_days, is_active, created_at, updated_at)
    VALUES (?,?,?,?, 'BUSINESS', 'Adaobi Ventures', '08031234567', 500000, 0, 14, 1, datetime('now'), datetime('now'))`,
  [customerId, world.businessId, world.branchId, cls.id]);
  const customer = await world.db.first('SELECT * FROM customers WHERE id = ?', [customerId]);

  const result = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.manager, settings: world.settings,
    customer, customerClass: cls, saleType: 'CREDIT',
    lines: [{ productId: product.id, quantity: 4, unitCode: 'PIECE' }],
    payments: [{ method: 'CREDIT', amount: 60000 }],
    tillSessionId: world.tillId,
  });

  assert.equal(result.totals.total, 60000);
  assert.equal(result.balanceDue, 60000, 'a credit sale is entirely unpaid');

  const sale = await world.db.first('SELECT * FROM sales WHERE id = ?', [result.saleId]);
  assert.equal(Number(sale.amount_paid), 0);
  assert.equal(Number(sale.balance_due), 60000);
  assert.ok(sale.due_date, 'a credit sale must have a due date to age against');

  const custAfter = await world.db.first('SELECT credit_balance FROM customers WHERE id = ?', [customerId]);
  assert.equal(Number(custAfter.credit_balance), 60000, 'the customer balance moved in the same transaction');

  const ledger = await world.db.all('SELECT * FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0', [customerId]);
  assert.equal(ledger.length, 1, 'one charge on the debtor ledger');
  assert.equal(Number(ledger[0].amount), 60000);
  assert.equal(Number(ledger[0].balance_after), 60000);
  assert.equal(ledger[0].entry_type, 'SALE');

  // The receivable is an ASSET, not cash: the till must not claim money it
  // never held.
  const till = await world.db.first('SELECT credit_total, cash_sales_total FROM till_sessions WHERE id = ?', [world.tillId]);
  assert.equal(Number(till.credit_total), 60000);
  assert.equal(Number(till.cash_sales_total), 0);

  const dr = await world.db.scalar(`SELECT SUM(l.debit) FROM gl_journal_lines l JOIN gl_accounts a ON a.id=l.account_id
    JOIN gl_journal_entries e ON e.id=l.journal_entry_id WHERE e.source_id=? AND a.code='1200'`, [result.saleId]);
  assert.equal(Number(dr), 60000, 'debtors debited');
  await assertBooksBalance(world, 'after a credit sale');
});

test('integration: an over-limit credit sale requires a recorded reason', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial));
  await receiveStock(world, product, { quantity: 100, costPrice: 1000, sellingPrice: 2000 });

  const customerId = newId();
  await world.db.run(`INSERT INTO customers (id, business_id, branch_id, customer_type, name, credit_limit, credit_balance, is_active, created_at, updated_at)
    VALUES (?,?,?, 'BUSINESS', 'Small Buyer', 10000, 0, 1, datetime('now'), datetime('now'))`,
  [customerId, world.businessId, world.branchId]);
  const customer = await world.db.first('SELECT * FROM customers WHERE id = ?', [customerId]);

  const base = {
    branch: world.branch, business: world.business, user: world.owner, settings: world.settings,
    customer, saleType: 'CREDIT',
    lines: [{ productId: product.id, quantity: 20, unitCode: 'PIECE' }],
    payments: [{ method: 'CREDIT', amount: 40000 }],
    tillSessionId: world.tillId,
  };

  // The limit is 10,000 and the sale is 40,000. An OWNER may override — but
  // only by saying why. Recording an over-limit sale without a reason is the
  // difference between an auditable judgement call and an unexplained hole.
  await assert.rejects(() => salesService.complete(world.db, base), (e) => {
    assert.equal(e.code, 'CREDIT_OVERRIDE_REASON_REQUIRED');
    return true;
  });

  const ok = await salesService.complete(world.db, { ...base, creditOverrideReason: 'Long-standing customer, owner approved by phone' });
  assert.equal(ok.totals.total, 40000);
  const sale = await world.db.first('SELECT notes, balance_due FROM sales WHERE id = ?', [ok.saleId]);
  assert.equal(Number(sale.balance_due), 40000);
});

test('integration: a void restores stock to the original batch and reverses the ledger', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  const batch = await receiveStock(world, product, { quantity: 10, costPrice: 8000, sellingPrice: 12000 });

  const sale = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: product.id, quantity: 4, unitCode: 'PIECE' }],
    payments: [{ method: 'CASH', amount: 48000 }],
    tillSessionId: world.tillId,
  });
  assert.equal(Number((await world.db.first('SELECT quantity FROM stock_batches WHERE id = ?', [batch.id])).quantity), 6);

  await assert.rejects(
    () => salesService.voidSale(world.db, { saleId: sale.saleId, user: world.manager, settings: world.settings, reason: 'no' }),
    (e) => { assert.equal(e.code, 'VOID_REASON_REQUIRED'); return true; },
    'a void needs a real reason, not two characters',
  );

  const voided = await salesService.voidSale(world.db, {
    saleId: sale.saleId, user: world.manager, settings: world.settings, reason: 'Customer changed their mind before leaving the shop',
  });
  assert.ok(voided);

  const saleRow = await world.db.first('SELECT * FROM sales WHERE id = ?', [sale.saleId]);
  assert.equal(saleRow.status, 'VOIDED');
  assert.ok(saleRow.voided_at, 'the void is timestamped');
  assert.equal(saleRow.voided_by, world.manager.id);
  assert.ok(saleRow.void_reason.includes('changed their mind'));

  // Stock returns to the SAME batch at its SAME cost. Putting it into a new
  // batch at today's price would quietly rewrite the cost history of the
  // original purchase and corrupt every future margin figure.
  const after = await world.db.first('SELECT quantity, cost_price_per_unit FROM stock_batches WHERE id = ?', [batch.id]);
  assert.equal(Number(after.quantity), 10, 'all four units returned to the original batch');
  assert.equal(Number(after.cost_price_per_unit), 8000, 'the original cost survived the void');

  const till = await world.db.first('SELECT cash_sales_total, sale_count, void_count FROM till_sessions WHERE id = ?', [world.tillId]);
  assert.equal(Number(till.cash_sales_total), 0, 'the till no longer claims the voided cash');
  assert.equal(till.sale_count, 0);
  assert.equal(till.void_count, 1, 'the void is counted, because voids are what you review');

  // The original journal entry is still there — a void reverses, it does not
  // delete. If it deleted, the books would look as though the sale had never
  // happened, which is exactly the appearance a fraudulent void wants.
  const entries = await world.db.all(
    "SELECT source_type, description FROM gl_journal_entries WHERE source_id = ? AND is_deleted = 0 ORDER BY created_at", [sale.saleId]);
  assert.ok(entries.length >= 2, `expected the original entries plus a reversal, got ${entries.length}`);
  assert.ok(entries.some((e) => e.source_type === 'SALE'), 'the original sale entry survives');
  assert.ok(entries.some((e) => e.source_type === 'SALE_RETURN' || /revers/i.test(e.description || '')),
    'a compensating reversal entry exists');

  // Net effect on cash and revenue must be zero.
  const cash = await world.db.scalar(`SELECT SUM(l.debit) - SUM(l.credit) FROM gl_journal_lines l
    JOIN gl_accounts a ON a.id = l.account_id WHERE a.code = '1000'`);
  assert.equal(round2(Number(cash) || 0), 0, 'the till account nets back to zero after the void');
  await assertBooksBalance(world, 'after a void');
});

test('integration: the staff void window is measured in the right direction', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  await receiveStock(world, product, { quantity: 100, costPrice: 1000, sellingPrice: 1500 });

  // staff_void_window_minutes defaults to 15. This is the regression test for
  // a bug that compared a WAT sold_at against a UTC "now" and then took
  // abs(), which INVERTED the window: a one-minute-old sale was refused as
  // being 59 minutes old, while a 75-minute-old sale was allowed as being 15.
  const fresh = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: product.id, quantity: 1, unitCode: 'PIECE' }],
    payments: [{ method: 'CASH', amount: 1500 }], tillSessionId: world.tillId,
  });
  // A cashier correcting their own mis-key a moment later must be ALLOWED.
  await salesService.voidSale(world.db, {
    saleId: fresh.saleId, user: world.cashier, settings: world.settings, reason: 'Mis-keyed the quantity',
  });

  // The same cashier, well outside the window, must be REFUSED. Backdating the
  // sale is how the test gets there without sleeping for an hour.
  const stale = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: product.id, quantity: 1, unitCode: 'PIECE' }],
    payments: [{ method: 'CASH', amount: 1500 }], tillSessionId: world.tillId,
    soldAt: `${addDays(watToday(), -2)} 10:00:00`,
  });
  await assert.rejects(
    () => salesService.voidSale(world.db, { saleId: stale.saleId, user: world.cashier, settings: world.settings, reason: 'Wants a refund' }),
    (e) => { assert.equal(e.code, 'VOID_NOT_ALLOWED'); return true; },
    'a cashier must not void a two-day-old sale',
  );
  // A manager may, because that is a different authority, not a longer window.
  await salesService.voidSale(world.db, {
    saleId: stale.saleId, user: world.manager, settings: world.settings, reason: 'Approved refund, goods returned to shelf',
  });
});

test('integration: a backdated sale keeps its own day and does not move a counted till', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  await receiveStock(world, product, { quantity: 50, costPrice: 5000, sellingPrice: 8000 });

  const twoDaysAgo = addDays(watToday(), -2);

  const result = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.manager, settings: world.settings,
    lines: [{ productId: product.id, quantity: 2, unitCode: 'PIECE' }],
    payments: [{ method: 'CASH', amount: 16000 }],
    soldAt: `${twoDaysAgo} 16:20:00`,
  });

  const sale = await world.db.first('SELECT sold_at, notes, till_session_id FROM sales WHERE id = ?', [result.saleId]);
  assert.equal(sale.sold_at.slice(0, 10), twoDaysAgo,
    'an offline till syncing late must land on the day it traded, not the day it synced');
  assert.equal(result.backdated, true);

  // The till that was open when this sale happened is the one it belongs to;
  // today's open till must not absorb money it never held.
  const todayTill = await world.db.first('SELECT cash_sales_total, sale_count FROM till_sessions WHERE id = ?', [world.tillId]);
  if (sale.till_session_id !== world.tillId) {
    assert.equal(Number(todayTill.cash_sales_total), 0, "today's till did not absorb a two-day-old sale");
    assert.equal(todayTill.sale_count, 0);
  }
  assert.ok(/late posting/i.test(sale.notes || '') || sale.till_session_id === world.tillId,
    'a sale posted against an already-counted till must say so on its face');

  // A sale stamped in the future beyond clock-drift tolerance is refused
  // rather than stored, because a future-dated sale is invisible to every
  // "today" report and looks like missing stock.
  await assert.rejects(
    () => salesService.complete(world.db, {
      branch: world.branch, business: world.business, user: world.manager, settings: world.settings,
      lines: [{ productId: product.id, quantity: 1, unitCode: 'PIECE' }],
      payments: [{ method: 'CASH', amount: 8000 }],
      soldAt: watNow(new Date(Date.now() + 3600 * 1000)),
    }),
    (e) => { assert.equal(e.code, 'SOLD_AT_IN_FUTURE'); return true; },
  );

  // An unparseable timestamp is refused, not silently turned into "now".
  await assert.rejects(
    () => salesService.complete(world.db, {
      branch: world.branch, business: world.business, user: world.manager, settings: world.settings,
      lines: [{ productId: product.id, quantity: 1, unitCode: 'PIECE' }],
      payments: [{ method: 'CASH', amount: 8000 }],
      soldAt: 'last tuesday',
    }),
    (e) => { assert.equal(e.code, 'SOLD_AT_INVALID'); return true; },
  );
  await assertBooksBalance(world, 'after a backdated sale');
});

test('integration: a serialised sale starts the warranty clock and chains the event', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  // Serialised AND warranted, but not variant-tracked: a variant product needs
  // a variant chosen before it can be sold, which is a separate concern tested
  // by the catalogue sweep below.
  const product = await findProduct(world, (p) => Number(p.requires_serial) && Number(p.warranty_months) > 0 && !Number(p.tracks_variants));
  assert.ok(Number(product.warranty_months) > 0, 'fixture needs a warranted serialised product');

  const batch = await receiveStock(world, product, { quantity: 5, costPrice: 150000, sellingPrice: 210000 });
  const serials = [];
  for (let i = 0; i < 3; i += 1) {
    const serialNo = `TESTSN${String(i + 1).padStart(5, '0')}`;
    await world.db.run(`INSERT INTO serial_numbers (id, product_id, serial_no, batch_id, branch_id, status, created_at, updated_at)
      VALUES (?,?,?,?,?, 'IN_STOCK', datetime('now'), datetime('now'))`,
    [newId(), product.id, serialNo, batch.id, world.branchId]);
    serials.push(serialNo);
  }

  const saleDay = addDays(watToday(), -1);
  const result = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: product.id, quantity: 2, unitCode: 'PIECE', serialNumbers: serials.slice(0, 2) }],
    payments: [{ method: 'BANK_TRANSFER', amount: 420000, reference: 'TRF-99887766' }],
    tillSessionId: world.tillId,
    soldAt: `${saleDay} 13:05:00`,
  });
  assert.equal(result.totals.total, 420000);

  const sold = await world.db.all(
    "SELECT * FROM serial_numbers WHERE serial_no IN (?, ?) ORDER BY serial_no", serials.slice(0, 2));
  assert.equal(sold.length, 2);
  for (const sn of sold) {
    assert.equal(sn.status, 'SOLD');
    assert.equal(sn.sale_id, result.saleId);
    // The warranty starts on the day the goods were SOLD. Backdated entry must
    // not shorten the customer's cover by however long the sync took.
    assert.equal(sn.warranty_starts_at, saleDay, `warranty should start on the sale date, got ${sn.warranty_starts_at}`);
    assert.ok(sn.warranty_ends_at > saleDay, 'a warranted product must have an end date');
    assert.equal(sn.warranty_ends_at, addMonths(saleDay, Number(product.warranty_months)),
      'the warranty ends the sale date plus the product warranty term');
  }
  const unsold = await world.db.first('SELECT status FROM serial_numbers WHERE serial_no = ?', [serials[2]]);
  assert.equal(unsold.status, 'IN_STOCK', 'an unsold serial is untouched');

  // The serial event register is hash-chained, so an edit to a past event
  // breaks every later link. That is what makes it admissible as evidence.
  const events = await world.db.all('SELECT * FROM serial_events WHERE serial_no = ? ORDER BY created_at', [serials[0]]);
  assert.ok(events.length >= 1, 'selling a serialised unit writes a serial event');
  const { verifyChain } = require('../../domain/hashChain');
  const verification = await verifyChain(world.db, {
    table: 'serial_events', scopeColumn: 'serial_no', scopeValue: serials[0],
    // The SAME field builder the writer used. A chain is only evidence if a
    // third party can recompute it from the stored row, so writer and verifier
    // must not each have their own idea of which fields were hashed.
    expectedFieldBuilder: salesService.serialEventFields,
  });
  assert.equal(verification.ok, true, `serial event chain must verify: ${verification.reason || verification.error || ''}`);
  await assertBooksBalance(world, 'after a serialised sale');
});

test('integration: selling stock that does not exist is refused, not oversold', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial));
  await receiveStock(world, product, { quantity: 2, costPrice: 1000, sellingPrice: 1500 });

  await assert.rejects(
    () => salesService.complete(world.db, {
      branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
      lines: [{ productId: product.id, quantity: 5, unitCode: 'PIECE' }],
      payments: [{ method: 'CASH', amount: 7500 }], tillSessionId: world.tillId,
    }),
    (e) => {
      assert.ok(e.problems && e.problems.length, 'a refused sale must explain itself per line');
      return true;
    },
  );

  // Nothing was written: the batch is untouched and no sale row exists.
  const batch = await world.db.first('SELECT quantity FROM stock_batches WHERE branch_id = ?', [world.branchId]);
  assert.equal(Number(batch.quantity), 2, 'a refused sale must not decrement stock');
  assert.equal(await world.db.scalar('SELECT COUNT(*) FROM sales'), 0, 'a refused sale must not create a sale row');
  await assertBooksBalance(world, 'after a refused sale');
});

test('integration: a reserved unit cannot be sold twice', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  const batch = await receiveStock(world, product, { quantity: 3, costPrice: 1000, sellingPrice: 1500 });
  // A layaway holds one unit: it is on the shelf but it is not for sale.
  await world.db.run('UPDATE stock_batches SET quantity_reserved = 1 WHERE id = ?', [batch.id]);

  await assert.rejects(
    () => salesService.complete(world.db, {
      branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
      lines: [{ productId: product.id, quantity: 3, unitCode: 'PIECE' }],
      payments: [{ method: 'CASH', amount: 4500 }], tillSessionId: world.tillId,
    }),
    (e) => { assert.ok(e.problems && e.problems.length); return true; },
    'three units on the shelf with one reserved means two are sellable',
  );

  const ok = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: product.id, quantity: 2, unitCode: 'PIECE' }],
    payments: [{ method: 'CASH', amount: 3000 }], tillSessionId: world.tillId,
  });
  assert.equal(ok.totals.total, 3000);
  const after = await world.db.first('SELECT quantity, quantity_reserved FROM stock_batches WHERE id = ?', [batch.id]);
  assert.equal(Number(after.quantity), 1);
  assert.equal(Number(after.quantity_reserved), 1, 'the layaway hold survives the sale of the other units');
});

test('integration: two lines on one sale cannot both claim the same batch', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  await receiveStock(world, product, { quantity: 5, costPrice: 1000, sellingPrice: 1500 });

  // Five units in stock, and two lines asking for three each. The second line
  // must see only what the first left, or the sale oversells by one and the
  // batch goes negative at commit time.
  await assert.rejects(
    () => salesService.complete(world.db, {
      branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
      lines: [
        { productId: product.id, quantity: 3, unitCode: 'PIECE' },
        { productId: product.id, quantity: 3, unitCode: 'PIECE' },
      ],
      payments: [{ method: 'CASH', amount: 9000 }], tillSessionId: world.tillId,
    }),
    (e) => { assert.ok(e.problems && e.problems.length); return true; },
  );

  const ok = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [
      { productId: product.id, quantity: 3, unitCode: 'PIECE' },
      { productId: product.id, quantity: 2, unitCode: 'PIECE' },
    ],
    payments: [{ method: 'CASH', amount: 7500 }], tillSessionId: world.tillId,
  });
  assert.equal(ok.lineCount, 2);
  assert.equal(Number((await world.db.first('SELECT quantity FROM stock_batches WHERE branch_id = ?', [world.branchId])).quantity), 0);
});

test('integration: an underpayment is refused and an overpayment becomes change owed', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  await receiveStock(world, product, { quantity: 20, costPrice: 1000, sellingPrice: 1500 });
  const base = {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: product.id, quantity: 2, unitCode: 'PIECE' }],
    tillSessionId: world.tillId,
  };

  await assert.rejects(
    () => salesService.complete(world.db, { ...base, payments: [{ method: 'CASH', amount: 2000 }] }),
    (e) => { assert.match(e.code, /UNDERPAID|PAYMENT/); return true; },
    'a 3,000 sale cannot be completed with 2,000 of cash and no credit arrangement',
  );

  // Change owed needs a named customer: an anonymous claim code cannot be
  // redeemed by anybody, and would be a liability with no owner.
  await assert.rejects(
    () => salesService.complete(world.db, { ...base, payments: [{ method: 'CASH', amount: 3000 }], changeOwedAmount: 500 }),
    (e) => { assert.equal(e.code, 'CHANGE_OWED_NEEDS_CUSTOMER'); return true; },
  );

  const customerId = newId();
  await world.db.run(`INSERT INTO customers (id, business_id, branch_id, customer_type, name, phone, is_active, created_at, updated_at)
    VALUES (?,?,?, 'INDIVIDUAL', 'Bola Adeleke', '08123456789', 1, datetime('now'), datetime('now'))`,
  [customerId, world.businessId, world.branchId]);
  const customer = await world.db.first('SELECT * FROM customers WHERE id = ?', [customerId]);

  // The real scenario: a 3,000 sale, the customer hands over 3,500 because the
  // till has no small notes, and 500 is owed back on a claim code.
  const withChange = await salesService.complete(world.db, {
    ...base, customer, payments: [{ method: 'CASH', amount: 3500 }], changeOwedAmount: 500,
  });
  assert.equal(withChange.changeOwed, 500);
  const sale = await world.db.first(
    'SELECT total, amount_paid, balance_due, cash_tendered, change_given FROM sales WHERE id = ?', [withChange.saleId]);
  // The sale happened at full price; the 500 is money the shop is HOLDING, not
  // a discount. Booking it as a discount would understate both revenue and the
  // amount the till owes the customer.
  assert.equal(Number(sale.total), 3000, 'change owed must not reduce the sale total');
  assert.equal(Number(sale.amount_paid), 3000, 'the sale is fully settled');
  assert.equal(Number(sale.balance_due), 0, 'change owed is not a debt the customer owes');
  assert.equal(Number(sale.cash_tendered), 3500, 'what physically arrived at the drawer');
  assert.equal(Number(sale.change_given), 0, 'nothing went back over the counter');

  // The claim itself: a code the customer can quote, and an expiry.
  const claim = await world.db.first('SELECT * FROM change_owed WHERE sale_id = ?', [withChange.saleId]);
  assert.ok(claim, 'change owed must produce a claim row');
  assert.equal(Number(claim.amount), 500);
  assert.equal(claim.status, 'OUTSTANDING');
  assert.ok(claim.claim_code, 'the customer needs a code to quote');
  assert.ok(claim.expires_at, 'an unclaimed liability cannot sit on the books forever');

  // And the ledger holds it as a LIABILITY, not as a reduction of revenue.
  const liability = await world.db.scalar(`SELECT SUM(l.credit) FROM gl_journal_lines l
    JOIN gl_accounts a ON a.id = l.account_id JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE e.source_id = ? AND a.code = '2210'`, [withChange.saleId]);
  assert.equal(Number(liability), 500, 'change owed is credited to the change-owed liability account');
  const cash = await world.db.scalar(`SELECT SUM(l.debit) FROM gl_journal_lines l
    JOIN gl_accounts a ON a.id = l.account_id JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE e.source_id = ? AND a.code = '1000'`, [withChange.saleId]);
  assert.equal(Number(cash), 3500, 'the cash account records what actually arrived, exactly once');
  await assertBooksBalance(world, 'after a change-owed sale');
});

test('integration: a delivery sale creates its job in the same transaction', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => Number(p.is_bulky) || !Number(p.requires_serial));
  await receiveStock(world, product, { quantity: 10, costPrice: 20000, sellingPrice: 30000 });

  const result = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
    lines: [{ productId: product.id, quantity: 1, unitCode: 'PIECE' }],
    payments: [{ method: 'CASH', amount: 32000 }],
    deliveryRequired: true, deliveryFee: 2000, deliveryAddress: '14 Awolowo Road, Ikoyi, Lagos',
    tillSessionId: world.tillId, walkInName: 'Delivery customer',
  });

  const job = await world.db.first('SELECT * FROM delivery_jobs WHERE sale_id = ?', [result.saleId]);
  assert.ok(job, 'a delivery sale must produce a delivery job');
  assert.equal(job.status, 'PENDING');
  assert.equal(job.delivery_address, '14 Awolowo Road, Ikoyi, Lagos');
  assert.equal(Number(job.fee), 2000);

  const items = await world.db.all('SELECT * FROM delivery_job_items WHERE delivery_job_id = ?', [job.id]);
  assert.equal(items.length, 1, 'the job carries the line it has to deliver');
  assert.equal(Number(items[0].delivered_qty), 0, 'nothing is delivered yet');

  const sale = await world.db.first('SELECT status, delivery_fee FROM sales WHERE id = ?', [result.saleId]);
  assert.equal(sale.status, 'PENDING_DELIVERY', 'the sale is not complete until the goods arrive');
  assert.equal(Number(sale.delivery_fee), 2000);
  // Delivery income is its own revenue account, not a rounding error inside
  // product margin — a shop that delivers at a loss cannot see it otherwise.
  const deliveryRevenue = await world.db.scalar(`SELECT SUM(l.credit) FROM gl_journal_lines l
    JOIN gl_accounts a ON a.id = l.account_id JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE e.source_id = ? AND a.code = '4100'`, [result.saleId]);
  assert.equal(Number(deliveryRevenue), 2000);
  await assertBooksBalance(world, 'after a delivery sale');
});

test('integration: a part-paid credit sale records both the charge and the payment', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const product = await findProduct(world, (p) => !Number(p.requires_serial) && !Number(p.tracks_variants));
  await receiveStock(world, product, { quantity: 20, costPrice: 10000, sellingPrice: 15000 });

  const customerId = newId();
  await world.db.run(`INSERT INTO customers (id, business_id, branch_id, customer_type, name, credit_limit, credit_balance, is_active, created_at, updated_at)
    VALUES (?,?,?, 'BUSINESS', 'Chukwuemeka & Sons', 500000, 0, 1, datetime('now'), datetime('now'))`,
  [customerId, world.businessId, world.branchId]);
  const customer = await world.db.first('SELECT * FROM customers WHERE id = ?', [customerId]);

  const result = await salesService.complete(world.db, {
    branch: world.branch, business: world.business, user: world.manager, settings: world.settings,
    customer, saleType: 'CREDIT',
    lines: [{ productId: product.id, quantity: 4, unitCode: 'PIECE' }],
    payments: [{ method: 'CASH', amount: 20000 }, { method: 'CREDIT', amount: 40000 }],
    tillSessionId: world.tillId,
  });
  assert.equal(result.totals.total, 60000);
  assert.equal(result.paid, 20000, 'the cash part is real money in the till');
  assert.equal(result.balanceDue, 40000, 'the rest is a receivable');

  const till = await world.db.first('SELECT cash_sales_total, credit_total FROM till_sessions WHERE id = ?', [world.tillId]);
  assert.equal(Number(till.cash_sales_total), 20000, 'only the cash leg reaches the cash drawer');
  assert.equal(Number(till.credit_total), 40000);

  const cust = await world.db.first('SELECT credit_balance FROM customers WHERE id = ?', [customerId]);
  assert.equal(Number(cust.credit_balance), 40000);

  // Statement order: a charge and its payments share a created_at second, so
  // the tiebreak is explicit — the invoice first, then each payment against it.
  const ledger = await world.db.all(`SELECT entry_type, amount, balance_after FROM debtor_ledger
      WHERE customer_id = ? AND is_deleted = 0
      ORDER BY created_at, CASE WHEN entry_type = 'SALE' THEN 0 ELSE 1 END, amount DESC`, [customerId]);
  assert.equal(ledger.length, 2, 'a part-paid credit sale posts the gross invoice and then the payment');
  assert.equal(ledger[0].entry_type, 'SALE');
  assert.equal(Number(ledger[0].amount), 60000, 'the ledger shows the WHOLE invoice, not the net of the deposit');
  assert.equal(Number(ledger[0].balance_after), 60000);
  assert.equal(ledger[1].entry_type, 'PAYMENT');
  assert.equal(Number(ledger[1].amount), -20000, 'the part-payment is a negative row against that invoice');
  assert.equal(Number(ledger[1].balance_after), 40000, 'the ledger balance matches the customer row');
  await assertBooksBalance(world, 'after a part-paid credit sale');
});

test('integration: the whole seeded catalogue can be sold without breaking the books', async (t) => {
  // A sweep rather than a scenario. Every product in every profile is sold
  // once, and the trial balance is checked at the end. This is the test that
  // catches a profile whose data does not survive contact with the engine —
  // a measured product with no unit ladder, a variant with no price, a ladder
  // whose base unit disagrees with the product row.
  const profiles = ['ELECTRONICS', 'FURNITURE', 'WHOLESALE_RETAIL', 'BUILDING_MATERIALS'];
  for (const profileCode of profiles) {
    const world = await makeWorld({ profileCode });
    t.after(world.cleanup);

    const products = await world.db.all(
      'SELECT * FROM products WHERE business_id = ? AND is_deleted = 0', [world.businessId]);
    assert.ok(products.length >= 15, `${profileCode}: expected a seeded catalogue`);

    let sold = 0; const failures = [];
    for (const product of products) {
      const ladder = await world.db.all('SELECT * FROM product_units WHERE product_id = ? ORDER BY quantity_in_base', [product.id]);
      assert.ok(ladder.length, `${profileCode}/${product.sku}: no unit ladder`);
      const sellUnit = ladder.find((u) => Number(u.is_default_sell)) || ladder[0];

      const variants = await world.db.all('SELECT * FROM product_variants WHERE product_id = ? AND is_deleted = 0', [product.id]);
      const targets = variants.length ? variants : [null];
      const variant = targets[0];

      await receiveStock(world, product, {
        quantity: 500, costPrice: Number(product.cost_price) || 100,
        sellingPrice: (variant && Number(variant.selling_price)) || Number(product.selling_price) || 150,
        variantId: variant ? variant.id : null,
      });

      try {
        const line = { productId: product.id, quantity: 1, unitCode: sellUnit.code };
        if (variant) line.variantId = variant.id;
        if (Number(product.requires_serial)) {
          const serialNo = `SW-${product.sku || product.id.slice(0, 6)}-1`;
          const batch = await world.db.first(
            'SELECT id FROM stock_batches WHERE product_id = ? AND branch_id = ? ORDER BY created_at DESC LIMIT 1',
            [product.id, world.branchId]);
          await world.db.run(`INSERT INTO serial_numbers (id, product_id, variant_id, serial_no, batch_id, branch_id, status, created_at, updated_at)
            VALUES (?,?,?,?,?,?, 'IN_STOCK', datetime('now'), datetime('now'))`,
          [newId(), product.id, variant ? variant.id : null, serialNo, batch.id, world.branchId]);
          line.serialNumbers = [serialNo];
        }
        const price = (variant && Number(variant.selling_price)) || Number(product.selling_price) || 150;
        const qtyBase = Number(sellUnit.quantity_in_base);
        await salesService.complete(world.db, {
          branch: world.branch, business: world.business, user: world.cashier, settings: world.settings,
          lines: [line],
          payments: [{ method: 'CASH', amount: round2(price * qtyBase) }],
          tillSessionId: world.tillId, walkInName: 'Sweep customer',
        });
        sold += 1;
      } catch (e) {
        failures.push(`${product.sku}: ${e.code || e.message.slice(0, 90)}`);
      }
    }
    assert.deepEqual(failures, [], `${profileCode}: ${failures.length} of ${products.length} products could not be sold`);
    assert.equal(sold, products.length, `${profileCode}: every seeded product must be sellable`);
    await assertBooksBalance(world, `${profileCode} after selling the whole catalogue`);
  }
});
