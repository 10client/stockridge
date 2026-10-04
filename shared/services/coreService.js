// =====================================================================
// shared/services/coreService.js — COUNTERS, SETTINGS, AUDIT, NOTIFICATIONS
// =====================================================================
// Shared by both backends. Everything here is adapter-agnostic: it only uses
// the db.prepare(...).bind(...).first()/all()/run() shape and db.transaction().

'use strict';

const { newId, docNumber, claimCode } = require('../lib/ids');
const { todayWat } = require('../lib/timegeo');
const { toKobo, fromKobo } = require('../lib/money');
const VERTICALS = require('../lib/verticals');

// ---------------------------------------------------------------------
// CLIENT SETTINGS
// ---------------------------------------------------------------------
// Fail-open defaults that match the migration's column defaults, so a missing
// settings row never bricks every request in the app.
const DEFAULT_VAT_RATE_PERCENTAGE = 7.5;

const DEFAULT_SETTINGS = Object.freeze({
  id: 1,
  product_name: 'StockRidge',
  logo_data_url: null,
  max_businesses: 3, max_branches: 5, max_staff: 25,
  subscription_status: 'ACTIVE', subscription_plan: 'Standard', subscription_renewal_date: null,
  attendance_module_enabled: 1, multi_business_enabled: 1, multi_branch_enabled: 1,
  instalments_module_enabled: 1, warranty_module_enabled: 1, delivery_module_enabled: 1,
  accounting_module_enabled: 1, offline_sync_enabled: 1,
  default_vat_enabled: 0, default_vat_rate_percent: DEFAULT_VAT_RATE_PERCENTAGE,
  wht_company_size: 'SMALL', wht_enabled: 1,
  pos_fee_percent: 1.5, pos_fee_cap: 2000, pos_fee_configured: 1, pos_settlement_business_days: 1,
  fx_rate_bands_json: null, fx_enabled: 0,
  managers_can_void_sales: 1, managers_can_approve_expenses: 1, managers_can_edit_prices: 1,
  managers_can_override_price_floor: 1, managers_can_dispatch_unpaid: 0, managers_can_write_off_debt: 0,
  staff_can_void_sales: 1, staff_void_window_minutes: 15,
  staff_can_adjust_stock: 1, staff_adjustment_max_units: 5,
  staff_max_discount_percent: 5,
  price_floor_percent_of_cost: 100, max_discount_percent: 25,
  staff_can_spend_from_safe: 1, staff_safe_spend_max: 20000,
  credit_enabled: 1, credit_max_overdue_days: 30, credit_max_concentration_pct: 25, credit_requires_manager: 0,
  instalment_min_deposit_percent: 20, instalment_max_tenor_months: 24,
  instalment_grace_days: 7, instalment_missed_before_default: 3,
  instalment_late_fee_percent: 0, instalment_plan_fee_percent: 0,
  layaway_default_hold_days: 7, layaway_max_hold_days: 180, layaway_max_extensions: 3, layaway_forfeit_percent: 0,
  warranty_basis_default: 'SALE', warranty_provision_percent: 1.5,
  shelf_life_horizons_json: '[7,30,90]', bad_debt_provision_json: null,
  receipt_footer_text: null, receipt_show_pricing_trail: 1,
  require_delivery_proof: 1, require_payment_before_dispatch: 1,
});

async function getSettings(db) {
  const row = await db.prepare('SELECT * FROM client_settings WHERE id = 1').first();
  // Defensive merge: a column added by a later migration is present in the row;
  // a row that predates it is filled from the defaults. Never fail the request.
  return { ...DEFAULT_SETTINGS, ...(row || {}) };
}

/** Parse a JSON settings column, falling back rather than throwing. A settings
 *  value that cannot be parsed must not stop the POS from opening. */
function parseJsonColumn(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

async function updateSettings(db, changes, updatedBy) {
  const fields = Object.keys(changes || {});
  if (!fields.length) return getSettings(db);
  const sets = fields.map((f) => `${f} = ?`).join(', ');
  const params = fields.map((f) => changes[f]);
  params.push(updatedBy || null);
  await db.prepare(`UPDATE client_settings SET ${sets}, updated_at = datetime('now'), updated_by = ? WHERE id = 1`)
    .bind(...params).run();
  return getSettings(db);
}

// ---------------------------------------------------------------------
// BUSINESS PROFILE RESOLUTION
// ---------------------------------------------------------------------
// A vertical profile is DATA. These helpers are the only place the application
// reads one, so there is no `if (vertical === 'ELECTRONICS')` anywhere.
async function getBusiness(db, businessId) {
  return db.prepare('SELECT * FROM businesses WHERE id = ? AND is_deleted = 0').bind(String(businessId)).first();
}

async function getBusinessProfile(db, businessId) {
  const business = await getBusiness(db, businessId);
  if (!business) {
    const err = new Error('Business not found');
    err.status = 404; err.code = 'BUSINESS_NOT_FOUND';
    throw err;
  }
  const profile = VERTICALS.getProfile(business.vertical_code) || VERTICALS.GENERAL_PROFILE;
  const custom = parseJsonColumn(business.custom_categories_json, null);
  return { business, profile, customCategories: custom };
}

/** Which optional modules does this business actually use? Drives navigation and
 *  refuses flows the client has switched off, rather than showing empty screens. */
function businessModules(business) {
  return {
    serialTracking: !!business.uses_serial_tracking,
    warranty: !!business.uses_warranty,
    delivery: !!business.uses_delivery,
    installation: !!business.uses_installation,
    layaway: !!business.uses_layaway,
    instalments: !!business.uses_instalments,
    shelfLife: !!business.uses_shelf_life,
    credit: !!business.uses_credit,
    wholesale: !!business.uses_wholesale,
    fx: !!business.uses_fx,
  };
}

function assertModuleEnabled(business, moduleName, what) {
  const mods = businessModules(business);
  if (!mods[moduleName]) {
    const err = new Error(
      `${what || 'This feature'} is not enabled for ${business.name}. `
      + 'Turn it on from Settings → Business Profile.'
    );
    err.status = 409; err.code = 'MODULE_DISABLED';
    throw err;
  }
  return true;
}

/** The categories a business actually uses: its own rows, which were seeded from
 *  the vertical profile and may since have been renamed or extended. */
async function listCategories(db, businessId, { includeInactive = false } = {}) {
  const sql = `SELECT * FROM product_categories WHERE business_id = ? AND is_deleted = 0
               ${includeInactive ? '' : 'AND is_active = 1'} ORDER BY sort_order, name`;
  return db.prepare(sql).bind(String(businessId)).all();
}

async function getCategory(db, categoryId) {
  if (!categoryId) return null;
  return db.prepare('SELECT * FROM product_categories WHERE id = ? AND is_deleted = 0').bind(String(categoryId)).first();
}

/** Seed a new business's categories from its vertical profile. Done once, at
 *  creation: afterwards the rows are the client's own data and the profile is
 *  only a suggestion. */
async function seedCategoriesFromProfile(db, business, profile) {
  const rows = [];
  let order = 0;
  for (const c of profile.categories) {
    order += 1;
    rows.push({
      id: newId(),
      business_id: business.id,
      parent_id: null,
      code: c.code,
      name: c.label,
      vertical_code: profile.code,
      shelf_life_tracked: c.shelfLife ? 1 : 0,
      register_required: c.registerRequired ? 1 : 0,
      restriction_reason: c.restriction || profile.restrictionDefault || 'NONE',
      vat_exempt: c.vatExempt ? 1 : 0,
      sort_order: order,
    });
  }
  await db.transaction(async (tx) => {
    for (const r of rows) {
      tx.prepare(`INSERT INTO product_categories
        (id, business_id, parent_id, code, name, vertical_code, shelf_life_tracked, register_required,
         restriction_reason, vat_exempt, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(r.id, r.business_id, r.parent_id, r.code, r.name, r.vertical_code, r.shelf_life_tracked,
          r.register_required, r.restriction_reason, r.vat_exempt, r.sort_order).run();
    }
  });
  return rows;
}

// ---------------------------------------------------------------------
// DOCUMENT NUMBERS
// ---------------------------------------------------------------------
/**
 * Next sequential document number for (business, branch, type).
 *
 * MUST be called inside the caller's transaction. Two concurrent sales that each
 * read last_number = 416 and each write 417 produce two invoices with the same
 * number — and the UNIQUE index then rejects the second sale at the worst
 * possible moment, mid-queue. Inside one transaction the read and the write are
 * atomic with respect to the rest of the database.
 *
 * GAP-FREE WITHIN A SERIES on purpose: an invoice series with gaps is a tax-audit
 * red flag that invites a closer look at everything else.
 */
async function nextDocNumber(db, { businessId, branchId, docType, prefix = null, padStart = 6 }) {
  const existing = await db.prepare(
    'SELECT * FROM document_counters WHERE business_id = ? AND branch_id = ? AND doc_type = ?'
  ).bind(String(businessId), String(branchId), String(docType)).first();

  const next = (existing ? Number(existing.last_number) || 0 : 0) + 1;
  const tag = prefix || (await branchTag(db, branchId)) || docType.slice(0, 3);

  if (existing) {
    await db.prepare(
      `UPDATE document_counters SET last_number = ?, prefix = ?, updated_at = datetime('now')
        WHERE business_id = ? AND branch_id = ? AND doc_type = ?`
    ).bind(next, tag, String(businessId), String(branchId), String(docType)).run();
  } else {
    await db.prepare(
      `INSERT INTO document_counters (id, business_id, branch_id, doc_type, last_number, prefix, updated_at)
       VALUES (?,?,?,?,?,?, datetime('now'))`
    ).bind(newId(), String(businessId), String(branchId), String(docType), next, tag).run();
  }
  const n = String(next).padStart(padStart, '0');
  return { number: docNumber(docPrefixFor(docType), tag, n), seq: next, raw: n };
}

function docPrefixFor(docType) {
  const map = {
    SALE: 'SR', RECEIPT: 'RCT', PO: 'PO', GRN: 'GRN', RETURN: 'RTN', DELIVERY: 'DLV',
    TRANSFER: 'TRF', QUOTE: 'QTE', CREDIT_NOTE: 'CN', STOCKTAKE: 'STK', VOUCHER: 'VCH',
  };
  return map[String(docType).toUpperCase()] || String(docType).slice(0, 3).toUpperCase();
}

async function branchTag(db, branchId) {
  const b = await db.prepare('SELECT code, name FROM branches WHERE id = ?').bind(String(branchId)).first();
  if (!b) return null;
  if (b.code) return String(b.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  // Derive a stable tag from the name when no code was set, so document numbers
  // stay readable instead of falling back to the doc type.
  const initials = String(b.name).split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (initials || 'BR').slice(0, 4);
}

/** An unguessable claim code for change-owed and layaway. */
function newClaimCode(len = 8) { return claimCode(len); }

// ---------------------------------------------------------------------
// AUDIT LOG
// ---------------------------------------------------------------------
/**
 * Record an audit entry. NEVER THROWS.
 *
 * An audit write that can fail the operation it is auditing is worse than no
 * audit at all: it turns "record that the manager overrode the price floor" into
 * "the manager cannot override the price floor because the log table is locked",
 * which is a shop-floor outage caused by a bookkeeping feature.
 */
async function audit(db, entry) {
  try {
    await db.prepare(`
      INSERT INTO audit_log
        (id, business_id, branch_id, user_id, user_role, action, entity_type, entity_id,
         before_json, after_json, reason, approved_by, ip_address, user_agent, device_id, severity, occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    `).bind(
      newId(),
      entry.businessId || null,
      entry.branchId || null,
      entry.userId || null,
      entry.userRole || null,
      String(entry.action || 'UNKNOWN'),
      String(entry.entityType || 'unknown'),
      entry.entityId || null,
      entry.before != null ? JSON.stringify(entry.before) : null,
      entry.after != null ? JSON.stringify(entry.after) : null,
      entry.reason ? String(entry.reason).slice(0, 1000) : null,
      entry.approvedBy || null,
      entry.ipAddress ? String(entry.ipAddress).slice(0, 60) : null,
      entry.userAgent ? String(entry.userAgent).slice(0, 220) : null,
      entry.deviceId ? String(entry.deviceId).slice(0, 64) : null,
      String(entry.severity || 'INFO')
    ).run();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[audit] could not record entry:', e && e.message, entry && entry.action);
  }
}

/** A price override above the threshold is chained, not merely logged, because
 *  it is one of the two ways a till can be robbed without a void. */
async function auditPriceOverride(db, { business, branchId, userId, productId, oldPrice, newPrice, reason, deviceId }) {
  return audit(db, {
    businessId: business.id, branchId, userId,
    action: 'PRICE_OVERRIDE', entityType: 'product', entityId: productId,
    before: { price: oldPrice }, after: { price: newPrice },
    reason, deviceId, severity: 'WARNING',
  });
}

// ---------------------------------------------------------------------
// SUBSCRIPTION / PLAN LIMITS
// ---------------------------------------------------------------------
// Counts ACTIVE rows only. A deactivated staff member frees their seat
// immediately and a closed branch frees its slot; counting inactive rows would
// bill a client for a shop they shut and a cashier who left. A half-implemented
// version of this had exactly that contradiction: deactivating a staff member
// freed the seat, but closing a branch freed nothing, so a pharmacy that shut one
// shop could not open a replacement without buying an upgrade.
async function countUsage(db) {
  const [b, br, u] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS c FROM businesses WHERE is_active = 1 AND is_deleted = 0').first(),
    db.prepare('SELECT COUNT(*) AS c FROM branches WHERE is_active = 1 AND is_deleted = 0').first(),
    // ADMIN is the vendor seat: not part of the client's staff and never counted
    // against their limit.
    db.prepare(`SELECT COUNT(*) AS c FROM users
                 WHERE role != 'ADMIN' AND is_active = 1 AND is_deleted = 0`).first(),
  ]);
  return {
    businesses: (b && b.c) || 0,
    branches: (br && br.c) || 0,
    staff: (u && u.c) || 0,
  };
}

async function getPlanUsage(db) {
  const [settings, usage] = await Promise.all([getSettings(db), countUsage(db)]);
  return {
    ...usage,
    businesses_allowed: settings.max_businesses,
    branches_allowed: settings.max_branches,
    staff_allowed: settings.max_staff,
    subscription_status: settings.subscription_status,
    subscription_plan: settings.subscription_plan,
    renewal_date: settings.subscription_renewal_date,
    at_limit: {
      businesses: usage.businesses >= settings.max_businesses,
      branches: usage.branches >= settings.max_branches,
      staff: usage.staff >= settings.max_staff,
    },
  };
}

class SubscriptionGateError extends Error {
  constructor(message, code) {
    super(message);
    this.status = 402;
    this.code = code || 'SUBSCRIPTION_REQUIRED';
  }
}

/**
 * Block writes when the subscription is not active.
 *
 * READS ARE NOT BLOCKED. A client whose payment bounced must still be able to
 * see their own stock, their debtors and their sales history — that is the data
 * they need in order to keep trading while they sort out the invoice, and it is
 * the data they would take to a competitor if they could not. Locking reads is
 * how a billing problem becomes a churned customer.
 *
 * ADMIN always bypasses, so the vendor can never be locked out of their own
 * client's instance while trying to fix exactly this situation.
 */
async function assertSubscriptionAllowsWrites(db, scope, settings = null) {
  if (scope && scope.isVendor) return true;
  const s = settings || await getSettings(db);
  const status = String(s.subscription_status || 'ACTIVE').toUpperCase();
  if (status === 'ACTIVE' || status === 'TRIAL') return true;
  if (status === 'SUSPENDED') {
    throw new SubscriptionGateError(
      `This subscription is SUSPENDED, so records can be viewed but not changed. `
      + `Contact ${supportLine(s)} to restore it.`,
      'SUBSCRIPTION_SUSPENDED'
    );
  }
  throw new SubscriptionGateError(
    `This subscription has ${status.toLowerCase()}${s.subscription_renewal_date ? ` (renewal was due ${s.subscription_renewal_date})` : ''}. `
    + `Records can still be viewed. Contact ${supportLine(s)} to renew.`,
    'SUBSCRIPTION_EXPIRED'
  );
}

function supportLine(settings) {
  const parts = [];
  if (settings.support_contact_name) parts.push(settings.support_contact_name);
  if (settings.support_contact_phone) parts.push(`phone: ${settings.support_contact_phone}`);
  if (settings.support_contact_email) parts.push(settings.support_contact_email);
  return parts.length ? parts.join(', ') : `${settings.product_name || 'StockRidge'} support`;
}

/** Enforce a hard plan cap BEFORE the row is created, with a message that says
 *  what to do about it rather than just "no". */
async function assertUnderLimit(db, kind, settings = null) {
  const s = settings || await getSettings(db);
  const usage = await countUsage(db);
  const map = {
    business: { used: usage.businesses, max: s.max_businesses, label: 'business', portal: 'Ask your account manager to raise the business limit.' },
    branch: { used: usage.branches, max: s.max_branches, label: 'branch', portal: 'Upgrade the plan, or deactivate a closed branch to free its slot.' },
    staff: { used: usage.staff, max: s.max_staff, label: 'staff member', portal: 'Upgrade the plan, or deactivate a leaver to free their seat.' },
  };
  const m = map[kind];
  if (!m) return true;
  if (m.max != null && m.used >= m.max) {
    const err = new Error(
      `Your plan allows ${m.max} ${m.label}${m.max === 1 ? '' : 's'} and ${m.used} ${m.used === 1 ? 'is' : 'are'} already active. ${m.portal}`
    );
    err.status = 402; err.code = `PLAN_LIMIT_${kind.toUpperCase()}`;
    throw err;
  }
  return true;
}

function assertFeatureEnabled(settings, feature, what) {
  if (Number(settings[feature]) === 1) return true;
  const err = new Error(`${what || 'This feature'} is not included in the ${settings.subscription_plan || 'current'} plan.`);
  err.status = 402; err.code = 'FEATURE_NOT_IN_PLAN';
  throw err;
}

// ---------------------------------------------------------------------
// FX  (rates are looked up, never assumed)
// ---------------------------------------------------------------------
/** The most recent rate for a currency from a preferred source list. */
async function lookupFxRate(db, { currency, source = null, businessId = null, asOf = null }) {
  const cur = String(currency || 'NGN').toUpperCase();
  if (cur === 'NGN') return { rate: 1, currency: 'NGN', source: null, rate_date: todayWat() };

  const date = asOf || todayWat();
  const sources = source ? [String(source).toUpperCase()] : ['AGREED', 'BANK', 'CBN_OFFICIAL', 'NAFEM', 'PARALLEL', 'SUPPLIER', 'MANUAL'];
  for (const src of sources) {
    // A deal rate specific to this business wins over published reference data.
    const scoped = await db.prepare(`
      SELECT * FROM fx_rates
       WHERE currency = ? AND source = ? AND is_deleted = 0
         AND rate_date <= ? AND (business_id = ? OR business_id IS NULL)
       ORDER BY (business_id IS NULL), rate_date DESC, created_at DESC LIMIT 1
    `).bind(cur, src, date, businessId || '__none__').first();
    if (scoped) {
      return { rate: Number(scoped.rate), currency: cur, source: scoped.source, rate_date: scoped.rate_date, fx_rate_id: scoped.id };
    }
  }
  return null;
}

async function fxRateBands(settings) {
  const parsed = parseJsonColumn(settings.fx_rate_bands_json, null);
  if (parsed && typeof parsed === 'object') return parsed;
  // Sane published bands so a rate typed the wrong way round is caught even
  // before the client configures anything. Wide on purpose: this is a typo trap,
  // not a market view.
  return { USD: { min: 300, max: 5000 }, GBP: { min: 400, max: 7000 }, EUR: { min: 350, max: 6000 }, CNY: { min: 40, max: 900 } };
}

// ---------------------------------------------------------------------
// PUBLIC HOLIDAYS
// ---------------------------------------------------------------------
async function listHolidays(db, { year = null, stateCode = null } = {}) {
  const params = [];
  let sql = 'SELECT * FROM public_holidays WHERE is_deleted = 0';
  if (year) { sql += ' AND year = ?'; params.push(Number(year)); }
  if (stateCode) { sql += ' AND (state_code = ? OR state_code IS NULL)'; params.push(String(stateCode)); }
  sql += ' ORDER BY holiday_date';
  return db.prepare(sql).bind(...params).all();
}

async function holidayDates(db, { year = null, stateCode = null } = {}) {
  const rows = await listHolidays(db, { year, stateCode });
  return rows.filter((r) => Number(r.banks_closed) === 1).map((r) => String(r.holiday_date).slice(0, 10));
}

module.exports = {
  DEFAULT_SETTINGS, getSettings, updateSettings, parseJsonColumn,
  getBusiness, getBusinessProfile, businessModules, assertModuleEnabled,
  listCategories, getCategory, seedCategoriesFromProfile,
  nextDocNumber, docPrefixFor, branchTag, newClaimCode,
  audit, auditPriceOverride,
  countUsage, getPlanUsage, assertSubscriptionAllowsWrites, assertUnderLimit,
  assertFeatureEnabled, supportLine, SubscriptionGateError,
  lookupFxRate, fxRateBands, listHolidays, holidayDates,
  toKobo, fromKobo, newId,
};
