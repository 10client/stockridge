// =====================================================================
// StockRidge — BUSINESS PROFILES ("VERTICALS")
// =====================================================================
// THE CENTRAL DECOUPLING.
//
// PharmaRidge hardcoded its industry into the schema: products carried
// nafdac_reg_no, dispensing_type (OTC/POM), is_controlled; the retail
// category CHECK was ('PHARMACEUTICALS','FOOD_DRINKS','ACCESSORIES',
// 'BEAUTY_PERSONAL_CARE','OTHERS'); branches carried pcn_license_no and
// a superintendent pharmacist; and a controlled-substance register was a
// first-class table. Every one of those is a PHARMACY fact, not an
// inventory fact, and every one of them had to be deleted or ignored to
// serve a furniture shop.
//
// StockRidge inverts this. The database stores GENERIC commerce facts
// (a product, a compliance reference, a licence, a regulated-item
// register) and a *profile* — plain data in this file — says which of
// those facts matter, what they are called on screen, which categories
// to offer, and which compliance regime applies.
//
// CONSEQUENCES OF THIS DESIGN
//   * Adding a fifth vertical (e.g. Agro-Inputs, Auto Parts, Fashion)
//     is a new entry in PROFILES below. No migration, no schema change,
//     no new routes. That is the entire extension surface.
//   * A client can MIX profiles: a "General Merchandise" wholesaler who
//     also sells furniture enables both and gets both category trees.
//   * Regulatory features stay real where they are real. Electronics
//     genuinely need SONCAP and serial numbers; furniture genuinely needs
//     delivery and assembly; building materials genuinely need project
//     accounts. None of it is faked for verticals that do not need it —
//     the profile simply does not enable it, and the UI hides it.
//
// Everything in this file is DATA plus pure lookup functions. No Node
// APIs, no imports: it runs verbatim on Cloudflare Workers and on Node.
// =====================================================================

const PROFILES = Object.freeze({
  // -------------------------------------------------------------------
  // ELECTRONICS_APPLIANCES
  // Wholesale/retail of phones, laptops, TVs, fridges, ACs, generators,
  // solar/inverter kit, and small appliances. The defining properties of
  // this trade: HIGH unit value, SERIALISED stock (IMEI/serial per unit),
  // WARRANTY obligations that outlive the sale by months or years,
  // SON/SONCAP import compliance, and heavy instalment selling because
  // ₦450,000 for a refrigerator is not a cash purchase for most buyers.
  // -------------------------------------------------------------------
  ELECTRONICS_APPLIANCES: {
    code: 'ELECTRONICS_APPLIANCES',
    label: 'Electronics, Appliances & Gadgets',
    shortLabel: 'Electronics',
    description:
      'Phones, computers, home appliances, power/solar and consumer electronics — wholesale and retail.',
    brandMark: 'device', // resolved to an inline SVG by public/js/theme.js

    // ---- commerce capabilities -------------------------------------
    capabilities: {
      serialisedStock: true,   // track IMEI/serial number per individual unit
      warrantyTracking: true,  // warranty period per product + claims register
      instalmentPlans: true,   // pay-small-small / Ajo-style plans
      layaway: true,           // deposit now, collect when fully paid
      itemHolds: true,         // short shelf-hold against a customer
      deliveryJobs: true,      // schedule + dispatch delivery
      installationJobs: true,  // AC/fridge/solar installation & commissioning
      tradeIn: true,           // accept old unit as part-payment
      wholesaleTiers: true,    // dealer/reseller price levels
      creditSales: true,       // sell now, collect later (debtor ledger)
      projectAccounts: false,
      batchExpiry: false,      // electronics do not expire
      mixingServices: false,
    },

    // ---- product taxonomy ------------------------------------------
    // Three levels: department -> category -> subcategory. The POS and
    // every report can slice at any level, which is what lets an owner
    // answer "how did Cooling do against Computing this month?".
    categories: Object.freeze([
      { code: 'MOBILE_PHONES', label: 'Mobile Phones', department: 'DEVICES', subcategories: ['Feature Phones', 'Smartphones', 'Refurbished'] },
      { code: 'COMPUTING', label: 'Computing', department: 'DEVICES', subcategories: ['Laptops', 'Desktops', 'Monitors', 'Tablets'] },
      { code: 'COMPUTER_ACCESSORIES', label: 'Computer Accessories', department: 'ACCESSORIES', subcategories: ['Keyboards', 'Mice', 'Storage', 'Cables & Adapters'] },
      { code: 'MOBILE_ACCESSORIES', label: 'Mobile Accessories', department: 'ACCESSORIES', subcategories: ['Chargers', 'Power Banks', 'Earbuds & Headsets', 'Cases & Screen Guards'] },
      { code: 'HOME_APPLIANCES', label: 'Home Appliances', department: 'APPLIANCES', subcategories: ['Refrigerators', 'Freezers', 'Washing Machines', 'Microwaves', 'Gas Cookers'] },
      { code: 'SMALL_APPLIANCES', label: 'Small Appliances', department: 'APPLIANCES', subcategories: ['Blenders', 'Electric Kettles', 'Pressing Irons', 'Air Fryers', 'Rice Cookers'] },
      { code: 'COOLING', label: 'Cooling & Air Conditioning', department: 'APPLIANCES', subcategories: ['Split ACs', 'Window ACs', 'Standing Fans', 'Ceiling Fans', 'AC Accessories'] },
      { code: 'HOME_ENTERTAINMENT', label: 'Home Entertainment', department: 'DEVICES', subcategories: ['Televisions', 'Sound Systems', 'Decoders & Streaming', 'Projectors'] },
      { code: 'POWER_SOLUTIONS', label: 'Power & Solar', department: 'POWER', subcategories: ['Generators', 'Inverters', 'Solar Panels', 'Batteries', 'Charge Controllers', 'Stabilizers & UPS'] },
      { code: 'GAMING', label: 'Gaming', department: 'DEVICES', subcategories: ['Consoles', 'Controllers', 'Games & Media'] },
      { code: 'NETWORKING', label: 'Networking & Security', department: 'DEVICES', subcategories: ['Routers & Switches', 'Wi-Fi Extenders', 'CCTV & DVR', 'Access Control'] },
      { code: 'SPARE_PARTS', label: 'Spare Parts & Service', department: 'SERVICE', subcategories: ['Screens', 'Batteries (device)', 'Compressors', 'Boards & Modules'] },
      { code: 'OTHERS', label: 'Others', department: 'OTHER', subcategories: [] },
    ]),

    // ---- units of measure ------------------------------------------
    // `receive` = how stock ARRIVES from the supplier; `sell` = how it
    // leaves across the counter. They are deliberately decoupled (you buy
    // chargers by the carton and sell them by the piece). PALLET is added
    // over PharmaRidge's three units because container-load electronics
    // imports are received by the pallet.
    units: Object.freeze({
      receive: ['PALLET', 'CARTON', 'PACK', 'PIECE'],
      sell: ['CARTON', 'PACK', 'PIECE'],
      baseUnitChoices: ['piece', 'unit', 'set', 'pair', 'box'],
    }),

    // ---- compliance / regulatory ------------------------------------
    // Nigeria's Standards Organisation of Nigeria Conformity Assessment
    // Programme (SONCAP) governs imported regulated products — most
    // electronics and appliances are on the SON mandatory-conformity list.
    // We store the reference and, crucially, surface an ALERT view when a
    // product with no SON/SONCAP record is sold in quantity, so an
    // importer cannot accidentally retail an unregistered consignment.
    compliance: Object.freeze({
      regime: 'SON_SONCAP',
      label: 'SON / SONCAP',
      productReferenceField: 'compliance_ref_no',
      productReferenceLabel: 'SONCAP / SON Cert. No.',
      entityRegistrationLabel: 'CAC Registration No.',
      entityRegistrationField: 'cac_reg_no',
      requiresSerialNumbers: true,
      serialNumberLabel: 'Serial No. / IMEI',
      // Which categories are on the mandatory-conformity list. Used only
      // to warn, never to block — the app cannot know a specific SKU's
      // regulatory status better than the importer does.
      regulatedCategories: Object.freeze([
        'MOBILE_PHONES', 'COMPUTING', 'HOME_APPLIANCES', 'SMALL_APPLIANCES',
        'COOLING', 'HOME_ENTERTAINMENT', 'POWER_SOLUTIONS',
      ]),
    }),

    // ---- warranty ---------------------------------------------------
    warranty: Object.freeze({
      enabled: true,
      defaultMonths: 12,
      choices: [0, 3, 6, 12, 18, 24, 36, 48, 60],
      // Manufacturer warranty is honoured by the brand's service centre;
      // shop warranty is honoured by the retailer out of its own margin.
      // The two have completely different cost consequences and must be
      // recorded separately, or the P&L cannot tell who paid for a repair.
      types: Object.freeze(['MANUFACTURER', 'SHOP', 'BOTH', 'NONE']),
      claimOutcomes: Object.freeze(['REPAIRED', 'REPLACED', 'REFUNDED', 'REJECTED', 'SCRAPPED', 'RETURNED_TO_SUPPLIER']),
    }),

    // ---- pricing / selling ------------------------------------------
    pricing: Object.freeze({
      customerTiers: Object.freeze([
        { code: 'RETAIL', label: 'Retail (walk-in)', defaultDiscountPercent: 0 },
        { code: 'WHOLESALE', label: 'Wholesale', defaultDiscountPercent: 5 },
        { code: 'DEALER', label: 'Dealer / Reseller', defaultDiscountPercent: 10 },
        { code: 'CORPORATE', label: 'Corporate / Contract', defaultDiscountPercent: 7 },
        { code: 'STAFF', label: 'Staff purchase', defaultDiscountPercent: 12 },
      ]),
      // Minimum quantities that unlock the wholesale price. Nigerian
      // electronics wholesalers price by the carton, not by a vague
      // "bulk" notion, so the tier is expressed as a piece count.
      wholesaleMinQty: 5,
      cartonMinQty: 1,
      allowNegativeStock: false,
      allowOpenPrice: true,   // manager may override the shelf price
    }),

    // ---- payments ----------------------------------------------------
    paymentMethods: Object.freeze(['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'USSD', 'MOBILE_MONEY', 'CHEQUE', 'CREDIT', 'INSTALMENT', 'LAYAWAY', 'TRADE_IN']),

    // ---- delivery / installation -------------------------------------
    fulfilment: Object.freeze({
      deliveryEnabled: true,
      installationEnabled: true,
      deliveryFeeModel: 'ZONE_FLAT', // flat fee per delivery zone
      jobStatuses: Object.freeze(['PENDING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'INSTALLED', 'FAILED', 'CANCELLED']),
    }),

    // ---- document templates ------------------------------------------
    documents: Object.freeze({
      receipt: true,
      invoice: true,
      warrantyCard: true,
      goodsReceivedNote: true,
      deliveryNote: true,
      proformaInvoice: true,
    }),
  },

  // -------------------------------------------------------------------
  // FURNITURE_HOME
  // Showroom + workshop furniture retail. Defining properties: very high
  // unit value, NO serial numbers but often a made-to-order component,
  // delivery and assembly are the product as much as the item, fabrics
  // and finishes are per-item attributes, and long sales cycles where a
  // customer reserves a sofa and pays over weeks.
  // -------------------------------------------------------------------
  FURNITURE_HOME: {
    code: 'FURNITURE_HOME',
    label: 'Furniture & Home Furnishings',
    shortLabel: 'Furniture',
    description: 'Showroom and workshop furniture, mattresses, fittings and home décor.',

    capabilities: {
      serialisedStock: false,
      warrantyTracking: true,
      instalmentPlans: true,
      layaway: true,
      itemHolds: true,        // essential: a showroom has ONE 7-seater
      deliveryJobs: true,
      installationJobs: true, // assembly on site
      tradeIn: false,
      wholesaleTiers: true,   // hotels, estates, offices buy in volume
      creditSales: true,
      projectAccounts: true,  // a hotel fit-out is a project, not a sale
      batchExpiry: false,
      madeToOrder: true,      // bespoke production against a deposit
      mixingServices: false,
    },

    categories: Object.freeze([
      { code: 'LIVING_ROOM', label: 'Living Room', department: 'FURNITURE', subcategories: ['Sofas & Sectionals', 'Coffee & Centre Tables', 'TV Consoles', 'Recliners', 'Shelves & Bookcases'] },
      { code: 'BEDROOM', label: 'Bedroom', department: 'FURNITURE', subcategories: ['Beds & Frames', 'Wardrobes', 'Dressing Tables', 'Bedside Tables', 'Chests of Drawers'] },
      { code: 'DINING', label: 'Dining', department: 'FURNITURE', subcategories: ['Dining Sets', 'Dining Tables', 'Dining Chairs', 'Bar Stools', 'Sideboards & Buffets'] },
      { code: 'OFFICE', label: 'Office', department: 'FURNITURE', subcategories: ['Executive Desks', 'Workstations', 'Office Chairs', 'Filing Cabinets', 'Conference Tables'] },
      { code: 'OUTDOOR', label: 'Outdoor & Garden', department: 'FURNITURE', subcategories: ['Garden Sets', 'Parasols', 'Outdoor Loungers', 'Swings & Hammocks'] },
      { code: 'MATTRESSES_BEDDING', label: 'Mattresses & Bedding', department: 'SOFT_FURNISHINGS', subcategories: ['Mattresses', 'Pillows', 'Duvets & Comforters', 'Bedsheets & Covers', 'Mosquito Nets'] },
      { code: 'CURTAINS_BLINDS', label: 'Curtains, Blinds & Rugs', department: 'SOFT_FURNISHINGS', subcategories: ['Curtains', 'Blinds', 'Rugs & Carpets', 'Cushions'] },
      { code: 'KITCHENWARE', label: 'Kitchenware & Tableware', department: 'HOUSEWARES', subcategories: ['Cookware', 'Dinnerware', 'Cutlery', 'Storage Containers', 'Glassware'] },
      { code: 'HOME_DECOR', label: 'Home Décor', department: 'HOUSEWARES', subcategories: ['Wall Art', 'Mirrors', 'Vases', 'Lighting & Lamps', 'Clocks'] },
      { code: 'FITTINGS_HARDWARE', label: 'Fittings & Hardware', department: 'HOUSEWARES', subcategories: ['Door Handles', 'Hinges & Rails', 'Cabinet Fittings', 'Locks'] },
      { code: 'UPHOLSTERY_MATERIALS', label: 'Upholstery & Workshop Materials', department: 'WORKSHOP', subcategories: ['Fabrics', 'Foam', 'Leather & Vinyl', 'Timber & Board', 'Adhesives & Finishes'] },
      { code: 'MADE_TO_ORDER', label: 'Made to Order', department: 'WORKSHOP', subcategories: ['Bespoke Furniture', 'Custom Upholstery', 'Curtain Making'] },
      { code: 'OTHERS', label: 'Others', department: 'OTHER', subcategories: [] },
    ]),

    units: Object.freeze({
      receive: ['PALLET', 'CARTON', 'PACK', 'PIECE'],
      sell: ['SET', 'CARTON', 'PACK', 'PIECE'],
      baseUnitChoices: ['piece', 'set', 'pair', 'metre', 'roll', 'box'],
    }),

    compliance: Object.freeze({
      regime: 'CAC_GENERAL',
      label: 'CAC (general trading)',
      productReferenceField: 'compliance_ref_no',
      productReferenceLabel: 'Supplier / Model Ref.',
      entityRegistrationLabel: 'CAC Registration No.',
      entityRegistrationField: 'cac_reg_no',
      requiresSerialNumbers: false,
      serialNumberLabel: 'Tag / Item No.',
      regulatedCategories: Object.freeze([]),
    }),

    warranty: Object.freeze({
      enabled: true,
      defaultMonths: 12,
      choices: [0, 3, 6, 12, 24, 36, 60, 120], // structural frames often carry 10 years
      types: Object.freeze(['MANUFACTURER', 'SHOP', 'BOTH', 'NONE']),
      claimOutcomes: Object.freeze(['REPAIRED', 'REPLACED', 'REFUNDED', 'REJECTED', 'SCRAPPED', 'RETURNED_TO_SUPPLIER']),
    }),

    pricing: Object.freeze({
      customerTiers: Object.freeze([
        { code: 'RETAIL', label: 'Retail (walk-in)', defaultDiscountPercent: 0 },
        { code: 'WHOLESALE', label: 'Wholesale / Bulk', defaultDiscountPercent: 6 },
        { code: 'PROJECT', label: 'Project (hotel, estate, office)', defaultDiscountPercent: 10 },
        { code: 'CORPORATE', label: 'Corporate', defaultDiscountPercent: 7 },
        { code: 'STAFF', label: 'Staff purchase', defaultDiscountPercent: 15 },
      ]),
      wholesaleMinQty: 4,
      cartonMinQty: 1,
      allowNegativeStock: false,
      allowOpenPrice: true,
    }),

    paymentMethods: Object.freeze(['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'USSD', 'MOBILE_MONEY', 'CHEQUE', 'CREDIT', 'INSTALMENT', 'LAYAWAY']),

    fulfilment: Object.freeze({
      deliveryEnabled: true,
      installationEnabled: true,
      deliveryFeeModel: 'ZONE_FLAT',
      jobStatuses: Object.freeze(['PENDING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'INSTALLED', 'FAILED', 'CANCELLED']),
    }),

    documents: Object.freeze({
      receipt: true,
      invoice: true,
      warrantyCard: true,
      goodsReceivedNote: true,
      deliveryNote: true,
      proformaInvoice: true,
      madeToOrderAgreement: true,
    }),
  },

  // -------------------------------------------------------------------
  // GENERAL_MERCHANDISE
  // The supermarket / provision / general wholesale-and-retail store:
  // food, drinks, provisions, toiletries, household goods, stationery.
  // Defining properties: LOW unit value, VERY high line count, EXPIRY
  // DATES matter (this is where PharmaRidge's batch-expiry logic lives),
  // carton/pack breaking is the core mechanic, and shrinkage control at
  // the till is the whole ballgame.
  // -------------------------------------------------------------------
  GENERAL_MERCHANDISE: {
    code: 'GENERAL_MERCHANDISE',
    label: 'General Merchandise (Wholesale & Retail)',
    shortLabel: 'Merchandise',
    description: 'Provisions, food & drinks, household goods, toiletries and general trading stock.',

    capabilities: {
      serialisedStock: false,
      warrantyTracking: false,
      instalmentPlans: false,
      layaway: true,
      itemHolds: true,
      deliveryJobs: true,
      installationJobs: false,
      tradeIn: false,
      wholesaleTiers: true,
      creditSales: true,
      projectAccounts: false,
      batchExpiry: true,       // <-- the pharmacy-derived strength, reused
      expiryAlerts: true,
      mixingServices: false,
    },

    categories: Object.freeze([
      { code: 'FOODSTUFFS', label: 'Foodstuffs & Grains', department: 'FOOD', subcategories: ['Rice', 'Beans', 'Garri', 'Yam Flour', 'Semovita & Wheat', 'Spices & Seasonings'] },
      { code: 'BEVERAGES', label: 'Beverages', department: 'FOOD', subcategories: ['Soft Drinks', 'Juices', 'Water', 'Malt & Energy Drinks', 'Tea & Coffee'] },
      { code: 'PROVISIONS', label: 'Provisions & Snacks', department: 'FOOD', subcategories: ['Biscuits & Confectionery', 'Canned & Packaged Foods', 'Noodles & Pasta', 'Breakfast Cereals', 'Dairy'] },
      { code: 'CONDIMENTS_OILS', label: 'Condiments, Oils & Sauces', department: 'FOOD', subcategories: ['Vegetable & Groundnut Oil', 'Tomato Paste & Sauces', 'Vinegar & Mayo', 'Sugar & Salt'] },
      { code: 'HOUSEHOLD', label: 'Household & Cleaning', department: 'HOUSEHOLD', subcategories: ['Detergents', 'Soaps & Cleaners', 'Air Fresheners', 'Insecticides', 'Brushes & Mops'] },
      { code: 'TOILETRIES', label: 'Toiletries & Personal Care', department: 'HOUSEHOLD', subcategories: ['Bath Soaps', 'Creams & Lotions', 'Oral Care', 'Hair Care', 'Sanitary & Diapers'] },
      { code: 'KITCHEN_UTENSILS', label: 'Kitchen & Plastic Wares', department: 'HOUSEWARES', subcategories: ['Plastic Containers', 'Aluminium & Enamel Wares', 'Cutlery', 'Flasks & Coolers'] },
      { code: 'STATIONERY', label: 'Stationery & Office Supplies', department: 'OTHER', subcategories: ['Paper & Notebooks', 'Pens & Writing', 'Files & Folders', 'Printing Supplies'] },
      { code: 'ELECTRICALS', label: 'Electricals & Bulbs', department: 'OTHER', subcategories: ['Bulbs & Tubes', 'Extension Boxes', 'Batteries', 'Tape & Wire'] },
      { code: 'TEXTILES', label: 'Textiles & Apparel Basics', department: 'OTHER', subcategories: ['Fabrics', 'Ready-to-wear', 'Footwear', 'Bags'] },
      { code: 'OTHERS', label: 'Others', department: 'OTHER', subcategories: [] },
    ]),

    units: Object.freeze({
      receive: ['PALLET', 'CARTON', 'BAG', 'PACK', 'PIECE'],
      sell: ['CARTON', 'BAG', 'PACK', 'PIECE'],
      baseUnitChoices: ['piece', 'sachet', 'pack', 'bottle', 'tin', 'kg', 'bag', 'roll'],
    }),

    compliance: Object.freeze({
      regime: 'NAFDAC_OPTIONAL',
      label: 'NAFDAC (food & consumables)',
      productReferenceField: 'compliance_ref_no',
      productReferenceLabel: 'NAFDAC Reg. No.',
      entityRegistrationLabel: 'CAC Registration No.',
      entityRegistrationField: 'cac_reg_no',
      requiresSerialNumbers: false,
      serialNumberLabel: 'Batch No.',
      // NAFDAC registration is genuinely required for packaged food and
      // consumables sold in Nigeria, so we keep the field and the alert
      // view — but as an OPTIONAL reference rather than the mandatory,
      // catalogued regime PharmaRidge ran against its 6,801-row Greenbook.
      regulatedCategories: Object.freeze(['FOODSTUFFS', 'BEVERAGES', 'PROVISIONS', 'CONDIMENTS_OILS', 'TOILETRIES']),
    }),

    warranty: Object.freeze({ enabled: false, defaultMonths: 0, choices: [0], types: Object.freeze(['NONE']), claimOutcomes: Object.freeze([]) }),

    pricing: Object.freeze({
      customerTiers: Object.freeze([
        { code: 'RETAIL', label: 'Retail (walk-in)', defaultDiscountPercent: 0 },
        { code: 'WHOLESALE', label: 'Wholesale (carton+)', defaultDiscountPercent: 4 },
        { code: 'DEALER', label: 'Sub-dealer / Kiosk', defaultDiscountPercent: 8 },
        { code: 'CORPORATE', label: 'Corporate / Institution', defaultDiscountPercent: 5 },
        { code: 'STAFF', label: 'Staff purchase', defaultDiscountPercent: 10 },
      ]),
      wholesaleMinQty: 1,      // a carton IS the wholesale unit here
      cartonMinQty: 1,
      allowNegativeStock: false,
      allowOpenPrice: false,   // shelf price discipline matters at low margin
    }),

    paymentMethods: Object.freeze(['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'USSD', 'MOBILE_MONEY', 'CHEQUE', 'CREDIT', 'LAYAWAY']),

    fulfilment: Object.freeze({
      deliveryEnabled: true,
      installationEnabled: false,
      deliveryFeeModel: 'ZONE_FLAT',
      jobStatuses: Object.freeze(['PENDING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED']),
    }),

    documents: Object.freeze({
      receipt: true,
      invoice: true,
      goodsReceivedNote: true,
      deliveryNote: true,
      proformaInvoice: true,
    }),
  },

  // -------------------------------------------------------------------
  // BUILDING_MATERIALS
  // Cement, iron rods, roofing sheets, paints, tiles, plumbing and
  // electrical materials. Defining properties: sold by WEIGHT/LENGTH/COUNT
  // as well as by piece, priced against a volatile commodity market,
  // dominated by PROJECT and CONTRACT customers rather than walk-ins,
  // delivered by truck to a site, and heavily credit-driven.
  // -------------------------------------------------------------------
  BUILDING_MATERIALS: {
    code: 'BUILDING_MATERIALS',
    label: 'Building Materials & Hardware',
    shortLabel: 'Building Materials',
    description: 'Cement, steel, roofing, paints, plumbing, electrical and general hardware.',

    capabilities: {
      serialisedStock: false,
      warrantyTracking: false,
      instalmentPlans: true,   // contractors pay against milestones
      layaway: true,           // reserve a consignment of rods
      itemHolds: true,
      deliveryJobs: true,      // truck delivery to site is the norm
      installationJobs: false,
      tradeIn: false,
      wholesaleTiers: true,
      creditSales: true,
      projectAccounts: true,   // a building site is the real customer
      batchExpiry: true,       // cement and paint DO have shelf lives
      expiryAlerts: true,
      weighingStock: true,     // iron rods / sand sold by weight
      mixingServices: false,
    },

    categories: Object.freeze([
      { code: 'CEMENT_BINDERS', label: 'Cement & Binders', department: 'STRUCTURAL', subcategories: ['Cement', 'Plaster of Paris', 'Lime', 'Adhesives & Tile Glue'] },
      { code: 'STEEL_REINFORCEMENT', label: 'Steel & Reinforcement', department: 'STRUCTURAL', subcategories: ['Iron Rods', 'Binding Wire', 'Steel Mesh', 'Nails & Screws'] },
      { code: 'ROOFING', label: 'Roofing', department: 'STRUCTURAL', subcategories: ['Aluminium Sheets', 'Long-span & Step-tiles', 'Roofing Nails', 'Wood & Rafters', 'Ceiling Boards'] },
      { code: 'BLOCKS_STONES', label: 'Blocks, Stones & Aggregates', department: 'STRUCTURAL', subcategories: ['Vibrated Blocks', 'Hollow Blocks', 'Granite & Gravel', 'Sharp Sand', 'Laterite'] },
      { code: 'PAINTS_FINISHES', label: 'Paints & Finishes', department: 'FINISHES', subcategories: ['Emulsion', 'Gloss & Oil Paint', 'Textured & Screed', 'Thinner & Primers', 'Paint Tools'] },
      { code: 'TILES_FLOORING', label: 'Tiles & Flooring', department: 'FINISHES', subcategories: ['Floor Tiles', 'Wall Tiles', 'Ceiling Panels', 'Vinyl & Carpet'] },
      { code: 'PLUMBING', label: 'Plumbing & Sanitary', department: 'SERVICES', subcategories: ['Pipes & Fittings', 'Water Closets', 'Sinks & Basins', 'Taps & Showers', 'Tanks & Pumps'] },
      { code: 'ELECTRICAL_MATERIALS', label: 'Electrical Materials', department: 'SERVICES', subcategories: ['Cables & Wires', 'Switches & Sockets', 'Distribution Boards', 'Conduits & Accessories', 'Lighting Fittings'] },
      { code: 'DOORS_WINDOWS', label: 'Doors, Windows & Glass', department: 'FINISHES', subcategories: ['Doors', 'Window Frames', 'Glass & Mirrors', 'Handles & Locks'] },
      { code: 'TOOLS', label: 'Tools & Equipment', department: 'HARDWARE', subcategories: ['Hand Tools', 'Power Tools', 'Measuring Tools', 'Safety Gear'] },
      { code: 'HARDWARE_FASTENERS', label: 'Hardware & Fasteners', department: 'HARDWARE', subcategories: ['Bolts & Nuts', 'Hinges', 'Chains', 'Anchors & Plugs'] },
      { code: 'OTHERS', label: 'Others', department: 'OTHER', subcategories: [] },
    ]),

    units: Object.freeze({
      receive: ['TRUCKLOAD', 'PALLET', 'BAG', 'BUNDLE', 'CARTON', 'PIECE'],
      sell: ['BAG', 'BUNDLE', 'LENGTH', 'TONNE', 'CARTON', 'PIECE'],
      baseUnitChoices: ['piece', 'bag', 'length', 'tonne', 'kg', 'metre', 'bundle', 'litre', 'gallon', 'sheet'],
    }),

    compliance: Object.freeze({
      regime: 'SON_SONCAP',
      label: 'SON / SONCAP',
      productReferenceField: 'compliance_ref_no',
      productReferenceLabel: 'SON / SONCAP Cert. No.',
      entityRegistrationLabel: 'CAC Registration No.',
      entityRegistrationField: 'cac_reg_no',
      requiresSerialNumbers: false,
      serialNumberLabel: 'Batch / Heat No.',
      // Cement, steel and cables are all on SON's mandatory list — this is
      // a real, enforced regime for this vertical.
      regulatedCategories: Object.freeze(['CEMENT_BINDERS', 'STEEL_REINFORCEMENT', 'ROOFING', 'ELECTRICAL_MATERIALS', 'PLUMBING']),
    }),

    warranty: Object.freeze({ enabled: false, defaultMonths: 0, choices: [0], types: Object.freeze(['NONE']), claimOutcomes: Object.freeze([]) }),

    pricing: Object.freeze({
      customerTiers: Object.freeze([
        { code: 'RETAIL', label: 'Retail (walk-in)', defaultDiscountPercent: 0 },
        { code: 'WHOLESALE', label: 'Wholesale', defaultDiscountPercent: 4 },
        { code: 'CONTRACTOR', label: 'Contractor', defaultDiscountPercent: 7 },
        { code: 'PROJECT', label: 'Project / Site account', defaultDiscountPercent: 9 },
        { code: 'STAFF', label: 'Staff purchase', defaultDiscountPercent: 10 },
      ]),
      wholesaleMinQty: 10,
      cartonMinQty: 1,
      allowNegativeStock: true,  // a truck leaves before the weighbridge ticket is keyed
      allowOpenPrice: true,      // commodity prices move daily
    }),

    paymentMethods: Object.freeze(['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'USSD', 'MOBILE_MONEY', 'CHEQUE', 'CREDIT', 'INSTALMENT', 'LAYAWAY']),

    fulfilment: Object.freeze({
      deliveryEnabled: true,
      installationEnabled: false,
      deliveryFeeModel: 'TRIP_DISTANCE', // truck trip, priced by distance/load
      jobStatuses: Object.freeze(['PENDING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'CANCELLED']),
    }),

    documents: Object.freeze({
      receipt: true,
      invoice: true,
      goodsReceivedNote: true,
      deliveryNote: true,
      proformaInvoice: true,
      waybill: true,
    }),
  },
});

const PROFILE_CODES = Object.freeze(Object.keys(PROFILES));

// The profile a brand-new deployment starts with when the owner has not
// chosen yet. General Merchandise is the widest and least opinionated, so
// nothing is hidden from a first-time user by accident.
const DEFAULT_PROFILE = 'GENERAL_MERCHANDISE';

function isProfile(code) {
  return Object.prototype.hasOwnProperty.call(PROFILES, code);
}

function getProfile(code) {
  return PROFILES[code] || PROFILES[DEFAULT_PROFILE];
}

function profileLabel(code) {
  return getProfile(code).label;
}

// A client may enable SEVERAL profiles (a general merchant who also runs a
// furniture showroom). These helpers keep that union well-defined: the
// category tree is the union of enabled profiles' categories with
// duplicates collapsed, and a capability is ON if ANY enabled profile
// turns it on. Union-not-intersection is deliberate — hiding a feature a
// client paid for because one of their three verticals does not use it is
// the wrong failure mode.
function mergeProfiles(codes) {
  const list = (Array.isArray(codes) && codes.length ? codes : [DEFAULT_PROFILE])
    .filter(isProfile)
    .map((c) => PROFILES[c]);
  if (!list.length) list.push(PROFILES[DEFAULT_PROFILE]);

  const primary = list[0];

  const capabilities = {};
  for (const p of list) {
    for (const [k, v] of Object.entries(p.capabilities || {})) {
      capabilities[k] = capabilities[k] || Boolean(v);
    }
  }

  const seen = new Set();
  const categories = [];
  for (const p of list) {
    for (const cat of p.categories) {
      if (seen.has(cat.code)) continue;
      seen.add(cat.code);
      categories.push({ ...cat, fromProfile: p.code });
    }
  }

  const unitSets = { receive: new Set(), sell: new Set(), baseUnitChoices: new Set() };
  for (const p of list) {
    p.units.receive.forEach((u) => unitSets.receive.add(u));
    p.units.sell.forEach((u) => unitSets.sell.add(u));
    p.units.baseUnitChoices.forEach((u) => unitSets.baseUnitChoices.add(u));
  }

  const tierSeen = new Set();
  const customerTiers = [];
  for (const p of list) {
    for (const t of p.pricing.customerTiers) {
      if (tierSeen.has(t.code)) continue;
      tierSeen.add(t.code);
      customerTiers.push(t);
    }
  }

  const methods = new Set();
  for (const p of list) p.paymentMethods.forEach((m) => methods.add(m));

  const docs = {};
  for (const p of list) Object.assign(docs, p.documents);

  return {
    code: primary.code,
    label: list.length === 1 ? primary.label : `${primary.shortLabel} + ${list.length - 1} more`,
    profiles: list.map((p) => p.code),
    capabilities,
    categories,
    units: {
      receive: [...unitSets.receive],
      sell: [...unitSets.sell],
      baseUnitChoices: [...unitSets.baseUnitChoices],
    },
    customerTiers,
    paymentMethods: [...methods],
    documents: docs,
    compliance: primary.compliance,
    warranty: primary.warranty,
    fulfilment: primary.fulfilment,
    pricing: primary.pricing,
    brandMark: primary.brandMark || 'store',
  };
}

function categoryLabel(codes, code) {
  const merged = mergeProfiles(codes);
  const found = merged.categories.find((c) => c.code === code);
  return found ? found.label : code || 'Others';
}

function isCategory(codes, code) {
  return mergeProfiles(codes).categories.some((c) => c.code === code);
}

function departmentOf(codes, code) {
  const found = mergeProfiles(codes).categories.find((c) => c.code === code);
  return found ? found.department : 'OTHER';
}

function subcategoriesOf(codes, code) {
  const found = mergeProfiles(codes).categories.find((c) => c.code === code);
  return found ? found.subcategories : [];
}

module.exports = {
  PROFILES,
  PROFILE_CODES,
  DEFAULT_PROFILE,
  isProfile,
  getProfile,
  profileLabel,
  mergeProfiles,
  categoryLabel,
  isCategory,
  departmentOf,
  subcategoriesOf,
};
