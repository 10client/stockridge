'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const verticals = require('../../domain/verticals');
const { modulesFor } = require('../../domain/modules');

test('a module belongs to the business that uses it', () => {
  const pharma = modulesFor(verticals.getProfile('PHARMACEUTICAL'));
  const shop = modulesFor(verticals.getProfile('SUPERMARKET'));
  const event = modulesFor(verticals.getProfile('EVENT_RENTAL'));
  const electronics = modulesFor(verticals.getProfile('ELECTRONICS'));
  const general = modulesFor(verticals.getProfile('GENERAL_RETAIL'));

  assert.equal(pharma.nafdac, true);
  assert.equal(pharma.dispensing, true);
  assert.equal(pharma.hireBook, false);
  assert.equal(pharma.warranty, false);

  assert.equal(shop.nafdac, false, 'a supermarket is not the Greenbook');
  assert.equal(shop.hireBook, false);
  assert.equal(shop.expiry, true);

  assert.equal(event.hireBook, true);
  assert.equal(event.hire, true);
  assert.equal(event.nafdac, false);
  assert.equal(event.dispensing, false);

  assert.equal(electronics.warranty, true);
  assert.equal(electronics.serials, true);
  assert.equal(electronics.instalments, true);
  assert.equal(electronics.nafdac, false);

  assert.equal(general.nafdac, false, 'turning every switch on does not open the Greenbook');
});

test('the shell and the catalogue ask before showing a module', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
  const products = fs.readFileSync(path.join(__dirname, '../../public/js/views/products.js'), 'utf8');
  assert.match(app, /module: 'hireBook'/);
  assert.match(app, /moduleOn\(route\.module\)/);
  assert.match(products, /moduleOn\('nafdac'\)/);
  assert.equal(products.includes('openGreenbook'), false);
});
