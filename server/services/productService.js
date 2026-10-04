// =====================================================================
// StockRidge — PRODUCTS, CATEGORIES, SUPPLIERS, BARCODES
// =====================================================================
// The catalogue is shared across branches of one business unit (one master
// product, per-branch pricing and per-branch batches) and is driven by the
// industry profile rather than by the schema.
//
// WHAT "PROFILE-DRIVEN" MEANS IN PRACTICE: a product's vertical-specific
// attributes (a phone's storage and IMEI prefix, a sofa's fabric and
// dimensions, cement's grade and bag weight) live in `attributes_json`,
// keyed by the profile's declared product_fields[].key. The schema therefore
// never grows a column per vertical, the product form renders itself from the
// profile, and adding a fifth vertical is a data change.
//
// WHAT IS STILL A REAL COLUMN: anything the system QUERIES, JOINS, INDEXES or
// ENFORCES. tracks_serials, tracks_expiry, tracks_warranty, base_unit, the
// packing ladder, reorder_level, valuation_method, tax_code — putting those
// in JSON would make every stock and tax report a full table scan with a JSON
// extract in the predicate. The line is: queried -> column, displayed -> JSON.
//
// SKU UNIQUENESS is per business unit and partial (only where sku IS NOT NULL
// and is_deleted = 0), so two businesses can both use "GEN-001" and a
// discontinued product does not block its own code from being reused.
// =====================================================================

const { newId, watNowIso } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const V = require('../../shared/validation');
const U = require('../../shared/units');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess, assertRole } = require('../lib/roles');
const { capabilitiesOf, itemCapabilities, sellingUnitsFor, profileOf } = require('../lib/capabilities');
const { assertCanCreateProduct, getUnitSettings, staffAllowance } = require('../lib/planLimits');
const { PROFILES, BASE_UNITS } = require('../../shared/industryProfiles');

// ---------------------------------------------------------------------
// PRODUCTS
// ---------------------------------------------------------------------
async function create(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  await assertCanCreateProduct(db, businessUnitId, ctx.user);

  const profile = profileOf(settings);
  const caps = capabilitiesOf(settings);

  const name = V.required(V.cleanProductName(input.name), { field: 'Product name', max: V.LIMITS.NAME });
  if (name && name.error) throw new HttpError(400, name.error, 'VALIDATION_FAILED');
  if (name.length < 2) throw new HttpError(400, 'A product name of one character cannot be searched for reliably.', 'PRODUCT_NAME_TOO_SHORT');

  // Category. Optional, but an uncategorised product cannot appear in a
  // category P&L, and a business with 400 uncategorised products has no idea
  // which of its four departments makes money.
  let category = null;
  if (input.category_id) {
    category = await db.prepare('SELECT * FROM product_categories WHERE id = ? AND business_unit_id = ? AND is_deleted = 0').bind(input.category_id, businessUnitId).first();
    if (!category) throw new HttpError(404, 'That category was not found for this business.', 'CATEGORY_NOT_FOUND');
  }

  const baseUnit = V.oneOf(input.base_unit || (category && category.default_base_unit) || (profile && profile.base_unit_default) || 'PIECE',
    BASE_UNITS.map((u) => u.code), { field: 'Base unit' });
  if (baseUnit && baseUnit.error) throw new HttpError(400, baseUnit.error, 'VALIDATION_FAILED');

  const packing = U.validatePacking({
    units_per_pack: input.units_per_pack,
    packs_per_carton: input.packs_per_carton,
    cartons_per_pallet: input.cartons_per_pallet,
  });
  if (!packing.ok) throw new HttpError(400, packing.error, packing.code);

  // Selling rungs must be a subset of what the profile allows AND consistent
  // with the packing actually configured. Declaring "CARTON" with no
  // packs_per_carton is a product that cannot be sold by the carton, and the
  // failure would surface at the counter rather than here.
  const allowedRungs = (profile && profile.selling_units) || ['BASE_UNIT', 'PACK'];
  const requestedRungs = Array.isArray(input.selling_units) && input.selling_units.length
    ? input.selling_units.map((s) => String(s).trim().toUpperCase())
    : ['BASE_UNIT'];
  for (const r of requestedRungs) {
    if (!U.isSellingUnit(r)) throw new HttpError(400, `Selling unit must be one of: ${U.SELLING_UNITS.join(', ')}.`, 'SELLING_UNIT_INVALID');
    if (!allowedRungs.includes(r)) {
      throw new HttpError(400, `${profile ? profile.label : 'This business profile'} does not sell by the ${r.toLowerCase()}. Allowed units: ${allowedRungs.join(', ')}.`, 'SELLING_UNIT_NOT_ALLOWED');
    }
    if (r === 'PACK' && !packing.packs_per_carton && packing.units_per_pack <= 1) {
      throw new HttpError(400, 'To sell by the pack, set how many base units are in a pack.', 'PACKING_REQUIRED_FOR_PACK');
    }
    if (r === 'CARTON' && !packing.packs_per_carton) throw new HttpError(400, 'To sell by the carton, set packs per carton.', 'PACKING_REQUIRED_FOR_CARTON');
    if (r === 'PALLET' && !packing.cartons_per_pallet) throw new HttpError(400, 'To sell by the pallet, set cartons per pallet.', 'PACKING_REQUIRED_FOR_PALLET');
  }

  // Capability opt-ins are refused if the profile does not have the
  // capability. A furniture product with an IMEI field is not a feature, it is
  // a form that will be filled in with junk.
  const tracksSerials = input.tracks_serials ? 1 : 0;
  if (tracksSerials && !caps.serial_tracking) {
    throw new HttpError(403, `${profile ? profile.label : 'This business profile'} does not use serial-number tracking. Turn it on for the business profile first if you sell serialised goods.`, 'CAPABILITY_DISABLED');
  }
  const tracksExpiry = input.tracks_expiry ? 1 : 0;
  if (tracksExpiry && !caps.expiry_tracking) throw new HttpError(403, 'This business profile does not track expiry dates.', 'CAPABILITY_DISABLED');
  const tracksWarranty = input.tracks_warranty ? 1 : 0;
  if (tracksWarranty && !caps.warranty_tracking) throw new HttpError(403, 'Warranty tracking is not enabled for this business. Ask your account administrator.', 'CAPABILITY_DISABLED');

  const warrantyMonths = tracksWarranty
    ? (input.warranty_months != null ? Number(input.warranty_months) : (profile && profile.warranty_default_months) || 0)
    : null;
  if (warrantyMonths != null && (!Number.isFinite(warrantyMonths) || warrantyMonths < 0 || warrantyMonths > 240)) {
    throw new HttpError(400, 'Warranty months must be between 0 and 240.', 'WARRANTY_MONTHS_INVALID');
  }

  const sku = input.sku ? V.str(String(input.sku).trim().toUpperCase(), { field: 'SKU', max: V.LIMITS.CODE, allowEmpty: false }) : null;
  if (sku && sku.error) throw new HttpError(400, sku.error, 'VALIDATION_FAILED');
  if (sku) {
    const clash = await db.prepare('SELECT id, name FROM products WHERE business_unit_id = ? AND sku = ? AND is_deleted = 0').bind(businessUnitId, sku).first();
    if (clash) throw new HttpError(409, `SKU ${sku} is already used by "${clash.name}".`, 'SKU_ALREADY_EXISTS');
  }

  const cost = round2(Math.max(0, Number(input.default_cost_price) || 0));
  const selling = round2(Math.max(0, Number(input.default_selling_price) || 0));
  if (selling > 0 && cost > 0 && selling < cost) {
    // Warn, do not block. A loss-leader is a legitimate pricing decision and
    // the person making it should not have to fight the software — but they
    // should have to acknowledge it.
    input._below_cost_warning = `The default selling price is below cost. Margin will be negative on every unit sold at this price.`;
  }

  // Profile-driven attributes. Only keys the profile declares are accepted —
  // an unknown key is a client bug or an injection attempt, and either way it
  // should not land in the database.
  const declaredFields = (profile && profile.product_fields) || [];
  const attributes = {};
  const rawAttrs = input.attributes && typeof input.attributes === 'object' ? input.attributes : {};
  for (const f of declaredFields) {
    const v = rawAttrs[f.key] !== undefined ? rawAttrs[f.key] : input[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) attributes[f.key] = n;
    } else if (f.type === 'boolean') {
      attributes[f.key] = !!(v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'yes');
    } else if (f.type === 'select') {
      const s = String(v).trim().toUpperCase();
      if (!f.options || f.options.includes(s)) attributes[f.key] = s;
      else throw new HttpError(400, `${f.label} must be one of: ${f.options.join(', ')}.`, 'ATTRIBUTE_INVALID');
    } else {
      attributes[f.key] = String(v).slice(0, V.LIMITS.SHORT_TEXT);
    }
    if (f.required && attributes[f.key] === undefined) {
      throw new HttpError(400, `${f.label} is required for ${profile.label} products.`, 'ATTRIBUTE_REQUIRED');
    }
  }

  // Brand and model are declared fields on some profiles and real columns on
  // the product table. The column wins, because it is indexed and searched.
  const brand = input.brand || attributes.brand || null;
  const modelNumber = input.model_number || attributes.model_number || null;

  const complianceRef = input.compliance_ref_no ? String(input.compliance_ref_no).trim().slice(0, V.LIMITS.CODE) : null;
  const complianceScheme = input.compliance_scheme ? String(input.compliance_scheme).trim().toUpperCase().slice(0, 40) : (profile && profile.compliance ? profile.compliance.scheme : null);
  if (complianceRef && !complianceScheme) {
    throw new HttpError(400, 'A compliance reference number needs to say which scheme it belongs to (SONCAP, NAFDAC, SON, PCN…).', 'COMPLIANCE_SCHEME_REQUIRED');
  }

  const deliveryClass = input.delivery_class ? V.oneOf(input.delivery_class, ['SMALL', 'MEDIUM', 'LARGE', 'BULKY'], { field: 'Delivery class' }) : null;
  if (deliveryClass && deliveryClass.error) throw new HttpError(400, deliveryClass.error, 'VALIDATION_FAILED');

  const valuation = V.oneOf(input.valuation_method || 'FIFO', ['FIFO', 'WEIGHTED_AVG', 'SPECIFIC'], { field: 'Valuation method' });
  if (valuation && valuation.error) throw new HttpError(400, valuation.error, 'VALIDATION_FAILED');

  const taxCode = input.tax_code ? String(input.tax_code).trim().toUpperCase().slice(0, 40) : 'STANDARD';
  const { taxCodeOf } = require('../lib/vat');
  if (!taxCodeOf(taxCode)) throw new HttpError(400, `Tax code must be one of: ${Object.keys(require('../lib/vat').TAX_CODES).join(', ')}.`, 'TAX_CODE_INVALID');

  const ts = watNowIso();
  const id = newId();

  await db.prepare(`
    INSERT INTO products (
      id, business_unit_id, sku, name, description, category_id, brand, model_number,
      base_unit, units_per_pack, packs_per_carton, cartons_per_pallet, selling_units,
      compliance_scheme, compliance_ref_no, compliance_expiry_date, is_regulated,
      tracks_serials, tracks_expiry, tracks_warranty, warranty_months, warranty_terms,
      requires_installation, assembly_required, made_to_order, lead_time_days, delivery_class, is_fragile,
      attributes_json, valuation_method, reorder_level, reorder_quantity, max_stock_level,
      default_cost_price, default_selling_price, wholesale_selling_price, tax_code,
      is_active, created_by, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, businessUnitId, sku, name,
    input.description ? String(input.description).slice(0, V.LIMITS.MEDIUM_TEXT) : null,
    category ? category.id : null,
    brand ? String(brand).slice(0, 120) : null,
    modelNumber ? String(modelNumber).slice(0, 120) : null,
    baseUnit, packing.units_per_pack, packing.packs_per_carton, packing.cartons_per_pallet,
    requestedRungs.join(','),
    complianceScheme, complianceRef,
    input.compliance_expiry_date ? String(input.compliance_expiry_date).slice(0, 10) : null,
    input.is_regulated ? 1 : 0,
    tracksSerials, tracksExpiry, tracksWarranty, warrantyMonths,
    tracksWarranty ? (input.warranty_terms ? String(input.warranty_terms).slice(0, 2000) : (profile && profile.warranty_terms_default) || null) : null,
    input.requires_installation ? 1 : 0,
    input.assembly_required ? 1 : 0,
    input.made_to_order ? 1 : 0,
    Math.max(0, Number(input.lead_time_days) || 0),
    deliveryClass,
    input.is_fragile ? 1 : 0,
    JSON.stringify(attributes),
    valuation,
    Math.max(0, Number(input.reorder_level) || 0),
    Math.max(0, Number(input.reorder_quantity) || 0),
    input.max_stock_level != null ? Math.max(0, Number(input.max_stock_level)) : null,
    cost, selling,
    input.wholesale_selling_price != null ? round2(Math.max(0, Number(input.wholesale_selling_price))) : null,
    taxCode, 1, ctx.user.id, ts, ts
  ).run();

  // Barcodes supplied at creation. One primary only — "print a label" must be
  // unambiguous.
  if (Array.isArray(input.barcodes) && input.barcodes.length) {
    await setBarcodes(db, ctx, { productId: id, barcodes: input.barcodes });
  }
  if (Array.isArray(input.suppliers) && input.suppliers.length) {
    for (const s of input.suppliers) {
      try { await addSupplierLink(db, ctx, { productId: id, ...s }); } catch (e) { console.error('[productService] supplier link failed:', e && e.message); }
    }
  }

  await writeAudit(db, {
    businessUnitId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'PRODUCT_CREATED', entityType: 'PRODUCT', entityId: id,
    after: { name, sku, base_unit: baseUnit, default_selling_price: selling, tracks_serials: tracksSerials },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id, name, sku, base_unit: baseUnit, selling_units: requestedRungs,
    default_cost_price: cost, default_selling_price: selling,
    category_id: category ? category.id : null, attributes,
    warning: input._below_cost_warning || null,
  };
}

async function update(db, ctx, productId, input) {
  const businessUnitId = ctx.businessUnitId;
  const existing = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(productId).first();
  if (!existing) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
  if (existing.business_unit_id !== businessUnitId) throw new HttpError(403, 'That product belongs to a different business.', 'PRODUCT_WRONG_BUSINESS');

  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  const profile = profileOf(settings);
  const caps = capabilitiesOf(settings);
  const allowance = await staffAllowance(db, businessUnitId, ctx.user);

  const patch = {};
  const before = {};
  const record = (key, value) => {
    if (String(existing[key] ?? '') !== String(value ?? '')) { before[key] = existing[key]; patch[key] = value; }
  };

  if (input.name !== undefined) {
    const n = V.required(V.cleanProductName(input.name), { field: 'Product name', max: V.LIMITS.NAME });
    if (n && n.error) throw new HttpError(400, n.error, 'VALIDATION_FAILED');
    record('name', n);
  }
  if (input.description !== undefined) record('description', input.description ? String(input.description).slice(0, V.LIMITS.MEDIUM_TEXT) : null);
  if (input.sku !== undefined) {
    const sku = input.sku ? String(input.sku).trim().toUpperCase().slice(0, V.LIMITS.CODE) : null;
    if (sku) {
      const clash = await db.prepare('SELECT id, name FROM products WHERE business_unit_id = ? AND sku = ? AND is_deleted = 0 AND id <> ?').bind(businessUnitId, sku, productId).first();
      if (clash) throw new HttpError(409, `SKU ${sku} is already used by "${clash.name}".`, 'SKU_ALREADY_EXISTS');
    }
    record('sku', sku);
  }
  if (input.category_id !== undefined) {
    if (input.category_id) {
      const c = await db.prepare('SELECT * FROM product_categories WHERE id = ? AND business_unit_id = ? AND is_deleted = 0').bind(input.category_id, businessUnitId).first();
      if (!c) throw new HttpError(404, 'That category was not found for this business.', 'CATEGORY_NOT_FOUND');
      record('category_id', c.id);
    } else record('category_id', null);
  }
  if (input.brand !== undefined) record('brand', input.brand ? String(input.brand).slice(0, 120) : null);
  if (input.model_number !== undefined) record('model_number', input.model_number ? String(input.model_number).slice(0, 120) : null);

  if (input.base_unit !== undefined) {
    const u = V.oneOf(input.base_unit, BASE_UNITS.map((x) => x.code), { field: 'Base unit' });
    if (u && u.error) throw new HttpError(400, u.error, 'VALIDATION_FAILED');
    // Changing the base unit of a product that already has stock would make
    // every existing quantity mean something different. Refuse and point at
    // the correct action.
    const held = await db.prepare('SELECT COUNT(*) AS n FROM stock_batches WHERE product_id = ? AND quantity_remaining > 0 AND is_deleted = 0').bind(productId).first();
    if (held.n > 0 && u !== existing.base_unit) {
      throw new HttpError(409,
        `This product has stock on hand measured in ${existing.base_unit}. Changing the base unit would silently revalue every existing quantity — create a new product for the new unit, or run the stock down to zero first.`,
        'BASE_UNIT_CHANGE_WITH_STOCK');
    }
    record('base_unit', u);
  }

  if (input.units_per_pack !== undefined || input.packs_per_carton !== undefined || input.cartons_per_pallet !== undefined) {
    const packing = U.validatePacking({
      units_per_pack: input.units_per_pack !== undefined ? input.units_per_pack : existing.units_per_pack,
      packs_per_carton: input.packs_per_carton !== undefined ? input.packs_per_carton : existing.packs_per_carton,
      cartons_per_pallet: input.cartons_per_pallet !== undefined ? input.cartons_per_pallet : existing.cartons_per_pallet,
    });
    if (!packing.ok) throw new HttpError(400, packing.error, packing.code);
    // Changing the ladder under existing stock is legitimate (a supplier
    // changed the case size) but it must not silently invalidate the batches
    // already held, so it is recorded in the audit trail with both values.
    record('units_per_pack', packing.units_per_pack);
    record('packs_per_carton', packing.packs_per_carton);
    record('cartons_per_pallet', packing.cartons_per_pallet);
  }

  if (input.selling_units !== undefined) {
    const allowedRungs = (profile && profile.selling_units) || ['BASE_UNIT', 'PACK'];
    const rungs = (Array.isArray(input.selling_units) ? input.selling_units : String(input.selling_units).split(','))
      .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    for (const r of rungs) {
      if (!U.isSellingUnit(r)) throw new HttpError(400, `Selling unit must be one of: ${U.SELLING_UNITS.join(', ')}.`, 'SELLING_UNIT_INVALID');
      if (!allowedRungs.includes(r)) throw new HttpError(400, `${profile ? profile.label : 'This profile'} does not sell by the ${r.toLowerCase()}.`, 'SELLING_UNIT_NOT_ALLOWED');
    }
    record('selling_units', (rungs.length ? rungs : ['BASE_UNIT']).join(','));
  }

  // PRICE EDITS are the highest-value change a cashier can make, so they are
  // gated by the owner-controlled permission and audited with both values.
  const priceTouched = input.default_cost_price !== undefined || input.default_selling_price !== undefined || input.wholesale_selling_price !== undefined;
  if (priceTouched && !allowance.can_edit_prices) {
    throw new HttpError(403, 'You are not permitted to change product prices in this business. The owner controls this under My Plan → Manager permissions.', 'PRICE_EDIT_FORBIDDEN');
  }
  if (input.default_cost_price !== undefined) record('default_cost_price', round2(Math.max(0, Number(input.default_cost_price) || 0)));
  if (input.default_selling_price !== undefined) record('default_selling_price', round2(Math.max(0, Number(input.default_selling_price) || 0)));
  if (input.wholesale_selling_price !== undefined) {
    record('wholesale_selling_price', input.wholesale_selling_price == null ? null : round2(Math.max(0, Number(input.wholesale_selling_price))));
  }

  if (input.reorder_level !== undefined) record('reorder_level', Math.max(0, Number(input.reorder_level) || 0));
  if (input.reorder_quantity !== undefined) record('reorder_quantity', Math.max(0, Number(input.reorder_quantity) || 0));
  if (input.max_stock_level !== undefined) record('max_stock_level', input.max_stock_level == null ? null : Math.max(0, Number(input.max_stock_level)));

  if (input.tracks_serials !== undefined) {
    const v = input.tracks_serials ? 1 : 0;
    if (v && !caps.serial_tracking) throw new HttpError(403, 'Serial tracking is not available for this business profile.', 'CAPABILITY_DISABLED');
    // Turning serial tracking OFF on a product that has serials in stock would
    // orphan the custody chain. Refuse.
    if (!v && existing.tracks_serials) {
      const live = await db.prepare(`SELECT COUNT(*) AS n FROM product_serials WHERE product_id = ? AND is_deleted = 0 AND status NOT IN ('SOLD','SCRAPPED','LOST')`).bind(productId).first();
      if (live.n > 0) {
        throw new HttpError(409, `${live.n} serialised unit(s) of this product are still in stock. Serial tracking cannot be turned off while the custody chain is live — sell or scrap them first.`, 'SERIALS_STILL_HELD');
      }
    }
    record('tracks_serials', v);
  }
  if (input.tracks_expiry !== undefined) {
    const v = input.tracks_expiry ? 1 : 0;
    if (v && !caps.expiry_tracking) throw new HttpError(403, 'Expiry tracking is not available for this business profile.', 'CAPABILITY_DISABLED');
    record('tracks_expiry', v);
  }
  if (input.tracks_warranty !== undefined) {
    const v = input.tracks_warranty ? 1 : 0;
    if (v && !caps.warranty_tracking) throw new HttpError(403, 'Warranty tracking is not enabled for this business.', 'CAPABILITY_DISABLED');
    record('tracks_warranty', v);
  }
  if (input.warranty_months !== undefined) {
    const m = input.warranty_months == null ? null : Number(input.warranty_months);
    if (m != null && (!Number.isFinite(m) || m < 0 || m > 240)) throw new HttpError(400, 'Warranty months must be between 0 and 240.', 'WARRANTY_MONTHS_INVALID');
    record('warranty_months', m);
  }
  if (input.warranty_terms !== undefined) record('warranty_terms', input.warranty_terms ? String(input.warranty_terms).slice(0, 2000) : null);
  if (input.requires_installation !== undefined) record('requires_installation', input.requires_installation ? 1 : 0);
  if (input.assembly_required !== undefined) record('assembly_required', input.assembly_required ? 1 : 0);
  if (input.made_to_order !== undefined) record('made_to_order', input.made_to_order ? 1 : 0);
  if (input.lead_time_days !== undefined) record('lead_time_days', Math.max(0, Number(input.lead_time_days) || 0));
  if (input.delivery_class !== undefined) {
    const d = input.delivery_class ? V.oneOf(input.delivery_class, ['SMALL', 'MEDIUM', 'LARGE', 'BULKY'], { field: 'Delivery class' }) : null;
    if (d && d.error) throw new HttpError(400, d.error, 'VALIDATION_FAILED');
    record('delivery_class', d);
  }
  if (input.is_fragile !== undefined) record('is_fragile', input.is_fragile ? 1 : 0);
  if (input.tax_code !== undefined) {
    const t = String(input.tax_code || 'STANDARD').toUpperCase();
    if (!require('../lib/vat').TAX_CODES[t]) throw new HttpError(400, `Tax code must be one of: ${Object.keys(require('../lib/vat').TAX_CODES).join(', ')}.`, 'TAX_CODE_INVALID');
    record('tax_code', t);
  }
  if (input.compliance_ref_no !== undefined) record('compliance_ref_no', input.compliance_ref_no ? String(input.compliance_ref_no).slice(0, V.LIMITS.CODE) : null);
  if (input.compliance_expiry_date !== undefined) record('compliance_expiry_date', input.compliance_expiry_date ? String(input.compliance_expiry_date).slice(0, 10) : null);
  if (input.is_regulated !== undefined) record('is_regulated', input.is_regulated ? 1 : 0);
  if (input.is_active !== undefined) record('is_active', input.is_active ? 1 : 0);

  // Attributes: merge, never replace wholesale, so a partial update cannot
  // erase fields the caller did not send.
  const declaredFields = (profile && profile.product_fields) || [];
  const incomingAttrs = input.attributes && typeof input.attributes === 'object' ? input.attributes : null;
  if (incomingAttrs) {
    let current = {};
    try { current = JSON.parse(existing.attributes_json || '{}'); } catch (_) { current = {}; }
    for (const f of declaredFields) {
      if (incomingAttrs[f.key] === undefined) continue;
      const v = incomingAttrs[f.key];
      if (v === null || v === '') { delete current[f.key]; continue; }
      if (f.type === 'number') { const n = Number(v); if (Number.isFinite(n)) current[f.key] = n; }
      else if (f.type === 'boolean') current[f.key] = !!(v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'yes');
      else if (f.type === 'select') {
        const s = String(v).trim().toUpperCase();
        if (!f.options || f.options.includes(s)) current[f.key] = s;
        else throw new HttpError(400, `${f.label} must be one of: ${f.options.join(', ')}.`, 'ATTRIBUTE_INVALID');
      } else current[f.key] = String(v).slice(0, V.LIMITS.SHORT_TEXT);
      if (f.required && current[f.key] === undefined) throw new HttpError(400, `${f.label} is required for ${profile.label} products.`, 'ATTRIBUTE_REQUIRED');
    }
    record('attributes_json', JSON.stringify(current));
  }

  if (!Object.keys(patch).length) return { ok: true, id: productId, changed: 0, message: 'Nothing to change.' };

  patch.updated_at = watNowIso();
  const cols = Object.keys(patch);
  await db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .bind(...cols.map((c) => patch[c]), productId).run();

  await writeAudit(db, {
    businessUnitId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: priceTouched ? 'PRODUCT_PRICE_CHANGED' : 'PRODUCT_UPDATED',
    entityType: 'PRODUCT', entityId: productId,
    amount: patch.default_selling_price != null ? patch.default_selling_price : null,
    before, after: patch, ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id: productId, changed: cols.length, price_changed: priceTouched };
}

async function get(db, ctx, productId, { branchId = null } = {}) {
  const p = await db.prepare(`
    SELECT p.*, pc.label AS category_label, pc.code AS category_code,
           bu.industry_profile, bu.name AS business_name
    FROM products p
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    JOIN business_units bu ON bu.id = p.business_unit_id
    WHERE p.id = ? AND p.is_deleted = 0
  `).bind(productId).first();
  if (!p) return null;
  if (p.business_unit_id !== ctx.businessUnitId) throw new HttpError(403, 'That product belongs to a different business.', 'PRODUCT_WRONG_BUSINESS');

  let attributes = {};
  try { attributes = JSON.parse(p.attributes_json || '{}'); } catch (_) { attributes = {}; }

  const [barcodes, suppliers, stockByBranch, overrides, serialCount] = await Promise.all([
    db.prepare('SELECT * FROM product_barcodes WHERE product_id = ? AND is_deleted = 0 ORDER BY is_primary DESC').bind(productId).all(),
    db.prepare(`
      SELECT ps.*, s.name AS supplier_name, s.phone AS supplier_phone, s.payment_terms_days
      FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
      WHERE ps.product_id = ? AND ps.is_deleted = 0 ORDER BY ps.is_preferred DESC
    `).bind(productId).all(),
    db.prepare(`
      SELECT sb.branch_id, b.name AS branch_name,
             COALESCE(SUM(sb.quantity_remaining),0) AS on_hand,
             COALESCE(SUM(sb.quantity_reserved),0) AS reserved,
             COALESCE(SUM(sb.quantity_remaining - sb.quantity_reserved),0) AS available,
             COALESCE(SUM(sb.quantity_remaining * sb.unit_cost),0) AS value_at_cost,
             MIN(sb.expiry_date) AS earliest_expiry
      FROM stock_batches sb JOIN branches b ON b.id = sb.branch_id
      WHERE sb.product_id = ? AND sb.is_deleted = 0 AND sb.status NOT IN ('EXPIRED','RECALLED','RETURNED_TO_SUPPLIER')
      GROUP BY sb.branch_id, b.name
    `).bind(productId).all(),
    branchId
      ? db.prepare('SELECT * FROM product_price_overrides WHERE product_id = ? AND branch_id = ? AND is_deleted = 0').bind(productId, branchId).all()
      : db.prepare('SELECT * FROM product_price_overrides WHERE product_id = ? AND is_deleted = 0').bind(productId).all(),
    p.tracks_serials
      ? db.prepare(`SELECT status, COUNT(*) AS n FROM product_serials WHERE product_id = ? AND is_deleted = 0 GROUP BY status`).bind(productId).all()
      : Promise.resolve({ results: [] }),
  ]);

  const settings = ctx.businessUnit || await getUnitSettings(db, ctx.businessUnitId);
  return {
    ...p,
    attributes,
    capability_flags: itemCapabilities(settings, p, null),
    selling_units_list: String(p.selling_units || 'BASE_UNIT').split(',').map((s) => s.trim()).filter(Boolean),
    packing: U.ladderOf(p),
    barcodes: barcodes.results,
    suppliers: suppliers.results,
    stock_by_branch: stockByBranch.results.map((r) => ({
      ...r,
      on_hand: round2(r.on_hand), reserved: round2(r.reserved), available: round2(r.available),
      value_at_cost: round2(r.value_at_cost),
      below_reorder: Number(p.reorder_level) > 0 && Number(r.on_hand) <= Number(p.reorder_level),
    })),
    total_on_hand: round2(stockByBranch.results.reduce((a, r) => a + Number(r.on_hand), 0)),
    total_available: round2(stockByBranch.results.reduce((a, r) => a + Number(r.available), 0)),
    price_overrides: overrides.results,
    serial_summary: serialCount.results,
    margin_percent: Number(p.default_selling_price) > 0 && Number(p.default_cost_price) > 0
      ? round2(((Number(p.default_selling_price) - Number(p.default_cost_price)) / Number(p.default_selling_price)) * 100)
      : null,
  };
}

async function list(db, { businessUnitId, branchId = null, categoryId = null, search = null, tracksSerials = null, belowReorderOnly = false, activeOnly = true, includeStock = true, limit = 50, offset = 0, sort = 'name', dir = 'ASC' }) {
  const where = ['p.is_deleted = 0', 'p.business_unit_id = ?'];
  const params = [businessUnitId];
  if (activeOnly) where.push('p.is_active = 1');
  if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }
  if (tracksSerials != null) { where.push('p.tracks_serials = ?'); params.push(tracksSerials ? 1 : 0); }
  if (search) {
    const term = String(search).trim();
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\'
                 OR p.model_number LIKE ? ESCAPE '\\' OR p.attributes_json LIKE ? ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.is_deleted = 0 AND pb.barcode LIKE ? ESCAPE '\\'))`);
    params.push(like, like, like, like, like, like);
  }

  // Stock is aggregated in a correlated subquery. The branch scope is a BOUND
  // parameter, never string-interpolated — `branchId` arrives from a query
  // string, and interpolating it would be a full-database read for any caller.
  // The `? IS NULL OR sb.branch_id = ?` form binds the same value twice and
  // lets one query serve both the all-branches and single-branch cases.
  const branchPair = branchId ? [branchId, branchId] : [null, null];
  const stockSub = `(SELECT COALESCE(SUM(sb.quantity_remaining),0) FROM stock_batches sb
        WHERE sb.product_id = p.id AND sb.is_deleted = 0
          AND sb.status NOT IN ('EXPIRED','RECALLED','RETURNED_TO_SUPPLIER')
          AND (? IS NULL OR sb.branch_id = ?))`;
  const reservedSub = `(SELECT COALESCE(SUM(sb.quantity_reserved),0) FROM stock_batches sb
        WHERE sb.product_id = p.id AND sb.is_deleted = 0 AND (? IS NULL OR sb.branch_id = ?))`;

  if (belowReorderOnly) {
    where.push('p.reorder_level > 0');
    where.push(`${stockSub} <= p.reorder_level`);
  }

  const allowedSorts = ['name', 'sku', 'created_at', 'default_selling_price', 'reorder_level', 'brand'];
  const sortCol = allowedSorts.includes(String(sort)) ? String(sort) : 'name';
  const sortDir = String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  // Parameter order must match the order the placeholders appear in the final
  // SQL string: the SELECT-list subqueries come first, then the WHERE clause,
  // then LIMIT/OFFSET.
  const selectParams = [...branchPair, ...branchPair];
  const belowReorderParams = belowReorderOnly ? [...branchPair] : [];

  const rows = await db.prepare(`
    SELECT p.id, p.sku, p.name, p.brand, p.model_number, p.base_unit, p.category_id, pc.label AS category_label,
           p.units_per_pack, p.packs_per_carton, p.cartons_per_pallet, p.selling_units,
           p.default_cost_price, p.default_selling_price, p.wholesale_selling_price,
           p.reorder_level, p.tracks_serials, p.tracks_expiry, p.tracks_warranty, p.warranty_months,
           p.delivery_class, p.made_to_order, p.is_active, p.tax_code, p.attributes_json, p.created_at,
           ${stockSub} AS on_hand, ${reservedSub} AS reserved
    FROM products p
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.${sortCol} ${sortDir}, p.name ASC
    LIMIT ? OFFSET ?
  `).bind(...selectParams, ...belowReorderParams, ...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();

  const countRow = await db.prepare(`
    SELECT COUNT(*) AS n FROM products p
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    WHERE ${where.join(' AND ')}
  `).bind(...belowReorderParams, ...params).first();


  return {
    results: rows.results.map((r) => {
      const onHand = round2(Number(r.on_hand) || 0);
      const reserved = round2(Number(r.reserved) || 0);
      let attrs = {};
      try { attrs = JSON.parse(r.attributes_json || '{}'); } catch (_) { attrs = {}; }
      return {
        ...r, attributes: attrs, on_hand: onHand, reserved, available: round2(onHand - reserved),
        below_reorder: Number(r.reorder_level) > 0 && onHand <= Number(r.reorder_level),
        margin_percent: Number(r.default_selling_price) > 0 && Number(r.default_cost_price) > 0
          ? round2(((Number(r.default_selling_price) - Number(r.default_cost_price)) / Number(r.default_selling_price)) * 100) : null,
      };
    }),
    total: countRow ? countRow.n : rows.results.length,
  };
}

// ---------------------------------------------------------------------
// BARCODES
// ---------------------------------------------------------------------
async function setBarcodes(db, ctx, { productId, barcodes }) {
  const businessUnitId = ctx.businessUnitId;
  const list = Array.isArray(barcodes) ? barcodes : [];
  if (!list.length) return { ok: true, count: 0 };
  if (list.length > 50) throw new HttpError(400, 'At most 50 barcodes per product — that many usually means a CSV was pasted into the wrong field.', 'TOO_MANY_BARCODES');

  const ts = watNowIso();
  const seen = new Set();
  const statements = [];
  let primarySet = false;

  for (const raw of list) {
    const code = V.barcode(raw.barcode || raw.code, { field: 'Barcode' });
    if (code && code.error) throw new HttpError(400, code.error, 'VALIDATION_FAILED');
    if (seen.has(code)) throw new HttpError(409, `Barcode ${code} appears twice in this list.`, 'BARCODE_DUPLICATED_IN_LIST');
    seen.add(code);

    const unit = V.oneOf(raw.unit_type || 'BASE_UNIT', U.SELLING_UNITS, { field: 'Barcode unit' });
    if (unit && unit.error) throw new HttpError(400, unit.error, 'VALIDATION_FAILED');

    const clash = await db.prepare('SELECT product_id FROM product_barcodes WHERE business_unit_id = ? AND barcode = ? AND is_deleted = 0').bind(businessUnitId, code).first();
    if (clash && clash.product_id !== productId) {
      const other = await db.prepare('SELECT name FROM products WHERE id = ?').bind(clash.product_id).first();
      throw new HttpError(409, `Barcode ${code} is already assigned to "${other ? other.name : 'another product'}". One code must resolve to exactly one product, or a scan at the counter is a guess.`, 'BARCODE_ALREADY_ASSIGNED');
    }

    const isPrimary = raw.is_primary ? 1 : 0;
    if (isPrimary) {
      if (primarySet) throw new HttpError(400, 'Only one barcode per product can be the primary — it is the one printed on your own labels.', 'ONLY_ONE_PRIMARY_BARCODE');
      primarySet = true;
    }

    const id = newId();
    statements.push(db.prepare(`
      INSERT INTO product_barcodes (id, product_id, business_unit_id, barcode, unit_type, label, is_primary, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT (business_unit_id, barcode) DO UPDATE SET
        product_id = excluded.product_id, unit_type = excluded.unit_type,
        label = excluded.label, is_primary = excluded.is_primary, is_deleted = 0, updated_at = excluded.updated_at
    `).bind(id, productId, businessUnitId, code, unit,
      raw.label ? String(raw.label).slice(0, 120) : null, isPrimary, ts, ts));
  }
  await db.batch(statements);
  return { ok: true, count: statements.length };
}

// Scan lookup — the hottest read path in the POS. Resolves a barcode, an SKU,
// a serial number or an IMEI to a product, in that order, because that is the
// order a cashier will try them in when the scanner is broken.
async function resolveScan(db, { businessUnitId, code, branchId = null }) {
  const key = String(code || '').trim();
  if (!key) return null;
  const upper = key.toUpperCase();

  const barcode = await db.prepare(`
    SELECT pb.*, p.name AS product_name, p.sku, p.base_unit, p.tracks_serials
    FROM product_barcodes pb JOIN products p ON p.id = pb.product_id AND p.is_deleted = 0
    WHERE pb.business_unit_id = ? AND pb.barcode = ? AND pb.is_deleted = 0 AND p.is_active = 1
  `).bind(businessUnitId, upper).first();
  if (barcode) {
    const product = await get(db, { businessUnitId }, barcode.product_id, { branchId });
    return { match_type: 'BARCODE', unit_type: barcode.unit_type, product, barcode };
  }

  const bySku = await db.prepare('SELECT id FROM products WHERE business_unit_id = ? AND sku = ? AND is_deleted = 0 AND is_active = 1').bind(businessUnitId, upper).first();
  if (bySku) return { match_type: 'SKU', unit_type: 'BASE_UNIT', product: await get(db, { businessUnitId }, bySku.id, { branchId }) };

  // A serial/IMEI scan identifies a SPECIFIC physical unit. Returning the
  // product alone would let the cashier sell a unit that is not in stock at
  // this branch, so the serial record comes back with it.
  const serial = await stockServiceSerial(db, { businessUnitId, serialNo: key });
  if (serial) {
    const product = await get(db, { businessUnitId }, serial.product_id, { branchId });
    return {
      match_type: 'SERIAL', unit_type: 'BASE_UNIT', product,
      serial: { id: serial.id, serial_no: serial.serial_no, imei: serial.imei, status: serial.status, branch_id: serial.branch_id, branch_name: serial.branch_name },
      sellable_here: serial.status === 'IN_STOCK' && (!branchId || serial.branch_id === branchId),
      advisory: serial.status !== 'IN_STOCK'
        ? `That serial is ${String(serial.status).replace(/_/g, ' ').toLowerCase()} and cannot be sold.`
        : (branchId && serial.branch_id !== branchId ? `That unit is at ${serial.branch_name}, not this branch. Request a transfer.` : null),
    };
  }
  return null;
}

async function stockServiceSerial(db, { businessUnitId, serialNo }) {
  const stockService = require('./stockService');
  return stockService.serialByNumber(db, { businessUnitId, serialNo });
}

// ---------------------------------------------------------------------
// CATEGORIES
// ---------------------------------------------------------------------
async function listCategories(db, { businessUnitId, includeInactive = false }) {
  const rows = await db.prepare(`
    SELECT pc.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = pc.id AND p.is_deleted = 0) AS product_count
    FROM product_categories pc
    WHERE pc.business_unit_id = ? AND pc.is_deleted = 0 ${includeInactive ? '' : 'AND pc.is_active = 1'}
    ORDER BY pc.sort_order ASC, pc.label ASC
  `).bind(businessUnitId).all();
  return rows.results;
}

async function createCategory(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const code = V.required(String(input.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'), { field: 'Category code', max: 40 });
  if (code && code.error) throw new HttpError(400, code.error, 'VALIDATION_FAILED');
  const label = V.required(input.label, { field: 'Category name', max: 120 });
  if (label && label.error) throw new HttpError(400, label.error, 'VALIDATION_FAILED');

  const clash = await db.prepare('SELECT id FROM product_categories WHERE business_unit_id = ? AND code = ? AND is_deleted = 0').bind(businessUnitId, code).first();
  if (clash) throw new HttpError(409, `A category with code ${code} already exists.`, 'CATEGORY_CODE_EXISTS');

  const baseUnit = V.oneOf(input.default_base_unit || 'PIECE', BASE_UNITS.map((u) => u.code), { field: 'Default unit' });
  if (baseUnit && baseUnit.error) throw new HttpError(400, baseUnit.error, 'VALIDATION_FAILED');

  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  const caps = capabilitiesOf(settings);
  const ts = watNowIso();
  const id = newId();
  await db.prepare(`
    INSERT INTO product_categories (
      id, business_unit_id, code, label, parent_id, default_base_unit, tracks_serials, tracks_expiry,
      tracks_warranty, is_installation_item, sort_order, is_active, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, businessUnitId, code, label, input.parent_id || null, baseUnit,
    caps.serial_tracking && input.tracks_serials ? 1 : 0,
    caps.expiry_tracking && input.tracks_expiry ? 1 : 0,
    caps.warranty_tracking && input.tracks_warranty ? 1 : 0,
    caps.installation_service && input.is_installation_item ? 1 : 0,
    Number(input.sort_order) || 0, 1, ts, ts
  ).run();
  return { ok: true, id, code, label };
}

// Seed the profile's default categories. Idempotent: existing codes are left
// alone, so re-running after an owner has renamed things does not resurrect
// the defaults over their edits.
async function seedProfileCategories(db, { businessUnitId, profile }) {
  const p = profileOf(profile) || profile;
  if (!p || !Array.isArray(p.default_categories)) return { created: 0 };
  const ts = watNowIso();
  const statements = [];
  let created = 0;
  for (let i = 0; i < p.default_categories.length; i += 1) {
    const c = p.default_categories[i];
    const existing = await db.prepare('SELECT id FROM product_categories WHERE business_unit_id = ? AND code = ?').bind(businessUnitId, c.code).first();
    if (existing) continue;
    created += 1;
    statements.push(db.prepare(`
      INSERT INTO product_categories (
        id, business_unit_id, code, label, default_base_unit, tracks_serials, tracks_expiry,
        tracks_warranty, is_installation_item, sort_order, is_active, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      newId(), businessUnitId, c.code, c.label, c.uom || p.base_unit_default || 'PIECE',
      p.code === 'ELECTRONICS_APPLIANCES' && ['MOBILE_PHONES', 'LAPTOPS_COMPUTERS', 'HOME_APPLIANCES', 'TV_AUDIO', 'GENERATORS', 'SOLAR_POWER', 'GAMING', 'CAMERAS'].includes(c.code) ? 1 : 0,
      ['FOODSTUFFS', 'BEVERAGES', 'PROVISIONS', 'BABY_PRODUCTS', 'PERSONAL_CARE'].includes(c.code) || p.code === 'PHARMACY_HEALTH' ? 1 : 0,
      p.code === 'ELECTRONICS_APPLIANCES' || p.code === 'FURNITURE_HOME' ? 1 : 0,
      p.code === 'FURNITURE_HOME' || p.code === 'ELECTRONICS_APPLIANCES' ? 1 : 0,
      (i + 1) * 10, 1, ts, ts
    ));
  }
  if (statements.length) await db.batch(statements);
  return { created };
}

// ---------------------------------------------------------------------
// SUPPLIERS
// ---------------------------------------------------------------------
async function createSupplier(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const name = V.required(input.name, { field: 'Supplier name', max: V.LIMITS.NAME });
  if (name && name.error) throw new HttpError(400, name.error, 'VALIDATION_FAILED');

  let phone = null;
  if (input.phone) {
    const p = V.phone(input.phone, { field: 'Phone number' });
    if (p && p.error) throw new HttpError(400, p.error, 'VALIDATION_FAILED');
    if (p) phone = p.international;
  }
  const tin = input.tin ? V.tin(input.tin, { field: 'TIN' }) : null;
  if (tin && tin.error) throw new HttpError(400, tin.error, 'VALIDATION_FAILED');
  const type = V.oneOf(input.supplier_type || 'WHOLESALE',
    ['MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'WHOLESALE', 'WORKSHOP', 'SERVICE', 'OTHER'], { field: 'Supplier type' });
  if (type && type.error) throw new HttpError(400, type.error, 'VALIDATION_FAILED');

  const ts = watNowIso();
  const id = newId();
  await db.prepare(`
    INSERT INTO suppliers (
      id, business_unit_id, name, supplier_type, contact_name, phone, alt_phone, email, address, state,
      country, tin, rc_number, bank_name, bank_account_name, bank_account_no,
      payment_terms_days, credit_limit, currency, lead_time_days, notes, is_active, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 1,?,?)
  `).bind(
    id, businessUnitId, name, type,
    input.contact_name ? String(input.contact_name).slice(0, 160) : null, phone,
    input.alt_phone ? String(input.alt_phone).slice(0, 20) : null,
    input.email ? V.email(input.email, { field: 'Email' }) || null : null,
    input.address ? String(input.address).slice(0, V.LIMITS.ADDRESS) : null,
    input.state ? require('../lib/geo').normaliseState(input.state) : null,
    input.country ? String(input.country).slice(0, 80) : 'Nigeria',
    tin, input.rc_number ? String(input.rc_number).slice(0, 40) : null,
    input.bank_name ? String(input.bank_name).slice(0, 120) : null,
    input.bank_account_name ? String(input.bank_account_name).slice(0, 160) : null,
    input.bank_account_no ? String(input.bank_account_no).slice(0, 40) : null,
    Math.max(0, Number(input.payment_terms_days) || 0),
    round2(Math.max(0, Number(input.credit_limit) || 0)),
    input.currency ? String(input.currency).toUpperCase().slice(0, 3) : 'NGN',
    Math.max(0, Number(input.lead_time_days) || 0),
    input.notes ? String(input.notes).slice(0, V.LIMITS.NOTES) : null, ts, ts
  ).run();
  return { ok: true, id, name, supplier_type: type, phone };
}

async function addSupplierLink(db, ctx, { productId, supplierId, supplierItemCode = null, unitCost = null, costUnit = 'BASE_UNIT', minOrderQuantity = 1, leadTimeDays = 0, isPreferred = false, notes = null }) {
  const businessUnitId = ctx.businessUnitId;
  const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(productId).first();
  if (!product) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
  if (product.business_unit_id !== businessUnitId) throw new HttpError(403, 'That product belongs to a different business.', 'PRODUCT_WRONG_BUSINESS');
  const supplier = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0').bind(supplierId).first();
  if (!supplier) throw new HttpError(404, 'That supplier was not found.', 'SUPPLIER_NOT_FOUND');
  if (supplier.business_unit_id !== businessUnitId) throw new HttpError(403, 'That supplier belongs to a different business.', 'SUPPLIER_WRONG_BUSINESS');

  const cu = V.oneOf(costUnit, U.SELLING_UNITS, { field: 'Cost unit' });
  if (cu && cu.error) throw new HttpError(400, cu.error, 'VALIDATION_FAILED');

  const ts = watNowIso();
  const existing = await db.prepare('SELECT id FROM product_suppliers WHERE product_id = ? AND supplier_id = ? AND is_deleted = 0').bind(productId, supplierId).first();
  if (existing) {
    await db.prepare(`
      UPDATE product_suppliers SET supplier_item_code = COALESCE(?, supplier_item_code), unit_cost = COALESCE(?, unit_cost),
        cost_unit = ?, min_order_quantity = ?, lead_time_days = ?, is_preferred = ?, notes = COALESCE(?, notes), updated_at = ?
      WHERE id = ?
    `).bind(supplierItemCode, unitCost == null ? null : round2(Number(unitCost)), cu,
      Math.max(1, Number(minOrderQuantity) || 1), Math.max(0, Number(leadTimeDays) || 0),
      isPreferred ? 1 : 0, notes, ts, existing.id).run();
    return { ok: true, id: existing.id, updated: true };
  }

  const id = newId();
  await db.prepare(`
    INSERT INTO product_suppliers (
      id, business_unit_id, product_id, supplier_id, supplier_item_code, unit_cost, cost_unit,
      min_order_quantity, lead_time_days, is_preferred, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, businessUnitId, productId, supplierId,
    supplierItemCode ? String(supplierItemCode).slice(0, 60) : null,
    unitCost == null ? null : round2(Number(unitCost)), cu,
    Math.max(1, Number(minOrderQuantity) || 1), Math.max(0, Number(leadTimeDays) || 0),
    isPreferred ? 1 : 0, notes ? String(notes).slice(0, 500) : null, ts, ts).run();
  return { ok: true, id };
}

async function listSuppliers(db, { businessUnitId, search = null, type = null, limit = 50, offset = 0 }) {
  const where = ['s.is_deleted = 0', 's.business_unit_id = ?'];
  const params = [businessUnitId];
  if (type) { where.push('s.supplier_type = ?'); params.push(String(type).toUpperCase()); }
  if (search) {
    const like = `%${String(search).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const digits = String(search).replace(/\D/g, '');
    where.push(`(s.name LIKE ? ESCAPE '\\' OR s.contact_name LIKE ? ESCAPE '\\' OR s.phone LIKE ? OR s.tin LIKE ? ESCAPE '\\')`);
    params.push(like, like, digits ? `%${digits.slice(-10)}` : like, like);
  }
  const rows = await db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM product_suppliers ps WHERE ps.supplier_id = s.id AND ps.is_deleted = 0) AS product_count,
      COALESCE((SELECT SUM(cl.amount) FROM creditor_ledger cl WHERE cl.supplier_id = s.id AND cl.is_deleted = 0),0) AS balance_owed
    FROM suppliers s WHERE ${where.join(' AND ')}
    ORDER BY s.name ASC LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();
  return rows.results.map((r) => ({ ...r, balance_owed: round2(r.balance_owed) }));
}

// Reorder suggestions. Turns "we are running low" into a phone call: names
// the preferred supplier, their number, the lead time and the suggested
// quantity. A low-stock list without a supplier is a list nobody acts on.
async function reorderSuggestions(db, { businessUnitId, branchId = null, limit = 100 }) {
  // Branch scoping via bound parameters (see the note in list()): one query
  // serves both the all-branches and single-branch case.
  const rows = await db.prepare(`
    SELECT p.id AS product_id, p.name AS product_name, p.sku, p.base_unit, p.reorder_level, p.reorder_quantity,
           pc.label AS category_label,
           ? AS branch_id,
           COALESCE(SUM(CASE WHEN sb.quantity_remaining IS NOT NULL AND (? IS NULL OR sb.branch_id = ?)
                             THEN sb.quantity_remaining ELSE 0 END),0) AS on_hand,
           (SELECT ps.supplier_id FROM product_suppliers ps WHERE ps.product_id = p.id AND ps.is_deleted = 0
             ORDER BY ps.is_preferred DESC LIMIT 1) AS supplier_id
    FROM products p
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    LEFT JOIN stock_batches sb ON sb.product_id = p.id AND sb.is_deleted = 0
      AND sb.status NOT IN ('EXPIRED','RECALLED','RETURNED_TO_SUPPLIER')
    WHERE p.business_unit_id = ? AND p.is_deleted = 0 AND p.is_active = 1 AND p.reorder_level > 0
    GROUP BY p.id, p.name, p.sku, p.base_unit, p.reorder_level, p.reorder_quantity, pc.label
    HAVING on_hand <= p.reorder_level
    ORDER BY (p.reorder_level - on_hand) DESC
    LIMIT ?
  `).bind(branchId || null, branchId || null, branchId || null, businessUnitId, Math.min(500, Number(limit) || 100)).all();

  const out = [];
  for (const r of rows.results) {
    let supplier = null;
    if (r.supplier_id) {
      supplier = await db.prepare(`
        SELECT s.name, s.phone, s.contact_name, s.payment_terms_days, s.lead_time_days,
               ps.supplier_item_code, ps.unit_cost, ps.cost_unit, ps.min_order_quantity, ps.lead_time_days AS product_lead_time
        FROM suppliers s JOIN product_suppliers ps ON ps.supplier_id = s.id
        WHERE s.id = ? AND ps.product_id = ?
      `).bind(r.supplier_id, r.product_id).first();
    }
    const suggested = Number(r.reorder_quantity) > 0 ? Number(r.reorder_quantity) : Math.max(1, Number(r.reorder_level) * 2 - Number(r.on_hand));
    out.push({
      ...r,
      on_hand: round2(r.on_hand),
      shortfall: round2(Number(r.reorder_level) - Number(r.on_hand)),
      suggested_order_quantity: round2(Math.max(supplier ? Number(supplier.min_order_quantity) || 1 : 1, suggested)),
      supplier: supplier || null,
      estimated_cost: supplier && supplier.unit_cost
        ? round2(Number(supplier.unit_cost) * Math.max(supplier ? Number(supplier.min_order_quantity) || 1 : 1, suggested))
        : null,
    });
  }
  return out;
}

module.exports = {
  create, update, get, list, setBarcodes, resolveScan,
  listCategories, createCategory, seedProfileCategories,
  createSupplier, addSupplierLink, listSuppliers, reorderSuggestions,
};
'use strict';
