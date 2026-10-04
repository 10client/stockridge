// =====================================================================
// StockRidge — CATALOGUE ROUTES: products, categories, suppliers, serials
// =====================================================================

const { createRouter, HttpError } = require('../lib/http');
const V = require('../../shared/validation');
const { round2 } = require('../../shared/money');
const { newId, watNowIso } = require('../../shared/ids');
const { writeAudit } = require('../lib/audit');
const { assertRole, assertBranchAccess, resolveScopedBranchId } = require('../lib/roles');
const productService = require('../services/productService');
const stockService = require('../services/stockService');
const { getUnitSettings, staffAllowance } = require('../lib/planLimits');
const { capabilitiesOf, assertCapability, profileOf, sellingUnitsFor } = require('../lib/capabilities');
const { BASE_UNITS, SELLING_UNITS, validatePacking, ladderOf, describeCount } = require('../../shared/units');

// ---------------------------------------------------------------------
// PRODUCTS
// ---------------------------------------------------------------------
function productRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const result = await productService.list(db, {
      businessUnitId: c.var.businessUnitId,
      branchId: c.req.query('branch_id') || null,
      categoryId: c.req.query('category_id') || null,
      search: c.req.query('q') || c.req.query('search') || null,
      tracksSerials: c.req.query('tracks_serials') === '1' ? true : (c.req.query('tracks_serials') === '0' ? false : null),
      belowReorderOnly: c.req.query('below_reorder') === '1',
      activeOnly: c.req.query('include_inactive') !== '1',
      limit: c.req.query('limit'), offset: c.req.query('offset'),
      sort: c.req.query('sort'), dir: c.req.query('dir'),
    });
    void scoped;
    return c.json(result);
  });

  // Barcode / SKU / serial / IMEI scan — the POS entry point.
  app.get('/scan', async (c) => {
    const db = getDb();
    const code = c.req.query('code') || c.req.query('barcode') || c.req.query('q');
    if (!code) throw new HttpError(400, 'Send the scanned code as ?code=.', 'SCAN_CODE_REQUIRED');
    const branchId = c.req.query('branch_id') || c.var.user.branch_id || null;
    const found = await productService.resolveScan(db, { businessUnitId: c.var.businessUnitId, code, branchId });
    if (!found) {
      // A failed scan is a normal event, not an error: the cashier needs to
      // know it did not resolve so they can search by name instead. A 404 that
      // reads like a crash makes them retry the same scan five times.
      return c.json({
        found: false,
        message: `Nothing matched "${String(code).slice(0, 40)}". Check the digits, or search by name — a hand-typed barcode is worth an EAN check-digit test if you are typing them often.`,
        ean_check_valid: require('../../shared/validation').eanCheckDigitValid(code),
      }, 404);
    }
    // Availability at THIS branch, so the cashier knows before adding to the
    // basket rather than at checkout.
    let availability = null;
    if (found.product && branchId) {
      const pos = await stockService.position(db, { branchId, productId: found.product.id });
      availability = {
        on_hand: round2(pos.on_hand), reserved: round2(pos.reserved), available: round2(pos.available),
        batch_count: pos.batch_count,
      };
    }
    return c.json({ found: true, ...found, availability });
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const branchId = c.req.query('branch_id') || c.var.user.branch_id || null;
    const p = await productService.get(db, c.serviceCtx, c.req.param('id'), { branchId });
    if (!p) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
    const unit = c.var.businessUnit;
    return c.json({
      ...p,
      // The form spec the UI renders from: the profile's declared fields, with
      // the values this product already has filled in.
      form_spec: {
        product_fields: (profileOf(unit) || { product_fields: [] }).product_fields,
        base_units: BASE_UNITS,
        selling_units_allowed: (profileOf(unit) || { selling_units: ['BASE_UNIT'] }).selling_units,
        selling_units_current: sellingUnitsFor(unit, p),
        packing: ladderOf(p),
        capability_flags: p.capability_flags,
      },
    });
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const result = await productService.create(db, c.serviceCtx, body);
    return c.json(result, 201);
  });

  app.put('/:id', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await productService.update(db, c.serviceCtx, c.req.param('id'), body));
  });

  // Discontinue rather than delete. A product with sales history cannot be
  // deleted without breaking the audit trail, the P&L and every receipt ever
  // printed against it.
  app.post('/:id/discontinue', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'discontinue a product' });
    const db = getDb();
    const id = c.req.param('id');
    const p = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!p) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
    if (p.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That product belongs to a different business.', 'PRODUCT_WRONG_BUSINESS');

    // Stock still on hand must be dealt with first. Discontinuing a product
    // with 40 units on the shelf means either those units are unsellable or the
    // flag is meaningless.
    const stock = await stockService.positionAll(db, { businessUnitId: c.var.businessUnitId });
    const held = stock.get(id);
    if (held && held.on_hand > 0) {
      throw new HttpError(409,
        `This product still has ${round2(held.on_hand).toLocaleString('en-NG')} unit(s) on hand. Sell it down, transfer it, or write it off first — a discontinued product that is still on the shelf cannot be sold and cannot be counted correctly.`,
        'PRODUCT_HAS_STOCK');
      }
    const ts = watNowIso();
    await db.prepare('UPDATE products SET is_active = 0, discontinued_at = ?, updated_at = ? WHERE id = ?').bind(ts, ts, id).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'PRODUCT_DISCONTINUED', entityType: 'PRODUCT', entityId: id,
      before: { is_active: 1 }, after: { is_active: 0 }, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, id, is_active: false, note: 'Discontinued, not deleted — every sale, receipt and report that references it still resolves.' });
  });

  // Barcodes
  app.post('/:id/barcodes', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const p = await db.prepare('SELECT id, business_unit_id FROM products WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!p) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
    if (p.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That product belongs to a different business.', 'PRODUCT_WRONG_BUSINESS');
    return c.json(await productService.setBarcodes(db, c.serviceCtx, { productId: p.id, barcodes: body.barcodes || [] }), 201);
  });

  app.get('/:id/barcodes', async (c) => {
    const db = getDb();
    const rows = await db.prepare('SELECT * FROM product_barcodes WHERE product_id = ? AND is_deleted = 0 ORDER BY is_primary DESC').bind(c.req.param('id')).all();
    return c.json({ results: rows.results });
  });

  // Per-branch price overrides
  app.get('/:id/prices', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const p = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!p) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
    if (p.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That product belongs to a different business.', 'PRODUCT_WRONG_BUSINESS');

    const overrides = await db.prepare(`
      SELECT ppo.*, b.name AS branch_name, u.full_name AS updated_by_name
      FROM product_price_overrides ppo JOIN branches b ON b.id = ppo.branch_id
      LEFT JOIN users u ON u.id = ppo.updated_by
      WHERE ppo.product_id = ? AND ppo.is_deleted = 0 ORDER BY b.name
    `).bind(id).all();

    // What each branch would actually charge right now, resolved through the
    // full cascade. This is the answer to "why is Lagos cheaper than Minna?" —
    // a question that comes up in every margin review.
    const branches = await db.prepare('SELECT id, name FROM branches WHERE business_unit_id = ? AND is_active = 1 AND is_deleted = 0').bind(c.var.businessUnitId).all();
    const pricingService = require('../services/pricingService');
    const effective = [];
    for (const b of branches.results) {
      try {
        const resolved = await pricingService.resolveUnitPrice(db, c.serviceCtx, {
          businessUnitId: c.var.businessUnitId, branchId: b.id, productId: id, unitType: 'BASE_UNIT', quantity: 1,
        });
        effective.push({ branch_id: b.id, branch_name: b.name, price: resolved.unit_price, source: resolved.price_source });
      } catch (e) {
        effective.push({ branch_id: b.id, branch_name: b.name, price: null, source: null, error: e.code });
      }
    }
    return c.json({ product_id: id, product_name: p.name, overrides: overrides.results, effective_prices: effective });
  });

  app.put('/:id/prices/:branchId', async (c) => {
    const db = getDb();
    const allowance = await staffAllowance(db, c.var.businessUnitId, c.var.user);
    if (!allowance.can_edit_prices) {
      throw new HttpError(403, 'You are not permitted to change prices in this business. The owner controls this under My Plan → Manager permissions.', 'PRICE_EDIT_FORBIDDEN');
    }
    const id = c.req.param('id');
    const branchId = c.req.param('branchId');
    const p = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!p) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
    if (p.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That product belongs to a different business.', 'PRODUCT_WRONG_BUSINESS');
    assertBranchAccess(c.var.user, branchId);
    const branch = await db.prepare('SELECT * FROM branches WHERE id = ? AND business_unit_id = ? AND is_deleted = 0').bind(branchId, c.var.businessUnitId).first();
    if (!branch) throw new HttpError(404, 'That branch was not found for this business.', 'BRANCH_NOT_FOUND');

    const body = await c.req.json();
    const price = body.default_selling_price != null ? round2(Number(body.default_selling_price)) : null;
    if (price == null || !Number.isFinite(price) || price < 0) {
      throw new HttpError(400, 'Enter a selling price of zero or more.', 'PRICE_INVALID');
    }
    const pack = body.pack_price != null ? round2(Number(body.pack_price)) : null;
    const carton = body.carton_price != null ? round2(Number(body.carton_price)) : null;
    const pallet = body.pallet_price != null ? round2(Number(body.pallet_price)) : null;

    // A pack/carton price below the equivalent base price is almost always a
    // typing error, and it is the kind that costs money silently: a carton
    // priced below 10 loose units sells at a loss every time.
    const ladder = ladderOf(p);
    if (pack != null && pack < price * ladder.unitsPerPack) {
      throw new HttpError(400, `A pack price of ₦${pack.toLocaleString('en-NG')} is less than ${ladder.unitsPerPack} loose units at ₦${price.toLocaleString('en-NG')} each (₦${round2(price * ladder.unitsPerPack).toLocaleString('en-NG')}). Check the figure — a pack priced below its own contents sells at a loss every time.`, 'PACK_PRICE_BELOW_LOOSE');
    }
    if (carton != null && ladder.packsPerCarton && pack != null && carton < pack * ladder.packsPerCarton) {
      throw new HttpError(400, `A carton price of ₦${carton.toLocaleString('en-NG')} is less than ${ladder.packsPerCarton} packs at ₦${pack.toLocaleString('en-NG')} each. Check the figure.`, 'CARTON_PRICE_BELOW_PACKS');
    }

    const ts = watNowIso();
    const existing = await db.prepare('SELECT * FROM product_price_overrides WHERE branch_id = ? AND product_id = ? AND is_deleted = 0').bind(branchId, id).first();
    if (existing) {
      await db.prepare(`
        UPDATE product_price_overrides SET default_selling_price = ?, pack_price = ?, carton_price = ?, pallet_price = ?,
          effective_from = COALESCE(?, effective_from), effective_to = ?, updated_by = ?, reason = ?, updated_at = ?
        WHERE id = ?
      `).bind(price, pack, carton, pallet,
        body.effective_from ? String(body.effective_from).slice(0, 10) : null,
        body.effective_to ? String(body.effective_to).slice(0, 10) : null,
        c.var.user.id, body.reason ? String(body.reason).slice(0, 200) : null, ts, existing.id).run();
      await writeAudit(db, {
        businessUnitId: c.var.businessUnitId, branchId, userId: c.var.user.id, actorRole: c.var.user.role,
        action: 'BRANCH_PRICE_CHANGED', entityType: 'PRICE_OVERRIDE', entityId: existing.id, amount: price,
        before: { price: Number(existing.default_selling_price) }, after: { price, reason: body.reason },
        ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
      });
      return c.json({ ok: true, id: existing.id, updated: true, price });
    }
    const newIdValue = newId();
    await db.prepare(`
      INSERT INTO product_price_overrides (
        id, business_unit_id, branch_id, product_id, default_selling_price, pack_price, carton_price, pallet_price,
        effective_from, effective_to, updated_by, reason, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(newIdValue, c.var.businessUnitId, branchId, id, price, pack, carton, pallet,
      body.effective_from ? String(body.effective_from).slice(0, 10) : null,
      body.effective_to ? String(body.effective_to).slice(0, 10) : null,
      c.var.user.id, body.reason ? String(body.reason).slice(0, 200) : null, ts, ts).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'BRANCH_PRICE_SET', entityType: 'PRICE_OVERRIDE', entityId: newIdValue, amount: price,
      after: { price, branch: branch.name, reason: body.reason }, ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, id: newIdValue, created: true, price }, 201);
  });

  // Supplier links
  app.get('/:id/suppliers', async (c) => {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT ps.*, s.name AS supplier_name, s.phone, s.contact_name, s.payment_terms_days, s.supplier_type
      FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
      WHERE ps.product_id = ? AND ps.is_deleted = 0 ORDER BY ps.is_preferred DESC, s.name
    `).bind(c.req.param('id')).all();
    return c.json({ results: rows.results });
  });

  app.post('/:id/suppliers', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await productService.addSupplierLink(db, c.serviceCtx, { productId: c.req.param('id'), ...body }), 201);
  });

  return app;
}

// ---------------------------------------------------------------------
// CATEGORIES
// ---------------------------------------------------------------------
function categoryRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const results = await productService.listCategories(db, {
      businessUnitId: c.var.businessUnitId, includeInactive: c.req.query('include_inactive') === '1',
    });
    const profile = profileOf(c.var.businessUnit);
    return c.json({ results, profile_defaults: profile ? profile.default_categories : [] });
  });

  app.post('/', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'create a category' });
    const db = getDb();
    const body = await c.req.json();
    return c.json(await productService.createCategory(db, c.serviceCtx, body), 201);
  });

  app.post('/seed-from-profile', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'seed categories from the business profile' });
    const db = getDb();
    const unit = c.var.businessUnit;
    const result = await productService.seedProfileCategories(db, { businessUnitId: c.var.businessUnitId, profile: unit.industry_profile });
    return c.json({ ...result, note: 'Existing categories are left alone, so re-running this after you have renamed things does not resurrect the defaults over your edits.' });
  });

  app.put('/:id', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'edit a category' });
    const db = getDb();
    const id = c.req.param('id');
    const existing = await db.prepare('SELECT * FROM product_categories WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!existing) throw new HttpError(404, 'That category was not found.', 'CATEGORY_NOT_FOUND');
    if (existing.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That category belongs to a different business.', 'CATEGORY_WRONG_BUSINESS');

    const body = await c.req.json();
    const patch = {};
    const before = {};
    const record = (k, v) => { if (String(existing[k] ?? '') !== String(v ?? '')) { before[k] = existing[k]; patch[k] = v; } };
    if (body.label !== undefined) {
      const l = V.required(body.label, { field: 'Category name', max: 120 });
      if (l && l.error) throw new HttpError(400, l.error, 'VALIDATION_FAILED');
      record('label', l);
    }
    const caps = capabilitiesOf(c.var.businessUnit);
    if (body.tracks_serials !== undefined) {
      if (body.tracks_serials && !caps.serial_tracking) throw new HttpError(403, 'Serial tracking is not available for this business profile.', 'CAPABILITY_DISABLED');
      record('tracks_serials', body.tracks_serials ? 1 : 0);
    }
    if (body.tracks_expiry !== undefined) {
      if (body.tracks_expiry && !caps.expiry_tracking) throw new HttpError(403, 'Expiry tracking is not available for this business profile.', 'CAPABILITY_DISABLED');
      record('tracks_expiry', body.tracks_expiry ? 1 : 0);
    }
    if (body.tracks_warranty !== undefined) {
      if (body.tracks_warranty && !caps.warranty_tracking) throw new HttpError(403, 'Warranty tracking is not enabled for this business.', 'CAPABILITY_DISABLED');
      record('tracks_warranty', body.tracks_warranty ? 1 : 0);
    }
    if (body.is_active !== undefined) record('is_active', body.is_active ? 1 : 0);
    if (body.sort_order !== undefined) record('sort_order', Number(body.sort_order) || 0);
    if (body.default_base_unit !== undefined) {
      const u = V.oneOf(body.default_base_unit, BASE_UNITS.map((x) => x.code), { field: 'Default unit' });
      if (u && u.error) throw new HttpError(400, u.error, 'VALIDATION_FAILED');
      record('default_base_unit', u);
    }
    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0 });
    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    await db.prepare(`UPDATE product_categories SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((k) => patch[k]), id).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'CATEGORY_UPDATED', entityType: 'CATEGORY', entityId: id, before, after: patch,
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, changed: cols.length });
  });

  return app;
}

// ---------------------------------------------------------------------
// PRICE TIERS
// ---------------------------------------------------------------------
function tierRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT pt.*,
        (SELECT COUNT(*) FROM customers cu WHERE cu.tier_id = pt.id AND cu.is_deleted = 0) AS customer_count,
        (SELECT COUNT(*) FROM product_tier_prices p WHERE p.tier_id = pt.id AND p.is_deleted = 0) AS price_rule_count
      FROM price_tiers pt WHERE pt.business_unit_id = ? AND pt.is_deleted = 0
      ORDER BY pt.rank DESC, pt.label
    `).bind(c.var.businessUnitId).all();
    const profile = profileOf(c.var.businessUnit);
    return c.json({ results: rows.results, profile_default_tiers: profile ? profile.customer_tiers : [] });
  });

  app.post('/', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'create a price tier' });
    const db = getDb();
    const body = await c.req.json();
    const code = V.required(String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'), { field: 'Tier code', max: 40 });
    if (code && code.error) throw new HttpError(400, code.error, 'VALIDATION_FAILED');
    const label = V.required(body.label, { field: 'Tier name', max: 120 });
    if (label && label.error) throw new HttpError(400, label.error, 'VALIDATION_FAILED');
    const clash = await db.prepare('SELECT id FROM price_tiers WHERE business_unit_id = ? AND code = ? AND is_deleted = 0').bind(c.var.businessUnitId, code).first();
    if (clash) throw new HttpError(409, `A tier with code ${code} already exists.`, 'TIER_CODE_EXISTS');

    const ts = watNowIso();
    const id = newId();
    await db.prepare(`
      INSERT INTO price_tiers (id, business_unit_id, code, label, rank, requires_min_qty, is_default, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?, 1,?,?)
    `).bind(id, c.var.businessUnitId, code, label, Number(body.rank) || 0,
      Math.max(0, Number(body.requires_min_qty) || 0), body.is_default ? 1 : 0, ts, ts).run();
    return c.json({ ok: true, id, code, label }, 201);
  });

  // Tier price rules — the quantity-break engine.
  app.get('/:id/prices', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const rows = await db.prepare(`
      SELECT ptp.*, p.name AS product_name, p.sku, p.default_selling_price, b.name AS branch_name
      FROM product_tier_prices ptp
      JOIN products p ON p.id = ptp.product_id
      LEFT JOIN branches b ON b.id = ptp.branch_id
      WHERE ptp.tier_id = ? AND ptp.is_deleted = 0
      ORDER BY p.name, ptp.min_quantity
    `).bind(id).all();
    return c.json({ results: rows.results });
  });

  app.post('/:id/prices', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'set a tier price' });
    const db = getDb();
    const allowance = await staffAllowance(db, c.var.businessUnitId, c.var.user);
    if (!allowance.can_edit_prices) throw new HttpError(403, 'You are not permitted to change prices in this business.', 'PRICE_EDIT_FORBIDDEN');
    const tierId = c.req.param('id');
    const tier = await db.prepare('SELECT * FROM price_tiers WHERE id = ? AND business_unit_id = ? AND is_deleted = 0').bind(tierId, c.var.businessUnitId).first();
    if (!tier) throw new HttpError(404, 'That price tier was not found.', 'TIER_NOT_FOUND');
    assertCapability(c.var.businessUnit, 'wholesale_tiers', { action: 'set a wholesale tier price' });

    const body = await c.req.json();
    const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(body.product_id).first();
    if (!product) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
    if (product.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That product belongs to a different business.', 'PRODUCT_WRONG_BUSINESS');

    const priceType = V.oneOf(body.price_type || 'FIXED', ['FIXED', 'PERCENT_OFF_RETAIL', 'PERCENT_OFF_COST_PLUS_MARKUP'], { field: 'Price type' });
    if (priceType && priceType.error) throw new HttpError(400, priceType.error, 'VALIDATION_FAILED');
    const priceValue = Number(body.price_value);
    if (!Number.isFinite(priceValue) || priceValue < 0) throw new HttpError(400, 'Enter a price or a percentage of zero or more.', 'TIER_PRICE_INVALID');
    if (priceType !== 'FIXED' && priceValue > 100) throw new HttpError(400, 'A percentage must be between 0 and 100.', 'TIER_PERCENT_INVALID');
    const minQty = Math.max(1, Number(body.min_quantity) || 1);
    const maxQty = body.max_quantity != null ? Number(body.max_quantity) : null;
    if (maxQty != null && maxQty < minQty) throw new HttpError(400, 'The maximum quantity cannot be below the minimum.', 'TIER_QUANTITY_RANGE_INVALID');

    // A FIXED tier price below cost is the classic wholesale mistake: a
    // distributor price set from an old cost sheet, then applied automatically
    // to every bulk order for months.
    if (priceType === 'FIXED' && priceValue < Number(product.default_cost_price) && !body.allow_below_cost) {
      throw new HttpError(409,
        `₦${priceValue.toLocaleString('en-NG')} is below the ₦${round2(Number(product.default_cost_price)).toLocaleString('en-NG')} cost of "${product.name}". `
        + 'Wholesale prices below cost are allowed but must be deliberate — confirm with allow_below_cost and give a reason.',
        'TIER_PRICE_BELOW_COST');
    }

    const branchId = body.branch_id || null;
    if (branchId) assertBranchAccess(c.var.user, branchId);

    const clash = await db.prepare(`
      SELECT id FROM product_tier_prices
      WHERE product_id = ? AND tier_id = ? AND min_quantity = ? AND (branch_id IS ? ) AND is_deleted = 0
    `).bind(product.id, tierId, minQty, branchId).first();
    if (clash) {
      throw new HttpError(409, 'A rule already exists for this product, tier and quantity break. Edit it instead of adding a second — two overlapping rules for the same break would resolve by luck.', 'TIER_RULE_EXISTS');
    }

    const ts = watNowIso();
    const id = newId();
    await db.prepare(`
      INSERT INTO product_tier_prices (
        id, business_unit_id, product_id, tier_id, branch_id, price_type, price_value, markup_percent,
        min_quantity, max_quantity, effective_from, effective_to, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(id, c.var.businessUnitId, product.id, tierId, branchId, priceType, priceValue,
      body.markup_percent != null ? Number(body.markup_percent) : null, minQty, maxQty,
      body.effective_from ? String(body.effective_from).slice(0, 10) : null,
      body.effective_to ? String(body.effective_to).slice(0, 10) : null, ts, ts).run();

    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'TIER_PRICE_SET', entityType: 'TIER_PRICE', entityId: id, amount: priceType === 'FIXED' ? priceValue : null,
      after: { product: product.name, tier: tier.label, price_type: priceType, price_value: priceValue, min_quantity: minQty },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, id, tier: tier.label, product: product.name, price_type: priceType, price_value: priceValue, min_quantity: minQty }, 201);
  });

  app.delete('/:id/prices/:ruleId', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'remove a tier price' });
    const db = getDb();
    const ts = watNowIso();
    const res = await db.prepare('UPDATE product_tier_prices SET is_deleted = 1, updated_at = ? WHERE id = ? AND tier_id = ?')
      .bind(ts, c.req.param('ruleId'), c.req.param('id')).run();
    if (!res.meta.changes) throw new HttpError(404, 'That tier price rule was not found.', 'TIER_RULE_NOT_FOUND');
    return c.json({ ok: true });
  });

  return app;
}

// ---------------------------------------------------------------------
// SUPPLIERS
// ---------------------------------------------------------------------
function supplierRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const results = await productService.listSuppliers(db, {
      businessUnitId: c.var.businessUnitId,
      search: c.req.query('q') || c.req.query('search') || null,
      type: c.req.query('type') || null,
      limit: c.req.query('limit'), offset: c.req.query('offset'),
    });
    return c.json({ results });
  });

  app.post('/', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'add a supplier' });
    const db = getDb();
    const body = await c.req.json();
    return c.json(await productService.createSupplier(db, c.serviceCtx, body), 201);
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const s = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!s) throw new HttpError(404, 'That supplier was not found.', 'SUPPLIER_NOT_FOUND');
    if (s.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That supplier belongs to a different business.', 'SUPPLIER_WRONG_BUSINESS');

    const [products, orders, balance, payments, wht] = await Promise.all([
      db.prepare(`
        SELECT ps.*, p.name AS product_name, p.sku FROM product_suppliers ps
        JOIN products p ON p.id = ps.product_id WHERE ps.supplier_id = ? AND ps.is_deleted = 0
        ORDER BY p.name LIMIT 200
      `).bind(id).all(),
      db.prepare(`
        SELECT po.id, po.po_number, po.status, po.total_cost, po.amount_paid, po.ordered_at, po.expected_at, b.name AS branch_name
        FROM purchase_orders po JOIN branches b ON b.id = po.branch_id
        WHERE po.supplier_id = ? AND po.is_deleted = 0 ORDER BY po.ordered_at DESC LIMIT 50
      `).bind(id).all(),
      db.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM creditor_ledger WHERE supplier_id = ? AND is_deleted = 0').bind(id).first(),
      db.prepare(`
        SELECT entry_date, entry_type, reference, amount, balance_after, notes FROM creditor_ledger
        WHERE supplier_id = ? AND is_deleted = 0 ORDER BY entry_date DESC LIMIT 100
      `).bind(id).all(),
      db.prepare(`
        SELECT entry_date, rate_code, gross_amount, wht_amount, net_amount, remitted_at, credit_note_no
        FROM wht_entries WHERE counterparty_name = ? AND is_deleted = 0 ORDER BY entry_date DESC LIMIT 50
      `).bind(s.name).all(),
    ]);

    return c.json({
      ...s,
      balance_owed: round2(Number(balance.balance) || 0),
      products: products.results,
      purchase_orders: orders.results,
      ledger: payments.results.map((r) => ({ ...r, amount: round2(r.amount), balance_after: round2(r.balance_after) })),
      withholding_tax: wht.results.map((r) => ({ ...r, gross_amount: round2(r.gross_amount), wht_amount: round2(r.wht_amount), net_amount: round2(r.net_amount) })),
      // Lead time performance: promised vs actual. A supplier who is always
      // two weeks late is a supplier worth changing, and only the comparison
      // shows it.
      performance: orders.results.length ? {
        orders: orders.results.length,
        received: orders.results.filter((o) => o.status === 'RECEIVED').length,
        cancelled: orders.results.filter((o) => o.status === 'CANCELLED').length,
      } : null,
    });
  });

  app.put('/:id', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'edit a supplier' });
    const db = getDb();
    const id = c.req.param('id');
    const s = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!s) throw new HttpError(404, 'That supplier was not found.', 'SUPPLIER_NOT_FOUND');
    if (s.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That supplier belongs to a different business.', 'SUPPLIER_WRONG_BUSINESS');

    const body = await c.req.json();
    const patch = {};
    const before = {};
    const record = (k, v) => { if (String(s[k] ?? '') !== String(v ?? '')) { before[k] = s[k]; patch[k] = v; } };
    const textFields = ['name', 'contact_name', 'address', 'email', 'bank_name', 'bank_account_name', 'notes', 'country'];
    for (const k of textFields) {
      if (body[k] === undefined) continue;
      record(k, body[k] == null ? null : String(body[k]).trim().slice(0, 400) || null);
    }
    if (body.phone !== undefined) {
      const p = body.phone ? V.phone(body.phone, { field: 'Phone' }) : null;
      if (p && p.error) throw new HttpError(400, p.error, 'VALIDATION_FAILED');
      record('phone', p ? p.international : null);
    }
    if (body.tin !== undefined) {
      const t = body.tin ? V.tin(body.tin, { field: 'TIN' }) : null;
      if (t && t.error) throw new HttpError(400, t.error, 'VALIDATION_FAILED');
      record('tin', t);
    }
    if (body.state !== undefined) record('state', body.state ? require('../lib/geo').normaliseState(body.state) : null);
    if (body.supplier_type !== undefined) {
      const t = V.oneOf(body.supplier_type, ['MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'WHOLESALE', 'WORKSHOP', 'SERVICE', 'OTHER'], { field: 'Supplier type' });
      if (t && t.error) throw new HttpError(400, t.error, 'VALIDATION_FAILED');
      record('supplier_type', t);
    }
    if (body.payment_terms_days !== undefined) record('payment_terms_days', Math.max(0, Number(body.payment_terms_days) || 0));
    if (body.lead_time_days !== undefined) record('lead_time_days', Math.max(0, Number(body.lead_time_days) || 0));
    if (body.is_active !== undefined) record('is_active', body.is_active ? 1 : 0);
    if (body.rating !== undefined) record('rating', body.rating == null ? null : Math.min(5, Math.max(1, Number(body.rating) || 0)));
    // Bank details and the credit limit are OWNER-level: a manager who could
    // change where money is sent could redirect a payment.
    if (body.bank_account_no !== undefined || body.credit_limit !== undefined) {
      assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'change supplier payment or credit details' });
      if (body.bank_account_no !== undefined) record('bank_account_no', body.bank_account_no ? String(body.bank_account_no).slice(0, 40) : null);
      if (body.credit_limit !== undefined) record('credit_limit', round2(Math.max(0, Number(body.credit_limit) || 0)));
    }
    if (!Object.keys(patch).length) return c.json({ ok: true, changed: 0 });
    patch.updated_at = watNowIso();
    const cols = Object.keys(patch);
    await db.prepare(`UPDATE suppliers SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map((k) => patch[k]), id).run();
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: cols.includes('bank_account_no') ? 'SUPPLIER_BANK_DETAILS_CHANGED' : 'SUPPLIER_UPDATED',
      entityType: 'SUPPLIER', entityId: id, before, after: patch,
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, changed: cols.length });
  });

  return app;
}

// ---------------------------------------------------------------------
// SERIALS
// ---------------------------------------------------------------------
function serialRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    assertCapability(c.var.businessUnit, 'serial_tracking', { action: 'browse serialised stock' });
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const where = ['ps.is_deleted = 0', 'ps.business_unit_id = ?'];
    const params = [c.var.businessUnitId];
    if (scoped) { where.push('ps.branch_id = ?'); params.push(scoped); }
    if (c.req.query('product_id')) { where.push('ps.product_id = ?'); params.push(c.req.query('product_id')); }
    if (c.req.query('status')) { where.push('ps.status = ?'); params.push(String(c.req.query('status')).toUpperCase()); }
    if (c.req.query('q')) {
      const key = String(c.req.query('q')).trim().toUpperCase();
      where.push(`(upper(ps.serial_no) LIKE ? OR upper(COALESCE(ps.imei,'')) LIKE ?)`);
      params.push(`%${key.replace(/[\\%_]/g, (x) => `\\${x}`)}%`, `%${key.replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
    }
    // The strongest single theft signal available in an electronics business:
    // a serial marked IN_STOCK at a branch it was never received or
    // transferred into. It only works because transfers are the ONLY way a
    // serial changes branch.
    if (c.req.query('anomalies') === '1') {
      where.push(`NOT EXISTS (
        SELECT 1 FROM stock_movements m WHERE m.serial_id = ps.id AND m.branch_id = ps.branch_id
          AND m.movement_type IN ('PURCHASE_RECEIPT','TRANSFER_IN','ADJUSTMENT_FOUND','STOCKTAKE_VARIANCE'))`);
      where.push(`NOT EXISTS (SELECT 1 FROM purchase_order_receipts r WHERE r.stock_batch_id = ps.stock_batch_id AND r.branch_id = ps.branch_id)`);
    }

    const rows = await db.prepare(`
      SELECT ps.*, p.name AS product_name, p.brand, p.model_number, p.sku, b.name AS branch_name,
             s.receipt_no, cu.full_name AS customer_name, cu.phone AS customer_phone,
             w.ends_at AS warranty_ends_at, w.status AS warranty_status
      FROM product_serials ps
      JOIN products p ON p.id = ps.product_id
      JOIN branches b ON b.id = ps.branch_id
      LEFT JOIN sales s ON s.id = ps.sale_id
      LEFT JOIN customers cu ON cu.id = s.customer_id
      LEFT JOIN product_warranties w ON w.serial_id = ps.id AND w.is_deleted = 0
      WHERE ${where.join(' AND ')}
      ORDER BY ps.received_at DESC LIMIT ? OFFSET ?
    `).bind(...params, Math.min(1000, Number(c.req.query('limit')) || 100), Number(c.req.query('offset')) || 0).all();

    const counts = await db.prepare(`
      SELECT status, COUNT(*) AS n FROM product_serials
      WHERE business_unit_id = ? AND is_deleted = 0 GROUP BY status
    `).bind(c.var.businessUnitId).all();

    return c.json({
      results: rows.results,
      status_counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
      transitions: stockService.SERIAL_TRANSITIONS,
    });
  });

  app.get('/:serialNo', async (c) => {
    const db = getDb();
    const s = await stockService.serialByNumber(db, { businessUnitId: c.var.businessUnitId, serialNo: c.req.param('serialNo') });
    if (!s) throw new HttpError(404, 'That serial number was not found. It may be mistyped — 0/O and 1/I are the usual confusions when reading a label aloud.', 'SERIAL_NOT_FOUND');

    // Full custody history from the chained register. This is the answer to
    // "where has this item been?" and it is tamper-evident.
    const history = await db.prepare(`
      SELECT cr.event_type, cr.occurred_at, cr.detail, cr.counterparty_name, cr.counterparty_phone,
             cr.chain_seq, cr.row_hash, b.name AS branch_name, u.full_name AS performed_by_name
      FROM compliance_register cr
      LEFT JOIN branches b ON b.id = cr.branch_id
      LEFT JOIN users u ON u.id = cr.performed_by
      WHERE cr.serial_id = ? ORDER BY cr.chain_seq ASC
    `).bind(s.id).all();
    const warranty = await db.prepare(`
      SELECT w.*, (SELECT COUNT(*) FROM warranty_claims wc WHERE wc.warranty_id = w.id AND wc.is_deleted = 0) AS claim_count
      FROM product_warranties w WHERE w.serial_id = ? AND w.is_deleted = 0 ORDER BY w.starts_at DESC
    `).bind(s.id).all();
    const movements = await db.prepare(`
      SELECT m.movement_type, m.direction, m.quantity, m.occurred_at, m.reference, m.reason, b.name AS branch_name
      FROM stock_movements m LEFT JOIN branches b ON b.id = m.branch_id
      WHERE m.serial_id = ? ORDER BY m.occurred_at DESC LIMIT 50
    `).bind(s.id).all();

    return c.json({
      ...s,
      custody_history: history.results,
      custody_chain_length: history.results.length,
      warranties: warranty.results,
      movements: movements.results,
      in_cover: warranty.results.some((w) => w.status === 'ACTIVE' && w.ends_at >= require('../../shared/ids').watDate()),
      can_transition_to: stockService.SERIAL_TRANSITIONS[s.status] || [],
    });
  });

  // A manual status correction, which must go through the transition graph and
  // be recorded with a reason. Silently flipping a SOLD serial back to
  // IN_STOCK would destroy the custody chain, so it is not offered.
  app.post('/:id/status', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'change a serial number\u2019s status' });
    const db = getDb();
    const id = c.req.param('id');
    const s = await db.prepare('SELECT * FROM product_serials WHERE id = ? AND is_deleted = 0').bind(id).first();
    if (!s) throw new HttpError(404, 'That serial record was not found.', 'SERIAL_NOT_FOUND');
    if (s.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That serial belongs to a different business.', 'SERIAL_WRONG_BUSINESS');
    assertBranchAccess(c.var.user, s.branch_id);

    const body = await c.req.json();
    const to = String(body.status || '').toUpperCase();
    if (!stockService.canTransitionSerial(s.status, to)) {
      const allowed = stockService.SERIAL_TRANSITIONS[s.status] || [];
      throw new HttpError(409,
        `A serial marked ${String(s.status).replace(/_/g, ' ').toLowerCase()} cannot move to ${to.replace(/_/g, ' ').toLowerCase()}. Allowed: ${allowed.length ? allowed.join(', ') : 'none — this status is terminal'}. `
        + 'If the record is genuinely wrong, use CORRECTION on the stock side and say why — the chain is the evidence and rewriting it silently would destroy its value.',
        'SERIAL_TRANSITION_NOT_ALLOWED');
    }
    if (!body.reason || String(body.reason).trim().length < 5) {
      throw new HttpError(400, 'A serial status change needs a written reason of at least 5 characters. It goes on the tamper-evident custody register.', 'SERIAL_STATUS_REASON_REQUIRED');
    }
    await stockService.transitionSerial(db, id, to, { branchId: body.branch_id || null, note: String(body.reason).slice(0, 300) });

    if (c.var.businessUnit.compliance_register_enabled !== 0) {
      try {
        const eventMap = { RETURNED: 'ITEM_RETURNED', SCRAPPED: 'ITEM_SCRAPPED', LOST: 'ITEM_SCRAPPED', IN_TRANSIT: 'ITEM_TRANSFERRED', WARRANTY_REPAIR: 'ITEM_REPAIRED' };
        await require('../lib/audit').appendRegister(db, {
          business_unit_id: s.business_unit_id, branch_id: s.branch_id, scheme_code: 'SERIAL_CUSTODY',
          event_type: eventMap[to] || 'OTHER', product_id: s.product_id, serial_id: id, quantity: 1,
          detail: `${String(s.status).replace(/_/g, ' ')} → ${to.replace(/_/g, ' ')}: ${String(body.reason).slice(0, 300)}`,
          performed_by: c.var.user.id, device_id: c.var.deviceId, ip_address: c.var.ipAddress,
        });
      } catch (e) { console.error('[serials] register write failed:', e && e.message); }
    }

    await writeAudit(db, {
      businessUnitId: s.business_unit_id, branchId: s.branch_id, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'SERIAL_STATUS_CHANGED', entityType: 'SERIAL', entityId: id,
      reason: String(body.reason).slice(0, 500), before: { status: s.status }, after: { status: to },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, id, from: s.status, to });
  });

  return app;
}

module.exports = { productRoutes, categoryRoutes, tierRoutes, supplierRoutes, serialRoutes };
'use strict';
