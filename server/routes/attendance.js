'use strict';
// =====================================================================
// server/routes/attendance.js — WHO IS AT WORK, AND WHERE THEY SAID SO
// =====================================================================
// THE CENTRAL DESIGN DECISION: location and device checks are ADVISORY, never
// blocking.
//
// A geofence that refuses a clock-in fails the person who most needs to get
// through it. GPS on a budget Android phone inside a Lagos shop with a metal
// roof is routinely 300m out; a branch's stored coordinates may be a pin dropped
// on the wrong street; a device id changes when a phone is factory reset. If any
// of those prevented a clock-in, staff would stop using the system and keep a
// paper book — and then there is no attendance data at all, which is worse than
// approximate data.
//
// So the rule is: RECORD EVERYTHING, FLAG WHAT LOOKS WRONG, LET A HUMAN DECIDE.
// A clock-in 4km away is accepted and flagged with the distance attached. The
// manager sees it on the review queue with the evidence, and can override with a
// reason. That is auditable; a silent refusal is not.
//
// `branch_id` on the user is the sole scoping truth: which branch somebody
// belongs to is never taken from the request.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, scopeFilter, pagination, listResponse, dateRange, numField, strField, boolField, valid } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday, utcToWat, watToUtc } = require('../../domain/time');
const { classifyAttendance, hoursBetween, coordinatesArePlausible, haversineMeters, LOCATION_STATUS, DEVICE_STATUS } = require('../../domain/geofence');
const { oneOf } = require('../../domain/validation');

// `staff_attendance.clock_in_method` is constrained to these three. A method
// the schema does not allow would be refused by the CHECK constraint at insert
// time, which is the worst moment to discover it — at the door, mid-shift.
const CLOCK_METHODS = ['GEOLOCATION', 'REGISTERED_DEVICE', 'MANUAL'];

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // CLOCK IN
  // -------------------------------------------------------------------
  /**
   * Clock in.
   *
   * Location is optional: a branch without coordinates, or a phone without GPS
   * permission, must still be able to record attendance. When coordinates ARE
   * supplied they are checked and the result stored — `ON_SITE`, `OFF_SITE`,
   * `NO_LOCATION` or `NOT_CONFIGURED`, the four values the schema's CHECK
   * constraint allows — along with the distance, so a review has evidence rather
   * than an impression.
   */
  app.post(`${base}/attendance/clock-in`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    // The branch is resolved from the USER, not from the body. Letting a request
    // choose its own branch would allow a clock-in to be attributed anywhere,
    // which defeats the purpose of recording it.
    const lat = body.latitude != null && String(body.latitude).trim() !== '' ? Number(body.latitude) : null;
    const lng = body.longitude != null && String(body.longitude).trim() !== '' ? Number(body.longitude) : null;
    const deviceId = strField(body.device_id || body.deviceId || ctx.req.header('X-Device-Id'), { field: 'Device', maxLength: 120 });
    const method = valid(oneOf(body.method || 'GEOLOCATION', CLOCK_METHODS, { field: 'Clock-in method' }), 'clock_in_method');
    const accuracy = body.accuracy_meters != null ? numField(body.accuracy_meters, { field: 'GPS accuracy', min: 0, max: 100000 }) : null;

    // Already clocked in? Refuse, but say when — a double clock-in is nearly
    // always a phone that did not show the first one succeeding.
    const open = await db.first('SELECT * FROM staff_attendance WHERE user_id = ? AND clock_in_at IS NOT NULL AND clock_out_at IS NULL AND is_deleted = 0 ORDER BY clock_in_at DESC LIMIT 1',
      [String(user.id)]);
    if (open) {
      throw new HttpError(
        `You are already clocked in at ${open.branch_id === String(branch.id) ? branch.name : 'another branch'} since ${utcToWat(open.clock_in_at) || open.clock_in_at}. Clock out first — two open shifts for one person makes neither countable.`,
        { status: 409, code: 'ALREADY_CLOCKED_IN' },
      );
    }

    // `branch_devices` has no status column: a device is APPROVED when it has a
    // `registered_by` and no `revoked_at`, PENDING when it was auto-recorded on
    // first sight and nobody has approved it, and BLOCKED once revoked. Reading
    // those three states off two columns keeps the schema honest instead of
    // inventing a status field the migration does not have.
    const registered = await db.all('SELECT device_id FROM branch_devices WHERE branch_id = ? AND revoked_at IS NULL AND registered_by IS NOT NULL AND is_deleted = 0', [String(branch.id)]);
    const classification = classifyAttendance({
      branch, latitude: lat, longitude: lng, deviceId,
      registeredDeviceIds: registered.map((r) => String(r.device_id)),
    });

    // GPS accuracy is recorded and taken into account: a fix accurate to 500m
    // cannot meaningfully be judged against a 100m fence, and flagging it as
    // "outside" would be a false accusation.
    const fence = Number(branch.geofence_radius_meters) || 0;
    const accuracyExcuse = accuracy != null && fence > 0 && accuracy > fence;
    // `classifyLocation` speaks the schema's vocabulary: ON_SITE, OFF_SITE,
    // NO_LOCATION, NOT_CONFIGURED. Comparing against a status string the schema
    // does not contain ('OUTSIDE_FENCE') made this branch unreachable, so an
    // off-site clock-in was recorded as clean — the one outcome the whole flag
    // mechanism exists to prevent. The unit test asserts an OFF_SITE clock-in
    // comes back flagged.
    const plausibility = lat != null && lng != null
      ? coordinatesArePlausible(lat, lng)
      : { plausible: true, suspect: false, reason: null };
    const flags = [];
    if (classification.locationStatus === LOCATION_STATUS.OFF_SITE) {
      flags.push(accuracyExcuse
        ? `GPS reported ${Math.round(classification.distanceMeters || 0)}m away but only to ±${Math.round(accuracy)}m, which is wider than the ${fence}m fence — the position is too uncertain to judge.`
        : `Clocked in ${Math.round(classification.distanceMeters || 0)}m from ${branch.name}, outside its ${fence}m fence.`);
    }
    if (classification.locationStatus === LOCATION_STATUS.NO_LOCATION) {
      flags.push('No location was supplied, so the clock-in could not be placed.');
    }
    // `coordinatesArePlausible` returns an OBJECT, not a boolean; testing it
    // directly was always truthy, so an uninitialised GPS fix (0,0) or a swapped
    // lat/lng pair was never flagged.
    if (!plausibility.plausible) flags.push(`${plausibility.reason} Recorded as given, pending review.`);
    else if (plausibility.suspect) flags.push(plausibility.reason);
    if (classification.deviceStatus === DEVICE_STATUS.UNRECOGNIZED) flags.push(`Device ${deviceId || '(unknown)'} is not registered at ${branch.name}.`);
    if (!flags.length && classification.flagReason) flags.push(classification.flagReason);

    const flagged = flags.length > 0 ? 1 : 0;
    const id = newId();
    const nowUtc = watToUtc(watNow()) || new Date().toISOString();

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO staff_attendance (
          id, user_id, branch_id, business_id, clock_in_at, clock_in_method, clock_in_lat, clock_in_lng,
          clock_in_device_id, location_status, distance_meters, device_status, flagged, flag_reason,
          hours_worked, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 0, ?, datetime('now'), datetime('now'))`, [
        id, String(user.id), String(branch.id), String(business.id), nowUtc, method,
        lat, lng, deviceId,
        classification.locationStatus,
        classification.distanceMeters != null ? round2(classification.distanceMeters) : null,
        classification.deviceStatus,
        flagged, flagged ? flags.join(' ') : null,
        strField(body.notes, { field: 'Notes', maxLength: 300 }),
      ]);
      // A device seen for the first time is registered as pending rather than
      // ignored, so the manager can approve it once instead of every shift.
      if (deviceId && classification.deviceStatus === 'UNREGISTERED') {
        // Registered with `registered_by` LEFT NULL, which is the PENDING state:
        // the manager sees it on the device list and approves it once, rather
        // than the shift being flagged every single day forever.
        tx.queue(`INSERT INTO branch_devices (id, branch_id, device_id, label, updated_at)
            VALUES (?,?,?, ?, datetime('now'))`, [
          newId(), String(branch.id), deviceId,
          `${user.full_name || user.username}'s device (${String(ctx.req.header('User-Agent') || 'unknown').slice(0, 60)})`,
        ]);
      } else if (deviceId) {
        tx.queue("UPDATE branch_devices SET updated_at = datetime('now') WHERE branch_id = ? AND device_id = ? AND is_deleted = 0",
          [String(branch.id), deviceId]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'CLOCK_IN', entityType: 'ATTENDANCE', entityId: id, branchId: branch.id, businessId: business.id,
      after: { method, lat, lng, accuracy, deviceId, locationStatus: classification.locationStatus, distanceMeters: classification.distanceMeters, flagged },
    });

    ctx.json({
      ok: true, id,
      clockedInAt: nowUtc, clockedInAtWat: watNow(),
      locationStatus: classification.locationStatus,
      distanceMeters: classification.distanceMeters != null ? round2(classification.distanceMeters) : null,
      deviceStatus: classification.deviceStatus,
      flagged: Boolean(flagged), flags,
      // A branch with no coordinates on file cannot be judged at all. Saying so
      // once, here, is what stops a manager concluding that every clock-in is
      // clean when in fact nothing is being checked.
      geofenceConfigured: !classification.needsGeofenceConfiguration,
      // The message must be usable by the person standing at the door with a
      // phone in their hand. "OUTSIDE_FENCE" is a status code, not an answer.
      message: flagged
        ? `Clocked in at ${branch.name} — but this needs a manager's review: ${flags[0]}`
        : `Clocked in at ${branch.name}.${fence > 0 ? ` Position confirmed within the ${fence}m fence.` : ''}`,
    }, 201);
  });

  /**
   * Clock out.
   *
   * Hours are computed from the STORED clock-in, never from a duration the
   * client sends. A client-supplied duration can be anything, and the whole
   * value of the record is that it was measured rather than declared.
   */
  app.post(`${base}/attendance/clock-out`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);

    const open = await db.first('SELECT * FROM staff_attendance WHERE user_id = ? AND clock_in_at IS NOT NULL AND clock_out_at IS NULL AND is_deleted = 0 ORDER BY clock_in_at DESC LIMIT 1',
      [String(user.id)]);
    if (!open) {
      throw new HttpError('You are not clocked in, so there is no shift to close.', { status: 409, code: 'NOT_CLOCKED_IN' });
    }
    const nowUtc = watToUtc(watNow()) || new Date().toISOString();
    const hours = round2(hoursBetween(open.clock_in_at, nowUtc));
    if (hours < 0) {
      // Can only happen if the clock-in was recorded with a future timestamp.
      // Clamping at zero keeps the record usable and says what happened, rather
      // than storing negative hours that make a payroll total wrong.
      ctx.set('negativeHours', `The clock-in (${open.clock_in_at}) is later than now (${nowUtc}); the device clock or the stored time is wrong. Recorded as 0 hours.`);
    }
    const safeHours = Math.max(0, hours);

    // A shift longer than a working day is flagged, not rejected: it is usually
    // somebody who forgot to clock out, and the honest record is the long shift
    // plus a flag, not a fabricated eight hours.
    const flags = [];
    if (safeHours > 16) flags.push(`This shift is ${safeHours} hours long, which usually means a missed clock-out rather than a real shift. A manager should correct it.`);
    if (Number(open.flagged)) flags.push(open.flag_reason);

    await db.run(`UPDATE staff_attendance SET clock_out_at = ?, hours_worked = ?, flagged = ?,
        flag_reason = ?, notes = COALESCE(notes,'') || ?, updated_at = datetime('now')
      WHERE id = ? AND is_deleted = 0`, [
      nowUtc, safeHours,
      flags.length ? 1 : Number(open.flagged),
      flags.length ? flags.join(' ') : open.flag_reason,
      `\n| Clocked out ${watNow()} after ${safeHours}h`,
      String(open.id),
    ]);

    await recordFromCtx(ctx, {
      action: 'CLOCK_OUT', entityType: 'ATTENDANCE', entityId: String(open.id), branchId: branch.id, businessId: open.business_id,
      before: { clock_out_at: null, hours_worked: null },
      after: { clockOutAt: nowUtc, hours: safeHours, flagged: flags.length > 0 },
    });
    ctx.json({
      ok: true, id: String(open.id), hours: safeHours,
      clockedOutAt: nowUtc,
      message: `Clocked out after ${safeHours} hour(s).${flags.length ? ` Flagged: ${flags[0]}` : ''}`,
      warnings: [ctx.get('negativeHours'), ...flags].filter(Boolean),
    });
  });

  /** Today's attendance for the branches the caller may see. */
  app.get(`${base}/attendance/today`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const branch = await resolveBranch(db, ctx, { required: false });
    const date = strField(ctx.req.queryParam('date'), { field: 'Date', maxLength: 10 }) || watToday();

    // `clock_in_at` is UTC and `date` is a WAT trading day, so the comparison
    // converts. Comparing a WAT date against a UTC timestamp puts everybody who
    // clocked in before 01:00 WAT on the wrong day.
    const dayStartUtc = watToUtc(`${date}T00:00:00`) || `${date} 00:00:00`;
    const dayEndUtc = watToUtc(`${date}T23:59:59`) || `${date} 23:59:59`;

    const where = ['a.is_deleted = 0', 'a.clock_in_at BETWEEN ? AND ?'];
    const params = [dayStartUtc, dayEndUtc];
    if (branch) { where.push('a.branch_id = ?'); params.push(String(branch.id)); }
    else {
      const f = scopeFilter(scope, { alias: 'a' });
      if (f.sql) { where.push(f.sql); params.push(...f.params); }
    }

    const rows = await db.all(`SELECT a.*, u.full_name, u.username, u.role, u.job_title, b.name AS branch_name,
          r.full_name AS reviewer_name, o.full_name AS override_by_name
        FROM staff_attendance a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN branches b ON b.id = a.branch_id
        LEFT JOIN users r ON r.id = a.reviewed_by
        LEFT JOIN users o ON o.id = a.override_by
        WHERE ${where.join(' AND ')}
        ORDER BY a.clock_in_at ASC`, params);

    // Who is expected but has not arrived. This is the half of the report that
    // matters operationally: a list of clock-ins shows who came, but not who did
    // not, and the second is what a manager acts on at 9am.
    const expectedWhere = ['u.is_deleted = 0', 'u.is_active = 1'];
    const expectedParams = [];
    if (branch) { expectedWhere.push('u.branch_id = ?'); expectedParams.push(String(branch.id)); }
    else if (!scope.allBranches && scope.branchIds) {
      const ids = [...scope.branchIds];
      expectedWhere.push(`u.branch_id IN (${ids.map(() => '?').join(',')})`);
      expectedParams.push(...ids);
    }
    const expected = await db.all(`SELECT u.id, u.full_name, u.username, u.role, u.job_title, b.name AS branch_name, b.id AS branch_id
        FROM users u LEFT JOIN branches b ON b.id = u.branch_id
        WHERE ${expectedWhere.join(' AND ')} ORDER BY u.full_name`, expectedParams);
    const presentIds = new Set(rows.map((r) => String(r.user_id)));
    const absent = expected.filter((u) => !presentIds.has(String(u.id)));

    ctx.json({
      ok: true, date, records: rows,
      summary: {
        clockedIn: rows.length,
        stillIn: rows.filter((r) => !r.clock_out_at).length,
        completed: rows.filter((r) => r.clock_out_at).length,
        flagged: rows.filter((r) => Number(r.flagged)).length,
        totalHours: round2(rows.reduce((a, r) => a + Number(r.hours_worked || 0), 0)),
        expected: expected.length,
        absent: absent.length,
      },
      absent,
      needsReview: rows.filter((r) => Number(r.flagged) && !r.reviewed_by),
    });
  });

  app.get(`${base}/attendance`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const where = ['a.is_deleted = 0', "date(a.clock_in_at, '+1 hours') BETWEEN ? AND ?"];
    const params = [from, to];
    const f = scopeFilter(scope, { alias: 'a' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }
    const userId = ctx.req.queryParam('user_id');
    if (userId) { where.push('a.user_id = ?'); params.push(String(userId)); }
    if (boolField(ctx.req.queryParam('flagged_only'))) where.push('a.flagged = 1');
    if (boolField(ctx.req.queryParam('unreviewed_only'))) where.push('a.flagged = 1 AND a.reviewed_by IS NULL');
    const whereSql = where.join(' AND ');

    const rows = await db.all(`SELECT a.*, u.full_name, u.username, u.role, b.name AS branch_name,
          r.full_name AS reviewer_name
        FROM staff_attendance a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN branches b ON b.id = a.branch_id
        LEFT JOIN users r ON r.id = a.reviewed_by
        WHERE ${whereSql} ORDER BY a.clock_in_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM staff_attendance a WHERE ${whereSql}`, params);
    const summary = await db.first(`SELECT COUNT(*) AS shifts, COALESCE(SUM(a.hours_worked),0) AS hours,
          COALESCE(SUM(a.flagged),0) AS flagged
        FROM staff_attendance a WHERE ${whereSql}`, params);
    const perUser = await db.all(`SELECT u.id AS user_id, u.full_name, COUNT(a.id) AS shifts,
          COALESCE(SUM(a.hours_worked),0) AS hours, COALESCE(SUM(a.flagged),0) AS flagged
        FROM staff_attendance a JOIN users u ON u.id = a.user_id
        WHERE ${whereSql} GROUP BY u.id ORDER BY hours DESC LIMIT 100`, params);
    ctx.json({
      ...listResponse(rows, { limit, offset }, total),
      range: { from, to },
      summary: { shifts: Number(summary.shifts) || 0, hours: round2(Number(summary.hours)), flagged: Number(summary.flagged) || 0 },
      perUser: perUser.map((r) => ({ ...r, hours: round2(Number(r.hours)) })),
    });
  });

  /**
   * Review a flagged clock-in, or correct a shift.
   *
   * An override does NOT delete the original evidence: the recorded coordinates,
   * distance and flag reason stay, and the override is stamped beside them with
   * who made it and why. Correcting a shift by rewriting it would remove the
   * thing that made the correction necessary.
   */
  app.post(`${base}/attendance/:id/review`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can review attendance.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const record = await db.first('SELECT a.*, u.full_name FROM staff_attendance a JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.is_deleted = 0', [id]);
    if (!record) throw new HttpError('That attendance record does not exist.', { status: 404, code: 'ATTENDANCE_NOT_FOUND' });

    const accepted = boolField(body.accepted ?? true, true);
    const note = strField(body.note || body.reason || body.override_reason, { field: 'Note', maxLength: 500, required: !accepted });
    if (!accepted && (!note || note.length < 6)) {
      throw new HttpError('Say why you are rejecting this clock-in, in a sentence. The staff member is entitled to know what was held against them and on what basis.', { status: 400, code: 'REASON_REQUIRED' });
    }

    // An optional correction to the hours, when the real problem was a missed
    // clock-out rather than a dishonest clock-in.
    const correctedHours = body.corrected_hours != null ? numField(body.corrected_hours, { field: 'Corrected hours', min: 0, max: 24 }) : null;
    if (correctedHours != null && !note) {
      throw new HttpError('Correcting somebody\'s hours changes what they are paid, so it needs a written reason.', { status: 400, code: 'REASON_REQUIRED' });
    }

    await db.run(`UPDATE staff_attendance SET
        reviewed_by = ?, reviewed_at = datetime('now'),
        ${accepted ? '' : 'flagged = 1,'}
        ${correctedHours != null ? 'hours_worked = ?,' : ''}
        override_by = ?, override_reason = ?,
        notes = COALESCE(notes,'') || ?,
        updated_at = datetime('now')
      WHERE id = ? AND is_deleted = 0`,
    [
      String(user.id),
      ...(correctedHours != null ? [correctedHours] : []),
      accepted && !correctedHours ? null : String(user.id),
      note || null,
      `\n| ${accepted ? 'Accepted' : 'Reviewed'} by ${user.full_name || user.username} at ${watNow()}${correctedHours != null ? ` — hours corrected from ${record.hours_worked} to ${correctedHours}` : ''}${note ? `: ${note}` : ''}`,
      id,
    ]);

    await recordFromCtx(ctx, {
      action: accepted ? 'ATTENDANCE_REVIEWED' : 'ATTENDANCE_REJECTED', entityType: 'ATTENDANCE', entityId: id,
      branchId: record.branch_id, businessId: record.business_id,
      before: { flagged: Number(record.flagged), hours_worked: record.hours_worked, reviewed_by: record.reviewed_by, flag_reason: record.flag_reason },
      after: { accepted, note, correctedHours, reviewedBy: String(user.id) },
    });
    ctx.json({
      ok: true,
      message: correctedHours != null
        ? `${record.full_name}'s shift corrected to ${correctedHours} hour(s) and ${accepted ? 'accepted' : 'reviewed'}.`
        : `${record.full_name}'s clock-in ${accepted ? 'accepted' : 'reviewed'}.${note ? ` Note: ${note}` : ''}`,
      correctedHours,
    });
  });

  /** Devices registered at a branch, with approval control. */
  app.get(`${base}/attendance/devices`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const branch = await resolveBranch(db, ctx, { required: false });
    const scope = ctx.get('scope');
    const where = ['d.is_deleted = 0']; const params = [];
    if (branch) { where.push('d.branch_id = ?'); params.push(String(branch.id)); }
    else { const f = scopeFilter(scope, { alias: 'd' }); if (f.sql) { where.push(f.sql); params.push(...f.params); } }
    const rows = await db.all(`SELECT d.*, b.name AS branch_name, r.full_name AS registered_by_name,
          CASE
            WHEN d.revoked_at IS NOT NULL THEN 'BLOCKED'
            WHEN d.registered_by IS NULL THEN 'PENDING'
            ELSE 'APPROVED'
          END AS status,
          (SELECT COUNT(*) FROM staff_attendance a WHERE a.clock_in_device_id = d.device_id AND a.is_deleted = 0) AS clock_ins,
          (SELECT MAX(a.clock_in_at) FROM staff_attendance a WHERE a.clock_in_device_id = d.device_id AND a.is_deleted = 0) AS last_seen_at
        FROM branch_devices d
        LEFT JOIN branches b ON b.id = d.branch_id
        LEFT JOIN users r ON r.id = d.registered_by
        WHERE ${where.join(' AND ')}
        ORDER BY status ASC, d.updated_at DESC`, params);
    ctx.json({ ok: true, data: rows, pending: rows.filter((r) => r.status === 'PENDING').length });
  });

  app.post(`${base}/attendance/devices/:deviceId/status`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can approve a device.', { status: 403, code: 'ROLE_REQUIRED' });
    const deviceId = String(ctx.req.param('deviceId'));
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const device = await db.first('SELECT * FROM branch_devices WHERE device_id = ? AND branch_id = ? AND is_deleted = 0', [deviceId, String(branch.id)]);
    if (!device) throw new HttpError('That device is not registered at this branch.', { status: 404, code: 'DEVICE_NOT_FOUND' });
    const status = valid(oneOf(body.status || 'APPROVED', ['APPROVED', 'BLOCKED', 'PENDING'], { field: 'Status' }), 'status');
    const label = strField(body.label, { field: 'Label', maxLength: 120 });
    const reason = strField(body.reason, { field: 'Reason', maxLength: 300, required: status === 'BLOCKED' });
    if (status === 'BLOCKED' && (!reason || reason.length < 4)) {
      throw new HttpError('Say why the device is being blocked. It is somebody\'s phone, and they are entitled to know what it was held against.', { status: 400, code: 'REASON_REQUIRED' });
    }
    const previous = device.revoked_at ? 'BLOCKED' : (device.registered_by ? 'APPROVED' : 'PENDING');
    // APPROVED  -> registered_by set, revoked_at cleared
    // BLOCKED   -> revoked_at set with the reason appended to the label
    // PENDING   -> registered_by cleared, so it returns to the approval queue
    const sets = ['updated_at = datetime(\'now\')'];
    const args = [];
    if (label) { sets.push('label = ?'); args.push(label); }
    if (status === 'APPROVED') { sets.push('registered_by = ?', 'registered_at = datetime(\'now\')', 'revoked_by = NULL', 'revoked_at = NULL'); args.push(String(user.id)); }
    if (status === 'BLOCKED') { sets.push('revoked_by = ?', 'revoked_at = datetime(\'now\')'); args.push(String(user.id)); }
    if (status === 'PENDING') { sets.push('registered_by = NULL', 'registered_at = NULL', 'revoked_by = NULL', 'revoked_at = NULL'); }
    args.push(String(device.id));
    await db.run(`UPDATE branch_devices SET ${sets.join(', ')} WHERE id = ? AND is_deleted = 0`, args);
    await recordFromCtx(ctx, {
      action: 'DEVICE_STATUS_CHANGED', entityType: 'BRANCH_DEVICE', entityId: String(device.id), branchId: branch.id,
      before: { status: previous }, after: { status, label, reason },
    });
    ctx.json({
      ok: true, previousStatus: previous, status,
      message: status === 'APPROVED'
        ? `Device approved at ${branch.name}. Clock-ins from it will no longer be flagged as unregistered.`
        : status === 'BLOCKED'
          ? `Device blocked. Clock-ins from it will be flagged — but still accepted, because blocking a device must not stop somebody recording that they came to work.`
          : 'Device returned to pending.',
    });
  });

  /** Branch geofence configuration. */
  app.put(`${base}/attendance/geofence`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can change a branch geofence.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const lat = body.latitude != null ? Number(body.latitude) : Number(branch.latitude);
    const lng = body.longitude != null ? Number(body.longitude) : Number(branch.longitude);
    const radius = numField(body.geofence_radius_meters ?? body.radius ?? branch.geofence_radius_meters ?? 150, { field: 'Fence radius', min: 0, max: 50000, whole: true });

    // A branch pin of (91, 200) — or the classic swapped pair — would
    // mis-classify every clock-in after it, so unlike a clock-in this is
    // REFUSED rather than flagged: there is nobody to review a setting.
    //
    // `coordinatesArePlausible` returns an OBJECT. Testing it directly is always
    // truthy, which is how this guard spent its life accepting anything at all.
    // Read the field.
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      const plausibility = coordinatesArePlausible(lat, lng);
      if (!plausibility.plausible) {
        throw new HttpError(
          `(${lat}, ${lng}) is not a plausible position on Earth: ${plausibility.reason} Latitude must be between -90 and 90 and longitude between -180 and 180 — check that they are not the wrong way round.`,
          { status: 400, code: 'IMPLAUSIBLE_COORDINATES', fields: { latitude: 'Between -90 and 90', longitude: 'Between -180 and 180' } },
        );
      }
    }
    if ((Number.isFinite(lat) && !Number.isFinite(lng)) || (!Number.isFinite(lat) && Number.isFinite(lng))) {
      throw new HttpError('Supply both a latitude and a longitude, or neither. One without the other cannot place the branch.', { status: 400, code: 'INCOMPLETE_COORDINATES' });
    }
    if (lat === 0 && lng === 0) {
      throw new HttpError('(0, 0) is in the Atlantic off the coast of Ghana — that is what an unset GPS reports, not a branch. Stand at the shop and use “where I am now”, or enter the coordinates by hand.', { status: 400, code: 'IMPLAUSIBLE_COORDINATES' });
    }
    if (radius > 0 && radius < 50) {
      // A fence tighter than GPS accuracy produces a stream of false "outside"
      // flags, which trains managers to ignore all of them.
      ctx.set('radiusWarning', `A ${radius}m fence is tighter than typical phone GPS accuracy (10-50m outdoors, much worse indoors). Expect false flags; 150-300m is more realistic for a shop.`);
    }
    const mode = valid(oneOf(body.attendance_mode || branch.attendance_mode || 'GEOLOCATION', ['GEOLOCATION', 'REGISTERED_DEVICE'], { field: 'Attendance mode' }), 'attendance_mode');

    const before = { latitude: branch.latitude, longitude: branch.longitude, radius: branch.geofence_radius_meters, mode: branch.attendance_mode };
    await db.run(`UPDATE branches SET latitude = ?, longitude = ?, geofence_radius_meters = ?, attendance_mode = ?, updated_at = datetime('now') WHERE id = ?`,
      [lat || null, lng || null, radius, mode, String(branch.id)]);
    await recordFromCtx(ctx, {
      action: 'GEOFENCE_UPDATED', entityType: 'BRANCH', entityId: String(branch.id), branchId: branch.id, businessId: branch.business_id,
      before, after: { lat, lng, radius, mode },
    });
    ctx.json({
      ok: true,
      message: `${branch.name}'s geofence set to ${radius}m around (${lat}, ${lng}) in ${mode === 'GEOLOCATION' ? 'geolocation' : 'registered-device'} mode.`,
      warnings: [ctx.get('radiusWarning')].filter(Boolean),
      // How far the current stored point is from what was just saved, so the
      // manager can see the effect immediately rather than at the next clock-in.
      distanceFromPrevious: before.latitude && before.longitude ? round2(haversineMeters(before.latitude, before.longitude, lat, lng)) : null,
    });
  });
}

module.exports = { mount, CLOCK_METHODS };
