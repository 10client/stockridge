// =====================================================================
// StockRidge — CUSTOMERS
// =====================================================================
// The customer record is where three different problems meet, and treating
// them as one record is what makes it work:
//
//   IDENTITY   who they are, reached by phone number — the only identifier
//              a Nigerian customer reliably has and reliably quotes
//   PRICING    what tier they buy at (retail / wholesale / distributor /
//              contractor / project / government)
//   EXPOSURE   what they owe, against what they may owe
//
// PHONE IS THE PRIMARY KEY IN PRACTICE. A partial unique index enforces one
// ACTIVE customer per phone per business. Without it, one subscriber
// accumulates two debtor records and defeats their own credit limit — which
// is not a data-quality complaint, it is a hole in the only control that
// stops a bad debtor taking more stock.
//
// CREDIT LIMIT IS A HARD STOP WITH AN ATTRIBUTABLE OVERRIDE. The override is
// recorded against a NAMED person on the sale row, so an escalation of
// authority is never anonymous. A limit that can be exceeded quietly is not a
// limit.
//
// KYC IS DEMANDED PER FLOW, NOT GLOBALLY. Asking every walk-in buyer for a
// BVN would empty the shop. It is required for credit, for instalment plans
// and for regulated goods — the three places where not knowing who someone is
// actually costs money.
//
// DEBTOR BALANCE IS DERIVED, NEVER STORED. v_debtor_balances sums the ledger.
// A stored balance can drift from its own entries, and then nobody knows
// which number is true; a derived one can only be as wrong as its entries,
// which are append-only and auditable.
// =====================================================================

const { newId, watNowIso, watDate, daysBetween } = require('../../shared/ids');
const { round2, sumMoney } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const V = require('../../shared/validation');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess, assertRole } = require('../lib/roles');
const { staffAllowance } = require('../lib/planLimits');

const CUSTOMER_TYPES = ['WALK_IN', 'RETAIL', 'WHOLESALE', 'DISTRIBUTOR', 'SUB_DEALER', 'CORPORATE', 'GOVERNMENT', 'CONTRACTOR', 'PROJECT', 'HOSPITAL', 'RESERVED'];
const ID_TYPES = ['NIN', 'BVN', 'DRIVERS_LICENSE', 'INTL_PASSPORT', 'VOTERS_CARD', 'CAC', 'WORK_ID', 'OTHER'];

async function create(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const branchId = input.home_branch_id || ctx.user.branch_id || null;
  if (branchId) assertBranchAccess(ctx.user, branchId);

  const fullName = V.required(input.full_name, { field: 'Customer name', max: V.LIMITS.NAME });
  if (fullName && fullName.error) throw new HttpError(400, fullName.error, 'VALIDATION_FAILED');

  const type = V.oneOf(input.customer_type, CUSTOMER_TYPES, { field: 'Customer type', def: 'RETAIL' });
  if (type && type.error) throw new HttpError(400, type.error, 'VALIDATION_FAILED');

  // Phone normalisation. Every form a customer says or writes — 0803...,
  // +234803..., 234 803..., 803... — resolves to the same subscriber. Two
  // records for one subscriber is how a credit limit gets defeated.
  let phoneInt = null;
  let phoneNat = null;
  if (input.phone) {
    const p = V.phone(input.phone, { field: 'Phone number' });
    if (p && p.error) throw new HttpError(400, p.error, 'VALIDATION_FAILED');
    if (p) { phoneInt = p.international; phoneNat = p.national; }
  }

  if (phoneInt) {
    const dupe = await db.prepare(`
      SELECT id, full_name, home_branch_id, b.name AS branch_name FROM customers c
      LEFT JOIN branches b ON b.id = c.home_branch_id
      WHERE c.business_unit_id = ? AND c.phone = ? AND c.is_deleted = 0 AND c.is_active = 1
    `).bind(businessUnitId, phoneInt).first();
    if (dupe) {
      // Refuse AND tell them who it is. Silently creating a second record is
      // the failure this check exists to prevent; silently merging would
      // rewrite a record the caller did not ask to change.
      throw new HttpError(409,
        `${dupe.full_name} is already registered on ${phoneNat}${dupe.branch_name ? ` at ${dupe.branch_name}` : ''}. Open that record instead — creating a second one would split their purchase history and their credit limit.`,
        'CUSTOMER_PHONE_EXISTS');
    }
  }

  const email = input.email ? V.email(input.email, { field: 'Email' }) : null;
  if (email && email.error) throw new HttpError(400, email.error, 'VALIDATION_FAILED');
  const tin = input.tin ? V.tin(input.tin, { field: 'TIN' }) : null;
  if (tin && tin.error) throw new HttpError(400, tin.error, 'VALIDATION_FAILED');

  // A wholesale/distributor/corporate account is a CREDIT-CAPABLE account by
  // nature, and it needs a company name — an invoice to "Chinedu" for a
  // ₦4m wholesale order is not a document a supplier's accountant can use.
  if (['WHOLESALE', 'DISTRIBUTOR', 'SUB_DEALER', 'CORPORATE', 'GOVERNMENT', 'CONTRACTOR', 'PROJECT'].includes(type) && !input.company_name) {
    throw new HttpError(400,
      `A ${type.toLowerCase().replace(/_/g, ' ')} account needs a company or organisation name. It appears on invoices and credit notes, and an invoice without it is not a document an accounts department can process.`,
      'CUSTOMER_COMPANY_REQUIRED');
  }

  // Credit settings may only be set by someone with credit authority. A
  // cashier who can grant their own customer a ₦500,000 limit has no limit.
  let creditEnabled = 0;
  let creditLimit = 0;
  let creditDays = 30;
  if (input.credit_enabled || Number(input.credit_limit) > 0) {
    const allowance = await staffAllowance(db, businessUnitId, ctx.user);
    if (!allowance.can_grant_credit) {
      throw new HttpError(403, 'Only a manager or the owner can enable credit or set a credit limit for a customer.', 'CREDIT_SETUP_FORBIDDEN');
    }
    creditEnabled = 1;
    creditLimit = round2(Math.max(0, Number(input.credit_limit) || 0));
    creditDays = Math.min(365, Math.max(0, Number(input.credit_days) || 30));
    if (creditLimit > 0 && !input.kyc_verified && (!input.id_type || !input.id_number)) {
      throw new HttpError(400,
        `A credit limit of ₦${creditLimit.toLocaleString('en-NG')} needs the customer\u2019s identity recorded first — an ID type and number (NIN, BVN, driver\u2019s licence, passport or voter\u2019s card). Credit extended to an unidentifiable person is not recoverable.`,
        'CREDIT_KYC_REQUIRED');
    }
  }

  const idType = input.id_type ? V.oneOf(input.id_type, ID_TYPES, { field: 'ID type' }) : null;
  if (idType && idType.error) throw new HttpError(400, idType.error, 'VALIDATION_FAILED');

  const tierId = input.tier_id || null;
  if (tierId) {
    const tier = await db.prepare('SELECT * FROM price_tiers WHERE id = ? AND business_unit_id = ? AND is_deleted = 0').bind(tierId, businessUnitId).first();
    if (!tier) throw new HttpError(404, 'That price tier was not found for this business.', 'TIER_NOT_FOUND');
  }

  const ts = watNowIso();
  const id = newId();
  const kycStatus = (idType && input.id_number) ? 'VERIFIED' : (creditEnabled ? 'PENDING' : 'NOT_REQUIRED');

  await db.prepare(`
    INSERT INTO customers (
      id, business_unit_id, home_branch_id, full_name, customer_type, tier_id, phone, phone_national,
      alt_phone, email, address, state, lga, city, delivery_address, delivery_state, delivery_city,
      delivery_landmark, delivery_instructions, company_name, contact_person, occupation,
      id_type, id_number, kyc_status, kyc_verified_at, kyc_verified_by,
      credit_enabled, credit_limit, credit_days, notes, is_active, created_by, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, businessUnitId, branchId, fullName, type, tierId, phoneInt, phoneNat,
    input.alt_phone ? String(input.alt_phone).slice(0, 20) : null, email,
    input.address ? String(input.address).slice(0, V.LIMITS.ADDRESS) : null,
    input.state ? require('../lib/geo').normaliseState(input.state) : null,
    input.lga ? String(input.lga).slice(0, 120) : null,
    input.city ? String(input.city).slice(0, 120) : null,
    input.delivery_address ? String(input.delivery_address).slice(0, V.LIMITS.ADDRESS) : null,
    input.delivery_state ? require('../lib/geo').normaliseState(input.delivery_state) : null,
    input.delivery_city ? String(input.delivery_city).slice(0, 120) : null,
    input.delivery_landmark ? String(input.delivery_landmark).slice(0, 200) : null,
    input.delivery_instructions ? String(input.delivery_instructions).slice(0, 500) : null,
    input.company_name ? String(input.company_name).slice(0, 160) : null,
    input.contact_person ? String(input.contact_person).slice(0, 160) : null,
    input.occupation ? String(input.occupation).slice(0, 120) : null,
    idType, input.id_number ? String(input.id_number).slice(0, 60) : null,
    kycStatus, kycStatus === 'VERIFIED' ? ts : null, kycStatus === 'VERIFIED' ? ctx.user.id : null,
    creditEnabled, creditLimit, creditDays,
    input.notes ? String(input.notes).slice(0, V.LIMITS.NOTES) : null,
    1, ctx.user.id, ts, ts
  ).run();

  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'CUSTOMER_CREATED', entityType: 'CUSTOMER', entityId: id,
    after: { full_name: fullName, customer_type: type, credit_enabled: creditEnabled, credit_limit: creditLimit },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id, full_name: fullName, customer_type: type, phone: phoneInt, phone_national: phoneNat, credit_enabled: !!creditEnabled, credit_limit: creditLimit, kyc_status: kycStatus };
}

async function update(db, ctx, customerId, input) {
  const existing = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(customerId).first();
  if (!existing) throw new HttpError(404, 'That customer was not found.', 'CUSTOMER_NOT_FOUND');
  if (existing.business_unit_id !== ctx.businessUnitId) throw new HttpError(403, 'That customer belongs to a different business.', 'CUSTOMER_WRONG_BUSINESS');

  // A branch manager may edit customers of their own branch. They may NOT
  // move a customer's home branch — that reparents the debtor book, which is
  // exactly the cross-branch write the sync module refuses.
  assertBranchAccess(ctx.user, existing.home_branch_id);

  const patch = {};
  const auditBefore = {};
  const fields = {
    full_name: { max: V.LIMITS.NAME }, first_name: {}, last_name: {}, address: { max: V.LIMITS.ADDRESS },
    city: {}, lga: {}, delivery_address: { max: V.LIMITS.ADDRESS }, delivery_city: {}, delivery_landmark: {},
    delivery_instructions: { max: 500 }, company_name: {}, contact_person: {}, occupation: {},
    email: { validate: (v) => V.email(v, { field: 'Email' }) },
    notes: { max: V.LIMITS.NOTES },
  };
  for (const [key, opts] of Object.entries(fields)) {
    if (input[key] === undefined) continue;
    let value = input[key] == null ? null : String(input[key]).trim();
    if (opts.validate && value) {
      const r = opts.validate(value);
      if (r && r.error) throw new HttpError(400, r.error, 'VALIDATION_FAILED');
      value = r || value;
    }
    if (value && opts.max && value.length > opts.max) throw new HttpError(400, `${key} is too long.`, 'VALIDATION_FAILED');
    if (String(existing[key] ?? '') !== String(value ?? '')) { auditBefore[key] = existing[key]; patch[key] = value || null; }
  }
  if (input.state !== undefined) patch.state = input.state ? require('../lib/geo').normaliseState(input.state) : null;

  if (input.customer_type !== undefined) {
    const t = V.oneOf(input.customer_type, CUSTOMER_TYPES, { field: 'Customer type' });
    if (t && t.error) throw new HttpError(400, t.error, 'VALIDATION_FAILED');
    patch.customer_type = t;
  }
  if (input.phone !== undefined) {
    if (!input.phone) { patch.phone = null; patch.phone_national = null; }
    else {
      const p = V.phone(input.phone, { field: 'Phone number', optional: false });
      if (p && p.error) throw new HttpError(400, p.error, 'VALIDATION_FAILED');
      const clash = await db.prepare(`
        SELECT id, full_name FROM customers
        WHERE business_unit_id = ? AND phone = ? AND is_deleted = 0 AND is_active = 1 AND id <> ?
      `).bind(ctx.businessUnitId, p.international, customerId).first();
      if (clash) {
        throw new HttpError(409, `${clash.full_name} is already registered on ${p.national}. Two customers on one phone number splits their history and defeats the credit limit.`, 'CUSTOMER_PHONE_EXISTS');
      }
      patch.phone = p.international;
      patch.phone_national = p.national;
    }
  }

  // CREDIT CHANGES need authority AND an audit trail, because raising a limit
  // is functionally the same as handing over stock.
  const creditTouched = input.credit_enabled !== undefined || input.credit_limit !== undefined || input.credit_days !== undefined;
  if (creditTouched) {
    const allowance = await staffAllowance(db, ctx.businessUnitId, ctx.user);
    if (!allowance.can_grant_credit) {
      throw new HttpError(403, 'Only a manager or the owner can change a customer\u2019s credit settings.', 'CREDIT_SETUP_FORBIDDEN');
    }
    if (input.credit_enabled !== undefined) patch.credit_enabled = input.credit_enabled ? 1 : 0;
    if (input.credit_limit !== undefined) {
      const limit = round2(Math.max(0, Number(input.credit_limit) || 0));
      patch.credit_limit = limit;
      // Lowering a limit below the current balance does not erase the debt —
      // it just stops further credit. Saying so prevents the misunderstanding
      // that a limit change is a settlement.
      if (limit > 0 && !existing.credit_enabled) patch.credit_enabled = 1;
    }
    if (input.credit_days !== undefined) patch.credit_days = Math.min(365, Math.max(0, Number(input.credit_days) || 0));
    auditBefore.credit_enabled = existing.credit_enabled;
    auditBefore.credit_limit = existing.credit_limit;
    auditBefore.credit_days = existing.credit_days;
  }

  if (input.tier_id !== undefined) {
    if (input.tier_id) {
      const tier = await db.prepare('SELECT * FROM price_tiers WHERE id = ? AND business_unit_id = ? AND is_deleted = 0').bind(input.tier_id, ctx.businessUnitId).first();
      if (!tier) throw new HttpError(404, 'That price tier was not found for this business.', 'TIER_NOT_FOUND');
      patch.tier_id = tier.id;
    } else patch.tier_id = null;
    auditBefore.tier_id = existing.tier_id;
  }
  if (input.id_type !== undefined) {
    const t = input.id_type ? V.oneOf(input.id_type, ID_TYPES, { field: 'ID type' }) : null;
    if (t && t.error) throw new HttpError(400, t.error, 'VALIDATION_FAILED');
    patch.id_type = t;
    patch.kyc_status = (t && (input.id_number || existing.id_number)) ? 'VERIFIED' : 'PENDING';
    patch.kyc_verified_at = patch.kyc_status === 'VERIFIED' ? watNowIso() : null;
    patch.kyc_verified_by = patch.kyc_status === 'VERIFIED' ? ctx.user.id : null;
  }
  if (input.id_number !== undefined) { patch.id_number = input.id_number ? String(input.id_number).slice(0, 60) : null; }
  if (input.is_active !== undefined) {
    // Deactivating is how a customer record is retired. It releases the phone
    // number for reuse (the unique index only covers is_active = 1) while
    // keeping every historical sale and debt intact.
    patch.is_active = input.is_active ? 1 : 0;
  }

  if (!Object.keys(patch).length) return { ok: true, id: customerId, changed: 0, message: 'Nothing to change.' };

  patch.updated_at = watNowIso();
  patch.updated_by = ctx.user.id;
  const cols = Object.keys(patch).filter((c) => c !== 'updated_by');   // customers has no updated_by column
  await db.prepare(`UPDATE customers SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .bind(...cols.map((c) => patch[c]), customerId).run();

  await writeAudit(db, {
    businessUnitId: ctx.businessUnitId, branchId: existing.home_branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: creditTouched ? 'CUSTOMER_CREDIT_CHANGED' : 'CUSTOMER_UPDATED',
    entityType: 'CUSTOMER', entityId: customerId,
    amount: patch.credit_limit != null ? patch.credit_limit : null,
    before: auditBefore, after: patch, ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id: customerId, changed: cols.length };
}

// The 360 view: identity, tier, balance, aging, open plans, holds, recent
// purchases and warranty cover. One call, because a cashier at the counter
// cannot assemble this from six screens while a customer waits.
async function get(db, ctx, customerId) {
  const businessUnitId = ctx.businessUnitId;
  const c = await db.prepare(`
    SELECT c.*, b.name AS home_branch_name, t.code AS tier_code, t.label AS tier_label
    FROM customers c
    LEFT JOIN branches b ON b.id = c.home_branch_id
    LEFT JOIN price_tiers t ON t.id = c.tier_id
    WHERE c.id = ? AND c.is_deleted = 0
  `).bind(customerId).first();
  if (!c) return null;
  if (c.business_unit_id !== businessUnitId) throw new HttpError(403, 'That customer belongs to a different business.', 'CUSTOMER_WRONG_BUSINESS');

  // A branch manager may see a customer of their own branch. They may NOT see
  // another branch's debtor — the original audit found a Lagos cashier reading
  // a Minna debtor's balance after a cross-branch push reparented the record.
  const role = String(ctx.user.role).toUpperCase();
  if (role === 'STAFF' || (role === 'MANAGER' && ctx.user.branch_id)) {
    if (c.home_branch_id && c.home_branch_id !== ctx.user.branch_id) {
      const ownSales = await db.prepare('SELECT COUNT(*) AS n FROM sales WHERE customer_id = ? AND branch_id = ?').bind(customerId, ctx.user.branch_id).first();
      if (!ownSales.n) {
        throw new HttpError(403, 'That customer belongs to another branch. Their balance and history are not visible from here.', 'CUSTOMER_OTHER_BRANCH');
      }
    }
  }

  const [balance, aging, plans, holds, recentSales, warranties, deliveries] = await Promise.all([
    db.prepare(`
      SELECT COALESCE(SUM(amount),0) AS balance, MAX(entry_date) AS last_entry
      FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0
    `).bind(customerId).first(),
    db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN days <= 30 THEN amount ELSE 0 END),0) AS d_0_30,
        COALESCE(SUM(CASE WHEN days > 30 AND days <= 60 THEN amount ELSE 0 END),0) AS d_31_60,
        COALESCE(SUM(CASE WHEN days > 60 AND days <= 90 THEN amount ELSE 0 END),0) AS d_61_90,
        COALESCE(SUM(CASE WHEN days > 90 THEN amount ELSE 0 END),0) AS d_over_90
      FROM (
        SELECT amount, CAST(julianday('now','+1 hour') - julianday(entry_date) AS INTEGER) AS days
        FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0 AND amount > 0
      )
    `).bind(customerId).first(),
    db.prepare(`
      SELECT id, plan_no, status, plan_type, total_payable, amount_paid, balance_due, next_due_date, possession
      FROM payment_plans WHERE customer_id = ? AND is_deleted = 0 AND status IN ('ACTIVE','DEFAULTED') ORDER BY next_due_date
    `).bind(customerId).all(),
    db.prepare(`
      SELECT id, hold_no, status, total_amount, amount_paid, balance_due, expiry_date
      FROM layaway_holds WHERE customer_id = ? AND is_deleted = 0 AND status = 'ACTIVE' ORDER BY expiry_date
    `).bind(customerId).all(),
    db.prepare(`
      SELECT s.id, s.receipt_no, s.total, s.status, s.sale_type, s.occurred_at, s.balance_due, b.name AS branch_name,
             u.full_name AS sold_by_name
      FROM sales s JOIN branches b ON b.id = s.branch_id JOIN users u ON u.id = s.sold_by
      WHERE s.customer_id = ? AND s.is_deleted = 0 ORDER BY s.occurred_at DESC LIMIT 20
    `).bind(customerId).all(),
    db.prepare(`
      SELECT w.id, w.warranty_type, w.months, w.starts_at, w.ends_at, w.status, p.name AS product_name, ps.serial_no,
             CAST(julianday(w.ends_at) - julianday('now','+1 hour') AS INTEGER) AS days_remaining,
             (SELECT COUNT(*) FROM warranty_claims wc WHERE wc.warranty_id = w.id AND wc.is_deleted = 0) AS claim_count
      FROM product_warranties w
      JOIN products p ON p.id = w.product_id
      LEFT JOIN product_serials ps ON ps.id = w.serial_id
      WHERE w.customer_id = ? AND w.is_deleted = 0 ORDER BY w.ends_at DESC LIMIT 20
    `).bind(customerId).all(),
    db.prepare(`
      SELECT id, job_no, job_type, status, scheduled_date, address, total_charge, pod_received
      FROM delivery_jobs WHERE customer_id = ? AND is_deleted = 0 ORDER BY scheduled_date DESC LIMIT 10
    `).bind(customerId).all(),
  ]);

  const bal = round2(Number(balance.balance) || 0);
  const limit = round2(Number(c.credit_limit) || 0);
  const creditUsedPercent = limit > 0 ? round2((bal / limit) * 100) : null;

  return {
    ...c,
    balance,
    credit_used_percent: creditUsedPercent,
    credit_available: limit > 0 ? round2(Math.max(0, limit - bal)) : null,
    over_limit: limit > 0 && bal > limit,
    aging: aging ? {
      current: round2(aging.d_0_30), d31_60: round2(aging.d_31_60),
      d61_90: round2(aging.d_61_90), over_90: round2(aging.d_over_90),
      total: round2(Number(aging.d_0_30) + Number(aging.d_31_60) + Number(aging.d_61_90) + Number(aging.d_over_90)),
    } : null,
    open_plans: plans.results,
    open_holds: holds.results,
    recent_sales: recentSales.results,
    warranties: warranties.results,
    recent_deliveries: deliveries.results,
    // What the cashier needs to know in one line, at the counter.
    advisory: c.credit_enabled && limit > 0 && bal >= limit
      ? `This customer is at or over their ₦${limit.toLocaleString('en-NG')} credit limit (₦${bal.toLocaleString('en-NG')} owed). A further credit sale needs a manager override with a written reason.`
      : (aging && Number(aging.d_over_90) > 0
        ? `₦${round2(aging.d_over_90).toLocaleString('en-NG')} is over 90 days old. Collect or write it off — it will not get easier.`
        : null),
  };
}

async function list(db, { businessUnitId, branchId = null, type = null, tierId = null, search = null, withBalanceOnly = false, overLimitOnly = false, limit = 50, offset = 0, sort = 'full_name', dir = 'ASC' }) {
  const where = ['c.is_deleted = 0', 'c.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('c.home_branch_id = ?'); params.push(branchId); }
  if (type) { where.push('c.customer_type = ?'); params.push(String(type).toUpperCase()); }
  if (tierId) { where.push('c.tier_id = ?'); params.push(tierId); }
  if (search) {
    const like = `%${String(search).trim().replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
    const digits = String(search).replace(/\D/g, '');
    where.push(`(c.full_name LIKE ? ESCAPE '\\' OR c.company_name LIKE ? ESCAPE '\\' OR c.phone LIKE ? OR c.phone_national LIKE ? OR c.email LIKE ? ESCAPE '\\')`);
    params.push(like, like, digits ? `%${digits.slice(-10)}` : like, digits ? `%${digits.slice(-10)}` : like, like);
  }
  if (withBalanceOnly || overLimitOnly) {
    where.push(`EXISTS (SELECT 1 FROM debtor_ledger d WHERE d.customer_id = c.id AND d.is_deleted = 0 HAVING SUM(d.amount) > 0.005)`);
  }
  if (overLimitOnly) {
    where.push(`c.credit_enabled = 1 AND c.credit_limit > 0
      AND (SELECT COALESCE(SUM(d.amount),0) FROM debtor_ledger d WHERE d.customer_id = c.id AND d.is_deleted = 0) > c.credit_limit`);
  }

  const allowedSorts = ['full_name', 'created_at', 'last_purchase_at', 'total_purchases', 'purchase_count', 'credit_limit'];
  const sortCol = allowedSorts.includes(String(sort)) ? String(sort) : 'full_name';
  const sortDir = String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const rows = await db.prepare(`
    SELECT c.id, c.full_name, c.company_name, c.customer_type, c.phone, c.phone_national, c.email,
           c.home_branch_id, b.name AS home_branch_name, c.tier_id, t.label AS tier_label,
           c.credit_enabled, c.credit_limit, c.credit_days, c.kyc_status, c.is_active,
           c.total_purchases, c.purchase_count, c.last_purchase_at, c.loyalty_points, c.created_at,
           COALESCE((SELECT SUM(d.amount) FROM debtor_ledger d WHERE d.customer_id = c.id AND d.is_deleted = 0),0) AS balance
    FROM customers c
    LEFT JOIN branches b ON b.id = c.home_branch_id
    LEFT JOIN price_tiers t ON t.id = c.tier_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.${sortCol} ${sortDir}
    LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();

  const countRow = await db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE ${where.join(' AND ')}`).bind(...params).first();
  return {
    results: rows.results.map((r) => ({ ...r, balance: round2(r.balance) })),
    total: countRow ? countRow.n : rows.results.length,
  };
}

// Debtor aging across the business. The buckets are the standard 0-30 /
// 31-60 / 61-90 / 90+ because that is what a lender, an auditor and an owner
// all already read; inventing new buckets would make the report harder to
// use, not more precise.
async function agingReport(db, { businessUnitId, branchId = null, asAt = null }) {
  const date = String(asAt || watDate()).slice(0, 10);
  const where = ['d.is_deleted = 0', 'd.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('d.branch_id = ?'); params.push(branchId); }

  const rows = await db.prepare(`
    SELECT c.id AS customer_id, c.full_name, c.company_name, c.phone, c.customer_type,
           c.credit_limit, c.credit_days, b.name AS branch_name,
           COALESCE(SUM(d.amount),0) AS balance,
           COALESCE(SUM(CASE WHEN d.amount > 0 AND julianday(?) - julianday(d.entry_date) <= 30 THEN d.amount ELSE 0 END),0) AS d_0_30,
           COALESCE(SUM(CASE WHEN d.amount > 0 AND julianday(?) - julianday(d.entry_date) > 30 AND julianday(?) - julianday(d.entry_date) <= 60 THEN d.amount ELSE 0 END),0) AS d_31_60,
           COALESCE(SUM(CASE WHEN d.amount > 0 AND julianday(?) - julianday(d.entry_date) > 60 AND julianday(?) - julianday(d.entry_date) <= 90 THEN d.amount ELSE 0 END),0) AS d_61_90,
           COALESCE(SUM(CASE WHEN d.amount > 0 AND julianday(?) - julianday(d.entry_date) > 90 THEN d.amount ELSE 0 END),0) AS d_over_90,
           MIN(CASE WHEN d.amount > 0 THEN d.entry_date END) AS oldest_debit
    FROM debtor_ledger d
    JOIN customers c ON c.id = d.customer_id
    LEFT JOIN branches b ON b.id = d.branch_id
    WHERE ${where.join(' AND ')}
    GROUP BY c.id, c.full_name, c.company_name, c.phone, c.customer_type, c.credit_limit, c.credit_days, b.name
    HAVING COALESCE(SUM(d.amount),0) > 0.005
    ORDER BY COALESCE(SUM(d.amount),0) DESC
    LIMIT 1000
  `).bind(date, date, date, date, date, ...params).all();

  const results = rows.results.map((r) => ({
    ...r,
    balance: round2(r.balance), d_0_30: round2(r.d_0_30), d_31_60: round2(r.d_31_60),
    d_61_90: round2(r.d_61_90), d_over_90: round2(r.d_over_90),
    over_limit: Number(r.credit_limit) > 0 && Number(r.balance) > Number(r.credit_limit),
    days_since_oldest: r.oldest_debit ? daysBetween(r.oldest_debit, date) : null,
  }));

  const totals = {
    balance: round2(sumMoney(results.map((r) => r.balance))),
    d_0_30: round2(sumMoney(results.map((r) => r.d_0_30))),
    d_31_60: round2(sumMoney(results.map((r) => r.d_31_60))),
    d_61_90: round2(sumMoney(results.map((r) => r.d_61_90))),
    d_over_90: round2(sumMoney(results.map((r) => r.d_over_90))),
    customers: results.length,
    over_limit_count: results.filter((r) => r.over_limit).length,
    over_90_value: round2(sumMoney(results.map((r) => r.d_over_90))),
  };

  return {
    as_at: date, totals, results,
    advisory: totals.d_over_90 > 0
      ? `₦${totals.d_over_90.toLocaleString('en-NG')} is more than 90 days old across ${results.filter((r) => r.d_over_90 > 0).length} customers. Debt older than 90 days is recovered at a fraction of the rate of current debt — the realistic choice now is between aggressive collection and a write-off decision.`
      : null,
  };
}

// Record a payment against a customer's account (not tied to a specific new
// sale). This is how an outstanding credit balance gets collected.
async function recordPayment(db, ctx, { customerId, amount, method = 'CASH', reference = null, branchId = null, note = null, allocation = null }) {
  const businessUnitId = ctx.businessUnitId;
  const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(customerId).first();
  if (!c) throw new HttpError(404, 'That customer was not found.', 'CUSTOMER_NOT_FOUND');
  if (c.business_unit_id !== businessUnitId) throw new HttpError(403, 'That customer belongs to a different business.', 'CUSTOMER_WRONG_BUSINESS');

  const bid = branchId || ctx.user.branch_id || c.home_branch_id;
  if (!bid) throw new HttpError(400, 'Choose which branch is receiving this payment.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, bid);

  const value = round2(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'The payment must be more than zero.', 'PAYMENT_AMOUNT_INVALID');

  const balRow = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS balance FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0`).bind(customerId).first();
  const balance = round2(Number(balRow.balance) || 0);
  if (value > balance + 0.005) {
    throw new HttpError(400,
      `${c.full_name} owes ₦${balance.toLocaleString('en-NG')}, so a ₦${value.toLocaleString('en-NG')} payment would put them in credit. `
      + 'Take the exact amount, or if they genuinely want to prepay, record it as a customer deposit rather than a debtor payment.',
      'PAYMENT_EXCEEDS_BALANCE');
  }
  const m = String(method).toUpperCase();
  if (!['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'USSD', 'MOBILE_MONEY', 'CHEQUE', 'OTHER'].includes(m)) {
    throw new HttpError(400, 'Payment method must be CASH, POS_TERMINAL, BANK_TRANSFER, USSD, MOBILE_MONEY, CHEQUE or OTHER.', 'PAYMENT_METHOD_INVALID');
  }
  if (['BANK_TRANSFER', 'POS_TERMINAL', 'CHEQUE', 'USSD'].includes(m) && !reference) {
    throw new HttpError(400, `A ${m.replace(/_/g, ' ').toLowerCase()} payment needs a reference so it can be matched to the bank statement.`, 'PAYMENT_REFERENCE_REQUIRED');
  }

  const ts = watNowIso();
  const id = newId();
  const statements = [
    db.prepare(`
      INSERT INTO debtor_ledger (
        id, business_unit_id, branch_id, customer_id, entry_date, entry_type, source_type, source_id,
        reference, amount, balance_after, notes, created_by, created_at, updated_at
      ) VALUES (?,?,?,?,?, 'PAYMENT', 'CUSTOMER_PAYMENT', ?,?,?,?, ?,?,?,?)
    `).bind(id, businessUnitId, bid, customerId, watDate(), id, reference ? String(reference).slice(0, 120) : null,
      -value, round2(balance - value), note ? String(note).slice(0, 500) : null, ctx.user.id, ts, ts),
  ];

  // Cash into the open till so the drawer agrees. A debtor payment taken in
  // cash and not counted in a till is a shortage blamed on a cashier.
  const till = await db.prepare(`SELECT * FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0`).bind(bid).first();
  if (till && m === 'CASH') {
    statements.push(db.prepare(`UPDATE till_sessions SET expected_cash = expected_cash + ?, expected_total = expected_total + ?, updated_at = ? WHERE id = ?`)
      .bind(value, value, ts, till.id));
  }
  await db.batch(statements);

  if (m !== 'CASH') {
    try {
      const settings = await require('../lib/planLimits').getUnitSettings(db, businessUnitId);
      if (settings.gl_module_enabled !== 0) {
        const glService = require('./glService');
        const account = { POS_TERMINAL: '1030', BANK_TRANSFER: '1020', USSD: '1040', MOBILE_MONEY: '1040', CHEQUE: '1050', OTHER: '1020' }[m] || '1020';
        await glService.postEntry(db, {
          businessUnitId, branchId: bid, entryDate: watDate(),
          sourceType: 'CUSTOMER_PAYMENT', sourceId: id, reference: reference || null,
          description: `Debtor payment from ${c.full_name}`,
          lines: [
            { account_code: account, debit: value, credit: 0, description: `Payment ${reference || ''}` },
            { account_code: '1200', debit: 0, credit: value, description: `Debtor settled ${c.full_name}` },
          ],
          userId: ctx.user.id,
        });
      }
    } catch (e) { console.error('[customerService] GL posting failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId, branchId: bid, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'DEBTOR_PAYMENT', entityType: 'CUSTOMER', entityId: customerId, amount: value,
    before: { balance }, after: { balance: round2(balance - value), method: m, reference },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id, customer_id: customerId, amount: value, method: m, balance_before: balance, balance_after: round2(balance - value) };
}

// Statement of account: the document a customer's accounts department asks
// for, and the document that settles "I already paid that".
async function statement(db, ctx, { customerId, from = null, to = null }) {
  const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(customerId).first();
  if (!c) throw new HttpError(404, 'That customer was not found.', 'CUSTOMER_NOT_FOUND');
  if (c.business_unit_id !== ctx.businessUnitId) throw new HttpError(403, 'That customer belongs to a different business.', 'CUSTOMER_WRONG_BUSINESS');

  const where = ['d.is_deleted = 0', 'd.customer_id = ?'];
  const params = [customerId];
  if (from) { where.push('d.entry_date >= ?'); params.push(String(from).slice(0, 10)); }
  if (to) { where.push('d.entry_date <= ?'); params.push(String(to).slice(0, 10)); }

  const rows = await db.prepare(`
    SELECT d.*, b.name AS branch_name, u.full_name AS created_by_name
    FROM debtor_ledger d
    LEFT JOIN branches b ON b.id = d.branch_id
    LEFT JOIN users u ON u.id = d.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY d.entry_date ASC, d.created_at ASC
    LIMIT 2000
  `).bind(...params).all();

  const business = await db.prepare('SELECT name, legal_name, address, phone, rc_number, tin FROM business_units WHERE id = ?').bind(c.business_unit_id).first();
  const openingRow = from
    ? await db.prepare(`SELECT COALESCE(SUM(amount),0) AS opening FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0 AND entry_date < ?`).bind(customerId, String(from).slice(0, 10)).first()
    : { opening: 0 };

  const opening = round2(Number(openingRow.opening) || 0);
  let running = opening;
  const lines = rows.results.map((r) => {
    running = round2(running + Number(r.amount));
    return {
      date: r.entry_date, type: r.entry_type, reference: r.reference, source_type: r.source_type,
      debit: Number(r.amount) > 0 ? round2(r.amount) : 0,
      credit: Number(r.amount) < 0 ? round2(-r.amount) : 0,
      balance: running, branch_name: r.branch_name, notes: r.notes,
    };
  });

  return {
    business,
    customer: {
      id: c.id, full_name: c.full_name, company_name: c.company_name, address: c.address,
      phone_national: c.phone_national, email: c.email, customer_type: c.customer_type,
      tin: c.tin, rc_number: c.rc_number, credit_limit: round2(Number(c.credit_limit) || 0), credit_days: c.credit_days,
    },
    period: { from: from || null, to: to || watDate() },
    opening_balance: opening,
    lines,
    total_debits: round2(sumMoney(lines.map((l) => l.debit))),
    total_credits: round2(sumMoney(lines.map((l) => l.credit))),
    closing_balance: running,
    generated_at: watNowIso(),
  };
}

module.exports = {
  CUSTOMER_TYPES, ID_TYPES,
  create, update, get, list, agingReport, recordPayment, statement,
};
'use strict';
