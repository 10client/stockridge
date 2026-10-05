'use strict';
// =====================================================================
// server/lib/schemaInfo.js — WHAT SHAPE IS THIS DATABASE IN?
// =====================================================================
// Split out of server/lib/db.js so that it can be required from a runtime that
// has no better-sqlite3 — which is the whole point of the Cloudflare Workers
// build. `server/routes/health.js` needs this and health.js is part of the
// portable route set; if it reached into db.js for it, importing the route
// registry would drag a native SQLite binding into a Worker bundle and the
// build would fail on a module that cannot exist there.
//
// Nothing in this file touches the filesystem, Node built-ins or a driver. It
// asks the database three questions through the portable interface and returns
// a summary.
// =====================================================================

async function schemaInfo(db) {
  const tables = await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations'",
  );
  const views = await db.all("SELECT name FROM sqlite_master WHERE type = 'view'");
  const indexes = await db.all(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
  );
  return {
    tables: tables.length,
    views: views.length,
    indexes: Number((indexes[0] && indexes[0].c) || 0),
    tableNames: tables.map((t) => t.name).sort(),
    viewNames: views.map((v) => v.name).sort(),
  };
}

/**
 * How many migrations have been applied, counted in a way that works on both
 * backends.
 *
 * Node's migrator records them in `_migrations`, with a checksum, so that an
 * edited migration is a hard error. Cloudflare D1 keeps its own bookkeeping in
 * `d1_migrations`, applied by `wrangler d1 migrations apply`, and does not
 * create `_migrations` at all. Asking for the wrong table throws "no such
 * table", which a readiness probe would report as a database fault on a
 * perfectly healthy deployment — so both are tried, and the answer says which
 * one it came from.
 */
async function appliedMigrationCount(db) {
  for (const table of ['_migrations', 'd1_migrations']) {
    try {
      const n = await db.scalar(`SELECT COUNT(*) FROM ${table}`);
      return { count: Number(n) || 0, table };
    } catch (e) { /* not this backend */ }
  }
  return { count: 0, table: null };
}

module.exports = { schemaInfo, appliedMigrationCount };
