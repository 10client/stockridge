// =====================================================================
// StockRidge — CREDIT PLANS (Instalments, Layaway, Holds, Trade Credit)
// =====================================================================
// "PAY SMALL SMALL" IS NOT A FEATURE. IT IS THE MARKET.
//
// A ₦450,000 refrigerator or a ₦1,200,000 7-seater sofa is not a cash
// purchase for most Nigerian households, and a shop that cannot offer a
// plan does not make the sale — the customer goes to the dealer who can.
// At the same time, informal instalment selling is where retailers lose
// money: a paper exercise book, a phone number that stops ringing, and no
// record of what was actually collected against what was agreed.
//
// These four instruments are deliberately SEPARATE, because they carry
// completely different risk and completely different stock consequences:
//
//   INSTALMENT_PLAN  Goods leave the shop NOW; the customer pays over time.
//                    The shop owns an unsecured (or guarantor-backed)
//                    receivable. Stock is decremented at handover. Highest
//                    risk, highest sales lift.
//
//   LAYAWAY          Customer pays a deposit and instalments; goods stay
//                    in the shop until PAID IN FULL, then are collected.
//                    Stock is RESERVED, not decremented. Almost no credit
//                    risk. This is the instrument for a showroom with ONE
//                    7-seater that three customers want.
//
//   ITEM_HOLD        A short shelf reservation (hours, not weeks) so a
//                    customer can go to the bank and come back. No money
//                    necessarily changes hands. Auto-expires.
//
//   TRADE_CREDIT     A business-to-business account: a dealer or contractor
//                    buys on 30-day terms against an agreed credit limit,
//                    and pays invoices rather than plans. Runs on the
//                    debtor ledger, not on a schedule.
//
// ---------------------------------------------------------------------
// THE ARITHMETIC RULES
// ---------------------------------------------------------------------
// 1. THE SCHEDULE MUST SUM TO THE AGREED TOTAL. Not "approximately". The
//    final instalment ABSORBS the rounding difference, so a ₦450,000 plan
//    over 7 months is six instalments of ₦68,571.43 and a seventh of
//    ₦38,571.42 — never seven instalments that add to ₦450,000.01 and make
//    the customer's last payment a dispute.
// 2. A DEPOSIT IS A REAL PAYMENT, NOT A REDUCTION. It is recorded as a
//    payment leg on the originating sale AND as the first schedule entry.
//    Recording it only in one place is how a plan shows ₦0 collected
//    against a customer who demonstrably paid.
// 3. INTEREST IS OPTIONAL AND MUST BE DISCLOSED. Many Nigerian retailers
//    sell interest-free over 3 months and charge on 6-12. The plan stores
//    both the goods price and the total payable, so the customer's
//    agreement and the shop's revenue recognition are both honest.
// 4. DEFAULT NEVER SILENTLY FORGIVES. A plan in DEFAULT still owes its
//    balance; it is flagged, aged and reported, and the goods may be
//    repossessed (recorded as a stock RETURN, not a write-off — the asset
//    comes back onto the shelf at its current value).
// =====================================================================

const { round2, sum } = require('./money');

// ---------------------------------------------------------------------
// INSTALMENT PLANS
// ---------------------------------------------------------------------
const PLAN_STATUSES = Object.freeze([
  'DRAFT',        // quoted to the customer, not yet agreed
  'ACTIVE',       // signed, goods handed over, schedule running
  'COMPLETED',    // fully paid
  'DEFAULTED',    // missed payments past the grace period
  'REPOSSESSED',  // goods taken back; balance written off or pursued
  'RESTRUCTURED', // replaced by a new plan (the old one is kept for audit)
  'WRITTEN_OFF',  // balance abandoned; requires OWNER authority
  'CANCELLED',    // never activated
]);

// Standard tenors offered at the counter. Deliberately a short list: a
// cashier negotiating an 11-month plan off-menu is a cashier creating an
// unpriceable receivable.
const PLAN_TENOR_MONTHS = Object.freeze([3, 4, 6, 9, 12, 18, 24]);

// Minimum deposit as a percentage of the goods price. 30% is the common
// Nigerian retail floor; below that the customer has less skin in the game
// than the cost of repossessing a used appliance.
const DEFAULT_MIN_DEPOSIT_PERCENT = 30;

// Grace period before a missed instalment makes the plan DEFAULTED. One
// month is realistic: salaries in Nigeria commonly land late, and
// defaulting a customer on day 1 of lateness destroys the relationship the
// plan was built on — while never defaulting destroys the cash flow.
const DEFAULT_GRACE_DAYS = 30;

// Build a schedule. Pure function; no dates are invented here beyond the
// anchors the caller passes, so the same code produces a schedule the GUI
// can preview and the server can persist identically.
function buildInstalmentSchedule({
  goodsPrice,
  deposit = 0,
  tenorMonths = 6,
  interestPercentPerAnnum = 0,
  startDate,               // Date or ISO string — the handover/agreement date
  billingDayOfMonth = null, // pin due dates to a day (e.g. salary day, 25th)
}) {
  const price = round2(goodsPrice);
  if (!(price > 0)) {
    return { ok: false, code: 'PRICE_INVALID', error: 'The goods price must be greater than zero.' };
  }
  const tenor = Number(tenorMonths);
  if (!Number.isInteger(tenor) || tenor < 1 || tenor > 60) {
    return { ok: false, code: 'TENOR_INVALID', error: 'Choose a plan length between 1 and 60 months.' };
  }

  const dep = round2(Math.max(0, Number(deposit) || 0));
  if (dep > price) {
    return { ok: false, code: 'DEPOSIT_EXCEEDS_PRICE', error: 'The deposit cannot be more than the goods price.' };
  }

  const financed = round2(price - dep);

  // Interest. Simple interest on the FINANCED amount over the tenor,
  // disclosed as a single figure. Compound/amortised interest is a lending
  // product with its own regulatory treatment (CBN licensing for money
  // lending); a retailer offering "pay small small" prices a service
  // charge, and simple interest is the honest, defensible model for it.
  const rate = Math.max(0, Number(interestPercentPerAnnum) || 0);
  const interest = round2((financed * rate * tenor) / (100 * 12));
  const totalPayable = round2(price + interest);
  const totalInstalments = round2(financed + interest);

  // ---- the schedule, with the last entry absorbing rounding -------------
  const start = startDate instanceof Date ? new Date(startDate.getTime()) : new Date(String(startDate || new Date().toISOString()));
  if (Number.isNaN(start.getTime())) {
    return { ok: false, code: 'START_DATE_INVALID', error: 'The agreement date is not a valid date.' };
  }

  const entries = [];
  if (dep > 0) {
    entries.push({
      seq: 0,
      due_date: isoDate(start),
      amount: dep,
      kind: 'DEPOSIT',
      description: 'Deposit paid at agreement',
    });
  }

  const instalmentCount = tenor;
  const even = instalmentCount > 0 ? round2(totalInstalments / instalmentCount) : 0;
  let allocated = 0;

  for (let i = 1; i <= instalmentCount; i++) {
    const due = addMonths(start, i);
    if (billingDayOfMonth) pinToDayOfMonth(due, billingDayOfMonth);
    // RULE 1: the final instalment absorbs the rounding difference.
    const amount = i === instalmentCount ? round2(totalInstalments - allocated) : even;
    allocated = round2(allocated + amount);
    entries.push({
      seq: i,
      due_date: isoDate(due),
      amount,
      kind: 'INSTALMENT',
      description: `Instalment ${i} of ${instalmentCount}`,
    });
  }

  // Sanity: the schedule must equal the total, exactly.
  const scheduled = round2(sum(entries.map((e) => e.amount)));
  if (Math.abs(scheduled - totalPayable) > 0.005) {
    return {
      ok: false, code: 'SCHEDULE_DOES_NOT_BALANCE',
      error: `Internal check failed: the schedule totals ₦${scheduled.toFixed(2)} against ₦${totalPayable.toFixed(2)} payable.`,
    };
  }

  return {
    ok: true,
    goods_price: price,
    deposit: dep,
    deposit_percent: price > 0 ? round2((dep / price) * 100) : 0,
    financed_amount: financed,
    interest_percent_per_annum: rate,
    interest_amount: interest,
    total_payable: totalPayable,
    tenor_months: tenor,
    instalment_count: instalmentCount,
    regular_instalment: even,
    schedule: entries,
    start_date: isoDate(start),
    end_date: entries.length ? entries[entries.length - 1].due_date : isoDate(start),
  };
}

// Minimum-deposit gate. Returns null when satisfied, or a refusal with the
// shortfall so the UI can say exactly how much more is needed rather than
// just "not enough".
function assertMinimumDeposit({ goodsPrice, deposit, minDepositPercent = DEFAULT_MIN_DEPOSIT_PERCENT }) {
  const price = round2(goodsPrice);
  const dep = round2(deposit);
  const pct = Math.max(0, Number(minDepositPercent) || 0);
  if (pct <= 0) return null;
  const required = round2((price * pct) / 100);
  if (dep < required) {
    return {
      ok: false, code: 'DEPOSIT_BELOW_MINIMUM',
      error: `The minimum deposit is ${pct}% of ₦${price.toLocaleString('en-NG')} = ₦${required.toLocaleString('en-NG')}. ₦${shortfallLabel(dep, required)} more is needed.`,
      required,
      offered: dep,
      shortfall: round2(required - dep),
    };
  }
  return null;
}

function shortfallLabel(offered, required) {
  return round2(Math.max(0, required - offered)).toLocaleString('en-NG');
}

// Apply a payment to a schedule. Earliest unpaid entry first (not the entry
// the cashier picked) — a customer who pays ₦200,000 against a 6-month plan
// has paid the next two months, not "instalment 5" because that is the one
// on screen. Overpayment beyond the schedule is refused rather than held as
// an unexplained credit.
function applyPlanPayment(schedule, amount, { paidAt } = {}) {
  const pay = round2(amount);
  if (!(pay > 0)) return { ok: false, code: 'AMOUNT_INVALID', error: 'Enter an amount greater than zero.' };

  const outstanding = schedule.filter((e) => !e.paid_at);
  const totalOutstanding = round2(sum(outstanding.map((e) => e.amount)));
  if (pay > totalOutstanding) {
    return {
      ok: false, code: 'OVERPAYMENT_ON_PLAN',
      error: `The plan balance is ₦${totalOutstanding.toLocaleString('en-NG')}. ₦${pay.toLocaleString('en-NG')} is more than is owed — the plan would be complete.`,
      totalOutstanding,
    };
  }

  let remaining = pay;
  const allocations = [];
  const updated = schedule.map((e) => ({ ...e }));

  for (const entry of updated) {
    if (entry.paid_at || remaining <= 0) continue;
    const apply = Math.min(entry.amount, remaining);
    entry.paid_amount = round2((entry.paid_amount || 0) + apply);
    if (round2(entry.paid_amount) >= round2(entry.amount)) {
      entry.paid_at = isoDate(paidAt || new Date());
    }
    remaining = round2(remaining - apply);
    allocations.push({ seq: entry.seq, applied: apply, due_date: entry.due_date, closed: Boolean(entry.paid_at) });
  }

  const paidTotal = round2(sum(updated.filter((e) => e.paid_at).map((e) => e.amount)));
  const balance = round2(sum(updated.filter((e) => !e.paid_at).map((e) => Number(e.amount) - Number(e.paid_amount || 0))));

  return {
    ok: true,
    allocations,
    schedule: updated,
    amount_applied: round2(pay - remaining),
    unapplied: remaining,
    paid_to_date: paidTotal,
    outstanding_balance: balance,
    is_complete: balance <= 0.005,
    next_due: (updated.find((e) => !e.paid_at) || {}).due_date || null,
  };
}

// Is the plan in default? A missed instalment inside the grace period is
// OVERDUE, not DEFAULTED — the distinction matters because overdue plans
// get a reminder and defaulted plans get repossessed.
function planHealth(schedule, { graceDays = DEFAULT_GRACE_DAYS, now = new Date() } = {}) {
  const today = isoDate(now);
  let overdueCount = 0;
  let defaultedCount = 0;
  let overdueAmount = 0;
  let nextDue = null;

  for (const e of schedule) {
    if (e.paid_at) continue;
    if (!nextDue) nextDue = e.due_date;
    if (e.due_date < today) {
      overdueCount += 1;
      overdueAmount = round2(overdueAmount + (Number(e.amount) - Number(e.paid_amount || 0)));
      const daysLate = daysBetween(e.due_date, today);
      if (daysLate > graceDays) defaultedCount += 1;
    }
  }

  const status = defaultedCount > 0 ? 'DEFAULTED' : overdueCount > 0 ? 'OVERDUE' : 'CURRENT';
  return { status, overdueCount, defaultedCount, overdueAmount, nextDue, graceDays };
}

// ---------------------------------------------------------------------
// LAYAWAY
// ---------------------------------------------------------------------
// Stock is RESERVED, not decremented. The reservation has to expire, or a
// customer who paid ₦20,000 on a ₦400,000 sofa and vanished locks the only
// one in the showroom forever — and a locked sofa earns nothing.
const LAYAWAY_STATUSES = Object.freeze([
  'ACTIVE', 'COMPLETED', 'COLLECTED', 'EXPIRED', 'CANCELLED', 'FORFEITED',
]);

const LAYAWAY_DEFAULT_COLLECTION_WINDOW_DAYS = 14; // after final payment
const LAYAWAY_DEFAULT_MAX_TERM_DAYS = 90;           // total time to pay

// Forfeiture is the sensitive one. Under Nigerian consumer practice a shop
// that keeps the WHOLE of a customer's layaway money for a defaulted
// agreement is exposed, and it is also bad for business in a market where
// the customer's family will hear about it. The default is to refund the
// paid amount LESS a stated administration charge, with the charge capped —
// and the cap is a setting the owner chooses knowingly.
const LAYAWAY_DEFAULT_ADMIN_CHARGE_PERCENT = 10;
const LAYAWAY_MAX_ADMIN_CHARGE_PERCENT = 25;

function layawaySummary({ goodsPrice, paidToDate, adminChargePercent = LAYAWAY_DEFAULT_ADMIN_CHARGE_PERCENT }) {
  const price = round2(goodsPrice);
  const paid = round2(paidToDate);
  const balance = round2(Math.max(0, price - paid));
  const pct = Math.min(LAYAWAY_MAX_ADMIN_CHARGE_PERCENT, Math.max(0, Number(adminChargePercent) || 0));
  const charge = round2((paid * pct) / 100);
  return {
    goods_price: price,
    paid_to_date: paid,
    outstanding_balance: balance,
    percent_paid: price > 0 ? round2((paid / price) * 100) : 0,
    is_complete: balance <= 0.005,
    forfeit_admin_charge_percent: pct,
    forfeit_admin_charge: charge,
    forfeit_refund_due: round2(Math.max(0, paid - charge)),
  };
}

// ---------------------------------------------------------------------
// ITEM HOLDS
// ---------------------------------------------------------------------
// Short, auto-expiring, and ALWAYS bounded. An unbounded hold is just a
// layaway nobody is paying for.
const HOLD_DEFAULT_TTL_HOURS = 24;
const HOLD_MAX_TTL_HOURS = 72;
const HOLD_STATUSES = Object.freeze(['ACTIVE', 'RELEASED', 'CONVERTED', 'EXPIRED']);

function holdExpiresAt(startedAt, ttlHours = HOLD_DEFAULT_TTL_HOURS) {
  const ttl = Math.min(HOLD_MAX_TTL_HOURS, Math.max(1, Number(ttlHours) || HOLD_DEFAULT_TTL_HOURS));
  const base = startedAt instanceof Date ? new Date(startedAt.getTime()) : new Date(String(startedAt || new Date().toISOString()));
  return new Date(base.getTime() + ttl * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------
// TRADE CREDIT (B2B accounts)
// ---------------------------------------------------------------------
// Runs on the debtor ledger. The credit LIMIT is the control: a contractor
// account that can draw without a ceiling is an unsecured loan the owner
// never agreed to make.
const DEBTOR_AGING_BUCKETS = Object.freeze([
  { code: 'CURRENT', label: 'Not yet due', minDays: -Infinity, maxDays: 0 },
  { code: 'D1_30', label: '1–30 days', minDays: 1, maxDays: 30 },
  { code: 'D31_60', label: '31–60 days', minDays: 31, maxDays: 60 },
  { code: 'D61_90', label: '61–90 days', minDays: 61, maxDays: 90 },
  { code: 'D90_PLUS', label: 'Over 90 days', minDays: 91, maxDays: Infinity },
]);

function agingBucket(daysOverdue) {
  const d = Number(daysOverdue) || 0;
  return DEBTOR_AGING_BUCKETS.find((b) => d >= b.minDays && d <= b.maxDays) || DEBTOR_AGING_BUCKETS[0];
}

// Credit-limit gate for a NEW sale on account. Checks the limit against the
// balance the customer will have AFTER this sale, and distinguishes three
// outcomes because they need three different responses at the counter:
//   WITHIN      — proceed
//   OVER_LIMIT  — needs manager authority, and the manager should see the
//                 numbers, not just a warning
//   ALREADY_OVER— the account is already in breach; a manager must decide
//                 whether to keep supplying a customer who has not paid
function checkCreditAvailability({ creditLimit, currentBalance, saleAmount, hasOverdueInvoices = false }) {
  const limit = round2(creditLimit);
  const bal = round2(currentBalance);
  const add = round2(saleAmount);
  if (!(limit > 0)) {
    return { outcome: 'NO_CREDIT_TERMS', available: 0, after: round2(bal + add), limit: 0 };
  }
  const after = round2(bal + add);
  const available = round2(Math.max(0, limit - bal));

  if (bal > limit) {
    return { outcome: 'ALREADY_OVER_LIMIT', available: 0, after, limit, overBy: round2(bal - limit), hasOverdueInvoices };
  }
  if (after > limit) {
    return { outcome: 'OVER_LIMIT', available, after, limit, overBy: round2(after - limit), hasOverdueInvoices };
  }
  if (hasOverdueInvoices) {
    return { outcome: 'WITHIN_LIMIT_HAS_OVERDUE', available, after, limit, hasOverdueInvoices: true };
  }
  return { outcome: 'WITHIN_LIMIT', available, after, limit, hasOverdueInvoices: false };
}

const CREDIT_OUTCOME_MESSAGES = Object.freeze({
  NO_CREDIT_TERMS: 'This customer has no credit terms. Set a credit limit (manager) or take payment now.',
  OVER_LIMIT: 'This sale would take the customer over their credit limit. Manager approval required.',
  ALREADY_OVER_LIMIT: 'This account is ALREADY over its credit limit. Manager approval required to supply further.',
  WITHIN_LIMIT_HAS_OVERDUE: 'Within the limit, but this customer has overdue invoices. Consider chasing before extending more.',
  WITHIN_LIMIT: null,
});

// ---------------------------------------------------------------------
// DATE HELPERS
// ---------------------------------------------------------------------
function isoDate(d) {
  const date = d instanceof Date ? d : new Date(String(d));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamping matters: 31 January + 1 month must be 28/29 February, not
  // 3 March. A plan that silently shifts a due date into the next month
  // makes the customer late on an instalment they were never told about.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

function pinToDayOfMonth(date, day) {
  const target = Math.min(28, Math.max(1, Number(day) || 1)); // 29-31 do not exist every month
  date.setUTCDate(target);
  return date;
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(String(fromIso));
  const b = Date.parse(String(toIso));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86400000);
}

module.exports = {
  PLAN_STATUSES,
  PLAN_TENOR_MONTHS,
  DEFAULT_MIN_DEPOSIT_PERCENT,
  DEFAULT_GRACE_DAYS,
  LAYAWAY_STATUSES,
  LAYAWAY_DEFAULT_COLLECTION_WINDOW_DAYS,
  LAYAWAY_DEFAULT_MAX_TERM_DAYS,
  LAYAWAY_DEFAULT_ADMIN_CHARGE_PERCENT,
  LAYAWAY_MAX_ADMIN_CHARGE_PERCENT,
  HOLD_DEFAULT_TTL_HOURS,
  HOLD_MAX_TTL_HOURS,
  HOLD_STATUSES,
  DEBTOR_AGING_BUCKETS,
  CREDIT_OUTCOME_MESSAGES,
  buildInstalmentSchedule,
  assertMinimumDeposit,
  applyPlanPayment,
  planHealth,
  layawaySummary,
  holdExpiresAt,
  agingBucket,
  checkCreditAvailability,
  isoDate,
  addMonths,
  pinToDayOfMonth,
  daysBetween,
};
