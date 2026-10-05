'use strict';
// =====================================================================
// server/services/glService.js — DOUBLE-ENTRY GENERAL LEDGER
// =====================================================================
// WHY A SHOP NEEDS A REAL GENERAL LEDGER
//
// A sales report answers "what did we take?" It cannot answer "what did we
// make?", "what do we own?", or "what do we owe?" — and those are the three
// questions an owner asks once the business is big enough to need an
// accountant, a bank facility, or a tax filing that survives scrutiny.
//
// So every economic event in StockRidge posts double-entry lines:
// a sale, a return, a goods receipt, an expense, a stock adjustment, a
// transfer, a till banking, a safe movement, a debtor payment, a WHT
// deduction, a warranty cost. The reports (trial balance, P&L, balance
// sheet) are then QUERIES over those lines rather than bespoke
// aggregations over operational tables, which is the difference between
// figures that reconcile to the kobo and figures that approximately agree.
//
// THE INVARIANT
//   Every journal entry balances: total_debit = total_credit.
// This is enforced twice — by a CHECK constraint on gl_journal_entries, and
// by balanceCheck() below refusing to queue an unbalanced entry. Two
// enforcements for one rule is deliberate: the CHECK fires at commit time
// with a message nobody at a counter can act on, while balanceCheck fires at
// build time in the service that caused it, naming the entry.
//
// STATEMENT-BUILDING, NOT STATEMENT-EXECUTING
// Every function here returns an ARRAY of { sql, params } rather than
// writing. That is what lets a caller queue them inside its own atomic
// transaction: a sale and its journal entry commit together or not at all.
// A GL that wrote independently of the sale it describes would, under a
// crash between the two, produce books that do not match the shop.
//
// VAT AND COGS
// VAT is never revenue. On a VAT-inclusive sale the entry splits the total
// into net revenue and VAT payable to FIRS, because the shop is collecting
// that money on the government's behalf and it is not theirs to spend.
// Cost of goods sold posts at the SAME time as the revenue (not when stock
// is purchased), so a month's P&L matches the cost of the goods it actually
// sold against the revenue they earned. Purchasing stock is an asset
// movement — cash into inventory — and touches no P&L account at all.
// =====================================================================

const { newId } = require('../../domain/crypto');
const { round2 } = require('../../domain/money');
const { watToday } = require('../../domain/time');

// ---------------------------------------------------------------------
// CHART OF ACCOUNTS
// ---------------------------------------------------------------------
// Seeded per business. Codes follow the common Nigerian small-business
// convention (1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue,
// 5xxx cost of sales, 6xxx expenses) so an accountant handed an export
// recognises it immediately rather than needing a mapping document.
const CHART_OF_ACCOUNTS = Object.freeze([
  { code: '1000', name: 'Cash at Till', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1010', name: 'Cash in Safe', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1020', name: 'Bank Account', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1030', name: 'POS Terminal Settlements', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1040', name: 'Mobile Money Wallet', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1100', name: 'Inventory — Stock on Hand', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1110', name: 'Inventory — Goods in Transit', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1200', name: 'Debtors — Trade Receivables', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1210', name: 'Instalment Plans Receivable', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1220', name: 'Change Owed to Customers', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1300', name: 'Withholding Tax Receivable', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '1500', name: 'Delivery Vehicles & Equipment', type: 'ASSET', side: 'DEBIT', control: false },
  { code: '1510', name: 'Accumulated Depreciation', type: 'ASSET', side: 'CREDIT', control: false },

  { code: '2000', name: 'Creditors — Trade Payables', type: 'LIABILITY', side: 'CREDIT', control: true },
  { code: '2100', name: 'VAT Payable to FIRS', type: 'LIABILITY', side: 'CREDIT', control: true },
  { code: '2110', name: 'Withholding Tax Payable', type: 'LIABILITY', side: 'CREDIT', control: true },
  { code: '2200', name: 'Customer Deposits & Layaway', type: 'LIABILITY', side: 'CREDIT', control: true },
  { code: '2210', name: 'Change Owed Liability', type: 'LIABILITY', side: 'CREDIT', control: true },
  { code: '2300', name: 'Staff Wages Payable', type: 'LIABILITY', side: 'CREDIT', control: false },

  { code: '3000', name: "Owner's Capital", type: 'EQUITY', side: 'CREDIT', control: false },
  { code: '3100', name: 'Retained Earnings', type: 'EQUITY', side: 'CREDIT', control: false },
  { code: '3200', name: 'Drawings', type: 'EQUITY', side: 'DEBIT', control: false },

  { code: '4000', name: 'Sales Revenue', type: 'REVENUE', side: 'CREDIT', control: true },
  { code: '4010', name: 'Wholesale Revenue', type: 'REVENUE', side: 'CREDIT', control: true },
  { code: '4100', name: 'Delivery & Installation Income', type: 'REVENUE', side: 'CREDIT', control: true },
  { code: '4200', name: 'Sales Returns & Allowances', type: 'REVENUE', side: 'DEBIT', control: true },
  { code: '4300', name: 'Discounts Allowed', type: 'REVENUE', side: 'DEBIT', control: true },
  { code: '4400', name: 'Instalment Interest Income', type: 'REVENUE', side: 'CREDIT', control: true },
  { code: '4500', name: 'Other Income', type: 'REVENUE', side: 'CREDIT', control: false },

  { code: '5000', name: 'Cost of Goods Sold', type: 'EXPENSE', side: 'DEBIT', control: true },
  { code: '5100', name: 'Stock Write-off — Damage', type: 'EXPENSE', side: 'DEBIT', control: true },
  { code: '5110', name: 'Stock Write-off — Shrinkage & Theft', type: 'EXPENSE', side: 'DEBIT', control: true },
  { code: '5120', name: 'Stock Write-off — Expired', type: 'EXPENSE', side: 'DEBIT', control: true },
  { code: '5130', name: 'Stocktake Variance', type: 'EXPENSE', side: 'DEBIT', control: true },
  { code: '5200', name: 'Warranty & Repair Costs', type: 'EXPENSE', side: 'DEBIT', control: true },
  { code: '5300', name: 'Freight & Customs (capitalised)', type: 'EXPENSE', side: 'DEBIT', control: false },

  { code: '6000', name: 'Rent & Rates', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6010', name: 'Salaries & Wages', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6020', name: 'Diesel, Fuel & Power', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6030', name: 'Electricity', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6040', name: 'Transport & Logistics', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6050', name: 'Security', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6060', name: 'Repairs & Maintenance', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6070', name: 'Marketing & Advertising', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6080', name: 'Bank Charges', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6090', name: 'Internet & Airtime', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6100', name: 'Cleaning & Consumables', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6110', name: 'Depreciation', type: 'EXPENSE', side: 'DEBIT', control: false },
  { code: '6900', name: 'Sundry Expenses', type: 'EXPENSE', side: 'DEBIT', control: false },

  { code: '7000', name: 'Intercompany — Due From', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '7010', name: 'Intercompany — Due To', type: 'LIABILITY', side: 'CREDIT', control: true },
]);

/** Map an expense category string to an account code. */
const EXPENSE_CATEGORY_ACCOUNTS = Object.freeze({
  RENT: '6000', RATES: '6000',
  SALARY_WAGES: '6010', SALARY: '6010', WAGES: '6010', PAYROLL: '6010',
  DIESEL_FUEL: '6020', DIESEL: '6020', FUEL: '6020', GENERATOR: '6020', POWER: '6020',
  ELECTRICITY: '6030', NEPA: '6030', PHCN: '6030',
  TRANSPORT_LOGISTICS: '6040', TRANSPORT: '6040', LOGISTICS: '6040', HAULAGE: '6040', DELIVERY: '6040',
  SECURITY: '6050',
  REPAIRS_MAINTENANCE: '6060', REPAIRS: '6060', MAINTENANCE: '6060',
  MARKETING: '6070', ADVERTISING: '6070', SIGNAGE: '6070',
  BANK_CHARGES: '6080', POS_CHARGES: '6080',
  INTERNET_AIRTIME: '6090', INTERNET: '6090', AIRTIME: '6090', DATA: '6090',
  CLEANING: '6100', PACKAGING_MATERIALS: '6100', CONSUMABLES: '6100',
  DEPRECIATION: '6110',
  SITE_EXPENSES: '6900', EQUIPMENT_HIRE: '6900', LOADERS_PORTERS: '6040',
  SHRINKAGE: '5110',
  MISC: '6900', OTHER: '6900',
});

/** Map a stock adjustment type to a write-off account. */
const ADJUSTMENT_ACCOUNTS = Object.freeze({
  DAMAGE: '5100',
  THEFT: '5110',
  SHRINKAGE: '5110',
  EXPIRED: '5120',
  COUNT_VARIANCE: '5130',
  WRITE_OFF: '5110',
  SAMPLE: '6070',
  FOUND: '4500',
  RETURN_TO_SUPPLIER: '2000',
  OTHER: '6900',
});

const ACCOUNT_BY_CODE = Object.freeze(Object.fromEntries(CHART_OF_ACCOUNTS.map((a) => [a.code, a])));

// ---------------------------------------------------------------------
// SEEDING
// ---------------------------------------------------------------------
/**
 * Statements that create the chart of accounts for a business.
 * Called by provisioningService when a business is created, and by the seed
 * tool. Idempotent: an existing code is skipped rather than duplicated,
 * because re-running provisioning must not corrupt a live set of books.
 */
function seedChartStatements({ businessId, accountsByCode }) {
  const statements = [];
  for (const def of CHART_OF_ACCOUNTS) {
    if (accountsByCode && accountsByCode.has(def.code)) continue;
    statements.push({
      sql: `INSERT INTO gl_accounts (id, business_id, code, name, account_type, is_system, is_control, normal_side, is_active, created_at, updated_at)
            VALUES (?,?,?,?,?,1,?,?,1, datetime('now'), datetime('now'))`,
      params: [newId(), String(businessId), def.code, def.name, def.type, def.control ? 1 : 0, def.side],
    });
  }
  return statements;
}

async function loadAccountCodes(db, businessId) {
  const rows = await db.all(
    'SELECT code, id FROM gl_accounts WHERE (business_id = ? OR business_id IS NULL) AND is_deleted = 0',
    [String(businessId)],
  );
  return new Map(rows.map((r) => [r.code, r.id]));
}

// ---------------------------------------------------------------------
// ENTRY BUILDING
// ---------------------------------------------------------------------
/**
 * Build one balanced journal entry.
 *
 * `lines` is [{ accountCode, debit, credit, branchId?, categoryId?, description? }].
 * Throws if it does not balance — a caller that produced an unbalanced entry
 * has a bug, and the bug must surface at the point it was written rather
 * than as a CHECK failure three layers away.
 */
function buildEntry({ businessId, branchId = null, entryDate = null, sourceType, sourceId = null, description = null, lines, postedBy = null, accountIds }) {
  const resolved = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    const debit = round2(Number(line.debit) || 0);
    const credit = round2(Number(line.credit) || 0);
    if (debit === 0 && credit === 0) continue; // a zero line is noise, not an entry
    if (debit > 0 && credit > 0) {
      throw new Error(`Journal line for account ${line.accountCode} has BOTH a debit and a credit. Split it into two lines — a single line cannot be both.`);
    }
    const accountId = accountIds ? accountIds.get(line.accountCode) : null;
    if (accountIds && !accountId) {
      throw new Error(`Chart of accounts has no account with code "${line.accountCode}" for this business. The books cannot post to an account that does not exist.`);
    }
    resolved.push({
      accountId,
      accountCode: line.accountCode,
      branchId: line.branchId ? String(line.branchId) : (branchId ? String(branchId) : null),
      debit, credit,
      categoryId: line.categoryId ? String(line.categoryId) : null,
      description: line.description || description || null,
      referenceType: sourceType,
      referenceId: sourceId ? String(sourceId) : null,
    });
    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);
  }

  if (!resolved.length) return []; // nothing to post is not an error
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    throw new Error(
      `Unbalanced journal entry for ${sourceType} ${sourceId || ''}: debits ₦${totalDebit} against credits ₦${totalCredit}, a difference of ₦${round2(Math.abs(totalDebit - totalCredit))}. `
      + 'The books must balance to the kobo, so this entry was refused rather than posted.',
    );
  }

  const entryId = newId();
  const statements = [{
    sql: `INSERT INTO gl_journal_entries (id, business_id, branch_id, entry_no, entry_date, source_type, source_id, description, total_debit, total_credit, posted_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
    params: [
      entryId, String(businessId), branchId ? String(branchId) : null,
      `JE-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`,
      entryDate || watToday(), sourceType, sourceId ? String(sourceId) : null,
      description || null, totalDebit, totalCredit, postedBy ? String(postedBy) : null,
    ],
  }];
  for (const line of resolved) {
    statements.push({
      sql: `INSERT INTO gl_journal_lines (id, journal_entry_id, account_id, branch_id, description, debit, credit, category_id, reference_type, reference_id, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
      params: [newId(), entryId, line.accountId, line.branchId, line.description, line.debit, line.credit, line.categoryId, line.referenceType, line.referenceId],
    });
  }
  return statements;
}

// ---------------------------------------------------------------------
// POSTING RULES
// ---------------------------------------------------------------------

/**
 * A completed sale.
 *
 *   DR  the asset that received value (cash / POS settlement / bank /
 *       wallet / debtors, one leg per payment method)
 *   CR  Sales Revenue  — net of VAT
 *   CR  VAT Payable    — the VAT component, which is FIRS's money
 *   DR  Cost of Goods Sold
 *   CR  Inventory      — the stock that left, at its snapshot cost
 *
 * The COGS legs are what make a month's profit real. Without them a P&L
 * shows revenue with no cost and every month looks enormously profitable
 * right up to the moment the owner counts the cash.
 */
function postSaleStatements({ saleId, business, branch, totals, vat, payments, lines, isCredit, balanceDue, changeOwed, user, receiptNo, accountIds, customer }) {
  const statements = [];
  const revenueAccount = String(totals && totals.saleType || '').toUpperCase() === 'WHOLESALE' ? '4010' : '4000';
  const netRevenue = round2(totals.subtotal - totals.discountAmount - vat.vatAmount);

  const assetLegs = [];
  const byMethod = {};
  for (const leg of payments || []) byMethod[leg.method] = round2((byMethod[leg.method] || 0) + Number(leg.amount));

  const METHOD_ACCOUNTS = {
    CASH: '1000', POS_TERMINAL: '1030', BANK_TRANSFER: '1020', MOBILE_MONEY: '1040',
    USSD: '1040', CHEQUE: '1020', CREDIT: '1200', INSTALMENT: '1210',
    DEPOSIT: '2200', GIFT_CARD: '2200', VOUCHER: '4300', OTHER: '1020',
  };
  for (const [method, amount] of Object.entries(byMethod)) {
    if (amount <= 0) continue;
    assetLegs.push({ accountCode: METHOD_ACCOUNTS[method] || '1020', debit: amount, description: `${method.replace(/_/g, ' ').toLowerCase()} received` });
  }
  if (isCredit && balanceDue > 0 && !assetLegs.some((l) => l.accountCode === '1200')) {
    assetLegs.push({ accountCode: '1200', debit: balanceDue, description: `Credit extended to ${customer ? customer.name : 'customer'}` });
  }
  const saleLines = [
    ...assetLegs.filter((l) => l.debit > 0 || l.credit > 0),
    { accountCode: revenueAccount, credit: Math.max(0, netRevenue), description: `Sales, receipt ${receiptNo}` },
  ];
  if (vat.vatAmount > 0) saleLines.push({ accountCode: '2100', credit: vat.vatAmount, description: `VAT at ${vat.vatRatePercent}% extracted from inclusive prices` });
  if (totals.deliveryFee > 0) saleLines.push({ accountCode: '4100', credit: totals.deliveryFee, description: 'Delivery & installation charge' });
  // CHANGE OWED. The customer handed over more cash than the sale total and the
  // till could not give the difference back, so the shop is holding it. That
  // makes it a LIABILITY, credited here in the SAME entry as the cash that
  // arrived.
  //
  // It cannot be a separate entry. Posting "DR cash / CR change owed" on its own
  // would count the retained notes twice: the asset legs above already debit the
  // full amount tendered, so a second debit books cash the drawer never
  // received and the trial balance still balances while the cash account is
  // wrong. Booking it as a discount would be worse again — it would understate
  // both revenue and the amount owed back.
  if (changeOwed > 0) {
    saleLines.push({
      accountCode: '2210', credit: changeOwed,
      description: `Change owed to ${customer ? customer.name : 'customer'}, claim issued on receipt ${receiptNo}`,
    });
  }

  // Per-category revenue detail is carried on the COGS lines below (which
  // take categoryId) and on sale_items.category_id, so v_revenue_by_category
  // and the department report can be produced without re-joining sales.

  statements.push(...buildEntry({
    businessId: business.id, branchId: branch.id, sourceType: 'SALE', sourceId: saleId,
    description: `Sale receipt ${receiptNo}`, postedBy: user && user.id, accountIds, lines: saleLines,
  }));

  // COGS and inventory relief, per line so the category axis is preserved.
  const cogsLines = [];
  for (const line of lines || []) {
    if (line.totalCost <= 0) continue;
    cogsLines.push({ accountCode: '5000', debit: line.totalCost, categoryId: line.categoryId, description: `${line.productName} — cost of sale` });
  }
  const totalCogs = round2(cogsLines.reduce((a, l) => a + l.debit, 0));
  if (totalCogs > 0) {
    cogsLines.push({ accountCode: '1100', credit: totalCogs, description: 'Inventory relieved at cost' });
    statements.push(...buildEntry({
      businessId: business.id, branchId: branch.id, sourceType: 'SALE', sourceId: saleId,
      description: `Cost of goods sold, receipt ${receiptNo}`, postedBy: user && user.id, accountIds, lines: cogsLines,
    }));
  }

  // Discounts allowed, shown separately so gross margin before discount is
  // recoverable. A discount buried inside revenue cannot be reported on.
  if (totals.discountAmount > 0) {
    statements.push(...buildEntry({
      businessId: business.id, branchId: branch.id, sourceType: 'SALE', sourceId: saleId,
      description: `Discounts allowed, receipt ${receiptNo}`, accountIds,
      lines: [
        { accountCode: '4300', debit: totals.discountAmount, description: 'Discounts allowed' },
        { accountCode: revenueAccount, credit: totals.discountAmount, description: 'Revenue reduced by discount' },
      ],
    }));
  }
  return statements;
}

/**
 * Reverse a voided or fully refunded sale.
 *
 * A REVERSAL, not a deletion. The original entry stays; a compensating entry
 * with source_type SALE_RETURN (or the same source with is_reversing) is
 * added. Deleting the original would make the books look as though the sale
 * never happened, which is precisely the appearance a fraudulent void is
 * trying to create — and the audit trail would then be the only evidence,
 * rather than the books themselves.
 */
function reverseSaleStatements({ sale, items, business, branch, user, reason, accountIds, sourceType = 'SALE_RETURN' }) {
  const statements = [];
  const revenueAccount = String(sale.sale_type || '').toUpperCase() === 'WHOLESALE' ? '4010' : '4000';
  const netRevenue = round2(Number(sale.subtotal) - Number(sale.discount_amount) - Number(sale.vat_amount));
  const amount = round2(Number(sale.amount_paid) || 0);

  const lines = [];
  if (amount > 0) lines.push({ accountCode: '1000', credit: amount, description: `Refund of receipt ${sale.receipt_no}` });
  const balance = round2(Number(sale.balance_due) || 0);
  if (balance > 0) lines.push({ accountCode: '1200', credit: balance, description: 'Credit sale reversed — receivable removed' });
  if (netRevenue > 0) lines.push({ accountCode: revenueAccount, debit: netRevenue, description: `Revenue reversed: ${reason}` });
  if (Number(sale.vat_amount) > 0) lines.push({ accountCode: '2100', debit: round2(Number(sale.vat_amount)), description: 'VAT reversed — no longer collectible' });
  if (Number(sale.discount_amount) > 0) lines.push({ accountCode: '4300', credit: round2(Number(sale.discount_amount)), description: 'Discount reversed' });

  // Balance the entry: any residual is the difference between what was
  // recorded and what is being reversed, which happens when a partial refund
  // was already taken. It goes to Sales Returns & Allowances so it is
  // visible as such rather than silently absorbed.
  const dr = round2(lines.reduce((a, l) => a + (l.debit || 0), 0));
  const cr = round2(lines.reduce((a, l) => a + (l.credit || 0), 0));
  if (Math.abs(dr - cr) > 0.005) {
    const diff = round2(dr - cr);
    if (diff > 0) lines.push({ accountCode: '4200', credit: diff, description: 'Balancing figure on reversal' });
    else lines.push({ accountCode: '4200', debit: -diff, description: 'Balancing figure on reversal' });
  }

  statements.push(...buildEntry({
    businessId: business.id, branchId: branch.id, sourceType, sourceId: sale.id,
    description: `Void/reversal of receipt ${sale.receipt_no}: ${reason}`, postedBy: user && user.id, accountIds, lines,
  }));

  // Restore inventory value at the snapshot cost, and reverse COGS.
  const cogs = round2((items || []).reduce((a, i) => a + Number(i.quantity_in_base) * Number(i.cost_price_snapshot || 0), 0));
  if (cogs > 0) {
    statements.push(...buildEntry({
      businessId: business.id, branchId: branch.id, sourceType, sourceId: sale.id,
      description: `Stock restored to inventory, receipt ${sale.receipt_no}`, accountIds,
      lines: [
        { accountCode: '1100', debit: cogs, description: 'Inventory restored at cost' },
        { accountCode: '5000', credit: cogs, description: 'Cost of goods sold reversed' },
      ],
    }));
  }
  return statements;
}

/**
 * Receiving stock against a purchase order.
 *
 *   DR Inventory (cost) / DR Inventory (freight allocation)
 *   CR Creditors  — if bought on credit
 *   CR Cash/Bank  — if paid on delivery
 *
 * Purchasing stock is an ASSET MOVEMENT. It touches no P&L account, which is
 * the single most common bookkeeping error in a small shop: treating a
 * ₦5m stock purchase as a ₦5m expense makes the month look catastrophically
 * loss-making while the cash merely changed form.
 */
function postPurchaseReceiptStatements({ businessId, branchId, poId, items, supplier, paidNow = 0, onCredit = 0, freightTotal = 0, user, accountIds, whtAmount = 0, whtAccountCode = '2110' }) {
  const stockValue = round2((items || []).reduce((a, i) => a + Number(i.quantity_received) * Number(i.cost_per_unit || 0), 0));
  const freight = round2(Number(freightTotal) || 0);
  const lines = [];
  if (stockValue > 0) lines.push({ accountCode: '1100', debit: stockValue, description: 'Stock received at cost' });
  if (freight > 0) lines.push({ accountCode: '1100', debit: freight, description: 'Freight, clearing and customs capitalised into stock cost' });

  const credit = round2(Number(onCredit) || 0);
  const paid = round2(Number(paidNow) || 0);
  const wht = round2(Number(whtAmount) || 0);
  if (credit > 0) lines.push({ accountCode: '2000', credit: credit, description: `Owed to ${supplier ? supplier.name : 'supplier'}` });
  if (paid > 0) lines.push({ accountCode: '1020', credit: paid, description: 'Paid on delivery' });
  if (wht > 0) lines.push({ accountCode: whtAccountCode, credit: wht, description: 'Withholding tax deducted at source' });

  const dr = round2(lines.reduce((a, l) => a + (l.debit || 0), 0));
  const cr = round2(lines.reduce((a, l) => a + (l.credit || 0), 0));
  if (Math.abs(dr - cr) > 0.005) {
    const diff = round2(dr - cr);
    if (diff > 0) lines.push({ accountCode: '2000', credit: diff, description: 'Balance owed to supplier' });
    else lines.push({ accountCode: '1020', debit: -diff, description: 'Balance paid' });
  }

  return buildEntry({
    businessId, branchId, sourceType: 'PURCHASE', sourceId: poId,
    description: `Goods received${supplier ? ` from ${supplier.name}` : ''}`, postedBy: user && user.id, accountIds, lines,
  });
}

/** An expense. Category maps to an account; VAT input and WHT are split out. */
function postExpenseStatements({ expense, business, branch, user, accountIds, vatInput = 0, whtAmount = 0 }) {
  const code = EXPENSE_CATEGORY_ACCOUNTS[String(expense.category || '').toUpperCase()] || '6900';
  const gross = round2(Number(expense.amount) || 0);
  const vat = round2(Number(vatInput) || 0);
  const wht = round2(Number(whtAmount) || 0);
  const netCash = round2(gross - wht);
  const lines = [
    { accountCode: code, debit: round2(gross - vat), description: expense.description },
  ];
  if (vat > 0) lines.push({ accountCode: '1300', debit: vat, description: 'Input VAT recoverable' });
  const payAccount = String(expense.paid_from || 'TILL').toUpperCase() === 'SAFE' ? '1010'
    : String(expense.paid_from || '').toUpperCase() === 'BANK' ? '1020' : '1000';
  if (netCash > 0) lines.push({ accountCode: payAccount, credit: netCash, description: `Paid from ${String(expense.paid_from || 'till').toLowerCase()}` });
  if (wht > 0) lines.push({ accountCode: '2110', credit: wht, description: 'WHT deducted, payable to FIRS' });

  const dr = round2(lines.reduce((a, l) => a + (l.debit || 0), 0));
  const cr = round2(lines.reduce((a, l) => a + (l.credit || 0), 0));
  if (Math.abs(dr - cr) > 0.005) {
    lines.push({ accountCode: '6900', debit: round2(cr - dr), description: 'Balancing figure' });
  }
  return buildEntry({
    businessId: business.id, branchId: branch.id, sourceType: 'EXPENSE', sourceId: expense.id,
    description: expense.description, postedBy: user && user.id, accountIds, lines,
  });
}

/** A stock adjustment (write-off or found stock). */
function postAdjustmentStatements({ adjustment, business, branch, accountIds, user }) {
  const value = round2(Math.abs(Number(adjustment.total_value) || 0));
  if (value <= 0) return [];
  const writeOffAccount = ADJUSTMENT_ACCOUNTS[String(adjustment.adjustment_type || 'OTHER').toUpperCase()] || '6900';
  const removing = Number(adjustment.quantity) < 0;
  return buildEntry({
    businessId: business.id, branchId: branch.id, sourceType: 'STOCK_ADJUSTMENT', sourceId: adjustment.id,
    description: `${adjustment.adjustment_type.replace(/_/g, ' ').toLowerCase()}: ${adjustment.reason || 'no reason given'}`,
    postedBy: user && user.id, accountIds,
    lines: removing
      ? [
        { accountCode: writeOffAccount, debit: value, description: 'Stock written off' },
        { accountCode: '1100', credit: value, description: 'Inventory relieved' },
      ]
      : [
        // FOUND stock is income, not free inventory: something was purchased
        // and never recorded, so recognising it as other income keeps the
        // books honest about where the value came from.
        { accountCode: '1100', debit: value, description: 'Stock found / added' },
        { accountCode: '4500', credit: value, description: 'Other income — stock recovered' },
      ],
  });
}

/**
 * A branch-to-branch transfer within the SAME business.
 *
 * No P&L effect and no net asset change: inventory moves from one location
 * to another inside one legal entity. The entry exists so each BRANCH's
 * stock value is separately attributable, which is what makes a per-branch
 * balance sheet possible at all.
 */
function postTransferStatements({ transfer, business, fromBranch, toBranch, value, accountIds, user }) {
  const amount = round2(Number(value) || 0);
  if (amount <= 0) return [];
  return buildEntry({
    businessId: business.id, branchId: fromBranch.id, sourceType: 'TRANSFER', sourceId: transfer.id,
    description: `Stock transfer ${transfer.reference}: ${fromBranch.name} to ${toBranch.name}`, postedBy: user && user.id, accountIds,
    lines: [
      { accountCode: '1110', debit: amount, branchId: toBranch.id, description: 'Goods in transit, received' },
      { accountCode: '1100', credit: amount, branchId: fromBranch.id, description: 'Inventory dispatched' },
    ],
  });
}

/**
 * An INTER-BUSINESS transfer.
 *
 * This is a sale between two legal entities and must be treated as one:
 * the sending business records a receivable and revenue at transfer price,
 * the receiving business records a payable and inventory at the same price.
 * Without this the two businesses' margins silently cross-subsidise each
 * other and neither P&L is true — which matters the moment the owner wants
 * to know whether the furniture shop or the electronics shop is actually
 * making money.
 */
function postIntercompanyTransferStatements({ transfer, fromBusiness, toBusiness, fromBranch, toBranch, value, accountIds, user }) {
  const amount = round2(Number(value) || 0);
  if (amount <= 0) return [];
  return [
    ...buildEntry({
      businessId: fromBusiness.id, branchId: fromBranch.id, sourceType: 'INTERCOMPANY', sourceId: transfer.id,
      description: `Intercompany sale to ${toBusiness.name}, transfer ${transfer.reference}`, postedBy: user && user.id, accountIds,
      lines: [
        { accountCode: '7000', debit: amount, description: `Due from ${toBusiness.name}` },
        { accountCode: '4000', credit: amount, description: 'Intercompany revenue at transfer price' },
      ],
    }),
    ...buildEntry({
      businessId: toBusiness.id, branchId: toBranch.id, sourceType: 'INTERCOMPANY', sourceId: transfer.id,
      description: `Intercompany purchase from ${fromBusiness.name}, transfer ${transfer.reference}`, postedBy: user && user.id, accountIds,
      lines: [
        { accountCode: '1100', debit: amount, description: 'Inventory received at transfer price' },
        { accountCode: '7010', credit: amount, description: `Due to ${fromBusiness.name}` },
      ],
    }),
  ];
}

/** Banking cash from the till or safe into the bank. */
function postBankingStatements({ businessId, branchId, amount, from = 'TILL', reference = null, accountIds, user }) {
  const value = round2(Number(amount) || 0);
  if (value <= 0) return [];
  const fromAccount = String(from).toUpperCase() === 'SAFE' ? '1010' : '1000';
  return buildEntry({
    businessId, branchId, sourceType: 'SAFE', sourceId: reference,
    description: `Banked ${String(from).toLowerCase()} cash`, postedBy: user && user.id, accountIds,
    lines: [
      { accountCode: '1020', debit: value, description: 'Banked' },
      { accountCode: fromAccount, credit: value, description: 'Cash out of the shop' },
    ],
  });
}

/** A customer pays down their debt. */
function postDebtorPaymentStatements({ businessId, branchId, customerId, customerName, amount, method = 'CASH', reference = null, accountIds, user }) {
  const value = round2(Number(amount) || 0);
  if (value <= 0) return [];
  const assetAccount = { CASH: '1000', BANK_TRANSFER: '1020', POS_TERMINAL: '1030', MOBILE_MONEY: '1040', USSD: '1040', CHEQUE: '1020' }[String(method).toUpperCase()] || '1000';
  return buildEntry({
    businessId, branchId, sourceType: 'DEBTOR_PAYMENT', sourceId: reference,
    description: `Payment from ${customerName || 'customer'}`, postedBy: user && user.id, accountIds,
    lines: [
      { accountCode: assetAccount, debit: value, description: 'Received' },
      { accountCode: '1200', credit: value, description: 'Receivable reduced' },
    ],
  });
}

/** A payment to a supplier. */
function postCreditorPaymentStatements({ businessId, branchId, supplierId, supplierName, amount, method = 'BANK_TRANSFER', reference = null, whtAmount = 0, accountIds, user }) {
  const value = round2(Number(amount) || 0);
  if (value <= 0) return [];
  const wht = round2(Number(whtAmount) || 0);
  const assetAccount = String(method).toUpperCase() === 'CASH' ? '1000' : '1020';
  const lines = [{ accountCode: '2000', debit: value, description: `Paid to ${supplierName || 'supplier'}` }];
  if (wht > 0) lines.push({ accountCode: '2110', credit: wht, description: 'WHT deducted' });
  lines.push({ accountCode: assetAccount, credit: round2(value - wht), description: 'Cash out' });
  return buildEntry({
    businessId, branchId, sourceType: 'CREDITOR_PAYMENT', sourceId: reference,
    description: `Supplier payment to ${supplierName || 'supplier'}`, postedBy: user && user.id, accountIds, lines,
  });
}

/** A warranty repair or replacement cost. */
function postWarrantyStatements({ claim, businessId, branchId, costToBusiness, supplierRecovery = 0, accountIds, user }) {
  const cost = round2(Number(costToBusiness) || 0);
  const recovery = round2(Number(supplierRecovery) || 0);
  if (cost <= 0 && recovery <= 0) return [];
  const lines = [];
  if (cost > 0) lines.push({ accountCode: '5200', debit: cost, description: `Warranty claim ${claim.claim_no}` });
  if (recovery > 0) lines.push({ accountCode: '1200', debit: recovery, description: `Recoverable from supplier, claim ${claim.claim_no}` });
  const dr = round2(lines.reduce((a, l) => a + l.debit, 0));
  lines.push({ accountCode: '1000', credit: dr, description: 'Warranty work paid out' });
  return buildEntry({
    businessId, branchId, sourceType: 'WARRANTY', sourceId: claim.id,
    description: `Warranty claim ${claim.claim_no}`, postedBy: user && user.id, accountIds, lines,
  });
}

/** An instalment interest recognition (accrual, not cash). */
function postInstalmentInterestStatements({ plan, amount, accountIds, businessId, branchId, user }) {
  const value = round2(Number(amount) || 0);
  if (value <= 0) return [];
  return buildEntry({
    businessId, branchId, sourceType: 'INSTALMENT', sourceId: plan.id,
    description: `Instalment interest on plan ${plan.plan_no}`, postedBy: user && user.id, accountIds,
    lines: [
      { accountCode: '1210', debit: value, description: 'Interest added to the receivable' },
      { accountCode: '4400', credit: value, description: 'Instalment interest income' },
    ],
  });
}

// ---------------------------------------------------------------------
// REPORTS
// ---------------------------------------------------------------------

/**
 * Trial balance. The control total for everything else: if this does not
 * balance, no other report can be trusted.
 */
async function trialBalance(db, { businessId = null, asAt = null, branchId = null } = {}) {
  const where = ["a.is_deleted = 0", "e.is_deleted = 0", "l.is_deleted = 0"];
  const params = [];
  if (businessId) { where.push('e.business_id = ?'); params.push(String(businessId)); }
  if (branchId) { where.push('l.branch_id = ?'); params.push(String(branchId)); }
  if (asAt) { where.push('e.entry_date <= ?'); params.push(String(asAt)); }

  const rows = await db.all(`
    SELECT a.code, a.name, a.account_type, a.normal_side,
           SUM(l.debit) AS total_debit, SUM(l.credit) AS total_credit,
           SUM(l.debit) - SUM(l.credit) AS debit_balance
    FROM gl_accounts a
    JOIN gl_journal_lines l ON l.account_id = a.id
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE ${where.join(' AND ')}
    GROUP BY a.id
    ORDER BY a.code`, params);

  let totalDebit = 0; let totalCredit = 0;
  const accounts = rows.map((r) => {
    const debit = round2(Number(r.total_debit) || 0);
    const credit = round2(Number(r.total_credit) || 0);
    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);
    // The natural balance of an account is on its normal side; the opposite
    // sign means a contra movement (e.g. a credit to an asset).
    const normal = String(r.normal_side).toUpperCase() === 'DEBIT';
    const net = round2(debit - credit);
    return {
      code: r.code, name: r.name, accountType: r.account_type, normalSide: r.normal_side,
      totalDebit: debit, totalCredit: credit,
      balance: normal ? net : -net,
      balanceSide: normal ? (net >= 0 ? 'DEBIT' : 'CREDIT') : (net <= 0 ? 'CREDIT' : 'DEBIT'),
    };
  });

  return {
    asAt: asAt || watToday(),
    accounts,
    totalDebit, totalCredit,
    balances: Math.abs(totalDebit - totalCredit) <= 0.005,
    difference: round2(Math.abs(totalDebit - totalCredit)),
  };
}

/** Profit and loss for a period. */
async function profitAndLoss(db, { businessId = null, branchId = null, startDate, endDate } = {}) {
  const where = ["a.is_deleted = 0", "e.is_deleted = 0", "l.is_deleted = 0", "a.account_type IN ('REVENUE','EXPENSE')"];
  const params = [];
  if (businessId) { where.push('e.business_id = ?'); params.push(String(businessId)); }
  if (branchId) { where.push('l.branch_id = ?'); params.push(String(branchId)); }
  if (startDate) { where.push('e.entry_date >= ?'); params.push(String(startDate)); }
  if (endDate) { where.push('e.entry_date <= ?'); params.push(String(endDate)); }

  const rows = await db.all(`
    SELECT a.code, a.name, a.account_type, a.normal_side,
           SUM(l.debit) AS total_debit, SUM(l.credit) AS total_credit
    FROM gl_accounts a
    JOIN gl_journal_lines l ON l.account_id = a.id
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE ${where.join(' AND ')}
    GROUP BY a.id ORDER BY a.code`, params);

  const revenue = []; const cogs = []; const expenses = [];
  let totalRevenue = 0; let totalCogs = 0; let totalExpenses = 0;
  for (const r of rows) {
    const debit = round2(Number(r.total_debit) || 0);
    const credit = round2(Number(r.total_credit) || 0);
    const isRevenueType = r.account_type === 'REVENUE';
    // Revenue normally sits on the credit side; contra-revenue accounts
    // (Sales Returns, Discounts Allowed) sit on the debit side and REDUCE it.
    const amount = isRevenueType ? round2(credit - debit) : round2(debit - credit);
    const row = { code: r.code, name: r.name, amount };
    if (isRevenueType) { revenue.push(row); totalRevenue = round2(totalRevenue + amount); }
    else if (r.code.startsWith('5')) { cogs.push(row); totalCogs = round2(totalCogs + amount); }
    else { expenses.push(row); totalExpenses = round2(totalExpenses + amount); }
  }

  const grossProfit = round2(totalRevenue - totalCogs);
  const netProfit = round2(grossProfit - totalExpenses);
  return {
    startDate, endDate,
    revenue, cogs, expenses,
    totalRevenue, totalCogs, totalExpenses,
    grossProfit,
    grossMarginPct: totalRevenue > 0 ? round2((grossProfit / totalRevenue) * 100) : null,
    netProfit,
    netMarginPct: totalRevenue > 0 ? round2((netProfit / totalRevenue) * 100) : null,
  };
}

/** Balance sheet. Assets must equal liabilities plus equity. */
async function balanceSheet(db, { businessId = null, branchId = null, asAt = null } = {}) {
  const tb = await trialBalance(db, { businessId, branchId, asAt });
  const pl = await profitAndLoss(db, { businessId, branchId, startDate: null, endDate: asAt });

  const group = (type) => tb.accounts.filter((a) => a.accountType === type);
  const sumGroup = (rows) => round2(rows.reduce((a, r) => a + r.balance, 0));

  const assets = group('ASSET');
  const liabilities = group('LIABILITY');
  const equity = group('EQUITY');

  const totalAssets = sumGroup(assets);
  const totalLiabilities = sumGroup(liabilities);
  const statedEquity = sumGroup(equity);
  // Retained earnings is the accumulated net profit, which the trial balance
  // does not contain until it is closed out at year end. Adding it here is
  // what makes the sheet balance in a live, unclosed set of books.
  const retainedEarnings = pl.netProfit;
  const totalEquity = round2(statedEquity + retainedEarnings);

  return {
    asAt: asAt || watToday(),
    assets, liabilities, equity,
    totalAssets,
    totalLiabilities,
    statedEquity,
    retainedEarnings,
    totalEquity,
    totalLiabilitiesAndEquity: round2(totalLiabilities + totalEquity),
    balances: Math.abs(totalAssets - (totalLiabilities + totalEquity)) <= 0.005,
    difference: round2(Math.abs(totalAssets - (totalLiabilities + totalEquity))),
  };
}

/** Revenue by category, from the ledger's category axis. */
async function revenueByCategory(db, { businessId = null, branchId = null, startDate, endDate } = {}) {
  const where = ["l.category_id IS NOT NULL", "e.is_deleted = 0", "l.is_deleted = 0"];
  const params = [];
  if (businessId) { where.push('e.business_id = ?'); params.push(String(businessId)); }
  if (branchId) { where.push('l.branch_id = ?'); params.push(String(branchId)); }
  if (startDate) { where.push('e.entry_date >= ?'); params.push(String(startDate)); }
  if (endDate) { where.push('e.entry_date <= ?'); params.push(String(endDate)); }
  const rows = await db.all(`
    SELECT c.id AS category_id, c.name AS category_name, c.code AS category_code,
           SUM(l.credit) - SUM(l.debit) AS revenue_net_of_vat
    FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    JOIN gl_accounts a ON a.id = l.account_id
    LEFT JOIN product_categories c ON c.id = l.category_id
    WHERE ${where.join(' AND ')} AND a.account_type = 'REVENUE'
    GROUP BY c.id ORDER BY revenue_net_of_vat DESC`, params);
  return rows.map((r) => ({ ...r, revenue_net_of_vat: round2(Number(r.revenue_net_of_vat) || 0) }));
}

module.exports = {
  CHART_OF_ACCOUNTS, ACCOUNT_BY_CODE, EXPENSE_CATEGORY_ACCOUNTS, ADJUSTMENT_ACCOUNTS,
  seedChartStatements, loadAccountCodes, buildEntry,
  postSaleStatements, reverseSaleStatements, postPurchaseReceiptStatements,
  postExpenseStatements, postAdjustmentStatements, postTransferStatements,
  postIntercompanyTransferStatements, postBankingStatements,
  postDebtorPaymentStatements, postCreditorPaymentStatements,
  postWarrantyStatements, postInstalmentInterestStatements,
  trialBalance, profitAndLoss, balanceSheet, revenueByCategory,
};
