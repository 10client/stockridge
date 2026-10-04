// =====================================================================
// shared/services/glService.js — CHART OF ACCOUNTS AND JOURNAL POSTING
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: gl_accounts, gl_journal_entries and
// gl_journal_lines were kept essentially as they were — double-entry posting is
// not pharmacy-specific — but the CHART was rebuilt for general retail, because
// a pharmacy's accounts do not describe a furniture shop's business.
//
// WHY A LEDGER AT ALL, WHEN THE OPERATIONAL TABLES ALREADY HAVE THE NUMBERS?
// Because a report derived from operational tables can be wrong in a way nobody
// can check. A trial balance that does not balance is wrong in a way ANYONE can
// see, immediately, without understanding the code. That property is the whole
// value: it converts "is our margin report right?" (unknowable) into "do the
// debits equal the credits?" (checkable in one query).
//
// ---------------------------------------------------------------------
// ACCOUNTS THE PHARMACY CHART DID NOT NEED
// ---------------------------------------------------------------------
//   2210 VAT PAYABLE / 1215 VAT RECOVERABLE   a VAT-registered retailer
//         collects output tax and reclaims input tax; the net is a liability or
//         an asset depending on the period. Without these two accounts the VAT
//         return has to be re-derived from sales and purchases every quarter.
//   1240 WHT RECEIVABLE / 2230 WHT PAYABLE    corporate customers deduct WHT
//         from what they pay us; we deduct it from what we pay suppliers. These
//         are two different balances moving in opposite directions and a single
//         "WHT" account cannot hold both.
//   1250 INSTALMENT RECEIVABLE                goods sold on a plan, delivered
//         on deposit: a real asset with a real ageing.
//   2260 LAYAWAY DEPOSIT LIABILITY            money taken against a held item.
//         NOT revenue — no goods have left. Recognising it as revenue overstates
//         turnover and creates a tax bill on money that may be refunded.
//   2270 CHANGE OWED                          cash the drawer could not make
//         change for. A liability until collected.
//   2280 WARRANTY PROVISION                   claims WILL arrive; accruing a
//         percentage of warrantied revenue stops one month looking catastrophic
//         and the rest looking artificially profitable.
//   2290 CUSTOMER ADVANCES                    over-payments and unallocated
//         receipts. Money we hold that we owe back in goods or cash.
//   2295 DELIVERY FEE PAYABLE (to drivers)    third-party delivery.
//   1350 FX REVALUATION / 7900 FX GAIN-LOSS   stock bought at ₦1,200/$ and sold
//         after the naira moved to ₦1,500/$ has a replacement cost the books do
//         not show. This is a real P&L line in an importing business, not a
//         rounding difference.
//   5450 SHRINKAGE AND DAMAGE                 separate from COGS on purpose:
//         shrinkage is the number an owner most needs to see on its own.
//   4300 DELIVERY AND INSTALLATION REVENUE    service income, distinct from
//         goods income, because the margins and the tax treatment differ.
//   4400 OTHER INCOME (forfeited deposits)    a forfeited layaway deposit is
//         income with no matching cost. Booking it as SALES revenue would
//         overstate turnover and understate margin.
//
// Every account is seeded with `is_system = 1` so it cannot be renamed or
// deleted by a client who then wonders why their trial balance stopped
// balancing. Clients may ADD accounts; they may not remove the ones the posting
// logic depends on.

'use strict';

const { newId } = require('../lib/ids');
const M = require('../lib/money');
const { todayWat } = require('../lib/timegeo');
const core = require('./coreService');

// ---------------------------------------------------------------------
// CHART OF ACCOUNTS
// ---------------------------------------------------------------------
// code | name | type | sub_type | normal balance | vat treatment
const SYSTEM_CHART = Object.freeze([
  // ---- 1000s ASSETS ----
  ['1000', 'Cash on hand',            'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1010', 'Branch safes',            'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1020', 'Petty cash',              'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1030', 'Cash at bank',            'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1040', 'POS terminal receivable', 'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],   // card money in transit, T+1
  ['1050', 'Mobile money receivable', 'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1060', 'Foreign currency held',   'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1100', 'Accounts receivable',     'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1200', 'Inventory',               'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1210', 'Goods in transit',        'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],   // dispatched, not yet received
  ['1215', 'Input VAT recoverable',   'ASSET',     'CURRENT_ASSET',  'DEBIT',  'INPUT_VAT'],
  ['1220', 'Stock with third parties','ASSET',     'CURRENT_ASSET',  'DEBIT',  null],   // at a service agent
  ['1240', 'WHT receivable',          'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1250', 'Instalment receivable',   'ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1300', 'Prepayments and deposits','ASSET',     'CURRENT_ASSET',  'DEBIT',  null],
  ['1500', 'Shop fittings and fixtures','ASSET',   'FIXED_ASSET',    'DEBIT',  null],
  ['1510', 'Delivery vehicles',       'ASSET',     'FIXED_ASSET',    'DEBIT',  null],
  ['1520', 'Equipment and tools',     'ASSET',     'FIXED_ASSET',    'DEBIT',  null],
  ['1590', 'Accumulated depreciation','ASSET',     'FIXED_ASSET',    'CREDIT', null],

  // ---- 2000s LIABILITIES ----
  ['2000', 'Accounts payable',        'LIABILITY', 'CURRENT_LIABILITY','CREDIT', null],
  ['2100', 'Accrued expenses',        'LIABILITY', 'CURRENT_LIABILITY','CREDIT', null],
  ['2200', 'Payroll and staff payable','LIABILITY','CURRENT_LIABILITY','CREDIT', null],
  ['2210', 'Output VAT payable',      'LIABILITY', 'CURRENT_LIABILITY','CREDIT', 'OUTPUT_VAT'],
  ['2230', 'WHT payable',             'LIABILITY', 'CURRENT_LIABILITY','CREDIT', null],
  ['2260', 'Layaway deposits held',   'LIABILITY', 'CURRENT_LIABILITY','CREDIT', null],
  ['2270', 'Change owed to customers','LIABILITY', 'CURRENT_LIABILITY','CREDIT', null],
  ['2280', 'Warranty provision',      'LIABILITY', 'CURRENT_LIABILITY','CREDIT', null],
  ['2290', 'Customer advances',       'LIABILITY', 'CURRENT_LIABILITY','CREDIT', null],
  ['2295', 'Delivery fees payable',   'LIABILITY', 'CURRENT_LIABILITY','CREDIT', null],
  ['2300', 'Vouchers and gift cards issued','LIABILITY','CURRENT_LIABILITY','CREDIT', null],
  ['2500', 'Loans and instalment funding','LIABILITY','LONG_TERM_LIABILITY','CREDIT', null],

  // ---- 3000s EQUITY ----
  ['3000', "Owner's capital",         'EQUITY',    'EQUITY',          'CREDIT', null],
  ['3100', "Owner's drawings",        'EQUITY',    'EQUITY',          'DEBIT',  null],
  ['3900', 'Retained earnings',       'EQUITY',    'EQUITY',          'CREDIT', null],

  // ---- 4000s REVENUE ----
  ['4000', 'Sales revenue',           'REVENUE',   'REVENUE',         'CREDIT', 'OUT_OF_SCOPE'],
  ['4100', 'Wholesale revenue',       'REVENUE',   'REVENUE',         'CREDIT', 'OUT_OF_SCOPE'],
  ['4200', 'Sales returns and allowances','REVENUE','REVENUE',        'DEBIT',  'OUT_OF_SCOPE'],
  ['4300', 'Delivery and installation revenue','REVENUE','SERVICE_REVENUE','CREDIT','OUT_OF_SCOPE'],
  ['4400', 'Other income',            'REVENUE',   'OTHER_REVENUE',   'CREDIT', null],   // forfeited deposits etc.
  ['4500', 'Discounts allowed',       'REVENUE',   'REVENUE',         'DEBIT',  null],

  // ---- 5000s COST OF SALES ----
  ['5000', 'Cost of goods sold',      'EXPENSE',   'COGS',            'DEBIT',  null],
  ['5100', 'Freight and carriage in', 'EXPENSE',   'COGS',            'DEBIT',  null],
  ['5200', 'Purchase returns',        'EXPENSE',   'COGS',            'CREDIT', null],
  ['5400', 'Delivery and installation cost','EXPENSE','COGS',         'DEBIT',  null],
  ['5450', 'Shrinkage and damage',    'EXPENSE',   'COGS',            'DEBIT',  null],
  ['5460', 'Warranty claims expense', 'EXPENSE',   'COGS',            'DEBIT',  null],
  ['5470', 'Stock write-offs',        'EXPENSE',   'COGS',            'DEBIT',  null],

  // ---- 6000s OPERATING EXPENSES ----
  ['6000', 'Rent and rates',          'EXPENSE',   'OPEX',            'DEBIT',  null],
  ['6010', 'Utilities',               'EXPENSE',   'OPEX',            'DEBIT',  null],
  ['6020', 'Salaries and wages',      'EXPENSE',   'OPEX',            'DEBIT',  null],
  ['6030', 'Fuel and vehicle running','EXPENSE',   'OPEX',            'DEBIT',  null],
  ['6040', 'Marketing and advertising','EXPENSE',  'OPEX',            'DEBIT',  null],
  ['6050', 'Repairs and maintenance', 'EXPENSE',   'OPEX',            'DEBIT',  null],
  ['6060', 'Security',                'EXPENSE',   'OPEX',            'DEBIT',  null],
  ['6070', 'Insurance',               'EXPENSE',   'OPEX',            'DEBIT',  null],
  ['6080', 'Professional and legal fees','EXPENSE','OPEX',            'DEBIT',  null],
  ['6090', 'Bank and POS charges',    'EXPENSE',   'OPEX',            'DEBIT',  null],   // the MDR
  ['6100', 'Bad debts',               'EXPENSE',   'OPEX',            'DEBIT',  null],
  ['6110', 'Depreciation',            'EXPENSE',   'OPEX',            'DEBIT',  null],
  ['6900', 'Sundry expenses',         'EXPENSE',   'OPEX',            'DEBIT',  null],

  // ---- 7000s OTHER ----
  ['7900', 'Foreign exchange gain/loss','EXPENSE', 'OTHER',           'DEBIT',  null],
  ['8000', 'Income tax expense',      'EXPENSE',   'TAX',             'DEBIT',  null],
]);

const ACCOUNT_BY_CODE = Object.freeze(Object.fromEntries(SYSTEM_CHART.map((a) => [a[0], {
  code: a[0], name: a[1], account_type: a[2], sub_type: a[3], normal_balance: a[4], vat_treatment: a[5],
}])));

/**
 * Seed the chart for a business. Idempotent: existing codes are left alone, so
 * re-running a seed never overwrites a client's rename of a non-system account.
 */
async function seedChart(db, businessId, { includeSystem = true } = {}) {
  const existing = await db.prepare(
    'SELECT code FROM gl_accounts WHERE (business_id = ? OR business_id IS NULL) AND is_deleted = 0'
  ).bind(String(businessId)).all();
  const have = new Set(existing.map((r) => r.code));
  const rows = SYSTEM_CHART.filter(([code]) => !have.has(code));
  if (!rows.length) return { created: 0 };

  let order = 0;
  await db.transaction(async (tx) => {
    for (const [code, name, type, sub, normal, vat] of rows) {
      order += 1;
      tx.prepare(`
        INSERT INTO gl_accounts
          (id, business_id, code, name, account_type, sub_type, normal_balance, is_system, is_active,
           vat_treatment, sort_order, created_at, updated_at)
        VALUES (?,?, ?,?,?,?, ?, 1, 1, ?, ?, datetime('now'), datetime('now'))
      `).bind(
        newId(), includeSystem ? null : String(businessId),
        code, name, type, sub, normal, vat, order
      ).run();
    }
  });
  return { created: rows.length };
}

/** Resolve an account id by code, for a business (falling back to system). */
async function accountId(db, code, businessId) {
  const row = await db.prepare(`
    SELECT id FROM gl_accounts
     WHERE code = ? AND is_deleted = 0 AND (business_id = ? OR business_id IS NULL)
     ORDER BY (business_id IS NULL) LIMIT 1
  `).bind(String(code), String(businessId || '__none__')).first();
  if (!row) {
    // A missing account is a configuration error, not something to paper over:
    // posting to the wrong account produces a trial balance that balances and
    // says nothing true.
    const err = new Error(`Chart of accounts is missing ${code}. Re-run the chart seed.`);
    err.status = 500; err.code = 'GL_ACCOUNT_MISSING';
    throw err;
  }
  return row.id;
}

async function accountMap(db, businessId) {
  const rows = await db.prepare(`
    SELECT id, code, name FROM gl_accounts
     WHERE is_deleted = 0 AND is_active = 1 AND (business_id = ? OR business_id IS NULL)
  `).bind(String(businessId || '__none__')).all();
  const map = {};
  for (const r of rows) if (!map[r.code]) map[r.code] = r;   // business-specific wins
  return map;
}

function periodOf(dateIso) { return String(dateIso).slice(0, 7); }

// ---------------------------------------------------------------------
// JOURNAL WRITING
// ---------------------------------------------------------------------
/**
 * Write one balanced journal entry. THE ONLY WAY an entry is created.
 *
 * Lines are given as { code, direction, amountKobo, ... }. The entry's totals
 * are computed from the lines and the balance is ASSERTED before the write, so
 * an unbalanced entry cannot reach the database even if the CHECK constraint
// were somehow absent.
 */
async function postEntry(db, { business, branchId = null, entryDate, sourceType, sourceId, reference, description, lines, currency = 'NGN', fxRate = 1, userId = null, status = 'POSTED' }) {
  const clean = (lines || [])
    .map((l) => ({
      ...l,
      amountKobo: Math.round(Number(l.amountKobo) || 0),
      direction: String(l.direction || '').toUpperCase(),
    }))
    .filter((l) => l.amountKobo !== 0);      // a zero line is noise, not an entry

  if (!clean.length) {
    const err = new Error('A journal entry needs at least one non-zero line.');
    err.status = 400; err.code = 'GL_EMPTY_ENTRY';
    throw err;
  }

  const debitK = clean.filter((l) => l.direction === 'DEBIT').reduce((a, l) => a + l.amountKobo, 0);
  const creditK = clean.filter((l) => l.direction === 'CREDIT').reduce((a, l) => a + l.amountKobo, 0);

  if (debitK !== creditK) {
    // This is the failure the whole ledger exists to make visible, so it is
    // raised loudly with the actual numbers rather than a generic message.
    const err = new Error(
      `Unbalanced journal entry for ${description || sourceType}: debits ${M.fromKobo(debitK)} vs credits ${M.fromKobo(creditK)} `
      + `(difference ${M.fromKobo(Math.abs(debitK - creditK))}). The entry was not posted.`
    );
    err.status = 500; err.code = 'GL_UNBALANCED';
    err.details = { debitK, creditK, lines: clean };
    throw err;
  }

  const accounts = await accountMap(db, business.id);
  const entryId = newId();
  const date = String(entryDate || todayWat()).slice(0, 10);

  // Sequence the entry number per business per period, so a ledger prints in
  // order and a missing number is visible.
  const seqRow = await db.prepare(`
    SELECT COUNT(*) AS c FROM gl_journal_entries
     WHERE business_id = ? AND period = ? AND is_deleted = 0
  `).bind(String(business.id), periodOf(date)).first();
  const seq = String((Number(seqRow ? seqRow.c : 0) + 1)).padStart(5, '0');
  const entryNumber = `JE-${periodOf(date).replace('-', '')}-${seq}`;

  await db.prepare(`
    INSERT INTO gl_journal_entries
      (id, business_id, branch_id, entry_number, entry_date, period, status, source_type, source_id,
       reference, description, total_debit_kobo, total_credit_kobo, currency, fx_rate,
       posted_by, posted_at, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), ?, datetime('now'), datetime('now'))
  `).bind(
    entryId, String(business.id), branchId ? String(branchId) : null,
    entryNumber, date, periodOf(date), status, String(sourceType), sourceId ? String(sourceId) : null,
    reference || null, String(description || '').slice(0, 500),
    debitK, creditK, currency, fxRate,
    userId ? String(userId) : null, userId ? String(userId) : null
  ).run();

  for (const l of clean) {
    const acct = accounts[l.code];
    if (!acct) {
      const err = new Error(`Chart of accounts is missing ${l.code}. Re-run the chart seed.`);
      err.status = 500; err.code = 'GL_ACCOUNT_MISSING';
      throw err;
    }
    await db.prepare(`
      INSERT INTO gl_journal_lines
        (id, journal_entry_id, account_id, account_code, account_name, direction, amount_kobo, amount,
         branch_id, category_id, category_code, description, reference, vat_kobo, wht_kobo, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    `).bind(
      newId(), entryId, acct.id, acct.code, acct.name, l.direction, l.amountKobo, M.fromKobo(l.amountKobo),
      l.branchId ? String(l.branchId) : (branchId ? String(branchId) : null),
      l.categoryId || null, l.categoryCode || null,
      l.description || null, l.reference || null,
      Math.round(Number(l.vatKobo) || 0), Math.round(Number(l.whtKobo) || 0)
    ).run();
  }

  return { id: entryId, entry_number: entryNumber, debit_kobo: debitK, credit_kobo: creditK, lines: clean.length };
}

// ---------------------------------------------------------------------
// POSTING RULES  (one function per business event)
// ---------------------------------------------------------------------
// Each of these encodes the double-entry for one event. They are separate
// functions rather than one switch because the accounts involved differ enough
// that a shared code path would need so many conditionals that a mistake in one
// event would silently affect another.

/**
 * A SALE. The full posting:
 *
 *   DR  cash / card receivable / mobile money   (what was actually taken)
 *   DR  accounts receivable                     (what is still owed)
 *   DR  cost of goods sold                      (the cost of the units picked)
 *   CR  sales revenue                           (net of VAT and of discounts)
 *   CR  output VAT payable                      (the VAT inside the price)
 *   CR  inventory                               (the units leaving)
 *   CR  change owed                             (change the drawer could not give)
 *
 * Revenue is recognised NET OF VAT because the VAT is not the shop's money —
 * it is collected on behalf of FIRS and is a liability from the moment of sale.
 * A retailer that books the gross as revenue overstates turnover by 7.5% and
 * then cannot produce a VAT return from its own ledger.
 *
 * Discounts reduce revenue rather than being booked as an expense: the sale
 * price was the discounted price, and calling the difference an expense would
 * make the discount look like a cost of doing business rather than a reduction
 * in what was charged.
 */
async function postSaleJournal(db, { business, branch, saleId, saleNumber, saleDate, scope, totals, tenders, customer, lines }) {
  const glLines = [];

  // ---- what came in, by tender ----------------------------------------
  for (const t of tenders || []) {
    const accountFor = {
      CASH: '1000',
      POS_TERMINAL: '1040',        // not cash yet: T+1 settlement, and the MDR
      BANK_TRANSFER: '1030',
      MOBILE_MONEY: '1050',
      USSD: '1030',
      VOUCHER: '2300',             // redeems a liability already recognised
      FX_CASH: '1060',
      CREDIT: '1100',
      INSTALLMENT_PART: '1250',
      LAYAWAY_DEPOSIT: '2260',
    }[t.method] || '1000';
    glLines.push({ code: accountFor, direction: 'DEBIT', amountKobo: t.amount_kobo, description: `Tender ${t.method}` });

    // A fee-bearing tender's fee is a cost, booked now rather than discovered
    // at bank reconciliation. The receivable is the NET of the fee, because
    // that is what will actually land.
    if (t.fee_kobo > 0 && ['POS_TERMINAL', 'MOBILE_MONEY'].includes(t.method)) {
      // The receivable was booked gross above; split the fee out.
      glLines.push({ code: '6090', direction: 'DEBIT', amountKobo: t.fee_kobo, description: `${t.method} charge` });
      glLines.push({ code: accountFor, direction: 'CREDIT', amountKobo: t.fee_kobo, description: `${t.method} charge deducted` });
    }
  }

  // ---- what is still owed (not already recorded in tenders) ------------
  const deferredTenderKobo = (tenders || [])
    .filter((t) => ['CREDIT', 'INSTALLMENT_PART', 'LAYAWAY_DEPOSIT'].includes(t.method))
    .reduce((a, t) => a + (Number(t.amount_kobo) || 0), 0);
  const unrecordedBalanceKobo = Math.max(0, (totals.balanceKobo || 0) - deferredTenderKobo);
  if (unrecordedBalanceKobo > 0) {
    glLines.push({ code: '1100', direction: 'DEBIT', amountKobo: unrecordedBalanceKobo, description: `Balance due from ${customer ? customer.name : 'customer'}` });
  }

  // ---- change the drawer could not give ----------------------------------
  // (already excluded from `paid`; it is a liability, not a payment)

  // ---- revenue, net of VAT, with the discount shown separately --------------
  // `totals.netOfVatKobo` is ALREADY net of the discount (salesService derives
  // it from subtotal - discount). So gross ex-VAT revenue is netOfVat + discount.
  //
  // Posting gross to revenue and the discount to a contra-revenue account keeps
  // BOTH figures visible: an owner can see what discounting cost them, which is
  // impossible once the discount is netted into a single revenue line. It also
  // avoids the classic error of subtracting the discount twice — an earlier draft
  // of this function did exactly that, understating revenue by the discount a
  // second time while still balancing, so nothing on the trial balance revealed
  // it. A balanced ledger is not the same as a correct one, which is why the
  // derivation is written out here rather than left implicit.
  const discountKobo = Math.max(0, totals.discountKobo || 0);
  const grossRevenueKobo = Math.max(0, totals.netOfVatKobo + discountKobo);
  const revenueAccount = (customer && ['WHOLESALE', 'DISTRIBUTOR'].includes(String(customer.customer_class))) ? '4100' : '4000';
  if (grossRevenueKobo > 0) {
    glLines.push({ code: revenueAccount, direction: 'CREDIT', amountKobo: grossRevenueKobo, description: `Sales ${saleNumber}` });
  }
  if (discountKobo > 0) {
    // 4500 Discounts allowed has a DEBIT normal balance, so a debit here
    // increases it and reduces net revenue in the P&L.
    glLines.push({ code: '4500', direction: 'DEBIT', amountKobo: discountKobo, description: `Discounts on ${saleNumber}` });
  }

  // ---- VAT ----------------------------------------------------------------
  if (totals.vatKobo > 0) {
    glLines.push({ code: '2210', direction: 'CREDIT', amountKobo: totals.vatKobo, description: `Output VAT on ${saleNumber}` });
  }

  // ---- cost of sales and inventory -----------------------------------------
  if (totals.costKobo > 0) {
    glLines.push({ code: '5000', direction: 'DEBIT', amountKobo: totals.costKobo, description: `COGS ${saleNumber}` });
    glLines.push({ code: '1200', direction: 'CREDIT', amountKobo: totals.costKobo, description: `Inventory issued ${saleNumber}` });
  }

  // The tender legs must equal total + fee, and the revenue legs must equal
  // total. If a fee was split out above, the DR side grows by exactly the fee
  // and the CR side grows by exactly the fee, so balance is preserved — which is
  // the property worth having, and the reason the fee is booked as a split
  // rather than as a netted receivable.
  return postEntry(db, {
    business, branchId: branch.id, entryDate: saleDate,
    sourceType: 'SALE', sourceId: saleId, reference: saleNumber,
    description: `Sale ${saleNumber}`, lines: glLines, userId: scope.userId,
  });
}

/**
 * A customer PAYS a debt.
 *   DR cash/bank        CR accounts receivable
 * An over-payment becomes a customer advance (a liability), never revenue.
 */
async function postDebtorPayment(db, { business, branchId, entryDate, method, amountKobo, unappliedKobo, customerId, reference, userId }) {
  const accountFor = { CASH: '1000', POS_TERMINAL: '1040', BANK_TRANSFER: '1030', MOBILE_MONEY: '1050', USSD: '1030', CHEQUE: '1030' }[String(method).toUpperCase()] || '1000';
  const lines = [
    { code: accountFor, direction: 'DEBIT', amountKobo, description: `Receipt from debtor ${reference || ''}` },
    { code: '1100', direction: 'CREDIT', amountKobo: amountKobo - (unappliedKobo || 0), description: 'Debtors reduced' },
  ];
  if (unappliedKobo > 0) {
    lines.push({ code: '2290', direction: 'CREDIT', amountKobo: unappliedKobo, description: 'Unapplied receipt held as a customer advance' });
  }
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'DEBTOR_PAYMENT', sourceId: customerId,
    reference, description: `Debtor payment ${reference || ''}`, lines, userId,
  });
}

/**
 * GOODS RECEIVED against a PO.
 *   DR inventory        CR accounts payable
 * Freight is added to inventory (it is part of the cost of getting the goods
 * into a saleable position), and input VAT is separated out so it can be
 * reclaimed rather than buried in the stock value.
 */
async function postGoodsReceipt(db, { business, branchId, entryDate, costKobo, freightKobo = 0, inputVatKobo = 0, supplierId, reference, userId }) {
  const stockKobo = Math.max(0, costKobo + freightKobo);
  const lines = [];
  if (stockKobo > 0) lines.push({ code: '1200', direction: 'DEBIT', amountKobo: stockKobo, description: `Stock received ${reference || ''}` });
  if (inputVatKobo > 0) lines.push({ code: '1215', direction: 'DEBIT', amountKobo: inputVatKobo, description: 'Input VAT on purchase' });
  const creditTotal = stockKobo + inputVatKobo;
  if (creditTotal > 0) lines.push({ code: '2000', direction: 'CREDIT', amountKobo: creditTotal, description: `Payable to supplier ${reference || ''}` });
  if (!lines.length) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'PO_RECEIPT', sourceId: supplierId,
    reference, description: `Goods received ${reference || ''}`, lines, userId,
  });
}

/**
 * An EXPENSE.
 *   DR expense (+ input VAT if recoverable)   CR the money it came from
 * `paid_from` decides the credit side: a till purchase reduces the drawer, a
 * safe purchase reduces the safe, a credit purchase creates a payable. Getting
 * this wrong is how a till reconciles at close and the safe does not.
 */
async function postExpense(db, { business, branchId, entryDate, category, netKobo, vatKobo = 0, paidFrom = 'TILL', supplierId, reference, description, userId }) {
  const creditAccount = {
    TILL: '1000', SAFE: '1010', BANK: '1030', CREDIT: '2000', PETTY_CASH: '1020',
  }[String(paidFrom).toUpperCase()] || '1000';
  // The expense account is chosen by category, falling back to sundry. A client
  // who wants proper mapping configures it; the fallback must never be "post
  // nothing".
  const expenseAccount = mapExpenseCategory(category);
  const lines = [
    { code: expenseAccount, direction: 'DEBIT', amountKobo: Math.max(0, netKobo), description: description || category },
  ];
  if (vatKobo > 0) lines.push({ code: '1215', direction: 'DEBIT', amountKobo: vatKobo, description: 'Input VAT on expense' });
  lines.push({ code: creditAccount, direction: 'CREDIT', amountKobo: Math.max(0, netKobo) + Math.max(0, vatKobo), description: `Paid from ${paidFrom}` });
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'EXPENSE', sourceId: supplierId || null,
    reference, description: description || `Expense: ${category}`, lines, userId,
  });
}

const EXPENSE_CATEGORY_MAP = Object.freeze({
  RENT: '6000', RATES: '6000', SERVICE_CHARGE: '6000',
  ELECTRICITY: '6010', POWER: '6010', WATER: '6010', INTERNET: '6010', AIRTIME: '6010', GENERATOR_FUEL: '6010',
  SALARY: '6020', SALARIES: '6020', WAGES: '6020', STAFF_WELFARE: '6020', CASUAL_LABOUR: '6020',
  FUEL: '6030', TRANSPORT: '6030', DELIVERY: '6030', LOGISTICS: '6030', VEHICLE_MAINTENANCE: '6030',
  ADVERTISING: '6040', MARKETING: '6040', SIGNAGE: '6040',
  REPAIRS: '6050', MAINTENANCE: '6050', CLEANING: '6050',
  SECURITY: '6060',
  INSURANCE: '6070',
  LEGAL: '6080', ACCOUNTING: '6080', PROFESSIONAL: '6080', LICENCES: '6080', PERMITS: '6080',
  BANK_CHARGES: '6090', POS_CHARGES: '6090', TERMINAL_RENTAL: '6090',
  BAD_DEBT: '6100',
  DEPRECIATION: '6110',
});

function mapExpenseCategory(category) {
  const key = String(category || '').toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_');
  if (EXPENSE_CATEGORY_MAP[key]) return EXPENSE_CATEGORY_MAP[key];
  // A partial match, so "RENT_IKEJA" still lands on 6000 rather than sundry.
  for (const [k, v] of Object.entries(EXPENSE_CATEGORY_MAP)) {
    if (key.startsWith(k)) return v;
  }
  return '6900';
}

/**
 * A STOCK ADJUSTMENT (damage, theft, count variance, write-off).
 *   DR shrinkage/damage or write-off   CR inventory
 * Kept OUT of COGS on purpose: shrinkage is the number an owner most needs to
 * see on its own line. Burying a stolen generator inside cost of sales makes it
 * invisible in exactly the report where it matters.
 */
async function postStockAdjustment(db, { business, branchId, entryDate, reason, valueKobo, reference, description, userId }) {
  const account = ['THEFT', 'LOSS', 'DAMAGE', 'SCRAPPED'].includes(String(reason).toUpperCase()) ? '5450'
    : String(reason).toUpperCase() === 'EXPIRED' ? '5470'
      : String(reason).toUpperCase() === 'RETURN_TO_SUPPLIER' ? '5200'
        : '5450';
  const abs = Math.abs(Math.round(Number(valueKobo) || 0));
  if (abs === 0) return null;
  const lines = Number(valueKobo) > 0
    // Stock found: inventory up, shrinkage reversed.
    ? [{ code: '1200', direction: 'DEBIT', amountKobo: abs, description }, { code: account, direction: 'CREDIT', amountKobo: abs, description }]
    : [{ code: account, direction: 'DEBIT', amountKobo: abs, description }, { code: '1200', direction: 'CREDIT', amountKobo: abs, description }];
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'STOCK_ADJUSTMENT', sourceId: null,
    reference, description: description || `Stock adjustment: ${reason}`, lines, userId,
  });
}

/**
 * A TILL SWEEP into the safe, and a SAFE deposit to the bank.
 * Both are internal movements: DR one asset, CR another, no P&L effect. Posting
 * them is what makes the safe balance and the bank balance both derivable from
 * the ledger instead of only from the operational tables.
 */
async function postCashMovement(db, { business, branchId, entryDate, movementType, amountKobo, reference, userId }) {
  const abs = Math.abs(Math.round(Number(amountKobo) || 0));
  if (!abs) return null;
  const map = {
    TILL_SWEEP: ['1010', '1000', 'Till swept into the safe'],
    FLOAT_IN: ['1000', '1010', 'Float issued from the safe'],
    BANK_DEPOSIT: ['1030', '1010', 'Cash banked'],
    TRANSFER_IN: ['1010', '1030', 'Cash received from another branch'],
    TRANSFER_OUT: ['1030', '1010', 'Cash sent to another branch'],
  }[String(movementType).toUpperCase()];
  if (!map) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'TILL_CLOSE', reference,
    description: map[2],
    lines: [
      { code: map[0], direction: 'DEBIT', amountKobo: abs, description: map[2] },
      { code: map[1], direction: 'CREDIT', amountKobo: abs, description: map[2] },
    ],
    userId,
  });
}

/** CHANGE OWED arises and is settled. Both legs are balance-sheet only. */
async function postChangeOwed(db, { business, branchId, entryDate, amountKobo, direction, reference, userId }) {
  const abs = Math.abs(Math.round(Number(amountKobo) || 0));
  if (!abs) return null;
  const lines = direction === 'OUT'
    ? [{ code: '2270', direction: 'DEBIT', amountKobo: abs, description: 'Change owed settled' },
       { code: '1000', direction: 'CREDIT', amountKobo: abs, description: 'Paid from the till' }]
    : [{ code: '1000', direction: 'DEBIT', amountKobo: abs, description: 'Change not available in the drawer' },
       { code: '2270', direction: 'CREDIT', amountKobo: abs, description: 'Change owed to customer' }];
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'CHANGE_OWED', reference,
    description: direction === 'OUT' ? 'Change owed paid out' : 'Change owed recorded', lines, userId,
  });
}

/** A LAYAWAY deposit taken: cash in, liability out. NOT revenue. */
async function postLayawayDeposit(db, { business, branchId, entryDate, amountKobo, holdNumber, userId }) {
  const abs = Math.abs(Math.round(Number(amountKobo) || 0));
  if (!abs) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'LAYAWAY', reference: holdNumber,
    description: `Layaway deposit ${holdNumber || ''}`,
    lines: [
      { code: '1000', direction: 'DEBIT', amountKobo: abs, description: 'Deposit received' },
      { code: '2260', direction: 'CREDIT', amountKobo: abs, description: 'Held against the held goods — not yet revenue' },
    ],
    userId,
  });
}

/** A forfeited layaway deposit: liability becomes other income. */
async function postForfeitedDeposit(db, { business, branchId, entryDate, amountKobo, holdNumber, userId }) {
  const abs = Math.abs(Math.round(Number(amountKobo) || 0));
  if (!abs) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'LAYAWAY', reference: holdNumber,
    description: `Forfeited layaway deposit ${holdNumber || ''}`,
    lines: [
      { code: '2260', direction: 'DEBIT', amountKobo: abs, description: 'Liability released' },
      // OTHER INCOME, not sales: no goods left the shop, so booking it as
      // revenue would overstate turnover and understate margin.
      { code: '4400', direction: 'CREDIT', amountKobo: abs, description: 'Forfeited deposit' },
    ],
    userId,
  });
}

/** An INSTALMENT plan opened on the DELIVERED_ON_DEPOSIT model: the goods have
 *  left, so revenue is recognised now and the unpaid part is an instalment
 *  receivable rather than trade debt. */
async function postInstalmentSale(db, { business, branchId, entryDate, planNumber, depositKobo, financedKobo, revenueKobo, vatKobo, costKobo, userId }) {
  const lines = [];
  if (depositKobo > 0) lines.push({ code: '1000', direction: 'DEBIT', amountKobo: depositKobo, description: 'Deposit received' });
  if (financedKobo > 0) lines.push({ code: '1250', direction: 'DEBIT', amountKobo: financedKobo, description: `Instalment receivable ${planNumber}` });
  if (revenueKobo > 0) lines.push({ code: '4000', direction: 'CREDIT', amountKobo: revenueKobo, description: `Revenue on ${planNumber}` });
  if (vatKobo > 0) lines.push({ code: '2210', direction: 'CREDIT', amountKobo: vatKobo, description: 'Output VAT' });
  if (costKobo > 0) {
    lines.push({ code: '5000', direction: 'DEBIT', amountKobo: costKobo, description: 'COGS' });
    lines.push({ code: '1200', direction: 'CREDIT', amountKobo: costKobo, description: 'Inventory issued' });
  }
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'INSTALMENT', reference: planNumber,
    description: `Instalment sale ${planNumber}`, lines, userId,
  });
}

/** An instalment PAYMENT received: cash in, instalment receivable down. */
async function postInstalmentPayment(db, { business, branchId, entryDate, amountKobo, method = 'CASH', planNumber, userId }) {
  const abs = Math.abs(Math.round(Number(amountKobo) || 0));
  if (!abs) return null;
  const accountFor = { CASH: '1000', POS_TERMINAL: '1040', BANK_TRANSFER: '1030', MOBILE_MONEY: '1050' }[String(method).toUpperCase()] || '1000';
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'INSTALMENT', reference: planNumber,
    description: `Instalment received ${planNumber || ''}`,
    lines: [
      { code: accountFor, direction: 'DEBIT', amountKobo: abs, description: 'Instalment received' },
      { code: '1250', direction: 'CREDIT', amountKobo: abs, description: 'Instalment receivable reduced' },
    ],
    userId,
  });
}

/** WHT deducted FROM a supplier payment: the payable falls by the gross, cash
 *  by the net, and a WHT payable arises for the difference. */
async function postWhtPayable(db, { business, branchId, entryDate, whtKobo, reference, description, userId }) {
  const abs = Math.abs(Math.round(Number(whtKobo) || 0));
  if (!abs) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'WHT', reference,
    description: description || `WHT deducted ${reference || ''}`,
    lines: [
      { code: '2000', direction: 'DEBIT', amountKobo: abs, description: 'Payable reduced by WHT' },
      { code: '2230', direction: 'CREDIT', amountKobo: abs, description: 'WHT payable to FIRS' },
    ],
    userId,
  });
}

/** WHT deducted BY a customer from what they owe us: receivable falls, a WHT
 *  receivable arises (an asset until the credit note lands). */
async function postWhtReceivable(db, { business, branchId, entryDate, whtKobo, reference, description, userId }) {
  const abs = Math.abs(Math.round(Number(whtKobo) || 0));
  if (!abs) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'WHT', reference,
    description: description || `WHT deducted by customer ${reference || ''}`,
    lines: [
      { code: '1240', direction: 'DEBIT', amountKobo: abs, description: 'WHT receivable — awaiting credit note' },
      { code: '1100', direction: 'CREDIT', amountKobo: abs, description: 'Receivable reduced by WHT deducted' },
    ],
    userId,
  });
}

/** A VAT period settled: output less input, paid to or reclaimed from FIRS. */
async function postVatSettlement(db, { business, branchId, entryDate, outputKobo, inputKobo, paidKobo, position, reference, userId }) {
  const lines = [];
  if (outputKobo > 0) lines.push({ code: '2210', direction: 'DEBIT', amountKobo: outputKobo, description: 'Output VAT cleared' });
  if (inputKobo > 0) lines.push({ code: '1215', direction: 'CREDIT', amountKobo: inputKobo, description: 'Input VAT cleared' });
  const net = Math.max(0, outputKobo - inputKobo);
  if (net > 0) lines.push({ code: '1030', direction: 'CREDIT', amountKobo: net, description: `VAT paid to FIRS ${reference || ''}` });
  if (!lines.length) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'VAT', reference,
    description: `VAT settlement (${position}) ${reference || ''}`, lines, userId,
  });
}

/** A warranty claim settled: draw down the provision, or expense it if the
 *  provision is exhausted. */
async function postWarrantyClaim(db, { business, branchId, entryDate, repairCostKobo, replacementCostKobo = 0, refundKobo = 0, claimNumber, userId }) {
  const costK = Math.abs(Math.round(Number(repairCostKobo) || 0)) + Math.abs(Math.round(Number(replacementCostKobo) || 0));
  const refundK = Math.abs(Math.round(Number(refundKobo) || 0));
  const lines = [];
  if (costK > 0) {
    lines.push({ code: '2280', direction: 'DEBIT', amountKobo: costK, description: `Warranty provision drawn down ${claimNumber}` });
    lines.push({ code: '5460', direction: 'CREDIT', amountKobo: costK, description: 'Warranty cost' });
  }
  if (refundK > 0) {
    lines.push({ code: '2280', direction: 'DEBIT', amountKobo: refundK, description: `Warranty refund ${claimNumber}` });
    lines.push({ code: '1000', direction: 'CREDIT', amountKobo: refundK, description: 'Refund paid' });
  }
  if (!lines.length) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'WARRANTY', reference: claimNumber,
    description: `Warranty claim ${claimNumber || ''}`, lines, userId,
  });
}

/** The monthly warranty accrual: expense now, provision for later. */
async function postWarrantyProvision(db, { business, branchId, entryDate, accrualKobo, period, userId }) {
  const abs = Math.abs(Math.round(Number(accrualKobo) || 0));
  if (!abs) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'PROVISION', reference: period,
    description: `Warranty provision accrued for ${period}`,
    lines: [
      { code: '5460', direction: 'DEBIT', amountKobo: abs, description: 'Warranty cost accrued' },
      { code: '2280', direction: 'CREDIT', amountKobo: abs, description: 'Provision raised' },
    ],
    userId,
  });
}

/** A bad debt written off. */
async function postBadDebt(db, { business, branchId, entryDate, amountKobo, customerId, reference, userId }) {
  const abs = Math.abs(Math.round(Number(amountKobo) || 0));
  if (!abs) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'BAD_DEBT', sourceId: customerId, reference,
    description: `Bad debt written off ${reference || ''}`,
    lines: [
      { code: '6100', direction: 'DEBIT', amountKobo: abs, description: 'Bad debt expense' },
      { code: '1100', direction: 'CREDIT', amountKobo: abs, description: 'Receivable removed' },
    ],
    userId,
  });
}

/** A SALE RETURN: revenue and VAT reversed, stock back in (or written off). */
async function postSaleReturn(db, { business, branchId, entryDate, refundKobo, vatKobo = 0, costKobo = 0, restocked = true, refundMethod = 'CASH', returnNumber, userId }) {
  const lines = [];
  const revenueK = Math.max(0, Math.round(refundKobo) - Math.round(vatKobo));
  if (revenueK > 0) lines.push({ code: '4200', direction: 'DEBIT', amountKobo: revenueK, description: `Sales return ${returnNumber}` });
  if (vatKobo > 0) lines.push({ code: '2210', direction: 'DEBIT', amountKobo: vatKobo, description: 'Output VAT reversed' });
  const refundAccount = { CASH: '1000', ORIGINAL_METHOD: '1030', BANK: '1030' }[String(refundMethod).toUpperCase()];
  if (refundAccount && Math.round(refundKobo) > 0) {
    lines.push({ code: refundAccount, direction: 'CREDIT', amountKobo: Math.round(refundKobo), description: 'Refund paid' });
  } else if (String(refundMethod).toUpperCase() === 'STORE_CREDIT' || String(refundMethod).toUpperCase() === 'VOUCHER') {
    // Not paid out: a liability is created instead.
    lines.push({ code: '2300', direction: 'CREDIT', amountKobo: Math.round(refundKobo), description: 'Store credit issued' });
  }
  if (costKobo > 0 && restocked) {
    lines.push({ code: '1200', direction: 'DEBIT', amountKobo: costKobo, description: 'Goods returned to stock' });
    lines.push({ code: '5000', direction: 'CREDIT', amountKobo: costKobo, description: 'COGS reversed' });
  }
  if (!lines.length) return null;
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'SALE_RETURN', reference: returnNumber,
    description: `Sales return ${returnNumber || ''}`, lines, userId,
  });
}

/** A stock TRANSFER between branches is a movement within one asset account —
 *  no P&L effect, but posting it keeps the per-branch inventory ledger honest. */
async function postTransfer(db, { business, fromBranchId, toBranchId, entryDate, valueKobo, reference, userId }) {
  const abs = Math.abs(Math.round(Number(valueKobo) || 0));
  if (!abs) return null;
  return postEntry(db, {
    business, branchId: fromBranchId, entryDate, sourceType: 'TRANSFER', reference,
    description: `Stock transfer ${reference || ''}`,
    lines: [
      { code: '1200', direction: 'DEBIT', amountKobo: abs, branchId: toBranchId, description: 'Stock received at destination' },
      { code: '1200', direction: 'CREDIT', amountKobo: abs, branchId: fromBranchId, description: 'Stock issued from origin' },
    ],
    userId,
  });
}

/** FX revaluation of foreign-currency stock or balances. */
async function postFxRevaluation(db, { business, branchId, entryDate, gainLossKobo, reference, userId }) {
  const k = Math.round(Number(gainLossKobo) || 0);
  if (!k) return null;
  const lines = k > 0
    ? [{ code: '1200', direction: 'DEBIT', amountKobo: k, description: 'Stock revalued upward' },
       { code: '7900', direction: 'CREDIT', amountKobo: k, description: 'FX gain' }]
    : [{ code: '7900', direction: 'DEBIT', amountKobo: Math.abs(k), description: 'FX loss' },
       { code: '1200', direction: 'CREDIT', amountKobo: Math.abs(k), description: 'Stock revalued downward' }];
  return postEntry(db, {
    business, branchId, entryDate, sourceType: 'FX_REVALUATION', reference,
    description: `FX revaluation ${reference || ''}`, lines, userId,
  });
}

// ---------------------------------------------------------------------
// REPORTS
// ---------------------------------------------------------------------
/** Trial balance for a period. The one report that proves the ledger is sound. */
async function trialBalance(db, { businessId, period = null, branchId = null, asOf = null }) {
  const params = [String(businessId)];
  let where = "je.is_deleted = 0 AND je.status = 'POSTED' AND je.business_id = ?";
  if (period) { where += ' AND je.period = ?'; params.push(String(period)); }
  if (asOf) { where += ' AND je.entry_date <= ?'; params.push(String(asOf).slice(0, 10)); }
  if (branchId) { where += ' AND (je.branch_id = ? OR je.branch_id IS NULL)'; params.push(String(branchId)); }

  const rows = await db.prepare(`
    SELECT ga.code, ga.name, ga.account_type, ga.normal_balance,
           SUM(CASE WHEN gl.direction='DEBIT'  THEN gl.amount_kobo ELSE 0 END) AS debit_kobo,
           SUM(CASE WHEN gl.direction='CREDIT' THEN gl.amount_kobo ELSE 0 END) AS credit_kobo
      FROM gl_journal_lines gl
      JOIN gl_journal_entries je ON je.id = gl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = gl.account_id
     WHERE gl.is_deleted = 0 AND ${where}
     GROUP BY ga.code
     ORDER BY ga.code
  `).bind(...params).all();

  let totalDebit = 0; let totalCredit = 0;
  const accounts = rows.map((r) => {
    const debit = Number(r.debit_kobo) || 0;
    const credit = Number(r.credit_kobo) || 0;
    totalDebit += debit; totalCredit += credit;
    const balance = r.normal_balance === 'DEBIT' ? debit - credit : credit - debit;
    return {
      code: r.code, name: r.name, account_type: r.account_type, normal_balance: r.normal_balance,
      debit: M.fromKobo(debit), credit: M.fromKobo(credit),
      balance: M.fromKobo(balance), balance_kobo: balance,
    };
  });

  return {
    business_id: businessId, period, as_of: asOf || null, branch_id: branchId || null,
    accounts,
    total_debit: M.fromKobo(totalDebit),
    total_credit: M.fromKobo(totalCredit),
    total_debit_kobo: totalDebit,
    total_credit_kobo: totalCredit,
    // THE POINT OF THE WHOLE EXERCISE.
    balanced: totalDebit === totalCredit,
    difference: M.fromKobo(Math.abs(totalDebit - totalCredit)),
    note: totalDebit === totalCredit
      ? 'The trial balance is in balance.'
      : 'THE TRIAL BALANCE DOES NOT BALANCE. Do not rely on any report derived from it until this is found and fixed.',
  };
}

/** Profit and loss for a period. */
async function profitAndLoss(db, { businessId, period, branchId = null }) {
  const tb = await trialBalance(db, { businessId, period, branchId });
  const pick = (prefix) => tb.accounts.filter((a) => a.code.startsWith(prefix));
  const sum = (list) => list.reduce((a, x) => a + x.balance_kobo, 0);

  const revenue = sum(pick('40')) + sum(pick('41'));
  const returns = sum(pick('42'));
  const discounts = sum(pick('45'));
  const otherIncome = sum(pick('44'));
  const netRevenue = revenue - returns - discounts;

  const cogs = sum(pick('50')) + sum(pick('51')) - sum(pick('52')) + sum(pick('54'));
  const grossProfit = netRevenue - cogs;

  const opex = sum(pick('60')) + sum(pick('61')) + sum(pick('69'));
  const operatingProfit = grossProfit - opex;
  const other = sum(pick('79'));
  const tax = sum(pick('80'));
  const netProfit = operatingProfit + other - tax;

  return {
    period, business_id: businessId, branch_id: branchId,
    revenue: M.fromKobo(revenue), returns: M.fromKobo(returns), discounts: M.fromKobo(discounts),
    net_revenue: M.fromKobo(netRevenue),
    cogs: M.fromKobo(cogs),
    gross_profit: M.fromKobo(grossProfit),
    gross_margin_percent: netRevenue > 0 ? M.round2((grossProfit / netRevenue) * 100) : 0,
    opex: M.fromKobo(opex),
    operating_profit: M.fromKobo(operatingProfit),
    other: M.fromKobo(other),
    tax: M.fromKobo(tax),
    net_profit: M.fromKobo(netProfit),
    net_margin_percent: netRevenue > 0 ? M.round2((netProfit / netRevenue) * 100) : 0,
    lines: {
      revenue: pick('40').concat(pick('41')), returns: pick('42'), other_income: pick('44'), discounts: pick('45'),
      cogs: pick('50').concat(pick('51'), pick('52'), pick('54')),
      opex: pick('60').concat(pick('61'), pick('69')),
      other: pick('79'), tax: pick('80'),
    },
    balanced: tb.balanced,
  };
}

/** Balance sheet as at a date. */
async function balanceSheet(db, { businessId, asOf, branchId = null }) {
  const tb = await trialBalance(db, { businessId, asOf, branchId });
  const byType = (t) => tb.accounts.filter((a) => a.account_type === t);
  const sum = (list) => list.reduce((a, x) => a + x.balance_kobo, 0);

  const assets = sum(byType('ASSET'));
  const liabilities = sum(byType('LIABILITY'));
  const equity = sum(byType('EQUITY'));
  // Retained earnings for the period are the P&L result; without it the sheet
  // cannot balance, because the revenue and expense accounts have been closed
  // into nothing.
  const pl = await profitAndLoss(db, { businessId, period: null, branchId });
  const earningsKobo = pl.net_profit_kobo || (pl.net_profit != null ? M.toKobo(pl.net_profit) : 0);

  return {
    as_of: asOf, business_id: businessId,
    assets: M.fromKobo(assets), assets_kobo: assets,
    liabilities: M.fromKobo(liabilities), liabilities_kobo: liabilities,
    equity: M.fromKobo(equity), equity_kobo: equity,
    current_period_earnings: pl.net_profit,
    current_period_earnings_kobo: earningsKobo,
    // Equity + liabilities + the cumulative result must equal assets, or
    // something has been posted to the wrong side. That is the assertion the
    // balance sheet exists to make, so it is returned rather than left for the
    // reader to compute.
    total_equity_and_liabilities: M.fromKobo(liabilities + equity + earningsKobo),
    balances: assets === liabilities + equity + earningsKobo,
    out_by: M.fromKobo(Math.abs(assets - (liabilities + equity + earningsKobo))),
    lines: { assets: byType('ASSET'), liabilities: byType('LIABILITY'), equity: byType('EQUITY') },
    balanced: tb.balanced,
  };
}

/** VAT return for a period, derived from the ledger alone. */
async function vatReturn(db, { businessId, period, branchId = null }) {
  const tb = await trialBalance(db, { businessId, period, branchId });
  const output = tb.accounts.find((a) => a.code === '2210');
  const input = tb.accounts.find((a) => a.code === '1215');
  const VATLIB = require('../lib/vat');
  return VATLIB.vatReturn({
    period,
    outputVat: output ? output.balance : 0,
    inputVat: input ? input.balance : 0,
  });
}

/** The check that makes the whole ledger trustworthy: does it balance? */
async function checkLedgerIntegrity(db, { businessId = null } = {}) {
  const params = [];
  let where = "je.is_deleted = 0 AND je.status = 'POSTED'";
  if (businessId) { where += ' AND je.business_id = ?'; params.push(String(businessId)); }
  const bad = await db.prepare(`
    SELECT je.id, je.entry_number, je.entry_date, je.total_debit_kobo, je.total_credit_kobo,
           SUM(CASE WHEN gl.direction='DEBIT'  THEN gl.amount_kobo ELSE 0 END) AS line_debit,
           SUM(CASE WHEN gl.direction='CREDIT' THEN gl.amount_kobo ELSE 0 END) AS line_credit
      FROM gl_journal_entries je
      JOIN gl_journal_lines gl ON gl.journal_entry_id = je.id AND gl.is_deleted = 0
     WHERE ${where}
     GROUP BY je.id
    HAVING line_debit != line_credit
        OR line_debit != je.total_debit_kobo
        OR line_credit != je.total_credit_kobo
  `).bind(...params).all();

  const totals = await db.prepare(`
    SELECT COALESCE(SUM(total_debit_kobo),0) AS d, COALESCE(SUM(total_credit_kobo),0) AS c, COUNT(*) AS n
      FROM gl_journal_entries WHERE is_deleted = 0 AND status = 'POSTED'
      ${businessId ? 'AND business_id = ?' : ''}
  `).bind(...params).first();

  return {
    entries: (totals && totals.n) || 0,
    total_debit: M.fromKobo((totals && totals.d) || 0),
    total_credit: M.fromKobo((totals && totals.c) || 0),
    balanced: ((totals && totals.d) || 0) === ((totals && totals.c) || 0),
    unbalanced_entries: bad.map((b) => ({
      id: b.id, entry_number: b.entry_number, entry_date: b.entry_date,
      stated_debit: M.fromKobo(b.total_debit_kobo), stated_credit: M.fromKobo(b.total_credit_kobo),
      actual_debit: M.fromKobo(b.line_debit), actual_credit: M.fromKobo(b.line_credit),
    })),
    ok: bad.length === 0 && ((totals && totals.d) || 0) === ((totals && totals.c) || 0),
  };
}

module.exports = {
  SYSTEM_CHART, ACCOUNT_BY_CODE, EXPENSE_CATEGORY_MAP, mapExpenseCategory,
  seedChart, accountId, accountMap, periodOf, postEntry,
  postSaleJournal, postDebtorPayment, postGoodsReceipt, postExpense,
  postStockAdjustment, postCashMovement, postChangeOwed,
  postLayawayDeposit, postForfeitedDeposit, postInstalmentSale, postInstalmentPayment,
  postWhtPayable, postWhtReceivable, postVatSettlement,
  postWarrantyClaim, postWarrantyProvision, postBadDebt, postSaleReturn,
  postTransfer, postFxRevaluation,
  trialBalance, profitAndLoss, balanceSheet, vatReturn, checkLedgerIntegrity,
};
