// =====================================================================
// StockRidge — INDUSTRY PROFILES  (the "multi-business" decoupling point)
// =====================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// PharmaRidge hardcoded the pharmacy domain into its schema:
//
//     products.nafdac_reg_no        products.dispensing_type (OTC/POM)
//     products.is_controlled        prescriptions
//     controlled_substance_register branches.pcn_license_no
//     branches.superintendent_pharmacist
//     products.retail_category CHECK (... 'PHARMACEUTICALS' ...)
//
// Every one of those is a *domain policy*, not an inventory primitive.
// StockRidge keeps the primitives (product, batch, sale, stock movement,
// ledger, till, transfer, stocktake) and moves the policy OUT of the
// schema and INTO data: an industry profile declares which capabilities
// a business needs, and the code reads the capability, never the domain.
//
// The rule enforced everywhere in this codebase:
//
//     NOTHING under server/ or worker/ may test `profile === 'ELECTRONICS'`.
//     It must test `capabilities.serial_tracking` / `profile.warranty_default_months`.
//
// That single rule is what makes the same binary serve an appliance
// wholesaler in Alaba, a furniture showroom in Abuja, a building-materials
// yard in Kano and a general-merchandise retail chain in Lagos without a
// line of business-specific branching.
//
// ADDING A FIFTH VERTICAL is therefore a data change: append one entry to
// PROFILES below (or let a client define a CUSTOM profile at runtime via
// Settings -> Business Profile, which writes the same shape into the
// industry_profiles table). No migration, no new route, no new view.
// =====================================================================

// ---------------------------------------------------------------------
// BASE UNITS OF MEASURE
// ---------------------------------------------------------------------
// A furniture shop sells a "set"; a building-materials yard sells "bags"
// of cement and "lengths" of rebar; an electronics wholesaler sells
// "units". PharmaRidge's `base_unit` was a free-text column defaulting to
// 'tablet', which is why carton/pack maths was bolted on separately.
// StockRidge makes the unit first-class and gives every profile a sane
// default so a cashier never has to think about it.
const BASE_UNITS = Object.freeze([
  { code: 'PIECE',   label: 'Piece',        plural: 'pieces',  abbrev: 'pc'   },
  { code: 'UNIT',    label: 'Unit',         plural: 'units',   abbrev: 'u'    },
  { code: 'SET',     label: 'Set',          plural: 'sets',    abbrev: 'set'  },
  { code: 'PAIR',    label: 'Pair',         plural: 'pairs',   abbrev: 'pr'   },
  { code: 'METRE',   label: 'Metre',        plural: 'metres',  abbrev: 'm'    },
  { code: 'SQUARE_METRE', label: 'Square metre', plural: 'square metres', abbrev: 'm²' },
  { code: 'CUBIC_METRE',  label: 'Cubic metre',  plural: 'cubic metres',  abbrev: 'm³' },
  { code: 'KILOGRAM',     label: 'Kilogram',     plural: 'kilograms',     abbrev: 'kg' },
  { code: 'GRAM',    label: 'Gram',         plural: 'grams',   abbrev: 'g'    },
  { code: 'LITRE',   label: 'Litre',        plural: 'litres',  abbrev: 'L'    },
  { code: 'BAG',     label: 'Bag',          plural: 'bags',    abbrev: 'bag'  },
  { code: 'ROLL',    label: 'Roll',         plural: 'rolls',   abbrev: 'roll' },
  { code: 'LENGTH',  label: 'Length',       plural: 'lengths', abbrev: 'len'  },
  { code: 'SHEET',   label: 'Sheet',        plural: 'sheets',  abbrev: 'sht'  },
  { code: 'BUNDLE',  label: 'Bundle',       plural: 'bundles', abbrev: 'bdl'  },
  { code: 'BOX',     label: 'Box',          plural: 'boxes',   abbrev: 'bx'   },
  { code: 'DOZEN',   label: 'Dozen',        plural: 'dozens',  abbrev: 'dz'   },
  { code: 'TABLET',  label: 'Tablet',       plural: 'tablets', abbrev: 'tab'  },
  { code: 'BOTTLE',  label: 'Bottle',       plural: 'bottles', abbrev: 'btl'  },
  { code: 'SACHET',  label: 'Sachet',       plural: 'sachets', abbrev: 'sch'  },
  { code: 'SERVICE', label: 'Service',      plural: 'services', abbrev: 'svc' },
]);

// ---------------------------------------------------------------------
// SELLING PACKAGING LADDER
// ---------------------------------------------------------------------
// PharmaRidge's [UOM] design: sell/discount at carton or pack level while
// stock decrements in base units. That is a genuinely good primitive and
// it is kept verbatim — it is exactly right for a wholesale appliance
// distributor selling "3 cartons" of irons. The only change is that the
// ladder is declared per profile so the UI can hide rungs that do not
// exist (nobody sells a "carton" of sofas).
const SELLING_UNITS = Object.freeze(['BASE_UNIT', 'PACK', 'CARTON', 'PALLET']);

// ---------------------------------------------------------------------
// CAPABILITIES
// ---------------------------------------------------------------------
// The complete set of switches any profile may declare. Every one maps to
// a real flow in the app; a false capability hides the UI *and* closes the
// route server-side (defence in depth — see assertCapability() in
// server/lib/capabilities.js).
const CAPABILITY_KEYS = Object.freeze([
  'serial_tracking',        // one row per physical item: IMEI, serial, asset tag
  'warranty_tracking',      // warranty terms per product + claims per serial/sale
  'expiry_tracking',        // shelf-life batches: paint, cement, adhesives, food
  'batch_lot_tracking',     // lot numbers for recall without expiry dates
  'installation_service',   // delivery job can include a fitter/installer
  'assembly_required',      // flat-pack furniture: sell kit, track assembly
  'instalment_plans',       // Ajo/Esusu-style deferred payment agreements
  'layaway_holds',          // deposit now, collect later; stock reserved
  'wholesale_tiers',        // price tiers by customer class (retail/wholesale/distributor)
  'credit_sales',           // debtor ledger + aging
  'credit_purchases',       // creditor ledger on POs
  'delivery_management',    // delivery jobs, vehicles, proof of delivery
  'compliance_certificates',// SONCAP / SON / MAN / NAFDAC style register
  'multi_branch',           // branch transfers, per-branch pricing, consolidation
  'attendance',             // clock in/out with geofence or registered device
  'branch_safe',            // reserve cash ledger separate from the till
  'vat',                    // 7.5% FIRS VAT, inclusive-pricing model
  'withholding_tax',        // Deduction of Tax at Source (Withholding) Regulations 2024
  'general_ledger',         // double-entry chart of accounts, trial balance, P&L
]);

function caps(...keys) {
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = keys.includes(k);
  return Object.freeze(out);
}

// The near-universal retail baseline. Deliberately generous: a capability
// that is OFF is a feature the client cannot reach, so the default posture
// for a *general* Nigerian business app is "on unless it is meaningless".
const RETAIL_BASELINE = CAPABILITY_KEYS.filter((k) => k !== 'serial_tracking' && k !== 'warranty_tracking' && k !== 'installation_service');

// ---------------------------------------------------------------------
// THE FOUR SHIPPING PROFILES
// ---------------------------------------------------------------------
const PROFILES = Object.freeze([
  {
    code: 'ELECTRONICS_APPLIANCES',
    label: 'Electronics, Appliances & Gadgets',
    short_label: 'Electronics',
    blurb: 'Wholesale/retail of phones, laptops, home appliances, TVs, solar and accessories. Alaba, Ikeja Computer Village, online gadget stores.',
    icon: 'tv',
    accent: '#1565d8',
    base_unit_default: 'UNIT',
    selling_units: SELLING_UNITS,                 // unit -> pack -> carton -> pallet
    capabilities: caps(...RETAIL_BASELINE, 'serial_tracking', 'warranty_tracking', 'installation_service', 'batch_lot_tracking'),
    warranty_default_months: 12,
    warranty_terms_default: 'Manufacturer warranty. Physical damage, water ingress and unauthorised repair void cover.',
    compliance: Object.freeze({
      regulator: 'Standards Organisation of Nigeria (SON)',
      scheme: 'SONCAP',
      certificate_label: 'SONCAP Certificate No.',
      register_label: 'Product Compliance Register',
      register_reason: 'Mandatory Conformity Assessment Programme certificate for imported regulated electrical/electronic goods.',
      requires_expiry: true,
      expiry_label: 'SONCAP certificate expiry',
    }),
    customer_tiers: Object.freeze(['WALK_IN', 'RETAIL', 'WHOLESALE', 'DISTRIBUTOR', 'CORPORATE']),
    default_categories: Object.freeze([
      { code: 'MOBILE_PHONES',   label: 'Mobile Phones',        uom: 'UNIT' },
      { code: 'LAPTOPS_COMPUTERS', label: 'Laptops & Computers', uom: 'UNIT' },
      { code: 'HOME_APPLIANCES', label: 'Home Appliances',      uom: 'UNIT' },
      { code: 'KITCHEN_APPLIANCES', label: 'Kitchen Appliances', uom: 'UNIT' },
      { code: 'TV_AUDIO',        label: 'TV, Audio & Video',    uom: 'UNIT' },
      { code: 'SOLAR_POWER',     label: 'Solar, Inverters & Batteries', uom: 'UNIT' },
      { code: 'GENERATORS',      label: 'Generators & Engines', uom: 'UNIT' },
      { code: 'PHONE_ACCESSORIES', label: 'Phone Accessories',  uom: 'PIECE' },
      { code: 'COMPUTER_ACCESSORIES', label: 'Computer Accessories', uom: 'PIECE' },
      { code: 'CABLES_CONNECTORS', label: 'Cables & Connectors', uom: 'PIECE' },
      { code: 'GAMING',          label: 'Gaming & Consoles',    uom: 'UNIT' },
      { code: 'CAMERAS',         label: 'Cameras & Photography', uom: 'UNIT' },
      { code: 'SMART_HOME',      label: 'Smart Home & Security', uom: 'UNIT' },
      { code: 'SPARE_PARTS',     label: 'Spare Parts',          uom: 'PIECE' },
    ]),
    product_fields: Object.freeze([
      { key: 'brand',              label: 'Brand',              type: 'text',     required: false, searchable: true  },
      { key: 'model_number',       label: 'Model number',       type: 'text',     required: false, searchable: true  },
      { key: 'colour',             label: 'Colour',             type: 'text',     required: false, searchable: false },
      { key: 'storage_capacity',   label: 'Storage',            type: 'text',     required: false, searchable: false },
      { key: 'screen_size_inches', label: 'Screen size (inches)', type: 'number', required: false, searchable: false },
      { key: 'power_watts',        label: 'Power (W)',          type: 'number',   required: false, searchable: false },
      { key: 'voltage',            label: 'Voltage',            type: 'text',     required: false, searchable: false },
      { key: 'imei_or_serial_prefix', label: 'IMEI/Serial prefix', type: 'text',  required: false, searchable: true  },
      { key: 'warranty_months',    label: 'Warranty (months)',  type: 'number',   required: false, searchable: false },
    ]),
  },

  {
    code: 'FURNITURE_HOME',
    label: 'Furniture & Home Furnishing',
    short_label: 'Furniture',
    blurb: 'Showrooms and workshops selling sofas, beds, wardrobes, office furniture, curtains and fittings. Often made-to-order and delivered/installed.',
    icon: 'sofa',
    accent: '#8a5a2b',
    base_unit_default: 'SET',
    selling_units: Object.freeze(['BASE_UNIT', 'PACK']),   // a "carton of sofas" does not exist
    capabilities: caps(...RETAIL_BASELINE, 'assembly_required', 'installation_service', 'batch_lot_tracking'),
    warranty_default_months: 24,
    warranty_terms_default: 'Workmanship warranty. Excludes normal wear, misuse, exposure to weather and customer-supplied fabric.',
    compliance: Object.freeze({
      regulator: 'Standards Organisation of Nigeria (SON)',
      scheme: 'SON',
      certificate_label: 'SON / MAN registration no.',
      register_label: 'Materials & Finish Register',
      register_reason: 'Foam flammability, timber treatment and fabric safety declarations requested by corporate and government buyers.',
      requires_expiry: false,
      expiry_label: null,
    }),
    customer_tiers: Object.freeze(['WALK_IN', 'RETAIL', 'WHOLESALE', 'CORPORATE', 'PROJECT']),
    default_categories: Object.freeze([
      { code: 'SOFA_SEATING',    label: 'Sofas & Seating',      uom: 'SET'   },
      { code: 'BEDS_MATTRESSES', label: 'Beds & Mattresses',    uom: 'PIECE' },
      { code: 'WARDROBES_STORAGE', label: 'Wardrobes & Storage', uom: 'PIECE' },
      { code: 'DINING',          label: 'Dining Sets',          uom: 'SET'   },
      { code: 'OFFICE_FURNITURE', label: 'Office Furniture',    uom: 'PIECE' },
      { code: 'OUTDOOR_GARDEN',  label: 'Outdoor & Garden',     uom: 'PIECE' },
      { code: 'KITCHEN_CABINETRY', label: 'Kitchen & Cabinetry', uom: 'PIECE' },
      { code: 'CURTAINS_BLINDS', label: 'Curtains, Blinds & Upholstery', uom: 'METRE' },
      { code: 'LIGHTING',        label: 'Lighting & Fixtures',  uom: 'PIECE' },
      { code: 'RUGS_CARPETS',    label: 'Rugs & Carpets',       uom: 'SQUARE_METRE' },
      { code: 'HOME_DECOR',      label: 'Home Décor & Accessories', uom: 'PIECE' },
      { code: 'CUSTOM_MADE_TO_ORDER', label: 'Made-to-Order / Bespoke', uom: 'SET' },
    ]),
    product_fields: Object.freeze([
      { key: 'material',         label: 'Material / finish',  type: 'text',   required: false, searchable: true  },
      { key: 'colour',           label: 'Colour / fabric',    type: 'text',   required: false, searchable: false },
      { key: 'dimensions_cm',    label: 'Dimensions (WxDxH cm)', type: 'text', required: false, searchable: false },
      { key: 'seat_capacity',    label: 'Seating capacity',   type: 'number', required: false, searchable: false },
      { key: 'assembly_required', label: 'Assembly required', type: 'boolean', required: false, searchable: false },
      { key: 'lead_time_days',   label: 'Made-to-order lead time (days)', type: 'number', required: false, searchable: false },
      { key: 'delivery_class',   label: 'Delivery class',     type: 'select', options: ['SMALL', 'MEDIUM', 'LARGE', 'BULKY'], required: false, searchable: false },
      { key: 'warranty_months',  label: 'Warranty (months)',  type: 'number', required: false, searchable: false },
    ]),
  },

  {
    code: 'GENERAL_RETAIL_WHOLESALE',
    label: 'General Merchandise — Wholesale & Retail',
    short_label: 'Wholesale / Retail',
    blurb: 'Supermarkets, provision stores, distributors and wholesalers moving fast consumer goods in cartons, packs and pallets across several branches.',
    icon: 'cart',
    accent: '#0f8a5f',
    base_unit_default: 'PIECE',
    selling_units: SELLING_UNITS,
    capabilities: caps(...RETAIL_BASELINE, 'expiry_tracking', 'batch_lot_tracking'),
    warranty_default_months: 0,
    warranty_terms_default: null,
    compliance: Object.freeze({
      regulator: 'NAFDAC / Standards Organisation of Nigeria',
      scheme: 'NAFDAC',
      certificate_label: 'NAFDAC registration no.',
      register_label: 'Regulated Goods Register',
      register_reason: 'Registration numbers for food, cosmetics and regulated consumables, kept for inspection and for customer confidence.',
      requires_expiry: true,
      expiry_label: 'Registration expiry',
    }),
    customer_tiers: Object.freeze(['WALK_IN', 'RETAIL', 'WHOLESALE', 'SUB_DEALER', 'DISTRIBUTOR', 'CORPORATE']),
    default_categories: Object.freeze([
      { code: 'FOODSTUFFS',      label: 'Foodstuffs & Groceries', uom: 'PIECE' },
      { code: 'BEVERAGES',       label: 'Beverages',              uom: 'BOTTLE' },
      { code: 'HOUSEHOLD',       label: 'Household & Cleaning',   uom: 'PIECE' },
      { code: 'PERSONAL_CARE',   label: 'Personal Care & Cosmetics', uom: 'PIECE' },
      { code: 'BABY_PRODUCTS',   label: 'Baby Products',          uom: 'PIECE' },
      { code: 'STATIONERY',      label: 'Stationery & Office Supplies', uom: 'PIECE' },
      { code: 'ELECTRICALS',     label: 'Electricals & Bulbs',    uom: 'PIECE' },
      { code: 'PROVISIONS',      label: 'Provisions & Confectionery', uom: 'SACHET' },
      { code: 'DRINKS_CARTONS',  label: 'Drinks (carton trade)',  uom: 'PIECE' },
      { code: 'OTHERS',          label: 'Others',                 uom: 'PIECE' },
    ]),
    product_fields: Object.freeze([
      { key: 'brand',          label: 'Brand',          type: 'text',   required: false, searchable: true  },
      { key: 'pack_size',      label: 'Pack size',      type: 'text',   required: false, searchable: false },
      { key: 'shelf_life_days', label: 'Shelf life (days)', type: 'number', required: false, searchable: false },
      { key: 'storage_condition', label: 'Storage',     type: 'select', options: ['AMBIENT', 'COOL', 'REFRIGERATED', 'FROZEN'], required: false, searchable: false },
      { key: 'nafdac_reg_no',  label: 'NAFDAC reg. no.', type: 'text',  required: false, searchable: true  },
      { key: 'supplier_item_code', label: 'Supplier item code', type: 'text', required: false, searchable: true },
    ]),
  },

  {
    code: 'BUILDING_MATERIALS',
    label: 'Building Materials & Hardware',
    short_label: 'Building Materials',
    blurb: 'Cement yards, steel/roofing dealers, plumbing and electrical hardware. Sold by bag, length, sheet and cubic metre, usually with site delivery.',
    icon: 'brick',
    accent: '#c2410c',
    base_unit_default: 'BAG',
    selling_units: SELLING_UNITS,
    capabilities: caps(...RETAIL_BASELINE, 'expiry_tracking', 'batch_lot_tracking', 'delivery_management'),
    warranty_default_months: 0,
    warranty_terms_default: null,
    compliance: Object.freeze({
      regulator: 'Standards Organisation of Nigeria (SON)',
      scheme: 'SON',
      certificate_label: 'SON conformity certificate no.',
      register_label: 'Materials Conformity Register',
      register_reason: 'Cement, steel and roofing conformity certificates demanded by engineers, consultants and government contracts.',
      requires_expiry: false,
      expiry_label: null,
    }),
    customer_tiers: Object.freeze(['WALK_IN', 'RETAIL', 'CONTRACTOR', 'WHOLESALE', 'PROJECT', 'GOVERNMENT']),
    default_categories: Object.freeze([
      { code: 'CEMENT_BINDERS',  label: 'Cement & Binders',     uom: 'BAG'   },
      { code: 'STEEL_REBAR',     label: 'Steel, Rebar & Rods',  uom: 'LENGTH' },
      { code: 'ROOFING',         label: 'Roofing Sheets & Accessories', uom: 'SHEET' },
      { code: 'BLOCKS_BRICKS',   label: 'Blocks, Bricks & Stones', uom: 'PIECE' },
      { code: 'SAND_GRAVEL',     label: 'Sand, Gravel & Aggregate', uom: 'CUBIC_METRE' },
      { code: 'TIMBER',          label: 'Timber & Wood',        uom: 'LENGTH' },
      { code: 'PLUMBING',        label: 'Plumbing & Pipes',     uom: 'LENGTH' },
      { code: 'ELECTRICAL_INSTALL', label: 'Electrical Installation', uom: 'PIECE' },
      { code: 'PAINTS_COATINGS', label: 'Paints & Coatings',    uom: 'LITRE' },
      { code: 'TILES_FLOORING',  label: 'Tiles & Flooring',     uom: 'SQUARE_METRE' },
      { code: 'DOORS_WINDOWS',   label: 'Doors, Windows & Frames', uom: 'PIECE' },
      { code: 'TOOLS_HARDWARE',  label: 'Tools & Hardware',     uom: 'PIECE' },
      { code: 'SAFETY_EQUIPMENT', label: 'Safety Equipment (PPE)', uom: 'PIECE' },
    ]),
    product_fields: Object.freeze([
      { key: 'grade',          label: 'Grade / specification', type: 'text', required: false, searchable: true },
      { key: 'size_mm',        label: 'Size (mm)',             type: 'text', required: false, searchable: false },
      { key: 'weight_kg',      label: 'Weight (kg)',           type: 'number', required: false, searchable: false },
      { key: 'origin',         label: 'Origin / mill',         type: 'text', required: false, searchable: true },
      { key: 'shelf_life_days', label: 'Shelf life (days)',    type: 'number', required: false, searchable: false },
      { key: 'delivery_class', label: 'Delivery class',        type: 'select', options: ['SMALL', 'MEDIUM', 'LARGE', 'BULKY'], required: false, searchable: false },
    ]),
  },

  // Kept so a migrating PharmaRidge client is a profile switch, not a
  // rewrite. Same capabilities the pharmacy schema implied.
  {
    code: 'PHARMACY_HEALTH',
    label: 'Pharmacy & Patent Medicine',
    short_label: 'Pharmacy',
    blurb: 'Retail pharmacy / PPMV. Provided for continuity with PharmaRidge deployments and for chemist counters inside general stores.',
    icon: 'cross',
    accent: '#0a3b2c',
    base_unit_default: 'TABLET',
    selling_units: Object.freeze(['BASE_UNIT', 'PACK', 'CARTON']),
    capabilities: caps(...RETAIL_BASELINE, 'expiry_tracking', 'batch_lot_tracking'),
    warranty_default_months: 0,
    warranty_terms_default: null,
    compliance: Object.freeze({
      regulator: 'Pharmacy Council of Nigeria (PCN) / NAFDAC',
      scheme: 'PCN',
      certificate_label: 'PCN / NAFDAC licence no.',
      register_label: 'Controlled & Regulated Stock Register',
      register_reason: 'PCN premises licence and NAFDAC registration, with the controlled-substance register for scheduled products.',
      requires_expiry: true,
      expiry_label: 'Licence expiry',
    }),
    customer_tiers: Object.freeze(['WALK_IN', 'RETAIL', 'WHOLESALE', 'HOSPITAL', 'CORPORATE']),
    default_categories: Object.freeze([
      { code: 'PHARMACEUTICALS', label: 'Pharmaceuticals', uom: 'TABLET' },
      { code: 'FOOD_DRINKS',     label: 'Food & Drinks',   uom: 'PIECE'  },
      { code: 'ACCESSORIES',     label: 'Accessories',     uom: 'PIECE'  },
      { code: 'BEAUTY_PERSONAL_CARE', label: 'Beauty & Personal Care', uom: 'PIECE' },
      { code: 'OTHERS',          label: 'Others',          uom: 'PIECE'  },
    ]),
    product_fields: Object.freeze([
      { key: 'generic_name',    label: 'Generic name',    type: 'text',   required: false, searchable: true },
      { key: 'nafdac_reg_no',   label: 'NAFDAC reg. no.', type: 'text',   required: false, searchable: true },
      { key: 'dispensing_type', label: 'Dispensing type', type: 'select', options: ['OTC', 'POM'], required: false, searchable: false },
      { key: 'strength',        label: 'Strength',        type: 'text',   required: false, searchable: false },
      { key: 'shelf_life_days', label: 'Shelf life (days)', type: 'number', required: false, searchable: false },
    ]),
  },
]);

const PROFILE_CODES = new Set(PROFILES.map((p) => p.code));
const DEFAULT_PROFILE_CODE = 'GENERAL_RETAIL_WHOLESALE';

function getProfile(code) {
  if (!code) return null;
  return PROFILES.find((p) => p.code === String(code).trim().toUpperCase()) || null;
}

function requireProfile(code) {
  const p = getProfile(code);
  if (!p) {
    const err = new Error(`Unknown business profile "${code}". Valid profiles: ${PROFILES.map((x) => x.code).join(', ')}`);
    err.status = 400; err.code = 'UNKNOWN_INDUSTRY_PROFILE';
    throw err;
  }
  return p;
}

function defaultProfile() { return getProfile(DEFAULT_PROFILE_CODE); }

function profileSummary(p) {
  return {
    code: p.code, label: p.label, short_label: p.short_label, blurb: p.blurb,
    icon: p.icon, accent: p.accent, base_unit_default: p.base_unit_default,
    selling_units: p.selling_units, capabilities: p.capabilities,
    warranty_default_months: p.warranty_default_months,
    warranty_terms_default: p.warranty_terms_default,
    compliance: p.compliance, customer_tiers: p.customer_tiers,
    category_count: p.default_categories.length,
    field_count: p.product_fields.length,
  };
}

module.exports = {
  PROFILES, PROFILE_CODES, DEFAULT_PROFILE_CODE, CAPABILITY_KEYS, BASE_UNITS, SELLING_UNITS,
  getProfile, requireProfile, defaultProfile, profileSummary,
};
'use strict';
