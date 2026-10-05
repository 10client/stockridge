'use strict';
// =====================================================================
// domain/instalments.js — "WORK AND PAY" / AJO-STYLE PAYMENT PLANS
// =====================================================================
// WHAT THIS IS IN THE NIGERIAN MARKET
//
// A customer takes a fridge or a motorcycle today and pays over 3-12
// months, usually weekly or monthly, usually with a deposit of 20-40% and
// usually with a guarantor who is a known relative or employer. Shops call
// it "work and pay", "small-small", or an instalment plan; the rotating
// savings variant is "Ajo" or "Esusu".
//
// This is not a loan product and StockRidge does not treat it as one: there
// is no credit scoring, no regulatory capital calculation, no NPL
// provisioning model. What it IS is a disciplined record of an agreement
// the shop has already made face to face, so that:
//   - the schedule exists before the customer leaves, not in someone's head
//   - a payment is attributed to a specific instalment, not to "the plan"
//   - arrears are visible by day count, not by memory
//   - the guarantor's details are on file when the phone stops being answered
//   - the goods are not handed over until the deposit and the first
//     instalment are actually in the till
//
// INTEREST
// Most Nigerian work-and-pay arrangements charge interest, expressed
// either as a flat uplift on the principal ("pay ₦700,000 for a ₦600,000
// fridge") or as a monthly percentage. Both are supported. The uplift form
// is the default because it is what shops actually quote and what the
// customer actually understands.
//
// The cap in client_settings.instalment_max_interest_pct exists because an
// uncapped uplift is how a ₦600,000 fridge becomes a ₦1.4m debt that can
// never be repaid and ends in a fight in the shop. The OWNER sets the cap;
// the app refuses to build a schedule above it.
// =====================================================================

const { round2 } = require('./money');
const { addMonths, addDays, daysBetween } = require('./time');

const FREQUENCIES = Object.freeze(['WEEKLY', 'BIWEEKLY', 'MONTHLY']);

const PLAN_STATUS = Object.freeze(['ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED']);

const SCHEDULE_STATUS = Object.freeze(['PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED']);

/** How many instalments a tenure and frequency produce. */
function instalmentCount(tenureMonths, frequency) {
  const months = Math.max(1, Math.round(Number(tenureMonths) || 1));
  switch (String(frequency || 'MONTHLY').toUpperCase()) {
    case 'WEEKLY': return months * 4;      // 4 weeks treated as a month, the shop-floor convention
    case 'BIWEEKLY': return months * 2;
    case 'MONTHLY':
    default: return months;
  }
}

/** Advance a date by one instalment period. */
function nextDueDate(fromDate, frequency) {
  switch (String(frequency || 'MONTHLY').toUpperCase()) {
    case 'WEEKLY': return addDays(fromDate, 7);
    case 'BIWEEKLY': return addDays(fromDate, 14);
    case 'MONTHLY':
    default: return addMonths(fromDate, 1);
  }
}

/**
 * Validate a proposed plan against the owner's policy caps.
 *
 * Every check returns a message written for a HUMAN AT A COUNTER, not a
 * code for a developer — this result is shown directly to the person
 * building the plan.
 */
function validatePlan({
  principal, depositAmount = 0, interestPercent = 0, interestAmount = null,
  tenureMonths, frequency = 'MONTHLY', settings = {},
}) {
  const p = round2(Number(principal) || 0);
  const deposit = round2(Math.max(0, Number(depositAmount) || 0));
  const months = Number(tenureMonths);
  const freq = String(frequency || 'MONTHLY').toUpperCase();
  const errors = [];

  if (p <= 0) errors.push('Enter the price of the goods being taken on plan.');
  if (!FREQUENCIES.includes(freq)) errors.push(`Payment frequency must be one of: ${FREQUENCIES.join(', ')}.`);
  if (!Number.isFinite(months) || months < 1) errors.push('Tenure must be at least 1 month.');

  const maxTenure = Number(settings.instalment_max_tenure_months);
  if (Number.isFinite(maxTenure) && maxTenure > 0 && months > maxTenure) {
    errors.push(`This account's policy caps instalment plans at ${maxTenure} month${maxTenure === 1 ? '' : 's'}. Ask the owner to change it in Settings if this customer needs longer.`);
  }

  if (deposit > p) errors.push('The deposit cannot be more than the price of the goods.');

  const minDepositPct = Number(settings.instalment_min_deposit_pct);
  if (Number.isFinite(minDepositPct) && minDepositPct > 0 && p > 0) {
    const minDeposit = round2((p * minDepositPct) / 100);
    if (deposit < minDeposit) {
      errors.push(`Policy requires a deposit of at least ${minDepositPct}% — ₦${minDeposit.toLocaleString('en-NG')} on this price. Entered: ₦${deposit.toLocaleString('en-NG')}.`);
    }
  }

  // Interest may be given as a percentage OR as a flat amount. Not both —
  // two independent statements of the same figure will disagree.
  const pct = Number(interestPercent) || 0;
  const flat = interestAmount == null ? null : round2(Number(interestAmount));
  if (pct !== 0 && flat != null && flat !== 0) {
    errors.push('Enter interest as EITHER a percentage OR a flat amount, not both.');
  }
  let interest = 0;
  if (flat != null && flat > 0) interest = flat;
  else if (pct > 0) interest = round2((p * pct) / 100);

  const maxInterestPct = Number(settings.instalment_max_interest_pct);
  if (Number.isFinite(maxInterestPct) && maxInterestPct >= 0 && p > 0) {
    const impliedPct = round2((interest / p) * 100);
    if (impliedPct > maxInterestPct) {
      errors.push(`That is ${impliedPct}% interest on the price. This account's policy caps instalment interest at ${maxInterestPct}%. A plan above the cap cannot be created — the owner can raise it in Settings if they choose.`);
    }
  }

  const balanceAfterDeposit = round2(p - deposit);
  if (balanceAfterDeposit <= 0 && p > 0) {
    errors.push('The deposit covers the whole price — record this as a normal cash sale instead of an instalment plan.');
  }

  const count = instalmentCount(months, freq);
  if (count < 1) errors.push('That combination produces no instalments.');

  return {
    ok: errors.length === 0,
    errors,
    principal: p,
    depositAmount: deposit,
    interestAmount: interest,
    interestPercent: p > 0 ? round2((interest / p) * 100) : 0,
    totalPayable: round2(p + interest),
    financedAmount: balanceAfterDeposit,
    tenureMonths: Number.isFinite(months) ? months : null,
    frequency: freq,
    instalmentCount: count,
  };
}

/**
 * Build the repayment schedule.
 *
 * The financed amount (price minus deposit) is divided across the
 * instalments, with the ROUNDING REMAINDER ON THE FIRST instalment rather
 * than the last.
 *
 * That choice is deliberate and opposite to the usual convention. The last
 * instalment is the one most often unpaid — a customer who has made eleven
 * payments and then disappears. Putting the extra kobo there means the plan
 * reconciles only if the customer completes it. Putting it first means the
 * schedule is exact from day one and any arrears are arrears, not rounding.
 */
/**
 * Advance a date by N instalment periods, anchored to the ORIGINAL date.
 *
 * Anchoring matters at month ends and is the reason this is not just
 * `nextDueDate` applied repeatedly: a plan starting 31 January chained
 * through a clamped 28 February would then produce 28 March, 28 April,
 * 28 May... and by December the customer is billed three days early every
 * month for the life of the plan. Anchoring gives 31 Jan, 28 Feb, 31 Mar,
 * 30 Apr — each month's correct date, February clamped only because
 * February is short.
 */
function advanceFrom(startDate, periods, frequency) {
  const from = String(startDate).slice(0, 10);
  const n = Math.max(0, Math.round(Number(periods) || 0));
  if (n === 0) return from;
  switch (String(frequency || 'MONTHLY').toUpperCase()) {
    case 'WEEKLY': return addDays(from, n * 7);
    case 'BIWEEKLY': return addDays(from, n * 14);
    case 'MONTHLY':
    default: return addMonths(from, n);
  }
}

function buildSchedule({ financedAmount, instalmentCount: count, scheduleStart, frequency = 'MONTHLY' }) {
  const total = round2(Number(financedAmount) || 0);
  const n = Math.max(1, Math.round(Number(count) || 1));
  if (total <= 0) return [];

  const base = Math.floor((total * 100) / n) / 100; // truncate to kobo
  const remainder = round2(total - round2(base * n));

  const start = String(scheduleStart || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      seq: i + 1,
      dueDate: advanceFrom(start, i, frequency),
      amountDue: i === 0 ? round2(base + remainder) : base,
      status: SCHEDULE_STATUS[0],
    });
  }
  // Safety: the parts must foot to the whole exactly.
  const sum = round2(rows.reduce((a, r) => a + r.amountDue, 0));
  if (sum !== total) rows[0].amountDue = round2(rows[0].amountDue + (total - sum));
  return rows;
}

/**
 * Apply a payment to a schedule, oldest-due-first.
 *
 * Oldest-first is the convention that keeps an arrears report honest.
 * Applying to the newest instalment instead would let a customer who pays
 * one month in three show as "up to date on the current instalment" while
 * carrying two months of arrears — which is exactly the misreading that
 * causes a shop to hand over a second item on plan.
 */
function applyPayment({ schedule, amount, paidAt = null }) {
  let remaining = round2(Math.max(0, Number(amount) || 0));
  if (remaining <= 0) return { ok: false, error: 'Payment amount must be greater than zero.', schedule, allocated: [], remaining };

  const rows = (schedule || []).map((r) => ({ ...r }));
  const ordered = rows
    .filter((r) => r.status !== 'PAID' && r.status !== 'WAIVED')
    .sort((a, b) => {
      const byDue = String(a.dueDate).localeCompare(String(b.dueDate));
      return byDue !== 0 ? byDue : Number(a.seq) - Number(b.seq);
    });

  const allocated = [];
  for (const row of ordered) {
    if (remaining <= 0) break;
    const outstanding = round2(Number(row.amountDue) - Number(row.amountPaid || 0));
    if (outstanding <= 0) continue;
    const applied = round2(Math.min(outstanding, remaining));
    row.amountPaid = round2(Number(row.amountPaid || 0) + applied);
    row.status = row.amountPaid >= row.amountDue ? 'PAID' : 'PARTIAL';
    if (row.status === 'PAID') row.paidAt = paidAt || new Date().toISOString().slice(0, 19).replace('T', ' ');
    remaining = round2(remaining - applied);
    allocated.push({ seq: row.seq, applied, newStatus: row.status });
  }

  return {
    ok: true,
    schedule: rows,
    allocated,
    // Anything left after every instalment is covered is an OVERPAYMENT:
    // a credit on the plan, not a rounding artefact. It must be surfaced
    // and refunded or carried forward, never silently absorbed.
    unallocated: remaining,
  };
}

/** Recompute a plan's derived figures from its schedule. */
function planStatusFromSchedule({ schedule, totalPayable, depositAmount = 0 }) {
  const rows = schedule || [];
  const paid = round2(rows.reduce((a, r) => a + Number(r.amountPaid || 0), 0) + Number(depositAmount || 0));
  const outstanding = round2(Math.max(0, Number(totalPayable) - paid));
  const today = new Date().toISOString().slice(0, 10);
  const overdue = rows.filter((r) => (r.status === 'PENDING' || r.status === 'PARTIAL') && String(r.dueDate) < today);
  const nextPending = rows
    .filter((r) => r.status !== 'PAID' && r.status !== 'WAIVED')
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0] || null;

  const worstOverdueDays = overdue.length
    ? Math.max(...overdue.map((r) => daysBetween(String(r.dueDate).slice(0, 10), today) || 0))
    : 0;

  return {
    amountPaid: paid,
    outstanding,
    isComplete: outstanding <= 0.005,
    status: outstanding <= 0.005 ? 'COMPLETED' : 'ACTIVE',
    overdueCount: overdue.length,
    overdueAmount: round2(overdue.reduce((a, r) => a + (Number(r.amountDue) - Number(r.amountPaid || 0)), 0)),
    daysOverdue: worstOverdueDays,
    nextDueDate: nextPending ? nextPending.dueDate : null,
    nextDueAmount: nextPending ? round2(Number(nextPending.amountDue) - Number(nextPending.amountPaid || 0)) : null,
    paidUpCount: rows.filter((r) => r.status === 'PAID').length,
    totalInstalments: rows.length,
  };
}

/**
 * Should a plan be marked DEFAULTED?
 *
 * A threshold, not a judgement: the owner sets how many days of arrears
 * means the plan has failed. Deliberately NOT automatic enforcement —
 * marking a plan defaulted is a business decision with real consequences
 * (repossession, calling the guarantor), and the system should surface the
 * trigger, not pull it.
 */
function defaultTrigger({ plan, settings = {}, today = null }) {
  const reference = today || new Date().toISOString().slice(0, 10);
  const thresholdDays = Number(settings.instalment_default_after_days) || 60;
  const missedCount = Number(settings.instalment_default_after_missed) || 3;
  const overdue = Number(plan.daysOverdue || 0);
  const missed = Number(plan.overdueCount || 0);
  const byDays = overdue >= thresholdDays;
  const byCount = missed >= missedCount;
  if (!byDays && !byCount) return null;
  return {
    code: 'PLAN_DEFAULT_TRIGGERED',
    severity: 'CRITICAL',
    daysOverdue: overdue,
    missedInstalments: missed,
    message: byDays && byCount
      ? `This plan is ${overdue} days overdue on ${missed} instalments. Policy says a plan is in default at ${thresholdDays} days or ${missedCount} missed instalments — both thresholds are met.`
      : byDays
        ? `This plan is ${overdue} days overdue. Policy treats ${thresholdDays} days as default.`
        : `This plan has ${missed} missed instalments. Policy treats ${missedCount} as default.`,
  };
}

module.exports = {
  FREQUENCIES, PLAN_STATUS, SCHEDULE_STATUS,
  instalmentCount, nextDueDate, advanceFrom,
  validatePlan, buildSchedule, applyPayment, planStatusFromSchedule, defaultTrigger,
};
