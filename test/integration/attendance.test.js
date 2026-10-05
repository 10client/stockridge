'use strict';
// =====================================================================
// test/integration/attendance.test.js — THE GEOFENCE, AND WHAT IT FLAGS
// =====================================================================
// This file exists because of two bugs that were invisible from the outside.
//
// The clock-in route builds a `flags` array and sets `staff_attendance.flagged`
// from it. Every check in that array was wrong in the same way — it tested
// something that could never be false:
//
//   1. It compared `locationStatus` against the string 'OUTSIDE_FENCE'. The
//      domain function speaks the schema's vocabulary instead: ON_SITE, OFF_SITE,
//      NO_LOCATION, NOT_CONFIGURED. So the comparison never matched, and a
//      clock-in four kilometres from the shop was recorded as clean. The flag
//      mechanism — the entire reason the module exists — was dead code.
//
//   2. It tested `if (!plausible)` where `coordinatesArePlausible()` returns an
//      OBJECT. An object is always truthy, so a GPS fix reading (0,0) or a
//      swapped latitude/longitude pair was never flagged either.
//
// Nothing else could have caught these. The route returns 201, the row is
// written, the screen says "clocked in". The only symptom is a manager who
// never sees anything to review, which looks exactly like a well-behaved staff.
//
// So these tests assert the OUTCOME a manager depends on: an off-site clock-in
// arrives flagged, with the distance attached, and an on-site one does not.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, migrate } = require('../../server/lib/db');
const { provisionDeployment } = require('../../server/services/provisioningService');
const { createHttpApp } = require('../../server/app');
const { getSettings } = require('../../domain/planLimits');

const BRANCH_LAT = 6.6018;
const BRANCH_LNG = 3.3515;

let counter = 0;

/** A provisioned deployment, its HTTP app, and a signed-in token. */
async function makeWorld() {
  counter += 1;
  const file = path.join(os.tmpdir(), `stockridge-att-${process.pid}-${counter}-${Date.now()}.db`);
  const db = openDatabase({ file });
  await migrate(db);

  const prov = await provisionDeployment(db, {
    businessName: 'Attendance Traders',
    profileCode: 'ELECTRONICS',
    ownerName: 'Att Owner', ownerUsername: 'attowner', ownerPin: '12345',
    branches: [{
      name: 'Fenced Branch', code: 'FB-01', city: 'Port Harcourt', state: 'Rivers', branch_type: 'RETAIL',
      latitude: BRANCH_LAT, longitude: BRANCH_LNG, geofence_radius_meters: 150,
      attendance_mode: 'GEOLOCATION', opening_cash: 50000,
      manager: { name: 'Att Manager', username: 'attmanager', pin: '23456' },
      staff: [{ name: 'Att Cashier', username: 'attcashier', pin: '34567' }],
    }],
  });

  const settings = await getSettings(db);
  const app = createHttpApp({ db, jwtSecret: 'attendance-test-secret', settings });

  async function call(method, url, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Device-Id': 'test-device' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await app.fetch(new Request(`http://local${url}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = { _raw: text }; }
    return { status: res.status, json };
  }

  async function login(username, pin) {
    const r = await call('POST', '/api/auth/login', { body: { username, pin } });
    assert.equal(r.status, 200, `login failed for ${username}: ${JSON.stringify(r.json).slice(0, 200)}`);
    return r.json.token;
  }

  const branchId = prov.branchIds[0];
  return {
    db, file, app, call, login, branchId,
    managerToken: await login('attmanager', '23456'),
    cashierToken: await login('attcashier', '34567'),
    cleanup: () => {
      try { db.close(); } catch (e) { /* already closed */ }
      for (const suffix of ['', '-wal', '-shm']) { const f = file + suffix; if (fs.existsSync(f)) fs.rmSync(f, { force: true }); }
    },
  };
}

/** Roughly `metres` north of the branch, as a coordinate pair. */
function offsetNorth(metres) {
  return BRANCH_LAT + (metres / 111320);
}

test('attendance: a clock-in inside the fence is clean', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const r = await world.call('POST', '/api/attendance/clock-in', {
    token: world.cashierToken,
    body: {
      latitude: offsetNorth(40), longitude: BRANCH_LNG, accuracy_meters: 10,
      device_id: 'cashier-phone',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json).slice(0, 300));
  assert.equal(r.json.locationStatus, 'ON_SITE');
  assert.equal(r.json.flagged, false, `an on-site clock-in must not be flagged: ${JSON.stringify(r.json.flags)}`);

  const row = await world.db.first('SELECT * FROM staff_attendance ORDER BY clock_in_at DESC LIMIT 1');
  assert.equal(row.location_status, 'ON_SITE', 'the stored status must be one the schema allows');
  assert.equal(Number(row.flagged), 0);
});

test('attendance: a clock-in kilometres away IS flagged, with the distance', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const r = await world.call('POST', '/api/attendance/clock-in', {
    token: world.cashierToken,
    body: {
      latitude: offsetNorth(4200), longitude: BRANCH_LNG, accuracy_meters: 12,
      device_id: 'cashier-phone',
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.locationStatus, 'OFF_SITE', 'a clock-in 4.2km away is off site');
  assert.equal(r.json.flagged, true,
    'THE REGRESSION: this was recorded as clean because the route compared locationStatus against a string the domain module never returns');
  assert.ok(Array.isArray(r.json.flags) && r.json.flags.length > 0, 'a flagged clock-in must carry its reasons');
  assert.match(r.json.flags.join(' '), /4,?2\d\d\s*m|distance|outside/i, `expected the distance in the flags, got: ${r.json.flags.join(' | ')}`);
  assert.ok(r.json.distanceMeters > 4000, `expected a measured distance over 4km, got ${r.json.distanceMeters}`);

  const row = await world.db.first('SELECT * FROM staff_attendance ORDER BY clock_in_at DESC LIMIT 1');
  assert.equal(Number(row.flagged), 1, 'the flag must be PERSISTED, not just returned');
  assert.ok(row.flag_reason && row.flag_reason.length > 10, 'the reason is what a manager reviews');
  assert.equal(row.location_status, 'OFF_SITE');
});

test('attendance: an uninitialised GPS fix is flagged, not silently accepted', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const r = await world.call('POST', '/api/attendance/clock-in', {
    token: world.cashierToken,
    body: { latitude: 0, longitude: 0, accuracy_meters: 5, device_id: 'cashier-phone' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.flagged, true,
    'THE SECOND REGRESSION: coordinatesArePlausible() returns an object, so `if (!plausible)` was always false and a (0,0) fix was accepted');
  assert.match(r.json.flags.join(' '), /plausible|0,0|uninitialised|GPS/i, `expected a note about the coordinates, got: ${r.json.flags.join(' | ')}`);
});

test('attendance: a swapped latitude/longitude pair is caught by the distance, not swallowed', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  // The most common GPS bug in West Africa is the right two numbers in the wrong
  // order. At this latitude a swap is not extreme enough for the plausibility
  // test to cry "Arctic" — 3.35N/6.60E is a valid point off the coast of Guinea
  // — so it is the DISTANCE check that has to catch it. That is the design: the
  // plausibility test exists to reject (0,0) and out-of-range values, not to
  // second-guess a coordinate pair that merely looks unusual.
  const r = await world.call('POST', '/api/attendance/clock-in', {
    token: world.cashierToken,
    body: { latitude: BRANCH_LNG, longitude: BRANCH_LAT, accuracy_meters: 8, device_id: 'cashier-phone' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.flagged, true, 'a swapped pair lands hundreds of kilometres away and must be flagged');
  assert.ok(r.json.distanceMeters > 100000, `expected a distance in the hundreds of km, got ${r.json.distanceMeters}`);
  assert.match(r.json.flags.join(' '), /outside/i);
});

test('attendance: an out-of-range coordinate pair is refused outright on the geofence route', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  // The fence route is the one place coordinates are REJECTED rather than
  // flagged: a branch pin of (91, 200) would mis-classify every clock-in after
  // it, and unlike a clock-in there is no "record it and let a human decide"
  // that makes sense for a setting.
  const bad = await world.call('PUT', '/api/attendance/geofence', {
    token: world.managerToken,
    body: { latitude: 91, longitude: 200, geofence_radius_meters: 150 },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'IMPLAUSIBLE_COORDINATES');

  const good = await world.call('PUT', '/api/attendance/geofence', {
    token: world.managerToken,
    body: { latitude: BRANCH_LAT, longitude: BRANCH_LNG, geofence_radius_meters: 250 },
  });
  assert.equal(good.status, 200, JSON.stringify(good.json).slice(0, 200));
  const branch = await world.db.first('SELECT geofence_radius_meters FROM branches WHERE id = ?', [world.branchId]);
  assert.equal(Number(branch.geofence_radius_meters), 250);
});

test('attendance: a device nobody registered is flagged even when the person is on site', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  // `attendance_mode` decides whether the device axis is judged at all. Turn it
  // on for this branch, because that is the deployment where it matters.
  await world.db.run("UPDATE branches SET attendance_mode = 'REGISTERED_DEVICE' WHERE id = ?", [world.branchId]);

  const r = await world.call('POST', '/api/attendance/clock-in', {
    token: world.cashierToken,
    body: {
      latitude: offsetNorth(20), longitude: BRANCH_LNG, accuracy_meters: 8,
      device_id: 'a-phone-nobody-approved',
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.deviceStatus, 'UNRECOGNIZED');
  assert.equal(r.json.flagged, true, 'an unregistered device must be flagged in REGISTERED_DEVICE mode');
  assert.match(r.json.flags.join(' '), /not registered|device/i, `expected a device warning, got: ${r.json.flags.join(' | ')}`);
});

test('attendance: a branch with no coordinates says so instead of pretending', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  await world.db.run('UPDATE branches SET latitude = NULL, longitude = NULL WHERE id = ?', [world.branchId]);

  const r = await world.call('POST', '/api/attendance/clock-in', {
    token: world.cashierToken,
    body: { latitude: offsetNorth(20), longitude: BRANCH_LNG, accuracy_meters: 8, device_id: 'cashier-phone' },
  });
  assert.equal(r.status, 201, 'an unconfigured fence must never block a clock-in');
  assert.equal(r.json.locationStatus, 'NOT_CONFIGURED');
  assert.equal(r.json.geofenceConfigured, false, 'the response must admit that nothing is being checked');
});

test('attendance: clocking in twice is refused, and says when the first one was', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  const first = await world.call('POST', '/api/attendance/clock-in', {
    token: world.cashierToken,
    body: { latitude: offsetNorth(30), longitude: BRANCH_LNG, accuracy_meters: 8, device_id: 'cashier-phone' },
  });
  assert.equal(first.status, 201);

  const second = await world.call('POST', '/api/attendance/clock-in', {
    token: world.cashierToken,
    body: { latitude: offsetNorth(30), longitude: BRANCH_LNG, accuracy_meters: 8, device_id: 'cashier-phone' },
  });
  assert.equal(second.status, 409, 'two open shifts for one person makes neither countable');
  assert.equal(second.json.code, 'ALREADY_CLOCKED_IN');
});

test('attendance: the day list shows a manager what needs reviewing', async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);

  await world.call('POST', '/api/attendance/clock-in', {
    token: world.cashierToken,
    body: { latitude: offsetNorth(5000), longitude: BRANCH_LNG, accuracy_meters: 12, device_id: 'cashier-phone' },
  });

  const day = await world.call('GET', '/api/attendance/today', { token: world.managerToken });
  assert.equal(day.status, 200);
  // The day view answers with `records` (a roster) plus `absent` (who has not
  // turned up) and `needsReview`. The UI reads all three, so the contract is
  // asserted here rather than discovered in a screenshot.
  assert.ok(day.json.records.length >= 1, 'the day list must include the clock-in');
  assert.ok(Array.isArray(day.json.absent), 'and must say who has NOT arrived — that is what a manager acts on');
  assert.ok(Array.isArray(day.json.needsReview), 'and must surface the unreviewed flags');
  assert.equal(day.json.needsReview.length, 1, 'the off-site clock-in should be sitting in the review queue');
  assert.equal(Number(day.json.records[0].flagged), 1);

  // A manager signs it off, with a reason, and the queue empties.
  const id = day.json.needsReview[0].id;
  const noReason = await world.call('POST', `/api/attendance/${id}/review`, { token: world.managerToken, body: { accepted: false } });
  assert.equal(noReason.status, 400, 'a rejection with no explanation is not a review');
  const reviewed = await world.call('POST', `/api/attendance/${id}/review`, {
    token: world.managerToken, body: { accepted: true, note: 'Was delivering to Ikwerre Road, see waybill 8821' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json).slice(0, 200));

  const after = await world.call('GET', '/api/attendance/today', { token: world.managerToken });
  assert.equal(after.json.needsReview.length, 0, 'a reviewed flag must leave the queue');
  const row = await world.db.first('SELECT * FROM staff_attendance WHERE id = ?', [id]);
  assert.ok(row.reviewed_by, 'the reviewer is stamped on the row');
  assert.ok(row.flag_reason && row.flag_reason.length > 10,
    'and the ORIGINAL evidence survives the review — an override that erased it would remove the reason the override was needed');
});
