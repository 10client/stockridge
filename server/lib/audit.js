'use strict';
// =====================================================================
// server/lib/audit.js — HASH-CHAINED AUDIT TRAIL
// =====================================================================
// WHAT GETS AUDITED, AND WHAT DELIBERATELY DOES NOT
//
// Auditing every request would produce a table that grows by tens of
// thousands of rows a day and that nobody reads, which is worse than no
// audit trail because it hides the entries that matter. So this records
// PRIVILEGED and IRREVERSIBLE actions — the ones where "who did this, and
// were they allowed to" is the question an owner asks six weeks later:
//
//   authentication      sign-in, sign-out, failed sign-in, lock cleared
//   money movements     sale voided, refund, safe draw, till open/close,
//                       expense approved, credit-limit override, WHT posted
//   stock integrity     adjustment, stocktake committed, transfer
//                       initiated/received, batch quarantined, recall opened
//   authority changes   user created/edited/deactivated/role changed,
//                       branch or business created, permission switch flipped
//   data lifecycle      export taken, bulk cleanup run, database reset
//   scope violations    any 403 from the access layer — an ATTEMPTED
//                       cross-branch write is the single most useful line in
//                       this table, because it is the one that says somebody
//                       tried something they were not allowed to do
//
// Ordinary reads and ordinary sales are NOT here. A sale is already its own
// permanent record with an actor on it; duplicating it into an audit table
// buys nothing and costs a write per line item.
//
// The chain itself is documented in domain/hashChain.js. The short version:
// each row hashes its predecessor, a UNIQUE index on prev_hash makes a fork
// impossible to insert, and verifyAuditChain() can be run at any time to
// answer "has this trail been altered?" — which is tamper-EVIDENT, not
// tamper-proof, and the difference is stated in that module rather than
// glossed over here.
// =====================================================================

const { appendChained, verifyChain, anchor } = require('../../domain/hashChain');

const AUDIT_ACTIONS = Object.freeze([
  // THE NAMES THE TRAIL MAY USE, reconciled with the code that writes it by
  // `tools/audit-actions.js` and held there by `test/unit/audit-actions.test.js`.
  //
  // An action that is not in this list is an action an auditor cannot name, and a name
  // in this list that nothing writes is a name they will search for and never find. Both
  // were true of this list before it was reconciled: 50 actions were written under names
  // it did not contain (`SESSIONS_REVOKED`, `CUSTOMER_DELETED`, every compliance action)
  // and 31 names in it had never been written by anything.
  'ACCESS_DENIED', 'ATTENDANCE_REJECTED', 'ATTENDANCE_REVIEWED', 'AUDIT_CHAIN_ANCHORED', 'BATCH_QUARANTINED', 'BRANCH_CREATED', 'BRANCH_UPDATED', 'BRANDING_UPDATED', 'BUSINESS_ACCESS_GRANTED', 'BUSINESS_ACCESS_REGRANTED', 'BUSINESS_ACCESS_REVOKED', 'BUSINESS_CREATED',
  'BUSINESS_UPDATED', 'CATEGORY_CREATED', 'CHANGE_OWED_SETTLED', 'CHANGE_OWED_WRITTEN_OFF', 'CLOCK_IN', 'CLOCK_OUT', 'COMPLIANCE_ALERTS_RAISED', 'COMPLIANCE_RECORD_CREATED', 'COMPLIANCE_RECORD_REMOVED', 'COMPLIANCE_RECORD_UPDATED', 'CUSTOMER_CLASS_CREATED', 'CUSTOMER_CREATED',
  'CUSTOMER_DELETED', 'CUSTOMER_PAYMENT', 'CUSTOMER_UPDATED', 'DATA_CLEANUP_RUN', 'DEBTOR_PAYMENT', 'DEBT_WRITTEN_OFF', 'DELIVERY_STATUS_CHANGED', 'DEPOSIT_CANCELLED', 'DEPOSIT_COMPLETED', 'DEPOSIT_FORFEITED', 'DEPOSIT_PAYMENT', 'DEPOSIT_TAKEN',
  'DEVICE_STATUS_CHANGED', 'EXPENSE_APPROVED', 'EXPENSE_RECORDED', 'EXPENSE_REJECTED', 'GEOFENCE_UPDATED', 'GL_ACCOUNT_CREATED', 'INSTALLATION_BOOKED', 'INSTALLATION_COMPLETED', 'INSTALMENT_PAYMENT', 'INSTALMENT_PLAN_OPENED', 'LOGIN_FAILURE', 'LOGIN_LOCK_CLEARED',
  'LOGIN_SUCCESS', 'LOGOUT', 'MANUAL_JOURNAL_POSTED', 'PIN_CHANGED', 'PIN_RESET', 'PLAN_LIMITS_CHANGED', 'PO_CANCELLED', 'PO_CREATED', 'PO_RECEIVED', 'PRICE_CHANGED', 'PRICE_OVERRIDE_CHANGED', 'PRICE_OVERRIDE_REMOVED',
  'PRICE_OVERRIDE_SET', 'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'RETURN_APPROVED', 'RETURN_CREATED', 'RETURN_REJECTED', 'SAFE_ENTRY', 'SAFE_PAYOUT', 'SAFE_RECONCILED', 'SALE_COMPLETED', 'SALE_VOIDED', 'SESSIONS_REVOKED',
  'SETTINGS_UPDATED', 'STOCKTAKE_COMMITTED', 'STOCKTAKE_OPENED', 'STOCK_ADJUSTED', 'SUPPLIER_PAID', 'SYNC_CONFLICT_RESOLVED', 'SYNC_PUSH_PARTIAL', 'TILL_CLOSED', 'TILL_OPENED', 'TILL_REVIEWED', 'TILL_REVIEW_REJECTED', 'TRANSFER_CANCELLED',
  'TRANSFER_INITIATED', 'TRANSFER_RECEIVED', 'USER_CREATED', 'USER_DEACTIVATED', 'USER_PIN_RESET', 'USER_TRANSFER_ACCEPTED', 'USER_TRANSFER_CANCELLED', 'USER_TRANSFER_REJECTED', 'USER_TRANSFER_REQUESTED', 'USER_UPDATED', 'WARRANTY_CLAIM_OPENED', 'WARRANTY_CLAIM_RESOLVED',
  'WHT_REMITTED',
]);

const AUDIT_ACTIONS_RESERVED = Object.freeze([
  // RESERVED: names for events this product does not distinguish yet. Kept, separately and
  // labelled, because deleting them would erase the record that the difference is known.
  // A role change is recorded inside USER_UPDATED; the VAT rate inside SETTINGS_UPDATED; a
  // bulk export is not recorded at all; a superseded session is not recorded at all. An
  // auditor reading the trail cannot tell those apart today, and this list is how that is
  // said out loud instead of hidden behind a vocabulary that pretends otherwise.
  'BRANCH_DEACTIVATED', 'CHANGE_OWED_ISSUED', 'CHANGE_OWED_REDEEMED', 'COMPLIANCE_ADDED', 'CREDITOR_PAYMENT', 'CREDIT_OVERRIDE', 'DATA_CLEANUP', 'DELIVERY_CREATED', 'DEPOSIT_CREATED', 'DEVICE_REGISTERED', 'DEVICE_REVOKED', 'EXPENSE_CREATED',
  'EXPORT_TAKEN', 'INSTALMENT_DEFAULTED', 'INSTALMENT_PLAN_CREATED', 'PERMISSION_CHANGED', 'RECALL_OPENED', 'REPARENT_BLOCKED', 'RETURN_COMPLETED', 'SALE_REFUNDED', 'SESSION_SUPERSEDED', 'SYNC_CONFLICT', 'SYNC_PUSH_REJECTED', 'TOKEN_REJECTED',
  'USER_BRANCH_CHANGED', 'USER_BUSINESS_CHANGED', 'USER_ROLE_CHANGED', 'USER_TRANSFER_RESOLVED', 'VAT_CHANGED', 'WHT_POSTED',
]);

/**
 * Append one audit entry.
 *
 * THE VOCABULARY IS NOT ENFORCED HERE, deliberately. `AUDIT_ACTIONS` above is the list of
 * names the trail may use, but `record()` accepts any string, and this is a decision rather
 * than an oversight. Failing a write because a caller invented a name would DROP THE ROW —
 * losing the record of a privileged action in order to protect a list — which inverts what an
 * audit trail is for. A new call site whose name nobody listed must still produce its row.
 * The drift is then caught where it is cheap: `node tools/audit-actions.js` reports names the
 * code writes that the vocabulary does not admit, and `test/unit/audit-actions.test.js` fails
 * the build on the same condition. Keep this order — never trade a row for a name.
 *
 * NEVER THROWS. An audit failure must not break the action being audited —
 * a shop that cannot void a sale because its audit table is locked is a shop
 * with a queue at the counter and a cashier improvising. The failure is
 * logged loudly to stderr, where a supervisor process can alert on it.
 *
 * That is a real trade and it is stated plainly: under database failure this
 * system prioritises trading over logging. The compensating control is that
 * the primary record of every audited action (the sale row, the adjustment
 * row, the user row) is written in the SAME transaction as the action, so
 * losing the audit entry does not lose the fact.
 */
async function record(db, {
  action, userId = null, username = null, branchId = null, businessId = null,
  entityType = null, entityId = null, before = null, after = null,
  ipAddress = null, userAgent = null,
}) {
  try {
    if (!action) return null;
    const id = require('../../domain/crypto').newId();
    const fields = {
      id,
      action: String(action),
      business_id: businessId ? String(businessId) : null,
      branch_id: branchId ? String(branchId) : null,
      user_id: userId ? String(userId) : null,
      username: username ? String(username) : null,
      entity_type: entityType ? String(entityType) : null,
      entity_id: entityId ? String(entityId) : null,
      ip_address: ipAddress ? String(ipAddress).slice(0, 60) : null,
      user_agent: userAgent ? String(userAgent).slice(0, 200) : null,
      before_json: before ? JSON.stringify(before) : null,
      after_json: after ? JSON.stringify(after) : null,
    };

    await appendChained(db, {
      table: 'audit_log',
      columns: ['id', 'business_id', 'branch_id', 'user_id', 'username', 'action',
        'entity_type', 'entity_id', 'before_json', 'after_json', 'ip_address', 'user_agent'],
      values: [fields.id, fields.business_id, fields.branch_id, fields.user_id, fields.username,
        fields.action, fields.entity_type, fields.entity_id, fields.before_json, fields.after_json,
        fields.ip_address, fields.user_agent],
      hashFields: fields,
    });
    return id;
  } catch (e) {
    console.error('[audit] could not record', action, ':', e && e.message);
    return null;
  }
}

/** Convenience wrapper that pulls actor details off the request context. */
async function recordFromCtx(ctx, { action, entityType = null, entityId = null, before = null, after = null, branchId = null, businessId = null }) {
  const user = ctx.get ? ctx.get('user') : null;
  return record(ctx.env.DB || ctx.env.db, {
    action,
    userId: user && user.id,
    username: user && user.username,
    branchId: branchId || (user && user.branch_id) || null,
    businessId: businessId || (user && (user.business_id || user.branch_business_id)) || null,
    entityType, entityId, before, after,
    ipAddress: ctx.req.header('CF-Connecting-IP') || ctx.req.header('X-Forwarded-For') || null,
    userAgent: ctx.req.header('User-Agent') || null,
  });
}

/**
 * Record a denied access attempt.
 *
 * This is the highest-value line in the whole table. Every other entry says
 * what somebody DID; this says what somebody TRIED. A branch manager who
 * repeatedly attempts to read another branch's till is visible here long
 * before anything is provable from the sales data.
 */
async function recordDenied(ctx, { reason, entityType = null, entityId = null, attemptedBranchId = null }) {
  return recordFromCtx(ctx, {
    action: 'ACCESS_DENIED',
    entityType, entityId,
    after: { reason, attempted_branch_id: attemptedBranchId, path: ctx.path, method: ctx.method },
  });
}

/** Query the trail with the same scope rules as everything else. */
async function list(db, { scope, action = null, entityType = null, entityId = null, userId = null, branchId = null, from = null, to = null, limit = 200, offset = 0 } = {}) {
  const where = ['1 = 1'];
  const params = [];

  if (scope && !scope.allBranches) {
    // An audit trail scoped by branch would let a branch manager erase their
    // own trail by acting cross-branch, so a scoped user sees entries for
    // THEIR branches plus any entry with no branch at all (deployment-level
    // actions like a settings change).
    const ids = Array.from(scope.branchIds || []);
    if (ids.length) {
      where.push(`(branch_id IS NULL OR branch_id IN (${ids.map(() => '?').join(',')}))`);
      params.push(...ids);
    } else {
      where.push('branch_id IS NULL');
    }
  }
  if (scope && !scope.allBusinesses) {
    const ids = Array.from(scope.businessIds || []);
    if (ids.length) {
      where.push(`(business_id IS NULL OR business_id IN (${ids.map(() => '?').join(',')}))`);
      params.push(...ids);
    }
  }
  if (action) { where.push('action = ?'); params.push(String(action)); }
  if (entityType) { where.push('entity_type = ?'); params.push(String(entityType)); }
  if (entityId) { where.push('entity_id = ?'); params.push(String(entityId)); }
  if (userId) { where.push('user_id = ?'); params.push(String(userId)); }
  if (branchId) { where.push('branch_id = ?'); params.push(String(branchId)); }
  if (from) { where.push("created_at >= datetime(?)"); params.push(String(from)); }
  if (to) { where.push("created_at <= datetime(?)"); params.push(String(to)); }

  const n = Math.min(1000, Math.max(1, Number(limit) || 200));
  const off = Math.max(0, Number(offset) || 0);
  const rows = await db.all(
    `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    [...params, n, off],
  );
  const total = await db.scalar(`SELECT COUNT(*) FROM audit_log WHERE ${where.join(' AND ')}`, params);
  return { rows, total: Number(total || 0), limit: n, offset: off };
}

/** Verify the whole chain. Exposed at /api/audit/verify for OWNER and ADMIN. */
async function verifyAuditChain(db) {
  return verifyChain(db, {
    table: 'audit_log',
    hashColumn: 'row_hash',
    prevColumn: 'prev_hash',
    // The fields that were hashed, reconstructed from the stored row. This
    // list must match the writer's exactly — which is why it is derived from
    // the same field names rather than restated.
    expectedFieldBuilder: (row) => ({
      id: row.id,
      action: row.action,
      business_id: row.business_id,
      branch_id: row.branch_id,
      user_id: row.user_id,
      username: row.username,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      before_json: row.before_json,
      after_json: row.after_json,
    }),
  });
}

async function anchorAudit(db) {
  return anchor(db, { table: 'audit_log', hashColumn: 'row_hash', prevColumn: 'prev_hash' });
}

module.exports = { AUDIT_ACTIONS, AUDIT_ACTIONS_RESERVED, record, recordFromCtx, recordDenied, list, verifyAuditChain, anchorAudit };
