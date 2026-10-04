// =====================================================================
// StockRidge — EXPENSES
// =====================================================================
// Petty cash is where a branch P&L goes to die. Not through fraud, usually,
// but through a hundred ₦2,000 items nobody recorded and nobody questioned —
// so the branch looks profitable and the owner cannot see where the money
// went.
//
// THE APPROVAL WORKFLOW IS THE POINT. An expense nobody has to approve is an
// expense nobody can question. So:
//   * staff may SUBMIT, managers/owners APPROVE
//   * an unapproved expense is PENDING_APPROVAL and hits no report
//   * a rejected expense keeps its record and its reason
//   * the owner controls whether managers may approve at all
//     (managers_can_approve_expenses)
//
// A receipt photo is optional but the requirement is per-category
// (expense_categories.requires_receipt), because "generator diesel" happens
// daily at a roadside pump that issues no receipt, while "rent" always has one
// and should never be posted without it.
//
// WHT on expenses: rent, professional fees, agency commission and contracts
// all attract deduction at source. The gross is expensed, the deduction is a
// liability to FIRS and the net is what leaves the bank — see lib/wht.js.
// =====================================================================

const { newId, watNowIso, watDate } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const V = require('../../shared/validation');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { getUnitSettings, assertSubscribed, assertManagerPermission, staffAllowance } = require('../lib/planLimits');
const { capabilitiesOf } = require('../lib/capabilities');
const whtLib = require('../lib/wht');
const vatLib = require('../lib/vat');

const METHODS = ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'USSD', 'MOBILE_MONEY', 'CHEQUE', 'SAFE', 'CREDIT', 'OTHER'];
const STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'POSTED', 'CANCELLED'];

const DEFAULT_CATEGORIES = Object.freeze([
  { code: 'RENT_RATES', label: 'Rent & rates', gl: '6000', requires_receipt: 1 },
  { code: 'SALARIES', label: 'Salaries, wages & allowances', gl: '6010', requires_receipt: 0 },
  { code: 'POWER_FUEL', label: 'Power, fuel & generator', gl: '6020', requires_receipt: 0 },
  { code: 'UTILITIES', label: 'Water & utilities', gl: '6020', requires_receipt: 0 },
  { code: 'TRANSPORT', label: 'Transport & logistics', gl: '6030', requires_receipt: 0 },
  { code: 'REPAIRS', label: 'Repairs & maintenance', gl: '6040', requires_receipt: 1 },
  { code: 'MARKETING', label: 'Marketing & advertising', gl: '6050', requires_receipt: 1 },
  { code: 'PROFESSIONAL', label: 'Professional, legal & accounting', gl: '6060', requires_receipt: 1, wht: 'PROFESSIONAL_FEES' },
  { code: 'LICENCES', label: 'Licences, permits & regulatory', gl: '6070', requires_receipt: 1 },
  { code: 'BANK_CHARGES', label: 'Bank & POS charges', gl: '6080', requires_receipt: 0 },
  { code: 'TELECOMS', label: 'Telephone & internet', gl: '6090', requires_receipt: 0 },
  { code: 'INSURANCE', label: 'Insurance', gl: '6100', requires_receipt: 1 },
  { code: 'SECURITY', label: 'Security', gl: '6110', requires_receipt: 0 },
  { code: 'SUPPLIES', label: 'Office & shop supplies', gl: '6120', requires_receipt: 0 },
  { code: 'TRAVEL', label: 'Travel & entertainment', gl: '6130', requires_receipt: 1 },
  { code: 'DELIVERY_COST', label: 'Delivery & installation cost', gl: '5100', requires_receipt: 0 },
  { code: 'SUNDRY', label: 'Sundry', gl: '6950', requires_receipt: 0 },
]);

async function seedCategories(db, businessUnitId) {
  const existing = await db.prepare('SELECT code FROM expense_categories WHERE business_unit_id = ?').bind(businessUnitId).all();
  const have = new Set(existing.results.map((r) => r.code));
  const ts = watNowIso();
  const statements = [];
  for (const c of DEFAULT_CATEGORIES) {
    if (have.has(c.code)) continue;
    let glAccountId = null;
    if (c.gl) {
      const acc = await db.prepare('SELECT id FROM gl_accounts WHERE business_unit_id = ? AND code = ? AND is_deleted = 0').bind(businessUnitId, c.gl).first();
      glAccountId = acc ? acc.id : null;
    }
    statements.push(db.prepare(`
      INSERT INTO expense_categories (id, business_unit_id, code, label, gl_account_id, is_operational, requires_receipt, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?, 1, ?, 1,?,?)
    `).bind(newId(), businessUnitId, c.code, c.label, glAccountId, c.requires_receipt ? 1 : 0, ts, ts));
  }
  if (statements.length) await db.batch(statements);
  return { created: statements.length };
}

async function listCategories(db, { businessUnitId, includeInactive = false }) {
  const rows = await db.prepare(`
    SELECT ec.*, a.code AS gl_account_code, a.name AS gl_account_name,
           (SELECT COUNT(*) FROM expenses e WHERE e.category_id = ec.id AND e.is_deleted = 0) AS expense_count,
           (SELECT COALESCE(SUM(e.amount),0) FROM expenses e WHERE e.category_id = ec.id AND e.is_deleted = 0
              AND date(e.expense_date) >= date('now','+1 hour','start of year')) AS ytd_amount
    FROM expense_categories ec
    LEFT JOIN gl_accounts a ON a.id = ec.gl_account_id
    WHERE ec.business_unit_id = ? AND ec.is_deleted = 0 ${includeInactive ? '' : 'AND ec.is_active = 1'}
    ORDER BY ec.label
  `).bind(businessUnitId).all();
  return rows.results.map((r) => ({ ...r, ytd_amount: round2(r.ytd_amount) }));
}

async function create(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'record an expense' });

  const branchId = input.branch_id || ctx.user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch this expense belongs to.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, branchId);

  const description = V.required(input.description, { field: 'Description', max: V.LIMITS.MEDIUM_TEXT });
  if (description && description.error) throw new HttpError(400, description.error, 'VALIDATION_FAILED');

  const amount = V.money(input.amount, { field: 'Amount', min: 0.01, max: 500_000_000 });
  if (amount && amount.error) throw new HttpError(400, amount.error, 'VALIDATION_FAILED');

  const method = V.oneOf(input.payment_method || 'CASH', METHODS, { field: 'Payment method' });
  if (method && method.error) throw new HttpError(400, method.error, 'VALIDATION_FAILED');

  const expenseDate = V.isoDate(input.expense_date || watDate(), { field: 'Expense date', optional: false });
  if (expenseDate && expenseDate.error) throw new HttpError(400, expenseDate.error, 'VALIDATION_FAILED');
  // A future-dated expense is refused: it would sit in a period that has not
  // happened and quietly distort the month it lands in.
  if (expenseDate > watDate()) throw new HttpError(400, 'An expense cannot be dated in the future.', 'EXPENSE_DATE_FUTURE');
  // A very old expense is allowed but flagged — back-dating into a closed
  // period is legitimate (a bill that arrived late) and must not be blocked,
  // but the owner should see it happened.
  const daysOld = require('../../shared/ids').daysBetween(expenseDate, watDate());

  let category = null;
  if (input.category_id) {
    category = await db.prepare('SELECT * FROM expense_categories WHERE id = ? AND business_unit_id = ? AND is_deleted = 0').bind(input.category_id, businessUnitId).first();
    if (!category) throw new HttpError(404, 'That expense category was not found for this business.', 'CATEGORY_NOT_FOUND');
    if (category.requires_receipt && !input.receipt_no && !input.receipt_data_url) {
      throw new HttpError(400,
        `${category.label} requires a receipt. Enter a receipt number or attach a photo — this category is the one most often queried by an auditor, and an unreceipted entry is indistinguishable from an invented one.`,
        'EXPENSE_RECEIPT_REQUIRED');
    }
  }

  const paidFromSafe = method === 'SAFE' ? 1 : (input.paid_from_safe ? 1 : 0);
  const tillSessionId = input.till_session_id || null;

  // WHT. Only when the business has it enabled and a rate was chosen.
  let whtAmount = 0;
  let whtCode = null;
  let netAmount = amount;
  let vatAmount = 0;
  if (input.wht_rate_code && settings.wht_enabled !== 0) {
    const deduction = await whtLib.resolveDeduction(db, {
      grossAmount: amount, rateCode: input.wht_rate_code, direction: 'PAYABLE',
      counterpartyType: input.counterparty_type || null, businessUnitId,
    });
    if (deduction) {
      whtAmount = deduction.wht;
      whtCode = deduction.rateCode;
      netAmount = deduction.net;
    }
  }
  if (vatLib.isVatEnabled(settings) && vatLib.isVatInclusive(settings) && input.includes_vat !== false) {
    vatAmount = vatLib.extractVat(amount, settings.vat_rate_percent).vat;
  }

  // Approval. The owner decides whether managers may approve; a cashier never
  // approves their own submission. Self-approval is refused even for a manager
  // above the configured limit, because "the person who spent it decided it was
  // fine" is not a control.
  const allowance = await staffAllowance(db, businessUnitId, ctx.user);
  let status = 'PENDING_APPROVAL';
  let approvedBy = null;
  const role = String(ctx.user.role).toUpperCase();
  if (role === 'ADMIN' || role === 'OWNER') {
    status = 'POSTED';
    approvedBy = ctx.user.id;
  } else if (role === 'MANAGER' && allowance.can_approve_expenses) {
    status = 'POSTED';
    approvedBy = ctx.user.id;
  }

  // Paying from the safe at submission time is a stock movement of cash and
  // must respect the same narrow staff allowance as any other safe draw.
  let safeLedgerId = null;
  if (paidFromSafe) {
    if (role === 'STAFF' && Number.isFinite(allowance.safe_spend_max) && amount > allowance.safe_spend_max) {
      throw new HttpError(403,
        `Your safe-spend limit is ₦${allowance.safe_spend_max.toLocaleString('en-NG')} per transaction and this expense is ₦${amount.toLocaleString('en-NG')}. A manager must pay it.`,
        'SAFE_OVER_STAFF_LIMIT');
    }
    const tillService = require('./tillService');
    const balance = await tillService.safeBalance(db, { branchId });
    if (balance < amount) {
      throw new HttpError(409, `The branch safe holds ₦${balance.toLocaleString('en-NG')}, not enough for a ₦${amount.toLocaleString('en-NG')} expense.`, 'SAFE_INSUFFICIENT_BALANCE');
    }
  }

  const ts = watNowIso();
  const id = newId();
  const statements = [];

  statements.push(db.prepare(`
    INSERT INTO expenses (
      id, business_unit_id, branch_id, category_id, expense_date, description, amount, payment_method,
      till_session_id, paid_from_safe, safe_ledger_id, supplier_id, reference, receipt_no, receipt_data_url,
      status, requested_by, approved_by, approved_at, wht_rate_code, wht_amount, net_amount, vat_amount,
      device_id, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, businessUnitId, branchId, category ? category.id : null, expenseDate, description, amount, method,
    tillSessionId, paidFromSafe, null,
    input.supplier_id || null,
    input.reference ? String(input.reference).slice(0, 120) : null,
    input.receipt_no ? String(input.receipt_no).slice(0, 120) : null,
    input.receipt_data_url ? String(input.receipt_data_url) : null,
    status, ctx.user.id, approvedBy, approvedBy ? ts : null,
    whtCode, whtAmount, netAmount, vatAmount,
    ctx.deviceId || null, input.notes ? String(input.notes).slice(0, V.LIMITS.NOTES) : null, ts, ts
  ));

  if (paidFromSafe && status === 'POSTED') {
    safeLedgerId = newId();
    const tillService = require('./tillService');
    const balance = await tillService.safeBalance(db, { branchId });
    statements.push(db.prepare(`
      INSERT INTO branch_safe_ledger (
        id, business_unit_id, branch_id, entry_type, amount, balance_after, source_type, source_id,
        reference, reason, approved_by, performed_by, occurred_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?, 'EXPENSE', ?,?,?,?, ?,?,?,?)
    `).bind(safeLedgerId, businessUnitId, branchId, 'EXPENSE_PAYMENT', -amount, round2(balance - amount),
      id, input.reference || null, description, approvedBy, ctx.user.id, ts, ts, ts));
    statements.push(db.prepare('UPDATE expenses SET safe_ledger_id = ? WHERE id = ?').bind(safeLedgerId, id));
  }

  // Cash out of an open till, so the drawer agrees at close.
  if (!paidFromSafe && method === 'CASH' && status === 'POSTED') {
    const till = tillSessionId
      ? await db.prepare(`SELECT * FROM till_sessions WHERE id = ? AND status = 'OPEN'`).bind(tillSessionId).first()
      : await db.prepare(`SELECT * FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0`).bind(branchId).first();
    if (till) {
      statements.push(db.prepare(`
        UPDATE till_sessions SET expected_cash = MAX(0, expected_cash - ?), expected_total = MAX(0, expected_total - ?), updated_at = ? WHERE id = ?
      `).bind(amount, amount, ts, till.id));
      statements.push(db.prepare('UPDATE expenses SET till_session_id = ? WHERE id = ?').bind(till.id, id));
    }
  }

  await db.batch(statements);

  if (status === 'POSTED') {
    await postToLedger(db, ctx, { expenseId: id, businessUnitId, branchId, settings, category });
  }

  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: role,
    action: status === 'POSTED' ? 'EXPENSE_POSTED' : 'EXPENSE_SUBMITTED',
    entityType: 'EXPENSE', entityId: id, amount,
    after: { description, category: category ? category.label : null, status, wht_amount: whtAmount, paid_from_safe: paidFromSafe, days_old: daysOld },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id, status, amount, net_amount: netAmount, wht_amount: whtAmount, vat_amount: vatAmount,
    expense_date: expenseDate, category: category ? category.label : null,
    needs_approval: status === 'PENDING_APPROVAL',
    advisory: status === 'PENDING_APPROVAL'
      ? 'Submitted and waiting for a manager to approve. It will not appear in any report until it is approved.'
      : (daysOld > 30
        ? `This expense is back-dated ${daysOld} days. That is allowed — bills arrive late — but it lands in ${expenseDate.slice(0, 7)}, so that month's profit will move.`
        : null),
  };
}

async function postToLedger(db, ctx, { expenseId, businessUnitId, branchId, settings, category }) {
  if (!capabilitiesOf(settings).general_ledger || settings.gl_module_enabled === 0) return null;
  const expense = await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(expenseId).first();
  if (!expense) return null;
  const glService = require('./glService');
  await glService.ensureChart(db, businessUnitId);
  let accountCode = '6950';
  if (category && category.gl_account_id) {
    const acc = await db.prepare('SELECT code FROM gl_accounts WHERE id = ?').bind(category.gl_account_id).first();
    if (acc) accountCode = acc.code;
  }
  try {
    return await glService.postExpense(db, { businessUnitId, branchId, expense, categoryAccountCode: accountCode, userId: ctx.user.id, settings });
  } catch (e) {
    console.error('[expenseService] GL posting failed for expense', expenseId, e && e.message);
    return null;
  }
}

async function decide(db, ctx, { expenseId, decision, reason = null }) {
  const e = await db.prepare('SELECT * FROM expenses WHERE id = ? AND is_deleted = 0').bind(expenseId).first();
  if (!e) throw new HttpError(404, 'That expense was not found.', 'EXPENSE_NOT_FOUND');
  assertBranchAccess(ctx.user, e.branch_id);
  if (e.status !== 'PENDING_APPROVAL') throw new HttpError(409, `That expense is ${e.status}, not awaiting approval.`, 'EXPENSE_NOT_PENDING');

  const d = String(decision).toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(d)) throw new HttpError(400, 'Decision must be APPROVED or REJECTED.', 'EXPENSE_DECISION_INVALID');

  // SELF-APPROVAL IS REFUSED. The person who spent the money cannot be the
  // person who decides it was fine — that is not a control, it is a formality.
  if (e.requested_by === ctx.user.id) {
    throw new HttpError(403,
      'You submitted this expense, so you cannot approve it. Another manager or the owner must — otherwise the approval step records nothing more than that you agreed with yourself.',
      'EXPENSE_SELF_APPROVAL');
  }
  await assertManagerPermission(db, ctx.businessUnitId, ctx.user, 'managers_can_approve_expenses', { action: 'approve an expense' });

  if (d === 'REJECTED' && (!reason || String(reason).trim().length < 5)) {
    throw new HttpError(400, 'Rejecting an expense needs a written reason of at least 5 characters, so the person who submitted it knows what to fix.', 'EXPENSE_REJECTION_REASON_REQUIRED');
  }

  const ts = watNowIso();
  const settings = ctx.businessUnit || await getUnitSettings(db, ctx.businessUnitId);
  const statements = [
    db.prepare(`
      UPDATE expenses SET status = ?, approved_by = ?, approved_at = ?, rejection_reason = ?, updated_at = ? WHERE id = ?
    `).bind(d === 'APPROVED' ? 'POSTED' : 'REJECTED', ctx.user.id, ts,
      d === 'REJECTED' ? String(reason).slice(0, 500) : null, ts, expenseId),
  ];

  // Cash effects happen at APPROVAL, not at submission — an unapproved
  // expense must not have moved the drawer.
  if (d === 'APPROVED') {
    if (e.paid_from_safe) {
      const tillService = require('./tillService');
      const balance = await tillService.safeBalance(db, { branchId: e.branch_id });
      const ledgerId = newId();
      statements.push(db.prepare(`
        INSERT INTO branch_safe_ledger (
          id, business_unit_id, branch_id, entry_type, amount, balance_after, source_type, source_id,
          reference, reason, approved_by, performed_by, occurred_at, created_at, updated_at
        ) VALUES (?,?,?,?,?,?, 'EXPENSE', ?,?,?,?, ?,?,?,?)
      `).bind(ledgerId, e.business_unit_id, e.branch_id, 'EXPENSE_PAYMENT', -Number(e.amount), round2(balance - Number(e.amount)),
        expenseId, e.reference || null, e.description, ctx.user.id, e.requested_by, ts, ts, ts));
      statements.push(db.prepare('UPDATE expenses SET safe_ledger_id = ? WHERE id = ?').bind(ledgerId, expenseId));
    } else if (e.payment_method === 'CASH' && e.till_session_id) {
      statements.push(db.prepare(`
        UPDATE till_sessions SET expected_cash = MAX(0, expected_cash - ?), expected_total = MAX(0, expected_total - ?), updated_at = ? WHERE id = ?
      `).bind(Number(e.amount), Number(e.amount), ts, e.till_session_id));
    }
  }
  await db.batch(statements);

  if (d === 'APPROVED') {
    const category = e.category_id ? await db.prepare('SELECT * FROM expense_categories WHERE id = ?').bind(e.category_id).first() : null;
    await postToLedger(db, ctx, { expenseId, businessUnitId: e.business_unit_id, branchId: e.branch_id, settings, category });
  }

  await writeAudit(db, {
    businessUnitId: e.business_unit_id, branchId: e.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: d === 'APPROVED' ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
    entityType: 'EXPENSE', entityId: expenseId, amount: Number(e.amount),
    reason: reason ? String(reason).slice(0, 500) : null,
    before: { status: e.status }, after: { status: d === 'APPROVED' ? 'POSTED' : 'REJECTED' },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: expenseId, status: d === 'APPROVED' ? 'POSTED' : 'REJECTED' };
}

async function list(db, { businessUnitId, branchId = null, categoryId = null, status = null, from = null, to = null, search = null, requestedBy = null, limit = 50, offset = 0 }) {
  const where = ['e.is_deleted = 0', 'e.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('e.branch_id = ?'); params.push(branchId); }
  if (categoryId) { where.push('e.category_id = ?'); params.push(categoryId); }
  if (status) { where.push('e.status = ?'); params.push(String(status).toUpperCase()); }
  if (requestedBy) { where.push('e.requested_by = ?'); params.push(requestedBy); }
  if (from) { where.push('e.expense_date >= ?'); params.push(String(from).slice(0, 10)); }
  if (to) { where.push('e.expense_date <= ?'); params.push(String(to).slice(0, 10)); }
  if (search) {
    const like = `%${String(search).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(e.description LIKE ? ESCAPE '\\' OR e.reference LIKE ? ESCAPE '\\' OR e.receipt_no LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  const rows = await db.prepare(`
    SELECT e.*, ec.label AS category_label, b.name AS branch_name, s.name AS supplier_name,
           u.full_name AS requested_by_name, a.full_name AS approved_by_name
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    JOIN branches b ON b.id = e.branch_id
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    LEFT JOIN users u ON u.id = e.requested_by
    LEFT JOIN users a ON a.id = e.approved_by
    WHERE ${where.join(' AND ')}
    ORDER BY CASE e.status WHEN 'PENDING_APPROVAL' THEN 0 ELSE 1 END, e.expense_date DESC, e.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();

  const summary = await db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN e.status IN ('APPROVED','POSTED') THEN e.amount ELSE 0 END),0) AS approved_total,
           COALESCE(SUM(CASE WHEN e.status = 'PENDING_APPROVAL' THEN e.amount ELSE 0 END),0) AS pending_total,
           COUNT(CASE WHEN e.status = 'PENDING_APPROVAL' THEN 1 END) AS pending_count
    FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id
    WHERE ${where.join(' AND ')}
  `).bind(...params).first();

  return {
    results: rows.results,
    summary: summary ? { ...summary, approved_total: round2(summary.approved_total), pending_total: round2(summary.pending_total) } : null,
  };
}

// Spend by category and branch. The report that turns "where did the money
// go?" into a specific answer, and the one that finds the branch spending
// three times its peers on fuel.
async function summaryReport(db, { businessUnitId, branchId = null, startDate, endDate }) {
  const where = ['e.is_deleted = 0', "e.status IN ('APPROVED','POSTED')", 'e.business_unit_id = ?', 'e.expense_date BETWEEN ? AND ?'];
  const params = [businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10)];
  if (branchId) { where.push('e.branch_id = ?'); params.push(branchId); }

  const [byCategory, byBranch, byMonth, total] = await Promise.all([
    db.prepare(`
      SELECT COALESCE(ec.label, 'Uncategorised') AS category, e.category_id, COUNT(*) AS entries,
             COALESCE(SUM(e.amount),0) AS amount
      FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
      WHERE ${where.join(' AND ')} GROUP BY COALESCE(ec.label,'Uncategorised'), e.category_id ORDER BY amount DESC
    `).bind(...params).all(),
    db.prepare(`
      SELECT b.name AS branch_name, e.branch_id, COUNT(*) AS entries, COALESCE(SUM(e.amount),0) AS amount
      FROM expenses e JOIN branches b ON b.id = e.branch_id
      WHERE ${where.join(' AND ')} GROUP BY b.name, e.branch_id ORDER BY amount DESC
    `).bind(...params).all(),
    db.prepare(`
      SELECT substr(e.expense_date,1,7) AS month, COALESCE(SUM(e.amount),0) AS amount, COUNT(*) AS entries
      FROM expenses e WHERE ${where.join(' AND ')} GROUP BY substr(e.expense_date,1,7) ORDER BY month
    `).bind(...params).all(),
    db.prepare(`SELECT COALESCE(SUM(e.amount),0) AS amount, COUNT(*) AS entries,
                       COALESCE(SUM(e.wht_amount),0) AS wht, COALESCE(SUM(e.vat_amount),0) AS vat
                FROM expenses e WHERE ${where.join(' AND ')}`).bind(...params).first(),
  ]);

  // Revenue for the same period, so expenses can be read as a percentage of
  // turnover. An absolute expense figure is meaningless without it: ₦400,000
  // of diesel is a rounding error for one branch and a crisis for another.
  const revParams = [businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10)];
  let revWhere = "s.is_deleted = 0 AND s.status <> 'VOIDED' AND s.business_unit_id = ? AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?";
  if (branchId) { revWhere += ' AND s.branch_id = ?'; revParams.push(branchId); }
  const revenue = await db.prepare(`SELECT COALESCE(SUM(s.total),0) AS revenue FROM sales s WHERE ${revWhere}`).bind(...revParams).first();

  const totalAmount = round2(Number(total.amount) || 0);
  const rev = round2(Number(revenue.revenue) || 0);

  return {
    period: { start: String(startDate).slice(0, 10), end: String(endDate).slice(0, 10) },
    total_expenses: totalAmount,
    entry_count: total.entries,
    wht_deducted: round2(Number(total.wht) || 0),
    input_vat: round2(Number(total.vat) || 0),
    revenue: rev,
    expense_percent_of_revenue: rev > 0 ? round2((totalAmount / rev) * 100) : null,
    by_category: byCategory.results.map((r) => ({ ...r, amount: round2(r.amount), share_percent: totalAmount > 0 ? round2((Number(r.amount) / totalAmount) * 100) : 0 })),
    by_branch: byBranch.results.map((r) => ({ ...r, amount: round2(r.amount), share_percent: totalAmount > 0 ? round2((Number(r.amount) / totalAmount) * 100) : 0 })),
    by_month: byMonth.results.map((r) => ({ ...r, amount: round2(r.amount) })),
    advisory: totalAmount > 0 && rev > 0 && (totalAmount / rev) > 0.25
      ? `Operating expenses are ${round2((totalAmount / rev) * 100)}% of turnover. Above roughly 25% a retailer is usually working for its landlord and its fuel supplier — the by-category breakdown shows which.`
      : null,
  };
}

module.exports = { METHODS, STATUSES, DEFAULT_CATEGORIES, seedCategories, listCategories, create, decide, list, summaryReport };
'use strict';
