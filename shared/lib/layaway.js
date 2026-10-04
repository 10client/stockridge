// =====================================================================
// shared/lib/layaway.js — ITEM HOLDS ("WE'LL KEEP IT FOR YOU")
// =====================================================================
//
// NEW TO STOCKRIDGE. A hold is NOT a sale and NOT an instalment plan, though
// it is the front door to both. It is the answer to three very common
// Nigerian retail situations:
//
//   1. "Keep this 65-inch TV for me, I'm coming back Saturday with the money."
//   2. "I've paid a deposit on this sofa; don't sell it."
//   3. "This customer is collecting on behalf of a corporate buyer — hold the
//      20 chairs until the PO clears."
//
// THE CRITICAL PROPERTY: a held item is still ON HAND but NOT SELLABLE.
//
//   quantity_on_hand   — what is physically in the branch
//   quantity_reserved  — what is spoken for (holds, layaways, dispatched
//                        deliveries, allocated transfer stock)
//   sellable           — on_hand - reserved
//
// A POS that checks `quantity_on_hand > 0` will sell the same TV twice on two
// tills. Every availability check in StockRidge goes through sellable, and the
// hold is the main reason that distinction exists.
//
// A hold EXPIRES. An unbounded hold is a stock report that lies: three
// abandoned holds on the only generator in the branch means the branch has
// been showing "0 available" for a month while the generator sat in the
// corner. Expiry is configurable per hold and a nightly job releases anything
// overdue, logging the release so a manager can see what was let go.

'use strict';

const { round2, toKobo, fromKobo } = require('./money');

const HOLD_STATUSES = Object.freeze(['ACTIVE', 'CONVERTED', 'RELEASED', 'EXPIRED', 'CANCELLED']);
const HOLD_REASONS = Object.freeze([
  { code: 'CUSTOMER_REQUEST', label: 'Customer asked us to hold it' },
  { code: 'DEPOSIT_PAID',     label: 'Deposit paid' },
  { code: 'AWAITING_PAYMENT', label: 'Awaiting payment clearance' },
  { code: 'AWAITING_DELIVERY', label: 'Awaiting collection / delivery slot' },
  { code: 'CORPORATE_PO',     label: 'Against a corporate purchase order' },
  { code: 'WARRANTY_SWAP',    label: 'Reserved for a warranty replacement' },
  { code: 'OTHER',            label: 'Other' },
]);
const HOLD_REASON_CODES = new Set(HOLD_REASONS.map((r) => r.code));

const DEFAULT_HOLD_DAYS = 7;
const MAX_HOLD_DAYS = 180;

/**
 * Create a hold. PURE validation + shape; the caller writes the row and
 * increments stock_batches.quantity_reserved in the SAME transaction, because
 * a hold without the reservation is a promise the stock report does not know
 * about.
 */
function createHold({ product, branchId, customerId, quantity, deposit = 0, holdDays, reason, notes, startDate, sellingPrice }) {
  const qty = Math.floor(Number(quantity) || 0);
  if (qty <= 0) {
    return err('Hold at least one unit', 'INVALID_HOLD_QTY');
  }
  if (!branchId) return err('A hold must belong to a branch', 'HOLD_NEEDS_BRANCH');
  if (!customerId) {
    // A hold with no customer cannot be chased, cannot be collected, and will
    // simply expire. Allowed (walk-ins do happen) but flagged, and it cannot
    // carry a deposit — money taken against nobody is unreconcilable.
    if (toKobo(deposit) > 0) return err('A deposit requires a named customer', 'DEPOSIT_NEEDS_CUSTOMER');
  }

  const days = Math.min(MAX_HOLD_DAYS, Math.max(1, Math.floor(Number(holdDays == null ? DEFAULT_HOLD_DAYS : holdDays))));
  const rsn = String(reason || 'CUSTOMER_REQUEST').toUpperCase();
  if (!HOLD_REASON_CODES.has(rsn)) {
    return err(`Hold reason must be one of: ${[...HOLD_REASON_CODES].join(', ')}`, 'INVALID_HOLD_REASON');
  }

  const start = String(startDate || new Date().toISOString()).slice(0, 10);
  const expires = addDays(start, days);
  const depK = Math.max(0, toKobo(deposit));
  const priceK = toKobo(sellingPrice == null ? 0 : sellingPrice);
  const totalK = priceK * qty;

  if (depK > totalK && totalK > 0) {
    return err('The deposit cannot exceed the value of the held items', 'DEPOSIT_EXCEEDS_VALUE');
  }

  return {
    ok: true,
    hold: {
      product_id: product ? product.id : null,
      product_name: product ? product.name : null,
      branch_id: branchId,
      customer_id: customerId || null,
      quantity: qty,
      reason: rsn,
      notes: notes ? String(notes).slice(0, 500) : null,
      deposit_kobo: depK,
      deposit: fromKobo(depK),
      balance_kobo: Math.max(0, totalK - depK),
      balance: fromKobo(Math.max(0, totalK - depK)),
      unit_price_kobo: priceK,
      unit_price: fromKobo(priceK),
      total_value_kobo: totalK,
      total_value: fromKobo(totalK),
      deposit_percent: totalK > 0 ? round2((depK / totalK) * 100) : 0,
      held_from: start,
      expires_on: expires,
      status: 'ACTIVE',
      // Does this hold lock stock? A CORPORATE_PO or WARRANTY_SWAP hold does;
      // a "keep it in the back for me" note against an item that is not
      // actually in the branch yet does not.
      reserves_stock: true,
    },
  };
}

function err(message, code) {
  return { ok: false, code, error: message };
}

function addDays(dateIso, days) {
  const d = new Date(Date.parse(`${String(dateIso).slice(0, 10)}T00:00:00Z`));
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.floor(Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Extend a hold. Deliberately capped and DELIBERATELY LOGGED: repeated
 * extension is how an abandoned hold quietly becomes permanent, and a manager
 * should be able to see that a given item has been held-and-extended four
 * times.
 */
function extendHold({ hold, extraDays, maxExtensions = 3 }) {
  const extensions = Number(hold.extension_count) || 0;
  if (extensions >= maxExtensions) {
    return {
      ok: false, code: 'HOLD_EXTENSION_LIMIT',
      error: `This hold has already been extended ${extensions} times. Convert it to a sale, an instalment plan, or release the stock — a manager can override from the holds screen.`,
    };
  }
  const days = Math.min(MAX_HOLD_DAYS, Math.max(1, Math.floor(Number(extraDays) || DEFAULT_HOLD_DAYS)));
  const from = String(hold.expires_on || new Date().toISOString()).slice(0, 10);
  return {
    ok: true,
    expires_on: addDays(from, days),
    extension_count: extensions + 1,
    extension_days: days,
  };
}

/**
 * Release a hold: stock becomes sellable again.
 * Returns the deposit disposition, because releasing a hold that carried a
 * deposit is a money event, not just a stock event.
 */
function releaseHold({ hold, reason, refundDeposit = true, forfeitPercent = 0 }) {
  const depK = toKobo(hold.deposit || 0);
  const forfeitPct = Math.min(100, Math.max(0, Number(forfeitPercent) || 0));
  const forfeitK = Math.round((depK * forfeitPct) / 100);
  const refundK = refundDeposit ? Math.max(0, depK - forfeitK) : 0;

  return {
    ok: true,
    status: String(reason || '').toUpperCase() === 'EXPIRED' ? 'EXPIRED' : 'RELEASED',
    release_reason: reason || 'MANUAL',
    quantity_to_release: Number(hold.quantity) || 0,
    deposit: fromKobo(depK),
    deposit_forfeited: fromKobo(forfeitK),
    deposit_refundable: fromKobo(refundK),
    // A forfeited deposit is OTHER INCOME, not sales revenue: no goods left
    // the shop, so recognising it as revenue would overstate turnover and
    // understate margin.
    glTreatment: forfeitK > 0 ? { account: 'OTHER_INCOME', amount_kobo: forfeitK } : null,
    note: refundK > 0
      ? `Refund ${fromKobo(refundK)} from the branch safe or till.`
      : 'No refund due on this hold.',
  };
}

/**
 * Convert a hold into a real sale.
 * The reserved quantity moves to a decrement rather than being released and
 * re-taken, so there is no window in which another till can grab it.
 */
function convertToSale({ hold, saleId }) {
  const depK = toKobo(hold.deposit || 0);
  const balK = Math.max(0, toKobo(hold.balance || 0));
  return {
    ok: true,
    hold_id: hold.id,
    sale_id: saleId,
    quantity: Number(hold.quantity) || 0,
    // The deposit becomes a tender on the sale, so the customer is never
    // asked to pay twice and the till reconciles against the safe movement
    // that recorded the original deposit.
    credit_deposit_kobo: depK,
    credit_deposit: fromKobo(depK),
    balance_due_kobo: balK,
    balance_due: fromKobo(balK),
    release_reservation: true,   // the reservation is superseded by the sale
    newStatus: 'CONVERTED',
  };
}

/** Holds that have passed their expiry and should be released. */
function findExpired(holds, todayIso = new Date().toISOString().slice(0, 10)) {
  const today = String(todayIso).slice(0, 10);
  return (holds || []).filter((h) => h.status === 'ACTIVE' && h.expires_on && String(h.expires_on).slice(0, 10) < today);
}

module.exports = {
  HOLD_STATUSES, HOLD_REASONS, HOLD_REASON_CODES,
  DEFAULT_HOLD_DAYS, MAX_HOLD_DAYS,
  createHold, extendHold, releaseHold, convertToSale, findExpired, addDays,
};
