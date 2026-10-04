// =====================================================================
// worker/src/d1Adapter.js — the SAME data interface, over D1
// =====================================================================
//
// THIS FILE IS THE ENTIRE ARGUMENT FOR THE ADAPTER DESIGN.
//
// server/db/adapter.js exposes a D1-shaped async API over better-sqlite3 and
// sql.js. This file exposes the identical API over Cloudflare D1. Because the
// shapes match, shared/services/* — salesService, glService, coreService and
// every domain module — is loaded by BOTH backends with no changes at all.
//
// The pharmacy product this was decoupled from kept two parallel trees and
// described one of them as "a Cloudflare D1 port ... kept deliberately parallel
// in structure/wording to the Node version so the two backends are easy to audit
// side by side". Parallel-by-discipline. Its own audit log then recorded what
// that discipline costs: a documented parity gap where the Node backend pruned
// sync_change_log on a schedule and the Worker never did, found only when
// somebody went looking.
//
// There is nothing to keep in parity here, because there is only one copy of the
// business logic. What D1 already provides — prepare().bind().first()/.all()/.
// run(), and batch() — is the interface the services were written against, so
// this file is thin by construction rather than thin by effort.
//
// The two behaviours that DO need care:
//
//   1. D1's run() returns `{ success, meta: { changes, duration, rows_read,
//      rows_written, last_row_id } }`. The Node adapter returns the same fields
//      at the TOP LEVEL as well as under `meta`, because a caller reading
//      `result.changes` against one backend and `result.meta.changes` against the
//      other is how a stock-decrement guard silently concludes that zero rows
//      were written. Both shapes are populated here too.
//
//   2. D1 has no interactive transaction. `batch()` runs an array of statements
//      atomically, and that is the only atomicity primitive available. The Node
//      adapter's transaction() therefore accepts a function and this one accepts
//      the same function, but the Worker executes the statements the function
//      QUEUED rather than interleaving them — see transaction() below for what
//      that means for service code.

'use strict';

/** Wrap a D1Database so it presents the exact interface the Node adapter does. */
export function wrapD1(d1) {
  return {
    driverName: 'd1',
    impl: d1,
    filePath: null,

    prepare(sql) {
      return new D1Statement(d1, sql);
    },

    /** Execute several prepared statements atomically. */
    async batch(statements) {
      const prepared = (statements || []).map((s) => (typeof s === 'string' ? d1.prepare(s) : s.raw()));
      return d1.batch(prepared);
    },

    /**
     * Run `fn` atomically.
     *
     * D1 cannot interleave reads and writes inside one transaction the way
     * better-sqlite3 can: `batch()` is fire-and-forget over a list. So the
     * function receives a COLLECTING handle whose statements are gathered and
     * then executed as one batch.
     *
     * The consequence matters and is not hidden: a service that READS inside a
     * transaction and then branches on what it read will not work here, because
     * the reads have not executed yet. Every transactional write path in
     * shared/services is written to do its reading BEFORE opening the
     * transaction and only write inside it — which is also better practice on the
     * Node side, because it shortens the window a write lock is held. The
     * collector throws if a read is attempted inside a transaction, so a future
     * service that breaks the rule fails loudly in development rather than
     * silently misbehaving in production.
     */
    async transaction(fn) {
      const queued = [];
      const collector = {
        driverName: 'd1',
        prepare(sql) {
          return {
            bind(...values) {
              const params = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
              const stmt = d1.prepare(sql).bind(...params.map(normaliseParam));
              return {
                run() { queued.push(stmt); return Promise.resolve({ success: true, changes: null, meta: { changes: null } }); },
                first() { throw new TransactionReadError(sql); },
                all() { throw new TransactionReadError(sql); },
                raw() { return stmt; },
              };
            },
          };
        },
        // Multi-statement scripts (migrations) cannot be batched; they run
        // directly. Only used by tooling, never inside a service.
        execScript(sql) { return d1.batch(sql.split(/;\s*\n/).filter((x) => x.trim()).map((x) => d1.prepare(x))); },
      };
      await fn(collector);
      if (!queued.length) return undefined;
      return d1.batch(queued);
    },

    flush() { /* D1 is durable on write; nothing to do. */ },
    close() { /* nothing to close. */ },

    info() {
      return { driver: 'd1', sqliteVersion: null, pageSize: null, journalMode: 'd1', file: null };
    },
  };
}

class TransactionReadError extends Error {
  constructor(sql) {
    super(
      'A READ was attempted inside a transaction. Cloudflare D1 cannot interleave reads and writes '
      + 'inside one atomic batch, so reads inside a transaction are refused on BOTH backends to keep '
      + 'them identical. Read before opening the transaction.\n'
      + `Statement: ${String(sql).slice(0, 160)}`
    );
    this.name = 'TransactionReadError';
    this.code = 'READ_INSIDE_TRANSACTION';
  }
}

/**
 * Bind-value normalisation, matching the Node adapter exactly.
 *
 * `undefined` is REJECTED on both backends. D1 silently coerces it to NULL and
 * better-sqlite3 throws — two behaviours for the same mistake, and the D1 one is
 * worse because a field the caller forgot to set becomes a NULL in the database
 * instead of an error. A product's reorder level silently becoming NULL means it
 * stops appearing on the low-stock report, and nobody notices for a month.
 */
function normaliseParam(v) {
  if (v === undefined) {
    throw new TypeError(
      'Cannot bind `undefined` to a SQL parameter. Pass null to store NULL, or omit the field.'
    );
  }
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new TypeError(`Cannot bind a non-finite number (${v}) to a SQL parameter.`);
  }
  return v;
}

class D1Statement {
  constructor(d1, sql) {
    this.d1 = d1;
    this.sql = sql;
    this.params = [];
  }

  bind(...values) {
    const flat = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
    this.params = flat.map(normaliseParam);
    return this;
  }

  /** The underlying D1PreparedStatement, for batch(). */
  raw() {
    return this.d1.prepare(this.sql).bind(...this.params);
  }

  async first(...cols) {
    const row = await this.raw().first();
    if (!row) return null;
    if (cols && cols.length) return cols.length === 1 ? row[cols[0]] : cols.map((c) => row[c]);
    return row;
  }

  async all() {
    return this.raw().all();
  }

  async run() {
    const res = await this.raw().run();
    const meta = (res && res.meta) || {};
    const changes = Number(meta.changes) || 0;
    const lastInsertRowid = Number(meta.last_row_id) || 0;
    // Both shapes, from the same numbers. See the header comment for why.
    return {
      success: !!(res && res.success !== false),
      changes,
      lastInsertRowid,
      meta: {
        changes,
        last_row_id: lastInsertRowid,
        duration: meta.duration || 0,
        rows_read: meta.rows_read || 0,
        rows_written: meta.rows_written || 0,
      },
    };
  }

  async changes() {
    const r = await this.run();
    return Number(r.changes) || 0;
  }
}

export { normaliseParam, TransactionReadError };
export default wrapD1;
