'use strict';
// =====================================================================
// test/integration/demo-seed.test.js — THE FIRST COMMAND A NEW DEVELOPER RUNS
// =====================================================================
// `npm run db:reset` is migrations + the demo seeder. It is also the command the
// sample deployment's data is built from, and the one every local session starts
// with. It had been **broken outright and nothing noticed**:
//
//   Error: CHECK constraint failed: resolution IS NULL OR resolution IN
//     ('REPAIRED','REPLACED','REFUNDED','SUPPLIER_RETURN','PAID_REPAIR','REJECTED')
//
// Migration 0007 rebuilt `warranty_claims` around the six outcomes the resolve route
// accepts. It converted the rows that already existed — and left the SEEDER writing
// the four old nouns (`REPAIR`, `REPLACE`, `REFUND`, `REJECT`). Not one of them is in
// the new set, so the seed aborted part-way and left a half-populated database.
//
// Why nothing caught it: `test/integration/d1-seed.test.js` covers the SQL the
// DEPLOYMENTS are built from, and that builder writes no warranty claims at all. The
// demo seeder — a 1,000-line script that every developer depends on and no test ran —
// was the uncovered one. A test suite that skips the bootstrap path reports green on
// a product nobody can start.
//
// So this runs the real seeder, in a real temporary database, and asserts it finishes
// and leaves the rows the demo screens need.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

/** Run a node tool against a throwaway database and hand back its output. */
function runTool(tool, dbFile, extraArgs = []) {
  return execFileSync(process.execPath, [path.join(ROOT, 'tools', tool), `--db=${dbFile}`, ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, STOCKRIDGE_DB: dbFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('the demo seeder still produces a database the screens can render', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockridge-seed-'));
  const dbFile = path.join(dir, 'seed.db');
  try {
    await t.test('it runs to completion', () => {
      let out = '';
      try {
        out = runTool('migrate.js', dbFile);
        out += runTool('seed.js', dbFile);
      } catch (err) {
        const detail = `${err.stdout || ''}${err.stderr || ''}`.trim().split('\n').slice(-6).join('\n');
        assert.fail(`the demo seed failed — a new developer's first command does not work:\n${detail}`);
      }
      assert.match(out, /start it/i, 'the seeder should end by saying how to start the server');
    });

    // Everything below reads the database the seeder just wrote. Read-only, and through
    // the same module the server uses, so a schema change that the seeder did not follow
    // shows up here rather than in a half-rendered screen.
    const { openDatabase } = require(path.join(ROOT, 'server/lib/db'));
    const db = openDatabase({ file: dbFile });
    try {
      await t.test('the warranty claims it writes are outcomes the schema allows', async () => {
        const rows = await db.all("SELECT status, resolution, resolution_notes FROM warranty_claims WHERE is_deleted = 0");
        assert.ok(rows.length > 0, 'the demo should demonstrate warranty claims — none were seeded');
        const allowed = new Set(['REPAIRED', 'REPLACED', 'REFUNDED', 'REJECTED', 'SUPPLIER_RETURN', 'PAID_REPAIR']);
        const bogus = rows.filter((r) => r.resolution != null && !allowed.has(String(r.resolution)));
        assert.deepEqual(bogus.map((r) => r.resolution), [],
          'the seeder wrote a resolution the schema does not define. Migration 0007 replaced the vocabulary; the seeder has to speak the new one');
        // And the pairing the app itself produces: a resolved claim is CLOSED, an open
        // one is on the way there.
        const incoherent = rows.filter((r) => (r.resolution != null) !== (String(r.status) === 'CLOSED'));
        assert.deepEqual(incoherent.map((r) => `${r.status}/${r.resolution}`), [],
          'a claim with an outcome must be CLOSED, and a CLOSED claim must carry the outcome — that is what POST /:id/resolve writes');
        // A rejection without a reason is the shape the resolve route refuses to write.
        const unexplained = rows.filter((r) => String(r.resolution) === 'REJECTED' && !String(r.resolution_notes || '').trim());
        assert.deepEqual(unexplained.map((r) => r.claim_no), [], 'a rejected claim needs the written reason the route insists on');
      });

      await t.test('the demo has a shop to look at', async () => {
        const counts = {};
        for (const table of ['businesses', 'branches', 'users', 'products', 'sales', 'stock_batches', 'customers', 'till_sessions']) {
          const row = await db.first(`SELECT COUNT(*) AS c FROM ${table} WHERE is_deleted = 0`);
          counts[table] = Number(row.c);
        }
        const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([k]) => k);
        assert.deepEqual(empty, [], `the demo database is missing ${empty.join(', ')} — the dashboard and every screen read these`);
      });

      await t.test('the seeded sales add up the way the product adds them up', async () => {
        // A demo that contradicts itself teaches the wrong thing.
        //
        // The arithmetic has to be the PRODUCT'S, not a plausible guess: VAT in Nigeria is
        // extracted from an inclusive price, so `subtotal` already contains it and
        // `total = subtotal − discounts + delivery`. Comparing the total to the line
        // totals directly fails on every delivered sale — which is how this check first
        // reported 83 mismatches in a database that was completely correct.
        const notLines = await db.scalar(`SELECT COUNT(*) FROM sales s
            WHERE s.is_deleted = 0 AND s.status = 'COMPLETED'
              AND ABS(s.subtotal - (SELECT COALESCE(SUM(si.line_total), 0) FROM sale_items si WHERE si.sale_id = s.id AND si.is_deleted = 0)) > 0.01`);
        assert.equal(Number(notLines), 0, `${notLines} completed sale(s) whose subtotal does not equal their own line totals`);

        const notTotal = await db.scalar(`SELECT COUNT(*) FROM sales s
            WHERE s.is_deleted = 0 AND s.status = 'COMPLETED'
              AND ABS(s.total - (s.subtotal - COALESCE(s.discount_amount, 0) - COALESCE(s.order_discount_amount, 0) + COALESCE(s.delivery_fee, 0))) > 0.01`);
        assert.equal(Number(notTotal), 0, `${notTotal} completed sale(s) whose total is not subtotal less discounts plus delivery`);

        // Debt without a name against it is debt nobody can chase, and the debtors screen
        // is one of the demonstration's whole points.
        const namelessDebt = await db.scalar(`SELECT COUNT(*) FROM sales s
            WHERE s.is_deleted = 0 AND s.status = 'COMPLETED' AND s.balance_due > 0 AND s.customer_id IS NULL`);
        assert.equal(Number(namelessDebt), 0, 'a sale with a balance due and no customer cannot be followed up — the demo should not contain one');
      });
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
