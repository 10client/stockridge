'use strict';
// =====================================================================
// server/routes/till.js — THE DRAWER AND THE SAFE
// =====================================================================
// A till session is the unit of accountability for cash at a branch. It opens
// with a float, accumulates every sale rung up while it is open, and closes
// with a physical count. THE VARIANCE IS THE POINT OF THE WHOLE MODULE: it is
// the only number that tells an owner whether the cash they were told about is
// the cash that is in the drawer.
//
// Two disciplines make that number trustworthy:
//
//   1. A CLOSED TILL IS NEVER MUTATED. A sale recorded after the count is a
//      `latePosting` — it hits the ledger (so the books stay true) but does not
//      change the closed session's totals (so the signed-off count stays true).
//      salesService enforces this; this route never updates a closed session.
//
//   2. ONE OPEN TILL PER USER PER BRANCH. Two open drawers for one cashier means
//      neither count means anything.
//
// THE SAFE is separate from the till and is a hash-adjacent append-only ledger:
// every deposit and payout carries a running `balance_after`, so the safe's
// balance at any moment can be recomputed from its rows and compared with the
// stored one. A safe that only stored a balance could be edited; a safe that
// stores a chain cannot be edited without the numbers disagreeing.
// =====================================================================

const { idempotent } = require('../lib/idempotency');
const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, branchFilter, scopeFilter, pagination, listResponse, dateRange, numField, strField, boolField, valid } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday, utcToWat } = require('../../domain/time');
const { oneOf } = require('../../domain/validation');
const { resolveDeduction, exemptionHint, whtRemittanceDueDate, WHT_REMITTANCE_DAY_OF_MONTH } = require('../../domain/nigerianTax');
const glService = require('../services/glService');

const PAYOUT_REASONS = ['TRANSPORT', 'FEEDING', 'FUEL', 'CLEANING', 'REPAIRS', 'CASUAL_WORKER', 'BANK_CHARGES', 'SUPPLIES', 'OTHER'];

// ---------------------------------------------------------------------
// WHERE CASH INTO THE SAFE CAME FROM, AND WHERE CASH OUT OF IT WENT
// ---------------------------------------------------------------------
// Both are FIXED LISTS because both become an account in the general ledger, and
// an account chosen from a free-text box is not a set of books. `from`/`account`
// are keys and chart codes the ledger already knows — no new accounts, no
// mapping table to keep in step.
// `kind: 'CASH'` — the money was already inside the business, so the entry moves
// it between two cash accounts and the balance-sheet total does not change.
// `kind: 'ACCOUNT'` — the money entered or left the business, so the other side is
// equity or an expense account.
const SAFE_DEPOSIT_SOURCES = Object.freeze([
  { code: 'BANK', label: 'Withdrawn from the bank', kind: 'CASH', from: 'BANK' },
  { code: 'OWNER', label: 'Put in by the owner', kind: 'ACCOUNT', account: '3000' },
  { code: 'TILL', label: 'Taken from the drawer', kind: 'CASH', from: 'TILL' },
  { code: 'OTHER', label: 'Somewhere else', kind: 'ACCOUNT', account: '6910' },
]);

const SAFE_WITHDRAWAL_DESTINATIONS = Object.freeze([
  { code: 'OWNER', label: 'Drawn by the owner', kind: 'ACCOUNT', account: '3200' },
  { code: 'EXPENSE', label: 'Paid out as an expense', kind: 'EXPENSE', account: null },
  { code: 'OTHER', label: 'Unclassified', kind: 'ACCOUNT', account: '6910' },
]);

/**
 * The safe's balance, computed from its ledger rather than read from a column.
 *
 * `branch_safe_ledger.amount` is SIGNED — positive into the safe, negative out
 * of it — and `entry_type` records WHY the money moved, not which direction it
 * went. So the balance is simply the sum of the amounts.
 *
 * An earlier version of this summed a CASE expression over entry_type names that
 * this schema does not even permit (the column has a CHECK constraint listing
 * OPENING, DEPOSIT, WITHDRAWAL, BANKING, EXPENSE, TRANSFER_IN, TRANSFER_OUT,
 * ADJUSTMENT, TILL_FUND and TILL_RETURN). Every write would have been rejected,
 * and the balance would have double-counted the sign on any type it did not
 * recognise. Recomputing from the rows is also what makes the chain checkable:
 * `balance_after` on each row must equal the running sum, so an edited row shows
 * up as a disagreement rather than passing silently.
 */
async function safeBalance(db, branchId) {
  const row = await db.first(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM branch_safe_ledger WHERE branch_id = ? AND is_deleted = 0',
    [String(branchId)],
  );
  return round2(Number((row || {}).balance) || 0);
}

/** The entry types the schema allows, with the direction each one implies. */
const SAFE_IN = 1;
const SAFE_OUT = -1;
const SAFE_ENTRY_TYPES = {
  OPENING: SAFE_IN, DEPOSIT: SAFE_IN, TRANSFER_IN: SAFE_IN, TILL_RETURN: SAFE_IN,
  WITHDRAWAL: SAFE_OUT, BANKING: SAFE_OUT, EXPENSE: SAFE_OUT, TRANSFER_OUT: SAFE_OUT,
  TILL_FUND: SAFE_OUT, ADJUSTMENT: 0, // an adjustment carries its own sign
};

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // TILL SESSIONS
  // -------------------------------------------------------------------
  app.get(`${base}/tills`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 14 });
    const where = ['t.is_deleted = 0', "date(t.opened_at, '+1 hours') BETWEEN ? AND ?"];
    const params = [from, to];
    const f = scopeFilter(scope, { alias: 't' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    // A BRANCH THE CALLER NAMED NARROWS THIS LIST — see branchFilter() in lib/respond.
    const bf = await branchFilter(db, ctx, { alias: 't' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }
    const status = ctx.req.queryParam('status');
    if (status) { where.push('t.status = ?'); params.push(String(status).toUpperCase()); }
    const userId = ctx.req.queryParam('user_id');
    if (userId) { where.push('t.user_id = ?'); params.push(String(userId)); }
    const whereSql = where.join(' AND ');

    const rows = await db.all(`SELECT t.*, b.name AS branch_name, b.code AS branch_code, u.full_name AS cashier_name,
          (t.reviewed_by IS NOT NULL) AS reviewed
        FROM till_sessions t
        LEFT JOIN branches b ON b.id = t.branch_id
        LEFT JOIN users u ON u.id = t.user_id
        WHERE ${whereSql}
        ORDER BY t.opened_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM till_sessions t WHERE ${whereSql}`, params);
    const summary = await db.first(`SELECT COUNT(*) AS sessions,
          COALESCE(SUM(t.grand_total),0) AS takings,
          COALESCE(SUM(t.variance),0) AS net_variance,
          COALESCE(SUM(CASE WHEN t.status = 'OPEN' THEN 1 ELSE 0 END),0) AS open_now
        FROM till_sessions t WHERE ${whereSql}`, params);
    ctx.json({
      ...listResponse(rows, { limit, offset }, total),
      summary: {
        sessions: Number(summary.sessions) || 0,
        takings: round2(Number(summary.takings)),
        netVariance: round2(Number(summary.net_variance)),
        openNow: Number(summary.open_now) || 0,
      },
      range: { from, to },
    });
  });

  /** The caller's own open till, or the branch's. What the POS screen needs on load. */
  app.get(`${base}/tills/current`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const branch = await resolveBranch(db, ctx);

    let till = await db.first("SELECT * FROM till_sessions WHERE branch_id = ? AND user_id = ? AND status = 'OPEN' AND is_deleted = 0 ORDER BY opened_at DESC LIMIT 1",
      [String(branch.id), String(user.id)]);
    // An OWNER or MANAGER may be running the counter with somebody else's drawer
    // open. Falling back to the branch's open till (rather than reporting none)
    // is what lets a manager step in mid-shift without opening a second drawer.
    if (!till && atLeast(user.role, 'MANAGER')) {
      till = await db.first(`SELECT t.*, u.full_name AS cashier_name FROM till_sessions t
          LEFT JOIN users u ON u.id = t.user_id
          WHERE t.branch_id = ? AND t.status = 'OPEN' AND t.is_deleted = 0 ORDER BY t.opened_at DESC LIMIT 1`, [String(branch.id)]);
      if (till) ctx.set('tillBelongsToSomebodyElse', true);
    }

    if (!till) return ctx.json({ ok: true, till: null, message: `No till is open at ${branch.name}.` });

    const live = await db.first(`SELECT COUNT(*) AS sales, COALESCE(SUM(s.total),0) AS revenue,
          COALESCE(SUM(s.balance_due),0) AS outstanding
        FROM sales s WHERE s.till_session_id = ? AND s.status <> 'VOIDED' AND s.is_deleted = 0`, [String(till.id)]);
    const byMethod = await db.all(`SELECT p.method, COALESCE(SUM(p.amount),0) AS amount, COUNT(*) AS count
        FROM sale_payments p WHERE p.sale_id IN (SELECT id FROM sales WHERE till_session_id = ? AND is_deleted = 0)
          AND p.is_deleted = 0 GROUP BY p.method ORDER BY amount DESC`, [String(till.id)]);
    const safeNow = await safeBalance(db, branch.id);

    ctx.json({
      ok: true, till,
      belongsToAnotherUser: Boolean(ctx.get('tillBelongsToSomebodyElse')),
      live: { sales: Number(live.sales) || 0, revenue: round2(Number(live.revenue)), outstanding: round2(Number(live.outstanding)) },
      byMethod,
      safeBalance: safeNow,
      // What the drawer SHOULD hold right now: the float it opened with, plus
      // cash taken, less cash paid back out. Shown beside the live figure so a
      // cashier can spot a problem during the shift rather than discovering it
      // at the count, when the customer is gone and the till is the only witness.
      expectedCashNow: round2(Number(till.opening_cash) + Number(till.cash_sales_total) - Number(till.refund_total)),
    });
  });

  /**
   * Open a till.
   *
   * The opening float is counted and recorded, not assumed. A drawer opened with
   * an unrecorded float cannot be reconciled at close: every kobo of the float
   * shows up as a surplus, and a permanent "surplus" trains everybody to ignore
   * the variance line.
   */
  app.post(`${base}/tills/open`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const existing = await db.first("SELECT * FROM till_sessions WHERE branch_id = ? AND user_id = ? AND status = 'OPEN' AND is_deleted = 0",
      [String(branch.id), String(user.id)]);
    if (existing) {
      throw new HttpError(
        `You already have an open till at ${branch.name} (opened ${utcToWat(existing.opened_at) || existing.opened_at}). Close it before opening another — two open drawers for one person means neither count means anything.`,
        { status: 409, code: 'TILL_ALREADY_OPEN' },
      );
    }

    const openingCash = numField(body.opening_cash ?? body.openingCash ?? branch.opening_cash ?? 0, { field: 'Opening float', min: 0 });
    const deviceId = strField(body.device_id || body.deviceId || ctx.req.header('X-Device-Id'), { field: 'Device', maxLength: 120 });
    const id = newId();
    const accountIds = await glService.loadAccountCodes(db, business.id);

    // The float's SOURCE. Money moved out of the safe into a drawer is not new
    // money, and treating it as such double-counts it in the branch's cash. So a
    // float taken from the safe writes a safe payout in the same transaction.
    const fromSafe = boolField(body.from_safe ?? body.fromSafe) && openingCash > 0;
    const safeNow = await safeBalance(db, branch.id);
    if (fromSafe) {
      const inSafe = safeNow;
      if (inSafe < openingCash) {
        throw new HttpError(`The safe at ${branch.name} holds ₦${inSafe.toLocaleString('en-NG')}, which is not enough for a ₦${openingCash.toLocaleString('en-NG')} float. Take the float from the bank instead, or fund the safe first.`, { status: 409, code: 'SAFE_INSUFFICIENT' });
      }
    }

    const safeAfter = fromSafe ? round2(safeNow - openingCash) : null;

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO till_sessions (
          id, branch_id, business_id, user_id, device_id, status, opened_at, opening_cash,
          expected_cash, counted_cash, variance, cash_sales_total, pos_total, transfer_total,
          mobile_money_total, cheque_total, credit_total, other_total, grand_total, refund_total,
          sale_count, void_count, notes, created_at, updated_at)
        VALUES (?,?,?,?,?, 'OPEN', datetime('now'), ?, ?, 0, 0, 0,0,0,0,0,0,0,0,0, 0,0, ?, datetime('now'), datetime('now'))`, [
        id, String(branch.id), String(business.id), String(user.id), deviceId,
        openingCash, openingCash,
        strField(body.notes, { field: 'Notes', maxLength: 500 }),
      ]);

      if (fromSafe) {
        // Money LEAVES the safe to fund the drawer, so the amount is negative and
        // the type is TILL_FUND. Recording it positive would make the safe look
        // richer every time a till was opened.
        tx.queue(`INSERT INTO branch_safe_ledger (
            id, branch_id, business_id, entry_type, amount, balance_after, reference_type, reference_id,
            till_session_id, reason, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?, 'TILL_FLOAT', ?, datetime('now'), datetime('now'))`, [
          // Both reference_id and till_session_id point at the same till session
          // and both need a value: one is how the ledger row is traced back, the
          // other is how the session's own safe movements are found. Supplying
          // only one left ten placeholders against nine values, so opening a
          // till funded from the safe failed outright.
          newId(), String(branch.id), String(business.id), 'TILL_FUND', -openingCash, safeAfter,
          'TILL_SESSION', id, id, String(user.id),
        ]);
        // THE FLOAT MOVES BETWEEN THE TWO CASH ACCOUNTS, AND NOW THE BOOKS SAY SO.
        //
        // Three versions of this line, and the first two were both wrong in the same
        // direction — the general ledger did not learn where the money was.
        //
        // 1. It posted a BANKING entry (DR Bank / CR Cash in Safe), inventing a bank
        //    deposit that never happened: the money went from the safe into a drawer in
        //    the same building.
        // 2. It posted NOTHING, on the reasoning that cash moving between the drawer and
        //    the safe is still cash at the branch. True about the BALANCE SHEET TOTAL,
        //    and wrong about the ACCOUNTS: with no post at all, the float never arrived
        //    in Cash at Till and Cash in Safe was never relieved of it. Run against
        //    staging, that produced **Cash in Safe reading −₦205,500 in the books while
        //    the branch safe physically held ₦4,000** — the exact defect the audit was
        //    written to find, still there, one layer down.
        //
        // 3. It posts the move: DR Cash at Till / CR Cash in Safe. Both legs are real
        //    accounts, the entry balances, total cash is unchanged, and each cash account
        //    can be reconciled against the thing it stands for. That is the rule
        //    everywhere cash moves inside the business now — see
        //    glService.postCashMoveStatements.
        for (const st of glService.postCashMoveStatements({
          businessId: String(business.id), branchId: String(branch.id), amount: openingCash,
          from: 'SAFE', to: 'TILL', sourceType: 'TILL', sourceId: id,
          description: `Till float of ₦${openingCash.toLocaleString('en-NG')} from the branch safe`,
          accountIds, user,
        })) tx.queue(st.sql, st.params);
      }
    });

    await recordFromCtx(ctx, {
      action: 'TILL_OPENED', entityType: 'TILL_SESSION', entityId: id, branchId: branch.id, businessId: business.id,
      after: { openingCash, fromSafe, deviceId },
    });
    ctx.json({
      ok: true, id,
      message: `Till opened at ${branch.name} with a ₦${openingCash.toLocaleString('en-NG')} float${fromSafe ? ' taken from the safe' : ''}.`,
      openingCash, fromSafe, safeBalanceAfter: safeAfter,
    }, 201);
  }));

  app.get(`${base}/tills/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const id = String(ctx.req.param('id'));
    const till = await db.first(`SELECT t.*, b.name AS branch_name, b.code AS branch_code,
          u.full_name AS cashier_name, r.full_name AS reviewer_name
        FROM till_sessions t
        LEFT JOIN branches b ON b.id = t.branch_id
        LEFT JOIN users u ON u.id = t.user_id
        LEFT JOIN users r ON r.id = t.reviewed_by
        WHERE t.id = ? AND t.is_deleted = 0`, [id]);
    if (!till) throw new HttpError('That till session does not exist.', { status: 404, code: 'TILL_NOT_FOUND' });
    if (!scope.allBranches && till.branch_id && !scope.branchIds.has(String(till.branch_id))) {
      throw new HttpError('That till belongs to another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }

    const [sales, byMethod, bySalesperson, voids, latePostings] = await Promise.all([
      db.all(`SELECT s.id, s.receipt_no, s.sold_at, s.total, s.amount_paid, s.balance_due, s.payment_method,
            s.status, s.customer_name, u.full_name AS cashier_name
          FROM sales s LEFT JOIN users u ON u.id = s.salesperson_id
          WHERE s.till_session_id = ? AND s.is_deleted = 0 ORDER BY s.sold_at DESC, s.receipt_no DESC LIMIT 500`, [id]),
      db.all(`SELECT p.method, COALESCE(SUM(p.amount),0) AS amount, COUNT(*) AS count
          FROM sale_payments p WHERE p.is_deleted = 0 AND p.sale_id IN
            (SELECT id FROM sales WHERE till_session_id = ? AND is_deleted = 0)
          GROUP BY p.method ORDER BY amount DESC`, [id]),
      db.all(`SELECT u.id AS user_id, u.full_name, COUNT(s.id) AS sales, COALESCE(SUM(s.total),0) AS revenue
          FROM sales s JOIN users u ON u.id = s.salesperson_id
          WHERE s.till_session_id = ? AND s.status <> 'VOIDED' AND s.is_deleted = 0
          GROUP BY u.id ORDER BY revenue DESC`, [id]),
      db.all(`SELECT s.id, s.receipt_no, s.total, s.void_reason, s.voided_at, u.full_name AS voided_by_name
          FROM sales s LEFT JOIN users u ON u.id = s.voided_by
          WHERE s.till_session_id = ? AND s.status = 'VOIDED' AND s.is_deleted = 0 ORDER BY s.voided_at DESC`, [id]),
      // Sales that landed AFTER the count. They are in the ledger but not in the
      // session totals, so the reconciliation has to name them or the variance
      // looks like theft.
      db.all(`SELECT s.id, s.receipt_no, s.sold_at, s.total FROM sales s
          WHERE s.branch_id = ? AND s.is_deleted = 0 AND s.status <> 'VOIDED'
            AND s.till_session_id IS NULL
            AND s.sold_at >= ? ${till.closed_at ? `AND s.sold_at <= ?` : ''}
          ORDER BY s.sold_at DESC LIMIT 100`,
      till.closed_at ? [String(till.branch_id), utcToWat(till.opened_at) || till.opened_at, utcToWat(till.closed_at) || till.closed_at] : [String(till.branch_id), utcToWat(till.opened_at) || till.opened_at]),
    ]);

    const counted = Number(till.counted_cash) || 0;
    const expected = round2(Number(till.opening_cash) + Number(till.cash_sales_total) - Number(till.refund_total));
    ctx.json({
      ok: true, till, sales, byMethod, bySalesperson, voids, latePostings,
      reconciliation: {
        openingCash: round2(Number(till.opening_cash)),
        cashSales: round2(Number(till.cash_sales_total)),
        refunds: round2(Number(till.refund_total)),
        expectedCash: till.status === 'CLOSED' ? round2(Number(till.expected_cash)) : expected,
        countedCash: counted,
        variance: till.status === 'CLOSED' ? round2(Number(till.variance)) : round2(counted - expected),
        varianceReason: till.variance_reason,
        reviewed: Boolean(till.reviewed_by),
      },
    });
  });

  /**
   * Close a till: record the physical count and the variance.
   *
   * THE VARIANCE IS SIGNED AND EXPLAINED. A shortfall needs a reason; a surplus
   * needs one too, and is the more suspicious of the two — money appearing in a
   * drawer usually means a sale was rung up and not recorded, which is a
   * revenue leak rather than a cash one.
   */
  app.post(`${base}/tills/:id/close`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();

    const till = await db.first('SELECT * FROM till_sessions WHERE id = ? AND is_deleted = 0', [id]);
    if (!till) throw new HttpError('That till session does not exist.', { status: 404, code: 'TILL_NOT_FOUND' });
    if (till.status === 'CLOSED') throw new HttpError('That till is already closed. Its count is a signed-off record and cannot be changed.', { status: 409, code: 'TILL_ALREADY_CLOSED' });

    // The till row IS the branch here — see the row-scoped rule in resolveBranch.
    const branch = await resolveBranch(db, ctx, { fallback: till.branch_id });
    if (String(till.branch_id) !== String(branch.id)) throw new HttpError('That till belongs to another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    // A cashier closes their OWN drawer. Somebody else's drawer needs a manager,
    // because the count is that person's accountability.
    if (String(till.user_id) !== String(user.id) && !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('That is not your till. Only its cashier or a manager can close it.', { status: 403, code: 'NOT_YOUR_TILL' });
    }

    const countedCash = numField(requireCounted(body), { field: 'Counted cash', min: 0 });
    const expectedCash = round2(Number(till.opening_cash) + Number(till.cash_sales_total) - Number(till.refund_total));
    const variance = round2(countedCash - expectedCash);

    const reason = strField(body.variance_reason || body.varianceReason, { field: 'Variance reason', maxLength: 500 });
    // Any variance at all needs explaining. A threshold would let small,
    // repeated shortages accumulate unnoticed — which is precisely how a
    // systematic leak hides.
    if (variance !== 0 && !reason) {
      throw new HttpError(
        `The drawer is ${variance < 0 ? 'short' : 'over'} by ₦${Math.abs(variance).toLocaleString('en-NG')} (you counted ₦${countedCash.toLocaleString('en-NG')}, the system expected ₦${expectedCash.toLocaleString('en-NG')}). Record why before closing — an unexplained variance cannot be investigated later.`,
        { status: 400, code: 'VARIANCE_REASON_REQUIRED', fields: { variance_reason: 'Required when the count differs.' } },
      );
    }

    // Bank the cash on close if asked. This is the step most shops skip, and
    // skipping it is why "the till balanced" and "the money reached the bank"
    // are two different claims that never get compared.
    const bankNow = numField(body.bank_amount ?? body.bankAmount, { field: 'Amount to bank', min: 0 });
    if (bankNow > countedCash) {
      throw new HttpError(`You cannot bank ₦${bankNow.toLocaleString('en-NG')} from a drawer that counted ₦${countedCash.toLocaleString('en-NG')}.`, { status: 400, code: 'OVER_BANKING' });
    }
    const toSafe = numField(body.to_safe ?? body.toSafe, { field: 'Amount to safe', min: 0 });
    if (bankNow + toSafe > countedCash) {
      throw new HttpError(`Banking ₦${bankNow.toLocaleString('en-NG')} and moving ₦${toSafe.toLocaleString('en-NG')} to the safe exceeds the ₦${countedCash.toLocaleString('en-NG')} in the drawer.`, { status: 400, code: 'OVER_ALLOCATION' });
    }

    const business = await resolveBusiness(db, ctx, branch);
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const safeBalanceNow = await safeBalance(db, branch.id);
    const safeAfter = round2(safeBalanceNow + toSafe);
    const bankReference = strField(body.bank_reference || body.deposit_slip, { field: 'Bank reference', maxLength: 80 });
    if (bankNow > 0 && !bankReference) {
      throw new HttpError('Record the deposit slip number. A banking entry with no reference cannot be matched to the bank statement, which is the only check that the money actually arrived.', { status: 400, code: 'BANK_REFERENCE_REQUIRED', fields: { bank_reference: 'Required' } });
    }

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE till_sessions SET status = 'CLOSED', closed_at = datetime('now'), counted_cash = ?,
          expected_cash = ?, variance = ?, variance_reason = ?, notes = COALESCE(notes,'') || ?,
          updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [
        countedCash, expectedCash, variance, reason,
        ` | Closed ${watNow()} by ${user.full_name || user.username}. Counted ₦${countedCash.toLocaleString('en-NG')} against ₦${expectedCash.toLocaleString('en-NG')} expected (variance ₦${variance.toLocaleString('en-NG')}).`,
        id,
      ]);

      if (toSafe > 0) {
        tx.queue(`INSERT INTO branch_safe_ledger (
            id, branch_id, business_id, entry_type, amount, balance_after, reference_type, reference_id,
            till_session_id, reason, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?, 'TILL_SESSION', ?, ?, 'Cash moved to safe on till close', ?, datetime('now'), datetime('now'))`, [
          // reference_id and till_session_id both carry the session id — see the
          // till-fund entry above for why both are needed.
          newId(), String(branch.id), String(business.id), 'TILL_RETURN', toSafe, safeAfter, id, id, String(user.id),
        ]);
        // AND THE BOOKS FOLLOW IT OUT OF THE DRAWER: DR Cash in Safe / CR Cash at Till.
        // The other half of the float's entry, in the other direction — without it the
        // sweep empties the physical drawer and leaves the ledger still saying the money
        // is at the till.
        for (const st of glService.postCashMoveStatements({
          businessId: String(business.id), branchId: String(branch.id), amount: toSafe,
          from: 'TILL', to: 'SAFE', sourceType: 'TILL', sourceId: id,
          description: `₦${toSafe.toLocaleString('en-NG')} swept from the drawer to the safe at close`,
          accountIds, user,
        })) tx.queue(st.sql, st.params);
      }

      // THE COUNT DID NOT MATCH, SO THE LEDGER MUST BE TOLD.
      //
      // `counted_cash` and the expected figure already differ by `variance`, and the till
      // row records it — but nothing posted it, so Cash at Till went on claiming money the
      // drawer did not hold, for the life of the business, one shortfall at a time. The
      // loss lands in 6910 Cash Over & Short where an owner can see the month's total.
      for (const st of glService.postCashOverShortStatements({
        businessId: String(business.id), branchId: String(branch.id), variance,
        accountCode: '1000', sourceType: 'TILL', sourceId: id,
        reason: reason || null, accountIds, user,
      })) tx.queue(st.sql, st.params);
      if (bankNow > 0) {
        for (const st of glService.postBankingStatements({
          businessId: String(business.id), branchId: String(branch.id), amount: bankNow,
          from: 'TILL', reference: bankReference || `Till close ${id.slice(0, 8)}`, accountIds, user,
        })) tx.queue(st.sql, st.params);
      }
    });

    await recordFromCtx(ctx, {
      action: 'TILL_CLOSED', entityType: 'TILL_SESSION', entityId: id, branchId: branch.id, businessId: business.id,
      before: { status: till.status, expectedCash },
      after: { countedCash, variance, reason, bankNow, toSafe, bankReference },
    });

    ctx.json({
      ok: true,
      message: variance === 0
        ? `Till closed and balanced exactly: ₦${countedCash.toLocaleString('en-NG')}.`
        : `Till closed with a ₦${Math.abs(variance).toLocaleString('en-NG')} ${variance < 0 ? 'SHORTFALL' : 'SURPLUS'} (counted ₦${countedCash.toLocaleString('en-NG')}, expected ₦${expectedCash.toLocaleString('en-NG')}).${bankNow > 0 ? ` ₦${bankNow.toLocaleString('en-NG')} banked.` : ''}`,
      countedCash, expectedCash, variance, banked: bankNow, toSafe,
      // A surplus is flagged harder than a shortfall on purpose.
      needsReview: variance !== 0 || bankNow > 0,
      varianceDirection: variance === 0 ? 'BALANCED' : (variance < 0 ? 'SHORT' : 'OVER'),
      warning: variance > 0
        ? 'A surplus is not good news: cash appearing in a drawer usually means a sale was taken and not recorded. Treat it as seriously as a shortfall.'
        : null,
    });
  }));

  /**
   * Manager sign-off on a closed till.
   *
   * Separate from closing so that the person who counted is not the person who
   * accepts the count. Where a manager does both (a small shop), the review still
   * records a second, deliberate act — which is what an auditor looks for.
   */
  app.post(`${base}/tills/:id/review`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can sign off a till.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const till = await db.first('SELECT * FROM till_sessions WHERE id = ? AND is_deleted = 0', [id]);
    if (!till) throw new HttpError('That till session does not exist.', { status: 404, code: 'TILL_NOT_FOUND' });
    if (till.status !== 'CLOSED') throw new HttpError('A till must be closed before it can be reviewed.', { status: 409, code: 'TILL_NOT_CLOSED' });
    if (till.reviewed_by) throw new HttpError('That till has already been signed off.', { status: 409, code: 'ALREADY_REVIEWED' });

    const accepted = boolField(body.accepted ?? true, true);
    const note = strField(body.note || body.notes, { field: 'Note', maxLength: 500, required: !accepted });
    if (!accepted && (!note || note.length < 4)) {
      throw new HttpError('If you are not accepting this count, say what is wrong. A rejected till with no note leaves the cashier guessing.', { status: 400, code: 'NOTE_REQUIRED' });
    }

    await db.run(`UPDATE till_sessions SET reviewed_by = ?, reviewed_at = datetime('now'),
        notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [
      String(user.id),
      ` | ${accepted ? 'Signed off' : 'REJECTED'} by ${user.full_name || user.username} at ${watNow()}${note ? `: ${note}` : ''}`,
      id,
    ]);
    await recordFromCtx(ctx, {
      action: accepted ? 'TILL_REVIEWED' : 'TILL_REVIEW_REJECTED', entityType: 'TILL_SESSION', entityId: id,
      branchId: till.branch_id, businessId: till.business_id,
      before: { variance: Number(till.variance), reviewedBy: null },
      after: { accepted, note, reviewedBy: String(user.id) },
    });
    ctx.json({ ok: true, message: accepted ? `Till signed off (variance ₦${Number(till.variance).toLocaleString('en-NG')}).` : `Till rejected: ${note}` });
  }));

  // -------------------------------------------------------------------
  // BRANCH SAFE
  // -------------------------------------------------------------------
  app.get(`${base}/safe`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const branch = await resolveBranch(db, ctx);
    const { limit, offset } = pagination(ctx);
    const entries = await db.all(`SELECT sl.*, u.full_name AS created_by_name, a.full_name AS approved_by_name
        FROM branch_safe_ledger sl
        LEFT JOIN users u ON u.id = sl.created_by
        LEFT JOIN users a ON a.id = sl.approved_by
        WHERE sl.branch_id = ? AND sl.is_deleted = 0
        ORDER BY sl.created_at DESC, sl.rowid DESC LIMIT ? OFFSET ?`, [String(branch.id), limit, offset]);
    const balance = await safeBalance(db, branch.id);
    // Recomputed from the rows rather than trusted from the last row: if the two
    // disagree, somebody edited a row, and that is worth knowing.
    //
    // "THE LAST ROW" HAS TO MEAN THE LAST ONE INSERTED, and it used to mean the one with
    // the largest id — an id that is RANDOM HEX. Two safe entries written in the same
    // second therefore came back in an arbitrary order, and when the newest row happened
    // to sort second, the running balance on the row being compared belonged to an older
    // entry. The screen then told an owner "A row has been edited outside this ledger"
    // about a ledger nobody had touched. Found by test/audit/audit.money.js: a ₦200,000
    // opening float and a ₦50,000 transfer to a drawer, both in the same second.
    //
    // `rowid` is the insertion order SQLite already keeps, so the newest row is the
    // newest row. The derived balance is a SUM and was always right; it was the row it
    // was compared against that was wrong.
    const storedLast = entries.length ? round2(Number(entries[0].balance_after)) : 0;

    // WHAT THE GENERAL LEDGER SAYS THE SAFE HOLDS, read back from the books.
    //
    // The safe ledger is the shop's own record of movements; Cash in Safe (1010) is
    // what the accounts believe. When they disagree, one of them is wrong, and until
    // this figure was on the screen nobody could tell — the two were never compared
    // by anything. On staging they disagreed by more than ₦200,000, because cash
    // moved between the drawer and the safe without the ledger being told.
    //
    // Reported, not asserted: an owner looking at a drifted safe wants to see both
    // numbers and the difference, and then decide. `POST /api/safe/reconcile` is how
    // they fix it, deliberately, with a note.
    const business = await resolveBusiness(db, ctx, branch);
    const books = await glService.trialBalance(db, { businessId: business.id, branchId: branch.id });
    const ledgerRow = (books.accounts || []).find((a) => a.code === '1010');
    const ledgerBalance = round2(Number(ledgerRow ? ledgerRow.balance : 0));
    const difference = round2(balance - ledgerBalance);

    ctx.json({
      ...listResponse(entries, { limit, offset }),
      branch: { id: branch.id, name: branch.name },
      balance,
      ledgerBalance,
      difference,
      inAgreement: Math.abs(difference) < 0.01,
      agreementMessage: Math.abs(difference) < 0.01
        ? `The books agree with the safe: ${'₦'}${balance.toLocaleString('en-NG')}.`
        : `The safe ledger says ${'₦'}${balance.toLocaleString('en-NG')} and the general ledger says ${'₦'}${ledgerBalance.toLocaleString('en-NG')} — a difference of ${'₦'}${difference.toLocaleString('en-NG')}. Cash moved inside the shop without the books being told, or a count was corrected in one place only. Reconcile it from this screen once you have counted the safe.`,
      chainConsistent: Math.abs(balance - storedLast) < 0.01,
      chainMessage: Math.abs(balance - storedLast) < 0.01
        ? null
        : `The safe's running balance does not add up: the entries sum to ₦${balance.toLocaleString('en-NG')} but the last row says ₦${storedLast.toLocaleString('en-NG')}. A row has been edited outside this ledger.`,
    });
  });

  /**
   * RECONCILE THE SAFE ACCOUNT — the one correction the two records cannot make
   * for themselves.
   *
   * Every other entry on this screen moves BOTH the safe ledger and the general
   * ledger, so they stay in step with each other and neither can fix a gap between
   * them. A gap is real: the safe ledger is a record of movements, and Cash in Safe
   * is the account an accountant reads. They disagree whenever cash moved between
   * the drawer and the safe before the books were told (which, until this stage,
   * was every float and every sweep — staging's safe account was more than
   * ₦200,000 adrift), or when a migration or a hand-edit touched one side.
   *
   * So: the owner counts the safe, and posts the difference to Cash Over & Short.
   * The SAFE LEDGER IS NOT TOUCHED — it is append-only and it says what physically
   * happened — so this corrects the figure in the ACCOUNTS to agree with the figure
   * on the shelf.
   *
   * `counted_balance` is what the owner actually counted; send nothing and the
   * route brings the books into line with the safe ledger instead. Either way the
   * note is required: a correction to the books with no reason is exactly the entry
   * a future reader cannot interpret.
   */
  app.post(`${base}/safe/reconcile`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can correct the safe account. It moves money in the books.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);
    const note = strField(body.note || body.reason, { field: 'Note', maxLength: 400, required: true });
    if (String(note || '').trim().length < 4) {
      throw new HttpError('Say what was counted and why the books were out. This is the entry the next person reading the accounts will rely on.', { status: 400, code: 'NOTE_REQUIRED' });
    }

    const safe = await safeBalance(db, branch.id);
    const books = await glService.trialBalance(db, { businessId: business.id, branchId: branch.id });
    const ledgerRow = (books.accounts || []).find((a) => a.code === '1010');
    const ledgerBalance = round2(Number(ledgerRow ? ledgerRow.balance : 0));
    const countedField = body.counted_balance ?? body.countedBalance ?? body.balance;
    const target = countedField === undefined || countedField === null || countedField === ''
      ? safe
      : numField(countedField, { field: 'Counted balance', min: 0 });
    const difference = round2(target - ledgerBalance);

    if (Math.abs(difference) < 0.01) {
      ctx.json({
        ok: true, reconciled: false, branch: { id: branch.id, name: branch.name },
        safeBalance: safe, ledgerBalance, difference: 0, target,
        message: `Nothing to correct: the books already say ₦${ledgerBalance.toLocaleString('en-NG')} in the safe and the count is ₦${target.toLocaleString('en-NG')}.`,
      });
      return;
    }

    // `difference` is what the BOOKS must move by. Positive means the safe holds
    // more than the books believe, which debits Cash in Safe and credits over &
    // short — the same shape as an overage at a till count, because it is one.
    const id = newId();
    const accountIds = await glService.loadAccountCodes(db, business.id);
    await db.transaction(async (tx) => {
      for (const st of glService.postCashOverShortStatements({
        businessId: String(business.id), branchId: String(branch.id), variance: difference,
        accountCode: 'SAFE', sourceType: 'SAFE', sourceId: id,
        reason: `safe reconciled against the count — ${note}`, accountIds, user,
      })) tx.queue(st.sql, st.params);
    });

    const after = await glService.trialBalance(db, { businessId: business.id, branchId: branch.id });
    const afterRow = (after.accounts || []).find((a) => a.code === '1010');
    const ledgerAfter = round2(Number(afterRow ? afterRow.balance : 0));
    const stillOut = round2(safe - ledgerAfter);

    await recordFromCtx(ctx, {
      action: 'SAFE_RECONCILED', entityType: 'GL_ACCOUNT', entityId: '1010',
      branchId: branch.id, businessId: business.id,
      before: { ledgerBalance, safeBalance: safe }, after: { ledgerBalance: ledgerAfter, target, difference, note },
    });
    ctx.json({
      ok: true, reconciled: true, id,
      branch: { id: branch.id, name: branch.name },
      safeBalance: safe, ledgerBalance: ledgerAfter, difference: stillOut, target,
      message: stillOut === 0
        ? `The books now say ₦${ledgerAfter.toLocaleString('en-NG')} in the safe, which is what the count says. ${'₦'}${Math.abs(difference).toLocaleString('en-NG')} posted to Cash Over & Short.`
        : `Posted ₦${difference.toLocaleString('en-NG')} to Cash Over & Short. The books say ₦${ledgerAfter.toLocaleString('en-NG')} and the count says ₦${target.toLocaleString('en-NG')} — ₦${stillOut.toLocaleString('en-NG')} apart.`,
    });
  }));

  /**
   * Move cash into or out of the safe.
   *
   * Payouts are capped by `staff_safe_spend_max` for STAFF and require a reason
   * from a fixed list. An open-text reason on a cash payout is unauditable: "misc"
   * repeated forty times a month is how a safe empties without anybody deciding
   * it should.
   */
  app.post(`${base}/safe/entries`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const entryType = valid(oneOf(requireField2(body, 'entry_type', ['DEPOSIT', 'WITHDRAWAL', 'BANKING', 'EXPENSE', 'ADJUSTMENT']), Object.keys(SAFE_ENTRY_TYPES), { field: 'Entry type' }), 'entry_type');
    const amount = numField(requireField2(body, 'amount', null), { field: 'Amount', min: 0.01 });
    const reasonCode = valid(oneOf(body.reason || body.reason_code || 'OTHER', PAYOUT_REASONS, { field: 'Reason' }), 'reason');
    // A reason from a fixed list is required for anything leaving the safe, and a
    // free-text note for an adjustment: "misc" forty times a month is how a safe
    // empties without anybody deciding it should.
    const note = strField(body.note || body.notes || body.description, { field: 'Note', maxLength: 500, required: ['WITHDRAWAL', 'EXPENSE', 'ADJUSTMENT'].includes(entryType) });

    // The SIGN is carried by `amount`, and the entry type only says why. So a
    // withdrawal, a banking, an expense and a till funding are all NEGATIVE, and
    // a deposit or a till return are POSITIVE. Getting this the other way round
    // would make the safe's balance move in the wrong direction on every payout.
    const outgoing = ['WITHDRAWAL', 'BANKING', 'EXPENSE', 'TRANSFER_OUT', 'TILL_FUND'].includes(entryType);
    const signedAmount = entryType === 'ADJUSTMENT'
      ? (boolField(body.outgoing) ? -amount : amount)
      : (outgoing ? -amount : amount);

    const staffCap = Number(settings.staff_safe_spend_max) || 0;
    if (outgoing && !atLeast(user.role, 'MANAGER')) {
      if (!boolField(settings.staff_can_spend_from_safe)) {
        throw new HttpError('Staff cannot spend from the safe at this business. Ask a manager.', { status: 403, code: 'SAFE_SPEND_NOT_ALLOWED' });
      }
      if (staffCap > 0 && amount > staffCap) {
        throw new HttpError(`That payout is ₦${amount.toLocaleString('en-NG')} but staff may spend at most ₦${staffCap.toLocaleString('en-NG')} from the safe. A manager must approve anything above it.`, { status: 403, code: 'SAFE_SPEND_OVER_LIMIT' });
      }
    }

    const balanceNow = await safeBalance(db, branch.id);
    if (outgoing && amount > balanceNow) {
      throw new HttpError(`The safe holds ₦${balanceNow.toLocaleString('en-NG')}, so ₦${amount.toLocaleString('en-NG')} cannot come out of it.`, { status: 409, code: 'SAFE_INSUFFICIENT' });
    }
    const balanceAfter = round2(balanceNow + signedAmount);

    // ------------------------------------------------------------------
    // WHERE THE MONEY CAME FROM, AND WHERE IT WENT.
    // ------------------------------------------------------------------
    // A deposit into the safe is not income and not a mystery: the cash came
    // from somewhere, and that somewhere is a second account in the books. A
    // withdrawal is the same question in reverse. Until these were asked, the
    // safe could only ever be debited by money the ledger never saw arrive, which
    // is precisely how Cash in Safe reached −₦205,500 on staging while the safe
    // held ₦4,000 — and, separately, how a payout for salaries left the books
    // with no wage cost in them at all.
    //
    // So both are required, from a fixed list. The list is short on purpose: a
    // free-text answer here is a free-text answer in the general ledger.
    const counterparty = String(body.source || body.destination || body.counterparty || '').trim().toUpperCase();
    const isDeposit = entryType === 'DEPOSIT';
    const isWithdrawal = entryType === 'WITHDRAWAL';
    if (isDeposit || isWithdrawal) {
      const allowed = isDeposit ? SAFE_DEPOSIT_SOURCES : SAFE_WITHDRAWAL_DESTINATIONS;
      if (!counterparty) {
        throw new HttpError(
          isDeposit
            ? `Say where the ₦${amount.toLocaleString('en-NG')} came from. Cash into the safe arrives from the bank, from the owner, from the drawer, or from somewhere else — and the books need the other side of the entry, or the safe's account drifts away from the safe.`
            : `Say where the ₦${amount.toLocaleString('en-NG')} went. Money leaving the safe is drawn by the owner, paid out as an expense, or unclassified — and each of those is a different line in the accounts.`,
          { status: 400, code: isDeposit ? 'SAFE_SOURCE_REQUIRED' : 'SAFE_DESTINATION_REQUIRED', fields: { [isDeposit ? 'source' : 'destination']: `One of ${allowed.map((x) => x.code).join(', ')}` } },
        );
      }
      const match = allowed.find((x) => x.code === counterparty);
      if (!match) {
        throw new HttpError(`"${counterparty}" is not somewhere cash ${isDeposit ? 'comes from' : 'goes'}. Choose one of: ${allowed.map((x) => `${x.code} (${x.label.toLowerCase()})`).join(', ')}.`,
          { status: 400, code: isDeposit ? 'SAFE_SOURCE_REQUIRED' : 'SAFE_DESTINATION_REQUIRED' });
      }
    }

    const reference = strField(body.reference, { field: 'Reference', maxLength: 80, required: entryType === 'BANKING' });
    if (entryType === 'BANKING' && !reference) {
      throw new HttpError('A bank deposit needs its slip number, or it cannot be matched to the statement.', { status: 400, code: 'REFERENCE_REQUIRED' });
    }

    const id = newId();
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const approvedBy = atLeast(user.role, 'MANAGER') ? String(user.id) : null;

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO branch_safe_ledger (
          id, branch_id, business_id, entry_type, amount, balance_after, reference_type, reference_id,
          till_session_id, reason, approved_by, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?, ?, NULL, ?, ?, ?, datetime('now'), datetime('now'))`, [
        id, String(branch.id), String(business.id), entryType, signedAmount, balanceAfter,
        reference ? 'BANK_SLIP' : null, reference,
        outgoing ? `${reasonCode}${note ? ` — ${note}` : ''}` : (note || reasonCode),
        approvedBy, String(user.id),
      ]);
      // EVERY ENTRY NOW POSTS, AND THE BALANCE SHEET TOTAL IS STILL UNTOUCHED.
      //
      // The old rule here was "only BANKING moves the general ledger", on the same
      // reasoning the till float used: cash inside the building is still cash at the
      // branch. It is right about the TOTAL and wrong about the ACCOUNTS — money arriving
      // in the safe has to be debited to 1010 and credited to whatever it came from, or
      // 1010 is a number nobody can reconcile with the safe, and a payout for salaries
      // never becomes a cost in the profit and loss at all.
      const movesToLedger = ['BANKING', 'DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT'].includes(entryType);
      if (movesToLedger) {
        let statements = [];
        if (entryType === 'BANKING') {
          statements = glService.postBankingStatements({
            businessId: String(business.id), branchId: String(branch.id), amount,
            from: 'SAFE', reference, accountIds, user,
          });
        } else if (isDeposit) {
          const src = SAFE_DEPOSIT_SOURCES.find((x) => x.code === counterparty);
          const description = `Cash into the safe: ${src.label.toLowerCase()}${note ? ` — ${note}` : ''}`;
          statements = src.kind === 'CASH'
            ? glService.postCashMoveStatements({
              businessId: String(business.id), branchId: String(branch.id), amount,
              from: src.from, to: 'SAFE', sourceType: 'SAFE', sourceId: id,
              description, accountIds, user,
            })
            : glService.postCashAgainstAccountStatements({
              businessId: String(business.id), branchId: String(branch.id), amount,
              cash: 'SAFE', direction: 'IN', accountCode: src.account,
              sourceType: 'SAFE', sourceId: id, description, accountIds, user,
            });
        } else if (isWithdrawal) {
          const dest = SAFE_WITHDRAWAL_DESTINATIONS.find((x) => x.code === counterparty);
          // A payout the reason list maps to an expense account is posted to THAT
          // account — a salary payout is a salary cost, not a mystery, and the
          // month's wages are then visible in the profit and loss rather than
          // missing from it. Anything the reason does not map falls through to the
          // destination's own account: drawings for the owner, over & short for
          // an unclassified payout (which is exactly what it is).
          const payoutAccount = dest.code === 'EXPENSE'
            ? (glService.EXPENSE_CATEGORY_ACCOUNTS[reasonCode] || '6900')
            : dest.account;
          statements = glService.postCashPayoutStatements({
            businessId: String(business.id), branchId: String(branch.id), amount,
            from: 'SAFE', accountCode: payoutAccount, sourceId: id,
            description: `Paid out of the safe: ${reasonCode.toLowerCase().replace(/_/g, ' ')}${note ? ` — ${note}` : ''}`,
            accountIds, user,
          });
        } else if (entryType === 'ADJUSTMENT') {
          // A correction to the safe's balance is cash appearing or disappearing
          // against the count, so it posts to over & short like a till variance.
          statements = glService.postCashOverShortStatements({
            businessId: String(business.id), branchId: String(branch.id),
            variance: signedAmount, accountCode: 'SAFE', sourceType: 'SAFE', sourceId: id,
            reason: note || 'Safe balance corrected', accountIds, user,
          });
        }
        for (const st of statements) tx.queue(st.sql, st.params);
      }
    });

    await recordFromCtx(ctx, {
      action: outgoing ? 'SAFE_PAYOUT' : 'SAFE_ENTRY', entityType: 'SAFE_LEDGER', entityId: id,
      branchId: branch.id, businessId: business.id,
      before: { balance: balanceNow }, after: { entryType, amount, signedAmount, balanceAfter, reasonCode, note, reference },
    });
    ctx.json({
      ok: true, id, balanceAfter,
      message: `${outgoing ? (entryType === 'BANKING' ? 'Banked' : 'Paid out') : 'Deposited'} ₦${amount.toLocaleString('en-NG')} ${outgoing ? `from the safe for ${reasonCode.replace(/_/g, ' ').toLowerCase()}` : 'into the safe'}. The safe now holds ₦${balanceAfter.toLocaleString('en-NG')}.`,
    }, 201);
  }));

  // -------------------------------------------------------------------
  // EXPENSES
  // -------------------------------------------------------------------
  /**
   * Record an expense.
   *
   * VAT and WHT are extracted HERE, at the point of entry, rather than left to a
   * month-end spreadsheet. Under the 2024 Withholding Regulations the payer
   * withholds and remits by the 21st of the following month, so an expense
   * recorded gross with no WHT line is a liability nobody has booked.
   */
  app.post(`${base}/expenses`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const category = strField(requireField2(body, 'category', null), { field: 'Category', maxLength: 80, required: true }).toUpperCase().replace(/\s+/g, '_');
    const amount = numField(requireField2(body, 'amount', null), { field: 'Amount', min: 0.01 });
    const description = strField(body.description, { field: 'Description', maxLength: 300, required: true });
    if (description.length < 4) {
      throw new HttpError('Describe what this was actually for. “Expense” cannot be approved or audited three months later.', { status: 400, code: 'DESCRIPTION_REQUIRED' });
    }

    const expenseDate = strField(body.expense_date || body.expenseDate, { field: 'Expense date', maxLength: 10 }) || watToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) throw new HttpError('The expense date must be YYYY-MM-DD.', { status: 400, code: 'INVALID_DATE' });

    // ---- WHT: resolved from the `wht_rates` table as DATA, never hardcoded in
    // the route. Rates change with the Regulations and correcting one must not
    // require a redeploy. `resolveDeduction` also checks the rate's DIRECTION, so
    // a receivable-only rate cannot be applied to an expense.
    const whtCode = strField(body.wht_code || body.whtCode, { field: 'WHT code', maxLength: 40 });
    const supplierId = body.supplier_id ? String(body.supplier_id) : null;
    const supplier = supplierId ? await db.first('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0', [supplierId]) : null;
    if (supplierId && !supplier) throw new HttpError('That supplier does not exist.', { status: 404, code: 'SUPPLIER_NOT_FOUND' });

    let wht = null;
    if (whtCode || body.wht_percent != null) {
      wht = await resolveDeduction(db, {
        grossAmount: amount,
        rateCode: whtCode || null,
        ratePercentOverride: body.wht_percent != null ? numField(body.wht_percent, { field: 'WHT rate', min: 0, max: 100 }) : null,
        direction: 'PAYABLE',
      });
    }
    const whtAmount = wht ? round2(wht.wht) : 0;
    const whtRate = wht ? Number(wht.ratePercent) : 0;
    const whtResolvedCode = wht ? wht.rateCode : null;
    // ADVISORY only, never blocking. The small-company threshold test is per
    // supplier per month and depends on turnover this system does not
    // authoritatively know, and a manufacturer is exempt from the 2% goods rate.
    // So the hint is surfaced and the owner decides.
    const exemption = wht ? exemptionHint({
      grossAmount: amount,
      counterpartyTin: supplier ? supplier.tin : strField(body.supplier_tin, { field: 'Supplier TIN', maxLength: 40 }),
      counterpartyIsManufacturer: Boolean(supplier && Number(supplier.is_manufacturer)),
    }) : null;

    // ---- input VAT, recoverable only if the business is VAT registered
    const vatInput = boolField(body.vat_registered ?? business.vat_registered) && Number(settings.vat_enabled)
      ? round2(amount * (Number(settings.vat_rate_percent) || 0) / (100 + (Number(settings.vat_rate_percent) || 0)))
      : 0;

    const netAmount = round2(amount - whtAmount);
    const paymentMethod = valid(oneOf(body.payment_method || 'CASH', ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'CHEQUE', 'SAFE', 'CREDIT'], { field: 'Payment method' }), 'payment_method');
    const needsApproval = !atLeast(user.role, 'MANAGER') && Boolean(Number(settings.managers_can_approve_expenses));
    // `expenses.status` allows PENDING_APPROVAL, APPROVED and REJECTED — there is
    // no PAID. Whether the money has left is recorded by `paid_from` and by the
    // ledger entry, not by inventing a status the CHECK constraint will refuse.
    const status = needsApproval ? 'PENDING_APPROVAL' : 'APPROVED';

    const id = newId();
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const expenseRow = {
      id, category, description, amount, vat_amount: vatInput, wht_code: whtResolvedCode,
      wht_percent: whtRate, wht_amount: whtAmount, net_amount: netAmount,
      expense_date: expenseDate, payment_method: paymentMethod, status,
      // WHICH DRAWER THE MONEY CAME OUT OF. `postExpenseStatements` credits the account
      // `paid_from` names, and it defaults to the till when it is absent — so an expense
      // paid from the SAFE wrote its safe-ledger row, took ₦3,000 out of the physical
      // safe, and posted the credit to Cash at Till. The ledger then said the till was
      // short and the safe still held money it had paid out; both records drifted, in
      // opposite directions, on the shop's most ordinary transaction.
      //
      // Found by test/audit/audit.money.js in Stage T2b, in the same branch as the two
      // undefined identifiers above: this code path had never once run to completion, so
      // it had never been wrong in a way anybody could see. THE COLUMN ON THE TABLE AND
      // THE FIELD IN THE OBJECT ARE TWO DIFFERENT NAMES FOR ONE FACT, and only one of
      // them was being written.
      paid_from: paymentMethod === 'SAFE' ? 'SAFE' : paymentMethod === 'CASH' ? 'TILL' : 'BANK',
    };

    const safeBalBefore = paymentMethod === 'SAFE' ? await safeBalance(db, branch.id) : null;
    if (safeBalBefore != null && safeBalBefore < amount) {
      throw new HttpError(`The safe holds ₦${safeBalBefore.toLocaleString('en-NG')}, which will not cover a ₦${amount.toLocaleString('en-NG')} expense.`, { status: 409, code: 'SAFE_INSUFFICIENT' });
    }

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO expenses (
          id, branch_id, business_id, category, gl_account_id, supplier_id, description, amount, vat_amount,
          wht_code, wht_percent, wht_amount, net_amount, expense_date, payment_method, reference, receipt_url,
          status, approved_by, approved_at, paid_from, created_by, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?, ?,?, ?,?,?, ?,?, datetime('now'), datetime('now'))`, [
        id, String(branch.id), String(business.id), category,
        // The GL account is resolved by code at posting time, not stored here:
        // glService maps the expense category to its 6xxx account, so a stored
        // id would go stale the moment the chart of accounts is re-seeded.
        null, supplierId, description, amount, vatInput,
        whtResolvedCode, whtRate, whtAmount, netAmount, expenseDate, paymentMethod,
        strField(body.reference, { field: 'Reference', maxLength: 80 }),
        strField(body.receipt_url, { field: 'Receipt', maxLength: 500 }),
        status, status === 'APPROVED' ? String(user.id) : null, status === 'APPROVED' ? watNow() : null,
        paymentMethod === 'SAFE' ? 'SAFE' : paymentMethod === 'CASH' ? 'TILL' : 'BANK',
        String(user.id),
        strField(body.notes, { field: 'Notes', maxLength: 500 }),
      ]);

      // The WHT withheld is recorded as its own entry. It is money the business
      // owes FIRS, not money it saved, and without this row the liability is
      // invisible until the 21st arrives.
      if (whtAmount > 0) {
        tx.queue(`INSERT INTO wht_entries (
            id, branch_id, business_id, direction, source_type, source_id, rate_code, rate_percent,
            gross_amount, wht_amount, net_amount, supplier_id, counterparty_name, counterparty_tin,
            recorded_by, entry_date, notes, created_at, updated_at)
          VALUES (?,?,?, 'PAYABLE', 'EXPENSE', ?,?,?, ?,?,?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
          newId(), String(branch.id), String(business.id), id,
          whtResolvedCode, whtRate, amount, whtAmount, netAmount, supplierId,
          supplier ? supplier.name : strField(body.supplier_name, { field: 'Supplier name', maxLength: 160 }),
          supplier ? supplier.tin : strField(body.supplier_tin, { field: 'Supplier TIN', maxLength: 40 }),
          String(user.id), expenseDate,
          `Withheld on ${category.replace(/_/g, ' ').toLowerCase()}: ${description}`,
        ]);
      }

      if (status === 'APPROVED') {
        for (const st of glService.postExpenseStatements({
          expense: expenseRow, business: { id: business.id }, branch: { id: branch.id },
          user, accountIds, vatInput, whtAmount,
        })) tx.queue(st.sql, st.params);
      }

      if (paymentMethod === 'SAFE') {
        // THE SAFE HAD TO COVER IT, AND `bal` WAS NEVER A VARIABLE IN THIS ROUTE.
        //
        // So EVERY attempt to pay an expense out of the branch safe answered
        // `500 {"error":"bal is not defined"}` — the one payment method whose whole
        // point is a cash drawer that must not go negative, and it could not be used
        // at all. The balance is now read above, when the payment method is chosen, and
        // it is read from the safe's own ledger rather than from a variable that reads
        // like it came from somewhere else.
        //
        // Found by test/audit/audit.money.js (Stage T2b) while proving that every way
        // cash leaves the safe reaches the books. Nothing else in the suite touched this
        // path: the WHT audit pays expenses from the till, and the unit tests call the
        // service rather than the route.
        if (safeBalBefore < amount) {
          throw new HttpError(`The safe holds ₦${safeBalBefore.toLocaleString('en-NG')}, which will not cover a ₦${amount.toLocaleString('en-NG')} expense. Record it as paid from the till, or put money into the safe first.`, { status: 409, code: 'SAFE_INSUFFICIENT' });
        }
        tx.queue(`INSERT INTO branch_safe_ledger (
            id, branch_id, business_id, entry_type, amount, balance_after, reference_type, reference_id,
            reason, approved_by, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?, ?, 'EXPENSE', ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
          newId(), String(branch.id), String(business.id), 'EXPENSE', -amount, round2(safeBalBefore - amount),
          // `approved_by` is the person who signed the payout off, and this route only
          // reaches here with a manager or better (the approval gate above). It used to
          // name a variable called `approvedBy` that does not exist in this file — the
          // second undefined identifier in the same branch, and the reason the first fix
          // was not the last one. A cash ledger row is the record of WHO paid money out.
          id, `${category}: ${description}`, String(user.id), String(user.id),
        ]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'EXPENSE_RECORDED', entityType: 'EXPENSE', entityId: id, branchId: branch.id, businessId: business.id,
      after: { category, amount, netAmount, wht: whtAmount, whtCode: whtResolvedCode, paymentMethod, status },
    });
    ctx.json({
      ok: true, id, status,
      message: needsApproval
        ? `₦${amount.toLocaleString('en-NG')} recorded as ${category.replace(/_/g, ' ').toLowerCase()} and queued for a manager's approval.`
        : `₦${amount.toLocaleString('en-NG')} recorded as ${category.replace(/_/g, ' ').toLowerCase()}.${whtAmount > 0 ? ` ₦${whtAmount.toLocaleString('en-NG')} WHT withheld (${whtRate}%, ${whtResolvedCode}) — remittable to FIRS by the ${WHT_REMITTANCE_DAY_OF_MONTH}th of next month.` : ''}`,
      amount, vatInput,
      wht: {
        code: whtResolvedCode, ratePercent: whtRate, amount: whtAmount,
        exemptionHint: exemption,
        // The remittance deadline travels with the entry so the owner sees WHEN
        // the withheld tax is due at the moment they record it, not when they go
        // looking for it on the 20th.
        remittanceDue: whtAmount > 0 ? whtRemittanceDueDate(expenseDate.slice(0, 7)) : null,
      },
      netAmount, needsApproval,
    }, 201);
  }));

  app.get(`${base}/expenses`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const where = ['e.is_deleted = 0', 'e.expense_date BETWEEN ? AND ?'];
    const params = [from, to];
    const f = scopeFilter(scope, { alias: 'e' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    // A BRANCH THE CALLER NAMED NARROWS THIS LIST — see branchFilter() in lib/respond.
    const bf = await branchFilter(db, ctx, { alias: 'e' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }
    const status = ctx.req.queryParam('status');
    if (status) { where.push('e.status = ?'); params.push(String(status).toUpperCase()); }
    const category = ctx.req.queryParam('category');
    if (category) { where.push('e.category = ?'); params.push(String(category).toUpperCase().replace(/\s+/g, '_')); }
    const whereSql = where.join(' AND ');

    const rows = await db.all(`SELECT e.*, b.name AS branch_name, s.name AS supplier_name, u.full_name AS created_by_name
        FROM expenses e
        LEFT JOIN branches b ON b.id = e.branch_id
        LEFT JOIN suppliers s ON s.id = e.supplier_id
        LEFT JOIN users u ON u.id = e.created_by
        WHERE ${whereSql} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM expenses e WHERE ${whereSql}`, params);
    const byCategory = await db.all(`SELECT e.category, COUNT(*) AS entries, COALESCE(SUM(e.amount),0) AS amount,
          COALESCE(SUM(e.wht_amount),0) AS wht
        FROM expenses e WHERE ${whereSql} GROUP BY e.category ORDER BY amount DESC`, params);
    const totals = await db.first(`SELECT COALESCE(SUM(e.amount),0) AS amount, COALESCE(SUM(e.wht_amount),0) AS wht,
          COALESCE(SUM(CASE WHEN e.status = 'PENDING_APPROVAL' THEN 1 ELSE 0 END),0) AS pending
        FROM expenses e WHERE ${whereSql}`, params);
    ctx.json({
      ...listResponse(rows, { limit, offset }, total),
      byCategory,
      summary: { amount: round2(Number(totals.amount)), whtWithheld: round2(Number(totals.wht)), pendingApproval: Number(totals.pending) || 0 },
      range: { from, to },
    });
  });

  /** Approve or reject a pending expense. */
  app.post(`${base}/expenses/:id/approve`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can approve an expense.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const expense = await db.first('SELECT * FROM expenses WHERE id = ? AND is_deleted = 0', [id]);
    if (!expense) throw new HttpError('That expense does not exist.', { status: 404, code: 'EXPENSE_NOT_FOUND' });
    if (expense.status !== 'PENDING_APPROVAL') throw new HttpError(`That expense is already ${expense.status.toLowerCase()}.`, { status: 409, code: 'NOT_PENDING' });

    const approved = boolField(body.approved ?? true, true);
    const note = strField(body.note || body.notes, { field: 'Note', maxLength: 500, required: !approved });
    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [expense.branch_id]);
    const accountIds = await glService.loadAccountCodes(db, expense.business_id);

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE expenses SET status = ?, approved_by = ?, approved_at = datetime('now'),
          notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [
        approved ? 'APPROVED' : 'REJECTED', String(user.id),
        ` | ${approved ? 'Approved' : 'Rejected'} by ${user.full_name || user.username} at ${watNow()}${note ? `: ${note}` : ''}`,
        id,
      ]);
      if (approved) {
        for (const st of glService.postExpenseStatements({
          expense, business: { id: expense.business_id }, branch: { id: branch.id },
          user, accountIds, vatInput: Number(expense.vat_amount) || 0, whtAmount: Number(expense.wht_amount) || 0,
        })) tx.queue(st.sql, st.params);
      }
    });

    await recordFromCtx(ctx, {
      action: approved ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED', entityType: 'EXPENSE', entityId: id,
      branchId: expense.branch_id, businessId: expense.business_id,
      before: { status: expense.status }, after: { approved, note, amount: Number(expense.amount) },
    });
    ctx.json({ ok: true, message: approved ? `Expense of ₦${Number(expense.amount).toLocaleString('en-NG')} approved and posted.` : `Expense rejected: ${note}` });
  }));
}

function requireField2(body, field, fallback) {
  const v = body[field];
  if (v === undefined || v === null || String(v).trim() === '') {
    if (Array.isArray(fallback)) {
      throw new HttpError(`Send ${field.replace(/_/g, ' ')}. Use one of ${fallback.join(', ')}.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: 'Required' } });
    }
    throw new HttpError(`${field.replace(/_/g, ' ')} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: 'Required' } });
  }
  return v;
}

function requireCounted(body) {
  const v = body.counted_cash ?? body.countedCash ?? body.cash_counted;
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new HttpError('Enter the cash you physically counted in the drawer. Closing a till without a count records no variance, which is the only number that shows whether the cash is there.', { status: 400, code: 'COUNT_REQUIRED', fields: { counted_cash: 'Required' } });
  }
  return v;
}

module.exports = { mount, SAFE_ENTRY_TYPES, PAYOUT_REASONS };
