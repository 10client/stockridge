// =====================================================================
// shared/lib/timegeo.js — WEST AFRICA TIME AND NIGERIAN GEOGRAPHY
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE, WHICH LEARNED THIS THE HARD WAY.
//
// Migration 009 of the pharmacy schema exists because of a live-verified bug:
// every day-based report bucketed by raw UTC, so a sale made between 00:00 and
// 00:59 Lagos time was counted under the PREVIOUS calendar day. A shop that
// trades past midnight — and in Nigeria plenty do — had a daily sales report
// that was wrong every single day, in a way that looked plausible because the
// monthly total still came out right.
//
// StockRidge therefore has ONE definition of "today", in ONE place, and every
// date-bucketing query in the system uses it. Nigeria observes West Africa Time
// (UTC+1) year-round with NO daylight saving, which makes this a fixed offset
// rather than a timezone database lookup — but the offset is a named constant
// here, not a magic `+1 hours` scattered across SQL, so if it ever changed the
// change is one edit and one migration rather than an audit.
//
// ALSO HERE: the state/LGA reference and the geofence maths, because both are
// "facts about Nigeria" that must not be re-derived per module.

'use strict';

// ---------------------------------------------------------------------
// TIME
// ---------------------------------------------------------------------
const WAT_UTC_OFFSET_HOURS = 1;
const TIMEZONE_LABEL = 'Africa/Lagos (WAT, UTC+1)';

/** Current time in WAT as a Date whose UTC fields read as WAT wall-clock. */
function nowWat(now = new Date()) {
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  return new Date(d.getTime() + WAT_UTC_OFFSET_HOURS * 3600000);
}

/** Today's date in WAT, as YYYY-MM-DD. THE definition of "today". */
function todayWat(now = new Date()) {
  return nowWat(now).toISOString().slice(0, 10);
}

/** Current WAT wall-clock as YYYY-MM-DD HH:MM:SS (what SQLite datetime('now') would say in Lagos). */
function watTimestamp(now = new Date()) {
  return nowWat(now).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The SQL fragment every date-bucketing query must use.
 *
 * SQLite stores `datetime('now')` in UTC. To bucket by Lagos calendar day you
 * shift the stored value forward one hour and THEN take the date part. Doing it
 * in this order matters: `date(created_at) + 1 hour` is not the same as
 * `date(created_at + 1 hour)` for a row stamped at 23:30 UTC.
 */
const SQL_WAT_DATE = (column) => `date(${column}, '+${WAT_UTC_OFFSET_HOURS} hours')`;
const SQL_WAT_NOW = `datetime('now', '+${WAT_UTC_OFFSET_HOURS} hours')`;
const SQL_WAT_TODAY = `date('now', '+${WAT_UTC_OFFSET_HOURS} hours')`;

/** Business day boundaries in WAT. A "trading day" ends when the shop closes,
 *  not at midnight — but the REPORTING day is the calendar day, and the two are
 *  kept separate on purpose so a till that closes at 01:00 is still reported
 *  against the day it opened. */
function tradingDayRange(dayIso) {
  const d = String(dayIso).slice(0, 10);
  return {
    day: d,
    startUtc: `${d}T${String(24 - WAT_UTC_OFFSET_HOURS).padStart(2, '0')}:00:00Z`.replace('24:00:00Z', '00:00:00Z'),
    // WAT midnight == 23:00 UTC of the PREVIOUS day.
    startUtcIso: new Date(Date.parse(`${d}T00:00:00Z`) - WAT_UTC_OFFSET_HOURS * 3600000).toISOString(),
    endUtcIso: new Date(Date.parse(`${d}T00:00:00Z`) + (24 - WAT_UTC_OFFSET_HOURS) * 3600000).toISOString(),
  };
}

/** Is a given WAT timestamp inside typical Nigerian trading hours? Used by
 *  anomaly detection: a sale at 03:40 is worth a second look. */
function isWithinTradingHours(watTimestampStr, { openHour = 7, closeHour = 21 } = {}) {
  const m = String(watTimestampStr || '').match(/(\d{2}):(\d{2})/);
  if (!m) return true; // unknown time: never flag on a parse failure
  const h = Number(m[1]);
  return h >= openHour && h < closeHour;
}

// ---------------------------------------------------------------------
// GEOGRAPHY
// ---------------------------------------------------------------------
// 36 states + the FCT, with their principal commercial cities. This is NOT a
// full LGA gazette (there are 774 and it changes); it is the list a delivery
// zone table, a branch address form and a sales-by-state report actually need.
// LGAs are loaded from data/nigeria-geo.json when a client needs the full set.
const NIGERIAN_STATES = Object.freeze([
  { code: 'AB', name: 'Abia', capital: 'Umuahia', city: 'Aba', zone: 'SOUTH_EAST' },
  { code: 'AD', name: 'Adamawa', capital: 'Yola', city: 'Yola', zone: 'NORTH_EAST' },
  { code: 'AK', name: 'Akwa Ibom', capital: 'Uyo', city: 'Uyo', zone: 'SOUTH_SOUTH' },
  { code: 'AN', name: 'Anambra', capital: 'Awka', city: 'Onitsha', zone: 'SOUTH_EAST' },
  { code: 'BA', name: 'Bauchi', capital: 'Bauchi', city: 'Bauchi', zone: 'NORTH_EAST' },
  { code: 'BY', name: 'Bayelsa', capital: 'Yenagoa', city: 'Yenagoa', zone: 'SOUTH_SOUTH' },
  { code: 'BE', name: 'Benue', capital: 'Makurdi', city: 'Makurdi', zone: 'NORTH_CENTRAL' },
  { code: 'BO', name: 'Borno', capital: 'Maiduguri', city: 'Maiduguri', zone: 'NORTH_EAST' },
  { code: 'CR', name: 'Cross River', capital: 'Calabar', city: 'Calabar', zone: 'SOUTH_SOUTH' },
  { code: 'DE', name: 'Delta', capital: 'Asaba', city: 'Warri', zone: 'SOUTH_SOUTH' },
  { code: 'EB', name: 'Ebonyi', capital: 'Abakaliki', city: 'Abakaliki', zone: 'SOUTH_EAST' },
  { code: 'ED', name: 'Edo', capital: 'Benin City', city: 'Benin City', zone: 'SOUTH_SOUTH' },
  { code: 'EK', name: 'Ekiti', capital: 'Ado-Ekiti', city: 'Ado-Ekiti', zone: 'SOUTH_WEST' },
  { code: 'EN', name: 'Enugu', capital: 'Enugu', city: 'Enugu', zone: 'SOUTH_EAST' },
  { code: 'FC', name: 'Federal Capital Territory', capital: 'Abuja', city: 'Abuja', zone: 'NORTH_CENTRAL' },
  { code: 'GO', name: 'Gombe', capital: 'Gombe', city: 'Gombe', zone: 'NORTH_EAST' },
  { code: 'IM', name: 'Imo', capital: 'Owerri', city: 'Owerri', zone: 'SOUTH_EAST' },
  { code: 'JI', name: 'Jigawa', capital: 'Dutse', city: 'Dutse', zone: 'NORTH_WEST' },
  { code: 'KD', name: 'Kaduna', capital: 'Kaduna', city: 'Kaduna', zone: 'NORTH_WEST' },
  { code: 'KN', name: 'Kano', capital: 'Kano', city: 'Kano', zone: 'NORTH_WEST' },
  { code: 'KT', name: 'Katsina', capital: 'Katsina', city: 'Katsina', zone: 'NORTH_WEST' },
  { code: 'KE', name: 'Kebbi', capital: 'Birnin Kebbi', city: 'Birnin Kebbi', zone: 'NORTH_WEST' },
  { code: 'KO', name: 'Kogi', capital: 'Lokoja', city: 'Lokoja', zone: 'NORTH_CENTRAL' },
  { code: 'KW', name: 'Kwara', capital: 'Ilorin', city: 'Ilorin', zone: 'NORTH_CENTRAL' },
  { code: 'LA', name: 'Lagos', capital: 'Ikeja', city: 'Lagos', zone: 'SOUTH_WEST' },
  { code: 'NA', name: 'Nasarawa', capital: 'Lafia', city: 'Lafia', zone: 'NORTH_CENTRAL' },
  { code: 'NI', name: 'Niger', capital: 'Minna', city: 'Minna', zone: 'NORTH_CENTRAL' },
  { code: 'OG', name: 'Ogun', capital: 'Abeokuta', city: 'Abeokuta', zone: 'SOUTH_WEST' },
  { code: 'ON', name: 'Ondo', capital: 'Akure', city: 'Akure', zone: 'SOUTH_WEST' },
  { code: 'OS', name: 'Osun', capital: 'Osogbo', city: 'Osogbo', zone: 'SOUTH_WEST' },
  { code: 'OY', name: 'Oyo', capital: 'Ibadan', city: 'Ibadan', zone: 'SOUTH_WEST' },
  { code: 'PL', name: 'Plateau', capital: 'Jos', city: 'Jos', zone: 'NORTH_CENTRAL' },
  { code: 'RI', name: 'Rivers', capital: 'Port Harcourt', city: 'Port Harcourt', zone: 'SOUTH_SOUTH' },
  { code: 'SO', name: 'Sokoto', capital: 'Sokoto', city: 'Sokoto', zone: 'NORTH_WEST' },
  { code: 'TA', name: 'Taraba', capital: 'Jalingo', city: 'Jalingo', zone: 'NORTH_EAST' },
  { code: 'YO', name: 'Yobe', capital: 'Damaturu', city: 'Damaturu', zone: 'NORTH_EAST' },
  { code: 'ZA', name: 'Zamfara', capital: 'Gusau', city: 'Gusau', zone: 'NORTH_WEST' },
]);

const GEO_POLITICAL_ZONES = Object.freeze([
  { code: 'NORTH_CENTRAL', label: 'North Central' },
  { code: 'NORTH_EAST',    label: 'North East' },
  { code: 'NORTH_WEST',    label: 'North West' },
  { code: 'SOUTH_EAST',    label: 'South East' },
  { code: 'SOUTH_SOUTH',   label: 'South South' },
  { code: 'SOUTH_WEST',    label: 'South West' },
]);

// Well-known commercial districts, used to seed delivery zones. A delivery
// quote engine keyed on "Lagos" is useless; keyed on "Ikeja", "Lekki Phase 1",
// "Alaba International" and "Computer Village" it matches how the market
// actually talks about itself.
const COMMERCIAL_HUBS = Object.freeze([
  { state: 'LA', area: 'Ikeja', note: 'Computer Village — the national electronics market' },
  { state: 'LA', area: 'Alaba International', note: 'Electronics and appliances wholesale' },
  { state: 'LA', area: 'Lekki Phase 1', note: 'High-value retail and furniture' },
  { state: 'LA', area: 'Victoria Island', note: 'Corporate and project supply' },
  { state: 'LA', area: 'Surulere', note: 'Furniture and general merchandise' },
  { state: 'LA', area: 'Mushin', note: 'Wholesale general merchandise' },
  { state: 'LA', area: 'Apapa', note: 'Port-side building materials and imports' },
  { state: 'LA', area: 'Yaba', note: 'Tejuosho market — textiles and general goods' },
  { state: 'LA', area: 'Oshodi', note: 'Wholesale distribution' },
  { state: 'LA', area: 'Agege', note: 'General merchandise retail' },
  { state: 'KN', area: 'Kano (Sabon Gari)', note: 'The largest wholesale market in West Africa' },
  { state: 'KN', area: 'Kano (Kurmi)', note: 'General merchandise and textiles' },
  { state: 'AN', area: 'Onitsha (Main Market)', note: 'National wholesale hub' },
  { state: 'AN', area: 'Nkwor Nnewi', note: 'Auto parts and hardware' },
  { state: 'AB', area: 'Aba (Ariaria)', note: 'Manufactured goods, footwear, furniture' },
  { state: 'FC', area: 'Abuja (Wuse)', note: 'Retail and corporate supply' },
  { state: 'FC', area: 'Abuja (Gwarinpa)', note: 'Furniture and home retail' },
  { state: 'FC', area: 'Abuja (Dei-Dei)', note: 'Building materials market' },
  { state: 'RI', area: 'Port Harcourt (Mile 3)', note: 'General merchandise' },
  { state: 'OY', area: 'Ibadan (Gbodofonja)', note: 'Building materials and hardware' },
  { state: 'OG', area: 'Otta', note: 'Industrial supply and building materials' },
  { state: 'ED', area: 'Benin City (Ikpoba Hill)', note: 'Furniture and timber' },
]);

const STATE_BY_CODE = Object.freeze(Object.fromEntries(NIGERIAN_STATES.map((s) => [s.code, s])));
const STATE_BY_NAME = Object.freeze(Object.fromEntries(NIGERIAN_STATES.map((s) => [s.name.toUpperCase(), s])));

function stateByCodeOrName(value) {
  if (!value) return null;
  const s = String(value).trim();
  return STATE_BY_CODE[s.toUpperCase()] || STATE_BY_NAME[s.toUpperCase()] || null;
}

/** Approximate bounding box of Nigeria, for a sanity check on GPS input. */
const NIGERIA_BOUNDS = Object.freeze({ minLat: 4.0, maxLat: 14.2, minLng: 2.5, maxLng: 14.8 });

function isInsideNigeria(lat, lng) {
  const a = Number(lat); const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a >= NIGERIA_BOUNDS.minLat && a <= NIGERIA_BOUNDS.maxLat
    && b >= NIGERIA_BOUNDS.minLng && b <= NIGERIA_BOUNDS.maxLng;
}

/**
 * Haversine distance in metres.
 *
 * Used for geofenced attendance. Computed SERVER-SIDE and stored per record —
 * never trusted from the client, because a client-computed distance is a
 * client-asserted alibi.
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const a = Number(lat1); const b = Number(lng1); const c = Number(lat2); const d = Number(lng2);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  const dLat = toRad(c - a);
  const dLng = toRad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Classify a clock-in against a branch geofence.
 *
 * NEVER BLOCKS. This is the design decision PharmaRidge arrived at after living
 * with it, and it is the right one: GPS accuracy indoors is poor, permissions
 * vary by device, and a shop in a Lagos plaza may read 300 m off on a bad day.
 * An off-site reading is a SIGNAL FOR MANAGER REVIEW, not a refusal — because a
 * system that locks a cashier out of the till at 8am on a Saturday over a
 * satellite is a system that gets switched off.
 */
const ATTENDANCE_CLASSIFICATIONS = Object.freeze(['ON_SITE', 'OFF_SITE', 'NO_LOCATION', 'GEOFENCE_NOT_SET']);

function classifyAttendance({ lat, lng, branch, deviceRecognised = null }) {
  if (branch && String(branch.attendance_mode || '').toUpperCase() === 'REGISTERED_DEVICE') {
    // Device mode: the browser's persistent device id either matches a device
    // the manager registered FOR THIS BRANCH or it does not. Same rule —
    // flag, never block.
    if (deviceRecognised === true) return { classification: 'ON_SITE', distanceMeters: null, flagged: false, method: 'REGISTERED_DEVICE' };
    if (deviceRecognised === false) {
      return {
        classification: 'OFF_SITE', distanceMeters: null, flagged: true, method: 'REGISTERED_DEVICE',
        note: 'This device is not registered to this branch. Flagged for manager review — the clock-in was still recorded.',
      };
    }
    return { classification: 'NO_LOCATION', distanceMeters: null, flagged: true, method: 'REGISTERED_DEVICE', note: 'Device could not be identified.' };
  }

  if (!branch || branch.latitude == null || branch.longitude == null) {
    return {
      classification: 'GEOFENCE_NOT_SET', distanceMeters: null, flagged: true, method: 'GEOLOCATION',
      note: 'This branch has no GPS position set, so attendance cannot be location-verified. Set it from Branches → Edit.',
    };
  }
  if (lat == null || lng == null) {
    return {
      classification: 'NO_LOCATION', distanceMeters: null, flagged: true, method: 'GEOLOCATION',
      note: 'No location was available from this device (permission denied, or indoors with no fix). Recorded and flagged for review.',
    };
  }
  const dist = haversineMeters(lat, lng, branch.latitude, branch.longitude);
  const radius = Math.max(10, Number(branch.geofence_radius_meters) || 100);
  if (dist == null) {
    return { classification: 'NO_LOCATION', distanceMeters: null, flagged: true, method: 'GEOLOCATION', note: 'Location could not be interpreted.' };
  }
  return {
    classification: dist <= radius ? 'ON_SITE' : 'OFF_SITE',
    distanceMeters: dist,
    radiusMeters: radius,
    flagged: dist > radius,
    method: 'GEOLOCATION',
    note: dist > radius
      ? `Clock-in was ${dist} m from the branch (geofence ${radius} m). Recorded and flagged for manager review — not rejected.`
      : null,
  };
}

module.exports = {
  WAT_UTC_OFFSET_HOURS, TIMEZONE_LABEL,
  nowWat, todayWat, watTimestamp,
  SQL_WAT_DATE, SQL_WAT_NOW, SQL_WAT_TODAY,
  tradingDayRange, isWithinTradingHours,
  NIGERIAN_STATES, GEO_POLITICAL_ZONES, COMMERCIAL_HUBS,
  STATE_BY_CODE, stateByCodeOrName, NIGERIA_BOUNDS, isInsideNigeria,
  haversineMeters, ATTENDANCE_CLASSIFICATIONS, classifyAttendance,
};
