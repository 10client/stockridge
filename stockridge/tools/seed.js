// =====================================================================
// StockRidge — DEMONSTRATION SEED
// =====================================================================
// Builds a realistic multi-business, multi-branch dataset so the product can
// be evaluated against something that looks like an actual Nigerian trading
// business rather than an empty database.
//
//   3 business units, 4 industry profiles represented:
//     RIDGE-APPL   Electronics, Appliances & Gadgets  — 3 branches
//     RIDGE-HOME   Furniture & Home Furnishing        — 2 branches
//     RIDGE-TRADE  General Merchandise Wholesale      — 3 branches
//
// PINs are randomly generated and HASHED with PBKDF2 — never stored in plain
// text even in a demo, because a seed file that carries a usable PIN is a
// credential that ships to every clone. The generated PINs are written to
// data/seed-credentials.json, which is gitignored.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { newId, hashPin, watNowIso, watDate, addDays } = require('../shared/ids');
const { round2 } = require('../shared/money');
const { PROFILES, getProfile } = require('../shared/industryProfiles');
const productService = require('../server/services/productService');
const expenseService = require('../server/services/expenseService');
const glService = require('../server/services/glService');
const { SEED_RATES } = require('../server/lib/wht');

const OUT_DIR = path.join(__dirname, '..', 'data');

// ---------------------------------------------------------------------
// CATALOGUE DATA
// ---------------------------------------------------------------------
// Real Nigerian market products with realistic 2026 price levels. Prices are
// deliberately not round numbers: a catalogue of ₦100,000 / ₦200,000 items
// would not exercise the kobo-precision paths that matter.
const ELECTRONICS = [
  { name: 'Samsung Galaxy A15 128GB', brand: 'Samsung', cat: 'MOBILE_PHONES', cost: 168500, price: 214900, uom: 'UNIT', serials: true, warranty: 12, class: 'SMALL', attrs: { storage_capacity: '128GB', screen_size_inches: 6.5, colour: 'Blue Black' } },
  { name: 'Tecno Spark 20C 128GB', brand: 'Tecno', cat: 'MOBILE_PHONES', cost: 108000, price: 143500, uom: 'UNIT', serials: true, warranty: 12, class: 'SMALL', attrs: { storage_capacity: '128GB', screen_size_inches: 6.6 } },
  { name: 'iPhone 13 128GB (UK used, grade A)', brand: 'Apple', cat: 'MOBILE_PHONES', cost: 495000, price: 618000, uom: 'UNIT', serials: true, warranty: 3, class: 'SMALL', attrs: { storage_capacity: '128GB', screen_size_inches: 6.1 } },
  { name: 'Infinix Hot 40i 256GB', brand: 'Infinix', cat: 'MOBILE_PHONES', cost: 132000, price: 171500, uom: 'UNIT', serials: true, warranty: 12, class: 'SMALL', attrs: { storage_capacity: '256GB' } },
  { name: 'HP EliteBook 840 G6 Core i5 16GB/512GB', brand: 'HP', cat: 'LAPTOPS_COMPUTERS', cost: 412000, price: 528500, uom: 'UNIT', serials: true, warranty: 6, class: 'MEDIUM', attrs: { storage_capacity: '512GB SSD', screen_size_inches: 14 } },
  { name: 'Lenovo ThinkPad T480 Core i7 16GB/1TB', brand: 'Lenovo', cat: 'LAPTOPS_COMPUTERS', cost: 468000, price: 596000, uom: 'UNIT', serials: true, warranty: 6, class: 'MEDIUM' },
  { name: 'Hisense 43" Smart TV 43A4K', brand: 'Hisense', cat: 'TV_AUDIO', cost: 218000, price: 289900, uom: 'UNIT', serials: true, warranty: 24, class: 'LARGE', attrs: { screen_size_inches: 43, power_watts: 75 } },
  { name: 'LG 55" UHD Smart TV 55UR78', brand: 'LG', cat: 'TV_AUDIO', cost: 486000, price: 624500, uom: 'UNIT', serials: true, warranty: 24, class: 'LARGE', attrs: { screen_size_inches: 55 } },
  { name: 'Binatone 1.8L Electric Kettle KE-1840', brand: 'Binatone', cat: 'KITCHEN_APPLIANCES', cost: 9800, price: 14950, uom: 'UNIT', serials: false, warranty: 12, class: 'SMALL', pack: 6, attrs: { power_watts: 1500 } },
  { name: 'Century 20L Microwave Oven CMW-20', brand: 'Century', cat: 'KITCHEN_APPLIANCES', cost: 62500, price: 84900, uom: 'UNIT', serials: true, warranty: 12, class: 'MEDIUM' },
  { name: 'Ox 7.5kVA Key Start Generator', brand: 'Ox', cat: 'GENERATORS', cost: 425000, price: 539000, uom: 'UNIT', serials: true, warranty: 12, class: 'BULKY', attrs: { power_watts: 7500 } },
  { name: 'Luminous 1.5kVA Inverter + 200Ah Battery Bundle', brand: 'Luminous', cat: 'SOLAR_POWER', cost: 318000, price: 412500, uom: 'SET', serials: true, warranty: 24, class: 'BULKY' },
  { name: '450W Monocrystalline Solar Panel', brand: 'Felicity', cat: 'SOLAR_POWER', cost: 96500, price: 128000, uom: 'UNIT', serials: false, warranty: 60, class: 'LARGE', attrs: { power_watts: 450 } },
  { name: 'Anker 20000mAh Power Bank A1257', brand: 'Anker', cat: 'PHONE_ACCESSORIES', cost: 15800, price: 24500, uom: 'PIECE', serials: false, warranty: 18, class: 'SMALL', pack: 20 },
  { name: 'USB-C Fast Charge Cable 1m (braided)', brand: 'Oraimo', cat: 'CABLES_CONNECTORS', cost: 1450, price: 3200, uom: 'PIECE', serials: false, warranty: 6, class: 'SMALL', pack: 50 },
  { name: '18W USB-C Wall Charger', brand: 'Oraimo', cat: 'PHONE_ACCESSORIES', cost: 2900, price: 5900, uom: 'PIECE', serials: false, warranty: 12, class: 'SMALL', pack: 40 },
  { name: 'Logitech M170 Wireless Mouse', brand: 'Logitech', cat: 'COMPUTER_ACCESSORIES', cost: 5400, price: 9200, uom: 'PIECE', serials: false, warranty: 12, class: 'SMALL', pack: 24 },
  { name: 'PlayStation 5 Slim Digital Edition', brand: 'Sony', cat: 'GAMING', cost: 645000, price: 798000, uom: 'UNIT', serials: true, warranty: 12, class: 'MEDIUM' },
  { name: 'Hikvision 2MP Dome Camera + 4-Ch DVR Kit', brand: 'Hikvision', cat: 'SMART_HOME', cost: 128000, price: 172500, uom: 'SET', serials: false, warranty: 24, class: 'MEDIUM', install: true },
  { name: 'Canon EOS 4000D DSLR + 18-55mm', brand: 'Canon', cat: 'CAMERAS', cost: 288000, price: 372000, uom: 'SET', serials: true, warranty: 12, class: 'MEDIUM' },
  { name: 'Haier Thermocool 1.5HP Split Air Conditioner', brand: 'Thermocool', cat: 'HOME_APPLIANCES', cost: 342000, price: 448500, uom: 'UNIT', serials: true, warranty: 60, class: 'BULKY', install: true },
  { name: 'Nexus 250L Double Door Refrigerator', brand: 'Nexus', cat: 'HOME_APPLIANCES', cost: 296000, price: 389000, uom: 'UNIT', serials: true, warranty: 24, class: 'BULKY' },
];

const FURNITURE = [
  { name: '7-Seater L-Shape Leather Sofa Set', cat: 'SOFA_SEATING', cost: 485000, price: 742000, uom: 'SET', warranty: 24, class: 'BULKY', attrs: { material: 'Italian leatherette, hardwood frame', colour: 'Cognac brown', dimensions_cm: '280 x 190 x 85', seat_capacity: 7 } },
  { name: '3-Seater Fabric Sofa (Ankara accent)', cat: 'SOFA_SEATING', cost: 198000, price: 312500, uom: 'SET', warranty: 24, class: 'LARGE', attrs: { material: 'Woven fabric, kiln-dried mahogany', seat_capacity: 3 } },
  { name: '6x6 Spring Mattress (10 inch, orthopaedic)', cat: 'BEDS_MATTRESSES', cost: 128000, price: 189500, uom: 'PIECE', warranty: 60, class: 'BULKY', attrs: { material: 'Bonnel spring, quilted knitted cover', dimensions_cm: '183 x 183 x 25' } },
  { name: 'King Bed Frame with Hydraulic Storage', cat: 'BEDS_MATTRESSES', cost: 265000, price: 418000, uom: 'PIECE', warranty: 24, class: 'BULKY', assembly: true, attrs: { material: 'MDF + solid oak legs', dimensions_cm: '200 x 190 x 110' } },
  { name: '4-Door Wardrobe with Mirror and Safe Drawer', cat: 'WARDROBES_STORAGE', cost: 232000, price: 365000, uom: 'PIECE', warranty: 24, class: 'BULKY', assembly: true, attrs: { material: 'Laminated MDF, aluminium rails', dimensions_cm: '180 x 60 x 220' } },
  { name: '8-Seater Marble Top Dining Set', cat: 'DINING', cost: 398000, price: 612000, uom: 'SET', warranty: 24, class: 'BULKY', attrs: { material: 'Italian marble, solid ash', seat_capacity: 8 } },
  { name: 'Executive Office Desk 1.8m with Return', cat: 'OFFICE_FURNITURE', cost: 186000, price: 289500, uom: 'PIECE', warranty: 24, class: 'LARGE', assembly: true, attrs: { material: 'Veneered MDF, steel frame', dimensions_cm: '180 x 160 x 75' } },
  { name: 'Ergonomic Mesh Office Chair (headrest)', cat: 'OFFICE_FURNITURE', cost: 68500, price: 112000, uom: 'PIECE', warranty: 36, class: 'MEDIUM', assembly: true, attrs: { material: 'Breathable mesh, nylon base' } },
  { name: 'Blackout Curtain Fabric (per metre)', cat: 'CURTAINS_BLINDS', cost: 3400, price: 6200, uom: 'METRE', warranty: 0, class: 'SMALL', attrs: { material: '3-pass blackout, 280cm width', colour: 'Assorted' } },
  { name: '5x8 Persian Area Rug', cat: 'RUGS_CARPETS', cost: 78000, price: 128500, uom: 'PIECE', warranty: 0, class: 'MEDIUM', attrs: { material: 'Polypropylene pile, cotton backing', dimensions_cm: '150 x 240' } },
  { name: '5-Drawer Chest of Drawers (walnut finish)', cat: 'WARDROBES_STORAGE', cost: 118000, price: 186500, uom: 'PIECE', warranty: 24, class: 'LARGE', assembly: true, attrs: { material: 'Walnut veneer, soft-close runners' } },
  { name: 'Made-to-Order Kitchen Cabinet Run (per metre)', cat: 'KITCHEN_CABINETRY', cost: 42000, price: 68500, uom: 'METRE', warranty: 60, class: 'LARGE', madeToOrder: true, leadTime: 21, install: true, attrs: { material: 'HDF carcass, acrylic door', lead_time_days: 21 } },
  { name: 'Rattan Garden 5-Piece Set (outdoor)', cat: 'OUTDOOR_GARDEN', cost: 245000, price: 386000, uom: 'SET', warranty: 12, class: 'BULKY', attrs: { material: 'All-weather PE rattan, powder-coated aluminium', seat_capacity: 5 } },
  { name: 'Pendant Ceiling Light Fixture (3-globe)', cat: 'LIGHTING', cost: 24500, price: 42800, uom: 'PIECE', warranty: 12, class: 'SMALL', pack: 12 },
  { name: 'Decorative Wall Mirror 90cm Round', cat: 'HOME_DECOR', cost: 32000, price: 54500, uom: 'PIECE', warranty: 0, class: 'MEDIUM' },
];

const MERCHANDISE = [
  { name: 'Golden Penny Semovita 2kg', cat: 'FOODSTUFFS', cost: 2850, price: 3650, uom: 'PIECE', pack: 12, carton: 2, expiry: 540, attrs: { brand: 'Golden Penny', pack_size: '2kg', shelf_life_days: 540 } },
  { name: 'Indomie Chicken Flavour Noodles (carton of 40)', cat: 'PROVISIONS', cost: 8650, price: 10950, uom: 'PIECE', pack: 40, carton: 1, expiry: 270, attrs: { brand: 'Indomie', pack_size: '70g x 40', shelf_life_days: 270 } },
  { name: 'Coca-Cola 50cl PET (crate of 12)', cat: 'BEVERAGES', cost: 4200, price: 5400, uom: 'BOTTLE', pack: 12, expiry: 180, attrs: { brand: 'Coca-Cola', pack_size: '50cl', shelf_life_days: 180 } },
  { name: 'Peak Powdered Milk 400g Tin', cat: 'FOODSTUFFS', cost: 4850, price: 6150, uom: 'PIECE', pack: 24, expiry: 365, attrs: { brand: 'Peak', pack_size: '400g', shelf_life_days: 365 } },
  { name: 'Omo Detergent 900g', cat: 'HOUSEHOLD', cost: 2350, price: 3150, uom: 'PIECE', pack: 12, expiry: 720, attrs: { brand: 'Omo', pack_size: '900g' } },
  { name: 'Hypo Bleach 1L', cat: 'HOUSEHOLD', cost: 890, price: 1350, uom: 'BOTTLE', pack: 12, expiry: 540 },
  { name: 'Close-Up Toothpaste 140g', cat: 'PERSONAL_CARE', cost: 1150, price: 1720, uom: 'PIECE', pack: 24, expiry: 730 },
  { name: 'Pampers Baby Dry Size 4 (jumbo 74s)', cat: 'BABY_PRODUCTS', cost: 12800, price: 16450, uom: 'PACK', pack: 74, expiry: 1095, attrs: { brand: 'Pampers', pack_size: '74 count' } },
  { name: 'Biro Pen Blue (box of 50)', cat: 'STATIONERY', cost: 1850, price: 3200, uom: 'BOX', pack: 50 },
  { name: 'A4 Copy Paper 80gsm (ream of 500)', cat: 'STATIONERY', cost: 4650, price: 6250, uom: 'BOX', pack: 500, carton: 5 },
  { name: 'Philips LED Bulb 9W (pack of 10)', cat: 'ELECTRICALS', cost: 6800, price: 9950, uom: 'PIECE', pack: 10, attrs: { brand: 'Philips', pack_size: '9W bayonet' } },
  { name: 'Nigerian Long Grain Rice 50kg (Mama Gold)', cat: 'FOODSTUFFS', cost: 62500, price: 74800, uom: 'BAG', pack: 1, expiry: 365, attrs: { brand: 'Mama Gold', pack_size: '50kg', shelf_life_days: 365 } },
  { name: 'Groundnut Oil 5L Jerry Can', cat: 'FOODSTUFFS', cost: 11800, price: 14950, uom: 'LITRE', pack: 5, expiry: 365 },
  { name: 'Dettol Antiseptic 750ml', cat: 'PERSONAL_CARE', cost: 3450, price: 4680, uom: 'BOTTLE', pack: 12, expiry: 730 },
];

const BUILDING = [
  { name: 'Dangote Cement 50kg (32.5R)', cat: 'CEMENT_BINDERS', cost: 7850, price: 9200, uom: 'BAG', pack: 1, expiry: 90, attrs: { grade: '32.5R', weight_kg: 50, origin: 'Dangote Obajanu', shelf_life_days: 90 } },
  { name: 'BUA Cement 50kg (42.5N)', cat: 'CEMENT_BINDERS', cost: 8250, price: 9650, uom: 'BAG', expiry: 90, attrs: { grade: '42.5N', weight_kg: 50 } },
  { name: '12mm High-Tensile Rebar Rod (12m length)', cat: 'STEEL_REBAR', cost: 14800, price: 17600, uom: 'LENGTH', attrs: { size_mm: '12', weight_kg: 10.7, grade: 'B500B', origin: 'African Foundries' } },
  { name: '0.55mm Aluminium Roofing Sheet (Longspan, per m)', cat: 'ROOFING', cost: 3850, price: 4900, uom: 'METRE', attrs: { size_mm: '0.55', grade: 'Longspan' } },
  { name: '9 Inch Sandcrete Block (per block)', cat: 'BLOCKS_BRICKS', cost: 420, price: 620, uom: 'PIECE' },
  { name: 'Sharp Sand (per cubic metre, delivered)', cat: 'SAND_GRAVEL', cost: 18500, price: 24500, uom: 'CUBIC_METRE' },
  { name: 'Granite Chippings 3/4 inch (per cubic metre)', cat: 'SAND_GRAVEL', cost: 32500, price: 41500, uom: 'CUBIC_METRE' },
  { name: '2x3 Hardwood Timber (3.6m length)', cat: 'TIMBER', cost: 1850, price: 2650, uom: 'LENGTH' },
  { name: '40mm PVC Pressure Pipe (6m length)', cat: 'PLUMBING', cost: 5850, price: 7600, uom: 'LENGTH', attrs: { size_mm: '40' } },
  { name: 'Emulsion Paint 20L (white, premium)', cat: 'PAINTS_COATINGS', cost: 42500, price: 56800, uom: 'LITRE', pack: 20, expiry: 540, attrs: { shelf_life_days: 540 } },
  { name: '600x600 Porcelain Floor Tile (per m²)', cat: 'TILES_FLOORING', cost: 4850, price: 6900, uom: 'SQUARE_METRE', attrs: { size_mm: '600x600', grade: 'Polished porcelain' } },
  { name: 'Security Door (Turkish, double leaf)', cat: 'DOORS_WINDOWS', cost: 186000, price: 245000, uom: 'PIECE', attrs: { size_mm: '1200x2100' } },
  { name: 'Safety Helmet with Chin Strap', cat: 'SAFETY_EQUIPMENT', cost: 2450, price: 3900, uom: 'PIECE', pack: 20 },
  { name: 'Angle Grinder 4.5 inch 850W', cat: 'TOOLS_HARDWARE', cost: 24500, price: 34800, uom: 'UNIT', warranty: 12, serials: true },
];

const BRANCHES_BY_UNIT = {
  'RIDGE-APPL': [
    { code: 'IKEJA', name: 'Ikeja Computer Village Flagship', type: 'BOTH', state: 'Lagos', city: 'Ikeja', address: '12 Otigba Street, Computer Village, Ikeja', lat: 6.5965, lng: 3.3421, main: true },
    { code: 'LEKKI', name: 'Lekki Phase 1 Showroom', type: 'RETAIL', state: 'Lagos', city: 'Lekki', address: '48 Admiralty Way, Lekki Phase 1', lat: 6.4531, lng: 3.4565 },
    { code: 'ABUJA', name: 'Abuja Wuse Zone 4 Branch', type: 'BOTH', state: 'FCT - Abuja', city: 'Abuja', address: 'Plot 1025 Aminu Kano Crescent, Wuse Zone 4', lat: 9.0765, lng: 7.4986 },
  ],
  'RIDGE-HOME': [
    { code: 'ABJ', name: 'Abuja Showroom & Workshop', type: 'SHOWROOM', state: 'FCT - Abuja', city: 'Abuja', address: 'KM 8 Kubwa Express Way, showrooms 3-7', lat: 9.1120, lng: 7.3910, main: true },
    { code: 'PH', name: 'Port Harcourt Showroom', type: 'SHOWROOM', state: 'Rivers', city: 'Port Harcourt', address: '23 Aba Road, Mile 2', lat: 4.8156, lng: 7.0407 },
  ],
  'RIDGE-TRADE': [
    { code: 'LAG', name: 'Lagos Ojota Warehouse & Cash-and-Carry', type: 'WHOLESALE', state: 'Lagos', city: 'Lagos', address: 'Plot 4 Ojota Industrial Layout', lat: 6.6010, lng: 3.3720, main: true },
    { code: 'KAN', name: 'Kano Sabon Gari Depot', type: 'WHOLESALE', state: 'Kano', city: 'Kano', address: 'Warehouse 9, Sabon Gari Market Road', lat: 12.0022, lng: 8.5324 },
    { code: 'MIN', name: 'Minna Retail Store', type: 'RETAIL', state: 'Niger', city: 'Minna', address: '14 Bosso Road', lat: 9.6139, lng: 6.5569 },
  ],
};

const STAFF_BY_UNIT = {
  'RIDGE-APPL': [
    { username: 'adeola', name: 'Adeola Balogun', role: 'OWNER', branch: null },
    { username: 'chidi', name: 'Chidi Okonkwo', role: 'MANAGER', branch: null },
    { username: 'fatima', name: 'Fatima Bello', role: 'MANAGER', branch: 'IKEJA' },
    { username: 'tunde', name: 'Tunde Ajayi', role: 'STAFF', branch: 'IKEJA' },
    { username: 'ngozi', name: 'Ngozi Eze', role: 'STAFF', branch: 'IKEJA' },
    { username: 'musa', name: 'Musa Ibrahim', role: 'MANAGER', branch: 'LEKKI' },
    { username: 'blessing', name: 'Blessing Adamu', role: 'STAFF', branch: 'LEKKI' },
    { username: 'emeka', name: 'Emeka Nwosu', role: 'MANAGER', branch: 'ABUJA' },
    { username: 'zainab', name: 'Zainab Yusuf', role: 'STAFF', branch: 'ABUJA' },
    { username: 'daniel', name: 'Daniel Ogunleye', role: 'STAFF', branch: 'ABUJA' },
  ],
  'RIDGE-HOME': [
    { username: 'ifeyinwa', name: 'Ifeyinwa Obi', role: 'OWNER', branch: null },
    { username: 'segun', name: 'Segun Adebayo', role: 'MANAGER', branch: 'ABJ' },
    { username: 'halima', name: 'Halima Sani', role: 'STAFF', branch: 'ABJ' },
    { username: 'kingsley', name: 'Kingsley Udo', role: 'MANAGER', branch: 'PH' },
    { username: 'amaka', name: 'Amaka Chukwu', role: 'STAFF', branch: 'PH' },
  ],
  'RIDGE-TRADE': [
    { username: 'bashir', name: 'Bashir Lawal', role: 'OWNER', branch: null },
    { username: 'yetunde', name: 'Yetunde Fashola', role: 'MANAGER', branch: null },
    { username: 'ibrahim', name: 'Ibrahim Sule', role: 'MANAGER', branch: 'LAG' },
    { username: 'grace', name: 'Grace Okoro', role: 'STAFF', branch: 'LAG' },
    { username: 'sani', name: 'Sani Abubakar', role: 'MANAGER', branch: 'KAN' },
    { username: 'binta', name: 'Binta Mohammed', role: 'STAFF', branch: 'KAN' },
    { username: 'joseph', name: 'Joseph Danjuma', role: 'MANAGER', branch: 'MIN' },
  ],
};

const CUSTOMERS_BY_UNIT = {
  'RIDGE-APPL': [
    { name: 'Chinelo Marketing Ltd', type: 'DISTRIBUTOR', tier: 'DISTRIBUTOR', phone: '08033445566', company: 'Chinelo Marketing Ltd', tin: '20184432', credit: 4500000, state: 'Lagos' },
    { name: 'Federal Ministry of Works (Supply)', type: 'GOVERNMENT', tier: 'GOVERNMENT', phone: '08066778899', company: 'Federal Ministry of Works', tin: '10023344', credit: 12000000, state: 'FCT - Abuja' },
    { name: 'Obiora Ventures', type: 'WHOLESALE', tier: 'WHOLESALE', phone: '08055667788', company: 'Obiora Ventures', tin: '20993311', credit: 1800000, state: 'Lagos' },
    { name: 'Aisha Garba', type: 'RETAIL', phone: '08077889900', state: 'FCT - Abuja' },
    { name: 'Kunle Adewale', type: 'RETAIL', phone: '08099001122', state: 'Lagos' },
    { name: 'Ruth Ekong', type: 'CORPORATE', tier: 'CORPORATE', phone: '08022334455', company: 'Ekong & Partners', credit: 950000, state: 'Lagos' },
    { name: 'Sani Bawa', type: 'RETAIL', phone: '08044556677', state: 'Kaduna' },
    { name: 'Bukola Ajibade', type: 'WALK_IN', phone: '08011223344', state: 'Ogun' },
  ],
  'RIDGE-HOME': [
    { name: 'Honeywell Estates Project', type: 'PROJECT', tier: 'PROJECT', phone: '08055443322', company: 'Honeywell Estates Ltd', credit: 24000000, state: 'FCT - Abuja' },
    { name: 'Grace Interiors Ltd', type: 'CORPORATE', tier: 'CORPORATE', phone: '08066554433', company: 'Grace Interiors Ltd', tin: '20774411', credit: 3200000, state: 'Rivers' },
    { name: 'Yusuf Abdullahi', type: 'RETAIL', phone: '08077665544', state: 'FCT - Abuja' },
    { name: 'Nkechi Onwuka', type: 'RETAIL', phone: '08088776655', state: 'Lagos' },
    { name: 'Terna Achineku', type: 'WHOLESALE', tier: 'WHOLESALE', phone: '08099887766', company: 'Terna Furniture Trade', credit: 1500000, state: 'Benue' },
  ],
  'RIDGE-TRADE': [
    { name: 'Mallam Danjuma & Sons', type: 'SUB_DEALER', tier: 'SUB_DEALER', phone: '08033112233', company: 'Danjuma & Sons', tin: '20445566', credit: 2800000, state: 'Kano' },
    { name: 'Mama Nkechi Provision Stores', type: 'WHOLESALE', tier: 'WHOLESALE', phone: '08044223344', company: 'Mama Nkechi Stores', credit: 1200000, state: 'Lagos' },
    { name: 'St. Mary\u2019s School Bursary', type: 'CORPORATE', tier: 'CORPORATE', phone: '08055334455', company: 'St Mary\u2019s Catholic School', tin: '10556677', credit: 780000, state: 'Niger' },
    { name: 'Hauwa Suleiman', type: 'RETAIL', phone: '08066445566', state: 'Kano' },
    { name: 'Femi Alabi', type: 'RETAIL', phone: '08077556677', state: 'Lagos' },
    { name: 'Unity Hotel Purchasing', type: 'CORPORATE', tier: 'CORPORATE', phone: '08088667788', company: 'Unity Hotel Ltd', credit: 640000, state: 'Lagos' },
  ],
};

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(list) { return list[randInt(0, list.length - 1)]; }
function jitter(base, pct) { return round2(base * (1 + (Math.random() * 2 - 1) * pct)); }

function serialFor(index, prefix) {
  // Deterministic-looking but unique: SR + 14 digits, Luhn-free but shaped like
  // a real IMEI so the field lengths and validation paths are exercised.
  const n = String(350000000000000 + index * 7919).slice(0, 14);
  return { serial_no: `${prefix}${n}`, imei: n };
}

async function seed(db, { verbose = true } = {}) {
  const log = (...a) => { if (verbose) console.log(...a); };
  const ts = watNowIso();
  const startedAt = Date.now();

  const units = {
    'RIDGE-APPL': { name: 'Ridgepoint Appliances & Gadgets Ltd', profile: 'ELECTRONICS_APPLIANCES', legal: 'Ridgepoint Appliances & Gadgets Limited', rc: 'RC 1884320', tin: '20184432-0001', state: 'Lagos', address: '12 Otigba Street, Computer Village, Ikeja, Lagos', phone: '+2348033445566', email: 'accounts@ridgepoint.ng', plan: 'Business Plus' },
    'RIDGE-HOME': { name: 'Ridgepoint Home & Living', profile: 'FURNITURE_HOME', legal: 'Ridgepoint Home & Living Ltd', rc: 'BN 4471220', tin: '20774411-0001', state: 'FCT - Abuja', address: 'KM 8 Kubwa Express Way, Abuja', phone: '+2348055443322', email: 'hello@ridgepointhome.ng', plan: 'Standard' },
    'RIDGE-TRADE': { name: 'Ridgepoint Trading Company', profile: 'GENERAL_RETAIL_WHOLESALE', legal: 'Ridgepoint Trading Company Limited', rc: 'RC 0992114', tin: '20445566-0001', state: 'Lagos', address: 'Plot 4 Ojota Industrial Layout, Lagos', phone: '+2348033112233', email: 'trade@ridgepoint.ng', plan: 'Enterprise' },
  };

  const credentials = [];
  const created = { units: [], branches: [], users: [], products: [], customers: [], suppliers: [], sales: [] };

  // Vendor ADMIN seat — one deployment-wide, not part of any client's staff.
  const adminPin = String(randInt(1000, 9999));
  const adminHash = await hashPin(adminPin);
  const adminId = newId();

  for (const [code, meta] of Object.entries(units)) {
    const profile = getProfile(meta.profile);
    const unitId = newId();
    created.units.push({ id: unitId, code, name: meta.name, profile: profile.code });

    await db.prepare(`
      INSERT INTO business_units (
        id, code, name, industry_profile, legal_name, rc_number, tin, address, state, phone, email,
        currency, timezone, max_branches, max_staff, max_products,
        subscription_status, subscription_plan, vat_enabled, vat_rate_percent, vat_registration_no,
        wht_enabled, admin_contact_name, admin_contact_phone, admin_contact_email, notes,
        is_active, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      unitId, code, meta.name, profile.code, meta.legal, meta.rc, meta.tin, meta.address, meta.state,
      meta.phone, meta.email,
      code === 'RIDGE-APPL' ? 8 : 5, code === 'RIDGE-TRADE' ? 60 : 25, code === 'RIDGE-TRADE' ? 20000 : 5000,
      meta.plan, meta.tin, 'StockRidge Support', '+2348000000000', 'support@stockridge.ng',
      `Demonstration dataset for the ${profile.label} profile.`, ts, ts
    ).run();

    await productService.seedProfileCategories(db, { businessUnitId: unitId, profile });
    await expenseService.seedCategories(db, unitId);
    await glService.ensureChart(db, unitId);
    for (const r of SEED_RATES) {
      const exists = await db.prepare('SELECT id FROM wht_rates WHERE code = ? AND is_system = 1').bind(r.code).first();
      if (!exists) {
        await db.prepare(`
          INSERT INTO wht_rates (id, business_unit_id, code, label, category, direction, rate_percent,
            rate_percent_small_company, regulation_ref, effective_from, is_active, is_system, created_at, updated_at)
          VALUES (?, NULL,?,?,?,?,?,?,?, date('2025-01-01'), 1, 1,?,?)
        `).bind(newId(), r.code, r.label, r.category, r.direction, r.rate_percent, r.rate_percent_small_company,
          r.regulation_ref, ts, ts).run();
      }
    }
    for (let i = 0; i < profile.customer_tiers.length; i += 1) {
      const t = profile.customer_tiers[i];
      await db.prepare(`
        INSERT INTO price_tiers (id, business_unit_id, code, label, rank, requires_min_qty, is_default, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?, 1,?,?)
      `).bind(newId(), unitId, t, t.replace(/_/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase()),
        profile.customer_tiers.length - i, t === 'WHOLESALE' ? 5 : (t === 'DISTRIBUTOR' ? 20 : 0),
        i === 0 ? 1 : 0, ts, ts).run();
    }
    if (profile.compliance) {
      await db.prepare(`
        INSERT INTO compliance_schemes (id, business_unit_id, code, label, regulator, applies_to, requires_expiry, renewal_warning_days, description, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?, 'ALL', ?, 90, ?, 1,?,?)
      `).bind(newId(), unitId, profile.compliance.scheme, profile.compliance.certificate_label,
        profile.compliance.regulator, profile.compliance.requires_expiry ? 1 : 0,
        profile.compliance.register_reason, ts, ts).run();
    }

    // ---- ADMIN seat (created once, given access to every unit) ----
    if (code === 'RIDGE-APPL') {
      await db.prepare(`
        INSERT INTO users (id, business_unit_id, branch_id, full_name, username, pin_hash, pin_updated_at, role, job_title,
          phone, email, is_active, must_change_pin, hired_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'StockRidge Platform Administrator', 'admin', ?,?, 'ADMIN', 'Live Sample Administrator',
          '+2348000000000','support@stockridge.ng', 1, 0, date('now','+1 hour'),?,?)
      `).bind(adminId, unitId, adminHash.encoded, ts, ts, ts).run();
      credentials.push({ business: 'ALL', username: 'admin', pin: adminPin, role: 'ADMIN', note: 'Vendor seat — spans all businesses. Use business code RIDGE-APPL to sign in.' });
    } else {
      await db.prepare(`
        INSERT INTO user_business_access (id, user_id, business_unit_id, role, branch_id, granted_by, granted_at, updated_at)
        VALUES (?,?,?,?,NULL,?,?,?)
      `).bind(newId(), adminId, unitId, 'ADMIN', adminId, ts, ts).run();
    }

    // ---- BRANCHES ----
    const branchDefs = BRANCHES_BY_UNIT[code];
    const branchIds = {};
    for (const bd of branchDefs) {
      const bid = newId();
      branchIds[bd.code] = bid;
      await db.prepare(`
        INSERT INTO branches (
          id, business_unit_id, code, name, branch_type, address, state, lga, city, phone, manager_name,
          latitude, longitude, geofence_radius_meters, attendance_mode, is_main, is_active, opening_date, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'GEOLOCATION', ?, 1, date('now','+1 hour','-365 days'),?,?)
      `).bind(bid, unitId, bd.code, bd.name, bd.type, bd.address, bd.state, null, bd.city,
        meta.phone, null, bd.lat, bd.lng, 150, bd.main ? 1 : 0, ts, ts).run();
      created.branches.push({ id: bid, unit: code, branch_code: bd.code, name: bd.name });

      // Each branch gets its own licence/certificate so the expiry-alert view
      // has something real to show.
      if (profile.compliance) {
        const daysToExpiry = bd.main ? 42 : randInt(200, 900);
        await db.prepare(`
          INSERT INTO branch_certificates (
            id, business_unit_id, branch_id, scheme_code, certificate_no, holder_name, issued_at, expiry_date,
            status, recorded_by, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?, ?, 'VALID',?,?,?)
        `).bind(newId(), unitId, bid, profile.compliance.scheme,
          `${profile.compliance.scheme}-${bd.code}-${randInt(100000, 999999)}`, meta.legal,
          addDays(watDate(), -320), addDays(watDate(), daysToExpiry), adminId, ts, ts).run();
      }
      await db.prepare(`
        INSERT INTO branch_shifts (id, business_unit_id, branch_id, name, shift_type, start_time, end_time, grace_minutes, days_of_week, is_active, created_at, updated_at)
        VALUES (?,?,?,?, 'FULL_DAY', ?,?,?, '1,2,3,4,5,6', 1,?,?)
      `).bind(newId(), unitId, bid, `${bd.code} trading hours`, bd.type === 'WHOLESALE' ? '07:30' : '08:30', bd.type === 'WHOLESALE' ? '18:00' : '19:30', 15, ts, ts).run();
    }

    // ---- USERS ----
    const userDefs = STAFF_BY_UNIT[code];
    for (const ud of userDefs) {
      const pin = String(randInt(1000, 9999));
      const h = await hashPin(pin);
      const uid = newId();
      const bid = ud.branch ? branchIds[ud.branch] : null;
      await db.prepare(`
        INSERT INTO users (
          id, business_unit_id, branch_id, full_name, username, pin_hash, pin_updated_at, role, job_title,
          phone, is_active, must_change_pin, hired_at, created_by, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, date('now','+1 hour','-300 days'),?,?,?)
      `).bind(uid, unitId, bid, ud.name, ud.username, h.encoded, ts, ud.role,
        ud.role === 'MANAGER' ? (bid ? 'Branch Manager' : 'General Manager') : (ud.role === 'OWNER' ? 'Business Owner' : 'Sales / Counter Staff'),
        `+23480${randInt(10000000, 99999999)}`, 1, 0, adminId, ts, ts).run();
      await db.prepare(`
        INSERT INTO user_business_access (id, user_id, business_unit_id, role, branch_id, granted_by, granted_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)
      `).bind(newId(), uid, unitId, ud.role, bid, adminId, ts, ts).run();
      created.users.push({ id: uid, unit: code, username: ud.username, name: ud.name, role: ud.role, branch: ud.branch });
      credentials.push({ business: code, username: ud.username, pin, role: ud.role, name: ud.name, branch: ud.branch || 'ALL BRANCHES' });
    }

    // ---- SUPPLIERS ----
    const supplierDefs = code === 'RIDGE-APPL' ? [
      { name: 'Alaba International Electronics Importers', type: 'IMPORTER', state: 'Lagos', terms: 14, tin: '20118833' },
      { name: 'Samsung Electronics Nigeria Ltd', type: 'MANUFACTURER', state: 'Lagos', terms: 30, tin: '10022331' },
      { name: 'Oraimo Accessories Wholesale', type: 'DISTRIBUTOR', state: 'Lagos', terms: 0 },
      { name: 'Thermocool Nigeria Plc', type: 'MANUFACTURER', state: 'Lagos', terms: 21, tin: '10099221' },
    ] : code === 'RIDGE-HOME' ? [
      { name: 'Aba Timber & Frame Works', type: 'WORKSHOP', state: 'Abia', terms: 7 },
      { name: 'Foam & Springs Nigeria Ltd', type: 'MANUFACTURER', state: 'Ogun', terms: 30, tin: '20334455' },
      { name: 'Kano Textile & Upholstery Supply', type: 'WHOLESALE', state: 'Kano', terms: 0 },
      { name: 'Imported Fittings (Guangzhou agent)', type: 'IMPORTER', state: 'Lagos', terms: 45, tin: '20887766' },
    ] : [
      { name: 'Flour Mills of Nigeria Plc', type: 'MANUFACTURER', state: 'Lagos', terms: 21, tin: '10011223' },
      { name: 'Nigerian Breweries Distributor (Ojota)', type: 'DISTRIBUTOR', state: 'Lagos', terms: 7 },
      { name: 'Unilever Nigeria Trade Depot', type: 'DISTRIBUTOR', state: 'Lagos', terms: 14, tin: '10044556' },
      { name: 'Dangote Cement Direct Depot', type: 'MANUFACTURER', state: 'Kogi', terms: 0, tin: '10077889' },
      { name: 'Kano Open Market Wholesalers Assoc.', type: 'WHOLESALE', state: 'Kano', terms: 3 },
    ];
    const supplierIds = [];
    for (const sd of supplierDefs) {
      const sid = newId();
      supplierIds.push(sid);
      await db.prepare(`
        INSERT INTO suppliers (
          id, business_unit_id, name, supplier_type, contact_name, phone, email, address, state, country,
          tin, payment_terms_days, credit_limit, lead_time_days, rating, is_active, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?, 'Nigeria',?,?,?,?,?, 1,?,?)
      `).bind(sid, unitId, sd.name, sd.type, null, `+23480${randInt(10000000, 99999999)}`, null, null,
        sd.state, sd.tin || null, sd.terms, round2(randInt(2, 40) * 100000), randInt(2, 21), randInt(3, 5), ts, ts).run();
    }

    // ---- PRODUCTS + STOCK ----
    const catalogue = code === 'RIDGE-APPL' ? ELECTRONICS : (code === 'RIDGE-HOME' ? FURNITURE : MERCHANDISE);
    const extra = code === 'RIDGE-TRADE' ? BUILDING.slice(0, 6) : [];
    const allItems = [...catalogue, ...extra];
    const productIds = [];
    const catMap = new Map((await db.prepare('SELECT code, id, default_base_unit FROM product_categories WHERE business_unit_id = ?').bind(unitId).all()).results.map((r) => [r.code, r]));
    const tierRows = (await db.prepare('SELECT id, code, rank FROM price_tiers WHERE business_unit_id = ?').bind(unitId).all()).results;
    const wholesaleTier = tierRows.find((t) => t.code === 'WHOLESALE');
    const distributorTier = tierRows.find((t) => t.code === 'DISTRIBUTOR');

    let serialCounter = 1;
    for (let pi = 0; pi < allItems.length; pi += 1) {
      const it = allItems[pi];
      const cat = catMap.get(it.cat) || null;
      const productId = newId();
      productIds.push({ id: productId, name: it.name, cost: it.cost, price: it.price, serials: !!it.serials, uom: it.uom });

      const tracksSerials = it.serials ? 1 : 0;
      const tracksExpiry = it.expiry ? 1 : 0;
      const tracksWarranty = (it.warranty || 0) > 0 ? 1 : 0;
      const attrs = it.attrs || {};
      if (it.madeToOrder) attrs.lead_time_days = it.leadTime || 21;
      if (it.class) attrs.delivery_class = it.class;
      if (it.warranty) attrs.warranty_months = it.warranty;

      const sellingUnits = code === 'RIDGE-HOME'
        ? ['BASE_UNIT']
        : (it.pack && it.carton ? 'BASE_UNIT,PACK,CARTON' : (it.pack ? 'BASE_UNIT,PACK' : 'BASE_UNIT'));

      await db.prepare(`
        INSERT INTO products (
          id, business_unit_id, sku, name, description, category_id, brand, model_number,
          base_unit, units_per_pack, packs_per_carton, cartons_per_pallet, selling_units,
          compliance_scheme, compliance_ref_no, is_regulated,
          tracks_serials, tracks_expiry, tracks_warranty, warranty_months, warranty_terms,
          requires_installation, assembly_required, made_to_order, lead_time_days, delivery_class, is_fragile,
          attributes_json, valuation_method, reorder_level, reorder_quantity,
          default_cost_price, default_selling_price, wholesale_selling_price, tax_code,
          is_active, created_by, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        productId, unitId, `${code.slice(6, 9)}-${String(pi + 1).padStart(4, '0')}`, it.name,
        null, cat ? cat.id : null, attrs.brand || null, null,
        it.uom || (cat ? cat.default_base_unit : 'PIECE'),
        it.pack || 1, it.carton || null, null, sellingUnits,
        profile.compliance ? profile.compliance.scheme : null,
        profile.compliance && it.cat === 'MOBILE_PHONES' ? `${profile.compliance.scheme}-NG-${randInt(100000, 999999)}` : null,
        it.cat === 'MOBILE_PHONES' || it.cat === 'FOODSTUFFS' || it.cat === 'CEMENT_BINDERS' ? 1 : 0,
        tracksSerials, tracksExpiry, tracksWarranty, it.warranty || null,
        tracksWarranty ? profile.warranty_terms_default : null,
        it.install ? 1 : 0, it.assembly ? 1 : 0, it.madeToOrder ? 1 : 0, it.leadTime || 0,
        it.class || null, ['GLASS', 'CERAMIC'].includes(it.cat) ? 1 : 0,
        JSON.stringify(attrs), 'FIFO',
        Math.max(2, Math.round((it.cost / 2000))), Math.max(5, Math.round(it.cost / 800)),
        jitter(it.cost, 0.02), jitter(it.price, 0.03),
        wholesaleTier ? round2(it.price * 0.88) : null,
        ['FOODSTUFFS', 'PROVISIONS'].includes(it.cat) ? 'EXEMPT' : 'STANDARD',
        1, adminId, ts, ts
      ).run();

      // Wholesale/distributor quantity breaks — the most common Nigerian
      // wholesale price expression: "X per unit if you take N or more".
      if (wholesaleTier) {
        await db.prepare(`
          INSERT INTO product_tier_prices (id, business_unit_id, product_id, tier_id, branch_id, price_type, price_value,
            min_quantity, created_at, updated_at)
          VALUES (?,?,?,?,NULL,'PERCENT_OFF_RETAIL',?, 1,?,?)
        `).bind(newId(), unitId, productId, wholesaleTier.id, 12, ts, ts).run();
      }
      if (distributorTier) {
        await db.prepare(`
          INSERT INTO product_tier_prices (id, business_unit_id, product_id, tier_id, branch_id, price_type, price_value,
            min_quantity, created_at, updated_at)
          VALUES (?,?,?,?,NULL,'PERCENT_OFF_RETAIL',?, 1,?,?)
        `).bind(newId(), unitId, productId, distributorTier.id, 19, ts, ts).run();
        await db.prepare(`
          INSERT INTO product_tier_prices (id, business_unit_id, product_id, tier_id, branch_id, price_type, price_value,
            min_quantity, created_at, updated_at)
          VALUES (?,?,?,?,NULL,'PERCENT_OFF_RETAIL',?, 10,?,?)
        `).bind(newId(), unitId, productId, distributorTier.id, 24, ts, ts).run();
      }

      // Barcodes for the pack and carton rungs, plus a primary per-piece code.
      const primaryBarcode = String(6150000000000 + pi * 137 + code.length);
      await db.prepare(`
        INSERT INTO product_barcodes (id, product_id, business_unit_id, barcode, unit_type, label, is_primary, created_at, updated_at)
        VALUES (?,?,?,?, 'BASE_UNIT', ?, 1,?,?)
      `).bind(newId(), productId, unitId, primaryBarcode, `Single ${it.name}`, ts, ts).run();
      if (it.pack) {
        await db.prepare(`
          INSERT INTO product_barcodes (id, product_id, business_unit_id, barcode, unit_type, label, is_primary, created_at, updated_at)
          VALUES (?,?,?,?, 'PACK', ?, 0,?,?)
        `).bind(newId(), productId, unitId, `${primaryBarcode.slice(0, -1)}1`, `Pack of ${it.pack}`, ts, ts).run();
      }
      await db.prepare(`
        INSERT INTO product_suppliers (id, business_unit_id, product_id, supplier_id, supplier_item_code, unit_cost,
          cost_unit, min_order_quantity, lead_time_days, is_preferred, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 1,?,?)
      `).bind(newId(), unitId, productId, pick(supplierIds), `SUP-${randInt(1000, 9999)}`,
        jitter(it.cost, 0.03), 'BASE_UNIT', it.pack ? randInt(1, 5) : randInt(1, 10), randInt(2, 14), ts, ts).run();

      // ---- STOCK across branches ----
      for (const bd of branchDefs) {
        const bid = branchIds[bd.code];
        const batches = randInt(1, it.serials ? 1 : 2);
        for (let bI = 0; bI < batches; bI += 1) {
          const qtyBase = it.serials
            ? randInt(2, 9)
            : randInt(Math.max(4, Math.round(it.cost / 2500)), Math.max(30, Math.round(it.cost / 250)) + 40);
          const unitCost = jitter(it.cost, 0.04);
          const selling = jitter(it.price, 0.05);
          const batchId = newId();
          const receivedDaysAgo = randInt(3, 180);
          const expiryDate = it.expiry ? addDays(watDate(), randInt(-12, 400)) : null;
          await db.prepare(`
            INSERT INTO stock_batches (
              id, business_unit_id, branch_id, product_id, batch_no, supplier_id,
              quantity_received, quantity_remaining, quantity_reserved, unit_cost, total_cost,
              selling_price_per_unit, pack_price, carton_price,
              received_at, received_by, expiry_date, manufacture_date, status, notes, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?, 0,?,?,?,?, ?,?,?, ?, 'ACTIVE', ?,?,?)
          `).bind(batchId, unitId, bid, productId,
            `${bd.code}-${watDate().replace(/-/g, '').slice(2)}-${bI + 1}`, pick(supplierIds),
            qtyBase, Math.max(0, qtyBase - randInt(0, Math.floor(qtyBase * 0.4))), unitCost,
            round2(unitCost * qtyBase), selling,
            it.pack ? round2(selling * it.pack * 0.97) : null,
            (it.pack && it.carton) ? round2(selling * it.pack * it.carton * 0.94) : null,
            `${watDate()} ${String(randInt(8, 17)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:00`,
            adminId, expiryDate, expiryDate ? addDays(expiryDate, -(it.expiry || 0)) : null,
            `Seeded opening batch ${bI + 1}`, ts, ts).run();

          await db.prepare(`
            INSERT INTO stock_movements (
              id, business_unit_id, branch_id, product_id, stock_batch_id, direction, quantity, unit_cost,
              movement_type, source_type, source_id, reference, balance_after, reason, performed_by, occurred_at, created_at
            ) VALUES (?,?,?,?,?, 'IN', ?,?, 'PURCHASE_RECEIPT', 'OPENING_BALANCE', ?,?,?, 'Seeded opening stock',?,?,?)
          `).bind(newId(), unitId, bid, productId, batchId, qtyBase, unitCost, batchId, `OPEN-${bd.code}`,
            qtyBase, adminId, `${watDate()} 09:00:00`, ts).run();

          if (it.serials) {
            for (let s = 0; s < qtyBase; s += 1) {
              const ser = serialFor(serialCounter, code.slice(6, 9));
              serialCounter += 1;
              await db.prepare(`
                INSERT INTO product_serials (
                  id, business_unit_id, product_id, stock_batch_id, branch_id, serial_no, imei, colour,
                  status, cost_price, received_at, received_by, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?, 'IN_STOCK',?,?,?,?,?)
              `).bind(newId(), unitId, productId, batchId, bid, ser.serial_no, ser.imei,
                attrs.colour || null, unitCost, `${watDate()} 09:05:00`, adminId, ts, ts).run();
            }
          }
        }
      }
    }

    // ---- CUSTOMERS ----
    const customerIds = [];
    for (const cd of (CUSTOMERS_BY_UNIT[code] || [])) {
      const cid = newId();
      const tier = cd.tier ? tierRows.find((t) => t.code === cd.tier) : null;
      const phoneDigits = String(cd.phone).replace(/^0/, '');
      customerIds.push({ id: cid, name: cd.name, credit: cd.credit || 0 });
      await db.prepare(`
        INSERT INTO customers (
          id, business_unit_id, home_branch_id, full_name, customer_type, tier_id, phone, phone_national,
          address, state, city, company_name, tin, id_type, id_number, kyc_status, kyc_verified_at, kyc_verified_by,
          credit_enabled, credit_limit, credit_days, total_purchases, purchase_count, last_purchase_at,
          loyalty_points, is_active, created_by, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'VERIFIED',?,?, ?,?,?, ?,?,?, ?, 1,?,?,?)
      `).bind(cid, unitId, branchIds[branchDefs[0].code], cd.name, cd.type, tier ? tier.id : null,
        `+234${phoneDigits}`, cd.phone, null, cd.state || null, null, cd.company || null, cd.tin || null,
        'NIN', `${randInt(10000000000, 99999999999)}`, ts, adminId,
        cd.credit ? 1 : 0, cd.credit || 0, cd.credit ? 30 : 0,
        0, 0, null, 0, adminId, ts, ts).run();
    }

    // ---- VEHICLES ----
    const vehicleIds = [];
    const vehicles = code === 'RIDGE-APPL' ? [['LAG-482-XR', 'VAN', 1200], ['EPE-119-KJ', 'BIKE', 60]]
      : code === 'RIDGE-HOME' ? [['ABJ-903-TQ', 'TRUCK', 4500], ['ABJ-221-LM', 'PICKUP', 1500]]
      : [['LAG-774-ZZ', 'FLATBED', 12000], ['KAN-330-BD', 'TRUCK', 8000], ['LAG-018-HK', 'KEKE', 200]];
    for (const [plate, type, cap] of vehicles) {
      const vid = newId();
      vehicleIds.push(vid);
      await db.prepare(`
        INSERT INTO delivery_vehicles (id, business_unit_id, branch_id, plate_number, vehicle_type, capacity_kg,
          driver_name, driver_phone, is_third_party, cost_per_trip, cost_per_km, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?,?, ?,?, 0,?,?, 1,?,?)
      `).bind(vid, unitId, branchIds[branchDefs[0].code], plate, type, cap,
        pick(['Ibrahim Keke', 'Sunday Okafor', 'Malam Bello', 'Chinedu Driver', 'Aunty Bose']),
        `+23480${randInt(10000000, 99999999)}`, round2(type === 'BIKE' || type === 'KEKE' ? 1500 : 8500),
        type === 'FLATBED' ? 250 : 120, ts, ts).run();
    }

    log(`  · ${code}  ${meta.name}  [${profile.label}]  ${branchDefs.length} branches, ${userDefs.length} staff, ${allItems.length} products`);
  }

  // ---- ONE SALES HISTORY so reports are not empty ----
  await seedTradingHistory(db, created, { adminId });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const credPath = path.join(OUT_DIR, 'seed-credentials.json');
  fs.writeFileSync(credPath, JSON.stringify({
    generated_at: watNowIso(),
    warning: 'DEMONSTRATION DATA ONLY. PINs are randomly generated per seed run and stored hashed in the database. This file is gitignored — never commit it, and never reuse these PINs in production.',
    accounts: credentials,
  }, null, 2));

  log('');
  log(`Seeded in ${elapsed}s — ${created.units.length} businesses, ${created.branches.length} branches, ${created.users.length} staff accounts`);
  log(`Credentials written to data/seed-credentials.json`);
  return { created, credentials, credPath };
}

// ---------------------------------------------------------------------
// TRADING HISTORY
// ---------------------------------------------------------------------
// ~90 days of sales, tills, expenses, plans and deliveries, so every report,
// dashboard and aging bucket has real data behind it. Deliberately run through
// the SAME services the API uses rather than by direct INSERT, because a seed
// that bypasses the business rules produces a dataset the rules would reject —
// which makes the demo lie about what the product does.
async function seedTradingHistory(db, created, { adminId }) {
  const salesService = require('../server/services/salesService');
  const tillService = require('../server/services/tillService');
  const instalmentService = require('../server/services/instalmentService');
  const layawayService = require('../server/services/layawayService');
  const deliveryService = require('../server/services/deliveryService');
  const warrantyService = require('../server/services/warrantyService');
  const expenseService = require('../server/services/expenseService');
  const adjustmentService = require('../server/services/adjustmentService');
  const { getUnitSettings } = require('../server/lib/planLimits');

  let salesMade = 0;
  let tillsOpened = 0;
  let plansMade = 0;
  let holdsMade = 0;
  let jobsMade = 0;
  let claimsMade = 0;

  for (const unit of created.units) {
    const unitId = unit.id;
    const settings = await getUnitSettings(db, unitId);
    const branches = created.branches.filter((b) => b.unit === unit.code);
    const staff = created.users.filter((u) => u.unit === unit.code);
    const customers = (await db.prepare('SELECT * FROM customers WHERE business_unit_id = ? AND is_deleted = 0').bind(unitId).all()).results;
    const products = (await db.prepare('SELECT * FROM products WHERE business_unit_id = ? AND is_deleted = 0 AND is_active = 1').bind(unitId).all()).results;
    const vehicles = (await db.prepare('SELECT id FROM delivery_vehicles WHERE business_unit_id = ?').bind(unitId).all()).results;

    for (const branch of branches) {
      const branchStaff = staff.filter((s) => s.branch === branch.branch_code || !s.branch);
      const cashier = branchStaff.find((s) => s.role === 'STAFF') || branchStaff.find((s) => s.role === 'MANAGER') || staff[0];
      const manager = staff.find((s) => s.role === 'MANAGER' && s.branch === branch.branch_code)
        || staff.find((s) => s.role === 'MANAGER' && !s.branch) || staff.find((s) => s.role === 'OWNER');
      if (!cashier || !manager) continue;

      const cashierRow = await db.prepare('SELECT * FROM users WHERE id = ?').bind(cashier.id).first();
      const managerRow = await db.prepare('SELECT * FROM users WHERE id = ?').bind(manager.id).first();
      const cashierCtx = { user: cashierRow, businessUnitId: unitId, businessUnit: settings, deviceId: `seed-device-${branch.branch_code}`, ipAddress: '127.0.0.1', userAgent: 'StockRidgeSeed/1.0' };
      const managerCtx = { user: managerRow, businessUnitId: unitId, businessUnit: settings, deviceId: `seed-device-${branch.branch_code}`, ipAddress: '127.0.0.1', userAgent: 'StockRidgeSeed/1.0' };

      const branchProducts = (await db.prepare(`
        SELECT DISTINCT sb.product_id FROM stock_batches sb
        WHERE sb.branch_id = ? AND sb.is_deleted = 0 AND sb.quantity_remaining > 0
      `).bind(branch.id).all()).results.map((r) => r.product_id);
      if (!branchProducts.length) continue;

      // 60 trading days of history, one till per day, several sales per day.
      for (let day = 60; day >= 0; day -= 1) {
        const date = addDays(watDate(), -day);
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (weekday === 0) continue;                       // closed Sundays

        let till = null;
        try {
          till = await tillService.openTill(db, cashierCtx, { branchId: branch.id, openingFloat: round2(randInt(15, 60) * 1000) });
          tillsOpened += 1;
        } catch (e) { /* a seeded branch may already have one open */ }

        const salesToday = branch.branch_code === 'LAG' || branch.branch_code === 'IKEJA' ? randInt(4, 9) : randInt(1, 5);
        for (let s = 0; s < salesToday; s += 1) {
          const customer = customers.length && Math.random() < 0.45 ? pick(customers) : null;
          const lineCount = randInt(1, Math.min(4, branchProducts.length));
          const items = [];
          const usedProducts = new Set();
          for (let l = 0; l < lineCount; l += 1) {
            const pid = pick(branchProducts);
            if (usedProducts.has(pid)) continue;
            usedProducts.add(pid);
            const p = products.find((x) => x.id === pid);
            if (!p) continue;
            const pos = await require('../server/services/stockService').position(db, { branchId: branch.id, productId: pid });
            const maxQty = p.tracks_serials ? Math.min(2, Math.floor(pos.available)) : Math.floor(pos.available / 4);
            if (maxQty < 1) continue;
            const qty = Math.max(1, randInt(1, Math.max(1, maxQty)));
            const item = { product_id: pid, quantity: qty, unit_type: 'BASE_UNIT' };
            // Serialised items must name their units.
            if (p.tracks_serials) {
              const serials = (await db.prepare(`
                SELECT id FROM product_serials
                WHERE branch_id = ? AND product_id = ? AND status = 'IN_STOCK' AND is_deleted = 0 LIMIT ?
              `).bind(branch.id, pid, qty).all()).results;
              if (serials.length !== qty) continue;
              item.serial_ids = serials.map((x) => x.id);
            }
            items.push(item);
          }
          if (!items.length) continue;

          const isCredit = customer && customer.credit_enabled && Math.random() < 0.12;
          const totalGuess = round2(randInt(8, 400) * 1000);
          const payments = isCredit
            ? [{ method: 'CREDIT', amount: totalGuess }]
            : (Math.random() < 0.55
              ? [{ method: 'CASH', amount: totalGuess, cash_tendered: totalGuess }]
              : [{ method: 'POS_TERMINAL', amount: totalGuess, reference: `AUTH${randInt(100000, 999999)}` }]);

          try {
            // Quote first to get the real total, then pay exactly that. A seed
            // that guesses the total would produce overpayments the API refuses.
            const quote = await salesService.resolveSaleLine;   // touch to keep parity obvious
            void quote;
            const preview = await previewTotal(db, cashierCtx, { branchId: branch.id, items, customerId: customer ? customer.id : null, settings });
            const paid = preview.total;
            const finalPayments = isCredit
              ? [{ method: 'CREDIT', amount: paid }]
              : (payments[0].method === 'CASH'
                ? [{ method: 'CASH', amount: paid, cash_tendered: round2(paid + (Math.random() < 0.3 ? randInt(1, 5) * 100 : 0)) }]
                : [{ method: 'POS_TERMINAL', amount: paid, reference: `AUTH${randInt(100000, 999999)}` }]);

            const sale = await salesService.createSale(db, cashierCtx, {
              branch_id: branch.id,
              customer_id: customer ? customer.id : null,
              sale_type: isCredit ? 'CREDIT' : (customer && ['WHOLESALE', 'DISTRIBUTOR', 'SUB_DEALER'].includes(customer.customer_type) ? 'WHOLESALE' : 'RETAIL'),
              items,
              payments: finalPayments,
              is_credit_sale: isCredit,
              discount_percent: Math.random() < 0.15 ? randInt(2, 8) : 0,
              discount_reason: Math.random() < 0.15 ? 'Regular customer discount' : null,
              notes: 'Seeded demonstration sale',
            });
            salesMade += 1;

            // Backdate the sale so the history spreads over the period. This is
            // the ONLY place the seed writes a timestamp directly, and it is
            // deliberate: without it 60 days of trading would all be "today".
            await db.prepare("UPDATE sales SET occurred_at = ?, created_at = ? WHERE id = ?")
              .bind(`${date} ${String(randInt(9, 18)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:00`, ts2(), sale.sale_id).run();
            await db.prepare("UPDATE sale_payments SET received_at = ? WHERE sale_id = ?")
              .bind(`${date} ${String(randInt(9, 18)).padStart(2, '0')}:30:00`, sale.sale_id).run();

            // Occasionally: an instalment plan, a layaway hold, a delivery job.
            if (!isCredit && customer && Math.random() < 0.06 && settings.instalment_module_enabled) {
              try {
                const plan = await instalmentService.createPlan(db, managerCtx, {
                  branch_id: branch.id, customer_id: customer.id, plan_type: 'WORK_AND_PAY',
                  items: items.slice(0, 1).map((i) => ({ product_id: i.product_id, quantity: 1 })),
                  deposit_percent: 20, interest_percent: Math.random() < 0.5 ? 10 : 0, interest_type: 'FLAT',
                  instalment_count: randInt(3, 9), frequency: pick(['MONTHLY', 'WEEKLY']),
                  first_due_date: addDays(watDate(), 14), possession: 'POSSESSION_WITH_TITLE_HELD',
                  guarantor_name: pick(['Mallam Sani Bello', 'Mrs. Folake Adeyemi', 'Chief Emeka Obi', 'Alhaji Umar Danjuma']),
                  guarantor_phone: `+23480${randInt(10000000, 99999999)}`,
                  guarantor_address: '14 Ring Road, Lagos', guarantor_id_type: 'NIN',
                  guarantor_id_no: String(randInt(10000000000, 99999999999)),
                  collateral_description: 'Employer guarantee letter on file',
                  contract_note: 'Seeded demonstration plan', signed_at: ts2(),
                });
                await instalmentService.activate(db, managerCtx, { planId: plan.id, depositPayment: { method: 'CASH' } });
                await db.prepare('UPDATE payment_plans SET created_at = ?, first_due_date = ? WHERE id = ?')
                  .bind(`${date} 14:00:00`, addDays(date, 14), plan.id).run();
                // Pay some instalments, leave some overdue so the collections
                // queue and the aging buckets both have content.
                const items2 = (await db.prepare('SELECT * FROM payment_plan_items WHERE payment_plan_id = ? AND seq > 0 ORDER BY seq').bind(plan.id).all()).results;
                const toPay = Math.max(0, Math.min(items2.length - randInt(0, 2), items2.length));
                for (let k = 0; k < toPay; k += 1) {
                  await instalmentService.recordPayment(db, cashierCtx, {
                    planId: plan.id, amount: Number(items2[k].amount_due), method: 'CASH',
                    reference: `SEED-${randInt(1000, 9999)}`, note: 'Seeded instalment payment',
                  });
                }
                plansMade += 1;
              } catch (e) { /* a plan that cannot be seeded is not worth failing the run over */ }
            }

            if (Math.random() < 0.03 && settings.layaway_module_enabled && customer) {
              try {
                const hold = await layawayService.create(db, cashierCtx, {
                  branch_id: branch.id, customer_id: customer.id,
                  items: items.slice(0, 1).map((i) => ({ product_id: i.product_id, quantity: 1 })),
                  deposit_percent: 25, hold_days: randInt(45, 120), forfeiture_percent: 25,
                  notes: 'Seeded demonstration hold',
                });
                await db.prepare('UPDATE layaway_holds SET created_at = ? WHERE id = ?').bind(`${date} 12:00:00`, hold.id).run();
                holdsMade += 1;
              } catch (e) { /* noop */ }
            }

            if (Math.random() < 0.07 && settings.delivery_module_enabled && customer) {
              try {
                const job = await deliveryService.create(db, cashierCtx, {
                  branch_id: branch.id, sale_id: sale.sale_id, customer_id: customer.id,
                  job_type: pick(['DELIVERY', 'DELIVERY_AND_INSTALLATION', 'INSTALLATION']),
                  address: pick(['14 Adeola Odeku Street, Victoria Island', 'Plot 22 Kubwa Express Way', '7 Sabon Gari Market Road', '3 Bosso Road, Minna', '19 Aba Road, Mile 2 PH']),
                  city: pick(['Lagos', 'Abuja', 'Kano', 'Minna', 'Port Harcourt']),
                  state: pick(['Lagos', 'FCT - Abuja', 'Kano', 'Niger', 'Rivers']),
                  contact_name: customer.full_name, contact_phone: customer.phone_national || customer.phone,
                  scheduled_date: addDays(date, randInt(1, 4)),
                  scheduled_window: pick(['MORNING', 'AFTERNOON', 'ANY']),
                  priority: pick(['NORMAL', 'NORMAL', 'HIGH', 'URGENT']),
                  vehicle_id: vehicles.length ? pick(vehicles).id : null,
                  notes: 'Seeded demonstration delivery',
                });
                // Complete most of them with a POD, leave a few open and a few
                // failed so the exception list has content.
                const r = Math.random();
                if (r < 0.6) {
                  await deliveryService.transition(db, cashierCtx, { jobId: job.id, toStatus: 'ASSIGNED' });
                  await deliveryService.transition(db, cashierCtx, { jobId: job.id, toStatus: 'LOADING' });
                  await deliveryService.transition(db, cashierCtx, { jobId: job.id, toStatus: 'IN_TRANSIT' });
                  await deliveryService.transition(db, cashierCtx, { jobId: job.id, toStatus: 'ARRIVED' });
                  await deliveryService.transition(db, cashierCtx, {
                    jobId: job.id, toStatus: 'COMPLETED',
                    pod: { received_by_name: customer.full_name, signature_data_url: 'data:image/png;base64,SEEDPOD' },
                    customerRating: randInt(3, 5),
                  });
                } else if (r < 0.75) {
                  await deliveryService.transition(db, cashierCtx, { jobId: job.id, toStatus: 'ASSIGNED' });
                  await deliveryService.transition(db, cashierCtx, { jobId: job.id, toStatus: 'FAILED', note: 'Customer not reachable at the address; two calls unanswered.' });
                }
                await db.prepare('UPDATE delivery_jobs SET created_at = ?, scheduled_date = ? WHERE id = ?')
                  .bind(`${date} 16:00:00`, addDays(date, randInt(-2, 5)), job.id).run();
                jobsMade += 1;
              } catch (e) { /* noop */ }
            }

            // Warranty cover for serialised sales, and the occasional claim.
            if (settings.warranty_module_enabled) {
              const warr = (await db.prepare('SELECT * FROM product_warranties WHERE sale_id = ? AND is_deleted = 0').bind(sale.sale_id).all()).results;
              for (const w of warr) {
                await db.prepare('UPDATE product_warranties SET starts_at = ?, ends_at = ?, created_at = ? WHERE id = ?')
                  .bind(date, addDays(date, Number(w.months) * 30), `${date} 11:00:00`, w.id).run();
                if (Math.random() < 0.05) {
                  try {
                    const claim = await warrantyService.logClaim(db, cashierCtx, {
                      warranty_id: w.id, fault_type: pick(['MANUFACTURING', 'POWER_SURGE', 'WATER_DAMAGE', 'MISUSE', 'SOFTWARE']),
                      fault_description: pick([
                        'Unit will not power on after a lightning surge; customer reports the socket was protected.',
                        'Compressor runs but does not cool. Installed six weeks ago.',
                        'Screen has a dead pixel band across the lower third, present since unboxing.',
                        'Customer reports water ingress after a roof leak.',
                        'Software will not complete the initial activation.',
                      ]),
                      notes: 'Seeded demonstration claim',
                    });
                    await db.prepare('UPDATE warranty_claims SET logged_at = ? WHERE id = ?').bind(`${date} 15:00:00`, claim.id).run();
                    if (Math.random() < 0.6) {
                      await warrantyService.assessClaim(db, managerCtx, {
                        claimId: claim.id,
                        status: pick(['APPROVED', 'REJECTED', 'WITH_PROVIDER', 'REPAIRING']),
                        outcome: pick(['REPAIR', 'REPLACE', 'REJECT']),
                        assessmentNote: 'Bench-tested at the branch. Fault confirmed as a manufacturing defect within cover; approved for repair under the manufacturer warranty.',
                        repairCost: round2(randInt(4, 90) * 1000),
                        recoveredFromProvider: round2(randInt(0, 40) * 1000),
                      });
                    }
                    claimsMade += 1;
                  } catch (e) { /* noop */ }
                }
              }
            }
          } catch (e) {
            // A seeded sale that fails is usually "insufficient stock" once the
            // day's earlier sales have taken it. That is correct behaviour and
            // not worth failing the run over.
            if (!['INSUFFICIENT_STOCK', 'SERIAL_NOT_SELLABLE', 'SERIAL_TRANSITION_NOT_ALLOWED', 'NO_OPEN_TILL'].includes(e.code)) {
              if (process.env.SEED_STRICT === '1') throw e;
            }
          }
        }

        // Close the till with a count, sometimes short, sometimes over.
        if (till) {
          try {
            const live = await db.prepare('SELECT expected_cash, opening_float FROM till_sessions WHERE id = ?').bind(till.id).first();
            const expected = round2(Number(live.opening_float) + Number(live.expected_cash));
            const roll = Math.random();
            const counted = roll < 0.7 ? expected : (roll < 0.85 ? round2(expected - randInt(80, 3500)) : round2(expected + randInt(50, 1200)));
            await tillService.closeTill(db, managerCtx, {
              tillSessionId: till.id, countedCash: counted,
              varianceReason: counted === expected ? null : 'Recounted twice; difference is small-notes rounding across the day. Manager acknowledged.',
              bankedAmount: Math.max(0, round2(counted - Number(live.opening_float))),
              notes: 'Seeded till close',
            });
            await db.prepare("UPDATE till_sessions SET opened_at = ?, closed_at = ? WHERE id = ?")
              .bind(`${date} 08:00:00`, `${date} 19:30:00`, till.id).run();
          } catch (e) { /* noop */ }
        }

        // Expenses: rent monthly, fuel daily-ish, others weekly.
        const expenseRoll = Math.random();
        if (day % 30 === 0) {
          await seedExpense(db, managerCtx, { unitId, branchId: branch.id, date, settings, category: 'RENT_RATES', description: `Shop rent — ${branch.name} (${monthName(date)})`, amount: round2(randInt(180, 900) * 1000), method: 'BANK_TRANSFER', reference: `RENT-${date.replace(/-/g, '')}` });
        }
        if (expenseRoll < 0.35) {
          await seedExpense(db, cashierCtx, { unitId, branchId: branch.id, date, settings, category: 'POWER_FUEL', description: 'Generator diesel — 25 litres', amount: round2(randInt(12, 26) * 1000), method: 'CASH' });
        } else if (expenseRoll < 0.45) {
          await seedExpense(db, cashierCtx, { unitId, branchId: branch.id, date, settings, category: 'TRANSPORT', description: 'Delivery bike fuel and rider allowance', amount: round2(randInt(3, 12) * 1000), method: 'CASH' });
        } else if (expenseRoll < 0.5) {
          await seedExpense(db, cashierCtx, { unitId, branchId: branch.id, date, settings, category: 'SUPPLIES', description: 'Receipt rolls, packing tape and cleaning materials', amount: round2(randInt(4, 18) * 1000), method: 'SAFE' });
        }
        // One adjustment every few days, so the shrinkage report has content.
        if (day % 7 === 0 && branchProducts.length) {
          try {
            const pid = pick(branchProducts);
            const p = products.find((x) => x.id === pid);
            await adjustmentService.create(db, managerCtx, {
              branch_id: branch.id, product_id: pid,
              adjustment_type: pick(['DAMAGE', 'LOSS', 'EXPIRED', 'DAMAGE']),
              quantity: -(p && p.tracks_serials ? 1 : randInt(1, 3)),
              reason: pick([
                'Damaged during offloading; outer carton crushed and the unit will not power on.',
                'Counted short during the weekly spot check; no delivery or sale accounts for it.',
                'Passed its expiry date and removed from the shelf.',
                'Screen cracked while being moved between the showroom floor and the store.',
              ]),
              reference: `SEED-ADJ-${date.replace(/-/g, '')}`,
            });
            await db.prepare("UPDATE stock_adjustments SET posted_at = ?, created_at = ? WHERE reference = ?")
              .bind(`${date} 17:00:00`, `${date} 17:00:00`, `SEED-ADJ-${date.replace(/-/g, '')}`).run();
          } catch (e) { /* noop */ }
        }
      }
    }
  }

  console.log(`  · trading history: ${salesMade} sales, ${tillsOpened} till sessions, ${plansMade} instalment plans, ${holdsMade} layaway holds, ${jobsMade} delivery jobs, ${claimsMade} warranty claims`);
}

function ts2() { return watNowIso(); }
function monthName(date) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return months[Number(String(date).slice(5, 7)) - 1] || '';
}

// Total a basket the same way the POS would, so the seed pays exactly the right
// amount rather than guessing and tripping the overpayment guard.
async function previewTotal(db, ctx, { branchId, items, customerId, settings }) {
  const salesService = require('../server/services/salesService');
  const vatLib = require('../server/lib/vat');
  let subtotal = 0;
  for (const raw of items) {
    const resolved = await salesService.resolveSaleLine(db, ctx, {
      businessUnitId: ctx.businessUnitId, branchId, line: { ...raw }, index: 0,
      customer: null, customerId, tier: null, tierId: null,
      saleType: 'RETAIL', allowance: await require('../server/lib/planLimits').staffAllowance(db, ctx.businessUnitId, ctx.user),
      settings, caps: require('../server/lib/capabilities').capabilitiesOf(settings), promotionCode: null,
    });
    subtotal = round2(subtotal + resolved.line_subtotal_after_line_discount);
  }
  const vatEnabled = vatLib.isVatEnabled(settings);
  const vatAmount = vatEnabled ? vatLib.extractVat(subtotal, settings.vat_rate_percent).vat : 0;
  return { subtotal, vat_amount: vatAmount, total: vatEnabled && !vatLib.isVatInclusive(settings) ? round2(subtotal + vatAmount) : subtotal };
}

async function seedExpense(db, ctx, { unitId, branchId, date, settings, category, description, amount, method, reference }) {
  try {
    const expenseService = require('../server/services/expenseService');
    const cat = await db.prepare('SELECT id FROM expense_categories WHERE business_unit_id = ? AND code = ?').bind(unitId, category).first();
    const result = await expenseService.create(db, ctx, {
      branch_id: branchId, category_id: cat ? cat.id : null, expense_date: date,
      description, amount, payment_method: method === 'SAFE' ? 'SAFE' : method,
      paid_from_safe: method === 'SAFE' ? 1 : 0,
      reference: reference || `SEED-${date.replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`,
      notes: 'Seeded demonstration expense',
    });
    await db.prepare('UPDATE expenses SET created_at = ? WHERE id = ?').bind(`${date} 13:00:00`, result.id).run();
  } catch (e) {
    // A safe-funded expense fails if the safe has no balance yet, which is
    // correct behaviour and not worth failing the seed over.
    if (process.env.SEED_STRICT === '1' && e.code !== 'SAFE_INSUFFICIENT_BALANCE' && e.code !== 'SAFE_OVER_STAFF_LIMIT') throw e;
  }
}

if (require.main === module) {
  (async () => {
    const { db: getDb } = require('../server/lib/db');
    const { runMigrations } = require('./migrate');
    const { seed } = require('../server/db/seed');
    const database = await getDb();
    await runMigrations(database, { quiet: true });
    const existing = await database.prepare('SELECT COUNT(*) AS n FROM businesses WHERE is_deleted = 0').first();
    if (existing && existing.n > 0 && !process.argv.includes('--force')) {
      console.log('[seed] The database already has businesses. Use --force to seed anyway, or run `npm run db:reset` first.');
      return;
    }
    console.log('[seed] building demonstration dataset…');
    await seed({ db: database, options: {}, log: console.log });
  })().catch((e) => { console.error('[seed] failed:', e); process.exit(1); });
}

module.exports = { seed, ELECTRONICS, FURNITURE, MERCHANDISE, BUILDING };
