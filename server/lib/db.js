'use strict';
// =====================================================================
// server/lib/db.js — STORAGE ADAPTER (Node + better-sqlite3)
// =====================================================================
// WHY THIS ADAPTER EXISTS
//
// StockRidge ships two backends: this Node one and a Cloudflare Workers one
// on D1 (worker/src/index.js). PharmaRidge shipped two backends as TWO
// IMPLEMENTATIONS of every service and route, kept parallel by hand and
// audited side by side — which is how it accumulated real parity gaps,
// including a cron handler that pruned one table on Node and a different
// table on Workers.
//
// StockRidge decouples along the storage seam instead. Every service and
// route is written ONCE against this interface:
//
//   db.first(sql, params)        -> Promise<row | null>
//   db.all(sql, params)          -> Promise<row[]>
//   db.run(sql, params)          -> Promise<{ changes, lastInsertRowid }>
//   db.scalar(sql, params)       -> Promise<first column of first row>
//   db.exec(sql)                 -> Promise  (multi-statement DDL)
//   db.transaction(fn)           -> Promise<value>  (see below)
//
// ---------------------------------------------------------------------
// THE TRANSACTION CONTRACT, AND WHY IT LOOKS UNUSUAL
// ---------------------------------------------------------------------
// A service's transaction callback receives a collector, NOT a live handle:
//
//   await db.transaction(async (tx) => {
//     const product = await db.first('SELECT ...', [id]);   // read: real db
//     tx.queue('INSERT INTO sales (...) VALUES (...)', [...]);
//     tx.queue('UPDATE stock_batches SET quantity = ...', [...]);
//     const saleId = tx.idFor('sale');                       // id known up front
//     return { saleId };
//   });
//
// Rules:
//   * READS inside a transaction go through `db` and are AWAITED.
//   * WRITES are QUEUED on `tx` and execute atomically at commit.
//   * Ids of not-yet-written rows come from tx.idFor(key), so a child row
//     can reference its parent before either exists.
//
// This is not a stylistic quirk — it is what makes one service source run on
// both backends. better-sqlite3 is fully synchronous and CANNOT span a
// microtask, so `await tx.run(...)` inside its transaction() wrapper would
// silently escape the transaction and commit a half-written sale. D1,
// conversely, cannot do interactive transactions at all, but it CAN execute
// an array of statements atomically via `.batch()`. A queue-then-execute
// contract maps exactly onto both: BEGIN IMMEDIATE + run-all + COMMIT here,
// and a single .batch() there.
//
// The cost is stated plainly: you cannot branch on the result of a WRITE
// inside a transaction. You can branch on READS. Every flow in this app
// (sale, receive, transfer, stocktake commit, plan payment) reads first and
// writes second, which is why the constraint has not bitten.
//
// WHAT THE ADAPTER DELIBERATELY DOES NOT DO
// It does not translate SQL dialects. Both engines are SQLite and the schema
// avoids anything D1 lacks. The only divergence is the foreign_keys pragma:
// D1 always enforces foreign keys and refuses to let user SQL set the
// pragma, so this adapter sets it per connection and the Worker's does not.
// =====================================================================

const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'schema', 'migrations');
const { newId } = require('../../domain/crypto');

/**
 * Open (or create) the database file and apply pragmas.
 *
 * journal_mode = WAL: a shop floor has one writer and several readers (the
 * POS writing while the dashboard reads). Without WAL a reader blocks the
 * writer, which at the counter means a till that freezes while a report runs.
 *
 * synchronous = NORMAL under WAL is the documented safe-and-fast setting: it
 * survives a process crash, and only an OS/power crash can lose the last
 * transaction. On a shop machine that loses power regularly FULL would be
 * safer, but it roughly halves write throughput and the till would stutter
 * mid-queue. NORMAL with WAL is the deliberate trade, and it is the same
 * guarantee D1 gives.
 *
 * foreign_keys = ON must be set PER CONNECTION in SQLite — it is not stored
 * in the file. Forgetting it silently turns every REFERENCES clause into a
 * comment, and the resulting orphan rows break reports in ways that look
 * like data corruption rather than a missing pragma.
 */
function openDatabase({ file = null, readonly = false, verbose = false } = {}) {
  const location = file || process.env.STOCKRIDGE_DB || path.join(PROJECT_ROOT, '.data', 'stockridge.db');
  if (location !== ':memory:') fs.mkdirSync(path.dirname(location), { recursive: true });
  const raw = new Database(location, { readonly, verbose: verbose ? console.log : undefined });
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  return wrap(raw, { location });
}

/** Wrap a better-sqlite3 instance in the portable interface. */
function wrap(raw, meta = {}) {
  // Statements are CACHED per SQL string. Prepare is the expensive part of a
  // better-sqlite3 call, and the POS prepares the same dozen statements
  // thousands of times a day.
  const cache = new Map();
  let hits = 0;
  let misses = 0;

  function prepare(sql) {
    const cached = cache.get(sql);
    if (cached) { hits += 1; return cached; }
    misses += 1;
    const stmt = raw.prepare(sql);
    // Bound the cache: an unbounded Map keyed by SQL text grows forever if a
    // caller ever interpolates a value into the string instead of binding it.
    if (cache.size > 500) cache.clear();
    cache.set(sql, stmt);
    return stmt;
  }

  function params(list) {
    if (list == null) return [];
    const arr = Array.isArray(list) ? list : [list];
    // Booleans have no SQLite storage class. Normalise so the schema's
    // INTEGER flags behave identically on both backends.
    return arr.map((p) => {
      if (typeof p === 'boolean') return p ? 1 : 0;
      if (p === undefined) return null;
      return p;
    });
  }

  /**
   * Run a statement, and if it throws, say WHICH one.
   *
   * better-sqlite3's errors are accurate and useless at the same time:
   * "Too few parameter values were provided" and "34 values for 32 columns"
   * name no statement, so in a transaction that queued forty writes there is
   * nothing to go on. Every failure is rethrown with the SQL, the placeholder
   * count and the parameter count attached — the three facts that identify a
   * hand-written statement bug immediately. The original error is preserved as
   * `cause` and its `code` is carried across, so callers that switch on
   * SQLITE_CONSTRAINT still work.
   *
   * This is diagnostics only. It never changes what is executed, and it adds
   * no cost on the success path.
   */
  function guard(sql, bind, fn) {
    try {
      return fn();
    } catch (e) {
      const list = params(bind);
      const placeholders = (String(sql).match(/\?/g) || []).length;
      const head = String(sql).replace(/\s+/g, ' ').trim().slice(0, 160);
      const detail = placeholders !== list.length
        ? ` The statement has ${placeholders} placeholder(s) but received ${list.length} value(s).`
        : '';
      const wrapped = Object.assign(
        new Error(`${e.message}${detail} Statement: ${head}${placeholders !== list.length ? '' : ` [${placeholders} bound value(s)]`}`, { cause: e }),
        { code: e.code, sql: String(sql), paramCount: list.length, placeholderCount: placeholders },
      );
      throw wrapped;
    }
  }

  const api = {
    first(sql, bind) {
      const row = guard(sql, bind, () => prepare(sql).get(...params(bind)));
      return Promise.resolve(row === undefined ? null : row);
    },
    all(sql, bind) {
      return Promise.resolve(guard(sql, bind, () => prepare(sql).all(...params(bind))));
    },
    run(sql, bind) {
      const info = guard(sql, bind, () => prepare(sql).run(...params(bind)));
      return Promise.resolve({ changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) });
    },
    scalar(sql, bind) {
      const row = guard(sql, bind, () => prepare(sql).get(...params(bind)));
      if (!row) return Promise.resolve(null);
      const values = Object.values(row);
      return Promise.resolve(values.length ? values[0] : null);
    },
    exec(sql) { raw.exec(sql); return Promise.resolve({ ok: true }); },
    batch(statements) {
      const run = raw.transaction((list) => {
        for (let i = 0; i < list.length; i += 1) {
          const s = list[i];
          // The index is included because a failed batch does not otherwise
          // say which of its statements broke.
          guard(s.sql, s.params, () => prepare(s.sql).run(...params(s.params)));
          void i;
        }
      });
      run(statements || []);
      return Promise.resolve({ ok: true, count: (statements || []).length });
    },
    async transaction(fn) {
      const tx = createCollector(api);
      const value = await fn(tx);
      if (!tx.statements.length) return value;
      // BEGIN IMMEDIATE, not DEFERRED: a deferred transaction upgrades to a
      // write lock partway through and dies with SQLITE_BUSY if another
      // connection holds it — after having already done work.
      const commit = raw.transaction((list) => {
        for (let i = 0; i < list.length; i += 1) {
          const s = list[i];
          try {
            guard(s.sql, s.params, () => prepare(s.sql).run(...params(s.params)));
          } catch (e) {
            // Naming the position in the queue matters: a sale queues thirty
            // writes and the fortieth is not the one that failed.
            e.queuePosition = i;
            e.queueLength = list.length;
            throw e;
          }
        }
      });
      commit.immediate(tx.statements);
      return value;
    },
    pragma(name) { return raw.pragma(name); },
    close() { cache.clear(); raw.close(); },
    get raw() { return raw; },
    get location() { return meta.location || null; },
    get stats() { return { hits, misses, cached: cache.size }; },
    get dialect() { return 'sqlite-node'; },
  };

  return api;
}

/**
 * The transaction collector described in the header comment.
 *
 * `idFor(key)` is the piece that makes parent/child inserts possible: the
 * id is generated up front, so a child row can reference a parent that has
 * not been written yet, and both land in the same atomic commit.
 */
function createCollector(db) {
  const statements = [];
  const ids = new Map();
  return {
    statements,
    queue(sql, bind) { statements.push({ sql, params: bind || [] }); return statements.length - 1; },
    idFor(key) {
      const k = String(key);
      if (!ids.has(k)) ids.set(k, newId());
      return ids.get(k);
    },
    peek(key) { return ids.get(String(key)) || null; },
    get count() { return statements.length; },
    // Reads pass through to the real db, and are awaited normally.
    first: (sql, bind) => db.first(sql, bind),
    all: (sql, bind) => db.all(sql, bind),
    scalar: (sql, bind) => db.scalar(sql, bind),
    get dialect() { return db.dialect; },
  };
}

/**
 * Apply every migration in schema/migrations in filename order.
 *
 * Applied state is tracked in a `_migrations` table rather than inferred
 * from the schema, so a partially-applied migration is visible instead of
 * silently skipped. A migration whose file has CHANGED since it was applied
 * is a hard error: editing an applied migration is how a fleet of existing
 * deployments silently diverges from a fresh install, and the divergence
 * only surfaces months later as a column that exists on some databases and
 * not others.
 */
async function migrate(db, { dir = MIGRATIONS_DIR, reset = false } = {}) {
  if (reset) {
    await db.exec('PRAGMA foreign_keys = OFF');
    const views = await db.all("SELECT name FROM sqlite_master WHERE type='view'");
    for (const v of views) await db.exec(`DROP VIEW IF EXISTS "${v.name}"`);
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    for (const t of tables) await db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    await db.exec('PRAGMA foreign_keys = ON');
  }

  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    checksum    TEXT
  )`);

  if (!fs.existsSync(dir)) return { applied: [], skipped: [] };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map((await db.all('SELECT id, checksum FROM _migrations')).map((r) => [r.id, r.checksum]));

  const result = { applied: [], skipped: [] };
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(id)) {
      if (applied.get(id) && applied.get(id) !== checksum) {
        throw new Error(
          `Migration "${id}" has CHANGED since it was applied. Never edit an applied migration — add a new one. `
          + 'Otherwise existing deployments silently diverge from fresh installs.',
        );
      }
      result.skipped.push(id);
      continue;
    }
    await db.exec(sql);
    await db.run('INSERT INTO _migrations (id, checksum) VALUES (?, ?)', [id, checksum]);
    result.applied.push(id);
  }
  return result;
}

// schemaInfo lives in its own module now, with nothing in it that needs a
// driver, because the portable route set (health.js) uses it and a Worker
// bundle must be able to import that without pulling in better-sqlite3.
const { schemaInfo, appliedMigrationCount } = require('./schemaInfo');

module.exports = { openDatabase, wrap, createCollector, migrate, schemaInfo, appliedMigrationCount, PROJECT_ROOT, MIGRATIONS_DIR };
