'use strict';
// =====================================================================
// test/audit/audit.serials.js — THE NUMBER ON THE LABEL, AND WHERE IT IS ENTERED
// =====================================================================
// A serial-tracked product cannot be received without one number per unit. That demand is correct
// and it is the whole value of the register: a serial captured later cannot be matched to the unit
// it came in on, and the warranty claim it is needed for is exactly the one that arrives after the
// box is in the bin.
//
// What this audit exists for is the OTHER half of that sentence. A demand a person cannot satisfy
// from the screen in front of them is a dead end, not a control — and that is exactly what was
// reported against this app: the receipt was refused with "1 expected for 1 unit(s), 0 given" and
// there was nowhere on the form to type the number. So this checks the control AND the door:
//
//   FRONT TO BACK  two numbers in, two serials on file, on-hand up by two → a carton of four asks
//                  for four numbers, not one → the register answers for the product and branch.
//   BACK TO FRONT  no numbers is refused and the refusal NAMES the count → one number for a carton
//                  of four is refused → a serial on a product with no serial identity is refused →
//                  the same number twice is refused → and the screen that has to accept them has
//                  the box, opens it, and cannot leave somebody with a refusal and no field.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const ROOT = path.join(__dirname, '..', '..');

runAudit('serials', async (audit, d) => {
  const owner = d.owner;
  const branch = d.branchFor(d.owner) || d.branches[0];

  const products = await audit.captureAsync('a serial-tracked product and one that is not', async () => {
    const res = await owner.get('/api/products?limit=200');
    const rows = (res.json && res.json.data) || [];
    const serial = rows.find((p) => Number(p.requires_serial) === 1 && Number(p.selling_price) > 0);
    const plain = rows.find((p) => !Number(p.requires_serial) && Number(p.selling_price) > 0);
    assert.ok(serial, `the catalogue has no serial-tracked product (${rows.length} row(s)) — this audit cannot check the control the shop depends on for warranties`);
    assert.ok(plain, 'the catalogue has no product WITHOUT serial tracking to compare against');
    return { serial, plain };
  });
  const { serial, plain } = products;

  // A CARTON ON THIS VERTICAL IS FOUR UNITS, so one carton needs four numbers. The audit reads the
  // factor off the product's own ladder rather than assuming it: the point is that the demand is
  // per BASE unit, and the factor is what makes it so.
  const ladder = await audit.captureAsync('the unit ladder the serial demand is counted in', async () => {
    const res = await owner.get(`/api/products/${encodeURIComponent(serial.id)}`);
    const units = (res.json && (res.json.units || (res.json.product && res.json.product.units))) || [];
    const carton = units.find((u) => String(u.code || '').toUpperCase() === 'CARTON');
    return { units, cartonFactor: carton ? Number(carton.quantity_in_base) : 0 };
  });

  const tag = Date.now().toString(36).slice(-5).toUpperCase();
  const serialsFor = (n, prefix = 'AUD') => Array.from({ length: n }, (_, i) => `${prefix}${tag}-${i + 1}`);

  // ------------------------------------------------------------------
  await audit.checkAsync('a serial-tracked receipt without its numbers is refused, and the refusal says how many', async () => {
    const res = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: serial.id, quantity: 1, unit_code: 'PIECE',
      cost_price: Number(serial.cost_price || 1000), selling_price: Number(serial.selling_price),
      reference: `AUDIT-SN-${tag}`,
    });
    assert.equal(res.status, 400, `a receipt of a serial-tracked unit with no numbers answered ${res.status} — an unnumbered unit is one nobody can claim a warranty on`);
    assert.equal(res.json.code, 'SERIALS_REQUIRED', `refused as ${res.json.code}`);
    // THE SENTENCE THE SHOP SEES. It has to name the product, the count it wants and the count it
    // was given, because the person holding the labels needs to know how many lines to type.
    const msg = String(res.json.error || '');
    assert.match(msg, /serial-tracked/, `the refusal does not say the product is serial-tracked: ${msg.slice(0, 160)}`);
    assert.match(msg, /1 expected for 1 unit\(s\), 0 given/, `the refusal does not count what is missing: ${msg.slice(0, 200)}`);
    assert.match(msg, new RegExp(String(serial.name).slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the refusal does not name the product');
    assert.equal(res.json.fields && res.json.fields.serials, '1 required.', `the field hint says ${JSON.stringify(res.json.fields && res.json.fields.serials)}`);
    audit.note(`refusal: ${msg.slice(0, 170)}`);

    // AND NOTHING WAS WRITTEN. A refused receipt that leaves stock behind is worse than a
    // refused one: the shelf and the register disagree and the numbers no longer add up.
    const after = await owner.get(`/api/products/${encodeURIComponent(serial.id)}`);
    const stock = Number((after.json && (after.json.onHand !== undefined ? after.json.onHand : (after.json.product || {}).onHand)) || 0);
    const before = await owner.get(`/api/serials?product_id=${encodeURIComponent(serial.id)}&limit=1`);
    audit.note(`on hand now ${stock}; register reaches ${(before.json.data || []).length} row(s) for this product`);
  });

  // ------------------------------------------------------------------
  await audit.checkAsync('two numbers in, two serials on file, and the shelf agrees', async () => {
    const pair = serialsFor(2);
    const res = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: serial.id, quantity: 2, unit_code: 'PIECE',
      cost_price: Number(serial.cost_price || 1000), selling_price: Number(serial.selling_price),
      reference: `AUDIT-SN-${tag}`, serials: pair,
    });
    assert.ok(res.status < 400, `receiving two units with two numbers answered ${res.status}: ${String(res.text).slice(0, 220)}`);
    const serials = res.json.serials || res.json.serial_numbers || [];
    audit.note(`received 2 of ${serial.name} with ${JSON.stringify(pair)}`);

    // THE REGISTER IS THE PROOF, not the receipt's own answer: a row per unit, each on the shelf,
    // each reachable by the number printed on it.
    const listed = await owner.get(`/api/serials?product_id=${encodeURIComponent(serial.id)}&branch_id=${encodeURIComponent(branch.id)}&limit=200`);
    assert.equal(listed.status, 200, `the serial register answered ${listed.status}`);
    const rows = listed.json.data || [];
    for (const sn of pair) {
      const row = rows.find((r) => String(r.serial_no) === sn);
      assert.ok(row, `the serial ${sn} is not in the register after being received with the unit it came in on`);
      assert.ok(!row.sale_id, `the serial ${sn} is on file as sold before it was ever sold`);
      assert.equal(String(row.status || '').toUpperCase(), 'IN_STOCK', `the serial ${sn} is on file as ${row.status}`);
    }

    // AND ONE OF THEM ANSWERS BY ITS OWN NUMBER — the lookup the counter does when a customer
    // walks in with a unit and a claim.
    const one = await owner.get(`/api/serials/${encodeURIComponent(pair[0])}`);
    assert.ok(one.status < 400, `looking up the serial ${pair[0]} answered ${one.status}: ${String(one.text).slice(0, 160)}`);
    audit.note(`looked up ${pair[0]}: ${JSON.stringify(one.json.serial || one.json.data || {}).slice(0, 120)}`);

    if (serials.length) assert.ok(serials.length === 2, `the receipt answered ${serials.length} serial(s) for two units`);
  });

  // ------------------------------------------------------------------
  await audit.checkAsync('a carton asks for one number per unit inside it, not one per carton', async () => {
    if (!ladder.cartonFactor || ladder.cartonFactor < 2) { audit.skip('this product has no carton on its ladder'); return; }
    const factor = ladder.cartonFactor;

    // ONE NUMBER FOR A CARTON OF FOUR IS REFUSED — and refused with FOUR in the sentence, because
    // the count is base units. The screen told the operator "1 expected" for exactly this case,
    // which is how a clerk ends up arguing with a form that is counting a different thing.
    const thin = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: serial.id, quantity: 1, unit_code: 'CARTON',
      cost_price: Number(serial.cost_price || 1000) * factor, selling_price: Number(serial.selling_price) * factor,
      reference: `AUDIT-SN-${tag}-C`, serials: serialsFor(1, 'AUDC'),
    });
    assert.equal(thin.status, 400, `a carton of ${factor} units with ONE number answered ${thin.status} — a carton is ${factor} units and each of them can be claimed on separately`);
    assert.equal(thin.json.code, 'SERIALS_REQUIRED', `refused as ${thin.json.code}`);
    assert.match(String(thin.json.error || ''), new RegExp(`${factor} expected for ${factor} unit\\(s\\), 1 given`),
      `the refusal does not count the units inside the carton: ${String(thin.json.error || '').slice(0, 200)}`);

    // THE SAME CARTON WITH FOUR IS ACCEPTED.
    const full = serialsFor(factor, 'AUDF');
    const ok = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: serial.id, quantity: 1, unit_code: 'CARTON',
      cost_price: Number(serial.cost_price || 1000) * factor, selling_price: Number(serial.selling_price) * factor,
      reference: `AUDIT-SN-${tag}-C2`, serials: full,
    });
    assert.ok(ok.status < 400, `a carton with ${factor} numbers answered ${ok.status}: ${String(ok.text).slice(0, 220)}`);
    const listed = await owner.get(`/api/serials?product_id=${encodeURIComponent(serial.id)}&limit=200`);
    const rows = listed.json.data || [];
    for (const sn of full) assert.ok(rows.some((r) => String(r.serial_no) === sn), `the serial ${sn} from the carton is not on file`);
    audit.note(`carton of ${factor}: one number refused, ${factor} numbers accepted`);
  });

  // ------------------------------------------------------------------
  await audit.checkAsync('a number for a unit that has no number is refused, and the same number twice is not two units', async () => {
    // A PRODUCT WITHOUT SERIAL IDENTITY HAS NOWHERE TO FILE ONE. Accepting it silently would put a
    // number in a register that no sale, no warranty and no claim will ever look up again.
    const notExpected = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: plain.id, quantity: 1, unit_code: 'PIECE',
      cost_price: Number(plain.cost_price || 100), selling_price: Number(plain.selling_price),
      reference: `AUDIT-SN-${tag}-P`, serials: serialsFor(1, 'AUDP'),
    });
    assert.equal(notExpected.status, 400, `a serial filed against a product that is not serial-tracked answered ${notExpected.status}`);
    assert.equal(notExpected.json.code, 'SERIALS_NOT_EXPECTED', `refused as ${notExpected.json.code}`);
    assert.match(String(notExpected.json.error || ''), /nowhere to file|Track serial numbers/i,
      'the refusal should tell the shop how to start tracking serials if every unit really is identified');

    // THE SAME NUMBER TWICE IN ONE RECEIPT.
    const dupe = serialsFor(1, 'AUDD');
    const twice = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: serial.id, quantity: 2, unit_code: 'PIECE',
      cost_price: Number(serial.cost_price || 1000), selling_price: Number(serial.selling_price),
      reference: `AUDIT-SN-${tag}-D`, serials: [dupe[0], dupe[0]],
    });
    assert.equal(twice.status, 400, `the same serial entered twice for two units answered ${twice.status}`);
    assert.equal(twice.json.code, 'DUPLICATE_SERIAL_IN_REQUEST', `refused as ${twice.json.code}`);

    // AND A NUMBER ALREADY ON FILE — the same unit received twice, or a duplicated label.
    const again = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: serial.id, quantity: 1, unit_code: 'PIECE',
      cost_price: Number(serial.cost_price || 1000), selling_price: Number(serial.selling_price),
      reference: `AUDIT-SN-${tag}-E`, serials: serialsFor(2).slice(0, 1),
    });
    assert.equal(again.status, 409, `a serial already on file answered ${again.status} instead of 409`);
    assert.equal(again.json.code, 'SERIAL_ALREADY_RECEIVED', `refused as ${again.json.code}`);
    assert.match(String(again.json.error || ''), /already on file/, 'the refusal should say the number is already on file and where');
  });

  // ------------------------------------------------------------------
  await audit.checkAsync('the receiving screen has the box, opens it, and cannot refuse without a field', async () => {
    // THE HALF OF THIS THAT WAS REPORTED BROKEN IS THE SCREEN, so the screen is audited by reading
    // it — and every assertion here is anchored to a named function or call, not to a phrase in a
    // comment. If a future edit deletes the recovery path, this check has to fail.
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'stock.js'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

    assert.match(code, /ui\.field\(\{\s*\n?\s*label: 'Serial numbers', name: 'serials'/, 'the receive form no longer has a serials field');
    assert.match(code, /function openSerialsFor\(/, 'the form no longer has a way to open the serials box for a product the operator typed rather than clicked');
    assert.match(code, /SERIALS_REQUIRED/, 'the receive form no longer recognises the server\'s serials refusal — a refusal that arrives without opening the box leaves nowhere to type');
    assert.match(code, /serialsField\.hidden = false/, 'nothing in the form ever reveals the serials box');
    assert.match(code, /function unitsExpected\(/, 'the form no longer counts the units a receipt is for, so its hint and the server will disagree again');
    assert.match(code, /unitFactors\[/, 'the expected count is no longer taken from the product\'s own ladder — a carton receipt would ask for one number instead of one per unit');
    assert.doesNotMatch(code, /serials\.length !== Math\.ceil\(quantity\)/,
      'the form is back to comparing the numbers against the QUANTITY TYPED rather than the units it is for: receiving one carton of four would ask for one serial');
    // ONE NUMBER PER LINE IS WHAT A SCANNER AND A PASTE BOTH PRODUCE.
    assert.match(code, /split\(\/\[\\n,\\t\]\+\//, 'the serials are no longer split one per line');
  });
}, {
  setup: () => startDeployment({
    label: 'serials',
    businesses: [{
      name: 'Serial Audit Electronics', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Serial Audit Branch', code: 'SN-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'sn-owner', pin: '94181', branchIndex: 0, full_name: 'Serial Audit Owner' },
    ],
  }),
});
