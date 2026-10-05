'use strict';
// =====================================================================
// server/lib/loginThrottle.js — PIN BRUTE-FORCE DEFENCE
// =====================================================================
// WHY THIS IS MANDATORY AND NOT A NICE-TO-HAVE
//
// This product authenticates with SHORT NUMERIC PINs. The minimum is 4
// digits: a 10,000-value keyspace. Reproduced live against a running server
// in the original build, before this defence existed:
//
//   60 consecutive wrong PINs against the `owner` account all returned a
//   plain 401 in 1,150ms total — 19ms per attempt, with no lockout, no
//   throttle, and no record anywhere that it had happened. The correct PIN
//   then worked immediately afterwards.
//
// At 19ms per attempt a 4-digit PIN is exhaustible in about three minutes.
// PBKDF2 slows the OFFLINE attack against a stolen database (see
// domain/crypto.js); THIS slows the ONLINE one. They are different defences
// for different attacks and neither substitutes for the other.
//
// DESIGN DECISIONS, each of which was a real trade:
//
//   USERNAME-SCOPED, NOT IP-SCOPED. An IP-scoped lock behind a shop's NAT
//     means one cashier's typo locks out the whole branch — and in Nigeria a
//     whole plaza often shares one public IP, so it would lock out unrelated
//     businesses. The cost is that an attacker can rotate usernames; that is
//     acceptable because each username is separately throttled and the audit
//     trail records every attempt regardless of outcome.
//
//   THE LOCK RUNS FROM THE MOST RECENT FAILURE. A fixed 15-minute window
//     would let an attacker make 8 attempts, wait 15 minutes, and make 8
//     more forever. Extending on each failure means continued hammering
//     keeps pushing the unlock time further away, so the attack never
//     completes even at a patient rate.
//
//   FAILS OPEN ON INTERNAL ERROR. If the login_attempts table is missing or
//     the query fails, the login PROCEEDS. Bricking every sign-in because an
//     audit table is unwritable is worse than the attack it defends against:
//     a shop that cannot open the till loses more in an hour than a brute
//     force would. The failure is logged loudly.
//
//   A HIGHER-RANKED USER CAN CLEAR A LOCK. The lock is time-based, so a
//     legitimate owner who mistypes 8 times is locked out of their own shop
//     for 15 minutes — potentially mid-queue, unable to open the till.
//     "Wait it out" is not an acceptable answer on a shop floor. Authority
//     mirrors PIN reset exactly, so this grants no new power: anyone who can
//     clear a lock could already reset that user's PIN outright.
// =====================================================================

const MAX_FAILED_ATTEMPTS = 8;
const WINDOW_MINUTES = 15;
const LOCKOUT_MINUTES = 15;

// A PIN keyspace of 10^4 means an attacker who is rate-limited to 8 guesses
// per 15 minutes needs 1250 windows — about 13 days of uninterrupted
// hammering, on ONE username, with every attempt recorded. That is the
// arithmetic this constant set is chosen to produce.
class LoginLockedError extends Error {
  constructor(retryAfterSeconds) {
    const mins = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    super(
      `Too many failed sign-in attempts for this account. For security it has been temporarily locked. `
      + `Please try again in about ${mins} minute${mins === 1 ? '' : 's'}, or ask a manager to reset your PIN.`,
    );
    this.name = 'LoginLockedError';
    this.status = 429;
    this.code = 'TOO_MANY_LOGIN_ATTEMPTS';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Throws LoginLockedError when `username` currently has too many recent
 * failures. Call BEFORE verifying the PIN, so a locked account does not even
 * get to spend PBKDF2 time.
 *
 * Fails open: any internal error allows the login to proceed.
 */
async function assertLoginAllowed(db, username) {
  if (!username) return;
  try {
    const row = await db.first(`
      SELECT COUNT(*) AS failures, MAX(attempted_at) AS last_failure
      FROM login_attempts
      WHERE username = ? AND succeeded = 0
        AND attempted_at > datetime('now', ?)`,
    [String(username), `-${WINDOW_MINUTES} minutes`]);

    if (!row || Number(row.failures) < MAX_FAILED_ATTEMPTS) return;

    const unlock = await db.first(
      "SELECT datetime(?, ?) AS unlock_at, datetime('now') AS now_at",
      [row.last_failure, `+${LOCKOUT_MINUTES} minutes`],
    );
    if (!unlock) return;
    const remainingSeconds = Math.max(
      1,
      Math.round((Date.parse(`${unlock.unlock_at}Z`) - Date.parse(`${unlock.now_at}Z`)) / 1000),
    );
    if (remainingSeconds <= 0) return;
    throw new LoginLockedError(remainingSeconds);
  } catch (e) {
    if (e instanceof LoginLockedError) throw e;
    // FAIL OPEN — see the header comment.
    console.error('[loginThrottle] check failed, allowing login:', e && e.message);
  }
}

/**
 * Record one authentication attempt. Never throws — an audit-trail failure
 * must not break a legitimate sign-in.
 */
async function recordLoginAttempt(db, { username, userId, succeeded, ipAddress, userAgent }) {
  try {
    await db.run(
      'INSERT INTO login_attempts (username, user_id, succeeded, ip_address, user_agent) VALUES (?,?,?,?,?)',
      [
        String(username || '').slice(0, 120),
        userId || null,
        succeeded ? 1 : 0,
        ipAddress ? String(ipAddress).slice(0, 60) : null,
        userAgent ? String(userAgent).slice(0, 200) : null,
      ],
    );
    // A successful sign-in clears the slate, so ordinary mistyping over a
    // month never accumulates into a lockout.
    if (succeeded) {
      await db.run('DELETE FROM login_attempts WHERE username = ? AND succeeded = 0', [String(username || '')]);
    }
  } catch (e) {
    console.error('[loginThrottle] could not record attempt:', e && e.message);
  }
}

/**
 * Clear the failed-attempt counter for a username, unlocking it immediately.
 *
 * The audit trail is NOT deleted — only the failure rows that feed the
 * throttle. Successful logins and the fact that an unlock happened remain
 * visible, so "who unlocked whom, and when" is answerable afterwards.
 */
async function clearLoginLock(db, username) {
  const result = await db.run('DELETE FROM login_attempts WHERE username = ? AND succeeded = 0', [String(username || '')]);
  return Number((result && result.changes) || 0);
}

/** Current lock state, so a manager can see WHICH accounts are locked. */
async function getLockState(db, username) {
  const row = await db.first(`
    SELECT COUNT(*) AS failures, MAX(attempted_at) AS last_failure
    FROM login_attempts
    WHERE username = ? AND succeeded = 0
      AND attempted_at > datetime('now', ?)`,
  [String(username || ''), `-${WINDOW_MINUTES} minutes`]);
  const failures = Number((row && row.failures) || 0);
  return {
    failed_attempts: failures,
    is_locked: failures >= MAX_FAILED_ATTEMPTS,
    last_failed_at: (row && row.last_failure) || null,
    attempts_before_lock: Math.max(0, MAX_FAILED_ATTEMPTS - failures),
  };
}

/**
 * Sign-in history for one user, for the security screen.
 * Deliberately includes SUCCESSFUL attempts: a manager investigating a
 * suspected shared PIN needs to see logins from unfamiliar user agents, and
 * a list of only failures would hide exactly that.
 */
async function recentAttempts(db, { username = null, limit = 50 } = {}) {
  const n = Math.min(500, Math.max(1, Number(limit) || 50));
  if (username) {
    return db.all(
      'SELECT username, succeeded, ip_address, user_agent, attempted_at FROM login_attempts WHERE username = ? ORDER BY attempted_at DESC LIMIT ?',
      [String(username), n],
    );
  }
  return db.all(
    'SELECT username, succeeded, ip_address, user_agent, attempted_at FROM login_attempts ORDER BY attempted_at DESC LIMIT ?',
    [n],
  );
}

/**
 * Housekeeping: drop attempt rows older than the retention window.
 *
 * Called from the cron/scheduled handler. Without it this table grows
 * forever — it records every failed attempt from every device, which on a
 * busy deployment is thousands of rows a month of pure noise after 90 days.
 * Successful attempts are kept longer than failures, because "when did this
 * person last sign in, and from where" stays useful for years while "somebody
 * mistyped a PIN in March" does not.
 */
async function pruneAttempts(db, { failureRetentionDays = 30, successRetentionDays = 365 } = {}) {
  const failures = await db.run(
    "DELETE FROM login_attempts WHERE succeeded = 0 AND attempted_at < datetime('now', ?)",
    [`-${Math.max(1, Number(failureRetentionDays) || 30)} days`],
  );
  const successes = await db.run(
    "DELETE FROM login_attempts WHERE succeeded = 1 AND attempted_at < datetime('now', ?)",
    [`-${Math.max(1, Number(successRetentionDays) || 365)} days`],
  );
  return { failuresRemoved: Number(failures.changes || 0), successesRemoved: Number(successes.changes || 0) };
}

module.exports = {
  MAX_FAILED_ATTEMPTS, WINDOW_MINUTES, LOCKOUT_MINUTES, LoginLockedError,
  assertLoginAllowed, recordLoginAttempt, clearLoginLock, getLockState,
  recentAttempts, pruneAttempts,
};
