// =====================================================================
// shared/lib/instalments.js — "PAY SMALL-SMALL" PLANS
// =====================================================================
//
// NEW TO STOCKRIDGE (no PharmaRidge equivalent). Instalment selling is not a
// niche feature in Nigerian retail — for anything above roughly ₦150,000 it is
// often the ONLY way the sale happens. A furniture shop that cannot offer
// "pay ₦100,000 now, ₦50,000 every month for six months" loses the customer to
// the shop down the road that can.
//
// THE THREE THINGS THAT MAKE THIS HARD, AND HOW EACH IS HANDLED:
//
// 1. THE SCHEDULE MUST FOOT EXACTLY.
//    ₦500,000 over 7 instalments is not ₦71,428.57 x 7 — that is
//    ₦499,999.99. Money.allocateKobo() splits it as 6 x ₦71,428.57 plus one
//    ₦71,428.58, and the plan total equals the financed amount to the kobo.
//    A schedule that is one kobo out can never be marked PAID_OFF.
//
// 2. OWNERSHIP AND STOCK ARE SEPARATE QUESTIONS.
//    Two models, both used in Nigeria, and the client picks per plan:
//      LAYAWAY_BACKED  the goods stay in the shop until the final instalment.
//                      Stock is RESERVED (not decremented) so nobody else can
//                      sell it, and it is decremented on completion. Lowest
//                      risk, and what most furniture shops actually do.
//      DELIVERED_ON_DEPOSIT  the goods leave with the customer after the
//                      deposit. Stock is decremented immediately and the
//                      outstanding balance is an unsecured RECEIVABLE. Higher
//                      risk, normal for appliances where the customer needs
//                      the item now.
//    Getting this wrong is the difference between a stock report that is right
//    and one that is out by every unpaid plan in the shop.
//
// 3. DEFAULT IS A BUSINESS EVENT, NOT A ROUNDED NUMBER.
//    Missed instalments accrue late fees IF the client has enabled them
//    (many deliberately do not, because the relationship matters more than the
//    fee). After a configurable number of missed instalments the plan goes to
//    DEFAULT and the choices become explicit: repossess (LAYAWAY_BACKED),
//    convert to a plain debt, write off, or restructure.
//
// REGULATORY NOTE: this is trade credit, not lending. A business selling its
// OWN goods on instalments is not doing money-lending business and does not
// need an FCCPC money-lender licence for that activity. The moment the client
// starts financing goods it does not sell, or charging interest as a product,
// the analysis changes. This module charges a flat `plan_fee` and an optional
// late fee — never compound interest — and the README says so, because a
// feature that quietly turns a furniture shop into an unlicensed lender is a
// feature that gets the client in trouble.

'use strict';

const { round2, toKobo, fromKobo, allocateKobo } = require('./money');

const PLAN_MODELS = Object.freeze(['LAYAWAY_BACKED', 'DELIVERED_ON_DEPOSIT']);
const PLAN_STATUSES = Object.freeze(['DRAFT', 'ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED', 'RESTRUCTURED']);
const FREQUENCIES = Object.freeze(['WEEKLY', 'FORTNIGHTLY', 'MONTHLY']);
const ENTRY_STATUSES = Object.freeze(['SCHEDULED', 'PAID', 'MISSED', 'LATE_PAID', 'WAIVED', 'RESTRUCTURED']);

const DEFAULTS = Object.freeze({
  minDepositPercent: 20,
  maxTenorMonths: 24,
  lateFeePercent: 0,          // 0 = no late fees (a deliberate client choice)
  graceDays: 7,
  missedBeforeDefault: 3,
  planFeePercent: 0,          // a flat admin fee, NOT interest
});

function daysForFrequency(freq) {
  switch (String(freq || 'MONTHLY').toUpperCase()) {
    case 'WEEKLY': return 7;
    case 'FORTNIGHTLY': return 14;
    case 'MONTHLY': return 30;
    default: return 30;
  }
}

/**
 * Add N frequency periods to a date, landing on a real calendar day.
 *
 * Monthly arithmetic is done by MONTH, not by +30 days, because a plan that
 * starts on 31 January must fall due on 28 February — not on 2 March. Using
 * +30 days drifts a monthly plan by five days a year, and after three years
 * the "monthly" instalment is due every 26 days.
 */
function addPeriods(dateIso, periods, frequency) {
  const d = new Date(Date.parse(`${String(dateIso).slice(0, 10)}T00:00:00Z`));
  if (Number.isNaN(d.getTime())) return null;
  const f = String(frequency || 'MONTHLY').toUpperCase();
  const n = Math.max(0, Math.floor(Number(periods) || 0));

  if (f === 'MONTHLY') {
    const dayOfMonth = d.getUTCDate();
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    // Clamp to the last day of the target month (31 Jan + 1 month -> 28 Feb).
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(dayOfMonth, lastDay));
    return target.toISOString().slice(0, 10);
  }
  d.setUTCDate(d.getUTCDate() + n * daysForFrequency(f));
  return d.toISOString().slice(0, 10);
}

/**
 * Build a plan. PURE — returns the schedule; the caller persists it.
 *
 * @param {object} p
 * @param {number} p.totalAmount        the price of the goods
 * @param {number} p.deposit            amount paid up front
 * @param {number} p.instalments        number of instalments AFTER the deposit
 * @param {string} p.frequency          WEEKLY | FORTNIGHTLY | MONTHLY
 * @param {string} p.startDate          ISO date of the deposit / plan start
 * @param {string} p.model              LAYAWAY_BACKED | DELIVERED_ON_DEPOSIT
 * @param {number} [p.planFeePercent]   flat admin fee on the financed amount
 * @param {number} [p.lateFeePercent]   fee on a missed instalment
 * @param {number} [p.graceDays]
 */
function buildPlan(p) {
  const totalK = toKobo(p.totalAmount);
  const depositK = toKobo(p.deposit == null ? 0 : p.deposit);
  const n = Math.max(1, Math.floor(Number(p.instalments) || 1));
  const freq = String(p.frequency || 'MONTHLY').toUpperCase();

  if (!FREQUENCIES.includes(freq)) {
    const err = new Error(`Frequency must be one of: ${FREQUENCIES.join(', ')}`);
    err.status = 400; err.code = 'INVALID_FREQUENCY';
    throw err;
  }
  if (totalK <= 0) {
    const err = new Error('Plan total must be greater than zero');
    err.status = 400; err.code = 'INVALID_PLAN_TOTAL';
    throw err;
  }
  if (depositK < 0 || depositK > totalK) {
    const err = new Error('The deposit cannot be negative or more than the total');
    err.status = 400; err.code = 'INVALID_DEPOSIT';
    throw err;
  }
  const model = String(p.model || 'LAYAWAY_BACKED').toUpperCase();
  if (!PLAN_MODELS.includes(model)) {
    const err = new Error(`Plan model must be one of: ${PLAN_MODELS.join(', ')}`);
    err.status = 400; err.code = 'INVALID_PLAN_MODEL';
    throw err;
  }

  const cfg = { ...DEFAULTS, ...(p.policy || {}) };
  const depositPercent = round2((depositK / totalK) * 100);
  if (depositPercent < cfg.minDepositPercent - 1e-9) {
    const err = new Error(`The deposit must be at least ${cfg.minDepositPercent}% of the price (${fromKobo(Math.round(totalK * cfg.minDepositPercent / 100))}).`);
    err.status = 409; err.code = 'DEPOSIT_BELOW_MINIMUM';
    throw err;
  }

  // A flat admin fee on the amount financed — disclosed, not compounded.
  const feePct = Math.max(0, Number(p.planFeePercent != null ? p.planFeePercent : cfg.planFeePercent) || 0);
  const financedBeforeFeeK = totalK - depositK;
  const feeK = Math.round((financedBeforeFeeK * feePct) / 100);
  const financedK = financedBeforeFeeK + feeK;

  // THE FOOTING GUARANTEE: allocate the financed amount across n instalments
  // by largest remainder so the schedule sums EXACTLY to financedK.
  const parts = allocateKobo(financedK, new Array(n).fill(1));

  const start = String(p.startDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const latePct = Math.max(0, Number(p.lateFeePercent != null ? p.lateFeePercent : cfg.lateFeePercent) || 0);

  const schedule = parts.map((kobo, idx) => ({
    seq: idx + 1,
    due_date: addPeriods(start, idx + 1, freq),
    amount_kobo: kobo,
    amount: fromKobo(kobo),
    // The late fee is COMPUTED here but only CHARGED when an instalment is
    // actually recorded as missed — a schedule that pre-charges fees on
    // instalments the customer might well pay on time is how a shop loses a
    // good customer over nothing.
    late_fee_if_missed_kobo: latePct > 0 ? Math.round((kobo * latePct) / 100) : 0,
    late_fee_if_missed: latePct > 0 ? fromKobo(Math.round((kobo * latePct) / 100)) : 0,
    status: 'SCHEDULED',
  }));

  return {
    model,
    frequency: freq,
    total: fromKobo(totalK), totalKobo: totalK,
    deposit: fromKobo(depositK), depositKobo: depositK,
    depositPercent,
    planFeePercent: feePct,
    planFee: fromKobo(feeK), planFeeKobo: feeK,
    financed: fromKobo(financedK), financedKobo: financedK,
    instalmentCount: n,
    lateFeePercent: latePct,
    graceDays: Math.max(0, Math.floor(Number(p.graceDays != null ? p.graceDays : cfg.graceDays) || 0)),
    missedBeforeDefault: Math.max(1, Math.floor(Number(cfg.missedBeforeDefault) || 3)),
    startDate: start,
    firstDueDate: schedule[0].due_date,
    lastDueDate: schedule[n - 1].due_date,
    schedule,
    // Invariant, asserted rather than assumed:
    balanced: depositK + parts.reduce((a, b) => a + b, 0) === totalK + feeK,
    stockTreatment: model === 'LAYAWAY_BACKED' ? 'RESERVE_UNTIL_COMPLETION' : 'DECREMENT_ON_DEPOSIT',
  };
}

/**
 * Record a payment against a plan and return the new state.
 * PURE: the caller persists.
 *
 * Handles the messy real-world cases:
 *   * paying MORE than the instalment due (over-payment rolls onto the next)
 *   * paying LESS (part payment; the instalment stays open with a balance)
 *   * paying after the grace period (recorded LATE_PAID, fee applied if set)
 *   * paying off the whole plan early (all remaining instalments settled,
 *     unearned late fees never charged)
 */
function applyPayment({ plan, schedule, paymentKobo, payment, paidAtIso }) {
  const paidK = paymentKobo != null ? Math.max(0, toKobo(paymentKobo)) : (payment != null ? Math.max(0, toKobo(payment)) : 0);
  const today = String(paidAtIso || new Date().toISOString()).slice(0, 10);
  const grace = Math.max(0, Number(plan.graceDays) || 0);

  const next = schedule.map((s) => ({ ...s }));
  let remaining = paidK;
  let lateFeesChargedK = 0;
  const entries = [];

  for (const s of next) {
    if (remaining <= 0) break;
    if (s.status === 'PAID' || s.status === 'WAIVED') continue;

    const outstandingK = Math.max(0, (s.amount_kobo || 0) - (s.paid_kobo || 0));
    if (outstandingK <= 0) { s.status = 'PAID'; continue; }

    const apply = Math.min(remaining, outstandingK);
    s.paid_kobo = (s.paid_kobo || 0) + apply;
    remaining -= apply;

    const isLate = s.due_date && today > addCalendarDays(s.due_date, grace);
    if (s.paid_kobo >= s.amount_kobo) {
      s.status = isLate ? 'LATE_PAID' : 'PAID';
      if (isLate && s.late_fee_if_missed_kobo > 0 && !s.late_fee_waived) {
        lateFeesChargedK += s.late_fee_if_missed_kobo;
        s.late_fee_charged_kobo = s.late_fee_if_missed_kobo;
      }
    } else {
      s.status = isLate ? 'MISSED' : 'SCHEDULED';
    }
    entries.push({ seq: s.seq, due_date: s.due_date, applied_kobo: apply, applied: fromKobo(apply), late: isLate });
  }

  const paidTotalK = next.reduce((a, s) => a + (s.paid_kobo || 0), 0) + toKobo(plan.deposit || 0);
  const feesK = next.reduce((a, s) => a + (s.late_fee_charged_kobo || 0), 0);
  const targetK = toKobo(plan.total || 0) + toKobo(plan.planFee || 0);
  const outstandingK = Math.max(0, targetK - paidTotalK - feesK);

  const missed = next.filter((s) => s.status === 'MISSED' && isOverdue(s, today, grace)).length;

  return {
    schedule: next,
    entries,
    unappliedKobo: remaining,
    unapplied: fromKobo(remaining),
    lateFeesCharged: fromKobo(lateFeesChargedK),
    lateFeesChargedKobo: lateFeesChargedK,
    paidTotalKobo: paidTotalK,
    paidTotal: fromKobo(paidTotalK),
    outstandingKobo: outstandingK,
    outstanding: fromKobo(outstandingK),
    missedCount: missed,
    status: outstandingK <= 0 ? 'COMPLETED'
      : missed >= (plan.missedBeforeDefault || 3) ? 'DEFAULTED'
        : 'ACTIVE',
  };
}

function addCalendarDays(dateIso, days) {
  const d = new Date(Date.parse(`${String(dateIso).slice(0, 10)}T00:00:00Z`));
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + (Math.floor(Number(days) || 0)));
  return d.toISOString().slice(0, 10);
}

function isOverdue(instalment, todayIso, graceDays) {
  if (!instalment.due_date) return false;
  const limit = addCalendarDays(instalment.due_date, graceDays);
  return limit != null && todayIso > limit;
}

/**
 * Mark instalments that have gone past due + grace as MISSED. Run nightly by
 * the scheduler; also run on every plan read so a plan is never shown as
 * "up to date" when it is three weeks late.
 */
function refreshOverdue({ plan, schedule, todayIso }) {
  const today = String(todayIso || new Date().toISOString()).slice(0, 10);
  const grace = Math.max(0, Number(plan.graceDays) || 0);
  let changed = false;
  const next = schedule.map((s) => {
    if (s.status !== 'SCHEDULED') return s;
    if (isOverdue(s, today, grace)) { changed = true; return { ...s, status: 'MISSED' }; }
    return s;
  });
  const missed = next.filter((s) => s.status === 'MISSED').length;
  return {
    schedule: next,
    changed,
    missedCount: missed,
    status: missed >= (plan.missedBeforeDefault || 3) ? 'DEFAULTED' : plan.status,
  };
}

/**
 * What the business may do about a defaulted plan, per model.
 * A LAYAWAY_BACKED plan can be repossessed (the goods never left). A
 * DELIVERED_ON_DEPOSIT plan cannot — the options are chase, restructure or
 * write off. Returning the honest option list is what stops a manager clicking
 * "repossess" on goods that left the shop eight months ago.
 */
function defaultOptions(plan) {
  const base = [
    { code: 'RESTRUCTURE', label: 'Restructure into a longer plan', available: true },
    { code: 'CHASE', label: 'Record a chase / promise-to-pay', available: true },
    { code: 'WRITE_OFF', label: 'Write off the balance', available: true, requiresManager: true },
    { code: 'LEGAL', label: 'Escalate to legal / small claims', available: true, requiresOwner: true },
  ];
  if (plan.model === 'LAYAWAY_BACKED' && plan.status !== 'COMPLETED') {
    base.unshift({ code: 'REPOSSESS', label: 'Repossess the goods and refund amounts paid (less restocking fee)', available: true, requiresManager: true });
  }
  return base;
}

/** Repossession settlement: what is owed back to the customer. */
function repossessionSettlement({ plan, paidTotal, restockingFeePercent = 10 }) {
  const paidK = toKobo(paidTotal);
  const pct = Math.min(100, Math.max(0, Number(restockingFeePercent) || 0));
  const feeK = Math.round((paidK * pct) / 100);
  const refundK = Math.max(0, paidK - feeK);
  return {
    paidTotal: fromKobo(paidK),
    restockingFeePercent: pct,
    restockingFee: fromKobo(feeK),
    refundDue: fromKobo(refundK),
    note: 'The goods return to stock at their original batch cost; the refund is a cash-out from the branch safe or till.',
  };
}

module.exports = {
  PLAN_MODELS, PLAN_STATUSES, FREQUENCIES, ENTRY_STATUSES, DEFAULTS,
  daysForFrequency, addPeriods, addCalendarDays, isOverdue,
  buildPlan, applyPayment, refreshOverdue, defaultOptions, repossessionSettlement,
};
