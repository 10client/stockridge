'use strict';
// =====================================================================
// server/lib/storage.js — HOW FULL IS THIS SHOP'S DATABASE?
// =====================================================================
// D1 DOES NOT TELL YOU. There is no `SELECT SUM(pgsize) FROM dbstat` on the
// platform, and the deployment cannot read its own database size from the
// Worker. So the figure has to be MODELLED, and the only thing that makes a
// model trustworthy is that its assumptions are measured and written down.
//
// The shape of the model is PharmaRidge's, adapted to this schema and re-measured
// against this schema:
//
//   1. ONE query of COUNT(*) per known table. One query, not one per table,
//      because this runs on a dashboard and the Workers free plan allows 50
//      subrequests per invocation — a per-table loop would spend most of the
//      budget estimating a number.
//   2. each count × a per-row byte cost, summed.
//   3. × OVERHEAD for indexes, page slack and the tables not itemised (the
//      measured whole-file growth against raw row bytes was ~1.35× for the
//      reference schema; the same factor is kept here and labelled as the
//      assumption it is).
//   4. + EMPTY_SCHEMA_BYTES, a FIXED FLOOR that does not scale with row counts.
//
// WHY THE FLOOR MATTERS MORE THAN IT LOOKS. A row-count model can only ever see
// rows. An empty StockRidge database is already 1.39 MB — 76 tables, 244 indexes
// and 22 views, none of which the model can count. On a small shop the floor IS
// most of the database, and leaving it out produces an estimate that under-warns,
// which is the dangerous direction: the whole purpose of this figure is to warn a
// proprietor BEFORE writes start failing.
//
// THE FLOOR IS MEASURED, NOT COPIED. `EMPTY_SCHEMA_BYTES` below is the size of a
// freshly migrated, VACUUMed database, measured on 2026-10-06 by
// test/integration/storage.test.js — which re-measures it and fails if the real
// figure drifts more than 25% from the constant. A migration that doubles the
// schema re-opens the question instead of quietly invalidating the answer.
// =====================================================================

/**
 * Bytes a row costs, averaged across the tables that grow.
 *
 * Places these are wrong in an obvious direction: `sales` carries two timestamps
 * and a dozen REAL columns but shares its rows with `sale_items`, which is the
 * table that actually grows (one row per line, and a wholesale sale has many).
 * A model that sees only `sales` under-counts the fastest-growing thing a busy
 * shop writes. Both are itemised for that reason.
 */
const ROW_COST_BYTES = Object.freeze({
  sales: 900,
  sale_items: 420,
  sale_payments: 260,
  change_owed: 220,
  stock_movements: 380,
  stock_batches: 420,
  stock_adjustments: 320,
  stocktake_lines: 260,
  products: 780,
  product_units: 260,
  product_barcodes: 180,
  product_price_overrides: 240,
  customers: 620,
  debtor_ledger: 300,
  creditor_ledger: 300,
  suppliers: 520,
  purchase_orders: 700,
  purchase_order_items: 380,
  purchase_order_receipts: 380,
  expenses: 480,
  till_sessions: 900,
  branch_safe_ledger: 300,
  gl_journal_entries: 520,
  gl_journal_lines: 320,
  gl_accounts: 380,
  audit_log: 700,
  sync_change_log: 300,
  sync_conflicts: 1200,
  idempotency_keys: 400,
  login_attempts: 300,
  user_sessions: 220,
  notifications: 340,
  warranty_claims: 700,
  delivery_jobs: 620,
  attendance_records: 320,
  instalment_plans: 480,
  instalment_payments: 320,
  sales_returns: 520,
  return_items: 320,
  serials: 380,
});

/** Measured 2026-10-06 against a freshly migrated database: 76 tables, 244 indexes, 22 views. */
const EMPTY_SCHEMA_BYTES = 1462272;

/** Indexes, page slack and tables not itemised above. An assumption, labelled as one. */
const OVERHEAD = 1.35;

/** D1's documented ceilings — see docs: 500 MB free, 10 GB on Workers Paid. */
const D1_FREE_LIMIT_BYTES = 500 * 1024 * 1024;
const D1_PAID_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

/** Warn before the wall, in the language of somebody who owns a shop. */
const WARN_AT = 0.70;
const CRITICAL_AT = 0.90;

const megabytes = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Estimate, in one query. Never throws: a database missing a table (an older
 * deployment, a half-applied migration) loses that table's contribution rather
 * than failing a screen somebody opened to find out what was wrong.
 */
async function estimate(db, { limitBytes = D1_FREE_LIMIT_BYTES } = {}) {
  const available = [];
  let known = [];
  try {
    const present = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
    known = new Set((present || []).map((r) => r.name));
    available.push(...Object.keys(ROW_COST_BYTES).filter((t) => known.has(t)));
  } catch (err) {
    return {
      available: false, status: 'UNKNOWN', bytes: null, megabytes: null,
      message: 'The size of this database could not be estimated because the schema could not be read.',
      error: err && err.message ? err.message : String(err),
      assumption: { overhead: OVERHEAD, emptySchemaBytes: EMPTY_SCHEMA_BYTES },
    };
  }
  if (!available.length) {
    return { available: false, status: 'UNKNOWN', bytes: null, megabytes: null, message: 'The size of this database could not be estimated: no known table was found.', assumption: { overhead: OVERHEAD, emptySchemaBytes: EMPTY_SCHEMA_BYTES } };
  }

  const sql = 'SELECT ' + available.map((t) => `(SELECT COUNT(*) FROM ${t}) AS "${t}"`).join(', ');
  const counts = (await db.first(sql)) || {};
  let rowBytes = 0;
  const byTable = [];
  for (const t of available) {
    const rows = Number(counts[t] || 0);
    const cost = rows * ROW_COST_BYTES[t];
    rowBytes += cost;
    if (rows) byTable.push({ table: t, rows, bytes: Math.round(cost * OVERHEAD) });
  }
  const bytes = Math.round(rowBytes * OVERHEAD) + EMPTY_SCHEMA_BYTES;
  const ratio = bytes / Math.max(1, limitBytes);

  const status = ratio >= CRITICAL_AT ? 'CRITICAL' : ratio >= WARN_AT ? 'WARNING' : 'OK';
  const message = status === 'CRITICAL'
    ? 'This database is nearly full. When it fills, StockRidge will stop being able to record new sales — existing records stay readable. Contact StockRidge support now to upgrade storage.'
    : status === 'WARNING'
      ? 'This database is filling up. Sales, receipts and accounting records are kept permanently for tax and inspection, so storage only grows. Contact StockRidge support to plan an upgrade, or review the retention choices below.'
      : 'There is plenty of room.';

  return {
    available: true,
    status,
    bytes,
    megabytes: megabytes(bytes),
    limit_bytes: limitBytes,
    limit_megabytes: megabytes(limitBytes),
    percent_used: Math.round(ratio * 1000) / 10,
    message,
    // The biggest contributors, so "why is it that big?" has an answer rather
    // than a percentage.
    largest: byTable.sort((a, b) => b.bytes - a.bytes).slice(0, 6).map((t) => ({ table: t.table, rows: t.rows, megabytes: megabytes(t.bytes) })),
    assumption: {
      overhead: OVERHEAD,
      emptySchemaBytes: EMPTY_SCHEMA_BYTES,
      emptySchemaMegabytes: megabytes(EMPTY_SCHEMA_BYTES),
      rows: rowBytes,
      // Said plainly, because an estimate presented as a measurement is a lie a
      // proprietor may act on.
      note: 'An estimate from row counts, not a measurement: Cloudflare does not expose the size of a D1 database to the Worker reading it. It is calibrated to warn LATE rather than early — the fixed floor of an empty schema is included.',
    },
  };
}

module.exports = {
  estimate, ROW_COST_BYTES, OVERHEAD, EMPTY_SCHEMA_BYTES,
  D1_FREE_LIMIT_BYTES, D1_PAID_LIMIT_BYTES, WARN_AT, CRITICAL_AT,
};
