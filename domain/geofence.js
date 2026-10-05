'use strict';
// =====================================================================
// domain/geofence.js — ATTENDANCE LOCATION AND DEVICE VERIFICATION
// =====================================================================
// BEST-EFFORT SIGNAL, NEVER A HARD GATE.
//
// This is the single most important design decision in the attendance
// feature and it is stated here because it is easy to get wrong in the
// "obvious" direction. The obvious implementation refuses a clock-in that
// is outside the geofence. That implementation fails on the first day of
// real use, for reasons that are not the staff member's fault:
//
//   - Android WebView and iOS Safari both deny or silently omit
//     geolocation inside an installed PWA unless the permission was granted
//     in a specific earlier context.
//   - Indoor retail units in a Nigerian plaza often get no GPS fix at all.
//   - A phone with location off returns null, not an error.
//   - Urban multipath puts a genuine on-site reading 200m away.
//
// A cashier who cannot clock in is a shop that cannot open. So an off-site
// or no-location attempt is RECORDED and FLAGGED for manager review, never
// rejected. The manager sees "Chidinma clocked in 340m from the branch" and
// decides what that means. The system's job is to make buddy-punching
// VISIBLE and auditable, not to be the security guard.
//
// The same logic applies to REGISTERED_DEVICE mode, and the device id is
// honest about what it is: a random value generated once client-side and
// persisted in that browser's localStorage. No web page can read a hardware
// serial number — every modern browser blocks it, including on
// native-feeling PWA installs. Clearing site data or switching browsers
// resets it. That is the same practical guarantee commercial POS
// terminal-locking relies on, and it is stated plainly here so nobody
// over-trusts it.
// =====================================================================

const EARTH_RADIUS_METERS = 6371008.8; // mean radius, WGS-84

/**
 * Haversine great-circle distance in metres.
 *
 * Accurate to well under a metre at retail-geofence scales (tens to
 * hundreds of metres), which is far inside the noise floor of consumer GPS.
 * The mean radius rather than the equatorial one is used because at the
 * latitudes Nigeria occupies (4-14°N) the difference is under 0.2%, and a
 * 0.2% error on a 100m fence is 20cm — irrelevant next to a GPS fix that
 * may itself be 15m off.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const a = Number(lat1); const b = Number(lon1); const c = Number(lat2); const d = Number(lon2);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  if (Math.abs(a) > 90 || Math.abs(c) > 90) return null;
  if (Math.abs(b) > 180 || Math.abs(d) > 180) return null;
  const dLat = toRad(c - a);
  const dLon = toRad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

const LOCATION_STATUS = Object.freeze({
  ON_SITE: 'ON_SITE',
  OFF_SITE: 'OFF_SITE',
  NO_LOCATION: 'NO_LOCATION',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
});

const DEVICE_STATUS = Object.freeze({
  REGISTERED: 'REGISTERED',
  UNRECOGNIZED: 'UNRECOGNIZED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
});

/**
 * Classify a clock-in against a branch's geofence.
 *
 * Returns a status, the measured distance, and a human-readable flag
 * reason. NEVER returns an error and NEVER blocks.
 */
function classifyLocation({ branch, latitude, longitude }) {
  if (!branch || branch.latitude == null || branch.longitude == null) {
    return {
      status: LOCATION_STATUS.NOT_CONFIGURED,
      distanceMeters: null,
      flagged: false,
      flagReason: null,
      // Surfaced so the manager is told the fence does not exist yet rather
      // than silently collecting unclassified records forever.
      needsConfiguration: true,
    };
  }
  if (latitude == null || longitude == null || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
    return {
      status: LOCATION_STATUS.NO_LOCATION,
      distanceMeters: null,
      flagged: true,
      flagReason: 'No location was available on this device. This usually means location permission was denied or the phone has no GPS fix indoors — it does not by itself mean the person was elsewhere.',
      needsConfiguration: false,
    };
  }
  const distance = haversineMeters(branch.latitude, branch.longitude, Number(latitude), Number(longitude));
  if (distance == null) {
    return {
      status: LOCATION_STATUS.NO_LOCATION, distanceMeters: null, flagged: true,
      flagReason: 'The reported coordinates were not valid.', needsConfiguration: false,
    };
  }
  const radius = Number(branch.geofence_radius_meters) > 0 ? Number(branch.geofence_radius_meters) : 100;
  const rounded = Math.round(distance);
  if (rounded <= radius) {
    return { status: LOCATION_STATUS.ON_SITE, distanceMeters: rounded, flagged: false, flagReason: null, needsConfiguration: false };
  }
  return {
    status: LOCATION_STATUS.OFF_SITE,
    distanceMeters: rounded,
    flagged: true,
    flagReason: `Clock-in was ${rounded.toLocaleString('en-NG')}m from ${branch.name || 'the branch'}, outside the ${radius.toLocaleString('en-NG')}m boundary. Review: this may be GPS drift, a delivery run, or the wrong location.`,
    needsConfiguration: false,
  };
}

/** Classify a clock-in against the branch's registered device list. */
function classifyDevice({ branch, deviceId, registeredDeviceIds }) {
  if (!branch || String(branch.attendance_mode || 'GEOLOCATION').toUpperCase() !== 'REGISTERED_DEVICE') {
    return { status: DEVICE_STATUS.NOT_APPLICABLE, flagged: false, flagReason: null };
  }
  const registered = new Set((registeredDeviceIds || []).map(String));
  if (!deviceId) {
    return {
      status: DEVICE_STATUS.UNRECOGNIZED, flagged: true,
      flagReason: 'No device identifier was sent. This browser may have cleared its site data, which resets the identifier — re-register the machine if this is a known till.',
    };
  }
  if (registered.has(String(deviceId))) {
    return { status: DEVICE_STATUS.REGISTERED, flagged: false, flagReason: null };
  }
  return {
    status: DEVICE_STATUS.UNRECOGNIZED, flagged: true,
    flagReason: 'This machine is not registered to this branch. If it is a new or replaced till, a manager should register it under Branch Devices; if it is not, the clock-in needs review.',
  };
}

/**
 * Combine both classifications into the decision that is actually stored.
 * Flagged if EITHER axis is unhappy — a manager reviewing wants one list,
 * not two.
 */
function classifyAttendance({ branch, latitude, longitude, deviceId, registeredDeviceIds }) {
  const loc = classifyLocation({ branch, latitude, longitude });
  const dev = classifyDevice({ branch, deviceId, registeredDeviceIds });
  const flagReasons = [loc.flagReason, dev.flagReason].filter(Boolean);
  return {
    locationStatus: loc.status,
    distanceMeters: loc.distanceMeters,
    deviceStatus: dev.status,
    flagged: Boolean(loc.flagged || dev.flagged) ? 1 : 0,
    flagReason: flagReasons.length ? flagReasons.join(' ') : null,
    needsGeofenceConfiguration: Boolean(loc.needsConfiguration),
  };
}

/** Hours worked between two timestamps, rounded to 2dp. */
function hoursBetween(clockInUtc, clockOutUtc) {
  const a = Date.parse(String(clockInUtc).replace(' ', 'T') + (String(clockInUtc).endsWith('Z') ? '' : 'Z'));
  const b = Date.parse(String(clockOutUtc).replace(' ', 'T') + (String(clockOutUtc).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return Math.round(((b - a) / 3600000) * 100) / 100;
}

/**
 * Sanity guard on a submitted coordinate pair.
 *
 * Deliberately permissive: Nigeria spans roughly 4-14°N and 2-15°E, but a
 * business with a branch in Accra, Douala or London must not be refused.
 * The check exists to reject the values that indicate a BUG rather than a
 * place: (0,0) from an uninitialised GPS, or a swapped lat/lng pair, which
 * would otherwise classify a genuine on-site clock-in as 6,000km away and
 * flag an honest cashier every single day.
 */
function coordinatesArePlausible(latitude, longitude) {
  const lat = Number(latitude); const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { plausible: false, reason: 'Coordinates were not numbers.' };
  if (lat === 0 && lon === 0) return { plausible: false, reason: 'Coordinates were exactly 0,0 — the device reported an uninitialised GPS fix.' };
  if (Math.abs(lat) > 90) return { plausible: false, reason: 'Latitude is outside -90..90 — the values may be swapped.' };
  if (Math.abs(lon) > 180) return { plausible: false, reason: 'Longitude is outside -180..180.' };
  if (Math.abs(lat) > 66 && Math.abs(lon) < 20) {
    return { plausible: true, suspect: true, reason: 'Latitude and longitude may be swapped: this point is in the Arctic. Recorded as given.' };
  }
  return { plausible: true, suspect: false, reason: null };
}

module.exports = {
  EARTH_RADIUS_METERS, LOCATION_STATUS, DEVICE_STATUS,
  haversineMeters, classifyLocation, classifyDevice, classifyAttendance,
  hoursBetween, coordinatesArePlausible,
};
