'use strict';
// =====================================================================
// server/routes/reports.js — WHAT HAPPENED, AND WHAT IT MEANT
// =====================================================================
// Every figure here is derived from the ledger and the sales table by QUERY, and
// never stored. A stored "revenue today" column is wrong the moment a sale is
// voided, a return is processed, or a late posting lands; a derived one is right
// by construction. The cost is a heavier query, which is the correct trade —
// reports are read occasionally and must be right, sales are read constantly and
// must be fast.
//
// ONE DECISION APPLIES EVERYWHERE: `sold_at` is WEST AFRICA TIME and is the date
// a sale belongs to. `created_at` is UTC and is when the row was written. A
// report grouped by created_at puts a 9pm Saturday sale into Sunday, and a
// backdated offline sync into the day it was uploaded rather than the day it
// happened. Both are wrong in ways that are invisible until two reports
// disagree.
//
// REVENUE ALWAYS EXCLUDES VOIDS AND ALWAYS EXCLUDES VAT. A voided sale did not
// happen. VAT is not the business's money — it was collected for FIRS — so
// including it in revenue overstates turnover by 7.5% and makes every margin
// percentage meaningless.
// =====================================================================

const { HttpError } = require('../lib/http');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, scopeFilter, pagination, dateRange, numField, strField, boolField, valid } = require('../lib/respond');
const { round2 } = require('../../domain/money');
// `newId` was used at the sales-target insert without being imported here, so
// setting a target answered 500 "newId is not defined". node --check cannot see
// that; only calling the route can.
const { newId } = require('../../domain/crypto');
const { watToday, addDays } = require('../../domain/time');
const { oneOf } = require('../../domain/validation');
const { extractVatFromInclusive } = require('../../domain/nigerianTax');
const glService = require('../services/glService');

/**
 * The SQL fragment that defines "a sale that counts".
 *
 * Written once and reused by every report, because the definition has to be
 * identical everywhere. If the sales report excluded voids but the margin report
 * did not, the two would disagree and nobody would know which to believe.
 */
const COUNTS = "s.is_deleted = 0 AND s.status <> 'VOIDED'";

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // SALES
  // -------------------------------------------------------------------
  /**
   * Sales over a period, grouped by day, branch, product, category, payment
   * method and cashier — one call, because the POS dashboard needs all of them
   * and six round trips on a mobile connection is six chances to fail.
   */
  app.get(`${base}/reports/sales`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const settings = ctx.get('settings');
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const groupBy = valid(oneOf(ctx.req.queryParam('group_by') || 'DAY', ['DAY', 'WEEK', 'MONTH', 'BRANCH', 'CASHIER', 'CATEGORY', 'PRODUCT', 'PAYMENT_METHOD', 'SALE_TYPE'], { field: 'Group by' }), 'group_by');
    const useBranch = branch && ctx.req.queryParam('branch_scope') !== 'all' ? String(branch.id) : null;

    const where = [COUNTS, 'date(s.sold_at) BETWEEN ? AND ?', 's.business_id = ?'];
    const params = [from, to, String(business.id)];
    if (useBranch) { where.push('s.branch_id = ?'); params.push(useBranch); }
    if (!scope.allBranches && scope.branchIds && !useBranch) {
      const ids = [...scope.branchIds];
      where.push(`s.branch_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    const whereSql = where.join(' AND ');

    // The grouping key. `sold_at` is already WAT, so `date(sold_at)` is the
    // trading day — no conversion needed, and adding one would be the bug.
    const GROUP = {
      DAY: "date(s.sold_at)",
      WEEK: "strftime('%Y-W%W', s.sold_at)",
      MONTH: "strftime('%Y-%m', s.sold_at)",
      BRANCH: 's.branch_id',
      CASHIER: 's.salesperson_id',
      CATEGORY: 'si.category_id',
      PRODUCT: 'si.product_id',
      PAYMENT_METHOD: 's.payment_method',
      SALE_TYPE: 's.sale_type',
    }[groupBy];
    // Category and product reports must aggregate over LINES, not headers: one
    // sale can contain three categories, and grouping the header by a single
    // category would attribute the whole basket to whichever line came first.
    const lineLevel = ['CATEGORY', 'PRODUCT'].includes(groupBy);
    const selectValue = lineLevel ? 'si.line_total' : 's.total';
    const vatValue = lineLevel ? 'si.vat_amount' : 's.vat_amount';
    const costValue = lineLevel
      ? '(si.cost_price_snapshot * si.quantity_in_base)'
      : '(SELECT COALESCE(SUM(si2.cost_price_snapshot * si2.quantity_in_base),0) FROM sale_items si2 WHERE si2.sale_id = s.id AND si2.is_deleted = 0)';

    const grouped = await db.all(`
      SELECT ${GROUP} AS group_key,
             COUNT(DISTINCT s.id) AS transactions,
             COALESCE(SUM(${selectValue}),0) AS gross_revenue,
             COALESCE(SUM(${vatValue}),0) AS vat,
             COALESCE(SUM(${costValue}),0) AS cogs,
             COALESCE(SUM(s.discount_amount + COALESCE(s.order_discount_amount,0)),0) AS discounts,
             COALESCE(SUM(s.delivery_fee),0) AS delivery_fees,
             COALESCE(SUM(s.balance_due),0) AS outstanding
      ${lineLevel ? 'FROM sales s JOIN sale_items si ON si.sale_id = s.id AND si.is_deleted = 0' : 'FROM sales s'}
      ${lineLevel && groupBy === 'CATEGORY' ? 'LEFT JOIN product_categories pc ON pc.id = si.category_id' : ''}
      ${lineLevel && groupBy === 'PRODUCT' ? 'LEFT JOIN products pp ON pp.id = si.product_id' : ''}
      ${groupBy === 'BRANCH' ? 'LEFT JOIN branches bb ON bb.id = s.branch_id' : ''}
      ${groupBy === 'CASHIER' ? 'LEFT JOIN users uu ON uu.id = s.salesperson_id' : ''}
      WHERE ${whereSql}
      GROUP BY group_key
      ORDER BY gross_revenue DESC
      LIMIT 500`, params);

    // Attach a human label to each key. Done in a second pass rather than in the
    // GROUP BY so the aggregation stays cheap and index-friendly.
    const labels = new Map();
    if (groupBy === 'BRANCH') {
      for (const b of await db.all('SELECT id, name, code FROM branches WHERE is_deleted = 0')) labels.set(String(b.id), `${b.name}${b.code ? ` (${b.code})` : ''}`);
    } else if (groupBy === 'CASHIER') {
      for (const u of await db.all('SELECT id, full_name, username FROM users WHERE is_deleted = 0')) labels.set(String(u.id), u.full_name || u.username);
    } else if (groupBy === 'CATEGORY') {
      for (const c of await db.all('SELECT id, name, code FROM product_categories WHERE is_deleted = 0')) labels.set(String(c.id), c.name || c.code);
    } else if (groupBy === 'PRODUCT') {
      for (const p of await db.all('SELECT id, name, sku FROM products WHERE is_deleted = 0')) labels.set(String(p.id), `${p.name}${p.sku ? ` [${p.sku}]` : ''}`);
    }

    const vatRate = Number(settings.vat_rate_percent) || 7.5;
    const rows = grouped.map((r) => {
      const gross = round2(Number(r.gross_revenue));
      const vat = round2(Number(r.vat));
      // NET revenue is what the business actually earned. Gross includes VAT that
      // belongs to FIRS, so a margin computed on gross is understated by the tax.
      const net = round2(gross - vat);
      const cogs = round2(Number(r.cogs));
      const margin = round2(net - cogs);
      return {
        key: r.group_key,
        label: labels.get(String(r.group_key)) || (['DAY', 'WEEK', 'MONTH'].includes(groupBy) ? String(r.group_key) : String(r.group_key || 'Unspecified').replace(/_/g, ' ')),
        transactions: Number(r.transactions) || 0,
        grossRevenue: gross, vat, netRevenue: net, cogs,
        grossMargin: margin,
        grossMarginPct: net > 0 ? round2((margin / net) * 100) : 0,
        discounts: round2(Number(r.discounts)),
        deliveryFees: round2(Number(r.delivery_fees)),
        outstanding: round2(Number(r.outstanding)),
        averageTransaction: Number(r.transactions) ? round2(gross / Number(r.transactions)) : 0,
      };
    }).sort((a, b) => (['DAY', 'WEEK', 'MONTH'].includes(groupBy) ? String(a.key).localeCompare(String(b.key)) : b.grossRevenue - a.grossRevenue));

    const totals = rows.reduce((a, r) => ({
      transactions: a.transactions + r.transactions,
      grossRevenue: round2(a.grossRevenue + r.grossRevenue),
      vat: round2(a.vat + r.vat),
      netRevenue: round2(a.netRevenue + r.netRevenue),
      cogs: round2(a.cogs + r.cogs),
      grossMargin: round2(a.grossMargin + r.grossMargin),
      discounts: round2(a.discounts + r.discounts),
      deliveryFees: round2(a.deliveryFees + r.deliveryFees),
      outstanding: round2(a.outstanding + r.outstanding),
    }), { transactions: 0, grossRevenue: 0, vat: 0, netRevenue: 0, cogs: 0, grossMargin: 0, discounts: 0, deliveryFees: 0, outstanding: 0 });

    const voided = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(s.total),0) AS value
        FROM sales s WHERE s.is_deleted = 0 AND s.status = 'VOIDED' AND s.business_id = ?
          AND date(s.sold_at) BETWEEN ? AND ? ${useBranch ? 'AND s.branch_id = ?' : ''}`,
    useBranch ? [String(business.id), from, to, useBranch] : [String(business.id), from, to]);

    ctx.json({
      ok: true, range: { from, to }, groupBy,
      scope: useBranch ? { branch: (await db.first('SELECT name FROM branches WHERE id = ?', [useBranch]) || {}).name } : { business: business.name },
      rows, totals: { ...totals, grossMarginPct: totals.netRevenue > 0 ? round2((totals.grossMargin / totals.netRevenue) * 100) : 0 },
      voided: { count: Number(voided.count) || 0, value: round2(Number(voided.value)) },
      vatRatePercent: vatRate,
      // Stated plainly because the single most common misreading of a Nigerian
      // retail report is treating the gross figure as turnover.
      note: `Gross ₦${totals.grossRevenue.toLocaleString('en-NG')} includes ₦${totals.vat.toLocaleString('en-NG')} of VAT collected for FIRS. The business's own revenue is ₦${totals.netRevenue.toLocaleString('en-NG')}.`,
    });
  });

  // -------------------------------------------------------------------
  // INVENTORY
  // -------------------------------------------------------------------
  /**
   * Stock movement in and out over a period, per product.
   *
   * Built from SEPARATE aggregate queries joined in JavaScript rather than one
   * query of correlated subqueries. The correlated version needs the same branch
   * and date parameters bound repeatedly in an order that must exactly match the
   * placeholder order in a string assembled across six subqueries — which is the
   * kind of thing that is right the first time and silently wrong after any edit.
   * Six straightforward queries with obvious parameter lists cost a few
   * milliseconds more and cannot drift.
   */
  app.get(`${base}/reports/inventory-movement`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const days = Math.max(1, daysBetween(from, to));
    const bId = branch ? String(branch.id) : null;

    const products = await db.all(
      `SELECT p.id, p.name, p.sku, p.base_unit_name, p.cost_price, p.selling_price, p.reorder_level
         FROM products p WHERE p.is_deleted = 0 AND p.business_id = ? ORDER BY p.name`,
      [String(business.id)],
    );

    const onHand = await db.all(
      `SELECT sb.product_id, COALESCE(SUM(sb.quantity),0) AS qty, COALESCE(SUM(sb.quantity_reserved),0) AS reserved
         FROM stock_batches sb
        WHERE sb.is_deleted = 0 AND sb.status NOT IN ('QUARANTINED','EXPIRED')
          AND sb.business_id = ? ${bId ? 'AND sb.branch_id = ?' : ''}
        GROUP BY sb.product_id`,
      bId ? [String(business.id), bId] : [String(business.id)],
    );
    const reservedAll = await db.all(
      `SELECT sb.product_id, COALESCE(SUM(sb.quantity_reserved),0) AS reserved
         FROM stock_batches sb WHERE sb.is_deleted = 0 AND sb.business_id = ? ${bId ? 'AND sb.branch_id = ?' : ''}
        GROUP BY sb.product_id`,
      bId ? [String(business.id), bId] : [String(business.id)],
    );
    const sold = await db.all(
      `SELECT si.product_id,
              COALESCE(SUM(si.quantity_in_base),0) AS units,
              COALESCE(SUM(si.line_total),0) AS revenue,
              COALESCE(SUM(si.cost_price_snapshot * si.quantity_in_base),0) AS cogs
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE si.is_deleted = 0 AND ${COUNTS} AND s.business_id = ?
          AND date(s.sold_at) BETWEEN ? AND ? ${bId ? 'AND s.branch_id = ?' : ''}
        GROUP BY si.product_id`,
      bId ? [String(business.id), from, to, bId] : [String(business.id), from, to],
    );
    const adjusted = await db.all(
      `SELECT sa.product_id, COALESCE(SUM(sa.quantity),0) AS net_qty, COALESCE(SUM(ABS(sa.total_value)),0) AS value
         FROM stock_adjustments sa
        WHERE sa.is_deleted = 0 AND sa.business_id = ? AND date(sa.created_at) BETWEEN ? AND ?
          ${bId ? 'AND sa.branch_id = ?' : ''}
        GROUP BY sa.product_id`,
      bId ? [String(business.id), from, to, bId] : [String(business.id), from, to],
    );

    const idx = (rows, key = 'product_id') => new Map(rows.map((r) => [String(r[key]), r]));
    const mOnHand = idx(onHand); const mReserved = idx(reservedAll); const mSold = idx(sold); const mAdj = idx(adjusted);

    const data = products.map((p) => {
      const oh = mOnHand.get(String(p.id)) || {};
      const rs = mReserved.get(String(p.id)) || {};
      const sl = mSold.get(String(p.id)) || {};
      const aj = mAdj.get(String(p.id)) || {};
      const onHandQty = round2(Number(oh.qty) || 0);
      const reservedQty = round2(Number(rs.reserved) || 0);
      const unitsSold = round2(Number(sl.units) || 0);
      const revenue = round2(Number(sl.revenue) || 0);
      const cogs = round2(Number(sl.cogs) || 0);
      const netAdjusted = round2(Number(aj.net_qty) || 0);
      return {
        product_id: p.id, name: p.name, sku: p.sku, base_unit_name: p.base_unit_name,
        cost_price: Number(p.cost_price), selling_price: Number(p.selling_price), reorder_level: Number(p.reorder_level),
        on_hand: onHandQty, reserved: reservedQty, available: round2(onHandQty - reservedQty),
        units_sold: unitsSold, revenue, cogs,
        gross_margin: round2(revenue - cogs),
        gross_margin_pct: revenue > 0 ? round2(((revenue - cogs) / revenue) * 100) : 0,
        stock_value: round2(onHandQty * Number(p.cost_price)),
        net_adjusted: netAdjusted,
        adjustment_value: round2(Number(aj.value) || 0),
        units_per_day: round2(unitsSold / days),
        // Days of cover is the number that decides a reorder, and it is derived
        // from what actually sold rather than from a forecast.
        days_of_cover: unitsSold > 0 ? round2(onHandQty / (unitsSold / days)) : null,
        low_stock: Number(p.reorder_level) > 0 && onHandQty <= Number(p.reorder_level),
        out_of_stock: onHandQty - reservedQty <= 0,
        // Shrinkage as a share of what sold: high on a slow mover is noise, high
        // on a fast one is theft or a broken process.
        shrinkage_pct: unitsSold > 0 ? round2((Math.abs(netAdjusted) / unitsSold) * 100) : 0,
      };
    });

    const sort = String(ctx.req.queryParam('sort') || 'revenue').toLowerCase();
    const SORTS = {
      revenue: (a, b) => b.revenue - a.revenue,
      margin: (a, b) => b.gross_margin - a.gross_margin,
      stock_value: (a, b) => b.stock_value - a.stock_value,
      shrinkage: (a, b) => b.adjustment_value - a.adjustment_value,
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
      days_of_cover: (a, b) => (b.days_of_cover ?? 1e9) - (a.days_of_cover ?? 1e9),
    };
    data.sort(SORTS[sort] || SORTS.revenue);

    ctx.json({
      ok: true, range: { from, to }, days, sort, data, count: data.length,
      totals: {
        stockValue: round2(data.reduce((a, d) => a + d.stock_value, 0)),
        revenue: round2(data.reduce((a, d) => a + d.revenue, 0)),
        cogs: round2(data.reduce((a, d) => a + d.cogs, 0)),
        grossMargin: round2(data.reduce((a, d) => a + d.gross_margin, 0)),
        shrinkageValue: round2(data.reduce((a, d) => a + d.adjustment_value, 0)),
        lowStockCount: data.filter((d) => d.low_stock).length,
        outOfStockCount: data.filter((d) => d.out_of_stock).length,
      },
    });
  });

  /** Fast and slow movers — the reorder decision, made from evidence. */
  app.get(`${base}/reports/movers`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const kind = valid(oneOf(ctx.req.queryParam('kind') || 'FAST', ['FAST', 'SLOW', 'DEAD', 'SHRINKAGE'], { field: 'Report kind' }), 'kind');
    const days = Math.max(1, daysBetween(from, to));

    if (kind === 'SHRINKAGE') {
      const rows = await db.all(`SELECT p.id AS product_id, p.name, p.sku, p.base_unit_name,
            COALESCE(SUM(ABS(sa.quantity)),0) AS units_lost, COALESCE(SUM(ABS(sa.total_value)),0) AS value_lost,
            COUNT(sa.id) AS entries
          FROM stock_adjustments sa JOIN products p ON p.id = sa.product_id
          WHERE sa.is_deleted = 0 AND sa.business_id = ? AND date(sa.created_at) BETWEEN ? AND ?
            AND sa.adjustment_type IN ('DAMAGE','THEFT','EXPIRED','SHRINKAGE','WRITE_OFF')
            ${branch ? 'AND sa.branch_id = ?' : ''}
          GROUP BY p.id ORDER BY value_lost DESC LIMIT 50`,
      [String(business.id), from, to].concat(branch ? [String(branch.id)] : []));
      return ctx.json({ ok: true, kind, range: { from, to }, data: rows.map((r) => ({ ...r, units_lost: round2(Number(r.units_lost)), value_lost: round2(Number(r.value_lost)) })) });
    }

    const rows = await db.all(`SELECT p.id AS product_id, p.name, p.sku, p.base_unit_name, p.reorder_level, p.cost_price,
          COALESCE(SUM(si.quantity_in_base),0) AS units_sold,
          COALESCE(SUM(si.line_total),0) AS revenue,
          COALESCE(SUM(si.cost_price_snapshot * si.quantity_in_base),0) AS cogs,
          COUNT(DISTINCT s.id) AS transactions,
          (SELECT COALESCE(SUM(sb.quantity),0) FROM stock_batches sb WHERE sb.product_id = p.id AND sb.is_deleted = 0
             AND sb.status NOT IN ('QUARANTINED','EXPIRED') ${branch ? 'AND sb.branch_id = ?' : ''}) AS on_hand,
          MAX(date(s.sold_at)) AS last_sold
        FROM products p
        LEFT JOIN sale_items si ON si.product_id = p.id AND si.is_deleted = 0
        LEFT JOIN sales s ON s.id = si.sale_id AND ${COUNTS} AND date(s.sold_at) BETWEEN ? AND ?
              ${branch ? 'AND s.branch_id = ?' : ''}
        WHERE p.is_deleted = 0 AND p.business_id = ?
        GROUP BY p.id`,
    // Bind order follows the placeholder order: the on_hand subquery's branch
    // filter, then the sales join's dates and branch, then the outer business id.
    (branch ? [String(branch.id)] : []).concat([from, to], branch ? [String(branch.id)] : [], [String(business.id)]));

    let data = rows.map((r) => {
      const sold = round2(Number(r.units_sold));
      const revenue = round2(Number(r.revenue));
      const cogs = round2(Number(r.cogs));
      const onHand = round2(Number(r.on_hand));
      return {
        ...r, units_sold: sold, revenue, cogs, on_hand: onHand,
        per_day: round2(sold / days),
        gross_margin: round2(revenue - cogs),
        gross_margin_pct: revenue > 0 ? round2(((revenue - cogs) / revenue) * 100) : 0,
        days_of_cover: sold > 0 ? round2(onHand / (sold / days)) : null,
        stock_value: round2(onHand * Number(r.cost_price)),
        last_sold: r.last_sold,
        days_since_sold: r.last_sold ? daysBetween(r.last_sold, watToday()) : null,
      };
    });

    if (kind === 'FAST') data = data.filter((d) => d.units_sold > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 50);
    if (kind === 'SLOW') data = data.filter((d) => d.on_hand > 0 && d.units_sold > 0 && d.days_of_cover > 90).sort((a, b) => b.stock_value - a.stock_value).slice(0, 50);
    if (kind === 'DEAD') data = data.filter((d) => d.on_hand > 0 && d.units_sold === 0).sort((a, b) => b.stock_value - a.stock_value).slice(0, 50);

    ctx.json({
      ok: true, kind, range: { from, to }, days, data,
      // The dead-stock figure is the one worth acting on: it is cash sitting on a
      // shelf that is not turning, and it does not appear as a loss anywhere.
      summary: {
        products: data.length,
        stockValue: round2(data.reduce((a, d) => a + d.stock_value, 0)),
        revenue: round2(data.reduce((a, d) => a + d.revenue, 0)),
        message: kind === 'DEAD'
          ? `${data.length} product(s) holding ₦${round2(data.reduce((a, d) => a + d.stock_value, 0)).toLocaleString('en-NG')} of stock sold nothing in ${days} days. That is working capital doing nothing — discount it, transfer it to a branch where it moves, or return it.`
          : kind === 'SLOW'
            ? `${data.length} product(s) have more than 90 days of cover. Reordering any of them would tie up more cash.`
            : `${data.length} top product(s) by revenue for the period.`,
      },
    });
  });

  // -------------------------------------------------------------------
  // CUSTOMERS / STAFF
  // -------------------------------------------------------------------
  app.get(`${base}/reports/top-customers`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 90 });
    const rows = await db.all(`SELECT c.id, c.name, c.company_name, c.phone, c.credit_limit, c.credit_balance,
          cc.name AS class_name,
          COUNT(s.id) AS purchases, COALESCE(SUM(s.total),0) AS revenue,
          COALESCE(SUM(s.balance_due),0) AS outstanding, MIN(s.sold_at) AS first_purchase, MAX(s.sold_at) AS last_purchase
        FROM customers c
        LEFT JOIN sales s ON s.customer_id = c.id AND ${COUNTS.replace(/\bs\./g, 's.')} AND date(s.sold_at) BETWEEN ? AND ?
        LEFT JOIN customer_classes cc ON cc.id = c.customer_class_id
        WHERE c.is_deleted = 0 AND c.business_id = ?
        GROUP BY c.id HAVING purchases > 0
        ORDER BY revenue DESC LIMIT 100`, [from, to, String(business.id)]);
    ctx.json({
      ok: true, range: { from, to },
      data: rows.map((r) => ({ ...r, revenue: round2(Number(r.revenue)), outstanding: round2(Number(r.outstanding)), averagePurchase: round2(Number(r.revenue) / Math.max(1, Number(r.purchases))) })),
      // Concentration risk: if the top five customers are most of the revenue,
      // losing one is an existential event rather than a bad month.
      concentration: (() => {
        const total = round2(rows.reduce((a, r) => a + Number(r.revenue), 0));
        const top5 = round2(rows.slice(0, 5).reduce((a, r) => a + Number(r.revenue), 0));
        return { total, top5, top5Pct: total > 0 ? round2((top5 / total) * 100) : 0 };
      })(),
    });
  });

  /** Commission per salesperson — derived, so it always matches the sales report. */
  app.get(`${base}/reports/commission`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const rows = await db.all(`SELECT u.id, u.full_name, u.username, u.role, u.commission_rate_pct, b.name AS branch_name,
          COUNT(s.id) AS sales, COALESCE(SUM(s.total),0) AS revenue,
          COALESCE(SUM(s.total - s.vat_amount),0) AS net_revenue,
          (SELECT COALESCE(SUM(si.margin),0) FROM sale_items si JOIN sales s2 ON s2.id = si.sale_id
             WHERE s2.salesperson_id = u.id AND si.is_deleted = 0 AND ${COUNTS.replace(/\bs\./g, 's2.')}
               AND date(s2.sold_at) BETWEEN ? AND ?) AS margin_generated,
          (SELECT COUNT(*) FROM sales s3 WHERE s3.salesperson_id = u.id AND s3.status = 'VOIDED' AND s3.is_deleted = 0
             AND date(s3.sold_at) BETWEEN ? AND ?) AS voids
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN sales s ON s.salesperson_id = u.id AND ${COUNTS.replace(/\bs\./g, 's.')} AND date(s.sold_at) BETWEEN ? AND ? AND s.business_id = ?
        WHERE u.is_deleted = 0 AND u.business_id = ? AND u.role IN ('STAFF','MANAGER')
        GROUP BY u.id ORDER BY revenue DESC`,
    [from, to, from, to, from, to, String(business.id), String(business.id)]);

    ctx.json({
      ok: true, range: { from, to },
      data: rows.map((r) => {
        const rate = Number(r.commission_rate_pct) || 0;
        // Commission on NET revenue, not gross: gross contains VAT that was never
        // the business's money, so paying commission on it pays staff out of tax.
        const net = round2(Number(r.net_revenue));
        return {
          ...r, revenue: round2(Number(r.revenue)), net_revenue: net,
          margin_generated: round2(Number(r.margin_generated)),
          commission_rate_pct: rate,
          commission: round2(net * rate / 100),
          void_rate_pct: Number(r.sales) ? round2((Number(r.voids) / Number(r.sales)) * 100) : 0,
        };
      }),
      totals: {
        commission: round2(rows.reduce((a, r) => a + round2(Number(r.net_revenue) * (Number(r.commission_rate_pct) || 0) / 100), 0)),
        revenue: round2(rows.reduce((a, r) => a + Number(r.revenue), 0)),
      },
    });
  });

  // -------------------------------------------------------------------
  // TARGETS
  // -------------------------------------------------------------------
  app.get(`${base}/reports/targets`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const today = watToday();
    const monthStart = today.slice(0, 8) + '01';
    const rows = await db.all(`SELECT t.*, b.name AS branch_name, u.full_name AS user_name
        FROM sales_targets t
        LEFT JOIN branches b ON b.id = t.branch_id
        LEFT JOIN users u ON u.id = t.user_id
        WHERE t.is_deleted = 0 AND t.business_id = ? AND t.period_start <= ? AND t.period_end >= ?
        ORDER BY t.period_start DESC, t.target_revenue DESC LIMIT 100`, [String(business.id), today, today]);

    const data = [];
    for (const t of rows) {
      const where = [COUNTS, 'date(s.sold_at) BETWEEN ? AND ?', 's.business_id = ?'];
      const params = [t.period_start, t.period_end, String(business.id)];
      if (t.branch_id) { where.push('s.branch_id = ?'); params.push(String(t.branch_id)); }
      if (t.user_id) { where.push('s.salesperson_id = ?'); params.push(String(t.user_id)); }
      const actual = await db.first(`SELECT COALESCE(SUM(s.total),0) AS revenue, COUNT(*) AS sales,
            COALESCE(SUM(s.total - s.vat_amount),0) AS net_revenue
          FROM sales s WHERE ${where.join(' AND ')}`, params);
      const revenue = round2(Number(actual.revenue));
      const target = round2(Number(t.target_revenue) || 0);
      const elapsed = daysBetween(t.period_start, today);
      const span = Math.max(1, daysBetween(t.period_start, t.period_end));
      data.push({
        ...t, target_revenue: target,
        actual_revenue: revenue,
        sales: Number(actual.sales) || 0,
        attainment_pct: target > 0 ? round2((revenue / target) * 100) : null,
        // Pace compares attainment with how far through the period we are. Being
        // at 40% of target with 80% of the month gone is a different situation
        // from 40% of target with 20% gone, and the raw percentage hides which.
        time_elapsed_pct: round2((Math.min(elapsed, span) / span) * 100),
        on_track: target > 0 ? (revenue / target) >= (Math.min(elapsed, span) / span) : null,
        shortfall: round2(Math.max(0, target - revenue)),
        days_left: Math.max(0, span - elapsed),
        required_per_day: Math.max(0, span - elapsed) > 0 ? round2(Math.max(0, target - revenue) / Math.max(0, span - elapsed)) : null,
      });
    }
    ctx.json({ ok: true, asAt: today, data });
  });

  app.post(`${base}/reports/targets`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can set a sales target.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const periodType = valid(oneOf(body.period_type || 'MONTHLY', ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'], { field: 'Period type' }), 'period_type');
    const periodStart = strField(requireVal(body, 'period_start'), { field: 'Period start', maxLength: 10, required: true });
    const periodEnd = strField(requireVal(body, 'period_end'), { field: 'Period end', maxLength: 10, required: true });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) throw new HttpError('Period dates must be YYYY-MM-DD.', { status: 400, code: 'INVALID_DATE' });
    if (periodEnd < periodStart) throw new HttpError('The period ends before it starts.', { status: 400, code: 'INVALID_RANGE' });
    const targetRevenue = numField(body.target_revenue, { field: 'Target revenue', min: 0 });
    const targetUnits = numField(body.target_units, { field: 'Target units', min: 0, places: 4 });
    const targetMargin = numField(body.target_margin, { field: 'Target margin', min: 0 });
    if (targetRevenue === 0 && targetUnits === 0 && targetMargin === 0) {
      throw new HttpError('A target with nothing in it cannot be missed or met. Set at least one of revenue, units or margin.', { status: 400, code: 'EMPTY_TARGET' });
    }
    const id = newId();
    await db.run(`INSERT INTO sales_targets (
        id, business_id, branch_id, user_id, period_type, period_start, period_end,
        target_revenue, target_units, target_margin, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
      id, String(business.id), branch ? String(branch.id) : null,
      body.user_id ? String(body.user_id) : null, periodType, periodStart, periodEnd,
      targetRevenue, targetUnits, targetMargin, String(user.id),
    ]);
    await recordTarget(ctx, 'TARGET_CREATED', id, business.id, branch ? branch.id : null, { periodType, periodStart, periodEnd, targetRevenue, targetUnits, targetMargin });
    ctx.json({ ok: true, id, message: `${periodType} target set for ${periodStart} to ${periodEnd}${targetRevenue > 0 ? `: ₦${targetRevenue.toLocaleString('en-NG')}` : ''}.` }, 201);
  });

  // -------------------------------------------------------------------
  // CSV EXPORT
  // -------------------------------------------------------------------
  /**
   * Any of the above as a CSV download.
   *
   * Implemented as one endpoint that re-runs the same query rather than a
   * separate export path per report, because a second path is a second
   * definition of the numbers — and an export that disagrees with the screen is
   * worse than no export.
   */
  app.get(`${base}/reports/export`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const what = valid(oneOf(ctx.req.queryParam('report') || 'SALES', ['SALES', 'SALES_DETAIL', 'STOCK', 'DEBTORS', 'CREDITORS', 'EXPENSES', 'ADJUSTMENTS', 'AUDIT'], { field: 'Report' }), 'report');
    const business = await resolveBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const bSql = branch && ctx.req.queryParam('branch_scope') !== 'all' ? 'AND t.branch_id = ?' : '';
    const bParam = branch && ctx.req.queryParam('branch_scope') !== 'all' ? [String(branch.id)] : [];

    const QUERIES = {
      SALES: {
        head: ['Receipt', 'Date (WAT)', 'Branch', 'Cashier', 'Customer', 'Type', 'Payment', 'Subtotal', 'Discount', 'VAT', 'Delivery', 'Total', 'Paid', 'Balance', 'Status'],
        sql: `SELECT s.receipt_no, s.sold_at, b.name, u.full_name, COALESCE(s.customer_name,'Walk-in'), s.sale_type, s.payment_method,
                s.subtotal, s.discount_amount + COALESCE(s.order_discount_amount,0), s.vat_amount, s.delivery_fee, s.total,
                s.amount_paid, s.balance_due, s.status
              FROM sales s LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN users u ON u.id = s.salesperson_id
              WHERE s.is_deleted = 0 AND s.business_id = ? AND date(s.sold_at) BETWEEN ? AND ? ${bSql.replace('t.', 's.')}
              ORDER BY s.sold_at DESC`,
        params: [String(business.id), from, to, ...bParam],
      },
      SALES_DETAIL: {
        head: ['Receipt', 'Date (WAT)', 'Branch', 'Product', 'SKU', 'Variant', 'Unit', 'Qty', 'Base qty', 'Unit price', 'Discount', 'VAT', 'Line total', 'Cost', 'Margin'],
        sql: `SELECT s.receipt_no, s.sold_at, b.name, si.product_name, si.sku, v.name, si.unit_code, si.quantity,
                si.quantity_in_base, si.unit_price, si.discount_amount, si.vat_amount, si.line_total,
                si.cost_price_snapshot * si.quantity_in_base, si.margin
              FROM sale_items si JOIN sales s ON s.id = si.sale_id
              LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN product_variants v ON v.id = si.variant_id
              WHERE si.is_deleted = 0 AND ${COUNTS} AND s.business_id = ? AND date(s.sold_at) BETWEEN ? AND ? ${bSql.replace('t.', 's.')}
              ORDER BY s.sold_at DESC, s.receipt_no`,
        params: [String(business.id), from, to, ...bParam],
      },
      STOCK: {
        head: ['SKU', 'Product', 'Branch', 'Batch', 'Expiry', 'Qty', 'Reserved', 'Available', 'Unit cost', 'Stock value', 'Status'],
        sql: `SELECT p.sku, p.name, b.name, sb.batch_no, sb.expiry_date, sb.quantity, sb.quantity_reserved,
                sb.quantity - sb.quantity_reserved, sb.cost_price_per_unit,
                sb.quantity * sb.cost_price_per_unit, sb.status
              FROM stock_batches sb JOIN products p ON p.id = sb.product_id LEFT JOIN branches b ON b.id = sb.branch_id
              WHERE sb.is_deleted = 0 AND sb.business_id = ? ${bSql.replace('t.', 'sb.')}
              ORDER BY p.name, sb.batch_no`,
        params: [String(business.id), ...bParam],
      },
      DEBTORS: {
        head: ['Customer', 'Phone', 'Class', 'Credit limit', 'Balance', 'Terms (days)', 'Oldest due', 'Open invoices'],
        sql: `SELECT c.name, c.phone, cc.name, c.credit_limit, c.credit_balance, c.payment_terms_days,
                (SELECT MIN(s.due_date) FROM sales s WHERE s.customer_id = c.id AND s.balance_due > 0 AND s.status <> 'VOIDED' AND s.is_deleted = 0),
                (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.balance_due > 0 AND s.status <> 'VOIDED' AND s.is_deleted = 0)
              FROM customers c LEFT JOIN customer_classes cc ON cc.id = c.customer_class_id
              WHERE c.is_deleted = 0 AND c.credit_balance <> 0 AND c.business_id = ? ${bSql.replace('t.', 'c.')}
              ORDER BY c.credit_balance DESC`,
        params: [String(business.id), ...bParam],
      },
      CREDITORS: {
        head: ['Supplier', 'Phone', 'TIN', 'Manufacturer', 'Credit limit', 'Balance owed'],
        sql: `SELECT s.name, s.phone, s.tin, CASE s.is_manufacturer WHEN 1 THEN 'Yes' ELSE 'No' END, s.credit_limit,
                (SELECT COALESCE(SUM(cl.amount),0) FROM creditor_ledger cl WHERE cl.supplier_id = s.id AND cl.is_deleted = 0)
              FROM suppliers s WHERE s.is_deleted = 0 AND (s.business_id = ? OR s.business_id IS NULL)
              ORDER BY 6 DESC`,
        params: [String(business.id)],
      },
      EXPENSES: {
        head: ['Date', 'Branch', 'Category', 'Description', 'Supplier', 'Gross', 'Input VAT', 'WHT code', 'WHT', 'Net', 'Method', 'Status'],
        sql: `SELECT e.expense_date, b.name, e.category, e.description, s.name, e.amount, e.vat_amount, e.wht_code,
                e.wht_amount, e.net_amount, e.payment_method, e.status
              FROM expenses e LEFT JOIN branches b ON b.id = e.branch_id LEFT JOIN suppliers s ON s.id = e.supplier_id
              WHERE e.is_deleted = 0 AND e.business_id = ? AND e.expense_date BETWEEN ? AND ? ${bSql.replace('t.', 'e.')}
              ORDER BY e.expense_date DESC`,
        params: [String(business.id), from, to, ...bParam],
      },
      ADJUSTMENTS: {
        head: ['Date', 'Branch', 'Product', 'Type', 'Qty', 'Unit cost', 'Value', 'Reason', 'By'],
        sql: `SELECT sa.created_at, b.name, p.name, sa.adjustment_type, sa.quantity, sa.unit_cost, sa.total_value, sa.reason, u.full_name
              FROM stock_adjustments sa JOIN products p ON p.id = sa.product_id
              LEFT JOIN branches b ON b.id = sa.branch_id LEFT JOIN users u ON u.id = sa.created_by
              WHERE sa.is_deleted = 0 AND sa.business_id = ? AND date(sa.created_at) BETWEEN ? AND ? ${bSql.replace('t.', 'sa.')}
              ORDER BY sa.created_at DESC`,
        params: [String(business.id), from, to, ...bParam],
      },
      AUDIT: {
        head: ['When (UTC)', 'User', 'Action', 'Entity', 'Entity id', 'Branch', 'IP'],
        sql: `SELECT a.created_at, a.username, a.action, a.entity_type, a.entity_id, b.name, a.ip_address
              FROM audit_log a LEFT JOIN branches b ON b.id = a.branch_id
              WHERE a.business_id = ? AND date(a.created_at) BETWEEN ? AND ? ${bSql.replace('t.', 'a.')}
              ORDER BY a.created_at DESC LIMIT 5000`,
        params: [String(business.id), from, to, ...bParam],
      },
    };

    const q = QUERIES[what];
    const rows = await db.all(q.sql, q.params);
    const csv = toCsv([q.head, ...rows.map((r) => Object.values(r))]);
    const filename = `stockridge-${what.toLowerCase()}-${from}-to-${to}.csv`;
    ctx.header('Content-Disposition', `attachment; filename="${filename}"`);
    ctx.text(csv);
    // Set the type AFTER ctx.text, which defaults every text body to text/plain.
    // Without this the file arrives as a plain-text page instead of a download
    // that Excel opens, and the BOM is the only thing keeping ₦ readable.
    ctx.header('Content-Type', 'text/csv; charset=utf-8');
  });
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
function daysBetween(a, b) {
  const ms = Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10));
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

/**
 * RFC-4180 CSV.
 *
 * Fields containing a comma, quote or newline are quoted, and embedded quotes
 * are doubled. Nigeria's accounting software is mostly Excel, which will happily
 * mangle an unquoted "Lagos, Ikeja" into two columns — and a report that opens
 * broken is a report nobody trusts.
 */
function toCsv(rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // A leading BOM makes Excel detect UTF-8 instead of guessing a legacy
  // codepage, which is what turns "₦" into mojibake.
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

function requireVal(body, field) {
  const v = body[field];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new HttpError(`${field.replace(/_/g, ' ')} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: 'Required' } });
  }
  return v;
}

async function recordTarget(ctx, action, entityId, businessId, branchId, after) {
  const { recordFromCtx } = require('../lib/audit');
  return recordFromCtx(ctx, { action, entityType: 'SALES_TARGET', entityId, businessId, branchId, after });
}

module.exports = { mount, toCsv, daysBetween, COUNTS };
