'use strict';
// =====================================================================
// server/routes/auth.js — SIGNING IN, AND WHAT THE CLIENT IS TOLD
// =====================================================================
// POST /api/auth/login is the one endpoint that must never be removed from
// behind a rate limit. A PIN is four to eight digits, so an unlimited login
// endpoint is a brute-force oracle against every account in the shop; eight
// failures in fifteen minutes locks the username (see server/lib/loginThrottle.js).
//
// THREE THINGS THIS ROUTE IS CAREFUL ABOUT
//
// 1. IT DOES NOT LEAK WHICH USERNAMES EXIST. `auth.login` already timing-
//    equalises the missing-user and wrong-PIN paths by running a dummy
//    verification. This route keeps that property by returning the identical
//    message and status for both, and by recording both as a failure against
//    the attempted username — so an attacker cannot enumerate staff by watching
//    which names lock out faster.
//
// 2. A FAILED LOGIN IS AUDITED WITH THE IP AND USER AGENT. The till is shared
//    and a PIN is short; when money goes missing, "who tried to sign in as the
//    manager at 2am from a device that is not the till" is the question, and it
//    can only be answered from a log written at the time.
//
// 3. THE /me RESPONSE CARRIES THE SCOPE, NOT JUST THE ROLE. A client that knows
//    "MANAGER" still has to guess which branches that manager can see. Sending
//    the resolved scope means the UI can hide what the server would refuse
//    anyway, and there is one definition of access rather than two that can
//    drift.
// =====================================================================

const { HttpError } = require('../lib/http');
const { login, authenticate, resolveScope } = require('../middleware/auth');
const { assertLoginAllowed, recordLoginAttempt, clearLoginLock, getLockState, recentAttempts, MAX_FAILED_ATTEMPTS, WINDOW_MINUTES, LOCKOUT_MINUTES } = require('../lib/loginThrottle');
const { recordFromCtx } = require('../lib/audit');
const { hashPin, verifyPin } = require('../../domain/crypto');
const { pin, username: usernameRule } = require('../../domain/validation');
const { navigationFor, roleLabel, atLeast } = require('../../domain/roles');
const { FEATURE_LABELS, planUsage } = require('../../domain/planLimits');
const { getProfile, describeProfile } = require('../../domain/verticals');
const { requireField } = require('../lib/respond');

function clientIp(ctx) {
  return ctx.req.header('CF-Connecting-IP') || ctx.req.header('X-Forwarded-For') || ctx.req.header('X-Real-IP') || null;
}

function mount(app, base = '/api/auth', makeEnv = null) {
  const envOf = (ctx) => (makeEnv ? makeEnv(ctx) : ctx.env);

  /** Sign in with username + PIN. */
  app.post(`${base}/login`, async (ctx) => {
    const env = envOf(ctx);
    const db = env.DB || env.db;
    const secret = env.JWT_SECRET || env.jwtSecret;
    if (!secret) throw new HttpError('The server has no JWT secret configured.', { status: 500, code: 'NO_SECRET' });

    const body = await ctx.req.json();
    const rawUsername = requireField(body, 'username', 'Username');
    const rawPin = requireField(body, 'pin', 'PIN');
    const username = String(rawUsername).trim().toLowerCase();
    const deviceId = body.deviceId ? String(body.deviceId).slice(0, 120) : null;
    const ipAddress = clientIp(ctx);
    const userAgent = ctx.req.header('User-Agent') || null;

    // Throttle FIRST. Checking the PIN before the lock would let an attacker
    // keep guessing during a lockout and simply ignore the refusal.
    try {
      await assertLoginAllowed(db, username);
    } catch (e) {
      if (e && e.name === 'LoginLockedError') {
        await recordFromCtx(ctx, { action: 'LOGIN_FAILURE', entityType: 'USER', entityId: username });
        ctx.header('Retry-After', String(Math.max(60, Math.ceil((e.retryAfterSeconds || LOCKOUT_MINUTES * 60)))));
        throw new HttpError(e.message, { status: 429, code: 'LOGIN_LOCKED' });
      }
      // The throttle FAILS OPEN on an internal error: if the attempts table
      // cannot be read, refusing every login would lock the whole shop out
      // because of a fault in the security furniture. Trading continues and the
      // fault is logged. That trade is deliberate and is documented in
      // loginThrottle.js.
      console.error('[auth] login throttle failed open:', e.message);
    }

    try {
      const result = await login(db, { username, pin: String(rawPin), secret, deviceId });
      await recordLoginAttempt(db, { username, userId: result.user.id, succeeded: true, ipAddress, userAgent });
      await recordFromCtx(ctx, { action: 'LOGIN_SUCCESS', entityType: 'USER', entityId: result.user.id });

      ctx.json({
        ok: true,
        token: result.token,
        sessionId: result.sessionId,
        // The profile the client stores. Deliberately small: it is persisted in
        // localStorage on a shared till, so it carries no PIN hash and nothing
        // that would help an attacker who gets hold of the device.
        profile: {
          id: result.user.id,
          username: result.user.username,
          fullName: result.user.full_name,
          role: result.user.role,
          roleLabel: roleLabel(result.user.role, result.user),
          jobTitle: result.user.job_title || null,
          branchId: result.user.branch_id || null,
          branchName: result.user.branch_name || null,
          businessId: result.user.business_id || result.user.branch_business_id || null,
          businessName: result.user.business_name || null,
          profileCode: result.user.business_profile_code || null,
          navigation: navigationFor(result.user.role),
        },
        scope: serialiseScope(result.scope),
      });
    } catch (e) {
      await recordLoginAttempt(db, { username, userId: null, succeeded: false, ipAddress, userAgent });
      await recordFromCtx(ctx, { action: 'LOGIN_FAILURE', entityType: 'USER', entityId: username });

      // One message for every credential failure. Distinguishing "no such user"
      // from "wrong PIN" would hand an attacker a list of valid usernames for
      // free, and the accounts here are named after real staff.
      if (e instanceof HttpError && ['BAD_CREDENTIALS', 'ACCOUNT_UNAVAILABLE'].includes(e.code)) {
        throw new HttpError('Username or PIN is incorrect.', { status: 401, code: 'BAD_CREDENTIALS' });
      }
      if (e instanceof HttpError && e.code === 'ACCOUNT_DEACTIVATED') throw e; // safe to reveal: it is their own account
      throw e;
    }
  });

  /**
   * Everything the client needs to render the signed-in shell.
   *
   * Guarded, and it re-reads the live user rather than trusting the token, so a
   * user deactivated mid-shift finds out on their next navigation instead of at
   * the end of a twelve-hour token.
   */
  app.get(`${base}/me`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');
    const settings = ctx.get('settings');

    const businesses = scope.allBusinesses
      ? await db.all('SELECT id, name, profile_code, is_active FROM businesses WHERE is_deleted = 0 ORDER BY name')
      : await db.all(`SELECT id, name, profile_code, is_active FROM businesses
          WHERE is_deleted = 0 AND id IN (${[...(scope.businessIds || [])].map(() => '?').join(',') || "''"}) ORDER BY name`,
      [...(scope.businessIds || [])]);

    const branches = scope.allBranches
      ? await db.all('SELECT id, business_id, name, code, branch_type, city, state, is_active FROM branches WHERE is_deleted = 0 ORDER BY name')
      : await db.all(`SELECT id, business_id, name, code, branch_type, city, state, is_active FROM branches
          WHERE is_deleted = 0 AND id IN (${[...(scope.branchIds || [])].map(() => '?').join(',') || "''"}) ORDER BY name`,
      [...(scope.branchIds || [])]);

    const profile = user.business_profile_code ? describeProfile(getProfile(user.business_profile_code)) : null;

    ctx.json({
      ok: true,
      user: {
        id: user.id, username: user.username, fullName: user.full_name,
        role: user.role, roleLabel: roleLabel(user.role, user), jobTitle: user.job_title || null,
        email: user.email || null, phone: user.phone || null,
        commissionRatePct: user.commission_rate_pct == null ? null : Number(user.commission_rate_pct),
        branch: user.branch_id ? { id: user.branch_id, name: user.branch_name } : null,
        business: (user.business_id || user.branch_business_id) ? { id: user.business_id || user.branch_business_id, name: user.business_name } : null,
        navigation: navigationFor(user.role),
      },
      scope: serialiseScope(scope),
      businesses,
      branches,
      vertical: profile,
      // Settings the client needs to render correctly. Only the fields that are
      // safe and useful — never another user's PIN hash or the JWT secret.
      settings: publicSettings(settings),
      featureLabels: FEATURE_LABELS,
    });
  });

  /** Sign out. Retires this session so the token stops working immediately. */
  app.post(`${base}/logout`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    // Clearing the row (rather than marking it) is what makes the token dead on
    // the next request: `authenticate` compares the token's sid against this
    // row, so a missing row is a rejected token.
    await db.run('DELETE FROM user_sessions WHERE user_id = ?', [String(user.id)]);
    await recordFromCtx(ctx, { action: 'LOGOUT', entityType: 'USER', entityId: user.id });
    ctx.json({ ok: true, message: 'Signed out.' });
  });

  /** Change your own PIN. Requires the current one — a shared till is not a trusted device. */
  app.post(`${base}/change-pin`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();

    const current = requireField(body, 'currentPin', 'Current PIN');
    const next = requireField(body, 'newPin', 'New PIN');

    const row = await db.first('SELECT pin_hash FROM users WHERE id = ? AND is_deleted = 0', [String(user.id)]);
    if (!row) throw new HttpError('Your account could not be found.', { status: 404, code: 'USER_NOT_FOUND' });
    if (!(await verifyPin(String(current), row.pin_hash))) {
      throw new HttpError('Your current PIN is incorrect.', { status: 401, code: 'BAD_CREDENTIALS' });
    }

    const check = pin(String(next));
    if (!check.ok) throw new HttpError(check.error, { status: 400, code: check.code, fields: { newPin: check.error } });
    if (await verifyPin(String(next), row.pin_hash)) {
      // Reusing the same PIN reads as "changed" while leaving the old one valid
      // to anyone who watched it being typed. Refusing is the honest answer.
      throw new HttpError('Choose a PIN different from your current one.', { status: 400, code: 'PIN_UNCHANGED', fields: { newPin: 'Choose a different PIN.' } });
    }

    const hashed = await hashPin(String(next));
    await db.run("UPDATE users SET pin_hash = ?, pin_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [hashed.stored, String(user.id)]);
    // Every other session is retired: if the PIN changed because somebody else
    // knew it, their session must not survive the change.
    await db.run('DELETE FROM user_sessions WHERE user_id = ? AND session_id <> ?', [String(user.id), String(ctx.get('token') || '')]);
    await recordFromCtx(ctx, { action: 'USER_PIN_RESET', entityType: 'USER', entityId: user.id });

    ctx.json({ ok: true, message: 'PIN changed. Sign in again on any other device you were using.' });
  });

  /**
   * Lock state for a username. Manager and above: a cashier able to look up
   * whether a colleague is locked out learns something about them, and a
   * manager investigating a lockout needs it.
   */
  app.get(`${base}/lock-state`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can check sign-in lockouts.', { status: 403, code: 'ROLE_REQUIRED' });
    const target = ctx.req.queryParam('username');
    if (!target) throw new HttpError('Pass ?username= to check.', { status: 400, code: 'MISSING_FIELD' });
    ctx.json({ ok: true, username: String(target).toLowerCase(), ...(await getLockState(db, String(target).toLowerCase())) });
  });

  /**
   * Clear a lockout. Owner and above, and audited, because it is the override of
   * a security control: an attacker who has persuaded a manager to unlock a
   * username gets another eight attempts, so the decision has to belong to the
   * proprietor and be on the record.
   */
  app.post(`${base}/unlock`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only the owner or an administrator can clear a sign-in lockout.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const target = String(requireField(body, 'username', 'Username')).toLowerCase();
    const reason = requireField(body, 'reason', 'Reason');
    if (String(reason).trim().length < 4) throw new HttpError('Give a reason of at least four characters — this overrides a security control and is reviewed.', { status: 400, code: 'REASON_REQUIRED' });

    const state = await getLockState(db, target);
    await clearLoginLock(db, target);
    await recordFromCtx(ctx, { action: 'LOGIN_LOCK_CLEARED', entityType: 'USER', entityId: target, before: state, after: { reason: String(reason).slice(0, 500) } });
    ctx.json({ ok: true, username: target, message: `Lockout cleared for ${target}.` });
  });

  /** Recent sign-in attempts. Owner and above — it reads like a security log because it is one. */
  app.get(`${base}/attempts`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only the owner or an administrator can review sign-in attempts.', { status: 403, code: 'ROLE_REQUIRED' });
    const target = ctx.req.queryParam('username');
    const limit = Math.min(Number(ctx.req.queryParam('limit')) || 50, 200);
    const rows = await recentAttempts(db, { username: target ? String(target).toLowerCase() : null, limit });
    ctx.json({
      ok: true, data: rows,
      policy: { maxFailedAttempts: MAX_FAILED_ATTEMPTS, windowMinutes: WINDOW_MINUTES, lockoutMinutes: LOCKOUT_MINUTES },
    });
  });

  /**
   * Validate a token without a full /me. The service worker uses this on resume
   * to decide whether to flush the offline queue or send the user to sign in —
   * a cheap check that avoids replaying two hundred queued sales against an
   * expired session.
   */
  app.get(`${base}/verify`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const env = ctx.env;
    const token = ctx.req.header('Authorization')?.replace(/^Bearer\s+/i, '') || ctx.req.header('X-Stockridge-Token');
    if (!token) throw new HttpError('No token supplied.', { status: 401, code: 'NO_TOKEN' });
    const { user } = await authenticate(db, token, env.JWT_SECRET || env.jwtSecret);
    const scope = await resolveScope(db, user);
    ctx.json({ ok: true, userId: user.id, role: user.role, username: user.username, scope: serialiseScope(scope) });
  });

  void usernameRule;
}

/** Sets cannot cross a JSON boundary, so the scope is flattened for the client. */
function serialiseScope(scope) {
  if (!scope) return null;
  return {
    role: scope.role,
    allBusinesses: scope.allBusinesses,
    allBranches: scope.allBranches,
    businessIds: scope.businessIds ? [...scope.businessIds] : null,
    branchIds: scope.branchIds ? [...scope.branchIds] : null,
    pinnedBranchId: scope.pinnedBranchId,
    pinnedBusinessId: scope.pinnedBusinessId,
  };
}

/**
 * The subset of client_settings the client is allowed to see.
 *
 * An explicit allowlist rather than `...settings`, because that table will grow
 * and a new column must not become visible to every signed-in user by accident.
 */
function publicSettings(settings) {
  if (!settings) return null;
  const keys = [
    'business_name', 'logo_data_url', 'subscription_status', 'subscription_plan', 'subscription_renewal_date',
    'vat_enabled', 'vat_rate_percent', 'receipt_footer_text',
    'attendance_module_enabled', 'warranty_module_enabled', 'instalment_module_enabled', 'delivery_module_enabled',
    'multi_branch_enabled', 'multi_business_enabled', 'serial_tracking_enabled', 'offline_sync_enabled',
    'staff_can_void_sales', 'staff_void_window_minutes', 'staff_can_adjust_stock', 'staff_adjustment_max_units',
    'staff_can_adjust_stock_value', 'staff_can_sell_on_credit', 'staff_credit_max', 'staff_discount_max_pct',
    'staff_can_spend_from_safe', 'staff_safe_spend_max',
    'managers_can_void_sales', 'managers_can_approve_expenses', 'managers_can_edit_prices', 'managers_can_override_credit_limit',
    'instalment_max_interest_pct', 'instalment_max_tenure_months', 'instalment_min_deposit_pct',
    'credit_max_days', 'layaway_max_days', 'layaway_min_deposit_pct', 'change_owed_expiry_days',
    'return_window_days_default', 'low_stock_alert_enabled', 'expiry_alert_days', 'compliance_alert_days',
    'admin_contact_name', 'admin_contact_phone', 'admin_contact_email',
  ];
  const out = {};
  for (const k of keys) if (settings[k] !== undefined) out[k] = settings[k];
  return out;
}

module.exports = { mount, publicSettings, serialiseScope };
