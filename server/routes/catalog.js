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
const { atLeast, canOrganizeCatalogue } = require('../../domain/roles');
const selling = require('../../domain/selling');
const { resolveBranch, resolveBusiness, scopeFilter, pagination, listResponse, requireField, valid, numField, strField, boolField, searchTerm } = require('../lib/respond');
const { validateLadder } = require('../../domain/uom');
const { LADDERS, MEASURE_AXES, PROFILE_CODES, getProfile, resolveProfile, describeProfile } = require('../../domain/verticals');
const { modulesOf } = require('../../domain/modules');
const { round2 } = require('../../domain/money');
const { barcode: barcodeRule, oneOf } = require('../../domain/validation');
const { newId } = require('../../domain/crypto');
const { canEditPrices } = require('../../domain/planLimits');
const { watToday } = require('../../domain/time');
const market = require('../../domain/nigeriaMarket');
const { fileGreenbook, syntheticBarcode } = require('../services/provisioningService');

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
  dispensing_class: (v) => (v == null || v === '' ? null : valid(oneOf(String(v).toUpperCase(), ['OTC', 'POM'], { field: 'Dispensing class' }), 'dispensing_class')),
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
  hire_price_per_day: (v) => (v == null || v === '' ? null : numField(v, { field: 'Hire rate', min: 0 })),
  hire_deposit: (v) => (v == null || v === '' ? null : numField(v, { field: 'Hire deposit', min: 0 })),
  lease_price_per_month: (v) => (v == null || v === '' ? null : numField(v, { field: 'Lease rate', min: 0 })),
  lease_deposit: (v) => (v == null || v === '' ? null : numField(v, { field: 'Lease deposit', min: 0 })),
};
const PRODUCT_FLAGS = ['requires_serial', 'tracks_variants', 'is_bulky', 'requires_installation', 'has_expiry', 'is_age_restricted', 'is_fragile', 'is_returnable', 'is_active', 'offers_sale', 'offers_hire', 'offers_lease', 'is_controlled'];

function overridesOf(business) {
  if (!business || !business.profile_overrides_json) return null;
  try { return JSON.parse(business.profile_overrides_json); } catch (e) { return null; }
}

function modulesOfBusiness(business) {
  return modulesOf(business && business.profile_code, overridesOf(business));
}

function refuseForeignModule(business, fields) {
  if (!business) return;
  const modules = modulesOfBusiness(business);
  const on = (flag) => fields[flag] === 1 || fields[flag] === true;
  if ((on('offers_hire') || Number(fields.hire_price_per_day) > 0 || Number(fields.hire_deposit) > 0) && !modules.hire) {
    throw new HttpError('Hire belongs to a business that hires goods out. This one does not.', { status: 403, code: 'MODULE_OFF' });
  }
  if ((on('offers_lease') || Number(fields.lease_price_per_month) > 0 || Number(fields.lease_deposit) > 0) && !modules.lease) {
    throw new HttpError('A lease belongs to a business that leases. This one does not.', { status: 403, code: 'MODULE_OFF' });
  }
  if ((fields.dispensing_class || on('is_controlled')) && !modules.dispensing) {
    throw new HttpError('Prescription and controlled medicines belong to a dispensary. This business is not one.', { status: 403, code: 'MODULE_OFF' });
  }
  if (on('requires_serial') && !modules.serials) {
    throw new HttpError('Serial numbers belong to a business that tracks individual units. This one does not.', { status: 403, code: 'MODULE_OFF' });
  }
  if (Number(fields.warranty_months) > 0 && !modules.warranty) {
    throw new HttpError('Warranty belongs to a business that sells covered goods. This one does not.', { status: 403, code: 'MODULE_OFF' });
  }
  if (on('tracks_variants') && !modules.variants) {
    throw new HttpError('Variants belong to a business that sells the same goods in more than one form. This one does not.', { status: 403, code: 'MODULE_OFF' });
  }
  if (on('has_expiry') && !modules.expiry) {
    throw new HttpError('Expiry tracking belongs to a business that sells dated goods. This one does not.', { status: 403, code: 'MODULE_OFF' });
  }
  if (on('requires_installation') && !modules.installation) {
    throw new HttpError('Installation belongs to a business that fits what it sells. This one does not.', { status: 403, code: 'MODULE_OFF' });
  }
  if (on('is_bulky') && !modules.bulky) {
    throw new HttpError('Bulky delivery belongs to a business that delivers large goods. This one does not.', { status: 403, code: 'MODULE_OFF' });
  }
  if (on('is_fragile') && !modules.fragile) {
    throw new HttpError('Fragile handling belongs to a business that marks goods that break. This one does not.', { status: 403, code: 'MODULE_OFF' });
  }
}

async function requireModule(db, ctx, name, message) {
  const branch = await resolveBranch(db, ctx, { required: false });
  const business = await resolveBusiness(db, ctx, branch || undefined, { required: false });
  if (!business) {
    throw new HttpError('Choose which business this applies to.', { status: 400, code: 'BUSINESS_REQUIRED' });
  }
  const modules = modulesOfBusiness(business);
  if (!modules[name]) throw new HttpError(message, { status: 403, code: 'MODULE_OFF' });
  return business;
}

/**
 * A new category is not appended. It is given the place its name has among
 * the categories this business already has, and the sort numbers are rewritten
 * so a screen that still orders by sort_order agrees with one that orders by name.
 */
async function fileCategoriesAlphabetically(db, businessId) {
  const rows = await db.all(
    `SELECT id, name FROM product_categories
      WHERE business_id = ? AND is_deleted = 0
      ORDER BY name COLLATE NOCASE, code`,
    [String(businessId)],
  );
  for (let i = 0; i < rows.length; i += 1) {
    await db.run(
      `UPDATE product_categories SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`,
      [i + 1, rows[i].id],
    );
  }
  return rows;
}

/**
 * Stock the till is allowed to sell: still on the shelf, and received against
 * a purchase order. A catalogue row that was never received, a direct receipt
 * with no order, and a cancelled order are not offered at the counter.
 * PARTIALLY_RECEIVED counts — the cartons that arrived are stock.
 */
function receivedStockExpr(productAlias = 'p') {
  return `(SELECT COALESCE(SUM(sb.quantity - sb.quantity_reserved), 0)
    FROM stock_batches sb
    INNER JOIN purchase_orders po ON po.id = sb.purchase_order_id
      AND po.is_deleted = 0 AND po.status IN ('PARTIALLY_RECEIVED','RECEIVED')
    WHERE sb.product_id = ${productAlias}.id AND sb.branch_id = ?
      AND sb.is_deleted = 0 AND sb.status = 'ACTIVE')`;
}

async function receivedAvailable(db, productId, branchId) {
  const n = await db.scalar(
    `SELECT COALESCE(SUM(sb.quantity - sb.quantity_reserved), 0)
     FROM stock_batches sb
     INNER JOIN purchase_orders po ON po.id = sb.purchase_order_id
       AND po.is_deleted = 0 AND po.status IN ('PARTIALLY_RECEIVED','RECEIVED')
     WHERE sb.product_id = ? AND sb.branch_id = ? AND sb.is_deleted = 0 AND sb.status = 'ACTIVE'`,
    [String(productId), String(branchId)],
  );
  return Number(n) || 0;
}


/**
 * Every catalogue product carries one shelf barcode, the same way the seeded
 * list does. A USB scanner at the till reads that code. A manufacturer barcode
 * is kept when one was supplied and it is valid and free; otherwise an
 * in-store EAN-13 (GS1 prefix 2) is assigned from the product id so two shops
 * with the same SKU cannot collide.
 */
async function assignShelfBarcode(db, { productId, unitCode, supplied, seed }) {
  const unit = unitCode || 'PIECE';
  const insert = async (code, label) => {
    const id = newId();
    await db.run(`INSERT INTO product_barcodes (id, product_id, barcode, unit_code, label, is_primary, created_at, updated_at)
                  VALUES (?,?,?,?,?,1, datetime('now'), datetime('now'))`,
    [id, productId, code, unit, label]);
    await db.run("UPDATE products SET barcode = ?, updated_at = datetime('now') WHERE id = ?", [code, productId]);
    return { barcode: code, id, unitCode: unit, warning: null };
  };
  if (supplied != null && String(supplied).trim() !== '') {
    const bc = barcodeRule(String(supplied));
    if (bc.ok) {
      const clash = await db.first('SELECT id, product_id FROM product_barcodes WHERE barcode = ?', [bc.value]);
      if (!clash) return insert(bc.value, 'Shelf label');
      if (String(clash.product_id) === String(productId)) {
        return { barcode: bc.value, id: clash.id, unitCode: unit, warning: null };
      }
      const generated = await insertGeneratedBarcode(db, insert, productId, seed);
      return Object.assign(generated, { warning: 'That barcode is already on another product, so a shelf barcode was assigned instead.' });
    }
    const generated = await insertGeneratedBarcode(db, insert, productId, seed);
    return Object.assign(generated, { warning: bc.error });
  }
  return insertGeneratedBarcode(db, insert, productId, seed);
}

async function insertGeneratedBarcode(db, insert, productId, seed) {
  for (let n = 0; n < 6; n += 1) {
    const code = syntheticBarcode(`${productId}|${seed || ''}|${n}`);
    if (!code) continue;
    const clash = await db.first('SELECT id FROM product_barcodes WHERE barcode = ?', [code]);
    if (clash) continue;
    try {
      return await insert(code, 'Shelf label');
    } catch (err) {
      /* unique race: try the next seed */
    }
  }
  return { barcode: null, id: null, unitCode: null, warning: 'A shelf barcode could not be assigned. The product is still in the catalogue and can be found by name.' };
}

/** What a USB wedge actually delivers: the code, without the gun's prefix or suffix. */
function normalizeScanCode(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.trim().replace(/^\][A-Za-z][0-9]/, '').replace(/^[*]+|[*]+$/g, '').trim();
  return s;
}

function scanCandidates(raw) {
  const code = normalizeScanCode(raw);
  const list = [];
  const push = (v) => { if (v && !list.includes(v)) list.push(v); };
  push(code);
  if (code) push(code.toUpperCase());
  if (/^\d{12}$/.test(code)) push(`0${code}`);
  if (/^\d{13,14}$/.test(code) && code[0] === '0') push(code.slice(1));
  return list;
}

async function assertSellable(db, productId, branchId, name) {
  const row = await db.first('SELECT offers_sale FROM products WHERE id = ? AND is_deleted = 0', [productId]);
  if (row && Number(row.offers_sale) === 0) {
    throw new HttpError(
      `“${name || 'That product'}” is not sold at the till. It is kept as stock — a plant input, or goods that are hired rather than sold.`,
      { status: 400, code: 'NOT_FOR_SALE' },
    );
  }
  const available = await receivedAvailable(db, productId, branchId);
  if (!(available > 0)) {
    throw new HttpError(
      `“${name || 'That product'}” is not on the shelf from a received purchase order. The till only sells goods that were received on a purchase order and still have stock.`,
      { status: 404, code: 'NOT_IN_RECEIVED_STOCK' },
    );
  }
  return available;
}

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // PRODUCTS
  // -------------------------------------------------------------------
  app.get(`${base}/products`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    // sort=name is the catalogue screen. Everything else keeps owned goods
    // first so a priced row is still on page one. A dispensary's own goods
    // now include every registration, so those stay ahead of the shared
    // market list even when the catalogue asks for name order.
    const sortByName = String(ctx.req.queryParam('sort') || '') === 'name';
    const search = searchTerm(ctx);
    const businessId = ctx.req.queryParam('business_id');
    const categoryId = ctx.req.queryParam('category_id');
    const activeOnly = ctx.req.queryParam('active') !== '0';
    const lowStock = ctx.req.queryParam('low_stock') === '1';
    // The catalogue keeps listing goods that have not been received yet — that
    // is how a purchase order is raised. The till passes for_sale=1 and must
    // not be offered those rows, or a name that was never received.
    const forSale = ctx.req.queryParam('for_sale') === '1';
    const branch = (lowStock || forSale) ? await resolveBranch(db, ctx) : null;

    const where = ['p.is_deleted = 0'];
    const params = [];
    if (businessId) { where.push('(p.business_id = ? OR p.business_id IS NULL)'); params.push(String(businessId)); }
    else if (scope.businessIds) { where.push('(p.business_id IS NULL OR p.business_id IN (' + [...scope.businessIds].map(() => '?').join(',') + '))'); params.push(...[...scope.businessIds]); }
    if (categoryId) { where.push('p.category_id = ?'); params.push(String(categoryId)); }
    const sellingGroup = String(ctx.req.queryParam('selling_group') || '').trim();
    if (sellingGroup) {
      const selling = require('../../domain/selling');
      const clause = selling.productWhere(sellingGroup);
      where.push(clause.sql);
      params.push(...clause.params);
    }
    if (activeOnly) where.push('p.is_active = 1');
    if (search) {
      where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ? OR p.model_no LIKE ? OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode LIKE ? AND pb.is_deleted = 0))');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    // The Nigerian-market migration plants the same SKU as a shared row. Once
    // a shop the caller can see has added its own copy, the list must not show
    // both — a second Mama Gold is how a till rings the unpriced one. An owner
    // reaches every business, so for them the copy can belong to any shop.
    const ownerIds = businessId ? [String(businessId)] : (scope.businessIds ? [...scope.businessIds] : null);
    if (ownerIds && ownerIds.length) {
      where.push(`NOT (p.business_id IS NULL AND EXISTS (
        SELECT 1 FROM products own
        WHERE own.is_deleted = 0 AND own.sku = p.sku AND own.sku IS NOT NULL
          AND own.business_id IN (${ownerIds.map(() => '?').join(',')})
      ))`);
      params.push(...ownerIds);
    } else if (!scope.businessIds) {
      where.push(`NOT (p.business_id IS NULL AND EXISTS (
        SELECT 1 FROM products own
        WHERE own.is_deleted = 0 AND own.sku = p.sku AND own.sku IS NOT NULL
          AND own.business_id IS NOT NULL
      ))`);
    }

    // On-hand stock is a correlated subquery rather than a join, because a join
    // over stock_batches would multiply product rows by batch count and then need
    // re-grouping; for a list screen the subquery is both simpler and faster.
    // A sale search counts only stock received on a purchase order, so the
    // figure beside the name is the quantity the till is allowed to ring.
    const stockExpr = forSale
      ? receivedStockExpr('p')
      : branch
      ? `(SELECT COALESCE(SUM(sb.quantity - sb.quantity_reserved), 0) FROM stock_batches sb
          WHERE sb.product_id = p.id AND sb.branch_id = ? AND sb.is_deleted = 0
            AND sb.status NOT IN ('QUARANTINED','EXPIRED'))`
      : `(SELECT COALESCE(SUM(sb.quantity - sb.quantity_reserved), 0) FROM stock_batches sb
          WHERE sb.product_id = p.id AND sb.is_deleted = 0 AND sb.status NOT IN ('QUARANTINED','EXPIRED'))`;
    if (forSale) {
      // A plant input is stock, not a till line. Hire-only goods are the
      // same shape: offers_sale is off, so the counter must not offer them.
      where.push('COALESCE(p.offers_sale, 1) = 1');
      where.push(`${receivedStockExpr('p')} > 0`);
      params.push(String(branch.id));
    }

    // A pharmaceutical business owns every NAFDAC registration as one of its
    // own products. File any that are missing before the list is read, so the
    // catalogue and a purchase order see the same rows a shop product uses.
    // Other verticals are not given them. A virtual Greenbook id is not listed:
    // that was the Add button.
    let ownCatalogue = false;
    // Filing the Greenbook is a catalogue job. Doing it on every till
    // keystroke made a dispensary search wait on thousands of registrations,
    // and a phone that gave up then searched an empty device.
    if (businessId && !forSale) {
      const focused = await db.first(
        'SELECT profile_code, profile_overrides_json FROM businesses WHERE id = ? AND is_deleted = 0',
        [String(businessId)],
      );
      if (focused && modulesOfBusiness(focused).nafdac) {
        await fileGreenbook(db, String(businessId));
        ownCatalogue = true;
      }
    }
    const orderSql = sortByName
      ? `${ownCatalogue ? '(p.business_id IS NULL), ' : ''}LOWER(p.name) ASC, LOWER(IFNULL(p.sku, '')) ASC, p.id ASC`
      : '(p.business_id IS NULL), p.name ASC';

    const productBind = [...(branch ? [String(branch.id)] : []), ...params, ...(lowStock && branch ? [String(branch.id)] : [])];
    const productSelect = `
      SELECT p.id, p.business_id, p.category_id, p.sku, p.name, p.brand, p.model_no,
             p.requires_serial, p.tracks_variants, p.warranty_months, p.warranty_type,
             p.is_bulky, p.requires_installation, p.has_expiry, p.is_fragile, p.is_returnable,
             p.base_unit_name, p.cost_price, p.selling_price, p.reorder_level, p.reorder_quantity,
             p.min_margin_pct, p.valuation_method, p.is_active, p.updated_at,
             p.offers_sale, p.offers_hire, p.offers_lease,
             p.hire_price_per_day, p.hire_deposit, p.lease_price_per_month, p.lease_deposit,
             p.dispensing_class, p.is_controlled, p.nafdac_catalog_id, p.registration_no,
             c.name AS category_name, c.code AS category_code,
             -- The unit a screen should sell or buy in, as a CODE. base_unit_name
             -- is the WORD a receipt prints (unit, piece, metre), which is not
             -- always the same as the ladder's code for that level: the appliance
             -- ladder names PIECE "Unit", and a till that sent the name was refused
             -- with 'Unknown unit'. Expose the code so no client has to guess.
             (SELECT pu.code FROM product_units pu
               WHERE pu.product_id = p.id AND pu.is_deleted = 0
               ORDER BY pu.is_default_sell DESC, pu.quantity_in_base ASC LIMIT 1) AS default_unit_code,
             -- ...and HOW MANY base units that code is. A till that knows the code
             -- but not the factor prices a carton of water at the price of a bottle:
             -- it showed the customer ₦300 for ₦14,400 of water.
             (SELECT pu.quantity_in_base FROM product_units pu
               WHERE pu.product_id = p.id AND pu.is_deleted = 0
               ORDER BY pu.is_default_sell DESC, pu.quantity_in_base ASC LIMIT 1) AS default_unit_factor,
             ${stockExpr} AS on_hand
      FROM products p
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')}
      ${lowStock ? 'AND COALESCE((' + stockExpr + '), 0) <= p.reorder_level' : ''}`;

    let rows;
    let total;
    let located = null;
    const locateId = ctx.req.queryParam('locate');
    {
      rows = await db.all(`
        ${productSelect}
        -- Default: the shop's own goods first. The shared market list is thousands of
        -- unpriced names; sorting those first would hide a priced product on
        -- the first page of the till and of every audit that sells one.
        -- The catalogue screen asks for sort=name, which files a new product
        -- among those names instead of in a block ahead of them.
        ORDER BY ${orderSql}
        LIMIT ? OFFSET ?`,
      [...productBind, limit, offset]);
      total = await db.scalar(`SELECT COUNT(*) FROM products p WHERE ${where.join(' AND ')}`, params);
      // locate tells the catalogue which page a name just landed on, using the
      // same filter and the same name order as the list above.
      if (locateId && sortByName) {
        const target = await db.first(
          `SELECT p.id, p.name, p.sku FROM products p WHERE p.id = ? AND ${where.join(' AND ')}`,
          [String(locateId), ...params],
        );
        if (target) {
          const index = await db.scalar(
            `SELECT COUNT(*) FROM products p WHERE ${where.join(' AND ')} AND (
               LOWER(p.name) < LOWER(?)
               OR (LOWER(p.name) = LOWER(?) AND LOWER(IFNULL(p.sku, '')) < LOWER(?))
               OR (LOWER(p.name) = LOWER(?) AND LOWER(IFNULL(p.sku, '')) = LOWER(?) AND p.id < ?)
             )`,
            [...params, target.name, target.name, target.sku || '', target.name, target.sku || '', target.id],
          );
          located = { id: target.id, index: Number(index) || 0, name: target.name };
        }
      }
    }
    // The till searches this list and refuses a row whose selling_price is 0.
    // A shared market product stays unpriced on the row itself. This branch's
    // override, or the price typed when the goods were received, is what the
    // shop actually charges — so that is the price the list hands the till.
    const priceBranchId = ctx.req.queryParam('branch_id');
    if (priceBranchId) rows = await applyShopPrices(db, rows, String(priceBranchId));
    const body = listResponse(rows.map((r) => ({
      ...r,
      on_hand: round2(Number(r.on_hand) || 0),
      low_stock: Number(r.reorder_level) > 0 && Number(r.on_hand) <= Number(r.reorder_level),
      margin_pct: Number(r.selling_price) > 0 ? round2(((Number(r.selling_price) - Number(r.cost_price)) / Number(r.selling_price)) * 100) : null,
    })), { limit, offset }, total);
    if (located) body.located = located;
    ctx.json(body);
  });

  app.get(`${base}/products/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [id]);
    if (!product) throw new HttpError('That product does not exist, or has been deleted.', { status: 404, code: 'PRODUCT_NOT_FOUND' });

    const [units, variants, measures, barcodes, registrations, category, overrides, stockByBranch, shelfPrices] = await Promise.all([
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
      db.all(`SELECT branch_id, selling_price_per_unit, received_at FROM stock_batches
        WHERE product_id = ? AND is_deleted = 0 AND selling_price_per_unit > 0
          AND status NOT IN ('QUARANTINED','EXPIRED')
        ORDER BY received_at DESC, id DESC`, [id]),
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
      shelfPrices,
      stock: stockByBranch.map((s) => ({
        ...s,
        on_shelf: round2(Number(s.on_shelf)), reserved: round2(Number(s.reserved)),
        available: round2(Number(s.available)), stock_value: round2(Number(s.stock_value)),
      })),
    });
  });

  /**
   * -------------------------------------------------------------------
   * A BRANCH PRICE OVERRIDE
   * -------------------------------------------------------------------
   * THE MISSING HALF OF A FEATURE THAT WAS ALREADY BUILT.
   *
   * `domain/pricing.js` resolves a line price in a documented order — manual,
   * then the branch OVERRIDE, then the customer's price list, then the product —
   * and `salesService.loadPriceOverrides()` has always loaded them. The product
   * detail screen has always shown them. Nothing anywhere could CREATE one. So:
   *
   *   * an Ikeja shop could not price a kettle differently from its Aba shop;
   *   * a wholesale counter could not carry a carton price that differs from the
   *     per-piece price times 24.
   *
   * By the capability audit (tools/capability-audit.js) this was "read but never
   * created" — a capability that reaches a customer as a screen they cannot fill
   * in. These two endpoints are how it is created and cleared.
   *
   * WRITE IT, OR CLEAR IT — there is no third verb. An override is a whole
   * pricing decision for one product in one branch, so a partial update would
   * leave `pack_price` from a previous decision standing next to a new per-piece
   * price, which is how a branch ends up quietly selling cartons below cost.
   */
  app.put(`${base}/products/:id/price-override`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const allowed = canEditPrices(ctx.get('settings'), user);
    if (!allowed.allowed) throw new HttpError(allowed.reason, { status: 403, code: 'PRICE_EDIT_NOT_ALLOWED' });

    const id = String(ctx.req.param('id'));
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [id]);
    if (!product) throw new HttpError('That product does not exist, or has been deleted.', { status: 404, code: 'PRODUCT_NOT_FOUND' });

    // `resolveBranch` does the whole job: it reads the branch from the body or the
    // query, honours a user pinned to one shop, refuses an owner of several who
    // has not said which, refuses a deactivated branch, and refuses a branch
    // outside the caller's scope. Re-implementing any of that here would be a
    // second, weaker copy of the same rule.
    const branch = await resolveBranch(db, ctx, { required: true });

    const body = await ctx.req.json();
    const variantId = body.variant_id ? String(body.variant_id) : null;
    if (variantId) {
      const variant = await db.first('SELECT * FROM product_variants WHERE id = ? AND product_id = ? AND is_deleted = 0', [variantId, id]);
      if (!variant) throw new HttpError('That variant does not belong to this product.', { status: 400, code: 'VARIANT_NOT_OF_PRODUCT' });
    }

    const defaultPrice = numField(requireField(body, 'default_selling_price', 'The price per piece'), { field: 'The price per piece', min: 0 });
    // `null` is how a level is cleared: a shop may price per piece and not carry a
    // carton price at all, and pricing falls back to per-base × the carton factor.
    const packPrice = body.pack_price == null || body.pack_price === '' ? null : numField(body.pack_price, { field: 'The pack price', min: 0 });
    const cartonPrice = body.carton_price == null || body.carton_price === '' ? null : numField(body.carton_price, { field: 'The carton price', min: 0 });

    // ONE ROW PER (branch, product, variant). The table's UNIQUE constraint cannot
    // enforce this on its own, because SQLite treats NULLs as distinct — so two
    // rows for the same branch and product, both with a NULL variant, are
    // perfectly legal to the engine and ambiguous to the price resolver. The
    // lookup has to name the NULL case explicitly, exactly as the price-list item
    // route does.
    // ORDERED, and read as one row. The UNIQUE constraint cannot police the NULL
    // variant (SQLite counts NULLs as distinct), so a database that predates this
    // code could hold two rows for the same branch and product. Ordering by the
    // newest decision makes that case resolve to the price somebody set last —
    // which is the answer a shopkeeper would give — instead of whichever row the
    // planner happened to return first.
    const existing = await db.first(`SELECT * FROM product_price_overrides
      WHERE branch_id = ? AND product_id = ? AND is_deleted = 0
        AND ((? IS NULL AND variant_id IS NULL) OR variant_id = ?)
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    [String(branch.id), id, variantId, variantId]);

    const overrideId = existing ? existing.id : newId();
    if (existing) {
      await db.run(`UPDATE product_price_overrides
          SET default_selling_price = ?, pack_price = ?, carton_price = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = ?`, [round2(defaultPrice), packPrice, cartonPrice, String(user.id), overrideId]);
    } else {
      await db.run(`INSERT INTO product_price_overrides
          (id, branch_id, product_id, variant_id, default_selling_price, pack_price, carton_price, updated_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
      [overrideId, String(branch.id), id, variantId, round2(defaultPrice), packPrice, cartonPrice, String(user.id)]);
    }

    // A price below what the goods cost is legal — clearance, a loss leader, a
    // mistake somebody will want pointed out. It is reported, not refused: a shop
    // that cannot sell at a loss cannot clear a line, and a system that refuses
    // gets worked around instead of trusted.
    const cost = Number(product.cost_price) || 0;
    const warnings = [];
    if (cost > 0 && round2(defaultPrice) < round2(cost)) {
      warnings.push(`This is below the cost of ₦${round2(cost).toLocaleString('en-NG')} — every ${product.base_unit_name || 'unit'} sold at this branch loses money.`);
    }
    if (cartonPrice != null) {
      const cartonUnit = await db.first("SELECT quantity_in_base FROM product_units WHERE product_id = ? AND code IN ('CARTON','PACK') AND is_deleted = 0 ORDER BY quantity_in_base DESC LIMIT 1", [id]);
      const factor = cartonUnit ? Number(cartonUnit.quantity_in_base) : 0;
      if (factor > 1 && round2(cartonPrice) < round2(defaultPrice * factor)) {
        warnings.push(`The carton price is below ${factor} × the piece price (${(round2(defaultPrice * factor)).toLocaleString('en-NG')}) — buying by the carton would be cheaper than by the piece, which is usually backwards.`);
      }
    }

    await recordFromCtx(ctx, {
      action: existing ? 'PRICE_OVERRIDE_CHANGED' : 'PRICE_OVERRIDE_SET',
      entityType: 'PRICE_OVERRIDE', entityId: overrideId, branchId: branch.id, businessId: branch.business_id,
      before: existing ? { perPiece: existing.default_selling_price, pack: existing.pack_price, carton: existing.carton_price } : null,
      after: { product: product.name, branch: branch.name, variantId, perPiece: round2(defaultPrice), pack: packPrice, carton: cartonPrice },
    });

    ctx.json({
      ok: true,
      id: overrideId,
      replaced: Boolean(existing),
      warnings,
      message: `${product.name} now prices at ₦${round2(defaultPrice).toLocaleString('en-NG')} per ${(product.base_unit_name || 'unit').toLowerCase()} in ${branch.name}${packPrice != null ? ` · pack ₦${round2(packPrice).toLocaleString('en-NG')}` : ''}${cartonPrice != null ? ` · carton ₦${round2(cartonPrice).toLocaleString('en-NG')}` : ''}.`,
    }, existing ? 200 : 201);
  });

  /** Clear an override: the product's own price applies in this branch again. */
  app.delete(`${base}/products/:id/price-override`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const allowed = canEditPrices(ctx.get('settings'), ctx.get('user'));
    if (!allowed.allowed) throw new HttpError(allowed.reason, { status: 403, code: 'PRICE_EDIT_NOT_ALLOWED' });

    const id = String(ctx.req.param('id'));
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [id]);
    if (!product) throw new HttpError('That product does not exist, or has been deleted.', { status: 404, code: 'PRODUCT_NOT_FOUND' });
    const branch = await resolveBranch(db, ctx, { required: true });
    const variantId = ctx.req.queryParam('variant_id') ? String(ctx.req.queryParam('variant_id')) : null;

    const existing = await db.first(`SELECT * FROM product_price_overrides
      WHERE branch_id = ? AND product_id = ? AND is_deleted = 0
        AND ((? IS NULL AND variant_id IS NULL) OR variant_id = ?)
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    [String(branch.id), id, variantId, variantId]);
    if (!existing) {
      throw new HttpError(`${product.name} has no branch price in ${branch.name} — it sells at the catalogue price there already.`, { status: 404, code: 'NO_OVERRIDE' });
    }

    // Soft delete, like every other mutable row: the audit below says who removed
    // it, and the row itself still exists if anybody asks what the price used to be.
    await db.run("UPDATE product_price_overrides SET is_deleted = 1, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
      [String(ctx.get('user').id), existing.id]);
    await recordFromCtx(ctx, {
      action: 'PRICE_OVERRIDE_REMOVED', entityType: 'PRICE_OVERRIDE', entityId: existing.id,
      branchId: branch.id, businessId: branch.business_id,
      before: { perPiece: existing.default_selling_price, pack: existing.pack_price, carton: existing.carton_price, branch: branch.name },
    });
    ctx.json({ ok: true, message: `${product.name} now sells at the catalogue price in ${branch.name} again (₦${round2(product.selling_price).toLocaleString('en-NG')} per ${(product.base_unit_name || 'unit').toLowerCase()}).` });
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
    refuseForeignModule(business, fields);

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
    if (fields.dispensing_class || fields.is_controlled) {
      await db.run(
        `UPDATE products SET dispensing_class = ?, is_controlled = ?, updated_at = datetime('now') WHERE id = ?`,
        [fields.dispensing_class || null, fields.is_controlled ? 1 : 0, id],
      );
    }

    // Every product gets a base unit, or it cannot be sold: the sale engine
    // refuses a product with no ladder rather than guessing one.
    const ladder = Array.isArray(body.units) && body.units.length ? body.units : [{ code: 'PIECE', name: fields.base_unit_name || 'Piece', quantityInBase: 1, isDefaultSell: true }];
    const check = validateLadder(ladder);
    // `levels`, NOT `ladder`. validateLadder returns the normalised rows under `levels`
    // while buildLadder — the other function in domain/uom.js, whose result every other
    // caller in this codebase reads — returns `{ ladder, base, ... }`. Reading the wrong
    // key here threw "check.ladder is not iterable" on EVERY attempt to create or edit a
    // product, after the product row had already been inserted: the catalogue could not be
    // written from the app at all, and each failure left behind a product with no unit
    // ladder, which can never be sold. Found by T4c.
    if (!check.ok) {
      // Roll the product back rather than leave a row that cannot be sold.
      await db.run('UPDATE products SET is_deleted = 1 WHERE id = ?', [id]);
      throw new HttpError(check.error, { status: 400, code: check.code, fields: { units: check.error } });
    }
    for (const level of check.levels) {
      await db.run(`INSERT INTO product_units (id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
      [newId(), id, level.level, level.code, level.name, level.pluralName, level.quantityInBase, level.isSellable ? 1 : 0, level.isDefaultSell ? 1 : 0]);
    }

    // A shelf barcode is assigned even when the form left it blank. The seeded
    // catalogue already has one on every row; a product added later must too,
    // or the USB scanner at the till has nothing to read.
    let assigned = { barcode: null, id: null, unitCode: check.levels[0].code, warning: null };
    try {
      assigned = await assignShelfBarcode(db, {
        productId: id,
        unitCode: check.levels[0].code,
        supplied: body.barcode,
        seed: fields.sku || fields.name,
      });
    } catch (err) {
      assigned.warning = 'A shelf barcode could not be assigned. The product is still in the catalogue and can be found by name.';
    }

    await recordFromCtx(ctx, {
      action: 'PRODUCT_CREATED', entityType: 'PRODUCT', entityId: id, branchId: branch ? branch.id : null, businessId: business.id,
      after: { name: fields.name, sku: fields.sku, selling_price: fields.selling_price, barcode: assigned.barcode || undefined, belowCost: belowCost || undefined },
    });
    ctx.json({
      ok: true, id,
      barcode: assigned.barcode,
      barcodeId: assigned.id,
      barcodeUnit: assigned.unitCode,
      message: `“${fields.name}” added to the catalogue.${assigned.barcode ? ` Shelf barcode ${assigned.barcode}.` : ''}${belowCost ? ' Note: it is priced below cost.' : ''}`,
      warning: assigned.warning || null,
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
    if (!before.business_id && (fields.offers_hire || fields.offers_lease || fields.hire_price_per_day || fields.lease_price_per_month)) {
      throw new HttpError('The shared market list is not priced and is not for hire. Copy the product into this business before setting a hire or a lease.', { status: 400, code: 'SHARED_GOODS_NOT_HIREABLE' });
    }
    if (!before.business_id && (fields.dispensing_class || fields.is_controlled)) {
      throw new HttpError('The shared market list is not a dispensary. Copy the product into this business before marking it as a medicine.', { status: 400, code: 'SHARED_GOODS_NOT_DISPENSABLE' });
    }
    if (before.business_id) {
      const owner = await db.first('SELECT * FROM businesses WHERE id = ? AND is_deleted = 0', [String(before.business_id)]);
      refuseForeignModule(owner, fields);
    }
    const priceChanged = fields.selling_price !== undefined && round2(Number(fields.selling_price)) !== round2(Number(before.selling_price));
    if (priceChanged) {
      const allowed = canEditPrices(ctx.get('settings'), ctx.get('user'));
      if (!allowed.allowed) throw new HttpError(allowed.reason, { status: 403, code: 'PRICE_EDIT_NOT_ALLOWED' });
    }

    if (Object.prototype.hasOwnProperty.call(fields, 'category_id')) {
      const nextCategory = fields.category_id || null;
      const prevCategory = before.category_id || null;
      if (String(nextCategory || '') !== String(prevCategory || '')) {
        if (!canOrganizeCatalogue(ctx.get('user'))) {
          throw new HttpError('Only the owner or a general manager can move a product to another category.', { status: 403, code: 'ROLE_REQUIRED' });
        }
        if (!before.business_id) {
          throw new HttpError('The shared market list is not filed under a shop category. Copy the product into this business first.', { status: 400, code: 'SHARED_GOODS' });
        }
        if (nextCategory) {
          const category = await db.first(
            'SELECT id, business_id, name FROM product_categories WHERE id = ? AND is_deleted = 0',
            [String(nextCategory)],
          );
          if (!category || String(category.business_id || '') !== String(before.business_id)) {
            throw new HttpError('That category is not on this business.', { status: 400, code: 'BAD_CATEGORY' });
          }
        }
      }
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
      for (const level of check.levels) {
        // REVIVE THE ROW, DO NOT BLIND-INSERT BESIDE IT. `product_units` carries
        // UNIQUE (product_id, code) as a TABLE constraint — not an index filtered on
        // is_deleted — so the row soft-deleted a line above still occupies the code.
        // A blind INSERT here answered 409 DUPLICATE for EVERY ladder replacement,
        // and every ladder keeps PIECE (the first level must be exactly 1 base unit),
        // so a product's units could never be edited at all. Found by the catalogue
        // write probe in T4c, after the same trap was found and fixed in two other
        // places: the price-override route below and the business-access grant in
        // admin.js both revive-or-insert for exactly this reason.
        await db.run(`INSERT INTO product_units (id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at, is_deleted)
                      VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'), 0)
                      ON CONFLICT(product_id, code) DO UPDATE SET
                        level = excluded.level, name = excluded.name, plural_name = excluded.plural_name,
                        quantity_in_base = excluded.quantity_in_base, is_sellable = excluded.is_sellable,
                        is_default_sell = excluded.is_default_sell, updated_at = datetime('now'), is_deleted = 0`,
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
    const rawCode = ctx.req.queryParam('code') || ctx.req.queryParam('barcode') || '';
    const candidates = scanCandidates(rawCode);
    const code = candidates[0] || '';
    if (!code) throw new HttpError('Pass ?code= with the scanned value.', { status: 400, code: 'MISSING_FIELD' });
    const forSale = ctx.req.queryParam('for_sale') === '1';
    const branch = await resolveBranch(db, ctx);

    // Exact match first. A LIKE search on a scan would let a damaged barcode
    // that reads as a prefix of another product silently sell the wrong item.
    // A USB wedge may prefix an AIM identifier or drop the leading zero of a
    // UPC, so each cleaned candidate is tried, never a prefix match.
    let hit = null;
    for (const candidate of candidates) {
      hit = await db.first(`
        SELECT p.*, pb.unit_code AS scanned_unit, pb.variant_id AS barcode_variant_id, pb.label AS barcode_label,
               c.name AS category_name
        FROM product_barcodes pb
        JOIN products p ON p.id = pb.product_id AND p.is_deleted = 0 AND p.is_active = 1
        LEFT JOIN product_categories c ON c.id = p.category_id
        WHERE pb.barcode = ? AND pb.is_deleted = 0`, [candidate]);
      if (hit) break;
    }
    if (!hit) {
      for (const candidate of candidates) {
        hit = await db.first(`
          SELECT p.*, c.name AS category_name
          FROM products p
          LEFT JOIN product_categories c ON c.id = p.category_id
          WHERE p.barcode = ? AND p.is_deleted = 0 AND p.is_active = 1
          LIMIT 1`, [candidate]);
        if (hit) {
          hit.scanned_unit = null;
          hit.barcode_variant_id = null;
          break;
        }
      }
    }

    if (!hit) {
      // Fall back to SKU, because a lot of Nigerian stock arrives with the
      // shop's own printed label rather than a manufacturer barcode, and the
      // cashier types the SKU into the same field.
      // The shared market row and the shop's own copy can share a SKU. The
      // shop's row wins, or a scan sells the unpriced master instead of the
      // good this branch priced.
      const scanBiz = branch && branch.business_id ? String(branch.business_id) : null;
      let bySku = null;
      for (const candidate of candidates) {
        const sku = candidate.toUpperCase();
        bySku = await db.first(`SELECT p.*, c.name AS category_name FROM products p
          LEFT JOIN product_categories c ON c.id = p.category_id
          WHERE (p.sku = ? OR p.registration_no = ?) AND p.is_deleted = 0 AND p.is_active = 1
            ${scanBiz ? 'AND (p.business_id IS NULL OR p.business_id = ?)' : ''}
          ORDER BY (p.business_id IS NULL) ASC
          LIMIT 1`, scanBiz ? [sku, sku, scanBiz] : [sku, sku]);
        if (bySku) break;
      }
      if (!bySku) throw new HttpError(`Nothing in your catalogue matches “${code}”. Check the barcode, or add the product under Products.`, { status: 404, code: 'SCAN_NOT_FOUND' });
      if (forSale) await assertSellable(db, bySku.id, branch.id, bySku.name);
      return ctx.json({ ok: true, matchedBy: 'SKU', ...(await productPayload(db, bySku, branch, scope, null, null, { sellableOnly: forSale })) });
    }

    const scopeCheck = scopeFilter(scope, { alias: 'p' });
    if (scopeCheck.sql) {
      const allowed = await db.first(`SELECT p.id FROM products p WHERE p.id = ? AND ${scopeCheck.sql}`, [hit.id, ...scopeCheck.params]);
      if (!allowed) throw new HttpError('That product belongs to a different business.', { status: 403, code: 'SCOPE_VIOLATION' });
    }
    if (forSale) await assertSellable(db, hit.id, branch.id, hit.name);
    ctx.json({ ok: true, matchedBy: 'BARCODE', ...(await productPayload(db, hit, branch, scope, hit.scanned_unit, hit.barcode_variant_id, { sellableOnly: forSale })) });
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
    // One "Rice" in the dropdown. The shared market category stays until a shop
    // the caller can see has its own category with the same code.
    const ownerIds = businessId ? [String(businessId)] : (scope.businessIds ? [...scope.businessIds] : null);
    if (ownerIds && ownerIds.length) {
      where.push(`NOT (c.business_id IS NULL AND EXISTS (
        SELECT 1 FROM product_categories own
        WHERE own.is_deleted = 0 AND own.code = c.code
          AND own.business_id IN (${ownerIds.map(() => '?').join(',')})
      ))`);
      params.push(...ownerIds);
    } else if (!scope.businessIds) {
      where.push(`NOT (c.business_id IS NULL AND EXISTS (
        SELECT 1 FROM product_categories own
        WHERE own.is_deleted = 0 AND own.code = c.code
          AND own.business_id IS NOT NULL
      ))`);
    }
    if (businessId) {
      const focused = await db.first(
        'SELECT profile_code, profile_overrides_json FROM businesses WHERE id = ? AND is_deleted = 0',
        [String(businessId)],
      );
      if (focused && modulesOfBusiness(focused).nafdac) await fileGreenbook(db, String(businessId));
    }
    const countBusiness = businessId ? String(businessId) : null;
    const countSql = countBusiness
      ? `(SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_deleted = 0 AND (p.business_id = ? OR p.business_id IS NULL))`
      : `(SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_deleted = 0)`;
    const nafdacSql = countBusiness
      ? `(SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_deleted = 0 AND p.nafdac_catalog_id IS NOT NULL AND (p.business_id = ? OR p.business_id IS NULL))`
      : `(SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_deleted = 0 AND p.nafdac_catalog_id IS NOT NULL)`;
    const countParams = countBusiness ? [countBusiness, countBusiness] : [];
    const rows = await db.all(
      `SELECT c.*, ${countSql} AS product_count, ${nafdacSql} AS nafdac_count
         FROM product_categories c WHERE ${where.join(' AND ')} ORDER BY c.name COLLATE NOCASE, c.code`,
      [...countParams, ...params],
    );
    const previews = new Map();
    let unfiled = { product_count: 0, products: [] };
    if (countBusiness) {
      const listed = await db.all(
        `SELECT category_id, id, name, sku, brand FROM (
           SELECT p.category_id, p.id, p.name, p.sku, p.brand,
                  ROW_NUMBER() OVER (PARTITION BY p.category_id ORDER BY LOWER(p.name), p.id) AS rn
             FROM products p
            WHERE p.is_deleted = 0 AND p.category_id IS NOT NULL
              AND (p.business_id = ? OR p.business_id IS NULL)
         ) WHERE rn <= 8`,
        [countBusiness],
      );
      for (const product of listed) {
        const key = String(product.category_id);
        const list = previews.get(key) || [];
        list.push({ id: product.id, name: product.name, sku: product.sku, brand: product.brand });
        previews.set(key, list);
      }
      const unfiledCount = await db.scalar(
        `SELECT COUNT(*) FROM products WHERE is_deleted = 0 AND category_id IS NULL AND business_id = ?`,
        [countBusiness],
      );
      const unfiledRows = await db.all(
        `SELECT id, name, sku, brand FROM products
          WHERE is_deleted = 0 AND category_id IS NULL AND business_id = ?
          ORDER BY LOWER(name) LIMIT 8`,
        [countBusiness],
      );
      unfiled = { product_count: Number(unfiledCount) || 0, products: unfiledRows };
    }
    ctx.json({
      ok: true,
      data: rows.map((row) => {
        const pharma = Number(row.nafdac_count) > 0 || selling.sellingGroup({ code: row.code }).code === 'PHARMACEUTICALS';
        return {
          ...row,
          product_count: Number(row.product_count) || 0,
          selling_group: pharma ? 'PHARMACEUTICALS' : 'NON_PHARMACEUTICALS',
          products: previews.get(String(row.id)) || [],
        };
      }),
      unfiled,
    });
  });

  app.put(`${base}/categories/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!canOrganizeCatalogue(user)) {
      throw new HttpError('Only the owner or a general manager can rename a category.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const id = String(ctx.req.param('id'));
    const before = await db.first('SELECT * FROM product_categories WHERE id = ? AND is_deleted = 0', [id]);
    if (!before) throw new HttpError('That category does not exist.', { status: 404, code: 'CATEGORY_NOT_FOUND' });
    if (!before.business_id) {
      throw new HttpError('The shared market categories are not renamed from a shop. Add a category on this business instead.', { status: 400, code: 'SHARED_CATEGORY' });
    }
    const body = await ctx.req.json();
    const name = strField(requireField(body, 'name', 'Category name'), { field: 'Category name', maxLength: 120, required: true });
    if (!name || name.length < 2) throw new HttpError('A category needs a name of at least two characters.', { status: 400, code: 'CATEGORY_NAME' });
    if (String(name).toLowerCase() === String(before.name).toLowerCase()) {
      ctx.json({ ok: true, id, name: before.name, message: `“${before.name}” is already called that.` });
      return;
    }
    const dupe = await db.first(
      `SELECT id FROM product_categories
        WHERE business_id = ? AND is_deleted = 0 AND id <> ? AND lower(name) = lower(?)`,
      [String(before.business_id), id, name],
    );
    if (dupe) throw new HttpError(`“${name}” is already a category on this business. Move products into that one instead of giving two categories the same name.`, { status: 409, code: 'DUPLICATE_CATEGORY' });
    const held = await db.scalar(
      'SELECT COUNT(*) FROM products WHERE category_id = ? AND is_deleted = 0',
      [id],
    );
    await db.run(
      `UPDATE product_categories SET name = ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`,
      [name, id],
    );
    await fileCategoriesAlphabetically(db, before.business_id);
    await recordFromCtx(ctx, {
      action: 'CATEGORY_UPDATED', entityType: 'CATEGORY', entityId: id, businessId: before.business_id,
      before: { name: before.name }, after: { name, products: Number(held) || 0 },
    });
    ctx.json({
      ok: true,
      id,
      name,
      product_count: Number(held) || 0,
      message: Number(held)
        ? `“${before.name}” is now “${name}”. ${Number(held)} product${Number(held) === 1 ? '' : 's'} stay in it.`
        : `“${before.name}” is now “${name}”.`,
    });
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
    const cleanName = String(name).slice(0, 120);
    await db.run(`INSERT INTO product_categories (id, business_id, code, name, parent_id, sort_order, is_active, created_at, updated_at)
                  VALUES (?,?,?,?,?,0,1, datetime('now'), datetime('now'))`,
    [id, String(business.id), code, cleanName, body.parent_id ? String(body.parent_id) : null]);
    const filed = await fileCategoriesAlphabetically(db, business.id);
    const index = filed.findIndex((row) => row.id === id);
    const before = index > 0 ? filed[index - 1].name : null;
    const after = index >= 0 && index < filed.length - 1 ? filed[index + 1].name : null;
    const message = before && after
      ? `“${cleanName}” filed alphabetically, after ${before} and before ${after}.`
      : before
        ? `“${cleanName}” filed alphabetically, after ${before}.`
        : after
          ? `“${cleanName}” filed alphabetically, before ${after}.`
          : `“${cleanName}” is the first category on this business.`;
    await recordFromCtx(ctx, { action: 'CATEGORY_CREATED', entityType: 'CATEGORY', entityId: id, businessId: business.id, after: { code, name: cleanName } });
    ctx.json({ ok: true, id, code, name: cleanName, before, after, message }, 201);
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
   * product are how "5+ cartons at NGN X, 20+ at NGN Y" is expressed, and the sale
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
    // `getProfile` answers null for a code we do not have (it used to fall back to
    // GENERAL_RETAIL, which made the line below dead code), so this route now
    // actually 404s as it always intended to.
    const known = getProfile(code);
    if (!known) {
      throw new HttpError(`“${code}” is not a business vertical this system has. It has: ${PROFILE_CODES.join(', ')}.`, { status: 404, code: 'UNKNOWN_PROFILE' });
    }
    const profile = resolveProfile(code, overrides);
    ctx.json({ ok: true, ...describeProfile(profile) });
  });

  // -------------------------------------------------------------------
  // SUPPLIERS
  // -------------------------------------------------------------------
  app.get(`${base}/suppliers`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const { limit, offset } = pagination(ctx);
    const search = searchTerm(ctx);
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

  // -------------------------------------------------------------------
  // NIGERIAN MARKET — an inbuilt list, with no prices
  // -------------------------------------------------------------------
  // The list lives in the application, not in the shop's rows. A till that
  // searched two thousand unpriced goods would sell them at nothing. Adding
  // one copies it into THIS business, still with no price, and with serial
  // numbers off unless the person turning the switch said otherwise.
  app.get(`${base}/market-catalogue`, async (ctx) => {
    const page = market.search({
      q: searchTerm(ctx),
      category: ctx.req.queryParam('category') || '',
      limit: Math.min(pagination(ctx).limit, 80),
      offset: pagination(ctx).offset,
    });
    ctx.json({
      ok: true,
      data: page.data,
      categories: market.categories(),
      paging: { total: page.total, limit: page.limit, offset: page.offset },
      prices: false,
      count: market.ITEMS.length,
      note: 'No prices. Set a price after you add the item. A serial number stays off until you turn it on for that product.',
    });
  });

  app.post(`${base}/market-catalogue/adopt`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can add goods from the Nigerian market.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx, { required: false });
    const business = await resolveBusiness(db, ctx, branch || undefined);
    const raw = Array.isArray(body.items) ? body.items : (Array.isArray(body.skus) ? body.skus.map((sku) => ({ sku, serial: body.serial })) : []);
    if (!raw.length) throw new HttpError('Choose at least one item to add.', { status: 400, code: 'MISSING_FIELD', fields: { items: 'Required.' } });
    if (raw.length > 40) throw new HttpError('Add up to 40 items at a time.', { status: 400, code: 'TOO_MANY', fields: { items: '40 at a time.' } });

    const existing = await db.all('SELECT sku FROM products WHERE business_id = ? AND is_deleted = 0 AND sku IS NOT NULL', [String(business.id)]);
    const have = new Set(existing.map((r) => String(r.sku).toUpperCase()));
    const cats = await db.all('SELECT id, code FROM product_categories WHERE business_id = ? AND is_deleted = 0', [String(business.id)]);
    const catByCode = new Map(cats.map((c) => [String(c.code), c.id]));

    const added = [];
    const already = [];
    const missing = [];
    for (const row of raw) {
      const sku = String((row && row.sku) || row || '').trim().toUpperCase();
      const item = market.get(sku);
      if (!item) { missing.push(sku || '(blank)'); continue; }
      if (have.has(item.sku)) { already.push(item.sku); continue; }
      let categoryId = catByCode.get(item.category) || null;
      if (!categoryId) {
        categoryId = newId();
        const name = market.categoryName(item.category);
        await db.run(`INSERT INTO product_categories (id, business_id, code, name, sort_order, is_active, created_at, updated_at)
                      VALUES (?,?,?,?,?,1, datetime('now'), datetime('now'))`,
        [categoryId, String(business.id), item.category, name, catByCode.size]);
        catByCode.set(item.category, categoryId);
      }
      const unit = market.UNITS[item.unit];
      const ladder = validateLadder([{ code: unit.code, name: unit.name, pluralName: unit.plural, quantityInBase: 1, isDefaultSell: true }]);
      if (!ladder.ok) throw new HttpError(ladder.error, { status: 500, code: ladder.code });
      const id = newId();
      const serial = boolField(row && row.serial, 0);
      await db.run(`INSERT INTO products (
          id, business_id, category_id, sku, name, brand,
          requires_serial, tracks_variants, warranty_months, is_bulky, requires_installation,
          has_expiry, is_age_restricted, is_fragile, is_returnable, return_window_days,
          base_unit_name, cost_price, selling_price, reorder_level, reorder_quantity,
          valuation_method, is_active, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,0,0,0,0,?,?,0,1,7,?,0,0,0,0,'WEIGHTED_AVG',1,?, datetime('now'), datetime('now'))`, [
        id, String(business.id), categoryId, item.sku, item.name, item.brand,
        serial,
        item.expiry ? 1 : 0, item.ageRestricted ? 1 : 0,
        unit.name.toLowerCase(), String(user.id),
      ]);
      const level = ladder.levels[0];
      await db.run(`INSERT INTO product_units (id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
      [newId(), id, level.level, level.code, level.name, level.pluralName, level.quantityInBase, 1, 1]);
      have.add(item.sku);
      let shelf = null;
      try {
        shelf = await assignShelfBarcode(db, { productId: id, unitCode: level.code, seed: item.sku || item.name });
      } catch (err) { shelf = null; }
      added.push({ id, sku: item.sku, name: item.name, requires_serial: serial, barcode: shelf && shelf.barcode });
    }
    if (!added.length && !already.length) {
      throw new HttpError('None of those items are in the Nigerian market list.', { status: 400, code: 'NOT_IN_MARKET', fields: { items: missing.join(', ') } });
    }
    await recordFromCtx(ctx, {
      action: 'PRODUCT_CREATED', entityType: 'PRODUCT', entityId: added[0] ? added[0].id : null,
      businessId: business.id,
      after: { source: 'nigerian-market', added: added.map((a) => a.sku), already, missing },
    });
    const n = added.length;
    ctx.json({
      ok: true,
      added, already, missing,
      prices: false,
      message: n
        ? `Added ${n} from the Nigerian market. No price yet — set a price before selling.${already.length ? ` ${already.length} already in the catalogue.` : ''}`
        : `Already in the catalogue.${missing.length ? ` ${missing.length} not in the market list.` : ''}`,
    }, n ? 201 : 200);
  });

  // -------------------------------------------------------------------
  // NAFDAC GREENBOOK — reference rows, not shop stock
  // -------------------------------------------------------------------
  app.get(`${base}/nafdac`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await requireModule(db, ctx, 'nafdac', 'The NAFDAC Greenbook is only for a pharmaceutical business.');
    const q = String(ctx.req.queryParam('q') || '').trim().toLowerCase();
    if (q.length < 2) throw new HttpError('Type at least two characters of a name, an ingredient, or a NAFDAC number.', { status: 400, code: 'QUERY_TOO_SHORT' });
    const limit = Math.min(50, Math.max(1, Number(ctx.req.queryParam('limit')) || 20));
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const rows = await db.all(
      `SELECT n.id, n.nafdac_reg_no, n.product_name, n.ingredient_name, n.strength, n.dosage_form, n.manufacturer,
              n.pack_size, n.category, n.base_unit, n.is_controlled, n.dispensing_type, n.registration_expiry,
              (SELECT p.id FROM products p
                WHERE p.business_id = ? AND p.nafdac_catalog_id = n.id AND p.is_deleted = 0
                ORDER BY p.id LIMIT 1) AS adopted_id
         FROM nafdac_catalog n
        WHERE n.search_blob LIKE ? OR lower(n.nafdac_reg_no) LIKE ? OR lower(n.product_name) LIKE ?
        ORDER BY n.product_name COLLATE NOCASE, n.id
        LIMIT ?`,
      [String(business.id), like, like, like, limit],
    );
    ctx.json({ ok: true, data: rows, count: rows.length });
  });

  app.post(`${base}/nafdac/:id/adopt`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json().catch(() => ({}));
    const business = await requireModule(db, ctx, 'nafdac', 'The NAFDAC Greenbook is only for a pharmaceutical business.');
    const catalogId = Number(ctx.req.param('id'));
    const row = await db.first('SELECT * FROM nafdac_catalog WHERE id = ?', [catalogId]);
    if (!row) throw new HttpError('That Greenbook row does not exist.', { status: 404, code: 'NAFDAC_NOT_FOUND' });
    const existing = await db.first(
      'SELECT id, name, sku FROM products WHERE business_id = ? AND nafdac_catalog_id = ? AND is_deleted = 0 ORDER BY id LIMIT 1',
      [String(business.id), catalogId],
    );
    if (existing) {
      ctx.json({ ok: true, id: existing.id, already: true, message: `${existing.name} is already in this catalogue.` });
      return;
    }
    // A purchase order needs the row in this shop before it can name it.
    // The selling price is still unknown then. Ordering must not invent one,
    // and it must not put the row on the shared market list.
    const forOrder = Boolean(boolField(body.for_order));
    const price = body.selling_price == null || body.selling_price === ''
      ? 0
      : numField(body.selling_price, { field: 'Selling price', min: 0 });
    const cost = body.cost_price == null || body.cost_price === '' ? 0 : numField(body.cost_price, { field: 'Cost price', min: 0 });
    if (!forOrder && !(price > 0)) throw new HttpError('Set a selling price when you copy a Greenbook row. The Greenbook itself is not priced.', { status: 400, code: 'PRICE_REQUIRED' });
    const name = strField(body.name, { field: 'Name', maxLength: 200 }) || row.product_name;
    const brand = body.brand === undefined ? (row.manufacturer || null) : strField(body.brand, { field: 'Brand', maxLength: 120 });
    const categoryId = body.category_id ? String(body.category_id) : null;
    if (categoryId) {
      const category = await db.first(
        'SELECT id FROM product_categories WHERE id = ? AND business_id = ? AND is_deleted = 0',
        [categoryId, String(business.id)],
      );
      if (!category) throw new HttpError('That category is not on this business.', { status: 400, code: 'BAD_CATEGORY' });
    }
    const id = newId();
    const suggested = `NAF-${String(row.nafdac_reg_no || 'ROW').replace(/[^A-Za-z0-9]+/g, '').slice(0, 16)}-${catalogId}`.slice(0, 40);
    const sku = body.sku ? String(body.sku).toUpperCase().replace(/\s+/g, '').slice(0, 40) : suggested;
    const clash = await db.first(
      'SELECT id FROM products WHERE business_id = ? AND sku = ? AND is_deleted = 0',
      [String(business.id), sku],
    );
    if (clash) throw new HttpError('That SKU is already in this catalogue. Leave it blank and one will be suggested.', { status: 409, code: 'SKU_TAKEN' });
    const dispensing = body.dispensing_class ? String(body.dispensing_class).toUpperCase() : (row.dispensing_type || 'OTC');
    if (!['OTC', 'POM'].includes(dispensing)) {
      throw new HttpError('A Greenbook row is either OTC or POM.', { status: 400, code: 'BAD_DISPENSING' });
    }
    await db.run(`INSERT INTO products (
        id, business_id, category_id, sku, name, brand, registration_no, base_unit_name,
        has_expiry, cost_price, selling_price, dispensing_class, is_controlled, nafdac_catalog_id,
        valuation_method, is_active, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,'WEIGHTED_AVG',1,?, datetime('now'), datetime('now'))`, [
      id, String(business.id), categoryId, sku, name, brand, row.nafdac_reg_no || null,
      row.base_unit || 'unit', round2(cost), round2(price),
      dispensing, Number(row.is_controlled) || Number(body.is_controlled) ? 1 : 0, catalogId, String(user.id),
    ]);
    await db.run(`INSERT INTO product_units (id, product_id, level, code, name, plural_name, quantity_in_base, is_sellable, is_default_sell, created_at, updated_at)
                  VALUES (?,?,0,?,?,?,1,1,1, datetime('now'), datetime('now'))`, [
      newId(), id, 'PIECE', row.base_unit || 'Piece', `${row.base_unit || 'Piece'}s`,
    ]);
    let shelf = { barcode: null, id: null, unitCode: 'PIECE', warning: null };
    try {
      shelf = await assignShelfBarcode(db, { productId: id, unitCode: 'PIECE', supplied: body.barcode, seed: sku || name });
    } catch (err) {
      shelf.warning = 'A shelf barcode could not be assigned.';
    }
    await recordFromCtx(ctx, {
      action: 'PRODUCT_CREATED', entityType: 'PRODUCT', entityId: id, businessId: business.id,
      after: { source: 'nafdac', nafdac_reg_no: row.nafdac_reg_no, name: row.product_name, barcode: shelf.barcode || undefined },
    });
    ctx.json({
      ok: true, id, name,
      barcode: shelf.barcode, barcodeId: shelf.id, barcodeUnit: shelf.unitCode,
      warning: shelf.warning,
      message: `${name} is in this catalogue.${shelf.barcode ? ` Shelf barcode ${shelf.barcode}.` : ''} It is not on the shared market list.`,
    }, 201);
  });

  app.get(`${base}/pharmacy/register`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    await requireModule(db, ctx, 'dispensing', 'The controlled register belongs to a dispensary. This business is not one.');
    const scope = ctx.get('scope');
    const scoped = scopeFilter(scope, { alias: 'r' });
    const where = ['r.is_deleted = 0'];
    const bind = [];
    if (scoped.sql) { where.push(scoped.sql); bind.push(...scoped.params); }
    const branchId = ctx.req.queryParam('branch_id');
    if (branchId) { where.push('r.branch_id = ?'); bind.push(String(branchId)); }
    const rows = await db.all(
      `SELECT r.*, p.name AS product_name, p.sku
         FROM controlled_substance_register r
         LEFT JOIN products p ON p.id = r.product_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 200`,
      bind,
    );
    ctx.json({ ok: true, data: rows, count: rows.length });
  });
}

/** The payload a POS scan needs: price, units, variants and stock at this branch. */
async function productPayload(db, product, branch, scope, scannedUnit = null, barcodeVariantId = null, options = {}) {
  const sellableOnly = Boolean(options && options.sellableOnly);
  // `measures`, NOT `measure`. This destructured the array as `measure` and then returned
  // `measures` twenty lines down, so EVERY call to productPayload threw
  // `ReferenceError: measures is not defined` — and both callers are the barcode scan at the
  // counter. The cashier's gun answered 500 for any code it recognised, while an UNKNOWN code
  // answered 404 from the branch above, so the one case that worked was the one that should
  // not: the scan that found nothing. Found by test/audit/audit.reference.js.
  const [units, variants, measures, stock, overrides, lists] = await Promise.all([
    db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [product.id]),
    db.all('SELECT * FROM product_variants WHERE product_id = ? AND is_deleted = 0 ORDER BY sort_order, name', [product.id]),
    // ALL of them, not an arbitrary one. A sofa is sold by the piece AND has a
    // packed weight; a cable is sold by the metre AND rolled. `UNIQUE
    // (product_id, axis)` means a product may legitimately carry several rows,
    // so `first()` here was picking whichever the planner happened to return.
    db.all('SELECT * FROM product_measures WHERE product_id = ? AND is_deleted = 0 ORDER BY axis', [product.id]),
    db.all(sellableOnly
      ? `SELECT sb.*, sb.quantity - sb.quantity_reserved AS available FROM stock_batches sb
      INNER JOIN purchase_orders po ON po.id = sb.purchase_order_id
        AND po.is_deleted = 0 AND po.status IN ('PARTIALLY_RECEIVED','RECEIVED')
      WHERE sb.product_id = ? AND sb.branch_id = ? AND sb.is_deleted = 0 AND sb.status = 'ACTIVE'
      ORDER BY sb.expiry_date IS NULL, sb.expiry_date, sb.received_at, sb.batch_no, sb.id`
      : `SELECT sb.*, sb.quantity - sb.quantity_reserved AS available FROM stock_batches sb
      WHERE sb.product_id = ? AND sb.branch_id = ? AND sb.is_deleted = 0 AND sb.status = 'ACTIVE'
      ORDER BY sb.expiry_date IS NULL, sb.expiry_date, sb.received_at, sb.batch_no, sb.id`, [product.id, branch.id]),
    db.all('SELECT * FROM product_price_overrides WHERE product_id = ? AND branch_id = ? AND is_deleted = 0', [product.id, branch.id]),
    db.all('SELECT * FROM price_lists WHERE is_deleted = 0 AND is_active = 1 AND (business_id = ? OR business_id IS NULL) ORDER BY priority DESC', [String(product.business_id)]),
  ]);

  const onHand = stock.reduce((a, s) => a + Math.max(0, Number(s.quantity) - Number(s.quantity_reserved)), 0);
  // A scan sells the product object the till already has. If that object's
  // catalogue price is 0, the till refuses before it looks at the batches
  // this payload also returns. Hand it the price this branch actually charges.
  const catalogue = Number(product.selling_price) || 0;
  let shopPrice = catalogue;
  if (!(shopPrice > 0)) {
    const ov = overrides.find((o) => !o.variant_id && Number(o.default_selling_price) > 0);
    if (ov) shopPrice = Number(ov.default_selling_price);
    else {
      const priced = stock.filter((s) => Number(s.selling_price_per_unit) > 0)
        .sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));
      if (priced.length) shopPrice = Number(priced[0].selling_price_per_unit);
    }
  }
  const pricedProduct = shopPrice > 0 && !(catalogue > 0)
    ? Object.assign({}, product, { selling_price: round2(shopPrice), catalogue_price: catalogue })
    : product;
  // The till reads on_hand off the product, not off the payload. A sale scan
  // must carry the received-order quantity, or the cart has no ceiling.
  const handed = sellableOnly
    ? Object.assign({}, pricedProduct, { on_hand: round2(onHand) })
    : pricedProduct;
  return {
    product: handed,
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

/**
 * The price this branch sells at, written onto selling_price for the till.
 * A catalogue price already set is left as the row stored it. An empty
 * catalogue uses this branch's override, then the latest batch price — the
 * figure typed when the goods were received. The shared market row is not
 * updated; only the list the shop is looking at.
 *
 * Chunked so a full page (the cap is 500) stays under D1's 100 bound parameters.
 */
async function applyShopPrices(db, rows, branchId) {
  if (!rows.length || !branchId) return rows;
  const branchPrice = new Map();
  const batchPrice = new Map();
  const ids = rows.map((r) => String(r.id));
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const marks = chunk.map(() => '?').join(',');
    const overrides = await db.all(
      `SELECT product_id, default_selling_price FROM product_price_overrides
        WHERE is_deleted = 0 AND variant_id IS NULL AND default_selling_price > 0 AND branch_id = ?
          AND product_id IN (${marks})
        ORDER BY updated_at DESC, rowid DESC`,
      [String(branchId), ...chunk],
    );
    for (const o of overrides) {
      if (!branchPrice.has(String(o.product_id))) branchPrice.set(String(o.product_id), Number(o.default_selling_price));
    }
    const batches = await db.all(
      `SELECT product_id, selling_price_per_unit FROM stock_batches
        WHERE is_deleted = 0 AND selling_price_per_unit > 0
          AND status NOT IN ('QUARANTINED','EXPIRED') AND branch_id = ?
          AND product_id IN (${marks})
        ORDER BY received_at DESC, id DESC`,
      [String(branchId), ...chunk],
    );
    for (const b of batches) {
      if (!batchPrice.has(String(b.product_id))) batchPrice.set(String(b.product_id), Number(b.selling_price_per_unit));
    }
  }
  return rows.map((r) => {
    const catalogue = Number(r.selling_price) || 0;
    if (catalogue > 0) return r;
    const shop = branchPrice.get(String(r.id)) || batchPrice.get(String(r.id)) || 0;
    if (!(shop > 0)) return r;
    return { ...r, catalogue_price: catalogue, selling_price: round2(shop) };
  });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = { mount, fileCategoriesAlphabetically };
