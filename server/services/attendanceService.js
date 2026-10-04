// =====================================================================
// StockRidge — ATTENDANCE
// =====================================================================
// Carried over from PharmaRidge with the policy decision kept intact, because
// the decision is the feature:
//
//   THE VERIFICATION IS A SIGNAL, NEVER A GATE.
//
// An off-site or no-location clock-in is FLAGGED for manager review, never
// rejected. Every reason is real on a Nigerian shop floor: GPS permissions are
// permanently denied by a large share of users; a showroom inside a mall or
// under a metal roof may never get a fix; cheap handsets report wildly
// inaccurate positions indoors; data is off at the exact moment of clock-in.
// Rejecting a clock-in for any of those means a cashier cannot start their
// shift — and the workaround they find is a buddy punching in from inside the
// shop, which defeats the control AND loses the audit trail.
//
// TWO VERIFICATION MODES, chosen per branch by the manager, because different
// branches genuinely need different methods:
//   GEOLOCATION       for mobile/handheld/delivery staff — classified against
//                     the branch geofence (Haversine, shared/geo.js).
//   REGISTERED_DEVICE for branches with fixed till laptops — classified by
//                     whether the browser's persistent device id matches one
//                     the manager registered for THIS branch. Not a hardware
//                     serial: no browser can read one, and claiming otherwise
//                     would be a security lie. It identifies "this browser
//                     profile on this machine", which is the same guarantee
//                     commercial POS terminal-locking relies on.
//
// WHAT IS NEW: branch_shifts makes "late" a computed fact rather than an
// opinion, with a grace period — because a 10-minute grace absorbs traffic and
// a zero-minute grace produces a late register nobody believes.
//
// ONE OPEN CLOCK-IN PER USER, enforced by a partial unique index. A double
// clock-in would either create two overlapping shifts or silently close the
// first, and both corrupt the hours report.
// =====================================================================

const { newId, watNowIso, watDate } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const { classifyLocation } = require('../lib/geo');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { getUnitSettings, assertSubscribed } = require('../lib/planLimits');
const { capabilitiesOf, assertCapability } = require('../lib/capabilities');

async function openClock(db, ctx, { branchId = null, latitude = null, longitude = null, deviceId = null, shiftType = null, note = null }) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'clock in' });
  assertCapability(settings, 'attendance', { action: 'clock in' });

  const bid = branchId || ctx.user.branch_id;
  if (!bid) throw new HttpError(400, 'You are not attached to a branch, so choose which one you are clocking into.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, bid);
  const branch = await db.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0 AND is_active = 1').bind(bid).first();
  if (!branch) throw new HttpError(404, 'That branch was not found or is not active.', 'BRANCH_NOT_FOUND');

  const existing = await db.prepare('SELECT id, clock_in_at, branch_id FROM staff_attendance WHERE user_id = ? AND clock_out_at IS NULL AND is_deleted = 0').bind(ctx.user.id).first();
  if (existing) {
    const otherBranch = existing.branch_id !== bid ? await db.prepare('SELECT name FROM branches WHERE id = ?').bind(existing.branch_id).first() : null;
    throw new HttpError(409,
      `You are already clocked in since ${existing.clock_in_at}${otherBranch ? ` at ${otherBranch.name}` : ''}. Clock out before clocking in again — two overlapping shifts would make your hours meaningless.`,
      'ALREADY_CLOCKED_IN');
  }

  // Device matching, for REGISTERED_DEVICE branches. A laptop that cannot move
  // is identified by its browser device id — see the header comment for what
  // that is and is not.
  let deviceMatched = null;
  const did = deviceId || ctx.deviceId || null;
  if (String(branch.attendance_mode).toUpperCase() === 'REGISTERED_DEVICE') {
    if (!did) {
      deviceMatched = false;
    } else {
      const registered = await db.prepare(`
        SELECT id FROM branch_devices
        WHERE device_id = ? AND branch_id = ? AND is_deleted = 0 AND revoked_at IS NULL
      `).bind(did, bid).first();
      deviceMatched = !!registered;
      if (registered) {
        await db.prepare(`UPDATE branch_devices SET last_seen_at = ? WHERE device_id = ? AND revoked_at IS NULL`).bind(watNowIso(), did).run();
      }
    }
  }

  const classification = classifyLocation({
    branch, latitude, longitude, deviceMatched,
    attendanceMode: branch.attendance_mode,
  });

  // LATENESS is computed against the branch's shift definition, with a grace
  // period. A grace absorbs traffic; no grace produces a late register that
  // everybody disputes and therefore nobody reads.
  const now = new Date();
  const watClock = watNowIso(now);
  const workDate = watDate(now);
  const timeOfDay = watClock.slice(11, 16);
  const shift = await db.prepare(`
    SELECT * FROM branch_shifts
    WHERE branch_id = ? AND is_active = 1 AND is_deleted = 0
      AND (',' || days_of_week || ',') LIKE ('%,' || CAST(((CAST(strftime('%w','now') AS INTEGER) + 6) % 7) + 1) AS TEXT) || ',%')
    ORDER BY
      -- The shift whose start is closest at-or-before now, so a 2pm clock-in
      -- on a morning/afternoon split lands in the afternoon shift.
      CASE WHEN start_time <= ? THEN 0 ELSE 1 END, start_time DESC
    LIMIT 1
  `).bind(bid, timeOfDay).first();

  let isLate = 0;
  let lateMinutes = 0;
  if (shift) {
    const grace = Number(shift.grace_minutes) || 0;
    const [sh, sm] = String(shift.start_time).split(':').map(Number);
    const [nh, nm] = timeOfDay.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const nowMins = nh * 60 + nm;
    const diff = nowMins - startMins;
    if (diff > grace) { isLate = 1; lateMinutes = diff; }
  }

  const ts = watNowIso();
  const id = newId();
  await db.prepare(`
    INSERT INTO staff_attendance (
      id, business_unit_id, user_id, branch_id, work_date, clock_in_at,
      in_latitude, in_longitude, in_distance_meters, in_location_status,
      device_id, device_matched, needs_review, shift_type, is_late, late_minutes, note,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, businessUnitId, ctx.user.id, bid, workDate, ts,
    latitude != null ? Number(latitude) : null, longitude != null ? Number(longitude) : null,
    classification.distance_meters, classification.status,
    did, deviceMatched == null ? null : (deviceMatched ? 1 : 0),
    classification.needs_review, shiftType ? String(shiftType).toUpperCase() : (shift ? shift.shift_type : null),
    isLate, lateMinutes, note ? String(note).slice(0, 500) : null, ts, ts
  ).run();

  await writeAudit(db, {
    businessUnitId, branchId: bid, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'CLOCK_IN', entityType: 'ATTENDANCE', entityId: id,
    after: { location_status: classification.status, distance_meters: classification.distance_meters, needs_review: classification.needs_review, is_late: isLate },
    ipAddress: ctx.ipAddress, deviceId: did,
  });

  // The response tells the person what happened and what to do about it.
  // "FLAGGED" without an explanation produces a phone call to the manager;
  // "flagged because we could not get a location" does not.
  let advisory = null;
  if (classification.status === 'OFF_SITE') {
    advisory = `You clocked in ${classification.distance_meters} m from ${branch.name}, outside its ${classification.radius_meters} m boundary. It has been recorded and flagged for your manager to review — it has NOT been rejected. If the location is wrong, ask your manager to set the branch's GPS position and boundary radius.`;
  } else if (classification.status === 'NO_LOCATION') {
    advisory = classification.reason === 'BRANCH_GEOFENCE_NOT_CONFIGURED'
      ? 'This branch has no GPS position set yet, so your clock-in could not be location-checked. It is recorded normally and flagged once — ask a manager to set the branch location under Branches.'
      : 'No location was available, so your clock-in could not be location-checked. It is recorded and flagged for review, not rejected. Allow location access in your browser settings to avoid the flag.';
  } else if (classification.status === 'DEVICE_UNRECOGNIZED') {
    advisory = 'This device is not registered to this branch, so your clock-in is flagged for review. It is NOT rejected. If this is your usual machine, ask a manager to register it under Branches → Devices.';
  }
  if (isLate) advisory = `${advisory ? advisory + ' ' : ''}You clocked in ${lateMinutes} minute${lateMinutes === 1 ? '' : 's'} after the ${shift ? shift.name : 'shift'} start, past the grace period.`;

  return {
    ok: true, id, work_date: workDate, clock_in_at: ts, branch_id: bid, branch_name: branch.name,
    location_status: classification.status, distance_meters: classification.distance_meters,
    needs_review: !!classification.needs_review, is_late: !!isLate, late_minutes: lateMinutes,
    shift: shift ? { name: shift.name, start_time: shift.start_time, end_time: shift.end_time, grace_minutes: shift.grace_minutes } : null,
    advisory,
  };
}

async function closeClock(db, ctx, { latitude = null, longitude = null, deviceId = null, breakMinutes = 0, note = null }) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertCapability(settings, 'attendance', { action: 'clock out' });

  const open = await db.prepare(`
    SELECT sa.*, b.latitude AS b_lat, b.longitude AS b_lng, b.geofence_radius_meters, b.attendance_mode, b.name AS branch_name
    FROM staff_attendance sa JOIN branches b ON b.id = sa.branch_id
    WHERE sa.user_id = ? AND sa.clock_out_at IS NULL AND sa.is_deleted = 0
  `).bind(ctx.user.id).first();
  if (!open) throw new HttpError(404, 'You are not currently clocked in.', 'NOT_CLOCKED_IN');

  const classification = classifyLocation({
    branch: { latitude: open.b_lat, longitude: open.b_lng, geofence_radius_meters: open.geofence_radius_meters, attendance_mode: open.attendance_mode },
    latitude, longitude,
    deviceMatched: open.device_matched == null ? null : !!open.device_matched,
    attendanceMode: open.attendance_mode,
  });

  const ts = watNowIso();
  const inMs = Date.parse(String(open.clock_in_at).replace(' ', 'T') + 'Z');
  const outMs = Date.parse(ts.replace(' ', 'T') + 'Z');
  const grossMinutes = Number.isFinite(inMs) && Number.isFinite(outMs) ? Math.max(0, Math.round((outMs - inMs) / 60000)) : null;
  const breaks = Math.max(0, Math.min(Number(breakMinutes) || 0, grossMinutes == null ? 0 : grossMinutes));
  const hoursWorked = grossMinutes == null ? null : round2((grossMinutes - breaks) / 60);

  // A shift longer than 18 hours is almost certainly a forgotten clock-out,
  // not a genuine shift. Flag it rather than silently recording 26 hours of
  // labour, which would corrupt the hours report and any wage calculation
  // built on it.
  const suspiciouslyLong = grossMinutes != null && grossMinutes > 18 * 60;

  await db.prepare(`
    UPDATE staff_attendance SET
      clock_out_at = ?, out_latitude = ?, out_longitude = ?, out_distance_meters = ?, out_location_status = ?,
      hours_worked = ?, break_minutes = ?,
      needs_review = CASE WHEN ? THEN 1 ELSE needs_review END,
      note = COALESCE(note || ' | ','') || ?, updated_at = ?
    WHERE id = ?
  `).bind(
    ts,
    latitude != null ? Number(latitude) : null, longitude != null ? Number(longitude) : null,
    classification.distance_meters, classification.status, hoursWorked, breaks,
    (classification.needs_review || suspiciouslyLong) ? 1 : 0,
    [note, suspiciouslyLong ? `Shift recorded as ${Math.round(grossMinutes / 60)} hours — likely a forgotten clock-out.` : null].filter(Boolean).join(' | ').slice(0, 500),
    ts, open.id
  ).run();

  await writeAudit(db, {
    businessUnitId, branchId: open.branch_id, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'CLOCK_OUT', entityType: 'ATTENDANCE', entityId: open.id,
    after: { hours_worked: hoursWorked, location_status: classification.status, suspiciously_long: suspiciouslyLong },
    ipAddress: ctx.ipAddress, deviceId: deviceId || ctx.deviceId,
  });

  return {
    ok: true, id: open.id, work_date: open.work_date,
    clock_in_at: open.clock_in_at, clock_out_at: ts,
    hours_worked: hoursWorked, break_minutes: breaks,
    out_location_status: classification.status, needs_review: !!(classification.needs_review || suspiciouslyLong),
    advisory: suspiciouslyLong
      ? `That shift is recorded as ${Math.round(grossMinutes / 60)} hours. If you forgot to clock out yesterday, ask a manager to correct it — otherwise the hours report will show you working more than a day.`
      : (classification.status === 'OFF_SITE' ? `You clocked out ${classification.distance_meters} m from ${open.branch_name}. Flagged for review, not rejected.` : null),
  };
}

// MANAGER REVIEW. The flag is meaningless unless somebody can clear it, and
// clearing it must itself be recorded — an override that leaves no trace is an
// override that can be abused.
async function review(db, ctx, { attendanceId, decision, note = null, correctedHours = null }) {
  const a = await db.prepare('SELECT * FROM staff_attendance WHERE id = ? AND is_deleted = 0').bind(attendanceId).first();
  if (!a) throw new HttpError(404, 'That attendance record was not found.', 'ATTENDANCE_NOT_FOUND');
  assertBranchAccess(ctx.user, a.branch_id);
  const role = String(ctx.user.role).toUpperCase();
  if (role === 'STAFF') throw new HttpError(403, 'Only a manager can review an attendance flag.', 'ATTENDANCE_REVIEW_FORBIDDEN');

  const d = String(decision).toUpperCase();
  if (!['APPROVED', 'REJECTED', 'OVERRIDE_APPROVED'].includes(d)) throw new HttpError(400, 'Decision must be APPROVED, REJECTED or OVERRIDE_APPROVED.', 'ATTENDANCE_DECISION_INVALID');
  if (d === 'OVERRIDE_APPROVED' && (!note || String(note).trim().length < 5)) {
    throw new HttpError(400,
      'An override needs a written reason of at least 5 characters. Overriding a location or device flag is exactly the action an auditor will look for, and an unexplained one is indistinguishable from covering for a friend.',
      'ATTENDANCE_OVERRIDE_REASON_REQUIRED');
  }

  const ts = watNowIso();
  const hours = correctedHours != null ? round2(Math.max(0, Math.min(24, Number(correctedHours)))) : Number(a.hours_worked);
  await db.prepare(`
    UPDATE staff_attendance SET
      review_status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?,
      override_by = CASE WHEN ? = 'OVERRIDE_APPROVED' THEN ? ELSE override_by END,
      hours_worked = COALESCE(?, hours_worked), needs_review = 0, updated_at = ?
    WHERE id = ?
  `).bind(d, ctx.user.id, ts, note ? String(note).slice(0, 500) : null, d, ctx.user.id,
    correctedHours != null ? hours : null, ts, attendanceId).run();

  await writeAudit(db, {
    businessUnitId: a.business_unit_id, branchId: a.branch_id, userId: ctx.user.id, actorRole: role,
    action: `ATTENDANCE_${d}`, entityType: 'ATTENDANCE', entityId: attendanceId,
    reason: note ? String(note).slice(0, 500) : null,
    before: { needs_review: a.needs_review, in_location_status: a.in_location_status, hours_worked: a.hours_worked },
    after: { review_status: d, hours_worked: hours },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: attendanceId, review_status: d, hours_worked: hours };
}

async function pendingReview(db, { businessUnitId, branchId = null, limit = 100 }) {
  const rows = await db.prepare(`
    SELECT sa.*, u.full_name AS user_name, u.role, u.job_title, b.name AS branch_name
    FROM staff_attendance sa
    JOIN users u ON u.id = sa.user_id
    JOIN branches b ON b.id = sa.branch_id
    WHERE sa.needs_review = 1 AND sa.is_deleted = 0 AND sa.business_unit_id = ?
      ${branchId ? 'AND sa.branch_id = ?' : ''}
    ORDER BY sa.clock_in_at DESC LIMIT ?
  `).bind(businessUnitId, ...(branchId ? [branchId] : []), Math.min(500, Number(limit) || 100)).all();

  const byReason = { OFF_SITE: 0, NO_LOCATION: 0, DEVICE_UNRECOGNIZED: 0, OTHER: 0 };
  for (const r of rows.results) {
    const key = byReason[r.in_location_status] !== undefined ? r.in_location_status : 'OTHER';
    byReason[key] += 1;
  }
  return {
    results: rows.results,
    count: rows.results.length,
    by_reason: byReason,
    // A queue dominated by NO_LOCATION is a SETUP problem, not a staff
    // problem, and the manager needs to be told which — otherwise they will
    // spend the morning suspecting honest people.
    advisory: byReason.NO_LOCATION > byReason.OFF_SITE + byReason.DEVICE_UNRECOGNIZED && rows.results.length > 3
      ? 'Most of these flags are missing locations, not off-site readings. That is usually a setup problem: either the branch GPS position is not set, or staff browsers have location permission denied. Fix the setup before treating these as conduct issues.'
      : null,
  };
}

async function timesheet(db, { businessUnitId, branchId = null, userId = null, startDate, endDate }) {
  const where = ['sa.is_deleted = 0', 'sa.business_unit_id = ?', 'sa.work_date BETWEEN ? AND ?'];
  const params = [businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10)];
  if (branchId) { where.push('sa.branch_id = ?'); params.push(branchId); }
  if (userId) { where.push('sa.user_id = ?'); params.push(userId); }

  const rows = await db.prepare(`
    SELECT sa.*, u.full_name AS user_name, u.role, u.job_title, b.name AS branch_name,
           r.full_name AS reviewed_by_name
    FROM staff_attendance sa
    JOIN users u ON u.id = sa.user_id
    JOIN branches b ON b.id = sa.branch_id
    LEFT JOIN users r ON r.id = sa.reviewed_by
    WHERE ${where.join(' AND ')}
    ORDER BY sa.work_date ASC, u.full_name ASC
    LIMIT 5000
  `).bind(...params).all();

  const byUser = new Map();
  for (const r of rows.results) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, { user_id: r.user_id, user_name: r.user_name, role: r.role, branch_name: r.branch_name, days: 0, hours: 0, late_count: 0, flagged_count: 0, overrides: 0, records: [] });
    }
    const u = byUser.get(r.user_id);
    u.days += 1;
    u.hours = round2(u.hours + Number(r.hours_worked || 0));
    u.late_count += r.is_late ? 1 : 0;
    u.flagged_count += r.needs_review ? 1 : 0;
    u.overrides += r.review_status === 'OVERRIDE_APPROVED' ? 1 : 0;
    u.records.push(r);
  }

  const summary = [...byUser.values()].map((u) => ({ ...u, average_hours_per_day: u.days > 0 ? round2(u.hours / u.days) : 0 }));
  return {
    period: { start: String(startDate).slice(0, 10), end: String(endDate).slice(0, 10) },
    total_hours: round2(summary.reduce((a, u) => a + u.hours, 0)),
    total_days: summary.reduce((a, u) => a + u.days, 0),
    late_total: summary.reduce((a, u) => a + u.late_count, 0),
    flagged_total: summary.reduce((a, u) => a + u.flagged_count, 0),
    by_user: summary,
  };
}

// ---------------------------------------------------------------------
// DEVICES  (REGISTERED_DEVICE mode)
// ---------------------------------------------------------------------
async function registerDevice(db, ctx, { branchId = null, deviceId, label = null, deviceType = 'TILL' }) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertCapability(settings, 'attendance', { action: 'register a device' });
  const bid = branchId || ctx.user.branch_id;
  if (!bid) throw new HttpError(400, 'Choose which branch this device belongs to.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, bid);
  const role = String(ctx.user.role).toUpperCase();
  if (role === 'STAFF') throw new HttpError(403, 'Only a manager can register a device to a branch — a device registration is what makes clock-ins trustworthy there.', 'DEVICE_REGISTRATION_FORBIDDEN');

  if (!deviceId || String(deviceId).trim().length < 8) {
    throw new HttpError(400, 'A device id is required. Open this page on the machine you want to register — the app generates the id itself.', 'DEVICE_ID_REQUIRED');
  }
  const dt = String(deviceType || 'TILL').toUpperCase();
  if (!['TILL', 'BACK_OFFICE', 'HANDHELD', 'TABLET', 'OTHER'].includes(dt)) throw new HttpError(400, 'Device type must be TILL, BACK_OFFICE, HANDHELD, TABLET or OTHER.', 'DEVICE_TYPE_INVALID');

  // A device belongs to ONE branch. Reassigning requires revoking first, so
  // device ownership stays auditable rather than ambiguous.
  const active = await db.prepare('SELECT id, branch_id, label FROM branch_devices WHERE device_id = ? AND is_deleted = 0 AND revoked_at IS NULL').bind(String(deviceId).trim()).first();
  if (active) {
    if (active.branch_id === bid) return { ok: true, id: active.id, already_registered: true, label: active.label };
    const other = await db.prepare('SELECT name FROM branches WHERE id = ?').bind(active.branch_id).first();
    throw new HttpError(409,
      `That device is already registered to ${other ? other.name : 'another branch'}. Revoke it there first — a device physically belongs to one location, and letting it be in two places at once removes the whole point of device-based attendance.`,
      'DEVICE_ALREADY_REGISTERED');
  }

  const ts = watNowIso();
  const id = newId();
  await db.prepare(`
    INSERT INTO branch_devices (id, branch_id, business_unit_id, device_id, label, device_type, registered_by, registered_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(id, bid, businessUnitId, String(deviceId).trim().slice(0, 120),
    label ? String(label).slice(0, 120) : null, dt, ctx.user.id, ts, ts).run();

  await writeAudit(db, {
    businessUnitId, branchId: bid, userId: ctx.user.id, actorRole: role,
    action: 'DEVICE_REGISTERED', entityType: 'BRANCH_DEVICE', entityId: id,
    after: { device_id: String(deviceId).slice(0, 16) + '…', label, device_type: dt },
    ipAddress: ctx.ipAddress, deviceId: String(deviceId),
  });
  return { ok: true, id, branch_id: bid, device_type: dt, label };
}

async function revokeDevice(db, ctx, { deviceRowId, reason = null }) {
  const d = await db.prepare('SELECT * FROM branch_devices WHERE id = ? AND is_deleted = 0').bind(deviceRowId).first();
  if (!d) throw new HttpError(404, 'That device registration was not found.', 'DEVICE_NOT_FOUND');
  assertBranchAccess(ctx.user, d.branch_id);
  if (String(ctx.user.role).toUpperCase() === 'STAFF') throw new HttpError(403, 'Only a manager can revoke a device.', 'DEVICE_REVOKE_FORBIDDEN');
  if (d.revoked_at) return { ok: true, id: deviceRowId, already_revoked: true };
  const ts = watNowIso();
  await db.prepare(`UPDATE branch_devices SET revoked_by = ?, revoked_at = ?, label = COALESCE(label || ' | ','') || ?, updated_at = ? WHERE id = ?`)
    .bind(ctx.user.id, ts, reason ? `Revoked: ${String(reason).slice(0, 150)}` : 'Revoked', ts, deviceRowId).run();
  await writeAudit(db, {
    businessUnitId: d.business_unit_id, branchId: d.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'DEVICE_REVOKED', entityType: 'BRANCH_DEVICE', entityId: deviceRowId,
    reason: reason || null, ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: deviceRowId, revoked_at: ts };
}

async function listDevices(db, { businessUnitId, branchId = null, includeRevoked = false }) {
  const rows = await db.prepare(`
    SELECT bd.*, b.name AS branch_name, u.full_name AS registered_by_name, r.full_name AS revoked_by_name
    FROM branch_devices bd
    JOIN branches b ON b.id = bd.branch_id
    LEFT JOIN users u ON u.id = bd.registered_by
    LEFT JOIN users r ON r.id = bd.revoked_by
    WHERE bd.is_deleted = 0 AND bd.business_unit_id = ?
      ${branchId ? 'AND bd.branch_id = ?' : ''}
      ${includeRevoked ? '' : 'AND bd.revoked_at IS NULL'}
    ORDER BY bd.registered_at DESC
  `).bind(businessUnitId, ...(branchId ? [branchId] : [])).all();
  return rows.results;
}

module.exports = { openClock, closeClock, review, pendingReview, timesheet, registerDevice, revokeDevice, listDevices };
'use strict';
