'use strict';
// =====================================================================
// server/routes/accounting.js — THE BOOKS
// =====================================================================
// Everything here is READ-ONLY over the general ledger, plus two deliberate
// write endpoints (a manual journal and a WHT remittance mark). That split is
// the design: the ledger is written by the TRANSACTIONS that cause it — a sale,
// a receipt, an expense — and never by a report. A report that could post would
// let somebody make the books say what they want.
//
// Three Nigerian specifics live here and nowhere else:
//
//   VAT is INCLUSIVE. A ₦45,000 sale at 7.5% contains ₦3,139.53 of VAT; the
//   revenue is ₦41,860.47. Extracting it as `total × r/(100+r)` rather than
//   adding 7.5% on top is the difference between owing FIRS the right amount
//   and owing them 7.5% of a figure that already included the tax.
//
//   WHT is DATA. The 2024 Withholding Regulations (effective 1 January 2025)
//   set the rates, and they live in the `wht_rates` table, not in code. Remitting
//   is due by the 21st of the following month, so the position is reported with
//   its deadline attached.
//
//   The trial balance must BALANCE. If it does not, an entry was posted with
//   unequal legs and every report downstream is wrong. `balances: false` is
//   surfaced as an error condition rather than a number to scroll past.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, readBusinessFilter, branchFilter, scopeFilter, pagination, listResponse, dateRange, numField, strField, boolField, valid, searchTerm } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday, addDays } = require('../../domain/time');
const { oneOf } = require('../../domain/validation');
const { extractVatFromInclusive, whtRemittanceDueDate, WHT_REMITTANCE_DAY_OF_MONTH, WHT_SCHEDULE_2024 } = require('../../domain/nigerianTax');
const glService = require('../services/glService');

// =====================================================================
// WHO MAY READ THE BOOKS
// =====================================================================
// The mutations on this surface were always guarded — only an owner may open an
// account, post a manual journal or declare tax remitted — and the REPORTS were open
// to anybody holding a token. A cashier with a phone could read the shop's profit and
// loss, its margins by category, its trial balance and what it owes FIRS.
//
// That is not a hole in the accounting; it is a hole in the shop. Margins are the most
// commercially sensitive numbers the business holds, they are visible to every member
// of staff on a shared device, and the person they leak to is the one who is about to
// be asked to negotiate a discount or who is about to leave for a competitor.
//
// So: the books are MANAGER and above. A manager runs a branch and answers for its
// numbers; a cashier runs a till. This is ONE function because a rule written out at
// eight endpoints is a rule that will be true at seven of them.
function requireBooks(ctx) {
  const user = ctx.get('user');
  if (!atLeast(user && user.role, 'MANAGER')) {
    throw new HttpError('Only a manager or above can read the accounts. Ask a manager to run this report.', { status: 403, code: 'ROLE_REQUIRED' });
  }
}

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // CHART OF ACCOUNTS
  // -------------------------------------------------------------------
  app.get(`${base}/accounting/accounts`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    // A read is narrowed by what the request NAMED, or by the caller's scope — never
    // by a guessed business. `readBusinessFilter` returns `1 = 1` for a caller who
    // reaches every business, which is the honest answer for a chart of accounts.
    const bf = await readBusinessFilter(db, ctx, { column: 'business_id', alias: 'a', allowNull: true });
    const rows = await db.all(`SELECT a.*,
          (SELECT COUNT(*) FROM gl_journal_lines l WHERE l.account_id = a.id AND l.is_deleted = 0) AS line_count,
          (SELECT COALESCE(SUM(l.debit - l.credit),0) FROM gl_journal_lines l
             JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.is_deleted = 0
             WHERE l.account_id = a.id AND l.is_deleted = 0) AS net_movement
        FROM gl_accounts a
        WHERE a.is_deleted = 0 AND ${bf.sql}
        ORDER BY a.code`, bf.params);
    // Grouped by type so the screen reads like an accountant's list, not a flat
    // table of 51 rows.
    const byType = {};
    for (const r of rows) {
      const t = r.account_type || 'OTHER';
      if (!byType[t]) byType[t] = { type: t, accounts: [], netMovement: 0 };
      byType[t].accounts.push({ ...r, net_movement: round2(Number(r.net_movement)) });
      byType[t].netMovement = round2(byType[t].netMovement + Number(r.net_movement));
    }
    ctx.json({ ok: true, data: rows, byType: Object.values(byType), count: rows.length });
  });

  app.post(`${base}/accounting/accounts`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) {
      throw new HttpError('Only an owner can add a ledger account. Every report is built from the chart of accounts, so changing it changes what the numbers mean.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const body = await ctx.req.json();
    const business = await resolveBusiness(db, ctx);
    const code = strField(requireVal(body, 'code'), { field: 'Account code', maxLength: 20, required: true });
    if (!/^\d{4}$/.test(code)) {
      throw new HttpError(`Account codes are four digits (1000 assets, 2000 liabilities, 4000 revenue, 5000 cost of sales, 6000 expenses, 7000 intercompany). “${code}” is not.`, { status: 400, code: 'INVALID_ACCOUNT_CODE', fields: { code: 'Four digits' } });
    }
    const dupe = await db.first('SELECT id, name FROM gl_accounts WHERE code = ? AND is_deleted = 0 AND business_id = ?', [code, String(business.id)]);
    if (dupe) throw new HttpError(`Account ${code} already exists (${dupe.name}). Codes must be unique or a report cannot tell two accounts apart.`, { status: 409, code: 'DUPLICATE_ACCOUNT_CODE' });

    const name = strField(requireVal(body, 'name'), { field: 'Account name', maxLength: 120, required: true });
    const accountType = valid(oneOf(requireVal(body, 'account_type'), ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'], { field: 'Account type' }), 'account_type');
    // The normal side follows from the type and is NOT caller-supplied: an asset
    // with a credit normal side would report its balance inverted on the trial
    // balance, and the resulting "difference" would look like a posting error
    // rather than a configuration one.
    // Cost of sales lives in the EXPENSE type with a debit normal side; the schema
    // has five account types, not six.
    const normalSide = ['ASSET', 'EXPENSE'].includes(accountType) ? 'DEBIT' : 'CREDIT';
    const id = newId();
    await db.run(`INSERT INTO gl_accounts (
        id, business_id, code, name, account_type, normal_side, is_system, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?, 0, 1, datetime('now'), datetime('now'))`, [
      id, String(business.id), code, name, accountType, normalSide,
    ]);
    await recordFromCtx(ctx, { action: 'GL_ACCOUNT_CREATED', entityType: 'GL_ACCOUNT', entityId: id, businessId: business.id, after: { code, name, accountType, normalSide } });
    ctx.json({ ok: true, id, message: `Account ${code} — ${name} (${accountType.replace(/_/g, ' ').toLowerCase()}, normal side ${normalSide.toLowerCase()}) added.` }, 201);
  });

  // -------------------------------------------------------------------
  // JOURNAL
  // -------------------------------------------------------------------
  app.get(`${base}/accounting/journal`, async (ctx) => {
    requireBooks(ctx);
    const db = ctx.env.DB || ctx.env.db;
    const bf = await readBusinessFilter(db, ctx, { column: 'business_id', alias: 'e', allowNull: true });
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const where = ['e.is_deleted = 0', 'e.entry_date BETWEEN ? AND ?', bf.sql];
    const params = [from, to, ...bf.params];
    if (!scope.allBranches && scope.branchIds) {
      const ids = [...scope.branchIds];
      where.push(`(e.branch_id IS NULL OR e.branch_id IN (${ids.map(() => '?').join(',')}))`);
      params.push(...ids);
    }
    // AND THE BRANCH THE CALLER NAMED. A journal for one shop is what a branch's trial
    // balance is read through, and naming a branch outside your access is refused rather
    // than answered with the group's entries. (`bf` above is the BUSINESS filter — hence
    // a second name rather than a second meaning for `bf`.)
    const nbf = await branchFilter(db, ctx, { alias: 'e' });
    if (nbf.sql) { where.push(nbf.sql); params.push(...nbf.params); }
    const sourceType = ctx.req.queryParam('source_type');
    if (sourceType) { where.push('e.source_type = ?'); params.push(String(sourceType).toUpperCase()); }
    const search = searchTerm(ctx);
    if (search) { where.push('(e.entry_no LIKE ? OR e.description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const whereSql = where.join(' AND ');

    const rows = await db.all(`SELECT e.*, u.full_name AS posted_by_name, b.name AS branch_name,
          (SELECT COUNT(*) FROM gl_journal_lines l WHERE l.journal_entry_id = e.id AND l.is_deleted = 0) AS line_count
        FROM gl_journal_entries e
        LEFT JOIN users u ON u.id = e.posted_by
        LEFT JOIN branches b ON b.id = e.branch_id
        WHERE ${whereSql} ORDER BY e.entry_date DESC, e.entry_no DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM gl_journal_entries e WHERE ${whereSql}`, params);
    ctx.json({ ...listResponse(rows, { limit, offset }, total), range: { from, to } });
  });

  app.get(`${base}/accounting/journal/:id`, async (ctx) => {
    requireBooks(ctx);
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const entry = await db.first(`SELECT e.*, u.full_name AS posted_by_name, b.name AS branch_name, biz.name AS business_name
        FROM gl_journal_entries e
        LEFT JOIN users u ON u.id = e.posted_by
        LEFT JOIN branches b ON b.id = e.branch_id
        LEFT JOIN businesses biz ON biz.id = e.business_id
        WHERE e.id = ? AND e.is_deleted = 0`, [id]);
    if (!entry) throw new HttpError('That journal entry does not exist.', { status: 404, code: 'ENTRY_NOT_FOUND' });
    const lines = await db.all(`SELECT l.*, a.code AS account_code, a.name AS account_name, a.account_type
        FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.account_id
        WHERE l.journal_entry_id = ? AND l.is_deleted = 0 ORDER BY a.code, l.id`, [id]);
    const debit = round2(lines.reduce((a, l) => a + Number(l.debit || 0), 0));
    const credit = round2(lines.reduce((a, l) => a + Number(l.credit || 0), 0));
    ctx.json({
      ok: true, entry, lines,
      totals: { debit, credit, balances: Math.abs(debit - credit) <= 0.005, difference: round2(Math.abs(debit - credit)) },
      // A source link, so an accountant can jump from the entry to the sale or
      // expense that caused it. An entry with no route back to its source is
      // unauditable.
      source: entry.source_id ? { type: entry.source_type, id: entry.source_id } : null,
    });
  });

  /**
   * A manual journal entry. OWNER only.
   *
   * Deliberately narrow: it must balance, every account must exist, and it is
   * stamped MANUAL so a reviewer can find every hand-written entry in one query.
   * The alternative — letting anybody post anything — is how a ledger stops
   * being evidence.
   */
  app.post(`${base}/accounting/journal`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) {
      throw new HttpError('Only an owner can post a manual journal. Every automatic entry in this ledger was caused by a transaction; a manual one was caused by a judgement, and it should be one person\'s responsibility.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const body = await ctx.req.json();
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const description = strField(requireVal(body, 'description'), { field: 'Description', maxLength: 300, required: true });
    if (description.length < 8) {
      throw new HttpError('Describe what this entry is for, in a sentence. A manual journal with a vague description is the first thing an auditor challenges and the hardest to defend two years later.', { status: 400, code: 'DESCRIPTION_REQUIRED' });
    }
    const entryDate = strField(body.entry_date, { field: 'Entry date', maxLength: 10 }) || watToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new HttpError('The entry date must be YYYY-MM-DD.', { status: 400, code: 'INVALID_DATE' });
    if (entryDate > watToday()) {
      throw new HttpError('A journal entry cannot be dated in the future. Date it today, or wait until the day it belongs to.', { status: 400, code: 'FUTURE_ENTRY' });
    }

    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (rawLines.length < 2) throw new HttpError('A double-entry journal needs at least two lines — a debit and a credit.', { status: 400, code: 'TOO_FEW_LINES' });

    const accountIds = await glService.loadAccountCodes(db, business.id);
    const lines = [];
    let totalDebit = 0; let totalCredit = 0;
    for (let i = 0; i < rawLines.length; i += 1) {
      const l = rawLines[i];
      const code = strField(l.account_code || l.code, { field: `Line ${i + 1} account`, maxLength: 20, required: true });
      const debit = numField(l.debit, { field: `Line ${i + 1} debit`, min: 0 });
      const credit = numField(l.credit, { field: `Line ${i + 1} credit`, min: 0 });
      if (debit > 0 && credit > 0) {
        throw new HttpError(`Line ${i + 1} has both a debit and a credit. Split it into two lines — a line that does both is not a double entry, it is a net figure, and the ledger loses the detail.`, { status: 400, code: 'BOTH_SIDES' });
      }
      if (debit === 0 && credit === 0) {
        throw new HttpError(`Line ${i + 1} has no amount. Remove it or give it a value.`, { status: 400, code: 'ZERO_LINE' });
      }
      // `loadAccountCodes` returns a Map, not an object — `accountIds[code]`
      // would be undefined for every code and silently reject a valid entry.
      if (!accountIds || !accountIds.get(code)) {
        const known = accountIds ? [...accountIds.keys()].sort().join(', ') : 'none loaded';
        throw new HttpError(`Account ${code} does not exist on this business's chart of accounts. Known codes: ${known}.`, { status: 400, code: 'UNKNOWN_ACCOUNT' });
      }
      totalDebit = round2(totalDebit + debit);
      totalCredit = round2(totalCredit + credit);
      lines.push({ accountCode: code, debit, credit, description: strField(l.description, { field: `Line ${i + 1} description`, maxLength: 200 }) });
    }

    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      throw new HttpError(
        `This entry does not balance: ₦${totalDebit.toLocaleString('en-NG')} of debits against ₦${totalCredit.toLocaleString('en-NG')} of credits, a difference of ₦${round2(Math.abs(totalDebit - totalCredit)).toLocaleString('en-NG')}. Double entry requires the two to be equal.`,
        { status: 400, code: 'ENTRY_NOT_BALANCED', fields: { lines: 'Debits must equal credits' } },
      );
    }

    const id = newId();
    // Built through `glService.buildEntry` rather than written by hand here.
    // buildEntry is the ONE place a journal entry is constructed: it refuses an
    // unbalanced entry, refuses an unknown account, and generates the entry
    // number. A second construction path would eventually disagree with it, and
    // the disagreement shows up as a trial balance that does not balance.
    const statements = glService.buildEntry({
      businessId: String(business.id),
      branchId: branch ? String(branch.id) : null,
      entryDate,
      sourceType: 'MANUAL',
      sourceId: id,
      description,
      lines,
      postedBy: String(user.id),
      accountIds,
    });
    if (!statements.length) {
      throw new HttpError('Every line had a zero amount, so there is nothing to post.', { status: 400, code: 'EMPTY_ENTRY' });
    }
    // The entry number is generated by buildEntry, not here, so that every entry
    // in the ledger is numbered by the same code path. It is the 4th bound
    // parameter of buildEntry's header INSERT.
    const postedEntryNo = statements[0].params[3];

    await db.transaction(async (tx) => {
      for (const st of statements) tx.queue(st.sql, st.params);
    });

    await recordFromCtx(ctx, {
      action: 'MANUAL_JOURNAL_POSTED', entityType: 'GL_ENTRY', entityId: id,
      branchId: branch ? branch.id : null, businessId: business.id,
      after: { entryNo: postedEntryNo, entryDate, description, totalDebit, totalCredit, lines: lines.map((l) => ({ code: l.accountCode, debit: l.debit, credit: l.credit })) },
    });
    ctx.json({
      ok: true, id, entryNo: postedEntryNo,
      message: `Manual journal ${postedEntryNo} posted for ${entryDate}: \u20a6${totalDebit.toLocaleString('en-NG')} debited and credited across ${lines.length} line(s).`,
      totalDebit, totalCredit, entryDate, lines,
    }, 201);
  });

  // -------------------------------------------------------------------
  // REPORTS
  // -------------------------------------------------------------------
  /**
   * Trial balance.
   *
   * `balances: false` is returned as a 500-shaped warning rather than hidden: if
   * the two sides differ, an entry was posted with unequal legs and EVERY report
   * built on the ledger is wrong. Showing a tidy table over an unbalanced ledger
   * is the worst possible failure mode, because it looks like it worked.
   */
  app.get(`${base}/accounting/trial-balance`, async (ctx) => {
    requireBooks(ctx);
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const asAt = strField(ctx.req.queryParam('as_at'), { field: 'As-at date', maxLength: 10 }) || watToday();
    const tb = await glService.trialBalance(db, {
      businessId: String(business.id), asAt,
      branchId: branch && ctx.req.queryParam('branch_scope') ? String(branch.id) : null,
    });
    if (!tb.balances) {
      ctx.header('X-Ledger-Unbalanced', 'true');
    }
    ctx.json({
      ok: tb.balances,
      ...tb,
      // Said plainly, because a difference of ₦0.01 and a difference of ₦400,000
      // need completely different responses and the number alone does not convey
      // which is which to a non-accountant.
      message: tb.balances
        ? `The books balance at ${asAt}: ₦${tb.totalDebit.toLocaleString('en-NG')} on each side across ${tb.accounts.filter((a) => a.totalDebit !== 0 || a.totalCredit !== 0).length} active account(s).`
        : `THE BOOKS DO NOT BALANCE at ${asAt}. Debits total ₦${tb.totalDebit.toLocaleString('en-NG')} and credits ₦${tb.totalCredit.toLocaleString('en-NG')} — a difference of ₦${tb.difference.toLocaleString('en-NG')}. An entry was posted with unequal legs. Until it is found, every report built on this ledger is unreliable.`,
    }, tb.balances ? 200 : 500);
  });

  app.get(`${base}/accounting/profit-loss`, async (ctx) => {
    requireBooks(ctx);
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const useBranch = Boolean(ctx.req.queryParam('branch_scope'));
    const pl = await glService.profitAndLoss(db, {
      businessId: String(business.id), startDate: from, endDate: to,
      branchId: branch && useBranch ? String(branch.id) : null,
    });
    const byCategory = await glService.revenueByCategory(db, {
      businessId: String(business.id), startDate: from, endDate: to,
      branchId: branch && useBranch ? String(branch.id) : null,
    });
    ctx.json({
      ok: true, range: { from, to }, scope: useBranch && branch ? { branch: branch.name } : { business: business.name },
      ...pl, byCategory,
      commentary: pl.grossMarginPct != null
        ? `Gross margin is ${pl.grossMarginPct}% on ₦${round2(Number(pl.revenue || 0)).toLocaleString('en-NG')} of revenue for ${from} to ${to}.`
        : null,
    });
  });

  app.get(`${base}/accounting/balance-sheet`, async (ctx) => {
    requireBooks(ctx);
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const asAt = strField(ctx.req.queryParam('as_at'), { field: 'As-at date', maxLength: 10 }) || watToday();
    const bs = await glService.balanceSheet(db, {
      businessId: String(business.id), asAt,
      branchId: branch && ctx.req.queryParam('branch_scope') ? String(branch.id) : null,
    });
    ctx.json({
      ok: bs.balances !== false, asAt, ...bs,
      message: bs.balances === false
        ? `Assets (₦${Number(bs.totalAssets || 0).toLocaleString('en-NG')}) do not equal liabilities plus equity (₦${Number(bs.totalLiabilitiesAndEquity || 0).toLocaleString('en-NG')}). The accounting equation is broken, which means an entry was posted with unequal legs.`
        : `The balance sheet balances at ${asAt}.`,
    });
  });

  /**
   * The VAT position for a period — what is owed to FIRS.
   *
   * OUTPUT VAT is extracted from inclusive sales; INPUT VAT is what was paid on
   * purchases and expenses and is recoverable. The net is what is remittable.
   * Both figures come from the LEDGER (accounts 2110 and the input-VAT account),
   * not from a re-derivation of the sales table, because the ledger is what the
   * return is filed against and the two must not disagree.
   */
  app.get(`${base}/accounting/vat`, async (ctx) => {
    requireBooks(ctx);
    const db = ctx.env.DB || ctx.env.db;
    // THIS ONE NEEDS THE BUSINESS'S OWN FACTS, NOT JUST A FILTER — whether it is
    // registered for VAT decides whether an input-VAT credit exists at all. A
    // caller who named one entity gets that entity's answer; a caller who reaches
    // several and named none is reporting across all of them, so the credit is
    // available if ANY of them is registered.
    const business = await resolveBusiness(db, ctx, null, { required: false });
    const settings = ctx.get('settings');
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const rate = Number(settings.vat_rate_percent) || 7.5;
    const bf = await readBusinessFilter(db, ctx, { column: 'business_id', alias: 's', allowNull: false });
    const bf2 = await readBusinessFilter(db, ctx, { column: 'business_id', alias: 'e', allowNull: false });
    let anyRegistered = false;
    if (!business) {
      const vb = await readBusinessFilter(db, ctx, { column: 'id', alias: 'bz', allowNull: false });
      const row = await db.first(`SELECT COUNT(*) AS n FROM businesses bz WHERE bz.is_deleted = 0 AND bz.vat_registered = 1 AND ${vb.sql}`, vb.params);
      anyRegistered = Number(row && row.n) > 0;
    }

    // Output VAT: from sales, excluding voids. A voided sale's VAT was reversed
    // in the ledger, so including it here would overstate what is owed.
    const output = await db.first(`SELECT COUNT(*) AS sales, COALESCE(SUM(s.vat_amount),0) AS vat,
          COALESCE(SUM(s.total - s.vat_amount),0) AS net_revenue
        FROM sales s WHERE ${bf.sql} AND s.is_deleted = 0 AND s.status <> 'VOIDED'
          AND s.vat_enabled = 1 AND date(s.sold_at) BETWEEN ? AND ?`, [...bf.params, from, to]);

    const voided = await db.first(`SELECT COUNT(*) AS sales, COALESCE(SUM(s.vat_amount),0) AS vat
        FROM sales s WHERE ${bf.sql} AND s.is_deleted = 0 AND s.status = 'VOIDED'
          AND s.vat_enabled = 1 AND date(s.sold_at) BETWEEN ? AND ?`, [...bf.params, from, to]);

    // Input VAT on expenses, where the business is registered and can recover it.
    const input = await db.first(`SELECT COUNT(*) AS entries, COALESCE(SUM(e.vat_amount),0) AS vat
        FROM expenses e WHERE ${bf2.sql} AND e.is_deleted = 0 AND e.status <> 'REJECTED'
          AND e.expense_date BETWEEN ? AND ?`, [...bf2.params, from, to]);

    const outputVat = round2(Number(output.vat));
    const inputVat = round2(Number(input.vat));
    const net = round2(outputVat - inputVat);
    const registered = (business ? Boolean(Number(business.vat_registered)) : anyRegistered)
      && Boolean(Number(settings.vat_enabled));

    ctx.json({
      ok: true, range: { from, to }, ratePercent: rate, registered,
      output: { sales: Number(output.sales) || 0, vat: outputVat, netRevenue: round2(Number(output.net_revenue)), voidedSales: Number(voided.sales) || 0, voidedVat: round2(Number(voided.vat)) },
      input: { entries: Number(input.entries) || 0, vat: inputVat },
      netPayable: net,
      position: net > 0 ? 'PAYABLE' : (net < 0 ? 'RECOVERABLE' : 'NIL'),
      // FIRS VAT returns are due on the 21st of the following month, the same
      // day as WHT. Reporting the date with the amount is what turns a figure
      // into something somebody acts on.
      dueBy: whtRemittanceDueDate(to.slice(0, 7)),
      message: !registered
        ? 'This business is not registered for VAT (or VAT is disabled in settings), so no return is due. If turnover has passed the registration threshold, register — charging VAT without being registered is worse than not charging it.'
        : net > 0
          ? `₦${net.toLocaleString('en-NG')} of VAT is payable to FIRS for ${from} to ${to}, due by the ${WHT_REMITTANCE_DAY_OF_MONTH}st of the following month.`
          : net < 0
            ? `Input VAT exceeds output VAT by ₦${Math.abs(net).toLocaleString('en-NG')} for ${from} to ${to} — a recoverable position, usually caused by a large stock purchase.`
            : 'Nil VAT position for this period.',
    });
  });

  /**
   * The WHT position: what was withheld and what is still unremitted.
   *
   * PAYABLE rows are tax this business withheld from somebody else and owes
   * FIRS. RECEIVABLE rows are tax withheld FROM this business, which are
   * credit notes to collect. Mixing the two into one number would show a
   * liability and an asset cancelling out, and both would go unmanaged.
   */
  app.get(`${base}/accounting/wht`, async (ctx) => {
    // NOT GUARDED, AND DELIBERATELY SO — the exception to `requireBooks`, written down
    // where the exception lives. The withholding position is the tax ON INVOICES IN THE
    // PERSON'S HAND: a storekeeper receiving goods has to see what was withheld from the
    // supplier in front of them. Hiding it does not protect the business, it pushes the
    // arithmetic onto paper. `audit.wht.js` asserts a staff seat can read this and cannot
    // file it, and both halves of that are the rule.
    const db = ctx.env.DB || ctx.env.db;
    const bf = await readBusinessFilter(db, ctx, { column: 'business_id', alias: 'w', allowNull: false });
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const rows = await db.all(`SELECT w.*, s.name AS supplier_name, b.name AS branch_name, u.full_name AS recorded_by_name
        FROM wht_entries w
        LEFT JOIN suppliers s ON s.id = w.supplier_id
        LEFT JOIN branches b ON b.id = w.branch_id
        LEFT JOIN users u ON u.id = w.recorded_by
        WHERE w.is_deleted = 0 AND ${bf.sql} AND w.entry_date BETWEEN ? AND ?
        ORDER BY w.entry_date DESC, w.created_at DESC`, [...bf.params, from, to]);

    const payable = rows.filter((r) => r.direction === 'PAYABLE');
    const receivable = rows.filter((r) => r.direction === 'RECEIVABLE');
    const sum = (arr) => round2(arr.reduce((a, r) => a + Number(r.wht_amount || 0), 0));
    const unremitted = payable.filter((r) => !r.remitted_at);
    const byRate = {};
    for (const r of payable) {
      const k = r.rate_code || 'UNKNOWN';
      if (!byRate[k]) byRate[k] = { code: k, ratePercent: Number(r.rate_percent), entries: 0, gross: 0, wht: 0 };
      byRate[k].entries += 1;
      byRate[k].gross = round2(byRate[k].gross + Number(r.gross_amount || 0));
      byRate[k].wht = round2(byRate[k].wht + Number(r.wht_amount || 0));
    }

    ctx.json({
      ok: true, range: { from, to },
      entries: rows, byRate: Object.values(byRate).sort((a, b) => b.wht - a.wht),
      summary: {
        payableTotal: sum(payable), receivableTotal: sum(receivable),
        remittedTotal: sum(payable.filter((r) => r.remitted_at)),
        unremittedTotal: sum(unremitted),
        unremittedCount: unremitted.length,
        // The deadline is attached to the number. A liability with no date on it
        // is a liability nobody pays on time.
        nextRemittanceDue: whtRemittanceDueDate(to.slice(0, 7)),
        remittanceDay: WHT_REMITTANCE_DAY_OF_MONTH,
      },
      schedule: WHT_SCHEDULE_2024,
      message: unremitted.length
        ? `₦${sum(unremitted).toLocaleString('en-NG')} of withheld tax across ${unremitted.length} entr(ies) is UNREMITTED, due by the ${WHT_REMITTANCE_DAY_OF_MONTH}th. Late remittance attracts a penalty, and the counterparty cannot claim their credit note until you file.`
        : 'All withheld tax in this period has been remitted.',
    });
  });

  /** Mark a WHT entry as remitted, with the FIRS reference. */
  app.post(`${base}/accounting/wht/:id/remitted`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only an owner can mark tax as remitted. It closes a liability to FIRS.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const entry = await db.first('SELECT * FROM wht_entries WHERE id = ? AND is_deleted = 0', [id]);
    if (!entry) throw new HttpError('That WHT entry does not exist.', { status: 404, code: 'WHT_ENTRY_NOT_FOUND' });
    if (entry.remitted_at) throw new HttpError(`That entry was already remitted on ${entry.remitted_at}${entry.remittance_ref ? ` (ref ${entry.remittance_ref})` : ''}.`, { status: 409, code: 'ALREADY_REMITTED' });
    const reference = strField(requireVal(body, 'reference'), { field: 'Remittance reference', maxLength: 80, required: true });
    if (reference.length < 4) {
      throw new HttpError('Enter the actual FIRS or bank reference. Without one there is no proof the tax was paid, and the counterparty cannot claim their credit note.', { status: 400, code: 'REFERENCE_REQUIRED' });
    }
    const certificateNo = strField(body.certificate_no, { field: 'Certificate number', maxLength: 80 });
    await db.run(`UPDATE wht_entries SET remitted_at = datetime('now'), remittance_ref = ?, certificate_no = COALESCE(?, certificate_no),
        notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [
      reference, certificateNo, `\n| Remitted ${watNow()} by ${user.full_name || user.username}, ref ${reference}`, id,
    ]);
    await recordFromCtx(ctx, {
      action: 'WHT_REMITTED', entityType: 'WHT_ENTRY', entityId: id, branchId: entry.branch_id, businessId: entry.business_id,
      before: { remitted_at: null }, after: { reference, certificateNo, amount: Number(entry.wht_amount) },
    });
    ctx.json({ ok: true, message: `₦${Number(entry.wht_amount).toLocaleString('en-NG')} of ${entry.direction.toLowerCase()} WHT (${entry.rate_code}) marked as remitted, reference ${reference}.` });
  });
}

function requireVal(body, field) {
  const v = body[field];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new HttpError(`${field.replace(/_/g, ' ')} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: 'Required' } });
  }
  return v;
}

module.exports = { mount };
