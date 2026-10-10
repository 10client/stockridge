'use strict';
// The inbuilt Nigerian market list is a catalogue of names, not a price list,
// and serial numbers are a choice the shop makes afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const market = require('../../domain/nigeriaMarket');

test('the Nigerian market list is thousands of goods, with no prices and no serials', () => {
  assert.ok(market.ITEMS.length >= 4000, `expected the wider market list, got ${market.ITEMS.length}`);
  const skus = new Set();
  const names = new Set();
  for (const item of market.ITEMS) {
    assert.ok(item.sku && item.name && item.category && item.unit, `incomplete row ${JSON.stringify(item)}`);
    assert.equal(skus.has(item.sku), false, `duplicate sku ${item.sku}`);
    skus.add(item.sku);
    assert.equal(names.has(item.name.toLowerCase()), false, `duplicate name ${item.name}`);
    names.add(item.name.toLowerCase());
    assert.equal('price' in item || 'cost' in item || 'selling_price' in item, false, `${item.sku} carries a price`);
    assert.equal(item.requires_serial, undefined, `${item.name} has a serial switched on in the list`);
    assert.ok(market.UNITS[item.unit], `unknown unit ${item.unit} on ${item.name}`);
    assert.ok(item.name.length <= 180, item.name);
  }
  const page = market.search({ q: 'dangote cement', limit: 5 });
  assert.ok(page.total >= 1, 'Dangote cement is not in the market list');
  assert.equal('selling_price' in page.data[0], false);
  assert.equal('price' in page.data[0], false);
  const rice = market.search({ category: 'NG_RICE', limit: 1 });
  assert.ok(rice.total >= 50, 'the rice section is too thin to be a market list');

  assert.equal(market.CATEGORIES.some((c) => c.code === 'NG_COUNTER'), false, 'the pharmacy counter is still on the list');
  for (const word of ['panadol', 'paracetamol', 'ibuprofen', 'benylin']) {
    assert.equal(market.search({ q: word, limit: 5 }).total, 0, `${word} is still on the market list`);
  }
  // Goods that were already on the list keep the SKU a shop may have added.
  assert.equal(market.ITEMS.find((i) => i.name === 'Mama Gold 50kg bag').sku, 'NG-00005');
  assert.equal(market.ITEMS.find((i) => i.name === 'Dangote 3X cement 50kg').sku, 'NG-02044');
  assert.equal(market.ITEMS.find((i) => i.name === 'Gas cylinder 12.5kg').sku, 'NG-02776');
  assert.equal(market.get('NG-02740'), null, 'a retired pharmacy number was given to another good');
  for (const name of ['Apple iPhone 18 Pro 256GB Burgundy', 'Apple iPhone 18 Pro Max 2TB Glacier', 'Apple iPhone Duo 256GB Star White', 'Samsung Galaxy Z Fold 7 512GB Black', 'Infinix Hot 70 256GB Green', 'Tecno Spark 50 128GB Blue', 'Apple AirPods 5 USB-C case', 'Apple Watch Series 12 GPS 46mm Black']) {
    assert.ok(market.ITEMS.some((i) => i.name === name), `${name} is not on the market list`);
  }
  assert.equal(market.ITEMS.some((i) => /^Apple iPhone 18 \d/.test(i.name)), false, 'the plain iPhone 18 is not in shops yet');
  for (const name of ['Hisense chest freezer 249L inverter', 'Lafarge Supaset cement 50kg', 'Virony 60x120 porcelain', 'Moniepoint POS terminal', 'Capri-Sun 200ml', 'Notore urea 50kg', 'Pedrollo 1hp pump', 'Hollandia evaporated 160g tin']) {
    assert.ok(market.ITEMS.some((i) => i.name === name), `${name} is not on the market list`);
    assert.equal(market.ITEMS.find((i) => i.name === name).category === 'NG_PHONE', false, `${name} was filed as a phone`);
  }
  const css = fs.readFileSync(path.join(__dirname, '../../public/css/app.css'), 'utf8');
  assert.match(css, /\.kpis, \.kpi-grid/);
  assert.match(css, /grid > \.card/);
  const views = fs.readdirSync(path.join(__dirname, '../../public/js/views')).filter((f) => f.endsWith('.js'));
  for (const file of views) {
    const src = fs.readFileSync(path.join(__dirname, '../../public/js/views', file), 'utf8');
    assert.equal(src.includes('.kpis{'), false, `${file} still pastes its own card layout over the shared one`);
    assert.equal(src.includes('.kpi-value{'), false, `${file} still restyles every tile`);
  }

  const trades = [
    ['NG_FRESH', 'Benue yam', 40],
    ['NG_HAIR', 'Xpression', 40],
    ['NG_COMPUTER', 'POS terminal', 40],
    ['NG_MOTO', 'Bajaj Boxer', 40],
    ['NG_TIMBER', 'plywood', 30],
    ['NG_ELECTRICAL', 'Cutix', 40],
    ['NG_BOOKS', 'WAEC', 40],
    ['NG_LEATHER', 'Aba-made', 20],
    ['NG_NYLON', 'nylon', 20],
    ['NG_MOTOR', 'Toyota Hilux', 20],
  ];
  for (const [code, word, least] of trades) {
    const page = market.search({ category: code, q: word, limit: 3 });
    assert.ok(page.total >= 1, `${word} is not in ${code}`);
    const section = market.categories().find((c) => c.code === code);
    assert.ok(section && section.count >= least, `${code} has ${section && section.count}, expected at least ${least}`);
    assert.equal('price' in page.data[0], false);
  }
});

test('the catalogue screen toggles serial on the product, and the till refuses an unpriced item', () => {
  const products = fs.readFileSync(path.join(__dirname, '../../public/js/views/products.js'), 'utf8');
  const pos = fs.readFileSync(path.join(__dirname, '../../public/js/views/pos.js'), 'utf8');
  assert.match(products, /Serial off/);
  assert.match(products, /Use a serial number on this product/);
  assert.match(products, /\/api\/market-catalogue/);
  assert.match(pos, /has no price/);
});
