// =====================================================================
// StockRidge — WARRANTY & CLAIMS
// =====================================================================
// A warranty register is a commercial instrument, not a customer-service
// nicety. Three things it exists to answer:
//
//   1. "Is this item still in cover?"  — at the counter, in ten seconds, from
//      a serial number or a phone number, without phoning the head office.
//   2. "What does this claim cost us, and can we recover it?" — repair_cost
//      against recovered_from_provider. A manufacturer that will not honour
//      its own warranty is a brand worth delisting, and only a register makes
//      that visible.
//   3. "Is this product failing?" — claim rate by product and by brand. Three
//      compressor failures on one fridge model in a quarter is a purchasing
//      decision, and without the register it is a series of unrelated
//      conversations.
//
// VOIDING IS A RECORDED DECISION, never a deletion. A warranty row moves to
// VOIDED with a void_reason; it is never removed, because "we voided your
// cover" is a sentence that will be argued about and the record is the only
// thing that settles it.
//
// WHO MAY VOID: a manager or above. A cashier who can void cover at the
// counter can also sell a warranty replacement for cash and void the
// evidence — the same shape as the void-sale theft pattern, applied to stock.
//
// A CLAIM MOVES STOCK. A replacement is a stock movement of type
// WARRANTY_REPLACEMENT, so the item that goes out is accounted for and the
// item that comes back is either restocked (RESALABLE) or written off
// (DEFECTIVE/SCRAP). A replacement that does not touch stock is a replacement
// nobody can count.
// =====================================================================

const { newId, watNowIso, watDate, addMonths, daysBetween } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const stockService = require('./stockService');
const { PREFIXES, nextReference } = require('../lib/references');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { assertCapability } = require('../lib/capabilities');
const { getUnitSettings, assertSubscribed } = require('../lib/planLimits');

const WARRANTY_TYPES = ['MANUFACTURER', 'VENDOR', 'EXTENDED', 'WORKMANSHIP', 'INSTALLATION'];
const FAULT_TYPES = ['MANUFACTURING', 'INSTALLATION', 'MISUSE', 'ACCIDENTAL_DAMAGE', 'WATER_DAMAGE', 'POWER_SURGE', 'SOFTWARE', 'UNKNOWN'];
const CLAIM_STATUSES = ['LOGGED', 'ASSESSED', 'APPROVED', 'REJECTED', 'REPAIRING', 'WITH_PROVIDER', 'REPLACED', 'REFUNDED', 'CLOSED'];
const OUTCOMES = ['PENDING', 'REPAIR', 'REPLACE', 'REFUND', 'REJECT'];

// Look a warranty up the way a customer will ask about it: by serial number,
// by phone number, or by receipt number. All three, because a customer has
// whichever one of them they kept.
async function lookup(db, ctx, { serialNo = null, phone = null, receiptNo = null, productId = null, customerId = null }) {
  const businessUnitId = ctx.businessUnitId;
  const where = ['w.is_deleted = 0', 'w.business_unit_id = ?'];
  const params = [businessUnitId];

  if (serialNo) {
    const key = String(serialNo).trim().toUpperCase();
    where.push('(upper(ps.serial_no) = ? OR upper(ps.imei) = ?)');
    params.push(key, key);
  }
  if (phone) {
    const normalised = require('../../shared/validation').phoneE164(phone);
    const digits = normalised && !normalised.error ? normalised.digits : String(phone).replace(/\D/g, '');
    where.push('(c.phone LIKE ? OR c.phone_national LIKE ?)');
    params.push(`%${digits.slice(-10)}`, `%${digits.slice(-10)}`);
  }
  if (receiptNo) { where.push('upper(s.receipt_no) = ?'); params.push(String(receiptNo).trim().toUpperCase()); }
  if (productId) { where.push('w.product_id = ?'); params.push(productId); }
  if (customerId) { where.push('w.customer_id = ?'); params.push(customerId); }

  if (where.length === 2) {
    throw new HttpError(400, 'Search by serial number, phone number, receipt number, product or customer.', 'WARRANTY_LOOKUP_NEEDS_CRITERIA');
  }

  const rows = await db.prepare(`
    SELECT w.*, p.name AS product_name, p.brand, p.model_number, p.sku,
           ps.serial_no, ps.imei, ps.status AS serial_status,
           c.full_name AS customer_name, c.phone AS customer_phone,
           s.receipt_no, s.occurred_at AS sold_at, b.name AS branch_name,
           CAST(julianday(w.ends_at) - julianday('now','+1 hour') AS INTEGER) AS days_remaining,
           (SELECT COUNT(*) FROM warranty_claims wc WHERE wc.warranty_id = w.id AND wc.is_deleted = 0) AS claim_count
    FROM product_warranties w
    JOIN products p ON p.id = w.product_id
    LEFT JOIN product_serials ps ON ps.id = w.serial_id
    LEFT JOIN customers c ON c.id = w.customer_id
    LEFT JOIN sales s ON s.id = w.sale_id
    LEFT JOIN branches b ON b.id = w.branch_id
    WHERE ${where.join(' AND ')}
    ORDER BY w.starts_at DESC LIMIT 100
  `).bind(...params).all();

  const today = watDate();
  return rows.results.map((r) => ({
    ...r,
    in_cover: r.status === 'ACTIVE' && r.ends_at >= today,
    cover_state: r.status !== 'ACTIVE' ? r.status : (r.ends_at < today ? 'EXPIRED' : (daysBetween(today, r.ends_at) <= 30 ? 'EXPIRING_SOON' : 'IN_COVER')),
    days_remaining: r.days_remaining == null ? null : Number(r.days_remaining),
  }));
}

async function register(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'register a warranty' });
  assertCapability(settings, 'warranty_tracking', { action: 'register a warranty' });

  const branchId = input.branch_id || ctx.user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch this warranty belongs to.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, branchId);

  if (!input.product_id) throw new HttpError(400, 'Choose the product this cover applies to.', 'WARRANTY_PRODUCT_REQUIRED');
  const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(input.product_id).first();
  if (!product) throw new HttpError(404, 'That product was not found.', 'PRODUCT_NOT_FOUND');

  const months = Number(input.months) || Number(product.warranty_months) || Number(settings.warranty_default_months) || 0;
  if (!Number.isFinite(months) || months < 0 || months > 240) {
    throw new HttpError(400, 'Warranty cover must be between 0 and 240 months.', 'WARRANTY_MONTHS_INVALID');
  }
  if (months === 0) {
    throw new HttpError(400, 'A zero-month warranty is not a warranty. If this product carries no cover, turn off warranty tracking on the product instead — a row that says "covered until today" will be quoted back at you.', 'WARRANTY_ZERO_MONTHS');
  }

  const wtype = String(input.warranty_type || 'VENDOR').toUpperCase();
  if (!WARRANTY_TYPES.includes(wtype)) throw new HttpError(400, `Warranty type must be one of: ${WARRANTY_TYPES.join(', ')}.`, 'WARRANTY_TYPE_INVALID');

  const startsAt = String(input.starts_at || watDate()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsAt)) throw new HttpError(400, 'Start date must be YYYY-MM-DD.', 'WARRANTY_DATE_INVALID');
  const endsAt = input.ends_at ? String(input.ends_at).slice(0, 10) : addMonths(startsAt, months);

  let serial = null;
  if (input.serial_id || input.serial_no) {
    serial = input.serial_id
      ? await db.prepare('SELECT * FROM product_serials WHERE id = ? AND is_deleted = 0').bind(input.serial_id).first()
      : await stockService.serialByNumber(db, { businessUnitId, serialNo: input.serial_no });
    if (!serial) throw new HttpError(404, 'That serial number was not found.', 'SERIAL_NOT_FOUND');
    if (serial.product_id !== product.id) {
      throw new HttpError(400, `Serial ${serial.serial_no} belongs to a different product (${serial.product_id}). Cover must be registered against the item it actually identifies.`, 'WARRANTY_SERIAL_PRODUCT_MISMATCH');
    }
    // One ACTIVE cover per serial. A second one is either a mistake or an
    // attempt to extend cover that has expired, and both must be a deliberate
    // EXTENDED registration rather than a duplicate row.
    const existing = await db.prepare(`
      SELECT id, ends_at FROM product_warranties
      WHERE serial_id = ? AND status = 'ACTIVE' AND is_deleted = 0 AND id <> ?
    `).bind(serial.id, input.id || '__none__').first();
    if (existing && wtype !== 'EXTENDED') {
      throw new HttpError(409,
        `Serial ${serial.serial_no} already has active cover until ${existing.ends_at}. Register an EXTENDED warranty to add cover on top, or void the existing one first.`,
        'WARRANTY_ALREADY_ACTIVE');
    }
  }

  const ts = watNowIso();
  const id = newId();
  await db.prepare(`
    INSERT INTO product_warranties (
      id, business_unit_id, serial_id, product_id, sale_id, sale_item_id, customer_id, branch_id,
      warranty_type, months, starts_at, ends_at, terms, provider_name, provider_phone, status,
      registered_by, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?,?,?)
  `).bind(
    id, businessUnitId, serial ? serial.id : null, product.id, input.sale_id || null, input.sale_item_id || null,
    input.customer_id || null, branchId, wtype, months, startsAt, endsAt,
    input.terms ? String(input.terms).slice(0, 2000) : (product.warranty_terms || settings.warranty_terms_default || null),
    input.provider_name ? String(input.provider_name).slice(0, 160) : null,
    input.provider_phone ? String(input.provider_phone).slice(0, 20) : null,
    ctx.user.id, ts, ts
  ).run();

  if (serial) {
    await db.prepare('UPDATE product_serials SET warranty_id = ?, updated_at = ? WHERE id = ?').bind(id, ts, serial.id).run();
  }

  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'WARRANTY_REGISTERED', entityType: 'WARRANTY', entityId: id,
    after: { product_id: product.id, serial_no: serial ? serial.serial_no : null, months, ends_at: endsAt },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id, product_name: product.name, serial_no: serial ? serial.serial_no : null, months, starts_at: startsAt, ends_at: endsAt, warranty_type: wtype };
}

async function voidWarranty(db, ctx, { warrantyId, reason }) {
  const w = await db.prepare('SELECT * FROM product_warranties WHERE id = ? AND is_deleted = 0').bind(warrantyId).first();
  if (!w) throw new HttpError(404, 'That warranty was not found.', 'WARRANTY_NOT_FOUND');
  if (w.business_unit_id !== ctx.businessUnitId) throw new HttpError(403, 'That warranty belongs to another business.', 'WARRANTY_WRONG_BUSINESS');
  assertBranchAccess(ctx.user, w.branch_id);
  if (String(ctx.user.role).toUpperCase() === 'STAFF') {
    throw new HttpError(403,
      'Only a manager can void warranty cover. A cashier who could void cover at the counter could also sell a replacement for cash and remove the evidence — the same pattern as an unrecorded sale void.',
      'WARRANTY_VOID_FORBIDDEN');
  }
  if (!reason || String(reason).trim().length < 8) {
    throw new HttpError(400,
      'Voiding cover needs a written reason of at least 8 characters, and it should name the ground (unauthorised repair, water ingress, physical damage, missing serial). This is the record you will need when the customer disputes it.',
      'WARRANTY_VOID_REASON_REQUIRED');
  }
  if (w.status === 'VOIDED') throw new HttpError(409, 'That cover is already voided.', 'WARRANTY_ALREADY_VOIDED');

  const ts = watNowIso();
  await db.prepare(`UPDATE product_warranties SET status = 'VOIDED', void_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(String(reason).slice(0, 500), ts, warrantyId).run();

  await writeAudit(db, {
    businessUnitId: w.business_unit_id, branchId: w.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'WARRANTY_VOIDED', entityType: 'WARRANTY', entityId: warrantyId,
    reason: String(reason).slice(0, 500), before: { status: w.status, ends_at: w.ends_at }, after: { status: 'VOIDED' },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: warrantyId, status: 'VOIDED', void_reason: String(reason).slice(0, 500) };
}

// ---------------------------------------------------------------------
// CLAIMS
// ---------------------------------------------------------------------
async function logClaim(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertCapability(settings, 'warranty_tracking', { action: 'log a warranty claim' });

  if (!input.warranty_id) throw new HttpError(400, 'A claim must be against a registered warranty. Look it up by serial or phone number first.', 'CLAIM_WARRANTY_REQUIRED');
  const w = await db.prepare('SELECT * FROM product_warranties WHERE id = ? AND is_deleted = 0').bind(input.warranty_id).first();
  if (!w) throw new HttpError(404, 'That warranty was not found.', 'WARRANTY_NOT_FOUND');
  assertBranchAccess(ctx.user, w.branch_id);

  if (!input.fault_description || String(input.fault_description).trim().length < 10) {
    throw new HttpError(400,
      'Describe the fault in at least 10 characters. "Not working" is not a fault description and will not support a claim against the manufacturer or a rejection of the customer.',
      'CLAIM_DESCRIPTION_REQUIRED');
  }
  const faultType = String(input.fault_type || 'UNKNOWN').toUpperCase();
  if (!FAULT_TYPES.includes(faultType)) throw new HttpError(400, `Fault type must be one of: ${FAULT_TYPES.join(', ')}.`, 'CLAIM_FAULT_TYPE_INVALID');

  const today = watDate();
  const inCover = w.status === 'ACTIVE' && w.ends_at >= today;
  // An out-of-cover claim is LOGGED, not refused. Refusing at the counter
  // means no record exists, and the customer's next stop is a social media
  // post about a shop that would not even look at their item. Logging it
  // costs nothing and preserves a goodwill option.
  const ts = watNowIso();
  const id = newId();
  const branch = await db.prepare('SELECT code FROM branches WHERE id = ?').bind(w.branch_id).first();
  const claimNo = (await nextReference(db, { businessUnitId, prefix: PREFIXES.WARRANTY_CLAIM, branchCode: branch.code || '*', scope: 'YEAR' })).reference;

  await db.prepare(`
    INSERT INTO warranty_claims (
      id, business_unit_id, warranty_id, branch_id, customer_id, claim_no, fault_description, fault_type,
      status, outcome, logged_at, logged_by, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,'LOGGED','PENDING',?,?,?,?,?)
  `).bind(
    id, businessUnitId, w.id, w.branch_id, w.customer_id, claimNo,
    String(input.fault_description).slice(0, 2000), faultType, ts, ctx.user.id,
    input.notes ? String(input.notes).slice(0, 2000) : null, ts, ts
  ).run();

  // A serialised item under claim is not sellable stock. Moving it to
  // WARRANTY_REPAIR is what stops it being sold to someone else while the
  // manufacturer is looking at it.
  if (w.serial_id) {
    try {
      await stockService.transitionSerial(db, w.serial_id, 'WARRANTY_REPAIR', { note: `Warranty claim ${claimNo}` });
    } catch (e) {
      // A serial already SOLD cannot transition directly; that is fine, the
      // claim is still logged and the custody chain is intact.
      if (e.code !== 'SERIAL_TRANSITION_NOT_ALLOWED') console.error('[warrantyService] serial transition failed:', e && e.message);
    }
  }

  await writeAudit(db, {
    businessUnitId, branchId: w.branch_id, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'WARRANTY_CLAIM_LOGGED', entityType: 'WARRANTY_CLAIM', entityId: id,
    after: { claim_no: claimNo, in_cover: inCover, fault_type: faultType },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id, claim_no: claimNo, status: 'LOGGED', in_cover: inCover,
    advisory: inCover
      ? `Cover runs to ${w.ends_at}. Assess the fault and record the outcome.`
      : `This cover ${w.status === 'VOIDED' ? `was voided (${w.void_reason || 'no reason recorded'})` : `expired on ${w.ends_at}`}. The claim is logged anyway so there is a record — a manager can decide whether to honour it as goodwill.`,
  };
}

async function assessClaim(db, ctx, { claimId, status, outcome = null, assessmentNote = null, repairCost = 0, recoveredFromProvider = 0 }) {
  const c = await db.prepare('SELECT * FROM warranty_claims WHERE id = ? AND is_deleted = 0').bind(claimId).first();
  if (!c) throw new HttpError(404, 'That claim was not found.', 'CLAIM_NOT_FOUND');
  assertBranchAccess(ctx.user, c.branch_id);
  if (String(ctx.user.role).toUpperCase() === 'STAFF') {
    throw new HttpError(403, 'Only a manager can assess a warranty claim. The decision commits the business to a cost.', 'CLAIM_ASSESSMENT_FORBIDDEN');
  }
  const s = String(status).toUpperCase();
  if (!CLAIM_STATUSES.includes(s)) throw new HttpError(400, `Status must be one of: ${CLAIM_STATUSES.join(', ')}.`, 'CLAIM_STATUS_INVALID');
  const o = outcome ? String(outcome).toUpperCase() : null;
  if (o && !OUTCOMES.includes(o)) throw new HttpError(400, `Outcome must be one of: ${OUTCOMES.join(', ')}.`, 'CLAIM_OUTCOME_INVALID');
  if (['APPROVED', 'REJECTED', 'REPLACED', 'REFUNDED', 'CLOSED'].includes(s) && !o) {
    throw new HttpError(400, 'A decision on a claim needs an outcome: REPAIR, REPLACE, REFUND or REJECT.', 'CLAIM_OUTCOME_REQUIRED');
  }
  if (s === 'REJECTED' || o === 'REJECT') {
    if (!assessmentNote || String(assessmentNote).trim().length < 15) {
      throw new HttpError(400,
        'Rejecting a claim needs a written assessment of at least 15 characters stating the ground. The customer will ask why, and "rejected" with no reason is both unanswerable and indefensible.',
        'CLAIM_REJECTION_REASON_REQUIRED');
    }
  }

  const cost = round2(Math.max(0, Number(repairCost) || 0));
  const recovered = round2(Math.max(0, Number(recoveredFromProvider) || 0));
  if (recovered > cost + 0.005) {
    throw new HttpError(400, `You cannot recover ₦${recovered.toLocaleString('en-NG')} from a provider on a ₦${cost.toLocaleString('en-NG')} repair.`, 'CLAIM_RECOVERY_EXCEEDS_COST');
  }

  const ts = watNowIso();
  const sets = ['status = ?', 'updated_at = ?', 'assessed_by = ?', 'assessment_note = ?', 'repair_cost = ?', 'recovered_from_provider = ?'];
  const params = [s, ts, ctx.user.id, assessmentNote ? String(assessmentNote).slice(0, 2000) : null, cost, recovered];
  if (o) { sets.push('outcome = ?'); params.push(o); }
  if (s === 'CLOSED') { sets.push('closed_at = ?'); params.push(ts); }
  params.push(claimId);
  await db.prepare(`UPDATE warranty_claims SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  // Cost recognition. A warranty repair is a real expense and belongs in the
  // period it happened; the recovery from the provider is a separate credit,
  // because netting them would hide both the cost of the brand and the
  // effectiveness of the recovery.
  if ((cost > 0.004 || recovered > 0.004) && ['APPROVED', 'REPAIRING', 'WITH_PROVIDER', 'CLOSED', 'REPLACED'].includes(s)) {
    try {
      const settings = await getUnitSettings(db, c.business_unit_id);
      if (settings.gl_module_enabled !== 0) {
        const glService = require('./glService');
        const lines = [];
        if (cost > 0.004) lines.push({ account_code: '5500', debit: cost, credit: 0, description: `Warranty repair ${c.claim_no}` });
        if (recovered > 0.004) lines.push({ account_code: '1200', debit: recovered, credit: 0, description: `Recoverable from provider ${c.claim_no}` });
        const total = round2(cost + recovered);
        if (lines.length && total > 0) {
          lines.push({ account_code: '2400', debit: 0, credit: total, description: `Warranty accrual ${c.claim_no}` });
          await glService.postEntry(db, {
            businessUnitId: c.business_unit_id, branchId: c.branch_id, entryDate: watDate(),
            sourceType: 'WARRANTY_CLAIM', sourceId: claimId, reference: c.claim_no,
            description: `Warranty claim ${c.claim_no}`, lines, userId: ctx.user.id,
          });
        }
      }
    } catch (e) { console.error('[warrantyService] GL posting failed for', c.claim_no, e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId: c.business_unit_id, branchId: c.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: `CLAIM_${s}`, entityType: 'WARRANTY_CLAIM', entityId: claimId,
    amount: cost, reason: assessmentNote ? String(assessmentNote).slice(0, 500) : null,
    before: { status: c.status, outcome: c.outcome }, after: { status: s, outcome: o, repair_cost: cost, recovered },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id: claimId, claim_no: c.claim_no, status: s, outcome: o, repair_cost: cost, recovered_from_provider: recovered, net_cost: round2(cost - recovered) };
}

// Fulfil a REPLACE outcome: a replacement unit leaves stock, the faulty one
// is written off or returned to the provider.
async function replaceItem(db, ctx, { claimId, replacementProductId = null, replacementSerialId = null, branchId = null, faultyDisposition = 'SCRAP', note = null }) {
  const c = await db.prepare('SELECT * FROM warranty_claims WHERE id = ? AND is_deleted = 0').bind(claimId).first();
  if (!c) throw new HttpError(404, 'That claim was not found.', 'CLAIM_NOT_FOUND');
  if (!['APPROVED', 'REPAIRING', 'WITH_PROVIDER'].includes(c.status)) {
    throw new HttpError(409, `A claim must be APPROVED before a replacement is issued — this one is ${c.status}.`, 'CLAIM_NOT_APPROVED');
  }
  const w = await db.prepare('SELECT * FROM product_warranties WHERE id = ?').bind(c.warranty_id).first();
  if (!w) throw new HttpError(404, 'The warranty behind this claim was not found.', 'WARRANTY_NOT_FOUND');
  const bid = branchId || c.branch_id;
  assertBranchAccess(ctx.user, bid);

  const productId = replacementProductId || w.product_id;
  const ts = watNowIso();

  const consumed = await stockService.buildConsumeStatements(db, {
    businessUnitId: c.business_unit_id, branchId: bid, productId, quantityBase: 1,
    movementType: 'WARRANTY_REPLACEMENT', sourceType: 'WARRANTY_CLAIM', sourceId: claimId,
    reference: c.claim_no, reason: note || `Warranty replacement for ${c.claim_no}`,
    performedBy: ctx.user.id, deviceId: ctx.deviceId || null, now: ts,
  });
  await db.batch(consumed.statements);

  if (replacementSerialId) {
    await stockService.transitionSerial(db, replacementSerialId, 'SOLD', { note: `Warranty replacement ${c.claim_no}` });
  }
  if (w.serial_id) {
    const disposition = String(faultyDisposition).toUpperCase();
    if (['SCRAP', 'DEFECTIVE', 'RETURNED'].includes(disposition)) {
      try { await stockService.transitionSerial(db, w.serial_id, disposition, { note: `Faulty unit on ${c.claim_no}` }); } catch (e) {
        if (e.code !== 'SERIAL_TRANSITION_NOT_ALLOWED') throw e;
      }
    }
  }

  await db.prepare(`UPDATE warranty_claims SET status = 'REPLACED', outcome = 'REPLACE', updated_at = ? WHERE id = ?`).bind(ts, claimId).run();
  await db.prepare(`UPDATE product_warranties SET status = 'REPLACED', updated_at = ? WHERE id = ?`).bind(ts, w.id).run();

  await writeAudit(db, {
    businessUnitId: c.business_unit_id, branchId: bid, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'CLAIM_REPLACED', entityType: 'WARRANTY_CLAIM', entityId: claimId,
    after: { replacement_product_id: productId, replacement_serial_id: replacementSerialId, faulty_disposition: faultyDisposition },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: claimId, status: 'REPLACED', replacement_product_id: productId };
}

// Claim rate by product and brand. This is the report that changes a
// purchasing decision — and it is only meaningful as a RATE, because a
// best-selling model will always have the most claims in absolute terms.
async function claimRateReport(db, { businessUnitId, startDate, endDate, branchId = null, minUnitsSold = 10 }) {
  const where = ['si.is_deleted = 0', 's.is_deleted = 0', "s.status <> 'VOIDED'", 's.business_unit_id = ?', "date(s.occurred_at,'+1 hour') BETWEEN ? AND ?"];
  const params = [businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10)];
  if (branchId) { where.push('s.branch_id = ?'); params.push(branchId); }

  const rows = await db.prepare(`
    WITH sold AS (
      SELECT si.product_id, COUNT(DISTINCT si.sale_id) AS units_sold
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE ${where.join(' AND ')} AND si.is_service_line = 0
      GROUP BY si.product_id
    ), claims AS (
      SELECT w.product_id, COUNT(*) AS claim_count,
             COALESCE(SUM(wc.repair_cost),0) AS repair_cost,
             COALESCE(SUM(wc.recovered_from_provider),0) AS recovered,
             SUM(CASE WHEN wc.outcome = 'REJECT' THEN 1 ELSE 0 END) AS rejected,
             SUM(CASE WHEN wc.fault_type IN ('MISUSE','ACCIDENTAL_DAMAGE','WATER_DAMAGE') THEN 1 ELSE 0 END) AS customer_fault
      FROM warranty_claims wc
      JOIN product_warranties w ON w.id = wc.warranty_id
      WHERE wc.is_deleted = 0 AND wc.business_unit_id = ?
        AND date(wc.logged_at,'+1 hour') BETWEEN ? AND ?
      GROUP BY w.product_id
    )
    SELECT p.id AS product_id, p.name AS product_name, p.brand, p.model_number,
           COALESCE(s.units_sold,0) AS units_sold,
           COALESCE(c.claim_count,0) AS claim_count,
           COALESCE(c.repair_cost,0) AS repair_cost,
           COALESCE(c.recovered,0) AS recovered,
           COALESCE(c.rejected,0) AS rejected,
           COALESCE(c.customer_fault,0) AS customer_fault
    FROM products p
    LEFT JOIN sold s ON s.product_id = p.id
    LEFT JOIN claims c ON c.product_id = p.id
    WHERE p.business_unit_id = ? AND p.is_deleted = 0
      AND (COALESCE(c.claim_count,0) > 0 OR COALESCE(s.units_sold,0) >= ?)
    ORDER BY (CAST(COALESCE(c.claim_count,0) AS REAL) / MAX(1, COALESCE(s.units_sold,0))) DESC, c.claim_count DESC
    LIMIT 100
  `).bind(...params, businessUnitId, String(startDate).slice(0, 10), String(endDate).slice(0, 10), businessUnitId, Number(minUnitsSold) || 10).all();

  return rows.results.map((r) => {
    const sold = Number(r.units_sold) || 0;
    const claims = Number(r.claim_count) || 0;
    const repair = round2(Number(r.repair_cost) || 0);
    const recovered = round2(Number(r.recovered) || 0);
    return {
      ...r,
      units_sold: sold, claim_count: claims, repair_cost: repair, recovered,
      net_claim_cost: round2(repair - recovered),
      claim_rate_percent: sold > 0 ? round2((claims / sold) * 100) : null,
      recovery_rate_percent: repair > 0 ? round2((recovered / repair) * 100) : null,
      // A high claim rate driven by CUSTOMER fault (misuse, water, drops) is a
      // product-education or product-quality problem; a high rate driven by
      // MANUFACTURING fault is a supplier problem. Only the split tells you
      // which conversation to have.
      customer_fault_share_percent: claims > 0 ? round2((Number(r.customer_fault) / claims) * 100) : 0,
    };
  });
}

async function listClaims(db, { businessUnitId, branchId = null, status = null, outcome = null, customerId = null, from = null, to = null, limit = 50, offset = 0 }) {
  const where = ['wc.is_deleted = 0', 'wc.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('wc.branch_id = ?'); params.push(branchId); }
  if (status) { where.push('wc.status = ?'); params.push(String(status).toUpperCase()); }
  if (outcome) { where.push('wc.outcome = ?'); params.push(String(outcome).toUpperCase()); }
  if (customerId) { where.push('wc.customer_id = ?'); params.push(customerId); }
  if (from) { where.push("date(wc.logged_at,'+1 hour') >= ?"); params.push(String(from).slice(0, 10)); }
  if (to) { where.push("date(wc.logged_at,'+1 hour') <= ?"); params.push(String(to).slice(0, 10)); }

  const rows = await db.prepare(`
    SELECT wc.*, p.name AS product_name, p.brand, ps.serial_no, c.full_name AS customer_name, c.phone AS customer_phone,
           b.name AS branch_name, w.ends_at AS cover_ends_at, w.warranty_type,
           u.full_name AS logged_by_name
    FROM warranty_claims wc
    JOIN product_warranties w ON w.id = wc.warranty_id
    JOIN products p ON p.id = w.product_id
    LEFT JOIN product_serials ps ON ps.id = w.serial_id
    LEFT JOIN customers c ON c.id = wc.customer_id
    LEFT JOIN branches b ON b.id = wc.branch_id
    LEFT JOIN users u ON u.id = wc.logged_by
    WHERE ${where.join(' AND ')}
    ORDER BY CASE wc.status WHEN 'LOGGED' THEN 0 WHEN 'ASSESSED' THEN 1 WHEN 'REPAIRING' THEN 2 ELSE 3 END, wc.logged_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();
  return rows.results;
}

async function expiringCover(db, { businessUnitId, daysAhead = 60, branchId = null, limit = 200 }) {
  const rows = await db.prepare(`
    SELECT * FROM v_warranty_expiring
    WHERE business_unit_id = ? AND days_remaining >= 0 AND days_remaining <= ?
      ${branchId ? 'AND branch_id = ?' : ''}
    ORDER BY days_remaining ASC LIMIT ?
  `).bind(businessUnitId, Number(daysAhead) || 60, ...(branchId ? [branchId] : []), Math.min(500, Number(limit) || 200)).all();
  return {
    results: rows.results,
    count: rows.results.length,
    // Expiring cover is a SALES opportunity, not just an admin task: an
    // extended-warranty offer to a customer whose cover ends next month is
    // the highest-conversion outreach a gadget shop can make.
    advisory: rows.results.length
      ? `${rows.results.length} cover${rows.results.length === 1 ? '' : 'ies'} expire within ${daysAhead} days. This is the list to offer extended cover to — the customer already trusts the product and the timing is the point.`
      : null,
  };
}

module.exports = {
  WARRANTY_TYPES, FAULT_TYPES, CLAIM_STATUSES, OUTCOMES,
  lookup, register, voidWarranty, logClaim, assessClaim, replaceItem,
  claimRateReport, listClaims, expiringCover,
};
