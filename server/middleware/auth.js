'use strict';
// =====================================================================
// server/middleware/auth.js — AUTHENTICATION AND AUTHORITY MIDDLEWARE
// =====================================================================
// THE CENTRAL POLICY: A TOKEN'S CLAIMS ARE NEVER TRUSTED ON THEIR OWN.
//
// Every authenticated request re-fetches the live user row. The token says
// who the caller CLAIMS to be; the database says who they ARE right now.
// The difference matters concretely:
//
//   - A cashier deactivated mid-shift loses access on their NEXT request,
//     not when their token expires twelve hours later.
//   - A manager transferred from Lagos to Minna stops seeing Lagos's cash
//     immediately. Under a claims-only design they would keep seeing it
//     until the token expired, which is precisely the window in which a
//     departing employee does damage.
//   - An owner who tightens a permission switch takes effect at once.
//
// The cost is one extra indexed primary-key lookup per request. That is
// cheap, and it is the reason a role change in this system is not a
// security event.
//
// Sessions are also single-active-per-user (user_sessions.session_id):
// signing in on a second device invalidates the first. A shared shop login
// on a phone that has left the premises is otherwise indistinguishable from
// the person still at the counter.
// =====================================================================

const { verifyToken, signToken, hashPin, verifyPin, newId, PBKDF2_ITERATIONS } = require('../../domain/crypto');
const { buildScope } = require('../../domain/access');
const { ROLES, atLeast, isRole } = require('../../domain/roles');
const { HttpError } = require('../lib/http');

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // one long shop day including overtime

/** Everything about a user that the app needs on every request. */
const USER_SELECT = `
  SELECT u.id, u.business_id, u.branch_id, u.full_name, u.username, u.role,
         u.job_title, u.email, u.phone, u.is_active, u.commission_rate_pct,
         b.name AS branch_name, b.business_id AS branch_business_id,
         b.latitude AS branch_latitude, b.longitude AS branch_longitude,
         b.geofence_radius_meters AS branch_geofence_radius,
         b.attendance_mode AS branch_attendance_mode,
         bs.name AS business_name, bs.profile_code AS business_profile_code,
         bs.profile_overrides_json AS business_profile_overrides
  FROM users u
  LEFT JOIN branches b ON b.id = u.branch_id
  LEFT JOIN businesses bs ON bs.id = COALESCE(u.business_id, b.business_id)
  WHERE u.id = ? AND u.is_deleted = 0`;

async function loadUser(db, userId) {
  if (!userId) return null;
  const row = await db.first(USER_SELECT, [String(userId)]);
  return row || null;
}

/** Businesses a user can reach: their own, plus explicit grants. */
async function accessibleBusinessIds(db, user) {
  if (!user) return [];
  const rows = await db.all(
    `SELECT business_id FROM user_business_access
     WHERE user_id = ? AND is_deleted = 0 AND revoked_at IS NULL`,
    [String(user.id)],
  );
  const ids = new Set(rows.map((r) => String(r.business_id)));
  if (user.business_id) ids.add(String(user.business_id));
  if (user.branch_business_id) ids.add(String(user.branch_business_id));
  return Array.from(ids);
}

/** Build the resolved scope object used by every access decision. */
async function resolveScope(db, user) {
  const businessIds = await accessibleBusinessIds(db, user);
  let allBranchRows = null;
  if (!user.branch_id) {
    allBranchRows = await db.all('SELECT id, business_id FROM branches WHERE is_deleted = 0 AND is_active = 1');
  }
  return buildScope(user, { businessIds, allBranchIds: allBranchRows });
}

// ---------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------
/**
 * Authenticate with username + PIN.
 *
 * Returns a token and a profile object shaped for the client's session
 * store. The caller (routes/auth.js) wraps this with throttling and audit
 * recording, which are kept OUT of here so this function stays testable
 * without a database of login attempts.
 */
async function login(db, { username, pin, secret, deviceId = null }) {
  const uname = String(username || '').trim().toLowerCase();
  if (!uname) throw new HttpError('Enter your username.', { status: 400, code: 'USERNAME_REQUIRED' });
  if (pin == null || String(pin).trim() === '') throw new HttpError('Enter your PIN.', { status: 400, code: 'PIN_REQUIRED' });

  // The lookup is by username regardless of case, but the STORED username is
  // canonical lowercase. Comparing case-insensitively avoids a support ticket
  // about "Ada" not being able to sign in as "ada".
  const row = await db.first(
    'SELECT id, username, pin_hash, role, is_active, branch_id, business_id, full_name FROM users WHERE lower(username) = ? AND is_deleted = 0 LIMIT 1',
    [uname],
  );

  // A missing user and a wrong PIN must take a similar amount of time and
  // return the same message, or the endpoint becomes a username oracle —
  // with a 4-digit PIN and a known username, an attacker has a much easier
  // job than with an unknown one.
  if (!row) {
    // Burn comparable time against a dummy hash. The iteration count comes from
    // the shared constant, never a literal: this string previously hard-coded
    // 120,000 and would have kept failing on Workers even after the constant was
    // corrected, quietly turning the timing defence into no defence at all.
    await verifyPin(String(pin), `pbkdf2$sha256$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$${'0'.repeat(64)}`);
    throw new HttpError('Username or PIN is incorrect.', { status: 401, code: 'BAD_CREDENTIALS' });
  }

  const pinOk = await verifyPin(String(pin), row.pin_hash);
  if (!pinOk) throw new HttpError('Username or PIN is incorrect.', { status: 401, code: 'BAD_CREDENTIALS' });

  if (!Number(row.is_active)) {
    throw new HttpError(
      'This account has been deactivated. If you believe that is a mistake, ask a manager or the owner to reactivate it.',
      { status: 403, code: 'ACCOUNT_DEACTIVATED' },
    );
  }

  const user = await loadUser(db, row.id);
  if (!user) throw new HttpError('This account could not be loaded. Ask a manager to check it.', { status: 403, code: 'ACCOUNT_UNAVAILABLE' });

  const sessionId = newId();
  const token = await signToken({ sub: user.id, role: user.role, sid: sessionId }, secret, { ttlSeconds: TOKEN_TTL_SECONDS });

  // Single active session per user. INSERT OR REPLACE is atomic and means a
  // second sign-in silently retires the first; the retired device gets a
  // clear message on its next request rather than mysteriously failing.
  await db.run(
    `INSERT INTO user_sessions (user_id, session_id, issued_at, updated_at)
     VALUES (?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET session_id = excluded.session_id, issued_at = datetime('now'), updated_at = datetime('now')`,
    [String(user.id), sessionId],
  );
  await db.run("UPDATE users SET last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [String(user.id)]);

  const scope = await resolveScope(db, user);
  return { token, sessionId, user, scope, deviceId };
}

/** Verify a token and confirm its session is still the active one. */
async function authenticate(db, token, secret) {
  let payload;
  try {
    payload = await verifyToken(token, secret);
  } catch (e) {
    const status = e.code === 'TOKEN_EXPIRED' ? 401 : 401;
    throw new HttpError(e.message || 'Invalid or expired session.', { status, code: e.code || 'BAD_TOKEN' });
  }
  const user = await loadUser(db, payload.sub);
  if (!user) throw new HttpError('This account no longer exists.', { status: 401, code: 'USER_GONE' });
  if (!Number(user.is_active)) {
    throw new HttpError('This account has been deactivated. Ask a manager to reactivate it if that is a mistake.', { status: 403, code: 'ACCOUNT_DEACTIVATED' });
  }
  if (payload.sid) {
    const session = await db.first('SELECT session_id FROM user_sessions WHERE user_id = ?', [String(user.id)]);

    // A MISSING ROW IS A REVOKED TOKEN, AND THIS IS THE ONLY PLACE THAT SAYS SO.
    //
    // The check below used to be `if (session && session.session_id !== payload.sid)`,
    // which reads as "reject a token whose session has been replaced" and
    // actually means "accept a token whose session has been deleted". Sign-out
    // deletes the row — so signing out did nothing at all, and on a shared till
    // the next person inherited the previous cashier's session until the token
    // expired twelve hours later. A live deployment is where this surfaced: the
    // token still returned 200 from /api/auth/me after a successful sign-out.
    //
    // The comment on the logout route already claimed a missing row is a
    // rejected token. It was aspirational. Now it is true.
    //
    // Safe to be strict because nothing else issues a token: `login` both signs
    // the token and writes this row, in that order, in one place.
    if (!session) {
      throw new HttpError(
        'You have been signed out. Sign in again to continue.',
        { status: 401, code: 'SESSION_REVOKED' },
      );
    }
    if (session.session_id !== payload.sid) {
      throw new HttpError(
        'You have been signed out because this account signed in somewhere else. If that was not you, tell a manager — your PIN may be known to somebody else.',
        { status: 401, code: 'SESSION_SUPERSEDED' },
      );
    }
  }
  // A role or branch change invalidates a token's claims even though the
  // signature is still valid: the caller's authority comes from `user`, not
  // from the token.
  return { user, payload };
}

// ---------------------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------------------
function extractToken(ctx) {
  const header = ctx.req.header('Authorization') || ctx.req.header('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  // The PWA also sends the token in a custom header for requests the service
  // worker replays from the offline queue, where re-adding Authorization is
  // awkward. Both are accepted; neither is preferred.
  const alt = ctx.req.header('X-Stockridge-Token');
  return alt ? String(alt).trim() : null;
}

/** Require a valid session. Sets ctx.user and ctx.scope. */
function authRequired({ secret } = {}) {
  return async function authMiddleware(ctx, next) {
    const token = extractToken(ctx);
    if (!token) {
      throw new HttpError('Please sign in to continue.', { status: 401, code: 'NO_TOKEN' });
    }
    const jwtSecret = secret || (ctx.env && (ctx.env.JWT_SECRET || ctx.env.jwtSecret));
    if (!jwtSecret) throw new HttpError('The server has no JWT secret configured.', { status: 500, code: 'NO_SECRET' });

    const { user } = await authenticate(ctx.env.DB || ctx.env.db, token, jwtSecret);
    const scope = await resolveScope(ctx.env.DB || ctx.env.db, user);
    ctx.set('user', user);
    ctx.set('scope', scope);
    ctx.set('token', token);
    await next();
  };
}

/** Require at least a given role. */
function requireRole(minimumRole) {
  if (!isRole(minimumRole)) throw new Error(`requireRole: unknown role "${minimumRole}"`);
  return async function roleMiddleware(ctx, next) {
    const user = ctx.get('user');
    if (!user) throw new HttpError('Please sign in to continue.', { status: 401, code: 'NO_TOKEN' });
    if (!atLeast(user.role, minimumRole)) {
      throw new HttpError(
        `This screen needs ${minimumRole.toLowerCase()} access or above. Your role is ${String(user.role).toLowerCase()}.`,
        { status: 403, code: 'ROLE_REQUIRED' },
      );
    }
    await next();
  };
}

const managerOnly = requireRole(ROLES.MANAGER);
const ownerOnly = requireRole(ROLES.OWNER);
const adminOnly = requireRole(ROLES.ADMIN);

/**
 * Convenience for a route: the authenticated user, or a 401.
 * Lets a route body read `const user = ctx.user` instead of `ctx.get('user')`.
 */
function decorateContext(ctx) {
  Object.defineProperty(ctx, 'user', { get: () => ctx.get('user'), configurable: true });
  Object.defineProperty(ctx, 'scope', { get: () => ctx.get('scope'), configurable: true });
  Object.defineProperty(ctx, 'db', { get: () => ctx.env.DB || ctx.env.db, configurable: true });
  return ctx;
}

module.exports = {
  TOKEN_TTL_SECONDS, USER_SELECT,
  loadUser, accessibleBusinessIds, resolveScope,
  login, authenticate, extractToken,
  authRequired, requireRole, managerOnly, ownerOnly, adminOnly, decorateContext,
};
