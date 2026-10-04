// =====================================================================
// StockRidge — SERIALISED STOCK & WARRANTY
// =====================================================================
// WHY THIS EXISTS AT ALL, AND WHY A PHARMACY SYSTEM NEVER NEEDED IT
// ---------------------------------------------------------------------
// Medicine is fungible: any tablet of the same batch is the same tablet.
// A refrigerator is not. When a customer returns six months later saying
// "the one you sold me is not cooling", the shop has to answer four
// questions from memory or from a paper card that may be lost:
//   1. Did WE sell it, and to whom, and when?
//   2. Is it the unit we sold, or a different one bought elsewhere?
//   3. Is it still in warranty, and whose warranty — the manufacturer's or
//      ours?
//   4. What did it cost us, so we know whether to repair, replace or refuse?
//
// The serial number answers 1 and 2. The warranty period answers 3. The
// batch cost answers 4. Without all three the retailer either pays for
// repairs on units it never sold (a real and common leak — "grey" units
// bought at Computer Village get presented to whichever shop will honour
// them) or refuses legitimate claims and loses the customer.
//
// ---------------------------------------------------------------------
// SERIALISED UNITS
// ---------------------------------------------------------------------
// A serialized_unit is ONE physical item, distinct from a stock_batch
// which is a QUANTITY of fungible items. Receiving 20 TVs creates one
// batch with quantity 20 AND twenty serialized_unit rows. Selling one
// decrements the batch by 1 and moves one unit to SOLD.
//
// Invariant enforced in stockService: a batch of a serialised product can
// never have fewer live units than its quantity, or more. If those two
// numbers disagree, the shop cannot answer "which serials do I actually
// hold" and the warranty register is fiction.
// =====================================================================

const { round2 } = require('./money');
const { isoDate, addMonths, daysBetween } = require('./creditPlans');

const UNIT_STATUSES = Object.freeze([
  'IN_STOCK',       // on the shelf, available
  'RESERVED',       // held against a layaway or an item hold
  'IN_TRANSIT',     // on a transfer between branches
  'SOLD',           // handed over to a customer
  'AT_SERVICE_CENTRE', // with us or the manufacturer for repair
  'RETURNED_TO_SUPPLIER',
  'REPOSSESSED',    // taken back from a defaulted instalment plan
  'DAMAGED',        // not sellable at full price
  'SCRAPPED',       // written off
]);

// Which statuses still represent stock the business holds and can sell.
// REPOSSESSED and DAMAGED are held but not freely sellable — they are
// counted in stock value and excluded from "available to promise".
const OWNED_STATUSES = Object.freeze(['IN_STOCK', 'RESERVED', 'IN_TRANSIT', 'REPOSSESSED', 'DAMAGED', 'AT_SERVICE_CENTRE']);
const AVAILABLE_STATUSES = Object.freeze(['IN_STOCK']);

const CLAIM_STATUSES = Object.freeze([
  'LOGGED',        // customer has reported a fault; nothing decided yet
  'ASSESSING',     // with a technician
  'APPROVED',      // we accept it is a valid warranty claim
  'REJECTED',      // out of warranty, misuse, or not our unit
  'IN_REPAIR',
  'AWAITING_PARTS',
  'COMPLETED',
  'ESCALATED_TO_MANUFACTURER',
  'CLOSED',
]);

const CLAIM_OUTCOMES = Object.freeze(['REPAIRED', 'REPLACED', 'REFUNDED', 'REJECTED', 'SCRAPPED', 'RETURNED_TO_SUPPLIER']);

// Who bears the cost. This is the field that makes warranty a P&L line
// rather than a mystery: a MANUFACTURER claim is recoverable from the brand
// (and until it is, it is a receivable); a SHOP claim comes straight out of
// the retailer's margin. Mixing them up means the shop silently absorbs
// every manufacturer defect and never reclaims a kobo.
const COST_BEARERS = Object.freeze(['MANUFACTURER', 'SHOP', 'CUSTOMER', 'SUPPLIER']);

// ---------------------------------------------------------------------
// WARRANTY ENTITLEMENT
// ---------------------------------------------------------------------
// Warranty runs from the DATE OF SALE (handover), not from the date of
// manufacture and not from the date of import. Running it from manufacture
// is how a customer who bought a fridge in month 11 of its shelf life gets
// one month of cover on a two-year warranty — and how the retailer gets
// blamed for the manufacturer's date.
//
// Where a product carries BOTH a manufacturer and a shop warranty, they run
// CONCURRENTLY from the same sale date but for different durations and with
// different cost bearers. The entitlement function returns both so the
// counter staff can tell the customer the truth: "the compressor is covered
// by Hisense for 5 years, the rest by us for 12 months".
function warrantyEntitlement({ saleDate, warrantyMonths = 0, warrantyType = 'NONE', extendedMonths = 0, extendedPurchased = false, now = new Date() }) {
  const start = saleDate ? isoDate(saleDate) : null;
  if (!start) {
    return { covered: false, reason: 'NO_SALE_DATE', message: 'No sale date on record — entitlement cannot be determined.' };
  }

  const base = Math.max(0, Number(warrantyMonths) || 0);
  const ext = extendedPurchased ? Math.max(0, Number(extendedMonths) || 0) : 0;
  const today = isoDate(now);

  const result = {
    start_date: start,
    warranty_type: warrantyType || 'NONE',
    base_months: base,
    extended_months: ext,
    extended_purchased: Boolean(extendedPurchased),
  };

  if (base <= 0 && ext <= 0) {
    return { ...result, covered: false, reason: 'NO_WARRANTY', message: 'This product was sold without a warranty.' };
  }

  const baseEnd = base > 0 ? isoDate(addMonths(new Date(start), base)) : null;
  const extEnd = ext > 0 ? isoDate(addMonths(new Date(start), base + ext)) : null;

  const inBase = baseEnd ? today <= baseEnd : false;
  const inExtended = extEnd ? today > (baseEnd || start) && today <= extEnd : false;
  const covered = inBase || inExtended;

  const daysLeft = covered ? daysBetween(today, inBase ? baseEnd : extEnd) : 0;

  return {
    ...result,
    base_expiry_date: baseEnd,
    extended_expiry_date: extEnd,
    covered,
    in_base_period: inBase,
    in_extended_period: inExtended,
    days_remaining: Math.max(0, daysLeft),
    expired_date: inBase ? null : (baseEnd || extEnd),
    days_since_expiry: covered ? 0 : Math.max(0, daysBetween(inBase ? baseEnd : extEnd, today)),
    reason: covered ? (inBase ? 'IN_BASE_WARRANTY' : 'IN_EXTENDED_WARRANTY') : 'EXPIRED',
    message: covered
      ? `${inBase ? 'Manufacturer/shop' : 'Extended'} warranty — ${Math.max(0, daysLeft).toLocaleString('en-NG')} day(s) remaining.`
      : `Warranty expired${baseEnd ? ` on ${baseEnd}` : ''}.`,
  };
}

// A claim is legitimate only when all four facts line up. Each check returns
// its own reason so the counter can say exactly WHICH one failed — "no
// warranty" and "not our unit" lead to completely different conversations.
function assessClaimEligibility({ unit, sale, entitlement, reportedSerialMatches = true }) {
  const checks = [];

  checks.push({
    code: 'UNIT_ON_RECORD',
    ok: Boolean(unit && unit.id),
    message: unit && unit.id ? null : 'No such serial number on record. It may not have been captured at receiving.',
  });

  checks.push({
    code: 'SOLD_BY_US',
    ok: Boolean(unit && unit.sale_id && sale && sale.id),
    message: unit && unit.sale_id ? null : 'This serial is not recorded as sold by us. It may be a grey-market unit or belong to another dealer.',
  });

  checks.push({
    code: 'SERIAL_MATCHES_SALE',
    ok: reportedSerialMatches,
    message: reportedSerialMatches ? null : 'The serial presented does not match the one on the sales record.',
  });

  checks.push({
    code: 'IN_WARRANTY',
    ok: Boolean(entitlement && entitlement.covered),
    message: entitlement && entitlement.covered ? null : (entitlement && entitlement.message) || 'Warranty status unknown.',
  });

  checks.push({
    code: 'UNIT_NOT_ALREADY_SCRAPPED',
    ok: !unit || (unit.status !== 'SCRAPPED' && unit.status !== 'RETURNED_TO_SUPPLIER'),
    message: unit && (unit.status === 'SCRAPPED' || unit.status === 'RETURNED_TO_SUPPLIER')
      ? `This unit is recorded as ${String(unit.status).replace(/_/g, ' ').toLowerCase()} and cannot be claimed against.`
      : null,
  });

  const eligible = checks.every((c) => c.ok);
  return {
    eligible,
    checks,
    failed: checks.filter((c) => !c.ok),
    // A claim can still be SERVICED when ineligible — as a paid repair.
    // Offering that is good business: the customer is in the shop with a
    // broken appliance and a refusal is the end of the relationship, while
    // a ₦25,000 repair fee is revenue and goodwill.
    offerableAsPaidRepair: checks.some((c) => c.code === 'IN_WARRANTY' && !c.ok) && checks.filter((c) => c.code !== 'IN_WARRANTY').every((c) => c.ok),
  };
}

// ---------------------------------------------------------------------
// WARRANTY COST & RECOVERABILITY
// ---------------------------------------------------------------------
// The cost of a claim splits three ways and each part lands in a different
// account. Getting this right is what makes the warranty line in the P&L
// mean something.
function warrantyCostBreakdown({ partsCost = 0, labourCost = 0, logisticsCost = 0, costBearer = 'SHOP', manufacturerRecoverable = null }) {
  const parts = round2(partsCost);
  const labour = round2(labourCost);
  const logistics = round2(logisticsCost);
  const total = round2(parts + labour + logistics);

  // Where the manufacturer bears the cost, the amount is RECOVERABLE — an
  // asset (a receivable from the brand) rather than an expense. It stays
  // recoverable until the credit note actually arrives, so the shop does
  // not book income it has not received.
  const recoverable = costBearer === 'MANUFACTURER' || costBearer === 'SUPPLIER'
    ? round2(manufacturerRecoverable != null ? manufacturerRecoverable : total)
    : 0;

  return {
    parts_cost: parts,
    labour_cost: labour,
    logistics_cost: logistics,
    total_cost: total,
    cost_bearer: costBearer,
    recoverable_amount: recoverable,
    net_cost_to_shop: round2(total - recoverable),
    borne_by_shop: costBearer === 'SHOP' || costBearer === 'CUSTOMER' ? round2(total - recoverable) : 0,
  };
}

// Replacement vs repair decision support. The honest rule used by service
// managers: if a repair will cost more than a stated share of a replacement
// unit's current value, replace it — a repaired appliance that fails again
// in a month costs twice and destroys the customer's confidence.
const REPAIR_VS_REPLACE_THRESHOLD_PERCENT = 60;

function repairOrReplace({ estimatedRepairCost, replacementValue, thresholdPercent = REPAIR_VS_REPLACE_THRESHOLD_PERCENT }) {
  const repair = round2(estimatedRepairCost);
  const replace = round2(replacementValue);
  if (!(replace > 0)) return { recommendation: 'REPAIR', reason: 'No replacement value on record; repair by default.' };
  const pct = round2((repair / replace) * 100);
  const threshold = Math.max(0, Number(thresholdPercent) || REPAIR_VS_REPLACE_THRESHOLD_PERCENT);
  return {
    recommendation: pct > threshold ? 'REPLACE' : 'REPAIR',
    repair_cost: repair,
    replacement_value: replace,
    repair_as_percent_of_replacement: pct,
    threshold_percent: threshold,
    reason: pct > threshold
      ? `Repairing costs ${pct.toFixed(0)}% of a replacement, above the ${threshold}% threshold. Replace — a second failure would cost more than the unit is worth.`
      : `Repairing costs ${pct.toFixed(0)}% of a replacement, within the ${threshold}% threshold. Repair.`,
  };
}

// ---------------------------------------------------------------------
// WARRANTY EXPIRY NOTIFICATIONS
// ---------------------------------------------------------------------
// A genuinely useful commercial feature rather than a compliance one: a
// customer whose warranty expires in 30 days is a customer who may want an
// extended plan, a service contract, or a new unit. This is the marketing
// list, produced from data the shop already has.
const EXPIRY_NOTICE_WINDOWS_DAYS = Object.freeze([90, 60, 30, 7]);

function expiringWarrantyWindow(expiryDate, now = new Date()) {
  const end = expiryDate ? isoDate(expiryDate) : null;
  if (!end) return null;
  const today = isoDate(now);
  const days = daysBetween(today, end);
  if (days < 0) return { window: 'EXPIRED', days: -days };
  const hit = [...EXPIRY_NOTICE_WINDOWS_DAYS].sort((a, b) => a - b).find((w) => days <= w);
  return hit ? { window: `WITHIN_${hit}`, days } : { window: 'BEYOND', days };
}

// Serial number normalisation. Manufacturers stamp serials inconsistently —
// with and without spaces, in mixed case, sometimes with an O that is a
// zero. Two records for the same physical unit because one clerk typed it
// with a space is a duplicate warranty claim waiting to happen.
function normaliseSerial(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

// IMEI is a special case: 15 digits, Luhn-checked. Validating it catches a
// mistyped digit at the point of sale rather than at the point of claim,
// when the customer is standing in the shop with a phone that will not
// register.
function isValidImei(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(digits[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

module.exports = {
  UNIT_STATUSES,
  OWNED_STATUSES,
  AVAILABLE_STATUSES,
  CLAIM_STATUSES,
  CLAIM_OUTCOMES,
  COST_BEARERS,
  REPAIR_VS_REPLACE_THRESHOLD_PERCENT,
  EXPIRY_NOTICE_WINDOWS_DAYS,
  warrantyEntitlement,
  assessClaimEligibility,
  warrantyCostBreakdown,
  repairOrReplace,
  expiringWarrantyWindow,
  normaliseSerial,
  isValidImei,
};
