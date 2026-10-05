'use strict';
// =====================================================================
// test/unit/domain.test.js — PURE DOMAIN LOGIC, NO DATABASE, NO NETWORK
// =====================================================================
// This suite runs offline and fast, which is the point: the domain layer is
// where every business rule lives, and a rule that is wrong there is wrong
// on BOTH backends at once. Catching it here costs milliseconds; catching it
// in production costs a reconciliation argument with an accountant.
//
// Every assertion is written with the EXPECTED VALUE STATED EXPLICITLY and
// independently derived in the comment where the arithmetic is non-obvious,
// so a future reader can tell whether a failure means the code broke or the
// expectation was always wrong.
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../../domain/money');
const tax = require('../../domain/nigerianTax');
const uom = require('../../domain/uom');
const validation = require('../../domain/validation');
const instalments = require('../../domain/instalments');
const geofence = require('../../domain/geofence');
const verticals = require('../../domain/verticals');
const pricing = require('../../domain/pricing');
const credit = require('../../domain/credit');
const roles = require('../../domain/roles');
const time = require('../../domain/time');
const hashChain = require('../../domain/hashChain');
const salesService = require('../../server/services/salesService');
const crypto = require('../../domain/crypto');

const FMCG_LADDER = [
  { code: 'PIECE', name: 'Piece', level: 0, quantity_in_base: 1, is_sellable: 1 },
  { code: 'PACK', name: 'Pack', level: 1, quantity_in_base: 6, is_sellable: 1 },
  { code: 'CARTON', name: 'Carton', level: 2, quantity_in_base: 48, is_sellable: 1, is_default_sell: 1 },
];

// ---------------------------------------------------------------------
test('money: half-kobo rounds the way a human expects', () => {
  // 1250.005 * 100 === 125000.49999999999 in IEEE-754, so a bare Math.round
  // gives 125000 -> 1250.00. The epsilon nudge makes it 1250.01.
  assert.equal(money.round2(1250.005), 1250.01);
  assert.equal(money.round2(0.1 + 0.2), 0.3);
  assert.equal(money.round2(-1250.005), -1250.01); // epsilon is added before scaling, so the sign is preserved and the magnitude rounds the same way
});

test('money: allocation foots to the total exactly, remainder on the last part', () => {
  assert.equal(money.sum(money.allocate(1000, [1, 1, 1])), 1000);
  assert.deepEqual(money.allocate(100, [1, 1, 1]), [33.33, 33.33, 33.34]);
  assert.equal(money.sum(money.allocate(10000, [7, 11, 13, 3])), 10000);
  // Zero weights must spread rather than drop the money.
  assert.equal(money.sum(money.allocate(90, [0, 0, 0])), 90);
  assert.deepEqual(money.allocate(0, [1, 2]), [0, 0]);
});

test('money: margin and markup are different numbers and both guard zero cost', () => {
  assert.equal(money.marginPct(80000, 100000), 20);   // profit / PRICE
  assert.equal(money.markupPct(80000, 100000), 25);   // profit / COST
  assert.equal(money.marginPct(0, 100000), null);     // cost unknown, not 100% margin
  assert.equal(money.pctChange(150, 0), null);        // not comparable, distinct from 0%
  assert.equal(money.pctChange(0, 0), 0);
});

test('money: formatting follows Nigerian convention', () => {
  assert.equal(money.formatNaira(1250), '₦1,250');
  assert.equal(money.formatNaira(1250.5), '₦1,250.50');
  assert.equal(money.formatCompact(1250000), '₦1.25m');
  assert.equal(money.formatCompact(-450000), '-₦450k');
});

// ---------------------------------------------------------------------
test('VAT: extraction from an inclusive total, not addition on top', () => {
  // ₦10,750 inclusive at 7.5%: vat = 10750 * 7.5 / 107.5 = 750. net = 10000.
  const r = tax.extractVatFromInclusive({ grossAmount: 10750, ratePercent: 7.5 });
  assert.equal(r.vat, 750);
  assert.equal(r.net, 10000);
  assert.equal(money.round2(r.net + r.vat), 10750);
  // The naive computation would report 806.25 of VAT that was never collected.
  assert.equal(money.round2(10750 * 0.075), 806.25);
  assert.notEqual(r.vat, 806.25);
});

test('VAT: the exclusive direction exists for B2B invoicing and is distinct', () => {
  const r = tax.addVatToExclusive({ netAmount: 10000, ratePercent: 7.5 });
  assert.equal(r.vat, 750);
  assert.equal(r.gross, 10750);
});

test('VAT: zero rate leaves the total untouched', () => {
  const r = tax.extractVatFromInclusive({ grossAmount: 5000, ratePercent: 0 });
  assert.equal(r.vat, 0);
  assert.equal(r.net, 5000);
});

test('VAT: allocation across lines foots to the invoice VAT figure', () => {
  const parts = tax.allocateVatAcrossLines({ totalVat: 750, lineValues: [3000, 5000, 2750] });
  assert.equal(money.sum(parts), 750);
  assert.equal(parts.length, 3);
  // A single line gets the whole amount, not a rounded fraction of it.
  assert.deepEqual(tax.allocateVatAcrossLines({ totalVat: 33.33, lineValues: [100] }), [33.33]);
});

// ---------------------------------------------------------------------
test('WHT: gross = net + wht exactly, derived by subtraction', () => {
  const w = tax.computeWht({ grossAmount: 500000, ratePercent: 2 });
  assert.equal(w.wht, 10000);
  assert.equal(w.net, 490000);
  assert.equal(money.round2(w.net + w.wht), w.gross);
});

test('WHT: an awkward amount still foots, because net is not rounded independently', () => {
  // 333333.33 at 5% = 16666.6665 -> 16666.67. net = 333333.33 - 16666.67.
  const w = tax.computeWht({ grossAmount: 333333.33, ratePercent: 5 });
  assert.equal(money.round2(w.gross - w.net - w.wht), 0);
});

test('WHT: the shipped 2024 schedule carries the documented rates', () => {
  const byCode = Object.fromEntries(tax.WHT_SCHEDULE_2024.map((r) => [r.code, r]));
  assert.equal(byCode.SUPPLY_OF_GOODS.rate_percent, 2.0);      // reduced by the 2024 Regulations
  assert.equal(byCode.PROFESSIONAL_FEES.rate_percent, 5.0);    // reduced from 10%
  assert.equal(byCode.DIRECTORS_FEES.rate_percent, 15.0);      // increased from 10%
  assert.equal(byCode.RENT.rate_percent, 10.0);
  assert.equal(byCode.CONSTRUCTION.direction, 'PAYABLE');
  assert.ok(tax.WHT_SCHEDULE_2024.length >= 9);
});

test('WHT: remittance falls due on the 21st of the following month', () => {
  assert.equal(tax.whtRemittanceDueDate('2026-03-15'), '2026-04-21');
  assert.equal(tax.whtRemittanceDueDate('2026-12-01'), '2027-01-21');
  assert.equal(tax.whtRemittanceDueDate('nonsense'), null);
});

test('WHT: the small-company exemption hint never blocks and names the manufacturer carve-out', () => {
  assert.equal(tax.exemptionHint({ grossAmount: 5000000, counterpartyTin: '12345678' }), null);
  const noTin = tax.exemptionHint({ grossAmount: 500000, counterpartyTin: null });
  assert.match(noTin, /TIN/);
  const manufacturer = tax.exemptionHint({ grossAmount: 500000, counterpartyTin: '12345678', counterpartyIsManufacturer: true });
  assert.match(manufacturer, /NOT liable/);
});

// ---------------------------------------------------------------------
test('UOM: a ladder resolves to base units and stock always decrements in base', () => {
  assert.equal(uom.toBaseUnits({ quantity: 2, unitCode: 'CARTON', ladder: FMCG_LADDER }).baseQuantity, 96);
  assert.equal(uom.toBaseUnits({ quantity: 3, unitCode: 'PACK', ladder: FMCG_LADDER }).baseQuantity, 18);
  assert.equal(uom.toBaseUnits({ quantity: 7, unitCode: 'PIECE', ladder: FMCG_LADDER }).baseQuantity, 7);
});

test('UOM: a fractional discrete quantity is refused with an actionable message', () => {
  const r = uom.toBaseUnits({ quantity: 1.5, unitCode: 'CARTON', ladder: FMCG_LADDER });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FRACTIONAL_DISCRETE_QTY');
  assert.match(r.error, /whole number/);
});

test('UOM: measured goods accept fractions, which is the entire point of them', () => {
  const metreLadder = [{ code: 'METRE', name: 'Metre', level: 0, quantity_in_base: 1, is_sellable: 1 }];
  const r = uom.toBaseUnits({
    quantity: 12.5, unitCode: 'METRE', ladder: metreLadder,
    measure: { axis: 'LENGTH', sellUnitCode: 'METRE', sellUnitBaseFactor: 1 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.baseQuantity, 12.5);
  assert.equal(r.measured, true);
});

test('UOM: a roll of cable converts to metres', () => {
  const cableLadder = [
    { code: 'METRE', name: 'Metre', level: 0, quantity_in_base: 1, is_sellable: 1 },
    { code: 'ROLL', name: 'Roll', level: 1, quantity_in_base: 100, is_sellable: 1 },
  ];
  assert.equal(uom.toBaseUnits({ quantity: 2, unitCode: 'ROLL', ladder: cableLadder }).baseQuantity, 200);
});

test('UOM: an unknown unit names the units that ARE available', () => {
  const r = uom.toBaseUnits({ quantity: 1, unitCode: 'PALLET', ladder: FMCG_LADDER });
  assert.equal(r.ok, false);
  // Both the CODE and the WORD for each level. The words matter because a caller
  // may be holding `base_unit_name` — the receipt word — rather than a code, and
  // "Unknown unit" with only codes listed reads as "you sent nonsense" when the
  // real answer is "you sent the name of a unit that exists".
  for (const expected of ['PIECE', 'PACK', 'CARTON', 'Piece', 'Pack', 'Carton']) {
    assert.match(r.error, new RegExp(`\\b${expected}\\b`), `the message must name ${expected}`);
  }
});

test('UOM: a ladder must start at exactly one base unit', () => {
  const r = uom.buildLadder([{ code: 'CARTON', name: 'Carton', level: 0, quantity_in_base: 48, is_sellable: 1 }]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LADDER_MISSING_BASE');
});

test('UOM: a non-ascending ladder is refused', () => {
  const r = uom.validateLadder([
    { code: 'PIECE', name: 'Piece', quantityInBase: 1 },
    { code: 'CARTON', name: 'Carton', quantityInBase: 48 },
    { code: 'PACK', name: 'Pack', quantityInBase: 6 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LADDER_NOT_ASCENDING');
});

test('UOM: unit cost keeps full precision, because rounding it loses real money', () => {
  // ₦480,000 for 7,000 pieces. Rounded to 68.57 and multiplied back: 479,990.
  const r = uom.splitTotalCost(480000, 7000);
  assert.equal(r.costPerBaseUnit, 480000 / 7000);
  assert.notEqual(r.costPerBaseUnit, 68.57);
  assert.ok(Math.abs(r.costPerBaseUnit * 7000 - 480000) < 1e-9);
});

test('UOM: FIFO consumption takes expiry first, then receipt order', () => {
  const batches = [
    { id: 'late-expiry', quantity: 5, quantity_reserved: 0, status: 'ACTIVE', received_at: '2026-01-01 00:00:00', expiry_date: '2027-06-01', cost_price_per_unit: 100 },
    { id: 'early-expiry', quantity: 5, quantity_reserved: 0, status: 'ACTIVE', received_at: '2026-03-01 00:00:00', expiry_date: '2026-09-01', cost_price_per_unit: 120 },
  ];
  const r = uom.selectBatchesFifo(batches, 8);
  assert.equal(r.ok, true);
  assert.equal(r.picks[0].batch.id, 'early-expiry'); // sell what will go off first
  assert.equal(r.picks[0].quantityBase, 5);
  assert.equal(r.picks[1].batch.id, 'late-expiry');
  assert.equal(r.picks[1].quantityBase, 3);
  assert.equal(r.totalCost, 5 * 120 + 3 * 100); // 900
});

test('UOM: FIFO without expiry falls back to receipt order', () => {
  const batches = [
    { id: 'b', quantity: 5, quantity_reserved: 0, status: 'ACTIVE', received_at: '2026-02-01 00:00:00', cost_price_per_unit: 120 },
    { id: 'a', quantity: 5, quantity_reserved: 0, status: 'ACTIVE', received_at: '2026-01-01 00:00:00', cost_price_per_unit: 100 },
  ];
  const r = uom.selectBatchesFifo(batches, 8);
  assert.equal(r.picks[0].batch.id, 'a');
  assert.equal(r.totalCost, 5 * 100 + 3 * 120); // 860
});

test('UOM: quarantined stock is not available to sell', () => {
  const r = uom.selectBatchesFifo([{ id: 'q', quantity: 5, quantity_reserved: 0, status: 'QUARANTINED', received_at: '2026-01-01' }], 1);
  assert.equal(r.ok, false);
  assert.equal(r.shortfallBase, 1);
});

test('UOM: reserved quantity is already spoken for and is not sellable', () => {
  const r = uom.selectBatchesFifo([{ id: 'r', quantity: 10, quantity_reserved: 10, status: 'ACTIVE', received_at: '2026-01-01' }], 1);
  assert.equal(r.ok, false);
});

test('UOM: a shortfall reports exactly how much is missing', () => {
  const r = uom.selectBatchesFifo([{ id: 'a', quantity: 3, quantity_reserved: 0, status: 'ACTIVE', received_at: '2026-01-01' }], 10);
  assert.equal(r.ok, false);
  assert.equal(r.shortfallBase, 7);
});

test('UOM: weighted-average cost is value over quantity, at full precision', () => {
  const w = uom.weightedAverageCost([
    { quantity: 10, cost_price_per_unit: 100 },
    { quantity: 30, cost_price_per_unit: 140 },
  ]);
  assert.equal(w, (10 * 100 + 30 * 140) / 40); // 130
});

test('UOM: a receipt description is one human sentence', () => {
  assert.equal(
    uom.describeReceipt({ quantity: 2, unitCode: 'CARTON', ladder: FMCG_LADDER }),
    '2 cartons x 48 = 96 pieces',
  );
});

// ---------------------------------------------------------------------
test('validation: Nigerian phone numbers normalise from all four real-world forms', () => {
  for (const input of ['08031234567', '+2348031234567', '2348031234567', '0803 123 4567', '002348031234567']) {
    assert.equal(validation.nigerianPhone(input).value, '08031234567', input);
  }
});

test('validation: a 10-digit phone is refused with the reason, not just "invalid"', () => {
  const r = validation.nigerianPhone('8031234567');
  assert.equal(r.ok, false);
  assert.match(r.error, /missing the leading 0/);
});

test('validation: a plausible-but-wrong network prefix is caught', () => {
  // A transposed digit here means the receipt SMS goes to a stranger.
  const r = validation.nigerianPhone('01234567890');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PHONE_PREFIX');
});

test('validation: TIN, CAC, NIN, BVN and account formats', () => {
  assert.equal(validation.tin('12345678').ok, true);
  assert.equal(validation.tin('1234567').ok, false);
  assert.equal(validation.cacNumber('RC1234567').value, 'RC1234567');
  assert.equal(validation.cacNumber('BN 7654321').value, 'BN7654321');
  assert.equal(validation.cacNumber('nonsense').ok, false);
  assert.equal(validation.nin('12345678901').ok, true);
  assert.equal(validation.nin('1234567890').ok, false);
  assert.equal(validation.bankAccount('0123456789').ok, true);
  assert.equal(validation.bankAccount('123456789').ok, false);
});

test('validation: a BVN is stored as last-4 by default', () => {
  // A BVN is a bank identifier. Storing it whole in a shop's back office is
  // a liability with no operational benefit.
  assert.equal(validation.bvn('12345678901').value, '8901');
  assert.equal(validation.bvn('12345678901', { storeLast4Only: false }).value, '12345678901');
});

test('validation: PIN rejects the patterns people actually choose', () => {
  for (const weak of ['1111', '1234', '4321', '9999', '0000', '2026']) {
    assert.equal(validation.pin(weak).ok, false, weak);
  }
  for (const strong of ['8531', '40729', '913572']) {
    assert.equal(validation.pin(strong).ok, true, strong);
  }
  assert.equal(validation.pin('12a4').ok, false);
  assert.equal(validation.pin('123456789').ok, false); // 9 digits, over the ceiling
});

test('validation: barcode check digits are correct for all four GS1 formats', () => {
  // Published GS1 example codes, one per format the schema accepts. Asserting
  // all four is the point: the weighting parity differs between EAN-8/13 and
  // UPC-A, and an implementation that is right for the one you tested is
  // wrong for the one you shipped.
  assert.equal(validation.eanCheckDigit('061414100001'), 2);   // EAN-13
  assert.equal(validation.eanCheckDigit('400638133393'), 1);   // EAN-13
  assert.equal(validation.eanCheckDigit('9638507'), 4);        // EAN-8
  assert.equal(validation.eanCheckDigit('03600029145'), 2);    // UPC-A
  assert.equal(validation.eanCheckDigit('0001234560001'), 2);  // ITF-14
  assert.equal(validation.barcode('4006381333931').ok, true);
  assert.equal(validation.barcode('4006381333932').ok, false); // one digit off
  assert.equal(validation.barcode('400638133393').ok, false);  // wrong length
});

test('validation: IMEI Luhn check', () => {
  assert.equal(validation.imei('490154203237518').ok, true);
  assert.equal(validation.imei('490154203237519').ok, false);
});

test('validation: a serial number is loose by design, because manufacturers are not consistent', () => {
  assert.equal(validation.serialNumber('AB12-CD34/56').ok, true);
  assert.equal(validation.serialNumber('ab12cd34').value, 'AB12CD34');
  assert.equal(validation.serialNumber('AB1').ok, false);
});

test('validation: an SVG logo is refused even though SVG is a legitimate image format', () => {
  // An SVG can carry a script, and the logo renders in the topbar of every
  // screen. The branding use case does not need SVG; the risk is not worth it.
  const r = validation.logoDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LOGO_SVG_REFUSED');
});

test('validation: a logo must really contain image bytes, not just claim to', () => {
  // "text/html" bytes wearing an image/png MIME type.
  const fake = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
  const r = validation.logoDataUrl(fake);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LOGO_NOT_AN_IMAGE');
});

test('validation: a real PNG data URL is accepted', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const url = `data:image/png;base64,${png.toString('base64')}`;
  assert.equal(validation.logoDataUrl(url).ok, true);
});

test('validation: money input accepts what a cashier actually types', () => {
  assert.equal(validation.money('₦12,500').value, 12500);
  assert.equal(validation.money(' 12500.50 ').value, 12500.5);
  assert.equal(validation.money('-5').ok, false);
  assert.equal(validation.money('abc').ok, false);
});

test('validation: NUBAN is a hint, never a block', () => {
  const r = validation.validateNuban('0019283746', '058');
  assert.equal(r.checked, true);
  assert.equal(r.valid, true); // advisory: valid regardless of the check digit
  const strict = validation.validateNuban('0019283746', '058', { strict: true });
  assert.equal(typeof strict.valid, 'boolean');
});

test('validation: validateBody collects every failure at once', () => {
  const r = validation.validateBody(
    { name: '', phone: '123', amount: 'abc' },
    {
      name: [validation.required, {}],
      phone: [validation.nigerianPhone, {}],
      amount: [validation.money, {}],
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
  const err = validation.validationError(r);
  assert.equal(err.status, 400);
  assert.match(err.message, /3 fields/);
});

// ---------------------------------------------------------------------
test('instalments: a valid plan computes total payable', () => {
  const r = instalments.validatePlan({
    principal: 600000, depositAmount: 180000, interestPercent: 10,
    tenureMonths: 6, frequency: 'MONTHLY',
    settings: { instalment_max_interest_pct: 25, instalment_max_tenure_months: 12, instalment_min_deposit_pct: 20 },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.interestAmount, 60000);
  assert.equal(r.totalPayable, 660000);
  assert.equal(r.financedAmount, 420000);
  assert.equal(r.instalmentCount, 6);
});

test('instalments: a deposit below policy minimum is refused with the required figure named', () => {
  const r = instalments.validatePlan({
    principal: 600000, depositAmount: 60000, tenureMonths: 6,
    settings: { instalment_min_deposit_pct: 20 },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /₦120,000/);
});

test('instalments: the interest cap cannot be exceeded, because that is how a debt becomes unpayable', () => {
  const r = instalments.validatePlan({
    principal: 600000, depositAmount: 200000, interestPercent: 80, tenureMonths: 6,
    settings: { instalment_max_interest_pct: 25 },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /caps instalment interest at 25%/);
});

test('instalments: tenure cap is enforced', () => {
  const r = instalments.validatePlan({
    principal: 100000, depositAmount: 30000, tenureMonths: 36,
    settings: { instalment_max_tenure_months: 12, instalment_min_deposit_pct: 20 },
  });
  assert.equal(r.ok, false);
});

test('instalments: interest as BOTH percent and amount is refused, since they would disagree', () => {
  const r = instalments.validatePlan({
    principal: 100000, depositAmount: 30000, interestPercent: 10, interestAmount: 5000, tenureMonths: 6,
    settings: { instalment_min_deposit_pct: 20 },
  });
  assert.equal(r.ok, false);
});

test('instalments: a deposit covering the whole price is a cash sale, not a plan', () => {
  const r = instalments.validatePlan({ principal: 100000, depositAmount: 100000, tenureMonths: 6, settings: {} });
  assert.equal(r.ok, false);
});

test('instalments: the schedule foots to the financed amount exactly', () => {
  const s = instalments.buildSchedule({ financedAmount: 420000, instalmentCount: 6, scheduleStart: '2026-01-15', frequency: 'MONTHLY' });
  assert.equal(s.length, 6);
  assert.equal(money.sum(s.map((r) => r.amountDue)), 420000);
});

test('instalments: an indivisible amount puts the remainder on the FIRST instalment', () => {
  // ₦100 over 3: 33.33 each leaves 0.01. First gets 33.34.
  const s = instalments.buildSchedule({ financedAmount: 100, instalmentCount: 3, scheduleStart: '2026-01-01', frequency: 'MONTHLY' });
  assert.equal(s[0].amountDue, 33.34);
  assert.equal(s[1].amountDue, 33.33);
  assert.equal(money.sum(s.map((r) => r.amountDue)), 100);
});

test('instalments: month-end dates clamp rather than rolling into the next month', () => {
  // 31 January + 1 month must be 28 February, not 3 March, or a customer is
  // billed a month late.
  const s = instalments.buildSchedule({ financedAmount: 60000, instalmentCount: 3, scheduleStart: '2026-01-31', frequency: 'MONTHLY' });
  assert.equal(s[0].dueDate, '2026-01-31');
  assert.equal(s[1].dueDate, '2026-02-28'); // clamped, February is short
  assert.equal(s[2].dueDate, '2026-03-31'); // ANCHORED, not chained from the 28th
  const four = instalments.buildSchedule({ financedAmount: 40000, instalmentCount: 4, scheduleStart: '2026-01-31', frequency: 'MONTHLY' });
  assert.equal(four[3].dueDate, '2026-04-30'); // April has 30 days, not the 28th
});

test('instalments: weekly frequency produces four instalments per month', () => {
  const s = instalments.buildSchedule({ financedAmount: 40000, instalmentCount: instalments.instalmentCount(2, 'WEEKLY'), scheduleStart: '2026-01-05', frequency: 'WEEKLY' });
  assert.equal(s.length, 8);
  assert.equal(s[1].dueDate, '2026-01-12');
});

test('instalments: a payment is applied oldest-due-first', () => {
  const s = instalments.buildSchedule({ financedAmount: 420000, instalmentCount: 6, scheduleStart: '2026-01-01', frequency: 'MONTHLY' });
  const r = instalments.applyPayment({ schedule: s, amount: 100000 });
  assert.equal(r.schedule[0].status, 'PAID');
  assert.equal(r.schedule[1].amountPaid, 30000);
  assert.equal(r.schedule[1].status, 'PARTIAL');
  assert.equal(r.unallocated, 0);
});

test('instalments: an overpayment is surfaced, never silently absorbed', () => {
  const s = instalments.buildSchedule({ financedAmount: 10000, instalmentCount: 2, scheduleStart: '2026-01-01', frequency: 'MONTHLY' });
  const r = instalments.applyPayment({ schedule: s, amount: 15000 });
  assert.equal(r.unallocated, 5000);
});

test('instalments: plan status is derived from the schedule, not stored twice', () => {
  const s = instalments.buildSchedule({ financedAmount: 30000, instalmentCount: 3, scheduleStart: '2026-01-01', frequency: 'MONTHLY' });
  const paid = instalments.applyPayment({ schedule: s, amount: 30000 });
  const st = instalments.planStatusFromSchedule({ schedule: paid.schedule, totalPayable: 30000 });
  assert.equal(st.isComplete, true);
  assert.equal(st.status, 'COMPLETED');
  assert.equal(st.outstanding, 0);
});

// ---------------------------------------------------------------------
test('geofence: on-site, off-site and no-location all classify without blocking', () => {
  const branch = { name: 'Ikeja', latitude: 6.6018, longitude: 3.3515, geofence_radius_meters: 100, attendance_mode: 'GEOLOCATION' };
  const onSite = geofence.classifyLocation({ branch, latitude: 6.6019, longitude: 3.3516 });
  assert.equal(onSite.status, 'ON_SITE');
  assert.equal(onSite.flagged, false);

  const offSite = geofence.classifyLocation({ branch, latitude: 6.65, longitude: 3.40 });
  assert.equal(offSite.status, 'OFF_SITE');
  assert.equal(offSite.flagged, true); // flagged, NOT rejected
  assert.match(offSite.flagReason, /m from Ikeja/);

  const noLocation = geofence.classifyLocation({ branch, latitude: null, longitude: null });
  assert.equal(noLocation.status, 'NO_LOCATION');
  assert.equal(noLocation.flagged, true);
  assert.match(noLocation.flagReason, /does not by itself mean/);
});

test('geofence: an unconfigured fence says so instead of silently collecting unclassified records', () => {
  const r = geofence.classifyLocation({ branch: { latitude: null, longitude: null }, latitude: 6.6, longitude: 3.3 });
  assert.equal(r.status, 'NOT_CONFIGURED');
  assert.equal(r.needsConfiguration, true);
  assert.equal(r.flagged, false); // the branch is at fault, not the staff member
});

test('geofence: Haversine is sane at Nigerian retail scale', () => {
  // Ikeja (6.6018, 3.3515) to Lekki Phase 1 (6.4281, 3.5817) is roughly 25km.
  const d = geofence.haversineMeters(6.6018, 3.3515, 6.4281, 3.5817);
  assert.ok(d > 15000 && d < 32000, `got ${d}`);
  assert.equal(geofence.haversineMeters(6.6, 3.3, 6.6, 3.3), 0);
  assert.equal(geofence.haversineMeters(999, 3.3, 6.6, 3.3), null);
});

test('geofence: device mode classifies a registered till and flags an unknown one', () => {
  const branch = { attendance_mode: 'REGISTERED_DEVICE', name: 'Onitsha' };
  assert.equal(geofence.classifyDevice({ branch, deviceId: 'abc', registeredDeviceIds: ['abc'] }).status, 'REGISTERED');
  const unknown = geofence.classifyDevice({ branch, deviceId: 'zzz', registeredDeviceIds: ['abc'] });
  assert.equal(unknown.status, 'UNRECOGNIZED');
  assert.equal(unknown.flagged, true);
  assert.equal(geofence.classifyDevice({ branch: { attendance_mode: 'GEOLOCATION' }, deviceId: 'x' }).status, 'NOT_APPLICABLE');
});

test('geofence: (0,0) is recognised as an uninitialised GPS fix, not a place', () => {
  assert.equal(geofence.coordinatesArePlausible(0, 0).plausible, false);
  assert.equal(geofence.coordinatesArePlausible(6.6, 3.3).plausible, true);
  assert.equal(geofence.coordinatesArePlausible(91, 3.3).plausible, false);
});

// ---------------------------------------------------------------------
test('verticals: five profiles ship, and the generic one is the fallback', () => {
  assert.deepEqual([...verticals.PROFILE_CODES].sort(), ['BUILDING_MATERIALS', 'ELECTRONICS', 'FURNITURE', 'GENERAL_RETAIL', 'WHOLESALE_RETAIL']);
  assert.equal(verticals.getProfile('NONSENSE').code, 'GENERAL_RETAIL');
  assert.equal(verticals.DEFAULT_PROFILE_CODE, 'GENERAL_RETAIL');
});

test('verticals: each profile switches on only what its trade needs', () => {
  // A gadget shop needs serials and warranty; a furniture showroom does not
  // serialise a sofa but does deliver and install it.
  assert.equal(verticals.getProfile('ELECTRONICS').features.serialTracking, true);
  assert.equal(verticals.getProfile('ELECTRONICS').features.warranty, true);
  assert.equal(verticals.getProfile('FURNITURE').features.serialTracking, false);
  assert.equal(verticals.getProfile('FURNITURE').features.bulkyDelivery, true);
  assert.equal(verticals.getProfile('BUILDING_MATERIALS').features.measuredSales, true);
  assert.equal(verticals.getProfile('WHOLESALE_RETAIL').features.expiryTracking, true);
  assert.equal(verticals.getProfile('FURNITURE').features.expiryTracking, false);
  // The generic profile assumes nothing and enables everything.
  assert.deepEqual(verticals.getProfile('GENERAL_RETAIL').features, verticals.ALL_FEATURES_ON);
});

test('verticals: compliance fields match the regulator that actually governs the goods', () => {
  assert.ok(verticals.getProfile('ELECTRONICS').complianceFields.includes('SONCAP_DEALER'));
  assert.ok(verticals.getProfile('ELECTRONICS').complianceFields.includes('SCUML')); // high-value goods dealer
  assert.ok(verticals.getProfile('FURNITURE').complianceFields.includes('FORESTRY_PERMIT'));
  assert.ok(verticals.getProfile('WHOLESALE_RETAIL').complianceFields.includes('NAFDAC_PREMISES'));
  assert.ok(verticals.getProfile('BUILDING_MATERIALS').complianceFields.includes('QUARRY_PERMIT'));
  // Every profile carries the universal ones.
  for (const code of verticals.PROFILE_CODES) {
    assert.ok(verticals.getProfile(code).complianceFields.includes('CAC'), code);
    assert.ok(verticals.getProfile(code).complianceFields.includes('TIN'), code);
  }
});

test('verticals: customer classes reflect how each trade actually sells', () => {
  const wholesale = verticals.getProfile('WHOLESALE_RETAIL').customerClasses.map((c) => c.code);
  assert.ok(wholesale.includes('DISTRIBUTOR'));
  const building = verticals.getProfile('BUILDING_MATERIALS').customerClasses.map((c) => c.code);
  assert.ok(building.includes('CONTRACTOR'));
  assert.ok(building.includes('DEVELOPER'));
  // A distributor gets a deeper discount than a walk-in, everywhere.
  for (const code of verticals.PROFILE_CODES) {
    const classes = verticals.getProfile(code).customerClasses;
    const walkIn = classes.find((c) => c.code === 'WALK_IN');
    const deepest = classes.reduce((a, b) => (b.discountPct > a.discountPct ? b : a));
    assert.equal(walkIn.discountPct, 0, code);
    assert.ok(deepest.discountPct > 0, code);
  }
});

test('verticals: per-business overrides merge rather than replace the profile', () => {
  // A furniture business that also sells fridges can turn serials on for
  // itself without the app growing a fifth profile.
  const resolved = verticals.resolveProfile('FURNITURE', { features: { serialTracking: true } });
  assert.equal(resolved.features.serialTracking, true);
  assert.equal(resolved.features.variants, true);           // inherited
  assert.equal(resolved.features.bulkyDelivery, true);      // inherited
  const withCategory = verticals.resolveProfile('FURNITURE', { categories: [{ code: 'APPLIANCES', name: 'Appliances' }] });
  assert.ok(withCategory.categories.some((c) => c.code === 'APPLIANCES'));
  assert.ok(withCategory.categories.some((c) => c.code === 'LIVING_ROOM'));
});

test('verticals: every seeded product has a cost, a price and a valid category', () => {
  for (const code of verticals.PROFILE_CODES) {
    const profile = verticals.getProfile(code);
    const categoryCodes = new Set(profile.categories.map((c) => c.code));
    for (const p of profile.seedProducts) {
      assert.ok(p.name, `${code}: unnamed seed product`);
      assert.ok(p.sku, `${code}: ${p.name} has no SKU`);
      assert.ok(categoryCodes.has(p.category), `${code}: ${p.name} in unknown category ${p.category}`);
      assert.ok(Number(p.cost) > 0, `${code}: ${p.name} has no cost`);
      assert.ok(Number(p.price) > Number(p.cost), `${code}: ${p.name} prices below cost`);
    }
  }
});

// ---------------------------------------------------------------------
test('pricing: resolution order puts a manual price above everything', () => {
  const r = pricing.resolveUnitPrice({
    product: { selling_price: 100 }, batch: { selling_price_per_unit: 120 },
    override: { default_selling_price: 130 }, manualPrice: 90, unitCode: 'PIECE',
  });
  assert.equal(r.source, 'MANUAL');
  assert.equal(r.unitPrice, 90);
});

test('pricing: a branch override beats the batch price', () => {
  const r = pricing.resolveUnitPrice({
    product: { selling_price: 100 }, batch: { selling_price_per_unit: 120 },
    override: { default_selling_price: 130 }, unitCode: 'PIECE',
  });
  assert.equal(r.source, 'OVERRIDE');
  assert.equal(r.unitPrice, 130);
});

test('pricing: a quantity break only applies when the order reaches it', () => {
  const items = [
    { price_list_id: 'pl', unit_code: 'CARTON', min_quantity: 0, price: 4800 },
    { price_list_id: 'pl', unit_code: 'CARTON', min_quantity: 50, price: 4200 },
  ];
  assert.equal(pricing.resolveUnitPrice({ product: {}, unitCode: 'CARTON', quantity: 10, priceListItems: items }).unitPrice, 4800);
  assert.equal(pricing.resolveUnitPrice({ product: {}, unitCode: 'CARTON', quantity: 60, priceListItems: items }).unitPrice, 4200);
});

test('pricing: a price list beats the batch, and the batch beats the catalogue', () => {
  const items = [{ price_list_id: 'pl', unit_code: 'PIECE', min_quantity: 0, price: 110 }];
  assert.equal(pricing.resolveUnitPrice({ product: { selling_price: 100 }, batch: { selling_price_per_unit: 120 }, priceListItems: items, unitCode: 'PIECE' }).source, 'PRICE_LIST');
  assert.equal(pricing.resolveUnitPrice({ product: { selling_price: 100 }, batch: { selling_price_per_unit: 120 }, unitCode: 'PIECE' }).source, 'BATCH');
});

test('pricing: a line total converts units, extracts VAT and snapshots cost', () => {
  const line = pricing.computeSaleLine({
    product: { id: 'p', name: 'TV', category_id: 'c' }, ladder: FMCG_LADDER,
    unitCode: 'CARTON', quantity: 1, unitPrice: 1000, costPerBaseUnit: 15,
    vatEnabled: true, vatRatePercent: 7.5,
  });
  assert.equal(line.quantityInBase, 48);
  assert.equal(line.lineTotal, 1000);
  assert.equal(line.totalCost, 720);            // 48 x 15
  // vat = 1000 * 7.5 / 107.5 = 69.77 (inclusive extraction)
  assert.equal(line.vatAmount, 69.77);
  assert.equal(line.revenueNetOfVat, 930.23);
  assert.equal(line.margin, 210.23);
});

test('pricing: a discount can never make a line negative', () => {
  const line = pricing.computeSaleLine({
    product: { id: 'p', name: 'X' }, ladder: FMCG_LADDER,
    unitCode: 'PIECE', quantity: 1, unitPrice: 100, discountAmount: 500,
  });
  assert.equal(line.lineTotal, 0);
  assert.equal(line.discountAmount, 100); // capped at the line value
});

test('pricing: sale totals are summed from the lines, never recomputed', () => {
  const l1 = pricing.computeSaleLine({ product: { id: 'a' }, ladder: FMCG_LADDER, unitCode: 'PIECE', quantity: 2, unitPrice: 500, costPerBaseUnit: 300 });
  const l2 = pricing.computeSaleLine({ product: { id: 'b' }, ladder: FMCG_LADDER, unitCode: 'PIECE', quantity: 1, unitPrice: 250, costPerBaseUnit: 100 });
  const t = pricing.computeSaleTotals({ lines: [l1, l2], deliveryFee: 2000 });
  assert.equal(t.subtotal, 1250);
  assert.equal(t.total, 3250);
  assert.equal(t.totalCost, 700);
  assert.equal(t.grossMargin, 550); // 1250 revenue + 2000 delivery fee - 700 cost
  assert.equal(t.unitCount, 3);
});

test('pricing: selling below cost warns but does not block', () => {
  const w = pricing.marginWarnings({
    line: { totalCost: 100, revenueNetOfVat: 90, margin: -10, marginPct: -11.11 },
    product: { min_margin_pct: 10 },
  });
  assert.ok(w.some((x) => x.code === 'BELOW_COST'));
  assert.ok(w.some((x) => x.code === 'BELOW_MIN_MARGIN'));
  assert.ok(w.every((x) => x.severity !== 'BLOCK'));
});

// ---------------------------------------------------------------------
test('credit: inside the limit is a silent ALLOW', () => {
  const d = credit.creditDecision({ customer: { credit_limit: 500000 }, currentBalance: 100000, requestedAmount: 50000 });
  assert.equal(d.decision, 'ALLOW');
  assert.equal(d.availableAfter, 350000);
});

test('credit: over the limit WARNs for someone who can override', () => {
  const d = credit.creditDecision({ customer: { name: 'Ada', credit_limit: 500000 }, currentBalance: 480000, requestedAmount: 50000, canOverride: true });
  assert.equal(d.decision, 'WARN');
  assert.equal(d.overBy, 30000);
  assert.match(d.message, /₦30,000/);
});

test('credit: over the limit REQUIREs an override for someone who cannot', () => {
  const d = credit.creditDecision({ customer: { credit_limit: 500000 }, currentBalance: 480000, requestedAmount: 50000, canOverride: false });
  assert.equal(d.decision, 'REQUIRE_OVERRIDE');
});

test('credit: a customer with no limit is a cash customer, which is a different message', () => {
  const d = credit.creditDecision({ customer: { name: 'Bola', credit_limit: 0 }, requestedAmount: 5000, canOverride: false });
  assert.equal(d.decision, 'REQUIRE_OVERRIDE');
  assert.equal(d.code, 'NO_CREDIT_LIMIT');
  assert.match(d.message, /cash customer/);
});

test('credit: ageing buckets a balance oldest-charge-first', () => {
  const today = '2026-10-01';
  const entries = [
    { amount: 100000, entry_date: '2026-09-20', created_at: '2026-09-20' }, // 11 days -> 0-30
    { amount: 200000, entry_date: '2026-08-15', created_at: '2026-08-15' }, // 47 days -> 31-60
    { amount: 300000, entry_date: '2026-05-01', created_at: '2026-05-01' }, // 153 days -> 90+
    { amount: -150000, entry_date: '2026-09-25', created_at: '2026-09-25' },
  ];
  const a = credit.ageBalance(entries, { today });
  // The ₦150,000 payment clears the OLDEST charge (₦300k, 153 days) down to
  // ₦150k rather than being spread across all three, which is what makes the
  // 90+ bucket actionable instead of permanently full.
  assert.equal(a.bucket_90_plus, 150000);
  assert.equal(a.bucket_31_60, 200000);
  assert.equal(a.bucket_0_30, 100000);
  assert.equal(a.total, 450000);
  assert.equal(a.creditBalance, 0);
});

test('credit: terms are capped by account policy, and the cap is reported', () => {
  const t = credit.creditTerms({ customer: { payment_terms_days: 180 }, settings: { credit_max_days: 30 } });
  assert.equal(t.days, 30);
  assert.equal(t.capped, true);
  assert.match(t.message, /capped at 30 days/);
});

// ---------------------------------------------------------------------
test('roles: the hierarchy is a total order and a manager cannot manage a peer', () => {
  assert.ok(roles.outranks('OWNER', 'MANAGER'));
  assert.ok(roles.outranks('MANAGER', 'STAFF'));
  assert.equal(roles.outranks('MANAGER', 'MANAGER'), false);
  assert.equal(roles.outranks('STAFF', 'MANAGER'), false);
});

test('roles: the manager job title is DERIVED from branch_id, never stored', () => {
  assert.equal(roles.managerJobTitle({ role: 'MANAGER', branch_id: null }), 'General Manager');
  assert.equal(roles.managerJobTitle({ role: 'MANAGER', branch_id: 'b1' }), 'Branch Manager');
  // A custom title is displayed but does not change authority.
  assert.equal(roles.managerJobTitle({ role: 'MANAGER', branch_id: 'b1', job_title: 'Operations Supervisor' }), 'Operations Supervisor');
});

test('roles: the ADMIN vendor seat cannot be managed by a client OWNER', () => {
  assert.equal(roles.canManageUser({ id: 'o', role: 'OWNER' }, { id: 'a', role: 'ADMIN' }), false);
  assert.equal(roles.canManageUser({ id: 'a', role: 'ADMIN' }, { id: 'o', role: 'OWNER' }), true);
  assert.equal(roles.canManageUser({ id: 'm1', role: 'MANAGER' }, { id: 'm2', role: 'MANAGER' }), false);
  assert.equal(roles.canManageUser({ id: 'm1', role: 'MANAGER' }, { id: 's1', role: 'STAFF' }), true);
});

test('roles: nobody changes their own role through the management path', () => {
  assert.equal(roles.canManageUser({ id: 'x', role: 'OWNER' }, { id: 'x', role: 'OWNER' }), false);
});

test('roles: navigation is defined for every role and staff see no accounting', () => {
  for (const r of ['ADMIN', 'OWNER', 'MANAGER', 'STAFF']) {
    assert.ok(roles.navigationFor(r).length > 0, r);
  }
  assert.ok(!roles.navigationFor('STAFF').includes('accounting'));
  assert.ok(roles.navigationFor('OWNER').includes('plan'));
  assert.ok(!roles.navigationFor('MANAGER').includes('plan')); // the vendor relationship is the owner's
});

// ---------------------------------------------------------------------
test('time: WAT conversion moves a UTC timestamp forward one hour', () => {
  assert.equal(time.utcToWat('2026-10-05 23:30:00'), '2026-10-06 00:30:00');
  // The bug this prevents: 23:30 UTC on the 5th is 00:30 on the 6th in Lagos,
  // so it must be bucketed under the 6th.
  assert.equal(time.utcToWat('2026-10-05 23:30:00').slice(0, 10), '2026-10-06');
});

test('time: the WAT day-range helper produces UTC bounds for a Lagos day', () => {
  const r = time.watDayRangeUtc('2026-10-05');
  assert.equal(r.startUtc, '2026-10-04 23:00:00');
  assert.equal(r.endUtc, '2026-10-05 22:59:59');
});

test('time: month arithmetic clamps to the last valid day', () => {
  assert.equal(time.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(time.addMonths('2024-01-31', 1), '2024-02-29'); // leap year
  assert.equal(time.addMonths('2026-12-15', 1), '2027-01-15');
});

test('time: an invalid date is a 400, not a crash', () => {
  assert.throws(() => time.watDayRangeUtc('not-a-date'), (e) => e.status === 400);
});

// ---------------------------------------------------------------------
test('crypto: PIN hashing is salted, so the same PIN produces different hashes', async () => {
  const a = await crypto.hashPin('8531');
  const b = await crypto.hashPin('8531');
  assert.notEqual(a.stored, b.stored);
  assert.equal(await crypto.verifyPin('8531', a.stored), true);
  assert.equal(await crypto.verifyPin('8532', a.stored), false);
  assert.equal(await crypto.verifyPin('8531', b.stored), true);
});

test('crypto: a malformed stored hash returns false rather than throwing', async () => {
  for (const bad of [null, '', 'plaintext', 'pbkdf2$sha256$abc', 'md5$x$y$z$w']) {
    assert.equal(await crypto.verifyPin('1234', bad), false, String(bad));
  }
});

test('crypto: hashing stays inside the iteration count every runtime can compute', async () => {
  // THE DEFECT THIS TEST EXISTS FOR, in one line: the Workers WebCrypto
  // implementation throws on any PBKDF2 iteration count above 100,000, and
  // verifyPin turns a throw into `false`. A 120,000-iteration hash therefore
  // worked perfectly on Node — every local test passed — and locked every user
  // out of the deployed Worker with "Username or PIN is incorrect."
  //
  // The constant is asserted, not just the behaviour, because a future edit that
  // raises it would be invisible until a deployment refused to authenticate.
  assert.ok(
    crypto.PBKDF2_ITERATIONS <= 100000,
    `PBKDF2_ITERATIONS is ${crypto.PBKDF2_ITERATIONS}; Cloudflare Workers refuse anything above 100000`,
  );
  assert.equal(crypto.PBKDF2_ITERATIONS, crypto.PBKDF2_MAX_ITERATIONS);

  const hashed = await crypto.hashPin('8531');
  assert.ok(
    hashed.stored.startsWith(`pbkdf2$sha256$${crypto.PBKDF2_ITERATIONS}$`),
    `a written hash must carry the shared count, got ${hashed.stored.slice(0, 24)}`,
  );
});

test('crypto: a stored hash above the platform ceiling is refused, not silently wrong', async () => {
  // The row is present, the format is valid, and this runtime cannot compute it.
  // Returning false is the only safe answer, and it has to be the answer on
  // Node too — otherwise the two backends disagree about the same stored value
  // and "it works on my machine" is the whole bug report.
  const aboveCeiling = `pbkdf2$sha256$${crypto.PBKDF2_MAX_ITERATIONS + 1}$${'A'.repeat(22)}$${'0'.repeat(64)}`;
  assert.equal(await crypto.verifyPin('1234', aboveCeiling), false);

  // A hash written at the ceiling itself must still verify, or the guard is
  // simply a smaller version of the same outage.
  const atCeiling = await crypto.hashPin('1234');
  assert.equal(await crypto.verifyPin('1234', atCeiling.stored), true);
});

test('crypto: token sign/verify round-trips and rejects tampering', async () => {
  const secret = 'test-secret-that-is-long-enough';
  const token = await crypto.signToken({ sub: 'u1', role: 'OWNER' }, secret);
  const payload = await crypto.verifyToken(token, secret);
  assert.equal(payload.sub, 'u1');
  assert.equal(payload.role, 'OWNER');
  assert.ok(payload.exp > payload.iat);

  const parts = token.split('.');
  const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'u1', role: 'ADMIN', exp: 9999999999 })).toString('base64url')}.${parts[2]}`;
  await assert.rejects(() => crypto.verifyToken(tampered, secret), (e) => e.code === 'TOKEN_BAD_SIGNATURE');
  await assert.rejects(() => crypto.verifyToken(token, 'wrong-secret'), (e) => e.code === 'TOKEN_BAD_SIGNATURE');
});

test('crypto: an expired token is refused with a message a cashier understands', async () => {
  const secret = 'test-secret-that-is-long-enough';
  const token = await crypto.signToken({ sub: 'u1' }, secret, { ttlSeconds: -10 });
  await assert.rejects(() => crypto.verifyToken(token, secret), (e) => /expired/i.test(e.message));
});

test('crypto: ids and codes have the expected shapes', () => {
  assert.match(crypto.newId(), /^[0-9a-f]{32}$/);
  assert.equal(crypto.newId().length, 32);
  assert.notEqual(crypto.newId(), crypto.newId());
  assert.match(crypto.shortCode(8), /^[A-Z2-9]{8}$/);
  assert.ok(!/[IO01]/.test(crypto.shortCode(40))); // ambiguous characters excluded
  assert.match(crypto.numericCode(6), /^\d{6}$/);
});

test('crypto: canonical JSON makes key order irrelevant to a request hash', async () => {
  const a = await crypto.hashRequestBody({ amount: 100, method: 'CASH' });
  const b = await crypto.hashRequestBody({ method: 'CASH', amount: 100 });
  assert.equal(a, b); // otherwise an identical retry would execute twice
  const c = await crypto.hashRequestBody({ amount: 101, method: 'CASH' });
  assert.notEqual(a, c);
});

test('crypto: hash chains link, and an edit is detectable', async () => {
  const first = await hashChain.computeRowHash(null, { a: '1', b: '2' });
  const second = await hashChain.computeRowHash(first, { a: '3', b: '4' });
  assert.notEqual(first, second);
  // Editing a payload changes the hash, which invalidates every later row.
  const edited = await hashChain.computeRowHash(null, { a: '1', b: '9' });
  assert.notEqual(first, edited);
  // Field order in the input object does not matter.
  assert.equal(await hashChain.computeRowHash(null, { b: '2', a: '1' }), first);
});

// =====================================================================
// REGRESSION TESTS FOR BUGS FOUND WHILE BUILDING THE SEED
// =====================================================================
// Each of these is a real defect that was shipped, found by driving the code
// rather than reading it, and fixed. They live here so the fix is enforced by
// the suite rather than by somebody remembering.

test('time: utcToWat accepts ISO-8601 with a trailing Z (regression)', () => {
  // This returned null before parseTimestamp existed: the old normaliser did
  // s.replace('T',' ').replace(' ','T') + 'Z', turning an already-Z-terminated
  // ISO string into '...000ZZ' — an Invalid Date. `new Date().toISOString()`
  // is the most common timestamp in the codebase, so the failure was silent
  // and total: timestamps simply vanished into columns as null.
  assert.equal(time.utcToWat('2026-10-05T09:30:00Z'), '2026-10-05 10:30:00');
  assert.equal(time.utcToWat('2026-10-05T09:30:00.000Z'), '2026-10-05 10:30:00');
  assert.equal(time.utcToWat('2026-10-05 09:30:00'), '2026-10-05 10:30:00');
  // An explicit offset is honoured, not treated as UTC.
  assert.equal(time.utcToWat('2026-10-05T09:30:00+01:00'), '2026-10-05 09:30:00');
  assert.equal(time.utcToWat('2026-10-05'), '2026-10-05 01:00:00');
  assert.equal(time.utcToWat(new Date('2026-10-05T09:30:00Z')), '2026-10-05 10:30:00');
  // Unparseable input still returns null rather than throwing or inventing now.
  assert.equal(time.utcToWat('garbage'), null);
  assert.equal(time.utcToWat(null), null);
  assert.equal(time.utcToWat(''), null);
});

test('time: watToDate and parseTimestamp round-trip every accepted form', () => {
  const d = time.watToDate('2026-10-05 10:30:00'); // WAT in, UTC instant out
  assert.equal(d.toISOString(), '2026-10-05T09:30:00.000Z');
  assert.equal(time.parseTimestamp('2026-10-05T09:30:00.000Z').toISOString(), '2026-10-05T09:30:00.000Z');
  // A bare SQLite timestamp is read as UTC, never as the host's local zone.
  // Without that, the same stored string would mean different things on a
  // Lagos server and a Cloudflare edge in Frankfurt.
  assert.equal(time.parseTimestamp('2026-10-05 09:30:00').toISOString(), '2026-10-05T09:30:00.000Z');
  assert.equal(time.parseTimestamp(1791192600000).toISOString(), '2026-10-05T09:30:00.000Z');
  assert.equal(time.parseTimestamp(undefined), null);
});

test('time: minutesBetween is signed and handles ISO Z strings', () => {
  assert.equal(time.minutesBetween('2026-10-05 10:00:00', '2026-10-05 11:30:00'), 90);
  assert.equal(time.minutesBetween('2026-10-05T09:30:00.000Z', '2026-10-05T11:00:00.000Z'), 90);
  // Negative when B precedes A. Callers that need an elapsed duration must
  // clamp at zero themselves — abs() is the wrong clamp, see the next test.
  assert.equal(time.minutesBetween('2026-10-05 11:00:00', '2026-10-05 10:00:00'), -60);
  assert.equal(time.minutesBetween('2026-10-05 10:00:00', null), null);
});

test('time: watDaySql refuses anything that is not a column name', () => {
  assert.equal(time.watDaySql('sold_at'), "date(sold_at, '+1 hours')");
  assert.equal(time.watDaySql('s.sold_at'), "date(s.sold_at, '+1 hours')");
  // The column name is interpolated into SQL, not bound as a parameter, so an
  // unguarded version is an injection hole one careless caller away.
  for (const bad of ['sold_at); DROP TABLE sales;--', '1', 'a b', '', null, undefined, "x'"]) {
    assert.throws(() => time.watDaySql(bad), /INVALID_SQL_COLUMN|column name/, `watDaySql accepted ${JSON.stringify(bad)}`);
  }
});

test('verticals: every shipped unit ladder satisfies validateLadder', () => {
  // LADDERS.BUILDING once read PIECE(1) -> BAG(1) -> TRIP(600). Two levels at
  // one base unit is an alias, not a ladder, and validateLadder rejects it
  // with LADDER_NOT_ASCENDING — so every BUILDING_MATERIALS product
  // provisioned from that data would have failed the moment anything read its
  // units back. Nothing tested the shipped data against the shipped validator.
  for (const [key, ladder] of Object.entries(verticals.LADDERS)) {
    const r = uom.validateLadder(ladder);
    assert.equal(r.ok, true, `LADDERS.${key} is invalid: ${r.code} — ${r.error}`);
  }
  for (const [key, ladder] of Object.entries(verticals.MEASURE_LADDERS)) {
    const r = uom.validateLadder(ladder);
    assert.equal(r.ok, true, `MEASURE_LADDERS.${key} is invalid: ${r.code} — ${r.error}`);
  }
  for (const code of verticals.PROFILE_CODES) {
    const profile = verticals.getProfile(code);
    const r = uom.validateLadder(profile.defaultLadder);
    assert.equal(r.ok, true, `${code}.defaultLadder is invalid: ${r.code} — ${r.error}`);
  }
});

test('verticals: every measure axis has a ladder whose base unit agrees with it', () => {
  // products.base_unit_name, product_units.code (level 0) and
  // product_measures.base_unit_code all have to name the same unit. When they
  // disagree a receipt of "5" is ambiguous — 5 of what? — and stock goes wrong
  // invisibly until the stocktake finds it.
  for (const [axis, def] of Object.entries(verticals.MEASURE_AXES)) {
    const ladder = verticals.MEASURE_LADDERS[axis];
    assert.ok(ladder, `measure axis ${axis} has no ladder`);
    assert.equal(ladder[0].code, def.baseUnitCode, `${axis}: ladder base ${ladder[0].code} != axis base ${def.baseUnitCode}`);
    assert.equal(ladder[0].quantityInBase, 1, `${axis}: level 0 must be exactly 1 base unit`);
    assert.equal(def.baseFactor, 1, `${axis}: baseFactor must be 1 (stock is counted in the sell unit)`);
  }
});

test('verticals: every seed product derives a valid ladder and a known category', () => {
  // This is the data/code drift check: a profile may add a seed product whose
  // category code was never declared, or whose ladder key does not exist. Both
  // fail silently at provisioning time (a NULL category, a fallback ladder)
  // and only surface later as a report with a blank column.
  let seen = 0;
  for (const code of verticals.PROFILE_CODES) {
    const profile = verticals.getProfile(code);
    const categoryCodes = new Set(profile.categories.map((c) => c.code));
    for (const seed of profile.seedProducts) {
      seen += 1;
      const ladder = verticals.ladderForSeedProduct(profile, seed);
      const r = uom.validateLadder(ladder);
      assert.equal(r.ok, true, `${code}/${seed.sku}: ladder invalid — ${r.code} ${r.error}`);
      assert.ok(categoryCodes.has(seed.category), `${code}/${seed.sku}: category "${seed.category}" is not declared on the profile`);
      // base_unit_name is derived from the ladder, so it must equal level 0.
      const base = verticals.baseUnitNameFor(profile, seed);
      assert.equal(base, String(ladder[0].name).toLowerCase(), `${code}/${seed.sku}: base unit "${base}" != ladder level 0 "${ladder[0].name}"`);
      // A measured product's axis must exist.
      if (seed.measured) assert.ok(verticals.MEASURE_AXES[seed.measured], `${code}/${seed.sku}: unknown measure axis ${seed.measured}`);
      // An explicit ladder key must exist, otherwise the fallback hides a typo.
      if (seed.ladder) assert.ok(verticals.LADDERS[seed.ladder], `${code}/${seed.sku}: unknown ladder key ${seed.ladder}`);
      if (seed.registration) {
        assert.ok(verticals.REGISTRATION_AUTHORITIES[seed.registration.authority],
          `${code}/${seed.sku}: unknown registration authority ${seed.registration.authority}`);
      }
      // Money sanity: selling above cost, both positive.
      assert.ok(seed.cost > 0 && seed.price > seed.cost, `${code}/${seed.sku}: cost ${seed.cost} / price ${seed.price} is not a viable margin`);
    }
  }
  assert.ok(seen >= 70, `expected a substantial seed catalogue, saw ${seen} products`);
});

test('verticals: ladderForSeedProduct precedence is explicit > axis > profile', () => {
  const profile = verticals.getProfile('BUILDING_MATERIALS');
  // Explicit ladder key wins even when an axis is present: a merchant selling
  // cable by the 100m roll wants CABLE, not the generic LENGTH ladder.
  assert.equal(verticals.ladderForSeedProduct(profile, { ladder: 'CABLE', measured: 'LENGTH' }), verticals.LADDERS.CABLE);
  // Axis wins over the profile default.
  assert.equal(verticals.ladderForSeedProduct(profile, { measured: 'WEIGHT' }), verticals.MEASURE_LADDERS.WEIGHT);
  // Profile default when neither is given.
  assert.equal(verticals.ladderForSeedProduct(profile, {}), profile.defaultLadder);
  // An unknown ladder key falls back to the profile default rather than
  // crashing provisioning — a typo in seed data must not take down a deployment.
  assert.equal(verticals.ladderForSeedProduct(profile, { ladder: 'NOPE' }), profile.defaultLadder);
  // No seed and no profile default: the single-level EACH_ONLY ladder.
  assert.equal(verticals.ladderForSeedProduct({}, {}), verticals.LADDERS.EACH_ONLY);
});

test('uom: a ladder with two levels at one base unit is rejected', () => {
  // The specific shape that broke BUILDING, asserted directly so the rule is
  // documented next to the validator rather than only in the data.
  const r = uom.validateLadder([
    { code: 'PIECE', name: 'Piece', quantityInBase: 1 },
    { code: 'BAG', name: 'Bag', quantityInBase: 1 },
    { code: 'TRIP', name: 'Trip', quantityInBase: 600 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LADDER_NOT_ASCENDING');
});

test('uom: buildLadder is idempotent — its own output can be fed back in', () => {
  // THE BUG THIS PINS. buildLadder read only snake_case, so a second pass over
  // its own camelCase output produced quantityInBase = NaN for every level, the
  // finite-and-positive filter discarded them all, and a product with a valid
  // two-level ladder was reported as having NO unit of measure and could not be
  // sold. salesService.prepare() builds once and toBaseUnits() builds again, so
  // this is the normal path, not an edge case.
  const dbRows = [
    { id: 'u1', product_id: 'p1', code: 'PIECE', name: 'Unit', plural_name: 'Units', level: 0, quantity_in_base: 1, is_sellable: 1, is_default_sell: 1, is_deleted: 0 },
    { id: 'u2', product_id: 'p1', code: 'CARTON', name: 'Carton', plural_name: 'Cartons', level: 1, quantity_in_base: 4, is_sellable: 1, is_default_sell: 0, is_deleted: 0 },
  ];
  const first = uom.buildLadder(dbRows);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.ladder.length, 2);

  const second = uom.buildLadder(first.ladder);
  assert.equal(second.ok, true, `rebuilding from its own output failed: ${second.code} ${second.error}`);
  assert.deepEqual(second.ladder, first.ladder, 'a second build must be byte-identical to the first');
  assert.equal(second.base.code, 'PIECE');
  assert.equal(second.defaultSell.code, 'PIECE');

  // And the path the sale engine actually takes: build once, then convert.
  const conv = uom.toBaseUnits({ quantity: 2, unitCode: 'CARTON', ladder: first.ladder });
  assert.equal(conv.ok, true, conv.error);
  assert.equal(conv.baseQuantity, 8, 'two cartons is eight units even through the rebuilt ladder');

  // is_default_sell = 0 must survive as FALSE, not be swallowed by a `||`.
  const withZero = uom.buildLadder([
    { code: 'PIECE', name: 'Piece', level: 0, quantity_in_base: 1, is_sellable: 1, is_default_sell: 0 },
    { code: 'CARTON', name: 'Carton', level: 1, quantity_in_base: 48, is_sellable: 1, is_default_sell: 1 },
  ]);
  assert.equal(withZero.ok, true);
  assert.equal(withZero.defaultSell.code, 'CARTON', 'the flagged default sell unit wins over the base unit');
  assert.equal(withZero.base.quantityInBase, 1);
  const rebuilt = uom.buildLadder(withZero.ladder);
  assert.equal(rebuilt.defaultSell.code, 'CARTON', 'the default sell flag must survive a rebuild');

  // A receiving-only unit stays unsellable through a rebuild.
  const receiving = uom.buildLadder([
    { code: 'PIECE', name: 'Piece', level: 0, quantity_in_base: 1, is_sellable: 1, is_default_sell: 1 },
    { code: 'PALLET', name: 'Pallet', level: 1, quantity_in_base: 500, is_sellable: 0, is_default_sell: 0 },
  ]);
  assert.equal(receiving.byCode.PALLET.isSellable, false);
  assert.equal(uom.buildLadder(receiving.ladder).byCode.PALLET.isSellable, false,
    'a receiving-only unit must not become sellable after a rebuild');
  assert.equal(uom.toBaseUnits({ quantity: 1, unitCode: 'PALLET', ladder: receiving.ladder }).code, 'UNIT_NOT_SELLABLE');
});

test('pricing: a NULL pack or carton price derives from the ladder, not from zero', () => {
  // THE BUG. `selling_price_pack` and `selling_price_carton` are nullable and
  // are only set when a merchant prices that level explicitly. They were read
  // with `Number.isFinite(Number(col))`, and Number(null) is 0 — which is
  // finite. So an unset carton price was read as a real price of ZERO: a carton
  // of 48 sold for nothing, the sale totalled zero, the till balanced against
  // it, and stock still fell by 48 units. Nothing looked wrong anywhere except
  // the bank account. Provisioning never sets those columns, so this was the
  // default for every pack- or carton-sold product in a fresh deployment.
  const ladder = [
    { code: 'PIECE', quantityInBase: 1 },
    { code: 'PACK', quantityInBase: 6 },
    { code: 'CARTON', quantityInBase: 48 },
  ];
  const batch = (carton, pack) => ({ selling_price_per_unit: 150, selling_price_carton: carton, selling_price_pack: pack });
  const price = (b, unitCode) => pricing.resolveUnitPrice({ product: { selling_price: 1650 }, batch: b, unitCode, quantity: 1, ladder }).unitPrice;

  assert.equal(price(batch(null, null), 'CARTON'), 7200, '48 pieces at 150 must derive to 7,200 — not 0');
  assert.equal(price(batch(null, null), 'PACK'), 900, '6 pieces at 150 must derive to 900 — not 0');
  assert.equal(price(batch(null, null), 'PIECE'), 150);
  // An explicitly stored price still wins over the derivation.
  assert.equal(price(batch(6800, null), 'CARTON'), 6800, 'a deliberate carton price beats the derived one');
  assert.equal(price(batch(null, 850), 'PACK'), 850);
  // A stored ZERO is honoured: a free promotional item is real, but it has to
  // have been written as 0 rather than arriving as NULL.
  assert.equal(price(batch(0, null), 'CARTON'), 0, 'an explicit free-of-charge carton is respected');
  assert.equal(pricing.storedPrice(null), null);
  assert.equal(pricing.storedPrice(undefined), null);
  assert.equal(pricing.storedPrice(''), null);
  assert.equal(pricing.storedPrice(0), 0);
  assert.equal(pricing.storedPrice('1500'), 1500);
  assert.equal(pricing.storedPrice(NaN), null);
  assert.equal(pricing.storedPrice(-5), null, 'a negative price is not a price');

  // The same trap existed on the branch override path.
  const override = { default_selling_price: 200, carton_price: null, pack_price: null };
  const op = (o, unitCode) => pricing.resolveUnitPrice({ product: {}, override: o, unitCode, quantity: 1, ladder }).unitPrice;
  assert.equal(op(override, 'CARTON'), 9600, 'an unset override carton price derives from the override base price');
  assert.equal(op({ ...override, carton_price: 9000 }, 'CARTON'), 9000);
});

test('sales: a CREDIT payment leg is not money received', () => {
  // A credit leg records "this goes on the customer's account". Counting it as
  // received made a fully-credit sale look fully PAID: balanceDue came out
  // zero, no debtor ledger row was written, revenue was recognised against
  // money that does not exist, and the till claimed cash it never held — so the
  // day's count came out OVER by exactly the credit sales, which is the one
  // variance nobody investigates.
  const totals = { total: 60000 };
  const base = { totals, saleType: 'CREDIT', isCredit: true, settings: {}, user: { role: 'OWNER' }, customer: null, creditInfo: null };

  const allCredit = salesService.validatePayments({ ...base, payments: [{ method: 'CREDIT', amount: 60000 }] });
  assert.equal(allCredit.paid, 0, 'no real money was received');
  assert.equal(allCredit.creditLeg, 60000);
  assert.equal(allCredit.balanceDue, 60000, 'the whole bill is a receivable');

  const partPaid = salesService.validatePayments({ ...base, payments: [{ method: 'CASH', amount: 20000 }, { method: 'CREDIT', amount: 40000 }] });
  assert.equal(partPaid.paid, 20000, 'only the cash leg is payment');
  assert.equal(partPaid.balanceDue, 40000);
  assert.equal(partPaid.tendered, 20000);

  // Cash plus credit must add up to the bill: less is an unrecorded debt, more
  // is money belonging to no bill.
  assert.throws(() => salesService.validatePayments({ ...base, payments: [{ method: 'CASH', amount: 10000 }, { method: 'CREDIT', amount: 40000 }] }),
    (e) => e.code === 'UNDERPAID');
  assert.throws(() => salesService.validatePayments({ ...base, payments: [{ method: 'CASH', amount: 30000 }, { method: 'CREDIT', amount: 40000 }] }),
    (e) => e.code === 'OVERPAID');

  // A non-credit sale may not carry a credit leg at all.
  assert.throws(() => salesService.validatePayments({ ...base, isCredit: false, saleType: 'RETAIL', payments: [{ method: 'CREDIT', amount: 60000 }] }),
    (e) => e.code === 'CREDIT_ON_CASH_SALE');

  // Change owed is money the customer handed over that the shop now holds.
  const owed = salesService.validatePayments({
    ...base, isCredit: false, saleType: 'RETAIL', totals: { total: 2500 },
    payments: [{ method: 'CASH', amount: 3000 }], changeOwed: 500,
  });
  assert.equal(owed.paid, 2500, 'the sale is settled at its own total');
  assert.equal(owed.tendered, 3000, 'but 3,000 physically arrived');
  assert.equal(owed.changeOwed, 500);
  assert.equal(owed.balanceDue, 0, 'change owed is not a debt the customer owes');
  // Without declaring the change owed, the same 3,000 is an overpayment.
  assert.throws(() => salesService.validatePayments({
    ...base, isCredit: false, saleType: 'RETAIL', totals: { total: 2500 }, payments: [{ method: 'CASH', amount: 3000 }],
  }), (e) => e.code === 'OVERPAID');
});

test('time: watToUtc is the exact inverse of utcToWat', () => {
  // This schema stores BOTH zones: sales.sold_at is West Africa Time while
  // created_at / opened_at / closed_at are UTC from datetime('now'). Comparing
  // one against the other is out by an hour, which is enough to attach a sale
  // to the wrong till session at the open/close boundary.
  for (const utc of ['2026-10-05 09:30:00', '2026-10-05 23:30:00', '2026-01-01 00:00:00']) {
    const wat = time.utcToWat(utc);
    assert.equal(time.watToUtc(wat), utc, `${utc} -> ${wat} -> ${time.watToUtc(wat)}`);
  }
  assert.equal(time.watToUtc('2026-10-05 10:30:00'), '2026-10-05 09:30:00');
  assert.equal(time.watToUtc(null), null);
  assert.equal(time.watToUtc('garbage'), null);
});

test('uom: FIFO breaks receipt-time ties on a stable key, not on the id', () => {
  // Receipt timestamps are stored to the second, so two batches booked on one
  // goods-received note tie. The tiebreak used to be `id.localeCompare`, and ids
  // are random hex — so the winner was arbitrary and DIFFERENT ON EVERY RUN. Two
  // identical sales consumed different batches and snapshotted different costs,
  // which makes margin history irreproducible and made the seeded fixture
  // impossible to replay against a bug report.
  const tie = (id, batchNo, cost) => ({
    id, batch_no: batchNo, quantity: 10, quantity_reserved: 0,
    cost_price_per_unit: cost, status: 'ACTIVE', is_deleted: 0,
    expiry_date: null, received_at: '2026-09-01 10:00:00', created_at: '2026-09-01 10:00:00',
  });
  // Same receipt time, deliberately reversed id order vs batch_no order.
  const batches = [tie('ffffffffffffffff', 'B-002', 200), tie('0000000000000000', 'B-001', 100)];

  const first = uom.selectBatchesFifo(batches, 5);
  const second = uom.selectBatchesFifo([...batches].reverse(), 5);
  assert.equal(first.ok, true);
  assert.equal(first.picks[0].batch.batch_no, 'B-001', 'the lower batch number wins the tie');
  // Input order must not matter: the sort is total, so a caller cannot get a
  // different cost by fetching the same batches in a different order.
  assert.equal(second.picks[0].batch.batch_no, 'B-001');
  assert.equal(first.picks[0].costPerBaseUnit, 100);
  assert.equal(second.picks[0].costPerBaseUnit, 100);

  // Expiry still outranks everything: sell what will go off first.
  const withExpiry = [
    tie('aaaa', 'B-001', 100),
    { ...tie('bbbb', 'B-002', 50), expiry_date: '2026-10-01' },
  ];
  assert.equal(uom.selectBatchesFifo(withExpiry, 1).picks[0].batch.batch_no, 'B-002');

  // A batch with no batch_no still sorts deterministically (falls back to id).
  const noBatchNo = [
    { ...tie('zzz', null, 300), batch_no: null },
    { ...tie('aaa', null, 400), batch_no: null },
  ];
  const r1 = uom.selectBatchesFifo(noBatchNo, 1);
  const r2 = uom.selectBatchesFifo([...noBatchNo].reverse(), 1);
  assert.equal(r1.picks[0].batch.id, r2.picks[0].batch.id, 'a total order survives reversal even without batch numbers');
});
