'use strict';
// =====================================================================
// domain/verticals.js — BUSINESS PROFILE CONFIGURATION
// =====================================================================
// THE CENTRAL DECOUPLING DECISION
//
// PharmaRidge encoded "this is a pharmacy" in the schema itself: a
// dispensing_type CHECK constraint of OTC|POM, a nafdac_reg_no column, a
// prescriptions table, a controlled_substance_register, a fixed 5-value
// retail_category enum, and base_unit defaulting to 'tablet'. Every one of
// those is a storage-level assertion that the deployment is a pharmacy,
// and every one of them had to be surgically removed before the engine
// could serve anybody else.
//
// StockRidge therefore puts vertical-specific behaviour in DATA AND CONFIG,
// never in constraints. This file is the single source of truth for what
// an ELECTRONICS business needs that a FURNITURE business does not. The
// schema is generic; a profile says which parts of it to switch on.
//
// CONSEQUENCES OF THIS CHOICE, stated plainly:
//   + A new vertical (a bakery, a spare-parts dealer, a bookshop) is a new
//     entry in PROFILES below. No migration, no schema change.
//   + A client can override any of it per business via
//     businesses.profile_overrides_json — e.g. a furniture business that
//     also sells fridges can turn serial tracking on for one category.
//   - The database cannot REFUSE an invalid combination. A profile that
//     says requires_serial: false will happily accept a product with
//     requires_serial = 1, because the column exists for everyone.
//     Enforcement is in domain/validation.js and the routes, which means a
//     direct SQL write can bypass it. That is an accepted trade: the
//     alternative is four schemas, and four schemas is four codebases.
//
// Each profile declares:
//   code, label, blurb            — identity
//   baseUnit                      — what stock is counted in by default
//   categories[]                  — seeded into product_categories
//   features{}                    — module switches the UI and routes read
//   complianceFields[]            — branch_compliance_records the UI offers
//   productRegistrations[]        — authorities relevant to these goods
//   variantAxes[]                 — suggested axes for product_variants
//   unitLadder[]                  — suggested product_units rows
//   expenseCategories[]           — seeded expense categories
//   returnReasons[]               — allowed sale_returns.reason_code emphasis
//   seedProducts[]                — demo/starting catalogue
// =====================================================================

const { round2 } = require('./money');
const { summariseModes } = require('./dispatch');

// ---------------------------------------------------------------------
// FEATURE FLAGS — the vocabulary every profile draws from
// ---------------------------------------------------------------------
// Each flag is read in exactly one place per concern:
//   serialTracking     -> POS captures serials; warranty lookup enabled
//   warranty           -> warranty_claims module and the claim screen
//   variants           -> product_variants + variant_axes UI
//   expiryTracking     -> batch expiry_date captured; v_expiry_alerts shown
//   bulkyDelivery      -> delivery_jobs with vehicle sizing
//   installation       -> installation_jobs, technician scheduling
//   measuredSales      -> product_measures; fractional quantities at POS
//   wholesalePricing   -> customer_classes + price_lists drive the counter
//   instalments        -> instalment_plans (work-and-pay)
//   layaway            -> deposits
//   batchTracking      -> stock_batches batch_no is meaningful, not just an id
//   quarantine         -> goods-received inspection can hold stock
//   recalls            -> product_recalls module
//   commissionTracking -> salesperson commission on the dashboard
const FEATURE_FLAGS = Object.freeze([
  'serialTracking', 'warranty', 'variants', 'expiryTracking', 'bulkyDelivery',
  'installation', 'measuredSales', 'wholesalePricing', 'instalments', 'layaway',
  'batchTracking', 'quarantine', 'recalls', 'commissionTracking', 'fragileHandling',
  // Prescription and controlled-medicine gates. Off unless the profile sells drugs.
  'dispensing',
  // billBeforeReceipt is intentionally absent. GENERAL_RETAIL spreads every
  // flag in this list on. A bill that holds stock is set on the warehouse,
  // yard, showroom and plaza profiles, and an owner can override it.
]);

const ALL_FEATURES_ON = Object.freeze(FEATURE_FLAGS.reduce((acc, f) => { acc[f] = true; return acc; }, {}));
const ALL_FEATURES_OFF = Object.freeze(FEATURE_FLAGS.reduce((acc, f) => { acc[f] = false; return acc; }, {}));

// ---------------------------------------------------------------------
// UNIT LADDERS
// ---------------------------------------------------------------------
// A ladder is an ordered set of sellable levels. quantityInBase is how many
// BASE UNITS one of that level contains. Stock always decrements in base
// units; the ladder only changes what the cashier types.
const LADDERS = Object.freeze({
  EACH_ONLY: [
    { code: 'PIECE', name: 'Piece', plural: 'Pieces', quantityInBase: 1, isDefaultSell: true },
  ],
  FMCG: [
    { code: 'PIECE', name: 'Piece', plural: 'Pieces', quantityInBase: 1 },
    { code: 'PACK', name: 'Pack', plural: 'Packs', quantityInBase: 6 },
    { code: 'CARTON', name: 'Carton', plural: 'Cartons', quantityInBase: 48, isDefaultSell: true },
  ],
  // A pharmacy counter sells one tablet, a strip, or a pack. The levels ascend,
  // so the ladder validator accepts them. Liquids use EACH_ONLY instead.
  PHARMA: [
    { code: 'TABLET', name: 'Tablet', plural: 'Tablets', quantityInBase: 1, isDefaultSell: true },
    { code: 'STRIP', name: 'Strip', plural: 'Strips', quantityInBase: 10 },
    { code: 'PACK', name: 'Pack', plural: 'Packs', quantityInBase: 100 },
  ],
  ELECTRONICS: [
    { code: 'PIECE', name: 'Unit', plural: 'Units', quantityInBase: 1, isDefaultSell: true },
    { code: 'CARTON', name: 'Carton', plural: 'Cartons', quantityInBase: 4 },
  ],
  FURNITURE: [
    { code: 'PIECE', name: 'Piece', plural: 'Pieces', quantityInBase: 1, isDefaultSell: true },
    { code: 'SET', name: 'Set', plural: 'Sets', quantityInBase: 3 },
  ],
  // A building-materials yard genuinely sells the same commodity two ways:
  // loose bags to a homeowner and a 30-ton truck load to a site. One bag is
  // the base unit and a trip is 600 of them, which is the real ratio for
  // cement and closely approximates it for aggregates.
  //
  // NOTE ON A BUG THAT USED TO LIVE HERE: this ladder once began
  // PIECE(1) -> BAG(1) -> TRIP(600). Two levels at 1 base unit is not a
  // ladder, it is an alias, and uom.validateLadder rejects it with
  // LADDER_NOT_ASCENDING — meaning every BUILDING_MATERIALS product
  // provisioned from this file would have failed validation the moment
  // anything read its units back. Caught by test/unit/verticals.test.js,
  // which now validates every shipped ladder rather than trusting the data.
  BUILDING: [
    { code: 'BAG', name: 'Bag', plural: 'Bags', quantityInBase: 1, isDefaultSell: true },
    { code: 'TRIP', name: 'Trip (truck load)', plural: 'Trips', quantityInBase: 600 },
  ],
  // Commodities that are ONLY ever sold by the truck load. Counting sharp
  // sand in "bags" would force a yard to record 600 units for one delivery.
  TRIP_ONLY: [
    { code: 'TRIP', name: 'Trip (truck load)', plural: 'Trips', quantityInBase: 1, isDefaultSell: true },
  ],
  // Commodities that are ONLY ever sold by the bag (cement, a 50kg sack of
  // rice). One bag is the base unit; there is no smaller thing to count.
  BAG_ONLY: [
    { code: 'BAG', name: 'Bag', plural: 'Bags', quantityInBase: 1, isDefaultSell: true },
  ],
  // A sachet-water plant counts every sachet and sells the market bag of 20.
  // A single sachet stays sellable at the gate and at a hawker's bowl.
  WATER_SACHET: [
    { code: 'SACHET', name: 'Sachet', plural: 'Sachets', quantityInBase: 1 },
    { code: 'BAG', name: 'Bag of 20', plural: 'Bags', quantityInBase: 20, isDefaultSell: true },
  ],
  // PET table water. The counter sells a bottle. A depot takes a pack of 12.
  WATER_BOTTLE: [
    { code: 'BOTTLE', name: 'Bottle', plural: 'Bottles', quantityInBase: 1, isDefaultSell: true },
    { code: 'PACK', name: 'Pack of 12', plural: 'Packs', quantityInBase: 12 },
  ],
  // 1.5 litre bottles travel in sixes, not in the 50cl pack of 12.
  WATER_LARGE: [
    { code: 'BOTTLE', name: 'Bottle', plural: 'Bottles', quantityInBase: 1, isDefaultSell: true },
    { code: 'PACK', name: 'Pack of 6', plural: 'Packs', quantityInBase: 6 },
  ],
  WATER_JERRY: [
    { code: 'JERRYCAN', name: 'Jerrycan', plural: 'Jerrycans', quantityInBase: 1, isDefaultSell: true },
  ],
  // The counter sells a loaf. A depot, a school or a hotel takes a nylon of 10.
  BAKERY_LOAF: [
    { code: 'LOAF', name: 'Loaf', plural: 'Loaves', quantityInBase: 1, isDefaultSell: true },
    { code: 'NYLON', name: 'Nylon of 10', plural: 'Nylons', quantityInBase: 10 },
  ],
  BAKERY_PIECE: [
    { code: 'PIECE', name: 'Piece', plural: 'Pieces', quantityInBase: 1, isDefaultSell: true },
    { code: 'PACK', name: 'Pack of 6', plural: 'Packs', quantityInBase: 6 },
  ],
  CABLE: [
    { code: 'METRE', name: 'Metre', plural: 'Metres', quantityInBase: 1, isDefaultSell: true },
    { code: 'ROLL', name: 'Roll', plural: 'Rolls', quantityInBase: 100 },
  ],
});

// ---------------------------------------------------------------------
// MEASURE LADDERS — the unit ladder implied by a measure axis
// ---------------------------------------------------------------------
// A product sold by length/area/volume/weight has its base unit FIXED by the
// axis: metres, square metres, litres, kilograms. Deriving the ladder from
// the axis (rather than letting each product name one) is what keeps
// products.base_unit_name, product_units.code and product_measures.
// base_unit_code agreeing with each other. When they disagree, a receipt of
// "5" is ambiguous — 5 of what? — and stock goes wrong in a way nobody
// notices until the stocktake.
const MEASURE_LADDERS = Object.freeze({
  LENGTH: [
    { code: 'METRE', name: 'Metre', plural: 'Metres', quantityInBase: 1, isDefaultSell: true },
    { code: 'ROLL', name: 'Roll', plural: 'Rolls', quantityInBase: 100 },
  ],
  AREA: [
    { code: 'SQUARE_METRE', name: 'Square metre', plural: 'Square metres', quantityInBase: 1, isDefaultSell: true },
  ],
  VOLUME: [
    { code: 'LITRE', name: 'Litre', plural: 'Litres', quantityInBase: 1, isDefaultSell: true },
    { code: 'DRUM', name: 'Drum (200L)', plural: 'Drums', quantityInBase: 200 },
  ],
  WEIGHT: [
    { code: 'KILOGRAM', name: 'Kilogram', plural: 'Kilograms', quantityInBase: 1, isDefaultSell: true },
    { code: 'BAG', name: 'Bag (50kg)', plural: 'Bags', quantityInBase: 50 },
  ],
});

/**
 * The ONE place a product's unit ladder is derived.
 *
 * Precedence: an explicit `ladder` key on the seed wins (a merchant selling
 * cable by the roll wants CABLE, not the generic LENGTH ladder); otherwise a
 * measured product takes its axis ladder; otherwise the profile default.
 * Provisioning and the test suite both call this, so they cannot drift.
 */
function ladderForSeedProduct(profile, seed) {
  if (seed && seed.ladder && LADDERS[seed.ladder]) return LADDERS[seed.ladder];
  if (seed && seed.measured && MEASURE_LADDERS[seed.measured]) return MEASURE_LADDERS[seed.measured];
  return Array.isArray(profile && profile.defaultLadder) && profile.defaultLadder.length
    ? profile.defaultLadder
    : LADDERS.EACH_ONLY;
}

/**
 * The base unit NAME for a product, derived from its ladder.
 *
 * Always level 0's name, lowercased — never a free-text value from seed data.
 * `base_unit_name` is what a receipt prints and what a stocktake sheet says,
 * so it has to be the same word the units table uses.
 */
function baseUnitNameFor(profile, seed) {
  const ladder = ladderForSeedProduct(profile, seed);
  return String(ladder[0].name || ladder[0].code).toLowerCase();
}

// ---------------------------------------------------------------------
// MEASURE AXES — for goods sold by length/area/volume/weight
// ---------------------------------------------------------------------
const MEASURE_AXES = Object.freeze({
  LENGTH: {
    axis: 'LENGTH', sellUnitCode: 'METRE', sellUnitName: 'Metre',
    baseUnitCode: 'METRE', baseFactor: 1, step: 0.5,
  },
  AREA: {
    axis: 'AREA', sellUnitCode: 'SQUARE_METRE', sellUnitName: 'Square metre',
    baseUnitCode: 'SQUARE_METRE', baseFactor: 1, step: 0.25,
  },
  VOLUME: {
    axis: 'VOLUME', sellUnitCode: 'LITRE', sellUnitName: 'Litre',
    baseUnitCode: 'LITRE', baseFactor: 1, step: 0.5,
  },
  WEIGHT: {
    axis: 'WEIGHT', sellUnitCode: 'KILOGRAM', sellUnitName: 'Kilogram',
    baseUnitCode: 'KILOGRAM', baseFactor: 1, step: 0.1,
  },
});

// ---------------------------------------------------------------------
// COMPLIANCE FIELD LIBRARY
// ---------------------------------------------------------------------
// branch_compliance_records.record_type values, with the human label and
// whether the record normally expires. Nothing here is mandatory at the
// schema level: the profile decides what the UI OFFERS and what the
// expiry alert view warns about. A client with an unusual permit is never
// blocked from going live by this file.
const COMPLIANCE_FIELDS = Object.freeze({
  CAC: { type: 'CAC', label: 'CAC Registration', expires: false, hint: 'Corporate Affairs Commission RC/BN number' },
  TIN: { type: 'TIN', label: 'FIRS Tax ID (TIN)', expires: false, hint: 'Required on invoices above the VAT threshold' },
  VAT_REG: { type: 'VAT_REG', label: 'VAT Registration', expires: false, hint: 'Required once turnover exceeds the FIRS threshold' },
  SONCAP_DEALER: { type: 'SONCAP_DEALER', label: 'SON / SONCAP Dealer Registration', expires: true, hint: 'Standards Organisation of Nigeria conformity scheme' },
  NAFDAC_PREMISES: { type: 'NAFDAC_PREMISES', label: 'NAFDAC Premises Registration', expires: true, hint: 'Required to retail food, drinks, cosmetics or drugs' },
  TRADING_PERMIT: { type: 'TRADING_PERMIT', label: 'State/LGA Trading Permit', expires: true, hint: 'Issued by the state ministry of commerce or the LGA' },
  FORESTRY_PERMIT: { type: 'FORESTRY_PERMIT', label: 'Forestry / Timber Permit', expires: true, hint: 'Required for logged timber and some imported hardwoods' },
  CITES: { type: 'CITES', label: 'CITES Import Permit', expires: true, hint: 'For internationally traded protected hardwood species' },
  FIRE_CERT: { type: 'FIRE_CERT', label: 'Fire Service Certificate', expires: true, hint: 'State fire service premises certificate' },
  SIGNAGE_PERMIT: { type: 'SIGNAGE_PERMIT', label: 'Signage / Advertising Permit', expires: true, hint: 'LASAA or state signage agency' },
  QUARRY_PERMIT: { type: 'QUARRY_PERMIT', label: 'Quarry / Aggregate Permit', expires: true, hint: 'For sand, granite and aggregate dealers' },
  NCC_TYPE_APPROVAL: { type: 'NCC_TYPE_APPROVAL', label: 'NCC Type Approval', expires: true, hint: 'Nigerian Communications Commission approval for radio equipment' },
  SCUML: { type: 'SCUML', label: 'SCUML Certificate', expires: true, hint: 'EFCC Special Control Unit Against Money Laundering — required for dealers in high-value goods' },
  PCN: { type: 'PCN', label: 'PCN Premises Licence', expires: true, hint: 'Pharmacists Council of Nigeria premises licence' },
  SUPERINTENDENT: { type: 'SUPERINTENDENT', label: 'Superintendent Pharmacist', expires: true, hint: 'The pharmacist named on the premises licence' },
  // Packaged water is NIS 306, enforced with NAFDAC. NIS 554 is drinking
  // water from a utility or a tanker, and it says so: it excludes packaged water.
  NIS_PACKAGED_WATER: { type: 'NIS_PACKAGED_WATER', label: 'SON / NIS 306 packaged water', expires: true, hint: 'Nigerian Industrial Standard for potable packaged water. Not a pharmacy licence.' },
  FOOD_HANDLERS: { type: 'FOOD_HANDLERS', label: 'Food handlers’ medicals', expires: true, hint: 'Current medical certificates for people who pack water or handle dough and finished bread' },
});

// ---------------------------------------------------------------------
// PRODUCT REGISTRATION AUTHORITIES
// ---------------------------------------------------------------------
const REGISTRATION_AUTHORITIES = Object.freeze({
  SON: { authority: 'SON', label: 'Standards Organisation of Nigeria', regTypes: ['SONCAP', 'MANCAP'] },
  NAFDAC: { authority: 'NAFDAC', label: 'National Agency for Food and Drug Administration and Control', regTypes: ['NAFDAC_REG', 'NAFDAC_LISTING'] },
  NCC: { authority: 'NCC', label: 'Nigerian Communications Commission', regTypes: ['TYPE_APPROVAL'] },
  MAN: { authority: 'MAN', label: 'Manufacturers Association of Nigeria', regTypes: ['MAN_MEMBERSHIP'] },
  CITES: { authority: 'CITES', label: 'Convention on International Trade in Endangered Species', regTypes: ['CITES_PERMIT'] },
});

// ---------------------------------------------------------------------
// CUSTOMER CLASSES — the wholesale/retail axis, seeded per profile
// ---------------------------------------------------------------------
// A Nigerian general merchant's counter serves at least three genuinely
// different customers in one day: a walk-in buying one item at shelf price,
// a market trader buying ten cartons at a lower price on credit, and a
// corporate procurement officer buying on invoice with 30-day terms.
// Treating them identically either loses the wholesaler to a competitor or
// gives away retail margin. So the class is a first-class object that
// selects a price list and credit terms BEFORE the cashier types anything.
const CUSTOMER_CLASS_SETS = Object.freeze({
  RETAIL_LED: [
    { code: 'WALK_IN', name: 'Walk-in', discountPct: 0, creditAllowed: false, termsDays: 0 },
    { code: 'RETAIL', name: 'Regular Retail', discountPct: 2, creditAllowed: false, termsDays: 0 },
    { code: 'WHOLESALE', name: 'Wholesale', discountPct: 8, creditAllowed: true, termsDays: 14, defaultCreditLimit: 500000 },
    { code: 'CORPORATE', name: 'Corporate / Invoice', discountPct: 5, creditAllowed: true, termsDays: 30, defaultCreditLimit: 2000000 },
  ],
  WHOLESALE_LED: [
    { code: 'WALK_IN', name: 'Walk-in Retail', discountPct: 0, creditAllowed: false, termsDays: 0 },
    { code: 'RETAIL', name: 'Small Retailer', discountPct: 5, creditAllowed: true, termsDays: 7, defaultCreditLimit: 200000 },
    { code: 'WHOLESALE', name: 'Wholesaler', discountPct: 12, creditAllowed: true, termsDays: 21, defaultCreditLimit: 2000000 },
    { code: 'DISTRIBUTOR', name: 'Distributor', discountPct: 18, creditAllowed: true, termsDays: 30, defaultCreditLimit: 10000000 },
    { code: 'CORPORATE', name: 'Corporate / Institution', discountPct: 10, creditAllowed: true, termsDays: 45, defaultCreditLimit: 5000000 },
  ],
  PROJECT_LED: [
    { code: 'WALK_IN', name: 'Walk-in', discountPct: 0, creditAllowed: false, termsDays: 0 },
    { code: 'RETAIL', name: 'Retail Customer', discountPct: 3, creditAllowed: false, termsDays: 0 },
    { code: 'CONTRACTOR', name: 'Contractor', discountPct: 10, creditAllowed: true, termsDays: 30, defaultCreditLimit: 5000000 },
    { code: 'DEVELOPER', name: 'Developer / Project', discountPct: 15, creditAllowed: true, termsDays: 60, defaultCreditLimit: 20000000 },
  ],
  // A walk-in buying ribbon, a family booking chairs for Saturday, and a
  // planner who takes fifty cartons and two hundred chairs on seven-day terms.
  EVENT: [
    { code: 'WALK_IN', name: 'Walk-in', discountPct: 0, creditAllowed: false, termsDays: 0 },
    { code: 'RETAIL', name: 'Regular customer', discountPct: 0, creditAllowed: false, termsDays: 0 },
    { code: 'PLANNER', name: 'Event planner', discountPct: 5, creditAllowed: true, termsDays: 7, defaultCreditLimit: 500000 },
    { code: 'WHOLESALE', name: 'Wholesale', discountPct: 8, creditAllowed: true, termsDays: 14, defaultCreditLimit: 1000000 },
  ],
  // A lessee is not a walk-in. The term is the relationship.
  LEASE_LED: [
    { code: 'WALK_IN', name: 'Walk-in', discountPct: 0, creditAllowed: false, termsDays: 0 },
    { code: 'RETAIL', name: 'Cash customer', discountPct: 0, creditAllowed: false, termsDays: 0 },
    { code: 'LESSEE', name: 'Lessee', discountPct: 0, creditAllowed: true, termsDays: 7, defaultCreditLimit: 1000000 },
    { code: 'CORPORATE', name: 'Corporate lessee', discountPct: 5, creditAllowed: true, termsDays: 30, defaultCreditLimit: 5000000 },
  ],
  // A factory gate in one morning: a hawker buying two bags for cash, a
  // kiosk on three-day terms, a depot on a fortnight, and a school or a
  // hotel that wants an invoice. The class picks the price before the
  // cashier types the quantity.
  ROUTE_TRADE: [
    { code: 'WALK_IN', name: 'Counter', discountPct: 0, creditAllowed: false, termsDays: 0 },
    { code: 'KIOSK', name: 'Kiosk / hawker', discountPct: 5, creditAllowed: true, termsDays: 3, defaultCreditLimit: 80000 },
    { code: 'RETAILER', name: 'Retailer', discountPct: 8, creditAllowed: true, termsDays: 7, defaultCreditLimit: 250000 },
    { code: 'WHOLESALE', name: 'Wholesale depot', discountPct: 12, creditAllowed: true, termsDays: 14, defaultCreditLimit: 1500000 },
    { code: 'INSTITUTION', name: 'School, hotel or event', discountPct: 8, creditAllowed: true, termsDays: 14, defaultCreditLimit: 500000 },
  ],
});

// ---------------------------------------------------------------------
// RETURN REASONS
// ---------------------------------------------------------------------
// The schema CHECK admits one fixed list (so a report can group on it);
// the profile decides which are OFFERED, because "wrong item" means
// something different at a furniture showroom than at a phone counter.
const RETURN_REASONS = Object.freeze([
  { code: 'DEFECTIVE', label: 'Defective / not working' },
  { code: 'WRONG_ITEM', label: 'Wrong item supplied' },
  { code: 'DAMAGED_IN_TRANSIT', label: 'Damaged in transit' },
  { code: 'CUSTOMER_CHANGE_OF_MIND', label: 'Customer changed their mind' },
  { code: 'OVERCHARGE', label: 'Overcharge / pricing error' },
  { code: 'RECALL', label: 'Product recall' },
  { code: 'WARRANTY', label: 'Warranty failure' },
  { code: 'OTHER', label: 'Other' },
]);

// ---------------------------------------------------------------------
// EXPENSE CATEGORIES
// ---------------------------------------------------------------------
const EXPENSE_CATEGORY_SETS = Object.freeze({
  GENERAL: ['RENT', 'DIESEL_FUEL', 'ELECTRICITY', 'SALARY_WAGES', 'TRANSPORT_LOGISTICS', 'SECURITY', 'CLEANING', 'MARKETING', 'REPAIRS_MAINTENANCE', 'BANK_CHARGES', 'INTERNET_AIRTIME', 'MISC'],
  RETAIL_HEAVY: ['RENT', 'DIESEL_FUEL', 'ELECTRICITY', 'SALARY_WAGES', 'TRANSPORT_LOGISTICS', 'SECURITY', 'CLEANING', 'MARKETING', 'REPAIRS_MAINTENANCE', 'BANK_CHARGES', 'INTERNET_AIRTIME', 'PACKAGING_MATERIALS', 'SHRINKAGE', 'MISC'],
  PROJECT_HEAVY: ['RENT', 'DIESEL_FUEL', 'ELECTRICITY', 'SALARY_WAGES', 'TRANSPORT_LOGISTICS', 'SECURITY', 'CLEANING', 'MARKETING', 'REPAIRS_MAINTENANCE', 'BANK_CHARGES', 'INTERNET_AIRTIME', 'SITE_EXPENSES', 'EQUIPMENT_HIRE', 'LOADERS_PORTERS', 'MISC'],
  // A yard that sends goods out and brings them back. The shop's own rent is
  // still RENT. EQUIPMENT_HIRE here is money paid to somebody else.
  HIRE_YARD: ['RENT', 'DIESEL_FUEL', 'ELECTRICITY', 'SALARY_WAGES', 'TRANSPORT_LOGISTICS', 'SECURITY', 'CLEANING', 'REPAIRS_MAINTENANCE', 'BANK_CHARGES', 'LOADERS_PORTERS', 'EQUIPMENT_HIRE', 'SHRINKAGE', 'MISC'],
  // A plant. DRIVER_WAGES is the salary of a driver on a vehicle the
  // business owns. A partner rider is not in that line: their pay is a
  // share of the sales they delivered, recorded when the drop is closed.
  PRODUCTION: ['RENT', 'DIESEL_FUEL', 'ELECTRICITY', 'SALARY_WAGES', 'DRIVER_WAGES', 'TRANSPORT_LOGISTICS', 'PACKAGING_MATERIALS', 'WATER_TREATMENT', 'BAKERY_GAS', 'REPAIRS_MAINTENANCE', 'SHRINKAGE', 'SECURITY', 'CLEANING', 'BANK_CHARGES', 'MISC'],
});

// =====================================================================
// THE PROFILES
// =====================================================================
const PROFILES = Object.freeze({

  // -------------------------------------------------------------------
  // ELECTRONICS — appliances, gadgets, phones, computers, accessories
  // -------------------------------------------------------------------
  // The defining traits: a serialised individual unit, a manufacturer
  // warranty that the shop passes through, colour/storage/size variants,
  // NCC type approval for anything with a radio, and SCUML because
  // high-value goods dealers are a designated sector under Nigerian
  // anti-money-laundering rules.
  ELECTRONICS: {
    code: 'ELECTRONICS',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE']),
    label: 'Electronics, Appliances & Gadgets',
    blurb: 'Phones, laptops, TVs, fridges, generators, solar and accessories — serialised, warrantied, variant-heavy.',
    baseUnit: 'unit',
    defaultLadder: LADDERS.ELECTRONICS,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      serialTracking: true, warranty: true, variants: true, bulkyDelivery: true,
      installation: true, wholesalePricing: true, instalments: true, layaway: true,
      batchTracking: true, quarantine: true, recalls: true, commissionTracking: true,
      fragileHandling: true,
      // Computer Village / Banex pattern: bill at the desk, pay at the cashier, collect from the store.
      billBeforeReceipt: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'SONCAP_DEALER', 'TRADING_PERMIT', 'FIRE_CERT', 'SCUML', 'NCC_TYPE_APPROVAL']),
    registrationAuthorities: Object.freeze(['SON', 'NCC', 'MAN']),
    variantAxes: Object.freeze([
      { name: 'Colour', options: ['Black', 'Silver', 'Gold', 'Blue', 'White', 'Red'] },
      { name: 'Storage', options: ['64GB', '128GB', '256GB', '512GB', '1TB'] },
      { name: 'Size', options: ['32 inch', '43 inch', '55 inch', '65 inch', '75 inch'] },
      { name: 'Capacity', options: ['1.5HP', '2HP', '300L', '450L', '5kVA', '10kVA'] },
    ]),
    customerClasses: CUSTOMER_CLASS_SETS.RETAIL_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.RETAIL_HEAVY,
    returnReasons: Object.freeze(['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'CUSTOMER_CHANGE_OF_MIND', 'OVERCHARGE', 'RECALL', 'WARRANTY', 'OTHER']),
    defaultWarrantyMonths: 12,
    defaultReturnWindowDays: 7,
    categories: Object.freeze([
      { code: 'MOBILE_PHONES', name: 'Mobile Phones' },
      { code: 'PHONE_ACCESSORIES', name: 'Phone Accessories' },
      { code: 'LAPTOPS_COMPUTERS', name: 'Laptops & Computers' },
      { code: 'COMPUTER_ACCESSORIES', name: 'Computer Accessories' },
      { code: 'HOME_APPLIANCES', name: 'Home Appliances' },
      { code: 'KITCHEN_APPLIANCES', name: 'Kitchen Appliances' },
      { code: 'TV_AUDIO', name: 'TV, Audio & Home Theatre' },
      { code: 'POWER_GENERATION', name: 'Generators, Inverters & Solar' },
      { code: 'GAMING', name: 'Gaming' },
      { code: 'CAMERAS', name: 'Cameras & Photography' },
      { code: 'SMART_HOME', name: 'Smart Home & Security' },
      { code: 'CABLES_CONNECTORS', name: 'Cables & Connectors' },
      { code: 'OTHER_ELECTRONICS', name: 'Other Electronics' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Samsung Galaxy A15 128GB', brand: 'Samsung', model: 'SM-A155F', sku: 'EL-PH-001', category: 'MOBILE_PHONES', cost: 168000, price: 214500, reorder: 5, serial: true, warranty: 12, variants: [{ colour: ['Blue', 'Black'] }, { storage: ['128GB', '256GB'] }] },
      { name: 'Tecno Spark 20 256GB', brand: 'Tecno', model: 'KI5q', sku: 'EL-PH-002', category: 'MOBILE_PHONES', cost: 132000, price: 169000, reorder: 5, serial: true, warranty: 12, variants: [{ colour: ['White', 'Gold'] }] },
      { name: 'iPhone 13 128GB (UK Used)', brand: 'Apple', model: 'A2633', sku: 'EL-PH-003', category: 'MOBILE_PHONES', cost: 512000, price: 645000, reorder: 3, serial: true, warranty: 3 },
      { name: 'Anker 20000mAh Power Bank', brand: 'Anker', model: 'A1257', sku: 'EL-AC-001', category: 'PHONE_ACCESSORIES', cost: 21500, price: 34000, reorder: 10 },
      { name: 'Oraimo 3-in-1 Charging Cable', brand: 'Oraimo', model: 'OCB-128', sku: 'EL-AC-002', category: 'PHONE_ACCESSORIES', cost: 3200, price: 6500, reorder: 40 },
      { name: 'HP EliteBook 840 G6 i7', brand: 'HP', model: '840G6', sku: 'EL-LP-001', category: 'LAPTOPS_COMPUTERS', cost: 486000, price: 615000, reorder: 2, serial: true, warranty: 6, variants: [{ ram: ['8GB', '16GB'] }] },
      { name: 'Lenovo ThinkPad T480 i5', brand: 'Lenovo', model: 'T480', sku: 'EL-LP-002', category: 'LAPTOPS_COMPUTERS', cost: 342000, price: 438000, reorder: 2, serial: true, warranty: 6 },
      { name: 'Logitech Wireless Mouse M185', brand: 'Logitech', model: 'M185', sku: 'EL-CA-001', category: 'COMPUTER_ACCESSORIES', cost: 7400, price: 13500, reorder: 15 },
      { name: 'Hisense 43" Smart TV', brand: 'Hisense', model: '43A4K', sku: 'EL-TV-001', category: 'TV_AUDIO', cost: 268000, price: 342000, reorder: 3, serial: true, warranty: 24, bulky: true },
      { name: 'LG 1.5HP Inverter Air Conditioner', brand: 'LG', model: 'DSN12581', sku: 'EL-AP-001', category: 'HOME_APPLIANCES', cost: 486000, price: 618000, reorder: 2, serial: true, warranty: 12, bulky: true, installation: true },
      { name: 'Haier Thermocool 300L Double Door Fridge', brand: 'Haier Thermocool', model: 'HEF-300', sku: 'EL-AP-002', category: 'HOME_APPLIANCES', cost: 524000, price: 668000, reorder: 2, serial: true, warranty: 12, bulky: true },
      { name: 'Binatone Standing Fan 18"', brand: 'Binatone', model: 'SF-1820', sku: 'EL-AP-003', category: 'HOME_APPLIANCES', cost: 42000, price: 58500, reorder: 4, serial: true, warranty: 12, bulky: true },
      { name: 'Scanfrost 4 Burner Gas Cooker', brand: 'Scanfrost', model: 'SFC-5402', sku: 'EL-KA-001', category: 'KITCHEN_APPLIANCES', cost: 286000, price: 368000, reorder: 2, serial: true, warranty: 12, bulky: true, installation: true },
      { name: 'Silver Crest 2L Blender', brand: 'Silver Crest', model: 'SC-2L', sku: 'EL-KA-002', category: 'KITCHEN_APPLIANCES', cost: 18500, price: 29500, reorder: 8, warranty: 6 },
      { name: 'Sumec Firman 3.5kVA Generator', brand: 'Sumec Firman', model: 'SPG3800', sku: 'EL-PW-001', category: 'POWER_GENERATION', cost: 386000, price: 489000, reorder: 2, serial: true, warranty: 12, bulky: true },
      { name: 'Luminous 1.5kVA Inverter', brand: 'Luminous', model: 'ECO1500', sku: 'EL-PW-002', category: 'POWER_GENERATION', cost: 214000, price: 276000, reorder: 3, serial: true, warranty: 24, bulky: true, installation: true },
      { name: 'Monocrystalline Solar Panel 300W', brand: 'Felicity', model: 'FSM-300M', sku: 'EL-PW-003', category: 'POWER_GENERATION', cost: 96000, price: 132000, reorder: 4, bulky: true, warranty: 60 },
      { name: 'PlayStation 5 Slim Console', brand: 'Sony', model: 'CFI-2000', sku: 'EL-GM-001', category: 'GAMING', cost: 812000, price: 985000, reorder: 2, serial: true, warranty: 12 },
      { name: 'Hikvision 4-Channel CCTV Kit', brand: 'Hikvision', model: 'DS-2CE16', sku: 'EL-SH-001', category: 'SMART_HOME', cost: 168000, price: 224000, reorder: 3, serial: true, warranty: 24, installation: true },
      { name: 'HDMI Cable 2.1 (2m)', brand: 'Generic', model: 'HD21-2M', sku: 'EL-CB-001', category: 'CABLES_CONNECTORS', cost: 2800, price: 6500, reorder: 30, measured: 'LENGTH' },
    ]),
  },

  // -------------------------------------------------------------------
  // FURNITURE — showroom, made-to-order, bulky, install/assemble
  // -------------------------------------------------------------------
  // The defining traits: variants along fabric and size axes, delivery and
  // assembly as a real costed operation, no serial numbers (a sofa is not
  // individually registered, though a high-value item may be), long
  // layaway because a customer furnishing a new house pays over months,
  // and forestry/CITES paperwork for imported hardwood.
  FURNITURE: {
    code: 'FURNITURE',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE']),
    label: 'Furniture & Home Furnishings',
    blurb: 'Showroom and made-to-order furniture — fabric and size variants, bulky delivery, assembly and long layaway.',
    baseUnit: 'piece',
    defaultLadder: LADDERS.FURNITURE,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      variants: true, bulkyDelivery: true, installation: true, wholesalePricing: true,
      instalments: true, layaway: true, batchTracking: true, quarantine: true,
      commissionTracking: true, fragileHandling: true,
      // Showroom writes the bill. The warehouse releases the piece only against the receipt.
      billBeforeReceipt: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'TRADING_PERMIT', 'FORESTRY_PERMIT', 'CITES', 'FIRE_CERT', 'SIGNAGE_PERMIT']),
    registrationAuthorities: Object.freeze(['CITES', 'MAN']),
    variantAxes: Object.freeze([
      { name: 'Seating', options: ['1-Seater', '2-Seater', '3-Seater', '4-Seater', '6-Seater', 'L-Shape'] },
      { name: 'Fabric', options: ['Ashanti Beige', 'Ashanti Grey', 'Velvet Royal Blue', 'Leather Brown', 'Leather Black', 'Tiffany Teal'] },
      { name: 'Finish', options: ['Natural Oak', 'Walnut', 'Mahogany', 'Matte Black', 'High Gloss White'] },
      { name: 'Size', options: ['Single', 'Double', 'King', 'Queen'] },
    ]),
    customerClasses: CUSTOMER_CLASS_SETS.RETAIL_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.RETAIL_HEAVY,
    returnReasons: Object.freeze(['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'CUSTOMER_CHANGE_OF_MIND', 'OVERCHARGE', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 3,
    categories: Object.freeze([
      { code: 'LIVING_ROOM', name: 'Living Room' },
      { code: 'BEDROOM', name: 'Bedroom' },
      { code: 'DINING', name: 'Dining' },
      { code: 'OFFICE_FURNITURE', name: 'Office Furniture' },
      { code: 'OUTDOOR', name: 'Outdoor & Garden' },
      { code: 'KITCHEN_CABINETRY', name: 'Kitchen & Cabinetry' },
      { code: 'MATTRESS_BEDDING', name: 'Mattresses & Bedding' },
      { code: 'SOFT_FURNISHING', name: 'Curtains, Rugs & Soft Furnishing' },
      { code: 'HOME_DECOR', name: 'Home Decor & Lighting' },
      { code: 'MADE_TO_ORDER', name: 'Made to Order / Bespoke' },
      { code: 'OTHER_FURNITURE', name: 'Other Furniture' },
    ]),
    seedProducts: Object.freeze([
      { name: '7-Seater Ashanti Sofa Set', brand: 'Innostar', sku: 'FU-LR-001', category: 'LIVING_ROOM', cost: 786000, price: 1085000, reorder: 1, bulky: true, variants: [{ seating: ['5-Seater', '7-Seater'] }, { fabric: ['Ashanti Beige', 'Ashanti Grey', 'Velvet Royal Blue'] }] },
      { name: '3-Seater Tiffany Fabric Sofa', brand: 'Innostar', sku: 'FU-LR-002', category: 'LIVING_ROOM', cost: 342000, price: 478000, reorder: 2, bulky: true, variants: [{ fabric: ['Tiffany Teal', 'Ashanti Grey', 'Leather Brown'] }] },
      { name: 'Leather Recliner Chair', brand: 'ComfortPlus', sku: 'FU-LR-003', category: 'LIVING_ROOM', cost: 268000, price: 385000, reorder: 2, bulky: true, variants: [{ fabric: ['Leather Brown', 'Leather Black'] }] },
      { name: 'Centre Table (Tempered Glass)', brand: 'Innostar', sku: 'FU-LR-004', category: 'LIVING_ROOM', cost: 86000, price: 132000, reorder: 3, bulky: true },
      { name: 'King Size Bed Frame (Walnut)', brand: 'HomeCraft', sku: 'FU-BR-001', category: 'BEDROOM', cost: 428000, price: 598000, reorder: 1, bulky: true, installation: true, variants: [{ size: ['Double', 'Queen', 'King'] }, { finish: ['Walnut', 'Natural Oak', 'Matte Black'] }] },
      { name: '4-Door Wardrobe with Mirror', brand: 'HomeCraft', sku: 'FU-BR-002', category: 'BEDROOM', cost: 386000, price: 542000, reorder: 1, bulky: true, installation: true },
      { name: 'Bedside Table (Set of 2)', brand: 'HomeCraft', sku: 'FU-BR-003', category: 'BEDROOM', cost: 68000, price: 104000, reorder: 3, bulky: true },
      { name: 'Spring Mattress 6x6 (12 inch)', brand: 'Vitafoam', sku: 'FU-MB-001', category: 'MATTRESS_BEDDING', cost: 186000, price: 264000, reorder: 3, bulky: true, warranty: 120, variants: [{ size: ['Single', 'Double', 'King'] }] },
      { name: '8-Seater Dining Set (Marble Top)', brand: 'HomeCraft', sku: 'FU-DI-001', category: 'DINING', cost: 686000, price: 948000, reorder: 1, bulky: true, installation: true },
      { name: 'Executive Office Desk (L-Shape)', brand: 'OfficePro', sku: 'FU-OF-001', category: 'OFFICE_FURNITURE', cost: 268000, price: 385000, reorder: 2, bulky: true, installation: true },
      { name: 'Ergonomic Mesh Office Chair', brand: 'OfficePro', sku: 'FU-OF-002', category: 'OFFICE_FURNITURE', cost: 128000, price: 194000, reorder: 4, bulky: true },
      { name: '4-Drawer Filing Cabinet', brand: 'OfficePro', sku: 'FU-OF-003', category: 'OFFICE_FURNITURE', cost: 96000, price: 148000, reorder: 3, bulky: true },
      { name: 'Kitchen Cabinet Set (Melamine, 10 units)', brand: 'HomeCraft', sku: 'FU-KC-001', category: 'KITCHEN_CABINETRY', cost: 1240000, price: 1780000, reorder: 1, bulky: true, installation: true },
      { name: 'Outdoor Rattan 5-Piece Set', brand: 'GardenLife', sku: 'FU-OD-001', category: 'OUTDOOR', cost: 486000, price: 692000, reorder: 1, bulky: true },
      { name: 'Blackout Curtains (per metre)', brand: 'TextileCo', sku: 'FU-SF-001', category: 'SOFT_FURNISHING', cost: 4200, price: 7800, reorder: 60, measured: 'LENGTH' },
      { name: 'Persian-style Area Rug 2x3m', brand: 'TextileCo', sku: 'FU-SF-002', category: 'SOFT_FURNISHING', cost: 96000, price: 158000, reorder: 2 },
      { name: 'Chandelier (5-arm, crystal)', brand: 'Lumiere', sku: 'FU-HD-001', category: 'HOME_DECOR', cost: 186000, price: 294000, reorder: 2, installation: true, fragile: true },
      { name: 'Bespoke Upholstery (per seat)', brand: 'Made to Order', sku: 'FU-MTO-001', category: 'MADE_TO_ORDER', cost: 42000, price: 78000, reorder: 0 },
    ]),
  },

  // -------------------------------------------------------------------
  // WHOLESALE_RETAIL — general merchandise, FMCG, provisions
  // -------------------------------------------------------------------
  // The defining traits: a deep unit ladder (piece/pack/carton/pallet),
  // expiry tracking because food and drink are in the mix, aggressive
  // wholesale price tiers because the margin is made on volume, and
  // NAFDAC registration for anything ingestible or applied to the body.
  // This is the "provision store that grew into a distributor" profile.
  WHOLESALE_RETAIL: {
    code: 'WHOLESALE_RETAIL',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE']),
    label: 'Wholesale & Retail General Merchandise',
    blurb: 'Provisions, FMCG, drinks, household goods — carton and pallet trading with wholesale price tiers and expiry control.',
    baseUnit: 'piece',
    defaultLadder: LADDERS.FMCG,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      variants: true, expiryTracking: true, wholesalePricing: true, instalments: true,
      layaway: true, batchTracking: true, quarantine: true, recalls: true,
      bulkyDelivery: true, commissionTracking: true, measuredSales: true,
      // Cash-and-carry: the bill holds the cartons, the cashier takes the money, then the store releases them.
      billBeforeReceipt: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'NAFDAC_PREMISES', 'TRADING_PERMIT', 'FIRE_CERT', 'SIGNAGE_PERMIT']),
    registrationAuthorities: Object.freeze(['NAFDAC', 'SON', 'MAN']),
    variantAxes: Object.freeze([
      { name: 'Size', options: ['50cl', '1L', '1.5L', '250g', '500g', '1kg', '5kg'] },
      { name: 'Flavour', options: ['Original', 'Chicken', 'Beef', 'Chocolate', 'Strawberry'] },
      { name: 'Pack', options: ['Single', '6-pack', '12-pack', 'Carton of 24', 'Carton of 48'] },
    ]),
    customerClasses: CUSTOMER_CLASS_SETS.WHOLESALE_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.RETAIL_HEAVY,
    returnReasons: Object.freeze(['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'CUSTOMER_CHANGE_OF_MIND', 'OVERCHARGE', 'RECALL', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 3,
    categories: Object.freeze([
      { code: 'BEVERAGES', name: 'Drinks & Beverages' },
      { code: 'FOODSTUFFS', name: 'Foodstuffs & Groceries' },
      { code: 'CONFECTIONERY', name: 'Confectionery & Snacks' },
      { code: 'HOUSEHOLD', name: 'Household & Cleaning' },
      { code: 'PERSONAL_CARE', name: 'Personal Care & Toiletries' },
      { code: 'BABY_PRODUCTS', name: 'Baby Products' },
      { code: 'PROVISIONS', name: 'Provisions' },
      { code: 'PLASTICS_KITCHENWARE', name: 'Plastics & Kitchenware' },
      { code: 'STATIONERY', name: 'Stationery & Office Supplies' },
      { code: 'ELECTRICALS_SMALL', name: 'Small Electricals' },
      { code: 'GENERAL_MERCH', name: 'General Merchandise' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Indomie Instant Noodles Chicken', brand: 'Indomie', sku: 'WR-CF-001', category: 'CONFECTIONERY', cost: 2850, price: 4200, reorder: 40, ladder: 'FMCG', expiry: true },
      { name: 'Golden Penny Spaghetti 500g', brand: 'Golden Penny', sku: 'WR-FD-001', category: 'FOODSTUFFS', cost: 1180, price: 1650, reorder: 100, expiry: true },
      { name: 'Dangote Granulated Sugar 1kg', brand: 'Dangote', sku: 'WR-FD-002', category: 'FOODSTUFFS', cost: 1950, price: 2600, reorder: 60, expiry: true },
      { name: 'Mama Gold Rice 5kg', brand: 'Mama Gold', sku: 'WR-FD-003', category: 'FOODSTUFFS', cost: 12800, price: 16500, reorder: 20, expiry: true },
      { name: 'Devon King\'s Oil 3L', brand: "Devon King's", sku: 'WR-FD-004', category: 'FOODSTUFFS', cost: 9600, price: 12800, reorder: 15, expiry: true },
      { name: 'Coca-Cola 50cl PET', brand: 'Coca-Cola', sku: 'WR-BV-001', category: 'BEVERAGES', cost: 320, price: 500, reorder: 240, ladder: 'FMCG', expiry: true },
      { name: 'Peak Milk Powder 400g', brand: 'Peak', sku: 'WR-BV-002', category: 'BEVERAGES', cost: 5400, price: 7200, reorder: 48, expiry: true },
      { name: 'Milo Refill 400g', brand: 'Nestle', sku: 'WR-BV-003', category: 'BEVERAGES', cost: 4800, price: 6500, reorder: 48, expiry: true },
      { name: 'Eva Water 75cl', brand: 'Eva', sku: 'WR-BV-004', category: 'BEVERAGES', cost: 180, price: 300, reorder: 480, ladder: 'FMCG', expiry: true },
      { name: 'Ariel Detergent 1kg', brand: 'Ariel', sku: 'WR-HH-001', category: 'HOUSEHOLD', cost: 3600, price: 5200, reorder: 24 },
      { name: 'Hypo Bleach 1L', brand: 'Hypo', sku: 'WR-HH-002', category: 'HOUSEHOLD', cost: 1150, price: 1800, reorder: 48, expiry: true },
      { name: 'Dettol Antiseptic 200ml', brand: 'Dettol', sku: 'WR-PC-001', category: 'PERSONAL_CARE', cost: 2400, price: 3600, reorder: 24, expiry: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Close-Up Toothpaste 140g', brand: 'Close-Up', sku: 'WR-PC-002', category: 'PERSONAL_CARE', cost: 1050, price: 1700, reorder: 60, expiry: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Pampers Baby Dry Size 4 (58 pcs)', brand: 'Pampers', sku: 'WR-BB-001', category: 'BABY_PRODUCTS', cost: 18600, price: 24500, reorder: 12 },
      { name: 'Cerelac Wheat 400g', brand: 'Nestle', sku: 'WR-BB-002', category: 'BABY_PRODUCTS', cost: 6800, price: 9200, reorder: 24, expiry: true },
      { name: 'Binatone Kettle 1.8L', brand: 'Binatone', sku: 'WR-ES-001', category: 'ELECTRICALS_SMALL', cost: 12400, price: 19500, reorder: 8, warranty: 12 },
      { name: 'Extension Socket 6-way (Surge Protected)', brand: 'Century', sku: 'WR-ES-002', category: 'ELECTRICALS_SMALL', cost: 6200, price: 10500, reorder: 15 },
      { name: 'A4 Copier Paper 80gsm (Ream)', brand: 'PaperOne', sku: 'WR-ST-001', category: 'STATIONERY', cost: 4800, price: 6800, reorder: 40 },
      { name: 'Plastic Bucket 20L', brand: 'Kingsway', sku: 'WR-PK-001', category: 'PLASTICS_KITCHENWARE', cost: 1450, price: 2400, reorder: 40 },
      { name: 'Rice (loose, per bag of 50kg)', brand: 'Generic', sku: 'WR-GM-001', category: 'GENERAL_MERCH', cost: 62000, price: 78000, reorder: 10, ladder: 'BAG_ONLY' },
    ]),
  },

  // -------------------------------------------------------------------
  // BUILDING_MATERIALS — hardware, cement, steel, tiles, paint, cable
  // -------------------------------------------------------------------
  // The defining traits: MEASURED selling dominates (cable by the metre,
  // tiles by the square metre, sand by the trip, paint by the litre),
  // contractor and developer customer classes with long credit terms,
  // site delivery with hired trucks and loaders, and SONCAP because cement,
  // cables and steel are all conformity-assessed products in Nigeria.
  BUILDING_MATERIALS: {
    code: 'BUILDING_MATERIALS',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE']),
    label: 'Building Materials & Hardware',
    blurb: 'Cement, steel, tiles, paint, cable, plumbing — measured sales, contractor credit terms and site delivery.',
    baseUnit: 'piece',
    defaultLadder: LADDERS.BUILDING,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      variants: true, measuredSales: true, wholesalePricing: true, instalments: true,
      batchTracking: true, quarantine: true, recalls: true, bulkyDelivery: true,
      commissionTracking: true, expiryTracking: true,
      // Yard desk writes the bill. The gate loads the truck only against the receipt.
      billBeforeReceipt: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'SONCAP_DEALER', 'TRADING_PERMIT', 'QUARRY_PERMIT', 'FIRE_CERT', 'SCUML']),
    registrationAuthorities: Object.freeze(['SON', 'MAN']),
    variantAxes: Object.freeze([
      { name: 'Size', options: ['10mm', '12mm', '16mm', '20mm', '1/2 inch', '3/4 inch', '1 inch'] },
      { name: 'Gauge', options: ['18 gauge', '20 gauge', '22 gauge'] },
      { name: 'Colour', options: ['White', 'Cream', 'Terracotta', 'Grey', 'Magnolia'] },
      { name: 'Finish', options: ['Matte', 'Silk', 'Gloss', 'Textured'] },
    ]),
    customerClasses: CUSTOMER_CLASS_SETS.PROJECT_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.PROJECT_HEAVY,
    returnReasons: Object.freeze(['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'CUSTOMER_CHANGE_OF_MIND', 'OVERCHARGE', 'RECALL', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 7,
    categories: Object.freeze([
      { code: 'CEMENT_BINDERS', name: 'Cement & Binders' },
      { code: 'STEEL_REINFORCEMENT', name: 'Steel & Reinforcement' },
      { code: 'ROOFING', name: 'Roofing' },
      { code: 'TILES_FLOORING', name: 'Tiles & Flooring' },
      { code: 'PAINT_COATINGS', name: 'Paint & Coatings' },
      { code: 'ELECTRICAL_CABLE', name: 'Electrical & Cable' },
      { code: 'PLUMBING_PIPES', name: 'Plumbing & Pipes' },
      { code: 'DOORS_WINDOWS', name: 'Doors & Windows' },
      { code: 'TOOLS_HARDWARE', name: 'Tools & Hardware' },
      { code: 'AGGREGATES', name: 'Sand, Gravel & Aggregates' },
      { code: 'SANITARYWARE', name: 'Sanitaryware' },
      { code: 'OTHER_BUILDING', name: 'Other Building Materials' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Dangote Cement 3X', brand: 'Dangote', sku: 'BM-CB-001', category: 'CEMENT_BINDERS', cost: 8200, price: 10200, reorder: 200, ladder: 'BUILDING', registration: { authority: 'SON', type: 'SONCAP' } },
      { name: 'BUA Cement', brand: 'BUA', sku: 'BM-CB-002', category: 'CEMENT_BINDERS', cost: 7900, price: 9800, reorder: 200, ladder: 'BUILDING' },
      { name: '12mm Iron Rod (TMT, 12m length)', brand: 'African Foundries', sku: 'BM-SR-001', category: 'STEEL_REINFORCEMENT', cost: 22400, price: 27500, reorder: 60, measured: 'LENGTH' },
      { name: '16mm Iron Rod (TMT, 12m length)', brand: 'African Foundries', sku: 'BM-SR-002', category: 'STEEL_REINFORCEMENT', cost: 38600, price: 46800, reorder: 40 },
      { name: 'Binding Wire (per kg)', brand: 'Generic', sku: 'BM-SR-003', category: 'STEEL_REINFORCEMENT', cost: 1450, price: 2100, reorder: 100, measured: 'WEIGHT' },
      { name: 'Long-span Aluminium Roofing Sheet (0.55mm)', brand: 'Tower', sku: 'BM-RF-001', category: 'ROOFING', cost: 4800, price: 6400, reorder: 200, measured: 'LENGTH' },
      { name: 'Stone-Coated Roofing Tile (per m2)', brand: 'Gerard', sku: 'BM-RF-002', category: 'ROOFING', cost: 8600, price: 11800, reorder: 150, measured: 'AREA' },
      { name: '60x60 Porcelain Floor Tile (per m2)', brand: 'Goodwill', sku: 'BM-TF-001', category: 'TILES_FLOORING', cost: 5400, price: 7600, reorder: 200, measured: 'AREA', variants: [{ finish: ['Polished', 'Matte'] }] },
      { name: 'Emulsion Paint White 20L', brand: 'Captain', sku: 'BM-PC-001', category: 'PAINT_COATINGS', cost: 42000, price: 56000, reorder: 20, expiry: true },
      { name: 'Gloss Paint (per litre)', brand: 'Captain', sku: 'BM-PC-002', category: 'PAINT_COATINGS', cost: 4200, price: 6200, reorder: 100, measured: 'VOLUME', variants: [{ colour: ['White', 'Cream', 'Magnolia'] }] },
      { name: '2.5mm Single Core Cable (per metre)', brand: 'Cutix', sku: 'BM-EC-001', category: 'ELECTRICAL_CABLE', cost: 620, price: 950, reorder: 1000, measured: 'LENGTH', ladder: 'CABLE', registration: { authority: 'SON', type: 'SONCAP' } },
      { name: '4mm Twin & Earth Cable (per metre)', brand: 'Cutix', sku: 'BM-EC-002', category: 'ELECTRICAL_CABLE', cost: 1240, price: 1850, reorder: 600, measured: 'LENGTH' },
      { name: 'PVC Pipe 1/2" (4m length)', brand: 'Bulldog', sku: 'BM-PP-001', category: 'PLUMBING_PIPES', cost: 1450, price: 2200, reorder: 120 },
      { name: 'PPR Pipe 25mm (4m length)', brand: 'Bulldog', sku: 'BM-PP-002', category: 'PLUMBING_PIPES', cost: 3200, price: 4600, reorder: 80 },
      { name: 'Security Door (Turkish, Steel)', brand: 'Imported', sku: 'BM-DW-001', category: 'DOORS_WINDOWS', cost: 186000, price: 268000, reorder: 3, installation: true },
      { name: 'Aluminium Sliding Window 1.2x1.2m', brand: 'Local Fabrication', sku: 'BM-DW-002', category: 'DOORS_WINDOWS', cost: 78000, price: 118000, reorder: 4, installation: true },
      { name: 'WC Complete Set (Close-coupled)', brand: 'Kohler', sku: 'BM-SW-001', category: 'SANITARYWARE', cost: 96000, price: 148000, reorder: 5, installation: true },
      { name: 'Sharp Sand (per trip, 30 tons)', brand: 'Generic', sku: 'BM-AG-001', category: 'AGGREGATES', cost: 186000, price: 245000, reorder: 3, ladder: 'TRIP_ONLY' },
      { name: 'Granite 20mm (per trip)', brand: 'Generic', sku: 'BM-AG-002', category: 'AGGREGATES', cost: 486000, price: 618000, reorder: 2 },
      { name: 'Angle Grinder 4.5"', brand: 'Bosch', sku: 'BM-TH-001', category: 'TOOLS_HARDWARE', cost: 42000, price: 62000, reorder: 5, warranty: 12, serial: true },
    ]),
  },

  // -------------------------------------------------------------------
  // EVENT_RENTAL — chairs, canopies and tables go out and come back.
  // Ribbon, balloons and plates are sold. A planner may also take cartons.
  // -------------------------------------------------------------------
  EVENT_RENTAL: {
    code: 'EVENT_RENTAL',
    tradeModes: Object.freeze(['HIRE', 'RETAIL', 'WHOLESALE']),
    label: 'Event rental',
    blurb: 'Hire chairs, tables and canopies for a date, and sell the decorations and drinks on the same job. The hired goods stay yours. The deposit is held, not earned.',
    baseUnit: 'piece',
    defaultLadder: LADDERS.EACH_ONLY,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      bulkyDelivery: true, wholesalePricing: true, commissionTracking: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'TRADING_PERMIT', 'FIRE_CERT']),
    registrationAuthorities: Object.freeze(['SON']),
    variantAxes: Object.freeze([
      { name: 'Colour', options: ['White', 'Gold', 'Black', 'Clear'] },
    ]),
    customerClasses: CUSTOMER_CLASS_SETS.EVENT,
    expenseCategories: EXPENSE_CATEGORY_SETS.HIRE_YARD,
    returnReasons: Object.freeze(['DEFECTIVE', 'DAMAGED_IN_TRANSIT', 'WRONG_ITEM', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 0,
    categories: Object.freeze([
      { code: 'CHAIRS', name: 'Chairs' },
      { code: 'TABLES', name: 'Tables' },
      { code: 'CANOPIES', name: 'Canopies and tents' },
      { code: 'LINEN', name: 'Linen and covers' },
      { code: 'DECOR_SALE', name: 'Decorations for sale' },
      { code: 'CONSUMABLES', name: 'Consumables' },
    ]),
    seedProducts: Object.freeze([
      { name: 'White plastic chair', sku: 'ER-CH-001', category: 'CHAIRS', cost: 2500, price: 4500, reorder: 50, hire: true, hireRate: 200, hireDeposit: 500, sale: false },
      { name: 'Chiavari chair gold', sku: 'ER-CH-002', category: 'CHAIRS', cost: 8500, price: 14000, reorder: 20, hire: true, hireRate: 800, hireDeposit: 2000, sale: false },
      { name: 'Round banquet table', sku: 'ER-TB-001', category: 'TABLES', cost: 18000, price: 28000, reorder: 10, hire: true, hireRate: 1500, hireDeposit: 3000, sale: false },
      { name: 'Canopy 10 by 10', sku: 'ER-CP-001', category: 'CANOPIES', cost: 45000, price: 75000, reorder: 4, hire: true, hireRate: 8000, hireDeposit: 15000, sale: false, bulky: true },
      { name: 'Table cover white', sku: 'ER-LN-001', category: 'LINEN', cost: 1800, price: 3500, reorder: 30, hire: true, hireRate: 300, hireDeposit: 500, sale: true },
      { name: 'Balloon garland pack', sku: 'ER-DC-001', category: 'DECOR_SALE', cost: 4500, price: 9000, reorder: 12, sale: true },
      { name: 'Paper plates pack of 50', sku: 'ER-CS-001', category: 'CONSUMABLES', cost: 1200, price: 2200, reorder: 40, sale: true },
    ]),
  },

  // -------------------------------------------------------------------
  // EQUIPMENT_RENTAL — a generator or a mixer goes out for days, or on
  // a monthly lease, and a worn unit can still be sold.
  // -------------------------------------------------------------------
  EQUIPMENT_RENTAL: {
    code: 'EQUIPMENT_RENTAL',
    tradeModes: Object.freeze(['HIRE', 'LEASE', 'RETAIL']),
    label: 'Equipment rental',
    blurb: 'Hire a generator for a site day, lease one for a term, or sell a unit that has done its time. The hired and leased units stay on your books until they are sold.',
    baseUnit: 'unit',
    defaultLadder: LADDERS.EACH_ONLY,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      serialTracking: true, bulkyDelivery: true, commissionTracking: true, batchTracking: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'TRADING_PERMIT', 'SONCAP_DEALER']),
    registrationAuthorities: Object.freeze(['SON']),
    variantAxes: Object.freeze([
      { name: 'Capacity', options: ['2.5kVA', '5kVA', '10kVA'] },
    ]),
    customerClasses: CUSTOMER_CLASS_SETS.EVENT,
    expenseCategories: EXPENSE_CATEGORY_SETS.HIRE_YARD,
    returnReasons: Object.freeze(['DEFECTIVE', 'DAMAGED_IN_TRANSIT', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 0,
    categories: Object.freeze([
      { code: 'POWER', name: 'Generators and power' },
      { code: 'SITE_TOOLS', name: 'Site tools' },
      { code: 'ACCESS', name: 'Scaffold and access' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Generator 5kVA', sku: 'EQ-PW-001', category: 'POWER', cost: 280000, price: 420000, reorder: 2, serial: true, bulky: true, hire: true, lease: true, hireRate: 15000, leaseRate: 180000, hireDeposit: 50000, leaseDeposit: 100000, sale: true },
      { name: 'Concrete mixer', sku: 'EQ-ST-001', category: 'SITE_TOOLS', cost: 185000, price: 275000, reorder: 2, serial: true, bulky: true, hire: true, hireRate: 8000, hireDeposit: 25000, sale: true },
      { name: 'Scaffold frame', sku: 'EQ-AC-001', category: 'ACCESS', cost: 22000, price: 35000, reorder: 20, hire: true, hireRate: 500, hireDeposit: 2000, sale: false },
    ]),
  },

  // -------------------------------------------------------------------
  // LEASING — the asset stays the lessor's for the term. Rent is a
  // schedule. Buyout, if there is one, is the only sale.
  // -------------------------------------------------------------------
  LEASING: {
    code: 'LEASING',
    tradeModes: Object.freeze(['LEASE']),
    label: 'Leasing',
    blurb: 'A generator, a freezer or a till, out for months. Rent is income as it falls due. The deposit is held. The asset is sold only if the customer buys it at the end.',
    baseUnit: 'unit',
    defaultLadder: LADDERS.EACH_ONLY,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      serialTracking: true, bulkyDelivery: true, commissionTracking: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'SCUML']),
    registrationAuthorities: Object.freeze(['SON']),
    variantAxes: Object.freeze([
      { name: 'Capacity', options: ['Small', 'Medium', 'Large'] },
    ]),
    customerClasses: CUSTOMER_CLASS_SETS.LEASE_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.HIRE_YARD,
    returnReasons: Object.freeze(['DEFECTIVE', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 0,
    categories: Object.freeze([
      { code: 'POWER_LEASE', name: 'Power equipment' },
      { code: 'COLD_LEASE', name: 'Cold equipment' },
      { code: 'OFFICE_LEASE', name: 'Office equipment' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Generator 10kVA on lease', sku: 'LS-PW-001', category: 'POWER_LEASE', cost: 640000, price: 980000, reorder: 1, serial: true, bulky: true, lease: true, sale: false, leaseRate: 85000, leaseDeposit: 200000, buyout: 700000 },
      { name: 'Chest freezer 300L on lease', sku: 'LS-CL-001', category: 'COLD_LEASE', cost: 210000, price: 320000, reorder: 2, serial: true, bulky: true, lease: true, sale: false, leaseRate: 28000, leaseDeposit: 60000, buyout: 240000 },
      { name: 'Desktop till on lease', sku: 'LS-OF-001', category: 'OFFICE_LEASE', cost: 85000, price: 140000, reorder: 3, serial: true, lease: true, sale: false, leaseRate: 12000, leaseDeposit: 25000, buyout: 90000 },
    ]),
  },

  // -------------------------------------------------------------------
  // SELL_AND_LEASE — one shop, two movements. A freezer is sold. A
  // generator goes out on a term and stays on the books. The same receipt
  // can carry both, and the ledger keeps them apart.
  // -------------------------------------------------------------------
  SELL_AND_LEASE: {
    code: 'SELL_AND_LEASE',
    tradeModes: Object.freeze(['RETAIL', 'LEASE', 'WHOLESALE']),
    label: 'Sell and lease',
    blurb: 'Some goods are sold. Some are leased for a term and stay yours until the customer buys them. One shop, both ways, each with its own entry in the books.',
    baseUnit: 'unit',
    defaultLadder: LADDERS.EACH_ONLY,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      serialTracking: true, bulkyDelivery: true, wholesalePricing: true, commissionTracking: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'TRADING_PERMIT', 'SONCAP_DEALER']),
    registrationAuthorities: Object.freeze(['SON']),
    variantAxes: Object.freeze([{ name: 'Capacity', options: ['Small', 'Medium', 'Large'] }]),
    customerClasses: CUSTOMER_CLASS_SETS.LEASE_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.HIRE_YARD,
    returnReasons: Object.freeze(['DEFECTIVE', 'DAMAGED_IN_TRANSIT', 'OTHER']),
    defaultWarrantyMonths: 12,
    defaultReturnWindowDays: 7,
    categories: Object.freeze([
      { code: 'FOR_SALE', name: 'Goods for sale' },
      { code: 'ON_LEASE', name: 'Goods on lease' },
      { code: 'EITHER', name: 'Sale or lease' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Chest freezer 200L', sku: 'SL-SL-001', category: 'FOR_SALE', cost: 145000, price: 215000, reorder: 2, serial: true, bulky: true, sale: true },
      { name: 'Generator 5kVA on lease', sku: 'SL-LS-001', category: 'ON_LEASE', cost: 280000, price: 420000, reorder: 1, serial: true, bulky: true, lease: true, sale: false, leaseRate: 45000, leaseDeposit: 80000 },
      { name: 'Standing fan', sku: 'SL-EI-001', category: 'EITHER', cost: 18000, price: 32000, reorder: 6, sale: true, lease: true, leaseRate: 4000, leaseDeposit: 8000 },
    ]),
  },

  // -------------------------------------------------------------------
  // PROVISIONS_FABRICS — one shop, two sides of the floor. Rice and milk
  // are not the same takings as ankara. Category sales are a ledger fact,
  // not only a till total.
  // -------------------------------------------------------------------
  PROVISIONS_FABRICS: {
    code: 'PROVISIONS_FABRICS',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE']),
    label: 'Provisions and fabrics',
    blurb: 'A shop that sells provisions and also sells fabrics. Each category’s sales are posted on their own line in the books, so the owner can see which side of the shop earned the day.',
    baseUnit: 'piece',
    defaultLadder: LADDERS.EACH_ONLY,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      expiryTracking: true, batchTracking: true, wholesalePricing: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'TRADING_PERMIT', 'NAFDAC_PREMISES']),
    registrationAuthorities: Object.freeze(['NAFDAC', 'SON']),
    variantAxes: Object.freeze([{ name: 'Pack', options: ['Retail', 'Bag'] }]),
    customerClasses: CUSTOMER_CLASS_SETS.RETAIL_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.RETAIL_HEAVY,
    returnReasons: Object.freeze(['DEFECTIVE', 'WRONG_ITEM', 'CUSTOMER_CHANGE_OF_MIND', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 3,
    categories: Object.freeze([
      { code: 'PROVISIONS', name: 'Provisions' },
      { code: 'FABRICS', name: 'Fabrics' },
      { code: 'HOUSEHOLD', name: 'Household' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Peak Milk tin 400g', sku: 'PF-PR-001', category: 'PROVISIONS', cost: 650, price: 950, reorder: 24, expiry: true },
      { name: 'Golden Penny Semovita 10kg', sku: 'PF-PR-002', category: 'PROVISIONS', cost: 9800, price: 12500, reorder: 10 },
      { name: 'Parboiled rice 50kg', sku: 'PF-PR-003', category: 'PROVISIONS', cost: 62000, price: 78000, reorder: 8 },
      { name: 'Ankara 6 yards', sku: 'PF-FB-001', category: 'FABRICS', cost: 4500, price: 8500, reorder: 12 },
      { name: 'Lace 5 yards', sku: 'PF-FB-002', category: 'FABRICS', cost: 12000, price: 18500, reorder: 6 },
      { name: 'Washing soap bar', sku: 'PF-HH-001', category: 'HOUSEHOLD', cost: 180, price: 350, reorder: 48 },
    ]),
  },

  // -------------------------------------------------------------------
  // PHARMACEUTICAL — a dispensary. Prescription and controlled rules
  // apply only to products this profile marks. The Greenbook is a
  // reference catalogue the shop copies from. It is not the shared
  // Nigerian-market list, and it is not priced.
  // Starter prices below are placeholders the shop replaces.
  // -------------------------------------------------------------------
  PHARMACEUTICAL: {
    code: 'PHARMACEUTICAL',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE']),
    label: 'Pharmaceutical',
    blurb: 'A dispensary that also sells like a small supermarket. Drugs are recorded apart from provisions, drinks and toiletries. OTC sells over the counter. POM needs a prescriber. A controlled medicine needs the buyer’s name and phone, written into a register that a void cannot erase.',
    baseUnit: 'tablet',
    defaultLadder: LADDERS.PHARMA,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      expiryTracking: true, batchTracking: true, wholesalePricing: true,
      quarantine: true, recalls: true, dispensing: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'NAFDAC_PREMISES', 'PCN', 'SUPERINTENDENT', 'TRADING_PERMIT', 'FIRE_CERT']),
    registrationAuthorities: Object.freeze(['NAFDAC']),
    variantAxes: Object.freeze([{ name: 'Strength', options: ['Standard'] }]),
    customerClasses: CUSTOMER_CLASS_SETS.RETAIL_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.RETAIL_HEAVY,
    returnReasons: Object.freeze(['DEFECTIVE', 'WRONG_ITEM', 'RECALL', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 0,
    categories: Object.freeze([
      { code: 'ALIMENTARY', name: 'Alimentary' },
      { code: 'ANALGESICS', name: 'Analgesics' },
      { code: 'ANTIPARASITIC', name: 'Antiparasitic' },
      { code: 'CARDIOVASCULAR', name: 'Cardiovascular' },
      { code: 'CONTROLLED', name: 'Controlled medicines' },
      { code: 'DERMATOLOGY', name: 'Dermatology' },
      { code: 'INJECTIONS', name: 'Injections' },
      { code: 'RESPIRATORY', name: 'Respiratory' },
      { code: 'VITAMINS', name: 'Vitamins and supplements' },
      { code: 'PROVISIONS', name: 'Provisions' },
      { code: 'DRINKS', name: 'Drinks' },
      { code: 'SNACKS', name: 'Snacks' },
      { code: 'PERSONAL_CARE', name: 'Personal care' },
      { code: 'HOUSEHOLD', name: 'Household' },
      { code: 'BABY', name: 'Baby care' },
      { code: 'ACCESSORIES', name: 'Accessories' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Aciguard Antacid Suspension', sku: 'PH-OTC-001', category: 'ALIMENTARY', cost: 900, price: 1600, reorder: 12, expiry: true, ladder: 'EACH_ONLY', dispensing: 'OTC', nafdacReg: '04-4753' },
      { name: 'Albendazole 200', sku: 'PH-OTC-002', category: 'ANTIPARASITIC', cost: 850, price: 1500, reorder: 12, expiry: true, ladder: 'EACH_ONLY', dispensing: 'OTC', nafdacReg: 'A11-100325' },
      { name: 'Chemiron Vitamin C Syrup', sku: 'PH-OTC-003', category: 'VITAMINS', cost: 700, price: 1300, reorder: 10, expiry: true, ladder: 'EACH_ONLY', dispensing: 'OTC', nafdacReg: 'A11-100356' },
      { name: 'Cika Ketoconazole Cream', sku: 'PH-OTC-004', category: 'DERMATOLOGY', cost: 650, price: 1200, reorder: 8, expiry: true, ladder: 'EACH_ONLY', dispensing: 'OTC', nafdacReg: 'A11-100354' },
      { name: 'Apitol Caplets', sku: 'PH-OTC-005', category: 'RESPIRATORY', cost: 400, price: 900, reorder: 20, expiry: true, dispensing: 'OTC', nafdacReg: 'A11-100260' },
      { name: 'Cafekris', sku: 'PH-OTC-006', category: 'ANALGESICS', cost: 350, price: 800, reorder: 24, expiry: true, dispensing: 'OTC', nafdacReg: 'A11-100335' },
      { name: 'Amikacin Injection', sku: 'PH-POM-001', category: 'INJECTIONS', cost: 1800, price: 3200, reorder: 6, expiry: true, ladder: 'EACH_ONLY', dispensing: 'POM', nafdacReg: 'BA-0906' },
      { name: 'Amlodipine Tablets', sku: 'PH-POM-002', category: 'CARDIOVASCULAR', cost: 500, price: 1100, reorder: 20, expiry: true, dispensing: 'POM', nafdacReg: 'A11-0275' },
      { name: 'Dolburg 50', sku: 'PH-CTL-001', category: 'CONTROLLED', cost: 1200, price: 2400, reorder: 4, expiry: true, dispensing: 'POM', controlled: true, nafdacReg: 'A4-9351' },
      { name: 'Alpent Injection', sku: 'PH-CTL-002', category: 'CONTROLLED', cost: 2000, price: 3800, reorder: 4, expiry: true, ladder: 'EACH_ONLY', dispensing: 'POM', controlled: true, nafdacReg: 'B4-3655' },
      { name: 'Eva table water 75cl', sku: 'PH-SM-001', category: 'DRINKS', cost: 150, price: 300, reorder: 48, expiry: true, ladder: 'EACH_ONLY' },
      { name: 'Mama Gold rice 5kg', sku: 'PH-SM-002', category: 'PROVISIONS', cost: 8500, price: 12000, reorder: 8, expiry: true, ladder: 'EACH_ONLY' },
      { name: 'Dettol soap bar', sku: 'PH-SM-003', category: 'PERSONAL_CARE', cost: 250, price: 500, reorder: 24, ladder: 'EACH_ONLY' },
    ]),
  },

  // -------------------------------------------------------------------
  // SUPERMARKET — retail-led, expiry and carton ladders, many aisles.
  // Not a dispensary unless a product is marked. Starter prices are
  // placeholders. Pharmacy goods are not added to the shared market list.
  // -------------------------------------------------------------------
  SUPERMARKET: {
    code: 'SUPERMARKET',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE']),
    label: 'Supermarket',
    blurb: 'A retail floor with aisles. Provisions, drinks, household and frozen goods carry expiry and sell by the piece, the pack or the carton. Category sales stay separate in the books.',
    baseUnit: 'piece',
    defaultLadder: LADDERS.FMCG,
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      expiryTracking: true, batchTracking: true, wholesalePricing: true,
      quarantine: true, recalls: true, dispensing: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'NAFDAC_PREMISES', 'TRADING_PERMIT', 'FIRE_CERT']),
    registrationAuthorities: Object.freeze(['NAFDAC', 'SON']),
    variantAxes: Object.freeze([{ name: 'Pack', options: ['Retail', 'Family'] }]),
    customerClasses: CUSTOMER_CLASS_SETS.RETAIL_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.RETAIL_HEAVY,
    returnReasons: Object.freeze(['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'CUSTOMER_CHANGE_OF_MIND', 'RECALL', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 3,
    categories: Object.freeze([
      { code: 'BABY', name: 'Baby care' },
      { code: 'DRINKS', name: 'Drinks' },
      { code: 'FROZEN', name: 'Frozen' },
      { code: 'HOUSEHOLD', name: 'Household' },
      { code: 'PERSONAL_CARE', name: 'Personal care' },
      { code: 'PROVISIONS', name: 'Provisions' },
      { code: 'SNACKS', name: 'Snacks' },
      { code: 'ANALGESICS', name: 'Analgesics' },
      { code: 'VITAMINS', name: 'Vitamins and supplements' },
      { code: 'RESPIRATORY', name: 'Respiratory' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Peak evaporated milk 160g', sku: 'SM-PR-001', category: 'PROVISIONS', cost: 450, price: 750, reorder: 24, expiry: true },
      { name: 'Golden Penny sugar 1kg', sku: 'SM-PR-002', category: 'PROVISIONS', cost: 900, price: 1400, reorder: 20, expiry: true, ladder: 'EACH_ONLY' },
      { name: 'Indomie chicken flavour 70g', sku: 'SM-SN-001', category: 'SNACKS', cost: 150, price: 280, reorder: 48, expiry: true },
      { name: 'Hollandia yoghurt 1L', sku: 'SM-DR-001', category: 'DRINKS', cost: 800, price: 1300, reorder: 12, expiry: true, ladder: 'EACH_ONLY' },
      { name: 'Coca-Cola 50cl', sku: 'SM-DR-002', category: 'DRINKS', cost: 200, price: 400, reorder: 48 },
      { name: 'Morning Fresh 500ml', sku: 'SM-HH-001', category: 'HOUSEHOLD', cost: 600, price: 1100, reorder: 12, ladder: 'EACH_ONLY' },
      { name: 'Dettol soap bar', sku: 'SM-PC-001', category: 'PERSONAL_CARE', cost: 250, price: 500, reorder: 24 },
      { name: 'Pampers size 3', sku: 'SM-BB-001', category: 'BABY', cost: 3500, price: 5200, reorder: 6, ladder: 'EACH_ONLY' },
      { name: 'Frozen chicken drumsticks 1kg', sku: 'SM-FZ-001', category: 'FROZEN', cost: 2800, price: 4200, reorder: 10, expiry: true, ladder: 'EACH_ONLY' },
      { name: 'Cabin biscuit', sku: 'SM-SN-002', category: 'SNACKS', cost: 200, price: 400, reorder: 24, expiry: true },
    ]),
  },

  // -------------------------------------------------------------------
  // WATER_PACKING — sachet (pure water) and bottled table water
  // -------------------------------------------------------------------
  // One plant, two packs. The market bag is 20 sachets. Bottles sell by
  // the piece and by the pack. NAFDAC registers the premises and the
  // product; NIS 306 is the packaged-water standard. This is not a
  // pharmacy and it does not open the Greenbook.
  //
  // The gate prints a bill, the cashier takes the money, then the load
  // is released onto a vehicle. The suggested mix is an owned pickup
  // (the driver is paid a wage) and partner kekes (paid on the sales
  // they deliver). The owner confirms one or two types. Starter prices
  // are samples: a bag prices at 20 times the sachet, and a depot price
  // is the wholesale class, not a second hidden ladder.
  WATER_PACKING: {
    code: 'WATER_PACKING',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE']),
    label: 'Water packing (sachet and bottle)',
    blurb: 'Sachet pure water and bottled table water from one plant. Sell a sachet, a bag of 20, a bottle or a pack. The gate bills, takes payment, then releases the load. NAFDAC packaged water — not a pharmacy.',
    baseUnit: 'sachet',
    defaultLadder: LADDERS.WATER_SACHET,
    dispatch: true,
    dispatchDefaults: Object.freeze([
      { vehicleClass: 'PICKUP', arrangement: 'OWNED' },
      { vehicleClass: 'TRICYCLE', arrangement: 'PARTNER', salesSharePct: 8 },
    ]),
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      expiryTracking: true, batchTracking: true, quarantine: true, recalls: true,
      wholesalePricing: true, bulkyDelivery: true, commissionTracking: true,
      billBeforeReceipt: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'NAFDAC_PREMISES', 'NIS_PACKAGED_WATER', 'FOOD_HANDLERS', 'TRADING_PERMIT', 'FIRE_CERT']),
    registrationAuthorities: Object.freeze(['NAFDAC', 'SON']),
    variantAxes: Object.freeze([]),
    customerClasses: CUSTOMER_CLASS_SETS.ROUTE_TRADE,
    expenseCategories: EXPENSE_CATEGORY_SETS.PRODUCTION,
    returnReasons: Object.freeze(['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'RECALL', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 2,
    categories: Object.freeze([
      { code: 'SACHET_WATER', name: 'Sachet water (pure water)' },
      { code: 'BOTTLED_WATER', name: 'Bottled table water' },
      { code: 'DISPENSER_WATER', name: 'Dispenser and jerrycan' },
      { code: 'PACKAGING', name: 'Film, bags and labels' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Sachet water 50cl', sku: 'WP-SW-001', category: 'SACHET_WATER', cost: 14, price: 25, reorder: 200, ladder: 'WATER_SACHET', expiry: true, bulky: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Sachet water 60cl', sku: 'WP-SW-002', category: 'SACHET_WATER', cost: 16, price: 30, reorder: 120, ladder: 'WATER_SACHET', expiry: true, bulky: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Table water 50cl bottle', sku: 'WP-BW-001', category: 'BOTTLED_WATER', cost: 55, price: 100, reorder: 40, ladder: 'WATER_BOTTLE', expiry: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Table water 75cl bottle', sku: 'WP-BW-002', category: 'BOTTLED_WATER', cost: 80, price: 150, reorder: 40, ladder: 'WATER_BOTTLE', expiry: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Table water 1.5L bottle', sku: 'WP-BW-003', category: 'BOTTLED_WATER', cost: 120, price: 250, reorder: 24, ladder: 'WATER_LARGE', expiry: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Dispenser refill 19L', sku: 'WP-DW-001', category: 'DISPENSER_WATER', cost: 600, price: 1200, reorder: 20, ladder: 'WATER_JERRY', expiry: true, bulky: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Dispenser bottle 19L', sku: 'WP-DW-002', category: 'DISPENSER_WATER', cost: 1800, price: 3500, reorder: 8, ladder: 'WATER_JERRY', bulky: true },
      { name: 'Printed sachet film (roll)', sku: 'WP-PK-001', category: 'PACKAGING', cost: 18000, price: 18000, reorder: 4, ladder: 'EACH_ONLY', sale: false },
    ]),
  },

  // -------------------------------------------------------------------
  // BAKERY — bake, then sell retail and wholesale
  // -------------------------------------------------------------------
  // The oven and the counter are the same business. A walk-in buys one
  // loaf. A depot, a kiosk, a school or a hotel takes a nylon of 10
  // before the crumb goes stale. Pies and snacks sell by the piece and
  // by the pack of 6. Returns are short because bread does not wait.
  //
  // Suggested dispatch: an owned van for the wholesale round (driver on
  // a wage) and partner motorcycles for the neighbourhood (paid on the
  // sales they deliver). The owner confirms one or two types.
  BAKERY: {
    code: 'BAKERY',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE']),
    label: 'Bakery (retail and wholesale)',
    blurb: 'Bake, then sell at the counter and to depots, kiosks, schools and hotels. A loaf, a nylon of 10, a pie or a pack. The shift bills the load, takes payment, then the van or the bike leaves with the bread.',
    baseUnit: 'loaf',
    defaultLadder: LADDERS.BAKERY_LOAF,
    dispatch: true,
    dispatchDefaults: Object.freeze([
      { vehicleClass: 'VAN', arrangement: 'OWNED' },
      { vehicleClass: 'BIKE', arrangement: 'PARTNER', salesSharePct: 10 },
    ]),
    features: Object.freeze({
      ...ALL_FEATURES_OFF,
      expiryTracking: true, batchTracking: true, quarantine: true, recalls: true,
      wholesalePricing: true, bulkyDelivery: true, commissionTracking: true,
      billBeforeReceipt: true,
    }),
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'NAFDAC_PREMISES', 'FOOD_HANDLERS', 'TRADING_PERMIT', 'FIRE_CERT']),
    registrationAuthorities: Object.freeze(['NAFDAC', 'SON']),
    variantAxes: Object.freeze([]),
    customerClasses: CUSTOMER_CLASS_SETS.ROUTE_TRADE,
    expenseCategories: EXPENSE_CATEGORY_SETS.PRODUCTION,
    returnReasons: Object.freeze(['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'CUSTOMER_CHANGE_OF_MIND', 'OTHER']),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 1,
    categories: Object.freeze([
      { code: 'BREAD', name: 'Bread' },
      { code: 'PASTRY', name: 'Pies, rolls and doughnuts' },
      { code: 'SNACKS', name: 'Chin-chin and small chops' },
      { code: 'CAKES', name: 'Cakes' },
      { code: 'INGREDIENTS', name: 'Flour, sugar and yeast' },
    ]),
    seedProducts: Object.freeze([
      { name: 'Agege bread', sku: 'BK-BR-001', category: 'BREAD', cost: 450, price: 900, reorder: 40, ladder: 'BAKERY_LOAF', expiry: true, bulky: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Sliced family loaf', sku: 'BK-BR-002', category: 'BREAD', cost: 700, price: 1400, reorder: 24, ladder: 'BAKERY_LOAF', expiry: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Butter bread', sku: 'BK-BR-003', category: 'BREAD', cost: 500, price: 1000, reorder: 24, ladder: 'BAKERY_LOAF', expiry: true, registration: { authority: 'NAFDAC', type: 'NAFDAC_REG' } },
      { name: 'Meat pie', sku: 'BK-PA-001', category: 'PASTRY', cost: 180, price: 400, reorder: 30, ladder: 'BAKERY_PIECE', expiry: true },
      { name: 'Doughnut', sku: 'BK-PA-002', category: 'PASTRY', cost: 120, price: 300, reorder: 30, ladder: 'BAKERY_PIECE', expiry: true },
      { name: 'Chin-chin 500g', sku: 'BK-SN-001', category: 'SNACKS', cost: 700, price: 1500, reorder: 16, ladder: 'EACH_ONLY', expiry: true },
      { name: 'Small chops pack', sku: 'BK-SN-002', category: 'SNACKS', cost: 1200, price: 2500, reorder: 12, ladder: 'EACH_ONLY', expiry: true },
      { name: 'Plain cake loaf', sku: 'BK-CK-001', category: 'CAKES', cost: 1500, price: 3000, reorder: 8, ladder: 'EACH_ONLY', expiry: true },
      { name: 'Flour 50kg', sku: 'BK-IN-001', category: 'INGREDIENTS', cost: 42000, price: 48000, reorder: 6, ladder: 'BAG_ONLY', expiry: true },
      { name: 'Sugar 50kg', sku: 'BK-IN-002', category: 'INGREDIENTS', cost: 48000, price: 55000, reorder: 4, ladder: 'BAG_ONLY', expiry: true },
    ]),
  },

  // -------------------------------------------------------------------
  // GENERAL_RETAIL — the blank, fully-configurable profile
  // -------------------------------------------------------------------
  // Exists so a deployment is never forced into a vertical that does not
  // fit. Everything is on, every category is the client's to define.
  GENERAL_RETAIL: {
    code: 'GENERAL_RETAIL',
    tradeModes: Object.freeze(['RETAIL', 'WHOLESALE', 'HIRE', 'LEASE']),
    label: 'General Retail (fully configurable)',
    blurb: 'No assumptions. Every module available; you define your own categories, units and compliance records.',
    baseUnit: 'piece',
    defaultLadder: LADDERS.EACH_ONLY,
    features: ALL_FEATURES_ON,
    complianceFields: Object.freeze(['CAC', 'TIN', 'VAT_REG', 'TRADING_PERMIT', 'FIRE_CERT']),
    registrationAuthorities: Object.freeze(['SON', 'NAFDAC', 'NCC', 'MAN', 'CITES']),
    variantAxes: Object.freeze([{ name: 'Variant', options: ['Standard'] }]),
    customerClasses: CUSTOMER_CLASS_SETS.RETAIL_LED,
    expenseCategories: EXPENSE_CATEGORY_SETS.GENERAL,
    returnReasons: Object.freeze(RETURN_REASONS.map((r) => r.code)),
    defaultWarrantyMonths: 0,
    defaultReturnWindowDays: 7,
    categories: Object.freeze([
      { code: 'GENERAL', name: 'General' },
      { code: 'OTHER', name: 'Other' },
    ]),
    seedProducts: Object.freeze([]),
  },
});

const PROFILE_CODES = Object.freeze(Object.keys(PROFILES));
const DEFAULT_PROFILE_CODE = 'GENERAL_RETAIL';

function isProfileCode(code) {
  return Object.prototype.hasOwnProperty.call(PROFILES, String(code || '').toUpperCase());
}

/**
 * The profile for a code, or **null** when the code is not one we have.
 *
 * THIS FUNCTION USED TO FALL BACK TO GENERAL_RETAIL SILENTLY, and two guards that
 * checked its result were therefore dead code:
 *
 *   provisioningService: `if (!getProfile(profileCode)) throw UNKNOWN_PROFILE`
 *   catalog.js:           `if (!profile) throw UNKNOWN_PROFILE`
 *
 * Neither could ever fire, because the lookup always returned something. The live
 * consequence: an administrator (or an API client) provisioning a business with a
 * vertical StockRidge does not have — "WHOLESALE" instead of "WHOLESALE_RETAIL" —
 * got a GENERAL_RETAIL business instead. Wrong category tree, wrong feature set,
 * and NO STARTER CATALOGUE, with no error anywhere. It was found exactly that way:
 * a test asked for 'WHOLESALE', received an empty catalogue, and the first
 * explanation that came to mind was "the wholesale vertical has no products".
 *
 * An unknown code is now null. Callers reading STORED data — a business row
 * written by an older version, a code that has since been renamed — should use
 * `getProfileOrDefault`, which is explicit about tolerating that.
 */
function getProfile(code) {
  const key = String(code || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(PROFILES, key) ? PROFILES[key] : null;
}

/**
 * The profile for a code, falling back to GENERAL_RETAIL when it is not one we
 * know. For READING stored data, where a legacy or renamed code must not break a
 * screen. Never use this to validate input: it accepts everything.
 */
function getProfileOrDefault(code) {
  return getProfile(code) || PROFILES[DEFAULT_PROFILE_CODE];
}

/**
 * Resolve a profile with per-business overrides applied.
 *
 * `overrides` is businesses.profile_overrides_json parsed. It is a shallow
 * merge on features/complianceFields and a replace on categories, so a
 * client can add a category the profile did not anticipate without losing
 * the rest of the profile's configuration.
 */
function resolveProfile(code, overrides) {
  // Tolerant on purpose: this is the path that reads a business's STORED profile,
  // including one written by an older version of the app whose code has since been
  // renamed. A screen must not stop drawing because of that.
  const base = getProfileOrDefault(code);
  if (!overrides || typeof overrides !== 'object') return base;
  const out = { ...base };
  if (overrides.features && typeof overrides.features === 'object') {
    out.features = Object.freeze({ ...base.features, ...overrides.features });
  }
  if (Array.isArray(overrides.categories) && overrides.categories.length) {
    out.categories = Object.freeze([...base.categories, ...overrides.categories]);
  }
  if (Array.isArray(overrides.complianceFields)) {
    out.complianceFields = Object.freeze([...new Set([...base.complianceFields, ...overrides.complianceFields])]);
  }
  if (typeof overrides.baseUnit === 'string') out.baseUnit = overrides.baseUnit;
  if (Number.isFinite(overrides.defaultWarrantyMonths)) out.defaultWarrantyMonths = overrides.defaultWarrantyMonths;
  if (Number.isFinite(overrides.defaultReturnWindowDays)) out.defaultReturnWindowDays = overrides.defaultReturnWindowDays;
  // An owner can add hire to a furniture shop, or drop wholesale from a
  // general shop, without changing the category tree. The set replaces,
  // it does not merge: the screen is asking "which of these does this
  // business actually do", and a merge would turn a mode back on that
  // the owner had switched off.
  if (Array.isArray(overrides.tradeModes)) {
    const { normaliseModes } = require('./trade');
    out.tradeModes = Object.freeze(normaliseModes(overrides.tradeModes, base.tradeModes));
  }
  return out;
}

/** True when a profile switches a given feature on. */
function featureEnabled(profile, flag) {
  return Boolean(profile && profile.features && profile.features[flag]);
}

/** Human-readable feature summary, for the business setup screen. */
function describeProfile(code) {
  // Accepts a profile object (the common case — callers already have one) or a
  // code. A code we do not know describes nothing rather than describing
  // GENERAL_RETAIL as though it were what was asked for.
  const p = typeof code === 'object' && code ? code : getProfileOrDefault(code);
  if (!p) return null;
  return {
    code: p.code,
    label: p.label,
    // THE SAME STRING UNDER THE NAME EVERY OTHER LIST ROUTE USES. `/api/profiles` and
    // `/api/catalogue/profiles` both answer these four, and a caller choosing a vertical had to
    // know which of the two it had called to find a human-readable name — one nested it under
    // `profile.label` and the other answered `label`. A chooser should not have to.
    name: p.label,
    blurb: p.blurb,
    baseUnit: p.baseUnit,
    tradeModes: Array.isArray(p.tradeModes) ? p.tradeModes : ['RETAIL'],
    dispatch: p.dispatch ? summariseModes(p.dispatchDefaults) : null,
    enabledFeatures: FEATURE_FLAGS.filter((f) => p.features[f]),
    disabledFeatures: FEATURE_FLAGS.filter((f) => !p.features[f]),
    categoryCount: p.categories.length,
    complianceFields: p.complianceFields.map((c) => (COMPLIANCE_FIELDS[c] || { label: c }).label),
  };
}

module.exports = {
  PROFILES, PROFILE_CODES, DEFAULT_PROFILE_CODE,
  FEATURE_FLAGS, ALL_FEATURES_ON, ALL_FEATURES_OFF,
  LADDERS, MEASURE_AXES, MEASURE_LADDERS, COMPLIANCE_FIELDS, REGISTRATION_AUTHORITIES,
  CUSTOMER_CLASS_SETS, RETURN_REASONS, EXPENSE_CATEGORY_SETS,
  isProfileCode, getProfile, getProfileOrDefault, resolveProfile, featureEnabled, describeProfile,
  ladderForSeedProduct, baseUnitNameFor,
};
