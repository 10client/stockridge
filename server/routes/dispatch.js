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
const { resolveBusiness, resolveBranch, inScope, strField, numField, boolField } = require('../lib/respond');
const { round2, roundTo } = require('../../domain/money');
const { weightedAverageCost } = require('../../domain/uom');
const { newId } = require('../../domain/crypto');
const { watToday, watNow, watToUtc } = require('../../domain/time');
const { resolveProfile, inputSeeds, ladderForSeedProduct, baseUnitNameFor } = require('../../domain/verticals');
const { eanCheckDigit } = require('../../domain/validation');
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

function categoryCode(name) {
  const code = String(name || 'INPUT').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  return code || 'INPUT';
}

function shelfBarcode(seed) {
  let n = 0;
  const s = String(seed || 'input');
  for (let i = 0; i < s.length; i += 1) n = (n * 33 + s.charCodeAt(i)) >>> 0;
  const body = `2${String(n).padStart(11, '0').slice(-11)}`;
  return `${body}${eanCheckDigit(body)}`;
}

async function ensureCategory(db, businessId, code, name) {
  const existing = await db.first(
    'SELECT id FROM product_categories WHERE business_id = ? AND code = ? AND is_deleted = 0',
    [String(businessId), code],
  );
  if (existing) return existing.id;
  const id = newId();
  await db.run(`INSERT INTO product_categories (id, business_id, code, name, sort_order, is_active, created_at, updated_at)
                VALUES (?,?,?,?, 80, 1, datetime('now'), datetime('now'))`,
  [id, String(businessId), code, name]);
  return id;
}


function dateField(value, label) {
  const day = strField(value, { field: label, maxLength: 10, required: true });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new HttpError(`${label} must be YYYY-MM-DD.`, { status: 400, code: 'INVALID_DATE' });
  }
  if (day > watToday()) {
    throw new HttpError(`${label} cannot be in the future.`, { status: 400, code: 'INVALID_DATE' });
  }
  return day;
}

/**
 * A confirmed mix is a vehicle the board can choose, not only a sentence.
 * Creating the business saves the type. This puts that type on the fleet
 * when no active vehicle of that type and arrangement already exists.
 * It does not invent a plate or a driver, and it does not add a second
 * pickup when one is already there.
 */
async function ensureFleet(db, business, modes, branchId) {
  if (!business || !Array.isArray(modes) || !modes.length) return [];
  const existing = await db.all(
    `SELECT vehicle_class, arrangement FROM delivery_vehicles
     WHERE business_id = ? AND is_deleted = 0 AND is_active = 1`,
    [String(business.id)],
  );
  const have = new Set(existing.map((row) => `${row.vehicle_class}:${row.arrangement}`));
  let home = branchId ? String(branchId) : null;
  if (!home) {
    const branch = await db.first(
      'SELECT id FROM branches WHERE business_id = ? AND is_deleted = 0 AND is_active = 1 ORDER BY created_at LIMIT 1',
      [String(business.id)],
    );
    home = branch ? String(branch.id) : null;
  }
  const added = [];
  for (const mode of modes) {
    const key = `${mode.vehicleClass}:${mode.arrangement}`;
    if (have.has(key)) continue;
    const vehicle = classOf(mode.vehicleClass);
    const id = newId();
    await db.run(`INSERT INTO delivery_vehicles (
        id, business_id, branch_id, name, plate_no, vehicle_class, arrangement, pay_basis, sales_share_pct,
        is_active, created_at, updated_at)
      VALUES (?,?,?,?,NULL,?,?,?,?, 1, datetime('now'), datetime('now'))`, [
      id, String(business.id), home, vehicle ? vehicle.label : mode.vehicleClass,
      mode.vehicleClass, mode.arrangement, mode.payBasis || null, mode.salesSharePct,
    ]);
    have.add(key);
    added.push(id);
  }
  return added;
}

async function loadAsset(db, id, businessId) {
  const asset = await db.first('SELECT * FROM plant_assets WHERE id = ? AND is_deleted = 0', [String(id)]);
  if (!asset || String(asset.business_id) !== String(businessId)) {
    throw new HttpError('That machine or tool is not on this plant.', { status: 404, code: 'ASSET_NOT_FOUND' });
  }
  return asset;
}

async function insertInputProduct(db, business, seed, { offersSale = false } = {}) {
  const profile = profileOf(business);
  const code = seed.category || categoryCode(seed.categoryName || seed.name);
  const categoryId = await ensureCategory(db, business.id, code, seed.categoryName || seed.name);
  const id = newId();
  const unitName = baseUnitNameFor(profile, seed);
  await db.run(`INSERT INTO products (
      id, business_id, category_id, sku, name, base_unit_name, cost_price, selling_price,
      reorder_level, has_expiry, valuation_method, offers_sale, stock_role, is_active, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'WEIGHTED_AVG', ?, 'INPUT', 1, datetime('now'), datetime('now'))`, [
    id, String(business.id), categoryId, seed.sku || null, seed.name, unitName,
    round2(Number(seed.cost) || 0), round2(Number(seed.price) || 0),
    Number(seed.reorder) || 0, seed.expiry ? 1 : 0,
    offersSale ? 1 : 0,
  ]);
  const ladder = ladderForSeedProduct(profile, seed);
  const levels = Array.isArray(ladder) && ladder.length ? ladder : [{ code: 'PIECE', name: unitName, plural: unitName, quantityInBase: 1, isDefaultSell: true }];
  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i];
    await db.run(`INSERT INTO product_units (
        id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
      newId(), id, i, level.code || 'PIECE', level.name || unitName, level.plural || level.name || unitName,
      Number(level.quantityInBase) || 1, offersSale ? 1 : 0, level.isDefaultSell ? 1 : 0,
    ]);
  }
  for (let n = 0; n < 4; n += 1) {
    const codeValue = shelfBarcode(`${id}|${n}`);
    const clash = await db.first('SELECT id FROM product_barcodes WHERE barcode = ?', [codeValue]);
    if (clash) continue;
    await db.run(`INSERT INTO product_barcodes (id, product_id, barcode, unit_code, label, is_primary, created_at, updated_at)
                  VALUES (?,?,?,?, 'Shelf label', 1, datetime('now'), datetime('now'))`,
    [newId(), id, codeValue, levels[0].code || 'PIECE']);
    await db.run("UPDATE products SET barcode = ?, updated_at = datetime('now') WHERE id = ?", [codeValue, id]);
    break;
  }
  return id;
}

function mount(app, base = '/api') {
  app.get(`${base}/dispatch`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await loadBusiness(db, ctx);
    const setup = setupOf(business);
    if (setup.confirmed && setup.modes && setup.modes.length) {
      await ensureFleet(db, business, setup.modes);
    }
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
    await ensureFleet(db, business, parsed.modes);
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

  /**
   * What a plant is holding: unpaid credit supplies, manufacturing stock,
   * and machinery service cost. Credit is the customer balance already on
   * the books. Inputs are products marked INPUT. Leather is not invented.
   */
  app.get(`${base}/plant`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const business = await loadBusiness(db, ctx);
    const profile = profileOf(business);
    const branch = await resolveBranch(db, ctx, { required: false });
    const branchId = branch ? String(branch.id) : null;
    const inputs = await db.all(`SELECT p.id, p.name, p.sku, p.base_unit_name, p.cost_price, p.offers_sale,
          p.reorder_level, p.has_expiry,
          COALESCE(SUM(CASE WHEN b.is_deleted = 0 AND b.status = 'ACTIVE' THEN b.quantity ELSE 0 END), 0) AS on_hand,
          COALESCE(SUM(CASE WHEN b.is_deleted = 0 AND b.status = 'ACTIVE' AND b.branch_id = ? THEN b.quantity ELSE 0 END), 0) AS branch_on_hand,
          COALESCE(SUM(CASE WHEN b.is_deleted = 0 AND b.status = 'ACTIVE' THEN b.quantity * b.cost_price_per_unit ELSE 0 END), 0) AS stock_value
        FROM products p
        LEFT JOIN stock_batches b ON b.product_id = p.id
        WHERE p.business_id = ? AND p.is_deleted = 0 AND p.stock_role = 'INPUT'
        GROUP BY p.id
        ORDER BY p.name`, [branchId || '', String(business.id)]);
    const openCredit = await db.all(`SELECT id, name, phone, credit_balance, credit_limit
        FROM customers
        WHERE business_id = ? AND is_deleted = 0 AND credit_balance > 0.009
        ORDER BY credit_balance DESC LIMIT 40`, [String(business.id)]);
    const machinery30 = await db.first(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
        FROM expenses
        WHERE business_id = ? AND is_deleted = 0 AND category = 'MACHINERY_SERVICE'
          AND expense_date >= date('now', '+1 hours', '-30 days')`, [String(business.id)]);
    const machineryAll = await db.first(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
        FROM expenses
        WHERE business_id = ? AND is_deleted = 0 AND category = 'MACHINERY_SERVICE'`, [String(business.id)]);
    const assets = await db.all(`SELECT a.*,
          (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
            WHERE e.plant_asset_id = a.id AND e.is_deleted = 0 AND e.status <> 'REJECTED') AS maintenance_total,
          (SELECT COUNT(*) FROM expenses e
            WHERE e.plant_asset_id = a.id AND e.is_deleted = 0 AND e.status <> 'REJECTED') AS maintenance_count
        FROM plant_assets a
        WHERE a.business_id = ? AND a.is_deleted = 0
        ORDER BY CASE a.status WHEN 'WORKING' THEN 0 ELSE 1 END, a.name`, [String(business.id)]);
    const receipts = await db.all(`SELECT b.id, b.product_id, p.name AS product_name, p.base_unit_name,
          b.initial_quantity, b.quantity, b.cost_price_per_unit, b.received_at, b.notes, b.expiry_date
        FROM stock_batches b
        JOIN products p ON p.id = b.product_id
        WHERE b.business_id = ? AND b.is_deleted = 0 AND p.is_deleted = 0 AND p.stock_role = 'INPUT'
        ORDER BY b.received_at DESC, b.created_at DESC LIMIT 24`, [String(business.id)]);
    const services = await db.all(`SELECT id, plant_asset_id, amount, expense_date, description, payment_method
        FROM expenses
        WHERE business_id = ? AND plant_asset_id IS NOT NULL AND is_deleted = 0 AND status <> 'REJECTED'
        ORDER BY expense_date DESC, created_at DESC LIMIT 80`, [String(business.id)]);
    const useRows = await db.all(`SELECT id, product_id, quantity, unit_cost, total_value, reason, created_at
        FROM stock_adjustments
        WHERE business_id = ? AND is_deleted = 0 AND adjustment_type = 'OTHER'
          AND reason LIKE 'Used in production:%'
        ORDER BY created_at DESC LIMIT 24`, [String(business.id)]);
    const uses = useRows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      quantity: roundTo(Math.abs(Number(row.quantity) || 0), 4),
      cost: round2(Number(row.unit_cost) || 0),
      value: round2(Math.abs(Number(row.total_value) || 0)),
      reason: String(row.reason || '').replace(/^Used in production:\s*/, ''),
      at: row.created_at,
    }));
    const have = new Set(inputs.map((row) => row.sku).filter(Boolean));
    const missing = inputSeeds(profile).filter((seed) => seed.sku && !have.has(seed.sku)).map((seed) => ({
      sku: seed.sku, name: seed.name,
    }));
    ctx.json({
      ok: true,
      creditUntilPaid: Boolean(profile.creditUntilPaid),
      manufacturing: Boolean(profile.manufacturing),
      openCredit: openCredit.map((row) => ({
        id: row.id,
        name: row.name,
        phone: row.phone,
        balance: round2(Number(row.credit_balance) || 0),
        limit: round2(Number(row.credit_limit) || 0),
      })),
      inputs: inputs.map((row) => {
        const onHand = round2(Number(row.on_hand) || 0);
        const reorder = round2(Number(row.reorder_level) || 0);
        const here = branchId ? round2(Number(row.branch_on_hand) || 0) : onHand;
        return {
          id: row.id,
          name: row.name,
          sku: row.sku,
          unit: row.base_unit_name,
          onHand,
          branchOnHand: here,
          value: round2(Number(row.stock_value) || 0),
          reorder,
          low: reorder > 0 && here <= reorder,
          hasExpiry: Number(row.has_expiry) === 1,
          offersSale: Number(row.offers_sale) === 1,
        };
      }),
      inputValue: round2(inputs.reduce((sum, row) => sum + (Number(row.stock_value) || 0), 0)),
      machinery: {
        days30: round2(Number(machinery30 && machinery30.total) || 0),
        count30: Number(machinery30 && machinery30.n) || 0,
        allTime: round2(Number(machineryAll && machineryAll.total) || 0),
        countAll: Number(machineryAll && machineryAll.n) || 0,
      },
      assets: assets.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        acquiredAt: row.acquired_at,
        purchasePrice: round2(Number(row.purchase_price) || 0),
        supplierName: row.supplier_name,
        serialNo: row.serial_no,
        status: row.status,
        stoppedAt: row.stopped_at,
        stoppedReason: row.stopped_reason,
        notes: row.notes,
        maintenanceTotal: round2(Number(row.maintenance_total) || 0),
        maintenanceCount: Number(row.maintenance_count) || 0,
        services: services.filter((item) => String(item.plant_asset_id) === String(row.id)).slice(0, 4).map((item) => ({
          id: item.id,
          amount: round2(Number(item.amount) || 0),
          date: item.expense_date,
          description: item.description,
          method: item.payment_method,
        })),
      })),
      receipts: receipts.map((row) => ({
        id: row.id,
        productId: row.product_id,
        name: row.product_name,
        unit: row.base_unit_name,
        quantity: round2(Number(row.initial_quantity) || 0),
        remaining: round2(Number(row.quantity) || 0),
        price: round2(Number(row.cost_price_per_unit) || 0),
        receivedAt: row.received_at,
        expiry: row.expiry_date,
        notes: row.notes,
        stillOwed: String(row.notes || '').includes('Still owed'),
      })),
      uses,
      missing,
      viewer: {
        role: user && user.role,
        canManage: atLeast(user && user.role, 'MANAGER'),
        branchName: branch ? branch.name : null,
      },
    });
  });

  app.post(`${base}/plant/inputs/ensure`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager adds the plant inputs.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const business = await loadBusiness(db, ctx);
    const profile = profileOf(business);
    const seeds = inputSeeds(profile);
    const added = [];
    const marked = [];
    for (const seed of seeds) {
      const existing = seed.sku
        ? await db.first('SELECT id, stock_role, offers_sale FROM products WHERE business_id = ? AND sku = ? AND is_deleted = 0', [String(business.id), seed.sku])
        : null;
      if (existing) {
        if (existing.stock_role !== 'INPUT') {
          await db.run("UPDATE products SET stock_role = 'INPUT', updated_at = datetime('now') WHERE id = ?", [existing.id]);
          marked.push(seed.sku);
        }
        continue;
      }
      await insertInputProduct(db, business, seed, { offersSale: false });
      added.push(seed.sku || seed.name);
    }
    ctx.json({
      ok: true,
      added,
      marked,
      message: added.length
        ? `Added ${added.length} plant input${added.length === 1 ? '' : 's'}. They are counted as stock and are not sold at the till.`
        : (marked.length ? 'Existing inputs are now counted as manufacturing stock.' : 'The usual inputs are already on this plant.'),
    });
  });

  app.post(`${base}/plant/inputs`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager adds a manufacturing input.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const business = await loadBusiness(db, ctx);
    const body = await ctx.req.json();
    const name = strField(body.name, { field: 'Name', maxLength: 160, required: true });
    if (!name || name.length < 2) throw new HttpError('Name the input. Chemicals, film, flour, leather — whatever this plant actually uses.', { status: 400, code: 'NAME_REQUIRED' });
    const categoryName = strField(body.category_name, { field: 'Category', maxLength: 80 }) || 'Manufacturing inputs';
    const unit = strField(body.unit, { field: 'Unit', maxLength: 40 }) || 'piece';
    const id = await insertInputProduct(db, business, {
      name,
      sku: strField(body.sku, { field: 'SKU', maxLength: 40 }) || null,
      category: categoryCode(categoryName),
      categoryName,
      cost: numField(body.cost, { field: 'Cost', min: 0 }),
      price: 0,
      reorder: numField(body.reorder, { field: 'Reorder', min: 0 }),
      ladder: 'EACH_ONLY',
    }, { offersSale: Boolean(boolField(body.offers_sale)) });
    if (unit && unit.toLowerCase() !== 'piece') {
      await db.run("UPDATE products SET base_unit_name = ?, updated_at = datetime('now') WHERE id = ?", [unit.toLowerCase(), id]);
      await db.run("UPDATE product_units SET name = ?, plural_name = ?, updated_at = datetime('now') WHERE product_id = ? AND level = 0", [unit, unit, id]);
    }
    await recordFromCtx(ctx, {
      action: 'PLANT_INPUT_ADDED', entityType: 'PRODUCT', entityId: id, businessId: business.id,
      after: { name, category: categoryName },
    });
    ctx.json({
      ok: true,
      id,
      message: `${name} is on the plant stock. It is not sold at the till unless you say it is also sold.`,
    }, 201);
  });

  /**
   * A machine or a tool, recorded from the day it was gotten.
   * The price is the fact of what was paid then. It is not posted again
   * into this month's books: a filler bought in 2022 must not look like
   * a purchase made today. Maintenance, which is money leaving now, is
   * an expense on the existing ledger.
   */
  app.post(`${base}/plant/assets`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager records a machine or a tool.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const business = await loadBusiness(db, ctx);
    const branch = await resolveBranch(db, ctx, { required: false });
    const body = await ctx.req.json();
    const name = strField(body.name, { field: 'Name', maxLength: 160, required: true });
    if (!name || name.length < 2) throw new HttpError('Name the machine or the tool. A filler, an oven, a UV lamp, a sealing jaw.', { status: 400, code: 'NAME_REQUIRED' });
    const kind = String(body.kind || 'MACHINE').toUpperCase();
    if (!['MACHINE', 'TOOL'].includes(kind)) {
      throw new HttpError('Say whether this is a machine or a tool.', { status: 400, code: 'ASSET_KIND' });
    }
    const acquiredAt = dateField(body.acquired_at || body.acquiredAt, 'Date gotten');
    const price = numField(body.purchase_price != null ? body.purchase_price : body.price, { field: 'Price', min: 0 });
    const id = newId();
    await db.run(`INSERT INTO plant_assets (
        id, business_id, branch_id, name, kind, acquired_at, purchase_price, supplier_name, serial_no, notes, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
      id, String(business.id), branch ? String(branch.id) : null, name, kind, acquiredAt, price,
      strField(body.supplier_name, { field: 'Where it was gotten', maxLength: 160 }),
      strField(body.serial_no, { field: 'Serial number', maxLength: 80 }),
      strField(body.notes, { field: 'Notes', maxLength: 500 }),
      String(user.id),
    ]);
    await recordFromCtx(ctx, {
      action: 'PLANT_ASSET_ADDED', entityType: 'PLANT_ASSET', entityId: id, businessId: business.id,
      after: { name, kind, acquiredAt, price },
    });
    ctx.json({
      ok: true, id,
      message: `${name} is on the plant. Gotten ${acquiredAt} for ₦${price.toLocaleString('en-NG')}. Repairs you record against it add up on this machine, not in a separate book.`,
    }, 201);
  }));

  app.post(`${base}/plant/assets/:id/stop`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager records when a machine or a tool stops working.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const business = await loadBusiness(db, ctx);
    const asset = await loadAsset(db, ctx.req.param('id'), business.id);
    const body = await ctx.req.json();
    const workingAgain = String(body.status || '').toUpperCase() === 'WORKING';
    if (workingAgain) {
      if (asset.status !== 'STOPPED') throw new HttpError('This is already in use.', { status: 409, code: 'ASSET_WORKING' });
      const note = `\n[${watNow()}] Back in use, recorded by ${user.full_name || user.username}. It had stopped on ${asset.stopped_at || 'an unstated day'}${asset.stopped_reason ? `: ${asset.stopped_reason}` : ''}.`;
      await db.run(`UPDATE plant_assets SET status = 'WORKING', stopped_at = NULL, stopped_reason = NULL,
          notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?`, [note, String(asset.id)]);
      ctx.json({ ok: true, message: `${asset.name} is back in use. The day it stopped stays in the notes.` });
      return;
    }
    if (asset.status === 'STOPPED') {
      throw new HttpError(`${asset.name} is already recorded as stopped on ${asset.stopped_at}.`, { status: 409, code: 'ASSET_STOPPED' });
    }
    const stoppedAt = dateField(body.stopped_at || body.stoppedAt, 'Date it stopped');
    if (stoppedAt < String(asset.acquired_at)) {
      throw new HttpError('It cannot have stopped before the day it was gotten.', { status: 400, code: 'INVALID_DATE' });
    }
    const reason = strField(body.reason || body.stopped_reason, { field: 'Why it stopped', maxLength: 300, required: true });
    if (!reason || reason.length < 4) throw new HttpError('Say why it stopped. A burnt element, a seized gearbox, a cracked jaw — the next person has to know.', { status: 400, code: 'REASON_REQUIRED' });
    await db.run(`UPDATE plant_assets SET status = 'STOPPED', stopped_at = ?, stopped_reason = ?, updated_at = datetime('now') WHERE id = ?`, [
      stoppedAt, reason, String(asset.id),
    ]);
    await recordFromCtx(ctx, {
      action: 'PLANT_ASSET_STOPPED', entityType: 'PLANT_ASSET', entityId: asset.id, businessId: business.id,
      before: { status: asset.status }, after: { status: 'STOPPED', stoppedAt, reason },
    });
    ctx.json({ ok: true, message: `${asset.name} stopped working on ${stoppedAt}. It stays on the register. It is not deleted.` });
  }));

  app.post(`${base}/plant/assets/:id/service`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager records maintenance on a machine or a tool.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);
    const asset = await loadAsset(db, ctx.req.param('id'), business.id);
    const body = await ctx.req.json();
    const amount = numField(body.amount, { field: 'Amount', min: 0.01 });
    const what = strField(body.description, { field: 'What was done', maxLength: 300, required: true });
    if (!what || what.length < 4) throw new HttpError('Say what was done. A new heating element, a gearbox service, a jaw replacement.', { status: 400, code: 'DESCRIPTION_REQUIRED' });
    const expenseDate = dateField(body.expense_date || body.expenseDate || watToday(), 'Service date');
    const paymentMethod = String(body.payment_method || 'BANK_TRANSFER').toUpperCase();
    if (!['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY'].includes(paymentMethod)) {
      throw new HttpError('Say how it was paid.', { status: 400, code: 'PAYMENT_METHOD' });
    }
    const paidFrom = paymentMethod === 'CASH' ? 'TILL' : 'BANK';
    const id = newId();
    const description = `${asset.name}: ${what}`;
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const expenseRow = {
      id, category: 'MACHINERY_SERVICE', description, amount,
      vat_amount: 0, wht_amount: 0, net_amount: amount,
      expense_date: expenseDate, payment_method: paymentMethod, status: 'APPROVED', paid_from: paidFrom,
    };
    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO expenses (
          id, branch_id, business_id, category, description, amount, vat_amount, wht_amount, net_amount,
          expense_date, payment_method, status, approved_by, approved_at, paid_from, created_by, plant_asset_id, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,0,0,?,?,?, 'APPROVED', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
        id, String(branch.id), String(business.id), 'MACHINERY_SERVICE', description, amount, amount,
        expenseDate, paymentMethod, String(user.id), watNow(), paidFrom, String(user.id), String(asset.id),
        strField(body.notes, { field: 'Notes', maxLength: 300 }),
      ]);
      for (const st of glService.postExpenseStatements({
        expense: expenseRow, business: { id: business.id }, branch: { id: branch.id },
        user, accountIds, vatInput: 0, whtAmount: 0,
      })) tx.queue(st.sql, st.params);
    });
    await recordFromCtx(ctx, {
      action: 'PLANT_ASSET_SERVICED', entityType: 'PLANT_ASSET', entityId: asset.id, businessId: business.id, branchId: branch.id,
      after: { expenseId: id, amount, expenseDate },
    });
    ctx.json({
      ok: true, id,
      message: `₦${amount.toLocaleString('en-NG')} recorded against ${asset.name}. It adds to the maintenance this machine has taken, and it is the same expense book the rest of the plant uses.`,
    }, 201);
  }));

  /**
   * Production stock arriving: film, flour, alum, chlorine, yeast.
   * Date, price and amount go onto a stock batch. The purchase posts
   * to the same stock account a goods receipt uses. It is not a second inventory.
   */
  app.post(`${base}/plant/inputs/:id/receive`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager records production stock when it is gotten.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [String(ctx.req.param('id'))]);
    if (!product || String(product.business_id) !== String(business.id) || product.stock_role !== 'INPUT') {
      throw new HttpError('That is not a production input on this plant. Film, flour and treatment chemical are recorded here. Till goods are received on the stock screen.', { status: 404, code: 'INPUT_NOT_FOUND' });
    }
    const body = await ctx.req.json();
    const quantity = numField(body.quantity, { field: 'Amount', min: 0.0001, places: 4 });
    const price = numField(body.price != null ? body.price : body.cost, { field: 'Price', min: 0.01, places: 6 });
    const receivedOn = dateField(body.received_on || body.received_at, 'Date gotten');
    const receivedAt = watToUtc(`${receivedOn} 12:00:00`) || `${receivedOn} 11:00:00`;
    const supplierName = strField(body.supplier_name, { field: 'Supplier', maxLength: 160 });
    const note = strField(body.notes, { field: 'Notes', maxLength: 300 });
    const paidNowFlag = body.paid_now == null ? true : Boolean(boolField(body.paid_now));
    if (!paidNowFlag && !supplierName) {
      throw new HttpError('Name the supplier if this delivery is not paid yet. The amount has to sit against somebody.', { status: 400, code: 'SUPPLIER_REQUIRED' });
    }
    let expiry = null;
    if (body.expiry_date) {
      expiry = strField(body.expiry_date, { field: 'Expiry', maxLength: 10, required: true });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
        throw new HttpError('Expiry must be YYYY-MM-DD.', { status: 400, code: 'INVALID_DATE' });
      }
      if (expiry < receivedOn) {
        throw new HttpError('The expiry cannot be before the day it was gotten.', { status: 400, code: 'INVALID_DATE' });
      }
    }
    const batchId = newId();
    const held = await db.all('SELECT quantity, cost_price_per_unit FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0', [
      String(product.id), String(branch.id),
    ]);
    const newAvg = weightedAverageCost([
      ...held.map((row) => ({ quantity: Number(row.quantity), cost: Number(row.cost_price_per_unit) })),
      { quantity, cost: price },
    ]);
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const gross = round2(quantity * price);
    const paidNow = paidNowFlag ? gross : 0;
    const onCredit = paidNowFlag ? 0 : gross;
    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO stock_batches (
          id, branch_id, business_id, product_id, batch_no, cost_price_per_unit, selling_price_per_unit,
          quantity, quantity_reserved, initial_quantity, expiry_date, received_at, received_by, status, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,0, ?,0,?,?,?,?, 'ACTIVE', ?, datetime('now'), datetime('now'))`, [
        batchId, String(branch.id), String(business.id), String(product.id),
        `IN-${receivedOn.replace(/-/g, '')}-${batchId.slice(0, 4).toUpperCase()}`,
        price, quantity, quantity, expiry, receivedAt, String(user.id),
        [supplierName ? `From ${supplierName}` : null, paidNowFlag ? 'Paid on delivery' : 'Still owed', note, `Gotten ${receivedOn}`].filter(Boolean).join('. '),
      ]);
      if (newAvg != null) {
        tx.queue("UPDATE products SET cost_price = ?, updated_at = datetime('now') WHERE id = ? AND business_id = ?", [
          round2(newAvg), String(product.id), String(business.id),
        ]);
      }
      for (const st of glService.postPurchaseReceiptStatements({
        businessId: business.id, branchId: branch.id, poId: batchId,
        items: [{ quantity_received: quantity, cost_per_unit: price }],
        supplier: supplierName ? { name: supplierName } : null,
        paidNow, onCredit, user, accountIds,
      })) tx.queue(st.sql, st.params);
    });
    await recordFromCtx(ctx, {
      action: 'PLANT_INPUT_RECEIVED', entityType: 'PRODUCT', entityId: product.id, businessId: business.id, branchId: branch.id,
      after: { batchId, quantity, price, receivedOn },
    });
    ctx.json({
      ok: true, id: batchId,
      message: `${quantity.toLocaleString('en-NG')} ${product.base_unit_name || ''} of ${product.name} gotten on ${receivedOn} at ₦${price.toLocaleString('en-NG')} each. ${paidNowFlag ? 'Paid on delivery, on the same books as any other goods receipt.' : `₦${gross.toLocaleString('en-NG')} is still owed to ${supplierName}.`}`.replace(/\s+/g, ' '),
    }, 201);
  }));

  /**
   * Flour, film or chemical used to produce. Not a recipe. The oldest
   * active batch goes first. One stock-adjust call cannot cross batches,
   * so this walks them. The write-off uses the existing type OTHER.
   */
  app.post(`${base}/plant/inputs/:id/use`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager records production stock that has been used. A cashier can see what is left, not take it off the books.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [String(ctx.req.param('id'))]);
    if (!product || String(product.business_id) !== String(business.id) || product.stock_role !== 'INPUT') {
      throw new HttpError('That is not production stock on this plant.', { status: 404, code: 'INPUT_NOT_FOUND' });
    }
    const body = await ctx.req.json();
    const quantity = numField(body.quantity, { field: 'Amount used', min: 0.0001, places: 4 });
    const why = strField(body.reason, { field: 'What it was used for', maxLength: 300, required: true });
    if (!why || why.length < 4) throw new HttpError('Say what it was used for. A morning bake, a sachet run, a filter change.', { status: 400, code: 'REASON_REQUIRED' });
    const batches = await db.all(`SELECT id, quantity, quantity_reserved, cost_price_per_unit
        FROM stock_batches
        WHERE product_id = ? AND branch_id = ? AND is_deleted = 0 AND status = 'ACTIVE' AND quantity - quantity_reserved > 0
        ORDER BY received_at, id`, [String(product.id), String(branch.id)]);
    let left = quantity;
    const takes = [];
    for (const batch of batches) {
      const free = Number(batch.quantity) - Number(batch.quantity_reserved);
      if (!(free > 0) || !(left > 0)) continue;
      const take = Math.min(free, left);
      takes.push({ id: String(batch.id), take, cost: Number(batch.cost_price_per_unit) || 0 });
      left -= take;
      if (left < 0.00005) left = 0;
      if (left <= 0) break;
    }
    if (left > 0) {
      const held = roundTo(quantity - left, 4);
      throw new HttpError(`${branch.name} has ${held.toLocaleString('en-NG')} ${product.base_unit_name || ''} of ${product.name} that can be used. ${quantity.toLocaleString('en-NG')} is more than that.`, { status: 409, code: 'INSUFFICIENT_STOCK' });
    }
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const reason = `Used in production: ${why}`;
    const ids = [];
    await db.transaction(async (tx) => {
      for (const take of takes) {
        const id = newId();
        ids.push(id);
        const value = round2(take.take * take.cost);
        tx.queue(`UPDATE stock_batches SET quantity = quantity - ?, updated_at = datetime('now')
            WHERE id = ? AND is_deleted = 0 AND quantity - quantity_reserved >= ?`, [take.take, take.id, take.take]);
        tx.queue("UPDATE stock_batches SET status = CASE WHEN quantity <= 0 THEN 'DEPLETED' ELSE status END, updated_at = datetime('now') WHERE id = ?", [take.id]);
        tx.queue(`INSERT INTO stock_adjustments (
            id, branch_id, business_id, batch_id, product_id, adjustment_type, quantity, unit_cost, total_value, reason, requires_approval, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?, 'OTHER', ?,?,?,?, 0, ?, datetime('now'), datetime('now'))`, [
          id, String(branch.id), String(business.id), take.id, String(product.id),
          -take.take, take.cost, -value, reason, String(user.id),
        ]);
        for (const st of glService.postAdjustmentStatements({
          adjustment: { id, adjustment_type: 'OTHER', quantity: -take.take, total_value: -value, reason },
          business: { id: business.id }, branch: { id: branch.id }, accountIds, user,
        })) tx.queue(st.sql, st.params);
      }
    });
    await recordFromCtx(ctx, {
      action: 'PLANT_INPUT_USED', entityType: 'PRODUCT', entityId: product.id, businessId: business.id, branchId: branch.id,
      after: { quantity, reason, adjustments: ids },
    });
    ctx.json({
      ok: true,
      message: `${quantity.toLocaleString('en-NG')} ${product.base_unit_name || ''} of ${product.name} taken for production at ${branch.name}. The oldest stock went first. It is the same stock book, not a recipe.`,
    });
  }));

  app.post(`${base}/plant/inputs/:id/reorder`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager sets the low-stock line. A cashier can see it, not move it.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const business = await loadBusiness(db, ctx);
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [String(ctx.req.param('id'))]);
    if (!product || String(product.business_id) !== String(business.id) || product.stock_role !== 'INPUT') {
      throw new HttpError('That is not production stock on this plant.', { status: 404, code: 'INPUT_NOT_FOUND' });
    }
    const body = await ctx.req.json();
    const level = numField(body.reorder_level != null ? body.reorder_level : body.reorder, { field: 'Low-stock line', min: 0, places: 4 });
    await db.run("UPDATE products SET reorder_level = ?, updated_at = datetime('now') WHERE id = ? AND business_id = ?", [
      level, String(product.id), String(business.id),
    ]);
    await recordFromCtx(ctx, {
      action: 'PLANT_INPUT_REORDER', entityType: 'PRODUCT', entityId: product.id, businessId: business.id,
      before: { reorder_level: product.reorder_level }, after: { reorder_level: level },
    });
    ctx.json({
      ok: true,
      message: level > 0
        ? `${product.name} is low when this branch has ${level.toLocaleString('en-NG')} ${product.base_unit_name || ''} or less.`
        : `${product.name} no longer has a low-stock line.`,
    });
  }));

  app.post(`${base}/plant/assets/:id/correct`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A manager corrects a machine or tool record. The price and the date are facts, so a cashier cannot rewrite them.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const business = await loadBusiness(db, ctx);
    const asset = await loadAsset(db, ctx.req.param('id'), business.id);
    const body = await ctx.req.json();
    const sets = [];
    const params = [];
    if (body.name != null) {
      const name = strField(body.name, { field: 'Name', maxLength: 160, required: true });
      if (!name || name.length < 2) throw new HttpError('Name the machine or the tool.', { status: 400, code: 'NAME_REQUIRED' });
      sets.push('name = ?');
      params.push(name);
    }
    if (body.acquired_at != null || body.acquiredAt != null) {
      const acquiredAt = dateField(body.acquired_at || body.acquiredAt, 'Date gotten');
      if (asset.stopped_at && acquiredAt > String(asset.stopped_at)) {
        throw new HttpError('The day it was gotten cannot be after the day it stopped.', { status: 400, code: 'INVALID_DATE' });
      }
      sets.push('acquired_at = ?');
      params.push(acquiredAt);
    }
    if (body.purchase_price != null || body.price != null) {
      const price = numField(body.purchase_price != null ? body.purchase_price : body.price, { field: 'Price', min: 0 });
      sets.push('purchase_price = ?');
      params.push(price);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'supplier_name')) {
      sets.push('supplier_name = ?');
      params.push(strField(body.supplier_name, { field: 'Where it was gotten', maxLength: 160 }));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'serial_no')) {
      sets.push('serial_no = ?');
      params.push(strField(body.serial_no, { field: 'Serial number', maxLength: 80 }));
    }
    if (body.kind != null) {
      const kind = String(body.kind).toUpperCase();
      if (!['MACHINE', 'TOOL'].includes(kind)) throw new HttpError('Say whether this is a machine or a tool.', { status: 400, code: 'ASSET_KIND' });
      sets.push('kind = ?');
      params.push(kind);
    }
    if (!sets.length) throw new HttpError('Nothing to correct.', { status: 400, code: 'NO_CHANGES' });
    const note = '\n[' + watNow() + '] Record corrected by ' + (user.full_name || user.username) + '. The purchase price is the register fact. It is not posted again.';
    sets.push("notes = COALESCE(notes, '') || ?");
    sets.push("updated_at = datetime('now')");
    params.push(note, String(asset.id));
    await db.run('UPDATE plant_assets SET ' + sets.join(', ') + ' WHERE id = ?', params);
    await recordFromCtx(ctx, {
      action: 'PLANT_ASSET_CORRECTED', entityType: 'PLANT_ASSET', entityId: asset.id, businessId: business.id,
      before: { name: asset.name, acquired_at: asset.acquired_at, purchase_price: asset.purchase_price },
      after: body,
    });
    const kept = body.name || asset.name;
    ctx.json({ ok: true, message: kept + ' is corrected. Changing the price here does not move money a second time.' });
  }));

  app.post(`${base}/plant/assets/:id/report`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const business = await loadBusiness(db, ctx);
    const asset = await loadAsset(db, ctx.req.param('id'), business.id);
    const body = await ctx.req.json();
    const reason = strField(body.reason, { field: 'What is wrong', maxLength: 300, required: true });
    if (!reason || reason.length < 4) throw new HttpError('Say what is wrong. A manager then records the stop and any repair.', { status: 400, code: 'REASON_REQUIRED' });
    const note = '\n[' + watNow() + '] Reported by ' + (user.full_name || user.username) + ' (' + user.role + '): ' + reason;
    await db.run("UPDATE plant_assets SET notes = COALESCE(notes, '') || ?, updated_at = datetime('now') WHERE id = ?", [note, String(asset.id)]);
    await recordFromCtx(ctx, {
      action: 'PLANT_ASSET_REPORTED', entityType: 'PLANT_ASSET', entityId: asset.id, businessId: business.id,
      after: { reason, by: user.id },
    });
    ctx.json({
      ok: true,
      message: atLeast(user.role, 'MANAGER')
        ? 'Noted on ' + asset.name + '. Record Stopped working if it is actually out, and Maintenance if money was spent.'
        : 'Noted on ' + asset.name + '. A manager records the stop and any money spent. This report does not take it off the register by itself.',
    });
  }));
}

module.exports = { mount, ensureFleet };
