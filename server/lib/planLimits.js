// =====================================================================
// StockRidge — PLAN LIMITS & SUBSCRIPTION GATE
// =====================================================================
// Ported from PharmaRidge's lib/planLimits.js, including the bug it
// records, because the bug is a billing-model contradiction rather than a
// pharmacy detail:
//
//   BUG 85 — A CLOSED BRANCH KEPT CONSUMING A PAID SLOT.
//   The branch count included deactivated branches while the staff count
//   filtered on is_active. The two halves of the same billing model
//   contradicted each other: deactivating a staff member immediately freed
//   their seat, but closing a branch freed nothing, so a business that shut
//   one shop could not open a replacement without buying an upgrade.
//   Both counts now filter on is_active. v_plan_usage agrees with them.
//
// Enforcement is fail-CLOSED on limits (a suspended client must not keep
// trading on someone else's licence) but fail-OPEN on a missing settings
// row (a freshly-migrated database must never brick the client's whole
// system because one row is absent). Those two postures look inconsistent
// and are not: one protects the vendor's revenue, the other protects the
// client's ability to open the shop.
// =====================================================================

const { HttpError } = require('./http');

const DEFAULT_SETTINGS = Object.freeze({
  max_branches: 5, max_staff: 25, max_products: 5000,
  subscription_status: 'ACTIVE', subscription_plan: 'Standard', subscription_renewal_date: null,
  multi_branch_enabled: 1, instalment_module_enabled: 1, layaway_module_enabled: 1,
  delivery_module_enabled: 1, warranty_module_enabled: 1, wholesale_tier_enabled: 1,
  attendance_module_enabled: 1, compliance_register_enabled: 1, gl_module_enabled: 1,
  offline_sync_enabled: 1,
  vat_enabled: 0, vat_rate_percent: 7.5, vat_inclusive_pricing: 1, wht_enabled: 0,
  managers_can_void_sales: 1, managers_can_approve_expenses: 1, managers_can_edit_prices: 1,
  managers_can_grant_credit: 1, managers_can_override_credit_limit: 1, managers_can_discount: 1,
  max_discount_percent: 25,
  staff_can_void_sales: 1, staff_void_window_minutes: 15,
  staff_can_adjust_stock: 1, staff_adjustment_max_units: 5,
  staff_can_discount: 0, staff_max_discount_percent: 5,
  staff_can_take_credit_sale: 0,
  staff_can_spend_from_safe: 1, staff_safe_spend_max: 20000,
  staff_can_create_delivery_job: 1,
});

async function getUnitSettings(db, businessUnitId) {
  const row = await db.prepare('SELECT * FROM business_units WHERE id = ? AND is_deleted = 0').bind(businessUnitId).first();
  if (!row) return { ...DEFAULT_SETTINGS, id: null, missing: true };
  return { ...DEFAULT_SETTINGS, ...row, missing: false };
}

function contactLine(settings) {
  const parts = [];
  if (settings.admin_contact_name) parts.push(settings.admin_contact_name);
  if (settings.admin_contact_phone) parts.push(`phone: ${settings.admin_contact_phone}`);
  if (settings.admin_contact_email) parts.push(`email: ${settings.admin_contact_email}`);
  return parts.length ? parts.join(', ') : 'StockRidge support';
}

// ACTIVE branches and ACTIVE staff only — see BUG 85 above. ADMIN seats are
// vendor seats and never consume a client's paid slot.
async function activeBranchCount(db, businessUnitId) {
  const row = await db.prepare(
    'SELECT COUNT(*) AS n FROM branches WHERE business_unit_id = ? AND is_active = 1 AND is_deleted = 0'
  ).bind(businessUnitId).first();
  return (row && row.n) || 0;
}

async function activeStaffCount(db, businessUnitId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM users
     WHERE business_unit_id = ? AND role <> 'ADMIN' AND is_active = 1 AND is_deleted = 0`
  ).bind(businessUnitId).first();
  return (row && row.n) || 0;
}

async function productCount(db, businessUnitId) {
  const row = await db.prepare(
    'SELECT COUNT(*) AS n FROM products WHERE business_unit_id = ? AND is_deleted = 0'
  ).bind(businessUnitId).first();
  return (row && row.n) || 0;
}

// The subscription gate. ADMIN always bypasses: the vendor must never be
// locked out of their own client's instance, including the instance they
// need to reach in order to un-suspend it.
function assertSubscribed(settings, user, { action = 'continue' } = {}) {
  if (user && String(user.role).toUpperCase() === 'ADMIN') return true;
  const status = String(settings.subscription_status || 'ACTIVE').toUpperCase();
  if (status === 'ACTIVE' || status === 'TRIAL') return true;
  const message = status === 'SUSPENDED'
    ? `This business account is suspended, so you cannot ${action}. Please contact ${contactLine(settings)}.`
    : `This business subscription has expired, so you cannot ${action}. Please contact ${contactLine(settings)} to renew.`;
  throw new HttpError(402, message, status === 'SUSPENDED' ? 'SUBSCRIPTION_SUSPENDED' : 'SUBSCRIPTION_EXPIRED');
}

async function assertCanCreateBranch(db, businessUnitId, user) {
  const settings = await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, user, { action: 'add a branch' });
  if (!settings.multi_branch_enabled) {
    const used = await activeBranchCount(db, businessUnitId);
    if (used >= 1) {
      throw new HttpError(402, 'Your plan covers a single location. Contact ' + contactLine(settings) + ' to enable multi-branch.', 'MULTI_BRANCH_NOT_ENABLED');
    }
  }
  const used = await activeBranchCount(db, businessUnitId);
  if (used >= settings.max_branches) {
    throw new HttpError(402,
      `Your plan allows ${settings.max_branches} branch${settings.max_branches === 1 ? '' : 'es'} and all ${used} are in use. `
      + `Deactivate a closed branch to free a slot, or contact ${contactLine(settings)} to upgrade.`,
      'BRANCH_LIMIT_REACHED');
  }
  return { used, max: settings.max_branches };
}

async function assertCanCreateUser(db, businessUnitId, user, { role = 'STAFF' } = {}) {
  const settings = await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, user, { action: 'add a staff member' });
  if (String(role).toUpperCase() === 'ADMIN') return { used: 0, max: settings.max_staff };  // vendor seat
  const used = await activeStaffCount(db, businessUnitId);
  if (used >= settings.max_staff) {
    throw new HttpError(402,
      `Your plan allows ${settings.max_staff} staff and all ${used} seats are in use. `
      + `Deactivate a departed staff member to free a seat, or contact ${contactLine(settings)} to upgrade.`,
      'STAFF_LIMIT_REACHED');
  }
  return { used, max: settings.max_staff };
}

async function assertCanCreateProduct(db, businessUnitId, user) {
  const settings = await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, user, { action: 'add a product' });
  const used = await productCount(db, businessUnitId);
  if (used >= settings.max_products) {
    throw new HttpError(402,
      `Your plan allows ${settings.max_products.toLocaleString('en-NG')} products and the catalogue is full at ${used.toLocaleString('en-NG')}. `
      + `Discontinue unused products or contact ${contactLine(settings)} to upgrade.`,
      'PRODUCT_LIMIT_REACHED');
  }
  return { used, max: settings.max_products };
}

// ---------------------------------------------------------------------
// OWNER-CONTROLLED PERMISSIONS
// ---------------------------------------------------------------------
// These are the client's own governance switches over what their managers
// and cashiers may do. OWNER and ADMIN are NEVER restricted by them: a
// switch that could lock the proprietor out of their own books is a footgun.
async function assertManagerPermission(db, businessUnitId, user, permission, { action } = {}) {
  if (!user) throw new HttpError(401, 'Sign in to continue.', 'UNAUTHENTICATED');
  const role = String(user.role).toUpperCase();
  if (role === 'ADMIN' || role === 'OWNER') return true;
  if (role !== 'MANAGER') {
    // A cashier asking for a manager-only permission gets the staff answer,
    // not a confusing "your manager may not do this either".
    throw new HttpError(403, action ? `You cannot ${action} — a manager must do that.` : 'A manager must do that.', 'ROLE_FORBIDDEN');
  }
  const settings = await getUnitSettings(db, businessUnitId);
  if (settings[permission] === 0) {
    throw new HttpError(403,
      action
        ? `Managers are not permitted to ${action} in this business. The owner can change that under My Plan → Manager permissions.`
        : 'Managers are not permitted to do that in this business. The owner can change that under My Plan.',
      'MANAGER_PERMISSION_DISABLED');
  }
  return true;
}

// The staff allowances. Returns what the cashier MAY do rather than throwing,
// because the useful answer is usually "you can, up to ₦X / within Y minutes"
// and the caller then decides.
async function staffAllowance(db, businessUnitId, user) {
  const s = await getUnitSettings(db, businessUnitId);
  const role = String((user && user.role) || '').toUpperCase();
  const unrestricted = role === 'ADMIN' || role === 'OWNER' || role === 'MANAGER';
  return {
    role,
    can_void_sales: unrestricted ? true : !!s.staff_can_void_sales,
    void_window_minutes: Number(s.staff_void_window_minutes || 0),
    can_adjust_stock: unrestricted ? true : !!s.staff_can_adjust_stock,
    adjustment_max_units: unrestricted ? Infinity : Number(s.staff_adjustment_max_units || 0),
    can_discount: unrestricted ? !!s.managers_can_discount : !!s.staff_can_discount,
    max_discount_percent: unrestricted ? Number(s.max_discount_percent || 0) : Number(s.staff_max_discount_percent || 0),
    can_take_credit_sale: unrestricted ? !!s.managers_can_grant_credit : !!s.staff_can_take_credit_sale,
    can_spend_from_safe: unrestricted ? true : !!s.staff_can_spend_from_safe,
    // 0 means NO CAP by deliberate design, never "nothing allowed".
    safe_spend_max: Number(s.staff_safe_spend_max || 0) === 0 ? Infinity : Number(s.staff_safe_spend_max),
    can_create_delivery_job: unrestricted ? true : !!s.staff_can_create_delivery_job,
    can_grant_credit: unrestricted ? !!s.managers_can_grant_credit : false,
    can_override_credit_limit: role === 'ADMIN' || role === 'OWNER' ? true : !!s.managers_can_override_credit_limit,
    can_edit_prices: unrestricted ? !!s.managers_can_edit_prices : false,
    can_approve_expenses: unrestricted ? !!s.managers_can_approve_expenses : false,
  };
}

// Enforce one specific staff allowance and throw a message that says what
// the limit IS, because "you are not allowed" at a busy counter produces a
// phone call to the owner, whereas "up to 5 units, ask a manager beyond
// that" produces the right next action.
async function assertStaffCanAdjust(db, businessUnitId, user, quantityUnits) {
  const a = await staffAllowance(db, businessUnitId, user);
  if (a.can_adjust_stock) {
    const abs = Math.abs(Number(quantityUnits) || 0);
    if (abs <= a.adjustment_max_units) return true;
    throw new HttpError(403,
      `A write-off of ${abs.toLocaleString('en-NG')} unit${abs === 1 ? '' : 's'} is above your limit of ${a.adjustment_max_units.toLocaleString('en-NG')}. `
      + 'A manager must approve and post it.', 'STAFF_ADJUSTMENT_OVER_LIMIT');
  }
  throw new HttpError(403, 'Stock adjustments need a manager in this business. Ask one to post it.', 'STAFF_ADJUSTMENT_NOT_PERMITTED');
}

async function assertStaffCanVoid(db, businessUnitId, user, sale) {
  const a = await staffAllowance(db, businessUnitId, user);
  if (a.can_void_sales) {
    // Three conditions make the narrow allowance safe: it is THEIR sale,
    // it is within the window, and the till is still open. Together they
    // cover "I just rang that up wrong" without covering "I am reversing
    // yesterday's takings".
    if (sale && sale.sold_by !== user.id) {
      throw new HttpError(403, 'You can only void a sale you rang up yourself. Ask the cashier who made it, or a manager.', 'VOID_NOT_OWN_SALE');
    }
    const windowMs = a.void_window_minutes * 60000;
    if (sale && sale.occurred_at && Number.isFinite(windowMs)) {
      const at = Date.parse(String(sale.occurred_at).replace(' ', 'T') + (String(sale.occurred_at).endsWith('Z') ? '' : 'Z'));
      if (Number.isFinite(at) && (Date.now() - at) > windowMs) {
        throw new HttpError(403,
          `That sale is outside your ${a.void_window_minutes}-minute correction window. A manager can still void it.`,
          'VOID_WINDOW_EXPIRED');
      }
    }
    return true;
  }
  throw new HttpError(403, 'Voiding a sale needs a manager in this business.', 'STAFF_VOID_NOT_PERMITTED');
}

async function assertCanDiscount(db, businessUnitId, user, discountPercent) {
  const a = await staffAllowance(db, businessUnitId, user);
  const pct = Math.abs(Number(discountPercent) || 0);
  if (!a.can_discount && pct > 0) {
    throw new HttpError(403, 'Discounting is not enabled for your role in this business. Ask a manager.', 'DISCOUNT_NOT_PERMITTED');
  }
  if (pct > a.max_discount_percent) {
    throw new HttpError(403,
      `A ${pct}% discount is above your limit of ${a.max_discount_percent}%. A manager can approve a larger one up to the business maximum.`,
      'DISCOUNT_OVER_LIMIT');
  }
  return true;
}

// The "My Plan" payload: usage against limits, so the owner can see a slot
// is nearly gone before the day they need it.
async function planSummary(db, businessUnitId) {
  const s = await getUnitSettings(db, businessUnitId);
  const [branchesUsed, staffUsed, productsUsed] = await Promise.all([
    activeBranchCount(db, businessUnitId),
    activeStaffCount(db, businessUnitId),
    productCount(db, businessUnitId),
  ]);
  return {
    business_unit_id: businessUnitId,
    plan: s.subscription_plan,
    status: s.subscription_status,
    renewal_date: s.subscription_renewal_date,
    support_contact: contactLine(s),
    limits: {
      branches: { used: branchesUsed, max: s.max_branches, remaining: Math.max(0, s.max_branches - branchesUsed) },
      staff: { used: staffUsed, max: s.max_staff, remaining: Math.max(0, s.max_staff - staffUsed) },
      products: { used: productsUsed, max: s.max_products, remaining: Math.max(0, s.max_products - productsUsed) },
    },
    modules: {
      multi_branch: !!s.multi_branch_enabled,
      instalments: !!s.instalment_module_enabled,
      layaway: !!s.layaway_module_enabled,
      delivery: !!s.delivery_module_enabled,
      warranty: !!s.warranty_module_enabled,
      wholesale_tiers: !!s.wholesale_tier_enabled,
      attendance: !!s.attendance_module_enabled,
      compliance_register: !!s.compliance_register_enabled,
      general_ledger: !!s.gl_module_enabled,
      offline_sync: !!s.offline_sync_enabled,
    },
    tax: {
      vat_enabled: !!s.vat_enabled,
      vat_rate_percent: Number(s.vat_rate_percent),
      vat_inclusive_pricing: !!s.vat_inclusive_pricing,
      vat_registration_no: s.vat_registration_no || null,
      wht_enabled: !!s.wht_enabled,
    },
  };
}

module.exports = {
  DEFAULT_SETTINGS, getUnitSettings, contactLine,
  activeBranchCount, activeStaffCount, productCount,
  assertSubscribed, assertCanCreateBranch, assertCanCreateUser, assertCanCreateProduct,
  assertManagerPermission, staffAllowance, assertStaffCanAdjust, assertStaffCanVoid,
  assertCanDiscount, planSummary,
};
'use strict';
