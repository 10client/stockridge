'use strict';
// =====================================================================
// server/lib/replay.js — A SYNC REPLAY THE CLIENT CANNOT FORGE
// =====================================================================
// Offline work is replayed through the same routes an online request uses, so
// the route cannot tell them apart by looking at the body. A header of `1`
// is not a distinction either: the browser can set that itself, and a staff
// sale would then be allowed to name any time in the last 90 days.
//
// The worker signs `sync-replay:<idempotency key>` with the JWT secret, which
// never leaves the server. A route trusts the replay only when that signature
// matches. The key is part of the message so a captured header cannot be
// reused on a different operation.

const { hmacSha256Base64url, timingSafeEqualString } = require('../../domain/crypto');

const PREFIX = 'sync-replay:';

function secretOf(env) {
  return (env && (env.JWT_SECRET || env.jwtSecret)) || null;
}

async function signReplay(env, idempotencyKey) {
  const secret = secretOf(env);
  if (!secret || !idempotencyKey) return null;
  return hmacSha256Base64url(secret, `${PREFIX}${idempotencyKey}`);
}

async function trustedReplay(ctx) {
  const token = ctx.req.header('X-Sync-Replay') || ctx.req.header('x-sync-replay');
  const key = ctx.req.header('Idempotency-Key') || ctx.req.header('idempotency-key');
  if (!token || !key || token === '1') return false;
  const expected = await signReplay(ctx.env, key);
  if (!expected) return false;
  return timingSafeEqualString(token, expected);
}

module.exports = { signReplay, trustedReplay };
