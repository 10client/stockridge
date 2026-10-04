// =====================================================================
// worker/src/auth.js — configuration and authentication on Workers
// =====================================================================
// The PIN hashing and token signing live in server/lib/auth.js and are used
// UNCHANGED here, via the `nodejs_compat` runtime flag that exposes node:crypto
// (and therefore scrypt) inside a Worker.
//
// That flag is not a convenience — it is what makes one auth implementation
// possible. Without it the Worker would need a second PIN-hashing scheme, and
// then a database created by one backend could not be read by the other: an
// scrypt hash is meaningless to a PBKDF2 verifier. Two auth implementations is
// two sets of users.

'use strict';

import auth from '../../server/lib/auth.js';
import scopeLib from '../../server/lib/scope.js';

/** Build the same config shape server/lib/config.js produces, from env vars. */
export function workerConfig(env) {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    // Refusing to boot is correct here. A Worker with a missing or short secret
    // would happily mint and accept tokens that anyone could forge, including for
    // the ADMIN seat — and unlike a VPS, a Worker is reachable from the whole
    // internet the moment it is deployed. There is no "development mode" on a
    // public URL.
    throw new Error(
      'JWT_SECRET is not set or is shorter than 32 characters. Set it with:\n'
      + '  npx wrangler secret put JWT_SECRET\n'
      + 'Generate one with:\n'
      + "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
    );
  }
  const int = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
  return Object.freeze({
    env: 'production',
    isProduction: true,
    host: '0.0.0.0',
    port: 443,
    publicOrigin: env.PUBLIC_ORIGIN || null,
    logLevel: env.LOG_LEVEL || 'info',
    db: { file: null, driver: 'd1', wal: false },
    jwt: {
      secret,
      ephemeral: false,
      source: 'env',
      algorithm: 'HS256',
      ttlHours: int(env.SESSION_TTL_HOURS, 12),
      issuer: 'stockridge',
      audience: 'stockridge-app',
    },
    security: {
      maxFailedLogins: int(env.MAX_FAILED_LOGINS, 8),
      loginWindowMinutes: int(env.LOGIN_WINDOW_MINUTES, 15),
      lockoutMinutes: int(env.LOGIN_MINUTES, 15),
      bcryptCost: int(env.PIN_HASH_COST, 12),
      rateLimit: { windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60000), max: int(env.RATE_LIMIT_MAX, 600) },
      corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
      trustProxy: true,
      maxBodyBytes: int(env.MAX_BODY_BYTES, 4 * 1024 * 1024),
      maxLogoBytes: int(env.MAX_LOGO_BYTES, 500 * 1024),
    },
    app: {
      autoseed: false,
      productName: env.PRODUCT_NAME || 'StockRidge',
      version: env.APP_VERSION || '1.0.0',
      timezone: 'Africa/Lagos',
      timezoneOffsetHours: 1,
      defaultCurrency: 'NGN',
      retention: {
        syncLogDays: int(env.RETENTION_SYNC_LOG_DAYS, 90),
        idempotencyHours: int(env.RETENTION_IDEMPOTENCY_HOURS, 72),
        auditLogDays: int(env.RETENTION_AUDIT_LOG_DAYS, 730),
        loginAttemptsDays: int(env.RETENTION_LOGIN_ATTEMPTS_DAYS, 30),
      },
      scheduler: { enabled: true, intervalMinutes: 60 },
    },
  });
}

/**
 * The same authentication rules as the Node backend: token verified, session not
 * revoked, user still active and still holding the role the token claims.
 *
 * The database is authoritative, not the token. A user demoted or deactivated
 * five minutes ago must not keep operating on a token minted before the change —
 * and on a shop-floor product where a leaver keeps their device, that is not a
 * hypothetical.
 */
export function makeWorkerAuthenticator(db, config) {
  return async function authenticate(req) {
    const token = auth.extractToken(req);
    if (!token) throw Object.assign(new Error('Sign in to continue.'), { status: 401, code: 'UNAUTHENTICATED' });

    const verified = auth.verifyToken(token, {
      secret: config.jwt.secret, issuer: config.jwt.issuer, audience: config.jwt.audience,
    });
    if (!verified.valid) {
      const messages = {
        expired: 'Your session has expired. Sign in again.',
        bad_signature: 'This session token is not valid. Sign in again.',
      };
      throw Object.assign(new Error(messages[verified.reason] || 'This session token is not valid. Sign in again.'),
        { status: 401, code: verified.reason === 'expired' ? 'SESSION_EXPIRED' : 'INVALID_TOKEN' });
    }

    const session = await db.prepare(
      "SELECT * FROM user_sessions WHERE session_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')"
    ).bind(verified.payload.sid).first();
    if (!session) throw Object.assign(new Error('This session has been signed out. Sign in again.'), { status: 401, code: 'SESSION_REVOKED' });

    const user = await db.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').bind(verified.payload.sub).first();
    if (!user) throw Object.assign(new Error('This account no longer exists.'), { status: 401, code: 'USER_GONE' });
    if (Number(user.is_active) !== 1) throw Object.assign(new Error('This account is deactivated.'), { status: 403, code: 'USER_INACTIVE' });
    if (verified.payload.ver !== (Number(user.pin_version) || 0)) {
      throw Object.assign(new Error('Your PIN was changed, so this session was signed out.'), { status: 401, code: 'SESSION_SUPERSEDED' });
    }

    return { ...(await scopeLib.loadScope(db, user)), sessionId: verified.payload.sid, user };
  };
}

export { auth };
export default makeWorkerAuthenticator;
