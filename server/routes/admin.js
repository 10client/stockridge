'use strict';
// =====================================================================
// server/routes/admin.js — THE STRUCTURE OF THE DEPLOYMENT
// =====================================================================
// Businesses, branches, users, settings, plan limits and the audit trail. This
// is the module that decides WHO CAN SEE WHAT, so it carries the two rules the
// rest of the system depends on:
//
//   1. `users.branch_id` is the SOLE scoping truth. A MANAGER sees one branch
//      because that is where they are pinned, not because a request said so. No
//      endpoint here accepts a branch_id that widens a caller's scope.
//
//   2. There is exactly ONE stored MANAGER-or-above role hierarchy, and the
//      single ADMIN (the deployment owner) is the only user with no branch pin.
//      Everything else is scoped.
//
// PLAN LIMITS COUNT ONLY is_active = 1. Counting deactivated branches or sacked
// staff against a subscription cap charges a customer for people who have left,
// and — worse — silently blocks them from hiring a replacement.
//
// DEACTIVATE, NEVER DELETE. A user who sold something last month must still be
// attributable on that sale. Deleting them would orphan the audit trail, which
// is the one thing an investigation needs.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx, verifyAuditChain, anchorAudit } = require('../lib/audit');
// EVERY BRANCH CHANGE GOES THROUGH THIS, including the ones made from this file — see
// the module header in services/assignmentService.js for why a move is a handover.
const assignments = require('../services/assignmentService');
const { atLeast, isRole, ROLES, ROLE_ORDER, canManageUser, canResetPin, canChangeRole, roleLabel, navigationFor } = require('../../domain/roles');
const { TOKEN_TTL_SECONDS } = require('../middleware/auth');
const { resolveBranch, resolveBusiness, inScope, scopeFilter, pagination, listResponse, dateRange, numField, strField, boolField, valid, assertRowAccess, searchTerm } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId, hashPin, verifyPin, numericCode } = require('../../domain/crypto');
const { watNow, watToday } = require('../../domain/time');
const { oneOf, pin: pinRule, username: usernameRule, email: emailRule, nigerianPhone, validateNuban } = require('../../domain/validation');
const {
  getSettings, DEFAULT_SETTINGS, FLAG_SETTINGS, FEATURE_COLUMNS, FEATURE_LABELS, planUsage,
  assertCanCreateBusiness, assertCanCreateBranch, assertCanCreateStaff, assertFeatureEnabled,
  assertSubscriptionActive, activeBusinessCount, activeBranchCount, activeStaffCount,
  PLAN_FIELDS, SUBSCRIPTION_STATUSES, isPlanField, capValue, contactLine,
} = require('../../domain/planLimits');
const { getProfile, getProfileOrDefault, resolveProfile, PROFILE_CODES } = require('../../domain/verticals');
const { ALERT_HORIZON_DAYS } = require('../../domain/compliance');
const provisioning = require('../services/provisioningService');

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // BUSINESSES
  // -------------------------------------------------------------------
  app.get(`${base}/businesses`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const where = ['b.is_deleted = 0']; const params = [];
    if (!scope.allBusinesses && scope.businessIds) {
      const ids = [...scope.businessIds];
      where.push(`b.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
    }
    const rows = await db.all(`SELECT b.*,
          (SELECT COUNT(*) FROM branches br WHERE br.business_id = b.id AND br.is_deleted = 0 AND br.is_active = 1) AS active_branches,
          (SELECT COUNT(*) FROM users u WHERE u.business_id = b.id AND u.is_deleted = 0 AND u.is_active = 1) AS active_staff,
          (SELECT COUNT(*) FROM products p WHERE p.business_id = b.id AND p.is_deleted = 0 AND p.is_active = 1) AS products,
          (SELECT COALESCE(SUM(s.total),0) FROM sales s WHERE s.business_id = b.id AND s.is_deleted = 0 AND s.status <> 'VOIDED') AS lifetime_revenue
        FROM businesses b WHERE ${where.join(' AND ')} ORDER BY b.name`, params);
    ctx.json({
      ok: true,
      data: rows.map((r) => ({ ...r, lifetime_revenue: round2(Number(r.lifetime_revenue)), profile: profileSummary(r) })),
    });
  });

  /**
   * Create a business and provision it in ONE request.
   *
   * Provisioning derives the categories, the chart of accounts, the customer
   * classes, the price lists and the starter catalogue from the vertical profile.
   * Doing it here rather than as a follow-up call means a business is never left
   * half-created: an empty one has no ledger accounts, so its first sale would
   * fail to post and the owner's first impression would be that the system is
   * broken.
   */
  app.post(`${base}/businesses`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    if (!atLeast(user.role, 'ADMIN')) {
      throw new HttpError('Only the deployment administrator can create a business. Each business is a separate legal entity with its own books.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const body = await ctx.req.json();
    // THE SUBSCRIPTION GATE IS NOT HERE ANY MORE. It is one middleware on the whole
    // API (`server/routes/index.js`), which is the only arrangement in which the list of
    // what stays reachable while suspended can be true: a call parked inside a route
    // fires whatever the pipeline decides, so `POST /api/users` was refusing a client who
    // was suspended — while the pipeline exempts the users family on purpose, because a
    // sacked cashier has to be sackable and a PIN has to be resettable whether or not the
    // invoice is paid. One rule, one place.
    await assertCanCreateBusiness(db, settings);

    const name = strField(requireVal(body, 'name'), { field: 'Business name', maxLength: 160, required: true });
    const profileCode = valid(oneOf(body.profile_code || 'GENERAL_RETAIL', [...PROFILE_CODES], { field: 'Business type' }), 'profile_code');
    const id = newId();
    const seedCatalogue = boolField(body.seed_catalogue ?? true, true);

    // THE ROW IS INSERTED HERE, then handed to the service.
    //
    // `provisionBusiness(db, business, { withCatalogue, createdBy })` takes an
    // EXISTING business row and derives the catalogue, chart of accounts,
    // customer classes and price lists from its profile. It does not create the
    // business. Calling it with a single wrapper object — which is what this
    // route did — meant `business.id` was `undefined`, so every derived row was
    // written against business_id "undefined" and the whole request failed on the
    // foreign key. The route had never been exercised end to end, because the
    // seed creates deployments by a different path.
    await db.run(`INSERT INTO businesses (
        id, name, legal_name, profile_code, profile_overrides_json, cac_reg_no, tin, vat_registered,
        currency_code, contact_name, contact_phone, contact_email, address, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?, 'NGN', ?,?,?,?, 1, datetime('now'), datetime('now'))`, [
      id, name,
      strField(body.legal_name, { field: 'Legal name', maxLength: 200 }) || name,
      profileCode,
      body.profile_overrides ? JSON.stringify(body.profile_overrides) : null,
      strField(body.cac_reg_no, { field: 'CAC number', maxLength: 40 }),
      strField(body.tin, { field: 'TIN', maxLength: 40 }),
      boolField(body.vat_registered),
      strField(body.contact_name, { field: 'Contact name', maxLength: 120 }),
      strField(body.contact_phone, { field: 'Contact phone', maxLength: 40 }),
      strField(body.contact_email, { field: 'Contact email', maxLength: 160 }),
      strField(body.address, { field: 'Address', maxLength: 300 }),
    ]);
    const businessRow = await db.first('SELECT * FROM businesses WHERE id = ?', [id]);

    // A business with no branch cannot trade: every sale, stock row and till is
    // branch-scoped. So the first branch is created with the business, in the
    // same request, unless the caller explicitly says not to.
    let branchId = null;
    if (body.branch !== false) {
      const b = body.branch || {};
      branchId = newId();
      const bLat = b.latitude != null && String(b.latitude) !== '' ? Number(b.latitude) : null;
      const bLng = b.longitude != null && String(b.longitude) !== '' ? Number(b.longitude) : null;
      const bCode = (strField(b.code, { field: 'Branch code', maxLength: 20 }) || 'MAIN').toUpperCase();
      await db.run(`INSERT INTO branches (
          id, business_id, name, code, branch_type, address, city, state, lga, phone,
          latitude, longitude, geofence_radius_meters, attendance_mode, opening_cash, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 1, datetime('now'), datetime('now'))`, [
        branchId, id,
        strField(b.name, { field: 'Branch name', maxLength: 120 }) || `${name} — Main`,
        bCode,
        valid(oneOf(b.branch_type || 'RETAIL', ['RETAIL', 'WHOLESALE', 'WAREHOUSE', 'SHOWROOM', 'MIXED'], { field: 'Branch type' }), 'branch_type'),
        strField(b.address, { field: 'Branch address', maxLength: 300 }),
        strField(b.city, { field: 'City', maxLength: 80 }),
        strField(b.state, { field: 'State', maxLength: 80 }),
        strField(b.lga, { field: 'LGA', maxLength: 80 }),
        strField(b.phone, { field: 'Branch phone', maxLength: 40 }),
        bLat, bLng,
        numField(b.geofence_radius_meters ?? 150, { field: 'Fence radius', min: 0, max: 50000, whole: true }),
        valid(oneOf(b.attendance_mode || 'GEOLOCATION', ['GEOLOCATION', 'REGISTERED_DEVICE'], { field: 'Attendance mode' }), 'attendance_mode'),
        numField(b.opening_cash, { field: 'Opening float', min: 0 }),
      ]);
    } else {
      branchId = body.branch_id ? String(body.branch_id) : null;
    }

    const result = await provisioning.provisionBusiness(db, businessRow, {
      withCatalogue: seedCatalogue,
      createdBy: String(user.id),
    });

    // THE SERVICE HANDS BACK THE SUMMARY ITSELF. `provisionBusiness` ends `return summary` — the
    // counts are the value, at `result.categories` / `result.accounts` / `result.products`. The
    // `{ ok, businessId, … provisioned, seededBy }` wrapper belongs to `provisionDeployment`,
    // which is where the earlier reading of this came from; both shapes are accepted below so the
    // sentence stays true whichever way the service is called. Reading `result.summary` (and then
    // `result.provisioned`) left every count at `|| 0`, and the sentence a platform administrator
    // reads after creating a business said:
    //
    //     "…provisioned: 0 categories, 0 ledger accounts, 0 customer classes, 0 starter products."
    //
    // while the database held 13 categories and 52 ledger accounts. The provisioning worked and
    // the message denied it — the worst kind of wrong, because the next thing an administrator
    // does is start looking for what went missing. The numbers below are the service's own
    // summary, and `audit.createFlows.js` asserts they match the rows that actually exist.
    const summary = (result && (result.provisioned || result.summary)) || result || {};
    await recordFromCtx(ctx, {
      action: 'BUSINESS_CREATED', entityType: 'BUSINESS', entityId: id, businessId: id,
      after: { name, profileCode, provisioned: summary },
    });
    ctx.json({
      ok: true, id, branchId,
      business: { id, name, profile_code: profileCode },
      // A brand-new business is useless without a branch, a category and a
      // ledger, so the message says what was actually built rather than "ok".
      message: `${name} created as ${getProfileOrDefault(profileCode).label}${branchId ? ' with its first branch' : ''} and provisioned: ${summary.categories || 0} categories, ${summary.accounts || 0} ledger accounts, ${summary.customerClasses || 0} customer classes${seedCatalogue ? `, ${summary.products || 0} starter products` : ''}.${summary.skipped && summary.skipped.length ? ` ${summary.skipped.length} item(s) were skipped because they already existed.` : ''}`,
      summary,
      branch_id: branchId,
    }, 201);
  });

  app.put(`${base}/businesses/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const business = await db.first('SELECT * FROM businesses WHERE id = ? AND is_deleted = 0', [id]);
    if (!business) throw new HttpError('That business does not exist.', { status: 404, code: 'BUSINESS_NOT_FOUND' });
    if (!atLeast(user.role, 'ADMIN') && String(user.business_id) !== id) {
      throw new HttpError('You can only edit your own business.', { status: 403, code: 'BUSINESS_SCOPE_VIOLATION' });
    }
    // Changing the vertical profile after trading has begun would invalidate the
    // catalogue and the unit ladders built from it, so it is refused rather than
    // allowed to half-apply.
    if (body.profile_code && String(body.profile_code).toUpperCase() !== business.profile_code) {
      const products = await db.scalar('SELECT COUNT(*) FROM products WHERE business_id = ? AND is_deleted = 0', [id]);
      if (Number(products) > 0) {
        throw new HttpError(
          `${business.name} already has ${products} product(s) built on the ${business.profile_code} profile, including their unit ladders and categories. Changing the business type would leave them inconsistent. Create a new business for the other vertical instead.`,
          { status: 409, code: 'PROFILE_LOCKED' },
        );
      }
    }
    const sets = []; const params = [];
    for (const [col, opts] of Object.entries({
      name: { field: 'Business name', maxLength: 160 }, legal_name: { field: 'Legal name', maxLength: 200 },
      cac_reg_no: { field: 'CAC number', maxLength: 40 }, tin: { field: 'TIN', maxLength: 40 },
      contact_name: { field: 'Contact name', maxLength: 120 }, contact_phone: { field: 'Contact phone', maxLength: 40 },
      contact_email: { field: 'Contact email', maxLength: 160 }, address: { field: 'Address', maxLength: 300 },
    })) {
      if (body[col] !== undefined) { sets.push(`${col} = ?`); params.push(strField(body[col], opts)); }
    }
    if (body.profile_code !== undefined) { sets.push('profile_code = ?'); params.push(valid(oneOf(body.profile_code, [...PROFILE_CODES], { field: 'Business type' }), 'profile_code')); }
    if (body.profile_overrides !== undefined) { sets.push('profile_overrides_json = ?'); params.push(body.profile_overrides ? JSON.stringify(body.profile_overrides) : null); }
    if (body.vat_registered !== undefined) {
      const reg = boolField(body.vat_registered);
      sets.push('vat_registered = ?'); params.push(reg);
      if (!reg && !atLeast(user.role, 'ADMIN')) {
        throw new HttpError('Deregistering from VAT changes what every sale owes FIRS. Only the administrator can do that.', { status: 403, code: 'ROLE_REQUIRED' });
      }
    }
    if (body.is_active !== undefined && atLeast(user.role, 'ADMIN')) { sets.push('is_active = ?'); params.push(boolField(body.is_active, 1)); }
    if (!sets.length) throw new HttpError('Nothing to update.', { status: 400, code: 'NO_CHANGES' });
    sets.push("updated_at = datetime('now')");
    params.push(id);
    const before = { ...business };
    await db.run(`UPDATE businesses SET ${sets.join(', ')} WHERE id = ? AND is_deleted = 0`, params);
    await recordFromCtx(ctx, { action: 'BUSINESS_UPDATED', entityType: 'BUSINESS', entityId: id, businessId: id, before, after: body });
    ctx.json({ ok: true, message: `${body.name || business.name} updated.` });
  });

  // -------------------------------------------------------------------
  // BRANCHES
  // -------------------------------------------------------------------
  app.get(`${base}/branches`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const where = ['b.is_deleted = 0']; const params = [];
    if (!scope.allBranches && scope.branchIds) {
      const ids = [...scope.branchIds]; where.push(`b.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
    }
    const businessId = ctx.req.queryParam('business_id');
    if (businessId) { where.push('b.business_id = ?'); params.push(String(businessId)); }
    const rows = await db.all(`SELECT b.*, biz.name AS business_name, biz.profile_code,
          (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.is_deleted = 0 AND u.is_active = 1) AS active_staff,
          (SELECT COUNT(*) FROM products p WHERE p.business_id = b.business_id AND p.is_deleted = 0 AND p.is_active = 1) AS products,
          (SELECT COALESCE(SUM(sb.quantity * sb.cost_price_per_unit),0) FROM stock_batches sb
             WHERE sb.branch_id = b.id AND sb.is_deleted = 0 AND sb.status NOT IN ('QUARANTINED','EXPIRED')) AS stock_at_cost,
          (SELECT COUNT(*) FROM sales s WHERE s.branch_id = b.id AND s.is_deleted = 0 AND s.status <> 'VOIDED'
             AND date(s.sold_at) = date('now','+1 hours')) AS sales_today
        FROM branches b LEFT JOIN businesses biz ON biz.id = b.business_id
        WHERE ${where.join(' AND ')} ORDER BY b.is_active DESC, b.name`, params);
    ctx.json({
      ok: true,
      data: rows.map((r) => ({ ...r, stock_at_cost: round2(Number(r.stock_at_cost)), geofence_configured: Boolean(r.latitude && r.longitude && Number(r.geofence_radius_meters) > 0) })),
    });
  });

  app.post(`${base}/branches`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();
    const business = await resolveBusiness(db, ctx);
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only an owner can open a branch.', { status: 403, code: 'ROLE_REQUIRED' });
    // THE SUBSCRIPTION GATE IS NOT HERE ANY MORE. It is one middleware on the whole
    // API (`server/routes/index.js`), which is the only arrangement in which the list of
    // what stays reachable while suspended can be true: a call parked inside a route
    // fires whatever the pipeline decides, so `POST /api/users` was refusing a client who
    // was suspended — while the pipeline exempts the users family on purpose, because a
    // sacked cashier has to be sackable and a PIN has to be resettable whether or not the
    // invoice is paid. One rule, one place.
    if (!boolField(settings.multi_branch_enabled)) {
      throw new HttpError('Multi-branch is not enabled on this deployment. It can be switched on in Settings — it is a plan feature, not a technical limit.', { status: 403, code: 'FEATURE_DISABLED' });
    }
    await assertCanCreateBranch(db, settings, business.id);

    const name = strField(requireVal(body, 'name'), { field: 'Branch name', maxLength: 120, required: true });
    const code = (strField(body.code, { field: 'Branch code', maxLength: 20 }) || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'BR').toUpperCase();
    const dupe = await db.first('SELECT id, name FROM branches WHERE code = ? AND is_deleted = 0', [code]);
    if (dupe) throw new HttpError(`Branch code ${code} is already used by ${dupe.name}. Codes appear on receipt numbers and transfer references, so they must be unique.`, { status: 409, code: 'DUPLICATE_BRANCH_CODE' });

    const lat = body.latitude != null ? Number(body.latitude) : null;
    const lng = body.longitude != null ? Number(body.longitude) : null;
    const { coordinatesArePlausible } = require('../../domain/geofence');
    // `coordinatesArePlausible` returns an OBJECT ({ plausible, suspect, reason }).
    // Testing it directly — `if (!coordinatesArePlausible(...))` — is always
    // false, so this guard accepted every value it was ever given, including the
    // swapped pairs and unset-GPS (0,0) readings it exists to reject. Three call
    // sites had the same mistake; all four are now checked by tests.
    if (lat !== null || lng !== null) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new HttpError('A branch needs BOTH a latitude and a longitude, or neither. One without the other cannot place it.', { status: 400, code: 'INCOMPLETE_COORDINATES' });
      }
      const plausibility = coordinatesArePlausible(lat, lng);
      if (!plausibility.plausible) {
        throw new HttpError(`(${lat}, ${lng}) is not a plausible position: ${plausibility.reason} Latitude is -90..90, longitude -180..180 — check they are not swapped.`, { status: 400, code: 'IMPLAUSIBLE_COORDINATES' });
      }
    }
    const radius = numField(body.geofence_radius_meters ?? 150, { field: 'Fence radius', min: 0, max: 50000, whole: true });
    const id = newId();
    await db.run(`INSERT INTO branches (
        id, business_id, name, code, branch_type, address, city, state, lga, phone, email,
        latitude, longitude, geofence_radius_meters, attendance_mode, opening_cash, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?, 1, datetime('now'), datetime('now'))`, [
      id, String(business.id), name, code,
      valid(oneOf(body.branch_type || 'RETAIL', ['RETAIL', 'WHOLESALE', 'WAREHOUSE', 'SHOWROOM', 'MIXED'], { field: 'Branch type' }), 'branch_type'),
      strField(body.address, { field: 'Address', maxLength: 300 }),
      strField(body.city, { field: 'City', maxLength: 80 }),
      strField(body.state, { field: 'State', maxLength: 80 }),
      strField(body.lga, { field: 'LGA', maxLength: 80 }),
      strField(body.phone, { field: 'Phone', maxLength: 40 }),
      strField(body.email, { field: 'Email', maxLength: 160 }),
      lat, lng, radius,
      valid(oneOf(body.attendance_mode || 'GEOLOCATION', ['GEOLOCATION', 'REGISTERED_DEVICE'], { field: 'Attendance mode' }), 'attendance_mode'),
      numField(body.opening_cash, { field: 'Opening float', min: 0 }),
    ]);

    // A new branch starts with NO stock: it does not inherit another branch's
    // shelves. Copying stock would create units in two places at once, and the
    // group's total inventory would silently double.
    await recordFromCtx(ctx, {
      action: 'BRANCH_CREATED', entityType: 'BRANCH', entityId: id, branchId: id, businessId: business.id,
      after: { name, code, city: body.city, state: body.state, geofence: radius },
    });
    ctx.json({
      ok: true, id, code,
      message: `${name} (${code}) opened under ${business.name}.${lat ? ` Geofence set to ${radius}m.` : ' No coordinates were given, so clock-ins there will be flagged as unplaced until you set the branch location.'}`,
      warnings: lat ? [] : ['No location set — attendance geofencing cannot work at this branch until you add coordinates.'],
    }, 201);
  });

  app.put(`${base}/branches/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const branch = await db.first('SELECT * FROM branches WHERE id = ? AND is_deleted = 0', [id]);
    if (!branch) throw new HttpError('That branch does not exist.', { status: 404, code: 'BRANCH_NOT_FOUND' });
    // A manager may edit their OWN branch's contact details but not its identity
    // or its geofence — moving a fence is how an attendance problem disappears.
    assertRowAccess(ctx.get('scope'), branch, 'branch');
    if (!atLeast(user.role, 'OWNER') && String(user.branch_id) !== id) {
      throw new HttpError('You can only edit your own branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }
    const isOwner = atLeast(user.role, 'OWNER');
    const sets = []; const params = [];
    const editable = isOwner
      ? { name: { field: 'Branch name', maxLength: 120 }, code: { field: 'Branch code', maxLength: 20 }, address: { field: 'Address', maxLength: 300 }, city: { field: 'City', maxLength: 80 }, state: { field: 'State', maxLength: 80 }, lga: { field: 'LGA', maxLength: 80 }, phone: { field: 'Phone', maxLength: 40 }, email: { field: 'Email', maxLength: 160 } }
      : { address: { field: 'Address', maxLength: 300 }, city: { field: 'City', maxLength: 80 }, phone: { field: 'Phone', maxLength: 40 }, email: { field: 'Email', maxLength: 160 } };
    for (const [col, opts] of Object.entries(editable)) {
      if (body[col] !== undefined) {
        let v = strField(body[col], opts);
        if (col === 'code') {
          v = (v || '').toUpperCase();
          const dupe = await db.first('SELECT id, name FROM branches WHERE code = ? AND is_deleted = 0 AND id <> ?', [v, id]);
          if (dupe) throw new HttpError(`Branch code ${v} is already used by ${dupe.name}.`, { status: 409, code: 'DUPLICATE_BRANCH_CODE' });
        }
        sets.push(`${col} = ?`); params.push(v);
      }
    }
    if (isOwner) {
      if (body.latitude !== undefined || body.longitude !== undefined) {
        const { coordinatesArePlausible } = require('../../domain/geofence');
        const lat = body.latitude != null ? Number(body.latitude) : Number(branch.latitude);
        const lng = body.longitude != null ? Number(body.longitude) : Number(branch.longitude);
        // Same object-vs-boolean mistake as the create route: read `.plausible`.
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          throw new HttpError('A branch needs BOTH a latitude and a longitude, or neither. Clearing the pin is done by sending both as null.', { status: 400, code: 'INCOMPLETE_COORDINATES' });
        }
        if (lat !== 0 || lng !== 0) {
          const plausibility = coordinatesArePlausible(lat, lng);
          if (!plausibility.plausible) {
            throw new HttpError(`(${lat}, ${lng}) is not a plausible position: ${plausibility.reason}`, { status: 400, code: 'IMPLAUSIBLE_COORDINATES' });
          }
        } else {
          throw new HttpError('(0, 0) is where an unset GPS reports, not where a branch is. Send both coordinates as null to clear the pin.', { status: 400, code: 'IMPLAUSIBLE_COORDINATES' });
        }
        sets.push('latitude = ?', 'longitude = ?'); params.push(lat || null, lng || null);
      }
      if (body.geofence_radius_meters !== undefined) { sets.push('geofence_radius_meters = ?'); params.push(numField(body.geofence_radius_meters, { field: 'Fence radius', min: 0, max: 50000, whole: true })); }
      if (body.attendance_mode !== undefined) { sets.push('attendance_mode = ?'); params.push(valid(oneOf(body.attendance_mode, ['GEOLOCATION', 'REGISTERED_DEVICE'], { field: 'Attendance mode' }), 'attendance_mode')); }
      if (body.opening_cash !== undefined) { sets.push('opening_cash = ?'); params.push(numField(body.opening_cash, { field: 'Opening float', min: 0 })); }
      if (body.branch_type !== undefined) { sets.push('branch_type = ?'); params.push(valid(oneOf(body.branch_type, ['RETAIL', 'WHOLESALE', 'WAREHOUSE', 'SHOWROOM', 'MIXED'], { field: 'Branch type' }), 'branch_type')); }
      if (body.is_active !== undefined) {
        const active = boolField(body.is_active, 1);
        if (!active) {
          const staff = await db.scalar('SELECT COUNT(*) FROM users WHERE branch_id = ? AND is_active = 1 AND is_deleted = 0', [id]);
          const openTills = await db.scalar("SELECT COUNT(*) FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0", [id]);
          if (openTills > 0) throw new HttpError(`${openTills} till(s) are still open at ${branch.name}. Close them before deactivating the branch, or the counts will never be reconciled.`, { status: 409, code: 'OPEN_TILLS' });
          if (staff > 0 && !boolField(body.confirm_deactivate)) {
            throw new HttpError(`${branch.name} has ${staff} active staff member(s). Deactivating the branch will stop them selling. Pass confirm_deactivate: true if that is intended.`, { status: 409, code: 'BRANCH_HAS_STAFF' });
          }
        }
        sets.push('is_active = ?'); params.push(active);
      }
    }
    if (!sets.length) throw new HttpError('Nothing to update.', { status: 400, code: 'NO_CHANGES' });
    sets.push("updated_at = datetime('now')"); params.push(id);
    const before = { ...branch };
    await db.run(`UPDATE branches SET ${sets.join(', ')} WHERE id = ? AND is_deleted = 0`, params);
    await recordFromCtx(ctx, { action: 'BRANCH_UPDATED', entityType: 'BRANCH', entityId: id, branchId: id, businessId: branch.business_id, before, after: body });
    ctx.json({ ok: true, message: `${body.name || branch.name} updated.` });
  });

  // -------------------------------------------------------------------
  // USERS
  // -------------------------------------------------------------------
  app.get(`${base}/users`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const where = ['u.is_deleted = 0']; const params = [];
    const f = scopeFilter(scope, { alias: 'u' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }
    // THE VENDOR IS NOT PART OF THE CLIENT'S TEAM — the same rule as the session list below.
    // The deployment administrator's account was listed among the shop's own staff: a row the
    // client cannot manage, cannot reset and cannot revoke (every action on it answers 403),
    // sitting in the middle of the people they CAN. The count on the plan already excludes it;
    // the list now agrees with the count.
    if (!atLeast(user.role, 'ADMIN')) where.push("u.role <> 'ADMIN'");
    const role = ctx.req.queryParam('role');
    if (role) { where.push('u.role = ?'); params.push(String(role).toUpperCase()); }
    const active = ctx.req.queryParam('active');
    if (active === '1' || active === 'true') where.push('u.is_active = 1');
    if (active === '0' || active === 'false') where.push('u.is_active = 0');
    const search = searchTerm(ctx);
    if (search) { where.push('(u.full_name LIKE ? OR u.username LIKE ? OR u.phone LIKE ? OR u.email LIKE ?)'); const l = `%${search}%`; params.push(l, l, l, l); }
    const whereSql = where.join(' AND ');
    const rows = await db.all(`SELECT u.id, u.business_id, u.branch_id, u.full_name, u.username, u.role, u.job_title,
          u.email, u.phone, u.nin, u.bvn_last4, u.bank_name, u.bank_account_no, u.employment_started, u.employment_ended,
          u.commission_rate_pct, u.is_active, u.last_login_at, u.created_at,
          b.name AS branch_name, b.code AS branch_code, biz.name AS business_name,
          (SELECT COUNT(*) FROM sales s WHERE s.salesperson_id = u.id AND s.is_deleted = 0 AND date(s.sold_at) = date('now','+1 hours')) AS sales_today,
          (SELECT COALESCE(SUM(s.total),0) FROM sales s WHERE s.salesperson_id = u.id AND s.is_deleted = 0 AND s.status <> 'VOIDED'
             AND date(s.sold_at) BETWEEN date('now','-29 days','+1 hours') AND date('now','+1 hours')) AS revenue_30d,
          (SELECT sa.clock_in_at FROM staff_attendance sa WHERE sa.user_id = u.id AND sa.clock_out_at IS NULL AND sa.is_deleted = 0
             ORDER BY sa.clock_in_at DESC LIMIT 1) AS currently_clocked_in
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN businesses biz ON biz.id = u.business_id
        WHERE ${whereSql} ORDER BY u.is_active DESC, u.full_name LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM users u WHERE ${whereSql}`, params);
    ctx.json({
      ...listResponse(rows.map((r) => ({
        ...r,
        // The PIN hash is never selected above and never returned. A caller who
        // needs to know whether a PIN is set should ask for that fact, not the
        // hash.
        revenue_30d: round2(Number(r.revenue_30d)),
        roleLabel: roleLabel(r.role),
        navigation: navigationFor(r.role),
      })), { limit, offset }, total),
    });
  });

  app.post(`${base}/users`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();
    // THE SUBSCRIPTION GATE IS NOT HERE ANY MORE. It is one middleware on the whole
    // API (`server/routes/index.js`), which is the only arrangement in which the list of
    // what stays reachable while suspended can be true: a call parked inside a route
    // fires whatever the pipeline decides, so `POST /api/users` was refusing a client who
    // was suspended — while the pipeline exempts the users family on purpose, because a
    // sacked cashier has to be sackable and a PIN has to be resettable whether or not the
    // invoice is paid. One rule, one place.

    const role = valid(oneOf(requireVal(body, 'role'), [...ROLE_ORDER], { field: 'Role' }), 'role');
    if (!canManageUser(user, { role })) {
      throw new HttpError(`You are a ${roleLabel(user.role)} and cannot create a ${roleLabel(role)}. Only somebody above that role can.`, { status: 403, code: 'ROLE_REQUIRED' });
    }
    // Only the deployment administrator may create another ADMIN. Two admins who
    // can each deactivate the other is not a hierarchy, it is a deadlock.
    if (role === 'ADMIN' && !atLeast(user.role, 'ADMIN')) {
      throw new HttpError('Only the deployment administrator can create another administrator.', { status: 403, code: 'ADMIN_ONLY' });
    }

    // THE BRANCH IS RESOLVED FIRST, BECAUSE THE BUSINESS FOLLOWS FROM IT.
    //
    // The previous version passed an options object into `resolveBusiness`'s third
    // parameter, which is a BRANCH ROW — so the business came from
    // `options.business_id` (usually undefined), then the caller's pinned
    // business, then `client_settings.primary_business_id`, and finally "the
    // oldest live business". For an administrator provisioning a second company,
    // that last fallback is silently wrong: a user created for a branch of the
    // NEW business was recorded against the OLD one, with the new branch attached.
    //
    // Live consequence, found by tools/verify-deployment.js on staging: that user
    // then read the other company's reports, because scope is derived from the
    // business on the user row. It is the same shape of failure as the six
    // missing-import bugs — a value passed where a different shape was expected,
    // which no compiler and no static audit in this repository can see.
    //
    // `required: false` because an administrator may be creating another
    // administrator, who belongs to no branch at all.
    const branch = await resolveBranch(db, ctx, { required: false });
    const business = await resolveBusiness(db, ctx, branch);

    // An explicit business_id naming a business the caller may reach is honoured
    // (see resolveBusiness). Naming one they may not reach is refused there, with
    // BUSINESS_SCOPE_VIOLATION, rather than ignored.
    // A MANAGER or below is PINNED to the caller's own branch: the branch_id in
    // the request is ignored rather than trusted, because that field is the sole
    // scoping truth and letting it be set from a request would let a manager
    // create staff they can then see the sales of, anywhere.
    const effectiveBranch = role === 'ADMIN' ? null : (atLeast(user.role, 'OWNER') ? (branch || null) : await resolveBranch(db, ctx));
    if (role !== 'ADMIN' && !effectiveBranch) {
      throw new HttpError('Choose which branch this person works at. A user with no branch has no scope, so they would see nothing.', { status: 400, code: 'BRANCH_REQUIRED' });
    }
    if (role === 'MANAGER' && !effectiveBranch) {
      throw new HttpError('A manager must be pinned to one branch — that pin is what makes them a manager OF somewhere.', { status: 400, code: 'BRANCH_REQUIRED' });
    }

    if (role === 'STAFF') await assertCanCreateStaff(db, settings, business.id);

    const fullName = strField(requireVal(body, 'full_name'), { field: 'Full name', maxLength: 160, required: true });
    const usernameRaw = strField(requireVal(body, 'username'), { field: 'Username', maxLength: 40, required: true }).toLowerCase();
    const uname = usernameRule(usernameRaw);
    if (!uname.ok) throw new HttpError(uname.error, { status: 400, code: uname.code, fields: { username: uname.error } });
    const username = uname.value;
    const dupeUser = await db.first('SELECT id, full_name, is_active FROM users WHERE username = ? AND is_deleted = 0', [username]);
    if (dupeUser) {
      throw new HttpError(
        `The username "${username}" is already taken by ${dupeUser.full_name}${dupeUser.is_active ? '' : ' (deactivated)'}. Usernames must be unique even for a deactivated user, because their past sales are still attributed to them.`,
        { status: 409, code: 'DUPLICATE_USERNAME', fields: { username: 'Already taken' } },
      );
    }

    const pinCheck = pinRule(requireVal(body, 'pin'), { confirm: body.confirm_pin != null ? body.confirm_pin : null });
    if (!pinCheck.ok) throw new HttpError(pinCheck.error, { status: 400, code: pinCheck.code, fields: { pin: pinCheck.error } });
    const hashed = await hashPin(pinCheck.value);

    const phone = body.phone ? nigerianPhone(body.phone, { required: false }) : null;
    if (phone && !phone.ok) throw new HttpError(phone.error, { status: 400, code: phone.code, fields: { phone: phone.error } });
    const emailCheck = body.email ? emailRule(body.email, { required: false }) : null;
    if (emailCheck && !emailCheck.ok) throw new HttpError(emailCheck.error, { status: 400, code: emailCheck.code, fields: { email: emailCheck.error } });

    // Bank details are collected for payroll. The NUBAN check is ADVISORY: an
    // unusual bank or a newly issued account can fail the checksum while being
    // perfectly real, and blocking a hire over it is worse than recording a
    // warning the owner can look at.
    const nuban = strField(body.bank_account_no, { field: 'Account number', maxLength: 40 });
    const advisories = [];
    if (nuban) {
      const nubanCheck = validateNuban(nuban, { bankName: strField(body.bank_name, { field: 'Bank', maxLength: 120 }) });
      if (!nubanCheck.ok) advisories.push(nubanCheck.error);
    }

    const commissionRate = numField(body.commission_rate_pct, { field: 'Commission rate', min: 0, max: 100 });
    const id = newId();
    await db.run(`INSERT INTO users (
        id, business_id, branch_id, full_name, username, pin_hash, role, job_title, email, phone,
        nin, bvn_last4, bank_name, bank_account_no, employment_started, employment_ended,
        commission_rate_pct, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 1, datetime('now'), datetime('now'))`, [
      id, String(business.id), effectiveBranch ? String(effectiveBranch.id) : null,
      fullName, username, hashed.stored, role,
      strField(body.job_title, { field: 'Job title', maxLength: 120 }) || roleLabel(role),
      emailCheck ? emailCheck.value : null, phone ? phone.value : null,
      strField(body.nin, { field: 'NIN', maxLength: 40 }),
      strField(body.bvn_last4, { field: 'BVN last 4', maxLength: 4 }),
      strField(body.bank_name, { field: 'Bank', maxLength: 120 }), nuban,
      strField(body.employment_started, { field: 'Start date', maxLength: 10 }) || watToday(),
      null, commissionRate,
    ]);

    // THE HISTORY STARTS HERE, not at somebody's first transfer. Most staff never
    // transfer at all, so a history that began at the first move could not answer
    // "who could see the Minna till on 14 March?" for the majority of the people it
    // is asked about. The row says: from this moment, this person is at that branch.
    await assignments.recordAssignment(db, {
      userId: id,
      fromBranchId: null,
      toBranchId: effectiveBranch ? effectiveBranch.id : null,
      fromBusinessId: null,
      toBusinessId: business.id,
      reason: `Created as ${roleLabel(role)}`,
      changedBy: user.id,
    });

    await recordFromCtx(ctx, {
      action: 'USER_CREATED', entityType: 'USER', entityId: id,
      branchId: effectiveBranch ? effectiveBranch.id : null, businessId: business.id,
      after: { fullName, username, role, branch: effectiveBranch ? effectiveBranch.name : null, commissionRate },
    });
    ctx.json({
      ok: true, id, username,
      message: `${fullName} created as ${roleLabel(role)}${effectiveBranch ? ` at ${effectiveBranch.name}` : ' with access to every branch'}. Their PIN is set and they can sign in now.`,
      advisories,
    }, 201);
  });

  app.put(`${base}/users/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const target = await db.first('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [id]);
    if (!target) throw new HttpError('That user does not exist.', { status: 404, code: 'USER_NOT_FOUND' });
    if (String(target.id) === String(user.id) && (body.role || body.is_active === false || body.branch_id)) {
      throw new HttpError('You cannot change your own role, branch or active status. Somebody else has to do that, or the hierarchy could be edited by the person it constrains.', { status: 400, code: 'SELF_CHANGE_FORBIDDEN' });
    }
    if (!canManageUser(user, target)) throw new HttpError(`You are a ${roleLabel(user.role)} and cannot edit a ${roleLabel(target.role)}.`, { status: 403, code: 'ROLE_REQUIRED' });
    if (!inScope(ctx.get('scope'), target) && !atLeast(user.role, 'ADMIN')) {
      throw new HttpError('That user is at another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }

    const sets = []; const params = [];
    if (body.full_name !== undefined) { sets.push('full_name = ?'); params.push(strField(body.full_name, { field: 'Full name', maxLength: 160, required: true })); }
    if (body.job_title !== undefined) { sets.push('job_title = ?'); params.push(strField(body.job_title, { field: 'Job title', maxLength: 120 })); }
    if (body.email !== undefined) { const e = emailRule(body.email, { required: false }); if (!e.ok) throw new HttpError(e.error, { status: 400, code: e.code, fields: { email: e.error } }); sets.push('email = ?'); params.push(e.value); }
    if (body.phone !== undefined) { const p = nigerianPhone(body.phone, { required: false }); if (!p.ok) throw new HttpError(p.error, { status: 400, code: p.code, fields: { phone: p.error } }); sets.push('phone = ?'); params.push(p.value); }
    for (const col of ['nin', 'bvn_last4', 'bank_name', 'bank_account_no', 'employment_started', 'employment_ended']) {
      if (body[col] !== undefined) { sets.push(`${col} = ?`); params.push(strField(body[col], { field: col.replace(/_/g, ' '), maxLength: 80 })); }
    }
    if (body.commission_rate_pct !== undefined) {
      if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can set a commission rate.', { status: 403, code: 'ROLE_REQUIRED' });
      sets.push('commission_rate_pct = ?'); params.push(numField(body.commission_rate_pct, { field: 'Commission rate', min: 0, max: 100 }));
    }
    // MOVING A USER between branches is the sensitive edit: it changes everything
    // they can see. It is refused across businesses unless the caller is an admin,
    // and it is never allowed to reparent a row into a scope the caller controls.
    //
    // AND SINCE STAGE G3 IT IS A HANDOVER, NOT A ROW UPDATE. A move asked for in this
    // request does not happen here: a transfer row is created and the person stays
    // where they are until somebody at the receiving branch agrees. The rest of the
    // edit (name, phone, job title, commission) applies immediately, because those do
    // not change what the person can see.
    //
    // TWO MOVES STILL APPLY AT ONCE, and both are deliberate:
    //   * a move to NO branch (releasing somebody), because no shop has to agree to
    //     receive a person they are not receiving;
    //   * a move by the platform ADMINISTRATOR, whose job is moving rows across
    //     businesses and who has no branch to be refused by.
    let pendingTransfer = null;
    if (body.branch_id !== undefined && body.branch_id !== target.branch_id) {
      if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only an owner can move somebody to another branch. Their branch is what they can see.', { status: 403, code: 'ROLE_REQUIRED' });
      const nb = body.branch_id ? await db.first('SELECT * FROM branches WHERE id = ? AND is_deleted = 0', [String(body.branch_id)]) : null;
      if (body.branch_id && !nb) throw new HttpError('That branch does not exist.', { status: 404, code: 'BRANCH_NOT_FOUND' });
      if (nb && String(nb.business_id) !== String(target.business_id) && !atLeast(user.role, 'ADMIN')) {
        throw new HttpError(`${nb.name} belongs to another business. Moving somebody between businesses is an administrator action, because it moves them between two sets of books.`, { status: 403, code: 'CROSS_BUSINESS_MOVE' });
      }
      if (target.role === 'MANAGER' && !nb) throw new HttpError('A manager must be pinned to a branch.', { status: 400, code: 'BRANCH_REQUIRED' });

      const immediate = !nb || atLeast(user.role, 'ADMIN');
      if (immediate) {
        sets.push('branch_id = ?'); params.push(nb ? String(nb.id) : null);
        if (nb) { sets.push('business_id = ?'); params.push(String(nb.business_id)); }
      } else {
        // THE RECEIVING BRANCH DECIDES. Asked for in the same breath as the edit, so a
        // screen that saves a form does not need to know about transfers — but the
        // answer says plainly that the move is a question and not a fact.
        const asked = await assignments.requestTransfer(db, {
          userId: target.id, toBranchId: nb.id, requestedBy: user.id,
          reason: strField(body.transfer_reason, { field: 'Reason', maxLength: 300 }) || `Asked from the staff screen by ${user.full_name || user.username}`,
        });
        if (asked.error === 'ALREADY_PENDING') {
          throw new HttpError(`${target.full_name} already has a transfer waiting — to ${asked.to.name}. Cancel that one first, or wait for somebody at ${asked.to.name} to answer it.`, { status: 409, code: 'TRANSFER_ALREADY_PENDING' });
        }
        if (asked.error === 'ALREADY_THERE') {
          throw new HttpError(`${target.full_name} is already at ${asked.to.name}.`, { status: 409, code: 'ALREADY_THERE' });
        }
        if (asked.error) throw new HttpError('That move could not be requested.', { status: 400, code: asked.error });
        pendingTransfer = asked;
        await recordFromCtx(ctx, {
          action: 'USER_TRANSFER_REQUESTED', entityType: 'USER_TRANSFER', entityId: asked.transfer.id,
          branchId: String(nb.id), businessId: String(nb.business_id),
          before: { user_id: target.id, branch_id: target.branch_id },
          after: { user_id: target.id, to_branch_id: nb.id, to_branch: nb.name },
        });
      }
    }
    if (body.role !== undefined && String(body.role).toUpperCase() !== target.role) {
      const newRole = valid(oneOf(body.role, [...ROLE_ORDER], { field: 'Role' }), 'role');
      if (!canChangeRole(user, target.role, newRole)) throw new HttpError(`You cannot change a ${roleLabel(target.role)} into a ${roleLabel(newRole)}.`, { status: 403, code: 'ROLE_REQUIRED' });
      if (newRole === 'ADMIN' && !atLeast(user.role, 'ADMIN')) throw new HttpError('Only an administrator can grant administrator rights.', { status: 403, code: 'ADMIN_ONLY' });
      if (newRole !== 'ADMIN' && !target.branch_id) throw new HttpError(`${target.full_name} has no branch, so they can only be an administrator. Give them a branch first — a ${roleLabel(newRole)} with no branch would see nothing.`, { status: 400, code: 'BRANCH_REQUIRED' });
      sets.push('role = ?'); params.push(newRole);
    }
    if (body.is_active !== undefined) {
      const active = boolField(body.is_active, 1);
      if (!active) {
        // DEACTIVATE, NEVER DELETE: their past sales must stay attributable.
        const openTill = await db.scalar("SELECT COUNT(*) FROM till_sessions WHERE user_id = ? AND status = 'OPEN' AND is_deleted = 0", [id]);
        if (openTill > 0 && !boolField(body.force)) {
          throw new HttpError(`${target.full_name} has an open till. Close it first, or pass force: true — leaving a drawer open under a deactivated user means nobody will ever count it.`, { status: 409, code: 'OPEN_TILL' });
        }
        sets.push('is_active = 0', 'employment_ended = COALESCE(employment_ended, date(\'now\',\'+1 hours\'))');
      } else {
        sets.push('is_active = 1');
      }
    }
    // A REQUEST WITHOUT AN EDIT IS NOT AN EMPTY REQUEST. Sending only `branch_id` asks
    // for a handover and changes no column on this row, and refusing it with "Nothing
    // to update" would make the move impossible to ask for from a screen that saves one
    // field at a time.
    if (!sets.length && !pendingTransfer) throw new HttpError('Nothing to update.', { status: 400, code: 'NO_CHANGES' });
    const willWrite = sets.length > 0;
    sets.push("updated_at = datetime('now')"); params.push(id);

    const before = { full_name: target.full_name, username: target.username, role: target.role, branch_id: target.branch_id, business_id: target.business_id, is_active: target.is_active, commission_rate_pct: target.commission_rate_pct };
    if (willWrite) await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND is_deleted = 0`, params);

    // AN IMMEDIATE MOVE IS STILL A MOVE. Without this the history would record every
    // handover and none of the administrator's own corrections, which is the half of
    // the story that is hardest to reconstruct afterwards.
    if (!pendingTransfer && body.branch_id !== undefined && String(body.branch_id || '') !== String(target.branch_id || '')) {
      await assignments.recordAssignment(db, {
        userId: target.id,
        fromBranchId: target.branch_id,
        toBranchId: body.branch_id || null,
        fromBusinessId: target.business_id,
        toBusinessId: body.branch_id && body.branch_id !== target.branch_id
          ? (await db.first('SELECT business_id FROM branches WHERE id = ?', [String(body.branch_id)]) || {}).business_id || null
          : target.business_id,
        reason: body.branch_id ? 'Moved directly, without a handover' : 'Released from a branch',
        changedBy: user.id,
      });
    }

    // Deactivating someone must end their live session immediately. Their token
    // would otherwise keep working until it expired — up to twelve hours — which
    // is the difference between a sacked cashier losing access now and losing it
    // at 6pm.
    if (body.is_active !== undefined && !boolField(body.is_active, 1)) {
      await db.run('DELETE FROM user_sessions WHERE user_id = ?', [id]);
    }

    await recordFromCtx(ctx, {
      action: body.is_active === false ? 'USER_DEACTIVATED' : 'USER_UPDATED', entityType: 'USER', entityId: id,
      branchId: target.branch_id, businessId: target.business_id, before, after: body,
    });
    ctx.json({
      ok: true,
      pendingTransfer: pendingTransfer ? pendingTransfer.transfer : null,
      message: body.is_active === false
        ? `${target.full_name} deactivated and signed out of every device. Their past sales and audit entries stay attributed to them.`
        : (pendingTransfer
          ? `${target.full_name} updated. The move to ${pendingTransfer.to.name} is now a question for that branch — they keep working where they are until somebody there agrees to receive them.`
          : `${target.full_name} updated.`),
    });
  });

  /**
   * Reset a PIN.
   *
   * The new PIN is returned ONCE, in this response, and never stored or logged in
   * plain text. Ending every live session at the same time is not optional: a
   * reset because a PIN was compromised is worthless if the thief's existing
   * token keeps working.
   */
  app.post(`${base}/users/:id/reset-pin`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const target = await db.first('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [id]);
    if (!target) throw new HttpError('That user does not exist.', { status: 404, code: 'USER_NOT_FOUND' });
    const self = String(target.id) === String(user.id);
    if (!self && !canResetPin(user, target)) {
      throw new HttpError(`You cannot reset a ${roleLabel(target.role)}'s PIN.`, { status: 403, code: 'ROLE_REQUIRED' });
    }

    // A manager resetting their OWN PIN must prove the old one. Somebody else
    // resetting theirs does not know it, and requiring it would make the feature
    // unusable — which is the point of an authority check instead.
    if (self) {
      const current = strField(body.current_pin, { field: 'Current PIN', maxLength: 12, required: true });
      const okCurrent = await verifyPin(current, target.pin_hash);
      if (!okCurrent) throw new HttpError('That is not your current PIN.', { status: 403, code: 'WRONG_PIN', fields: { current_pin: 'Incorrect' } });
    }

    let newPin;
    if (body.new_pin) {
      const check = pinRule(body.new_pin, { confirm: body.confirm_pin != null ? body.confirm_pin : null });
      if (!check.ok) throw new HttpError(check.error, { status: 400, code: check.code, fields: { new_pin: check.error } });
      newPin = check.value;
    } else {
      // A generated PIN is cryptographically random, not a pattern. Guessable
      // resets (1234, the last four of a phone number) are how a "reset" becomes
      // the easiest way into an account.
      newPin = numericCode(5);
    }
    if (newPin === body.current_pin) {
      throw new HttpError('The new PIN is the same as the old one. If it was compromised, reusing it changes nothing.', { status: 400, code: 'PIN_UNCHANGED' });
    }
    const hashed = await hashPin(newPin);
    await db.run("UPDATE users SET pin_hash = ?, pin_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND is_deleted = 0", [hashed.stored, id]);
    const killed = await db.run('DELETE FROM user_sessions WHERE user_id = ?', [id]);

    await recordFromCtx(ctx, {
      action: self ? 'PIN_CHANGED' : 'PIN_RESET', entityType: 'USER', entityId: id,
      branchId: target.branch_id, businessId: target.business_id,
      // The PIN itself is NEVER written to the audit log. An audit trail that
      // contains credentials becomes the most valuable thing in the database to
      // steal.
      after: { self, sessionsEnded: killed && killed.changes, generated: !body.new_pin },
    });
    ctx.json({
      ok: true,
      pin: newPin,
      sessionsEnded: killed ? killed.changes : 0,
      message: self
        ? 'Your PIN has been changed and you have been signed out of every other device. Sign in again with the new PIN.'
        : `${target.full_name}'s PIN is ${newPin}. Tell them in person — it is shown once and is not stored anywhere in plain text. They have been signed out of every device.`,
      showOnce: true,
    });
  });

  /** Who is signed in right now, and from where. */
  app.get(`${base}/sessions`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');
    const where = ['u.is_deleted = 0']; const params = [];
    const f = scopeFilter(scope, { alias: 'u' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }
    // THE VENDOR IS NOT PART OF THE CLIENT'S TEAM. The deployment ADMIN's own session was
    // listed to client managers — a username, when they last acted and the address they came
    // from — and there is nothing the manager could do with the row: `canManageUser` refuses
    // the revocation, so the row is information they cannot act on and have no business
    // holding. A session is the most sensitive row this product holds (it says where a person
    // is working from and when they last touched the system), so the rule is stated here
    // rather than left to whoever remembers. The same rule already governs the plan: "the
    // ADMIN vendor seat is NOT counted — it is not part of the client's team". The owner of
    // the deployment still sees every session, vendor included: hiding the vendor's own
    // session from the vendor would hide the account that is signed in as you.
    if (!atLeast(user.role, 'ADMIN')) where.push("u.role <> 'ADMIN'");
    // EXPIRES_AT IS COMPUTED FROM THE SAME CONSTANT THE TOKEN IS SIGNED WITH, bound as a
    // parameter rather than typed into the SQL — a screen that says "expires in 4 hours" and a
    // token that lives for twelve is worse than no column at all.
    const rows = await db.all(`SELECT us.user_id, us.session_id, us.issued_at, us.updated_at,
          us.device_id, us.user_agent,
          datetime(us.issued_at, ?) AS expires_at,
          u.full_name, u.username, u.role, b.name AS branch_name,
          (SELECT MAX(a.created_at) FROM audit_log a WHERE a.user_id = u.id) AS last_action_at,
          (SELECT a.ip_address FROM audit_log a WHERE a.user_id = u.id ORDER BY a.created_at DESC LIMIT 1) AS last_ip
        FROM user_sessions us JOIN users u ON u.id = us.user_id
        LEFT JOIN branches b ON b.id = u.branch_id
        WHERE ${where.join(' AND ')} ORDER BY us.issued_at DESC LIMIT 200`,
    [`+${TOKEN_TTL_SECONDS} seconds`, ...params]);
    ctx.json({ ok: true, data: rows, count: rows.length });
  });

  /** Sign somebody else out. An owner removing access from a lost phone. */
  app.post(`${base}/sessions/:userId/revoke`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const targetId = String(ctx.req.param('userId'));
    if (targetId !== String(user.id) && !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('You can only sign yourself out.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const target = await db.first('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [targetId]);
    if (!target) throw new HttpError('That user does not exist.', { status: 404, code: 'USER_NOT_FOUND' });
    if (targetId !== String(user.id) && !canManageUser(user, target)) throw new HttpError(`You cannot sign out a ${roleLabel(target.role)}.`, { status: 403, code: 'ROLE_REQUIRED' });
    const res = await db.run('DELETE FROM user_sessions WHERE user_id = ?', [targetId]);
    await recordFromCtx(ctx, { action: 'SESSIONS_REVOKED', entityType: 'USER', entityId: targetId, branchId: target.branch_id, businessId: target.business_id, after: { sessionsEnded: res.changes, self: targetId === String(user.id) } });
    ctx.json({ ok: true, sessionsEnded: res.changes, message: targetId === String(user.id) ? 'You have been signed out of every device.' : `${target.full_name} signed out of ${res.changes} session(s).` });
  });


  // -------------------------------------------------------------------
  // WHICH BUSINESSES A USER MAY REACH
  // -------------------------------------------------------------------
  /**
   * THE LAST HALF-BUILT CAPABILITY IN THE SCHEMA.
   *
   * `server/middleware/auth.js` has always read `user_business_access` to decide
   * which businesses a user can reach — "their own, plus explicit grants" — and
   * `domain/access.js` turns that set into the SQL that scopes every read. Nothing
   * anywhere could create a grant, so the answer was always "their own".
   *
   * What that cost a real shop: a group running two businesses (a furniture
   * showroom and an appliance shop, or a retail shop and its wholesale arm) could
   * not have one operations manager run both. The only way through was a second
   * account with a second PIN, and the audit trail then shows two people where
   * there is one — which is exactly the thing an audit trail exists to prevent.
   *
   * WHO MAY GRANT: the deployment administrator only.
   *
   * This is a CROSS-TENANT act. An owner's scope is deliberately "every business
   * in this deployment" (that is what makes them an owner), so letting an owner
   * grant would mean the owner of business A could hand out access to business B —
   * two separate legal entities with separate books, which is the one boundary this
   * whole design treats as inviolable. Creating a business is already ADMIN-only
   * for the same reason; reaching into another one stays with it.
   */
  app.get(`${base}/users/:id/business-access`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'ADMIN')) {
      throw new HttpError('Only the deployment administrator can review cross-business access.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const targetId = String(ctx.req.param('id'));
    const target = await db.first('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [targetId]);
    if (!target) throw new HttpError('That user does not exist.', { status: 404, code: 'USER_NOT_FOUND' });

    // EVERY business, with whether this user reaches it and how. Being precise
    // about the "how" matters to the screen: a user reaches their own business by
    // virtue of being on the row, and an administrator reaches all of them by
    // role, so neither needs a grant — offering a checkbox for those would imply
    // that unticking it would take something away.
    const rows = await db.all(`SELECT b.id, b.name, b.profile_code, b.is_active,
          (SELECT uba.id FROM user_business_access uba
             WHERE uba.user_id = ? AND uba.business_id = b.id AND uba.is_deleted = 0 AND uba.revoked_at IS NULL) AS grant_id,
          (SELECT uba.granted_at FROM user_business_access uba
             WHERE uba.user_id = ? AND uba.business_id = b.id AND uba.is_deleted = 0 AND uba.revoked_at IS NULL) AS granted_at
        FROM businesses b WHERE b.is_deleted = 0 ORDER BY b.name`, [targetId, targetId]);

    // WHO ALREADY REACHES EVERYTHING, and it is three kinds of user, not one.
    //
    // `buildScope` (domain/access.js) gives every business to an ADMIN, to an
    // OWNER, and to anyone with no business on their row — `pinnedBusinessId ===
    // null` means nothing is pinned, so nothing is excluded. A grant to any of
    // them is a row that looks meaningful on the screen and changes what they can
    // see by exactly nothing.
    //
    // Only the ADMIN case was refused when this route was written, so the screen
    // offered an owner three live switches that could not take effect. The rule
    // is now stated once, here, and used by both the refusal and the screen.
    const targetRole = String(target.role).toUpperCase();
    const unpinned = target.business_id === null || target.business_id === undefined || target.business_id === '';
    const reachesEverythingBy = targetRole === 'ADMIN' ? 'ROLE:ADMIN'
      : targetRole === 'OWNER' ? 'ROLE:OWNER'
        : unpinned ? 'NO_BUSINESS_PINNED' : null;
    const isAdminTarget = reachesEverythingBy !== null;

    ctx.json({
      ok: true,
      user: { id: target.id, fullName: target.full_name, username: target.username, role: target.role, business_id: target.business_id },
      // An administrator already reaches everything; their own business is already
      // theirs. Both facts are reported rather than left for the screen to guess.
      reachesEverything: isAdminTarget,
      reachesEverythingBy,
      data: rows.map((b) => ({
        id: b.id, name: b.name, profile_code: b.profile_code, is_active: b.is_active,
        own: String(b.id) === String(target.business_id),
        viaGrant: Boolean(b.grant_id),
        grantedAt: b.granted_at,
      })),
    });
  });

  app.post(`${base}/users/:id/business-access`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'ADMIN')) {
      throw new HttpError('Only the deployment administrator can grant access to another business.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const targetId = String(ctx.req.param('id'));
    const target = await db.first('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [targetId]);
    if (!target) throw new HttpError('That user does not exist.', { status: 404, code: 'USER_NOT_FOUND' });

    const body = await ctx.req.json();
    const businessId = String(requireVal(body, 'business_id'));
    const business = await db.first('SELECT * FROM businesses WHERE id = ? AND is_deleted = 0', [businessId]);
    if (!business) throw new HttpError('That business does not exist.', { status: 404, code: 'BUSINESS_NOT_FOUND' });

    // Refused rather than quietly recorded: a grant here would look meaningful on
    // the screen and change nothing, because the scope already covers every
    // business — a row that misleads the next person to read it. Three ways that
    // happens, and the message names the one that applies, because "already
    // reaches every business" is confusing to read about an owner who may believe
    // they are confined to the business on their row.
    const targetRoleNow = String(target.role).toUpperCase();
    const targetUnpinned = target.business_id === null || target.business_id === undefined || target.business_id === '';
    if (targetRoleNow === 'ADMIN') {
      throw new HttpError(`${target.full_name} is the deployment administrator and already reaches every business. There is nothing to grant.`, { status: 409, code: 'ALREADY_REACHES_EVERY_BUSINESS' });
    }
    if (targetRoleNow === 'OWNER') {
      throw new HttpError(`${target.full_name} is an owner, and an owner reaches every business in this deployment. There is nothing to grant.`, { status: 409, code: 'ALREADY_REACHES_EVERY_BUSINESS' });
    }
    if (targetUnpinned) {
      throw new HttpError(`${target.full_name} is not tied to any one business, so they already reach every business. Put them on one first, if that is the intent.`, { status: 409, code: 'ALREADY_REACHES_EVERY_BUSINESS' });
    }
    if (String(businessId) === String(target.business_id)) {
      throw new HttpError(`${target.full_name} already belongs to ${business.name} — it is their own business, not a grant.`, { status: 409, code: 'ALREADY_THEIR_BUSINESS' });
    }

    // ONE ROW PER (user, business) — the table's UNIQUE forbids a second, so a
    // re-grant after a revocation REVIVES the row rather than inserting beside it.
    // `revoked_at` is set on revoke and cleared on grant: a row with a timestamp
    // and is_deleted = 1 is a decision somebody can still read, which is the point
    // of revoking rather than deleting.
    const existing = await db.first('SELECT * FROM user_business_access WHERE user_id = ? AND business_id = ?', [targetId, businessId]);
    const id = existing ? existing.id : newId();
    if (existing) {
      await db.run(`UPDATE user_business_access
          SET is_deleted = 0, revoked_at = NULL, granted_by = ?, granted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`, [String(user.id), id]);
    } else {
      // No `created_at`: this table carries `granted_at` instead — the date the
      // access began is the meaningful one, and a second timestamp saying the same
      // thing is how two columns come to disagree.
      await db.run(`INSERT INTO user_business_access (id, user_id, business_id, granted_by, granted_at, updated_at)
        VALUES (?,?,?,?, datetime('now'), datetime('now'))`, [id, targetId, businessId, String(user.id)]);
    }

    await recordFromCtx(ctx, {
      action: existing ? 'BUSINESS_ACCESS_REGRANTED' : 'BUSINESS_ACCESS_GRANTED',
      entityType: 'USER_BUSINESS_ACCESS', entityId: id, businessId, branchId: target.branch_id,
      after: { user: target.username, userRole: target.role, business: business.name, businessId },
    });
    ctx.json({
      ok: true, id,
      // The scope is resolved from the database on EVERY request (the user row and
      // its grants are re-read per request), so this takes effect on the user's next
      // action rather than at their next sign-in. Saying so removes the "do they
      // need to sign out?" question.
      message: `${target.full_name} can now reach ${business.name} as well. It applies from their next action — they do not need to sign out.`,
    }, existing ? 200 : 201);
  });

  app.delete(`${base}/users/:id/business-access/:businessId`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'ADMIN')) {
      throw new HttpError('Only the deployment administrator can withdraw access to another business.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const targetId = String(ctx.req.param('id'));
    const businessId = String(ctx.req.param('businessId'));
    const target = await db.first('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [targetId]);
    if (!target) throw new HttpError('That user does not exist.', { status: 404, code: 'USER_NOT_FOUND' });

    const grant = await db.first(`SELECT * FROM user_business_access
      WHERE user_id = ? AND business_id = ? AND is_deleted = 0 AND revoked_at IS NULL`, [targetId, businessId]);
    if (!grant) {
      throw new HttpError(`${target.full_name} has no grant for that business — removing nothing would report a change that did not happen.`, { status: 404, code: 'NO_GRANT' });
    }

    // Soft, and stamped. The row survives with the date it was withdrawn, so
    // "who could see the Minna books in March?" stays answerable — the same reason
    // `user_assignment_history` exists for branch moves.
    await db.run("UPDATE user_business_access SET is_deleted = 1, revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [grant.id]);
    const business = await db.first('SELECT name FROM businesses WHERE id = ?', [businessId]);
    await recordFromCtx(ctx, {
      action: 'BUSINESS_ACCESS_REVOKED', entityType: 'USER_BUSINESS_ACCESS', entityId: grant.id,
      businessId, branchId: target.branch_id,
      before: { user: target.username, business: business ? business.name : businessId, grantedAt: grant.granted_at },
    });
    ctx.json({ ok: true, message: `${target.full_name} can no longer reach ${business ? business.name : 'that business'}.` });
  });

  // -------------------------------------------------------------------
  // SETTINGS
  // -------------------------------------------------------------------
  app.get(`${base}/settings`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const settings = ctx.get('settings') || await getSettings(db);
    const user = ctx.get('user');
    ctx.json({
      ok: true, settings,
      defaults: DEFAULT_SETTINGS,
      // Only an owner sees the editable flags with their labels: the screen has
      // to explain what each one does, because "staff_can_adjust_stock" means
      // nothing on its own and a wrong guess is either a blocked counter or an
      // open door to theft.
      featureLabels: atLeast(user.role, 'OWNER') ? FEATURE_LABELS : null,
      featureColumns: atLeast(user.role, 'OWNER') ? FEATURE_COLUMNS : null,
      plan: atLeast(user.role, 'OWNER') ? await planUsage(db, settings) : null,
    });
  });

  /**
   * Update settings. OWNER or above only.
   *
   * EVERY change is audited with its before value, because these flags are the
   * controls. "Who allowed staff to write off stock?" has to be answerable, and
   * the answer is in this log rather than in anybody's memory.
   */
  app.put(`${base}/settings`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) {
      throw new HttpError('Only an owner can change business settings. These flags decide what staff are allowed to do.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const body = await ctx.req.json();
    const before = await getSettings(db);
    const id = before.id || 'default';

    // ------------------------------------------------------------------
    // THE COMMERCIAL SETTINGS ARE NOT THE CLIENTS' TO CHANGE
    // ------------------------------------------------------------------
    // `atLeast(user.role, 'OWNER')` above lets an owner through — correct for the VAT
    // rate, the receipt footer and every staff permission, and wrong for the six
    // settings that decide what the client has bought. With only that guard, an owner
    // could raise their own caps, name their own plan, move their own renewal date
    // and set their own subscription back to ACTIVE after a suspension — with a
    // queued offline write if they preferred. The screen has always drawn these
    // read-only ("commercial: set by the deploy tool and by renewal, not by the
    // client"); hiding a field is not a permission, so the API says no as well.
    const planKeys = Object.keys(body).filter(isPlanField);
    // `isRole(x)` answers "is this a known role", NOT "is this the ADMIN role" — reading
    // it as the latter inverts the guard and lets every owner through, which is the
    // exact defect this check exists to close.
    const isPlatformAdmin = String(user.role).toUpperCase() === String(ROLES.ADMIN).toUpperCase();
    if (planKeys.length && !isPlatformAdmin) {
      throw new HttpError(
        `${planKeys.length === 1 ? 'That is a commercial setting' : 'Those are commercial settings'}: ${planKeys.join(', ')}. `
        + `Your plan is set by ${contactLine(before)}. Nothing was changed.`,
        {
          status: 403,
          code: 'PLATFORM_ADMIN_REQUIRED',
          fields: planKeys.reduce((acc, k) => { acc[k] = 'Set by the platform administrator.'; return acc; }, {}),
        },
      );
    }

    // Which columns may be written. Anything not in DEFAULT_SETTINGS is either
    // computed or belongs to another table, and a mass-assignment of the request
    // body would let a caller set `data_reset_at` or `primary_business_id`.
    const allowed = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'id');

    // A KEY THAT IS NOT A SETTING IS REFUSED, NOT IGNORED.
    //
    // The loop below only looks at keys it knows, so `{ receipt_footer: 'x' }` — the
    // name the Settings screen used for a year while the column was
    // `receipt_footer_text` — was accepted, reported as saved, and did nothing.
    // A caller who misspells a key must be told, because the alternative is an
    // owner who believes they set something. `unknown` is reported in full so the
    // message can name what was actually sent.
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length) {
      throw new HttpError(
        `${unknown.length === 1 ? 'That is not a setting' : 'Those are not settings'}: ${unknown.join(', ')}. Nothing was changed.`,
        {
          status: 400,
          code: 'UNKNOWN_SETTING',
          fields: unknown.reduce((acc, k) => { acc[k] = 'Not a setting on this deployment.'; return acc; }, {}),
        },
      );
    }

    const sets = []; const params = []; const changes = {};
    for (const col of allowed) {
      if (body[col] === undefined) continue;
      const def = DEFAULT_SETTINGS[col];
      let value;
      if (col === 'subscription_status') {
        // A TYPO HERE SUSPENDS THE WHOLE CLIENT. The status is compared by the
        // subscription gate, which blocks everything that is neither ACTIVE nor
        // TRIAL — so `SUSPENDEDD`, or a lower-case `suspended`, would behave exactly
        // like a deliberate suspension, with no error and no way to see why. The
        // four values are the schema's own CHECK constraint.
        const wanted = String(body[col] === undefined ? before[col] : body[col]).trim().toUpperCase();
        if (!SUBSCRIPTION_STATUSES.includes(wanted)) {
          throw new HttpError(
            `"${body[col]}" is not a subscription status. Use one of: ${SUBSCRIPTION_STATUSES.join(', ')}. Nothing was changed.`,
            { status: 400, code: 'INVALID_SUBSCRIPTION_STATUS', fields: { subscription_status: SUBSCRIPTION_STATUSES.join(', ') } },
          );
        }
        value = wanted;
      } else if (col === 'subscription_renewal_date') {
        // Empty means "no date agreed", which is how the schema stores it — not the
        // empty string, which would print as a blank where the plan screen shows the
        // renewal date and would sort after every real date.
        const raw = body[col] === undefined ? before[col] : body[col];
        const text = raw === null || raw === undefined ? '' : String(raw).trim();
        if (text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          throw new HttpError(
            `"${text}" is not a date. Renewal dates are stored as YYYY-MM-DD (for example 2026-12-31), or send an empty value for none. Nothing was changed.`,
            { status: 400, code: 'INVALID_DATE', fields: { subscription_renewal_date: 'YYYY-MM-DD, or empty' } },
          );
        }
        value = text || null;
      } else if (col === 'subscription_plan') {
        // The plan name is PRINTED — every cap refusal says "Your <plan> plan
        // includes…" — so a blank one produces a message with a hole in it.
        const text = strField(body[col] === undefined ? before[col] : body[col], { field: 'subscription plan', maxLength: 60 });
        if (!String(text || '').trim()) {
          throw new HttpError('A plan needs a name. It is printed in the refusal a client sees when they reach a limit. Nothing was changed.', { status: 400, code: 'PLAN_NAME_REQUIRED', fields: { subscription_plan: 'A name, up to 60 characters.' } });
        }
        value = text;
      } else if (typeof def === 'number') {
        // A FLAG IS NAMED, NOT INFERRED FROM ITS DEFAULT.
        //
        // This read `[0, 1].includes(def)` — "the default is zero or one, so it must
        // be a boolean" — which is true of a flag and false of any number whose
        // sensible default is zero. `credit_grace_days: 30` and `staff_credit_max:
        // 25000` are both numbers, both default to 0, and both were therefore handed
        // to `boolField`, which does not recognise `30` as a boolean, returned the
        // fallback, and SAVED ZERO with a success message. See FLAG_SETTINGS.
        value = FLAG_SETTINGS.has(col)
          ? boolField(body[col], def)
          : numField(body[col], { field: col.replace(/_/g, ' '), min: 0, max: 1000000 });
      } else {
        value = strField(body[col], { field: col.replace(/_/g, ' '), maxLength: 2000 });
      }
      sets.push(`${col} = ?`); params.push(value);
      if (String(before[col]) !== String(value)) changes[col] = { from: before[col], to: value };
    }
    if (!sets.length) throw new HttpError('Nothing to change. Send the settings you want to update.', { status: 400, code: 'NO_CHANGES' });

    // Coherence checks between flags. Turning one on while another contradicts it
    // produces a system that behaves unpredictably, so the contradiction is
    // refused at the point it is created rather than discovered at the counter.
    if (boolField(body.staff_can_void_sales ?? before.staff_can_void_sales)) {
      const window = numField(body.staff_void_window_minutes ?? before.staff_void_window_minutes, { field: 'Void window', min: 0, max: 1440, whole: true });
      if (window === 0) {
        throw new HttpError('Staff voiding is enabled but the window is 0 minutes, which means staff can never void. Set a window (15-30 minutes is usual) or turn the permission off.', { status: 400, code: 'CONTRADICTORY_SETTINGS' });
      }
    }
    if (boolField(body.staff_can_sell_on_credit ?? before.staff_can_sell_on_credit)) {
      const cap = numField(body.staff_credit_max ?? before.staff_credit_max, { field: 'Staff credit cap', min: 0 });
      if (cap === 0) {
        throw new HttpError('Staff may sell on credit but their cap is ₦0, so they can never actually do it. Set a cap or turn the permission off.', { status: 400, code: 'CONTRADICTORY_SETTINGS' });
      }
    }
    if (boolField(body.staff_can_adjust_stock ?? before.staff_can_adjust_stock)) {
      const units = numField(body.staff_adjustment_max_units ?? before.staff_adjustment_max_units, { field: 'Staff adjustment cap', min: 0, whole: true });
      if (units === 0) throw new HttpError('Staff may adjust stock but their cap is 0 units, so they can never do it. Set a cap or turn the permission off.', { status: 400, code: 'CONTRADICTORY_SETTINGS' });
    }
    const vatOn = boolField(body.vat_enabled ?? before.vat_enabled);
    if (vatOn) {
      const rate = numField(body.vat_rate_percent ?? before.vat_rate_percent, { field: 'VAT rate', min: 0, max: 100 });
      if (rate === 0) throw new HttpError('VAT is enabled but the rate is 0%. Set the rate (7.5% is the standard Nigerian rate) or turn VAT off.', { status: 400, code: 'CONTRADICTORY_SETTINGS' });
      if (rate !== 7.5) ctx.set('vatWarning', `The VAT rate is set to ${rate}%. Nigeria's standard rate is 7.5% — if this is not a deliberate exemption or a special rate, check it before the next return is filed.`);
    }

    // The compliance window cannot exceed what the schema can see.
    //
    // `compliance_alert_days` is honoured by /api/compliance/alerts, which reads
    // `v_compliance_expiry_alerts` — and that view stops at 90 days, in SQL. A
    // number larger than the horizon would be accepted here and then silently
    // deliver less than it promised, which is worse than refusing it: an operator
    // who sets 180 days and is shown 90 has no way to tell whether the application
    // is ignoring them or there is genuinely nothing expiring.
    const complianceWindow = numField(body.compliance_alert_days ?? before.compliance_alert_days, { field: 'Compliance alert window', min: 1, max: 365, whole: true });
    if (complianceWindow > ALERT_HORIZON_DAYS) {
      throw new HttpError(`Expiry alerts can look ${ALERT_HORIZON_DAYS} days ahead at most, and you asked for ${complianceWindow}. The expiry view the alert list reads stops at a quarter's notice.`, { status: 400, code: 'BEYOND_ALERT_HORIZON', fields: { compliance_alert_days: `${ALERT_HORIZON_DAYS} days at most.` } });
    }

    // A CAP BELOW WHAT IS ALREADY IN USE IS ALLOWED AND SAID OUT LOUD.
    // Repeating it would be right for a client who has outgrown a plan, and refusing
    // it would leave the operator stuck between two plans. But setting 2 branches on a
    // shop that has 4 does not remove any of them — it silently stops the fifth ever
    // being opened, and the next person to try reads "all 4 are in use" beside a cap
    // they never chose. So it is done, and it is reported.
    const capWarnings = [];
    const planChanges = Object.keys(changes).filter(isPlanField);
    for (const [key, counted] of [['max_branches', activeBranchCount], ['max_staff', activeStaffCount], ['max_businesses', activeBusinessCount]]) {
      if (!(key in changes)) continue;
      const max = capValue({ [key]: changes[key].to }, key);
      if (max === Infinity) continue;
      const used = await counted(db);
      if (used > max) {
        const noun = { max_branches: 'branch(es)', max_staff: 'staff seat(s)', max_businesses: 'business(es)' }[key];
        capWarnings.push(`${key.replace(/_/g, ' ')} is now ${max}, and ${used} ${noun} are already in use. Nothing is removed — but no more can be created until one is deactivated or the cap is raised, and the client will be shown "all ${used} are in use" against a limit of ${max}.`);
      }
    }

    sets.push('updated_at = datetime(\'now\')', 'updated_by = ?');
    params.push(String(user.id), id);
    await db.run(`UPDATE client_settings SET ${sets.join(', ')} WHERE id = ?`, params);

    // PLAN_LIMITS_CHANGED was an allowed audit action that nothing ever recorded —
    // the write path it was named for did not exist. Now that the plan is editable,
    // "who lowered this client's staff cap" is a question the trail answers directly
    // instead of hiding inside a generic SETTINGS_UPDATED.
    await recordFromCtx(ctx, {
      // NOTE: `recordFromCtx` takes exactly { action, entityType, entityId, before, after,
      // branchId, businessId } and SILENTLY DROPS anything else — an earlier version of
      // this call passed `metadata` and it was discarded without a word. The fields that
      // changed are the keys of before/after; the plan ones are the ones in `after` whose
      // names are in PLAN_FIELDS, so nothing extra is needed to find them.
      action: planChanges.length ? 'PLAN_LIMITS_CHANGED' : 'SETTINGS_UPDATED',
      entityType: 'SETTINGS', entityId: id,
      before: Object.fromEntries(Object.keys(changes).map((k) => [k, changes[k].from])),
      after: Object.fromEntries(Object.keys(changes).map((k) => [k, changes[k].to])),
    });

    const described = Object.entries(changes).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.from} → ${v.to}`);
    ctx.json({
      ok: true, changes,
      settings: await getSettings(db),
      message: described.length ? `${described.length} setting(s) changed — ${described.join('; ')}.` : 'No settings actually changed.',
      warnings: [ctx.get('vatWarning'), ...capWarnings].filter(Boolean),
    });
  });

  // -------------------------------------------------------------------
  // PLAN / SUBSCRIPTION
  // -------------------------------------------------------------------
  app.get(`${base}/plan`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only an owner can see the subscription position.', { status: 403, code: 'ROLE_REQUIRED' });
    const settings = ctx.get('settings') || await getSettings(db);
    const usage = await planUsage(db, settings);
    ctx.json({
      ok: true, settings: {
        plan: settings.subscription_plan, status: settings.subscription_status,
        renewalDate: settings.subscription_renewal_date,
        maxBusinesses: settings.max_businesses, maxBranches: settings.max_branches, maxStaff: settings.max_staff,
      },
      usage,
      // FEATURE_COLUMNS is a frozen feature-key -> column-name map, not a list.
      // Iterate its ENTRIES: the key is what the UI toggles, the value is the
      // column the flag actually lives in.
      features: Object.fromEntries(Object.entries(FEATURE_COLUMNS).map(([key, column]) => [
        key, { enabled: Boolean(Number(settings[column])), label: FEATURE_LABELS[key] || key.replace(/_/g, ' ') },
      ])),
      // Counted live, and counting ONLY is_active = 1. Including deactivated
      // rows would charge a customer for staff who have left and block them from
      // hiring a replacement.
      counts: {
        businesses: await activeBusinessCount(db),
        branches: await activeBranchCount(db),
        staff: await activeStaffCount(db),
      },
    });
  });

  // -------------------------------------------------------------------
  // AUDIT TRAIL
  // -------------------------------------------------------------------
  /**
   * The audit log.
   *
   * Read-only by design: there is no endpoint anywhere that updates or deletes an
   * audit row. It is also hash-chained (prev_hash/row_hash), so removing a row in
   * the middle breaks every subsequent link — which is what makes "the log is
   * complete" a claim that can be checked rather than believed.
   */
  app.get(`${base}/audit`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can read the audit trail.', { status: 403, code: 'ROLE_REQUIRED' });
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 7 });
    const where = ["date(a.created_at, '+1 hours') BETWEEN ? AND ?"];
    const params = [from, to];
    if (!scope.allBusinesses && scope.businessIds) {
      const ids = [...scope.businessIds];
      where.push(`(a.business_id IS NULL OR a.business_id IN (${ids.map(() => '?').join(',')}))`); params.push(...ids);
    }
    if (!scope.allBranches && scope.branchIds) {
      const ids = [...scope.branchIds];
      where.push(`(a.branch_id IS NULL OR a.branch_id IN (${ids.map(() => '?').join(',')}))`); params.push(...ids);
    }
    const action = ctx.req.queryParam('action');
    if (action) { where.push('a.action = ?'); params.push(String(action).toUpperCase()); }
    const userId = ctx.req.queryParam('user_id');
    if (userId) { where.push('a.user_id = ?'); params.push(String(userId)); }
    const entityType = ctx.req.queryParam('entity_type');
    if (entityType) { where.push('a.entity_type = ?'); params.push(String(entityType).toUpperCase()); }
    const entityId = ctx.req.queryParam('entity_id');
    if (entityId) { where.push('a.entity_id = ?'); params.push(String(entityId)); }
    const search = searchTerm(ctx);
    if (search) { where.push('(a.username LIKE ? OR a.action LIKE ? OR a.entity_type LIKE ?)'); const l = `%${search}%`; params.push(l, l, l); }
    const whereSql = where.join(' AND ');

    const rows = await db.all(`SELECT a.*, b.name AS branch_name, biz.name AS business_name
        FROM audit_log a
        LEFT JOIN branches b ON b.id = a.branch_id
        LEFT JOIN businesses biz ON biz.id = a.business_id
        WHERE ${whereSql} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM audit_log a WHERE ${whereSql}`, params);
    const actions = await db.all(`SELECT a.action, COUNT(*) AS count FROM audit_log a
        WHERE ${whereSql} GROUP BY a.action ORDER BY count DESC LIMIT 40`, params);

    ctx.json({
      ...listResponse(rows, { limit, offset }, total),
      range: { from, to }, actions,
      chainVerified: null,
      note: 'Audit rows cannot be edited or deleted through this API. Each row carries the hash of the one before it, so removing a row breaks every link after it.',
    });
  });

  /**
   * Verify the audit hash chain end to end.
   *
   * Delegated to `audit.verifyAuditChain`, which reconstructs each row's hash
   * from the SAME field list the writer used. Re-deriving the field order here
   * would produce a verifier that disagrees with the writer, and a verifier that
   * always reports "intact" is worse than no verifier at all.
   */
  app.get(`${base}/audit/verify`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only an owner can verify the audit chain.', { status: 403, code: 'ROLE_REQUIRED' });
    const result = await verifyAuditChain(db);
    const ok = Boolean(result && result.ok !== false && !(result.breaks && result.breaks.length));
    ctx.json({
      ok,
      ...result,
      message: ok
        ? `The audit chain is intact across ${result.rows || result.count || 'all'} row(s). No entry has been removed or altered since it was written.`
        : `THE AUDIT CHAIN IS BROKEN. ${(result.breaks || []).length} row(s) do not link to the one before them, which means entries have been removed or edited directly in the database.${result.breaks && result.breaks[0] ? ` First break: ${JSON.stringify(result.breaks[0]).slice(0, 200)}` : ''}`,
    }, ok ? 200 : 500);
  });

  /** Anchor the chain: publish its head hash so a later break is provable. */
  app.post(`${base}/audit/anchor`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only an owner can anchor the audit chain.', { status: 403, code: 'ROLE_REQUIRED' });
    const result = await anchorAudit(db);
    await recordFromCtx(ctx, { action: 'AUDIT_CHAIN_ANCHORED', entityType: 'AUDIT_LOG', after: result });
    ctx.json({
      ok: true, ...result,
      message: 'The chain head has been anchored. Record this hash somewhere outside the database — it is the reference that proves whether the log was complete at this moment.',
    });
  });

  // -------------------------------------------------------------------
  // VERTICAL PROFILES
  // -------------------------------------------------------------------
  app.get(`${base}/profiles`, (ctx) => {
    ctx.json({
      ok: true,
      data: PROFILE_CODES.map((code) => profileSummary({ profile_code: code })),
      note: 'A business\'s profile decides its categories, unit ladders, compliance requirements and warranty rules. It is chosen at creation and locked once products exist.',
    });
  });

  // -------------------------------------------------------------------
  // NOTIFICATIONS
  // -------------------------------------------------------------------
  app.get(`${base}/notifications`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const { limit, offset } = pagination(ctx);
    const unreadOnly = boolField(ctx.req.queryParam('unread'));
    const scope = ctx.get('scope');

    // A notification is for its user, or a broadcast to whoever reaches the branch
    // or business it is about. WIDENING BEYOND THAT would show one branch's stock
    // alerts to another, so the broadcast half is filtered by the caller's SCOPE.
    //
    // IT USED TO BE FILTERED BY `user.branch_id` INSTEAD, with the literal string
    // '__none__' standing in for a user who has no branch — which is every OWNER
    // and every ADMIN. So an owner matched neither the "addressed to me" half nor
    // the "at my branch" half and saw an EMPTY list, while the branch manager saw
    // their own shop's alerts and nothing else. Nobody noticed, because nothing in
    // the application produced a notification: the bell was empty for a second
    // reason. Stage 11 gave the table a producer, and the first alert raised for a
    // branch was invisible to the one person whose job it is to renew licences.
    //
    // The scope already knows who reaches what — an owner reaches every branch —
    // so it is the right answer here, as it is everywhere else.
    const broadcast = scopeFilter(scope, { alias: 'n' });
    const audience = broadcast.sql
      ? `(n.user_id = ? OR (n.user_id IS NULL AND (${broadcast.sql})))`
      : '(n.user_id = ? OR n.user_id IS NULL)';
    const audienceParams = [String(user.id), ...broadcast.params];

    const rows = await db.all(`SELECT n.*, b.name AS branch_name FROM notifications n
        LEFT JOIN branches b ON b.id = n.branch_id
        WHERE n.is_deleted = 0
          AND ${audience}
          ${unreadOnly ? 'AND n.is_read = 0' : ''}
        ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
    [...audienceParams, limit, offset]);
    const unread = await db.scalar(`SELECT COUNT(*) FROM notifications n WHERE n.is_deleted = 0 AND n.is_read = 0
        AND ${audience}`, audienceParams);
    ctx.json({ ...listResponse(rows, { limit, offset }), unread: Number(unread) || 0 });
  });

  app.post(`${base}/notifications/:id/read`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const n = await db.first('SELECT * FROM notifications WHERE id = ? AND is_deleted = 0', [id]);
    if (!n) throw new HttpError('That notification does not exist.', { status: 404, code: 'NOTIFICATION_NOT_FOUND' });
    if (n.user_id && String(n.user_id) !== String(user.id)) throw new HttpError('That notification is for somebody else.', { status: 403, code: 'NOT_YOURS' });
    await db.run("UPDATE notifications SET is_read = 1, read_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [id]);
    ctx.json({ ok: true });
  });

  /**
   * MARK EVERYTHING THIS USER CAN SEE AS READ — the same set the list shows.
   *
   * This used to scope the broadcast half by the caller's OWN `branch_id`, exactly the
   * defect the list route's comment records: an OWNER and an ADMIN have no branch, so
   * the predicate matched only rows with `branch_id IS NULL` and **"mark all read"
   * marked nothing at all for the two seats most likely to press it** — while the list
   * beside it, which had already been fixed to use the scope, showed them plenty. A
   * multi-branch manager got the same thing in miniature: read-all marked their own
   * branch and left the rest unread forever.
   *
   * The audience is now IDENTICAL to the list route's, built from the same
   * `scopeFilter`, because the only thing worse than a "mark all read" that misses rows
   * is one that disagrees with the screen it is sitting on.
   */
  app.post(`${base}/notifications/read-all`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');
    const broadcast = scopeFilter(scope, { alias: 'notifications' });
    const audience = broadcast.sql
      ? `(user_id = ? OR (user_id IS NULL AND (${broadcast.sql})))`
      : '(user_id = ? OR user_id IS NULL)';
    const res = await db.run(`UPDATE notifications SET is_read = 1, read_at = datetime('now'), updated_at = datetime('now')
        WHERE is_deleted = 0 AND is_read = 0 AND ${audience}`,
    [String(user.id), ...broadcast.params]);
    const remaining = await db.scalar(`SELECT COUNT(*) FROM notifications WHERE is_deleted = 0 AND is_read = 0 AND ${audience}`,
      [String(user.id), ...broadcast.params]);
    ctx.json({
      ok: true,
      marked: res.changes,
      unread: Number(remaining) || 0,
      message: res.changes
        ? `${res.changes} notification(s) marked read.`
        : 'Nothing was unread.',
    });
  });
}

function profileSummary(row) {
  const code = row.profile_code || 'GENERAL_RETAIL';
  let profile = null;
  try { profile = resolveProfile(code, row.profile_overrides_json ? JSON.parse(row.profile_overrides_json) : null); } catch (e) { profile = getProfileOrDefault(code); }
  return {
    // A SYNTHETIC ROW — one built from a profile code alone, as the vertical list builds them —
    // has no business name, and the profile's own label is the name that list is for. Without
    // this, `/api/profiles` answered four rows whose `name` was undefined while the label sat
    // one level down inside `profile`.
    id: row.id, name: row.name || (profile ? profile.label : code), profile_code: code,
    profile: profile ? { label: profile.label, description: profile.description, features: profile.features } : null,
    is_active: row.is_active,
  };
}

function requireVal(body, field) {
  const v = body[field];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new HttpError(`${field.replace(/_/g, ' ')} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: 'Required' } });
  }
  return v;
}

module.exports = { mount };
