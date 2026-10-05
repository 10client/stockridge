'use strict';
// =====================================================================
// domain/hashChain.js — APPEND-ONLY, TAMPER-EVIDENT RECORD CHAINS
// =====================================================================
// WHY A HASH CHAIN AND NOT JUST AN AUDIT TABLE
//
// A plain append-only audit table is only tamper-evident if nobody can
// UPDATE or DELETE from it. In SQLite on a shared database, the application
// user typically can. A hash chain makes an edit DETECTABLE without
// requiring that it be impossible:
//
//   row_hash = SHA-256(prev_hash || canonical(payload))
//
// Editing any field of any row invalidates that row's hash and therefore
// every row after it. Deleting a middle row breaks the link. The chain can
// be re-verified at any time from its first row, and the result is a
// yes/no answer to "has this register been altered since it was written?"
//
// The schema adds a UNIQUE index on (chain_scope, prev_hash). That makes a
// FORK impossible to insert: two rows claiming the same predecessor violate
// the index, so an attacker who wants to insert a fabricated row must also
// rewrite everything after it — which changes the head hash, which is the
// thing a reviewer compares against.
//
// WHAT THIS DOES NOT DO, stated plainly: it does not prevent a sufficiently
// determined actor with database write access from recomputing the entire
// chain. Defending against that needs an externally-anchored head hash
// (a periodic commitment published somewhere the actor cannot also write).
// The `anchor` helpers below exist for exactly that, and the cron job
// publishes the head; without the external publication step this is
// tamper-EVIDENT, not tamper-PROOF. Overstating the guarantee would be
// worse than not making it.
//
// Carried across from PharmaRidge's controlled_substance_register and
// applied to: serial_events (an appliance's identity chain) and audit_log
// (every privileged action).
// =====================================================================

const { canonicalJson, sha256Hex, sha256HexSync } = require('./crypto');

const GENESIS_PREV_HASH = 'GENESIS';

/**
 * The fields that go into a row's hash.
 *
 * DELIBERATELY EXCLUDES: created_at/updated_at (a re-write of the clock is
 * not the threat being modelled, and including a DB-default timestamp makes
 * the hash unreproducible from application data alone), and any column that
 * is allowed to change after insert.
 *
 * INCLUDES the actor and the substantive payload, because those are the
 * facts a reviewer cares about: who did what, to which entity, when they
 * said they did it.
 */
function chainPayload(fields) {
  const out = {};
  for (const key of Object.keys(fields || {}).sort()) {
    const value = fields[key];
    if (value === undefined) continue;
    out[key] = value === null ? null : (typeof value === 'object' ? canonicalJson(value) : String(value));
  }
  return out;
}

/** Compute a row hash. `prevHash` is GENESIS_PREV_HASH for a chain's first row. */
async function computeRowHash(prevHash, fields) {
  const payload = canonicalJson(chainPayload(fields));
  return sha256Hex(`${String(prevHash || GENESIS_PREV_HASH)}|${payload}`);
}

function computeRowHashSync(prevHash, fields) {
  const payload = canonicalJson(chainPayload(fields));
  return sha256HexSync(`${String(prevHash || GENESIS_PREV_HASH)}|${payload}`);
}

/**
 * Fetch the current head hash for a chain scope.
 *
 * `scopeColumn` partitions the chain — serial_events chains per serial_no
 * (so one serial's history is independently verifiable without reading the
 * whole table), audit_log chains globally per deployment.
 */
async function headHash(db, { table, scopeColumn = null, scopeValue = null, hashColumn = 'row_hash', prevColumn = 'prev_hash' }) {
  const where = [];
  const params = [];
  if (scopeColumn) { where.push(`${scopeColumn} = ?`); params.push(String(scopeValue)); }
  const sql = `SELECT ${hashColumn} AS h, ${prevColumn} AS p, id FROM ${table}`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ` ORDER BY created_at DESC, rowid DESC LIMIT 1`;
  const row = await db.first(sql, params);
  return row ? { hash: row.h, prev: row.p, id: row.id } : { hash: GENESIS_PREV_HASH, prev: null, id: null };
}

/**
 * Append a chained row. Returns the inserted row's hash so the caller can
 * pass it on within the same transaction (a bulk goods-received of 50
 * serials is one chain walk, not 50 independent lookups).
 */
async function appendChained(db, {
  table, columns, values, scopeColumn = null, scopeValue = null,
  hashFields, prevHash = null, hashColumn = 'row_hash', prevColumn = 'prev_hash',
}) {
  const prev = prevHash != null
    ? { hash: prevHash }
    : await headHash(db, { table, scopeColumn, scopeValue, hashColumn, prevColumn });

  const rowHash = await computeRowHash(prev.hash, hashFields);
  const allColumns = [...columns, prevColumn, hashColumn];
  const allValues = [...values, prev.hash === GENESIS_PREV_HASH ? null : prev.hash, rowHash];

  const placeholders = allValues.map(() => '?').join(', ');
  await db.run(
    `INSERT INTO ${table} (${allColumns.join(', ')}) VALUES (${placeholders})`,
    allValues,
  );
  return { rowHash, prevHash: prev.hash === GENESIS_PREV_HASH ? null : prev.hash };
}

/**
 * Verify a whole chain. Returns the first break found, or ok.
 *
 * `expectedFieldBuilder` maps a stored row back to the fields that were
 * hashed, because the stored row has extra columns (created_at, the hash
 * itself) that were not part of the input. Without it a verifier would have
 * to duplicate the writer's field list — and a duplicated list is a list
 * that drifts.
 */
async function verifyChain(db, {
  table, scopeColumn = null, scopeValue = null,
  hashColumn = 'row_hash', prevColumn = 'prev_hash', expectedFieldBuilder,
}) {
  const where = [];
  const params = [];
  if (scopeColumn) { where.push(`${scopeColumn} = ?`); params.push(String(scopeValue)); }
  const rows = await db.all(
    `SELECT * FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, rowid ASC`,
    params,
  );

  let expectedPrev = null;
  const problems = [];
  for (const row of rows) {
    const storedPrev = row[prevColumn] || null;
    if (storedPrev !== expectedPrev) {
      problems.push({
        id: row.id, type: 'BROKEN_LINK',
        detail: `expected prev_hash ${expectedPrev === null ? 'NULL (genesis)' : expectedPrev.slice(0, 12) + '…'} but found ${storedPrev === null ? 'NULL' : String(storedPrev).slice(0, 12) + '…'}`,
      });
      // Continue: one break does not tell us how many rows were altered.
    }
    const recomputed = await computeRowHash(storedPrev || GENESIS_PREV_HASH, expectedFieldBuilder(row));
    if (recomputed !== row[hashColumn]) {
      problems.push({
        id: row.id, type: 'HASH_MISMATCH',
        detail: `stored ${String(row[hashColumn]).slice(0, 12)}… recomputed ${recomputed.slice(0, 12)}…`,
      });
    }
    expectedPrev = row[hashColumn];
  }

  // Detect a fork: two rows claiming the same predecessor. The UNIQUE index
  // makes this impossible to INSERT, but verifying it means the report can
  // say so honestly rather than assuming the index exists.
  const seenPrev = new Map();
  for (const row of rows) {
    const key = String(row[prevColumn] || 'NULL');
    if (seenPrev.has(key)) {
      problems.push({ id: row.id, type: 'FORK', detail: `two rows claim predecessor ${key === 'NULL' ? 'NULL' : key.slice(0, 12) + '…'} (also row ${seenPrev.get(key)})` });
    } else {
      seenPrev.set(key, row.id);
    }
  }

  return {
    ok: problems.length === 0,
    rowsChecked: rows.length,
    headHash: rows.length ? rows[rows.length - 1][hashColumn] : null,
    problems,
  };
}

/**
 * Produce a publishable anchor: a short, human-comparable commitment to the
 * chain head. The cron job logs/exports this; an owner who wants real
 * tamper-proofing pastes it somewhere they also control (an email to
 * themselves, a notarised doc). Comparing two anchors from different dates
 * proves nothing was rewritten in between.
 */
async function anchor(db, { table, scopeColumn = null, scopeValue = null, hashColumn = 'row_hash', prevColumn = 'prev_hash' }) {
  const head = await headHash(db, { table, scopeColumn, scopeValue, hashColumn, prevColumn });
  const countRow = await db.first(
    `SELECT COUNT(*) AS c FROM ${table}${scopeColumn ? ` WHERE ${scopeColumn} = ?` : ''}`,
    scopeColumn ? [String(scopeValue)] : [],
  );
  return {
    table,
    scope: scopeColumn ? { column: scopeColumn, value: scopeValue } : null,
    headHash: head.hash === GENESIS_PREV_HASH ? null : head.hash,
    rowCount: Number((countRow && countRow.c) || 0),
    anchoredAt: new Date().toISOString(),
  };
}

module.exports = {
  GENESIS_PREV_HASH,
  chainPayload, computeRowHash, computeRowHashSync,
  headHash, appendChained, verifyChain, anchor,
};
