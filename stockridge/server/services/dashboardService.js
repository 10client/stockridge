// =====================================================================
// StockRidge — DASHBOARD & REPORTS
// =====================================================================
// Every figure here is a WAT-day figure. `date(x, '+1 hour')` converts a
// stored UTC timestamp before bucketing. This is the fix PharmaRidge had to
// retrofit as migration 009 after finding that a sale made between 00:00 and
// 00:59 Lagos time landed in the PREVIOUS calendar day in every day-based
// report. Here it is the only way a date is ever taken, so the bug is designed
// out rather than patched.
//
// THE DASHBOARD IS ROLE-SHAPED, not one screen for everyone:
//   STAFF    today at this till — sales, cash expected, open holds, jobs due
//   MANAGER  this branch (or all branches for a General Manager) plus the
//            exceptions that need a decision: variances, flags, overdue plans
//   OWNER    the group: revenue, margin, cash position, debtor exposure,
//            shrinkage, plan usage
//   ADMIN    every business unit, subscription state, sync health, register
//            integrity
// A cashier who can see group profit learns nothing useful and the owner
// loses a negotiation; an owner who sees only till figures cannot run a
// business. The shape of the answer is a permission decision.
//
// EXCEPTIONS BEFORE METRICS. A dashboard of green numbers is a dashboard
// nobody opens twice. The first block on every manager screen is "things that
// need a decision today", because those are the only numbers that change
// behaviour.
// =====================================================================

const { round2, sumMoney } = require('../../shared/money');
const { watDate, watNowIso, daysBetween } = require('../../shared/ids');
const { HttpError } = require('../lib/http');
const { resolveScopedBranchId } = require('../lib/roles');
const { planSummary } = require('../lib/planLimits');

// ---------------------------------------------------------------------
// CORE PERIOD FIGURES
// ---------------------------------------------------------------------
async function periodFigures(db, { businessUnitId, branchId = null, startDate, endDate, compareStartDate = null, compareEndDate = null }) {
  const buildWhere = (bid) => {
    const where = ['s.is_deleted = 0', 's.business_unit_id = ?'];
    const params = [businessUnitId];
    if (bid) { where.push('s.branch_id = ?'); params.push(bid); }
    where.push("date(s.occurred_at,'+1 hour') BETWEEN ? AND ?");
    params.push(String(startDate).slice(0, 10), String(endDate).slice(0, 10));
    return { clause: where.join(' AND '), params };
  };

  const w = buildWhere(branchId);
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS sale_count,
      SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS void_count,
      COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END),0) AS revenue,
      COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.vat_amount ELSE 0 END),0) AS vat,
      COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.discount_amount ELSE 0 END),0) AS discounts,
      COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.balance_due ELSE 0 END),0) AS credit_extended,
      COALESCE(AVG(CASE WHEN s.status <> 'VOIDED' THEN s.total END),0) AS average_sale,
      COUNT(DISTINCT s.customer_id) AS distinct_customers,
      COUNT(DISTINCT date(s.occurred_at,'+1 hour')) AS trading_days
    FROM sales s WHERE ${w.clause}
  `).bind(...w.params).first();

  const marginRow = await db.prepare(`
    SELECT COALESCE(SUM(si.gross_margin),0) AS margin, COALESCE(SUM(si.line_total),0) AS line_total,
           COALESCE(SUM(si.unit_cost * si.quantity_base),0) AS cogs
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE si.is_deleted = 0 AND ${w.clause} AND s.status <> 'VOIDED'
  `).bind(...w.params).first();

  const expenseRow = await db.prepare(`
    SELECT COALESCE(SUM(e.amount),0) AS expenses FROM expenses e
    WHERE e.is_deleted = 0 AND e.status IN ('APPROVED','POSTED') AND e.business_unit_id = ?
      ${branchId ? 'AND e.branch_id = ?' : ''}
      AND e.expense_date BETWEEN ? AND ?
  `).bind(businessUnitId, ...(branchId ? [branchId] : []), String(startDate).slice(0, 10), String(endDate).slice(0, 10)).first();

  const returnRow = await db.prepare(`
    SELECT COALESCE(SUM(sr.refund_amount),0) AS refunds, COUNT(*) AS return_count
    FROM sale_returns sr
    WHERE sr.is_deleted = 0 AND sr.status = 'COMPLETED' AND sr.business_unit_id = ?
      ${branchId ? 'AND sr.branch_id = ?' : ''}
      AND sr.processed_at BETWEEN ? AND ?
  `).bind(businessUnitId, ...(branchId ? [branchId] : []), `${String(startDate).slice(0, 10)} 00:00:00`, `${String(endDate).slice(0, 10)} 23:59:59`).first();

  const revenue = round2(Number(row.revenue) || 0);
  const margin = round2(Number(marginRow.margin) || 0);
  const expenses = round2(Number(expenseRow.expenses) || 0);
  const tradingDays = Number(row.trading_days) || 0;

  const figures = {
    period: { start: String(startDate).slice(0, 10), end: String(endDate).slice(0, 10), days: daysBetween(String(startDate).slice(0, 10), String(endDate).slice(0, 10)) + 1 },
    sale_count: row.sale_count || 0,
    void_count: row.void_count || 0,
    void_rate_percent: row.sale_count > 0 ? round2((Number(row.void_count) / Number(row.sale_count)) * 100) : 0,
    revenue,
    vat_collected: round2(Number(row.vat) || 0),
    discounts_given: round2(Number(row.discounts) || 0),
    discount_rate_percent: revenue > 0 ? round2((Number(row.discounts) / revenue) * 100) : 0,
    credit_extended: round2(Number(row.credit_extended) || 0),
    average_sale_value: round2(Number(row.average_sale) || 0),
    distinct_customers: row.distinct_customers || 0,
    trading_days: tradingDays,
    revenue_per_trading_day: tradingDays > 0 ? round2(revenue / tradingDays) : 0,
    cost_of_goods_sold: round2(Number(marginRow.cogs) || 0),
    gross_margin: margin,
    gross_margin_percent: revenue > 0 ? round2((margin / revenue) * 100) : 0,
    operating_expenses: expenses,
    net_profit: round2(margin - expenses),
    net_margin_percent: revenue > 0 ? round2(((margin - expenses) / revenue) * 100) : 0,
    refunds: round2(Number(returnRow.refunds) || 0),
    return_count: returnRow.return_count || 0,
  };

  if (compareStartDate && compareEndDate) {
    const prev = await periodFigures(db, { businessUnitId, branchId, startDate: compareStartDate, endDate: compareEndDate });
    figures.comparison = {
      period: prev.period,
      revenue: prev.revenue, gross_margin: prev.gross_margin, net_profit: prev.net_profit, sale_count: prev.sale_count,
      revenue_change_percent: prev.revenue > 0 ? round2(((revenue - prev.revenue) / prev.revenue) * 100) : null,
      margin_change_percent: prev.gross_margin > 0 ? round2(((margin - prev.gross_margin) / prev.gross_margin) * 100) : null,
      profit_change_percent: prev.net_profit !== 0 ? round2(((figures.net_profit - prev.net_profit) / Math.abs(prev.net_profit)) * 100) : null,
    };
  }
  return figures;
}

// ---------------------------------------------------------------------
// CASH POSITION
// ---------------------------------------------------------------------
async function cashPosition(db, { businessUnitId, branchId = null }) {
  const scope = branchId ? 'AND branch_id = ?' : '';
  const params = branchId ? [businessUnitId, branchId] : [businessUnitId];

  const [openTills, safe, changeOwed] = await Promise.all([
    db.prepare(`
      SELECT branch_id, b.name AS branch_name, session_no, opening_float, expected_cash, expected_total,
             expected_pos, expected_transfer, expected_mobile_money, expected_cheque, expected_credit,
             sale_count, void_count, opened_at, opened_by
      FROM till_sessions t JOIN branches b ON b.id = t.branch_id
      WHERE t.business_unit_id = ? AND t.status = 'OPEN' AND t.is_deleted = 0 ${scope}
    `).bind(...params).all(),
    db.prepare(`
      SELECT sl.branch_id, b.name AS branch_name, COALESCE(SUM(sl.amount),0) AS balance
      FROM branch_safe_ledger sl JOIN branches b ON b.id = sl.branch_id
      WHERE sl.business_unit_id = ? AND sl.is_deleted = 0 ${scope}
      GROUP BY sl.branch_id, b.name
    `).bind(...params).all(),
    db.prepare(`
      SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS claims FROM change_owed
      WHERE business_unit_id = ? AND status = 'OUTSTANDING' AND is_deleted = 0 ${scope}
    `).bind(...params).first(),
  ]);

  const tills = openTills.results.map((t) => ({ ...t, expected_cash: round2(t.expected_cash), expected_total: round2(t.expected_total), opening_float: round2(t.opening_float) }));
  const safes = safe.results.map((s) => ({ ...s, balance: round2(s.balance) }));

  return {
    tills,
    till_count: tills.length,
    expected_in_drawers: round2(sumMoney(tills.map((t) => round2(Number(t.opening_float) + Number(t.expected_cash))))),
    expected_electronic: round2(sumMoney(tills.map((t) => round2(Number(t.expected_pos) + Number(t.expected_transfer) + Number(t.expected_mobile_money) + Number(t.expected_cheque)))))
      ,
    safes,
    safe_total: round2(sumMoney(safes.map((s) => s.balance))),
    change_owed: { total: round2(Number(changeOwed.total) || 0), claims: changeOwed.claims || 0 },
    total_cash_on_premises: round2(sumMoney(tills.map((t) => round2(Number(t.opening_float) + Number(t.expected_cash)))) + sumMoney(safes.map((s) => s.balance))),
    // Credit extended on open tills is money that has NOT arrived. Showing it
    // inside "expected" without separating it is how a manager banks cash that
    // is not there.
    credit_on_open_tills: round2(sumMoney(tills.map((t) => round2(Number(t.expected_credit))))),
  };
}

// ---------------------------------------------------------------------
// EXCEPTIONS — the "needs a decision today" block
// ---------------------------------------------------------------------
async function exceptions(db, { businessUnitId, branchId = null, user = null }) {
  const scope = (col) => (branchId ? `AND ${col} = ?` : '');
  const p = branchId ? [businessUnitId, branchId] : [businessUnitId];

  const [lowStock, expiring, tillVariances, attendanceFlags, syncIssues, overduePlans, overdueDebts, pendingAdjustments, pendingExpenses, certExpiry, openDeliveries, serialAnomalies, glIntegrity] = await Promise.all([
    db.prepare(`
      SELECT * FROM v_low_stock_alerts WHERE business_unit_id = ? ${scope('branch_id')} LIMIT 25
    `).bind(...p).all(),
    db.prepare(`
      SELECT * FROM v_expiry_alerts WHERE business_unit_id = ? AND severity IN ('EXPIRED','CRITICAL','WARNING') ${scope('branch_id')}
      ORDER BY CASE severity WHEN 'EXPIRED' THEN 0 WHEN 'CRITICAL' THEN 1 ELSE 2 END, days_to_expiry LIMIT 25
    `).bind(...p).all(),
    db.prepare(`
      SELECT t.session_no, t.branch_id, b.name AS branch_name, t.closed_at, t.expected_cash, t.opening_float,
             t.counted_cash, t.variance, t.variance_reason, t.variance_approved_by, u.full_name AS closed_by_name
      FROM till_sessions t JOIN branches b ON b.id = t.branch_id LEFT JOIN users u ON u.id = t.closed_by
      WHERE t.business_unit_id = ? AND t.status = 'CLOSED' AND t.is_deleted = 0
        AND ABS(t.variance) > 50 ${scope('t.branch_id')}
        AND date(t.closed_at,'+1 hour') >= date('now','+1 hour','-14 days')
      ORDER BY ABS(t.variance) DESC LIMIT 15
    `).bind(...p).all(),
    db.prepare(`
      SELECT sa.id, sa.work_date, sa.in_location_status, sa.in_distance_meters, sa.needs_review, sa.is_late,
             u.full_name AS user_name, b.name AS branch_name
      FROM staff_attendance sa JOIN users u ON u.id = sa.user_id JOIN branches b ON b.id = sa.branch_id
      WHERE sa.business_unit_id = ? AND sa.needs_review = 1 AND sa.is_deleted = 0 AND sa.review_status IS NULL ${scope('sa.branch_id')}
      ORDER BY sa.clock_in_at DESC LIMIT 15
    `).bind(...p).all(),
    db.prepare(`
      SELECT * FROM v_branch_sync_overview WHERE business_unit_id = ? AND sync_health <> 'HEALTHY' ${scope('branch_id')}
    `).bind(...p).all(),
    db.prepare(`
      SELECT COUNT(*) AS plans, COALESCE(SUM(outstanding),0) AS value
      FROM v_plan_installments_due
      WHERE business_unit_id = ? AND ageing = 'OVERDUE' ${scope('branch_id')}
    `).bind(...p).first(),
    db.prepare(`
      SELECT COUNT(*) AS customers, COALESCE(SUM(balance),0) AS value, COALESCE(SUM(overdue_balance),0) AS overdue
      FROM v_debtor_balances WHERE business_unit_id = ? AND overdue_balance > 0
    `).bind(businessUnitId).first(),
    db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(a.value),0) AS value
      FROM stock_adjustments a WHERE a.business_unit_id = ? AND a.status = 'PENDING_APPROVAL' AND a.is_deleted = 0 ${scope('a.branch_id')}
    `).bind(...p).first(),
    db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(e.amount),0) AS value
      FROM expenses e WHERE e.business_unit_id = ? AND e.status = 'PENDING_APPROVAL' AND e.is_deleted = 0 ${scope('e.branch_id')}
    `).bind(...p).first(),
    db.prepare(`
      SELECT * FROM v_certificate_expiry_alerts WHERE business_unit_id = ? AND severity IN ('EXPIRED','CRITICAL','WARNING') ${scope('branch_id')}
      ORDER BY days_to_expiry LIMIT 15
    `).bind(...p).all(),
    db.prepare(`
      SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN scheduled_date < date('now','+1 hour') AND status IN ('SCHEDULED','ASSIGNED') THEN 1 ELSE 0 END) AS overdue
      FROM delivery_jobs WHERE business_unit_id = ? AND is_deleted = 0 AND status NOT IN ('COMPLETED','CANCELLED') ${scope('branch_id')}
    `).bind(...p).first(),
    // A serial marked IN_STOCK at a branch it was never received or
    // transferred into. The strongest single theft signal available in an
    // electronics business, and it only works because transfers are the only
    // way a serial changes branch.
    db.prepare(`
      SELECT COUNT(*) AS n FROM product_serials ps
      WHERE ps.business_unit_id = ? AND ps.is_deleted = 0 AND ps.status = 'IN_STOCK'
        AND NOT EXISTS (
          SELECT 1 FROM stock_movements m
          WHERE m.serial_id = ps.id AND m.branch_id = ps.branch_id AND m.movement_type IN ('PURCHASE_RECEIPT','TRANSFER_IN','ADJUSTMENT_FOUND','STOCKTAKE_VARIANCE')
        )
        AND NOT EXISTS (SELECT 1 FROM purchase_order_receipts r WHERE r.stock_batch_id = ps.stock_batch_id AND r.branch_id = ps.branch_id)
    `).bind(businessUnitId).first(),
    (async () => {
      try { return await require('./glService').integrityCheck(db, { businessUnitId }); } catch (_) { return null; }
    })(),
  ]);

  const items = [];
  const push = (severity, key, label, count, detail, action) => {
    if (!count) return;
    items.push({ severity, key, label, count, detail, action });
  };

  push('HIGH', 'serial_anomaly', 'Serialised stock with no receipt trail', Number(serialAnomalies.n) || 0,
    'Items marked in stock at a branch they were never received or transferred into.', '/serials?anomalies=1');
  push('HIGH', 'gl_integrity', 'Accounting integrity failures', glIntegrity && !glIntegrity.all_ok ? glIntegrity.checks.filter((c) => !c.ok).length : 0,
    glIntegrity ? glIntegrity.checks.filter((c) => !c.ok).map((c) => c.detail).join(' · ') : '', '/accounting?tab=integrity');
  push('HIGH', 'till_variance', 'Till variances above ₦50 in the last 14 days', tillVariances.results.length,
    tillVariances.results.length ? `Largest: ₦${round2(Math.max(...tillVariances.results.map((t) => Math.abs(Number(t.variance))))).toLocaleString('en-NG')} at ${tillVariances.results[0].branch_name}` : '', '/till?tab=variances');
  push('HIGH', 'expired_stock', 'Expired stock still on the shelf', expiring.results.filter((r) => r.severity === 'EXPIRED').length,
    'Must be quarantined or written off — it is unsellable and it is being counted in stock value.', '/stock?filter=expiry');
  push('MEDIUM', 'overdue_plans', 'Instalment plans in arrears', Number(overduePlans.plans) || 0,
    overduePlans.plans ? `₦${round2(Number(overduePlans.value)).toLocaleString('en-NG')} overdue. Call today — arrears at 7 days recover at several times the rate of arrears at 60.` : '', '/plans?filter=overdue');
  push('MEDIUM', 'overdue_debts', 'Customers over their payment terms', Number(overdueDebts.customers) || 0,
    overdueDebts.customers ? `₦${round2(Number(overdueDebts.overdue)).toLocaleString('en-NG')} overdue of ₦${round2(Number(overdueDebts.value)).toLocaleString('en-NG')} total owed.` : '', '/customers?filter=overdue');
  push('MEDIUM', 'low_stock', 'Products at or below reorder level', lowStock.results.length,
    lowStock.results.length ? `${lowStock.results[0].product_name} and ${lowStock.results.length - 1} more.` : '', '/stock?filter=reorder');
  push('MEDIUM', 'expiry_soon', 'Stock expiring within 30 days', expiring.results.filter((r) => r.severity !== 'EXPIRED').length,
    'Sell it down, return it to the supplier, or plan the write-off before it becomes the row above.', '/stock?filter=expiry');
  push('MEDIUM', 'certificate_expiry', 'Licences or certificates expiring', certExpiry.results.length,
    certExpiry.results.length ? `${certExpiry.results[0].scheme_code} ${certExpiry.results[0].certificate_no} — ${certExpiry.results[0].days_to_expiry} days.` : '', '/compliance');
  push('MEDIUM', 'sync_unhealthy', 'Branches not syncing', syncIssues.results.length,
    syncIssues.results.length ? syncIssues.results.map((s) => `${s.branch_name}: ${s.sync_health}`).join(', ') : '', '/sync');
  push('LOW', 'attendance_flags', 'Attendance flags awaiting review', attendanceFlags.results.length,
    'Most are missing GPS readings, which is a setup problem, not a conduct one. Check the pattern before acting.', '/attendance?tab=review');
  push('LOW', 'pending_adjustments', 'Stock write-offs awaiting approval', Number(pendingAdjustments.n) || 0,
    pendingAdjustments.n ? `₦${round2(Number(pendingAdjustments.value)).toLocaleString('en-NG')} at cost.` : '', '/adjustments?status=PENDING_APPROVAL');
  push('LOW', 'pending_expenses', 'Expenses awaiting approval', Number(pendingExpenses.n) || 0,
    pendingExpenses.n ? `₦${round2(Number(pendingExpenses.value)).toLocaleString('en-NG')}.` : '', '/expenses?status=PENDING_APPROVAL');
  push('LOW', 'delivery_overdue', 'Deliveries past their scheduled date', Number(openDeliveries.overdue) || 0,
    'A delivery that is late and not communicated is a refund request in progress.', '/delivery?filter=overdue');

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  items.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);

  return {
    items,
    high_count: items.filter((i) => i.severity === 'HIGH').length,
    total_count: items.length,
    all_clear: items.length === 0,
    checked_at: watNowIso(),
  };
}

// ---------------------------------------------------------------------
// DASHBOARDS
// ---------------------------------------------------------------------
async function staff(db, ctx) {
  const businessUnitId = ctx.businessUnitId;
  const branchId = ctx.user.branch_id;
  const today = watDate();
  const till = branchId ? await db.prepare(`SELECT * FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0 ORDER BY opened_at DESC LIMIT 1`).bind(branchId).first() : null;

  const mySales = await db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(discount_amount),0) AS discounts,
           SUM(CASE WHEN status = 'VOIDED' THEN 1 ELSE 0 END) AS voids
    FROM sales WHERE sold_by = ? AND is_deleted = 0 AND date(occurred_at,'+1 hour') = ?
  `).bind(ctx.user.id, today).first();

  const myAttendance = await db.prepare(`
    SELECT * FROM staff_attendance WHERE user_id = ? AND work_date = ? AND is_deleted = 0 ORDER BY clock_in_at DESC LIMIT 1
  `).bind(ctx.user.id, today).first();

  const collections = await db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(outstanding),0) AS value FROM v_plan_installments_due
    WHERE business_unit_id = ? AND branch_id = ? AND ageing IN ('OVERDUE','DUE_SOON')
  `).bind(businessUnitId, branchId || '__none__').first();

  const deliveries = await db.prepare(`
    SELECT COUNT(*) AS n FROM delivery_jobs
    WHERE branch_id = ? AND is_deleted = 0 AND scheduled_date = ? AND status NOT IN ('COMPLETED','CANCELLED')
  `).bind(branchId || '__none__', today).first();

  return {
    role_view: 'STAFF',
    date: today,
    branch_id: branchId,
    till: till ? {
      id: till.id, session_no: till.session_no, opened_at: till.opened_at,
      opening_float: round2(till.opening_float), expected_cash: round2(till.expected_cash),
      expected_total: round2(till.expected_total), sale_count: till.sale_count, void_count: till.void_count,
      cash_in_drawer: round2(Number(till.opening_float) + Number(till.expected_cash)),
    } : null,
    my_day: {
      sales: mySales.n || 0, revenue: round2(Number(mySales.revenue) || 0),
      discounts: round2(Number(mySales.discounts) || 0), voids: mySales.voids || 0,
      average_sale: mySales.n > 0 ? round2(Number(mySales.revenue) / mySales.n) : 0,
    },
    attendance: myAttendance ? {
      clocked_in: !!myAttendance.clock_in_at, clock_in_at: myAttendance.clock_in_at,
      clock_out_at: myAttendance.clock_out_at, location_status: myAttendance.in_location_status,
      needs_review: !!myAttendance.needs_review, is_late: !!myAttendance.is_late,
    } : { clocked_in: false },
    todays_collections: { count: collections.n || 0, value: round2(Number(collections.value) || 0) },
    todays_deliveries: deliveries.n || 0,
    // What a cashier actually needs to do next, in order.
    next_actions: [
      !myAttendance ? 'Clock in for today\u2019s shift.' : null,
      !till ? 'Ask a manager to open the till — you cannot record a sale without one.' : null,
      Number(collections.n) > 0 ? `${collections.n} instalment${collections.n === 1 ? '' : 's'} due from customers today.` : null,
      Number(deliveries.n) > 0 ? `${deliveries.n} delivery job${deliveries.n === 1 ? '' : 's'} scheduled today.` : null,
    ].filter(Boolean),
  };
}

async function manager(db, ctx, { branchId = null, startDate = null, endDate = null } = {}) {
  const businessUnitId = ctx.businessUnitId;
  const scopedBranch = resolveScopedBranchId(ctx.user, branchId);
  const start = startDate || watDate();
  const end = endDate || watDate();

  const [figures, cash, exc, topProducts, topStaff, byBranch, salesByDay] = await Promise.all([
    periodFigures(db, { businessUnitId, branchId: scopedBranch, startDate: start, endDate: end, compareStartDate: null, compareEndDate: null }),
    cashPosition(db, { businessUnitId, branchId: scopedBranch }),
    exceptions(db, { businessUnitId, branchId: scopedBranch }),
    db.prepare(`
      SELECT * FROM v_top_products WHERE business_unit_id = ? ${scopedBranch ? 'AND branch_id IS NOT NULL' : ''}
      ORDER BY revenue DESC LIMIT 10
    `).bind(businessUnitId).all(),
    db.prepare(`
      SELECT u.full_name AS user_name, u.role, COUNT(s.id) AS sales, COALESCE(SUM(s.total),0) AS revenue,
             COALESCE(SUM(s.discount_amount),0) AS discounts,
             SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS voids
      FROM sales s JOIN users u ON u.id = s.sold_by
      WHERE s.business_unit_id = ? AND s.is_deleted = 0 ${scopedBranch ? 'AND s.branch_id = ?' : ''}
        AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
      GROUP BY u.full_name, u.role ORDER BY revenue DESC LIMIT 10
    `).bind(businessUnitId, ...(scopedBranch ? [scopedBranch] : []), start, end).all(),
    scopedBranch ? Promise.resolve({ results: [] }) : db.prepare(`
      SELECT b.id AS branch_id, b.name AS branch_name,
             COUNT(s.id) AS sales, COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END),0) AS revenue,
             COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN si.gross_margin ELSE 0 END),0) AS margin
      FROM branches b
      LEFT JOIN sales s ON s.branch_id = b.id AND s.is_deleted = 0 AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
      LEFT JOIN sale_items si ON si.sale_id = s.id AND si.is_deleted = 0
      WHERE b.business_unit_id = ? AND b.is_deleted = 0 AND b.is_active = 1
      GROUP BY b.id, b.name ORDER BY revenue DESC
    `).bind(start, end, businessUnitId).all(),
    db.prepare(`
      SELECT date(s.occurred_at,'+1 hour') AS day, COUNT(s.id) AS sales,
             COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END),0) AS revenue
      FROM sales s WHERE s.business_unit_id = ? AND s.is_deleted = 0 ${scopedBranch ? 'AND s.branch_id = ?' : ''}
        AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
      GROUP BY day ORDER BY day DESC LIMIT 31
    `).bind(businessUnitId, ...(scopedBranch ? [scopedBranch] : []), start, end).all(),
  ]);

  // Filter top products to the scope: the view is business-wide, so a branch
  // manager must not be shown another branch's best sellers.
  const scopedTop = scopedBranch
    ? (await db.prepare(`
        SELECT p.name AS product_name, p.brand, COALESCE(SUM(si.quantity_base),0) AS units_sold,
               COALESCE(SUM(si.line_total),0) AS revenue, COALESCE(SUM(si.gross_margin),0) AS gross_margin
        FROM sale_items si JOIN sales s ON s.id = si.sale_id AND s.status <> 'VOIDED' AND s.is_deleted = 0
        JOIN products p ON p.id = si.product_id
        WHERE si.is_deleted = 0 AND si.business_unit_id = ? AND s.branch_id = ?
          AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
        GROUP BY p.name, p.brand ORDER BY revenue DESC LIMIT 10
      `).bind(businessUnitId, scopedBranch, start, end).all()).results
    : topProducts.results;

  return {
    role_view: 'MANAGER',
    branch_id: scopedBranch,
    scope_label: scopedBranch ? (await db.prepare('SELECT name FROM branches WHERE id = ?').bind(scopedBranch).first() || {}).name : 'All branches',
    figures, cash, exceptions: exc,
    top_products: scopedTop.map((r) => ({ ...r, revenue: round2(r.revenue), gross_margin: round2(r.gross_margin) })),
    top_staff: topStaff.results.map((r) => ({ ...r, revenue: round2(r.revenue), discounts: round2(r.discounts) })),
    by_branch: byBranch.results.map((r) => ({ ...r, revenue: round2(r.revenue), margin: round2(r.margin) })),
    sales_by_day: salesByDay.results.map((r) => ({ ...r, revenue: round2(r.revenue) })),
  };
}

async function owner(db, ctx, { startDate = null, endDate = null } = {}) {
  const businessUnitId = ctx.businessUnitId;
  const end = endDate || watDate();
  const start = startDate || require('../../shared/ids').addDays(end, -29);

  const [figures, cash, exc, plan, debtors, creditors, stockValue, shrinkage, categoryPnl, byBranch, plans, holds] = await Promise.all([
    periodFigures(db, {
      businessUnitId, startDate: start, endDate: end,
      compareStartDate: require('../../shared/ids').addDays(start, -30),
      compareEndDate: require('../../shared/ids').addDays(end, -30),
    }),
    cashPosition(db, { businessUnitId }),
    exceptions(db, { businessUnitId }),
    planSummary(db, businessUnitId),
    db.prepare(`
      SELECT COUNT(*) AS customers, COALESCE(SUM(balance),0) AS total, COALESCE(SUM(overdue_balance),0) AS overdue,
             COALESCE(SUM(CASE WHEN credit_limit > 0 AND balance > credit_limit THEN 1 ELSE 0 END),0) AS over_limit_count
      FROM v_debtor_balances WHERE business_unit_id = ?
    `).bind(businessUnitId).first(),
    db.prepare(`
      SELECT COUNT(*) AS suppliers, COALESCE(SUM(balance),0) AS total FROM v_creditor_balances WHERE business_unit_id = ?
    `).bind(businessUnitId).first(),
    db.prepare(`
      SELECT COALESCE(SUM(value_at_cost),0) AS at_cost, COALESCE(SUM(value_at_retail),0) AS at_retail,
             COALESCE(SUM(qty_on_hand),0) AS units, COUNT(DISTINCT product_id) AS products,
             SUM(below_reorder) AS below_reorder
      FROM v_stock_position_by_branch WHERE business_unit_id = ?
    `).bind(businessUnitId).first(),
    require('./adjustmentService').shrinkageReport(db, { businessUnitId, startDate: start, endDate: end }),
    db.prepare(`
      SELECT pc.label AS category, COALESCE(SUM(si.line_total),0) AS revenue,
             COALESCE(SUM(si.gross_margin),0) AS margin, COUNT(DISTINCT si.sale_id) AS sales
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.status <> 'VOIDED' AND s.is_deleted = 0
      LEFT JOIN product_categories pc ON pc.id = si.category_id
      WHERE si.is_deleted = 0 AND si.business_unit_id = ? AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
      GROUP BY pc.label ORDER BY revenue DESC
    `).bind(businessUnitId, start, end).all(),
    db.prepare(`
      SELECT b.id AS branch_id, b.name AS branch_name, b.branch_type,
             COUNT(s.id) AS sales,
             COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END),0) AS revenue,
             COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN si.gross_margin ELSE 0 END),0) AS margin,
             COALESCE(SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END),0) AS voids
      FROM branches b
      LEFT JOIN sales s ON s.branch_id = b.id AND s.is_deleted = 0 AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
      LEFT JOIN sale_items si ON si.sale_id = s.id AND si.is_deleted = 0
      WHERE b.business_unit_id = ? AND b.is_deleted = 0 AND b.is_active = 1
      GROUP BY b.id, b.name, b.branch_type ORDER BY revenue DESC
    `).bind(start, end, businessUnitId).all(),
    db.prepare(`
      SELECT status, COUNT(*) AS n, COALESCE(SUM(balance_due),0) AS outstanding, COALESCE(SUM(amount_paid),0) AS collected
      FROM payment_plans WHERE business_unit_id = ? AND is_deleted = 0 GROUP BY status
    `).bind(businessUnitId).all(),
    db.prepare(`
      SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_paid),0) AS held
      FROM layaway_holds WHERE business_unit_id = ? AND is_deleted = 0 GROUP BY status
    `).bind(businessUnitId).all(),
  ]);

  const stockAtCost = round2(Number(stockValue.at_cost) || 0);
  const debtorTotal = round2(Number(debtors.total) || 0);
  const creditorTotal = round2(Number(creditors.total) || 0);

  return {
    role_view: 'OWNER',
    figures, cash, exceptions: exc, plan,
    working_capital: {
      stock_at_cost: stockAtCost,
      stock_at_retail: round2(Number(stockValue.at_retail) || 0),
      stock_units: round2(Number(stockValue.units) || 0),
      stock_products: stockValue.products || 0,
      products_below_reorder: Number(stockValue.below_reorder) || 0,
      debtors: debtorTotal,
      debtors_overdue: round2(Number(debtors.overdue) || 0),
      debtors_over_limit: debtors.over_limit_count || 0,
      creditors: creditorTotal,
      net_working_capital: round2(stockAtCost + debtorTotal - creditorTotal),
    },
    shrinkage: {
      total_loss_value: shrinkage.total_loss_value,
      theft_value: shrinkage.theft_value,
      percent_of_revenue: shrinkage.shrinkage_percent_of_revenue,
      by_type: shrinkage.by_type.slice(0, 6),
    },
    credit_book: {
      plans: plans.results.map((r) => ({ ...r, outstanding: round2(r.outstanding), collected: round2(r.collected) })),
      plan_outstanding: round2(plans.results.filter((r) => ['ACTIVE', 'DEFAULTED'].includes(r.status)).reduce((a, r) => a + Number(r.outstanding), 0)),
      holds: holds.results.map((r) => ({ ...r, held: round2(r.held) })),
    },
    category_pnl: categoryPnl.results.map((r) => ({
      ...r, revenue: round2(r.revenue), margin: round2(r.margin),
      margin_percent: Number(r.revenue) > 0 ? round2((Number(r.margin) / Number(r.revenue)) * 100) : 0,
    })),
    by_branch: byBranch.results.map((r) => ({
      ...r, revenue: round2(r.revenue), margin: round2(r.margin),
      margin_percent: Number(r.revenue) > 0 ? round2((Number(r.margin) / Number(r.revenue)) * 100) : 0,
      void_rate_percent: Number(r.sales) > 0 ? round2((Number(r.voids) / Number(r.sales)) * 100) : 0,
    })),
  };
}

// Sales by day, for the chart. Always WAT days.
async function salesTrend(db, { businessUnitId, branchId = null, days = 30 }) {
  const end = watDate();
  const start = require('../../shared/ids').addDays(end, -(Number(days) || 30) + 1);
  const rows = await db.prepare(`
    SELECT date(s.occurred_at,'+1 hour') AS day,
           COUNT(s.id) AS sales,
           COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END),0) AS revenue,
           COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.discount_amount ELSE 0 END),0) AS discounts,
           SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS voids
    FROM sales s
    WHERE s.business_unit_id = ? AND s.is_deleted = 0 ${branchId ? 'AND s.branch_id = ?' : ''}
      AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
    GROUP BY day ORDER BY day ASC
  `).bind(businessUnitId, ...(branchId ? [branchId] : []), start, end).all();

  // Fill gaps so a zero-sales day shows as zero rather than disappearing — a
  // chart that omits closed days makes a bad week look like a good one.
  const byDay = new Map(rows.results.map((r) => [r.day, r]));
  const out = [];
  let cursor = start;
  while (cursor <= end) {
    const r = byDay.get(cursor);
    out.push({
      day: cursor,
      sales: r ? r.sales : 0,
      revenue: round2(r ? Number(r.revenue) : 0),
      discounts: round2(r ? Number(r.discounts) : 0),
      voids: r ? Number(r.voids) || 0 : 0,
    });
    cursor = require('../../shared/ids').addDays(cursor, 1);
  }
  return { start, end, days: out, total_revenue: round2(sumMoney(out.map((d) => d.revenue))) };
}

async function topProducts(db, { businessUnitId, branchId = null, startDate, endDate, metric = 'revenue', limit = 20 }) {
  const allowed = ['revenue', 'units_sold', 'gross_margin'];
  const sortCol = allowed.includes(metric) ? metric : 'revenue';
  const rows = await db.prepare(`
    SELECT p.id AS product_id, p.name AS product_name, p.sku, p.brand, pc.label AS category,
           COALESCE(SUM(si.quantity_base),0) AS units_sold,
           COALESCE(SUM(si.line_total),0) AS revenue,
           COALESCE(SUM(si.gross_margin),0) AS gross_margin,
           COUNT(DISTINCT si.sale_id) AS times_sold
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id AND s.status <> 'VOIDED' AND s.is_deleted = 0
    JOIN products p ON p.id = si.product_id
    LEFT JOIN product_categories pc ON pc.id = si.category_id
    WHERE si.is_deleted = 0 AND si.business_unit_id = ? ${branchId ? 'AND s.branch_id = ?' : ''}
      AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
    GROUP BY p.id, p.name, p.sku, p.brand, pc.label
    ORDER BY ${sortCol} DESC
    LIMIT ?
  `).bind(businessUnitId, ...(branchId ? [branchId] : []), String(startDate).slice(0, 10), String(endDate).slice(0, 10), Math.min(200, Number(limit) || 20)).all();

  return rows.results.map((r) => ({
    ...r,
    units_sold: round2(r.units_sold), revenue: round2(r.revenue), gross_margin: round2(r.gross_margin),
    margin_percent: Number(r.revenue) > 0 ? round2((Number(r.gross_margin) / Number(r.revenue)) * 100) : 0,
  }));
}

// Branch comparison. The report that settles "which branch is actually
// performing?" — and it must compare MARGIN and void rate, not just revenue,
// because a branch can win on revenue by discounting and losing on everything
// that matters.
async function branchComparison(db, { businessUnitId, startDate, endDate }) {
  const rows = await db.prepare(`
    SELECT b.id AS branch_id, b.name AS branch_name, b.branch_type, b.state,
      COUNT(s.id) AS sales,
      COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END),0) AS revenue,
      COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.discount_amount ELSE 0 END),0) AS discounts,
      COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN si.gross_margin ELSE 0 END),0) AS margin,
      COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN si.unit_cost * si.quantity_base ELSE 0 END),0) AS cogs,
      SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS voids,
      COUNT(DISTINCT s.customer_id) AS customers,
      COUNT(DISTINCT date(s.occurred_at,'+1 hour')) AS trading_days
    FROM branches b
    LEFT JOIN sales s ON s.branch_id = b.id AND s.is_deleted = 0 AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
    LEFT JOIN sale_items si ON si.sale_id = s.id AND si.is_deleted = 0
    WHERE b.business_unit_id = ? AND b.is_deleted = 0 AND b.is_active = 1
    GROUP BY b.id, b.name, b.branch_type, b.state
    ORDER BY revenue DESC
  `).bind(String(startDate).slice(0, 10), String(endDate).slice(0, 10), businessUnitId).all();

  const [expenses, stock, shrinkage] = await Promise.all([
    db.prepare(`
      SELECT branch_id, COALESCE(SUM(amount),0) AS total FROM expenses
      WHERE business_unit_id = ? AND is_deleted = 0 AND status IN ('APPROVED','POSTED') AND expense_date BETWEEN ? AND ?
      GROUP BY branch_id
    `).bind(businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10)).all(),
    db.prepare(`SELECT branch_id, COALESCE(SUM(value_at_cost),0) AS at_cost FROM v_stock_position_by_branch WHERE business_unit_id = ? GROUP BY branch_id`).bind(businessUnitId).all(),
    db.prepare(`
      SELECT branch_id, COALESCE(SUM(value),0) AS loss FROM stock_adjustments
      WHERE business_unit_id = ? AND is_deleted = 0 AND status = 'POSTED' AND quantity < 0
        AND date(posted_at,'+1 hour') BETWEEN ? AND ?
      GROUP BY branch_id
    `).bind(businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10)).all(),
  ]);
  const expMap = new Map(expenses.results.map((r) => [r.branch_id, Number(r.total)]));
  const stockMap = new Map(stock.results.map((r) => [r.branch_id, Number(r.at_cost)]));
  const shrinkMap = new Map(shrinkage.results.map((r) => [r.branch_id, Number(r.loss)]));

  const out = rows.results.map((r) => {
    const revenue = round2(Number(r.revenue) || 0);
    const margin = round2(Number(r.margin) || 0);
    const exp = round2(expMap.get(r.branch_id) || 0);
    const loss = round2(shrinkMap.get(r.branch_id) || 0);
    return {
      branch_id: r.branch_id, branch_name: r.branch_name, branch_type: r.branch_type, state: r.state,
      sales: r.sales || 0, revenue, discounts: round2(Number(r.discounts) || 0),
      cogs: round2(Number(r.cogs) || 0), gross_margin: margin,
      gross_margin_percent: revenue > 0 ? round2((margin / revenue) * 100) : 0,
      operating_expenses: exp, shrinkage_loss: loss,
      net_profit: round2(margin - exp),
      net_margin_percent: revenue > 0 ? round2(((margin - exp) / revenue) * 100) : 0,
      void_rate_percent: r.sales > 0 ? round2((Number(r.voids) / Number(r.sales)) * 100) : 0,
      discount_rate_percent: revenue > 0 ? round2((Number(r.discounts) / revenue) * 100) : 0,
      shrinkage_percent: revenue > 0 ? round2((loss / revenue) * 100) : 0,
      average_sale: r.sales > 0 ? round2(revenue / (Number(r.sales) - Number(r.voids) || 1)) : 0,
      revenue_per_trading_day: r.trading_days > 0 ? round2(revenue / r.trading_days) : 0,
      stock_at_cost: round2(stockMap.get(r.branch_id) || 0),
      customers: r.customers || 0,
      trading_days: r.trading_days || 0,
    };
  });

  // Stock turn is the number that separates a branch that sells from one that
  // merely holds. COGS / average stock, annualised over the period.
  const days = Math.max(1, daysBetween(String(startDate).slice(0, 10), String(endDate).slice(0, 10)) + 1);
  for (const b of out) {
    b.stock_turn_annualised = b.stock_at_cost > 0 ? round2((b.cogs / b.stock_at_cost) * (365 / days)) : null;
  }
  return { period: { start: String(startDate).slice(0, 10), end: String(endDate).slice(0, 10), days }, branches: out };
}

module.exports = { periodFigures, cashPosition, exceptions, staff, manager, owner, salesTrend, topProducts, branchComparison };
'use strict';
