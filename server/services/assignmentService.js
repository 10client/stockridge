'use strict';
// =====================================================================
// server/services/assignmentService.js — WHO CAN SEE WHICH SHOP, AND WHEN
// =====================================================================
// `users.branch_id` IS THE ONLY SCOPING TRUTH IN THIS PRODUCT. It decides which
// takings a cashier can see, which drawer they can open, which stock they can sell.
// Nothing else about a user changes so much about what they are allowed to do.
//
// And until this file existed, that column could be changed by one row update with
// no record of the move at all. Two questions were unanswerable:
//
//   "Who could see the Minna till on 14 March?"  — nothing recorded a move, so the
//   only answer was the CURRENT assignment, projected backwards onto every date.
//
//   "Did anybody at Minna agree to receive this cashier?"  — `pending_user_transfers`
//   has been in the schema since the first migration, with its comment spelling out
//   the rule ("the receiving manager must accept, so a cashier cannot be silently
//   moved to a branch nobody is staffing"), and nothing ever created a row.
//
// So every branch change now goes through this module. It does two things:
//
//   1. RECORDS EVERY ASSIGNMENT, including the moment a user is created — because a
//      history that only starts at somebody's first transfer cannot answer the
//      question above for the majority of staff, who never transfer at all. A person
//      created at Wuse on 2 January and still there in March must be findable at
//      Wuse on 14 March, and the only way to be sure of that is for their creation to
//      have written the row that says so.
//
//   2. TURNS A MOVE INTO A HANDOVER for STAFF and MANAGER. The receiving branch's
//      manager accepts or refuses. The user does NOT move while it is pending — the
//      pending row is a question, and a question is not an assignment.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: it does not decide who may ASK for a
// transfer, who may ACCEPT one, or what an owner may do. Those are permission
// questions and they live next to the routes, where the caller's role is known. This
// module is the bookkeeping: it keeps the row, the history and the user's assignment
// consistent with each other, and it refuses the states that have no meaning (a
// transfer to the branch they are already at, a second transfer while one is open).
// =====================================================================

const { newId } = require('../../domain/crypto');

const TRANSFER_STATUSES = Object.freeze(['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED']);

/** What this transfer is about, in one line, for a screen or a refusal message. */
function describeTransfer(row) {
  const from = row.from_branch_name || 'no branch';
  return `${row.full_name || row.username} moves from ${from} to ${row.to_branch_name}`;
}

/**
 * WRITE THE HISTORY ROW. One row per assignment change, and the ONLY place rows are
 * written — a second writer is a second version of the truth.
 *
 * `fromBranchId` may be null (a brand-new user holds no branch yet) and `toBranchId`
 * may be null (a user released from a branch). Both are recorded as they are: a
 * history that silently dropped the nulls could not show a person being detached.
 */
async function recordAssignment(db, {
  userId, fromBranchId = null, toBranchId = null,
  fromBusinessId = null, toBusinessId = null,
  reason = null, changedBy = null, changedAt = null,
}) {
  if (!userId) throw new Error('recordAssignment needs a user');
  const id = newId();
  await db.run(`INSERT INTO user_assignment_history (
      id, user_id, from_business_id, to_business_id, from_branch_id, to_branch_id, reason, changed_by, changed_at)
    VALUES (?,?,?,?,?,?,?,?, COALESCE(?, datetime('now')))`, [
    id, String(userId),
    fromBusinessId == null ? null : String(fromBusinessId),
    toBusinessId == null ? null : String(toBusinessId),
    fromBranchId == null ? null : String(fromBranchId),
    toBranchId == null ? null : String(toBranchId),
    reason == null ? null : String(reason).slice(0, 300),
    changedBy == null ? null : String(changedBy),
    changedAt || null,
  ]);
  return id;
}

/**
 * ASK FOR A MOVE. Returns the pending row, or throws `TRANSFER_ALREADY_PENDING`.
 *
 * The unique index `idx_pending_user_transfer_open` allows one OPEN transfer per user,
 * and that is a product rule, not a database detail: two open questions about the same
 * person ("to Kano" and "to Minna") have no answer that is not a guess, and whichever
 * manager accepts first would silently win.
 */
async function requestTransfer(db, { userId, toBranchId, requestedBy, reason = null }) {
  const target = await db.first('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [String(userId)]);
  if (!target) return { error: 'USER_NOT_FOUND' };

  const to = await db.first('SELECT * FROM branches WHERE id = ? AND is_deleted = 0', [String(toBranchId)]);
  if (!to) return { error: 'BRANCH_NOT_FOUND' };

  if (String(target.branch_id || '') === String(to.id)) return { error: 'ALREADY_THERE', target, to };

  const open = await db.first(`SELECT * FROM pending_user_transfers
      WHERE user_id = ? AND status = 'PENDING' AND is_deleted = 0
      ORDER BY requested_at DESC, rowid DESC LIMIT 1`, [String(userId)]);
  if (open) return { error: 'ALREADY_PENDING', open, target, to };

  const id = newId();
  await db.run(`INSERT INTO pending_user_transfers (
      id, user_id, from_branch_id, to_branch_id, requested_by, requested_at, status, reason, updated_at)
    VALUES (?,?,?,?,?, datetime('now'), 'PENDING', ?, datetime('now'))`, [
    id, String(userId),
    target.branch_id == null ? null : String(target.branch_id),
    String(to.id), String(requestedBy),
    reason == null ? null : String(reason).slice(0, 300),
  ]);
  const row = await db.first('SELECT * FROM pending_user_transfers WHERE id = ?', [id]);
  return { transfer: row, target, to };
}

/**
 * ACCEPT IT — the handover completes, and THIS is the only place a transfer moves a
 * user. The row is claimed with a conditional UPDATE first, so two managers pressing
 * accept at the same moment cannot both move the person and both write a history row.
 */
async function acceptTransfer(db, { transferId, actorId, at = null }) {
  const claimed = await db.run(`UPDATE pending_user_transfers
      SET status = 'ACCEPTED', resolved_by = ?, resolved_at = COALESCE(?, datetime('now')), updated_at = datetime('now')
    WHERE id = ? AND status = 'PENDING' AND is_deleted = 0`,
  [String(actorId), at || null, String(transferId)]);
  // `db.run` normalises both engines to { changes } — see server/lib/db.js:179.
  if (!Number(claimed.changes || 0)) return { error: 'NOT_PENDING' };

  const row = await db.first('SELECT * FROM pending_user_transfers WHERE id = ?', [String(transferId)]);
  const before = await db.first('SELECT * FROM users WHERE id = ?', [String(row.user_id)]);
  const to = await db.first('SELECT * FROM branches WHERE id = ?', [String(row.to_branch_id)]);

  await db.run(`UPDATE users SET branch_id = ?, business_id = ?, updated_at = datetime('now')
      WHERE id = ? AND is_deleted = 0`, [String(to.id), String(to.business_id), String(row.user_id)]);

  await recordAssignment(db, {
    userId: row.user_id,
    fromBranchId: before ? before.branch_id : row.from_branch_id,
    toBranchId: to.id,
    fromBusinessId: before ? before.business_id : null,
    toBusinessId: to.business_id,
    reason: `Transfer accepted${row.reason ? ` — ${row.reason}` : ''}`,
    changedBy: actorId,
    changedAt: at,
  });
  return { transfer: row, user: before, to };
}

/**
 * REFUSE OR WITHDRAW IT. Both end the question without moving anybody, and both keep
 * the row: "Kano was asked and said no" is the fact an owner needs when the same
 * request comes round again in three months.
 */
async function resolveTransfer(db, { transferId, status, actorId, reason = null, at = null }) {
  if (!['REJECTED', 'CANCELLED'].includes(status)) throw new Error(`resolveTransfer cannot set ${status}`);
  const res = await db.run(`UPDATE pending_user_transfers
      SET status = ?, resolved_by = ?, resolved_at = COALESCE(?, datetime('now')), updated_at = datetime('now'),
          reason = TRIM(COALESCE(reason, '') || ?)
    WHERE id = ? AND status = 'PENDING' AND is_deleted = 0`,
  [status, String(actorId), at || null, reason ? ` | ${String(reason).slice(0, 300)}` : '', String(transferId)]);
  if (!Number(res.changes || 0)) return { error: 'NOT_PENDING' };
  const row = await db.first('SELECT * FROM pending_user_transfers WHERE id = ?', [String(transferId)]);
  return { transfer: row };
}

/**
 * WHERE SOMEBODY WAS ON A GIVEN DAY — the question the history exists to answer, and
 * the reason every creation writes a row.
 *
 * The answer is the `to_branch_id` of the newest assignment row at or before the end
 * of that day, because each row says "from here on, this person is at that branch".
 * A person with no row yet had not been created yet.
 */
async function assignmentAt(db, { userId, at, endOfDay = 'T23:59:59' }) {
  const row = await db.first(`SELECT h.to_branch_id, h.to_business_id, h.changed_at, h.reason,
        b.name AS branch_name
      FROM user_assignment_history h
      LEFT JOIN branches b ON b.id = h.to_branch_id
      WHERE h.user_id = ? AND h.changed_at <= ?
      ORDER BY h.changed_at DESC, h.rowid DESC LIMIT 1`, [String(userId), `${String(at)}${endOfDay}`]);
  return row || null;
}

/**
 * WHO COULD SEE THIS BRANCH ON THIS DAY. One query, because the answer is read while
 * somebody is looking at a discrepancy and not at the end of a report run.
 */
async function coverageAt(db, { businessId, branchId, at, endOfDay = 'T23:59:59' }) {
  const cutoff = `${String(at)}${endOfDay}`;
  const rows = await db.all(`SELECT u.id, u.full_name, u.username, u.role, u.is_active,
        (SELECT h.to_branch_id FROM user_assignment_history h
           WHERE h.user_id = u.id AND h.changed_at <= ?
           ORDER BY h.changed_at DESC, h.rowid DESC LIMIT 1) AS branch_then
      FROM users u
      WHERE u.is_deleted = 0${businessId ? ' AND u.business_id = ?' : ''}
      ORDER BY u.full_name, u.id`, businessId ? [cutoff, String(businessId)] : [cutoff]);
  return rows.filter((r) => String(r.branch_then || '') === String(branchId));
}

/** The history of one person, newest first, with the branches named. */
async function historyFor(db, { userId, limit = 50 }) {
  return db.all(`SELECT h.*, fb.name AS from_branch_name, tb.name AS to_branch_name,
        cu.full_name AS changed_by_name, cu.username AS changed_by_username
      FROM user_assignment_history h
      LEFT JOIN branches fb ON fb.id = h.from_branch_id
      LEFT JOIN branches tb ON tb.id = h.to_branch_id
      LEFT JOIN users cu ON cu.id = h.changed_by
      WHERE h.user_id = ?
      ORDER BY h.changed_at DESC, h.rowid DESC
      LIMIT ?`, [String(userId), Number(limit) || 50]);
}

/** The pending transfers aimed at a set of branches, with everything a screen needs. */
async function pendingFor(db, { businessId = null, toBranchIds = null, userId = null } = {}) {
  const where = ["t.status = 'PENDING'", 't.is_deleted = 0'];
  const params = [];
  if (userId) { where.push('t.user_id = ?'); params.push(String(userId)); }
  if (toBranchIds && toBranchIds.length) {
    where.push(`t.to_branch_id IN (${toBranchIds.map(() => '?').join(',')})`);
    params.push(...toBranchIds.map(String));
  }
  if (businessId) { where.push('u.business_id = ?'); params.push(String(businessId)); }
  return db.all(`SELECT t.*, u.full_name, u.username, u.role, u.is_active,
        fb.name AS from_branch_name, tb.name AS to_branch_name,
        ru.full_name AS requested_by_name, ru.username AS requested_by_username
      FROM pending_user_transfers t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN branches fb ON fb.id = t.from_branch_id
      LEFT JOIN branches tb ON tb.id = t.to_branch_id
      LEFT JOIN users ru ON ru.id = t.requested_by
      WHERE ${where.join(' AND ')}
      ORDER BY t.requested_at DESC, t.rowid DESC
      LIMIT 100`, params);
}

module.exports = {
  TRANSFER_STATUSES,
  describeTransfer,
  recordAssignment,
  requestTransfer,
  acceptTransfer,
  resolveTransfer,
  assignmentAt,
  coverageAt,
  historyFor,
  pendingFor,
};
