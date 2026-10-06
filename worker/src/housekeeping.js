'use strict';
// =====================================================================
// worker/src/housekeeping.js — WHAT THE CRON ACTUALLY DOES
// =====================================================================
// Extracted from the Worker's `scheduled` handler for one reason: so a test can
// execute it against a real migrated database.
//
// The statements it replaces were written from memory, named two columns that do
// not exist (`user_sessions.is_deleted`, `user_sessions.expires_at`, and
// `branch_devices.is_active`, `branch_devices.last_seen_at`), and threw on every
// run. The handler caught the error and logged it, so the cron had silently done
// nothing since the day it was scheduled — and no static audit could see it,
// because the SQL is perfectly well-formed. It is only wrong about the schema, and
// the schema only answers when you execute.
//
// The rule this module now follows: every statement here is executed by
// `test/integration/housekeeping.test.js` against a database built from
// `schema/migrations/`. A statement that names a column the schema lacks fails
// that test, loudly, before it is ever deployed.
// =====================================================================

const { prune, RETENTION_DAYS } = require('../../server/lib/idempotency');
const { notifyStatement } = require('../../domain/compliance');
const { TOKEN_TTL_SECONDS } = require('../../domain/crypto');

/**
 * How long a signed-out or abandoned session row is kept before deletion.
 *
 * A session row stops meaning anything the moment its token expires, and a token
 * lives for TOKEN_TTL_SECONDS (twelve hours — a shop day plus overtime). Keeping
 * the row beyond that is bytes with no reader. It is NOT deleted on sign-out,
 * because sign-out deletes it explicitly and immediately.
 */
const SESSION_GRACE_HOURS = 12;

/**
 * The statements, as data, so they can be run by the Worker and asserted by a
 * test. `params` are bound, never interpolated.
 */
function housekeepingStatements({ sessionGraceHours = SESSION_GRACE_HOURS } = {}) {
  const hours = Math.max(1, Number(sessionGraceHours) || SESSION_GRACE_HOURS);
  return [
    {
      name: 'expired sessions',
      // user_sessions is (user_id, session_id, issued_at, updated_at). There is no
      // expiry column to compare against: `issued_at` IS the clock, because a
      // session's row is rewritten on every sign-in and its token carries the TTL.
      sql: "DELETE FROM user_sessions WHERE issued_at < datetime('now', ?)",
      params: [`-${hours} hours`],
    },
    {
      name: 'compliance expiry alerts',
      // THE REASON THIS IS IN THE CRON AT ALL. A licence that lapses is a fine, a
      // sealed shop, or a shipment held at the port, and the person who needs to
      // know is not necessarily the person who opens this screen. The daily
      // schedule raises the alert; the screen can also raise it on demand, from
      // the same statement, which is why the two can never disagree.
      //
      // It reads `v_compliance_expiry_alerts` and respects the owner's own
      // window through the settings subquery inside the statement.
      ...notifyStatement({ useSettings: true }),
    },
  ];
}

/**
 * Run the whole of it. Never throws: a cron that dies takes its own evidence with
 * it, and the Worker's retry then does the same failing work again. It returns
 * what happened, including what failed.
 */
async function runHousekeeping(db, { sessionGraceHours = SESSION_GRACE_HOURS } = {}) {
  const result = { sessionsPruned: 0, idempotencyKeysPruned: 0, complianceAlertsRaised: 0, errors: [] };

  for (const statement of housekeepingStatements({ sessionGraceHours })) {
    try {
      const run = await db.run(statement.sql, statement.params);
      const changes = Number(run && run.changes) || 0;
      if (statement.name === 'expired sessions') result.sessionsPruned = changes;
      if (statement.name === 'compliance expiry alerts') result.complianceAlertsRaised = changes;
    } catch (err) {
      result.errors.push(`${statement.name}: ${err && err.message ? err.message : err}`);
    }
  }

  // Idempotency keys are how a retried sale is applied once instead of twice.
  // They accumulate one row per write, forever, and the retention window already
  // exists in idempotency.js for exactly this purpose — it was simply never
  // called by anything.
  try {
    result.idempotencyKeysPruned = await prune(db, { retentionDays: RETENTION_DAYS });
  } catch (err) {
    result.errors.push(`idempotency keys: ${err && err.message ? err.message : err}`);
  }

  return result;
}

/**
 * Records deliberately NOT pruned, and why — so that a future reader does not
 * "finish the job" by deleting a shop's history.
 *
 *   login_attempts   An authentication audit trail. The throttle window is
 *                    fifteen minutes, so only the last few rows have any use to
 *                    the throttle — but the value of the rest is forensic, in
 *                    exactly the situation where somebody wants to know who tried
 *                    to sign in as whom. Growth is a few rows per staff member
 *                    per day, which is not a problem worth trading history for.
 *
 *   branch_devices   A registered device is revoked explicitly, by a person, with
 *                    `revoked_at` set — the partial unique index and the Devices
 *                    screen both depend on that being a human act. There is no
 *                    heartbeat column on this table to age a device by, and
 *                    synthesising one from `registered_at` would retire the till
 *                    in a shop that simply had a quiet season.
 *
 *   audit_log, hash-chained registers, stock movements, sales, payments
 *                    The trading record. Never automatically deleted.
 */
const NEVER_PRUNED = Object.freeze(['login_attempts', 'branch_devices', 'audit_log']);

module.exports = {
  SESSION_GRACE_HOURS,
  housekeepingStatements,
  runHousekeeping,
  NEVER_PRUNED,
};
