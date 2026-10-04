// =====================================================================
// StockRidge — DASHBOARD, REPORTING, AUDIT, SYNC & ADMIN ROUTES
// =====================================================================

const { createRouter, HttpError } = require('../lib/http');
const { watDate, watNowIso, addDays } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { assertRole, assertBranchAccess, resolveScopedBranchId, ROLES, jobTitleOf } = require('../lib/roles');
const dashboardService = require('../services/dashboardService');
const syncService = require('../services/syncService');
const { writeAudit, queryAudit } = require('../lib/audit');
const { planSummary, getUnitSettings, activeBranchCount, activeStaffCount, productCount } = require('../lib/planLimits');

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------
function dashboardRoutes(getDb) {
  const app = createRouter();

  // The role-shaped landing screen. One endpoint, four shapes — see the header
  // comment in dashboardService.js for why a single screen for everyone is
  // wrong in both directions.
  app.get('/', async (c) => {
    const db = getDb();
    const role = String(c.var.user.role).toUpperCase();
    if (role === 'STAFF') return c.json(await dashboardService.staff(db, c.serviceCtx));
    if (role === 'MANAGER') return c.json(await dashboardService.manager(db, c.serviceCtx, {
      branchId: c.req.query('branch_id') || null,
      startDate: c.req.query('from') || null, endDate: c.req.query('to') || null,
    }));
    return c.json(await dashboardService.owner(db, c.serviceCtx, {
      startDate: c.req.query('from') || null, endDate: c.req.query('to') || null,
    }));
  });

  app.get('/exceptions', async (c) => {
    const db = getDb();
    return c.json(await dashboardService.exceptions(db, {
      businessUnitId: c.var.businessUnitId,
      branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
    }));
  });

  app.get('/cash', async (c) => {
    const db = getDb();
    return c.json(await dashboardService.cashPosition(db, {
      businessUnitId: c.var.businessUnitId,
      branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
    }));
  });

  app.get('/plan', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'view the subscription plan' });
    const db = getDb();
    return c.json(await planSummary(db, c.var.businessUnitId));
  });

  return app;
}

// ---------------------------------------------------------------------
// REPORTS
// ---------------------------------------------------------------------
function reportRoutes(getDb) {
  const app = createRouter();

  const range = (c) => ({
    startDate: c.req.query('from') || c.req.query('start_date') || addDays(watDate(), -29),
    endDate: c.req.query('to') || c.req.query('end_date') || watDate(),
  });

  app.get('/sales', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the sales report' });
    const db = getDb();
    const { startDate, endDate } = range(c);
    return c.json(await dashboardService.periodFigures(db, {
      businessUnitId: c.var.businessUnitId,
      branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      startDate, endDate,
      compareStartDate: c.req.query('compare') === '1' ? addDays(startDate, -30) : null,
      compareEndDate: c.req.query('compare') === '1' ? addDays(endDate, -30) : null,
    }));
  });

  app.get('/sales-trend', async (c) => {
    const db = getDb();
    return c.json(await dashboardService.salesTrend(db, {
      businessUnitId: c.var.businessUnitId,
      branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      days: Math.min(365, Number(c.req.query('days')) || 30),
    }));
  });

  app.get('/branch-comparison', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'compare branches' });
    const db = getDb();
    const { startDate, endDate } = range(c);
    return c.json(await dashboardService.branchComparison(db, { businessUnitId: c.var.businessUnitId, startDate, endDate }));
  });

  app.get('/top-products', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view top products' });
    const db = getDb();
    const { startDate, endDate } = range(c);
    return c.json({
      results: await dashboardService.topProducts(db, {
        businessUnitId: c.var.businessUnitId,
        branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
        startDate, endDate, metric: c.req.query('metric') || 'revenue', limit: c.req.query('limit') || 20,
      }),
    });
  });

  // Category P&L. The question behind "which department actually makes money?"
  app.get('/category-performance', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view category performance' });
    const db = getDb();
    const { startDate, endDate } = range(c);
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT pc.id AS category_id, COALESCE(pc.label, 'Uncategorised') AS category,
             COALESCE(SUM(si.line_total),0) AS revenue,
             COALESCE(SUM(si.unit_cost * si.quantity_base),0) AS cogs,
             COALESCE(SUM(si.gross_margin),0) AS gross_margin,
             COALESCE(SUM(si.discount_amount),0) AS discounts,
             COALESCE(SUM(si.quantity_base),0) AS units,
             COUNT(DISTINCT si.sale_id) AS sales
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.is_deleted = 0 AND s.status <> 'VOIDED'
      LEFT JOIN product_categories pc ON pc.id = si.category_id
      WHERE si.is_deleted = 0 AND si.business_unit_id = ? AND si.is_service_line = 0
        AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
        ${scoped ? 'AND s.branch_id = ?' : ''}
      GROUP BY pc.id, COALESCE(pc.label,'Uncategorised')
      ORDER BY revenue DESC
    `).bind(c.var.businessUnitId, startDate, endDate, ...(scoped ? [scoped] : [])).all();

    const services = await db.prepare(`
      SELECT si.service_type, COALESCE(SUM(si.line_total),0) AS revenue, COUNT(DISTINCT si.sale_id) AS sales
      FROM sale_items si JOIN sales s ON s.id = si.sale_id AND s.is_deleted = 0 AND s.status <> 'VOIDED'
      WHERE si.is_deleted = 0 AND si.is_service_line = 1 AND si.business_unit_id = ?
        AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
        ${scoped ? 'AND s.branch_id = ?' : ''}
      GROUP BY si.service_type ORDER BY revenue DESC
    `).bind(c.var.businessUnitId, startDate, endDate, ...(scoped ? [scoped] : [])).all();

    const total = round2(rows.results.reduce((a, r) => a + Number(r.revenue), 0));
    return c.json({
      period: { start: startDate, end: endDate },
      categories: rows.results.map((r) => {
        const revenue = round2(Number(r.revenue));
        const margin = round2(Number(r.gross_margin));
        return {
          ...r, revenue, cogs: round2(r.cogs), gross_margin: margin,
          discounts: round2(r.discounts), units: round2(r.units),
          margin_percent: revenue > 0 ? round2((margin / revenue) * 100) : 0,
          revenue_share_percent: total > 0 ? round2((revenue / total) * 100) : 0,
        };
      }),
      services: services.results.map((r) => ({ ...r, revenue: round2(r.revenue) })),
      total_revenue: total,
      total_margin: round2(rows.results.reduce((a, r) => a + Number(r.gross_margin), 0)),
      // An uncategorised bucket large enough to matter is a data-quality
      // problem, not a reporting one: it means nobody knows which department
      // that revenue belongs to.
      advisory: rows.results.find((r) => !r.category_id) && Number(rows.results.find((r) => !r.category_id).revenue) / Math.max(1, total) > 0.1
        ? 'More than 10% of revenue has no category. Assign categories to those products — an uncategorised bucket that large means you cannot tell which department earns its rent.'
        : null,
    });
  });

  // Payment-method mix. Cash-heavy branches are robbery risks and reconciliation
  // burdens; a shift toward transfers is worth knowing about.
  app.get('/payment-methods', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the payment mix' });
    const db = getDb();
    const { startDate, endDate } = range(c);
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT sp.method, COUNT(*) AS transactions, COALESCE(SUM(sp.amount),0) AS total,
             COALESCE(SUM(sp.change_given),0) AS change_given,
             COUNT(DISTINCT sp.sale_id) AS sales
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id AND s.is_deleted = 0 AND s.status <> 'VOIDED'
      WHERE sp.is_deleted = 0 AND sp.business_unit_id = ?
        AND date(sp.received_at,'+1 hour') BETWEEN ? AND ?
        ${scoped ? 'AND sp.branch_id = ?' : ''}
      GROUP BY sp.method ORDER BY total DESC
    `).bind(c.var.businessUnitId, startDate, endDate, ...(scoped ? [scoped] : [])).all();

    const total = round2(rows.results.reduce((a, r) => a + Number(r.total), 0));
    const cash = rows.results.find((r) => r.method === 'CASH');
    return c.json({
      period: { start: startDate, end: endDate },
      results: rows.results.map((r) => ({ ...r, total: round2(r.total), share_percent: total > 0 ? round2((Number(r.total) / total) * 100) : 0 })),
      total,
      cash_share_percent: total > 0 && cash ? round2((Number(cash.total) / total) * 100) : 0,
      advisory: total > 0 && cash && Number(cash.total) / total > 0.6
        ? `Cash is ${round2((Number(cash.total) / total) * 100)}% of takings. That is a robbery exposure and a daily reconciliation burden — encouraging POS and transfer reduces both, and the payment mix is the metric that shows whether it is working.`
        : null,
    });
  });

  // Staff performance, including the void-rate shrinkage signal.
  app.get('/staff-performance', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view staff performance' });
    const db = getDb();
    const { startDate, endDate } = range(c);
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT u.id AS user_id, u.full_name AS user_name, u.role, u.job_title, b.name AS branch_name,
             COUNT(s.id) AS sales,
             COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END),0) AS revenue,
             COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN si.gross_margin ELSE 0 END),0) AS gross_margin,
             COALESCE(SUM(s.discount_amount),0) AS discounts,
             SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS voids,
             COALESCE(SUM(CASE WHEN s.status = 'VOIDED' THEN s.total ELSE 0 END),0) AS voided_value,
             COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.balance_due ELSE 0 END),0) AS credit_extended,
             COUNT(DISTINCT s.customer_id) AS customers_served
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      LEFT JOIN sales s ON s.sold_by = u.id AND s.is_deleted = 0 AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
        ${scoped ? 'AND s.branch_id = ?' : ''}
      LEFT JOIN sale_items si ON si.sale_id = s.id AND si.is_deleted = 0
      WHERE u.business_unit_id = ? AND u.is_deleted = 0 AND u.role <> 'ADMIN'
        ${scoped ? 'AND (u.branch_id = ? OR u.branch_id IS NULL)' : ''}
      GROUP BY u.id, u.full_name, u.role, u.job_title, b.name
      HAVING COUNT(s.id) > 0
      ORDER BY revenue DESC
    `).bind(startDate, endDate, ...(scoped ? [scoped] : []), c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();

    const results = rows.results.map((r) => {
      const sales = Number(r.sales) || 0;
      const revenue = round2(Number(r.revenue) || 0);
      return {
        ...r, job_title: jobTitleOf(r), revenue,
        gross_margin: round2(Number(r.gross_margin) || 0),
        discounts: round2(Number(r.discounts) || 0),
        voided_value: round2(Number(r.voided_value) || 0),
        credit_extended: round2(Number(r.credit_extended) || 0),
        average_sale: sales > 0 ? round2(revenue / Math.max(1, sales - Number(r.voids))) : 0,
        void_rate_percent: sales > 0 ? round2((Number(r.voids) / sales) * 100) : 0,
        discount_rate_percent: revenue > 0 ? round2((Number(r.discounts) / revenue) * 100) : 0,
        margin_percent: revenue > 0 ? round2((Number(r.gross_margin) / revenue) * 100) : 0,
      };
    });

    // The void rate is a RELATIVE signal. Flagging anyone above an absolute
    // threshold punishes the cashier on the quiet counter; comparing each
    // person against the group median is what actually finds an outlier.
    const rates = results.map((r) => r.void_rate_percent).sort((a, b) => a - b);
    const median = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
    for (const r of results) {
      r.void_rate_outlier = r.sales >= 10 && median > 0 && r.void_rate_percent > median * 2.5;
    }

    return c.json({
      period: { start: startDate, end: endDate },
      results,
      median_void_rate_percent: median,
      outliers: results.filter((r) => r.void_rate_outlier).map((r) => ({ user_name: r.user_name, void_rate_percent: r.void_rate_percent, sales: r.sales })),
      advisory: results.some((r) => r.void_rate_outlier)
        ? 'One or more cashiers void at more than 2.5× the group median. That is a lightweight shrinkage signal, not proof of anything — but it is worth a conversation and a look at the specific receipts before the pattern becomes a habit.'
        : null,
    });
  });

  app.get('/stock', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the stock report' });
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const byBranch = await db.prepare(`
      SELECT * FROM v_stock_value_by_branch WHERE business_unit_id = ? ${scoped ? 'AND branch_id = ?' : ''}
      ORDER BY value_at_cost DESC
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();
    const slow = await db.prepare(`
      SELECT p.id AS product_id, p.name AS product_name, p.sku, b.name AS branch_name,
             COALESCE(SUM(sb.quantity_remaining),0) AS on_hand,
             COALESCE(SUM(sb.quantity_remaining * sb.unit_cost),0) AS value_at_cost,
             COALESCE((SELECT SUM(si.quantity_base) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                       WHERE si.product_id = p.id AND s.branch_id = sb.branch_id AND si.is_deleted = 0
                         AND s.is_deleted = 0 AND s.status <> 'VOIDED'
                         AND date(s.occurred_at,'+1 hour') >= date('now','+1 hour','-90 days')),0) AS sold_90d
      FROM stock_batches sb JOIN products p ON p.id = sb.product_id JOIN branches b ON b.id = sb.branch_id
      WHERE sb.business_unit_id = ? AND sb.is_deleted = 0 ${scoped ? 'AND sb.branch_id = ?' : ''}
        AND sb.status NOT IN ('EXPIRED','RECALLED','RETURNED_TO_SUPPLIER')
      GROUP BY p.id, p.name, p.sku, b.name, sb.branch_id
      HAVING on_hand > 0
      ORDER BY (CAST(sold_90d AS REAL) / MAX(1, on_hand)) ASC, value_at_cost DESC
      LIMIT 25
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();

    return c.json({
      by_branch: byBranch.results.map((r) => ({ ...r, value_at_cost: round2(r.value_at_cost), value_at_retail: round2(r.value_at_retail), total_units: round2(r.total_units) })),
      total_at_cost: round2(byBranch.results.reduce((a, r) => a + Number(r.value_at_cost), 0)),
      // DEAD STOCK is the report a growing retailer most needs and least often
      // has. Stock that has not sold in 90 days is cash in a warehouse, and it
      // does not become more saleable with time.
      slow_moving: slow.results.map((r) => ({
        ...r, on_hand: round2(r.on_hand), value_at_cost: round2(r.value_at_cost), sold_90d: round2(r.sold_90d),
        months_of_cover: Number(r.sold_90d) > 0 ? round2((Number(r.on_hand) / Number(r.sold_90d)) * 3) : null,
      })),
      dead_stock_value: round2(slow.results.filter((r) => Number(r.sold_90d) === 0).reduce((a, r) => a + Number(r.value_at_cost), 0)),
      advisory: slow.results.some((r) => Number(r.sold_90d) === 0)
        ? `${slow.results.filter((r) => Number(r.sold_90d) === 0).length} product(s) have not sold in 90 days. Stock that does not turn is not an asset — it is cash sitting on a shelf, and it does not become more saleable with time.`
        : null,
    });
  });

  app.get('/audit', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'read the audit trail' });
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const results = await queryAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      userId: c.req.query('user_id') || null, action: c.req.query('action') || null,
      entityType: c.req.query('entity_type') || null, entityId: c.req.query('entity_id') || null,
      from: c.req.query('from') || null, to: c.req.query('to') || null,
      limit: Math.min(500, Number(c.req.query('limit')) || 200), offset: Number(c.req.query('offset')) || 0,
    });
    const actions = await db.prepare(`
      SELECT action, COUNT(*) AS n FROM audit_log
      WHERE business_unit_id = ? AND occurred_at >= datetime('now','+1 hour','-90 days')
      GROUP BY action ORDER BY n DESC LIMIT 60
    `).bind(c.var.businessUnitId).all();
    return c.json({ results, actions: actions.results });
  });

  app.get('/void-audit', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the void audit' });
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT * FROM v_void_audit_by_user WHERE business_unit_id = ? ${scoped ? 'AND branch_id = ?' : ''}
      ORDER BY void_rate_percent DESC
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();
    return c.json({
      results: rows.results.map((r) => ({ ...r, voided_value: round2(r.voided_value), total_discount_given: round2(r.total_discount_given) })),
      note: 'A cashier whose void rate is an outlier against their peers is worth a conversation long before an audit finds anything. This is a signal, not a verdict.',
    });
  });

  return app;
}

// ---------------------------------------------------------------------
// SYNC
// ---------------------------------------------------------------------
function syncRoutes(getDb) {
  const app = createRouter();

  app.post('/heartbeat', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await syncService.heartbeat(db, c.serviceCtx, {
      branchId: body.branch_id || c.var.user.branch_id,
      deviceId: body.device_id || c.var.deviceId,
      appVersion: body.app_version || c.req.header('X-App-Version'),
      pendingPushCount: body.pending_push_count || 0,
      queueOldestAt: body.queue_oldest_at || null,
      lastError: body.last_error || null,
    }));
  });

  app.post('/push', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await syncService.push(db, c.serviceCtx, {
      branchId: body.branch_id || c.var.user.branch_id,
      deviceId: body.device_id || c.var.deviceId,
      changes: body.changes,
    }));
  });

  app.post('/pull', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await syncService.pull(db, c.serviceCtx, {
      branchId: body.branch_id || c.var.user.branch_id,
      deviceId: body.device_id || c.var.deviceId,
      since: body.since || c.req.query('since') || null,
      tables: body.tables || null,
    }));
  });

  app.get('/status', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view sync status' });
    const db = getDb();
    return c.json({
      results: await syncService.overview(db, {
        businessUnitId: c.var.businessUnitId,
        branchId: c.req.query('branch_id') || null,
      }),
    });
  });

  app.get('/log', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'read the sync log' });
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT scl.*, b.name AS branch_name FROM sync_change_log scl
      LEFT JOIN branches b ON b.id = scl.branch_id
      WHERE scl.business_unit_id = ? ${scoped ? 'AND scl.branch_id = ?' : ''}
        ${c.req.query('direction') ? 'AND scl.direction = ?' : ''}
      ORDER BY scl.synced_at DESC LIMIT ?
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : []),
      ...(c.req.query('direction') ? [String(c.req.query('direction')).toUpperCase()] : []),
      Math.min(500, Number(c.req.query('limit')) || 100)).all();
    return c.json({ results: rows.results });
  });

  app.get('/conflicts', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'review sync conflicts' });
    const db = getDb();
    return c.json({
      results: await syncService.conflicts(db, {
        businessUnitId: c.var.businessUnitId, unreviewedOnly: c.req.query('all') !== '1', limit: c.req.query('limit') || 100,
      }),
      note: 'Last-write-wins discards a losing write. Each row here is a discarded version captured BEFORE it was overwritten, so a concurrent offline edit that lost is a reviewable event rather than a silent data loss.',
    });
  });

  app.post('/conflicts/:id/review', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await syncService.reviewConflict(db, c.serviceCtx, {
      conflictId: c.req.param('id'), resolution: body.resolution, note: body.note,
    }));
  });

  return app;
}

// ---------------------------------------------------------------------
// ADMIN  (vendor/platform seat)
// ---------------------------------------------------------------------
function adminRoutes(getDb) {
  const app = createRouter();

  const requireAdmin = (c) => assertRole(c.var.user, ['ADMIN'], { action: 'use the platform administrator portal' });

  // Cross-business overview. The ADMIN seat is the vendor's, so it spans units.
  app.get('/overview', async (c) => {
    requireAdmin(c);
    const db = getDb();
    const rows = await db.prepare('SELECT * FROM v_plan_usage ORDER BY name').all();
    const sync = await db.prepare(`
      SELECT sync_health, COUNT(*) AS n FROM v_branch_sync_overview GROUP BY sync_health
    `).all();
    const chains = await require('../lib/audit').verifyAllChains(db, {});
    return c.json({
      business_units: rows.results,
      counts: {
        businesses: rows.results.length,
        branches: rows.results.reduce((a, r) => a + Number(r.branches_used), 0),
        staff: rows.results.reduce((a, r) => a + Number(r.staff_used), 0),
        products: rows.results.reduce((a, r) => a + Number(r.products_used), 0),
        suspended: rows.results.filter((r) => r.subscription_status === 'SUSPENDED').length,
        expired: rows.results.filter((r) => r.subscription_status === 'EXPIRED').length,
        trial: rows.results.filter((r) => r.subscription_status === 'TRIAL').length,
      },
      sync_health: Object.fromEntries(sync.results.map((r) => [r.sync_health, r.n])),
      register_chains: { total: chains.length, broken: chains.filter((x) => !x.verified).length, chains },
    });
  });

  app.get('/business-units', async (c) => {
    requireAdmin(c);
    const db = getDb();
    const rows = await db.prepare(`
      SELECT bu.*,
        (SELECT COUNT(*) FROM branches b WHERE b.business_unit_id = bu.id AND b.is_active = 1 AND b.is_deleted = 0) AS branches_used,
        (SELECT COUNT(*) FROM users u WHERE u.business_unit_id = bu.id AND u.role <> 'ADMIN' AND u.is_active = 1 AND u.is_deleted = 0) AS staff_used,
        (SELECT COUNT(*) FROM products p WHERE p.business_unit_id = bu.id AND p.is_deleted = 0) AS products_used
      FROM business_units bu WHERE bu.is_deleted = 0 ORDER BY bu.created_at DESC
    `).all();
    return c.json({ results: rows.results });
  });

  // Create a business unit. This is the vendor's onboarding action, and it is
  // where the industry profile is chosen — the single decision that configures
  // everything downstream.
  app.post('/business-units', async (c) => {
    requireAdmin(c);
    const db = getDb();
    const body = await c.req.json();
    const V = require('../../shared/validation');
    const { requireProfile, PROFILES } = require('../../shared/industryProfiles');

    const name = V.required(body.name, { field: 'Business name', max: 160 });
    if (name && name.error) throw new HttpError(400, name.error, 'VALIDATION_FAILED');
    const code = V.required(String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''), { field: 'Business code', max: 12 });
    if (code && code.error) throw new HttpError(400, code.error, 'VALIDATION_FAILED');
    if (code.length < 2) throw new HttpError(400, 'The business code must be at least 2 characters — it identifies the business at sign-in.', 'CODE_TOO_SHORT');
    const clash = await db.prepare('SELECT name FROM business_units WHERE code = ? AND is_deleted = 0').bind(code).first();
    if (clash) throw new HttpError(409, `Business code ${code} is already used by "${clash.name}".`, 'CODE_EXISTS');

    const profile = requireProfile(body.industry_profile);
    const ts = watNowIso();
    const id = newId();
    await db.prepare(`
      INSERT INTO business_units (
        id, code, name, industry_profile, legal_name, rc_number, tin, address, state, lga, phone, email,
        currency, timezone, max_branches, max_staff, max_products, subscription_status, subscription_plan,
        subscription_renewal_date, vat_enabled, vat_rate_percent, admin_contact_name, admin_contact_phone,
        admin_contact_email, notes, is_active, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?, date('now','+1 hour'),?,?)
    `).bind(
      id, code, name, profile.code,
      body.legal_name ? String(body.legal_name).slice(0, 200) : null,
      body.rc_number ? String(body.rc_number).slice(0, 40) : null,
      body.tin ? String(body.tin).slice(0, 20) : null,
      body.address ? String(body.address).slice(0, 400) : null,
      body.state ? require('../lib/geo').normaliseState(body.state) : null,
      body.lga ? String(body.lga).slice(0, 120) : null,
      body.phone ? String(body.phone).slice(0, 20) : null,
      body.email ? String(body.email).slice(0, 200) : null,
      'NGN', 'Africa/Lagos',
      Math.max(1, Number(body.max_branches) || 5), Math.max(1, Number(body.max_staff) || 25),
      Math.max(10, Number(body.max_products) || 5000),
      body.subscription_status ? String(body.subscription_status).toUpperCase() : 'TRIAL',
      body.subscription_plan || 'Standard',
      body.subscription_renewal_date ? String(body.subscription_renewal_date).slice(0, 10) : null,
      0, 7.5, 1, 1,
      body.admin_contact_name ? String(body.admin_contact_name).slice(0, 160) : null,
      body.admin_contact_phone ? String(body.admin_contact_phone).slice(0, 20) : null,
      body.admin_contact_email ? String(body.admin_contact_email).slice(0, 200) : null,
      body.notes ? String(body.notes).slice(0, 2000) : null, ts, ts
    ).run();

    // Seed the profile: categories, price tiers, expense categories, chart of
    // accounts and the WHT schedule. The client's first action must be able to
    // be "add a product", not "configure forty things".
    await require('../services/productService').seedProfileCategories(db, { businessUnitId: id, profile });
    for (let i = 0; i < profile.customer_tiers.length; i += 1) {
      const t = profile.customer_tiers[i];
      await db.prepare(`
        INSERT INTO price_tiers (id, business_unit_id, code, label, rank, is_default, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?, ?, 1,?,?)
      `).bind(newId(), id, t, t.replace(/_/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase()),
        profile.customer_tiers.length - i, i === 0 ? 1 : 0, ts, ts).run();
    }
    await require('../services/expenseService').seedCategories(db, id);
    await require('../services/glService').ensureChart(db, id);
    for (const r of require('../lib/wht').SEED_RATES) {
      await db.prepare(`
        INSERT INTO wht_rates (id, business_unit_id, code, label, category, direction, rate_percent,
          rate_percent_small_company, regulation_ref, effective_from, is_active, is_system, created_at, updated_at)
        VALUES (?, NULL,?,?,?,?,?,?,?, date('now','+1 hour'), 1, 1,?,?)
        ON CONFLICT DO NOTHING
      `).bind(newId(), r.code, r.label, r.category, r.direction, r.rate_percent, r.rate_percent_small_company,
        r.regulation_ref, ts, ts).run();
    }
    // Compliance scheme from the profile.
    if (profile.compliance) {
      await db.prepare(`
        INSERT INTO compliance_schemes (id, business_unit_id, code, label, regulator, applies_to, requires_expiry, renewal_warning_days, description, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?, 'ALL', ?, 60, ?, 1,?,?)
      `).bind(newId(), id, profile.compliance.scheme, profile.compliance.certificate_label,
        profile.compliance.regulator, profile.compliance.requires_expiry ? 1 : 0,
        profile.compliance.register_reason, ts, ts).run();
    }

    await writeAudit(db, {
      businessUnitId: id, userId: c.var.user.id, actorRole: 'ADMIN',
      action: 'BUSINESS_UNIT_CREATED', entityType: 'BUSINESS_UNIT', entityId: id,
      after: { name, code, industry_profile: profile.code },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });

    return c.json({
      ok: true, id, code, name, industry_profile: profile.code,
      profile_label: profile.label,
      seeded: {
        categories: profile.default_categories.length,
        price_tiers: profile.customer_tiers.length,
        expense_categories: require('../services/expenseService').DEFAULT_CATEGORIES.length,
        gl_accounts: require('../services/glService').CHART_OF_ACCOUNTS.length,
      },
      next_step: 'Create the OWNER account for this business, then a branch. Everything else is seeded from the profile.',
    }, 201);
  });

  const newId = () => require('../../shared/ids').newId();

  app.put('/business-units/:id', async (c) => {
    requireAdmin(c);
    const db = getDb();
    const id = c.req.param('id');
    const bu = await db.prepare('SELECT * FROM business_units WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!bu) throw new HttpError(404, 'That business was not found.', 'BUSINESS_UNIT_NOT_FOUND');
    const body = await c.req.json();
    const patch = {};
    const before = {};
    const record = (k, v) => { if (String(bu[k] ?? '') !== String(v ?? '')) { before[k] = bu[k]; patch[k] = v; } };

    const textKeys = ['name', 'legal_name', 'rc_number', 'tin', 'address', 'state', 'lga', 'phone', 'email', 'website',
      'subscription_plan', 'subscription_renewal_date', 'admin_contact_name', 'admin_contact_phone', 'admin_contact_email', 'notes'];
    for (const k of textKeys) {
      if (body[k] === undefined) continue;
      record(k, body[k] == null ? null : String(body[k]).trim().slice(0, 2000) || null);
    }
    const intKeys = ['max_branches', 'max_staff', 'max_products'];
    for (const k of intKeys) {
      if (body[k] === undefined) continue;
      const v = Number(body[k]);
      if (!Number.isFinite(v) || v < 1) throw new HttpError(400, `${k} must be 1 or more.`, 'PLAN_LIMIT_INVALID');
      record(k, Math.trunc(v));
    }
    const boolKeys = ['multi_branch_enabled', 'instalment_module_enabled', 'layaway_module_enabled', 'delivery_module_enabled',
      'warranty_module_enabled', 'wholesale_tier_enabled', 'attendance_module_enabled', 'compliance_register_enabled',
      'gl_module_enabled', 'offline_sync_enabled', 'vat_enabled', 'wht_enabled', 'vat_inclusive_pricing', 'is_active'];
    for (const k of boolKeys) {
      if (body[k] === undefined) continue;
      record(k, body[k] ? 1 : 0);
    }
    if (body.subscription_status !== undefined) {
      const s = String(body.subscription_status).toUpperCase();
      if (!['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED'].includes(s)) throw new HttpError(400, 'Subscription status must be TRIAL, ACTIVE, SUSPENDED or EXPIRED.', 'SUBSCRIPTION_STATUS_INVALID');
      record('subscription_status', s);
    }
    if (body.vat_rate_percent !== undefined) {
      const v = Number(body.vat_rate_percent);
      if (!Number.isFinite(v) || v < 0 || v > 50) throw new HttpError(400, 'The VAT rate must be between 0 and 50 percent.', 'VAT_RATE_INVALID');
      record('vat_rate_percent', v);
    }
    if (body.logo_data_url !== undefined) {
      const validated = require('../lib/branding').assertValidLogoDataUrl(body.logo_data_url);
      patch.logo_data_url = validated ? validated.dataUrl : null;
      before.logo_data_url = '[changed]';
    }
    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0 });

    // Turning a module OFF that has live data is refused rather than allowed,
    // because the data does not disappear — it becomes unreachable, which is
    // worse than either keeping it or deleting it.
    const moduleChecks = {
      instalment_module_enabled: ['payment_plans', 'ACTIVE'],
      layaway_module_enabled: ['layaway_holds', 'ACTIVE'],
      warranty_module_enabled: ['product_warranties', 'ACTIVE'],
      delivery_module_enabled: ['delivery_jobs', null],
      attendance_module_enabled: ['staff_attendance', null],
    };
    for (const [key, [table, statusValue]] of Object.entries(moduleChecks)) {
      if (patch[key] === 0 && bu[key] === 1) {
        const live = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business_unit_id = ? AND is_deleted = 0 ${statusValue ? `AND status = '${statusValue}'` : ''}`).bind(id).first();
        if (live.n > 0) {
          throw new HttpError(409,
            `This business has ${live.n} live ${table.replace(/_/g, ' ')} record(s). Turning the module off would not delete them — it would make them unreachable, which is worse than either keeping the module on or archiving the records first.`,
            'MODULE_HAS_LIVE_DATA');
        }
      }
    }

    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    await db.prepare(`UPDATE business_units SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((k) => patch[k]), id).run();
    await writeAudit(db, {
      businessUnitId: id, userId: c.var.user.id, actorRole: 'ADMIN',
      action: 'BUSINESS_UNIT_UPDATED', entityType: 'BUSINESS_UNIT', entityId: id,
      before, after: patch, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, changed: cols.length });
  });

  // Impersonation-style access for support. Deliberately NOT a silent
  // role-switch: it issues a scoped session that is recorded in the audit log
  // with a reason, so "the vendor was in our account" is always answerable.
  app.post('/business-units/:id/support-access', async (c) => {
    requireAdmin(c);
    const db = getDb();
    const id = c.req.param('id');
    const bu = await db.prepare('SELECT * FROM business_units WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!bu) throw new HttpError(404, 'That business was not found.', 'BUSINESS_UNIT_NOT_FOUND');
    const body = await c.req.json();
    if (!body.reason || String(body.reason).trim().length < 10) {
      throw new HttpError(400,
        'Support access needs a written reason of at least 10 characters. It is recorded in the client\u2019s audit log, and a client must be able to see why the vendor was in their account.',
        'SUPPORT_ACCESS_REASON_REQUIRED');
    }
    const authService = require('../lib/auth');
    const session = await authService.createSession(db, {
      user: c.var.user, businessUnitId: id, deviceId: c.var.deviceId,
      ipAddress: c.var.ipAddress, userAgent: c.var.userAgent, ttlHours: 2,
    });
    await writeAudit(db, {
      businessUnitId: id, userId: c.var.user.id, actorRole: 'ADMIN',
      action: 'ADMIN_SUPPORT_ACCESS', entityType: 'BUSINESS_UNIT', entityId: id,
      reason: String(body.reason).slice(0, 500), after: { expires_at: session.expiresAt },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({
      ok: true, token: session.token, business_unit_id: id, business_name: bu.name,
      expires_at: session.expiresAt, role: 'ADMIN',
      note: 'This session is recorded in the client\u2019s audit log with your reason. It expires in 2 hours.',
    });
  });

  // Data maintenance
  app.post('/maintenance', async (c) => {
    requireAdmin(c);
    const db = getDb();
    const results = {};
    results.idempotency_keys_pruned = await require('../lib/idempotency').pruneKeys(db, { keepHours: 48 });
    results.sync_log_pruned = await syncService.pruneSyncLog(db, { keepDays: 90 });
    results.login_attempts_pruned = await require('../lib/loginThrottle').pruneLoginAttempts(db, { keepDays: 90 });
    results.sessions_pruned = await require('../lib/auth').pruneSessions(db, { keepDays: 30 });
    // Expired layaway holds are flagged, not auto-forfeited: silently taking a
    // customer's deposit on a timer is how a shop loses a neighbourhood.
    results.layaway_expired = (await require('../services/layawayService').expireLapsed(db, {})).expired_count;
    const vacuum = await db.prepare('PRAGMA freelist_count').first().catch(() => null);
    results.freelist_pages = vacuum ? vacuum.freelist_count : null;
    await db.prepare(`INSERT INTO data_cleanup_log (business_unit_id, table_name, rows_deleted, retention_days, performed_by, note)
                      VALUES (NULL, 'MULTI', ?, 0, 'ADMIN', ?)`).bind(
      Object.values(results).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0),
      JSON.stringify(results).slice(0, 1000)).run().catch(() => {});
    return c.json({ ok: true, results, ran_at: watNowIso() });
  });

  app.get('/integrity', async (c) => {
    requireAdmin(c);
    const db = getDb();
    const units = await db.prepare('SELECT id, code, name FROM business_units WHERE is_deleted = 0').all();
    const out = [];
    for (const u of units.results) {
      const gl = await require('../services/glService').integrityCheck(db, { businessUnitId: u.id }).catch(() => null);
      const chains = await require('../lib/audit').verifyAllChains(db, { businessUnitId: u.id });
      // Stock versus movement ledger: the on-hand figure is a CACHE of the
      // movement ledger. When they disagree, the ledger wins — and the
      // disagreement is the thing worth knowing about.
      const drift = await db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT sb.branch_id, sb.product_id, SUM(sb.quantity_remaining) AS on_hand,
                 COALESCE((SELECT SUM(CASE WHEN m.direction = 'IN' THEN m.quantity ELSE -m.quantity END)
                           FROM stock_movements m
                           WHERE m.branch_id = sb.branch_id AND m.product_id = sb.product_id),0) AS ledger
          FROM stock_batches sb WHERE sb.business_unit_id = ? AND sb.is_deleted = 0
          GROUP BY sb.branch_id, sb.product_id
          HAVING ABS(on_hand - ledger) > 0.01
        )
      `).bind(u.id).first();
      out.push({
        business_unit: u,
        gl: gl ? { all_ok: gl.all_ok, checks: gl.checks } : null,
        register_chains: { total: chains.length, broken: chains.filter((x) => !x.verified).length },
        stock_ledger_drift_rows: drift ? drift.n : null,
      });
    }
    return c.json({
      results: out,
      all_ok: out.every((o) => (!o.gl || o.gl.all_ok) && o.register_chains.broken === 0 && (o.stock_ledger_drift_rows === 0 || o.stock_ledger_drift_rows == null)),
      checked_at: watNowIso(),
    });
  });

  return app;
}

module.exports = { dashboardRoutes, reportRoutes, syncRoutes, adminRoutes };
