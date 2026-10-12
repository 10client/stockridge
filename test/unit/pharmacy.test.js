'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pharmacy = require('../../domain/pharmacy');
const uom = require('../../domain/uom');
const verticals = require('../../domain/verticals');

test('pharmacy: an unmarked product is not a dispense', () => {
  const result = pharmacy.assertDispense({ name: 'Chair', dispensing_class: null, is_controlled: 0 }, {});
  assert.equal(result.prescription, null);
  assert.equal(result.kyc, null);
});

test('pharmacy: POM without a prescriber is refused, and an empty object is not a name', () => {
  const product = { name: 'Amikacin Injection', dispensing_class: 'POM', is_controlled: 0 };
  assert.throws(() => pharmacy.assertDispense(product, {}), (e) => e.code === 'PRESCRIPTION_REQUIRED');
  assert.throws(() => pharmacy.assertDispense(product, { prescription: {} }), (e) => e.code === 'PRESCRIPTION_REQUIRED');
  assert.throws(() => pharmacy.assertDispense(product, { prescription: { prescriber_name: '   ' } }), (e) => e.code === 'PRESCRIPTION_REQUIRED');
  const ok = pharmacy.assertDispense(product, { prescription: { prescriber_name: ' Dr Ada ' } });
  assert.equal(ok.prescription.prescriber_name, 'Dr Ada');
});

test('pharmacy: a controlled line needs a buyer name and a phone, not a truthy object', () => {
  const product = { name: 'Dolburg 50', dispensing_class: 'POM', is_controlled: 1 };
  const line = { prescription: { prescriber_name: 'Dr Ada' }, controlledKyc: {} };
  assert.throws(() => pharmacy.assertDispense(product, line), (e) => e.code === 'CONTROLLED_KYC_REQUIRED');
  const ok = pharmacy.assertDispense(product, {
    prescription: { prescriber_name: 'Dr Ada' },
    controlledKyc: { buyer_name: 'Emeka', buyer_phone: '08030000000' },
  });
  assert.equal(ok.kyc.buyer_name, 'Emeka');
  assert.equal(ok.kyc.buyer_phone, '08030000000');
});

test('pharmacy: a dated batch is unsellable once the date has passed', () => {
  const batches = [{
    id: 'old', batch_no: 'B-OLD', quantity: 10, quantity_reserved: 0, status: 'ACTIVE',
    expiry_date: '2020-01-01', received_at: '2020-01-01',
  }];
  assert.equal(uom.selectBatchesFifo(batches, 1, { asOf: '2026-10-13' }).ok, false);
  assert.equal(uom.selectBatchesFifo(batches, 1).ok, true, 'callers that do not pass a date keep the old sort');
});

test('verticals: pharmaceutical and supermarket are trades, not a shared market list', () => {
  const pharma = verticals.getProfile('PHARMACEUTICAL');
  const shop = verticals.getProfile('SUPERMARKET');
  assert.equal(pharma.features.dispensing, true);
  assert.ok(pharma.complianceFields.includes('PCN'));
  assert.ok(pharma.complianceFields.includes('NAFDAC_PREMISES'));
  assert.equal(pharma.tradeModes.includes('HIRE'), false);
  assert.equal(shop.features.expiryTracking, true);
  assert.equal(shop.features.serialTracking, false);
  const names = shop.categories.map((c) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.ok(pharma.seedProducts.some((p) => p.controlled && p.dispensing === 'POM'));
  assert.ok(pharma.seedProducts.every((p) => p.nafdacReg), 'starter medicines cite a Greenbook number, they are not invented');
});
