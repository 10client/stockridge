'use strict';
// Hire and lease book. A row here is a promise that goods are out, not a
// sale. Returning them, charging damage, and handing the deposit back all
// happen here. Buying the goods is still a sale — this route only says the
// agreement may be bought, and the till writes the receipt.

const { HttpError } = require('../lib/http');
const { newId } = require('../../domain/crypto');
const { round2 } = require('../../domain/money');
const { watToday } = require('../../domain/time');
const { atLeast } = require('../../domain/roles');
const trade = require('../../domain/trade');
const glService = require('../services/glService');
const { scopeFilter, numField, strField, resolveBusiness } = require('../lib/respond');
const { modulesOf } = require('../../domain/modules');

function mount(app, base = '/api') {
  app.get(`${base}/agreements`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const filter = scopeFilter(scope, { alias: 'a' });
    const business = await resolveBusiness(db, ctx, null, { required: false });
    if (business) {
      let overrides = null;
      if (business.profile_overrides_json) {
        try { overrides = JSON.parse(business.profile_overrides_json); } catch (e) { overrides = null; }
      }
      if (!modulesOf(business.profile_code, overrides).hireBook) {
        throw new HttpError('The hire book belongs to a business that hires or leases. This one does not.', { status: 403, code: 'MODULE_OFF' });
      }
    }
    const status = strField(ctx.req.queryParam('status'), { field: 'Status', maxLength: 20 });
    const where = ['a.is_deleted = 0'];
    const params = [];
    if (filter.sql) { where.push(filter.sql); params.push(...filter.params); }
    if (status) { where.push('a.status = ?'); params.push(status.toUpperCase()); }
    const rows = await db.all(`
      SELECT a.*, c.name AS customer_record_name
        FROM asset_agreements a
        LEFT JOIN customers c ON c.id = a.customer_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.ends_on ASC, a.created_at DESC
       LIMIT 200`, params);
    const today = watToday();
    ctx.json({
      ok: true,
      data: rows.map((row) => ({
        ...row,
        overdue: row.status === 'OUT' && String(row.ends_on) < today,
        customer_name: row.customer_name || row.customer_record_name || null,
      })),
    });
  });

  app.get(`${base}/agreements/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const agreement = await loadAgreement(db, id, ctx.get('scope'));
    const lines = await db.all('SELECT * FROM asset_agreement_lines WHERE agreement_id = ? AND is_deleted = 0', [id]);
    const schedule = await db.all('SELECT * FROM asset_agreement_schedule WHERE agreement_id = ? AND is_deleted = 0 ORDER BY period_no', [id]);
    ctx.json({ ok: true, agreement, lines, schedule, overdue: agreement.status === 'OUT' && agreement.ends_on < watToday() });
  });

  app.post(`${base}/agreements/:id/return`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const agreement = await loadAgreement(db, id, ctx.get('scope'));
    if (agreement.status !== 'OUT') {
      throw new HttpError('Those goods are not out. A returned or cancelled agreement cannot be returned again.', { status: 409, code: 'NOT_OUT' });
    }
    const body = await ctx.req.json().catch(() => ({}));
    const condition = String(body.condition || 'GOOD').toUpperCase();
    if (!['GOOD', 'DAMAGED', 'MISSING'].includes(condition)) {
      throw new HttpError('Say whether the goods came back good, damaged, or missing.', { status: 400, code: 'BAD_CONDITION' });
    }
    const today = watToday();
    const late = trade.lateDays(agreement.ends_on, today);
    const damage = round2(numField(body.damage_charge ?? body.damageCharge, { field: 'Damage charge', min: 0 }) || 0);
    const lateCharge = round2(numField(body.late_charge ?? body.lateCharge, { field: 'Late charge', min: 0 }) || 0);
    if ((damage > 0 || condition !== 'GOOD') && !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('A damage or missing charge needs a manager. The deposit is the customer’s money until somebody senior says otherwise.', { status: 403, code: 'DAMAGE_NEEDS_MANAGER' });
    }
    const held = round2(Number(agreement.deposit_held) || 0);
    const charge = round2(damage + lateCharge);
    const applied = round2(Math.min(held, charge));
    const refund = round2(Math.max(0, held - charge));
    const owed = round2(Math.max(0, charge - held));
    const accountIds = await glService.loadAccountCodes(db, agreement.business_id);
    const business = { id: agreement.business_id };
    const branch = { id: agreement.branch_id };
    const serials = await linesWithSerials(db, id);

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE asset_agreements SET
          status = 'RETURNED', returned_at = datetime('now'), return_condition = ?,
          damage_charge = ?, late_days = ?, late_charge = ?, amount_owed = ?,
          deposit_held = 0, updated_at = datetime('now')
        WHERE id = ? AND status = 'OUT'`, [
        condition, damage, late, lateCharge, owed, id,
      ]);
      if (applied > 0) {
        for (const s of glService.postHeldDeposit({
          business, branch, agreementId: id, amount: applied, user, accountIds, toIncome: true,
          description: `Deposit applied to ${condition === 'MISSING' ? 'missing goods' : 'damage or a late return'}.`,
        })) tx.queue(s.sql, s.params);
      }
      if (refund > 0) {
        for (const s of glService.postHeldDeposit({
          business, branch, agreementId: id, amount: refund, method: agreement.deposit_method || 'CASH',
          user, accountIds, releasing: true,
          description: 'Deposit returned with the goods.',
        })) tx.queue(s.sql, s.params);
      }
      for (const line of serials) {
        if (!line.serial_no) continue;
        tx.queue(`UPDATE serial_numbers SET status = 'IN_STOCK', sale_id = NULL, updated_at = datetime('now')
                  WHERE serial_no = ? AND is_deleted = 0 AND status = 'RESERVED'`, [line.serial_no]);
      }
    });

    ctx.json({
      ok: true,
      id,
      condition,
      lateDays: late,
      damage,
      lateCharge,
      depositApplied: applied,
      depositRefunded: refund,
      stillOwed: owed,
      message: owed > 0
        ? `Goods recorded back. ₦${owed.toLocaleString('en-NG')} is still owed above the deposit.`
        : refund > 0
          ? `Goods recorded back. ₦${refund.toLocaleString('en-NG')} of the deposit goes back to the customer.`
          : 'Goods recorded back. The deposit covered the charges.',
    });
  });
}

async function loadAgreement(db, id, scope) {
  const filter = scopeFilter(scope || { allBranches: true, allBusinesses: true }, { alias: 'a' });
  const row = await db.first(
    `SELECT a.* FROM asset_agreements a WHERE a.id = ? AND a.is_deleted = 0 ${filter.sql ? `AND ${filter.sql}` : ''}`,
    [id, ...filter.params],
  );
  if (!row) throw new HttpError('That agreement does not exist.', { status: 404, code: 'AGREEMENT_NOT_FOUND' });
  return row;
}

async function linesWithSerials(db, id) {
  return db.all('SELECT serial_no FROM asset_agreement_lines WHERE agreement_id = ? AND is_deleted = 0 AND serial_no IS NOT NULL', [id]);
}

module.exports = { mount };
