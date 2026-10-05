'use strict';
// =====================================================================
// server/lib/idempotency.js — SAFE RETRY FOR EVERY MUTATING REQUEST
// =====================================================================
// THE PROBLEM
//
// An offline-first PWA on a flaky connection retries. It MUST retry, because
// the alternative is a cashier standing at a counter with a dead screen and
// a queue behind them. But a retry after a lost RESPONSE is ambiguous: the
// request may have failed, or it may have succeeded and only the reply was
// lost. Without a defence, the second attempt executes a second time.
//
// For a sale that means: stock decremented twice, cash counted twice, a
// duplicate receipt number, a customer charged twice on a POS terminal that
// already authorised the first one, and a till that will not reconcile at
// close — with no way to tell afterwards which of the two sales was real.
//
// THE MECHANISM
//
// A client generates one Idempotency-Key per LOGICAL action and sends the
// SAME key on every attempt of that action. The server:
//   1. looks the key up for this user
//   2. if absent, reserves it (IN_PROGRESS) and executes
//   3. stores the response and marks it COMPLETED
//   4. on a repeat with the same key, REPLAYS the stored response verbatim
//
// The stored request body's hash is compared too. A key reused for a
// DIFFERENT request is refused rather than silently returning the old
// response — because a client bug that reuses a key across two sales would
// otherwise make the second sale vanish, which is worse than the duplicate
// this feature prevents.
//
// WHY THE KEY IS SCOPED PER USER
//
// Two cashiers at two branches will both generate the same random key
// eventually, and more importantly a key must not let one user read another
// user's stored response body. (user_id, idempotency_key) is the primary key.
// =====================================================================

const { HttpError } = require('./http');

const RETENTION_DAYS = 7;

// A request that has been IN_PROGRESS this long is assumed to have died
// mid-flight (the process was killed, the deploy rolled). Reserving the key
// forever would permanently block a legitimate retry, so a stale reservation
// is taken over. Two minutes is longer than any real transaction here and
// shorter than a cashier's patience.
const STALE_IN_PROGRESS_MINUTES = 2;

function keyFrom(ctx) {
  const raw = ctx.req.header('Idempotency-Key') || ctx.req.header('idempotency-key') || null;
  if (!raw) return null;
  const key = String(raw).trim();
  if (!key) return null;
  if (key.length > 128) {
    throw new HttpError('The Idempotency-Key header is too long (128 characters maximum).', { status: 400, code: 'IDEMPOTENCY_KEY_TOO_LONG' });
  }
  return key;
}

/**
 * Look up an existing result for this key.
 * Returns { state: 'COMPLETED', status, body } | { state: 'IN_PROGRESS' } | null
 */
async function lookup(db, { key, userId, requestHash }) {
  const row = await db.first(
    // `response_status` MUST be selected: it is what makes a replay answer with
    // the status the original call produced. Leaving it out silently downgraded
    // every replayed 201 to a 200, and a replayed 400 to a 200 — which a client
    // reading `if (status === 201)` would treat as a failed sale and try again.
    `SELECT status, response_status, response_body, request_hash, created_at,
            CAST((julianday('now') - julianday(created_at)) * 24 * 60 AS INTEGER) AS age_minutes
     FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?`,
    [String(key), String(userId)],
  );
  if (!row) return null;

  if (row.request_hash && requestHash && row.request_hash !== requestHash) {
    throw new HttpError(
      'This Idempotency-Key was already used for a DIFFERENT request. A key must identify one logical action; reusing it for another would return the first action\'s result and silently discard this one. Generate a fresh key.',
      { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' },
    );
  }

  if (row.status === 'COMPLETED') {
    let body = null;
    try { body = row.response_body ? JSON.parse(row.response_body) : null; } catch (e) { body = null; }
    // response_status is the column the schema defines; a NULL there means
    // the handler completed without recording a status, so replay as 200.
    return { state: 'COMPLETED', status: Number(row.response_status) || 200, body, replayed: true };
  }

  const age = Number(row.age_minutes || 0);
  if (age >= STALE_IN_PROGRESS_MINUTES) return { state: 'STALE' };
  return { state: 'IN_PROGRESS', ageMinutes: age };
}

/** Reserve a key. Returns true if this caller won the reservation. */
async function reserve(db, { key, userId, method, path, requestHash }) {
  try {
    const result = await db.run(
      `INSERT INTO idempotency_keys (idempotency_key, user_id, method, path, request_hash, status)
       VALUES (?,?,?,?,?, 'IN_PROGRESS')
       ON CONFLICT(idempotency_key, user_id) DO UPDATE SET
         status = 'IN_PROGRESS',
         method = excluded.method,
         path = excluded.path,
         request_hash = excluded.request_hash,
         created_at = datetime('now')
       WHERE idempotency_keys.status <> 'COMPLETED'
         AND (julianday('now') - julianday(idempotency_keys.created_at)) * 24 * 60 >= ?`,
      [String(key), String(userId), String(method), String(path), requestHash, STALE_IN_PROGRESS_MINUTES],
    );
    return Number(result.changes) > 0;
  } catch (e) {
    // A constraint failure here means somebody else won the race. That is the
    // expected outcome under concurrency, not an error to surface.
    return false;
  }
}

/** Store the completed response so a retry can replay it. */
async function complete(db, { key, userId, status, body }) {
  await db.run(
    `UPDATE idempotency_keys SET status = 'COMPLETED', response_status = ?, response_body = ?
     WHERE idempotency_key = ? AND user_id = ?`,
    [Number(status), JSON.stringify(body === undefined ? null : body), String(key), String(userId)],
  );
}

/** Release a reservation when the handler threw, so a retry can proceed. */
async function release(db, { key, userId }) {
  await db.run(
    `DELETE FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ? AND status = 'IN_PROGRESS'`,
    [String(key), String(userId)],
  );
}

/**
 * The middleware. Wraps a mutating route handler with the full protocol.
 *
 * Only applied to POST/PUT/PATCH/DELETE. A GET is already idempotent by
 * definition and wrapping it would just cost a table write per request.
 */
function idempotent(handler) {
  return async function idempotentHandler(ctx, next) {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const key = keyFrom(ctx);

    // No key: execute normally. The feature is opt-in per request, because a
    // client that does not send a key cannot be protected and refusing the
    // request outright would break every caller that has not adopted it yet.
    if (!key || !user) return handler(ctx, next);

    const body = await ctx.req.json().catch(() => null);
    const { canonicalJson, sha256Hex } = require('../../domain/crypto');
    const requestHash = await sha256Hex(canonicalJson(body));

    const existing = await lookup(db, { key, userId: user.id, requestHash });
    if (existing && existing.state === 'COMPLETED') {
      ctx.set('idempotencyReplayed', true);
      ctx.header('Idempotency-Replayed', 'true');
      // The stored body is the ORIGINAL response, produced before a replay was
      // even conceivable, so it cannot say it is one. The flag is added here: a
      // device that retried a queued sale has no other way to tell "the server
      // did this just now" from "the server did this the first time I asked",
      // and the offline queue needs that to know it can drop the item.
      const body = existing.body && typeof existing.body === 'object' && !Array.isArray(existing.body)
        ? Object.assign({}, existing.body, { replayed: true })
        : existing.body;
      return ctx.json(body, existing.status);
    }
    if (existing && existing.state === 'IN_PROGRESS') {
      // A concurrent duplicate, not a retry-after-completion. The honest
      // answer is "the first one is still running": returning 409 lets the
      // client back off and retry, which will then replay the result.
      throw new HttpError(
        'That action is still being processed. Wait a moment and send the same request again — it will not be executed twice.',
        { status: 409, code: 'IDEMPOTENCY_IN_PROGRESS', headers: { 'Retry-After': '5' } },
      );
    }

    const won = await reserve(db, { key, userId: user.id, method: ctx.method, path: ctx.path, requestHash });
    if (!won) {
      // Lost the race to a concurrent request with the same key.
      throw new HttpError(
        'That action is already in progress. Wait a moment and retry — it will not be executed twice.',
        { status: 409, code: 'IDEMPOTENCY_IN_PROGRESS', headers: { 'Retry-After': '5' } },
      );
    }

    try {
      await handler(ctx, next);
      // Capture whatever the handler produced. ctx.json() sets _body_out.
      const status = ctx._status;
      let parsed = null;
      try { parsed = ctx._body_out ? JSON.parse(ctx._body_out) : null; } catch (e) { parsed = null; }
      await complete(db, { key, userId: user.id, status, body: parsed });
    } catch (e) {
      // A FAILED request must not be remembered as completed, or the client's
      // legitimate retry after fixing the input would replay the error.
      await release(db, { key, userId: user.id }).catch(() => {});
      throw e;
    }
  };
}

/** Housekeeping for the cron handler. */
async function prune(db, { retentionDays = RETENTION_DAYS } = {}) {
  const days = Math.max(1, Number(retentionDays) || RETENTION_DAYS);
  const result = await db.run(
    "DELETE FROM idempotency_keys WHERE created_at < datetime('now', ?)",
    [`-${days} days`],
  );
  return Number(result.changes || 0);
}

module.exports = {
  RETENTION_DAYS, STALE_IN_PROGRESS_MINUTES,
  keyFrom, lookup, reserve, complete, release, idempotent, prune,
};
