// =====================================================================
// StockRidge — GENERAL LEDGER SERVICE
// =====================================================================
// Double-entry bookkeeping, posted automatically from every operational
// event. A retailer that has to type its own journals does not have books;
// it has a spreadsheet with extra steps.
//
// INVARIANTS, all enforced here and two of them enforced again in SQL:
//
//   1. EVERY ENTRY BALANCES. total_debit = total_credit, checked in the
//      service AND by a CHECK constraint on gl_journal_entries, so a bug in
//      any caller produces a loud failure rather than a silently wrong
//      balance sheet.
//
//   2. A LINE CARRIES EITHER A DEBIT OR A CREDIT, NEVER BOTH. A line with
//      both would net out and hide itself from the trial balance. Also a
//      CHECK constraint.
//
//   3. NOTHING IS EVER DELETED OR EDITED. A void, a reversal or a correction
//      posts a NEW entry referencing the original. An accounting record that
//      can be edited is not an accounting record — it is a draft.
//
//   4. NO DRAFT OR ORPHAN ENTRIES REACH A REPORT. Reports read
//      status = 'POSTED' only, and a DRAFT entry that never posts is a bug
//      the integrity panel surfaces rather than a number that quietly
//      disappears.
//
// VAT SPLIT: where the business is VAT-registered, revenue is posted NET of
// VAT and the VAT component goes to a liability account, because output VAT
// is money collected on behalf of FIRS and is not the business's income.
// Posting the gross figure to revenue overstates turnover by 7.5% on every
// sale and overstates profit by the same amount — which then flows into
// income-tax exposure. This is the single most common bookkeeping error in
// small Nigerian retail and it is designed out here.
// =====================================================================

const { newId, watNowIso, watDate } = require('../../shared/ids');
const { round2, sumMoney, toKobo, fromKobo } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const { PREFIXES, nextReference } = require('../lib/references');
const vat = require('../lib/vat');

// ---------------------------------------------------------------------
// CHART OF ACCOUNTS
// ---------------------------------------------------------------------
// Seeded per business unit. `is_system = 1` rows cannot be deleted, because
// the posting code below references them by code and a deleted account would
// make every subsequent sale fail to post.
const CHART_OF_ACCOUNTS = Object.freeze([
  // ASSETS (normal side DEBIT)
  { code: '1000', name: 'Cash at hand — tills', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1010', name: 'Cash in branch safe', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1020', name: 'Bank — current account', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1030', name: 'POS terminal settlements receivable', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1040', name: 'Mobile money / USSD receivable', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1050', name: 'Cheques in hand', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1100', name: 'Inventory — stock at cost', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1110', name: 'Goods in transit (inter-branch)', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1200', name: 'Trade debtors — customers', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1210', name: 'Instalment plan receivable', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1220', name: 'Layaway receivable', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1230', name: 'Withholding tax credit notes receivable', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1240', name: 'Change owed to customers', account_type: 'LIABILITY', normal_side: 'CREDIT', system: 1 },
  { code: '1300', name: 'Fixed assets — equipment', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1310', name: 'Delivery vehicles', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '1390', name: 'Accumulated depreciation', account_type: 'ASSET', normal_side: 'CREDIT', system: 1 },

  // LIABILITIES (normal side CREDIT)
  { code: '2000', name: 'Trade creditors — suppliers', account_type: 'LIABILITY', normal_side: 'CREDIT', system: 1 },
  { code: '2100', name: 'VAT payable — output', account_type: 'LIABILITY', normal_side: 'CREDIT', system: 1 },
  { code: '2110', name: 'VAT recoverable — input', account_type: 'ASSET', normal_side: 'DEBIT', system: 1 },
  { code: '2120', name: 'Withholding tax payable to FIRS', account_type: 'LIABILITY', normal_side: 'CREDIT', system: 1 },
  { code: '2200', name: 'Customer deposits — layaway', account_type: 'LIABILITY', normal_side: 'CREDIT', system: 1 },
  { code: '2210', name: 'Customer deposits — instalment plans', account_type: 'LIABILITY', normal_side: 'CREDIT', system: 1 },
  { code: '2300', name: 'Staff payables', account_type: 'LIABILITY', normal_side: 'CREDIT', system: 1 },
  { code: '2400', name: 'Accrued expenses', account_type: 'LIABILITY', normal_side: 'CREDIT', system: 1 },

  // EQUITY
  { code: '3000', name: 'Owner\u2019s capital', account_type: 'EQUITY', normal_side: 'CREDIT', system: 1 },
  { code: '3100', name: 'Owner\u2019s drawings', account_type: 'EQUITY', normal_side: 'DEBIT', system: 1 },
  { code: '3900', name: 'Retained earnings / opening balance', account_type: 'EQUITY', normal_side: 'CREDIT', system: 1 },

  // REVENUE
  { code: '4000', name: 'Sales revenue — goods', account_type: 'REVENUE', normal_side: 'CREDIT', system: 1 },
  { code: '4100', name: 'Sales revenue — services & installation', account_type: 'REVENUE', normal_side: 'CREDIT', system: 1 },
  { code: '4200', name: 'Delivery income', account_type: 'REVENUE', normal_side: 'CREDIT', system: 1 },
  { code: '4300', name: 'Interest & instalment plan income', account_type: 'REVENUE', normal_side: 'CREDIT', system: 1 },
  { code: '4900', name: 'Discounts allowed to customers', account_type: 'REVENUE', normal_side: 'DEBIT', system: 1 },
  { code: '4910', name: 'Sales returns & allowances', account_type: 'REVENUE', normal_side: 'DEBIT', system: 1 },

  // COST OF SALES
  { code: '5000', name: 'Cost of goods sold', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '5100', name: 'Delivery & logistics cost', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '5200', name: 'Installation labour cost', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '5300', name: 'Stock write-off — damage & loss', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '5400', name: 'Stock write-off — expiry & obsolescence', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '5500', name: 'Warranty & claims cost', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },

  // EXPENSES
  { code: '6000', name: 'Rent & rates', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6010', name: 'Salaries, wages & allowances', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6020', name: 'Utilities — power, water, fuel & generator', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6030', name: 'Transport & logistics', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6040', name: 'Repairs & maintenance', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6050', name: 'Marketing & advertising', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6060', name: 'Professional, legal & accounting fees', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6070', name: 'Licences, permits & regulatory fees', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6080', name: 'Bank & POS terminal charges', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6090', name: 'Telephone & internet', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6100', name: 'Insurance', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6110', name: 'Security', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6120', name: 'Office & shop supplies', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6130', name: 'Travel & entertainment', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6900', name: 'Depreciation', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6950', name: 'Sundry expenses', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
  { code: '6990', name: 'Bad debts written off', account_type: 'EXPENSE', normal_side: 'DEBIT', system: 1 },
]);

// Which cash-ish account each tender method lands in. A POS settlement is
// NOT cash in the drawer — it arrives in the bank T+1 — and treating it as
// cash is why so many small-shop books show a drawer surplus that was never
// physically there.
const PAYMENT_ACCOUNT = Object.freeze({
  CASH: '1000',
  POS_TERMINAL: '1030',
  BANK_TRANSFER: '1020',
  USSD: '1040',
  MOBILE_MONEY: '1040',
  CHEQUE: '1050',
  CREDIT: '1200',
  GIFT_VOUCHER: '2200',
  LOYALTY_REDEMPTION: '4900',
  CRYPTO: '1020',
  OTHER: '1020',
});

async function ensureChart(db, businessUnitId) {
  const existing = await db.prepare('SELECT code, id FROM gl_accounts WHERE business_unit_id = ? AND is_deleted = 0').bind(businessUnitId).all();
  const map = new Map(existing.results.map((r) => [r.code, r.id]));
  const statements = [];
  for (const a of CHART_OF_ACCOUNTS) {
    if (map.has(a.code)) continue;
    const id = newId();
    map.set(a.code, id);
    statements.push(db.prepare(`
      INSERT INTO gl_accounts (id, business_unit_id, code, name, account_type, normal_side, is_system, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,1,1,?,?)
    `).bind(id, businessUnitId, a.code, a.name, a.account_type, a.normal_side, watNowIso(), watNowIso()));
  }
  if (statements.length) await db.batch(statements);
  return map;
}

async function accountId(db, businessUnitId, code) {
  const map = await ensureChart(db, businessUnitId);
  const id = map.get(code);
  if (!id) throw new HttpError(500, `Chart of accounts is missing ${code}. Re-run the chart seed for this business.`, 'GL_ACCOUNT_MISSING');
  return id;
}

// ---------------------------------------------------------------------
// POSTING PRIMITIVES
// ---------------------------------------------------------------------
// Every posting goes through here, so the balance invariant has exactly one
// implementation to be right in.
async function postEntry(db, {
  businessUnitId, branchId = null, entryDate = null, sourceType, sourceId = null,
  reference = null, description, lines, userId = null, status = 'POSTED', entryNo = null,
}) {
  if (!Array.isArray(lines) || !lines.length) {
    throw new HttpError(400, 'A journal entry needs at least one line.', 'GL_EMPTY_ENTRY');
  }
  const accountMap = await ensureChart(db, businessUnitId);

  const prepared = [];
  let totalDebitKobo = 0;
  let totalCreditKobo = 0;
  for (const l of lines) {
    const debit = round2(Number(l.debit) || 0);
    const credit = round2(Number(l.credit) || 0);
    if (debit > 0 && credit > 0) {
      throw new HttpError(400, `Journal line for account ${l.account_code} carries both a debit and a credit. Use two lines — a line that nets to zero hides itself from the trial balance.`, 'GL_LINE_BOTH_SIDES');
    }
    if (debit < 0 || credit < 0) {
      throw new HttpError(400, 'Journal amounts cannot be negative. Reverse the sides instead.', 'GL_NEGATIVE_AMOUNT');
    }
    if (debit === 0 && credit === 0) continue;                 // a zero line is noise, not an entry
    const accountIdValue = accountMap.get(l.account_code);
    if (!accountIdValue) {
      throw new HttpError(500, `Account ${l.account_code} is not in the chart of accounts for this business.`, 'GL_ACCOUNT_MISSING');
    }
    prepared.push({ ...l, account_id: accountIdValue, debit, credit });
    totalDebitKobo += toKobo(debit);
    totalCreditKobo += toKobo(credit);
  }

  if (!prepared.length) throw new HttpError(400, 'Every journal line was zero, so there is nothing to post.', 'GL_EMPTY_ENTRY');

  // Integer-kobo comparison. Comparing floats for equality would make this
  // fail sporadically on entries that are in fact correct, and an
  // intermittently-failing accounting invariant gets switched off.
  if (totalDebitKobo !== totalCreditKobo) {
    throw new HttpError(400,
      `That journal entry does not balance: debits ₦${fromKobo(totalDebitKobo).toLocaleString('en-NG')} against credits ₦${fromKobo(totalCreditKobo).toLocaleString('en-NG')}. `
      + `Double entry requires them to be equal.`,
      'GL_ENTRY_UNBALANCED');
  }

  const ts = watNowIso();
  const id = newId();
  const no = entryNo || (await nextReference(db, { businessUnitId, prefix: PREFIXES.JOURNAL, branchCode: '*', scope: 'YEAR' })).reference;

  const statements = [
    db.prepare(`
      INSERT INTO gl_journal_entries (
        id, business_unit_id, branch_id, entry_no, entry_date, source_type, source_id, reference,
        description, total_debit, total_credit, status, posted_by, posted_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?)
    `).bind(
      id, businessUnitId, branchId || null, no, entryDate || watDate(), sourceType, sourceId || null, reference || null,
      String(description).slice(0, 500), fromKobo(totalDebitKobo), fromKobo(totalCreditKobo), status,
      userId || null, ts, ts, ts
    ),
  ];
  for (const l of prepared) {
    statements.push(db.prepare(`
      INSERT INTO gl_journal_lines (
        id, journal_entry_id, business_unit_id, branch_id, account_id, debit, credit, category_id, description, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      newId(), id, businessUnitId, branchId || l.branch_id || null, l.account_id, l.debit, l.credit,
      l.category_id || null, l.description ? String(l.description).slice(0, 500) : null, ts, ts
    ));
  }
  await db.batch(statements);
  return { entry_id: id, entry_no: no, total_debit: fromKobo(totalDebitKobo), total_credit: fromKobo(totalCreditKobo), lines: prepared.length };
}

// ---------------------------------------------------------------------
// OPERATIONAL POSTINGS
// ---------------------------------------------------------------------

// SALE. The canonical entry:
//   DR  cash / POS receivable / bank / debtor   (by tender method)
//   CR  sales revenue — goods                   (net of VAT)
//   CR  sales revenue — services                (service lines)
//   CR  VAT payable — output                    (if registered)
//   DR  cost of goods sold
//   CR  inventory at cost
//   DR  discounts allowed                       (when a discount was given)
async function postSale(db, { businessUnitId, branchId, saleId, sale, items, payments, settings, userId }) {
  const vatEnabled = vat.isVatEnabled(settings);
  const entryDate = String(sale.occurred_at || sale.created_at || '').slice(0, 10) || watDate();
  const lines = [];

  let goodsRevenue = 0;
  let serviceRevenue = 0;
  let deliveryRevenue = 0;
  let cogs = 0;
  let vatTotal = 0;

  for (const it of items) {
    const lineTotal = round2(Number(it.line_total) || 0);
    const lineVat = round2(Number(it.vat_amount) || 0);
    const net = round2(lineTotal - lineVat);
    vatTotal = round2(vatTotal + lineVat);
    if (it.is_service_line) {
      const code = String(it.service_type || '').toUpperCase();
      if (code === 'DELIVERY') deliveryRevenue = round2(deliveryRevenue + net);
      else serviceRevenue = round2(serviceRevenue + net);
    } else {
      goodsRevenue = round2(goodsRevenue + net);
      cogs = round2(cogs + (Number(it.unit_cost) || 0) * (Number(it.quantity_base) || 0));
    }
  }

  // Receipts side, split by tender so the drawer, the terminal settlement and
  // the bank each show their own movement.
  const byAccount = new Map();
  for (const p of payments) {
    const code = PAYMENT_ACCOUNT[p.method] || '1020';
    byAccount.set(code, round2((byAccount.get(code) || 0) + (Number(p.amount) || 0)));
  }
  if (Number(sale.balance_due) > 0.005 && !byAccount.has('1200')) {
    byAccount.set('1200', round2(Number(sale.balance_due)));
  } else if (Number(sale.balance_due) > 0.005) {
    byAccount.set('1200', round2((byAccount.get('1200') || 0) + Number(sale.balance_due)));
  }
  for (const [code, amount] of byAccount) {
    if (amount > 0.004) lines.push({ account_code: code, debit: amount, credit: 0, description: `Receipt ${sale.receipt_no}` });
  }

  // Discounts are a DEBIT to a contra-revenue account, not a reduction of the
  // revenue line. Both produce the same net revenue, but only this way can
  // the owner see how much margin they gave away — which is the question
  // behind every "why is revenue up and profit flat?" conversation.
  if (Number(sale.discount_amount) > 0.005) {
    lines.push({ account_code: '4900', debit: round2(Number(sale.discount_amount)), credit: 0, description: `Discount on ${sale.receipt_no}` });
  }

  if (goodsRevenue > 0.004) lines.push({ account_code: '4000', debit: 0, credit: goodsRevenue, description: `Goods sold on ${sale.receipt_no}` });
  if (serviceRevenue > 0.004) lines.push({ account_code: '4100', debit: 0, credit: serviceRevenue, description: `Services on ${sale.receipt_no}` });
  if (deliveryRevenue > 0.004) lines.push({ account_code: '4200', debit: 0, credit: deliveryRevenue, description: `Delivery on ${sale.receipt_no}` });
  if (vatEnabled && vatTotal > 0.004) lines.push({ account_code: '2100', debit: 0, credit: vatTotal, description: `Output VAT on ${sale.receipt_no}` });

  // COGS side. Posted at the batch cost actually consumed, which is why the
  // items carry unit_cost and quantity_base rather than a single margin
  // figure: margin is derived, cost is a fact.
  if (cogs > 0.004) {
    lines.push({ account_code: '5000', debit: round2(cogs), credit: 0, description: `Cost of goods on ${sale.receipt_no}` });
    lines.push({ account_code: '1100', debit: 0, credit: round2(cogs), description: `Stock issued on ${sale.receipt_no}` });
  }

  return postEntry(db, {
    businessUnitId, branchId: sale.branch_id || branchId, entryDate,
    sourceType: 'SALE', sourceId: sale.id || saleId, reference: sale.receipt_no,
    description: `Sale ${sale.receipt_no} — ₦${round2(Number(sale.total) || 0).toLocaleString('en-NG')}`,
    lines, userId,
  });
}

// VOID. A reversing entry, never a deletion.
async function reverseSale(db, { businessUnitId, branchId, saleId, reason, userId }) {
  const original = await db.prepare(`
    SELECT * FROM gl_journal_entries
    WHERE source_type = 'SALE' AND source_id = ? AND business_unit_id = ? AND status = 'POSTED' AND is_deleted = 0
    ORDER BY posted_at DESC LIMIT 1
  `).bind(saleId, businessUnitId).first();
  if (!original) return { ok: false, reason: 'NO_ORIGINAL_ENTRY' };

  const lines = await db.prepare('SELECT * FROM gl_journal_lines WHERE journal_entry_id = ? AND is_deleted = 0').bind(original.id).all();
  const accountMap = await ensureChart(db, businessUnitId);
  const codeById = new Map([...accountMap.entries()].map(([code, id]) => [id, code]));

  const reversed = lines.results
    .map((l) => ({
      account_code: codeById.get(l.account_id),
      debit: round2(Number(l.credit) || 0),        // swap sides
      credit: round2(Number(l.debit) || 0),
      category_id: l.category_id,
      description: `Reversal of ${original.entry_no}`,
    }))
    .filter((l) => l.account_code && (l.debit > 0 || l.credit > 0));

  const sale = await db.prepare('SELECT receipt_no FROM sales WHERE id = ?').bind(saleId).first();
  const entry = await postEntry(db, {
    businessUnitId, branchId, entryDate: watDate(),
    sourceType: 'SALE_VOID', sourceId: saleId, reference: sale ? sale.receipt_no : null,
    description: `Void of sale ${sale ? sale.receipt_no : saleId} — ${String(reason || '').slice(0, 200)}`,
    lines: reversed, userId,
  });
  await db.prepare(`
    UPDATE gl_journal_entries SET status = 'REVERSED', reversed_by_entry_id = ?, updated_at = ? WHERE id = ?
  `).bind(entry.entry_id, watNowIso(), original.id).run();
  return { ok: true, ...entry };
}

// PURCHASE RECEIPT. Stock comes in at cost; the creditor or the payment
// method takes the other side. Input VAT is an ASSET (recoverable) when the
// business is registered, not part of the stock cost — capitalising it would
// overstate inventory and understate the VAT position.
async function postPurchaseReceipt(db, { businessUnitId, branchId, po, receiptLines, supplierName, userId, settings }) {
  const vatEnabled = vat.isVatEnabled(settings);
  const rate = vat.normaliseRate(settings.vat_rate_percent);
  let stockCost = 0;
  let inputVat = 0;
  for (const l of receiptLines) {
    const gross = round2(Number(l.total_cost) || 0);
    if (vatEnabled && vat.vat_inclusive_pricing(settings)) {
      const extracted = vat.extractVat(gross, rate);
      stockCost = round2(stockCost + extracted.taxable);
      inputVat = round2(inputVat + extracted.vat);
    } else {
      stockCost = round2(stockCost + gross);
    }
  }
  // Freight and clearing are part of LANDED COST. Excluding them understates
  // every margin on imported goods, which for an electronics wholesaler is
  // most of the catalogue.
  const extra = round2(Number(po.freight_cost || 0) + Number(po.clearing_cost || 0) + Number(po.other_cost || 0));
  stockCost = round2(stockCost + extra);

  const lines = [{ account_code: '1100', debit: stockCost, credit: 0, description: `Stock received on ${po.po_number}` }];
  if (vatEnabled && inputVat > 0.004) {
    lines.push({ account_code: '2110', debit: inputVat, credit: 0, description: `Input VAT on ${po.po_number}` });
  }
  const creditTotal = round2(stockCost + inputVat);
  lines.push({ account_code: '2000', debit: 0, credit: creditTotal, description: `Owed to ${supplierName || 'supplier'} on ${po.po_number}` });

  return postEntry(db, {
    businessUnitId, branchId: po.branch_id || branchId, entryDate: watDate(),
    sourceType: 'PURCHASE', sourceId: po.id, reference: po.po_number,
    description: `Purchase receipt ${po.po_number} — ₦${creditTotal.toLocaleString('en-NG')}`,
    lines, userId,
  });
}

async function postSupplierPayment(db, { businessUnitId, branchId, poId, reference, amount, method, whtAmount = 0, userId }) {
  const lines = [
    { account_code: '2000', debit: round2(Number(amount) || 0), credit: 0, description: `Payment to supplier ${reference || ''}` },
    { account_code: PAYMENT_ACCOUNT[String(method).toUpperCase()] || '1020', debit: 0, credit: round2(Number(amount) - Number(whtAmount || 0)), description: `Payment ${reference || ''}` },
  ];
  if (Number(whtAmount) > 0.004) {
    lines.push({ account_code: '2120', debit: 0, credit: round2(Number(whtAmount)), description: `WHT deducted ${reference || ''}` });
  }
  return postEntry(db, {
    // sourceType must be a value the gl_journal_entries CHECK allows; there
    // is no SUPPLIER_PAYMENT in that list, and a payment against a PO is a
    // PURCHASE-sourced entry.
    businessUnitId, branchId, entryDate: watDate(), sourceType: 'PURCHASE',
    sourceId: poId, reference, description: `Supplier payment ${reference || ''}`, lines, userId,
  });
}

async function postExpense(db, { businessUnitId, branchId, expense, categoryAccountCode, userId, settings }) {
  const vatEnabled = vat.isVatEnabled(settings);
  const amount = round2(Number(expense.amount) || 0);
  const wht = round2(Number(expense.wht_amount) || 0);
  let expenseAmount = amount;
  let inputVat = 0;
  if (vatEnabled && round2(Number(expense.vat_amount) || 0) > 0) {
    inputVat = round2(Number(expense.vat_amount));
    expenseAmount = round2(amount - inputVat);
  }
  const code = categoryAccountCode || '6950';
  const lines = [
    { account_code: code, debit: expenseAmount, credit: 0, description: expense.description },
  ];
  if (inputVat > 0.004) lines.push({ account_code: '2110', debit: inputVat, credit: 0, description: `Input VAT on ${expense.reference || 'expense'}` });
  if (wht > 0.004) lines.push({ account_code: '2120', debit: 0, credit: wht, description: `WHT deducted on ${expense.reference || 'expense'}` });
  const paymentAccount = expense.paid_from_safe ? '1010' : (PAYMENT_ACCOUNT[String(expense.payment_method).toUpperCase()] || '1000');
  lines.push({ account_code: paymentAccount, debit: 0, credit: round2(amount - wht), description: `Paid ${expense.reference || ''}` });

  return postEntry(db, {
    businessUnitId, branchId: expense.branch_id || branchId, entryDate: expense.expense_date || watDate(),
    sourceType: 'EXPENSE', sourceId: expense.id, reference: expense.reference || expense.receipt_no || null,
    description: `Expense — ${String(expense.description || '').slice(0, 200)}`,
    lines, userId,
  });
}

// STOCK ADJUSTMENT. Damage and expiry are separate accounts because they are
// separately actionable: damage points at handling, expiry points at
// purchasing. Collapsing them into "shrinkage" is how a business keeps
// buying stock it cannot sell in time.
const ADJUSTMENT_ACCOUNT = Object.freeze({
  DAMAGE: '5300', LOSS: '5300', THEFT: '5300', STOCKTAKE: '5300', CORRECTION: '5300',
  EXPIRED: '5400', WRITE_OFF: '5300', SCRAP: '5300',
  FOUND: '1100', SAMPLE: '5300',
});

async function postStockAdjustment(db, { businessUnitId, branchId, adjustment, userId }) {
  const value = round2(Math.abs(Number(adjustment.value) || 0));
  if (value <= 0.004) return { ok: false, reason: 'NO_VALUE' };
  const qty = Number(adjustment.quantity) || 0;
  const account = ADJUSTMENT_ACCOUNT[String(adjustment.adjustment_type).toUpperCase()] || '5300';
  const lines = qty < 0
    ? [
      { account_code: account, debit: value, credit: 0, description: `${adjustment.adjustment_type} write-off ${adjustment.reference || ''}` },
      { account_code: '1100', debit: 0, credit: value, description: `Stock reduced ${adjustment.reference || ''}` },
    ]
    : [
      { account_code: '1100', debit: value, credit: 0, description: `Stock found/corrected ${adjustment.reference || ''}` },
      // A found item is NOT income — recognising it as revenue would inflate
      // turnover with something nobody sold. It corrects the opening equity /
      // prior-period position, which is what it actually is.
      { account_code: '3900', debit: 0, credit: value, description: `Correction ${adjustment.reference || ''}` },
    ];
  return postEntry(db, {
    businessUnitId, branchId, entryDate: watDate(),
    sourceType: 'STOCK_ADJUSTMENT', sourceId: adjustment.id, reference: adjustment.reference || null,
    description: `Stock ${adjustment.adjustment_type} — ₦${value.toLocaleString('en-NG')}`,
    lines, userId,
  });
}

// CASH MOVEMENTS between drawer, safe and bank. These are the entries that
// make a bank reconciliation possible at all: without them, "cash at hand"
// in the books grows forever and never matches a count.
async function postCashMovement(db, { businessUnitId, branchId, from, to, amount, reference, description, userId }) {
  const map = { TILL: '1000', SAFE: '1010', BANK: '1020' };
  const fromAccount = map[String(from).toUpperCase()];
  const toAccount = map[String(to).toUpperCase()];
  if (!fromAccount || !toAccount) throw new HttpError(400, 'A cash movement must be between TILL, SAFE and BANK.', 'GL_CASH_MOVEMENT_INVALID');
  if (fromAccount === toAccount) throw new HttpError(400, 'The source and destination are the same.', 'GL_CASH_MOVEMENT_SAME');
  const value = round2(Number(amount) || 0);
  if (value <= 0) throw new HttpError(400, 'A cash movement must be a positive amount.', 'GL_CASH_MOVEMENT_INVALID');
  return postEntry(db, {
    businessUnitId, branchId, entryDate: watDate(),
    sourceType: 'BANK_DEPOSIT', sourceId: reference || null, reference,
    description: description || `Cash moved ${from} → ${to}`,
    lines: [
      { account_code: toAccount, debit: value, credit: 0, description: description || reference || '' },
      { account_code: fromAccount, debit: 0, credit: value, description: description || reference || '' },
    ],
    userId,
  });
}

// WHT. A receivable credit note when a customer deducted from our invoice; a
// liability when we deducted from a supplier.
async function postWhtEntry(db, { businessUnitId, branchId, entry, userId }) {
  const amount = round2(Number(entry.wht_amount) || 0);
  if (amount <= 0.004) return { ok: false, reason: 'NO_WHT' };
  const lines = entry.direction === 'RECEIVABLE'
    ? [
      { account_code: '1230', debit: amount, credit: 0, description: `WHT credit note ${entry.credit_note_no || ''}` },
      { account_code: '1200', debit: 0, credit: amount, description: `Customer deducted WHT ${entry.counterparty_name}` },
    ]
    : [
      { account_code: '2000', debit: amount, credit: 0, description: `WHT deducted from ${entry.counterparty_name}` },
      { account_code: '2120', debit: 0, credit: amount, description: `WHT payable to FIRS ${entry.filed_period || ''}` },
    ];
  return postEntry(db, {
    businessUnitId, branchId, entryDate: entry.entry_date || watDate(),
    sourceType: 'WHT', sourceId: entry.id, reference: entry.credit_note_no || null,
    description: `Withholding tax ${entry.direction} — ${entry.counterparty_name}`,
    lines, userId,
  });
}

// ---------------------------------------------------------------------
// REPORTS
// ---------------------------------------------------------------------
async function trialBalance(db, { businessUnitId, branchId = null, asAt = null }) {
  const params = [businessUnitId];
  let scope = '';
  if (branchId) { scope = ' AND l.branch_id = ?'; params.push(branchId); }
  if (asAt) { scope += ' AND e.entry_date <= ?'; params.push(String(asAt).slice(0, 10)); }
  const rows = await db.prepare(`
    SELECT a.code, a.name, a.account_type, a.normal_side,
           COALESCE(SUM(l.debit),0) AS total_debit,
           COALESCE(SUM(l.credit),0) AS total_credit,
           CASE WHEN a.normal_side = 'DEBIT'
                THEN COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0)
                ELSE COALESCE(SUM(l.credit),0) - COALESCE(SUM(l.debit),0) END AS balance
    FROM gl_journal_lines l
    JOIN gl_accounts a ON a.id = l.account_id AND a.is_deleted = 0
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.status = 'POSTED' AND e.is_deleted = 0
    WHERE l.is_deleted = 0 AND l.business_unit_id = ? ${scope}
    GROUP BY a.code, a.name, a.account_type, a.normal_side
    ORDER BY a.code
  `).bind(...params).all();

  const accounts = rows.results.map((r) => ({
    ...r,
    total_debit: round2(r.total_debit), total_credit: round2(r.total_credit), balance: round2(r.balance),
  }));
  const totalDebit = round2(accounts.reduce((a, r) => a + r.total_debit, 0));
  const totalCredit = round2(accounts.reduce((a, r) => a + r.total_credit, 0));
  return {
    as_at: asAt || watDate(),
    accounts,
    total_debit: totalDebit,
    total_credit: totalCredit,
    // The trial balance balances when the two sides agree to the kobo.
    balances: toKobo(totalDebit) === toKobo(totalCredit),
    difference: round2(totalDebit - totalCredit),
  };
}

async function profitAndLoss(db, { businessUnitId, branchId = null, startDate, endDate }) {
  const params = [businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10)];
  let scope = '';
  if (branchId) { scope = ' AND l.branch_id = ?'; params.push(branchId); }
  const rows = await db.prepare(`
    SELECT a.code, a.name, a.account_type, a.normal_side,
           COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0) AS debit_net
    FROM gl_journal_lines l
    JOIN gl_accounts a ON a.id = l.account_id AND a.is_deleted = 0
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.status = 'POSTED' AND e.is_deleted = 0
    WHERE l.is_deleted = 0 AND l.business_unit_id = ?
      AND e.entry_date BETWEEN ? AND ? ${scope}
      AND a.account_type IN ('REVENUE','EXPENSE')
    GROUP BY a.code, a.name, a.account_type, a.normal_side
    ORDER BY a.code
  `).bind(...params).all();

  const revenue = [];
  const cogs = [];
  const expenses = [];
  for (const r of rows.results) {
    // REVENUE normal side is CREDIT, so a credit-heavy account produces a
    // NEGATIVE debit_net; negate to get the income figure.
    const amount = round2(r.account_type === 'REVENUE' && r.normal_side === 'CREDIT' ? -r.debit_net : r.debit_net);
    const line = { code: r.code, name: r.name, amount };
    if (r.account_type === 'REVENUE') revenue.push(line);
    else if (String(r.code).startsWith('5')) cogs.push(line);
    else expenses.push(line);
  }

  const grossRevenue = round2(revenue.filter((r) => r.code.startsWith('4') && !r.code.startsWith('49')).reduce((a, r) => a + r.amount, 0));
  const contraRevenue = round2(revenue.filter((r) => r.code.startsWith('49')).reduce((a, r) => a + r.amount, 0));
  const netRevenue = round2(grossRevenue - contraRevenue);
  const totalCogs = round2(cogs.reduce((a, r) => a + r.amount, 0));
  const grossProfit = round2(netRevenue - totalCogs);
  const totalExpenses = round2(expenses.reduce((a, r) => a + r.amount, 0));
  const netProfit = round2(grossProfit - totalExpenses);

  return {
    start_date: String(startDate).slice(0, 10),
    end_date: String(endDate).slice(0, 10),
    revenue: [...revenue.map((r) => ({ ...r })), { code: '', name: 'Net revenue', amount: netRevenue, is_total: true }],
    cost_of_sales: [...cogs, { code: '', name: 'Total cost of sales', amount: totalCogs, is_total: true }],
    gross_profit: grossProfit,
    gross_margin_percent: netRevenue > 0 ? round2((grossProfit / netRevenue) * 100) : 0,
    expenses: [...expenses, { code: '', name: 'Total expenses', amount: totalExpenses, is_total: true }],
    net_profit: netProfit,
    net_margin_percent: netRevenue > 0 ? round2((netProfit / netRevenue) * 100) : 0,
    total_revenue: netRevenue,
    total_expenses: round2(totalCogs + totalExpenses),
  };
}

async function balanceSheet(db, { businessUnitId, branchId = null, asAt = null }) {
  const tb = await trialBalance(db, { businessUnitId, branchId, asAt });
  const byType = { ASSET: [], LIABILITY: [], EQUITY: [], REVENUE: [], EXPENSE: [] };
  for (const a of tb.accounts) byType[a.account_type].push(a);

  const sum = (list) => round2(list.reduce((acc, a) => acc + a.balance, 0));
  const totalAssets = sum(byType.ASSET);
  const totalLiabilities = sum(byType.LIABILITY);
  // Current-period profit belongs in equity until it is appropriated. Omitting
  // it is the reason a small-business balance sheet "never balances".
  const pnl = await profitAndLoss(db, {
    businessUnitId, branchId,
    startDate: '1970-01-01', endDate: asAt || watDate(),
  });
  const totalEquity = round2(sum(byType.EQUITY) + pnl.net_profit);

  return {
    as_at: asAt || watDate(),
    assets: byType.ASSET.map((a) => ({ code: a.code, name: a.name, balance: a.balance })),
    liabilities: byType.LIABILITY.map((a) => ({ code: a.code, name: a.name, balance: a.balance })),
    equity: [
      ...byType.EQUITY.map((a) => ({ code: a.code, name: a.name, balance: a.balance })),
      { code: '', name: 'Retained profit to date', balance: pnl.net_profit },
    ],
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    total_equity: totalEquity,
    balances: Math.abs(toKobo(totalAssets) - (toKobo(totalLiabilities) + toKobo(totalEquity))) <= 1,
    difference: round2(totalAssets - (totalLiabilities + totalEquity)),
    trial_balance: { total_debit: tb.total_debit, total_credit: tb.total_credit, balances: tb.balances },
  };
}

// Integrity checks an owner can run any time. Each one names a specific
// failure rather than reporting "something is wrong": an integrity panel that
// says "check your books" is indistinguishable from one that is broken.
async function integrityCheck(db, { businessUnitId }) {
  const checks = [];

  const unbalanced = await db.prepare(`
    SELECT e.entry_no, e.total_debit, e.total_credit, e.posted_at
    FROM gl_journal_entries e
    WHERE e.business_unit_id = ? AND e.is_deleted = 0
      AND abs(e.total_debit - e.total_credit) >= 0.005
    LIMIT 20
  `).bind(businessUnitId).all();
  checks.push({
    key: 'entries_balance',
    label: 'Every journal entry balances',
    ok: unbalanced.results.length === 0,
    detail: unbalanced.results.length ? `${unbalanced.results.length} unbalanced entries, e.g. ${unbalanced.results[0].entry_no}` : 'All posted entries balance to the kobo.',
    rows: unbalanced.results,
  });

  const drafts = await db.prepare(`
    SELECT COUNT(*) AS n FROM gl_journal_entries
    WHERE business_unit_id = ? AND status = 'DRAFT' AND is_deleted = 0
  `).bind(businessUnitId).first();
  checks.push({
    key: 'no_draft_entries',
    label: 'No draft or orphan entries',
    ok: (drafts.n || 0) === 0,
    detail: drafts.n ? `${drafts.n} entries were left in DRAFT and are excluded from every report` : 'No entries stuck in draft.',
  });

  const lineless = await db.prepare(`
    SELECT e.entry_no FROM gl_journal_entries e
    WHERE e.business_unit_id = ? AND e.is_deleted = 0 AND e.status = 'POSTED'
      AND NOT EXISTS (SELECT 1 FROM gl_journal_lines l WHERE l.journal_entry_id = e.id AND l.is_deleted = 0)
    LIMIT 20
  `).bind(businessUnitId).all();
  checks.push({
    key: 'no_empty_entries',
    label: 'Every posted entry has lines',
    ok: lineless.results.length === 0,
    detail: lineless.results.length ? `${lineless.results.length} posted entries have no lines` : 'No empty entries.',
    rows: lineless.results,
  });

  const unpostedSales = await db.prepare(`
    SELECT COUNT(*) AS n FROM sales s
    WHERE s.business_unit_id = ? AND s.is_deleted = 0 AND s.status <> 'VOIDED'
      AND NOT EXISTS (SELECT 1 FROM gl_journal_entries e WHERE e.source_type = 'SALE' AND e.source_id = s.id AND e.status = 'POSTED' AND e.is_deleted = 0)
  `).bind(businessUnitId).first();
  checks.push({
    key: 'all_sales_posted',
    label: 'Every completed sale has been posted',
    ok: (unpostedSales.n || 0) === 0,
    detail: unpostedSales.n
      ? `${unpostedSales.n} sales never reached the ledger — the books understate revenue. This is a posting failure, not a data-entry gap.`
      : 'Every sale is in the ledger.',
  });

  const tb = await trialBalance(db, { businessUnitId });
  checks.push({
    key: 'trial_balance',
    label: 'Trial balance agrees',
    ok: tb.balances,
    detail: tb.balances ? `Debits ₦${tb.total_debit.toLocaleString('en-NG')} = credits ₦${tb.total_credit.toLocaleString('en-NG')}` : `Out by ₦${tb.difference.toLocaleString('en-NG')}`,
  });

  return { checks, all_ok: checks.every((c) => c.ok), checked_at: watNowIso() };
}

module.exports = {
  CHART_OF_ACCOUNTS, PAYMENT_ACCOUNT, ADJUSTMENT_ACCOUNT,
  ensureChart, accountId, postEntry,
  postSale, reverseSale, postPurchaseReceipt, postSupplierPayment, postExpense,
  postStockAdjustment, postCashMovement, postWhtEntry,
  trialBalance, profitAndLoss, balanceSheet, integrityCheck,
};
'use strict';
