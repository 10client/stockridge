'use strict';
// =====================================================================
// test/integration/purge.test.js — CAN IT CLEAR A DATABASE THAT HAS BEEN USED?
// =====================================================================
// A purge is only proved against a database with rows in it, in every table the
// plan names. Anything less and the test says "the tables I happened to think of
// were emptied" — which is exactly the assurance that fails in production, on a
// table somebody added six months later.
//
// So this file does something unusual and deliberate: it reads the SCHEMA, works
// out what each table requires, and seeds ONE ROW IN EVERY TABLE, in foreign-key
// order, satisfying every NOT NULL and every CHECK constraint it can parse. The
// fixture maintains itself — a table added by a future migration is seeded
// automatically, and if the purge plan forgets it, the counts below fail.
//
// WHAT IS ASSERTED, mode by mode:
//   · the cleanup completes: no failed step, no foreign-key error
//   · everything the mode says it removes is gone (counted per table)
//   · everything the mode says it KEEPS is still there — the journal, the safe,
//     the stocking, the catalogue, the team, the account
//   · a SECOND business trading in the same database is untouched, row for row
//   · the tables no mode may ever touch still hold their rows
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { runPurge, planFor, describeSchema, NEVER_REMOVED } = require('../../server/lib/purge');

let counter = 0;

async function withDb(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-purge-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try {
    await migrate(db);
    return await fn(db, file);
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(file + suffix, { force: true }); } catch (e) { /* nothing */ } }
  }
}

const { seedEverything, businessFixture, counts, schemaMap } = require('./lib/purge-fixture');

test('the fixture seeds a row into every table the schema declares', async () => {
  await withDb(async (db) => {
    const { businessId, branchId, secondBranchId } = await businessFixture(db, 'Seed Co');
    const seed = await seedEverything(db, { businessId, branchId, secondBranchId });
    const total = db.raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().c;
    assert.equal(seed.failures.length, 0,
      `the fixture could not seed ${seed.failures.length} table(s):\n      ${seed.failures.join('\n      ')}\n    A purge can only be proved against a database with rows in the tables the plan names`);
    assert.ok(seed.seeded >= total - 1,
      `only ${seed.seeded} of ${total} tables hold a seeded row — the fixture is not covering the schema`);
  });
});

for (const [mode, promise] of [
  ['CLEAR_OPERATIONAL_KEEP_ACCOUNTING', { keeps: ['gl_journal_entries', 'gl_journal_lines', 'branch_safe_ledger', 'products', 'customers', 'suppliers', 'users'], removes: ['sales', 'sale_items', 'sale_payments', 'expenses', 'purchase_orders', 'stock_batches', 'till_sessions', 'expenses'] }],
  // This mode clears TRADING history and keeps the books AND the current stock —
  // so the catalogue, the customers and the suppliers stay, and saying otherwise
  // in this table would be the test asserting its own misunderstanding.
  ['CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK', { keeps: ['gl_journal_entries', 'branch_safe_ledger', 'products', 'product_units', 'customers', 'suppliers', 'users'], removes: ['sales', 'sale_items', 'expenses', 'purchase_orders', 'till_sessions', 'debtor_ledger'] }],
  ['ALL_BUSINESS_DATA', { keeps: ['users', 'branches'], removes: ['sales', 'sale_items', 'expenses', 'products', 'product_units', 'customers', 'suppliers', 'gl_journal_entries', 'stock_batches'] }],
  ['FULL_SETUP_RESET', { keeps: [], removes: ['sales', 'products', 'product_units', 'customers', 'suppliers', 'gl_journal_entries', 'branches'] }],
]) {
  test(`${mode} completes against a fully-used database and keeps what it promises`, async () => {
    await withDb(async (db) => {
      const a = await businessFixture(db, 'Alpha Traders');
      const seed = await seedEverything(db, { businessId: a.businessId, branchId: a.branchId, secondBranchId: a.secondBranchId });
      assert.equal(seed.failures.length, 0, `the fixture failed:\n      ${seed.failures.join('\n      ')}`);

      const result = await runPurge(db, mode, { businessIds: [a.businessId], actorId: null, dryRun: false });
      assert.deepEqual(result.failed, [],
        `${mode} reported failures:\n      ${result.failed.map((f) => `${f.table}: ${f.error}`).join('\n      ')}\n    A cleanup that half-finishes leaves a shop unable to tell what survived`);

      const after = counts(db, [...new Set([...promise.keeps, ...promise.removes])], 'business_id', a.businessId);
      for (const t of promise.removes) {
        assert.equal(after[t], 0, `${mode} promised to remove ${t} and left ${after[t]} row(s)`);
      }
      for (const t of promise.keeps) {
        assert.ok(after[t] > 0, `${mode} promised to keep ${t} and it holds none afterwards`);
      }
      for (const t of NEVER_REMOVED) {
        const row = db.raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get();
        assert.ok(row.c > 0, `${mode} removed rows from ${t}, which no cleanup may ever touch`);
      }
      assert.ok(result.total > 0, `${mode} reported removing nothing from a seeded database`);
    });
  });
}

test('a cleanup of one business leaves another business trading in the same database untouched', async () => {
  // THE ISOLATION BOUNDARY. Multi-business is a feature of this product, and the
  // worst possible bug here is a cleanup that reaches across shops.
  await withDb(async (db) => {
    const alpha = await businessFixture(db, 'Alpha Traders');
    const beta = await businessFixture(db, 'Beta Stores');
    const seedA = await seedEverything(db, { businessId: alpha.businessId, branchId: alpha.branchId, secondBranchId: alpha.secondBranchId });
    assert.equal(seedA.failures.length, 0, seedA.failures.join('; '));
    // Give Beta the same shape, so both databases look used.
    const seedB = await seedEverything(db, { businessId: beta.businessId, branchId: beta.branchId, secondBranchId: beta.secondBranchId });
    assert.equal(seedB.failures.length, 0, seedB.failures.join('; '));

    const watched = ['sales', 'sale_items', 'products', 'customers', 'gl_journal_entries', 'stock_batches'];
    const before = counts(db, watched, 'business_id', beta.businessId);
    const result = await runPurge(db, 'ALL_BUSINESS_DATA', { businessIds: [alpha.businessId], dryRun: false });
    assert.deepEqual(result.failed, [], result.failed.map((f) => `${f.table}: ${f.error}`).join('; '));
    const after = counts(db, watched, 'business_id', beta.businessId);
    assert.deepEqual(after, before,
      `a cleanup of Alpha changed Beta's rows:\n      before ${JSON.stringify(before)}\n      after  ${JSON.stringify(after)}`);

    const alphaLeft = counts(db, ['sales', 'products'], 'business_id', alpha.businessId);
    assert.deepEqual(alphaLeft, { sales: 0, products: 0 }, 'Alpha was not actually cleared');
  });
});

test('a cleanup with no business in scope removes nothing at all', async () => {
  await withDb(async (db) => {
    const a = await businessFixture(db, 'Alpha Traders');
    await seedEverything(db, { businessId: a.businessId, branchId: a.branchId, secondBranchId: a.secondBranchId });
    const before = counts(db, ['sales', 'products'], 'business_id', a.businessId);
    const result = await runPurge(db, 'ALL_BUSINESS_DATA', { businessIds: [], dryRun: false });
    const after = counts(db, ['sales', 'products'], 'business_id', a.businessId);
    assert.deepEqual(after, before, 'an unscoped cleanup deleted rows — the one failure this module must never have');
    assert.equal(result.total, 0, `it reported removing ${result.total} row(s)`);
    assert.ok(result.failed.length > 0, 'it did not report that it had no scope to work in');
  });
});

test('the keep-stock mode keeps stock that can still be sold, not just rows', async () => {
  // THE PROMISE IN FULL: a kept batch whose product lost its unit ladder would be
  // stock the till refuses to sell. So the mode must keep the product AND its
  // ladder, its barcodes and its variants.
  await withDb(async (db) => {
    const a = await businessFixture(db, 'Alpha Traders');
    const seed = await seedEverything(db, { businessId: a.businessId, branchId: a.branchId, secondBranchId: a.secondBranchId });
    assert.equal(seed.failures.length, 0, seed.failures.join('; '));

    // One batch with stock, one empty. The seeded batch is detached from everything
    // that points at a batch BEFORE it is removed: the fixture put a serial and a few
    // movement rows in those tables, and foreign keys are on.
    const batchRefs = [];
    for (const r of db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      for (const fk of db.raw.prepare(`PRAGMA foreign_key_list(${r.name})`).all()) {
        if (fk.table === 'stock_batches' && r.name !== 'stock_batches') batchRefs.push(`${r.name}.${fk.from}`);
      }
    }
    for (const ref of batchRefs) {
      const [tbl, col] = ref.split('.');
      db.raw.prepare(`UPDATE ${tbl} SET ${col} = NULL WHERE ${col} IS NOT NULL`).run();
    }
    db.raw.prepare("DELETE FROM stock_batches WHERE business_id = ?").run(a.businessId);
    // THE ID IS READ BACK BY SKU, IN BOTH CASES. These rows supply their own text id,
    // and `lastInsertRowid` is the ROWID, not the id — the first version of this test
    // asked the database for a product with id "3" and got a foreign key failure that
    // had nothing to do with the cleanup code it was meant to be testing. A test that
    // fails for its own reasons is worse than no test: it points at innocent code.
    db.raw.prepare("INSERT INTO products (id, business_id, name, sku, selling_price, cost_price, is_active, is_deleted, created_at, updated_at) VALUES (lower(hex(randomblob(8))), ?, 'Kept Fridge', 'KEEP-1', 5000, 4000, 1, 0, datetime('now'), datetime('now'))").run(a.businessId);
    const keptProduct = String(db.raw.prepare('SELECT id FROM products WHERE sku = ?').get('KEEP-1').id);
    db.raw.prepare("INSERT INTO products (id, business_id, name, sku, selling_price, cost_price, is_active, is_deleted, created_at, updated_at) VALUES (lower(hex(randomblob(8))), ?, 'Empty Kettle', 'EMPTY-1', 3000, 2000, 1, 0, datetime('now'), datetime('now'))").run(a.businessId);
    const emptyProduct = String(db.raw.prepare('SELECT id FROM products WHERE sku = ?').get('EMPTY-1').id);
    db.raw.prepare("INSERT INTO product_units (id, product_id, level, code, name, quantity_in_base, is_sellable, is_default_sell, is_deleted, created_at, updated_at) VALUES (lower(hex(randomblob(8))), ?, 0, 'PIECE', 'Piece', 1, 1, 1, 0, datetime('now'), datetime('now'))").run(keptProduct);

    for (const [id, qty] of [[keptProduct, 7], [emptyProduct, 0]]) {
      db.raw.prepare("INSERT INTO stock_batches (id, business_id, branch_id, product_id, quantity, quantity_reserved, cost_price_per_unit, selling_price_per_unit, status, is_deleted, created_at, updated_at) VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, 0, 4000, 5000, 'ACTIVE', 0, datetime('now'), datetime('now'))")
        .run(a.businessId, a.branchId, id, qty);
    }

    const result = await runPurge(db, 'CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK', { businessIds: [a.businessId], dryRun: false });
    assert.deepEqual(result.failed, [], result.failed.map((f) => `${f.table}: ${f.error}`).join('; '));

    const batches = db.raw.prepare('SELECT product_id, quantity FROM stock_batches WHERE business_id = ?').all(a.businessId);
    assert.equal(batches.length, 1, `the mode kept ${batches.length} batch(es); exactly the one with stock should survive`);
    assert.equal(batches[0].product_id, keptProduct, 'the surviving batch belongs to the wrong product');

    const products = db.raw.prepare('SELECT id FROM products WHERE business_id = ?').all(a.businessId).map((r) => String(r.id));
    assert.deepEqual(products, [keptProduct], `the catalogue now holds ${products.length} product(s); the stocked one should survive and the empty one should not`);

    const ladder = db.raw.prepare('SELECT COUNT(*) AS c FROM product_units WHERE product_id = ?').get(keptProduct).c;
    assert.equal(ladder, 1,
      'the kept product lost its unit ladder — the sale engine refuses a product with no ladder rather than guessing one, so this is stock the till cannot ring up');
  });
});

// The fixture helpers are exported so a diagnosis script can reproduce a failure
// exactly, rather than approximating it.
module.exports = { seedEverything, businessFixture, counts, schemaMap };

test('no cleanup plan removes a parent while a row that points at it survives', async () => {
  // THE ORDER INSIDE EACH PLAN, CHECKED AGAINST THE SCHEMA ITSELF.
  //
  // Six ordering mistakes were found by hand before this test existed — a deposit
  // deleted before the instalment plan that points at it, a purchase order before the
  // batch that arrived against it, a price list before the customer who chose it. Every
  // one of them is a foreign key failure at the till, in front of a shop, during a
  // cleanup they were told was routine. The plans say what to remove; the schema says
  // what depends on what; this asserts the two agree, for every mode, forever.
  await withDb(async (db) => {
    const schema = await describeSchema(db);
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => String(r.name));
    const fksByTable = {};
    for (const t of tables) fksByTable[t] = db.raw.prepare(`PRAGMA foreign_key_list(${t})`).all();

    const broken = [];
    for (const mode of Object.keys(require('../../server/lib/purge').PLANS)) {
      const plan = planFor(mode, { businessIds: ['scope-check'], schema });
      const order = plan.steps.map((s) => s.t);
      order.forEach((target, i) => {
        for (const child of tables) {
          if (child === target) continue;
          const childAt = order.indexOf(child);
          if (childAt === -1) continue;                    // this mode keeps that table
          for (const fk of fksByTable[child]) {
            if (fk.table !== target || fk.from === fk.to) continue;
            if (childAt > i) broken.push(`${mode}: ${target} (step ${i}) is removed before ${child}.${fk.from} (step ${childAt})`);
          }
        }
      });
    }
    assert.deepEqual([...new Set(broken)], [],
      `a plan deletes rows that something still points at:\n      ${[...new Set(broken)].join('\n      ')}`);
  });
});
