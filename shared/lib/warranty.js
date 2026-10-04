// =====================================================================
// shared/lib/warranty.js — SERIAL NUMBERS, WARRANTY COVER AND CLAIMS
// =====================================================================
//
// NEW TO STOCKRIDGE, and the single biggest reason an electronics retailer
// cannot run on a generic stock system.
//
// A serialised product is not "quantity 40". It is forty INDIVIDUAL objects,
// each with its own identity, its own purchase date, its own warranty clock
// and its own history. Three things break without this:
//
//   1. WARRANTY. A customer returns a fridge eleven months after purchase
//      claiming it is under warranty. Without a serial linked to a sale, the
//      shop either takes the word of anyone who walks in (and eats the cost of
//      a unit bought elsewhere) or refuses everyone (and loses the customer).
//      With it, the answer is a lookup.
//
//   2. THEFT AND GREY MARKET. A serial recorded at receipt and at sale is the
//      only way to prove which units were in which branch on which day. When a
//      branch reports a missing laptop, "we had 12, now we have 11" is not an
//      investigation. "IMEI 3582... was received in Ikeja on 3 March and never
//      sold" is.
//
//   3. RECALLS AND MANUFACTURER NOTICES. Samsung announces a batch of
//      washing machines with a faulty part. A retailer with serials can call
//      exactly the affected customers. A retailer without them puts a sign in
//      the window.
//
// SERIAL CAPTURE IS ENFORCED IN THE POS, NOT ADVISED. A product whose
// restriction is SERIAL_CAPTURE cannot complete a sale until one serial per
// unit has been recorded. Making it a warning means it never happens on a
// busy Saturday.
//
// WARRANTY CLOCK: starts at the SALE DATE by default, because that is what the
// customer's receipt says and what a manufacturer's own terms usually specify
// for an end consumer. It can be configured to start at RECEIPT for B2B
// supply, where the reseller's stock sits before it is sold — and where
// starting at receipt is the honest reading of the manufacturer's cover.

'use strict';

const { round2, toKobo, fromKobo } = require('./money');

const SERIAL_STATUSES = Object.freeze([
  'IN_STOCK',        // received, on the shelf
  'RESERVED',        // on a hold or allocated to a delivery job
  'SOLD',            // sold to a customer
  'RETURNED',        // came back from a customer
  'IN_REPAIR',       // with us or with a service agent
  'WITH_MANUFACTURER', // sent away under warranty
  'REPLACED',        // swapped out under a claim; a new serial supersedes it
  'SCRAPPED',        // written off — damaged beyond sale
  'LOST',            // unaccounted for; a shrinkage event
  'STOLEN',          // confirmed theft; flagged for police report
  'TRANSFERRED',     // moved to another branch (a new row tracks it there)
]);

const CLAIM_TYPES = Object.freeze(['REPAIR', 'REPLACE', 'REFUND', 'PARTS_ONLY', 'REJECT_AS_OUT_OF_COVER']);
const CLAIM_STATUSES = Object.freeze(['OPEN', 'ASSESSING', 'AWAITING_CUSTOMER', 'WITH_MANUFACTURER', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED']);
const CLAIM_OUTCOMES = Object.freeze(['REPAIRED', 'REPLACED', 'REFUNDED', 'PARTS_ISSUED', 'OUT_OF_COVER', 'CUSTOMER_FAULT', 'NOT_RESOLVED']);

const RESPONSIBILITY = Object.freeze([
  { code: 'MANUFACTURER', label: 'Manufacturer / importer warranty' },
  { code: 'SHOP',         label: 'Shop goodwill / own warranty' },
  { code: 'CUSTOMER',     label: 'Customer fault — chargeable' },
  { code: 'CARRIER',      label: 'Damage in transit — carrier liable' },
  { code: 'INSTALLER',    label: 'Installation fault — installer liable' },
]);

// A serial is a manufacturer string. Allow the shapes that actually occur:
// IMEI (15 digits), appliance model+serial (alphanumeric 6-30), and internal
// tags a shop prints itself. Normalise case and strip separators so a scan and
// a hand-keyed entry of the same serial match.
const SERIAL_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{3,39}$/;

function normaliseSerial(value) {
  if (value == null) return null;
  const s = String(value).trim().toUpperCase().replace(/\s+/g, '');
  return s === '' ? null : s;
}

function validateSerial(value, { field = 'serial_number' } = {}) {
  const s = normaliseSerial(value);
  if (!s) {
    const err = new Error('A serial number is required for this product');
    err.status = 400; err.code = 'SERIAL_REQUIRED'; err.field = field;
    throw err;
  }
  if (!SERIAL_PATTERN.test(s)) {
    const err = new Error(`"${s}" does not look like a serial number (4-40 letters/digits)`);
    err.status = 400; err.code = 'INVALID_SERIAL'; err.field = field;
    throw err;
  }
  return s;
}

/**
 * Validate a whole capture set against the quantity being sold.
 *
 * The count must match EXACTLY. Fewer serials than units means a unit left the
 * shop untracked; more means a duplicate scan was accepted, which corrupts the
 * register. Neither is tolerable, and both are caught here rather than at
 * report time.
 */
function validateCapture({ serials, requiredQty, existingSerials = [] }) {
  const need = Math.floor(Number(requiredQty) || 0);
  const seen = new Map();
  const problems = [];
  const clean = [];

  for (const raw of serials || []) {
    const s = normaliseSerial(raw);
    if (!s) continue;
    if (!SERIAL_PATTERN.test(s)) { problems.push({ serial: s, code: 'INVALID_SERIAL', message: `"${s}" is not a valid serial format` }); continue; }
    if (seen.has(s)) { problems.push({ serial: s, code: 'DUPLICATE_IN_CAPTURE', message: `"${s}" was scanned twice on this line` }); continue; }
    if (existingSerials.includes(s)) {
      problems.push({ serial: s, code: 'SERIAL_ALREADY_SOLD', message: `"${s}" is already recorded against another unit — it cannot be sold twice` });
      continue;
    }
    seen.set(s, true);
    clean.push(s);
  }

  if (problems.length) return { ok: false, serials: clean, problems, short: Math.max(0, need - clean.length) };
  if (clean.length < need) {
    return {
      ok: false, serials: clean, problems: [],
      short: need - clean.length,
      message: `${need - clean.length} more serial number(s) needed — one per unit being sold.`,
    };
  }
  if (clean.length > need) {
    return {
      ok: false, serials: clean.slice(0, need), problems: [],
      excess: clean.length - need,
      message: `${clean.length - need} more serial(s) captured than units on this line. Remove the extras.`,
    };
  }
  return { ok: true, serials: clean, problems: [], short: 0 };
}

function addMonths(dateIso, months) {
  let s = String(dateIso).slice(0, 10);
  const parts = s.split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2] || 1;
  const targetMonth = (m - 1) + Math.floor(Number(months) || 0);
  const targetYear = y + Math.floor(targetMonth / 12);
  const normMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(normMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Warranty expiry for one serial.
 *
 * `basis`:
 *   SALE      — from the sale date (default; matches the customer's receipt)
 *   RECEIPT   — from goods-received (B2B supply, and manufacturer cover that
 *               starts at import)
 *   MANUFACTURE — from a manufacture date recorded at receipt
 *
 * Extended cover (an optional paid extension, very common on appliances) is
 * added on top and recorded separately so the shop can see how much extension
 * revenue it wrote.
 */
function warrantyExpiry({ months, extendedMonths = 0, basis = 'SALE', saleDate, receiptDate, manufactureDate }) {
  const anchor = String(basis || 'SALE').toUpperCase() === 'RECEIPT' ? receiptDate
    : String(basis || 'SALE').toUpperCase() === 'MANUFACTURE' ? manufactureDate
      : saleDate;
  if (!anchor) return null;
  const total = Math.max(0, Math.floor(Number(months) || 0)) + Math.max(0, Math.floor(Number(extendedMonths) || 0));
  if (total <= 0) return null;
  return addMonths(String(anchor).slice(0, 10), total);
}

/**
 * Is this serial in cover TODAY, and if not, why not?
 *
 * The `reasons` list matters: "out of warranty" is not one condition. It is
 * "expired 40 days ago", or "no warranty on this product", or "void because
 * the seal was broken", or "void because it was installed by an unauthorised
 * person". Telling the customer which one it is turns an argument into a
 * conversation.
 */
function assessCover({ serial, product, sale, today = new Date() }) {
  const todayIso = (today instanceof Date ? today : new Date(today)).toISOString().slice(0, 10);
  const months = Math.max(0, Math.floor(Number(serial.warranty_months != null ? serial.warranty_months : product && product.warranty_months) || 0));
  const extended = Math.max(0, Math.floor(Number(serial.warranty_extended_months) || 0));

  if (serial.warranty_status && ['VOID', 'REPLACED', 'REFUNDED'].includes(String(serial.warranty_status).toUpperCase())) {
    return {
      inCover: false, status: String(serial.warranty_status).toUpperCase(),
      expiresOn: serial.warranty_expires_on || null, daysRemaining: null,
      reasons: [{ code: 'STATUS_VOID', message: serial.warranty_void_reason || 'This warranty has been voided.' }],
    };
  }
  if (months + extended <= 0) {
    return {
      inCover: false, status: 'NO_WARRANTY', expiresOn: null, daysRemaining: null,
      reasons: [{ code: 'NO_WARRANTY', message: 'No warranty is recorded for this product.' }],
    };
  }
  if (!sale || !sale.sale_date) {
    return {
      inCover: false, status: 'NO_SALE_RECORD', expiresOn: null, daysRemaining: null,
      reasons: [{ code: 'NO_SALE_RECORD', message: 'This serial is not linked to a sale. Find the original invoice before assessing cover.' }],
    };
  }

  const expiry = warrantyExpiry({
    months, extendedMonths: extended,
    basis: serial.warranty_basis || product && product.warranty_basis || 'SALE',
    saleDate: sale.sale_date,
    receiptDate: serial.received_at,
    manufactureDate: serial.manufacture_date,
  });
  if (!expiry) {
    return { inCover: false, status: 'UNKNOWN', expiresOn: null, daysRemaining: null, reasons: [{ code: 'UNKNOWN', message: 'Warranty expiry could not be computed.' }] };
  }

  const days = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000);
  const reasons = [];
  if (days < 0) {
    reasons.push({ code: 'EXPIRED', message: `Warranty expired ${Math.abs(days)} day(s) ago on ${expiry}.` });
  } else if (days <= 30) {
    reasons.push({ code: 'EXPIRING_SOON', message: `Warranty expires in ${days} day(s) on ${expiry}.` });
  }
  if (product && product.warranty_requires_receipt && !sale.receipt_number) {
    reasons.push({ code: 'NO_RECEIPT', message: 'Cover requires the original receipt, which is not on file.' });
  }
  return {
    inCover: days >= 0,
    status: days >= 0 ? 'IN_WARRANTY' : 'OUT_OF_WARRANTY',
    expiresOn: expiry,
    daysRemaining: days,
    warrantyMonths: months,
    extendedMonths: extended,
    purchasedOn: String(sale.sale_date).slice(0, 10),
    reasons,
  };
}

/**
 * Open a claim. Validates the transitions that matter commercially:
 *   * a claim cannot be opened against a serial that was never sold by us
 *     (that is a manufacturer matter, and taking it on is unpaid labour)
 *   * a claim on an out-of-cover serial is allowed but is recorded as
 *     RESPONSIBILITY=CUSTOMER with a chargeable assessment, because shops DO
 *     repair out-of-warranty items — they just must not book it as a warranty
 *     expense.
 */
function openClaim({ serial, cover, claimType, reportedBy, description, responsibility }) {
  const type = String(claimType || '').toUpperCase();
  if (!CLAIM_TYPES.includes(type)) {
    return { ok: false, code: 'INVALID_CLAIM_TYPE', error: `Claim type must be one of: ${CLAIM_TYPES.join(', ')}` };
  }
  if (!serial || !serial.id) {
    return { ok: false, code: 'SERIAL_NOT_FOUND', error: 'Scan or enter the serial number first.' };
  }
  const status = String((serial && serial.status) || '').toUpperCase();
  if (!['SOLD', 'RETURNED', 'IN_REPAIR'].includes(status)) {
    return {
      ok: false, code: 'SERIAL_NOT_SOLD',
      error: `This unit is recorded as ${serial.status}. A warranty claim needs a unit that was sold to a customer.`,
    };
  }
  const desc = String(description || '').trim();
  if (desc.length < 10) {
    return { ok: false, code: 'DESCRIPTION_TOO_SHORT', error: 'Describe the fault in at least a sentence — the manufacturer will ask for it.' };
  }

  const resp = String(responsibility || (cover && cover.inCover ? 'MANUFACTURER' : 'CUSTOMER')).toUpperCase();
  if (!RESPONSIBILITY.some((r) => r.code === resp)) {
    return { ok: false, code: 'INVALID_RESPONSIBILITY', error: `Responsibility must be one of: ${RESPONSIBILITY.map((r) => r.code).join(', ')}` };
  }

  return {
    ok: true,
    claim: {
      serial_id: serial.id,
      serial_number: serial.serial_number,
      product_id: serial.product_id,
      customer_id: serial.customer_id || (reportedBy && reportedBy.id) || null,
      claim_type: type,
      status: 'OPEN',
      responsibility: resp,
      chargeable: resp === 'CUSTOMER' || resp === 'INSTALLER',
      in_cover_at_open: !!(cover && cover.inCover),
      cover_status: cover ? cover.status : 'UNKNOWN',
      cover_expires_on: cover ? cover.expiresOn : null,
      description: desc.slice(0, 2000),
      reported_by_name: (reportedBy && reportedBy.name) || null,
      reported_by_phone: (reportedBy && reportedBy.phone) || null,
      opened_on: new Date().toISOString().slice(0, 10),
    },
    // The serial leaves the sellable pool for the duration.
    serialStatusTransition: type === 'REJECT_AS_OUT_OF_COVER' ? null : 'IN_REPAIR',
    notes: resp === 'MANUFACTURER'
      ? 'Book the unit out to the manufacturer/importer and record the RMA number.'
      : resp === 'CUSTOMER'
        ? 'Quote the customer before any work. This is chargeable, not a warranty cost.'
        : 'Record who is liable before the work is done.',
  };
}

/**
 * Resolve a claim. Each outcome has a different stock and money effect, and
 * getting them mixed up is how a replacement unit disappears from the stock
 * report:
 *
 *   REPAIRED   the SAME serial returns to the customer. No stock movement;
 *              the repair cost is an expense against the warranty provision.
 *   REPLACED   the old serial goes to status REPLACED (it may go back to the
 *              manufacturer). A NEW serial is issued and decrements stock at
 *              cost — so the replacement must be in stock or on order.
 *   REFUNDED   money back, the unit returns to stock as RETURNED (and is
 *              usually scrapped or sold as refurbished, never as new).
 *   PARTS_ONLY parts issued; recorded as an expense, no unit movement.
 */
function resolveClaim({ claim, outcome, newSerial = null, refundAmount = 0, repairCostKobo = 0, restockAs = 'SCRAPPED' }) {
  const o = String(outcome || '').toUpperCase();
  const effects = { claimStatus: 'COMPLETED', serialStatus: null, newSerial: null, stockMovement: null, refundKobo: 0, expenseKobo: 0 };

  switch (o) {
    case 'REPAIRED':
      effects.serialStatus = 'SOLD';           // back with the customer
      effects.expenseKobo = Math.max(0, toKobo(repairCostKobo));
      break;
    case 'REPLACED': {
      const ns = normaliseSerial(newSerial);
      if (!ns) return { ok: false, code: 'REPLACEMENT_SERIAL_REQUIRED', error: 'A replacement needs its own serial number recorded.' };
      effects.serialStatus = 'REPLACED';
      effects.newSerial = ns;
      effects.stockMovement = { type: 'WARRANTY_SWAP', direction: -1, quantity: 1, note: `Replacement issued for claim on ${claim.serial_number}` };
      break;
    }
    case 'REFUNDED':
      effects.serialStatus = 'RETURNED';
      effects.refundKobo = Math.max(0, toKobo(refundAmount));
      effects.stockMovement = {
        type: 'SALE_RETURN', direction: 1, quantity: 1,
        restock_as: restockAs,
        note: `Refunded under warranty claim; unit returned as ${restockAs}`,
      };
      break;
    case 'PARTS_ISSUED':
      effects.serialStatus = 'SOLD';
      effects.expenseKobo = Math.max(0, toKobo(repairCostKobo));
      break;
    case 'OUT_OF_COVER':
      effects.claimStatus = 'COMPLETED';
      effects.serialStatus = 'SOLD';
      effects.chargeable = true;
      break;
    case 'CUSTOMER_FAULT':
      effects.serialStatus = 'SOLD';
      effects.chargeable = true;
      break;
    case 'NOT_RESOLVED':
      effects.claimStatus = 'COMPLETED';
      effects.serialStatus = 'IN_REPAIR';
      break;
    default:
      return { ok: false, code: 'INVALID_CLAIM_OUTCOME', error: `Outcome must be one of: ${CLAIM_OUTCOMES.join(', ')}` };
  }

  return { ok: true, outcome: o, effects };
}

/**
 * Warranty provision.
 *
 * A business selling 1,000 warrantied appliances a month WILL have claims.
 * Recognising the cost only when a claim arrives makes one month look
 * catastrophic and the rest look artificially profitable. The provision is a
 * percentage of warrantied revenue, accrued monthly and drawn down as claims
 * are settled. The percentage is a client setting — a shop selling a brand
 * with a bad failure rate needs a higher one than a shop selling a good one.
 */
function warrantyProvision({ warrantiedRevenue, provisionPercent = 1.5, claimsSettledKobo = 0, openingProvisionKobo = 0 }) {
  const revK = toKobo(warrantiedRevenue);
  const pct = Math.min(20, Math.max(0, Number(provisionPercent) || 0));
  const accrualK = Math.round((revK * pct) / 100);
  const settledK = Math.max(0, Math.round(Number(claimsSettledKobo) || 0));
  const openingK = Math.max(0, Math.round(Number(openingProvisionKobo) || 0));
  const closingK = openingK + accrualK - settledK;
  return {
    provisionPercent: pct,
    warrantiedRevenue: fromKobo(revK),
    openingProvision: fromKobo(openingK),
    accrual: fromKobo(accrualK),
    claimsSettled: fromKobo(settledK),
    closingProvision: fromKobo(Math.max(0, closingK)),
    underProvisioned: closingK < 0,
    note: closingK < 0
      ? 'Claims have exceeded the provision. Either the percentage is too low or a specific product line is failing — check claims by product.'
      : null,
  };
}

module.exports = {
  SERIAL_STATUSES, CLAIM_TYPES, CLAIM_STATUSES, CLAIM_OUTCOMES, RESPONSIBILITY,
  normaliseSerial, validateSerial, validateCapture, addMonths,
  warrantyExpiry, assessCover, openClaim, resolveClaim, warrantyProvision,
};
