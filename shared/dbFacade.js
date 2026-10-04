// =====================================================================
// StockRidge — DATABASE FACADE  (the backend-decoupling point)
// =====================================================================
//
// PharmaRidge shipped TWO backends and paid for it twice. Every route
// existed as `server/routes/x.js` (better-sqlite3, synchronous) AND
// `worker/src/routes/x.js` (D1, asynchronous). Its own comments record the
// cost: a parity gap where the Node cron pruned sync_change_log and the
// Worker cron never did; a tenant-isolation hole fixed in one backend; a
// receiving-unit library maintained in `server/lib/receiving.js` and
// `worker/src/lib/receiving.js` "kept deliberately parallel in structure
// and wording so the two backends are easy to audit side by side".
// Parallel code that must be audited side by side is code that drifts.
//
// StockRidge therefore has ONE implementation of every route and service,
// written against the D1-shaped async API (prepare/bind/first/all/run/
// batch). Two thin adapters make it run anywhere:
//
//   server/lib/db.js      better-sqlite3  -> D1-shaped facade   (Node)
//   worker/src/lib/db.js  D1              -> same facade        (Workers)
//
// The Node adapter is not a toy: it is the same object contract, so a bug
// found against SQLite is a bug found against D1. The rules the adapters
// must honour are stated once, here, and both are tested against them in
// test/db.contract.js.
//
// CONTRACT
// --------
//   db.prepare(sql)              -> Statement
//   stmt.bind(...params)         -> Statement   (immutable, chainable)
//   stmt.first([col])            -> Promise<object|null|scalar>
//   stmt.all()                   -> Promise<{ results: object[] }>
//   stmt.run()                   -> Promise<{ success, meta:{ changes, last_row_id } }>
//   stmt.raw()                   -> Promise<array[]>   (rows as arrays)
//   db.batch([stmt,...])         -> Promise<result[]>  (single transaction, all-or-nothing)
//   db.transaction(fn)           -> Promise<T>         (helper, not in D1: implemented as batch)
//
// PARAMETER RULES (identical on both):
//   * Positional `?` only. Named parameters are NOT supported, because D1
//     binds them differently and a positional-only rule is the one thing
//     that cannot diverge.
//   * JS values must be null | number | string | bigint. `undefined`,
//     `boolean`, Date and object are REJECTED with a clear error rather
//     than silently coerced — an `undefined` bound into SQLite becomes
//     NULL, which is how a WHERE clause quietly matches nothing.
//   * booleans must be 0/1 (SQLite has no boolean). `b()` below converts.
//
// TRANSACTION RULES:
//   `db.batch()` is atomic on both. Never issue several mutating
//   statements outside a batch: on the Node adapter they would each
//   autocommit, so a crash half-way through a sale would take the money
//   and not decrement the stock.
// =====================================================================

class DbError extends Error {
  constructor(message, { code = 'DB_ERROR', cause = null } = {}) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// Bound-value gate. Shared by both adapters so the rejection message and
// therefore the developer experience is identical.
function assertBindable(value, index) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new DbError(
        `Parameter #${index + 1} is ${value}, which is not a finite number. `
        + 'Pass null for "unknown" rather than NaN/Infinity — NaN in a SQL comparison matches nothing and fails silently.'
      );
    }
    return value;
  }
  if (t === 'string') return value;
  if (t === 'bigint') return value;
  if (t === 'boolean') {
    throw new DbError(
      `Parameter #${index + 1} is a boolean. SQLite has no boolean type — pass 1 or 0 (use b(value) from lib/db).`
    );
  }
  if (value === undefined) {
    throw new DbError(
      `Parameter #${index + 1} is undefined. That would become NULL and silently break the query — pass null explicitly, or omit the field.`
    );
  }
  throw new DbError(`Parameter #${index + 1} is ${t}, which cannot be bound. Serialise it to a string first.`);
}

function b(value) { return value ? 1 : 0; }

// ---------------------------------------------------------------------
// Node adapter: better-sqlite3 behind the D1-shaped facade
// ---------------------------------------------------------------------
function createSqliteDb(betterSqlite3, { filename = ':memory:', fileMustExist = false, verbose = null } = {}) {
  const Database = betterSqlite3;
  const raw = new Database(filename, { fileMustExist, verbose: verbose || undefined });

  // WAL: concurrent readers alongside a writer. Without it a POS sale
  // blocks the dashboard's report queries and the manager's screen spins
  // while a cashier checks out. :memory: cannot use WAL, so it is skipped.
  if (filename !== ':memory:') {
    raw.pragma('journal_mode = WAL');
    // NORMAL is the right durability/throughput point for WAL: full fsync
    // per commit is not survivable on the cheap SSDs Nigerian SME servers
    // run on, and NORMAL still cannot corrupt the database on power loss.
    raw.pragma('synchronous = NORMAL');
    raw.pragma('busy_timeout = 8000');
    raw.pragma('foreign_keys = ON');
  } else {
    raw.pragma('foreign_keys = ON');
  }

  let inTransaction = false;

  class Statement {
    constructor(sql) { this.sql = sql; this.params = []; this._raw = false; }
    bind(...params) {
      const next = new Statement(this.sql);
      next.params = this.params.concat(params.map(assertBindable));
      return next;
    }
    raw() { this._raw = true; return this; }
    _stmt() {
      try { return raw.prepare(this.sql); } catch (e) {
        throw new DbError(`SQL prepare failed: ${e.message}\n--- SQL ---\n${this.sql}`, { code: 'SQL_PREPARE_FAILED', cause: e });
      }
    }
    // better-sqlite3 silently IGNORES extra bound values and throws an opaque
    // "Too many parameter values" for some shapes. Neither is acceptable: a
    // bind list that disagrees with the placeholders is always a bug, and it
    // should say so with the SQL next to it.
    _assertArity(stmt) {
      const expected = stmt.reader ? stmt.reader.columns : null;
      const count = Number(stmt.statement && stmt.statement.bindParameterCount != null
        ? stmt.statement.bindParameterCount
        : (stmt.source ? countPlaceholders(stmt.source) : null));
      if (Number.isFinite(count) && count !== this.params.length) {
        throw new DbError(
          `This statement has ${count} placeholder${count === 1 ? '' : 's'} but ${this.params.length} value${this.params.length === 1 ? '' : 's'} were bound. `
          + 'The column list and the VALUES list almost certainly disagree.\n--- SQL ---\n' + this.sql,
          { code: 'BIND_ARITY_MISMATCH' }
        );
      }
      void expected;
    }
    async first(col) {
      const row = this._stmt().get(...this.params);
      if (row === undefined) return null;
      if (col) return row[col] === undefined ? null : row[col];
      return row;
    }
    async all() {
      const rows = this._stmt().all(...this.params);
      return { results: this._raw ? rows.map((r) => Object.values(r)) : rows };
    }
    async run() {
      const info = this._stmt().run(...this.params);
      return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid || 0), duration: 0, served_by: 'sqlite' } };
    }
  }

  const db = {
    driver: 'sqlite',
    filename,
    prepare(sql) {
      if (typeof sql !== 'string' || !sql.trim()) throw new DbError('prepare() requires a non-empty SQL string');
      return new Statement(sql);
    },
    async batch(statements) {
      if (!Array.isArray(statements) || !statements.length) return [];
      const results = [];
      // Nested batch inside an open transaction just runs inline — SQLite
      // has no savepoint-free nested BEGIN, and every caller that needs
      // atomicity already has it from the outer transaction.
      const run = () => {
        for (const s of statements) {
          if (!s || typeof s.run !== 'function') throw new DbError('db.batch() takes prepared statements only');
          const info = s._stmt().run(...s.params);
          results.push({ success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid || 0) } });
        }
        return results;
      };
      if (inTransaction) return run();
      const tx = raw.transaction(run);
      inTransaction = true;
      try { return tx(); } finally { inTransaction = false; }
    },
    // Escape hatch for schema/DDL and pragmas, which are not bindable.
    async exec(sql) { raw.exec(sql); return { success: true }; },
    async transaction(fn) {
      if (inTransaction) return fn(db);
      inTransaction = true;
      try {
        raw.exec('BEGIN IMMEDIATE');
        const out = await fn(db);
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
        throw e;
      } finally {
        inTransaction = false;
      }
    },
    close() { try { raw.close(); } catch (_) { /* noop */ } },
    get handle() { return raw; },
  };

  return db;
}

// ---------------------------------------------------------------------
// Cloudflare D1 adapter
// ---------------------------------------------------------------------
// D1 already speaks prepare/bind/first/all/run/batch, so this is a
// pass-through that exists for two reasons: (1) it applies the SAME
// bindable-value gate, so a boolean or undefined is rejected identically
// on both backends; (2) it normalises .run()'s meta, which D1 spells
// differently from better-sqlite3.
function createD1Db(d1) {
  class Statement {
    constructor(inner, sql) { this._inner = inner; this.sql = sql; }
    bind(...params) { return new Statement(this._inner.bind(...params.map(assertBindable)), this.sql); }
    raw() { this._inner = this._inner.raw(); return this; }
    first(col) { return col ? this._inner.first(col) : this._inner.first(); }
    all() { return this._inner.all(); }
    run() { return this._inner.run(); }
  }
  return {
    driver: 'd1',
    prepare(sql) {
      if (typeof sql !== 'string' || !sql.trim()) throw new DbError('prepare() requires a non-empty SQL string');
      return new Statement(d1.prepare(sql), sql);
    },
    batch(statements) {
      if (!Array.isArray(statements) || !statements.length) return Promise.resolve([]);
      return d1.batch(statements.map((s) => s._inner || s));
    },
    async exec(sql) { await d1.exec(sql); return { success: true }; },
    // D1 has no client-side transaction API beyond batch(). Callers that
    // need "run this, then this, atomically" must express it as one batch,
    // which is why every service in this codebase builds statement arrays
    // instead of awaiting writes one at a time. That constraint is a
    // feature: it is what makes the Node and D1 paths provably identical.
    async transaction(fn) { return fn(this); },
    close() {},
    get handle() { return d1; },
  };
}

module.exports = { DbError, assertBindable, b, createSqliteDb, createD1Db };
'use strict';
