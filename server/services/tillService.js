// =====================================================================
// StockRidge — TILL SESSIONS & BRANCH SAFE
// =====================================================================
// Cash control. The single most emotionally charged screen in the product,
// because it is where a cashier is told they are short.
//
// THE MODEL: a till session is opened with a float, accumulates every
// payment by METHOD (not just by total), and is closed against a physical
// count. The variance is then either explained or investigated.
//
// WHY SPLIT BY METHOD AND NOT JUST TOTAL: a till that is "correct" on total
// can still be badly wrong — ₦40,000 missing from the drawer and ₦40,000 of
// phantom POS settlements balances to zero and hides both. Expected cash,
// expected POS, expected transfer, expected USSD, expected mobile money,
// expected cheque and expected credit are separate columns, and the variance
// is computed on the CASH column against the CASH count, because that is the
// only column anyone can physically verify.
//
// CHANGE OWED IS A LIABILITY, NOT A ROUNDING. When the drawer has no small
// notes and the customer leaves ₦300 outstanding, that ₦300 is real money
// owed to a real person. It is recorded with a claim code they can quote at
// ANY branch, it stays in the drawer (so it is not deducted from expected
// cash), and it sits in the balance sheet as "change owed to customers"
// until it is paid or forfeited. Silently writing it off is how a till
// reconciles to a number that is not the money in the box.
//
// THE SAFE IS SEPARATE FROM THE TILL. A drawer that holds a full day's
// takings in a shop with no bank run is a robbery waiting to happen, so cash
// is swept to the safe during the shift and the sweep is recorded. The safe
// has its own ledger, its own balance and its own audit — and its own
// narrow staff allowance, because a cashier sent to buy stock the drawer
// cannot cover must not have to find a manager first.
//
// ONE OPEN TILL PER BRANCH+TILL_CODE, enforced by a partial unique index.
// Two open tills on one drawer means neither closing reconciles to anything.
// =====================================================================

const { newId, watNowIso, watDate } = require('../../shared/ids');
const { round2, roundCash, toKobo, sumMoney } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const { PREFIXES, nextReference, claimCode, normaliseClaimCode, formatClaimCode } = require('../lib/references');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { staffAllowance, getUnitSettings, assertSubscribed } = require('../lib/planLimits');
const { capabilitiesOf } = require('../lib/capabilities');

const TILL_STATUSES = ['OPEN', 'CLOSED', 'SUSPENDED', 'RECONCILED'];
const SAFE_ENTRY_TYPES = ['OPENING_BALANCE', 'DEPOSIT_FROM_TILL', 'WITHDRAWAL_TO_TILL', 'BANK_DEPOSIT', 'PURCHASE_PAYMENT', 'EXPENSE_PAYMENT', 'TILL_FLOAT_ISSUE', 'ADJUSTMENT', 'COUNT_CORRECTION'];

// ---------------------------------------------------------------------
// TILL SESSIONS
// ---------------------------------------------------------------------
async function openTill(db, ctx, { branchId = null, tillCode = 'TILL-1', openingFloat = 0, notes = null, deviceId = null }) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'open a till' });

  const bid = branchId || ctx.user.branch_id;
  if (!bid) throw new HttpError(400, 'Choose which branch this till is for.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, bid);
  const branch = await db.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0 AND is_active = 1').bind(bid).first();
  if (!branch) throw new HttpError(404, 'That branch was not found or is not active.', 'BRANCH_NOT_FOUND');

  const code = String(tillCode || 'TILL-1').trim().toUpperCase().slice(0, 20) || 'TILL-1';
  const existing = await db.prepare(`
    SELECT session_no, opened_at FROM till_sessions
    WHERE branch_id = ? AND till_code = ? AND status = 'OPEN' AND is_deleted = 0
  `).bind(bid, code).first();
  if (existing) {
    throw new HttpError(409,
      `Till ${code} is already open at ${branch.name} (session ${existing.session_no}, opened ${existing.opened_at}). Close it before opening another — two open tills on one drawer means neither closing reconciles to anything.`,
      'TILL_ALREADY_OPEN');
  }

  const float = round2(Number(openingFloat) || 0);
  if (float < 0) throw new HttpError(400, 'The opening float cannot be negative.', 'TILL_FLOAT_INVALID');

  const ts = watNowIso();
  const id = newId();
  const sessionNo = (await nextReference(db, { businessUnitId, prefix: PREFIXES.TILL_SESSION, branchCode: branch.code || code, scope: 'YEAR' })).reference;

  const statements = [
    db.prepare(`
      INSERT INTO till_sessions (
        id, business_unit_id, branch_id, till_code, session_no, status, opened_by, opened_at,
        device_id, opening_float, expected_cash, expected_pos, expected_transfer, expected_ussd,
        expected_mobile_money, expected_cheque, expected_other, expected_credit, expected_total,
        notes, created_at, updated_at
      ) VALUES (?,?,?,?,?, 'OPEN', ?,?,?, ?,0,0,0,0, 0,0,0,0,0, ?,?,?)
    `).bind(id, businessUnitId, bid, code, sessionNo, ctx.user.id, ts, deviceId || ctx.deviceId || null, float, notes || null, ts, ts),
  ];

  // The float physically comes FROM the safe (or is issued fresh), so the
  // safe ledger must show it leaving — otherwise the safe balance in the
  // books is money that is actually sitting in a drawer.
  if (float > 0) {
    const safeBalance = await safeBalance(db, { branchId: bid });
    if (safeBalance < float) {
      throw new HttpError(409,
        `The branch safe holds ₦${safeBalance.toLocaleString('en-NG')}, which is not enough for a ₦${float.toLocaleString('en-NG')} till float. `
        + 'Deposit cash into the safe first, or open with a smaller float and record the rest as an adjustment.',
        'SAFE_INSUFFICIENT_FOR_FLOAT');
    }
    statements.push(db.prepare(`
      INSERT INTO branch_safe_ledger (
        id, business_unit_id, branch_id, entry_type, amount, balance_after, source_type, source_id,
        reference, reason, approved_by, performed_by, till_session_id, occurred_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      newId(), businessUnitId, bid, 'TILL_FLOAT_ISSUE', -float, round2(safeBalance - float),
      'TILL_SESSION', id, sessionNo, 'Opening float issued to till', ctx.user.id, ctx.user.id, id, ts, ts, ts
    ));
  }

  await db.batch(statements);
  await writeAudit(db, {
    businessUnitId, branchId: bid, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'TILL_OPENED', entityType: 'TILL_SESSION', entityId: id, amount: float,
    after: { session_no: sessionNo, till_code: code, opening_float: float },
    ipAddress: ctx.ipAddress, deviceId: deviceId || ctx.deviceId,
  });

  return { ok: true, id, session_no: sessionNo, till_code: code, branch_id: bid, branch_name: branch.name, status: 'OPEN', opening_float: float, opened_at: ts };
}

async function closeTill(db, ctx, { tillSessionId = null, branchId = null, tillCode = 'TILL-1', countedCash = null, countedPos = null, countedTransfer = null, notes = null, varianceReason = null, bankedAmount = 0 }) {
  const businessUnitId = ctx.businessUnitId;
  const session = tillSessionId
    ? await db.prepare('SELECT * FROM till_sessions WHERE id = ? AND is_deleted = 0').bind(tillSessionId).first()
    : await db.prepare(`SELECT * FROM till_sessions WHERE branch_id = ? AND till_code = ? AND status = 'OPEN' AND is_deleted = 0`)
      .bind(branchId || ctx.user.branch_id, String(tillCode).toUpperCase()).first();
  if (!session) throw new HttpError(404, 'No open till was found to close.', 'TILL_NOT_FOUND');
  if (session.status !== 'OPEN') throw new HttpError(409, `That till session is ${session.status}, not OPEN.`, 'TILL_NOT_OPEN');
  assertBranchAccess(ctx.user, session.branch_id);

  if (countedCash == null) {
    throw new HttpError(400,
      'Enter the physical cash count. A till closed without a count has no variance to investigate, which is the same as a till nobody checked.',
      'TILL_COUNT_REQUIRED');
  }
  const counted = round2(Number(countedCash));
  if (!Number.isFinite(counted) || counted < 0) throw new HttpError(400, 'The counted cash must be zero or more.', 'TILL_COUNT_INVALID');

  // Expected CASH in the drawer = opening float + cash taken - change given.
  // The float is included because it is physically in the box and must be
  // counted back; excluding it is the most common cause of a "surplus" that
  // is really just the float.
  const expectedCash = round2(Number(session.opening_float) + Number(session.expected_cash));
  const variance = round2(counted - expectedCash);

  // Cash that leaves the drawer into the safe. Sweeping the day's takings is
  // the single most effective robbery control a cash business has.
  const toSafe = round2(Math.max(0, counted - Number(session.opening_float)));
  const banked = round2(Number(bankedAmount) || 0);
  if (banked > counted) {
    throw new HttpError(400, `You cannot bank ₦${banked.toLocaleString('en-NG')} from a drawer holding ₦${counted.toLocaleString('en-NG')}.`, 'TILL_BANK_EXCEEDS_COUNT');
  }

  const ts = watNowIso();
  const statements = [];

  // A variance beyond tolerance needs either a reason or a manager. Not
  // because the system doubts the cashier, but because an unexplained
  // variance is the only evidence that will exist later.
  const TOLERANCE = 50;   // ₦50 — below the smallest note in circulation
  let varianceApprovedBy = null;
  if (Math.abs(variance) > TOLERANCE) {
    const role = String(ctx.user.role).toUpperCase();
    if (role === 'STAFF' && (!varianceReason || String(varianceReason).trim().length < 5)) {
      throw new HttpError(403,
        `The drawer is ${variance < 0 ? 'short' : 'over'} by ₦${Math.abs(variance).toLocaleString('en-NG')}. A variance above ₦${TOLERANCE} needs a written reason and a manager to acknowledge it. `
        + 'The count is saved — recount if you think it is wrong.',
        'TILL_VARIANCE_NEEDS_APPROVAL');
    }
    if (role !== 'STAFF') varianceApprovedBy = ctx.user.id;
  }

  statements.push(db.prepare(`
    UPDATE till_sessions SET
      status = 'CLOSED', closed_by = ?, closed_at = ?,
      counted_cash = ?, counted_total = ?, variance = ?, variance_reason = ?, variance_approved_by = ?,
      safe_deposited = ?, banked_amount = ?, notes = COALESCE(?, notes), updated_at = ?
    WHERE id = ?
  `).bind(
    ctx.user.id, ts, counted, counted, variance,
    varianceReason ? String(varianceReason).slice(0, 500) : null, varianceApprovedBy,
    toSafe, banked, notes || null, ts, session.id
  ));

  const safeBalance = await safeBalance(db, { branchId: session.branch_id });
  if (toSafe > 0) {
    statements.push(db.prepare(`
      INSERT INTO branch_safe_ledger (
        id, business_unit_id, branch_id, entry_type, amount, balance_after, source_type, source_id,
        reference, reason, approved_by, performed_by, till_session_id, occurred_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      newId(), businessUnitId, session.branch_id, 'DEPOSIT_FROM_TILL', toSafe, round2(safeBalance + toSafe),
      'TILL_SESSION', session.id, session.session_no, 'Till closing sweep', ctx.user.id, ctx.user.id, session.id, ts, ts, ts
    ));
  }
  if (banked > 0) {
    statements.push(db.prepare(`
      INSERT INTO branch_safe_ledger (
        id, business_unit_id, branch_id, entry_type, amount, balance_after, source_type, source_id,
        reference, reason, approved_by, performed_by, till_session_id, occurred_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      newId(), businessUnitId, session.branch_id, 'BANK_DEPOSIT', -banked, round2(safeBalance + toSafe - banked),
      'TILL_SESSION', session.id, session.session_no, 'Banked from safe', ctx.user.id, ctx.user.id, session.id, ts, ts, ts
    ));
  }

  await db.batch(statements);

  // GL: the drawer's cash becomes safe cash becomes bank. Posting this is
  // what makes a bank reconciliation possible at all.
  if (capabilitiesOf(ctx.businessUnit || await getUnitSettings(db, businessUnitId)).general_ledger) {
    try {
      const glService = require('./glService');
      if (toSafe > 0) {
        await glService.postCashMovement(db, {
          businessUnitId, branchId: session.branch_id, from: 'TILL', to: 'SAFE', amount: toSafe,
          reference: session.session_no, description: `Till close sweep ${session.session_no}`, userId: ctx.user.id,
        });
      }
      if (banked > 0) {
        await glService.postCashMovement(db, {
          businessUnitId, branchId: session.branch_id, from: 'SAFE', to: 'BANK', amount: banked,
          reference: session.session_no, description: `Banked from safe ${session.session_no}`, userId: ctx.user.id,
        });
      }
    } catch (e) { console.error('[tillService] GL posting on close failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId, branchId: session.branch_id, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'TILL_CLOSED', entityType: 'TILL_SESSION', entityId: session.id, amount: counted,
    reason: varianceReason || null,
    before: { expected_cash: expectedCash }, after: { counted_cash: counted, variance, to_safe: toSafe, banked },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  const outstandingChange = await db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM change_owed
    WHERE branch_id = ? AND status = 'OUTSTANDING' AND is_deleted = 0
  `).bind(session.branch_id).first();

  return {
    ok: true, id: session.id, session_no: session.session_no, status: 'CLOSED', closed_at: ts,
    opening_float: round2(session.opening_float),
    expected: {
      cash: round2(session.expected_cash), pos: round2(session.expected_pos), transfer: round2(session.expected_transfer),
      ussd: round2(session.expected_ussd), mobile_money: round2(session.expected_mobile_money),
      cheque: round2(session.expected_cheque), credit: round2(session.expected_credit),
      other: round2(session.expected_other), total: round2(session.expected_total),
      cash_in_drawer_including_float: expectedCash,
    },
    counted_cash: counted,
    variance,
    variance_percent: expectedCash > 0 ? round2((variance / expectedCash) * 100) : 0,
    reconciled: toKobo(Math.abs(variance)) <= toKobo(TOLERANCE),
    deposited_to_safe: toSafe, banked,
    sale_count: session.sale_count, void_count: session.void_count, return_count: session.return_count,
    discount_total: round2(session.discount_total),
    change_owed_outstanding: { claims: outstandingChange.n, total: round2(outstandingChange.total) },
    advisory: Math.abs(variance) > TOLERANCE
      ? `The drawer was ${variance < 0 ? 'SHORT' : 'OVER'} by ₦${Math.abs(variance).toLocaleString('en-NG')} (${round2(Math.abs(variance) / Math.max(1, expectedCash) * 100)}%). `
        + (variance < 0
          ? 'Check voids and change given on this session first — those two account for most shortages.'
          : 'An over is usually change given that was not recorded, or a sale rung up for less than the cash received.')
      : null,
  };
}

async function getSession(db, sessionId) {
  const s = await db.prepare(`
    SELECT t.*, b.name AS branch_name, b.code AS branch_code,
           u.full_name AS opened_by_name, c.full_name AS closed_by_name
    FROM till_sessions t
    JOIN branches b ON b.id = t.branch_id
    LEFT JOIN users u ON u.id = t.opened_by
    LEFT JOIN users c ON c.id = t.closed_by
    WHERE t.id = ?
  `).bind(sessionId).first();
  if (!s) return null;
  const payments = await db.prepare(`
    SELECT sp.method, COUNT(*) AS count, COALESCE(SUM(sp.amount),0) AS total,
           COALESCE(SUM(sp.change_given),0) AS change_given
    FROM sale_payments sp WHERE sp.till_session_id = ? AND sp.is_deleted = 0
    GROUP BY sp.method ORDER BY total DESC
  `).bind(sessionId).all();
  const sales = await db.prepare(`
    SELECT id, receipt_no, total, status, occurred_at, sold_by, u.full_name AS sold_by_name
    FROM sales s LEFT JOIN users u ON u.id = s.sold_by
    WHERE s.till_session_id = ? AND s.is_deleted = 0 ORDER BY s.occurred_at DESC LIMIT 500
  `).bind(sessionId).all();
  return {
    ...s,
    payment_breakdown: payments.results.map((p) => ({ ...p, total: round2(p.total), change_given: round2(p.change_given) })),
    sales: sales.results,
  };
}

async function currentTill(db, { branchId }) {
  return db.prepare(`
    SELECT * FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0
    ORDER BY opened_at DESC LIMIT 1
  `).bind(branchId).first();
}

// ---------------------------------------------------------------------
// BRANCH SAFE
// ---------------------------------------------------------------------
async function safeBalance(db, { branchId }) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS balance FROM branch_safe_ledger
    WHERE branch_id = ? AND is_deleted = 0
  `).bind(branchId).first();
  return round2(Number((row && row.balance) || 0));
}

async function safeEntry(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const branchId = input.branch_id || ctx.user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch\u2019s safe this is.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, branchId);

  const type = String(input.entry_type || '').trim().toUpperCase();
  if (!SAFE_ENTRY_TYPES.includes(type)) {
    throw new HttpError(400, `Safe entry type must be one of: ${SAFE_ENTRY_TYPES.join(', ')}.`, 'SAFE_ENTRY_TYPE_INVALID');
  }
  let amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount === 0) {
    throw new HttpError(400, 'Enter an amount. Positive puts money in, negative takes it out.', 'SAFE_AMOUNT_INVALID');
  }
  // Direction is derived from the type where the type implies one, so a
  // WITHDRAWAL_TO_TILL cannot be posted as money arriving.
  const IN_TYPES = ['OPENING_BALANCE', 'DEPOSIT_FROM_TILL', 'COUNT_CORRECTION'];
  const OUT_TYPES = ['WITHDRAWAL_TO_TILL', 'BANK_DEPOSIT', 'PURCHASE_PAYMENT', 'EXPENSE_PAYMENT', 'TILL_FLOAT_ISSUE'];
  if (IN_TYPES.includes(type)) amount = Math.abs(amount);
  if (OUT_TYPES.includes(type)) amount = -Math.abs(amount);

  const balance = await safeBalance(db, { branchId });
  if (amount < 0 && Math.abs(amount) > balance) {
    throw new HttpError(409,
      `The safe holds ₦${balance.toLocaleString('en-NG')}, so ₦${Math.abs(amount).toLocaleString('en-NG')} cannot come out of it. `
      + 'If the recorded balance is wrong, post a COUNT_CORRECTION with a reason instead.',
      'SAFE_INSUFFICIENT_BALANCE');
  }

  // STAFF ALLOWANCE. See the header comment: a cashier sent to buy stock the
  // drawer cannot cover must not have to find a manager first, but a cashier
  // moving the whole reserve unsupervised is the classic shrinkage route.
  const allowance = await staffAllowance(db, businessUnitId, ctx.user);
  let approvedBy = null;
  if (String(ctx.user.role).toUpperCase() === 'STAFF') {
    if (!allowance.can_spend_from_safe) {
      throw new HttpError(403, 'Only a manager may move money from the safe in this business. The owner can grant cashiers a limited allowance under My Plan.', 'SAFE_STAFF_NOT_PERMITTED');
    }
    if (amount < 0 && Number.isFinite(allowance.safe_spend_max) && Math.abs(amount) > allowance.safe_spend_max) {
      throw new HttpError(403,
        `Your safe-spend limit is ₦${allowance.safe_spend_max.toLocaleString('en-NG')} per transaction and this is ₦${Math.abs(amount).toLocaleString('en-NG')}. A manager must make this payment.`,
        'SAFE_OVER_STAFF_LIMIT');
    }
  } else {
    approvedBy = ctx.user.id;
  }

  if (!input.reason || String(input.reason).trim().length < 4) {
    throw new HttpError(400, 'A safe movement needs a reason of at least 4 characters. It is the only record of why the reserve changed.', 'SAFE_REASON_REQUIRED');
  }

  const ts = watNowIso();
  const id = newId();
  await db.prepare(`
    INSERT INTO branch_safe_ledger (
      id, business_unit_id, branch_id, entry_type, amount, balance_after, source_type, source_id,
      reference, reason, approved_by, performed_by, till_session_id, occurred_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, businessUnitId, branchId, type, amount, round2(balance + amount),
    input.source_type || null, input.source_id || null, input.reference || null,
    String(input.reason).slice(0, 500), approvedBy, ctx.user.id, input.till_session_id || null, ts, ts, ts
  ).run();

  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'SAFE_MOVEMENT', entityType: 'SAFE_LEDGER', entityId: id, amount,
    reason: String(input.reason).slice(0, 500),
    before: { balance }, after: { balance: round2(balance + amount), entry_type: type },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id, entry_type: type, amount, balance_before: balance, balance_after: round2(balance + amount) };
}

async function safeLedger(db, { branchId, businessUnitId = null, from = null, to = null, limit = 100 }) {
  const where = ['is_deleted = 0'];
  const params = [];
  if (branchId) { where.push('branch_id = ?'); params.push(branchId); }
  if (businessUnitId) { where.push('business_unit_id = ?'); params.push(businessUnitId); }
  if (from) { where.push("date(occurred_at,'+1 hour') >= ?"); params.push(String(from).slice(0, 10)); }
  if (to) { where.push("date(occurred_at,'+1 hour') <= ?"); params.push(String(to).slice(0, 10)); }
  const rows = await db.prepare(`
    SELECT sl.*, u.full_name AS performed_by_name, a.full_name AS approved_by_name
    FROM branch_safe_ledger sl
    LEFT JOIN users u ON u.id = sl.performed_by
    LEFT JOIN users a ON a.id = sl.approved_by
    WHERE ${where.join(' AND ')}
    ORDER BY sl.occurred_at DESC LIMIT ?
  `).bind(...params, Math.min(500, Number(limit) || 100)).all();
  return rows.results;
}

// Safe count. A physical count of the reserve against the ledger balance.
// A safe nobody counts is a safe that can be quietly emptied over months,
// and the ledger will agree with itself the whole time.
async function countSafe(db, ctx, { branchId = null, countedAmount, note = null }) {
  const businessUnitId = ctx.businessUnitId;
  const bid = branchId || ctx.user.branch_id;
  if (!bid) throw new HttpError(400, 'Choose which branch\u2019s safe you counted.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, bid);
  const counted = round2(Number(countedAmount));
  if (!Number.isFinite(counted) || counted < 0) throw new HttpError(400, 'Enter the amount you counted.', 'SAFE_COUNT_INVALID');
  const ledger = await safeBalance(db, { branchId: bid });
  const variance = round2(counted - ledger);
  const ts = watNowIso();

  if (toKobo(Math.abs(variance)) > 0) {
    if (!note || String(note).trim().length < 4) {
      throw new HttpError(400,
        `The safe counted ₦${counted.toLocaleString('en-NG')} against a ledger balance of ₦${ledger.toLocaleString('en-NG')} — a difference of ₦${variance.toLocaleString('en-NG')}. `
        + 'A correction needs a written note explaining it.',
        'SAFE_COUNT_VARIANCE_NEEDS_NOTE');
    }
    if (String(ctx.user.role).toUpperCase() === 'STAFF') {
      throw new HttpError(403, 'Only a manager can post a safe count correction — a cashier who could adjust the reserve to match their own count would remove the control entirely.', 'SAFE_CORRECTION_FORBIDDEN');
    }
    await db.prepare(`
      INSERT INTO branch_safe_ledger (
        id, business_unit_id, branch_id, entry_type, amount, balance_after, source_type, reference,
        reason, approved_by, performed_by, occurred_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?, 'SAFE_COUNT','SAFE_COUNT',?,?,?,?,?,?)
    `).bind(newId(), businessUnitId, bid, 'COUNT_CORRECTION', variance, counted,
      `Safe count correction: counted ₦${counted.toLocaleString('en-NG')}, ledger ₦${ledger.toLocaleString('en-NG')}. ${String(note).slice(0, 300)}`,
      ctx.user.id, ctx.user.id, ts, ts, ts).run();
  }

  await writeAudit(db, {
    businessUnitId, branchId: bid, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'SAFE_COUNTED', entityType: 'SAFE_LEDGER', entityId: bid, amount: counted,
    reason: note || null, before: { ledger_balance: ledger }, after: { counted, variance },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, branch_id: bid, ledger_balance: ledger, counted, variance, reconciled: toKobo(Math.abs(variance)) === 0, counted_at: ts };
}

// ---------------------------------------------------------------------
// CHANGE OWED
// ---------------------------------------------------------------------
async function createChangeOwed(db, ctx, { branchId = null, saleId = null, amount, customerName = null, customerPhone = null, customerId = null, reason = 'NO_SMALL_CHANGE', note = null, expiresDays = 30 }) {
  const businessUnitId = ctx.businessUnitId;
  const bid = branchId || ctx.user.branch_id;
  if (!bid) throw new HttpError(400, 'Choose which branch owes this change.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, bid);
  const value = round2(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'The amount owed must be more than zero.', 'CHANGE_AMOUNT_INVALID');
  if (value > 5000) {
    throw new HttpError(400,
      `₦${value.toLocaleString('en-NG')} is too large to be missing change. If the customer overpaid by that much, correct the sale instead — a change-owed claim is for notes the drawer does not have.`,
      'CHANGE_AMOUNT_TOO_LARGE');
  }
  if (!customerName && !customerPhone && !customerId) {
    throw new HttpError(400,
      'Record a name or a phone number for the person owed. An anonymous claim cannot be paid to the right person and becomes a write-off.',
      'CHANGE_CUSTOMER_REQUIRED');
  }

  const ts = watNowIso();
  const id = newId();
  const code = claimCode({ prefix: 'CHG' });
  const expiry = new Date(Date.now() + (Number(expiresDays) || 30) * 86400000).toISOString().slice(0, 19).replace('T', ' ');

  await db.prepare(`
    INSERT INTO change_owed (
      id, business_unit_id, branch_id, sale_id, customer_id, customer_name, customer_phone,
      claim_code, amount, reason, status, expires_at, notes, created_by, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?, 'OUTSTANDING', ?,?,?,?,?)
  `).bind(id, businessUnitId, bid, saleId || null, customerId || null,
    customerName ? String(customerName).slice(0, 160) : null,
    customerPhone ? String(customerPhone).slice(0, 20) : null,
    code, value, String(reason).toUpperCase(), expiry, note ? String(note).slice(0, 500) : null,
    ctx.user.id, ts, ts).run();

  return { ok: true, id, claim_code: code, claim_code_spoken: formatClaimCode(code), amount: value, expires_at: expiry };
}

// Pay a claim at ANY branch. The whole point of a claim code is that the
// customer does not have to go back to the shop that shorted them — which
// matters when the branches are in different cities.
async function payChangeOwed(db, ctx, { claimCodeOrId, method = 'CASH', note = null }) {
  const businessUnitId = ctx.businessUnitId;
  let row = null;
  if (claimCodeOrId && /^[0-9a-f]{32}$/i.test(String(claimCodeOrId).replace(/-/g, ''))) {
    row = await db.prepare('SELECT * FROM change_owed WHERE id = ? AND is_deleted = 0').bind(claimCodeOrId).first();
  }
  if (!row) {
    const normalised = normaliseClaimCode(claimCodeOrId);
    if (!normalised) throw new HttpError(400, 'Enter the claim code from the receipt.', 'CHANGE_CLAIM_CODE_REQUIRED');
    row = await db.prepare(`
      SELECT * FROM change_owed WHERE business_unit_id = ? AND is_deleted = 0
        AND (upper(claim_code) = ? OR upper(replace(claim_code,'-','')) = ?)
      ORDER BY created_at DESC LIMIT 1
    `).bind(businessUnitId, normalised.joined, normalised.body).first();
  }
  if (!row) throw new HttpError(404, 'No outstanding claim was found with that code. Check the digits — 0 and O, 1 and I are often confused when read aloud.', 'CHANGE_CLAIM_NOT_FOUND');
  if (row.status !== 'OUTSTANDING') {
    throw new HttpError(409, `That claim was already ${row.status.toLowerCase()}${row.paid_at ? ` on ${row.paid_at}` : ''}.`, 'CHANGE_CLAIM_NOT_OUTSTANDING');
  }
  assertBranchAccess(ctx.user, ctx.user.branch_id || row.branch_id);

  const payingBranchId = ctx.user.branch_id || row.branch_id;
  const m = String(method).toUpperCase();
  if (!['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'USSD'].includes(m)) {
    throw new HttpError(400, 'Change is paid out in cash or by transfer.', 'CHANGE_PAYMENT_METHOD_INVALID');
  }
  // Paying from a branch other than the one that owes it is normal and must
  // be allowed, but the safe ledger has to record it at the paying branch or
  // that branch's safe count will not agree.
  const balance = await safeBalance(db, { branchId: payingBranchId });
  const amount = round2(Number(row.amount));
  if (m === 'CASH' && balance < amount) {
    throw new HttpError(409,
      `This branch's safe holds ₦${balance.toLocaleString('en-NG')}, not enough to pay ₦${amount.toLocaleString('en-NG')} in cash. Pay by transfer, or move cash into the safe first.`,
      'SAFE_INSUFFICIENT_FOR_CLAIM');
  }

  const ts = watNowIso();
  const statements = [
    db.prepare(`
      UPDATE change_owed SET status = 'PAID', paid_at = ?, paid_branch_id = ?, paid_by = ?, payment_method = ?, notes = COALESCE(notes || ' | ','') || ?, updated_at = ?
      WHERE id = ? AND status = 'OUTSTANDING'
    `).bind(ts, payingBranchId, ctx.user.id, m, `Paid: ${String(note || '').slice(0, 200)}`, ts, row.id),
  ];
  if (m === 'CASH') {
    statements.push(db.prepare(`
      INSERT INTO branch_safe_ledger (
        id, business_unit_id, branch_id, entry_type, amount, balance_after, source_type, source_id,
        reference, reason, approved_by, performed_by, occurred_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?, 'CHANGE_OWED', ?,?,?,?, ?,?,?,?)
    `).bind(newId(), businessUnitId, payingBranchId, 'WITHDRAWAL_TO_TILL', -amount, round2(balance - amount),
      row.id, row.claim_code, `Change owed paid to ${row.customer_name || 'customer'}`,
      ctx.user.id, ctx.user.id, ts, ts, ts));
  }
  await db.batch(statements);

  await writeAudit(db, {
    businessUnitId, branchId: payingBranchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'CHANGE_OWED_PAID', entityType: 'CHANGE_OWED', entityId: row.id, amount,
    before: { status: 'OUTSTANDING', owing_branch: row.branch_id }, after: { status: 'PAID', method: m },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id: row.id, claim_code: row.claim_code, amount, method: m, paid_at: ts, paid_at_branch: payingBranchId };
}

async function outstandingChange(db, { businessUnitId, branchId = null, search = null, limit = 100 }) {
  const where = ["status = 'OUTSTANDING'", 'is_deleted = 0', 'business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('branch_id = ?'); params.push(branchId); }
  if (search) {
    const like = `%${String(search).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(customer_name LIKE ? ESCAPE '\\' OR customer_phone LIKE ? ESCAPE '\\' OR upper(claim_code) LIKE ? ESCAPE '\\')`);
    params.push(like, like, like.toUpperCase());
  }
  const rows = await db.prepare(`
    SELECT co.*, b.name AS branch_name, u.full_name AS created_by_name,
           CAST(julianday(co.expires_at) - julianday('now','+1 hour') AS INTEGER) AS days_to_expiry
    FROM change_owed co
    JOIN branches b ON b.id = co.branch_id
    LEFT JOIN users u ON u.id = co.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY co.created_at ASC LIMIT ?
  `).bind(...params, Math.min(500, Number(limit) || 100)).all();
  return {
    results: rows.results,
    total: round2(rows.results.reduce((a, r) => a + Number(r.amount), 0)),
    count: rows.results.length,
  };
}

module.exports = {
  TILL_STATUSES, SAFE_ENTRY_TYPES,
  openTill, closeTill, getSession, currentTill,
  safeBalance, safeEntry, safeLedger, countSafe,
  createChangeOwed, payChangeOwed, outstandingChange,
};
'use strict';
