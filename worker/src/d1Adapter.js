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
    const res = await this.raw().all();
    const rows = (res && Array.isArray(res.results)) ? res.results : [];
    rows.results = rows;
    rows.meta = (res && res.meta) || {};
    rows.success = !!(res && res.success !== false);
    return rows;
  }

  async run() {
    const res = await this.raw().run();
    const meta = (res && res.meta) || {};
    const changes = Number(meta.changes) || 0;
    const lastInsertRowid = Number(meta.last_row_id) || 0;
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
