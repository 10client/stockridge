// =====================================================================
// StockRidge — STOCK ADJUSTMENTS
// =====================================================================
// An adjustment is the ONLY way stock changes outside a sale, a receipt, a
// transfer or a stocktake. That narrowness is deliberate: if any screen can
// write a quantity, no report means anything.
//
// THE TWO THEFT PATTERNS THIS MODULE EXISTS TO SLOW DOWN, both reproduced
// live in the original audit before the controls existed:
//
//   WRITE-OFF   take the goods, record them as DAMAGE. Shrinkage then looks
//               exactly like breakage, and the only evidence is a pattern
//               over time.
//   (its twin, the VOID, is in salesService — sell for cash, void the sale,
//    keep the note.)
//
// So an adjustment carries: a TYPE that distinguishes damage from loss from
// theft from expiry (they have different causes and different fixes), a
// VALUE at cost (so the P&L takes the hit it should), an ATTRIBUTABLE actor,
// and — for staff — a per-adjustment CAP set by the owner.
//
// THE CAP IS A NARROW ALLOWANCE, NOT A BAN. A cashier who drops a bottle
// must be able to write it off without finding a manager; a cashier who can
// write off a whole carton cannot be trusted with the keys. The default is 5
// units and the owner sets it. Beyond the cap the adjustment is created as
// PENDING_APPROVAL and a manager posts it — the count is still recorded, so
// the manager is confirming a number, not doing the walk.
//
// THEFT IS A SEPARATE TYPE from LOSS for a reason that is not bookkeeping:
// a theft may need a police report and an insurance claim, and it must be
// countable separately. Collapsing "someone stole it" into "we can't find
// it" is how a business discovers in year three that it has been robbed
// weekly.
// =====================================================================

const { newId, watNowIso } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const stockService = require('./stockService');
const { PREFIXES, nextReference } = require('../lib/references');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { staffAllowance, assertSubscribed, getUnitSettings, assertStaffCanAdjust } = require('../lib/planLimits');
const { capabilitiesOf } = require('../lib/capabilities');

const TYPES = ['DAMAGE', 'LOSS', 'THEFT', 'EXPIRED', 'FOUND', 'CORRECTION', 'STOCKTAKE', 'SAMPLE', 'SCRAP', 'WRITE_OFF'];
const NEGATIVE_TYPES = ['DAMAGE', 'LOSS', 'THEFT', 'EXPIRED', 'SCRAP', 'SAMPLE', 'WRITE_OFF', 'STOCKTAKE'];
const POSITIVE_TYPES = ['FOUND', 'CORRECTION'];

// Which types may move stock UP. Allowing a cashier to create stock out of
// nothing is as dangerous as allowing them to destroy it: a phantom "FOUND"
// entry is how a stolen item is laundered back into saleable inventory.
const INCREASE_TYPES = ['FOUND', 'CORRECTION'];

async function create(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  const user = ctx.user;

  const branchId = input.branch_id || user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch this adjustment is for.', 'BRANCH_REQUIRED');
  assertBranchAccess(user, branchId);

  const type = String(input.adjustment_type || '').trim().toUpperCase();
  if (!TYPES.includes(type)) {
    throw new HttpError(400, `Adjustment type must be one of: ${TYPES.join(', ')}.`, 'ADJUSTMENT_TYPE_INVALID');
  }

  const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(input.product_id).first();
  if (!product) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');
  if (product.business_unit_id !== businessUnitId) {
    throw new HttpError(403, 'That product belongs to a different business.', 'PRODUCT_WRONG_BUSINESS');
  }

  let qty = Number(input.quantity);
  if (!Number.isFinite(qty) || qty === 0) {
    throw new HttpError(400, 'Enter a quantity. It is negative for stock leaving and positive for stock appearing.', 'ADJUSTMENT_QUANTITY_INVALID');
  }
  // Sign is DERIVED from the type, not trusted from the client. A client that
  // sends +5 DAMAGE has either a bug or an intent, and neither should be
  // honoured.
  const expectedSign = POSITIVE_TYPES.includes(type) || type === 'FOUND' || type === 'CORRECTION' ? 1 : -1;
  if (type === 'CORRECTION') {
    // A correction may go either way — it is "the system says 10, there are
    // actually 8" or "...actually 12". Everything else has a fixed direction.
  } else if (Math.sign(qty) !== expectedSign && !(type === 'STOCKTAKE')) {
    qty = Math.abs(qty) * expectedSign;
  }

  const absQty = Math.abs(qty);
  if (qty < 0 && NEGATIVE_TYPES.includes(type) === false && type !== 'CORRECTION' && type !== 'STOCKTAKE') {
    throw new HttpError(400, `A ${type} adjustment cannot remove stock.`, 'ADJUSTMENT_SIGN_INVALID');
  }
  if (qty > 0 && !INCREASE_TYPES.includes(type) && type !== 'STOCKTAKE') {
    throw new HttpError(400, `A ${type} adjustment cannot add stock. Use FOUND or CORRECTION, with a reason.`, 'ADJUSTMENT_SIGN_INVALID');
  }

  // Authority. Staff are capped; a manager is not, but a large adjustment by
  // anyone is worth a reason.
  const allowance = await staffAllowance(db, businessUnitId, user);
  let status = 'POSTED';
  let approvedBy = null;
  if (!input.skipAuthorityCheck) {
    assertSubscribed(settings, user, { action: 'adjust stock' });
    if (String(user.role).toUpperCase() === 'STAFF') {
      if (absQty > allowance.adjustment_max_units) {
        // Do NOT refuse outright. Record it as PENDING_APPROVAL so the count
        // is captured and the manager confirms a number rather than repeating
        // a walk. Refusing would push the adjustment onto paper, which is
        // strictly worse.
        status = 'PENDING_APPROVAL';
      } else {
        await assertStaffCanAdjust(db, businessUnitId, user, absQty);
      }
    }
  }

  if (!input.reason || String(input.reason).trim().length < 4) {
    throw new HttpError(400,
      'A stock adjustment needs a written reason of at least 4 characters. It is the only record of why the number changed, and it is what makes DAMAGE distinguishable from THEFT a year later.',
      'ADJUSTMENT_REASON_REQUIRED');
  }
  if (type === 'THEFT' && (!input.reference || String(input.reference).trim().length < 3)) {
    throw new HttpError(400,
      'A theft write-off needs a reference — an incident report number, a police report number, or at minimum who reported it. An unreferenced theft entry is indistinguishable from a convenient one.',
      'THEFT_REFERENCE_REQUIRED');
  }

  const pos = await stockService.position(db, { branchId, productId: product.id });
  if (qty < 0 && pos.on_hand < absQty) {
    throw new HttpError(409,
      `You cannot write off ${absQty.toLocaleString('en-NG')} ${product.base_unit || 'units'} — the branch only holds ${pos.on_hand.toLocaleString('en-NG')}. `
      + 'If the system quantity is wrong, run a stocktake and let the variance post the correction.',
      'ADJUSTMENT_EXCEEDS_STOCK');
  }

  // Value at the branch's actual average cost, not the product's default
  // cost. Writing off at the default would mis-state the P&L by whatever the
  // exchange rate did to the last delivery.
  const unitCost = pos.on_hand > 0
    ? round2(await stockService.averageCost(db, { branchId, productId: product.id }))
    : round2(Number(product.default_cost_price) || 0);
  const value = round2(unitCost * absQty);

  const ts = watNowIso();
  const id = newId();
  const reference = input.reference
    || (await nextReference(db, { businessUnitId, prefix: PREFIXES.ADJUSTMENT, branchCode: '*', scope: 'MONTH' })).reference;

  const statements = [
    db.prepare(`
      INSERT INTO stock_adjustments (
        id, business_unit_id, branch_id, product_id, stock_batch_id, adjustment_type, quantity,
        unit_cost, value, reason, reference, stocktake_id, status, requested_by, approved_by,
        posted_at, device_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id, businessUnitId, branchId, product.id, input.stock_batch_id || null, type, qty,
      unitCost, value, String(input.reason).slice(0, 500), String(reference).slice(0, 120),
      input.stocktake_id || null, status, user.id, approvedBy,
      status === 'POSTED' ? ts : null, ctx.deviceId || null, ts, ts
    ),
  ];

  if (status === 'POSTED') {
    if (qty < 0) {
      const consumed = await stockService.buildConsumeStatements(db, {
        businessUnitId, branchId, productId: product.id, quantityBase: absQty,
        movementType: movementTypeFor(type), sourceType: 'ADJUSTMENT', sourceId: id,
        reference, reason: String(input.reason).slice(0, 500), performedBy: user.id,
        deviceId: ctx.deviceId || null, now: ts, batchId: input.stock_batch_id || null,
        allowPartial: false,
      });
      for (const s of consumed.statements) statements.push(s);
    } else {
      const batchId = input.stock_batch_id || (await stockService.newestAllocatableBatch(db, { branchId, productId: product.id }))?.id || null;
      if (batchId) {
        statements.push(db.prepare(`
          UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?,
            status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END, updated_at = ?
          WHERE id = ?
        `).bind(absQty, ts, batchId));
        const after = await stockService.position(db, { branchId, productId: product.id });
        statements.push(db.prepare(`
          INSERT INTO stock_movements (
            id, business_unit_id, branch_id, product_id, stock_batch_id, direction, quantity, unit_cost,
            movement_type, source_type, source_id, reference, balance_after, reason, performed_by, device_id,
            occurred_at, created_at
          ) VALUES (?,?,?,?,?, 'IN', ?,?, ?, 'ADJUSTMENT', ?,?,?, ?,?,?,?)
        `).bind(
          newId(), businessUnitId, branchId, product.id, batchId, absQty, unitCost,
          movementTypeFor(type), id, reference, round2(after.on_hand + absQty),
          String(input.reason).slice(0, 500), user.id, ctx.deviceId || null, ts, ts
        ));
      } else {
        // No batch to add to: create one. A FOUND item with no batch context
        // still has to land somewhere or the physical count will never agree.
        const newBatch = newId();
        statements.push(db.prepare(`
          INSERT INTO stock_batches (
            id, business_unit_id, branch_id, product_id, batch_no, quantity_received, quantity_remaining,
            quantity_reserved, unit_cost, total_cost, selling_price_per_unit, received_at, received_by,
            status, notes, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?, 0, ?,?,?,?,?,'ACTIVE',?,?,?)
        `).bind(
          newBatch, businessUnitId, branchId, product.id, `ADJ-${reference}`, absQty, absQty,
          unitCost, round2(unitCost * absQty), Number(product.default_selling_price) || 0,
          ts, user.id, `Created by adjustment ${reference}`, ts, ts
        ));
        statements.push(db.prepare(`
          INSERT INTO stock_movements (
            id, business_unit_id, branch_id, product_id, stock_batch_id, direction, quantity, unit_cost,
            movement_type, source_type, source_id, reference, balance_after, reason, performed_by, device_id,
            occurred_at, created_at
          ) VALUES (?,?,?,?,?, 'IN', ?,?, ?, 'ADJUSTMENT', ?,?,?, ?,?,?,?)
        `).bind(
          newId(), businessUnitId, branchId, product.id, newBatch, absQty, unitCost,
          movementTypeFor(type), id, reference, round2(pos.on_hand + absQty),
          String(input.reason).slice(0, 500), user.id, ctx.deviceId || null, ts, ts
        ));
      }
    }
  }

  await db.batch(statements);

  // GL. A write-off is a real expense and must hit the P&L in the period it
  // happened, or the month's profit is overstated by exactly the shrinkage
  // the owner is trying to measure.
  if (status === 'POSTED' && capabilitiesOf(settings).general_ledger && settings.gl_module_enabled !== 0) {
    try {
      const glService = require('./glService');
      await glService.postStockAdjustment(db, {
        businessUnitId, branchId, userId: user.id,
        adjustment: { id, adjustment_type: type, quantity: qty, value, reference },
      });
    } catch (e) { console.error('[adjustmentService] GL posting failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId, branchId, userId: user.id, actorRole: user.role, action: 'STOCK_ADJUSTMENT',
    entityType: 'ADJUSTMENT', entityId: id, amount: value,
    reason: String(input.reason).slice(0, 500),
    after: { type, quantity: qty, status, reference },
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id, reference, adjustment_type: type, quantity: qty, unit_cost: unitCost, value,
    status, needs_approval: status === 'PENDING_APPROVAL',
    advisory: status === 'PENDING_APPROVAL'
      ? `This write-off is above your limit of ${allowance.adjustment_max_units.toLocaleString('en-NG')} units, so it is waiting for a manager to approve. The quantity is recorded — the manager only has to confirm it.`
      : null,
  };
}

function movementTypeFor(type) {
  switch (type) {
    case 'DAMAGE': return 'ADJUSTMENT_DAMAGE';
    case 'LOSS': return 'ADJUSTMENT_LOSS';
    case 'THEFT': return 'ADJUSTMENT_THEFT';
    case 'EXPIRED': return 'ADJUSTMENT_EXPIRY';
    case 'FOUND': return 'ADJUSTMENT_FOUND';
    case 'CORRECTION': return 'ADJUSTMENT_CORRECTION';
    case 'STOCKTAKE': return 'STOCKTAKE_VARIANCE';
    case 'SCRAP': return 'SCRAP';
    case 'SAMPLE': return 'SAMPLE';
    default: return 'ADJUSTMENT_CORRECTION';
  }
}

async function approve(db, ctx, { adjustmentId, decision = 'APPROVED', note = null }) {
  const a = await db.prepare('SELECT * FROM stock_adjustments WHERE id = ? AND is_deleted = 0').bind(adjustmentId).first();
  if (!a) throw new HttpError(404, 'That adjustment was not found.', 'ADJUSTMENT_NOT_FOUND');
  assertBranchAccess(ctx.user, a.branch_id);
  if (a.status !== 'PENDING_APPROVAL') throw new HttpError(409, `That adjustment is ${a.status}, not awaiting approval.`, 'ADJUSTMENT_NOT_PENDING');

  const role = String(ctx.user.role).toUpperCase();
  if (role === 'STAFF') throw new HttpError(403, 'A cashier cannot approve a stock adjustment — including their own.', 'ADJUSTMENT_APPROVAL_FORBIDDEN');
  const d = String(decision).toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(d)) throw new HttpError(400, 'Decision must be APPROVED or REJECTED.', 'ADJUSTMENT_DECISION_INVALID');

  const ts = watNowIso();
  if (d === 'REJECTED') {
    await db.prepare(`
      UPDATE stock_adjustments SET status = 'REJECTED', approved_by = ?, approved_at = ?, reason = reason || ? , updated_at = ?
      WHERE id = ?
    `).bind(ctx.user.id, ts, ` | Rejected: ${String(note || 'no reason given').slice(0, 200)}`, ts, adjustmentId).run();
    await writeAudit(db, {
      businessUnitId: a.business_unit_id, branchId: a.branch_id, userId: ctx.user.id, actorRole: role,
      action: 'ADJUSTMENT_REJECTED', entityType: 'ADJUSTMENT', entityId: adjustmentId, amount: Number(a.value),
      reason: String(note || '').slice(0, 500), before: { status: a.status }, after: { status: 'REJECTED' },
      ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
    });
    return { ok: true, id: adjustmentId, status: 'REJECTED' };
  }

  // Approving POSTS the movement. The quantity was captured at request time,
  // so the approver is confirming a number somebody already counted — which
  // is the whole point of the two-step.
  const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(a.product_id).first();
  const qty = Number(a.quantity) || 0;
  const statements = [
    db.prepare(`
      UPDATE stock_adjustments SET status = 'POSTED', approved_by = ?, approved_at = ?, posted_at = ?, updated_at = ? WHERE id = ?
    `).bind(ctx.user.id, ts, ts, ts, adjustmentId),
  ];

  if (qty < 0) {
    const consumed = await stockService.buildConsumeStatements(db, {
      businessUnitId: a.business_unit_id, branchId: a.branch_id, productId: a.product_id,
      quantityBase: Math.abs(qty), movementType: movementTypeFor(a.adjustment_type),
      sourceType: 'ADJUSTMENT', sourceId: adjustmentId, reference: a.reference,
      reason: a.reason, performedBy: ctx.user.id, deviceId: ctx.deviceId || null,
      now: ts, batchId: a.stock_batch_id || null,
      // The stock may have moved since the request. Allow the partial and
      // record it: refusing would leave an approved write-off unposted, which
      // is worse than posting what is actually there.
      allowPartial: true,
    });
    for (const s of consumed.statements) statements.push(s);
  } else {
    const batch = a.stock_batch_id || (await stockService.newestAllocatableBatch(db, { branchId: a.branch_id, productId: a.product_id }))?.id;
    if (batch) {
      statements.push(db.prepare(`
        UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?,
          status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END, updated_at = ? WHERE id = ?
      `).bind(qty, ts, batch));
    }
  }
  await db.batch(statements);

  if (capabilitiesOf(ctx.businessUnit || await getUnitSettings(db, a.business_unit_id)).general_ledger) {
    try {
      const glService = require('./glService');
      await glService.postStockAdjustment(db, {
        businessUnitId: a.business_unit_id, branchId: a.branch_id, userId: ctx.user.id, adjustment: a,
      });
    } catch (e) { console.error('[adjustmentService] GL posting on approval failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId: a.business_unit_id, branchId: a.branch_id, userId: ctx.user.id, actorRole: role,
    action: 'ADJUSTMENT_APPROVED', entityType: 'ADJUSTMENT', entityId: adjustmentId, amount: Number(a.value),
    reason: String(note || '').slice(0, 500), before: { status: a.status }, after: { status: 'POSTED' },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id: adjustmentId, status: 'POSTED', posted_at: ts };
}

async function list(db, { businessUnitId, branchId = null, productId = null, type = null, status = null, from = null, to = null, limit = 50, offset = 0 }) {
  const where = ['a.is_deleted = 0', 'a.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('a.branch_id = ?'); params.push(branchId); }
  if (productId) { where.push('a.product_id = ?'); params.push(productId); }
  if (type) { where.push('a.adjustment_type = ?'); params.push(String(type).toUpperCase()); }
  if (status) { where.push('a.status = ?'); params.push(String(status).toUpperCase()); }
  if (from) { where.push("date(a.posted_at, '+1 hour') >= ?"); params.push(String(from).slice(0, 10)); }
  if (to) { where.push("date(a.posted_at, '+1 hour') <= ?"); params.push(String(to).slice(0, 10)); }

  const rows = await db.prepare(`
    SELECT a.*, p.name AS product_name, p.sku, p.base_unit, b.name AS branch_name,
           u.full_name AS requested_by_name, ap.full_name AS approved_by_name
    FROM stock_adjustments a
    JOIN products p ON p.id = a.product_id
    JOIN branches b ON b.id = a.branch_id
    LEFT JOIN users u ON u.id = a.requested_by
    LEFT JOIN users ap ON ap.id = a.approved_by
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(a.posted_at, a.created_at) DESC LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();
  return rows.results;
}

// Shrinkage by type and by branch. This is the report that turns a pile of
// write-offs into a decision: if THEFT is concentrated at one branch, that is
// a management problem; if DAMAGE is concentrated on one product, that is a
// handling or packaging problem. Both are invisible in a total.
async function shrinkageReport(db, { businessUnitId, branchId = null, startDate, endDate }) {
  const where = ['a.is_deleted = 0', "a.status = 'POSTED'", 'a.business_unit_id = ?', "date(a.posted_at,'+1 hour') BETWEEN ? AND ?"];
  const params = [businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10)];
  if (branchId) { where.push('a.branch_id = ?'); params.push(branchId); }

  const byType = await db.prepare(`
    SELECT a.adjustment_type, COUNT(*) AS entries, COALESCE(SUM(a.value),0) AS value,
           COALESCE(SUM(ABS(a.quantity)),0) AS units
    FROM stock_adjustments a WHERE ${where.join(' AND ')}
    GROUP BY a.adjustment_type ORDER BY value DESC
  `).bind(...params).all();

  const byBranch = await db.prepare(`
    SELECT b.name AS branch_name, a.branch_id, COUNT(*) AS entries, COALESCE(SUM(a.value),0) AS value
    FROM stock_adjustments a JOIN branches b ON b.id = a.branch_id
    WHERE ${where.join(' AND ')}
    GROUP BY b.name, a.branch_id ORDER BY value DESC
  `).bind(...params).all();

  const byProduct = await db.prepare(`
    SELECT p.name AS product_name, p.sku, a.product_id, COUNT(*) AS entries,
           COALESCE(SUM(a.value),0) AS value, COALESCE(SUM(ABS(a.quantity)),0) AS units
    FROM stock_adjustments a JOIN products p ON p.id = a.product_id
    WHERE ${where.join(' AND ')}
    GROUP BY p.name, p.sku, a.product_id ORDER BY value DESC LIMIT 20
  `).bind(...params).all();

  const byUser = await db.prepare(`
    SELECT u.full_name AS user_name, u.role, a.requested_by AS user_id, COUNT(*) AS entries,
           COALESCE(SUM(a.value),0) AS value
    FROM stock_adjustments a JOIN users u ON u.id = a.requested_by
    WHERE ${where.join(' AND ')}
    GROUP BY u.full_name, u.role, a.requested_by ORDER BY value DESC LIMIT 20
  `).bind(...params).all();

  // Loss against revenue: shrinkage as a percentage of turnover is the only
  // form of the number that is comparable between branches of different sizes.
  const revenue = await db.prepare(`
    SELECT COALESCE(SUM(s.total),0) AS revenue FROM sales s
    WHERE s.business_unit_id = ? AND s.is_deleted = 0 AND s.status <> 'VOIDED'
      AND date(s.occurred_at,'+1 hour') BETWEEN ? AND ?
      ${branchId ? 'AND s.branch_id = ?' : ''}
  `).bind(businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10), ...(branchId ? [branchId] : [])).first();

  const totalLoss = round2(byType.results
    .filter((r) => ['DAMAGE', 'LOSS', 'THEFT', 'EXPIRED', 'SCRAP', 'WRITE_OFF'].includes(r.adjustment_type))
    .reduce((a, r) => a + Number(r.value), 0));
  const theft = round2((byType.results.find((r) => r.adjustment_type === 'THEFT') || {}).value || 0);
  const rev = round2(Number(revenue.revenue) || 0);

  return {
    period: { start: String(startDate).slice(0, 10), end: String(endDate).slice(0, 10) },
    revenue: rev,
    total_loss_value: totalLoss,
    theft_value: theft,
    shrinkage_percent_of_revenue: rev > 0 ? round2((totalLoss / rev) * 100) : 0,
    by_type: byType.results.map((r) => ({ ...r, value: round2(r.value), units: round2(r.units) })),
    by_branch: byBranch.results.map((r) => ({ ...r, value: round2(r.value) })),
    by_product: byProduct.results.map((r) => ({ ...r, value: round2(r.value), units: round2(r.units) })),
    by_user: byUser.results.map((r) => ({ ...r, value: round2(r.value) })),
    advisory: totalLoss > 0 && rev > 0 && (totalLoss / rev) > 0.02
      ? `Shrinkage is ${round2((totalLoss / rev) * 100)}% of turnover, which is above the 2% most retailers treat as the outer edge of normal. The by-type breakdown will tell you whether it is handling, expiry or theft — those have different fixes.`
      : null,
  };
}

module.exports = { TYPES, NEGATIVE_TYPES, POSITIVE_TYPES, INCREASE_TYPES, create, approve, list, shrinkageReport, movementTypeFor };
'use strict';
