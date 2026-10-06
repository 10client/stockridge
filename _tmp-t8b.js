const test = (name, fn) => fn();
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { openDatabase, migrate } = require('./server/lib/db');
const { runPurge, planFor, NEVER_REMOVED } = require('./server/lib/purge');
const { seedEverything, businessFixture, counts, schemaMap } = require('./test/integration/lib/purge-fixture');
let counter = 0;
async function withDb(fn) {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-purge-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  try { await migrate(db); return await fn(db, file); }
  finally { db.close(); for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(file + s, { force: true }); } catch (e) {} } }
}
process.on('uncaughtException', (e) => { console.log('UNCAUGHT →', e.message, '\n', (e.stack || '').split('\n').slice(0,4).join('\n')); process.exit(1); });
(async () => { try { await (async () => { await ('the keep-stock mode keeps stock that can still be sold, not just rows', async () => {
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
    const product = String(db.raw.prepare("INSERT INTO products (id, business_id, name, sku, selling_price, cost_price, is_active, is_deleted, created_at, updated_at) VALUES (lower(hex(randomblob(8))), ?, 'Kept Fridge', 'KEEP-1', 5000, 4000, 1, 0, datetime('now'), datetime('now'))").run(a.businessId).lastInsertRowid);
    const keptProduct = String(db.raw.prepare('SELECT id FROM products WHERE sku = ?').get('KEEP-1').id);
    void product;
    const emptyProduct = String(db.raw.prepare("INSERT INTO products (id, business_id, name, sku, selling_price, cost_price, is_active, is_deleted, created_at, updated_at) VALUES (lower(hex(randomblob(8))), ?, 'Empty Kettle', 'EMPTY-1', 3000, 2000, 1, 0, datetime('now'), datetime('now'))").run(a.businessId).lastInsertRowid);
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
}); })(); console.log('TEST 8 PASSED standalone'); } catch (e) { console.log('THREW →', e.message, '\n', (e.stack || '').split('\n').slice(0,5).join('\n')); process.exit(1); } })();
