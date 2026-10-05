'use strict';
// =====================================================================
// server/routes/dashboard.js — THE FIRST SCREEN
// =====================================================================
// One endpoint, shaped by who is asking. A cashier needs to know what they have
// sold today and whether their drawer balances; an owner needs the group
// position across every business and branch. Serving both the same payload
// either buries the cashier in numbers they cannot act on or hides the owner's
// exposure behind a branch filter.
//
// EVERY FIGURE IS DERIVED ON READ. Nothing here is stored, so nothing here can
// go stale. A dashboard that reads a cached "sales today" column will show
// yesterday's figure after a void, a late posting, or a midnight rollover — and
// a dashboard that is occasionally wrong is a dashboard nobody checks, which is
// worse than none.
//
// `sold_at` (West Africa Time) defines the trading day throughout. Grouping by
// `created_at` (UTC) would move every sale before 01:00 WAT onto the wrong day.
// =====================================================================

const { resolveBranch, resolveBusiness, scopeFilter, dateRange, numField } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { watToday, watNow, addDays, utcToWat } = require('../../domain/time');
const { atLeast, navigationFor } = require('../../domain/roles');
const { planUsage, getSettings } = require('../../domain/planLimits');
const { ageBalance } = require('../../domain/credit');
const glService = require('../services/glService');

const COUNTS = "s.is_deleted = 0 AND s.status <> 'VOIDED'";

function mount(app, base = '/api') {
  app.get(`${base}/dashboard`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings') || await getSettings(db);
    const today = watToday();
    const scope = ctx.get('scope');

    // The scope decides the shape of the answer, and it is derived from the user
    // rather than requested — a client cannot ask to see the whole group.
    const isOwnerView = scope.allBusinesses;
    const business = isOwnerView ? null : await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const useBranch = branch && !scope.allBranches ? String(branch.id) : null;

    const scopeClause = (alias) => {
      const where = []; const params = [];
      if (business) { where.push(`${alias}.business_id = ?`); params.push(String(business.id)); }
      if (useBranch) { where.push(`${alias}.branch_id = ?`); params.push(useBranch); }
      else if (!scope.allBranches && scope.branchIds) {
        const ids = [...scope.branchIds];
        where.push(`${alias}.branch_id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      }
      return { sql: where.length ? `AND ${where.join(' AND ')}` : '', params };
    };

    // ---- TODAY --------------------------------------------------------
    const sc = scopeClause('s');
    const todaySales = await db.first(`SELECT COUNT(*) AS count,
          COALESCE(SUM(s.total),0) AS gross, COALESCE(SUM(s.vat_amount),0) AS vat,
          COALESCE(SUM(s.balance_due),0) AS outstanding, COALESCE(SUM(s.delivery_fee),0) AS delivery,
          COALESCE(AVG(s.total),0) AS average
        FROM sales s WHERE ${COUNTS} AND date(s.sold_at) = ? ${sc.sql}`, [today, ...sc.params]);
    const yesterday = addDays(today, -1);
    const yesterdaySales = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(s.total),0) AS gross
        FROM sales s WHERE ${COUNTS} AND date(s.sold_at) = ? ${sc.sql}`, [yesterday, ...sc.params]);
    const todayCogs = await db.first(`SELECT COALESCE(SUM(si.cost_price_snapshot * si.quantity_in_base),0) AS cogs
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE si.is_deleted = 0 AND ${COUNTS} AND date(s.sold_at) = ? ${sc.sql}`, [today, ...sc.params]);
    const todayVoids = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(s.total),0) AS value
        FROM sales s WHERE s.is_deleted = 0 AND s.status = 'VOIDED' AND date(s.sold_at) = ? ${sc.sql}`, [today, ...sc.params]);

    const grossToday = round2(Number(todaySales.gross));
    const vatToday = round2(Number(todaySales.vat));
    const netToday = round2(grossToday - vatToday);
    const cogsToday = round2(Number(todayCogs.cogs));
    const marginToday = round2(netToday - cogsToday);
    const grossYesterday = round2(Number(yesterdaySales.gross));

    // ---- PAYMENT MIX (today) -----------------------------------------
    const byMethod = await db.all(`SELECT p.method, COALESCE(SUM(p.amount),0) AS amount, COUNT(*) AS count
        FROM sale_payments p JOIN sales s ON s.id = p.sale_id
        WHERE p.is_deleted = 0 AND ${COUNTS} AND date(s.sold_at) = ? ${sc.sql}
        GROUP BY p.method ORDER BY amount DESC`, [today, ...sc.params]);

    // ---- PERIOD (default 30 days) ------------------------------------
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const period = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(s.total),0) AS gross,
          COALESCE(SUM(s.vat_amount),0) AS vat, COALESCE(SUM(s.balance_due),0) AS outstanding
        FROM sales s WHERE ${COUNTS} AND date(s.sold_at) BETWEEN ? AND ? ${sc.sql}`, [from, to, ...sc.params]);
    const periodCogs = await db.first(`SELECT COALESCE(SUM(si.cost_price_snapshot * si.quantity_in_base),0) AS cogs
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE si.is_deleted = 0 AND ${COUNTS} AND date(s.sold_at) BETWEEN ? AND ? ${sc.sql}`, [from, to, ...sc.params]);
    const periodNet = round2(Number(period.gross) - Number(period.vat));
    const periodMargin = round2(periodNet - Number(periodCogs.cogs));

    // Daily series for the chart. Derived from the same predicate as the totals,
    // so the chart and the headline numbers cannot disagree.
    const series = await db.all(`SELECT date(s.sold_at) AS day, COUNT(*) AS count,
          COALESCE(SUM(s.total),0) AS gross, COALESCE(SUM(s.vat_amount),0) AS vat
        FROM sales s WHERE ${COUNTS} AND date(s.sold_at) BETWEEN ? AND ? ${sc.sql}
        GROUP BY day ORDER BY day ASC`, [from, to, ...sc.params]);

    // ---- STOCK --------------------------------------------------------
    const stockWhere = ['sb.is_deleted = 0', "sb.status NOT IN ('QUARANTINED','EXPIRED')"];
    const stockParams = [];
    if (business) { stockWhere.push('sb.business_id = ?'); stockParams.push(String(business.id)); }
    if (useBranch) { stockWhere.push('sb.branch_id = ?'); stockParams.push(useBranch); }
    else if (!scope.allBranches && scope.branchIds) {
      const ids = [...scope.branchIds];
      stockWhere.push(`sb.branch_id IN (${ids.map(() => '?').join(',')})`);
      stockParams.push(...ids);
    }
    const stock = await db.first(`SELECT COALESCE(SUM(sb.quantity),0) AS units,
          COALESCE(SUM(sb.quantity * sb.cost_price_per_unit),0) AS at_cost,
          COALESCE(SUM(sb.quantity * sb.selling_price_per_unit),0) AS at_retail,
          COUNT(DISTINCT sb.product_id) AS products
        FROM stock_batches sb WHERE ${stockWhere.join(' AND ')}`, stockParams);

    const lowStockClause = useBranch ? 'AND sb.branch_id = ?' : (business ? 'AND sb.business_id = ?' : '');
    const lowStockParam = useBranch ? [useBranch] : (business ? [String(business.id)] : []);
    const lowStock = await db.all(`SELECT p.id, p.name, p.sku, p.base_unit_name, p.reorder_level, b.name AS branch_name,
            COALESCE(SUM(sb.quantity - sb.quantity_reserved),0) AS available
          FROM stock_batches sb JOIN products p ON p.id = sb.product_id
          LEFT JOIN branches b ON b.id = sb.branch_id
          WHERE sb.is_deleted = 0 AND sb.status NOT IN ('QUARANTINED','EXPIRED') ${lowStockClause}
          GROUP BY sb.product_id, sb.branch_id
          HAVING p.reorder_level > 0 AND available <= p.reorder_level
          ORDER BY (available * 1.0 / p.reorder_level) ASC LIMIT 12`, lowStockParam);
    const lowStockCount = await db.scalar(`SELECT COUNT(*) FROM (
          SELECT sb.product_id, sb.branch_id, COALESCE(SUM(sb.quantity - sb.quantity_reserved),0) AS available, p.reorder_level
          FROM stock_batches sb JOIN products p ON p.id = sb.product_id
          WHERE sb.is_deleted = 0 AND sb.status NOT IN ('QUARANTINED','EXPIRED') ${lowStockClause}
          GROUP BY sb.product_id, sb.branch_id
          HAVING p.reorder_level > 0 AND available <= p.reorder_level)`, lowStockParam);
    const expiringSoon = await db.all(`SELECT sb.id, sb.batch_no, sb.expiry_date, sb.quantity, p.name AS product_name, b.name AS branch_name
        FROM stock_batches sb JOIN products p ON p.id = sb.product_id LEFT JOIN branches b ON b.id = sb.branch_id
        WHERE sb.is_deleted = 0 AND sb.expiry_date IS NOT NULL AND sb.status <> 'EXPIRED'
          AND sb.expiry_date <= date('now', '+${Number(settings.expiry_alert_days) || 60} days')
          ${lowStockClause.replace('sb.branch_id', 'sb.branch_id')}
        ORDER BY sb.expiry_date ASC LIMIT 10`, lowStockParam);

    // ---- TOP SELLERS --------------------------------------------------
    const topProducts = await db.all(`SELECT si.product_id, si.product_name, si.sku,
          COALESCE(SUM(si.quantity_in_base),0) AS units, COALESCE(SUM(si.line_total),0) AS revenue,
          COALESCE(SUM(si.margin),0) AS margin
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE si.is_deleted = 0 AND ${COUNTS} AND date(s.sold_at) BETWEEN ? AND ? ${sc.sql}
        GROUP BY si.product_id ORDER BY revenue DESC LIMIT 8`, [from, to, ...sc.params]);
    const topStaff = await db.all(`SELECT u.id, u.full_name, COUNT(s.id) AS sales, COALESCE(SUM(s.total),0) AS revenue
        FROM sales s JOIN users u ON u.id = s.salesperson_id
        WHERE ${COUNTS} AND date(s.sold_at) BETWEEN ? AND ? ${sc.sql}
        GROUP BY u.id ORDER BY revenue DESC LIMIT 8`, [from, to, ...sc.params]);

    // ---- CREDIT / DEBTORS --------------------------------------------
    let debtors = null;
    if (atLeast(user.role, 'MANAGER')) {
      const dWhere = ['c.is_deleted = 0', 'c.credit_balance > 0']; const dParams = [];
      if (business) { dWhere.push('c.business_id = ?'); dParams.push(String(business.id)); }
      if (useBranch) { dWhere.push('c.branch_id = ?'); dParams.push(useBranch); }
      const owed = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(c.credit_balance),0) AS total
          FROM customers c WHERE ${dWhere.join(' AND ')}`, dParams);
      // The over-90 bucket needs the ledger, so it is sampled from the largest
      // debtors rather than computed for every customer on every dashboard load.
      const worst = await db.all(`SELECT c.id, c.name, c.credit_balance FROM customers c
          WHERE ${dWhere.join(' AND ')} ORDER BY c.credit_balance DESC LIMIT 40`, dParams);
      let over90 = 0;
      for (const w of worst) {
        const entries = await db.all('SELECT * FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0 ORDER BY created_at, id', [String(w.id)]);
        over90 = round2(over90 + ageBalance(entries, { today }).bucket_90_plus);
      }
      const overdueInvoices = await db.scalar(`SELECT COUNT(*) FROM sales s
          WHERE ${COUNTS} AND s.balance_due > 0 AND s.due_date IS NOT NULL AND s.due_date < ? ${sc.sql}`, [today, ...sc.params]);
      debtors = {
        count: Number(owed.count) || 0,
        totalOwed: round2(Number(owed.total)),
        likelyBad: over90,
        overdueInvoices: Number(overdueInvoices) || 0,
      };
    }

    // ---- TILL / SAFE --------------------------------------------------
    const tillWhere = useBranch ? 'AND t.branch_id = ?' : (business ? 'AND t.business_id = ?' : '');
    const tillParam = useBranch ? [useBranch] : (business ? [String(business.id)] : []);
    const openTills = await db.all(`SELECT t.*, b.name AS branch_name, u.full_name AS cashier_name
        FROM till_sessions t LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN users u ON u.id = t.user_id
        WHERE t.is_deleted = 0 AND t.status = 'OPEN' ${tillWhere} ORDER BY t.opened_at DESC LIMIT 20`, tillParam);
    // Uncounted variances on CLOSED tills: the number that shows whether cash
    // control is actually working, as distinct from whether today was busy.
    const variance = await db.first(`SELECT COALESCE(SUM(t.variance),0) AS net,
          COALESCE(SUM(CASE WHEN t.variance < 0 THEN -t.variance ELSE 0 END),0) AS shortages,
          COALESCE(SUM(CASE WHEN t.variance > 0 THEN t.variance ELSE 0 END),0) AS surpluses,
          COUNT(*) AS closed,
          COALESCE(SUM(CASE WHEN t.variance <> 0 AND t.reviewed_by IS NULL THEN 1 ELSE 0 END),0) AS unreviewed
        FROM till_sessions t WHERE t.is_deleted = 0 AND t.status = 'CLOSED'
          AND date(t.closed_at, '+1 hours') BETWEEN ? AND ? ${tillWhere}`, [from, to, ...tillParam]);
    const safeWhere = useBranch ? 'AND branch_id = ?' : (business ? 'AND business_id = ?' : '');
    const safeParam = useBranch ? [useBranch] : (business ? [String(business.id)] : []);
    const safe = await db.first(`SELECT COALESCE(SUM(CASE WHEN entry_type IN ('OPENING_FLOAT','CASH_DEPOSIT','TILL_TRANSFER_IN','BANK_DEPOSIT') THEN amount ELSE -amount END),0) AS balance
        FROM branch_safe_ledger WHERE is_deleted = 0 ${safeWhere}`, safeParam);

    // ---- CASH POSITION (from the ledger, not the tills) ---------------
    let cash = null;
    if (atLeast(user.role, 'MANAGER') && business) {
      const accountIds = await glService.loadAccountCodes(db, business.id);
      const codes = ['1000', '1010', '1020', '1030', '1040'];
      const accounts = [];
      for (const code of codes) {
        const accountId = accountIds.get(code);
        if (!accountId) continue;
        const row = await db.first(`SELECT a.code, a.name, COALESCE(SUM(l.debit - l.credit),0) AS balance
            FROM gl_accounts a
            LEFT JOIN gl_journal_lines l ON l.account_id = a.id AND l.is_deleted = 0
            LEFT JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.is_deleted = 0
            WHERE a.id = ? GROUP BY a.id`, [accountId]);
        if (row) accounts.push({ code: row.code, name: row.name, balance: round2(Number(row.balance)) });
      }
      cash = { accounts, total: round2(accounts.reduce((a, x) => a + x.balance, 0)) };
    }

    // ---- GROUP VIEW: per-business and per-branch ----------------------
    let byBranch = null;
    let byBusiness = null;
    if (scope.allBranches || isOwnerView) {
      const bWhere = ['b.is_deleted = 0', 'b.is_active = 1']; const bParams = [];
      if (business) { bWhere.push('b.business_id = ?'); bParams.push(String(business.id)); }
      else if (!scope.allBranches && scope.branchIds) {
        const ids = [...scope.branchIds];
        bWhere.push(`b.id IN (${ids.map(() => '?').join(',')})`); bParams.push(...ids);
      }
      const branches = await db.all(`SELECT b.id, b.name, b.code, b.city, b.business_id, biz.name AS business_name
          FROM branches b LEFT JOIN businesses biz ON biz.id = b.business_id
          WHERE ${bWhere.join(' AND ')} ORDER BY b.name`, bParams);
      byBranch = [];
      for (const b of branches) {
        const r = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(s.total),0) AS gross, COALESCE(SUM(s.vat_amount),0) AS vat
            FROM sales s WHERE ${COUNTS} AND date(s.sold_at) BETWEEN ? AND ? AND s.branch_id = ?`, [from, to, String(b.id)]);
        const todayR = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(s.total),0) AS gross
            FROM sales s WHERE ${COUNTS} AND date(s.sold_at) = ? AND s.branch_id = ?`, [today, String(b.id)]);
        const st = await db.first(`SELECT COALESCE(SUM(sb.quantity * sb.cost_price_per_unit),0) AS at_cost
            FROM stock_batches sb WHERE sb.is_deleted = 0 AND sb.branch_id = ? AND sb.status NOT IN ('QUARANTINED','EXPIRED')`, [String(b.id)]);
        byBranch.push({
          ...b,
          today: { sales: Number(todayR.count) || 0, gross: round2(Number(todayR.gross)) },
          period: { sales: Number(r.count) || 0, gross: round2(Number(r.gross)), net: round2(Number(r.gross) - Number(r.vat)) },
          stockAtCost: round2(Number(st.at_cost)),
        });
      }
      if (isOwnerView) {
        const businesses = await db.all('SELECT id, name, legal_name, profile_code, is_active FROM businesses WHERE is_deleted = 0 ORDER BY name');
        byBusiness = [];
        for (const biz of businesses) {
          const r = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(s.total),0) AS gross, COALESCE(SUM(s.vat_amount),0) AS vat
              FROM sales s WHERE ${COUNTS} AND date(s.sold_at) BETWEEN ? AND ? AND s.business_id = ?`, [from, to, String(biz.id)]);
          const branchCount = await db.scalar('SELECT COUNT(*) FROM branches WHERE business_id = ? AND is_deleted = 0 AND is_active = 1', [String(biz.id)]);
          byBusiness.push({
            ...biz, branchCount: Number(branchCount) || 0,
            period: { sales: Number(r.count) || 0, gross: round2(Number(r.gross)), net: round2(Number(r.gross) - Number(r.vat)) },
          });
        }
      }
    }

    // ---- WHAT NEEDS DOING --------------------------------------------
    // A dashboard that only reports the past is a report. The action list is what
    // makes it a working screen: each item is something a person can do now.
    const actions = [];
    if (Number(lowStockCount) > 0) actions.push({ key: 'low_stock', severity: 'WARN', count: Number(lowStockCount), label: `${lowStockCount} product(s) at or below reorder level`, route: '/stock?filter=low' });
    if (expiringSoon.length) actions.push({ key: 'expiring', severity: 'WARN', count: expiringSoon.length, label: `${expiringSoon.length} batch(es) expiring within ${settings.expiry_alert_days || 60} days`, route: '/stock?filter=expiring' });
    if (debtors && debtors.overdueInvoices > 0) actions.push({ key: 'overdue', severity: debtors.likelyBad > 0 ? 'CRITICAL' : 'WARN', count: debtors.overdueInvoices, label: `${debtors.overdueInvoices} invoice(s) past their due date`, route: '/customers?filter=overdue' });
    if (Number(variance.unreviewed) > 0) actions.push({ key: 'till_review', severity: 'WARN', count: Number(variance.unreviewed), label: `${variance.unreviewed} closed till(s) with an unexplained variance need sign-off`, route: '/till?filter=unreviewed' });
    const pendingExpenses = atLeast(user.role, 'MANAGER')
      ? await db.scalar(`SELECT COUNT(*) FROM expenses WHERE is_deleted = 0 AND status = 'PENDING_APPROVAL' ${business ? 'AND business_id = ?' : ''}`, business ? [String(business.id)] : [])
      : 0;
    if (Number(pendingExpenses) > 0) actions.push({ key: 'expenses', severity: 'INFO', count: Number(pendingExpenses), label: `${pendingExpenses} expense(s) awaiting approval`, route: '/expenses?status=PENDING_APPROVAL' });
    const pendingDeliveries = await db.scalar(`SELECT COUNT(*) FROM delivery_jobs d WHERE d.is_deleted = 0 AND d.status IN ('PENDING','SCHEDULED','PICKED','IN_TRANSIT') ${useBranch ? 'AND d.branch_id = ?' : (business ? 'AND d.business_id = ?' : '')}`, useBranch ? [useBranch] : (business ? [String(business.id)] : []));
    if (Number(pendingDeliveries) > 0) actions.push({ key: 'deliveries', severity: 'INFO', count: Number(pendingDeliveries), label: `${pendingDeliveries} delivery job(s) outstanding`, route: '/sales?tab=deliveries' });
    const pendingDevices = await db.scalar(`SELECT COUNT(*) FROM branch_devices WHERE is_deleted = 0 AND registered_by IS NULL AND revoked_at IS NULL ${useBranch ? 'AND branch_id = ?' : ''}`, useBranch ? [useBranch] : []);
    if (Number(pendingDevices) > 0 && atLeast(user.role, 'MANAGER')) actions.push({ key: 'devices', severity: 'INFO', count: Number(pendingDevices), label: `${pendingDevices} device(s) awaiting approval`, route: '/attendance?tab=devices' });
    const flaggedAttendance = await db.scalar(`SELECT COUNT(*) FROM staff_attendance a WHERE a.is_deleted = 0 AND a.flagged = 1 AND a.reviewed_by IS NULL ${useBranch ? 'AND a.branch_id = ?' : (business ? 'AND a.business_id = ?' : '')}`, useBranch ? [useBranch] : (business ? [String(business.id)] : []));
    if (Number(flaggedAttendance) > 0 && atLeast(user.role, 'MANAGER')) actions.push({ key: 'attendance', severity: 'WARN', count: Number(flaggedAttendance), label: `${flaggedAttendance} clock-in(s) flagged for review`, route: '/attendance?filter=unreviewed' });

    const myTill = await db.first("SELECT * FROM till_sessions WHERE branch_id = ? AND user_id = ? AND status = 'OPEN' AND is_deleted = 0 ORDER BY opened_at DESC LIMIT 1",
      [String(branch ? branch.id : user.branch_id), String(user.id)]);

    ctx.json({
      ok: true,
      generatedAt: watNow(),
      // The WAT date, under a name that does not collide with the `today` block
      // below. This line used to be a bare `today,` shorthand — which the object
      // literal below then OVERWROTE, so the date silently vanished and esbuild
      // warned about a duplicate key that nobody had read.
      date: today,
      view: isOwnerView ? 'GROUP' : (scope.allBranches ? 'BUSINESS' : (useBranch ? 'BRANCH' : 'ALL_ACCESSIBLE')),
      scope: { business: business ? business.name : 'All businesses', branch: useBranch ? (branch && branch.name) : 'All branches' },
      user: { id: user.id, name: user.full_name || user.username, role: user.role, navigation: navigationFor(user.role) },

      today: {
        sales: Number(todaySales.count) || 0,
        // `count` and `gross` are the names the dashboard client reads. Without
        // them the KPI fell back through a chain of keys that did not exist and
        // printed "0 sales" beside real takings — a wrong number, on the first
        // screen the owner opens, looking exactly like a quiet morning.
        count: Number(todaySales.count) || 0,
        gross: grossToday,
        grossRevenue: grossToday,
        vat: vatToday,
        // Net of VAT throughout: gross contains money that belongs to FIRS, so
        // every margin derived from it would be understated.
        netRevenue: netToday,
        cogs: cogsToday,
        grossMargin: marginToday,
        grossMarginPct: netToday > 0 ? round2((marginToday / netToday) * 100) : 0,
        averageSale: round2(Number(todaySales.average)),
        outstanding: round2(Number(todaySales.outstanding)),
        deliveryFees: round2(Number(todaySales.delivery)),
        voids: { count: Number(todayVoids.count) || 0, value: round2(Number(todayVoids.value)) },
        // Change against yesterday, because a number on its own does not tell a
        // trader whether today is good.
        vsYesterday: {
          gross: grossYesterday,
          change: round2(grossToday - grossYesterday),
          changePct: grossYesterday > 0 ? round2(((grossToday - grossYesterday) / grossYesterday) * 100) : null,
        },
        byMethod: byMethod.map((m) => ({ method: m.method, amount: round2(Number(m.amount)), count: Number(m.count) })),
      },

      period: {
        from, to,
        sales: Number(period.count) || 0,
        grossRevenue: round2(Number(period.gross)),
        vat: round2(Number(period.vat)),
        netRevenue: periodNet,
        cogs: round2(Number(periodCogs.cogs)),
        grossMargin: periodMargin,
        grossMarginPct: periodNet > 0 ? round2((periodMargin / periodNet) * 100) : 0,
        outstanding: round2(Number(period.outstanding)),
        series: series.map((r) => ({ day: r.day, sales: Number(r.count) || 0, gross: round2(Number(r.gross)), net: round2(Number(r.gross) - Number(r.vat)) })),
      },

      stock: {
        units: round2(Number(stock.units)),
        atCost: round2(Number(stock.at_cost)),
        atRetail: round2(Number(stock.at_retail)),
        potentialMargin: round2(Number(stock.at_retail) - Number(stock.at_cost)),
        products: Number(stock.products) || 0,
        lowStockCount: Number(lowStockCount) || 0,
        lowStock,
        expiringSoon,
      },

      topProducts: topProducts.map((r) => ({ ...r, units: round2(Number(r.units)), revenue: round2(Number(r.revenue)), margin: round2(Number(r.margin)) })),
      topStaff: topStaff.map((r) => ({ ...r, revenue: round2(Number(r.revenue)) })),

      cash: {
        safeBalance: round2(Number(safe.balance)),
        openTills: openTills.map((t) => ({ id: t.id, branch: t.branch_name, cashier: t.cashier_name, openedAt: utcToWat(t.opened_at), grandTotal: round2(Number(t.grand_total)), saleCount: Number(t.sale_count) })),
        ledgerAccounts: cash,
        variance: {
          net: round2(Number(variance.net)),
          shortages: round2(Number(variance.shortages)),
          surpluses: round2(Number(variance.surpluses)),
          closedTills: Number(variance.closed) || 0,
          unreviewed: Number(variance.unreviewed) || 0,
        },
        myTill: myTill ? { id: myTill.id, openedAt: utcToWat(myTill.opened_at), openingCash: round2(Number(myTill.opening_cash)), cashSales: round2(Number(myTill.cash_sales_total)), grandTotal: round2(Number(myTill.grand_total)), saleCount: Number(myTill.sale_count), expectedCash: round2(Number(myTill.opening_cash) + Number(myTill.cash_sales_total) - Number(myTill.refund_total)) } : null,
      },

      debtors,
      byBranch,
      byBusiness,
      actions,

      // Plan usage is shown to an owner because running out of branch or staff
      // slots stops them working, and finding out at the moment of hiring is the
      // worst time. Only is_active rows count towards the limit.
      plan: isOwnerView || atLeast(user.role, 'OWNER') ? await planUsage(db, settings) : null,
    });
  });

  /** A lightweight health/summary card for the sign-in screen and the PWA shell. */
  app.get(`${base}/dashboard/summary`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const branch = await resolveBranch(db, ctx, { required: false });
    const today = watToday();
    const sc = branch ? 'AND s.branch_id = ?' : '';
    const params = branch ? [today, String(branch.id)] : [today];
    const t = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(s.total),0) AS gross FROM sales s
        WHERE ${COUNTS} AND date(s.sold_at) = ? ${sc}`, params);
    const lowCount = await db.scalar(`SELECT COUNT(*) FROM (
        SELECT sb.product_id FROM stock_batches sb JOIN products p ON p.id = sb.product_id
        WHERE sb.is_deleted = 0 AND sb.status NOT IN ('QUARANTINED','EXPIRED') ${branch ? 'AND sb.branch_id = ?' : ''}
        GROUP BY sb.product_id HAVING p.reorder_level > 0 AND SUM(sb.quantity - sb.quantity_reserved) <= p.reorder_level)`,
    branch ? [String(branch.id)] : []);
    ctx.json({
      ok: true, today,
      salesToday: Number(t.count) || 0,
      grossToday: round2(Number(t.gross)),
      lowStockCount: Number(lowCount) || 0,
      role: user.role,
      navigation: navigationFor(user.role),
    });
  });
}

module.exports = { mount };
