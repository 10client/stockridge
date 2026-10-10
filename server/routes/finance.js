'use strict';
// =====================================================================
// server/routes/finance.js — MONEY LEAVING THE BUSINESS
// =====================================================================
// The mirror image of customers.js: where that module tracks what customers owe
// THIS business, this one tracks what the business owes its SUPPLIERS, plus the
// purchase orders that create those obligations and the bank movements that
// settle them.
//
// THE RULE THAT MATTERS: buying stock is an ASSET MOVEMENT, not an expense.
//
//   DR 1100 Inventory        CR 2000 Creditors / 1020 Bank
//
// Stock sits on the balance sheet until it is SOLD, at which point it moves to
// 5000 Cost of Sales. A shop that expenses its purchases shows a catastrophic
// loss in the month it stocks up and an impossible profit in the month it sells
// — which is exactly what happens when the purchase is posted to an expense
// account, and it is the single most common reason a small Nigerian retailer's
// "accounts" do not match their bank.
//
// WHT on supply of goods is 2%, and a MANUFACTURER is exempt. That exemption
// lives on `suppliers.is_manufacturer` as data, so getting it wrong is a
// supplier record problem rather than a code problem.
// =====================================================================

const { idempotent } = require('../lib/idempotency');
const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, readBusinessId, branchFilter, scopeFilter, pagination, listResponse, dateRange, numField, strField, boolField, valid } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday, addDays } = require('../../domain/time');
const { toBaseUnits, buildLadder } = require('../../domain/uom');
const { oneOf } = require('../../domain/validation');
const { resolveDeduction, exemptionHint, whtRemittanceDueDate, WHT_REMITTANCE_DAY_OF_MONTH } = require('../../domain/nigerianTax');
const { ageBalance } = require('../../domain/credit');
const glService = require('../services/glService');
const { parseSerials, acceptSerials, planSerialRows, serialStatements } = require('../services/serialsService');

const PO_STATUSES = ['DRAFT', 'PENDING', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // PURCHASE ORDERS
  // -------------------------------------------------------------------
  app.get(`${base}/purchase-orders`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 60 });
    const where = ['po.is_deleted = 0', "date(COALESCE(po.ordered_at, po.updated_at)) BETWEEN ? AND ?"];
    const params = [from, to];
    const f = scopeFilter(scope, { alias: 'po' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    // A BRANCH THE CALLER NAMED NARROWS THIS LIST — see branchFilter() in lib/respond.
    const bf = await branchFilter(db, ctx, { alias: 'po' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }
    const status = ctx.req.queryParam('status');
    if (status) { where.push('po.status = ?'); params.push(String(status).toUpperCase()); }
    const supplierId = ctx.req.queryParam('supplier_id');
    if (supplierId) { where.push('po.supplier_id = ?'); params.push(String(supplierId)); }
    const whereSql = where.join(' AND ');

    const rows = await db.all(`SELECT po.*, s.name AS supplier_name, b.name AS branch_name, u.full_name AS ordered_by_name,
          (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id AND i.is_deleted = 0) AS item_count,
          (SELECT COALESCE(SUM(i.quantity_in_base),0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id AND i.is_deleted = 0) AS units_ordered,
          (SELECT COALESCE(SUM(i.quantity_received),0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id AND i.is_deleted = 0) AS units_received
        FROM purchase_orders po
        LEFT JOIN suppliers s ON s.id = po.supplier_id
        LEFT JOIN branches b ON b.id = po.branch_id
        LEFT JOIN users u ON u.id = po.ordered_by
        WHERE ${whereSql} ORDER BY po.ordered_at DESC, po.po_number DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM purchase_orders po WHERE ${whereSql}`, params);
    ctx.json({
      ...listResponse(rows.map((r) => ({
        ...r,
        outstanding_units: round2(Number(r.units_ordered) - Number(r.units_received)),
        expected_date: r.expected_date,
        overdue: r.expected_date && r.status !== 'RECEIVED' && r.status !== 'CANCELLED' && r.expected_date < watToday(),
      })), { limit, offset }, total),
      range: { from, to },
    });
  });

  /**
   * Raise a purchase order.
   *
   * Quantities are converted to BASE UNITS at order time using the product's own
   * ladder, exactly as a sale does. Ordering "20 cartons" and storing 20 would
   * make the received-quantity comparison meaningless the moment the supplier
   * delivers in a different pack size — which happens constantly.
   */
  app.post(`${base}/purchase-orders`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can raise a purchase order. It commits the business to pay a supplier.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const supplierId = String(requireVal(body, 'supplier_id'));
    const supplier = await db.first('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0', [supplierId]);
    if (!supplier) throw new HttpError('That supplier does not exist.', { status: 404, code: 'SUPPLIER_NOT_FOUND' });

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) throw new HttpError('A purchase order needs at least one item.', { status: 400, code: 'EMPTY_PO' });

    const items = [];
    let subtotal = 0;
    for (let i = 0; i < rawItems.length; i += 1) {
      const raw = rawItems[i];
      const productId = String(requireVal(raw, 'product_id', `Item ${i + 1}`));
      const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [productId]);
      if (!product) throw new HttpError(`Item ${i + 1}: that product does not exist.`, { status: 404, code: 'PRODUCT_NOT_FOUND' });
      const units = await db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [productId]);
      const ladder = buildLadder(units);
      const unitCode = String(raw.unit_code || (ladder.ok ? ladder.defaultSell.code : 'PIECE')).toUpperCase();
      const qty = numField(requireVal(raw, 'quantity', `Item ${i + 1}`), { field: `Item ${i + 1} quantity`, min: 0.0001, places: 4 });
      const conv = toBaseUnits({ quantity: qty, unitCode, ladder: ladder.ok ? ladder.ladder : [] });
      if (!conv.ok) throw new HttpError(`Item ${i + 1} (${product.name}): ${conv.error}`, { status: 400, code: conv.code });
      const unitCost = numField(raw.expected_unit_cost ?? raw.cost_price ?? product.cost_price, { field: `Item ${i + 1} unit cost`, min: 0, places: 6 });
      const lineTotal = round2(qty * unitCost);
      subtotal = round2(subtotal + lineTotal);
      items.push({ productId, product, unitCode, quantityOrdered: qty, quantityInBase: conv.baseQuantity, expectedUnitCost: unitCost, expectedTotalCost: lineTotal, variantId: raw.variant_id ? String(raw.variant_id) : null, notes: strField(raw.notes, { field: 'Item note', maxLength: 300 }) });
    }

    const freightTotal = numField(body.freight_total ?? body.freight, { field: 'Freight', min: 0 });
    const discountTotal = numField(body.discount_total ?? body.discount, { field: 'Discount', min: 0 });
    if (discountTotal > subtotal) {
      throw new HttpError(`A ₦${discountTotal.toLocaleString('en-NG')} discount exceeds the ₦${subtotal.toLocaleString('en-NG')} subtotal.`, { status: 400, code: 'DISCOUNT_EXCEEDS_SUBTOTAL' });
    }
    const settings = ctx.get('settings');
    const vatTotal = boolField(body.vat_inclusive) ? 0 : (Number(settings.vat_enabled) && supplier.tin
      ? round2((subtotal - discountTotal + freightTotal) * (Number(settings.vat_rate_percent) || 7.5) / 100)
      : 0);

    // WHT on goods supplied: 2%, and a manufacturer is exempt. Resolved from the
    // wht_rates table so a change in the Regulations does not need a redeploy.
    const whtCode = strField(body.wht_code, { field: 'WHT code', maxLength: 40 }) || (subtotal - discountTotal > 0 ? 'SUPPLY_OF_GOODS' : null);
    let wht = null;
    if (whtCode) {
      wht = await resolveDeduction(db, {
        grossAmount: round2(subtotal - discountTotal + freightTotal + vatTotal),
        rateCode: whtCode,
        ratePercentOverride: body.wht_percent != null ? numField(body.wht_percent, { field: 'WHT rate', min: 0, max: 100 }) : null,
        direction: 'PAYABLE',
      });
    }
    const exemption = wht ? exemptionHint({
      grossAmount: round2(subtotal - discountTotal),
      counterpartyTin: supplier.tin,
      counterpartyIsManufacturer: Boolean(Number(supplier.is_manufacturer)),
    }) : null;

    const total = round2(subtotal - discountTotal + freightTotal + vatTotal);
    const id = newId();
    const poNumber = strField(body.po_number, { field: 'PO number', maxLength: 40 })
      || `PO-${String(branch.code || branch.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const dupe = await db.first('SELECT id FROM purchase_orders WHERE po_number = ? AND is_deleted = 0', [poNumber]);
    if (dupe) throw new HttpError(`A purchase order numbered ${poNumber} already exists.`, { status: 409, code: 'DUPLICATE_PO_NUMBER' });

    const expectedDate = strField(body.expected_date, { field: 'Expected date', maxLength: 10 }) || addDays(watToday(), supplier.payment_terms_days || 7);
    const status = valid(oneOf(body.status || 'PENDING', PO_STATUSES, { field: 'Status' }), 'status');

    // Credit exposure: an open PO plus what is already owed. Advisory, because a
    // shop must be able to order beyond a supplier's nominal limit — but the
    // figure has to be in front of the person doing it.
    const owedToSupplier = round2(Number((await db.first('SELECT COALESCE(SUM(amount),0) AS owed FROM creditor_ledger WHERE supplier_id = ? AND is_deleted = 0', [supplierId]) || {}).owed));
    const openPoValue = round2(Number((await db.first(`SELECT COALESCE(SUM(total),0) AS v FROM purchase_orders
        WHERE supplier_id = ? AND is_deleted = 0 AND status IN ('DRAFT','PENDING','PARTIALLY_RECEIVED')`, [supplierId]) || {}).v));
    const supplierLimit = round2(Number(supplier.credit_limit) || 0);
    const advisories = [];
    if (supplierLimit > 0 && owedToSupplier + openPoValue + total > supplierLimit) {
      advisories.push(`${supplier.name} would be exposed to ₦${round2(owedToSupplier + openPoValue + total).toLocaleString('en-NG')} against a ₦${supplierLimit.toLocaleString('en-NG')} credit limit. This order is recorded anyway — a limit is a prompt to check, not a wall.`);
    }
    if (exemption) advisories.push(exemption);

    await db.transaction(async (tx) => {
      // `purchase_orders` has no created_at column; ordered_at is the timestamp
      // that matters and it is set explicitly rather than defaulting.
      tx.queue(`INSERT INTO purchase_orders (
          id, branch_id, business_id, po_number, supplier_id, status, ordered_by, ordered_at, expected_date,
          currency_code, fx_rate, subtotal, discount_total, freight_total, vat_total, wht_code, wht_percent,
          wht_amount, total, notes, updated_at)
        VALUES (?,?,?,?,?,?,?, datetime('now'),?,?, 1,?,?,?,?,?,?, ?,?,?, datetime('now'))`, [
        id, String(branch.id), String(business.id), poNumber, supplierId, status, String(user.id),
        expectedDate, 'NGN', subtotal, discountTotal, freightTotal, vatTotal,
        wht ? wht.rateCode : null, wht ? Number(wht.ratePercent) : 0, wht ? round2(wht.wht) : 0,
        total, strField(body.notes, { field: 'Notes', maxLength: 1000 }),
      ]);

      // Freight is ALLOCATED across the lines in proportion to value, because it
      // is part of the cost of the goods. Leaving it unallocated means the batch
      // cost excludes it and the margin on those goods is overstated by exactly
      // the freight — which for a container of building materials is not small.
      for (const item of items) {
        const allocation = subtotal > 0 ? round2(freightTotal * (item.expectedTotalCost / subtotal)) : 0;
        // THE ZERO BELONGS TO `quantity_received`, AND IT USED TO SIT ONE PLACE TOO FAR
        // RIGHT.
        //
        // Fourteen columns and thirteen bound values is a shape that hides its own
        // mistyping: the literal 0 landed in `expected_total_cost`, so every line was
        // written with `quantity_received = expected_unit_cost`, `expected_unit_cost =
        // expected_total_cost` and `freight_allocation = allocation` — and the schema's
        // own CHECK (`quantity_received <= quantity_in_base`) then refused the order
        // outright whenever a unit cost exceeded the quantity ordered in base units,
        // which is to say almost always. The flow had never been exercised by any test,
        // which is how it survived: `tools/flow-coverage.js` found it by reporting that
        // purchase orders were covered by NO live audit.
        //
        // Binding `quantity_received` as 0 in its own column keeps every value next to
        // the name it belongs to.
        tx.queue(`INSERT INTO purchase_order_items (
            id, purchase_order_id, product_id, variant_id, unit_code, quantity_ordered, quantity_in_base,
            quantity_received, expected_unit_cost, expected_total_cost, freight_allocation, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?, 0, ?,?,?,?, datetime('now'), datetime('now'))`, [
          newId(), id, item.productId, item.variantId, item.unitCode, item.quantityOrdered,
          item.quantityInBase, item.expectedUnitCost, item.expectedTotalCost, allocation, item.notes,
        ]);
      }

      // The obligation is booked when the PO is confirmed, not when the goods
      // arrive. A DRAFT commits nothing; a SENT order is a promise to pay.
      if (status !== 'DRAFT' && status !== 'CANCELLED') {
        if (wht && round2(wht.wht) > 0) {
          tx.queue(`INSERT INTO wht_entries (
              id, branch_id, business_id, direction, source_type, source_id, rate_code, rate_percent,
              gross_amount, wht_amount, net_amount, supplier_id, counterparty_name, counterparty_tin,
              recorded_by, entry_date, notes, created_at, updated_at)
            VALUES (?,?,?, 'PAYABLE', 'PO_RECEIVE', ?,?,?, ?,?,?, ?, ?, ?, ?, date('now'), ?, datetime('now'), datetime('now'))`, [
            newId(), String(branch.id), String(business.id), id,
            wht.rateCode, Number(wht.ratePercent), round2(subtotal - discountTotal + freightTotal + vatTotal),
            round2(wht.wht), round2(total - wht.wht), supplierId, supplier.name, supplier.tin,
            String(user.id), `WHT withheld on ${poNumber}`,
          ]);
        }
        tx.queue(`INSERT INTO creditor_ledger (
            id, branch_id, business_id, supplier_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
          VALUES (?,?,?,?, 'PURCHASE', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
          newId(), String(branch.id), String(business.id), supplierId, id, total,
          round2(owedToSupplier + total), `Purchase order ${poNumber} raised with ${supplier.name}`, String(user.id),
        ]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'PO_CREATED', entityType: 'PURCHASE_ORDER', entityId: id, branchId: branch.id, businessId: business.id,
      after: { poNumber, supplier: supplier.name, items: items.length, total, status, wht: wht ? round2(wht.wht) : 0 },
    });
    ctx.json({
      ok: true, id, poNumber, total, status,
      message: `Purchase order ${poNumber} raised with ${supplier.name} for ₦${total.toLocaleString('en-NG')} across ${items.length} line(s).${wht && round2(wht.wht) > 0 ? ` ₦${round2(wht.wht).toLocaleString('en-NG')} WHT (${wht.ratePercent}%) will be withheld on payment.` : ''}`,
      advisories,
      exposure: { owedToSupplier, openPoValue, thisOrder: total, supplierLimit },
    }, 201);
  });

  app.get(`${base}/purchase-orders/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const po = await db.first(`SELECT po.*, s.name AS supplier_name, s.contact_person, s.phone AS supplier_phone,
          s.tin AS supplier_tin, s.is_manufacturer, b.name AS branch_name, u.full_name AS ordered_by_name
        FROM purchase_orders po
        LEFT JOIN suppliers s ON s.id = po.supplier_id
        LEFT JOIN branches b ON b.id = po.branch_id
        LEFT JOIN users u ON u.id = po.ordered_by
        WHERE po.id = ? AND po.is_deleted = 0`, [id]);
    if (!po) throw new HttpError('That purchase order does not exist.', { status: 404, code: 'PO_NOT_FOUND' });
    const [items, receipts, ledger] = await Promise.all([
      // `p.requires_serial` IS IN THE PAYLOAD. The receive screen asks for a serial number per
      // unit on serial-tracked products — the route refuses the delivery without them — and it
      // cannot ask for what the line never told it. Without this column the form had no way to
      // know a line needed numbers, so a phone or an appliance was refused with nowhere to type.
      db.all(`SELECT i.*, p.name AS product_name, p.sku, p.base_unit_name, p.requires_serial, v.name AS variant_name
          FROM purchase_order_items i
          JOIN products p ON p.id = i.product_id
          LEFT JOIN product_variants v ON v.id = i.variant_id
          WHERE i.purchase_order_id = ? AND i.is_deleted = 0 ORDER BY p.name, i.id`, [id]),
      db.all(`SELECT r.*, p.name AS product_name, u.full_name AS received_by_name
          FROM purchase_order_receipts r
          LEFT JOIN purchase_order_items i ON i.id = r.purchase_order_item_id
          LEFT JOIN products p ON p.id = i.product_id
          LEFT JOIN users u ON u.id = r.received_by
          WHERE r.purchase_order_id = ? AND r.is_deleted = 0 ORDER BY r.received_at DESC`, [id]),
      db.all('SELECT * FROM creditor_ledger WHERE reference_id = ? AND is_deleted = 0 ORDER BY created_at, id', [id]),
    ]);
    ctx.json({
      ok: true, po,
      items: items.map((i) => ({ ...i, outstanding: round2(Number(i.quantity_in_base) - Number(i.quantity_received)) })),
      receipts, ledger,
      totals: {
        subtotal: Number(po.subtotal), discount: Number(po.discount_total), freight: Number(po.freight_total),
        vat: Number(po.vat_total), wht: Number(po.wht_amount), total: Number(po.total),
        receivedValue: round2(receipts.reduce((a, r) => a + Number(r.quantity_received) * Number(r.cost_per_unit), 0)),
      },
      whtRemittanceDue: Number(po.wht_amount) > 0 ? whtRemittanceDueDate(watToday().slice(0, 7)) : null,
    });
  });

  /** Cancel a PO. Only if nothing has been received against it. */
  app.post(`${base}/purchase-orders/:id/cancel`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can cancel a purchase order.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const po = await db.first('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0', [id]);
    if (!po) throw new HttpError('That purchase order does not exist.', { status: 404, code: 'PO_NOT_FOUND' });
    if (po.status === 'CANCELLED') throw new HttpError('That purchase order is already cancelled.', { status: 409, code: 'ALREADY_CANCELLED' });
    const received = await db.scalar('SELECT COALESCE(SUM(quantity_received),0) FROM purchase_order_items WHERE purchase_order_id = ? AND is_deleted = 0', [id]);
    if (Number(received) > 0) {
      throw new HttpError(
        `${round2(Number(received))} unit(s) have already been received against ${po.po_number}. A partly-received order cannot be cancelled — the goods exist and the debt is real. Reduce the outstanding quantity instead, or receive the rest.`,
        { status: 409, code: 'PO_PARTLY_RECEIVED' },
      );
    }
    const reason = strField(requireVal(body, 'reason'), { field: 'Reason', maxLength: 300, required: true });
    if (reason.length < 4) throw new HttpError('Say why the order was cancelled. A supplier will ask, and the commitment was already recorded.', { status: 400, code: 'REASON_REQUIRED' });

    const owedNow = round2(Number((await db.first('SELECT COALESCE(SUM(amount),0) AS owed FROM creditor_ledger WHERE supplier_id = ? AND is_deleted = 0', [String(po.supplier_id)]) || {}).owed));
    const balanceAfter = round2(owedNow - Number(po.total));

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE purchase_orders SET status = 'CANCELLED', notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`,
        [`\n| Cancelled ${watNow()} by ${user.full_name || user.username}: ${reason}`, id]);
      // Reverse the obligation with a ledger row rather than deleting the
      // original. Deleting it would leave no trace that the commitment was ever
      // made, and the supplier's statement would not reconcile to the books.
      tx.queue(`INSERT INTO creditor_ledger (
          id, branch_id, business_id, supplier_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?, 'ADJUSTMENT', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
        newId(), po.branch_id, po.business_id, po.supplier_id, id,
        -Number(po.total), balanceAfter, `Purchase order ${po.po_number} cancelled: ${reason}`, String(user.id),
      ]);
    });
    await recordFromCtx(ctx, { action: 'PO_CANCELLED', entityType: 'PURCHASE_ORDER', entityId: id, branchId: po.branch_id, businessId: po.business_id, before: { status: po.status, total: Number(po.total) }, after: { reason } });
    ctx.json({ ok: true, message: `Purchase order ${po.po_number} cancelled and ₦${Number(po.total).toLocaleString('en-NG')} released from the commitment to ${po.supplier_id ? 'the supplier' : 'the supplier'}.` });
  });

  /**
   * Receive goods against a PO.
   *
   * This writes the receipt line, creates the stock batch at the ACTUAL cost
   * (which may differ from the ordered cost — that difference is the whole point
   * of recording both), updates the product's weighted-average cost, and posts
   * the inventory movement to the ledger.
   */
  app.post(`${base}/purchase-orders/:id/receive`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can receive goods against a purchase order.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const po = await db.first('SELECT po.*, s.name AS supplier_name, s.tin AS supplier_tin, s.is_manufacturer FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ? AND po.is_deleted = 0', [id]);
    if (!po) throw new HttpError('That purchase order does not exist.', { status: 404, code: 'PO_NOT_FOUND' });
    if (po.status === 'CANCELLED') throw new HttpError('That purchase order was cancelled.', { status: 409, code: 'PO_CANCELLED' });
    if (po.status === 'RECEIVED') throw new HttpError('That purchase order is fully received.', { status: 409, code: 'PO_COMPLETE' });

    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [po.branch_id]);
    const business = await db.first('SELECT * FROM businesses WHERE id = ?', [po.business_id]);
    const rawReceipts = Array.isArray(body.receipts || body.items) ? (body.receipts || body.items) : [];
    if (!rawReceipts.length) throw new HttpError('Send the items being received, each with its item id and quantity.', { status: 400, code: 'EMPTY_RECEIPT' });

    const accountIds = await glService.loadAccountCodes(db, business.id);
    const owedNow = round2(Number((await db.first('SELECT COALESCE(SUM(amount),0) AS owed FROM creditor_ledger WHERE supplier_id = ? AND is_deleted = 0', [String(po.supplier_id)]) || {}).owed));
    const paidNow = numField(body.paid_now, { field: 'Amount paid', min: 0 });
    const onCreditNow = numField(body.on_credit, { field: 'Amount on credit', min: 0 });

    const plan = [];
    let receivedValue = 0;
    for (const r of rawReceipts) {
      const itemId = String(requireVal(r, 'item_id', 'Receipt line'));
      const item = await db.first('SELECT * FROM purchase_order_items WHERE id = ? AND purchase_order_id = ? AND is_deleted = 0', [itemId, id]);
      if (!item) throw new HttpError(`Receipt line for item ${itemId.slice(0, 8)} is not on this purchase order.`, { status: 404, code: 'PO_ITEM_NOT_FOUND' });
      const product = await db.first('SELECT * FROM products WHERE id = ?', [item.product_id]);
      const qtyBase = numField(requireVal(r, 'quantity_received', 'Received quantity'), { field: 'Quantity received', min: 0.0001, places: 4 });
      const outstanding = round2(Number(item.quantity_in_base) - Number(item.quantity_received));
      if (qtyBase > outstanding) {
        // Over-delivery happens, but it must be a deliberate decision: accepting
        // more than was ordered means paying for more than was budgeted, and the
        // supplier's invoice will not match the PO.
        if (!boolField(r.allow_over_receipt)) {
          throw new HttpError(
            `${product.name}: you are receiving ${qtyBase} ${product.base_unit_name} but only ${outstanding} remain outstanding on this order. If the supplier over-delivered, set allow_over_receipt on that line so the excess is visible.`,
            { status: 400, code: 'OVER_RECEIPT', fields: { quantity_received: `Maximum ${outstanding}` } },
          );
        }
      }
      const costPerUnit = numField(r.cost_per_unit ?? item.expected_unit_cost, { field: 'Cost per unit', min: 0, places: 6 });
      const freightPerUnit = numField(r.freight_per_unit, { field: 'Freight per unit', min: 0, places: 6 });
      const landed = round2((costPerUnit + freightPerUnit) * 1000000) / 1000000;
      const sellingPrice = numField(r.selling_price ?? product.selling_price, { field: 'Selling price', min: 0 });
      receivedValue = round2(receivedValue + qtyBase * landed);

      const units = await db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [item.product_id]);
      const ladder = buildLadder(units);
      const batches = await db.all(`SELECT quantity, cost_price_per_unit FROM stock_batches
          WHERE product_id = ? AND branch_id = ? AND is_deleted = 0`, [item.product_id, String(branch.id)]);
      const layers = [...batches.map((b) => ({ quantity: Number(b.quantity), cost: Number(b.cost_price_per_unit) })), { quantity: qtyBase, cost: landed }];
      const { weightedAverageCost } = require('../../domain/uom');
      const newAvg = weightedAverageCost(layers);

      // ===================================================================
      // SERIALS ARRIVE WITH THE GOODS ON A PURCHASE ORDER TOO
      // ===================================================================
      // This is the route a shop actually uses to buy appliances and phones — the direct
      // goods-received route is for a load that arrives with no paperwork. Serial capture
      // went into that one first, which left the ordinary path unable to register a unit:
      // the same dead end the feature was built to remove, one route over. Both routes now
      // call server/services/serialsService.js, so neither can drift.
      const accepted = await acceptSerials(db, {
        product, quantityBase: qtyBase,
        supplied: parseSerials(r.serials || r.serial_numbers || r.serial_no),
        featureOn: Boolean(settings) && Number(settings.serial_tracking_enabled) === 1,
        what: 'order',
      });
      const batchId = newId();
      plan.push({
        item, product, qtyBase, landed, costPerUnit, freightPerUnit, sellingPrice, newAvg, ladder, batchId,
        serialRows: await planSerialRows(db, accepted.serials, {
          branchId: String(branch.id), batchId, productId: String(item.product_id),
          variantId: item.variant_id || null, actorId: String(user.id),
          note: `Received on ${po.po_number} at ${branch.name}.`,
        }),
        serialWarnings: accepted.warnings,
        batchNo: strField(r.batch_no, { field: 'Batch number', maxLength: 60 }) || `${po.po_number}-${(plan.length + 1).toString().padStart(2, '0')}`,
        expiryDate: strField(r.expiry_date, { field: 'Expiry date', maxLength: 10 }),
      });
    }

    // Would every line be complete AFTER this receipt? Computed from the current
    // rows plus what is about to be added, because the transaction has not run
    // yet and the write phase may not await a read.
    const currentItems = await db.all('SELECT id, quantity_in_base, quantity_received FROM purchase_order_items WHERE purchase_order_id = ? AND is_deleted = 0', [id]);
    const addingByItem = new Map();
    for (const p of plan) addingByItem.set(String(p.item.id), (addingByItem.get(String(p.item.id)) || 0) + p.qtyBase);
    const fullyReceived = currentItems.every((i) =>
      Number(i.quantity_received) + (addingByItem.get(String(i.id)) || 0) >= Number(i.quantity_in_base) - 0.0001);

    await db.transaction(async (tx) => {
      for (const p of plan) {
        const receiptId = newId();
        tx.queue(`INSERT INTO purchase_order_receipts (
            id, purchase_order_id, purchase_order_item_id, quantity_received, batch_no, expiry_date,
            cost_per_unit, freight_per_unit, selling_price, received_by, received_at, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'), ?, datetime('now'), datetime('now'))`, [
          receiptId, id, String(p.item.id), p.qtyBase, p.batchNo, p.expiryDate,
          p.costPerUnit, p.freightPerUnit, p.sellingPrice, String(user.id),
          strField(body.notes, { field: 'Notes', maxLength: 300 }),
        ]);
        tx.queue(`UPDATE purchase_order_items SET quantity_received = quantity_received + ?, updated_at = datetime('now') WHERE id = ?`,
          [p.qtyBase, String(p.item.id)]);

        const batchId = p.batchId;
        tx.queue(`INSERT INTO stock_batches (
            id, branch_id, business_id, product_id, variant_id, batch_no, supplier_id, purchase_order_id,
            cost_price_per_unit, selling_price_per_unit, quantity, quantity_reserved, initial_quantity,
            expiry_date, received_at, received_by, status, warehouse_zone, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, 0, ?,?, datetime('now'), ?, 'ACTIVE', ?, ?, datetime('now'), datetime('now'))`, [
          batchId, String(branch.id), String(business.id), String(p.product.id), p.item.variant_id,
          p.batchNo, String(po.supplier_id), id, p.landed, p.sellingPrice, p.qtyBase, p.qtyBase,
          p.expiryDate, String(user.id),
          strField(body.warehouse_zone, { field: 'Warehouse zone', maxLength: 120 }),
          `Received on ${po.po_number}`,
        ]);
        if (p.newAvg != null) {
          tx.queue("UPDATE products SET cost_price = ?, updated_at = datetime('now') WHERE id = ?", [round2(p.newAvg), String(p.product.id)]);
        }
        if (p.serialRows && p.serialRows.length) serialStatements(tx, p.serialRows);
      }

      tx.queue(`UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ?`,
        [fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED', id]);

      for (const st of glService.postPurchaseReceiptStatements({
        businessId: String(business.id), branchId: String(branch.id), poId: id,
        items: plan.map((p) => ({ quantity_received: p.qtyBase, cost_per_unit: p.landed })),
        supplier: { id: po.supplier_id, name: po.supplier_name, tin: po.supplier_tin, is_manufacturer: Number(po.is_manufacturer) },
        paidNow,
        onCredit: onCreditNow,
        freightTotal: round2(plan.reduce((a, p) => a + p.qtyBase * p.freightPerUnit, 0)),
        user, accountIds,
      })) tx.queue(st.sql, st.params);

      if (paidNow > 0) {
        tx.queue(`INSERT INTO creditor_ledger (
            id, branch_id, business_id, supplier_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
          VALUES (?,?,?,?, 'PAYMENT', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
          newId(), String(branch.id), String(business.id), String(po.supplier_id), id,
          -paidNow, round2(owedNow - paidNow), `Payment against ${po.po_number}`, String(user.id),
        ]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'PO_RECEIVED', entityType: 'PURCHASE_ORDER', entityId: id, branchId: branch.id, businessId: business.id,
      after: { poNumber: po.po_number, lines: plan.length, receivedValue, fullyReceived },
    });
    const serialCount = plan.reduce((a, p) => a + ((p.serialRows || []).length), 0);
    ctx.json({
      ok: true,
      message: `${plan.length} line(s) received against ${po.po_number} — ₦${receivedValue.toLocaleString('en-NG')} of stock added at ${branch.name}.${fullyReceived ? ' The order is now complete.' : ' The order remains partly outstanding.'}`
        + (serialCount ? ` ${serialCount} serial number(s) filed, so each unit can be sold and its warranty proved.` : ''),
      receivedValue, fullyReceived, serialCount,
      serials: plan.flatMap((p) => (p.serialRows || []).map((r) => r.serialNo)),
      warnings: plan.flatMap((p) => p.serialWarnings || []),
      newStatus: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
    });
  }));

  // -------------------------------------------------------------------
  // CREDITORS
  // -------------------------------------------------------------------
  /** The creditor book: who the business owes, aged. */
  app.get(`${base}/creditors`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const biz = await readBusinessId(db, ctx);
    const asAt = strField(ctx.req.queryParam('as_at'), { field: 'As-at date', maxLength: 10 }) || watToday();
    const suppliers = await db.all(`SELECT s.id, s.name, s.phone, s.tin, s.is_manufacturer, s.credit_limit, s.payment_terms_days,
          (SELECT COALESCE(SUM(cl.amount),0) FROM creditor_ledger cl WHERE cl.supplier_id = s.id AND cl.is_deleted = 0) AS owed
        FROM suppliers s WHERE s.is_deleted = 0 ${biz ? 'AND (s.business_id = ? OR s.business_id IS NULL)' : ''}
        ORDER BY owed DESC, s.name LIMIT 500`, biz ? [biz] : []);
    const creditors = [];
    for (const sp of suppliers.filter((x) => Number(x.owed) !== 0)) {
      const entries = await db.all('SELECT * FROM creditor_ledger WHERE supplier_id = ? AND is_deleted = 0 ORDER BY created_at, id', [String(sp.id)]);
      creditors.push({
        ...sp,
        owed: round2(Number(sp.owed)),
        ageing: ageBalance(entries, { today: asAt }),
        overLimit: Number(sp.credit_limit) > 0 && Number(sp.owed) > Number(sp.credit_limit),
        manufacturer: Boolean(Number(sp.is_manufacturer)),
        // A manufacturer is exempt from the 2% supply-of-goods WHT. Shown here
        // because paying a manufacturer with WHT deducted creates a credit note
        // they will chase, and not deducting from a non-manufacturer is a penalty.
        whtExempt: Boolean(Number(sp.is_manufacturer)),
      });
    }
    const totalOwed = round2(creditors.reduce((a, c) => a + (c.owed > 0 ? c.owed : 0), 0));
    ctx.json({
      ok: true, asAt, creditors,
      summary: {
        creditorCount: creditors.filter((c) => c.owed > 0).length,
        totalOwed,
        totalOwedToUs: round2(creditors.filter((c) => c.owed < 0).reduce((a, c) => a - c.owed, 0)),
        overLimitCount: creditors.filter((c) => c.overLimit).length,
      },
    });
  });

  /** Pay a supplier. */
  app.post(`${base}/suppliers/:id/payments`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can pay a supplier.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const supplier = await db.first('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0', [id]);
    if (!supplier) throw new HttpError('That supplier does not exist.', { status: 404, code: 'SUPPLIER_NOT_FOUND' });

    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);
    const gross = numField(requireVal(body, 'amount'), { field: 'Amount', min: 0.01 });
    const method = valid(oneOf(body.method || body.payment_method || 'BANK_TRANSFER', ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'CHEQUE'], { field: 'Payment method' }), 'method');
    const reference = strField(requireVal(body, 'reference'), { field: 'Reference', maxLength: 80, required: true });
    if (reference.length < 3) {
      throw new HttpError('Enter the bank transfer reference or cheque number. A supplier payment with no reference cannot be matched to the statement, and an unmatched payment is indistinguishable from one that never happened.', { status: 400, code: 'REFERENCE_REQUIRED' });
    }

    // WHT is deducted from the GROSS and the net is what leaves the bank.
    // Getting this the other way round — paying gross and withholding nothing —
    // is the most common WHT failure, and it is the business's own liability.
    const whtCode = strField(body.wht_code, { field: 'WHT code', maxLength: 40 });
    let wht = null;
    if (whtCode) {
      wht = await resolveDeduction(db, { grossAmount: gross, rateCode: whtCode, direction: 'PAYABLE' });
    }
    const whtAmount = wht ? round2(wht.wht) : 0;
    const net = round2(gross - whtAmount);
    if (net <= 0) throw new HttpError('The withholding exceeds the payment, leaving nothing to pay.', { status: 400, code: 'WHT_EXCEEDS_PAYMENT' });

    const exemption = wht ? exemptionHint({ grossAmount: gross, counterpartyTin: supplier.tin, counterpartyIsManufacturer: Boolean(Number(supplier.is_manufacturer)) }) : null;
    if (wht && Number(supplier.is_manufacturer) && wht.rateCode === 'SUPPLY_OF_GOODS') {
      ctx.set('manufacturerWarning', `${supplier.name} is recorded as a MANUFACTURER, which is exempt from the 2% supply-of-goods WHT. You are withholding ₦${whtAmount.toLocaleString('en-NG')} anyway — confirm that is intended, or correct the supplier record.`);
    }

    const owedNow = round2(Number((await db.first('SELECT COALESCE(SUM(amount),0) AS owed FROM creditor_ledger WHERE supplier_id = ? AND is_deleted = 0', [id]) || {}).owed));
    const balanceAfter = round2(owedNow - gross);
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const ledgerId = newId();

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO creditor_ledger (
          id, branch_id, business_id, supplier_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?, 'PAYMENT', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
        ledgerId, String(branch.id), String(business.id), id,
        body.purchase_order_id ? String(body.purchase_order_id) : null,
        -gross, balanceAfter,
        `Payment to ${supplier.name} by ${method.replace(/_/g, ' ').toLowerCase()}, ref ${reference}${whtAmount > 0 ? ` (₦${whtAmount.toLocaleString('en-NG')} WHT withheld, net ₦${net.toLocaleString('en-NG')})` : ''}`,
        String(user.id),
      ]);
      if (whtAmount > 0) {
        tx.queue(`INSERT INTO wht_entries (
            id, branch_id, business_id, direction, source_type, source_id, rate_code, rate_percent,
            gross_amount, wht_amount, net_amount, supplier_id, counterparty_name, counterparty_tin,
            recorded_by, entry_date, notes, created_at, updated_at)
          VALUES (?,?,?, 'PAYABLE', 'SUPPLIER_PAYMENT', ?,?,?, ?,?,?, ?, ?, ?, ?, date('now'), ?, datetime('now'), datetime('now'))`, [
          newId(), String(branch.id), String(business.id), ledgerId,
          wht.rateCode, Number(wht.ratePercent), gross, whtAmount, net, id,
          supplier.name, supplier.tin, String(user.id),
          `Withheld on payment to ${supplier.name}, ref ${reference}`,
        ]);
      }
      // THE GROSS, NOT THE NET. This passed `net`, and the helper then subtracted the
      // withholding a SECOND time:
      //
      //   debit  payables  net            ← should have been the gross: the invoice
      //   credit WHT       wht               being discharged is the gross one
      //   credit bank      net - wht
      //
      // So on a ₦200,000 invoice with ₦4,000 withheld, the bank was credited ₦192,000
      // when ₦196,000 actually left it, and the supplier's account stayed ₦4,000 in
      // credit — a supplier who has been paid in full still looks owed money, and the
      // business pays them twice. The entry BALANCED (196,000 = 192,000 + 4,000), so the
      // trial balance reported nothing wrong; only reading the bank balance and the
      // supplier's account back catches it, which is what test/audit/audit.wht.js does.
      //
      // The helper was written for the gross all along — `value - wht` is the cash line.
      for (const st of glService.postCreditorPaymentStatements({
        businessId: String(business.id), branchId: String(branch.id), supplierId: id,
        supplierName: supplier.name, amount: gross, method, reference, whtAmount, accountIds, user,
      })) tx.queue(st.sql, st.params);
    });

    await recordFromCtx(ctx, {
      action: 'SUPPLIER_PAID', entityType: 'SUPPLIER', entityId: id, branchId: branch.id, businessId: business.id,
      before: { owed: owedNow }, after: { gross, net, whtAmount, whtCode: wht ? wht.rateCode : null, method, reference, balanceAfter },
    });
    ctx.json({
      ok: true, id: ledgerId,
      message: `Paid ${supplier.name} ₦${net.toLocaleString('en-NG')}${whtAmount > 0 ? ` net of ₦${whtAmount.toLocaleString('en-NG')} WHT (${wht.ratePercent}% ${wht.rateCode}), remittable to FIRS by the ${WHT_REMITTANCE_DAY_OF_MONTH}th` : ''}. ${balanceAfter > 0 ? `₦${balanceAfter.toLocaleString('en-NG')} still owed.` : 'Account settled.'}`,
      gross, net, whtAmount, balanceAfter,
      advisories: [exemption, ctx.get('manufacturerWarning')].filter(Boolean),
    }, 201);
  }));

  /** Bank position: what the ledger says is in each account. */
  app.get(`${base}/banking`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const codes = ['1000', '1010', '1020', '1030', '1040'];
    const accounts = [];
    for (const code of codes) {
      const accountId = accountIds.get(code);
      if (!accountId) continue;
      const row = await db.first(`SELECT a.code, a.name, COALESCE(SUM(l.debit - l.credit),0) AS balance
          FROM gl_accounts a
          LEFT JOIN gl_journal_lines l ON l.account_id = a.id AND l.is_deleted = 0
          LEFT JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.is_deleted = 0
          WHERE a.id = ? GROUP BY a.id`, [accountId]);
      if (row) accounts.push({ ...row, balance: round2(Number(row.balance)) });
    }
    const totalCash = round2(accounts.reduce((a, x) => a + x.balance, 0));
    const recent = await db.all(`SELECT e.entry_no, e.entry_date, e.source_type, e.description, e.total_debit, b.name AS branch_name
        FROM gl_journal_entries e LEFT JOIN branches b ON b.id = e.branch_id
        WHERE e.is_deleted = 0 AND e.business_id = ? AND e.source_type IN ('BANKING','DEBTOR_PAYMENT','SUPPLIER_PAYMENT','MANUAL')
        ORDER BY e.entry_date DESC, e.created_at DESC LIMIT 25`, [String(business.id)]);
    ctx.json({
      ok: true, accounts, totalCash, recent,
      message: `₦${totalCash.toLocaleString('en-NG')} across ${accounts.length} cash and bank account(s), per the ledger.`,
    });
  });
}

function requireVal(body, field, label) {
  const v = body[field];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new HttpError(`${(label ? `${label}: ` : '')}${field.replace(/_/g, ' ')} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: 'Required' } });
  }
  return v;
}

module.exports = { mount, PO_STATUSES };
