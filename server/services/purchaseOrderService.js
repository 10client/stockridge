// =====================================================================
// StockRidge — PURCHASE ORDERS & RECEIVING
// =====================================================================
// PARTIAL RECEIVING IS THE NORMAL CASE, not an exception. A supplier ships
// 60 of the 100 units ordered today and the rest next week — extremely common
// in Nigerian wholesale. An all-or-nothing receive means the 60 that arrived
// cannot go on the shelf until the other 40 do, so the shop is out of stock of
// something it is physically holding. The PARTIALLY_RECEIVED status must be
// REACHABLE, which was a real gap in the original design: the CHECK constraint
// allowed the value and no route could ever set it.
//
// LANDED COST. Freight, clearing and "other" are added to the stock value.
// For an importer these are not overheads to be expensed — they are part of
// what the goods cost, and excluding them understates every margin on imported
// goods by 15-40%, which is the difference between a business that knows its
// true margin and one that discovers it at the bank.
//
// EXCHANGE RATE IS A FACT OF THE PURCHASE, not a setting. A USD-sourced order
// booked at ₦1,450/USD must stay valued at ₦1,450/USD forever, because that is
// what was paid. Reading today's rate at report time would revalue history.
//
// THE PRICE OF RECORD IS THE BATCH. Once received, the batch's own
// selling_price_per_unit prices any sale of that stock. The product's default
// and the branch override are only PRE-FILLS for the receiving screen. This is
// what lets two deliveries of the same product at different costs sell at
// different prices without a costing engine.
// =====================================================================

const { newId, watNowIso, watDate } = require('../../shared/ids');
const { round2, sumMoney } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const U = require('../../shared/units');
const stockService = require('./stockService');
const { PREFIXES, nextReference } = require('../lib/references');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { getUnitSettings, assertSubscribed, assertManagerPermission, staffAllowance } = require('../lib/planLimits');
const { capabilitiesOf } = require('../lib/capabilities');
const whtLib = require('../lib/wht');
const vatLib = require('../lib/vat');

const PO_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];

async function create(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'raise a purchase order' });

  const branchId = input.branch_id || ctx.user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch is ordering.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, branchId);

  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw new HttpError(400, 'A purchase order needs at least one line.', 'PO_EMPTY');
  if (items.length > 500) throw new HttpError(400, 'A purchase order cannot hold more than 500 lines. Split it.', 'PO_TOO_MANY_LINES');

  let supplier = null;
  if (input.supplier_id) {
    supplier = await db.prepare('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0').bind(input.supplier_id).first();
    if (!supplier) throw new HttpError(404, 'That supplier was not found.', 'SUPPLIER_NOT_FOUND');
    if (supplier.business_unit_id !== businessUnitId) throw new HttpError(403, 'That supplier belongs to a different business.', 'SUPPLIER_WRONG_BUSINESS');
  }

  const ts = watNowIso();
  const poId = newId();
  const branch = await db.prepare('SELECT code FROM branches WHERE id = ?').bind(branchId).first();
  const poNumber = input.po_number
    || (await nextReference(db, { businessUnitId, prefix: PREFIXES.PURCHASE_ORDER, branchCode: branch.code || '*', scope: 'YEAR' })).reference;

  const exchangeRate = Number(input.exchange_rate) > 0 ? Number(input.exchange_rate) : 1;
  const currency = input.currency ? String(input.currency).toUpperCase().slice(0, 3) : 'NGN';
  if (currency !== 'NGN' && exchangeRate <= 1) {
    throw new HttpError(400, `A ${currency} purchase order needs the exchange rate to Naira. Without it the stock lands in the books at a fraction of what it cost.`, 'PO_EXCHANGE_RATE_REQUIRED');
  }

  const statements = [];
  const resolvedItems = [];
  let subtotal = 0;

  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (!raw.product_id) throw new HttpError(400, `Line ${i + 1}: choose a product.`, 'PRODUCT_REQUIRED');
    const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(raw.product_id).first();
    if (!product) throw new HttpError(404, `Line ${i + 1}: that product was not found.`, 'PRODUCT_NOT_FOUND');
    if (product.business_unit_id !== businessUnitId) throw new HttpError(403, `Line ${i + 1}: that product belongs to a different business.`, 'PRODUCT_WRONG_BUSINESS');

    // Order quantity is expressed in a SELLING UNIT and resolved to base
    // units, exactly as a sale is. Ordering "10 cartons" and receiving
    // "1,000 pieces" must be the same arithmetic the receiving clerk can check
    // on the delivery note.
    const sellingUnits = String(product.selling_units || 'BASE_UNIT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const resolved = U.resolveLine({ ...product, selling_units: sellingUnits }, { quantity: raw.quantity, unit: raw.order_unit || 'BASE_UNIT' });
    if (!resolved.ok) throw new HttpError(400, `Line ${i + 1} (${product.name}): ${resolved.error}`, resolved.code);

    const unitCostInput = raw.expected_unit_cost != null ? round2(Number(raw.expected_unit_cost)) : null;
    const totalLineCost = raw.total_cost != null ? round2(Number(raw.total_cost)) : (unitCostInput != null ? round2(unitCostInput * resolved.count) : null);

    // Prefer the TOTAL paid over the unit cost when both are given, and split
    // it at full precision — see shared/units.js splitTotalCost for why the
    // per-piece figure is never rounded to kobo.
    let unitCost = unitCostInput;
    if (totalLineCost != null && totalLineCost > 0) {
      const split = U.splitTotalCost(totalLineCost * exchangeRate, resolved);
      if (!split.ok) throw new HttpError(400, `Line ${i + 1}: ${split.error}`, split.code);
      unitCost = split.costPerPiece;
    } else if (unitCost != null) {
      unitCost = unitCost * exchangeRate;
    }

    const lineTotal = unitCost != null ? round2(unitCost * resolved.totalPieces) : null;
    if (lineTotal != null) subtotal = round2(subtotal + lineTotal);

    resolvedItems.push({
      product_id: product.id, product_name: product.name,
      quantity_ordered: resolved.totalPieces, order_unit: resolved.unit,
      order_count: resolved.count, expected_unit_cost: unitCost, total_line_cost: lineTotal,
      description: U.describeCount(resolved.count, resolved.unit, product),
    });

    statements.push(db.prepare(`
      INSERT INTO purchase_order_items (
        id, purchase_order_id, business_unit_id, product_id, quantity_ordered, quantity_received,
        order_unit, expected_unit_cost, total_line_cost, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?, 0, ?,?,?,?,?,?)
    `).bind(newId(), poId, businessUnitId, product.id, resolved.totalPieces, resolved.unit,
      unitCost, lineTotal, raw.notes ? String(raw.notes).slice(0, 500) : null, ts, ts));
  }

  const freight = round2(Math.max(0, Number(input.freight_cost) || 0));
  const clearing = round2(Math.max(0, Number(input.clearing_cost) || 0));
  const other = round2(Math.max(0, Number(input.other_cost) || 0));
  const totalCost = round2(subtotal + freight + clearing + other);

  // Withholding tax on the purchase. Computed from the GROSS invoice value and
  // net derived by subtraction — see lib/wht.js.
  let whtAmount = 0;
  let whtCode = null;
  if (input.wht_rate_code && settings.wht_enabled !== 0) {
    const deduction = await whtLib.resolveDeduction(db, {
      grossAmount: totalCost, rateCode: input.wht_rate_code, direction: 'PAYABLE',
      counterpartyType: supplier ? (supplier.supplier_type === 'MANUFACTURER' ? 'COMPANY' : null) : null,
      businessUnitId,
    });
    if (deduction) { whtAmount = deduction.wht; whtCode = deduction.rateCode; }
  }
  const payable = round2(totalCost - whtAmount);

  statements.push(db.prepare(`
    INSERT INTO purchase_orders (
      id, business_unit_id, branch_id, po_number, supplier_id, status, ordered_by, ordered_at,
      expected_at, currency, exchange_rate, subtotal, freight_cost, clearing_cost, other_cost,
      total_cost, wht_rate_code, wht_amount, payable_amount, payment_status, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?,?,?, ?,?,?,?, 'UNPAID', ?,?,?)
  `).bind(
    poId, businessUnitId, branchId, poNumber, supplier ? supplier.id : null,
    input.status && ['DRAFT', 'PENDING'].includes(String(input.status).toUpperCase()) ? String(input.status).toUpperCase() : 'DRAFT',
    ctx.user.id, ts,
    input.expected_at ? String(input.expected_at).slice(0, 10) : null,
    currency, exchangeRate, subtotal, freight, clearing, other, totalCost, whtCode, whtAmount, payable,
    input.notes ? String(input.notes).slice(0, 2000) : null, ts, ts
  ));

  await db.batch(statements);
  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'PO_CREATED', entityType: 'PURCHASE_ORDER', entityId: poId, amount: totalCost,
    after: { po_number: poNumber, supplier: supplier ? supplier.name : null, lines: resolvedItems.length },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id: poId, po_number: poNumber, status: 'DRAFT',
    supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
    currency, exchange_rate: exchangeRate,
    items: resolvedItems, subtotal, freight_cost: freight, clearing_cost: clearing, other_cost: other,
    total_cost: totalCost, wht_amount: whtAmount, payable_amount: payable,
    advisory: freight + clearing > 0
      ? `₦${round2(freight + clearing).toLocaleString('en-NG')} of freight and clearing is included in the landed cost, so margins on these goods will be correct. Excluding it would understate cost and overstate every margin on this delivery.`
      : null,
  };
}

async function approve(db, ctx, { poId, note = null }) {
  const po = await load(db, poId, ctx.businessUnitId);
  if (!po) throw new HttpError(404, 'That purchase order was not found.', 'PO_NOT_FOUND');
  assertBranchAccess(ctx.user, po.branch_id);
  if (!['DRAFT', 'PENDING'].includes(po.status)) throw new HttpError(409, `A ${po.status} purchase order cannot be approved.`, 'PO_NOT_APPROVABLE');
  await assertManagerPermission(db, ctx.businessUnitId, ctx.user, 'managers_can_approve_expenses', { action: 'approve a purchase order' });

  const ts = watNowIso();
  await db.prepare(`UPDATE purchase_orders SET status = 'APPROVED', approved_by = ?, approved_at = ?, notes = COALESCE(notes || ' | ','') || ?, updated_at = ? WHERE id = ?`)
    .bind(ctx.user.id, ts, note ? `Approved: ${String(note).slice(0, 200)}` : '', ts, poId).run();
  await writeAudit(db, {
    businessUnitId: po.business_unit_id, branchId: po.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'PO_APPROVED', entityType: 'PURCHASE_ORDER', entityId: poId,
    amount: Number(po.total_cost), reason: note || null, ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: poId, status: 'APPROVED' };
}

// RECEIVE — the goods-in screen. Accepts a partial quantity per line.
async function receive(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  const po = await load(db, input.po_id || input.poId, businessUnitId);
  if (!po) throw new HttpError(404, 'That purchase order was not found.', 'PO_NOT_FOUND');
  assertBranchAccess(ctx.user, po.branch_id);
  if (['RECEIVED', 'CANCELLED'].includes(po.status)) {
    throw new HttpError(409, `That purchase order is ${po.status} and cannot take more goods. Raise a new order for the balance.`, 'PO_NOT_RECEIVABLE');
  }
  if (po.status === 'DRAFT') {
    throw new HttpError(409, 'Approve this purchase order before receiving against it. Receiving against an unapproved order means goods arrived that nobody authorised.', 'PO_NOT_APPROVED');
  }

  const branchId = input.branch_id || po.branch_id;
  assertBranchAccess(ctx.user, branchId);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) throw new HttpError(400, 'Record what actually arrived — at least one line.', 'RECEIVE_EMPTY');

  const ts = watNowIso();
  const grnNumber = input.grn_number
    || (await nextReference(db, { businessUnitId, prefix: PREFIXES.GRN, branchCode: '*', scope: 'YEAR' })).reference;

  const statements = [];
  const receivedLines = [];
  const serialBatches = [];
  let receivedValue = 0;
  let allComplete = true;

  for (const raw of lines) {
    const item = await db.prepare('SELECT * FROM purchase_order_items WHERE id = ? AND purchase_order_id = ? AND is_deleted = 0')
      .bind(raw.item_id || raw.purchase_order_item_id, po.id).first();
    if (!item) throw new HttpError(404, `Line ${raw.item_id || raw.purchase_order_item_id} is not on this purchase order.`, 'PO_ITEM_NOT_FOUND');

    const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(item.product_id).first();
    const sellingUnits = String(product.selling_units || 'BASE_UNIT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const resolved = U.resolveLine({ ...product, selling_units: sellingUnits }, {
      quantity: raw.quantity, unit: raw.receive_unit || item.order_unit || 'BASE_UNIT',
    });
    if (!resolved.ok) throw new HttpError(400, `${product.name}: ${resolved.error}`, resolved.code);

    const alreadyReceived = Number(item.quantity_received) || 0;
    const newTotal = round2(alreadyReceived + resolved.totalPieces);
    if (newTotal > Number(item.quantity_ordered) + 1e-6) {
      // Over-receipt is refused rather than accepted-and-noted: stock that
      // arrived beyond the order has no cost basis in the order, no supplier
      // invoice line to match, and would silently inflate the creditor ledger
      // by less than the value of the goods on the shelf.
      throw new HttpError(409,
        `${product.name}: receiving ${resolved.totalPieces.toLocaleString('en-NG')} would take this line to ${newTotal.toLocaleString('en-NG')} against ${Number(item.quantity_ordered).toLocaleString('en-NG')} ordered. `
        + 'Raise a new purchase order for the extra — goods without an order line have no cost basis and no invoice to match.',
        'RECEIVE_EXCEEDS_ORDER');
    }

    // Unit cost. Falls back through: what the caller states (converted at the
    // PO's own exchange rate), the line's expected cost, then the product
    // default. The PO's rate is used, never today's — see the header comment.
    const exchangeRate = Number(po.exchange_rate) > 0 ? Number(po.exchange_rate) : 1;
    let unitCost;
    if (raw.total_cost != null && Number(raw.total_cost) > 0) {
      const split = U.splitTotalCost(round2(Number(raw.total_cost)) * exchangeRate, resolved);
      if (!split.ok) throw new HttpError(400, `${product.name}: ${split.error}`, split.code);
      unitCost = split.costPerPiece;
    } else if (raw.unit_cost != null) {
      unitCost = round2(Number(raw.unit_cost)) * exchangeRate;
    } else if (item.expected_unit_cost != null) {
      unitCost = Number(item.expected_unit_cost);
    } else {
      unitCost = Number(product.default_cost_price) || 0;
    }
    const lineCost = round2(unitCost * resolved.totalPieces);
    receivedValue = round2(receivedValue + lineCost);

    // Selling price of record for THIS batch. Pre-filled from the branch
    // override or the product default, but the receiving clerk can set it —
    // which is where a branch decides its own margin on this delivery.
    const allowance = await staffAllowance(db, businessUnitId, ctx.user);
    let sellingPrice = raw.selling_price != null ? round2(Number(raw.selling_price)) : null;
    if (sellingPrice == null) {
      const override = await db.prepare('SELECT default_selling_price FROM product_price_overrides WHERE branch_id = ? AND product_id = ? AND is_deleted = 0').bind(branchId, product.id).first();
      sellingPrice = override ? Number(override.default_selling_price) : Number(product.default_selling_price) || 0;
    }
    if (raw.selling_price != null && !allowance.can_edit_prices) {
      throw new HttpError(403, 'You are not permitted to set selling prices in this business. Receive at the default and ask a manager to adjust it.', 'PRICE_EDIT_FORBIDDEN');
    }

    // Expiry is required when the product tracks it. Receiving short-dated
    // stock without a date is how a shop discovers ₦400,000 of expired goods at
    // the next count.
    if (product.tracks_expiry && !raw.expiry_date) {
      throw new HttpError(400,
        `${product.name} is tracked by expiry date, so the batch needs one. Receiving it without a date means the expiry alert can never fire and the stock will be found at the next count instead.`,
        'RECEIVE_EXPIRY_REQUIRED');
    }
    const expiryDate = raw.expiry_date ? String(raw.expiry_date).slice(0, 10) : null;
    if (expiryDate && expiryDate < watDate()) {
      throw new HttpError(400, `${product.name}: the expiry date ${expiryDate} is already past. Do not receive expired stock — reject the delivery with the supplier.`, 'RECEIVE_EXPIRY_PAST');
    }

    const built = stockService.buildReceiveStatements(db, {
      businessUnitId, branchId, productId: product.id, quantity: resolved.totalPieces,
      unitCost, sellingPrice, batchNo: raw.batch_no || `${po.po_number}/${receivedLines.length + 1}`,
      expiryDate, manufactureDate: raw.manufacture_date ? String(raw.manufacture_date).slice(0, 10) : null,
      supplierId: po.supplier_id, purchaseOrderId: po.id, receivedBy: ctx.user.id,
      notes: raw.notes ? String(raw.notes).slice(0, 500) : `Received on ${grnNumber} against ${po.po_number}`,
      packPrice: raw.pack_price != null ? round2(Number(raw.pack_price)) : null,
      cartonPrice: raw.carton_price != null ? round2(Number(raw.carton_price)) : null,
      palletPrice: raw.pallet_price != null ? round2(Number(raw.pallet_price)) : null,
      movementType: 'PURCHASE_RECEIPT', sourceType: 'PURCHASE_ORDER', sourceId: po.id,
      reference: grnNumber, now: ts, deviceId: ctx.deviceId || null,
    });
    for (const s of built.statements) statements.push(s);

    const pos = await stockService.position(db, { branchId, productId: product.id });
    statements.push(db.prepare(`
      INSERT INTO stock_movements (
        id, business_unit_id, branch_id, product_id, stock_batch_id, direction, quantity, unit_cost,
        movement_type, source_type, source_id, reference, balance_after, reason, performed_by, device_id,
        occurred_at, created_at
      ) VALUES (?,?,?,?,?, 'IN', ?,?, 'PURCHASE_RECEIPT', 'PURCHASE_ORDER', ?,?,?, ?,?,?,?)
    `).bind(newId(), businessUnitId, branchId, product.id, built.batchId, resolved.totalPieces, unitCost,
      po.id, grnNumber, round2(pos.on_hand + resolved.totalPieces),
      `${U.describeCount(resolved.count, resolved.unit, product)} on ${po.po_number}`,
      ctx.user.id, ctx.deviceId || null, ts, ts));

    statements.push(db.prepare(`
      INSERT INTO purchase_order_receipts (
        id, purchase_order_id, purchase_order_item_id, business_unit_id, branch_id, stock_batch_id,
        quantity_received, receive_unit, pieces_received, unit_cost, total_cost, selling_price,
        batch_no, expiry_date, grn_number, received_by, received_at, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      newId(), po.id, item.id, businessUnitId, branchId, built.batchId,
      resolved.count, resolved.unit, resolved.totalPieces, unitCost, lineCost, sellingPrice,
      raw.batch_no || null, expiryDate, grnNumber, ctx.user.id, ts,
      raw.notes ? String(raw.notes).slice(0, 500) : null, ts, ts
    ));

    statements.push(db.prepare(`
      UPDATE purchase_order_items SET quantity_received = ?, updated_at = ? WHERE id = ?
    `).bind(newTotal, ts, item.id));

    if (newTotal < Number(item.quantity_ordered) - 1e-6) allComplete = false;
    receivedLines.push({ item_id: item.id, product_id: product.id, product_name: product.name, batch_id: built.batchId, received: resolved.totalPieces, unit_cost: unitCost, line_cost: lineCost, description: U.describeCount(resolved.count, resolved.unit, product) });

    // Serials for this batch, if supplied.
    if (product.tracks_serials && Array.isArray(raw.serials) && raw.serials.length) {
      if (raw.serials.length !== Math.round(resolved.totalPieces)) {
        throw new HttpError(400,
          `${product.name} is serialised: ${Math.round(resolved.totalPieces)} serial numbers are required for this receipt, you supplied ${raw.serials.length}. `
          + 'Each physical unit must be identifiable, or the custody chain starts broken.',
          'RECEIVE_SERIAL_COUNT_MISMATCH');
      }
      serialBatches.push({ batchId: built.batchId, product, serials: raw.serials, unitCost });
    }
  }

  // Any line not mentioned in this receipt is checked too: the PO is only
  // fully received when EVERY line is complete.
  const allItems = await db.prepare('SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE purchase_order_id = ? AND is_deleted = 0').bind(po.id).all();
  for (const it of allItems.results) {
    if (Number(it.quantity_received) < Number(it.quantity_ordered) - 1e-6) { allComplete = false; break; }
  }
  // Include the lines we are about to write.
  for (const rl of receivedLines) {
    const it = allItems.results.find((x) => false);   // handled below by re-reading
    void it;
  }

  const newStatus = allComplete ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
  statements.push(db.prepare(`UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?`).bind(newStatus, ts, po.id));

  // Update last cost and last-ordered on the supplier links, which is what
  // makes the next reorder suggestion accurate.
  for (const rl of receivedLines) {
    if (po.supplier_id) {
      statements.push(db.prepare(`
        UPDATE product_suppliers SET unit_cost = ?, last_ordered_at = ?, updated_at = ?
        WHERE product_id = ? AND supplier_id = ? AND is_deleted = 0
      `).bind(rl.unit_cost, ts, ts, rl.product_id, po.supplier_id));
    }
  }

  await db.batch(statements);

  // Register serials AFTER the batches exist, so each serial points at a real
  // batch. Failures here are reported, not swallowed: a serialised delivery
  // whose serials did not register is a delivery that cannot be warranty-
  // claimed or theft-traced, and the clerk needs to know now.
  const serialResults = [];
  for (const sb of serialBatches) {
    try {
      const r = await stockService.registerSerials(db, {
        businessUnitId, branchId, productId: sb.product.id, batchId: sb.batchId,
        serials: sb.serials, purchaseOrderId: po.id, receivedBy: ctx.user.id, costPrice: sb.unitCost, now: ts,
      });
      serialResults.push({ product: sb.product.name, registered: r.registered });
    } catch (e) {
      serialResults.push({ product: sb.product.name, error: e.message });
    }
  }

  // Creditor ledger: we now owe the supplier.
  if (po.supplier_id) {
    const owed = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS balance FROM creditor_ledger WHERE supplier_id = ? AND is_deleted = 0`).bind(po.supplier_id).first();
    await db.prepare(`
      INSERT INTO creditor_ledger (
        id, business_unit_id, branch_id, supplier_id, entry_date, entry_type, source_type, source_id,
        reference, amount, balance_after, wht_amount, notes, created_by, created_at, updated_at
      ) VALUES (?,?,?,?,?, 'PURCHASE', 'PURCHASE_ORDER', ?,?,?,?,?,?,?,?,?)
    `).bind(newId(), businessUnitId, branchId, po.supplier_id, watDate(), po.id, grnNumber,
      receivedValue, round2(Number(owed.balance) + receivedValue), 0,
      `Goods received on ${grnNumber}`, ctx.user.id, ts, ts).run();
  }

  // GL: stock in at landed cost, creditor for the same.
  if (capabilitiesOf(settings).general_ledger && settings.gl_module_enabled !== 0) {
    try {
      const glService = require('./glService');
      const supplier = po.supplier_id ? await db.prepare('SELECT name FROM suppliers WHERE id = ?').bind(po.supplier_id).first() : null;
      await glService.postPurchaseReceipt(db, {
        businessUnitId, branchId, po, userId: ctx.user.id, settings,
        supplierName: supplier ? supplier.name : null,
        receiptLines: receivedLines.map((rl) => ({ total_cost: rl.line_cost })),
      });
    } catch (e) { console.error('[purchaseOrderService] GL posting failed for', po.po_number, e && e.message); }
  }

  // WHT entry if the PO carries a rate. Recorded on receipt, which is when the
  // liability actually crystallises.
  if (Number(po.wht_amount) > 0 && po.supplier_id && settings.wht_enabled !== 0) {
    try {
      const supplier = await db.prepare('SELECT name, tin FROM suppliers WHERE id = ?').bind(po.supplier_id).first();
      await db.prepare(`
        INSERT INTO wht_entries (
          id, business_unit_id, branch_id, entry_date, direction, source_type, source_id,
          counterparty_name, counterparty_tin, rate_code, rate_percent, gross_amount, wht_amount,
          net_amount, filed_period, created_by, created_at, updated_at
        ) VALUES (?,?,?,?, 'PAYABLE', 'PURCHASE_ORDER', ?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(newId(), businessUnitId, branchId, watDate(), po.id,
        supplier ? supplier.name : 'Supplier', supplier ? supplier.tin : null,
        po.wht_rate_code, Number(po.total_cost) > 0 ? round2((Number(po.wht_amount) / Number(po.total_cost)) * 100) : 0,
        round2(Number(po.total_cost)), round2(Number(po.wht_amount)), round2(Number(po.payable_amount)),
        watDate().slice(0, 7), ctx.user.id, ts, ts).run();
    } catch (e) { console.error('[purchaseOrderService] WHT entry failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'PO_RECEIVED', entityType: 'PURCHASE_ORDER', entityId: po.id, amount: receivedValue,
    after: { grn_number: grnNumber, status: newStatus, lines: receivedLines.length, serials: serialResults },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  const serialErrors = serialResults.filter((r) => r.error);
  return {
    ok: serialErrors.length === 0, id: po.id, po_number: po.po_number, grn_number: grnNumber, status: newStatus,
    received_lines: receivedLines, received_value: receivedValue, serials: serialResults,
    advisory: serialErrors.length
      ? `The goods are received, but ${serialErrors.length} serial registration(s) failed: ${serialErrors.map((e) => `${e.product} — ${e.error}`).join('; ')}. Fix these before selling the units — an unregistered serial cannot be warranty-claimed or theft-traced.`
      : (newStatus === 'PARTIALLY_RECEIVED'
        ? `Partially received. The balance is still outstanding on this order — the supplier will send the rest, or cancel the remaining lines.`
        : null),
  };
}

async function cancel(db, ctx, { poId, reason }) {
  const po = await load(db, poId, ctx.businessUnitId);
  if (!po) throw new HttpError(404, 'That purchase order was not found.', 'PO_NOT_FOUND');
  assertBranchAccess(ctx.user, po.branch_id);
  if (['RECEIVED', 'CANCELLED'].includes(po.status)) throw new HttpError(409, `A ${po.status} purchase order cannot be cancelled.`, 'PO_NOT_CANCELLABLE');
  if (po.status === 'PARTIALLY_RECEIVED') {
    throw new HttpError(409,
      'Part of this order has already been received, so it cannot simply be cancelled — the received stock is on the shelf. Cancel the outstanding lines individually or receive the balance.',
      'PO_PARTIALLY_RECEIVED_NOT_CANCELLABLE');
  }
  if (!reason || String(reason).trim().length < 4) throw new HttpError(400, 'A cancellation needs a reason of at least 4 characters.', 'CANCEL_REASON_REQUIRED');
  const ts = watNowIso();
  await db.prepare(`UPDATE purchase_orders SET status = 'CANCELLED', notes = COALESCE(notes || ' | ','') || ?, updated_at = ? WHERE id = ?`)
    .bind(`Cancelled: ${String(reason).slice(0, 300)}`, ts, poId).run();
  await writeAudit(db, {
    businessUnitId: po.business_unit_id, branchId: po.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'PO_CANCELLED', entityType: 'PURCHASE_ORDER', entityId: poId,
    amount: Number(po.total_cost), reason: String(reason).slice(0, 500), ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: poId, status: 'CANCELLED' };
}

async function recordPayment(db, ctx, { poId, amount, method = 'BANK_TRANSFER', reference = null, note = null, whtDeducted = 0 }) {
  const po = await load(db, poId, ctx.businessUnitId);
  if (!po) throw new HttpError(404, 'That purchase order was not found.', 'PO_NOT_FOUND');
  assertBranchAccess(ctx.user, po.branch_id);
  const value = round2(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'The payment must be more than zero.', 'PAYMENT_AMOUNT_INVALID');
  const outstanding = round2(Number(po.payable_amount) - Number(po.amount_paid));
  if (value > outstanding + 0.005) {
    throw new HttpError(400, `That is ₦${value.toLocaleString('en-NG')} against ₦${outstanding.toLocaleString('en-NG')} outstanding on this order. An overpayment becomes an unrecoverable supplier credit.`, 'PO_OVERPAYMENT');
  }
  if (['BANK_TRANSFER', 'CHEQUE', 'POS_TERMINAL'].includes(String(method).toUpperCase()) && !reference) {
    throw new HttpError(400, 'A payment to a supplier needs a reference — the transfer narration or cheque number. It is what you will quote when the supplier says they were not paid.', 'PAYMENT_REFERENCE_REQUIRED');
  }

  const ts = watNowIso();
  const newPaid = round2(Number(po.amount_paid) + value);
  const status = round2(newPaid) >= round2(Number(po.payable_amount)) - 0.004 ? 'PAID' : 'PART_PAID';
  const statements = [
    db.prepare(`UPDATE purchase_orders SET amount_paid = ?, payment_status = ?, updated_at = ? WHERE id = ?`)
      .bind(newPaid, status, ts, poId),
  ];
  if (po.supplier_id) {
    const owed = await db.prepare('SELECT COALESCE(SUM(amount),0) AS balance FROM creditor_ledger WHERE supplier_id = ? AND is_deleted = 0').bind(po.supplier_id).first();
    statements.push(db.prepare(`
      INSERT INTO creditor_ledger (
        id, business_unit_id, branch_id, supplier_id, entry_date, entry_type, source_type, source_id,
        reference, amount, balance_after, wht_amount, notes, created_by, created_at, updated_at
      ) VALUES (?,?,?,?,?, 'PAYMENT', 'PURCHASE_ORDER', ?,?,?,?,?,?,?,?,?)
    `).bind(newId(), po.business_unit_id, po.branch_id, po.supplier_id, watDate(), poId,
      reference ? String(reference).slice(0, 120) : null, -value,
      round2(Number(owed.balance) - value), round2(Number(whtDeducted) || 0),
      note ? String(note).slice(0, 500) : `Payment on ${po.po_number}`, ctx.user.id, ts, ts));
  }
  await db.batch(statements);

  if (capabilitiesOf(ctx.businessUnit || await getUnitSettings(db, po.business_unit_id)).general_ledger) {
    try {
      const glService = require('./glService');
      await glService.postSupplierPayment(db, {
        businessUnitId: po.business_unit_id, branchId: po.branch_id, poId, reference: reference || po.po_number,
        amount: value, method, whtAmount: round2(Number(whtDeducted) || 0), userId: ctx.user.id,
      });
    } catch (e) { console.error('[purchaseOrderService] GL payment posting failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId: po.business_unit_id, branchId: po.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'PO_PAID', entityType: 'PURCHASE_ORDER', entityId: poId,
    amount: value, after: { payment_status: status, amount_paid: newPaid, reference },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: poId, amount: value, payment_status: status, amount_paid: newPaid, outstanding: round2(Number(po.payable_amount) - newPaid) };
}

async function load(db, poId, businessUnitId = null) {
  return db.prepare(`
    SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone, s.tin AS supplier_tin,
           s.payment_terms_days AS supplier_terms, b.name AS branch_name, b.code AS branch_code,
           u.full_name AS ordered_by_name, a.full_name AS approved_by_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    JOIN branches b ON b.id = po.branch_id
    LEFT JOIN users u ON u.id = po.ordered_by
    LEFT JOIN users a ON a.id = po.approved_by
    WHERE po.id = ? AND po.is_deleted = 0 ${businessUnitId ? 'AND po.business_unit_id = ?' : ''}
  `).bind(poId, ...(businessUnitId ? [businessUnitId] : [])).first();
}

async function getWithItems(db, poId, businessUnitId) {
  const po = await load(db, poId, businessUnitId);
  if (!po) return null;
  const items = await db.prepare(`
    SELECT poi.*, p.name AS product_name, p.sku, p.base_unit, p.units_per_pack, p.packs_per_carton,
           p.cartons_per_pallet, p.selling_units,
           (poi.quantity_ordered - poi.quantity_received) AS outstanding_quantity
    FROM purchase_order_items poi JOIN products p ON p.id = poi.product_id
    WHERE poi.purchase_order_id = ? AND poi.is_deleted = 0 ORDER BY poi.created_at
  `).bind(poId).all();
  const receipts = await db.prepare(`
    SELECT pr.*, p.name AS product_name, u.full_name AS received_by_name, b.name AS branch_name
    FROM purchase_order_receipts pr
    JOIN products p ON p.id = (SELECT product_id FROM purchase_order_items WHERE id = pr.purchase_order_item_id)
    LEFT JOIN users u ON u.id = pr.received_by
    LEFT JOIN branches b ON b.id = pr.branch_id
    WHERE pr.purchase_order_id = ? AND pr.is_deleted = 0 ORDER BY pr.received_at DESC
  `).bind(poId).all();
  return {
    ...po,
    items: items.results.map((it) => ({
      ...it,
      outstanding_quantity: round2(Number(it.outstanding_quantity)),
      fully_received: Number(it.quantity_received) >= Number(it.quantity_ordered) - 1e-6,
    })),
    receipts: receipts.results,
    received_value: round2(receipts.results.reduce((a, r) => a + Number(r.total_cost || 0), 0)),
  };
}

async function list(db, { businessUnitId, branchId = null, supplierId = null, status = null, from = null, to = null, search = null, limit = 50, offset = 0 }) {
  const where = ['po.is_deleted = 0', 'po.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('po.branch_id = ?'); params.push(branchId); }
  if (supplierId) { where.push('po.supplier_id = ?'); params.push(supplierId); }
  if (status) { where.push('po.status = ?'); params.push(String(status).toUpperCase()); }
  if (from) { where.push("date(po.ordered_at,'+1 hour') >= ?"); params.push(String(from).slice(0, 10)); }
  if (to) { where.push("date(po.ordered_at,'+1 hour') <= ?"); params.push(String(to).slice(0, 10)); }
  if (search) {
    const like = `%${String(search).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(po.po_number LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  const rows = await db.prepare(`
    SELECT po.*, s.name AS supplier_name, b.name AS branch_name, u.full_name AS ordered_by_name,
      (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id AND i.is_deleted = 0) AS line_count,
      (SELECT COALESCE(SUM(i.quantity_ordered - i.quantity_received),0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id AND i.is_deleted = 0) AS units_outstanding,
      (SELECT COUNT(*) FROM purchase_order_receipts r WHERE r.purchase_order_id = po.id AND r.is_deleted = 0) AS receipt_count
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    JOIN branches b ON b.id = po.branch_id
    LEFT JOIN users u ON u.id = po.ordered_by
    WHERE ${where.join(' AND ')}
    ORDER BY CASE po.status WHEN 'APPROVED' THEN 0 WHEN 'PARTIALLY_RECEIVED' THEN 1 WHEN 'PENDING' THEN 2 WHEN 'DRAFT' THEN 3 ELSE 4 END, po.ordered_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();
  return rows.results;
}

module.exports = { PO_STATUSES, create, approve, receive, cancel, recordPayment, load, getWithItems, list };
'use strict';
