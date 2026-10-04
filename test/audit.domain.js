// =====================================================================
// test/audit.domain.js — PURE DOMAIN-CORE AUDIT
// =====================================================================
// Runs with NO database and NO server: every function here is pure, so this
// suite is the fastest and most reliable gate in the project. Run it first.
//
//   node test/audit.domain.js
//
// What it protects: the invariants that, if they break, produce wrong money
// silently. A failing test here means a till that will not reconcile, a
// schedule that never marks itself paid, or a stock report that is out.

'use strict';

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const M = require(path.join(ROOT, 'shared/lib/money'));
const V = require(path.join(ROOT, 'shared/lib/verticals'));
const R = require(path.join(ROOT, 'shared/lib/receiving'));
const P = require(path.join(ROOT, 'shared/lib/pricing'));
const VAT = require(path.join(ROOT, 'shared/lib/vat'));
const WHT = require(path.join(ROOT, 'shared/lib/wht'));
const I = require(path.join(ROOT, 'shared/lib/instalments'));
const L = require(path.join(ROOT, 'shared/lib/layaway'));
const W = require(path.join(ROOT, 'shared/lib/warranty'));
const D = require(path.join(ROOT, 'shared/lib/delivery'));
const C = require(path.join(ROOT, 'shared/lib/credit'));
const F = require(path.join(ROOT, 'shared/lib/fx'));
const H = require(path.join(ROOT, 'shared/lib/hashchain'));
const T = require(path.join(ROOT, 'shared/lib/timegeo'));
const S = require(path.join(ROOT, 'shared/lib/stock'));
const PAY = require(path.join(ROOT, 'shared/lib/payments'));
const VAL = require(path.join(ROOT, 'shared/lib/validate'));

let pass = 0; let fail = 0; const fails = [];
let section = '';

function group(name) { section = name; console.log(`\n--- ${name} ---`); }
function ok(name, condition, detail) {
  if (condition) { pass += 1; console.log(`  PASS  ${name}`); }
  else {
    fail += 1; fails.push(`${section}: ${name}${detail ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
    console.log(`  FAIL  ${name}${detail ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 220)}` : ''}`);
  }
}
function throwsCode(name, fn, code) {
  try { fn(); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, e.code === code, `got ${e.code}: ${e.message}`); }
}

// =====================================================================
group('A. MONEY — the kobo invariants');
// =====================================================================
ok('allocateKobo(₦500,000 over 7) foots exactly',
  M.allocateKobo(50000000, new Array(7).fill(1)).reduce((a, b) => a + b, 0) === 50000000,
  M.allocateKobo(50000000, new Array(7).fill(1)));
ok('allocateKobo is deterministic across runs',
  JSON.stringify(M.allocateKobo(1000001, new Array(3).fill(1)))
    === JSON.stringify(M.allocateKobo(1000001, new Array(3).fill(1))));
ok('allocateKobo honours unequal weights',
  M.allocateKobo(100, [1, 3]).join(',') === '25,75', M.allocateKobo(100, [1, 3]));
ok('allocateKobo handles a negative total',
  M.allocateKobo(-100, [1, 1]).reduce((a, b) => a + b, 0) === -100);
ok('allocateKobo with degenerate weights still balances',
  M.allocateKobo(1000, [0, 0, 0]).reduce((a, b) => a + b, 0) === 1000);
ok('round2 is half-up, not float-truncated', M.round2(1.005) === 1.01, M.round2(1.005));
ok('round2 keeps a negative small figure negative', M.round2(-0.005) === -0.01, M.round2(-0.005));
ok('toKobo has no float drift on 0.1 + 0.2', M.toKobo(0.1) + M.toKobo(0.2) === 30);
ok('toKobo rejects an overflow rather than silently wrapping',
  (() => { try { M.toKobo(1e16); return false; } catch (e) { return e.code === 'MONEY_OVERFLOW'; } })());
const vatSplit = M.extractVat(45000, 7.5);
ok('extractVat: net + vat === total, to the kobo',
  M.toKobo(vatSplit.net) + M.toKobo(vatSplit.vat) === M.toKobo(vatSplit.total), vatSplit);
ok('extractVat does NOT increase what the customer pays', vatSplit.total === 45000, vatSplit.total);
ok('addVat goes the other way', M.addVat(41860.47, 7.5).total > 41860.47);
ok('parseMoney "45k"', M.parseMoney('45k') === 45000, M.parseMoney('45k'));
ok('parseMoney "₦1,234,567.89"', M.parseMoney('₦1,234,567.89') === 1234567.89);
ok('parseMoney "45,000/-" (receipt convention)', M.parseMoney('45,000/-') === 45000, M.parseMoney('45,000/-'));
ok('parseMoney "(1,500)" is negative', M.parseMoney('(1,500)') === -1500);
ok('parseMoney "1 200.50" (space thousands)', M.parseMoney('1 200.50') === 1200.5);
ok('parseMoney returns null (not 0) on junk', M.parseMoney('abc') === null && M.parseMoney('') === null);
ok('formatNaira groups en-NG', M.formatNaira(1234567.5) === '₦1,234,567.50', M.formatNaira(1234567.5));
ok('formatNaira hides .00 on a whole note with kobo:false',
  M.formatNaira(45000, { kobo: false }) === '₦45,000', M.formatNaira(45000, { kobo: false }));
ok('marginPercent is on selling price, not cost', M.marginPercent(110, 100) === 9.09, M.marginPercent(110, 100));

// =====================================================================
group('B. VERTICALS — four profiles, data-driven, no code paths');
// =====================================================================
ok('ships 4 verticals + 1 general profile', V.ALL_PROFILES.length === 5, V.ALL_PROFILES.length);
ok('every profile has categories, units and an attribute schema',
  V.ALL_PROFILES.every((p) => p.categories.length > 0 && p.units.length > 0 && p.attributeSchema.length > 0));
ok('every profile declares compliance types',
  V.ALL_PROFILES.every((p) => Array.isArray(p.complianceTypes) && p.complianceTypes.includes('CAC')));
ok('electronics defaults to serial capture', V.ELECTRONICS.restrictionDefault === 'SERIAL_CAPTURE');
ok('furniture does not', V.FURNITURE.restrictionDefault === 'NONE');
ok('wholesale tracks shelf life; furniture does not',
  V.WHOLESALE_RETAIL.shelfLifeDefault === true && V.FURNITURE.shelfLifeDefault === false);
ok('category cascade: alcohol -> AGE_VERIFICATION',
  V.effectiveRestriction('WHOLESALE_RETAIL', 'ALCOHOL_TOBACCO', null) === 'AGE_VERIFICATION');
ok('category cascade: mattresses are register-required',
  V.effectiveRegisterRequired('FURNITURE', 'MATTRESSES', null) === true);
ok('a product-level override beats the category default',
  V.effectiveRestriction('ELECTRONICS', 'ACCESSORIES', 'NONE') === 'NONE');
ok('profile default applies when the category is silent',
  V.effectiveRestriction('ELECTRONICS', 'COMPUTING', null) === 'SERIAL_CAPTURE');
ok('building materials allow fractional quantities (tonnes)',
  V.allowsFractionalQty('BUILDING_MATERIALS') === true && V.allowsFractionalQty('ELECTRONICS') === false);
ok('unknown profile is rejected, not defaulted', V.getProfile('SPACESHIPS') === null);
throwsCode('getProfileOrThrow rejects an unknown profile', () => V.getProfileOrThrow('SPACESHIPS'), 'UNKNOWN_VERTICAL');
ok('every category code is unique within its profile',
  V.ALL_PROFILES.every((p) => new Set(p.categories.map((c) => c.code)).size === p.categories.length));
ok('customer classes carry credit policy',
  V.customerClassInfo('RETAIL').creditAllowed === false && V.customerClassInfo('WHOLESALE').creditAllowed === true);

// =====================================================================
group('C. UoM LADDER — rungs are independent, not a strict chain');
// =====================================================================
const BISCUITS = { name: 'Biscuits', base_unit: 'PIECE', units_per_pack: 12, packs_per_carton: 24, cartons_per_pallet: 40 };
const TV = { name: 'Samsung 55" TV', base_unit: 'UNIT', units_per_carton: 1, units_per_pallet: 20 };
const CEMENT = { name: 'Dangote Cement', base_unit: 'BAG' };
ok('a full ladder resolves', R.resolveReceiveLine({ unit: 'PALLET', count: 1, product: BISCUITS }).totalPieces === 11520);
ok('5 cartons of biscuits = 1,440 pieces',
  R.resolveReceiveLine({ unit: 'CARTON', count: 5, product: BISCUITS }).totalPieces === 1440);
ok('a TV pallet needs no pack rung (2 x 20 = 40 units)',
  R.resolveReceiveLine({ unit: 'PALLET', count: 2, product: TV }).totalPieces === 40);
ok('describeReceipt skips rungs that do not exist',
  R.describeReceipt(R.resolveReceiveLine({ unit: 'PALLET', count: 2, product: TV })) === '2 pallets x 20 = 40 pieces',
  R.describeReceipt(R.resolveReceiveLine({ unit: 'PALLET', count: 2, product: TV })));
ok('describeReceipt spells out a full ladder',
  R.describeReceipt(R.resolveReceiveLine({ unit: 'CARTON', count: 5, product: BISCUITS }))
    === '5 cartons x 24 packs x 12 = 1,440 pieces');
ok('cement has no rungs at all',
  R.resolveReceiveLine({ unit: 'CARTON', count: 1, product: CEMENT }).ok === false);
ok('...and says which field to set',
  /units_per_carton/.test(R.resolveReceiveLine({ unit: 'CARTON', count: 1, product: CEMENT }).error));
ok('ladder() flags unconfigured rungs rather than hiding them',
  R.ladder(TV).find((x) => x.unit === 'PACK').configured === false);
ok('an inverted ladder (carton smaller than pack) is rejected',
  R.validateLadder({ base_unit: 'PIECE', units_per_pack: 12, units_per_carton: 4 }).ok === false);
ok('a pallet that is not a whole number of cartons is rejected',
  R.validateLadder({ base_unit: 'PIECE', units_per_carton: 7, units_per_pallet: 100 }).ok === false);
ok('a valid ladder passes', R.validateLadder(BISCUITS).ok === true, R.validateLadder(BISCUITS).errors);
ok('a fractional count is refused', R.resolveReceiveLine({ unit: 'CARTON', count: 2.5, product: BISCUITS }).ok === false);
const cost = R.splitTotalCost(480000, R.resolveReceiveLine({ unit: 'BASE_UNIT', count: 7000, product: CEMENT }));
ok('cost per piece keeps FULL precision (no ₦10 permanent loss)',
  Math.abs(cost.costPerPiece * 7000 - 480000) < 1e-9, cost.costPerPiece);
ok('...while the display figure is rounded', cost.display.costPerPiece === M.round2(cost.costPerPiece));
const sell = R.resolveSellingLine({ product: BISCUITS, unit: 'CARTON', count: 10, pricePerRung: 8640.55 });
ok('a rung sale converts to base units', sell.ok && sell.baseQuantity === 2880, sell.baseQuantity);
ok('a rung price splits across base units to the exact kobo',
  M.allocateKobo(sell.rungTotalKobo, new Array(sell.baseQuantity).fill(1)).reduce((a, b) => a + b, 0) === sell.rungTotalKobo);

// =====================================================================
group('D. PRICING — precedence, guard rails and an explainable trail');
// =====================================================================
const wholesale = P.priceLine({
  baseQuantity: 10, batchPricePerBaseUnit: 50000, unitCostPerBaseUnit: 42000,
  customer: { customer_class: 'WHOLESALE' }, tier: { discount_percent: 7 },
  policy: { max_discount_percent: 15 },
});
ok('a wholesale tier prices correctly (10 x 50,000 less 7%)', wholesale.ok && wholesale.net === 465000, wholesale.net);
ok('the trail explains which layer fired',
  wholesale.pricingTrail.map((t) => t.layer).join('>') === 'BATCH>CUSTOMER_TIER',
  wholesale.pricingTrail.map((t) => t.layer));
ok('margin is computed from the batch cost', wholesale.marginPercent === 9.68, wholesale.marginPercent);
const promo = P.priceLine({
  baseQuantity: 10, batchPricePerBaseUnit: 50000,
  customer: { customer_class: 'WHOLESALE' }, tier: { discount_percent: 7 },
  promotion: { type: 'PERCENT_OFF', value: 20, status: 'ACTIVE', starts_on: '2020-01-01', ends_on: '2099-01-01' },
});
ok('a live promotion OUTRANKS the customer tier',
  promo.net === 400000 && promo.pricingTrail.some((t) => t.layer === 'PROMOTION'), promo.net);
const expired = P.priceLine({
  baseQuantity: 1, batchPricePerBaseUnit: 50000,
  promotion: { type: 'PERCENT_OFF', value: 90, status: 'ACTIVE', starts_on: '2020-01-01', ends_on: '2020-02-01' },
});
ok('an expired promotion does not fire', expired.net === 50000, expired.net);
const bogo = P.priceLine({
  baseQuantity: 9, batchPricePerBaseUnit: 1000,
  promotion: { type: 'BUY_N_GET_M', buy_n: 2, get_m: 1, status: 'ACTIVE', starts_on: '2020-01-01', ends_on: '2099-01-01' },
});
ok('buy-2-get-1 gives 3 free units out of 9', bogo.freeUnits === 3 && bogo.net === 6000, { free: bogo.freeUnits, net: bogo.net });
const belowFloor = P.priceLine({
  baseQuantity: 1, batchPricePerBaseUnit: 50000, unitCostPerBaseUnit: 45000,
  manualDiscount: { kind: 'PERCENT', value: 50 }, policy: { floor_price_percent: 100 },
});
ok('selling below the price floor BLOCKS a cashier',
  belowFloor.ok === false && belowFloor.blocks[0].code === 'BELOW_PRICE_FLOOR', belowFloor.blocks);
const overridden = P.priceLine({
  baseQuantity: 1, batchPricePerBaseUnit: 50000, unitCostPerBaseUnit: 45000,
  manualDiscount: { kind: 'PERCENT', value: 50, approved_by_manager: true }, policy: { floor_price_percent: 100 },
});
ok('...and a manager override allows it WITH a warning',
  overridden.ok === true && overridden.warnings.length > 0, overridden.warnings);
const overDiscount = P.priceLine({
  baseQuantity: 1, batchPricePerBaseUnit: 50000, manualDiscount: { kind: 'PERCENT', value: 40 },
  policy: { max_discount_percent: 15 },
});
ok('a discount above the limit BLOCKS', overDiscount.blocks[0].code === 'DISCOUNT_EXCEEDS_LIMIT');
ok('a branch override beats the batch price',
  P.priceLine({ baseQuantity: 1, batchPricePerBaseUnit: 50000, branchPricePerBaseUnit: 55000 }).net === 55000);
throwsCode('a batch with no price refuses to sell', () => P.priceLine({ baseQuantity: 1, batchPricePerBaseUnit: null }), 'NO_SELLING_PRICE');
ok('priceFromMargin uses selling price, not cost (markup)',
  P.priceFromMargin(100, 20) === 125 && P.priceFromMarkup(100, 20) === 120,
  { margin: P.priceFromMargin(100, 20), markup: P.priceFromMarkup(100, 20) });

// =====================================================================
group('E. VAT — extraction model, exempt categories, exact footing');
// =====================================================================
const mixed = VAT.computeSaleVat({
  lines: [
    { id: 1, netKobo: M.toKobo(465000), category: 'TV_HOME_ENT' },       // chargeable
    { id: 2, netKobo: M.toKobo(15000), category: 'FOOD_PROVISIONS' },    // exempt (basic food)
    { id: 3, netKobo: M.toKobo(8500), category: 'BABY_PRODUCTS' },       // exempt
  ],
  vatEnabled: true, vatRatePercent: 7.5,
});
ok('a mixed basket charges VAT only on the chargeable part',
  mixed.chargeable === 465000 && mixed.exempt === 23500, { chargeable: mixed.chargeable, exempt: mixed.exempt });
ok('total === chargeable + exempt', mixed.total === 488500, mixed.total);
ok('vat is extracted, never added on top', mixed.total === 488500);
ok('sum(line.vat) === sale.vat exactly',
  mixed.lines.reduce((a, l) => a + l.vatKobo, 0) === mixed.vatKobo,
  { sum: mixed.lines.map((l) => l.vat), sale: mixed.vat });
ok('exempt lines carry vat 0, not null',
  mixed.lines.filter((l) => !l.chargeable).every((l) => l.vatKobo === 0 && l.vat === 0));
ok('net + vat === total in kobo', mixed.netKobo + mixed.vatKobo === mixed.totalKobo);
const vatOff = VAT.computeSaleVat({ lines: [{ id: 1, netKobo: 500000, category: 'TV_HOME_ENT' }], vatEnabled: false });
ok('VAT off: everything is net, nothing is null', vatOff.vatKobo === 0 && vatOff.net === 5000);
ok('a per-product exemption overrides its category',
  VAT.isExempt({ product: { vat_exempt: true }, categoryCode: 'TV_HOME_ENT' }) === true);
ok('a per-product override can make an exempt category chargeable',
  VAT.isExempt({ product: { vat_exempt: false }, categoryCode: 'FOOD_PROVISIONS' }) === false);
throwsCode('an out-of-range VAT rate is rejected', () => M.extractVat(1000, 150), 'VAT_INVALID_RATE');
const ret = VAT.vatReturn({ outputVat: 500000, inputVat: 200000 });
ok('a VAT return nets output against input', ret.netPayable === 300000 && ret.position === 'PAYABLE', ret);
ok('a negative net is REFUNDABLE, not a negative payable',
  VAT.vatReturn({ outputVat: 100, inputVat: 500 }).position === 'REFUNDABLE');

// =====================================================================
group('F. WHT — 2024 Regulations, gross-in, size-differentiated');
// =====================================================================
const w = WHT.computeWht({ grossAmount: 1000000, ratePercent: 5 });
ok('WHT is computed from GROSS, never net', w.wht === 50000 && w.net === 950000, w);
ok('gross === net + wht to the kobo', M.toKobo(w.gross) === M.toKobo(w.net) + M.toKobo(w.wht));
ok('WHT never exceeds the gross', (() => { try { WHT.computeWht({ grossAmount: 100, ratePercent: 150 }); return false; } catch (e) { return e.code === 'WHT_INVALID_RATE'; } })());
ok('the seeded schedule is size-differentiated',
  WHT.SEED_RATES.find((r) => r.code === 'CONSULTANCY').small === 5
    && WHT.SEED_RATES.find((r) => r.code === 'CONSULTANCY').large === 10);
ok('resolveSizeColumn picks the right column',
  WHT.resolveSizeColumn({ rate_percent_small: 5, rate_percent_medium: 10, rate_percent_large: 10 }, 'SMALL') === 5);
ok('the small-company exemption is ADVISORY (never blocks)',
  typeof WHT.exemptionHint({ grossAmount: 500000, counterpartyTin: '12345678' }) === 'string');
ok('...and is silent above ₦2m in the month',
  WHT.exemptionHint({ grossAmount: 3000000, counterpartyTin: '12345678' }) === null);
ok('...and warns when there is no TIN',
  /may not apply/.test(WHT.exemptionHint({ grossAmount: 500000 }) || ''));
ok('remittance is due on the 21st of the following month',
  WHT.remittanceDueDate('2026-03-15') === '2026-04-21', WHT.remittanceDueDate('2026-03-15'));
ok('a December deduction is due in January', WHT.remittanceDueDate('2026-12-05') === '2027-01-21');
ok('an overdue receivable is flagged',
  WHT.receivableStatus({ entryDate: '2026-01-10', creditNoteReceived: false, today: new Date('2026-04-01') }) === 'OVERDUE');

// =====================================================================
group('G. INSTALMENTS — "pay small-small" schedules that foot');
// =====================================================================
const plan = I.buildPlan({ totalAmount: 500000, deposit: 100000, instalments: 7, frequency: 'MONTHLY', startDate: '2026-01-31', model: 'LAYAWAY_BACKED' });
ok('deposit + every instalment === total, to the kobo', plan.balanced === true, { d: plan.deposit, s: plan.schedule.map((x) => x.amount) });
ok('a monthly plan starting 31 Jan falls due 28 Feb (not 2 Mar)',
  plan.schedule[0].due_date === '2026-02-28', plan.schedule[0].due_date);
ok('monthly arithmetic does not drift over 12 periods',
  I.addPeriods('2026-01-15', 12, 'MONTHLY') === '2027-01-15', I.addPeriods('2026-01-15', 12, 'MONTHLY'));
ok('a weekly plan is 7 days, not 30', I.addPeriods('2026-01-01', 1, 'WEEKLY') === '2026-01-08');
throwsCode('a deposit below the minimum is refused', () => I.buildPlan({ totalAmount: 500000, deposit: 10000, instalments: 3, frequency: 'MONTHLY', startDate: '2026-01-01' }), 'DEPOSIT_BELOW_MINIMUM');
throwsCode('a deposit above the total is refused', () => I.buildPlan({ totalAmount: 500000, deposit: 600000, instalments: 3, frequency: 'MONTHLY', startDate: '2026-01-01' }), 'INVALID_DEPOSIT');
ok('a plan fee is disclosed, not hidden as interest',
  I.buildPlan({ totalAmount: 500000, deposit: 100000, instalments: 4, frequency: 'MONTHLY', startDate: '2026-01-01', planFeePercent: 2 }).planFee === 8000);
ok('LAYAWAY_BACKED reserves stock until completion', plan.stockTreatment === 'RESERVE_UNTIL_COMPLETION');
ok('DELIVERED_ON_DEPOSIT decrements immediately',
  I.buildPlan({ totalAmount: 500000, deposit: 100000, instalments: 4, frequency: 'MONTHLY', startDate: '2026-01-01', model: 'DELIVERED_ON_DEPOSIT' }).stockTreatment === 'DECREMENT_ON_DEPOSIT');
const paid = I.applyPayment({ plan, schedule: plan.schedule, paymentKobo: plan.schedule[0].amount, paidAtIso: plan.schedule[0].due_date });
ok('paying on time marks the instalment PAID', paid.schedule[0].status === 'PAID' && paid.status === 'ACTIVE', paid.schedule[0].status);
ok('the outstanding balance falls by exactly what was paid',
  paid.outstanding === M.round2(plan.financed - plan.schedule[0].amount), paid.outstanding);
const late = I.applyPayment({ plan: { ...plan, lateFeePercent: 5 }, schedule: plan.schedule.map((s) => ({ ...s, late_fee_if_missed_kobo: Math.round(s.amount_kobo * 0.05) })), paymentKobo: plan.schedule[0].amount, paidAtIso: I.addCalendarDays(plan.schedule[0].due_date, 30) });
ok('a payment after the grace period is LATE_PAID with a fee',
  late.schedule[0].status === 'LATE_PAID' && late.lateFeesCharged > 0, { st: late.schedule[0].status, fee: late.lateFeesCharged });
const payoff = I.applyPayment({ plan, schedule: plan.schedule, paymentKobo: plan.financed, paidAtIso: plan.schedule[0].due_date });
ok('paying the whole plan off completes it', payoff.status === 'COMPLETED' && payoff.outstanding === 0, payoff.status);
const overdue = I.refreshOverdue({ plan, schedule: plan.schedule.map((s) => ({ ...s, status: 'MISSED' })), todayIso: '2027-01-01' });
ok('three missed instalments defaults the plan', overdue.status === 'DEFAULTED', overdue.missedCount);
ok('a defaulted LAYAWAY_BACKED plan can be repossessed',
  I.defaultOptions({ ...plan, status: 'DEFAULTED' }).some((o) => o.code === 'REPOSSESS'));
ok('a defaulted DELIVERED_ON_DEPOSIT plan cannot',
  !I.defaultOptions({ ...plan, model: 'DELIVERED_ON_DEPOSIT', status: 'DEFAULTED' }).some((o) => o.code === 'REPOSSESS'));
ok('repossession computes a refund net of a restocking fee',
  I.repossessionSettlement({ plan, paidTotal: 200000, restockingFeePercent: 10 }).refundDue === 180000);

// =====================================================================
group('H. LAYAWAY — holds reserve stock, expire, and never take anonymous money');
// =====================================================================
const hold = L.createHold({ product: { id: 'p1', name: 'Sofa' }, branchId: 'b1', customerId: 'c1', quantity: 1, deposit: 50000, sellingPrice: 300000, holdDays: 7, reason: 'DEPOSIT_PAID' });
ok('a hold reserves stock', hold.ok && hold.hold.reserves_stock === true);
ok('the balance is the price less the deposit', hold.hold.balance === 250000, hold.hold.balance);
ok('a deposit requires a named customer',
  L.createHold({ product: { id: 'p1' }, branchId: 'b1', customerId: null, quantity: 1, deposit: 5000 }).ok === false);
ok('a deposit cannot exceed the value held',
  L.createHold({ product: { id: 'p1' }, branchId: 'b1', customerId: 'c1', quantity: 1, deposit: 900000, sellingPrice: 300000 }).ok === false);
ok('a hold expires after its term', hold.hold.expires_on === L.addDays(hold.hold.held_from, 7), hold.hold.expires_on);
ok('a hold cannot run past 180 days', L.createHold({ product: { id: 'p1' }, branchId: 'b1', customerId: 'c1', quantity: 1, holdDays: 9999 }).hold.expires_on === L.addDays(new Date().toISOString().slice(0, 10), 180));
ok('extension is capped and counted', L.extendHold({ hold: { expires_on: '2026-10-10', extension_count: 3 }, extraDays: 7 }).ok === false);
const rel = L.releaseHold({ hold: hold.hold, reason: 'EXPIRED', forfeitPercent: 20 });
ok('releasing a hold frees the quantity', rel.quantity_to_release === 1 && rel.status === 'EXPIRED');
ok('a forfeited deposit is OTHER INCOME, never sales revenue',
  rel.glTreatment.account === 'OTHER_INCOME' && rel.deposit_forfeited === 10000, rel.glTreatment);
const conv = L.convertToSale({ hold: { ...hold.hold, id: 'h1' }, saleId: 's1' });
ok('converting credits the deposit as a tender', conv.credit_deposit === 50000 && conv.balance_due === 250000);
ok('expired holds are findable for the nightly release job',
  L.findExpired([{ ...hold.hold, status: 'ACTIVE', expires_on: '2020-01-01' }], '2026-10-04').length === 1);

// =====================================================================
group('I. WARRANTY & SERIALS — capture is enforced, cover is evidenced');
// =====================================================================
ok('a serial is normalised so a scan and a key-in match',
  W.normaliseSerial(' 3582 4401 ') === '35824401' && W.normaliseSerial('ab-12') === 'AB-12');
throwsCode('a missing serial on a serialised line throws', () => W.validateSerial(''), 'SERIAL_REQUIRED');
throwsCode('a malformed serial throws', () => W.validateSerial('!!'), 'INVALID_SERIAL');
const shortCapture = W.validateCapture({ serials: ['AAAA1111'], requiredQty: 2 });
ok('fewer serials than units is refused', shortCapture.ok === false && shortCapture.short === 1);
const dupe = W.validateCapture({ serials: ['AAAA1111', 'AAAA1111'], requiredQty: 2 });
ok('a duplicate scan is caught at the counter, not at report time',
  dupe.ok === false && dupe.problems[0].code === 'DUPLICATE_IN_CAPTURE', dupe.problems);
const alreadySold = W.validateCapture({ serials: ['AAAA1111'], requiredQty: 1, existingSerials: ['AAAA1111'] });
ok('a serial already sold cannot be sold again',
  alreadySold.ok === false && alreadySold.problems[0].code === 'SERIAL_ALREADY_SOLD');
ok('an exact capture passes', W.validateCapture({ serials: ['AAAA1111', 'BBBB2222'], requiredQty: 2 }).ok === true);
ok('excess serials are refused', W.validateCapture({ serials: ['AAAA1111', 'BBBB2222'], requiredQty: 1 }).ok === false);
ok('warranty expiry from sale date + 12 months',
  W.warrantyExpiry({ months: 12, basis: 'SALE', saleDate: '2026-02-29' }) === '2027-02-28',
  W.warrantyExpiry({ months: 12, basis: 'SALE', saleDate: '2026-02-29' }));
ok('extended cover adds on top', W.warrantyExpiry({ months: 12, extendedMonths: 6, basis: 'SALE', saleDate: '2026-01-01' }) === '2027-07-01');
const inCover = W.assessCover({ serial: { warranty_months: 24 }, product: {}, sale: { sale_date: '2026-01-01' }, today: new Date('2026-10-04') });
ok('a unit bought in January is in cover in October', inCover.inCover === true && inCover.daysRemaining > 0, inCover.daysRemaining);
const outCover = W.assessCover({ serial: { warranty_months: 12 }, product: {}, sale: { sale_date: '2025-06-01' }, today: new Date('2026-10-04') });
ok('an expired warranty says HOW LONG AGO, not just "no"',
  outCover.inCover === false && /expired \d+ day/.test(outCover.reasons[0].message), outCover.reasons);
ok('a serial with no sale record cannot be assessed',
  W.assessCover({ serial: { warranty_months: 12 }, product: {}, sale: null }).status === 'NO_SALE_RECORD');
ok('a voided warranty is refused cover with the reason',
  W.assessCover({ serial: { warranty_months: 24, warranty_status: 'VOID', warranty_void_reason: 'Seal broken' }, product: {}, sale: { sale_date: '2026-01-01' } }).reasons[0].code === 'STATUS_VOID');
const claim = W.openClaim({ serial: { id: 's1', serial_number: 'AAAA1111', status: 'SOLD', product_id: 'p1' }, cover: inCover, claimType: 'REPAIR', reportedBy: { name: 'Ada', phone: '08031234567' }, description: 'Compressor makes a loud noise and does not cool.' });
ok('a claim can be opened on a unit in cover', claim.ok && claim.claim.in_cover_at_open === true);
ok('an in-cover claim is the manufacturer\'s responsibility', claim.claim.responsibility === 'MANUFACTURER' && claim.claim.chargeable === false);
ok('a thin description is refused (the manufacturer will ask)',
  W.openClaim({ serial: { id: 's1', status: 'SOLD' }, cover: inCover, claimType: 'REPAIR', description: 'bad' }).ok === false);
ok('a unit never sold by us cannot claim warranty',
  W.openClaim({ serial: { id: 's1', status: 'IN_STOCK' }, cover: inCover, claimType: 'REPAIR', description: 'It does not work at all.' }).ok === false);
const outClaim = W.openClaim({ serial: { id: 's1', status: 'SOLD' }, cover: outCover, claimType: 'REPAIR', description: 'Does not cool at all anymore.' });
ok('an out-of-cover claim is allowed but CHARGEABLE', outClaim.ok && outClaim.claim.chargeable === true);
ok('a replacement requires its own serial',
  W.resolveClaim({ claim: { serial_number: 'AAAA1111' }, outcome: 'REPLACED' }).ok === false);
ok('a replacement moves stock out and supersedes the old serial',
  W.resolveClaim({ claim: { serial_number: 'AAAA1111' }, outcome: 'REPLACED', newSerial: 'CCCC3333' }).effects.stockMovement.type === 'WARRANTY_SWAP');
ok('a refund returns the unit as scrapped, never as new',
  W.resolveClaim({ claim: {}, outcome: 'REFUNDED', refundAmount: 300000 }).effects.stockMovement.restock_as === 'SCRAPPED');
ok('a repair is an expense against the provision, not a stock movement',
  W.resolveClaim({ claim: {}, outcome: 'REPAIRED', repairCostKobo: 25000 }).effects.stockMovement === null);
const prov = W.warrantyProvision({ warrantiedRevenue: 10000000, provisionPercent: 1.5, claimsSettledKobo: 4000000 });
ok('a warranty provision accrues and draws down', prov.accrual === 150000 && prov.closingProvision === 110000, prov);
ok('under-provisioning is reported, not hidden',
  W.warrantyProvision({ warrantiedRevenue: 1000000, provisionPercent: 1.5, claimsSettledKobo: 9000000 }).underProvisioned === true);

// =====================================================================
group('J. DELIVERY — fees are itemised, stock leaves on dispatch');
// =====================================================================
const zone = { code: 'LEKKI1', name: 'Lekki Phase 1', base_fee: 8000, per_km_fee: 300, bulky_surcharge: 2000, bulky_surcharge_cap: 12000, floor_surcharge: 1500, installation_fee: 2500 };
const quote = D.quoteDelivery({
  zone, distanceKm: 14, floors: 3, hasLift: false, installationRequired: true,
  items: [{ quantity: 1, base_unit: 'SET', is_bulky: true }, { quantity: 2, base_unit: 'CARTON' }],
});
ok('every fee component is itemised and labelled', quote.components.length === 5, quote.components.map((c) => c.label));
ok('distance is charged per km', quote.components.find((c) => c.code === 'DISTANCE').kobo === 4200);
ok('stairs without a lift are charged', quote.components.find((c) => c.code === 'FLOORS').kobo === 4500);
ok('the bulky surcharge is capped', D.quoteDelivery({ zone, items: [{ quantity: 500, base_unit: 'BAG' }] }).components.find((c) => c.code === 'BULKY').kobo === 12000);
ok('a lift means no floor surcharge', D.quoteDelivery({ zone, floors: 12, hasLift: true, items: [] }).components.every((c) => c.code !== 'FLOORS'));
ok('the quote totals correctly', quote.fee === 8000 + 4200 + 6000 + 4500 + 2500, quote.fee);
const job = D.buildJob({ saleId: 's1', branchId: 'b1', customerId: 'c1', jobType: 'DELIVERY_AND_INSTALLATION', items: [{ product_id: 'p1', quantity: 1 }], slot: { date: '2026-10-08', window_start: '09:00', window_end: '13:00' }, address: '12 Admiralty Way, Lekki', fee: quote.fee });
ok('a job needs a customer, an address and a slot', job.ok === true);
ok('a delivery job reserves stock on create and dispatches on load',
  job.stockEffect.reservesOnCreate === true && job.stockEffect.movementOnDispatch === 'DELIVERY_DISPATCH');
ok('an INSTALLATION-only job does not move stock',
  D.buildJob({ branchId: 'b1', customerId: 'c1', jobType: 'INSTALLATION', items: [{ product_id: 'p1', quantity: 1 }], slot: { date: '2026-10-08' }, address: 'x' }).stockEffect.reservesOnCreate === false);
ok('a job without an address is refused', D.buildJob({ branchId: 'b1', customerId: 'c1', jobType: 'DELIVERY', items: [{ product_id: 'p1' }], slot: { date: '2026-10-08' }, address: '' }).ok === false);
ok('delivery requires proof — a name, signature or photo',
  D.recordAttempt({ job: {}, success: true, proof: {} }).ok === false);
ok('proof of delivery is captured with a GPS stamp',
  D.recordAttempt({ job: {}, success: true, proof: { receiver_name: 'Mrs Okoye', gps_latitude: 6.45, gps_longitude: 3.47 } }).proof.receiver_name === 'Mrs Okoye');
const failedOurs = D.recordAttempt({ job: {}, success: false, reason: 'VEHICLE_BREAKDOWN', chargeRedelivery: true, redeliveryFeeKobo: 500000 });
ok('a failure that is OUR fault is not chargeable to the customer', failedOurs.chargeable === false && failedOurs.redelivery_fee === 0, failedOurs);
const failedTheirs = D.recordAttempt({ job: {}, success: false, reason: 'CUSTOMER_NOT_AVAILABLE', chargeRedelivery: true, redeliveryFeeKobo: 5000 });
ok('a failure that is THEIRS is chargeable', failedTheirs.chargeable === true && failedTheirs.redelivery_fee === 5000);
ok('a failed delivery returns the goods to sellable stock', failedTheirs.stockEffect.type === 'SALE_RETURN' && failedTheirs.stockEffect.restock === true);
ok('dispatch refuses an unpaid sale',
  D.dispatch({ job: {}, sale: { paid_in_full: false, balance_due: 250000 }, driverId: 'd1' }).ok === false);
ok('dispatch refuses an unassigned driver', D.dispatch({ job: {}, sale: { paid_in_full: true }, driverId: null }).ok === false);
ok('slot capacity prevents overbooking a truck',
  D.slotCapacity({ booked: 8, capacity: 8 }).isFull === true && D.slotCapacity({ booked: 3, capacity: 8 }).remaining === 5);
const card = D.driverScorecard([
  { status: 'DELIVERED', on_time: true }, { status: 'DELIVERED', on_time: false },
  { status: 'FAILED', failure_reason: 'CUSTOMER_NOT_AVAILABLE' }, { status: 'CANCELLED' },
]);
ok('a driver scorecard reports success and on-time rates', card.successRate === 50 && card.onTimeRate === 50, card);

// =====================================================================
group('K. CREDIT — derived balances, four gates, honest ageing');
// =====================================================================
const entries = [
  { id: 'e1', entry_type: 'SALE', direction: 'DEBIT', amount: 500000, entry_date: '2026-08-01', terms_code: 'NET_30' },
  { id: 'e2', entry_type: 'SALE', direction: 'DEBIT', amount: 300000, entry_date: '2026-09-15', terms_code: 'NET_30' },
  { id: 'e3', entry_type: 'PAYMENT', direction: 'CREDIT', amount: 200000, entry_date: '2026-09-20' },
];
const bal = C.deriveBalance(entries);
ok('a balance is DERIVED from the ledger, never stored', bal.balance === 600000, bal.balance);
ok('a credit balance is a customer ADVANCE (a liability), not negative revenue',
  C.deriveBalance([{ entry_type: 'PAYMENT', direction: 'CREDIT', amount: 50000 }]).advance === 50000);
ok('terms produce a due date', C.dueDate('2026-08-01', 'NET_30') === '2026-08-31');
const ageing = C.ageEntries(entries, { todayIso: '2026-10-04' });
ok('ageing buckets the outstanding balance', ageing.totalOutstanding === 600000, ageing.totalOutstanding);
ok('a payment is applied OLDEST-FIRST',
  ageing.lines.find((l) => l.entry_id === 'e1').applied === 200000, ageing.lines);
ok('the older debt shows as more overdue',
  ageing.lines[0].entry_id === 'e1' && ageing.lines[0].days_overdue > ageing.lines[1].days_overdue, ageing.lines.map((l) => l.days_overdue));
ok('bucket percentages sum to 100',
  M.round2(ageing.buckets.reduce((a, b) => a + b.percent, 0)) === 100, ageing.buckets.map((b) => b.percent));
const apply = C.applyPaymentToDebts({ paymentKobo: M.toKobo(350000), openEntries: ageing.lines });
ok('a payment settles the oldest debt first then part-settles the next',
  apply.allocations.length === 2 && apply.allocations[0].settled_in_full === true, apply.allocations);
ok('the allocation sums exactly to the payment',
  apply.allocations.reduce((a, x) => a + x.applied_kobo, 0) === M.toKobo(350000));
const over = C.applyPaymentToDebts({ paymentKobo: M.toKobo(900000), openEntries: ageing.lines });
ok('over-payment becomes a customer ADVANCE, never a dropped amount',
  over.unapplied === 300000 && over.unappliedTreatment === 'CUSTOMER_ADVANCE', over.unapplied);
ok('credit gate 1: a RETAIL customer cannot buy on account',
  C.assessCreditRequest({ customer: { balance: 0, class_allows_credit: false, customer_class: 'RETAIL' }, requestedKobo: 100000 }).blocks.some((b) => b.code === 'CLASS_FORBIDS_CREDIT'));
ok('credit gate 2: the limit is enforced',
  C.assessCreditRequest({ customer: { balance: 450000, credit_limit: 500000, class_allows_credit: true }, requestedKobo: 100000 }).blocks.some((b) => b.code === 'OVER_LIMIT'));
ok('credit gate 3: an already-overdue account is blocked even under its limit',
  C.assessCreditRequest({ customer: { balance: 100000, credit_limit: 5000000, overdue_balance: 100000, max_days_overdue: 45, class_allows_credit: true }, requestedKobo: 50000 }).blocks.some((b) => b.code === 'ALREADY_OVERDUE'));
ok('credit gate 4: a suspended account is blocked',
  C.assessCreditRequest({ customer: { balance: 0, account_status: 'SUSPENDED', class_allows_credit: true }, requestedKobo: 1000 }).blocks.some((b) => b.code === 'ACCOUNT_STATUS'));
ok('concentration risk warns but does not block',
  C.assessCreditRequest({ customer: { balance: 900000, class_allows_credit: true }, requestedKobo: 100000, policy: { total_debtors: 2000000 } }).warnings.some((w) => w.code === 'CONCENTRATION'));
ok('headroom is reported so the POS can say why',
  C.assessCreditRequest({ customer: { balance: 450000, credit_limit: 500000, class_allows_credit: true }, requestedKobo: 100000 }).headroom === 50000);
const chase = C.chaseSchedule({ daysOverdue: 45, amount: 500000 });
ok('a chase schedule exists rather than being improvised', chase.completed.length === 4 && chase.nextAction.atDays === 60, chase.nextAction);
ok('credit is suspended at the policy threshold', chase.suspendCredit === true);
const provAgeing = C.provisionForAgeing(ageing);
ok('bad-debt provision is computed per bucket', provAgeing.totalProvision >= 0 && provAgeing.rows.length === C.AGEING_BUCKETS.length);
ok('change owed requires SOME identity, or it is unclaimable forever',
  (() => { try { C.recordChangeOwed({ branchId: 'b1', amount: 250 }); return false; } catch (e) { return e.code === 'CHANGE_OWED_NEEDS_IDENTITY'; } })());
ok('change owed is a liability until collected',
  C.recordChangeOwed({ branchId: 'b1', customerName: 'Ada', amount: 250 }).glTreatment.account === 'CHANGE_OWED_LIABILITY');
ok('a safe balance is derived and a negative is flagged',
  C.safeBalance([{ movement_type: 'FLOAT_IN', amount: 50000 }, { movement_type: 'BANK_DEPOSIT', amount: 70000 }]).negative === true);

// =====================================================================
group('L. PAYMENTS — tenders, fees, settlement and till reconciliation');
// =====================================================================
const tenders = PAY.validateTenders({ tenders: [{ method: 'CASH', amount: 50000 }], amountDue: 47350, customerId: 'c1' });
ok('change is computed in kobo', tenders.changeKobo === 265000 && tenders.change === 2650, tenders.change);
ok('change routes to cash from the till', tenders.changeRoute === 'CASH_FROM_TILL');
ok('over-payment on a card alone becomes CHANGE_OWED (you cannot give change onto a terminal)',
  PAY.validateTenders({ tenders: [{ method: 'POS_TERMINAL', amount: 50000, reference: 'RR-9911' }], amountDue: 47350, customerId: 'c1' }).changeRoute === 'CHANGE_OWED');
ok('a split tender sums correctly',
  PAY.validateTenders({ tenders: [{ method: 'CASH', amount: 20000 }, { method: 'BANK_TRANSFER', amount: 27350, reference: 'TRX-1' }], amountDue: 47350, customerId: 'c1' }).changeKobo === 0);
throwsCode('a transfer with no reference is refused', () => PAY.validateTenders({ tenders: [{ method: 'BANK_TRANSFER', amount: 47350 }], amountDue: 47350 }), 'VALIDATION_ERROR');
throwsCode('a short payment is refused unless credit is allowed', () => PAY.validateTenders({ tenders: [{ method: 'CASH', amount: 1000 }], amountDue: 47350 }), 'PAYMENT_SHORT');
throwsCode('an unknown tender is refused', () => PAY.validateTenders({ tenders: [{ method: 'BITCOIN', amount: 47350 }], amountDue: 47350 }), 'UNKNOWN_TENDER');
ok('credit needs a named customer',
  (() => { try { PAY.validateTenders({ tenders: [{ method: 'CREDIT', amount: 47350 }], amountDue: 47350 }); return false; } catch (e) { return e.code === 'CREDIT_NEEDS_CUSTOMER'; } })());
ok('a credit tender over the limit is refused',
  (() => { try { PAY.validateTenders({ tenders: [{ method: 'CREDIT', amount: 900000 }], amountDue: 900000, customerId: 'c1', creditLimitKobo: 50000000 }); return false; } catch (e) { return e.code === 'CREDIT_LIMIT_EXCEEDED'; } })());
ok('a POS fee is computed and capped', PAY.posFee({ amount: 500000 }).fee === 2000, PAY.posFee({ amount: 500000 }));
ok('a small POS fee is the percentage, not the cap', PAY.posFee({ amount: 50000 }).fee === 750);
ok('an unconfigured fee is flagged rather than silently assumed zero',
  PAY.posFee({ amount: 500000, configured: false }).configured === false);
ok('a Friday POS sale settles Monday', PAY.expectedSettlement('2026-10-02', { businessDays: 1 }) === '2026-10-05', PAY.expectedSettlement('2026-10-02'));
ok('holidays push settlement out', PAY.expectedSettlement('2026-09-30', { businessDays: 1, holidays: ['2026-10-01'] }) === '2026-10-02');
const recon = PAY.reconcileTill({ expectedByMethod: { CASH: 250000, POS_TERMINAL: 400000 }, countedByMethod: { CASH: 248500 } });
ok('a till reconciliation isolates the SHORT method',
  recon.rows.find((r) => r.method === 'CASH').variance === -1500 && recon.rows.find((r) => r.method === 'CASH').status === 'SHORT');
ok('only cash is treated as counted in the drawer',
  recon.rows.find((r) => r.method === 'POS_TERMINAL').countsAsCash === false);
ok('a balanced drawer reports balanced', PAY.reconcileTill({ expectedByMethod: { CASH: 250000 }, countedByMethod: { CASH: 250000 } }).balanced === true);

// =====================================================================
group('M. STOCK — picking respects reservations and never oversells');
// =====================================================================
const batches = [
  { id: 'b1', quantity_on_hand: 5, quantity_reserved: 2, cost_per_unit: 40000, received_at: '2026-01-01' },
  { id: 'b2', quantity_on_hand: 10, quantity_reserved: 0, cost_per_unit: 42000, received_at: '2026-02-01' },
];
const fifo = S.pickBatches(batches, { policy: 'FIFO', requiredQty: 6 });
ok('FIFO takes the oldest batch first', fifo.allocation[0].stock_batch_id === 'b1');
ok('a reservation is NOT sellable — only 3 of b1\'s 5 are available',
  fifo.allocation[0].quantity === 3 && fifo.allocation[1].quantity === 3, fifo.allocation);
ok('an oversell is refused with the exact shortfall',
  (() => { const r = S.pickBatches(batches, { policy: 'FIFO', requiredQty: 20 }); return r.ok === false && r.short === 7; })());
const fefo = S.pickBatches([
  { id: 'x', quantity_on_hand: 3, best_before_date: '2026-12-01', cost_per_unit: 100, received_at: '2026-03-01' },
  { id: 'y', quantity_on_hand: 3, best_before_date: '2026-11-01', cost_per_unit: 90, received_at: '2026-01-01' },
], { policy: 'FEFO', requiredQty: 2 });
ok('FEFO picks the soonest best-before', fefo.allocation[0].stock_batch_id === 'y');
ok('a dateless batch never wins over one about to expire',
  S.pickBatches([
    { id: 'nodate', quantity_on_hand: 5, best_before_date: null, received_at: '2020-01-01' },
    { id: 'soon', quantity_on_hand: 5, best_before_date: '2026-10-10', received_at: '2026-01-01' },
  ], { policy: 'FEFO', requiredQty: 1 }).allocation[0].stock_batch_id === 'soon');
ok('LIFO takes the newest first',
  S.pickBatches(batches, { policy: 'LIFO', requiredQty: 1 }).allocation[0].stock_batch_id === 'b2');
ok('SPECIFIC mode takes only the chosen batch',
  S.pickBatches(batches, { policy: 'SPECIFIC', requiredQty: 4, specificBatchIds: ['b2'] }).allocation[0].stock_batch_id === 'b2');
ok('SPECIFIC with nothing chosen is refused', S.pickBatches(batches, { policy: 'SPECIFIC', requiredQty: 1 }).ok === false);
ok('an unknown policy is refused', S.pickBatches(batches, { policy: 'MAGIC', requiredQty: 1 }).ok === false);
const wc = S.weightedCost(fifo.allocation);
ok('a multi-batch pick has a weighted cost', wc.totalQty === 6 && wc.cost === M.round2((3 * 40000 + 3 * 42000)), wc.cost);
const val = S.valueBatches(batches);
ok('stock valuation reports cost, retail and potential margin',
  val.cost === 5 * 40000 + 10 * 42000 && val.potentialMargin === val.retail - val.cost, val);
ok('stock ageing buckets dead stock', S.ageBucket(200).code === '180_PLUS' && S.ageBucket(15).code === '0_30');
const advice = S.reorderAdvice({ quantityOnHand: 4, reorderLevel: 10, avgDailySales: 2, leadTimeDays: 7, reviewDays: 7 });
ok('reorder advice uses velocity, not just the reorder level',
  advice.suggestedReorderPoint === 35 && advice.shouldReorder === true && advice.urgency === 'CRITICAL', advice);
ok('stock cover days is what a manager actually reads', advice.stockCoverDays === 2);
ok('zero velocity with stock on hand is not "out of stock"',
  S.reorderAdvice({ quantityOnHand: 10, reorderLevel: 0, avgDailySales: 0 }).urgency === 'OK');
const shelf = S.shelfLifeAlerts({ batches: [
  { id: 'b', product_id: 'p', quantity_on_hand: 10, best_before_date: '2026-10-08', cost_per_unit: 100, selling_price_per_unit: 150 },
  { id: 'c', product_id: 'q', quantity_on_hand: 3, best_before_date: '2026-09-01', cost_per_unit: 100, selling_price_per_unit: 150 },
  { id: 'd', product_id: 'r', quantity_on_hand: 5, best_before_date: null },
], horizonsDays: [7, 30, 90], today: new Date('2026-10-04') });
ok('a dateless batch raises no shelf-life alert', shelf.every((a) => a.stock_batch_id !== 'd'));
ok('an expired batch is EXPIRED and recommends write-off',
  shelf.find((a) => a.stock_batch_id === 'c').band === 'EXPIRED' && shelf.find((a) => a.stock_batch_id === 'c').recommended_action === 'WRITE_OFF');
ok('alerts are sorted soonest-first', shelf[0].stock_batch_id === 'c');

// =====================================================================
group('N. FX — the rate used is the rate recorded, forever');
// =====================================================================
ok('conversion is NGN per unit, in the fixed direction', F.toBase(1000, 'USD', 1450) === 1450000);
ok('the inverse conversion round-trips', F.fromBase(1450000, 'USD', 1450) === 1000);
throwsCode('a zero rate is refused', () => F.toBase(100, 'USD', 0), 'MISSING_FX_RATE');
throwsCode('an inverted rate is caught by the band', () => F.validateRate({ currency: 'USD', rate: 0.00069, band: { USD: { min: 500, max: 3000 } } }), 'FX_RATE_OUT_OF_BAND');
ok('a plausible rate passes the band', F.validateRate({ currency: 'USD', rate: 1450, band: { USD: { min: 500, max: 3000 } } }) === 1450);
ok('NGN converts at rate 1 with no source', F.conversionRecord({ amount: 5000, currency: 'NGN' }).fx_rate === 1);
const rec = F.conversionRecord({ amount: 1000, currency: 'USD', rate: 1450, source: 'AGREED', rateDate: '2026-10-04' });
ok('a conversion records amount, rate, source AND date', rec.amount_ngn === 1450000 && rec.fx_source === 'AGREED' && rec.fx_rate_date === '2026-10-04');
const exp = F.replacementExposure({ stockValueAtCostNgn: 14500000, currentRate: 1600, costRate: 1450 });
ok('replacement exposure shows the margin illusion', exp.exposure === 1500000 && exp.direction === 'UNDER_VALUED', exp);
ok('a stress table shows several rates at once', F.replacementExposure({ stockValueAtCostNgn: 14500000, currentRate: 1600, costRate: 1450, stressRates: [1700, 2000] }).stress.length === 2);
ok('an FX cash tender settles in naira but goes to the FX drawer',
  F.fxCashTender({ foreignAmount: 500, currency: 'USD', rate: 1450 }).goes_to_fx_drawer === true);
throwsCode('an FX tender cannot be in naira', () => F.fxCashTender({ foreignAmount: 500, currency: 'NGN', rate: 1 }), 'FX_TENDER_IN_BASE');

// =====================================================================
group('O. HASH CHAIN — a record an insider cannot quietly rewrite');
// =====================================================================
const f1 = { sale_number: 'INV-LG-000001', buyer_name: 'Ada Obi', total_amount_kobo: 50000000 };
const f2 = { sale_number: 'INV-LG-000002', buyer_name: 'Bola Ahmed', total_amount_kobo: 20000000 };
const scope = { register: 'HIGH_VALUE_REGISTER', branchId: 'B1', dayIso: '2026-10-04' };
const r1 = H.appendRow({ ...scope, fields: f1 });
const r2 = H.appendRow({ ...scope, fields: f2, prevHash: r1.row_hash });
const r3 = H.appendRow({ ...scope, fields: { sale_number: 'INV-LG-000003', buyer_name: 'Chidi', total_amount_kobo: 9000000 }, prevHash: r2.row_hash });
ok('an intact chain verifies', H.verifyChain([r1, r2, r3], scope).ok === true);
ok('the chain starts from a published genesis value, not NULL', r1.prev_hash === H.GENESIS_HASH);
ok('field order in the input does not change the hash',
  H.rowHash({ b: 2, a: 1 }, H.GENESIS_HASH) === H.rowHash({ a: 1, b: 2 }, H.GENESIS_HASH));
ok('null and empty string hash differently',
  H.rowHash({ a: null }, H.GENESIS_HASH) !== H.rowHash({ a: '' }, H.GENESIS_HASH));
const tampered = { ...r2, payload_json: JSON.stringify({ ...f2, buyer_name: 'Someone Else' }) };
const broken = H.verifyChain([r1, tampered, r3], scope);
ok('editing a field in place is detected', broken.ok === false && broken.breaks.some((b) => b.type === 'CONTENT_BROKEN'), broken.breaks.map((b) => b.type));
ok('the break reports WHICH row and what changed', broken.breaks[0].rowId === tampered.id && broken.breaks[0].index === 1);
ok('everything after a break is reported unverifiable', broken.unverifiableRows === 2, broken.unverifiableRows);
const deleted = H.verifyChain([r1, r3], scope);
ok('deleting a middle row breaks the link', deleted.ok === false && deleted.breaks.some((b) => b.type === 'LINK_BROKEN'));
ok('removing the head of the chain is detected distinctly',
  H.verifyChain([r2, r3], scope).breaks[0].type === 'GENESIS_MISSING');
ok('an empty chain is not an error', H.verifyChain([], scope).ok === true);
ok('chains are scoped per branch per day (offline branches stay independent)',
  H.chainKey({ register: 'HIGH_VALUE_REGISTER', branchId: 'B1', dayIso: '2026-10-04' })
    !== H.chainKey({ register: 'HIGH_VALUE_REGISTER', branchId: 'B2', dayIso: '2026-10-04' }));
throwsCode('a register entry without a buyer is refused', () => H.highValueEntry({ quantity: 1, buyer: {} }), 'REGISTER_ENTRY_INCOMPLETE');
throwsCode('an ID number without an ID type is refused', () => H.highValueEntry({ buyer: { name: 'Ada' }, idNumber: '12345' }), 'REGISTER_ENTRY_INCOMPLETE');
ok('a valid register entry normalises the phone',
  H.highValueEntry({ buyer: { name: 'Ada', phone: '+234 803 123 4567' }, quantity: 1, idType: 'NIN', idNumber: '12345678901' }).buyer_phone === '08031234567');

// =====================================================================
group('P. TIME & GEO — one definition of "today", in Lagos');
// =====================================================================
ok('WAT is UTC+1', T.WAT_UTC_OFFSET_HOURS === 1);
ok('todayWat is a real ISO date', /^\d{4}-\d{2}-\d{2}$/.test(T.todayWat()), T.todayWat());
ok('the SQL fragment shifts BEFORE taking the date',
  T.SQL_WAT_DATE('created_at') === "date(created_at, '+1 hours')", T.SQL_WAT_DATE('created_at'));
ok('a sale at 23:30 UTC is the NEXT Lagos day',
  T.nowWat(new Date('2026-10-04T23:30:00Z')).toISOString().slice(0, 10) === '2026-10-05');
ok('a sale at 00:30 Lagos is the SAME Lagos day',
  T.nowWat(new Date('2026-10-03T23:30:00Z')).toISOString().slice(0, 10) === '2026-10-04');
ok('37 states including the FCT', T.NIGERIAN_STATES.length === 37);
ok('state codes are unique', new Set(T.NIGERIAN_STATES.map((s) => s.code)).size === 37);
ok('every state has a geopolitical zone', T.NIGERIAN_STATES.every((s) => T.GEO_POLITICAL_ZONES.some((z) => z.code === s.zone)));
ok('a state resolves from code or name', T.stateByCodeOrName('LA').name === 'Lagos' && T.stateByCodeOrName('kano').code === 'KN');
ok('Abuja is inside the Nigeria bounding box', T.isInsideNigeria(9.0765, 7.3986) === true);
ok('London is not', T.isInsideNigeria(51.5074, -0.1278) === false);
ok('haversine Lagos Island -> Ikeja is ~15 km',
  (() => { const d = T.haversineMeters(6.4531, 3.3958, 6.5965, 3.3421); return d > 14000 && d < 20000; })(),
  T.haversineMeters(6.4531, 3.3958, 6.5965, 3.3421));
ok('identical points are 0 m apart', T.haversineMeters(9.07, 7.39, 9.07, 7.39) === 0);
const onsite = T.classifyAttendance({ lat: 9.07650, lng: 7.39860, branch: { latitude: 9.07680, longitude: 7.39890, geofence_radius_meters: 100, attendance_mode: 'GEOLOCATION' } });
ok('a clock-in inside the geofence is ON_SITE', onsite.classification === 'ON_SITE' && onsite.flagged === false, onsite);
const offsite = T.classifyAttendance({ lat: 9.09, lng: 7.41, branch: { latitude: 9.0765, longitude: 7.3986, geofence_radius_meters: 100 } });
ok('a clock-in outside it is FLAGGED, never rejected', offsite.classification === 'OFF_SITE' && offsite.flagged === true);
ok('no GPS is recorded and flagged for review', T.classifyAttendance({ lat: null, lng: null, branch: { latitude: 9.07, longitude: 7.39 } }).classification === 'NO_LOCATION');
ok('a branch with no geofence says so instead of guessing',
  T.classifyAttendance({ lat: 9.07, lng: 7.39, branch: {} }).classification === 'GEOFENCE_NOT_SET');
ok('an unregistered device is flagged, not blocked',
  T.classifyAttendance({ branch: { attendance_mode: 'REGISTERED_DEVICE' }, deviceRecognised: false }).flagged === true);
ok('a registered device is ON_SITE without GPS',
  T.classifyAttendance({ branch: { attendance_mode: 'REGISTERED_DEVICE' }, deviceRecognised: true }).classification === 'ON_SITE');
ok('a 03:40 sale is outside trading hours (an anomaly signal)', T.isWithinTradingHours('2026-10-04 03:40:00') === false);

// =====================================================================
group('Q. VALIDATION — the boundary where bad data is stopped');
// =====================================================================
ok('a Nigerian mobile normalises from +234', VAL.ngPhone('+234 803 123 4567') === '08031234567');
ok('...and from 234 without the plus', VAL.ngPhone('2348031234567') === '08031234567');
ok('...and from dashes', VAL.ngPhone('0803-123-4567') === '08031234567');
throwsCode('a 9-digit number is refused', () => VAL.ngPhone('80312345', { required: true }), 'INVALID_PHONE');
ok('an 8-digit TIN is accepted', VAL.tin('12345678') === '12345678');
throwsCode('a 7-digit TIN is refused', () => VAL.tin('1234567', { required: true }), 'INVALID_TIN');
ok('a CAC number normalises to RC-123456', VAL.cacNumber('rc 123456') === 'RC-123456');
ok('a business name normalises too', VAL.cacNumber('BN7654321') === 'BN-7654321');
throwsCode('a malformed CAC number is refused', () => VAL.cacNumber('XYZ1', { required: true }), 'INVALID_CAC_NUMBER');
ok('a SONCAP number normalises', VAL.soncapNumber('soncap/pc/12345678') === 'SONCAP/PC/12345678');
ok('a valid EAN-13 passes', VAL.barcode('6156000138948') === '6156000138948');
throwsCode('an EAN-13 with a wrong check digit is caught at entry', () => VAL.barcode('6156000138949'), 'INVALID_BARCODE_CHECK_DIGIT');
ok('an internal SKU-style barcode is allowed', VAL.barcode('SR-TCL-55U8K') === 'SR-TCL-55U8K');
ok('a real calendar date passes', VAL.isoDate('2026-02-28') === '2026-02-28');
throwsCode('2026-02-30 is refused as not a real date', () => VAL.isoDate('2026-02-30'), 'INVALID_DATE');
ok('a pasted DD/MM/YYYY is normalised', VAL.isoDate('31/12/2026') === '2026-12-31');
const dr = VAL.dateRange({ start_date: '2030-01-01', end_date: '2020-01-01' });
ok('a reversed date range is swapped, not a 500', dr.start_date === '2020-01-01' && dr.end_date === '2030-01-01', dr);
ok('a date range defaults to 30 days', VAL.dateRange({}).days === 30);
throwsCode('an absurdly wide range is refused with guidance', () => VAL.dateRange({ start_date: '1900-01-01', end_date: '2100-01-01' }), 'DATE_RANGE_TOO_WIDE');
ok('whitespace is collapsed at the boundary', VAL.str('  Samsung    TV  ', { field: 'name' }) === 'Samsung TV');
throwsCode('a required field cannot be blank', () => VAL.str('   ', { field: 'name' }), 'REQUIRED_FIELD');
throwsCode('a blank quantity is not silently zero', () => VAL.qty('', { field: 'quantity' }), 'REQUIRED_FIELD');
throwsCode('a fractional quantity is refused', () => VAL.qty(2.5), 'NOT_AN_INTEGER');
ok('bool accepts the strings a form actually posts', VAL.bool('yes') === true && VAL.bool('0') === false && VAL.bool('on') === true);
throwsCode('a coordinate outside Nigeria is caught', () => VAL.coordinate(51.5, { field: 'latitude', axis: 'lat', nigeriaOnly: true }), 'OUT_OF_NIGERIA');
ok('pick drops absent fields so an UPDATE cannot null them',
  JSON.stringify(VAL.pick({ a: 1 }, ['a', 'b'])) === '{"a":1}');
throwsCode('an unexpected key is refused (mass-assignment defence)', () => VAL.assertNoUnknownKeys({ name: 'x', branch_id: 'other' }, ['name']), 'UNKNOWN_FIELD');

// =====================================================================
console.log(`\n${'='.repeat(66)}`);
console.log(`DOMAIN CORE: ${pass} passed, ${fail} failed`);
if (fails.length) {
  console.log('\nFAILED:');
  for (const f of fails) console.log(` - ${f}`);
}
console.log('='.repeat(66));
process.exit(fail ? 1 : 0);
