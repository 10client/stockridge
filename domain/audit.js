// =====================================================================
// StockRidge — AUDIT TRAIL & FRAUD SIGNALS
// =====================================================================
// WHAT AN AUDIT LOG IS FOR
// ---------------------------------------------------------------------
// Not for compliance theatre. A retail audit log answers four questions an
// owner actually asks, usually after money has gone missing:
//
//   1. Who changed this, and when?           (the fact)
//   2. What was it before?                   (the delta)
//   3. Was that within their authority?      (the policy check)
//   4. Is anyone doing this more than they should?  (the PATTERN)
//
// Question 4 is the one that pays for the log. A single void is a mistake;
// a cashier whose void rate is four times the branch average is a finding.
// PharmaRidge shipped `v_void_audit_by_user` for exactly this reason, and it
// is generalised here into a set of signals that work for any retail trade.
//
// ---------------------------------------------------------------------
// WHAT MUST BE LOGGED (and what must not)
// ---------------------------------------------------------------------
// Logged: every mutation to money, stock, prices, authority, or identity —
// with the before value, the after value, the actor, the branch, the
// request id and the reason where one was given.
//
// NOT logged: PIN values, card numbers, full ID numbers beyond a masked
// form, or anything else that turns the audit log into a more attractive
// target than the database it describes. An audit log is readable by more
// people than the data it audits, so it must hold less sensitive material,
// not more. See redact() below.
// =====================================================================

const { round2 } = require('./money');

// ---------------------------------------------------------------------
// AUDIT ENTITIES & ACTIONS
// ---------------------------------------------------------------------
const AUDIT_ENTITIES = Object.freeze([
  'user', 'branch', 'product', 'price', 'stock_batch', 'serialised_unit',
  'purchase_order', 'supplier', 'customer', 'sale', 'sale_payment',
  'transfer', 'stocktake', 'stock_adjustment', 'expense',
  'till_session', 'safe_movement', 'debtor_ledger', 'creditor_ledger',
  'change_owed', 'instalment_plan', 'plan_payment', 'layaway', 'item_hold',
  'warranty_claim', 'delivery_job', 'regulated_register', 'settings',
  'plan_limits', 'branding', 'sync', 'data_cleanup', 'login', 'session',
]);

const AUDIT_ACTIONS = Object.freeze([
  'CREATE', 'UPDATE', 'DELETE', 'VOID', 'REVERSE', 'APPROVE', 'REJECT',
  'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'LOCKOUT', 'UNLOCK', 'PIN_RESET',
  'ROLE_CHANGE', 'BRANCH_TRANSFER', 'DEACTIVATE', 'REACTIVATE',
  'PRICE_CHANGE', 'STOCK_ADJUST', 'STOCKTAKE_COMMIT', 'TILL_OPEN',
  'TILL_CLOSE', 'SAFE_DEPOSIT', 'SAFE_WITHDRAWAL', 'EXPORT', 'IMPORT',
  'SETTINGS_CHANGE', 'PLAN_CHANGE', 'CONFLICT_REVIEWED', 'RECALL_LOOKUP',
]);

// Actions whose every occurrence a manager should be able to see at a
// glance, because each one is either money moving or authority being used.
const HIGH_INTEREST_ACTIONS = Object.freeze([
  'VOID', 'REVERSE', 'PRICE_CHANGE', 'STOCK_ADJUST', 'SAFE_WITHDRAWAL',
  'PIN_RESET', 'ROLE_CHANGE', 'BRANCH_TRANSFER', 'APPROVE', 'EXPORT',
  'SETTINGS_CHANGE', 'PLAN_CHANGE', 'LOGIN_FAILED', 'LOCKOUT', 'UNLOCK',
]);

// ---------------------------------------------------------------------
// REDACTION
// ---------------------------------------------------------------------
// Fields that must never reach the audit log in clear. Masked rather than
// dropped: "ID number recorded: NIN ****4521" proves something was captured
// without becoming a copy of the identity register.
const REDACTED_FIELDS = Object.freeze([
  'pin', 'pin_hash', 'password', 'new_pin', 'current_pin',
  'card_number', 'card_pan', 'cvv', 'cvc', 'pin_pad',
  'bvn', 'nin_number', 'id_number', 'token', 'jwt', 'secret',
  'authorization', 'cookie', 'session_token',
]);

const MASKED_FIELDS = Object.freeze([
  'phone', 'customer_phone', 'buyer_phone', 'email', 'account_number',
  'bank_account', 'tin', 'cac_reg_no', 'serial_number',
]);

function maskValue(field, value) {
  const s = String(value == null ? '' : value);
  if (!s) return s;
  const lower = String(field).toLowerCase();
  if (lower.includes('phone')) {
    const digits = s.replace(/\D/g, '');
    return digits.length >= 4 ? `+234****${digits.slice(-4)}` : '****';
  }
  if (lower.includes('email')) {
    const at = s.indexOf('@');
    return at > 1 ? `${s.slice(0, 2)}****${s.slice(at)}` : '****';
  }
  if (lower.includes('serial') || lower.includes('imei')) {
    return s.length > 4 ? `${s.slice(0, 2)}****${s.slice(-4)}` : '****';
  }
  if (lower.includes('account')) {
    return s.length > 4 ? `****${s.slice(-4)}` : '****';
  }
  return s.length > 4 ? `${s.slice(0, 2)}****${s.slice(-2)}` : '****';
}

// Deep-redact an object before it is serialised into the audit log.
function redact(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (value.length > 50) return [`[array of ${value.length}]`, ...value.slice(0, 20).map((v) => redact(v, depth + 1))];
    return value.map((v) => redact(v, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lower = k.toLowerCase();
    if (REDACTED_FIELDS.includes(lower)) { out[k] = '[redacted]'; continue; }
    if (MASKED_FIELDS.some((m) => lower.includes(m))) { out[k] = maskValue(k, v); continue; }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------
// THE AUDIT ENTRY
// ---------------------------------------------------------------------
// A plain, complete record. `before`/`after` are the delta and they are the
// reason the log is useful: without them, "PRICE_CHANGE by user 7" tells
// you nothing about whether ₦450,000 became ₦45,000 or ₦450,500.
function buildAuditEntry({
  entity, action, entityId, branchId, userId, userName, userRole,
  before = null, after = null, reason = null, requestId = null,
  ipAddress = null, userAgent = null, meta = null, severity = 'INFO',
}) {
  if (!AUDIT_ENTITIES.includes(entity)) {
    throw Object.assign(new Error(`Unknown audit entity "${entity}"`), { status: 500, code: 'AUDIT_ENTITY_UNKNOWN' });
  }
  if (!AUDIT_ACTIONS.includes(action)) {
    throw Object.assign(new Error(`Unknown audit action "${action}"`), { status: 500, code: 'AUDIT_ACTION_UNKNOWN' });
  }
  return {
    entity,
    action,
    entity_id: entityId || null,
    branch_id: branchId || null,
    user_id: userId || null,
    user_name: userName || null,
    user_role: userRole || null,
    before_json: before ? JSON.stringify(redact(before)) : null,
    after_json: after ? JSON.stringify(redact(after)) : null,
    reason: reason ? String(reason).slice(0, 500) : null,
    request_id: requestId || null,
    ip_address: ipAddress ? String(ipAddress).slice(0, 60) : null,
    user_agent: userAgent ? String(userAgent).slice(0, 200) : null,
    meta_json: meta ? JSON.stringify(redact(meta)) : null,
    severity: ['INFO', 'NOTICE', 'WARN', 'CRITICAL'].includes(severity) ? severity : 'INFO',
    high_interest: HIGH_INTEREST_ACTIONS.includes(action) ? 1 : 0,
    occurred_at: new Date().toISOString(),
  };
}

// A reason is REQUIRED for the destructive actions. "Why did you void it"
// asked six weeks later gets "I don't remember"; asked at the moment of the
// void, in the field that will not submit without it, gets the truth — and
// the truth is usually "customer changed their mind", which is fine, or
// "I rang it up wrong", which is fine, or nothing at all, which is the
// finding.
const REASON_REQUIRED_ACTIONS = Object.freeze([
  'VOID', 'REVERSE', 'STOCK_ADJUST', 'PRICE_CHANGE', 'PIN_RESET',
  'ROLE_CHANGE', 'SAFE_WITHDRAWAL', 'REJECT', 'DEACTIVATE', 'SETTINGS_CHANGE',
]);

function assertReasonGiven(action, reason) {
  if (!REASON_REQUIRED_ACTIONS.includes(action)) return null;
  const r = String(reason || '').trim();
  if (r.length < 4) {
    return {
      ok: false, code: 'REASON_REQUIRED',
      error: `A reason is required for ${action.replace(/_/g, ' ').toLowerCase()}. It is the only record of why this happened, and it will be read by someone who was not in the shop.`,
    };
  }
  if (r.length > 500) {
    return { ok: false, code: 'REASON_TOO_LONG', error: 'Keep the reason under 500 characters.' };
  }
  return null;
}

// ---------------------------------------------------------------------
// FRAUD / SHRINKAGE SIGNALS
// ---------------------------------------------------------------------
// Each signal is a pure function over rows the audit log and the ledgers
// already contain. They are computed into views and surfaced on the
// manager's dashboard as EXCEPTIONS, never as accusations: the numbers are
// a reason to look, not a verdict.

// 1. VOID RATE. Voids per user against the branch average. The classic
//    pattern is sell-for-cash, void, pocket the note — the books show no
//    sale and the stock is gone.
function voidRateSignal(users) {
  const rows = (users || []).map((u) => ({
    user_id: u.user_id,
    user_name: u.user_name,
    branch_id: u.branch_id,
    sales_count: Number(u.sales_count) || 0,
    void_count: Number(u.void_count) || 0,
  }));
  const active = rows.filter((r) => r.sales_count > 0);
  if (!active.length) return { signal: 'VOID_RATE', findings: [], baseline: null };

  const totalVoids = active.reduce((s, r) => s + r.void_count, 0);
  const totalSales = active.reduce((s, r) => s + r.sales_count, 0);
  const baseline = totalSales > 0 ? round2((totalVoids / totalSales) * 100) : 0;

  const findings = active
    .map((r) => ({
      ...r,
      void_rate_percent: r.sales_count > 0 ? round2((r.void_count / r.sales_count) * 100) : 0,
    }))
    .filter((r) => r.void_count >= 3 && baseline > 0 && r.void_rate_percent > baseline * 2.5)
    .map((r) => ({
      ...r,
      severity: r.void_rate_percent > baseline * 5 ? 'CRITICAL' : 'WARN',
      message:
        `${r.user_name || 'A cashier'} voided ${r.void_count} of ${r.sales_count} sales (${r.void_rate_percent}%) against a branch baseline of ${baseline}%. ` +
        'Review the voided receipts — a void after a cash payment is the pattern to look for.',
    }));

  return { signal: 'VOID_RATE', baseline_percent: baseline, findings };
}

// 2. WRITE-OFF CONCENTRATION. One user accounting for a disproportionate
//    share of DAMAGE/THEFT/EXPIRED adjustments is the second classic
//    pattern: take the goods, record them as broken.
function writeOffConcentration(adjustments) {
  const rows = adjustments || [];
  if (!rows.length) return { signal: 'WRITE_OFF_CONCENTRATION', findings: [] };

  const byUser = new Map();
  const byBranch = new Map();
  for (const a of rows) {
    const value = Math.abs(Number(a.value) || 0);
    const u = byUser.get(a.user_id) || { user_id: a.user_id, user_name: a.user_name, count: 0, value: 0 };
    u.count += 1; u.value = round2(u.value + value);
    byUser.set(a.user_id, u);
    const b = byBranch.get(a.branch_id) || { count: 0, value: 0 };
    b.count += 1; b.value = round2(b.value + value);
    byBranch.set(a.branch_id, b);
  }

  const findings = [];
  for (const [branchId, totals] of byBranch) {
    if (totals.count < 5) continue;
    for (const u of byUser.values()) {
      const share = totals.value > 0 ? round2((u.value / totals.value) * 100) : 0;
      if (u.count >= 4 && share >= 60) {
        findings.push({
          branch_id: branchId, user_id: u.user_id, user_name: u.user_name,
          adjustment_count: u.count, adjustment_value: u.value,
          share_of_branch_value_percent: share,
          severity: share >= 85 ? 'CRITICAL' : 'WARN',
          message:
            `${u.user_name || 'A member of staff'} posted ${u.count} write-offs worth ₦${u.value.toLocaleString('en-NG')} — ${share}% of this branch's total write-off value. ` +
            'Verify the damaged/expired goods were actually disposed of.',
        });
      }
    }
  }
  return { signal: 'WRITE_OFF_CONCENTRATION', findings };
}

// 3. PRICE OVERRIDE PATTERN. Repeated downward price changes on the same
//    product by the same user, especially just before a sale to the same
//    customer. Not necessarily theft — but always worth a look.
function priceOverridePattern(events) {
  const rows = (events || []).filter((e) => e.action === 'PRICE_CHANGE' && Number(e.after_value) < Number(e.before_value));
  if (!rows.length) return { signal: 'PRICE_OVERRIDE_PATTERN', findings: [] };

  const byUserProduct = new Map();
  for (const e of rows) {
    const key = `${e.user_id}|${e.entity_id}`;
    const cur = byUserProduct.get(key) || { user_id: e.user_id, user_name: e.user_name, product_id: e.entity_id, product_name: e.product_name, count: 0, total_reduction: 0 };
    cur.count += 1;
    cur.total_reduction = round2(cur.total_reduction + (Number(e.before_value) - Number(e.after_value)));
    byUserProduct.set(key, cur);
  }

  const findings = [...byUserProduct.values()]
    .filter((r) => r.count >= 3)
    .map((r) => ({
      ...r,
      severity: r.count >= 6 ? 'CRITICAL' : 'WARN',
      message:
        `${r.user_name || 'A member of staff'} reduced the price of "${r.product_name || 'a product'}" ${r.count} time(s), a cumulative ₦${r.total_reduction.toLocaleString('en-NG')} off list. ` +
        'Check who bought it at the reduced price.',
    }));

  return { signal: 'PRICE_OVERRIDE_PATTERN', findings };
}

// 4. TILL VARIANCE RECURRENCE. One short shift is a mistake. A cashier
//    short by a similar amount every shift is not.
function tillVarianceRecurrence(sessions) {
  const rows = (sessions || []).filter((s) => Number.isFinite(Number(s.variance)));
  if (rows.length < 4) return { signal: 'TILL_VARIANCE_RECURRENCE', findings: [] };

  const byUser = new Map();
  for (const s of rows) {
    const cur = byUser.get(s.user_id) || { user_id: s.user_id, user_name: s.user_name, sessions: 0, shortCount: 0, overCount: 0, totalShort: 0, totalOver: 0, variances: [] };
    cur.sessions += 1;
    const v = round2(Number(s.variance));
    cur.variances.push(v);
    if (v < 0) { cur.shortCount += 1; cur.totalShort = round2(cur.totalShort + Math.abs(v)); }
    if (v > 0) { cur.overCount += 1; cur.totalOver = round2(cur.totalOver + v); }
    byUser.set(s.user_id, cur);
  }

  const findings = [];
  for (const u of byUser.values()) {
    if (u.sessions < 4) continue;
    const shortRate = round2((u.shortCount / u.sessions) * 100);
    // Consistently short at a rate well above chance, or a suspiciously
    // consistent AMOUNT (which is what skimming looks like: the same small
    // figure every shift, below the level anyone would investigate).
    const amounts = u.variances.filter((v) => v < 0).map((v) => Math.abs(v));
    const consistentAmount = amounts.length >= 3
      && Math.max(...amounts) - Math.min(...amounts) <= Math.max(500, Math.max(...amounts) * 0.15);

    if (shortRate >= 75 || consistentAmount) {
      findings.push({
        user_id: u.user_id, user_name: u.user_name,
        sessions: u.sessions, short_count: u.shortCount, short_rate_percent: shortRate,
        total_short: u.totalShort, total_over: u.totalOver,
        consistent_shortfall_amount: consistentAmount,
        severity: u.totalShort > 50000 || consistentAmount ? 'CRITICAL' : 'WARN',
        message: consistentAmount
          ? `${u.user_name || 'A cashier'} was short on ${u.shortCount} of ${u.sessions} shifts by a near-identical amount each time. That pattern is not counting error.`
          : `${u.user_name || 'A cashier'} was short on ${u.shortCount} of ${u.sessions} shifts (${shortRate}%), ₦${u.totalShort.toLocaleString('en-NG')} in total.`,
      });
    }
  }
  return { signal: 'TILL_VARIANCE_RECURRENCE', findings };
}

// 5. OFF-HOURS ACTIVITY. Mutations at times the branch is not trading.
//    A sale at 02:40 in a shop that closes at 20:00 is either a night
//    market branch (legitimate, and the trading-hours setting says so) or
//    somebody with a key and no witnesses.
function offHoursActivity(events, { branchTradingHours = null } = {}) {
  if (!branchTradingHours) return { signal: 'OFF_HOURS_ACTIVITY', findings: [], notConfigured: true };
  const [openHour, closeHour] = branchTradingHours;
  const rows = (events || []).filter((e) => {
    const h = new Date(e.occurred_at).getUTCHours(); // callers pass local-hours-adjusted timestamps
    return h < openHour || h >= closeHour;
  });
  const byUser = new Map();
  for (const e of rows) {
    const cur = byUser.get(e.user_id) || { user_id: e.user_id, user_name: e.user_name, count: 0, actions: new Set() };
    cur.count += 1; cur.actions.add(e.action);
    byUser.set(e.user_id, cur);
  }
  const findings = [...byUser.values()]
    .filter((u) => u.count >= 2)
    .map((u) => ({
      user_id: u.user_id, user_name: u.user_name, event_count: u.count,
      actions: [...u.actions],
      severity: u.count >= 10 ? 'CRITICAL' : 'WARN',
      message: `${u.user_name || 'A member of staff'} made ${u.count} change(s) outside trading hours (${[...u.actions].join(', ')}).`,
    }));
  return { signal: 'OFF_HOURS_ACTIVITY', findings };
}

// 6. CREDIT EXTENDED TO THE SAME CUSTOMER REPEATEDLY AT THE LIMIT. A
//    manager repeatedly approving "just over the limit" for one customer is
//    either good relationship management or a favour being banked.
function repeatedLimitOverrides(sales) {
  const rows = (sales || []).filter((s) => s.credit_limit_override === 1);
  if (rows.length < 3) return { signal: 'REPEATED_LIMIT_OVERRIDE', findings: [] };
  const byCustomer = new Map();
  for (const s of rows) {
    const cur = byCustomer.get(s.customer_id) || {
      customer_id: s.customer_id, customer_name: s.customer_name, count: 0, value: 0,
      approved_by: new Map(),
    };
    cur.count += 1;
    cur.value = round2(cur.value + Number(s.total) || 0);
    const a = cur.approved_by.get(s.approved_by) || { user_name: s.approved_by_name, count: 0 };
    a.count += 1;
    cur.approved_by.set(s.approved_by, a);
    byCustomer.set(s.customer_id, cur);
  }
  const findings = [...byCustomer.values()]
    .filter((c) => c.count >= 3)
    .map((c) => {
      const approvers = [...c.approved_by.values()].sort((a, b) => b.count - a.count);
      return {
        customer_id: c.customer_id, customer_name: c.customer_name,
        override_count: c.count, override_value: c.value,
        top_approver: approvers[0] ? approvers[0].user_name : null,
        top_approver_count: approvers[0] ? approvers[0].count : 0,
        severity: approvers[0] && approvers[0].count >= c.count * 0.8 ? 'CRITICAL' : 'WARN',
        message:
          `Credit limits were overridden ${c.count} time(s) for ${c.customer_name || 'a customer'} (₦${c.value.toLocaleString('en-NG')}), ` +
          `${approvers[0] ? `${approvers[0].count} of them approved by ${approvers[0].user_name || 'the same manager'}` : ''}. Review whether the limit should simply be raised, or whether the account should be stopped.`,
      };
    });
  return { signal: 'REPEATED_LIMIT_OVERRIDE', findings };
}

const FRAUD_SIGNALS = Object.freeze([
  { code: 'VOID_RATE', label: 'Unusual void rate', run: voidRateSignal },
  { code: 'WRITE_OFF_CONCENTRATION', label: 'Write-off concentration', run: writeOffConcentration },
  { code: 'PRICE_OVERRIDE_PATTERN', label: 'Repeated price reductions', run: priceOverridePattern },
  { code: 'TILL_VARIANCE_RECURRENCE', label: 'Recurring till shortfall', run: tillVarianceRecurrence },
  { code: 'OFF_HOURS_ACTIVITY', label: 'Activity outside trading hours', run: offHoursActivity },
  { code: 'REPEATED_LIMIT_OVERRIDE', label: 'Repeated credit-limit overrides', run: repeatedLimitOverrides },
]);

function runAllSignals(data = {}) {
  return FRAUD_SIGNALS
    .map((s) => ({ code: s.code, label: s.label, ...s.run(data[s.code] || []) }))
    .map((r) => ({ ...r, finding_count: (r.findings || []).length }))
    .sort((a, b) => b.finding_count - a.finding_count);
}

// ---------------------------------------------------------------------
// RETENTION
// ---------------------------------------------------------------------
// The audit log grows without bound on a busy multi-branch deployment. It
// is pruned by a scheduled job, but NEVER silently: the pruning itself is
// logged, and the retention period is a setting the owner can see, because
// "the record of who voided that sale is gone" needs to have an answer that
// is not "we deleted it and did not tell you".
const AUDIT_RETENTION_DAYS_DEFAULT = 730; // 2 years

module.exports = {
  AUDIT_ENTITIES,
  AUDIT_ACTIONS,
  HIGH_INTEREST_ACTIONS,
  REASON_REQUIRED_ACTIONS,
  REDACTED_FIELDS,
  MASKED_FIELDS,
  FRAUD_SIGNALS,
  AUDIT_RETENTION_DAYS_DEFAULT,
  maskValue,
  redact,
  buildAuditEntry,
  assertReasonGiven,
  voidRateSignal,
  writeOffConcentration,
  priceOverridePattern,
  tillVarianceRecurrence,
  offHoursActivity,
  repeatedLimitOverrides,
  runAllSignals,
};
