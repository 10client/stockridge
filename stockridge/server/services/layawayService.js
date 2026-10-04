// =====================================================================
// StockRidge — LAYAWAY / HOLDS
// =====================================================================
// "Pay small-small, collect when it is complete." The customer pays a
// deposit, the shop holds the goods, and the customer collects when the
// balance is cleared.
//
// THE COMMERCIAL QUESTION IS FORFEITURE, and it is the reason this is a
// module rather than a flag on a sale: when a customer abandons a hold they
// have paid real money. What happens to it cannot be left to the cashier's
// discretion at the counter, because the answer differs by shop and by
// customer and an argument about it is an argument the shop always loses in
// the neighbourhood. So the policy is EXPLICIT and OWNER-SET:
//
//   forfeiture_percent — how much of what was paid the business keeps
//   refunded_amount    — what goes back
//   expiry_date        — after which the hold lapses
//
// STOCK IS RESERVED, NEVER DECREMENTS. The goods are physically still in the
// shop; they are just promised. Reserved quantity is excluded from
// "available to sell" so two cashiers cannot both promise the last
// television, and it is released either into a sale (completion) or back to
// the shelf (cancellation/expiry). Treating a hold as a sale would show
// revenue the business has not earned and stock it still physically holds.
//
// ACCOUNTING: a deposit on a layaway is a LIABILITY (customer deposits), not
// revenue. Revenue is recognised when the goods are collected. Recognising
// it on deposit is how a shop that has taken ₦2m in layaway deposits shows a
// profit it cannot spend and a tax bill on money it may yet refund.
// =====================================================================

const { newId, watNowIso, watDate, addDays } = require('../../shared/ids');
const { round2, toKobo, sumMoney } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const stockService = require('./stockService');
const { PREFIXES, nextReference } = require('../lib/references');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { assertCapability, capabilitiesOf } = require('../lib/capabilities');
const { getUnitSettings, assertSubscribed } = require('../lib/planLimits');

const STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FORFEITED'];

async function create(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'open a layaway hold' });
  assertCapability(settings, 'layaway_holds', { action: 'open a layaway hold' });

  const branchId = input.branch_id || ctx.user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch is holding these goods.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, branchId);

  if (!input.customer_id) throw new HttpError(400, 'A layaway hold must be against a named customer — an anonymous hold cannot be collected by the right person.', 'LAYAWAY_CUSTOMER_REQUIRED');
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(input.customer_id).first();
  if (!customer) throw new HttpError(404, 'That customer was not found.', 'CUSTOMER_NOT_FOUND');
  if (!customer.phone) {
    throw new HttpError(400, 'Record a phone number for this customer first. A hold that expires with no way to contact the customer becomes a forfeiture dispute.', 'LAYAWAY_PHONE_REQUIRED');
  }

  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw new HttpError(400, 'A hold needs at least one item.', 'LAYAWAY_EMPTY');

  const pricingService = require('./pricingService');
  const ts = watNowIso();
  const holdId = newId();
  const branch = await db.prepare('SELECT code FROM branches WHERE id = ?').bind(branchId).first();
  const holdNo = (await nextReference(db, { businessUnitId, prefix: PREFIXES.LAYAWAY, branchCode: branch.code || '*', scope: 'YEAR' })).reference;

  let total = 0;
  const pricedItems = [];
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (!raw.product_id) throw new HttpError(400, `Line ${i + 1}: choose a product.`, 'PRODUCT_REQUIRED');
    const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(raw.product_id).first();
    if (!product) throw new HttpError(404, `Line ${i + 1}: that product was not found.`, 'PRODUCT_NOT_FOUND');
    const qty = Number(raw.quantity) || 1;
    if (qty <= 0) throw new HttpError(400, `Line ${i + 1}: quantity must be more than zero.`, 'LAYAWAY_QUANTITY_INVALID');

    const priced = await pricingService.resolveUnitPrice(db, ctx, {
      businessUnitId, branchId, productId: product.id, unitType: raw.unit_type || 'BASE_UNIT',
      quantity: qty, customerId: customer.id,
    });
    const lineTotal = round2(priced.unit_price * qty);
    total = round2(total + lineTotal);
    pricedItems.push({ product_id: product.id, product_name: product.name, quantity: qty, unit_price: priced.unit_price, line_total: lineTotal, serial_id: raw.serial_id || null, stock_batch_id: priced.batch_id || null });
  }

  // PRICE PROTECTION. A hold can run for months and the exchange rate can
  // move the replacement cost of the goods. The price is FROZEN at hold time
  // — that is the entire value proposition of a layaway for the customer —
  // and the business absorbs the movement. Storing the price per line is what
  // makes that enforceable rather than a matter of memory.
  const depositPercent = round2(Math.min(100, Math.max(0, Number(input.deposit_percent) != null ? Number(input.deposit_percent) : 20)));
  const depositAmount = input.deposit_amount != null ? round2(Number(input.deposit_amount)) : round2((total * depositPercent) / 100);
  if (depositAmount <= 0) {
    throw new HttpError(400, 'A hold needs a deposit of more than zero. A zero-deposit hold reserves stock against nobody\u2019s commitment.', 'LAYAWAY_DEPOSIT_REQUIRED');
  }
  if (depositAmount > total) {
    throw new HttpError(400, `The deposit cannot exceed the ₦${total.toLocaleString('en-NG')} total.`, 'LAYAWAY_DEPOSIT_EXCEEDS_TOTAL');
  }

  const holdDays = Number(input.hold_days) || 90;
  if (holdDays < 7 || holdDays > 730) throw new HttpError(400, 'A hold must run between 7 and 730 days.', 'LAYAWAY_DURATION_INVALID');
  const expiry = addDays(watDate(), holdDays);

  const forfeiturePercent = round2(Math.min(100, Math.max(0, Number(input.forfeiture_percent) != null ? Number(input.forfeiture_percent) : 25)));

  // Reserve the stock BEFORE writing the hold, so a hold can never exist
  // against stock that is not there.
  const reservationIds = [];
  try {
    for (const pi of pricedItems) {
      const r = await stockService.reserve(db, {
        businessUnitId, branchId, productId: pi.product_id, quantity: pi.quantity,
        sourceType: 'LAYAWAY', sourceId: holdId, serialId: pi.serial_id || null,
        batchId: pi.stock_batch_id || null, customerId: customer.id, expiresAt: `${expiry} 23:59:59`,
        reservedBy: ctx.user.id,
      });
      reservationIds.push(r.reservation_id);
    }
  } catch (e) {
    // Release anything already reserved, or a failed hold leaves stock
    // committed to nothing — invisible shrinkage of availability.
    for (const rid of reservationIds) {
      try { await stockService.releaseReservation(db, rid, { status: 'CANCELLED' }); } catch (_) { /* best effort */ }
    }
    throw e;
  }

  const statements = [
    db.prepare(`
      INSERT INTO layaway_holds (
        id, business_unit_id, branch_id, hold_no, customer_id, status, deposit_percent, deposit_amount,
        total_amount, amount_paid, balance_due, forfeiture_percent, expiry_date, created_by, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?, 'ACTIVE', ?,?,?, 0, ?,?,?, ?,?,?)
    `).bind(holdId, businessUnitId, branchId, holdNo, customer.id, depositPercent, depositAmount,
      total, total, depositAmount, forfeiturePercent, expiry, ctx.user.id, input.notes || null, ts, ts),
  ];
  for (const pi of pricedItems) {
    statements.push(db.prepare(`
      INSERT INTO layaway_items (id, layaway_hold_id, business_unit_id, product_id, stock_batch_id, serial_id,
        quantity, unit_price, line_total, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).bind(newId(), holdId, businessUnitId, pi.product_id, pi.stock_batch_id || null, pi.serial_id || null,
      pi.quantity, pi.unit_price, pi.line_total, ts, ts));
  }
  await db.batch(statements);

  let depositRecorded = null;
  if (depositAmount > 0 && input.record_deposit !== false) {
    depositRecorded = await recordPayment(db, ctx, {
      holdId, amount: depositAmount, kind: 'DEPOSIT',
      method: (input.deposit_method || 'CASH'), reference: input.deposit_reference || null,
    });
  }

  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'LAYAWAY_CREATED', entityType: 'LAYAWAY_HOLD', entityId: holdId, amount: total,
    after: { hold_no: holdNo, deposit: depositAmount, expiry, items: pricedItems.length },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id: holdId, hold_no: holdNo, status: 'ACTIVE',
    customer: { id: customer.id, full_name: customer.full_name, phone: customer.phone },
    items: pricedItems, total_amount: total, deposit_percent: depositPercent, deposit_amount: depositAmount,
    balance_due: round2(total - depositAmount), expiry_date: expiry, forfeiture_percent: forfeiturePercent,
    deposit_payment: depositRecorded,
    advisory: `The price is frozen at today's ₦${total.toLocaleString('en-NG')} until ${expiry}. If the hold lapses, ${forfeiturePercent}% of what was paid is retained and the rest refunded — tell the customer now, not at the counter in three months.`,
  };
}

async function recordPayment(db, ctx, { holdId, amount, kind = 'INSTALMENT', method = 'CASH', reference = null, note = null }) {
  const hold = await load(db, holdId, ctx.businessUnitId);
  if (!hold) throw new HttpError(404, 'That hold was not found.', 'LAYAWAY_NOT_FOUND');
  assertBranchAccess(ctx.user, hold.branch_id);
  if (hold.status !== 'ACTIVE') throw new HttpError(409, `A ${hold.status} hold cannot take a payment.`, 'LAYAWAY_NOT_ACTIVE');

  const value = round2(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'The payment must be more than zero.', 'LAYAWAY_PAYMENT_INVALID');
  const k = String(kind).toUpperCase();
  if (!['DEPOSIT', 'INSTALMENT', 'FINAL', 'REFUND', 'FORFEITURE'].includes(k)) throw new HttpError(400, 'Kind must be DEPOSIT, INSTALMENT, FINAL, REFUND or FORFEITURE.', 'LAYAWAY_PAYMENT_KIND_INVALID');

  const paidSoFar = round2(Number(hold.amount_paid));
  const balance = round2(Number(hold.total_amount) - paidSoFar);
  if (k !== 'REFUND' && k !== 'FORFEITURE' && value > balance + 0.005) {
    throw new HttpError(400,
      `That is ₦${value.toLocaleString('en-NG')} against a ₦${balance.toLocaleString('en-NG')} balance. If the customer is paying the balance in full, complete the hold — that releases the goods and prints the receipt.`,
      'LAYAWAY_OVERPAYMENT');
  }

  const m = String(method).toUpperCase();
  if (!['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'USSD', 'MOBILE_MONEY', 'CHEQUE', 'OTHER'].includes(m)) {
    throw new HttpError(400, 'Payment method must be CASH, POS_TERMINAL, BANK_TRANSFER, USSD, MOBILE_MONEY, CHEQUE or OTHER.', 'LAYAWAY_PAYMENT_METHOD_INVALID');
  }
  if (['BANK_TRANSFER', 'POS_TERMINAL', 'CHEQUE', 'USSD'].includes(m) && !reference) {
    throw new HttpError(400, `A ${m.replace(/_/g, ' ').toLowerCase()} payment needs a reference so it can be matched to the bank statement.`, 'LAYAWAY_PAYMENT_REFERENCE_REQUIRED');
  }

  const branchId = ctx.user.branch_id || hold.branch_id;
  const ts = watNowIso();
  const receiptNo = (await nextReference(db, { businessUnitId: hold.business_unit_id, prefix: PREFIXES.LAYAWAY_RECEIPT, branchCode: '*', scope: 'YEAR' })).reference;
  const paymentId = newId();
  const signed = ['REFUND', 'FORFEITURE'].includes(k) ? -1 : 1;

  const till = await db.prepare(`SELECT * FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0`).bind(branchId).first();
  const statements = [
    db.prepare(`
      INSERT INTO layaway_payments (
        id, layaway_hold_id, business_unit_id, branch_id, till_session_id, receipt_no, amount, kind,
        method, reference, received_by, received_at, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(paymentId, holdId, hold.business_unit_id, branchId, till ? till.id : null, receiptNo, value, k, m,
      reference ? String(reference).slice(0, 120) : null, ctx.user.id, ts, note ? String(note).slice(0, 500) : null, ts, ts),
  ];
  if (signed > 0) {
    const newPaid = round2(paidSoFar + value);
    statements.push(db.prepare(`UPDATE layaway_holds SET amount_paid = ?, balance_due = ?, updated_at = ? WHERE id = ?`)
      .bind(newPaid, round2(Math.max(0, Number(hold.total_amount) - newPaid)), ts, holdId));
  }
  if (till && m === 'CASH' && signed > 0) {
    statements.push(db.prepare(`UPDATE till_sessions SET expected_cash = expected_cash + ?, expected_total = expected_total + ?, updated_at = ? WHERE id = ?`)
      .bind(value, value, ts, till.id));
  }
  await db.batch(statements);

  // A layaway deposit is a LIABILITY, not revenue. See the header comment:
  // recognising it on receipt overstates profit and creates a tax bill on
  // money that may yet be refunded.
  if (signed > 0 && capabilitiesOf(ctx.businessUnit || await getUnitSettings(db, hold.business_unit_id)).general_ledger) {
    try {
      const glService = require('./glService');
      const account = { CASH: '1000', POS_TERMINAL: '1030', BANK_TRANSFER: '1020', USSD: '1040', MOBILE_MONEY: '1040', CHEQUE: '1050', OTHER: '1020' }[m] || '1020';
      await glService.postEntry(db, {
        businessUnitId: hold.business_unit_id, branchId, entryDate: watDate(),
        sourceType: 'LAYAWAY', sourceId: holdId, reference: receiptNo,
        description: `Layaway ${k.toLowerCase()} ${receiptNo} — ${hold.hold_no}`,
        lines: [
          { account_code: account, debit: value, credit: 0, description: `Layaway ${hold.hold_no}` },
          { account_code: '2200', debit: 0, credit: value, description: `Customer deposit ${hold.hold_no}` },
        ],
        userId: ctx.user.id,
      });
    } catch (e) { console.error('[layawayService] GL posting failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId: hold.business_unit_id, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'LAYAWAY_PAYMENT', entityType: 'LAYAWAY_HOLD', entityId: holdId, amount: value,
    after: { receipt_no: receiptNo, kind: k, balance_due: round2(Math.max(0, Number(hold.total_amount) - (paidSoFar + value * signed))) },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, payment_id: paymentId, receipt_no: receiptNo, kind: k, amount: value, method: m };
}

// COMPLETE: balance cleared, goods released, a real sale is created.
async function complete(db, ctx, { holdId, finalPayment = null, note = null }) {
  const hold = await load(db, holdId, ctx.businessUnitId);
  if (!hold) throw new HttpError(404, 'That hold was not found.', 'LAYAWAY_NOT_FOUND');
  assertBranchAccess(ctx.user, hold.branch_id);
  if (hold.status !== 'ACTIVE') throw new HttpError(409, `That hold is ${hold.status}.`, 'LAYAWAY_NOT_ACTIVE');

  const paid = round2(Number(hold.amount_paid));
  const total = round2(Number(hold.total_amount));
  const balance = round2(total - paid);

  if (toKobo(balance) > 0) {
    if (!finalPayment) {
      throw new HttpError(400,
        `₦${balance.toLocaleString('en-NG')} is still outstanding on this hold. Take the final payment to complete it — the goods cannot be released against an unpaid balance.`,
        'LAYAWAY_BALANCE_OUTSTANDING');
    }
    const fp = round2(Number(finalPayment.amount));
    if (fp < balance - 0.005) {
      throw new HttpError(400, `That payment of ₦${fp.toLocaleString('en-NG')} does not clear the ₦${balance.toLocaleString('en-NG')} balance.`, 'LAYAWAY_FINAL_PAYMENT_SHORT');
    }
    await recordPayment(db, ctx, {
      holdId, amount: balance, kind: 'FINAL', method: finalPayment.method || 'CASH',
      reference: finalPayment.reference || null, note: note || 'Final payment on completion',
    });
  }

  // EXPIRY CHECK. Completing an expired hold is allowed — the customer came
  // back and paid — but it must be recorded, because the alternative is a
  // shop quietly honouring holds years later with no stock to show for them.
  const expired = hold.expiry_date && hold.expiry_date < watDate();
  const ts = watNowIso();

  // Release the reservations and create the sale. The sale consumes the
  // RESERVED quantity (fromReserved: true) so the reservation does not end up
  // dangling against stock that has already gone.
  const reservations = await db.prepare(`SELECT id FROM stock_reservations WHERE source_type = 'LAYAWAY' AND source_id = ? AND status = 'ACTIVE'`).bind(holdId).all();
  for (const r of reservations.results) {
    try { await stockService.releaseReservation(db, r.id, { status: 'FULFILLED', releaseStock: false }); } catch (e) { console.error('[layawayService] reservation release failed:', e && e.message); }
  }

  const items = await db.prepare(`
    SELECT li.*, p.name AS product_name FROM layaway_items li JOIN products p ON p.id = li.product_id
    WHERE li.layaway_hold_id = ? AND li.is_deleted = 0
  `).bind(holdId).all();

  const salesService = require('./salesService');
  let sale = null;
  try {
    sale = await salesService.createSale(db, ctx, {
      branch_id: hold.branch_id,
      customer_id: hold.customer_id,
      sale_type: 'LAYAWAY_RELEASE',
      layaway_hold_id: holdId,
      items: items.results.map((it) => ({
        product_id: it.product_id,
        quantity: Number(it.quantity),
        unit_type: 'BASE_UNIT',
        unit_price: Number(it.unit_price),       // the FROZEN hold price, not today's price
        serial_ids: it.serial_id ? [it.serial_id] : undefined,
        notes: `Layaway ${hold.hold_no}${expired ? ' (completed after the hold expiry date)' : ''}`,
      })),
      payments: [{ method: 'CREDIT', amount: total }],   // already paid through the hold
      notes: note || `Completed layaway hold ${hold.hold_no}`,
    });
  } catch (e) {
    // If the sale cannot be created (e.g. no open till), the hold stays
    // ACTIVE and the money stays taken — which is recoverable. Completing the
    // hold first and failing the sale would be the unrecoverable order.
    throw new HttpError(e.status || 500,
      `The hold could not be completed into a sale: ${e.message}. The payments are still recorded against the hold.`,
      'LAYAWAY_COMPLETION_FAILED');
  }

  await db.prepare(`
    UPDATE layaway_holds SET status = 'COMPLETED', completed_sale_id = ?, notes = COALESCE(notes || ' | ','') || ?, updated_at = ?
    WHERE id = ?
  `).bind(sale.sale_id, `Completed into ${sale.receipt_no}${expired ? ' after expiry' : ''}. ${note || ''}`.slice(0, 500), ts, holdId).run();

  // Move the deposit liability to revenue now that the goods have gone. This
  // is the point at which the money is actually earned.
  if (capabilitiesOf(ctx.businessUnit || await getUnitSettings(db, hold.business_unit_id)).general_ledger) {
    try {
      const glService = require('./glService');
      await glService.postEntry(db, {
        businessUnitId: hold.business_unit_id, branchId: hold.branch_id, entryDate: watDate(),
        sourceType: 'LAYAWAY', sourceId: holdId, reference: hold.hold_no,
        description: `Layaway ${hold.hold_no} completed — deposit liability released to revenue`,
        lines: [
          { account_code: '2200', debit: round2(Number(hold.amount_paid)), credit: 0, description: `Deposit released ${hold.hold_no}` },
          { account_code: '1200', debit: 0, credit: round2(Number(hold.amount_paid)), description: `Recognised on ${sale.receipt_no}` },
        ],
        userId: ctx.user.id,
      });
    } catch (e) { console.error('[layawayService] GL completion posting failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId: hold.business_unit_id, branchId: hold.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'LAYAWAY_COMPLETED', entityType: 'LAYAWAY_HOLD', entityId: holdId,
    amount: total, after: { status: 'COMPLETED', sale_id: sale.sale_id, receipt_no: sale.receipt_no, completed_after_expiry: expired },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id: holdId, hold_no: hold.hold_no, status: 'COMPLETED',
    sale_id: sale.sale_id, receipt_no: sale.receipt_no, total_amount: total,
    completed_after_expiry: expired,
    advisory: expired ? 'This hold had passed its expiry date and was completed anyway. That is allowed, but it is recorded — repeated late completions mean the expiry period is too short for your customers.' : null,
  };
}

// CANCEL. Applies the forfeiture policy and refunds the rest.
async function cancel(db, ctx, { holdId, reason, refundMethod = 'CASH', applyForfeiture = true, note = null }) {
  const hold = await load(db, holdId, ctx.businessUnitId);
  if (!hold) throw new HttpError(404, 'That hold was not found.', 'LAYAWAY_NOT_FOUND');
  assertBranchAccess(ctx.user, hold.branch_id);
  if (hold.status !== 'ACTIVE') throw new HttpError(409, `That hold is ${hold.status}.`, 'LAYAWAY_NOT_ACTIVE');
  if (!reason || String(reason).trim().length < 4) {
    throw new HttpError(400, 'Cancelling a hold needs a reason of at least 4 characters — the customer has paid money and this is the record of why it stopped.', 'LAYAWAY_CANCEL_REASON_REQUIRED');
  }

  const paid = round2(Number(hold.amount_paid));
  const forfeitPercent = applyForfeiture ? round2(Number(hold.forfeiture_percent)) : 0;
  const forfeited = round2((paid * forfeitPercent) / 100);
  const refund = round2(Math.max(0, paid - forfeited));

  // A full refund with no forfeiture is a manager decision, not a cashier
  // one: it is the difference between "we changed our mind" and "we are
  // giving away stock reservations for free".
  if (applyForfeiture === false && paid > 0 && String(ctx.user.role).toUpperCase() === 'STAFF') {
    throw new HttpError(403, 'Waiving the forfeiture on a cancelled hold needs a manager. The policy is set by the owner and a cashier cannot override it at the counter.', 'LAYAWAY_FORFEITURE_WAIVER_FORBIDDEN');
  }

  const ts = watNowIso();
  const reservations = await db.prepare(`SELECT id FROM stock_reservations WHERE source_type = 'LAYAWAY' AND source_id = ? AND status = 'ACTIVE'`).bind(holdId).all();
  for (const r of reservations.results) {
    // Release back to the shelf. This is the whole point of reserving rather
    // than selling: the stock becomes available again immediately.
    try { await stockService.releaseReservation(db, r.id, { status: 'CANCELLED', releaseStock: true }); } catch (e) { console.error('[layawayService] reservation release failed:', e && e.message); }
  }

  const status = forfeited > 0 ? 'FORFEITED' : 'CANCELLED';
  const statements = [
    db.prepare(`
      UPDATE layaway_holds SET status = ?, cancelled_by = ?, cancelled_at = ?, cancellation_reason = ?,
        forfeited_amount = ?, refunded_amount = ?, notes = COALESCE(notes || ' | ','') || ?, updated_at = ?
      WHERE id = ?
    `).bind(status, ctx.user.id, ts, String(reason).slice(0, 500), forfeited, refund,
      String(note || '').slice(0, 300), ts, holdId),
  ];
  if (refund > 0) {
    const receiptNo = (await nextReference(db, { businessUnitId: hold.business_unit_id, prefix: PREFIXES.LAYAWAY_RECEIPT, branchCode: '*', scope: 'YEAR' })).reference;
    statements.push(db.prepare(`
      INSERT INTO layaway_payments (
        id, layaway_hold_id, business_unit_id, branch_id, receipt_no, amount, kind, method,
        reference, received_by, received_at, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?, 'REFUND', ?,?,?,?, ?,?,?)
    `).bind(newId(), holdId, hold.business_unit_id, hold.branch_id, receiptNo, refund,
      String(refundMethod).toUpperCase(), `Refund on cancellation of ${hold.hold_no}`,
      ctx.user.id, ts, String(reason).slice(0, 300), ts, ts));
  }
  await db.batch(statements);

  if (capabilitiesOf(ctx.businessUnit || await getUnitSettings(db, hold.business_unit_id)).general_ledger) {
    try {
      const glService = require('./glService');
      const lines = [{ account_code: '2200', debit: paid, credit: 0, description: `Deposit released on cancellation ${hold.hold_no}` }];
      if (refund > 0.004) lines.push({ account_code: '1000', debit: 0, credit: refund, description: `Refunded to customer ${hold.hold_no}` });
      if (forfeited > 0.004) {
        // Retained forfeiture is income, but it is NOT sales revenue — it is a
        // cancellation charge, and mixing it into turnover would overstate
        // trading performance with money that came from a sale that did not
        // happen.
        lines.push({ account_code: '4910', debit: 0, credit: forfeited, description: `Forfeiture retained ${hold.hold_no}` });
      }
      await glService.postEntry(db, {
        businessUnitId: hold.business_unit_id, branchId: hold.branch_id, entryDate: watDate(),
        sourceType: 'LAYAWAY', sourceId: holdId, reference: hold.hold_no,
        description: `Layaway ${hold.hold_no} cancelled — ${reason}`.slice(0, 500), lines, userId: ctx.user.id,
      });
    } catch (e) { console.error('[layawayService] GL cancellation posting failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId: hold.business_unit_id, branchId: hold.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'LAYAWAY_CANCELLED', entityType: 'LAYAWAY_HOLD', entityId: holdId,
    amount: refund, reason: String(reason).slice(0, 500),
    after: { status, forfeited, refund, refund_method: refundMethod },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id: holdId, hold_no: hold.hold_no, status,
    amount_paid: paid, forfeited, refunded: refund, refund_method: refundMethod,
    stock_released: reservations.results.length,
    advisory: refund > 0 ? `₦${refund.toLocaleString('en-NG')} is due back to ${hold.customer_name}${refundMethod === 'CASH' ? ' from the till or safe' : ` by ${refundMethod.toLowerCase()}`}.` : null,
  };
}

// Expire holds that have lapsed. Run by the maintenance job. Notifies nobody
// by itself — it flags them for the branch manager, because silently
// forfeiting a customer's deposit on a timer is how a shop loses a
// neighbourhood.
async function expireLapsed(db, { businessUnitId, limit = 200 }) {
  const rows = await db.prepare(`
    SELECT * FROM layaway_holds
    WHERE status = 'ACTIVE' AND is_deleted = 0 AND expiry_date < date('now','+1 hour')
      AND (? IS NULL OR business_unit_id = ?)
    ORDER BY expiry_date ASC LIMIT ?
  `).bind(businessUnitId || null, businessUnitId || null, Number(limit) || 200).all();

  const ts = watNowIso();
  const expired = [];
  for (const hold of rows.results) {
    const reservations = await db.prepare(`SELECT id FROM stock_reservations WHERE source_type = 'LAYAWAY' AND source_id = ? AND status = 'ACTIVE'`).bind(hold.id).all();
    for (const r of reservations.results) {
      try { await stockService.releaseReservation(db, r.id, { status: 'EXPIRED', releaseStock: true }); } catch (e) { console.error('[layawayService] expiry release failed:', e && e.message); }
    }
    await db.prepare(`
      UPDATE layaway_holds SET status = 'EXPIRED', notes = COALESCE(notes || ' | ','') || ?, updated_at = ? WHERE id = ?
    `).bind(`Lapsed on ${hold.expiry_date}; stock released. Money still held pending a manager decision.`, ts, hold.id).run();
    expired.push({ id: hold.id, hold_no: hold.hold_no, customer_name: hold.customer_name, customer_phone: hold.customer_phone, amount_paid: round2(Number(hold.amount_paid)), expiry_date: hold.expiry_date, branch_id: hold.branch_id });
  }
  return { expired_count: expired.length, expired };
}

async function load(db, holdId, businessUnitId = null) {
  return db.prepare(`
    SELECT lh.*, c.full_name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
           b.name AS branch_name, u.full_name AS created_by_name,
           CAST(julianday(lh.expiry_date) - julianday('now','+1 hour') AS INTEGER) AS days_to_expiry
    FROM layaway_holds lh
    JOIN customers c ON c.id = lh.customer_id
    JOIN branches b ON b.id = lh.branch_id
    LEFT JOIN users u ON u.id = lh.created_by
    WHERE lh.id = ? AND lh.is_deleted = 0 ${businessUnitId ? 'AND lh.business_unit_id = ?' : ''}
  `).bind(holdId, ...(businessUnitId ? [businessUnitId] : [])).first();
}

async function getWithItems(db, holdId, businessUnitId) {
  const hold = await load(db, holdId, businessUnitId);
  if (!hold) return null;
  const [items, payments] = await Promise.all([
    db.prepare(`
      SELECT li.*, p.name AS product_name, p.sku, p.base_unit, ps.serial_no
      FROM layaway_items li JOIN products p ON p.id = li.product_id
      LEFT JOIN product_serials ps ON ps.id = li.serial_id
      WHERE li.layaway_hold_id = ? AND li.is_deleted = 0
    `).bind(holdId).all(),
    db.prepare(`SELECT lp.*, u.full_name AS received_by_name FROM layaway_payments lp LEFT JOIN users u ON u.id = lp.received_by WHERE lp.layaway_hold_id = ? AND lp.is_deleted = 0 ORDER BY lp.received_at`).bind(holdId).all(),
  ]);
  return { ...hold, items: items.results, payments: payments.results };
}

async function list(db, { businessUnitId, branchId = null, customerId = null, status = null, expiringWithinDays = null, limit = 50, offset = 0 }) {
  const where = ['lh.is_deleted = 0', 'lh.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('lh.branch_id = ?'); params.push(branchId); }
  if (customerId) { where.push('lh.customer_id = ?'); params.push(customerId); }
  if (status) { where.push('lh.status = ?'); params.push(String(status).toUpperCase()); }
  if (expiringWithinDays) { where.push(`lh.status = 'ACTIVE' AND julianday(lh.expiry_date) - julianday('now','+1 hour') <= ?`); params.push(Number(expiringWithinDays)); }

  const rows = await db.prepare(`
    SELECT lh.*, c.full_name AS customer_name, c.phone AS customer_phone, b.name AS branch_name,
      (SELECT COUNT(*) FROM layaway_items li WHERE li.layaway_hold_id = lh.id AND li.is_deleted = 0) AS item_count,
      CAST(julianday(lh.expiry_date) - julianday('now','+1 hour') AS INTEGER) AS days_to_expiry
    FROM layaway_holds lh
    JOIN customers c ON c.id = lh.customer_id
    JOIN branches b ON b.id = lh.branch_id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE lh.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, lh.expiry_date ASC
    LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();
  return rows.results;
}

module.exports = { STATUSES, create, recordPayment, complete, cancel, expireLapsed, load, getWithItems, list };
'use strict';
