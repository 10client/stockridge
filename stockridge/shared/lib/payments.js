// =====================================================================
// shared/lib/payments.js — TENDER TYPES, SPLIT PAYMENTS, CHANGE & RECON
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: sale_payments carried method + cash_tendered +
// change_given, and `change_owed` handled the case where the till could not
// make change. Both are kept (they solved real problems) and the tender
// vocabulary is rebuilt for general Nigerian retail, which is materially more
// diverse than a pharmacy counter:
//
//   CASH               naira notes and coins
//   POS_TERMINAL       a bank POS machine (the dominant non-cash method in
//                      Nigerian retail; settlement lands T+1 and the shop pays
//                      an MDR, so the FEE and the EXPECTED SETTLEMENT DATE are
//                      recorded, not just the amount)
//   BANK_TRANSFER      instant transfer, confirmed by alert or by the
//                      merchant app. Needs a REFERENCE to reconcile.
//   MOBILE_MONEY       MTN MoMo, OPay, PalmPay, Kuda, Moniepoint — recorded
//                      with the wallet and a reference
//   USSD               *737#-style; reference required
//   CREDIT             sold on account to a known customer -> debtor_ledger
//   INSTALLMENT_PART   a scheduled instalment against an existing plan
//   LAYAWAY_DEPOSIT    money taken against a held item, not yet a sale
//   VOUCHER            a store voucher/gift card redemption
//   FX_CASH            foreign currency at an agreed rate (common in
//                      electronics and building materials, where the customer
//                      may pay USD)
//
// WHY THE FEE AND SETTLEMENT DATE ARE FIRST-CLASS:
// A shop that records "₦500,000 POS" and nothing else will reconcile its bank
// statement at ₦492,500 and have no idea why. The MDR (typically 1.5% capped
// at ₦2,000 per transaction under the CBN cashless policy, though merchants
// report higher effective charges) plus the T+1 settlement gap is the single
// most common source of "the till balanced but the bank did not". StockRidge
// records fee and expected_settlement_at on every non-cash tender so the till
// report, the bank reconciliation and the GL all agree.

'use strict';

const { round2, toKobo, fromKobo, allocateKobo } = require('./money');
const V = require('./validate');

const TENDER_METHODS = Object.freeze([
  { code: 'CASH',             label: 'Cash',                 needsReference: false, settlesImmediately: true,  feeBearing: false },
  { code: 'POS_TERMINAL',     label: 'POS terminal',         needsReference: true,  settlesImmediately: false, feeBearing: true },
  { code: 'BANK_TRANSFER',    label: 'Bank transfer',        needsReference: true,  settlesImmediately: true,  feeBearing: false },
  { code: 'MOBILE_MONEY',     label: 'Mobile money / wallet', needsReference: true, settlesImmediately: true,  feeBearing: true },
  { code: 'USSD',             label: 'USSD',                 needsReference: true,  settlesImmediately: true,  feeBearing: false },
  { code: 'CREDIT',           label: 'Credit (on account)',  needsReference: false, settlesImmediately: false, feeBearing: false },
  { code: 'INSTALLMENT_PART', label: 'Instalment payment',   needsReference: false, settlesImmediately: false, feeBearing: false },
  { code: 'LAYAWAY_DEPOSIT',  label: 'Layaway deposit',      needsReference: false, settlesImmediately: false, feeBearing: false },
  { code: 'VOUCHER',          label: 'Voucher / gift card',  needsReference: true,  settlesImmediately: true,  feeBearing: false },
  { code: 'FX_CASH',          label: 'Foreign currency',     needsReference: false, settlesImmediately: true,  feeBearing: false },
]);
const TENDER_CODES = new Set(TENDER_METHODS.map((m) => m.code));

function tenderInfo(code) {
  return TENDER_METHODS.find((m) => m.code === String(code || '').toUpperCase()) || null;
}

function isTender(code) { return TENDER_CODES.has(String(code || '').toUpperCase()); }

const WALLETS = Object.freeze(['MTN_MOMO', 'OPAY', 'PALMPAY', 'KUDA', 'MONIEPOINT', 'GTCREDIT', 'OTHER']);

/**
 * Validate a set of tenders against an amount due.
 *
 * Rules, in the order a cashier needs to hear them:
 *   1. Every method must be known.
 *   2. A method that needs a reference must have one (a transfer with no
 *      reference cannot be reconciled, which is how a shop "loses" money it
 *      actually received).
 *   3. Total tendered must be >= amount due, unless part of the balance is
 *      explicitly going to CREDIT / an instalment plan / layaway.
 *   4. Change is computed in KOBO and allocated across the cash tenders, not
 *      computed by subtraction of floats.
 *   5. Only ONE tender may be the change-bearing one in practice (cash), but
 *      the code allows over-payment on any tender and returns change against
 *      the LAST cash tender, matching how a till actually behaves.
 */
function validateTenders({ tenders, amountDue, allowShort, customerId, creditLimitKobo = null }) {
  const list = (tenders || []).map((t, i) => {
    const method = String(t.method || '').toUpperCase();
    const info = tenderInfo(method);
    if (!info) {
      V.fail(`Unknown payment method "${t.method}" on tender ${i + 1}. Use one of: ${[...TENDER_CODES].join(', ')}`,
        'UNKNOWN_TENDER', `tenders[${i}].method`);
    }
    const amount = V.money(t.amount, { field: `tenders[${i}].amount`, allowNegative: false });
    if (toKobo(amount) <= 0) {
      V.fail(`Tender ${i + 1} amount must be greater than zero`, 'ZERO_TENDER', `tenders[${i}].amount`);
    }
    const reference = info.needsReference
      ? (() => {
          if (!t.reference || !String(t.reference).trim()) {
            V.fail('Enter the reference from the transfer alert, POS receipt or wallet confirmation', 'VALIDATION_ERROR', `tenders[${i}].reference`);
          }
          return V.str(t.reference, { field: `tenders[${i}].reference`, max: 120 });
        })()
      : V.optionalStr(t.reference, { field: `tenders[${i}].reference`, max: 120 });

    return {
      method, info, amount, amountKobo: toKobo(amount), reference,
      wallet: V.optionalStr(t.wallet, { field: `tenders[${i}].wallet`, max: 32 }),
      fee: V.optionalNum(t.fee, { field: `tenders[${i}].fee`, min: 0 }),
      expected_settlement_date: V.optionalIsoDate(t.expected_settlement_date, { field: `tenders[${i}].expected_settlement_date` }),
      fx_rate: V.optionalNum(t.fx_rate, { field: `tenders[${i}].fx_rate`, min: 0 }),
      foreign_amount: V.optionalNum(t.foreign_amount, { field: `tenders[${i}].foreign_amount`, min: 0 }),
      cash_tendered: V.optionalNum(t.cash_tendered, { field: `tenders[${i}].cash_tendered`, min: 0 }),
    };
  });

  if (!list.length) V.fail('At least one payment method is required', 'NO_TENDERS', 'tenders');

  const dueKobo = toKobo(amountDue);
  const totalKobo = list.reduce((a, t) => a + t.amountKobo, 0);

  // Credit-bearing tenders reduce what must be covered now.
  const deferred = list.filter((t) => ['CREDIT', 'INSTALLMENT_PART', 'LAYAWAY_DEPOSIT'].includes(t.method));
  const deferredKobo = deferred.reduce((a, t) => a + t.amountKobo, 0);

  const creditTender = list.find((t) => t.method === 'CREDIT');
  if (creditTender) {
    if (!customerId) {
      V.fail('A credit sale must be against a named customer', 'CREDIT_NEEDS_CUSTOMER', 'customer_id');
    }
    if (creditLimitKobo != null && creditTender.amountKobo > creditLimitKobo) {
      const err = new Error(`This would put the customer over their credit limit of ${fromKobo(creditLimitKobo)}.`);
      err.status = 409; err.code = 'CREDIT_LIMIT_EXCEEDED';
      throw err;
    }
  }

  const settledNowKobo = totalKobo - deferredKobo;
  const balanceKobo = dueKobo - totalKobo;

  if (balanceKobo > 0 && !allowShort) {
    const err = new Error(`Payment is short by ${fromKobo(balanceKobo)}. Take the rest, or record the balance as credit or an instalment plan.`);
    err.status = 400; err.code = 'PAYMENT_SHORT';
    throw err;
  }

  // CHANGE. Over-payment is normal (a customer hands over ₦50,000 for a
  // ₦47,350 purchase). Change is given back in CASH from the till regardless
  // of how the customer paid — you cannot give change onto a POS terminal.
  let changeKobo = 0;
  if (balanceKobo < 0) {
    changeKobo = -balanceKobo;
    const hasCashTender = list.some((t) => t.method === 'CASH');
    if (!hasCashTender && deferredKobo === 0) {
      // Over-paid entirely by a non-cash method: the shop owes the customer a
      // refund it cannot make from the till. That becomes CHANGE_OWED.
      return finish({ list, dueKobo, totalKobo, settledNowKobo, deferredKobo, changeKobo, changeRoute: 'CHANGE_OWED', customerId });
    }
    return finish({ list, dueKobo, totalKobo, settledNowKobo, deferredKobo, changeKobo, changeRoute: 'CASH_FROM_TILL', customerId });
  }

  return finish({ list, dueKobo, totalKobo, settledNowKobo, deferredKobo, changeKobo: 0, changeRoute: balanceKobo === 0 ? 'EXACT' : 'BALANCE_TO_CREDIT', customerId });
}

function finish({ list, dueKobo, totalKobo, settledNowKobo, deferredKobo, changeKobo, changeRoute, customerId }) {
  return {
    ok: true,
    tenders: list.map((t) => ({
      method: t.method,
      amount: t.amount,
      amount_kobo: t.amountKobo,
      reference: t.reference,
      wallet: t.wallet,
      fee: t.fee,
      expected_settlement_date: t.expected_settlement_date,
      fx_rate: t.fx_rate,
      foreign_amount: t.foreign_amount,
      cash_tendered: t.cash_tendered,
    })),
    amountDueKobo: dueKobo,
    amountDue: fromKobo(dueKobo),
    totalTenderedKobo: totalKobo,
    totalTendered: fromKobo(totalKobo),
    settledNowKobo, settledNow: fromKobo(settledNowKobo),
    deferredKobo, deferred: fromKobo(deferredKobo),
    changeKobo, change: fromKobo(changeKobo),
    changeRoute,
    customerId: customerId || null,
  };
}

/**
 * Default POS-terminal fee.
 *
 * CBN guidance has been 1.5% of transaction value capped at ₦2,000 for POS
 * charges. Merchants report higher effective costs once the acquirer's own
 * fees and the terminal rental are included, so the percentage and the cap are
 * CLIENT SETTINGS (settings → payment fees) with these as the seeded defaults.
 * The function never guesses silently: if the client has not configured fees,
 * it returns 0 and the caller flags "fee not configured" so the reconciliation
 * gap is visible rather than assumed away.
 */
function posFee({ amount, percent = 1.5, cap = 2000, configured = true }) {
  if (!configured) return { fee: 0, configured: false, note: 'POS fee not configured — the bank settlement will differ from the till.' };
  const k = toKobo(amount);
  const pctK = Math.round((k * (Number(percent) || 0)) / 100);
  const capK = toKobo(cap == null ? Infinity : cap);
  const feeK = Math.min(pctK, Number.isFinite(capK) ? capK : pctK);
  return { fee: fromKobo(feeK), feeKobo: feeK, configured: true };
}

/**
 * Expected settlement date for a card/POS tender.
 * Nigerian acquirers settle T+1 on business days; a Friday sale settles
 * Monday. Public holidays are client-configurable (holidays table) and passed
 * in, because hard-coding them would be wrong within a year.
 */
function expectedSettlement(dateIso, { businessDays = 1, holidays = [] } = {}) {
  const d = new Date(Date.parse(`${String(dateIso).slice(0, 10)}T00:00:00Z`));
  if (Number.isNaN(d.getTime())) return null;
  const hol = new Set((holidays || []).map((h) => String(h).slice(0, 10)));
  let added = 0;
  while (added < businessDays) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !hol.has(iso)) added += 1;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Till reconciliation: expected vs counted, by method.
 *
 * This is the report that decides whether a cashier's shift is clean. The
 * classic failure it catches is not theft — it is a POS sale recorded as CASH,
 * which makes the drawer short by exactly the card amount and sends everyone
 * looking in the wrong place.
 */
function reconcileTill({ expectedByMethod, countedByMethod, safeMovements = [] }) {
  const methods = new Set([...Object.keys(expectedByMethod || {}), ...Object.keys(countedByMethod || {})]);
  const rows = [];
  let expectedK = 0; let countedK = 0; let varianceK = 0;

  for (const m of [...methods].sort()) {
    const eK = toKobo((expectedByMethod || {})[m] || 0);
    const hasCount = countedByMethod && Object.prototype.hasOwnProperty.call(countedByMethod, m);
    // Cash is the only method physically in the drawer; everything else is
    // verified against a settlement report, so it is not "counted".
    const cK = hasCount ? toKobo(countedByMethod[m] || 0) : (m === 'CASH' ? 0 : eK);
    const vK = cK - eK;
    expectedK += eK; countedK += cK;
    if (m === 'CASH' || hasCount) {
      varianceK += vK;
    }
    rows.push({
      method: m,
      label: (tenderInfo(m) || {}).label || m,
      expected: fromKobo(eK),
      counted: fromKobo(cK),
      variance: fromKobo(vK),
      variance_kobo: vK,
      status: vK === 0 ? 'BALANCED' : vK > 0 ? 'OVER' : 'SHORT',
      countsAsCash: m === 'CASH',
    });
  }

  const safeK = (safeMovements || []).reduce((a, s) => a + toKobo(Number(s.amount) || 0) * (String(s.direction) === 'OUT' ? -1 : 1), 0);

  return {
    rows,
    expectedTotal: fromKobo(expectedK),
    countedTotal: fromKobo(countedK),
    variance: fromKobo(varianceK),
    varianceKobo: varianceK,
    safeMovementsNet: fromKobo(safeK),
    // Drawer expectation = cash sales + float in - float out - safe withdrawals
    balanced: varianceK === 0,
    toleranceBreached: Math.abs(varianceK) > 0,
  };
}

/**
 * Voucher / gift-card validation. Vouchers are a real shrinkage vector: an
 * unbounded, unsigned voucher code is guessable. Codes are 12 chars from an
 * unambiguous alphabet, single-use, expiry-dated, and redeemed inside the same
 * transaction that records the sale.
 */
function voucherIsUsable(v, { now = new Date(), minimumKobo }) {
  const iso = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  if (!v) return { ok: false, code: 'VOUCHER_NOT_FOUND', message: 'That voucher code does not exist.' };
  if (String(v.status || '').toUpperCase() === 'REDEEMED') {
    return { ok: false, code: 'VOUCHER_ALREADY_REDEEMED', message: 'That voucher has already been used.' };
  }
  if (String(v.status || '').toUpperCase() === 'CANCELLED') {
    return { ok: false, code: 'VOUCHER_CANCELLED', message: 'That voucher has been cancelled.' };
  }
  if (v.expires_on && String(v.expires_on).slice(0, 10) < iso) {
    return { ok: false, code: 'VOUCHER_EXPIRED', message: `That voucher expired on ${String(v.expires_on).slice(0, 10)}.` };
  }
  const balK = toKobo(v.balance);
  if (minimumKobo != null && balK < minimumKobo) {
    return { ok: false, code: 'VOUCHER_BALANCE_TOO_LOW', message: `That voucher has ${fromKobo(balK)} left.` };
  }
  return { ok: true, balanceKobo: balK, balance: fromKobo(balK), code: v.code };
}

module.exports = {
  TENDER_METHODS, TENDER_CODES, WALLETS,
  tenderInfo, isTender, validateTenders, posFee, expectedSettlement,
  reconcileTill, voucherIsUsable, allocateKobo,
};
