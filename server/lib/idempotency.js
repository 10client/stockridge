// =====================================================================
// StockRidge — IDEMPOTENCY
// =====================================================================
// Protects every mutating request against duplicate execution when a client
// retries after losing the RESPONSE (not the request): a flaky connection,
// a 3G handover between cells, or the offline queue replaying a sale that
// actually already succeeded server-side before connectivity dropped.
//
// This is what makes it safe for the PWA's offline queue to retry blindly.
// Without it, a retry means double stock deduction, double cash counted, or
// a duplicate entry on an evidentiary register — and on a Nigerian mobile
// network, "the request succeeded but the response was lost" is not an edge
// case, it is a Tuesday.
//
// PROTOCOL
//   Client sends `Idempotency-Key: <uuid>` on every attempt of the SAME
//   logical action. The client generates it ONCE per action, not per
//   attempt — regenerating it on retry defeats the entire mechanism.
//
//   First arrival:  row inserted IN_PROGRESS, handler runs, response stored
//                   and row moved to COMPLETED.
//   Repeat arrival: stored response replayed VERBATIM, same status code.
//   Repeat with a DIFFERENT body under the same key: 409. That is a client
//                   bug (key reuse across actions), and replaying the old
//                   response would silently do the wrong thing.
//   Repeat while still IN_PROGRESS: 409 with Retry-After. Two concurrent
//                   executions of the same action is exactly the double-spend
//                   this exists to prevent, so the second one must not run.
//
// KEYS ARE SCOPED PER USER: (idempotency_key, user_id) is the primary key,
// so one cashier's key cannot collide with another's, and a stolen key
// cannot be replayed by a different account.
// =====================================================================

const { sha256Hex, watNowIso } = require('../../shared/ids');
const { HttpError } = require('./http');

const KEY_TTL_HOURS = 48;      // long enough to cover an overnight offline queue, short enough to prune
const KEY_MAX_LENGTH = 128;

function normaliseKey(raw) {
  const k = String(raw == null ? '' : raw).trim();
  if (!k) return null;
  if (k.length > KEY_MAX_LENGTH) return null;
  return k;
}

async function hashBody(body) {
  return sha256Hex(JSON.stringify(body == null ? null : body));
}

// Wrap a mutating handler. Returns the stored response for a repeat key.
//
// `run` is called with no arguments and must return
// { status, body } — the exact response to store and replay.
async function withIdempotency(db, ctx, run, { required = false } = {}) {
  const header = ctx.req.header('Idempotency-Key') || ctx.req.header('idempotency-key');
  const key = normaliseKey(header);
  const userId = ctx.var.user ? ctx.var.user.id : null;

  // No key and none required: run directly. GET-shaped and explicitly
  // opt-out mutations take this path.
  if (!key) {
    if (required) {
      throw new HttpError(400,
        'This request needs an Idempotency-Key header so a retry cannot execute it twice. The app sends this automatically; if you are calling the API directly, generate one UUID per action.',
        'IDEMPOTENCY_KEY_REQUIRED');
    }
    return run();
  }
  if (!userId) {
    // An unauthenticated request cannot be scoped to a user, so the key
    // cannot be trusted. Refuse rather than key on a global namespace that
    // one client could collide with another's.
    throw new HttpError(400, 'An Idempotency-Key can only be used on an authenticated request.', 'IDEMPOTENCY_KEY_UNAUTHENTICATED');
  }

  const body = await ctx.req.json();
  const requestHash = await hashBody(body);
  const method = ctx.req.method;
  const path = ctx.routePath || ctx.req.path;
  const unitId = ctx.var.businessUnitId || null;

  const existing = await db.prepare(
    'SELECT * FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?'
  ).bind(key, userId).first();

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new HttpError(409,
        'That Idempotency-Key has already been used for a DIFFERENT request. Generate a new key for each distinct action — reusing one would replay the earlier result instead of doing what you asked.',
        'IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY');
    }
    if (existing.status === 'IN_PROGRESS') {
      const e = new HttpError(409,
        'An identical request is still being processed. Wait a moment and retry with the SAME Idempotency-Key — you will get the original result, not a duplicate.',
        'IDEMPOTENCY_IN_PROGRESS');
      e.retryAfterSeconds = 5;
      throw e;
    }
    // Replay verbatim, including the original status code. A 201 replayed as
    // 200 would make a well-behaved client think it created something twice.
    return {
      status: existing.response_status || 200,
      body: safeParse(existing.response_body),
      replayed: true,
      idempotency_key: key,
    };
  }

  // Claim the key BEFORE running, so a concurrent duplicate sees
  // IN_PROGRESS and refuses rather than also running.
  await db.prepare(`
    INSERT INTO idempotency_keys (idempotency_key, user_id, business_unit_id, method, path, request_hash, status, created_at)
    VALUES (?,?,?,?,?,?, 'IN_PROGRESS', ?)
  `).bind(key, userId, unitId, method, path, requestHash, watNowIso()).run();

  let result;
  try {
    result = await run();
  } catch (e) {
    // A FAILED attempt must not be cached as the answer forever — otherwise
    // a transient error (a locked database, a network blip) permanently
    // poisons that action for that user. Release the claim so a retry runs.
    // A DETERMINISTIC failure (validation) will simply fail again, which is
    // correct and costs nothing.
    await db.prepare('DELETE FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?')
      .bind(key, userId).run();
    throw e;
  }

  const status = Number(result && result.status) || 200;
  const responseBody = JSON.stringify((result && result.body) == null ? {} : result.body);
  await db.prepare(`
    UPDATE idempotency_keys
    SET response_status = ?, response_body = ?, status = 'COMPLETED'
    WHERE idempotency_key = ? AND user_id = ?
  `).bind(status, responseBody, key, userId).run();

  return { ...result, status, replayed: false, idempotency_key: key };
}

function safeParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { return { error: 'Stored response could not be parsed.', code: 'IDEMPOTENCY_STORED_RESPONSE_CORRUPT' }; }
}

async function pruneKeys(db, { keepHours = KEY_TTL_HOURS } = {}) {
  const res = await db.prepare(`
    DELETE FROM idempotency_keys WHERE created_at < datetime('now', '+1 hour', ?)
  `).bind(`-${keepHours} hours`).run();
  return (res && res.meta && res.meta.changes) || 0;
}

module.exports = { withIdempotency, normaliseKey, hashBody, pruneKeys, KEY_TTL_HOURS, KEY_MAX_LENGTH };
'use strict';
