'use strict';
// =====================================================================
// worker/src/turso.js — THE STORAGE ADAPTER FOR TURSO
// =====================================================================
// Same six methods as worker/src/d1.js, so the shared route table does not
// know which database it is talking to. Turso is reached over HTTPS
// (libSQL's /v2/pipeline), which is what a Cloudflare Worker can do: there
// is no native SQLite in that runtime, and there is no second copy of any
// query in this file.
//
// A pipeline is one connection. Foreign keys default to OFF on that
// connection, unlike D1, which always enforces them. Every pipeline
// therefore starts with `PRAGMA foreign_keys = ON` before any statement
// the application wrote. A batch begins a transaction, sends the writes,
// and only then commits — on a second request. Turso keeps executing a
// pipeline after a statement fails, so a COMMIT in the same request would
// keep the writes that landed before the failure.
//
// The auth token is a Worker secret. This file never logs it.
// =====================================================================

const BATCH_LIMIT_WARN = 900;

function normaliseParams(list) {
  if (list == null) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    return p;
  });
}

function httpUrl(url) {
  let value = String(url || '').trim();
  value = value.replace(/^turso:\/\//i, 'https://').replace(/^libsql:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, '');
}

function hostOf(url) {
  try { return new URL(httpUrl(url)).host; } catch (e) { return 'turso'; }
}

function encodeArg(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) && !(value instanceof Uint8Array) && value.type) {
    if (value.type === 'null') return { type: 'null' };
    if (value.type === 'blob') return { type: 'blob', base64: value.base64 };
    if (value.type === 'text') return { type: 'text', value: String(value.value) };
    if (value.type === 'integer') return { type: 'integer', value: String(value.value) };
    // This Turso endpoint rejects a float whose value is a string. Integers
    // stay strings so a large id cannot lose precision in JSON.
    if (value.type === 'float') return { type: 'float', value: Number(value.value) };
  }
  if (value == null) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { type: 'null' };
    if (Number.isInteger(value)) return { type: 'integer', value: String(value) };
    return { type: 'float', value };
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { type: 'blob', base64: value.toString('base64') };
  }
  if (value instanceof Uint8Array) {
    return { type: 'blob', base64: bytesToBase64(value) };
  }
  return { type: 'text', value: String(value) };
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function decodeCell(cell) {
  if (!cell || cell.type === 'null' || cell.type == null) return null;
  if (cell.type === 'integer') {
    const n = Number(cell.value);
    return Number.isSafeInteger(n) ? n : cell.value;
  }
  if (cell.type === 'float') return Number(cell.value);
  if (cell.type === 'blob') return cell.base64 || null;
  return cell.value == null ? null : cell.value;
}

function decodeRows(result) {
  const cols = (result && result.cols) || [];
  const rows = (result && result.rows) || [];
  return rows.map((row) => {
    const obj = {};
    for (let i = 0; i < cols.length; i += 1) obj[cols[i].name] = decodeCell(row[i]);
    return obj;
  });
}

function errorMessage(item) {
  if (!item) return 'Turso returned no result for a statement.';
  const err = item.error || (item.response && item.response.error) || item;
  if (typeof err === 'string') return err;
  return err.message || err.code || JSON.stringify(err).slice(0, 300);
}

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
    throw Object.assign(
      new Error(`${e.message}${detail} Statement: ${head}`, { cause: e }),
      { code: e.code, sql: String(sql), paramCount: list.length, placeholderCount: placeholders },
    );
  }
}

/**
 * Split a migration file into statements.
 *
 * Semicolons inside quotes, comments, or a BEGIN/END block (the bill-hold
 * trigger) are not boundaries. CASE/END is not a block: only BEGIN raises
 * the depth, so a view's `END AS` does not swallow the next statement.
 */
function splitSql(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let state = 'normal';
  let depth = 0;
  const text = String(sql || '');
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state === 'line') {
      buf += c;
      if (c === '\n') state = 'normal';
      i += 1;
      continue;
    }
    if (state === 'block') {
      buf += c;
      if (c === '*' && n === '/') { buf += n; i += 2; state = 'normal'; continue; }
      i += 1;
      continue;
    }
    if (state === 'sq') {
      buf += c;
      if (c === "'" && n === "'") { buf += n; i += 2; continue; }
      if (c === "'") state = 'normal';
      i += 1;
      continue;
    }
    if (state === 'dq') {
      buf += c;
      if (c === '"' && n === '"') { buf += n; i += 2; continue; }
      if (c === '"') state = 'normal';
      i += 1;
      continue;
    }
    if (c === '-' && n === '-') { state = 'line'; buf += c; i += 1; continue; }
    if (c === '/' && n === '*') { state = 'block'; buf += c; i += 1; continue; }
    if (c === "'") { state = 'sq'; buf += c; i += 1; continue; }
    if (c === '"') { state = 'dq'; buf += c; i += 1; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      if (/^begin$/i.test(word)) depth += 1;
      else if (/^end$/i.test(word) && depth > 0) depth -= 1;
      buf += word;
      i = j;
      continue;
    }
    if (c === ';' && depth === 0) {
      const stmt = buf.trim();
      if (executableSql(stmt)) out.push(stmt);
      buf = '';
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  const tail = buf.trim();
  if (executableSql(tail)) out.push(tail);
  return out;
}

function executableSql(stmt) {
  if (!stmt) return '';
  return stmt
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim();
}

function keyPrefix(key) {
  const clean = String(key).replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return clean || 'row';
}

function randomSuffix() {
  const bytes = new Uint8Array(4);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

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
    // Reads inside a transaction go to the database as it is, not to the
    // queued writes. That is the same restriction D1 imposes, and every
    // service already reads first and writes second.
    first: (sql, bind) => db.first(sql, bind),
    all: (sql, bind) => db.all(sql, bind),
    scalar: (sql, bind) => db.scalar(sql, bind),
    run: (sql, bind) => db.run(sql, bind),
    get dialect() { return db.dialect; },
  };
}

function createTursoDatabase({ url, authToken, name = null } = {}) {
  if (!url) throw new Error('createTursoDatabase() needs a database URL.');
  if (!authToken) throw new Error('createTursoDatabase() needs an auth token. Set it with wrangler secret put TURSO_AUTH_TOKEN — do not put it in wrangler.toml.');
  const endpoint = `${httpUrl(url)}/v2/pipeline`;
  const location = name || hostOf(url);

  function requestBody(requests, baton) {
    const body = { requests };
    if (baton) body.baton = baton;
    return body;
  }

  async function post(requests, { timeoutMs = 30000, baton = null } = {}) {
    const init = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody(requests, baton)),
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(timeoutMs);
    }
    let res;
    try {
      res = await fetch(endpoint, init);
    } catch (e) {
      throw new Error(`Turso could not be reached: ${e.message}`);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!res.ok) {
      const message = (json && (json.error || json.message)) || text.slice(0, 300) || `HTTP ${res.status}`;
      throw new Error(`Turso refused the request (${res.status}): ${typeof message === 'string' ? message : JSON.stringify(message).slice(0, 300)}`);
    }
    return json || { results: [] };
  }

  function statementRequest(statement) {
    const stmt = { sql: statement.sql };
    const args = normaliseParams(statement.args || statement.params);
    if (args.length) stmt.args = args.map(encodeArg);
    return { type: 'execute', stmt };
  }

  /**
   * One pipeline, then close. Used for a single statement. Not atomic across
   * statements: Turso keeps executing the pipeline after an error, so a
   * COMMIT later in the same request would keep the earlier writes.
   */
  async function pipeline(statements, { foreignKeys = true, timeoutMs = 30000 } = {}) {
    const requests = [];
    if (foreignKeys) requests.push({ type: 'execute', stmt: { sql: 'PRAGMA foreign_keys = ON' } });
    for (const statement of statements) requests.push(statementRequest(statement));
    requests.push({ type: 'close' });
    const json = await post(requests, { timeoutMs });
    const results = json.results || [];
    const offset = foreignKeys ? 1 : 0;
    if (foreignKeys && results[0] && results[0].type === 'error') {
      throw new Error(`Turso could not enable foreign keys: ${errorMessage(results[0])}`);
    }
    const out = [];
    for (let i = 0; i < statements.length; i += 1) {
      const item = results[i + offset];
      if (!item || item.type === 'error') {
        const head = String(statements[i].sql).replace(/\s+/g, ' ').trim().slice(0, 140);
        throw Object.assign(
          new Error(`${errorMessage(item)} (statement ${i + 1} of ${statements.length}: ${head})`),
          { batchIndex: i + 1, batchLength: statements.length, sql: statements[i].sql },
        );
      }
      out.push((item.response && item.response.result) || {});
    }
    return out;
  }

  /**
   * BEGIN, the writes, then COMMIT on the same connection.
   *
   * COMMIT is a second request. Putting it in the first pipeline is wrong:
   * Turso does not stop the pipeline when a statement fails, so the COMMIT
   * would keep every write that landed before the failure. If any statement
   * fails, the follow-up is ROLLBACK, and closing an open transaction rolls
   * it back as well.
   */
  async function atomic(statements, { timeoutMs = 30000 } = {}) {
    const requests = [
      { type: 'execute', stmt: { sql: 'PRAGMA foreign_keys = ON' } },
      { type: 'execute', stmt: { sql: 'BEGIN' } },
      ...statements.map(statementRequest),
    ];
    const json = await post(requests, { timeoutMs });
    const results = json.results || [];
    let failure = null;
    if (results[0] && results[0].type === 'error') failure = `Turso could not enable foreign keys: ${errorMessage(results[0])}`;
    else if (results[1] && results[1].type === 'error') failure = `Turso could not begin a transaction: ${errorMessage(results[1])}`;
    else {
      for (let i = 0; i < statements.length; i += 1) {
        const item = results[i + 2];
        if (!item || item.type === 'error') {
          const head = String(statements[i].sql).replace(/\s+/g, ' ').trim().slice(0, 140);
          failure = `${errorMessage(item)} (statement ${i + 1} of ${statements.length}: ${head})`;
          break;
        }
      }
    }
    const baton = json.baton || null;
    if (baton) {
      try {
        await post([
          { type: 'execute', stmt: { sql: failure ? 'ROLLBACK' : 'COMMIT' } },
          { type: 'close' },
        ], { baton, timeoutMs: 15000 });
      } catch (err) {
        if (!failure) throw err;
      }
    }
    if (failure) {
      throw Object.assign(new Error(failure), { batchLength: statements.length });
    }
    if (!baton) throw new Error('Turso did not keep the transaction open, so it was not committed.');
    return { ok: true, count: statements.length };
  }

  const api = {
    async first(sql, bind) {
      return guard(sql, bind, async () => {
        const [result] = await pipeline([{ sql, args: bind }]);
        const rows = decodeRows(result);
        return rows.length ? rows[0] : null;
      });
    },
    async all(sql, bind) {
      return guard(sql, bind, async () => {
        const [result] = await pipeline([{ sql, args: bind }]);
        return decodeRows(result);
      });
    },
    async run(sql, bind) {
      return guard(sql, bind, async () => {
        const [result] = await pipeline([{ sql, args: bind }]);
        const rowid = result && result.last_insert_rowid;
        const n = rowid == null ? 0 : Number(rowid);
        return {
          changes: Number((result && result.affected_row_count) || 0),
          lastInsertRowid: Number.isSafeInteger(n) ? n : (rowid || 0),
        };
      });
    },
    async scalar(sql, bind) {
      const row = await api.first(sql, bind);
      if (!row) return null;
      const values = Object.values(row);
      return values.length ? values[0] : null;
    },
    async exec(sql) {
      const statements = splitSql(sql);
      for (const statement of statements) {
        const timeoutMs = statement.length > 200000 ? 120000 : 30000;
        await pipeline([{ sql: statement }], { timeoutMs });
      }
      return { ok: true, count: statements.length };
    },
    async batch(statements) {
      const list = statements || [];
      if (!list.length) return { ok: true, count: 0 };
      if (list.length > BATCH_LIMIT_WARN) {
        console.warn(`[turso] committing a transaction of ${list.length} statements`);
      }
      return atomic(list, { timeoutMs: Math.min(120000, 15000 + list.length * 200) });
    },
    async transaction(fn) {
      const tx = createCollector(api);
      const value = await fn(tx);
      if (!tx.statements.length) return value;
      await api.batch(tx.statements);
      return value;
    },
    pipeline,
    pragma() { return null; },
    async close() { /* each pipeline closes its own connection */ },
    get raw() { return null; },
    get location() { return location; },
    get stats() { return { hits: 0, misses: 0, cached: 0 }; },
    get dialect() { return 'turso'; },
    splitSql,
  };

  return api;
}

module.exports = { createTursoDatabase, splitSql, httpUrl };
