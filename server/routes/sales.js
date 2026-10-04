// =====================================================================
// StockRidge — SALES ROUTES: POS, quotes, returns, plans, layaway, delivery
// =====================================================================
// Every mutating route here goes through withIdempotency(). That is not
// decoration: the PWA queues sales offline and replays them, and on a Nigerian
// mobile network "the request succeeded but the response was lost" is not an
// edge case. Without an idempotency key a replay means double stock deduction
// and double cash counted.
// =====================================================================

const { createRouter, HttpError } = require('../lib/http');
const { withIdempotency } = require('../lib/idempotency');
const { watNowIso, watDate } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { assertRole, assertBranchAccess, resolveScopedBranchId } = require('../lib/roles');
const { getUnitSettings, staffAllowance, assertSubscribed } = require('../lib/planLimits');
const salesService = require('../services/salesService');
const instalmentService = require('../services/instalmentService');
const layawayService = require('../services/layawayService');
const deliveryService = require('../services/deliveryService');
const warrantyService = require('../services/warrantyService');
const pricingService = require('../services/pricingService');
const { capabilitiesOf, assertCapability } = require('../lib/capabilities');
const { writeAudit } = require('../lib/audit');

// ---------------------------------------------------------------------
// SALES / POS
// ---------------------------------------------------------------------
function saleRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    if (c.req.query('branch_id')) assertBranchAccess(c.var.user, c.req.query('branch_id'));
    const result = await salesService.listSales(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      customerId: c.req.query('customer_id') || null,
      status: c.req.query('status') || null,
      saleType: c.req.query('sale_type') || null,
      from: c.req.query('from') || c.req.query('start_date') || null,
      to: c.req.query('to') || c.req.query('end_date') || null,
      search: c.req.query('q') || c.req.query('search') || null,
      limit: c.req.query('limit'), offset: c.req.query('offset'),
      sort: c.req.query('sort'), dir: c.req.query('dir'),
    });
    return c.json(result);
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const sale = await salesService.getSale(db, { saleId: c.req.param('id'), businessUnitId: c.var.businessUnitId });
    if (!sale) throw new HttpError(404, 'That sale was not found.', 'SALE_NOT_FOUND');
    assertBranchAccess(c.var.user, sale.branch_id);
    // A cashier may read a sale THEY made, or any sale at their own branch, but
    // not another branch's — the original audit found a cross-branch read after
    // a customer record was reparented by a sync push.
    if (String(c.var.user.role).toUpperCase() === 'STAFF' && c.var.user.branch_id && sale.branch_id !== c.var.user.branch_id) {
      throw new HttpError(403, 'That sale belongs to another branch.', 'SALE_OTHER_BRANCH');
    }
    return c.json({
      ...sale,
      can_void: canVoid(c.var.user, sale),
      can_return: sale.status === 'COMPLETED' && ['ADMIN', 'OWNER', 'MANAGER'].includes(String(c.var.user.role).toUpperCase()),
    });
  });

  function canVoid(user, sale) {
    const role = String(user.role).toUpperCase();
    if (role === 'ADMIN' || role === 'OWNER') return sale.status === 'COMPLETED';
    if (role === 'MANAGER') return sale.status === 'COMPLETED';
    return sale.status === 'COMPLETED' && sale.sold_by === user.id;
  }

  // PRICE QUOTE — resolve a basket without committing it. The POS calls this on
  // every change so the cashier sees the tier price, the promotion and the
  // margin BEFORE checkout, not after.
  app.post('/quote', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const branchId = body.branch_id || c.var.user.branch_id;
    if (!branchId) throw new HttpError(400, 'Choose a branch.', 'BRANCH_REQUIRED');
    assertBranchAccess(c.var.user, branchId);
    const settings = c.var.businessUnit;
    const allowance = await staffAllowance(db, c.var.businessUnitId, c.var.user);
    const vatLib = require('../lib/vat');

    let customer = null;
    let tier = null;
    if (body.customer_id) {
      customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(body.customer_id).first();
      if (!customer) throw new HttpError(404, 'That customer was not found.', 'CUSTOMER_NOT_FOUND');
      if (customer.tier_id) tier = await db.prepare('SELECT * FROM price_tiers WHERE id = ?').bind(customer.tier_id).first();
    }

    const lines = [];
    let subtotal = 0;
    for (const raw of (Array.isArray(body.items) ? body.items : [])) {
      try {
        const resolved = await salesService.resolveSaleLine(db, { ...c.serviceCtx, businessUnit: settings }, {
          businessUnitId: c.var.businessUnitId, branchId, line: raw, index: lines.length,
          customer, customerId: body.customer_id, tier, tierId: tier ? tier.id : null,
          saleType: body.sale_type || 'RETAIL', allowance, settings,
          caps: capabilitiesOf(settings), promotionCode: raw.promotion_code || body.promotion_code || null,
        });
        subtotal = round2(subtotal + resolved.line_subtotal_after_line_discount);
        lines.push({
          product_id: resolved.product_id, product_name: resolved.product_name,
          is_service_line: resolved.is_service_line, service_type: resolved.service_type,
          unit_type: resolved.unit_type, quantity: resolved.quantity, quantity_base: resolved.quantity_base,
          pieces_per_unit: resolved.pieces_per_unit, base_unit: resolved.base_unit,
          unit_price: resolved.unit_price, line_subtotal: resolved.line_subtotal,
          line_total: resolved.line_total, price_source: resolved.price_source,
          unit_cost: resolved.unit_cost, gross_margin: resolved.gross_margin,
          gross_margin_percent: resolved.gross_margin_percent, below_cost: resolved.below_cost,
          tier_id: resolved.tier_id, promotion_id: resolved.promotion_id,
          serials_required: resolved.serial_ids ? resolved.serial_ids.length : 0,
          warranty_months: resolved.warranty_months || null,
          tax_code: resolved.tax_code,
        });
      } catch (e) {
        lines.push({ error: e.message, code: e.code, product_id: raw.product_id || null, line_index: lines.length });
      }
    }

    let discountAmount = 0;
    let discountPercent = 0;
    if (Number(body.discount_percent) > 0) {
      discountPercent = round2(Number(body.discount_percent));
      if (discountPercent > allowance.max_discount_percent) {
        lines.push({ warning: `A ${discountPercent}% discount is above your limit of ${allowance.max_discount_percent}%.`, code: 'DISCOUNT_OVER_LIMIT' });
      } else {
        discountAmount = round2((subtotal * discountPercent) / 100);
      }
    }
    const afterDiscount = round2(subtotal - discountAmount);
    const vatEnabled = vatLib.isVatEnabled(settings);
    const vatRate = vatLib.normaliseRate(settings.vat_rate_percent);
    const inclusive = vatLib.isVatInclusive(settings);
    const vatAmount = vatEnabled ? (inclusive ? vatLib.extractVat(afterDiscount, vatRate).vat : vatLib.addVat(afterDiscount, vatRate).vat) : 0;
    const total = round2(inclusive || !vatEnabled ? afterDiscount : afterDiscount + vatAmount);

    return c.json({
      branch_id: branchId,
      customer: customer ? { id: customer.id, full_name: customer.full_name, tier: tier ? tier.label : null, credit_enabled: !!customer.credit_enabled, credit_limit: round2(Number(customer.credit_limit) || 0), balance: null } : null,
      lines, subtotal, discount_percent: discountPercent, discount_amount: discountAmount,
      vat_enabled: vatEnabled, vat_rate_percent: vatRate, vat_inclusive: inclusive,
      vat_amount: vatAmount, taxable_amount: round2(afterDiscount - vatAmount), total,
      gross_margin: round2(lines.reduce((a, l) => a + (Number(l.gross_margin) || 0), 0)),
      allowance: {
        max_discount_percent: allowance.max_discount_percent, can_discount: allowance.can_discount,
        can_take_credit_sale: allowance.can_take_credit_sale, can_void_sales: allowance.can_void_sales,
        void_window_minutes: allowance.void_window_minutes,
      },
    });
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => {
      const result = await salesService.createSale(db, c.serviceCtx, body);
      return { status: 201, body: result };
    }, { required: false });
  });

  app.post('/:id/void', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => {
      const result = await salesService.voidSale(db, c.serviceCtx, { saleId: c.req.param('id'), reason: body.reason });
      return { status: 200, body: result };
    });
  });

  // -------------------------------------------------------------------
  // RETURNS
  // -------------------------------------------------------------------
  app.post('/:id/return', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'process a return' });
    const settings = c.var.businessUnit;
    const id = c.req.param('id');
    const sale = await salesService.getSale(db, { saleId: id, businessUnitId: c.var.businessUnitId });
    if (!sale) throw new HttpError(404, 'That sale was not found.', 'SALE_NOT_FOUND');
    assertBranchAccess(c.var.user, sale.branch_id);
    if (sale.status === 'VOIDED') throw new HttpError(409, 'A voided sale cannot be returned — it never happened. Returns and voids are different records for a reason.', 'SALE_ALREADY_VOIDED');
    if (sale.status === 'REFUNDED') throw new HttpError(409, 'That sale has already been fully refunded.', 'SALE_ALREADY_REFUNDED');

    const reason = String(body.reason || '').toUpperCase();
    if (!['DEFECTIVE', 'WRONG_ITEM', 'CUSTOMER_CHANGED_MIND', 'DAMAGED_IN_TRANSIT', 'WARRANTY_FAULT', 'PRICE_DISPUTE', 'OTHER'].includes(reason)) {
      throw new HttpError(400, 'Reason must be DEFECTIVE, WRONG_ITEM, CUSTOMER_CHANGED_MIND, DAMAGED_IN_TRANSIT, WARRANTY_FAULT, PRICE_DISPUTE or OTHER.', 'RETURN_REASON_INVALID');
    }
    if (!body.reason_detail || String(body.reason_detail).trim().length < 5) {
      throw new HttpError(400, 'Describe what is being returned and why in at least 5 characters. "Customer returned it" is not a reason — the reason determines whether the item is resalable, whether the supplier is liable, and whether this is a pattern.', 'RETURN_DETAIL_REQUIRED');
    }

    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new HttpError(400, 'Select what is being returned.', 'RETURN_EMPTY');

    const ts = watNowIso();
    const { newId } = require('../../shared/ids');
    const { PREFIXES, nextReference } = require('../lib/references');
    const branch = await db.prepare('SELECT code FROM branches WHERE id = ?').bind(sale.branch_id).first();
    const returnNo = (await nextReference(db, { businessUnitId: c.var.businessUnitId, prefix: PREFIXES.RETURN, branchCode: branch.code || '*', scope: 'YEAR' })).reference;
    const returnId = newId();
    const statements = [];
    let refundTotal = 0;
    const resolvedItems = [];

    for (const raw of items) {
      const saleItem = sale.items.find((it) => it.id === raw.sale_item_id);
      if (!saleItem) throw new HttpError(404, `Line ${raw.sale_item_id} is not on that sale.`, 'RETURN_ITEM_NOT_ON_SALE');
      const qty = Number(raw.quantity);
      if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, 'The return quantity must be more than zero.', 'RETURN_QUANTITY_INVALID');
      const alreadyReturned = Number(saleItem.refunded_quantity) || 0;
      if (qty + alreadyReturned > Number(saleItem.quantity_base) + 1e-6) {
        throw new HttpError(409,
          `You cannot return ${qty} of "${saleItem.product_name}" — only ${round2(Number(saleItem.quantity_base) - alreadyReturned)} remain unreturned on this line.`,
          'RETURN_EXCEEDS_QUANTITY');
      }
      const unitPrice = Number(saleItem.unit_price) || 0;
      const pieces = Number(saleItem.pieces_per_unit) || 1;
      const refund = round2((Number(saleItem.line_total) / Number(saleItem.quantity)) * qty);
      refundTotal = round2(refundTotal + refund);
      const condition = V2.oneOf(raw.condition || 'RESALABLE', ['RESALABLE', 'DAMAGED', 'DEFECTIVE', 'MISSING_PARTS', 'OPENED'], { field: 'Condition' });
      if (condition && condition.error) throw new HttpError(400, condition.error, 'VALIDATION_FAILED');

      resolvedItems.push({ sale_item_id: saleItem.id, product_id: saleItem.product_id, quantity: qty, refund, condition });
      statements.push(db.prepare(`
        INSERT INTO sale_return_items (
          id, sale_return_id, sale_item_id, business_unit_id, product_id, serial_id, quantity, unit_price,
          refund_amount, condition, notes, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(newId(), returnId, saleItem.id, c.var.businessUnitId, saleItem.product_id,
        raw.serial_id || null, qty, unitPrice, refund, condition,
        raw.notes ? String(raw.notes).slice(0, 500) : null, ts, ts));
      statements.push(db.prepare(`
        UPDATE sale_items SET is_refunded = 1, refunded_quantity = refunded_quantity + ?, refunded_amount = refunded_amount + ?, updated_at = ?
        WHERE id = ?
      `).bind(qty, refund, ts, saleItem.id));

      // RESTOCK only what is genuinely resalable, and only into the batch it
      // came from. Restocking a defective unit as sellable is how a returned
      // fault goes back out to the next customer.
      if (body.restock !== false && condition === 'RESALABLE' && !saleItem.is_service_line) {
        if (saleItem.stock_batch_id) {
          statements.push(db.prepare(`
            UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?,
              status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END, updated_at = ?
            WHERE id = ?
          `).bind(qty * pieces, ts, saleItem.stock_batch_id));
        }
        const stockService = require('../services/stockService');
        const pos = await stockService.position(db, { branchId: sale.branch_id, productId: saleItem.product_id });
        statements.push(db.prepare(`
          INSERT INTO stock_movements (
            id, business_unit_id, branch_id, product_id, stock_batch_id, direction, quantity, unit_cost,
            movement_type, source_type, source_id, reference, balance_after, reason, performed_by, device_id,
            occurred_at, created_at
          ) VALUES (?,?,?,?,?, 'IN', ?,?, 'SALE_RETURN', 'SALE_RETURN', ?,?,?, ?,?,?,?)
        `).bind(newId(), c.var.businessUnitId, sale.branch_id, saleItem.product_id, saleItem.stock_batch_id,
          qty * pieces, Number(saleItem.unit_cost) || 0, returnId, returnNo,
          round2(pos.on_hand + qty * pieces), `${condition} return: ${String(body.reason_detail).slice(0, 200)}`,
          c.var.user.id, c.var.deviceId || null, ts, ts));
      }
      // A returned serial goes back to RETURNED, and only becomes IN_STOCK if
      // it is resalable. A DEFECTIVE serial stays DEFECTIVE so it cannot be
      // sold again by accident.
      if (raw.serial_id) {
        statements.push(db.prepare(`UPDATE product_serials SET status = ?, updated_at = ? WHERE id = ? AND status = 'SOLD'`)
          .bind(condition === 'RESALABLE' ? 'IN_STOCK' : (condition === 'DEFECTIVE' ? 'DEFECTIVE' : 'RETURNED'), ts, raw.serial_id));
        if (condition === 'RESALABLE') {
          statements.push(db.prepare('UPDATE product_serials SET sale_id = NULL, sale_item_id = NULL, sold_at = NULL, branch_id = ? WHERE id = ?').bind(sale.branch_id, raw.serial_id));
        }
      }
    }

    const refundMethod = body.refund_method ? String(body.refund_method).toUpperCase() : null;
    if (refundMethod && !['CASH', 'BANK_TRANSFER', 'STORE_CREDIT', 'REPLACEMENT', 'POS_REVERSAL'].includes(refundMethod)) {
      throw new HttpError(400, 'Refund method must be CASH, BANK_TRANSFER, STORE_CREDIT, REPLACEMENT or POS_REVERSAL.', 'REFUND_METHOD_INVALID');
    }
    if (refundTotal > 0 && !refundMethod) {
      throw new HttpError(400, 'Choose how the customer is being refunded. A refund with no method is a refund nobody can prove was paid.', 'REFUND_METHOD_REQUIRED');
    }
    if (refundMethod === 'CASH' && refundTotal > 50000 && String(c.var.user.role).toUpperCase() === 'STAFF') {
      throw new HttpError(403, 'A cash refund above ₦50,000 needs a manager. Cash leaving the drawer is the one movement that cannot be reversed.', 'REFUND_AMOUNT_OVER_LIMIT');
    }

    statements.push(db.prepare(`
      INSERT INTO sale_returns (
        id, business_unit_id, original_sale_id, branch_id, return_no, reason, reason_detail, status,
        restock, restock_batch_id, refund_method, refund_amount, store_credit_amount,
        approved_by, approved_at, processed_by, processed_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?, 'COMPLETED', ?,?,?,?,?,?,?,?, ?,?,?)
    `).bind(returnId, c.var.businessUnitId, sale.id, sale.branch_id, returnNo, reason,
      String(body.reason_detail).slice(0, 1000), body.restock === false ? 0 : 1,
      body.restock_batch_id || null, refundMethod, refundTotal,
      refundMethod === 'STORE_CREDIT' ? refundTotal : 0,
      c.var.user.id, ts, c.var.user.id, ts, ts, ts));

    const fullyRefunded = sale.items.every((it) => resolvedItems.some((r) => r.sale_item_id === it.id)
      || Number(it.refunded_quantity) >= Number(it.quantity_base));
    statements.push(db.prepare('UPDATE sales SET status = ?, updated_at = ? WHERE id = ?')
      .bind(fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED', ts, sale.id));
    statements.push(db.prepare('UPDATE till_sessions SET return_count = return_count + 1, updated_at = ? WHERE id = ?')
      .bind(ts, sale.till_session_id));

    // Cash refunds reduce the drawer. Not doing this is how a till closes
    // short and a cashier is blamed for a refund they correctly processed.
    if (refundMethod === 'CASH' && sale.till_session_id) {
      const session = await db.prepare('SELECT status FROM till_sessions WHERE id = ?').bind(sale.till_session_id).first();
      if (session && session.status === 'OPEN') {
        statements.push(db.prepare(`
          UPDATE till_sessions SET expected_cash = MAX(0, expected_cash - ?), expected_total = MAX(0, expected_total - ?), updated_at = ? WHERE id = ?
        `).bind(refundTotal, refundTotal, ts, sale.till_session_id));
      }
    }
    // A credit refund reduces what the customer owes.
    if (refundMethod === 'STORE_CREDIT' && sale.customer_id) {
      const bal = await salesService.debtorBalance(db, { customerId: sale.customer_id, businessUnitId: c.var.businessUnitId });
      statements.push(db.prepare(`
        INSERT INTO debtor_ledger (
          id, business_unit_id, branch_id, customer_id, entry_date, entry_type, source_type, source_id,
          reference, amount, balance_after, notes, created_by, created_at, updated_at
        ) VALUES (?,?,?,?,?, 'REFUND', 'SALE_RETURN', ?,?,?,?, ?,?,?,?)
      `).bind(newId(), c.var.businessUnitId, sale.branch_id, sale.customer_id, watDate(), returnId, returnNo,
        -refundTotal, round2(bal - refundTotal), `Refund on ${sale.receipt_no}: ${reason}`, c.var.user.id, ts, ts));
    }

    await db.batch(statements);

    if (capabilitiesOf(settings).general_ledger && settings.gl_module_enabled !== 0) {
      try {
        const glService = require('../services/glService');
        const lines = [
          { account_code: '4910', debit: refundTotal, credit: 0, description: `Return ${returnNo}` },
          { account_code: refundMethod === 'CASH' ? '1000' : (refundMethod === 'STORE_CREDIT' ? '1200' : '1020'), debit: 0, credit: refundTotal, description: `Refunded ${returnNo}` },
        ];
        const restockedValue = resolvedItems.filter((r) => r.condition === 'RESALABLE').reduce((a, r) => {
          const si = sale.items.find((x) => x.id === r.sale_item_id);
          return a + (Number(si ? si.unit_cost : 0) * r.quantity * Number(si ? si.pieces_per_unit : 1));
        }, 0);
        if (restockedValue > 0.004) {
          lines.push({ account_code: '1100', debit: round2(restockedValue), credit: 0, description: `Restocked ${returnNo}` });
          lines.push({ account_code: '5000', debit: 0, credit: round2(restockedValue), description: `COGS reversed ${returnNo}` });
        }
        await glService.postEntry(db, {
          businessUnitId: c.var.businessUnitId, branchId: sale.branch_id, entryDate: watDate(),
          sourceType: 'SALE_RETURN', sourceId: returnId, reference: returnNo,
          description: `Return ${returnNo} against ${sale.receipt_no}`, lines, userId: c.var.user.id,
        });
      } catch (e) { console.error('[sales] return GL posting failed:', e && e.message); }
    }

    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId: sale.branch_id, userId: c.var.user.id,
      actorRole: c.var.user.role, action: 'SALE_RETURNED', entityType: 'SALE_RETURN', entityId: returnId,
      amount: refundTotal, reason: `${reason}: ${String(body.reason_detail).slice(0, 300)}`,
      before: { sale_status: sale.status }, after: { return_no: returnNo, refund_method: refundMethod, restocked: body.restock !== false },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });

    return c.json({
      ok: true, id: returnId, return_no: returnNo, original_receipt_no: sale.receipt_no,
      refund_amount: refundTotal, refund_method: refundMethod, restocked: body.restock !== false,
      items: resolvedItems.length, sale_status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      advisory: refundMethod === 'STORE_CREDIT'
        ? `₦${refundTotal.toLocaleString('en-NG')} has been credited to ${sale.customer_name || 'the customer'}'s account, reducing what they owe.`
        : (resolvedItems.some((r) => r.condition !== 'RESALABLE')
          ? `${resolvedItems.filter((r) => r.condition !== 'RESALABLE').length} item(s) were not restocked because of their condition. Write them off as damage, or return them to the supplier under warranty.`
          : null),
    }, 201);
  });

  app.get('/:id/receipt', async (c) => {
    const db = getDb();
    const sale = await salesService.getSale(db, { saleId: c.req.param('id'), businessUnitId: c.var.businessUnitId });
    if (!sale) throw new HttpError(404, 'That sale was not found.', 'SALE_NOT_FOUND');
    assertBranchAccess(c.var.user, sale.branch_id);
    // The receipt payload is what the print view renders. It carries the
    // business's own legal identity (name, RC number, TIN, VAT number) because
    // FIRS expects those on a tax invoice and a receipt without them is not a
    // document an accounts department can book.
    return c.json({
      kind: sale.invoice_no ? 'TAX_INVOICE' : 'RECEIPT',
      sale,
      print: {
        business: {
          name: sale.business_name, legal_name: sale.business_legal_name, address: sale.business_address,
          phone: sale.business_phone, rc_number: sale.business_rc_number, tin: sale.business_tin,
          vat_registration_no: sale.vat_registration_no, vat_enabled: !!sale.vat_enabled,
          vat_rate_percent: Number(sale.vat_rate_percent) || 0,
        },
        branch: { name: sale.branch_name, address: sale.branch_address, phone: sale.branch_phone },
        lines: sale.items.map((it, i) => ({
          no: i + 1, description: it.product_name, sku: it.sku,
          quantity: `${it.quantity} × ${it.unit_type === 'BASE_UNIT' ? it.base_unit : it.unit_type.toLowerCase()}`,
          unit_price: round2(Number(it.unit_price)), line_total: round2(Number(it.line_total)),
          vat: round2(Number(it.vat_amount)), serials: it.serials || [],
        })),
        totals: {
          subtotal: round2(Number(sale.subtotal)), discount: round2(Number(sale.discount_amount)),
          vat: round2(Number(sale.vat_amount)), total: round2(Number(sale.total)),
          paid: round2(Number(sale.amount_paid)), balance_due: round2(Number(sale.balance_due)),
          change_given: round2(Number(sale.change_given)),
        },
        payments: sale.payments.map((p) => ({ method: p.method, amount: round2(Number(p.amount)), reference: p.reference })),
        change_owed: sale.change_owed || null,
        warranty_lines: sale.items.filter((it) => it.warranty_ids_json).map((it) => ({ product: it.product_name, serials: it.serials })),
        delivery: sale.delivery,
        footer: 'Thank you for your custom. Goods remain the property of the seller until paid for in full.',
      },
    });
  });

  return app;
}

// Local alias so the return route reads the same as every other validator.
const V2 = require('../../shared/validation');

// ---------------------------------------------------------------------
// INSTALMENT PLANS
// ---------------------------------------------------------------------
function planRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const results = await instalmentService.list(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      customerId: c.req.query('customer_id') || null,
      status: c.req.query('status') || null,
      overdueOnly: c.req.query('overdue') === '1',
      limit: c.req.query('limit'), offset: c.req.query('offset'),
    });
    const totals = await db.prepare(`
      SELECT status, COUNT(*) AS n, COALESCE(SUM(balance_due),0) AS outstanding, COALESCE(SUM(amount_paid),0) AS collected
      FROM payment_plans WHERE business_unit_id = ? AND is_deleted = 0 GROUP BY status
    `).bind(c.var.businessUnitId).all();
    return c.json({
      results,
      totals: Object.fromEntries(totals.results.map((r) => [r.status, { count: r.n, outstanding: round2(r.outstanding), collected: round2(r.collected) }])),
    });
  });

  app.get('/collections-queue', async (c) => {
    const db = getDb();
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER', 'STAFF'], { action: 'view the collections queue' });
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    return c.json(await instalmentService.collectionsQueue(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      daysAhead: c.req.query('days_ahead') || 7, limit: c.req.query('limit') || 100,
    }));
  });

  // Preview a schedule before committing. The customer must be shown the
  // effective total BEFORE they sign — quoting a rate and letting them discover
  // the total is how a shop acquires a reputation.
  app.post('/preview', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const schedule = instalmentService.buildSchedule({
      principal: body.principal, depositAmount: body.deposit_amount || 0,
      interestPercent: body.interest_percent || 0, interestType: body.interest_type || 'NONE',
      instalmentCount: body.instalment_count, firstDueDate: body.first_due_date || watDate(),
      frequency: body.frequency || 'MONTHLY',
    });
    return c.json({
      schedule,
      customer_disclosure: {
        cash_price: schedule.principal,
        deposit: schedule.deposit_amount,
        amount_financed: schedule.financed_amount,
        interest_basis: schedule.interest_type,
        total_interest: schedule.interest_total,
        total_repayable: schedule.total_payable,
        instalments: schedule.instalment_count,
        typical_instalment: schedule.instalment_amount,
        effective_annual_percent: schedule.effective_annual_percent,
        statement: `Cash price ₦${schedule.principal.toLocaleString('en-NG')}. Deposit ₦${schedule.deposit_amount.toLocaleString('en-NG')}. `
          + `You repay ₦${schedule.total_payable.toLocaleString('en-NG')} in ${schedule.instalment_count} instalment(s) of about ₦${schedule.instalment_amount.toLocaleString('en-NG')}. `
          + `Total cost of credit ₦${schedule.interest_total.toLocaleString('en-NG')}${schedule.interest_type !== 'NONE' ? ` (${schedule.interest_type.toLowerCase()} basis).` : '.'}`,
      },
    });
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 201, body: await instalmentService.createPlan(db, c.serviceCtx, body),
    }));
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const plan = await instalmentService.getWithSchedule(db, c.req.param('id'), c.var.businessUnitId);
    if (!plan) throw new HttpError(404, 'That plan was not found.', 'PLAN_NOT_FOUND');
    assertBranchAccess(c.var.user, plan.branch_id);
    return c.json(plan);
  });

  app.post('/:id/activate', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 200, body: await instalmentService.activate(db, c.serviceCtx, { planId: c.req.param('id'), depositPayment: body.deposit_payment }),
    }));
  });

  app.post('/:id/payments', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 201, body: await instalmentService.recordPayment(db, c.serviceCtx, { planId: c.req.param('id'), ...body }),
    }));
  });

  app.post('/:id/default', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await instalmentService.markDefault(db, c.serviceCtx, { planId: c.req.param('id'), reason: body.reason }));
  });

  app.post('/:id/write-off', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await instalmentService.writeOff(db, c.serviceCtx, { planId: c.req.param('id'), reason: body.reason }));
  });

  return app;
}

// ---------------------------------------------------------------------
// LAYAWAY
// ---------------------------------------------------------------------
function layawayRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const results = await layawayService.list(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      customerId: c.req.query('customer_id') || null, status: c.req.query('status') || null,
      expiringWithinDays: c.req.query('expiring_within_days') || null,
      limit: c.req.query('limit'), offset: c.req.query('offset'),
    });
    const totals = await db.prepare(`
      SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_paid),0) AS held, COALESCE(SUM(balance_due),0) AS outstanding
      FROM layaway_holds WHERE business_unit_id = ? AND is_deleted = 0 GROUP BY status
    `).bind(c.var.businessUnitId).all();
    return c.json({
      results,
      totals: Object.fromEntries(totals.results.map((r) => [r.status, { count: r.n, deposits_held: round2(r.held), outstanding: round2(r.outstanding) }])),
      // Deposits held are a LIABILITY, not income. Displaying them as revenue
      // is the accounting error this note exists to prevent.
      note: 'Deposits held are a customer-deposit liability, not revenue. Revenue is recognised when the goods are collected.',
    });
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await layawayService.create(db, c.serviceCtx, body) }));
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const hold = await layawayService.getWithItems(db, c.req.param('id'), c.var.businessUnitId);
    if (!hold) throw new HttpError(404, 'That hold was not found.', 'LAYAWAY_NOT_FOUND');
    assertBranchAccess(c.var.user, hold.branch_id);
    return c.json(hold);
  });

  app.post('/:id/payments', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await layawayService.recordPayment(db, c.serviceCtx, { holdId: c.req.param('id'), ...body }) }));
  });

  app.post('/:id/complete', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 200, body: await layawayService.complete(db, c.serviceCtx, { holdId: c.req.param('id'), ...body }) }));
  });

  app.post('/:id/cancel', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 200, body: await layawayService.cancel(db, c.serviceCtx, { holdId: c.req.param('id'), ...body }) }));
  });

  return app;
}

// ---------------------------------------------------------------------
// DELIVERY & INSTALLATION
// ---------------------------------------------------------------------
function deliveryRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const results = await deliveryService.list(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      status: c.req.query('status') || null, jobType: c.req.query('job_type') || null,
      assignedTo: c.req.query('assigned_to') || null, priority: c.req.query('priority') || null,
      date: c.req.query('date') || null, fromDate: c.req.query('from') || null, toDate: c.req.query('to') || null,
      limit: c.req.query('limit'), offset: c.req.query('offset'),
    });
    return c.json({ results });
  });

  app.get('/run-sheet', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    return c.json(await deliveryService.runSheet(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped, date: c.req.query('date') || null,
    }));
  });

  app.get('/estimate-fee', async (c) => {
    const db = getDb();
    const items = c.req.queries('product_id').map((id) => ({ product_id: id }));
    const fee = await deliveryService.estimateFee(db, {
      businessUnitId: c.var.businessUnitId, branchId: c.req.query('branch_id') || c.var.user.branch_id,
      items, jobType: c.req.query('job_type') || 'DELIVERY',
    });
    return c.json({ fee, bands: deliveryService.DEFAULT_FEE_BANDS, note: 'Bands are defaults — set real rates per branch under Settings → Delivery.' });
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await deliveryService.create(db, c.serviceCtx, body) }));
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const job = await deliveryService.getWithItems(db, c.req.param('id'), c.var.businessUnitId);
    if (!job) throw new HttpError(404, 'That delivery job was not found.', 'DELIVERY_JOB_NOT_FOUND');
    assertBranchAccess(c.var.user, job.branch_id);
    return c.json({ ...job, allowed_transitions: deliveryService.TRANSITIONS[job.status] || [] });
  });

  app.post('/:id/assign', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await deliveryService.assign(db, c.serviceCtx, { jobId: c.req.param('id'), ...body }));
  });

  app.post('/:id/status', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 200,
      body: await deliveryService.transition(db, c.serviceCtx, { jobId: c.req.param('id'), toStatus: body.status, ...body }),
    }));
  });

  app.post('/:id/reschedule', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await deliveryService.reschedule(db, c.serviceCtx, { jobId: c.req.param('id'), newDate: body.new_date, newWindow: body.new_window, reason: body.reason }));
  });

  app.post('/:id/items/:itemId/installed', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await deliveryService.markItemInstalled(db, c.serviceCtx, {
      jobId: c.req.param('id'), jobItemId: c.req.param('itemId'),
      installed: body.installed !== false, note: body.note,
    }));
  });

  app.get('/vehicles', async (c) => {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT v.*, b.name AS branch_name,
        (SELECT COUNT(*) FROM delivery_jobs dj WHERE dj.vehicle_id = v.id AND dj.is_deleted = 0
           AND dj.status NOT IN ('COMPLETED','CANCELLED')) AS open_jobs
      FROM delivery_vehicles v LEFT JOIN branches b ON b.id = v.branch_id
      WHERE v.business_unit_id = ? AND v.is_deleted = 0 AND v.is_active = 1 ORDER BY v.plate_number
    `).bind(c.var.businessUnitId).all();
    return c.json({ results: rows.results });
  });

  app.post('/vehicles', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'add a delivery vehicle' });
    const db = getDb();
    const body = await c.req.json();
    const V = require('../../shared/validation');
    const plate = V.required(String(body.plate_number || '').trim().toUpperCase(), { field: 'Plate number', max: 20 });
    if (plate && plate.error) throw new HttpError(400, plate.error, 'VALIDATION_FAILED');
    const type = V.oneOf(body.vehicle_type || 'VAN', ['BIKE', 'KEKE', 'CAR', 'PICKUP', 'VAN', 'TRUCK', 'FLATBED', 'THIRD_PARTY'], { field: 'Vehicle type' });
    if (type && type.error) throw new HttpError(400, type.error, 'VALIDATION_FAILED');
    const clash = await db.prepare('SELECT id FROM delivery_vehicles WHERE business_unit_id = ? AND plate_number = ? AND is_deleted = 0').bind(c.var.businessUnitId, plate).first();
    if (clash) throw new HttpError(409, `Plate ${plate} is already registered.`, 'VEHICLE_PLATE_EXISTS');
    const branchId = body.branch_id || c.var.user.branch_id || null;
    if (branchId) assertBranchAccess(c.var.user, branchId);
    const ts = watNowIso();
    const id = require('../../shared/ids').newId();
    await db.prepare(`
      INSERT INTO delivery_vehicles (
        id, business_unit_id, branch_id, plate_number, vehicle_type, capacity_kg, capacity_volume_m3,
        driver_name, driver_phone, is_third_party, cost_per_trip, cost_per_km, is_active, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, 1,?,?)
    `).bind(id, c.var.businessUnitId, branchId, plate, type,
      body.capacity_kg != null ? Number(body.capacity_kg) : null,
      body.capacity_volume_m3 != null ? Number(body.capacity_volume_m3) : null,
      body.driver_name ? String(body.driver_name).slice(0, 160) : null,
      body.driver_phone ? String(body.driver_phone).slice(0, 20) : null,
      body.is_third_party ? 1 : 0,
      round2(Math.max(0, Number(body.cost_per_trip) || 0)), round2(Math.max(0, Number(body.cost_per_km) || 0)), ts, ts).run();
    return c.json({ ok: true, id, plate_number: plate, vehicle_type: type }, 201);
  });

  return app;
}

// ---------------------------------------------------------------------
// WARRANTY
// ---------------------------------------------------------------------
function warrantyRoutes(getDb) {
  const app = createRouter();

  app.get('/lookup', async (c) => {
    const db = getDb();
    const results = await warrantyService.lookup(db, c.serviceCtx, {
      serialNo: c.req.query('serial') || c.req.query('imei') || null,
      phone: c.req.query('phone') || null,
      receiptNo: c.req.query('receipt') || null,
      customerId: c.req.query('customer_id') || null,
    });
    return c.json({ results, count: results.length });
  });

  app.post('/register', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await warrantyService.register(db, c.serviceCtx, body), 201);
  });

  app.post('/:id/void', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await warrantyService.voidWarranty(db, c.serviceCtx, { warrantyId: c.req.param('id'), reason: body.reason }));
  });

  app.get('/claims', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const results = await warrantyService.listClaims(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      status: c.req.query('status') || null, outcome: c.req.query('outcome') || null,
      customerId: c.req.query('customer_id') || null,
      from: c.req.query('from') || null, to: c.req.query('to') || null,
      limit: c.req.query('limit'), offset: c.req.query('offset'),
    });
    return c.json({ results });
  });

  app.post('/claims', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await warrantyService.logClaim(db, c.serviceCtx, body), 201);
  });

  app.post('/claims/:id/assess', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await warrantyService.assessClaim(db, c.serviceCtx, { claimId: c.req.param('id'), ...body }));
  });

  app.post('/claims/:id/replace', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await warrantyService.replaceItem(db, c.serviceCtx, { claimId: c.req.param('id'), ...body }));
  });

  app.get('/claim-rates', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view warranty claim rates' });
    const db = getDb();
    const results = await warrantyService.claimRateReport(db, {
      businessUnitId: c.var.businessUnitId, branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      startDate: c.req.query('from') || watDate(), endDate: c.req.query('to') || watDate(),
      minUnitsSold: c.req.query('min_units') || 10,
    });
    return c.json({
      results,
      note: 'Claim rate matters more than claim count: a best-selling model always has the most claims in absolute terms. A high rate driven by customer fault (misuse, water, drops) is a product-education problem; a high rate driven by manufacturing fault is a supplier problem.',
    });
  });

  app.get('/expiring', async (c) => {
    const db = getDb();
    return c.json(await warrantyService.expiringCover(db, {
      businessUnitId: c.var.businessUnitId, branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      daysAhead: c.req.query('days') || 60, limit: c.req.query('limit') || 200,
    }));
  });

  return app;
}

module.exports = { saleRoutes, planRoutes, layawayRoutes, deliveryRoutes, warrantyRoutes };
'use strict';
