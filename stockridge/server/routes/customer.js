// =====================================================================
// StockRidge — CUSTOMER, TILL, CASH-CONTROL & ATTENDANCE ROUTES
// =====================================================================

const { createRouter, HttpError } = require('../lib/http');
const { withIdempotency } = require('../lib/idempotency');
const { watNowIso, watDate } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { assertRole, assertBranchAccess, resolveScopedBranchId } = require('../lib/roles');
const customerService = require('../services/customerService');
const tillService = require('../services/tillService');
const attendanceService = require('../services/attendanceService');
const { writeAudit } = require('../lib/audit');
const { formatClaimCode } = require('../lib/references');

function customerRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    return c.json(await customerService.list(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      type: c.req.query('type') || null, tierId: c.req.query('tier_id') || null,
      search: c.req.query('q') || c.req.query('search') || null,
      withBalanceOnly: c.req.query('with_balance') === '1',
      overLimitOnly: c.req.query('over_limit') === '1',
      limit: c.req.query('limit'), offset: c.req.query('offset'),
      sort: c.req.query('sort'), dir: c.req.query('dir'),
    }));
  });

  // Quick lookup by phone — the counter flow. A cashier types the last digits
  // the customer reads out and gets one record or a clear "not found".
  app.get('/lookup', async (c) => {
    const db = getDb();
    const q = String(c.req.query('q') || c.req.query('phone') || '').trim();
    if (!q) throw new HttpError(400, 'Send the phone number, name or customer code as ?q=.', 'LOOKUP_QUERY_REQUIRED');
    const digits = q.replace(/\D/g, '');
    const like = `%${q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
    const rows = await db.prepare(`
      SELECT c.id, c.full_name, c.company_name, c.phone, c.phone_national, c.customer_type, c.home_branch_id,
             b.name AS home_branch_name, t.label AS tier_label, c.credit_enabled, c.credit_limit,
             COALESCE((SELECT SUM(d.amount) FROM debtor_ledger d WHERE d.customer_id = c.id AND d.is_deleted = 0),0) AS balance,
             c.purchase_count, c.total_purchases, c.last_purchase_at, c.loyalty_points
      FROM customers c
      LEFT JOIN branches b ON b.id = c.home_branch_id
      LEFT JOIN price_tiers t ON t.id = c.tier_id
      WHERE c.business_unit_id = ? AND c.is_deleted = 0 AND c.is_active = 1
        AND (c.full_name LIKE ? ESCAPE '\\' OR c.company_name LIKE ? ESCAPE '\\'
             OR (${digits ? 'c.phone LIKE ? OR c.phone_national LIKE ? OR' : ''} c.customer_code LIKE ? ESCAPE '\\'))
      ORDER BY c.purchase_count DESC LIMIT 10
    `).bind(c.var.businessUnitId, like, like,
      ...(digits ? [`%${digits.slice(-10)}`, `%${digits.slice(-10)}`] : []), like).all();

    return c.json({
      results: rows.results.map((r) => ({
        ...r, balance: round2(r.balance), total_purchases: round2(r.total_purchases),
        credit_available: r.credit_enabled && Number(r.credit_limit) > 0 ? round2(Math.max(0, Number(r.credit_limit) - Number(r.balance))) : null,
      })),
      count: rows.results.length,
      // Say so explicitly rather than returning an empty list that the cashier
      // reads as "the system is broken".
      message: rows.results.length ? null : `No customer matched "${q.slice(0, 30)}". They may be a walk-in — you can sell without a customer record, or create one.`,
    });
  });

  app.get('/aging', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the debtor aging report' });
    const db = getDb();
    return c.json(await customerService.agingReport(db, {
      businessUnitId: c.var.businessUnitId,
      branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      asAt: c.req.query('as_at') || null,
    }));
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await customerService.create(db, c.serviceCtx, body) }));
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    return c.json(await customerService.get(db, c.serviceCtx, c.req.param('id')));
  });

  app.put('/:id', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await customerService.update(db, c.serviceCtx, c.req.param('id'), body));
  });

  app.get('/:id/statement', async (c) => {
    const db = getDb();
    return c.json(await customerService.statement(db, c.serviceCtx, {
      customerId: c.req.param('id'), from: c.req.query('from') || null, to: c.req.query('to') || null,
    }));
  });

  app.post('/:id/payments', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 201, body: await customerService.recordPayment(db, c.serviceCtx, { customerId: c.req.param('id'), ...body }),
    }));
  });

  app.get('/:id/purchases', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const cust = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!cust) throw new HttpError(404, 'That customer was not found.', 'CUSTOMER_NOT_FOUND');
    if (cust.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That customer belongs to a different business.', 'CUSTOMER_WRONG_BUSINESS');
    const rows = await db.prepare(`
      SELECT s.id, s.receipt_no, s.invoice_no, s.sale_type, s.status, s.total, s.balance_due, s.occurred_at,
             b.name AS branch_name, u.full_name AS sold_by_name,
             (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.is_deleted = 0) AS line_count
      FROM sales s JOIN branches b ON b.id = s.branch_id JOIN users u ON u.id = s.sold_by
      WHERE s.customer_id = ? AND s.is_deleted = 0
      ORDER BY s.occurred_at DESC LIMIT ? OFFSET ?
    `).bind(id, Math.min(500, Number(c.req.query('limit')) || 50), Number(c.req.query('offset')) || 0).all();
    return c.json({ results: rows.results });
  });

  app.get('/:id/warranties', async (c) => {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT w.*, p.name AS product_name, p.brand, ps.serial_no, b.name AS branch_name,
             CAST(julianday(w.ends_at) - julianday('now','+1 hour') AS INTEGER) AS days_remaining,
             (SELECT COUNT(*) FROM warranty_claims wc WHERE wc.warranty_id = w.id AND wc.is_deleted = 0) AS claim_count
      FROM product_warranties w
      JOIN products p ON p.id = w.product_id
      LEFT JOIN product_serials ps ON ps.id = w.serial_id
      LEFT JOIN branches b ON b.id = w.branch_id
      WHERE w.customer_id = ? AND w.is_deleted = 0
      ORDER BY w.ends_at DESC LIMIT 200
    `).bind(c.req.param('id')).all();
    return c.json({ results: rows.results });
  });

  return app;
}

// ---------------------------------------------------------------------
// TILL & SAFE
// ---------------------------------------------------------------------
function tillRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const where = ['t.is_deleted = 0', 't.business_unit_id = ?'];
    const params = [c.var.businessUnitId];
    if (scoped) { where.push('t.branch_id = ?'); params.push(scoped); }
    if (c.req.query('status')) { where.push('t.status = ?'); params.push(String(c.req.query('status')).toUpperCase()); }
    if (c.req.query('from')) { where.push("date(t.opened_at,'+1 hour') >= ?"); params.push(String(c.req.query('from')).slice(0, 10)); }
    if (c.req.query('to')) { where.push("date(t.opened_at,'+1 hour') <= ?"); params.push(String(c.req.query('to')).slice(0, 10)); }
    const rows = await db.prepare(`
      SELECT t.*, b.name AS branch_name, u.full_name AS opened_by_name, cl.full_name AS closed_by_name
      FROM till_sessions t
      JOIN branches b ON b.id = t.branch_id
      LEFT JOIN users u ON u.id = t.opened_by
      LEFT JOIN users cl ON cl.id = t.closed_by
      WHERE ${where.join(' AND ')}
      ORDER BY CASE t.status WHEN 'OPEN' THEN 0 ELSE 1 END, t.opened_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params, Math.min(500, Number(c.req.query('limit')) || 50), Number(c.req.query('offset')) || 0).all();
    return c.json({ results: rows.results });
  });

  app.get('/current', async (c) => {
    const db = getDb();
    const branchId = c.req.query('branch_id') || c.var.user.branch_id;
    if (!branchId) throw new HttpError(400, 'Choose a branch.', 'BRANCH_REQUIRED');
    assertBranchAccess(c.var.user, branchId);
    const till = await tillService.currentTill(db, { branchId });
    const safe = await tillService.safeBalance(db, { branchId });
    if (!till) {
      return c.json({
        till: null, safe_balance: safe,
        message: 'No till is open at this branch. Sales cannot be recorded until one is — a sale without an open till cannot be reconciled against the drawer at close.',
      });
    }
    return c.json({
      till: {
        ...till,
        opening_float: round2(till.opening_float), expected_cash: round2(till.expected_cash),
        expected_total: round2(till.expected_total),
        cash_in_drawer: round2(Number(till.opening_float) + Number(till.expected_cash)),
      },
      safe_balance: safe,
    });
  });

  app.get('/variances', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view till variances' });
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const days = Math.min(365, Number(c.req.query('days')) || 30);
    const rows = await db.prepare(`
      SELECT t.*, b.name AS branch_name, u.full_name AS closed_by_name, o.full_name AS opened_by_name
      FROM till_sessions t
      JOIN branches b ON b.id = t.branch_id
      LEFT JOIN users u ON u.id = t.closed_by
      LEFT JOIN users o ON o.id = t.opened_by
      WHERE t.business_unit_id = ? AND t.is_deleted = 0 AND t.status IN ('CLOSED','RECONCILED')
        AND date(t.closed_at,'+1 hour') >= date('now','+1 hour', ?)
        ${scoped ? 'AND t.branch_id = ?' : ''}
      ORDER BY ABS(t.variance) DESC LIMIT 500
    `).bind(c.var.businessUnitId, `-${days} days`, ...(scoped ? [scoped] : [])).all();

    const results = rows.results.map((r) => ({ ...r, variance: round2(r.variance), counted_cash: round2(r.counted_cash) }));
    const short = results.filter((r) => Number(r.variance) < 0);
    const over = results.filter((r) => Number(r.variance) > 0);
    // By cashier. A variance concentrated on one person is a training or an
    // honesty question; a variance spread evenly is a process question. Those
    // need opposite responses and only the breakdown tells you which.
    const byUser = new Map();
    for (const r of results) {
      const key = r.closed_by || 'unknown';
      if (!byUser.has(key)) byUser.set(key, { user_id: key, user_name: r.closed_by_name || 'Unknown', sessions: 0, short_count: 0, over_count: 0, net_variance: 0, worst: 0 });
      const u = byUser.get(key);
      u.sessions += 1;
      u.net_variance = round2(u.net_variance + Number(r.variance));
      if (Number(r.variance) < 0) { u.short_count += 1; u.worst = Math.min(u.worst, Number(r.variance)); }
      if (Number(r.variance) > 0) u.over_count += 1;
    }
    return c.json({
      days,
      results,
      summary: {
        sessions: results.length,
        reconciled: results.filter((r) => Math.abs(Number(r.variance)) <= 50).length,
        short_count: short.length, over_count: over.length,
        net_variance: round2(results.reduce((a, r) => a + Number(r.variance), 0)),
        total_short: round2(short.reduce((a, r) => a + Number(r.variance), 0)),
        total_over: round2(over.reduce((a, r) => a + Number(r.variance), 0)),
      },
      by_user: [...byUser.values()].sort((a, b) => Math.abs(a.net_variance) - Math.abs(b.net_variance)).reverse(),
    });
  });

  app.post('/open', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await tillService.openTill(db, c.serviceCtx, body) }));
  });

  app.post('/close', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 200, body: await tillService.closeTill(db, c.serviceCtx, body) }));
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const s = await tillService.getSession(db, c.req.param('id'));
    if (!s) throw new HttpError(404, 'That till session was not found.', 'TILL_NOT_FOUND');
    if (s.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That till belongs to another business.', 'TILL_WRONG_BUSINESS');
    assertBranchAccess(c.var.user, s.branch_id);
    return c.json({ ...s, cash_in_drawer: round2(Number(s.opening_float) + Number(s.expected_cash)) });
  });

  // Safe
  app.get('/safe/balance', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    if (!scoped) {
      const rows = await db.prepare(`SELECT * FROM v_branch_safe_balances WHERE business_unit_id = ?`).bind(c.var.businessUnitId).all();
      return c.json({ results: rows.results.map((r) => ({ ...r, safe_balance: round2(r.safe_balance) })), total: round2(rows.results.reduce((a, r) => a + Number(r.safe_balance), 0)) });
    }
    return c.json({ branch_id: scoped, balance: await tillService.safeBalance(db, { branchId: scoped }) });
  });

  app.get('/safe/ledger', async (c) => {
    const db = getDb();
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'read the safe ledger' });
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    return c.json({
      results: await tillService.safeLedger(db, {
        businessUnitId: c.var.businessUnitId, branchId: scoped,
        from: c.req.query('from') || null, to: c.req.query('to') || null, limit: c.req.query('limit') || 100,
      }),
    });
  });

  app.post('/safe/entry', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await tillService.safeEntry(db, c.serviceCtx, body) }));
  });

  app.post('/safe/count', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await tillService.countSafe(db, c.serviceCtx, body));
  });

  // Change owed
  app.get('/change-owed', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const result = await tillService.outstandingChange(db, {
      businessUnitId: c.var.businessUnitId, branchId: c.req.query('all_branches') === '1' ? null : scoped,
      search: c.req.query('q') || null, limit: c.req.query('limit') || 100,
    });
    return c.json({ ...result, results: result.results.map((r) => ({ ...r, claim_code_spoken: formatClaimCode(r.claim_code), amount: round2(r.amount) })) });
  });

  app.post('/change-owed', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await tillService.createChangeOwed(db, c.serviceCtx, body), 201);
  });

  // Payable at ANY branch: the whole point of a claim code is that the customer
  // does not have to go back to the shop that shorted them.
  app.post('/change-owed/pay', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 200, body: await tillService.payChangeOwed(db, c.serviceCtx, { claimCodeOrId: body.claim_code || body.id, method: body.method, note: body.note }),
    }));
  });

  return app;
}

// ---------------------------------------------------------------------
// ATTENDANCE
// ---------------------------------------------------------------------
function attendanceRoutes(getDb) {
  const app = createRouter();

  app.post('/clock-in', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 201,
      body: await attendanceService.openClock(db, c.serviceCtx, {
        branchId: body.branch_id || null, latitude: body.latitude, longitude: body.longitude,
        deviceId: body.device_id || c.var.deviceId, shiftType: body.shift_type, note: body.note,
      }),
    }));
  });

  app.post('/clock-out', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 200,
      body: await attendanceService.closeClock(db, c.serviceCtx, {
        latitude: body.latitude, longitude: body.longitude,
        deviceId: body.device_id || c.var.deviceId, breakMinutes: body.break_minutes, note: body.note,
      }),
    }));
  });

  app.get('/today', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const today = watDate();
    const rows = await db.prepare(`
      SELECT sa.*, u.full_name AS user_name, u.role, u.job_title, b.name AS branch_name
      FROM staff_attendance sa JOIN users u ON u.id = sa.user_id JOIN branches b ON b.id = sa.branch_id
      WHERE sa.business_unit_id = ? AND sa.is_deleted = 0 AND sa.work_date = ?
        ${scoped ? 'AND sa.branch_id = ?' : ''}
      ORDER BY sa.clock_in_at ASC
    `).bind(c.var.businessUnitId, today, ...(scoped ? [scoped] : [])).all();

    const allStaff = await db.prepare(`
      SELECT u.id, u.full_name, u.role, u.branch_id, b.name AS branch_name
      FROM users u LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.business_unit_id = ? AND u.is_deleted = 0 AND u.is_active = 1 AND u.role <> 'ADMIN'
        ${scoped ? 'AND (u.branch_id = ? OR u.branch_id IS NULL)' : ''}
      ORDER BY u.full_name
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();

    const presentIds = new Set(rows.results.map((r) => r.user_id));
    return c.json({
      date: today,
      records: rows.results,
      present: rows.results.filter((r) => !r.clock_out_at).length,
      clocked_out: rows.results.filter((r) => r.clock_out_at).length,
      flagged: rows.results.filter((r) => r.needs_review).length,
      late: rows.results.filter((r) => r.is_late).length,
      // Who has not clocked in at all. This is the list a manager actually
      // needs at 9am, and it is not derivable from the attendance table alone
      // because absence produces no row.
      absent: allStaff.results.filter((u) => !presentIds.has(u.id)).map((u) => ({ id: u.id, full_name: u.full_name, role: u.role, branch_name: u.branch_name })),
      total_hours: round2(rows.results.reduce((a, r) => a + Number(r.hours_worked || 0), 0)),
    });
  });

  app.get('/timesheet', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view a timesheet' });
    const db = getDb();
    return c.json(await attendanceService.timesheet(db, {
      businessUnitId: c.var.businessUnitId, branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      userId: c.req.query('user_id') || null,
      startDate: c.req.query('from') || watDate(), endDate: c.req.query('to') || watDate(),
    }));
  });

  app.get('/review-queue', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'review attendance flags' });
    const db = getDb();
    return c.json(await attendanceService.pendingReview(db, {
      businessUnitId: c.var.businessUnitId, branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      limit: c.req.query('limit') || 100,
    }));
  });

  app.post('/:id/review', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await attendanceService.review(db, c.serviceCtx, {
      attendanceId: c.req.param('id'), decision: body.decision, note: body.note, correctedHours: body.corrected_hours,
    }));
  });

  // Shifts
  app.get('/shifts', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT bs.*, b.name AS branch_name FROM branch_shifts bs JOIN branches b ON b.id = bs.branch_id
      WHERE bs.business_unit_id = ? AND bs.is_deleted = 0 AND bs.is_active = 1 ${scoped ? 'AND bs.branch_id = ?' : ''}
      ORDER BY b.name, bs.start_time
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();
    return c.json({ results: rows.results });
  });

  app.post('/shifts', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'define a shift' });
    const db = getDb();
    const body = await c.req.json();
    const V = require('../../shared/validation');
    const branchId = body.branch_id || c.var.user.branch_id;
    if (!branchId) throw new HttpError(400, 'Choose which branch this shift belongs to.', 'BRANCH_REQUIRED');
    assertBranchAccess(c.var.user, branchId);
    const name = V.required(body.name, { field: 'Shift name', max: 80 });
    if (name && name.error) throw new HttpError(400, name.error, 'VALIDATION_FAILED');
    const timeRe = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    if (!timeRe.test(String(body.start_time || ''))) throw new HttpError(400, 'Start time must be HH:MM in 24-hour format.', 'SHIFT_TIME_INVALID');
    if (!timeRe.test(String(body.end_time || ''))) throw new HttpError(400, 'End time must be HH:MM in 24-hour format.', 'SHIFT_TIME_INVALID');
    const type = V.oneOf(body.shift_type || 'FULL_DAY', ['MORNING', 'AFTERNOON', 'FULL_DAY', 'NIGHT', 'FLEX'], { field: 'Shift type' });
    if (type && type.error) throw new HttpError(400, type.error, 'VALIDATION_FAILED');
    const days = Array.isArray(body.days_of_week) && body.days_of_week.length
      ? body.days_of_week.map((d) => Number(d)).filter((d) => d >= 1 && d <= 7).sort().join(',')
      : '1,2,3,4,5,6';
    const ts = watNowIso();
    const id = require('../../shared/ids').newId();
    await db.prepare(`
      INSERT INTO branch_shifts (id, business_unit_id, branch_id, name, shift_type, start_time, end_time, grace_minutes, days_of_week, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, 1,?,?)
    `).bind(id, c.var.businessUnitId, branchId, name, type, String(body.start_time), String(body.end_time),
      Math.max(0, Number(body.grace_minutes) || 10), days, ts, ts).run();
    return c.json({
      ok: true, id, name, start_time: String(body.start_time), end_time: String(body.end_time), grace_minutes: Math.max(0, Number(body.grace_minutes) || 10),
      note: 'The grace period absorbs traffic. A zero-minute grace produces a late register that everybody disputes and therefore nobody reads.',
    }, 201);
  });

  return app;
}

module.exports = { customerRoutes, tillRoutes, attendanceRoutes };
'use strict';
