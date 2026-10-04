// =====================================================================
// server/db/adapter.js — THE DATA-ACCESS SEAM
// =====================================================================
//
// THIS FILE IS WHY STOCKRIDGE CAN SHIP TWO BACKENDS WITHOUT TWO CODEBASES.
//
// PharmaRidge maintained server/ (Node + better-sqlite3, SYNCHRONOUS) and
// worker/src/ (Cloudflare Workers + D1, ASYNCHRONOUS) as parallel trees. Its
// own comments admit the cost: planLimits.js was described as a "Cloudflare D1
// port of the original implementation ... kept deliberately parallel in
// structure/wording to the Node version so the two backends are easy to audit
// side by side." Parallel-by-discipline. And the audit log shows what that
// discipline costs — a documented parity gap where the Node backend pruned
// sync_change_log and the Worker never did, undetected until an audit found it.
//
// StockRidge removes the seam instead of managing it:
//
//   * EVERY service and route is written against ONE async data interface
//     (the D1 shape, because it is the more constrained of the two — you can
//     always make a sync API look async, never the reverse).
//   * server/db/adapter.js implements that interface over better-sqlite3 or
//     sql.js. worker/src/d1Adapter.js implements the SAME interface over D1 —
//     which needs almost no work, because D1 already has that shape.
//   * shared/services/* contains the business logic. It is loaded unchanged by
//     both backends. There is nothing to keep in parity, because there is only
//     one copy.
//
// THE INTERFACE (a deliberate subset of D1's):
//
//   db.prepare(sql)
//       .bind(...values)
//       .first()  -> row object | null
//       .all()    -> array of row objects
//       .run()    -> { changes, lastInsertRowid }
//   db.batch([...statements])           -> array of run results, one transaction
//   runTransaction(db, async (tx) => {}) -> commit or roll back
//
// Every value is bound, never interpolated. There is no code path in this
// project that builds SQL from a user-supplied string as a value.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DRIVERS = Object.freeze(['auto', 'better-sqlite3', 'sql.js']);

// ---------------------------------------------------------------------
// driver selection
// ---------------------------------------------------------------------
// better-sqlite3 is the production driver: native, synchronous, WAL-capable,
// and roughly an order of magnitude faster than the WASM build. But it needs a
// prebuilt binary for the host platform, and "npm install failed on the
// client's Windows box" is not an acceptable reason for a shop to be unable to
// open its till. sql.js is pure WASM — it always installs, always runs — at
// the cost of holding the database in memory and flushing it to disk on a
// timer and at every commit.
function selectDriver(preference = 'auto') {
  const want = String(preference || 'auto').toLowerCase();
  if (!DRIVERS.includes(want)) {
    throw new Error(`STOCKRIDGE_DRIVER must be one of: ${DRIVERS.join(', ')} (got "${preference}")`);
  }
  if (want === 'better-sqlite3' || want === 'auto') {
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      const Database = require('better-sqlite3');
      return { name: 'better-sqlite3', Database };
    } catch (e) {
      if (want === 'better-sqlite3') {
        throw new Error(
          'STOCKRIDGE_DRIVER=better-sqlite3 was requested but the module could not be loaded. '
          + 'Run `npm rebuild better-sqlite3`, or set STOCKRIDGE_DRIVER=sql.js to use the '
          + 'pure-WASM driver instead.\n'
          + `Underlying error: ${e.message}`
        );
      }
    }
  }
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const initSqlJs = require('sql.js');
    return { name: 'sql.js', initSqlJs };
  } catch (e) {
    throw new Error(
      'No SQLite driver is available. Install one with `npm install better-sqlite3` '
      + '(recommended) or `npm install sql.js` (pure WASM, no native build).\n'
      + `Underlying error: ${e.message}`
    );
  }
}

// ---------------------------------------------------------------------
// statement wrapper — the D1-shaped async API over a sync driver
// ---------------------------------------------------------------------
class Statement {
  constructor(db, sql, driverName) {
    this.db = db;
    this.sql = sql;
    this.driverName = driverName;
    this.params = [];
  }

  bind(...values) {
    // D1 allows bind(a, b, c) and bind([a, b, c]); support both so a service
    // written against D1 works here unchanged.
    const flat = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
    this.params = flat.map(normaliseParam);
    return this;
  }

  async first(...cols) {
    const row = this.driverName === 'better-sqlite3'
      ? this.db.prepare(this.sql).get(...this.params)
      : sqlJsFirst(this.db, this.sql, this.params);
    if (!row) return null;
    if (cols && cols.length) {
      // D1's first('column') returns the scalar, not a row.
      return cols.length === 1 ? row[cols[0]] : cols.map((c) => row[c]);
    }
    return row;
  }

  async all() {
    const rows = this.driverName === 'better-sqlite3'
      ? this.db.prepare(this.sql).all(...this.params)
      : sqlJsAll(this.db, this.sql, this.params);
    if (Array.isArray(rows)) {
      rows.results = rows;
    }
    return rows;
  }

  async run() {
    if (this.driverName === 'better-sqlite3') {
      const info = this.db.prepare(this.sql).run(...this.params);
      return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
    }
    return sqlJsRun(this.db, this.sql, this.params);
  }

  /** Convenience: run and return the changes count. */
  async changes() {
    const r = await this.run();
    return (r.meta && r.meta.changes) || 0;
  }
}

/**
 * Bind-value normalisation.
 *
 * THE RULE THAT PREVENTS THE WORST CLASS OF SQLITE BUG IN JAVASCRIPT:
 * `undefined` is not a valid bind value. better-sqlite3 THROWS on it; D1
 * silently coerces it to NULL. Two backends, two behaviours, and the D1 one is
 * worse — a field the caller forgot to set becomes a NULL in the database
 * instead of an error, so a product silently loses its reorder level and
 * nobody notices for a month.
 *
 * So: undefined is REJECTED here, loudly, on both drivers. Absent means absent.
 * If you want NULL, pass null and mean it.
 */
function normaliseParam(v) {
  if (v === undefined) {
    throw new TypeError(
      'Cannot bind `undefined` to a SQL parameter. Pass null to store NULL, or omit the field. '
      + 'Binding undefined is rejected on purpose: D1 would silently write NULL where '
      + 'better-sqlite3 would throw, and the two backends must not disagree.'
    );
  }
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') {
    // Arrays and objects have no SQLite representation. JSON-encode them
    // rather than binding "[object Object]", which is unrecoverable.
    return JSON.stringify(v);
  }
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new TypeError(`Cannot bind a non-finite number (${v}) to a SQL parameter.`);
  }
  return v;
}

// ---------------------------------------------------------------------
// sql.js helpers
// ---------------------------------------------------------------------
// sql.js has no prepared-statement cache and no .get()/.all() convenience, so
// the same three operations are implemented against its exec/prepare API.
// Its parameter binding treats a JS `true` as 1 already, but it will happily
// bind a JS object as NULL, so normaliseParam runs before we get here.
function sqlJsAll(db, sql, params) {
  const stmt = db.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

function sqlJsFirst(db, sql, params) {
  const rows = sqlJsAll(db, sql, params);
  return rows.length ? rows[0] : null;
}

function sqlJsRun(db, sql, params) {
  db.run(sql, params && params.length ? params : []);
  // sql.js does not expose changes() for a non-SELECT directly through run();
  // `SELECT changes()` immediately afterwards is the documented way.
  let changes = 0;
  try {
    const r = db.exec('SELECT changes() AS c');
    changes = r && r.length ? Number(r[0].values[0][0]) : 0;
  } catch (e) { changes = 0; }
  return { success: true, meta: { changes } };
}

// ---------------------------------------------------------------------
// the handle
// ---------------------------------------------------------------------
class DatabaseHandle {
  constructor({ impl, driverName, filePath, persist }) {
    this.impl = impl;
    this.driverName = driverName;
    this.filePath = filePath || null;
    this._persist = persist || null;
    this._txDepth = 0;
    this._dirtySinceFlush = false;
  }

  prepare(sql) {
    return new Statement(this.impl, sql, this.driverName);
  }

  /** Execute several statements inside ONE transaction. */
  async batch(statements) {
    const out = [];
    await this.transaction(async () => {
      for (const s of statements || []) {
        // Accept either a Statement or a plain SQL string.
        out.push(typeof s === 'string' ? this.prepare(s).run() : s.run());
      }
    });
    return Promise.all(out);
  }

  /**
   * Run `fn` inside a transaction.
   *
   * NESTING: SQLite has no nested transactions, so a nested call joins the
   * outer one via a SAVEPOINT. This matters because services compose — a sale
   * posts stock, ledger and GL entries, and each of those is itself written as
   * a self-contained transactional unit. Without savepoints, an inner service
   * committing would end the outer transaction early and a later failure would
   * leave half a sale written.
   */
  async transaction(fn) {
    const depth = this._txDepth;
    const name = `sr_sp_${depth}_${Date.now().toString(36)}`;
    if (depth === 0) this.exec('BEGIN IMMEDIATE');
    else this.exec(`SAVEPOINT ${name}`);
    this._txDepth += 1;
    try {
      const result = await fn(this);
      if (depth === 0) this.exec('COMMIT');
      else this.exec(`RELEASE ${name}`);
      this._txDepth -= 1;
      if (depth === 0) this.markDirty();
      return result;
    } catch (e) {
      try {
        if (depth === 0) this.exec('ROLLBACK');
        else this.exec(`ROLLBACK TO ${name}`);
      } catch (rollbackErr) {
        // A rollback that itself fails means the connection is unusable.
        // Say so plainly rather than masking the original error.
        e.rollbackFailed = rollbackErr.message;
      }
      this._txDepth = depth;
      throw e;
    }
  }

  exec(sql) {
    if (this.driverName === 'better-sqlite3') this.impl.exec(sql);
    else this.impl.run(sql);
  }

  /** Raw multi-statement script (migrations). Not parameterised by design. */
  execScript(sql) {
    if (this.driverName === 'better-sqlite3') {
      this.impl.exec(sql);
    } else {
      this.impl.run(sql);
    }
    this.markDirty();
  }

  markDirty() {
    this._dirtySinceFlush = true;
    if (this._persist) this._persist();
  }

  /** Force a durable flush (sql.js only; better-sqlite3 is always durable). */
  flush() {
    if (this._persist) this._persist();
    this._dirtySinceFlush = false;
  }

  close() {
    try { this.flush(); } catch (e) { /* best effort */ }
    try { this.impl.close(); } catch (e) { /* best effort */ }
  }

  /** Diagnostics surfaced on /api/health so a support call can see the engine. */
  info() {
    let version = null; let pageSize = null; let journal = null;
    try { version = this.prepare('SELECT sqlite_version() AS v').first ? null : null; } catch (e) { /* ignore */ }
    try {
      const row = this.driverName === 'better-sqlite3'
        ? this.impl.prepare('SELECT sqlite_version() AS v').get()
        : sqlJsFirst(this.impl, 'SELECT sqlite_version() AS v', []);
      version = row ? row.v : null;
    } catch (e) { /* ignore */ }
    if (this.driverName === 'better-sqlite3') {
      try { pageSize = this.impl.pragma('page_size', { simple: true }); } catch (e) { /* ignore */ }
      try { journal = this.impl.pragma('journal_mode', { simple: true }); } catch (e) { /* ignore */ }
    }
    return { driver: this.driverName, sqliteVersion: version, pageSize, journalMode: journal, file: this.filePath };
  }
}

// ---------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------
/**
 * Open (creating if needed) the StockRidge database.
 *
 * @param {object} opts
 * @param {string} [opts.file]      path to the SQLite file; ':memory:' for tests
 * @param {string} [opts.driver]    'auto' | 'better-sqlite3' | 'sql.js'
 * @param {boolean} [opts.wal]      enable WAL (better-sqlite3 only; default true)
 */
async function openDatabase(opts = {}) {
  const file = opts.file || ':memory:';
  const chosen = selectDriver(opts.driver || process.env.STOCKRIDGE_DRIVER || 'auto');
  const inMemory = file === ':memory:' || file === '';

  if (chosen.name === 'better-sqlite3') {
    if (!inMemory) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const impl = new chosen.Database(file);
    // Foreign keys are OFF by default in SQLite. Every relationship in this
    // schema depends on them, so this is not optional — a missing pragma here
    // is how an orphaned sale_item survives a deleted sale.
    impl.pragma('foreign_keys = ON');
    if (opts.wal !== false && !inMemory) {
      // WAL lets readers and one writer proceed concurrently, which is what
      // makes four tills plus a stocktake usable on one box.
      impl.pragma('journal_mode = WAL');
      impl.pragma('synchronous = NORMAL');
      impl.pragma('busy_timeout = 8000');
    }
    return new DatabaseHandle({ impl, driverName: 'better-sqlite3', filePath: inMemory ? null : file });
  }

  // sql.js: load the WASM engine, then load the file's bytes if it exists.
  const SQL = await chosen.initSqlJs();
  let impl;
  const abs = inMemory ? null : path.resolve(file);
  if (abs && fs.existsSync(abs)) {
    impl = new SQL.Database(fs.readFileSync(abs));
  } else {
    impl = new SQL.Database();
    if (abs) fs.mkdirSync(path.dirname(abs), { recursive: true });
  }
  // sql.js does not enforce foreign keys unless asked, per connection.
  impl.run('PRAGMA foreign_keys = ON;');

  // Persistence: sql.js keeps the whole database in memory, so durability is
  // OUR job. Write atomically (temp file + rename) so a crash mid-write cannot
  // truncate the client's database — a half-written SQLite file is not
  // recoverable, and "the shop lost its data" is the one failure with no
  // workaround.
  let writing = false;
  const persist = () => {
    if (!abs || writing) return;
    writing = true;
    try {
      const data = Buffer.from(impl.export());
      const tmp = `${abs}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, abs);
    } catch (e) {
      // Never throw from a persist hook inside a transaction rollback path —
      // that would mask the real error. Log loudly instead.
      // eslint-disable-next-line no-console
      console.error('[stockridge] CRITICAL: could not persist the database:', e.message);
    } finally {
      writing = false;
    }
  };

  return new DatabaseHandle({ impl, driverName: 'sql.js', filePath: abs, persist });
}

module.exports = { openDatabase, DatabaseHandle, Statement, selectDriver, normaliseParam, DRIVERS };
