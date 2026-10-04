// =====================================================================
// StockRidge — SQL HELPERS
// =====================================================================
// Small utilities that keep the routes free of string-concatenation SQL.
// The one rule: EVERY value is a bound parameter. The only things ever
// interpolated into SQL here are identifiers and fragments this module
// itself produced — never user input.
//
// This matters more than it looks. Filter screens in this product take a
// dozen optional query parameters, and the natural way to write that is
// `sql += " AND name LIKE '%" + q + "%'"`. One such line is a full database
// read for any unauthenticated caller.
// =====================================================================

// Build a WHERE clause from a map of filters. Each entry is either a
// column name (equality) or a raw fragment containing `?` placeholders.
function where(filters) {
  const clauses = [];
  const params = [];
  for (const entry of filters) {
    if (!entry) continue;
    if (entry.sql) { clauses.push(entry.sql); if (entry.params) params.push(...entry.params); }
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    clause: clauses.length ? clauses.join(' AND ') : '',
    params,
    clauses,
  };
}

// Equality filter that drops out entirely when the value is absent, so
// "all branches" and "branch X" are the same query shape.
function eq(column, value, { table = null } = {}) {
  if (value == null || value === '') return null;
  return { sql: `${table ? table + '.' : ''}${column} = ?`, params: [value] };
}

function neq(column, value, { table = null } = {}) {
  if (value == null || value === '') return null;
  return { sql: `${table ? table + '.' : ''}${column} <> ?`, params: [value] };
}

function inList(column, values, { table = null } = {}) {
  const list = Array.isArray(values) ? values.filter((v) => v != null && v !== '') : [];
  if (!list.length) return null;
  // Cap the IN list: D1 and SQLite both degrade badly on thousands of
  // placeholders, and a filter with more than this is a report, not a filter.
  const capped = list.slice(0, 500);
  const col = `${table ? table + '.' : ''}${column}`;
  return { sql: `${col} IN (${capped.map(() => '?').join(',')})`, params: capped };
}

// LIKE filter. Escapes the LIKE metacharacters so a search for "100%" does
// not become a wildcard — and wraps in % only where asked.
function like(column, value, { table = null, prefix = false, suffix = true } = {}) {
  if (value == null || String(value).trim() === '') return null;
  const escaped = String(value).trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `${prefix ? '%' : ''}${escaped}${suffix ? '%' : ''}`;
  const col = `${table ? table + '.' : ''}${column}`;
  // ESCAPE '\' is required for the escaping above to mean anything.
  return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [pattern] };
}

// Free-text search across several columns, used by every list screen's
// search box. One OR group, one escape, one bound value per column.
function search(columns, value, { table = null } = {}) {
  if (value == null || String(value).trim() === '') return null;
  const parts = [];
  const params = [];
  for (const c of columns) {
    const f = like(c, value, { table });
    if (f) { parts.push(f.sql); params.push(...f.params); }
  }
  if (!parts.length) return null;
  return { sql: `(${parts.join(' OR ')})`, params };
}

function gte(column, value, { table = null } = {}) {
  if (value == null || value === '') return null;
  return { sql: `${table ? table + '.' : ''}${column} >= ?`, params: [value] };
}

function lte(column, value, { table = null } = {}) {
  if (value == null || value === '') return null;
  return { sql: `${table ? table + '.' : ''}${column} <= ?`, params: [value] };
}

// Date range on a timestamp column, using WAT day boundaries. The stored
// value is UTC, so '2026-03-14' as a WAT day is the UTC half-open interval
// [2026-03-13 23:00:00, 2026-03-14 23:00:00).
function watDayRange(column, { from, to }, { table = null } = {}) {
  const col = `${table ? table + '.' : ''}${column}`;
  const out = [];
  if (from) out.push({ sql: `${col} >= ?`, params: [`${String(from).slice(0, 10)} 00:00:00`] });
  if (to) out.push({ sql: `${col} < ?`, params: [`${shiftDay(String(to).slice(0, 10), 1)} 00:00:00`] });
  return out;
}

function shiftDay(dateStr, days) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// is_deleted = 0 is on essentially every table and forgetting it once is a
// bug that shows deleted rows in a report. Making it the default is cheaper
// than reviewing for it.
function notDeleted(table = null) {
  return { sql: `${table ? table + '.' : ''}is_deleted = 0`, params: [] };
}

const SOFT_DELETE = notDeleted();

function isTrue(column, value, { table = null } = {}) {
  if (value === true || value === 1 || value === '1' || value === 'true') {
    return { sql: `${table ? table + '.' : ''}${column} = 1`, params: [] };
  }
  if (value === false || value === 0 || value === '0' || value === 'false') {
    return { sql: `${table ? table + '.' : ''}${column} = 0`, params: [] };
  }
  return null;
}

function isNull(column, { table = null } = {}) {
  return { sql: `${table ? table + '.' : ''}${column} IS NULL`, params: [] };
}

function notNull(column, { table = null } = {}) {
  return { sql: `${table ? table + '.' : ''}${column} IS NOT NULL`, params: [] };
}

// ORDER BY with a whitelist. `sort` and `dir` come straight from the query
// string, so they are the two identifiers in the whole codebase that must
// never be interpolated unchecked.
function orderBy(allowed, sort, dir, fallback) {
  const column = allowed.includes(String(sort || '')) ? String(sort) : fallback.column;
  const direction = String(dir || fallback.dir || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return { sql: `ORDER BY ${column} ${direction}`, params: [] };
}

// Pagination with hard caps. An uncapped LIMIT on a table that grows
// forever is how a dashboard becomes a 40-second query and then a timeout.
function limitOffset({ limit, offset, defaultLimit = 50, maxLimit = 500 }) {
  const l = Math.min(maxLimit, Math.max(1, Number(limit) || defaultLimit));
  const o = Math.max(0, Number(offset) || 0);
  return { sql: 'LIMIT ? OFFSET ?', params: [l, o], limit: l, offset: o };
}

// Build an INSERT from a column map. Values are bound; columns come from
// the caller's own literal object keys, never from request input — and to
// make that structurally true, keys are validated against the identifier
// pattern before use.
function insert(table, values) {
  const cols = Object.keys(values);
  for (const c of cols) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(c)) throw new Error(`Refusing to build SQL with column name "${c}"`);
  }
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return { sql, params: cols.map((c) => values[c] === undefined ? null : values[c]), columns: cols };
}

// Build an UPDATE from a column map. Only the keys present are touched, so
// a PATCH-shaped route cannot accidentally null a column it did not mean to.
function update(table, values, whereSql, whereParams) {
  const cols = Object.keys(values);
  if (!cols.length) return null;
  for (const c of cols) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(c)) throw new Error(`Refusing to build SQL with column name "${c}"`);
  }
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} ${whereSql}`;
  return { sql, params: [...cols.map((c) => (values[c] === undefined ? null : values[c])), ...(whereParams || [])] };
}

// Touch updated_at on every mutable write. Soft-delete merge (LWW on
// updated_at) depends on this never being forgotten.
const TOUCH = "updated_at = datetime('now','+1 hour')";

module.exports = {
  where, eq, neq, inList, like, search, gte, lte, watDayRange, shiftDay,
  notDeleted, SOFT_DELETE, isTrue, isNull, notNull, orderBy, limitOffset,
  insert, update, TOUCH,
};
'use strict';
