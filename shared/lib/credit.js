// =====================================================================
// shared/lib/credit.js — CREDIT SALES, DEBTOR LEDGER AND AGEING
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: debtor_ledger + creditor_ledger + change_owed +
// branch_safe_ledger. The ledger mechanics are unchanged (they were correct)
// but the CREDIT POLICY layer is new, because a general retailer extends far
// more credit than a pharmacy does:
//
//   * a wholesaler supplies 30 sub-dealers on 14-day terms
//   * a furniture shop sells a ₦3m bedroom set to a corporate client on 60 days
//   * a building-materials dealer supplies a site against a contractor's PO,
//     paid when the client's own milestone clears
//   * a market trader takes goods in the morning and pays in the evening
//
// Every one of those is a receivable with a TERMS CODE, a due date, an ageing
// bucket and a chase history. Without terms the debtor report is a list of
// numbers with no dates, and "who is late?" is unanswerable.
//
// THE LEDGER IS APPEND-ONLY. Balances are DERIVED, never stored as a running
// total. A stored balance can be written to directly, and once it can be, it
// will drift from the sum of its entries — and then nobody knows which figure
// to believe. Deriving it means the balance is always the sum of the evidence.

'use strict';

const { round2, toKobo, fromKobo, allocateKobo } = require('./money');

const TERMS_CODES = Object.freeze([
  { code: 'CASH',      label: 'Cash / immediate',     days: 0 },
  { code: 'NET_7',     label: 'Net 7 days',           days: 7 },
  { code: 'NET_14',    label: 'Net 14 days',          days: 14 },
  { code: 'NET_30',    label: 'Net 30 days',          days: 30 },
  { code: 'NET_60',    label: 'Net 60 days',          days: 60 },
  { code: 'NET_90',    label: 'Net 90 days',          days: 90 },
  { code: 'ON_DELIVERY', label: 'Payable on delivery', days: 0 },
  { code: 'MILESTONE', label: 'Against a milestone / PO', days: 30 },
]);

const ENTRY_TYPES = Object.freeze([
  'SALE',            // debit  — goods went out on credit
  'PAYMENT',         // credit — money received
  'CREDIT_NOTE',     // credit — returned goods, pricing error, goodwill
  'DEBIT_NOTE',      // debit  — delivery fee, installation, interest agreed
  'INSTALLMENT_DUE', // debit  — an instalment plan's obligation
  'BAD_DEBT',        // credit — written off (removes the receivable)
  'REVERSAL',        // reverses a specific earlier entry
  'OPENING_BALANCE', // debit/credit — what the customer owed when we started
  'FX_REVALUATION',  // debit/credit — a foreign-currency debt revalued
]);

// Standard ageing buckets. 0-30 / 31-60 / 61-90 / 90+ is what an accountant
// asks for and what a chase list is built from.
const AGEING_BUCKETS = Object.freeze([
  { code: 'CURRENT',  label: 'Not yet due',  min: -Infinity, max: 0 },
  { code: 'D1_30',    label: '1-30 days',    min: 1,  max: 30 },
  { code: 'D31_60',   label: '31-60 days',   min: 31, max: 60 },
  { code: 'D61_90',   label: '61-90 days',   min: 61, max: 90 },
  { code: 'D91_180',  label: '91-180 days',  min: 91, max: 180 },
  { code: 'D180_PLUS', label: 'Over 180 days', min: 181, max: Infinity },
]);

function termsDays(code) {
  const t = TERMS_CODES.find((x) => x.code === String(code || 'CASH').toUpperCase());
  return t ? t.days : 0;
}

function addDays(dateIso, days) {
  const d = new Date(Date.parse(`${String(dateIso).slice(0, 10)}T00:00:00Z`));
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.floor(Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

function dueDate(entryDateIso, termsCode) {
  return addDays(entryDateIso, termsDays(termsCode));
}

/**
 * Can this customer take more credit RIGHT NOW?
 *
 * Four independent gates, all of which must pass. The order matters because it
 * is the order a manager wants to hear them in:
 *
 *   1. CREDIT ALLOWED AT ALL — the customer class may forbid it (a walk-in
 *      RETAIL customer cannot buy on account, full stop).
 *   2. LIMIT — headroom against the customer's own limit.
 *   3. OVERDUE — a customer already 30+ days late does not get more goods.
 *      This is the gate that saves the most money and the one shops most often
 *      forget, because the POS only ever looked at the limit.
 *   4. ACCOUNT STATUS — SUSPENDED / BLOCKED / UNDER_REVIEW.
 *
 * Returns { allowed, reasons[], headroomKobo } so the POS can say exactly why.
 */
function assessCreditRequest({ customer, requestedKobo, todayIso = new Date().toISOString().slice(0, 10), policy = {} }) {
  const reqK = Math.max(0, toKobo(requestedKobo));
  const balanceK = Math.max(0, toKobo(customer.balance || 0));
  const limitK = customer.credit_limit != null ? toKobo(customer.credit_limit) : null;
  const reasons = [];

  const status = String(customer.account_status || 'ACTIVE').toUpperCase();
  if (['SUSPENDED', 'BLOCKED', 'UNDER_REVIEW', 'WRITTEN_OFF'].includes(status)) {
    reasons.push({ code: 'ACCOUNT_STATUS', severity: 'BLOCK', message: `This account is ${status.toLowerCase()}. A manager or owner must clear it before further credit.` });
  }

  const classAllows = customer.class_allows_credit !== false;
  if (!classAllows) {
    reasons.push({ code: 'CLASS_FORBIDS_CREDIT', severity: 'BLOCK', message: `${customer.customer_class || 'RETAIL'} customers do not buy on account. Convert this to a cash, card or instalment sale.` });
  }

  if (limitK != null) {
    const headroom = limitK - balanceK;
    if (reqK > headroom) {
      reasons.push({
        code: 'OVER_LIMIT', severity: 'BLOCK',
        message: `This would take the account to ${fromKobo(balanceK + reqK)}, above its ${fromKobo(limitK)} limit (headroom today: ${fromKobo(Math.max(0, headroom))}).`,
      });
    }
  }

  const overdueK = Math.max(0, toKobo(customer.overdue_balance || 0));
  const maxOverdueDays = Number(policy.max_overdue_days != null ? policy.max_overdue_days : 30);
  if (overdueK > 0 && (customer.max_days_overdue || 0) >= maxOverdueDays) {
    reasons.push({
      code: 'ALREADY_OVERDUE', severity: 'BLOCK',
      message: `This customer is ${customer.max_days_overdue} days overdue on ${fromKobo(overdueK)}. Collect or restructure that before extending more.`,
    });
  }

  // Concentration risk: one customer should not be most of the book. Advisory.
  const bookK = Math.max(0, toKobo(policy.total_debtors || 0));
  const concentrationPct = Number(policy.max_concentration_percent || 25);
  if (bookK > 0 && ((balanceK + reqK) / bookK) * 100 > concentrationPct) {
    reasons.push({
      code: 'CONCENTRATION', severity: 'WARN',
      message: `This customer would be ${round2(((balanceK + reqK) / bookK) * 100)}% of your whole debtor book (policy limit ${concentrationPct}%).`,
    });
  }

  const blocked = reasons.some((r) => r.severity === 'BLOCK');
  return {
    allowed: !blocked,
    reasons,
    warnings: reasons.filter((r) => r.severity === 'WARN'),
    blocks: reasons.filter((r) => r.severity === 'BLOCK'),
    currentBalance: fromKobo(balanceK),
    requested: fromKobo(reqK),
    resultingBalance: fromKobo(balanceK + reqK),
    limit: limitK == null ? null : fromKobo(limitK),
    headroomKobo: limitK == null ? null : Math.max(0, limitK - balanceK),
    headroom: limitK == null ? null : fromKobo(Math.max(0, limitK - balanceK)),
  };
}

/**
 * Derive a balance from ledger entries. THE ONLY way a balance is computed.
 *
 * Debits increase what the customer owes; credits decrease it. Sign is
 * carried on the entry, so an entry's `amount` is always positive and
 * `direction` says which way it moves the balance — this prevents the classic
 * ledger bug where a negative amount entered as a "payment" silently increases
 * the debt.
 */
function deriveBalance(entries) {
  let debitK = 0; let creditK = 0;
  for (const e of entries || []) {
    const k = Math.abs(toKobo(e.amount || 0));
    const dir = String(e.direction || '').toUpperCase();
    if (dir === 'DEBIT') debitK += k;
    else if (dir === 'CREDIT') creditK += k;
    else {
      // Infer from type when direction was not stored (legacy rows).
      if (['SALE', 'DEBIT_NOTE', 'INSTALLMENT_DUE', 'OPENING_BALANCE'].includes(String(e.entry_type).toUpperCase())) debitK += k;
      else creditK += k;
    }
  }
  const balanceK = debitK - creditK;
  return {
    debitKobo: debitK, creditKobo: creditK,
    balanceKobo: balanceK, balance: fromKobo(balanceK),
    isOverpaid: balanceK < 0,
    // A credit balance is a customer ADVANCE — money we hold that we owe back
    // in goods or cash. It is a LIABILITY, not negative revenue.
    advanceKobo: balanceK < 0 ? -balanceK : 0,
    advance: balanceK < 0 ? fromKobo(-balanceK) : 0,
  };
}

/**
 * Ageing of one customer's outstanding entries.
 *
 * Payments are applied OLDEST-FIRST (FIFO), because that is both the
 * commercially standard convention and the one most favourable to the customer
 * — and applying them newest-first would let a shop make an old debt look
 * current while the genuinely new one ages. Any other rule must be a deliberate
 * client choice, recorded here rather than improvised at report time.
 */
function ageEntries(entries, { todayIso = new Date().toISOString().slice(0, 10), allocation = 'FIFO' }) {
  const open = (entries || [])
    .filter((e) => ['SALE', 'DEBIT_NOTE', 'INSTALLMENT_DUE', 'OPENING_BALANCE', 'FX_REVALUATION'].includes(String(e.entry_type || '').toUpperCase()))
    .map((e) => ({
      ...e,
      amountKobo: Math.abs(toKobo(e.amount || 0)),
      outstandingKobo: Math.abs(toKobo(e.amount || 0)),
      due: e.due_date ? String(e.due_date).slice(0, 10) : dueDate(String(e.entry_date).slice(0, 10), e.terms_code),
    }))
    .sort((a, b) => String(a.due || a.entry_date).localeCompare(String(b.due || b.entry_date)));

  // Total credits available to apply.
  let creditK = (entries || [])
    .filter((e) => ['PAYMENT', 'CREDIT_NOTE', 'BAD_DEBT', 'REVERSAL'].includes(String(e.entry_type || '').toUpperCase()))
    .reduce((a, e) => a + Math.abs(toKobo(e.amount || 0)), 0);

  if (String(allocation).toUpperCase() === 'SPECIFIC') {
    // Entries carry an explicit `applies_to_entry_id`; apply those first.
    const byTarget = new Map();
    for (const e of entries || []) {
      if (e.applies_to_entry_id) {
        byTarget.set(e.applies_to_entry_id, (byTarget.get(e.applies_to_entry_id) || 0) + Math.abs(toKobo(e.amount || 0)));
      }
    }
    for (const o of open) {
      const applied = byTarget.get(o.id) || 0;
      if (applied > 0) {
        o.outstandingKobo = Math.max(0, o.outstandingKobo - applied);
        creditK -= applied;
      }
    }
  }

  // Apply whatever credit remains, oldest-first.
  for (const o of open) {
    if (creditK <= 0) break;
    const apply = Math.min(creditK, o.outstandingKobo);
    o.outstandingKobo -= apply;
    creditK -= apply;
    o.appliedKobo = (o.appliedKobo || 0) + apply;
  }

  const buckets = AGEING_BUCKETS.map((b) => ({ ...b, kobo: 0, count: 0 }));
  const lines = [];
  for (const o of open) {
    if (o.outstandingKobo <= 0) continue;
    const days = daysBetween(o.due || o.entry_date, todayIso);
    const bucket = AGEING_BUCKETS.find((b) => days >= b.min && days <= b.max) || AGEING_BUCKETS[AGEING_BUCKETS.length - 1];
    const row = buckets.find((b) => b.code === bucket.code);
    row.kobo += o.outstandingKobo;
    row.count += 1;
    lines.push({
      entry_id: o.id, entry_type: o.entry_type, entry_date: String(o.entry_date).slice(0, 10),
      due_date: o.due, reference: o.reference || null,
      amount: fromKobo(o.amountKobo),
      applied: fromKobo(o.appliedKobo || 0),
      outstanding: fromKobo(o.outstandingKobo),
      outstanding_kobo: o.outstandingKobo,
      days_overdue: days,
      bucket: bucket.code, bucket_label: bucket.label,
    });
  }

  const totalK = buckets.reduce((a, b) => a + b.kobo, 0);
  return {
    asAt: todayIso,
    allocation,
    buckets: buckets.map((b) => ({
      code: b.code, label: b.label, count: b.count,
      amount: fromKobo(b.kobo), amount_kobo: b.kobo,
      percent: totalK > 0 ? round2((b.kobo / totalK) * 100) : 0,
    })),
    lines: lines.sort((a, b) => b.days_overdue - a.days_overdue),
    totalOutstanding: fromKobo(totalK),
    totalOutstandingKobo: totalK,
    maxDaysOverdue: lines.length ? lines[0].days_overdue : 0,
    unappliedCredit: fromKobo(Math.max(0, creditK)),
    unappliedCreditKobo: Math.max(0, creditK),
  };
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86400000);
}

/**
 * Apply a payment across a customer's open debts.
 *
 * Returns the per-entry allocation so each entry can be marked down and the
 * customer's statement shows exactly what the money settled. FIFO by default
 * (oldest first); `specific` lets a cashier say "this is for invoice 417".
 */
function applyPaymentToDebts({ payment, paymentKobo, openEntries, mode = 'FIFO', targetEntryId = null }) {
  const payK = paymentKobo != null ? Math.round(Number(paymentKobo)) : toKobo(payment);
  let remaining = Math.max(0, payK);
  if (remaining <= 0) {
    const err = new Error('Enter the amount received');
    err.status = 400; err.code = 'ZERO_PAYMENT';
    throw err;
  }

  let order = (openEntries || []).slice();
  if (String(mode).toUpperCase() === 'SPECIFIC' && targetEntryId) {
    order = order.slice().sort((a, b) => (
      (a.entry_id === targetEntryId || a.id === targetEntryId) ? -1 :
      (b.entry_id === targetEntryId || b.id === targetEntryId) ? 1 : 0
    ));
  } else {
    order.sort((a, b) => String(a.due_date || a.entry_date).localeCompare(String(b.due_date || b.entry_date)));
  }

  const allocations = [];
  for (const e of order) {
    if (remaining <= 0) break;
    const outstanding = e.outstanding_kobo != null ? Math.max(0, Math.round(e.outstanding_kobo)) :
      e.amount_kobo != null ? Math.max(0, Math.round(e.amount_kobo)) :
      Math.max(0, toKobo(e.outstanding != null ? e.outstanding : e.amount));
    if (outstanding <= 0) continue;
    const apply = Math.min(remaining, outstanding);
    remaining -= apply;
    allocations.push({
      entry_id: e.entry_id || e.id, reference: e.reference || null,
      entry_date: String(e.entry_date).slice(0, 10),
      due_date: e.due_date || null,
      applied_kobo: apply, applied: fromKobo(apply),
      settled_in_full: apply >= outstanding,
    });
  }

  const appliedK = payK - remaining;
  return {
    allocations,
    appliedKobo: appliedK, applied: fromKobo(appliedK),
    // Money received with nothing left to settle becomes a customer ADVANCE
    // (a liability), NOT extra revenue and NOT a silently dropped amount.
    unappliedKobo: remaining, unapplied: fromKobo(remaining),
    unappliedTreatment: remaining > 0 ? 'CUSTOMER_ADVANCE' : null,
    note: remaining > 0
      ? `${fromKobo(remaining)} could not be matched to any open debt. It will be held as a customer advance and offset against the next sale.`
      : null,
  };
}

/**
 * Chase schedule. A debt that nobody calls about is a debt that is never paid.
 * This produces the day-by-day action list for an overdue account so the
 * manager is not improvising a collections process.
 */
function chaseSchedule({ daysOverdue, amount, customer, policy = {} }) {
  const steps = [
    { atDays: 1,  channel: 'SMS',       message: `Friendly reminder: ${fromKobo(toKobo(amount))} was due on your account.` },
    { atDays: 7,  channel: 'PHONE_CALL', message: 'Call the customer. Record the promise-to-pay date and who spoke to them.' },
    { atDays: 14, channel: 'WHATSAPP_OR_EMAIL', message: 'Send a statement of account showing the aged balance.' },
    { atDays: 30, channel: 'FORMAL_LETTER', message: 'Issue a formal demand letter. Suspend further credit on the account.' },
    { atDays: 60, channel: 'MANAGER_VISIT', message: 'Owner or manager visits, or a written repayment proposal is required.' },
    { atDays: 90, channel: 'LEGAL_REVIEW', message: 'Review for small-claims court or a debt-recovery agent. Consider provisioning for bad debt.' },
  ];
  const d = Math.max(0, Math.floor(Number(daysOverdue) || 0));
  const due = steps.filter((s) => d >= s.atDays);
  const next = steps.find((s) => d < s.atDays);
  return {
    daysOverdue: d,
    amount: fromKobo(toKobo(amount)),
    customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone } : null,
    completed: due,
    nextAction: next ? { ...next, inDays: next.atDays - d } : null,
    escalated: d >= (policy.escalate_after_days || 30),
    suspendCredit: d >= (policy.suspend_after_days || 30),
    provisionForBadDebt: d >= (policy.bad_debt_after_days || 180),
  };
}

/**
 * Bad-debt provision by ageing bucket.
 *
 * Expected-loss percentages are client settings with these defaults, which are
 * the conventional retail provisioning rates:
 *   1-30 days 0%, 31-60 5%, 61-90 15%, 91-180 40%, 180+ 80%.
 * Provisioning is what makes the P&L honest: an unprovided 180-day debt is
 * profit that will never arrive.
 */
const DEFAULT_PROVISION_PERCENT = Object.freeze({
  CURRENT: 0, D1_30: 0, D31_60: 5, D61_90: 15, D91_180: 40, D180_PLUS: 80,
});

function provisionForAgeing(ageing, percents = DEFAULT_PROVISION_PERCENT) {
  const rows = (ageing.buckets || []).map((b) => {
    const pct = Number(percents[b.code] != null ? percents[b.code] : 0);
    const k = Math.round((b.amount_kobo * pct) / 100);
    return { bucket: b.code, label: b.label, amount: b.amount, amount_kobo: b.amount_kobo, percent: pct, provision_kobo: k, provision: fromKobo(k) };
  });
  const totalK = rows.reduce((a, r) => a + r.provision_kobo, 0);
  return { rows, totalProvisionKobo: totalK, totalProvision: fromKobo(totalK) };
}

/**
 * CHANGE OWED — kept from PharmaRidge because it solved a genuinely Nigerian
 * problem and generalises perfectly.
 *
 * A customer pays with ₦10,000 for a ₦9,750 purchase and the drawer has no
 * ₦250. The options are: refuse the note (lose the sale), or take it and owe
 * the customer ₦250. Shops do the second, all day, every day — and without a
 * record it becomes "I don't think I owe you anything."
 *
 * The record carries a CLAIM CODE the customer can quote at ANY branch, so the
// change can be collected on the next visit to a different shop. It is a
// liability until collected, it ages, and it shows on the till report so the
// drawer reconciles (the ₦10,000 is in the drawer; the ₦250 is owed out).
 */
function recordChangeOwed({ saleId, branchId, customerId, customerName, customerPhone, amount, reason, todayIso = new Date().toISOString().slice(0, 10) }) {
  const k = toKobo(amount);
  if (k <= 0) {
    const err = new Error('Change owed must be greater than zero');
    err.status = 400; err.code = 'INVALID_CHANGE_OWED';
    throw err;
  }
  if (!customerName && !customerId && !customerPhone) {
    // Without SOME identifier the customer can never claim it and the
    // liability sits forever. Refuse rather than create an unclaimable debt.
    const err = new Error('Record at least a name or a phone number, otherwise the customer cannot claim this back.');
    err.status = 400; err.code = 'CHANGE_OWED_NEEDS_IDENTITY';
    throw err;
  }
  return {
    sale_id: saleId || null,
    branch_id: branchId,
    customer_id: customerId || null,
    customer_name: customerName || null,
    customer_phone: customerPhone || null,
    amount_kobo: k,
    amount: fromKobo(k),
    reason: reason || 'NO_CHANGE_IN_DRAWER',
    status: 'OUTSTANDING',
    created_on: todayIso,
    // Unclaimed change is written back to income after this many days — but
    // only with a manager's action, never automatically. Silent write-back is
    // how a drawer shortage becomes someone's profit.
    review_after_days: 90,
    glTreatment: { account: 'CHANGE_OWED_LIABILITY', amount_kobo: k },
  };
}

/**
 * Branch safe ledger. The safe is the branch's cash reserve: float in the
 * morning, takings swept into it through the day, banked periodically.
 *
 * Every movement is typed and signed so the safe balance is DERIVED, exactly
 * like the debtor ledger. A safe whose balance is typed in rather than
 * computed is a safe nobody can prove.
 */
const SAFE_MOVEMENT_TYPES = Object.freeze([
  'FLOAT_IN',        // opening float placed in the safe
  'TILL_SWEEP',      // cash moved from a till into the safe
  'BANK_DEPOSIT',    // cash taken out to the bank
  'PURCHASE',        // paid out for a business expense
  'CHANGE_GIVEN',    // paid out to settle change owed
  'REFUND',          // paid out to a customer
  'TRANSFER_IN',     // cash received from another branch
  'TRANSFER_OUT',    // cash sent to another branch
  'COUNT_CORRECTION',// a stocktake-style recount adjusting the safe
]);

function safeBalance(movements) {
  let k = 0;
  for (const m of movements || []) {
    const amt = Math.abs(toKobo(m.amount || 0));
    const dir = String(m.direction || '').toUpperCase();
    if (dir === 'IN') k += amt;
    else if (dir === 'OUT') k -= amt;
    else {
      const inflow = ['FLOAT_IN', 'TILL_SWEEP', 'TRANSFER_IN'].includes(String(m.movement_type).toUpperCase());
      k += inflow ? amt : -amt;
    }
  }
  return {
    balanceKobo: k, balance: fromKobo(k),
    negative: k < 0,
    warning: k < 0 ? 'The safe is showing a negative balance — a movement was recorded in the wrong direction.' : null,
  };
}

module.exports = {
  TERMS_CODES, ENTRY_TYPES, AGEING_BUCKETS, SAFE_MOVEMENT_TYPES,
  DEFAULT_PROVISION_PERCENT,
  termsDays, dueDate, addDays, daysBetween,
  assessCreditRequest, deriveBalance, ageEntries, applyPaymentToDebts,
  chaseSchedule, provisionForAgeing, recordChangeOwed, safeBalance,
  allocateKobo,
};
