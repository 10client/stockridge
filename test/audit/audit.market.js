'use strict';
// =====================================================================
// test/audit/audit.market.js — SERIAL ON THE PRODUCT, AND THE MARKET LIST
// =====================================================================
// Two decisions, checked in both directions.
//
//   A serial number is a switch on the product. Off, that product is sold
//   without a number, from the catalogue through to the receipt. On, and only
//   when the shop has also turned serials on, the till and the goods receipt
//   ask for one number per unit.
//
//   The Nigerian market list is names, not prices. Adding one copies the name
//   into this shop with no price and with serial off, unless the person adding
//   it turned the switch on for that row.
//
// FRONT TO BACK  the catalogue screen has the switch and the market list, and
//                what it sends is what the server stores and what a later sale
//                is refused or accepted on.
// BACK TO FRONT  a refusal names the product and the missing count; a number
//                that was captured is the number the sale reads back; a price
//                that was never set is not invented; a role that cannot add
//                goods cannot add them.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const ROOT = path.join(__dirname, '..', '..');

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

runAudit('market', async (audit, d) => {
  const owner = d.owner;
  const manager = d.seats.manager;
  const staff = d.seats.staff;
  const branch = d.branchFor(owner) || d.branches[0];
  assert.ok(owner && manager && staff && branch, 'the fixture did not seat an owner, a manager, a cashier and a branch');

  audit.section('The screen the operator actually uses');

  await audit.checkAsync('the catalogue turns serial on or off on the product, and opens the market list', async () => {
    const products = codeOnly(fs.readFileSync(path.join(ROOT, 'public/js/views/products.js'), 'utf8'));
    const pos = codeOnly(fs.readFileSync(path.join(ROOT, 'public/js/views/pos.js'), 'utf8'));
    const state = codeOnly(fs.readFileSync(path.join(ROOT, 'public/js/state.js'), 'utf8'));
    const stock = codeOnly(fs.readFileSync(path.join(ROOT, 'public/js/views/stock.js'), 'utf8'));
    const orders = codeOnly(fs.readFileSync(path.join(ROOT, 'public/js/views/purchase-orders.js'), 'utf8'));
    const print = codeOnly(fs.readFileSync(path.join(ROOT, 'public/js/print.js'), 'utf8'));

    assert.match(products, /Serial off/, 'the catalogue no longer has a Serial off switch');
    assert.match(products, /Use a serial number on this product/, 'the product form no longer says what the serial switch does');
    assert.match(products, /requires_serial: next/, 'the switch no longer writes requires_serial');
    assert.match(products, /\/api\/market-catalogue/, 'the catalogue no longer asks for the Nigerian market list');
    assert.match(products, /serial: state\.serials\.has\(item\.sku\)/, 'adding from the market no longer sends the serial choice for that row');
    assert.match(state, /function usesSerialNumbers\(\)/, 'the till no longer has one place that decides whether serials are on');
    assert.match(pos, /usesSerialNumbers\(\)/, 'the till no longer reads the shop serial switch');
    assert.match(pos, /has no price/, 'the till will ring an item that has no price');
    assert.match(stock, /usesSerialNumbers\(\)/, 'goods received no longer hides the serial box when the shop is off');
    assert.match(stock, /function openSerialsFor\(/, 'goods received lost the way to open the serial box');
    assert.match(stock, /SERIALS_REQUIRED/, 'goods received no longer opens the box when the server asks for numbers');
    assert.match(orders, /usesSerialNumbers\(\)/, 'a purchase-order receipt no longer follows the shop serial switch');
    assert.match(print, /function serialsForItem\(/, 'the receipt no longer knows which numbers belong to which line');
  });

  audit.section('The market list, read back as stored');

  const listed = await audit.captureAsync('the market list is thousands of goods and quotes no price', async () => {
    const res = await owner.get('/api/market-catalogue?limit=5');
    assert.equal(res.status, 200, `the list answered ${res.status}: ${String(res.text).slice(0, 180)}`);
    assert.ok(Number(res.json.count) >= 2000, `the list holds ${res.json.count}, not thousands`);
    assert.equal(res.json.prices, false, 'the list claims to carry prices');
    const row = (res.json.data || [])[0];
    assert.ok(row && row.sku && row.name, 'the first row has no name');
    for (const key of ['price', 'selling_price', 'cost_price', 'cost']) {
      assert.equal(key in row, false, `the list sent ${key}`);
    }
    assert.ok(Array.isArray(res.json.categories) && res.json.categories.length >= 20, 'the list has no categories to browse');
    return res.json;
  });

  await audit.checkAsync('a search for two words finds the good, and a nonsense word finds nothing', async () => {
    const hit = await owner.get('/api/market-catalogue?q=mama%20gold%2050kg&limit=5');
    assert.equal(hit.status, 200, hit.text.slice(0, 160));
    assert.ok((hit.json.data || []).length >= 1, 'Mama Gold 50kg is not in the market list');
    assert.ok((hit.json.data || []).every((r) => /mama gold/i.test(r.name) && /50kg/i.test(r.name)), 'the search returned a row that is not Mama Gold 50kg');
    const miss = await owner.get('/api/market-catalogue?q=not-a-market-good-xyz&limit=5');
    assert.equal(miss.status, 200, miss.text.slice(0, 160));
    assert.equal((miss.json.data || []).length, 0, 'a word that is not a good still returned rows');
    assert.equal(Number(miss.json.paging && miss.json.paging.total), 0);
  });

  const picked = await audit.captureAsync('a bag of rice and a phone, chosen from the list', async () => {
    const rice = await owner.get('/api/market-catalogue?category=NG_RICE&q=Mama%20Gold%2050kg&limit=5');
    const phone = await owner.get('/api/market-catalogue?category=NG_PHONE&q=Tecno%20Spark%2020%20Black&limit=5');
    const riceRow = (rice.json.data || [])[0];
    const phoneRow = (phone.json.data || [])[0];
    assert.ok(riceRow, 'no rice row to add');
    assert.ok(phoneRow, 'no phone row to add');
    assert.equal(riceRow.unit, 'bag', `rice is counted in ${riceRow.unit}, not a bag`);
    assert.equal(phoneRow.unit, 'piece', `the phone is counted in ${phoneRow.unit}, not a piece`);
    return { rice: riceRow, phone: phoneRow };
  });
  if (!picked) return;

  await audit.refusal('a cashier cannot add goods from the market list', () => staff.post('/api/market-catalogue/adopt', {
    items: [{ sku: picked.rice.sku }],
  }), { code: /ROLE_REQUIRED/ });

  await audit.refusal('adding nothing is refused, and says what to choose', () => owner.post('/api/market-catalogue/adopt', { items: [] }), { code: /MISSING_FIELD/ });

  await audit.refusal('more than 40 at once is refused', () => owner.post('/api/market-catalogue/adopt', {
    items: Array.from({ length: 41 }, () => ({ sku: picked.rice.sku })),
  }), { code: /TOO_MANY/ });

  await audit.refusal('a sku that is not in the list is refused, and nothing is invented', () => owner.post('/api/market-catalogue/adopt', {
    items: [{ sku: 'NG-NOT-A-GOOD' }],
  }), { code: /NOT_IN_MARKET/ });

  const added = await audit.twoWay(
    'adding the rice and the phone stores the names, no price, and the serial choice that was sent',
    () => owner.post('/api/market-catalogue/adopt', {
      items: [
        { sku: picked.rice.sku, serial: false },
        { sku: picked.phone.sku, serial: true },
      ],
    }),
    async (action) => {
      assert.equal(action.status, 201, action.text.slice(0, 240));
      assert.equal(action.json.prices, false);
      const riceId = action.json.added.find((a) => a.sku === picked.rice.sku).id;
      const phoneId = action.json.added.find((a) => a.sku === picked.phone.sku).id;
      const [rice, phone, cats] = await Promise.all([
        owner.get(`/api/products/${encodeURIComponent(riceId)}`),
        owner.get(`/api/products/${encodeURIComponent(phoneId)}`),
        owner.get('/api/categories'),
      ]);
      return { rice, phone, cats, riceId, phoneId };
    },
    ({ rice, phone, cats }) => {
      const riceProduct = rice.json.product || rice.json;
      const phoneProduct = phone.json.product || phone.json;
      assert.equal(Number(riceProduct.selling_price), 0, 'the rice was given a selling price');
      assert.equal(Number(riceProduct.cost_price), 0, 'the rice was given a cost');
      assert.equal(Number(riceProduct.requires_serial), 0, 'serial was switched on for the rice without being asked');
      assert.equal(Number(phoneProduct.requires_serial), 1, 'the phone was added with serial off after the switch was turned on');
      assert.equal(Number(phoneProduct.selling_price), 0, 'the phone was given a selling price');
      const units = rice.json.units || [];
      assert.ok(units.some((u) => String(u.code).toUpperCase() === 'BAG'), `the rice has no bag unit: ${units.map((u) => u.code).join(', ') || 'none'}`);
      assert.ok((cats.json.data || []).some((c) => c.code === 'NG_RICE'), 'the rice category was not created for this shop');
      assert.ok((cats.json.data || []).some((c) => c.code === 'NG_PHONE'), 'the phone category was not created for this shop');
    },
  );
  if (!added) return;

  await audit.twoWay(
    'adding the same rice again does not create a second row',
    () => owner.post('/api/market-catalogue/adopt', { items: [{ sku: picked.rice.sku }] }),
    async () => owner.get(`/api/products?q=${encodeURIComponent(picked.rice.sku)}&limit=20`),
    (list, action) => {
      assert.equal(action.status, 200, action.text.slice(0, 180));
      assert.deepEqual(action.json.already, [picked.rice.sku]);
      const copies = (list.json.data || []).filter((p) => p.sku === picked.rice.sku);
      assert.equal(copies.length, 1, `the catalogue holds ${copies.length} copies of ${picked.rice.sku}`);
    },
  );

  audit.section('Serial on the product, from the catalogue through to the sale');

  await audit.checkAsync('serial numbers are off for a fresh shop', async () => {
    const settings = await owner.get('/api/settings');
    assert.equal(settings.status, 200, settings.text.slice(0, 160));
    assert.equal(Number(settings.json.settings.serial_tracking_enabled), 0, 'a fresh shop is already demanding serial numbers');
  });

  await audit.refusal('a manager cannot turn the shop serial switch on', () => manager.put('/api/settings', { serial_tracking_enabled: 1 }), { code: /ROLE_REQUIRED/ });

  await audit.twoWay(
    'a manager can mark the rice as using a serial number, and the catalogue reads it back',
    () => manager.put(`/api/products/${encodeURIComponent(added.riceId)}`, { requires_serial: 1 }),
    () => owner.get(`/api/products/${encodeURIComponent(added.riceId)}`),
    (read) => {
      const product = read.json.product || read.json;
      assert.equal(Number(product.requires_serial), 1, 'the manager marked the rice and the catalogue still says off');
    },
  );

  await audit.twoWay(
    'the same switch turns it off again',
    () => owner.put(`/api/products/${encodeURIComponent(added.riceId)}`, { requires_serial: 0 }),
    () => owner.get(`/api/products/${encodeURIComponent(added.riceId)}`),
    (read) => {
      const product = read.json.product || read.json;
      assert.equal(Number(product.requires_serial), 0, 'turning the switch off did not stick');
    },
  );

  const tag = Date.now().toString(36).slice(-5).toUpperCase();
  const serialNo = `MKT${tag}-1`;

  await audit.checkAsync('with the shop switch off, a serial-marked phone is received without a number', async () => {
    const res = await owner.post('/api/stock/receive', {
      branch_id: branch.id,
      product_id: added.phoneId,
      quantity: 1,
      unit_code: 'PIECE',
      cost_price: 80000,
      selling_price: 1000,
      reference: `MKT-OFF-${tag}`,
    });
    assert.ok(res.status < 400, `shop serials are off, but receiving was refused ${res.status}: ${String(res.text).slice(0, 220)}`);
  });

  await audit.twoWay(
    'the owner turns serial numbers on for the shop, and the setting reads back on',
    () => owner.put('/api/settings', { serial_tracking_enabled: 1 }),
    () => owner.get('/api/settings'),
    (read) => {
      assert.equal(Number(read.json.settings.serial_tracking_enabled), 1, 'the shop switch did not stay on');
    },
  );

  await audit.checkAsync('the phone, now that the shop uses serials, is refused without a number and the refusal counts', async () => {
    const res = await owner.post('/api/stock/receive', {
      branch_id: branch.id,
      product_id: added.phoneId,
      quantity: 1,
      unit_code: 'PIECE',
      cost_price: 80000,
      selling_price: 1000,
      reference: `MKT-ON-${tag}`,
    });
    assert.equal(res.status, 400, `answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    assert.equal(res.json.code, 'SERIALS_REQUIRED', `refused as ${res.json.code}`);
    const msg = String(res.json.error || '');
    assert.match(msg, /serial-tracked/, `the refusal does not say why: ${msg.slice(0, 160)}`);
    assert.match(msg, /1 expected/, `the refusal does not say how many: ${msg.slice(0, 180)}`);
    assert.match(msg, /0 given/, `the refusal does not say none were given: ${msg.slice(0, 180)}`);
  });

  await audit.checkAsync('the rice, with serial off, is still received without a number', async () => {
    const res = await owner.post('/api/stock/receive', {
      branch_id: branch.id,
      product_id: added.riceId,
      quantity: 1,
      unit_code: 'BAG',
      cost_price: 70000,
      selling_price: 85000,
      reference: `MKT-RICE-${tag}`,
    });
    assert.ok(res.status < 400, `a product with serial off was refused: ${res.status} ${String(res.text).slice(0, 220)}`);
  });

  await audit.twoWay(
    'the phone is received with its number, and the register reads that number back',
    () => owner.post('/api/stock/receive', {
      branch_id: branch.id,
      product_id: added.phoneId,
      quantity: 1,
      unit_code: 'PIECE',
      cost_price: 80000,
      selling_price: 1000,
      serials: [serialNo],
      reference: `MKT-SN-${tag}`,
    }),
    () => owner.get(`/api/serials?product_id=${encodeURIComponent(added.phoneId)}&branch_id=${encodeURIComponent(branch.id)}&limit=20`),
    (list) => {
      const row = (list.json.data || []).find((r) => r.serial_no === serialNo);
      assert.ok(row, `${serialNo} is not on the register after it was received with the unit`);
      assert.ok(!row.sale_id, `${serialNo} is marked sold before it was sold`);
    },
  );

  await audit.twoWay(
    'the phone is given a price, because an unpriced good must not be rung',
    () => owner.put(`/api/products/${encodeURIComponent(added.phoneId)}`, { selling_price: 120000 }),
    () => owner.get(`/api/products/${encodeURIComponent(added.phoneId)}`),
    (read) => {
      const product = read.json.product || read.json;
      assert.equal(Number(product.selling_price), 120000, 'the price that was set is not the price the catalogue reads back');
    },
  );

  await audit.checkAsync('a sale of the phone with no number is refused, and names the missing number', async () => {
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: added.phoneId, quantity: 1, unit_code: 'PIECE' }],
      payments: [{ method: 'CASH', amount: 120000, cash_tendered: 120000 }],
    }, { idempotencyKey: `mkt-nosn-${tag}` });
    assert.equal(res.status, 400, `a serial-tracked sale with no number answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const msg = String(res.json.error || '');
    assert.match(msg, /serial/i, `the sale refusal does not mention a serial number: ${msg.slice(0, 200)}`);
    assert.match(msg, /Expected 1, got 0/, `the sale refusal does not count: ${msg.slice(0, 220)}`);
  });

  const quoted = await audit.captureAsync('the price the server will charge is read before the money is taken', async () => {
    const preview = await owner.post('/api/sales/preview', {
      branch_id: branch.id,
      lines: [{ product_id: added.phoneId, quantity: 1, unit_code: 'PIECE', serial_numbers: [serialNo] }],
    });
    assert.equal(preview.status, 200, `preview answered ${preview.status}: ${String(preview.text).slice(0, 240)}`);
    const total = Number(preview.json.totals && preview.json.totals.total);
    assert.ok(total > 0, `preview total was ${total}`);
    const catalogue = 120000;
    if (Math.abs(total - catalogue) > 0.01) {
      audit.note(`the catalogue says ₦${catalogue.toLocaleString('en-NG')} and the shelf price the sale will charge is ₦${total.toLocaleString('en-NG')} — the batch price wins, and a till that pays the catalogue figure is refused as overpayment`);
    }
    return total;
  });
  if (!(quoted > 0)) return;

  const sold = await audit.twoWay(
    'the same sale, with the number from the register, is the sale that is read back',
    () => owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: added.phoneId, quantity: 1, unit_code: 'PIECE', serial_numbers: [serialNo] }],
      payments: [{ method: 'CASH', amount: quoted, cash_tendered: quoted }],
    }, { idempotencyKey: `mkt-sn-${tag}` }),
    async (action) => {
      assert.equal(action.status, 201, action.text.slice(0, 300));
      return owner.get(`/api/sales/${encodeURIComponent(action.json.saleId)}`);
    },
    (read) => {
      const serials = read.json.serials || [];
      const hit = serials.find((s) => s.serial_no === serialNo);
      assert.ok(hit, `the sale was recorded and ${serialNo} is not on it. Serials: ${JSON.stringify(serials).slice(0, 180)}`);
      const item = (read.json.items || []).find((i) => String(i.product_id) === String(added.phoneId));
      assert.ok(item, 'the sale has no line for the phone');
      assert.equal(Number(item.quantity), 1);
    },
  );
  if (sold) audit.note(`sold ${serialNo} on receipt ${sold.json && sold.json.sale && sold.json.sale.receipt_no}`);

  await audit.checkAsync('the rice, serial off, sells without a number even though the shop uses serials', async () => {
    const priced = await owner.put(`/api/products/${encodeURIComponent(added.riceId)}`, { selling_price: 85000 });
    assert.equal(priced.status, 200, priced.text.slice(0, 160));
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: added.riceId, quantity: 1, unit_code: 'BAG' }],
      payments: [{ method: 'CASH', amount: 85000, cash_tendered: 85000 }],
    }, { idempotencyKey: `mkt-rice-${tag}` });
    assert.equal(res.status, 201, `rice with serial off was refused ${res.status}: ${String(res.text).slice(0, 240)}`);
    const back = await owner.get(`/api/sales/${encodeURIComponent(res.json.saleId)}`);
    const serials = (back.json.serials || []).filter((s) => String(s.product_id) === String(added.riceId) || /rice|Mama/i.test(String(s.product_name || '')));
    assert.equal(serials.length, 0, 'a product with serial off had a serial written onto the sale');
  });

  audit.section('An unpriced good is not a sale');

  await audit.checkAsync('a market good that still has no price cannot be sold, and the refusal says to set one', async () => {
    const bare = await owner.get('/api/market-catalogue?category=NG_OIL&q=Devon%201L&limit=3');
    const row = (bare.json.data || [])[0];
    assert.ok(row, 'no oil row to try an unpriced sale against');
    const adopt = await owner.post('/api/market-catalogue/adopt', { items: [{ sku: row.sku, serial: false }] });
    assert.ok(adopt.status < 300, adopt.text.slice(0, 200));
    const id = adopt.json.added[0].id;
    const received = await owner.post('/api/stock/receive', {
      branch_id: branch.id,
      product_id: id,
      quantity: 1,
      unit_code: String(row.unitName || 'BOTTLE').toUpperCase() === 'BOTTLE' ? 'BOTTLE' : 'PIECE',
      cost_price: 1000,
      selling_price: 0,
      reference: `MKT-NOPRICE-${tag}`,
    });
    // The unit code is whatever the list named. If the receipt was refused for the unit, say so
    // rather than blaming the price rule.
    if (received.status >= 400 && received.json.code !== 'NO_PRICE') {
      const detail = await owner.get(`/api/products/${encodeURIComponent(id)}`);
      const code = ((detail.json.units || [])[0] || {}).code;
      const again = await owner.post('/api/stock/receive', {
        branch_id: branch.id, product_id: id, quantity: 1, unit_code: code,
        cost_price: 1000, selling_price: 0, reference: `MKT-NOPRICE2-${tag}`,
      });
      assert.ok(again.status < 400, `could not put the unpriced good on the shelf to try selling it: ${again.status} ${String(again.text).slice(0, 200)}`);
    }
    const sale = await owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 1, cash_tendered: 1 }],
    }, { idempotencyKey: `mkt-noprice-${tag}` });
    assert.equal(sale.status, 400, `an unpriced good was sold: ${sale.status} ${String(sale.text).slice(0, 240)}`);
    const msg = String(sale.json.error || '');
    assert.match(msg, /price/i, `the refusal does not tell the cashier to set a price: ${msg.slice(0, 220)}`);
    assert.match(String(sale.json.code || ''), /NO_PRICE|SALE_PREPARATION_FAILED/, `refused as ${sale.json.code}, not as a missing price`);
    if (sale.json.code === 'SALE_PREPARATION_FAILED') {
      assert.match(msg, /no price/i, `the preparation failure is not the missing price: ${msg.slice(0, 220)}`);
    }
  });
}, {
  setup: () => startDeployment({
    label: 'market',
    businesses: [{
      name: 'Market Audit Provisions',
      profileCode: 'WHOLESALE_RETAIL',
      vatRegistered: false,
      branches: [
        { name: 'Market Audit Store', code: 'MKT-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'mkt-owner', pin: '94181', branchIndex: 0, full_name: 'Market Audit Owner' },
      { as: 'manager', role: 'MANAGER', username: 'mkt-manager', pin: '73041', branchIndex: 0, full_name: 'Market Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'mkt-staff', pin: '73041', branchIndex: 0, full_name: 'Market Audit Cashier' },
    ],
  }),
});
