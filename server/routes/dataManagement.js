'use strict';
// =====================================================================
// server/routes/dataManagement.js — WHAT THE SHOP KEEPS, AND WHAT IT MAY LET GO
// =====================================================================
// THE QUESTION THIS ANSWERS. A proprietor asks "how much room do we have, and
// what happens when it runs out?" — and today the answer is nothing, anywhere:
// `data_cleanup_log` sits in the schema with no writer, and nothing in the
// product says how much of the database is full or which records could be let go.
//
// WHAT IS HERE NOW (G1b) is the READ half, deliberately before the destructive
// half:
//
//   GET /api/data-management/status     capacity, the retention windows and what
//                                       each would remove right now, the modes a
//                                       purge will offer with their confirmation
//                                       phrases, and the history of past runs.
//
//   GET /api/data-management/history    the runs themselves, pageable.
//
// WHY THE DESTRUCTIVE HALF IS NOT HERE YET (G1c). `POST /api/data-management/purge`
// deletes a shop's records permanently; getting it wrong is not a bug report, it
// is a client's VAT history. It lands as its own stage with its own audit, one
// test per mode proving that what a mode promises to KEEP is still there
// afterwards — because the promise ("keep accounting", "keep accounting and
// current stock") is the entire feature, and a mode that keeps too little is
// indistinguishable from a mode that works until somebody reconciles a quarter.
//
// WHO MAY LOOK. Reading is MANAGER and above; the purge will be OWNER or the
// platform ADMIN. The reasoning is the same one the books follow: a manager who
// can see the P&L can also see how full the database is, and being unable to
// answer "are we about to run out of room?" is how a proprietor is told too late.
// Changing what is kept is a decision about the business's records, so it belongs
// to the person who is answerable for them.
// =====================================================================

const { resolveBusiness, pagination, listResponse } = require('../lib/respond');
const { HttpError } = require('../lib/http');
const { atLeast } = require('../../domain/roles');
const { estimate } = require('../lib/storage');
const { RETENTION_DAYS, retentionPreview } = require('../lib/retention');

/** The modes a purge will offer, with the phrase that must be typed to mean it. */
const PURGE_MODES = Object.freeze([
  {
    code: 'PERIOD',
    label: 'Delete a selected period',
    phrase: 'DELETE SELECTED PERIOD',
    description: 'Removes trading records dated inside the range you give: sales and their lines and payments, expenses, purchases, ledgers and till sessions. The catalogue, the team and the account stay.',
    needs_dates: true,
    keeps: 'The catalogue, customers, suppliers, the team, the account and any record dated outside the range.',
  },
  {
    code: 'CLEAR_OPERATIONAL_KEEP_ACCOUNTING',
    label: 'Clear trading history; keep the books',
    phrase: 'CLEAR OPERATIONS KEEP ACCOUNTING',
    description: 'Removes sales, purchases, expenses, stock movements and ledgers in full, and keeps the accounting journals and the safe ledger so the books still show what happened.',
    needs_dates: false,
    keeps: 'The journal, the safe ledger, the catalogue, the team and the account.',
  },
  {
    code: 'CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK',
    label: 'Clear trading history; keep the books and the shelf',
    phrase: 'CLEAR OPERATIONS KEEP ACCOUNTING AND STOCK',
    description: 'The same as above, and also keeps what is physically on the shelf right now — the batches with stock in them, their products and their branch prices — so the shop can start a new season without a stocktake.',
    needs_dates: false,
    keeps: 'The journal, the safe ledger, the ledger continuity, the current stock and the account.',
  },
  {
    code: 'ALL_BUSINESS_DATA',
    label: 'Clear all business data',
    phrase: 'CLEAR ALL BUSINESS DATA',
    description: 'Removes every business record: the catalogue, customers, suppliers, trading history and ledgers. The account, the team and the settings stay.',
    needs_dates: false,
    keeps: 'The account, the team, the settings and the branding.',
  },
  {
    code: 'FULL_SETUP_RESET',
    label: 'Full business and team reset',
    phrase: 'RESET BUSINESS AND TEAM',
    description: 'The most complete reset short of deleting the account: every business record AND the team, leaving the account and its settings ready for a fresh setup.',
    needs_dates: false,
    keeps: 'The account and its settings only.',
  },
]);

/**
 * THE WARNING, VERBATIM AND IN THE PRODUCT'S WORDS. PharmaRidge put its
 * equivalent in the API response rather than only in the screen, and that is the
 * right place: a client that calls the endpoint directly — a script, a future
 * mobile app — must receive the warning too, not only a browser that rendered a
 * modal.
 */
const RETENTION_NOTICE = 'Deleting a record is permanent from this application. Export and verify every report or backup you must retain before continuing. Resolve every reported offline queue first; after any cleanup, an older queued replay is quarantined for review instead of being allowed to recreate records. Check your accountant, tax adviser and applicable retention obligations before deleting financial, VAT or WHT records.';

function mount(app, base = '/api') {
  /**
   * CAPACITY, RETENTION AND HISTORY IN ONE READ.
   *
   * One endpoint rather than three because they are asked together: "are we
   * nearly full, what would housekeeping free, and what have we done before?" is
   * one question with three parts, and a screen that fires three requests to
   * answer it can render two of them without the third.
   */
  app.get(`${base}/data-management/status`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!user || !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager, owner or administrator can see the data-management controls.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    // CAPACITY IS A PROPERTY OF THE DATABASE, NOT OF A BUSINESS. All businesses on
    // a deployment share one D1 database, so its size is the same answer whoever
    // asks. `required: false` matters on a FRESH deployment: sample and production
    // are deliberately handed over with an administrator and no business at all,
    // and a 400 BUSINESS_REQUIRED there would mean the one person who could act on
    // a filling database — the platform administrator — cannot read the figure
    // that tells them it is filling.
    const business = await resolveBusiness(db, ctx, null, { required: false });

    // Capacity and the retention rules. THE RUNS THEMSELVES ARE NOT EMBEDDED
    // HERE: they have their own endpoint below, because an embedded copy would be
    // a second source of truth for the same rows AND would leave that endpoint
    // with no caller — which this repository's own capability audit reports as
    // "an endpoint the frontend never asks for". One screen, one request, one
    // shape.
    const [storage, retention] = await Promise.all([
      estimate(db),
      retentionPreview(db),
    ]);

    ctx.json({
      ok: true,
      business: business ? { id: business.id, name: business.name } : null,
      storage,
      retention: {
        windows: RETENTION_DAYS,
        rules: retention,
        note: 'These run automatically on the daily schedule. Nothing here touches sales, payments, the ledger, stock movements or the audit log — see server/lib/retention.js for what is deliberately never removed.',
      },
      modes: PURGE_MODES.map((m) => ({ ...m, confirmation_phrase: m.phrase })),
      retention_notice: RETENTION_NOTICE,
    });
  });

  /** THE RUNS THEMSELVES, pageable. The Plan screen's "Past cleanups" card reads this. */
  app.get(`${base}/data-management/history`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!user || !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager, owner or administrator can see the data-management history.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    // Optional for the same reason as the status read: a cleanup run is recorded
    // against the deployment, and a fresh deployment has no business to name.
    await resolveBusiness(db, ctx, null, { required: false });
    const { limit, offset } = pagination(ctx);
    const rows = await db.all(`SELECT id, mode, initiated_by, initiated_by_username, start_date, end_date, deleted_summary_json, created_at
                                 FROM data_cleanup_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [limit, offset]);
    const total = await db.first('SELECT COUNT(*) AS c FROM data_cleanup_log');
    ctx.json(listResponse((rows || []).map((row) => {
      let summary = null;
      try { summary = row.deleted_summary_json ? JSON.parse(row.deleted_summary_json) : null; } catch (e) { summary = null; }
      return {
        id: row.id, mode: row.mode, by: row.initiated_by_username, by_id: row.initiated_by,
        start_date: row.start_date, end_date: row.end_date, created_at: row.created_at, summary,
      };
    }), { limit, offset }, Number((total && total.c) || 0)));
  });
}

module.exports = { mount, PURGE_MODES, RETENTION_NOTICE };
