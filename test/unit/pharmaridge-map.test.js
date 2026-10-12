'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NAMED = [
  'test/audit.adminowner.js', 'test/audit.barcode-flow.js', 'test/audit.branchscope.js',
  'test/audit.catalog.js', 'test/audit.concurrency.js', 'test/audit.concurrent-pos-sales.js',
  'test/audit.customers.js', 'test/audit.d1limits.js', 'test/audit.data-management.js',
  'test/audit.docs.js', 'test/audit.e2e.js', 'test/audit.expiry.js', 'test/audit.exports.js',
  'test/audit.frontend.js', 'test/audit.golive.js', 'test/audit.harness.js', 'test/audit.http.js',
  'test/audit.inventory.js', 'test/audit.live.js', 'test/audit.manager.js', 'test/audit.managerstaff.js',
  'test/audit.money.js', 'test/audit.owner.js', 'test/audit.ownermanager.js', 'test/audit.plan-downgrade.js',
  'test/audit.promotionauthority.js', 'test/audit.pwa.js', 'test/audit.responsive.js',
  'test/audit.retail-categories.js', 'test/audit.rolelabels.js', 'test/audit.rolelifecycle.js',
  'test/audit.roles.js', 'test/audit.single-session.js', 'test/audit.staff.js', 'test/audit.staffstaff.js',
  'test/audit.sync.js', 'test/audit.three-month-simulation.js', 'test/audit.vendorseat.js',
  'test/audit.wht.js', 'test/audit.workflows.js', 'test/integration.test.js',
];

test('pharmaridge map names every audit file the dump listed', () => {
  const doc = fs.readFileSync(path.join(__dirname, '../../docs/pharmaridge-test-map.md'), 'utf8');
  const missing = NAMED.filter((name) => !doc.includes(name));
  assert.deepEqual(missing, [], `map is missing ${missing.join(', ')}`);
});
