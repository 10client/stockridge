'use strict';
// =====================================================================
// server/services/saleIssues.js — A FLAGGED SALE, FIXED AND CLEARED
// =====================================================================
// The sale stays. A void stays visible. What this service adds is the
// missing step: name the problem, let the role that owns it correct the
// data that is safe to correct, and record who cleared it.
//
// Money, stock and the journal are not edited here. A balance is cleared
// by taking the payment. Change owed is cleared by paying the claim. A
// missing journal is cleared by an owner quoting the entry that covers
// it, or by voiding and re-ringing. A closed till is not rewritten.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { scopeFilter, branchFilter, strField } = require('../lib/respond');
const { atLeast } = require('../../domain/roles');
const { newId } = require('../../domain/crypto');

const WINDOW = '-120 days';
const SCAN_CAP = 60;
const REF_METHODS = ['POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD', 'CHEQUE'];

const RULES = {
  LATE_TILL: {
    summary: 'Posted after the till was counted',
    how: 'The money is in the books. It is not in that closed till. A manager records what happened and clears the flag. The closed count is not rewritten, and the sale is not deleted.',
    clear: 'MANAGER',
  },
  NO_TILL: {
    summary: 'No till was open',
    how: 'A manager notes which drawer the money went into, then clears the flag. Opening a till now does not move this sale into it.',
    clear: 'MANAGER',
  },
  OPEN_BALANCE: {
    summary: 'Customer still owes money',
    how: 'Take the payment on the receipt. This clears itself when nothing is owed. It cannot be cleared while money is still outstanding.',
    clear: null,
  },
  CHANGE_UNCOLLECTED: {
    summary: 'Change is still owed to the customer',
    how: 'Pay the claim from Change owed. This clears itself when the claim is no longer outstanding.',
    clear: null,
  },
  MISSING_REFERENCE: {
    summary: 'A card or transfer payment has no reference',
    how: 'Enter the terminal or transfer reference. The flag clears when every such payment has one. A manager can clear it without a reference if the terminal did not give one, and must say so.',
    clear: 'STAFF',
  },
  MISSING_JOURNAL: {
    summary: 'This sale has no journal entry',
    how: 'An owner voids and re-rings it, or posts a manual journal and quotes that entry number when clearing the flag. The sale is not deleted.',
    clear: 'OWNER',
    needsReference: true,
  },
  SYNC_CONFLICT: {
    summary: 'This sale disagreed with the server',
    how: 'The server kept its copy. A manager decides that is the one that stands, then clears the flag. Clearing also marks the conflict reviewed.',
    clear: 'MANAGER',
  },
  QUARANTINED_REPLAY: {
    summary: 'An offline sale was held back after a data cleanup',
    how: 'It was not applied, because replaying it would put deleted records back. Re-enter it by hand if it is still true, then a manager clears the flag.',
    clear: 'MANAGER',
  },
};

function missingTable(err) {
  return /no such table/i.test(String(err && err.message || err));
}

function scopeSql(scope, alias) {
  const f = scopeFilter(scope, { alias });
  return f.sql ? { sql: f.sql, params: f.params } : { sql: '', params: [] };
}

async function branchOnly(db, ctx, alias) {
  const scope = ctx.get('scope') || {};
  const parts = [];
  const params = [];
  if (!scope.allBranches && scope.branchIds && scope.branchIds.size) {
    const ids = [...scope.branchIds];
    parts.push(`${alias}.branch_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (!scope.allBusinesses && scope.businessIds && scope.businessIds.size) {
    const ids = [...scope.businessIds];
    parts.push(`${alias}.branch_id IN (SELECT id FROM branches WHERE business_id IN (${ids.map(() => '?').join(',')}))`);
    params.push(...ids);
  }
  if (scope.focusBusinessId) {
    parts.push(`${alias}.branch_id IN (SELECT id FROM branches WHERE business_id = ? AND is_deleted = 0)`);
    params.push(String(scope.focusBusinessId));
  }
  const bf = await branchFilter(db, ctx, { alias, nullMeansEveryBranch: false });
  if (bf.sql) { parts.push(bf.sql); params.push(...bf.params); }
  return { sql: parts.join(' AND '), params };
}

async function narrowed(db, ctx, alias) {
  const scope = ctx.get('scope');
  const parts = [];
  const params = [];
  const scoped = scopeSql(scope, alias);
  if (scoped.sql) { parts.push(scoped.sql); params.push(...scoped.params); }
  const bf = await branchFilter(db, ctx, { alias });
  if (bf.sql) { parts.push(bf.sql); params.push(...bf.params); }
  return { sql: parts.length ? parts.join(' AND ') : '', params };
}

function ruleOf(code) {
  return RULES[code] || null;
}

function referenceMissing(payments) {
  return (payments || []).some((p) => REF_METHODS.includes(String(p.method || ''))
    && !String(p.reference || '').trim()
    && p.status !== 'FAILED'
    && p.status !== 'REVERSED');
}

function canCorrect(user, issue) {
  if (!issue || !issue.sale_id || issue.status !== 'OPEN') return false;
  if (atLeast(user.role, 'MANAGER')) return true;
  return String(user.role || '').toUpperCase() === 'STAFF' && String(issue.salesperson_id || '') === String(user.id);
}

function canClear(user, issue, payments) {
  const rule = ruleOf(issue && issue.code);
  if (!rule || !rule.clear || !issue || issue.status !== 'OPEN') return false;
  if (!atLeast(user.role, rule.clear)) return false;
  if (issue.code === 'MISSING_REFERENCE' && referenceMissing(payments) && !atLeast(user.role, 'MANAGER')) return false;
  return true;
}

function present(row, user, payments) {
  const rule = ruleOf(row.code) || {};
  const pays = payments || row.payments || [];
  return {
    id: row.id,
    code: row.code,
    summary: row.summary,
    detail: row.detail || null,
    status: row.status,
    detectedAt: row.detected_at,
    clearedAt: row.cleared_at || null,
    clearNote: row.clear_note || null,
    saleId: row.sale_id || null,
    receiptNo: row.receipt_no || null,
    soldAt: row.sold_at || null,
    customerName: row.customer_name || null,
    customerPhone: row.customer_phone || null,
    balanceDue: row.balance_due != null ? Number(row.balance_due) : null,
    saleStatus: row.sale_status || null,
    salespersonId: row.salesperson_id || null,
    branchId: row.branch_id,
    clientId: row.client_id || null,
    sourceId: row.source_id || null,
    how: rule.how || 'Fix the data this flag names, then clear it.',
    clearRole: rule.clear || null,
    needsReference: Boolean(rule.needsReference),
    canClear: user ? canClear(user, row, pays) : false,
    canCorrect: user ? canCorrect(user, row) : false,
    payments: pays.map((p) => ({
      id: p.id,
      method: p.method,
      amount: Number(p.amount) || 0,
      reference: p.reference || '',
      status: p.status,
      needsReference: REF_METHODS.includes(String(p.method || '')) && p.status !== 'FAILED' && p.status !== 'REVERSED',
    })),
  };
}

async function openIssue(db, row) {
  if (!row.businessId || !row.branchId || !row.code) return null;
  const id = newId();
  try {
    await db.run(`INSERT INTO sale_issues (
        id, business_id, branch_id, sale_id, client_id, source_id, code, summary, detail, status, detected_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'OPEN', datetime('now'))`, [
      id,
      String(row.businessId),
      String(row.branchId),
      row.saleId || null,
      row.clientId || null,
      row.sourceId || null,
      row.code,
      row.summary,
      row.detail || null,
    ]);
    return id;
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return null;
    throw e;
  }
}

async function noteCompletedSale(db, result) {
  if (!result || !result.saleId || !result.businessId || !result.branchId) return;
  if (result.latePosting) {
    await openIssue(db, {
      businessId: result.businessId,
      branchId: result.branchId,
      saleId: result.saleId,
      code: 'LATE_TILL',
      summary: RULES.LATE_TILL.summary,
      detail: 'Recorded after the till for that time was already counted.',
    });
  }
  if (!result.tillSessionId) {
    await openIssue(db, {
      businessId: result.businessId,
      branchId: result.branchId,
      saleId: result.saleId,
      code: 'NO_TILL',
      summary: RULES.NO_TILL.summary,
      detail: 'The sale was recorded with no till open.',
    });
  }
  if (Number(result.balanceDue) > 0.009) {
    await openIssue(db, {
      businessId: result.businessId,
      branchId: result.branchId,
      saleId: result.saleId,
      code: 'OPEN_BALANCE',
      summary: RULES.OPEN_BALANCE.summary,
      detail: 'A balance was left on this receipt.',
    });
  }
  if (Number(result.changeOwed) > 0.009) {
    await openIssue(db, {
      businessId: result.businessId,
      branchId: result.branchId,
      saleId: result.saleId,
      code: 'CHANGE_UNCOLLECTED',
      summary: RULES.CHANGE_UNCOLLECTED.summary,
      detail: 'Change was held for the customer to collect.',
    });
  }
}

async function noteQuarantine(db, { conflictId, clientId, branchId, kind, occurredAt }) {
  if (!branchId || !conflictId) return;
  const salesKind = kind === 'SALE' || kind === 'SALE_VOID' || kind === 'SALE_PAYMENT';
  if (!salesKind) return;
  const branch = await db.first('SELECT business_id FROM branches WHERE id = ?', [String(branchId)]);
  if (!branch || !branch.business_id) return;
  await openIssue(db, {
    businessId: branch.business_id,
    branchId,
    clientId: clientId || null,
    sourceId: conflictId,
    code: 'QUARANTINED_REPLAY',
    summary: RULES.QUARANTINED_REPLAY.summary,
    detail: `A queued ${kind} from ${occurredAt || 'before the cleanup'} was stored and not applied.`,
  });
}

async function noteConflict(db, { conflictId, table, rowId, branchId }) {
  if (table !== 'sales' || !branchId || !conflictId) return;
  const branch = await db.first('SELECT business_id FROM branches WHERE id = ?', [String(branchId)]);
  if (!branch || !branch.business_id) return;
  await openIssue(db, {
    businessId: branch.business_id,
    branchId,
    saleId: rowId || null,
    sourceId: conflictId,
    code: 'SYNC_CONFLICT',
    summary: RULES.SYNC_CONFLICT.summary,
    detail: 'The device and the server disagreed. The server copy was kept.',
  });
}

async function raiseFromSales(db, ctx, code, sql, params, mapRow) {
  const extra = await narrowed(db, ctx, 's');
  const where = [sql];
  const bound = [...params];
  if (extra.sql) { where.push(extra.sql); bound.push(...extra.params); }
  const rows = await db.all(`SELECT s.id, s.business_id, s.branch_id, s.receipt_no, s.notes, s.balance_due
      FROM sales s
      WHERE ${where.join(' AND ')}
      ORDER BY s.sold_at DESC LIMIT ${SCAN_CAP}`, bound);
  for (const row of rows) {
    const mapped = mapRow(row);
    await openIssue(db, {
      businessId: row.business_id,
      branchId: row.branch_id,
      saleId: row.id,
      code,
      summary: RULES[code].summary,
      detail: mapped.detail,
    });
  }
}

async function scan(db, ctx) {
  const live = `s.is_deleted = 0 AND s.status <> 'VOIDED' AND s.sold_at >= datetime('now', '${WINDOW}')`;
  const notYet = (code) => `NOT EXISTS (SELECT 1 FROM sale_issues si WHERE si.sale_id = s.id AND si.code = '${code}')`;

  await raiseFromSales(db, ctx, 'LATE_TILL',
    `${live} AND s.notes LIKE '%Late posting:%' AND ${notYet('LATE_TILL')}`, [],
    (row) => ({ detail: String(row.notes || '').slice(0, 400) }));

  await raiseFromSales(db, ctx, 'NO_TILL',
    `${live} AND s.till_session_id IS NULL AND ${notYet('NO_TILL')}`, [],
    () => ({ detail: 'The sale was recorded with no till open.' }));

  await raiseFromSales(db, ctx, 'OPEN_BALANCE',
    `${live} AND s.balance_due > 0.009 AND ${notYet('OPEN_BALANCE')}`, [],
    (row) => ({ detail: `Balance still owed: ${Number(row.balance_due).toFixed(2)}.` }));

  await raiseFromSales(db, ctx, 'CHANGE_UNCOLLECTED',
    `${live} AND ${notYet('CHANGE_UNCOLLECTED')} AND EXISTS (
      SELECT 1 FROM change_owed co WHERE co.sale_id = s.id AND co.status = 'OUTSTANDING' AND co.is_deleted = 0
    )`, [],
    () => ({ detail: 'A change-owed claim on this receipt is still outstanding.' }));

  const refList = REF_METHODS.map(() => '?').join(',');
  await raiseFromSales(db, ctx, 'MISSING_REFERENCE',
    `${live} AND ${notYet('MISSING_REFERENCE')} AND EXISTS (
      SELECT 1 FROM sale_payments sp
      WHERE sp.sale_id = s.id AND sp.is_deleted = 0 AND sp.status NOT IN ('FAILED','REVERSED')
        AND sp.method IN (${refList}) AND (sp.reference IS NULL OR trim(sp.reference) = '')
    )`, REF_METHODS,
    () => ({ detail: 'A card, transfer or cheque payment has no reference.' }));

  await raiseFromSales(db, ctx, 'MISSING_JOURNAL',
    `${live} AND s.total > 0 AND ${notYet('MISSING_JOURNAL')} AND NOT EXISTS (
      SELECT 1 FROM gl_journal_entries je
      WHERE je.source_type = 'SALE' AND je.source_id = s.id AND je.is_deleted = 0
    )`, [],
    () => ({ detail: 'No journal entry is tied to this sale.' }));

  const conflictScope = await branchOnly(db, ctx, 'c');
  const conflictWhere = [`c.reviewed_at IS NULL`, `c.branch_id IS NOT NULL`];
  const conflictParams = [];
  if (conflictScope.sql) { conflictWhere.push(conflictScope.sql); conflictParams.push(...conflictScope.params); }
  const conflicts = await db.all(`SELECT c.id, c.table_name, c.row_id, c.branch_id, c.losing_version_json, b.business_id
      FROM sync_conflicts c
      JOIN branches b ON b.id = c.branch_id
      WHERE ${conflictWhere.join(' AND ')}
      ORDER BY c.detected_at DESC LIMIT ${SCAN_CAP}`, conflictParams);
  for (const row of conflicts) {
    const losing = String(row.losing_version_json || '');
    const isSale = row.table_name === 'sales'
      || (row.table_name === 'offline_queue' && /"type":"SALE/.test(losing));
    if (!isSale) continue;
    const quarantined = row.table_name === 'offline_queue';
    await openIssue(db, {
      businessId: row.business_id,
      branchId: row.branch_id,
      saleId: quarantined ? null : row.row_id,
      clientId: quarantined ? row.row_id : null,
      sourceId: row.id,
      code: quarantined ? 'QUARANTINED_REPLAY' : 'SYNC_CONFLICT',
      summary: quarantined ? RULES.QUARANTINED_REPLAY.summary : RULES.SYNC_CONFLICT.summary,
      detail: quarantined
        ? 'Held back after a data cleanup. It was not applied.'
        : 'The server copy was kept. The device copy is stored with the conflict.',
    });
  }

  await autoClear(db, ctx);
}

async function autoClear(db, ctx) {
  const extra = await narrowed(db, ctx, 'i');
  const where = [`i.status = 'OPEN'`];
  const params = [];
  if (extra.sql) { where.push(extra.sql); params.push(...extra.params); }
  const open = await db.all(`SELECT i.id, i.code, i.sale_id, i.source_id, s.status AS sale_status, s.balance_due
      FROM sale_issues i
      LEFT JOIN sales s ON s.id = i.sale_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.detected_at DESC LIMIT 200`, params);
  for (const issue of open) {
    const reason = await resolvedReason(db, issue);
    if (!reason) continue;
    await db.run(`UPDATE sale_issues
        SET status = 'CLEARED', cleared_at = datetime('now'), clear_note = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'OPEN'`, [reason, issue.id]);
  }
}

async function resolvedReason(db, issue) {
  if (issue.sale_status === 'VOIDED' && issue.code !== 'SYNC_CONFLICT' && issue.code !== 'QUARANTINED_REPLAY') {
    return 'Cleared because the sale was voided. The receipt stays in the sales book.';
  }
  if (issue.code === 'OPEN_BALANCE' && Number(issue.balance_due) <= 0.009) {
    return 'Cleared because nothing is owed on this receipt.';
  }
  if (issue.code === 'CHANGE_UNCOLLECTED' && issue.sale_id) {
    const owed = await db.first(`SELECT id FROM change_owed
        WHERE sale_id = ? AND status = 'OUTSTANDING' AND is_deleted = 0 LIMIT 1`, [issue.sale_id]);
    if (!owed) return 'Cleared because the change is no longer outstanding.';
  }
  if (issue.code === 'MISSING_REFERENCE' && issue.sale_id) {
    const pays = await db.all(`SELECT method, reference, status FROM sale_payments
        WHERE sale_id = ? AND is_deleted = 0`, [issue.sale_id]);
    if (!referenceMissing(pays)) return 'Cleared because every card or transfer payment now has a reference.';
  }
  if (issue.code === 'MISSING_JOURNAL' && issue.sale_id) {
    const journal = await db.first(`SELECT id FROM gl_journal_entries
        WHERE source_type = 'SALE' AND source_id = ? AND is_deleted = 0 LIMIT 1`, [issue.sale_id]);
    if (journal) return 'Cleared because a journal entry is now tied to this sale.';
  }
  if ((issue.code === 'SYNC_CONFLICT' || issue.code === 'QUARANTINED_REPLAY') && issue.source_id) {
    const conflict = await db.first('SELECT reviewed_at FROM sync_conflicts WHERE id = ?', [issue.source_id]);
    if (conflict && conflict.reviewed_at) return 'Cleared because the conflict was reviewed.';
  }
  return null;
}

async function attachPayments(db, rows) {
  const ids = [...new Set(rows.map((r) => r.sale_id).filter(Boolean))];
  if (!ids.length) {
    for (const row of rows) row.payments = [];
    return rows;
  }
  const payments = await db.all(`SELECT id, sale_id, method, amount, reference, status
      FROM sale_payments WHERE is_deleted = 0 AND sale_id IN (${ids.map(() => '?').join(',')})`, ids);
  const bySale = new Map();
  for (const p of payments) {
    if (!bySale.has(p.sale_id)) bySale.set(p.sale_id, []);
    bySale.get(p.sale_id).push(p);
  }
  for (const row of rows) row.payments = bySale.get(row.sale_id) || [];
  return rows;
}

async function list(db, ctx, { status = 'OPEN', saleId = null, scanFirst = true } = {}) {
  if (scanFirst) await scan(db, ctx);
  const extra = await narrowed(db, ctx, 'i');
  const where = ['1 = 1'];
  const params = [];
  if (status && status !== 'ALL') { where.push('i.status = ?'); params.push(String(status).toUpperCase()); }
  if (saleId) { where.push('i.sale_id = ?'); params.push(String(saleId)); }
  if (extra.sql) { where.push(extra.sql); params.push(...extra.params); }
  const rows = await db.all(`SELECT i.*, s.receipt_no, s.sold_at, s.customer_name, s.customer_phone,
          s.balance_due, s.status AS sale_status, s.salesperson_id
      FROM sale_issues i
      LEFT JOIN sales s ON s.id = i.sale_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE i.status WHEN 'OPEN' THEN 0 ELSE 1 END, i.detected_at DESC
      LIMIT 80`, params);
  await attachPayments(db, rows);
  const user = ctx.get('user');
  return rows.map((row) => present(row, user, row.payments));
}

async function loadIssue(db, ctx, id) {
  const extra = await narrowed(db, ctx, 'i');
  const where = ['i.id = ?'];
  const params = [String(id)];
  if (extra.sql) { where.push(extra.sql); params.push(...extra.params); }
  const row = await db.first(`SELECT i.*, s.receipt_no, s.sold_at, s.customer_name, s.customer_phone,
          s.notes AS sale_notes, s.balance_due, s.status AS sale_status, s.salesperson_id, s.business_id AS sale_business_id
      FROM sale_issues i
      LEFT JOIN sales s ON s.id = i.sale_id
      WHERE ${where.join(' AND ')}`, params);
  if (!row) throw new HttpError('That flagged sale is not in the branches you can see.', { status: 404, code: 'NOT_FOUND' });
  const payments = row.sale_id
    ? await db.all('SELECT id, sale_id, method, amount, reference, status FROM sale_payments WHERE sale_id = ? AND is_deleted = 0', [row.sale_id])
    : [];
  row.payments = payments;
  return row;
}

async function correct(db, ctx, id, body) {
  const issue = await loadIssue(db, ctx, id);
  const user = ctx.get('user');
  if (issue.status !== 'OPEN') throw new HttpError('This flag is already cleared.', { status: 409, code: 'ALREADY_CLEARED' });
  if (!issue.sale_id) throw new HttpError('This one never became a sale. Re-enter it by hand, then clear the flag.', { status: 409, code: 'NOT_A_SALE' });
  if (!canCorrect(user, issue)) {
    throw new HttpError('You can correct a receipt you rang. A manager corrects anybody else\'s.', { status: 403, code: 'FORBIDDEN' });
  }

  const after = {};
  if (body.customer_name != null) {
    const name = strField(body.customer_name, { field: 'Customer name', maxLength: 120 });
    if (name && name.length < 2) throw new HttpError('The customer name needs at least 2 characters.', { status: 400, code: 'INVALID_NAME' });
    if (name) {
      await db.run(`UPDATE sales SET customer_name = ?, updated_at = datetime('now') WHERE id = ?`, [name, issue.sale_id]);
      after.customer_name = name;
    }
  }
  if (body.customer_phone != null) {
    const phone = strField(body.customer_phone, { field: 'Phone', maxLength: 20 }) || null;
    await db.run(`UPDATE sales SET customer_phone = ?, updated_at = datetime('now') WHERE id = ?`, [phone, issue.sale_id]);
    after.customer_phone = phone;
  }
  if (body.note) {
    const note = strField(body.note, { field: 'Note', maxLength: 300 });
    if (note) {
      const existing = String(issue.sale_notes || '');
      const next = existing ? `${existing}\nCorrection: ${note}` : `Correction: ${note}`;
      await db.run(`UPDATE sales SET notes = ?, updated_at = datetime('now') WHERE id = ?`, [next.slice(0, 2000), issue.sale_id]);
      after.note = note;
    }
  }
  const paymentEdits = Array.isArray(body.payments) ? body.payments : [];
  for (const edit of paymentEdits) {
    if (!edit || !edit.id) continue;
    const reference = strField(edit.reference, { field: 'Reference', maxLength: 80 });
    if (!reference) continue;
    const owned = (issue.payments || []).find((p) => String(p.id) === String(edit.id));
    if (!owned) throw new HttpError('That payment is not on this receipt.', { status: 404, code: 'PAYMENT_NOT_ON_SALE' });
    await db.run(`UPDATE sale_payments SET reference = ?, updated_at = datetime('now') WHERE id = ? AND sale_id = ?`,
      [reference, owned.id, issue.sale_id]);
    after.reference = reference;
  }
  if (!Object.keys(after).length) throw new HttpError('Nothing to correct.', { status: 400, code: 'NOTHING_TO_CORRECT' });

  await db.run(`UPDATE sale_issues SET corrected_at = datetime('now'), corrected_by = ?, correction = ?, updated_at = datetime('now') WHERE id = ?`,
    [String(user.id), JSON.stringify(after).slice(0, 1000), issue.id]);
  await recordFromCtx(ctx, {
    action: 'SALE_ISSUE_CORRECTED', entityType: 'SALE', entityId: issue.sale_id,
    branchId: issue.branch_id, businessId: issue.business_id,
    after: { issueId: issue.id, code: issue.code, ...after },
  });

  const pays = await db.all('SELECT method, reference, status FROM sale_payments WHERE sale_id = ? AND is_deleted = 0', [issue.sale_id]);
  if (issue.code === 'MISSING_REFERENCE' && !referenceMissing(pays)) {
    await markCleared(db, ctx, issue, user, 'Reference recorded.');
  }
  return present(await loadIssue(db, ctx, id), user);
}

async function assertClearable(db, user, issue, body) {
  const rule = ruleOf(issue.code);
  if (!rule || !rule.clear) {
    throw new HttpError(rule ? rule.how : 'This flag clears itself once the sale is fixed.', { status: 409, code: 'NOT_CLEARABLE' });
  }
  if (!atLeast(user.role, rule.clear)) {
    throw new HttpError(`A ${String(rule.clear).toLowerCase()} has to clear this.`, { status: 403, code: 'FORBIDDEN' });
  }
  if (issue.code === 'OPEN_BALANCE' && Number(issue.balance_due) > 0.009) {
    throw new HttpError('Take the payment first. This flag clears itself when nothing is owed.', { status: 409, code: 'STILL_OWED' });
  }
  if (issue.code === 'CHANGE_UNCOLLECTED') {
    const owed = issue.sale_id
      ? await db.first(`SELECT id FROM change_owed WHERE sale_id = ? AND status = 'OUTSTANDING' AND is_deleted = 0 LIMIT 1`, [issue.sale_id])
      : null;
    if (owed) throw new HttpError('Pay the claim first. This flag clears itself when the change is collected.', { status: 409, code: 'CHANGE_STILL_OWED' });
  }
  if (issue.code === 'MISSING_REFERENCE' && referenceMissing(issue.payments) && !atLeast(user.role, 'MANAGER')) {
    throw new HttpError('Enter the reference first. A manager can clear it without one, and has to say why.', { status: 409, code: 'REFERENCE_MISSING' });
  }
  if (issue.code === 'MISSING_JOURNAL') {
    const reference = strField(body.reference, { field: 'Journal entry', maxLength: 40, required: true });
    const journal = await db.first(`SELECT id, entry_no FROM gl_journal_entries
        WHERE business_id = ? AND is_deleted = 0 AND (entry_no = ? OR id = ?) LIMIT 1`,
      [issue.business_id, reference, reference]);
    if (!journal) throw new HttpError('That journal entry is not in this business. Quote the entry that covers this sale, or void and re-ring it.', { status: 400, code: 'JOURNAL_NOT_FOUND' });
    return reference;
  }
  return null;
}

async function markCleared(db, ctx, issue, user, note, reference) {
  await db.run(`UPDATE sale_issues
      SET status = 'CLEARED', cleared_at = datetime('now'), cleared_by = ?, clear_note = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'OPEN'`, [user ? String(user.id) : null, note, issue.id]);
  if ((issue.code === 'SYNC_CONFLICT' || issue.code === 'QUARANTINED_REPLAY') && issue.source_id && user) {
    await db.run(`UPDATE sync_conflicts SET reviewed_by = ?, reviewed_at = datetime('now')
        WHERE id = ? AND reviewed_at IS NULL`, [String(user.id), issue.source_id]);
  }
  if (ctx && user) {
    await recordFromCtx(ctx, {
      action: 'SALE_ISSUE_CLEARED', entityType: 'SALE', entityId: issue.sale_id || issue.client_id || issue.id,
      branchId: issue.branch_id, businessId: issue.business_id,
      after: { issueId: issue.id, code: issue.code, note, reference: reference || null },
    });
  }
}

async function clear(db, ctx, id, body) {
  const issue = await loadIssue(db, ctx, id);
  const user = ctx.get('user');
  if (issue.status !== 'OPEN') throw new HttpError('This flag is already cleared.', { status: 409, code: 'ALREADY_CLEARED' });
  const note = strField(body.note, { field: 'Note', maxLength: 500, required: true });
  if (!note || note.length < 8) throw new HttpError('Say what you checked, in at least a few words.', { status: 400, code: 'NOTE_REQUIRED' });
  const reference = await assertClearable(db, user, issue, body || {});
  const fullNote = reference ? `${note} Journal: ${reference}` : note;
  await markCleared(db, ctx, issue, user, fullNote, reference);
  return present(await loadIssue(db, ctx, id), user);
}

async function clearMatching(db, ctx, body) {
  const code = strField(body.code, { field: 'Problem', maxLength: 40, required: true });
  if (!RULES[code]) throw new HttpError('That is not a sales problem this screen clears.', { status: 400, code: 'UNKNOWN_ISSUE' });
  const note = strField(body.note, { field: 'Note', maxLength: 500, required: true });
  if (!note || note.length < 8) throw new HttpError('Say what you checked, in at least a few words.', { status: 400, code: 'NOTE_REQUIRED' });
  const user = ctx.get('user');
  const extra = await narrowed(db, ctx, 'i');
  const where = [`i.status = 'OPEN'`, `i.code = ?`];
  const params = [code];
  if (extra.sql) { where.push(extra.sql); params.push(...extra.params); }
  const rows = await db.all(`SELECT i.*, s.receipt_no, s.balance_due, s.status AS sale_status, s.salesperson_id
      FROM sale_issues i
      LEFT JOIN sales s ON s.id = i.sale_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.detected_at DESC LIMIT 80`, params);
  let cleared = 0;
  for (const issue of rows) {
    issue.payments = issue.sale_id
      ? await db.all('SELECT method, reference, status FROM sale_payments WHERE sale_id = ? AND is_deleted = 0', [issue.sale_id])
      : [];
    if (!canClear(user, issue, issue.payments)) continue;
    if (issue.code === 'MISSING_JOURNAL') continue;
    await markCleared(db, ctx, issue, user, note);
    cleared += 1;
  }
  if (!cleared) throw new HttpError('Nothing of that kind is waiting for you to clear.', { status: 409, code: 'NOTHING_TO_CLEAR' });
  return { cleared };
}

module.exports = {
  RULES, REF_METHODS, missingTable,
  noteCompletedSale, noteQuarantine, noteConflict,
  scan, list, correct, clear, clearMatching,
};
