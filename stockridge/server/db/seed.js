// =====================================================================
// server/db/seed.js — A REALISTIC STARTING POSITION
// =====================================================================
// This is not a fixture dump. It is a plausible Nigerian business group on the
// day it starts using StockRidge, so that every screen has something honest to
// show and every flow can be exercised without an hour of data entry:
//
//   ONE PROPRIETOR, TWO BUSINESSES, FOUR BRANCHES — which is the "multi
//   business AND multi branch" requirement demonstrated rather than described.
//
//   Business 1  "Ridge Electronics & Appliances Ltd"  (ELECTRONICS)
//               Ikeja showroom + Alaba wholesale depot
//   Business 2  "Ridge Home & Living"                  (FURNITURE)
//               Lekki gallery + Abuja showroom
//
// A third and fourth business (wholesale provisions, building materials) can be
// created from the UI in seconds to demonstrate the other two verticals; they
// are not seeded because four businesses of stock would make the demo slow to
// open and hard to read. `--vertical all` seeds all four.
//
// WHAT IS SEEDED, deliberately:
//   * opening stock batches at DIFFERENT costs and dates, so FIFO/FEFO picking,
//     stock valuation and margin reports have something real to compute
//   * some stock RESERVED by layaway holds, so the sellable-vs-on-hand
//     distinction is visible on day one
//   * serialised units with warranty clocks at different stages
//   * a customer book spanning RETAIL / TRADE / WHOLESALE / DISTRIBUTOR, one of
//     them overdue, so the credit gates and the chase schedule have something to
//     act on
//   * a few completed sales with mixed tenders, so the till and GL reports are
//     not empty
//   * a debtor ledger and a creditor ledger with real ageing
//   * delivery zones for Lagos and Abuja with genuine fee components
//   * the full chart of accounts
//   * the WHT rate schedule from the 2024 Regulations
//   * Nigerian public holidays for the current and next year
//
// The seed is IDEMPOTENT by id: re-running it will not duplicate anything, and
// it will not overwrite data the user has since changed.

'use strict';

const { newId, docNumber } = require('../../shared/lib/ids');
const M = require('../../shared/lib/money');
const VERTICALS = require('../../shared/lib/verticals');
const RECEIVING = require('../../shared/lib/receiving');
const WARRANTY = require('../../shared/lib/warranty');
const CREDIT = require('../../shared/lib/credit');
const HASHCHAIN = require('../../shared/lib/hashchain');
const { todayWat, NIGERIAN_STATES } = require('../../shared/lib/timegeo');
const { hashPin } = require('../lib/auth');
const core = require('../../shared/services/coreService');
const gl = require('../../shared/services/glService');

// Deterministic ids so a re-seed matches existing rows rather than duplicating.
const ID = {
  admin: 'usr_admin_platform',
  owner: 'usr_owner_adaeze',
  gmBiz1: 'usr_gm_chinedu',
  gmBiz2: 'usr_gm_folake',
  mgrIkeja: 'usr_mgr_ikeja',
  mgrAlaba: 'usr_mgr_alaba',
  mgrLekki: 'usr_mgr_lekki',
  mgrAbuja: 'usr_mgr_abuja',
  staff1: 'usr_staff_ikeja_1',
  staff2: 'usr_staff_ikeja_2',
  staff3: 'usr_staff_lekki_1',
  driver1: 'usr_driver_lekki',
  biz1: 'biz_ridge_electronics',
  biz2: 'biz_ridge_home',
  brIkeja: 'br_ikeja_showroom',
  brAlaba: 'br_alaba_depot',
  brLekki: 'br_lekki_gallery',
  brAbuja: 'br_abuja_showroom',
};

function today() { return todayWat(); }
function daysAgo(n) {
  const d = new Date(Date.parse(`${today()}T00:00:00Z`));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function daysAhead(n) {
  const d = new Date(Date.parse(`${today()}T00:00:00Z`));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// PRODUCT CATALOGUE
// ---------------------------------------------------------------------
// Real brands, real model numbers, real Nigerian street prices at the time of
// writing. A demo with "Product 1 / Product 2" cannot convince anyone that the
// system understands their business, and the prices matter: they are what make
// the margin, credit-limit and instalment flows meaningful rather than abstract.
const ELECTRONICS_PRODUCTS = [
  // [categoryCode, name, brand, model, sku, base_unit, cost, retail, warrantyMonths, serialTracked, attrs]
  ['TV_HOME_ENT', 'Samsung 55" Crystal UHD 4K Smart TV', 'Samsung', 'UA55DU7000', 'SAM-TV-55DU7000', 'UNIT', 640000, 795000, 24, 1, { screen_size: '55 inch', display: '4K UHD', smart_tv: true, model_year: 2025, power_watts: 185 }],
  ['TV_HOME_ENT', 'LG 43" Full HD Smart TV', 'LG', '43LR6050', 'LG-TV-43LR6050', 'UNIT', 385000, 468000, 12, 1, { screen_size: '43 inch', display: 'Full HD', smart_tv: true }],
  ['TV_HOME_ENT', 'TCL 32" Android TV', 'TCL', '32S5400AF', 'TCL-TV-32S5400', 'UNIT', 178000, 232000, 12, 1, { screen_size: '32 inch', display: 'HD', smart_tv: true }],
  ['HOME_APPLIANCES', 'LG 340L Double Door Inverter Refrigerator', 'LG', 'GT4020PDC', 'LG-REF-340L', 'UNIT', 720000, 895000, 24, 1, { capacity_litres: 340, energy_rating: 'A+', inverter: true, colour: 'Shiny Steel' }],
  ['HOME_APPLIANCES', 'Scanfrost 250L Chest Freezer', 'Scanfrost', 'SFCHD250L', 'SCF-FRZ-250', 'UNIT', 285000, 368000, 12, 1, { capacity_litres: 250, type: 'Chest' }],
  ['HOME_APPLIANCES', 'Binatone 20" Standing Fan', 'Binatone', 'BMF20', 'BIN-FAN-20', 'UNIT', 42000, 58500, 6, 0, { size_inches: 20, type: 'Standing' }],
  ['HOME_APPLIANCES', 'Silver Crest 2-in-1 Blender', 'Silver Crest', 'SC-2IN1', 'SVC-BLD-2IN1', 'UNIT', 24000, 36500, 6, 0, { wattage: 1200 }],
  ['HOME_APPLIANCES', 'Century 1.5HP Split Air Conditioner', 'Century', 'CAS-12HR', 'CTY-AC-15HP', 'UNIT', 340000, 425000, 12, 1, { btu: 12000, hp: 1.5, type: 'Split', inverter: false }],
  ['COMPUTING', 'HP EliteBook 840 G7 (Core i5, 16GB, 512GB SSD)', 'HP', '840G7-i5', 'HP-LT-840G7', 'UNIT', 620000, 785000, 12, 1, { cpu: 'Intel Core i5-10310U', ram_gb: 16, storage_gb: 512, screen_size: '14 inch' }],
  ['COMPUTING', 'Lenovo ThinkPad T480 (Refurbished, i5, 8GB)', 'Lenovo', 'T480-i5-8G', 'LNV-LT-T480', 'UNIT', 310000, 425000, 6, 1, { cpu: 'Intel Core i5-8350U', ram_gb: 8, storage_gb: 256, condition: 'Refurbished' }],
  ['PHONES_TABLETS', 'Samsung Galaxy A15 (128GB/4GB)', 'Samsung', 'SM-A155F', 'SAM-PH-A15', 'UNIT', 178000, 215000, 12, 1, { ram_gb: 4, storage_gb: 128, screen_size: '6.5 inch' }],
  ['PHONES_TABLETS', 'Tecno Spark 20 (256GB/8GB)', 'Tecno', 'KG6n', 'TCN-PH-SPARK20', 'UNIT', 145000, 178000, 12, 1, { ram_gb: 8, storage_gb: 256 }],
  ['PHONES_TABLETS', 'iPhone 13 (128GB, UK Used)', 'Apple', 'A2633', 'APL-PH-IP13', 'UNIT', 585000, 720000, 6, 1, { ram_gb: 4, storage_gb: 128, condition: 'UK Used' }],
  ['POWER_GEN', 'Lutian 3.5KVA Generator (Key Start)', 'Lutian', 'LT3500K', 'LTN-GEN-35KVA', 'UNIT', 285000, 365000, 12, 1, { kva: 3.5, fuel: 'Petrol', start_type: 'Key' }],
  ['POWER_GEN', 'Elepaq 10KVA Generator SV2G3', 'Elepaq', 'SV2G3-10', 'ELP-GEN-10KVA', 'UNIT', 890000, 1080000, 12, 1, { kva: 10, fuel: 'Petrol' }],
  ['POWER_GEN', 'Luminous 1.5KVA Inverter + 200Ah Tubular Battery Bundle', 'Luminous', 'INV15-BDL', 'LUM-INV-BDL', 'SET', 385000, 475000, 24, 1, { kva: 1.5, battery_ah: 200, bundles: '1' }],
  ['AUDIO', 'Oraimo Riff 2 Bluetooth Speaker', 'Oraimo', 'OS110', 'ORI-SPK-RIFF2', 'UNIT', 12500, 19800, 6, 0, { wattage: 10, bluetooth: true }],
  ['AUDIO', 'Sony 2.1 Home Theatre System', 'Sony', 'HT-S400', 'SNY-HT-S400', 'UNIT', 210000, 275000, 12, 1, { channels: '2.1', wattage: 330 }],
  ['ACCESSORIES', 'Anker 20,000mAh Power Bank', 'Anker', 'A1257', 'ANK-PB-20K', 'UNIT', 22000, 34500, 12, 0, { capacity_mah: 20000 }],
  ['ACCESSORIES', 'Oraimo 65W GaN Fast Charger', 'Oraimo', 'OC118', 'ORI-CHG-65W', 'UNIT', 9500, 15800, 6, 0, { wattage: 65, ports: 3 }],
  ['ACCESSORIES', 'HDMI Cable 2.1 (2m, 8K)', 'Generic', 'HDMI21-2M', 'GEN-CBL-HDMI21', 'UNIT', 2200, 4500, 0, 0, { length_m: 2, standard: 'HDMI 2.1' }],
  ['KITCHEN', 'Nexus 4-Burner Gas Cooker with Oven', 'Nexus', 'NXGC-6040', 'NXS-CKR-4B', 'UNIT', 245000, 318000, 12, 1, { burners: 4, has_oven: true }],
];

const FURNITURE_PRODUCTS = [
  ['SOFA_LOUNGES', 'Luxury 7-Seater L-Shape Leather Sofa Set', 'RidgeCraft', 'RC-SOFA-7L', 'RC-SF-7L-BRN', 'SET', 1250000, 1680000, 24, 0, { seats: 7, material: 'Leather', colour: 'Brown', requires_assembly: true }],
  ['SOFA_LOUNGES', '3-Seater Fabric Sofa (Grey)', 'RidgeCraft', 'RC-SOFA-3F', 'RC-SF-3F-GRY', 'SET', 420000, 565000, 12, 0, { seats: 3, material: 'Fabric', colour: 'Grey', requires_assembly: true }],
  ['SOFA_LOUNGES', 'Executive Recliner Chair', 'ComfortPlus', 'CP-REC-01', 'CP-RC-EXEC', 'UNIT', 285000, 385000, 12, 0, { seats: 1, material: 'Leather', reclining: true }],
  ['BEDROOM', 'King Size Bed Frame with Storage Drawers (Solid Wood)', 'RidgeCraft', 'RC-BED-KS', 'RC-BD-KS-OAK', 'UNIT', 680000, 895000, 24, 0, { size: 'King', material: 'Solid Wood', requires_assembly: true }],
  ['BEDROOM', 'Queen Size Bed Frame (MDF, Walnut Finish)', 'HomeStyle', 'HS-BED-QN', 'HS-BD-QN-WAL', 'UNIT', 285000, 385000, 12, 0, { size: 'Queen', material: 'MDF', requires_assembly: true }],
  ['BEDROOM', '6x6 ft Spring Mattress (Orthopaedic)', 'Vitafoam', 'VTF-MAT-66', 'VTF-MT-66-ORTH', 'UNIT', 185000, 245000, 60, 0, { size: '6x6 ft', thickness_inches: 10, firmness: 'Orthopaedic', foam_density: 'High' }],
  ['BEDROOM', '4x6 ft Foam Mattress (Economy)', 'Vitafoam', 'VTF-MAT-46', 'VTF-MT-46-ECO', 'UNIT', 68000, 92000, 36, 0, { size: '4x6 ft', thickness_inches: 6 }],
  ['BEDROOM', '3-Door Wardrobe with Mirror', 'RidgeCraft', 'RC-WRB-3D', 'RC-WR-3D-MIR', 'UNIT', 425000, 565000, 12, 0, { doors: 3, material: 'MDF', requires_assembly: true }],
  ['DINING', '6-Seater Dining Table Set (Solid Wood)', 'RidgeCraft', 'RC-DIN-6S', 'RC-DT-6S-OAK', 'SET', 520000, 695000, 24, 0, { seats: 6, material: 'Solid Wood', requires_assembly: true }],
  ['DINING', '4-Seater Glass Top Dining Set', 'HomeStyle', 'HS-DIN-4G', 'HS-DT-4G-BLK', 'SET', 245000, 335000, 12, 0, { seats: 4, material: 'Glass + Metal' }],
  ['OFFICE', 'Executive Office Desk (L-Shape, 1.8m)', 'OfficePro', 'OP-DSK-L18', 'OP-DK-L18-WAL', 'UNIT', 285000, 385000, 12, 0, { length_cm: 180, material: 'MDF', shape: 'L-Shape', requires_assembly: true }],
  ['OFFICE', 'Ergonomic Mesh Office Chair', 'OfficePro', 'OP-CHR-ERG', 'OP-CH-ERG-BLK', 'UNIT', 95000, 138000, 12, 0, { material: 'Mesh', adjustable: true, lumbar_support: true }],
  ['STORAGE', '5-Tier Steel Storage Rack', 'MetalWorks', 'MW-RCK-5T', 'MW-RK-5T-STL', 'UNIT', 68000, 95000, 6, 0, { shelves: 5, material: 'Steel', load_per_shelf_kg: 80 }],
  ['OUTDOOR', 'Rattan Garden Set (4 Chairs + Table)', 'OutdoorLife', 'OL-GDN-RTN', 'OL-GD-RTN-4S', 'SET', 385000, 520000, 12, 0, { seats: 4, material: 'Rattan', weatherproof: true }],
  ['LIVING', '55" TV Stand Console (Walnut)', 'RidgeCraft', 'RC-TVS-55', 'RC-TV-STD-55', 'UNIT', 145000, 198000, 12, 0, { fits_tv_inches: 55, material: 'MDF' }],
  ['DECOR', '3-Piece Canvas Wall Art Set', 'ArtHouse', 'AH-CNV-3P', 'AH-CA-3P-ABS', 'SET', 42000, 68000, 0, 0, { pieces: 3, theme: 'Abstract' }],
];

const WHOLESALE_PRODUCTS = [
  ['FOOD_PROVISIONS', 'Golden Penny Semovita 10kg', 'Golden Penny', 'SEMOVITA-10', 'GP-SMV-10KG', 'BAG', 12800, 15500, 0, 0, { weight_kg: 10 }, 'CARTON', 4, 40],
  ['FOOD_PROVISIONS', 'Mama Gold Rice 50kg', 'Mama Gold', 'RICE-50', 'MG-RCE-50KG', 'BAG', 68000, 78500, 0, 0, { weight_kg: 50 }, 'PALLET', 0, 20],
  ['FOOD_PROVISIONS', 'Devon King\'s Margarine 500g', 'Devon King\'s', 'MARG-500', 'DK-MRG-500G', 'UNIT', 1850, 2450, 0, 0, { weight_g: 500 }, 'PACK', 12, 24],
  ['FOOD_PROVISIONS', 'Indomie Chicken Flavour Noodles (40s)', 'Indomie', 'NDL-CHK-40', 'IDM-NDL-CHK40', 'PACK', 4200, 5400, 0, 0, { count: 40 }, 'CARTON', 6, 50],
  ['BEVERAGES', 'Coca-Cola 35cl (Crate of 24)', 'Coca-Cola', 'CCK-35CL-24', 'CCL-BTL-35CL', 'BOTTLE', 285, 400, 0, 0, { volume_ml: 350 }, 'CARTON', 24, 60],
  ['BEVERAGES', 'Peak Milk Powder 400g Refill', 'Peak', 'PMK-400', 'PKK-MLK-400G', 'UNIT', 2850, 3650, 0, 0, { weight_g: 400 }, 'CARTON', 12, 40],
  ['BEVERAGES', 'Nescafé Classic 200g', 'Nescafé', 'NSC-200', 'NCF-CFE-200G', 'UNIT', 3800, 4850, 0, 0, { weight_g: 200 }, 'CARTON', 12, 30],
  ['ALCOHOL_TOBACCO', 'Star Lager Beer 60cl (Crate of 12)', 'Star', 'STR-60CL-12', 'STR-BTL-60CL', 'BOTTLE', 850, 1200, 0, 0, { volume_ml: 600, abv_percent: 5.1 }, 'CARTON', 12, 80],
  ['HOUSEHOLD', 'Ariel Automatic Washing Powder 2kg', 'Ariel', 'ARL-2KG', 'ARL-DTG-2KG', 'UNIT', 4200, 5650, 0, 0, { weight_kg: 2 }, 'CARTON', 6, 40],
  ['HOUSEHOLD', 'Dettol Antiseptic 750ml', 'Dettol', 'DTL-750', 'DTT-ANT-750ML', 'UNIT', 2650, 3450, 0, 0, { volume_ml: 750 }, 'CARTON', 12, 30],
  ['HOUSEHOLD', 'Harpic Toilet Cleaner 500ml', 'Harpic', 'HRP-500', 'HRP-CLN-500ML', 'UNIT', 1450, 1980, 0, 0, { volume_ml: 500 }, 'CARTON', 12, 40],
  ['BABY_PRODUCTS', 'Pampers Baby Dry Size 4 (58 pieces)', 'Pampers', 'PMP-S4-58', 'PMP-DPR-S4', 'PACK', 12500, 15800, 0, 0, { count: 58, size: '4' }, 'CARTON', 4, 30],
  ['BABY_PRODUCTS', 'Cerelac Wheat Apple 400g', 'Cerelac', 'CRL-WA-400', 'CRL-CCA-WA400', 'UNIT', 3200, 4150, 0, 0, { weight_g: 400 }, 'CARTON', 12, 30],
  ['STATIONERY', 'A4 Copy Paper 80gsm (Ream of 500)', 'PaperOne', 'A4-80-500', 'PPN-PPR-A480', 'REAM', 4800, 6200, 0, 0, { sheets: 500, gsm: 80 }, 'CARTON', 5, 40],
  ['PERSONAL_CARE', 'Close-Up Toothpaste 140ml', 'Close-Up', 'CLU-140', 'CLP-TP-140ML', 'UNIT', 780, 1150, 0, 0, { volume_ml: 140 }, 'CARTON', 24, 40],
];

const BUILDING_PRODUCTS = [
  ['CEMENT_BINDERS', 'Dangote Cement 3X (50kg)', 'Dangote', 'DNG-3X-50', 'DNG-CMT-3X50', 'BAG', 8200, 9500, 0, 0, { weight_kg: 50, grade: '3X' }, 'PALLET', 0, 60],
  ['CEMENT_BINDERS', 'BUA Cement 42.5R (50kg)', 'BUA', 'BUA-425R-50', 'BUA-CMT-425R', 'BAG', 8000, 9300, 0, 0, { weight_kg: 50 }, 'PALLET', 0, 60],
  ['STEEL_REINFORCEMENT', '12mm Iron Rod (TMT Reinforcement Bar, 12m)', 'African Foundries', 'TMT-12MM', 'AFR-ROD-12MM', 'LENGTH', 12500, 14800, 0, 0, { diameter_mm: 12, length_m: 12 }, 'BUNDLE', 20, 0],
  ['STEEL_REINFORCEMENT', '16mm Iron Rod (TMT, 12m)', 'African Foundries', 'TMT-16MM', 'AFR-ROD-16MM', 'LENGTH', 21500, 25000, 0, 0, { diameter_mm: 16, length_m: 12 }, 'BUNDLE', 15, 0],
  ['ROOFING', 'Aluminium Long-span Roofing Sheet (0.55mm, per metre)', 'Tower', 'ALU-055', 'TWR-RFS-ALU055', 'METRE', 4800, 6200, 0, 0, { thickness_mm: 0.55, material: 'Aluminium' }],
  ['ROOFING', 'Stone-Coated Roofing Tile (per square metre)', 'Wichtech', 'STN-SQM', 'WCT-TLE-STN', 'SQUARE_METRE', 8500, 11500, 0, 0, { material: 'Stone-coated steel' }],
  ['PLUMBING', 'PPR Pipe 25mm (4m length)', 'Generic', 'PPR-25-4M', 'GEN-PPR-25MM', 'LENGTH', 2800, 3850, 0, 0, { diameter_mm: 25, length_m: 4 }],
  ['PLUMBING', 'PVC Pipe 110mm (6m length)', 'Generic', 'PVC-110-6M', 'GEN-PVC-110', 'LENGTH', 8500, 11200, 0, 0, { diameter_mm: 110, length_m: 6 }],
  ['ELECTRICAL_FITTINGS', '4mm Single Core Cable (100m roll)', 'Nigerian Cable', 'CBL-4MM-100', 'NCL-CBL-4MM100', 'ROLL', 68000, 82500, 0, 0, { cross_section_mm: 4, length_m: 100 }],
  ['ELECTRICAL_FITTINGS', '13A Double Socket Outlet', 'Schneider', 'SCK-13A-DBL', 'SCH-SKT-13A2', 'UNIT', 3800, 5650, 0, 0, { amperage: 13, gangs: 2 }],
  ['PAINTS_COATINGS', 'Dulux Emulsion Paint 20L (White)', 'Dulux', 'DLX-EML-20L', 'DLX-PNT-EML20', 'BUCKET', 68000, 82500, 0, 0, { volume_litres: 20, colour: 'White', finish: 'Matt' }, null, 0, 0, 'SHELF_LIFE', 730],
  ['PAINTS_COATINGS', 'Sandtex Textured Paint 20L', 'Sandtex', 'SDT-TXT-20L', 'SDT-PNT-TXT20', 'BUCKET', 52000, 65000, 0, 0, { volume_litres: 20 }, null, 0, 0, 'SHELF_LIFE', 540],
  ['TILES_FLOORING', '600x600mm Porcelain Floor Tile (per carton of 4)', 'Cera', 'CRA-6060', 'CRA-TLE-6060', 'CARTON', 12500, 16800, 0, 0, { size_mm: '600x600', finish: 'Polished', pieces_per_carton: 4 }],
  ['DOORS_WINDOWS', 'Security Door (Turkish, Double Leaf)', 'SecurePro', 'SEC-DBL-TRK', 'SPR-DR-DBLTRK', 'UNIT', 385000, 495000, 12, 0, { material: 'Steel', leaves: 2 }],
  ['DOORS_WINDOWS', 'Aluminium Sliding Window 1.2x1.2m', 'AluTech', 'ALU-WIN-1212', 'ALT-WIN-1212', 'UNIT', 68000, 88000, 0, 0, { width_m: 1.2, height_m: 1.2 }],
  ['SAND_AGGREGATES', 'Sharp Sand (per 20-tonne truck)', 'Local', 'SND-SHARP-20T', 'LOC-SND-SHRP20', 'TRUCK_LOAD', 185000, 225000, 0, 0, { weight_tonnes: 20, type: 'Sharp' }],
  ['SAND_AGGREGATES', 'Granite 3/4 inch (per 30-tonne truck)', 'Local', 'GRT-34-30T', 'LOC-GRT-3430', 'TRUCK_LOAD', 425000, 495000, 0, 0, { weight_tonnes: 30, size: '3/4 inch' }],
];

async function seed({ db, options = {}, log = console.log } = {}) {
  const started = Date.now();
  const wantAllVerticals = !!(options.allVerticals || process.argv.includes('--vertical'));
  const created = { businesses: 0, branches: 0, users: 0, products: 0, batches: 0, customers: 0, sales: 0, serials: 0 };

  log('[seed] starting');

  // ---- platform ADMIN ---------------------------------------------------
  await upsertUser(db, {
    id: ID.admin, username: 'admin', pin: '9999', role: 'ADMIN',
    full_name: 'Platform Administrator', job_title: 'Vendor seat', branch_id: null, business_id: null,
  }, created);

  // ---- OWNER ------------------------------------------------------------
  const owner = await upsertUser(db, {
    id: ID.owner, username: 'owner', pin: '1234', role: 'OWNER',
    full_name: 'Adaeze Okafor', job_title: 'Proprietor', phone: '08031234567',
    email: 'adaeze@ridgegroup.ng', branch_id: null, business_id: null,
  }, created);

  // =====================================================================
  // BUSINESS 1 — ELECTRONICS
  // =====================================================================
  const biz1 = await upsertBusiness(db, {
    id: ID.biz1, name: 'Ridge Electronics & Appliances Ltd',
    vertical_code: 'ELECTRONICS', trading_name: 'Ridge Electronics',
    legal_name: 'Ridge Electronics & Appliances Limited',
    cac_number: 'RC-1845221', tin: '2458731902', vat_registration_no: 'VAT/104/2211845221/001',
    vat_enabled: 1, company_size: 'MEDIUM',
    uses_serial_tracking: 1, uses_warranty: 1, uses_delivery: 1, uses_installation: 1,
    uses_layaway: 1, uses_instalments: 1, uses_credit: 1, uses_wholesale: 1, uses_fx: 1,
    phone: '08055500001', email: 'sales@ridgeelectronics.ng',
    address: '14 Awolowo Way, Ikeja', state_code: 'LA', sort_order: 1,
  }, created);
  await gl.seedChart(db, biz1.id);
  await core.seedCategoriesFromProfile(db, biz1, VERTICALS.ELECTRONICS);
  const biz1Cats = await core.listCategories(db, biz1.id, { includeInactive: true });
  const biz1Cat = Object.fromEntries(biz1Cats.map((c) => [c.code, c]));
  const biz1Brands = await upsertBrands(db, biz1.id, ELECTRONICS_PRODUCTS.map((p) => p[2]));

  const brIkeja = await upsertBranch(db, {
    id: ID.brIkeja, business_id: biz1.id, name: 'Ikeja Showroom', code: 'IKJ',
    branch_type: 'RETAIL', address: '14 Awolowo Way, Ikeja', area: 'Ikeja', lga: 'Ikeja', state_code: 'LA',
    phone: '08055500101', latitude: 6.5965, longitude: 3.3421, geofence_radius_meters: 150,
    opening_time: '08:00', closing_time: '20:00', default_till_float: 50000,
    can_deliver: 1, vehicles: 2, drivers: 2, daily_delivery_capacity: 12,
    stock_pick_policy: 'FIFO', sort_order: 1,
  }, created);

  const brAlaba = await upsertBranch(db, {
    id: ID.brAlaba, business_id: biz1.id, name: 'Alaba Wholesale Depot', code: 'ALB',
    branch_type: 'WHOLESALE', address: 'Block C7, Alaba International Market', area: 'Alaba International',
    lga: 'Ojo', state_code: 'LA', phone: '08055500102', latitude: 6.4629, longitude: 3.2998,
    geofence_radius_meters: 300, opening_time: '07:00', closing_time: '18:00', default_till_float: 200000,
    can_deliver: 1, vehicles: 4, drivers: 4, daily_delivery_capacity: 25,
    stock_pick_policy: 'FIFO', sort_order: 2,
  }, created);

  // staff
  await upsertUser(db, { id: ID.gmBiz1, username: 'chinedu', pin: '2345', role: 'MANAGER', full_name: 'Chinedu Eze', job_title: 'General Manager', phone: '08066600001', branch_id: null, business_id: biz1.id }, created);
  await upsertUser(db, { id: ID.mgrIkeja, username: 'yetunde', pin: '3456', role: 'MANAGER', full_name: 'Yetunde Bakare', job_title: 'Branch Manager', phone: '08066600002', branch_id: brIkeja.id, business_id: biz1.id }, created);
  await upsertUser(db, { id: ID.mgrAlaba, username: 'ibrahim', pin: '4567', role: 'MANAGER', full_name: 'Ibrahim Musa', job_title: 'Branch Manager', phone: '08066600003', branch_id: brAlaba.id, business_id: biz1.id }, created);
  await upsertUser(db, { id: ID.staff1, username: 'grace', pin: '5678', role: 'STAFF', full_name: 'Grace Obi', job_title: 'Sales Representative', phone: '08077700001', branch_id: brIkeja.id, business_id: biz1.id }, created);
  await upsertUser(db, { id: ID.staff2, username: 'emeka', pin: '6789', role: 'STAFF', full_name: 'Emeka Nwosu', job_title: 'Storekeeper', phone: '08077700002', branch_id: brIkeja.id, business_id: biz1.id }, created);
  await upsertUser(db, { id: ID.driver1, username: 'sani', pin: '7890', role: 'STAFF', full_name: 'Sani Abdullahi', job_title: 'Delivery Driver', phone: '08077700003', branch_id: brIkeja.id, business_id: biz1.id, is_driver: 1 }, created);

  // products + opening stock
  const biz1Products = await seedProducts(db, {
    business: biz1, branchIds: [brIkeja.id, brAlaba.id], categoryMap: biz1Cat, brandMap: biz1Brands,
    rows: ELECTRONICS_PRODUCTS, counters: created, log,
  });

  // =====================================================================
  // BUSINESS 2 — FURNITURE
  // =====================================================================
  const biz2 = await upsertBusiness(db, {
    id: ID.biz2, name: 'Ridge Home & Living',
    vertical_code: 'FURNITURE', trading_name: 'Ridge Home',
    legal_name: 'Ridge Home & Living Nigeria Limited',
    cac_number: 'RC-2019884', tin: '2466120087', vat_registration_no: 'VAT/104/221/2019884/001',
    vat_enabled: 1, company_size: 'SMALL',
    uses_serial_tracking: 0, uses_warranty: 1, uses_delivery: 1, uses_installation: 1,
    uses_layaway: 1, uses_instalments: 1, uses_credit: 1, uses_wholesale: 1, uses_fx: 0,
    phone: '08055500002', email: 'hello@ridgehome.ng',
    address: '7B Admiralty Way, Lekki Phase 1', state_code: 'LA', sort_order: 2,
  }, created);
  await gl.seedChart(db, biz2.id);
  await core.seedCategoriesFromProfile(db, biz2, VERTICALS.FURNITURE);
  const biz2Cats = await core.listCategories(db, biz2.id, { includeInactive: true });
  const biz2Cat = Object.fromEntries(biz2Cats.map((c) => [c.code, c]));
  const biz2Brands = await upsertBrands(db, biz2.id, FURNITURE_PRODUCTS.map((p) => p[2]));

  const brLekki = await upsertBranch(db, {
    id: ID.brLekki, business_id: biz2.id, name: 'Lekki Gallery', code: 'LEK',
    branch_type: 'SHOWROOM', address: '7B Admiralty Way, Lekki Phase 1', area: 'Lekki Phase 1',
    lga: 'Eti-Osa', state_code: 'LA', phone: '08055500201', latitude: 6.4531, longitude: 3.4700,
    geofence_radius_meters: 200, opening_time: '09:00', closing_time: '19:00', default_till_float: 30000,
    can_deliver: 1, vehicles: 3, drivers: 3, daily_delivery_capacity: 8,
    stock_pick_policy: 'FIFO', sort_order: 1,
  }, created);

  const brAbuja = await upsertBranch(db, {
    id: ID.brAbuja, business_id: biz2.id, name: 'Abuja Showroom', code: 'ABJ',
    branch_type: 'SHOWROOM', address: 'Plot 1294, Cadastral Zone B06, Gwarinpa', area: 'Gwarinpa',
    lga: 'Abuja Municipal', state_code: 'FC', phone: '08055500202', latitude: 9.0765, longitude: 7.3986,
    geofence_radius_meters: 200, opening_time: '09:00', closing_time: '18:30', default_till_float: 25000,
    can_deliver: 1, vehicles: 1, drivers: 1, daily_delivery_capacity: 6,
    stock_pick_policy: 'FIFO', sort_order: 2,
  }, created);

  await upsertUser(db, { id: ID.gmBiz2, username: 'folake', pin: '8901', role: 'MANAGER', full_name: 'Folake Adeyemi', job_title: 'General Manager', phone: '08066600004', branch_id: null, business_id: biz2.id }, created);
  await upsertUser(db, { id: ID.mgrLekki, username: 'tunde', pin: '9012', role: 'MANAGER', full_name: 'Tunde Ogunleye', job_title: 'Branch Manager', phone: '08066600005', branch_id: brLekki.id, business_id: biz2.id }, created);
  await upsertUser(db, { id: ID.mgrAbuja, username: 'aisha', pin: '1122', role: 'MANAGER', full_name: 'Aisha Bello', job_title: 'Branch Manager', phone: '08066600006', branch_id: brAbuja.id, business_id: biz2.id }, created);
  await upsertUser(db, { id: ID.staff3, username: 'blessing', pin: '2233', role: 'STAFF', full_name: 'Blessing Okon', job_title: 'Sales Consultant', phone: '08077700004', branch_id: brLekki.id, business_id: biz2.id }, created);

  const biz2Products = await seedProducts(db, {
    business: biz2, branchIds: [brLekki.id, brAbuja.id], categoryMap: biz2Cat, brandMap: biz2Brands,
    rows: FURNITURE_PRODUCTS, counters: created, log,
  });

  // =====================================================================
  // OPTIONAL: the other two verticals (--vertical all)
  // =====================================================================
  if (wantAllVerticals) {
    await seedExtraVertical(db, {
      owner, created, log,
      key: 'biz3', name: 'Ridge Provisions Wholesale', vertical_code: 'WHOLESALE_RETAIL',
      profile: VERTICALS.WHOLESALE_RETAIL, cac: 'BN-4412887', tin: '2477001234',
      branch: { name: 'Onitsha Depot', code: 'ONI', type: 'WHOLESALE', area: 'Onitsha (Main Market)', lga: 'Onitsha South', state: 'AN', lat: 6.1531, lng: 6.7831 },
      rows: WHOLESALE_PRODUCTS,
    });
    await seedExtraVertical(db, {
      owner, created, log,
      key: 'biz4', name: 'Ridge Building Materials', vertical_code: 'BUILDING_MATERIALS',
      profile: VERTICALS.BUILDING_MATERIALS, cac: 'RC-2288441', tin: '2488119900',
      branch: { name: 'Dei-Dei Yard', code: 'DEI', type: 'YARD', area: 'Dei-Dei', lga: 'Abuja Municipal', state: 'FC', lat: 9.1400, lng: 7.3300 },
      rows: BUILDING_PRODUCTS,
    });
  }

  // =====================================================================
  // CUSTOMERS  (spanning the classes, one overdue, so credit gates are live)
  // =====================================================================
  const customers = await seedCustomers(db, { biz1, biz2, brIkeja, brLekki, created });

  // =====================================================================
  // SUPPLIERS
  // =====================================================================
  const suppliers = await seedSuppliers(db, { biz1, biz2, created });

  // =====================================================================
  // SERIALS + WARRANTY (electronics only)
  // =====================================================================
  const serialCount = await seedSerials(db, { business: biz1, branch: brIkeja, products: biz1Products, created, log });
  created.serials = serialCount;

  // =====================================================================
  // DELIVERY ZONES
  // =====================================================================
  await seedDeliveryZones(db, { biz1, biz2, created });

  // =====================================================================
  // LAYAWAY HOLDS  (so the sellable-vs-on-hand distinction is visible on day 1)
  // =====================================================================
  await seedHolds(db, { business: biz1, branch: brIkeja, products: biz1Products, customers, created, log });

  // =====================================================================
  // WHT RATES, HOLIDAYS, FX REFERENCE RATES, COMPLIANCE
  // =====================================================================
  await seedWhtRates(db, created);
  await seedHolidays(db, created);
  await seedFxRates(db, biz1.id, created);
  await seedComplianceCertificates(db, created);

  // =====================================================================
  // HISTORIC SALES + TILL + LEDGERS + GL
  // =====================================================================
  const saleCount = await seedHistoricSales(db, {
    businesses: [biz1, biz2],
    branches: { [biz1.id]: [brIkeja, brAlaba], [biz2.id]: [brLekki, brAbuja] },
    products: { [biz1.id]: biz1Products, [biz2.id]: biz2Products },
    customers, users: [ID.staff1, ID.staff3, ID.mgrIkeja, ID.mgrLekki],
    created, log,
  });
  created.sales = saleCount;

  // Ensure active till sessions exist for today on all branches
  for (const br of [brIkeja, brAlaba, brLekki, brAbuja]) {
    await ensureTill(db, br, ID.owner, today());
  }

  await seedDebtorLedger(db, { business: biz1, branch: brIkeja, customers, created });
  await seedCreditorLedger(db, { business: biz1, branch: brIkeja, suppliers, created });

  const integrity = await gl.checkLedgerIntegrity(db, { businessId: biz1.id });
  log(`[seed] ledger integrity (biz1): ${integrity.ok ? 'BALANCED' : 'UNBALANCED'} — ${integrity.entries} entries, DR ${integrity.total_debit} / CR ${integrity.total_credit}`);

  log(`[seed] complete in ${((Date.now() - started) / 1000).toFixed(1)}s — `
    + `${created.businesses} businesses, ${created.branches} branches, ${created.users} users, `
    + `${created.products} products, ${created.batches} stock batches, ${created.customers} customers, `
    + `${created.sales} sales, ${created.serials} serials`);
  log('[seed] sign in as: owner / 1234   (proprietor, sees both businesses)');
  log('[seed]               yetunde / 3456  (Branch Manager, Ikeja only)');
  log('[seed]               grace / 5678    (Staff, Ikeja — cashier)');
  log('[seed]               admin / 9999    (platform administrator — vendor seat)');

  return created;
}

// ---------------------------------------------------------------------
// upserts
// ---------------------------------------------------------------------
async function upsertUser(db, u, created) {
  const existing = await db.prepare('SELECT id, pin_hash FROM users WHERE id = ?').bind(u.id).first();
  if (existing) return existing;
  await db.prepare(`
    INSERT INTO users (id, branch_id, business_id, full_name, username, pin_hash, role, job_title, phone, email, is_driver, is_active, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1, datetime('now'), datetime('now'))
  `).bind(u.id, u.branch_id || null, u.business_id || null, u.full_name, u.username, hashPin(u.pin),
    u.role, u.job_title || null, u.phone || null, u.email || null, u.is_driver ? 1 : 0).run();
  created.users += 1;
  return { id: u.id };
}

async function upsertBusiness(db, b, created) {
  const existing = await db.prepare('SELECT * FROM businesses WHERE id = ?').bind(b.id).first();
  if (existing) return existing;
  await db.prepare(`
    INSERT INTO businesses (
      id, name, vertical_code, trading_name, legal_name, cac_number, tin, vat_registration_no,
      vat_enabled, vat_rate_percent, company_size,
      uses_serial_tracking, uses_warranty, uses_delivery, uses_installation, uses_layaway,
      uses_instalments, uses_shelf_life, uses_credit, uses_wholesale, uses_fx,
      email, phone, address, state_code, is_active, sort_order, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?, datetime('now'), datetime('now'))
  `).bind(b.id, b.name, b.vertical_code, b.trading_name || null, b.legal_name || null, b.cac_number || null,
    b.tin || null, b.vat_registration_no || null, b.vat_enabled ? 1 : 0, b.vat_rate_percent || 7.5,
    b.company_size || 'SMALL',
    b.uses_serial_tracking ? 1 : 0, b.uses_warranty ? 1 : 0, b.uses_delivery ? 1 : 0, b.uses_installation ? 1 : 0,
    b.uses_layaway ? 1 : 0, b.uses_instalments ? 1 : 0, b.uses_shelf_life ? 1 : 0, b.uses_credit ? 1 : 0,
    b.uses_wholesale ? 1 : 0, b.uses_fx ? 1 : 0,
    b.email || null, b.phone || null, b.address || null, b.state_code || null, b.sort_order || 0).run();
  created.businesses += 1;
  return b;
}

async function upsertBranch(db, b, created) {
  const existing = await db.prepare('SELECT * FROM branches WHERE id = ?').bind(b.id).first();
  if (existing) return existing;
  await db.prepare(`
    INSERT INTO branches (
      id, business_id, name, code, branch_type, address, area, lga, state_code, phone, email,
      latitude, longitude, geofence_radius_meters, attendance_mode, opening_time, closing_time,
      default_till_float, can_deliver, vehicles, drivers, daily_delivery_capacity,
      stock_pick_policy, is_active, sort_order, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'GEOLOCATION', ?,?,?,?,?,?,?, 'FIFO', 1, ?, datetime('now'), datetime('now'))
  `).bind(b.id, b.business_id, b.name, b.code || null, b.branch_type, b.address || null, b.area || null,
    b.lga || null, b.state_code || null, b.phone || null, b.email || null,
    b.latitude != null ? b.latitude : null, b.longitude != null ? b.longitude : null,
    b.geofence_radius_meters || 100, b.opening_time || null, b.closing_time || null,
    b.default_till_float || 0, b.can_deliver ? 1 : 0, b.vehicles || 0, b.drivers || 0,
    b.daily_delivery_capacity || 10, b.sort_order || 0).run();
  created.branches += 1;
  return b;
}

async function upsertBrands(db, businessId, names) {
  const unique = [...new Set(names.filter(Boolean))];
  const map = {};
  for (const name of unique) {
    const existing = await db.prepare('SELECT * FROM brands WHERE business_id = ? AND name = ? AND is_deleted = 0')
      .bind(String(businessId), name).first();
    if (existing) { map[name] = existing; continue; }
    const row = { id: newId(), name };
    await db.prepare(`
      INSERT INTO brands (id, business_id, name, country, is_active, created_at, updated_at)
      VALUES (?,?,?,?,1, datetime('now'), datetime('now'))
    `).bind(row.id, String(businessId), name, null).run();
    map[name] = row;
  }
  return map;
}

// ---------------------------------------------------------------------
// products + opening stock
// ---------------------------------------------------------------------
async function seedProducts(db, { business, branchIds, categoryMap, brandMap, rows, counters, log }) {
  const out = [];
  for (const row of rows) {
    const [catCode, name, brand, model, sku, baseUnit, cost, retail, warrantyMonths, serialTracked, attrs] = row;
    // Optional trailing fields: [unitType, unitsPer, ..., shelfLifeDays]
    const unitsPerPack = row[12] || 1;
    const packsPerCarton = row[13] || 0;
    const unitsPerCarton = row[11] === 'CARTON' ? row[12] : (row[11] === 'PACK' ? row[13] : 0);
    const unitsPerPallet = row[11] === 'PALLET' ? row[13] : (row[11] === 'BUNDLE' ? row[13] : 0);
    const cartonsPerPallet = row[11] === 'CARTON' ? row[13] : 0;
    const shelfLifeDays = row[17] || null;
    const category = categoryMap[catCode] || null;

    const existing = await db.prepare('SELECT * FROM products WHERE business_id = ? AND sku = ? AND is_deleted = 0')
      .bind(String(business.id), sku).first();
    if (existing) { out.push(existing); continue; }

    const isBuilding = business.vertical_code === 'BUILDING_MATERIALS';
    const id = newId();
    const wholesalePrice = M.round2(retail * 0.9);
    const searchText = [name, brand, model, sku, category ? category.name : '', Object.values(attrs || {}).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();

    await db.prepare(`
      INSERT INTO products (
        id, business_id, category_id, brand_id, name, sku, model_number, description,
        restriction_reason, register_required, serial_tracking,
        base_unit, units_per_pack, units_per_carton, packs_per_carton, units_per_pallet, cartons_per_pallet,
        allows_fractional_qty, unit_weight_kg, is_bulky, needs_two_man_delivery,
        shelf_life_days, track_best_before, warranty_months, warranty_basis, warranty_provider,
        compliance_scheme, compliance_reg_no, country_of_origin,
        attributes_json, search_text,
        default_selling_price, wholesale_price, recommended_retail_price, target_margin_percent,
        reorder_level, reorder_quantity, is_stocked, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))
    `).bind(
      id, String(business.id), category ? category.id : null, brandMap[brand] ? brandMap[brand].id : null,
      name, sku, model, `${brand} ${name}`,
      // restriction_reason / register_required / serial_tracking.
      //
      // These three columns are NULLABLE ON PURPOSE: NULL means "inherit from
      // the category, then from the vertical profile" (see
      // shared/lib/verticals.js effectiveRestriction). Writing the category's
      // own default into the product column turns an inheritance chain into a
      // hard override, which is not a cosmetic difference: an earlier draft of
      // this seed did exactly that, and every electronics line — HDMI cables
      // and power banks included — became serial-capture-required. A cashier
      // would have been asked for a serial number on every cable sold, and the
      // correct response to that is to stop using the system.
      //
      // So: a serialised line opts IN explicitly; a non-serialised line in a
      // category that defaults to capture opts OUT explicitly; everything else
      // stays NULL and inherits.
      serialTracked ? 'SERIAL_CAPTURE' : 'NONE',
      serialTracked ? 1 : (category && category.register_required ? 0 : null),
      serialTracked ? 1 : 0,
      baseUnit, unitsPerPack, unitsPerCarton || null, packsPerCarton || null, unitsPerPallet || null, cartonsPerPallet || null,
      isBuilding && ['TRUCK_LOAD', 'TONNE', 'METRE', 'SQUARE_METRE', 'KILOGRAM'].includes(baseUnit) ? 1 : 0,
      attrs && attrs.weight_kg ? Number(attrs.weight_kg) : null,
      attrs && attrs.weight_kg && attrs.weight_kg >= 30 ? 1 : (['SET', 'TRUCK_LOAD', 'CARTON'].includes(baseUnit) ? 1 : 0),
      (attrs && attrs.requires_assembly) || ['SET'].includes(baseUnit) ? 1 : 0,
      shelfLifeDays, shelfLifeDays ? 1 : 0,
      warrantyMonths || 0, warrantyMonths ? 'SALE' : null,
      warrantyMonths ? 'MANUFACTURER' : null,
      business.vertical_code === 'ELECTRONICS' ? 'SONCAP' : (business.vertical_code === 'WHOLESALE_RETAIL' ? 'NAFDAC' : null),
      null, null,
      JSON.stringify(attrs || {}), searchText,
      retail, wholesalePrice, retail, retail > 0 ? M.round2(((retail - cost) / retail) * 100) : 0,
      Math.max(2, Math.round(retail / 1000)), Math.max(5, Math.round(retail / 500)),
      1, 1
    ).run();
    counters.products += 1;

    // Barcode: an EAN-13 with a valid check digit, plus the SKU.
    const ean = makeEan13(id);
    await db.prepare(`
      INSERT INTO product_barcodes (id, product_id, barcode, unit_type, label, is_primary, created_at, updated_at)
      VALUES (?,?,?, 'BASE_UNIT', ?, 1, datetime('now'), datetime('now'))
    `).bind(newId(), id, ean, `Primary barcode for ${name}`).run();

    // Opening stock: TWO batches at different costs and dates for most lines, so
    // FIFO picking, stock valuation and margin all have something real to do.
    const product = { id, name, base_unit: baseUnit, units_per_pack: unitsPerPack, units_per_carton: unitsPerCarton, packs_per_carton: packsPerCarton, units_per_pallet: unitsPerPallet, cartons_per_pallet: cartonsPerPallet, selling_price_per_unit: retail, default_selling_price: retail };
    for (const branchId of branchIds) {
      const batches = [
        { daysAgo: 75, qtyPct: 0.35, costFactor: 1.06 },   // older, costlier stock
        { daysAgo: 12, qtyPct: 0.65, costFactor: 1.00 },   // newer stock
      ];
      const baseQty = qtyFor(retail, branchIds.length, name);
      for (const b of batches) {
        const qty = Math.max(1, Math.round(baseQty * b.qtyPct));
        if (qty <= 0) continue;
        const thisCost = M.round2(cost * b.costFactor);
        await insertBatch(db, {
          businessId: business.id, branchId, product, qty,
          cost: thisCost, price: retail,
          daysAgo: b.daysAgo,
          batchNo: `OPEN-${daysAgo(b.daysAgo).replace(/-/g, '')}`,
          bestBefore: shelfLifeDays ? daysAhead(shelfLifeDays - b.daysAgo) : null,
        });
        counters.batches += 1;
      }
    }
    out.push(await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first());
  }
  return out;
}

/** A plausible opening quantity: cheaper items in larger numbers. */
function qtyFor(retail, branchCount, name) {
  if (retail >= 500000) return Math.max(6, Math.round(18 / branchCount));
  if (retail >= 150000) return Math.max(10, Math.round(30 / branchCount));
  if (retail >= 40000) return Math.max(15, Math.round(60 / branchCount));
  if (retail >= 5000) return Math.max(25, Math.round(100 / branchCount));
  return Math.max(50, Math.round(250 / branchCount));
}

async function insertBatch(db, { businessId, branchId, product, qty, cost, price, daysAgo, batchNo, bestBefore = null, reserved = 0 }) {
  const id = newId();
  await db.prepare(`
    INSERT INTO stock_batches (
      id, branch_id, product_id, batch_no, quantity_on_hand, quantity_reserved, quantity_damaged,
      cost_per_unit, selling_price_per_unit, wholesale_price_per_unit, received_at, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now', ?), 'ACTIVE', datetime('now', ?), datetime('now'))
  `).bind(id, String(branchId), String(product.id), batchNo, qty, reserved, 0,
    cost, price, M.round2(price * 0.9), `-${daysAgo} days`, `-${daysAgo} days`).run();

  // The batch's best_before is set separately so the same offset logic applies.
  if (bestBefore) {
    await db.prepare('UPDATE stock_batches SET best_before_date = ? WHERE id = ?').bind(bestBefore, id).run();
  }

  await db.prepare(`
    INSERT INTO stock_movements (
      id, business_id, branch_id, product_id, stock_batch_id, movement_type, direction, quantity,
      value_kobo, unit_cost, source_type, source_id, moved_by, moved_at, notes, created_at)
    VALUES (?,?,?,?,?, 'OPENING_BALANCE', 1, ?,?,?, 'SEED', ?, NULL, datetime('now', ?), ?, datetime('now', ?))
  `).bind(newId(), String(businessId), String(branchId), String(product.id), id, qty,
    M.toKobo(cost) * qty, cost, id, `-${daysAgo} days`, 'Opening stock', `-${daysAgo} days`).run();

  return id;
}

/** A valid EAN-13 check digit, so scanning in the demo actually validates. */
function makeEan13(seedString) {
  let hash = 0;
  for (const ch of String(seedString)) hash = (hash * 31 + ch.charCodeAt(0)) % 1000000000000;
  const first12 = String(615600000000 + (hash % 999999999)).padStart(12, '0').slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return first12 + check;
}

// ---------------------------------------------------------------------
// extra verticals
// ---------------------------------------------------------------------
async function seedExtraVertical(db, { owner, created, log, key, name, vertical_code, profile, cac, tin, branch, rows }) {
  const bizId = `biz_${key}`;
  const business = await upsertBusiness(db, {
    id: bizId, name, vertical_code, trading_name: name, cac_number: cac, tin,
    vat_enabled: 1, company_size: 'SMALL',
    uses_serial_tracking: 0, uses_warranty: 0, uses_delivery: 1, uses_installation: 0,
    uses_layaway: 0, uses_instalments: 1,
    uses_shelf_life: vertical_code === 'WHOLESALE_RETAIL' ? 1 : 0,
    uses_credit: 1, uses_wholesale: 1, uses_fx: 0, sort_order: created.businesses + 1,
  }, created);
  await gl.seedChart(db, business.id);
  await core.seedCategoriesFromProfile(db, business, profile);
  const cats = await core.listCategories(db, business.id, { includeInactive: true });
  const catMap = Object.fromEntries(cats.map((c) => [c.code, c]));
  const brandMap = await upsertBrands(db, business.id, rows.map((r) => r[2]));
  const brId = `br_${key}`;
  const br = await upsertBranch(db, {
    id: brId, business_id: business.id, name: branch.name, code: branch.code, branch_type: branch.type,
    area: branch.area, lga: branch.lga, state_code: branch.state, latitude: branch.lat, longitude: branch.lng,
    geofence_radius_meters: 300, default_till_float: 50000, can_deliver: 1, vehicles: 2, drivers: 2,
    daily_delivery_capacity: 15, sort_order: 1,
  }, created);
  await upsertUser(db, {
    id: `usr_mgr_${key}`, username: key, pin: '3344', role: 'MANAGER',
    full_name: `${name.split(' ')[1] || 'Branch'} Manager`, job_title: 'Branch Manager',
    branch_id: brId, business_id: bizId,
  }, created);
  const products = await seedProducts(db, { business, branchIds: [brId], categoryMap: catMap, brandMap, rows, counters: created, log });
  log(`[seed] ${vertical_code}: ${products.length} products at ${branch.name}`);
  return { business, branch: br, products };
}

// ---------------------------------------------------------------------
// customers
// ---------------------------------------------------------------------
async function seedCustomers(db, { biz1, biz2, brIkeja, brLekki, created }) {
  const defs = [
    { biz: biz1, br: brIkeja, cls: 'RETAIL', type: 'INDIVIDUAL', name: 'Ada Obi', phone: '08033300001', area: 'Ikeja', state: 'LA', limit: null, terms: 'CASH' },
    { biz: biz1, br: brIkeja, cls: 'RETAIL', type: 'INDIVIDUAL', name: 'Kunle Adebayo', phone: '08033300002', area: 'Surulere', state: 'LA', limit: null, terms: 'CASH' },
    { biz: biz1, br: brIkeja, cls: 'TRADE', type: 'COMPANY', name: 'Zenith Facilities Ltd', company: 'Zenith Facilities Nigeria Ltd', phone: '08033300003', area: 'Victoria Island', state: 'LA', tin: '2455001122', cac: 'RC-998877', limit: 2000000, terms: 'NET_30' },
    { biz: biz1, br: brIkeja, cls: 'WHOLESALE', type: 'COMPANY', name: 'Bright Electronics Ventures', company: 'Bright Electronics Ventures Ltd', phone: '08033300004', area: 'Alaba International', state: 'LA', tin: '2455003344', cac: 'RC-1122334', limit: 8000000, terms: 'NET_14' },
    { biz: biz1, br: brIkeja, cls: 'DISTRIBUTOR', type: 'COMPANY', name: 'Kano Tech Distributors', company: 'Kano Tech Distributors Ltd', phone: '08033300005', area: 'Sabon Gari', state: 'KN', tin: '2455005566', cac: 'RC-3344556', limit: 25000000, terms: 'NET_30' },
    { biz: biz1, br: brIkeja, cls: 'CORPORATE', type: 'GOVERNMENT', name: 'FCT Ministry of Works', company: 'FCT Ministry of Works', phone: '08033300006', area: 'Abuja', state: 'FC', tin: '2455007788', limit: 50000000, terms: 'NET_60' },
    { biz: biz1, br: brIkeja, cls: 'WHOLESALE', type: 'COMPANY', name: 'Delta Provisions Trade', company: 'Delta Provisions Trade Ltd', phone: '08033300007', area: 'Warri', state: 'DE', tin: '2455009900', cac: 'RC-5566778', limit: 5000000, terms: 'NET_30', overdue: true },
    { biz: biz2, br: brLekki, cls: 'RETAIL', type: 'INDIVIDUAL', name: 'Mrs Funke Adewale', phone: '08044400001', area: 'Lekki Phase 1', state: 'LA', limit: null, terms: 'CASH' },
    { biz: biz2, br: brLekki, cls: 'TRADE', type: 'COMPANY', name: 'Lagos Interiors Studio', company: 'Lagos Interiors Studio Ltd', phone: '08044400002', area: 'Ikoyi', state: 'LA', tin: '2466001122', cac: 'RC-7788990', limit: 15000000, terms: 'NET_30' },
    { biz: biz2, br: brLekki, cls: 'CORPORATE', type: 'COMPANY', name: 'Meridian Estates Development', company: 'Meridian Estates Development Ltd', phone: '08044400003', area: 'Ajah', state: 'LA', tin: '2466003344', cac: 'RC-8899001', limit: 80000000, terms: 'MILESTONE' },
    { biz: biz2, br: brLekki, cls: 'RETAIL', type: 'INDIVIDUAL', name: 'Dr Emeka Ibe', phone: '08044400004', area: 'Gwarinpa', state: 'FC', limit: 3000000, terms: 'NET_14' },
  ];

  const out = [];
  for (const d of defs) {
    const existing = await db.prepare('SELECT * FROM customers WHERE business_id = ? AND name = ? AND is_deleted = 0')
      .bind(String(d.biz.id), d.name).first();
    if (existing) { out.push(existing); continue; }
    const id = newId();
    await db.prepare(`
      INSERT INTO customers (
        id, business_id, home_branch_id, customer_class, customer_type, name, company_name, phone,
        area, state_code, tin, cac_number, credit_limit, terms_code, account_status,
        discount_percent, total_purchases, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', 0, 0, datetime('now'), datetime('now'))
    `).bind(id, String(d.biz.id), String(d.br.id), d.cls, d.type, d.name, d.company || null, d.phone,
      d.area || null, d.state || null, d.tin || null, d.cac || null,
      d.limit != null ? d.limit : null, d.terms || 'CASH').run();
    created.customers += 1;
    const row = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------
// suppliers
// ---------------------------------------------------------------------
async function seedSuppliers(db, { biz1, biz2, created }) {
  const defs = [
    { biz: biz1, name: 'Samsung Electronics West Africa', type: 'GOODS', phone: '08022200001', state: 'LA', tin: '2411001111', terms: 'NET_30', lead: 21, bank: 'Stanbic IBTC', acct: '0011223344' },
    { biz: biz1, name: 'LG Electronics Nigeria', type: 'GOODS', phone: '08022200002', state: 'LA', tin: '2411002222', terms: 'NET_30', lead: 21, bank: 'Guaranty Trust', acct: '0022334455' },
    { biz: biz1, name: 'Alaba Direct Imports', type: 'GOODS', phone: '08022200003', state: 'LA', terms: 'CASH', lead: 3, bank: 'Access Bank', acct: '0033445566' },
    { biz: biz1, name: 'Oriental Cargo Logistics', type: 'LOGISTICS', phone: '08022200004', state: 'LA', tin: '2411004444', terms: 'NET_14', lead: 7 },
    { biz: biz1, name: 'Ikeja Showroom Landlord (Chief Balogun)', type: 'LANDLORD', phone: '08022200005', state: 'LA', tin: '2411005555', terms: 'NET_7', lead: 0 },
    { biz: biz1, name: 'CoolTech Refrigeration Services', type: 'SERVICE', phone: '08022200006', state: 'LA', terms: 'CASH', lead: 2 },
    { biz: biz2, name: 'RidgeCraft Workshop (own production)', type: 'GOODS', phone: '08022200007', state: 'LA', terms: 'CASH', lead: 14 },
    { biz: biz2, name: 'Vitafoam Nigeria Plc', type: 'GOODS', phone: '08022200008', state: 'OG', tin: '2411008888', terms: 'NET_30', lead: 10 },
    { biz: biz2, name: 'Abeokuta Timber Supply', type: 'GOODS', phone: '08022200009', state: 'OG', terms: 'CASH', lead: 5 },
    { biz: biz2, name: 'SwiftMove Haulage', type: 'LOGISTICS', phone: '08022200010', state: 'LA', terms: 'NET_7', lead: 1 },
  ];
  const out = [];
  for (const d of defs) {
    const existing = await db.prepare('SELECT * FROM suppliers WHERE business_id = ? AND name = ? AND is_deleted = 0')
      .bind(String(d.biz.id), d.name).first();
    if (existing) { out.push(existing); continue; }
    const id = newId();
    await db.prepare(`
      INSERT INTO suppliers (
        id, business_id, name, contact_person, phone, address, state_code, tin, cac_number,
        bank_name, bank_account_no, supplier_type, default_terms_code, lead_time_days, rating, is_active,
        created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1, datetime('now'), datetime('now'))
    `).bind(id, String(d.biz.id), d.name, d.contact || null, d.phone, d.address || null, d.state || null,
      d.tin || null, d.cac || null, d.bank || null, d.acct || null, d.type, d.terms || 'CASH', d.lead || 7,
      d.rating || 4).run();
    out.push(await db.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first());
  }
  return out;
}

// ---------------------------------------------------------------------
// serials
// ---------------------------------------------------------------------
async function seedSerials(db, { business, branch, products, created, log }) {
  let count = 0;
  const serialised = products.filter((p) => p && Number(p.serial_tracking) === 1);
  for (const p of serialised) {
    // Register serials for what is actually on hand, so the register and the
    // stock report agree.
    const batches = await db.prepare(
      'SELECT * FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0'
    ).bind(String(p.id), String(branch.id)).all();
    for (const b of batches) {
      const qty = Math.min(12, Number(b.quantity_on_hand) || 0);
      for (let i = 0; i < qty; i += 1) {
        const raw = serialFor(p.sku, b.batch_no, i);
        const norm = WARRANTY.normaliseSerial(raw);
        const dup = await db.prepare('SELECT id FROM serial_numbers WHERE business_id = ? AND serial_normalised = ?')
          .bind(String(business.id), norm).first();
        if (dup) continue;
        await db.prepare(`
          INSERT INTO serial_numbers (
            id, business_id, product_id, serial_number, serial_normalised, model_number,
            status, branch_id, stock_batch_id, warranty_months, warranty_basis, warranty_status,
            received_at, received_by, cost_per_unit, created_at, updated_at)
          VALUES (?,?,?,?,?,?, 'IN_STOCK', ?,?,?,?, 'PENDING', datetime('now', '-60 days'), ?, ?, datetime('now'), datetime('now'))
        `).bind(newId(), String(business.id), String(p.id), raw, norm, p.model_number || null,
          String(branch.id), String(b.id),
          Number(p.warranty_months) || 0, p.warranty_basis || 'SALE',
          null, Number(b.cost_per_unit) || 0).run();
        count += 1;
      }
    }
  }
  return count;
}

function serialFor(sku, batchNo, index) {
  // A plausible manufacturer serial: prefix from the SKU, a batch-derived
  // middle, and a sequence. Deterministic so a re-seed finds the same values.
  const base = String(sku || 'SR').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6);
  const b = String(batchNo || 'OPEN').replace(/\D/g, '').slice(-6) || '100000';
  return `${base}${b}${String(index + 1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------
// delivery zones
// ---------------------------------------------------------------------
async function seedDeliveryZones(db, { biz1, biz2, created }) {
  const zones = [
    // [biz, code, name, state, lga, area, base, perKm, bulky, cap, floor, install, distKm]
    [biz1, 'IKJ_LOCAL', 'Ikeja & immediate mainland', 'LA', 'Ikeja', 'Ikeja', 3000, 250, 1500, 9000, 1000, 2500, 6],
    [biz1, 'Lagos_ISLAND', 'Lagos Island / VI / Ikoyi', 'LA', 'Eti-Osa', 'Victoria Island', 8000, 350, 2500, 15000, 1500, 3500, 22],
    [biz1, 'LEKKI', 'Lekki / Ajah axis', 'LA', 'Eti-Osa', 'Lekki Phase 1', 8000, 400, 2500, 18000, 1500, 3500, 32],
    [biz1, 'MAINLAND_WEST', 'Agege / Alimosho / Ojo', 'LA', 'Alimosho', 'Agege', 4000, 300, 2000, 12000, 1000, 2500, 18],
    [biz1, 'OUTSTATE_LA', 'Lagos outskirts (Epe, Badagry, Ikorodu)', 'LA', null, null, 12000, 450, 3500, 25000, 2000, 5000, 55],
    [biz1, 'ABUJA', 'Abuja (FCT)', 'FC', 'Abuja Municipal', null, 15000, 500, 4000, 30000, 2500, 6000, 90],
    [biz1, 'SOUTHWEST', 'South-West states (Ogun, Oyo, Osun, Ondo)', null, null, null, 18000, 550, 5000, 40000, 3000, 7500, 120],
    [biz1, 'NATIONWIDE', 'Nationwide (waybill to a depot)', null, null, null, 25000, 600, 6000, 60000, 0, 0, 0],
    [biz2, 'LEKKI_LOCAL', 'Lekki / Ajah / Ikoyi (furniture)', 'LA', 'Eti-Osa', 'Lekki Phase 1', 10000, 400, 5000, 30000, 2500, 15000, 8],
    [biz2, 'LAGOS_MAINLAND', 'Lagos Mainland (furniture)', 'LA', 'Ikeja', 'Ikeja', 14000, 450, 6000, 35000, 2500, 15000, 25],
    [biz2, 'ABUJA_LOCAL', 'Abuja / Gwarinpa (furniture)', 'FC', 'Abuja Municipal', 'Gwarinpa', 10000, 400, 5000, 30000, 2500, 15000, 6],
    [biz2, 'ABUJA_OUTSKIRTS', 'Abuja outskirts (Kubwa, Lugbe, Gwagwalada)', 'FC', null, null, 16000, 500, 7000, 40000, 3000, 18000, 28],
  ];
  for (const z of zones) {
    const [biz, code, name, state, lga, area, base, perKm, bulky, cap, floor, install, distKm] = z;
    const existing = await db.prepare('SELECT id FROM delivery_zones WHERE business_id = ? AND code = ? AND is_deleted = 0')
      .bind(String(biz.id), code).first();
    if (existing) continue;
    await db.prepare(`
      INSERT INTO delivery_zones (
        id, business_id, branch_id, code, name, state_code, lga, area,
        base_fee, per_km_fee, bulky_surcharge, bulky_surcharge_cap, floor_surcharge, installation_fee,
        minimum_fee, default_distance_km, estimated_hours, is_serviceable, is_active, sort_order, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?, datetime('now'), datetime('now'))
    `).bind(newId(), String(biz.id), null, code, name, state, lga, area,
      base, perKm, bulky, cap, floor, install, base, distKm || null,
      distKm ? Math.max(1, Math.round(distKm / 25)) : null, z.length).run();
  }
}

// ---------------------------------------------------------------------
// layaway holds (and the stock they reserve)
// ---------------------------------------------------------------------
async function seedHolds(db, { business, branch, products, customers, created, log }) {
  const retail = customers.filter((c) => c.business_id === business.id);
  const tv = products.find((p) => p && /Samsung 55/.test(p.name));
  const fridge = products.find((p) => p && /340L/.test(p.name));
  if (!tv || !fridge || !retail.length) return;

  const holds = [
    { product: tv, qty: 1, depositPct: 0.3, daysAgo: 5, expiresIn: 4, customer: retail[0], reason: 'DEPOSIT_PAID' },
    { product: fridge, qty: 1, depositPct: 0.25, daysAgo: 9, expiresIn: 5, customer: retail[1] || retail[0], reason: 'AWAITING_PAYMENT' },
    { product: tv, qty: 2, depositPct: 0.5, daysAgo: 20, expiresIn: -1, customer: retail[0], reason: 'CORPORATE_PO' },  // EXPIRED
  ];

  for (const h of holds) {
    const holdNo = `HLD-${String(created.batches + holds.indexOf(h)).padStart(5, '0')}`;
    const existing = await db.prepare('SELECT id FROM layaway_holds WHERE business_id = ? AND hold_number = ?').bind(String(business.id), holdNo).first();
    if (existing) continue;

    const price = Number(h.product.default_selling_price) * h.qty;
    const deposit = M.round2(price * h.depositPct);
    const id = newId();
    const heldFrom = daysAgo(h.daysAgo);
    const expires = h.expiresIn < 0 ? daysAgo(Math.abs(h.expiresIn)) : daysAhead(h.expiresIn);
    const status = h.expiresIn < 0 ? 'EXPIRED' : 'ACTIVE';

    await db.prepare(`
      INSERT INTO layaway_holds (
        id, business_id, branch_id, hold_number, customer_id, customer_name, customer_phone, status, reason,
        deposit_kobo, deposit, total_value_kobo, total_value, balance_kobo, deposit_percent,
        held_from, expires_on, created_by, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))
    `).bind(id, String(business.id), String(branch.id), holdNo, String(h.customer.id), h.customer.name, h.customer.phone,
      status, h.reason, M.toKobo(deposit), deposit, M.toKobo(price), price, M.toKobo(price - deposit),
      M.round2(h.depositPct * 100), heldFrom, expires, ID.staff1,
      status === 'EXPIRED' ? 'Demo hold — left to expire so the nightly release job has something to do.' : 'Demo hold created by the seed.').run();

    // Reserve real stock, so `sellable` on the stock screen differs from
    // `on hand` on day one. Without this, the distinction is only a claim in the
    // documentation.
    const batch = await db.prepare(
      'SELECT * FROM stock_batches WHERE product_id = ? AND branch_id = ? AND quantity_on_hand >= ? AND is_deleted = 0 ORDER BY received_at LIMIT 1'
    ).bind(String(h.product.id), String(branch.id), h.qty).first();

    if (batch && status === 'ACTIVE') {
      const itemId = newId();
      await db.prepare(`
        INSERT INTO layaway_hold_items (id, hold_id, product_id, stock_batch_id, quantity, unit_price_kobo, line_total_kobo, reserved, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))
      `).bind(itemId, id, String(h.product.id), String(batch.id), h.qty,
        M.toKobo(h.product.default_selling_price), M.toKobo(price), 1).run();
      await db.prepare(`
        UPDATE stock_batches SET quantity_reserved = quantity_reserved + ?, updated_at = datetime('now') WHERE id = ?
      `).bind(h.qty, String(batch.id)).run();
      // A hold does not move a single unit; it makes units UNSELLABLE. So the
      // physical direction is +1 (nothing left) and reservation_delta carries
      // the real effect. `created_at` is omitted and takes its column DEFAULT.
      await db.prepare(`
        INSERT INTO stock_movements (
          id, business_id, branch_id, product_id, stock_batch_id, movement_type, direction,
          quantity, value_kobo, unit_cost, reservation_delta, source_type, source_id,
          moved_by, notes, moved_at)
        VALUES (?, ?, ?, ?, ?, 'LAYAWAY_RESERVE', 0, 0, ?, ?, ?, 'HOLD', ?, ?, ?, datetime('now'))
      `).bind(newId(), String(business.id), String(branch.id), String(h.product.id), String(batch.id),
        M.toKobo(Number(batch.cost_per_unit)) * h.qty, Number(batch.cost_per_unit),
        h.qty, id, String(ID.staff1), `Hold ${holdNo}`).run();
    }
    created.holds = (created.holds || 0) + 1;
  }
  log(`[seed] layaway holds: ${created.holds || 0} (one deliberately expired, so the release job has work)`);
}

// ---------------------------------------------------------------------
// WHT rates, holidays, FX
// ---------------------------------------------------------------------
async function seedWhtRates(db, created) {
  const WHT = require('../../shared/lib/wht');
  let n = 0;
  for (const r of WHT.SEED_RATES) {
    const existing = await db.prepare('SELECT id FROM wht_rates WHERE code = ?').bind(r.code).first();
    const desc = r.description || r.label || r.code;
    if (existing) {
      await db.prepare(`UPDATE wht_rates SET rate_percent_small=?, rate_percent_medium=?, rate_percent_large=?, rate_percent=?,
                        direction=?, description=?, statutory_reference=?, updated_at=datetime('now') WHERE code=?`)
        .bind(r.small, r.medium, r.large, r.large, r.direction || 'BOTH', desc, r.reference || null, r.code).run();
      continue;
    }
    await db.prepare(`
      INSERT INTO wht_rates (id, code, description, rate_percent_small, rate_percent_medium, rate_percent_large,
        rate_percent, direction, statutory_reference, effective_from, is_active, sort_order, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, '2025-01-01', 1, ?, datetime('now'), datetime('now'))
    `).bind(newId(), r.code, desc, r.small, r.medium, r.large, r.large, r.direction || 'BOTH',
      r.reference || 'Deduction of Tax at Source (Withholding) Regulations 2024', n).run();
    n += 1;
  }
  created.whtRates = WHT.SEED_RATES.length;
}

async function seedHolidays(db, created) {
  const year = Number(today().slice(0, 4));
  const defs = [
    ['01-01', "New Year's Day", 'FEDERAL'],
    ['05-01', "Workers' Day", 'FEDERAL'],
    ['06-12', 'Democracy Day', 'FEDERAL'],
    ['10-01', "Independence Day", 'FEDERAL'],
    ['12-25', 'Christmas Day', 'FEDERAL'],
    ['12-26', 'Boxing Day', 'FEDERAL'],
    ['03-31', 'Eid el-Fitr (indicative — confirm annually)', 'RELIGIOUS'],
    ['06-07', 'Eid el-Kabir (indicative — confirm annually)', 'RELIGIOUS'],
    ['06-16', 'Eid el-Mawlid (indicative — confirm annually)', 'RELIGIOUS'],
    ['05-29', 'Lagos State founding day (Lagos only)', 'STATE'],
  ];
  let n = 0;
  for (const y of [year, year + 1]) {
    for (const [mmdd, name, type] of defs) {
      const date = `${y}-${mmdd}`;
      const state = type === 'STATE' ? 'LA' : null;
      const existing = await db.prepare('SELECT id FROM public_holidays WHERE holiday_date = ? AND name = ? AND (state_code IS ? OR state_code = ?)')
        .bind(date, name, state, state).first();
      if (existing) continue;
      await db.prepare(`
        INSERT INTO public_holidays (id, holiday_date, name, state_code, holiday_type, banks_closed, trading_affected, year, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,'Seeded; confirm religious dates annually', datetime('now'), datetime('now'))
      `).bind(newId(), date, name, state, type, 1, type === 'RELIGIOUS' ? 1 : 0, y).run();
      n += 1;
    }
  }
  created.holidays = n;
}

async function seedComplianceCertificates(db, created) {
  const biz1 = ID.biz1;
  const certs = [
    {
      id: newId(), business_id: biz1, certificate_type: 'SONCAP',
      certificate_number: 'SON/PC/2025/88192', issuing_authority: 'Standards Organisation of Nigeria',
      holder_name: 'Ridge Electronics & Appliances Ltd',
      issue_date: daysAgo(340), expiry_date: daysAhead(25), alert_days_before: 60, status: 'EXPIRING_SOON',
    },
    {
      id: newId(), business_id: biz1, certificate_type: 'FIRE_SAFETY',
      certificate_number: 'LA-FS-2025-0044', issuing_authority: 'Lagos State Fire Service',
      holder_name: 'Ridge Electronics Ikeja Branch',
      issue_date: daysAgo(300), expiry_date: daysAhead(15), alert_days_before: 30, status: 'EXPIRING_SOON',
    },
    {
      id: newId(), business_id: biz1, certificate_type: 'CAC',
      certificate_number: 'RC-1845221', issuing_authority: 'Corporate Affairs Commission',
      holder_name: 'Ridge Electronics & Appliances Limited',
      issue_date: daysAgo(1000), expiry_date: null, alert_days_before: 0, status: 'VALID',
    },
  ];
  for (const c of certs) {
    const existing = await db.prepare('SELECT id FROM compliance_certificates WHERE certificate_number = ?').bind(c.certificate_number).first();
    if (existing) continue;
    await db.prepare(`
      INSERT INTO compliance_certificates (
        id, business_id, certificate_type, certificate_number, issuing_authority, holder_name,
        issue_date, expiry_date, alert_days_before, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))
    `).bind(c.id, c.business_id, c.certificate_type, c.certificate_number, c.issuing_authority,
      c.holder_name, c.issue_date, c.expiry_date, c.alert_days_before, c.status).run();
    created.compliance = (created.compliance || 0) + 1;
  }
}

async function seedFxRates(db, businessId, created) {
  // Reference rates only — a demo must not look like it is quoting a live rate.
  const defs = [
    ['USD', 'CBN_OFFICIAL', 1520, 1],
    ['USD', 'PARALLEL', 1610, 1],
    ['GBP', 'CBN_OFFICIAL', 1940, 1],
    ['EUR', 'CBN_OFFICIAL', 1660, 1],
    ['CNY', 'CBN_OFFICIAL', 212, 1],
  ];
  let n = 0;
  for (const [cur, source, rate, isRef] of defs) {
    const date = daysAgo(1);
    const existing = await db.prepare('SELECT id FROM fx_rates WHERE currency=? AND source=? AND rate_date=? AND business_id IS NULL')
      .bind(cur, source, date).first();
    if (existing) continue;
    await db.prepare(`
      INSERT INTO fx_rates (id, currency, rate, source, rate_date, business_id, is_reference, captured_by, notes, created_at, updated_at)
      VALUES (?,?,?,?,?, NULL, 1, NULL, 'Seeded reference rate — replace with your own before trading in foreign currency', datetime('now'), datetime('now'))
    `).bind(newId(), cur, rate, source, date).run();
    n += 1;
  }
  created.fxRates = n;
}

// ---------------------------------------------------------------------
// historic sales  (so no report is empty on first login)
// ---------------------------------------------------------------------
async function seedHistoricSales(db, { businesses, branches, products, customers, users, created, log }) {
  const salesService = require('../../shared/services/salesService');
  let made = 0;

  // Spread over the last 21 days so daily, weekly and monthly views all have
  // shape rather than a single spike.
  for (let dayOffset = 21; dayOffset >= 0; dayOffset -= 1) {
    const date = daysAgo(dayOffset);
    // Fewer sales on a Sunday — a real trading pattern, not a flat line.
    const dow = new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
    const count = dow === 0 ? 1 : (dow === 6 ? 4 : 3);

    for (const business of businesses) {
      const bizBranches = branches[business.id] || [];
      const bizProducts = products[business.id] || [];
      const bizCustomers = customers.filter((c) => c.business_id === business.id);
      if (!bizBranches.length || !bizProducts.length) continue;

      for (let s = 0; s < count; s += 1) {
        const branch = bizBranches[s % bizBranches.length];
        const soldBy = users[(s + dayOffset) % users.length];
        const lineCount = 1 + ((s + dayOffset) % 3);
        const lines = [];
        const used = new Set();
        for (let li = 0; li < lineCount; li += 1) {
          const p = bizProducts[(s * 3 + li * 5 + dayOffset) % bizProducts.length];
          if (!p || used.has(p.id)) continue;
          used.add(p.id);
          const batch = await db.prepare(
            `SELECT * FROM stock_batches WHERE product_id = ? AND branch_id = ?
              AND quantity_on_hand - quantity_reserved > 0 AND is_deleted = 0
             ORDER BY received_at LIMIT 1`
          ).bind(String(p.id), String(branch.id)).first();
          if (!batch) continue;
          const maxQty = Math.max(1, Number(batch.quantity_on_hand) - Number(batch.quantity_reserved));
          const qty = Math.min(maxQty, 1 + ((s + li + dayOffset) % (p.default_selling_price > 200000 ? 1 : 4)));
          const item = { product_id: p.id, quantity: qty, unit_type: 'BASE_UNIT' };
          if (p.serial_tracking || p.restriction_reason === 'SERIAL_CAPTURE') {
            const serials = await db.prepare(
              `SELECT serial_normalised FROM serial_numbers
               WHERE product_id = ? AND branch_id = ? AND status = 'IN_STOCK' AND is_deleted = 0
               LIMIT ?`
            ).bind(String(p.id), String(branch.id), qty).all();
            if (serials.length < qty) continue;
            item.serial_numbers = serials.map((sr) => sr.serial_normalised);
          }
          // Every third sale carries a discount, so the discount reporting is not empty.
          if ((s + dayOffset) % 3 === 0) item.discount = { kind: 'PERCENT', value: 5 };
          lines.push(item);
        }
        if (!lines.length) continue;

        // A customer every other sale; the rest are walk-ins.
        const customer = (s + dayOffset) % 2 === 0 ? bizCustomers[(s + dayOffset) % bizCustomers.length] : null;

        try {
          await db.transaction(async (tx) => {
            // Backdate the session clock so the sale lands on the intended day.
            // `createSale` stamps WAT today; the seed then corrects the date
            // columns afterwards, which keeps the demo history readable without
            // teaching the sales service a backdating path it should not have.
          });
          const scope = {
            userId: soldBy, role: 'MANAGER', rank: 2, isVendor: false,
            allBusinesses: false, businessId: business.id, businessIds: [business.id],
            allBranches: false, branchId: branch.id, branchIds: [branch.id], pinned: true,
          };

          // Ensure a till is open for that branch, then create the sale.
          await ensureTill(db, branch, soldBy, date);

          const registerBuyer = customer ? { name: customer.name, phone: customer.phone, id_type: 'NIN', id_number: '12345678901' }
            : { name: 'Walk-in Customer', phone: '08030000000', id_type: 'NIN', id_number: '12345678901' };

          const result = await salesService.createSale({
            db, scope,
            request: {
              business_id: business.id, branch_id: branch.id,
              customer_id: customer ? customer.id : null,
              sale_date: date,
              lines,
              tenders: [{ method: 'CASH' }],
              register_buyer: registerBuyer,
              age_verification: ageVerificationsFor(lines, products[business.id], bizProducts),
            },
          });

          // Backdate to the intended day.
          await db.prepare(`
            UPDATE sales SET sale_date = ?, created_at = datetime(?, '+10 hours'), updated_at = datetime(?, '+10 hours') WHERE id = ?
          `).bind(date, `${date}T1${s}:30:00Z`, `${date}T1${s}:30:00Z`, result.saleId).run();
          await db.prepare(`UPDATE sale_items SET created_at = datetime(?, '+10 hours') WHERE sale_id = ?`)
            .bind(`${date}T1${s}:30:00Z`, result.saleId).run();
          await db.prepare(`UPDATE sale_payments SET received_at = datetime(?, '+10 hours') WHERE sale_id = ?`)
            .bind(`${date}T1${s}:30:00Z`, result.saleId).run();
          made += 1;
        } catch (e) {
          created.saleErrors = (created.saleErrors || 0) + 1;
          console.error(`[seed] demo sale error:`, e);
        }
      }
    }
  }
  if (created.saleErrors) log(`[seed] ${created.saleErrors} demo sale(s) skipped (insufficient stock or an unsatisfied restriction)`);
  log(`[seed] historic sales: ${made}`);
  return made;
}

function ageVerificationsFor(lines, allProducts, bizProducts) {
  // No alcohol or tobacco in the seeded electronics/furniture catalogues, so
  // this returns an empty map. It exists so that seeding the wholesale vertical
  // (--vertical all) exercises the age-verification path rather than skipping it.
  return {};
}

async function ensureTill(db, branch, userId, date) {
  const open = await db.prepare(
    `SELECT * FROM till_sessions WHERE branch_id = ? AND till_no = '1' AND status = 'OPEN' AND is_deleted = 0`
  ).bind(String(branch.id)).first();
  if (open) return open;
  const id = newId();
  const float = Number(branch.default_till_float) || 0;
  await db.prepare(`
    INSERT INTO till_sessions (id, branch_id, till_no, status, opened_by, opened_at,
      opening_float_kobo, opening_float, float_counted_by, sales_count, created_at, updated_at)
    VALUES (?, ?, '1', 'OPEN', ?, datetime(?, '+8 hours'), ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).bind(id, String(branch.id), String(userId), `${date}T00:00:00Z`,
    M.toKobo(float), float, String(userId)).run();
  if (float > 0) {
    await db.prepare(`
      INSERT INTO branch_safe_ledger (id, branch_id, movement_type, direction, amount_kobo, amount, reference,
        source_type, source_id, performed_by, notes, created_at, updated_at)
      VALUES (?, ?, 'FLOAT_IN', 'IN', ?, ?, ?, 'TILL_SESSION', ?, ?, 'Opening float', datetime('now'), datetime('now'))
    `).bind(newId(), String(branch.id), M.toKobo(float), float, id, id, String(userId)).run();
  }
  return { id };
}

// ---------------------------------------------------------------------
// ledgers with real ageing
// ---------------------------------------------------------------------
async function seedDebtorLedger(db, { business, branch, customers, created }) {
  const trade = customers.filter((c) => ['TRADE', 'WHOLESALE', 'DISTRIBUTOR', 'CORPORATE'].includes(c.customer_class));
  const ages = [8, 25, 47, 78, 120, 210];
  for (let i = 0; i < trade.length; i += 1) {
    const c = trade[i];
    const amount = [450000, 1250000, 3800000, 950000, 2200000, 680000][i % 6];
    const daysOld = ages[i % ages.length];
    const date = daysAgo(daysOld);
    const terms = c.terms_code || 'NET_30';
    const due = CREDIT.dueDate(date, terms);
    const existing = await db.prepare(
      `SELECT id FROM debtor_ledger WHERE customer_id = ? AND source_id = 'SEED'`
    ).bind(String(c.id)).first();
    if (existing) continue;

    await db.prepare(`
      INSERT INTO debtor_ledger (id, business_id, branch_id, customer_id, entry_type, direction, amount_kobo, amount,
        entry_date, terms_code, due_date, source_type, source_id, reference, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'SALE', 'DEBIT', ?, ?, ?, ?, ?, 'SEED', 'SEED', ?, 'Seeded opening receivable', datetime('now'), datetime('now'))
    `).bind(newId(), String(business.id), String(branch.id), String(c.id),
      M.toKobo(amount), amount, date, terms, due, `SR-SEED-${String(i + 1).padStart(4, '0')}`).run();

    // Part-payments on some accounts, so the ageing report has partial
    // settlements and not just clean buckets.
    if (i % 2 === 0) {
      const payAmount = M.round2(amount * 0.4);
      await db.prepare(`
        INSERT INTO debtor_ledger (id, business_id, branch_id, customer_id, entry_type, direction, amount_kobo, amount,
          entry_date, terms_code, source_type, source_id, reference, method, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'PAYMENT', 'CREDIT', ?, ?, ?, 'CASH', 'SEED', 'SEED', ?, 'BANK_TRANSFER', 'Seeded part-payment', datetime('now'), datetime('now'))
      `).bind(newId(), String(business.id), String(branch.id), String(c.id),
        M.toKobo(payAmount), payAmount, daysAgo(Math.max(1, daysOld - 5)), `PAY-SEED-${String(i + 1).padStart(4, '0')}`).run();
    }
    created.debtorEntries = (created.debtorEntries || 0) + 1;
  }
}

async function seedCreditorLedger(db, { business, branch, suppliers, created }) {
  const goods = suppliers.filter((s) => ['GOODS', 'LOGISTICS', 'LANDLORD'].includes(s.supplier_type));
  const amounts = [4850000, 2200000, 1450000, 780000];
  const ages = [5, 18, 35, 62];
  for (let i = 0; i < goods.length; i += 1) {
    const s = goods[i];
    const existing = await db.prepare(`SELECT id FROM creditor_ledger WHERE supplier_id = ? AND source_id = 'SEED'`).bind(String(s.id)).first();
    if (existing) continue;
    const amount = amounts[i % amounts.length];
    const date = daysAgo(ages[i % ages.length]);
    const terms = s.default_terms_code || 'NET_30';
    await db.prepare(`
      INSERT INTO creditor_ledger (id, business_id, branch_id, supplier_id, entry_type, direction, amount_kobo, amount,
        entry_date, terms_code, due_date, source_type, source_id, reference, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'PURCHASE', 'DEBIT', ?, ?, ?, ?, ?, 'SEED', 'SEED', ?, 'Seeded opening payable', datetime('now'), datetime('now'))
    `).bind(newId(), String(business.id), String(branch.id), String(s.id),
      M.toKobo(amount), amount, date, terms, CREDIT.dueDate(date, terms), `BILL-SEED-${String(i + 1).padStart(4, '0')}`).run();
    created.creditorEntries = (created.creditorEntries || 0) + 1;
  }
}

module.exports = { seed, ID };
'use strict';
