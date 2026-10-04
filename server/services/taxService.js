// =====================================================================
// StockRidge — TAX SERVICE
// =====================================================================
// Everything the business owes FIRS, in the shape a filing needs.
//
// Two taxes, two directions, and confusing them is the most common small-
// business tax error in Nigeria:
//
//   VAT       output VAT collected on sales (a liability) MINUS input VAT
//             paid on purchases and expenses (an asset/recoverable). The net
//             is remitted monthly. Filing the gross output figure without
//             the input credit overpays; filing net without the supporting
//             input invoices fails an audit.
//
//   WHT       two separate books that must never be netted against each
//             other:
//               PAYABLE   we deducted from a supplier -> we owe FIRS the
//                         deduction and the supplier gets a credit note
//               RECEIVABLE a customer deducted from our invoice -> we hold
//                         their credit note and claim it against our own
//                         liability
//
// All figures here are DERIVED from the ledgers, never stored. A stored tax
// figure is a second source of truth that will eventually disagree with the
// transactions behind it, and the transaction is the one FIRS will ask for.
//
// VAT-INCLUSIVE REMINDER: the taxable base of an inclusive total is
// total / 1.075. See lib/vat.js — getting this the other way round
// overstates output VAT by 7.5% on every sale.
// =====================================================================

const { round2, sumMoney, toKobo } = require('../../shared/money');
const { watDate, watMonth } = require('../../shared/ids');
const { HttpError } = require('../lib/http');
const vat = require('../lib/vat');
const wht = require('../lib/wht');

function assertRange(startDate, endDate) {
  if (!startDate || !endDate) throw new HttpError(400, 'A start date and an end date are required.', 'DATE_RANGE_REQUIRED');
  const s = String(startDate).slice(0, 10);
  const e = String(endDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) {
    throw new HttpError(400, 'Dates must be in YYYY-MM-DD format.', 'DATE_FORMAT_INVALID');
  }
  // A backwards range is a 400 with a clear message, never a 500 and never
  // silently swapped — swapping would hide a mis-set report filter and the
  // client would file on the wrong period.
  if (s > e) throw new HttpError(400, 'The start date is after the end date.', 'DATE_RANGE_BACKWARDS');
  return { start: s, end: e };
}

// ---------------------------------------------------------------------
// VAT RETURN SUPPORT
// ---------------------------------------------------------------------
async function vatSummary(db, { businessUnitId, branchId = null, startDate, endDate }) {
  const { start, end } = assertRange(startDate, endDate);
  const settings = await db.prepare('SELECT * FROM business_units WHERE id = ?').bind(businessUnitId).first();
  if (!settings) throw new HttpError(404, 'Business not found.', 'BUSINESS_UNIT_NOT_FOUND');

  const branchScope = branchId ? 'AND s.branch_id = ?' : '';
  const branchParams = branchId ? [branchId] : [];

  const sales = await db.prepare(`
    SELECT
      COALESCE(SUM(s.total),0)            AS gross_turnover,
      COALESCE(SUM(s.vat_amount),0)       AS output_vat,
      COALESCE(SUM(s.total - s.vat_amount),0) AS taxable_turnover,
      COUNT(*)                            AS sale_count,
      COALESCE(SUM(CASE WHEN s.status = 'VOIDED' THEN s.total ELSE 0 END),0) AS voided_turnover
    FROM sales s
    WHERE s.business_unit_id = ? AND s.is_deleted = 0
      AND date(s.occurred_at, '+1 hour') BETWEEN ? AND ?
      ${branchScope}
  `).bind(businessUnitId, start, end, ...branchParams).first();

  const returns = await db.prepare(`
    SELECT COALESCE(SUM(sr.refund_amount),0) AS refunded, COUNT(*) AS return_count
    FROM sale_returns sr
    WHERE sr.business_unit_id = ? AND sr.is_deleted = 0 AND sr.status = 'COMPLETED'
      AND sr.processed_at BETWEEN ? AND ?
      ${branchId ? 'AND sr.branch_id = ?' : ''}
  `).bind(businessUnitId, `${start} 00:00:00`, `${end} 23:59:59`, ...(branchId ? [branchId] : [])).first();

  const rate = vat.normaliseRate(settings.vat_rate_percent);
  // Input VAT on purchases and expenses. Only recoverable when registered.
  const purchaseVat = await db.prepare(`
    SELECT COALESCE(SUM(pr.total_cost),0) AS gross
    FROM purchase_order_receipts pr
    JOIN purchase_orders po ON po.id = pr.purchase_order_id
    WHERE po.business_unit_id = ? AND pr.is_deleted = 0
      AND date(pr.received_at, '+1 hour') BETWEEN ? AND ?
      ${branchId ? 'AND pr.branch_id = ?' : ''}
  `).bind(businessUnitId, start, end, ...(branchId ? [branchId] : [])).first();

  const expenseVat = await db.prepare(`
    SELECT COALESCE(SUM(e.vat_amount),0) AS input_vat, COALESCE(SUM(e.amount),0) AS gross
    FROM expenses e
    WHERE e.business_unit_id = ? AND e.is_deleted = 0 AND e.status IN ('APPROVED','POSTED')
      AND e.expense_date BETWEEN ? AND ?
      ${branchId ? 'AND e.branch_id = ?' : ''}
  `).bind(businessUnitId, start, end, ...(branchId ? [branchId] : [])).first();

  const enabled = vat.isVatEnabled(settings);
  const inclusive = vat.isVatInclusive(settings);
  const purchaseInputVat = enabled ? round2(vat.extractVat(Number(purchaseVat.gross) || 0, rate).vat) : 0;
  const totalInputVat = round2(purchaseInputVat + (Number(expenseVat.input_vat) || 0));
  const refundVat = enabled && inclusive ? round2(vat.extractVat(Number(returns.refunded) || 0, rate).vat) : 0;

  const outputVat = round2((Number(sales.output_vat) || 0) - refundVat);
  const netVat = round2(outputVat - totalInputVat);

  return {
    period: { start, end },
    registered: enabled,
    rate_percent: rate,
    pricing: inclusive ? 'INCLUSIVE' : 'EXCLUSIVE',
    vat_registration_no: settings.vat_registration_no || null,
    output: {
      gross_turnover: round2(Number(sales.gross_turnover) || 0),
      voided_turnover: round2(Number(sales.voided_turnover) || 0),
      taxable_turnover: round2(Number(sales.taxable_turnover) || 0),
      vat_on_sales: round2(Number(sales.output_vat) || 0),
      vat_on_returns: round2(-refundVat),
      net_output_vat: outputVat,
      sale_count: sales.sale_count || 0,
      return_count: returns.return_count || 0,
    },
    input: {
      purchase_gross: round2(Number(purchaseVat.gross) || 0),
      purchase_input_vat: purchaseInputVat,
      expense_input_vat: round2(Number(expenseVat.input_vat) || 0),
      total_input_vat: totalInputVat,
    },
    net_vat_payable: netVat,
    // The advisory note matters: an unregistered business must not file, and
    // a registered one filing a nil return still has to file.
    advisory: !enabled
      ? 'VAT is not enabled for this business, so these figures are indicative only. Enable VAT under Settings → Tax once you are registered with FIRS.'
      : (netVat <= 0
        ? 'Input VAT exceeds output VAT for this period, so a repayment or a carry-forward may be due rather than a payment. Confirm with your tax adviser.'
        : `Net VAT of ₦${netVat.toLocaleString('en-NG')} is due to FIRS for this period. VAT returns are filed monthly by the 21st of the following month.`),
  };
}

// Category-level VAT breakdown, which is what a tax invoice and a filing
// schedule actually need: standard-rated, exempt and zero-rated supplies
// shown separately, because they are separate boxes on the return.
async function vatByTaxCode(db, { businessUnitId, branchId = null, startDate, endDate }) {
  const { start, end } = assertRange(startDate, endDate);
  const rows = await db.prepare(`
    SELECT COALESCE(p.tax_code, 'STANDARD') AS tax_code,
           COUNT(DISTINCT si.sale_id) AS sale_count,
           COALESCE(SUM(si.line_total),0) AS line_total,
           COALESCE(SUM(si.vat_amount),0) AS vat_amount,
           COALESCE(SUM(si.line_total - si.vat_amount),0) AS taxable_base
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id AND s.is_deleted = 0 AND s.status <> 'VOIDED'
    LEFT JOIN products p ON p.id = si.product_id
    WHERE si.is_deleted = 0 AND si.business_unit_id = ?
      AND date(s.occurred_at, '+1 hour') BETWEEN ? AND ?
      ${branchId ? 'AND s.branch_id = ?' : ''}
    GROUP BY COALESCE(p.tax_code, 'STANDARD')
    ORDER BY line_total DESC
  `).bind(businessUnitId, start, end, ...(branchId ? [branchId] : [])).all();

  return rows.results.map((r) => {
    const t = vat.taxCodeOf(r.tax_code);
    return {
      tax_code: t.code,
      label: t.label,
      note: t.note,
      sale_count: r.sale_count,
      line_total: round2(r.line_total),
      vat_amount: round2(r.vat_amount),
      taxable_base: round2(r.taxable_base),
    };
  });
}

// ---------------------------------------------------------------------
// WHT
// ---------------------------------------------------------------------
async function whtSummary(db, { businessUnitId, branchId = null, startDate, endDate, direction = null }) {
  const { start, end } = assertRange(startDate, endDate);
  const where = ['is_deleted = 0', 'business_unit_id = ?', 'entry_date BETWEEN ? AND ?'];
  const params = [businessUnitId, start, end];
  if (branchId) { where.push('branch_id = ?'); params.push(branchId); }
  if (direction) { where.push('direction = ?'); params.push(String(direction).toUpperCase()); }

  const rows = await db.prepare(`
    SELECT direction, rate_code,
           COUNT(*) AS entries,
           COALESCE(SUM(gross_amount),0) AS gross,
           COALESCE(SUM(wht_amount),0)   AS wht,
           COALESCE(SUM(net_amount),0)   AS net,
           COALESCE(SUM(CASE WHEN remitted_at IS NULL THEN wht_amount ELSE 0 END),0) AS unremitted,
           COUNT(CASE WHEN remitted_at IS NULL THEN 1 END) AS unremitted_entries
    FROM wht_entries
    WHERE ${where.join(' AND ')}
    GROUP BY direction, rate_code
    ORDER BY direction, wht DESC
  `).bind(...params).all();

  const payable = rows.results.filter((r) => r.direction === 'PAYABLE');
  const receivable = rows.results.filter((r) => r.direction === 'RECEIVABLE');
  const totalPayable = round2(payable.reduce((a, r) => a + Number(r.wht), 0));
  const totalReceivable = round2(receivable.reduce((a, r) => a + Number(r.wht), 0));
  const totalUnremitted = round2(payable.reduce((a, r) => a + Number(r.unremitted), 0));

  return {
    period: { start, end },
    deducted_from_suppliers: {
      label: 'WHT we deducted (payable to FIRS)',
      groups: payable.map((r) => ({ rate_code: r.rate_code, entries: r.entries, gross: round2(r.gross), wht: round2(r.wht), net: round2(r.net), unremitted: round2(r.unremitted) })),
      total: totalPayable,
      unremitted: totalUnremitted,
      unremitted_entries: payable.reduce((a, r) => a + r.unremitted_entries, 0),
    },
    deducted_by_customers: {
      label: 'WHT deducted from us (credit notes to claim)',
      groups: receivable.map((r) => ({ rate_code: r.rate_code, entries: r.entries, gross: round2(r.gross), wht: round2(r.wht), net: round2(r.net) })),
      total: totalReceivable,
    },
    // These are NEVER netted. Presenting a single figure would be wrong in
    // both directions: the payable is a cash obligation to FIRS on a fixed
    // date, and the receivable is a credit note that may or may not ever
    // arrive from the customer.
    netting_warning: 'Payable and receivable withholding tax are reported separately and must not be netted against each other. One is a cash obligation to FIRS; the other is a credit note you must obtain from your customer.',
    advisory: totalUnremitted > 0
      ? `₦${totalUnremitted.toLocaleString('en-NG')} of deducted WHT has not been marked as remitted. WHT is remitted to FIRS by the 21st of the month following deduction, and a late remittance attracts interest and penalties.`
      : 'All deducted WHT in this period is marked as remitted.',
  };
}

async function whtByCounterparty(db, { businessUnitId, startDate, endDate, direction = 'PAYABLE' }) {
  const { start, end } = assertRange(startDate, endDate);
  const rows = await db.prepare(`
    SELECT counterparty_name, counterparty_tin,
           COUNT(*) AS entries,
           COALESCE(SUM(gross_amount),0) AS gross,
           COALESCE(SUM(wht_amount),0) AS wht,
           MIN(entry_date) AS first_entry,
           MAX(entry_date) AS last_entry,
           SUM(CASE WHEN remitted_at IS NULL THEN 1 ELSE 0 END) AS unremitted_entries,
           MAX(exemption_applied) AS any_exemption
    FROM wht_entries
    WHERE is_deleted = 0 AND business_unit_id = ? AND direction = ? AND entry_date BETWEEN ? AND ?
    GROUP BY counterparty_name, counterparty_tin
    ORDER BY wht DESC
  `).bind(businessUnitId, String(direction).toUpperCase(), start, end).all();
  return rows.results.map((r) => ({
    ...r,
    gross: round2(r.gross), wht: round2(r.wht),
    has_tin: !!r.counterparty_tin,
  }));
}

// Which credit notes are outstanding. A receivable WHT nobody chases is a
// permanent loss: the customer deducted it, FIRS will not accept our gross
// figure without the note, and the note has to be requested from the
// customer's accounts department — which takes weeks if it happens at all.
async function outstandingCreditNotes(db, { businessUnitId, olderThanDays = 30 }) {
  const rows = await db.prepare(`
    SELECT we.*, c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
           CAST(julianday('now','+1 hour') - julianday(we.entry_date) AS INTEGER) AS days_outstanding
    FROM wht_entries we
    LEFT JOIN sales s ON s.id = we.source_id
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE we.is_deleted = 0 AND we.business_unit_id = ? AND we.direction = 'RECEIVABLE'
      AND we.credit_note_no IS NULL
      AND julianday('now','+1 hour') - julianday(we.entry_date) > ?
    ORDER BY we.entry_date ASC
    LIMIT 200
  `).bind(businessUnitId, Number(olderThanDays) || 30).all();
  return {
    results: rows.results.map((r) => ({ ...r, wht_amount: round2(r.wht_amount), gross_amount: round2(r.gross_amount) })),
    total_at_risk: round2(rows.results.reduce((a, r) => a + Number(r.wht_amount || 0), 0)),
    count: rows.results.length,
  };
}

// ---------------------------------------------------------------------
// RECORD A WHT ENTRY
// ---------------------------------------------------------------------
async function recordEntry(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await db.prepare('SELECT * FROM business_units WHERE id = ?').bind(businessUnitId).first();
  if (!whtEnabled(settings) && String(ctx.user.role).toUpperCase() !== 'ADMIN') {
    throw new HttpError(403,
      'Withholding tax is not enabled for this business. The owner can turn it on under Settings → Tax once you are deducting or being deducted.',
      'WHT_NOT_ENABLED');
  }

  const direction = String(input.direction || '').toUpperCase();
  if (!['PAYABLE', 'RECEIVABLE'].includes(direction)) {
    throw new HttpError(400, 'Direction must be PAYABLE (we deducted from a supplier) or RECEIVABLE (a customer deducted from us).', 'WHT_DIRECTION_INVALID');
  }
  const gross = round2(Number(input.gross_amount));
  if (!Number.isFinite(gross) || gross <= 0) throw new HttpError(400, 'Enter the gross invoice amount — the figure before any deduction.', 'WHT_GROSS_INVALID');

  const deduction = await wht.resolveDeduction(db, {
    grossAmount: gross,
    rateCode: input.rate_code || null,
    ratePercentOverride: input.rate_percent != null ? Number(input.rate_percent) : null,
    direction,
    counterpartyType: input.counterparty_type || null,
    businessUnitId,
  });
  if (!deduction) throw new HttpError(400, 'Choose a withholding tax rate, or enter a rate percentage.', 'WHT_RATE_REQUIRED');

  const counterpartyName = String(input.counterparty_name || '').trim();
  if (!counterpartyName) throw new HttpError(400, 'Name the counterparty — an anonymous WHT entry cannot be filed or chased.', 'WHT_COUNTERPARTY_REQUIRED');

  const entryDate = input.entry_date ? String(input.entry_date).slice(0, 10) : watDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new HttpError(400, 'Entry date must be YYYY-MM-DD.', 'WHT_DATE_INVALID');

  const hint = wht.exemptionHint({
    grossAmount: gross,
    counterpartyTin: input.counterparty_tin || null,
    counterpartyType: input.counterparty_type || null,
    monthlyTotalForCounterparty: (await wht.monthToDateTotal(db, {
      businessUnitId, direction, counterpartyName, tin: input.counterparty_tin || null,
      month: wht.filingPeriod(entryDate),
    })).total,
  });

  const id = require('../../shared/ids').newId();
  const ts = require('../../shared/ids').watNowIso();
  await db.prepare(`
    INSERT INTO wht_entries (
      id, business_unit_id, branch_id, entry_date, direction, source_type, source_id,
      counterparty_name, counterparty_tin, counterparty_type, rate_code, rate_percent,
      gross_amount, wht_amount, net_amount, credit_note_no, exemption_applied, exemption_reason,
      notes, created_by, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, businessUnitId, input.branch_id || ctx.user.branch_id || null, entryDate, direction,
    String(input.source_type || 'OTHER').toUpperCase(), input.source_id || id,
    counterpartyName.slice(0, 160), input.counterparty_tin || null,
    input.counterparty_type ? String(input.counterparty_type).toUpperCase() : null,
    deduction.rateCode, deduction.ratePercent,
    deduction.gross, deduction.wht, deduction.net,
    input.credit_note_no || null,
    input.exemption_applied ? 1 : 0, input.exemption_reason || null,
    input.notes || null, ctx.user.id, ts, ts
  ).run();

  // Post to the ledger when the GL is on. A WHT entry that never reaches the
  // books is a filing that will not reconcile to the trial balance.
  let glPosted = false;
  if (settings.gl_module_enabled !== 0) {
    try {
      const glService = require('./glService');
      await glService.postWhtEntry(db, {
        businessUnitId, branchId: input.branch_id || null, userId: ctx.user.id,
        entry: { id, direction, wht_amount: deduction.wht, counterparty_name: counterpartyName, entry_date: entryDate, credit_note_no: input.credit_note_no || null, filed_period: wht.filingPeriod(entryDate) },
      });
      glPosted = true;
    } catch (e) { console.error('[taxService] WHT GL posting failed:', e && e.message); }
  }

  return {
    ok: true, id, direction, entry_date: entryDate,
    counterparty_name: counterpartyName, counterparty_band: deduction.counterpartyBand,
    rate_code: deduction.rateCode, rate_percent: deduction.ratePercent,
    gross_amount: deduction.gross, wht_amount: deduction.wht, net_amount: deduction.net,
    regulation_ref: deduction.regulationRef,
    // ADVISORY, never blocking — see lib/wht.js for why.
    exemption_hint: hint,
    filed_period: wht.filingPeriod(entryDate),
    gl_posted: glPosted,
  };
}

function whtEnabled(settings) { return !!(settings && settings.wht_enabled); }

async function markRemitted(db, ctx, { entryId, remittanceRef, remittedAt }) {
  const row = await db.prepare('SELECT * FROM wht_entries WHERE id = ? AND is_deleted = 0').bind(entryId).first();
  if (!row) throw new HttpError(404, 'That withholding tax entry was not found.', 'WHT_ENTRY_NOT_FOUND');
  if (row.remitted_at) throw new HttpError(409, `That entry was already marked remitted on ${row.remitted_at}.`, 'WHT_ALREADY_REMITTED');
  if (!remittanceRef || String(remittanceRef).trim().length < 3) {
    throw new HttpError(400, 'Enter the FIRS remittance reference — without it there is no proof the deduction was paid over.', 'WHT_REMITTANCE_REF_REQUIRED');
  }
  await db.prepare('UPDATE wht_entries SET remitted_at = ?, remittance_ref = ?, updated_at = ? WHERE id = ?')
    .bind(remittedAt || watDate(), String(remittanceRef).trim().slice(0, 120), require('../../shared/ids').watNowIso(), entryId).run();
  return { ok: true, id: entryId, remitted_at: remittedAt || watDate(), remittance_ref: String(remittanceRef).trim() };
}

async function recordCreditNote(db, ctx, { entryId, creditNoteNo }) {
  const row = await db.prepare('SELECT * FROM wht_entries WHERE id = ? AND is_deleted = 0').bind(entryId).first();
  if (!row) throw new HttpError(404, 'That withholding tax entry was not found.', 'WHT_ENTRY_NOT_FOUND');
  if (row.direction !== 'RECEIVABLE') {
    throw new HttpError(400, 'A credit note is recorded against WHT a CUSTOMER deducted from you, not against WHT you deducted.', 'WHT_CREDIT_NOTE_WRONG_DIRECTION');
  }
  if (!creditNoteNo || String(creditNoteNo).trim().length < 3) {
    throw new HttpError(400, 'Enter the credit note number exactly as the customer issued it.', 'WHT_CREDIT_NOTE_REQUIRED');
  }
  await db.prepare('UPDATE wht_entries SET credit_note_no = ?, updated_at = ? WHERE id = ?')
    .bind(String(creditNoteNo).trim().slice(0, 120), require('../../shared/ids').watNowIso(), entryId).run();
  return { ok: true, id: entryId, credit_note_no: String(creditNoteNo).trim() };
}

// The monthly filing pack: everything needed to complete a VAT and WHT
// return for one period, in one call, because assembling it from six screens
// is how a filing gets done late.
async function monthlyFilingPack(db, { businessUnitId, month }) {
  const m = String(month || watMonth()).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new HttpError(400, 'Month must be YYYY-MM.', 'MONTH_FORMAT_INVALID');
  const start = `${m}-01`;
  const lastDay = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  const end = `${m}-${String(lastDay).padStart(2, '0')}`;

  const [vatSum, vatCodes, whtSum] = await Promise.all([
    vatSummary(db, { businessUnitId, startDate: start, endDate: end }),
    vatByTaxCode(db, { businessUnitId, startDate: start, endDate: end }),
    whtSummary(db, { businessUnitId, startDate: start, endDate: end }),
  ]);

  return {
    period: m, start, end,
    // FIRS deadlines, stated because a filing pack that does not say when it
    // is due is a filing pack that gets filed late.
    deadlines: {
      vat_return: '21st of the following month',
      wht_remittance: '21st of the following month',
      cit_prepayment: 'as advised by your tax adviser',
    },
    vat: { ...vatSum, by_tax_code: vatCodes },
    withholding_tax: whtSum,
    generated_at: require('../../shared/ids').watNowIso(),
  };
}

module.exports = {
  assertRange, vatSummary, vatByTaxCode,
  whtSummary, whtByCounterparty, outstandingCreditNotes,
  recordEntry, markRemitted, recordCreditNote, monthlyFilingPack,
};
'use strict';
