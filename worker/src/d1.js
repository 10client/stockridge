'use strict';
// =====================================================================
// worker/src/d1.js — THE STORAGE ADAPTER FOR CLOUDFLARE D1
// =====================================================================
// The other half of the seam described in server/lib/db.js. Every service and
// every route is written against six methods; this file implements them with D1
// bindings instead of a SQLite file handle.
//
//   db.first(sql, params)   -> Promise<row | null>
//   db.all(sql, params)     -> Promise<row[]>
//   db.run(sql, params)     -> Promise<{ changes, lastInsertRowid }>
//   db.scalar(sql, params)  -> Promise<first column of the first row>
//   db.exec(sql)            -> Promise          (multi-statement DDL)
//   db.transaction(fn)      -> Promise<value>   (queue-then-execute)
//   db.batch(statements)    -> Promise
//
// WHY TRANSACTIONS ARE A COLLECTOR AND NOT A HANDLE
//
// D1 has no interactive transactions: you cannot BEGIN, await five statements,
// and COMMIT. It CAN execute an array of prepared statements atomically in one
// .batch() call. So a service's transaction callback collects writes on `tx` and
// this adapter commits them as one batch — the same contract the Node adapter
// implements with BEGIN IMMEDIATE.
//
// The constraint that follows is stated in the services themselves: inside a
// transaction you may AWAIT READS and you may QUEUE WRITES, but you may not
// branch on the result of a write. Every flow in this app reads first and writes
// second, which is exactly why that restriction has not bitten.
//
// WHAT IS DELIBERATELY DIFFERENT FROM THE NODE ADAPTER
//
//   * `pragma()` does nothing. D1 refuses user SQL that sets pragmas — notably
//     foreign_keys, which D1 always enforces. On Node the pragma must be set per
//     connection or every REFERENCES clause becomes a comment; here there is
//     nothing to set.
//   * `location` is the D1 database name rather than a file path, and
//     `dialect` is 'd1', which is how a caller (the health endpoint, the seed
//     tool) can tell which backend it is talking to without guessing.
// =====================================================================

const BATCH_LIMIT_WARN = 900;

/** Normalise bound values so INTEGER flags behave identically on both backends. */
function normaliseParams(list) {
  if (list == null) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    return p;
  });
}

/**
 * Re-throw a D1 failure with the statement attached.
 *
 * D1's own errors name the SQL sometimes and the column never, and a failed
 * statement inside a 40-statement batch is indistinguishable from its siblings.
 * The placeholder count is checked here too, because D1 reports "too few
 * parameter values" without saying which statement in the batch it meant — and
 * this exact class of bug (an INSERT with one placeholder more than it has
 * values) shipped twice in this codebase.
 */
function guard(sql, bind, fn) {
  try {
    return fn();
  } catch (e) {
    const list = normaliseParams(bind);
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

/** The queue-and-commit collector, matching server/lib/db.js createCollector(). */
function createCollector(db) {
  const statements = [];
  const ids = new Map();
  let counter = 0;
  return {
    statements,
    queue(sql, bind) { statements.push({ sql, params: normaliseParams(bind) }); return statements.length - 1; },
    idFor(key) {
      const k = String(key);
      if (!ids.has(k)) {
        counter += 1;
        ids.set(k, `${keyPrefix(k)}_${Date.now().toString(36)}${counter.toString(36)}${randomSuffix()}`);
      }
      return ids.get(k);
    },
    peek(key) { return ids.get(String(key)) || null; },
    get count() { return statements.length; },
    // Reads inside a transaction go to the real database, and are awaited by the
    // caller — never queued, because their result is needed to decide what to
    // write next.
    first: (sql, bind) => db.first(sql, bind),
    all: (sql, bind) => db.all(sql, bind),
    scalar: (sql, bind) => db.scalar(sql, bind),
    run: (sql, bind) => db.run(sql, bind),
    get dialect() { return db.dialect; },
  };
}

function keyPrefix(key) {
  const clean = String(key).replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return clean || 'row';
}

function randomSuffix() {
  // Workers has crypto.getRandomValues; the fallback keeps this file runnable
  // under a plain Node require for tests.
  const bytes = new Uint8Array(4);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Wrap a D1 binding in the portable interface.
 *
 * `raw` is the object handed to a Worker as `env.DB`. Nothing here caches
 * prepared statements across requests: a Worker instance can serve concurrent
 * requests, and a statement cached from one is not valid in another.
 */
function createD1Database(raw, { name = null } = {}) {
  if (!raw || typeof raw.prepare !== 'function') {
    throw new Error('createD1Database() was given something that is not a D1 binding. Check the [[d1_databases]] block in wrangler.toml and that the binding is named DB.');
  }

  const api = {
    async first(sql, bind) {
      const stmt = raw.prepare(sql);
      const bound = normaliseParams(bind);
      const row = await guard(sql, bind, () => (bound.length ? stmt.bind(...bound) : stmt).first());
      return row === undefined ? null : row;
    },
    async all(sql, bind) {
      const stmt = raw.prepare(sql);
      const bound = normaliseParams(bind);
      const res = await guard(sql, bind, () => (bound.length ? stmt.bind(...bound) : stmt).all());
      // D1 returns { results, success, meta }. A caller that got an error would
      // have thrown above, so `results` is always an array here.
      return (res && res.results) || [];
    },
    async run(sql, bind) {
      const stmt = raw.prepare(sql);
      const bound = normaliseParams(bind);
      const res = await guard(sql, bind, () => (bound.length ? stmt.bind(...bound) : stmt).run());
      const meta = (res && res.meta) || {};
      return { changes: Number(meta.changes || 0), lastInsertRowid: Number(meta.last_row_id || 0) };
    },
    async scalar(sql, bind) {
      const stmt = raw.prepare(sql);
      const bound = normaliseParams(bind);
      const row = await guard(sql, bind, () => (bound.length ? stmt.bind(...bound) : stmt).first());
      if (!row) return null;
      const values = Object.values(row);
      return values.length ? values[0] : null;
    },
    async exec(sql) {
      // D1's exec() runs multiple statements and returns nothing useful. It is
      // the only way to apply a migration file.
      await raw.exec(String(sql));
      return { ok: true };
    },
    async batch(statements) {
      const list = statements || [];
      if (!list.length) return { ok: true, count: 0 };
      const prepared = list.map((s) => {
        const stmt = raw.prepare(s.sql);
        const bound = normaliseParams(s.params);
        return bound.length ? stmt.bind(...bound) : stmt;
      });
      try {
        await raw.batch(prepared);
      } catch (e) {
        // A batch failure says which statement by position, which is the only
        // thing that makes a 40-write sale debuggable.
        const index = Number((String(e.message).match(/statement\s+(\d+)/i) || [])[1]);
        const failing = Number.isFinite(index) && list[index - 1] ? list[index - 1] : null;
        const wrapped = Object.assign(
          new Error(failing
            ? `${e.message} (batch statement ${index} of ${list.length}: ${String(failing.sql).replace(/\s+/g, ' ').slice(0, 140)})`
            : e.message, { cause: e }),
          { code: e.code, batchIndex: Number.isFinite(index) ? index : null, batchLength: list.length },
        );
        throw wrapped;
      }
      return { ok: true, count: list.length };
    },
    async transaction(fn) {
      const tx = createCollector(api);
      const value = await fn(tx);
      if (!tx.statements.length) return value;
      if (tx.statements.length > BATCH_LIMIT_WARN) {
        // Not an error: D1 allows large batches. It is a warning because a
        // transaction this size is usually a loop that should have been a
        // single statement, and it is worth knowing before it meets a limit.
        console.warn(`[d1] committing a transaction of ${tx.statements.length} statements`);
      }
      await api.batch(tx.statements);
      return value;
    },
    pragma() { return null; },
    async close() { /* D1 connections are managed by the platform */ },
    get raw() { return raw; },
    get location() { return name; },
    get stats() { return { hits: 0, misses: 0, cached: 0 }; },
    get dialect() { return 'd1'; },
  };

  return api;
}

module.exports = { createD1Database, createCollector, normaliseParams, guard };
