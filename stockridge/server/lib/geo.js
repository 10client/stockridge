// =====================================================================
// StockRidge — GEO / GEOFENCE
// =====================================================================
// Attendance verification. The design decision carried over from
// PharmaRidge is the important part and it is a POLICY decision, not a
// technical one:
//
//   THE GEO CHECK IS A SIGNAL, NEVER A GATE.
//
// An off-site or no-location clock-in is FLAGGED for manager review, never
// rejected. Reasons that are all true on a Nigerian shop floor:
//   * GPS permissions are denied by a large share of users, permanently.
//   * A showroom inside a mall or under a metal roof may never get a fix.
//   * Cheap Android handsets report wildly inaccurate positions indoors.
//   * Data/airplane mode means no position at the exact moment of clock-in.
// Rejecting a clock-in for any of those means a cashier cannot start their
// shift, and the workaround they will find is a buddy punching in for them
// from inside the shop — which defeats the control entirely and loses the
// audit trail as well.
//
// Distance is Haversine on a sphere. Accuracy to a few metres is plenty for
// a 100 m geofence; a Vincenty ellipsoid solution would be more correct and
// completely pointless here.
// =====================================================================

const EARTH_RADIUS_M = 6371008.8;   // mean radius, WGS-84

function toRadians(deg) { return (Number(deg) * Math.PI) / 180; }

// Great-circle distance in metres. Returns null when either coordinate pair
// is missing, because "unknown" must never be reported as 0 m (which would
// read as ON_SITE) or as Infinity (which would read as OFF_SITE).
function haversineMeters(lat1, lon1, lat2, lon2) {
  const a = Number(lat1); const b = Number(lon1); const c = Number(lat2); const d = Number(lon2);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  if (Math.abs(a) > 90 || Math.abs(c) > 90 || Math.abs(b) > 180 || Math.abs(d) > 180) return null;
  const dLat = toRadians(c - a);
  const dLon = toRadians(d - b);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(a)) * Math.cos(toRadians(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Classify one clock-in. The four outcomes are exhaustive and the caller
// stores whichever it gets — it never decides the classification itself.
function classifyLocation({ branch, latitude, longitude, deviceMatched = null, attendanceMode = null }) {
  const mode = String(attendanceMode || (branch && branch.attendance_mode) || 'GEOLOCATION').toUpperCase();

  if (mode === 'REGISTERED_DEVICE') {
    // A laptop that cannot move is identified by its browser device id.
    // Unrecognised is FLAGGED, not blocked, for the same reason off-site is.
    if (deviceMatched === true) return { status: 'DEVICE_MATCHED', distance_meters: null, needs_review: 0, mode };
    if (deviceMatched === false) return { status: 'DEVICE_UNRECOGNIZED', distance_meters: null, needs_review: 1, mode };
    return { status: 'NO_LOCATION', distance_meters: null, needs_review: 1, mode };
  }

  if (latitude == null || longitude == null) {
    return { status: 'NO_LOCATION', distance_meters: null, needs_review: 1, mode };
  }
  if (!branch || branch.latitude == null || branch.longitude == null) {
    // The branch has no geofence centre configured yet. That is a setup
    // gap, not a staff offence — flag it for the manager to fix, and say so
    // explicitly so the manager does not read it as a suspicious employee.
    return { status: 'NO_LOCATION', distance_meters: null, needs_review: 1, mode, reason: 'BRANCH_GEOFENCE_NOT_CONFIGURED' };
  }

  const distance = haversineMeters(branch.latitude, branch.longitude, latitude, longitude);
  if (distance == null) return { status: 'NO_LOCATION', distance_meters: null, needs_review: 1, mode };
  const radius = Number(branch.geofence_radius_meters) > 0 ? Number(branch.geofence_radius_meters) : 100;
  return {
    status: distance <= radius ? 'ON_SITE' : 'OFF_SITE',
    distance_meters: Math.round(distance),
    radius_meters: radius,
    needs_review: distance <= radius ? 0 : 1,
    mode,
  };
}

// Suggest a geofence radius from observed clock-ins, so a manager is not
// guessing. Uses the 90th percentile plus a floor: the median would place
// the fence inside the shop and flag half the honest staff.
function suggestRadiusMeters(samples, { floor = 50, ceiling = 1000 } = {}) {
  const distances = samples
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!distances.length) return floor;
  const idx = Math.min(distances.length - 1, Math.ceil(distances.length * 0.9) - 1);
  const suggested = Math.ceil(distances[Math.max(0, idx)] / 10) * 10;
  return Math.min(ceiling, Math.max(floor, suggested));
}

// Nigerian state list. Used for validation and for tax-jurisdiction
// reporting (VAT is federal, but state levies, signage rules and trade
// permits are not, and a multi-state chain needs to group by state).
const NIGERIAN_STATES = Object.freeze([
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT - Abuja', 'Gombe',
  'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos',
  'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto',
  'Taraba', 'Yobe', 'Zamfara',
]);
const STATE_SET = new Set(NIGERIAN_STATES.map((s) => s.toLowerCase()));

function isNigerianState(value) {
  if (!value) return false;
  const s = String(value).trim().toLowerCase();
  if (STATE_SET.has(s)) return true;
  // Common colloquial spellings a cashier will actually type.
  const aliases = { 'abuja': 'fct - abuja', 'fct': 'fct - abuja', 'fct abuja': 'fct - abuja', 'rivers state': 'rivers', 'lagos state': 'lagos' };
  return Object.prototype.hasOwnProperty.call(aliases, s);
}

function normaliseState(value) {
  if (!value) return null;
  const s = String(value).trim();
  const lower = s.toLowerCase();
  const found = NIGERIAN_STATES.find((x) => x.toLowerCase() === lower);
  if (found) return found;
  const aliases = { 'abuja': 'FCT - Abuja', 'fct': 'FCT - Abuja', 'fct abuja': 'FCT - Abuja' };
  if (aliases[lower]) return aliases[lower];
  // Title-case an unrecognised value rather than rejecting it: a new LGA or
  // a typo should not block a customer record.
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = {
  EARTH_RADIUS_M, haversineMeters, classifyLocation, suggestRadiusMeters,
  NIGERIAN_STATES, isNigerianState, normaliseState,
};
