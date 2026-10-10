'use strict';
// The inbuilt Nigerian market list is a catalogue of names, not a price list,
// and serial numbers are a choice the shop makes afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const market = require('../../domain/nigeriaMarket');

test('the Nigerian market list is thousands of goods, with no prices and no serials', () => {
  assert.ok(market.ITEMS.length >= 2000, `expected thousands of goods, got ${market.ITEMS.length}`);
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
});

test('the catalogue screen toggles serial on the product, and the till refuses an unpriced item', () => {
  const products = fs.readFileSync(path.join(__dirname, '../../public/js/views/products.js'), 'utf8');
  const pos = fs.readFileSync(path.join(__dirname, '../../public/js/views/pos.js'), 'utf8');
  assert.match(products, /Serial off/);
  assert.match(products, /Use a serial number on this product/);
  assert.match(products, /\/api\/market-catalogue/);
  assert.match(pos, /has no price/);
});
