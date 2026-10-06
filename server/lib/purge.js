'use strict';
// =====================================================================
// server/lib/purge.js — WHAT A CLEANUP REMOVES, TABLE BY TABLE
// =====================================================================
// THE MOST DESTRUCTIVE CODE IN THIS PRODUCT, so it is written as DATA rather
// than as a script: every table a mode touches, in the order it must be touched,
// with the condition that decides which rows. A list can be read by a person,
// asserted by a test, and differenced against the schema; a function that runs
// five DELETEs in a row can only be trusted.
//
// FIVE RULES GOVERN EVERY LINE BELOW.
//
//   1. CHILDREN BEFORE PARENTS. Foreign keys are ON, so deleting a sale before
//      its lines fails — and a partial cleanup is worse than none, because the
//      shop cannot tell which half survived. test/integration/purge.test.js runs
//      every mode against a seeded database to prove the order.
//
//   2. THE PROMISE IS THE FEATURE. "Keep accounting" means the journal is still
//      there when it finishes; "keep accounting and stock" means the shelf is
//      still there too. Each mode's promise is a claim the test checks by counting
//      rows afterwards, not a caption.
//
//   3. KEEPING SOMETHING MEANS KEEPING WHAT IT DEPENDS ON — TRANSITIVELY. You
//      cannot keep a stocked batch while deleting the product it is a batch of,
//      or keep a product while deleting its unit ladder. A child scoped through a
//      parent therefore inherits the PARENT'S OWN condition including its
//      exception: without that, keeping 40 stocked products would still delete the
//      40 unit ladders that make them sellable, and the shop would keep rows it
//      cannot ring up.
//
//   4. CHUNKED, BECAUSE THE PLATFORM HAS A CLOCK. D1 caps a query at 30 seconds,
//      so a shop with two years of sales cannot be cleared by one `DELETE FROM
//      sales`. Every step deletes at most CHUNK rows at a time and repeats until
//      nothing is left, which also counts real rows instead of trusting `changes`.
//
//   5. AN UNKNOWN SCOPE DELETES NOTHING. Every condition is built from an
//      explicit business list; a table whose scope cannot be established is
//      SKIPPED and reported. The failure that matters most here is not "it did
//      not clean enough", it is "it cleaned somebody else's shop".
//
// WHAT NO MODE TOUCHES: the businesses row, the settings, the chart of accounts,
// the VAT and WHT rates, and the audit log. `NEVER_REMOVED` says so in the code
// and the audit asserts it — a cleanup that removed the audit log would destroy
// the record of the cleanup itself.
// =====================================================================

const CHUNK = 500;
const MAX_ROUNDS = 400;

/**
 * Ordered plans. Each step is:
 *   t      the table
 *   biz    true when the table carries `business_id` (scoped directly)
 *   via    [parentTable, fkColumn] when it is scoped through a parent instead
 *   date   the column carrying the trading date, for the PERIOD mode
 *   only   a named exception, resolved below
 */
const TRADING = [
  // THE ORDER IS A DEPENDENCY ORDER, and it is CHECKED rather than trusted:
  // test/integration/purge.test.js walks the schema's foreign keys and fails if any
  // table is deleted before something that still points at it. Six mistakes were
  // found that way, every one of them invisible until a database had rows in the
  // nullable columns a fixture leaves empty.
  //
  // Two rules are worth reading, because they are the ones that surprise:
  //   · nothing may be deleted before a table that POINTS AT IT, and that includes
  //     pointing at it through a column nobody filled in yet;
  //   · a table can be constrained from two directions at once. Stock batches are
  //     pointed at by sale lines and stocktakes (so they go late) and themselves
  //     point at a purchase order (so they go early) — the order below is the only
  //     place both are true.
  { t: 'sale_serials', via: ['sales', 'sale_id'] },
  { t: 'sale_payments', via: ['sales', 'sale_id'] },
  { t: 'change_owed', biz: true, date: 'created_at' },
  { t: 'sale_return_items', via: ['sale_returns', 'sale_return_id'] },
  { t: 'sale_returns', biz: true, date: 'created_at' },
  { t: 'deposit_payments', via: ['deposits', 'deposit_id'] },
  { t: 'instalment_payments', via: ['instalment_plans', 'plan_id'] },
  { t: 'instalment_schedule', via: ['instalment_plans', 'plan_id'] },
  { t: 'instalment_plans', biz: true, date: 'created_at' },
  { t: 'deposits', biz: true, date: 'created_at' },
  { t: 'delivery_job_items', via: ['delivery_jobs', 'delivery_job_id'] },
  { t: 'installation_jobs', biz: true, date: 'created_at' },
  { t: 'delivery_jobs', biz: true, date: 'created_at' },
  { t: 'warranty_claims', biz: true, date: 'created_at' },
  { t: 'purchase_order_receipts', via: ['purchase_orders', 'purchase_order_id'] },
  { t: 'purchase_order_items', via: ['purchase_orders', 'purchase_order_id'] },
  { t: 'stock_transfer_serials', via: ['stock_transfers', 'transfer_id'] },
  { t: 'stock_transfer_items', via: ['stock_transfers', 'transfer_id'] },
  { t: 'stock_transfers', via: ['branches', 'from_branch_id'], date: 'created_at' },
  { t: 'stocktake_lines', via: ['stocktake_sessions', 'stocktake_id'] },
  { t: 'stock_adjustments', biz: true, date: 'created_at' },
  { t: 'stocktake_sessions', biz: true, date: 'opened_at' },
  { t: 'serial_events', via: ['serial_numbers', 'serial_id'] },
  { t: 'serial_numbers', via: ['branches', 'branch_id'], date: 'created_at' },
  { t: 'sale_items', via: ['sales', 'sale_id'] },
  { t: 'stock_batches', biz: true, date: 'created_at' },
  { t: 'sales', biz: true, date: 'sold_at' },
  { t: 'purchase_orders', biz: true, date: 'ordered_at' },
  { t: 'debtor_ledger', biz: true, date: 'created_at' },
  { t: 'creditor_ledger', biz: true, date: 'created_at' },
  { t: 'wht_entries', biz: true, date: 'entry_date' },
  { t: 'expenses', biz: true, date: 'expense_date' },
  { t: 'till_sessions', biz: true, date: 'opened_at' },
  { t: 'staff_attendance', biz: true, date: 'clock_in_at' },
  { t: 'sales_targets', biz: true, date: 'created_at' },
  { t: 'notifications', biz: true, date: 'created_at' },
];/** The books and the safe. Kept by the two "keep accounting" modes. */
const ACCOUNTING = [
  { t: 'gl_journal_lines', via: ['gl_journal_entries', 'journal_entry_id'] },
  { t: 'gl_journal_entries', biz: true, date: 'entry_date' },
  { t: 'branch_safe_ledger', biz: true, date: 'created_at' },
];

/**
 * THE CATALOGUE: products and everything that hangs off one.
 *
 * Kept whole by the modes that keep master data, and PRUNED TO WHAT IS STILL ON THE
 * SHELF by the keep-stock mode. That pruning is the mode's whole point and it is
 * PharmaRidge's own contract (`products: id NOT IN (${activeProducts})`), not an
 * invention here: a shop that clears its trading history to start a new year keeps
 * the fridges it can actually sell and drops the catalogue entries it cannot, and a
 * product with no stock is not stock.
 */
const CATALOGUE = [
  // A recall is a fact about a product, so it goes where the product goes: pruned
  // with a product the mode dropped, kept alongside the stock that survived.
  { t: 'product_recalls', via: ['products', 'product_id'] },
  { t: 'product_registrations', via: ['products', 'product_id'] },
  { t: 'variant_axes', via: ['products', 'product_id'] },
  { t: 'product_measures', via: ['products', 'product_id'] },
  { t: 'product_barcodes', via: ['products', 'product_id'] },
  { t: 'product_units', via: ['products', 'product_id'] },
  { t: 'product_price_overrides', via: ['products', 'product_id'] },
  { t: 'price_list_items', via: ['products', 'product_id'] },
  { t: 'product_variants', via: ['products', 'product_id'] },
  { t: 'products', biz: true },
];

/** The customers, the suppliers and the lists they choose from. Never pruned. */
const PARTNERS = [
  // A CUSTOMER CHOOSES A PRICE LIST AND A CLASS, so the customer goes first and the
  // things it chose go afterwards. The other way round fails on the customer's own
  // foreign key.
  { t: 'customers', biz: true },
  { t: 'price_lists', biz: true },
  { t: 'customer_classes', biz: true },
  { t: 'delivery_zones', biz: true },
  { t: 'delivery_vehicles', biz: true },
  { t: 'suppliers', biz: true },
];

/** The catalogue, the customers and the suppliers. Kept unless the mode says otherwise. */
const MASTER = [...CATALOGUE, ...PARTNERS];
/** The team. Only the full reset touches it, and the acting administrator survives. */
const TEAM = [
  // A TRANSFER NAMES TWO BRANCHES AND A USER — and the user column is nullable, so
  // scoping it by user alone left rows behind that then blocked the branch deletion
  // with a foreign key. Scoping by either branch as well costs nothing (the second
  // pass finds nothing) and cannot miss a row that names the shop.
  { t: 'pending_user_transfers', via: ['users', 'user_id'] },
  { t: 'pending_user_transfers', via: ['branches', 'to_branch_id'] },
  { t: 'pending_user_transfers', via: ['branches', 'from_branch_id'] },
  { t: 'user_business_access', via: ['users', 'user_id'] },
  { t: 'user_assignment_history', via: ['users', 'user_id'] },
  { t: 'user_sessions', via: ['users', 'user_id'] },
  // BY BRANCH, NOT BY WHO REGISTERED IT. `registered_by` is nullable, and a device
  // whose registrant was NULL (or a deleted user) would survive a team reset while
  // still pointing at a branch — which then blocks the branch deletion with a
  // foreign key. A device belongs to a shop, so that is what scopes it.
  { t: 'branch_devices', via: ['branches', 'branch_id'] },
  { t: 'login_attempts', via: ['users', 'user_id'] },
  { t: 'users', biz: true, only: 'users' },
];

/** The shop's structure: only the full reset removes it, and last. */
const STRUCTURE = [
  { t: 'branch_compliance_records', via: ['branches', 'branch_id'] },
  { t: 'branch_sync_status', via: ['branches', 'branch_id'] },
  { t: 'branches', biz: true },
];

const PLANS = Object.freeze({
  PERIOD: { trading: true, dated: true, accounting: true },
  CLEAR_OPERATIONAL_KEEP_ACCOUNTING: { trading: true, accounting: false },
  CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK: { trading: true, accounting: false, keepStock: true, catalogue: true },
  ALL_BUSINESS_DATA: { trading: true, accounting: true, master: true },
  FULL_SETUP_RESET: { trading: true, accounting: true, master: true, team: true, structure: true },
});

/** Kept by every mode, in every circumstance, and asserted by the audit. */
const NEVER_REMOVED = Object.freeze([
  'businesses', 'client_settings', 'gl_accounts', 'wht_rates', 'audit_log', 'data_cleanup_log',
]);

const inClause = (ids) => `(${ids.map(() => '?').join(',')})`;

/**
 * WHAT EACH TABLE CAN BE SCOPED BY, read from the live schema rather than assumed.
 *
 * This exists because of a real defect the integration test caught: `serial_numbers`
 * and `stock_transfer_items` were scoped through `branches`, and `branches` is only
 * part of a plan during a full reset — so every other mode silently SKIPPED those
 * two tables and left serials and transfer lines behind after "clearing all
 * business data". The plan says what depends on what; the schema says how to scope
 * it, and a table added by a future migration is handled without editing this file.
 */
async function describeSchema(db) {
  const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  const schema = {};
  for (const row of rows) {
    const cols = await db.all(`PRAGMA table_info(${row.name})`);
    schema[String(row.name)] = {
      hasBusinessId: cols.some((c) => c.name === 'business_id'),
      hasBranchId: cols.some((c) => c.name === 'branch_id'),
    };
  }
  return schema;
}

function planFor(mode, { businessIds = [], actorId = null, schema = null } = {}) {
  const spec = PLANS[String(mode).toUpperCase()];
  if (!spec) throw new Error(`Unknown cleanup mode "${mode}".`);
  const steps = [];
  if (spec.trading) steps.push(...TRADING.map((s) => ({ ...s })));
  // The keep-stock mode prunes the catalogue instead of keeping it, so it takes the
  // catalogue steps WITHOUT the partner steps: a customer and a supplier are master
  // data in every mode, and pruning a customer because nobody bought from them this
  // year would be a data loss the shop never asked for.
  if (spec.catalogue) steps.push(...CATALOGUE.map((s) => ({ ...s })));
  if (spec.master) steps.push(...MASTER.map((s) => ({ ...s })));
  if (spec.accounting) steps.push(...ACCOUNTING.map((s) => ({ ...s })));
  if (spec.team) steps.push(...TEAM.map((s) => ({ ...s })));
  if (spec.structure) steps.push(...STRUCTURE.map((s) => ({ ...s })));
  return { mode: String(mode).toUpperCase(), spec, steps, businessIds: businessIds.map(String), actorId: actorId ? String(actorId) : null, keepStock: Boolean(spec.keepStock), schema };
}

/** A parent outside the plan, scoped by the business it belongs to. */
function parentScope(parent, plan) {
  const ids = plan.businessIds;
  if (!ids.length) return null;
  const cols = plan.schema && plan.schema[parent];
  if (cols && cols.hasBusinessId) return { where: `business_id IN ${inClause(ids)}`, params: [...ids] };
  if (cols && cols.hasBranchId) return { where: `branch_id IN (SELECT id FROM branches WHERE business_id IN ${inClause(ids)})`, params: [...ids] };
  return null;
}

/** A table with no business of its own but a branch: scope it through the branch. */
function branchScope(step, plan, { startDate = null, endDate = null } = {}) {
  const ids = plan.businessIds;
  if (!ids.length) return null;
  const parts = [`branch_id IN (SELECT id FROM branches WHERE business_id IN ${inClause(ids)})`];
  const params = [...ids];
  if (plan.spec.dated && step.date && startDate && endDate) {
    parts.push(`${step.date} >= ? AND ${step.date} < ?`);
    params.push(startDate, endDate);
  }
  return { where: parts.join(' AND '), params };
}

/** Scope only: which rows this step is allowed to consider. */
function scopeFor(step, plan, { startDate = null, endDate = null } = {}) {
  const ids = plan.businessIds;
  const params = [];

  if (step.via) {
    const [parent, column] = step.via;
    const parentStep = plan.steps.find((s) => s.t === parent);
    // THE PARENT'S OWN CONDITION, RECURSIVELY — and the parent does NOT have to be
    // part of this plan. `branches` is planning to be deleted only in a full reset,
    // but a serial number still belongs to a branch on every other mode, and
    // skipping the step instead of scoping through the parent is what left serials
    // and transfer lines behind. A parent outside the plan is scoped by its own
    // `business_id` when it has one.
    const parentCond = parentStep
      ? effectiveWhere(parentStep, plan, { startDate, endDate })
      : parentScope(parent, plan);
    if (!parentCond) return null;
    return { where: `${column} IN (SELECT id FROM ${parent} WHERE ${parentCond.where})`, params: parentCond.params };
  }

  if (!ids.length) return null;
  const cols = plan.schema && plan.schema[step.t];
  if (step.biz) {
    // `biz` is the plan's intent; the schema is the fact. A table declared
    // business-scoped that has no business_id is a plan bug, and the safe reading
    // of the schema wins.
    if (cols && !cols.hasBusinessId && cols.hasBranchId) return branchScope(step, plan, { startDate, endDate });
    if (cols && !cols.hasBusinessId && !cols.hasBranchId) return null;
  }
  if (!step.biz) return null;
  const parts = [`business_id IN ${inClause(ids)}`];
  params.push(...ids);
  if (plan.spec.dated && step.date && startDate && endDate) {
    parts.push(`${step.date} >= ? AND ${step.date} < ?`);
    params.push(startDate, endDate);
  }
  if (step.only === 'users') {
    // THE TWO PEOPLE WHO MUST SURVIVE A FULL RESET: every administrator (the
    // platform's own account, which the handover promises exists) and the person
    // running the reset. Deleting the last administrator would lock the client out
    // of their own deployment with no way back in.
    parts.push("role <> 'ADMIN'");
    if (plan.actorId) { parts.push('id <> ?'); params.push(plan.actorId); }
  }
  return { where: parts.join(' AND '), params };
}

/**
 * The exception that KEEPS rows a mode promises to keep — and, through rule 3,
 * that a child inherits from its parent.
 *
 *   batches    With stock in it stays; an empty one goes. This is what makes the
 *              mode useful: the shop keeps the shelf and loses the history of how
 *              it got there.
 *   products   A product stays if a KEPT batch references it.
 *   suppliers  A supplier stays if a KEPT batch still points at one — the batches
 *              that stay have their supplier link detached, which is the cleaner
 *              answer and is what `preparationsFor` does first.
 */
function exceptionFor(step, plan) {
  if (!plan.keepStock) return null;
  const ids = plan.businessIds;
  const kept = `SELECT DISTINCT product_id FROM stock_batches WHERE business_id IN ${inClause(ids)} AND quantity > 0`;
  if (step.t === 'stock_batches') return { sql: 'quantity > 0', params: [] };
  if (step.t === 'products') return { sql: `id IN (${kept})`, params: [...ids] };
  if (step.t === 'suppliers') return { sql: `id IN (SELECT DISTINCT supplier_id FROM stock_batches WHERE business_id IN ${inClause(ids)} AND quantity > 0 AND supplier_id IS NOT NULL)`, params: [...ids] };
  // A serial is the IDENTITY of a unit on the shelf. Keeping the batch and
  // deleting the serial would leave seven fridges the shop can count and cannot
  // identify — and the warranty is claimed against the serial, not the batch.
  //
  // AND THE COLUMN IS NULLABLE. `NOT (batch_id IN (kept))` is NULL — not false —
  // when `batch_id` is NULL, SQLite treats a NULL condition as a failed one, and the
  // row therefore escaped BOTH the delete and the keep: a serial with no batch is not
  // stock on a shelf, so it goes, and this says so explicitly instead of relying on
  // three-valued logic to agree.
  if (step.t === 'serial_numbers') return { sql: `batch_id IS NOT NULL AND batch_id IN (SELECT id FROM stock_batches WHERE business_id IN ${inClause(ids)} AND quantity > 0)`, params: [...ids] };
  return null;
}

/** Scope AND the exception — the condition a step actually runs under. */
function effectiveWhere(step, plan, window, seen = new Set()) {
  const scope = scopeFor(step, plan, window);
  if (!scope) return null;
  const keep = exceptionFor(step, plan);
  if (!keep) return scope;
  return { where: `${scope.where} AND NOT (${keep.sql})`, params: [...scope.params, ...keep.params] };
}

async function countStep(db, step, plan, window) {
  const cond = effectiveWhere(step, plan, window);
  if (!cond) return null;
  const row = await db.first(`SELECT COUNT(*) AS c FROM ${step.t} WHERE ${cond.where}`, cond.params);
  return Number((row && row.c) || 0);
}

async function deleteStep(db, step, plan, window) {
  const cond = effectiveWhere(step, plan, window);
  if (!cond) return 0;
  let removed = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const res = await db.run(
      `DELETE FROM ${step.t} WHERE rowid IN (SELECT rowid FROM ${step.t} WHERE ${cond.where} LIMIT ${CHUNK})`,
      cond.params,
    );
    const changes = Number((res && res.changes) || 0);
    removed += changes;
    if (changes < CHUNK) break;
  }
  return removed;
}

/**
 * THE FIX-UPS THAT MUST HAPPEN BEFORE THE DELETES, because a foreign key would
 * otherwise refuse the deletion or because the link would outlive its target.
 *
 * Detaching is not a technicality: a kept batch whose supplier is deleted would
 * either block the cleanup or point at a supplier the shop no longer has.
 */
function preparationsFor(plan) {
  const out = [];
  for (const id of plan.businessIds) {
    if (plan.keepStock) {
      out.push({ what: 'detach the kept batches from their purchase orders', sql: "UPDATE stock_batches SET purchase_order_id = NULL, updated_at = datetime('now') WHERE business_id = ? AND quantity > 0", params: [id] });
      if (plan.spec.master) {
        out.push({ what: 'detach the kept batches from their suppliers', sql: "UPDATE stock_batches SET supplier_id = NULL, updated_at = datetime('now') WHERE business_id = ? AND quantity > 0", params: [id] });
      }
    }
    if (plan.spec.team) {
      out.push({ what: 'leave no settings row attributed to a deleted user', sql: "UPDATE client_settings SET updated_by = NULL WHERE updated_by IS NOT NULL AND updated_by IN (SELECT id FROM users WHERE business_id = ? AND role <> 'ADMIN' AND id <> ?)", params: [id, plan.actorId || ''] });
      out.push({ what: 'leave no conflict reviewed by a deleted user', sql: "UPDATE sync_conflicts SET reviewed_by = NULL WHERE reviewed_by IS NOT NULL AND reviewed_by IN (SELECT id FROM users WHERE business_id = ? AND role <> 'ADMIN' AND id <> ?)", params: [id, plan.actorId || ''] });
    }
    if (plan.spec.structure) {
      // Rows about a branch that is about to stop existing. The sync log and the
      // conflicts keep their history with no branch attached; device status is
      // per-branch by primary key and cannot be left dangling.
      out.push({ what: 'detach the sync log from a branch being removed', sql: "UPDATE sync_change_log SET branch_id = NULL WHERE branch_id IN (SELECT id FROM branches WHERE business_id = ?)", params: [id] });
      out.push({ what: 'detach the conflicts from a branch being removed', sql: "UPDATE sync_conflicts SET branch_id = NULL WHERE branch_id IN (SELECT id FROM branches WHERE business_id = ?)", params: [id] });
      out.push({ what: 'detach every surviving user from a branch being removed', sql: "UPDATE users SET branch_id = NULL WHERE branch_id IN (SELECT id FROM branches WHERE business_id = ?)", params: [id] });
    }
  }
  return out;
}

/**
 * The whole run. Counts first, then deletes, then reports what actually happened.
 * The counts and the deletions come from the same predicate, so a preview cannot
 * promise something the run does not do.
 */
async function runPurge(db, mode, { businessIds = [], actorId = null, startDate = null, endDate = null, dryRun = false } = {}) {
  const schema = await describeSchema(db);
  const plan = planFor(mode, { businessIds, actorId, schema });
  const window = { startDate, endDate };
  const removed = {};
  const skipped = [];
  const failed = [];

  if (!plan.businessIds.length) {
    return { mode: plan.mode, dryRun: Boolean(dryRun), removed: {}, total: 0, skipped: plan.steps.map((s) => s.t), failed: [{ table: null, error: 'no business was in scope, so nothing was removed' }], businessIds: [] };
  }

  if (!dryRun) {
    for (const prep of preparationsFor(plan)) {
      try { await db.run(prep.sql, prep.params); } catch (err) { failed.push({ table: prep.what, error: err && err.message ? err.message : String(err) }); }
    }
  }

  for (const step of plan.steps) {
    try {
      const cond = effectiveWhere(step, plan, window);
      if (!cond) { skipped.push(step.t); removed[step.t] = null; continue; }
      if (dryRun) { removed[step.t] = await countStep(db, step, plan, window); continue; }
      removed[step.t] = await deleteStep(db, step, plan, window);
    } catch (err) {
      failed.push({ table: step.t, error: err && err.message ? err.message : String(err) });
      removed[step.t] = null;
    }
  }

  const total = Object.values(removed).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return { mode: plan.mode, dryRun: Boolean(dryRun), removed, total, skipped, failed, businessIds: plan.businessIds };
}

module.exports = {
  planFor, runPurge, countStep, deleteStep, effectiveWhere, exceptionFor, preparationsFor, describeSchema,
  TRADING, MASTER, ACCOUNTING, TEAM, STRUCTURE, PLANS, NEVER_REMOVED, CHUNK,
};
