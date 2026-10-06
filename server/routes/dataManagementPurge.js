'use strict';
// =====================================================================
// server/routes/dataManagementPurge.js — THE DOOR IN FRONT OF THE CLEANUP
// =====================================================================
// `server/lib/purge.js` knows HOW to delete; this file decides WHO MAY, under
// WHAT PROOF, and records that it happened. Kept in its own file because the
// difference between "the deletion plan is correct" and "the deletion is
// authorised, confirmed and logged" is the difference between a library and a
// destructive endpoint, and mixing them makes both harder to read.
//
// FOUR ANSWERS MUST ALL BE YES BEFORE A SINGLE ROW GOES:
//
//   1. the seat is an OWNER (or the platform administrator) — a manager runs the
//      shop, the proprietor owns what happens to its records;
//   2. the operative has TYPED THE EXACT PHRASE for the mode — not clicked a
//      checkbox, not scrolled to the bottom of a modal. The phrase is the one
//      thing a tired person cannot produce by reflex;
//   3. they have declared the export done, and read the retention notice;
//   4. the scope is not empty — a cleanup that quietly applies to nothing is
//      worse than one that refuses, because the screen would say it succeeded.
//
// The endpoint is deliberately HARD TO CALL BY ACCIDENT and deliberately
// POSSIBLE TO CALL HONESTLY: every parameter is explicit, the same request can
// be run as a dry run first, and the answer says exactly what was removed.
// =====================================================================

const { resolveBusiness } = require('../lib/respond');
const { HttpError } = require('../lib/http');
const { atLeast } = require('../../domain/roles');
const { recordFromCtx } = require('../lib/audit');
const { runPurge, countStep, planFor, describeSchema, NEVER_REMOVED } = require('../lib/purge');

/** Vocabulary for the confirmation, so the message can be specific and short. */
const CONFIRMATION_FIELDS = ['export_confirmed', 'retention_acknowledged'];

function requiredBoolean(body, field) {
  const value = body && body[field];
  if (value !== true) {
    throw new HttpError(`This cleanup requires ${field === 'export_confirmed' ? 'a declared export of the records you must keep' : 'an acknowledgement of the retention notice'} (${field}: true).`, { status: 428, code: 'CONFIRMATION_REQUIRED', fields: { [field]: 'Tick this before continuing.' } });
  }
}

/** A date the way this schema stores them: 'YYYY-MM-DD' or the same with a time. */
function normaliseDate(value, field) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(text)) {
    throw new HttpError(`${field} must look like 2025-01-31 (or 2025-01-31 14:30). The cleanup compares it against stored dates as text, so the shape matters.`, { status: 400, code: 'INVALID_DATE' });
  }
  // A bare day means the WHOLE day. `end_date = '2025-01-31'` compared as
  // `date < end_date` would exclude the last day's records, which is the exact
  // off-by-one that turns "delete January" into "delete January and keep one day
  // of it". The upper bound is exclusive everywhere in the purge, so it is
  // widened here, once, and the rule is written down rather than rediscovered.
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { date: text, wholeDay: true } : { date: text, wholeDay: false };
}

/**
 * Mounted from `dataManagement.js` rather than from the route index, so that the
 * MODE VOCABULARY HAS ONE HOME: the list of modes, their phrases and the retention
 * notice are declared once, served by `/status`, and enforced here. A copy of the
 * phrases in this file would be a second place to update and would eventually
 * disagree with the one the screen showed the operative.
 */
function mount(app, base = '/api', { modes = [], notice = '' } = {}) {
  const MODE_BY_CODE = new Map(modes.map((m) => [m.code, m]));
  /**
   * WHAT WOULD BE DELETED — counted, and NOT deleted.
   *
   * The dry run exists because the alternative is a shop agreeing to a number
   * it has only seen in prose. It applies the SAME plan and the SAME scope as
   * the real thing, and it writes nothing: no `data_cleanup_log`, no audit
   * entry, no rows. A dry run that changed the database would be a cleanup
   * with extra steps.
   */
  app.post(`${base}/data-management/purge/preview`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!user || !atLeast(user.role, 'OWNER')) {
      throw new HttpError('Only the owner or the platform administrator can preview or run a data cleanup.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const body = await ctx.req.json().catch(() => ({}));
    const mode = String(body.mode || '').toUpperCase();
    if (!MODE_BY_CODE.has(mode)) {
      throw new HttpError(`Unknown cleanup mode "${body.mode}".`, { status: 400, code: 'UNKNOWN_MODE' });
    }
    const business = await resolveBusiness(db, ctx, null, { required: true });
    const start = normaliseDate(body.start_date, 'start_date');
    const end = normaliseDate(body.end_date, 'end_date');

    // THE SAME PLAN THE REAL RUN USES, including the schema-aware scoping — a
    // preview that counted a different set of rows from the run would be worse
    // than no preview.
    const schema = await describeSchema(db);
    const plan = planFor(mode, { businessIds: [business.id], actorId: user.id, schema });
    const counts = {};
    for (const step of plan.steps) {
      const n = await countStep(db, step, plan, {
        startDate: start ? start.date : null,
        endDate: end ? (end.wholeDay ? `${end.date} 23:59:59.999` : end.date) : null,
      });
      if (n) counts[step.t] = n;
    }
    const total = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0);
    ctx.json({
      ok: true,
      dry_run: true,
      mode,
      label: MODE_BY_CODE.get(mode).label,
      phrase: MODE_BY_CODE.get(mode).phrase,
      business: { id: business.id, name: business.name },
      window: start || end ? { start_date: start && start.date, end_date: end && end.date } : null,
      would_remove: counts,
      total,
      kept_tables: NEVER_REMOVED,
      notice,
    });
  });

  /**
   * THE CLEANUP ITSELF.
   *
   * Ordered so that nothing irreversible happens before everything checkable has
   * been checked: the guard, then the phrase, then the declarations, then the
   * scope — and only then the deletion. The log is written AFTER, because a log
   * row for a cleanup that failed to start is a lie in the one table whose job
   * is to be believed.
   */
  app.post(`${base}/data-management/purge`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!user || !atLeast(user.role, 'OWNER')) {
      throw new HttpError('Only the owner or the platform administrator can run a data cleanup.', { status: 403, code: 'ROLE_REQUIRED' });
    }

    const body = await ctx.req.json().catch(() => ({}));
    const mode = String(body.mode || '').toUpperCase();
    const spec = MODE_BY_CODE.get(mode);
    if (!spec) throw new HttpError(`Unknown cleanup mode "${body.mode}".`, { status: 400, code: 'UNKNOWN_MODE' });

    // THE PHRASE, EXACTLY. Trimmed of surrounding whitespace only — a phone
    // keyboard adds a trailing space and refusing that teaches nothing.
    const typed = String(body.phrase == null ? '' : body.phrase).trim();
    if (typed !== spec.phrase) {
      throw new HttpError(`The confirmation phrase for this cleanup is "${spec.phrase}". Type it exactly to continue.`, { status: 428, code: 'PHRASE_REQUIRED', fields: { phrase: 'Type the phrase exactly as shown.', expected_phrase: spec.phrase } });
    }
    for (const field of CONFIRMATION_FIELDS) requiredBoolean(body, field);

    // AN EMPTY SCOPE IS REFUSED, NOT REPORTED. `runPurge` would return a failure
    // entry and delete nothing, which is safe and useless: the operative would
    // read "failed" with no idea why. This says why.
    const business = await resolveBusiness(db, ctx, null, { required: true });

    const start = normaliseDate(body.start_date, 'start_date');
    const end = normaliseDate(body.end_date, 'end_date');
    if (spec.needs_dates) {
      if (!start || !end) {
        throw new HttpError('This cleanup removes a period, so it needs both start_date and end_date.', { status: 400, code: 'DATES_REQUIRED' });
      }
      if (start.date > end.date) {
        throw new HttpError('The period ends before it starts.', { status: 400, code: 'INVALID_PERIOD' });
      }
    }
    // Dates sent to a mode that does not use them are IGNORED, not refused: the
    // operative may have switched mode in the modal and left the range filled in,
    // and refusing that would teach them nothing about the cleanup.

    const result = await runPurge(db, mode, {
      businessIds: [business.id],
      actorId: user.id,
      startDate: start ? start.date : null,
      endDate: end ? (end.wholeDay ? `${end.date} 23:59:59.999` : end.date) : null,
      dryRun: Boolean(body.dry_run),
    });

    if (body.dry_run) {
      ctx.json({ ok: true, dry_run: true, mode, label: spec.label, business: { id: business.id, name: business.name }, ...result });
      return;
    }

    // WHAT SURVIVED, IN THE ANSWER AND IN THE LOG. "Removed 412 rows" is a
    // receipt; "and 7 batches holding 31 units are still on the shelf" is the
    // sentence that tells the proprietor the shop can still trade tomorrow.
    const continuity = await continuityFor(db, business.id);

    const summary = {
      removed: result.removed,
      total: result.total,
      skipped: result.skipped,
      failed: result.failed,
      continuity,
      by_table: Object.fromEntries(Object.entries(result.removed || {}).sort((a, b) => b[1] - a[1])),
    };
    await db.run(
      `INSERT INTO data_cleanup_log (mode, initiated_by, initiated_by_username, start_date, end_date, deleted_summary_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [mode, user.id, user.username || 'unknown', start ? start.date : null, end ? end.date : null, JSON.stringify(summary)],
    );
    // THE AUDIT ENTRY CARRIES THE PHRASE AND THE DECLARATIONS, not just the fact:
    // six months later the question is never "did somebody run a cleanup" — the
    // log says that — it is "what exactly did they accept when they did".
    await recordFromCtx(ctx, {
      action: 'DATA_CLEANUP_RUN',
      entityType: 'business',
      entityId: business.id,
      businessId: business.id,
      after: {
        mode,
        phrase_confirmed: spec.phrase,
        export_confirmed: true,
        retention_acknowledged: true,
        total_removed: result.total,
        failed: (result.failed || []).map((f) => f.table),
        continuity,
      },
    });

    ctx.json({
      ok: (result.failed || []).length === 0,
      dry_run: false,
      mode,
      label: spec.label,
      business: { id: business.id, name: business.name },
      continuity,
      ...result,
    });
  });
}

/**
 * THE CONTINUITY FIGURE — what is still there to trade with.
 *
 * A deletion screen must answer the question the operative is actually asking,
 * which is never "how many rows went" but "is the shop still a shop". Counted
 * AFTER the deletion, from the database as it now stands, so it cannot be a
 * comfortable prediction.
 */
async function continuityFor(db, businessId) {
  const batches = await db.first('SELECT COUNT(*) AS c FROM stock_batches WHERE business_id = ? AND quantity > 0', [businessId]);
  const units = await db.first('SELECT COALESCE(SUM(quantity), 0) AS c FROM stock_batches WHERE business_id = ? AND quantity > 0', [businessId]);
  const products = await db.first('SELECT COUNT(DISTINCT product_id) AS c FROM stock_batches WHERE business_id = ? AND quantity > 0', [businessId]);
  const team = await db.first('SELECT COUNT(*) AS c FROM users WHERE is_deleted = 0');
  return {
    stock_batches: Number((batches && batches.c) || 0),
    stock_base_units: Number((units && units.c) || 0),
    stocked_products: Number((products && products.c) || 0),
    team_seats_remaining: Number((team && team.c) || 0),
  };
}

module.exports = { mount, CONFIRMATION_FIELDS, normaliseDate };
