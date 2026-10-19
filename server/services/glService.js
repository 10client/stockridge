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
  { code: '2220', name: 'Hire and lease deposits held', type: 'LIABILITY', side: 'CREDIT', control: true },
  { code: '2300', name: 'Staff Wages Payable', type: 'LIABILITY', side: 'CREDIT', control: false },

  { code: '3000', name: "Owner's Capital", type: 'EQUITY', side: 'CREDIT', control: false },
  { code: '3100', name: 'Retained Earnings', type: 'EQUITY', side: 'CREDIT', control: false },
  { code: '3200', name: 'Drawings', type: 'EQUITY', side: 'DEBIT', control: false },

  { code: '4000', name: 'Sales Revenue', type: 'REVENUE', side: 'CREDIT', control: true },
  { code: '4010', name: 'Wholesale Revenue', type: 'REVENUE', side: 'CREDIT', control: true },
  { code: '4020', name: 'Hire income', type: 'REVENUE', side: 'CREDIT', control: true },
  { code: '4030', name: 'Lease income', type: 'REVENUE', side: 'CREDIT', control: true },
  { code: '4040', name: 'Late return and damage', type: 'REVENUE', side: 'CREDIT', control: true },
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
  { code: '6910', name: 'Cash Over & Short', type: 'EXPENSE', side: 'DEBIT', control: true },

  { code: '7000', name: 'Intercompany — Due From', type: 'ASSET', side: 'DEBIT', control: true },
  { code: '7010', name: 'Intercompany — Due To', type: 'LIABILITY', side: 'CREDIT', control: true },
]);

/** Map an expense category string to an account code. */
const EXPENSE_CATEGORY_ACCOUNTS = Object.freeze({
  RENT: '6000', RATES: '6000',
  SALARY_WAGES: '6010', SALARY: '6010', WAGES: '6010', PAYROLL: '6010', DRIVER_WAGES: '6010', PACKER_WAGES: '6010',
  DIESEL_FUEL: '6020', DIESEL: '6020', FUEL: '6020', GENERATOR: '6020', POWER: '6020', BAKERY_GAS: '6020',
  ELECTRICITY: '6030', NEPA: '6030', PHCN: '6030',
  TRANSPORT_LOGISTICS: '6040', TRANSPORT: '6040', LOGISTICS: '6040', HAULAGE: '6040', DELIVERY: '6040', PARTNER_PAYOUT: '6040',
  SECURITY: '6050',
  REPAIRS_MAINTENANCE: '6060', REPAIRS: '6060', MAINTENANCE: '6060', MACHINERY_SERVICE: '6060',
  MARKETING: '6070', ADVERTISING: '6070', SIGNAGE: '6070',
  BANK_CHARGES: '6080', POS_CHARGES: '6080',
  INTERNET_AIRTIME: '6090', INTERNET: '6090', AIRTIME: '6090', DATA: '6090',
  CLEANING: '6100', PACKAGING_MATERIALS: '6100', CONSUMABLES: '6100', WATER_TREATMENT: '6100',
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
  if (!SOURCE_TYPES.includes(String(sourceType))) {
    throw new Error(`Journal source type "${sourceType}" is not one of the types the schema allows (${SOURCE_TYPES.join(', ')}). The source type says where an entry CAME FROM — a float and a sweep are both TILL events, a safe deposit is a SAFE event, and the description says which one.`);
  }
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
function postSaleStatements({ saleId, business, branch, totals, vat, payments, lines, isCredit, balanceDue, changeOwed, user, receiptNo, accountIds, customer, depositApplied = 0 }) {
  const statements = [];
  const { splitRevenue } = require('../../domain/trade');
  const netRevenue = round2(totals.subtotal - totals.discountAmount - vat.vatAmount);
  const revenueParts = splitRevenue(lines, totals && totals.saleType, netRevenue);

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
  // A buyout paid partly from the deposit already held. That deposit was
  // credited to 2220 when it was taken. Applying it debits 2220. It is not
  // a second receipt of cash.
  if (Number(depositApplied) > 0) {
    assetLegs.push({ accountCode: '2220', debit: round2(Number(depositApplied)), description: `Deposit applied to receipt ${receiptNo}` });
  }
  const incomeLines = revenueParts.length
    ? revenueParts.map((part) => ({
      accountCode: part.accountCode,
      credit: part.amount,
      categoryId: part.categoryId || null,
      description: [
        part.sellingGroupLabel,
        part.channel === 'HIRE' ? 'Hire fee'
          : part.channel === 'LEASE' ? 'Lease rent'
            : part.channel === 'WHOLESALE' ? 'Wholesale' : 'Retail',
        part.categoryName,
        `receipt ${receiptNo}`,
      ].filter(Boolean).join(' · '),
    }))
    : [{ accountCode: '4000', credit: Math.max(0, netRevenue), description: `Sales, receipt ${receiptNo}` }];
  const saleLines = [
    ...assetLegs.filter((l) => l.debit > 0 || l.credit > 0),
    ...incomeLines,
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

  // Each income line carries the category, so a shop that sells provisions
  // and fabrics can read those takings off the ledger, not only off the
  // till. Cost lines below carry the same category.

  const sides = [...new Set(revenueParts.map((part) => part.sellingGroupLabel).filter(Boolean))];
  statements.push(...buildEntry({
    businessId: business.id, branchId: branch.id, sourceType: 'SALE', sourceId: saleId,
    description: sides.length ? `Sale receipt ${receiptNo} — ${sides.join(' and ')}` : `Sale receipt ${receiptNo}`,
    postedBy: user && user.id, accountIds, lines: saleLines,
  }));

  // COGS and inventory relief, per line so the category axis is preserved.
  // A hire or a lease does not relieve inventory. The asset is still ours.
  const cogsLines = [];
  for (const line of lines || []) {
    const channel = String(line.channel || '').toUpperCase();
    if (channel === 'HIRE' || channel === 'LEASE') continue;
    if (line.totalCost <= 0) continue;
    const selling = require('../../domain/selling');
    const group = selling.sellingGroup({
      code: line.product && line.product.category_code,
      name: line.product && line.product.category_name,
      category_parent_code: line.product && line.product.category_parent_code,
      nafdac_catalog_id: line.product && line.product.nafdac_catalog_id,
    });
    cogsLines.push({
      accountCode: '5000', debit: line.totalCost, categoryId: line.categoryId,
      description: `${group.label} — ${line.productName} — cost of sale`,
    });
  }
  const totalCogs = round2(cogsLines.reduce((a, l) => a + l.debit, 0));
  if (totalCogs > 0) {
    cogsLines.push({ accountCode: '1100', credit: totalCogs, description: 'Inventory relieved at cost' });
    statements.push(...buildEntry({
      businessId: business.id, branchId: branch.id, sourceType: 'SALE', sourceId: saleId,
      description: `Cost of goods sold, receipt ${receiptNo}${sides.length ? ` — ${sides.join(' and ')}` : ''}`, postedBy: user && user.id, accountIds, lines: cogsLines,
    }));
  }

  // Discounts allowed, shown separately so gross margin before discount is
  // recoverable. A discount buried inside revenue cannot be reported on.
  if (totals.discountAmount > 0) {
    const discountParts = splitRevenue(lines, totals && totals.saleType, totals.discountAmount);
    const discountCredits = discountParts.length
      ? discountParts.map((part) => ({
        accountCode: part.accountCode,
        credit: part.amount,
        categoryId: part.categoryId || null,
        description: [part.sellingGroupLabel, 'Discount grossed back', part.categoryName].filter(Boolean).join(' · '),
      }))
      : [{ accountCode: '4000', credit: totals.discountAmount, description: 'Revenue reduced by discount' }];
    statements.push(...buildEntry({
      businessId: business.id, branchId: branch.id, sourceType: 'SALE', sourceId: saleId,
      description: `Discounts allowed, receipt ${receiptNo}`, accountIds,
      lines: [
        { accountCode: '4300', debit: totals.discountAmount, description: 'Discounts allowed' },
        ...discountCredits,
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
  const { splitRevenue } = require('../../domain/trade');
  const netRevenue = round2(Number(sale.subtotal) - Number(sale.discount_amount) - Number(sale.vat_amount));
  const revenueParts = splitRevenue(items, sale.sale_type, netRevenue);
  const amount = round2(Number(sale.amount_paid) || 0);

  const lines = [];
  if (amount > 0) lines.push({ accountCode: '1000', credit: amount, description: `Refund of receipt ${sale.receipt_no}` });
  const balance = round2(Number(sale.balance_due) || 0);
  if (balance > 0) lines.push({ accountCode: '1200', credit: balance, description: 'Credit sale reversed — receivable removed' });
  if (netRevenue > 0) {
    const reversals = revenueParts.length
      ? revenueParts
      : [{ accountCode: String(sale.sale_type || '').toUpperCase() === 'WHOLESALE' ? '4010' : '4000', amount: netRevenue, categoryId: null, categoryName: null }];
    for (const part of reversals) {
      lines.push({
        accountCode: part.accountCode,
        debit: part.amount,
        categoryId: part.categoryId || null,
        description: [part.sellingGroupLabel, 'Revenue reversed', part.categoryName, reason].filter(Boolean).join(' · '),
      });
    }
  }
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
function postAdjustmentStatements({ adjustment, business, branch, accountIds, user, accountCode = null }) {
  const value = round2(Math.abs(Number(adjustment.total_value) || 0));
  if (value <= 0) return [];
  // A caller may name the account. Production use is a cost of what will be
  // sold, not a sundry write-off, and it still uses this same stock book.
  const writeOffAccount = accountCode || ADJUSTMENT_ACCOUNTS[String(adjustment.adjustment_type || 'OTHER').toUpperCase()] || '6900';
  const removing = Number(adjustment.quantity) < 0;
  return buildEntry({
    businessId: business.id, branchId: branch.id, sourceType: 'STOCK_ADJUSTMENT', sourceId: adjustment.id,
    description: `${adjustment.adjustment_type.replace(/_/g, ' ').toLowerCase()}: ${adjustment.reason || 'no reason given'}`,
    postedBy: user && user.id, accountIds,
    lines: removing
      ? [
        { accountCode: writeOffAccount, debit: value, description: accountCode ? (adjustment.reason || 'Stock used') : 'Stock written off' },
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

/**
 * WHERE A JOURNAL ENTRY CAME FROM — the same closed list the `source_type`
 * CHECK constraint on gl_journal_entries allows.
 *
 * Repeated here so a caller that invents a new one finds out immediately, with a
 * sentence naming the list, instead of at the database as `CHECK constraint
 * failed: gl_journal_entries`. The first version of the cash-move work used six
 * source types of its own invention (`CASH_TRANSFER`, `CASH_VARIANCE`,
 * `SAFE_DEPOSIT`, `SAFE_PAYOUT`, `SAFE_ADJUSTMENT`, `SAFE_RECONCILE`) and every
 * one of them was rejected — correctly: a taxonomy that grows a word per feature
 * is not a taxonomy. A float and a sweep are TILL events, a safe entry is a SAFE
 * event, and the description says which one it was.
 */
const SOURCE_TYPES = Object.freeze([
  'SALE', 'SALE_RETURN', 'PURCHASE', 'EXPENSE', 'STOCK_ADJUSTMENT', 'TRANSFER',
  'TILL', 'SAFE', 'DEBTOR_PAYMENT', 'CREDITOR_PAYMENT', 'WHT', 'VAT', 'DEPRECIATION',
  'INSTALMENT', 'WARRANTY', 'DELIVERY', 'PAYROLL', 'MANUAL', 'OPENING_BALANCE', 'INTERCOMPANY',
]);

/**
 * The accounts cash actually sits in. Named so a caller says WHERE the money
 * came from and WHERE it went, in words, rather than in account numbers — a
 * posting written as `debit: '1000'` four files from the ledger it changes is
 * how a float ends up crediting the bank.
 */
const CASH_ACCOUNTS = Object.freeze({
  TILL: '1000', SAFE: '1010', BANK: '1020', POS: '1030', MOBILE_MONEY: '1040',
});

/**
 * CASH MOVING BETWEEN TWO PLACES THE BUSINESS HOLDS IT.
 *
 * Debit where it arrived, credit where it left. Both legs are real accounts, so
 * the entry balances and total assets do not change — which is the whole point:
 * a float taken from the safe is not income and not a bank deposit, it is the
 * same naira in a different drawer, and the books must say so at both ends.
 *
 * This exists because they did not. Until it did, ONLY banking touched the
 * general ledger, so the ledger's Cash at Till never received a float and its
 * Cash in Safe was never credited when money left it. The result, found by
 * test/audit/audit.money.js running against staging: **Cash in Safe reading
 * −₦205,500 in the books while the branch safe physically held ₦4,000.** The
 * rule stated in the code — "cash moving between the drawer and the safe is
 * still cash at the branch, so nothing in the ledger moves" — is right about
 * the BALANCE SHEET TOTAL and wrong about the ACCOUNTS: the two cash lines have
 * to move against each other, or each of them is a number nobody can reconcile.
 *
 * `from`/`to` are keys of CASH_ACCOUNTS. An unknown key throws rather than
 * posting something plausible, because a silently-wrong cash posting is the
 * class of bug this function exists to end.
 */
function postCashMoveStatements({
  businessId, branchId, amount, from, to, reference = null,
  sourceType = 'MANUAL', sourceId = null, description = null, accountIds, user,
}) {
  const value = round2(Number(amount) || 0);
  if (value <= 0) return [];
  const fromAccount = CASH_ACCOUNTS[String(from).toUpperCase()];
  const toAccount = CASH_ACCOUNTS[String(to).toUpperCase()];
  if (!fromAccount || !toAccount) {
    throw new Error(`Cash move from "${from}" to "${to}": both ends must be one of ${Object.keys(CASH_ACCOUNTS).join(', ')}.`);
  }
  if (fromAccount === toAccount) return []; // the same account paying itself is not a move
  return buildEntry({
    businessId, branchId, sourceType, sourceId: sourceId || reference,
    description: description || `Cash moved from ${String(from).toLowerCase()} to ${String(to).toLowerCase()}`,
    postedBy: user && user.id, accountIds,
    lines: [
      { accountCode: toAccount, debit: value, description: `Cash in: ${String(to).toLowerCase()}` },
      { accountCode: fromAccount, credit: value, description: `Cash out: ${String(from).toLowerCase()}` },
    ],
  });
}

/**
 * A COUNT THAT DID NOT MATCH, POSTED SO THE BOOKS AGREE WITH THE DRAWER.
 *
 * A till counted ₦2,000 short is a ₦2,000 fact: the cash account has to come
 * down, and the loss has to land somewhere a person can look at it, or the
 * ledger keeps claiming money that is not there and the shortage is only ever
 * visible in a variance column nobody reconciles. It goes to 6910 Cash Over &
 * Short — its own account, deliberately, not Sundry Expenses: overages and
 * shortages are read together, every month, and "how much is this shop short"
 * is a question that deserves an answer that is one line of a report.
 *
 * `variance` is COUNTED MINUS EXPECTED, the same sign the till stores: negative
 * is short. Negative debits the loss; positive credits it back.
 */
function postCashOverShortStatements({
  businessId, branchId, variance, accountCode = '1000', sourceType = 'TILL',
  sourceId = null, reference = null, reason = null, accountIds, user,
}) {
  const value = round2(Number(variance) || 0);
  if (value === 0) return [];
  // `accountCode` takes either a cash KEY ('TILL', 'SAFE') or a chart code
  // ('1000', '1010'). The count that went wrong can be either drawer, and naming
  // it the way the rest of this file names cash is less to get wrong.
  const cashKey = CASH_ACCOUNTS[String(accountCode).toUpperCase()] || String(accountCode);
  const abs = Math.abs(value);
  const loss = value < 0;
  return buildEntry({
    businessId, branchId, sourceType, sourceId: sourceId || reference,
    description: loss
      ? `Cash short at the count${reason ? `: ${reason}` : ''}`
      : `Cash over at the count${reason ? `: ${reason}` : ''}`,
    postedBy: user && user.id, accountIds,
    lines: loss
      ? [
        { accountCode: '6910', debit: abs, description: 'Cash over & short' },
        { accountCode: cashKey, credit: abs, description: 'Cash missing from the drawer' },
      ]
      : [
        { accountCode: cashKey, debit: abs, description: 'Cash found in the drawer' },
        { accountCode: '6910', credit: abs, description: 'Cash over & short' },
      ],
  });
}

/**
 * CASH AGAINST A NON-CASH ACCOUNT — money entering or leaving the business
 * entirely, rather than moving between two places it is held.
 *
 * A payout, an owner's drawing, an owner putting capital in, an unclassified
 * deposit: in each case one side is a cash account and the other is an expense,
 * an equity or a suspense account. It cannot be expressed as `from`/`to` because
 * the money stops being cash, which is exactly why it needs this door rather than
 * the move door — a payout posted as a cash move would credit an account that is
 * still holding the money.
 *
 * `direction` is IN (cash arrives) or OUT (cash leaves). An account is required
 * on the other side: a payout with no account is how a safe empties and the
 * profit and loss never notices, which is what the reason list on the safe route
 * was written to prevent in the first place.
 */
function postCashAgainstAccountStatements({
  businessId, branchId, amount, cash = 'SAFE', accountCode, direction = 'OUT',
  sourceType = 'SAFE', sourceId = null, reference = null, description = null, accountIds, user,
}) {
  const value = round2(Number(amount) || 0);
  if (value <= 0) return [];
  const cashAccount = CASH_ACCOUNTS[String(cash).toUpperCase()];
  if (!cashAccount) throw new Error(`Cash account "${cash}": expected one of ${Object.keys(CASH_ACCOUNTS).join(', ')}.`);
  if (!accountCode) throw new Error('Cash against an account needs the account — an expense, equity or suspense code, or the books lose the other side of the entry.');
  const inbound = String(direction).toUpperCase() === 'IN';
  const other = { accountCode: String(accountCode), description: inbound ? 'Source of the cash' : 'Use of the cash' };
  const cashLine = { accountCode: cashAccount, description: `${inbound ? 'Cash in' : 'Cash out'}: ${String(cash).toLowerCase()}` };
  return buildEntry({
    businessId, branchId, sourceType, sourceId: sourceId || reference,
    description: description || (inbound ? 'Cash received' : 'Cash paid out'),
    postedBy: user && user.id, accountIds,
    lines: inbound
      ? [{ ...cashLine, debit: value }, { ...other, credit: value }]
      : [{ ...other, debit: value }, { ...cashLine, credit: value }],
  });
}

/** A payout from the safe: cash leaving the business against an expense or equity account. */
function postCashPayoutStatements(opts) {
  return postCashAgainstAccountStatements({ ...opts, direction: 'OUT' });
}

/** Banking cash from the till or the safe into the bank. */
function postBankingStatements({ businessId, branchId, amount, from = 'TILL', reference = null, accountIds, user }) {
  // Expressed as a cash move now that one exists: from wherever the cash is,
  // into the bank. Same entry it always produced — DR 1020 / CR 1000|1010 — with
  // the destination named the same way every other move names it.
  return postCashMoveStatements({
    businessId, branchId, amount, from, to: 'BANK', reference,
    sourceType: 'SAFE', sourceId: reference,
    description: `Banked ${String(from).toLowerCase()} cash`, accountIds, user,
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

const RENTAL_INCOME_ACCOUNTS = Object.freeze([
  ['4020', 'Hire income'],
  ['4030', 'Lease income'],
  ['4040', 'Late return and damage'],
]);

/**
 * The rental yard's books, read from the accounts a hire or lease already
 * posts to. This is not a second ledger. A deposit is a liability, so it is
 * reported beside the fees and not added to them.
 */
async function rentalBooks(db, { businessId, branchId = null, startDate = null, endDate = null } = {}) {
  if (!businessId) return null;
  const yardParams = [String(businessId)];
  let yardSql = `SELECT COUNT(*) AS n FROM branches WHERE business_id = ? AND is_deleted = 0 AND branch_type = 'RENTAL'`;
  if (branchId) {
    yardSql += ' AND id = ?';
    yardParams.push(String(branchId));
  }
  const yardRow = await db.first(yardSql, yardParams);
  const codes = ['4020', '4030', '4040'];
  const where = ['a.is_deleted = 0', 'e.is_deleted = 0', 'l.is_deleted = 0', 'e.business_id = ?', `a.code IN (${codes.map(() => '?').join(',')})`];
  const params = [String(businessId), ...codes];
  if (branchId) { where.push('l.branch_id = ?'); params.push(String(branchId)); }
  if (startDate) { where.push('e.entry_date >= ?'); params.push(String(startDate)); }
  if (endDate) { where.push('e.entry_date <= ?'); params.push(String(endDate)); }
  const movements = await db.all(`SELECT a.code, SUM(l.debit) AS debit, SUM(l.credit) AS credit
    FROM gl_accounts a
    JOIN gl_journal_lines l ON l.account_id = a.id
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE ${where.join(' AND ')}
    GROUP BY a.code`, params);
  const heldWhere = ['a.is_deleted = 0', 'e.is_deleted = 0', 'l.is_deleted = 0', 'e.business_id = ?', "a.code = '2220'"];
  const heldParams = [String(businessId)];
  if (branchId) { heldWhere.push('l.branch_id = ?'); heldParams.push(String(branchId)); }
  if (endDate) { heldWhere.push('e.entry_date <= ?'); heldParams.push(String(endDate)); }
  const held = await db.first(`SELECT SUM(l.credit) AS credit, SUM(l.debit) AS debit
    FROM gl_accounts a
    JOIN gl_journal_lines l ON l.account_id = a.id
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE ${heldWhere.join(' AND ')}`, heldParams);
  const byCode = new Map((movements || []).map((row) => [row.code, row]));
  const income = RENTAL_INCOME_ACCOUNTS.map(([code, name]) => {
    const row = byCode.get(code);
    return { code, name, amount: round2((Number(row && row.credit) || 0) - (Number(row && row.debit) || 0)) };
  });
  const incomeTotal = round2(income.reduce((sum, row) => sum + row.amount, 0));
  const depositsHeld = round2((Number(held && held.credit) || 0) - (Number(held && held.debit) || 0));
  const yard = Number(yardRow && yardRow.n) > 0;
  if (!yard && incomeTotal === 0 && depositsHeld === 0) return null;
  return {
    yard,
    income,
    incomeTotal,
    depositsHeld,
    note: 'Hire fees and lease rent are income on these books. A deposit is held until the goods come back, so it is not in the profit above. Goods out on hire stay in inventory. Cost of goods is taken only when a unit is sold.',
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

/**
 * Pharmaceuticals against non-pharmaceuticals, from the same ledger lines.
 * A line posted as Pharmaceuticals stays there even if its shelf category is
 * not a drug shelf. Older lines, which have no side in the memo, fall back
 * to the shelf category. Delivery income is not a side of the shop.
 */
async function booksBySellingGroup(db, { businessId = null, branchId = null, startDate, endDate } = {}) {
  const selling = require('../../domain/selling');
  if (businessId) {
    const { ensureMajors } = require('./categorySides');
    await ensureMajors(db, businessId);
  }
  const where = ["e.is_deleted = 0", "l.is_deleted = 0", "a.code IN ('4000','4010','4020','4030','5000')"];
  const params = [];
  if (businessId) { where.push('e.business_id = ?'); params.push(String(businessId)); }
  if (branchId) { where.push('l.branch_id = ?'); params.push(String(branchId)); }
  if (startDate) { where.push('e.entry_date >= ?'); params.push(String(startDate)); }
  if (endDate) { where.push('e.entry_date <= ?'); params.push(String(endDate)); }
  const rows = await db.all(`
    SELECT e.source_type, e.source_id, l.description, l.category_id, c.code AS category_code,
           parent.code AS category_parent_code, a.code AS account_code,
           l.credit AS credit, l.debit AS debit
    FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    JOIN gl_accounts a ON a.id = l.account_id
    LEFT JOIN product_categories c ON c.id = l.category_id
    LEFT JOIN product_categories parent ON parent.id = c.parent_id AND parent.is_deleted = 0
    WHERE ${where.join(' AND ')}`, params);
  const saleIds = [...new Set((rows || []).filter((row) => row.source_type === 'SALE' && row.source_id).map((row) => String(row.source_id)))];
  const itemSides = new Map();
  for (let i = 0; i < saleIds.length; i += 80) {
    const chunk = saleIds.slice(i, i + 80);
    const items = await db.all(`
      SELECT si.sale_id, si.category_id, p.nafdac_catalog_id, pc.code AS category_code, parent.code AS category_parent_code
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      LEFT JOIN product_categories pc ON pc.id = si.category_id
      LEFT JOIN product_categories parent ON parent.id = pc.parent_id AND parent.is_deleted = 0
      WHERE si.is_deleted = 0 AND si.sale_id IN (${chunk.map(() => '?').join(',')})`, chunk);
    for (const item of items || []) {
      const key = `${item.sale_id}|${item.category_id || ''}`;
      const prev = itemSides.get(key) || new Set();
      prev.add(selling.sellingGroup(item).code);
      itemSides.set(key, prev);
    }
  }
  const sides = selling.GROUPS.map((group) => ({
    code: group.code, label: group.label, revenue: 0, cogs: 0, grossProfit: 0,
  }));
  for (const row of rows || []) {
    let group = journalSide(row);
    const text = String(row.description || '');
    if (!text.startsWith('Pharmaceuticals') && !text.startsWith('Non-pharmaceuticals')) {
      const found = itemSides.get(`${row.source_id}|${row.category_id || ''}`);
      if (found && found.size === 1) {
        const code = [...found][0];
        group = selling.GROUPS.find((item) => item.code === code) || group;
      }
    }
    const side = sides.find((item) => item.code === group.code);
    if (!side) continue;
    if (row.account_code === '5000') side.cogs = round2(side.cogs + Number(row.debit || 0) - Number(row.credit || 0));
    else side.revenue = round2(side.revenue + Number(row.credit || 0) - Number(row.debit || 0));
  }
  for (const side of sides) side.grossProfit = round2(side.revenue - side.cogs);
  return sides;
}

/**
 * A security deposit taken or given back.
 *
 * It is not income. Taking it debits the drawer and credits the liability.
 * Giving it back is the reverse. Applying it to damage credits late-and-damage
 * income and clears the liability. The description says which, because the
 * source type stays SALE — the schema's list does not grow a word per feature.
 */
function journalSide(row) {
  const text = String((row && row.description) || '');
  if (text.startsWith('Non-pharmaceuticals')) return { code: 'NON_PHARMACEUTICALS', label: 'Non-pharmaceuticals' };
  if (text.startsWith('Pharmaceuticals')) return { code: 'PHARMACEUTICALS', label: 'Pharmaceuticals' };
  const selling = require('../../domain/selling');
  return selling.sellingGroup(row);
}

function postHeldDeposit({ business, branch, agreementId, amount, method, user, description, accountIds, releasing = false, toIncome = false }) {
  const { methodAccount } = require('../../domain/trade');
  const value = round2(Number(amount) || 0);
  if (value <= 0) return [];
  const cash = methodAccount(method);
  const lines = toIncome
    ? [
      { accountCode: '2220', debit: value, description: description || 'Deposit applied to damage or a late return' },
      { accountCode: '4040', credit: value, description: description || 'Late return and damage' },
    ]
    : releasing
      ? [
        { accountCode: '2220', debit: value, description: description || 'Deposit returned' },
        { accountCode: cash, credit: value, description: description || 'Deposit paid back' },
      ]
      : [
        { accountCode: cash, debit: value, description: description || 'Deposit received' },
        { accountCode: '2220', credit: value, description: description || 'Deposit held, not income' },
      ];
  return buildEntry({
    businessId: business.id, branchId: branch.id, sourceType: 'SALE', sourceId: agreementId,
    description: description || 'Hire or lease deposit', postedBy: user && user.id, accountIds, lines,
  });
}

module.exports = {
  CHART_OF_ACCOUNTS, ACCOUNT_BY_CODE, CASH_ACCOUNTS, EXPENSE_CATEGORY_ACCOUNTS, ADJUSTMENT_ACCOUNTS,
  seedChartStatements, loadAccountCodes, buildEntry,
  postSaleStatements, reverseSaleStatements, postPurchaseReceiptStatements, postHeldDeposit,
  postExpenseStatements, postAdjustmentStatements, postTransferStatements,
  postIntercompanyTransferStatements, postBankingStatements,
  postCashMoveStatements, postCashOverShortStatements, postCashPayoutStatements, postCashAgainstAccountStatements,
  postDebtorPaymentStatements, postCreditorPaymentStatements,
  postWarrantyStatements, postInstalmentInterestStatements,
  trialBalance, profitAndLoss, rentalBooks, balanceSheet, revenueByCategory, booksBySellingGroup,
};
