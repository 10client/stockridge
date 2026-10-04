// =====================================================================
// shared/lib/verticals.js — BUSINESS VERTICAL PROFILES
// =====================================================================
//
// THIS FILE IS THE ANSWER TO "HOW DO YOU TURN A PHARMACY SYSTEM INTO A
// GENERAL RETAIL SYSTEM WITHOUT LOSING THE RIGOUR".
//
// PharmaRidge hard-coded its domain in roughly nine places:
//   products.dispensing_type  CHECK (OTC|POM)      -> gate on prescriptions
//   products.is_controlled    INTEGER              -> controlled-drug register
//   products.nafdac_reg_no    TEXT                 -> NAFDAC compliance
//   products.retail_category  CHECK (5 pharmacy-   -> POS/report grouping
//                             adjacent buckets)
//   products.base_unit        DEFAULT 'tablet'
//   stock_batches.expiry_date                      -> expiry alerts view
//   branches.pcn_license_*                         -> licence-expiry alerts
//   controlled_substance_register                  -> hash-chained audit log
//   prescriptions                                  -> prescriber/patient record
//
// Naively deleting all of it would throw away the *reasons* those fields
// existed. Each one encoded a real control:
//   dispensing_type  = "this line needs an authorising document before sale"
//   is_controlled    = "this line needs a tamper-evident register entry"
//   expiry_date      = "this stock loses value or becomes unsellable on a date"
//   licence expiry   = "the premises itself has a permission that lapses"
//
// StockRidge therefore keeps the CONTROL and makes the DOMAIN DATA.
// The four abstractions that replace nine hard-coded fields:
//
//   1. restricted_sale_reason  (was dispensing_type)
//        NONE / AGE_VERIFICATION / SERIAL_CAPTURE / AUTHORITY_DOCUMENT
//        A gadget needs a serial captured. A generator needs a warranty card.
//        Liquor/tobacco in a general store needs age verification. Cement
//        sold to a contractor may need an authority document. Same gate
//        mechanism in the POS, four different reasons.
//
//   2. register_required       (was is_controlled)
//        High-theft or high-value lines are written to the SAME hash-chained,
//        append-only register (high_value_register). Laptops, phones,
//        generators, mattresses bought on credit — the buyer's identity and
//        the serial are recorded and the chain cannot be edited afterwards.
//
//   3. shelf_life tracking     (was expiry_date)
//        Generalised to `best_before_date` + `shelf_life_days`. Applies to
//        food and drink in the wholesale vertical, paint and adhesive in
//        building materials, foam in furniture. The FEFO picking order and the
//        near-expiry alert view are UNCHANGED — they just no longer assume the
//        product is a medicine.
//
//   4. compliance_certificates (was pcn_license_* on branches)
//        A generic table of dated obligations per business/branch: CAC, SON,
//        SONCAP, NAFDAC, state trading permit, fire safety, LG signage levy.
//        The expiry-alert view is one query over that table instead of two
//        hard-coded columns.
//
// A vertical is DATA, not a code path. There is no `if (vertical === 'ELECTRONICS')`
// anywhere in the application — the POS, receiving, pricing and reporting code
// reads the profile and behaves. Adding a fifth vertical (e.g. spare parts,
// agro-inputs, a bakery) is a new entry in VERTICALS plus a seed, not a
// migration and not a route change.

'use strict';

// ---------------------------------------------------------------------
// UNITS
// ---------------------------------------------------------------------
// A unit has a code, a plural label, and an optional `dimension` used by the
// delivery/pricing engine (BULKY units attract a delivery fee and often need
// two people to unload; COUNTED units do not).
const UNIT_LIBRARY = Object.freeze({
  PIECE:      { code: 'PIECE',      label: 'piece',       plural: 'pieces',       dimension: 'COUNTED' },
  UNIT:       { code: 'UNIT',       label: 'unit',        plural: 'units',        dimension: 'COUNTED' },
  SET:        { code: 'SET',        label: 'set',         plural: 'sets',         dimension: 'BULKY' },
  PAIR:       { code: 'PAIR',       label: 'pair',        plural: 'pairs',        dimension: 'COUNTED' },
  DOZEN:      { code: 'DOZEN',      label: 'dozen',       plural: 'dozen',        dimension: 'COUNTED' },
  PACK:       { code: 'PACK',       label: 'pack',        plural: 'packs',        dimension: 'COUNTED' },
  CARTON:     { code: 'CARTON',     label: 'carton',      plural: 'cartons',      dimension: 'BULKY' },
  BAG:        { code: 'BAG',        label: 'bag',         plural: 'bags',         dimension: 'BULKY' },
  BOX:        { code: 'BOX',        label: 'box',         plural: 'boxes',        dimension: 'BULKY' },
  ROLL:       { code: 'ROLL',       label: 'roll',        plural: 'rolls',        dimension: 'BULKY' },
  BUNDLE:     { code: 'BUNDLE',     label: 'bundle',      plural: 'bundles',      dimension: 'BULKY' },
  LENGTH:     { code: 'LENGTH',     label: 'length',      plural: 'lengths',      dimension: 'BULKY' },
  SHEET:      { code: 'SHEET',      label: 'sheet',       plural: 'sheets',       dimension: 'BULKY' },
  BALE:       { code: 'BALE',       label: 'bale',        plural: 'bales',        dimension: 'BULKY' },
  KG:         { code: 'KG',         label: 'kg',          plural: 'kg',           dimension: 'WEIGHED' },
  TONNE:      { code: 'TONNE',      label: 'tonne',       plural: 'tonnes',       dimension: 'WEIGHED' },
  LITRE:      { code: 'LITRE',      label: 'litre',       plural: 'litres',       dimension: 'WEIGHED' },
  METRE:      { code: 'METRE',      label: 'metre',       plural: 'metres',       dimension: 'MEASURED' },
  SQUARE_METRE: { code: 'SQUARE_METRE', label: 'square metre', plural: 'square metres', dimension: 'MEASURED' },
  CUBIC_METRE:  { code: 'CUBIC_METRE',  label: 'cubic metre',  plural: 'cubic metres',  dimension: 'MEASURED' },
});

// ---------------------------------------------------------------------
// SELLING UNITS  (the UOM ladder — identical mechanics to PharmaRidge's
// BASE_UNIT / PACK / CARTON, with PALLET added because wholesale appliances
// and cement both arrive by the pallet)
// ---------------------------------------------------------------------
const SELLING_UNITS = Object.freeze(['BASE_UNIT', 'PACK', 'CARTON', 'PALLET']);
const SELLING_UNIT_LABELS = Object.freeze({
  BASE_UNIT: 'Piece', PACK: 'Pack', CARTON: 'Carton', PALLET: 'Pallet',
});

// ---------------------------------------------------------------------
// WHO MAY BUY, AND AT WHAT PRICE
// ---------------------------------------------------------------------
// `selling_pattern` decides whether the POS will even offer a wholesale price
// for a line. Cement is wholesale-first; a 65" TV is retail-first but a
// hotel fit-out buys ten of them.
const SELLING_PATTERNS = Object.freeze(['RETAIL_ONLY', 'WHOLESALE_ONLY', 'BOTH']);

// Customer classes drive the price tier. Every class has a DEFAULT discount
// per category that the owner can override; the override lives in
// customer_price_tiers, not here, so a client's own commercial policy is
// client data.
const CUSTOMER_CLASSES = Object.freeze([
  { code: 'RETAIL',      label: 'Retail (walk-in)',      defaultDiscountPercent: 0,   creditAllowed: false },
  { code: 'TRADE',       label: 'Trade / artisan',       defaultDiscountPercent: 3,   creditAllowed: true },
  { code: 'WHOLESALE',   label: 'Wholesaler',            defaultDiscountPercent: 7,   creditAllowed: true },
  { code: 'DISTRIBUTOR', label: 'Distributor / dealer',  defaultDiscountPercent: 12,  creditAllowed: true },
  { code: 'CORPORATE',   label: 'Corporate / project',   defaultDiscountPercent: 5,   creditAllowed: true },
  { code: 'STAFF',       label: 'Staff purchase',        defaultDiscountPercent: 10,  creditAllowed: false },
]);
const CUSTOMER_CLASS_CODES = new Set(CUSTOMER_CLASSES.map((c) => c.code));

// ---------------------------------------------------------------------
// SALE-RESTRICTION REASONS  (replaces dispensing_type)
// ---------------------------------------------------------------------
const RESTRICTION_REASONS = Object.freeze([
  { code: 'NONE',              label: 'No restriction',                       requires: null },
  // POS will not complete the line until the operator confirms the buyer's
  // stated age. Used for alcohol, tobacco, aerosols, solvent-based paint and
  // anything a state regulator has age-restricted.
  { code: 'AGE_VERIFICATION',  label: 'Age verification required',            requires: 'age_confirmed' },
  // POS will not complete the line until a serial/IMEI is captured for each
  // unit. Phones, laptops, appliances, cylinders, generators.
  { code: 'SERIAL_CAPTURE',    label: 'Serial number must be captured',       requires: 'serials' },
  // POS will not complete the line until an authorising document is recorded:
  // a purchase order, a works instruction, a consultant's approval, a
  // contractor's letter. Project sales and government supply.
  { code: 'AUTHORITY_DOCUMENT', label: 'Authorising document required',        requires: 'authority_document' },
]);
const RESTRICTION_CODES = new Set(RESTRICTION_REASONS.map((r) => r.code));

// ---------------------------------------------------------------------
// ATTRIBUTE SCHEMAS
// ---------------------------------------------------------------------
// A vertical declares the structured attributes its products carry. These
// render as real form fields (not one big JSON textarea), are searchable, and
// are what makes "filter to 55 inch, Smart, 4K" possible instead of a LIKE
// query over a description.
const FIELD_TYPES = Object.freeze(['TEXT', 'NUMBER', 'SELECT', 'BOOLEAN', 'DATE']);

// =====================================================================
// THE FOUR SHIPPING VERTICALS
// =====================================================================

const ELECTRONICS = Object.freeze({
  code: 'ELECTRONICS',
  label: 'Electronics, Appliances & Gadgets',
  shortLabel: 'Electronics & Gadgets',
  blurb: 'Phones, laptops, TVs, fridges, generators, inverters, solar and accessories.',
  defaultCurrency: 'NGN',
  // Serial tracking is the whole point of this vertical: warranty, theft
  // deterrence, grey-market tracing and insurance all key off the serial.
  serialTrackingDefault: true,
  warrantyDefault: true,
  deliveryDefault: true,
  installationDefault: true,
  layawayDefault: true,
  instalmentDefault: true,
  shelfLifeDefault: false,
  bulkHandlingDefault: true,
  baseUnitDefault: 'UNIT',
  sellingPatternDefault: 'BOTH',
  restrictionDefault: 'SERIAL_CAPTURE',
  units: ['UNIT', 'PIECE', 'SET', 'PAIR', 'PACK', 'CARTON', 'BOX'],
  categories: Object.freeze([
    { code: 'PHONES_TABLETS',     label: 'Phones & Tablets',        shelfLife: false, registerRequired: true },
    { code: 'COMPUTING',          label: 'Computers & Accessories', shelfLife: false, registerRequired: true },
    { code: 'TV_HOME_ENT',        label: 'TV & Home Entertainment', shelfLife: false, registerRequired: true },
    { code: 'MAJOR_APPLIANCES',   label: 'Major Appliances',        shelfLife: false, registerRequired: true },
    { code: 'SMALL_APPLIANCES',   label: 'Small Appliances',        shelfLife: false, registerRequired: false },
    { code: 'KITCHEN_APPLIANCES', label: 'Kitchen Appliances',      shelfLife: false, registerRequired: false },
    { code: 'COOLING_AIR',        label: 'Cooling & Air Conditioning', shelfLife: false, registerRequired: true },
    { code: 'POWER_GENERATION',   label: 'Generators & Power',      shelfLife: false, registerRequired: true },
    { code: 'SOLAR_INVERTER',     label: 'Solar & Inverters',       shelfLife: false, registerRequired: true },
    { code: 'AUDIO',              label: 'Audio & Sound',           shelfLife: false, registerRequired: false },
    { code: 'GAMING',             label: 'Gaming',                  shelfLife: false, registerRequired: true },
    { code: 'CAMERAS',            label: 'Cameras & Photography',   shelfLife: false, registerRequired: true },
    { code: 'WEARABLES',          label: 'Wearables',               shelfLife: false, registerRequired: false },
    { code: 'HOME_SECURITY',      label: 'Home Security & CCTV',    shelfLife: false, registerRequired: false },
    { code: 'NETWORKING',         label: 'Networking & Storage',    shelfLife: false, registerRequired: false },
    { code: 'ACCESSORIES',        label: 'Cables, Chargers & Accessories', shelfLife: false, registerRequired: false },
    { code: 'SPARE_PARTS',        label: 'Spare Parts',             shelfLife: false, registerRequired: false },
  ]),
  attributeSchema: Object.freeze([
    { key: 'brand',        label: 'Brand',        type: 'TEXT',   required: true,  searchable: true },
    { key: 'model',        label: 'Model number', type: 'TEXT',   required: true,  searchable: true },
    { key: 'colour',       label: 'Colour',       type: 'TEXT',   required: false, searchable: true },
    { key: 'screen_size',  label: 'Screen size (inches)', type: 'NUMBER', required: false, searchable: true },
    { key: 'capacity',     label: 'Capacity (L / kg)',    type: 'NUMBER', required: false, searchable: true },
    { key: 'storage_gb',   label: 'Storage (GB)',   type: 'NUMBER', required: false, searchable: true },
    { key: 'ram_gb',       label: 'RAM (GB)',       type: 'NUMBER', required: false, searchable: true },
    { key: 'wattage',      label: 'Power (W)',      type: 'NUMBER', required: false, searchable: true },
    { key: 'voltage',      label: 'Voltage',        type: 'SELECT', required: false, searchable: true,
      options: ['220-240V', '110-120V', '12V DC', '24V DC', 'Dual'] },
    { key: 'energy_rating', label: 'Energy rating', type: 'SELECT', required: false, searchable: true,
      options: ['A+++', 'A++', 'A+', 'A', 'B', 'C', 'D', 'Not rated'] },
    { key: 'warranty_months', label: 'Warranty (months)', type: 'NUMBER', required: false, searchable: false },
    { key: 'soncap_pc',    label: 'SONCAP PC no.',  type: 'TEXT',   required: false, searchable: false },
    { key: 'country_of_origin', label: 'Country of origin', type: 'TEXT', required: false, searchable: true },
  ]),
  complianceTypes: Object.freeze(['CAC', 'SON', 'SONCAP', 'STATE_TRADING_PERMIT', 'FIRE_SAFETY', 'LG_SIGNAGE', 'NCC_TYPE_APPROVAL', 'OTHER']),
  warrantyStatuses: Object.freeze(['IN_WARRANTY', 'OUT_OF_WARRANTY', 'VOID', 'PENDING_CLAIM', 'UNDER_REPAIR', 'REPLACED', 'REFUNDED']),
  notes: 'SONCAP is mandatory for imported regulated electricals. Serial capture is on by default for anything with a warranty.',
});

const FURNITURE = Object.freeze({
  code: 'FURNITURE',
  label: 'Furniture, Home & Office',
  shortLabel: 'Furniture & Home',
  blurb: 'Sofas, beds, wardrobes, office chairs, mattresses, curtains and fittings.',
  defaultCurrency: 'NGN',
  serialTrackingDefault: false,
  warrantyDefault: true,
  deliveryDefault: true,
  installationDefault: true,   // assembly on site
  layawayDefault: true,        // "pay small-small, we hold the sofa"
  instalmentDefault: true,
  shelfLifeDefault: false,
  bulkHandlingDefault: true,
  baseUnitDefault: 'PIECE',
  sellingPatternDefault: 'RETAIL_ONLY',
  restrictionDefault: 'NONE',
  units: ['PIECE', 'SET', 'PAIR', 'CARTON', 'ROLL', 'METRE', 'SQUARE_METRE'],
  categories: Object.freeze([
    { code: 'LIVING_ROOM',   label: 'Living Room',        shelfLife: false, registerRequired: false },
    { code: 'BEDROOM',       label: 'Bedroom',            shelfLife: false, registerRequired: false },
    { code: 'MATTRESSES',    label: 'Mattresses & Bedding', shelfLife: false, registerRequired: true },
    { code: 'DINING',        label: 'Dining & Kitchen',   shelfLife: false, registerRequired: false },
    { code: 'OFFICE',        label: 'Office Furniture',   shelfLife: false, registerRequired: false },
    { code: 'OUTDOOR',       label: 'Outdoor & Garden',   shelfLife: false, registerRequired: false },
    { code: 'STORAGE',       label: 'Storage & Shelving', shelfLife: false, registerRequired: false },
    { code: 'SOFT_FURNISHING', label: 'Curtains, Rugs & Soft Furnishing', shelfLife: false, registerRequired: false },
    { code: 'LIGHTING',      label: 'Lighting',           shelfLife: false, registerRequired: false },
    { code: 'FITTINGS',      label: 'Handles, Hinges & Fittings', shelfLife: false, registerRequired: false },
    { code: 'KIDS',          label: 'Kids & Nursery',     shelfLife: false, registerRequired: false },
    { code: 'UPHOLSTERY_MATERIAL', label: 'Fabric, Foam & Leather', shelfLife: false, registerRequired: false },
    { code: 'CUSTOM_MADE',   label: 'Custom / Made-to-Order', shelfLife: false, registerRequired: false },
  ]),
  attributeSchema: Object.freeze([
    { key: 'brand',       label: 'Brand / maker',  type: 'TEXT',   required: false, searchable: true },
    { key: 'material',    label: 'Material',       type: 'SELECT', required: true,  searchable: true,
      options: ['Solid wood', 'Engineered wood', 'MDF', 'Metal', 'Plastic', 'Fabric', 'Leather', 'Faux leather', 'Glass', 'Rattan', 'Foam', 'Mixed'] },
    { key: 'wood_type',   label: 'Wood species',   type: 'TEXT',   required: false, searchable: true },
    { key: 'colour',      label: 'Colour / finish', type: 'TEXT',  required: false, searchable: true },
    { key: 'seater',      label: 'Seater / size',  type: 'SELECT', required: false, searchable: true,
      options: ['1-seater', '2-seater', '3-seater', '4-seater', '5-seater', '6-seater', 'L-shape', 'King', 'Queen', 'Double', 'Single', 'Not applicable'] },
    { key: 'dimensions_cm', label: 'Dimensions WxDxH (cm)', type: 'TEXT', required: false, searchable: false },
    { key: 'weight_kg',   label: 'Weight (kg)',    type: 'NUMBER', required: false, searchable: false },
    { key: 'assembly_required', label: 'Assembly required', type: 'BOOLEAN', required: false, searchable: false },
    { key: 'foam_density', label: 'Foam density',  type: 'TEXT',   required: false, searchable: true },
    { key: 'warranty_months', label: 'Warranty (months)', type: 'NUMBER', required: false, searchable: false },
    { key: 'fire_rating', label: 'Fire rating',    type: 'TEXT',   required: false, searchable: false },
  ]),
  complianceTypes: Object.freeze(['CAC', 'SON', 'STATE_TRADING_PERMIT', 'FIRE_SAFETY', 'LG_SIGNAGE', 'FOREST_PERMIT', 'OTHER']),
  warrantyStatuses: Object.freeze(['IN_WARRANTY', 'OUT_OF_WARRANTY', 'VOID', 'PENDING_CLAIM', 'UNDER_REPAIR', 'REPLACED', 'REFUNDED']),
  notes: 'Mattresses and foam are high-theft, high-value: registerRequired is on for that category. Made-to-order lines are quoted, then converted to a sale.',
});

const WHOLESALE_RETAIL = Object.freeze({
  code: 'WHOLESALE_RETAIL',
  label: 'Wholesale & Retail General Merchandise',
  shortLabel: 'Wholesale / Retail',
  blurb: 'Provisions, food & drinks, household, toiletries, textiles, stationery — sold by the piece, pack or carton.',
  defaultCurrency: 'NGN',
  serialTrackingDefault: false,
  warrantyDefault: false,
  deliveryDefault: true,
  installationDefault: false,
  layawayDefault: false,
  instalmentDefault: false,
  shelfLifeDefault: true,       // THIS vertical is where best-before matters
  bulkHandlingDefault: true,
  baseUnitDefault: 'PIECE',
  sellingPatternDefault: 'BOTH',
  restrictionDefault: 'NONE',
  units: ['PIECE', 'PACK', 'CARTON', 'BAG', 'BOX', 'DOZEN', 'ROLL', 'KG', 'LITRE', 'BALE'],
  categories: Object.freeze([
    { code: 'FOOD_PROVISIONS', label: 'Food & Provisions', shelfLife: true,  registerRequired: false },
    { code: 'BEVERAGES',       label: 'Drinks & Beverages', shelfLife: true, registerRequired: false },
    { code: 'ALCOHOL_TOBACCO', label: 'Alcohol & Tobacco',  shelfLife: true, registerRequired: true, restriction: 'AGE_VERIFICATION' },
    { code: 'HOUSEHOLD',       label: 'Household & Cleaning', shelfLife: true, registerRequired: false },
    { code: 'TOILETRIES_COSMETICS', label: 'Toiletries & Cosmetics', shelfLife: true, registerRequired: false },
    { code: 'BABY_PRODUCTS',   label: 'Baby Products',      shelfLife: true, registerRequired: false },
    { code: 'TEXTILES_APPAREL', label: 'Textiles & Apparel', shelfLife: false, registerRequired: false },
    { code: 'FOOTWEAR_BAGS',   label: 'Footwear & Bags',    shelfLife: false, registerRequired: false },
    { code: 'KITCHENWARE',     label: 'Kitchenware & Tableware', shelfLife: false, registerRequired: false },
    { code: 'PLASTICS',        label: 'Plastics & Storage', shelfLife: false, registerRequired: false },
    { code: 'STATIONERY',      label: 'Stationery & Books', shelfLife: false, registerRequired: false },
    { code: 'ELECTRICALS_SMALL', label: 'Bulbs, Batteries & Small Electricals', shelfLife: true, registerRequired: false },
    { code: 'AGRO_INPUTS',     label: 'Agro-inputs & Seeds', shelfLife: true, registerRequired: false },
    { code: 'OTHERS',          label: 'Others',             shelfLife: false, registerRequired: false },
  ]),
  attributeSchema: Object.freeze([
    { key: 'brand',       label: 'Brand',        type: 'TEXT',   required: false, searchable: true },
    { key: 'size',        label: 'Pack size',    type: 'TEXT',   required: true,  searchable: true },
    { key: 'flavour',     label: 'Flavour / variant', type: 'TEXT', required: false, searchable: true },
    { key: 'shelf_life_days', label: 'Shelf life (days)', type: 'NUMBER', required: false, searchable: false },
    { key: 'nafdac_reg_no', label: 'NAFDAC reg. no.', type: 'TEXT', required: false, searchable: false },
    { key: 'storage',     label: 'Storage condition', type: 'SELECT', required: false, searchable: false,
      options: ['Ambient', 'Cool dry place', 'Refrigerated', 'Frozen', 'Away from sunlight'] },
    { key: 'carton_weight_kg', label: 'Carton weight (kg)', type: 'NUMBER', required: false, searchable: false },
    { key: 'hs_code',     label: 'HS / tariff code', type: 'TEXT', required: false, searchable: false },
  ]),
  complianceTypes: Object.freeze(['CAC', 'NAFDAC', 'NAFDAC_PREMISES', 'SON', 'STATE_TRADING_PERMIT', 'LG_FOOD_HANDLING', 'FIRE_SAFETY', 'LIQUOR_LICENCE', 'OTHER']),
  warrantyStatuses: Object.freeze([]),
  notes: 'Wholesale-first: the carton price and the customer class discount do most of the work here. Age verification gates alcohol and tobacco lines.',
});

const BUILDING_MATERIALS = Object.freeze({
  code: 'BUILDING_MATERIALS',
  label: 'Building Materials & Hardware',
  shortLabel: 'Building & Hardware',
  blurb: 'Cement, iron rods, roofing, paint, plumbing, electrical, tiles, sand and granite.',
  defaultCurrency: 'NGN',
  serialTrackingDefault: false,
  warrantyDefault: false,
  deliveryDefault: true,        // tipper delivery is the core service
  installationDefault: false,
  layawayDefault: true,         // "I have paid for 200 bags, deliver in three trips"
  instalmentDefault: true,      // project supply on part-payment is normal
  shelfLifeDefault: true,       // cement, paint, adhesive, PVC solvent all expire
  bulkHandlingDefault: true,
  baseUnitDefault: 'BAG',
  sellingPatternDefault: 'BOTH',
  restrictionDefault: 'NONE',
  units: ['BAG', 'PIECE', 'LENGTH', 'SHEET', 'ROLL', 'KG', 'TONNE', 'LITRE', 'METRE', 'SQUARE_METRE', 'CUBIC_METRE', 'CARTON', 'BOX', 'BUNDLE'],
  categories: Object.freeze([
    { code: 'CEMENT_BINDERS',  label: 'Cement, Lime & Binders', shelfLife: true,  registerRequired: false },
    { code: 'STEEL_RODS',      label: 'Iron Rods & Steel',      shelfLife: false, registerRequired: false },
    { code: 'ROOFING',         label: 'Roofing Sheets & Accessories', shelfLife: false, registerRequired: false },
    { code: 'WOOD_TIMBER',     label: 'Wood, Plywood & Timber', shelfLife: false, registerRequired: false },
    { code: 'BLOCKS_STONES',   label: 'Blocks, Sand & Granite', shelfLife: false, registerRequired: false },
    { code: 'PAINT_COATINGS',  label: 'Paint & Coatings',       shelfLife: true,  registerRequired: false },
    { code: 'PLUMBING',        label: 'Plumbing & Pipes',       shelfLife: false, registerRequired: false },
    { code: 'ELECTRICAL_FITTINGS', label: 'Electrical Fittings & Cable', shelfLife: false, registerRequired: false },
    { code: 'TILES_FLOORING',  label: 'Tiles & Flooring',       shelfLife: false, registerRequired: false },
    { code: 'DOORS_WINDOWS',   label: 'Doors, Windows & Frames', shelfLife: false, registerRequired: false },
    { code: 'TOOLS',           label: 'Tools & Equipment',      shelfLife: false, registerRequired: true },
    { code: 'FASTENERS',       label: 'Nails, Screws & Fasteners', shelfLife: false, registerRequired: false },
    { code: 'WATER_STORAGE',   label: 'Water Tanks & Storage',  shelfLife: false, registerRequired: false },
    { code: 'SAFETY_GEAR',     label: 'Safety Gear (PPE)',      shelfLife: true,  registerRequired: false },
  ]),
  attributeSchema: Object.freeze([
    { key: 'brand',       label: 'Brand / mill', type: 'TEXT',   required: false, searchable: true },
    { key: 'grade',       label: 'Grade / strength', type: 'TEXT', required: false, searchable: true },
    { key: 'size_mm',     label: 'Size (mm)',    type: 'TEXT',   required: false, searchable: true },
    { key: 'weight_kg',   label: 'Unit weight (kg)', type: 'NUMBER', required: false, searchable: false },
    { key: 'bag_weight_kg', label: 'Bag weight (kg)', type: 'NUMBER', required: false, searchable: false },
    { key: 'gauge',       label: 'Gauge / thickness', type: 'TEXT', required: false, searchable: true },
    { key: 'colour',      label: 'Colour',       type: 'TEXT',   required: false, searchable: true },
    { key: 'shelf_life_days', label: 'Shelf life (days)', type: 'NUMBER', required: false, searchable: false },
    { key: 'son_standard', label: 'SON / NIS standard', type: 'TEXT', required: false, searchable: false },
    { key: 'origin',      label: 'Mill / origin', type: 'TEXT',  required: false, searchable: false },
  ]),
  complianceTypes: Object.freeze(['CAC', 'SON', 'SONCAP', 'NESREA', 'MINES_QUARRY_PERMIT', 'STATE_TRADING_PERMIT', 'LG_SIGNAGE', 'FIRE_SAFETY', 'OTHER']),
  warrantyStatuses: Object.freeze([]),
  notes: 'Weight-based units (tonne, kg, cubic metre) need fractional quantities, so this vertical allows decimal base quantities where the others do not.',
});

const VERTICALS = Object.freeze([
  ELECTRONICS, FURNITURE, WHOLESALE_RETAIL, BUILDING_MATERIALS,
]);

const VERTICAL_CODES = new Set(VERTICALS.map((v) => v.code));
const VERTICAL_BY_CODE = Object.freeze(
  Object.fromEntries(VERTICALS.map((v) => [v.code, v]))
);

// A "general" profile for a business that does not fit any of the four:
// everything on, nothing assumed. The owner configures categories themselves.
const GENERAL_PROFILE = Object.freeze({
  code: 'GENERAL',
  label: 'General retail / wholesale (configurable)',
  shortLabel: 'General',
  blurb: 'Build your own categories, units and rules.',
  defaultCurrency: 'NGN',
  serialTrackingDefault: false,
  warrantyDefault: false,
  deliveryDefault: true,
  installationDefault: false,
  layawayDefault: true,
  instalmentDefault: true,
  shelfLifeDefault: false,
  bulkHandlingDefault: true,
  baseUnitDefault: 'PIECE',
  sellingPatternDefault: 'BOTH',
  restrictionDefault: 'NONE',
  units: Object.keys(UNIT_LIBRARY),
  categories: Object.freeze([{ code: 'GENERAL', label: 'General', shelfLife: false, registerRequired: false }]),
  attributeSchema: Object.freeze([
    { key: 'brand', label: 'Brand', type: 'TEXT', required: false, searchable: true },
    { key: 'model', label: 'Model / variant', type: 'TEXT', required: false, searchable: true },
  ]),
  complianceTypes: Object.freeze(['CAC', 'SON', 'SONCAP', 'NAFDAC', 'STATE_TRADING_PERMIT', 'LG_SIGNAGE', 'FIRE_SAFETY', 'OTHER']),
  warrantyStatuses: Object.freeze(['IN_WARRANTY', 'OUT_OF_WARRANTY', 'VOID', 'PENDING_CLAIM', 'UNDER_REPAIR', 'REPLACED', 'REFUNDED']),
  notes: 'The owner defines everything from Settings → Business Profile.',
});

const ALL_PROFILES = Object.freeze([...VERTICALS, GENERAL_PROFILE]);

// ---------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------
function isVertical(code) {
  const c = String(code || '').toUpperCase();
  return VERTICAL_CODES.has(c) || c === 'GENERAL';
}

function getProfile(code) {
  const c = String(code || '').toUpperCase();
  return VERTICAL_BY_CODE[c] || (c === 'GENERAL' ? GENERAL_PROFILE : null);
}

function getProfileOrThrow(code) {
  const p = getProfile(code);
  if (!p) {
    const err = new Error(`Unknown business profile "${code}". Choose one of: ${ALL_PROFILES.map((x) => x.code).join(', ')}`);
    err.status = 400; err.code = 'UNKNOWN_VERTICAL';
    throw err;
  }
  return p;
}

function categoryLabel(profile, code) {
  const p = typeof profile === 'string' ? getProfile(profile) : profile;
  if (!p) return code;
  const found = p.categories.find((c) => c.code === String(code || '').toUpperCase());
  return found ? found.label : (code || 'Uncategorised');
}

function categoryCodes(profile) {
  const p = typeof profile === 'string' ? getProfile(profile) : profile;
  return p ? p.categories.map((c) => c.code) : [];
}

function categoryConfig(profile, code) {
  const p = typeof profile === 'string' ? getProfile(profile) : profile;
  if (!p) return null;
  return p.categories.find((c) => c.code === String(code || '').toUpperCase()) || null;
}

/**
 * Effective restriction for a product. A product-level setting always wins;
 * when it is not set we fall back to the CATEGORY's default, then the
 * profile's default. That cascade is what lets an owner turn on serial capture
 * for every phone without editing 400 products, while still exempting one
 * specific accessory line.
 */
function effectiveRestriction(profile, categoryCode, productOverride) {
  if (productOverride && RESTRICTION_CODES.has(productOverride)) return productOverride;
  const p = typeof profile === 'string' ? getProfile(profile) : profile;
  const cat = categoryConfig(p, categoryCode);
  if (cat && cat.restriction && RESTRICTION_CODES.has(cat.restriction)) return cat.restriction;
  return p ? (p.restrictionDefault || 'NONE') : 'NONE';
}

/** Same cascade for "must this line go into the high-value register". */
function effectiveRegisterRequired(profile, categoryCode, productOverride) {
  if (productOverride != null) return !!productOverride;
  const p = typeof profile === 'string' ? getProfile(profile) : profile;
  const cat = categoryConfig(p, categoryCode);
  if (cat && cat.registerRequired != null) return !!cat.registerRequired;
  return false;
}

function unitInfo(code) {
  const c = String(code || 'PIECE').toUpperCase();
  return UNIT_LIBRARY[c] || UNIT_LIBRARY.PIECE;
}

function isUnit(code) {
  return Object.prototype.hasOwnProperty.call(UNIT_LIBRARY, String(code || '').toUpperCase());
}

function customerClassInfo(code) {
  return CUSTOMER_CLASSES.find((c) => c.code === String(code || '').toUpperCase()) || CUSTOMER_CLASSES[0];
}

function isCustomerClass(code) {
  return CUSTOMER_CLASS_CODES.has(String(code || '').toUpperCase());
}

function restrictionInfo(code) {
  return RESTRICTION_REASONS.find((r) => r.code === String(code || '').toUpperCase()) || RESTRICTION_REASONS[0];
}

/** Whether the profile permits fractional base quantities (tonnes, metres). */
function allowsFractionalQty(profile) {
  const p = typeof profile === 'string' ? getProfile(profile) : profile;
  if (!p) return false;
  return p.units.some((u) => ['KG', 'TONNE', 'LITRE', 'METRE', 'SQUARE_METRE', 'CUBIC_METRE'].includes(u));
}

module.exports = {
  UNIT_LIBRARY, SELLING_UNITS, SELLING_UNIT_LABELS,
  SELLING_PATTERNS, CUSTOMER_CLASSES, CUSTOMER_CLASS_CODES,
  RESTRICTION_REASONS, RESTRICTION_CODES, FIELD_TYPES,
  ELECTRONICS, FURNITURE, WHOLESALE_RETAIL, BUILDING_MATERIALS,
  VERTICALS, VERTICAL_CODES, GENERAL_PROFILE, ALL_PROFILES,
  isVertical, getProfile, getProfileOrThrow,
  categoryLabel, categoryCodes, categoryConfig,
  effectiveRestriction, effectiveRegisterRequired,
  unitInfo, isUnit, customerClassInfo, isCustomerClass, restrictionInfo,
  allowsFractionalQty,
};
