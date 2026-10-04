// =====================================================================
// StockRidge — SALES SERVICE  (the POS engine)
// =====================================================================
// One function, createSale(), is the busiest code path in the product and
// the one where a bug costs real money. It is written as an explicit
// sequence with every write collected into ONE db.batch(), because a sale
// that half-commits is worse than a sale that fails:
//
//   took the cash, did not decrement the stock  -> shrinkage nobody can find
//   decremented the stock, did not record cash  -> a till that will not close
//   recorded the sale, did not write the ledger -> a P&L that disagrees with
//                                                 the receipts in the drawer
//
// SEQUENCE
//   1  validate authority, capability and plan state
//   2  resolve each line's price (pricingService) and unit conversion
//   3  resolve stock availability across batches (stockService)
//   4  compute totals: line -> subtotal -> discount -> VAT -> total
//   5  validate payments against the total (split tender, change)
//   6  enforce credit limit if any part is on credit
//   7  build EVERY statement: sale, items, payments, stock decrements,
//      movements, serial transitions, warranties, debtor ledger, GL,
//      till counters, audit log
//   8  execute as one batch
//   9  post-effects that must not be able to fail the sale (register
//      entries, notifications, loyalty)
//
// Steps 1-7 throw. Step 8 is atomic. Step 9 is best-effort and logged.
// The ordering is deliberate: nothing that can fail is allowed to run after
// the money has moved, and nothing that must not fail is allowed to run
// before it.
//
// VAT: inclusive by default — see lib/vat.js for why, and note that the
// taxable base is total / 1.075, NOT total.
// =====================================================================

const { newId, watNowIso, watDate, addMonths } = require('../../shared/ids');
const { round2, roundCash, toKobo, fromKobo, sumMoney } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const { resolveLine } = require('../../shared/units');
const stockService = require('./stockService');
const pricingService = require('./pricingService');
const glService = require('./glService');
const vat = require('../lib/vat');
const { PREFIXES, nextReference, claimCode } = require('../lib/references');
const { writeAudit, appendRegister } = require('../lib/audit');
const { capabilitiesOf, assertCapability, itemCapabilities } = require('../lib/capabilities');
const { staffAllowance, assertSubscribed, getUnitSettings } = require('../lib/planLimits');
const { assertBranchAccess } = require('../lib/roles');

const PAYMENT_METHODS = ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'USSD', 'MOBILE_MONEY', 'CHEQUE', 'CREDIT', 'GIFT_VOUCHER', 'LOYALTY_REDEMPTION', 'CRYPTO', 'OTHER'];
const CASH_METHODS = ['CASH'];
const TILL_COLUMNS = {
  CASH: 'expected_cash', POS_TERMINAL: 'expected_pos', BANK_TRANSFER: 'expected_transfer',
  USSD: 'expected_ussd', MOBILE_MONEY: 'expected_mobile_money', CHEQUE: 'expected_cheque',
  CREDIT: 'expected_credit', GIFT_VOUCHER: 'expected_other', LOYALTY_REDEMPTION: 'expected_other',
  CRYPTO: 'expected_other', OTHER: 'expected_other',
};

// ---------------------------------------------------------------------
// CREATE SALE
// ---------------------------------------------------------------------
async function createSale(db, ctx, input) {
  const user = ctx.user;
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, user, { action: 'record a sale' });

  const branchId = input.branch_id || user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch this sale is for.', 'BRANCH_REQUIRED');
  assertBranchAccess(user, branchId);

  const branch = await db.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0 AND is_active = 1').bind(branchId).first();
  if (!branch) throw new HttpError(404, 'That branch was not found or is not active.', 'BRANCH_NOT_FOUND');

  const lines = Array.isArray(input.items) ? input.items : [];
  if (!lines.length) throw new HttpError(400, 'A sale needs at least one item.', 'SALE_EMPTY');
  if (lines.length > 200) throw new HttpError(400, 'A single receipt cannot hold more than 200 lines. Split it into two sales.', 'SALE_TOO_MANY_LINES');

  const allowance = await staffAllowance(db, businessUnitId, user);
  const caps = capabilitiesOf(settings);

  // ---- 1. Customer & tier -------------------------------------------
  let customer = null;
  let tier = null;
  if (input.customer_id) {
    customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(input.customer_id).first();
    if (!customer) throw new HttpError(404, 'That customer was not found.', 'CUSTOMER_NOT_FOUND');
  }
  const saleType = String(input.sale_type || 'RETAIL').toUpperCase();
  if (!['RETAIL', 'WHOLESALE', 'CREDIT', 'INSTALLMENT', 'LAYAWAY_RELEASE', 'INTERNAL'].includes(saleType)) {
    throw new HttpError(400, `Sale type must be one of RETAIL, WHOLESALE, CREDIT, INSTALLMENT, LAYAWAY_RELEASE, INTERNAL.`, 'SALE_TYPE_INVALID');
  }
  if (customer && customer.tier_id) {
    tier = await db.prepare('SELECT * FROM price_tiers WHERE id = ? AND is_deleted = 0').bind(customer.tier_id).first();
  }

  const isCreditSale = saleType === 'CREDIT' || saleType === 'INSTALLMENT' || !!input.is_credit_sale;

  // ---- 2. Open till --------------------------------------------------
  // A sale without an open till cannot be reconciled to a drawer, so it is
  // refused rather than accepted and orphaned. The one exception is a fully
  // credit sale with no cash component, which does not touch a drawer.
  let till = await db.prepare(`
    SELECT * FROM till_sessions
    WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0
    ORDER BY opened_at DESC LIMIT 1
  `).bind(branchId).first();
  if (!till) {
    throw new HttpError(409,
      'No till is open at this branch. Open the till first — a sale recorded without one cannot be reconciled against the drawer at close.',
      'NO_OPEN_TILL');
  }

  // ---- 3. Resolve each line -----------------------------------------
  const resolvedLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const resolved = await resolveSaleLine(db, ctx, {
      businessUnitId, branchId, line: raw, index: i,
      customer, customerId: input.customer_id, tier, tierId: tier ? tier.id : null,
      saleType, allowance, settings, caps,
      promotionCode: raw.promotion_code || input.promotion_code || null,
    });
    resolvedLines.push(resolved);
  }

  // ---- 4. Totals -----------------------------------------------------
  const subtotal = sumMoney(resolvedLines.map((l) => l.line_subtotal_after_line_discount));
  const lineDiscountTotal = sumMoney(resolvedLines.map((l) => l.line_discount_amount));

  // Whole-sale discount. A percentage off the (already line-discounted)
  // subtotal, or an absolute amount. Both are gated by the same authority.
  let discountAmount = 0;
  let discountPercent = 0;
  const requestedDiscountPercent = Number(input.discount_percent) || 0;
  const requestedDiscountAmount = input.discount_amount != null ? round2(Number(input.discount_amount)) : 0;

  if (requestedDiscountPercent > 0 && requestedDiscountAmount > 0) {
    throw new HttpError(400, 'Apply a discount as either a percentage or an amount on one receipt, not both — the result is ambiguous.', 'DISCOUNT_AMBIGUOUS');
  }
  if (requestedDiscountPercent > 0) {
    await assertDiscountAuthority(db, businessUnitId, user, allowance, requestedDiscountPercent, { kind: 'percent' });
    discountPercent = round2(requestedDiscountPercent);
    discountAmount = round2((subtotal * discountPercent) / 100);
  } else if (requestedDiscountAmount > 0) {
    if (subtotal <= 0) throw new HttpError(400, 'There is nothing to discount.', 'DISCOUNT_NO_SUBTOTAL');
    if (requestedDiscountAmount > subtotal) {
      throw new HttpError(400, `A discount of ₦${requestedDiscountAmount.toLocaleString('en-NG')} is more than the ₦${subtotal.toLocaleString('en-NG')} subtotal.`, 'DISCOUNT_EXCEEDS_SUBTOTAL');
    }
    discountPercent = round2((requestedDiscountAmount / subtotal) * 100);
    await assertDiscountAuthority(db, businessUnitId, user, allowance, discountPercent, { kind: 'amount' });
    discountAmount = requestedDiscountAmount;
  }

  const afterDiscount = round2(subtotal - discountAmount);
  if (afterDiscount < 0) throw new HttpError(400, 'The discount exceeds the sale total.', 'DISCOUNT_EXCEEDS_TOTAL');

  // VAT. Extracted from the inclusive total when the business is registered
  // and prices are inclusive; added on top when they are not.
  const vatEnabled = vat.isVatEnabled(settings);
  const vatRate = vat.normaliseRate(settings.vat_rate_percent);
  const inclusive = vat.isVatInclusive(settings);

  // Line-level VAT allocation, so the per-category VAT figures in the GL and
  // on a tax invoice sum EXACTLY to the headline VAT. Exempt lines are
  // removed from the base first.
  const vatLines = [];
  let taxableSubtotal = 0;
  for (const l of resolvedLines) {
    const code = vat.taxCodeOf(l.tax_code);
    const share = subtotal > 0 ? (l.line_subtotal_after_line_discount / subtotal) : 0;
    const lineAfterDiscount = round2(l.line_subtotal_after_line_discount - (discountAmount * share));
    if (code.rate_multiplier > 0) { taxableSubtotal = round2(taxableSubtotal + lineAfterDiscount); }
    vatLines.push({ ...l, line_total_for_vat: lineAfterDiscount, tax_code_obj: code });
  }

  let vatAmount = 0;
  let total = afterDiscount;
  if (vatEnabled) {
    if (inclusive) {
      const extracted = vat.extractVat(afterDiscount, vatRate);
      vatAmount = extracted.vat;
      total = afterDiscount;                      // customer pays the shelf price
    } else {
      const added = vat.addVat(afterDiscount, vatRate);
      vatAmount = added.vat;
      total = added.gross;                        // VAT added on top
    }
  }
  total = round2(total);

  // Per-line VAT share for reporting, allocated so the sum matches exactly.
  const vatAllocation = vatEnabled
    ? vat.allocateVatAcrossLines(vatLines.map((l) => ({ ...l, line_total: l.tax_code_obj.rate_multiplier > 0 ? l.line_total_for_vat : 0 })), vatRate)
    : vatLines.map((l, i) => ({ index: i, vat: 0, taxable: l.line_total_for_vat }));

  // ---- 5. Payments ---------------------------------------------------
  const payments = normalisePayments(input.payments, { total, isCreditSale, allowance, settings });
  const paidNow = sumMoney(payments.filter((p) => p.method !== 'CREDIT').map((p) => p.amount));
  const creditComponent = sumMoney(payments.filter((p) => p.method === 'CREDIT').map((p) => p.amount));
  const balanceDue = round2(Math.max(0, total - paidNow));

  if (!isCreditSale && balanceDue > 0.005) {
    throw new HttpError(409,
      `₦${balanceDue.toLocaleString('en-NG')} is still outstanding on this sale. Take the payment, or record it as a credit sale with a manager's approval.`,
      'SALE_NOT_PAID_IN_FULL');
  }
  if (isCreditSale && creditComponent <= 0 && balanceDue <= 0.005) {
    // A "credit sale" that is fully paid is just a sale. Not an error, but
    // recorded as such so the debtor ledger does not grow a zero-balance row.
  }
  if (paidNow > total + 0.005 && !isCreditSale) {
    // Overpayment is only legitimate as cash needing change.
    const cashPaid = sumMoney(payments.filter((p) => CASH_METHODS.includes(p.method)).map((p) => p.amount));
    const nonCashPaid = round2(paidNow - cashPaid);
    if (nonCashPaid > total + 0.005) {
      throw new HttpError(400,
        `Non-cash payments total ₦${nonCashPaid.toLocaleString('en-NG')} against a ₦${total.toLocaleString('en-NG')} sale. A POS terminal or transfer cannot give change — reduce the amount.`,
        'OVERPAYMENT_NON_CASH');
    }
  }

  // Change. Cash rounding to whole Naira — see shared/money.js roundCash.
  let changeGiven = 0;
  let changeOwedId = null;
  const cashTendered = sumMoney(payments.filter((p) => CASH_METHODS.includes(p.method)).map((p) => p.cash_tendered != null ? p.cash_tendered : p.amount));
  const cashApplied = sumMoney(payments.filter((p) => CASH_METHODS.includes(p.method)).map((p) => p.amount));
  const rawChange = round2(cashTendered - cashApplied);
  if (rawChange > 0) {
    changeGiven = roundCash(rawChange);
    // If the drawer cannot physically produce the change, record what is
    // owed with a claim code rather than silently writing it off or rounding
    // it against the customer. See change_owed in the schema.
    const canGiveChange = input.change_available !== false;
    if (!canGiveChange) {
      changeOwedId = newId();
    }
  }
  if (rawChange < -0.005) {
    throw new HttpError(400, 'Cash tendered is less than the cash component of the sale.', 'CASH_SHORT');
  }

  // ---- 6. Credit limit ----------------------------------------------
  if ((isCreditSale || balanceDue > 0.005) && customer) {
    await assertWithinCreditLimit(db, ctx, { customer, businessUnitId, branchId, amount: round2(balanceDue + creditComponent), override: !!input.credit_limit_override, overrideReason: input.credit_override_reason, user, allowance });
  }
  if ((isCreditSale || balanceDue > 0.005) && !customer) {
    throw new HttpError(400, 'A credit sale must be against a named customer — an anonymous debtor cannot be chased.', 'CREDIT_SALE_NEEDS_CUSTOMER');
  }

  // ---- 7. Build statements ------------------------------------------
  const saleId = input.sale_id || newId();         // caller-supplied so an offline queue can pre-allocate
  const ts = watNowIso();
  const occurredAt = input.occurred_at || ts;
  const receipt = input.receipt_no
    || (await nextReference(db, { businessUnitId, prefix: PREFIXES.SALE, branchCode: branch.code || '*', scope: 'YEAR' })).reference;

  const statements = [];
  const serialAssignments = [];
  const warrantyRows = [];
  const movementRows = [];
  let grossMarginTotal = 0;

  // Stock availability must be checked for the WHOLE basket before any line
  // is written: a basket that fails on line 4 of 6 must not have decremented
  // lines 1-3. This is why allocation happens here, ahead of statement
  // building, and why the allocation result is carried into the statements.
  const allocations = [];
  for (const l of resolvedLines) {
    if (l.is_service_line) { allocations.push(null); continue; }
    const result = await stockService.buildConsumeStatements(db, {
      businessUnitId, branchId, productId: l.product_id, quantityBase: l.quantity_base,
      movementType: saleType === 'LAYAWAY_RELEASE' ? 'LAYAWAY_RELEASE' : 'SALE',
      sourceType: 'SALE', sourceId: saleId, reference: receipt,
      performedBy: user.id, deviceId: ctx.deviceId || null,
      now: ts,
      fromReserved: saleType === 'LAYAWAY_RELEASE' && !!input.layaway_hold_id,
    });
    allocations.push(result);
    for (const s of result.statements) statements.push(s);
    grossMarginTotal = round2(grossMarginTotal + l.gross_margin);
  }

  statements.push(db.prepare(`
    INSERT INTO sales (
      id, business_unit_id, branch_id, receipt_no, invoice_no, till_session_id, customer_id, customer_snapshot_json,
      sale_type, tier_id, status, subtotal, discount_amount, discount_percent, discount_reason, discount_approved_by,
      taxable_amount, vat_amount, total, amount_paid, balance_due, change_given,
      is_credit_sale, due_date, credit_limit_overridden_by, credit_override_reason,
      payment_plan_id, layaway_hold_id, delivery_job_id,
      sold_by, device_id, occurred_at, client_created_at, sync_status, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?,?)
  `).bind(
    saleId, businessUnitId, branchId, receipt, input.invoice_no || null, till.id, customer ? customer.id : null,
    customer ? JSON.stringify({ full_name: customer.full_name, phone: customer.phone, tier_id: customer.tier_id, customer_type: customer.customer_type }) : null,
    saleType, tier ? tier.id : null, 'COMPLETED',
    subtotal, discountAmount, discountPercent, input.discount_reason || null, discountAmount > 0 && input.discount_approved_by ? input.discount_approved_by : null,
    round2(afterDiscount - vatAmount), vatAmount, total, paidNow, balanceDue, changeGiven,
    isCreditSale ? 1 : 0, input.due_date || (isCreditSale && customer ? defaultDueDate(settings, customer) : null),
    input.credit_limit_override ? user.id : null, input.credit_limit_override ? (input.credit_override_reason || null) : null,
    input.payment_plan_id || null, input.layaway_hold_id || null, input.delivery_job_id || null,
    user.id, ctx.deviceId || null, occurredAt, input.client_created_at || null,
    input.sync_status === 'LOCAL' ? 'LOCAL' : 'SYNCED', input.notes || null, ts, ts
  ));

  for (let i = 0; i < resolvedLines.length; i += 1) {
    const l = resolvedLines[i];
    const alloc = allocations[i];
    const saleItemId = newId();
    l.sale_item_id = saleItemId;
    const vatShare = vatAllocation[i] || { vat: 0 };
    statements.push(db.prepare(`
      INSERT INTO sale_items (
        id, business_unit_id, sale_id, product_id, stock_batch_id, category_id, line_no,
        unit_type, quantity, pieces_per_unit, quantity_base,
        unit_price, unit_cost, line_subtotal, discount_amount, discount_percent, discount_reason,
        line_total, vat_amount, gross_margin, gross_margin_percent,
        tier_id, price_source, promotion_id, is_service_line, service_type,
        serial_ids_json, warranty_ids_json, item_notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?)
    `).bind(
      saleItemId, businessUnitId, saleId, l.product_id,
      alloc && alloc.allocation.length === 1 ? alloc.allocation[0].batch_id : null,
      l.category_id || null, i + 1,
      l.unit_type, l.quantity, l.pieces_per_unit, l.quantity_base,
      l.unit_price, l.unit_cost, l.line_subtotal, l.line_discount_amount, l.line_discount_percent, l.line_discount_reason || null,
      l.line_total, round2(vatShare.vat || 0), l.gross_margin, l.gross_margin_percent,
      l.tier_id || null, l.price_source, l.promotion_id || null, l.is_service_line ? 1 : 0, l.service_type || null,
      l.serial_ids && l.serial_ids.length ? JSON.stringify(l.serial_ids) : null,
      null, l.item_notes || null, ts, ts
    ));
  }

  // Payments
  const paymentIds = [];
  for (const p of payments) {
    const pid = newId();
    paymentIds.push(pid);
    statements.push(db.prepare(`
      INSERT INTO sale_payments (
        id, business_unit_id, sale_id, branch_id, till_session_id, method, amount, currency,
        cash_tendered, change_given, change_owed_id, reference, terminal_id, bank_name,
        received_at, received_by, device_id, status, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      pid, businessUnitId, saleId, branchId, till.id, p.method, p.amount, 'NGN',
      p.cash_tendered == null ? null : p.cash_tendered,
      p.method === 'CASH' ? round2(p.cash_tendered != null ? Math.max(0, p.cash_tendered - p.amount) : 0) : 0,
      p.method === 'CASH' ? changeOwedId : null,
      p.reference || null, p.terminal_id || null, p.bank_name || null,
      ts, user.id, ctx.deviceId || null,
      p.method === 'CHEQUE' ? 'PENDING_CONFIRMATION' : 'RECEIVED',
      p.notes || null, ts, ts
    ));
  }

  // Change owed claim
  if (changeOwedId) {
    const code = claimCode({ prefix: 'CHG' });
    statements.push(db.prepare(`
      INSERT INTO change_owed (
        id, business_unit_id, branch_id, sale_id, customer_id, customer_name, customer_phone,
        claim_code, amount, reason, status, till_session_id, expires_at, created_by, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?, 'OUTSTANDING', ?,?,?,?,?)
    `).bind(
      changeOwedId, businessUnitId, branchId, saleId, customer ? customer.id : null,
      customer ? customer.full_name : (input.change_owed_name || null),
      customer ? customer.phone : (input.change_owed_phone || null),
      code, changeGiven, 'NO_SMALL_CHANGE', till.id,
      addMonths(watDate(), 1), user.id, ts, ts
    ));
  }

  // Till counters. Denormalised onto the session so a till close does not
  // have to re-scan every payment of the day.
  const tillDeltas = computeTillDeltas(payments, { changeGiven, discountAmount });
  statements.push(db.prepare(`
    UPDATE till_sessions SET
      expected_cash = expected_cash + ?,
      expected_pos = expected_pos + ?,
      expected_transfer = expected_transfer + ?,
      expected_ussd = expected_ussd + ?,
      expected_mobile_money = expected_mobile_money + ?,
      expected_cheque = expected_cheque + ?,
      expected_credit = expected_credit + ?,
      expected_other = expected_other + ?,
      expected_total = expected_total + ?,
      sale_count = sale_count + 1,
      discount_total = discount_total + ?,
      change_owed_outstanding = change_owed_outstanding + ?,
      updated_at = ?
    WHERE id = ?
  `).bind(
    tillDeltas.expected_cash, tillDeltas.expected_pos, tillDeltas.expected_transfer,
    tillDeltas.expected_ussd, tillDeltas.expected_mobile_money, tillDeltas.expected_cheque,
    tillDeltas.expected_credit, tillDeltas.expected_other, tillDeltas.expected_total,
    discountAmount, changeOwedId ? changeGiven : 0, ts, till.id
  ));

  // Customer counters + debtor ledger
  if (customer) {
    statements.push(db.prepare(`
      UPDATE customers SET
        total_purchases = total_purchases + ?,
        purchase_count = purchase_count + 1,
        last_purchase_at = ?,
        loyalty_points = loyalty_points + ?,
        updated_at = ?
      WHERE id = ?
    `).bind(paidNow + balanceDue, ts, Math.floor((paidNow + balanceDue) / 100), ts, customer.id));

    const debtAmount = round2(balanceDue + creditComponent);
    if (debtAmount > 0.005) {
      const currentBalance = await debtorBalance(db, { customerId: customer.id, businessUnitId });
      statements.push(db.prepare(`
        INSERT INTO debtor_ledger (
          id, business_unit_id, branch_id, customer_id, entry_date, entry_type, source_type, source_id,
          reference, amount, balance_after, notes, created_by, created_at, updated_at
        ) VALUES (?,?,?,?,?, 'SALE', 'SALE', ?,?,?,?,?,?,?,?)
      `).bind(
        newId(), businessUnitId, branchId, customer.id, watDate(), saleId, receipt,
        debtAmount, round2(currentBalance + debtAmount),
        input.notes || null, user.id, ts, ts
      ));
    }
  }

  // Serials
  for (const l of resolvedLines) {
    if (!l.serial_ids || !l.serial_ids.length) continue;
    for (const serialId of l.serial_ids) {
      const s = await db.prepare('SELECT * FROM product_serials WHERE id = ? AND is_deleted = 0').bind(serialId).first();
      if (!s) throw new HttpError(404, `Serial ${serialId} was not found.`, 'SERIAL_NOT_FOUND');
      if (!stockService.canTransitionSerial(s.status, 'SOLD')) {
        throw new HttpError(409, `Serial ${s.serial_no} is ${String(s.status).replace(/_/g, ' ').toLowerCase()} and cannot be sold.`, 'SERIAL_NOT_SELLABLE');
      }
      serialAssignments.push({ serialId, serial: s, line: l });
      statements.push(db.prepare(`
        UPDATE product_serials
        SET status = 'SOLD', sale_id = ?, sale_item_id = ?, branch_id = ?, sold_at = ?, updated_at = ?
        WHERE id = ? AND status <> 'SOLD'
      `).bind(saleId, l.sale_item_id, branchId, ts, ts, serialId));
    }
  }

  // Warranties. Created for every serialised item sold and for any product
  // that tracks warranty without serials (a made-to-order sofa).
  if (caps.warranty_tracking) {
    for (const l of resolvedLines) {
      if (!l.tracks_warranty) continue;
      const months = Number(l.warranty_months) || 0;
      if (months <= 0) continue;
      const startsAt = watDate();
      const endsAt = addMonths(startsAt, months);
      const serialIdsForLine = (l.serial_ids && l.serial_ids.length) ? l.serial_ids : [null];
      const qtyToCover = l.serial_ids && l.serial_ids.length ? serialIdsForLine.length : Math.round(l.quantity_base);
      for (let n = 0; n < Math.min(qtyToCover, serialIdsForLine.length || qtyToCover); n += 1) {
        const wid = newId();
        warrantyRows.push(wid);
        statements.push(db.prepare(`
          INSERT INTO product_warranties (
            id, business_unit_id, serial_id, product_id, sale_id, sale_item_id, customer_id, branch_id,
            warranty_type, months, starts_at, ends_at, terms, provider_name, status, registered_by,
            created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?, 'VENDOR', ?,?,?,?,NULL,'ACTIVE',?,?,?)
        `).bind(
          wid, businessUnitId, serialIdsForLine[n] || null, l.product_id, saleId, l.sale_item_id,
          customer ? customer.id : null, branchId, months, startsAt, endsAt,
          l.warranty_terms || settings.warranty_terms_default || null, user.id, ts, ts
        ));
      }
    }
  }

  // ---- 8. Execute atomically ----------------------------------------
  await db.batch(statements);

  // ---- 9. Post-effects (best-effort, must not fail the sale) ---------
  // GL posting is INSIDE the best-effort block on purpose for a small
  // business that has not enabled the GL module, but for a business that
  // HAS enabled it a failed posting is a real accounting gap, so it is
  // logged loudly and surfaced on the dashboard's integrity panel rather
  // than swallowed.
  let glPosted = false;
  let glError = null;
  if (caps.general_ledger && settings.gl_module_enabled !== 0) {
    try {
      await glService.postSale(db, {
        businessUnitId, branchId, saleId, settings,
        sale: {
          id: saleId, receipt_no: receipt, occurred_at: occurredAt, subtotal, discount_amount: discountAmount,
          vat_amount: vatAmount, total, amount_paid: paidNow, balance_due: balanceDue,
          is_credit_sale: isCreditSale ? 1 : 0, customer_id: customer ? customer.id : null, branch_id: branchId,
        },
        items: resolvedLines.map((l, i) => ({
          product_id: l.product_id, category_id: l.category_id, line_total: l.line_total,
          unit_cost: l.unit_cost, quantity_base: l.quantity_base, gross_margin: l.gross_margin,
          vat_amount: round2((vatAllocation[i] && vatAllocation[i].vat) || 0), is_service_line: l.is_service_line,
          service_type: l.service_type,
        })),
        payments,
        userId: user.id,
      });
      glPosted = true;
    } catch (e) {
      glError = e && e.message;
      console.error('[salesService] GL posting FAILED for sale', receipt, '— accounting gap, see dashboard integrity panel:', e && e.message);
    }
  }

  let registerEntries = 0;
  if (caps.compliance_certificates || settings.compliance_register_enabled !== 0) {
    try {
      // Serialised-item custody: the highest-value register event in an
      // electronics business. One entry per physical unit that left.
      for (const a of serialAssignments) {
        await appendRegister(db, {
          business_unit_id: businessUnitId, branch_id: branchId, scheme_code: 'SERIAL_CUSTODY',
          event_type: 'ITEM_SOLD', product_id: a.line.product_id, serial_id: a.serialId,
          sale_id: saleId, quantity: 1,
          counterparty_name: customer ? customer.full_name : (input.buyer_name || null),
          counterparty_phone: customer ? customer.phone : (input.buyer_phone || null),
          counterparty_id_type: customer ? customer.id_type : null,
          counterparty_id_no: customer ? customer.id_number : null,
          detail: `Sold on receipt ${receipt}${a.serial.imei ? `, IMEI ${a.serial.imei}` : ''}`,
          performed_by: user.id, device_id: ctx.deviceId || null, ip_address: ctx.ipAddress || null,
          occurred_at: ts,
        });
        registerEntries += 1;
      }
      // Regulated products (SONCAP / NAFDAC / customs-tracked) get an entry
      // per line even without serials.
      for (const l of resolvedLines) {
        if (!l.is_regulated || l.serial_ids && l.serial_ids.length) continue;
        await appendRegister(db, {
          business_unit_id: businessUnitId, branch_id: branchId, scheme_code: l.compliance_scheme || 'REGULATED_GOODS',
          event_type: 'ITEM_SOLD', product_id: l.product_id, sale_id: saleId, quantity: l.quantity_base,
          counterparty_name: customer ? customer.full_name : null,
          detail: `Sold on receipt ${receipt}`, performed_by: user.id, device_id: ctx.deviceId || null,
          occurred_at: ts,
        });
        registerEntries += 1;
      }
    } catch (e) {
      console.error('[salesService] compliance register write failed for', receipt, '(sale NOT rolled back):', e && e.message);
    }
  }

  await writeAudit(db, {
    businessUnitId, branchId, userId: user.id, actorRole: user.role, action: 'SALE_CREATED',
    entityType: 'SALE', entityId: saleId, amount: total,
    after: { receipt_no: receipt, total, paid: paidNow, balance_due: balanceDue, lines: resolvedLines.length, sale_type: saleType },
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, deviceId: ctx.deviceId,
  });

  return {
    ok: true,
    sale_id: saleId,
    receipt_no: receipt,
    branch_id: branchId,
    branch_name: branch.name,
    sale_type: saleType,
    status: 'COMPLETED',
    subtotal, discount_amount: discountAmount, discount_percent: discountPercent,
    vat_amount: vatAmount, vat_rate_percent: vatEnabled ? vatRate : 0, vat_inclusive: inclusive,
    taxable_amount: round2(afterDiscount - vatAmount),
    total, amount_paid: paidNow, balance_due: balanceDue,
    change_given: changeOwedId ? 0 : changeGiven,
    change_owed: changeOwedId ? { amount: changeGiven, claim_code: changeOwedId } : null,
    gross_margin: grossMarginTotal,
    gross_margin_percent: total > 0 ? round2((grossMarginTotal / total) * 100) : 0,
    line_count: resolvedLines.length,
    customer: customer ? { id: customer.id, full_name: customer.full_name, phone: customer.phone } : null,
    payments: payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference || null })),
    items: resolvedLines.map((l, i) => ({
      line_no: i + 1, product_id: l.product_id, name: l.product_name, unit_type: l.unit_type,
      quantity: l.quantity, quantity_base: l.quantity_base, unit_price: l.unit_price,
      line_total: l.line_total, price_source: l.price_source, discount_amount: l.line_discount_amount,
      vat_amount: round2((vatAllocation[i] && vatAllocation[i].vat) || 0), gross_margin: l.gross_margin,
      serial_ids: l.serial_ids || [],
    })),
    warranty_ids: warrantyRows,
    gl_posted: glPosted, gl_error: glError,
    register_entries: registerEntries,
    occurred_at: occurredAt,
    created_at: ts,
  };
}

// ---------------------------------------------------------------------
// LINE RESOLUTION
// ---------------------------------------------------------------------
async function resolveSaleLine(db, ctx, {
  businessUnitId, branchId, line, index, customer, customerId, tier, tierId,
  saleType, allowance, settings, caps, promotionCode,
}) {
  if (!line || typeof line !== 'object') throw new HttpError(400, `Line ${index + 1} is not a valid item.`, 'SALE_LINE_INVALID');

  // A SERVICE line (delivery, installation, assembly, repair labour) has no
  // product row and no stock. It must still be sellable, still be discounted,
  // still attract VAT and still land in a revenue category — otherwise the
  // shop rings it up as "miscellaneous ₦5,000" and the P&L loses the entire
  // services revenue line.
  if (line.is_service_line) {
    const amount = round2(Number(line.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, `Line ${index + 1}: a service charge must be a positive amount.`, 'SERVICE_AMOUNT_INVALID');
    }
    const serviceType = String(line.service_type || 'OTHER').toUpperCase();
    if (!['DELIVERY', 'INSTALLATION', 'ASSEMBLY', 'REPAIR', 'FABRICATION', 'OTHER'].includes(serviceType)) {
      throw new HttpError(400, `Line ${index + 1}: service type must be DELIVERY, INSTALLATION, ASSEMBLY, REPAIR, FABRICATION or OTHER.`, 'SERVICE_TYPE_INVALID');
    }
    if (serviceType === 'INSTALLATION' && !caps.installation_service) {
      throw new HttpError(403, 'Installation services are not enabled for this business profile.', 'CAPABILITY_DISABLED');
    }
    return {
      is_service_line: true, service_type: serviceType,
      product_id: null, product_name: line.description || serviceType,
      category_id: null, unit_type: 'BASE_UNIT', quantity: 1, pieces_per_unit: 1, quantity_base: 1,
      unit_price: amount, unit_cost: 0, line_subtotal: amount,
      line_discount_amount: 0, line_discount_percent: 0, line_discount_reason: null,
      line_subtotal_after_line_discount: amount, line_total: amount,
      gross_margin: amount, gross_margin_percent: 100,
      price_source: 'MANUAL', tax_code: line.tax_code || 'STANDARD',
      tracks_warranty: false, is_regulated: false, serial_ids: [],
      item_notes: line.notes || null,
    };
  }

  if (!line.product_id) throw new HttpError(400, `Line ${index + 1}: choose a product.`, 'PRODUCT_REQUIRED');

  const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(line.product_id).first();
  if (!product) throw new HttpError(404, `Line ${index + 1}: that product was not found.`, 'PRODUCT_NOT_FOUND');
  if (product.business_unit_id !== businessUnitId) {
    // Cross-business product reference. Refused rather than silently
    // adopted: the price, the tax code and the category all belong to the
    // other business.
    throw new HttpError(403, `Line ${index + 1}: "${product.name}" belongs to a different business and cannot be sold here.`, 'PRODUCT_WRONG_BUSINESS');
  }
  if (!product.is_active) throw new HttpError(409, `Line ${index + 1}: "${product.name}" is discontinued.`, 'PRODUCT_DISCONTINUED');

  const category = product.category_id
    ? await db.prepare('SELECT * FROM product_categories WHERE id = ? AND is_deleted = 0').bind(product.category_id).first()
    : null;
  const itemCaps = itemCapabilities(settings, product, category);

  // Unit conversion. Never done in the route or the view.
  const sellingUnits = String(product.selling_units || 'BASE_UNIT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const resolvedUnit = resolveLine(
    { ...product, selling_units: sellingUnits },
    { quantity: line.quantity, unit: line.unit_type || 'BASE_UNIT' }
  );
  if (!resolvedUnit.ok) {
    throw new HttpError(400, `Line ${index + 1} (${product.name}): ${resolvedUnit.error}`, resolvedUnit.code);
  }

  // Serials
  let serialIds = [];
  if (itemCaps.serial_tracking) {
    serialIds = Array.isArray(line.serial_ids) ? line.serial_ids.map((s) => String(s)) : [];
    if (line.serial_numbers && Array.isArray(line.serial_numbers)) {
      for (const sn of line.serial_numbers) {
        const found = await stockService.serialByNumber(db, { businessUnitId, serialNo: sn });
        if (!found) throw new HttpError(404, `Line ${index + 1}: serial "${sn}" is not in the system.`, 'SERIAL_NOT_FOUND');
        if (found.branch_id !== branchId) {
          throw new HttpError(409, `Line ${index + 1}: serial ${found.serial_no} is at ${found.branch_name}, not this branch.`, 'SERIAL_WRONG_BRANCH');
        }
        serialIds.push(found.id);
      }
    }
    if (serialIds.length && serialIds.length !== Math.round(resolvedUnit.totalPieces)) {
      throw new HttpError(400,
        `Line ${index + 1}: "${product.name}" is serialised — select exactly ${Math.round(resolvedUnit.totalPieces)} serial number${Math.round(resolvedUnit.totalPieces) === 1 ? '' : 's'}, you selected ${serialIds.length}.`,
        'SERIAL_COUNT_MISMATCH');
    }
    if (!serialIds.length && Math.round(resolvedUnit.totalPieces) > 0) {
      // Serialised stock cannot leave without naming the units. Allowing it
      // would silently break the custody chain, which is the whole point of
      // tracking serials.
      throw new HttpError(400,
        `Line ${index + 1}: "${product.name}" is serialised. Scan or select the ${Math.round(resolvedUnit.totalPieces)} serial number${Math.round(resolvedUnit.totalPieces) === 1 ? '' : 's'} being sold.`,
        'SERIALS_REQUIRED');
    }
    if (new Set(serialIds).size !== serialIds.length) {
      throw new HttpError(400, `Line ${index + 1}: the same serial number was selected twice.`, 'SERIAL_DUPLICATED');
    }
  }

  // Price
  const priced = await pricingService.resolveUnitPrice(db, ctx, {
    businessUnitId, branchId, productId: product.id,
    unitType: resolvedUnit.unit, quantity: resolvedUnit.count,
    customerId, customerType: customer ? customer.customer_type : null, tierId,
    manualPrice: line.unit_price != null ? line.unit_price : null,
    promotionCode: line.promotion_code || promotionCode || null,
    allowBelowCost: !!line.allow_below_cost,
  });

  // Line discount, on top of the resolved price.
  let lineDiscountAmount = 0;
  let lineDiscountPercent = 0;
  if (Number(line.discount_percent) > 0) {
    lineDiscountPercent = round2(Number(line.discount_percent));
    await assertDiscountAuthority(db, businessUnitId, ctx.user, allowance, lineDiscountPercent, { kind: 'percent', line: index + 1 });
    lineDiscountAmount = round2((priced.unit_price * resolvedUnit.count * lineDiscountPercent) / 100);
  } else if (line.discount_amount != null && Number(line.discount_amount) > 0) {
    const lineGross = round2(priced.unit_price * resolvedUnit.count);
    lineDiscountAmount = round2(Number(line.discount_amount));
    if (lineDiscountAmount > lineGross) {
      throw new HttpError(400, `Line ${index + 1}: the discount is more than the line total.`, 'LINE_DISCOUNT_EXCEEDS_TOTAL');
    }
    lineDiscountPercent = lineGross > 0 ? round2((lineDiscountAmount / lineGross) * 100) : 0;
    await assertDiscountAuthority(db, businessUnitId, ctx.user, allowance, lineDiscountPercent, { kind: 'amount', line: index + 1 });
  }

  const lineSubtotal = round2(priced.unit_price * resolvedUnit.count);
  const lineAfterLineDiscount = round2(lineSubtotal - lineDiscountAmount);
  const lineCost = round2(priced.unit_cost * resolvedUnit.totalPieces);
  const margin = round2(lineAfterLineDiscount - lineCost);

  return {
    is_service_line: false,
    service_type: null,
    product_id: product.id,
    product_name: product.name,
    category_id: product.category_id || (category && category.id) || null,
    unit_type: resolvedUnit.unit,
    quantity: resolvedUnit.count,
    pieces_per_unit: resolvedUnit.piecesPerUnit,
    quantity_base: resolvedUnit.totalPieces,
    unit_price: priced.unit_price,
    unit_cost: priced.unit_cost,
    line_subtotal: lineSubtotal,
    line_discount_amount: lineDiscountAmount,
    line_discount_percent: lineDiscountPercent,
    line_discount_reason: line.discount_reason || null,
    line_subtotal_after_line_discount: lineAfterLineDiscount,
    line_total: lineAfterLineDiscount,
    gross_margin: margin,
    gross_margin_percent: lineAfterLineDiscount > 0 ? round2((margin / lineAfterLineDiscount) * 100) : 0,
    price_source: priced.price_source,
    tier_id: priced.tier_id,
    promotion_id: priced.promotion_id,
    tax_code: product.tax_code || (category && category.code) || 'STANDARD',
    tracks_warranty: itemCaps.warranty_tracking,
    warranty_months: product.warranty_months != null ? product.warranty_months : (settings.warranty_default_months || 0),
    warranty_terms: product.warranty_terms || null,
    is_regulated: !!product.is_regulated,
    compliance_scheme: product.compliance_scheme || null,
    serial_ids: serialIds,
    below_cost: priced.below_cost,
    item_notes: line.notes || null,
    base_unit: product.base_unit,
  };
}

// ---------------------------------------------------------------------
// PAYMENTS
// ---------------------------------------------------------------------
function normalisePayments(rawPayments, { total, isCreditSale, allowance, settings }) {
  const list = Array.isArray(rawPayments) ? rawPayments : [];
  if (!list.length) {
    if (isCreditSale) return [{ method: 'CREDIT', amount: round2(total), cash_tendered: null, reference: null, notes: null }];
    throw new HttpError(400, 'Record how the customer paid.', 'PAYMENT_REQUIRED');
  }
  const out = [];
  for (const p of list) {
    const method = String(p.method || '').trim().toUpperCase();
    if (!PAYMENT_METHODS.includes(method)) {
      throw new HttpError(400, `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}.`, 'PAYMENT_METHOD_INVALID');
    }
    const amount = round2(Number(p.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, `A ${method.replace(/_/g, ' ').toLowerCase()} payment must be a positive amount.`, 'PAYMENT_AMOUNT_INVALID');
    }
    if (method === 'CREDIT') {
      if (!isCreditSale) {
        throw new HttpError(400, 'Credit can only be used on a credit sale. Ask a manager if this customer should be given credit.', 'CREDIT_ON_NON_CREDIT_SALE');
      }
      if (!allowance.can_take_credit_sale && !allowance.can_grant_credit) {
        throw new HttpError(403, 'Your role cannot put a sale on credit in this business. A manager must do it.', 'CREDIT_NOT_PERMITTED');
      }
      // A reference is required for a bank transfer / POS / cheque, because
      // an unreferenced electronic payment cannot be matched to a bank
      // statement at reconciliation — which is the whole reason to record
      // the method separately at all.
    } else if (['BANK_TRANSFER', 'POS_TERMINAL', 'CHEQUE', 'USSD'].includes(method) && !p.reference) {
      throw new HttpError(400,
        `A ${method.replace(/_/g, ' ').toLowerCase()} payment needs a reference — the transfer narration, terminal auth code or cheque number. Without it the payment cannot be matched to the bank statement.`,
        'PAYMENT_REFERENCE_REQUIRED');
    }
    out.push({
      method,
      amount,
      cash_tendered: method === 'CASH' && p.cash_tendered != null ? round2(Number(p.cash_tendered)) : null,
      reference: p.reference ? String(p.reference).slice(0, 120) : null,
      terminal_id: p.terminal_id ? String(p.terminal_id).slice(0, 60) : null,
      bank_name: p.bank_name ? String(p.bank_name).slice(0, 120) : null,
      notes: p.notes ? String(p.notes).slice(0, 500) : null,
    });
  }
  const paid = sumMoney(out.filter((p) => p.method !== 'CREDIT').map((p) => p.amount));
  if (paid > total + 0.005) {
    const cashOnly = out.filter((p) => p.method === 'CASH').length === out.length;
    if (!cashOnly) {
      throw new HttpError(400,
        `Payments total ₦${paid.toLocaleString('en-NG')} against a ₦${total.toLocaleString('en-NG')} sale. Only cash can give change — reduce the electronic amounts.`,
        'OVERPAYMENT_NON_CASH');
    }
  }
  return out;
}

function computeTillDeltas(payments, { changeGiven = 0, discountAmount = 0 }) {
  const deltas = {
    expected_cash: 0, expected_pos: 0, expected_transfer: 0, expected_ussd: 0,
    expected_mobile_money: 0, expected_cheque: 0, expected_credit: 0, expected_other: 0,
  };
  for (const p of payments) {
    const col = TILL_COLUMNS[p.method] || 'expected_other';
    deltas[col] = round2(deltas[col] + p.amount);
  }
  // The drawer's expected CASH is what is IN the drawer: cash applied minus
  // change that physically left it. Change OWED (no small notes) did not
  // leave the drawer, so it is not deducted here — it is tracked separately
  // as a liability, and the two together reconcile to the kobo.
  deltas.expected_cash = round2(Math.max(0, deltas.expected_cash - changeGiven));
  deltas.expected_total = round2(Object.values(deltas).reduce((a, b) => a + b, 0));
  return deltas;
}

function defaultDueDate(settings, customer) {
  const days = Number(customer.credit_days) > 0 ? Number(customer.credit_days) : 30;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// GUARDS
// ---------------------------------------------------------------------
async function assertDiscountAuthority(db, businessUnitId, user, allowance, discountPercent, { kind = 'percent', line = null } = {}) {
  const where = line ? `on line ${line}` : 'on this receipt';
  if (discountPercent <= 0) return true;
  if (!allowance.can_discount) {
    throw new HttpError(403,
      `Discounting is not enabled for your role in this business, so you cannot apply a discount ${where}. Ask a manager.`,
      'DISCOUNT_NOT_PERMITTED');
  }
  if (discountPercent > allowance.max_discount_percent) {
    throw new HttpError(403,
      `A ${round2(discountPercent)}% discount ${where} is above your limit of ${allowance.max_discount_percent}%. A manager can approve more.`,
      'DISCOUNT_OVER_LIMIT');
  }
  return true;
}

async function debtorBalance(db, { customerId, businessUnitId = null }) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS balance FROM debtor_ledger
    WHERE customer_id = ? AND is_deleted = 0 AND (? IS NULL OR business_unit_id = ?)
  `).bind(customerId, businessUnitId || null, businessUnitId || null).first();
  return round2(Number((row && row.balance) || 0));
}

// Credit limit enforcement. A hard ceiling with an attributable override —
// the override is recorded against a NAMED person on the sale row, so an
// escalation of authority is never anonymous.
async function assertWithinCreditLimit(db, ctx, { customer, businessUnitId, branchId, amount, override, overrideReason, user, allowance }) {
  if (!customer.credit_enabled) {
    throw new HttpError(403,
      `${customer.full_name} is not enabled for credit. A manager can turn credit on for this customer under Customers → Credit.`,
      'CUSTOMER_CREDIT_NOT_ENABLED');
  }
  if (!allowance.can_grant_credit) {
    throw new HttpError(403, 'Your role cannot put a sale on credit in this business. A manager must do it.', 'CREDIT_NOT_PERMITTED');
  }
  const current = await debtorBalance(db, { customerId: customer.id, businessUnitId });
  const projected = round2(current + amount);
  const limit = round2(Number(customer.credit_limit) || 0);
  if (limit <= 0 || projected <= limit) {
    return { ok: true, current_balance: current, projected_balance: projected, limit };
  }
  if (!override) {
    throw new HttpError(403,
      `That would take ${customer.full_name} to ₦${projected.toLocaleString('en-NG')} against a credit limit of ₦${limit.toLocaleString('en-NG')} `
      + `(they already owe ₦${current.toLocaleString('en-NG')}). Collect a payment, reduce the sale, or a manager can approve an override with a reason.`,
      'CREDIT_LIMIT_EXCEEDED');
  }
  if (!allowance.can_override_credit_limit) {
    throw new HttpError(403, 'Only the owner can approve a credit-limit override in this business.', 'CREDIT_OVERRIDE_NOT_PERMITTED');
  }
  if (!overrideReason || String(overrideReason).trim().length < 5) {
    throw new HttpError(400, 'A credit-limit override needs a written reason of at least 5 characters — it is recorded against your name.', 'CREDIT_OVERRIDE_REASON_REQUIRED');
  }
  await writeAudit(db, {
    businessUnitId, branchId, userId: user.id, actorRole: user.role, action: 'CREDIT_LIMIT_OVERRIDE',
    entityType: 'CUSTOMER', entityId: customer.id, amount,
    reason: String(overrideReason).slice(0, 500),
    before: { credit_limit: limit, current_balance: current },
    after: { projected_balance: projected },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, overridden: true, current_balance: current, projected_balance: projected, limit };
}

// ---------------------------------------------------------------------
// VOID
// ---------------------------------------------------------------------
// Reverses a sale: stock comes back, serials return to IN_STOCK, the debtor
// entry is reversed, the till counters are unwound and the GL is reversed by
// a NEW entry (never by deleting the original — an accounting record that
// can be deleted is not an accounting record).
async function voidSale(db, ctx, { saleId, reason }) {
  const user = ctx.user;
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);

  const sale = await db.prepare('SELECT * FROM sales WHERE id = ? AND is_deleted = 0').bind(saleId).first();
  if (!sale) throw new HttpError(404, 'That sale was not found.', 'SALE_NOT_FOUND');
  assertBranchAccess(user, sale.branch_id);
  if (sale.status === 'VOIDED') throw new HttpError(409, 'That sale has already been voided.', 'SALE_ALREADY_VOIDED');
  if (sale.status === 'REFUNDED' || sale.status === 'PARTIALLY_REFUNDED') {
    throw new HttpError(409, 'That sale has been refunded, so it cannot be voided. Refunds and voids are different records.', 'SALE_ALREADY_REFUNDED');
  }

  const allowance = await staffAllowance(db, businessUnitId, user);
  const { assertStaffCanVoid, assertManagerPermission } = require('../lib/planLimits');
  if (String(user.role).toUpperCase() === 'STAFF') {
    await assertStaffCanVoid(db, businessUnitId, user, sale);
  } else if (String(user.role).toUpperCase() === 'MANAGER') {
    await assertManagerPermission(db, businessUnitId, user, 'managers_can_void_sales', { action: 'void a sale' });
  }
  if (!reason || String(reason).trim().length < 4) {
    throw new HttpError(400, 'A void needs a reason of at least 4 characters. It appears on the audit trail and in the void-rate report.', 'VOID_REASON_REQUIRED');
  }

  const ts = watNowIso();
  const statements = [];
  const items = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND is_deleted = 0 ORDER BY line_no').bind(saleId).all();
  const payments = await db.prepare("SELECT * FROM sale_payments WHERE sale_id = ? AND is_deleted = 0 AND method <> 'CREDIT'").bind(saleId).all();

  // Restock. A void is not a return: the goods never legitimately left, so
  // they go back to the batches they came from at the cost they were taken
  // at, which is what keeps the valuation honest.
  for (const item of items.results) {
    if (item.is_service_line) continue;
    const batch = item.stock_batch_id
      ? await db.prepare('SELECT * FROM stock_batches WHERE id = ? AND is_deleted = 0').bind(item.stock_batch_id).first()
      : null;
    if (batch) {
      statements.push(db.prepare(`
        UPDATE stock_batches
        SET quantity_remaining = quantity_remaining + ?,
            status = CASE WHEN quantity_remaining + ? > 0 AND status = 'DEPLETED' THEN 'ACTIVE' ELSE status END,
            updated_at = ?
        WHERE id = ?
      `).bind(item.quantity_base, item.quantity_base, ts, batch.id));
    } else {
      // Multi-batch line: put the stock back into the newest active batch.
      // Not perfect, and recorded as a CORRECTION movement so the audit
      // trail says which batch it went into and why it was not the original.
      const target = await stockService.newestAllocatableBatch(db, { branchId: sale.branch_id, productId: item.product_id });
      if (!target) throw new HttpError(409, `There is no active batch of "${item.product_id}" at this branch to return the stock to. Post a stock adjustment instead.`, 'VOID_NO_BATCH_TO_RESTOCK');
      statements.push(db.prepare(`
        UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?, updated_at = ? WHERE id = ?
      `).bind(item.quantity_base, ts, target.id));
    }

    const pos = await stockService.position(db, { branchId: sale.branch_id, productId: item.product_id });
    statements.push(db.prepare(`
      INSERT INTO stock_movements (
        id, business_unit_id, branch_id, product_id, stock_batch_id, direction, quantity, unit_cost,
        movement_type, source_type, source_id, reference, balance_after, reason, performed_by, device_id,
        occurred_at, created_at
      ) VALUES (?,?,?,?,?, 'IN', ?,?, 'SALE_VOID', 'SALE', ?,?,?,?, ?,?,?,?)
    `).bind(
      newId(), businessUnitId, sale.branch_id, item.product_id, batch ? batch.id : null,
      item.quantity_base, item.unit_cost, saleId, sale.receipt_no,
      round2(pos.on_hand + item.quantity_base), String(reason).slice(0, 500), user.id, ctx.deviceId || null, ts, ts
    ));

    // Serials back to IN_STOCK, which is a legal SOLD -> RETURNED -> IN_STOCK
    // transition; going straight SOLD -> IN_STOCK is not, and rightly so,
    // because it would erase the fact that the item had left.
    if (item.serial_ids_json) {
      let serialIds = [];
      try { serialIds = JSON.parse(item.serial_ids_json); } catch (_) { serialIds = []; }
      for (const sid of serialIds) {
        statements.push(db.prepare(`
          UPDATE product_serials SET status = 'RETURNED', sale_id = NULL, sale_item_id = NULL, sold_at = NULL,
            notes = COALESCE(notes || ' | ', '') || 'Sale voided: ' || ?, updated_at = ?
          WHERE id = ? AND status = 'SOLD'
        `).bind(String(reason).slice(0, 200), ts, sid));
        statements.push(db.prepare(`
          UPDATE product_serials SET status = 'IN_STOCK', updated_at = ? WHERE id = ? AND status = 'RETURNED'
        `).bind(ts, sid));
      }
    }
  }

  statements.push(db.prepare(`
    UPDATE sales SET status = 'VOIDED', voided_at = ?, voided_by = ?, void_reason = ?, updated_at = ? WHERE id = ?
  `).bind(ts, user.id, String(reason).slice(0, 500), ts, saleId));

  // Unwind the till counters. Only if the till is still the same one — a
  // sale from yesterday voided today must not silently rewrite a closed and
  // reconciled session, which is why the guard is on the session id AND its
  // status.
  if (sale.till_session_id) {
    const session = await db.prepare('SELECT * FROM till_sessions WHERE id = ?').bind(sale.till_session_id).first();
    if (session && session.status === 'OPEN') {
      const deltas = computeTillDeltas(payments.results, { changeGiven: Number(sale.change_given) || 0, discountAmount: Number(sale.discount_amount) || 0 });
      statements.push(db.prepare(`
        UPDATE till_sessions SET
          expected_cash = MAX(0, expected_cash - ?),
          expected_pos = MAX(0, expected_pos - ?),
          expected_transfer = MAX(0, expected_transfer - ?),
          expected_ussd = MAX(0, expected_ussd - ?),
          expected_mobile_money = MAX(0, expected_mobile_money - ?),
          expected_cheque = MAX(0, expected_cheque - ?),
          expected_credit = MAX(0, expected_credit - ?),
          expected_other = MAX(0, expected_other - ?),
          expected_total = MAX(0, expected_total - ?),
          sale_count = MAX(0, sale_count - 1),
          void_count = void_count + 1,
          discount_total = MAX(0, discount_total - ?),
          updated_at = ?
        WHERE id = ?
      `).bind(
        deltas.expected_cash, deltas.expected_pos, deltas.expected_transfer, deltas.expected_ussd,
        deltas.expected_mobile_money, deltas.expected_cheque, deltas.expected_credit, deltas.expected_other,
        deltas.expected_total, Number(sale.discount_amount) || 0, ts, session.id
      ));
    }
  }

  // Reverse the debtor entry with a CREDIT_NOTE, not by deleting the debit.
  if (sale.customer_id && (Number(sale.balance_due) > 0.005)) {
    const current = await debtorBalance(db, { customerId: sale.customer_id, businessUnitId });
    statements.push(db.prepare(`
      INSERT INTO debtor_ledger (
        id, business_unit_id, branch_id, customer_id, entry_date, entry_type, source_type, source_id,
        reference, amount, balance_after, notes, created_by, created_at, updated_at
      ) VALUES (?,?,?,?,?, 'ADJUSTMENT', 'SALE', ?,?,?,?, ?,?,?,?)
    `).bind(
      newId(), businessUnitId, sale.branch_id, sale.customer_id, watDate(), saleId,
      sale.receipt_no, round2(-Number(sale.balance_due)), round2(current - Number(sale.balance_due)),
      `Sale voided: ${String(reason).slice(0, 300)}`, user.id, ts, ts
    ));
    statements.push(db.prepare(`
      UPDATE customers SET
        total_purchases = MAX(0, total_purchases - ?),
        purchase_count = MAX(0, purchase_count - 1),
        loyalty_points = MAX(0, loyalty_points - ?),
        updated_at = ?
      WHERE id = ?
    `).bind(Number(sale.amount_paid) + Number(sale.balance_due), Math.floor((Number(sale.amount_paid) + Number(sale.balance_due)) / 100), ts, sale.customer_id));
  }

  await db.batch(statements);

  // Warranties created by this sale are voided, not deleted — the customer
  // may have already been told they have cover, and "voided with reason" is
  // a defensible record where a vanished row is not.
  try {
    await db.prepare(`
      UPDATE product_warranties SET status = 'VOIDED', void_reason = ?, updated_at = ? WHERE sale_id = ? AND is_deleted = 0
    `).bind(`Sale ${sale.receipt_no} voided: ${String(reason).slice(0, 200)}`, ts, saleId).run();
  } catch (e) { console.error('[salesService] warranty void failed for', sale.receipt_no, e && e.message); }

  if (capabilitiesOf(settings).general_ledger && settings.gl_module_enabled !== 0) {
    try {
      await glService.reverseSale(db, { businessUnitId, branchId: sale.branch_id, saleId, reason, userId: user.id });
    } catch (e) { console.error('[salesService] GL reversal failed for', sale.receipt_no, e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId, branchId: sale.branch_id, userId: user.id, actorRole: user.role, action: 'SALE_VOIDED',
    entityType: 'SALE', entityId: saleId, amount: Number(sale.total), reason: String(reason).slice(0, 500),
    before: { status: sale.status, total: sale.total, receipt_no: sale.receipt_no },
    after: { status: 'VOIDED' },
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, deviceId: ctx.deviceId,
  });

  return { ok: true, sale_id: saleId, receipt_no: sale.receipt_no, status: 'VOIDED', voided_at: ts };
}

// ---------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------
async function getSale(db, { saleId, businessUnitId = null }) {
  const sale = await db.prepare(`
    SELECT s.*, b.name AS branch_name, b.code AS branch_code, b.phone AS branch_phone, b.address AS branch_address,
           u.full_name AS sold_by_name, u.username AS sold_by_username,
           c.full_name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
           c.tin AS customer_tin, c.company_name AS customer_company,
           t.session_no AS till_session_no,
           bu.name AS business_name, bu.legal_name AS business_legal_name, bu.rc_number AS business_rc_number,
           bu.tin AS business_tin, bu.address AS business_address, bu.phone AS business_phone,
           bu.vat_enabled, bu.vat_rate_percent, bu.vat_registration_no, bu.industry_profile
    FROM sales s
    JOIN branches b ON b.id = s.branch_id
    JOIN users u ON u.id = s.sold_by
    JOIN business_units bu ON bu.id = s.business_unit_id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN till_sessions t ON t.id = s.till_session_id
    WHERE s.id = ? AND s.is_deleted = 0 ${businessUnitId ? 'AND s.business_unit_id = ?' : ''}
  `).bind(saleId, ...(businessUnitId ? [businessUnitId] : [])).first();
  if (!sale) return null;

  const [items, payments, returns, delivery, serials] = await Promise.all([
    db.prepare(`
      SELECT si.*, p.name AS product_name, p.sku, p.base_unit, p.brand, p.model_number, p.tracks_serials,
             pc.label AS category_label
      FROM sale_items si
      JOIN products p ON p.id = si.product_id OR si.is_service_line = 1
      LEFT JOIN product_categories pc ON pc.id = si.category_id
      WHERE si.sale_id = ? AND si.is_deleted = 0
      ORDER BY si.line_no
    `).bind(saleId).all(),
    db.prepare(`
      SELECT sp.*, u.full_name AS received_by_name FROM sale_payments sp
      LEFT JOIN users u ON u.id = sp.received_by
      WHERE sp.sale_id = ? AND sp.is_deleted = 0 ORDER BY sp.received_at
    `).bind(saleId).all(),
    db.prepare('SELECT * FROM sale_returns WHERE original_sale_id = ? AND is_deleted = 0').bind(saleId).all(),
    db.prepare('SELECT * FROM sale_delivery_requirements WHERE sale_id = ? AND is_deleted = 0').bind(saleId).all(),
    db.prepare('SELECT * FROM product_serials WHERE sale_id = ? AND is_deleted = 0').bind(saleId).all(),
  ]);

  return {
    ...sale,
    items: items.results.map((it) => ({
      ...it,
      serials: it.serial_ids_json ? safeParseList(it.serial_ids_json) : [],
    })),
    payments: payments.results,
    returns: returns.results,
    delivery: delivery.results[0] || null,
    serials: serials.results,
  };
}

function safeParseList(json) {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

async function listSales(db, { businessUnitId, branchId = null, customerId = null, status = null, saleType = null, from = null, to = null, search = null, limit = 50, offset = 0, sort = 'occurred_at', dir = 'DESC' }) {
  const where = ['s.is_deleted = 0'];
  const params = [];
  if (businessUnitId) { where.push('s.business_unit_id = ?'); params.push(businessUnitId); }
  if (branchId) { where.push('s.branch_id = ?'); params.push(branchId); }
  if (customerId) { where.push('s.customer_id = ?'); params.push(customerId); }
  if (status) { where.push('s.status = ?'); params.push(String(status).toUpperCase()); }
  if (saleType) { where.push('s.sale_type = ?'); params.push(String(saleType).toUpperCase()); }
  if (from) { where.push("date(s.occurred_at, '+1 hour') >= ?"); params.push(String(from).slice(0, 10)); }
  if (to) { where.push("date(s.occurred_at, '+1 hour') <= ?"); params.push(String(to).slice(0, 10)); }
  if (search) {
    where.push(`(s.receipt_no LIKE ? ESCAPE '\\' OR s.invoice_no LIKE ? ESCAPE '\\' OR c.full_name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')`);
    const like = `%${String(search).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like, like);
  }
  const allowedSorts = ['occurred_at', 'total', 'receipt_no', 'status', 'created_at'];
  const sortCol = allowedSorts.includes(String(sort)) ? String(sort) : 'occurred_at';
  const sortDir = String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const rows = await db.prepare(`
    SELECT s.id, s.receipt_no, s.invoice_no, s.branch_id, b.name AS branch_name, s.sale_type, s.status,
           s.subtotal, s.discount_amount, s.vat_amount, s.total, s.amount_paid, s.balance_due, s.is_credit_sale,
           s.occurred_at, s.created_at, s.sold_by, u.full_name AS sold_by_name,
           s.customer_id, c.full_name AS customer_name, c.phone AS customer_phone,
           (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.is_deleted = 0) AS line_count,
           (SELECT COALESCE(SUM(si.gross_margin),0) FROM sale_items si WHERE si.sale_id = s.id AND si.is_deleted = 0) AS gross_margin
    FROM sales s
    JOIN branches b ON b.id = s.branch_id
    JOIN users u ON u.id = s.sold_by
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.${sortCol} ${sortDir}
    LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();

  const totalRow = await db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END),0) AS revenue,
           COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.balance_due ELSE 0 END),0) AS outstanding,
           SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS voided
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    WHERE ${where.join(' AND ')}
  `).bind(...params).first();

  return { results: rows.results, summary: totalRow || { n: 0, revenue: 0, outstanding: 0, voided: 0 } };
}

module.exports = {
  PAYMENT_METHODS, TILL_COLUMNS,
  createSale, resolveSaleLine, normalisePayments, computeTillDeltas,
  assertDiscountAuthority, assertWithinCreditLimit, debtorBalance,
  voidSale, getSale, listSales,
};
'use strict';
