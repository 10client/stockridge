'use strict';
// =====================================================================
// server/routes/afterSales.js — WHAT HAPPENS AFTER THE RECEIPT
// =====================================================================
// Four flows, all of which move money or stock BACKWARDS and therefore all of
// which need the same discipline as a forward sale:
//
//   RETURNS      goods come back, stock returns to the ORIGINAL batch at its
//                ORIGINAL cost, and the ledger is reversed rather than edited.
//   WARRANTY     a claim against a serial number, with a route back to the
//                supplier for recovery.
//   DEPOSITS     layaway and item holds — money taken before goods are given.
//   INSTALMENTS  an Ajo-style plan with a real schedule and real interest.
//
// THE RULE THAT RUNS THROUGH ALL FOUR: a reversal is an ENTRY, never an edit.
// A return writes a return row and a reversing journal entry; it does not reduce
// the original sale. If it did, the day's takings would silently change after
// the till was counted, the receipt the customer holds would stop matching the
// database, and there would be no record that anything was ever returned.
//
// DEPOSITS ARE A LIABILITY, NOT REVENUE. Money taken for goods not yet handed
// over sits in 2200 (deposits/layaway) until the sale completes. Recognising it
// as revenue on receipt would book a sale before it happened and overstate the
// month — then understate the next one when the goods actually leave.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, inScope, branchFilter, scopeFilter, pagination, listResponse, dateRange, numField, strField, boolField, valid } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday, addDays } = require('../../domain/time');
const { toBaseUnits, buildLadder } = require('../../domain/uom');
const { oneOf } = require('../../domain/validation');
const { validatePlan, buildSchedule, applyPayment, instalmentCount, planStatusFromSchedule, defaultTrigger } = require('../../domain/instalments');
const glService = require('../services/glService');
const salesService = require('../services/salesService');

// Exactly the vocabulary `sale_returns.reason_code` allows. A reason outside it
// is refused by the CHECK constraint at insert time, i.e. at the counter, with a
// customer standing there.
const RETURN_REASONS = ['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'CUSTOMER_CHANGE_OF_MIND', 'OVERCHARGE', 'RECALL', 'WARRANTY', 'OTHER'];
// The condition decides whether the item can go back on the shelf, so the
// vocabulary is the schema's: RESALABLE, DAMAGED, DEFECTIVE, MISSING_PARTS.
const RETURN_CONDITIONS = ['RESALABLE', 'DAMAGED', 'DEFECTIVE', 'MISSING_PARTS'];
// `deposits.deposit_type` allows LAYAWAY, PART_PAYMENT and RESERVATION. A hold
// is a RESERVATION; a pre-order is a PART_PAYMENT against goods not yet received.
const DEPOSIT_TYPES = ['LAYAWAY', 'PART_PAYMENT', 'RESERVATION'];
const FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY'];

function mount(app, base = '/api') {
  // ===================================================================
  // RETURNS
  // ===================================================================
  /**
   * Start a return against a sale.
   *
   * The window is enforced from `products.return_window_days` per line, not from
   * a global setting, because a mattress and a phone have different return
   * economics and the difference is a property of the product.
   */
  app.post(`${base}/returns`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();

    const saleId = String(requireVal(body, 'sale_id'));
    const sale = await db.first('SELECT s.*, b.name AS branch_name FROM sales s LEFT JOIN branches b ON b.id = s.branch_id WHERE s.id = ? AND s.is_deleted = 0', [saleId]);
    if (!sale) throw new HttpError('That sale does not exist.', { status: 404, code: 'SALE_NOT_FOUND' });
    if (sale.status === 'VOIDED') throw new HttpError('That sale is void — it never happened, so there is nothing to return against it.', { status: 409, code: 'SALE_VOID' });
    if (!inScope(ctx.get('scope'), sale)) throw new HttpError('That sale belongs to another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });

    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [sale.branch_id]);
    const business = await db.first('SELECT * FROM businesses WHERE id = ?', [sale.business_id]);
    const reasonCode = valid(oneOf(requireVal(body, 'reason_code'), RETURN_REASONS, { field: 'Reason' }), 'reason_code');
    const refundMethod = valid(oneOf(body.refund_method || 'ORIGINAL', ['ORIGINAL', 'CASH', 'BANK_TRANSFER', 'STORE_CREDIT', 'EXCHANGE'], { field: 'Refund method' }), 'refund_method');
    const restock = boolField(body.restock ?? true, true);

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) throw new HttpError('Say which items are being returned.', { status: 400, code: 'EMPTY_RETURN' });

    const today = watToday();
    const plan = [];
    let refundTotal = 0;
    for (const raw of rawItems) {
      const saleItemId = String(requireVal(raw, 'sale_item_id', 'Return line'));
      const item = await db.first(`SELECT si.*, p.name AS product_name, p.return_window_days, p.is_returnable, p.base_unit_name,
            p.requires_serial, p.warranty_months
          FROM sale_items si JOIN products p ON p.id = si.product_id
          WHERE si.id = ? AND si.sale_id = ? AND si.is_deleted = 0`, [saleItemId, saleId]);
      if (!item) throw new HttpError(`That line is not on sale ${sale.receipt_no}.`, { status: 404, code: 'SALE_ITEM_NOT_FOUND' });

      // Already returned? Counting a line twice is how a refund exceeds what was
      // paid, and the excess leaves as cash with no sale behind it.
      const alreadyReturned = round2(Number(await db.scalar(`SELECT COALESCE(SUM(sri.quantity_in_base),0) FROM sale_return_items sri
          JOIN sale_returns sr ON sr.id = sri.sale_return_id
          WHERE sri.sale_item_id = ? AND sri.is_deleted = 0 AND sr.is_deleted = 0 AND sr.status <> 'REJECTED'`, [saleItemId])));

      const units = await db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [item.product_id]);
      const ladder = buildLadder(units);
      const unitCode = String(raw.unit_code || item.unit_code || (ladder.ok ? ladder.base.code : 'PIECE')).toUpperCase();
      const qty = numField(requireVal(raw, 'quantity', 'Return line'), { field: 'Quantity', min: 0.0001, places: 4 });
      const conv = toBaseUnits({ quantity: qty, unitCode, ladder: ladder.ok ? ladder.ladder : [] });
      if (!conv.ok) throw new HttpError(`${item.product_name}: ${conv.error}`, { status: 400, code: conv.code });
      const qtyBase = round2(conv.baseQuantity);

      if (round2(alreadyReturned + qtyBase) > round2(Number(item.quantity_in_base))) {
        throw new HttpError(
          `${item.product_name}: you are returning ${qtyBase} ${item.base_unit_name} but only ${round2(Number(item.quantity_in_base) - alreadyReturned)} remain unreturned on this receipt${alreadyReturned > 0 ? ` (${alreadyReturned} already returned)` : ''}.`,
          { status: 400, code: 'OVER_RETURN', fields: { quantity: `Maximum ${round2(Number(item.quantity_in_base) - alreadyReturned)}` } },
        );
      }

      // The return window is a property of the PRODUCT.
      const windowDays = Number(item.return_window_days != null ? item.return_window_days : settings.return_window_days_default) || 0;
      const soldDay = String(sale.sold_at).slice(0, 10);
      const daysSince = Math.round((Date.parse(today) - Date.parse(soldDay)) / 86400000);
      const outsideWindow = windowDays > 0 && daysSince > windowDays;
      if (outsideWindow && !atLeast(user.role, 'MANAGER')) {
        throw new HttpError(
          `${item.product_name} has a ${windowDays}-day return window and this was sold ${daysSince} day(s) ago. A manager can still accept it if there is a good reason — record that reason.`,
          { status: 403, code: 'OUTSIDE_RETURN_WINDOW' },
        );
      }
      if (!Number(item.is_returnable) && !atLeast(user.role, 'MANAGER')) {
        throw new HttpError(`${item.product_name} is marked as non-returnable. A manager can override that with a reason.`, { status: 403, code: 'NOT_RETURNABLE' });
      }

      const condition = valid(oneOf(raw.condition || 'RESALABLE', RETURN_CONDITIONS, { field: 'Condition' }), 'condition');
      if (['DEFECTIVE', 'DAMAGED_IN_TRANSIT'].includes(reasonCode) && condition === 'RESALABLE' && !boolField(raw.confirm_defect)) {
        // A defective item that is still sealed is possible (a factory fault) but
        // unusual enough to be worth one confirmation, because it is also the
        // shape of a refund taken on an unopened item that was simply unwanted.
        ctx.set('defectQuery', `${item.product_name} is being returned as ${reasonCode.replace(/_/g, ' ').toLowerCase()} but its condition is recorded as RESALABLE. Confirm the fault is a manufacturing one rather than a change of mind.`);
      }

      // Refund is PRO-RATA on what was actually paid for the line, including its
      // share of any order-level discount and its VAT. Refunding the list price
      // would refund more than was taken when a discount was given.
      const lineRefund = raw.refund_amount != null
        ? numField(raw.refund_amount, { field: 'Refund amount', min: 0 })
        : round2((Number(item.line_total) / Number(item.quantity_in_base)) * qtyBase);
      if (lineRefund > Number(item.line_total)) {
        throw new HttpError(`${item.product_name}: a refund of ₦${lineRefund.toLocaleString('en-NG')} exceeds the ₦${Number(item.line_total).toLocaleString('en-NG')} that line was sold for.`, { status: 400, code: 'REFUND_EXCEEDS_LINE' });
      }
      refundTotal = round2(refundTotal + lineRefund);

      const serialNo = strField(raw.serial_no, { field: 'Serial number', maxLength: 80 });
      if (Number(item.requires_serial) && !serialNo) {
        throw new HttpError(`${item.product_name} is serial-tracked, so the returning unit's serial number is required. Without it the warranty stays attached to a unit that is back on the shelf and the one that goes out next has none.`, { status: 400, code: 'SERIAL_REQUIRED' });
      }

      plan.push({ item, qty, qtyBase, unitCode, condition, lineRefund, serialNo, outsideWindow, daysSince, windowDays });
    }

    if (refundTotal > Number(sale.amount_paid)) {
      throw new HttpError(
        `The refund totals ₦${refundTotal.toLocaleString('en-NG')} but only ₦${Number(sale.amount_paid).toLocaleString('en-NG')} was ever paid on this receipt${Number(sale.balance_due) > 0 ? ` (₦${Number(sale.balance_due).toLocaleString('en-NG')} is still outstanding — reduce that instead of refunding it)` : ''}.`,
        { status: 400, code: 'REFUND_EXCEEDS_PAYMENT' },
      );
    }

    const id = newId();
    const returnNo = `RTN-${String(branch.code || branch.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}-${sale.receipt_no}`.slice(0, 40);
    const dupe = await db.first('SELECT id FROM sale_returns WHERE return_no = ? AND is_deleted = 0', [returnNo]);
    const finalReturnNo = dupe ? `${returnNo}-${Date.now().toString(36).toUpperCase().slice(-3)}` : returnNo;
    // A manager's approval is needed for a refund to cash; store credit and an
    // exchange are lower risk and can be processed by staff.
    const needsApproval = refundMethod === 'CASH' || refundMethod === 'BANK_TRANSFER' || plan.some((p) => p.outsideWindow);
    const status = needsApproval && !atLeast(user.role, 'MANAGER') ? 'PENDING_APPROVAL' : 'APPROVED';
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const note = strField(body.notes, { field: 'Notes', maxLength: 500, required: plan.some((p) => p.outsideWindow) });

    // Resolve WHERE each returned unit goes back to, before the transaction. A
    // line whose original batch is gone (consumed, transferred, deleted) falls
    // back to the newest batch of that product at this branch — but that lookup
    // is a read, and the write phase may only queue statements.
    for (const p of plan) {
      if (!restock) { p.targetBatchId = null; continue; }
      if (p.item.batch_id) { p.targetBatchId = String(p.item.batch_id); continue; }
      const fallback = await db.first(`SELECT id FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0
          ORDER BY received_at DESC, batch_no DESC, id DESC LIMIT 1`, [String(p.item.product_id), String(branch.id)]);
      p.targetBatchId = fallback ? String(fallback.id) : null;
    }
    // The customer's balance is needed if the refund is store credit, and it must
    // be read before the transaction writes the ledger row that depends on it.
    const customerBalanceNow = sale.customer_id
      ? round2(Number((await db.first('SELECT credit_balance FROM customers WHERE id = ?', [String(sale.customer_id)]) || {}).credit_balance) || 0)
      : 0;

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO sale_returns (
          id, sale_id, branch_id, business_id, return_no, customer_id, reason_code, status, refund_method,
          refund_amount, restock, approved_by, approved_at, processed_by, processed_at, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
        id, saleId, String(branch.id), String(business.id), finalReturnNo,
        sale.customer_id, reasonCode, status, refundMethod, refundTotal, restock ? 1 : 0,
        status === 'APPROVED' ? String(user.id) : null, status === 'APPROVED' ? watNow() : null,
        status === 'APPROVED' ? String(user.id) : null, status === 'APPROVED' ? watNow() : null,
        note || (plan.some((p) => p.outsideWindow) ? `Accepted outside the return window by ${user.full_name || user.username}.` : null),
      ]);

      for (const p of plan) {
        tx.queue(`INSERT INTO sale_return_items (
            id, sale_return_id, sale_item_id, product_id, variant_id, quantity, quantity_in_base, unit_code,
            refund_amount, condition, serial_no, created_at, updated_at)
          -- Twelve placeholders for thirteen columns, not thirteen: created_at
          -- and updated_at both default to now, and an extra placeholder would
          -- have bound created_at to a value that was never supplied. This
          -- statement made every approved return fail with 'the statement has
          -- 12 placeholder(s) but received 11 value(s)' - a flow nobody had run.
          VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
          newId(), id, String(p.item.id), String(p.item.product_id), p.item.variant_id,
          p.qty, p.qtyBase, p.unitCode, p.lineRefund, p.condition, p.serialNo,
        ]);

        // Only RESALABLE goods go back on the shelf. Restocking a DEFECTIVE unit
        // would put a broken item back into FIFO where the next customer buys it.
        if (restock && status === 'APPROVED' && p.targetBatchId && p.condition === 'RESALABLE') {
          // Stock returns to the ORIGINAL BATCH at its ORIGINAL COST. Putting it
          // into a new batch at today's cost would corrupt the weighted average
          // and misstate the margin on the next sale of that product.
          tx.queue(`UPDATE stock_batches SET quantity = quantity + ?,
              status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END,
              updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [p.qtyBase, p.targetBatchId]);
          tx.queue('UPDATE sale_return_items SET restocked_batch_id = ? WHERE sale_return_id = ? AND sale_item_id = ?',
            [p.targetBatchId, id, String(p.item.id)]);
        }

        // A returned serial goes back to IN_STOCK and its warranty clock stops
        // being a live claim against this customer.
        if (p.serialNo) {
          tx.queue(`UPDATE serial_numbers SET status = ?, sale_id = NULL, customer_id = NULL,
              notes = COALESCE(notes,'') || ?, updated_at = datetime('now')
            WHERE UPPER(serial_no) = UPPER(?) AND is_deleted = 0`, [
            restock ? 'IN_STOCK' : 'QUARANTINED',
            `\n| Returned ${watNow()} on ${finalReturnNo} (${reasonCode}, condition ${p.condition})`,
            p.serialNo,
          ]);
        }
      }

      if (status === 'APPROVED') {
        // Reverse the sale in the ledger. This uses the SAME reversing statements
        // the sale engine would produce, so the accounts affected are identical —
        // a hand-written reversal here would drift from the posting rules.
        const items = plan.map((p) => ({
          product_id: p.item.product_id, variant_id: p.item.variant_id, batch_id: p.item.batch_id,
          quantity: p.qty, quantity_in_base: p.qtyBase, unit_price: Number(p.item.unit_price),
          line_total: p.lineRefund, vat_amount: round2(Number(p.item.vat_amount) * (p.qtyBase / Number(p.item.quantity_in_base))),
          cost_price_snapshot: Number(p.item.cost_price_snapshot), margin: round2(Number(p.item.margin) * (p.qtyBase / Number(p.item.quantity_in_base))),
        }));
        for (const st of glService.reverseSaleStatements({
          sale: { id, receipt_no: finalReturnNo, branch_id: branch.id, business_id: business.id },
          items, business, branch, user, reason: `Return ${finalReturnNo}: ${reasonCode}`,
          accountIds, sourceType: 'SALE_RETURN',
        })) tx.queue(st.sql, st.params);

        // PARTIALLY_REFUNDED or REFUNDED — `sales.status` has no RETURNED, and
        // the distinction matters: a part return leaves the rest of the sale
        // standing, a full one does not.
        tx.queue(`UPDATE sales SET status = ?, notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?`, [
          refundTotal >= Number(sale.total) ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          `\n| Return ${finalReturnNo} processed ${watNow()}: ₦${refundTotal.toLocaleString('en-NG')} refunded (${reasonCode})`,
          saleId,
        ]);

        // The till the refund came out of has to show it, or the drawer will be
        // over by the refund amount at the count and the cashier gets blamed.
        if (refundMethod === 'CASH' && sale.till_session_id) {
          tx.queue(`UPDATE till_sessions SET refund_total = COALESCE(refund_total,0) + ?,
              cash_sales_total = cash_sales_total - ?, updated_at = datetime('now')
            WHERE id = ? AND status = 'OPEN'`, [refundTotal, refundTotal, String(sale.till_session_id)]);
        }
        if (refundMethod === 'STORE_CREDIT' && sale.customer_id) {
          const bal = customerBalanceNow;
          tx.queue(`INSERT INTO debtor_ledger (
              id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
            VALUES (?,?,?,?, 'ADJUSTMENT', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
            newId(), String(branch.id), String(business.id), String(sale.customer_id), id,
            -refundTotal, round2(bal - refundTotal),
            `Store credit issued on return ${finalReturnNo}`, String(user.id),
          ]);
          tx.queue("UPDATE customers SET credit_balance = credit_balance - ?, updated_at = datetime('now') WHERE id = ?", [refundTotal, String(sale.customer_id)]);
        }
      }
    });

    await recordFromCtx(ctx, {
      action: 'RETURN_CREATED', entityType: 'SALE_RETURN', entityId: id, branchId: branch.id, businessId: business.id,
      before: { saleReceipt: sale.receipt_no, saleTotal: Number(sale.total) },
      after: { returnNo: finalReturnNo, reasonCode, refundMethod, refundTotal, restock, status, lines: plan.length },
    });

    ctx.json({
      ok: true, id, returnNo: finalReturnNo, status, refundTotal, restock,
      message: status === 'APPROVED'
        ? `Return ${finalReturnNo} processed: ₦${refundTotal.toLocaleString('en-NG')} refunded by ${refundMethod.replace(/_/g, ' ').toLowerCase()}${restock ? ' and the goods are back on the shelf' : ' — the goods were NOT restocked'}.`
        : `Return ${finalReturnNo} recorded for ₦${refundTotal.toLocaleString('en-NG')} and queued for a manager's approval.${needsApproval ? ' Cash and transfer refunds, and anything outside the return window, need one.' : ''}`,
      needsApproval,
      advisories: [ctx.get('defectQuery'), ...plan.filter((p) => p.outsideWindow).map((p) => `${p.item.product_name} returned ${p.daysSince} days after sale, outside its ${p.windowDays}-day window.`)].filter(Boolean),
    }, 201);
  });

  /** Approve a pending return. */
  app.post(`${base}/returns/:id/approve`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can approve a return.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const ret = await db.first('SELECT * FROM sale_returns WHERE id = ? AND is_deleted = 0', [id]);
    if (!ret) throw new HttpError('That return does not exist.', { status: 404, code: 'RETURN_NOT_FOUND' });
    if (ret.status !== 'PENDING_APPROVAL') throw new HttpError(`That return is already ${ret.status.toLowerCase()}.`, { status: 409, code: 'NOT_PENDING' });
    const approved = boolField(body.approved ?? true, true);
    const note = strField(body.note || body.notes, { field: 'Note', maxLength: 500, required: !approved });
    if (!approved && (!note || note.length < 6)) {
      throw new HttpError('Say why the return was refused. The customer is entitled to a reason they can act on.', { status: 400, code: 'REASON_REQUIRED' });
    }
    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [ret.branch_id]);
    const business = await db.first('SELECT * FROM businesses WHERE id = ?', [ret.business_id]);
    const sale = await db.first('SELECT * FROM sales WHERE id = ?', [ret.sale_id]);
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const items = await db.all(`SELECT sri.*, si.batch_id, si.unit_price, si.cost_price_snapshot, si.vat_amount, si.margin, si.quantity_in_base AS sold_base
        FROM sale_return_items sri JOIN sale_items si ON si.id = sri.sale_item_id
        WHERE sri.sale_return_id = ? AND sri.is_deleted = 0`, [id]);

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE sale_returns SET status = ?, approved_by = ?, approved_at = datetime('now'),
          ${approved ? "processed_by = ?, processed_at = datetime('now')," : ''} notes = COALESCE(notes,'') || ?, updated_at = datetime('now')
        WHERE id = ? AND is_deleted = 0`, [
        approved ? 'APPROVED' : 'REJECTED', String(user.id),
        ...(approved ? [String(user.id)] : []),
        `\n| ${approved ? 'Approved' : 'Rejected'} by ${user.full_name || user.username} at ${watNow()}${note ? `: ${note}` : ''}`,
        id,
      ]);
      if (approved) {
        for (const it of items) {
          if (Number(ret.restock) && it.batch_id && it.condition === 'RESALABLE') {
            tx.queue(`UPDATE stock_batches SET quantity = quantity + ?,
                status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END, updated_at = datetime('now')
              WHERE id = ? AND is_deleted = 0`, [Number(it.quantity_in_base), String(it.batch_id)]);
            tx.queue('UPDATE sale_return_items SET restocked_batch_id = ? WHERE id = ?', [String(it.batch_id), String(it.id)]);
          }
          if (it.serial_no) {
            tx.queue(`UPDATE serial_numbers SET status = ?, sale_id = NULL, customer_id = NULL, updated_at = datetime('now')
              WHERE UPPER(serial_no) = UPPER(?) AND is_deleted = 0`, [Number(ret.restock) ? 'IN_STOCK' : 'QUARANTINED', it.serial_no]);
          }
        }
        for (const st of glService.reverseSaleStatements({
          sale: { id, receipt_no: ret.return_no, branch_id: ret.branch_id, business_id: ret.business_id },
          items: items.map((i) => ({
            product_id: i.product_id, variant_id: i.variant_id, batch_id: i.batch_id,
            quantity: Number(i.quantity), quantity_in_base: Number(i.quantity_in_base),
            unit_price: Number(i.unit_price), line_total: Number(i.refund_amount),
            vat_amount: round2(Number(i.vat_amount) * (Number(i.quantity_in_base) / Number(i.sold_base || 1))),
            cost_price_snapshot: Number(i.cost_price_snapshot),
            margin: round2(Number(i.margin) * (Number(i.quantity_in_base) / Number(i.sold_base || 1))),
          })),
          business, branch, user, reason: `Return ${ret.return_no} approved: ${ret.reason_code}`,
          accountIds, sourceType: 'SALE_RETURN',
        })) tx.queue(st.sql, st.params);
        tx.queue("UPDATE sales SET status = 'REFUNDED', updated_at = datetime('now') WHERE id = ? AND status NOT IN ('VOIDED','PARTIALLY_REFUNDED')", [String(ret.sale_id)]);
      }
    });
    await recordFromCtx(ctx, {
      action: approved ? 'RETURN_APPROVED' : 'RETURN_REJECTED', entityType: 'SALE_RETURN', entityId: id,
      branchId: ret.branch_id, businessId: ret.business_id,
      before: { status: ret.status }, after: { approved, note, refund: Number(ret.refund_amount) },
    });
    ctx.json({ ok: true, message: approved ? `Return ${ret.return_no} approved — ₦${Number(ret.refund_amount).toLocaleString('en-NG')} refunded and the ledger reversed.` : `Return ${ret.return_no} rejected: ${note}` });
  });

  app.get(`${base}/returns`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const where = ['r.is_deleted = 0', "date(r.created_at, '+1 hours') BETWEEN ? AND ?"];
    const params = [from, to];
    const f = scopeFilter(scope, { alias: 'r' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    // A BRANCH THE CALLER NAMED NARROWS THIS LIST — see branchFilter() in lib/respond.
    const bf = await branchFilter(db, ctx, { alias: 'r' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }
    const status = ctx.req.queryParam('status');
    if (status) { where.push('r.status = ?'); params.push(String(status).toUpperCase()); }
    const whereSql = where.join(' AND ');
    const rows = await db.all(`SELECT r.*, s.receipt_no, b.name AS branch_name, u.full_name AS processed_by_name,
          (SELECT COUNT(*) FROM sale_return_items i WHERE i.sale_return_id = r.id AND i.is_deleted = 0) AS item_count
        FROM sale_returns r
        LEFT JOIN sales s ON s.id = r.sale_id
        LEFT JOIN branches b ON b.id = r.branch_id
        LEFT JOIN users u ON u.id = r.processed_by
        WHERE ${whereSql} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM sale_returns r WHERE ${whereSql}`, params);
    const summary = await db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(r.refund_amount),0) AS refunded,
          COALESCE(SUM(CASE WHEN r.status = 'PENDING_APPROVAL' THEN 1 ELSE 0 END),0) AS pending
        FROM sale_returns r WHERE ${whereSql}`, params);
    const byReason = await db.all(`SELECT r.reason_code, COUNT(*) AS count, COALESCE(SUM(r.refund_amount),0) AS refunded
        FROM sale_returns r WHERE ${whereSql} GROUP BY r.reason_code ORDER BY refunded DESC`, params);
    ctx.json({
      ...listResponse(rows, { limit, offset }, total),
      range: { from, to }, byReason,
      summary: { count: Number(summary.count) || 0, refunded: round2(Number(summary.refunded)), pending: Number(summary.pending) || 0 },
    });
  });

  // ===================================================================
  // WARRANTY CLAIMS
  // ===================================================================
  /**
   * Open a warranty claim.
   *
   * IN-WARRANTY IS DETERMINED FROM THE SERIAL'S OWN DATES, and for an installed
   * appliance those dates start at COMMISSIONING rather than at sale. Claiming
   * against the sale date would deny cover for the weeks the unit spent in a
   * warehouse, which is the single most common reason a legitimate claim is
   * refused and the customer walks.
   */
  app.post(`${base}/warranty-claims`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const serialNo = strField(body.serial_no, { field: 'Serial number', maxLength: 80 });
    const serialId = body.serial_id ? String(body.serial_id) : null;
    let serial = null;
    if (serialNo) {
      serial = await db.first(`SELECT sn.*, p.name AS product_name, p.warranty_months, p.sku, s.id AS sale_id, s.receipt_no,
            s.sold_at, s.customer_id, si.id AS sale_item_id
          FROM serial_numbers sn
          JOIN products p ON p.id = sn.product_id
          LEFT JOIN sales s ON s.id = sn.sale_id
          LEFT JOIN sale_items si ON si.sale_id = s.id AND si.product_id = sn.product_id AND si.is_deleted = 0
          WHERE UPPER(sn.serial_no) = UPPER(?) AND sn.is_deleted = 0
          ORDER BY sn.created_at DESC LIMIT 1`, [serialNo]);
    } else if (serialId) {
      serial = await db.first('SELECT * FROM serial_numbers WHERE id = ? AND is_deleted = 0', [serialId]);
    }
    if (!serial) {
      throw new HttpError(
        serialNo
          ? `No record of serial ${serialNo.toUpperCase()} in this system. It was not sold from here — check the number, or treat this as an out-of-warranty repair and say so on the claim.`
          : 'Enter the serial number, or pick the unit from the sale.',
        { status: 404, code: 'SERIAL_NOT_FOUND' },
      );
    }

    const today = watToday();
    const warrantyEnds = serial.warranty_ends_at ? String(serial.warranty_ends_at).slice(0, 10) : null;
    const inWarranty = Boolean(warrantyEnds) && warrantyEnds >= today;
    // Where the serial has no end date but the product promises a warranty and
    // there is a sale to measure from, derive it rather than refusing the claim.
    // A missing date is a data problem, not a reason to turn a customer away.
    let derivedEnds = warrantyEnds;
    if (!warrantyEnds && serial.sale_id && serial.warranty_months) {
      derivedEnds = addDays(String(serial.sold_at).slice(0, 10), Number(serial.warranty_months) * 30);
      ctx.set('derivedWarranty', `No warranty end date is stored for this unit. Derived ${derivedEnds} from the sale date plus ${serial.warranty_months} month(s) — correct the serial record so the next claim does not have to guess.`);
    }
    const effectiveEnds = warrantyEnds || derivedEnds;
    const effectivelyInWarranty = Boolean(effectiveEnds) && effectiveEnds >= today;

    const faultReported = strField(requireVal(body, 'fault_reported'), { field: 'Fault reported', maxLength: 1000, required: true });
    if (faultReported.length < 8) {
      throw new HttpError('Describe the fault in the customer\'s own words, in at least a sentence. "Not working" cannot be assessed by a supplier, and a claim sent to a manufacturer with no fault description is rejected on sight.', { status: 400, code: 'FAULT_DESCRIPTION_REQUIRED' });
    }

    const id = newId();
    const claimNo = `WC-${Date.now().toString(36).toUpperCase().slice(-6)}-${String(serial.serial_no).slice(-4)}`;
    const customerId = body.customer_id ? String(body.customer_id) : (serial.customer_id || null);
    const supplierId = body.supplier_id ? String(body.supplier_id) : null;

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO warranty_claims (
          id, claim_no, business_id, branch_id, sale_id, sale_item_id, serial_id, product_id, variant_id,
          customer_id, status, fault_reported, in_warranty, warranty_ends_at, supplier_id, opened_by, opened_at,
          notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'OPEN', ?,?,?,?,?, datetime('now'), ?, datetime('now'), datetime('now'))`, [
        id, claimNo, String(business.id), String(branch.id),
        serial.sale_id || null, serial.sale_item_id || null, String(serial.id), String(serial.product_id),
        serial.variant_id || null, customerId,
        faultReported, effectivelyInWarranty ? 1 : 0, effectiveEnds, supplierId, String(user.id),
        [strField(body.notes, { field: 'Notes', maxLength: 500 }), ctx.get('derivedWarranty')].filter(Boolean).join('\n') || null,
      ]);
      tx.queue("UPDATE serial_numbers SET notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?",
        [`\n| Warranty claim ${claimNo} opened ${watNow()}: ${faultReported.slice(0, 120)}`, String(serial.id)]);
    });

    await recordFromCtx(ctx, {
      action: 'WARRANTY_CLAIM_OPENED', entityType: 'WARRANTY_CLAIM', entityId: id, branchId: branch.id, businessId: business.id,
      after: { claimNo, serialNo: serial.serial_no, product: serial.product_name, inWarranty: effectivelyInWarranty, warrantyEnds: effectiveEnds },
    });
    ctx.json({
      ok: true, id, claimNo,
      inWarranty: effectivelyInWarranty, warrantyEnds: effectiveEnds,
      message: effectivelyInWarranty
        ? `Claim ${claimNo} opened for ${serial.product_name} (serial ${serial.serial_no}). It IS in warranty until ${effectiveEnds} — cover applies.`
        : `Claim ${claimNo} opened for ${serial.product_name} (serial ${serial.serial_no}). It is OUT of warranty${effectiveEnds ? ` — cover ended ${effectiveEnds}` : ' and no warranty end date is on record'}. It can still be repaired as a paid job; say so to the customer before any work starts.`,
      advisories: [ctx.get('derivedWarranty')].filter(Boolean),
    }, 201);
  });

  /**
   * Resolve a claim.
   *
   * The cost to the business and any recovery from the supplier are recorded
   * separately, because the difference is the margin on warranty work. A repair
   * that costs ₦40,000 and recovers ₦40,000 from the manufacturer is a service;
   * one that recovers nothing is a loss, and only recording the two separately
   * shows which happened.
   */
  app.post(`${base}/warranty-claims/:id/resolve`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can resolve a warranty claim.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const claim = await db.first('SELECT * FROM warranty_claims WHERE id = ? AND is_deleted = 0', [id]);
    if (!claim) throw new HttpError('That claim does not exist.', { status: 404, code: 'CLAIM_NOT_FOUND' });
    if (['CLOSED', 'REJECTED'].includes(claim.status)) throw new HttpError(`That claim is already ${claim.status.toLowerCase()}.`, { status: 409, code: 'ALREADY_RESOLVED' });

    const resolution = valid(oneOf(requireVal(body, 'resolution'), ['REPAIRED', 'REPLACED', 'REFUNDED', 'REJECTED', 'SUPPLIER_RETURN', 'PAID_REPAIR'], { field: 'Resolution' }), 'resolution');
    const faultFound = strField(body.fault_found, { field: 'Fault found', maxLength: 1000, required: resolution !== 'REJECTED' });
    const notes = strField(body.resolution_notes || body.notes, { field: 'Resolution notes', maxLength: 1000, required: resolution === 'REJECTED' });
    if (resolution === 'REJECTED' && (!notes || notes.length < 10)) {
      throw new HttpError('A rejected claim needs a written explanation the customer can be given. "Rejected" alone will be disputed, and without a reason there is nothing to dispute against.', { status: 400, code: 'REJECTION_REASON_REQUIRED' });
    }

    const costToBusiness = numField(body.cost_to_business, { field: 'Cost to business', min: 0 });
    const supplierRecovery = numField(body.supplier_recovery_amount, { field: 'Supplier recovery', min: 0 });
    if (supplierRecovery > costToBusiness && costToBusiness > 0) {
      throw new HttpError(`A recovery of ₦${supplierRecovery.toLocaleString('en-NG')} exceeds the ₦${costToBusiness.toLocaleString('en-NG')} this cost the business. A supplier does not pay more than the claim is worth — check one of the two.`, { status: 400, code: 'RECOVERY_EXCEEDS_COST' });
    }
    const supplierClaimRef = strField(body.supplier_claim_ref, { field: 'Supplier claim reference', maxLength: 80 });
    if (supplierRecovery > 0 && !supplierClaimRef) {
      throw new HttpError('Record the supplier\'s claim reference. A recovery with no reference cannot be chased when the credit note does not arrive — and it usually does not arrive unless it is chased.', { status: 400, code: 'SUPPLIER_REF_REQUIRED' });
    }

    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [claim.branch_id]);
    const business = await db.first('SELECT * FROM businesses WHERE id = ?', [claim.business_id]);
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const replacementSerialId = body.replacement_serial_id ? String(body.replacement_serial_id) : null;
    // Read before the transaction: the REFUNDED branch annotates the original
    // sale, and an `await` inside the write phase cannot run.
    const relatedSale = (resolution === 'REFUNDED' && claim.sale_id)
      ? await db.first('SELECT id FROM sales WHERE id = ? AND is_deleted = 0', [String(claim.sale_id)])
      : null;
    if (resolution === 'REPLACED' && !replacementSerialId) {
      ctx.set('replacementWarning', 'A replacement was issued but no replacement serial was recorded. The new unit will have no warranty history and the old one will still show as sold.');
    }

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE warranty_claims SET status = 'CLOSED', fault_found = ?, resolution = ?, resolution_notes = ?,
          cost_to_business = ?, supplier_claim_ref = ?, supplier_recovery_amount = ?, replacement_serial_id = ?,
          resolved_by = ?, resolved_at = datetime('now'), closed_at = datetime('now'),
          notes = COALESCE(notes,'') || ?, updated_at = datetime('now')
        WHERE id = ? AND is_deleted = 0`, [
        faultFound, resolution, notes, costToBusiness, supplierClaimRef, supplierRecovery, replacementSerialId,
        String(user.id),
        `\n| Resolved ${watNow()} by ${user.full_name || user.username}: ${resolution}. Fault found: ${faultFound || 'not stated'}. Cost ₦${costToBusiness.toLocaleString('en-NG')}, recovered ₦${supplierRecovery.toLocaleString('en-NG')}.`,
        id,
      ]);

      if (resolution === 'REJECTED' && claim.serial_id) {
        tx.queue("UPDATE serial_numbers SET notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?",
          [`\n| Claim ${claim.claim_no} REJECTED ${watNow()}: ${notes}`, String(claim.serial_id)]);
      }
      if (resolution === 'REPLACED' && claim.serial_id) {
        // The returned unit leaves circulation; the replacement inherits the
        // remaining cover rather than starting a new one, which is what the
        // customer was promised when they bought the original.
        tx.queue(`UPDATE serial_numbers SET status = 'TRANSFERRED', notes = COALESCE(notes,'') || ?,
            updated_at = datetime('now') WHERE id = ?`,
        [`\n| Replaced under claim ${claim.claim_no} ${watNow()}`, String(claim.serial_id)]);
        if (replacementSerialId) {
          tx.queue(`UPDATE serial_numbers SET warranty_starts_at = COALESCE(warranty_starts_at, ?),
              warranty_ends_at = COALESCE(?, warranty_ends_at), sale_id = COALESCE(sale_id, ?),
              customer_id = COALESCE(customer_id, ?), status = 'SOLD',
              notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?`, [
            claim.opened_at ? String(claim.opened_at).slice(0, 10) : watToday(),
            claim.warranty_ends_at, claim.sale_id, claim.customer_id,
            `\n| Issued ${watNow()} as a warranty replacement for claim ${claim.claim_no}; inherits the original cover.`,
            replacementSerialId,
          ]);
        }
      }

      if (costToBusiness > 0 || supplierRecovery > 0) {
        for (const st of glService.postWarrantyStatements({
          claim: { id, claim_no: claim.claim_no, resolution },
          businessId: String(business.id), branchId: String(branch.id),
          costToBusiness, supplierRecovery, accountIds, user,
        })) tx.queue(st.sql, st.params);
      }
      if (relatedSale) {
        tx.queue("UPDATE sales SET notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0",
          [`\n| Refunded under warranty claim ${claim.claim_no} ${watNow()}: ₦${costToBusiness.toLocaleString('en-NG')}`, String(claim.sale_id)]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'WARRANTY_CLAIM_RESOLVED', entityType: 'WARRANTY_CLAIM', entityId: id, branchId: claim.branch_id, businessId: claim.business_id,
      before: { status: claim.status },
      after: { resolution, costToBusiness, supplierRecovery, supplierClaimRef, replacementSerialId, netCost: round2(costToBusiness - supplierRecovery) },
    });
    ctx.json({
      ok: true,
      message: `Claim ${claim.claim_no} closed as ${resolution.replace(/_/g, ' ').toLowerCase()}.`,
      costToBusiness, supplierRecovery,
      netCost: round2(costToBusiness - supplierRecovery),
      advisories: [ctx.get('replacementWarning'), supplierRecovery > 0 ? `₦${supplierRecovery.toLocaleString('en-NG')} is expected back from the supplier (ref ${supplierClaimRef}). Chase it — supplier credit notes rarely arrive unasked.` : null].filter(Boolean),
    });
  });

  app.get(`${base}/warranty-claims`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const where = ['w.is_deleted = 0']; const params = [];
    const f = scopeFilter(scope, { alias: 'w' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    // A BRANCH THE CALLER NAMED NARROWS THIS LIST — see branchFilter() in lib/respond.
    const bf = await branchFilter(db, ctx, { alias: 'w' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }
    const status = ctx.req.queryParam('status');
    if (status) { where.push('w.status = ?'); params.push(String(status).toUpperCase()); }
    else where.push("w.status <> 'CLOSED'");
    if (boolField(ctx.req.queryParam('in_warranty'))) where.push('w.in_warranty = 1');
    const search = (ctx.req.queryParam('q') || '').trim();
    if (search) {
      where.push('(w.claim_no LIKE ? OR sn.serial_no LIKE ? OR p.name LIKE ? OR c.name LIKE ?)');
      const l = `%${search}%`; params.push(l, l, l, l);
    }
    const whereSql = where.join(' AND ');
    const rows = await db.all(`SELECT w.*, p.name AS product_name, p.sku, sn.serial_no, c.name AS customer_name,
          c.phone AS customer_phone, s.receipt_no, b.name AS branch_name, sup.name AS supplier_name,
          u.full_name AS opened_by_name
        FROM warranty_claims w
        LEFT JOIN products p ON p.id = w.product_id
        LEFT JOIN serial_numbers sn ON sn.id = w.serial_id
        LEFT JOIN customers c ON c.id = w.customer_id
        LEFT JOIN sales s ON s.id = w.sale_id
        LEFT JOIN branches b ON b.id = w.branch_id
        LEFT JOIN suppliers sup ON sup.id = w.supplier_id
        LEFT JOIN users u ON u.id = w.opened_by
        WHERE ${whereSql} ORDER BY w.opened_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM warranty_claims w
        LEFT JOIN serial_numbers sn ON sn.id = w.serial_id
        LEFT JOIN products p ON p.id = w.product_id
        LEFT JOIN customers c ON c.id = w.customer_id
        WHERE ${whereSql}`, params);
    ctx.json({ ...listResponse(rows, { limit, offset }, total) });
  });

  // ===================================================================
  // DEPOSITS / LAYAWAY / HOLDS
  // ===================================================================
  /**
   * Take a deposit on an item — layaway, a hold, or a pre-order.
   *
   * The stock is RESERVED, not sold: `quantity_reserved` goes up so the unit
   * cannot be rung up by anybody else, while `quantity` stays put because the
   * goods are still physically on the shelf and still an asset of the business.
   * The money sits in 2200 as a LIABILITY until the sale completes. Recognising
   * it as revenue on receipt would book a sale before the customer has the goods.
   */
  app.post(`${base}/deposits`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();
    assertFeature(settings, 'delivery_module_enabled', null); // deposits are always allowed
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const productId = String(requireVal(body, 'product_id'));
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [productId]);
    if (!product) throw new HttpError('That product does not exist.', { status: 404, code: 'PRODUCT_NOT_FOUND' });
    const customerId = body.customer_id ? String(body.customer_id) : null;
    const customer = customerId ? await db.first('SELECT * FROM customers WHERE id = ? AND is_deleted = 0', [customerId]) : null;
    if (customerId && !customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });
    // A layaway is a promise to a NAMED person. Without one there is nobody to
    // hand the goods to and nobody to forfeit the deposit against.
    if (!customer) {
      throw new HttpError('A deposit needs a customer. The goods are being held for somebody specific, and the deposit is only meaningful if the system knows who.', { status: 400, code: 'CUSTOMER_REQUIRED' });
    }

    const depositType = valid(oneOf(body.deposit_type || 'LAYAWAY', DEPOSIT_TYPES, { field: 'Deposit type' }), 'deposit_type');
    const units = await db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [productId]);
    const ladder = buildLadder(units);
    if (!ladder.ok) throw new HttpError(`${product.name}: ${ladder.error}`, { status: 400, code: ladder.code });
    const unitCode = String(body.unit_code || ladder.defaultSell.code).toUpperCase();
    const qty = numField(requireVal(body, 'quantity'), { field: 'Quantity', min: 0.0001, places: 4 });
    const conv = toBaseUnits({ quantity: qty, unitCode, ladder: ladder.ladder });
    if (!conv.ok) throw new HttpError(`${product.name}: ${conv.error}`, { status: 400, code: conv.code });
    const qtyBase = round2(conv.baseQuantity);

    const unitPrice = numField(body.unit_price ?? product.selling_price, { field: 'Unit price', min: 0 });
    const totalPrice = round2(qty * unitPrice);
    const depositAmount = numField(requireVal(body, 'deposit_amount'), { field: 'Deposit', min: 0.01 });
    if (depositAmount > totalPrice) {
      throw new HttpError(`A deposit of ₦${depositAmount.toLocaleString('en-NG')} exceeds the ₦${totalPrice.toLocaleString('en-NG')} price of the goods. Take the difference as a normal sale, or correct the deposit.`, { status: 400, code: 'DEPOSIT_EXCEEDS_PRICE' });
    }
    const minPct = Number(settings.layaway_min_deposit_pct) || 0;
    if (depositType === 'LAYAWAY' && minPct > 0 && totalPrice > 0 && (depositAmount / totalPrice) * 100 < minPct) {
      throw new HttpError(`This business requires at least ${minPct}% down on a layaway, which is ₦${round2(totalPrice * minPct / 100).toLocaleString('en-NG')} on a ₦${totalPrice.toLocaleString('en-NG')} item. A token deposit holds stock indefinitely and stops somebody else buying it.`, { status: 400, code: 'DEPOSIT_BELOW_MINIMUM' });
    }
    const maxDays = Number(settings.layaway_max_days) || 90;
    const days = numField(body.days ?? maxDays, { field: 'Days to complete', min: 1, max: 365, whole: true });
    if (depositType === 'LAYAWAY' && days > maxDays) {
      throw new HttpError(`A layaway may run at most ${maxDays} days here; ${days} was requested. Stock held indefinitely is stock nobody else can buy.`, { status: 400, code: 'LAYAWAY_TOO_LONG' });
    }

    // Reserve against a specific batch so the unit actually exists and is not
    // already promised to somebody else.
    const batch = body.batch_id
      ? await db.first('SELECT * FROM stock_batches WHERE id = ? AND product_id = ? AND branch_id = ? AND is_deleted = 0', [String(body.batch_id), productId, String(branch.id)])
      : await db.first(`SELECT * FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0
            AND status = 'ACTIVE' AND quantity - quantity_reserved >= ?
          ORDER BY expiry_date IS NULL, expiry_date, received_at, batch_no, id LIMIT 1`, [productId, String(branch.id), qtyBase]);
    if (!batch) {
      throw new HttpError(`There is no unreserved stock of ${product.name} at ${branch.name} to hold ${qtyBase} ${product.base_unit_name}. A hold on stock that is not there is a promise the shop cannot keep.`, { status: 409, code: 'INSUFFICIENT_STOCK' });
    }

    const serialId = body.serial_id ? String(body.serial_id) : null;
    if (serialId) {
      const sn = await db.first('SELECT * FROM serial_numbers WHERE id = ? AND is_deleted = 0', [serialId]);
      if (!sn) throw new HttpError('That serial number does not exist.', { status: 404, code: 'SERIAL_NOT_FOUND' });
      if (String(sn.product_id) !== productId) throw new HttpError(`Serial ${sn.serial_no} is a different product.`, { status: 400, code: 'SERIAL_PRODUCT_MISMATCH' });
      if (sn.status === 'SOLD') throw new HttpError(`Serial ${sn.serial_no} is already sold.`, { status: 409, code: 'SERIAL_SOLD' });
    }

    const method = valid(oneOf(body.method || 'CASH', ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'USSD', 'CHEQUE'], { field: 'Payment method' }), 'method');
    const reference = strField(body.reference, { field: 'Reference', maxLength: 80 });
    const id = newId();
    const expiresAt = addDays(watToday(), days);
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const till = await db.first("SELECT * FROM till_sessions WHERE branch_id = ? AND user_id = ? AND status = 'OPEN' AND is_deleted = 0 ORDER BY opened_at DESC LIMIT 1",
      [String(branch.id), String(user.id)]);

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO deposits (
          id, branch_id, business_id, customer_id, product_id, variant_id, batch_id, serial_id, deposit_type,
          quantity, unit_code, quantity_in_base, unit_price, total_price, deposit_amount, balance_due,
          expires_at, status, created_by, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?, ?, datetime('now'), datetime('now'))`, [
        id, String(branch.id), String(business.id), String(customer.id), productId,
        body.variant_id ? String(body.variant_id) : null, String(batch.id), serialId, depositType,
        qty, unitCode, qtyBase, unitPrice, totalPrice, depositAmount, round2(totalPrice - depositAmount),
        expiresAt, String(user.id),
        strField(body.notes, { field: 'Notes', maxLength: 500 }),
      ]);
      tx.queue(`INSERT INTO deposit_payments (
          id, deposit_id, branch_id, amount, method, reference, received_by, received_at, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?, datetime('now'), ?, datetime('now'), datetime('now'))`, [
        newId(), id, String(branch.id), depositAmount, method, reference, String(user.id),
        `Initial ${depositType.toLowerCase()} deposit`,
      ]);
      // RESERVE, do not decrement. The goods are still on the shelf and still an
      // asset; they are simply no longer available to sell to anybody else.
      tx.queue(`UPDATE stock_batches SET quantity_reserved = quantity_reserved + ?, updated_at = datetime('now')
          WHERE id = ? AND is_deleted = 0 AND quantity - quantity_reserved >= ?`, [qtyBase, String(batch.id), qtyBase]);
      if (serialId) tx.queue("UPDATE serial_numbers SET status = 'RESERVED', notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?", [`\n| Reserved on ${depositType.toLowerCase()} ${watNow()} for ${customer.name}`, serialId]);

      // DR cash / bank, CR 2200 deposits held. NOT revenue.
      const assetAccount = { CASH: '1000', BANK_TRANSFER: '1020', POS_TERMINAL: '1030', MOBILE_MONEY: '1040', USSD: '1040', CHEQUE: '1020' }[method] || '1000';
      for (const st of glService.buildEntry({
        businessId: String(business.id), branchId: String(branch.id), // A layaway deposit is a sale in progress, so it posts under SALE — the schema
        // allows no DEPOSIT source type.
        sourceType: 'SALE', sourceId: id,
        description: `${depositType} deposit from ${customer.name} on ${product.name}`, postedBy: String(user.id), accountIds,
        lines: [
          { accountCode: assetAccount, debit: depositAmount, description: 'Deposit received' },
          { accountCode: '2200', credit: depositAmount, description: 'Held for the customer — not revenue until the goods are collected' },
        ],
      })) tx.queue(st.sql, st.params);

      if (till) {
        const col = { CASH: 'cash_sales_total', POS_TERMINAL: 'pos_total', BANK_TRANSFER: 'transfer_total', MOBILE_MONEY: 'mobile_money_total', USSD: 'mobile_money_total', CHEQUE: 'cheque_total' }[method];
        if (col) tx.queue(`UPDATE till_sessions SET ${col} = COALESCE(${col},0) + ?, grand_total = COALESCE(grand_total,0) + ?, updated_at = datetime('now') WHERE id = ?`, [depositAmount, depositAmount, String(till.id)]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'DEPOSIT_TAKEN', entityType: 'DEPOSIT', entityId: id, branchId: branch.id, businessId: business.id,
      after: { type: depositType, customer: customer.name, product: product.name, qtyBase, depositAmount, totalPrice, expiresAt },
    });
    ctx.json({
      ok: true, id, depositType,
      message: `${depositType === 'HOLD' ? 'Item held' : 'Layaway opened'} for ${customer.name}: ${qty} ${unitCode.toLowerCase()} of ${product.name} at ₦${totalPrice.toLocaleString('en-NG')}. ₦${depositAmount.toLocaleString('en-NG')} taken, ₦${round2(totalPrice - depositAmount).toLocaleString('en-NG')} to pay by ${expiresAt}. The item is reserved and cannot be sold to anybody else.`,
      balanceDue: round2(totalPrice - depositAmount), expiresAt,
    }, 201);
  });

  /** Add a further payment to a deposit. */
  app.post(`${base}/deposits/:id/payments`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const deposit = await db.first('SELECT d.*, p.name AS product_name, c.name AS customer_name FROM deposits d LEFT JOIN products p ON p.id = d.product_id LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.is_deleted = 0', [id]);
    if (!deposit) throw new HttpError('That deposit does not exist.', { status: 404, code: 'DEPOSIT_NOT_FOUND' });
    if (['COMPLETED', 'FORFEITED', 'CANCELLED', 'EXPIRED'].includes(deposit.status)) {
      throw new HttpError(`That ${deposit.deposit_type.toLowerCase()} is ${deposit.status.toLowerCase()}, so it cannot take another payment.`, { status: 409, code: 'DEPOSIT_CLOSED' });
    }
    if (deposit.expires_at && String(deposit.expires_at).slice(0, 10) < watToday() && !boolField(body.accept_expired)) {
      throw new HttpError(`That ${deposit.deposit_type.toLowerCase()} expired on ${String(deposit.expires_at).slice(0, 10)}. Extend it or forfeit it first — taking money against an expired hold leaves the customer owing on goods that were released back to the shelf.`, { status: 409, code: 'DEPOSIT_EXPIRED' });
    }
    const amount = numField(requireVal(body, 'amount'), { field: 'Amount', min: 0.01 });
    const outstanding = round2(Number(deposit.balance_due));
    if (amount > outstanding) {
      throw new HttpError(`Only ₦${outstanding.toLocaleString('en-NG')} is outstanding on this ${deposit.deposit_type.toLowerCase()}. Taking ₦${amount.toLocaleString('en-NG')} would leave the customer in credit on goods they have not collected.`, { status: 400, code: 'OVERPAYMENT' });
    }
    const method = valid(oneOf(body.method || 'CASH', ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'USSD', 'CHEQUE'], { field: 'Payment method' }), 'method');
    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [deposit.branch_id]);
    const accountIds = await glService.loadAccountCodes(db, deposit.business_id);
    const newBalance = round2(outstanding - amount);
    const paidSoFar = round2(Number(deposit.deposit_amount) + amount);

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO deposit_payments (
          id, deposit_id, branch_id, amount, method, reference, received_by, received_at, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?, datetime('now'), ?, datetime('now'), datetime('now'))`, [
        newId(), id, String(deposit.branch_id), amount, method,
        strField(body.reference, { field: 'Reference', maxLength: 80 }), String(user.id),
        strField(body.notes, { field: 'Notes', maxLength: 300 }) || `Further payment on ${deposit.deposit_type.toLowerCase()}`,
      ]);
      tx.queue(`UPDATE deposits SET deposit_amount = ?, balance_due = ?, status = ?, updated_at = datetime('now')
          WHERE id = ? AND is_deleted = 0`, [
        // The schema allows only ACTIVE, COMPLETED, CANCELLED, EXPIRED and
        // FORFEITED. "How much has been paid" lives in deposit_amount and
        // balance_due, not in a status the CHECK constraint would refuse.
        paidSoFar, newBalance, 'ACTIVE', id,
      ]);
      const assetAccount = { CASH: '1000', BANK_TRANSFER: '1020', POS_TERMINAL: '1030', MOBILE_MONEY: '1040', USSD: '1040', CHEQUE: '1020' }[method] || '1000';
      for (const st of glService.buildEntry({
        businessId: String(deposit.business_id), branchId: String(deposit.branch_id), sourceType: 'SALE', sourceId: id,
        description: `Further deposit from ${deposit.customer_name} on ${deposit.product_name}`, postedBy: String(user.id), accountIds,
        lines: [
          { accountCode: assetAccount, debit: amount, description: 'Received' },
          { accountCode: '2200', credit: amount, description: 'Still a liability until collection' },
        ],
      })) tx.queue(st.sql, st.params);
    });
    await recordFromCtx(ctx, { action: 'DEPOSIT_PAYMENT', entityType: 'DEPOSIT', entityId: id, branchId: deposit.branch_id, businessId: deposit.business_id, before: { balanceDue: outstanding }, after: { amount, method, newBalance, paidSoFar } });
    ctx.json({
      ok: true,
      message: newBalance <= 0
        ? `${deposit.customer_name}'s ${deposit.deposit_type.toLowerCase()} on ${deposit.product_name} is PAID IN FULL (₦${paidSoFar.toLocaleString('en-NG')}). The goods can be released — complete the sale so the stock and the ledger move.`
        : `₦${amount.toLocaleString('en-NG')} received on ${deposit.customer_name}'s ${deposit.deposit_type.toLowerCase()}. ₦${newBalance.toLocaleString('en-NG')} still to pay by ${String(deposit.expires_at).slice(0, 10)}.`,
      paidSoFar, balanceDue: newBalance, fullyPaid: newBalance <= 0,
    }, 201);
  });

  /**
   * Complete a deposit: turn it into a real sale.
   *
   * The reserved stock is released and the sale engine runs normally, so the
   * stock decrement, the ledger and the receipt are all produced by the SAME
   * code path as any other sale. Building a second sale path here would be a
   * second definition of what a sale is.
   */
  app.post(`${base}/deposits/:id/complete`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const deposit = await db.first('SELECT * FROM deposits WHERE id = ? AND is_deleted = 0', [id]);
    if (!deposit) throw new HttpError('That deposit does not exist.', { status: 404, code: 'DEPOSIT_NOT_FOUND' });
    if (deposit.status === 'COMPLETED') throw new HttpError('That deposit has already been completed into a sale.', { status: 409, code: 'ALREADY_COMPLETED' });
    if (['FORFEITED', 'CANCELLED'].includes(deposit.status)) throw new HttpError(`That deposit was ${deposit.status.toLowerCase()}.`, { status: 409, code: 'DEPOSIT_CLOSED' });

    const outstanding = round2(Number(deposit.balance_due));
    if (outstanding > 0 && !boolField(body.allow_outstanding)) {
      throw new HttpError(`₦${outstanding.toLocaleString('en-NG')} is still outstanding on this ${deposit.deposit_type.toLowerCase()}. Collect it, or pass allow_outstanding to complete the sale with the balance still owed (which becomes a credit sale).`, { status: 409, code: 'BALANCE_OUTSTANDING' });
    }

    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [deposit.branch_id]);
    const business = await db.first('SELECT * FROM businesses WHERE id = ?', [deposit.business_id]);
    const customer = await db.first('SELECT * FROM customers WHERE id = ?', [deposit.customer_id]);
    const settings = ctx.get('settings');
    const accountIds = await glService.loadAccountCodes(db, business.id);

    // Release the reservation BEFORE the sale runs: the sale engine decrements
    // `quantity - quantity_reserved`, so leaving the reservation in place would
    // hide the very stock the sale is about to take.
    await db.run("UPDATE stock_batches SET quantity_reserved = MAX(0, quantity_reserved - ?), updated_at = datetime('now') WHERE id = ? AND is_deleted = 0",
      [Number(deposit.quantity_in_base), String(deposit.batch_id)]);
    if (deposit.serial_id) {
      await db.run("UPDATE serial_numbers SET status = 'IN_STOCK', updated_at = datetime('now') WHERE id = ? AND is_deleted = 0", [String(deposit.serial_id)]);
    }

    const serial = deposit.serial_id ? await db.first('SELECT serial_no FROM serial_numbers WHERE id = ?', [String(deposit.serial_id)]) : null;
    // The deposit already paid is applied as a payment leg, so the customer is
    // not asked for it twice and the till does not count it twice.
    const payments = [];
    const depositPaid = round2(Number(deposit.deposit_amount));
    if (depositPaid > 0) payments.push({ method: 'DEPOSIT', amount: depositPaid, reference: `Deposit ${id.slice(0, 8)}` });
    for (const p of (Array.isArray(body.payments) ? body.payments : [])) {
      payments.push({ method: String(p.method || 'CASH').toUpperCase(), amount: round2(Number(p.amount) || 0), reference: p.reference || null, cashTendered: p.cash_tendered != null ? Number(p.cash_tendered) : null });
    }

    let result;
    try {
      result = await salesService.complete(db, {
        branch, business, user, settings, scope: ctx.get('scope'),
        customer, customerClass: null, priceLists: [],
        lines: [{
          productId: String(deposit.product_id),
          variantId: deposit.variant_id ? String(deposit.variant_id) : null,
          quantity: Number(deposit.quantity),
          unitCode: deposit.unit_code,
          serialNumbers: serial && serial.serial_no ? [serial.serial_no] : [],
          notes: `${deposit.deposit_type} completed — deposit ${id.slice(0, 8)}`,
        }],
        saleType: 'RETAIL',
        payments,
        notes: `Completed from ${deposit.deposit_type.toLowerCase()} deposit taken ${String(deposit.created_at).slice(0, 10)}`,
        accountIds,
      });
    } catch (e) {
      // Put the reservation back: if the sale could not complete, the customer
      // still has their hold and the stock must stay reserved to them.
      await db.run("UPDATE stock_batches SET quantity_reserved = quantity_reserved + ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0",
        [Number(deposit.quantity_in_base), String(deposit.batch_id)]);
      throw e;
    }

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE deposits SET status = 'COMPLETED', completed_sale_id = ?, notes = COALESCE(notes,'') || ?,
          updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [
        String(result.saleId), `\n| Completed into sale ${result.receiptNo} ${watNow()}`, id,
      ]);
      // Move the liability to revenue: the goods have now been handed over, so
      // the deposit stops being money held and becomes a sale.
      for (const st of glService.buildEntry({
        businessId: String(business.id), branchId: String(branch.id), sourceType: 'SALE', sourceId: id,
        description: `Deposit ${id.slice(0, 8)} applied to sale ${result.receiptNo}`, postedBy: String(user.id), accountIds,
        lines: [
          { accountCode: '2200', debit: depositPaid, description: 'Liability released' },
          { accountCode: '1200', credit: depositPaid, description: 'Applied against the sale' },
        ],
      })) tx.queue(st.sql, st.params);
    });

    await recordFromCtx(ctx, {
      action: 'DEPOSIT_COMPLETED', entityType: 'DEPOSIT', entityId: id, branchId: branch.id, businessId: business.id,
      before: { status: deposit.status, balanceDue: outstanding },
      after: { saleId: result.saleId, receiptNo: result.receiptNo, total: result.totals.total },
    });
    ctx.json({
      ok: true, saleId: result.saleId, receiptNo: result.receiptNo, totals: result.totals,
      message: `${deposit.deposit_type} completed as sale ${result.receiptNo} — ₦${Number(result.totals.total).toLocaleString('en-NG')}, of which ₦${depositPaid.toLocaleString('en-NG')} was already deposited.${result.balanceDue > 0 ? ` ₦${Number(result.balanceDue).toLocaleString('en-NG')} remains on credit.` : ''}`,
      warnings: result.warnings || [],
    });
  });

  /** Forfeit or cancel a deposit, releasing the reserved stock. */
  app.post(`${base}/deposits/:id/cancel`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can forfeit or cancel a customer deposit. It decides whether they get their money back.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const deposit = await db.first('SELECT d.*, p.name AS product_name, c.name AS customer_name FROM deposits d LEFT JOIN products p ON p.id = d.product_id LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.is_deleted = 0', [id]);
    if (!deposit) throw new HttpError('That deposit does not exist.', { status: 404, code: 'DEPOSIT_NOT_FOUND' });
    if (['COMPLETED', 'FORFEITED', 'CANCELLED'].includes(deposit.status)) throw new HttpError(`That deposit is already ${deposit.status.toLowerCase()}.`, { status: 409, code: 'DEPOSIT_CLOSED' });

    const forfeit = boolField(body.forfeit);
    const reason = strField(requireVal(body, 'reason'), { field: 'Reason', maxLength: 500, required: true });
    if (reason.length < 6) throw new HttpError('Give a real reason. The customer paid money and is entitled to know why it was kept or returned.', { status: 400, code: 'REASON_REQUIRED' });

    const forfeitAmount = forfeit ? round2(Number(deposit.deposit_amount)) : 0;
    const refundAmount = forfeit ? 0 : round2(Number(deposit.deposit_amount));
    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [deposit.branch_id]);
    const accountIds = await glService.loadAccountCodes(db, deposit.business_id);
    const refundMethod = valid(oneOf(body.refund_method || 'CASH', ['CASH', 'BANK_TRANSFER', 'STORE_CREDIT'], { field: 'Refund method' }), 'refund_method');
    // Read before the transaction, because the store-credit ledger row is built
    // from the balance the customer already has.
    const customerBalanceBefore = (refundMethod === 'STORE_CREDIT' && deposit.customer_id)
      ? round2(Number((await db.first('SELECT credit_balance FROM customers WHERE id = ?', [String(deposit.customer_id)]) || {}).credit_balance) || 0)
      : 0;

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE deposits SET status = ?, forfeit_amount = ?, notes = COALESCE(notes,'') || ?,
          updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [
        forfeit ? 'FORFEITED' : 'CANCELLED', forfeitAmount,
        `\n| ${forfeit ? 'Forfeited' : 'Cancelled'} ${watNow()} by ${user.full_name || user.username}: ${reason}`,
        id,
      ]);
      // Release the reservation so the goods can be sold to somebody else.
      if (deposit.batch_id) {
        tx.queue("UPDATE stock_batches SET quantity_reserved = MAX(0, quantity_reserved - ?), updated_at = datetime('now') WHERE id = ? AND is_deleted = 0",
          [Number(deposit.quantity_in_base), String(deposit.batch_id)]);
      }
      if (deposit.serial_id) {
        tx.queue("UPDATE serial_numbers SET status = 'IN_STOCK', notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?",
          [`\n| Reservation released ${watNow()} — ${deposit.deposit_type.toLowerCase()} ${forfeit ? 'forfeited' : 'cancelled'}`, String(deposit.serial_id)]);
      }

      if (refundAmount > 0) {
        // DR 2200 liability, CR cash. The money goes back out and the liability
        // is cleared — the deposit was never revenue, so nothing is reversed in
        // the P&L.
        const assetAccount = refundMethod === 'BANK_TRANSFER' ? '1020' : '1000';
        for (const st of glService.buildEntry({
          businessId: String(deposit.business_id), branchId: String(deposit.branch_id), sourceType: 'SALE', sourceId: id,
          description: `Deposit refunded to ${deposit.customer_name}: ${reason}`, postedBy: String(user.id), accountIds,
          lines: [
            { accountCode: '2200', debit: refundAmount, description: 'Liability cleared' },
            { accountCode: refundMethod === 'STORE_CREDIT' ? '2200' : assetAccount, credit: refundAmount, description: refundMethod === 'STORE_CREDIT' ? 'Held as store credit' : 'Refunded' },
          ],
        })) tx.queue(st.sql, st.params);
        if (refundMethod === 'STORE_CREDIT' && deposit.customer_id) {
          const bal = customerBalanceBefore;
          tx.queue(`INSERT INTO debtor_ledger (
              id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
            VALUES (?,?,?,?, 'ADJUSTMENT', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
            newId(), String(deposit.branch_id), String(deposit.business_id), String(deposit.customer_id), id,
            -refundAmount, round2(bal - refundAmount), `Deposit ${id.slice(0, 8)} converted to store credit: ${reason}`, String(user.id),
          ]);
          tx.queue("UPDATE customers SET credit_balance = credit_balance - ?, updated_at = datetime('now') WHERE id = ?", [refundAmount, String(deposit.customer_id)]);
        }
      }
      if (forfeitAmount > 0) {
        // A forfeited deposit IS revenue — the business kept money for nothing in
        // return. It goes to other revenue, not to sales, because no goods moved.
        for (const st of glService.buildEntry({
          businessId: String(deposit.business_id), branchId: String(deposit.branch_id), sourceType: 'SALE', sourceId: id,
          description: `Deposit forfeited by ${deposit.customer_name}: ${reason}`, postedBy: String(user.id), accountIds,
          lines: [
            { accountCode: '2200', debit: forfeitAmount, description: 'Liability cleared' },
            { accountCode: '4010', credit: forfeitAmount, description: 'Forfeited deposit recognised as other revenue' },
          ],
        })) tx.queue(st.sql, st.params);
      }
    });

    await recordFromCtx(ctx, {
      action: forfeit ? 'DEPOSIT_FORFEITED' : 'DEPOSIT_CANCELLED', entityType: 'DEPOSIT', entityId: id,
      branchId: deposit.branch_id, businessId: deposit.business_id,
      before: { status: deposit.status, depositAmount: Number(deposit.deposit_amount) },
      after: { forfeit, forfeitAmount, refundAmount, refundMethod, reason },
    });
    ctx.json({
      ok: true,
      message: forfeit
        ? `${deposit.customer_name}'s deposit of ₦${forfeitAmount.toLocaleString('en-NG')} on ${deposit.product_name} FORFEITED and recognised as other revenue. The stock is back on the shelf. Reason recorded: ${reason}`
        : `${deposit.customer_name}'s deposit of ₦${refundAmount.toLocaleString('en-NG')} on ${deposit.product_name} cancelled and refunded by ${refundMethod.replace(/_/g, ' ').toLowerCase()}. The stock is back on the shelf.`,
      forfeitAmount, refundAmount, refundMethod,
    });
  });

  app.get(`${base}/deposits`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const where = ['d.is_deleted = 0']; const params = [];
    const f = scopeFilter(scope, { alias: 'd' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    // A BRANCH THE CALLER NAMED NARROWS THIS LIST — see branchFilter() in lib/respond.
    const bf = await branchFilter(db, ctx, { alias: 'd' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }
    const status = ctx.req.queryParam('status');
    if (status) { where.push('d.status = ?'); params.push(String(status).toUpperCase()); }
    else where.push("d.status NOT IN ('COMPLETED','FORFEITED','CANCELLED','EXPIRED')");
    const customerId = ctx.req.queryParam('customer_id');
    if (customerId) { where.push('d.customer_id = ?'); params.push(String(customerId)); }
    const whereSql = where.join(' AND ');
    const rows = await db.all(`SELECT d.*, p.name AS product_name, p.sku, p.base_unit_name, c.name AS customer_name,
          c.phone AS customer_phone, b.name AS branch_name, sn.serial_no, u.full_name AS created_by_name,
          (SELECT COALESCE(SUM(dp.amount),0) FROM deposit_payments dp WHERE dp.deposit_id = d.id AND dp.is_deleted = 0) AS total_paid
        FROM deposits d
        LEFT JOIN products p ON p.id = d.product_id
        LEFT JOIN customers c ON c.id = d.customer_id
        LEFT JOIN branches b ON b.id = d.branch_id
        LEFT JOIN serial_numbers sn ON sn.id = d.serial_id
        LEFT JOIN users u ON u.id = d.created_by
        WHERE ${whereSql} ORDER BY d.expires_at ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM deposits d WHERE ${whereSql}`, params);
    const today = watToday();
    ctx.json({
      ...listResponse(rows.map((r) => ({
        ...r,
        total_paid: round2(Number(r.total_paid)),
        balance_due: round2(Number(r.balance_due)),
        days_to_expiry: r.expires_at ? Math.round((Date.parse(String(r.expires_at).slice(0, 10)) - Date.parse(today)) / 86400000) : null,
        expired: r.expires_at ? String(r.expires_at).slice(0, 10) < today : false,
      })), { limit, offset }, total),
      summary: {
        held: round2(rows.reduce((a, r) => a + Number(r.total_paid || r.deposit_amount || 0), 0)),
        outstanding: round2(rows.reduce((a, r) => a + Number(r.balance_due), 0)),
        expiringSoon: rows.filter((r) => r.expires_at && Math.round((Date.parse(String(r.expires_at).slice(0, 10)) - Date.parse(today)) / 86400000) <= 7).length,
        expired: rows.filter((r) => r.expires_at && String(r.expires_at).slice(0, 10) < today).length,
      },
    });
  });

  // ===================================================================
  // INSTALMENT PLANS (Ajo-style)
  // ===================================================================
  /**
   * Open an instalment plan.
   *
   * The schedule is built by `domain/instalments.buildSchedule`, which puts the
   * rounding remainder on the FIRST instalment rather than spreading it. That is
   * deliberate: a customer who pays every instalment exactly as printed must end
   // at zero, and a remainder on the last payment means the final figure is the
   * one nobody checks until the plan is "paid" and still shows a balance.
   */
  app.post(`${base}/instalments`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();
    assertFeature(settings, 'instalment_module_enabled', 'Instalment plans');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can open an instalment plan. It is a loan, and the business carries the risk until it is repaid.', { status: 403, code: 'ROLE_REQUIRED' });

    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);
    const customerId = String(requireVal(body, 'customer_id'));
    const customer = await db.first('SELECT * FROM customers WHERE id = ? AND is_deleted = 0', [customerId]);
    if (!customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });

    const principal = numField(requireVal(body, 'principal'), { field: 'Principal', min: 1 });
    const depositAmount = numField(body.deposit_amount, { field: 'Deposit', min: 0 });
    const tenureMonths = numField(requireVal(body, 'tenure_months'), { field: 'Tenure (months)', min: 1, max: 60, whole: true });
    const frequency = valid(oneOf(body.frequency || 'MONTHLY', FREQUENCIES, { field: 'Frequency' }), 'frequency');
    const interestPercent = numField(body.interest_percent, { field: 'Interest rate', min: 0, max: 100 });

    const maxInterest = Number(settings.instalment_max_interest_pct) || 0;
    if (maxInterest > 0 && interestPercent > maxInterest) {
      throw new HttpError(`This business caps instalment interest at ${maxInterest}%; ${interestPercent}% was requested. A higher rate is both a regulatory exposure and the fastest way to lose a customer who was trying to pay.`, { status: 400, code: 'INTEREST_OVER_CAP' });
    }
    const maxTenure = Number(settings.instalment_max_tenure_months) || 0;
    if (maxTenure > 0 && tenureMonths > maxTenure) {
      throw new HttpError(`This business caps instalment tenure at ${maxTenure} months; ${tenureMonths} was requested.`, { status: 400, code: 'TENURE_OVER_CAP' });
    }

    // validatePlan enforces the deposit minimum, the tenure and the arithmetic
    // in one place, so the plan cannot be created with a schedule that does not
    // foot to the total.
    const check = validatePlan({ principal, depositAmount, interestPercent, tenureMonths, frequency, settings });
    if (!check.ok) throw new HttpError(check.error || check.message || 'That instalment plan is not valid.', { status: 400, code: check.code || 'INVALID_PLAN' });

    const count = instalmentCount(tenureMonths, frequency);
    const scheduleStart = strField(body.schedule_start, { field: 'First payment date', maxLength: 10 }) || watToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduleStart)) throw new HttpError('The first payment date must be YYYY-MM-DD.', { status: 400, code: 'INVALID_DATE' });
    const schedule = buildSchedule({
      financedAmount: check.financedAmount != null ? check.financedAmount : round2(principal - depositAmount),
      instalmentCount: count, scheduleStart, frequency,
    });
    const totalPayable = check.totalPayable != null ? check.totalPayable : round2(schedule.reduce((a, r) => a + r.amountDue, 0) + depositAmount);
    const interestAmount = round2(totalPayable - principal);

    const id = newId();
    const planNo = `IP-${String(branch.code || branch.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const guarantorName = strField(body.guarantor_name, { field: 'Guarantor name', maxLength: 160 });
    const accountIds = await glService.loadAccountCodes(db, business.id);

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO instalment_plans (
          id, plan_no, branch_id, business_id, customer_id, sale_id, deposit_id, principal, interest_percent,
          interest_amount, total_payable, deposit_amount, tenure_months, frequency, schedule_start, status,
          guarantor_name, guarantor_phone, guarantor_address, guarantor_id_type, guarantor_id_no,
          next_due_date, amount_paid, outstanding, days_overdue, approved_by, created_by, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?, 'ACTIVE', ?,?,?,?,?,?, ?, ?, ?, 0, ?, ?, datetime('now'), datetime('now'))`, [
        id, planNo, String(branch.id), String(business.id), customerId,
        body.sale_id ? String(body.sale_id) : null, body.deposit_id ? String(body.deposit_id) : null,
        principal, interestPercent, interestAmount, totalPayable, depositAmount, tenureMonths, frequency,
        scheduleStart, guarantorName,
        strField(body.guarantor_phone, { field: 'Guarantor phone', maxLength: 40 }),
        strField(body.guarantor_address, { field: 'Guarantor address', maxLength: 300 }),
        strField(body.guarantor_id_type, { field: 'Guarantor ID type', maxLength: 40 }),
        strField(body.guarantor_id_no, { field: 'Guarantor ID number', maxLength: 60 }),
        schedule[0] ? schedule[0].dueDate : scheduleStart,
        depositAmount, round2(totalPayable - depositAmount),
        String(user.id), String(user.id),
        strField(body.notes, { field: 'Notes', maxLength: 500 }),
      ]);
      for (const row of schedule) {
        tx.queue(`INSERT INTO instalment_schedule (
            id, plan_id, seq, due_date, amount_due, amount_paid, status, created_at, updated_at)
          VALUES (?,?,?,?,?, 0, ?, datetime('now'), datetime('now'))`, [
          newId(), id, row.seq, row.dueDate, row.amountDue, row.status,
        ]);
      }
      // The receivable is recognised NOW, for the whole financed amount: the
      // customer has the goods and owes the money. Interest is recognised as it
      // ACCRUES on each payment, not up front — booking all of it on day one
      // would show income the business has not earned and would overstate profit
      // on a plan that then defaults.
      for (const st of glService.buildEntry({
        businessId: String(business.id), branchId: String(branch.id), sourceType: 'INSTALMENT', sourceId: id,
        description: `Instalment plan ${planNo} for ${customer.name}`, postedBy: String(user.id), accountIds,
        lines: [
          { accountCode: '1210', debit: round2(totalPayable - depositAmount), description: 'Instalment receivable' },
          { accountCode: '1200', credit: round2(totalPayable - depositAmount), description: 'Trade receivable moved to instalments' },
        ],
      })) tx.queue(st.sql, st.params);
    });

    await recordFromCtx(ctx, {
      action: 'INSTALMENT_PLAN_OPENED', entityType: 'INSTALMENT_PLAN', entityId: id, branchId: branch.id, businessId: business.id,
      after: { planNo, customer: customer.name, principal, depositAmount, interestPercent, interestAmount, totalPayable, tenureMonths, frequency, instalments: schedule.length },
    });
    ctx.json({
      ok: true, id, planNo,
      message: `Instalment plan ${planNo} opened for ${customer.name}: ₦${principal.toLocaleString('en-NG')} over ${count} ${frequency.toLowerCase()} payment(s) of about ₦${round2(schedule[0] ? schedule[0].amountDue : 0).toLocaleString('en-NG')}, first due ${schedule[0] ? schedule[0].dueDate : scheduleStart}. Total payable ₦${totalPayable.toLocaleString('en-NG')} including ₦${interestAmount.toLocaleString('en-NG')} of interest.`,
      schedule: schedule.map((r) => ({ seq: r.seq, dueDate: r.dueDate, amountDue: r.amountDue, status: r.status })),
      totalPayable, interestAmount, principal, depositAmount,
      // Shown because it is the figure a customer disputes most often, and
      // showing it at the point of agreement is the only time it is useful.
      effectiveAnnualRate: principal > 0 && tenureMonths > 0 ? round2((interestAmount / principal) * (12 / tenureMonths) * 100) : null,
    }, 201);
  });

  /** Take an instalment payment and allocate it across the schedule. */
  app.post(`${base}/instalments/:id/payments`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const plan = await db.first('SELECT ip.*, c.name AS customer_name, c.credit_balance FROM instalment_plans ip LEFT JOIN customers c ON c.id = ip.customer_id WHERE ip.id = ? AND ip.is_deleted = 0', [id]);
    if (!plan) throw new HttpError('That instalment plan does not exist.', { status: 404, code: 'PLAN_NOT_FOUND' });
    if (['COMPLETED', 'CANCELLED', 'DEFAULTED'].includes(plan.status)) {
      throw new HttpError(`That plan is ${plan.status.toLowerCase()}, so it cannot take a payment.${plan.status === 'DEFAULTED' ? ' Reinstate it first if the customer has resumed paying.' : ''}`, { status: 409, code: 'PLAN_CLOSED' });
    }
    const amount = numField(requireVal(body, 'amount'), { field: 'Amount', min: 0.01 });
    const method = valid(oneOf(body.method || 'CASH', ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'USSD', 'CHEQUE'], { field: 'Payment method' }), 'method');
    const reference = strField(body.reference, { field: 'Reference', maxLength: 80 });
    if (method === 'BANK_TRANSFER' && !reference) {
      throw new HttpError('A transfer needs its reference or alert code, or it cannot be matched to the bank statement.', { status: 400, code: 'REFERENCE_REQUIRED' });
    }
    const paidAt = strField(body.paid_at || body.received_at, { field: 'Paid at', maxLength: 40 }) || watNow();

    const rows = await db.all('SELECT * FROM instalment_schedule WHERE plan_id = ? AND is_deleted = 0 ORDER BY seq ASC', [id]);
    if (!rows.length) throw new HttpError('That plan has no schedule, so there is nothing to allocate against.', { status: 409, code: 'NO_SCHEDULE' });

    // applyPayment allocates oldest-first and reports anything it could not
    // allocate. Absorbing an overpayment silently would leave the customer with
    // credit nobody knows about.
    const applied = applyPayment({
      schedule: rows.map((r) => ({ seq: r.seq, dueDate: r.due_date, amountDue: Number(r.amount_due), amountPaid: Number(r.amount_paid) || 0, status: r.status })),
      amount, paidAt,
    });
    if (!applied.ok) throw new HttpError(applied.error || 'That payment could not be allocated.', { status: 400, code: applied.code || 'ALLOCATION_FAILED' });

    const accountIds = await glService.loadAccountCodes(db, plan.business_id);
    const paymentId = newId();
    const outstandingBefore = round2(Number(plan.outstanding));
    const outstandingAfter = round2(Math.max(0, outstandingBefore - amount));
    const amountPaidAfter = round2(Number(plan.amount_paid) + amount);
    const nextDue = applied.schedule.find((r) => r.status !== 'PAID');
    const status = planStatusFromSchedule({
      schedule: applied.schedule.map((r) => ({ ...r, amountDue: r.amountDue, amountPaid: r.amountPaid != null ? r.amountPaid : r.amount_due })),
      totalPayable: Number(plan.total_payable), depositAmount: Number(plan.deposit_amount),
    });
    // Interest recognised on THIS payment, pro-rata. Recognising it all up front
    // would book income not yet earned on a plan that might still default.
    const interestShare = Number(plan.total_payable) > 0
      ? round2(amount * (Number(plan.interest_amount) / Number(plan.total_payable)))
      : 0;

    await db.transaction(async (tx) => {
      for (const alloc of applied.allocated) {
        const row = rows.find((r) => Number(r.seq) === Number(alloc.seq));
        if (!row) continue;
        tx.queue(`UPDATE instalment_schedule SET amount_paid = ?, paid_at = ?, status = ?, updated_at = datetime('now')
            WHERE id = ? AND is_deleted = 0`, [
          round2(Number(row.amount_paid || 0) + alloc.applied), paidAt, alloc.newStatus, String(row.id),
        ]);
        tx.queue(`INSERT INTO instalment_payments (
            id, plan_id, schedule_id, branch_id, amount, method, reference, received_by, received_at, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?, ?, datetime('now'), datetime('now'))`, [
          newId(), id, String(row.id), String(plan.branch_id), alloc.applied, method, reference,
          String(user.id), paidAt, `Instalment ${alloc.seq}`,
        ]);
      }
      tx.queue(`UPDATE instalment_plans SET amount_paid = ?, outstanding = ?, status = ?, next_due_date = ?,
          days_overdue = 0, notes = COALESCE(notes,'') || ?, updated_at = datetime('now')
        WHERE id = ? AND is_deleted = 0`, [
        amountPaidAfter, outstandingAfter, status.status || status, nextDue ? nextDue.dueDate : null,
        `\n| ₦${amount.toLocaleString('en-NG')} received ${paidAt} by ${method.replace(/_/g, ' ').toLowerCase()}${reference ? ` ref ${reference}` : ''}`,
        id,
      ]);
      const assetAccount = { CASH: '1000', BANK_TRANSFER: '1020', POS_TERMINAL: '1030', MOBILE_MONEY: '1040', USSD: '1040', CHEQUE: '1020' }[method] || '1000';
      const principalShare = round2(amount - interestShare);
      const lines = [
        { accountCode: assetAccount, debit: amount, description: 'Instalment received' },
        { accountCode: '1210', credit: principalShare, description: 'Instalment receivable reduced' },
      ];
      if (interestShare > 0) lines.push({ accountCode: '4400', credit: interestShare, description: 'Interest earned on this instalment' });
      for (const st of glService.buildEntry({
        businessId: String(plan.business_id), branchId: String(plan.branch_id), sourceType: 'INSTALMENT', sourceId: paymentId,
        description: `Instalment payment from ${plan.customer_name} on ${plan.plan_no}`, postedBy: String(user.id), accountIds, lines,
      })) tx.queue(st.sql, st.params);
    });

    await recordFromCtx(ctx, {
      action: 'INSTALMENT_PAYMENT', entityType: 'INSTALMENT_PLAN', entityId: id, branchId: plan.branch_id, businessId: plan.business_id,
      before: { outstanding: outstandingBefore, amountPaid: Number(plan.amount_paid), status: plan.status },
      after: { amount, method, reference, outstandingAfter, amountPaidAfter, interestShare, allocated: applied.allocated.length, unallocated: applied.unallocated },
    });
    ctx.json({
      ok: true, id: paymentId,
      message: `₦${amount.toLocaleString('en-NG')} received on ${plan.plan_no} for ${plan.customer_name}, allocated across ${applied.allocated.length} instalment(s). ₦${outstandingAfter.toLocaleString('en-NG')} outstanding.${applied.unallocated > 0 ? ` ₦${round2(applied.unallocated).toLocaleString('en-NG')} could NOT be allocated — the plan is nearly paid off, so refund or carry it forward.` : ''}`,
      allocated: applied.allocated,
      unallocated: round2(applied.unallocated),
      outstandingAfter, amountPaidAfter, interestShare,
      planStatus: status.status || status,
      nextDueDate: nextDue ? nextDue.dueDate : null,
    }, 201);
  });

  app.get(`${base}/instalments`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const where = ['ip.is_deleted = 0']; const params = [];
    const f = scopeFilter(scope, { alias: 'ip' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    // A BRANCH THE CALLER NAMED NARROWS THIS LIST — see branchFilter() in lib/respond.
    const bf = await branchFilter(db, ctx, { alias: 'ip' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }
    const status = ctx.req.queryParam('status');
    if (status) { where.push('ip.status = ?'); params.push(String(status).toUpperCase()); }
    const customerId = ctx.req.queryParam('customer_id');
    if (customerId) { where.push('ip.customer_id = ?'); params.push(String(customerId)); }
    if (boolField(ctx.req.queryParam('overdue_only'))) where.push("ip.next_due_date < date('now','+1 hours') AND ip.status = 'ACTIVE'");
    const whereSql = where.join(' AND ');
    const rows = await db.all(`SELECT ip.*, c.name AS customer_name, c.phone AS customer_phone, b.name AS branch_name,
          (SELECT COUNT(*) FROM instalment_schedule sc WHERE sc.plan_id = ip.id AND sc.status = 'PAID' AND sc.is_deleted = 0) AS instalments_paid,
          (SELECT COUNT(*) FROM instalment_schedule sc WHERE sc.plan_id = ip.id AND sc.is_deleted = 0) AS instalments_total,
          (SELECT MIN(sc.due_date) FROM instalment_schedule sc WHERE sc.plan_id = ip.id AND sc.status <> 'PAID' AND sc.is_deleted = 0) AS next_due
        FROM instalment_plans ip
        LEFT JOIN customers c ON c.id = ip.customer_id
        LEFT JOIN branches b ON b.id = ip.branch_id
        WHERE ${whereSql} ORDER BY ip.next_due_date ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM instalment_plans ip WHERE ${whereSql}`, params);
    const today = watToday();
    ctx.json({
      ...listResponse(rows.map((r) => ({
        ...r,
        outstanding: round2(Number(r.outstanding)),
        amount_paid: round2(Number(r.amount_paid)),
        days_overdue: r.next_due && r.status === 'ACTIVE' && r.next_due < today ? Math.round((Date.parse(today) - Date.parse(r.next_due)) / 86400000) : 0,
        overdue: Boolean(r.next_due && r.status === 'ACTIVE' && r.next_due < today),
      })), { limit, offset }, total),
      summary: {
        plans: rows.length,
        outstanding: round2(rows.reduce((a, r) => a + Number(r.outstanding), 0)),
        overdue: rows.filter((r) => r.next_due && r.status === 'ACTIVE' && r.next_due < today).length,
        overdueValue: round2(rows.filter((r) => r.next_due && r.status === 'ACTIVE' && r.next_due < today).reduce((a, r) => a + Number(r.outstanding), 0)),
        interestEarned: round2(rows.reduce((a, r) => a + Number(r.interest_amount), 0)),
      },
    });
  });

  app.get(`${base}/instalments/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const plan = await db.first(`SELECT ip.*, c.name AS customer_name, c.phone AS customer_phone, c.address,
          b.name AS branch_name, u.full_name AS approved_by_name
        FROM instalment_plans ip
        LEFT JOIN customers c ON c.id = ip.customer_id
        LEFT JOIN branches b ON b.id = ip.branch_id
        LEFT JOIN users u ON u.id = ip.approved_by
        WHERE ip.id = ? AND ip.is_deleted = 0`, [id]);
    if (!plan) throw new HttpError('That instalment plan does not exist.', { status: 404, code: 'PLAN_NOT_FOUND' });
    const [schedule, payments] = await Promise.all([
      db.all('SELECT * FROM instalment_schedule WHERE plan_id = ? AND is_deleted = 0 ORDER BY seq ASC', [id]),
      db.all(`SELECT ipay.*, u.full_name AS received_by_name FROM instalment_payments ipay
          LEFT JOIN users u ON u.id = ipay.received_by
          WHERE ipay.plan_id = ? AND ipay.is_deleted = 0 ORDER BY ipay.received_at DESC`, [id]),
    ]);
    const today = watToday();
    ctx.json({
      ok: true, plan, schedule, payments,
      progress: {
        instalmentsPaid: schedule.filter((r) => r.status === 'PAID').length,
        instalmentsTotal: schedule.length,
        pctPaid: Number(plan.total_payable) > 0 ? round2((Number(plan.amount_paid) / Number(plan.total_payable)) * 100) : 0,
        outstanding: round2(Number(plan.outstanding)),
        overdueInstalments: schedule.filter((r) => r.status !== 'PAID' && r.due_date < today).length,
      },
      trigger: defaultTrigger({ plan, settings: ctx.get('settings'), today }),
    });
  });
}

/** Refuse when a module the owner switched off is being used. */
function assertFeature(settings, column, label) {
  if (!label) return;
  if (!Number(settings[column])) {
    throw new HttpError(`${label} is not enabled on this deployment. It can be switched on in Settings — it is a plan feature, not a technical limit.`, { status: 403, code: 'FEATURE_DISABLED' });
  }
}

function requireVal(body, field, label) {
  const v = body[field];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new HttpError(`${label ? `${label}: ` : ''}${field.replace(/_/g, ' ')} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: 'Required' } });
  }
  return v;
}

module.exports = { mount, RETURN_REASONS, RETURN_CONDITIONS, DEPOSIT_TYPES, FREQUENCIES };
