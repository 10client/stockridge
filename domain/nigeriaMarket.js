'use strict';
// =====================================================================
// domain/nigeriaMarket.js — GOODS THE NIGERIAN MARKET ACTUALLY SELLS
// =====================================================================
// An inbuilt list, not a price list, and not a pharmacy. A shop in Wuse,
// Onitsha, Kano, Aba, Dei-Dei or Computer Village already knows these
// names. What it does not want from a piece of software is a guessed
// naira figure, a serial number it did not ask for, or a drug list.
//
// Medicines are not on this list. A chemist is a different trade. The
// rows here are the goods the other businesses sell: provisions, the
// fresh market, hair and beauty, phones and computers, building
// materials, furniture, motor and motorcycle parts, books, tailoring,
// and the nylon and packaging every one of those shops buys.
//
// Every row has a name, a brand, a category and a unit, and nothing
// else that looks like money. Serial numbers are off. The shop turns a
// serial on, by hand, on the product it adds — and that choice is what
// the till asks for.
//
// The list is built once, in a fixed order, so a SKU means the same
// good on every deployment. It is not inserted into a business until
// somebody adds it. A till that searched two thousand unpriced rows
// would sell them at nothing.
// =====================================================================

const CATEGORIES = Object.freeze([
  { code: 'NG_RICE', name: 'Rice' },
  { code: 'NG_GRAINS', name: 'Grains, flour and swallow' },
  { code: 'NG_OIL', name: 'Oil, seasoning and spices' },
  { code: 'NG_PACKED', name: 'Packaged food' },
  { code: 'NG_NOODLES', name: 'Noodles and pasta' },
  { code: 'NG_DRINKS', name: 'Drinks' },
  { code: 'NG_DAIRY', name: 'Milk, tea and beverages' },
  { code: 'NG_SNACKS', name: 'Snacks and biscuits' },
  { code: 'NG_FROZEN', name: 'Frozen food' },
  { code: 'NG_TOILET', name: 'Toiletries' },
  { code: 'NG_CLEAN', name: 'Detergent and cleaning' },
  { code: 'NG_BABY', name: 'Baby care' },
  { code: 'NG_HOME', name: 'Household and plastics' },
  { code: 'NG_PHONE', name: 'Phones' },
  { code: 'NG_ACCESSORY', name: 'Phone and computer accessories' },
  { code: 'NG_APPLIANCE', name: 'Home and kitchen appliances' },
  { code: 'NG_POWER', name: 'Generators, inverters and solar' },
  { code: 'NG_LIGHT', name: 'Lighting and electricals' },
  { code: 'NG_CEMENT', name: 'Cement, blocks and aggregates' },
  { code: 'NG_STEEL', name: 'Steel, roofing and nails' },
  { code: 'NG_PAINT', name: 'Paint' },
  { code: 'NG_PLUMB', name: 'Plumbing and sanitary' },
  { code: 'NG_TILE', name: 'Tiles and finishing' },
  { code: 'NG_TOOLS', name: 'Tools and hardware' },
  { code: 'NG_FURNITURE', name: 'Furniture' },
  { code: 'NG_FABRIC', name: 'Fabrics' },
  { code: 'NG_CLOTH', name: 'Clothing and footwear' },
  { code: 'NG_STATIONERY', name: 'Stationery' },
  { code: 'NG_MOTOR', name: 'Motor parts and lubricants' },
  { code: 'NG_AGRO', name: 'Agro inputs' },
  { code: 'NG_GAS', name: 'Gas and cooking fuel' },
  { code: 'NG_FRESH', name: 'Fresh market' },
  { code: 'NG_HAIR', name: 'Hair, wigs and salon' },
  { code: 'NG_BEAUTY', name: 'Makeup and fragrance' },
  { code: 'NG_HYGIENE', name: 'First aid and hygiene' },
  { code: 'NG_COMPUTER', name: 'Computers, printers and POS' },
  { code: 'NG_MOTO', name: 'Motorcycles, tricycles and bicycles' },
  { code: 'NG_TIMBER', name: 'Timber, boards and plywood' },
  { code: 'NG_ALUMINIUM', name: 'Aluminium, glass and windows' },
  { code: 'NG_WELD', name: 'Welding and fabrication' },
  { code: 'NG_BAKERY', name: 'Bakery and confectionery supplies' },
  { code: 'NG_NYLON', name: 'Nylon, packaging and takeaway' },
  { code: 'NG_JEWELLERY', name: 'Watches, beads and jewellery' },
  { code: 'NG_BOOKS', name: 'Books and school' },
  { code: 'NG_SPORT', name: 'Sports goods' },
  { code: 'NG_WORSHIP', name: 'Religious goods' },
  { code: 'NG_WATER', name: 'Water storage and pumps' },
  { code: 'NG_POULTRY', name: 'Poultry and livestock equipment' },
  { code: 'NG_FISHING', name: 'Fishing gear' },
  { code: 'NG_EVENT', name: 'Party and event supplies' },
  { code: 'NG_SEWING', name: 'Sewing and tailoring' },
  { code: 'NG_ELECTRICAL', name: 'Cables, switches and fittings' },
  { code: 'NG_SECURITY', name: 'CCTV and security' },
  { code: 'NG_SCALE', name: 'Scales and shop machines' },
  { code: 'NG_TOY', name: 'Toys' },
  { code: 'NG_LEATHER', name: 'Aba and Kano leather goods' },
]);

const CATEGORY_BY_CODE = Object.freeze(Object.fromEntries(CATEGORIES.map((c) => [c.code, c])));

const UNITS = Object.freeze({
  piece: { code: 'PIECE', name: 'Piece', plural: 'Pieces' },
  bag: { code: 'BAG', name: 'Bag', plural: 'Bags' },
  carton: { code: 'CARTON', name: 'Carton', plural: 'Cartons' },
  bottle: { code: 'BOTTLE', name: 'Bottle', plural: 'Bottles' },
  sachet: { code: 'SACHET', name: 'Sachet', plural: 'Sachets' },
  litre: { code: 'LITRE', name: 'Litre', plural: 'Litres' },
  metre: { code: 'METRE', name: 'Metre', plural: 'Metres' },
  kilogram: { code: 'KILOGRAM', name: 'Kilogram', plural: 'Kilograms' },
  yard: { code: 'YARD', name: 'Yard', plural: 'Yards' },
  pair: { code: 'PAIR', name: 'Pair', plural: 'Pairs' },
  roll: { code: 'ROLL', name: 'Roll', plural: 'Rolls' },
  tin: { code: 'TIN', name: 'Tin', plural: 'Tins' },
  pack: { code: 'PACK', name: 'Pack', plural: 'Packs' },
  crate: { code: 'CRATE', name: 'Crate', plural: 'Crates' },
  trip: { code: 'TRIP', name: 'Trip', plural: 'Trips' },
  ream: { code: 'REAM', name: 'Ream', plural: 'Reams' },
  set: { code: 'SET', name: 'Set', plural: 'Sets' },
  length: { code: 'LENGTH', name: 'Length', plural: 'Lengths' },
  sheet: { code: 'SHEET', name: 'Sheet', plural: 'Sheets' },
  coil: { code: 'COIL', name: 'Coil', plural: 'Coils' },
  dozen: { code: 'DOZEN', name: 'Dozen', plural: 'Dozens' },
  bundle: { code: 'BUNDLE', name: 'Bundle', plural: 'Bundles' },
});

function build() {
  const items = [];
  const seen = new Set();
  let n = 0;

  function add(category, name, opts = {}) {
    if (!CATEGORY_BY_CODE[category]) throw new Error(`unknown market category ${category}`);
    const unit = opts.unit || 'piece';
    if (!UNITS[unit]) throw new Error(`unknown market unit ${unit}`);
    const clean = String(name).replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 180) throw new Error(`bad market name: ${clean.slice(0, 80)}`);
    const key = clean.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    n += 1;
    items.push({
      sku: `NG-${String(n).padStart(5, '0')}`,
      name: clean,
      brand: opts.brand ? String(opts.brand).slice(0, 80) : null,
      category,
      unit,
      expiry: opts.expiry ? 1 : 0,
      ageRestricted: opts.age ? 1 : 0,
    });
    return true;
  }

  function each(category, rows, opts = {}) {
    for (const row of rows) {
      if (typeof row === 'string') add(category, row, opts);
      else add(category, row.name, Object.assign({}, opts, row));
    }
  }

  function cross(category, heads, tails, opts = {}) {
    for (const head of heads) {
      for (const tail of tails) {
        const brand = opts.brandFrom === 'tail' ? tail : head;
        add(category, `${head} ${tail}`, Object.assign({ brand }, opts));
      }
    }
  }

  // ----- rice, the staple of every provisions shop -----
  cross('NG_RICE', [
    'Mama Gold', 'Cap Rice', 'Royal Stallion', "Mama's Pride", 'Big Bull', 'Stallion',
    'Tomato', 'Golden Penny', 'Ebony', 'Lake Rice', 'Crystal', 'American Long Grain',
    'Indian Parboiled', 'Thai Parboiled', 'Cap Rice Aromatic', 'Royal Stallion Premium',
    'Stallion Supreme', 'Mama Gold Super', 'Falcon Rice', 'Mr Chef Rice',
  ], ['1kg', '5kg', '10kg', '25kg', '50kg bag'], { unit: 'bag' });
  each('NG_RICE', [
    'Ofada rice 5kg', 'Ofada rice 10kg', 'Ofada rice 25kg',
    'Abakaliki rice 5kg', 'Abakaliki rice 25kg', 'Abakaliki rice 50kg bag',
    'Local parboiled rice 25kg', 'Local parboiled rice 50kg bag',
    'Brown rice 2kg', 'Brown rice 5kg', 'Jollof rice 5kg pack',
  ], { unit: 'bag' });

  // ----- grains, flour, swallow -----
  cross('NG_GRAINS', [
    'Oloyin beans', 'Honey beans', 'White beans', 'Brown beans', 'Drum beans', 'Black-eye beans', 'Iron beans',
  ], ['1kg', '4kg', 'paint bucket', '50kg bag'], { unit: 'bag' });
  cross('NG_GRAINS', [
    'Ijebu white garri', 'Ijebu yellow garri', 'Fine white garri', 'Coarse white garri',
    'Yellow garri', 'Ghana yellow garri', 'Bendel white garri', 'Oyo white garri',
  ], ['1kg', '4kg', 'paint bucket', '50kg bag'], { unit: 'bag' });
  cross('NG_GRAINS', [
    'White maize', 'Yellow maize', 'Millet', 'Guinea corn', 'Sorghum', 'Acha (fonio)',
    'Soybeans', 'Shelled groundnut', 'Unshelled groundnut', 'Egusi melon', 'Ogbono',
    'Ground crayfish', 'Whole crayfish', 'Dry pepper', 'Cameroon pepper', 'Iru (locust beans)',
    'Ogiri', 'Ukwa', 'Dry fish', 'Stockfish',
  ], ['1kg', '4kg', 'bag'], { unit: 'bag' });
  cross('NG_GRAINS', ['Golden Penny Semovita', 'Honeywell Semovita'], ['1kg', '2kg', '5kg', '10kg'], { unit: 'pack' });
  cross('NG_GRAINS', ['Golden Penny Semolina', 'Dangote Semolina', 'Honeywell Semolina'], ['1kg', '2kg', '5kg', '10kg'], { unit: 'pack' });
  cross('NG_GRAINS', ['Golden Penny wheat flour', 'Dangote wheat flour', 'Honeywell wheat flour', 'BUA wheat flour'], ['1kg', '2kg', '5kg', '10kg', '50kg bag'], { unit: 'pack' });
  cross('NG_GRAINS', ['Ayoola pounded yam', 'Poundo Yam', 'Iyan pounded yam', 'Endys pounded yam'], ['500g', '1kg', '2.5kg', '4kg'], { unit: 'pack' });
  cross('NG_GRAINS', ['Plantain flour', 'Cassava flour', 'Elubo (yam flour)', 'Amala flour', 'Fufu flour', 'Corn flour', 'Ogi white', 'Ogi yellow'], ['1kg', '2kg', '4kg', '10kg'], { unit: 'pack' });
  each('NG_GRAINS', [
    'Golden Penny spaghetti 500g', 'Golden Penny spaghetti 1kg', 'Dangote spaghetti 500g',
    'Honeywell spaghetti 500g', 'Power pasta 500g', 'Golden Penny macaroni 500g',
  ], { unit: 'pack' });

  // ----- oil and seasoning -----
  cross('NG_OIL', ["King's", 'Devon', 'Power oil', 'Mamador', 'Turkey', 'Grand', 'Laser', 'Sunola', 'Emperor'], ['75cl', '1L', '1.5L', '2L', '3L', '5L', '10L', '25L'], { unit: 'bottle' });
  each('NG_OIL', [
    'Red palm oil 1L', 'Red palm oil 2L', 'Red palm oil 5L', 'Red palm oil 10L jerry', 'Red palm oil 25L jerry',
    'Groundnut oil 1L', 'Groundnut oil 2L', 'Groundnut oil 5L', 'Groundnut oil 10L',
    'Coconut oil 500ml', 'Coconut oil 1L', 'Olive oil 500ml', 'Olive oil 1L',
  ], { unit: 'bottle' });
  cross('NG_OIL', [
    'Maggi Star', 'Maggi Chicken', 'Knorr Chicken', 'Knorr Beef', 'Royco', 'Onga chicken',
    'Doyin', 'Tasty Tom cube', 'Gino cube', 'Ajinomoto', 'Mr Chef cube', 'Jollof cube',
  ], ['sachet of 10', 'pack of 50', 'carton of 100', 'jar 400g'], { unit: 'pack' });
  cross('NG_OIL', ['Dangote salt', 'Mr Chef salt', 'Uncle Bens iodised salt'], ['sachet', '500g', '1kg'], { unit: 'pack' });
  cross('NG_OIL', ['Dangote sugar', 'St Louis sugar', 'Golden Penny sugar', 'BUA sugar'], ['250g', '500g', '1kg', '2kg', '50kg bag'], { unit: 'pack' });
  each('NG_OIL', [
    'Curry powder 100g', 'Thyme 50g', 'Thyme 100g', 'Nutmeg ground 50g', 'Ginger powder 100g',
    'Garlic powder 100g', 'Pepper soup spice 100g', 'Suya spice 100g', 'Suya spice 500g',
    'Jollof spice 100g', 'Fried rice spice 100g', 'Crayfish seasoning 200g',
    'White pepper 100g', 'Black pepper 100g', 'Cameroon pepper ground 200g',
  ], { unit: 'pack' });

  // ----- packaged food -----
  cross('NG_PACKED', ['Gino', 'Sonia', 'Tasty Tom', 'De Rica', 'Ric-Giko', 'Hanno', 'St Rita', 'Derica', 'Gino Party Jollof'], ['70g', '210g', '400g', '800g', '2.2kg', '3.1kg'], { unit: 'tin', expiry: true });
  cross('NG_PACKED', ['Titus sardine', 'Geisha sardine', 'Costa sardine', 'Titus in tomato'], ['125g', '155g'], { unit: 'tin', expiry: true });
  cross('NG_PACKED', ['Exeter corned beef', 'Zwan corned beef', 'Hereford corned beef'], ['200g', '340g'], { unit: 'tin', expiry: true });
  each('NG_PACKED', [
    'Baked beans 400g', 'Sweet corn 340g', 'Mackerel in tomato 425g', 'Baked beans 800g',
    'Peak milk tin 170g', 'Three Crowns milk tin 160g', 'Coast milk tin 160g',
    'Mayonnaise 500ml', 'Salad cream 500ml', 'Tomato ketchup 400g', 'Chilli sauce 200ml',
  ], { unit: 'tin', expiry: true });

  // ----- noodles -----
  cross('NG_NOODLES', [
    'Indomie Chicken', 'Indomie Onion Chicken', 'Indomie Relish', 'Indomie Jollof',
    'Indomie Super Pack', 'Indomie Hungry Man', 'Indomie Belle Full', 'Indomie Oriental',
    'Chikki Chicken', 'Chikki Jollof', 'Mimee Chicken', 'Minimie Chicken', 'Minimie Chilli',
    'Honeywell Chicken noodles', 'Tummy Tummy Chicken', 'Dangote Chicken noodles', 'Mimi Chicken',
  ], ['single pack', 'pack of 5', 'carton of 40'], { unit: 'pack', expiry: true });
  cross('NG_NOODLES', ['Golden Penny spaghetti', 'Dangote spaghetti', 'Honeywell spaghetti', 'Power pasta', 'Golden Penny macaroni'], ['500g pack', '1kg pack', 'carton'], { unit: 'pack' });

  // ----- drinks -----
  cross('NG_DRINKS', [
    'Coca-Cola', 'Fanta Orange', 'Sprite', 'Pepsi', 'Mirinda', '7Up', 'Schweppes',
    'Limca', 'Teem', 'Fayrouz', 'Fearless', 'Coca-Cola Zero',
  ], ['35cl bottle', '50cl pet', '1L pet', '1.5L pet', '33cl can', 'crate of 24'], { unit: 'bottle' });
  cross('NG_DRINKS', ['Maltina', 'Amstel Malta', 'Malta Guinness', 'Hi-Malt', 'Dubic Malt', 'Grand Malt', 'Maltex'], ['can', '33cl bottle', 'pet', 'crate'], { unit: 'bottle' });
  cross('NG_DRINKS', [
    'Star', 'Gulder', 'Heineken', 'Hero', 'Trophy', 'Goldberg', 'Life', 'Legend',
    'Guinness Stout', 'Guinness Foreign Extra Stout', 'Harp', 'Star Radler', 'Heineken 0.0',
    'Smirnoff Ice', 'Desperados', 'Budweiser',
  ], ['60cl bottle', 'can', 'crate of 12'], { unit: 'bottle', age: true });
  each('NG_DRINKS', [
    'Orijin bitters 20cl', 'Action bitters 20cl', 'Alomo bitters 20cl', 'Origin bitters sachet',
    'Palm wine 75cl', 'Local gin (ogogoro) 20cl',
  ], { unit: 'bottle', age: true });
  cross('NG_DRINKS', ['Eva', 'Swan', 'Nestle Pure Life', 'Aquafina', 'Cway', 'Mr V', 'Ragolis'], ['sachet', '50cl', '75cl', '1.5L', 'pack of 12'], { unit: 'bottle' });
  cross('NG_DRINKS', ['Chivita', 'Five Alive', 'Chi Exotic', 'Fumman', 'Don Simon'], ['orange 1L', 'apple 1L', 'tropical 1L', 'mango 1L', 'pack of 6'], { unit: 'bottle', expiry: true });
  cross('NG_DRINKS', ['Hollandia yoghurt', 'Fresh Yo', 'FanYogo', 'Nutri-Yo', 'Farmfresh yoghurt'], ['90ml', '180ml', '500ml', '1L'], { unit: 'pack', expiry: true });

  // ----- milk, tea, beverages -----
  cross('NG_DAIRY', ['Peak', 'Three Crowns', 'Dano', 'Cowbell', 'Loya', 'Milksi', 'Nido', 'Olympic', 'Luna'], ['sachet', '150g', '360g', '400g', '900g', '2.5kg'], { unit: 'tin', expiry: true });
  cross('NG_DAIRY', ['Peak evaporated', 'Three Crowns evaporated', 'Coast evaporated', 'Luna evaporated'], ['160g tin', '410g tin'], { unit: 'tin', expiry: true });
  each('NG_DAIRY', [
    'Hollandia full cream 450ml', 'Hollandia full cream 1L', 'Peak liquid milk 1L', 'Nutrimilk 1L',
    'Milo sachet', 'Milo 200g', 'Milo 400g', 'Milo 900g', 'Milo 1.8kg', 'Milo refill 500g',
    'Bournvita sachet', 'Bournvita 400g', 'Bournvita 900g', 'Bournvita 1.2kg',
    'Ovaltine 400g', 'Ovaltine 800g', 'Richoco 400g', 'Cowbell Chocolate 400g', 'Cowbell Chocolate 900g',
    'Lipton Yellow Label 25 bags', 'Lipton Yellow Label 50 bags', 'Lipton Yellow Label 100 bags',
    'Top Tea 25 bags', 'Top Tea 100 bags', 'Glen tea 25 bags', 'Green tea 25 bags',
    'Nescafe Classic 50g', 'Nescafe Classic 200g', 'Nescafe 3-in-1 sachet', 'Nescafe 3-in-1 box',
    'MacCoffee 3-in-1 box',
  ], { unit: 'pack', expiry: true });

  // ----- snacks -----
  cross('NG_SNACKS', [
    'Nasco biscuits', "McVitie's Digestive", 'Oreo', 'Beloxxi Cream Crackers', 'Yale Shortcake',
    'Cabin biscuits', 'Coaster', 'Hobnobs', 'Glucose biscuits', 'Malt and Milk biscuits',
  ], ['single', 'pack of 6', 'carton'], { unit: 'pack', expiry: true });
  each('NG_SNACKS', [
    'Tom-Tom', 'Buttermint', 'Trebor', 'Orbit', 'Mentos', 'Center Fresh', 'Eclairs', "Fox's Glacier",
    'Blue Band 250g', 'Blue Band 450g', 'Blue Band 900g', 'Margarine 250g', 'Peanut butter 350g',
    'Golden Morn 500g', 'Golden Morn 900g', 'Nasco Corn Flakes 500g', "Kellogg's Corn Flakes 500g",
    'Checkers Custard 400g', 'Golden Penny Custard 500g', 'Gala sausage roll', 'Bigi sausage',
    'Chin chin 200g', 'Chin chin 500g', 'Plantain chips 100g', 'Roasted groundnut 200g',
    'Cashew nuts 100g', 'Coconut candy pack', 'Puff-puff mix 500g', 'Meat pie pack',
  ], { unit: 'pack', expiry: true });

  // ----- frozen -----
  cross('NG_FROZEN', ['Chi frozen chicken', 'Zartech chicken', 'Agric chicken'], ['whole 1kg', 'drumstick 1kg', 'wings 1kg', 'thigh 1kg', 'gizzard 1kg'], { unit: 'pack', expiry: true });
  each('NG_FROZEN', [
    'Frozen turkey 2kg', 'Frozen turkey wings 1kg', 'Titus fish 1kg', 'Croaker fish 1kg',
    'Panla fish 1kg', 'Kote fish 1kg', 'Prawns 500g', 'Frozen sausage 1kg', 'Chicken lap 1kg',
  ], { unit: 'pack', expiry: true });

  // ----- toiletries -----
  cross('NG_TOILET', [
    'Dettol', 'Lux', 'Joy', 'Premier', 'Delta soap', 'Carex', 'Imperial Leather', 'Dove soap',
    'Safeguard', 'Tetmosol', 'Dudu Osun', 'African black soap',
  ], ['bar', 'pack of 3', 'pack of 6'], { unit: 'piece' });
  cross('NG_TOILET', ['Close Up', 'Colgate', 'Pepsodent', 'Macleans', 'Oral-B', 'Dabur Herbal', 'Sensodyne'], ['25ml', '75ml', '140ml', '175ml'], { unit: 'piece' });
  cross('NG_TOILET', [
    'Nivea cream', 'Vaseline', 'Petroleum jelly', 'Dove lotion', 'Eva lotion', 'Sure lotion',
    'Caro White', 'Venus lotion', 'Skin Success', 'Carotone', 'Deep Heat', 'Robb', 'Aboniki', 'Mentholatum',
  ], ['50ml', '125ml', '250ml', '400ml'], { unit: 'piece' });
  cross('NG_TOILET', ['Nivea', 'Rexona', 'Dove', 'Sure', 'Cool and Cool'], ['roll-on', 'spray'], { unit: 'piece' });
  cross('NG_TOILET', ['Always', 'Molped', 'Softcare', 'Lady Care', 'Dry Love'], ['regular', 'long', 'night', 'pantiliner'], { unit: 'pack' });
  cross('NG_TOILET', ['Rose tissue', 'Selpak', 'Nice tissue', 'Virony'], ['1 roll', '4 rolls', '8 rolls'], { unit: 'pack' });
  each('NG_TOILET', [
    'Raid insect spray', 'Baygon spray', 'Rambo spray', 'Mortein spray', 'Killit spray',
    'Rambo mosquito coil pack', 'Baygon mosquito coil pack', 'Shield mosquito coil pack',
    'Insecticide treated net', 'Toothbrush soft', 'Toothbrush medium', 'Razor pack',
    'Shaving stick', 'Hair cream 150ml', 'Hair relaxer kit', 'Hair attachment pack',
  ], { unit: 'piece' });

  // ----- cleaning -----
  cross('NG_CLEAN', ['Omo', 'Ariel', 'Sunlight', 'So Klin', 'Waw', 'Klin', 'Aerial', 'Boom', 'Zip', 'Good Mama', 'Viva Plus'], ['sachet', '200g', '500g', '900g', '1.8kg', '2.5kg', '5kg'], { unit: 'pack' });
  cross('NG_CLEAN', ['Key soap', 'Canoe soap', 'Ajax bar', 'Sunlight bar'], ['single', 'pack of 5'], { unit: 'piece' });
  cross('NG_CLEAN', ['Hypo', 'Jik', 'Harpic'], ['500ml', '1L', '2L'], { unit: 'bottle' });
  cross('NG_CLEAN', ['Morning Fresh', 'Sunlight dish wash', 'Mama Lemon'], ['250ml', '500ml', '1L'], { unit: 'bottle' });
  each('NG_CLEAN', [
    'Toilet roll pack of 10', 'Air freshener spray', 'Floor cleaner 1L', 'Izal 1L',
    'Sponge pack', 'Steel wool pack', 'Dustpan and brush', 'Mop and bucket set',
  ], { unit: 'piece' });

  // ----- baby -----
  cross('NG_BABY', ['Molfix', 'Huggies', 'Pampers', 'Softcare diapers', 'Dr Brown diapers'], ['newborn', 'small', 'medium', 'large', 'extra large', 'jumbo pack'], { unit: 'pack' });
  cross('NG_BABY', ['NAN', 'SMA', 'Lactogen', 'Peak 123', 'Cerelac', 'Nutribom'], ['stage 1 400g', 'stage 2 400g', 'stage 3 400g', '900g tin'], { unit: 'tin', expiry: true });
  each('NG_BABY', [
    'Baby wipes pack', 'Baby soap', 'Baby oil 200ml', 'Baby powder 200g', 'Baby lotion 200ml',
    'Feeding bottle 250ml', 'Soother', 'Baby cereal 400g',
  ], { unit: 'piece' });

  // ----- household -----
  cross('NG_HOME', ['Plastic bucket', 'Plastic basin', 'Jerry can', 'Cooler'], ['5L', '10L', '20L', '25L'], { unit: 'piece' });
  each('NG_HOME', [
    'Flask 1L', 'Flask 1.8L', 'Plastic kettle', 'Aluminium pot set', 'Non-stick pot set',
    'Dinner plate set', 'Spoon set', 'Cup set', 'Hanger pack of 6', 'Clothes pegs pack',
    'Broom', 'Mop', 'Dustbin 20L', 'Dustbin 40L', 'Laundry basket',
    'Ghana-must-go bag small', 'Ghana-must-go bag medium', 'Ghana-must-go bag large',
    'Matches carton', 'Candle pack', 'Tiger battery AA pack', 'Tiger battery AAA pack',
    'Duracell AA pack', 'Torch light', 'Rechargeable lamp', 'Padlock 40mm', 'Padlock 50mm',
    'Clothes iron table', 'Drying rope', 'Peg bucket',
  ], { unit: 'piece' });

  // ----- phones sold in Computer Village, Wuse and Alaba -----
  const phones = [
    ['Tecno', 'Spark 10', ['64GB', '128GB']],
    ['Tecno', 'Spark 20', ['128GB', '256GB']],
    ['Tecno', 'Spark 30', ['128GB', '256GB']],
    ['Tecno', 'Camon 20', ['128GB', '256GB']],
    ['Tecno', 'Camon 30', ['256GB']],
    ['Tecno', 'Pop 8', ['64GB', '128GB']],
    ['Tecno', 'Phantom X2', ['256GB']],
    ['Tecno', 'Pouvoir 4', ['32GB']],
    ['Infinix', 'Hot 30', ['128GB', '256GB']],
    ['Infinix', 'Hot 40', ['128GB', '256GB']],
    ['Infinix', 'Note 30', ['128GB', '256GB']],
    ['Infinix', 'Note 40', ['256GB']],
    ['Infinix', 'Smart 8', ['64GB', '128GB']],
    ['Infinix', 'Zero 30', ['256GB']],
    ['Itel', 'A70', ['128GB']],
    ['Itel', 'S23', ['128GB', '256GB']],
    ['Itel', 'P40', ['64GB', '128GB']],
    ['Itel', 'A60', ['64GB']],
    ['Samsung', 'Galaxy A05', ['64GB', '128GB']],
    ['Samsung', 'Galaxy A15', ['128GB', '256GB']],
    ['Samsung', 'Galaxy A25', ['128GB', '256GB']],
    ['Samsung', 'Galaxy A35', ['128GB', '256GB']],
    ['Samsung', 'Galaxy A55', ['128GB', '256GB']],
    ['Samsung', 'Galaxy M14', ['128GB']],
    ['Samsung', 'Galaxy M34', ['128GB']],
    ['Xiaomi', 'Redmi 13C', ['128GB', '256GB']],
    ['Xiaomi', 'Redmi Note 12', ['128GB', '256GB']],
    ['Xiaomi', 'Redmi Note 13', ['128GB', '256GB']],
    ['Apple', 'iPhone 11 (UK used)', ['64GB', '128GB']],
    ['Apple', 'iPhone 12 (UK used)', ['64GB', '128GB']],
    ['Apple', 'iPhone 13 (UK used)', ['128GB', '256GB']],
    ['Apple', 'iPhone 14 (UK used)', ['128GB', '256GB']],
    ['Nokia', '105', ['feature phone']],
    ['Nokia', '106', ['feature phone']],
    ['Nokia', '3310', ['feature phone']],
  ];
  const colours = ['Black', 'Blue', 'Gold'];
  for (const [brand, model, stores] of phones) {
    for (const store of stores) {
      for (const colour of colours) {
        if (store === 'feature phone' && colour !== 'Black') continue;
        add('NG_PHONE', `${brand} ${model} ${store} ${colour}`, { brand, unit: 'piece' });
      }
    }
  }

  // ----- accessories -----
  cross('NG_ACCESSORY', ['Oraimo', 'Anker', 'Samsung', 'Tecno', 'Infinix', 'Itel'], ['Type-C charger', 'micro-USB charger', '20W charger', '33W charger'], { unit: 'piece' });
  cross('NG_ACCESSORY', ['Oraimo', 'Anker', 'Generic'], ['Type-C cable 1m', 'lightning cable 1m', '3-in-1 cable', 'earphones', 'neckband'], { unit: 'piece' });
  cross('NG_ACCESSORY', ['Oraimo', 'Anker', 'Romoss', 'Itel'], ['power bank 10000mAh', 'power bank 20000mAh', 'power bank 30000mAh'], { unit: 'piece' });
  cross('NG_ACCESSORY', ['SanDisk', 'Samsung', 'Generic'], ['memory card 16GB', 'memory card 32GB', 'memory card 64GB', 'memory card 128GB', 'flash drive 32GB', 'flash drive 64GB'], { unit: 'piece' });
  each('NG_ACCESSORY', [
    'Screen guard pack', 'Phone pouch', 'Bluetooth speaker small', 'Qasa speaker', 'Zealot speaker',
    'JBL clip speaker', 'Wireless mouse', 'USB keyboard', 'Laptop bag 15 inch', 'HDMI cable 2m',
    'Extension socket 4-way', 'Extension socket 6-way', 'Universal travel adaptor',
  ], { unit: 'piece' });

  // ----- appliances -----
  cross('NG_APPLIANCE', ['LG', 'Samsung', 'Hisense', 'TCL', 'Nexus', 'Polystar', 'Sony'], ['24 inch TV', '32 inch TV', '43 inch TV', '50 inch TV', '55 inch TV', '65 inch TV', '75 inch TV'], { unit: 'piece' });
  cross('NG_APPLIANCE', ['Thermocool', 'LG', 'Hisense', 'Scanfrost', 'Haier', 'Nexus', 'Midea'], ['fridge 90L', 'fridge 120L', 'fridge 180L', 'fridge 250L', 'fridge 300L', 'fridge 350L', 'chest freezer 200L', 'chest freezer 300L'], { unit: 'piece' });
  cross('NG_APPLIANCE', ['LG', 'Hisense', 'Panasonic', 'Midea', 'Scanfrost', 'Haier'], ['1HP AC', '1.5HP AC', '2HP AC', '1.5HP inverter AC', '2HP inverter AC'], { unit: 'piece' });
  cross('NG_APPLIANCE', ['Ox', 'Binatone', 'Century', 'Nasco', 'Qasa'], ['standing fan 16 inch', 'standing fan 18 inch', 'wall fan', 'ceiling fan', 'table fan', 'rechargeable fan'], { unit: 'piece' });
  cross('NG_APPLIANCE', ['Binatone', 'Scanfrost', 'Silver Crest', 'Century', 'Nexus'], ['pressing iron', 'steam iron', 'blender 1.5L', 'blender 2L', 'kettle 1.8L', 'microwave 20L', '4-burner gas cooker', 'water dispenser'], { unit: 'piece' });
  each('NG_APPLIANCE', [
    'Washing machine 6kg', 'Washing machine 8kg', 'Soundbar', 'Home theatre', 'DVD player',
    'Rechargeable standing fan', 'Clipper', 'Hair dryer',
  ], { unit: 'piece' });

  // ----- power -----
  cross('NG_POWER', ['Sumec Firman', 'Elepaq', 'Tiger', 'Lutian', 'Honda', 'Maxmech', 'Elemax'], ['0.9kVA generator', '1.5kVA generator', '2.5kVA generator', '3.2kVA generator', '3.5kVA generator', '5.0kVA generator', '6.5kVA generator'], { unit: 'piece' });
  each('NG_POWER', [
    'Sumec Firman 8kVA diesel generator', 'Elepaq 10kVA diesel generator', 'Honda 5.5kVA generator',
    'Luminous 1.5kVA inverter', 'Luminous 2.5kVA inverter', 'Mercury 1.5kVA inverter',
    'Felicity 3kVA inverter', 'Su-Kam 2kVA inverter',
    'Tubular battery 100Ah', 'Tubular battery 150Ah', 'Tubular battery 200Ah', 'Tubular battery 220Ah',
    'Felicity solar panel 200W', 'Felicity solar panel 300W', 'Felicity solar panel 450W', 'Felicity solar panel 550W',
    'Charge controller 40A', 'Charge controller 60A', 'Inverter battery water',
  ], { unit: 'piece' });

  // ----- lighting -----
  cross('NG_LIGHT', ['Century', 'Philips', 'Osram', 'Generic LED'], ['5W bulb', '9W bulb', '12W bulb', '18W bulb', 'rechargeable bulb'], { unit: 'piece' });
  cross('NG_LIGHT', ['Cutix', 'Nigerchin', 'Coleman', 'Kabelmetal'], ['1.5mm single core cable', '2.5mm single core cable', '4mm single core cable', '6mm single core cable', '1.5mm twin cable', '2.5mm twin and earth', '4mm twin and earth'], { unit: 'metre' });
  each('NG_LIGHT', [
    '13A socket', '13A switch', 'Double socket', 'Consumer unit 6-way', 'MCB 20A', 'MCB 32A',
    'Ceiling rose', 'Lamp holder', '2.5mm cable per metre', '4mm cable per metre',
  ], { unit: 'piece' });

  // ----- cement and aggregates -----
  each('NG_CEMENT', [
    'Dangote 3X cement 50kg', 'Dangote Falcon cement 50kg', 'BUA cement 50kg',
    'Lafarge Elephant cement 50kg', 'Ashaka cement 50kg', 'White cement 20kg', 'POP cement 20kg',
    '6-inch block', '9-inch block', 'Sharp sand per trip', 'Plaster sand per trip',
    'Granite half inch per trip', 'Granite three-quarter per trip', 'Laterite per trip',
    'Stone dust per trip', 'Hardcore per trip', 'Tile adhesive 20kg', 'White cement 5kg',
  ], { unit: 'bag' });

  // ----- steel and roofing -----
  cross('NG_STEEL', ['African Foundries', 'Quantum', 'Local mill'], ['8mm rod 12m', '10mm rod 12m', '12mm rod 12m', '16mm rod 12m', '20mm rod 12m', '25mm rod 12m'], { unit: 'length' });
  cross('NG_STEEL', ['Wire nail', 'Concrete nail', 'Roofing nail'], ['1 inch', '2 inch', '2.5 inch', '3 inch', '4 inch', '5 inch', '6 inch'], { unit: 'kilogram' });
  each('NG_STEEL', [
    'Binding wire 18 gauge per kg', 'Binding wire 20 gauge per kg', 'Binding wire 22 gauge per kg',
    'Binding wire roll', 'BRC mesh sheet',
  ], { unit: 'roll' });
  cross('NG_STEEL', ['Tower', 'Nigerite', 'Metcoppo'], ['longspan 0.45mm', 'longspan 0.55mm', 'stone-coated tile', 'step tile', 'aluminium zinc sheet'], { unit: 'length' });

  // ----- paint: the colours a yard actually stocks -----
  cross('NG_PAINT', ['Dulux', 'Berger', 'Meyer', 'Sandtex', 'Finecoat', 'President', 'Peggy'], [
    'emulsion white 4L', 'emulsion white 20L', 'emulsion cream 4L', 'emulsion cream 20L',
    'emulsion magnolia 4L', 'emulsion magnolia 20L', 'emulsion off-white 20L',
    'emulsion grey 4L', 'emulsion grey 20L', 'gloss white 4L', 'gloss white 20L',
    'gloss cream 4L', 'gloss blue 4L', 'gloss green 4L', 'gloss chocolate 4L',
    'textured white 20L', 'undercoat 4L', 'undercoat 20L',
  ], { unit: 'tin', expiry: true });

  // ----- plumbing -----
  cross('NG_PLUMB', ['Bulldog PVC', 'Generic PVC'], ['1/2 inch pipe 4m', '3/4 inch pipe 4m', '1 inch pipe 4m', '1.5 inch pipe 4m', '2 inch pipe 4m', '3 inch pipe 4m', '4 inch pipe 4m'], { unit: 'length' });
  cross('NG_PLUMB', ['Bulldog PPR', 'Generic PPR'], ['20mm pipe 4m', '25mm pipe 4m', '32mm pipe 4m', '40mm pipe 4m'], { unit: 'length' });
  each('NG_PLUMB', [
    'WC close-coupled set', 'WC squatting pan', 'Wash hand basin', 'Kitchen sink single',
    'Pillar tap', 'Mixer tap', 'Shower set', 'Water heater 15L', 'Water heater 30L',
    'Ball valve 1/2 inch', 'Elbow 1/2 inch', 'Tee 1/2 inch', 'PTFE tape',
    'Toilet seat', 'Cistern', 'Waste pipe',
  ], { unit: 'piece' });

  // ----- tiles -----
  cross('NG_TILE', ['Goodwill', 'Royal', 'Local ceramic'], [
    '25x40 wall tile white', '25x40 wall tile beige', '30x30 floor tile',
    '40x40 floor tile polished', '40x40 floor tile matte', '60x60 porcelain polished',
    '60x60 porcelain matte', '60x60 rustic grey', '80x80 polished white',
  ], { unit: 'piece' });
  each('NG_TILE', [
    'Tile spacer pack', 'Tile grout white 5kg', 'Tile grout grey 5kg', 'Skirting tile',
  ], { unit: 'pack' });

  // ----- tools -----
  each('NG_TOOLS', [
    'Claw hammer', 'Ball hammer', 'Pliers', 'Adjustable spanner 10 inch', 'Screwdriver set',
    'Angle grinder 4.5 inch', 'Electric drill', 'Wheelbarrow', 'Head pan', 'Shovel',
    'Digger', 'Spirit level', 'Measuring tape 5m', 'Measuring tape 8m', 'Hacksaw',
    'Utility knife', 'Safety helmet', 'Safety boot pair', 'Hand gloves pair',
    'Union padlock 40mm', 'Union padlock 50mm', 'Yale padlock 50mm', 'Trio padlock 60mm',
    'Hinge pair 4 inch', 'Door handle set', 'Turkish security door', 'Chinese security door',
    'Local steel door', 'Flush door', 'Panel door',
  ], { unit: 'piece' });

  // ----- furniture -----
  cross('NG_FURNITURE', ['Vitafoam', 'Mouka', 'Mouka Latex'], ['mattress 3x6', 'mattress 4x6', 'mattress 6x6', 'mattress 6x7'], { unit: 'piece' });
  each('NG_FURNITURE', [
    'Plastic chair monobloc', 'Plastic table', 'Dining set 4-seater', 'Dining set 6-seater',
    'Bed 4x6', 'Bed 6x6', 'Wardrobe 2-door', 'Wardrobe 3-door', 'Office chair',
    'Sofa 3-seater', 'Centre table', 'TV stand', 'Bookshelf', 'School desk',
    'Foam pillow', 'Bed sheet set', 'Curtain pair', 'Window blind',
  ], { unit: 'piece' });

  // ----- fabrics: Balogun, Kantin Kwari, Ariaria -----
  cross('NG_FABRIC', ['Vlisco', 'Hitarget', 'GTP', 'Nichemtex', 'Woodin', 'Da Viva', 'ABC wax', 'Java', 'Uniwax'], [
    'ankara blue 6 yards', 'ankara red 6 yards', 'ankara green 6 yards', 'ankara gold 6 yards',
    'ankara wine 6 yards', 'ankara brown 6 yards', 'ankara white 6 yards', 'ankara multicolour 6 yards',
  ], { unit: 'yard' });
  cross('NG_FABRIC', ['Swiss lace', 'Cord lace', 'Sequin lace', 'Guinea brocade', 'Aso-oke', 'Adire', 'Senator material', 'Atiku'], [
    'blue 5 yards', 'gold 5 yards', 'white 5 yards', 'wine 5 yards',
  ], { unit: 'yard' });
  each('NG_FABRIC', [
    'Sewing thread reel', 'Button card', 'Zip 8 inch', 'Lining fabric per yard', 'Interlining per yard',
    'Bias tape', 'Elastic roll', 'Hook and eye card',
  ], { unit: 'piece' });

  // ----- clothing and footwear -----
  cross('NG_CLOTH', ['Polo shirt', 'Plain shirt', 'Trouser', 'Jeans', 'Kaftan', 'Agbada', 'Gown', 'Hijab', 'Senator cap'], ['small', 'medium', 'large', 'extra large', '2XL'], { unit: 'piece' });
  cross('NG_CLOTH', ['Palm slippers', 'Bathroom slippers', 'Corporate shoe black', 'Canvas shoe', 'School sandals'], ['size 38', 'size 40', 'size 42', 'size 44', 'size 45'], { unit: 'pair' });
  each('NG_CLOTH', [
    'School uniform shirt', 'School uniform skirt', 'School bag', 'Travelling bag',
    'Ladies handbag', 'Belt', 'Socks pair', 'Iro and buba set',
  ], { unit: 'piece' });

  // ----- stationery -----
  cross('NG_STATIONERY', ['Onward', 'Oxford', 'Local exercise book'], ['40 leaves', '60 leaves', '80 leaves'], { unit: 'piece' });
  cross('NG_STATIONERY', ['Bic', 'Reynolds', 'Local biro'], ['blue', 'black', 'red'], { unit: 'piece' });
  cross('NG_STATIONERY', ['Paperline', 'PaperOne', 'Double A', 'Xerox'], ['A4 ream 80gsm', 'A4 carton'], { unit: 'ream' });
  each('NG_STATIONERY', [
    'Mathematical set', 'Ruler 30cm', 'Pencil HB', 'Eraser', 'Sharpener', 'Chalk box',
    'Whiteboard marker', 'Cardboard sheet', 'Crayon set', 'Drawing book', 'Notebook A4',
    'Stapler', 'Staple pins', 'Cello tape', 'Envelope pack',
  ], { unit: 'piece' });

  // ----- motor -----
  cross('NG_MOTOR', ['Total Quartz', 'Mobil Super', 'Oando', 'MRS', 'Castrol'], ['20W50 1L', '20W50 4L', '20W50 5L', '5W30 1L', '5W30 4L', '15W40 4L', '15W40 5L'], { unit: 'bottle' });
  each('NG_MOTOR', [
    'Brake fluid DOT 3', 'Brake fluid DOT 4', 'Coolant 1L', 'Coolant 4L', 'Grease 500g',
    'Gear oil 1L', 'ATF 1L',
  ], { unit: 'bottle' });
  cross('NG_MOTOR', ['Amaron', 'Bosch', 'Exide', 'Solite'], ['45Ah battery', '55Ah battery', '62Ah battery', '75Ah battery', '100Ah battery'], { unit: 'piece' });
  cross('NG_MOTOR', ['Dunlop', 'Michelin', 'Maxxis', 'Triangle', 'Aptany', 'Westlake'], ['175/70R13', '185/65R14', '195/65R15', '195/70R15C', '205/55R16', '265/70R16'], { unit: 'piece' });
  each('NG_MOTOR', [
    'NGK spark plug', 'Denso spark plug', 'Oil filter', 'Air filter', 'Fuel filter',
    'Brake pad set', 'Wiper blade pair', 'Bulb H4', 'Bulb H7',
  ], { unit: 'piece' });

  // ----- agro: names only, no directions -----
  each('NG_AGRO', [
    'NPK 15-15-15 50kg', 'NPK 20-10-10 50kg', 'NPK 12-12-17 50kg', 'Urea 50kg', 'SSP 50kg',
    'Top Feeds chick mash 25kg', 'Top Feeds grower mash 25kg', 'Top Feeds finisher 25kg', 'Top Feeds layers mash 25kg',
    'Livestock Feeds chick mash 25kg', 'Livestock Feeds grower 25kg', 'Livestock Feeds layers 25kg',
    'Hybrid chick mash 25kg', 'Hybrid grower 25kg', 'Vital layers mash 25kg',
    'Fish feed 15kg', 'Pig feed 25kg',
    'Maize seed 2kg', 'Rice seed 5kg', 'Tomato seed packet', 'Pepper seed packet',
    'Okra seed packet', 'Watermelon seed packet',
    'Force Up herbicide 1L', 'Glyphosate 1L', 'Poultry premix 1kg',
  ], { unit: 'bag' });

  // Pharmaceuticals used to occupy the next thirty-three numbers. They are
  // not on this list. The numbers stay empty so a gas cylinder, and every
  // good already on the list, keeps the SKU it already had.
  n += 33;

  // ----- gas and fuel -----
  each('NG_GAS', [
    'Gas cylinder 3kg', 'Gas cylinder 5kg', 'Gas cylinder 6kg', 'Gas cylinder 12.5kg', 'Gas cylinder 25kg',
    'Gas cooker 2-burner', 'Gas cooker 3-burner', 'Gas cooker 4-burner',
    'Kerosene stove', 'Charcoal bag', 'Firewood bundle', 'Gas regulator', 'Gas hose',
    'Camping gas cartridge',
  ], { unit: 'piece' });

  // Other trades, appended so nothing already on the list changes SKU.
  require('./nigeriaMarketTrades').addTrades({ add, each, cross });

  return items;
}

const ITEMS = Object.freeze(build());
const BY_SKU = new Map(ITEMS.map((item) => [item.sku, item]));

function categoryName(code) {
  const row = CATEGORY_BY_CODE[code];
  return row ? row.name : code;
}

function publicItem(item) {
  return {
    sku: item.sku,
    name: item.name,
    brand: item.brand,
    category: item.category,
    categoryName: categoryName(item.category),
    unit: item.unit,
    unitName: UNITS[item.unit].name,
    expiry: item.expiry,
    ageRestricted: item.ageRestricted,
  };
}

/**
 * Search the inbuilt list. No prices are returned, because none are stored.
 * `q` is matched against the name, the brand and the SKU. A category code
 * narrows the list. Order is the catalogue order, which is stable.
 */
function search({ q = '', category = '', limit = 40, offset = 0 } = {}) {
  const needle = String(q || '').trim().toLowerCase().slice(0, 40);
  const words = needle.split(/\s+/).filter(Boolean);
  const cat = String(category || '').trim();
  const matched = [];
  for (const item of ITEMS) {
    if (cat && item.category !== cat) continue;
    if (words.length) {
      const hay = `${item.name} ${item.brand || ''} ${item.sku} ${categoryName(item.category)}`.toLowerCase();
      if (!words.every((word) => hay.includes(word))) continue;
    }
    matched.push(item);
  }
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.min(80, Math.max(1, Number(limit) || 40));
  return {
    data: matched.slice(start, start + size).map(publicItem),
    total: matched.length,
    limit: size,
    offset: start,
  };
}

function get(sku) {
  return BY_SKU.get(String(sku || '').trim().toUpperCase()) || null;
}

function categories() {
  const counts = new Map();
  for (const item of ITEMS) counts.set(item.category, (counts.get(item.category) || 0) + 1);
  return CATEGORIES.map((c) => ({ code: c.code, name: c.name, count: counts.get(c.code) || 0 }));
}

module.exports = {
  CATEGORIES,
  UNITS,
  ITEMS,
  search,
  get,
  categories,
  categoryName,
  publicItem,
};
