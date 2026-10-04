// =====================================================================
// StockRidge — STOCK SERVICE
// =====================================================================
// The one place stock quantity changes. Every sale, receipt, transfer,
// adjustment, stocktake variance and warranty movement goes through here,
// and nothing else writes stock_batches.quantity_remaining.
//
// WHY ONE PLACE: negative stock is the single failure that makes every
// downstream report lie — valuation, reorder alerts, margin, shrinkage. If
// five modules can decrement a batch, one of them will forget a guard and
// you will find out at the annual count.
//
// BATCH ALLOCATION IS FIFO, with three deliberate refinements:
//
//   1. EXPIRY FIRST. Within the FIFO order, a batch that expires sooner is
//      consumed before an older-received batch that expires later. Pure
//      receipt-date FIFO writes off good stock in a shop that also holds
//      short-dated stock — paint, cement, adhesives, food. Sorting by
//      (expiry_date NULLS LAST, received_at) is what a storekeeper actually
//      does by hand, so the system should do it.
//
//   2. RESERVED STOCK IS EXCLUDED. quantity_reserved is committed to a
//      layaway hold, a delivery job or an instalment plan. Selling it would
//      let two cashiers both promise the last television. `available` =
//      remaining - reserved, and every check uses `available`.
//
//   3. QUARANTINED / RECALLED / EXPIRED BATCHES ARE NEVER ALLOCATED. A
//      recalled item is physically on the shelf and must not be sellable;
//      the status flag is the control that makes that true without someone
//      having to move the boxes.
//
// SERIALISED ITEMS: when a product tracks serials, the sale names WHICH
// physical units left. That is what makes "sell the same phone twice"
// impossible at the data level, and it is what makes a warranty claim
// answerable two years later. A serial in the wrong status is refused
// rather than corrected — silently flipping a SOLD serial back to IN_STOCK
// would destroy the custody chain.
//
// ATOMICITY: every mutating function returns a LIST OF PREPARED STATEMENTS
// (or executes one db.batch). Never sequential awaits. On the Node adapter a
// crash between two awaited writes would take the money and not decrement
// the stock; on D1 there is no client-side transaction at all, so batch() is
// the only atomic primitive either backend has.
// =====================================================================

const { newId, watNowIso } = require('../../shared/ids');
const { HttpError } = require('../lib/http');
const { isFractionalUom } = require('../../shared/units');

const ALLOCATABLE_BATCH_STATUSES = ['ACTIVE'];

// ---------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------

// On-hand, reserved and available for one product at one branch.
async function position(db, { branchId, productId }) {
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(quantity_remaining), 0) AS on_hand,
      COALESCE(SUM(quantity_reserved), 0)  AS reserved,
      COALESCE(SUM(quantity_remaining - quantity_reserved), 0) AS available,
      COALESCE(SUM(quantity_remaining * unit_cost), 0) AS value_at_cost,
      COALESCE(SUM(quantity_remaining * selling_price_per_unit), 0) AS value_at_retail,
      COUNT(*) AS batch_count
    FROM stock_batches
    WHERE branch_id = ? AND product_id = ? AND is_deleted = 0
      AND status NOT IN ('EXPIRED','RECALLED','RETURNED_TO_SUPPLIER')
  `).bind(branchId, productId).first();
  return {
    on_hand: Number((row && row.on_hand) || 0),
    reserved: Number((row && row.reserved) || 0),
    available: Number((row && row.available) || 0),
    value_at_cost: Number((row && row.value_at_cost) || 0),
    value_at_retail: Number((row && row.value_at_retail) || 0),
    batch_count: (row && row.batch_count) || 0,
  };
}

async function positionAll(db, { branchId = null, businessUnitId = null }) {
  const where = [];
  const params = [];
  if (branchId) { where.push('sb.branch_id = ?'); params.push(branchId); }
  if (businessUnitId) { where.push('sb.business_unit_id = ?'); params.push(businessUnitId); }
  const rows = await db.prepare(`
    SELECT sb.product_id,
           COALESCE(SUM(sb.quantity_remaining), 0) AS on_hand,
           COALESCE(SUM(sb.quantity_reserved), 0)  AS reserved,
           COALESCE(SUM(sb.quantity_remaining - sb.quantity_reserved), 0) AS available
    FROM stock_batches sb
    WHERE sb.is_deleted = 0
      AND sb.status NOT IN ('EXPIRED','RECALLED','RETURNED_TO_SUPPLIER')
      ${where.length ? 'AND ' + where.join(' AND ') : ''}
    GROUP BY sb.product_id
  `).bind(...params).all();
  const map = new Map();
  for (const r of rows.results) {
    map.set(r.product_id, {
      on_hand: Number(r.on_hand), reserved: Number(r.reserved), available: Number(r.available),
    });
  }
  return map;
}

async function batchesForProduct(db, { branchId, productId, allocatableOnly = true }) {
  const statusSql = allocatableOnly
    ? `AND status IN (${ALLOCATABLE_BATCH_STATUSES.map(() => '?').join(',')})`
    : '';
  const params = allocatableOnly ? [branchId, productId, ...ALLOCATABLE_BATCH_STATUSES] : [branchId, productId];
  const rows = await db.prepare(`
    SELECT * FROM stock_batches
    WHERE branch_id = ? AND product_id = ? AND is_deleted = 0 ${statusSql}
      AND quantity_remaining > 0
    ORDER BY
      -- Expiry first, then oldest receipt. A NULL expiry sorts LAST so a
      -- non-perishable batch never jumps the queue ahead of short-dated stock.
      CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END ASC,
      expiry_date ASC,
      received_at ASC,
      created_at ASC
  `).bind(...params).all();
  return rows.results;
}

// Weighted-average cost across the batches a branch holds. Used for
// valuation in reports where per-batch FIFO detail is noise.
async function averageCost(db, { branchId, productId }) {
  const pos = await position(db, { branchId, productId });
  if (pos.on_hand <= 0) return 0;
  return pos.value_at_cost / pos.on_hand;
}

// ---------------------------------------------------------------------
// ALLOCATION
// ---------------------------------------------------------------------
// Decide WHICH batches a quantity comes out of, before anything is written.
// Pure: given the batch list and a quantity, returns the split. Kept pure so
// it can be unit-tested exhaustively — this is the function that, if wrong,
// mis-states every margin figure in the business.
function allocateFromBatches(batches, quantityBase, { allowPartial = false, serialIds = null } = {}) {
  const need = Number(quantityBase);
  if (!Number.isFinite(need) || need <= 0) {
    return { ok: false, code: 'QUANTITY_INVALID', error: 'Quantity must be greater than zero.' };
  }
  const lines = [];
  let remaining = need;
  let reservedShortfall = 0;

  for (const b of batches) {
    if (remaining <= 0) break;
    const onHand = Number(b.quantity_remaining) || 0;
    const reserved = Number(b.quantity_reserved) || 0;
    const available = Math.max(0, onHand - reserved);
    if (available <= 0) continue;

    const take = Math.min(available, remaining);
    lines.push({
      batch: b,
      batch_id: b.id,
      quantity: take,
      unit_cost: Number(b.unit_cost) || 0,
      selling_price_per_unit: Number(b.selling_price_per_unit) || 0,
    });
    remaining -= take;
  }

  if (remaining > 1e-9) {
    // Short. Either refuse, or (for a stocktake correction / a manager
    // override) allow it and record exactly how far short we were.
    if (!allowPartial) {
      const got = need - remaining;
      return {
        ok: false,
        code: 'INSUFFICIENT_STOCK',
        error: `Only ${formatQty(got, batches[0])} available${reservedShortfall > 0 ? ` (${formatQty(reservedShortfall, batches[0])} of it already reserved)` : ''}.`,
        requested: need,
        available: got,
        shortfall: remaining,
        allocation: lines,
      };
    }
  }

  // Serialised product: the caller must have named exactly this many serials
  // and every one must be in this branch, IN_STOCK, and in an allocated batch.
  if (serialIds) {
    const totalPieces = lines.reduce((a, l) => a + l.quantity, 0);
    if (serialIds.length !== Math.round(totalPieces)) {
      return {
        ok: false,
        code: 'SERIAL_COUNT_MISMATCH',
        error: `This item is serialised: exactly ${Math.round(totalPieces)} serial number${Math.round(totalPieces) === 1 ? '' : 's'} must be selected for this quantity (you selected ${serialIds.length}).`,
      };
    }
  }

  return { ok: true, allocation: lines, quantity_base: need - remaining };
}

function formatQty(n, sampleBatch) {
  const v = Number(n) || 0;
  return isFractionalUom(sampleBatch && sampleBatch.base_unit)
    ? v.toLocaleString('en-NG', { maximumFractionDigits: 3 })
    : Math.round(v).toLocaleString('en-NG');
}

// Check availability WITHOUT allocating — used by the POS as the basket is
// built, so the cashier finds out at the point of adding, not at checkout.
async function checkAvailability(db, { branchId, productId, quantityBase }) {
  const batches = await batchesForProduct(db, { branchId, productId });
  const result = allocateFromBatches(batches, quantityBase);
  return {
    ok: result.ok,
    requested: Number(quantityBase) || 0,
    available: result.ok ? Number(quantityBase) : (result.available || 0),
    shortfall: result.ok ? 0 : (result.shortfall || 0),
    code: result.ok ? null : result.code,
    error: result.ok ? null : result.error,
    batch_count: batches.length,
  };
}

// ---------------------------------------------------------------------
// WRITES — each returns { statements, meta } for the caller to batch
// ---------------------------------------------------------------------

// Receive stock into a branch, creating a batch. Called by PO receiving,
// opening balances and transfer-in.
function buildReceiveStatements(db, {
  businessUnitId, branchId, productId, quantity, unitCost, sellingPrice,
  batchNo = null, expiryDate = null, manufactureDate = null, supplierId = null,
  purchaseOrderId = null, transferId = null, receivedBy = null, notes = null,
  packPrice = null, cartonPrice = null, palletPrice = null, batchId = null,
  movementType = 'PURCHASE_RECEIPT', sourceType = 'PURCHASE_ORDER', sourceId = null,
  reference = null, reason = null, deviceId = null, now = null,
}) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new HttpError(400, 'Quantity received must be greater than zero.', 'RECEIVE_QUANTITY_INVALID');
  }
  const cost = Number(unitCost);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new HttpError(400, 'Unit cost must be a positive amount.', 'RECEIVE_COST_INVALID');
  }
  const ts = now || watNowIso();
  const id = batchId || newId();

  const batchInsert = db.prepare(`
    INSERT INTO stock_batches (
      id, business_unit_id, branch_id, product_id, batch_no, supplier_id, purchase_order_id, transfer_id,
      quantity_received, quantity_remaining, quantity_reserved, unit_cost, total_cost,
      selling_price_per_unit, pack_price, carton_price, pallet_price,
      received_at, received_by, expiry_date, manufacture_date, status, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?, 'ACTIVE', ?,?,?)
  `).bind(
    id, businessUnitId, branchId, productId, batchNo, supplierId || null, purchaseOrderId || null, transferId || null,
    qty, qty, 0, cost, cost * qty,
    Number(sellingPrice) || 0, packPrice == null ? null : Number(packPrice),
    cartonPrice == null ? null : Number(cartonPrice), palletPrice == null ? null : Number(palletPrice),
    ts, receivedBy || null, expiryDate || null, manufactureDate || null, notes || null, ts, ts
  );

  return { statements: [batchInsert], batchId: id, timestamp: ts, movement: { movementType, sourceType, sourceId, reference, reason, deviceId, quantity: qty, unitCost: cost } };
}

// Consume stock across batches (a sale, a transfer-out, a write-off).
// Returns the statements that decrement batches AND the movement rows, so the
// caller can put the whole thing in one atomic batch.
async function buildConsumeStatements(db, {
  businessUnitId, branchId, productId, quantityBase,
  movementType, sourceType = null, sourceId = null, reference = null,
  reason = null, performedBy = null, deviceId = null,
  batchId = null, serialIds = null, allowPartial = false, now = null,
  fromReserved = false,
}) {
  const ts = now || watNowIso();
  const batches = batchId
    ? (await db.prepare('SELECT * FROM stock_batches WHERE id = ? AND is_deleted = 0').bind(batchId).all()).results
    : await batchesForProduct(db, { branchId, productId });

  if (batchId && !batches.length) {
    throw new HttpError(404, 'That stock batch no longer exists.', 'BATCH_NOT_FOUND');
  }

  const result = allocateFromBatches(batches, quantityBase, { allowPartial, serialIds });
  if (!result.ok) {
    const e = new HttpError(result.code === 'INSUFFICIENT_STOCK' ? 409 : 400, result.error, result.code);
    e.details = { requested: result.requested, available: result.available, shortfall: result.shortfall };
    throw e;
  }

  const statements = [];
  let runningBalance = null;
  const pos = await position(db, { branchId, productId });
  runningBalance = pos.on_hand;

  for (const line of result.allocation) {
    // fromReserved releases a hold rather than taking free stock: a layaway
    // customer collecting their television consumes the RESERVED quantity,
    // and if it were taken from available instead, the reservation would be
    // left dangling against stock that is no longer there.
    if (fromReserved) {
      statements.push(db.prepare(`
        UPDATE stock_batches
        SET quantity_remaining = quantity_remaining - ?,
            quantity_reserved  = MAX(0, quantity_reserved - ?),
            status = CASE WHEN quantity_remaining - ? <= 0 THEN 'DEPLETED' ELSE status END,
            updated_at = ?
        WHERE id = ? AND quantity_remaining >= ? AND quantity_reserved >= ?
      `).bind(line.quantity, line.quantity, line.quantity, ts, line.batch_id, line.quantity, line.quantity));
    } else {
      // `quantity_remaining >= ?` in the WHERE is a second guard against a
      // concurrent write between the read and the write. If it fails, the
      // update touches 0 rows and the caller's balance assertion below
      // catches it — the batch is never driven negative.
      statements.push(db.prepare(`
        UPDATE stock_batches
        SET quantity_remaining = quantity_remaining - ?,
            status = CASE WHEN quantity_remaining - ? <= 0 THEN 'DEPLETED' ELSE status END,
            updated_at = ?
        WHERE id = ? AND quantity_remaining >= ?
      `).bind(line.quantity, line.quantity, ts, line.batch_id, line.quantity));
    }
    runningBalance -= line.quantity;

    statements.push(db.prepare(`
      INSERT INTO stock_movements (
        id, business_unit_id, branch_id, product_id, stock_batch_id, serial_id, direction, quantity,
        unit_cost, movement_type, source_type, source_id, reference, balance_after, reason,
        performed_by, device_id, occurred_at, created_at
      ) VALUES (?,?,?,?,?,?, 'OUT', ?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      newId(), businessUnitId, branchId, productId, line.batch_id, null, line.quantity,
      line.unit_cost, movementType, sourceType, sourceId, reference, runningBalance, reason || null,
      performedBy || null, deviceId || null, ts, ts
    ));
  }

  return { statements, allocation: result.allocation, timestamp: ts, balance_after: runningBalance };
}

// Add stock without a batch context (a found item, a stocktake variance up,
// a warranty return). Uses the newest ACTIVE batch if one exists, otherwise
// creates one at the product's default cost.
async function buildAddStatements(db, args) {
  return buildReceiveStatements(db, { ...args, movementType: args.movementType || 'ADJUSTMENT_FOUND' });
}

// Reserve / release. One mechanism behind layaway, delivery and instalment
// holds — see stock_reservations in the schema.
async function reserve(db, {
  businessUnitId, branchId, productId, quantity, sourceType, sourceId,
  batchId = null, serialId = null, customerId = null, expiresAt = null, reservedBy = null,
}) {
  if (!(quantity > 0)) throw new HttpError(400, 'Reservation quantity must be greater than zero.', 'RESERVE_QUANTITY_INVALID');

  if (serialId) {
    // A serialised item is reserved as a whole; a partial reservation of one
    // physical unit is not a meaningful state.
    const s = await db.prepare('SELECT * FROM product_serials WHERE id = ? AND is_deleted = 0').bind(serialId).first();
    if (!s) throw new HttpError(404, 'That serial number was not found.', 'SERIAL_NOT_FOUND');
    if (s.status !== 'IN_STOCK') {
      throw new HttpError(409, `Serial ${s.serial_no} is ${s.status.replace(/_/g, ' ').toLowerCase()} and cannot be reserved.`, 'SERIAL_NOT_AVAILABLE');
    }
    if (s.branch_id !== branchId) {
      throw new HttpError(409, `Serial ${s.serial_no} is at another branch and cannot be reserved here.`, 'SERIAL_WRONG_BRANCH');
    }
  }

  const targetBatch = batchId || (await newestAllocatableBatch(db, { branchId, productId }));
  if (!targetBatch) throw new HttpError(409, 'There is no stock of this product at this branch to reserve.', 'NO_STOCK_TO_RESERVE');

  const pos = await position(db, { branchId, productId });
  if (pos.available < quantity) {
    throw new HttpError(409,
      `Only ${pos.available.toLocaleString('en-NG')} available to reserve (${pos.reserved.toLocaleString('en-NG')} already committed).`,
      'INSUFFICIENT_AVAILABLE_STOCK');
  }

  const ts = watNowIso();
  const reservationId = newId();
  await db.batch([
    db.prepare(`
      UPDATE stock_batches SET quantity_reserved = quantity_reserved + ?, updated_at = ?
      WHERE id = ? AND (quantity_remaining - quantity_reserved) >= ?
    `).bind(quantity, ts, targetBatch.id, quantity),
    db.prepare(`
      INSERT INTO stock_reservations (
        id, business_unit_id, branch_id, product_id, stock_batch_id, serial_id, quantity,
        source_type, source_id, customer_id, status, expires_at, reserved_by, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)
    `).bind(reservationId, businessUnitId, branchId, productId, targetBatch.id, serialId || null,
      quantity, sourceType, sourceId, customerId || null, expiresAt || null, reservedBy || null, ts, ts),
  ]);
  if (serialId) {
    await db.prepare('UPDATE product_serials SET status = ?, updated_at = ? WHERE id = ?')
      .bind('RESERVED', ts, serialId).run();
  }
  return { reservation_id: reservationId, batch_id: targetBatch.id };
}

async function releaseReservation(db, reservationId, { status = 'RELEASED', releaseStock = true } = {}) {
  const r = await db.prepare('SELECT * FROM stock_reservations WHERE id = ? AND is_deleted = 0').bind(reservationId).first();
  if (!r) throw new HttpError(404, 'That reservation was not found.', 'RESERVATION_NOT_FOUND');
  if (r.status !== 'ACTIVE') return { ok: true, already_released: true, status: r.status };
  const ts = watNowIso();
  const statements = [
    db.prepare('UPDATE stock_reservations SET status = ?, updated_at = ? WHERE id = ?')
      .bind(status, ts, reservationId),
  ];
  if (releaseStock) {
    statements.push(db.prepare(`
      UPDATE stock_batches SET quantity_reserved = MAX(0, quantity_reserved - ?), updated_at = ?
      WHERE id = ?
    `).bind(Number(r.quantity) || 0, ts, r.stock_batch_id));
  }
  await db.batch(statements);
  return { ok: true, released_quantity: Number(r.quantity) || 0 };
}

async function newestAllocatableBatch(db, { branchId, productId }) {
  return db.prepare(`
    SELECT * FROM stock_batches
    WHERE branch_id = ? AND product_id = ? AND is_deleted = 0
      AND status IN (${ALLOCATABLE_BATCH_STATUSES.map(() => '?').join(',')})
      AND (quantity_remaining - quantity_reserved) > 0
    ORDER BY received_at DESC, created_at DESC LIMIT 1
  `).bind(branchId, productId, ...ALLOCATABLE_BATCH_STATUSES).first();
}

// ---------------------------------------------------------------------
// SERIALS
// ---------------------------------------------------------------------
async function registerSerials(db, {
  businessUnitId, branchId, productId, batchId = null, serials,
  purchaseOrderId = null, receivedBy = null, costPrice = null, now = null,
}) {
  const ts = now || watNowIso();
  const list = Array.isArray(serials) ? serials : [];
  if (!list.length) return { registered: 0, ids: [] };

  // Duplicate detection BEFORE insert. The UNIQUE constraint would catch it,
  // but a constraint error surfaces as a 500 and does not tell the receiving
  // clerk WHICH serial is the problem — and on a 200-unit delivery that is
  // the difference between a five-minute fix and an hour.
  const seen = new Set();
  const dupes = [];
  for (const s of list) {
    const key = String(s.serial_no || '').trim().toUpperCase();
    if (!key) { dupes.push('(blank)'); continue; }
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  if (dupes.length) {
    throw new HttpError(409,
      `These serial numbers appear more than once in the list: ${[...new Set(dupes)].slice(0, 8).join(', ')}${dupes.length > 8 ? '…' : ''}. Each unit must have a unique serial.`,
      'DUPLICATE_SERIALS_IN_LIST');
  }

  const existing = await db.prepare(`
    SELECT serial_no FROM product_serials
    WHERE business_unit_id = ? AND is_deleted = 0
      AND serial_no IN (${list.map(() => '?').join(',')})
  `).bind(businessUnitId, ...list.map((s) => String(s.serial_no || '').trim().toUpperCase())).all();
  if (existing.results.length) {
    throw new HttpError(409,
      `These serial numbers are already in the system: ${existing.results.map((r) => r.serial_no).slice(0, 8).join(', ')}${existing.results.length > 8 ? '…' : ''}. `
      + 'They may already have been received, or they may be at another branch.',
      'SERIAL_ALREADY_EXISTS');
  }

  const ids = [];
  const statements = [];
  for (const s of list) {
    const id = newId();
    ids.push(id);
    statements.push(db.prepare(`
      INSERT INTO product_serials (
        id, business_unit_id, product_id, stock_batch_id, branch_id, serial_no, imei, imei2,
        model_variant, colour, status, purchase_order_id, cost_price, received_at, received_by,
        notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?, 'IN_STOCK', ?,?,?,?,?,?,?)
    `).bind(
      id, businessUnitId, productId, batchId || null, branchId,
      String(s.serial_no).trim().toUpperCase(),
      s.imei ? String(s.imei).trim() : null,
      s.imei2 ? String(s.imei2).trim() : null,
      s.model_variant || null, s.colour || null,
      purchaseOrderId || null,
      costPrice == null ? null : Number(costPrice),
      ts, receivedBy || null, s.notes || null, ts, ts
    ));
  }
  await db.batch(statements);
  return { registered: ids.length, ids };
}

async function serialByNumber(db, { businessUnitId, serialNo }) {
  const key = String(serialNo || '').trim().toUpperCase();
  if (!key) return null;
  // Search serial_no then imei: a customer quotes whichever is on the box,
  // and a warranty lookup that fails because they read the IMEI instead of
  // the serial is a support call nobody needs.
  return db.prepare(`
    SELECT ps.*, p.name AS product_name, p.brand, p.model_number, p.warranty_months, b.name AS branch_name
    FROM product_serials ps
    JOIN products p ON p.id = ps.product_id
    JOIN branches b ON b.id = ps.branch_id
    WHERE ps.business_unit_id = ? AND ps.is_deleted = 0
      AND (upper(ps.serial_no) = ? OR upper(ps.imei) = ?)
    LIMIT 1
  `).bind(businessUnitId, key, key).first();
}

// Move serials on a sale. Status transitions are a fixed graph; anything
// else is refused. The alternative — silently correcting an impossible
// transition — is how a custody chain becomes worthless.
const SERIAL_TRANSITIONS = Object.freeze({
  IN_STOCK: ['SOLD', 'RESERVED', 'ON_HOLD', 'IN_TRANSIT', 'DEFECTIVE', 'SCRAPPED', 'LOST', 'DEMO_UNIT'],
  RESERVED: ['SOLD', 'IN_STOCK', 'ON_HOLD', 'IN_TRANSIT', 'CANCELLED'],
  ON_HOLD: ['IN_STOCK', 'SOLD', 'RESERVED', 'DEFECTIVE', 'SCRAPPED'],
  IN_TRANSIT: ['IN_STOCK', 'SOLD', 'LOST', 'DEFECTIVE'],
  SOLD: ['RETURNED', 'WARRANTY_REPAIR'],
  RETURNED: ['IN_STOCK', 'DEFECTIVE', 'SCRAPPED', 'SOLD'],
  DEFECTIVE: ['WARRANTY_REPAIR', 'SCRAPPED', 'IN_STOCK', 'RETURNED'],
  WARRANTY_REPAIR: ['IN_STOCK', 'RETURNED', 'SCRAPPED', 'SOLD'],
  DEMO_UNIT: ['IN_STOCK', 'SOLD', 'SCRAPPED'],
  SCRAPPED: [],
  LOST: ['IN_STOCK'],
});

function canTransitionSerial(from, to) {
  const allowed = SERIAL_TRANSITIONS[String(from || '').toUpperCase()] || [];
  return allowed.includes(String(to || '').toUpperCase());
}

async function transitionSerial(db, serialId, toStatus, { saleId = null, saleItemId = null, branchId = null, note = null } = {}) {
  const s = await db.prepare('SELECT * FROM product_serials WHERE id = ? AND is_deleted = 0').bind(serialId).first();
  if (!s) throw new HttpError(404, 'That serial number record was not found.', 'SERIAL_NOT_FOUND');
  const to = String(toStatus).toUpperCase();
  if (!canTransitionSerial(s.status, to)) {
    throw new HttpError(409,
      `A serial marked ${String(s.status).replace(/_/g, ' ').toLowerCase()} cannot be moved to ${to.replace(/_/g, ' ').toLowerCase()}. `
      + `If this is a genuine correction, use the serial register screen — it records why.`,
      'SERIAL_TRANSITION_NOT_ALLOWED');
  }
  const ts = watNowIso();
  await db.prepare(`
    UPDATE product_serials
    SET status = ?, sale_id = COALESCE(?, sale_id), sale_item_id = COALESCE(?, sale_item_id),
        branch_id = COALESCE(?, branch_id), sold_at = CASE WHEN ? = 'SOLD' THEN ? ELSE sold_at END,
        notes = COALESCE(notes, ?), updated_at = ?
    WHERE id = ?
  `).bind(to, saleId, saleItemId, branchId, to, ts, note || null, ts, serialId).run();
  return { id: serialId, from: s.status, to };
}

module.exports = {
  ALLOCATABLE_BATCH_STATUSES, SERIAL_TRANSITIONS,
  position, positionAll, batchesForProduct, averageCost,
  allocateFromBatches, checkAvailability,
  buildReceiveStatements, buildConsumeStatements, buildAddStatements,
  reserve, releaseReservation, newestAllocatableBatch,
  registerSerials, serialByNumber, canTransitionSerial, transitionSerial,
};
'use strict';
