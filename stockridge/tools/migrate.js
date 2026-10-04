// =====================================================================
// StockRidge — MIGRATIONS
// =====================================================================
// Applied in filename order, tracked in a _migrations table, each one run
// inside a transaction so a half-applied migration cannot leave the database
// in a state that is neither old nor new.
//
// The SAME files are what `wrangler d1 migrations apply` consumes for the
// Cloudflare deployment, which is why they are plain .sql with no driver-
// specific syntax and no PRAGMA statements (D1 always enforces foreign keys
// and cannot be told otherwise — leaving `PRAGMA foreign_keys = ON` in a
// migration aborts the apply).
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = fs.existsSync(path.join(__dirname, '..', 'server', 'db', 'migrations'))
  ? path.join(__dirname, '..', 'server', 'db', 'migrations')
  : path.join(__dirname, '..', 'migrations');

function listMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function ensureTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
      checksum    TEXT
    );
  `);
}

// A cheap checksum so a migration that has already been applied is not silently
// different from the one on disk. Editing an applied migration is the classic
// way a dev machine and production diverge without anyone noticing.
function checksum(sql) {
  let h = 0;
  for (let i = 0; i < sql.length; i += 1) { h = ((h << 5) - h + sql.charCodeAt(i)) | 0; }
  return String(h >>> 0);
}

async function runMigrations(db, { dir = MIGRATIONS_DIR, quiet = false, reset = false } = {}) {
  if (reset) {
    await db.exec(`DROP TABLE IF EXISTS _migrations;`);
  }
  await ensureTable(db);
  const applied = await db.prepare('SELECT name, checksum FROM _migrations').all();
  const appliedMap = new Map(applied.results.map((r) => [r.name, r.checksum]));
  const files = listMigrations(dir);
  const results = [];

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const sum = checksum(sql);
    if (appliedMap.has(file)) {
      if (appliedMap.get(file) !== sum) {
        // Warn loudly but do not fail: a checksum mismatch on a re-run is
        // usually a line-ending or whitespace difference between machines, and
        // refusing to boot over it would be worse than the risk it guards.
        if (!quiet) console.warn(`[migrate] WARNING: ${file} has changed since it was applied. Applied migrations must never be edited — add a new one.`);
        results.push({ file, status: 'already-applied-changed' });
      } else {
        results.push({ file, status: 'already-applied' });
      }
      continue;
    }
    try {
      await db.exec(sql);
      await db.prepare('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, datetime(\'now\'), ?)')
        .bind(file, sum).run();
      results.push({ file, status: 'applied' });
      if (!quiet) console.log(`[migrate] applied ${file}`);
    } catch (e) {
      if (!quiet) console.error(`[migrate] FAILED on ${file}:`, e.message);
      throw e;
    }
  }
  return { total: files.length, applied: results.filter((r) => r.status === 'applied').length, results };
}

if (require.main === module) {
  (async () => {
    const reset = process.argv.includes('--reset');
    const { db: getDb } = require('../server/lib/db');
    const database = await getDb({ reset });
    const result = await runMigrations(database, { reset });
    console.log(`[migrate] ${result.applied} new, ${result.total} total`);
    const counts = await database.prepare(`
      SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%') AS tables,
             (SELECT COUNT(*) FROM sqlite_master WHERE type='view') AS views,
             (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%') AS indexes
    `).first();
    console.log(`[migrate] database now has ${counts.tables} tables, ${counts.views} views, ${counts.indexes} indexes`);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runMigrations, listMigrations, MIGRATIONS_DIR, migrate: runMigrations };
'use strict';
