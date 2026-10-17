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
const { resolveBusiness, inScope, strField, numField, boolField } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watToday } = require('../../domain/time');
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

  /**
   * What a plant is holding: unpaid credit supplies, manufacturing stock,
   * and machinery service cost. Credit is the customer balance already on
   * the books. Inputs are products marked INPUT. Leather is not invented.
   */
  app.get(`${base}/plant`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await loadBusiness(db, ctx);
    const profile = profileOf(business);
    const inputs = await db.all(`SELECT p.id, p.name, p.sku, p.base_unit_name, p.cost_price, p.offers_sale,
          COALESCE(SUM(CASE WHEN b.is_deleted = 0 AND b.status = 'ACTIVE' THEN b.quantity ELSE 0 END), 0) AS on_hand,
          COALESCE(SUM(CASE WHEN b.is_deleted = 0 AND b.status = 'ACTIVE' THEN b.quantity * b.cost_price_per_unit ELSE 0 END), 0) AS stock_value
        FROM products p
        LEFT JOIN stock_batches b ON b.product_id = p.id
        WHERE p.business_id = ? AND p.is_deleted = 0 AND p.stock_role = 'INPUT'
        GROUP BY p.id
        ORDER BY p.name`, [String(business.id)]);
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
      inputs: inputs.map((row) => ({
        id: row.id,
        name: row.name,
        sku: row.sku,
        unit: row.base_unit_name,
        onHand: round2(Number(row.on_hand) || 0),
        value: round2(Number(row.stock_value) || 0),
        offersSale: Number(row.offers_sale) === 1,
      })),
      inputValue: round2(inputs.reduce((sum, row) => sum + (Number(row.stock_value) || 0), 0)),
      machinery: {
        days30: round2(Number(machinery30 && machinery30.total) || 0),
        count30: Number(machinery30 && machinery30.n) || 0,
        allTime: round2(Number(machineryAll && machineryAll.total) || 0),
        countAll: Number(machineryAll && machineryAll.n) || 0,
      },
      missing,
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
}

module.exports = { mount };
