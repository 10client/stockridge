'use strict';
// =====================================================================
// domain/planLimits.js — SUBSCRIPTION GATE AND PERMISSION SWITCHES
// =====================================================================
// THREE ENFORCEMENT MECHANISMS, AND WHY THEY ARE SEPARATE
//
// 1. HARD CAPS  (max_businesses / max_branches / max_staff)
//    Counted against ACTIVE rows only, and enforced on CREATE. A cap that
//    counted deactivated rows would mean a business that closed a shop
//    could not open a replacement without buying an upgrade — a real bug,
//    reproduced live, where deactivating a staff member freed their seat
//    but closing a branch freed nothing. The two halves of the same
//    billing model must not contradict each other.
//
// 2. FEATURE TOGGLES  (attendance, warranty, instalments, delivery,
//    multi-branch, multi-business, serial tracking, offline sync)
//    Vendor-owned plan features. ADMIN sets them; OWNER can see them.
//    A disabled feature returns 403 FEATURE_NOT_ON_PLAN with a message that
//    names the contact to talk to — not a bare "forbidden", because the
//    person hitting it is a cashier who has no idea what a plan is.
//
// 3. PERMISSION SWITCHES  (managers_can_*, staff_can_*)
//    CLIENT-owned governance, set by the OWNER. These are deliberately NOT
//    a flat ban on cashiers. A mis-keyed sale at a busy counter is common
//    and a lone cashier on a night shift must be able to correct it, so the
//    default is a NARROW ALLOWANCE — own sale, within a time window, while
//    the till is open — rather than "off". The window and the cap are what
//    make it safe: they cover "I just rang that up wrong" and "I dropped a
//    box" without covering "I am reversing yesterday's takings" or "a whole
//    pallet was damaged".
//
// FAIL-OPEN ON A MISSING SETTINGS ROW. A freshly migrated database always
// inserts this row, but if it were somehow missing we must never fail every
// request in the app. Generous defaults rather than bricking the client's
// entire system mid-trade.
// =====================================================================

const { ROLES } = require('./roles');

const DEFAULT_SETTINGS = Object.freeze({
  id: 1,
  business_name: null, logo_data_url: null, primary_business_id: null,
  max_businesses: 3, max_branches: 5, max_staff: 25,
  subscription_status: 'ACTIVE', subscription_plan: 'Standard', subscription_renewal_date: null,
  attendance_module_enabled: 1, warranty_module_enabled: 1, instalment_module_enabled: 1,
  delivery_module_enabled: 1, multi_branch_enabled: 1, multi_business_enabled: 1,
  serial_tracking_enabled: 1, offline_sync_enabled: 1,
  vat_enabled: 0, vat_rate_percent: 7.5,
  managers_can_void_sales: 1, managers_can_approve_expenses: 1, managers_can_edit_prices: 1,
  managers_can_override_credit_limit: 1,
  staff_can_void_sales: 1, staff_void_window_minutes: 15,
  staff_can_adjust_stock: 1, staff_adjustment_max_units: 5, staff_can_adjust_stock_value: 50000,
  staff_can_sell_on_credit: 0, staff_credit_max: 0, staff_discount_max_pct: 5,
  staff_can_spend_from_safe: 1, staff_safe_spend_max: 20000,
  instalment_max_interest_pct: 25, instalment_max_tenure_months: 12, instalment_min_deposit_pct: 20,
  credit_max_days: 60, layaway_max_days: 90, layaway_min_deposit_pct: 20,
  change_owed_expiry_days: 30, return_window_days_default: 7,
  // THE THREE THAT WERE READ BUT COULD NOT BE SET. `domain/credit.js` and
  // `domain/instalments.js` have read these out of the settings object since the
  // modulo landed — `Number(settings.credit_grace_days) || 0`,
  // `Number(settings.instalment_default_after_days) || 60`,
  // `Number(settings.instalment_default_after_missed) || 3` — and no column
  // existed, so the fallback always won and an owner had no way to move any of
  // them. They are real columns now (migration 0003) and real controls on the
  // Settings screen. The defaults below are the same numbers the code was already
  // falling back to, so nothing changes until somebody chooses.
  credit_grace_days: 0,
  instalment_default_after_days: 60,
  instalment_default_after_missed: 3,
  low_stock_alert_enabled: 1, expiry_alert_days: 60, compliance_alert_days: 30,
  // The receipt footer is a real client_settings column that `server/routes/branding.js`
  // could write and this whitelist could not, so the Settings screen had no way to set
  // the one string every customer reads. It is settable from both doors now; the
  // settings route audits it, and an audit trail is the point.
  receipt_footer_text: null,
  admin_contact_name: null, admin_contact_phone: null, admin_contact_email: null, notes: null,
});

/**
 * WHICH SETTINGS ARE FLAGS, NAMED RATHER THAN GUESSED.
 *
 * The settings route used to infer this from the DEFAULT: `[0, 1].includes(def)`
 * meant "this is a boolean". That is true for a flag and false for any NUMBER whose
 * sensible default is zero — and there are two:
 *
 *   credit_grace_days   how many days a debtor may be late before the counter warns
 *   staff_credit_max    the naira cap a cashier may extend on credit
 *
 * So `credit_grace_days: 30` was validated as a flag, `boolField(30, 0)` did not
 * recognise `30` as a boolean and returned the fallback, and the setting saved as
 * ZERO with a success message. An owner setting a thirty-day grace period got a
 * system that warned on the first day late, and nothing said so.
 *
 * A flag is a decision about behaviour; a number is a judgement about the business.
 * They are not distinguishable by their default, so they are listed. The test
 * `test/unit/settings-controls.test.js` fails if a setting whose default is 0 or 1
 * is neither a flag here nor a documented number, so a new one cannot slip in.
 */
const FLAG_SETTINGS = Object.freeze(new Set([
  'attendance_module_enabled', 'warranty_module_enabled', 'instalment_module_enabled',
  'delivery_module_enabled', 'multi_branch_enabled', 'multi_business_enabled',
  'serial_tracking_enabled', 'offline_sync_enabled',
  'vat_enabled',
  'managers_can_void_sales', 'managers_can_approve_expenses', 'managers_can_edit_prices',
  'managers_can_override_credit_limit',
  'staff_can_void_sales', 'staff_can_adjust_stock', 'staff_can_sell_on_credit',
  'staff_can_spend_from_safe',
  'low_stock_alert_enabled',
]));

// Feature toggle name -> settings column. One mapping so a new module is a
// one-line change rather than a new bespoke check in each route.
/**
 * THE COMMERCIAL SETTINGS — the six keys that decide what the client has bought.
 *
 * They live in the same `client_settings` row as the VAT rate and the receipt footer,
 * and they are written through the same route, but they are not the client's to
 * change: a cap that its own subject can raise is not a cap, and a subscription
 * status its own subject can reset is not a status. The screen has always drawn
 * them read-only; this list is what makes the API say no as well.
 */
const PLAN_FIELDS = Object.freeze([
  'max_businesses', 'max_branches', 'max_staff',
  'subscription_plan', 'subscription_status', 'subscription_renewal_date',
]);

/** Subscription statuses, matching the CHECK constraint in the schema. */
const SUBSCRIPTION_STATUSES = Object.freeze(['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED']);

function isPlanField(key) {
  return PLAN_FIELDS.includes(key);
}

/**
 * A CAP OF ZERO MEANS UNLIMITED — which is what the plan screen has always said.
 *
 * `public/js/views/plan.js` renders `maxBranches === 0` as "Unlimited", and the
 * enforcement read `Number(settings.max_branches || 0)` and threw `used >= max`,
 * so 0 blocked everything and the refusal read "includes 0 branches". An operator
 * who read the screen, decided a client should have unlimited branches and set
 * zero had locked them out of ever opening another one.
 *
 * The screen's reading wins, because it is the one the operator acted on, and
 * because a fail-open cap is the right direction here: an accidental zero costs a
 * support call, while an accidental lock-out stops a shop trading.
 */
function capValue(settings, key) {
  const raw = settings ? settings[key] : null;
  if (raw === null || raw === undefined || raw === '') return Infinity;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return Math.floor(n);
}

/** "5 branches" / "unlimited branches" — for messages that print a cap. */
function capLabel(max, one, many) {
  if (max === Infinity) return `unlimited ${many}`;
  return `${max} ${max === 1 ? one : many}`;
}

const FEATURE_COLUMNS = Object.freeze({
  attendance: 'attendance_module_enabled',
  warranty: 'warranty_module_enabled',
  instalments: 'instalment_module_enabled',
  delivery: 'delivery_module_enabled',
  multiBranch: 'multi_branch_enabled',
  multiBusiness: 'multi_business_enabled',
  serialTracking: 'serial_tracking_enabled',
  offlineSync: 'offline_sync_enabled',
});

const FEATURE_LABELS = Object.freeze({
  attendance: 'Staff Attendance',
  warranty: 'Warranty & Serial Tracking',
  instalments: 'Instalment Plans (Work and Pay)',
  delivery: 'Delivery & Installation',
  multiBranch: 'Multiple Branches',
  multiBusiness: 'Multiple Businesses',
  serialTracking: 'Serial Number Tracking',
  offlineSync: 'Offline Sync',
});

async function getSettings(db) {
  const row = await db.first('SELECT * FROM client_settings WHERE id = 1');
  return row ? { ...DEFAULT_SETTINGS, ...row } : { ...DEFAULT_SETTINGS };
}

function contactLine(settings) {
  const parts = [];
  if (settings.admin_contact_name) parts.push(settings.admin_contact_name);
  if (settings.admin_contact_phone) parts.push(`phone: ${settings.admin_contact_phone}`);
  if (settings.admin_contact_email) parts.push(`email: ${settings.admin_contact_email}`);
  return parts.length ? parts.join(', ') : 'your StockRidge account manager';
}

function planError(message, code = 'PLAN_LIMIT_REACHED', status = 402) {
  return Object.assign(new Error(message), { status, code });
}

// ---------------------------------------------------------------------
// SUBSCRIPTION STATUS GATE
// ---------------------------------------------------------------------
/**
 * Blocks every mutating request when the subscription is SUSPENDED or
 * EXPIRED. READ access is deliberately preserved: a client who has not paid
 * must still be able to export their own data. Locking a business out of
 * reading its own books to enforce an invoice is both legally dubious and
 * the fastest way to guarantee the invoice is never paid.
 *
 * ADMIN always bypasses — the vendor can never be locked out of their own
 * client's instance, including while helping that client resolve the very
 * suspension in question.
 */
function assertSubscriptionActive(settings, user, { allowRead = false } = {}) {
  if (!settings) return;
  if (user && String(user.role).toUpperCase() === ROLES.ADMIN) return;
  const status = String(settings.subscription_status || 'ACTIVE').toUpperCase();
  if (status === 'ACTIVE' || status === 'TRIAL') return;
  if (allowRead) return;
  const renewal = settings.subscription_renewal_date ? ` (renewal date ${settings.subscription_renewal_date})` : '';
  throw planError(
    `This account's subscription is ${status}${renewal}. Reading and exporting your data still works, but new transactions are paused. Please contact ${contactLine(settings)} to restore service.`,
    'SUBSCRIPTION_NOT_ACTIVE', 402,
  );
}

// ---------------------------------------------------------------------
// HARD CAPS
// ---------------------------------------------------------------------
/** Active businesses only. */
async function activeBusinessCount(db) {
  const row = await db.first('SELECT COUNT(*) AS c FROM businesses WHERE is_deleted = 0 AND is_active = 1');
  return Number((row && row.c) || 0);
}

/** Active branches only — see the note on closed branches above. */
async function activeBranchCount(db) {
  const row = await db.first('SELECT COUNT(*) AS c FROM branches WHERE is_deleted = 0 AND is_active = 1');
  return Number((row && row.c) || 0);
}

/**
 * Client staff only. The ADMIN vendor seat is NOT counted — it is not part
 * of the client's team and counting it would mean a one-person plan could
 * never be administered.
 */
async function activeStaffCount(db) {
  const row = await db.first("SELECT COUNT(*) AS c FROM users WHERE is_deleted = 0 AND is_active = 1 AND role <> 'ADMIN'");
  return Number((row && row.c) || 0);
}

async function assertCanCreateBusiness(db, settings) {
  const used = await activeBusinessCount(db);
  const max = capValue(settings, 'max_businesses');
  if (used >= max) {
    throw planError(
      `Your ${settings.subscription_plan} plan includes ${capLabel(max, 'business', 'businesses')} and all ${used} are in use. Contact ${contactLine(settings)} to add another.`,
      'MAX_BUSINESSES_REACHED',
    );
  }
  return { used, max, remaining: max === Infinity ? Infinity : max - used };
}

async function assertCanCreateBranch(db, settings) {
  if (!Number(settings.multi_branch_enabled)) {
    throw planError(
      `Multiple branches are not included in your ${settings.subscription_plan} plan. Contact ${contactLine(settings)} to enable them.`,
      'FEATURE_NOT_ON_PLAN', 403,
    );
  }
  const used = await activeBranchCount(db);
  const max = capValue(settings, 'max_branches');
  if (used >= max) {
    throw planError(
      `Your ${settings.subscription_plan} plan includes ${capLabel(max, 'branch', 'branches')} and all ${used} are in use. Contact ${contactLine(settings)} to add another.`,
      'MAX_BRANCHES_REACHED',
    );
  }
  return { used, max, remaining: max === Infinity ? Infinity : max - used };
}

async function assertCanCreateStaff(db, settings) {
  const used = await activeStaffCount(db);
  const max = capValue(settings, 'max_staff');
  if (used >= max) {
    throw planError(
      `Your ${settings.subscription_plan} plan includes ${capLabel(max, 'staff seat', 'staff seats')} and all ${used} are in use. Deactivate a leaver, or contact ${contactLine(settings)} to add more.`,
      'MAX_STAFF_REACHED',
    );
  }
  return { used, max, remaining: max === Infinity ? Infinity : max - used };
}

/** Usage summary for the OWNER's "My Plan" screen. */
function remaining(used, max) {
  return max === Infinity ? null : Math.max(0, max - used);
}

async function planUsage(db, settings) {
  const [businesses, branches, staff] = await Promise.all([
    activeBusinessCount(db), activeBranchCount(db), activeStaffCount(db),
  ]);
  return {
    plan: settings.subscription_plan,
    status: settings.subscription_status,
    renewalDate: settings.subscription_renewal_date || null,
    // `allowed: 0` and `unlimited: true` are the same statement; both are sent so a
    // screen can print "Unlimited" without having to know the convention.
    businesses: { used: businesses, allowed: Number(settings.max_businesses || 0), unlimited: capValue(settings, 'max_businesses') === Infinity, remaining: remaining(businesses, capValue(settings, 'max_businesses')) },
    branches: { used: branches, allowed: Number(settings.max_branches || 0), unlimited: capValue(settings, 'max_branches') === Infinity, remaining: remaining(branches, capValue(settings, 'max_branches')) },
    staff: { used: staff, allowed: Number(settings.max_staff || 0), unlimited: capValue(settings, 'max_staff') === Infinity, remaining: remaining(staff, capValue(settings, 'max_staff')) },
    features: Object.keys(FEATURE_COLUMNS).map((key) => ({
      key,
      label: FEATURE_LABELS[key],
      enabled: Boolean(Number(settings[FEATURE_COLUMNS[key]])),
    })),
    contact: {
      name: settings.admin_contact_name || null,
      phone: settings.admin_contact_phone || null,
      email: settings.admin_contact_email || null,
    },
  };
}

// ---------------------------------------------------------------------
// FEATURE TOGGLES
// ---------------------------------------------------------------------
function assertFeatureEnabled(settings, featureKey, user) {
  if (user && String(user.role).toUpperCase() === ROLES.ADMIN) return; // vendor always passes
  const column = FEATURE_COLUMNS[featureKey];
  if (!column) return; // unknown key: not a plan feature, nothing to gate
  if (Number(settings[column])) return;
  throw planError(
    `${FEATURE_LABELS[featureKey] || featureKey} is not enabled on this account's ${settings.subscription_plan} plan. Contact ${contactLine(settings)} to switch it on.`,
    'FEATURE_NOT_ON_PLAN', 403,
  );
}

// ---------------------------------------------------------------------
// PERMISSION SWITCHES (client-owned governance)
// ---------------------------------------------------------------------
/**
 * May this user void a sale?
 *
 * OWNER/ADMIN: always. MANAGER: if managers_can_void_sales. STAFF: only
 * their OWN sale, within the window, while the till that recorded it is
 * still open — the narrow allowance described in the header.
 */
function canVoidSale(settings, user, sale, { nowMinutesSinceSale = null } = {}) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === ROLES.ADMIN || role === ROLES.OWNER) return { allowed: true };
  if (role === ROLES.MANAGER) {
    return Number(settings.managers_can_void_sales)
      ? { allowed: true }
      : { allowed: false, reason: 'The owner has restricted sale voiding. Ask them to enable it in My Plan.' };
  }
  if (role !== ROLES.STAFF) return { allowed: false, reason: 'Unknown role.' };
  if (!Number(settings.staff_can_void_sales)) {
    return { allowed: false, reason: 'Cashiers cannot void sales on this account. A manager must do it.' };
  }
  if (sale && sale.salesperson_id && String(sale.salesperson_id) !== String(user.id)) {
    return { allowed: false, reason: 'You can only void a sale you made yourself. Ask the cashier who made it, or a manager.' };
  }
  const window = Number(settings.staff_void_window_minutes);
  if (Number.isFinite(window) && window >= 0 && nowMinutesSinceSale != null && nowMinutesSinceSale > window) {
    return {
      allowed: false,
      reason: `Cashiers may void their own sale within ${window} minute${window === 1 ? '' : 's'}. This sale is older than that, so a manager must void it.`,
    };
  }
  return { allowed: true };
}

/** May this user post a stock adjustment of this size? */
function canAdjustStock(settings, user, { quantityBase, totalValue = 0 } = {}) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === ROLES.ADMIN || role === ROLES.OWNER || role === ROLES.MANAGER) return { allowed: true };
  if (role !== ROLES.STAFF) return { allowed: false, reason: 'Unknown role.' };
  if (!Number(settings.staff_can_adjust_stock)) {
    return { allowed: false, reason: 'Cashiers cannot adjust stock on this account. A manager must record it.' };
  }
  const qty = Math.abs(Number(quantityBase) || 0);
  const maxUnits = Number(settings.staff_adjustment_max_units);
  if (Number.isFinite(maxUnits) && qty > maxUnits) {
    return {
      allowed: false,
      reason: `A cashier may write off up to ${maxUnits.toLocaleString('en-NG')} unit${maxUnits === 1 ? '' : 's'} per adjustment. This one is ${qty.toLocaleString('en-NG')}, so a manager must approve it.`,
    };
  }
  const maxValue = Number(settings.staff_can_adjust_stock_value);
  if (Number.isFinite(maxValue) && maxValue > 0 && Math.abs(Number(totalValue) || 0) > maxValue) {
    return {
      allowed: false,
      reason: `A cashier may write off up to ₦${maxValue.toLocaleString('en-NG')} of stock value per adjustment. This one is worth more, so a manager must approve it.`,
    };
  }
  return { allowed: true };
}

/** May this user draw from the branch safe? */
function canSpendFromSafe(settings, user, { amount } = {}) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === ROLES.ADMIN || role === ROLES.OWNER || role === ROLES.MANAGER) return { allowed: true };
  if (role !== ROLES.STAFF) return { allowed: false, reason: 'Unknown role.' };
  if (!Number(settings.staff_can_spend_from_safe)) {
    return { allowed: false, reason: 'Cashiers cannot draw from the safe on this account. A manager must do it.' };
  }
  const cap = Number(settings.staff_safe_spend_max);
  // 0 means NO CAP — a deliberate client choice, so it reads as unlimited
  // and never as "zero allowed". The can/cannot decision is the boolean
  // above, not this number.
  if (Number.isFinite(cap) && cap > 0 && Math.abs(Number(amount) || 0) > cap) {
    return {
      allowed: false,
      reason: `A cashier may draw up to ₦${cap.toLocaleString('en-NG')} from the safe in one transaction. This is more, so a manager must approve it.`,
    };
  }
  return { allowed: true };
}

/** May this user apply a discount of this percentage? */
function canDiscount(settings, user, { discountPct } = {}) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === ROLES.ADMIN || role === ROLES.OWNER || role === ROLES.MANAGER) return { allowed: true };
  const cap = Number(settings.staff_discount_max_pct);
  const pct = Math.abs(Number(discountPct) || 0);
  if (!Number.isFinite(cap) || pct <= cap) return { allowed: true };
  return { allowed: false, reason: `Cashiers may discount up to ${cap}%. This is ${pct}%, so a manager must approve it.` };
}

/** May this user put a sale on credit? */
function canSellOnCredit(settings, user, { amount = 0, customerBalance = 0, creditLimit = 0 } = {}) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === ROLES.ADMIN || role === ROLES.OWNER || role === ROLES.MANAGER) return { allowed: true };
  if (!Number(settings.staff_can_sell_on_credit)) {
    return { allowed: false, reason: 'Cashiers cannot sell on credit on this account. A manager must approve it.' };
  }
  const cap = Number(settings.staff_credit_max);
  if (Number.isFinite(cap) && cap > 0 && Number(amount) > cap) {
    return { allowed: false, reason: `A cashier may extend credit up to ₦${cap.toLocaleString('en-NG')}. This sale is larger, so a manager must approve it.` };
  }
  if (Number(creditLimit) > 0 && customerBalance + Number(amount) > Number(creditLimit)) {
    return { allowed: false, reason: 'This would take the customer over their credit limit. A manager can override it.' };
  }
  return { allowed: true };
}

function canApproveExpense(settings, user) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === ROLES.ADMIN || role === ROLES.OWNER) return { allowed: true };
  if (role === ROLES.MANAGER) {
    return Number(settings.managers_can_approve_expenses)
      ? { allowed: true }
      : { allowed: false, reason: 'The owner has restricted expense approval. Ask them to enable it in My Plan.' };
  }
  return { allowed: false, reason: 'Only a manager or the owner can approve expenses.' };
}

function canEditPrices(settings, user) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === ROLES.ADMIN || role === ROLES.OWNER) return { allowed: true };
  if (role === ROLES.MANAGER) {
    return Number(settings.managers_can_edit_prices)
      ? { allowed: true }
      : { allowed: false, reason: 'The owner has restricted price editing. Ask them to enable it in My Plan.' };
  }
  return { allowed: false, reason: 'Only a manager or the owner can change prices.' };
}

/**
 * Credit-limit override. The ledger check is advisory by default — a
 * Nigerian shop floor runs on relationships and an owner will sometimes
 * knowingly extend beyond the limit — so the system's job is to make that
 * a RECORDED decision rather than a silent one, not to refuse it.
 */
function canOverrideCreditLimit(settings, user) {
  const role = String((user && user.role) || '').toUpperCase();
  if (role === ROLES.ADMIN || role === ROLES.OWNER) return { allowed: true };
  if (role === ROLES.MANAGER) {
    return Number(settings.managers_can_override_credit_limit)
      ? { allowed: true }
      : { allowed: false, reason: 'The owner has restricted credit-limit overrides.' };
  }
  return { allowed: false, reason: 'Only a manager or the owner can go over a credit limit.' };
}

module.exports = {
  DEFAULT_SETTINGS, FLAG_SETTINGS, FEATURE_COLUMNS, FEATURE_LABELS,
  PLAN_FIELDS, SUBSCRIPTION_STATUSES, isPlanField, capValue, capLabel,
  getSettings, contactLine, planError,
  assertSubscriptionActive,
  activeBusinessCount, activeBranchCount, activeStaffCount,
  assertCanCreateBusiness, assertCanCreateBranch, assertCanCreateStaff, planUsage,
  assertFeatureEnabled,
  canVoidSale, canAdjustStock, canSpendFromSafe, canDiscount, canSellOnCredit,
  canApproveExpense, canEditPrices, canOverrideCreditLimit,
};
