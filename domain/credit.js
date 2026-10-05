'use strict';
// =====================================================================
// domain/credit.js — CUSTOMER CREDIT, AGEING AND LIMIT DECISIONS
// =====================================================================
// THE GOVERNING PRINCIPLE: ADVISORY, NOT BLOCKING.
//
// A Nigerian shop floor runs on relationships. A trader who has bought from
// the same shop for eleven years will be extended credit past a numeric
// limit, and the shop is usually right to do it. A system that HARD-BLOCKS
// the sale gets switched off within a week, and then it is not controlling
// anything at all — including the cases where it would have helped.
//
// So the limit produces a DECISION OBJECT with three possible shapes:
//   { decision: 'ALLOW' }              — inside the limit, no comment
//   { decision: 'WARN',  ... }         — over the limit, sale may proceed if
//                                        an authorised person records why
//   { decision: 'REQUIRE_OVERRIDE' }   — over the limit AND this user cannot
//                                        override it (a cashier with
//                                        staff_can_sell_on_credit off)
//
// When a WARN proceeds, the override is RECORDED (who, when, why) on the
// sale. That converts an invisible judgement call into an auditable one,
// which is the actual value the feature provides.
// =====================================================================

const { round2 } = require('./money');
const { daysBetween } = require('./time');

const AGEING_BUCKETS = Object.freeze([
  { key: 'bucket_0_30', label: 'Current (0-30 days)', minDays: 0, maxDays: 30 },
  { key: 'bucket_31_60', label: '31-60 days', minDays: 31, maxDays: 60 },
  { key: 'bucket_61_90', label: '61-90 days', minDays: 61, maxDays: 90 },
  { key: 'bucket_90_plus', label: 'Over 90 days', minDays: 91, maxDays: null },
]);

/** Bucket a balance by age, given the ledger entries that make it up. */
function ageBalance(entries, { today = null } = {}) {
  const reference = today || new Date().toISOString().slice(0, 10);
  const out = { total: 0 };
  for (const b of AGEING_BUCKETS) out[b.key] = 0;

  // FIFO allocation of payments against the OLDEST charges first. This is
  // the convention a Nigerian bookkeeper expects and the one that makes an
  // ageing report actionable: without it a customer who pays regularly but
  // always slightly late shows as "current" forever while their oldest
  // unpaid invoice quietly ages past 90 days.
  //
  // Sorted by AGE DESCENDING — oldest first, since `days` is days-elapsed.
  // (This comparator was written the wrong way round once and the effect was
  // exactly the misreading described above: a ₦150,000 payment cleared the
  // NEWEST invoice, the 90+ bucket stayed full at ₦300,000, and the report
  // told the owner a debt was uncollected when the customer had in fact paid.
  // The unit test asserts the allocation, not just the total, so it catches
  // the inversion rather than only the arithmetic.)
  //
  // Tie-broken by creation timestamp so two charges raised on the same day
  // are still allocated deterministically — a non-deterministic allocation
  // produces an ageing report that changes when re-run, which nobody can
  // reconcile against.
  const charges = (entries || [])
    .filter((e) => Number(e.amount) > 0)
    .map((e) => ({
      ...e,
      remaining: round2(Number(e.amount)),
      days: Math.max(0, daysBetween(String(e.entry_date || e.created_at).slice(0, 10), reference) || 0),
    }))
    .sort((a, b) => (b.days - a.days) || String(a.created_at || '').localeCompare(String(b.created_at || '')));

  let payments = round2((entries || []).filter((e) => Number(e.amount) < 0).reduce((a, e) => a + Math.abs(Number(e.amount)), 0));

  for (const charge of charges) {
    let outstanding = charge.remaining;
    if (payments > 0) {
      const applied = Math.min(payments, outstanding);
      payments = round2(payments - applied);
      outstanding = round2(outstanding - applied);
    }
    if (outstanding <= 0) continue;
    const bucket = AGEING_BUCKETS.find((b) => charge.days >= b.minDays && (b.maxDays === null || charge.days <= b.maxDays));
    if (bucket) out[bucket.key] = round2(out[bucket.key] + outstanding);
    out.total = round2(out.total + outstanding);
  }
  // Any unallocated payment is a credit balance (the customer overpaid or
  // pre-paid). Show it rather than dropping it.
  out.creditBalance = round2(Math.max(0, payments));
  out.total = round2(out.total - out.creditBalance);
  return out;
}

/**
 * The limit decision described in the header.
 *
 * `requestedAmount` is the additional credit this transaction would add.
 * A customer at ₦480,000 of a ₦500,000 limit asking for ₦50,000 is over;
 * the same customer paying cash is not, and that is why the amount is a
 * parameter rather than read off the sale.
 */
function creditDecision({
  customer, currentBalance = 0, requestedAmount = 0,
  canOverride = false, overrideReason = null, settings = {},
}) {
  const limit = Number((customer && customer.credit_limit) || 0);
  const balance = round2(Number(currentBalance) || 0);
  const requested = round2(Number(requestedAmount) || 0);
  const projected = round2(balance + requested);

  // No limit set at all: this is a cash customer and credit is simply not
  // available to them. Distinct from "limit reached" because the remedy is
  // different — one is a settings change, the other is a payment.
  if (limit <= 0) {
    if (requested <= 0) return { decision: 'ALLOW', projected, limit, balance };
    return {
      decision: canOverride ? 'WARN' : 'REQUIRE_OVERRIDE',
      code: 'NO_CREDIT_LIMIT',
      projected, limit, balance,
      message: `${(customer && customer.name) || 'This customer'} has no credit limit set, so they are a cash customer. ${canOverride ? 'You can record this sale on credit anyway — the reason will be saved.' : 'A manager must set a credit limit or approve this sale.'}`,
      overrideReason: overrideReason || null,
    };
  }

  if (projected <= limit) {
    return {
      decision: 'ALLOW', projected, limit, balance,
      availableAfter: round2(limit - projected),
      utilisationPct: round2((projected / limit) * 100),
    };
  }

  const overBy = round2(projected - limit);
  const base = {
    code: 'CREDIT_LIMIT_EXCEEDED',
    projected, limit, balance, overBy,
    utilisationPct: round2((projected / limit) * 100),
    message: `This would take ${(customer && customer.name) || 'the customer'} to ₦${projected.toLocaleString('en-NG')} against a ₦${limit.toLocaleString('en-NG')} limit — over by ₦${overBy.toLocaleString('en-NG')}.`,
  };
  if (canOverride) {
    return {
      ...base, decision: 'WARN',
      overrideRequired: true,
      overrideReason: overrideReason || null,
      message: `${base.message} You can proceed, and the reason will be recorded against the sale so the owner can review it.`,
    };
  }
  return { ...base, decision: 'REQUIRE_OVERRIDE', overrideRequired: true };
}

/**
 * Terms and due date for a credit sale.
 *
 * `maxDays` from client_settings caps what anyone can offer, so a manager
 * cannot quietly write 180-day terms on a 30-day account. The cap is
 * enforced here rather than in each route for the same reason pricing is:
 * seven callers, one rule.
 */
function creditTerms({ customer, customerClass = null, settings = {}, requestedDays = null }) {
  const classDays = Number((customerClass && customerClass.payment_terms_days) || 0);
  const customerDays = Number((customer && customer.payment_terms_days) || 0);
  const requested = requestedDays == null ? null : Number(requestedDays);
  const cap = Number(settings.credit_max_days);
  let days = Math.max(classDays, customerDays);
  if (requested != null && Number.isFinite(requested)) days = requested;
  let capped = false;
  if (Number.isFinite(cap) && cap >= 0 && days > cap) { days = cap; capped = true; }
  days = Math.max(0, Math.round(days));
  return {
    days,
    capped,
    capApplied: Number.isFinite(cap) ? cap : null,
    dueDate: addDaysIso(new Date().toISOString().slice(0, 10), days),
    message: capped
      ? `Terms capped at ${days} day${days === 1 ? '' : 's'} by this account's credit policy (maximum ${cap}).`
      : null,
  };
}

function addDaysIso(dateString, days) {
  const d = new Date(`${String(dateString).slice(0, 10)}T00:00:00Z`);
  return new Date(d.getTime() + Number(days || 0) * 86400000).toISOString().slice(0, 10);
}

/** Days overdue against a due date; 0 or negative means not yet due. */
function daysOverdue(dueDate, { today = null } = {}) {
  if (!dueDate) return 0;
  const reference = today || new Date().toISOString().slice(0, 10);
  return Math.max(0, daysBetween(String(dueDate).slice(0, 10), reference) || 0);
}

/**
 * Should this customer be blocked from NEW credit?
 *
 * Separate from the limit decision: a customer inside their limit but 120
 * days overdue on an old invoice is a different risk from one at the limit
 * who pays on time. This is a WARNING surfaced at the counter, never an
 * automatic block, for the same reason as everything else in this file.
 */
function overdueWarning({ entries, settings = {}, today = null }) {
  const reference = today || new Date().toISOString().slice(0, 10);
  const graceDays = Number(settings.credit_grace_days) || 0;
  const worst = (entries || [])
    .filter((e) => Number(e.amount) > 0)
    .map((e) => ({ ...e, overdue: daysOverdue(e.due_date || e.created_at, { today: reference }) }))
    .filter((e) => e.overdue > graceDays)
    .sort((a, b) => b.overdue - a.overdue)[0];
  if (!worst) return null;
  return {
    code: 'OVERDUE_DEBT',
    severity: worst.overdue > 90 ? 'CRITICAL' : 'WARNING',
    daysOverdue: worst.overdue,
    message: `This customer has an invoice ${worst.overdue} day${worst.overdue === 1 ? '' : 's'} overdue (₦${round2(Math.abs(Number(worst.amount))).toLocaleString('en-NG')}). Consider collecting before extending more credit.`,
  };
}

/** Ledger entry shape used by both backends, so balances are computed identically. */
function ledgerEntry({ branchId, businessId, customerId, entryType, referenceId = null, amount, balanceAfter, notes = null, createdBy = null }) {
  return {
    branch_id: branchId, business_id: businessId, customer_id: customerId,
    entry_type: entryType, reference_id: referenceId,
    amount: round2(Number(amount)), balance_after: round2(Number(balanceAfter)),
    notes, created_by: createdBy,
  };
}

module.exports = {
  AGEING_BUCKETS,
  ageBalance, creditDecision, creditTerms, daysOverdue, overdueWarning, ledgerEntry,
};
