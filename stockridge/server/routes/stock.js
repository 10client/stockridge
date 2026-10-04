// =====================================================================
// StockRidge — STOCK ROUTES: positions, batches, movements, POs, transfers,
//                           stocktakes, adjustments, reservations
// =====================================================================

const { createRouter, HttpError } = require('../lib/http');
const { withIdempotency } = require('../lib/idempotency');
const { watNowIso, watDate } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { assertRole, assertBranchAccess, resolveScopedBranchId } = require('../lib/roles');
const stockService = require('../services/stockService');
const transferService = require('../services/transferService');
const stocktakeService = require('../services/stocktakeService');
const adjustmentService = require('../services/adjustmentService');
const purchaseOrderService = require('../services/purchaseOrderService');
const { getUnitSettings } = require('../lib/planLimits');

// ---------------------------------------------------------------------
// STOCK POSITIONS
// ---------------------------------------------------------------------
function stockRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    if (c.req.query('branch_id')) assertBranchAccess(c.var.user, c.req.query('branch_id'));
    const where = ['sb.is_deleted = 0', 'sb.business_unit_id = ?', 'p.is_deleted = 0'];
    const params = [c.var.businessUnitId];
    if (scoped) { where.push('sb.branch_id = ?'); params.push(scoped); }
    if (c.req.query('product_id')) { where.push('sb.product_id = ?'); params.push(c.req.query('product_id')); }
    if (c.req.query('category_id')) { where.push('p.category_id = ?'); params.push(c.req.query('category_id')); }
    if (c.req.query('q')) {
      const like = `%${String(c.req.query('q')).trim().replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
      where.push(`(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\')`);
      params.push(like, like, like);
    }
    if (c.req.query('in_stock_only') === '1') where.push('sb.quantity_remaining > 0');

    const rows = await db.prepare(`
      SELECT p.id AS product_id, p.name AS product_name, p.sku, p.base_unit, p.brand, p.reorder_level,
             p.default_selling_price, p.tracks_serials, p.tracks_expiry, pc.label AS category_label,
             sb.branch_id, b.name AS branch_name,
             COALESCE(SUM(sb.quantity_remaining),0) AS on_hand,
             COALESCE(SUM(sb.quantity_reserved),0) AS reserved,
             COALESCE(SUM(sb.quantity_remaining - sb.quantity_reserved),0) AS available,
             COALESCE(SUM(sb.quantity_remaining * sb.unit_cost),0) AS value_at_cost,
             COALESCE(SUM(sb.quantity_remaining * sb.selling_price_per_unit),0) AS value_at_retail,
             COUNT(sb.id) AS batch_count,
             MIN(sb.expiry_date) AS earliest_expiry
      FROM stock_batches sb
      JOIN products p ON p.id = sb.product_id
      JOIN branches b ON b.id = sb.branch_id
      LEFT JOIN product_categories pc ON pc.id = p.category_id
      WHERE ${where.join(' AND ')}
      GROUP BY p.id, p.name, p.sku, p.base_unit, p.brand, p.reorder_level, p.default_selling_price,
               p.tracks_serials, p.tracks_expiry, pc.label, sb.branch_id, b.name
      HAVING (? <> 1 OR on_hand > 0)
      ORDER BY p.name ASC
      LIMIT ? OFFSET ?
    `).bind(...params, c.req.query('in_stock_only') === '1' ? 1 : 0,
      Math.min(2000, Number(c.req.query('limit')) || 200), Number(c.req.query('offset')) || 0).all();

    return c.json({
      results: rows.results.map((r) => ({
        ...r,
        on_hand: round2(r.on_hand), reserved: round2(r.reserved), available: round2(r.available),
        value_at_cost: round2(r.value_at_cost), value_at_retail: round2(r.value_at_retail),
        below_reorder: Number(r.reorder_level) > 0 && Number(r.on_hand) <= Number(r.reorder_level),
        average_cost: Number(r.on_hand) > 0 ? round2(Number(r.value_at_cost) / Number(r.on_hand)) : 0,
        potential_margin: round2(Number(r.value_at_retail) - Number(r.value_at_cost)),
      })),
    });
  });

  app.get('/valuation', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view stock valuation' });
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT * FROM v_stock_value_by_branch WHERE business_unit_id = ? ${scoped ? 'AND branch_id = ?' : ''}
      ORDER BY value_at_cost DESC
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();
    const byCategory = await db.prepare(`
      SELECT pc.label AS category, COALESCE(SUM(sb.quantity_remaining * sb.unit_cost),0) AS value_at_cost,
             COALESCE(SUM(sb.quantity_remaining),0) AS units, COUNT(DISTINCT sb.product_id) AS products
      FROM stock_batches sb JOIN products p ON p.id = sb.product_id
      LEFT JOIN product_categories pc ON pc.id = p.category_id
      WHERE sb.business_unit_id = ? AND sb.is_deleted = 0 ${scoped ? 'AND sb.branch_id = ?' : ''}
        AND sb.status NOT IN ('EXPIRED','RECALLED','RETURNED_TO_SUPPLIER')
      GROUP BY pc.label ORDER BY value_at_cost DESC
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();

    const branches = rows.results.map((r) => ({ ...r, value_at_cost: round2(r.value_at_cost), value_at_retail: round2(r.value_at_retail), total_units: round2(r.total_units) }));
    const total = round2(branches.reduce((a, r) => a + r.value_at_cost, 0));
    const totalRetail = round2(branches.reduce((a, r) => a + r.value_at_retail, 0));
    return {
      by_branch: branches,
      by_category: byCategory.results.map((r) => ({ ...r, value_at_cost: round2(r.value_at_cost), units: round2(r.units), share_percent: total > 0 ? round2((Number(r.value_at_cost) / total) * 100) : 0 })),
      total_at_cost: total,
      total_at_retail: totalRetail,
      potential_gross_margin: round2(totalRetail - total),
      potential_margin_percent: totalRetail > 0 ? round2(((totalRetail - total) / totalRetail) * 100) : 0,
      // Stock that is not turning is not an asset, it is cash in a warehouse.
      advisory: total > 0 ? 'Compare this against cost of goods sold for the period to get stock turn. A branch holding six months of stock is a branch with six months of cash it cannot spend.' : null,
    };
  });

  app.get('/low-stock', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT * FROM v_low_stock_alerts WHERE business_unit_id = ? ${scoped ? 'AND branch_id = ?' : ''} LIMIT 500
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();
    const suggestions = await require('../services/productService').reorderSuggestions(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped, limit: 200,
    });
    return c.json({
      results: rows.results.map((r) => ({ ...r, qty_on_hand: round2(r.qty_on_hand), qty_available: round2(r.qty_available), reorder_level: round2(r.reorder_level) })),
      count: rows.results.length,
      reorder_suggestions: suggestions,
    });
  });

  app.get('/expiry', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const rows = await db.prepare(`
      SELECT * FROM v_expiry_alerts WHERE business_unit_id = ? ${scoped ? 'AND branch_id = ?' : ''}
        AND severity <> 'OK'
      ORDER BY CASE severity WHEN 'EXPIRED' THEN 0 WHEN 'CRITICAL' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END, days_to_expiry
      LIMIT 500
    `).bind(c.var.businessUnitId, ...(scoped ? [scoped] : [])).all();
    const expired = rows.results.filter((r) => r.severity === 'EXPIRED');
    return c.json({
      results: rows.results.map((r) => ({ ...r, value_at_risk: round2(r.value_at_risk), quantity_remaining: round2(r.quantity_remaining) })),
      counts: {
        expired: expired.length,
        critical: rows.results.filter((r) => r.severity === 'CRITICAL').length,
        warning: rows.results.filter((r) => r.severity === 'WARNING').length,
        watch: rows.results.filter((r) => r.severity === 'WATCH').length,
      },
      value_at_risk: round2(rows.results.reduce((a, r) => a + Number(r.value_at_risk), 0)),
      expired_value: round2(expired.reduce((a, r) => a + Number(r.value_at_risk), 0)),
      advisory: expired.length
        ? `${expired.length} batch(es) have already expired and are still counted in stock value worth ₦${round2(expired.reduce((a, r) => a + Number(r.value_at_risk), 0)).toLocaleString('en-NG')}. Quarantine or write them off — unsellable stock that shows as an asset overstates the balance sheet.`
        : null,
    });
  });

  app.get('/batches', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const where = ['sb.is_deleted = 0', 'sb.business_unit_id = ?'];
    const params = [c.var.businessUnitId];
    if (scoped) { where.push('sb.branch_id = ?'); params.push(scoped); }
    if (c.req.query('product_id')) { where.push('sb.product_id = ?'); params.push(c.req.query('product_id')); }
    if (c.req.query('status')) { where.push('sb.status = ?'); params.push(String(c.req.query('status')).toUpperCase()); }
    const rows = await db.prepare(`
      SELECT sb.*, p.name AS product_name, p.sku, p.base_unit, b.name AS branch_name,
             s.name AS supplier_name, po.po_number, u.full_name AS received_by_name,
             (SELECT COUNT(*) FROM product_serials ps WHERE ps.stock_batch_id = sb.id AND ps.is_deleted = 0) AS serial_count
      FROM stock_batches sb
      JOIN products p ON p.id = sb.product_id
      JOIN branches b ON b.id = sb.branch_id
      LEFT JOIN suppliers s ON s.id = sb.supplier_id
      LEFT JOIN purchase_orders po ON po.id = sb.purchase_order_id
      LEFT JOIN users u ON u.id = sb.received_by
      WHERE ${where.join(' AND ')}
      ORDER BY sb.received_at DESC LIMIT ? OFFSET ?
    `).bind(...params, Math.min(1000, Number(c.req.query('limit')) || 200), Number(c.req.query('offset')) || 0).all();
    return c.json({ results: rows.results });
  });

  app.get('/movements', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const where = ['m.business_unit_id = ?'];
    const params = [c.var.businessUnitId];
    if (scoped) { where.push('m.branch_id = ?'); params.push(scoped); }
    if (c.req.query('product_id')) { where.push('m.product_id = ?'); params.push(c.req.query('product_id')); }
    if (c.req.query('type')) { where.push('m.movement_type = ?'); params.push(String(c.req.query('type')).toUpperCase()); }
    if (c.req.query('direction')) { where.push('m.direction = ?'); params.push(String(c.req.query('direction')).toUpperCase()); }
    if (c.req.query('from')) { where.push("date(m.occurred_at,'+1 hour') >= ?"); params.push(String(c.req.query('from')).slice(0, 10)); }
    if (c.req.query('to')) { where.push("date(m.occurred_at,'+1 hour') <= ?"); params.push(String(c.req.query('to')).slice(0, 10)); }
    const rows = await db.prepare(`
      SELECT m.*, p.name AS product_name, p.sku, p.base_unit, b.name AS branch_name,
             u.full_name AS performed_by_name, sb.batch_no
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      JOIN branches b ON b.id = m.branch_id
      LEFT JOIN users u ON u.id = m.performed_by
      LEFT JOIN stock_batches sb ON sb.id = m.stock_batch_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.occurred_at DESC LIMIT ? OFFSET ?
    `).bind(...params, Math.min(1000, Number(c.req.query('limit')) || 200), Number(c.req.query('offset')) || 0).all();
    return c.json({ results: rows.results });
  });

  // Opening stock. The one legitimate way to create stock without a supplier
  // invoice — and it must be attributable, because it is also the one way to
  // create stock that nobody paid for.
  app.post('/opening-balance', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'record opening stock' });
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => {
      const branchId = body.branch_id || c.var.user.branch_id;
      if (!branchId) throw new HttpError(400, 'Choose which branch this stock is at.', 'BRANCH_REQUIRED');
      assertBranchAccess(c.var.user, branchId);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) throw new HttpError(400, 'Record at least one item.', 'OPENING_STOCK_EMPTY');
      if (items.length > 1000) throw new HttpError(400, 'At most 1,000 lines per request — a larger batch will time out on a mobile connection.', 'OPENING_STOCK_TOO_LARGE');
      if (!body.reference) throw new HttpError(400, 'A reference is required: the count sheet, the date of takeover, or the source document. Opening stock without a reference is stock nobody can account for.', 'OPENING_STOCK_REFERENCE_REQUIRED');

      const ts = watNowIso();
      const statements = [];
      let totalValue = 0;
      const created = [];
      for (const raw of items) {
        const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(raw.product_id).first();
        if (!product) throw new HttpError(404, `Product ${raw.product_id} was not found.`, 'PRODUCT_NOT_FOUND');
        const qty = Number(raw.quantity);
        if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, `${product.name}: quantity must be more than zero.`, 'OPENING_STOCK_QUANTITY_INVALID');
        // A cost is required. Zero-cost opening stock would make every future
        // margin on that item read as 100%, which is worse than not knowing.
        const cost = Number(raw.unit_cost);
        if (!Number.isFinite(cost) || cost < 0) {
          throw new HttpError(400, `${product.name}: a unit cost is required for opening stock. Zero would make every future margin on this item read as 100%.`, 'OPENING_STOCK_COST_REQUIRED');
        }
        if (product.tracks_expiry && !raw.expiry_date) {
          throw new HttpError(400, `${product.name} is tracked by expiry date, so the opening batch needs one.`, 'OPENING_STOCK_EXPIRY_REQUIRED');
        }
        const built = stockService.buildReceiveStatements(db, {
          businessUnitId: c.var.businessUnitId, branchId, productId: product.id, quantity: qty,
          unitCost: cost, sellingPrice: raw.selling_price != null ? round2(Number(raw.selling_price)) : Number(product.default_selling_price) || 0,
          batchNo: raw.batch_no || `OPENING-${String(body.reference).slice(0, 20)}`,
          expiryDate: raw.expiry_date ? String(raw.expiry_date).slice(0, 10) : null,
          receivedBy: c.var.user.id, movementType: 'PURCHASE_RECEIPT', sourceType: 'OPENING_BALANCE',
          reference: String(body.reference).slice(0, 120), now: ts,
          notes: `Opening stock: ${String(body.reference).slice(0, 200)}`,
        });
        for (const s of built.statements) statements.push(s);
        totalValue = round2(totalValue + cost * qty);
        created.push({ product_name: product.name, quantity: qty, unit_cost: round2(cost), batch_id: built.batchId });

        if (product.tracks_serials && Array.isArray(raw.serials) && raw.serials.length) {
          if (raw.serials.length !== Math.round(qty)) {
            throw new HttpError(400, `${product.name} is serialised: ${Math.round(qty)} serial numbers are required, you supplied ${raw.serials.length}.`, 'OPENING_STOCK_SERIAL_COUNT');
          }
          // Registered after the batch exists.
          statements.push({ _defer: () => stockService.registerSerials(db, {
            businessUnitId: c.var.businessUnitId, branchId, productId: product.id, batchId: built.batchId,
            serials: raw.serials, receivedBy: c.var.user.id, costPrice: cost, now: ts,
          }) });
        }
      }

      await db.batch(statements.filter((s) => !s._defer).map((s) => s));
      for (const d of statements.filter((s) => s._defer)) {
        try { await d._defer(); } catch (e) { console.error('[stock] opening serial registration failed:', e && e.message); }
      }

      if (capabilitiesOfUnit(db, c)) {
        try {
          const glService = require('../services/glService');
          await glService.postEntry(db, {
            businessUnitId: c.var.businessUnitId, branchId, entryDate: watDate(),
            sourceType: 'OPENING_BALANCE', reference: String(body.reference).slice(0, 120),
            description: `Opening stock — ${String(body.reference).slice(0, 200)}`,
            lines: [
              { account_code: '1100', debit: totalValue, credit: 0, description: 'Opening inventory' },
              { account_code: '3900', debit: 0, credit: totalValue, description: 'Opening equity' },
            ],
            userId: c.var.user.id,
          });
        } catch (e) { console.error('[stock] opening GL posting failed:', e && e.message); }
      }

      await writeAuditLocal(db, c, { branchId, action: 'OPENING_STOCK_RECORDED', amount: totalValue, after: { reference: body.reference, lines: created.length } });
      return { status: 201, body: { ok: true, reference: String(body.reference).slice(0, 120), lines: created.length, total_value: totalValue } };
    });
  });

  return app;
}

function capabilitiesOfUnit(db, c) {
  const s = c.var.businessUnit;
  return s && s.gl_module_enabled !== 0;
}

async function writeAuditLocal(db, c, entry) {
  try {
    await require('../lib/audit').writeAudit(db, {
      businessUnitId: c.var.businessUnitId, userId: c.var.user.id, actorRole: c.var.user.role,
      entityType: entry.entityType || 'STOCK', ipAddress: c.var.ipAddress, deviceId: c.var.deviceId, ...entry,
    });
  } catch (_) { /* best effort */ }
}

// ---------------------------------------------------------------------
// PURCHASE ORDERS
// ---------------------------------------------------------------------
function purchaseOrderRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const results = await purchaseOrderService.list(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      supplierId: c.req.query('supplier_id') || null, status: c.req.query('status') || null,
      from: c.req.query('from') || null, to: c.req.query('to') || null, search: c.req.query('q') || null,
      limit: c.req.query('limit'), offset: c.req.query('offset'),
    });
    return c.json({ results });
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const po = await purchaseOrderService.getWithItems(db, c.req.param('id'), c.var.businessUnitId);
    if (!po) throw new HttpError(404, 'That purchase order was not found.', 'PO_NOT_FOUND');
    assertBranchAccess(c.var.user, po.branch_id);
    return c.json(po);
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await purchaseOrderService.create(db, c.serviceCtx, body) }));
  });

  app.post('/:id/approve', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await purchaseOrderService.approve(db, c.serviceCtx, { poId: c.req.param('id'), note: body.note }));
  });

  app.post('/:id/receive', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 201, body: await purchaseOrderService.receive(db, c.serviceCtx, { po_id: c.req.param('id'), ...body }),
    }));
  });

  app.post('/:id/payments', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await purchaseOrderService.recordPayment(db, c.serviceCtx, { poId: c.req.param('id'), ...body }) }));
  });

  app.post('/:id/cancel', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await purchaseOrderService.cancel(db, c.serviceCtx, { poId: c.req.param('id'), reason: body.reason }));
  });

  return app;
}

// ---------------------------------------------------------------------
// TRANSFERS
// ---------------------------------------------------------------------
function transferRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const results = await transferService.list(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped, status: c.req.query('status') || null,
      from: c.req.query('from') || null, to: c.req.query('to') || null,
      direction: c.req.query('direction') || 'BOTH',
      limit: c.req.query('limit'), offset: c.req.query('offset'),
    });
    return c.json({ results });
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const t = await transferService.getWithItems(db, c.req.param('id'), c.var.businessUnitId);
    if (!t) throw new HttpError(404, 'That transfer was not found.', 'TRANSFER_NOT_FOUND');
    // A pinned user may see a transfer their branch is party to, either side.
    if (c.var.user.branch_id && t.from_branch_id !== c.var.user.branch_id && t.to_branch_id !== c.var.user.branch_id) {
      throw new HttpError(403, 'That transfer is between two other branches.', 'TRANSFER_OTHER_BRANCHES');
    }
    return c.json(t);
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await transferService.create(db, c.serviceCtx, body) }));
  });

  app.post('/:id/dispatch', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 200, body: await transferService.dispatch(db, c.serviceCtx, { transferId: c.req.param('id'), ...body }) }));
  });

  app.post('/:id/receive', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 200, body: await transferService.receive(db, c.serviceCtx, { transferId: c.req.param('id'), ...body }) }));
  });

  app.post('/:id/cancel', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await transferService.cancel(db, c.serviceCtx, { transferId: c.req.param('id'), reason: body.reason }));
  });

  return app;
}

// ---------------------------------------------------------------------
// STOCKTAKES
// ---------------------------------------------------------------------
function stocktakeRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const results = await stocktakeService.list(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      status: c.req.query('status') || null, limit: c.req.query('limit'), offset: c.req.query('offset'),
    });
    return c.json({ results });
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await stocktakeService.open(db, c.serviceCtx, body), 201);
  });

  app.get('/:id', async (c) => {
    const db = getDb();
    const session = await stocktakeService.load(db, c.req.param('id'), c.var.businessUnitId);
    if (!session) throw new HttpError(404, 'That stocktake was not found.', 'STOCKTAKE_NOT_FOUND');
    assertBranchAccess(c.var.user, session.branch_id);
    const preview = await stocktakeService.previewVariances(db, session.id, { businessUnitId: c.var.businessUnitId });
    return c.json({ ...session, preview });
  });

  // The paper count sheet. A stocktake that can only be done on a screen will
  // not be done in a warehouse with no signal.
  app.get('/:id/count-sheet', async (c) => {
    const db = getDb();
    return c.json(await stocktakeService.countSheet(db, c.req.param('id'), c.var.businessUnitId));
  });

  app.post('/:id/counts', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 200, body: await stocktakeService.recordCount(db, c.serviceCtx, { stocktakeId: c.req.param('id'), lines: body.lines }),
    }));
  });

  app.post('/:id/recount', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await stocktakeService.recount(db, c.serviceCtx, {
      stocktakeId: c.req.param('id'), lineId: body.line_id, quantity: body.quantity, note: body.note,
    }));
  });

  app.get('/:id/variances', async (c) => {
    const db = getDb();
    return c.json(await stocktakeService.previewVariances(db, c.req.param('id'), { businessUnitId: c.var.businessUnitId }));
  });

  app.post('/:id/commit', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({
      status: 200, body: await stocktakeService.commit(db, c.serviceCtx, {
        stocktakeId: c.req.param('id'), note: body.note, postZeroVariances: !!body.post_zero_variances,
      }),
    }));
  });

  app.post('/:id/cancel', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await stocktakeService.cancel(db, c.serviceCtx, { stocktakeId: c.req.param('id'), reason: body.reason }));
  });

  return app;
}

// ---------------------------------------------------------------------
// ADJUSTMENTS
// ---------------------------------------------------------------------
function adjustmentRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const results = await adjustmentService.list(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      productId: c.req.query('product_id') || null, type: c.req.query('type') || null,
      status: c.req.query('status') || null, from: c.req.query('from') || null, to: c.req.query('to') || null,
      limit: c.req.query('limit'), offset: c.req.query('offset'),
    });
    return c.json({ results, types: adjustmentService.TYPES });
  });

  app.get('/shrinkage', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the shrinkage report' });
    const db = getDb();
    return c.json(await adjustmentService.shrinkageReport(db, {
      businessUnitId: c.var.businessUnitId, branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      startDate: c.req.query('from') || watDate(), endDate: c.req.query('to') || watDate(),
    }));
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await adjustmentService.create(db, c.serviceCtx, body) }));
  });

  app.post('/:id/approve', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await adjustmentService.approve(db, c.serviceCtx, { adjustmentId: c.req.param('id'), decision: body.decision, note: body.note }));
  });

  return app;
}

// ---------------------------------------------------------------------
// RESERVATIONS
// ---------------------------------------------------------------------
function reservationRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    const where = ['r.is_deleted = 0', 'r.business_unit_id = ?', "r.status = 'ACTIVE'"];
    const params = [c.var.businessUnitId];
    if (scoped) { where.push('r.branch_id = ?'); params.push(scoped); }
    if (c.req.query('source_type')) { where.push('r.source_type = ?'); params.push(String(c.req.query('source_type')).toUpperCase()); }
    const rows = await db.prepare(`
      SELECT r.*, p.name AS product_name, p.sku, b.name AS branch_name, cu.full_name AS customer_name,
             cu.phone AS customer_phone, ps.serial_no,
             lh.hold_no, pp.plan_no, dj.job_no
      FROM stock_reservations r
      JOIN products p ON p.id = r.product_id
      JOIN branches b ON b.id = r.branch_id
      LEFT JOIN customers cu ON cu.id = r.customer_id
      LEFT JOIN product_serials ps ON ps.id = r.serial_id
      LEFT JOIN layaway_holds lh ON lh.id = r.source_id AND r.source_type = 'LAYAWAY'
      LEFT JOIN payment_plans pp ON pp.id = r.source_id AND r.source_type = 'PAYMENT_PLAN'
      LEFT JOIN delivery_jobs dj ON dj.id = r.source_id AND r.source_type = 'DELIVERY_JOB'
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC LIMIT 500
    `).bind(...params).all();
    return c.json({
      results: rows.results,
      total_reserved_units: round2(rows.results.reduce((a, r) => a + Number(r.quantity), 0)),
      by_source: rows.results.reduce((acc, r) => {
        acc[r.source_type] = (acc[r.source_type] || 0) + 1;
        return acc;
      }, {}),
      note: 'Reserved stock is committed to a hold, a delivery or an instalment plan and is excluded from what can be sold. Two cashiers cannot both promise the last unit.',
    });
  });

  app.post('/:id/release', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'release a stock reservation' });
    const db = getDb();
    const body = await c.req.json();
    const r = await db.prepare('SELECT * FROM stock_reservations WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!r) throw new HttpError(404, 'That reservation was not found.', 'RESERVATION_NOT_FOUND');
    if (r.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That reservation belongs to another business.', 'RESERVATION_WRONG_BUSINESS');
    assertBranchAccess(c.var.user, r.branch_id);
    if (['LAYAWAY', 'PAYMENT_PLAN'].includes(r.source_type) && body.force !== true) {
      throw new HttpError(409,
        'This reservation belongs to a customer hold or instalment plan. Release it by cancelling the hold or plan so the customer record stays consistent — or pass force:true if you genuinely intend to break the commitment.',
        'RESERVATION_HAS_CUSTOMER_COMMITMENT');
    }
    const result = await stockService.releaseReservation(db, r.id, { status: 'CANCELLED' });
    await writeAuditLocal(db, c, {
      branchId: r.branch_id, action: 'RESERVATION_RELEASED', entityType: 'RESERVATION', entityId: r.id,
      reason: body.reason || null, after: { source_type: r.source_type, quantity: r.quantity },
    });
    return c.json(result);
  });

  return app;
}

module.exports = { stockRoutes, purchaseOrderRoutes, transferRoutes, stocktakeRoutes, adjustmentRoutes, reservationRoutes };
'use strict';
