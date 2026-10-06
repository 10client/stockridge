'use strict';
// =====================================================================
// test/audit/audit.staff.js — WHO WAS AT WORK, AND WHAT THE SHOP IS LICENSED TO DO
// =====================================================================
// `tools/flow-coverage.js` listed attendance (0/8) and compliance (0/7) as never exercised by
// a live audit — fifteen endpoints, the two largest untouched flows in the product. They are
// the flows a regulator or an inspector asks about, and both fail quietly:
//
//   * A CLOCK-IN THAT NOBODY CAN PLACE. A shift that is recorded without a location, or from
//     a machine the branch does not know, and never reviewed, is a payroll figure with no
//     evidence behind it — and the second one is what teaches managers to ignore the flags.
//   * A LICENCE THAT LAPSES. A certificate expiring in three weeks is legal today and a
//     closed shop next month. The register, the alert list and the notification have to
//     agree, and a licence the register does not know is required is worse than one that
//     has expired: nobody is warned at all.
//
// So this audit works a full day: a driver clocks in from an unregistered phone and is
// flagged, a manager reviews it, the device is approved, and the next clock-in comes back
// clean. Then it opens the compliance register for the branch, records what the product says
// the business needs, forces an expiry inside the alert window, and reads the checklist, the
// alerts and the notification back:
//
//   FRONT TO BACK  clock in → the record, the device, the flag and the fence all agree.
//                  record a licence → the register, the checklist and the shelf of dates agree.
//   BACK TO FRONT  read yesterday's attendance and the day's summary; read the register,
//                  the alerts and the notification; count what is missing.
//   AND THE REFUSALS a second clock-in, a clock-out with no shift, a staff review of their
//                  own shift, a licence with no branch, backwards dates, and a duplicate.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

runAudit('staff', async (audit, d) => {
  const owner = d.owner || d.admin;
  const staff = (d.seats && d.seats.staff) || null;
  const manager = (d.seats && d.seats.manager) || null;
  if (!staff || !manager) throw new Error('the staff fixture needs a STAFF and a MANAGER seat — attendance is about people clocking in and somebody else reviewing it');
  const branch = (d.branches || [])[0];
  assert.ok(branch, 'the staff fixture has no branch to work at');

  // THE BRANCH HAS TO BE PLACEABLE BEFORE ANY OF THIS MEANS ANYTHING. A fence around a
  // branch with no coordinates cannot classify a single clock-in, and "no location was
  // supplied" is not a fence doing its job.
  const FENCE = 200;
  const HERE = { lat: 9.0765, lng: 7.3986 };   // Wuse 2, Abuja
  const FAR = { lat: 9.0579, lng: 7.4951 };    // Maitama — a few km away, outside a 200m fence
  await audit.checkAsync('the branch is placed, with a fence around it', async () => {
    const res = await manager.put('/api/attendance/geofence', {
      branch_id: branch.id, latitude: HERE.lat, longitude: HERE.lng,
      geofence_radius_meters: FENCE, attendance_mode: 'GEOLOCATION',
    });
    assert.ok(res.status < 400, `setting the geofence answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const back = await owner.get('/api/branches?limit=100');
    const row = ((back.json.data || back.json.branches) || []).filter((b) => String(b.id) === String(branch.id))[0];
    assert.ok(row, 'the branch is not in the branch list');
    // NOT ROUNDED TO TWO PLACES: `round2(9.0765)` is 9.08, and the first version of this
    // check compared a rounded reading against an unrounded expectation and reported a
    // branch that had been placed correctly. Coordinates are compared to GPS precision.
    assert.equal(Number(row.geofence_radius_meters), FENCE,
      `the fence reads ${row.geofence_radius_meters}m against the ${FENCE}m just set`);
    assert.ok(Math.abs(Number(row.latitude) - HERE.lat) < 0.000001, `the branch latitude reads ${row.latitude} against ${HERE.lat}`);
  });

  await audit.checkAsync('a fence that cannot be right is refused, and nothing moves', async () => {
    const res = await manager.put('/api/attendance/geofence', {
      branch_id: branch.id, latitude: 91.5, longitude: 7.3986, geofence_radius_meters: FENCE,
    });
    assert.ok(res.status >= 400 && res.status < 500,
      `latitude 91.5 — off the planet — was accepted: ${res.status} ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'IMPLAUSIBLE_COORDINATES', `the refusal came back as ${res.json.code}`);
    const back = await owner.get('/api/branches?limit=100');
    const row = ((back.json.data || back.json.branches) || []).filter((b) => String(b.id) === String(branch.id))[0];
    assert.ok(Math.abs(Number(row.latitude) - HERE.lat) < 0.000001,
      `a refused geofence still moved the branch's latitude to ${row.latitude}. A refusal that writes is not a refusal`);
  });

  // ===================================================================
  audit.section('Clocking in — the day starts, and the shop knows where from');
  // ===================================================================
  const shift = await audit.captureAsync('a staff member clocks in from a phone the branch does not know', async () => {
    const res = await staff.post('/api/attendance/clock-in', {
      branch_id: branch.id,
      latitude: HERE.lat, longitude: HERE.lng, accuracy_meters: 12,
      method: 'GEOLOCATION',
    }, { device: 'audit-staff-phone' });
    assert.ok(res.status === 201 || res.status === 200, `clocking in answered ${res.status}: ${String(res.text).slice(0, 260)}`);
    const id = res.json.id || (res.json.attendance && res.json.attendance.id);
    assert.ok(id, 'the clock-in was recorded and the answer carries no id');
    return { id, flags: res.json.flags || [], flagged: Boolean(res.json.flagged) };
  });
  audit.note(`clock-in ${String(shift.id).slice(0, 8)} — ${shift.flags.length} flag(s)`);

  await audit.checkAsync('a clock-in at the branch is recorded, placed, and NOT flagged', async () => {
    // NO FALSE FLAGS ON A CLEAN CLOCK-IN. The branch is on GEOLOCATION mode, so the machine
    // it came from is not part of the decision at all (classifyDevice answers NOT_APPLICABLE
    // outside REGISTERED_DEVICE mode) — and a person standing at the shop must not be
    // questioned. A fence that flags its own front door trains managers to ignore flags.
    const res = await staff.get(`/api/attendance?limit=50`);
    assert.equal(res.status, 200, `the attendance register answered ${res.status} ${String(res.text).slice(0, 200)}`);
    const rows = res.json.data || res.json.records || [];
    assert.ok(Array.isArray(rows), `the register did not answer with rows under \`data\` (keys: ${Object.keys(res.json || {}).join(', ')})`);
    const row = rows.filter((r) => String(r.id) === String(shift.id))[0];
    assert.ok(row, 'the shift just clocked in is not in the attendance register');
    assert.equal(Number(row.flagged), 0,
      `a clock-in at the branch's own coordinates was flagged: ${row.flag_reason}`);

    // FRONT TO BACK: the location was classified, and the record carries what the fence saw.
    const detail = await owner.get(`/api/attendance/today?branch_id=${encodeURIComponent(branch.id)}`);
    const rec = (detail.json.records || []).filter((r) => String(r.id) === String(shift.id))[0];
    assert.ok(rec, 'the shift is not in today\'s attendance for the branch it was clocked at');
    assert.ok(Number(rec.distance_meters) < FENCE,
      `the clock-in reports ${rec.distance_meters}m from a branch it was made 0m from (the same coordinates), inside a ${FENCE}m fence`);
    assert.equal(String(rec.location_status || ''), 'ON_SITE',
      `a clock-in at the branch's own coordinates is recorded as ${rec.location_status}`);
    assert.ok(String(rec.clock_in_device_id || '').length > 0, 'the shift does not record which machine it was clocked in from');
  });

  await audit.checkAsync('somebody already on shift cannot clock in again', async () => {
    const res = await staff.post('/api/attendance/clock-in', {
      branch_id: branch.id, latitude: HERE.lat, longitude: HERE.lng, method: 'GEOLOCATION',
    }, { device: 'audit-staff-phone' });
    assert.ok(res.status >= 400 && res.status < 500,
      `a second clock-in while still on shift was accepted: ${res.status} ${String(res.text).slice(0, 220)}. Two open shifts for one person is a payroll figure with two answers`);
    assert.ok(/already|on shift|clocked in/i.test(String(res.json.error || '')),
      `the refusal does not say a shift is already open: ${res.json.error}`);
  });

  await audit.checkAsync('today’s board shows who is in, who is missing, and the hours so far', async () => {
    const res = await manager.get(`/api/attendance/today?branch_id=${encodeURIComponent(branch.id)}`);
    assert.equal(res.status, 200, `today's attendance answered ${res.status} ${String(res.text).slice(0, 220)}`);
    const summary = res.json.summary || {};
    assert.ok(Number(summary.clockedIn) >= 1, `today's board says ${summary.clockedIn} clock-in(s) while somebody is on shift`);
    assert.ok(Number(summary.stillIn) >= 1, `today's board says ${summary.stillIn} still in, and nobody has clocked out`);
    assert.equal(Number(summary.completed), 0, `today's board shows ${summary.completed} completed shift(s) and nobody has clocked out`);
    assert.ok(res.json.date, "today's board does not say which day it is for");

    // AND WHO IS MISSING IS THE HALF A MANAGER ACTS ON. The staff seat is on shift, so they
    // must NOT be in the absent list, and the manager seat is not on shift at all.
    const absent = res.json.absent || [];
    assert.ok(Array.isArray(absent), `the board's absent list is not a list (keys: ${Object.keys(res.json || {}).join(', ')})`);
    // THE IDS COME FROM THE DEPLOYMENT'S OWN RECORDS, not from the seat objects: a seat is an
    // actor, and its `user` blob is the sign-in answer rather than the row. The shift record
    // carries its own `user_id`, and the manager is identifiable by the name the fixture gave
    // them — both are facts the deployment produced.
    // Read from THIS check's own payload: the records on today's board carry the user id.
    const onShift = (res.json.records || []).filter((r) => String(r.id) === String(shift.id))[0] || {};
    const onShiftId = String(onShift.user_id || '');
    assert.ok(onShiftId, 'today\'s board does not say whose shift this is');
    assert.ok(!absent.some((a) => String(a.id) === onShiftId),
      'somebody who is on shift is listed as absent');
    assert.ok(absent.some((a) => String(a.full_name || '') === 'Staff Audit Manager' || String(a.username || '').includes('stf-manager')),
      `the manager has not clocked in and is not on the absent list (${absent.length} name(s): ${absent.map((a) => a.full_name || a.username).join(', ')}). The list exists so that somebody notices`);
  });

  // ===================================================================
  audit.section('Reviewing it — a manager, a reason, and a device that is no longer a stranger');
  // ===================================================================
  await audit.checkAsync('a staff member cannot review attendance', async () => {
    const res = await staff.post(`/api/attendance/${encodeURIComponent(shift.id)}/review`, { accepted: true });
    assert.equal(res.status, 403,
      `a STAFF member reviewed their own flag: ${res.status} ${String(res.text).slice(0, 200)}. Reviewing your own attendance is not a review`);
    assert.equal(res.json.code, 'ROLE_REQUIRED', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('a rejected clock-in has to say why', async () => {
    // TWO GUARDS, TWO ANSWERS: an absent reason is a missing field, a reason too short to
    // say anything is REASON_REQUIRED. (The first version of this check expected
    // REASON_REQUIRED for an absent one; both refusals are right, and the product's own
    // error codes are the authority.)
    const res = await manager.post(`/api/attendance/${encodeURIComponent(shift.id)}/review`, { accepted: false });
    assert.equal(res.status, 400,
      `a clock-in was rejected with no reason: ${res.status} ${String(res.text).slice(0, 200)}. The staff member is entitled to know what was held against them`);
    assert.equal(res.json.code, 'MISSING_FIELD', `a rejection with no reason came back as ${res.json.code}`);
    const short = await manager.post(`/api/attendance/${encodeURIComponent(shift.id)}/review`, { accepted: false, note: 'no' });
    assert.equal(short.status, 400, `a two-letter reason was accepted for rejecting a shift: ${short.status}`);
    assert.equal(short.json.code, 'REASON_REQUIRED', `a reason too short to say anything came back as ${short.json.code}`);
  });

  await audit.checkAsync('accepted, with the review on the record', async () => {
    const res = await manager.post(`/api/attendance/${encodeURIComponent(shift.id)}/review`, {
      accepted: true, note: 'The phone is new; the till was replaced last week. Location checks out.',
    });
    assert.ok(res.status < 400, `reviewing the clock-in answered ${res.status}: ${String(res.text).slice(0, 240)}`);

    // READ FROM THE WHOLE REGISTER, not from `flagged_only`. Accepting a review records WHO
    // decided and WHEN, and leaves the flag in place: the flag is "something looked odd",
    // the review is "a person looked at it". Dropping the flag would erase the only trace
    // that anything was ever questioned.
    const after = await manager.get('/api/attendance?limit=50');
    const row = (after.json.data || []).filter((r) => String(r.id) === String(shift.id))[0];
    assert.ok(row, 'the reviewed shift dropped out of the register entirely');
    assert.ok(row.reviewed_at, 'the reviewed shift carries no reviewed_at — the decision cannot be dated');
    // `reviewer_name` is the alias the register uses (`server/routes/attendance.js:320`).
    assert.ok(String(row.reviewer_name || '').length > 0,
      `the reviewed shift does not say who reviewed it (keys: ${Object.keys(row).join(', ')}). An approval with no name is an approval nobody made`);
    const unreviewed = await manager.get('/api/attendance?unreviewed_only=1&limit=50');
    assert.ok(!(unreviewed.json.data || []).some((r) => String(r.id) === String(shift.id)),
      'a shift that has been reviewed is still in the unreviewed list — the list a manager works from never shrinks');
  });

  await audit.checkAsync('the branch is switched to checking devices, and the machine it has been clocking in from is a stranger', async () => {
    // THE MODE IS THE POINT. In GEOLOCATION mode a machine is not part of the decision at
    // all; a shop that wants the till itself to be the credential switches the branch to
    // REGISTERED_DEVICE, and then every machine is a stranger until a manager says otherwise.
    const set = await manager.put('/api/attendance/geofence', {
      branch_id: branch.id, latitude: HERE.lat, longitude: HERE.lng,
      geofence_radius_meters: FENCE, attendance_mode: 'REGISTERED_DEVICE',
    });
    assert.ok(set.status < 400, `switching the branch to device mode answered ${set.status}: ${String(set.text).slice(0, 240)}`);

    const out = await staff.post('/api/attendance/clock-out', { branch_id: branch.id });
    if (out.status === 409) audit.note('there was no shift open to close');

    const res = await staff.post('/api/attendance/clock-in', {
      branch_id: branch.id, latitude: HERE.lat, longitude: HERE.lng, accuracy_meters: 10, method: 'GEOLOCATION',
    }, { device: 'audit-staff-phone' });
    assert.ok(res.status < 400, `clocking in under device mode answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.equal(Boolean(res.json.flagged), true,
      'a machine the branch has never approved clocked somebody in and was not flagged. In device mode the till IS the credential, and an unknown one is exactly what this mode exists to catch');
    assert.ok((res.json.flags || []).some((f) => /machine|device|registered/i.test(f)),
      `the flag does not mention the machine: ${JSON.stringify(res.json.flags || [])}`);
    await staff.post('/api/attendance/clock-out', { branch_id: branch.id });
  });

  await audit.checkAsync('the unknown machine is listed for approval, and approving it clears the flag', async () => {
    // A FIRST-SEEN DEVICE IS REGISTERED AS PENDING — that is what makes it approvable. The
    // guard that did this compared against a status value that does not exist
    // ('UNREGISTERED'; the classifier answers UNRECOGNIZED), so the row was never written:
    // the device list stayed empty, no manager could approve the machine, and every shift
    // from it was flagged for ever. Found here, by looking for the pending device.
    const devices = await manager.get(`/api/attendance/devices?branch_id=${encodeURIComponent(branch.id)}`);
    assert.equal(devices.status, 200, `the device list answered ${devices.status} ${String(devices.text).slice(0, 200)}`);
    const list = devices.json.data || [];
    const mine = list.filter((d) => String(d.device_id) === 'audit-staff-phone')[0];
    assert.ok(mine,
      `the machine that just clocked in is not on the branch's device list (${list.length} device(s)). A machine nobody can see is a machine nobody can approve, and its shifts are flagged for ever`);
    assert.equal(String(mine.status), 'PENDING',
      `a machine that has only just been seen is listed as ${mine.status} — no device is registered until a manager says so`);
    assert.ok(Number(mine.clock_ins) >= 1, `the device list says this machine has clocked in ${mine.clock_ins} time(s)`);

    const res = await manager.post(`/api/attendance/devices/${encodeURIComponent('audit-staff-phone')}/status`, {
      branch_id: branch.id, status: 'APPROVED', label: 'Front counter phone',
    });
    assert.ok(res.status < 400, `approving the device answered ${res.status}: ${String(res.text).slice(0, 240)}`);

    // BACK TO FRONT: the same person, the same place, the same machine — and now clean.
    await staff.post('/api/attendance/clock-out', { branch_id: branch.id });
    const again = await staff.post('/api/attendance/clock-in', {
      branch_id: branch.id, latitude: HERE.lat, longitude: HERE.lng, accuracy_meters: 10, method: 'GEOLOCATION',
    }, { device: 'audit-staff-phone' });
    assert.ok(again.status < 400, `the clock-in from the approved machine answered ${again.status}: ${String(again.text).slice(0, 240)}`);
    assert.equal(Boolean(again.json.flagged), false,
      `a clock-in at the branch, from the machine a manager approved a minute ago, is still flagged: ${JSON.stringify(again.json.flags || [])}. If approving a device changes nothing, the device screen is decoration`);
    await staff.post('/api/attendance/clock-out', { branch_id: branch.id });
  });

  await audit.checkAsync('the fence still catches a clock-in from somewhere else', async () => {
    // THE OTHER HALF, ON THE OTHER AXIS: same person, same approved machine, kilometres away.
    // The machine cannot be what answers this one.
    const res = await staff.post('/api/attendance/clock-in', {
      branch_id: branch.id, latitude: FAR.lat, longitude: FAR.lng, accuracy_meters: 10, method: 'GEOLOCATION',
    }, { device: 'audit-staff-phone' });
    assert.ok(res.status < 400, `the away clock-in answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.equal(Boolean(res.json.flagged), true,
      'a clock-in kilometres from the branch, from an approved machine, was NOT flagged. The fence is the half that catches a phone left at home');
    assert.ok((res.json.flags || []).some((f) => /outside|boundary|metre|meter|m from/i.test(f)),
      `the flag does not mention the distance: ${JSON.stringify(res.json.flags || [])}`);
    await staff.post('/api/attendance/clock-out', { branch_id: branch.id });
  });

  await audit.checkAsync('there is no shift to close when nothing is open', async () => {
    // THE STATE IS MADE CERTAIN FIRST. Every check above closes the shift it opened, so this
    // one is not reading whatever the last one happened to leave behind: a clock-out with a
    // shift open is a success, and an audit that confuses the two proves nothing either way.
    const already = await staff.post('/api/attendance/clock-out', { branch_id: branch.id });
    if (already.status < 400) audit.note('a shift was still open from an earlier check and has been closed');

    const res = await staff.post('/api/attendance/clock-out', { branch_id: branch.id });
    assert.equal(res.status, 409,
      `clocking out with no open shift answered ${res.status} ${String(res.text).slice(0, 200)}. A clock-out with nothing behind it invents a shift`);
    assert.equal(res.json.code, 'NOT_CLOCKED_IN', `the refusal came back as ${res.json.code}`);
  });

  // ===================================================================
  audit.section('The licence register — what the shop is allowed to do');
  // ===================================================================
  const checklist = await audit.captureAsync('the checklist names what this business must hold', async () => {
    const res = await owner.get(`/api/compliance/checklist?branch_id=${encodeURIComponent(branch.id)}`);
    assert.equal(res.status, 200, `the compliance checklist answered ${res.status} ${String(res.text).slice(0, 240)}`);
    const rows = res.json.data || [];
    assert.ok(Array.isArray(rows) && rows.length > 0,
      `the checklist came back with no branches (keys: ${Object.keys(res.json || {}).join(', ')})`);
    const mine = rows.filter((b) => String(b.branch_id || b.id) === String(branch.id))[0] || rows[0];
    const expected = mine.expected || [];
    assert.ok(expected.length > 0,
      `the checklist expects no licences at all for a branch of an ELECTRONICS business. Licences nobody is asked about are licences nobody notices expiring`);
    audit.note(`${branch.name} must hold ${expected.length} licence type(s); ${mine.counts ? mine.counts.missing : '?'} still missing`);
    return { expected, mine };
  });

  await audit.checkAsync('what is missing is named by the checklist; the register holds what exists', async () => {
    // MISSING IS NOT A ROW. A licence the branch does not hold cannot be a record — there is
    // nothing to store — so the checklist is the endpoint that names it, and the register's
    // own `status=MISSING` filter is deliberately empty (`where.push('1 = 0')`). Both halves
    // are asserted here so that neither can quietly become the other.
    const counts = checklist.mine.counts || {};
    assert.ok(Number(counts.missing) >= 1,
      `the checklist says ${counts.missing} licence(s) are missing for a branch that holds none. The register exists to name what is absent`);
    assert.ok(Number(counts.expected) >= Number(counts.missing),
      `the checklist expects ${counts.expected} licence(s) and reports ${counts.missing} missing`);
    const list = await owner.get(`/api/compliance/records?branch_id=${encodeURIComponent(branch.id)}&limit=100`);
    assert.equal(list.status, 200, `the register answered ${list.status} ${String(list.text).slice(0, 200)}`);
    assert.ok(Array.isArray(list.json.data), `the register did not answer with rows under data (keys: ${Object.keys(list.json || {}).join(', ')})`);
    const missing = await owner.get(`/api/compliance/records?branch_id=${encodeURIComponent(branch.id)}&status=MISSING&limit=100`);
    assert.equal((missing.json.data || []).length, 0,
      'the register returned rows for MISSING — a licence the branch does not hold is not a record, and inventing one would put a certificate in the books that nobody has');
  });

  // THE FIRST REQUIRED TYPE, RECORDED PROPERLY, WITH AN EXPIRY INSIDE THE ALERT WINDOW.
  const soonType = checklist.expected.map((e) => (typeof e === 'string' ? e : e.type || e.code))
    .find((t) => ['SONCAP_DEALER', 'TRADING_PERMIT', 'FIRE_CERT', 'SCUML', 'NCC_TYPE_APPROVAL'].includes(String(t)))
    || checklist.expected.map((e) => (typeof e === 'string' ? e : e.type || e.code))[0];
  const SOON = day(20);   // inside the default 30-day warning window

  const licence = await audit.captureAsync('a licence recorded against the branch, expiring soon', async () => {
    const res = await manager.post('/api/compliance/records', {
      branch_id: branch.id,
      record_type: soonType,
      record_number: `AUD-${String(soonType).slice(0, 6)}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
      issued_by: 'Abuja Municipal Area Council',
      issued_date: day(-300),
      expiry_date: SOON,
      notes: 'Staff audit fixture — expires inside the warning window on purpose.',
    });
    assert.ok(res.status === 201 || res.status === 200, `recording the licence answered ${res.status}: ${String(res.text).slice(0, 260)}`);
    const id = res.json.id || (res.json.record && res.json.record.id);
    assert.ok(id, 'the licence was recorded and the answer carries no id');
    return { id, type: soonType, expiry: SOON };
  });
  audit.note(`${soonType} recorded, expiring ${SOON}`);

  await audit.checkAsync('the register reads it back with its own verdict on the expiry', async () => {
    const res = await owner.get(`/api/compliance/records?branch_id=${encodeURIComponent(branch.id)}&limit=100`);
    const rows = res.json.data || [];
    const row = rows.filter((r) => String(r.id) === String(licence.id))[0];
    assert.ok(row, 'the licence just recorded is not in the register');
    assert.equal(String(row.expiry_date), SOON, `the register holds an expiry of ${row.expiry_date} against ${SOON}`);
    assert.equal(String(row.status), 'EXPIRING',
      `a licence expiring in 20 days is reported as "${row.status}". A licence that is legal today and gone in three weeks is exactly what the window exists to catch`);
    assert.ok(Number(row.daysToExpiry) <= 30 && Number(row.daysToExpiry) >= 19,
      `the register says ${row.daysToExpiry} day(s) to expiry for a date 20 days out`);
    assert.ok(String(row.note || '').length > 0, 'the register gives no note for a licence that is about to lapse');
  });

  await audit.checkAsync('the alert list holds the same fact as the register', async () => {
    const res = await manager.get(`/api/compliance/alerts?branch_id=${encodeURIComponent(branch.id)}&limit=100`);
    assert.equal(res.status, 200, `the alert list answered ${res.status} ${String(res.text).slice(0, 220)}`);
    const rows = res.json.data || [];
    const row = rows.filter((r) => String(r.id) === String(licence.id))[0];
    assert.ok(row, `the licence expiring in 20 days is not in the alert list (${rows.length} alert(s)). An alert list that misses the one licence inside its own window is worse than no list`);
    assert.equal(String(row.status), 'EXPIRING', `the alert calls it ${row.status}`);
    // The alert list answers with `counts`, not `summary`.
    const counts = res.json.counts || res.json.summary || {};
    assert.ok(Number(counts.expiring) >= 1,
      `the alert counts say ${counts.expiring} expiring licence(s) while the list itself contains one (keys: ${Object.keys(res.json || {}).join(', ')})`);
    assert.ok(Number(counts.total) >= (res.json.data || []).length,
      `the alert counts total ${counts.total} against ${(res.json.data || []).length} row(s) returned`);
  });

  await audit.checkAsync('a STAFF member can read the register but not write to it', async () => {
    const read = await staff.get(`/api/compliance/records?branch_id=${encodeURIComponent(branch.id)}&limit=50`);
    assert.equal(read.status, 200,
      `a STAFF member cannot read the compliance register at all (${read.status}). The person at the counter is the one who gets asked for the certificate`);
    const write = await staff.post('/api/compliance/records', {
      branch_id: branch.id, record_type: 'FIRE_CERT', record_number: 'STAFF-TRY', expiry_date: day(200),
    });
    assert.equal(write.status, 403,
      `a STAFF member recorded a licence: ${write.status} ${String(write.text).slice(0, 200)}. A licence is a claim about the business made to a regulator`);
    assert.equal(write.json.code, 'ROLE_REQUIRED', `the refusal came back as ${write.json.code}`);
  });

  await audit.checkAsync('a licence for a branch the manager does not run is refused, not silently re-pointed', async () => {
    // A SECOND BRANCH THE MANAGER IS NOT PINNED TO. The pin exists because the failure it
    // prevents is real: a manager posting a licence for the other shop used to get a 201 for
    // their own shop instead of a refusal — the register looked complete and the licence was
    // filed against the wrong premises.
    const other = (d.branches || []).filter((b) => String(b.id) !== String(branch.id))[0];
    assert.ok(other, 'the staff fixture needs a second branch for the manager to reach for');
    const res = await manager.post('/api/compliance/records', {
      branch_id: other.id, record_type: 'FIRE_CERT',
      record_number: `OTHER-${Date.now().toString(36).slice(-4).toUpperCase()}`,
      issued_date: day(-10), expiry_date: day(300),
    });
    assert.ok(res.status >= 400 && res.status < 500,
      `a manager filed a licence against ${other.name}, which they do not run: ${res.status} ${String(res.text).slice(0, 220)}. A licence filed against the wrong premises is worse than one that was never filed`);
    const check = await owner.get(`/api/compliance/records?branch_id=${encodeURIComponent(other.id)}&limit=50`);
    assert.equal((check.json.data || []).length, 0,
      `the refused licence was written anyway against ${other.name}`);
  });

  await audit.checkAsync('recorded without naming a branch, a licence lands on the branch the manager runs', async () => {
    // THE OTHER SIDE OF THE SAME RULE: the pin is the answer when nothing is named, which is
    // what makes the screen work for a single-branch manager. (An earlier version of this
    // check called this "a licence with no branch" and expected a refusal — the product was
    // right and the check was wrong.)
    const marker = `OWNBRANCH-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    const res = await manager.post('/api/compliance/records', {
      record_type: 'SIGNAGE_PERMIT', record_number: marker, issued_date: day(-5), expiry_date: day(500),
    });
    assert.ok(res.status < 400, `recording without naming a branch answered ${res.status}: ${String(res.text).slice(0, 220)}`);
    const back = await owner.get(`/api/compliance/records?branch_id=${encodeURIComponent(branch.id)}&limit=100`);
    const row = (back.json.data || []).filter((r) => String(r.record_number) === marker)[0];
    assert.ok(row, 'the licence recorded without a branch name is not on the manager\'s own branch');
    assert.equal(String(row.branch_id), String(branch.id), `the licence landed on branch ${row.branch_id}`);
  });

  await audit.checkAsync('a licence that expires before it was issued is refused', async () => {
    const backwards = await manager.post('/api/compliance/records', {
      branch_id: branch.id, record_type: 'FIRE_CERT', record_number: 'BACKWARDS',
      issued_date: day(-10), expiry_date: day(-40),
    });
    assert.equal(backwards.status, 400,
      `a licence expiring 30 days BEFORE it was issued was accepted: ${backwards.status} ${String(backwards.text).slice(0, 200)}`);
    assert.equal(backwards.json.code, 'INVALID_DATE_RANGE', `the refusal came back as ${backwards.json.code}`);
  });

  await audit.checkAsync('a second live record of the same type on the same branch is refused, by name', async () => {
    const res = await manager.post('/api/compliance/records', {
      branch_id: branch.id, record_type: licence.type,
      record_number: 'A-DUPLICATE', issued_date: day(-10), expiry_date: day(400),
    });
    assert.equal(res.status, 409,
      `two live ${licence.type} records were allowed on one branch: ${res.status} ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'DUPLICATE_RECORD_TYPE', `the refusal came back as ${res.json.code}`);
    assert.ok(String(res.json.error || '').includes(String(licence.type)),
      `the refusal does not name the type that already exists: ${res.json.error}`);
    assert.ok(String(res.json.error || '').toLowerCase().includes('edit') || String(res.json.error || '').toLowerCase().includes('remove'),
      `the refusal does not say how to proceed: ${res.json.error}`);
  });

  await audit.checkAsync('renewing it moves the register, the alerts and the checklist together', async () => {
    // BACK TO FRONT: the same record, pushed out past the window. Renewal is the ordinary
    // event, and every reading has to follow it.
    const res = await manager.put(`/api/compliance/records/${encodeURIComponent(licence.id)}`, {
      expiry_date: day(400), record_number: `RENEWED-${Date.now().toString(36).slice(-4).toUpperCase()}`,
      notes: 'Renewed — staff audit.',
    });
    assert.ok(res.status < 400, `renewing the licence answered ${res.status}: ${String(res.text).slice(0, 240)}`);

    const register = await owner.get(`/api/compliance/records?branch_id=${encodeURIComponent(branch.id)}&limit=100`);
    const row = (register.json.data || []).filter((r) => String(r.id) === String(licence.id))[0];
    assert.equal(String(row.expiry_date), day(400), `the register still holds ${row.expiry_date} after the renewal`);
    assert.equal(String(row.status), 'VALID',
      `a licence renewed for 400 days is reported as "${row.status}"`);

    const alerts = await manager.get(`/api/compliance/alerts?branch_id=${encodeURIComponent(branch.id)}&limit=100`);
    assert.ok(!(alerts.json.data || []).some((r) => String(r.id) === String(licence.id)),
      'a licence renewed for more than a year is still in the expiry alert list — alerts that do not clear are alerts nobody reads');

    const after = await owner.get(`/api/compliance/checklist?branch_id=${encodeURIComponent(branch.id)}`);
    const mine = (after.json.data || []).filter((b) => String(b.branch_id || b.id) === String(branch.id))[0] || (after.json.data || [])[0];
    const before = checklist.mine.counts || {};
    assert.equal(Number(mine.counts.missing), Number(before.missing) - 1,
      `the checklist said ${before.missing} licence(s) missing before the licence was recorded and says ${mine.counts.missing} after. A register the checklist does not read is two books`);
  });

  await audit.checkAsync('a licence that was filed by mistake can be taken off the register', async () => {
    // THE LAST ROUTE IN THE FLOW. A record filed against the wrong type or the wrong date has
    // to be removable, or the register fills up with things that are not true — and a soft
    // delete is what this product does everywhere else, so it must be a soft one here too.
    const marker = `BYMISTAKE-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    const made = await manager.post('/api/compliance/records', {
      branch_id: branch.id, record_type: 'NCC_TYPE_APPROVAL', record_number: marker,
      issued_date: day(-5), expiry_date: day(365),
    });
    assert.ok(made.status < 400, `recording the licence answered ${made.status}: ${String(made.text).slice(0, 220)}`);
    const id = made.json.id;

    const refused = await staff.del(`/api/compliance/records/${encodeURIComponent(id)}`);
    assert.equal(refused.status, 403,
      `a STAFF member removed a licence from the register: ${refused.status} ${String(refused.text).slice(0, 200)}`);
    assert.equal(refused.json.code, 'ROLE_REQUIRED', `the refusal came back as ${refused.json.code}`);

    const gone = await manager.del(`/api/compliance/records/${encodeURIComponent(id)}`);
    assert.ok(gone.status < 300, `removing the licence answered ${gone.status}: ${String(gone.text).slice(0, 220)}`);
    const list = await owner.get(`/api/compliance/records?branch_id=${encodeURIComponent(branch.id)}&limit=200`);
    assert.ok(!(list.json.data || []).some((r) => String(r.id) === String(id)),
      'a licence that was removed is still in the register');
    const again = await manager.del(`/api/compliance/records/${encodeURIComponent(id)}`);
    assert.equal(again.status, 404, `removing the same licence twice answered ${again.status} — a second removal is not a success`);
  });

  await audit.checkAsync('the expiry notification is raised once, not twice', async () => {
    // A SECOND LICENCE, EXPIRING SOONER, SO THE NOTIFIER HAS SOMETHING TO RAISE.
    const opened = await manager.post('/api/compliance/records', {
      branch_id: branch.id, record_type: 'FIRE_CERT', record_number: `FIRE-${Date.now().toString(36).slice(-4).toUpperCase()}`,
      issued_date: day(-400), expiry_date: day(10),
    });
    assert.ok(opened.status < 400, `recording the fire certificate answered ${opened.status}: ${String(opened.text).slice(0, 220)}`);

    const first = await manager.post('/api/compliance/notify', {});
    assert.ok(first.status < 400, `raising expiry alerts answered ${first.status}: ${String(first.text).slice(0, 240)}`);
    assert.ok(Number(first.json.created) >= 1,
      `the notifier created ${first.json.created} alert(s) with a licence expiring in 10 days on the register. A register nobody is told about is a diary entry`);

    const again = await manager.post('/api/compliance/notify', {});
    assert.equal(Number(again.json.created), 0,
      `running the notifier twice created ${again.json.created} more alert(s). Nothing is raised twice — an alert list that grows every morning is one nobody reads`);
    assert.ok(Number(again.json.outstanding) >= 1, `the second run reports ${again.json.outstanding} unread alerts, having just created some`);

    // AND THE ALERT IS READABLE WHERE A MANAGER LOOKS FOR IT.
    const bell = await manager.get('/api/notifications?limit=50');
    if (bell.status === 200) {
      const rows = bell.json.data || bell.json.notifications || [];
      const mine = rows.filter((n) => String(n.type) === 'COMPLIANCE_EXPIRY');
      assert.ok(mine.length >= 1,
        `the notifier raised ${first.json.created} expiry alert(s) and the notification list holds none (${rows.length} row(s) total)`);
      audit.note(`${mine.length} unread compliance expiry notification(s) on the bell`);
    } else {
      audit.note(`the notification list answered ${bell.status}, so the alerts were checked through their own count`);
    }
  });
}, {
  setup: () => startDeployment({
    label: 'staff',
    businesses: [{
      name: 'Staff Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Staff Audit Branch', code: 'STF-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 40000 },
        // A SECOND BRANCH THE SEATS ARE NOT PINNED TO: "you may not file this here" needs
        // somewhere to file it.
        { name: 'Staff Audit Annexe', code: 'STF-2', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000 },
      ],
    }],
    seats: [
      { as: 'staff', role: 'STAFF', username: 'stf-staff', pin: '60531', branchIndex: 0, full_name: 'Staff Audit Counter' },
      { as: 'manager', role: 'MANAGER', username: 'stf-manager', pin: '60532', branchIndex: 0, full_name: 'Staff Audit Manager' },
    ],
  }),
});
