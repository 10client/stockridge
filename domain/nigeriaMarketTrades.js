'use strict';
// =====================================================================
// domain/nigeriaMarketTrades.js — THE OTHER BUSINESSES
// =====================================================================
// Appended after the original list, so a good that was already there
// keeps its SKU. No prices. No medicines. A name is the pack on the
// shelf, the way that trade sells it.
// =====================================================================

function addTrades(api) {
  const add = api.add;
  const each = api.each;
  const cross = api.cross;
  // ----- fresh market: Mile 12, Dawanau, Bodija, Ogbete, Ariaria -----
  cross('NG_FRESH', [
    'Abuja yam', 'Benue yam', 'Pepa yam', 'Gboko yam', 'Onitsha yam', 'Water yam',
  ], ['small tuber', 'medium tuber', 'large tuber', 'heap of 5'], { unit: 'piece', expiry: true });
  cross('NG_FRESH', ['Ripe plantain', 'Unripe plantain'], ['bunch', 'finger', 'heap'], { unit: 'piece', expiry: true });
  cross('NG_FRESH', ['Tomato', 'Tatase pepper', 'Shombo pepper', 'Bawa onion', 'White onion'], ['paint bucket', 'basket', 'bag'], { unit: 'bag', expiry: true });
  each('NG_FRESH', [
    'Ugu bunch', 'Waterleaf bunch', 'Scent leaf bunch', 'Bitter leaf bunch', 'Pumpkin leaf bunch',
    'Okra paint bucket', 'Garden egg paint bucket', 'Cucumber piece', 'Cabbage head', 'Carrot bunch',
    'Lettuce head', 'Spring onion bunch', 'Green beans paint bucket', 'Fresh maize cob',
    'Beef per kg', 'Goat meat per kg', 'Ram meat per kg', 'Cow leg per kg', 'Ponmo per kg',
    'Cow skin per kg', 'Gizzard per kg', 'Live chicken', 'Live turkey', 'Live snail per kg',
    'Live catfish per kg', 'Fresh tilapia per kg', 'Fresh croaker per kg',
    'Orange bag', 'Banana bunch', 'Pineapple piece', 'Watermelon piece', 'Pawpaw piece',
    'Mango heap', 'Apple tray', 'Grape pack', 'Avocado piece', 'Coconut piece',
    'Egg crate of 30', 'Egg half crate', 'Pure honey 500ml', 'Shea butter 500g',
    'Zobo leaves pack', 'Kunu mix pack', 'Palm kernel oil 1L',
  ], { unit: 'piece', expiry: true });

  // ----- hair and salon: Balogun, Wuse, Kantin Kwari -----
  const hairColours = ['1', '1b', '2', '4', '27', '30', '99j', '613'];
  const hairLengths = ['12 inch', '14 inch', '16 inch', '18 inch', '22 inch', '26 inch'];
  cross('NG_HAIR', ['Xpression', 'Darling', 'Lush Hair', 'Sensationnel'], hairColours.map((c) => `braiding hair ${c}`), { unit: 'pack' });
  // The cross above pairs brand with colour only. Lengths are a second pass so a
  // pack is a colour and a length, which is how the shelf is labelled.
  for (const brand of ['Xpression', 'Darling']) {
    for (const colour of ['1b', '4', '27', '30', '613']) {
      for (const length of hairLengths) {
        add('NG_HAIR', `${brand} braiding hair ${colour} ${length}`, { brand, unit: 'pack' });
      }
    }
  }
  cross('NG_HAIR', ['Bone straight wig', 'Body wave wig', 'Curly wig', 'Bob wig', 'Pixie wig'], ['12 inch', '14 inch', '16 inch', '18 inch', '20 inch'], { unit: 'piece' });
  cross('NG_HAIR', ['Closure 4x4', 'Closure 5x5', 'Frontal 13x4', 'Frontal 13x6'], ['12 inch', '14 inch', '16 inch', '18 inch'], { unit: 'piece' });
  each('NG_HAIR', [
    'Wahl hair clipper', 'Kemei hair clipper', 'Andis hair clipper',
    'Salon standing dryer', 'Hood steamer', 'Mannequin head',
    'Hair roller set', 'Hair net pack', 'Edge control gel', 'Hair mousse',
    'Dark and Lovely relaxer kit', 'ORS relaxer kit', 'Creme of Nature hair dye black',
    'Garnier hair dye brown', 'Braiding thread roll', 'Hair wax stick',
    'Synthetic hair black 14 inch', 'Synthetic hair brown 18 inch',
  ], { unit: 'piece' });

  // ----- makeup and fragrance. No bleaching creams, no medicines. -----
  cross('NG_BEAUTY', ['Zaron', 'Sleek', 'BM', 'Zikel', 'L.A. Girl', 'Maybelline', 'Black Opal', 'Milani'], [
    'foundation', 'powder', 'lipstick', 'mascara', 'eyeliner', 'concealer',
  ], { unit: 'piece' });
  cross('NG_BEAUTY', ['Lattafa', 'Al-Rehab', 'Axe', 'Nivea', 'Sure', 'Classic'], [
    'body spray', 'perfume 50ml', 'perfume oil 6ml',
  ], { unit: 'piece' });
  each('NG_BEAUTY', [
    'Nail polish red', 'Nail polish nude', 'Nail polish black', 'Nail tips pack',
    'Nail glue', 'Makeup brush set', 'Makeup sponge', 'Setting powder',
    'Lip gloss clear', 'False eyelashes pair', 'Shea butter soap',
  ], { unit: 'piece' });

  // ----- first aid and hygiene: the pack, not a medicine -----
  each('NG_HYGIENE', [
    'Plaster roll', 'Cotton wool 100g', 'Crepe bandage', 'Examination gloves box',
    'Face mask box', 'Hand sanitizer 100ml', 'Hand sanitizer 500ml',
    'Digital thermometer', 'Blood pressure cuff', 'First aid box empty',
  ], { unit: 'piece' });

  // ----- Computer Village, Banex, Wuse Zone 4 -----
  cross('NG_COMPUTER', [
    'HP 15', 'HP 250', 'Dell Inspiron 15', 'Dell Latitude 3420', 'Lenovo IdeaPad 3',
    'Lenovo ThinkPad E14', 'Acer Aspire 3', 'Acer Aspire 5', 'Asus VivoBook 15',
    'Apple MacBook Air (UK used)',
  ], ['8GB 256GB', '8GB 512GB', '16GB 512GB'], { unit: 'piece' });
  each('NG_COMPUTER', [
    'HP LaserJet printer', 'HP DeskJet printer', 'Canon PIXMA printer', 'Epson L3250 printer',
    'HP 85A toner', 'HP 12A toner', 'Canon ink black', 'Canon ink colour', 'Epson ink bottle set',
    'PAX A920 POS terminal', 'PAX S90 POS terminal', 'Topwise POS terminal', 'Nexgo POS terminal',
    'Thermal receipt printer 80mm', 'Barcode scanner USB', 'Cash drawer',
    'Hikvision 4-channel CCTV kit', 'Hikvision 8-channel CCTV kit', 'Dahua 4-channel CCTV kit',
    'Dome camera', 'Bullet camera', 'CCTV power supply',
    'TP-Link router', 'Mercusys router', 'TP-Link switch 8-port',
    'USB flash drive 16GB', 'USB flash drive 32GB', 'USB flash drive 64GB', 'USB flash drive 128GB',
    'External hard disk 500GB', 'External hard disk 1TB', 'External hard disk 2TB',
    'SSD 256GB', 'SSD 512GB', 'SSD 1TB',
    'Monitor 19 inch', 'Monitor 22 inch', 'Monitor 24 inch',
    'USB keyboard', 'USB mouse', 'Wireless mouse',
    'UPS 650VA', 'UPS 1kVA', 'UPS 1.5kVA',
    'Projector', 'Projector screen', 'HDMI cable 5m', 'VGA cable 3m',
    'Laptop bag 15 inch', 'Laptop charger 65W', 'Webcam',
  ], { unit: 'piece' });

  // ----- Ladipo, Aspamda, the motorcycle line -----
  cross('NG_MOTO', [
    'Bajaj Boxer', 'Bajaj Discover', 'TVS Apache', 'TVS Star', 'Honda CG', 'Qlink', 'Haojue', 'Suzuki',
  ], [
    'front tyre', 'rear tyre', 'tube', 'chain', 'sprocket', 'brake shoe',
    'CDI unit', 'headlamp', 'mirror pair', 'seat', 'exhaust', 'spark plug',
  ], { unit: 'piece' });
  cross('NG_MOTO', ['TVS King keke', 'Bajaj RE keke'], [
    'front tyre', 'rear tyre', 'tube', 'shock absorber', 'windscreen', 'headlamp',
  ], { unit: 'piece' });
  cross('NG_MOTO', ['Phoenix bicycle', 'Raleigh bicycle'], ['20 inch', '24 inch', '26 inch'], { unit: 'piece' });
  each('NG_MOTO', [
    'Open-face helmet black', 'Open-face helmet red', 'Full-face helmet black',
    'Okada raincoat', 'Motorcycle gloves pair', 'Bicycle pump', 'Bicycle lock',
    'Motorcycle battery 12V', 'Keke battery 12V',
  ], { unit: 'piece' });

  // ----- timber yard -----
  cross('NG_TIMBER', ['Ordinary plywood 4x8', 'Marine plywood 4x8'], ['3mm', '6mm', '9mm', '12mm', '18mm', '25mm'], { unit: 'sheet' });
  cross('NG_TIMBER', ['MDF board 4x8', 'Particle board 4x8'], ['6mm', '12mm', '18mm'], { unit: 'sheet' });
  cross('NG_TIMBER', ['2x2 timber', '2x3 timber', '2x4 timber', '2x6 timber', '1x12 timber'], ['12ft', '16ft'], { unit: 'length' });
  cross('NG_TIMBER', ['Iroko', 'Mahogany', 'Obeche', 'Afara', 'Opepe'], ['length', 'plank'], { unit: 'length' });
  each('NG_TIMBER', [
    'PVC ceiling board', 'POP ceiling board', 'Formwork board', 'Skirting board 2.4m',
    'Door frame hardwood', 'Door frame softwood', 'Melamine board white', 'Melamine board brown',
  ], { unit: 'piece' });

  // ----- aluminium and glass -----
  cross('NG_ALUMINIUM', ['Sliding window', 'Casement window', 'Projected window'], ['4ft', '6ft', '8ft'], { unit: 'piece' });
  each('NG_ALUMINIUM', [
    'Aluminium door single', 'Aluminium door double', 'Aluminium sliding door',
    'Clear glass sheet 4mm', 'Clear glass sheet 5mm', 'Clear glass sheet 6mm',
    'Obscure glass sheet 4mm', 'Mosquito netting per metre', 'Aluminium profile length',
    'Glass door handle', 'Window roller set', 'Rubber glazing gasket per metre',
    'Balustrade panel', 'Shower cubicle glass',
  ], { unit: 'piece' });

  // ----- welding and fabrication -----
  each('NG_WELD', [
    'Inverter welder 200A', 'Arc welder 250A', 'Welding helmet', 'Welding gloves pair',
    'Electrode holder', 'Earth clamp', 'Chipping hammer',
    'Angle iron 1 inch length', 'Angle iron 2 inch length', 'Angle iron 3 inch length',
    'Flat bar length', 'Square pipe 1 inch length', 'Square pipe 2 inch length', 'Square pipe 3 inch length',
    'Round pipe 1 inch length', 'Round pipe 2 inch length',
    'Binding wire coil', 'BRC mesh sheet',
  ], { unit: 'piece' });
  cross('NG_WELD', ['Welding electrode'], ['2.5mm pack', '3.2mm pack', '4.0mm pack'], { unit: 'pack' });
  cross('NG_WELD', ['Cutting disc', 'Grinding disc'], ['4 inch', '4.5 inch', '9 inch'], { unit: 'piece' });

  // ----- bakery supplies. The flour is already under grains. -----
  cross('NG_BAKERY', ['Fermipan yeast', 'Eagle yeast', 'Instant yeast'], ['10g', '125g', '500g'], { unit: 'pack', expiry: true });
  each('NG_BAKERY', [
    'Baking powder 100g', 'Baking soda 100g', 'Icing sugar 500g', 'Caster sugar 1kg',
    'Vanilla essence 28ml', 'Butter flavour 28ml', 'Strawberry flavour 28ml', 'Banana flavour 28ml',
    'Cake box 8 inch', 'Cake box 10 inch', 'Cake box 12 inch', 'Cupcake liner pack',
    'Foil tray pack', 'Bread nylon pack', 'Whisk', 'Rolling pin', 'Oven tray',
    'Piping bag set', 'Cake board 10 inch', 'Whipped topping 500g',
    'Baking margarine 250g', 'Baking margarine 1kg',
  ], { unit: 'pack', expiry: true });

  // ----- nylon and takeaway: every provisions shop and every buka -----
  cross('NG_NYLON', ['Black nylon', 'White nylon', 'Leather nylon'], ['small', 'medium', 'large', 'extra large'], { unit: 'pack' });
  cross('NG_NYLON', ['Takeaway pack', 'Foil takeaway pack', 'Paper takeaway pack'], ['500ml', '750ml', '1L'], { unit: 'pack' });
  each('NG_NYLON', [
    'Carrier bag pack', 'Shopping bag pack', 'Ziplock bag pack',
    'Disposable cup pack', 'Disposable plate pack', 'Disposable spoon pack', 'Disposable fork pack',
    'Cling film roll', 'Aluminium foil roll', 'Serviette pack', 'Straw pack',
  ], { unit: 'pack' });

  // ----- watches, beads, jewellery. No counterfeit brand names. -----
  each('NG_JEWELLERY', [
    'Casio F91W', 'Casio A158', 'Casio MTP', 'Casio LTP', 'Casio G-Shock',
    'Q&Q analogue watch', 'Seiko 5 watch', 'Fashion watch gold', 'Fashion watch silver',
    'Coral beads strand', 'Gold beads strand', 'Black beads strand', 'Waist beads',
    'Gold-plated chain 18 inch', 'Gold-plated chain 20 inch', 'Gold-plated chain 22 inch',
    'Silver-plated chain 18 inch', 'Earrings pair gold', 'Earrings pair silver',
    'Ring size 6', 'Ring size 8', 'Ring size 10', 'Bangle', 'Anklet',
    'Wristwatch strap leather', 'Wristwatch battery',
  ], { unit: 'piece' });

  // ----- bookshop and school -----
  const subjects = [
    'English', 'Mathematics', 'Biology', 'Chemistry', 'Physics', 'Economics',
    'Government', 'Literature', 'Accounting', 'Commerce', 'Agricultural Science',
    'Geography', 'Civic Education', 'Computer Studies', 'Further Mathematics', 'CRS',
  ];
  cross('NG_BOOKS', ['WAEC past questions', 'NECO past questions', 'JAMB past questions'], subjects, { unit: 'piece' });
  cross('NG_BOOKS', ['Primary English', 'Primary Mathematics'], ['1', '2', '3', '4', '5', '6'], { unit: 'piece' });
  cross('NG_BOOKS', ['JSS English', 'JSS Mathematics', 'JSS Basic Science', 'JSS Basic Technology'], ['1', '2', '3'], { unit: 'piece' });
  cross('NG_BOOKS', ['SS English', 'SS Mathematics', 'SS Biology', 'SS Chemistry', 'SS Physics'], ['1', '2', '3'], { unit: 'piece' });
  each('NG_BOOKS', [
    'Oxford dictionary', 'Longman dictionary', 'Oxford advanced learner dictionary',
    'Atlas', 'Notebook A5', 'Graph book', 'Lesson note book', 'Register book',
    'Receipt booklet', 'Invoice booklet', 'Delivery waybill booklet',
  ], { unit: 'piece' });

  // ----- sports -----
  cross('NG_SPORT', ['Football jersey', 'Nigeria national team jersey'], ['small', 'medium', 'large', 'extra large', '2XL'], { unit: 'piece' });
  cross('NG_SPORT', ['Football boot'], ['size 40', 'size 41', 'size 42', 'size 43', 'size 44', 'size 45'], { unit: 'pair' });
  each('NG_SPORT', [
    'Molten football size 5', 'Training football size 5', 'Football size 4',
    'Goalkeeper gloves pair', 'Shin guard pair', 'Skipping rope',
    'Dumbbell pair 5kg', 'Dumbbell pair 10kg', 'Gym mat',
    'Table tennis bat', 'Table tennis ball pack', 'Badminton racket',
    'Sports water bottle', 'Whistle',
  ], { unit: 'piece' });

  // ----- religious goods. Books and cloth, not oils sold as medicine. -----
  cross('NG_WORSHIP', ['KJV Bible', 'NIV Bible', 'Good News Bible'], ['pocket', 'standard', 'large print'], { unit: 'piece' });
  each('NG_WORSHIP', [
    'Quran Arabic', 'Quran with translation', 'Hymnal', 'Song book',
    'Rosary', 'Tasbih', 'Prayer mat', 'White garment', 'Choir robe',
    'Incense pack', 'Church offering envelope pack', 'Wall crucifix',
  ], { unit: 'piece' });

  // ----- water storage and pumps. Hardware, not a treatment dose. -----
  cross('NG_WATER', ['Geepee tank', 'Stainless tank'], ['500L', '1000L', '1500L', '2000L', '3000L', '5000L'], { unit: 'piece' });
  each('NG_WATER', [
    'Surface pump 0.5hp', 'Surface pump 1hp', 'Borehole pump 1hp', 'Borehole pump 1.5hp', 'Borehole pump 2hp',
    'Water filter candle', 'Float valve', 'Tank stand', 'Pressure switch',
    'Water hose 20m', 'Water hose 30m',
  ], { unit: 'piece' });

  // ----- poultry and livestock equipment. No vaccines, no drugs. -----
  each('NG_POULTRY', [
    'Chick feeder', 'Grower feeder', 'Automatic feeder', 'Chick drinker', 'Grower drinker',
    'Egg crate plastic', 'Incubator 48 eggs', 'Incubator 96 eggs', 'Incubator 528 eggs',
    'Battery cage section', 'Debeaking machine', 'Heat lamp', 'Charcoal brooder',
    'Egg tray cardboard', 'Poultry scale', 'Wheelbarrow for droppings',
    'Cattle rope', 'Goat collar',
  ], { unit: 'piece' });

  // ----- fishing gear -----
  each('NG_FISHING', [
    'Fishing hook pack', 'Fishing line 100m', 'Fishing float pack', 'Sinker pack',
    'Cast net', 'Gill net 2 inch', 'Gill net 3 inch', 'Fishing rod', 'Reel',
    'Aerator pump', 'Catfish holding tank', 'Landing net',
  ], { unit: 'piece' });

  // ----- party and event -----
  each('NG_EVENT', [
    'Canopy 10x10', 'Canopy 20x20', 'Canopy 20x40',
    'Event chair white', 'Chiavari chair', 'Table cover white', 'Table cover gold',
    'Balloon pack', 'Ribbon roll', 'Centrepiece',
    'Microphone wired', 'Microphone wireless', 'Mixer 8-channel',
    'Speaker 12 inch', 'Speaker 15 inch', 'Speaker stand',
    'Stage light', 'Extension cable 20m',
  ], { unit: 'piece' });

  // ----- sewing and tailoring -----
  each('NG_SEWING', [
    'Butterfly sewing machine', 'Singer sewing machine', 'Brother sewing machine',
    'Industrial sewing machine', 'Overlocker', 'Steam iron',
    'Tailor scissors', 'Tailor measuring tape', 'Tailor chalk', 'Pattern paper pack',
    'Pressing cloth', 'Embroidery hoop', 'Seam ripper', 'Machine needle pack',
    'Machine oil bottle', 'Bobbin pack',
  ], { unit: 'piece' });
  cross('NG_SEWING', ['Embroidery thread'], ['black', 'white', 'red', 'blue', 'gold', 'green', 'wine', 'brown'], { unit: 'piece' });

  // ----- cables and fittings: Dei-Dei, the electrical line -----
  cross('NG_ELECTRICAL', ['Cutix', 'Coleman', 'Nigerchin', 'Kabelmetal'], [
    '1.5mm single cable per metre', '2.5mm single cable per metre', '4mm single cable per metre',
    '6mm single cable per metre', '10mm single cable per metre', '16mm single cable per metre',
    '1.5mm twin cable per metre', '2.5mm twin cable per metre', '4mm twin cable per metre',
    '1.5mm 3-core cable per metre', '2.5mm 3-core cable per metre', '4mm 3-core cable per metre',
    '1.5mm coil 100m', '2.5mm coil 100m', '4mm coil 100m', '6mm coil 100m',
  ], { unit: 'piece' });
  cross('NG_ELECTRICAL', ['MK', 'Legrand', 'Local'], [
    '1-gang switch', '2-gang switch', '3-gang switch', '13A socket', '15A socket',
    'ceiling rose fitting', 'lamp holder fitting',
  ], { unit: 'piece' });
  each('NG_ELECTRICAL', [
    'Distribution board 4-way', 'Distribution board 6-way', 'Distribution board 8-way', 'Distribution board 12-way',
    'MCB 10A', 'MCB 16A', 'MCB 20A', 'MCB 32A', 'MCB 63A',
    'Changeover switch 63A', 'Changeover switch 100A',
    'Conduit 20mm length', 'Conduit 25mm length', 'Trunking length',
    'LED floodlight 50W', 'LED floodlight 100W', 'LED floodlight 200W', 'LED panel 60x60',
    'Ceiling fan 48 inch', 'Ceiling fan 56 inch', 'Exhaust fan',
    'Cable lug pack', 'Cable tie pack', 'Insulation tape roll',
  ], { unit: 'piece' });

  // ----- security. Detectors and cameras, not weapons. -----
  each('NG_SECURITY', [
    'Smoke detector', 'Burglar alarm kit', 'Electric fence energizer',
    'Safe box small', 'Safe box medium', 'Safe box large',
    'Fire extinguisher dry powder 2kg', 'Fire extinguisher dry powder 4kg',
    'Fire extinguisher dry powder 6kg', 'Fire extinguisher dry powder 9kg',
    'Fire extinguisher CO2 2kg', 'Fire extinguisher CO2 5kg',
    'Fire blanket', 'Emergency light', 'Padlock hasp',
    'CCTV hard disk 1TB', 'CCTV hard disk 2TB', 'DVR 4-channel', 'DVR 8-channel',
  ], { unit: 'piece' });

  // ----- the machines a shop uses to sell -----
  each('NG_SCALE', [
    'Price computing scale 15kg', 'Price computing scale 30kg',
    'Platform scale 150kg', 'Platform scale 300kg', 'Hanging scale 50kg',
    'Money counter', 'Casio scientific calculator', 'Casio ordinary calculator',
    'Laminating machine', 'Binding machine', 'Laminating film pack',
    'Receipt roll 80mm', 'Receipt roll 57mm', 'Barcode label roll',
    'Label printer', 'Date stamp',
  ], { unit: 'piece' });

  // ----- toys -----
  each('NG_TOY', [
    'Doll', 'Teddy bear', 'Toy car', 'Remote control car', 'Building blocks set',
    'Children bicycle 12 inch', 'Children bicycle 16 inch', 'Children bicycle 20 inch',
    'Skipping rope for children', 'Colouring book', 'Puzzle', 'Toy kitchen set',
    'Football for children', 'Water gun',
  ], { unit: 'piece' });

  // ----- Aba-made and Kano leather, sold as themselves -----
  cross('NG_LEATHER', ['Aba-made cover shoe', 'Aba-made loafer', 'Aba-made corporate shoe', 'Kano leather slipper'], [
    'size 38', 'size 40', 'size 42', 'size 43', 'size 44', 'size 45',
  ], { unit: 'pair' });
  each('NG_LEATHER', [
    'Aba leather belt', 'Aba travelling bag', 'Aba school bag', 'Aba ladies handbag',
    'Kano leather wallet', 'Kano leather pouch', 'Hide per piece',
  ], { unit: 'piece' });

  // ----- thicken the trades that were already on the list -----
  cross('NG_FROZEN', ['Chi', 'Zartech', 'Agric', 'Imported'], [
    'chicken 2kg', 'turkey 5kg', 'croaker 2kg', 'titus 2kg', 'panla 2kg', 'prawns 1kg',
  ], { unit: 'pack', expiry: true });
  each('NG_CEMENT', [
    '4-inch block', '5-inch block', '9-inch solid block', 'Interlock paver grey', 'Interlock paver red',
    'Kerb stone', 'Culvert ring 600mm', 'Culvert ring 900mm', 'Decorative block',
  ], { unit: 'piece' });
  each('NG_CEMENT', [
    'Filling sand per trip', 'Quarry dust per trip', 'Granite dust per trip',
  ], { unit: 'trip' });
  each('NG_CEMENT', ['White cement 1kg'], { unit: 'bag' });
  // "Dangote cement 50kg" may already exist under a longer name. add() skips a duplicate name.
  cross('NG_HOME', ['Rambo plastic', 'Sir Plast'], [
    'bucket 10L', 'bucket 20L', 'basin', 'jerry can 25L', 'dustbin', 'laundry basket',
  ], { unit: 'piece' });
  cross('NG_TOOLS', ['Ingco', 'Total', 'Stanley', 'Bosch'], [
    'claw hammer', 'pliers', 'screwdriver set', 'tape 5m', 'angle grinder', 'drill',
    'spanner set', 'spirit level',
  ], { unit: 'piece' });
  each('NG_FURNITURE', [
    'Foam sheet 1 inch', 'Foam sheet 2 inch', 'Foam sheet 3 inch', 'Foam sheet 4 inch', 'Foam sheet 6 inch',
    'Vitafoam density 18', 'Vitafoam density 21', 'Vitafoam density 23', 'Vitafoam density 26',
    'Office desk 1.2m', 'Office desk 1.5m', 'Executive chair', 'Visitor chair',
    'Filing cabinet 2-drawer', 'Filing cabinet 4-drawer', 'Reception chair',
    'Kitchen cabinet door', 'Wardrobe hinge pair',
  ], { unit: 'piece' });
  cross('NG_PLUMB', ['Twyford', 'Ideal Standard', 'Local ceramic'], [
    'close-coupled WC', 'basin', 'kitchen sink', 'shower tray', 'cistern',
  ], { unit: 'piece' });
  each('NG_STATIONERY', [
    'School report sheet pack', 'Lesson timetable', 'Chalk duster', 'Board ruler',
    'Correction fluid', 'Highlighter', 'File folder', 'Arch file', 'Paper punch',
    'Rubber stamp pad', 'Carbon paper pack',
  ], { unit: 'piece' });
  cross('NG_GAS', ['Nexus cooker', 'Scanfrost cooker', 'Thermocool cooker'], ['2-burner', '3-burner', '4-burner'], { unit: 'piece' });
  each('NG_GAS', [
    'Gas cylinder 50kg', 'Gas burner head', 'Gas lighter',
  ], { unit: 'piece' });
  each('NG_GAS', ['Kerosene 1L'], { unit: 'bottle' });
  each('NG_GAS', ['Charcoal half bag'], { unit: 'bag' });
  cross('NG_CLOTH', ['Ankara gown', 'Native trouser', 'Native shirt', 'School cardigan', 'Hoodie'], [
    'small', 'medium', 'large', 'extra large',
  ], { unit: 'piece' });
  each('NG_AGRO', [
    'Knapsack sprayer 16L', 'Cutlass', 'Hoe', 'Watering can', 'Oil palm seedling', 'Cocoa seedling',
  ], { unit: 'piece' });
  each('NG_AGRO', [
    'Premier Feed chick mash 25kg', 'Premier Feed grower mash 25kg', 'Animal Care layers mash 25kg',
    'Yam sett bag', 'Harvest sack',
  ], { unit: 'bag' });
  each('NG_AGRO', ['Cassava stem bundle'], { unit: 'bundle' });
  each('NG_AGRO', ['Poultry drinker 5L', 'Poultry feeder 5kg'], { unit: 'piece' });
  cross('NG_MOTOR', [
    'Toyota Corolla', 'Toyota Camry', 'Toyota Hilux', 'Honda Accord', 'Nissan Sunny',
    'Peugeot 406', 'Mercedes 190', 'Volkswagen Golf', 'Kia Rio', 'Hyundai Accent',
  ], ['oil filter', 'air filter', 'fuel filter', 'brake pad set', 'shock absorber', 'fan belt', 'headlamp', 'side mirror'], { unit: 'piece' });
  cross('NG_APPLIANCE', ['LG', 'Samsung', 'Hisense', 'Thermocool', 'Midea'], [
    'split AC 1hp', 'split AC 1.5hp', 'split AC 2hp', 'washing machine 6kg', 'washing machine 8kg',
  ], { unit: 'piece' });
  cross('NG_DRINKS', ['Bigi Cola', 'Bigi Apple', 'Bigi Orange', 'La Casera', 'Chi Active', 'Ribena', 'Lucozade'], [
    'pet', 'can', 'pack of 6',
  ], { unit: 'bottle' });
  each('NG_SNACKS', [
    'Kokoro pack', 'Plantain chips branded 80g', 'Super Bite chin chin', 'Peanut 50g sachet',
    'Biscuit assorted carton', 'Chocolate bar', 'Chewing gum pack',
  ], { unit: 'pack', expiry: true });
  cross('NG_POWER', ['Felicity', 'Luminous', 'Mercury'], [
    'lithium battery 100Ah', 'lithium battery 200Ah', 'inverter 1.5kVA', 'inverter 3.5kVA', 'inverter 5kVA',
  ], { unit: 'piece' });
  each('NG_LIGHT', [
    'Rechargeable fan', 'Solar street light 60W', 'Solar street light 100W',
    'Emergency bulb', 'Tube light 4ft', 'Bulkhead light',
  ], { unit: 'piece' });
  cross('NG_FABRIC', ['Lace', 'Velvet', 'George', 'Bazin'], [
    'blue 5 yards', 'gold 5 yards', 'white 5 yards', 'wine 5 yards', 'black 5 yards',
  ], { unit: 'yard' });
  each('NG_BABY', [
    'Baby carrier', 'Baby bath tub', 'Baby high chair', 'Teething toy', 'Baby towel',
  ], { unit: 'piece' });
  each('NG_PAINT', [
    'Paint brush 2 inch', 'Paint brush 4 inch', 'Paint roller 9 inch', 'Roller tray',
    'Sandpaper pack', 'Filler 1kg', 'Thinner 1L', 'Masking tape', 'Paint scraper',
  ], { unit: 'piece' });
  each('NG_TILE', [
    'Tile adhesive 20kg grey', 'Tile adhesive 20kg white', 'Tile cutter', 'Notched trowel',
    'Marble 60x60', 'Granite slab',
  ], { unit: 'piece' });
  each('NG_ACCESSORY', [
    'Oraimo power bank 10000mAh', 'Oraimo power bank 20000mAh', 'Anker power bank 20000mAh',
    'Screen guard pack', 'Phone pouch', 'Bluetooth speaker', 'Earpiece wired', 'Oraimo FreePods',
    'Memory card 32GB', 'Memory card 64GB', 'Memory card 128GB',
    'Phone battery Tecno', 'Phone battery Infinix', 'Phone battery Samsung',
  ], { unit: 'piece' });

  // Shelves that were still too thin for the trade they stand for.
  cross('NG_NYLON', ['Nylon'], ['size 8', 'size 10', 'size 12', 'size 14', 'size 16', 'size 18', 'paint rubber', 'big ghana'], { unit: 'pack' });
  each('NG_FISHING', [
    'Hook size 1 pack', 'Hook size 2 pack', 'Hook size 4 pack', 'Hook size 6 pack', 'Hook size 8 pack',
    'Fishing line 0.20mm', 'Fishing line 0.30mm', 'Fishing line 0.40mm',
    'Life jacket', 'Paddle', 'Anchor', 'Fish basket', 'Bait bucket', 'Fishing knife',
    'Gill net 1 inch', 'Gill net 4 inch', 'Seine net',
  ], { unit: 'piece' });
  each('NG_TOY', [
    'Board game ludo', 'Board game draughts', 'Toy phone', 'Educational tablet toy',
    'Doll house', 'Toy truck', 'Skipping rope plastic', 'Balloon animal pack',
    'Crayon set for children', 'Play dough set', 'Toy drum', 'Kite',
  ], { unit: 'piece' });
  each('NG_POULTRY', [
    'Nipple drinker line', 'Nesting box', 'Egg washer', 'Chick guard',
    'Feeder 3kg', 'Feeder 8kg', 'Feeder 15kg', 'Drinker 3L', 'Drinker 8L', 'Drinker 12L',
    'Perch pole', 'Curtain for poultry house',
  ], { unit: 'piece' });
  each('NG_EVENT', [
    'Canopy 10x20', 'Chair cover white', 'Chair cover gold', 'Round table 4ft', 'Round table 5ft',
    'Rectangular table 6ft', 'Fairy light set', 'Photo backdrop stand', 'Red carpet roll',
    'Ice box 30L', 'Ice box 50L', 'Disposable tablecloth pack', 'Confetti pack',
  ], { unit: 'piece' });
  each('NG_JEWELLERY', [
    'Ijebu beads strand', 'Coral beads medium', 'Coral beads large', 'Bridal beads set',
    'Nose stud', 'Brooch', 'Cufflinks pair', 'Tie pin', 'Pendant', 'Ankle chain',
    'Watch box', 'Jewellery pouch',
  ], { unit: 'piece' });
  cross('NG_ALUMINIUM', ['Louvre window', 'Burglar-proof window'], ['3ft', '4ft', '5ft', '6ft'], { unit: 'piece' });
  each('NG_ALUMINIUM', [
    'Aluminium roofing sheet 0.45mm', 'Aluminium roofing sheet 0.55mm',
    'Glass shelf', 'Mirror sheet', 'Silicone sealant tube',
  ], { unit: 'piece' });
  cross('NG_SEWING', ['Zip'], ['6 inch', '8 inch', '10 inch', '12 inch', '14 inch', 'concealed'], { unit: 'piece' });
  each('NG_SEWING', [
    'Button shirt card', 'Button coat card', 'Press stud card', 'Velcro strip',
    'Tailor dummy', 'Pattern ruler', 'Tracing wheel',
  ], { unit: 'piece' });
  each('NG_BAKERY', [
    'Loaf tin', 'Muffin tin', 'Cake tin 8 inch', 'Cake tin 10 inch',
    'Proofing basket', 'Dough scraper', 'Palette knife', 'Sprinkles pack',
    'Fondant 250g', 'Food colour set',
  ], { unit: 'piece' });
  each('NG_WELD', [
    'Lincoln electrode 2.5mm pack', 'Lincoln electrode 3.2mm pack',
    'Welding rod mild steel', 'Chipping goggles', 'Leather apron',
    'Bench vice 4 inch', 'Bench vice 6 inch', 'Anvil',
  ], { unit: 'piece' });
  each('NG_SCALE', [
    'Kitchen scale 5kg', 'Kitchen scale 10kg', 'Crane scale 1 tonne',
    'Coin counter', 'Cheque printer', 'Barcode scanner wireless',
  ], { unit: 'piece' });
  each('NG_SECURITY', [
    'Fire hose reel', 'Fire alarm bell', 'Door sensor', 'Motion sensor',
    'CCTV monitor 19 inch', 'NVR 8-channel', 'Warning sign fire exit',
  ], { unit: 'piece' });
  each('NG_WORSHIP', [
    'RSV Bible', 'Amplified Bible', 'Islamic cap white', 'Islamic cap coloured',
    'Church fan', 'Pulpit Bible', 'Sunday school book', 'Misbaha 33', 'Misbaha 99',
  ], { unit: 'piece' });
  each('NG_HYGIENE', [
    'Paper towel pack', 'Wet wipes pack', 'Cotton buds pack', 'Dental floss',
    'Liquid soap 500ml', 'Disposable apron pack',
  ], { unit: 'piece' });
  each('NG_FRESH', [
    'Garden egg basket', 'Okra basket', 'Ugwu basket', 'Fresh pepper basket',
    'Cow head', 'Cow tail per kg', 'Shaki per kg', 'Roundabout per kg',
    'Dried stockfish head', 'Smoked catfish per kg', 'Smoked panla per kg',
    'Ofada rice paint bucket',
  ], { unit: 'piece', expiry: true });
  cross('NG_BOOKS', ['BECE past questions'], ['English', 'Mathematics', 'Basic Science', 'Civic Education'], { unit: 'piece' });
  each('NG_SPORT', [
    'Jersey shorts', 'Sports socks pair', 'Captain armband', 'Corner flag',
    'Hand pump', 'Agility cone set', 'Weighted exercise ball',
  ], { unit: 'piece' });
  cross('NG_LEATHER', ['Aba-made sandal', 'Aba-made palm shoe'], ['size 40', 'size 42', 'size 44', 'size 45'], { unit: 'pair' });
  each('NG_WATER', [
    'Geepee tank 750L', 'Geepee tank 2500L', 'Submersible pump 1hp', 'Control box for pump',
    'Non-return valve', 'Foot valve',
  ], { unit: 'piece' });
  each('NG_TIMBER', [
    'Veneer sheet', 'Blockboard 18mm', 'Hardboard 3mm', 'Plywood 2x4 12mm',
    'Softwood batten', 'Hardwood batten',
  ], { unit: 'sheet' });
  // Phones the Nigerian market is selling in 2026 that the first list did not
  // have. Names only. A colour is included only where shops price that colour
  // apart from the others. add() skips a name that is already on the list.
  function handset(brand, model, stores, colours) {
    const paints = colours && colours.length ? colours : [''];
    for (const store of stores) {
      for (const colour of paints) {
        add('NG_PHONE', [brand, model, store, colour].filter(Boolean).join(' '), { brand, unit: 'piece' });
      }
    }
  }

  handset('Apple', 'iPhone 15 (UK used)', ['128GB', '256GB'], ['Black', 'Blue']);
  handset('Apple', 'iPhone 15 Plus (UK used)', ['128GB', '256GB'], ['Black', 'Blue']);
  handset('Apple', 'iPhone 15 Pro (UK used)', ['128GB', '256GB', '512GB'], ['Black', 'Natural']);
  handset('Apple', 'iPhone 15 Pro Max (UK used)', ['256GB', '512GB'], ['Black', 'Blue']);
  handset('Apple', 'iPhone 16 (UK used)', ['128GB', '256GB'], ['Black', 'Pink']);
  handset('Apple', 'iPhone 16 Plus (UK used)', ['128GB', '256GB'], ['Black']);
  handset('Apple', 'iPhone 16 Pro (UK used)', ['128GB', '256GB', '512GB'], ['Black', 'Desert']);
  handset('Apple', 'iPhone 16 Pro Max (UK used)', ['256GB', '512GB'], ['Black', 'Desert']);
  handset('Apple', 'iPhone 16e', ['128GB', '256GB'], ['Black', 'White']);
  handset('Apple', 'iPhone 17', ['256GB', '512GB'], ['Black', 'Blue']);
  handset('Apple', 'iPhone 17 Air', ['256GB', '512GB'], ['Black', 'Blue']);
  handset('Apple', 'iPhone 17 Pro', ['256GB', '512GB', '1TB'], ['Black', 'Silver']);
  handset('Apple', 'iPhone 17 Pro Max', ['256GB', '512GB', '1TB'], ['Silver', 'Orange', 'Blue']);
  handset('Apple', 'iPhone 17e', ['256GB', '512GB'], ['Black', 'White', 'Soft pink']);
  handset('Apple', 'iPhone 18 Pro', ['256GB', '512GB', '1TB'], ['Black', 'Blue']);
  handset('Apple', 'iPhone 18 Pro Max', ['256GB', '512GB', '1TB'], ['Black', 'Blue']);
  // Announced 9 September 2026. Official retail is 23 October; Computer Village
  // already quotes it. One name, not invented storage splits.
  add('NG_PHONE', 'Apple iPhone Duo', { brand: 'Apple', unit: 'piece' });

  handset('Samsung', 'Galaxy S24 (UK used)', ['256GB'], ['Black']);
  handset('Samsung', 'Galaxy S25 (UK used)', ['256GB'], ['Black']);
  handset('Samsung', 'Galaxy S26', ['256GB', '512GB'], ['Black', 'Silver']);
  handset('Samsung', 'Galaxy S26+', ['256GB', '512GB'], ['Black']);
  handset('Samsung', 'Galaxy S26 Ultra', ['256GB', '512GB', '1TB'], ['Black', 'Blue']);
  handset('Samsung', 'Galaxy A06', ['64GB', '128GB'], ['Black']);
  handset('Samsung', 'Galaxy A07', ['128GB'], ['Black']);
  handset('Samsung', 'Galaxy A17', ['128GB', '256GB'], ['Black']);
  handset('Samsung', 'Galaxy A37', ['128GB', '256GB'], ['Black']);
  handset('Samsung', 'Galaxy A57', ['128GB', '256GB'], ['Black']);
  handset('Samsung', 'Galaxy Fold 8', ['256GB', '512GB'], ['Black']);
  handset('Samsung', 'Galaxy Fold 8 Ultra', ['512GB', '1TB'], ['Black']);

  handset('Tecno', 'Camon 40', ['128GB', '256GB'], ['Black']);
  handset('Tecno', 'Camon 50', ['256GB'], ['Black', 'Green']);
  handset('Tecno', 'Camon 50 Pro', ['256GB'], ['Black', 'Blue']);
  handset('Tecno', 'Camon 50 Ultra', ['256GB', '512GB'], ['Black']);
  handset('Tecno', 'Spark 40', ['128GB', '256GB'], ['Black']);
  handset('Tecno', 'Spark 40 Pro', ['128GB', '256GB'], ['Black']);
  handset('Tecno', 'Spark 40 Pro+', ['256GB'], ['Black']);
  handset('Tecno', 'POVA 7', ['128GB', '256GB'], ['Black']);
  handset('Tecno', 'Pop 10', ['64GB', '128GB'], ['Black']);
  handset('Tecno', 'Pop 10C', ['64GB'], ['Black']);

  handset('Infinix', 'Hot 60', ['128GB', '256GB'], ['Black']);
  handset('Infinix', 'Hot 60 Pro+', ['256GB'], ['Black']);
  handset('Infinix', 'Hot 60i', ['128GB'], ['Black']);
  handset('Infinix', 'Note 50', ['256GB'], ['Black']);
  handset('Infinix', 'Note 50 Pro', ['256GB'], ['Black']);
  handset('Infinix', 'Note 60', ['256GB'], ['Black']);
  handset('Infinix', 'Note 60 Pro', ['256GB'], ['Black']);
  handset('Infinix', 'Note Edge', ['256GB'], ['Black']);
  handset('Infinix', 'Zero Flip', ['256GB', '512GB'], ['Black']);
  handset('Infinix', 'Smart 10', ['64GB', '128GB'], ['Black']);
  handset('Infinix', 'Smart 10 HD', ['64GB'], ['Black']);
  handset('Infinix', 'Smart 20', ['128GB'], ['Black']);

  handset('Itel', 'A90', ['64GB', '128GB'], ['Black']);
  handset('Itel', 'A100C', ['64GB'], ['Black']);
  handset('Itel', 'City 100', ['128GB'], ['Black']);
  handset('Itel', 'City 200', ['128GB'], ['Black']);
  handset('Itel', 'S25', ['128GB', '256GB'], ['Black']);
  handset('Itel', 'S26 Ultra', ['256GB'], ['Black']);
  handset('Itel', 'P65', ['128GB'], ['Black']);
  handset('Itel', 'P70', ['128GB'], ['Black']);
  handset('Itel', 'Power 70', ['128GB'], ['Black']);
  handset('Itel', 'A200 Plus', ['128GB'], ['Black']);

  handset('Xiaomi', 'Redmi 15C', ['128GB', '256GB'], ['Black']);
  handset('Xiaomi', 'Redmi A5', ['64GB', '128GB'], ['Black']);
  handset('Xiaomi', 'Redmi Note 14', ['128GB', '256GB'], ['Black']);
  handset('POCO', 'C71', ['128GB'], ['Black']);
  handset('POCO', 'C85', ['256GB'], ['Black']);
  handset('OPPO', 'A6X', ['128GB'], ['Black']);
  handset('Realme', 'C71', ['128GB'], ['Black']);
  handset('Vivo', 'Y04', ['128GB'], ['Black']);
  handset('Vivo', 'Y18', ['128GB'], ['Black']);

  each('NG_ACCESSORY', [
    'Apple AirPods 4', 'Apple AirPods Pro 2', 'Samsung Galaxy Buds 3',
    'Oraimo FreePods 4', 'Tecno Hipods',
  ], { unit: 'piece' });
  each('NG_COMPUTER', [
    'Starlink Standard kit', 'Starlink Mini kit',
    'Apple iPad 10th generation (UK used) 64GB', 'Apple iPad 10th generation (UK used) 256GB',
    'Samsung Galaxy Tab A9 64GB', 'Samsung Galaxy Tab A9 128GB',
  ], { unit: 'piece' });

  // Official iPhone 18 Pro finishes, confirmed by Apple on 9 September 2026
  // and on sale in Ikeja and on Jumia: Black, Silver, Glacier, Burgundy,
  // each in 256GB, 512GB, 1TB and 2TB. The earlier Blue rows stay, because
  // that is the word some Computer Village ads use for Glacier. add() skips
  // a name already on the list. The plain iPhone 18 is not here: Apple has
  // not released it. Shops and Jumia still mark it coming in spring 2027.
  handset('Apple', 'iPhone 18 Pro', ['256GB', '512GB', '1TB', '2TB'], ['Silver', 'Glacier', 'Burgundy']);
  handset('Apple', 'iPhone 18 Pro', ['2TB'], ['Black', 'Blue']);
  handset('Apple', 'iPhone 18 Pro Max', ['256GB', '512GB', '1TB', '2TB'], ['Silver', 'Glacier', 'Burgundy']);
  handset('Apple', 'iPhone 18 Pro Max', ['2TB'], ['Black', 'Blue']);
  // Apple published these. Pre-order 16 October, on sale 23 October.
  handset('Apple', 'iPhone Duo', ['256GB', '512GB', '1TB', '2TB'], ['Star White', 'Night Sky']);

  handset('Samsung', 'Galaxy Z Fold 7', ['256GB', '512GB'], ['Black', 'Blue', 'Silver']);
  handset('Samsung', 'Galaxy Z Fold 7', ['1TB'], ['Black']);
  handset('Samsung', 'Galaxy Z Flip 7', ['256GB', '512GB'], ['Black', 'Blue']);
  handset('Samsung', 'Galaxy Z Flip 7', ['256GB'], ['Coral Red']);

  handset('Infinix', 'Hot 70', ['128GB', '256GB'], ['Black', 'Green', 'Blue']);
  handset('Tecno', 'Spark 50', ['128GB'], ['Black', 'Blue', 'Gray']);
  handset('Tecno', 'Spark 50', ['256GB'], ['Black']);
  handset('Tecno', 'Spark 50 Pro', ['128GB', '256GB'], ['Black']);

  each('NG_ACCESSORY', [
    'Apple AirPods 5 USB-C case',
    'Apple AirPods 5 wireless charging case',
    'Apple AirPods Pro 3',
    'Apple Watch Series 12 GPS 46mm Black',
    'Apple Watch Series 12 GPS 46mm Dark Bronze',
    'Apple Watch Series 12 GPS 46mm Light Gold',
    'Apple Watch Ultra 4 49mm Natural Titanium',
  ], { unit: 'piece' });

}

module.exports = { addTrades };
