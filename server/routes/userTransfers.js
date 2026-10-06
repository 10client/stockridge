'use strict';
// =====================================================================
// server/routes/userTransfers.js — MOVING SOMEBODY TO ANOTHER SHOP
// =====================================================================
// A cashier moving from Wuse to Minna does not change their PIN, their name or their
// job title. They change WHAT THEY CAN SEE — and that is why this is a handover with
// two decisions in it rather than one row update:
//
//   the owner (or a manager) ASKS, and the branch that receives them ANSWERS.
//
// The receiving manager is the person who will be accountable for a drawer the new
// cashier opens, so their agreement is not a formality. Until they agree, the person
// keeps working where they are: the pending row is a QUESTION, and a question is not
// an assignment. That single sentence is the whole feature — a system where asking
// moved somebody would make the question meaningless.
//
// FRONT TO BACK: the screen lists what is waiting at my branch, shows who asked and
// why, and offers accept and refuse. BACK TO FRONT: whatever is decided, the
// assignment is written down, so "who could see the Minna till on 14 March?" has an
// answer that is not a projection of today's rota onto last March.
//
// REFUSALS ARE RECORDED, NOT ERASED. "Kano was asked in March and said no" is exactly
// what an owner needs in June when the same cashier asks again, so a rejected transfer
// keeps its row, its date and its reason.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast, canManageUser, roleLabel } = require('../../domain/roles');
const { watToday } = require('../../domain/time');
const assignments = require('../services/assignmentService');
const {
  strField, scopeFilter, inScope, pagination, listResponse,
} = require('../lib/respond');

// THE SAME FLOOR AS A CHANGE-OWED WRITE-OFF, and for the same reason: this reason is
// the only explanation anybody will have, and "no" is not one. It is only required
// when a reason is given at all — refusing a transfer is allowed to be brief.
const MIN_REASON = 12;

function mount(app, base) {
  /**
   * ASK FOR THE MOVE.
   *
   * `to_branch_id` must be a real, active branch, and asking again while a question is
   * open is refused rather than queued: two open transfers for one person have no
   * answer that is not a guess.
   */
  app.post(`${base}/users/:id/transfer`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json().catch(() => ({}));

    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can ask for somebody to be moved between branches.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const target = await db.first('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [id]);
    if (!target) throw new HttpError('That user does not exist.', { status: 404, code: 'USER_NOT_FOUND' });
    if (!canManageUser(user, target)) {
      throw new HttpError(`You are a ${roleLabel(user.role)} and cannot move a ${roleLabel(target.role)}.`, { status: 403, code: 'ROLE_REQUIRED' });
    }
    if (!inScope(ctx.get('scope'), target) && !atLeast(user.role, 'ADMIN')) {
      throw new HttpError('That user is at another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }
    if (String(target.id) === String(user.id)) {
      throw new HttpError('You cannot transfer yourself. Somebody else has to ask for it, and the branch you are going to has to agree.', { status: 400, code: 'SELF_TRANSFER' });
    }
    if (!target.branch_id) {
      throw new HttpError(`${target.full_name} is not attached to a branch, so there is nothing to transfer. Give them a branch first.`, { status: 400, code: 'NO_BRANCH' });
    }

    const toBranchId = strField(body.to_branch_id, { field: 'Destination branch', maxLength: 64, required: true });
    const reason = strField(body.reason, { field: 'Reason', maxLength: 300 });
    if (reason && reason.trim().length < MIN_REASON) {
      throw new HttpError(`Give the reason in at least ${MIN_REASON} characters, or leave it out — "${reason}" will not tell the receiving manager anything.`, { status: 400, code: 'REASON_TOO_SHORT', fields: { reason: `At least ${MIN_REASON} characters, or leave it blank.` } });
    }

    const result = await assignments.requestTransfer(db, {
      userId: target.id, toBranchId, requestedBy: user.id, reason: reason || null,
    });
    if (result.error === 'USER_NOT_FOUND') throw new HttpError('That user does not exist.', { status: 404, code: 'USER_NOT_FOUND' });
    if (result.error === 'BRANCH_NOT_FOUND') throw new HttpError('That branch does not exist.', { status: 404, code: 'BRANCH_NOT_FOUND' });
    if (result.error === 'ALREADY_THERE') {
      throw new HttpError(`${target.full_name} is already at ${result.to.name}.`, { status: 409, code: 'ALREADY_THERE' });
    }
    if (result.error === 'ALREADY_PENDING') {
      const open = result.open;
      throw new HttpError(`${target.full_name} already has a transfer waiting — to ${result.to.name}, asked for on ${String(open.requested_at).slice(0, 10)}. Cancel that one first, or wait for it to be answered.`, { status: 409, code: 'TRANSFER_ALREADY_PENDING', fields: { pending_transfer_id: open.id } });
    }

    await recordFromCtx(ctx, {
      action: 'USER_TRANSFER_REQUESTED', entityType: 'USER_TRANSFER', entityId: result.transfer.id,
      branchId: String(result.to.id), businessId: String(result.to.business_id),
      before: { user_id: target.id, branch_id: target.branch_id },
      after: { user_id: target.id, to_branch_id: result.to.id, to_branch: result.to.name, reason: reason || null },
    });

    ctx.json({
      ok: true,
      pending: true,
      transfer: result.transfer,
      message: `${target.full_name} stays at ${result.transfer.from_branch_id ? 'their branch' : 'no branch'} until somebody at ${result.to.name} agrees to the move.`,
    }, 201);
  });

  /**
   * WHAT IS WAITING FOR ME TO DECIDE.
   *
   * A manager is asked about their OWN branch, because they are the one who will be
   * accountable for the person arriving. An owner sees every branch in their business,
   * and an administrator sees the deployment — which is the platform's job and not a
   * client's.
   */
  app.get(`${base}/users/transfers/pending`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can see transfers waiting for a decision.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const { limit, offset } = pagination(ctx, { defaultLimit: 50 });

    let toBranchIds = null;
    let businessId = scope && scope.businessId ? String(scope.businessId) : null;
    if (!atLeast(user.role, 'OWNER')) {
      // A MANAGER decides for their own branch only. `user.branch_id` is the scoping
      // truth everywhere else in this product and it is the truth here too.
      toBranchIds = user.branch_id ? [String(user.branch_id)] : [];
    } else if (atLeast(user.role, 'ADMIN')) {
      businessId = null;
    }
    const rows = await assignments.pendingFor(db, { businessId, toBranchIds });
    ctx.json(listResponse(rows, { limit, offset, total: rows.length }));
  });

  /**
   * WHAT IS WAITING THAT CONCERNS ME — as the person being moved, or as the person who
   * asked. A cashier who has been told "you are going to Minna next month" should be
   * able to see that it is still a question.
   */
  app.get(`${base}/users/transfers/pending/mine`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const mine = await db.all(`SELECT t.*, u.full_name, u.username, u.role,
          fb.name AS from_branch_name, tb.name AS to_branch_name,
          ru.full_name AS requested_by_name
        FROM pending_user_transfers t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN branches fb ON fb.id = t.from_branch_id
        LEFT JOIN branches tb ON tb.id = t.to_branch_id
        LEFT JOIN users ru ON ru.id = t.requested_by
        WHERE t.status = 'PENDING' AND t.is_deleted = 0
          AND (t.user_id = ? OR t.requested_by = ?)
        ORDER BY t.requested_at DESC, t.rowid DESC
        LIMIT 50`, [String(user.id), String(user.id)]);
    ctx.json({ ok: true, data: mine, count: mine.length });
  });

  /**
   * ACCEPT IT — the move happens here and nowhere else.
   *
   * WHO MAY ACCEPT: a manager at the receiving branch (the person who will answer for
   * the new arrival), the owner of the business, or the platform administrator. A
   * manager at a DIFFERENT branch may not, and neither may the person being moved —
   * accepting your own transfer is asking yourself for permission.
   */
  app.post(`${base}/users/transfers/:id/accept`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const row = await db.first('SELECT * FROM pending_user_transfers WHERE id = ? AND is_deleted = 0', [id]);
    if (!row) throw new HttpError('That transfer does not exist.', { status: 404, code: 'TRANSFER_NOT_FOUND' });
    if (row.status !== 'PENDING') {
      throw new HttpError(`That transfer was already ${String(row.status).toLowerCase()}.`, { status: 409, code: 'TRANSFER_NOT_PENDING' });
    }
    await assertMayDecide(db, ctx, row);

    const result = await assignments.acceptTransfer(db, { transferId: id, actorId: user.id });
    if (result.error === 'NOT_PENDING') {
      throw new HttpError('Somebody else answered that transfer first.', { status: 409, code: 'TRANSFER_NOT_PENDING' });
    }
    const moved = await db.first('SELECT full_name, username FROM users WHERE id = ?', [String(row.user_id)]);
    await recordFromCtx(ctx, {
      action: 'USER_TRANSFER_ACCEPTED', entityType: 'USER_TRANSFER', entityId: id,
      branchId: String(result.to.id), businessId: String(result.to.business_id),
      before: { user_id: row.user_id, branch_id: row.from_branch_id },
      after: { user_id: row.user_id, branch_id: result.to.id, branch: result.to.name },
    });
    ctx.json({
      ok: true,
      status: 'ACCEPTED',
      message: `${moved ? moved.full_name : 'They'} now works at ${result.to.name}. The change is in their assignment history.`,
    });
  });

  /**
   * REFUSE IT. A refusal is a decision and it is kept — with a reason when one is
   * given, because that reason is what the owner reads the next time this comes up.
   */
  app.post(`${base}/users/transfers/:id/reject`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json().catch(() => ({}));
    const row = await db.first('SELECT * FROM pending_user_transfers WHERE id = ? AND is_deleted = 0', [id]);
    if (!row) throw new HttpError('That transfer does not exist.', { status: 404, code: 'TRANSFER_NOT_FOUND' });
    if (row.status !== 'PENDING') {
      throw new HttpError(`That transfer was already ${String(row.status).toLowerCase()}.`, { status: 409, code: 'TRANSFER_NOT_PENDING' });
    }
    await assertMayDecide(db, ctx, row);
    const reason = strField(body.reason, { field: 'Reason', maxLength: 300 });

    const result = await assignments.resolveTransfer(db, { transferId: id, status: 'REJECTED', actorId: user.id, reason: reason || null });
    if (result.error === 'NOT_PENDING') throw new HttpError('Somebody else answered that transfer first.', { status: 409, code: 'TRANSFER_NOT_PENDING' });
    await recordFromCtx(ctx, {
      action: 'USER_TRANSFER_REJECTED', entityType: 'USER_TRANSFER', entityId: id,
      branchId: row.to_branch_id, businessId: null,
      before: { user_id: row.user_id, status: 'PENDING' },
      after: { user_id: row.user_id, status: 'REJECTED', reason: reason || null },
    });
    ctx.json({ ok: true, status: 'REJECTED', message: 'Refused. Nobody moves, and the refusal stays on the record.' });
  });

  /**
   * WITHDRAW IT — the person who asked has changed their mind, or the member of staff
   * has. Not the same as a refusal: nobody was asked and nobody said no.
   */
  app.post(`${base}/users/transfers/:id/cancel`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json().catch(() => ({}));
    const row = await db.first('SELECT * FROM pending_user_transfers WHERE id = ? AND is_deleted = 0', [id]);
    if (!row) throw new HttpError('That transfer does not exist.', { status: 404, code: 'TRANSFER_NOT_FOUND' });
    if (row.status !== 'PENDING') {
      throw new HttpError(`That transfer was already ${String(row.status).toLowerCase()}.`, { status: 409, code: 'TRANSFER_NOT_PENDING' });
    }
    const mine = String(row.user_id) === String(user.id) || String(row.requested_by) === String(user.id);
    if (!mine && !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only the person who asked, the person being moved, or a manager can withdraw a transfer.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    if (!mine && !atLeast(user.role, 'OWNER')) {
      // A manager at an uninvolved branch has no business withdrawing somebody else's
      // question; the receiving branch may still decide it, and an owner may end it.
      const targetBranch = user.branch_id ? String(user.branch_id) : null;
      if (String(row.to_branch_id) !== targetBranch) {
        throw new HttpError('That transfer is not at your branch, so you cannot withdraw it.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
      }
    }
    const reason = strField(body.reason, { field: 'Reason', maxLength: 300 });
    const result = await assignments.resolveTransfer(db, { transferId: id, status: 'CANCELLED', actorId: user.id, reason: reason || null });
    if (result.error === 'NOT_PENDING') throw new HttpError('Somebody else answered that transfer first.', { status: 409, code: 'TRANSFER_NOT_PENDING' });
    await recordFromCtx(ctx, {
      action: 'USER_TRANSFER_CANCELLED', entityType: 'USER_TRANSFER', entityId: id,
      branchId: row.to_branch_id, businessId: null,
      before: { user_id: row.user_id, status: 'PENDING' },
      after: { user_id: row.user_id, status: 'CANCELLED', reason: reason || null },
    });
    ctx.json({ ok: true, status: 'CANCELLED', message: 'Withdrawn. Nobody was asked to decide anything.' });
  });

  /**
   * ONE PERSON'S ASSIGNMENT HISTORY — where they have worked, and who moved them.
   */
  app.get(`${base}/users/:id/assignment-history`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const target = await db.first('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [id]);
    if (!target) throw new HttpError('That user does not exist.', { status: 404, code: 'USER_NOT_FOUND' });
    if (!canManageUser(user, target) && !atLeast(user.role, 'OWNER')) {
      throw new HttpError(`You are a ${roleLabel(user.role)} and cannot read a ${roleLabel(target.role)}'s history.`, { status: 403, code: 'ROLE_REQUIRED' });
    }
    if (!inScope(ctx.get('scope'), target) && !atLeast(user.role, 'ADMIN')) {
      throw new HttpError('That user is at another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }
    const rows = await assignments.historyFor(db, { userId: id, limit: 100 });
    const pending = await assignments.pendingFor(db, { userId: id });
    ctx.json({ ok: true, user: { id: target.id, full_name: target.full_name, username: target.username, branch_id: target.branch_id }, data: rows, pending: pending[0] || null, count: rows.length });
  });

  /**
   * WHO COULD SEE THIS BRANCH ON THIS DAY — the question that is asked AFTER something
   * has gone missing, usually weeks later, by somebody who was not there.
   *
   * It answers from the assignment history rather than from the current rota, and it
   * says out loud that DEACTIVATION IS NOT AN ASSIGNMENT: a deactivated user is still
   * listed with their branch for the day asked about, because the fact that they were
   * there is what matters. Their `is_active` flag is returned so the reader can see
   * which of them had already stopped working.
   */
  app.get(`${base}/assignment-history`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const scope = ctx.get('scope');
    if (!atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can ask who could see a branch.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    // READ GENEROUSLY, REFUSED PRECISELY. A length cap of ten turned "last Tuesday"
    // into TOO_LONG, which tells the caller nothing about the format they should use;
    // the check below is the one that produces a sentence they can act on.
    const at = strField(ctx.req.queryParam('at'), { field: 'Date', maxLength: 40 }) || watToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) {
      throw new HttpError(`Give the date as YYYY-MM-DD (received "${at}").`, { status: 400, code: 'INVALID_DATE' });
    }
    let branchId = strField(ctx.req.queryParam('branch_id'), { field: 'Branch', maxLength: 64 });
    if (!branchId) branchId = user.branch_id ? String(user.branch_id) : null;
    if (!branchId) {
      // THE SENTENCE HAS TO BE TRUE ON THE DEPLOYMENT IT IS SAID ON. "You can see more
      // than one" is right for an owner of a multi-branch business and nonsense on a
      // handover deployment whose administrator has no business at all — which is
      // exactly where this was first read. So the branch count is looked up, and the
      // answer says either "choose" or "there is nothing here yet".
      const branchCount = scope && scope.businessId
        ? Number(await db.scalar('SELECT COUNT(*) AS c FROM branches WHERE business_id = ? AND is_deleted = 0', [String(scope.businessId)]) || 0)
        : 0;
      throw new HttpError(
        branchCount > 1
          ? 'Name the branch you are asking about — you can see more than one.'
          : (branchCount === 0
            ? 'There is no branch to report on yet. This is what a deployment looks like before the first business is created.'
            : 'Name the branch you are asking about.'),
        { status: 400, code: branchCount === 0 ? 'BUSINESS_REQUIRED' : 'BRANCH_REQUIRED' });
    }
    if (!atLeast(user.role, 'OWNER') && String(user.branch_id || '') !== String(branchId)) {
      throw new HttpError('That is another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }
    const branch = await db.first('SELECT * FROM branches WHERE id = ? AND is_deleted = 0', [String(branchId)]);
    if (!branch) throw new HttpError('That branch does not exist.', { status: 404, code: 'BRANCH_NOT_FOUND' });
    if (scope && scope.businessId && String(branch.business_id) !== String(scope.businessId) && !atLeast(user.role, 'ADMIN')) {
      throw new HttpError('That branch belongs to another business.', { status: 403, code: 'CROSS_BUSINESS' });
    }

    const rows = await assignments.coverageAt(db, {
      businessId: branch.business_id ? String(branch.business_id) : null, branchId: String(branch.id), at,
    });
    ctx.json({
      ok: true,
      branch: { id: branch.id, name: branch.name, code: branch.code },
      at,
      data: rows,
      count: rows.length,
      note: 'Read from the assignment history, which records every move and every creation. A person who has since been deactivated is still listed if their branch on that day was this one — being deactivated is not the same as never having worked here.',
    });
  });
}

/**
 * MAY THIS CALLER DECIDE THIS TRANSFER? The receiving branch decides; the owner of the
 * business may decide any of theirs; the platform administrator may decide any.
 */
async function assertMayDecide(db, ctx, row) {
  const user = ctx.get('user');
  // ANSWERED BEFORE THE ROLE CHECK, deliberately: it is true at every role, and it is
  // the answer the person needs. "Only a manager or above" would leave a cashier who
  // tried to accept their own transfer believing they merely lacked the rank.
  if (String(row.user_id) === String(user.id)) {
    throw new HttpError('You cannot decide your own transfer. That is asking yourself for permission.', { status: 403, code: 'SELF_DECISION' });
  }
  if (!atLeast(user.role, 'MANAGER')) {
    throw new HttpError('Only a manager or above can answer a transfer.', { status: 403, code: 'ROLE_REQUIRED' });
  }
  if (atLeast(user.role, 'ADMIN')) return true;
  const toBranch = await db.first('SELECT * FROM branches WHERE id = ?', [String(row.to_branch_id)]);
  if (!toBranch) throw new HttpError('That branch no longer exists, so nobody can accept this transfer.', { status: 409, code: 'BRANCH_NOT_FOUND' });
  if (ctx.get('scope') && ctx.get('scope').businessId && String(toBranch.business_id) !== String(ctx.get('scope').businessId)) {
    throw new HttpError('That transfer is for another business.', { status: 403, code: 'CROSS_BUSINESS' });
  }
  if (atLeast(user.role, 'OWNER')) return true;
  if (String(user.branch_id || '') !== String(row.to_branch_id)) {
    throw new HttpError('That transfer is to another branch. The manager receiving somebody is the one who decides.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
  }
  return true;
}

module.exports = { mount, MIN_REASON };
