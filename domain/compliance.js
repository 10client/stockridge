'use strict';
// =====================================================================
// domain/compliance.js — WHETHER A PERMIT IS STILL GOOD, AND WHO SHOULD HEAR
// =====================================================================
// A branch's licences live in `branch_compliance_records`: a CAC registration, a
// TIN, a SONCAP dealer registration, a state trading permit, a fire certificate.
// The schema describes them per BRANCH rather than per business because that is
// how Nigerian regulators work — a trading permit names a premises, and a second
// shop in another LGA needs its own.
//
// Everything here is pure: given records and a date, what is the state of each
// one, and what should the application say about it. The route, the daily cron
// and the tests all call these functions, so there is one definition of
// "expiring" rather than three that drift.
//
// TWO HORIZONS, and they are different things:
//
//   the WINDOW    how far ahead THIS shop wants warning. A setting
//                 (`client_settings.compliance_alert_days`, default 30 days),
//                 because a bar with a fire certificate and a dealer with a
//                 SONCAP registration do not think about renewals on the same
//                 timetable.
//
//   the HORIZON   how far ahead the schema is willing to look at all. The view
//                 `v_compliance_expiry_alerts` stops at 90 days, in SQL. It is a
//                 fixed outer bound — a quarter's notice — and the alert list can
//                 never see past it, so a window wider than the horizon is
//                 reported as the horizon rather than silently promised.
//
// A record with NO expiry date does not expire (a TIN, a CAC number) and is never
// an alert, whatever the window says. The view agrees, in its own WHERE clause.
// =====================================================================

/**
 * How far ahead `v_compliance_expiry_alerts` looks, in days.
 *
 * This number is a COPY of policy that lives in SQL, and the copy is the point:
 * the application must be able to say "the list cannot show you further than 90
 * days" without asking the database. `test/integration/compliance.test.js`
 * asserts that the view and this constant agree, by inserting a record exactly at
 * the horizon and reading both — so the copy cannot drift in silence.
 */
const ALERT_HORIZON_DAYS = 90;

/** The default window, matching `client_settings.compliance_alert_days`. */
const DEFAULT_ALERT_WINDOW_DAYS = 30;

/** The widest window worth accepting: see ALERT_HORIZON_DAYS above. */
const MAX_ALERT_WINDOW_DAYS = ALERT_HORIZON_DAYS;

/**
 * Whole days from `today` to `date`, both ISO `YYYY-MM-DD`.
 *
 * Date arithmetic on strings through Date.UTC rather than `new Date(iso)`, which
 * parses a bare date as UTC midnight and can land on the previous day once the
 * local timezone is applied — the kind of off-by-one that makes a permit expire a
 * day early in Lagos but not in London.
 */
function daysBetween(today, date) {
  const a = String(today || '').slice(0, 10);
  const b = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const from = Date.UTC(ay, am - 1, ad);
  const to = Date.UTC(by, bm - 1, bd);
  return Math.round((to - from) / 86400000);
}

/**
 * What state one record is in, on one day.
 *
 * EXPIRED is 0 days or fewer — a permit that expires TODAY is still valid at the
 * counter this morning and is the most urgent thing on the list, so it is
 * reported under EXPIRING with daysToExpiry 0 rather than being called expired a
 * day early. The view uses the same convention (`<= 90`, and a negative
 * daysToExpiry for a lapsed one), which is what makes the two agree.
 */
function recordStatus(record, { today, windowDays = DEFAULT_ALERT_WINDOW_DAYS } = {}) {
  const expiry = record && record.expiry_date ? String(record.expiry_date).slice(0, 10) : null;
  if (!expiry) return { status: 'NO_EXPIRY', daysToExpiry: null, expired: false, alerting: false };

  const days = daysBetween(today, expiry);
  if (days === null) return { status: 'UNKNOWN_DATE', daysToExpiry: null, expired: false, alerting: false };

  const window = Math.min(Number(windowDays) || DEFAULT_ALERT_WINDOW_DAYS, ALERT_HORIZON_DAYS);
  if (days < 0) return { status: 'EXPIRED', daysToExpiry: days, expired: true, alerting: true };
  if (days <= window) return { status: 'EXPIRING', daysToExpiry: days, expired: false, alerting: true };
  return { status: 'VALID', daysToExpiry: days, expired: false, alerting: false };
}

/** How loudly to say it. An expired permit is not a warning, it is a finding. */
function severityFor(status) {
  if (status === 'EXPIRED') return 'CRITICAL';
  if (status === 'EXPIRING') return 'WARNING';
  return 'INFO';
}

/** A sentence a shopkeeper would say out loud. Used for the notification body. */
function describe(status, daysToExpiry) {
  if (status === 'EXPIRED') {
    const n = Math.abs(Number(daysToExpiry) || 0);
    return n === 0 ? 'Expires today.' : `Expired ${n} day${n === 1 ? '' : 's'} ago.`;
  }
  if (status === 'EXPIRING') {
    const n = Number(daysToExpiry) || 0;
    return n === 0 ? 'Expires today.' : `Expires in ${n} day${n === 1 ? '' : 's'}.`;
  }
  return null;
}

/**
 * The checklist: what this branch's VERTICAL expects it to hold, against what it
 * actually holds.
 *
 * This is where `profile.complianceFields` stops being documentation. An
 * electronics dealer is offered SONCAP and NCC type approval, a furniture shop
 * forestry permits and CITES, a building-materials yard a quarry permit — and
 * because the profile says so, the screen can tell a branch manager which of them
 * are MISSING rather than showing an empty list to somebody who does not know
 * what is supposed to be there.
 *
 * NOTHING HERE IS ENFORCED. The schema is explicit that an unusual permit must
 * never block a client from trading, so a record whose type the vertical does not
 * list is kept and reported under `extra` — visible, counted, and not an error.
 */
function buildChecklist({ profile, rows, today, windowDays = DEFAULT_ALERT_WINDOW_DAYS, fieldLibrary = {} }) {
  const expectedTypes = Array.isArray(profile && profile.complianceFields) ? profile.complianceFields : [];
  const byType = new Map();
  for (const row of rows || []) {
    const type = String(row.record_type || '').toUpperCase();
    // Newest wins when a branch holds two of a type — a renewal entered before
    // the old one was removed must not be hidden behind it.
    const existing = byType.get(type);
    if (!existing || String(row.updated_at || '') > String(existing.updated_at || '')) byType.set(type, row);
  }

  const expected = expectedTypes.map((type) => {
    const key = String(type).toUpperCase();
    const lib = fieldLibrary[key] || {};
    const record = byType.get(key) || null;
    const state = record
      ? recordStatus(record, { today, windowDays })
      : { status: 'MISSING', daysToExpiry: null, expired: false, alerting: false };
    return {
      type: key,
      label: lib.label || key,
      hint: lib.hint || null,
      expires: lib.expires === true,
      status: state.status,
      daysToExpiry: state.daysToExpiry,
      record: record || null,
    };
  });

  const expectedKeys = new Set(expectedTypes.map((t) => String(t).toUpperCase()));
  const extra = (rows || [])
    .filter((r) => !expectedKeys.has(String(r.record_type || '').toUpperCase()))
    .map((record) => ({
      type: String(record.record_type || '').toUpperCase(),
      status: recordStatus(record, { today, windowDays }).status,
      record,
    }));

  const counts = { expected: expected.length, held: 0, missing: 0, expired: 0, expiring: 0, noExpiry: 0, valid: 0, extra: extra.length };
  for (const e of expected) {
    if (e.status === 'MISSING') { counts.missing += 1; continue; }
    counts.held += 1;
    if (e.status === 'EXPIRED') counts.expired += 1;
    else if (e.status === 'EXPIRING') counts.expiring += 1;
    else if (e.status === 'NO_EXPIRY') counts.noExpiry += 1;
    else counts.valid += 1;
  }
  // A record held but already lapsed still counts as held: the branch did the
  // paperwork once, and "held" is not a claim that it is current.
  counts.alerting = counts.expired + counts.expiring;
  counts.ok = counts.missing === 0 && counts.alerting === 0;
  return { expected, extra, counts };
}

/**
 * The statement that raises a notification for every record the shop is being
 * warned about.
 *
 * IT IS ONE STATEMENT, AND IT IS IDEMPOTENT, because it runs from the daily cron
 * on every deployment and from a button a manager can press: a notification is
 * created only where an UNREAD one for the same record does not already exist.
 * Without that NOT EXISTS, a monthly permit would produce thirty notifications a
 * month, which is how a real alert gets tuned out.
 *
 * It reads `v_compliance_expiry_alerts` — the schema's own 90-day horizon — and
 * narrows from there to the configured window. `user_id` is left NULL, which the
 * notifications table defines as a broadcast to everyone with access; the branch
 * and business columns are what scope it.
 *
 * `now` is not a parameter: `datetime('now')` in SQL is UTC, and every other
 * timestamp in this schema is written the same way.
 */
function notifyStatement({ windowDays = null, useSettings = false } = {}) {
  // The cron cannot take a window as a parameter the way a route can: it runs with
  // no request and no settings object, and it must honour whatever the owner set.
  // So it asks the database for the number instead — one subquery, still one
  // statement, and still the same rule about not duplicating an unread alert.
  const window = useSettings
    ? null
    : Math.max(1, Math.min(Number(windowDays) || DEFAULT_ALERT_WINDOW_DAYS, ALERT_HORIZON_DAYS));
  // The predicate CARRIES NO `AND` OF ITS OWN: it is spliced after a `WHERE`, and
  // a leading AND there produced "WHERE AND r.days_to_expiry <= …" — SQL that the
  // static audit could not see and only the database refused.
  const windowPredicate = useSettings
    ? `r.days_to_expiry <= COALESCE((SELECT compliance_alert_days FROM client_settings WHERE id = 1), ${DEFAULT_ALERT_WINDOW_DAYS})`
    : 'r.days_to_expiry <= ?';
  const sql = `
    INSERT INTO notifications (business_id, branch_id, user_id, type, severity, title, body, reference_type, reference_id)
    SELECT r.business_id,
           r.branch_id,
           NULL,
           'COMPLIANCE_EXPIRY',
           CASE WHEN r.days_to_expiry < 0 THEN 'CRITICAL' ELSE 'WARNING' END,
           CASE WHEN r.days_to_expiry < 0
                THEN r.record_type || ' has expired at ' || r.branch_name
                ELSE r.record_type || ' expires in ' || r.days_to_expiry || ' day(s) at ' || r.branch_name END,
           CASE WHEN r.days_to_expiry < 0
                THEN 'Expired ' || abs(r.days_to_expiry) || ' day(s) ago.'
                ELSE 'Expires ' || r.expiry_date || '.' END,
           'branch_compliance_records',
           r.id
      FROM v_compliance_expiry_alerts r
     WHERE ${windowPredicate}
       AND NOT EXISTS (
             SELECT 1 FROM notifications n
              WHERE n.type = 'COMPLIANCE_EXPIRY'
                AND n.reference_id = r.id
                AND n.is_deleted = 0
                AND n.is_read = 0)`;
  return { sql, params: useSettings ? [] : [window] };
}

module.exports = {
  ALERT_HORIZON_DAYS,
  DEFAULT_ALERT_WINDOW_DAYS,
  MAX_ALERT_WINDOW_DAYS,
  daysBetween,
  recordStatus,
  severityFor,
  describe,
  buildChecklist,
  notifyStatement,
};
