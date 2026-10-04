// =====================================================================
// StockRidge — MONEY ROUTES: expenses, creditors, tax, general ledger
// =====================================================================

const { createRouter, HttpError } = require('../lib/http');
const { withIdempotency } = require('../lib/idempotency');
const { watNowIso, watDate } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { assertRole, assertBranchAccess, resolveScopedBranchId } = require('../lib/roles');
const expenseService = require('../services/expenseService');
const taxService = require('../services/taxService');
const glService = require('../services/glService');
const whtLib = require('../lib/wht');
const { writeAudit } = require('../lib/audit');
const { newId } = require('../../shared/ids');

function expenseRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    const db = getDb();
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    return c.json(await expenseService.list(db, {
      businessUnitId: c.var.businessUnitId, branchId: scoped,
      categoryId: c.req.query('category_id') || null, status: c.req.query('status') || null,
      from: c.req.query('from') || null, to: c.req.query('to') || null,
      search: c.req.query('q') || null, requestedBy: c.req.query('requested_by') || null,
      limit: c.req.query('limit'), offset: c.req.query('offset'),
    }));
  });

  app.get('/summary', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the expense summary' });
    const db = getDb();
    return c.json(await expenseService.summaryReport(db, {
      businessUnitId: c.var.businessUnitId, branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      startDate: c.req.query('from') || watDate(), endDate: c.req.query('to') || watDate(),
    }));
  });

  app.get('/categories', async (c) => {
    const db = getDb();
    return c.json({ results: await expenseService.listCategories(db, { businessUnitId: c.var.businessUnitId }) });
  });

  app.post('/categories', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'create an expense category' });
    const db = getDb();
    const body = await c.req.json();
    const V = require('../../shared/validation');
    const code = V.required(String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'), { field: 'Category code', max: 40 });
    if (code && code.error) throw new HttpError(400, code.error, 'VALIDATION_FAILED');
    const label = V.required(body.label, { field: 'Category name', max: 120 });
    if (label && label.error) throw new HttpError(400, label.error, 'VALIDATION_FAILED');
    const clash = await db.prepare('SELECT id FROM expense_categories WHERE business_unit_id = ? AND code = ? AND is_deleted = 0').bind(c.var.businessUnitId, code).first();
    if (clash) throw new HttpError(409, `A category with code ${code} already exists.`, 'CATEGORY_CODE_EXISTS');
    let glAccountId = null;
    if (body.gl_account_code) {
      const acc = await db.prepare('SELECT id FROM gl_accounts WHERE business_unit_id = ? AND code = ? AND is_deleted = 0').bind(c.var.businessUnitId, String(body.gl_account_code)).first();
      if (!acc) throw new HttpError(404, `Account ${body.gl_account_code} is not in the chart of accounts.`, 'GL_ACCOUNT_NOT_FOUND');
      glAccountId = acc.id;
    }
    const ts = watNowIso();
    const id = newId();
    await db.prepare(`
      INSERT INTO expense_categories (id, business_unit_id, code, label, gl_account_id, is_operational, requires_receipt, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?, 1, ?, 1,?,?)
    `).bind(id, c.var.businessUnitId, code, label, glAccountId, body.requires_receipt ? 1 : 0, ts, ts).run();
    return c.json({ ok: true, id, code, label }, 201);
  });

  app.post('/', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await expenseService.create(db, c.serviceCtx, body) }));
  });

  app.post('/:id/approve', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await expenseService.decide(db, c.serviceCtx, { expenseId: c.req.param('id'), decision: body.decision || 'APPROVED', reason: body.reason }));
  });

  return app;
}

// ---------------------------------------------------------------------
// CREDITORS
// ---------------------------------------------------------------------
function creditorRoutes(getDb) {
  const app = createRouter();

  app.get('/', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view what the business owes suppliers' });
    const db = getDb();
    const rows = await db.prepare(`
      SELECT cb.*, s.payment_terms_days, s.supplier_type, s.phone
      FROM v_creditor_balances cb JOIN suppliers s ON s.id = cb.supplier_id
      WHERE cb.business_unit_id = ? ORDER BY cb.balance DESC
    `).bind(c.var.businessUnitId).all();
    const results = rows.results.map((r) => ({ ...r, balance: round2(r.balance) }));
    const total = round2(results.reduce((a, r) => a + r.balance, 0));
    return c.json({
      results, total, suppliers: results.length,
      // Terms-based ageing: what is due now vs still within terms. Paying early
      // destroys working capital; paying late destroys supplier relationships,
      // and only the split tells you which risk you are carrying.
      due_now: round2(results.filter((r) => Number(r.payment_terms_days) === 0).reduce((a, r) => a + r.balance, 0)),
      on_terms: round2(results.filter((r) => Number(r.payment_terms_days) > 0).reduce((a, r) => a + r.balance, 0)),
    });
  });

  app.get('/:supplierId/ledger', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'read a supplier ledger' });
    const db = getDb();
    const rows = await db.prepare(`
      SELECT cl.*, b.name AS branch_name, u.full_name AS created_by_name
      FROM creditor_ledger cl LEFT JOIN branches b ON b.id = cl.branch_id LEFT JOIN users u ON u.id = cl.created_by
      WHERE cl.supplier_id = ? AND cl.is_deleted = 0
        AND cl.entry_date BETWEEN ? AND ?
      ORDER BY cl.entry_date ASC, cl.created_at ASC LIMIT 2000
    `).bind(c.req.param('supplierId'), String(c.req.query('from') || '1970-01-01').slice(0, 10),
      String(c.req.query('to') || watDate()).slice(0, 10)).all();
    return c.json({ results: rows.results.map((r) => ({ ...r, amount: round2(r.amount), balance_after: round2(r.balance_after), wht_amount: round2(r.wht_amount) })) });
  });

  return app;
}

// ---------------------------------------------------------------------
// TAX
// ---------------------------------------------------------------------
function taxRoutes(getDb) {
  const app = createRouter();

  app.get('/vat-summary', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the VAT position' });
    const db = getDb();
    return c.json(await taxService.vatSummary(db, {
      businessUnitId: c.var.businessUnitId, branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      startDate: c.req.query('from'), endDate: c.req.query('to'),
    }));
  });

  app.get('/vat-by-tax-code', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the VAT breakdown' });
    const db = getDb();
    return c.json({ results: await taxService.vatByTaxCode(db, {
      businessUnitId: c.var.businessUnitId, branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      startDate: c.req.query('from'), endDate: c.req.query('to'),
    }) });
  });

  app.get('/wht-summary', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view the withholding tax position' });
    const db = getDb();
    return c.json(await taxService.whtSummary(db, {
      businessUnitId: c.var.businessUnitId, branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      startDate: c.req.query('from'), endDate: c.req.query('to'), direction: c.req.query('direction') || null,
    }));
  });

  app.get('/wht-by-counterparty', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'view withholding tax by counterparty' });
    const db = getDb();
    return c.json({ results: await taxService.whtByCounterparty(db, {
      businessUnitId: c.var.businessUnitId, startDate: c.req.query('from'), endDate: c.req.query('to'),
      direction: c.req.query('direction') || 'PAYABLE',
    }) });
  });

  // Credit notes a customer owes us. A receivable WHT nobody chases is a
  // permanent loss: the customer deducted it, FIRS will not accept our gross
  // figure without the note, and the note has to be requested from the
  // customer's accounts department — which takes weeks if it happens at all.
  app.get('/wht-outstanding-credit-notes', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'view outstanding WHT credit notes' });
    const db = getDb();
    return c.json(await taxService.outstandingCreditNotes(db, {
      businessUnitId: c.var.businessUnitId, olderThanDays: c.req.query('older_than_days') || 30,
    }));
  });

  app.post('/wht', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return withIdempotency(db, c, async () => ({ status: 201, body: await taxService.recordEntry(db, c.serviceCtx, body) }));
  });

  app.post('/wht/:id/remitted', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'mark withholding tax remitted' });
    const db = getDb();
    const body = await c.req.json();
    return c.json(await taxService.markRemitted(db, c.serviceCtx, {
      entryId: c.req.param('id'), remittanceRef: body.remittance_ref, remittedAt: body.remitted_at,
    }));
  });

  app.post('/wht/:id/credit-note', async (c) => {
    const db = getDb();
    const body = await c.req.json();
    return c.json(await taxService.recordCreditNote(db, c.serviceCtx, { entryId: c.req.param('id'), creditNoteNo: body.credit_note_no }));
  });

  app.get('/preview-wht', async (c) => {
    const db = getDb();
    const gross = Number(c.req.query('gross'));
    if (!Number.isFinite(gross) || gross <= 0) throw new HttpError(400, 'Send the gross invoice amount as ?gross=.', 'WHT_GROSS_INVALID');
    const rateCode = c.req.query('rate_code') || null;
    const counterpartyType = c.req.query('counterparty_type') || null;
    const direction = String(c.req.query('direction') || 'PAYABLE').toUpperCase();
    const row = rateCode ? await whtLib.findRate(db, rateCode, { businessUnitId: c.var.businessUnitId }) : null;
    if (rateCode && !row) throw new HttpError(404, `Unknown or inactive WHT rate "${rateCode}".`, 'WHT_UNKNOWN_RATE');
    const resolved = row ? whtLib.rateForCounterparty(row, counterpartyType) : null;
    const ratePercent = c.req.query('rate_percent') != null ? Number(c.req.query('rate_percent')) : (resolved ? resolved.rate_percent : null);
    const computed = ratePercent != null ? whtLib.computeWht({ grossAmount: gross, ratePercent }) : null;
    const tin = c.req.query('tin') || null;
    const month = whtLib.filingPeriod(c.req.query('date') || watDate());
    const mtd = counterpartyType ? await whtLib.monthToDateTotal(db, {
      businessUnitId: c.var.businessUnitId, direction, counterpartyName: c.req.query('counterparty') || '', tin, month,
    }) : { total: 0 };
    return c.json({
      gross: computed ? computed.gross : round2(gross),
      rate_code: rateCode, rate_percent: ratePercent, counterparty_band: resolved ? resolved.band : null,
      wht: computed ? computed.wht : null, net: computed ? computed.net : null,
      regulation_ref: row ? row.regulation_ref : null,
      month_to_date_with_counterparty: mtd.total,
      // ADVISORY ONLY, never blocking — see lib/wht.js for why: whether this
      // business is itself a "small company" depends on its own turnover, which
      // the system does not authoritatively know, and the ₦2m test is
      // per-supplier-per-calendar-month rather than per-transaction.
      exemption_hint: whtLib.exemptionHint({ grossAmount: gross, counterpartyTin: tin, counterpartyType, monthlyTotalForCounterparty: mtd.total }),
    });
  });

  // The monthly filing pack. Assembling a return from six screens is how a
  // filing gets done late; one call produces everything for one period.
  app.get('/filing-pack', async (c) => {
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'generate a tax filing pack' });
    const db = getDb();
    return c.json(await taxService.monthlyFilingPack(db, {
      businessUnitId: c.var.businessUnitId, month: c.req.query('month') || null,
    }));
  });

  return app;
}

// ---------------------------------------------------------------------
// GENERAL LEDGER
// ---------------------------------------------------------------------
function glRoutes(getDb) {
  const app = createRouter();

  const requireGl = (c) => {
    const s = c.var.businessUnit;
    if (s.gl_module_enabled === 0) {
      throw new HttpError(403, 'The general ledger is not enabled for this business. Your account administrator can turn it on.', 'GL_DISABLED');
    }
    assertRole(c.var.user, ['ADMIN', 'OWNER', 'MANAGER'], { action: 'read the books' });
  };

  app.get('/accounts', async (c) => {
    requireGl(c);
    const db = getDb();
    await glService.ensureChart(db, c.var.businessUnitId);
    const rows = await db.prepare(`
      SELECT a.*,
        COALESCE((SELECT SUM(l.debit) - SUM(l.credit) FROM gl_journal_lines l
                  JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.status = 'POSTED' AND e.is_deleted = 0
                  WHERE l.account_id = a.id AND l.is_deleted = 0),0) AS raw_balance
      FROM gl_accounts a WHERE a.business_unit_id = ? AND a.is_deleted = 0
      ORDER BY a.code
    `).bind(c.var.businessUnitId).all();
    return c.json({ results: rows.results.map((r) => ({ ...r, balance: round2(r.raw_balance) })) });
  });

  app.get('/entries', async (c) => {
    requireGl(c);
    const db = getDb();
    const where = ['e.is_deleted = 0', 'e.business_unit_id = ?'];
    const params = [c.var.businessUnitId];
    const scoped = resolveScopedBranchId(c.var.user, c.req.query('branch_id'));
    if (scoped) { where.push('(e.branch_id = ? OR e.branch_id IS NULL)'); params.push(scoped); }
    if (c.req.query('from')) { where.push('e.entry_date >= ?'); params.push(String(c.req.query('from')).slice(0, 10)); }
    if (c.req.query('to')) { where.push('e.entry_date <= ?'); params.push(String(c.req.query('to')).slice(0, 10)); }
    if (c.req.query('source_type')) { where.push('e.source_type = ?'); params.push(String(c.req.query('source_type')).toUpperCase()); }
    if (c.req.query('status')) { where.push('e.status = ?'); params.push(String(c.req.query('status')).toUpperCase()); }
    if (c.req.query('q')) {
      const like = `%${String(c.req.query('q')).trim().replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
      where.push(`(e.entry_no LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\' OR e.reference LIKE ? ESCAPE '\\')`);
      params.push(like, like, like);
    }
    const rows = await db.prepare(`
      SELECT e.*, b.name AS branch_name, u.full_name AS posted_by_name,
             (SELECT COUNT(*) FROM gl_journal_lines l WHERE l.journal_entry_id = e.id AND l.is_deleted = 0) AS line_count
      FROM gl_journal_entries e
      LEFT JOIN branches b ON b.id = e.branch_id
      LEFT JOIN users u ON u.id = e.posted_by
      WHERE ${where.join(' AND ')}
      ORDER BY e.entry_date DESC, e.posted_at DESC LIMIT ? OFFSET ?
    `).bind(...params, Math.min(500, Number(c.req.query('limit')) || 100), Number(c.req.query('offset')) || 0).all();
    return c.json({ results: rows.results.map((r) => ({ ...r, total_debit: round2(r.total_debit), total_credit: round2(r.total_credit) })) });
  });

  app.get('/entries/:id', async (c) => {
    requireGl(c);
    const db = getDb();
    const e = await db.prepare('SELECT * FROM gl_journal_entries WHERE id = ? AND is_deleted = 0').bind(c.req.param('id')).first();
    if (!e) throw new HttpError(404, 'That journal entry was not found.', 'GL_ENTRY_NOT_FOUND');
    if (e.business_unit_id !== c.var.businessUnitId) throw new HttpError(403, 'That entry belongs to another business.', 'GL_WRONG_BUSINESS');
    const lines = await db.prepare(`
      SELECT l.*, a.code AS account_code, a.name AS account_name, a.account_type, pc.label AS category_label
      FROM gl_journal_lines l
      JOIN gl_accounts a ON a.id = l.account_id
      LEFT JOIN product_categories pc ON pc.id = l.category_id
      WHERE l.journal_entry_id = ? AND l.is_deleted = 0 ORDER BY a.code
    `).bind(e.id).all();
    return c.json({ ...e, lines: lines.results.map((l) => ({ ...l, debit: round2(l.debit), credit: round2(l.credit) })) });
  });

  // A MANUAL journal. Restricted to OWNER and ADMIN: a manager who can post
  // arbitrary entries can post away any evidence the operational journals
  // produced. Every manual entry is audited with a reason.
  app.post('/entries', async (c) => {
    const db = getDb();
    assertRole(c.var.user, ['ADMIN', 'OWNER'], { action: 'post a manual journal entry' });
    const s = c.var.businessUnit;
    if (s.gl_module_enabled === 0) throw new HttpError(403, 'The general ledger is not enabled for this business.', 'GL_DISABLED');
    const body = await c.req.json();
    if (!body.description || String(body.description).trim().length < 5) {
      throw new HttpError(400, 'A manual journal needs a description of at least 5 characters. It is the only explanation a future reader will have.', 'GL_DESCRIPTION_REQUIRED');
    }
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length < 2) throw new HttpError(400, 'A journal entry needs at least two lines — that is what double entry means.', 'GL_NEEDS_TWO_LINES');
    const branchId = body.branch_id || null;
    if (branchId) assertBranchAccess(c.var.user, branchId);
    const entryDate = body.entry_date ? String(body.entry_date).slice(0, 10) : watDate();
    if (entryDate > watDate()) throw new HttpError(400, 'A journal entry cannot be dated in the future.', 'GL_DATE_FUTURE');

    const result = await glService.postEntry(db, {
      businessUnitId: c.var.businessUnitId, branchId, entryDate,
      sourceType: 'MANUAL', reference: body.reference || null,
      description: String(body.description).slice(0, 500),
      lines: lines.map((l) => ({
        account_code: String(l.account_code || l.account || '').trim(),
        debit: l.debit != null ? Number(l.debit) : 0,
        credit: l.credit != null ? Number(l.credit) : 0,
        description: l.description || null,
      })),
      userId: c.var.user.id,
    });
    await writeAudit(db, {
      businessUnitId: c.var.businessUnitId, branchId, userId: c.var.user.id, actorRole: c.var.user.role,
      action: 'GL_MANUAL_ENTRY', entityType: 'JOURNAL_ENTRY', entityId: result.entry_id,
      amount: result.total_debit, reason: String(body.description).slice(0, 500),
      after: { entry_no: result.entry_no, lines: result.lines },
      ipAddress: c.var.ipAddress, deviceId: c.var.deviceId,
    });
    return c.json({ ok: true, ...result }, 201);
  });

  app.get('/trial-balance', async (c) => {
    requireGl(c);
    const db = getDb();
    return c.json(await glService.trialBalance(db, {
      businessUnitId: c.var.businessUnitId,
      branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      asAt: c.req.query('as_at') || null,
    }));
  });

  app.get('/profit-loss', async (c) => {
    requireGl(c);
    const db = getDb();
    return c.json(await glService.profitAndLoss(db, {
      businessUnitId: c.var.businessUnitId,
      branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      startDate: c.req.query('from'), endDate: c.req.query('to'),
    }));
  });

  app.get('/balance-sheet', async (c) => {
    requireGl(c);
    const db = getDb();
    return c.json(await glService.balanceSheet(db, {
      businessUnitId: c.var.businessUnitId,
      branchId: resolveScopedBranchId(c.var.user, c.req.query('branch_id')),
      asAt: c.req.query('as_at') || null,
    }));
  });

  // The integrity panel. Each check names a specific failure rather than
  // reporting "something is wrong": an integrity panel that says "check your
  // books" is indistinguishable from one that is broken.
  app.get('/integrity', async (c) => {
    requireGl(c);
    const db = getDb();
    return c.json(await glService.integrityCheck(db, { businessUnitId: c.var.businessUnitId }));
  });

  return app;
}

module.exports = { expenseRoutes, creditorRoutes, taxRoutes, glRoutes };
'use strict';
