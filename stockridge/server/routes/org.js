// =====================================================================
// StockRidge — ORGANISATION ROUTES: branches, users, devices, certificates
// =====================================================================

const { createRouter, HttpError } = require('../lib/http');
const V = require('../../shared/validation');
const { newId, hashPin, watNowIso, watDate, addMonths } = require('../../shared/ids');
const { writeAudit } = require('../lib/audit');
const { ROLES, assertRole, outranks, jobTitleOf, managerKindOf, assertBranchAccess, resolveScopedBranchId } = require('../lib/roles');
const { assertCanCreateBranch, assertCanCreateUser, getUnitSettings, staffAllowance, planSummary } = require('../lib/planLimits');
const authService = require('../lib/auth');
const { normaliseState, NIGERIAN_STATES, suggestRadiusMeters } = require('../lib/geo');
const { capabilitiesOf, assertCapability } = require('../lib/capabilities');

// ---------------------------------------------------------------------
// BRANCHES
// ---------------------------------------------------------------------
function branchRoutes(getDb) {
  const app = createRouter();
  const BRANCH_TYPES = ['RETAIL', 'WHOLESALE', 'BOTH', 'WAREHOUSE', 'SHOWROOM', 'WORKSHOP', 'YARD'];
  const ATTENDANCE_MODES = ['GEOLOCATION', 'REGISTERED_DEVICE'];

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const where = ['b.is_deleted = 0', 'b.business_unit_id = ?'];
    const params = [c.var.businessUnitId];
    if (scoped) { where.push('b.id = ?'); params.push(scoped); }
    if (c.req.query('include_inactive') !== '1') where.push('b.is_active = 1');

    const rows = await db.prepare(`
      SELECT b.*,
        (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.is_deleted = 0 AND u.is_active = 1) AS staff_count,
        COALESCE((SELECT SUM(sb.quantity_remaining * sb.unit_cost) FROM stock_batches sb WHERE sb.branch_id = b.id AND sb.is_deleted = 0),0) AS stock_value_at_cost,
        (SELECT COALESCE(SUM(sl.amount),0) FROM branch_safe_ledger sl WHERE sl.branch_id = b.id AND sl.is_deleted = 0) AS safe_balance,
        (SELECT session_no FROM till_sessions t WHERE t.branch_id = b.id AND t.status = 'OPEN' AND t.is_deleted = 0 LIMIT 1) AS open_till,
        (SELECT COUNT(*) FROM stocktake_sessions st WHERE st.branch_id = b.id AND st.status IN ('OPEN','COUNTING','REVIEW') AND st.is_deleted = 0) AS open_stocktakes
      FROM branches b WHERE ${where.join(' AND ')}
      ORDER BY b.is_main DESC, b.name ASC
    `).bind(...params).all();

    return c.json({
      results: rows.results.map((b) => ({
        ...b,
        stock_value_at_cost: Math.round(Number(b.stock_value_at_cost) * 100) / 100,
        safe_balance: Math.round(Number(b.safe_balance) * 100) / 100,
        geofence_configured: b.latitude != null && b.longitude != null,
        // The job title is DERIVED from branch_id, never stored — see roles.js.
        your_access: c.var.user.branch_id ? (c.var.user.branch_id === b.id ? 'OWN_BRANCH' : 'NONE') : 'ALL',
      })),
      states: NIGERIAN_STATES,
    });
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const b = await db.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!b) throw new HttpError(404, 'That branch was not found.', 'BRANCH_NOT_FOUND');
    if (b.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That branch belongs to a different business.', 'BRANCH_WRONG_BUSINESS');
    assertBranchAccess(c.var.user, b.id);

    const [staff, devices, certificates, shifts, attendanceSamples] = await Promise.all([
      db.prepare(`SELECT id, full_name, username, role, job_title, branch_id, phone, is_active, last_login_at
                  FROM users WHERE branch_id = ? AND is_deleted = 0 ORDER BY role DESC, full_name`).bind(b.id).all(),
      db.prepare(`SELECT bd.*, u.full_name AS registered_by_name FROM branch_devices bd
                  LEFT JOIN users u ON u.id = bd.registered_by
                  WHERE bd.branch_id = ? AND bd.is_deleted = 0 AND bd.revoked_at IS NULL`).bind(b.id).all(),
      db.prepare(`SELECT * FROM branch_certificates WHERE (branch_id = ? OR branch_id IS NULL) AND business_unit_id = ? AND is_deleted = 0
                  ORDER BY expiry_date`).bind(b.id, c.var.businessUnitId).all(),
      db.prepare('SELECT * FROM branch_shifts WHERE branch_id = ? AND is_deleted = 0 ORDER BY start_time').bind(b.id).all(),
      db.prepare(`SELECT in_distance_meters FROM staff_attendance
                  WHERE branch_id = ? AND in_distance_meters IS NOT NULL AND is_deleted = 0
                  ORDER BY clock_in_at DESC LIMIT 100`).bind(b.id).all(),
    ]);

    return c.json({
      ...b,
      geofence_configured: b.latitude != null && b.longitude != null,
      staff: staff.results.map((u) => ({ ...u, job_title: jobTitleOf(u) })),
      devices: devices.results,
      certificates: certificates.results,
      shifts: shifts.results,
      // A suggested radius from observed clock-ins beats a manager guessing.
      // Uses the 90th percentile plus a floor: the median would place the fence
      // inside the shop and flag half the honest staff.
      geofence_suggestion: attendanceSamples.results.length >= 5
        ? { radius_meters: suggestRadiusMeters(attendanceSamples.results.map((r) => r.in_distance_meters)), samples: attendanceSamples.results.length }
        : null,
    });
  });

  app.post('/', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'add a branch' });
    const db = getDb();
    const body = await c.req.json();
    await assertCanCreateBranch(db, c.var.businessUnitId, c.var.user);

    const name = V.required(body.name, { field: 'Branch name', max: V.LIMITS.NAME });
    if (name && name.error) throw new HttpError(400, name.error, 'VALIDATION_FAILED');
    const code = V.required(String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''), { field: 'Branch code', max: 10 });
    if (code && code.error) throw new HttpError(400, code.error, 'VALIDATION_FAILED');
    if (code.length < 2) throw new HttpError(400, 'The branch code must be at least 2 characters — it appears on every receipt number from this branch.', 'BRANCH_CODE_TOO_SHORT');

    const clash = await db.prepare('SELECT name FROM branches WHERE business_unit_id = ? AND code = ? AND is_deleted = 0').bind(c.var.businessUnitId, code).first();
    if (clash) throw new HttpError(409, `Branch code ${code} is already used by "${clash.name}".`, 'BRANCH_CODE_EXISTS');

    const type = V.oneOf(body.branch_type || 'RETAIL', BRANCH_TYPES, { field: 'Branch type' });
    if (type && type.error) throw new HttpError(400, type.error, 'VALIDATION_FAILED');
    const mode = V.oneOf(body.attendance_mode || 'GEOLOCATION', ATTENDANCE_MODES, { field: 'Attendance mode' });
    if (mode && mode.error) throw new HttpError(400, mode.error, 'VALIDATION_FAILED');

    let coords = null;
    if (body.latitude != null || body.longitude != null) {
      coords = V.coordinates(body.latitude, body.longitude, { optional: false });
      if (coords && coords.error) throw new HttpError(400, coords.error, 'VALIDATION_FAILED');
    }
    const radius = Math.min(2000, Math.max(20, Number(body.geofence_radius_meters) || 100));

    const ts = watNowIso();
    const id = newId();
    const isFirst = (await db.prepare('SELECT COUNT(*) AS n FROM branches WHERE business_unit_id = ? AND is_deleted = 0').bind(c.var.businessUnitId).first()).n === 0;

    await db.prepare(`
      INSERT INTO branches (
        id, business_unit_id, code, name, branch_type, address, state, lga, city, phone, email, manager_name,
        latitude, longitude, geofence_radius_meters, attendance_mode, is_main, is_active, opening_date,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?, date('now','+1 hour'),?,?)
    `).bind(
      id, c.var.businessUnitId, code, name, type,
      body.address ? String(body.address).slice(0, V.LIMITS.ADDRESS) : null,
      body.state ? normaliseState(body.state) : null,
      body.lga ? String(body.lga).slice(0, 120) : null,
      body.city ? String(body.city).slice(0, 120) : null,
      body.phone ? (V.phone(body.phone, { field: 'Phone' }).international || null) : null,
      body.email ? (V.email(body.email, { field: 'Email' }) || null) : null,
      body.manager_name ? String(body.manager_name).slice(0, 160) : null,
      coords ? coords.latitude : null, coords ? coords.longitude : null, radius, mode,
      isFirst || body.is_main ? 1 : 0, 1, ts, ts
    ).run();

    // Register the requesting device to the new branch when it uses device
    // attendance — otherwise the manager who just created it cannot clock in.
    if (mode === 'REGISTERED_DEVICE' && c.var.deviceId) {
      await db.prepare(`
        INSERT INTO branch_devices (id, branch_id, business_unit_id, device_id, label, device_type, registered_by, registered_at, updated_at)
        VALUES (?,?,?,?,?, 'BACK_OFFICE',?,?,?)
      `).bind(newId(), id, c.var.businessUnitId, String(c.var.deviceId).slice(0, 120),
        'Registered on branch creation', c.var.user.id, ts, ts).run();
    }

    // A new branch gets the expense categories and chart of accounts so its
    // first sale and first expense can post without a setup step.
    await require('../services/expenseService').seedCategories(db, c.var.businessUnitId);
    await require('../services/glService').ensureChart(db, c.var.businessUnitId);

    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId: id, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'BRANCH_CREATED', entityType: 'BRANCH', entityId: id,
      after: { name, code, branch_type: type, attendance_mode: mode, geofence: coords ? `${coords.latitude},${coords.longitude}` : null },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, id, code, name, is_main: isFirst, advisory: coords ? null : 'No GPS position was set, so attendance clock-ins at this branch will be flagged as NO_LOCATION until you add one under Branches.' }, 201);
  });

  app.put('/:id', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'edit a branch' });
    const db = getDb();
    const id = c.req.param('id');
    const b = await db.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!b) throw new HttpError(404, 'That branch was not found.', 'BRANCH_NOT_FOUND');
    if (b.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That branch belongs to a different business.', 'BRANCH_WRONG_BUSINESS');
    assertBranchAccess(c.var.user, id);
    // A Branch Manager may edit their own branch's contact details but not its
    // identity or its attendance policy — those are the controls that make
    // their own attendance records trustworthy.
    const isOwnBranchManager = c.var.user.role === 'MANAGER' && c.var.user.branch_id === id;

    const body = await c.req.json();
    const patch = {};
    const before = {};
    const record = (k, v) => { if (String(b[k] ?? '') !== String(v ?? '')) { before[k] = b[k]; patch[k] = v; } };

    const contactFields = ['name', 'address', 'city', 'lga', 'manager_name', 'email'];
    for (const k of contactFields) {
      if (body[k] === undefined) continue;
      record(k, body[k] == null ? null : String(body[k]).trim().slice(0, 400) || null);
    }
    if (body.phone !== undefined) {
      const p = body.phone ? V.phone(body.phone, { field: 'Phone' }) : null;
      if (p && p.error) throw new HttpError(400, p.error, 'VALIDATION_FAILED');
      record('phone', p ? p.international : null);
    }
    if (body.state !== undefined) record('state', body.state ? normaliseState(body.state) : null);

    if (!isOwnBranchManager) {
      if (body.code !== undefined) {
        const code = String(body.code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length < 2) throw new HttpError(400, 'The branch code must be at least 2 characters.', 'BRANCH_CODE_TOO_SHORT');
        if (code !== b.code) {
          const clash = await db.prepare('SELECT name FROM branches WHERE business_unit_id = ? AND code = ? AND is_deleted = 0 AND id <> ?').bind(c.var.businessUnitId, code, id).first();
          if (clash) throw new HttpError(409, `Branch code ${code} is already used by "${clash.name}".`, 'BRANCH_CODE_EXISTS');
          // Changing the code changes every FUTURE receipt number from this
          // branch. Existing receipts keep their numbers, so historical
          // references still resolve — but say so, because it is surprising.
          record('code', code);
        }
      }
      if (body.branch_type !== undefined) {
        const t = V.oneOf(body.branch_type, BRANCH_TYPES, { field: 'Branch type' });
        if (t && t.error) throw new HttpError(400, t.error, 'VALIDATION_FAILED');
        record('branch_type', t);
      }
      if (body.attendance_mode !== undefined) {
        const m = V.oneOf(body.attendance_mode, ATTENDANCE_MODES, { field: 'Attendance mode' });
        if (m && m.error) throw new HttpError(400, m.error, 'VALIDATION_FAILED');
        record('attendance_mode', m);
      }
      if (body.latitude !== undefined || body.longitude !== undefined) {
        const coords = V.coordinates(body.latitude !== undefined ? body.latitude : b.latitude,
          body.longitude !== undefined ? body.longitude : b.longitude, { optional: true });
        if (coords && coords.error) throw new HttpError(400, coords.error, 'VALIDATION_FAILED');
        record('latitude', coords ? coords.latitude : null);
        record('longitude', coords ? coords.longitude : null);
      }
      if (body.geofence_radius_meters !== undefined) {
        record('geofence_radius_meters', Math.min(2000, Math.max(20, Number(body.geofence_radius_meters) || 100)));
      }
      if (body.is_main !== undefined) record('is_main', body.is_main ? 1 : 0);
      if (body.is_active !== undefined) {
        const active = body.is_active ? 1 : 0;
        if (!active) {
          // DEACTIVATING frees a paid branch slot — see planLimits BUG 85. But
          // it must not silently strand an open till or an open stocktake.
          const openTill = await db.prepare(`SELECT session_no FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0`).bind(id).first();
          if (openTill) {
            throw new HttpError(409, `Till ${openTill.session_no} is still open at this branch. Close it before deactivating — an open till at a closed branch is a cash figure nobody will ever reconcile.`, 'BRANCH_HAS_OPEN_TILL');
          }
          const openCount = await db.prepare(`SELECT reference FROM stocktake_sessions WHERE branch_id = ? AND status IN ('OPEN','COUNTING','REVIEW') AND is_deleted = 0`).bind(id).first();
          if (openCount) {
            throw new HttpError(409, `Stocktake ${openCount.reference} is still open at this branch. Commit or cancel it first.`, 'BRANCH_HAS_OPEN_STOCKTAKE');
          }
          const activeStaff = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE branch_id = ? AND is_active = 1 AND is_deleted = 0`).bind(id).first();
          if (activeStaff.n > 0) {
            throw new HttpError(409, `${activeStaff.n} active staff member(s) are attached to this branch. Move them to another branch or deactivate them first — otherwise they are pinned to a branch that cannot trade.`, 'BRANCH_HAS_ACTIVE_STAFF');
          }
        }
        record('is_active', active);
      }
    }

    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0, message: 'Nothing to change.' });
    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    await db.prepare(`UPDATE branches SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((k) => patch[k]), id).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId: id, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'BRANCH_UPDATED', entityType: 'BRANCH', entityId: id, before, after: patch,
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, changed: cols.length });
  });

  // Devices for REGISTERED_DEVICE attendance.
  app.get('/:id/devices', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    assertBranchAccess(c.var.user, id);
    const rows = await require('../services/attendanceService').listDevices(db, {
      businessUnitId: c.var.businessUnitId, branchId: id, includeRevoked: c.req.query('include_revoked') === '1',
    });
    return c.json({ results: rows });
  });

  app.post('/:id/devices', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const result = await require('../services/attendanceService').registerDevice(db, c.serviceCtx, {
      branchId: c.req.param('id'), deviceId: body.device_id || c.var.deviceId,
      label: body.label, deviceType: body.device_type,
    });
    return c.json(result, 201);
  });

  app.delete('/:id/devices/:deviceId', async (c) => {
    const db = getDb();
    const body = await c.req.json().catch(() => ({}));
    return c.json(await require('../services/attendanceService').revokeDevice(db, c.serviceCtx, {
      deviceRowId: c.req.param('deviceId'), reason: body.reason,
    }));
  });

  return app;
}

// ---------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------
function userRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const role = c.var.user.role;
    // ADMIN (the vendor seat) is hidden from the client's own Users screen:
    // it is not their staff and it does not count against their staff limit.
    const where = ['u.is_deleted = 0', 'u.business_unit_id = ?', "u.role <> 'ADMIN'"];
    const params = [c.var.businessUnitId];
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    if (scoped) { where.push('(u.branch_id = ? OR u.branch_id IS NULL)'); params.push(scoped); }
    if (c.req.query('role')) { where.push('u.role = ?'); params.push(String(c.req.query('role')).toUpperCase()); }
    if (c.req.query('search')) {
      const like = `%${String(c.req.query('search')).trim().replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
      where.push(`(u.full_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }
    if (c.req.query('include_inactive') !== '1') where.push('u.is_active = 1');

    const rows = await db.prepare(`
      SELECT u.id, u.full_name, u.username, u.role, u.job_title, u.branch_id, b.name AS branch_name,
             u.phone, u.email, u.is_active, u.must_change_pin, u.last_login_at, u.hired_at, u.exited_at,
             u.created_at, c.full_name AS created_by_name,
             COALESCE((SELECT COUNT(*) FROM sales s WHERE s.sold_by = u.id AND s.is_deleted = 0
                       AND date(s.occurred_at,'+1 hour') = date('now','+1 hour')),0) AS sales_today
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      LEFT JOIN users c ON c.id = u.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY CASE u.role WHEN 'OWNER' THEN 0 WHEN 'MANAGER' THEN 1 ELSE 2 END, u.full_name
      LIMIT ? OFFSET ?
    `).bind(...params, Math.min(500, Number(c.req.query('limit')) || 100), Number(c.req.query('offset')) || 0).all();

    const locks = await require('../lib/loginThrottle').listLockedAccounts(db, c.var.businessUnitId);
    const lockMap = new Map(locks.map((l) => [l.username, l]));

    return c.json({
      results: rows.results.map((u) => ({
        ...u,
        job_title: jobTitleOf(u),
        manager_kind: managerKindOf(u),
        is_locked: !!lockMap.get(u.username),
        lock: lockMap.get(u.username) || null,
        is_self: u.id === c.var.user.id,
        // Can the current user modify this one? Shown so the UI disables the
        // button rather than letting the click produce a 403.
        can_modify: canModify(c.var.user, u),
      })),
      roles: ROLES.filter((r) => r !== 'ADMIN'),
      plan: role === 'OWNER' || role === 'ADMIN' ? (await planSummary(db, c.var.businessUnitId)).limits.staff : null,
    });
  });

  function canModify(actor, target) {
    if (actor.id === target.id) return true;                     // self
    if (String(target.role).toUpperCase() === 'ADMIN') return false;
    return outranks(actor.role, target.role);
  }

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const role = V.oneOf(body.role || 'STAFF', ['OWNER', 'MANAGER', 'STAFF'], { field: 'Role' });
    if (role && role.error) throw new HttpError(400, role.error, 'VALIDATION_FAILED');
    // Creating an OWNER is a serious act: it grants full access to the money
    // and the governance switches. Only an existing OWNER or the vendor ADMIN
    // may do it, and a MANAGER may not — a manager who could create an owner
    // could create one of themselves.
    if (role === 'OWNER' && !['ADMIN', 'OWNER'].includes(c.var.user.role)) {
      throw new HttpError(403, 'Only the owner can create another owner account. A manager who could create an owner could create one of themselves.', 'OWNER_CREATION_FORBIDDEN');
    }
    if (!outranks(c.var.user.role, role) && c.var.user.role !== role) {
      throw new HttpError(403, `You cannot create a ${role.toLowerCase()} account — that is your own level or above.`, 'ROLE_CREATION_FORBIDDEN');
    }

    await assertCanCreateUser(db, c.var.businessUnitId, c.var.user, { role });

    const fullName = V.required(body.full_name, { field: 'Full name', max: V.LIMITS.NAME });
    if (fullName && fullName.error) throw new HttpError(400, fullName.error, 'VALIDATION_FAILED');
    const username = V.username(body.username, { field: 'Username' });
    if (username && username.error) throw new HttpError(400, username.error, 'VALIDATION_FAILED');
    const pin = V.pin(body.pin, { field: 'PIN', optional: false });
    if (pin && pin.error) throw new HttpError(400, pin.error, 'VALIDATION_FAILED');

    const clash = await db.prepare('SELECT id, full_name, is_active FROM users WHERE business_unit_id = ? AND username = ? AND is_deleted = 0').bind(c.var.businessUnitId, username).first();
    if (clash) {
      throw new HttpError(409,
        clash.is_active
          ? `The username "${username}" is already taken by ${clash.full_name}.`
          : `The username "${username}" belongs to a deactivated account (${clash.full_name}). Reactivate that account, or choose a different username — reusing it would attach a new person to someone else's audit history.`,
        'USERNAME_TAKEN');
    }

    // BRANCH SCOPING IS THE ROLE DEFINITION. MANAGER with a branch is a Branch
    // Manager; MANAGER without one is a General Manager. STAFF must be pinned —
    // an unpinned cashier has no branch to be scoped to, and every authority
    // decision in the product routes through branch_id.
    let branchId = body.branch_id || null;
    if (role === 'STAFF' && !branchId) branchId = c.var.user.branch_id;
    if (role === 'STAFF' && !branchId) {
      throw new HttpError(400, 'A cashier must be attached to a branch — every sale, till and stock record they create is scoped to one.', 'STAFF_BRANCH_REQUIRED');
    }
    if (role === 'OWNER') branchId = null;      // an owner is never pinned
    if (branchId) {
      const b = await db.prepare('SELECT * FROM branches WHERE id = ? AND business_unit_id = ? AND is_deleted = 0 AND is_active = 1')
        .bind(branchId, c.var.businessUnitId).first();
      if (!b) throw new HttpError(404, 'That branch was not found or is not active.', 'BRANCH_NOT_FOUND');
      // A Branch Manager may only create staff in their OWN branch.
      if (c.var.user.branch_id && c.var.user.branch_id !== branchId) {
        throw new HttpError(403, 'You manage one branch, so you can only add staff to it.', 'CROSS_BRANCH_WRITE');
      }
    }

    let phone = null;
    if (body.phone) {
      const p = V.phone(body.phone, { field: 'Phone number' });
      if (p && p.error) throw new HttpError(400, p.error, 'VALIDATION_FAILED');
      if (p) phone = p.international;
    }
    const email = body.email ? V.email(body.email, { field: 'Email' }) : null;
    if (email && email.error) throw new HttpError(400, email.error, 'VALIDATION_FAILED');

    const hashed = await hashPin(pin);
    const ts = watNowIso();
    const id = newId();
    await db.prepare(`
      INSERT INTO users (
        id, business_unit_id, branch_id, full_name, username, pin_hash, pin_updated_at, role, job_title,
        phone, email, is_active, must_change_pin, hired_at, created_by, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?)
    `).bind(
      id, c.var.businessUnitId, branchId, fullName, username, hashed.encoded, ts, role,
      body.job_title ? String(body.job_title).slice(0, 120) : null,
      phone, email, ts, ctx2(c).id, ts, ts
    ).run();

    await db.prepare(`
      INSERT INTO user_business_access (id, user_id, business_unit_id, role, branch_id, granted_by, granted_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(newId(), id, c.var.businessUnitId, role, branchId, ctx2(c).id, ts, ts).run();

    await db.prepare(`
      INSERT INTO user_assignment_history (id, user_id, business_unit_id, from_branch_id, to_branch_id, from_role, to_role, changed_by, reason, changed_at)
      VALUES (?,?,?,?,NULL,NULL,?,?,?,?)
    `).bind(newId(), id, c.var.businessUnitId, role, ctx2(c).id, 'Account created', ts).run();

    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId, userId: ctx2(c).id, actorRole: c.var.user.role,
      action: 'USER_CREATED', entityType: 'USER', entityId: id,
      after: { username, full_name: fullName, role, branch_id: branchId, job_title: jobTitleOf({ role, branch_id: branchId }) },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });

    return c.json({
      ok: true, id, username, full_name: fullName, role, branch_id: branchId,
      job_title: jobTitleOf({ role, branch_id: branchId, full_name: fullName }),
      must_change_pin: true,
      advisory: `Their first PIN is the one you just set and they will be required to change it at first sign-in. Tell them the username "${username}"${branchId ? ' and which branch they are attached to' : ''}.`,
    }, 201);
  });

  function ctx2(c) { return { id: c.var.user.id }; }

  app.put('/:id', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const target = await db.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!target) throw new HttpError(404, 'That user was not found.', 'USER_NOT_FOUND');
    if (target.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That user belongs to a different business.', 'USER_WRONG_BUSINESS');
    if (String(target.role).toUpperCase() === 'ADMIN') {
      throw new HttpError(403, 'The platform administrator account is managed by the vendor and cannot be edited here.', 'VENDOR_SEAT_PROTECTED');
    }
    const isSelf = target.id === c.var.user.id;
    if (!isSelf && !canModify(c.var.user, target)) {
      // A manager may not edit a PEER manager: peers are exactly the people a
      // collusion pattern needs to be able to modify.
      throw new HttpError(403,
        String(target.role).toUpperCase() === 'MANAGER' && String(c.var.user.role).toUpperCase() === 'MANAGER'
          ? 'You cannot edit a fellow manager\u2019s account. Only the owner can — otherwise two managers could each grant the other authority neither was given.'
          : 'You can only edit accounts whose role is below your own.',
        'USER_MODIFY_FORBIDDEN');
    }

    const body = await c.req.json();
    const patch = {};
    const before = {};
    const record = (k, v) => { if (String(target[k] ?? '') !== String(v ?? '')) { before[k] = target[k]; patch[k] = v; } };

    if (body.full_name !== undefined) {
      const n = V.required(body.full_name, { field: 'Full name', max: V.LIMITS.NAME });
      if (n && n.error) throw new HttpError(400, n.error, 'VALIDATION_FAILED');
      record('full_name', n);
    }
    if (body.job_title !== undefined) record('job_title', body.job_title ? String(body.job_title).slice(0, 120) : null);
    if (body.phone !== undefined) {
      const p = body.phone ? V.phone(body.phone, { field: 'Phone number' }) : null;
      if (p && p.error) throw new HttpError(400, p.error, 'VALIDATION_FAILED');
      record('phone', p ? p.international : null);
    }
    if (body.email !== undefined) {
      const e = body.email ? V.email(body.email, { field: 'Email' }) : null;
      if (e && e.error) throw new HttpError(400, e.error, 'VALIDATION_FAILED');
      record('email', e);
    }

    // PIN RESET. A different operation from a PIN CHANGE: no current PIN
    // required, but only someone who outranks the target may do it.
    if (body.pin !== undefined) {
      if (!isSelf && !outranks(c.var.user.role, target.role)) {
        throw new HttpError(403, 'You can only reset the PIN of someone whose role is below your own.', 'PIN_RESET_NOT_PERMITTED');
      }
      const pin = V.pin(body.pin, { field: 'PIN', optional: false });
      if (pin && pin.error) throw new HttpError(400, pin.error, 'VALIDATION_FAILED');
      const hashed = await hashPin(pin);
      patch.pin_hash = hashed.encoded;
      patch.pin_updated_at = watNowIso();
      patch.must_change_pin = 1;
    }

    // ROLE AND BRANCH CHANGES. These are the seams the original audit focused
    // on, because they are where authority changes hands.
    const roleChanging = body.role !== undefined && String(body.role).toUpperCase() !== String(target.role).toUpperCase();
    const branchChanging = body.branch_id !== undefined && (body.branch_id || null) !== (target.branch_id || null);
    if (roleChanging || branchChanging) {
      if (!isSelf && !outranks(c.var.user.role, target.role)) {
        throw new HttpError(403, 'You can only change the role or branch of someone whose role is below your own.', 'USER_MODIFY_FORBIDDEN');
      }
      // Demoting yourself is allowed and sometimes correct (an owner handing
      // over). Promoting yourself is not: it would be the escalation path.
      if (isSelf && roleChanging) {
        const newRole = V.oneOf(body.role, ['OWNER', 'MANAGER', 'STAFF'], { field: 'Role' });
        if (newRole && newRole.error) throw new HttpError(400, newRole.error, 'VALIDATION_FAILED');
        const { rankOf } = require('../lib/roles');
        if (rankOf(newRole) > rankOf(target.role)) {
          throw new HttpError(403, 'You cannot raise your own role. Ask someone who already outranks you — a self-promotion is the escalation this check exists to prevent.', 'SELF_PROMOTION_FORBIDDEN');
        }
        record('role', newRole);
      } else if (roleChanging) {
        const newRole = V.oneOf(body.role, ['OWNER', 'MANAGER', 'STAFF'], { field: 'Role' });
        if (newRole && newRole.error) throw new HttpError(400, newRole.error, 'VALIDATION_FAILED');
        if (newRole === 'OWNER' && !['ADMIN', 'OWNER'].includes(c.var.user.role)) {
          throw new HttpError(403, 'Only the owner can promote someone to owner.', 'OWNER_PROMOTION_FORBIDDEN');
        }
        if (!outranks(c.var.user.role, newRole)) {
          throw new HttpError(403, `You cannot promote someone to ${newRole.toLowerCase()} — that is your own level or above.`, 'ROLE_PROMOTION_FORBIDDEN');
        }
        record('role', newRole);
      }

      if (branchChanging) {
        const newBranch = body.branch_id || null;
        const effectiveRole = patch.role || target.role;
        if (String(effectiveRole).toUpperCase() === 'OWNER') {
          throw new HttpError(400, 'An owner is never pinned to a single branch — that is what distinguishes the role from a Branch Manager. Set the role to MANAGER to pin them.', 'OWNER_CANNOT_BE_PINNED');
        }
        if (String(effectiveRole).toUpperCase() === 'STAFF' && !newBranch) {
          throw new HttpError(400, 'A cashier must be attached to a branch.', 'STAFF_BRANCH_REQUIRED');
        }
        if (newBranch) {
          const b = await db.prepare('SELECT * FROM branches WHERE id = ? AND business_unit_id = ? AND is_deleted = 0 AND is_active = 1')
            .bind(newBranch, c.var.businessUnitId).first();
          if (!b) throw new HttpError(404, 'That branch was not found or is not active.', 'BRANCH_NOT_FOUND');
          if (c.var.user.branch_id && c.var.user.branch_id !== newBranch && c.var.user.branch_id !== target.branch_id) {
            throw new HttpError(403, 'You manage one branch, so you can only move staff between your own branch and nowhere else.', 'CROSS_BRANCH_WRITE');
          }
        }
        record('branch_id', newBranch);
      }
    }

    if (body.is_active !== undefined) {
      if (!isSelf && !outranks(c.var.user.role, target.role)) {
        throw new HttpError(403, 'You can only deactivate someone whose role is below your own.', 'USER_MODIFY_FORBIDDEN');
      }
      if (isSelf && !body.is_active) {
        throw new HttpError(400, 'You cannot deactivate your own account — you would lock yourself out with no way back in. Ask the owner.', 'SELF_DEACTIVATION_FORBIDDEN');
      }
      const active = body.is_active ? 1 : 0;
      if (!active) {
        // The last active OWNER must not be deactivated: it would leave the
        // business with nobody who can change the governance switches, which is
        // an unrecoverable state without vendor intervention.
        if (String(target.role).toUpperCase() === 'OWNER') {
          const others = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE business_unit_id = ? AND role = 'OWNER' AND is_active = 1 AND is_deleted = 0 AND id <> ?`)
            .bind(c.var.businessUnitId, id).first();
          if (others.n === 0) {
            throw new HttpError(409, 'This is the last active owner account. Create or promote another owner first — a business with no owner has nobody who can change its permissions.', 'LAST_OWNER_CANNOT_DEACTIVATE');
          }
        }
        patch.exited_at = watNowIso();
        patch.exit_reason = body.exit_reason ? String(body.exit_reason).slice(0, 200) : null;
      } else {
        patch.exited_at = null;
        patch.exit_reason = null;
      }
      record('is_active', active);
    }

    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0, message: 'Nothing to change.' });
    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    const statements = [
      db.prepare(`UPDATE users SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...cols.map((k) => patch[k]), id),
    ];

    // A role or branch change is recorded in the assignment history, because
    // the audit question is never "what is Ada's role?" but "who could void a
    // sale at the Ikeja branch on the 14th of March?" — and by then the answer
    // has been overwritten twice.
    if (patch.role !== undefined || patch.branch_id !== undefined) {
      statements.push(db.prepare(`
        INSERT INTO user_assignment_history (id, user_id, business_unit_id, from_branch_id, to_branch_id, from_role, to_role, changed_by, reason, changed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).bind(newId(), id, c.var.businessUnitId, target.branch_id, patch.branch_id !== undefined ? patch.branch_id : target.branch_id,
        target.role, patch.role !== undefined ? patch.role : target.role, c.var.user.id,
        body.change_reason ? String(body.change_reason).slice(0, 500) : (patch.role !== undefined ? 'Role changed' : 'Branch changed'),
        watNowIso()));
      statements.push(db.prepare('UPDATE user_business_access SET role = ?, branch_id = ?, updated_at = ? WHERE user_id = ? AND business_unit_id = ?')
        .bind(patch.role !== undefined ? patch.role : target.role,
          patch.branch_id !== undefined ? patch.branch_id : target.branch_id,
          watNowIso(), id, c.var.businessUnitId));
    }
    // A PIN change or a deactivation must end every live session. Without this,
    // "I think someone knows my PIN, I changed it" does not remove them, and a
    // dismissed employee keeps a working token until it expires.
    if (patch.pin_hash || patch.is_active === 0 || patch.role) {
      statements.push(db.prepare(`UPDATE user_sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL`)
        .bind(watNowIso(), patch.pin_hash ? 'PIN_RESET' : (patch.is_active === 0 ? 'ACCOUNT_DEACTIVATED' : 'ROLE_CHANGED'), id));
    }
    await db.batch(statements);

    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId: patch.branch_id !== undefined ? patch.branch_id : target.branch_id,
      userId: c.var.user.id, actorRole: c.var.user.role,
      action: patch.pin_hash ? 'USER_PIN_RESET' : (patch.role ? 'USER_ROLE_CHANGED' : 'USER_UPDATED'),
      entityType: 'USER', entityId: id,
      reason: body.change_reason ? String(body.change_reason).slice(0, 500) : null,
      before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, k === 'pin_hash' ? '[redacted]' : v])),
      after: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, k === 'pin_hash' ? '[redacted]' : v])),
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });

    return c.json({
      ok: true, id, changed: cols.length,
      sessions_revoked: !!(patch.pin_hash || patch.is_active === 0 || patch.role),
      advisory: patch.pin_hash ? 'Their PIN is reset and every device has been signed out. They will be required to choose a new PIN at first sign-in.' : null,
    });
  });

  // A branch transfer that needs the RECEIVING manager's agreement. A
  // one-sided write would let a manager dump a problem employee on a peer.
  app.post('/:id/transfer-request', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const target = await db.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!target) throw new HttpError(404, 'That user was not found.', 'USER_NOT_FOUND');
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'request a staff transfer' });
    const body = await c.req.json();
    const toBranchId = body.to_branch_id;
    if (!toBranchId) throw new HttpError(400, 'Choose the branch to transfer them to.', 'BRANCH_REQUIRED');
    if (toBranchId === target.branch_id) throw new HttpError(400, 'They are already at that branch.', 'TRANSFER_SAME_BRANCH');
    const toBranch = await db.prepare('SELECT * FROM branches WHERE id = ? AND business_unit_id = ? AND is_deleted = 0 AND is_active = 1').bind(toBranchId, c.var.businessUnitId).first();
    if (!toBranch) throw new HttpError(404, 'That branch was not found or is not active.', 'BRANCH_NOT_FOUND');
    if (!c.var.user.branch_id || c.var.user.branch_id === target.branch_id) {
      // Only the SENDING manager (or an org-wide role) may request.
    } else {
      throw new HttpError(403, 'You can only request a transfer for staff at your own branch.', 'TRANSFER_NOT_YOUR_STAFF');
    }

    const open = await db.prepare(`SELECT id FROM pending_user_transfers WHERE user_id = ? AND status = 'PENDING' AND is_deleted = 0`).bind(id).first();
    if (open) throw new HttpError(409, 'A transfer request for this person is already pending. Two simultaneous moves for one person is not a state anyone can reason about.', 'TRANSFER_ALREADY_PENDING');

    const ts = watNowIso();
    const requestId = newId();
    await db.prepare(`
      INSERT INTO pending_user_transfers (id, user_id, business_unit_id, from_branch_id, to_branch_id, requested_by, status, reason, expires_at, updated_at)
      VALUES (?,?,?,?,?,?, 'PENDING', ?, datetime('now','+1 hour','+7 days'), ?)
    `).bind(requestId, id, c.var.businessUnitId, target.branch_id, toBranchId, c.var.user.id,
      body.reason ? String(body.reason).slice(0, 500) : null, ts).run();

    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId: target.branch_id, userId: c.var.user.id,
      actorRole: c.var.user.role, action: 'TRANSFER_REQUESTED', entityType: 'USER', entityId: id,
      reason: body.reason || null, after: { to_branch_id: toBranchId, request_id: requestId },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({
      ok: true, request_id: requestId, status: 'PENDING',
      advisory: `${toBranch.name} must accept before anything changes. The request expires in 7 days.`,
    }, 201);
  });

  app.get('/transfer-requests', async (c) => {
    const db = getDb();
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view transfer requests' });
    const scoped = c.var.user.branch_id;
    const rows = await db.prepare(`
      SELECT pt.*, u.full_name AS user_name, u.role AS user_role,
             fb.name AS from_branch_name, tb.name AS to_branch_name,
             rq.full_name AS requested_by_name
      FROM pending_user_transfers pt
      JOIN users u ON u.id = pt.user_id
      LEFT JOIN branches fb ON fb.id = pt.from_branch_id
      JOIN branches tb ON tb.id = pt.to_branch_id
      JOIN users rq ON rq.id = pt.requested_by
      WHERE pt.business_unit_id = ? AND pt.is_deleted = 0
        ${c.req.query('status') ? 'AND pt.status = ?' : ''}
        ${scoped ? 'AND (pt.from_branch_id = ? OR pt.to_branch_id = ?)' : ''}
      ORDER BY pt.requested_at DESC LIMIT 200
    `).bind(c.var.businessUnitId,
      ...(c.req.query('status') ? [String(c.req.query('status')).toUpperCase()] : []),
      ...(scoped ? [scoped, scoped] : [])).all();
    return c.json({ results: rows.results });
  });

  app.post('/transfer-requests/:requestId/respond', async (c) => {
    const db = getDb();
    const requestId = c.req.param('requestId');
    const req = await db.prepare('SELECT * FROM pending_user_transfers WHERE id = ? AND is_deleted = 0').bind(requestId).first();
    if (!req) throw new HttpError(404, 'That transfer request was not found.', 'TRANSFER_REQUEST_NOT_FOUND');
    if (req.status !== 'PENDING') throw new HttpError(409, `That request is ${req.status}.`, 'TRANSFER_REQUEST_NOT_PENDING');
    const body = await c.req.json();
    const decision = String(body.decision || '').toUpperCase();
    if (!['ACCEPTED', 'DECLINED', 'CANCELLED'].includes(decision)) {
      throw new HttpError(400, 'Decision must be ACCEPTED, DECLINED or CANCELLED.', 'TRANSFER_DECISION_INVALID');
    }

    const isRequester = req.requested_by === c.var.user.id;
    const isReceiver = c.var.user.branch_id === req.to_branch_id;
    const isOrgWide = ['ADMIN', 'OWNER'].includes(c.var.user.role) || (c.var.user.role === 'MANAGER' && !c.var.user.branch_id);

    if (decision === 'CANCELLED' && !isRequester && !isOrgWide) {
      throw new HttpError(403, 'Only the manager who raised this request, or the owner, can withdraw it.', 'TRANSFER_CANCEL_FORBIDDEN');
    }
    if (decision === 'ACCEPTED' && !isReceiver && !isOrgWide) {
      throw new HttpError(403,
        'Only the RECEIVING branch\u2019s manager (or the owner) can accept a transfer. Accepting staff changes that branch\u2019s payroll, accommodation and till responsibility, so it cannot be a one-sided decision.',
        'TRANSFER_ACCEPT_FORBIDDEN');
    }
    if (decision === 'DECLINED' && !isReceiver && !isRequester && !isOrgWide) {
      throw new HttpError(403, 'Only the receiving manager, the requester or the owner can decline.', 'TRANSFER_DECLINE_FORBIDDEN');
    }

    const ts = watNowIso();
    const statements = [
      db.prepare(`UPDATE pending_user_transfers SET status = ?, responded_by = ?, responded_at = ?, response_note = ?, updated_at = ? WHERE id = ?`)
        .bind(decision, c.var.user.id, ts, body.note ? String(body.note).slice(0, 500) : null, ts, requestId),
    ];

    if (decision === 'ACCEPTED') {
      const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(req.user_id).first();
      statements.push(db.prepare('UPDATE users SET branch_id = ?, updated_at = ? WHERE id = ?').bind(req.to_branch_id, ts, req.user_id));
      statements.push(db.prepare(`
        INSERT INTO user_assignment_history (id, user_id, business_unit_id, from_branch_id, to_branch_id, from_role, to_role, changed_by, reason, changed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).bind(newId(), req.user_id, req.business_unit_id, req.from_branch_id, req.to_branch_id,
        target.role, target.role, c.var.user.id, `Branch transfer accepted. ${String(body.note || '').slice(0, 300)}`, ts));
      statements.push(db.prepare('UPDATE user_business_access SET branch_id = ?, updated_at = ? WHERE user_id = ? AND business_unit_id = ?')
        .bind(req.to_branch_id, ts, req.user_id, req.business_unit_id));
      // The person moved must be signed out: their scope changed, and a live
      // session carrying the old branch scope would let them write into the
      // branch they just left until it expires.
      statements.push(db.prepare(`UPDATE user_sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL`)
        .bind(ts, 'BRANCH_TRANSFERRED', req.user_id));
    }
    await db.batch(statements);

    await writeAudit(db, {
      businessUnitId: req.business_unit_id, branchId: decision === 'ACCEPTED' ? req.to_branch_id : req.from_branch_id,
      userId: c.var.user.id, actorRole: c.var.user.role, action: `TRANSFER_${decision}`,
      entityType: 'USER', entityId: req.user_id, reason: body.note || req.reason || null,
      before: { status: 'PENDING' }, after: { status: decision, to_branch_id: req.to_branch_id },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({
      ok: true, request_id: requestId, status: decision,
      advisory: decision === 'ACCEPTED' ? 'The transfer is complete. They have been signed out and must sign in again — their branch scope has changed.' : null,
    });
  });

  return app;
}

// ---------------------------------------------------------------------
// COMPLIANCE / CERTIFICATES
// ---------------------------------------------------------------------
function complianceRoutes(getDb) {
  const app = createRouter();

  app.get('/schemes', async (c) => {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT * FROM compliance_schemes WHERE business_unit_id = ? AND is_deleted = 0 AND is_active = 1 ORDER BY code
    `).bind(c.var.businessUnitId).all();
    const unit = c.var.businessUnit;
    const profile = require('../lib/capabilities').profileOf(unit);
    return c.json({
      results: rows.results,
      profile_default: profile && profile.compliance ? profile.compliance : null,
    });
  });

  app.get('/certificates', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const where = ['bc.is_deleted = 0', 'bc.business_unit_id = ?'];
    const params = [c.var.businessUnitId];
    if (scoped) { where.push('(bc.branch_id = ? OR bc.branch_id IS NULL)'); params.push(scoped); }
    if (c.req.query('scheme')) { where.push('bc.scheme_code = ?'); params.push(String(c.req.query('scheme')).toUpperCase()); }
    const rows = await db.prepare(`
      SELECT bc.*, b.name AS branch_name, u.full_name AS recorded_by_name,
             CAST(julianday(bc.expiry_date) - julianday('now','+1 hour') AS INTEGER) AS days_to_expiry
      FROM branch_certificates bc
      LEFT JOIN branches b ON b.id = bc.branch_id
      LEFT JOIN users u ON u.id = bc.recorded_by
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN bc.expiry_date IS NULL THEN 1 ELSE 0 END, bc.expiry_date ASC
    `).bind(...params).all();
    return c.json({ results: rows.results });
  });

  app.get('/alerts', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT * FROM v_certificate_expiry_alerts
      WHERE business_unit_id = ? ${scoped ? 'AND (branch_id = ? OR branch_id IS NULL)' : ''}
        AND severity IN ('EXPIRED','CRITICAL','WARNING')
      ORDER BY CASE severity WHEN 'EXPIRED' THEN 0 WHEN 'CRITICAL' THEN 1 ELSE 2 END, days_to_expiry
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();
    return c.json({
      results: rows.results,
      count: rows.results.length,
      expired: rows.results.filter((r) => r.severity === 'EXPIRED').length,
      advisory: rows.results.length
        ? `${rows.results.length} licence(s) or certificate(s) need attention. An expired SONCAP or PCN certificate is not a paperwork problem — it can stop an import clearing or close a premises.`
        : null,
    });
  });

  app.post('/certificates', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'record a licence or certificate' });
    const db = getDb();
    const unit = c.var.businessUnit;
    assertCapability(unit, 'compliance_certificates', { action: 'record a licence or certificate' });
    const body = await c.req.json();

    const schemeCode = V.required(String(body.scheme_code || '').trim().toUpperCase(), { field: 'Scheme', max: 40 });
    if (schemeCode && schemeCode.error) throw new HttpError(400, schemeCode.error, 'VALIDATION_FAILED');
    const certNo = V.required(body.certificate_no, { field: 'Certificate number', max: 120 });
    if (certNo && certNo.error) throw new HttpError(400, certNo.error, 'VALIDATION_FAILED');

    const branchId = body.branch_id || (c.var.user.branch_id || null);
    if (branchId) assertBranchAccess(c.var.user, branchId);

    const expiry = body.expiry_date ? V.isoDate(body.expiry_date, { field: 'Expiry date', optional: false }) : null;
    if (expiry && expiry.error) throw new HttpError(400, expiry.error, 'VALIDATION_FAILED');

    // Ensure the scheme exists so alerts and the register can reference it.
    const scheme = await db.prepare('SELECT * FROM compliance_schemes WHERE business_unit_id = ? AND code = ? AND is_deleted = 0').bind(c.var.businessUnitId, schemeCode).first();
    if (!scheme) {
      const profile = require('../lib/capabilities').profileOf(unit);
      await db.prepare(`
        INSERT INTO compliance_schemes (id, business_unit_id, code, label, regulator, applies_to, requires_expiry, renewal_warning_days, description, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,1,60,?, 1,?,?)
      `).bind(newId(), c.var.businessUnitId, schemeCode, body.scheme_label || schemeCode,
        body.regulator || (profile && profile.compliance ? profile.compliance.regulator : 'Regulator'),
        branchId ? 'BRANCH' : 'BUSINESS',
        body.description ? String(body.description).slice(0, 500) : null, watNowIso(), watNowIso()).run();
    }

    const ts = watNowIso();
    const id = newId();
    await db.prepare(`
      INSERT INTO branch_certificates (
        id, business_unit_id, branch_id, scheme_code, certificate_no, holder_name, holder_reg_no,
        issued_at, expiry_date, attachment_note, status, recorded_by, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?)
    `).bind(id, c.var.businessUnitId, branchId, schemeCode, certNo,
      body.holder_name ? String(body.holder_name).slice(0, 160) : null,
      body.holder_reg_no ? String(body.holder_reg_no).slice(0, 80) : null,
      body.issued_at ? String(body.issued_at).slice(0, 10) : null, expiry,
      body.attachment_note ? String(body.attachment_note).slice(0, 500) : null,
      'VALID', c.var.user.id, ts, ts).run();

    // Register the event on the chained register when the scheme is a
    // regulated one — an inspector asking "when did you record this?" should
    // get a tamper-evident answer.
    if (unit.compliance_register_enabled !== 0) {
      try {
        await require('../lib/audit').appendRegister(db, {
          business_unit_id: c.var.businessUnitId, branch_id: branchId || c.var.user.branch_id,
          scheme_code: schemeCode, event_type: 'CERTIFICATE_RECORDED', certificate_id: id,
          detail: `${schemeCode} ${certNo}${expiry ? `, expires ${expiry}` : ''}`,
          performed_by: c.var.user.id, device_id: c.var.deviceId, ip_address: c.var.ipAddress, occurred_at: ts,
        });
      } catch (e) { console.error('[compliance] register write failed:', e && e.message); }
    }

    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'CERTIFICATE_RECORDED', entityType: 'CERTIFICATE', entityId: id,
      after: { scheme_code: schemeCode, certificate_no: certNo, expiry_date: expiry },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });

    return c.json({
      ok: true, id, scheme_code: schemeCode, certificate_no: certNo, expiry_date: expiry,
      advisory: expiry && expiry < addMonths(watDate(), 2)
        ? `That certificate expires on ${expiry}, which is soon. Renewal usually takes longer than expected — start now.`
        : null,
    }, 201);
  });

  app.put('/certificates/:id', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'update a licence or certificate' });
    const db = getDb();
    const id = c.req.param('id');
    const existing = await db.prepare('SELECT * FROM branch_certificates WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!existing) throw new HttpError(404, 'That certificate was not found.', 'CERTIFICATE_NOT_FOUND');
    if (existing.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That certificate belongs to another business.', 'CERTIFICATE_WRONG_BUSINESS');

    const body = await c.req.json();
    const patch = {};
    const before = {};
    const record = (k, v) => { if (String(existing[k] ?? '') !== String(v ?? '')) { before[k] = existing[k]; patch[k] = v; } };
    if (body.certificate_no !== undefined) record('certificate_no', String(body.certificate_no).slice(0, 120));
    if (body.holder_name !== undefined) record('holder_name', body.holder_name ? String(body.holder_name).slice(0, 160) : null);
    if (body.holder_reg_no !== undefined) record('holder_reg_no', body.holder_reg_no ? String(body.holder_reg_no).slice(0, 80) : null);
    if (body.issued_at !== undefined) record('issued_at', body.issued_at ? String(body.issued_at).slice(0, 10) : null);
    if (body.expiry_date !== undefined) {
      const e = body.expiry_date ? V.isoDate(body.expiry_date, { field: 'Expiry date', optional: false }) : null;
      if (e && e.error) throw new HttpError(400, e.error, 'VALIDATION_FAILED');
      record('expiry_date', e);
    }
    if (body.status !== undefined) {
      const s = V.oneOf(body.status, ['VALID', 'EXPIRING', 'EXPIRED', 'SUSPENDED', 'NOT_APPLICABLE'], { field: 'Status' });
      if (s && s.error) throw new HttpError(400, s.error, 'VALIDATION_FAILED');
      record('status', s);
    }
    if (body.attachment_note !== undefined) record('attachment_note', body.attachment_note ? String(body.attachment_note).slice(0, 500) : null);
    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0 });
    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    await db.prepare(`UPDATE branch_certificates SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((k) => patch[k]), id).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId: existing.branch_id, userId: c.var.user.id,
      actorRole: c.var.user.role, action: 'CERTIFICATE_UPDATED', entityType: 'CERTIFICATE', entityId: id,
      before, after: patch, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, changed: cols.length });
  });

  // The tamper-evident register and its chain verification.
  app.get('/register', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'read the compliance register' });
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const where = ['cr.business_unit_id = ?'];
    const params = [c.var.businessUnitId];
    if (scoped) { where.push('cr.branch_id = ?'); params.push(scoped); }
    if (c.req.query('scheme')) { where.push('cr.scheme_code = ?'); params.push(String(c.req.query('scheme')).toUpperCase()); }
    if (c.req.query('serial_id')) { where.push('cr.serial_id = ?'); params.push(c.req.query('serial_id')); }
    if (c.req.query('product_id')) { where.push('cr.product_id = ?'); params.push(c.req.query('product_id')); }
    if (c.req.query('event_type')) { where.push('cr.event_type = ?'); params.push(String(c.req.query('event_type')).toUpperCase()); }
    if (c.req.query('from')) { where.push("date(cr.occurred_at,'+1 hour') >= ?"); params.push(String(c.req.query('from')).slice(0, 10)); }
    if (c.req.query('to')) { where.push("date(cr.occurred_at,'+1 hour') <= ?"); params.push(String(c.req.query('to')).slice(0, 10)); }

    const rows = await db.prepare(`
      SELECT cr.*, b.name AS branch_name, p.name AS product_name, ps.serial_no, ps.imei,
             u.full_name AS performed_by_name, s.receipt_no
      FROM compliance_register cr
      LEFT JOIN branches b ON b.id = cr.branch_id
      LEFT JOIN products p ON p.id = cr.product_id
      LEFT JOIN product_serials ps ON ps.id = cr.serial_id
      LEFT JOIN users u ON u.id = cr.performed_by
      LEFT JOIN sales s ON s.id = cr.sale_id
      WHERE ${where.join(' AND ')}
      ORDER BY cr.occurred_at DESC, cr.chain_seq DESC
      LIMIT ? OFFSET ?
    `).bind(...params, Math.min(1000, Number(c.req.query('limit')) || 200), Number(c.req.query('offset')) || 0).all();
    return c.json({ results: rows.results, append_only: true, note: 'This register is append-only and hash-chained. Editing or deleting a historical entry breaks the chain for everything after it, which verify-chain detects.' });
  });

  app.get('/verify-chain', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'verify the compliance register' });
    const db = getDb();
    const { verifyChain, verifyAllChains } = require('../lib/audit');
    const branchId = c.req.query('branch_id');
    const scheme = c.req.query('scheme');
    const result = branchId && scheme
      ? [await verifyChain(db, { branchId, schemeCode: String(scheme).toUpperCase() }).then((v) => ({ branch_id: branchId, scheme_code: String(scheme).toUpperCase(), ...v }))]
      : await verifyAllChains(db, { businessUnitId: c.var.businessUnitId });
    return c.json({
      chains: result,
      all_verified: result.every((r) => r.verified),
      checked_at: watNowIso(),
      note: 'Recomputes every hash from the stored columns, so it detects an UPDATE, a DELETE and a re-ordered insert alike. Detection is the honest claim — no application-layer scheme can make tampering impossible, only visible.',
    });
  });

  return app;
}

module.exports = { branchRoutes, userRoutes, complianceRoutes };
'use strict';
