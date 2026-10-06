'use strict';
// =====================================================================
// server/routes/changeOwed.js — CHANGE THE SHOP OWES A CUSTOMER
// =====================================================================
// A customer pays ₦5,000 with a ₦10,000 note for goods costing ₦9,700 and the
// counter has no change. The sale records ₦300 owed, with a claim code the customer
// can quote. Until this file existed, that ₦300 was recorded and then never
// recorded as PAID: the shop's liability only ever grew, and the counter had no way
// to clear it. The table was written, the setting existed, and the money had no
// direction home.
//
// THE FOUR THINGS A SHOP NEEDS TO DO WITH IT:
//
//   look at the list        GET  /api/change-owed
//   a customer claims it    GET  /api/change-owed/code/:code
//   hand the money over     POST /api/change-owed/:id/settle
//   decide to keep it       POST /api/change-owed/:id/write-off
//
// WHO MAY DO WHAT, and why the line falls there:
//
//   SETTLING is the COUNTER'S work. Handing a customer ₦300 of their own money back
//   is the same act as taking it in the first place, and requiring a manager would
//   mean the queue waits at the till for somebody who is not there. Any seat that
//   can see the branch may settle at it, and the row records who did.
//
//   WRITING OFF is a DECISION, not a transaction: it is the shop choosing to keep
//   money it owes. That needs a manager, and it needs a REASON written down, because
//   "why does the business have ₦40,000 of forfeited change this quarter?" is a
//   question a proprietor will eventually ask.
//
//   EXPIRY is a guard, not a wall. A claim past its window cannot be settled by a
//   cashier (the money is no longer expected to be in the drawer) but a manager may
//   authorise it, and the override is recorded — the alternative is refusing a
//   customer who is standing there with a valid-looking code, which no shopkeeper
//   will accept.
// =====================================================================

const { HttpError } = require('../lib/http');
const { newId } = require('../../domain/crypto');
const { watToday } = require('../../domain/time');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');

// HOW LONG A WRITE-OFF REASON HAS TO BE. Four characters accepted "gone", which is
// not an explanation anybody can act on a year later — and the sentence this endpoint
// already printed promised "a few words" while the check enforced four letters. The
// floor is exported so the screen can stop a cashier at the same place instead of
// letting them type something the server will refuse.
const MIN_REASON = 12;
const {
  resolveBusiness, branchFilter, scopeFilter, pagination, listResponse,
  searchTerm, strField, numField, flag,
} = require('../lib/respond');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Methods a settlement can leave by. Cash leaves the safe; anything else leaves its own channel. */
const SETTLE_METHODS = Object.freeze(['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'USSD', 'CHEQUE']);

/** Which cash account a non-cash settlement leaves from, so the books name the channel. */
const METHOD_ACCOUNT = Object.freeze({
  CASH: 'SAFE',
  BANK_TRANSFER: 'BANK',
  POS_TERMINAL: 'POS',
  MOBILE_MONEY: 'MOBILE_MONEY',
  USSD: 'MOBILE_MONEY',
  CHEQUE: 'BANK',
});

function mount(app, base = '/api') {
  /**
   * WHAT THE SHOP OWES, in the shape a screen can render.
   *
   * Defaults to OUTSTANDING because that is the only status anybody acts on: the
   * redeemed and forfeited rows are history, and a list that mixes them in front of a
   * cashier serving a queue is a list nobody reads. `status=ALL` is there for the
   * screen's own history toggle.
   */
  app.get(`${base}/change-owed`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    await resolveBusiness(db, ctx, null, { required: false });
    const { limit, offset } = pagination(ctx);
    const where = ['co.is_deleted = 0']; const params = [];
    const f = scopeFilter(scope, { alias: 'co' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }
    const bf = await branchFilter(db, ctx, { alias: 'co' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }

    const status = String(ctx.req.queryParam('status') || 'OUTSTANDING').toUpperCase();
    if (status !== 'ALL') {
      const wanted = status.split(',').map((s) => s.trim()).filter(Boolean);
      where.push(`co.status IN (${wanted.map(() => '?').join(',')})`);
      params.push(...wanted);
    }
    const q = searchTerm(ctx);
    if (q) {
      where.push('(co.customer_name LIKE ? OR co.customer_phone LIKE ? OR co.claim_code LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const customerId = ctx.req.queryParam('customer_id');
    if (customerId) { where.push('co.customer_id = ?'); params.push(String(customerId)); }

    const whereSql = where.join(' AND ');
    const rows = await db.all(`SELECT co.*, b.name AS branch_name,
          u.full_name AS redeemed_by_name, c.full_name AS created_by_name,
          s.receipt_no AS sale_receipt_no,
          CASE WHEN co.status = 'OUTSTANDING' AND co.expires_at IS NOT NULL AND co.expires_at < date('now')
               THEN 1 ELSE 0 END AS expired,
          CASE WHEN co.expires_at IS NULL THEN NULL
               ELSE CAST(julianday(co.expires_at) - julianday(date('now')) AS INTEGER) END AS days_left
        FROM change_owed co
        LEFT JOIN branches b ON b.id = co.branch_id
        LEFT JOIN users u ON u.id = co.redeemed_by
        LEFT JOIN users c ON c.id = co.created_by
        LEFT JOIN sales s ON s.id = co.sale_id
        WHERE ${whereSql}
        ORDER BY co.expires_at ASC, co.created_at ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.first(`SELECT COUNT(*) AS c FROM change_owed co WHERE ${whereSql}`, params);
    ctx.json(listResponse(rows || [], { limit, offset }, Number((total && total.c) || 0)));
  });

  /**
   * THE MONEY THE SHOP IS HOLDING, TOTALLED — the dashboard card's one request.
   *
   * `expiring_soon` is the number that makes the card useful rather than decorative:
   * change owed is a promise with a date on it, and a proprietor who sees "₦18,400
   * owed, ₦7,300 expires in the next week" has something to act on. It is counted
   * from the same rows the list shows, so the two cannot disagree.
   */
  app.get(`${base}/change-owed/summary`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    await resolveBusiness(db, ctx, null, { required: false });
    const where = ['co.is_deleted = 0', "co.status = 'OUTSTANDING'"]; const params = [];
    const f = scopeFilter(scope, { alias: 'co' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }
    const bf = await branchFilter(db, ctx, { alias: 'co' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }
    const whereSql = where.join(' AND ');
    const row = await db.first(`SELECT COUNT(*) AS claims,
          COALESCE(SUM(co.amount), 0) AS amount,
          COALESCE(SUM(CASE WHEN co.expires_at IS NOT NULL AND co.expires_at < date('now') THEN co.amount ELSE 0 END), 0) AS expired_amount,
          COALESCE(SUM(CASE WHEN co.expires_at IS NOT NULL AND co.expires_at >= date('now')
                             AND co.expires_at <= date('now', '+7 days') THEN co.amount ELSE 0 END), 0) AS expiring_soon_amount,
          MIN(co.expires_at) AS next_expiry
        FROM change_owed co WHERE ${whereSql}`, params);
    const byBranch = await db.all(`SELECT co.branch_id, br.name AS branch_name, COUNT(*) AS claims,
          COALESCE(SUM(co.amount), 0) AS amount
        FROM change_owed co LEFT JOIN branches br ON br.id = co.branch_id
        WHERE ${whereSql} GROUP BY co.branch_id ORDER BY amount DESC`, params);
    ctx.json({
      ok: true,
      outstanding_claims: Number((row && row.claims) || 0),
      outstanding_amount: round2((row && row.amount) || 0),
      expired_amount: round2((row && row.expired_amount) || 0),
      expiring_soon_amount: round2((row && row.expiring_soon_amount) || 0),
      next_expiry: (row && row.next_expiry) || null,
      by_branch: (byBranch || []).map((b) => ({ ...b, amount: round2(b.amount) })),
    });
  });

  /**
   * A CUSTOMER CLAIMS THE MONEY BY CODE.
   *
   * This is the request the counter makes with a customer standing in front of it,
   * so it answers the two things the cashier needs and nothing else: whether the
   * claim is real and settlable, and — if not — why, in words that can be said out
   * loud without a manager explaining them. Codes are compared without case because
   * a code is read off a receipt and typed by hand.
   */
  app.get(`${base}/change-owed/code/:code`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    await resolveBusiness(db, ctx, null, { required: false });
    // UPPERCASED HERE, NOT IN THE QUERY. `UPPER(co.claim_code) = UPPER(?)` reads the
    // same and defeats the unique index on the column — on a table that grows with
    // every outstanding sale, that is a full scan per lookup at the counter. Codes are
    // generated from an alphabet with no lowercase in it, so folding the input costs
    // nothing and keeps the lookup on the index.
    const code = strField(String(ctx.req.param('code') || '').trim().toUpperCase(),
      { field: 'Claim code', maxLength: 24, required: true });
    // THE PIN IS WRITTEN OUT, not assembled. `claim_code = ?` is the whole reason this
    // is a single-row read, and a reader — or the SQL audit — should be able to see it
    // without reconstructing a join of conditions.
    const f = scopeFilter(scope, { alias: 'co' });
    const bf = await branchFilter(db, ctx, { alias: 'co' });
    const row = await db.first(`SELECT co.*, b.name AS branch_name, s.receipt_no AS sale_receipt_no,
          CASE WHEN co.expires_at IS NOT NULL AND co.expires_at < date('now') THEN 1 ELSE 0 END AS expired
        FROM change_owed co
        LEFT JOIN branches b ON b.id = co.branch_id
        LEFT JOIN sales s ON s.id = co.sale_id
        WHERE co.claim_code = ?
          ${f.sql ? `AND ${f.sql}` : ''}
          ${bf.sql ? `AND ${bf.sql}` : ''}
          AND co.is_deleted = 0`,
    [code, ...f.params, ...bf.params]);
    if (!row) {
      throw new HttpError(`No change is owed against the code ${code}. Check the receipt — codes are eight characters.`, { status: 404, code: 'CLAIM_NOT_FOUND' });
    }
    const settlable = row.status === 'OUTSTANDING' && (!row.expired || atLeast(ctx.get('user').role, 'MANAGER'));
    ctx.json({
      ok: true,
      claim: row,
      settlable: Boolean(settlable),
      why_not: row.status !== 'OUTSTANDING'
        ? `This claim is already ${String(row.status).toLowerCase().replace(/_/g, ' ')}.`
        : (row.expired ? `This claim expired on ${String(row.expires_at).slice(0, 10)}. A manager can still authorise the payment.` : null),
    });
  });

  /**
   * HAND THE MONEY OVER.
   *
   * The row moves to REDEEMED once, and a second attempt is refused with the status,
   * the time and the person — because the second attempt is either a double-tap at a
   * busy counter or a second person trying the same code, and both need to be told
   * that the money has already gone out of the door.
   *
   * THE CASH COMES OUT OF THE SAFE, and the reason is worth stating. The till's
   * expected cash is computed from the day's sales and payments; paying a liability
   * out of the drawer would make the drawer short every time a customer collected
   * change, and the till count would stop meaning anything. Change owed is money the
   * shop holds, so it leaves from where the shop's money is held.
   */
  app.post(`${base}/change-owed/:id/settle`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json().catch(() => ({}));

    // SCOPE AND ROW IN ONE QUERY, so a claim in another branch is not found at all
    // rather than found and then refused: the message a caller gets should not tell
    // them that a claim exists somewhere they cannot see.
    const f = scopeFilter(scope, { alias: 'co' });
    const row = await db.first(`SELECT co.* FROM change_owed co
        WHERE co.id = ? AND co.is_deleted = 0${f.sql ? ` AND ${f.sql}` : ''}`, [id, ...f.params]);
    if (!row) throw new HttpError('That change claim does not exist.', { status: 404, code: 'CLAIM_NOT_FOUND' });

    if (row.status !== 'OUTSTANDING') {
      const who = row.redeemed_by ? await db.first('SELECT full_name, username FROM users WHERE id = ?', [String(row.redeemed_by)]) : null;
      const by = who ? ` by ${who.full_name || who.username}` : '';
      const when = row.redeemed_at ? ` on ${String(row.redeemed_at).slice(0, 10)}` : '';
      throw new HttpError(`That ₦${round2(row.amount).toLocaleString('en-NG')} claim is already ${String(row.status).toLowerCase().replace(/_/g, ' ')}${by}${when}, so it cannot be paid again.`, { status: 409, code: 'CLAIM_ALREADY_SETTLED', status_of_claim: row.status });
    }

    const expired = row.expires_at && String(row.expires_at).slice(0, 10) < watToday();
    const acceptExpired = flag(ctx, 'accept_expired') || body.accept_expired === true;
    if (expired && !acceptExpired) {
      throw new HttpError(`That claim expired on ${String(row.expires_at).slice(0, 10)}. A manager can authorise paying it anyway — pass accept_expired to record that decision.`, { status: 409, code: 'CLAIM_EXPIRED' });
    }
    if (expired && acceptExpired && !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager can authorise paying an expired claim.', { status: 403, code: 'ROLE_REQUIRED' });
    }

    const method = String(body.method || 'CASH').toUpperCase();
    if (!SETTLE_METHODS.includes(method)) {
      throw new HttpError(`Unknown settlement method "${body.method}".`, { status: 400, code: 'UNKNOWN_METHOD', fields: { method: `One of ${SETTLE_METHODS.join(', ')}.` } });
    }
    const reference = strField(body.reference, { field: 'Reference', maxLength: 80 });
    const amount = round2(numField(body.amount == null ? row.amount : body.amount, { field: 'Amount', min: 0.01 }));
    // A PART PAYMENT IS REFUSED, DELIBERATELY. Change owed is an exact figure the
    // customer was promised; paying half of it leaves a second claim on the same code
    // and no way for the next cashier to know what happened. The shop can write the
    // balance off if it wants to.
    if (Math.abs(amount - round2(row.amount)) > 0.005) {
      throw new HttpError(`This claim is for ₦${round2(row.amount).toLocaleString('en-NG')} and cannot be paid in part. Pay the full amount, or write the balance off with a reason.`, { status: 400, code: 'PART_SETTLEMENT' });
    }

    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [String(row.branch_id)]);
    const businessId = String(row.business_id);
    const { loadAccountCodes, postCashPayoutStatements } = require('../services/glService');
    const accountIds = await loadAccountCodes(db, businessId);

    // The safe's balance, read INSIDE the transaction's shape: balance_after is not a
    // decoration, it is what makes the ledger auditable without re-summing history.
    const balanceNow = round2((await db.first(
      'SELECT COALESCE(SUM(amount), 0) AS balance FROM branch_safe_ledger WHERE branch_id = ? AND is_deleted = 0',
      [String(row.branch_id)],
    )).balance);
    const balanceAfter = round2(balanceNow - amount);

    // ONLY CASH LEAVES THE SAFE. A refund sent by bank transfer or paid onto the
    // customer's mobile money never touched the drawer, and writing a safe movement
    // for it would make the safe's balance wrong by exactly the money the shop did not
    // hand over — a discrepancy that would be investigated as a theft.
    const cashAccount = METHOD_ACCOUNT[method] || 'SAFE';
    const fromSafe = cashAccount === 'SAFE';

    await db.transaction(async (tx) => {
      if (fromSafe) {
        tx.queue(`INSERT INTO branch_safe_ledger (
            id, branch_id, business_id, entry_type, amount, balance_after, reference_type, reference_id,
            reason, created_by, created_at, updated_at)
          VALUES (?,?,?, 'WITHDRAWAL', ?, ?, 'CHANGE_OWED', ?, ?, ?, datetime('now'), datetime('now'))`, [
          newId(), String(row.branch_id), businessId, -amount, balanceAfter, id,
          `Change owed paid to ${row.customer_name} (claim ${row.claim_code})${expired ? ' — expired claim authorised by a manager' : ''}`,
          String(user.id),
        ]);
      }

      // AND THE BOOKS: DR Change Owed Liability / CR the cash that left. The sale
      // credited 2210 when the change was first owed, so this is the other half of
      // that entry, in the other direction — without it the liability stays on the
      // books after the money has gone.
      // `sourceType` IS THE SAFE, NOT THE CLAIM, because the journal's source types are
      // a closed list in the schema and a change payout IS a safe payout. The claim is
      // named in the description and carried as the source id, so the entry is still
      // traceable to the customer it paid — but the books say what happened in the
      // language the rest of the ledger uses.
      const statements = postCashPayoutStatements({
        businessId, branchId: String(row.branch_id), amount,
        cash: cashAccount, accountCode: '2210',
        sourceType: 'SAFE', sourceId: id,
        description: `Change owed paid to ${row.customer_name} (${method.toLowerCase().replace(/_/g, ' ')})`,
        accountIds, user,
      });
      for (const st of statements) tx.queue(st.sql, st.params);

      tx.queue(`UPDATE change_owed SET status = 'REDEEMED', redeemed_at = datetime('now'), redeemed_by = ?,
          notes = TRIM(COALESCE(notes, '') || ?), updated_at = datetime('now') WHERE id = ? AND status = 'OUTSTANDING'`, [
        String(user.id),
        ` | Redeemed ${method}${reference ? ` ref ${reference}` : ''} by ${user.full_name || user.username}${expired ? ' (expired claim, manager override)' : ''}.`,
        id,
      ]);
    });

    // THE SECOND ATTEMPT MUST BE REFUSED, AND THE UPDATE ABOVE IS WHERE THAT IS DECIDED:
    // `AND status = 'OUTSTANDING'` means a race between two cashiers settles the claim
    // once. Re-read the row to see who actually won the race rather than assuming.
    const after = await db.first('SELECT status, redeemed_by, redeemed_at FROM change_owed WHERE id = ?', [id]);
    if (String(after.status) !== 'REDEEMED') {
      throw new HttpError('That claim was settled by somebody else while this payment was being recorded. Nothing was paid out a second time.', { status: 409, code: 'CLAIM_ALREADY_SETTLED' });
    }

    await recordFromCtx(ctx, {
      action: 'CHANGE_OWED_SETTLED', entityType: 'CHANGE_OWED', entityId: id,
      branchId: String(row.branch_id), businessId,
      before: { status: row.status, amount: round2(row.amount) },
      after: {
        status: 'REDEEMED', method, reference, amount,
        claim_code: row.claim_code, customer: row.customer_name,
        safe_balance_after: fromSafe ? balanceAfter : null, expired_override: Boolean(expired && acceptExpired),
      },
    });

    ctx.json({
      ok: true,
      id, status: 'REDEEMED', amount, method,
      customer_name: row.customer_name, claim_code: row.claim_code,
      branch: branch ? { id: branch.id, name: branch.name } : null,
      safe_balance_after: fromSafe ? balanceAfter : null,
      expired_override: Boolean(expired && acceptExpired),
      message: `₦${amount.toLocaleString('en-NG')} paid to ${row.customer_name}. The claim is closed.`,
    });
  });

  /**
   * DECIDE TO KEEP THE MONEY — with a reason, in writing, from a manager.
   *
   * Writing off is not the same as forfeiting by expiry, and the two are kept apart in
   * the status because they are different facts: WRITTEN_OFF is a person deciding,
   * FORFEITED is time passing. Both leave the money with the shop, and only one of
   * them can be asked "who decided that?".
   */
  app.post(`${base}/change-owed/:id/write-off`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can write off money the shop owes.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json().catch(() => ({}));
    const f = scopeFilter(ctx.get('scope'), { alias: 'co' });
    const row = await db.first(`SELECT co.* FROM change_owed co
        WHERE co.id = ? AND co.is_deleted = 0${f.sql ? ` AND ${f.sql}` : ''}`, [id, ...f.params]);
    if (!row) throw new HttpError('That change claim does not exist.', { status: 404, code: 'CLAIM_NOT_FOUND' });
    if (row.status !== 'OUTSTANDING') {
      throw new HttpError(`That claim is already ${String(row.status).toLowerCase().replace(/_/g, ' ')}, so there is nothing to write off.`, { status: 409, code: 'CLAIM_ALREADY_SETTLED' });
    }

    // THE REASON IS THE POINT OF THE ENDPOINT. A write-off with no explanation is
    // indistinguishable from a cashier pocketing the difference, and the audit trail
    // is where that question is answered.
    //
    // CHECKED AFTER THE CLAIM'S STATE, DELIBERATELY. A second attempt on a claim that
    // is already closed is refused for being closed, whatever the caller typed in the
    // reason box — the useful answer is "this money has already been dealt with", and
    // a 400 about the length of a sentence would send a manager off to rewrite a note
    // that was never going to be stored. Read without `required` so the refusal carries
    // THIS code and THIS sentence rather than "MISSING_FIELD".
    const reason = strField(body.reason, { field: 'Reason', maxLength: 300 });
    if (!reason || reason.trim().length < MIN_REASON) {
      throw new HttpError(`A write-off needs a reason of at least ${MIN_REASON} characters — it is how the business explains money it chose not to pay back, and "gone" explains nothing to the owner reading it next year.`, { status: 400, code: 'REASON_REQUIRED', fields: { reason: `Say why this is being written off, in at least ${MIN_REASON} characters.` } });
    }

    await db.run(`UPDATE change_owed SET status = 'WRITTEN_OFF', redeemed_at = datetime('now'), redeemed_by = ?,
        notes = TRIM(COALESCE(notes, '') || ?), updated_at = datetime('now')
      WHERE id = ? AND status = 'OUTSTANDING'`, [
      String(user.id),
      ` | Written off by ${user.full_name || user.username}: ${reason}`,
      id,
    ]);

    await recordFromCtx(ctx, {
      action: 'CHANGE_OWED_WRITTEN_OFF', entityType: 'CHANGE_OWED', entityId: id,
      branchId: String(row.branch_id), businessId: String(row.business_id),
      before: { status: row.status, amount: round2(row.amount) },
      after: { status: 'WRITTEN_OFF', amount: round2(row.amount), claim_code: row.claim_code, customer: row.customer_name, reason },
    });

    ctx.json({
      ok: true, id, status: 'WRITTEN_OFF', amount: round2(row.amount), reason,
      customer_name: row.customer_name, claim_code: row.claim_code,
      message: `₦${round2(row.amount).toLocaleString('en-NG')} owed to ${row.customer_name} was written off. The reason is recorded against your name.`,
      // NO LEDGER ENTRY, AND THAT IS DELIBERATE: the liability was already recognised
      // when the sale was made, and writing it off converts it to income the shop has
      // decided not to chase. Posting it here would be a second, wrong entry; the
      // period's accountant decides where a written-off liability lands.
    });
  });
}

module.exports = { mount, SETTLE_METHODS, METHOD_ACCOUNT, MIN_REASON };
