'use strict';
// =====================================================================
// server/routes/dispatch.js — THE MIX, THE FLEET, THE PARTNER'S PAY
// =====================================================================
// The owner confirms one vehicle type, or two. A vehicle on the fleet
// has to be one of those. A partner is paid when the drop is delivered,
// and the payout is an expense posted once — not a second sale, and not
// a wage pretending to be a commission.

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { idempotent } = require('../lib/idempotency');
const { atLeast } = require('../../domain/roles');
const { resolveBusiness, inScope, strField, numField } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watToday } = require('../../domain/time');
const { resolveProfile } = require('../../domain/verticals');
const {
  VEHICLE_CLASSES, ARRANGEMENTS, normaliseModes, modesFromOverrides, modeMatches, classOf, arrangementOf,
} = require('../../domain/dispatch');
const glService = require('../services/glService');

function parseOverrides(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function profileOf(business) {
  return resolveProfile(business.profile_code, parseOverrides(business.profile_overrides_json));
}

async function loadBusiness(db, ctx) {
  const business = await resolveBusiness(db, ctx);
  if (!business) throw new HttpError('Choose a business first.', { status: 400, code: 'BUSINESS_REQUIRED' });
  return business;
}

function setupOf(business) {
  const profile = profileOf(business);
  const state = modesFromOverrides(parseOverrides(business.profile_overrides_json), profile);
  return {
    enabled: Boolean(profile && profile.dispatch),
    confirmed: state.confirmed,
    modes: state.modes,
    vehiclesOffered: VEHICLE_CLASSES,
    arrangements: ARRANGEMENTS,
  };
}

function mount(app, base = '/api') {
  app.get(`${base}/dispatch`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await loadBusiness(db, ctx);
    const setup = setupOf(business);
    const vehicles = await db.all(
      `SELECT * FROM delivery_vehicles WHERE business_id = ? AND is_deleted = 0 ORDER BY vehicle_class, name`,
      [String(business.id)],
    );
    ctx.json({ ok: true, ...setup, vehicles });
  });

  app.put(`${base}/dispatch`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) {
      throw new HttpError('Only the owner confirms which vehicles this business uses.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const business = await loadBusiness(db, ctx);
    const profile = profileOf(business);
    if (!profile || !profile.dispatch) {
      throw new HttpError('This business does not run a dispatch mix. Water packing and bakery do.', { status: 400, code: 'DISPATCH_NOT_FOR_PROFILE' });
    }
    const body = await ctx.req.json();
    const parsed = normaliseModes(body.modes || body.dispatch_modes);
    if (!parsed.ok) throw new HttpError(parsed.error, { status: 400, code: parsed.code });
    const overrides = parseOverrides(business.profile_overrides_json);
    overrides.dispatch = { modes: parsed.modes };
    await db.run(
      `UPDATE businesses SET profile_overrides_json = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(overrides), String(business.id)],
    );
    await recordFromCtx(ctx, {
      action: 'DISPATCH_MIX_SAVED', entityType: 'BUSINESS', entityId: business.id, businessId: business.id,
      after: { modes: parsed.modes },
    });
    ctx.json({
      ok: true,
      confirmed: true,
      modes: parsed.modes,
      message: 'Dispatch mix saved. Vehicles you add have to be one of these, and a partner is paid only after the drop is delivered.',
    });
  });

  app.post(`${base}/dispatch/vehicles`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager adds a vehicle to the fleet.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const business = await loadBusiness(db, ctx);
    const setup = setupOf(business);
    if (!setup.enabled) throw new HttpError('This business does not keep a dispatch fleet.', { status: 400, code: 'DISPATCH_NOT_FOR_PROFILE' });
    if (!setup.confirmed) {
      throw new HttpError('Confirm the dispatch mix first. A vehicle cannot be added to a mix the owner has not saved.', { status: 400, code: 'DISPATCH_UNCONFIRMED' });
    }
    const body = await ctx.req.json();
    const vehicleClass = String(body.vehicle_class || body.vehicleClass || '').toUpperCase();
    const arrangement = String(body.arrangement || '').toUpperCase();
    if (!classOf(vehicleClass) || !arrangementOf(arrangement)) {
      throw new HttpError('Name the vehicle type and whether the business owns it or a partner does.', { status: 400, code: 'DISPATCH_VEHICLE' });
    }
    if (!modeMatches(setup.modes, vehicleClass, arrangement)) {
      throw new HttpError('That combination is not in the confirmed mix. Change the mix, or pick one of the types already saved.', { status: 400, code: 'VEHICLE_NOT_IN_MIX' });
    }
    const mode = setup.modes.find((item) => item.vehicleClass === vehicleClass && item.arrangement === arrangement);
    const name = strField(body.name, { field: 'Vehicle name', maxLength: 80, required: true });
    if (!name || name.length < 2) throw new HttpError('Name the vehicle so the board can tell two kekes apart.', { status: 400, code: 'VEHICLE_NAME' });
    const id = newId();
    const branchId = body.branch_id ? String(body.branch_id) : null;
    await db.run(`INSERT INTO delivery_vehicles (
        id, business_id, branch_id, name, plate_no, vehicle_class, arrangement, pay_basis, sales_share_pct,
        driver_name, driver_phone, driver_user_id, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 1, datetime('now'), datetime('now'))`, [
      id, String(business.id), branchId, name,
      strField(body.plate_no || body.plate, { field: 'Plate', maxLength: 20 }),
      vehicleClass, arrangement, mode.payBasis, mode.salesSharePct,
      strField(body.driver_name, { field: 'Driver', maxLength: 120 }),
      strField(body.driver_phone, { field: 'Driver phone', maxLength: 40 }),
      body.driver_user_id ? String(body.driver_user_id) : null,
    ]);
    await recordFromCtx(ctx, {
      action: 'DISPATCH_VEHICLE_ADDED', entityType: 'DELIVERY_VEHICLE', entityId: id, businessId: business.id,
      after: { name, vehicleClass, arrangement },
    });
    ctx.json({ ok: true, id, message: `${name} is on the fleet.` }, 201);
  }));

  app.post(`${base}/deliveries/:id/partner-pay`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings') || {};
    const id = String(ctx.req.param('id'));
    const job = await db.first('SELECT * FROM delivery_jobs WHERE id = ? AND is_deleted = 0', [id]);
    if (!job) throw new HttpError('That delivery job does not exist.', { status: 404, code: 'DELIVERY_NOT_FOUND' });
    if (!inScope(ctx.get('scope'), job)) throw new HttpError('That delivery belongs to another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    if (String(job.status) !== 'DELIVERED') {
      throw new HttpError('Pay a partner when the drop is delivered, not before. An undelivered load has not earned the share.', { status: 409, code: 'NOT_DELIVERED' });
    }
    if (String(job.arrangement) !== 'PARTNER') {
      throw new HttpError('This drop is on a vehicle the business owns. The driver is paid a wage, not a share of this sale.', { status: 409, code: 'NOT_A_PARTNER' });
    }
    if (job.partner_expense_id) {
      throw new HttpError('This drop already has a partner payout. Paying it again would pay the rider twice.', { status: 409, code: 'ALREADY_PAID' });
    }
    const amount = round2(Number(job.driver_pay) || 0);
    if (amount < 0.01) {
      throw new HttpError('This drop has no partner share to pay. Check the sale total and the share on the mix.', { status: 409, code: 'NOTHING_TO_PAY' });
    }
    const body = await ctx.req.json().catch(() => ({}));
    const method = String(body.payment_method || 'BANK_TRANSFER').toUpperCase();
    if (!['CASH', 'BANK_TRANSFER'].includes(method)) {
      throw new HttpError('Pay a partner in cash or by transfer.', { status: 400, code: 'PAYMENT_METHOD' });
    }
    const needsApproval = !atLeast(user.role, 'MANAGER') && Boolean(Number(settings.managers_can_approve_expenses));
    const status = needsApproval ? 'PENDING_APPROVAL' : 'APPROVED';
    const expenseId = newId();
    const description = `Partner share for ${job.driver_name || 'the rider'} on ${job.job_no} (${job.sales_share_pct || 0}% of the goods, not the delivery fee).`;
    const paidFrom = method === 'CASH' ? 'TILL' : 'BANK';
    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [job.branch_id]);
    const business = await db.first('SELECT * FROM businesses WHERE id = ?', [job.business_id]);
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const expenseRow = {
      id: expenseId, category: 'PARTNER_PAYOUT', description, amount,
      vat_amount: 0, wht_amount: 0, net_amount: amount, paid_from: paidFrom, status,
    };
    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO expenses (
          id, branch_id, business_id, category, description, amount, vat_amount,
          wht_amount, net_amount, expense_date, payment_method, reference,
          status, approved_by, approved_at, paid_from, created_by, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,0, 0,?,?,?,?, ?,?, ?,?,?,?, datetime('now'), datetime('now'))`, [
        expenseId, String(job.branch_id), String(job.business_id), 'PARTNER_PAYOUT', description, amount,
        amount, watToday(), method, `dispatch:${job.id}`,
        status, status === 'APPROVED' ? String(user.id) : null, status === 'APPROVED' ? watToday() : null,
        paidFrom, String(user.id),
        'Share of sales delivered. Withholding tax was not deducted on this payout.',
      ]);
      tx.queue(
        `UPDATE delivery_jobs SET partner_expense_id = ?, updated_at = datetime('now') WHERE id = ? AND partner_expense_id IS NULL`,
        [expenseId, id],
      );
      if (status === 'APPROVED') {
        for (const st of glService.postExpenseStatements({
          expense: expenseRow, business, branch, user, accountIds, vatInput: 0, whtAmount: 0,
        })) tx.queue(st.sql, st.params);
      }
    });
    await recordFromCtx(ctx, {
      action: 'PARTNER_PAYOUT', entityType: 'DELIVERY_JOB', entityId: id,
      branchId: job.branch_id, businessId: job.business_id,
      after: { expenseId, amount, method, status, driver: job.driver_name },
    });
    ctx.json({
      ok: true,
      id: expenseId,
      amount,
      status,
      message: needsApproval
        ? `₦${amount.toLocaleString('en-NG')} for ${job.driver_name || 'the partner'} is waiting for approval.`
        : `₦${amount.toLocaleString('en-NG')} recorded for ${job.driver_name || 'the partner'} on ${job.job_no}.`,
    });
  }));
}

module.exports = { mount };
