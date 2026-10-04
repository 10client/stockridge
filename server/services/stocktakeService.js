// =====================================================================
// StockRidge — STOCKTAKE
// =====================================================================
// Models a full physical-count CYCLE rather than jumping straight to ad-hoc
// adjustments:
//
//   OPEN      freeze the system quantity into stocktake_lines.system_quantity
//   COUNTING  staff record counted_quantity, line by line
//   REVIEW    variances computed and shown; large ones recounted
//   COMMITTED adjustments posted, session closed, stock corrected
//
// WHY A CYCLE AND NOT JUST AN ADJUSTMENT SCREEN: a stocktake that only
// produces a number nobody acts on is a stocktake that will not happen twice.
// Freezing the system quantity is what makes the variance MEANINGFUL — count
// against a moving target and the variance is a mixture of real shrinkage and
// sales that happened while you were counting.
//
// THREE DESIGN DECISIONS WORTH DEFENDING:
//
//  1. COUNTING IS OPEN TO CASHIERS, COMMITTING IS NOT. Walking the shelves
//     is exactly a storekeeper's job, and requiring a manager to hold the
//     clipboard would make the feature unusable in a shop with one manager
//     and six staff. It is COMMITTING the variance that moves stock, so the
//     cap is applied to the largest variance about to be posted. A count that
//     matches the system (or is off by a unit or two) closes normally;
//     anything bigger needs a manager, who can then close the very same
//     session with the counts already recorded.
//
//  2. BLIND COUNT IS AN OPTION, NOT A DEFAULT. Hiding the system quantity
//     from the counter removes the "yes, that looks about right" reflex that
//     makes a non-blind count worthless. But a blind count of a 5,000-SKU
//     warehouse is a much bigger job, so it is the manager's choice per
//     session.
//
//  3. ONE OPEN SESSION PER BRANCH, enforced by a partial unique index. Two
//     concurrent counts of the same shelves produce two sets of variances
//     against a moving system quantity, and the resulting adjustments are
//     meaningless.
//
// SALES DURING A COUNT: not blocked — a shop does not close to count. The
// frozen system_quantity is compared against a LIVE recount at commit time,
// and the difference between frozen and live is shown as "moved during count"
// so the variance is attributable rather than mysterious.
// =====================================================================

const { newId, watNowIso } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const stockService = require('./stockService');
const adjustmentService = require('./adjustmentService');
const { PREFIXES, nextReference } = require('../lib/references');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { staffAllowance, getUnitSettings, assertSubscribed } = require('../lib/planLimits');

const STATUSES = ['OPEN', 'COUNTING', 'REVIEW', 'COMMITTED', 'CANCELLED'];
const SCOPES = ['FULL', 'CATEGORY', 'PRODUCT', 'LOCATION', 'SAMPLE'];

async function open(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'start a stocktake' });

  const branchId = input.branch_id || ctx.user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch this count is for.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, branchId);

  const existing = await db.prepare(`
    SELECT reference, status FROM stocktake_sessions
    WHERE branch_id = ? AND status IN ('OPEN','COUNTING','REVIEW') AND is_deleted = 0
  `).bind(branchId).first();
  if (existing) {
    throw new HttpError(409,
      `Count ${existing.reference} is already ${existing.status.toLowerCase()} at this branch. Finish or cancel it first — two counts of the same shelves at once produce variances against a moving target, and neither is then correct.`,
      'STOCKTAKE_ALREADY_OPEN');
  }

  const scope = String(input.scope || 'FULL').toUpperCase();
  if (!SCOPES.includes(scope)) throw new HttpError(400, `Scope must be one of: ${SCOPES.join(', ')}.`, 'STOCKTAKE_SCOPE_INVALID');

  // Build the line list from what the branch actually holds. A FULL count of
  // a branch with nothing on the shelves is refused rather than created
  // empty, because an empty session that can be "committed" is a free pass to
  // write every product down to zero.
  const where = ['sb.branch_id = ?', 'sb.is_deleted = 0', 'sb.quantity_remaining > 0'];
  const params = [branchId];
  if (scope === 'CATEGORY' && Array.isArray(input.scope_ids) && input.scope_ids.length) {
    where.push(`p.category_id IN (${input.scope_ids.map(() => '?').join(',')})`);
    params.push(...input.scope_ids);
  }
  if (scope === 'PRODUCT' && Array.isArray(input.scope_ids) && input.scope_ids.length) {
    where.push(`sb.product_id IN (${input.scope_ids.slice(0, 500).map(() => '?').join(',')})`);
    params.push(...input.scope_ids.slice(0, 500));
  }

  const rows = await db.prepare(`
    SELECT sb.product_id, sb.id AS stock_batch_id, p.name AS product_name, p.base_unit, p.tracks_serials,
           sb.quantity_remaining, sb.batch_no
    FROM stock_batches sb
    JOIN products p ON p.id = sb.product_id AND p.is_deleted = 0
    WHERE ${where.join(' AND ')}
    ORDER BY p.name
    LIMIT 20000
  `).bind(...params).all();

  if (!rows.results.length) {
    throw new HttpError(409,
      'This branch has no stock batches with a quantity to count. If you expected stock here, check that it has been received — a count against an empty shelf list would let every product be written down to zero.',
      'STOCKTAKE_NOTHING_TO_COUNT');
  }
  if (rows.results.length > 20000) {
    throw new HttpError(400, 'That scope covers more than 20,000 lines. Narrow it by category.', 'STOCKTAKE_TOO_LARGE');
  }

  const ts = watNowIso();
  const id = newId();
  const reference = input.reference
    || (await nextReference(db, { businessUnitId, prefix: PREFIXES.STOCKTAKE, branchCode: '*', scope: 'YEAR' })).reference;

  const statements = [
    db.prepare(`
      INSERT INTO stocktake_sessions (
        id, business_unit_id, branch_id, reference, scope, scope_ids_json, status, blind_count,
        opened_by, opened_at, total_lines, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?, 'OPEN', ?,?,?,?, ?,?,?)
    `).bind(
      id, businessUnitId, branchId, reference, scope,
      input.scope_ids ? JSON.stringify(input.scope_ids) : null,
      input.blind_count ? 1 : 0, ctx.user.id, ts, rows.results.length,
      input.notes || null, ts, ts
    ),
  ];

  for (const r of rows.results) {
    statements.push(db.prepare(`
      INSERT INTO stocktake_lines (
        id, stocktake_id, business_unit_id, product_id, stock_batch_id, system_quantity,
        counted_quantity, variance, counted_by, counted_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?, NULL, NULL, NULL, NULL,?,?)
    `).bind(newId(), id, businessUnitId, r.product_id, r.stock_batch_id, Number(r.quantity_remaining) || 0, ts, ts));
  }

  await db.batch(statements);
  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'STOCKTAKE_OPENED', entityType: 'STOCKTAKE', entityId: id,
    after: { reference, scope, lines: rows.results.length, blind: !!input.blind_count },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id, reference, status: 'OPEN', scope, total_lines: rows.results.length, blind_count: !!input.blind_count };
}

// Record a count. Repeatable and overwritable — a counter who mis-reads a
// shelf must be able to correct the line without a manager, because the
// alternative is a wrong number that nobody will admit to.
async function recordCount(db, ctx, { stocktakeId, lines }) {
  const session = await load(db, stocktakeId, ctx.businessUnitId);
  if (!session) throw new HttpError(404, 'That stocktake was not found.', 'STOCKTAKE_NOT_FOUND');
  assertBranchAccess(ctx.user, session.branch_id);
  if (!['OPEN', 'COUNTING', 'REVIEW'].includes(session.status)) {
    throw new HttpError(409, `A ${session.status} stocktake cannot accept counts.`, 'STOCKTAKE_NOT_COUNTABLE');
  }
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'Send the counted lines.', 'STOCKTAKE_LINES_REQUIRED');
  if (lines.length > 2000) throw new HttpError(400, 'Submit at most 2,000 lines per request — a larger batch will time out on a mobile connection.', 'STOCKTAKE_TOO_MANY_LINES');

  const ts = watNowIso();
  const statements = [];
  let counted = 0;
  const rejected = [];

  for (const l of lines) {
    const lineId = l.line_id || l.id;
    if (!lineId) { rejected.push({ line: l, reason: 'no line id' }); continue; }
    const qty = Number(l.counted_quantity);
    if (!Number.isFinite(qty) || qty < 0) {
      rejected.push({ line_id: lineId, reason: 'counted quantity must be zero or more' });
      continue;
    }
    const existing = await db.prepare('SELECT * FROM stocktake_lines WHERE id = ? AND stocktake_id = ? AND is_deleted = 0').bind(lineId, stocktakeId).first();
    if (!existing) { rejected.push({ line_id: lineId, reason: 'not part of this count' }); continue; }

    // Zero is a legitimate and important count: "there are none" is exactly
    // the finding a stocktake exists to surface, and treating 0 as "not
    // counted" would hide total loss.
    const variance = round2(qty - Number(existing.system_quantity));
    statements.push(db.prepare(`
      UPDATE stocktake_lines
      SET counted_quantity = ?, variance = ?, variance_value = ?, counted_by = ?, counted_at = ?, note = COALESCE(?, note), updated_at = ?
      WHERE id = ?
    `).bind(qty, variance, null, ctx.user.id, ts, l.note || null, ts, lineId));
    counted += 1;
  }

  if (!statements.length) {
    throw new HttpError(400, `None of those lines could be recorded: ${rejected.slice(0, 3).map((r) => r.reason).join('; ')}`, 'STOCKTAKE_LINES_REJECTED');
  }
  statements.push(db.prepare(`
    UPDATE stocktake_sessions
    SET status = CASE WHEN status = 'OPEN' THEN 'COUNTING' ELSE status END,
        counted_lines = (SELECT COUNT(*) FROM stocktake_lines WHERE stocktake_id = ? AND counted_quantity IS NOT NULL AND is_deleted = 0),
        updated_at = ?
    WHERE id = ?
  `).bind(stocktakeId, ts, stocktakeId));

  await db.batch(statements);
  return { ok: true, recorded: counted, rejected, stocktake_id: stocktakeId };
}

// Variances, computed live rather than read from a stored column: the system
// quantity may have moved since the count (a sale during the count), and the
// manager committing must see the CURRENT position, not the frozen one.
async function previewVariances(db, stocktakeId, { businessUnitId = null } = {}) {
  const session = await load(db, stocktakeId, businessUnitId);
  if (!session) throw new HttpError(404, 'That stocktake was not found.', 'STOCKTAKE_NOT_FOUND');

  const rows = await db.prepare(`
    SELECT sl.*, p.name AS product_name, p.sku, p.base_unit, p.tracks_serials,
           sb.unit_cost, sb.batch_no,
           COALESCE((SELECT SUM(sb2.quantity_remaining) FROM stock_batches sb2
                     WHERE sb2.branch_id = ? AND sb2.product_id = sl.product_id AND sb2.is_deleted = 0
                       AND sb2.status NOT IN ('EXPIRED','RECALLED','RETURNED_TO_SUPPLIER')), 0) AS live_quantity
    FROM stocktake_lines sl
    JOIN products p ON p.id = sl.product_id
    LEFT JOIN stock_batches sb ON sb.id = sl.stock_batch_id
    WHERE sl.stocktake_id = ? AND sl.is_deleted = 0 AND sl.counted_quantity IS NOT NULL
    ORDER BY ABS(sl.counted_quantity - sl.system_quantity) DESC
  `).bind(session.branch_id, stocktakeId).all();

  const out = [];
  let netVarianceValue = 0;
  for (const r of rows.results) {
    const counted = Number(r.counted_quantity);
    const frozen = Number(r.system_quantity);
    const live = Number(r.live_quantity);
    const unitCost = Number(r.unit_cost) || 0;
    // Variance against the LIVE figure is what should be posted; variance
    // against the FROZEN figure is what the counter was measuring. Both are
    // shown, because the difference between them is stock that moved during
    // the count and would otherwise look like shrinkage.
    const varianceFrozen = round2(counted - frozen);
    const varianceLive = round2(counted - live);
    const movedDuringCount = round2(live - frozen);
    const value = round2(varianceLive * unitCost);
    netVarianceValue = round2(netVarianceValue + value);
    out.push({
      line_id: r.id, product_id: r.product_id, product_name: r.product_name, sku: r.sku,
      base_unit: r.base_unit, stock_batch_id: r.stock_batch_id, batch_no: r.batch_no,
      system_quantity_frozen: frozen, live_system_quantity: live, counted_quantity: counted,
      variance: varianceLive, variance_frozen_basis: varianceFrozen,
      moved_during_count: movedDuringCount,
      unit_cost: round2(unitCost), variance_value: value,
      counted_by: r.counted_by, counted_at: r.counted_at,
      recount_quantity: r.recount_quantity, needs_recount: Math.abs(varianceLive) >= 3 && !r.recount_quantity,
      adjustment_id: r.adjustment_id,
      note: r.note,
    });
  }
  return {
    stocktake_id: stocktakeId, reference: session.reference, status: session.status,
    total_lines: session.total_lines, counted_lines: out.length,
    uncounted_lines: Math.max(0, Number(session.total_lines) - out.length),
    variance_lines: out.filter((v) => Math.abs(v.variance) > 0).length,
    needs_recount: out.filter((v) => v.needs_recount).length,
    net_variance_value: netVarianceValue,
    absolute_variance_value: round2(out.reduce((a, v) => a + Math.abs(v.variance_value), 0)),
    variances: out,
  };
}

// COMMIT: post one adjustment per non-zero variance.
async function commit(db, ctx, { stocktakeId, note = null, postZeroVariances = false }) {
  const session = await load(db, stocktakeId, ctx.businessUnitId);
  if (!session) throw new HttpError(404, 'That stocktake was not found.', 'STOCKTAKE_NOT_FOUND');
  assertBranchAccess(ctx.user, session.branch_id);
  if (session.status === 'COMMITTED') throw new HttpError(409, 'That stocktake has already been committed.', 'STOCKTAKE_ALREADY_COMMITTED');
  if (session.status === 'CANCELLED') throw new HttpError(409, 'That stocktake was cancelled.', 'STOCKTAKE_CANCELLED');

  const preview = await previewVariances(db, stocktakeId, { businessUnitId: ctx.businessUnitId });
  if (!preview.counted_lines) {
    throw new HttpError(409, 'Nothing has been counted yet, so there is nothing to commit.', 'STOCKTAKE_NOTHING_COUNTED');
  }
  if (preview.uncounted_lines > 0 && !note) {
    // Not a hard block — a partial count of one aisle is legitimate — but it
    // must be a stated decision, because an uncounted line looks identical to
    // a line that counted exactly right.
    throw new HttpError(400,
      `${preview.uncounted_lines} of ${preview.total_lines} lines have not been counted. Either count them, or commit with a note explaining why they were left — an uncounted line and a line that counted exactly right look identical afterwards.`,
      'STOCKTAKE_INCOMPLETE');
  }

  const toPost = preview.variances.filter((v) => Math.abs(v.variance) > 0 || postZeroVariances);
  if (!toPost.length) {
    await db.prepare(`
      UPDATE stocktake_sessions SET status = 'COMMITTED', committed_by = ?, committed_at = ?,
        variance_lines = 0, net_variance_value = 0, notes = COALESCE(notes || ' | ','') || ?, updated_at = ?
      WHERE id = ?
    `).bind(ctx.user.id, watNowIso(), `Committed with no variances. ${note || ''}`.slice(0, 500), watNowIso(), stocktakeId).run();
    return { ok: true, id: stocktakeId, status: 'COMMITTED', adjustments: 0, net_variance_value: 0 };
  }

  // THE CAP IS APPLIED TO THE LARGEST VARIANCE ABOUT TO BE POSTED, not to the
  // act of counting. See the header comment for why.
  const allowance = await staffAllowance(db, ctx.businessUnitId, ctx.user);
  const largest = toPost.reduce((max, v) => Math.max(max, Math.abs(v.variance)), 0);
  if (String(ctx.user.role).toUpperCase() === 'STAFF' && largest > allowance.adjustment_max_units) {
    throw new HttpError(403,
      `The largest variance in this count is ${largest.toLocaleString('en-NG')} units, above your limit of ${allowance.adjustment_max_units.toLocaleString('en-NG')}. `
      + 'The counts are all recorded — a manager can commit this very same session without recounting anything.',
      'STOCKTAKE_VARIANCE_OVER_STAFF_LIMIT');
  }

  const ts = watNowIso();
  const posted = [];
  const failed = [];
  let netValue = 0;

  for (const v of toPost) {
    if (Math.abs(v.variance) === 0) continue;
    try {
      const result = await adjustmentService.create(db, ctx, {
        branch_id: session.branch_id,
        product_id: v.product_id,
        stock_batch_id: v.stock_batch_id,
        adjustment_type: 'STOCKTAKE',
        quantity: v.variance,
        reason: `Stocktake ${session.reference} counted ${v.counted_quantity} against a system quantity of ${v.live_system_quantity}.`
          + (v.moved_during_count !== 0 ? ` ${Math.abs(v.moved_during_count)} moved during the count.` : '')
          + (note ? ` Note: ${note}` : ''),
        reference: session.reference,
        stocktake_id: stocktakeId,
        skipAuthorityCheck: true,        // the cap was checked against the LARGEST variance above
      });
      posted.push({ line_id: v.line_id, product_id: v.product_id, product_name: v.product_name, variance: v.variance, value: v.variance_value, adjustment_id: result.id });
      netValue = round2(netValue + v.variance_value);
      await db.prepare('UPDATE stocktake_lines SET adjustment_id = ?, variance_value = ?, updated_at = ? WHERE id = ?')
        .bind(result.id, v.variance_value, ts, v.line_id).run();
    } catch (e) {
      failed.push({ line_id: v.line_id, product_name: v.product_name, error: e && e.message });
    }
  }

  await db.prepare(`
    UPDATE stocktake_sessions
    SET status = 'COMMITTED', committed_by = ?, committed_at = ?, variance_lines = ?, net_variance_value = ?,
        counted_lines = ?, notes = COALESCE(notes || ' | ','') || ?, updated_at = ?
    WHERE id = ?
  `).bind(ctx.user.id, ts, posted.length, netValue, preview.counted_lines,
    `${posted.length} adjustments posted${failed.length ? `, ${failed.length} failed` : ''}. ${note || ''}`.slice(0, 500), ts, stocktakeId).run();

  await writeAudit(db, {
    businessUnitId: ctx.businessUnitId, branchId: session.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'STOCKTAKE_COMMITTED', entityType: 'STOCKTAKE', entityId: stocktakeId,
    amount: netValue, after: { reference: session.reference, adjustments: posted.length, failed: failed.length, net_variance_value: netValue },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id: stocktakeId, reference: session.reference, status: 'COMMITTED',
    adjustments_posted: posted.length, adjustments_failed: failed.length,
    net_variance_value: netValue,
    absolute_variance_value: preview.absolute_variance_value,
    posted, failed,
    advisory: failed.length
      ? `${failed.length} line(s) could not be posted and need attention: ${failed.slice(0, 3).map((f) => `${f.product_name} — ${f.error}`).join('; ')}`
      : null,
  };
}

async function cancel(db, ctx, { stocktakeId, reason }) {
  const session = await load(db, stocktakeId, ctx.businessUnitId);
  if (!session) throw new HttpError(404, 'That stocktake was not found.', 'STOCKTAKE_NOT_FOUND');
  assertBranchAccess(ctx.user, session.branch_id);
  if (session.status === 'COMMITTED') throw new HttpError(409, 'A committed stocktake cannot be cancelled — its adjustments are already posted.', 'STOCKTAKE_ALREADY_COMMITTED');
  if (!reason || String(reason).trim().length < 4) {
    throw new HttpError(400, 'Cancelling a count needs a reason of at least 4 characters.', 'CANCEL_REASON_REQUIRED');
  }
  const ts = watNowIso();
  await db.prepare(`
    UPDATE stocktake_sessions SET status = 'CANCELLED', cancelled_by = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?
  `).bind(ctx.user.id, String(reason).slice(0, 500), ts, stocktakeId).run();
  await writeAudit(db, {
    businessUnitId: ctx.businessUnitId, branchId: session.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'STOCKTAKE_CANCELLED', entityType: 'STOCKTAKE', entityId: stocktakeId,
    reason: String(reason).slice(0, 500), ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: stocktakeId, status: 'CANCELLED' };
}

async function recount(db, ctx, { stocktakeId, lineId, quantity, note = null }) {
  const session = await load(db, stocktakeId, ctx.businessUnitId);
  if (!session) throw new HttpError(404, 'That stocktake was not found.', 'STOCKTAKE_NOT_FOUND');
  if (session.status === 'COMMITTED') throw new HttpError(409, 'That stocktake is committed and cannot be recounted.', 'STOCKTAKE_ALREADY_COMMITTED');
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 0) throw new HttpError(400, 'The recount quantity must be zero or more.', 'RECOUNT_QUANTITY_INVALID');
  const ts = watNowIso();
  const line = await db.prepare('SELECT * FROM stocktake_lines WHERE id = ? AND stocktake_id = ?').bind(lineId, stocktakeId).first();
  if (!line) throw new HttpError(404, 'That count line was not part of this stocktake.', 'STOCKTAKE_LINE_NOT_FOUND');
  await db.prepare(`
    UPDATE stocktake_lines SET recount_quantity = ?, recount_by = ?, recount_at = ?,
      counted_quantity = ?, variance = ?, note = COALESCE(?, note), updated_at = ?
    WHERE id = ?
  `).bind(qty, ctx.user.id, ts, qty, round2(qty - Number(line.system_quantity)), note || null, ts, lineId).run();
  return { ok: true, line_id: lineId, recount_quantity: qty };
}

async function load(db, stocktakeId, businessUnitId = null) {
  return db.prepare(`
    SELECT st.*, b.name AS branch_name, b.code AS branch_code,
           u.full_name AS opened_by_name, c.full_name AS committed_by_name
    FROM stocktake_sessions st
    JOIN branches b ON b.id = st.branch_id
    LEFT JOIN users u ON u.id = st.opened_by
    LEFT JOIN users c ON c.id = st.committed_by
    WHERE st.id = ? AND st.is_deleted = 0 ${businessUnitId ? 'AND st.business_unit_id = ?' : ''}
  `).bind(stocktakeId, ...(businessUnitId ? [businessUnitId] : [])).first();
}

async function list(db, { businessUnitId, branchId = null, status = null, limit = 50, offset = 0 }) {
  const where = ['st.is_deleted = 0', 'st.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('st.branch_id = ?'); params.push(branchId); }
  if (status) { where.push('st.status = ?'); params.push(String(status).toUpperCase()); }
  const rows = await db.prepare(`
    SELECT st.*, b.name AS branch_name, u.full_name AS opened_by_name
    FROM stocktake_sessions st
    JOIN branches b ON b.id = st.branch_id
    LEFT JOIN users u ON u.id = st.opened_by
    WHERE ${where.join(' AND ')}
    ORDER BY st.created_at DESC LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();
  return rows.results;
}

// Count-sheet export: the paper a storekeeper actually walks the shelves
// with. Ordered by product name and, for a blind count, with the system
// quantity column left blank. A stocktake that can only be done on a screen
// will not be done in a warehouse with no signal.
async function countSheet(db, stocktakeId, businessUnitId) {
  const session = await load(db, stocktakeId, businessUnitId);
  if (!session) throw new HttpError(404, 'That stocktake was not found.', 'STOCKTAKE_NOT_FOUND');
  const rows = await db.prepare(`
    SELECT sl.id AS line_id, sl.system_quantity, sl.counted_quantity, sl.stock_batch_id,
           p.name AS product_name, p.sku, p.base_unit, sb.batch_no
    FROM stocktake_lines sl
    JOIN products p ON p.id = sl.product_id
    LEFT JOIN stock_batches sb ON sb.id = sl.stock_batch_id
    WHERE sl.stocktake_id = ? AND sl.is_deleted = 0
    ORDER BY p.name
  `).bind(stocktakeId).all();
  return {
    reference: session.reference, branch: session.branch_name, scope: session.scope,
    blind_count: !!session.blind_count, opened_at: session.opened_at,
    lines: rows.results.map((r) => ({
      line_id: r.line_id, product_name: r.product_name, sku: r.sku, base_unit: r.base_unit,
      batch_no: r.batch_no,
      // A blind count prints no system quantity. Printing one would defeat
      // the entire point of the setting.
      system_quantity: session.blind_count ? null : Number(r.system_quantity),
      counted_quantity: r.counted_quantity == null ? null : Number(r.counted_quantity),
    })),
  };
}

module.exports = { STATUSES, SCOPES, open, recordCount, previewVariances, commit, cancel, recount, load, list, countSheet };
'use strict';
