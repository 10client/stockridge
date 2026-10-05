'use strict';
// =====================================================================
// domain/time.js — West Africa Time and Nigerian business-calendar rules
// =====================================================================
// WHY THIS FILE EXISTS
// A live-verified bug in the original build: a sale made between 00:00 and
// 00:59 Lagos time was bucketed under the PREVIOUS calendar day in every
// day-based report, so the day's takings never matched the till and the
// owner spent their evening reconciling a discrepancy that did not exist.
//
// The cause is that SQLite's datetime('now') is UTC and Nigeria is UTC+1.
// Every day-bucketed query must convert on the way in. This module is the
// single place that knows the offset, so the rule cannot drift between
// the Node backend, the Worker backend and the browser.
//
// Note the deliberate choice NOT to use the IANA timezone database
// (Intl.DateTimeFormat with 'Africa/Lagos'). Nigeria has not observed DST
// since 1919 and WAT is a fixed UTC+1, so a constant offset is not a
// simplification here — it is the correct model, and it works identically
// on Cloudflare Workers where the tz database is not guaranteed.
// =====================================================================

const WAT_OFFSET_MINUTES = 60; // West Africa Time = UTC+1, no DST

/** Current UTC timestamp in SQLite's `datetime('now')` format. */
function utcNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Current West Africa Time timestamp in the same format. */
function watNow(date = new Date()) {
  const shifted = new Date(date.getTime() + WAT_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

/** Today's date in WAT, as YYYY-MM-DD. */
function watToday(date = new Date()) {
  return watNow(date).slice(0, 10);
}

/**
 * Parse any timestamp form this system meets into a UTC Date.
 *
 * WHY THIS EXISTS
 *
 * `utcToWat` and `watToDate` used to normalise by hand:
 * `s.replace('T',' ').replace(' ','T') + 'Z'`. For the single most common
 * input in the whole codebase — `new Date().toISOString()`, which is
 * `2026-10-05T09:30:00.000Z` — that produced `...000ZZ`, an Invalid Date,
 * and the functions returned **null**. A null timestamp does not throw; it
 * quietly disappears into a column, so a sale synced from an offline till
 * would have landed with no time at all. Both functions now route through
 * here, and a trailing `Z`, fractional seconds and an explicit offset are
 * all handled.
 *
 * Accepted: `YYYY-MM-DD HH:MM:SS` (SQLite's format, read as UTC),
 * ISO-8601 with or without `Z`/offset/fractional seconds, `YYYY-MM-DD`,
 * a Date instance, and epoch milliseconds.
 */
function parseTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let s = String(value).trim();
  if (!s) return null;

  // A bare date has no time and no zone: read it as UTC midnight so that
  // `2026-10-05` and `2026-10-05 00:00:00` behave identically.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;

  // SQLite's `YYYY-MM-DD HH:MM:SS` carries no zone marker. Everything this
  // system stores in that shape is UTC (`datetime('now')`), so say so
  // explicitly rather than letting the JS engine apply the host's local zone
  // — which would make the same string mean different things on a Lagos
  // server and a Cloudflare edge.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = `${s.replace(' ', 'T')}Z`;

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Convert a WAT timestamp string to a Date (UTC instant). */
function watToDate(watString) {
  const d = parseTimestamp(watString);
  if (!d) return null;
  return new Date(d.getTime() - WAT_OFFSET_MINUTES * 60 * 1000);
}

/** Convert a UTC timestamp (any accepted form) to a WAT timestamp string. */
function utcToWat(utcString) {
  const d = parseTimestamp(utcString);
  if (!d) return null;
  return new Date(d.getTime() + WAT_OFFSET_MINUTES * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The UTC instant of a WAT timestamp, in SQLite's storage format.
 *
 * The companion to utcToWat, and necessary because this schema stores BOTH
 * zones: `sales.sold_at` is West Africa Time (it is what every trading-day
 * report buckets on) while `created_at`, `updated_at`, `opened_at` and
 * `closed_at` are UTC from `datetime('now')`. Comparing one against the other
 * without converting is a one-hour error — enough to attach a sale to the wrong
 * till session at the open/close boundary, which is exactly the case the
 * conversion exists to get right.
 */
function watToUtc(watString) {
  const d = watToDate(watString);
  if (!d) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * SQLite expression that buckets a UTC column into a WAT day.
 *
 * The argument is interpolated straight into SQL, so it is validated as a
 * plain (optionally table-qualified) identifier and nothing else. Every
 * caller in this codebase passes a column name, but this function sits one
 * call away from a route handler, and an unguarded interpolation here is an
 * injection hole waiting for the first caller that passes a query parameter.
 * Rejecting loudly beats sanitising silently: a rejected column name is a
 * programming error that must be fixed, not a value to be quietly mangled.
 */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function watDaySql(column) {
  const name = String(column == null ? '' : column).trim();
  if (!SQL_IDENTIFIER.test(name)) {
    throw Object.assign(
      new Error(`watDaySql expects a column name such as "sold_at" or "s.sold_at", received ${JSON.stringify(column)}. `
        + 'This value is interpolated into SQL, so anything else is refused rather than escaped.'),
      { code: 'INVALID_SQL_COLUMN' },
    );
  }
  return `date(${name}, '+${WAT_OFFSET_MINUTES / 60} hours')`;
}

/** Start and end of a WAT day as UTC timestamp strings, for range queries. */
function watDayRangeUtc(day) {
  const d = String(day || watToday());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw Object.assign(new Error(`Invalid date "${day}", expected YYYY-MM-DD`), { status: 400, code: 'INVALID_DATE' });
  }
  const startWat = `${d} 00:00:00`;
  const endWat = `${d} 23:59:59`;
  return {
    day: d,
    startWat,
    endWat,
    startUtc: new Date(new Date(startWat.replace(' ', 'T') + 'Z').getTime() - WAT_OFFSET_MINUTES * 60000)
      .toISOString().slice(0, 19).replace('T', ' '),
    endUtc: new Date(new Date(endWat.replace(' ', 'T') + 'Z').getTime() - WAT_OFFSET_MINUTES * 60000)
      .toISOString().slice(0, 19).replace('T', ' '),
  };
}

/** Inclusive date range for the current WAT month. */
function watMonthRange(date = new Date()) {
  const today = watToday(date);
  const start = today.slice(0, 8) + '01';
  const [y, m] = today.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${today.slice(0, 8)}${String(lastDay).padStart(2, '0')}` };
}

/**
 * Add months to a YYYY-MM-DD date, clamping to the last valid day.
 * Clamping matters for instalment schedules: "31 January + 1 month" must
 * be 28/29 February, not 3 March, or a customer is billed a month late.
 */
function addMonths(dateString, months) {
  const d = new Date(`${String(dateString).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const targetMonth = d.getUTCMonth() + Number(months || 0);
  const year = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const d = new Date(`${String(dateString).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + Number(days || 0) * 86400000).toISOString().slice(0, 10);
}

/** Whole days between two dates (b - a), ignoring time-of-day. */
function daysBetween(a, b) {
  const da = new Date(`${String(a).slice(0, 10)}T00:00:00Z`).getTime();
  const db = new Date(`${String(b).slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

/**
 * Whole minutes from `utcA` to `utcB` (negative if B precedes A).
 *
 * Routed through parseTimestamp rather than hand-rolled string surgery, which
 * is what silently returned null for ISO strings carrying a trailing `Z`.
 * BOTH arguments must be in the SAME zone: this function measures the gap
 * between two timestamps and has no way to know that one is WAT and the other
 * UTC. Mixing them is how the sales void window ended up inverted by exactly
 * one hour — see the note in salesService.voidSale.
 */
function minutesBetween(utcA, utcB) {
  const a = parseTimestamp(utcA);
  const b = parseTimestamp(utcB);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

/** ISO week number, for weekly sales targets. */
function isoWeek(dateString) {
  const d = new Date(`${String(dateString).slice(0, 10)}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { year: d.getUTCFullYear(), week: Math.ceil((((d - yearStart) / 86400000) + 1) / 7) };
}

/**
 * Nigerian public holidays are declared annually by the Federal Government
 * and include both fixed and Islamic/Christian movable dates whose exact
 * day depends on moon sighting. Hardcoding them would be wrong within a
 * year of shipping, so this returns the FIXED ones only and flags the
 * movable ones as approximate. Reports use this to explain a zero-sales
 * day rather than to drive payroll — a distinction worth stating plainly,
 * because a shop that trades on Good Friday and one that does not are both
 * perfectly normal in Nigeria.
 */
const FIXED_NIGERIAN_HOLIDAYS = Object.freeze([
  { month: 1, day: 1, name: "New Year's Day" },
  { month: 5, day: 1, name: "Workers' Day" },
  { month: 5, day: 29, name: 'Democracy Day' },
  { month: 6, day: 12, name: 'June 12 Democracy Day' },
  { month: 10, day: 1, name: 'Independence Day' },
  { month: 12, day: 25, name: 'Christmas Day' },
  { month: 12, day: 26, name: 'Boxing Day' },
]);

const MOVABLE_NIGERIAN_HOLIDAYS = Object.freeze([
  'Good Friday', 'Easter Monday', 'Eid al-Fitr (Sallah)', 'Eid al-Adha (Big Sallah)',
  'Eid al-Mawlid', 'Id el-Kabir',
]);

function fixedHolidaysFor(year) {
  return FIXED_NIGERIAN_HOLIDAYS.map((h) => ({
    date: `${year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`,
    name: h.name,
    movable: false,
  }));
}

module.exports = {
  WAT_OFFSET_MINUTES,
  utcNow, watNow, watToday, watToDate, utcToWat, watToUtc, parseTimestamp, watDaySql, watDayRangeUtc, watMonthRange,
  addMonths, addDays, daysBetween, minutesBetween, isoWeek,
  FIXED_NIGERIAN_HOLIDAYS, MOVABLE_NIGERIAN_HOLIDAYS, fixedHolidaysFor,
};
