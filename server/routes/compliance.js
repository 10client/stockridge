'use strict';
// =====================================================================
// server/routes/compliance.js — THE PERMITS A BRANCH MUST HOLD
// =====================================================================
// `branch_compliance_records` has existed since the first migration and nothing
// has ever written a row. The view built on top of it, `v_compliance_expiry_alerts`,
// has existed just as long and nothing has ever read it. So a shop could not
// record that its fire certificate expires in March, and the application could not
// warn anybody that it was about to — a capability that existed on paper and in
// no other form.
//
// WHAT THIS ADDS
//
//   /compliance/records    the registry: what this branch holds, with dates
//   /compliance/alerts     what is expiring, straight out of the schema's view
//   /compliance/checklist  what this branch's VERTICAL expects it to hold
//                          (`profile.complianceFields`, until now documentation
//                          that no code read)
//   /compliance/notify     raise the alerts as notifications, for the daily cron
//                          and for the button on the screen
//
// WHY COMPLIANCE IS PER BRANCH, NOT PER BUSINESS. A trading permit names a
// premises; a second shop in another LGA needs its own, from a different office,
// with a different number. The schema is right and the screen follows it.
//
// WHO MAY WRITE. A manager, for a branch they can already reach — this is
// paperwork about their own shop, and the person who has to produce the fire
// certificate when an inspector calls is exactly the person who knows when it
// lapses. Reading is open to any signed-in user within their scope: "is our
// registration still valid" is not privileged information.
//
// NOTHING HERE BLOCKS TRADING. domain/verticals.js is explicit that an unusual
// permit must never stop a client going live, so an unrecognised record_type is
// accepted and reported as unrecognised, and a permit the vertical expects but
// the branch does not hold is reported MISSING rather than refused. The only
// thing this module refuses is bookkeeping that has no sensible reading: two
// live records of the same type on the same branch.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const {
  resolveBranch, resolveBusiness, inBranchScope, scopeFilter, pushScope,
  pagination, listResponse, requireField,
} = require('../lib/respond');
const { newId } = require('../../domain/crypto');
const { watToday, addDays } = require('../../domain/time');
const { COMPLIANCE_FIELDS, resolveProfile, DEFAULT_PROFILE_CODE } = require('../../domain/verticals');
const {
  ALERT_HORIZON_DAYS, DEFAULT_ALERT_WINDOW_DAYS, MAX_ALERT_WINDOW_DAYS,
  recordStatus, severityFor, describe: describeStatus, buildChecklist, notifyStatement,
} = require('../../domain/compliance');

/** ISO date, or null. An empty string is not a date and becomes NULL. */
function isoDateOrNull(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const v = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new HttpError(`${field} must be a date in YYYY-MM-DD form (you sent "${value}").`, { status: 400, code: 'INVALID_DATE', fields: { [field]: 'Use YYYY-MM-DD.' } });
  }
  return v;
}

/**
 * `record_type` is free text on purpose — see the header. Normalised, never refused.
 *
 * Takes the BODY, not the value: `requireField(body, field, label)` reads a field
 * out of an object, and passing it a value makes it look for `value.record_type`
 * and answer "Record type is required" about a request that carried one. (It did.)
 */
function normaliseType(body) {
  const raw = String(requireField(body, 'record_type', 'Record type')).trim().toUpperCase();
  if (raw.length > 40) {
    throw new HttpError('That record type is too long — 40 characters at most.', { status: 400, code: 'INVALID_FIELD', fields: { record_type: 'Too long.' } });
  }
  return raw.replace(/\s+/g, '_');
}

/** The window this deployment wants warnings for, clamped to what the view can see. */
function windowDaysFor(settings) {
  const raw = Number((settings && settings.compliance_alert_days) || DEFAULT_ALERT_WINDOW_DAYS);
  const wanted = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ALERT_WINDOW_DAYS;
  return { wanted, effective: Math.min(wanted, ALERT_HORIZON_DAYS), clamped: wanted > ALERT_HORIZON_DAYS };
}

function mount(app, base = '/api') {
  // ===================================================================
  // THE REGISTRY
  // ===================================================================
  app.get(`${base}/compliance/records`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const settings = ctx.get('settings');
    const { limit, offset } = pagination(ctx);
    const { effective } = windowDaysFor(settings);
    const today = watToday();

    const where = ['r.is_deleted = 0'];
    const params = [];
    const branch = await resolveBranch(db, ctx, { required: false });
    if (branch) { where.push('r.branch_id = ?'); params.push(String(branch.id)); }
    const business = await resolveBusiness(db, ctx, branch);
    if (business) { where.push('b.business_id = ?'); params.push(String(business.id)); }
    // THROUGH THE JOINED BRANCH, because `branch_compliance_records` has no
    // `business_id` of its own — a record reaches its business through the branch
    // it belongs to. Asking the filter for `r.business_id` threw
    // "no such column: r.business_id" for every caller whose scope is narrower
    // than the whole deployment (a branch manager, a cashier), while an owner saw
    // a working screen: the scope clauses are only emitted when the caller is
    // restricted. The fully-qualified names below are what the query needs.
    pushScope(where, params, scope, { branchColumn: 'r.branch_id', businessColumn: 'b.business_id', alias: '' });

    const type = ctx.req.queryParam('record_type');
    if (type) { where.push('r.record_type = ?'); params.push(String(type).toUpperCase()); }

    // Status is filtered in SQL rather than after the fetch, because a filter
    // applied after paging would return short pages and a wrong total.
    const status = String(ctx.req.queryParam('status') || '').toUpperCase();
    const soon = addDays(today, effective);
    if (status === 'EXPIRED') { where.push('r.expiry_date IS NOT NULL AND r.expiry_date < ?'); params.push(today); }
    else if (status === 'EXPIRING') { where.push('r.expiry_date IS NOT NULL AND r.expiry_date >= ? AND r.expiry_date <= ?'); params.push(today, soon); }
    else if (status === 'VALID') { where.push('r.expiry_date IS NOT NULL AND r.expiry_date > ?'); params.push(soon); }
    else if (status === 'NO_EXPIRY') { where.push('r.expiry_date IS NULL'); }
    else if (status === 'ALERTING') { where.push('r.expiry_date IS NOT NULL AND r.expiry_date <= ?'); params.push(soon); }
    else if (status === 'MISSING') { where.push('1 = 0'); }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = await db.scalar(`SELECT COUNT(*) FROM branch_compliance_records r JOIN branches b ON b.id = r.branch_id ${whereSql}`, params);
    const rows = await db.all(`
      SELECT r.*, b.name AS branch_name, b.business_id, bs.name AS business_name
        FROM branch_compliance_records r
        JOIN branches b ON b.id = r.branch_id
   LEFT JOIN businesses bs ON bs.id = b.business_id
        ${whereSql}
    ORDER BY r.expiry_date IS NULL, r.expiry_date, r.record_type
       LIMIT ? OFFSET ?`, [...params, limit, offset]);

    const data = rows.map((r) => {
      const state = recordStatus(r, { today, windowDays: effective });
      return {
        ...r,
        status: state.status,
        daysToExpiry: state.daysToExpiry,
        severity: severityFor(state.status),
        note: describeStatus(state.status, state.daysToExpiry),
        // Whether the vertical this branch belongs to expected this kind of record.
        // Reported so the screen can say so; never a reason to refuse it.
        knownType: Boolean(COMPLIANCE_FIELDS[String(r.record_type).toUpperCase()]),
      };
    });
    ctx.json(listResponse(data, { limit, offset }, Number(total) || 0));
  });

  // ===================================================================
  // THE ALERTS — read straight from the schema's own view
  // ===================================================================
  /**
   * What is expiring, soonest first.
   *
   * This reads `v_compliance_expiry_alerts` rather than repeating its SQL, so the
   * horizon lives in exactly one place (the view) and the application's copy of
   * that number is asserted against it by a test. The configured window narrows
   * the view's 90 days; it cannot widen them, and the response says so plainly
   * instead of quietly returning less than the setting promises.
   */
  app.get(`${base}/compliance/alerts`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const settings = ctx.get('settings');
    const { wanted, effective, clamped } = windowDaysFor(settings);
    const today = watToday();

    const where = ['r.days_to_expiry <= ?'];
    const params = [effective];
    pushScope(where, params, scope, { branchColumn: 'branch_id', businessColumn: 'business_id', alias: 'r' });
    const branchId = ctx.req.queryParam('branch_id');
    if (branchId) { where.push('r.branch_id = ?'); params.push(String(branchId)); }
    const type = ctx.req.queryParam('record_type');
    if (type) { where.push('r.record_type = ?'); params.push(String(type).toUpperCase()); }

    const rows = await db.all(`
      SELECT r.* FROM v_compliance_expiry_alerts r
       WHERE ${where.join(' AND ')}
    ORDER BY r.days_to_expiry`, params);

    const data = rows.map((r) => {
      // The day count is recomputed from the BUSINESS day rather than trusted from
      // the view, which measures against UTC `now`. The two can differ by one day
      // for a shop in Lagos after 11pm, and the number on the screen has to agree
      // with the date beside it.
      const state = recordStatus(r, { today, windowDays: effective });
      return {
        ...r,
        status: state.status,
        daysToExpiry: state.daysToExpiry,
        severity: severityFor(state.status),
        note: describeStatus(state.status, state.daysToExpiry),
        title: state.status === 'EXPIRED'
          ? `${r.record_type} has expired at ${r.branch_name}`
          : `${r.record_type} expires in ${state.daysToExpiry} day(s)`,
      };
    });

    ctx.json({
      ok: true,
      data,
      windowDays: effective,
      askedDays: wanted,
      horizonDays: ALERT_HORIZON_DAYS,
      // A promise that is not kept is worse than a smaller one that is. If the
      // setting asks for more than the view can see, the response says how far it
      // can actually see.
      note: clamped
        ? `You asked for ${wanted} days' warning; the expiry view looks ${ALERT_HORIZON_DAYS} days ahead, so that is what is shown.`
        : null,
      counts: {
        total: data.length,
        expired: data.filter((d) => d.status === 'EXPIRED').length,
        expiring: data.filter((d) => d.status === 'EXPIRING').length,
      },
    });
  });

  // ===================================================================
  // THE CHECKLIST — what this branch's vertical expects it to hold
  // ===================================================================
  /**
   * One row per branch the caller can reach, each carrying the vertical's own
   * compliance fields matched against the records actually held.
   *
   * This is the endpoint that makes `profile.complianceFields` mean something: a
   * building-materials yard is told it is missing a quarry permit; a furniture
   * shop is told about forestry and CITES; a general retailer is told about the
   * five things every Nigerian business holds and nothing more. A record of a
   * type the vertical does not list is returned under `extra` — kept, counted,
   * and never an error.
   */
  app.get(`${base}/compliance/checklist`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const settings = ctx.get('settings');
    const { wanted, effective } = windowDaysFor(settings);
    const today = watToday();

    const where = ['b.is_deleted = 0'];
    const params = [];
    const branch = await resolveBranch(db, ctx, { required: false });
    if (branch) { where.push('b.id = ?'); params.push(String(branch.id)); }
    const business = await resolveBusiness(db, ctx, branch);
    if (business) { where.push('b.business_id = ?'); params.push(String(business.id)); }
    pushScope(where, params, scope, { branchColumn: 'b.id', businessColumn: 'b.business_id' });

    const branches = await db.all(`
      SELECT b.id, b.name, b.business_id, b.is_active, bs.name AS business_name, bs.profile_code
        FROM branches b JOIN businesses bs ON bs.id = b.business_id
       WHERE ${where.join(' AND ')}
    ORDER BY bs.name, b.name`, params);

    const byBranch = await db.all(`
      SELECT r.* FROM branch_compliance_records r
       WHERE r.is_deleted = 0
    `);

    const rows = [];
    const totals = { branches: 0, expected: 0, missing: 0, expired: 0, expiring: 0, ok: 0 };
    for (const b of branches) {
      // `resolveProfile` reads a STORED code and is the right call here for the
      // same reason it exists: a business provisioned before a profile changed
      // must still be described, rather than throwing on a code that has moved.
      const profile = resolveProfile(b.profile_code) || resolveProfile(DEFAULT_PROFILE_CODE);
      const held = byBranch.filter((r) => String(r.branch_id) === String(b.id));
      const checklist = buildChecklist({
        profile: profile || {},
        rows: held,
        today,
        windowDays: effective,
        fieldLibrary: COMPLIANCE_FIELDS,
      });
      rows.push({
        branch_id: b.id,
        branch_name: b.name,
        business_id: b.business_id,
        business_name: b.business_name,
        profile_code: b.profile_code,
        is_active: b.is_active,
        expected: checklist.expected,
        extra: checklist.extra,
        counts: checklist.counts,
      });
      totals.branches += 1;
      totals.expected += checklist.counts.expected;
      totals.missing += checklist.counts.missing;
      totals.expired += checklist.counts.expired;
      totals.expiring += checklist.counts.expiring;
      if (checklist.counts.ok) totals.ok += 1;
    }

    ctx.json({
      ok: true,
      data: rows,
      windowDays: effective,
      askedDays: wanted,
      horizonDays: ALERT_HORIZON_DAYS,
      library: COMPLIANCE_FIELDS,
      totals,
    });
  });

  // ===================================================================
  // WRITING A RECORD
  // ===================================================================
  app.post(`${base}/compliance/records`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');

    // THE BODY IS READ FIRST, and that order is load-bearing. `resolveBranch`
    // looks for a branch in the query string and then in the BODY; reading the
    // body afterwards means the parameter it needs is not there yet, so it falls
    // back to the caller's own branch — and a manager who posted a record for
    // another branch had it silently written against their own, with a success
    // message naming the wrong shop. The body is parsed first so the branch the
    // request NAMES is the branch that is checked, and refused if it is out of
    // reach.
    const body = await ctx.req.json();

    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can record a licence for a branch.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const branch = await resolveBranch(db, ctx, { required: true });
    if (!inBranchScope(scope, branch)) {
      throw new HttpError('That branch is outside what you can reach.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }
    const business = await resolveBusiness(db, ctx, branch);

    const recordType = normaliseType(body);
    const issuedDate = isoDateOrNull(body.issued_date, 'issue date');
    const expiryDate = isoDateOrNull(body.expiry_date, 'expiry date');
    if (issuedDate && expiryDate && expiryDate < issuedDate) {
      throw new HttpError(`The expiry date (${expiryDate}) is before the issue date (${issuedDate}).`, { status: 400, code: 'INVALID_DATE_RANGE', fields: { expiry_date: 'Before the issue date.' } });
    }

    // ONE LIVE RECORD PER TYPE PER BRANCH.
    //
    // Not a UNIQUE index: the schema deliberately has none, because a branch may
    // legitimately hold a lapsed certificate and its replacement at the same time
    // while somebody is reconciling them. What cannot be read sensibly is TWO
    // live records of the same type — the screen would show one of them, the
    // alert list would warn twice, and the notification would say the same thing
    // in two rows. So the refusal names the existing record and how to proceed.
    const clash = await db.first(`
      SELECT id, record_number, expiry_date FROM branch_compliance_records
       WHERE branch_id = ? AND record_type = ? AND is_deleted = 0
    ORDER BY updated_at DESC LIMIT 1`, [String(branch.id), recordType]);
    if (clash) {
      throw new HttpError(
        `${branch.name} already has a live ${recordType} record${clash.record_number ? ` (${clash.record_number})` : ''}. Edit that one, or remove it first if this replaces it.`,
        { status: 409, code: 'DUPLICATE_RECORD_TYPE', fields: { record_type: 'Already recorded for this branch.' } },
      );
    }

    const id = newId();
    await db.run(`
      INSERT INTO branch_compliance_records
        (id, branch_id, record_type, record_number, issued_by, issued_date, expiry_date, document_url, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, String(branch.id), recordType,
      body.record_number ? String(body.record_number).trim() : null,
      body.issued_by ? String(body.issued_by).trim() : null,
      issuedDate, expiryDate,
      body.document_url ? String(body.document_url).trim() : null,
      body.notes ? String(body.notes).trim() : null,
      String(user.id)]);

    await recordFromCtx(ctx, {
      action: 'COMPLIANCE_RECORD_CREATED', entityType: 'BRANCH_COMPLIANCE_RECORD', entityId: id,
      branchId: branch.id, businessId: business ? business.id : branch.business_id,
      after: { recordType, recordNumber: body.record_number || null, issuedDate, expiryDate },
    });

    const known = COMPLIANCE_FIELDS[recordType];
    const state = recordStatus({ expiry_date: expiryDate }, { today: watToday(), windowDays: windowDaysFor(ctx.get('settings')).effective });
    ctx.json({
      ok: true,
      id,
      status: state.status,
      note: describeStatus(state.status, state.daysToExpiry),
      message: expiryDate
        ? `${recordType} recorded for ${branch.name}. ${describeStatus(state.status, state.daysToExpiry) || `Expires ${expiryDate}.`}`
        : `${recordType} recorded for ${branch.name}. A record with no expiry date is never an alert.`,
      // Said out loud, once, and not refused: the schema's own comment promises a
      // client with an unusual permit is never blocked.
      unrecognisedType: known ? null : `This vertical does not list ${recordType}; it is recorded and will be tracked like any other.`,
    }, 201);
  });

  app.put(`${base}/compliance/records/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();

    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can change a licence record.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const record = await db.first('SELECT * FROM branch_compliance_records WHERE id = ? AND is_deleted = 0', [id]);
    if (!record) throw new HttpError('That licence record does not exist.', { status: 404, code: 'RECORD_NOT_FOUND' });
    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [record.branch_id]);
    if (!inBranchScope(scope, branch)) {
      throw new HttpError('That record belongs to a branch outside what you can reach.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }

    const recordType = body.record_type === undefined ? record.record_type : normaliseType(body);
    const issuedDate = body.issued_date === undefined ? record.issued_date : isoDateOrNull(body.issued_date, 'issue date');
    const expiryDate = body.expiry_date === undefined ? record.expiry_date : isoDateOrNull(body.expiry_date, 'expiry date');
    if (issuedDate && expiryDate && expiryDate < issuedDate) {
      throw new HttpError(`The expiry date (${expiryDate}) is before the issue date (${issuedDate}).`, { status: 400, code: 'INVALID_DATE_RANGE', fields: { expiry_date: 'Before the issue date.' } });
    }
    if (recordType !== record.record_type) {
      const clash = await db.first(
        'SELECT id, record_number FROM branch_compliance_records WHERE branch_id = ? AND record_type = ? AND is_deleted = 0 AND id <> ? ORDER BY updated_at DESC LIMIT 1',
        [String(record.branch_id), recordType, id],
      );
      if (clash) {
        throw new HttpError(`This branch already has a live ${recordType} record${clash.record_number ? ` (${clash.record_number})` : ''}.`, { status: 409, code: 'DUPLICATE_RECORD_TYPE' });
      }
    }

    // One rule for a text column on the way in: absent means "leave it alone",
    // present-and-empty means "clear it", and anything else is trimmed. (The
    // indirection this replaced passed a function through a default parameter,
    // which `npm run names:audit` quite reasonably reported as a call to a name it
    // could not find defined — a simpler shape is also the one that reads right.)
    const textOrNull = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
    const pick = (field, current) => (body[field] === undefined ? current : textOrNull(body[field]));

    await db.run(`
      UPDATE branch_compliance_records
         SET record_type = ?, record_number = ?, issued_by = ?, issued_date = ?, expiry_date = ?,
             document_url = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ?`,
    [recordType,
      pick('record_number', record.record_number),
      pick('issued_by', record.issued_by),
      issuedDate, expiryDate,
      pick('document_url', record.document_url),
      pick('notes', record.notes),
      id]);

    await recordFromCtx(ctx, {
      action: 'COMPLIANCE_RECORD_UPDATED', entityType: 'BRANCH_COMPLIANCE_RECORD', entityId: id,
      branchId: record.branch_id, businessId: branch ? branch.business_id : null,
      before: { recordType: record.record_type, expiryDate: record.expiry_date },
      after: { recordType, expiryDate },
    });

    const state = recordStatus({ expiry_date: expiryDate }, { today: watToday(), windowDays: windowDaysFor(ctx.get('settings')).effective });
    ctx.json({
      ok: true, id, status: state.status,
      note: describeStatus(state.status, state.daysToExpiry),
      message: `${recordType} updated. ${describeStatus(state.status, state.daysToExpiry) || 'No expiry date, so it is never an alert.'}`,
    });
  });

  app.delete(`${base}/compliance/records/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');
    const id = String(ctx.req.param('id'));

    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can remove a licence record.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const record = await db.first('SELECT * FROM branch_compliance_records WHERE id = ? AND is_deleted = 0', [id]);
    if (!record) throw new HttpError('That licence record does not exist, or has already been removed.', { status: 404, code: 'RECORD_NOT_FOUND' });
    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [record.branch_id]);
    if (!inBranchScope(scope, branch)) {
      throw new HttpError('That record belongs to a branch outside what you can reach.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }

    // Soft delete, like every other mutable row in this schema: the certificate
    // that was recorded and then removed is a fact about the branch's paperwork,
    // and an inspector asking "when did you take this off your register" deserves
    // an answer.
    await db.run("UPDATE branch_compliance_records SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?", [id]);

    await recordFromCtx(ctx, {
      action: 'COMPLIANCE_RECORD_REMOVED', entityType: 'BRANCH_COMPLIANCE_RECORD', entityId: id,
      branchId: record.branch_id, businessId: branch ? branch.business_id : null,
      before: { recordType: record.record_type, recordNumber: record.record_number, expiryDate: record.expiry_date },
      after: null,
    });
    ctx.json({ ok: true, message: `${record.record_type} removed from ${branch ? branch.name : 'the branch'}'s register.` });
  });

  // ===================================================================
  // RAISING THE ALERTS
  // ===================================================================
  /**
   * Turn what is expiring into notifications.
   *
   * Called by the button on the Compliance screen and by the daily cron
   * (`worker/src/housekeeping.js` runs the same statement), so the alert reaches a
   * manager who never opened the screen. Idempotent: an alert already sitting
   * unread for the same record is not duplicated, because a monthly permit that
   * posts thirty notifications a month is a monthly permit nobody reads about.
   */
  app.post(`${base}/compliance/notify`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can raise expiry alerts.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const { wanted, effective } = windowDaysFor(ctx.get('settings'));
    const { sql, params } = notifyStatement({ windowDays: effective });
    const res = await db.run(sql, params);
    const created = Number((res && res.changes) || 0);

    if (created > 0) {
      await recordFromCtx(ctx, {
        action: 'COMPLIANCE_ALERTS_RAISED', entityType: 'NOTIFICATION', entityId: null,
        businessId: user.business_id || null,
        after: { created, windowDays: effective, askedDays: wanted },
      });
    }
    const outstanding = await db.scalar(
      "SELECT COUNT(*) FROM notifications WHERE type = 'COMPLIANCE_EXPIRY' AND is_deleted = 0 AND is_read = 0",
    );
    ctx.json({
      ok: true,
      created,
      outstanding: Number(outstanding) || 0,
      windowDays: effective,
      message: created
        ? `${created} new expiry alert(s) raised. ${Number(outstanding) || 0} unread in total.`
        : `No new alerts. ${Number(outstanding) || 0} expiry alert(s) are already unread — nothing is raised twice.`,
    });
  });
}

module.exports = {
  mount,
  // Exported for the settings screen's own validation and for tests that must not
  // re-derive a number that policy already owns.
  ALERT_HORIZON_DAYS, MAX_ALERT_WINDOW_DAYS,
};
