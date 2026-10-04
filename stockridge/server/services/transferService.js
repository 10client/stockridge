// =====================================================================
// StockRidge — INTER-BRANCH TRANSFERS
// =====================================================================
// A transfer is a THREE-STATE document, never a two-state one:
//
//   PENDING      requested, stock still at the origin and still sellable
//   IN_TRANSIT   dispatched: origin has decremented, destination has NOT
//                yet received. The goods are on a truck.
//   RECEIVED     destination has counted them in.
//
// WHY THE MIDDLE STATE IS NOT OPTIONAL: collapsing dispatch and receipt
// into one action means stock is either double-counted (both branches show
// it) or vanishes (neither does) for the hours a truck is on the Lagos–Abuja
// road. A goods_in_transit account exists in the chart of accounts for
// exactly this window, and the IN_TRANSIT status is what feeds it.
//
// PARTIAL RECEIPT AND DISCREPANCY are first-class. A transfer of 40 cartons
// that arrives with 38 — two crushed in transit — is the normal case in
// Nigerian logistics, not an exception. The receiving branch records what it
// actually counted; the difference is posted as a discrepancy against the
// transfer, which becomes a stock adjustment at the ORIGIN branch (where the
// goods were when they were damaged) with the transfer as its reference. That
// attribution is the point: without it, the shrinkage lands on whichever
// branch happened to be counting, and the real cause is never addressed.
//
// SERIALISED ITEMS: the serials move too, and their branch_id is updated. A
// serial that appears at a branch it was never transferred to is a red flag
// on its own — which only works if transfers are the only way a serial
// changes branch.
// =====================================================================

const { newId, watNowIso } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const stockService = require('./stockService');
const { PREFIXES, nextReference } = require('../lib/references');
const { writeAudit, appendRegister } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { capabilitiesOf } = require('../lib/capabilities');
const { getUnitSettings, assertSubscribed } = require('../lib/planLimits');

const STATUSES = ['PENDING', 'IN_TRANSIT', 'RECEIVED', 'PARTIALLY_RECEIVED', 'CANCELLED', 'DISCREPANCY'];

async function create(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'create a stock transfer' });

  const caps = capabilitiesOf(settings);
  if (!caps.multi_branch) {
    throw new HttpError(403, 'This business profile does not use multiple branches, so there is nothing to transfer between.', 'CAPABILITY_DISABLED');
  }

  const fromBranchId = input.from_branch_id || ctx.user.branch_id;
  const toBranchId = input.to_branch_id;
  if (!fromBranchId || !toBranchId) throw new HttpError(400, 'Both the sending and the receiving branch are required.', 'TRANSFER_BRANCHES_REQUIRED');
  if (fromBranchId === toBranchId) {
    throw new HttpError(400, 'A branch cannot transfer stock to itself.', 'TRANSFER_SAME_BRANCH');
  }
  assertBranchAccess(ctx.user, fromBranchId);
  assertBranchAccess(ctx.user, toBranchId);

  for (const id of [fromBranchId, toBranchId]) {
    const b = await db.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0 AND is_active = 1').bind(id).first();
    if (!b) throw new HttpError(404, 'One of those branches was not found or is not active.', 'BRANCH_NOT_FOUND');
    if (b.business_unit_id !== businessUnitId) {
      throw new HttpError(403, 'Stock cannot be transferred between two different businesses.', 'TRANSFER_CROSS_BUSINESS');
    }
  }

  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw new HttpError(400, 'A transfer needs at least one item.', 'TRANSFER_EMPTY');
  if (items.length > 300) throw new HttpError(400, 'A single transfer cannot hold more than 300 lines. Split it.', 'TRANSFER_TOO_MANY_LINES');

  const ts = watNowIso();
  const transferId = newId();
  const fromBranch = await db.prepare('SELECT code FROM branches WHERE id = ?').bind(fromBranchId).first();
  const transferNo = input.transfer_no
    || (await nextReference(db, { businessUnitId, prefix: PREFIXES.TRANSFER, branchCode: fromBranch.code || '*', scope: 'YEAR' })).reference;

  const statements = [];
  const resolvedItems = [];
  let totalCost = 0;
  let totalRetail = 0;

  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (!raw.product_id) throw new HttpError(400, `Line ${i + 1}: choose a product.`, 'PRODUCT_REQUIRED');
    const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(raw.product_id).first();
    if (!product) throw new HttpError(404, `Line ${i + 1}: that product was not found.`, 'PRODUCT_NOT_FOUND');

    const qty = Number(raw.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new HttpError(400, `Line ${i + 1} (${product.name}): quantity must be greater than zero.`, 'TRANSFER_QUANTITY_INVALID');
    }

    const pos = await stockService.position(db, { branchId: fromBranchId, productId: product.id });
    if (pos.available < qty) {
      throw new HttpError(409,
        `Line ${i + 1}: only ${pos.available.toLocaleString('en-NG')} of "${product.name}" is available at the sending branch `
        + `(${pos.on_hand.toLocaleString('en-NG')} on hand, ${pos.reserved.toLocaleString('en-NG')} already committed to holds and deliveries).`,
        'TRANSFER_INSUFFICIENT_STOCK');
    }

    // Serialised stock: name the units. A transfer that moves 3 phones
    // without naming which 3 is how an IMEI ends up at a branch that cannot
    // account for it.
    let serialIds = [];
    if (product.tracks_serials) {
      serialIds = Array.isArray(raw.serial_ids) ? raw.serial_ids.map(String) : [];
      if (serialIds.length !== Math.round(qty)) {
        throw new HttpError(400,
          `Line ${i + 1}: "${product.name}" is serialised — select exactly ${Math.round(qty)} serial number${Math.round(qty) === 1 ? '' : 's'} (you selected ${serialIds.length}).`,
          'SERIAL_COUNT_MISMATCH');
      }
      for (const sid of serialIds) {
        const s = await db.prepare('SELECT * FROM product_serials WHERE id = ? AND is_deleted = 0').bind(sid).first();
        if (!s) throw new HttpError(404, `Line ${i + 1}: serial ${sid} was not found.`, 'SERIAL_NOT_FOUND');
        if (s.branch_id !== fromBranchId) {
          throw new HttpError(409, `Line ${i + 1}: serial ${s.serial_no} is not at the sending branch.`, 'SERIAL_WRONG_BRANCH');
        }
        if (s.status !== 'IN_STOCK') {
          throw new HttpError(409, `Line ${i + 1}: serial ${s.serial_no} is ${String(s.status).replace(/_/g, ' ').toLowerCase()} and cannot be transferred.`, 'SERIAL_NOT_TRANSFERABLE');
        }
      }
    }

    // Valuation. AT_COST is the default and the honest one: AT_RETAIL would
    // inflate the receiving branch's stock value with profit nobody has
    // earned, and the group's consolidated margin would then depend on how
    // much stock happened to be mid-transfer on the reporting date.
    const valuation = String(input.valuation || 'AT_COST').toUpperCase();
    const unitCost = round2(pos.on_hand > 0 ? (await stockService.averageCost(db, { branchId: fromBranchId, productId: product.id })) : Number(product.default_cost_price) || 0);
    const retail = round2(await retailPriceAt(db, { branchId: fromBranchId, productId: product.id, fallback: product.default_selling_price }));
    const lineCost = round2(unitCost * qty);
    const lineRetail = round2(retail * qty);
    totalCost = round2(totalCost + lineCost);
    totalRetail = round2(totalRetail + lineRetail);

    resolvedItems.push({
      product_id: product.id, product_name: product.name, quantity: qty,
      unit_cost: unitCost, retail_price: retail, serial_ids: serialIds,
      from_batch_id: raw.from_batch_id || null, note: raw.note || null,
    });

    statements.push(db.prepare(`
      INSERT INTO stock_transfer_items (
        id, transfer_id, business_unit_id, product_id, from_batch_id, quantity_requested,
        quantity_dispatched, quantity_received, unit_cost, serial_ids_json, created_at, updated_at
      ) VALUES (?,?,?,?,?, 0, 0, ?,?,?,?)
    `).bind(newId(), transferId, businessUnitId, product.id, raw.from_batch_id || null, qty,
      unitCost, serialIds.length ? JSON.stringify(serialIds) : null, ts, ts));
  }

  statements.push(db.prepare(`
    INSERT INTO stock_transfers (
      id, business_unit_id, transfer_no, from_branch_id, to_branch_id, status, transfer_type,
      requested_by, valuation, total_cost_value, total_retail_value, vehicle_id, waybill_no, notes,
      created_at, updated_at
    ) VALUES (?,?,?,?,?, 'PENDING', ?,?,?,?, ?,?,?,?,?)
  `).bind(
    transferId, businessUnitId, transferNo, fromBranchId, toBranchId,
    String(input.transfer_type || 'STOCK_REBALANCE').toUpperCase(),
    ctx.user.id, valuation, totalCost, totalRetail,
    input.vehicle_id || null, input.waybill_no || null, input.notes || null, ts, ts
  ));

  await db.batch(statements);
  await writeAudit(db, {
    businessUnitId, branchId: fromBranchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'TRANSFER_CREATED', entityType: 'TRANSFER', entityId: transferId, amount: totalCost,
    after: { transfer_no: transferNo, to_branch_id: toBranchId, lines: resolvedItems.length },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id: transferId, transfer_no: transferNo, status: 'PENDING', items: resolvedItems, total_cost_value: totalCost, total_retail_value: totalRetail };
}

async function retailPriceAt(db, { branchId, productId, fallback = 0 }) {
  const override = await db.prepare(`
    SELECT default_selling_price FROM product_price_overrides
    WHERE branch_id = ? AND product_id = ? AND is_deleted = 0
      AND (effective_to IS NULL OR effective_to >= date('now','+1 hour'))
    ORDER BY effective_from DESC LIMIT 1
  `).bind(branchId, productId).first();
  if (override) return Number(override.default_selling_price) || 0;
  const batch = await db.prepare(`
    SELECT selling_price_per_unit FROM stock_batches
    WHERE branch_id = ? AND product_id = ? AND is_deleted = 0 AND status = 'ACTIVE' AND quantity_remaining > 0
    ORDER BY received_at DESC LIMIT 1
  `).bind(branchId, productId).first();
  return batch ? Number(batch.selling_price_per_unit) || 0 : Number(fallback) || 0;
}

// DISPATCH: origin decrements, goods go into transit.
async function dispatch(db, ctx, { transferId, vehicleId = null, waybillNo = null, notes = null }) {
  const t = await load(db, transferId, ctx.businessUnitId);
  if (!t) throw new HttpError(404, 'That transfer was not found.', 'TRANSFER_NOT_FOUND');
  assertBranchAccess(ctx.user, t.from_branch_id);
  if (t.status !== 'PENDING') throw new HttpError(409, `Only a PENDING transfer can be dispatched — this one is ${t.status}.`, 'TRANSFER_NOT_DISPATCHABLE');

  const ts = watNowIso();
  const items = await db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id = ? AND is_deleted = 0').bind(transferId).all();
  const statements = [];

  for (const item of items.results) {
    const qty = Number(item.quantity_requested) || 0;
    if (qty <= 0) continue;

    // Consume from the origin. buildConsumeStatements throws if the stock is
    // not there — which is the right answer, because between requesting and
    // dispatching a cashier may have sold it, and dispatching stock you no
    // longer hold is how a transfer arrives short with nobody able to say why.
    const consumed = await stockService.buildConsumeStatements(db, {
      businessUnitId: t.business_unit_id, branchId: t.from_branch_id, productId: item.product_id,
      quantityBase: qty, movementType: 'TRANSFER_OUT', sourceType: 'TRANSFER', sourceId: transferId,
      reference: t.transfer_no, reason: `Dispatched to ${t.to_branch_id}`, performedBy: ctx.user.id,
      deviceId: ctx.deviceId || null, now: ts,
    });
    for (const s of consumed.statements) statements.push(s);

    statements.push(db.prepare(`
      UPDATE stock_transfer_items SET quantity_dispatched = ?, updated_at = ? WHERE id = ?
    `).bind(qty, ts, item.id));

    if (item.serial_ids_json) {
      let serialIds = [];
      try { serialIds = JSON.parse(item.serial_ids_json); } catch (_) { serialIds = []; }
      for (const sid of serialIds) {
        statements.push(db.prepare(`
          UPDATE product_serials SET status = 'IN_TRANSIT', updated_at = ? WHERE id = ? AND status = 'IN_STOCK'
        `).bind(ts, sid));
      }
    }
  }

  statements.push(db.prepare(`
    UPDATE stock_transfers
    SET status = 'IN_TRANSIT', dispatched_by = ?, dispatched_at = ?, vehicle_id = COALESCE(?, vehicle_id),
        waybill_no = COALESCE(?, waybill_no), notes = COALESCE(?, notes), updated_at = ?
    WHERE id = ?
  `).bind(ctx.user.id, ts, vehicleId, waybillNo, notes, ts, transferId));

  await db.batch(statements);

  await writeAudit(db, {
    businessUnitId: t.business_unit_id, branchId: t.from_branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'TRANSFER_DISPATCHED', entityType: 'TRANSFER', entityId: transferId,
    amount: Number(t.total_cost_value), after: { status: 'IN_TRANSIT', waybill_no: waybillNo },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id: transferId, status: 'IN_TRANSIT', dispatched_at: ts };
}

// RECEIVE: destination counts in. Quantities are the RECEIVED ones, which
// may be fewer than dispatched; the difference is a discrepancy.
async function receive(db, ctx, { transferId, receivedItems = null, notes = null, acceptAsDispatched = false }) {
  const t = await load(db, transferId, ctx.businessUnitId);
  if (!t) throw new HttpError(404, 'That transfer was not found.', 'TRANSFER_NOT_FOUND');
  assertBranchAccess(ctx.user, t.to_branch_id);
  if (!['IN_TRANSIT', 'PENDING'].includes(t.status)) {
    throw new HttpError(409, `Only an IN_TRANSIT transfer can be received — this one is ${t.status}.`, 'TRANSFER_NOT_RECEIVABLE');
  }
  if (t.status === 'PENDING') {
    throw new HttpError(409, 'This transfer has not been dispatched yet. Dispatch it first — receiving an undispatched transfer would double-count the stock.', 'TRANSFER_NOT_DISPATCHED');
  }

  const ts = watNowIso();
  const items = await db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id = ? AND is_deleted = 0').bind(transferId).all();
  const receivedMap = new Map();
  if (Array.isArray(receivedItems)) {
    for (const r of receivedItems) {
      if (!r || !r.product_id) continue;
      receivedMap.set(String(r.product_id), Number(r.quantity_received));
    }
  }

  const statements = [];
  const discrepancies = [];
  let receivedValue = 0;
  let discrepancyValue = 0;

  for (const item of items.results) {
    const dispatched = Number(item.quantity_dispatched) || 0;
    if (dispatched <= 0) continue;
    const counted = acceptAsDispatched
      ? dispatched
      : (receivedMap.has(String(item.product_id)) ? Number(receivedMap.get(String(item.product_id))) : dispatched);

    if (!Number.isFinite(counted) || counted < 0) {
      throw new HttpError(400, `Received quantity for line ${item.id} must be zero or more.`, 'RECEIVE_QUANTITY_INVALID');
    }
    if (counted > dispatched) {
      throw new HttpError(400,
        `You counted ${counted} but only ${dispatched} were dispatched on this line. Extra stock cannot arrive on a transfer — record it as a stock adjustment with a reason instead.`,
        'RECEIVE_MORE_THAN_DISPATCHED');
    }

    const short = round2(dispatched - counted);
    const unitCost = Number(item.unit_cost) || 0;

    // Create a batch at the destination carrying the ORIGIN's cost, so group
    // valuation does not change because stock moved between two rooms.
    const batchId = newId();
    if (counted > 0) {
      const retail = await retailPriceAt(db, { branchId: t.to_branch_id, productId: item.product_id, fallback: 0 });
      statements.push(db.prepare(`
        INSERT INTO stock_batches (
          id, business_unit_id, branch_id, product_id, batch_no, transfer_id,
          quantity_received, quantity_remaining, quantity_reserved, unit_cost, total_cost,
          selling_price_per_unit, received_at, received_by, status, notes, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?, 0, ?,?,?, ?,?, 'ACTIVE', ?,?,?)
      `).bind(
        batchId, t.business_unit_id, t.to_branch_id, item.product_id,
        `${t.transfer_no}/${items.results.indexOf(item) + 1}`, transferId,
        counted, counted, unitCost, round2(unitCost * counted), retail, ts, ctx.user.id,
        `Received on transfer ${t.transfer_no}`, ts, ts
      ));
      receivedValue = round2(receivedValue + unitCost * counted);

      const destPos = await stockService.position(db, { branchId: t.to_branch_id, productId: item.product_id });
      statements.push(db.prepare(`
        INSERT INTO stock_movements (
          id, business_unit_id, branch_id, product_id, stock_batch_id, direction, quantity, unit_cost,
          movement_type, source_type, source_id, reference, balance_after, reason, performed_by, device_id,
          occurred_at, created_at
        ) VALUES (?,?,?,?,?, 'IN', ?,?, 'TRANSFER_IN', 'TRANSFER', ?,?,?,?, ?,?,?,?)
      `).bind(
        newId(), t.business_unit_id, t.to_branch_id, item.product_id, batchId, counted, unitCost,
        transferId, t.transfer_no, round2(destPos.on_hand + counted),
        `Transfer ${t.transfer_no}`, ctx.user.id, ctx.deviceId || null, ts, ts
      ));

      // Serials arrive and become sellable at the destination.
      if (item.serial_ids_json) {
        let serialIds = [];
        try { serialIds = JSON.parse(item.serial_ids_json); } catch (_) { serialIds = []; }
        for (const sid of serialIds.slice(0, Math.round(counted))) {
          statements.push(db.prepare(`
            UPDATE product_serials SET status = 'IN_STOCK', branch_id = ?, stock_batch_id = ?, updated_at = ?
            WHERE id = ? AND status = 'IN_TRANSIT'
          `).bind(t.to_branch_id, batchId, ts, sid));
        }
      }
    }

    if (short > 0) {
      discrepancyValue = round2(discrepancyValue + unitCost * short);
      discrepancies.push({ product_id: item.product_id, dispatched, counted: Math.round(counted), short, unit_cost: unitCost, value: round2(unitCost * short) });
      // Any serials that did not arrive are LOST in transit, not silently
      // dropped from the record. The alternative is an IMEI that is still
      // IN_TRANSIT forever, which no report can distinguish from a truck
      // that is genuinely still on the road.
      if (item.serial_ids_json) {
        let serialIds = [];
        try { serialIds = JSON.parse(item.serial_ids_json); } catch (_) { serialIds = []; }
        for (const sid of serialIds.slice(Math.round(counted))) {
          statements.push(db.prepare(`
            UPDATE product_serials SET status = 'LOST', notes = COALESCE(notes || ' | ','') || ?, updated_at = ?
            WHERE id = ? AND status = 'IN_TRANSIT'
          `).bind(`Not received on transfer ${t.transfer_no}`, ts, sid));
        }
      }
    }

    statements.push(db.prepare(`
      UPDATE stock_transfer_items
      SET quantity_received = ?, to_batch_id = ?, discrepancy_qty = ?,
          discrepancy_note = ?, updated_at = ?
      WHERE id = ?
    `).bind(counted, counted > 0 ? batchId : null, short, short > 0 ? `Short by ${short}` : null, ts, item.id));
  }

  const status = discrepancies.length ? 'DISCREPANCY' : 'RECEIVED';
  statements.push(db.prepare(`
    UPDATE stock_transfers
    SET status = ?, received_by = ?, received_at = ?, discrepancy_note = ?, notes = COALESCE(?, notes), updated_at = ?
    WHERE id = ?
  `).bind(status, ctx.user.id, ts, discrepancies.length ? `${discrepancies.length} line(s) short by ₦${discrepancyValue.toLocaleString('en-NG')} at cost` : null, notes, ts, transferId));

  await db.batch(statements);

  // A discrepancy posts a write-off at the ORIGIN branch, because that is
  // where the goods were when they were lost. Attributing it to the receiving
  // branch would put the shrinkage on the manager who reported it honestly.
  if (discrepancies.length) {
    for (const d of discrepancies) {
      try {
        const adjustmentService = require('./adjustmentService');
        await adjustmentService.create(db, ctx, {
          branch_id: t.from_branch_id,
          product_id: d.product_id,
          adjustment_type: 'LOSS',
          quantity: -d.short,
          reason: `Short on transfer ${t.transfer_no}: dispatched ${d.dispatched}, received ${d.counted}.`,
          reference: t.transfer_no,
          skipAuthorityCheck: true,       // the transfer itself is the authority
        });
      } catch (e) {
        console.error('[transferService] discrepancy adjustment failed for', t.transfer_no, e && e.message);
      }
    }
  }

  await writeAudit(db, {
    businessUnitId: t.business_unit_id, branchId: t.to_branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'TRANSFER_RECEIVED', entityType: 'TRANSFER', entityId: transferId,
    amount: receivedValue, reason: discrepancies.length ? `${discrepancies.length} discrepancies` : null,
    after: { status, received_value: receivedValue, discrepancy_value: discrepancyValue },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id: transferId, transfer_no: t.transfer_no, status,
    received_value: receivedValue, discrepancies, discrepancy_value: discrepancyValue,
    received_at: ts,
    advisory: discrepancies.length
      ? `${discrepancies.length} line(s) arrived short. The shortage has been written off at the SENDING branch (${discrepancyValue.toLocaleString('en-NG')} at cost) because that is where the goods were when they were lost. Raise it with the driver or the sending storekeeper.`
      : null,
  };
}

async function cancel(db, ctx, { transferId, reason }) {
  const t = await load(db, transferId, ctx.businessUnitId);
  if (!t) throw new HttpError(404, 'That transfer was not found.', 'TRANSFER_NOT_FOUND');
  assertBranchAccess(ctx.user, t.from_branch_id);
  if (!['PENDING', 'IN_TRANSIT'].includes(t.status)) {
    throw new HttpError(409, `A ${t.status} transfer cannot be cancelled.`, 'TRANSFER_NOT_CANCELLABLE');
  }
  if (t.status === 'IN_TRANSIT') {
    // Cancelling an in-transit transfer would strand stock that has already
    // left the origin: decremented there, never received anywhere. Refuse
    // and point at the correct action.
    throw new HttpError(409,
      'This transfer has already been dispatched, so the stock has left the sending branch. It cannot simply be cancelled — receive it at the destination, or record the loss as a discrepancy on receipt.',
      'TRANSFER_IN_TRANSIT_NOT_CANCELLABLE');
  }
  if (!reason || String(reason).trim().length < 4) {
    throw new HttpError(400, 'A cancellation needs a reason of at least 4 characters.', 'CANCEL_REASON_REQUIRED');
  }
  const ts = watNowIso();
  await db.prepare(`
    UPDATE stock_transfers SET status = 'CANCELLED', discrepancy_note = ?, updated_at = ? WHERE id = ?
  `).bind(`Cancelled: ${String(reason).slice(0, 300)}`, ts, transferId).run();
  await writeAudit(db, {
    businessUnitId: t.business_unit_id, branchId: t.from_branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'TRANSFER_CANCELLED', entityType: 'TRANSFER', entityId: transferId,
    reason: String(reason).slice(0, 500), ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: transferId, status: 'CANCELLED' };
}

async function load(db, transferId, businessUnitId = null) {
  return db.prepare(`
    SELECT t.*, fb.name AS from_branch_name, fb.code AS from_branch_code,
           tb.name AS to_branch_name, tb.code AS to_branch_code,
           u.full_name AS requested_by_name, d.full_name AS dispatched_by_name,
           r.full_name AS received_by_name, v.plate_number
    FROM stock_transfers t
    JOIN branches fb ON fb.id = t.from_branch_id
    JOIN branches tb ON tb.id = t.to_branch_id
    LEFT JOIN users u ON u.id = t.requested_by
    LEFT JOIN users d ON d.id = t.dispatched_by
    LEFT JOIN users r ON r.id = t.received_by
    LEFT JOIN delivery_vehicles v ON v.id = t.vehicle_id
    WHERE t.id = ? AND t.is_deleted = 0 ${businessUnitId ? 'AND t.business_unit_id = ?' : ''}
  `).bind(transferId, ...(businessUnitId ? [businessUnitId] : [])).first();
}

async function getWithItems(db, transferId, businessUnitId = null) {
  const t = await load(db, transferId, businessUnitId);
  if (!t) return null;
  const items = await db.prepare(`
    SELECT ti.*, p.name AS product_name, p.sku, p.base_unit, p.tracks_serials,
           (SELECT COUNT(*) FROM product_serials ps WHERE ps.is_deleted = 0 AND ps.id IN (SELECT value FROM json_each(COALESCE(ti.serial_ids_json,'[]')))) AS serial_count
    FROM stock_transfer_items ti
    JOIN products p ON p.id = ti.product_id
    WHERE ti.transfer_id = ? AND ti.is_deleted = 0
    ORDER BY ti.created_at
  `).bind(transferId).all();
  return { ...t, items: items.results };
}

async function list(db, { businessUnitId, branchId = null, status = null, from = null, to = null, direction = 'BOTH', limit = 50, offset = 0 }) {
  const where = ['t.is_deleted = 0', 't.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) {
    if (direction === 'OUT') { where.push('t.from_branch_id = ?'); params.push(branchId); }
    else if (direction === 'IN') { where.push('t.to_branch_id = ?'); params.push(branchId); }
    else { where.push('(t.from_branch_id = ? OR t.to_branch_id = ?)'); params.push(branchId, branchId); }
  }
  if (status) { where.push('t.status = ?'); params.push(String(status).toUpperCase()); }
  if (from) { where.push("date(t.created_at, '+1 hour') >= ?"); params.push(String(from).slice(0, 10)); }
  if (to) { where.push("date(t.created_at, '+1 hour') <= ?"); params.push(String(to).slice(0, 10)); }

  const rows = await db.prepare(`
    SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name,
           (SELECT COUNT(*) FROM stock_transfer_items ti WHERE ti.transfer_id = t.id AND ti.is_deleted = 0) AS line_count,
           (SELECT COALESCE(SUM(ti.quantity_requested),0) FROM stock_transfer_items ti WHERE ti.transfer_id = t.id AND ti.is_deleted = 0) AS units_requested
    FROM stock_transfers t
    JOIN branches fb ON fb.id = t.from_branch_id
    JOIN branches tb ON tb.id = t.to_branch_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.created_at DESC LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();
  return rows.results;
}

module.exports = { STATUSES, create, dispatch, receive, cancel, load, getWithItems, list, retailPriceAt };
'use strict';
