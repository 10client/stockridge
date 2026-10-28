'use strict';
// =====================================================================
// server/routes/bills.js — THE WAREHOUSE DESK
// =====================================================================
// Print a bill. Hold the goods. Take the money. Print the receipt. Then
// the store may release the goods. Nothing in this file posts a sale on
// its own: payment goes through the same engine as every other sale.

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const { scopeFilter, inScope, strField } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const salesRoutes = require('./sales');
const salesService = require('../services/salesService');
const bills = require('../services/billService');
const vehicleDuty = require('../lib/vehicleDuty');

async function branchIdsInScope(db, scope) {
  if (!scope) return [];
  if (scope.branchIds && scope.branchIds.size) return [...scope.branchIds].map(String);
  if (scope.allBranches && scope.allBusinesses) {
    const rows = await db.all('SELECT id FROM branches WHERE is_deleted = 0 AND is_active = 1');
    return rows.map((r) => String(r.id));
  }
  if (scope.businessIds && scope.businessIds.size) {
    const ids = [...scope.businessIds].map(String);
    const rows = await db.all(
      `SELECT id FROM branches WHERE is_deleted = 0 AND is_active = 1 AND business_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    return rows.map((r) => String(r.id));
  }
  return [];
}

function mount(app, base = '/api') {
  app.get(`${base}/bills`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const filter = scopeFilter(scope, { alias: 'b' });
    const branchIds = await branchIdsInScope(db, scope);
    await bills.recoverPaying(db, branchIds);
    await bills.expireDue(db, branchIds);

    const where = ['b.is_deleted = 0'];
    const params = [];
    if (filter.sql) {
      where.push(filter.sql);
      params.push(...filter.params);
    }
    const status = ctx.req.queryParam('status');
    if (status) {
      where.push('b.status = ?');
      params.push(String(status).toUpperCase());
    } else {
      where.push(`b.status = 'OPEN'`);
    }
    const named = ctx.req.queryParam('branch_id');
    if (named) {
      where.push('b.branch_id = ?');
      params.push(String(named));
    }
    const rows = await db.all(
      `SELECT b.*, br.name AS branch_name, u.full_name AS raised_by_name
         FROM customer_bills b
         LEFT JOIN branches br ON br.id = b.branch_id
         LEFT JOIN users u ON u.id = b.raised_by
        WHERE ${where.join(' AND ')}
        ORDER BY b.raised_at DESC
        LIMIT 100`,
      params,
    );
    ctx.json({
      ok: true,
      data: rows.map((row) => bills.publicBill(row)),
    });
  });

  app.get(`${base}/bills/lookup`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const code = strField(ctx.req.queryParam('code'), { field: 'Payment code', maxLength: 16 });
    if (!code) throw new HttpError('Type the payment code printed on the bill.', { status: 400, code: 'PAY_CODE_REQUIRED' });
    const branchIds = await branchIdsInScope(db, ctx.get('scope'));
    const row = await bills.findByCode(db, code, branchIds);
    if (!row) {
      throw new HttpError('No bill has that payment code. Read it off the bill again. An old bill can also be found by its bill number.', { status: 404, code: 'BILL_NOT_FOUND' });
    }
    if (!inScope(ctx.get('scope'), row)) {
      throw new HttpError('That bill is at another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }
    ctx.json({ ok: true, bill: bills.publicBill(row) });
  });

  app.get(`${base}/bills/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const row = await bills.loadBill(db, ctx.req.param('id'));
    if (!row) throw new HttpError('That bill does not exist.', { status: 404, code: 'BILL_NOT_FOUND' });
    if (!inScope(ctx.get('scope'), row)) {
      throw new HttpError('That bill is at another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }
    ctx.json({ ok: true, bill: bills.publicBill(row) });
  });

  app.post(`${base}/bills`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const params = await salesRoutes.buildEngineParams(db, ctx, body, { forComplete: false });
    const place = await vehicleDuty.resolveSalePlace(db, params.business, user, body);
    const raised = await bills.raise(db, { params, rawLines: params.lines, user });
    if (!place.skip) {
      await db.run(
        'UPDATE customer_bills SET sale_place = ?, vehicle_id = ? WHERE id = ?',
        [place.salePlace, place.vehicleId, raised.id],
      );
      raised.bill.sale_place = place.salePlace;
      raised.bill.vehicle_id = place.vehicleId;
      raised.bill.vehicle_name = place.vehicleName || null;
    }
    await recordFromCtx(ctx, {
      action: 'BILL_RAISED',
      entityType: 'CUSTOMER_BILL',
      entityId: raised.id,
      branchId: params.branch.id,
      businessId: params.business.id,
      after: { bill_no: raised.bill.bill_no, total: raised.bill.total, customer_name: raised.bill.customer_name },
    });
    ctx.json(raised, 201);
  });

  app.post(`${base}/bills/:id/pay`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const bill = await bills.loadBill(db, ctx.req.param('id'));
    if (!bill) throw new HttpError('That bill does not exist.', { status: 404, code: 'BILL_NOT_FOUND' });
    if (!inScope(ctx.get('scope'), bill)) throw new HttpError('That bill is at another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    const asked = body.branch_id || body.branchId || ctx.req.queryParam('branch_id');
    if (asked && String(asked) !== String(bill.branch_id)) {
      throw new HttpError(
        `Bill ${bill.bill_no} belongs to ${bill.branch_name || 'another shop'}. Switch to that shop before taking the money, so it lands in the right drawer and the goods are released from the right store.`,
        { status: 409, code: 'BILL_WRONG_BRANCH' },
      );
    }

    const locked = await bills.beginPay(db, bill, user);
    let sale = null;
    try {
      const payBody = bills.payRequest(bill, locked.replay, body);
      if ((payBody.payments || []).some((p) => String(p.method || '').toUpperCase() === 'CREDIT')) {
        // The bill was priced as a wholesale or retail document. Putting the
        // rest on account is a credit sale of that same paper, not a reprice.
        payBody.sale_type = 'CREDIT';
      }
      const params = await salesRoutes.buildEngineParams(db, ctx, payBody, { forComplete: true });
      if (String(params.branch.id) !== String(bill.branch_id)) {
        throw new HttpError('The payment resolved to a different shop from the bill. It was not taken.', { status: 409, code: 'BILL_WRONG_BRANCH' });
      }
      params.stockHolds = locked.holds;
      params.allowReservedSerials = locked.serials;
      const preview = await salesService.prepare(db, params);
      const saleTotal = round2(Number(preview.totals && preview.totals.total));
      const billTotal = round2(Number(bill.total));
      if (Math.abs(saleTotal - billTotal) > 0.01) {
        throw new HttpError(
          `Bill ${bill.bill_no} is ₦${billTotal.toLocaleString('en-NG')} but the sale would record ₦${saleTotal.toLocaleString('en-NG')}. Payment was not taken. The bill, the receipt, and the books have to be the same figure.`,
          { status: 409, code: 'BILL_TOTAL_MISMATCH' },
        );
      }
      sale = await salesService.complete(db, params);
      const stamped = bill.sale_place
        ? { skip: false, salePlace: bill.sale_place, vehicleId: bill.vehicle_id || null, vehicleName: null }
        : await vehicleDuty.resolveSalePlace(db, params.business, user, body);
      await vehicleDuty.writeSalePlace(db, sale.saleId, stamped);
      sale.salePlace = stamped.salePlace || null;
      sale.vehicleId = stamped.vehicleId || null;
      await bills.markPaid(db, bill, sale, user);
    } catch (e) {
      if (!e || e.code !== 'BILL_CLOSE_FAILED') await bills.abortPay(db, bill.id);
      throw e;
    }
    await recordFromCtx(ctx, {
      action: 'BILL_PAID',
      entityType: 'CUSTOMER_BILL',
      entityId: bill.id,
      branchId: bill.branch_id,
      businessId: bill.business_id,
      after: { bill_no: bill.bill_no, sale_id: sale.saleId, receipt_no: sale.receiptNo },
    });
    const bookedTotal = round2(Number(sale.totals && sale.totals.total));
    const billTotal = round2(Number(bill.total));
    const figuresMatch = Math.abs(bookedTotal - billTotal) <= 0.01;
    const cashierName = user.full_name || user.username || 'Staff';
    ctx.json({
      ok: true,
      billNo: bill.bill_no,
      billId: bill.id,
      payCode: bills.publicBill(bill).pay_code,
      raisedByName: bill.raised_by_name || null,
      cashierName,
      total: bookedTotal,
      figures: {
        billTotal,
        saleTotal: bookedTotal,
        paid: round2(Number(sale.paid) || 0),
        match: figuresMatch,
      },
      ...sale,
      message: figuresMatch
        ? `Bill ${bill.bill_no} is paid. Receipt ${sale.receiptNo} is ₦${bookedTotal.toLocaleString('en-NG')}, the same figure as the bill and the books. Received by ${cashierName}. Print the release note before the goods leave.`
        : `Receipt ${sale.receiptNo} is recorded at ₦${bookedTotal.toLocaleString('en-NG')} and bill ${bill.bill_no} was ₦${billTotal.toLocaleString('en-NG')}. Do not take the payment again. Check the sale before the goods leave.`,
    });
  });

  app.post(`${base}/bills/:id/cancel`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json().catch(() => ({}));
    const bill = await bills.loadBill(db, ctx.req.param('id'));
    if (!bill) throw new HttpError('That bill does not exist.', { status: 404, code: 'BILL_NOT_FOUND' });
    if (!inScope(ctx.get('scope'), bill)) throw new HttpError('That bill is at another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    const own = String(bill.raised_by) === String(user.id);
    if (!own && !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only the person who raised the bill, or a manager, can cancel it.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    if (bill.status === 'PAID') {
      throw new HttpError(`Bill ${bill.bill_no} is already paid. Void the sale if the goods must come back — cancelling the bill would not undo the receipt.`, { status: 409, code: 'BILL_ALREADY_PAID' });
    }
    const reason = strField(body.reason, { field: 'Reason', maxLength: 300 }) || 'Cancelled before payment. The hold has been released.';
    await bills.closeUnpaid(db, bill, { status: 'CANCELLED', by: user.id, reason });
    await recordFromCtx(ctx, {
      action: 'BILL_CANCELLED',
      entityType: 'CUSTOMER_BILL',
      entityId: bill.id,
      branchId: bill.branch_id,
      businessId: bill.business_id,
      after: { bill_no: bill.bill_no, reason },
    });
    ctx.json({
      ok: true,
      message: `Bill ${bill.bill_no} is cancelled. The goods are free to sell again. Nothing was received, so there is no receipt to void.`,
    });
  });
}

module.exports = { mount };
