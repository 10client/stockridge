'use strict';
// =====================================================================
// server/lib/respond.js — SHARED ROUTE HELPERS
// =====================================================================
// Every route in this system answers the same three questions before it does
// any work:
//
//   1. WHICH BUSINESS is this? (a deployment holds several legal entities)
//   2. WHICH BRANCH?           (a business holds several shops)
//   3. MAY THIS USER SEE IT?   (role + scope)
//
// Getting those wrong is not a cosmetic bug. It is one branch's cashier reading
// another branch's takings, or a manager of the furniture shop seeing the
// electronics shop's debtor book. So the answers are computed HERE, once, and
// every route consumes them — rather than each route re-deriving scoping from
// the token and getting it subtly differently.
//
// THE RULE THAT MAKES THIS SAFE
//
// A request may NARROW its scope (an owner asking for one branch) but may never
// WIDEN it (a cashier asking for all branches). `resolveBranch` and
// `scopeFilter` both enforce that by intersecting what was asked for with what
// the user is allowed, and refusing when the intersection is empty.
// =====================================================================

const { HttpError } = require('./http');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/**
 * The branch a request operates on.
 *
 * A user pinned to a branch (MANAGER, STAFF) always gets their own, whatever
 * the query string says — accepting a `branch_id` from them would be the whole
 * multi-branch isolation bug in one line. An unpinned user (OWNER, ADMIN, or a
 * general MANAGER) may name a branch, and must if the operation needs one.
 */
/**
 * A branch id named in a request body, if this request has one.
 *
 * Deliberately tolerant: an unparseable or absent body returns null so the
 * caller can raise its own, better-targeted error rather than a JSON parse
 * failure from a helper that was only trying to help.
 */
async function branchIdFromBody(ctx, param) {
  const method = String(ctx.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;
  try {
    const body = await ctx.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const value = body[param];
    return value === undefined || value === null || value === '' ? null : String(value);
  } catch (e) {
    return null;
  }
}

async function resolveBranch(db, ctx, { required = true, param = 'branch_id' } = {}) {
  const scope = ctx.get('scope');
  const user = ctx.get('user');
  if (!scope) throw new HttpError('Please sign in to continue.', { status: 401, code: 'NO_TOKEN' });

  // Where the branch may be named, in order of explicitness:
  //   1. the query string or the path — a URL parameter is the clearest place;
  //   2. the request BODY, for a POST that carries its own payload.
  //
  // (2) matters more than it looks. A manager transferring stock POSTs
  // { from_branch_id, to_branch_id } with no query string, and an owner creating
  // a staff member POSTs { branch_id }. Reading only the query meant both got
  // "Choose which branch this applies to" while the answer was sitting in the
  // body they had just written — a screen that was already built and could
  // never work. GET/HEAD have no body, so nothing changes for reads.
  const requested = ctx.req.queryParam(param) || ctx.req.param(param) || await branchIdFromBody(ctx, param);
  let branchId = scope.pinnedBranchId || requested;

  if (!branchId && scope.branchIds && scope.branchIds.size === 1) {
    branchId = [...scope.branchIds][0];
  }
  if (!branchId) {
    // An owner with several branches has to say which one. Guessing would post
    // stock or cash against the wrong shop.
    if (required) {
      throw new HttpError(
        'Choose which branch this applies to. You have access to more than one, and the system will not guess — stock, cash and reports all belong to a specific shop.',
        { status: 400, code: 'BRANCH_REQUIRED' },
      );
    }
    return null;
  }

  const branch = await db.first('SELECT * FROM branches WHERE id = ? AND is_deleted = 0', [String(branchId)]);
  if (!branch) throw new HttpError('That branch does not exist.', { status: 404, code: 'BRANCH_NOT_FOUND' });
  if (!Number(branch.is_active)) {
    throw new HttpError(`"${branch.name}" is deactivated. Reactivate it under Admin before trading through it.`, { status: 409, code: 'BRANCH_INACTIVE' });
  }
  if (!inScope(scope, { branch_id: branch.id, business_id: branch.business_id })) {
    throw new HttpError('That branch belongs to a different business or is outside your access. You can only work in the branches you are assigned to.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
  }
  void user;
  return branch;
}

/**
 * The business a request operates on, resolved from its branch where possible.
 *
 * Resolution order, and the reason for each step:
 *
 *   1. the branch the request already resolved to — always the most specific,
 *      most trustworthy answer;
 *   2. the caller's pinned business (OWNER of one legal entity);
 *   3. the caller's ONLY accessible business, which is the common single-entity
 *      deployment and needs no question asked;
 *   4. the explicit `?business_id=` param;
 *   5. THE DEPLOYMENT'S PRIMARY BUSINESS from client_settings.
 *
 * Step 5 is what makes the platform administrator (ADMIN, deliberately unpinned
 * because the vendor sets the deployment up before any business exists) able to
 * reach the ~25 endpoints that need a business. Without it an ADMIN signs in
 * successfully and then gets BUSINESS_REQUIRED from the dashboard, the
 * catalogue, the ledger and everything else — a broken-looking app for exactly
 * the account that has to work first.
 *
 * It is safe because ADMIN scope is `allBusinesses`, so the fallback cannot
 * widen anybody's access: steps 1–4 have already run, and the scope check below
 * still runs on whatever we land on. A tiered, multi-entity deployment simply
 * gets the primary entity, which is the same thing the UI shows on first load.
 */
async function resolveBusiness(db, ctx, branch = null) {
  const scope = ctx.get('scope');
  const requested = ctx.req.queryParam('business_id');

  let businessId = (branch && branch.business_id) || scope.pinnedBusinessId || null;

  if (!businessId && scope.businessIds && scope.businessIds.size === 1) {
    // Exactly one business in reach: that is unambiguous, so use it rather than
    // making a single-shop merchant answer a question with one possible answer.
    businessId = [...scope.businessIds][0];
  }
  if (!businessId) businessId = requested;
  if (!businessId && scope.allBusinesses) {
    const settings = await db.first('SELECT primary_business_id FROM client_settings WHERE id = 1');
    businessId = (settings && settings.primary_business_id) || null;
  }
  if (!businessId) {
    // Last resort for an unpinned administrator on a deployment whose primary
    // entity was never recorded: the oldest live business is the one that was
    // provisioned first, which is the deployment's own entity.
    if (scope.allBusinesses) {
      const first = await db.first('SELECT id FROM businesses WHERE is_deleted = 0 ORDER BY created_at, id LIMIT 1');
      businessId = (first && first.id) || null;
    }
  }
  if (!businessId) {
    throw new HttpError('Choose which business this applies to.', { status: 400, code: 'BUSINESS_REQUIRED' });
  }
  const business = await db.first('SELECT * FROM businesses WHERE id = ? AND is_deleted = 0', [String(businessId)]);
  if (!business) throw new HttpError('That business does not exist.', { status: 404, code: 'BUSINESS_NOT_FOUND' });
  if (!scope.allBusinesses && !(scope.businessIds && scope.businessIds.has(String(businessId)))) {
    throw new HttpError('That business is outside your access.', { status: 403, code: 'BUSINESS_SCOPE_VIOLATION' });
  }
  return business;
}

/** May this user see this row? Branch wins; business is the fallback. */
function inScope(scope, row) {
  if (!scope) return false;
  if (scope.allBusinesses && scope.allBranches) return true;
  const branchId = row && row.branch_id ? String(row.branch_id) : null;
  const businessId = row && row.business_id ? String(row.business_id) : null;
  if (branchId && scope.branchIds) {
    // A row with no branch (a shared catalogue entry, a vendor-level setting)
    // is visible to everybody; a row WITH a branch is visible only inside it.
    if (!scope.branchIds.has(branchId)) return false;
  }
  if (businessId && scope.businessIds && !scope.businessIds.has(businessId)) return false;
  return true;
}

/**
 * Throw unless the row is inside the caller's scope.
 *
 * Deliberately never returns a branch_id to "fix up" the row with. Reparenting a
 * record to another branch is a transfer with its own audit trail, not something
 * a read path may do quietly.
 */
function assertRowAccess(scope, row, label = 'That record') {
  if (!row) return null;
  if (!inScope(scope, row)) {
    throw new HttpError(`${label} belongs to another branch or business. You can only work with records from the branches you are assigned to.`, { status: 403, code: 'SCOPE_VIOLATION' });
  }
  return row;
}

/**
 * A WHERE fragment that constrains a list query to the caller's scope.
 *
 * Returns `{ sql, params }`. `sql` is empty for an owner/admin with everything,
 * so the common case costs nothing.
 *
 * Rows with a NULL branch are INCLUDED for scoped users: a shared catalogue
 * product or a vendor-level setting has no branch and must not vanish from a
 * cashier's product search. That is the same reasoning the audit log uses.
 */
function scopeFilter(scope, { branchColumn = 'branch_id', businessColumn = 'business_id', alias = '' } = {}) {
  const b = alias ? `${alias}.${branchColumn}` : branchColumn;
  const s = alias ? `${alias}.${businessColumn}` : businessColumn;
  const clauses = [];
  const params = [];

  if (!scope.allBranches && scope.branchIds && scope.branchIds.size) {
    const ids = [...scope.branchIds];
    clauses.push(`(${b} IS NULL OR ${b} IN (${ids.map(() => '?').join(',')}))`);
    params.push(...ids);
  }
  if (!scope.allBusinesses && scope.businessIds && scope.businessIds.size) {
    const ids = [...scope.businessIds];
    clauses.push(`(${s} IS NULL OR ${s} IN (${ids.map(() => '?').join(',')}))`);
    params.push(...ids);
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '', params };
}

/** Append a scope filter to a WHERE list without producing a dangling AND. */
function pushScope(where, params, scope, opts) {
  const f = scopeFilter(scope, opts);
  if (f.sql) { where.push(f.sql); params.push(...f.params); }
  return f;
}

/**
 * Pagination that cannot be abused.
 *
 * The ceiling matters more than the default: an unbounded `limit` on a sales
 * table is how a tablet on 3G asks for forty thousand rows and never comes
 * back. OFFSET pagination is used deliberately over cursors because the tables
 * here are small enough per branch that it is simpler, and every list is
 * ordered by a stable key so pages cannot skip or repeat.
 */
function pagination(ctx) {
  const rawLimit = Number(ctx.req.queryParam('limit'));
  const rawOffset = Number(ctx.req.queryParam('offset'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

/** Shape every list response identically so the client can page generically. */
function listResponse(rows, { limit, offset }, total = null) {
  return {
    ok: true,
    data: rows,
    paging: {
      limit, offset,
      returned: rows.length,
      total,
      hasMore: total == null ? rows.length === limit : offset + rows.length < total,
      nextOffset: rows.length === limit ? offset + limit : null,
    },
  };
}

/** Read and validate a date-range filter. */
function dateRange(ctx, { fromParam = 'from', toParam = 'to', defaultDays = 30 } = {}) {
  const { watToday, addDays } = require('../../domain/time');
  const to = ctx.req.queryParam(toParam) || watToday();
  const from = ctx.req.queryParam(fromParam) || addDays(to, -defaultDays);
  for (const [label, value] of [['from', from], ['to', to]]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      throw new HttpError(`The ${label} date must be YYYY-MM-DD (you sent "${value}").`, { status: 400, code: 'INVALID_DATE' });
    }
  }
  if (from > to) {
    throw new HttpError(`The from date (${from}) is after the to date (${to}).`, { status: 400, code: 'INVALID_DATE_RANGE' });
  }
  return { from, to };
}

/** A single value from the body, or a 400 naming the field. */
function requireField(body, field, label = field) {
  const value = body ? body[field] : undefined;
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new HttpError(`${label} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: `${label} is required.` } });
  }
  return typeof value === 'string' ? value.trim() : value;
}

/** A boolean query flag, defaulting to false. */
function flag(ctx, name) {
  const v = ctx.req.queryParam(name);
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Unwrap a domain validator result, or throw a 400 that names the field.
 *
 * Every validator in domain/validation.js returns `{ ok, value }` or
 * `{ ok:false, code, error }` rather than throwing, so that the POS can collect
 * several field errors and show them together. A route that forgets to unwrap
 * stores the RESULT OBJECT where a number belongs — `Number({ok:true})` is NaN,
 * which then lands in a money column as 0 or fails a CHECK three layers away.
 * This helper makes the unwrap impossible to forget.
 */
function valid(result, field) {
  if (!result || result.ok !== true) {
    const error = (result && result.error) || `${field} is not valid.`;
    throw new HttpError(error, { status: 400, code: (result && result.code) || 'INVALID_FIELD', fields: { [field]: error } });
  }
  return result.value;
}

/**
 * Parse a number for a route body.
 *
 * Deliberately NOT domain/validation.js `quantity()`, which rejects zero: a
 * reorder level of 0 ("never alert on this") and a commission rate of 0 are both
 * legitimate, and a validator that refuses them pushes merchants into entering 1
 * instead, which is worse than the zero they meant.
 */
function numField(value, { field = 'This number', min = null, max = null, whole = false, required = false, fallback = 0, places = 2 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw new HttpError(`${field} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: `${field} is required.` } });
    return fallback;
  }
  const cleaned = String(value).replace(/[₦,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new HttpError(`${field} must be a number (you sent “${String(value).slice(0, 40)}”).`, { status: 400, code: 'NOT_A_NUMBER', fields: { [field]: 'Must be a number.' } });
  }
  if (whole && !Number.isInteger(n)) {
    throw new HttpError(`${field} must be a whole number — ${n} is not.`, { status: 400, code: 'NOT_WHOLE', fields: { [field]: 'Must be a whole number.' } });
  }
  if (min !== null && n < min) throw new HttpError(`${field} cannot be less than ${min}.`, { status: 400, code: 'TOO_SMALL', fields: { [field]: `Minimum is ${min}.` } });
  if (max !== null && n > max) throw new HttpError(`${field} cannot be more than ${max}.`, { status: 400, code: 'TOO_LARGE', fields: { [field]: `Maximum is ${max}.` } });
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

/** A trimmed string, or null when blank, with a hard length cap. */
function strField(value, { field = 'This text', maxLength = 500, required = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw new HttpError(`${field} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: `${field} is required.` } });
    return null;
  }
  const s = String(value).trim();
  if (s.length > maxLength) {
    throw new HttpError(`${field} must be ${maxLength} characters or fewer (you entered ${s.length}).`, { status: 400, code: 'TOO_LONG', fields: { [field]: `Maximum ${maxLength} characters.` } });
  }
  return s;
}

/** A 0/1 flag from any of the shapes a client might send. */
function boolField(value, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return 1;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return 0;
  return fallback;
}

module.exports = {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  valid, numField, strField, boolField,
  resolveBranch, resolveBusiness, inScope, assertRowAccess,
  scopeFilter, pushScope, pagination, listResponse, dateRange, requireField, flag,
};
