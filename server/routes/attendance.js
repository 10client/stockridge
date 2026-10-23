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
const { resolveBranch, resolveBusiness, scopeFilter, pagination, listResponse, dateRange, numField, strField, boolField, valid, inScope } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday, utcToWat, watToUtc, minutesBetween, utcNow, claimedWatToUtcSql } = require('../../domain/time');
const { trustedReplay } = require('../lib/replay');
const { classifyAttendance, hoursBetween, coordinatesArePlausible, haversineMeters, LOCATION_STATUS, DEVICE_STATUS } = require('../../domain/geofence');
const { oneOf } = require('../../domain/validation');

// `staff_attendance.clock_in_method` is constrained to these three. A method
// the schema does not allow would be refused by the CHECK constraint at insert
// time, which is the worst moment to discover it — at the door, mid-shift.
const CLOCK_METHODS = ['GEOLOCATION', 'REGISTERED_DEVICE', 'MANUAL'];
const CLOCK_SKEW_MINUTES = 10;

/**
 * The instant a clock-in or clock-out happened, as SQLite UTC.
 *
 * Online, the server clock wins. A phone whose clock is wrong must not invent
 * a shift, so a claimed time is kept only when it is within ten minutes, or
 * when this request is a signed sync replay of a button pressed offline. The
 * queued stamp is the moment they pressed it; replaying it hours later must
 * not rewrite the shift to whenever the signal came back.
 */
async function resolveClockUtc(ctx, body) {
  const claimed = body && (body.clocked_at || body.clockedAt);
  const utc = claimed ? claimedWatToUtcSql(claimed) : null;
  if (utc) {
    const gap = minutesBetween(utc, utcNow());
    const near = gap != null && Math.abs(gap) <= CLOCK_SKEW_MINUTES;
    if (near || await trustedReplay(ctx)) return utc;
  }
  return watToUtc(watNow()) || utcNow();
}

function lagosTime(utcSql) {
  const wat = utcToWat(utcSql);
  return wat ? wat.slice(11, 16) : '';
}


async function loadAttendance(db, id) {
  return db.first(`SELECT a.*, u.full_name, u.username, b.name AS branch_name
      FROM staff_attendance a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN branches b ON b.id = a.branch_id
      WHERE a.id = ? AND a.is_deleted = 0`, [String(id)]);
}

function assertCanSeeAttendance(ctx, record) {
  const user = ctx.get('user');
  if (String(record.user_id) === String(user.id)) return;
  if (!inScope(ctx.get('scope'), record)) {
    throw new HttpError('That attendance record is outside your branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
  }
}

/**
 * Close an open shift, or correct one that is already closed.
 *
 * `nowOnly` is the header button: the server clock, this person's own open
 * row, no typed hours. The table sends the row id and, for a manager, the
 * time they left and the hours to count. Either way the row gets a
 * clock-out, so the one-open-shift rule releases and they can clock in again.
 */
async function applyClockOut(db, ctx, record, body, { nowOnly = false } = {}) {
  const user = ctx.get('user');
  const manager = atLeast(user.role, 'MANAGER');
  const mine = String(record.user_id) === String(user.id);
  const open = !record.clock_out_at;
  const note = strField(body.note || body.notes || body.reason, { field: 'Reason', maxLength: 500 });
  const hoursSent = !nowOnly && body.hours_worked != null && String(body.hours_worked).trim() !== '';
  const timeSent = !nowOnly && body.clock_out_at != null && String(body.clock_out_at).trim() !== '';
  const controlling = timeSent || hoursSent || !open;

  if (!mine && !manager) {
    throw new HttpError('You can only clock out your own shift.', { status: 403, code: 'ROLE_REQUIRED' });
  }
  if (!open && !manager) {
    throw new HttpError('This shift is already closed. A manager can correct it from the attendance table.', { status: 409, code: 'ALREADY_CLOCKED_OUT' });
  }
  if (controlling && !manager) {
    throw new HttpError('A manager sets the leaving time and the hours from the attendance table. You can clock out now.', { status: 403, code: 'ROLE_REQUIRED' });
  }
  if (controlling && (!note || note.length < 6)) {
    throw new HttpError('Say why this shift is being closed or corrected, in a sentence. The hours are what they are paid, so the reason stays on the row.', { status: 400, code: 'REASON_REQUIRED' });
  }

  let outUtc;
  if (timeSent) {
    outUtc = claimedWatToUtcSql(body.clock_out_at);
    if (!outUtc) throw new HttpError('That clock-out time is not a time.', { status: 400, code: 'CLOCK_OUT_TIME' });
    const ahead = minutesBetween(outUtc, utcNow());
    if (ahead != null && ahead < -CLOCK_SKEW_MINUTES) {
      throw new HttpError('A clock-out cannot be in the future.', { status: 400, code: 'CLOCK_OUT_TIME' });
    }
  } else if (open) {
    outUtc = await resolveClockUtc(ctx, nowOnly ? body : {});
  } else {
    outUtc = record.clock_out_at;
  }
  const gapMin = minutesBetween(record.clock_in_at, outUtc);
  if (gapMin == null || gapMin < 0) {
    throw new HttpError(`The clock-out has to be after the clock-in (${utcToWat(record.clock_in_at) || record.clock_in_at}). The row stays open until the times agree.`, { status: 400, code: 'CLOCK_OUT_BEFORE_IN' });
  }
  const span = hoursBetween(record.clock_in_at, outUtc) || 0;
  const counted = hoursSent
    ? numField(body.hours_worked, { field: 'Hours', min: 0, max: 36 })
    : round2(span);
  const flags = [];
  if (counted > 16) {
    flags.push(`This shift counts ${counted} hours, which usually means a missed clock-out rather than a real shift. Correct it from the attendance table.`);
  }
  if (hoursSent && Math.abs(counted - span) > 0.25) {
    flags.push(`Hours counted (${counted}) are not the span from clock-in to clock-out (${round2(span)}).`);
  }
  if (Number(record.flagged) && record.flag_reason && !flags.includes(record.flag_reason)) flags.push(record.flag_reason);
  const who = user.full_name || user.username;
  const line = open
    ? `\n| Clocked out ${watNow()} by ${who}${controlling ? ' from the attendance table' : ''} after ${counted}h${note ? ` — ${note}` : ''}`
    : `\n| Corrected ${watNow()} by ${who}: clock-out ${utcToWat(record.clock_out_at) || record.clock_out_at} → ${utcToWat(outUtc) || outUtc}, hours ${record.hours_worked} → ${counted}${note ? ` — ${note}` : ''}`;
  const reason = flags.length ? flags.join(' ').slice(0, 500) : record.flag_reason;

  await db.run(`UPDATE staff_attendance SET clock_out_at = ?, hours_worked = ?, flagged = ?,
      flag_reason = ?, override_by = ?, override_reason = ?,
      notes = COALESCE(notes,'') || ?, updated_at = datetime('now')
    WHERE id = ? AND is_deleted = 0`, [
    outUtc, counted,
    flags.length ? 1 : Number(record.flagged),
    reason,
    controlling ? String(user.id) : record.override_by,
    controlling ? (note || null) : record.override_reason,
    line,
    String(record.id),
  ]);

  await recordFromCtx(ctx, {
    action: open ? 'CLOCK_OUT' : 'ATTENDANCE_REVIEWED',
    entityType: 'ATTENDANCE',
    entityId: String(record.id),
    branchId: record.branch_id,
    businessId: record.business_id,
    before: { clock_out_at: record.clock_out_at, hours_worked: record.hours_worked },
    after: { clockOutAt: outUtc, hours: counted, flagged: flags.length > 0, note: note || null },
  });

  const name = record.full_name || 'This shift';
  const flagged = flags.length ? ` Flagged: ${flags[0]}` : '';
  return {
    ok: true,
    id: String(record.id),
    hours: counted,
    clockedOutAt: outUtc,
    message: open && !controlling
      ? `Clocked out at ${lagosTime(outUtc)} after ${counted} hour(s).${flagged}`
      : (open
        ? `${name} clocked out. ${counted} hour(s) counted.${flagged}`
        : `${name}'s shift corrected to ${counted} hour(s). The earlier times stay in the notes.`),
    warnings: flags,
  };
}

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

    // A pinned cashier has a shop on the account, and resolveBranch will not
    // let the body name a different one. A general manager has no pin and
    // reaches more than one shop, so the request has to name the shop they
    // picked. Guessing would put the hours on the wrong shop. The name is
    // accepted only when that shop is in their scope.
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
        `You are still clocked in since ${utcToWat(open.clock_in_at) || open.clock_in_at}. A new day does not close a shift. Clock it out from the attendance table — the row stays there until it is closed.`,
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
    const nowUtc = await resolveClockUtc(ctx, body);

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
      //
      // THE VALUE COMPARED HERE IS THE ONE THE CLASSIFIER ACTUALLY RETURNS. This guard read
      // `'UNREGISTERED'`, a spelling that appears NOWHERE else in the product: the classifier
      // answers REGISTERED / UNRECOGNIZED / NOT_APPLICABLE (domain/geofence.js:67), so the
      // branch below was dead code and a first-seen machine was never registered. The effect
      // is the exact opposite of the comment: the device list stayed empty, no manager could
      // ever approve the machine, and every shift from it was flagged for ever — the flag
      // nobody can clear is the flag everybody learns to ignore. Found by audit.staff, which
      // looked for the pending device it had just clocked in from and found none.
      if (deviceId && classification.deviceStatus === DEVICE_STATUS.UNRECOGNIZED) {
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
      clockedInAt: nowUtc, clockedInAtWat: utcToWat(nowUtc),
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
        ? `Clocked in at ${branch.name} at ${lagosTime(nowUtc)} — but this needs a manager's review: ${flags[0]}`
        : `Clocked in at ${branch.name} at ${lagosTime(nowUtc)}.${fence > 0 ? ` Position confirmed within the ${fence}m fence.` : ''}`,
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
    await resolveBranch(db, ctx);
    const open = await db.first('SELECT id FROM staff_attendance WHERE user_id = ? AND clock_in_at IS NOT NULL AND clock_out_at IS NULL AND is_deleted = 0 ORDER BY clock_in_at DESC LIMIT 1',
      [String(user.id)]);
    if (!open) {
      throw new HttpError('You are not clocked in, so there is no shift to close. If you clocked in on an earlier day, the row is still on the attendance table — close it there.', { status: 409, code: 'NOT_CLOCKED_IN' });
    }
    const record = await loadAttendance(db, open.id);
    ctx.json(await applyClockOut(db, ctx, record, body, { nowOnly: true }));
  });

  /**
   * Close or correct one row from the attendance table.
   *
   * A shift does not end because the day did. After midnight it leaves Today,
   * and the only clock-out button used to leave with it, while a new clock-in
   * was refused because the old row was still open. The table is where that
   * row is closed. The person can clock themselves out now. A manager can set
   * the time they actually left and the hours to count, including on a row
   * that is already closed, so a forgotten clock-out is not paid as a day and
   * a night. The original times stay in the notes.
   */
  app.post(`${base}/attendance/:id/clock-out`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const record = await loadAttendance(db, id);
    if (!record) throw new HttpError('That attendance record does not exist.', { status: 404, code: 'ATTENDANCE_NOT_FOUND' });
    assertCanSeeAttendance(ctx, record);
    ctx.json(await applyClockOut(db, ctx, record, body, { nowOnly: false }));
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

    const user = ctx.get('user');
    const openWhere = ['a.is_deleted = 0', 'a.clock_out_at IS NULL', 'a.clock_in_at < ?'];
    const openParams = [dayStartUtc];
    if (branch) { openWhere.push('a.branch_id = ?'); openParams.push(String(branch.id)); }
    else {
      const openScope = scopeFilter(scope, { alias: 'a' });
      if (openScope.sql) { openWhere.push(openScope.sql); openParams.push(...openScope.params); }
    }
    const stillOpen = await db.all(`SELECT a.*, u.full_name, u.username, u.role, u.job_title, b.name AS branch_name
        FROM staff_attendance a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN branches b ON b.id = a.branch_id
        WHERE ${openWhere.join(' AND ')}
        ORDER BY a.clock_in_at ASC LIMIT 50`, openParams);
    const myOpen = user
      ? await db.first(`SELECT a.*, u.full_name, u.username, u.role, u.job_title, b.name AS branch_name
          FROM staff_attendance a
          JOIN users u ON u.id = a.user_id
          LEFT JOIN branches b ON b.id = a.branch_id
          WHERE a.user_id = ? AND a.clock_in_at IS NOT NULL AND a.clock_out_at IS NULL AND a.is_deleted = 0
          ORDER BY a.clock_in_at DESC LIMIT 1`, [String(user.id)])
      : null;
    if (myOpen && String(myOpen.clock_in_at) < String(dayStartUtc) && !stillOpen.some((row) => String(row.id) === String(myOpen.id))) {
      stillOpen.unshift(myOpen);
    }

    ctx.json({
      ok: true, date, records: rows, myOpen: myOpen || null, stillOpen,
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
    const openWhere = ['a.is_deleted = 0', 'a.clock_out_at IS NULL'];
    const openParams = [];
    const openScope = scopeFilter(scope, { alias: 'a' });
    if (openScope.sql) { openWhere.push(openScope.sql); openParams.push(...openScope.params); }
    const stillOpen = await db.all(`SELECT a.*, u.full_name, u.username, u.role, b.name AS branch_name
        FROM staff_attendance a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN branches b ON b.id = a.branch_id
        WHERE ${openWhere.join(' AND ')}
        ORDER BY a.clock_in_at ASC LIMIT 50`, openParams);
    ctx.json({
      ...listResponse(rows, { limit, offset }, total),
      stillOpen,
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
    // `branch_devices` carries no `business_id` of its own — the business is the branch's — so a
    // business clause here is the same 500 the serial register had ("no such column:
    // d.business_id"), met by a manager looking at the devices registered at their branches.
    else { const f = scopeFilter(scope, { alias: 'd', businessViaBranches: true }); if (f.sql) { where.push(f.sql); params.push(...f.params); } }
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
