'use strict';
// =====================================================================
// server/routes/catalog.js — PRODUCTS, CATEGORIES, UNITS, PRICE LISTS
// =====================================================================
// THE CATALOGUE IS PER-BUSINESS, NOT PER-BRANCH.
//
// That is a deliberate consequence of the multi-business model. The electronics
// shop and the furniture shop are different legal entities selling different
// things; a shared catalogue would let a cashier at the furniture showroom scan
// a phone they do not stock and sell it against the wrong business's books.
// Branches within one business DO share its catalogue, because they are the same
// trader in two places.
//
// Rows with `business_id IS NULL` are deployment-shared master data and are
// visible to everybody; that is why the scope filter treats NULL as in-scope
// rather than out of it.
//
// STOCK IS NEVER EDITED HERE. A product's `cost_price` is a weighted average
// maintained by goods receipts, and its quantity lives only in stock_batches.
// Letting a catalogue edit move stock would bypass the batch history that FIFO
// costing, expiry tracking and quarantine all depend on.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, scopeFilter, pagination, listResponse, requireField, valid, numField, strField, boolField } = require('../lib/respond');
const { validateLadder } = require('../../domain/uom');
const { LADDERS, MEASURE_AXES, PROFILE_CODES, getProfile, resolveProfile, describeProfile } = require('../../domain/verticals');
const { round2 } = require('../../domain/money');
const { barcode: barcodeRule, oneOf } = require('../../domain/validation');
const { newId } = require('../../domain/crypto');
const { canEditPrices } = require('../../domain/planLimits');
const { watToday } = require('../../domain/time');

/**
 * The catalogue columns a client may set.
 *
 * Anything not listed here is either computed (stock quantities, weighted
 * average cost) or owned by another route, and a mass-assignment of the request
 * body into an UPDATE would let a caller set them. Each cleaner THROWS on bad
 * input rather than returning a result object, so a field that fails validation
 * cannot silently store an object where a number belongs.
 */
const PRODUCT_FIELDS = {
  name: (v) => strField(v, { field: 'Product name', maxLength: 200, required: true }),
  sku: (v) => { const s = strField(v, { field: 'SKU', maxLength: 60 }); return s ? s.toUpperCase() : null; },
  brand: (v) => strField(v, { field: 'Brand', maxLength: 120 }),
  model_no: (v) => strField(v, { field: 'Model number', maxLength: 120 }),
  description: (v) => strField(v, { field: 'Description', maxLength: 2000 }),
  registration_no: (v) => strField(v, { field: 'Registration number', maxLength: 80 }),
  category_id: (v) => strField(v, { field: 'Category', maxLength: 64 }),
  base_unit_name: (v) => strField(v, { field: 'Base unit', maxLength: 40 }) || 'piece',
  warranty_months: (v) => numField(v, { field: 'Warranty months', min: 0, max: 360, whole: true }),
  warranty_type: (v) => (v == null || v === '' ? null : valid(oneOf(v, ['CARRY_IN', 'ONSITE', 'RETURN_TO_BASE'], { field: 'Warranty type' }), 'warranty_type')),
  cost_price: (v) => numField(v, { field: 'Cost price', min: 0 }),
  selling_price: (v) => numField(v, { field: 'Selling price', min: 0 }),
  reorder_level: (v) => numField(v, { field: 'Reorder level', min: 0, places: 4 }),
  reorder_quantity: (v) => numField(v, { field: 'Reorder quantity', min: 0, places: 4 }),
  min_margin_pct: (v) => (v == null || v === '' ? null : numField(v, { field: 'Minimum margin', min: 0, max: 100 })),
  weight_kg: (v) => (v == null || v === '' ? null : numField(v, { field: 'Weight', min: 0, places: 4 })),
  dimensions_cm: (v) => strField(v, { field: 'Dimensions', maxLength: 60 }),
  return_window_days: (v) => numField(v, { field: 'Return window', min: 0, max: 365, whole: true, fallback: 7 }),
  valuation_method: (v) => valid(oneOf(v, ['WEIGHTED_AVG', 'FIFO'], { field: 'Valuation method', required: false }), 'valuation_method') || 'WEIGHTED_AVG',
};
const PRODUCT_FLAGS = ['requires_serial', 'tracks_variants', 'is_bulky', 'requires_installation', 'has_expiry', 'is_age_restricted', 'is_fragile', 'is_returnable', 'is_active'];

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // PRODUCTS
  // -------------------------------------------------------------------
  app.get(`${base}/products`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const search = (ctx.req.queryParam('q') || '').trim();
    const businessId = ctx.req.queryParam('business_id');
    const categoryId = ctx.req.queryParam('category_id');
    const activeOnly = ctx.req.queryParam('active') !== '0';
    const lowStock = ctx.req.queryParam('low_stock') === '1';
    const branch = lowStock ? await resolveBranch(db, ctx) : null;

    const where = ['p.is_deleted = 0'];
    const params = [];
    if (businessId) { where.push('(p.business_id = ? OR p.business_id IS NULL)'); params.push(String(businessId)); }
    else if (scope.businessIds) { where.push('(p.business_id IS NULL OR p.business_id IN (' + [...scope.businessIds].map(() => '?').join(',') + '))'); params.push(...[...scope.businessIds]); }
    if (categoryId) { where.push('p.category_id = ?'); params.push(String(categoryId)); }
    if (activeOnly) where.push('p.is_active = 1');
    if (search) {
      where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ? OR p.model_no LIKE ? OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode LIKE ? AND pb.is_deleted = 0))');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }

    // On-hand stock is a correlated subquery rather than a join, because a join
    // over stock_batches would multiply product rows by batch count and then need
    // re-grouping; for a list screen the subquery is both simpler and faster.
    const stockExpr = branch
      ? `(SELECT COALESCE(SUM(sb.quantity - sb.quantity_reserved), 0) FROM stock_batches sb
          WHERE sb.product_id = p.id AND sb.branch_id = ? AND sb.is_deleted = 0
            AND sb.status NOT IN ('QUARANTINED','EXPIRED'))`
      : `(SELECT COALESCE(SUM(sb.quantity - sb.quantity_reserved), 0) FROM stock_batches sb
          WHERE sb.product_id = p.id AND sb.is_deleted = 0 AND sb.status NOT IN ('QUARANTINED','EXPIRED'))`;

    const rows = await db.all(`
      SELECT p.id, p.business_id, p.category_id, p.sku, p.name, p.brand, p.model_no,
             p.requires_serial, p.tracks_variants, p.warranty_months, p.warranty_type,
             p.is_bulky, p.requires_installation, p.has_expiry, p.is_fragile, p.is_returnable,
             p.base_unit_name, p.cost_price, p.selling_price, p.reorder_level, p.reorder_quantity,
             p.min_margin_pct, p.valuation_method, p.is_active, p.updated_at,
             c.name AS category_name, c.code AS category_code,
             ${stockExpr} AS on_hand
      FROM products p
      LEFT JOIN product_categories c ON c.id = p.category_id
      ${lowStock && branch ? '' : ''}
      WHERE ${where.join(' AND ')}
      ${lowStock ? 'AND COALESCE((' + stockExpr + '), 0) <= p.reorder_level' : ''}
      ORDER BY p.name ASC
      LIMIT ? OFFSET ?`,
    [...(branch ? [String(branch.id)] : []), ...params, ...(lowStock && branch ? [String(branch.id)] : []), limit, offset]);

    const total = await db.scalar(`SELECT COUNT(*) FROM products p WHERE ${where.join(' AND ')}`, params);
    ctx.json(listResponse(rows.map((r) => ({
      ...r,
      on_hand: round2(Number(r.on_hand) || 0),
      low_stock: Number(r.reorder_level) > 0 && Number(r.on_hand) <= Number(r.reorder_level),
      margin_pct: Number(r.selling_price) > 0 ? round2(((Number(r.selling_price) - Number(r.cost_price)) / Number(r.selling_price)) * 100) : null,
    })), { limit, offset }, total));
  });

  app.get(`${base}/products/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [id]);
    if (!product) throw new HttpError('That product does not exist, or has been deleted.', { status: 404, code: 'PRODUCT_NOT_FOUND' });

    const [units, variants, measures, barcodes, registrations, category, overrides, stockByBranch] = await Promise.all([
      db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [id]),
      db.all('SELECT * FROM product_variants WHERE product_id = ? AND is_deleted = 0 ORDER BY sort_order, name', [id]),
      db.all('SELECT * FROM product_measures WHERE product_id = ? AND is_deleted = 0', [id]),
      db.all('SELECT * FROM product_barcodes WHERE product_id = ? AND is_deleted = 0 ORDER BY is_primary DESC, barcode', [id]),
      db.all('SELECT * FROM product_registrations WHERE product_id = ? AND is_deleted = 0 ORDER BY authority, reg_type', [id]),
      db.first('SELECT * FROM product_categories WHERE id = ?', [product.category_id]),
      db.all('SELECT po.*, b.name AS branch_name FROM product_price_overrides po JOIN branches b ON b.id = po.branch_id WHERE po.product_id = ? AND po.is_deleted = 0', [id]),
      db.all(`SELECT b.id AS branch_id, b.name AS branch_name, b.code AS branch_code,
                     COALESCE(SUM(sb.quantity), 0) AS on_shelf,
                     COALESCE(SUM(sb.quantity_reserved), 0) AS reserved,
                     COALESCE(SUM(sb.quantity - sb.quantity_reserved), 0) AS available,
                     COALESCE(SUM(sb.quantity * sb.cost_price_per_unit), 0) AS stock_value
              FROM branches b
              LEFT JOIN stock_batches sb ON sb.branch_id = b.id AND sb.product_id = ? AND sb.is_deleted = 0
                   AND sb.status NOT IN ('QUARANTINED','EXPIRED')
              WHERE b.is_deleted = 0 AND b.is_active = 1
              GROUP BY b.id ORDER BY b.name`, [id]),
    ]);

    ctx.json({
      ok: true,
      product,
      category,
      units,
      variants,
      measures: measures[0] || null,
      barcodes,
      registrations,
      priceOverrides: overrides,
      stock: stockByBranch.map((s) => ({
        ...s,
        on_shelf: round2(Number(s.on_shelf)), reserved: round2(Number(s.reserved)),
        available: round2(Number(s.available)), stock_value: round2(Number(s.stock_value)),
      })),
    });
  });

  app.post(`${base}/products`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx, { required: false });
    const business = await resolveBusiness(db, ctx, branch || undefined);

    const fields = {};
    for (const [key, clean] of Object.entries(PRODUCT_FIELDS)) {
      if (body[key] !== undefined) fields[key] = clean(body[key]);
    }
    if (!fields.name) throw new HttpError('A product needs a name.', { status: 400, code: 'MISSING_FIELD', fields: { name: 'Required.' } });
    for (const flag of PRODUCT_FLAGS) if (body[flag] !== undefined) fields[flag] = boolField(body[flag]);

    // A selling price below cost is allowed but recorded: a clearance line is a
    // legitimate decision, a typo is not, and the audit trail is what tells them
    // apart three months later.
    const belowCost = fields.selling_price != null && fields.cost_price != null && Number(fields.selling_price) < Number(fields.cost_price);

    const id = newId();
    await db.run(`INSERT INTO products (
        id, business_id, category_id, sku, name, brand, model_no, description, registration_no,
        requires_serial, tracks_variants, warranty_months, warranty_type, is_bulky, requires_installation,
        has_expiry, is_age_restricted, is_fragile, is_returnable, return_window_days,
        base_unit_name, cost_price, selling_price, reorder_level, reorder_quantity, min_margin_pct,
        weight_kg, dimensions_cm, valuation_method, is_active, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?, datetime('now'), datetime('now'))`, [
      id, String(business.id), fields.category_id || null, fields.sku || null, fields.name,
      fields.brand || null, fields.model_no || null, fields.description || null, fields.registration_no || null,
      fields.requires_serial || 0, fields.tracks_variants || 0, fields.warranty_months || 0, fields.warranty_type || null,
      fields.is_bulky || 0, fields.requires_installation || 0, fields.has_expiry || 0, fields.is_age_restricted || 0,
      fields.is_fragile || 0, fields.is_returnable === undefined ? 1 : fields.is_returnable, fields.return_window_days || 7,
      fields.base_unit_name || 'piece', round2(Number(fields.cost_price) || 0), round2(Number(fields.selling_price) || 0),
      Number(fields.reorder_level) || 0, Number(fields.reorder_quantity) || 0,
      fields.min_margin_pct == null ? null : Number(fields.min_margin_pct),
      fields.weight_kg == null ? null : Number(fields.weight_kg), fields.dimensions_cm || null,
      fields.valuation_method || 'WEIGHTED_AVG', String(user.id),
    ]);

    // Every product gets a base unit, or it cannot be sold: the sale engine
    // refuses a product with no ladder rather than guessing one.
    const ladder = Array.isArray(body.units) && body.units.length ? body.units : [{ code: 'PIECE', name: fields.base_unit_name || 'Piece', quantityInBase: 1, isDefaultSell: true }];
    const check = validateLadder(ladder);
    if (!check.ok) {
      // Roll the product back rather than leave a row that cannot be sold.
      await db.run('UPDATE products SET is_deleted = 1 WHERE id = ?', [id]);
      throw new HttpError(check.error, { status: 400, code: check.code, fields: { units: check.error } });
    }
    for (const level of check.ladder) {
      await db.run(`INSERT INTO product_units (id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
      [newId(), id, level.level, level.code, level.name, level.pluralName, level.quantityInBase, level.isSellable ? 1 : 0, level.isDefaultSell ? 1 : 0]);
    }

    if (body.barcode) {
      const bc = barcodeRule(String(body.barcode));
      // A rejected barcode is reported but does not fail the product: the item is
      // already in the catalogue and usable by name or SKU, and refusing the
      // whole create because a check digit was mistyped would send the merchant
      // back to a paper label.
      if (!bc.ok) ctx.set('barcodeWarning', bc.error);
      if (bc.ok) {
        await db.run(`INSERT INTO product_barcodes (id, product_id, barcode, unit_code, label, is_primary, created_at, updated_at)
                      VALUES (?,?,?,?,?,1, datetime('now'), datetime('now'))`,
        [newId(), id, bc.value, check.ladder[0].code, 'Primary barcode']);
      }
    }

    await recordFromCtx(ctx, {
      action: 'PRODUCT_CREATED', entityType: 'PRODUCT', entityId: id, branchId: branch ? branch.id : null, businessId: business.id,
      after: { name: fields.name, sku: fields.sku, selling_price: fields.selling_price, belowCost: belowCost || undefined },
    });
    ctx.json({
      ok: true, id,
      message: `“${fields.name}” added to the catalogue.${belowCost ? ' Note: it is priced below cost.' : ''}`,
      warning: ctx.get('barcodeWarning') || null,
    }, 201);
  });

  app.put(`${base}/products/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const before = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [id]);
    if (!before) throw new HttpError('That product does not exist.', { status: 404, code: 'PRODUCT_NOT_FOUND' });

    const body = await ctx.req.json();
    const fields = {};
    for (const [key, clean] of Object.entries(PRODUCT_FIELDS)) if (body[key] !== undefined) fields[key] = clean(body[key]);
    for (const flag of PRODUCT_FLAGS) if (body[flag] !== undefined) fields[flag] = boolField(body[flag]);

    // PRICE CHANGES ARE GOVERNED. A cashier who could quietly lower a selling
    // price has found the easiest theft route in retail: sell to a friend at
    // cost. The permission is OWNER-set and the change is audited with its
    // before-and-after values.
    const priceChanged = fields.selling_price !== undefined && round2(Number(fields.selling_price)) !== round2(Number(before.selling_price));
    if (priceChanged) {
      const allowed = canEditPrices(ctx.get('settings'), ctx.get('user'));
      if (!allowed.allowed) throw new HttpError(allowed.reason, { status: 403, code: 'PRICE_EDIT_NOT_ALLOWED' });
    }

    const updates = []; const params = [];
    for (const [k, v] of Object.entries(fields)) { updates.push(`${k} = ?`); params.push(v); }
    if (!updates.length) throw new HttpError('Nothing to update.', { status: 400, code: 'NOTHING_TO_UPDATE' });
    updates.push("updated_at = datetime('now')");
    params.push(id);
    await db.run(`UPDATE products SET ${updates.join(', ')} WHERE id = ? AND is_deleted = 0`, params);

    if (Array.isArray(body.units) && body.units.length) {
      const check = validateLadder(body.units);
      if (!check.ok) throw new HttpError(check.error, { status: 400, code: check.code });
      // The ladder is replaced wholesale rather than patched: a partial edit
      // leaves levels that no longer ascend, which is the exact state
      // validateLadder exists to prevent.
      await db.run('UPDATE product_units SET is_deleted = 1 WHERE product_id = ?', [id]);
      for (const level of check.ladder) {
        await db.run(`INSERT INTO product_units (id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
        [newId(), id, level.level, level.code, level.name, level.pluralName, level.quantityInBase, level.isSellable ? 1 : 0, level.isDefaultSell ? 1 : 0]);
      }
    }

    await recordFromCtx(ctx, {
      action: priceChanged ? 'PRICE_CHANGED' : 'PRODUCT_UPDATED', entityType: 'PRODUCT', entityId: id,
      before: pick(before, Object.keys(fields)), after: fields,
    });
    ctx.json({ ok: true, message: `“${fields.name || before.name}” updated.${priceChanged ? ` Selling price is now ₦${round2(Number(fields.selling_price)).toLocaleString('en-NG')}.` : ''}` });
  });

  /** Soft delete. Never a hard delete: sold lines reference this product forever. */
  app.delete(`${base}/products/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can remove a product from the catalogue.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [id]);
    if (!product) throw new HttpError('That product does not exist.', { status: 404, code: 'PRODUCT_NOT_FOUND' });

    const stockLeft = await db.scalar(`SELECT COALESCE(SUM(quantity - quantity_reserved),0) FROM stock_batches
      WHERE product_id = ? AND is_deleted = 0 AND status NOT IN ('QUARANTINED','EXPIRED')`, [id]);
    if (Number(stockLeft) > 0) {
      // Refusing here protects the stocktake. A product with stock on the shelf
      // that has vanished from the catalogue is untraceable shrinkage waiting to
      // be blamed on somebody.
      throw new HttpError(
        `“${product.name}” still has ${round2(Number(stockLeft))} units of stock across your branches. Sell it, transfer it or write it off first — removing it now would leave stock on the shelf that nothing accounts for.`,
        { status: 409, code: 'PRODUCT_HAS_STOCK' },
      );
    }

    await db.run("UPDATE products SET is_deleted = 1, is_active = 0, updated_at = datetime('now') WHERE id = ?", [id]);
    await recordFromCtx(ctx, { action: 'PRODUCT_UPDATED', entityType: 'PRODUCT', entityId: id, before: { is_deleted: 0 }, after: { is_deleted: 1 } });
    ctx.json({ ok: true, message: `“${product.name}” removed from the catalogue. Past sales keep their record of it.` });
  });

  /** Resolve a scanned barcode to a product. The POS uses this on every scan. */
  app.get(`${base}/catalogue/scan`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const code = (ctx.req.queryParam('code') || ctx.req.queryParam('barcode') || '').trim();
    if (!code) throw new HttpError('Pass ?code= with the scanned value.', { status: 400, code: 'MISSING_FIELD' });
    const branch = await resolveBranch(db, ctx);

    // Exact match first. A LIKE search on a scan would let a damaged barcode
    // that reads as a prefix of another product silently sell the wrong item.
    const hit = await db.first(`
      SELECT p.*, pb.unit_code AS scanned_unit, pb.variant_id AS barcode_variant_id, pb.label AS barcode_label,
             c.name AS category_name
      FROM product_barcodes pb
      JOIN products p ON p.id = pb.product_id AND p.is_deleted = 0 AND p.is_active = 1
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE pb.barcode = ? AND pb.is_deleted = 0`, [code]);

    if (!hit) {
      // Fall back to SKU, because a lot of Nigerian stock arrives with the
      // shop's own printed label rather than a manufacturer barcode, and the
      // cashier types the SKU into the same field.
      const bySku = await db.first(`SELECT p.*, c.name AS category_name FROM products p
          LEFT JOIN product_categories c ON c.id = p.category_id
          WHERE (p.sku = ? OR p.registration_no = ?) AND p.is_deleted = 0 AND p.is_active = 1`, [code.toUpperCase(), code.toUpperCase()]);
      if (!bySku) throw new HttpError(`Nothing in your catalogue matches “${code}”. Check the barcode, or add the product under Products.`, { status: 404, code: 'SCAN_NOT_FOUND' });
      return ctx.json({ ok: true, matchedBy: 'SKU', ...(await productPayload(db, bySku, branch, scope)) });
    }

    const scopeCheck = scopeFilter(scope, { alias: 'p' });
    if (scopeCheck.sql) {
      const allowed = await db.first(`SELECT p.id FROM products p WHERE p.id = ? AND ${scopeCheck.sql}`, [hit.id, ...scopeCheck.params]);
      if (!allowed) throw new HttpError('That product belongs to a different business.', { status: 403, code: 'SCOPE_VIOLATION' });
    }
    ctx.json({ ok: true, matchedBy: 'BARCODE', ...(await productPayload(db, hit, branch, scope, hit.scanned_unit, hit.barcode_variant_id)) });
  });

  // -------------------------------------------------------------------
  // CATEGORIES
  // -------------------------------------------------------------------
  app.get(`${base}/categories`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const businessId = ctx.req.queryParam('business_id');
    const where = ['c.is_deleted = 0']; const params = [];
    if (businessId) { where.push('(c.business_id = ? OR c.business_id IS NULL)'); params.push(String(businessId)); }
    else if (scope.businessIds) { where.push('(c.business_id IS NULL OR c.business_id IN (' + [...scope.businessIds].map(() => '?').join(',') + '))'); params.push(...scope.businessIds); }
    const rows = await db.all(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_deleted = 0) AS product_count
      FROM product_categories c WHERE ${where.join(' AND ')} ORDER BY c.sort_order, c.name`, params);
    ctx.json({ ok: true, data: rows });
  });

  app.post(`${base}/categories`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can add a category.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx, { required: false });
    const business = await resolveBusiness(db, ctx, branch || undefined);
    const name = requireField(body, 'name', 'Category name');
    const code = String(body.code || String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 40));

    const dupe = await db.first('SELECT id FROM product_categories WHERE business_id = ? AND code = ? AND is_deleted = 0', [String(business.id), code]);
    if (dupe) throw new HttpError(`A category coded “${code}” already exists for this business.`, { status: 409, code: 'DUPLICATE_CATEGORY' });

    const id = newId();
    const sort = Number(await db.scalar('SELECT COALESCE(MAX(sort_order),0) + 1 FROM product_categories WHERE business_id = ?', [String(business.id)])) || 0;
    await db.run(`INSERT INTO product_categories (id, business_id, code, name, parent_id, sort_order, is_active, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,1, datetime('now'), datetime('now'))`,
    [id, String(business.id), code, String(name).slice(0, 120), body.parent_id ? String(body.parent_id) : null, sort]);
    await recordFromCtx(ctx, { action: 'CATEGORY_CREATED', entityType: 'CATEGORY', entityId: id, businessId: business.id, after: { code, name } });
    ctx.json({ ok: true, id, code, name }, 201);
  });

  // -------------------------------------------------------------------
  // PRICE LISTS AND WHOLESALE TIERS
  // -------------------------------------------------------------------
  app.get(`${base}/price-lists`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const where = ['pl.is_deleted = 0']; const params = [];
    if (scope.businessIds) { where.push('(pl.business_id IS NULL OR pl.business_id IN (' + [...scope.businessIds].map(() => '?').join(',') + '))'); params.push(...scope.businessIds); }
    const lists = await db.all(`SELECT pl.*, (SELECT COUNT(*) FROM price_list_items i WHERE i.price_list_id = pl.id AND i.is_deleted = 0) AS item_count
      FROM price_lists pl WHERE ${where.join(' AND ')} ORDER BY pl.priority DESC, pl.name`, params);
    ctx.json({ ok: true, data: lists });
  });

  app.get(`${base}/price-lists/:id/items`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const { limit, offset } = pagination(ctx);
    const list = await db.first('SELECT * FROM price_lists WHERE id = ? AND is_deleted = 0', [id]);
    if (!list) throw new HttpError('That price list does not exist.', { status: 404, code: 'PRICE_LIST_NOT_FOUND' });
    const rows = await db.all(`SELECT i.*, p.name AS product_name, p.sku, p.selling_price AS retail_price, v.name AS variant_name
      FROM price_list_items i
      JOIN products p ON p.id = i.product_id
      LEFT JOIN product_variants v ON v.id = i.variant_id
      WHERE i.price_list_id = ? AND i.is_deleted = 0
      ORDER BY p.name, i.min_quantity DESC LIMIT ? OFFSET ?`, [id, limit, offset]);
    ctx.json(listResponse(rows, { limit, offset }));
  });

  /**
   * Set a wholesale tier.
   *
   * A tier is a (price list, product, unit, min_quantity) row. Several tiers per
   * product are how "5+ cartons at ₦X, 20+ at ₦Y" is expressed, and the sale
   * engine picks the highest min_quantity the order actually reaches.
   */
  app.post(`${base}/price-lists/:id/items`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const allowed = canEditPrices(ctx.get('settings'), user);
    if (!allowed.allowed) throw new HttpError(allowed.reason, { status: 403, code: 'PRICE_EDIT_NOT_ALLOWED' });

    const listId = String(ctx.req.param('id'));
    const list = await db.first('SELECT * FROM price_lists WHERE id = ? AND is_deleted = 0', [listId]);
    if (!list) throw new HttpError('That price list does not exist.', { status: 404, code: 'PRICE_LIST_NOT_FOUND' });

    const body = await ctx.req.json();
    const productId = String(requireField(body, 'product_id', 'Product'));
    const price = numField(requireField(body, 'price', 'Price'), { field: 'Price', min: 0 });
    const minQuantity = numField(body.min_quantity == null ? 0 : body.min_quantity, { field: 'Minimum quantity', min: 0, places: 4 });
    const unitCode = String(body.unit_code || 'PIECE').toUpperCase();

    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [productId]);
    if (!product) throw new HttpError('That product does not exist.', { status: 404, code: 'PRODUCT_NOT_FOUND' });
    const unit = await db.first('SELECT * FROM product_units WHERE product_id = ? AND code = ? AND is_deleted = 0', [productId, unitCode]);
    if (!unit) throw new HttpError(`“${product.name}” is not sold in ${unitCode}. Its units are: ${(await db.all('SELECT code FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base', [productId])).map((u) => u.code).join(', ')}.`, { status: 400, code: 'UNKNOWN_UNIT' });

    // Replacing an existing tier rather than adding a second one for the same
    // break: two rows with the same min_quantity make "which price applies"
    // depend on row order, which is exactly the ambiguity this feature removes.
    const existing = await db.first(`SELECT * FROM price_list_items WHERE price_list_id = ? AND product_id = ?
      AND unit_code = ? AND min_quantity = ? AND is_deleted = 0 AND ((? IS NULL AND variant_id IS NULL) OR variant_id = ?)`,
    [listId, productId, unitCode, Number(minQuantity), body.variant_id ? String(body.variant_id) : null, body.variant_id ? String(body.variant_id) : null]);

    const id = existing ? existing.id : newId();
    if (existing) {
      await db.run(`UPDATE price_list_items SET price = ?, valid_from = ?, valid_to = ?, updated_at = datetime('now') WHERE id = ?`,
        [round2(price), body.valid_from || null, body.valid_to || null, id]);
    } else {
      await db.run(`INSERT INTO price_list_items (id, price_list_id, product_id, variant_id, unit_code, price, min_quantity, valid_from, valid_to, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
      [id, listId, productId, body.variant_id ? String(body.variant_id) : null, unitCode, round2(price), Number(minQuantity), body.valid_from || null, body.valid_to || null]);
    }

    await recordFromCtx(ctx, {
      action: 'PRICE_CHANGED', entityType: 'PRICE_LIST_ITEM', entityId: id,
      before: existing ? { price: existing.price } : null,
      after: { list: list.name, product: product.name, unit: unitCode, minQuantity, price: round2(price) },
    });
    ctx.json({ ok: true, id, replaced: Boolean(existing), message: `${product.name}: ${minQuantity > 0 ? `${minQuantity}+ ` : ''}${unitCode.toLowerCase()} at ₦${round2(price).toLocaleString('en-NG')} on the ${list.name} list.` }, existing ? 200 : 201);
  });

  // -------------------------------------------------------------------
  // VERTICAL PROFILES — read-only, so the UI can explain itself
  // -------------------------------------------------------------------
  //
  // NAMESPACED UNDER /catalogue ON PURPOSE. `GET /api/profiles` is also served
  // by admin.js (the profile SUMMARY list: code, label, description), and the
  // router answers with the first registration — admin is mounted first, so this
  // richer payload spent its whole life as unreachable code. Two modules owning
  // one path is invisible until a screen silently shows the wrong shape, so the
  // frontend-contract test now fails on any duplicate (method, pattern) pair.
  app.get(`${base}/catalogue/profiles`, (ctx) => {
    // PROFILE_CODES is the list, not a hand-typed one: a hardcoded array drifts
    // from the profiles the provisioning service can actually build, and the
    // drift is invisible because `getProfile` falls back to the default for an
    // unknown code. (It also has to be spread — PROFILE_CODES is frozen, and
    // sorting it in place throws.)
    //
    // Each entry goes through `describeProfile(...)` with its CODE. Passing the
    // resolved profile object instead made every row describe the default
    // profile, because `String(object)` is "[object Object]" and that misses
    // every key.
    ctx.json({
      ok: true,
      data: [...PROFILE_CODES].map((code) => describeProfile(code)),
      ladders: LADDERS,
      measureAxes: MEASURE_AXES,
    });
  });

  /** The resolved profile for a business, including any owner overrides. */
  app.get(`${base}/profiles/:code`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const code = String(ctx.req.param('code')).toUpperCase();
    const businessId = ctx.req.queryParam('business_id');
    let overrides = null;
    if (businessId) {
      const b = await db.first('SELECT profile_overrides_json FROM businesses WHERE id = ?', [String(businessId)]);
      if (b && b.profile_overrides_json) { try { overrides = JSON.parse(b.profile_overrides_json); } catch (e) { overrides = null; } }
    }
    const profile = resolveProfile(code, overrides);
    if (!profile) throw new HttpError(`“${code}” is not a business profile this system knows.`, { status: 404, code: 'UNKNOWN_PROFILE' });
    ctx.json({ ok: true, ...describeProfile(profile) });
  });

  // -------------------------------------------------------------------
  // SUPPLIERS
  // -------------------------------------------------------------------
  app.get(`${base}/suppliers`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const { limit, offset } = pagination(ctx);
    const search = (ctx.req.queryParam('q') || '').trim();
    const where = ['s.is_deleted = 0']; const params = [];
    if (search) { where.push('(s.name LIKE ? OR s.phone LIKE ? OR s.city LIKE ?)'); const like = `%${search}%`; params.push(like, like, like); }
    const rows = await db.all(`SELECT s.*,
        (SELECT COALESCE(SUM(po.total),0) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.is_deleted = 0) AS lifetime_purchases,
        (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.is_deleted = 0) AS order_count,
        (SELECT COALESCE(SUM(cl.amount),0) FROM creditor_ledger cl WHERE cl.supplier_id = s.id AND cl.is_deleted = 0) AS balance_owed
      FROM suppliers s WHERE ${where.join(' AND ')} ORDER BY s.name LIMIT ? OFFSET ?`, [...params, limit, offset]);
    ctx.json(listResponse(rows, { limit, offset }, await db.scalar(`SELECT COUNT(*) FROM suppliers s WHERE ${where.join(' AND ')}`, params)));
  });

  /**
   * One supplier, with the two lists that are actually read when the phone rings:
   * what we ordered (and whether it has landed) and what we have paid.
   *
   * The balance is the SUM of the creditor ledger, not a stored column — the
   * ledger is the record, and a cached balance that can drift from it is worse
   * than no balance at all.
   */
  app.get(`${base}/suppliers/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const supplier = await db.first(`SELECT s.*,
        (SELECT COALESCE(SUM(po.total),0) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.is_deleted = 0) AS lifetime_purchases,
        (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.is_deleted = 0) AS order_count,
        (SELECT COALESCE(SUM(cl.amount),0) FROM creditor_ledger cl WHERE cl.supplier_id = s.id AND cl.is_deleted = 0) AS balance_owed
      FROM suppliers s WHERE s.id = ? AND s.is_deleted = 0`, [id]);
    if (!supplier) throw new HttpError('That supplier does not exist.', { status: 404, code: 'SUPPLIER_NOT_FOUND' });

    const purchaseOrders = await db.all(`SELECT po.*, b.name AS branch_name,
        (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id AND i.is_deleted = 0) AS item_count,
        (SELECT COALESCE(SUM(i.quantity_in_base),0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id AND i.is_deleted = 0) AS units_ordered,
        (SELECT COALESCE(SUM(i.quantity_received),0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id AND i.is_deleted = 0) AS units_received
      FROM purchase_orders po LEFT JOIN branches b ON b.id = po.branch_id
      WHERE po.supplier_id = ? AND po.is_deleted = 0
      ORDER BY po.ordered_at DESC, po.po_number DESC LIMIT 25`, [id]);

    const payments = await db.all(`SELECT cl.*, u.full_name AS created_by_name
      FROM creditor_ledger cl LEFT JOIN users u ON u.id = cl.created_by
      WHERE cl.supplier_id = ? AND cl.is_deleted = 0
      ORDER BY cl.created_at DESC LIMIT 50`, [id]);

    const wht = await db.all(`SELECT COALESCE(SUM(wht_amount),0) AS withheld, COUNT(*) AS entries
      FROM wht_entries WHERE supplier_id = ? AND is_deleted = 0`, [id]).then((r) => r[0] || { withheld: 0, entries: 0 }).catch(() => ({ withheld: 0, entries: 0 }));

    ctx.json({
      ok: true,
      supplier: { ...supplier, balance_owed: round2(Number(supplier.balance_owed)), lifetime_purchases: round2(Number(supplier.lifetime_purchases)) },
      purchaseOrders: purchaseOrders.map((po) => ({
        ...po,
        outstanding_units: round2(Number(po.units_ordered) - Number(po.units_received)),
        overdue: Boolean(po.expected_date) && po.status !== 'RECEIVED' && po.status !== 'CANCELLED' && po.expected_date < watToday(),
      })),
      payments,
      withholding: { total_withheld: round2(Number(wht.withheld)), entries: Number(wht.entries) },
    });
  });

  app.post(`${base}/suppliers`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can add a supplier.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const name = requireField(body, 'name', 'Supplier name');
    const id = newId();
    await db.run(`INSERT INTO suppliers (
        id, business_id, name, contact_person, phone, alt_phone, email, address, city, state, country,
        tin, cac_reg_no, is_manufacturer, bank_name, bank_account_no, bank_account_name,
        credit_limit, payment_terms_days, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
      id, body.business_id ? String(body.business_id) : null, String(name).slice(0, 160),
      strField(body.contact_person, { field: 'Contact person', maxLength: 120 }),
      strField(body.phone, { field: 'Phone', maxLength: 40 }),
      strField(body.alt_phone, { field: 'Alternate phone', maxLength: 40 }),
      strField(body.email, { field: 'Email', maxLength: 160 }),
      strField(body.address, { field: 'Address', maxLength: 300 }),
      strField(body.city, { field: 'City', maxLength: 80 }),
      strField(body.state, { field: 'State', maxLength: 80 }), 'Nigeria',
      strField(body.tin, { field: 'TIN', maxLength: 40 }),
      strField(body.cac_reg_no, { field: 'CAC number', maxLength: 40 }),
      // is_manufacturer decides WHT: goods a supplier manufactured itself are
      // NOT liable to the 2% supply-of-goods deduction, a distributor's are.
      // Getting this flag wrong either over-deducts (the supplier disputes it)
      // or under-deducts (FIRS does).
      boolField(body.is_manufacturer),
      strField(body.bank_name, { field: 'Bank', maxLength: 120 }),
      strField(body.bank_account_no, { field: 'Account number', maxLength: 40 }),
      strField(body.bank_account_name, { field: 'Account name', maxLength: 160 }),
      numField(body.credit_limit, { field: 'Credit limit', min: 0 }),
      numField(body.payment_terms_days, { field: 'Payment terms (days)', min: 0, max: 365, whole: true }),
      strField(body.notes, { field: 'Notes', maxLength: 1000 }),
    ]);
    await recordFromCtx(ctx, { action: 'PRODUCT_CREATED', entityType: 'SUPPLIER', entityId: id, after: { name } });
    ctx.json({ ok: true, id, message: `${name} added as a supplier.` }, 201);
  });

  app.put(`${base}/suppliers/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const before = await db.first('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0', [id]);
    if (!before) throw new HttpError('That supplier does not exist.', { status: 404, code: 'SUPPLIER_NOT_FOUND' });
    const body = await ctx.req.json();
    const updates = []; const params = [];
    const strings = ['name', 'contact_person', 'phone', 'alt_phone', 'email', 'address', 'city', 'state', 'tin', 'cac_reg_no', 'bank_name', 'bank_account_no', 'bank_account_name', 'notes'];
    for (const f of strings) if (body[f] !== undefined) { updates.push(`${f} = ?`); params.push(strField(body[f], { field: f.replace(/_/g, ' '), maxLength: 300 })); }
    if (body.is_manufacturer !== undefined) { updates.push('is_manufacturer = ?'); params.push(boolField(body.is_manufacturer)); }
    if (body.credit_limit !== undefined) { updates.push('credit_limit = ?'); params.push(numField(body.credit_limit, { field: 'Credit limit', min: 0 })); }
    if (body.payment_terms_days !== undefined) { updates.push('payment_terms_days = ?'); params.push(numField(body.payment_terms_days, { field: 'Payment terms', min: 0, max: 365, whole: true })); }
    if (body.rating !== undefined) { updates.push('rating = ?'); params.push(numField(body.rating, { field: 'Rating', min: 1, max: 5, whole: true })); }
    if (body.is_deleted !== undefined) { updates.push('is_deleted = ?'); params.push(boolField(body.is_deleted)); }
    if (!updates.length) throw new HttpError('Nothing to update.', { status: 400, code: 'NOTHING_TO_UPDATE' });
    updates.push("updated_at = datetime('now')");
    params.push(id);
    await db.run(`UPDATE suppliers SET ${updates.join(', ')} WHERE id = ?`, params);
    await recordFromCtx(ctx, { action: 'PRODUCT_UPDATED', entityType: 'SUPPLIER', entityId: id, before: pick(before, Object.keys(body)), after: body });
    ctx.json({ ok: true, message: `${body.name || before.name} updated.` });
  });
}

/** The payload a POS scan needs: price, units, variants and stock at this branch. */
async function productPayload(db, product, branch, scope, scannedUnit = null, barcodeVariantId = null) {
  const [units, variants, measure, stock, overrides, lists] = await Promise.all([
    db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [product.id]),
    db.all('SELECT * FROM product_variants WHERE product_id = ? AND is_deleted = 0 ORDER BY sort_order, name', [product.id]),
    // ALL of them, not an arbitrary one. A sofa is sold by the piece AND has a
    // packed weight; a cable is sold by the metre AND rolled. `UNIQUE
    // (product_id, axis)` means a product may legitimately carry several rows,
    // so `first()` here was picking whichever the planner happened to return.
    db.all('SELECT * FROM product_measures WHERE product_id = ? AND is_deleted = 0 ORDER BY axis', [product.id]),
    db.all(`SELECT sb.*, sb.quantity - sb.quantity_reserved AS available FROM stock_batches sb
      WHERE sb.product_id = ? AND sb.branch_id = ? AND sb.is_deleted = 0 AND sb.status = 'ACTIVE'
      ORDER BY sb.expiry_date IS NULL, sb.expiry_date, sb.received_at, sb.batch_no, sb.id`, [product.id, branch.id]),
    db.all('SELECT * FROM product_price_overrides WHERE product_id = ? AND branch_id = ? AND is_deleted = 0', [product.id, branch.id]),
    db.all('SELECT * FROM price_lists WHERE is_deleted = 0 AND is_active = 1 AND (business_id = ? OR business_id IS NULL) ORDER BY priority DESC', [String(product.business_id)]),
  ]);

  const onHand = stock.reduce((a, s) => a + Math.max(0, Number(s.quantity) - Number(s.quantity_reserved)), 0);
  return {
    product,
    category_name: product.category_name,
    units,
    variants,
    measures,
    // Whichever axis is first, deterministically — kept because the POS renders a
    // single "size" line and existing callers read `measure`.
    measure: measures[0] || null,
    scannedUnit: scannedUnit || null,
    barcodeVariantId: barcodeVariantId || null,
    priceOverrides: overrides,
    priceLists: lists.map((l) => ({ id: l.id, name: l.name, code: l.code, priority: l.priority })),
    batches: stock.map((s) => ({
      id: s.id, batch_no: s.batch_no, quantity: round2(Number(s.quantity)),
      reserved: round2(Number(s.quantity_reserved)), available: round2(Number(s.available)),
      cost: Number(s.cost_price_per_unit), price: Number(s.selling_price_per_unit),
      expiry_date: s.expiry_date, zone: s.warehouse_zone,
    })),
    onHand: round2(onHand),
    inScope: Boolean(scope),
    serialised: Boolean(Number(product.requires_serial)),
    needsVariant: Boolean(Number(product.tracks_variants)),
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = { mount };
