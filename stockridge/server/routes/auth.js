// =====================================================================
// StockRidge — AUTH, BRANDING & BUSINESS-UNIT ROUTES
// =====================================================================

const { createRouter, HttpError } = require('../lib/http');
const authService = require('../lib/auth');
const throttle = require('../lib/loginThrottle');
const { publicBranding, internalBranding, assertValidLogoDataUrl, decodeLogo } = require('../lib/branding');
const { writeAudit } = require('../lib/audit');
const { PROFILES, profileSummary, requireProfile } = require('../../shared/industryProfiles');
const V = require('../../shared/validation');
const { hashPin, watNowIso } = require('../../shared/ids');
const { planSummary, getUnitSettings } = require('../lib/planLimits');
const { assertRole } = require('../lib/roles');
const productService = require('../services/productService');
const expenseService = require('../services/expenseService');
const glService = require('../services/glService');
const whtLib = require('../lib/wht');
const { newId } = require('../../shared/ids');

// ---------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------
function authRoutes(getDb) {
  const app = createRouter();

  // Business codes are PUBLIC: the login screen needs the list to let a user
  // pick their business before they can authenticate. Only the code and the
  // display name are exposed — no address, no contact, no plan.
  app.get('/business-codes', async (c) => {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT code, name, industry_profile FROM business_units
      WHERE is_deleted = 0 AND is_active = 1 ORDER BY name
    `).all();
    return c.json({
      business_units: rows.results,
      // With one unit the code field is hidden entirely — asking a sole
      // trader to type a business code is friction with no security benefit.
      requires_business_code: rows.results.length > 1,
    });
  });

  app.post('/login', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const deviceId = c.req.header('X-Device-Id') || body.device_id || null;
    try {
      const result = await authService.login(db, {
        rawUsername: body.username,
        pin: body.pin,
        businessUnitCode: body.business_code || null,
        deviceId,
        ipAddress: c.req.ip,
        userAgent: c.req.userAgent,
        recordAttempt: {
          assertLoginAllowed: (d, u, bu) => throttle.assertLoginAllowed(d, u, bu),
          recordLoginAttempt: (d, args) => throttle.recordLoginAttempt(d, { ...args, businessUnitId: result_unit(db, body.business_code) }),
        },
      });
      // Record which unit the session belongs to for the throttle's audit
      // scope, and note the device if this branch uses REGISTERED_DEVICE.
      await writeAudit(db, {
        businessUnitId: result.business_unit_id, branchId: result.user.branch_id || null,
        userId: result.user.id, actorRole: result.user.role, action: 'LOGIN',
        entityType: 'USER', entityId: result.user.id,
        ipAddress: c.req.ip, userAgent: c.req.userAgent, deviceId,
      });
      return c.json({
        token: result.token,
        expires_at: result.expires_at,
        user: result.user,
        business_unit_id: result.business_unit_id,
        must_change_pin: result.must_change_pin,
        branding: publicBranding(await db.prepare('SELECT * FROM business_units WHERE id = ?').bind(result.business_unit_id).first()),
      });
    } catch (e) {
      if (e && e.code === 'TOO_MANY_LOGIN_ATTEMPTS') {
        return c.json({ error: e.message, code: e.code, retry_after_seconds: e.retryAfterSeconds }, 429);
      }
      throw e;
    }
  });

  app.post('/logout', async (c) => {
    const db = getDb();
    const token = require('../lib/middleware').bearerToken(c);
    if (token) await authService.revokeSession(db, token, 'USER_SIGNOUT');
    return c.json({ ok: true });
  });

  // "Sign out everywhere." The response to a lost phone, a shared laptop that
  // changed hands, or a dismissed employee.
  app.post('/logout-all', async (c) => {
    const db = getDb();
    const n = await authService.revokeAllSessions(db, c.var.user.id, 'USER_REQUESTED_ALL_DEVICES');
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'LOGOUT_ALL_DEVICES', entityType: 'USER', entityId: c.var.user.id,
      after: { sessions_revoked: n }, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, sessions_revoked: n, note: 'This device is signed out too. Sign in again.' });
  });

  app.get('/me', async (c) => {
    const db = getDb();
    const user = c.var.user;
    const branch = user.branch_id ? await db.prepare('SELECT id, name, code, branch_type, address, phone FROM branches WHERE id = ?').bind(user.branch_id).first() : null;
    const unit = await db.prepare('SELECT id, code, name, industry_profile, legal_name, currency FROM business_units WHERE id = ?').bind(c.var.businessUnitId).first();
    const allowance = await require('../lib/planLimits').staffAllowance(db, c.var.businessUnitId, user);
    return c.json({
      user: authService.publicUser(user),
      branch,
      business_unit: unit,
      accessible_business_units: c.var.accessibleUnitIds,
      profile: unit ? profileSummary(requireProfile(unit.industry_profile)) : null,
      allowances: allowance,
      session: { expires_at: c.var.session.expires_at, device_id: c.var.deviceId },
    });
  });

  app.post('/change-pin', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    await authService.changePin(db, {
      userId: c.var.user.id, currentPin: body.current_pin, newPin: body.new_pin, actor: c.var.user,
    });
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'PIN_CHANGED_SELF', entityType: 'USER', entityId: c.var.user.id,
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, note: 'Your PIN has been changed. Every device has been signed out for security — sign in again with the new PIN.' });
  });

  // Lock state, so a manager can see which accounts are locked rather than
  // waiting for a phone call from a cashier who cannot sign in.
  app.get('/locks', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view sign-in locks' });
    const db = getDb();
    const locked = await throttle.listLockedAccounts(db, c.var.businessUnitId);
    return c.json({
      locked_accounts: locked,
      policy: {
        max_failed_attempts: throttle.MAX_FAILED_ATTEMPTS,
        window_minutes: throttle.WINDOW_MINUTES,
        lockout_minutes: throttle.LOCKOUT_MINUTES,
        note: 'A lock runs from the most recent failure, so repeated attempts keep extending it. Anyone who outranks the locked user can clear it instantly — waiting 15 minutes mid-queue is not an acceptable answer for a shop floor.',
      },
    });
  });

  app.post('/unlock', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const username = V.username(body.username, { field: 'Username' });
    if (username && username.error) throw new HttpError(400, username.error, 'VALIDATION_FAILED');

    const target = await db.prepare('SELECT * FROM users WHERE business_unit_id = ? AND username = ? AND is_deleted = 0').bind(c.var.businessUnitId, username).first();
    if (!target) throw new HttpError(404, 'That username was not found in this business.', 'USER_NOT_FOUND');

    // Authority mirrors PIN-reset exactly: anyone who can clear a lock could
    // already reset that user's PIN outright, so this grants no new power.
    const { outranks } = require('../lib/roles');
    if (target.id !== c.var.user.id && !outranks(c.var.user.role, target.role)) {
      throw new HttpError(403, 'You can only clear the lock of someone whose role is below your own.', 'UNLOCK_NOT_PERMITTED');
    }
    const cleared = await throttle.clearLoginLock(db, username);
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'LOGIN_LOCK_CLEARED', entityType: 'USER', entityId: target.id,
      reason: body.reason ? String(body.reason).slice(0, 500) : null,
      after: { username, failures_cleared: cleared }, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    // The audit trail is NOT deleted — only the failure rows that feed the
    // throttle. Successful logins and the fact that an unlock happened remain.
    return c.json({ ok: true, username, failures_cleared: cleared, note: 'The failed-attempt counter is cleared. The attempt history is kept — an unlock is itself an auditable event.' });
  });

  return app;
}

// Best-effort unit id for throttle audit rows on a FAILED login, where no
// session exists yet.
function result_unit(db, code) { return null; }

// ---------------------------------------------------------------------
// BRANDING  (public, unauthenticated — the login screen needs it)
// ---------------------------------------------------------------------
function brandingRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    // With one active business unit, its branding is the deployment's
    // branding. With several, the login screen shows a business picker and the
    // generic product brand until one is chosen.
    const rows = await db.prepare('SELECT * FROM business_units WHERE is_deleted = 0 AND is_active = 1 ORDER BY created_at ASC').all();
    if (rows.results.length === 1) return c.json(publicBranding(rows.results[0]));
    return c.json({
      name: 'StockRidge',
      tagline: 'Multi-branch stock, sales & back office',
      accent: '#0f766e',
      has_logo: false,
      logo_url: null,
      is_default: true,
      business_count: rows.results.length,
    });
  });

  // Serves the decoded image BYTES with a real Content-Type. A browser needs a
  // same-origin image URL for <img> and for manifest icons; a multi-hundred-KB
  // data: URI repeated across every icon size is slow and rejected by some
  // install flows.
  app.get('/:id/logo', async (c) => {
    const db = getDb();
    const unit = await db.prepare('SELECT logo_data_url FROM business_units WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    const decoded = unit && unit.logo_data_url ? decodeLogo(unit.logo_data_url) : null;
    if (!decoded) throw new HttpError(404, 'No logo has been set for this business.', 'LOGO_NOT_FOUND');
    // Long cache: the logo changes rarely and the login screen renders it on
    // every load. Versioned by the caller (?v=) when it does change.
    c.raw(decoded.bytes, 200, {
      'Content-Type': decoded.type,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    return undefined;
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const unit = await db.prepare('SELECT * FROM business_units WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!unit) throw new HttpError(404, 'That business was not found.', 'BUSINESS_UNIT_NOT_FOUND');
    return c.json(publicBranding(unit));
  });

  return app;
}

// ---------------------------------------------------------------------
// BUSINESS UNITS / PROFILES / SETTINGS
// ---------------------------------------------------------------------
function unitRoutes(getDb) {
  const app = createRouter();

  // Available industry profiles — the "what kind of business are you?" screen.
  app.get('/profiles', async (c) => {
    return c.json({
      profiles: PROFILES.map((p) => ({
        ...profileSummary(p),
        default_categories: p.default_categories,
        product_fields: p.product_fields,
        base_units: p.base_units || null,
      })),
      capability_keys: require('../../shared/industryProfiles').CAPABILITY_KEYS,
      base_units: require('../../shared/industryProfiles').BASE_UNITS,
      selling_units: require('../../shared/industryProfiles').SELLING_UNITS,
    });
  });

  app.get('/current', async (c) => {
    const db = getDb();
    const unit = await db.prepare('SELECT * FROM business_units WHERE id = ?').bind(c.var.businessUnitId).first();
    const caps = require('../lib/capabilities').capabilitiesOf(unit);
    const profile = require('../lib/capabilities').profileOf(unit);
    return c.json({
      business_unit: {
        id: unit.id, code: unit.code, name: unit.name, legal_name: unit.legal_name,
        industry_profile: unit.industry_profile, rc_number: unit.rc_number, tin: unit.tin,
        address: unit.address, state: unit.state, lga: unit.lga, phone: unit.phone, email: unit.email,
        currency: unit.currency, timezone: unit.timezone, fiscal_year_start_month: unit.fiscal_year_start_month,
        logo_url: unit.logo_data_url ? `/api/branding/${unit.id}/logo` : null,
        is_active: !!unit.is_active, created_at: unit.created_at,
      },
      profile: profile ? profileSummary(profile) : null,
      capabilities: caps,
      your_role: c.var.user.role,
    });
  });

  app.put('/current', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'change business details' });
    const db = getDb();
    const body = await c.req.json();
    const unit = await db.prepare('SELECT * FROM business_units WHERE id = ?').bind(c.var.businessUnitId).first();
    const patch = {};
    const before = {};
    const allow = ['name', 'legal_name', 'rc_number', 'tin', 'address', 'state', 'lga', 'phone', 'email', 'website', 'currency', 'fiscal_year_start_month'];
    for (const key of allow) {
      if (body[key] === undefined) continue;
      const value = body[key] == null ? null : String(body[key]).trim().slice(0, 400);
      if (String(unit[key] ?? '') !== String(value ?? '')) { before[key] = unit[key]; patch[key] = value || null; }
    }
    if (body.state) patch.state = require('../lib/geo').normaliseState(body.state);
    if (body.logo_data_url !== undefined) {
      const validated = assertValidLogoDataUrl(body.logo_data_url);
      patch.logo_data_url = validated ? validated.dataUrl : null;
      before.logo_data_url = '[changed]';
    }
    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0, message: 'Nothing to change.' });
    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    await db.prepare(`UPDATE business_units SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((k) => patch[k]), unit.id).run();
    await writeAudit(db, {
      businessUnitId: unit.id, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'BUSINESS_UPDATED', entityType: 'BUSINESS_UNIT', entityId: unit.id,
      before, after: patch, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, changed: cols.length });
  });

  // My Plan — OWNER visibility into their own subscription usage.
  app.get('/plan', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'view the subscription plan' });
    const db = getDb();
    return c.json(await planSummary(db, c.var.businessUnitId));
  });

  // Capability matrix, so the UI can hide what is off and the owner can see
  // WHY something is off (profile vs plan) — two different conversations.
  app.get('/capabilities', async (c) => {
    const db = getDb();
    const unit = await db.prepare('SELECT * FROM business_units WHERE id = ?').bind(c.var.businessUnitId).first();
    const { capabilityStatus } = require('../lib/capabilities');
    const { CAPABILITY_KEYS } = require('../../shared/industryProfiles');
    return c.json({
      business_unit_id: unit.id,
      profile: unit.industry_profile,
      capabilities: CAPABILITY_KEYS.map((k) => capabilityStatus(unit, k)),
    });
  });

  return app;
}

// ---------------------------------------------------------------------
// SETTINGS  (owner/manager governance, tax, permissions)
// ---------------------------------------------------------------------
function settingsRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const s = c.var.businessUnit;
    const role = c.var.user.role;
    // The vendor's own contact details and internal notes are ADMIN-only:
    // they are the commercial relationship, not the client's configuration.
    const base = {
      business_unit_id: s.id,
      tax: {
        vat_enabled: !!s.vat_enabled, vat_rate_percent: Number(s.vat_rate_percent),
        vat_inclusive_pricing: !!s.vat_inclusive_pricing, vat_registration_no: s.vat_registration_no || null,
        wht_enabled: !!s.wht_enabled,
      },
      manager_permissions: {
        managers_can_void_sales: !!s.managers_can_void_sales,
        managers_can_approve_expenses: !!s.managers_can_approve_expenses,
        managers_can_edit_prices: !!s.managers_can_edit_prices,
        managers_can_grant_credit: !!s.managers_can_grant_credit,
        managers_can_override_credit_limit: !!s.managers_can_override_credit_limit,
        managers_can_discount: !!s.managers_can_discount,
        max_discount_percent: Number(s.max_discount_percent),
      },
      staff_permissions: {
        staff_can_void_sales: !!s.staff_can_void_sales,
        staff_void_window_minutes: Number(s.staff_void_window_minutes),
        staff_can_adjust_stock: !!s.staff_can_adjust_stock,
        staff_adjustment_max_units: Number(s.staff_adjustment_max_units),
        staff_can_discount: !!s.staff_can_discount,
        staff_max_discount_percent: Number(s.staff_max_discount_percent),
        staff_can_take_credit_sale: !!s.staff_can_take_credit_sale,
        staff_can_spend_from_safe: !!s.staff_can_spend_from_safe,
        staff_safe_spend_max: Number(s.staff_safe_spend_max),
        staff_can_create_delivery_job: !!s.staff_can_create_delivery_job,
      },
      can_edit_tax: role === 'ADMIN' || role === 'OWNER',
      can_edit_manager_permissions: role === 'ADMIN' || role === 'OWNER',
      can_edit_staff_permissions: role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER',
    };
    if (role === 'ADMIN') {
      base.admin = {
        subscription_status: s.subscription_status, subscription_plan: s.subscription_plan,
        subscription_renewal_date: s.subscription_renewal_date,
        max_branches: s.max_branches, max_staff: s.max_staff, max_products: s.max_products,
        admin_contact_name: s.admin_contact_name, admin_contact_phone: s.admin_contact_phone,
        admin_contact_email: s.admin_contact_email, notes: s.notes,
      };
    }
    return c.json(base);
  });

  // VAT. OWNER-controlled: this is the client's own FIRS registration status,
  // not a vendor switch.
  app.put('/vat', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'change VAT settings' });
    const db = getDb();
    const body = await c.req.json();
    const patch = {};
    if (body.vat_enabled !== undefined) patch.vat_enabled = body.vat_enabled ? 1 : 0;
    if (body.vat_rate_percent !== undefined) {
      const r = Number(body.vat_rate_percent);
      if (!Number.isFinite(r) || r < 0 || r > 50) throw new HttpError(400, 'The VAT rate must be between 0 and 50 percent.', 'VAT_RATE_INVALID');
      patch.vat_rate_percent = r;
    }
    if (body.vat_inclusive_pricing !== undefined) patch.vat_inclusive_pricing = body.vat_inclusive_pricing ? 1 : 0;
    if (body.vat_registration_no !== undefined) patch.vat_registration_no = body.vat_registration_no ? String(body.vat_registration_no).slice(0, 60) : null;

    if (patch.vat_enabled === 1 && !patch.vat_inclusive_pricing && c.var.businessUnit.vat_inclusive_pricing === 1) {
      // Not an error, but the consequence must be stated: switching to
      // exclusive pricing changes what customers pay at the counter, which
      // makes every shelf label in the shop wrong.
    }
    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0 });
    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    await db.prepare(`UPDATE business_units SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((k) => patch[k]), c.var.businessUnitId).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'VAT_SETTINGS_CHANGED', entityType: 'BUSINESS_UNIT', entityId: c.var.businessUnitId,
      before: { vat_enabled: c.var.businessUnit.vat_enabled, vat_rate_percent: c.var.businessUnit.vat_rate_percent, vat_inclusive_pricing: c.var.businessUnit.vat_inclusive_pricing },
      after: patch, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({
      ok: true, changed: cols.length,
      advisory: patch.vat_inclusive_pricing === 0
        ? 'Prices are now EXCLUSIVE of VAT: customers will pay the shelf price plus VAT at the counter. Every price label in the shop is now a net-of-VAT figure — make sure that is what you intend.'
        : (patch.vat_enabled === 1 ? 'VAT is now collected and extracted from your existing prices. What a customer pays does not change; the VAT component is reported separately for your FIRS return.' : null),
    });
  });

  app.put('/wht', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'change withholding tax settings' });
    const db = getDb();
    const body = await c.req.json();
    const enabled = body.wht_enabled ? 1 : 0;
    const statements = [
      db.prepare('UPDATE business_units SET wht_enabled = ?, updated_at = ? WHERE id = ?')
        .bind(enabled, watNowIso(), c.var.businessUnitId),
    ];
    // Seed the 2024 Regulations schedule the first time WHT is switched on.
    // Rates are DATA, so the owner can then edit them without a deploy.
    if (enabled) {
      for (const r of whtLib.SEED_RATES) {
        const existing = await db.prepare('SELECT id FROM wht_rates WHERE code = ? AND is_system = 1 AND business_unit_id IS NULL').bind(r.code).first();
        if (existing) continue;
        statements.push(db.prepare(`
          INSERT INTO wht_rates (id, business_unit_id, code, label, category, direction, rate_percent,
            rate_percent_small_company, regulation_ref, effective_from, is_active, is_system, created_at, updated_at)
          VALUES (?, NULL,?,?,?,?,?,?,?, date('now','+1 hour'), 1, 1,?,?)
        `).bind(newId(), r.code, r.label, r.category, r.direction, r.rate_percent, r.rate_percent_small_company,
          r.regulation_ref, watNowIso(), watNowIso()));
      }
    }
    await db.batch(statements);
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'WHT_SETTINGS_CHANGED', entityType: 'BUSINESS_UNIT', entityId: c.var.businessUnitId,
      before: { wht_enabled: c.var.businessUnit.wht_enabled }, after: { wht_enabled: enabled },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({
      ok: true, wht_enabled: !!enabled,
      advisory: enabled
        ? 'Withholding tax is on. The 2024 Regulations schedule has been loaded under Settings → Withholding Tax; rates are data you can edit, and the small-company exemption is advisory only — it warns, it never blocks a payment.'
        : null,
    });
  });

  // Manager permissions — OWNER only.
  app.put('/manager-permissions', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'change manager permissions' });
    const db = getDb();
    const body = await c.req.json();
    const keys = ['managers_can_void_sales', 'managers_can_approve_expenses', 'managers_can_edit_prices',
      'managers_can_grant_credit', 'managers_can_override_credit_limit', 'managers_can_discount'];
    const patch = {};
    const before = {};
    for (const k of keys) {
      if (body[k] === undefined) continue;
      patch[k] = body[k] ? 1 : 0;
      before[k] = c.var.businessUnit[k];
    }
    if (body.max_discount_percent !== undefined) {
      const v = Number(body.max_discount_percent);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new HttpError(400, 'The maximum discount must be between 0 and 100 percent.', 'DISCOUNT_LIMIT_INVALID');
      patch.max_discount_percent = v;
      before.max_discount_percent = c.var.businessUnit.max_discount_percent;
    }
    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0 });
    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    await db.prepare(`UPDATE business_units SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((k) => patch[k]), c.var.businessUnitId).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'MANAGER_PERMISSIONS_CHANGED', entityType: 'BUSINESS_UNIT', entityId: c.var.businessUnitId,
      before, after: patch, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, changed: cols.length });
  });

  // Staff permissions — OWNER, and for the safe-spend pair also a BRANCH
  // MANAGER, because a branch manager runs the shop the cashier stands in and
  // must be able to set their own branch's allowance.
  app.put('/staff-permissions', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const role = c.var.user.role;
    const ownerKeys = ['staff_can_void_sales', 'staff_void_window_minutes', 'staff_can_adjust_stock',
      'staff_adjustment_max_units', 'staff_can_discount', 'staff_max_discount_percent', 'staff_can_take_credit_sale'];
    const managerKeys = ['staff_can_spend_from_safe', 'staff_safe_spend_max', 'staff_can_create_delivery_job'];

    const patch = {};
    const before = {};
    for (const k of [...ownerKeys, ...managerKeys, 'staff_can_create_delivery_job']) {
      if (body[k] === undefined) continue;
      const isManagerKey = managerKeys.includes(k);
      if (!isManagerKey && role !== 'ADMIN' && role !== 'OWNER') {
        throw new HttpError(403, 'Only the owner can change cashier void, write-off, discount and credit permissions — those are the controls against the two classic retail-theft patterns.', 'STAFF_PERMISSION_FORBIDDEN');
      }
      if (typeof body[k] === 'boolean') patch[k] = body[k] ? 1 : 0;
      else patch[k] = Number(body[k]) || 0;
      before[k] = c.var.businessUnit[k];
    }
    if (patch.staff_void_window_minutes !== undefined && (patch.staff_void_window_minutes < 0 || patch.staff_void_window_minutes > 1440)) {
      throw new HttpError(400, 'The void window must be between 0 and 1440 minutes.', 'VOID_WINDOW_INVALID');
    }
    if (patch.staff_adjustment_max_units !== undefined && patch.staff_adjustment_max_units < 0) {
      throw new HttpError(400, 'The write-off limit cannot be negative.', 'ADJUSTMENT_LIMIT_INVALID');
    }
    if (patch.staff_max_discount_percent !== undefined && (patch.staff_max_discount_percent < 0 || patch.staff_max_discount_percent > 100)) {
      throw new HttpError(400, 'The cashier discount limit must be between 0 and 100 percent.', 'DISCOUNT_LIMIT_INVALID');
    }
    if (patch.staff_safe_spend_max !== undefined && patch.staff_safe_spend_max < 0) {
      throw new HttpError(400, 'The safe-spend limit cannot be negative. Use 0 for no cap.', 'SAFE_LIMIT_INVALID');
    }
    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0 });
    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    await db.prepare(`UPDATE business_units SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((k) => patch[k]), c.var.businessUnitId).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: role,
      action: 'STAFF_PERMISSIONS_CHANGED', entityType: 'BUSINESS_UNIT', entityId: c.var.businessUnitId,
      before, after: patch, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({
      ok: true, changed: cols.length,
      advisory: patch.staff_safe_spend_max === 0 ? 'A safe-spend limit of 0 means NO CAP. That is deliberate — the can/cannot decision is staff_can_spend_from_safe, not this number.' : null,
    });
  });

  // WHT rate schedule — data, editable.
  app.get('/wht-rates', async (c) => {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT * FROM wht_rates
      WHERE is_deleted = 0 AND is_active = 1
        AND (business_unit_id = ? OR (business_unit_id IS NULL AND is_system = 1))
      ORDER BY category, code
    `).bind(c.var.businessUnitId).all();
    return c.json({
      rates: rows.results,
      small_company_threshold: whtLib.SMALL_COMPANY_MONTHLY_THRESHOLD,
      counterparty_types: whtLib.COUNTERPARTY_TYPES,
      note: 'Rates are data, not code. Nigerian rates changed materially under the Deduction of Tax at Source (Withholding) Regulations 2024, and they now differ by counterparty company size — so edit the schedule here rather than asking for a software change.',
    });
  });

  app.post('/wht-rates', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'add a withholding tax rate' });
    const db = getDb();
    const body = await c.req.json();
    const code = V.required(String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'), { field: 'Rate code', max: 40 });
    if (code && code.error) throw new HttpError(400, code.error, 'VALIDATION_FAILED');
    const label = V.required(body.label, { field: 'Label', max: 160 });
    if (label && label.error) throw new HttpError(400, label.error, 'VALIDATION_FAILED');
    const rate = Number(body.rate_percent);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new HttpError(400, 'The rate must be between 0 and 100 percent.', 'WHT_RATE_INVALID');
    const direction = V.oneOf(body.direction || 'BOTH', ['PAYABLE', 'RECEIVABLE', 'BOTH'], { field: 'Direction' });
    if (direction && direction.error) throw new HttpError(400, direction.error, 'VALIDATION_FAILED');
    const reduced = body.rate_percent_small_company == null ? null : Number(body.rate_percent_small_company);
    if (reduced != null && (!Number.isFinite(reduced) || reduced < 0 || reduced > 100)) {
      throw new HttpError(400, 'The small-company rate must be between 0 and 100 percent.', 'WHT_RATE_INVALID');
    }
    const ts = watNowIso();
    const id = newId();
    await db.prepare(`
      INSERT INTO wht_rates (id, business_unit_id, code, label, category, direction, rate_percent,
        rate_percent_small_company, counterparty_type, regulation_ref, effective_from, is_active, is_system, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, date('now','+1 hour'), 1, 0,?,?)
    `).bind(id, c.var.businessUnitId, code, label,
      body.category ? String(body.category).slice(0, 60) : 'OTHER', direction, rate, reduced,
      body.counterparty_type ? String(body.counterparty_type).toUpperCase() : null,
      body.regulation_ref ? String(body.regulation_ref).slice(0, 200) : null, ts, ts).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'WHT_RATE_ADDED', entityType: 'WHT_RATE', entityId: id,
      after: { code, rate_percent: rate, direction }, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, id, code, rate_percent: rate });
  });

  return app;
}

module.exports = { authRoutes, brandingRoutes, unitRoutes, settingsRoutes };
'use strict';
