'use strict';
// =====================================================================
// server/routes/stock.js — EVERYTHING THAT MOVES STOCK
// =====================================================================
// FOUR WAYS STOCK CHANGES, and no others:
//
//   RECEIVE   goods in from a supplier (or a production run)
//   SELL      goods out to a customer        -> server/routes/sales.js
//   ADJUST    a correction: damage, theft, expiry, a stocktake variance
//   TRANSFER  the same goods moving between branches or businesses
//
// Every one of them writes a batch-level row, posts a general-ledger entry and
// records an audit entry in the SAME transaction. That is not ceremony: stock is
// the asset a shop actually holds, and an unexplained movement in it is either
// shrinkage or a bug. Without the ledger leg, "where did ₦400,000 of cement go?"
// has no answer; without the audit leg, "who moved it?" has no answer.
//
// STOCK IS ONLY EVER IN BASE UNITS. A receiving clerk books 20 cartons; the
// batch stores 960 pieces. Storing "20 cartons" would make the on-hand figure
// meaningless the moment somebody sells a single piece.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
// `valid` was missing from this list while POST /api/stock/adjust called it at
// the adjustment-type line, so every stock adjustment — the write-off that
// records a broken TV — answered 500 "valid is not defined".
const { resolveBranch, resolveBusiness, scopeFilter, pagination, listResponse, requireField, numField, strField, boolField, dateRange, valid } = require('../lib/respond');
const { toBaseUnits, buildLadder, validateLadder, weightedAverageCost } = require('../../domain/uom');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday, addDays, watToUtc } = require('../../domain/time');
const { canAdjustStock } = require('../../domain/planLimits');
const { oneOf } = require('../../domain/validation');
const glService = require('../services/glService');

const ADJUSTMENT_TYPES = ['DAMAGE', 'THEFT', 'EXPIRED', 'COUNT_VARIANCE', 'SAMPLE', 'SHRINKAGE', 'FOUND', 'RETURN_TO_SUPPLIER', 'WRITE_OFF', 'OTHER'];

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // STOCK ON HAND
  // -------------------------------------------------------------------
  /**
   * Stock at a branch, grouped by product.
   *
   * `on_shelf`, `reserved` and `available` are reported separately and never
   * collapsed into one number. "We have 10" and "we can sell 10" are different
   * statements whenever a layaway or an open delivery job is holding units, and a
   * cashier who is told the first will sell the second.
   */
  app.get(`${base}/stock`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const branch = await resolveBranch(db, ctx);
    const { limit, offset } = pagination(ctx);
    const search = (ctx.req.queryParam('q') || '').trim();
    const filter = ctx.req.queryParam('filter'); // low | out | expiring | quarantined | overstock
    const settings = ctx.get('settings');

    const where = ['sb.branch_id = ?', 'sb.is_deleted = 0'];
    const params = [String(branch.id)];
    if (filter === 'quarantined') where.push("sb.status = 'QUARANTINED'");
    else where.push("sb.status NOT IN ('QUARANTINED','EXPIRED')");
    if (search) { where.push('(p.name LIKE ? OR p.sku LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

    const rows = await db.all(`
      SELECT p.id AS product_id, ? AS branch_id, p.sku, p.name, p.base_unit_name, p.reorder_level, p.selling_price,
             p.cost_price AS book_cost, p.requires_serial, p.tracks_variants, p.has_expiry,
             c.name AS category_name,
             COALESCE(SUM(sb.quantity), 0) AS on_shelf,
             COALESCE(SUM(sb.quantity_reserved), 0) AS reserved,
             COALESCE(SUM(sb.quantity - sb.quantity_reserved), 0) AS available,
             COALESCE(SUM(sb.quantity * sb.cost_price_per_unit), 0) AS stock_value,
             COUNT(sb.id) AS batch_count,
             MIN(sb.expiry_date) AS next_expiry
      FROM stock_batches sb
      JOIN products p ON p.id = sb.product_id AND p.is_deleted = 0
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')}
      GROUP BY p.id
      HAVING 1 = 1
        ${filter === 'low' ? 'AND available <= p.reorder_level AND p.reorder_level > 0' : ''}
        ${filter === 'out' ? 'AND available <= 0' : ''}
        ${filter === 'overstock' ? 'AND p.reorder_level > 0 AND available > p.reorder_level * 4' : ''}
        ${filter === 'expiring' ? `AND next_expiry IS NOT NULL AND next_expiry <= date('now', '+${Number(settings.expiry_alert_days) || 60} days')` : ''}
      ORDER BY p.name
      LIMIT ? OFFSET ?`,
    // `branch_id` leads the projection so each row states WHICH branch the
    // numbers belong to. The offline client keys its mirror on it, and a stock
    // screenshot forwarded to a supplier is worthless if nobody can tell which
    // shop it came from.
    [String(branch.id), ...params, limit, offset]);

    ctx.json(listResponse(rows.map((r) => ({
      ...r,
      on_shelf: round2(Number(r.on_shelf)), reserved: round2(Number(r.reserved)),
      available: round2(Number(r.available)), stock_value: round2(Number(r.stock_value)),
      low_stock: Number(r.reorder_level) > 0 && Number(r.available) <= Number(r.reorder_level),
      out_of_stock: Number(r.available) <= 0,
      days_to_expiry: r.next_expiry ? Math.max(0, Math.round((Date.parse(r.next_expiry) - Date.parse(watToday())) / 86400000)) : null,
    })), { limit, offset }));
  });

  /** Batch-level detail for one product: what is on the shelf, at what cost, expiring when. */
  app.get(`${base}/stock/:productId/batches`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const branch = await resolveBranch(db, ctx);
    const productId = String(ctx.req.param('productId'));
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [productId]);
    if (!product) throw new HttpError('That product does not exist.', { status: 404, code: 'PRODUCT_NOT_FOUND' });

    const rows = await db.all(`SELECT sb.*, s.name AS supplier_name, v.name AS variant_name,
          (SELECT COUNT(*) FROM serial_numbers sn WHERE sn.batch_id = sb.id AND sn.is_deleted = 0) AS serial_count
        FROM stock_batches sb
        LEFT JOIN suppliers s ON s.id = sb.supplier_id
        LEFT JOIN product_variants v ON v.id = sb.variant_id
        WHERE sb.product_id = ? AND sb.branch_id = ? AND sb.is_deleted = 0
        ORDER BY sb.expiry_date IS NULL, sb.expiry_date, sb.received_at, sb.batch_no, sb.id`,
    [productId, String(branch.id)]);
    ctx.json({ ok: true, product, batches: rows });
  });

  /** Stock valuation across every branch the caller may see. The balance-sheet number. */
  app.get(`${base}/stock/valuation`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const where = ['sb.is_deleted = 0']; const params = [];
    const f = scopeFilter(scope, { alias: 'sb' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }
    const asAt = ctx.req.queryParam('as_at');

    const rows = await db.all(`
      SELECT b.id AS branch_id, b.name AS branch_name, b.code AS branch_code,
             COALESCE(SUM(sb.quantity), 0) AS units,
             COALESCE(SUM(sb.quantity * sb.cost_price_per_unit), 0) AS at_cost,
             COALESCE(SUM(sb.quantity * sb.selling_price_per_unit), 0) AS at_retail,
             COALESCE(SUM(sb.quantity_reserved), 0) AS reserved
      FROM branches b
      LEFT JOIN stock_batches sb ON sb.branch_id = b.id AND sb.is_deleted = 0
           AND sb.status NOT IN ('QUARANTINED','EXPIRED')
      WHERE b.is_deleted = 0 AND b.is_active = 1 ${f.sql ? `AND ${f.sql.replace(/\bsb\./g, 'sb.')}` : ''}
      GROUP BY b.id ORDER BY b.name`, params);

    const byCategory = await db.all(`
      SELECT c.name AS category_name, COALESCE(SUM(sb.quantity * sb.cost_price_per_unit),0) AS at_cost
      FROM stock_batches sb JOIN products p ON p.id = sb.product_id
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE sb.is_deleted = 0 AND sb.status NOT IN ('QUARANTINED','EXPIRED')
      GROUP BY c.id ORDER BY at_cost DESC LIMIT 20`, []);

    const totals = rows.reduce((a, r) => ({
      units: round2(a.units + Number(r.units)), at_cost: round2(a.at_cost + Number(r.at_cost)),
      at_retail: round2(a.at_retail + Number(r.at_retail)), reserved: round2(a.reserved + Number(r.reserved)),
    }), { units: 0, at_cost: 0, at_retail: 0, reserved: 0 });

    ctx.json({
      ok: true, asAt: asAt || watToday(), branches: rows, totals, byCategory,
      potentialMargin: round2(totals.at_retail - totals.at_cost),
    });
  });

  // -------------------------------------------------------------------
  // GOODS RECEIVED
  // -------------------------------------------------------------------
  /**
   * Receive stock. Creates a batch, updates the product's weighted-average cost
   * and posts the purchase to the ledger.
   *
   * COST IS STORED AT FULL PRECISION on the batch. Rounding a per-unit cost to
   * kobo at receipt time loses money on every large batch: ₦0.004 a unit across
   * 20,000 sachets is ₦80, and it compounds across a year of receipts. The
   * product's weighted average is rounded for DISPLAY only.
   */
  app.post(`${base}/stock/receive`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can receive stock. A goods receipt changes the cost basis of everything you sell, so it needs a signature behind it.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const productId = String(requireField(body, 'product_id', 'Product'));
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [productId]);
    if (!product) throw new HttpError('That product does not exist.', { status: 404, code: 'PRODUCT_NOT_FOUND' });

    const units = await db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [productId]);
    const ladderResult = buildLadder(units);
    if (!ladderResult.ok) throw new HttpError(ladderResult.error, { status: 400, code: ladderResult.code });

    const unitCode = String(body.unit_code || ladderResult.defaultSell.code).toUpperCase();
    const qtyIn = numField(requireField(body, 'quantity', 'Quantity'), { field: 'Quantity', min: 0.0001, places: 4 });
    const conversion = toBaseUnits({ quantity: qtyIn, unitCode, ladder: ladderResult.ladder });
    if (!conversion.ok) throw new HttpError(conversion.error, { status: 400, code: conversion.code, fields: { quantity: conversion.error } });
    const quantityBase = conversion.baseQuantity;

    // Cost is PER THE UNIT BEING RECEIVED, then converted to per-base. A clerk
    // books "₦480,000 for 20 cartons"; storing that as a per-piece cost would
    // overstate cost by the carton factor and invert the margin.
    // `cost_price_per_unit` was the name the receiving FORM sent, and this endpoint
    // never read it — so "Cost price is required" was the answer to every attempt to
    // receive stock from the screen. The form now sends `cost_price` like every
    // other client; both names are accepted so a payload already written elsewhere
    // does not turn into a lost receipt.
    const costField = body.cost_price != null ? body.cost_price : body.cost_price_per_unit;
    const costPerReceivedUnit = numField(requireField({ cost_price: costField }, 'cost_price', 'Cost price'), { field: 'Cost price', min: 0, places: 6 });
    const costPerBase = round2((costPerReceivedUnit * conversion.factor) / conversion.factor) === costPerReceivedUnit
      ? costPerReceivedUnit / Number(conversion.factor || 1)
      : costPerReceivedUnit / Number(conversion.factor || 1);
    const sellingPerBase = body.selling_price != null
      ? numField(body.selling_price, { field: 'Selling price', min: 0 }) / Number(conversion.factor || 1)
      : Number(product.selling_price) || round2(costPerBase * 1.3);

    const supplierId = body.supplier_id ? String(body.supplier_id) : null;
    if (supplierId) {
      const supplier = await db.first('SELECT id FROM suppliers WHERE id = ? AND is_deleted = 0', [supplierId]);
      if (!supplier) throw new HttpError('That supplier does not exist.', { status: 404, code: 'SUPPLIER_NOT_FOUND' });
    }

    // Freight is entered per RECEIVED unit on the form and converted below, because
    // "₦30,000 clearing on twenty cartons" is how the cost actually arrives.
    const freight = numField(body.freight_cost != null ? body.freight_cost : body.freight_per_unit,
      { field: 'Freight', min: 0 });
    const paidNow = numField(body.paid_now, { field: 'Amount paid', min: 0 });
    const onCredit = numField(body.on_credit, { field: 'Amount on credit', min: 0 });
    const expiryDate = body.expiry_date ? strField(body.expiry_date, { field: 'Expiry date', maxLength: 10 }) : null;
    if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      throw new HttpError('The expiry date must be YYYY-MM-DD.', { status: 400, code: 'INVALID_DATE', fields: { expiry_date: 'YYYY-MM-DD' } });
    }
    if (expiryDate && expiryDate <= watToday()) {
      // Receiving already-expired stock is either a data-entry mistake or a
      // decision somebody should make deliberately, not by accident.
      throw new HttpError(`That expiry date (${expiryDate}) is today or already past. If the stock is genuinely expired, receive it and quarantine it so the decision is on the record.`, { status: 400, code: 'EXPIRED_ON_RECEIPT' });
    }

    const batchId = newId();
    const receivedAt = body.received_at ? String(body.received_at) : watToUtc(watNow());
    const accountIds = await glService.loadAccountCodes(db, business.id);

    // ---- EVERY READ HAPPENS HERE, before the transaction.
    // The write phase may only queue statements: better-sqlite3 is fully
    // synchronous and cannot span a microtask, and D1 has no interactive
    // transaction at all, so an `await db.first()` inside the transaction either
    // deadlocks or silently never runs.
    const heldBatches = await db.all('SELECT quantity, cost_price_per_unit FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0 AND id <> ?',
      [productId, String(branch.id), batchId]);
    const supplier = supplierId ? await db.first('SELECT * FROM suppliers WHERE id = ?', [supplierId]) : null;

    // Freight and clearing are CAPITALISED into the batch cost rather than
    // expensed. They are part of what it cost to get the goods to the shelf, and
    // expensing them overstates this month's costs while understating the margin
    // on the goods they were spent on.
    const freightPerBase = quantityBase > 0 ? freight / quantityBase : 0;
    const landedCostPerBase = round2((costPerBase + freightPerBase) * 1000000) / 1000000;

    // Weighted-average cost across everything already on hand plus this receipt.
    const newAvgCost = weightedAverageCost([
      ...heldBatches.map((h) => ({ quantity: Number(h.quantity), cost: Number(h.cost_price_per_unit) })),
      { quantity: quantityBase, cost: landedCostPerBase },
    ]);

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO stock_batches (
          id, branch_id, business_id, product_id, variant_id, batch_no, supplier_id, purchase_order_id,
          cost_price_per_unit, selling_price_per_unit, quantity, quantity_reserved, initial_quantity,
          manufacture_date, expiry_date, received_at, received_by, status, warehouse_zone, notes,
          created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?, 'ACTIVE',?,?, datetime('now'), datetime('now'))`, [
        batchId, String(branch.id), String(business.id), productId,
        body.variant_id ? String(body.variant_id) : null,
        strField(body.batch_no, { field: 'Batch number', maxLength: 60 }) || `GRN-${Date.now().toString(36).toUpperCase()}`,
        supplierId, body.purchase_order_id ? String(body.purchase_order_id) : null,
        landedCostPerBase, round2(sellingPerBase), quantityBase, quantityBase,
        strField(body.manufacture_date, { field: 'Manufacture date', maxLength: 10 }),
        expiryDate, receivedAt, String(user.id),
        strField(body.warehouse_zone, { field: 'Warehouse zone', maxLength: 120 }),
        strField(body.notes, { field: 'Notes', maxLength: 500 }),
      ]);

      // The weighted average was computed BEFORE the transaction from the batches
      // already on hand. It is what `products.cost_price` means, and maintaining
      // it here rather than in a nightly job keeps the margin on the next sale
      // correct immediately.
      if (newAvgCost != null) {
        tx.queue("UPDATE products SET cost_price = ?, updated_at = datetime('now') WHERE id = ?", [round2(newAvgCost), productId]);
      }

      // Quarantine on arrival when asked: a failed goods-received inspection must
      // not reach the shelf, but it must still be counted.
      if (boolField(body.quarantine)) {
        tx.queue("UPDATE stock_batches SET status = 'QUARANTINED', updated_at = datetime('now') WHERE id = ?", [batchId]);
      }

      const grossValue = round2(quantityBase * landedCostPerBase);
      for (const st of glService.postPurchaseReceiptStatements({
        businessId: business.id, branchId: branch.id, poId: body.purchase_order_id || batchId,
        items: [{ quantity_received: quantityBase, cost_per_unit: landedCostPerBase }],
        supplier, paidNow, onCredit: onCredit || Math.max(0, grossValue - paidNow),
        freightTotal: freight, user, accountIds,
      })) tx.queue(st.sql, st.params);
    });

    await recordFromCtx(ctx, {
      action: 'PO_RECEIVED', entityType: 'STOCK_BATCH', entityId: batchId, branchId: branch.id, businessId: business.id,
      after: { product: product.name, quantityBase, unitCode, costPerBase: landedCostPerBase, freight, expiryDate },
    });

    ctx.json({
      ok: true, batchId,
      message: `Received ${qtyIn} ${unitCode.toLowerCase()} of ${product.name} (${round2(quantityBase)} ${product.base_unit_name}) at ₦${landedCostPerBase.toLocaleString('en-NG', { maximumFractionDigits: 4 })} each.`,
      quantityBase, landedCostPerBase,
      warnings: freight > 0 && quantityBase === 0 ? ['Freight was charged but no quantity was received, so it could not be allocated.'] : [],
    }, 201);
  });

  // -------------------------------------------------------------------
  // ADJUSTMENTS
  // -------------------------------------------------------------------
  /**
   * Adjust stock: damage, theft, expiry, a found item, a return to supplier.
   *
   * THE GUARDRAILS ARE THE FEATURE. A cashier who can write off unlimited stock
   * has found the second classic retail theft pattern (take the goods, record
   * them as damaged). But a flat ban is wrong too — a broken bottle at a busy
   * counter has to be dealt with by the person holding it. So STAFF get an
   * OWNER-set allowance in units and in value; above it, a manager must act.
   */
  app.post(`${base}/stock/adjust`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const adjustmentType = valid(oneOf(requireField(body, 'adjustment_type', 'Adjustment type'), ADJUSTMENT_TYPES, { field: 'Adjustment type' }), 'adjustment_type');
    const productId = String(requireField(body, 'product_id', 'Product'));
    const batchId = body.batch_id ? String(body.batch_id) : null;
    const reason = strField(body.reason, { field: 'Reason', maxLength: 500, required: true });
    if (reason.length < 4) {
      throw new HttpError('Give a real reason. “Damage” alone cannot be reviewed three months later when the write-offs are being questioned.', { status: 400, code: 'REASON_REQUIRED', fields: { reason: 'At least four characters.' } });
    }

    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [productId]);
    if (!product) throw new HttpError('That product does not exist.', { status: 404, code: 'PRODUCT_NOT_FOUND' });

    // Resolve the batch: named, else the oldest with stock (FIFO), because a
    // write-off that lands on an arbitrary batch corrupts that batch's cost.
    let batch = null;
    if (batchId) {
      batch = await db.first('SELECT * FROM stock_batches WHERE id = ? AND product_id = ? AND branch_id = ? AND is_deleted = 0', [batchId, productId, String(branch.id)]);
      if (!batch) throw new HttpError('That batch does not exist at this branch.', { status: 404, code: 'BATCH_NOT_FOUND' });
    }

    const units = await db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [productId]);
    const ladderResult = buildLadder(units);
    const unitCode = String(body.unit_code || (ladderResult.ok ? ladderResult.base.code : 'PIECE')).toUpperCase();
    const signedQtyIn = numField(requireField(body, 'quantity', 'Quantity'), { field: 'Quantity', min: -1000000, max: 1000000, places: 4 });
    const conversion = toBaseUnits({ quantity: Math.abs(signedQtyIn), unitCode, ladder: ladderResult.ok ? ladderResult.ladder : [] });
    if (!conversion.ok) throw new HttpError(conversion.error, { status: 400, code: conversion.code });

    // Sign convention: FOUND adds, everything else removes. Accepting a sign from
    // the client would let a "damage" adjustment quietly add stock instead.
    const adds = adjustmentType === 'FOUND';
    const quantityBase = adds ? Math.abs(conversion.baseQuantity) : -Math.abs(conversion.baseQuantity);

    if (!batch && !adds) {
      batch = await db.first(`SELECT * FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0
          AND status = 'ACTIVE' AND quantity - quantity_reserved >= ?
        ORDER BY expiry_date IS NULL, expiry_date, received_at, batch_no, id LIMIT 1`,
      [productId, String(branch.id), Math.abs(quantityBase)]);
      if (!batch) throw new HttpError(`There is not enough unreserved stock of ${product.name} at ${branch.name} to write off ${Math.abs(conversion.baseQuantity)} ${product.base_unit_name}.`, { status: 409, code: 'INSUFFICIENT_STOCK' });
    }

    const unitCost = batch ? Number(batch.cost_price_per_unit) : Number(product.cost_price) || 0;
    const totalValue = round2(Math.abs(quantityBase) * unitCost);

    // ---- authority check, BEFORE any write
    const authority = canAdjustStock(settings, user, { quantityBase: Math.abs(quantityBase), value: totalValue });
    if (!authority.allowed) {
      throw new HttpError(
        `${authority.reason} Ask a manager to make this adjustment — the limit exists so that a write-off above it is a second person's decision.`,
        { status: 403, code: 'ADJUSTMENT_NOT_ALLOWED' },
      );
    }

    const id = newId();
    const accountIds = await glService.loadAccountCodes(db, business.id);

    await db.transaction(async (tx) => {
      if (!adds) {
        // Guarded: if a sale took this stock between the read and the write, the
        // update affects no rows and the commit fails rather than driving the
        // quantity negative.
        tx.queue(`UPDATE stock_batches SET quantity = quantity - ?, updated_at = datetime('now')
            WHERE id = ? AND is_deleted = 0 AND quantity - quantity_reserved >= ?`,
        [Math.abs(quantityBase), String(batch.id), Math.abs(quantityBase)]);
        tx.queue("UPDATE stock_batches SET status = CASE WHEN quantity <= 0 THEN 'DEPLETED' ELSE status END, updated_at = datetime('now') WHERE id = ?", [String(batch.id)]);
      } else {
        if (batch) {
          tx.queue("UPDATE stock_batches SET quantity = quantity + ?, initial_quantity = initial_quantity + ?, status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END, updated_at = datetime('now') WHERE id = ?",
            [Math.abs(quantityBase), Math.abs(quantityBase), String(batch.id)]);
        } else {
          // Found stock with no batch to return to gets its own, at the book
          // cost. Without a batch it would be sellable by count but invisible to
          // FIFO, expiry tracking and quarantine.
          tx.queue(`INSERT INTO stock_batches (
              id, branch_id, business_id, product_id, batch_no, cost_price_per_unit, selling_price_per_unit,
              quantity, quantity_reserved, initial_quantity, received_at, received_by, status, warehouse_zone, notes,
              created_at, updated_at)
            VALUES (?,?,?,?, 'FOUND', ?, ?, ?, 0, ?, ?, ?, 'ACTIVE', 'Recovered', 'Stock found during a count', datetime('now'), datetime('now'))`, [
            newId(), String(branch.id), String(business.id), productId,
            unitCost, Number(product.selling_price) || 0, Math.abs(quantityBase), Math.abs(quantityBase),
            watToUtc(watNow()), String(user.id),
          ]);
        }
      }

      tx.queue(`INSERT INTO stock_adjustments (
          id, branch_id, business_id, batch_id, product_id, variant_id, adjustment_type,
          quantity, unit_cost, total_value, reason, requires_approval, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?, datetime('now'), datetime('now'))`, [
        id, String(branch.id), String(business.id), batch ? String(batch.id) : null, productId,
        body.variant_id ? String(body.variant_id) : (batch ? batch.variant_id : null),
        adjustmentType, quantityBase, unitCost, adds ? totalValue : -totalValue, reason, String(user.id),
      ]);

      for (const st of glService.postAdjustmentStatements({
        adjustment: { id, adjustment_type: adjustmentType, quantity: quantityBase, total_value: adds ? totalValue : -totalValue, reason },
        business: { id: business.id }, branch: { id: branch.id }, accountIds, user,
      })) tx.queue(st.sql, st.params);
    });

    await recordFromCtx(ctx, {
      action: 'STOCK_ADJUSTED', entityType: 'STOCK_ADJUSTMENT', entityId: id, branchId: branch.id, businessId: business.id,
      after: { product: product.name, type: adjustmentType, quantityBase, value: totalValue, reason },
    });

    ctx.json({
      ok: true, id,
      message: `${adds ? 'Added' : 'Wrote off'} ${Math.abs(round2(quantityBase))} ${product.base_unit_name} of ${product.name} as ${adjustmentType.replace(/_/g, ' ').toLowerCase()} (₦${totalValue.toLocaleString('en-NG')}).`,
      quantityBase, totalValue,
    }, 201);
  });

  app.get(`${base}/adjustments`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const where = ['a.is_deleted = 0', "date(a.created_at, '+1 hours') BETWEEN ? AND ?"];
    const params = [from, to];
    const f = scopeFilter(scope, { alias: 'a' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }
    const type = ctx.req.queryParam('type');
    if (type) { where.push('a.adjustment_type = ?'); params.push(String(type).toUpperCase()); }

    const rows = await db.all(`SELECT a.*, p.name AS product_name, p.sku, p.base_unit_name, b.name AS branch_name,
          u.full_name AS created_by_name
        FROM stock_adjustments a
        JOIN products p ON p.id = a.product_id
        LEFT JOIN branches b ON b.id = a.branch_id
        LEFT JOIN users u ON u.id = a.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM stock_adjustments a WHERE ${where.join(' AND ')}`, params);
    const byType = await db.all(`SELECT a.adjustment_type, COUNT(*) AS entries, SUM(ABS(a.total_value)) AS value
        FROM stock_adjustments a WHERE ${where.join(' AND ')} GROUP BY a.adjustment_type ORDER BY value DESC`, params);
    ctx.json({ ...listResponse(rows, { limit, offset }, total), byType });
  });

  // -------------------------------------------------------------------
  // QUARANTINE
  // -------------------------------------------------------------------
  /**
   * Quarantine or release a batch.
   *
   * Quarantined stock is COUNTED but NOT SELLABLE. That distinction is the whole
   * point: a failed inspection, a recall, or a customer return that has not been
   * checked yet must stay visible in the stock value while being impossible to
   * ring up.
   */
  app.post(`${base}/stock/batches/:id/quarantine`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can quarantine stock.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const id = String(ctx.req.param('id'));
    const batch = await db.first('SELECT * FROM stock_batches WHERE id = ? AND is_deleted = 0', [id]);
    if (!batch) throw new HttpError('That batch does not exist.', { status: 404, code: 'BATCH_NOT_FOUND' });
    const branch = await resolveBranch(db, ctx);
    if (String(batch.branch_id) !== String(branch.id)) throw new HttpError('That batch is at another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });

    const quarantine = body.release ? false : true;
    const reason = strField(body.reason, { field: 'Reason', maxLength: 500, required: quarantine });
    const nextStatus = quarantine ? 'QUARANTINED' : 'ACTIVE';

    await db.run(`UPDATE stock_batches SET status = ?, notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?`,
      [nextStatus, quarantine ? ` | Quarantined ${watNow()}: ${reason}` : ` | Released from quarantine ${watNow()}`, id]);
    await recordFromCtx(ctx, {
      action: 'BATCH_QUARANTINED', entityType: 'STOCK_BATCH', entityId: id, branchId: branch.id,
      before: { status: batch.status }, after: { status: nextStatus, reason },
    });
    ctx.json({ ok: true, message: quarantine ? `Batch ${batch.batch_no || id.slice(0, 8)} quarantined — it is counted but cannot be sold.` : `Batch ${batch.batch_no || id.slice(0, 8)} released back to sellable stock.` });
  });

  // -------------------------------------------------------------------
  // TRANSFERS
  // -------------------------------------------------------------------
  app.get(`${base}/transfers`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const status = ctx.req.queryParam('status');
    const where = ['t.is_deleted = 0']; const params = [];
    // A transfer is visible to EITHER end: the branch that sent it and the
    // branch that is waiting for it both need to see it. Scoping only to the
    // user's own branch would hide incoming stock from the receiver.
    if (!scope.allBranches && scope.branchIds) {
      const ids = [...scope.branchIds];
      where.push(`(t.from_branch_id IN (${ids.map(() => '?').join(',')}) OR t.to_branch_id IN (${ids.map(() => '?').join(',')}))`);
      params.push(...ids, ...ids);
    }
    if (status) { where.push('t.status = ?'); params.push(String(status).toUpperCase()); }
    const rows = await db.all(`SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name,
          fbm.name AS from_business_name, tbm.name AS to_business_name,
          u.full_name AS initiated_by_name,
          (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = t.id AND i.is_deleted = 0) AS item_count
        FROM stock_transfers t
        JOIN branches fb ON fb.id = t.from_branch_id
        JOIN branches tb ON tb.id = t.to_branch_id
        LEFT JOIN businesses fbm ON fbm.id = t.from_business_id
        LEFT JOIN businesses tbm ON tbm.id = t.to_business_id
        LEFT JOIN users u ON u.id = t.initiated_by
        WHERE ${where.join(' AND ')} ORDER BY t.initiated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    ctx.json(listResponse(rows, { limit, offset }));
  });

  /**
   * One transfer, with its lines.
   *
   * The list screen and the detail screen must agree: the receiving branch keys a
   * partial receipt by the ITEM ID, and those ids only exist in the database. A
   * client that tried to derive them from the list would post a receipt against
   * nothing — which is why this route exists rather than the view reusing the
   * list payload.
   */
  app.get(`${base}/transfers/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const id = String(ctx.req.param('id'));
    const transfer = await db.first(`SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name,
          fbm.name AS from_business_name, tbm.name AS to_business_name,
          u.full_name AS initiated_by_name, ru.full_name AS received_by_name
        FROM stock_transfers t
        LEFT JOIN branches fb ON fb.id = t.from_branch_id
        LEFT JOIN branches tb ON tb.id = t.to_branch_id
        LEFT JOIN businesses fbm ON fbm.id = t.from_business_id
        LEFT JOIN businesses tbm ON tbm.id = t.to_business_id
        LEFT JOIN users u ON u.id = t.initiated_by
        LEFT JOIN users ru ON ru.id = t.received_by
        WHERE t.id = ? AND t.is_deleted = 0`, [id]);
    if (!transfer) throw new HttpError('That transfer does not exist.', { status: 404, code: 'TRANSFER_NOT_FOUND' });

    // A transfer is visible to EITHER end, exactly as the list is. Scoping to the
    // user's own branch alone would hide an incoming transfer from the branch that
    // has to book it in.
    if (!scope.allBranches && scope.branchIds) {
      const ids = [...scope.branchIds].map(String);
      if (!ids.includes(String(transfer.from_branch_id)) && !ids.includes(String(transfer.to_branch_id))) {
        throw new HttpError('That transfer belongs to branches you cannot see.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
      }
    }

    const items = await db.all(`SELECT i.*, p.name AS product_name, p.sku, p.base_unit_name, v.name AS variant_name,
          b.batch_no, b.expiry_date
        FROM stock_transfer_items i
        LEFT JOIN products p ON p.id = i.product_id
        LEFT JOIN product_variants v ON v.id = i.variant_id
        LEFT JOIN stock_batches b ON b.id = i.batch_id
        WHERE i.transfer_id = ? AND i.is_deleted = 0
        ORDER BY p.name, i.id`, [id]);

    const sent = round2(items.reduce((a, i) => a + Number(i.quantity_sent_base || 0), 0));
    const received = round2(items.reduce((a, i) => a + Number(i.quantity_received || 0), 0));
    ctx.json({
      ok: true, transfer, items,
      summary: {
        lines: items.length,
        unitsSent: sent,
        unitsReceived: received,
        unitsOutstanding: round2(sent - received),
        // A shortfall is the number that matters: it is either still on the road
        // or it never left the sending branch's shelf, and only a human can say
        // which.
        shortfall: round2(items.filter((i) => i.quantity_received != null && Number(i.quantity_received) < Number(i.quantity_sent_base))
          .reduce((a, i) => a + (Number(i.quantity_sent_base) - Number(i.quantity_received)), 0)),
        disclosed: items.filter((i) => i.quantity_received != null && Number(i.quantity_received) < Number(i.quantity_sent_base)).length,
      },
    });
  });

  app.post(`${base}/transfers`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can move stock between branches.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const from = await resolveBranch(db, ctx, { param: 'from_branch_id' });
    const toBranchId = String(requireField(body, 'to_branch_id', 'Destination branch'));
    if (toBranchId === String(from.id)) throw new HttpError('A transfer needs two different branches.', { status: 400, code: 'SAME_BRANCH' });
    const to = await db.first('SELECT * FROM branches WHERE id = ? AND is_deleted = 0', [toBranchId]);
    if (!to) throw new HttpError('That destination branch does not exist.', { status: 404, code: 'BRANCH_NOT_FOUND' });

    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new HttpError('A transfer needs at least one item.', { status: 400, code: 'EMPTY_TRANSFER' });

    // INTER-COMPANY. Moving stock between two DIFFERENT businesses is a sale
    // between legal entities, not a relocation. It has to post a receivable and a
    // payable at transfer price, or the two businesses' margins silently
    // cross-subsidise each other and neither P&L is true.
    const intercompany = String(from.business_id) !== String(to.business_id);
    if (intercompany && !atLeast(user.role, 'OWNER')) {
      throw new HttpError('A transfer between two different businesses is a sale between legal entities and needs owner authority. It posts a receivable and a payable on both sets of books.', { status: 403, code: 'INTERCOMPANY_NEEDS_OWNER' });
    }

    const id = newId();
    const reference = strField(body.reference, { field: 'Reference', maxLength: 40 }) || `TRF-${Date.now().toString(36).toUpperCase()}`;
    const dupe = await db.first('SELECT id FROM stock_transfers WHERE reference = ? AND is_deleted = 0', [reference]);
    if (dupe) throw new HttpError(`A transfer with reference “${reference}” already exists.`, { status: 409, code: 'DUPLICATE_REFERENCE' });

    const resolved = [];
    for (const item of items) {
      const productId = String(requireField(item, 'product_id', 'Product'));
      const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [productId]);
      if (!product) throw new HttpError('One of the products in this transfer does not exist.', { status: 404, code: 'PRODUCT_NOT_FOUND' });
      const units = await db.all('SELECT * FROM product_units WHERE product_id = ? AND is_deleted = 0 ORDER BY quantity_in_base ASC', [productId]);
      const ladder = buildLadder(units);
      const unitCode = String(item.unit_code || (ladder.ok ? ladder.base.code : 'PIECE')).toUpperCase();
      const qty = numField(requireField(item, 'quantity', 'Quantity'), { field: 'Quantity', min: 0.0001, places: 4 });
      const conv = toBaseUnits({ quantity: qty, unitCode, ladder: ladder.ok ? ladder.ladder : [] });
      if (!conv.ok) throw new HttpError(conv.error, { status: 400, code: conv.code });

      const batch = item.batch_id
        ? await db.first('SELECT * FROM stock_batches WHERE id = ? AND product_id = ? AND branch_id = ? AND is_deleted = 0', [String(item.batch_id), productId, String(from.id)])
        : await db.first(`SELECT * FROM stock_batches WHERE product_id = ? AND branch_id = ? AND is_deleted = 0 AND status = 'ACTIVE'
              AND quantity - quantity_reserved >= ?
            ORDER BY expiry_date IS NULL, expiry_date, received_at, batch_no, id LIMIT 1`,
        [productId, String(from.id), conv.baseQuantity]);
      if (!batch) throw new HttpError(`There is not enough unreserved stock of ${product.name} at ${from.name} to transfer ${conv.baseQuantity} ${product.base_unit_name}.`, { status: 409, code: 'INSUFFICIENT_STOCK' });
      resolved.push({ productId, product, unitCode, quantitySent: qty, quantityBase: conv.baseQuantity, batch, variantId: item.variant_id ? String(item.variant_id) : batch.variant_id });
    }

    const markup = numField(body.intercompany_markup_pct, { field: 'Intercompany markup', min: 0, max: 100 });
    const accountIds = await glService.loadAccountCodes(db, from.business_id);
    const toAccountIds = intercompany ? await glService.loadAccountCodes(db, to.business_id) : accountIds;

    await db.transaction(async (tx) => {
      let transferValue = 0;
      tx.queue(`INSERT INTO stock_transfers (
          id, reference, from_branch_id, to_branch_id, from_business_id, to_business_id, is_intercompany,
          transfer_price, status, initiated_by, initiated_at, courier_name, courier_phone, vehicle_id, notes,
          created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?, 'IN_TRANSIT', ?, datetime('now'), ?,?,?,?, datetime('now'), datetime('now'))`, [
        id, reference, String(from.id), String(to.id), String(from.business_id), String(to.business_id),
        intercompany ? 1 : 0, 0, String(user.id),
        strField(body.courier_name, { field: 'Courier', maxLength: 120 }),
        strField(body.courier_phone, { field: 'Courier phone', maxLength: 40 }),
        body.vehicle_id ? String(body.vehicle_id) : null,
        strField(body.notes, { field: 'Notes', maxLength: 500 }),
      ]);

      for (const r of resolved) {
        const unitCost = Number(r.batch.cost_price_per_unit);
        const unitTransferPrice = intercompany ? round2(unitCost * (1 + markup / 100)) : unitCost;
        transferValue = round2(transferValue + r.quantityBase * unitTransferPrice);
        tx.queue(`INSERT INTO stock_transfer_items (
            id, transfer_id, product_id, variant_id, from_batch_id, unit_code, quantity_sent, quantity_sent_base,
            quantity_received, unit_cost, unit_transfer_price, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,0,?,?, datetime('now'), datetime('now'))`, [
          newId(), id, r.productId, r.variantId, String(r.batch.id), r.unitCode,
          r.quantitySent, r.quantityBase, unitCost, unitTransferPrice,
        ]);
        // The stock leaves the sending branch NOW, not on receipt. Goods in
        // transit are still an asset of the group, so the receiving side books
        // them into 1110 rather than leaving them nowhere.
        tx.queue(`UPDATE stock_batches SET quantity = quantity - ?, updated_at = datetime('now')
            WHERE id = ? AND is_deleted = 0 AND quantity - quantity_reserved >= ?`,
        [r.quantityBase, String(r.batch.id), r.quantityBase]);
        tx.queue("UPDATE stock_batches SET status = CASE WHEN quantity <= 0 THEN 'DEPLETED' ELSE status END, updated_at = datetime('now') WHERE id = ?", [String(r.batch.id)]);
      }
      tx.queue("UPDATE stock_transfers SET transfer_price = ?, updated_at = datetime('now') WHERE id = ?", [transferValue, id]);

      const statements = intercompany
        ? glService.postIntercompanyTransferStatements({
          transfer: { id, reference },
          fromBusiness: { id: from.business_id, name: from.name }, toBusiness: { id: to.business_id, name: to.name },
          fromBranch: from, toBranch: to, value: transferValue, accountIds, user,
        })
        : glService.postTransferStatements({
          transfer: { id, reference }, business: { id: from.business_id },
          fromBranch: from, toBranch: to, value: transferValue, accountIds, user,
        });
      for (const st of statements) tx.queue(st.sql, st.params);
      void toAccountIds;
    });

    await recordFromCtx(ctx, {
      action: 'TRANSFER_INITIATED', entityType: 'STOCK_TRANSFER', entityId: id, branchId: from.id, businessId: from.business_id,
      after: { reference, to: to.name, intercompany, lines: resolved.length },
    });
    ctx.json({
      ok: true, id, reference, intercompany,
      message: `Transfer ${reference} dispatched from ${from.name} to ${to.name} (${resolved.length} line(s)).${intercompany ? ' Booked as an intercompany sale between the two businesses.' : ''}`,
    }, 201);
  });

  /**
   * Receive a transfer at the destination.
   *
   * The received quantity may be LESS than sent — goods break in transit, and a
   * driver who arrives with 19 of 20 must be able to say so. The discrepancy is
   * recorded per line rather than silently absorbed into the destination's stock.
   */
  app.post(`${base}/transfers/:id/receive`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const id = String(ctx.req.param('id'));
    const transfer = await db.first('SELECT * FROM stock_transfers WHERE id = ? AND is_deleted = 0', [id]);
    if (!transfer) throw new HttpError('That transfer does not exist.', { status: 404, code: 'TRANSFER_NOT_FOUND' });
    if (transfer.status === 'RECEIVED') throw new HttpError('That transfer has already been received.', { status: 409, code: 'ALREADY_RECEIVED' });

    const to = await db.first('SELECT * FROM branches WHERE id = ?', [transfer.to_branch_id]);
    const branch = await resolveBranch(db, ctx, { required: false });
    if (branch && String(branch.id) !== String(to.id)) {
      throw new HttpError(`That transfer is addressed to ${to.name}, not ${branch.name}. Only the receiving branch can book it in.`, { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }

    const items = await db.all('SELECT * FROM stock_transfer_items WHERE transfer_id = ? AND is_deleted = 0 ORDER BY product_id', [id]);
    // Product rows and the sending branch's name are read HERE, not inside the
    // transaction: the write phase may only queue.
    const productById = new Map();
    for (const it of items) {
      if (!productById.has(String(it.product_id))) {
        const pr = await db.first('SELECT * FROM products WHERE id = ?', [String(it.product_id)]);
        productById.set(String(it.product_id), pr);
      }
    }
    const fromBranch = await db.first('SELECT name FROM branches WHERE id = ?', [String(transfer.from_branch_id)]);
    const fromBranchName = (fromBranch && fromBranch.name) || 'another branch';
    const received = Array.isArray(body.items) ? body.items : null;
    const accountIds = await glService.loadAccountCodes(db, transfer.to_business_id);

    let receivedValue = 0;
    let discrepancies = 0;
    await db.transaction(async (tx) => {
      for (const item of items) {
        const override = received ? received.find((r) => String(r.item_id || r.id) === String(item.id)) : null;
        const qtyBase = override ? numField(override.quantity_received_base != null ? override.quantity_received_base : override.quantity_received, { field: 'Received quantity', min: 0, places: 4 }) : Number(item.quantity_sent_base);
        if (qtyBase > Number(item.quantity_sent_base)) {
          throw new HttpError(`You cannot receive more than was sent (${qtyBase} against ${item.quantity_sent_base}). If extra goods arrived, they belong on a separate transfer so the discrepancy is visible.`, { status: 400, code: 'OVER_RECEIPT' });
        }
        const product = productById.get(String(item.product_id)) || null;
        const unitTransferPrice = Number(item.unit_transfer_price) || Number(item.unit_cost) || 0;
        receivedValue = round2(receivedValue + qtyBase * unitTransferPrice);
        if (qtyBase < Number(item.quantity_sent_base)) discrepancies += 1;

        tx.queue(`UPDATE stock_transfer_items SET quantity_received = ?, received_at = datetime('now'), received_by = ?,
            discrepancy_note = ?, updated_at = datetime('now') WHERE id = ?`, [
          qtyBase, String(user.id),
          qtyBase < Number(item.quantity_sent_base) ? (override && override.note ? String(override.note).slice(0, 500) : `Received ${qtyBase} of ${item.quantity_sent_base}`) : null,
          String(item.id),
        ]);

        // The receiving branch gets its own batch at the transfer price. Keeping
        // it as a separate batch preserves each branch's own cost history, which
        // is what makes a per-branch margin meaningful.
        const toBatchId = newId();
        tx.queue(`INSERT INTO stock_batches (
            id, branch_id, business_id, product_id, variant_id, batch_no, cost_price_per_unit, selling_price_per_unit,
            quantity, quantity_reserved, initial_quantity, received_at, received_by, status, warehouse_zone, notes,
            created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,0,?, datetime('now'), ?, 'ACTIVE', 'Transferred in', ?, datetime('now'), datetime('now'))`, [
          toBatchId, String(to.id), String(transfer.to_business_id), item.product_id, item.variant_id,
          transfer.reference, unitTransferPrice,
          product ? Number(product.selling_price) : round2(unitTransferPrice * 1.3),
          qtyBase, qtyBase, String(user.id),
          `Received on transfer ${transfer.reference} from ${fromBranchName}`,
        ]);
        tx.queue('UPDATE stock_transfer_items SET to_batch_id = ? WHERE id = ?', [toBatchId, String(item.id)]);
      }
      tx.queue(`UPDATE stock_transfers SET status = 'RECEIVED', received_by = ?, received_at = datetime('now'),
          transfer_price = ?, updated_at = datetime('now') WHERE id = ?`,
      [String(user.id), receivedValue, id]);
    });

    await recordFromCtx(ctx, {
      action: 'TRANSFER_RECEIVED', entityType: 'STOCK_TRANSFER', entityId: id, branchId: to.id, businessId: transfer.to_business_id,
      after: { reference: transfer.reference, receivedValue, discrepancies },
    });
    void accountIds;
    ctx.json({
      ok: true, message: `Transfer ${transfer.reference} received at ${to.name}.${discrepancies ? ` ${discrepancies} line(s) arrived short — the discrepancy is recorded against them.` : ''}`,
      discrepancies, receivedValue,
    });
  });

  // -------------------------------------------------------------------
  // STOCKTAKES
  // -------------------------------------------------------------------
  app.get(`${base}/stocktakes`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const where = ['s.is_deleted = 0']; const params = [];
    const f = scopeFilter(scope, { alias: 's' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }
    const rows = await db.all(`SELECT s.*, b.name AS branch_name, u.full_name AS opened_by_name,
          (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id AND l.is_deleted = 0) AS line_count,
          (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id AND l.is_deleted = 0 AND COALESCE(l.variance,0) <> 0) AS variance_count
        FROM stocktake_sessions s
        LEFT JOIN branches b ON b.id = s.branch_id
        LEFT JOIN users u ON u.id = s.opened_by
        WHERE ${where.join(' AND ')} ORDER BY s.opened_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    ctx.json(listResponse(rows, { limit, offset }));
  });

  /**
   * Open a stocktake.
   *
   * The system quantity is FROZEN into each line at open time. Counting against
   * a live figure means a sale rung up mid-count changes the variance under the
   * counter's feet, and the resulting adjustment corrects for stock that was
   * never missing.
   */
  app.post(`${base}/stocktakes`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can open a stocktake.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const open = await db.first("SELECT * FROM stocktake_sessions WHERE branch_id = ? AND status IN ('OPEN','COUNTING') AND is_deleted = 0", [String(branch.id)]);
    if (open) {
      // One open count per branch. Two concurrent stocktakes over the same shelf
      // produce two sets of variances for the same units, and the second commit
      // adjusts stock the first already corrected.
      throw new HttpError(`${branch.name} already has a stocktake in progress (${open.reference || 'unnumbered'}, opened ${open.opened_at}). Commit or cancel it before starting another.`, { status: 409, code: 'STOCKTAKE_IN_PROGRESS' });
    }

    const scope = String(body.scope || 'FULL').toUpperCase();
    const scopeFilterJson = body.scope_filter ? JSON.stringify(body.scope_filter) : null;
    const id = newId();
    const reference = strField(body.reference, { field: 'Reference', maxLength: 40 }) || `ST-${branch.code || branch.id.slice(0, 4)}-${Date.now().toString(36).toUpperCase().slice(-4)}`;

    const where = ['sb.branch_id = ?', 'sb.is_deleted = 0'];
    const params = [String(branch.id)];
    if (scope === 'CATEGORY' && body.category_id) { where.push('p.category_id = ?'); params.push(String(body.category_id)); }
    if (scope === 'PRODUCT' && body.product_id) { where.push('sb.product_id = ?'); params.push(String(body.product_id)); }
    if (scope === 'ZONE' && body.zone) { where.push('sb.warehouse_zone = ?'); params.push(String(body.zone)); }

    const batches = await db.all(`SELECT sb.*, p.name AS product_name, p.base_unit_name FROM stock_batches sb
        JOIN products p ON p.id = sb.product_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.name, sb.batch_no, sb.id`, params);

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO stocktake_sessions (
          id, branch_id, business_id, reference, scope, scope_filter_json, status, opened_by, opened_at, notes,
          created_at, updated_at)
        VALUES (?,?,?,?,?,?, 'COUNTING', ?, datetime('now'), ?, datetime('now'), datetime('now'))`, [
        id, String(branch.id), String(business.id), reference, scope, scopeFilterJson, String(user.id),
        strField(body.notes, { field: 'Notes', maxLength: 500 }),
      ]);
      for (const b of batches) {
        tx.queue(`INSERT INTO stocktake_lines (
            id, stocktake_id, product_id, variant_id, batch_id, warehouse_zone, system_qty, counted_qty, variance, notes,
            created_at, updated_at)
          VALUES (?,?,?,?,?,?,?, NULL, NULL, NULL, datetime('now'), datetime('now'))`, [
          newId(), id, b.product_id, b.variant_id, b.id, b.warehouse_zone, Number(b.quantity),
        ]);
      }
    });

    await recordFromCtx(ctx, { action: 'STOCKTAKE_OPENED', entityType: 'STOCKTAKE', entityId: id, branchId: branch.id, businessId: business.id, after: { reference, scope, lines: batches.length } });
    ctx.json({ ok: true, id, reference, lines: batches.length, message: `Stocktake ${reference} opened with ${batches.length} line(s). The system quantities are frozen — counting will not be disturbed by sales rung up meanwhile.` }, 201);
  });

  app.get(`${base}/stocktakes/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const session = await db.first('SELECT s.*, b.name AS branch_name FROM stocktake_sessions s LEFT JOIN branches b ON b.id = s.branch_id WHERE s.id = ? AND s.is_deleted = 0', [id]);
    if (!session) throw new HttpError('That stocktake does not exist.', { status: 404, code: 'STOCKTAKE_NOT_FOUND' });
    const lines = await db.all(`SELECT l.*, p.name AS product_name, p.sku, p.base_unit_name, v.name AS variant_name,
          b.cost_price_per_unit, b.batch_no
        FROM stocktake_lines l
        JOIN products p ON p.id = l.product_id
        LEFT JOIN product_variants v ON v.id = l.variant_id
        LEFT JOIN stock_batches b ON b.id = l.batch_id
        WHERE l.stocktake_id = ? AND l.is_deleted = 0
        ORDER BY p.name, b.batch_no`, [id]);
    ctx.json({
      ok: true, session,
      lines: lines.map((l) => ({
        ...l,
        variance_value: l.variance == null ? null : round2(Number(l.variance) * Number(l.cost_price_per_unit || 0)),
      })),
      summary: {
        lines: lines.length,
        counted: lines.filter((l) => l.counted_qty != null).length,
        outstanding: lines.filter((l) => l.counted_qty == null).length,
        withVariance: lines.filter((l) => Number(l.variance) !== 0).length,
        varianceValue: round2(lines.reduce((a, l) => a + Math.abs(Number(l.variance || 0) * Number(l.cost_price_per_unit || 0)), 0)),
      },
    });
  });

  /** Record counts. Repeatable — a counter can correct a line before committing. */
  app.post(`${base}/stocktakes/:id/counts`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const session = await db.first('SELECT * FROM stocktake_sessions WHERE id = ? AND is_deleted = 0', [id]);
    if (!session) throw new HttpError('That stocktake does not exist.', { status: 404, code: 'STOCKTAKE_NOT_FOUND' });
    if (session.status === 'COMMITTED') throw new HttpError('That stocktake is already committed. Open a new one to recount.', { status: 409, code: 'ALREADY_COMMITTED' });

    const body = await ctx.req.json();
    const counts = Array.isArray(body.counts) ? body.counts : [];
    if (!counts.length) throw new HttpError('Send a `counts` array of { line_id, counted_qty }.', { status: 400, code: 'MISSING_FIELD' });

    // Validate every line BEFORE opening the transaction. Doing it inside would
    // mean awaiting a read in the write phase, and it would also let a bad line
    // id abort the transaction after good counts had already been queued.
    const sessionLines = await db.all('SELECT * FROM stocktake_lines WHERE stocktake_id = ? AND is_deleted = 0', [id]);
    const lineById = new Map(sessionLines.map((l) => [String(l.id), l]));
    const prepared = counts.map((c, i) => {
      const lineId = String(requireField(c, 'line_id', 'Line'));
      const counted = numField(c.counted_qty, { field: 'Counted quantity', min: 0, places: 4 });
      const line = lineById.get(lineId);
      if (!line) throw new HttpError(`Count line ${lineId.slice(0, 8)} is not part of this stocktake.`, { status: 404, code: 'LINE_NOT_FOUND' });
      return { lineId, counted, line, note: strField(c.notes, { field: 'Note', maxLength: 300 }) };
    });

    let updated = 0;
    await db.transaction(async (tx) => {
      for (const c of prepared) {
        const { lineId, counted, line, note } = c;
        tx.queue(`UPDATE stocktake_lines SET counted_qty = ?, variance = ?, counted_by = ?, counted_at = datetime('now'),
            notes = ?, updated_at = datetime('now') WHERE id = ?`, [
          counted, round2(counted - Number(line.system_qty)), String(user.id),
          note, lineId,
        ]);
        updated += 1;
      }
      tx.queue("UPDATE stocktake_sessions SET status = 'COUNTING', updated_at = datetime('now') WHERE id = ?", [id]);
    });
    ctx.json({ ok: true, updated, message: `${updated} count(s) recorded.` });
  });

  /**
   * Commit a stocktake: post every variance as an adjustment and correct stock.
   *
   * This is the point of no return, so it refuses to run while any line is
   * uncounted unless the caller explicitly says the remainder was not counted.
   * Committing a half-finished sheet would write off everything nobody got to.
   */
  app.post(`${base}/stocktakes/:id/commit`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can commit a stocktake.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const session = await db.first('SELECT * FROM stocktake_sessions WHERE id = ? AND is_deleted = 0', [id]);
    if (!session) throw new HttpError('That stocktake does not exist.', { status: 404, code: 'STOCKTAKE_NOT_FOUND' });
    if (session.status === 'COMMITTED') throw new HttpError('That stocktake is already committed.', { status: 409, code: 'ALREADY_COMMITTED' });

    const branch = await db.first('SELECT * FROM branches WHERE id = ?', [session.branch_id]);
    const uncounted = await db.scalar('SELECT COUNT(*) FROM stocktake_lines WHERE stocktake_id = ? AND counted_qty IS NULL AND is_deleted = 0', [id]);
    if (uncounted > 0 && !boolField(body.accept_uncounted)) {
      throw new HttpError(
        `${uncounted} line(s) have not been counted. Count them, or pass accept_uncounted: true to commit with the uncounted lines left at their system quantity. Committing silently would treat an unfinished sheet as a finished one.`,
        { status: 409, code: 'STOCKTAKE_INCOMPLETE' },
      );
    }

    const lines = await db.all(`SELECT l.*, b.cost_price_per_unit, b.quantity AS batch_quantity, b.quantity_reserved
        FROM stocktake_lines l LEFT JOIN stock_batches b ON b.id = l.batch_id
        WHERE l.stocktake_id = ? AND l.is_deleted = 0 AND l.counted_qty IS NOT NULL AND COALESCE(l.variance, 0) <> 0`, [id]);
    const accountIds = await glService.loadAccountCodes(db, session.business_id);
    let varianceValue = 0;
    let unitsVariance = 0;

    await db.transaction(async (tx) => {
      for (const line of lines) {
        const variance = Number(line.variance);
        const unitCost = Number(line.cost_price_per_unit) || 0;
        const value = round2(variance * unitCost);
        varianceValue = round2(varianceValue + Math.abs(value));
        unitsVariance += Math.abs(variance);

        const adjustmentId = newId();
        tx.queue(`INSERT INTO stock_adjustments (
            id, branch_id, business_id, batch_id, product_id, variant_id, adjustment_type, quantity,
            unit_cost, total_value, reason, stocktake_id, requires_approval, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?, 'COUNT_VARIANCE', ?,?,?,?, ?, 0, ?, datetime('now'), datetime('now'))`, [
          adjustmentId, String(session.branch_id), String(session.business_id),
          line.batch_id ? String(line.batch_id) : null, line.product_id, line.variant_id,
          variance, unitCost, value,
          `Stocktake ${session.reference || id.slice(0, 8)}: counted ${line.counted_qty}, system said ${line.system_qty}`,
          id, String(user.id),
        ]);
        if (line.batch_id) {
          // Guarded the same way a sale is: the count is applied to the batch, and
          // a concurrent sale that emptied it fails this commit rather than
          // driving the quantity negative.
          tx.queue(`UPDATE stock_batches SET quantity = ?, updated_at = datetime('now')
              WHERE id = ? AND is_deleted = 0 AND ? >= quantity_reserved`, [
            Number(line.counted_qty), String(line.batch_id), Number(line.counted_qty),
          ]);
          tx.queue("UPDATE stock_batches SET status = CASE WHEN quantity <= 0 THEN 'DEPLETED' ELSE status END, updated_at = datetime('now') WHERE id = ?", [String(line.batch_id)]);
        }
        for (const st of glService.postAdjustmentStatements({
          adjustment: { id: adjustmentId, adjustment_type: 'COUNT_VARIANCE', quantity: variance, total_value: value, reason: `Stocktake ${session.reference || ''}` },
          business: { id: session.business_id }, branch: { id: session.branch_id }, accountIds, user,
        })) tx.queue(st.sql, st.params);
      }
      tx.queue(`UPDATE stocktake_sessions SET status = 'COMMITTED', committed_by = ?, committed_at = datetime('now'),
          total_variance_value = ?, notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?`, [
        String(user.id), varianceValue,
        uncounted ? ` | Committed with ${uncounted} uncounted line(s) left at system quantity.` : '',
        id,
      ]);
    });

    await recordFromCtx(ctx, {
      action: 'STOCKTAKE_COMMITTED', entityType: 'STOCKTAKE', entityId: id, branchId: session.branch_id, businessId: session.business_id,
      after: { reference: session.reference, lines: lines.length, varianceValue, unitsVariance, uncounted },
    });
    ctx.json({
      ok: true,
      message: `Stocktake ${session.reference || ''} committed: ${lines.length} variance(s) posted, ₦${varianceValue.toLocaleString('en-NG')} of stock value adjusted.`,
      varianceLines: lines.length, varianceValue, unitsVariance, uncounted,
    });
  });

  /** Products whose expiry is inside the alert window. */
  app.get(`${base}/stock/expiring`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const branch = await resolveBranch(db, ctx, { required: false });
    const settings = ctx.get('settings');
    const days = numField(ctx.req.queryParam('days') || settings.expiry_alert_days || 60, { field: 'Days', min: 1, max: 720, whole: true });
    const where = ["sb.expiry_date IS NOT NULL", 'sb.is_deleted = 0', "sb.status <> 'EXPIRED'", `sb.expiry_date <= date('now', '+${days} days')`];
    const params = [];
    if (branch) { where.push('sb.branch_id = ?'); params.push(String(branch.id)); }
    const rows = await db.all(`SELECT sb.id, sb.batch_no, sb.expiry_date, sb.quantity, sb.quantity_reserved,
          sb.cost_price_per_unit, sb.branch_id, b.name AS branch_name, p.id AS product_id, p.name AS product_name, p.sku
        FROM stock_batches sb JOIN products p ON p.id = sb.product_id
        LEFT JOIN branches b ON b.id = sb.branch_id
        WHERE ${where.join(' AND ')}
        ORDER BY sb.expiry_date ASC, p.name LIMIT 500`, params);
    ctx.json({
      ok: true, days,
      data: rows.map((r) => ({
        ...r,
        days_to_expiry: Math.round((Date.parse(r.expiry_date) - Date.parse(watToday())) / 86400000),
        expired: r.expiry_date < watToday(),
        value_at_risk: round2(Number(r.quantity) * Number(r.cost_price_per_unit)),
      })),
    });
  });
}

module.exports = { mount, ADJUSTMENT_TYPES };
