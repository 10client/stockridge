'use strict';
// =====================================================================
// domain/settlement.js — PAID ON THE SPOT, OR SUPPLIED ON CREDIT
// =====================================================================
// A Nigerian counter and a Nigerian route do not use one kind of paper.
// A walk-in who pays before the loaf or the bag leaves gets a receipt.
// A depot that takes the goods and pays after selling them gets an
// invoice. The invoice is not a receipt. Mixing the two is how a shop
// later argues about money that was never taken.
//
// The choice is made when the sale starts, by the cashier or — where the
// vertical runs a route — by dispatch. It is stored. The paper at the
// end reads that stored choice. It is not guessed from whatever the
// balance happens to be on the day somebody reprints it.
//
// This is not a FEATURE_FLAGS switch. General retail turns every flag
// on, and a phone shop must not be forced onto a route invoice.

function classesAllowCredit(profile) {
  const classes = profile && profile.customerClasses;
  return Array.isArray(classes) && classes.some((row) => row && row.creditAllowed);
}

/**
 * What this business may record. Spot is paid before or as the goods
 * leave. Credit is goods now, payment later. A route vertical lets
 * dispatch make the same choice the cashier makes. At least one stays
 * on: a business that sells nothing cannot be configured.
 */
function sellingPolicy(profile) {
  const explicit = profile && profile.selling && typeof profile.selling === 'object' ? profile.selling : null;
  const spot = explicit && Object.prototype.hasOwnProperty.call(explicit, 'spot')
    ? Boolean(explicit.spot)
    : true;
  const credit = explicit && Object.prototype.hasOwnProperty.call(explicit, 'credit')
    ? Boolean(explicit.credit)
    : classesAllowCredit(profile);
  const spotOn = spot || !credit;
  const creditOn = Boolean(credit);
  const both = spotOn && creditOn;
  const dispatch = Boolean(profile && profile.dispatch) && both;
  return {
    spot: spotOn,
    credit: creditOn,
    both,
    cashier: true,
    dispatch,
  };
}

function policyForBusiness(business) {
  if (!business) return sellingPolicy(null);
  let overrides = null;
  if (business.profile_overrides_json) {
    try { overrides = JSON.parse(business.profile_overrides_json); } catch (e) { overrides = null; }
  } else if (business.profile_overrides && typeof business.profile_overrides === 'object') {
    overrides = business.profile_overrides;
  }
  const { resolveProfile } = require('./verticals');
  return sellingPolicy(resolveProfile(business.profile_code, overrides));
}

function normaliseTerm(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'SPOT' || raw === 'UPFRONT' || raw === 'CASH' || raw === 'PAID') return 'SPOT';
  if (raw === 'CREDIT' || raw === 'INVOICE' || raw === 'ACCOUNT') return 'CREDIT';
  return null;
}

function creditLegPresent(payments) {
  return Array.isArray(payments) && payments.some((leg) => String(leg && leg.method || '').toUpperCase() === 'CREDIT');
}

/**
 * The term recorded on the sale. An explicit choice wins. A credit
 * payment leg is a choice. A credit sale type is a choice. Anything
 * else is paid on the spot, unless this business only sells on credit.
 */
function resolveSaleTerm({ business, requested, saleType, payments } = {}) {
  const policy = policyForBusiness(business);
  const type = String(saleType || 'RETAIL').toUpperCase();
  const explicit = normaliseTerm(requested);
  if (explicit === 'SPOT' && creditLegPresent(payments)) {
    return {
      ok: false,
      code: 'SPOT_WITH_CREDIT_LEG',
      error: 'A sale paid on the spot cannot also carry a credit balance. Take the money, or record it as credit so the paper is an invoice.',
    };
  }
  const asked = explicit
    || (creditLegPresent(payments) ? 'CREDIT' : null)
    || (['CREDIT', 'INSTALMENT', 'LAYAWAY'].includes(type) ? 'CREDIT' : null);
  let term = asked || (policy.spot ? 'SPOT' : 'CREDIT');
  if (type === 'INSTALMENT' || type === 'LAYAWAY') term = 'CREDIT';
  if (type === 'EXCHANGE' || type === 'INTERNAL') term = 'SPOT';
  if (term === 'CREDIT' && !policy.credit) {
    return {
      ok: false,
      code: 'CREDIT_NOT_OFFERED',
      error: 'This business sells on the spot. Credit is turned off. Take payment before the goods leave, or turn credit on for this business.',
    };
  }
  if (term === 'SPOT' && !policy.spot) {
    return {
      ok: false,
      code: 'SPOT_NOT_OFFERED',
      error: 'This business sells on credit. An upfront sale is turned off. Record the customer and the balance, or turn spot sales on for this business.',
    };
  }
  let storedType = type;
  if (term === 'CREDIT' && type === 'RETAIL') storedType = 'CREDIT';
  if (term === 'SPOT' && type === 'CREDIT') storedType = 'RETAIL';
  return { ok: true, term, saleType: storedType, policy };
}

/**
 * The paper handed over with the goods. A balance is an invoice, even
 * when some money was taken. Money taken in full is a receipt. A later
 * payment on an old invoice is its own receipt — pass forPayment.
 */
function paperOf({ settlement = null, saleType = null, balanceDue = 0, amountPaid = 0, forPayment = false } = {}) {
  if (forPayment) {
    return {
      kind: 'RECEIPT',
      title: 'Receipt',
      settlement: 'SPOT',
      line: 'Payment received. This receipt is for the money taken. It is not a new supply.',
    };
  }
  const term = normaliseTerm(settlement)
    || (['CREDIT', 'INSTALMENT', 'LAYAWAY'].includes(String(saleType || '').toUpperCase()) ? 'CREDIT' : 'SPOT');
  const due = Number(balanceDue) || 0;
  const paid = Number(amountPaid) || 0;
  if (term === 'CREDIT') {
    return {
      kind: 'INVOICE',
      title: 'Invoice',
      settlement: 'CREDIT',
      line: due > 0.009
        ? (paid > 0.009
          ? 'Part paid. This is not a receipt for the goods. The balance is still owed.'
          : 'Supplied on credit. This is not a receipt. Payment is still owed.')
        : 'This supply was on credit. This paper stays the invoice. A later payment has its own receipt.',
    };
  }
  return {
    kind: 'RECEIPT',
    title: 'Receipt',
    settlement: 'SPOT',
    line: 'Paid on the spot. This receipt is proof of payment.',
  };
}

module.exports = {
  sellingPolicy, policyForBusiness, normaliseTerm, resolveSaleTerm, paperOf,
};
