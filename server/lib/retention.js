'use strict';
// =====================================================================
// server/lib/retention.js — WHAT THE SHOP FORGETS, AND WHAT IT NEVER FORGETS
// =====================================================================
// THREE TABLES GROW WITH USE AND MEAN NOTHING AFTER A WHILE:
//
//   sync_change_log   one row per push, pull and heartbeat, per device, per day.
//                     Its value is measured in hours: it answers "did this phone
//                     sync, and did it fail?" A row from last year answers
//                     nothing and is the fastest-growing table in the schema —
//                     a shop with four devices syncing hourly writes ~35,000
//                     rows a year to say nothing.
//
//   login_attempts    the authentication audit trail. The throttle window is
//                     fifteen minutes, so only the last few rows per user have
//                     any operational use; the rest is forensic. It is kept for
//                     ninety days because "who tried to sign in as whom" is a
//                     question asked about a *recent* incident, and because an
//                     audit trail that grows without bound eventually competes
//                     for space with the trading record it is meant to protect.
//                     housekeeping.js used to keep these forever with a written
//                     rationale; that rationale is preserved below, the window
//                     is what changed. A DECISION, not an oversight.
//
//   sync_conflicts    a lost version kept for a human to look at. REVIEWED ones
//                     (somebody decided: keep the server's, re-queue the
//                     device's, merge) have served their purpose after six
//                     months. UNREVIEWED ones are never deleted at any age,
//                     because an unreviewed conflict is an *unanswered question
//                     about a customer's record* and deleting it would destroy
//                     the only copy of a version somebody typed offline.
//
// WHAT IS NEVER TOUCHED, here or anywhere: sales, payments, the ledger, stock
// movements, the audit log, the hash-chained registers, and the compliance
// record. A shop's trading history is not housekeeping; it is the reason the
// shop can answer a tax officer, a supplier and a court. `NEVER_PRUNED` in
// worker/src/housekeeping.js names them, and test/audit/audit.data.js asserts
// that no statement in this module mentions one.
//
// EVERY WINDOW IS A PARAMETER with a default, so the Owner's data-management
// screen can state the number it uses without a second copy of it living in the
// UI.
// =====================================================================

/** Defaults, in days. Named, exported, and quoted by the status endpoint. */
const RETENTION_DAYS = Object.freeze({
  syncChangeLog: 90,
  loginAttempts: 90,
  reviewedConflicts: 180,
});

/** `datetime('now', ?)` wants the modifier as a parameter, never interpolated. */
const olderThan = (days) => `-${Math.max(1, Math.floor(Number(days) || 1))} days`;

/**
 * The retention statements, as data: `{ name, sql, params, what }`.
 *
 * Returned rather than executed so the same list can be run by the cron, counted
 * by the status endpoint, and asserted one statement at a time by a test — the
 * shape worker/src/housekeeping.js already uses, and the reason a statement that
 * names a column the schema lacks fails a test instead of failing at 3am.
 */
function retentionStatements({ days = RETENTION_DAYS } = {}) {
  const windows = Object.assign({}, RETENTION_DAYS, days);
  return [
    {
      name: 'sync change log',
      what: `Device sync history (push, pull, heartbeat) older than ${windows.syncChangeLog} days.`,
      sql: "DELETE FROM sync_change_log WHERE synced_at < datetime('now', ?)",
      countSql: "SELECT COUNT(*) AS c FROM sync_change_log WHERE synced_at < datetime('now', ?)",
      params: [olderThan(windows.syncChangeLog)],
    },
    {
      name: 'reviewed sync conflicts',
      what: `Conflicts a person has already resolved, older than ${windows.reviewedConflicts} days. Unreviewed conflicts are never removed.`,
      // `reviewed_at IS NOT NULL` is the whole point: the row must have been
      // DECIDED before it can age out. A conflict nobody looked at stays until
      // somebody looks at it, at any age.
      sql: "DELETE FROM sync_conflicts WHERE reviewed_at IS NOT NULL AND reviewed_at < datetime('now', ?)",
      countSql: "SELECT COUNT(*) AS c FROM sync_conflicts WHERE reviewed_at IS NOT NULL AND reviewed_at < datetime('now', ?)",
      params: [olderThan(windows.reviewedConflicts)],
    },
    {
      name: 'login attempts',
      what: `Sign-in attempts older than ${windows.loginAttempts} days.`,
      sql: "DELETE FROM login_attempts WHERE attempted_at < datetime('now', ?)",
      countSql: "SELECT COUNT(*) AS c FROM login_attempts WHERE attempted_at < datetime('now', ?)",
      params: [olderThan(windows.loginAttempts)],
    },
  ];
}

/**
 * Run them. Never throws for the same reason housekeeping never throws: a cron
 * that dies takes its evidence with it, and the platform then retries the same
 * failing work. Each statement's outcome is reported separately so one bad table
 * cannot hide the other two.
 */
async function runRetention(db, { days } = {}) {
  const result = { pruned: {}, errors: [] };
  for (const statement of retentionStatements({ days })) {
    try {
      const run = await db.run(statement.sql, statement.params);
      result.pruned[statement.name] = Number(run && run.changes) || 0;
    } catch (err) {
      result.errors.push(`${statement.name}: ${err && err.message ? err.message : err}`);
    }
  }
  return result;
}

/**
 * What each window would remove if it ran right now, WITHOUT removing it.
 *
 * The count is a second copy of the same predicate, kept in the same object as
 * the delete so the two cannot drift apart in different files — and
 * test/integration/housekeeping.test.js asserts they agree by previewing,
 * running, and comparing the count with what actually disappeared. A status
 * screen that reports a number it does not act on is worse than no screen.
 */
async function retentionPreview(db, { days } = {}) {
  const out = [];
  for (const statement of retentionStatements({ days })) {
    let wouldRemove = null;
    let error = null;
    try {
      const row = await db.first(statement.countSql, statement.params);
      wouldRemove = Number((row && row.c) || 0);
    } catch (err) {
      error = err && err.message ? err.message : String(err);
    }
    out.push({ name: statement.name, what: statement.what, retainDays: Number(String(statement.params[0]).replace(/[^0-9]/g, '')), wouldRemove, error });
  }
  return out;
}

module.exports = { RETENTION_DAYS, retentionStatements, runRetention, retentionPreview };
