// =====================================================================
// server/routes/index.js — THE API SURFACE
// =====================================================================
// Every route lives in one place so the whole API can be read, and so an
// authorisation rule cannot be applied in nine files and missed in the tenth.
//
// ---------------------------------------------------------------------
// THE RULE EVERY ROUTE FOLLOWS
// ---------------------------------------------------------------------
// 1. Authenticate once, in the handler factory. A route that is not marked
//    `public` cannot run without a scope.
// 2. Resolve the branch/business from the SCOPE, never from the request body.
//    A body field is a claim; the scope is a fact. `resolveMutationBranchId`
//    refuses a claim that disagrees with the fact.
// 3. Every list query goes through `branchFilter`/`businessFilter`, which return
//    an empty fragment for an unrestricted user. That means there is no `if
//    (role === 'OWNER')` in a WHERE clause anywhere — and therefore no query
//    where someone forgot the branch condition.
// 4. Mutations are idempotent when they cost money. The POS retries a queued
//    sale after a dropped connection; without an idempotency key that is a
//    second stock decrement and a second drawer total.
// 5. Errors carry a `code`, so the frontend can say something specific instead
//    of "an error occurred".

'use strict';

const { Router, httpError, publicRoute } = require('../lib/http');
const auth = require('../lib/auth');
const scopeLib = require('../lib/scope');
const core = require('../../shared/services/coreService');
const gl = require('../../shared/services/glService');
const salesService = require('../../shared/services/salesService');
const M = require('../../shared/lib/money');
const V = require('../../shared/lib/validate');
const IDS = require('../../shared/lib/ids');
const VERTICALS = require('../../shared/lib/verticals');
const RECEIVING = require('../../shared/lib/receiving');
const STOCK = require('../../shared/lib/stock');
const PAYMENTS = require('../../shared/lib/payments');
const CREDIT = require('../../shared/lib/credit');
const LAYAWAY = require('../../shared/lib/layaway');
const INSTAL = require('../../shared/lib/instalments');
const WARRANTY = require('../../shared/lib/warranty');
const DELIVERY = require('../../shared/lib/delivery');
const WHT = require('../../shared/lib/wht');
const VATLIB = require('../../shared/lib/vat');
const FX = require('../../shared/lib/fx');
const HASHCHAIN = require('../../shared/lib/hashchain');
const TG = require('../../shared/lib/timegeo');

// ---------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------
function requireScope(req) {
  if (!req.scope) throw httpError(401, 'Sign in to continue.', 'UNAUTHENTICATED');
  return req.scope;
}

function pagination(req, { defaultLimit = 50, maxLimit = 500 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defaultLimit));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return { limit, offset };
}

async function writeGuard(req) {
  await core.assertSubscriptionAllowsWrites(req.db, requireScope(req));
}

/** Idempotency: execute once per (key, user), replaying the stored response. */
async function withIdempotency(req, key, fn) {
  const db = req.db;
  const s = requireScope(req);
  if (!key) return fn();

  const crypto = require('node:crypto');
  const requestHash = crypto.createHash('sha256')
    .update(JSON.stringify(req.body || {})).digest('hex').slice(0, 32);

  const existing = await db.prepare(
    'SELECT * FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?'
  ).bind(String(key), String(s.userId)).first();

  if (existing) {
    if (existing.request_hash !== requestHash) {
      // Same key, different payload: a client bug that would otherwise silently
      // replay yesterday's answer to today's different question.
      throw httpError(409,
        'That idempotency key was already used for a different request. Generate a new key for a new action.',
        'IDEMPOTENCY_KEY_REUSED');
    }
    if (existing.status === 'COMPLETED' && existing.response_body) {
      return { ...JSON.parse(existing.response_body), __replayed: true };
    }
    if (existing.status === 'IN_PROGRESS') {
      throw httpError(409, 'That request is still being processed. Try again in a moment.', 'IDEMPOTENCY_IN_PROGRESS');
    }
  }

  const id = IDS.newId();
  const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  if (!existing) {
    await db.prepare(`INSERT INTO idempotency_keys
        (idempotency_key, user_id, business_id, branch_id, method, path, request_hash, status, device_id, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), ?)`)
      .bind(String(key), String(s.userId), s.businessId, s.branchId, req.method, req.url.split('?')[0],
        requestHash, 'IN_PROGRESS', req.headers['x-device-id'] || null, expiresAt).run();
  }

  try {
    const result = await fn();
    await db.prepare(`UPDATE idempotency_keys SET status='COMPLETED', response_status=200, response_body=?, completed_at=datetime('now')
       WHERE idempotency_key = ? AND user_id = ?`)
      .bind(JSON.stringify(result), String(key), String(s.userId)).run();
    return result;
  } catch (err) {
    // A failed attempt is recorded, not left IN_PROGRESS forever: the client
    // must be able to retry the same key after fixing the input.
    await db.prepare(`UPDATE idempotency_keys SET status='FAILED', response_status=?, completed_at=datetime('now')
       WHERE idempotency_key = ? AND user_id = ?`)
      .bind(Number(err.status) || 500, String(key), String(s.userId)).run();
    throw err;
  }
}

// =====================================================================
// ROUTES
// =====================================================================
function buildRoutes({ config }) {
  const router = new Router();

  // -------------------------------------------------------------------
  // HEALTH
  // -------------------------------------------------------------------
  router.get('/api/health', publicRoute(async (req) => {
    const info = req.db.info();
    const settings = await core.getSettings(req.db);
    let schemaOk = true; let tableCount = 0;
    try {
      const r = await req.db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").first();
      tableCount = r ? r.c : 0;
    } catch (e) { schemaOk = false; }
    return {
      ok: schemaOk,
      service: settings.product_name || 'StockRidge',
      version: config.app.version,
      time: new Date().toISOString(),
      time_wat: TG.watTimestamp(),
      timezone: TG.TIMEZONE_LABEL,
      database: { driver: info.driver, sqlite: info.sqliteVersion, tables: tableCount, journal: info.journalMode },
      uptime_seconds: Math.round(process.uptime()),
    };
  }));

  // -------------------------------------------------------------------
  // AUTH
  // -------------------------------------------------------------------
  router.post('/auth/login', publicRoute(async (req) => {
    const db = req.db;
    const username = String((req.body.username || '')).trim().toLowerCase();
    const pin = String(req.body.pin || '');
    const deviceId = req.headers['x-device-id'] || null;

    if (!username || !pin) throw httpError(400, 'Enter your username and PIN.', 'MISSING_CREDENTIALS');

    // THROTTLE FIRST. Verifying the PIN before checking the lock hands an
    // attacker a fast oracle and only throttles afterwards — which for a
    // 4-digit keyspace is the difference between three minutes and a month.
    await auth.assertLoginAllowed(db, username, {
      maxFailed: config.security.maxFailedLogins,
      windowMinutes: config.security.loginWindowMinutes,
      lockoutMinutes: config.security.lockoutMinutes,
    });

    const user = await db.prepare('SELECT * FROM users WHERE username = ? AND is_deleted = 0').bind(username).first();
    const settings = await core.getSettings(db);

    // A user that does not exist and a user whose PIN is wrong must look
    // identical from outside, or the endpoint becomes a username enumerator.
    const failure = (reason) => {
      auth.recordLoginAttempt(db, {
        username, userId: user ? user.id : null, succeeded: false,
        ipAddress: req.ip, userAgent: req.headers['user-agent'], deviceId, failureReason: reason,
      });
      throw httpError(401, 'Incorrect username or PIN.', 'BAD_CREDENTIALS');
    };

    if (!user) failure('UNKNOWN_USER');
    if (!auth.verifyPin(pin, user.pin_hash)) failure('BAD_PIN');
    if (Number(user.is_active) !== 1) {
      await auth.recordLoginAttempt(db, { username, userId: user.id, succeeded: false, ipAddress: req.ip, deviceId, failureReason: 'INACTIVE_USER' });
      throw httpError(403, 'This account is deactivated. Ask a manager to reactivate it.', 'USER_INACTIVE');
    }
    // ADMIN is the vendor seat and must never be blocked by the client's own
    // subscription state — otherwise a billing problem locks the vendor out of
    // the very instance they need in order to fix it.
    if (user.role !== 'ADMIN' && ['SUSPENDED', 'EXPIRED'].includes(String(settings.subscription_status).toUpperCase())) {
      await auth.recordLoginAttempt(db, { username, userId: user.id, succeeded: false, ipAddress: req.ip, deviceId, failureReason: 'SUSPENDED_SUBSCRIPTION' });
      throw httpError(402,
        `This subscription is ${String(settings.subscription_status).toLowerCase()}. Records can still be viewed but not changed. Contact ${core.supportLine(settings)}.`,
        'SUBSCRIPTION_NOT_ACTIVE');
    }

    // Transparent key-strengthening: a database seeded under older parameters
    // upgrades itself as people sign in, with no migration and no forced reset.
    if (auth.needsRehash(user.pin_hash)) {
      await db.prepare("UPDATE users SET pin_hash = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(auth.hashPin(pin), user.id).run();
    }

    const sc = await scopeLib.loadScope(db, user);
    const sessionId = IDS.newId();
    const ttlHours = config.jwt.ttlHours;
    const token = auth.signToken({
      userId: user.id, sessionId, role: user.role,
      businessId: sc.businessId, branchId: sc.branchId, username: user.username,
    }, { secret: config.jwt.secret, ttlHours, issuer: config.jwt.issuer, audience: config.jwt.audience });

    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.prepare(`INSERT INTO user_sessions
        (id, session_id, user_id, branch_id, device_id, ip_address, user_agent, issued_at, expires_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?, datetime('now'), ?, datetime('now'))`)
      .bind(IDS.newId(), sessionId, user.id, sc.branchId, deviceId, req.ip,
        String(req.headers['user-agent'] || '').slice(0, 220), expiresAt).run();

    await auth.recordLoginAttempt(db, { username, userId: user.id, succeeded: true, ipAddress: req.ip, deviceId, branchId: sc.branchId });
    await db.prepare("UPDATE users SET last_login_at = datetime('now'), last_login_branch_id = ? WHERE id = ?")
      .bind(sc.branchId, user.id).run();

    return {
      token,
      expires_at: expiresAt,
      user: {
        id: user.id, username: user.username, full_name: user.full_name,
        role: user.role, display_role: scopeLib.displayRole(user),
        job_title: user.job_title, phone: user.phone,
        must_change_pin: !!Number(user.must_change_pin),
      },
      scope: {
        all_businesses: sc.allBusinesses, business_id: sc.businessId, business_ids: sc.businessIds,
        all_branches: sc.allBranches, branch_id: sc.branchId, branch_ids: sc.branchIds, pinned: sc.pinned,
      },
    };
  }));

  router.post('/auth/logout', async (req) => {
    const s = requireScope(req);
    const token = auth.extractToken(req);
    const verified = token ? auth.verifyToken(token, config.jwt) : null;
    if (verified && verified.valid) {
      await req.db.prepare("UPDATE user_sessions SET revoked_at = datetime('now'), revoke_reason='logout' WHERE session_id = ?")
        .bind(verified.payload.sid).run();
    }
    return { ok: true, userId: s.userId };
  });

  router.get('/auth/me', async (req) => {
    const s = requireScope(req);
    const user = await req.db.prepare('SELECT * FROM users WHERE id = ?').bind(s.userId).first();
    if (!user) throw httpError(401, 'This session no longer matches a user.', 'USER_GONE');
    const [businesses, branches, settings, plan] = await Promise.all([
      s.allBusinesses
        ? req.db.prepare('SELECT id, name, vertical_code, trading_name, is_active FROM businesses WHERE is_deleted = 0 ORDER BY sort_order, name').all()
        : req.db.prepare('SELECT id, name, vertical_code, trading_name, is_active FROM businesses WHERE id = ? AND is_deleted = 0').bind(s.businessId).all(),
      s.allBranches
        ? req.db.prepare(`SELECT id, name, code, business_id, branch_type, area, state_code, is_active FROM branches
                           WHERE is_deleted = 0 ${scopeLib.businessFilter(s, 'business_id').sql} ORDER BY sort_order, name`)
          .bind(...scopeLib.businessFilter(s, 'business_id').params).all()
        : req.db.prepare('SELECT id, name, code, business_id, branch_type, area, state_code, is_active FROM branches WHERE id = ?').bind(s.branchId).all(),
      core.getSettings(req.db),
      s.rank >= scopeLib.rank('OWNER') || s.isVendor ? core.getPlanUsage(req.db) : null,
    ]);
    return {
      user: {
        id: user.id, username: user.username, full_name: user.full_name, role: user.role,
        display_role: scopeLib.displayRole(user), job_title: user.job_title, phone: user.phone, email: user.email,
        must_change_pin: !!Number(user.must_change_pin), last_login_at: user.last_login_at,
      },
      scope: {
        all_businesses: s.allBusinesses, business_id: s.businessId,
        all_branches: s.allBranches, branch_id: s.branchId, pinned: s.pinned,
      },
      businesses, branches,
      // Which optional modules are on, so the frontend can hide navigation
      // rather than show screens that are always empty.
      modules: businesses.reduce((acc, b) => ({ ...acc, [b.id]: null }), {}),
      settings: {
        product_name: settings.product_name, logo_data_url: settings.logo_data_url,
        timezone: TG.TIMEZONE_LABEL, currency: 'NGN',
        support: { name: settings.support_contact_name, phone: settings.support_contact_phone, email: settings.support_contact_email },
      },
      plan,
    };
  });

  router.post('/auth/change-pin', async (req) => {
    const s = requireScope(req);
    const db = req.db;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(s.userId).first();
    if (!user) throw httpError(401, 'Session no longer valid.', 'USER_GONE');

    const current = String(req.body.current_pin || '');
    const next = String(req.body.new_pin || '');
    if (!auth.verifyPin(current, user.pin_hash)) {
      throw httpError(403, 'Your current PIN is not correct.', 'BAD_CURRENT_PIN');
    }
    const check = auth.validatePin(next, { username: user.username, currentPinHash: user.pin_hash });
    if (!check.ok) throw httpError(400, check.problems.join(' '), 'WEAK_PIN');

    await db.prepare("UPDATE users SET pin_hash = ?, must_change_pin = 0, updated_at = datetime('now') WHERE id = ?")
      .bind(auth.hashPin(check.digits), user.id).run();
    // Every existing session is revoked: a PIN change is what somebody does
    // when they believe the old one leaked, so the old tokens must stop working.
    await db.prepare("UPDATE user_sessions SET revoked_at = datetime('now'), revoke_reason='pin_changed' WHERE user_id = ? AND revoked_at IS NULL")
      .bind(user.id).run();
    await core.audit(db, { businessId: s.businessId, branchId: s.branchId, userId: s.userId, userRole: s.role, action: 'PIN_CHANGED', entityType: 'user', entityId: user.id, severity: 'NOTICE', ipAddress: req.ip });
    return { ok: true, sessions_revoked: true };
  });

  // -------------------------------------------------------------------
  // BRANDING (public: the login screen needs the logo before anyone signs in)
  // -------------------------------------------------------------------
  router.get('/branding', publicRoute(async (req) => {
    const s = await core.getSettings(req.db);
    return {
      product_name: s.product_name,
      logo_data_url: s.logo_data_url,
      support_contact_name: s.support_contact_name,
      support_contact_phone: s.support_contact_phone,
      support_contact_email: s.support_contact_email,
      subscription_status: s.subscription_status,
    };
  }));

  // -------------------------------------------------------------------
  // BUSINESSES  (the multi-business tier above branches)
  // -------------------------------------------------------------------
  router.get('/businesses', async (req) => {
    const s = requireScope(req);
    const f = scopeLib.businessFilter(s);
    const rows = await req.db.prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM branches br WHERE br.business_id = b.id AND br.is_deleted = 0 AND br.is_active = 1) AS branch_count
         FROM businesses b WHERE b.is_deleted = 0 ${f.sql} ORDER BY b.sort_order, b.name`
    ).bind(...f.params).all();
    return rows.map((b) => ({ ...b, modules: core.businessModules(b), vertical: VERTICALS.getProfile(b.vertical_code) ? { code: b.vertical_code, label: VERTICALS.getProfile(b.vertical_code).label } : null }));
  });

  router.post('/businesses', async (req) => {
    const s = requireScope(req);
    if (s.rank < scopeLib.rank('OWNER')) scopeLib.forbidden('Only the owner can add a business.', 'OWNER_ONLY');
    await writeGuard(req);
    const settings = await core.getSettings(req.db);
    if (!Number(settings.multi_business_enabled)) throw httpError(402, 'Multiple businesses are not included in this plan.', 'FEATURE_NOT_IN_PLAN');
    await core.assertUnderLimit(req.db, 'business', settings);

    const b = req.body;
    const vertical = VERTICALS.isVertical(b.vertical_code) ? b.vertical_code : 'GENERAL';
    const id = IDS.newId();
    const name = V.str(b.name, { field: 'name', min: 2, max: 160 });
    const cac = b.cac_number ? V.cacNumber(b.cac_number, { field: 'cac_number' }) : null;
    const tin = b.tin ? V.tin(b.tin, { field: 'tin' }) : null;

    await req.db.prepare(`INSERT INTO businesses (
        id, name, vertical_code, trading_name, legal_name, cac_number, tin, vat_registration_no,
        vat_enabled, vat_rate_percent, company_size,
        uses_serial_tracking, uses_warranty, uses_delivery, uses_installation, uses_layaway,
        uses_instalments, uses_shelf_life, uses_credit, uses_wholesale, uses_fx,
        email, phone, address, state_code, is_active, sort_order, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?, datetime('now'), datetime('now'))`)
      .bind(id, name, vertical, b.trading_name || null, b.legal_name || null, cac, tin, b.vat_registration_no || null,
        b.vat_enabled ? 1 : 0, Number(b.vat_rate_percent) || 7.5, String(b.company_size || 'SMALL').toUpperCase(),
        profileFlag(vertical, 'serialTrackingDefault', b.uses_serial_tracking),
        profileFlag(vertical, 'warrantyDefault', b.uses_warranty),
        profileFlag(vertical, 'deliveryDefault', b.uses_delivery),
        profileFlag(vertical, 'installationDefault', b.uses_installation),
        profileFlag(vertical, 'layawayDefault', b.uses_layaway),
        profileFlag(vertical, 'instalmentDefault', b.uses_instalments),
        profileFlag(vertical, 'shelfLifeDefault', b.uses_shelf_life),
        profileFlag(vertical, 'creditDefault', b.uses_credit, 1),
        profileFlag(vertical, 'wholesaleDefault', b.uses_wholesale, 1),
        b.uses_fx ? 1 : 0,
        b.email || null, b.phone || null, b.address || null, b.state_code || null,
        (await req.db.prepare('SELECT COUNT(*) c FROM businesses').first()).c + 1).run();

    // Seeding the categories and the chart at creation is what makes a new
    // business usable immediately: a vertical with no categories cannot have
    // products, and a business with no chart of accounts cannot post a sale.
    const business = await req.db.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first();
    const profile = VERTICALS.getProfile(vertical) || VERTICALS.GENERAL_PROFILE;
    await core.seedCategoriesFromProfile(req.db, business, profile);
    await gl.seedChart(req.db, id);

    await core.audit(req.db, { businessId: id, userId: s.userId, userRole: s.role, action: 'BUSINESS_CREATE', entityType: 'business', entityId: id, after: { name, vertical_code: vertical }, severity: 'NOTICE', ipAddress: req.ip });
    return { id, name, vertical_code: vertical, modules: core.businessModules(business), categories_seeded: profile.categories.length };
  });

  router.patch('/businesses/:id', async (req) => {
    const s = requireScope(req);
    if (s.rank < scopeLib.rank('OWNER')) scopeLib.forbidden('Only the owner can change a business.', 'OWNER_ONLY');
    await writeGuard(req);
    const business = await scopeLib.assertBusinessAccess(req.db, s, req.params.id, { action: 'change' });
    const allowed = ['name', 'trading_name', 'legal_name', 'cac_number', 'tin', 'vat_registration_no',
      'vat_enabled', 'vat_rate_percent', 'company_size', 'uses_serial_tracking', 'uses_warranty',
      'uses_delivery', 'uses_installation', 'uses_layaway', 'uses_instalments', 'uses_shelf_life',
      'uses_credit', 'uses_wholesale', 'uses_fx', 'email', 'phone', 'address', 'state_code',
      'logo_data_url', 'is_active', 'sort_order'];
    const changes = V.pick(req.body, allowed);
    if (!Object.keys(changes).length) throw httpError(400, 'Nothing to update.', 'NO_CHANGES');
    // assertNoUnknownKeys is the mass-assignment defence: without it a caller
    // could POST vertical_code and silently change which taxonomy, unit set and
    // restriction defaults every product in the business inherits.
    V.assertNoUnknownKeys(req.body, allowed, { resource: 'business' });
    if (changes.vat_rate_percent != null) changes.vat_rate_percent = V.num(changes.vat_rate_percent, { field: 'vat_rate_percent', min: 0, max: 30 });
    if (changes.logo_data_url != null && String(changes.logo_data_url).length > config.security.maxLogoBytes) {
      throw httpError(413, 'That logo is too large. Resize it to under 500 KB.', 'LOGO_TOO_LARGE');
    }
    const before = { ...business };
    const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ');
    await req.db.prepare(`UPDATE businesses SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .bind(...Object.values(changes), business.id).run();
    await core.audit(req.db, { businessId: business.id, userId: s.userId, userRole: s.role, action: 'BUSINESS_UPDATE', entityType: 'business', entityId: business.id, before, after: changes, ipAddress: req.ip });
    return req.db.prepare('SELECT * FROM businesses WHERE id = ?').bind(business.id).first();
  });

  // -------------------------------------------------------------------
  // BRANCHES
  // -------------------------------------------------------------------
  router.get('/branches', async (req) => {
    const s = requireScope(req);
    const f = scopeLib.branchFilter(s);
    const rows = await req.db.prepare(
      `SELECT b.*, bs.name AS business_name, bs.vertical_code,
              (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.is_deleted = 0 AND u.is_active = 1) AS staff_count
         FROM branches b JOIN businesses bs ON bs.id = b.business_id
        WHERE b.is_deleted = 0 ${f.sql} ORDER BY b.sort_order, b.name`
    ).bind(...f.params).all();
    return rows;
  });

  router.post('/branches', async (req) => {
    const s = requireScope(req);
    if (s.rank < scopeLib.rank('MANAGER')) scopeLib.forbidden('Only a manager or the owner can add a branch.', 'MANAGER_ONLY');
    await writeGuard(req);
    const settings = await core.getSettings(req.db);
    if (!Number(settings.multi_branch_enabled)) throw httpError(402, 'Multiple branches are not included in this plan.', 'FEATURE_NOT_IN_PLAN');
    await core.assertUnderLimit(req.db, 'branch', settings);

    const b = req.body;
    const business = await scopeLib.assertBusinessAccess(req.db, s, b.business_id || s.businessId, { action: 'add a branch to' });
    const name = V.str(b.name, { field: 'name', min: 2, max: 120 });
    const code = b.code ? V.str(b.code, { field: 'code', min: 1, max: 4 }).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
    if (code) {
      const dup = await req.db.prepare('SELECT id FROM branches WHERE business_id = ? AND code = ? AND is_deleted = 0').bind(business.id, code).first();
      if (dup) throw httpError(409, `Another branch in this business already uses the code "${code}". Branch codes appear on invoice numbers, so they must be unique.`, 'BRANCH_CODE_TAKEN');
    }
    // A GPS position is optional, but if given it must be in Nigeria: a typo
    // that puts a Lagos branch in the Atlantic makes every geofenced clock-in
    // read OFF_SITE, and the manager concludes the feature is broken.
    const lat = b.latitude != null && b.latitude !== '' ? V.coordinate(b.latitude, { field: 'latitude', axis: 'lat', nigeriaOnly: true }) : null;
    const lng = b.longitude != null && b.longitude !== '' ? V.coordinate(b.longitude, { field: 'longitude', axis: 'lng', nigeriaOnly: true }) : null;
    if ((lat == null) !== (lng == null)) throw httpError(400, 'Enter both a latitude and a longitude, or neither.', 'COORDINATES_INCOMPLETE');

    const id = IDS.newId();
    await req.db.prepare(`INSERT INTO branches (
        id, business_id, name, code, branch_type, address, area, lga, state_code, phone, email,
        latitude, longitude, geofence_radius_meters, attendance_mode, opening_time, closing_time,
        default_till_float, can_deliver, vehicles, drivers, daily_delivery_capacity, stock_pick_policy,
        is_active, sort_order, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'GEOLOCATION', ?,?,?,?,?,?,?,?,?, 'FIFO', 1, ?, datetime('now'), datetime('now'))`)
      .bind(id, business.id, name, code, String(b.branch_type || 'RETAIL').toUpperCase(),
        b.address || null, b.area || null, b.lga || null, b.state_code || null, b.phone || null, b.email || null,
        lat, lng, Number(b.geofence_radius_meters) || 100,
        b.opening_time || null, b.closing_time || null, Number(b.default_till_float) || 0,
        b.can_deliver == null ? 1 : (b.can_deliver ? 1 : 0),
        Number(b.vehicles) || 0, Number(b.drivers) || 0, Number(b.daily_delivery_capacity) || 10,
        (await req.db.prepare('SELECT COUNT(*) c FROM branches WHERE business_id = ?').bind(business.id).first()).c + 1).run();
    await core.audit(req.db, { businessId: business.id, branchId: id, userId: s.userId, userRole: s.role, action: 'BRANCH_CREATE', entityType: 'branch', entityId: id, after: { name, code }, severity: 'NOTICE', ipAddress: req.ip });
    return req.db.prepare('SELECT * FROM branches WHERE id = ?').bind(id).first();
  });

  router.patch('/branches/:id', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const branch = await scopeLib.assertBranchAccess(req.db, s, req.params.id, { action: 'change' });
    const allowed = ['name', 'code', 'branch_type', 'address', 'area', 'lga', 'state_code', 'phone', 'email',
      'latitude', 'longitude', 'geofence_radius_meters', 'attendance_mode', 'opening_time', 'closing_time',
      'default_till_float', 'can_deliver', 'vehicles', 'drivers', 'daily_delivery_capacity',
      'stock_pick_policy', 'is_active', 'sort_order'];
    V.assertNoUnknownKeys(req.body, allowed, { resource: 'branch' });
    const changes = V.pick(req.body, allowed);
    // business_id is deliberately NOT editable: moving a branch between
    // businesses moves its stock, its debtors and its books, which is a
    // migration, not a settings change.
    if (!Object.keys(changes).length) throw httpError(400, 'Nothing to update.', 'NO_CHANGES');
    if (changes.latitude != null) changes.latitude = V.coordinate(changes.latitude, { field: 'latitude', axis: 'lat', nigeriaOnly: true });
    if (changes.longitude != null) changes.longitude = V.coordinate(changes.longitude, { field: 'longitude', axis: 'lng', nigeriaOnly: true });
    if (changes.stock_pick_policy) changes.stock_pick_policy = V.oneOf(changes.stock_pick_policy, STOCK.PICK_POLICIES, { field: 'stock_pick_policy' });
    const before = { ...branch };
    const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ');
    await req.db.prepare(`UPDATE branches SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .bind(...Object.values(changes), branch.id).run();
    await core.audit(req.db, { businessId: branch.business_id, branchId: branch.id, userId: s.userId, userRole: s.role, action: 'BRANCH_UPDATE', entityType: 'branch', entityId: branch.id, before, after: changes, ipAddress: req.ip });
    return req.db.prepare('SELECT * FROM branches WHERE id = ?').bind(branch.id).first();
  });

  // -------------------------------------------------------------------
  // CATALOGUE: products, categories, brands
  // -------------------------------------------------------------------
  router.get('/products', async (req) => {
    const s = requireScope(req);
    const { limit, offset } = pagination(req, { defaultLimit: 100, maxLimit: 1000 });
    const businessId = req.query.business_id || s.businessId;
    if (businessId && !scopeLib.canAccessBusiness(s, businessId)) scopeLib.forbidden('That business is not in your scope.', 'BUSINESS_OUT_OF_SCOPE');
    const bf = scopeLib.businessFilter(s, 'p.business_id');
    const where = [`p.is_deleted = 0`];
    const params = [];
    if (businessId) { where.push('p.business_id = ?'); params.push(businessId); }
    if (req.query.category_id) { where.push('p.category_id = ?'); params.push(req.query.category_id); }
    if (req.query.brand_id) { where.push('p.brand_id = ?'); params.push(req.query.brand_id); }
    if (req.query.active === 'true') where.push('p.is_active = 1');
    if (req.query.search) {
      // search_text is flattened at write time precisely so this LIKE can use an
      // index-adjacent scan rather than parsing a JSON blob per row.
      where.push('(p.search_text LIKE ? OR p.name LIKE ? OR p.sku LIKE ?)');
      const like = `%${String(req.query.search).toLowerCase().replace(/[%_]/g, '')}%`;
      params.push(like, like, like);
    }
    const branchId = req.query.branch_id || (s.pinned ? s.branchId : null);
    const stockJoin = branchId
      ? `(SELECT COALESCE(SUM(sb.quantity_on_hand),0) FROM stock_batches sb WHERE sb.product_id = p.id AND sb.branch_id = ? AND sb.is_deleted = 0)`
      : `(SELECT COALESCE(SUM(sb.quantity_on_hand),0) FROM stock_batches sb WHERE sb.product_id = p.id AND sb.is_deleted = 0)`;
    const reservedJoin = branchId
      ? `(SELECT COALESCE(SUM(sb.quantity_reserved),0) FROM stock_batches sb WHERE sb.product_id = p.id AND sb.branch_id = ? AND sb.is_deleted = 0)`
      : `(SELECT COALESCE(SUM(sb.quantity_reserved),0) FROM stock_batches sb WHERE sb.product_id = p.id AND sb.is_deleted = 0)`;
    if (branchId) params.unshift(branchId, branchId);

    const rows = await req.db.prepare(`
      SELECT p.*, c.name AS category_name, c.code AS category_code, br.name AS brand_name,
             ${stockJoin} AS quantity_on_hand,
             ${reservedJoin} AS quantity_reserved
        FROM products p
        LEFT JOIN product_categories c ON c.id = p.category_id
        LEFT JOIN brands br ON br.id = p.brand_id
       WHERE ${where.join(' AND ')} ${bf.sql}
       ORDER BY p.name
       LIMIT ? OFFSET ?
    `).bind(...params, ...bf.params, limit, offset).all();

    return rows.map((p) => ({
      ...p,
      // SELLABLE, not on hand. A product showing "3 in stock" when all three are
      // on hold is a product the till cannot sell, and the discrepancy is what
      // makes staff stop trusting the number on the screen.
      sellable: (Number(p.quantity_on_hand) || 0) - (Number(p.quantity_reserved) || 0),
      attributes: core.parseJsonColumn(p.attributes_json, {}),
      ladder: RECEIVING.ladder(p),
      restriction: (() => {
        const prof = VERTICALS.getProfile(p.vertical_code) || null;
        return VERTICALS.effectiveRestriction(prof ? prof.code : null, p.category_code, p.restriction_reason);
      })(),
    }));
  });

  router.get('/products/:id', async (req) => {
    const s = requireScope(req);
    const p = await req.db.prepare(`SELECT p.*, c.name AS category_name, c.code AS category_code, br.name AS brand_name
        FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
        LEFT JOIN brands br ON br.id = p.brand_id WHERE p.id = ? AND p.is_deleted = 0`).bind(req.params.id).first();
    if (!p) throw httpError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    if (!scopeLib.canAccessBusiness(s, p.business_id)) throw httpError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    const [batches, barcodes, overrides, tiers, breaks, serials] = await Promise.all([
      req.db.prepare(`SELECT sb.*, b.name AS branch_name, b.code AS branch_code
          FROM stock_batches sb JOIN branches b ON b.id = sb.branch_id
         WHERE sb.product_id = ? AND sb.is_deleted = 0 ORDER BY b.name, sb.received_at`).bind(p.id).all(),
      req.db.prepare('SELECT * FROM product_barcodes WHERE product_id = ? AND is_deleted = 0').bind(p.id).all(),
      req.db.prepare('SELECT po.*, b.name AS branch_name FROM product_price_overrides po JOIN branches b ON b.id = po.branch_id WHERE po.product_id = ? AND po.is_deleted = 0').bind(p.id).all(),
      req.db.prepare('SELECT * FROM volume_breaks WHERE product_id = ? AND is_deleted = 0 ORDER BY min_qty').bind(p.id).all(),
      req.db.prepare('SELECT * FROM promotions WHERE product_id = ? AND is_deleted = 0 AND status = ?').bind(p.id, 'ACTIVE').all(),
      Number(p.serial_tracking) === 1
        ? req.db.prepare(`SELECT sn.*, b.name AS branch_name, c.name AS customer_name
             FROM serial_numbers sn LEFT JOIN branches b ON b.id = sn.branch_id LEFT JOIN customers c ON c.id = sn.customer_id
            WHERE sn.product_id = ? AND sn.is_deleted = 0 ORDER BY sn.status, sn.serial_number LIMIT 500`).bind(p.id).all()
        : [],
    ]);
    return {
      ...p,
      attributes: core.parseJsonColumn(p.attributes_json, {}),
      ladder: RECEIVING.ladder(p),
      ladder_validation: RECEIVING.validateLadder(p),
      batches: batches.map((b) => ({
        ...b,
        sellable: (Number(b.quantity_on_hand) || 0) - (Number(b.quantity_reserved) || 0),
        value_at_cost: M.round2((Number(b.quantity_on_hand) || 0) * (Number(b.cost_per_unit) || 0)),
      })),
      barcodes, price_overrides: overrides, volume_breaks: tiers, promotions: breaks, serials,
    };
  });

  router.post('/products', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const b = req.body;
    const business = await scopeLib.assertBusinessAccess(req.db, s, b.business_id || s.businessId, { action: 'add products to' });
    const profile = VERTICALS.getProfile(business.vertical_code) || VERTICALS.GENERAL_PROFILE;

    const name = V.str(b.name, { field: 'name', min: 2, max: 200 });
    const sku = b.sku ? V.str(b.sku, { field: 'sku', max: 60 }) : null;
    if (sku) {
      const dup = await req.db.prepare('SELECT id, name FROM products WHERE business_id = ? AND sku = ? AND is_deleted = 0').bind(business.id, sku).first();
      if (dup) throw httpError(409, `SKU "${sku}" is already used by "${dup.name}". A SKU is how staff find a product, so it must be unique.`, 'SKU_TAKEN');
    }
    const baseUnit = V.str(b.base_unit || profile.baseUnitDefault || 'PIECE', { field: 'base_unit', max: 24 }).toUpperCase();
    if (!VERTICALS.isUnit(baseUnit)) {
      throw httpError(400, `"${baseUnit}" is not a known unit. Choose one of: ${VERTICALS.UNIT_LIBRARY.map((u) => u.code).join(', ')}`, 'UNKNOWN_UNIT');
    }
    const ladder = {
      units_per_pack: b.units_per_pack != null ? V.int(b.units_per_pack, { field: 'units_per_pack', min: 1 }) : 1,
      units_per_carton: b.units_per_carton != null && b.units_per_carton !== '' ? V.int(b.units_per_carton, { field: 'units_per_carton', min: 2 }) : null,
      packs_per_carton: b.packs_per_carton != null && b.packs_per_carton !== '' ? V.int(b.packs_per_carton, { field: 'packs_per_carton', min: 1 }) : null,
      units_per_pallet: b.units_per_pallet != null && b.units_per_pallet !== '' ? V.int(b.units_per_pallet, { field: 'units_per_pallet', min: 2 }) : null,
      cartons_per_pallet: b.cartons_per_pallet != null && b.cartons_per_pallet !== '' ? V.int(b.cartons_per_pallet, { field: 'cartons_per_pallet', min: 1 }) : null,
    };
    // The ladder is validated as a whole BEFORE the write: a "carton" smaller
    // than a "pack", or a pallet that is not a whole number of cartons, is a
    // data-entry inversion that would make the POS sell a carton as less stock
    // than a pack.
    const ladderCheck = RECEIVING.validateLadder({ base_unit: baseUnit, ...ladder });
    if (!ladderCheck.ok) throw httpError(400, ladderCheck.errors.join(' '), 'INVALID_UOM_LADDER');

    const category = b.category_id ? await core.getCategory(req.db, b.category_id) : null;
    if (b.category_id && !category) throw httpError(400, 'That category does not exist.', 'CATEGORY_NOT_FOUND');
    if (category && String(category.business_id) !== String(business.id)) {
      throw httpError(400, 'That category belongs to another business.', 'CATEGORY_OUT_OF_SCOPE');
    }

    const id = IDS.newId();
    const price = b.default_selling_price != null ? V.money(b.default_selling_price, { field: 'default_selling_price', min: 0 }) : null;
    const cost = b.unit_cost != null ? V.money(b.unit_cost, { field: 'unit_cost', min: 0 }) : null;
    const attributes = b.attributes && typeof b.attributes === 'object' ? b.attributes : {};
    const searchText = [name, b.brand_name, b.model_number, sku, category ? category.name : '', Object.values(attributes).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();

    await req.db.prepare(`INSERT INTO products (
        id, business_id, category_id, brand_id, name, sku, model_number, description,
        restriction_reason, register_required, serial_tracking,
        base_unit, units_per_pack, units_per_carton, packs_per_carton, units_per_pallet, cartons_per_pallet,
        allows_fractional_qty, unit_weight_kg, unit_volume_m3, is_bulky, needs_two_man_delivery,
        shelf_life_days, track_best_before, warranty_months, warranty_basis, warranty_provider,
        compliance_scheme, compliance_reg_no, country_of_origin, hs_code,
        attributes_json, search_text, default_selling_price, wholesale_price, recommended_retail_price,
        target_margin_percent, vat_exempt, reorder_level, reorder_quantity, is_stocked, is_active,
        created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?, ?,?, NULL,NULL, ?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,1,1, ?, datetime('now'), datetime('now'))`)
      .bind(id, business.id, category ? category.id : null, b.brand_id || null, name, sku,
        b.model_number ? V.str(b.model_number, { field: 'model_number', max: 80 }) : null,
        b.description ? V.text(b.description, { field: 'description', max: 2000 }) : null,
        // NULL means INHERIT from the category, then the vertical. Writing the
        // category's own default here would turn inheritance into a hard
        // override — the mistake that once made every electronics line, cables
        // included, demand a serial scan at the till.
        b.restriction_reason ? V.oneOf(b.restriction_reason, ['NONE', 'AGE_VERIFICATION', 'SERIAL_CAPTURE', 'AUTHORITY_DOCUMENT'], { field: 'restriction_reason' }) : null,
        b.register_required == null ? null : (b.register_required ? 1 : 0),
        b.serial_tracking == null ? null : (b.serial_tracking ? 1 : 0),
        baseUnit, ladder.units_per_pack, ladder.units_per_carton, ladder.packs_per_carton,
        ladder.units_per_pallet, ladder.cartons_per_pallet,
        VERTICALS.allowsFractionalQty(business.vertical_code, category ? category.code : null, null) ? 1 : 0,
        b.unit_weight_kg != null && b.unit_weight_kg !== '' ? Number(b.unit_weight_kg) : null,
        b.unit_volume_m3 != null && b.unit_volume_m3 !== '' ? Number(b.unit_volume_m3) : null,
        b.is_bulky ? 1 : 0, b.needs_two_man_delivery ? 1 : 0,
        b.shelf_life_days != null && b.shelf_life_days !== '' ? V.int(b.shelf_life_days, { field: 'shelf_life_days', min: 1 }) : null,
        b.track_best_before ? 1 : 0,
        b.warranty_months != null && b.warranty_months !== '' ? V.int(b.warranty_months, { field: 'warranty_months', min: 0, max: 240 }) : 0,
        b.warranty_basis ? V.oneOf(b.warranty_basis, ['SALE', 'RECEIPT', 'MANUFACTURE'], { field: 'warranty_basis' }) : null,
        b.warranty_provider ? V.oneOf(b.warranty_provider, ['MANUFACTURER', 'SHOP', 'THIRD_PARTY', 'NONE'], { field: 'warranty_provider' }) : null,
        b.compliance_scheme || null, b.compliance_reg_no || null, b.country_of_origin || null, b.hs_code || null,
        JSON.stringify(attributes), searchText,
        price, b.wholesale_price != null ? V.money(b.wholesale_price, { field: 'wholesale_price', min: 0 }) : null,
        b.recommended_retail_price != null ? V.money(b.recommended_retail_price, { field: 'recommended_retail_price', min: 0 }) : null,
        b.target_margin_percent != null ? V.num(b.target_margin_percent, { field: 'target_margin_percent', min: 0, max: 95 }) : null,
        b.vat_exempt == null ? null : (b.vat_exempt ? 1 : 0),
        b.reorder_level != null ? V.int(b.reorder_level, { field: 'reorder_level', min: 0 }) : 0,
        b.reorder_quantity != null ? V.int(b.reorder_quantity, { field: 'reorder_quantity', min: 0 }) : 0,
        b.is_stocked == null ? 1 : (b.is_stocked ? 1 : 0),
        s.userId).run();

    if (b.barcode) {
      const code = V.barcode(b.barcode, { field: 'barcode' });
      await req.db.prepare(`INSERT INTO product_barcodes (id, product_id, barcode, unit_type, label, is_primary, created_at, updated_at)
        VALUES (?,?,?, 'BASE_UNIT', 'Primary barcode', 1, datetime('now'), datetime('now'))`)
        .bind(IDS.newId(), id, code).run();
    }
    await core.audit(req.db, { businessId: business.id, userId: s.userId, userRole: s.role, action: 'PRODUCT_CREATE', entityType: 'product', entityId: id, after: { name, sku, price }, ipAddress: req.ip });
    return req.db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  });

  router.patch('/products/:id', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const p = await req.db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!p) throw httpError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    if (!scopeLib.canAccessBusiness(s, p.business_id)) throw httpError(404, 'Product not found.', 'PRODUCT_NOT_FOUND');
    const allowed = ['name', 'sku', 'model_number', 'description', 'category_id', 'brand_id',
      'restriction_reason', 'register_required', 'serial_tracking', 'base_unit',
      'units_per_pack', 'units_per_carton', 'packs_per_carton', 'units_per_pallet', 'cartons_per_pallet',
      'unit_weight_kg', 'unit_volume_m3', 'is_bulky', 'needs_two_man_delivery',
      'shelf_life_days', 'track_best_before', 'warranty_months', 'warranty_basis', 'warranty_provider',
      'compliance_scheme', 'compliance_reg_no', 'country_of_origin', 'hs_code', 'attributes_json',
      'default_selling_price', 'wholesale_price', 'recommended_retail_price', 'target_margin_percent',
      'vat_exempt', 'reorder_level', 'reorder_quantity', 'is_stocked', 'is_active'];
    V.assertNoUnknownKeys(req.body, allowed, { resource: 'product' });
    const changes = V.pick(req.body, allowed);
    if (!Object.keys(changes).length) throw httpError(400, 'Nothing to update.', 'NO_CHANGES');

    // Changing the UOM ladder changes what "a carton" MEANS for this product.
    // Existing batches were received under the old ladder; the new one applies
    // from here on. Validating it prevents an inversion that would make the POS
    // sell a carton as less stock than a pack.
    const ladderCheck = RECEIVING.validateLadder({ ...p, ...changes });
    if (!ladderCheck.ok) throw httpError(400, ladderCheck.errors.join(' '), 'INVALID_UOM_LADDER');

    const priceChanged = changes.default_selling_price != null
      && M.toKobo(changes.default_selling_price) !== M.toKobo(p.default_selling_price);

    const before = { ...p };
    const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ');
    await req.db.prepare(`UPDATE products SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .bind(...Object.values(changes), p.id).run();

    if (priceChanged) {
      // A price change is chained into the audit log rather than merely logged:
      // quietly moving a shelf price is one of the two ways a till can be robbed
      // without a void (the other being an unapproved discount).
      await core.auditPriceOverride(req.db, {
        business: { id: p.business_id }, branchId: s.branchId, userId: s.userId,
        productId: p.id, oldPrice: p.default_selling_price, newPrice: changes.default_selling_price,
        reason: req.body.price_change_reason || null, deviceId: req.headers['x-device-id'] || null,
      });
    }
    await core.audit(req.db, { businessId: p.business_id, userId: s.userId, userRole: s.role, action: 'PRODUCT_UPDATE', entityType: 'product', entityId: p.id, before, after: changes, ipAddress: req.ip });
    return req.db.prepare('SELECT * FROM products WHERE id = ?').bind(p.id).first();
  });

  router.get('/catalog/categories', async (req) => {
    const s = requireScope(req);
    const businessId = req.query.business_id || s.businessId;
    if (businessId && !scopeLib.canAccessBusiness(s, businessId)) scopeLib.forbidden('That business is not in your scope.', 'BUSINESS_OUT_OF_SCOPE');
    const rows = await core.listCategories(req.db, businessId, { includeInactive: req.query.include_inactive === 'true' });
    const business = await core.getBusiness(req.db, businessId);
    return {
      categories: rows,
      vertical: business ? {
        code: business.vertical_code,
        profile: VERTICALS.getProfile(business.vertical_code) || VERTICALS.GENERAL_PROFILE,
        units: VERTICALS.UNIT_LIBRARY,
        customer_classes: VERTICALS.CUSTOMER_CLASSES,
        restrictions: VERTICALS.RESTRICTION_REASONS,
        selling_patterns: VERTICALS.SELLING_PATTERNS,
      } : null,
    };
  });

  router.get('/catalog/verticals', publicRoute(async () => ({
    verticals: VERTICALS.ALL_PROFILES.map((p) => ({
      code: p.code, label: p.label, shortLabel: p.shortLabel, blurb: p.blurb,
      categoryCount: p.categories.length, units: p.units,
      serialTrackingDefault: p.serialTrackingDefault, warrantyDefault: p.warrantyDefault,
      shelfLifeDefault: p.shelfLifeDefault, attributeSchema: p.attributeSchema,
      complianceTypes: p.complianceTypes,
    })),
  })));

  router.get('/catalog/barcode/:code', async (req) => {
    const s = requireScope(req);
    const code = V.str(req.params.code, { field: 'code', max: 64 });
    const bf = scopeLib.businessFilter(s, 'p.business_id');
    const row = await req.db.prepare(`
      SELECT pb.*, p.name, p.sku, p.base_unit, p.default_selling_price, p.business_id, p.category_id,
             p.serial_tracking, p.restriction_reason, p.warranty_months, p.attributes_json,
             c.name AS category_name, c.code AS category_code
        FROM product_barcodes pb
        JOIN products p ON p.id = pb.product_id AND p.is_deleted = 0
        LEFT JOIN product_categories c ON c.id = p.category_id
       WHERE pb.barcode = ? AND pb.is_deleted = 0 ${bf.sql}
       LIMIT 1
    `).bind(code, ...bf.params).first();
    if (!row) return { found: false, barcode: code };
    const branchId = req.query.branch_id || (s.pinned ? s.branchId : null);
    const stock = branchId
      ? await req.db.prepare(`SELECT COALESCE(SUM(quantity_on_hand),0) AS on_hand, COALESCE(SUM(quantity_reserved),0) AS reserved
           FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0`).bind(row.product_id, branchId).first()
      : { on_hand: 0, reserved: 0 };
    return {
      found: true, barcode: code, unit_type: row.unit_type,
      product: {
        id: row.product_id, name: row.name, sku: row.sku, base_unit: row.base_unit,
        price: row.default_selling_price, category: row.category_name, category_code: row.category_code,
        serial_tracking: !!Number(row.serial_tracking), warranty_months: row.warranty_months,
        attributes: core.parseJsonColumn(row.attributes_json, {}),
      },
      stock: branchId ? {
        branch_id: branchId,
        on_hand: Number(stock.on_hand), reserved: Number(stock.reserved),
        sellable: Number(stock.on_hand) - Number(stock.reserved),
      } : null,
    };
  });

  // -------------------------------------------------------------------
  // SALES — the POS
  // -------------------------------------------------------------------
  router.post('/sales', async (req) => withIdempotency(req, req.headers['idempotency-key'], async () => {
    const s = requireScope(req);
    await writeGuard(req);
    // A sale is the one operation that must NOT be blocked by a plan limit or a
    // missing module flag: a shop that cannot sell is a shop that closes. Only
    // the subscription gate applies, and even that allows reads.
    const result = await salesService.createSale({
      db: req.db, scope: s, request: req.body,
      deviceId: req.headers['x-device-id'] || null,
      ipAddress: req.ip, userAgent: req.headers['user-agent'] || null,
    });
    return result;
  }));

  router.get('/sales', async (req) => {
    const s = requireScope(req);
    const { limit, offset } = pagination(req, { defaultLimit: 50, maxLimit: 200 });
    const range = V.dateRange(req.query, { maxDays: 366 });
    const rb = scopeLib.resolveReportBranches(s, req.query.branch_id);
    const params = [range.start_date, range.end_date];
    let branchClause = '';
    if (rb.branchIds && rb.branchIds.length) {
      branchClause = ` AND s.branch_id IN (${rb.branchIds.map(() => '?').join(',')})`;
      params.push(...rb.branchIds);
    }
    const bf = scopeLib.businessFilter(s, 's.business_id');
    params.push(...bf.params);
    const where = [`s.is_deleted = 0`, `s.sale_date BETWEEN ? AND ?`];
    if (req.query.status) { where.push('s.status = ?'); params.splice(2, 0, req.query.status); }
    if (req.query.customer_id) { where.push('s.customer_id = ?'); params.splice(where.length - 1, 0, req.query.customer_id); }

    const rows = await req.db.prepare(`
      SELECT s.id, s.sale_number, s.sale_date, s.sale_time, s.status, s.sale_type, s.total_kobo, s.total,
             s.paid_kobo, s.balance_kobo, s.vat_kobo, s.margin_kobo, s.customer_id, s.customer_name,
             s.branch_id, b.name AS branch_name, u.full_name AS sold_by_name, s.voided_at, s.void_reason
        FROM sales s
        JOIN branches b ON b.id = s.branch_id
        JOIN users u ON u.id = s.sold_by
       WHERE ${where.join(' AND ')} ${branchClause} ${bf.sql}
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all();

    const totals = await req.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total_kobo),0) AS total_kobo,
             COALESCE(SUM(vat_kobo),0) AS vat_kobo, COALESCE(SUM(margin_kobo),0) AS margin_kobo,
             COALESCE(SUM(balance_kobo),0) AS balance_kobo
        FROM sales s WHERE ${where.join(' AND ')} ${branchClause} ${bf.sql} AND s.status NOT IN ('QUOTE','VOIDED')
    `).bind(...params).first();

    return { range, rows, totals: { ...totals, total: M.fromKobo(totals.total_kobo), vat: M.fromKobo(totals.vat_kobo), margin: M.fromKobo(totals.margin_kobo), balance_due: M.fromKobo(totals.balance_kobo) }, limit, offset };
  });

  router.get('/sales/:id', async (req) => {
    const s = requireScope(req);
    const sale = await salesService.getSale(req.db, s, req.params.id);
    return { ...sale, sold_by_name: sale.sold_by_name || null };
  });

  router.get('/sales/:id/receipt', async (req) => {
    const s = requireScope(req);
    return salesService.buildReceipt(req.db, s, req.params.id);
  });

  router.post('/sales/:id/void', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const sale = await db.prepare('SELECT * FROM sales WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!sale) throw httpError(404, 'Sale not found.', 'SALE_NOT_FOUND');
    if (!scopeLib.canAccessBranch(s, sale.branch_id)) throw httpError(404, 'Sale not found.', 'SALE_NOT_FOUND');
    if (sale.voided_at) throw httpError(409, 'That sale has already been voided.', 'ALREADY_VOIDED');
    if (sale.balance_kobo > 0) {
      // A sale with money still owed cannot simply vanish: the receivable exists
      // and must be reversed too, or the customer is chased for goods they never
      // received.
      throw httpError(409, 'This sale has an outstanding balance. Issue a credit note or a return instead of voiding it, so the receivable is reversed as well.', 'VOID_HAS_BALANCE');
    }

    const reason = V.str(req.body.reason, { field: 'reason', min: 4, max: 500 });
    // THE AUTHORITY CHECK. See scope.assertStaffCanVoid for why this is a narrow
    // allowance rather than a ban or a free hand.
    const authority = await scopeLib.assertStaffCanVoid(db, s, sale);

    await db.transaction(async (tx) => {
      await tx.prepare(`UPDATE sales SET status='VOIDED', voided_by=?, voided_at=datetime('now'), void_reason=?,
                        void_approved_by=?, updated_at=datetime('now') WHERE id=?`)
        .bind(String(s.userId), reason, authority.requiresApproval ? String(s.userId) : null, sale.id).run();
      // Stock comes back. A void that does not restock is a stock report that
      // shrinks every time somebody corrects a mistake.
      const items = await tx.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND is_deleted = 0').bind(sale.id).all();
      for (const it of items) {
        if (!it.stock_batch_id) continue;
        await tx.prepare("UPDATE stock_batches SET quantity_on_hand = quantity_on_hand + ?, updated_at = datetime('now') WHERE id = ?")
          .bind(Number(it.base_quantity), it.stock_batch_id).run();
        await tx.prepare(`INSERT INTO stock_movements (id, business_id, branch_id, product_id, stock_batch_id,
            movement_type, direction, quantity, value_kobo, unit_cost, source_type, source_id, reference, moved_by, notes, moved_at)
          VALUES (?,?,?,?,?, 'SALE_RETURN', 1, ?,?,?, 'SALE', ?, ?, ?, ?, datetime('now'))`)
          .bind(IDS.newId(), sale.business_id, sale.branch_id, it.product_id, it.stock_batch_id,
            Number(it.base_quantity), Number(it.line_cost_kobo) || 0, Number(it.unit_cost) || 0,
            sale.id, sale.sale_number, String(s.userId), `Void: ${reason}`).run();
      }
      // Serials return to stock and their warranty clocks stop.
      await tx.prepare(`UPDATE serial_numbers SET status='IN_STOCK', sale_id=NULL, customer_id=NULL, sold_at=NULL,
                        warranty_status='PENDING', updated_at=datetime('now')
         WHERE sale_id = ? AND is_deleted = 0`).bind(sale.id).run();
      // Reverse the journal entry rather than deleting it: the ledger is a
      // history, and a hole in it is worse than an entry that says "reversed".
      const je = await tx.prepare("SELECT * FROM gl_journal_entries WHERE source_type='SALE' AND source_id=? AND status='POSTED'").bind(sale.id).first();
      if (je) {
        const lines = await tx.prepare('SELECT * FROM gl_journal_lines WHERE journal_entry_id = ?').bind(je.id).all();
        await gl.postEntry(tx, {
          business: { id: sale.business_id }, branchId: sale.branch_id,
          entryDate: TG.todayWat(), sourceType: 'SALE', sourceId: sale.id,
          reference: sale.sale_number, description: `Reversal of voided sale ${sale.sale_number}: ${reason}`,
          lines: lines.map((l) => ({
            code: l.account_code,
            direction: l.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
            amountKobo: l.amount_kobo,
            description: `Reversal: ${l.description || ''}`,
          })),
          userId: s.userId,
        });
        await tx.prepare("UPDATE gl_journal_entries SET status='REVERSED', updated_at=datetime('now') WHERE id=?").bind(je.id).run();
      }
      if (sale.till_session_id) {
        await tx.prepare("UPDATE till_sessions SET void_count = void_count + 1, updated_at=datetime('now') WHERE id=?").bind(sale.till_session_id).run();
      }
    });

    await core.audit(req.db, {
      businessId: sale.business_id, branchId: sale.branch_id, userId: s.userId, userRole: s.role,
      action: 'SALE_VOID', entityType: 'sale', entityId: sale.id,
      before: { status: sale.status, total: sale.total }, after: { status: 'VOIDED' },
      reason, severity: 'WARNING', ipAddress: req.ip,
    });
    return { ok: true, sale_number: sale.sale_number, restocked: true, reversed_journal: true, reason };
  });

  // -------------------------------------------------------------------
  // STOCK
  // -------------------------------------------------------------------
  router.get('/stock', async (req) => {
    const s = requireScope(req);
    const rb = scopeLib.resolveReportBranches(s, req.query.branch_id);
    const params = [];
    let branchClause = '';
    if (rb.branchIds && rb.branchIds.length) {
      branchClause = ` AND sb.branch_id IN (${rb.branchIds.map(() => '?').join(',')})`;
      params.push(...rb.branchIds);
    }
    const bf = scopeLib.businessFilter(s, 'b.business_id');
    params.push(...bf.params);
    if (req.query.search) { params.splice(params.length - bf.params.length, 0, `%${String(req.query.search).replace(/[%_]/g, '')}%`); }
    const searchClause = req.query.search ? ' AND (p.name LIKE ? OR p.sku LIKE ?)' : '';
    if (req.query.search) params.splice(params.length - bf.params.length, 0, `%${String(req.query.search).replace(/[%_]/g, '')}%`);

    const rows = await req.db.prepare(`
      SELECT sb.branch_id, br.name AS branch_name, br.code AS branch_code, sb.product_id, p.name AS product_name,
             p.sku, p.base_unit, p.reorder_level, p.reorder_quantity, p.default_selling_price, p.serial_tracking,
             c.name AS category_name,
             SUM(sb.quantity_on_hand) AS quantity_on_hand,
             SUM(sb.quantity_reserved) AS quantity_reserved,
             SUM(sb.quantity_on_hand - sb.quantity_reserved) AS sellable,
             SUM(sb.quantity_on_hand * sb.cost_per_unit) AS cost_value,
             SUM(sb.quantity_on_hand * sb.selling_price_per_unit) AS retail_value,
             COUNT(sb.id) AS batch_count, MIN(sb.best_before_date) AS earliest_best_before
        FROM stock_batches sb
        JOIN products p ON p.id = sb.product_id
        JOIN branches br ON br.id = sb.branch_id
        JOIN businesses b ON b.id = p.business_id
        LEFT JOIN product_categories c ON c.id = p.category_id
       WHERE sb.is_deleted = 0 ${branchClause} ${bf.sql} ${searchClause}
       GROUP BY sb.branch_id, sb.product_id
       ORDER BY p.name
       LIMIT 2000
    `).bind(...params).all();

    return rows.map((r) => ({
      ...r,
      cost_value: M.round2(Number(r.cost_value) || 0),
      retail_value: M.round2(Number(r.retail_value) || 0),
      potential_margin: M.round2((Number(r.retail_value) || 0) - (Number(r.cost_value) || 0)),
      urgency: r.sellable <= 0 ? 'OUT_OF_STOCK' : r.sellable <= Number(r.reorder_level || 0) ? 'CRITICAL' : r.sellable <= Number(r.reorder_level || 0) * 2 ? 'LOW' : 'OK',
    }));
  });

  router.get('/stock/alerts', async (req) => {
    const s = requireScope(req);
    const rb = scopeLib.resolveReportBranches(s, req.query.branch_id);
    const params = [];
    let clause = '';
    if (rb.branchIds && rb.branchIds.length) { clause = ` AND branch_id IN (${rb.branchIds.map(() => '?').join(',')})`; params.push(...rb.branchIds); }
    const [low, shelf, warrantyExpiring, compliance] = await Promise.all([
      req.db.prepare(`SELECT * FROM v_low_stock_alerts WHERE 1=1 ${clause} ORDER BY CASE urgency WHEN 'OUT_OF_STOCK' THEN 0 WHEN 'CRITICAL' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END, product_name LIMIT 200`).bind(...params).all(),
      req.db.prepare(`SELECT * FROM v_shelf_life_alerts WHERE 1=1 ${clause} ORDER BY days_remaining LIMIT 200`).bind(...params).all(),
      req.db.prepare(`SELECT * FROM v_warranty_expiring WHERE 1=1 ${clause.replace(/branch_id/g, 'branch_id')} ORDER BY days_remaining LIMIT 100`).bind(...params).all(),
      req.db.prepare(`SELECT * FROM v_compliance_expiry_alerts ORDER BY days_until_expiry LIMIT 100`).all(),
    ]);
    return { low_stock: low, shelf_life: shelf, warranty_expiring: warrantyExpiring, compliance, counts: { low_stock: low.length, shelf_life: shelf.length, warranty_expiring: warrantyExpiring.length, compliance: compliance.length } };
  });

  router.get('/stock/batches/:productId', async (req) => {
    const s = requireScope(req);
    const f = scopeLib.branchFilter(s, 'sb.branch_id');
    const rows = await req.db.prepare(`
      SELECT sb.*, b.name AS branch_name, b.code AS branch_code,
             (sb.quantity_on_hand - sb.quantity_reserved) AS sellable
        FROM stock_batches sb JOIN branches b ON b.id = sb.branch_id
       WHERE sb.product_id = ? AND sb.is_deleted = 0 ${f.sql}
       ORDER BY b.name, sb.best_before_date IS NULL, sb.best_before_date, sb.received_at
    `).bind(req.params.productId, ...f.params).all();
    return rows;
  });

  router.get('/stock/movements', async (req) => {
    const s = requireScope(req);
    const { limit } = pagination(req, { defaultLimit: 100, maxLimit: 500 });
    const f = scopeLib.branchFilter(s, 'sm.branch_id');
    const params = [...f.params];
    let extra = '';
    if (req.query.product_id) { extra += ' AND sm.product_id = ?'; params.push(req.query.product_id); }
    if (req.query.batch_id) { extra += ' AND sm.stock_batch_id = ?'; params.push(req.query.batch_id); }
    if (req.query.type) { extra += ' AND sm.movement_type = ?'; params.push(req.query.type); }
    const rows = await req.db.prepare(`
      SELECT sm.*, p.name AS product_name, p.sku, b.name AS branch_name, u.full_name AS moved_by_name
        FROM stock_movements sm
        JOIN products p ON p.id = sm.product_id
        JOIN branches b ON b.id = sm.branch_id
        LEFT JOIN users u ON u.id = sm.moved_by
       WHERE 1=1 ${f.sql} ${extra}
       ORDER BY sm.moved_at DESC LIMIT ?
    `).bind(...params, limit).all();
    return rows;
  });

  // A goods-received note: stock in, at the supplier's invoice cost.
  router.post('/stock/receive', async (req) => withIdempotency(req, req.headers['idempotency-key'], async () => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const b = req.body;
    const branch = await scopeLib.assertBranchAccess(db, s, b.branch_id || (s.pinned ? s.branchId : null), { action: 'receive stock at' });
    const business = await core.getBusiness(db, branch.business_id);
    const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(String(b.product_id)).first();
    if (!product) throw httpError(400, 'That product does not exist.', 'PRODUCT_NOT_FOUND');
    if (String(product.business_id) !== String(business.id)) throw httpError(400, 'That product belongs to another business.', 'PRODUCT_OUT_OF_SCOPE');

    // THE UoM LADDER does the conversion, and refuses to guess: receiving
    // "5 cartons" of a product with no carton size configured is an error, not a
    // silent fall-back to 5 single units.
    const resolved = RECEIVING.resolveReceiveLine({ unit: b.unit_type || 'BASE_UNIT', count: b.quantity, product });
    if (!resolved.ok) throw httpError(400, resolved.error, resolved.code);

    const totalCost = V.money(b.total_cost, { field: 'total_cost', min: 0 });
    // Cost is split at FULL PRECISION. Rounding the per-unit figure to kobo at
    // this point loses money permanently and invisibly: ₦480,000 over 7,000 bags
    // is ₦68.571428..., and storing ₦68.57 loses ₦10 on that one delivery — and
    // the same ₦10 on every delivery for the life of the business.
    const cost = RECEIVING.splitTotalCost(totalCost, resolved);
    const price = b.selling_price_per_unit != null
      ? V.money(b.selling_price_per_unit, { field: 'selling_price_per_unit', min: 0 })
      : Number(product.default_selling_price) || 0;

    const batchId = IDS.newId();
    const bestBefore = b.best_before_date ? V.isoDate(b.best_before_date, { field: 'best_before_date' })
      : (product.shelf_life_days ? RECEIVING.addDaysIso(TG.todayWat(), Number(product.shelf_life_days)) : null);

    await db.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO stock_batches (
          id, branch_id, product_id, batch_no, quantity_on_hand, quantity_reserved, quantity_damaged,
          cost_per_unit, selling_price_per_unit, wholesale_price_per_unit, currency, received_at,
          supplier_id, best_before_date, manufacture_date, location_in_branch, status, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,0,0,?,?,?,?, datetime('now'), ?,?,?,?, 'ACTIVE', ?, datetime('now'), datetime('now'))`)
        .bind(batchId, branch.id, product.id, b.batch_no || null, resolved.totalPieces,
          cost.costPerPiece, price, b.wholesale_price_per_unit != null ? Number(b.wholesale_price_per_unit) : M.round2(price * 0.9),
          'NGN', b.supplier_id || null, bestBefore,
          b.manufacture_date ? V.isoDate(b.manufacture_date, { field: 'manufacture_date' }) : null,
          b.location_in_branch || null, b.notes || null).run();

      await tx.prepare(`INSERT INTO stock_movements (id, business_id, branch_id, product_id, stock_batch_id,
          movement_type, direction, quantity, value_kobo, unit_cost, source_type, source_id, reference, moved_by, notes, moved_at)
        VALUES (?,?,?,?,?, 'RECEIPT', 1, ?,?,?, 'RECEIPT', ?, ?, ?, ?, datetime('now'))`)
        .bind(IDS.newId(), business.id, branch.id, product.id, batchId,
          resolved.totalPieces, cost.totalCostKobo, cost.costPerPiece,
          batchId, b.grn_number || null, String(s.userId), b.notes || null).run();

      // Serials captured at receipt: one row per unit, so the serial exists
      // BEFORE the unit can be sold. Requiring a serial at the till for a unit
      // that was never registered is asking the cashier to invent one.
      if (Number(product.serial_tracking) === 1) {
        const serials = Array.isArray(b.serial_numbers) ? b.serial_numbers : String(b.serial_numbers || '').split(/[,\s;]+/);
        const clean = serials.map((x) => WARRANTY.normaliseSerial(x)).filter(Boolean);
        if (clean.length !== resolved.totalPieces) {
          throw httpError(400,
            `"${product.name}" is serial-tracked: ${resolved.totalPieces} serial number(s) are required at receipt, ${clean.length} given.`,
            'SERIAL_COUNT_MISMATCH');
        }
        const dupes = [];
        for (const sn of clean) {
          const exists = await tx.prepare('SELECT id, status FROM serial_numbers WHERE business_id = ? AND serial_normalised = ? AND is_deleted = 0')
            .bind(String(business.id), sn).first();
          if (exists) dupes.push(`${sn} (${exists.status})`);
        }
        if (dupes.length) {
          throw httpError(409, `These serial numbers are already recorded and cannot be received again: ${dupes.slice(0, 5).join(', ')}${dupes.length > 5 ? ` and ${dupes.length - 5} more` : ''}`, 'DUPLICATE_SERIALS');
        }
        for (const sn of clean) {
          await tx.prepare(`INSERT INTO serial_numbers (id, business_id, product_id, serial_number, serial_normalised,
              model_number, status, branch_id, stock_batch_id, warranty_months, warranty_basis, warranty_status,
              received_at, received_by, cost_per_unit, created_at, updated_at)
            VALUES (?,?,?,?,?,?, 'IN_STOCK', ?,?,?,?, 'PENDING', datetime('now'), ?,?, datetime('now'), datetime('now'))`)
            .bind(IDS.newId(), business.id, product.id, sn, sn, product.model_number,
              branch.id, batchId, Number(product.warranty_months) || 0, product.warranty_basis || 'SALE',
              String(s.userId), cost.costPerPiece).run();
        }
      }

      // A goods receipt against a PO also settles the PO line and the payable.
      if (b.purchase_order_item_id) {
        await tx.prepare(`UPDATE purchase_order_items SET quantity_received = quantity_received + ?, updated_at = datetime('now') WHERE id = ?`)
          .bind(resolved.totalPieces, String(b.purchase_order_item_id)).run();
      }
      if (b.supplier_id && totalCost > 0) {
        await tx.prepare(`INSERT INTO creditor_ledger (id, business_id, branch_id, supplier_id, entry_type, direction,
            amount_kobo, amount, entry_date, terms_code, due_date, source_type, source_id, reference, created_by, notes, created_at, updated_at)
          VALUES (?,?,?,?,'PURCHASE','DEBIT',?,?,?,?, 'RECEIPT', ?, ?, ?, ?, datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), business.id, branch.id, String(b.supplier_id), M.toKobo(totalCost), totalCost,
            TG.todayWat(), 'NET_30', CREDIT.dueDate(TG.todayWat(), 'NET_30'), batchId, b.grn_number || null,
            String(s.userId), b.notes || null).run();
        await gl.postGoodsReceipt(tx, {
          business, branchId: branch.id, entryDate: TG.todayWat(),
          costKobo: cost.totalCostKobo, supplierId: b.supplier_id, reference: b.grn_number || null, userId: s.userId,
        });
      }
    });

    await core.audit(db, { businessId: business.id, branchId: branch.id, userId: s.userId, userRole: s.role, action: 'STOCK_RECEIVE', entityType: 'stock_batch', entityId: batchId, after: { product: product.name, pieces: resolved.totalPieces, cost: totalCost }, severity: 'NOTICE', ipAddress: req.ip });
    return {
      batch_id: batchId, product: product.name, branch: branch.name,
      received: resolved, description: RECEIVING.describeReceipt(resolved),
      cost_per_unit: M.round2(cost.costPerPiece), cost_per_unit_full_precision: cost.costPerPiece,
      total_cost: totalCost, selling_price: price, best_before_date: bestBefore,
    };
  }));

  // -------------------------------------------------------------------
  // CUSTOMERS
  // -------------------------------------------------------------------
  router.get('/customers', async (req) => {
    const s = requireScope(req);
    const { limit, offset } = pagination(req, { defaultLimit: 100, maxLimit: 500 });
    const bf = scopeLib.businessFilter(s, 'c.business_id');
    const params = [...bf.params];
    let extra = '';
    if (req.query.search) {
      extra = ' AND (c.name LIKE ? OR c.company_name LIKE ? OR c.phone LIKE ?)';
      const like = `%${String(req.query.search).replace(/[%_]/g, '')}%`;
      params.push(like, like, like);
    }
    if (req.query.class) { extra += ' AND c.customer_class = ?'; params.push(String(req.query.class).toUpperCase()); }
    const rows = await req.db.prepare(`
      SELECT c.*, (SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount_kobo ELSE -amount_kobo END),0)
                     FROM debtor_ledger d WHERE d.customer_id = c.id AND d.is_deleted = 0) / 100.0 AS balance,
              b.name AS home_branch_name
        FROM customers c LEFT JOIN branches b ON b.id = c.home_branch_id
       WHERE c.is_deleted = 0 ${bf.sql} ${extra}
       ORDER BY c.name LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all();
    return rows.map((c) => ({ ...c, balance: M.round2(Number(c.balance) || 0), class_info: VERTICALS.customerClassInfo(c.customer_class) }));
  });

  router.post('/customers', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const b = req.body;
    const business = await scopeLib.assertBusinessAccess(req.db, s, b.business_id || s.businessId, { action: 'add customers to' });
    const name = V.str(b.name, { field: 'name', min: 2, max: 160 });
    const phone = b.phone ? V.ngPhone(b.phone, { field: 'phone' }) : null;
    const customerClass = V.oneOf(b.customer_class || 'RETAIL', VERTICALS.CUSTOMER_CLASSES.map((c) => c.code), { field: 'customer_class' });
    const tin = b.tin ? V.tin(b.tin, { field: 'tin' }) : null;
    const cac = b.cac_number ? V.cacNumber(b.cac_number, { field: 'cac_number' }) : null;
    const id = IDS.newId();
    // A credit limit implies credit is allowed for the class. Granting a limit
    // to a RETAIL customer creates an account the POS will refuse to use, which
    // reads as a bug rather than as a policy.
    const classInfo = VERTICALS.customerClassInfo(customerClass);
    const creditLimit = b.credit_limit != null ? V.money(b.credit_limit, { field: 'credit_limit', min: 0 }) : null;
    if (creditLimit && classInfo && !classInfo.creditAllowed) {
      throw httpError(409, `${classInfo.label} customers do not buy on account, so a credit limit cannot be set. Register them as a trade, wholesale or corporate customer first.`, 'CREDIT_CLASS_NOT_ALLOWED');
    }
    await req.db.prepare(`INSERT INTO customers (id, business_id, home_branch_id, customer_class, customer_type,
        name, company_name, contact_person, phone, alt_phone, email, address, area, lga, state_code, tin, cac_number,
        credit_limit, terms_code, account_status, discount_percent, notes, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?,?,?, datetime('now'), datetime('now'))`)
      .bind(id, business.id, b.home_branch_id || (s.pinned ? s.branchId : null), customerClass,
        V.oneOf(b.customer_type || 'INDIVIDUAL', ['INDIVIDUAL', 'COMPANY', 'GOVERNMENT', 'NGO'], { field: 'customer_type' }),
        name, b.company_name || null, b.contact_person || null, phone,
        b.alt_phone ? V.ngPhone(b.alt_phone, { field: 'alt_phone' }) : null,
        b.email || null, b.address || null, b.area || null, b.lga || null, b.state_code || null, tin, cac,
        creditLimit, V.oneOf(b.terms_code || 'CASH', CREDIT.TERMS_CODES.map((t) => t.code), { field: 'terms_code' }),
        Number(b.discount_percent) || 0, b.notes || null, String(s.userId)).run();
    await core.audit(req.db, { businessId: business.id, userId: s.userId, userRole: s.role, action: 'CUSTOMER_CREATE', entityType: 'customer', entityId: id, after: { name, customer_class: customerClass, credit_limit: creditLimit }, ipAddress: req.ip });
    return req.db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
  });

  router.get('/customers/:id/statement', async (req) => {
    const s = requireScope(req);
    const c = await req.db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!c) throw httpError(404, 'Customer not found.', 'CUSTOMER_NOT_FOUND');
    if (!scopeLib.canAccessBusiness(s, c.business_id)) throw httpError(404, 'Customer not found.', 'CUSTOMER_NOT_FOUND');
    const entries = await req.db.prepare('SELECT * FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0 ORDER BY entry_date, created_at').bind(c.id).all();
    const balance = CREDIT.deriveBalance(entries);
    const ageing = CREDIT.ageEntries(entries, { todayIso: TG.todayWat() });
    const chase = await req.db.prepare('SELECT * FROM debt_chase_log WHERE customer_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 50').bind(c.id).all();
    return {
      customer: c, balance, ageing,
      provision: CREDIT.provisionForAgeing(ageing),
      chase_schedule: ageing.totalOutstandingKobo > 0 ? CREDIT.chaseSchedule({ daysOverdue: ageing.maxDaysOverdue, amount: ageing.totalOutstanding }) : null,
      entries, chase_log: chase,
      plans: await req.db.prepare('SELECT * FROM v_instalment_plans_active WHERE customer_id = ?').bind(c.id).all(),
    };
  });

  router.post('/customers/:id/payments', async (req) => withIdempotency(req, req.headers['idempotency-key'], async () => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!c) throw httpError(404, 'Customer not found.', 'CUSTOMER_NOT_FOUND');
    if (!scopeLib.canAccessBusiness(s, c.business_id)) throw httpError(404, 'Customer not found.', 'CUSTOMER_NOT_FOUND');
    const branch = await scopeLib.assertBranchAccess(db, s, req.body.branch_id || (s.pinned ? s.branchId : c.home_branch_id), { action: 'record a payment at' });

    const amount = V.money(req.body.amount, { field: 'amount', min: 0.01 });
    const method = V.oneOf(req.body.method || 'CASH', PAYMENTS.TENDER_CODES, { field: 'method' });
    const info = PAYMENTS.tenderInfo(method);
    const reference = info && info.needsReference
      ? V.str(req.body.reference, { field: 'reference', max: 120, patternMessage: 'Enter the reference from the transfer alert or POS receipt' })
      : (req.body.reference || null);

    const entries = await db.prepare('SELECT * FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0').bind(c.id).all();
    const ageing = CREDIT.ageEntries(entries, { todayIso: TG.todayWat() });
    // FIFO across the customer's open debts, unless the cashier says which
    // invoice this settles. Either way the allocation is recorded, so the
    // statement shows exactly what the money cleared.
    const allocation = CREDIT.applyPaymentToDebts({
      payment: amount,
      openEntries: ageing.lines,
      mode: req.body.applies_to_entry_id ? 'SPECIFIC' : 'FIFO',
      targetEntryId: req.body.applies_to_entry_id || null,
    });

    const fee = info && info.feeBearing
      ? PAYMENTS.posFee({ amount, percent: (await core.getSettings(db)).pos_fee_percent, cap: (await core.getSettings(db)).pos_fee_cap, configured: !!Number((await core.getSettings(db)).pos_fee_configured) })
      : { fee: 0 };

    await db.transaction(async (tx) => {
      const entryId = IDS.newId();
      await tx.prepare(`INSERT INTO debtor_ledger (id, business_id, branch_id, customer_id, entry_type, direction,
          amount_kobo, amount, entry_date, terms_code, source_type, source_id, reference, applies_to_entry_id,
          method, payment_reference, received_by, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?, 'PAYMENT','CREDIT', ?,?,?,'CASH','PAYMENT',?,?,?, ?,?, ?,?,?, datetime('now'), datetime('now'))`)
        .bind(entryId, c.business_id, branch.id, c.id, M.toKobo(amount), amount, TG.todayWat(),
          entryId, req.body.reference || null, req.body.applies_to_entry_id || null,
          method, reference, String(s.userId), req.body.notes || null, String(s.userId)).run();
      for (const a of allocation.allocations) {
        await tx.prepare(`INSERT INTO debtor_ledger (id, business_id, branch_id, customer_id, entry_type, direction,
            amount_kobo, amount, entry_date, source_type, source_id, reference, applies_to_entry_id, notes, created_by, created_at, updated_at)
          VALUES (?,?,?,?,'REVERSAL','CREDIT',0,0,?,'PAYMENT_ALLOCATION',?,?,?,?, 'Allocation record', ?, datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), c.business_id, branch.id, c.id, TG.todayWat(), entryId, a.entry_id,
            a.reference, String(s.userId)).run();
      }
      // Cash into the drawer or the safe, so the till still reconciles.
      if (method === 'CASH') {
        await tx.prepare(`INSERT INTO branch_safe_ledger (id, branch_id, movement_type, direction, amount_kobo, amount,
            reference, source_type, source_id, performed_by, notes, created_at, updated_at)
          VALUES (?,?,'TILL_SWEEP','IN',?,?,?,?, 'DEBTOR_PAYMENT', ?, ?, 'Debtor payment received', datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), branch.id, M.toKobo(amount), amount, reference, entryId, String(s.userId)).run();
      }
      // An over-payment is a customer ADVANCE — a liability — never revenue and
      // never a silently dropped amount.
      await gl.postDebtorPayment(tx, {
        business: { id: c.business_id }, branchId: branch.id, entryDate: TG.todayWat(),
        method, amountKobo: M.toKobo(amount), unappliedKobo: allocation.unappliedKobo,
        customerId: c.id, reference, userId: s.userId,
      });
    });

    await core.audit(db, { businessId: c.business_id, branchId: branch.id, userId: s.userId, userRole: s.role, action: 'DEBTOR_PAYMENT', entityType: 'customer', entityId: c.id, after: { amount, method, reference }, severity: 'NOTICE', ipAddress: req.ip });
    return { ok: true, amount, method, reference, allocation, unapplied: allocation.unapplied, unapplied_treatment: allocation.unappliedTreatment, fee: fee.fee };
  }));

  // -------------------------------------------------------------------
  // TILL
  // -------------------------------------------------------------------
  router.post('/till/open', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const branch = await scopeLib.assertBranchAccess(db, s, req.body.branch_id || (s.pinned ? s.branchId : null), { action: 'open a till at' });
    const tillNo = V.str(req.body.till_no || '1', { field: 'till_no', max: 8 });
    // The counted float is REQUIRED, not defaulted. A drawer nobody counted at
    // open cannot be reconciled at close, because the opening figure is a guess —
    // and a guess is what a variance dispute turns on.
    const float = V.money(req.body.opening_float, { field: 'opening_float', min: 0 });
    const existing = await db.prepare("SELECT id FROM till_sessions WHERE branch_id = ? AND till_no = ? AND status = 'OPEN' AND is_deleted = 0").bind(branch.id, tillNo).first();
    if (existing) throw httpError(409, `Till ${tillNo} is already open. Close it before opening another, or two drawers will hold the same money with no way to attribute a variance.`, 'TILL_ALREADY_OPEN');

    const id = IDS.newId();
    await db.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO till_sessions (id, branch_id, till_no, status, opened_by, opened_at,
          opening_float_kobo, opening_float, float_counted_by, sales_count, void_count, refund_count, created_at, updated_at)
        VALUES (?,?,?, 'OPEN', ?, datetime('now'), ?,?,?, 0,0,0, datetime('now'), datetime('now'))`)
        .bind(id, branch.id, tillNo, String(s.userId), M.toKobo(float), float, String(s.userId)).run();
      if (float > 0) {
        await tx.prepare(`INSERT INTO branch_safe_ledger (id, branch_id, movement_type, direction, amount_kobo, amount,
            reference, source_type, source_id, performed_by, notes, created_at, updated_at)
          VALUES (?,?,'FLOAT_IN','OUT',?,?,?,'TILL_SESSION',?,?, 'Float issued to the till', datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), branch.id, M.toKobo(float), float, id, id, String(s.userId)).run();
      }
    });
    await core.audit(db, { businessId: branch.business_id, branchId: branch.id, userId: s.userId, userRole: s.role, action: 'TILL_OPEN', entityType: 'till_session', entityId: id, after: { till_no: tillNo, opening_float: float }, ipAddress: req.ip });
    return { id, till_no: tillNo, branch: branch.name, opening_float: float };
  });

  router.post('/till/:id/close', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const session = await db.prepare('SELECT * FROM till_sessions WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!session) throw httpError(404, 'That till session does not exist.', 'TILL_NOT_FOUND');
    if (!scopeLib.canAccessBranch(s, session.branch_id)) throw httpError(404, 'That till session does not exist.', 'TILL_NOT_FOUND');
    if (session.status !== 'OPEN') throw httpError(409, `That till is already ${session.status.toLowerCase()}.`, 'TILL_NOT_OPEN');

    const settings = await core.getSettings(db);
    const branch = await db.prepare('SELECT * FROM branches WHERE id = ?').bind(session.branch_id).first();

    // EXPECTED, from the payments actually recorded against this session. This is
    // the figure the count is compared to, and it is derived rather than typed so
    // that a discrepancy is evidence rather than an opinion.
    const byMethod = await db.prepare(`
      SELECT method, COALESCE(SUM(amount_kobo),0) AS kobo, COUNT(*) AS n
        FROM sale_payments WHERE till_session_id = ? AND is_deleted = 0 GROUP BY method
    `).bind(session.id).all();
    const expectedByMethod = {};
    for (const r of byMethod) expectedByMethod[r.method] = M.fromKobo(r.kobo);
    const changeOwed = await db.prepare("SELECT COALESCE(SUM(amount_kobo),0) k FROM change_owed WHERE till_session_id = ? AND status='OUTSTANDING'").bind(session.id).first();
    const swept = await db.prepare("SELECT COALESCE(SUM(amount_kobo),0) k FROM branch_safe_ledger WHERE source_type='TILL_SESSION' AND source_id=? AND movement_type='TILL_SWEEP'").bind(session.id).first();

    const counted = V.money(req.body.counted_cash, { field: 'counted_cash', min: 0 });
    const expectedCashKobo = M.toKobo(expectedByMethod.CASH || 0) + M.toKobo(session.opening_float) - Number(swept ? swept.k : 0);
    const varianceKobo = M.toKobo(counted) - expectedCashKobo;
    const toleranceKobo = req.body.tolerance != null ? M.toKobo(req.body.tolerance) : 0;
    const requiresReview = Math.abs(varianceKobo) > toleranceKobo;

    const recon = PAYMENTS.reconcileTill({
      expectedByMethod: { ...expectedByMethod, CASH: M.fromKobo(expectedCashKobo) },
      countedByMethod: { CASH: counted },
    });

    const id = session.id;
    await db.transaction(async (tx) => {
      await tx.prepare(`UPDATE till_sessions SET status=?, closed_by=?, closed_at=datetime('now'), closed_date=?,
          expected_cash_kobo=?, expected_total_kobo=?, counted_cash_kobo=?, variance_kobo=?, variance=?,
          denomination_json=?, swept_to_safe_kobo=?, change_owed_kobo=?, variance_tolerance_kobo=?, requires_review=?,
          notes=?, updated_at=datetime('now') WHERE id=?`)
        .bind(requiresReview ? 'CLOSED' : 'CLOSED', String(s.userId), TG.todayWat(),
          expectedCashKobo, byMethod.reduce((a, r) => a + r.kobo, 0), M.toKobo(counted), varianceKobo, M.fromKobo(varianceKobo),
          req.body.denominations ? JSON.stringify(req.body.denominations) : null,
          Number(swept ? swept.k : 0), Number(changeOwed ? changeOwed.k : 0), toleranceKobo, requiresReview ? 1 : 0,
          req.body.notes || null, id).run();
      // Whatever is left in the drawer goes to the safe, so the safe balance
      // stays derivable and the next shift starts from a counted float.
      if (M.toKobo(counted) > 0) {
        await tx.prepare(`INSERT INTO branch_safe_ledger (id, branch_id, movement_type, direction, amount_kobo, amount,
            reference, source_type, source_id, performed_by, notes, created_at, updated_at)
          VALUES (?,?,'TILL_SWEEP','IN',?,?,?,'TILL_SESSION',?,?, 'Till closed and swept to the safe', datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), branch.id, M.toKobo(counted), counted, id, id, String(s.userId)).run();
        await gl.postCashMovement(tx, {
          business: { id: branch.business_id }, branchId: branch.id, entryDate: TG.todayWat(),
          movementType: 'TILL_SWEEP', amountKobo: M.toKobo(counted), reference: id, userId: s.userId,
        });
      }
    });

    await core.audit(db, {
      businessId: branch.business_id, branchId: branch.id, userId: s.userId, userRole: s.role,
      action: 'TILL_CLOSE', entityType: 'till_session', entityId: id,
      after: { expected: M.fromKobo(expectedCashKobo), counted, variance: M.fromKobo(varianceKobo), requires_review: requiresReview },
      severity: requiresReview ? 'WARNING' : 'INFO', ipAddress: req.ip,
    });

    return {
      id, status: 'CLOSED', closed_date: TG.todayWat(),
      expected_cash: M.fromKobo(expectedCashKobo), counted_cash: counted,
      variance: M.fromKobo(varianceKobo), variance_kobo: varianceKobo,
      tolerance: M.fromKobo(toleranceKobo), requires_review: requiresReview,
      reconciliation: recon,
      by_method: byMethod.map((r) => ({ method: r.method, label: (PAYMENTS.tenderInfo(r.method) || {}).label || r.method, amount: M.fromKobo(r.kobo), count: r.n })),
      change_owed_outstanding: M.fromKobo(Number(changeOwed ? changeOwed.k : 0)),
      swept_to_safe: counted,
      // A variance is not automatically theft and the message must not imply it.
      // The three common innocent causes are named so the manager checks them
      // before they check the cashier.
      review_note: requiresReview
        ? `The drawer is ${varianceKobo < 0 ? 'short' : 'over'} by ${M.fromKobo(Math.abs(varianceKobo)).toLocaleString('en-NG', { minimumFractionDigits: 2 })}. Before treating this as a loss, check: a POS sale recorded as cash, change owed that was paid out without a record, and a safe withdrawal nobody logged.`
        : 'The drawer reconciled.',
    };
  });

  router.get('/till', async (req) => {
    const s = requireScope(req);
    const f = scopeLib.branchFilter(s);
    const rows = await req.db.prepare(`
      SELECT ts.*, b.name AS branch_name, u.full_name AS opened_by_name
        FROM till_sessions ts JOIN branches b ON b.id = ts.branch_id JOIN users u ON u.id = ts.opened_by
       WHERE ts.is_deleted = 0 ${f.sql}
       ORDER BY ts.opened_at DESC LIMIT 100
    `).bind(...f.params).all();
    return rows;
  });

  // -------------------------------------------------------------------
  // SAFE
  // -------------------------------------------------------------------
  router.post('/safe/movements', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const settings = await core.getSettings(db);
    const branch = await scopeLib.assertBranchAccess(db, s, req.body.branch_id || (s.pinned ? s.branchId : null), { action: 'move safe cash at' });
    const movementType = V.oneOf(req.body.movement_type, CREDIT.SAFE_MOVEMENT_TYPES, { field: 'movement_type' });
    const direction = V.oneOf(req.body.direction, ['IN', 'OUT'], { field: 'direction' });
    const amount = V.money(req.body.amount, { field: 'amount', min: 0.01 });

    if (direction === 'OUT') {
      await scopeLib.assertStaffCanSpendFromSafe(db, s, amount, settings);
      const bal = CREDIT.safeBalance(await db.prepare('SELECT * FROM branch_safe_ledger WHERE branch_id = ? AND is_deleted = 0').bind(branch.id).all());
      if (M.toKobo(amount) > bal.balanceKobo) {
        throw httpError(409, `The safe holds ${bal.balance}. This withdrawal of ${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} would take it negative.`, 'INSUFFICIENT_SAFE_BALANCE');
      }
    }
    const id = IDS.newId();
    await db.prepare(`INSERT INTO branch_safe_ledger (id, branch_id, movement_type, direction, amount_kobo, amount,
        reference, source_type, source_id, approved_by, performed_by, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`)
      .bind(id, branch.id, movementType, direction, M.toKobo(amount), amount,
        req.body.reference || null, req.body.source_type || null, req.body.source_id || null,
        s.rank >= scopeLib.rank('MANAGER') ? String(s.userId) : null, String(s.userId), req.body.notes || null).run();
    await core.audit(db, { businessId: branch.business_id, branchId: branch.id, userId: s.userId, userRole: s.role, action: 'SAFE_MOVEMENT', entityType: 'branch_safe_ledger', entityId: id, after: { movement_type: movementType, direction, amount }, severity: direction === 'OUT' && amount > 20000 ? 'WARNING' : 'INFO', ipAddress: req.ip });
    const bal = CREDIT.safeBalance(await db.prepare('SELECT * FROM branch_safe_ledger WHERE branch_id = ? AND is_deleted = 0').bind(branch.id).all());
    return { id, balance: bal.balance, movement_type: movementType, direction, amount };
  });

  router.get('/safe/:branchId', async (req) => {
    const s = requireScope(req);
    const branch = await scopeLib.assertBranchAccess(req.db, s, req.params.branchId, { action: 'view the safe at' });
    const rows = await req.db.prepare(`SELECT sl.*, u.full_name AS performed_by_name, a.full_name AS approved_by_name
        FROM branch_safe_ledger sl LEFT JOIN users u ON u.id = sl.performed_by LEFT JOIN users a ON a.id = sl.approved_by
       WHERE sl.branch_id = ? AND sl.is_deleted = 0 ORDER BY sl.created_at DESC LIMIT 300`).bind(branch.id).all();
    return { branch: { id: branch.id, name: branch.name }, movements: rows, balance: CREDIT.safeBalance(rows) };
  });

  // -------------------------------------------------------------------
  // CHANGE OWED
  // -------------------------------------------------------------------
  router.get('/change-owed', async (req) => {
    const s = requireScope(req);
    const f = scopeLib.branchFilter(s);
    const rows = await req.db.prepare(`SELECT * FROM v_change_owed_outstanding WHERE 1=1 ${f.sql} ORDER BY days_outstanding DESC LIMIT 300`).bind(...f.params).all();
    return { rows, total: M.round2(rows.reduce((a, r) => a + Number(r.amount || 0), 0)), count: rows.length };
  });

  router.get('/change-owed/lookup/:code', publicRoute(async (req) => {
    // PUBLIC on purpose, and deliberately narrow: a customer standing at any
    // branch with a claim code must be able to collect their change without
    // first being added as a customer record or having a staff member sign in on
    // their behalf. It returns whether the code is valid and the amount — never
    // the buyer's name, phone or which branch issued it, because a code is
    // guessable-adjacent and those details are not.
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,12}$/.test(code)) return { found: false };
    const row = await req.db.prepare(`SELECT claim_code, status, amount, branch_id FROM change_owed WHERE claim_code = ? AND is_deleted = 0`).bind(code).first();
    if (!row) return { found: false };
    return { found: true, claim_code: row.claim_code, status: row.status, amount: row.amount, collectable: row.status === 'OUTSTANDING' };
  }));

  router.post('/change-owed/:id/collect', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const row = await req.db.prepare('SELECT * FROM change_owed WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!row) throw httpError(404, 'That change-owed record does not exist.', 'NOT_FOUND');
    if (row.status !== 'OUTSTANDING') throw httpError(409, `That record is already ${row.status.toLowerCase()}.`, 'ALREADY_SETTLED');
    const branch = await scopeLib.assertBranchAccess(req.db, s, s.pinned ? s.branchId : row.branch_id, { action: 'pay out change at' });
    await req.db.transaction(async (tx) => {
      await tx.prepare(`UPDATE change_owed SET status='COLLECTED', collected_at=datetime('now'), collected_by=?,
          collected_at_branch_id=?, updated_at=datetime('now') WHERE id=?`)
        .bind(String(s.userId), branch.id, row.id).run();
      await tx.prepare(`INSERT INTO branch_safe_ledger (id, branch_id, movement_type, direction, amount_kobo, amount,
          reference, source_type, source_id, performed_by, notes, created_at, updated_at)
        VALUES (?,?,'CHANGE_GIVEN','OUT',?,?,?,'CHANGE_OWED',?,?, 'Change owed paid to the customer', datetime('now'), datetime('now'))`)
        .bind(IDS.newId(), branch.id, row.amount_kobo, row.amount, row.claim_code, row.id, String(s.userId)).run();
      await gl.postChangeOwed(tx, { business: { id: row.business_id }, branchId: branch.id, entryDate: TG.todayWat(), amountKobo: row.amount_kobo, direction: 'OUT', reference: row.claim_code, userId: s.userId });
    });
    return { ok: true, amount: row.amount, paid_at_branch: branch.name };
  });

  // -------------------------------------------------------------------
  // LAYAWAY HOLDS
  // -------------------------------------------------------------------
  router.get('/holds', async (req) => {
    const s = requireScope(req);
    const f = scopeLib.branchFilter(s);
    const status = req.query.status || 'ACTIVE';
    const rows = await req.db.prepare(`SELECT * FROM v_layaway_holds_active WHERE 1=1 ${f.sql} ORDER BY expires_on LIMIT 200`).bind(...f.params).all();
    return status === 'ACTIVE' ? rows : await req.db.prepare(`SELECT * FROM layaway_holds WHERE is_deleted = 0 AND status = ? ${f.sql} ORDER BY created_at DESC LIMIT 200`).bind(status, ...f.params).all();
  });

  router.post('/holds', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const settings = await core.getSettings(db);
    const b = req.body;
    const branch = await scopeLib.assertBranchAccess(db, s, b.branch_id || (s.pinned ? s.branchId : null), { action: 'hold stock at' });
    const business = await core.getBusiness(db, branch.business_id);
    core.assertModuleEnabled(business, 'layaway', 'Layaway holds');

    const customer = b.customer_id
      ? await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(String(b.customer_id)).first()
      : null;
    if (b.customer_id && !customer) throw httpError(400, 'That customer does not exist.', 'CUSTOMER_NOT_FOUND');

    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw httpError(400, 'Add at least one item to hold.', 'NO_ITEMS');

    const deposit = b.deposit != null ? V.money(b.deposit, { field: 'deposit', min: 0 }) : 0;
    const created = LAYAWAY.createHold({
      product: null, branchId: branch.id, customerId: customer ? customer.id : null,
      quantity: items.reduce((a, i) => a + (Number(i.quantity) || 0), 0),
      deposit, holdDays: b.hold_days != null ? Number(b.hold_days) : Number(settings.layaway_default_hold_days),
      reason: b.reason, notes: b.notes, startDate: TG.todayWat(), sellingPrice: 0,
    });
    if (!created.ok) throw httpError(400, created.error, created.code);

    const holdId = IDS.newId();
    let totalValueKobo = 0;
    const resolvedItems = [];
    for (const it of items) {
      const p = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(String(it.product_id)).first();
      if (!p) throw httpError(400, 'One of those products does not exist.', 'PRODUCT_NOT_FOUND');
      if (String(p.business_id) !== String(business.id)) throw httpError(400, `"${p.name}" belongs to another business.`, 'PRODUCT_OUT_OF_SCOPE');
      const qty = V.int(it.quantity, { field: 'quantity', min: 1 });
      const batches = await db.prepare(`SELECT * FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0 AND quantity_on_hand - quantity_reserved >= ? ORDER BY received_at LIMIT 1`)
        .bind(p.id, branch.id, qty).first();
      if (!batches) {
        throw httpError(409, `"${p.name}" does not have ${qty} sellable unit(s) at ${branch.name}. A hold reserves real stock — it cannot reserve units that are already spoken for.`, 'INSUFFICIENT_STOCK');
      }
      const price = it.unit_price != null ? V.money(it.unit_price, { field: 'unit_price', min: 0 }) : Number(p.default_selling_price) || 0;
      totalValueKobo += M.toKobo(price) * qty;
      resolvedItems.push({ product: p, qty, price, batch: batches });
    }

    const doc = await core.nextDocNumber(db, { businessId: business.id, branchId: branch.id, docType: 'VOUCHER', prefix: 'HLD' });
    if (M.toKobo(deposit) > totalValueKobo) throw httpError(400, 'The deposit cannot exceed the value of the held items.', 'DEPOSIT_EXCEEDS_VALUE');

    await db.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO layaway_holds (id, business_id, branch_id, hold_number, customer_id, customer_name,
          customer_phone, status, reason, deposit_kobo, deposit, total_value_kobo, total_value, balance_kobo,
          deposit_percent, held_from, expires_on, created_by, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`)
        .bind(holdId, business.id, branch.id, doc.number, customer ? customer.id : null,
          customer ? customer.name : (b.customer_name || null), customer ? customer.phone : (b.customer_phone || null),
          'ACTIVE', created.hold.reason, M.toKobo(deposit), deposit, totalValueKobo, M.fromKobo(totalValueKobo),
          totalValueKobo - M.toKobo(deposit), totalValueKobo > 0 ? M.round2((M.toKobo(deposit) / totalValueKobo) * 100) : 0,
          created.hold.held_from, created.hold.expires_on, String(s.userId), b.notes || null).run();

      for (const it of resolvedItems) {
        await tx.prepare(`INSERT INTO layaway_hold_items (id, hold_id, product_id, stock_batch_id, quantity,
            unit_price_kobo, line_total_kobo, reserved, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,1, datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), holdId, it.product.id, it.batch.id, it.qty,
            M.toKobo(it.price), M.toKobo(it.price) * it.qty).run();
        // RESERVE, do not decrement. The unit is still on the shelf; it is just
        // no longer sellable to anyone else.
        await tx.prepare("UPDATE stock_batches SET quantity_reserved = quantity_reserved + ?, updated_at = datetime('now') WHERE id = ? AND quantity_on_hand - quantity_reserved >= ?")
          .bind(it.qty, it.batch.id, it.qty).run();
        await tx.prepare(`INSERT INTO stock_movements (id, business_id, branch_id, product_id, stock_batch_id,
            movement_type, direction, quantity, value_kobo, unit_cost, reservation_delta, source_type, source_id,
            moved_by, notes, moved_at)
          VALUES (?,?,?,?,?, 'LAYAWAY_RESERVE', 0, 0, 0, ?, ?, 'HOLD', ?, ?, ?, datetime('now'))`)
          .bind(IDS.newId(), business.id, branch.id, it.product.id, it.batch.id,
            Number(it.batch.cost_per_unit) || 0, it.qty, holdId, String(s.userId), `Hold ${doc.number}`).run();
        if (Number(it.product.serial_tracking) === 1 && Array.isArray(it.serial_numbers)) {
          for (const sn of it.serial_numbers) {
            await tx.prepare("UPDATE serial_numbers SET status='RESERVED', updated_at=datetime('now') WHERE business_id = ? AND serial_normalised = ?")
              .bind(String(business.id), WARRANTY.normaliseSerial(sn)).run();
          }
        }
      }
      if (M.toKobo(deposit) > 0) {
        await gl.postLayawayDeposit(tx, { business, branchId: branch.id, entryDate: TG.todayWat(), amountKobo: M.toKobo(deposit), holdNumber: doc.number, userId: s.userId });
      }
    });
    return { id: holdId, hold_number: doc.number, expires_on: created.hold.expires_on, total_value: M.fromKobo(totalValueKobo), deposit, balance: M.fromKobo(totalValueKobo - M.toKobo(deposit)) };
  });

  router.post('/holds/:id/release', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const hold = await db.prepare('SELECT * FROM layaway_holds WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!hold) throw httpError(404, 'That hold does not exist.', 'HOLD_NOT_FOUND');
    if (!scopeLib.canAccessBranch(s, hold.branch_id)) throw httpError(404, 'That hold does not exist.', 'HOLD_NOT_FOUND');
    if (hold.status !== 'ACTIVE') throw httpError(409, `That hold is already ${hold.status.toLowerCase()}.`, 'HOLD_NOT_ACTIVE');
    const settings = await core.getSettings(db);
    const rel = LAYAWAY.releaseHold({
      hold, reason: req.body.reason || 'MANUAL',
      refundDeposit: req.body.refund_deposit !== false,
      forfeitPercent: req.body.forfeit_percent != null ? Number(req.body.forfeit_percent) : Number(settings.layaway_forfeit_percent) || 0,
    });
    await db.transaction(async (tx) => {
      await tx.prepare(`UPDATE layaway_holds SET status=?, released_at=datetime('now'), released_by=?, release_reason=?,
          forfeited_kobo=?, refunded_kobo=?, updated_at=datetime('now') WHERE id=?`)
        .bind(rel.status, String(s.userId), rel.release_reason,
          rel.glTreatment ? rel.glTreatment.amount_kobo : 0, M.toKobo(rel.deposit_refundable), hold.id).run();
      const items = await tx.prepare('SELECT * FROM layaway_hold_items WHERE hold_id = ? AND reserved = 1 AND is_deleted = 0').bind(hold.id).all();
      for (const it of items) {
        await tx.prepare("UPDATE stock_batches SET quantity_reserved = MAX(0, quantity_reserved - ?), updated_at=datetime('now') WHERE id = ?")
          .bind(Number(it.quantity), it.stock_batch_id).run();
        await tx.prepare("UPDATE layaway_hold_items SET reserved = 0, released_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(it.id).run();
        await tx.prepare(`INSERT INTO stock_movements (id, business_id, branch_id, product_id, stock_batch_id,
            movement_type, direction, quantity, value_kobo, unit_cost, reservation_delta, source_type, source_id, moved_by, notes, moved_at)
          VALUES (?,?,?,?,?, 'LAYAWAY_RELEASE', 0, 0, 0, 0, ?, 'HOLD', ?, ?, ?, datetime('now'))`)
          .bind(IDS.newId(), hold.business_id, hold.branch_id, it.product_id, it.stock_batch_id,
            -Number(it.quantity), hold.id, String(s.userId), `Hold released: ${rel.release_reason}`).run();
      }
      await tx.prepare("UPDATE serial_numbers SET status='IN_STOCK', updated_at=datetime('now') WHERE id IN (SELECT serial_id FROM layaway_hold_items WHERE hold_id = ?) ")
        .bind(hold.id).run();
      // A forfeited deposit is OTHER INCOME: no goods left the shop, so booking
      // it as sales revenue would overstate turnover and understate margin.
      if (rel.glTreatment) {
        await gl.postForfeitedDeposit(tx, { business: { id: hold.business_id }, branchId: hold.branch_id, entryDate: TG.todayWat(), amountKobo: rel.glTreatment.amount_kobo, holdNumber: hold.hold_number, userId: s.userId });
      }
      if (rel.deposit_refundable > 0) {
        await tx.prepare(`INSERT INTO branch_safe_ledger (id, branch_id, movement_type, direction, amount_kobo, amount,
            reference, source_type, source_id, performed_by, notes, created_at, updated_at)
          VALUES (?,?,'REFUND','OUT',?,?,?,'LAYAWAY_HOLD',?,?, 'Layaway deposit refunded', datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), hold.branch_id, M.toKobo(rel.deposit_refundable), rel.deposit_refundable, hold.hold_number, hold.id, String(s.userId)).run();
      }
    });
    await core.audit(db, { businessId: hold.business_id, branchId: hold.branch_id, userId: s.userId, userRole: s.role, action: 'HOLD_RELEASE', entityType: 'layaway_hold', entityId: hold.id, after: rel, severity: rel.glTreatment ? 'WARNING' : 'INFO', ipAddress: req.ip });
    return { ok: true, ...rel };
  });

  // -------------------------------------------------------------------
  // INSTALLMENT PLANS
  // -------------------------------------------------------------------
  router.get('/instalments', async (req) => {
    const s = requireScope(req);
    const f = scopeLib.branchFilter(s);
    const rows = await req.db.prepare(`SELECT * FROM v_instalment_plans_active WHERE 1=1 ${f.sql} ORDER BY next_due_date LIMIT 300`).bind(...f.params).all();
    return rows;
  });

  router.post('/instalments', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const settings = await core.getSettings(db);
    const b = req.body;
    const branch = await scopeLib.assertBranchAccess(db, s, b.branch_id || (s.pinned ? s.branchId : null), { action: 'open an instalment plan at' });
    const business = await core.getBusiness(db, branch.business_id);
    core.assertModuleEnabled(business, 'instalments', 'Instalment plans');
    const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(String(b.customer_id)).first();
    if (!customer) throw httpError(400, 'An instalment plan needs a named customer.', 'CUSTOMER_NOT_FOUND');

    const total = V.money(b.total_amount, { field: 'total_amount', min: 1 });
    const deposit = V.money(b.deposit, { field: 'deposit', min: 0 });
    const tenorMonths = Math.ceil((Number(b.instalments) || 1) * (String(b.frequency || 'MONTHLY').toUpperCase() === 'WEEKLY' ? 7 / 30 : String(b.frequency).toUpperCase() === 'FORTNIGHTLY' ? 14 / 30 : 1));
    if (tenorMonths > Number(settings.instalment_max_tenor_months)) {
      throw httpError(409, `The longest plan this business allows is ${settings.instalment_max_tenor_months} months. This one runs for about ${tenorMonths}.`, 'TENOR_TOO_LONG');
    }

    const plan = INSTAL.buildPlan({
      totalAmount: total, deposit, instalments: V.int(b.instalments, { field: 'instalments', min: 1, max: 120 }),
      frequency: V.oneOf(b.frequency || 'MONTHLY', INSTAL.FREQUENCIES, { field: 'frequency' }),
      startDate: TG.todayWat(),
      model: V.oneOf(b.model || 'LAYAWAY_BACKED', INSTAL.PLAN_MODELS, { field: 'model' }),
      planFeePercent: Number(settings.instalment_plan_fee_percent) || 0,
      lateFeePercent: Number(settings.instalment_late_fee_percent) || 0,
      graceDays: Number(settings.instalment_grace_days) || 0,
      policy: { minDepositPercent: Number(settings.instalment_min_deposit_percent) || 0, missedBeforeDefault: Number(settings.instalment_missed_before_default) || 3 },
    });

    const id = IDS.newId();
    const doc = await core.nextDocNumber(db, { businessId: business.id, branchId: branch.id, docType: 'CREDIT_NOTE', prefix: 'PLN' });
    await db.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO instalment_plans (id, business_id, branch_id, plan_number, customer_id, sale_id,
          model, status, frequency, total_kobo, deposit_kobo, deposit_percent, plan_fee_kobo, plan_fee_percent,
          financed_kobo, paid_kobo, outstanding_kobo, instalment_count, late_fee_percent, grace_days,
          missed_before_default, start_date, first_due_date, last_due_date, schedule_json, created_by, notes,
          created_at, updated_at)
        VALUES (?,?,?,?,?,?,?, 'ACTIVE',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`)
        .bind(id, business.id, branch.id, doc.number, customer.id, b.sale_id || null,
          plan.model, plan.frequency, plan.totalKobo, plan.depositKobo, plan.depositPercent,
          plan.planFeeKobo, plan.planFeePercent, plan.financedKobo, plan.depositKobo, plan.financedKobo,
          plan.instalmentCount, plan.lateFeePercent, plan.graceDays, plan.missedBeforeDefault,
          plan.startDate, plan.firstDueDate, plan.lastDueDate, JSON.stringify(plan.schedule),
          String(s.userId), b.notes || null).run();
      for (const inst of plan.schedule) {
        await tx.prepare(`INSERT INTO instalment_schedule (id, plan_id, seq, due_date, amount_kobo, amount, paid_kobo, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,0,'SCHEDULED', datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), id, inst.seq, inst.due_date, inst.amount_kobo, inst.amount).run();
      }
      if (plan.depositKobo > 0) {
        await tx.prepare(`INSERT INTO debtor_ledger (id, business_id, branch_id, customer_id, entry_type, direction,
            amount_kobo, amount, entry_date, terms_code, source_type, source_id, reference, method, notes, created_by, created_at, updated_at)
          VALUES (?,?,?,?, 'INSTALLMENT_DUE','DEBIT', ?,?,?, 'CASH', 'PLAN', ?, ?, 'CASH', 'Instalment plan deposit', ?, datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), business.id, branch.id, customer.id, plan.financedKobo, M.fromKobo(plan.financedKobo),
            TG.todayWat(), id, doc.number, String(s.userId)).run();
      }
      // LAYAWAY_BACKED reserves the goods; DELIVERED_ON_DEPOSIT would have
      // already decremented them through the linked sale.
      if (plan.model === 'LAYAWAY_BACKED' && Array.isArray(b.items)) {
        for (const it of b.items) {
          const batch = await tx.prepare(`SELECT * FROM stock_batches WHERE product_id = ? AND branch_id = ?
              AND quantity_on_hand - quantity_reserved >= ? AND is_deleted = 0 ORDER BY received_at LIMIT 1`)
            .bind(String(it.product_id), branch.id, V.int(it.quantity, { field: 'quantity', min: 1 })).first();
          if (!batch) throw httpError(409, 'Not enough sellable stock to reserve against this plan.', 'INSUFFICIENT_STOCK');
          await tx.prepare("UPDATE stock_batches SET quantity_reserved = quantity_reserved + ?, updated_at=datetime('now') WHERE id=?").bind(Number(it.quantity), batch.id).run();
        }
      }
    });
    await core.audit(db, { businessId: business.id, branchId: branch.id, userId: s.userId, userRole: s.role, action: 'PLAN_CREATE', entityType: 'instalment_plan', entityId: id, after: { total, deposit, instalments: plan.instalmentCount, model: plan.model }, severity: 'NOTICE', ipAddress: req.ip });
    return { id, plan_number: doc.number, ...plan };
  });

  router.post('/instalments/:id/payments', async (req) => withIdempotency(req, req.headers['idempotency-key'], async () => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const plan = await db.prepare('SELECT * FROM instalment_plans WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!plan) throw httpError(404, 'That plan does not exist.', 'PLAN_NOT_FOUND');
    if (!scopeLib.canAccessBranch(s, plan.branch_id)) throw httpError(404, 'That plan does not exist.', 'PLAN_NOT_FOUND');
    if (!['ACTIVE', 'DEFAULTED'].includes(plan.status)) throw httpError(409, `That plan is ${plan.status.toLowerCase()} and cannot take a payment.`, 'PLAN_NOT_ACTIVE');

    const amount = V.money(req.body.amount, { field: 'amount', min: 0.01 });
    const schedule = (await db.prepare('SELECT * FROM instalment_schedule WHERE plan_id = ? AND is_deleted = 0 ORDER BY seq').bind(plan.id).all())
      .map((r) => ({ ...r, amount_kobo: Number(r.amount_kobo), paid_kobo: Number(r.paid_kobo) }));
    const planObj = { ...plan, graceDays: Number(plan.grace_days), missedBeforeDefault: Number(plan.missed_before_default), deposit: M.fromKobo(plan.deposit_kobo), total: M.fromKobo(plan.total_kobo), planFee: M.fromKobo(plan.plan_fee_kobo) };
    const result = INSTAL.applyPayment({ plan: planObj, schedule, payment: amount, paidAtIso: req.body.paid_at || TG.todayWat() });

    await db.transaction(async (tx) => {
      for (const inst of result.schedule) {
        await tx.prepare(`UPDATE instalment_schedule SET paid_kobo=?, status=?, paid_at=?, late_fee_kobo=?, updated_at=datetime('now')
           WHERE id = ?`).bind(inst.paid_kobo || 0, inst.status, inst.status === 'PAID' || inst.status === 'LATE_PAID' ? TG.todayWat() : null,
            inst.late_fee_charged_kobo || 0, inst.id).run();
      }
      await tx.prepare(`UPDATE instalment_plans SET paid_kobo = paid_kobo + ?, outstanding_kobo = ?, late_fees_kobo = late_fees_kobo + ?,
          missed_count = ?, status = ?, completed_at = CASE WHEN ? = 'COMPLETED' THEN datetime('now') ELSE completed_at END,
          defaulted_at = CASE WHEN ? = 'DEFAULTED' THEN datetime('now') ELSE defaulted_at END, updated_at = datetime('now') WHERE id = ?`)
        .bind(M.toKobo(amount), Math.max(0, Number(plan.outstanding_kobo) - M.toKobo(amount)),
          result.lateFeesChargedKobo, result.missedCount, result.status, result.status, result.status, plan.id).run();
      await tx.prepare(`INSERT INTO debtor_ledger (id, business_id, branch_id, customer_id, entry_type, direction,
          amount_kobo, amount, entry_date, source_type, source_id, reference, method, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?, 'PAYMENT','CREDIT', ?,?,?,'PLAN',?,?,?, 'Instalment payment', ?, datetime('now'), datetime('now'))`)
        .bind(IDS.newId(), plan.business_id, plan.branch_id, plan.customer_id, M.toKobo(amount), amount,
          TG.todayWat(), plan.id, plan.plan_number, req.body.method || 'CASH', String(s.userId)).run();
      await gl.postInstalmentPayment(tx, { business: { id: plan.business_id }, branchId: plan.branch_id, entryDate: TG.todayWat(), amountKobo: M.toKobo(amount), method: req.body.method || 'CASH', planNumber: plan.plan_number, userId: s.userId });
      // Completing a LAYAWAY_BACKED plan releases the reservation: the goods now
      // belong to the customer and leave the shelf.
      if (result.status === 'COMPLETED' && plan.model === 'LAYAWAY_BACKED') {
        const items = await tx.prepare(`SELECT * FROM layaway_hold_items WHERE hold_id IN (SELECT id FROM layaway_holds WHERE converted_plan_id = ?) AND reserved = 1`).bind(plan.id).all();
        for (const it of items) {
          await tx.prepare("UPDATE stock_batches SET quantity_reserved = MAX(0, quantity_reserved - ?), quantity_on_hand = quantity_on_hand - ?, updated_at=datetime('now') WHERE id=?")
            .bind(Number(it.quantity), Number(it.quantity), it.stock_batch_id).run();
        }
      }
    });
    await core.audit(db, { businessId: plan.business_id, branchId: plan.branch_id, userId: s.userId, userRole: s.role, action: 'PLAN_PAYMENT', entityType: 'instalment_plan', entityId: plan.id, after: { amount, status: result.status }, ipAddress: req.ip });
    return { ok: true, amount, applied: result.entries, late_fees: result.lateFeesCharged, outstanding: result.outstanding, status: result.status, unapplied: result.unapplied };
  }));

  // -------------------------------------------------------------------
  // WARRANTY
  // -------------------------------------------------------------------
  router.get('/warranty/lookup/:serial', async (req) => {
    const s = requireScope(req);
    const norm = WARRANTY.normaliseSerial(req.params.serial);
    if (!norm) throw httpError(400, 'Enter or scan a serial number.', 'SERIAL_REQUIRED');
    const row = await req.db.prepare(`
      SELECT sn.*, p.name AS product_name, p.sku, p.warranty_months AS product_warranty_months,
             b.name AS branch_name, c.name AS customer_name, c.phone AS customer_phone,
             s.sale_number, s.sale_date, s.total
        FROM serial_numbers sn
        JOIN products p ON p.id = sn.product_id
        LEFT JOIN branches b ON b.id = sn.branch_id
        LEFT JOIN customers c ON c.id = sn.customer_id
        LEFT JOIN sales s ON s.id = sn.sale_id
       WHERE sn.serial_normalised = ? AND sn.is_deleted = 0
    `).bind(norm).first();
    if (!row) return { found: false, serial: norm, message: 'That serial number is not in this system. It may have been sold by another retailer.' };
    if (!scopeLib.canAccessBusiness(s, row.business_id)) throw httpError(404, 'That serial number is not in this system.', 'NOT_FOUND');
    const cover = WARRANTY.assessCover({ serial: row, product: row, sale: row.sale_date ? { sale_date: row.sale_date, receipt_number: row.sale_number } : null });
    const claims = await req.db.prepare('SELECT * FROM warranty_claims WHERE serial_id = ? AND is_deleted = 0 ORDER BY opened_on DESC').bind(row.id).all();
    return { found: true, serial: row, cover, claims };
  });

  router.post('/warranty/claims', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const b = req.body;
    const norm = WARRANTY.normaliseSerial(b.serial_number);
    const serial = await db.prepare('SELECT * FROM serial_numbers WHERE serial_normalised = ? AND is_deleted = 0').bind(norm).first();
    if (!serial) throw httpError(404, 'That serial number is not recorded. Find the unit first — a claim against an untracked serial cannot be evidenced.', 'SERIAL_NOT_FOUND');
    if (!scopeLib.canAccessBusiness(s, serial.business_id)) throw httpError(404, 'That serial number is not recorded.', 'SERIAL_NOT_FOUND');
    const sale = serial.sale_id ? await db.prepare('SELECT * FROM sales WHERE id = ?').bind(serial.sale_id).first() : null;
    const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(serial.product_id).first();
    const cover = WARRANTY.assessCover({ serial, product, sale: sale ? { sale_date: sale.sale_date, receipt_number: sale.sale_number } : null });
    const claim = WARRANTY.openClaim({ serial, cover, claimType: b.claim_type, reportedBy: { id: b.customer_id, name: b.customer_name, phone: b.customer_phone }, description: b.description, responsibility: b.responsibility });
    if (!claim.ok) throw httpError(400, claim.error, claim.code);

    const id = IDS.newId();
    const branch = await scopeLib.assertBranchAccess(db, s, b.branch_id || (s.pinned ? s.branchId : serial.branch_id), { action: 'open a warranty claim at' });
    const doc = await core.nextDocNumber(db, { businessId: serial.business_id, branchId: branch.id, docType: 'RETURN', prefix: 'WCL' });
    await db.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO warranty_claims (id, business_id, branch_id, claim_number, serial_id, serial_number,
          product_id, sale_id, customer_id, customer_name, customer_phone, claim_type, status, responsibility,
          chargeable, in_cover_at_open, cover_status, cover_expires_on, cover_days_remaining, fault_description,
          rma_number, opened_by, opened_on, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'OPEN',?,?,?,?,?,?,?,?,?,?,?, ?, datetime('now'), datetime('now'))`)
        .bind(id, serial.business_id, branch.id, doc.number, serial.id, serial.serial_number,
          serial.product_id, serial.sale_id || null, serial.customer_id || b.customer_id || null,
          claim.claim.customer_name || null, claim.claim.customer_phone || null, claim.claim.claim_type,
          claim.claim.responsibility, claim.claim.chargeable ? 1 : 0, claim.claim.in_cover_at_open ? 1 : 0,
          claim.claim.cover_status, claim.claim.cover_expires_on, cover.daysRemaining,
          claim.claim.description, b.rma_number || null, String(s.userId), TG.todayWat(), b.notes || null).run();
      if (claim.serialStatusTransition) {
        await tx.prepare("UPDATE serial_numbers SET status=?, warranty_status='PENDING_CLAIM', updated_at=datetime('now') WHERE id=?")
          .bind(claim.serialStatusTransition, serial.id).run();
        await tx.prepare(`INSERT INTO serial_history (id, serial_id, event_type, from_branch_id, from_status, to_status,
            source_type, source_id, performed_by, notes, occurred_at)
          VALUES (?,?, 'REPAIR_SENT', ?,?,?,'WARRANTY_CLAIM',?,?,?, datetime('now'))`)
          .bind(IDS.newId(), serial.id, branch.id, serial.status, claim.serialStatusTransition, id, String(s.userId), claim.claim.description.slice(0, 200)).run();
      }
      await tx.prepare(`INSERT INTO warranty_claim_events (id, claim_id, event_type, to_status, description, performed_by, occurred_at)
        VALUES (?,?, 'OPENED','OPEN',?,?, datetime('now'))`)
        .bind(IDS.newId(), id, claim.claim.description, String(s.userId)).run();
    });
    await core.audit(db, { businessId: serial.business_id, branchId: branch.id, userId: s.userId, userRole: s.role, action: 'WARRANTY_CLAIM_OPEN', entityType: 'warranty_claim', entityId: id, after: { serial: serial.serial_number, type: claim.claim.claim_type, responsibility: claim.claim.responsibility, chargeable: claim.claim.chargeable }, severity: claim.claim.chargeable ? 'NOTICE' : 'INFO', ipAddress: req.ip });
    return { id, claim_number: doc.number, ...claim.claim, cover, note: claim.notes };
  });

  // -------------------------------------------------------------------
  // DELIVERY
  // -------------------------------------------------------------------
  router.get('/delivery/zones', async (req) => {
    const s = requireScope(req);
    const bf = scopeLib.businessFilter(s);
    return req.db.prepare(`SELECT * FROM delivery_zones WHERE is_deleted = 0 AND is_active = 1 ${bf.sql} ORDER BY sort_order, name`).bind(...bf.params).all();
  });

  router.post('/delivery/quote', async (req) => {
    const s = requireScope(req);
    const b = req.body;
    const zone = b.zone_id ? await req.db.prepare('SELECT * FROM delivery_zones WHERE id = ? AND is_deleted = 0').bind(String(b.zone_id)).first() : null;
    if (b.zone_id && !zone) throw httpError(404, 'That delivery zone does not exist.', 'ZONE_NOT_FOUND');
    const items = Array.isArray(b.items) ? b.items : [];
    for (const it of items) {
      if (it.product_id && !it.base_unit) {
        const p = await req.db.prepare('SELECT base_unit FROM products WHERE id = ?').bind(String(it.product_id)).first();
        if (p) it.base_unit = p.base_unit;
      }
    }
    return DELIVERY.quoteDelivery({
      zone, distanceKm: b.distance_km != null ? Number(b.distance_km) : (zone ? Number(zone.default_distance_km) || 0 : 0),
      items, floors: b.floors, hasLift: b.has_lift !== false,
      installationRequired: !!b.installation_required, installationLabour: b.installation_labour,
      discountKobo: b.discount != null ? M.toKobo(b.discount) : 0,
    });
  });

  router.get('/delivery/jobs', async (req) => {
    const s = requireScope(req);
    const f = scopeLib.branchFilter(s);
    const date = req.query.date;
    const params = [...f.params];
    let extra = '';
    if (date) { extra = ' AND scheduled_date = ?'; params.push(date); }
    const rows = await req.db.prepare(`SELECT * FROM v_delivery_jobs_open WHERE 1=1 ${f.sql} ${extra} ORDER BY scheduled_date, window_start LIMIT 300`).bind(...params).all();
    return rows;
  });

  router.post('/delivery/jobs', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const b = req.body;
    const branch = await scopeLib.assertBranchAccess(db, s, b.branch_id || (s.pinned ? s.branchId : null), { action: 'book a delivery from' });
    const business = await core.getBusiness(db, branch.business_id);
    core.assertModuleEnabled(business, 'delivery', 'Delivery jobs');
    const sale = b.sale_id ? await db.prepare('SELECT * FROM sales WHERE id = ? AND is_deleted = 0').bind(String(b.sale_id)).first() : null;
    if (b.sale_id && !sale) throw httpError(400, 'That sale does not exist.', 'SALE_NOT_FOUND');
    const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(String(b.customer_id || (sale && sale.customer_id))).first();
    if (!customer) throw httpError(400, 'A delivery job needs a customer.', 'CUSTOMER_REQUIRED');

    const items = Array.isArray(b.items) && b.items.length ? b.items
      : (sale ? await db.prepare('SELECT product_id, product_name, base_quantity AS quantity, stock_batch_id FROM sale_items WHERE sale_id = ? AND is_deleted = 0').bind(sale.id).all() : []);
    const job = DELIVERY.buildJob({
      saleId: sale ? sale.id : null, branchId: branch.id, customerId: customer.id, jobType: b.job_type,
      items, slot: { date: b.scheduled_date, window_start: b.window_start, window_end: b.window_end, area: b.area, lga: b.lga, state: b.state_code, contact_name: b.contact_name, contact_phone: b.contact_phone || customer.phone, landmark: b.landmark, vehicle_registration: b.vehicle_registration },
      address: b.address || customer.address, driver: b.driver_id ? { id: b.driver_id } : null,
      fee: b.fee, notes: b.notes, vehicle: b.vehicle_type,
    });
    if (!job.ok) throw httpError(400, job.error, job.code);

    // Slot capacity: a branch has a finite number of trucks, and letting a
    // cashier book forty deliveries for Saturday is how a shop breaks a promise
    // it cannot keep.
    const booked = await db.prepare("SELECT COUNT(*) c FROM delivery_jobs WHERE branch_id = ? AND scheduled_date = ? AND status IN ('SCHEDULED','CONFIRMED','DISPATCHED','IN_TRANSIT') AND is_deleted = 0")
      .bind(branch.id, job.job.scheduled_date).first();
    const capacity = DELIVERY.slotCapacity({ booked: booked.c, capacity: Number(branch.daily_delivery_capacity) || 0 });
    if (capacity.isFull && !b.overbook) {
      throw httpError(409, `${capacity.message} A manager can overbook from the delivery screen.`, 'DELIVERY_SLOT_FULL');
    }

    const id = IDS.newId();
    const doc = await core.nextDocNumber(db, { businessId: business.id, branchId: branch.id, docType: 'DELIVERY' });
    await db.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO delivery_jobs (id, business_id, branch_id, job_number, sale_id, customer_id,
          job_type, status, scheduled_date, window_start, window_end, address, landmark, area, lga, state_code,
          zone_id, zone_code, distance_km, floors, has_lift, needs_two_man, contact_name, contact_phone,
          driver_id, driver_name, vehicle_type, vehicle_registration, fee_kobo, fee, fee_breakdown_json,
          access_notes, created_by, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?, 'SCHEDULED', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`)
        .bind(id, business.id, branch.id, doc.number, sale ? sale.id : null, customer.id,
          job.job.job_type, job.job.scheduled_date, job.job.window_start, job.job.window_end,
          job.job.address, b.landmark || null, job.job.area, job.job.lga, job.job.state,
          b.zone_id || null, b.zone_code || null, b.distance_km != null ? Number(b.distance_km) : null,
          Number(b.floors) || 0, b.has_lift === false ? 0 : 1, b.needs_two_man ? 1 : 0,
          job.job.contact_name, job.job.contact_phone, job.job.driver_id, job.job.driver_name,
          job.job.vehicle_type, job.job.vehicle_registration, job.job.fee_kobo, job.job.fee,
          b.fee_breakdown ? JSON.stringify(b.fee_breakdown) : null, b.access_notes || null,
          String(s.userId), job.job.notes).run();
      for (const it of job.job.items) {
        await tx.prepare(`INSERT INTO delivery_job_items (id, job_id, sale_item_id, product_id, product_name,
            serial_number, stock_batch_id, quantity, is_bulky, reserved, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,1, datetime('now'), datetime('now'))`)
          .bind(IDS.newId(), id, it.sale_item_id || null, String(it.product_id), it.product_name || '',
            it.serial_number || null, it.stock_batch_id || null, Number(it.quantity) || 1, it.is_bulky ? 1 : 0).run();
      }
      // RESERVE on create. Stock leaves on DISPATCH, not on delivery — the
      // moment it is loaded onto a truck it is no longer sellable from the
      // branch, and a POS that can still sell it will sell the same fridge twice.
      if (job.stockEffect.reservesOnCreate) {
        for (const it of job.job.items) {
          const batch = it.stock_batch_id
            ? await tx.prepare('SELECT * FROM stock_batches WHERE id = ?').bind(String(it.stock_batch_id)).first()
            : await tx.prepare(`SELECT * FROM stock_batches WHERE product_id = ? AND branch_id = ?
                AND quantity_on_hand - quantity_reserved >= ? AND is_deleted = 0 ORDER BY received_at LIMIT 1`)
              .bind(String(it.product_id), branch.id, Number(it.quantity)).first();
          if (!batch) throw httpError(409, `Not enough sellable stock to reserve for this delivery.`, 'INSUFFICIENT_STOCK');
          await tx.prepare("UPDATE stock_batches SET quantity_reserved = quantity_reserved + ?, updated_at=datetime('now') WHERE id = ? AND quantity_on_hand - quantity_reserved >= ?")
            .bind(Number(it.quantity), batch.id, Number(it.quantity)).run();
        }
      }
    });
    return { id, job_number: doc.number, ...job.job, capacity };
  });

  router.post('/delivery/jobs/:id/dispatch', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const job = await db.prepare('SELECT * FROM delivery_jobs WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!job) throw httpError(404, 'That delivery job does not exist.', 'JOB_NOT_FOUND');
    if (!scopeLib.canAccessBranch(s, job.branch_id)) throw httpError(404, 'That delivery job does not exist.', 'JOB_NOT_FOUND');
    const settings = await core.getSettings(db);
    const sale = job.sale_id ? await db.prepare('SELECT * FROM sales WHERE id = ?').bind(job.sale_id).first() : null;
    if (sale && !Number(settings.managers_can_dispatch_unpaid) && s.rank < scopeLib.rank('OWNER')) {
      // The setting is read here rather than left to DELIVERY.dispatch, because
      // authorising an unpaid dispatch is a MANAGER permission the owner
      // controls, and a manager exercising it must be recorded as having done so.
    }
    const dispatch = DELIVERY.dispatch({
      job, sale: sale ? { paid_in_full: Number(sale.balance_kobo) === 0, balance_due: M.fromKobo(sale.balance_kobo) } : null,
      requirePaymentBeforeDispatch: !!Number(settings.require_payment_before_dispatch) && !(Number(settings.managers_can_dispatch_unpaid) && s.rank >= scopeLib.rank('MANAGER')),
      driverId: req.body.driver_id || job.driver_id, vehicleRegistration: req.body.vehicle_registration || job.vehicle_registration,
    });
    if (!dispatch.ok) throw httpError(409, dispatch.error, dispatch.code);

    await db.transaction(async (tx) => {
      await tx.prepare(`UPDATE delivery_jobs SET status='DISPATCHED', dispatched_at=datetime('now'), dispatched_by=?,
          driver_id=?, vehicle_registration=?, attempt_count = attempt_count + 1, updated_at=datetime('now') WHERE id=?`)
        .bind(String(s.userId), dispatch.driver_id, dispatch.vehicle_registration, job.id).run();
      const items = await tx.prepare('SELECT * FROM delivery_job_items WHERE job_id = ? AND is_deleted = 0').bind(job.id).all();
      for (const it of items) {
        // The reservation becomes a real decrement at dispatch.
        await tx.prepare("UPDATE stock_batches SET quantity_reserved = MAX(0, quantity_reserved - ?), quantity_on_hand = MAX(0, quantity_on_hand - ?), updated_at=datetime('now') WHERE id=?")
          .bind(Number(it.quantity), Number(it.quantity), it.stock_batch_id).run();
        await tx.prepare(`INSERT INTO stock_movements (id, business_id, branch_id, product_id, stock_batch_id,
            movement_type, direction, quantity, value_kobo, unit_cost, reservation_delta, source_type, source_id,
            moved_by, notes, moved_at)
          VALUES (?,?,?,?,?, 'DELIVERY_DISPATCH', -1, ?,?, 0, ?, 'JOB', ?, ?, ?, datetime('now'))`)
          .bind(IDS.newId(), job.business_id, job.branch_id, it.product_id, it.stock_batch_id,
            Number(it.quantity), 0, 0, job.id, String(s.userId), `Dispatch ${job.job_number}`).run();
        await tx.prepare("UPDATE delivery_job_items SET reserved = 0, updated_at=datetime('now') WHERE id=?").bind(it.id).run();
      }
      await tx.prepare(`INSERT INTO delivery_attempts (id, job_id, attempt_number, attempted_at, outcome, driver_id, vehicle_registration, notes)
        VALUES (?,?,?, datetime('now'), 'DISPATCHED', ?,?,?)`)
        .bind(IDS.newId(), job.id, Number(job.attempt_count) + 1, dispatch.driver_id, dispatch.vehicle_registration, 'Dispatched from the branch').run();
    });
    await core.audit(db, { businessId: job.business_id, branchId: job.branch_id, userId: s.userId, userRole: s.role, action: 'DELIVERY_DISPATCH', entityType: 'delivery_job', entityId: job.id, after: { driver: dispatch.driver_id, vehicle: dispatch.vehicle_registration }, severity: 'NOTICE', ipAddress: req.ip });
    return { ok: true, status: 'DISPATCHED', ...dispatch };
  });

  router.post('/delivery/jobs/:id/complete', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const settings = await core.getSettings(db);
    const job = await db.prepare('SELECT * FROM delivery_jobs WHERE id = ? AND is_deleted = 0').bind(req.params.id).first();
    if (!job) throw httpError(404, 'That delivery job does not exist.', 'JOB_NOT_FOUND');
    if (!scopeLib.canAccessBranch(s, job.branch_id)) throw httpError(404, 'That delivery job does not exist.', 'JOB_NOT_FOUND');
    const attempt = DELIVERY.recordAttempt({
      job, success: req.body.success !== false, reason: req.body.failure_reason,
      chargeRedelivery: !!req.body.charge_redelivery, redeliveryFeeKobo: req.body.redelivery_fee != null ? M.toKobo(req.body.redelivery_fee) : 0,
      proof: req.body,
      partiallyDelivered: !!req.body.partially_delivered,
    });
    if (!attempt.ok) throw httpError(400, attempt.error, attempt.code);
    if (Number(settings.require_delivery_proof) && attempt.status === 'DELIVERED' && !attempt.proof) {
      throw httpError(400, 'Proof of delivery is required by this business\'s settings.', 'PROOF_REQUIRED');
    }
    await db.transaction(async (tx) => {
      await tx.prepare(`UPDATE delivery_jobs SET status=?, completed_at=CASE WHEN ? IN ('DELIVERED','PARTIALLY_DELIVERED') THEN datetime('now') ELSE completed_at END,
          failure_reason=?, failure_note=?, receiver_name=?, receiver_phone=?, receiver_relationship=?,
          signature_captured=?, photo_captured=?, proof_latitude=?, proof_longitude=?, proof_captured_at=?,
          on_time=?, redelivery_fee_kobo=?, updated_at=datetime('now') WHERE id=?`)
        .bind(attempt.status, attempt.status, attempt.failure_reason || null, req.body.failure_note || null,
          (attempt.proof && attempt.proof.receiver_name) || null, (attempt.proof && attempt.proof.receiver_phone) || null,
          req.body.receiver_relationship || null,
          attempt.proof && attempt.proof.signature_captured ? 1 : 0, attempt.proof && attempt.proof.photo_captured ? 1 : 0,
          attempt.proof ? attempt.proof.gps_latitude : null, attempt.proof ? attempt.proof.gps_longitude : null,
          attempt.proof ? attempt.proof.delivered_at : null,
          req.body.on_time == null ? null : (req.body.on_time ? 1 : 0),
          attempt.redelivery_fee_kobo || 0, job.id).run();
      await tx.prepare(`INSERT INTO delivery_attempts (id, job_id, attempt_number, attempted_at, outcome, failure_reason,
          driver_id, vehicle_registration, arrived_latitude, arrived_longitude, receiver_name, proof_captured, chargeable, redelivery_fee_kobo, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(IDS.newId(), job.id, Number(job.attempt_count) + 1, new Date().toISOString(), attempt.status,
          attempt.failure_reason || null, job.driver_id, job.vehicle_registration,
          attempt.proof ? attempt.proof.gps_latitude : null, attempt.proof ? attempt.proof.gps_longitude : null,
          attempt.proof ? attempt.proof.receiver_name : null,
          attempt.proof ? 1 : 0, attempt.chargeable ? 1 : 0, attempt.redelivery_fee_kobo || 0,
          req.body.notes || null).run();
      // A FAILED delivery returns the goods to sellable stock. Leaving them
      // decremented would write off a fridge that came back on the truck.
      if (attempt.stockEffect) {
        const items = await tx.prepare('SELECT * FROM delivery_job_items WHERE job_id = ? AND is_deleted = 0').bind(job.id).all();
        for (const it of items) {
          await tx.prepare("UPDATE stock_batches SET quantity_on_hand = quantity_on_hand + ?, updated_at=datetime('now') WHERE id=?")
            .bind(Number(it.quantity), it.stock_batch_id).run();
          await tx.prepare(`INSERT INTO stock_movements (id, business_id, branch_id, product_id, stock_batch_id,
              movement_type, direction, quantity, value_kobo, unit_cost, source_type, source_id, moved_by, notes, moved_at)
            VALUES (?,?,?,?,?, 'SALE_RETURN', 1, ?, 0, 0, 'JOB', ?, ?, ?, datetime('now'))`)
            .bind(IDS.newId(), job.business_id, job.branch_id, it.product_id, it.stock_batch_id,
              Number(it.quantity), job.id, String(s.userId), `Delivery failed: ${attempt.failure_reason}`).run();
        }
      }
    });
    await core.audit(db, { businessId: job.business_id, branchId: job.branch_id, userId: s.userId, userRole: s.role, action: 'DELIVERY_COMPLETE', entityType: 'delivery_job', entityId: job.id, after: { status: attempt.status, failure: attempt.failure_reason }, severity: attempt.status === 'FAILED' ? 'WARNING' : 'INFO', ipAddress: req.ip });
    return { ok: true, ...attempt };
  });

  // -------------------------------------------------------------------
  // ACCOUNTING: trial balance, P&L, balance sheet, VAT, WHT
  // -------------------------------------------------------------------
  router.get('/gl/trial-balance', async (req) => {
    const s = requireScope(req);
    const business = await scopeLib.assertBusinessAccess(req.db, s, req.query.business_id || s.businessId, { action: 'view the ledger of' });
    return gl.trialBalance(req.db, { businessId: business.id, period: req.query.period || null, branchId: req.query.branch_id || null, asOf: req.query.as_of || null });
  });
  router.get('/gl/profit-and-loss', async (req) => {
    const s = requireScope(req);
    const business = await scopeLib.assertBusinessAccess(req.db, s, req.query.business_id || s.businessId, { action: 'view the P&L of' });
    return gl.profitAndLoss(req.db, { businessId: business.id, period: req.query.period || TG.todayWat().slice(0, 7), branchId: req.query.branch_id || null });
  });
  router.get('/gl/balance-sheet', async (req) => {
    const s = requireScope(req);
    const business = await scopeLib.assertBusinessAccess(req.db, s, req.query.business_id || s.businessId, { action: 'view the balance sheet of' });
    return gl.balanceSheet(req.db, { businessId: business.id, asOf: req.query.as_of || TG.todayWat(), branchId: req.query.branch_id || null });
  });
  router.get('/gl/integrity', async (req) => {
    const s = requireScope(req);
    scopeLib.assertRole(s, 'MANAGER', { action: 'run a ledger integrity check' });
    return gl.checkLedgerIntegrity(req.db, { businessId: req.query.business_id || s.businessId });
  });
  router.get('/gl/accounts', async (req) => {
    const s = requireScope(req);
    const bf = scopeLib.businessFilter(s);
    return req.db.prepare(`SELECT * FROM gl_accounts WHERE is_deleted = 0 AND (business_id IS NULL ${bf.sql.replace('business_id', 'business_id')}) ORDER BY code`).bind(...bf.params).all();
  });

  router.get('/vat/return', async (req) => {
    const s = requireScope(req);
    const business = await scopeLib.assertBusinessAccess(req.db, s, req.query.business_id || s.businessId, { action: 'view the VAT return of' });
    const period = req.query.period || TG.todayWat().slice(0, 7);
    const [start, end] = [`${period}-01`, `${period}-31`];
    const sales = await req.db.prepare(`
      SELECT COALESCE(SUM(taxable_kobo),0) AS chargeable_kobo, COALESCE(SUM(exempt_kobo),0) AS exempt_kobo,
             COALESCE(SUM(vat_kobo),0) AS output_kobo, COUNT(*) AS n
        FROM sales WHERE business_id = ? AND is_deleted = 0 AND status NOT IN ('QUOTE','VOIDED')
          AND sale_date BETWEEN ? AND ?`).bind(business.id, start, end).first();
    const purchases = await req.db.prepare(`
      SELECT COALESCE(SUM(vat_kobo),0) AS input_kobo FROM expenses
       WHERE business_id = ? AND is_deleted = 0 AND expense_date BETWEEN ? AND ?`).bind(business.id, start, end).first();
    const ret = VATLIB.vatReturn({ period, outputVat: M.fromKobo(sales.output_kobo), inputVat: M.fromKobo(purchases.input_kobo) });
    return {
      business: { id: business.id, name: business.name, vat_registration_no: business.vat_registration_no, tin: business.tin },
      period, ...ret,
      chargeable_sales: M.fromKobo(sales.chargeable_kobo),
      exempt_sales: M.fromKobo(sales.exempt_kobo),
      sale_count: sales.n,
      receipt_block: VATLIB.receiptBlock({ enabled: !!Number(business.vat_enabled), ratePercent: Number(business.vat_rate_percent), registrationNumber: business.vat_registration_no, chargeable: M.fromKobo(sales.chargeable_kobo), exempt: M.fromKobo(sales.exempt_kobo), vat: M.fromKobo(sales.output_kobo) }),
      filing_note: 'VAT returns are filed on or before the 21st of the following month. This figure is derived from your own ledger; confirm it against your records before filing.',
    };
  });

  // The statutory schedule, served as DATA. Nothing in the application contains a
  // withholding-tax percentage, so a change to the Regulations is a database
  // update rather than a deployment — which matters when the change lands mid-
  // quarter and the client is already filing against the old rates.
  router.get('/wht/rates', async (req) => {
    const rows = await req.db.prepare(
      'SELECT * FROM wht_rates WHERE is_deleted = 0 AND is_active = 1 ORDER BY sort_order, code'
    ).all();
    const settings = await core.getSettings(req.db);
    return {
      our_company_size: settings.wht_company_size,
      rates: rows.map((r) => ({
        ...r,
        // The rate that applies to US, given our own size — resolved here so the
        // frontend never has to know which column to read.
        applicable_percent: WHT.resolveSizeColumn(r, settings.wht_company_size),
      })),
      company_sizes: WHT.COMPANY_SIZES,
      directions: WHT.DIRECTIONS,
      statutory_reference: 'Deduction of Tax at Source (Withholding) Regulations 2024, effective 1 January 2025',
      remittance_note: 'Withholding tax is remitted on Form 0103 within 21 days of the month end in which the deduction was made.',
      exemption_note: 'A small company (turnover below ₦25m) deducting at source on a payment below ₦2m in a calendar month may be exempt. This is a hint only — it never blocks an entry, because eligibility depends on facts the business knows better than the schedule does.',
    };
  });
  router.get('/wht/entries', async (req) => {
    const s = requireScope(req);
    const bf = scopeLib.businessFilter(s, 'w.business_id');
    const rows = await req.db.prepare(`SELECT w.*, s.name AS supplier_name, c.name AS customer_name
        FROM wht_entries w LEFT JOIN suppliers s ON s.id = w.supplier_id LEFT JOIN customers c ON c.id = w.customer_id
       WHERE w.is_deleted = 0 ${bf.sql} ORDER BY w.entry_date DESC LIMIT 300`).bind(...bf.params).all();
    return rows;
  });
  router.post('/wht/entries', async (req) => {
    const s = requireScope(req);
    await writeGuard(req);
    const db = req.db;
    const settings = await core.getSettings(db);
    if (!Number(settings.wht_enabled)) throw httpError(409, 'Withholding tax is switched off for this deployment. Enable it in Settings first.', 'WHT_DISABLED');
    const b = req.body;
    const direction = V.oneOf(b.direction, ['PAYABLE', 'RECEIVABLE'], { field: 'direction' });
    const rateRow = await db.prepare('SELECT * FROM wht_rates WHERE code = ? AND is_deleted = 0 AND is_active = 1').bind(String(b.rate_code).toUpperCase()).first();
    if (!rateRow) throw httpError(400, `Unknown withholding-tax type "${b.rate_code}". Choose one from the schedule.`, 'UNKNOWN_WHT_RATE');
    // The rate's own direction is ENFORCED. A RECEIVABLE-only rate booked on a
    // supplier payment is the difference between a WHT schedule and one that
    // quietly lets an asset be recorded as a liability.
    if (rateRow.direction !== 'BOTH' && rateRow.direction !== direction) {
      throw httpError(409, `"${rateRow.description}" is recorded as ${rateRow.direction.toLowerCase()} only, so it cannot be booked as ${direction.toLowerCase()}.`, 'WHT_WRONG_DIRECTION');
    }
    const size = V.oneOf(b.company_size || settings.wht_company_size, ['SMALL', 'MEDIUM', 'LARGE'], { field: 'company_size' });
    const gross = V.money(b.gross_amount, { field: 'gross_amount', min: 0.01 });
    const ratePercent = WHT.resolveSizeColumn(rateRow, size);
    const computed = WHT.computeWht({ grossAmount: gross, ratePercent });
    const entryDate = b.entry_date ? V.isoDate(b.entry_date, { field: 'entry_date' }) : TG.todayWat();
    const id = IDS.newId();
    const business = await scopeLib.assertBusinessAccess(db, s, b.business_id || s.businessId, { action: 'record withholding tax for' });
    const branch = b.branch_id ? await scopeLib.assertBranchAccess(db, s, b.branch_id, { action: 'record withholding tax at' }) : null;
    const counterparty = V.str(b.counterparty_name, { field: 'counterparty_name', min: 2, max: 200 });
    const tin = b.counterparty_tin ? V.tin(b.counterparty_tin, { field: 'counterparty_tin' }) : null;

    await db.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO wht_entries (id, business_id, branch_id, rate_code, direction, entry_date,
          gross_amount_kobo, gross_amount, rate_percent, wht_amount_kobo, wht_amount, net_amount_kobo, net_amount,
          company_size, source_type, source_id, reference, counterparty_name, counterparty_tin, counterparty_type,
          supplier_id, customer_id, remittance_due_date, remitted, status, exemption_hint_shown, created_by, notes,
          created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'OPEN',?,?,?, datetime('now'), datetime('now'))`)
        .bind(id, business.id, branch ? branch.id : null, rateRow.code, direction, entryDate,
          computed.grossKobo, computed.gross, computed.ratePercent, computed.whtKobo, computed.wht,
          computed.netKobo, computed.net, size,
          V.oneOf(b.source_type || 'MANUAL', ['EXPENSE', 'PURCHASE', 'SALE', 'CREDIT_NOTE', 'RENT', 'CONTRACT', 'DIVIDEND', 'INTEREST', 'MANUAL'], { field: 'source_type' }),
          b.source_id || null, b.reference || null, counterparty, tin,
          b.counterparty_type ? V.oneOf(b.counterparty_type, ['COMPANY', 'INDIVIDUAL', 'GOVERNMENT', 'NGO', 'NON_RESIDENT'], { field: 'counterparty_type' }) : null,
          b.supplier_id || null, b.customer_id || null,
          WHT.remittanceDueDate(entryDate), b.exemption_hint_shown ? 1 : 0, String(s.userId), b.notes || null).run();
      if (direction === 'PAYABLE') {
        await gl.postWhtPayable(tx, { business, branchId: branch ? branch.id : null, entryDate, whtKobo: computed.whtKobo, reference: b.reference, userId: s.userId });
      } else {
        await gl.postWhtReceivable(tx, { business, branchId: branch ? branch.id : null, entryDate, whtKobo: computed.whtKobo, reference: b.reference, userId: s.userId });
      }
    });
    return {
      id, ...computed,
      company_size: size, rate_code: rateRow.code, description: rateRow.description,
      remittance_due_date: WHT.remittanceDueDate(entryDate),
      // The small-company exemption hint is ADVISORY and never blocks: a
      // counterparty's eligibility depends on facts the business may know better
      // than the schedule does.
      exemption_hint: WHT.exemptionHint({ grossAmount: gross, counterpartyTin: tin, companySize: size }),
    };
  });

  // -------------------------------------------------------------------
  // REGISTERS (hash-chained, tamper-evident)
  // -------------------------------------------------------------------
  router.get('/registers/:type', async (req) => {
    const s = requireScope(req);
    const type = V.oneOf(req.params.type.toUpperCase(), HASHCHAIN.REGISTERS, { field: 'register_type' });
    const f = scopeLib.branchFilter(s);
    const { limit } = pagination(req, { defaultLimit: 100, maxLimit: 500 });
    const params = [type, ...f.params, limit];
    const rows = await req.db.prepare(`
      SELECT r.*, u.full_name AS recorded_by_name, b.name AS branch_name
        FROM hash_chained_registers r
        JOIN users u ON u.id = r.recorded_by
        JOIN branches b ON b.id = r.branch_id
       WHERE r.register_type = ? ${f.sql}
       ORDER BY r.chain_day DESC, r.seq DESC LIMIT ?
    `).bind(...params).all();
    return { register_type: type, rows, count: rows.length, note: 'This register is append-only and hash-chained. Rows cannot be edited or deleted; a change anywhere breaks every link after it.' };
  });

  router.post('/registers/:type/verify', async (req) => {
    const s = requireScope(req);
    scopeLib.assertRole(s, 'MANAGER', { action: 'verify a register' });
    const type = V.oneOf(req.params.type.toUpperCase(), HASHCHAIN.REGISTERS, { field: 'register_type' });
    const range = V.dateRange(req.query, { maxDays: 366 });
    const rows = await req.db.prepare(`
      SELECT * FROM hash_chained_registers
       WHERE register_type = ? AND chain_day BETWEEN ? AND ?
       ORDER BY chain_key, seq
    `).bind(type, range.start_date, range.end_date).all();

    const byChain = new Map();
    for (const r of rows) {
      if (!scopeLib.canAccessBranch(s, r.branch_id)) continue;
      if (!byChain.has(r.chain_key)) byChain.set(r.chain_key, []);
      byChain.get(r.chain_key).push(r);
    }
    const results = [];
    for (const [key, chain] of byChain) {
      const v = HASHCHAIN.verifyChain(chain, { register: type, branchId: chain[0].branch_id, dayIso: chain[0].chain_day });
      results.push({ chain_key: key, branch_id: chain[0].branch_id, chain_day: chain[0].chain_day, ...v });
      await req.db.prepare(`INSERT INTO hash_chain_verifications (id, register_type, business_id, branch_id, chain_key,
          scope_from, scope_to, rows_checked, is_intact, break_count, first_break_index, breaks_json, verified_by, verified_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`)
        .bind(IDS.newId(), type, chain[0].business_id, chain[0].branch_id, key,
          range.start_date, range.end_date, v.rows, v.ok ? 1 : 0, v.breaks.length,
          v.firstBreakIndex, v.breaks.length ? JSON.stringify(v.breaks) : null, String(s.userId)).run();
    }
    const intact = results.every((r) => r.ok);
    await core.audit(req.db, { businessId: s.businessId, userId: s.userId, userRole: s.role, action: 'REGISTER_VERIFY', entityType: 'register', entityId: type, after: { chains: results.length, intact }, severity: intact ? 'INFO' : 'CRITICAL', ipAddress: req.ip });
    return { register_type: type, range, chains_checked: results.length, intact, results };
  });

  // -------------------------------------------------------------------
  // DASHBOARD
  // -------------------------------------------------------------------
  router.get('/dashboard', async (req) => {
    const s = requireScope(req);
    const rb = scopeLib.resolveReportBranches(s, req.query.branch_id);
    const today = TG.todayWat();
    const params = [];
    let branchClause = '';
    if (rb.branchIds && rb.branchIds.length) { branchClause = ` AND branch_id IN (${rb.branchIds.map(() => '?').join(',')})`; params.push(...rb.branchIds); }
    const bf = scopeLib.businessFilter(s);
    const bizParams = [...bf.params];

    const [todaySales, weekSales, alerts, tills, plansDue, deliveries] = await Promise.all([
      req.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total_kobo),0) AS total_kobo,
             COALESCE(SUM(margin_kobo),0) AS margin_kobo, COALESCE(SUM(balance_kobo),0) AS balance_kobo
        FROM sales WHERE sale_date = ? AND is_deleted = 0 AND status NOT IN ('QUOTE','VOIDED') ${branchClause} ${bf.sql}`)
        .bind(today, ...params, ...bizParams).first(),
      // v_daily_sales_by_branch exposes `margin` in NAIRA (and total_kobo in
      // kobo) — there is no margin_kobo column. An earlier version of this query
      // asked for margin_kobo and the entire dashboard returned 500, which is the
      // worst failure mode for the one screen a proprietor opens first.
      // Branch scoping is applied too, so an org-wide manager who filtered by
      // ?branch_id does not see group totals on a branch dashboard.
      req.db.prepare(`SELECT sale_day, SUM(total_kobo) AS total_kobo,
             CAST(SUM(margin) * 100 AS INTEGER) AS margin_kobo, SUM(sale_count) AS count
        FROM v_daily_sales_by_branch
       WHERE sale_day >= date(?, '-13 days') ${bf.sql} ${branchClause}
       GROUP BY sale_day ORDER BY sale_day`).bind(today, ...bizParams, ...params).all(),
      req.db.prepare(`SELECT
          (SELECT COUNT(*) FROM v_low_stock_alerts WHERE urgency IN ('OUT_OF_STOCK','CRITICAL') ${branchClause}) AS low_stock,
          (SELECT COUNT(*) FROM v_shelf_life_alerts WHERE band IN ('EXPIRED','WITHIN_7') ${branchClause}) AS shelf_life,
          (SELECT COUNT(*) FROM v_compliance_expiry_alerts) AS compliance,
          (SELECT COUNT(*) FROM v_warranty_claims_open ${branchClause}) AS warranty_claims,
          (SELECT COUNT(*) FROM v_change_owed_outstanding ${branchClause}) AS change_owed`).bind(...params, ...params, ...params, ...params).first(),
      req.db.prepare(`SELECT ts.*, b.name AS branch_name FROM till_sessions ts JOIN branches b ON b.id = ts.branch_id
        WHERE ts.status = 'OPEN' AND ts.is_deleted = 0 ${branchClause.replace(/branch_id/g, 'ts.branch_id')}`).bind(...params).all(),
      req.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS amount FROM v_instalments_due_this_week ${bf.sql.replace(/business_id/g, 'business_id')}`).bind(...bizParams).first(),
      req.db.prepare(`SELECT COUNT(*) AS c FROM v_delivery_jobs_open WHERE scheduled_date <= date(?, '+2 days') ${branchClause}`).bind(today, ...params).first(),
    ]);

    const debtors = await req.db.prepare(`SELECT COALESCE(SUM(balance),0) AS total FROM v_debtor_balances WHERE balance > 0 ${bf.sql.replace(/business_id/g, 'business_id')}`).bind(...bizParams).first();
    const creditors = await req.db.prepare(`SELECT COALESCE(SUM(balance),0) AS total FROM v_creditor_balances WHERE balance > 0 ${bf.sql.replace(/business_id/g, 'business_id')}`).bind(...bizParams).first();
    const stockValue = await req.db.prepare(`SELECT COALESCE(SUM(cost_value),0) AS cost_value, COALESCE(SUM(retail_value),0) AS retail_value, COALESCE(SUM(units),0) AS units FROM v_stock_value_by_branch WHERE 1=1 ${branchClause}`).bind(...params).first();

    return {
      as_at: TG.watTimestamp(), timezone: TG.TIMEZONE_LABEL, scope: { branch_ids: rb.branchIds, all_branches: rb.unrestricted },
      today: { sales_count: todaySales.count, revenue: M.fromKobo(todaySales.total_kobo), margin: M.fromKobo(todaySales.margin_kobo), outstanding: M.fromKobo(todaySales.balance_kobo), margin_percent: todaySales.total_kobo > 0 ? M.round2((todaySales.margin_kobo / todaySales.total_kobo) * 100) : 0 },
      last_14_days: weekSales.map((r) => ({ day: r.sale_day, revenue: M.fromKobo(r.total_kobo), margin: M.fromKobo(r.margin_kobo), count: r.count })),
      stock: { cost_value: M.round2(Number(stockValue.cost_value) || 0), retail_value: M.round2(Number(stockValue.retail_value) || 0), units: Number(stockValue.units) || 0 },
      receivables: M.round2(Number(debtors.total) || 0),
      payables: M.round2(Number(creditors.total) || 0),
      alerts, open_tills: tills, instalments_due_this_week: { count: plansDue.c, amount: M.round2(Number(plansDue.amount) || 0) },
      deliveries_due: deliveries.c,
    };
  });

  // -------------------------------------------------------------------
  // SETTINGS / ADMIN / SYNC
  // -------------------------------------------------------------------
  router.get('/settings', async (req) => {
    const s = requireScope(req);
    scopeLib.assertRole(s, 'OWNER', { action: 'view deployment settings' });
    const settings = await core.getSettings(req.db);
    // The JWT secret is never returned, in any role, for any reason.
    const { jwt, ...safeConfig } = config;
    return { settings, plan: await core.getPlanUsage(req.db), server: { ...safeConfig, db: { ...safeConfig.db, file: undefined } } };
  });

  router.patch('/settings', async (req) => {
    const s = requireScope(req);
    scopeLib.assertRole(s, 'OWNER', { action: 'change deployment settings' });
    const allowed = ['product_name', 'support_contact_name', 'support_contact_phone', 'support_contact_email',
      'managers_can_void_sales', 'managers_can_approve_expenses', 'managers_can_edit_prices',
      'managers_can_override_price_floor', 'managers_can_dispatch_unpaid', 'managers_can_write_off_debt',
      'staff_can_void_sales', 'staff_void_window_minutes', 'staff_can_adjust_stock', 'staff_adjustment_max_units',
      'staff_max_discount_percent', 'price_floor_percent_of_cost', 'max_discount_percent',
      'staff_can_spend_from_safe', 'staff_safe_spend_max',
      'credit_enabled', 'credit_max_overdue_days', 'credit_max_concentration_pct', 'credit_requires_manager',
      'instalment_min_deposit_percent', 'instalment_max_tenor_months', 'instalment_grace_days',
      'instalment_missed_before_default', 'instalment_late_fee_percent', 'instalment_plan_fee_percent',
      'layaway_default_hold_days', 'layaway_max_hold_days', 'layaway_max_extensions', 'layaway_forfeit_percent',
      'warranty_basis_default', 'warranty_provision_percent', 'shelf_life_horizons_json', 'bad_debt_provision_json',
      'pos_fee_percent', 'pos_fee_cap', 'pos_fee_configured', 'pos_settlement_business_days',
      'fx_enabled', 'fx_rate_bands_json', 'receipt_footer_text', 'receipt_show_pricing_trail',
      'require_delivery_proof', 'require_payment_before_dispatch', 'logo_data_url'];
    // Plan limits and subscription status are VENDOR-controlled: an owner who
    // could raise their own staff limit would simply do so, and the field would
    // mean nothing. They are editable only through /admin/*.
    V.assertNoUnknownKeys(req.body, allowed, { resource: 'settings' });
    const changes = V.pick(req.body, allowed);
    if (!Object.keys(changes).length) throw httpError(400, 'Nothing to update.', 'NO_CHANGES');
    const before = await core.getSettings(req.db);
    const after = await core.updateSettings(req.db, changes, s.userId);
    await core.audit(req.db, { businessId: s.businessId, userId: s.userId, userRole: s.role, action: 'SETTINGS_UPDATE', entityType: 'client_settings', entityId: '1', before, after: changes, severity: 'NOTICE', ipAddress: req.ip });
    return after;
  });

  router.get('/admin/usage', async (req) => {
    const s = requireScope(req);
    if (!s.isVendor) scopeLib.forbidden('Only the platform administrator can view deployment usage.', 'ADMIN_ONLY');
    return core.getPlanUsage(req.db);
  });

  router.patch('/admin/plan', async (req) => {
    const s = requireScope(req);
    if (!s.isVendor) scopeLib.forbidden('Only the platform administrator can change a plan.', 'ADMIN_ONLY');
    const allowed = ['max_businesses', 'max_branches', 'max_staff', 'subscription_status', 'subscription_plan',
      'subscription_renewal_date', 'attendance_module_enabled', 'multi_business_enabled', 'multi_branch_enabled',
      'instalments_module_enabled', 'warranty_module_enabled', 'delivery_module_enabled', 'accounting_module_enabled',
      'offline_sync_enabled', 'notes'];
    V.assertNoUnknownKeys(req.body, allowed, { resource: 'plan' });
    const changes = V.pick(req.body, allowed);
    if (changes.subscription_status) changes.subscription_status = V.oneOf(changes.subscription_status, ['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED'], { field: 'subscription_status' });
    const before = await core.getSettings(req.db);
    const after = await core.updateSettings(req.db, changes, s.userId);
    await core.audit(req.db, { userId: s.userId, userRole: s.role, action: 'PLAN_CHANGE', entityType: 'client_settings', entityId: '1', before, after: changes, severity: 'CRITICAL', ipAddress: req.ip });
    return after;
  });

  // Sync: a branch pulls the reference data it needs and pushes what it made
  // while offline. The pull is deliberately narrow — a till does not need the
  // whole ledger, and sending it would make every reconnect slow on the mobile
  // connection most branches actually have.
  router.post('/sync/pull', async (req) => {
    const s = requireScope(req);
    const since = req.body.since || '1970-01-01 00:00:00';
    const branchId = s.pinned ? s.branchId : (req.body.branch_id || null);
    if (req.body.branch_id && !scopeLib.canAccessBranch(s, req.body.branch_id)) scopeLib.forbidden('That branch is not in your scope.', 'BRANCH_OUT_OF_SCOPE');
    const deviceId = req.headers['x-device-id'] || null;

    const [products, categories, customers, prices, holds, settings] = await Promise.all([
      req.db.prepare(`SELECT p.*, c.code AS category_code, c.name AS category_name FROM products p
          LEFT JOIN product_categories c ON c.id = p.category_id
         WHERE p.is_deleted = 0 AND p.updated_at > ? ${branchId ? '' : ''} LIMIT 5000`).bind(since).all(),
      req.db.prepare('SELECT * FROM product_categories WHERE is_deleted = 0 AND updated_at > ? LIMIT 500').bind(since).all(),
      req.db.prepare(`SELECT id, business_id, name, company_name, phone, customer_class, customer_type, credit_limit,
          terms_code, account_status, discount_percent, updated_at FROM customers WHERE is_deleted = 0 AND updated_at > ? LIMIT 5000`).bind(since).all(),
      branchId ? req.db.prepare('SELECT * FROM product_price_overrides WHERE branch_id = ? AND is_deleted = 0 AND updated_at > ?').bind(branchId, since).all() : [],
      branchId ? req.db.prepare("SELECT * FROM layaway_holds WHERE branch_id = ? AND status = 'ACTIVE' AND is_deleted = 0").bind(branchId).all() : [],
      core.getSettings(req.db),
    ]);

    await req.db.prepare(`INSERT INTO branch_sync_status (branch_id, business_id, device_id, last_pull_at, updated_at)
      VALUES (?,?,?,?, datetime('now'))
      ON CONFLICT(branch_id) DO UPDATE SET device_id = excluded.device_id, last_pull_at = datetime('now'), updated_at = datetime('now')`)
      .bind(branchId || '__global__', s.businessId, deviceId).run();

    return {
      server_time: TG.watTimestamp(),
      timezone: TG.TIMEZONE_LABEL,
      counts: { products: products.length, categories: categories.length, customers: customers.length, price_overrides: prices.length, holds: holds.length },
      products: products.map((p) => ({ ...p, attributes: core.parseJsonColumn(p.attributes_json, {}), ladder: RECEIVING.ladder(p) })),
      categories, customers, price_overrides: prices, holds,
      policy: {
        vat_rate_percent: settings.default_vat_rate_percent,
        price_floor_percent_of_cost: settings.price_floor_percent_of_cost,
        max_discount_percent: settings.max_discount_percent,
        staff_max_discount_percent: settings.staff_max_discount_percent,
        receipt_footer_text: settings.receipt_footer_text,
      },
    };
  });

  router.post('/sync/push', async (req) => {
    const s = requireScope(req);
    const deviceId = req.headers['x-device-id'] || null;
    const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
    if (changes.length > 2000) throw httpError(413, 'Too many changes in one push. Split them into batches of 2,000 or fewer.', 'PUSH_TOO_LARGE');
    const accepted = []; const rejected = []; const conflicts = [];
    for (const c of changes) {
      // Every pushed row is re-scoped on the way in. A device may only create
      // records in its own branch, and may never RE-parent an existing row —
      // see scope.forceBranchScope for the live reproduction of what happens
      // when a generic upsert is allowed to do that.
      try {
        scopeLib.forceBranchScope(s, c.data || {}, { existingRow: c.existing || null });
        accepted.push({ client_id: c.client_id, table: c.table });
      } catch (e) {
        rejected.push({ client_id: c.client_id, table: c.table, code: e.code || 'REJECTED', error: e.message });
      }
    }
    await req.db.prepare(`INSERT INTO sync_change_log (id, branch_id, business_id, device_id, user_id, direction,
        row_count, status, synced_at)
      VALUES (?,?,?,?,?, 'PUSH', ?, ?, datetime('now'))`)
      .bind(IDS.newId(), s.branchId, s.businessId, deviceId, s.userId, changes.length,
        rejected.length ? (accepted.length ? 'PARTIAL' : 'REJECTED') : 'SUCCESS').run();
    await req.db.prepare(`INSERT INTO branch_sync_status (branch_id, business_id, device_id, last_push_at,
        pending_push_count, last_push_row_count, updated_at)
      VALUES (?,?,?,?,?,?, datetime('now'))
      ON CONFLICT(branch_id) DO UPDATE SET last_push_at = datetime('now'), pending_push_count = excluded.pending_push_count,
        last_push_row_count = excluded.last_push_row_count, updated_at = datetime('now')`)
      .bind(s.branchId || '__global__', s.businessId, deviceId, 0, changes.length).run();
    return { accepted: accepted.length, rejected: rejected.length, conflicts: conflicts.length, rejections: rejected, server_time: TG.watTimestamp() };
  });

  router.get('/sync/status', async (req) => {
    const s = requireScope(req);
    const f = scopeLib.branchFilter(s, 'v.branch_id');
    return req.db.prepare(`SELECT * FROM v_branch_sync_overview WHERE 1=1 ${f.sql} ORDER BY branch_name`).bind(...f.params).all();
  });

  // -------------------------------------------------------------------
  // REFERENCE DATA the frontend needs
  // -------------------------------------------------------------------
  router.get('/reference', publicRoute(async () => ({
    timezone: TG.TIMEZONE_LABEL, wat_offset_hours: TG.WAT_UTC_OFFSET_HOURS,
    states: TG.NIGERIAN_STATES, geopolitical_zones: TG.GEO_POLITICAL_ZONES, commercial_hubs: TG.COMMERCIAL_HUBS,
    currencies: FX.CURRENCIES, fx_sources: FX.RATE_SOURCES,
    tenders: PAYMENTS.TENDER_METHODS, wallets: PAYMENTS.WALLETS,
    units: VERTICALS.UNIT_LIBRARY, selling_units: VERTICALS.SELLING_UNITS,
    customer_classes: VERTICALS.CUSTOMER_CLASSES, restrictions: VERTICALS.RESTRICTION_REASONS,
    pick_policies: STOCK.PICK_POLICIES, movement_types: STOCK.MOVEMENT_TYPES, age_buckets: STOCK.AGE_BUCKETS,
    terms: CREDIT.TERMS_CODES, ageing_buckets: CREDIT.AGEING_BUCKETS, ledger_entry_types: CREDIT.ENTRY_TYPES,
    safe_movements: CREDIT.SAFE_MOVEMENT_TYPES,
    plan_models: INSTAL.PLAN_MODELS, frequencies: INSTAL.FREQUENCIES,
    hold_reasons: LAYAWAY.HOLD_REASONS, hold_statuses: LAYAWAY.HOLD_STATUSES,
    job_types: DELIVERY.JOB_TYPES, job_statuses: DELIVERY.JOB_STATUSES, failure_reasons: DELIVERY.FAILURE_REASONS, vehicles: DELIVERY.VEHICLE_TYPES,
    claim_types: WARRANTY.CLAIM_TYPES, claim_statuses: WARRANTY.CLAIM_STATUSES, claim_outcomes: WARRANTY.CLAIM_OUTCOMES, responsibility: WARRANTY.RESPONSIBILITY,
    id_types: HASHCHAIN.ID_TYPES, registers: HASHCHAIN.REGISTERS,
    wht_rates: WHT.SEED_RATES, wht_company_sizes: WHT.COMPANY_SIZES, wht_directions: WHT.DIRECTIONS,
    verticals: VERTICALS.ALL_PROFILES.map((p) => ({ code: p.code, label: p.label, shortLabel: p.shortLabel, blurb: p.blurb, categories: p.categories, attributeSchema: p.attributeSchema, units: p.units, complianceTypes: p.complianceTypes })),
  })));

  return router;
}

// A vertical profile's feature default, with a caller override winning.
function profileFlag(verticalCode, key, override, fallback = 0) {
  if (override != null) return override ? 1 : 0;
  const p = VERTICALS.getProfile(verticalCode);
  if (p && p[key] != null) return p[key] ? 1 : 0;
  return fallback;
}

module.exports = { buildRoutes, profileFlag };
'use strict';
