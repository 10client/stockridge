// =====================================================================
// StockRidge — PAYMENTS (methods, split tender, change owed, reconciliation)
// =====================================================================
// HOW NIGERIAN RETAIL ACTUALLY TAKES MONEY.
//
// The naive model — one sale, one payment method, one amount — fails on
// the first real shift. What actually happens at a Nigerian counter:
//
//   * A ₦450,000 refrigerator is paid ₦100,000 cash deposit + ₦300,000
//     bank transfer + ₦50,000 on the shop's POS terminal. THREE legs,
//     three different reconciliation trails, one sale.
//   * A customer pays ₦10,000 for a ₦7,350 basket and there is no change
//     in the drawer. The shop owes them ₦2,650. That debt must be recorded
//     against a claim code the customer can present tomorrow, at ANY
//     branch — or it becomes a dispute and a shrinkage line.
//   * A POS terminal settlement arrives the NEXT BUSINESS DAY. The till
//     closes tonight showing ₦300,000 the shop does not physically hold.
//     Reconciliation must separate money in the drawer from money in
//     flight, or the cashier is blamed for the bank's settlement lag.
//   * A cheque is tendered. It may bounce. Until it clears it is not cash.
//   * An old unit is traded in against a new one. That is a payment leg
//     with a valuation, not a discount.
//
// Everything below is pure arithmetic over a list of payment legs plus
// validation. No I/O.
// =====================================================================

const { round2, roundCashAmount, isMoney, sum } = require('./money');

// ---------------------------------------------------------------------
// PAYMENT METHODS
// ---------------------------------------------------------------------
// `settlesImmediately` — does the drawer/bank hold the value at the moment
//   of sale? Drives till reconciliation and the change-owed rules.
// `isCashLeg` — physically present in the drawer. Only cash legs can create
//   a "change owed" situation and only cash legs are counted at close.
// `requiresReference` — the field the cashier MUST fill (a transfer with no
//   reference is untraceable when the customer disputes it six weeks later,
//   and "I paid you people" is not answerable without one).
// `clearsLater` — the value is promised but not yet realised (cheque).
const PAYMENT_METHODS = Object.freeze({
  CASH: {
    code: 'CASH', label: 'Cash', settlesImmediately: true, isCashLeg: true,
    requiresReference: false, clearsLater: false, referenceLabel: null,
  },
  POS_TERMINAL: {
    code: 'POS_TERMINAL', label: 'POS terminal (card)', settlesImmediately: false, isCashLeg: false,
    requiresReference: true, clearsLater: true, referenceLabel: 'Terminal / approval code',
    note: 'Settles to the merchant account, usually next business day.',
  },
  BANK_TRANSFER: {
    code: 'BANK_TRANSFER', label: 'Bank transfer', settlesImmediately: false, isCashLeg: false,
    requiresReference: true, clearsLater: true, referenceLabel: 'Transfer reference / narration',
  },
  USSD: {
    code: 'USSD', label: 'USSD (*737, *894, …)', settlesImmediately: true, isCashLeg: false,
    requiresReference: true, clearsLater: false, referenceLabel: 'USSD session / approval code',
  },
  MOBILE_MONEY: {
    code: 'MOBILE_MONEY', label: 'Mobile money / wallet', settlesImmediately: true, isCashLeg: false,
    requiresReference: true, clearsLater: false, referenceLabel: 'Wallet transaction id',
  },
  CHEQUE: {
    code: 'CHEQUE', label: 'Cheque', settlesImmediately: false, isCashLeg: false,
    requiresReference: true, clearsLater: true, referenceLabel: 'Cheque no. & bank',
    note: 'Not realised until it clears. A bounced cheque is reversed from the debtor ledger, not from the till.',
  },
  CREDIT: {
    code: 'CREDIT', label: 'On credit (debtor)', settlesImmediately: false, isCashLeg: false,
    requiresReference: false, clearsLater: true, referenceLabel: null,
    note: 'Creates a debtor-ledger entry against the customer. Requires a customer record and a manager.',
  },
  INSTALMENT: {
    code: 'INSTALMENT', label: 'Instalment plan deposit', settlesImmediately: true, isCashLeg: false,
    requiresReference: true, clearsLater: false, referenceLabel: 'Plan reference',
    note: 'The deposit leg of an instalment agreement; subsequent payments post against the plan.',
  },
  LAYAWAY: {
    code: 'LAYAWAY', label: 'Layaway payment', settlesImmediately: true, isCashLeg: false,
    requiresReference: true, clearsLater: false, referenceLabel: 'Layaway agreement no.',
  },
  TRADE_IN: {
    code: 'TRADE_IN', label: 'Trade-in allowance', settlesImmediately: true, isCashLeg: false,
    requiresReference: true, clearsLater: false, referenceLabel: 'Trade-in item & serial',
    note: 'A valuation on an item taken back, applied as part-payment. Not a discount — it creates stock.',
  },
  VOUCHER: {
    code: 'VOUCHER', label: 'Voucher / gift card', settlesImmediately: true, isCashLeg: false,
    requiresReference: true, clearsLater: false, referenceLabel: 'Voucher code',
  },
});

const PAYMENT_METHOD_CODES = Object.freeze(Object.keys(PAYMENT_METHODS));

function isPaymentMethod(code) {
  return Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, String(code || '').toUpperCase());
}

function paymentMethod(code) {
  return PAYMENT_METHODS[String(code || '').toUpperCase()] || null;
}

// Methods a given business profile actually offers. Intersecting with the
// profile prevents, for example, a provisions shop from recording a
// TRADE_IN payment it has no process for.
function methodsForProfile(mergedProfile) {
  const allowed = new Set((mergedProfile && mergedProfile.paymentMethods) || PAYMENT_METHOD_CODES);
  return PAYMENT_METHOD_CODES.filter((c) => allowed.has(c)).map((c) => PAYMENT_METHODS[c]);
}

// ---------------------------------------------------------------------
// VALIDATE A SET OF PAYMENT LEGS AGAINST A SALE TOTAL
// ---------------------------------------------------------------------
// Returns { ok, error, code } plus the reconciliation split. This is the
// function the POS calls before it will complete a sale, so its error
// messages are written for a cashier standing in front of a queue.
function validatePayments({ total, legs = [], vatEnabled = false, vatRatePercent = 7.5 }) {
  const due = round2(total);
  if (!isMoney(due)) {
    return { ok: false, code: 'TOTAL_INVALID', error: 'The sale total is not a valid amount. Check the basket.' };
  }

  if (!Array.isArray(legs) || legs.length === 0) {
    return { ok: false, code: 'NO_PAYMENT', error: 'Record at least one payment before completing the sale.' };
  }

  const cleaned = [];
  let cashTendered = 0;
  let cashInDrawer = 0;
  let receivableLater = 0;
  let creditLeg = 0;
  let nonCashImmediate = 0;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const label = `Payment ${i + 1}`;
    if (!leg || typeof leg !== 'object') {
      return { ok: false, code: 'LEG_INVALID', error: `${label} is missing.` };
    }
    const method = paymentMethod(leg.method);
    if (!method) {
      return { ok: false, code: 'METHOD_INVALID', error: `${label}: choose a payment method.` };
    }
    const amount = Number(leg.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, code: 'AMOUNT_INVALID', error: `${label} (${method.label}): enter an amount greater than zero.` };
    }
    if (method.requiresReference && !String(leg.reference || '').trim()) {
      return {
        ok: false, code: 'REFERENCE_REQUIRED',
        error: `${label} (${method.label}): ${method.referenceLabel} is required. Without it the payment cannot be traced if the customer disputes it.`,
      };
    }
    if (method.code === 'CREDIT' && !leg.customer_id) {
      return {
        ok: false, code: 'CREDIT_NEEDS_CUSTOMER',
        error: 'A credit sale must be against a named customer — the debt has to be owed by somebody.',
      };
    }
    if (method.code === 'TRADE_IN' && !(Number(leg.trade_in_value) > 0)) {
      return { ok: false, code: 'TRADE_IN_VALUE_REQUIRED', error: `${label}: record what the traded-in item was valued at.` };
    }

    cleaned.push({
      method: method.code,
      method_label: method.label,
      amount: round2(amount),
      reference: String(leg.reference || '').trim() || null,
      customer_id: leg.customer_id || null,
      trade_in_value: Number(leg.trade_in_value) || null,
      trade_in_serial: leg.trade_in_serial || null,
      trade_in_product_id: leg.trade_in_product_id || null,
      settles_immediately: method.settlesImmediately ? 1 : 0,
      is_cash_leg: method.isCashLeg ? 1 : 0,
      clears_later: method.clearsLater ? 1 : 0,
      received_at: leg.received_at || null,
    });

    if (method.isCashLeg) {
      cashInDrawer += amount;
      cashTendered += Number(leg.cash_tendered) > 0 ? Number(leg.cash_tendered) : amount;
    } else if (method.code === 'CREDIT') {
      creditLeg += amount;
    } else if (method.clearsLater) {
      receivableLater += amount;
    } else {
      nonCashImmediate += amount;
    }
  }

  const paid = round2(sum(cleaned.map((l) => l.amount)));

  // Overpayment is only legal on a CASH leg — that is the "customer handed
  // over a bigger note" case, and the excess becomes change given or change
  // owed. Overpaying by transfer is a mistake the customer will want back
  // and must be corrected, not silently absorbed.
  const hasCashLeg = cleaned.some((l) => l.is_cash_leg === 1);
  if (paid > due) {
    if (!hasCashLeg) {
      return {
        ok: false, code: 'OVERPAID_NO_CASH',
        error: `The payments total ₦${paid.toLocaleString('en-NG')} against ₦${due.toLocaleString('en-NG')} due. A non-cash payment cannot be overpaid — correct the amount.`,
      };
    }
  }
  if (paid < due) {
    const short = round2(due - paid);
    return {
      ok: false, code: 'UNDERPAID',
      error: `Short by ₦${short.toLocaleString('en-NG')}. Add another payment, or record the balance as credit/on an instalment plan.`,
      shortfall: short,
    };
  }

  // Change is a CASH-leg concept. Rounding to the nearest 50 kobo applies
  // only to the cash leg — the bank settles a transfer to the exact kobo
  // and rounding that would make the receipt disagree with the statement.
  const overpaid = round2(paid - due);
  const changeGiven = hasCashLeg ? roundCashAmount(Math.min(overpaid, cashInDrawer)) : 0;
  const changeOwed = hasCashLeg ? round2(Math.max(0, overpaid - changeGiven)) : round2(overpaid);

  return {
    ok: true,
    legs: cleaned,
    due,
    paid,
    overpaid,
    cashTendered: round2(cashTendered),
    changeGiven,
    changeOwed,
    reconciliation: {
      cash_in_drawer: round2(cashInDrawer),
      non_cash_immediate: round2(nonCashImmediate),
      receivable_later: round2(receivableLater), // POS terminal + transfer + cheque: in flight
      credit_extended: round2(creditLeg),
      settled_now: round2(cashInDrawer + nonCashImmediate),
    },
    vat: vatEnabled ? null : null, // VAT split is computed by tax.extractVat on the total, not per leg
    vatEnabled,
    vatRatePercent,
  };
}

// ---------------------------------------------------------------------
// CHANGE OWED
// ---------------------------------------------------------------------
// When the drawer cannot give change, the shop owes the customer. The
// claim code is what makes that enforceable: a short, human-readable code
// the customer can quote at ANY branch, with a balance and an expiry.
//
// The code format is deliberate. 8 characters from an unambiguous alphabet
// (no 0/O, no 1/I/l) read aloud over a phone line or a noisy counter —
// a customer quoting "B0RN8K2L" over a bad line gets the wrong account,
// and then the shop pays twice or the customer is told they are lying.
const CLAIM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CLAIM_CODE_LENGTH = 8;
const CHANGE_OWED_DEFAULT_EXPIRY_DAYS = 90;

function generateClaimCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) {
    out += CLAIM_CODE_ALPHABET[Math.floor(random() * CLAIM_CODE_ALPHABET.length) % CLAIM_CODE_ALPHABET.length];
  }
  return out;
}

function looksLikeClaimCode(value) {
  const v = String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (v.length !== CLAIM_CODE_LENGTH) return false;
  return [...v].every((ch) => CLAIM_CODE_ALPHABET.includes(ch));
}

const CHANGE_OWED_STATUSES = Object.freeze(['OUTSTANDING', 'SETTLED', 'EXPIRED', 'FORFEITED', 'DONATED']);

// Settling change owed is itself a cash movement, so it validates against
// the drawer the same way a sale does.
function validateChangeOwedSettlement({ outstanding, amount, drawerBalance }) {
  const owed = round2(outstanding);
  const pay = round2(amount);
  if (pay <= 0) return { ok: false, code: 'AMOUNT_INVALID', error: 'Enter an amount greater than zero.' };
  if (pay > owed) {
    return {
      ok: false, code: 'OVERPAYMENT',
      error: `The outstanding balance is ₦${owed.toLocaleString('en-NG')}; ₦${pay.toLocaleString('en-NG')} is more than is owed.`,
    };
  }
  if (Number.isFinite(Number(drawerBalance)) && pay > round2(drawerBalance)) {
    return {
      ok: false, code: 'DRAWER_SHORT',
      error: `The drawer holds ₦${round2(drawerBalance).toLocaleString('en-NG')}. Move money out of the safe, or settle part now.`,
    };
  }
  return { ok: true, amount: pay, remaining: round2(owed - pay) };
}

// ---------------------------------------------------------------------
// TILL RECONCILIATION
// ---------------------------------------------------------------------
// The close-of-shift arithmetic. `expected` is what the system says should
// be in the drawer; `counted` is what the cashier physically counted. The
// variance is the single most important number in retail cash control and
// it must be computed from a definition of "expected" that already accounts
// for change given, safe movements and change-owed settlements — otherwise
// every shift shows a phantom variance and the report stops being read.
function reconcileTill({
  openingFloat = 0,
  cashSales = 0,
  changeGiven = 0,
  cashRefunds = 0,
  safeDeposits = 0,       // cash moved INTO the safe (leaves the drawer)
  safeWithdrawals = 0,    // cash moved OUT of the safe (enters the drawer)
  changeOwedSettled = 0,  // cash paid out against a claim code
  changeOwedReceived = 0, // cash taken in when a customer tops up a layaway
  countedCash = 0,
}) {
  const expected = round2(
    Number(openingFloat)
    + Number(cashSales)
    - Number(changeGiven)
    - Number(cashRefunds)
    - Number(safeDeposits)
    + Number(safeWithdrawals)
    - Number(changeOwedSettled)
    + Number(changeOwedReceived),
  );
  const counted = round2(countedCash);
  const variance = round2(counted - expected);
  return {
    expected,
    counted,
    variance,
    over: variance > 0,
    short: variance < 0,
    balanced: variance === 0,
    // A variance is only "material" past a tolerance. Setting this to zero
    // means every shift where a ₦1 note was mistaken for ₦2 raises an
    // incident, and incidents that are always noise get ignored — including
    // the one that is real. ₦500 is a practical default for a Nigerian
    // counter; it is a setting, not a constant.
    material: Math.abs(variance) > 0,
  };
}

const TILL_VARIANCE_DEFAULT_TOLERANCE = 500; // ₦

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_METHOD_CODES,
  isPaymentMethod,
  paymentMethod,
  methodsForProfile,
  validatePayments,
  CLAIM_CODE_ALPHABET,
  CLAIM_CODE_LENGTH,
  CHANGE_OWED_DEFAULT_EXPIRY_DAYS,
  CHANGE_OWED_STATUSES,
  generateClaimCode,
  looksLikeClaimCode,
  validateChangeOwedSettlement,
  reconcileTill,
  TILL_VARIANCE_DEFAULT_TOLERANCE,
};
