'use strict';
// =====================================================================
// tools/turso-admin.js — SCHEMA AND A ONE-TIME COPY ONTO TURSO
// =====================================================================
// The Worker reads Turso at request time. This tool is what puts the schema
// there, and what copies an existing D1 database across once. It is not part
// of a later deploy: after the cutover, D1 is stale, and copying it again
// would overwrite records the shop has written to Turso.
//
// The token is read from the environment or from .env.deploy. It is never
// printed.
// =====================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTursoDatabase, splitSql } = require('../worker/src/turso');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'schema', 'migrations');

function loadEnvFile() {
  const file = path.join(ROOT, '.env.deploy');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key]) continue;
    const value = raw.replace(/^["']|["']$/g, '');
    if (value) process.env[key] = value;
  }
}

loadEnvFile();

function tursoDb() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required. Put them in .env.deploy. Do not commit the token.');
  }
  return createTursoDatabase({ url, authToken, name: 'stockridge-10client' });
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/**
 * A multi-row INSERT larger than Turso's comfortable request size is split
 * into several INSERTs of the same statement. Quotes and nested parentheses
 * are respected, so a product name that contains a comma stays in its tuple.
 */
function splitLargeInsert(sql, maxBytes = 350000) {
  if (sql.length <= maxBytes) return [sql];
  const valuesAt = sql.search(/\bVALUES\b/i);
  if (valuesAt < 0) return [sql];
  const prefix = sql.slice(0, valuesAt).replace(/\s+$/, '');
  let rest = sql.slice(valuesAt).replace(/^VALUES/i, '').trim().replace(/;\s*$/, '');
  const tuples = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /[\s,]/.test(rest[i])) i += 1;
    if (i >= rest.length) break;
    if (rest[i] !== '(') break;
    let depth = 0;
    let state = 'normal';
    const start = i;
    while (i < rest.length) {
      const c = rest[i];
      const n = rest[i + 1];
      if (state === 'sq') {
        if (c === "'" && n === "'") { i += 2; continue; }
        if (c === "'") state = 'normal';
        i += 1;
        continue;
      }
      if (c === "'") { state = 'sq'; i += 1; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) { i += 1; break; }
      }
      i += 1;
    }
    tuples.push(rest.slice(start, i));
  }
  if (tuples.length < 2) return [sql];
  const chunks = [];
  let current = [];
  let size = prefix.length + 8;
  for (const tuple of tuples) {
    if (current.length && size + tuple.length + 2 > maxBytes) {
      chunks.push(`${prefix} VALUES\n${current.join(',\n')};`);
      current = [];
      size = prefix.length + 8;
    }
    current.push(tuple);
    size += tuple.length + 2;
  }
  if (current.length) chunks.push(`${prefix} VALUES\n${current.join(',\n')};`);
  return chunks;
}

async function applyTursoMigrations(db = tursoDb()) {
  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    checksum    TEXT
  )`);
  const applied = new Map((await db.all('SELECT id, checksum FROM _migrations')).map((r) => [r.id, r.checksum]));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const result = { applied: [], skipped: [] };
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const sum = checksum(sql);
    if (applied.has(id)) {
      if (applied.get(id) && applied.get(id) !== sum) {
        throw new Error(`Migration "${id}" has CHANGED since it was applied. Never edit an applied migration — add a new one.`);
      }
      result.skipped.push(id);
      continue;
    }
    const statements = splitSql(sql).flatMap((statement) => splitLargeInsert(statement));
    // A table rebuild cannot drop a referenced table while foreign keys are on.
    // The marker is a comment, so it is not itself a statement.
    const rebuild = /turso:\s*foreign_keys\s+off/i.test(sql);
    if (rebuild) {
      const body = statements.filter((statement) => {
        const bare = statement.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim();
        return bare && !/^\s*PRAGMA\b/i.test(bare);
      });
      process.stdout.write(`      ${id} (rebuild, ${body.length} statement(s), foreign keys off)\n`);
      await db.batch(body.map((statement) => ({ sql: statement })), { foreignKeys: false, timeoutMs: 60000 });
    } else {
      process.stdout.write(`      ${id} (${statements.length} statement(s))\n`);
      for (let i = 0; i < statements.length; i += 1) {
        const statement = statements[i];
        const timeoutMs = statement.length > 200000 ? 120000 : 30000;
        await db.pipeline([{ sql: statement }], { timeoutMs });
        if (statements.length > 5 && (i + 1) % 10 === 0) {
          process.stdout.write(`        ${i + 1}/${statements.length}\n`);
        }
      }
    }
    await db.run('INSERT INTO _migrations (id, checksum) VALUES (?, ?)', [id, sum]);
    result.applied.push(id);
  }
  return result;
}

async function cfQuery(sql, params = []) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.D1_DATABASE_ID || 'fd72e95b-c0c8-4073-8aba-d3ca5919b107';
  if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to read D1.');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    const message = JSON.stringify(json.errors || json).slice(0, 400);
    throw new Error(`D1 query failed: ${message}`);
  }
  const block = (json.result && json.result[0]) || {};
  return block.results || [];
}

const SKIP_TABLES = new Set([
  '_migrations', 'd1_migrations', 'sqlite_sequence', '__turso_internal_mvcc_meta',
]);

function typedValue(value, declared) {
  if (value == null) return null;
  const kind = String(declared || '');
  const real = /REAL|FLOA|DOUB|NUM|DEC/.test(kind);
  const integer = /INT|BOOL/.test(kind) && !real;
  if (!real && !integer) return value;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return value;
  if (real) return { type: 'float', value: n };
  return { type: 'integer', value: Math.trunc(n) };
}

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe table or column name: ${name}`);
  return `"${name}"`;
}

async function copyFromD1(db = tursoDb()) {
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const summary = [];
  for (const table of tables) {
    const name = table.name;
    if (SKIP_TABLES.has(name)) continue;
    const info = await db.all(`PRAGMA table_info(${quoteIdent(name)})`);
    const columns = info.map((c) => c.name);
    const types = new Map(info.map((c) => [c.name, String(c.type || '').toUpperCase()]));
    if (!columns.length) continue;
    let sourceCount = 0;
    try {
      const counted = await cfQuery(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`);
      sourceCount = Number(counted[0] && counted[0].n) || 0;
    } catch (err) {
      summary.push({ table: name, copied: 0, note: `not in D1 (${err.message.slice(0, 80)})` });
      continue;
    }
    if (!sourceCount) {
      summary.push({ table: name, copied: 0 });
      continue;
    }
    // Foreign keys off for this connection only, so a child row can land
    // before the table that owns it. The next request turns them back on.
    await db.pipeline([{ sql: 'PRAGMA foreign_keys = OFF' }, { sql: `DELETE FROM ${quoteIdent(name)}` }], { foreignKeys: false });
    const colSql = columns.map(quoteIdent).join(', ');
    const pageSize = 40;
    let copied = 0;
    for (let offset = 0; offset < sourceCount; offset += pageSize) {
      const rows = await cfQuery(
        `SELECT ${colSql} FROM ${quoteIdent(name)} LIMIT ${pageSize} OFFSET ${offset}`,
      );
      if (!rows.length) break;
      const placeholders = `(${columns.map(() => '?').join(', ')})`;
      const sql = `INSERT INTO ${quoteIdent(name)} (${colSql}) VALUES ${rows.map(() => placeholders).join(', ')}`;
      const args = [];
      for (const row of rows) {
        for (const column of columns) args.push(typedValue(row[column], types.get(column)));
      }
      await db.pipeline([{ sql, args }], { foreignKeys: false, timeoutMs: 60000 });
      copied += rows.length;
    }
    summary.push({ table: name, copied, source: sourceCount });
    process.stdout.write(`      ${name}: ${copied}\n`);
  }
  return summary;
}

async function counts(db = tursoDb()) {
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out = [];
  for (const table of tables) {
    if (SKIP_TABLES.has(table.name)) continue;
    const n = await db.scalar(`SELECT COUNT(*) FROM ${quoteIdent(table.name)}`);
    if (Number(n)) out.push({ table: table.name, rows: Number(n) });
  }
  return out;
}

async function main() {
  const command = process.argv[2] || 'migrate';
  const db = tursoDb();
  if (command === 'migrate') {
    const result = await applyTursoMigrations(db);
    console.log(JSON.stringify({ applied: result.applied, skipped: result.skipped.length }));
    return;
  }
  if (command === 'copy-from-d1') {
    const summary = await copyFromD1(db);
    const copied = summary.reduce((n, row) => n + (row.copied || 0), 0);
    console.log(JSON.stringify({ tables: summary.filter((row) => row.copied || row.note).length, rows: copied }));
    return;
  }
  if (command === 'counts') {
    const rows = await counts(db);
    for (const row of rows) console.log(`${row.table}\t${row.rows}`);
    return;
  }
  if (command === 'probe') {
    const probe = await db.scalar('SELECT 1');
    const migrations = await db.scalar('SELECT COUNT(*) FROM _migrations').catch(() => null);
    console.log(JSON.stringify({ probe, migrations, dialect: db.dialect, location: db.location }));
    return;
  }
  throw new Error(`Unknown command ${command}`);
}

module.exports = { applyTursoMigrations, copyFromD1, counts };

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
