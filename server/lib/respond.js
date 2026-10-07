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
const { businessFilter } = require('../../domain/access');

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
/** Read an id out of a POST body. Named for ids in general, not just branches: a
 *  POST that carries the business it is about has said so as plainly as one that
 *  carries a branch, and both are read the same way. */
async function idFromBody(ctx, param) {
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

async function resolveBranch(db, ctx, { required = true, param = 'branch_id', fallback = null } = {}) {
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
  const requested = ctx.req.queryParam(param) || ctx.req.param(param) || await idFromBody(ctx, param);
  const pinned = scope.pinnedBranchId || null;

  // A NAMED BRANCH THAT IS NOT YOURS IS REFUSED, NOT SILENTLY SWAPPED.
  //
  // `pinned` used to win outright, so a cashier or a branch-pinned manager who
  // named another branch had the request quietly rewritten to their own: the
  // write landed on a different shop from the one the caller asked for, and the
  // success message named the substituted branch — for stock or cash, a
  // mis-posting nobody would notice until the count. It surfaced through
  // compliance records, where a manager posting a licence for the other store got
  // a 201 for their own store instead of a refusal.
  //
  // The pin is still the answer when nothing is named, and still wins when it
  // agrees with what was named. It only stops being a way to answer a question
  // that was asked about somewhere else.
  // ...AND A PIN ONLY REFUSES WHAT THE SCOPE CANNOT REACH.
  //
  // The rule above was right about a pinned manager and wrong about everybody else,
  // and the difference only shows on a deployment whose data has drifted from its
  // intent. An OWNER whose row happens to carry a `branch_id` — which is what an
  // owner created from inside a branch looks like — has `allBranches` scope: they
  // READ every branch, every report, every transfer. But the pin check fired before
  // the scope was consulted, so every WRITE naming another branch was refused with
  // "You can only work in the branch you are assigned to", while the same screen
  // happily showed them that branch. Found by the live write-mode run of
  // test/audit/audit.http.js against staging, where the owner seat carries a branch.
  //
  // The pin is a real constraint for the roles it exists for — a MANAGER is the
  // manager OF somewhere, and the compliance-record defect that put this check here
  // is still refused. What it must not be is a way to refuse a branch the caller's
  // scope already reaches: that is not a security boundary, it is an inconsistency
  // between what a person can see and what they can do about it.
  const reaches = (id) => {
    if (!id) return false;
    // Reaches every branch outright (owner, administrator), or the branch is in the
    // granted set (a business-scoped manager, a branch-pinned one naming their own).
    if (scope.allBranches && !scope.branchIds) return true;
    if (scope.branchIds && scope.branchIds.has(String(id))) return true;
    return false;
  };
  if (pinned && requested && String(requested) !== String(pinned) && !reaches(requested)) {
    throw new HttpError('That request names a branch outside your access. You can only work in the branch you are assigned to.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
  }
  // A ROW-SCOPED ACTION ALREADY NAMES ITS BRANCH — and asking for it a second time is a
  // wall in front of a button that cannot work.
  //
  // `POST /api/tills/:id/close` and `POST /api/sales/:id/pay` address ONE row, and both
  // load that row (with its `branch_id`) before calling this function — the close even
  // compares the two afterwards. But a multi-branch OWNER with no branch of their own was
  // refused outright with "Choose which branch this applies to", while the screens that
  // call them (public/js/views/till.js, sales.js) send no branch at all: Close Drawer and
  // Record Payment could only ever answer 400 for exactly the client this product is for.
  // Found by test/audit/audit.money.js the moment its fixture grew a second branch, which
  // is the shape a real deployment has.
  //
  // The row's branch is used only when the caller REACHES it — the same rule a named
  // branch gets — so nothing is opened up: a cashier who guesses another shop's till id
  // still has their PIN win first, and the endpoint still refuses the mismatch.
  const rowBranch = fallback && reaches(fallback) ? String(fallback) : null;

  // What was ASKED FOR, when the caller was allowed to ask for it. The pin remains the
  // answer when nothing is named, which is the case it was written for.
  let branchId = requested || pinned || rowBranch;

  if (!branchId && scope.branchIds && scope.branchIds.size === 1) {
    branchId = [...scope.branchIds][0];
  }
  // ONE BRANCH IS NOT A GUESS.
  //
  // The fallback above — "if the scope names exactly one branch, use it" — is written
  // against `scope.branchIds`, and an OWNER or a vendor ADMINISTRATOR has no branch
  // list at all, because reaching every branch is expressed by carrying none. So the
  // people most likely to have a single shop were the ones the fallback could never
  // help: a shop with one shop was told "You have access to more than one, and the
  // system will not guess" — a sentence that is untrue, on a screen that offers nothing
  // to choose from. Found by test/audit/audit.money.js, which could not create a
  // customer on a one-branch deployment without naming the branch it had just created.
  //
  // So before refusing, COUNT what the caller can actually reach. Exactly one live
  // branch, and it is the answer. Two or more, and the refusal below stands, because
  // guessing there would post stock or cash against the wrong shop.
  if (!branchId) {
    const f = scopeFilter(scope, { alias: 'b' });
    const reachable = await db.all(
      `SELECT b.id FROM branches b WHERE b.is_deleted = 0 AND b.is_active = 1${f.sql ? ` AND ${f.sql}` : ''} LIMIT 2`,
      f.params,
    );
    if (reachable.length === 1) branchId = String(reachable[0].id);
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
async function resolveBusiness(db, ctx, branch = null, { required = true } = {}) {
  const scope = ctx.get('scope');
  // Mirrors resolveBranch: a request that reached here without a scope is not a
  // server error, it is an unauthenticated one. Without this it was a TypeError.
  if (!scope) throw new HttpError('Please sign in to continue.', { status: 401, code: 'NO_TOKEN' });
  // The body counts, for the same reason it does for branches: a POST carries its
  // own payload, and a client that says `{ business_id }` has answered the
  // question. (The client's sync pull sends `branch_id` in the body for exactly
  // this reason.) The scope check below still refuses anything out of reach.
  const requested = ctx.req.queryParam('business_id') || await idFromBody(ctx, 'business_id');

  // PRECEDENCE, strongest first:
  //   1. the business the named branch belongs to — a branch cannot be in two
  //      businesses, so this is a fact rather than a preference;
  //   2. an explicitly requested business_id, BUT ONLY IF THE CALLER MAY REACH IT.
  //      This is what lets one owner run several businesses: without it, the
  //      request was ignored and the owner was silently shown whichever business
  //      their row happened to name. The scope check below refuses the rest.
  //   3. the business on the caller's own row;
  //   4. the only business in scope, when there is exactly one;
  //   5. the deployment's recorded primary business;
  //   6. the oldest live business — the last resort for an unpinned administrator,
  //      and the fallback that made a wrong assignment look successful.
  let businessId = (branch && branch.business_id) || null;

  if (requested) {
    const reachable = scope.allBusinesses || (scope.businessIds && scope.businessIds.has(String(requested)));
    if (!reachable) {
      // REFUSED, NOT IGNORED.
      //
      // Silently falling back to the caller's own business is the "successfully
      // wrong" pattern this codebase keeps finding: a 200 with somebody else's
      // numbers under the label the client asked for. A request that names a
      // business outside the caller's scope is an error, and says so.
      throw new HttpError('That business is outside your access.', { status: 403, code: 'BUSINESS_SCOPE_VIOLATION' });
    }
    if (!businessId) businessId = String(requested);
  }
  // THE PIN ANSWERS A WRITE, NOT A READ.
  //
  // `scope.pinnedBusinessId` is the business on the caller's own row. It is the
  // right target for a write that named nothing — a new product has to belong to
  // some business, and the caller's own entity is the sensible answer. It is NOT
  // a statement about what the caller may see: every OWNER has both allBusinesses
  // and a business_id, so using the pin to narrow a read silently hides the other
  // businesses they demonstrably reach. (An OWNER is exactly the role that grows a
  // second business.)
  if (required && !businessId) businessId = scope.pinnedBusinessId || null;

  if (!businessId && scope.businessIds && scope.businessIds.size === 1) {
    // Exactly one business in reach: that is unambiguous, so use it rather than
    // making a single-shop merchant answer a question with one possible answer.
    businessId = [...scope.businessIds][0];
  }
  if (required && !businessId && scope.allBusinesses) {
    // (A write with nothing named gets the deployment's recorded primary entity.)
    const settings = await db.first('SELECT primary_business_id FROM client_settings WHERE id = 1');
    businessId = (settings && settings.primary_business_id) || null;
  }
  if (!businessId && required) {
    // Last resort for an unpinned administrator on a deployment whose primary
    // entity was never recorded: the oldest live business is the one that was
    // provisioned first, which is the deployment's own entity.
    if (scope.allBusinesses) {
      const first = await db.first('SELECT id FROM businesses WHERE is_deleted = 0 ORDER BY created_at, id LIMIT 1');
      businessId = (first && first.id) || null;
    }
  }
  if (!businessId) {
    // A READ MUST NOT BE NARROWED BY A GUESS.
    //
    // Steps 5 and 6 above choose a business for a request that did not name one,
    // and for a WRITE that is necessary: a row needs a business_id, and something
    // has to be chosen. For a READ it is a lie. `required: false` is what a read
    // passes, and it means "the business this request named — or nothing at all,
    // rather than the one I would have picked for you":
    //
    //   * a caller who reaches every business and names none sees every business,
    //     because that is what reaching every business means;
    //   * a caller granted two businesses and naming none is already narrowed
    //     correctly by pushScope, and must not be narrowed again to the one the
    //     platform would have guessed;
    //   * a caller with exactly one business in reach never gets here — step 4
    //     answered, and that is not a guess, it is the only answer there is.
    //
    // This was found on a live deployment with two businesses. An ADMIN recorded a
    // licence against a branch of the newer business and then could not see it: the
    // write took its business from the named branch (a fact), the read guessed the
    // OLDEST business (a coin toss), and the register came back empty while the
    // duplicate-record guard cheerfully refused to make a second one. The same
    // narrowing sat on the chart of accounts, the journal, VAT, WHT, the creditor
    // book and eight reports. `dashboard.js` had already worked this out for itself
    // — `isOwnerView ? null : await resolveBusiness(...)` — and every other read had
    // not.
    if (!required) return null;
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
/**
 * May this caller see this row?
 *
 * IT READS `row.branch_id`, SO IT IS FOR ROWS THAT CARRY ONE — a sale, a batch, a
 * return, a user. It is NOT for a BRANCH row, which identifies itself as `row.id`:
 * passing a branch leaves `branchId` null, skips the branch check entirely, and
 * answers on the business alone, so a manager pinned to one branch is told they
 * may reach a sibling branch in the same business. That is not a hypothetical —
 * it let a manager edit another branch's compliance records until `inBranchScope`
 * below was added for exactly this shape.
 */
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
/**
 * May this caller work in this BRANCH?
 *
 * The right question for a branch row, whose id is `id`. Kept separate from
 * `inScope` rather than folded into it, because the two are asked about shapes
 * that differ in exactly the column that decides the answer — see the note on
 * `inScope` above for what folding them together cost.
 */
function inBranchScope(scope, branch) {
  if (!scope) return false;
  if (!branch) return false;
  if (scope.allBranches && scope.allBusinesses) return true;
  if (scope.branchIds && scope.branchIds.size) {
    if (!scope.branchIds.has(String(branch.id))) return false;
  }
  if (scope.businessIds && scope.businessIds.size && branch.business_id) {
    if (!scope.businessIds.has(String(branch.business_id))) return false;
  }
  return true;
}

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
function scopeFilter(scope, { branchColumn = 'branch_id', businessColumn = 'business_id', alias = '', businessViaBranches = false } = {}) {
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
    if (businessViaBranches) {
      // THE TABLE HAS NO business_id OF ITS OWN — `serial_numbers` is the one that matters, and
      // the business it belongs to is the business of the branch holding it. Asking for a column
      // that does not exist is not a refusal, it is a 500: `GET /api/serials` answered
      // "no such column: sn.business_id" for every manager and every staff member who opened the
      // warranty register, while an owner (whose scope covers all businesses) saw the list
      // perfectly. The detail route beside it had already met this and joined `branches` for the
      // business name; the list had not, and nothing caught it because the two roles that hit it
      // were the two no audit had ever signed in as.
      clauses.push(`(${b} IS NULL OR ${b} IN (SELECT id FROM branches WHERE business_id IN (${ids.map(() => '?').join(',')})))`);
    } else {
      clauses.push(`(${s} IS NULL OR ${s} IN (${ids.map(() => '?').join(',')}))`);
    }
    params.push(...ids);
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '', params };
}


/**
 * THE BRANCH A READ NAMED, as a WHERE fragment for a LIST — or a refusal.
 *
 * `scopeFilter` above narrows a read to what the caller is ALLOWED to see. It is the
 * security rule, and it is not the same question as "which branch is this list of?".
 * A caller who may see five branches and who asks for one of them was, until this
 * function existed, given all five: `GET /api/sales?branch_id=X` returned every branch's
 * sales, `GET /api/tills?branch_id=X` returned every branch's drawers, and the summary
 * block above the list reported the whole group's takings under a heading that named one
 * shop. Nothing errored. No figure looked wrong. The only symptom was a number that was
 * larger than the shop it was labelled with — and an OWNER (whose scope reaches every
 * branch) is exactly the caller who gets it, because a branch-pinned MANAGER is saved
 * from it by their own scope.
 *
 * Found by test/audit/audit.money.js against staging: it rings a sale at one branch,
 * reads the sales list back with `?branch_id=<that branch>`, and counted 41 sales it had
 * not made — the other branch's trading, in the same envelope. The receipt-number
 * collision that led there was a red herring; receipt numbers are per branch and were
 * correct all along.
 *
 * THE RULE:
 *   nothing named            → no narrowing (the caller's scope still applies)
 *   a branch they can reach  → `x.branch_id = ?`
 *   a branch they cannot     → 403 BRANCH_SCOPE_VIOLATION, the same refusal a WRITE
 *                              naming somebody else's branch gets from resolveBranch
 *                              above. Silently answering a question about another shop
 *                              with your own shop's rows is the defect this replaces;
 *                              quietly answering it with an empty list would be the same
 *                              lie in a quieter voice.
 *   ?branch_scope=all        → the explicit opt-out, for a screen that really wants the
 *                              group (reports.js has documented it since it was written).
 *                              It cannot widen past the caller's scope — it only stops
 *                              the NAMED branch from narrowing.
 *
 * Rows whose own branch is NULL are business-wide rather than branch-specific (a
 * catalogue line, a settings row), so they stay in every branch's list — the same
 * convention `scopeFilter` and the journal both already use.
 */
async function branchFilter(db, ctx, { alias = '', column = 'branch_id', also = null, nullMeansEveryBranch = true } = {}) {
  const named = ctx.req.queryParam('branch_id') || ctx.req.param('branch_id');
  const optedOut = String(ctx.req.queryParam('branch_scope') || '').toLowerCase() === 'all';
  if (!named || optedOut) return { sql: '', params: [], branchId: null, optedOut };
  const scope = ctx.get('scope');
  if (!scope) throw new HttpError('Please sign in to continue.', { status: 401, code: 'NO_TOKEN' });
  const reaches = Boolean(scope.allBranches)
    || Boolean(scope.branchIds && [...scope.branchIds].some((id) => String(id) === String(named)));
  if (!reaches) {
    throw new HttpError("That request names a branch outside your access. You can only read the branches you are assigned to.", { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
  }
  const cols = [column, ...(also || [])].map((c) => (alias ? `${alias}.${c}` : c));
  const sql = `(${cols.map((c) => (nullMeansEveryBranch ? `(${c} IS NULL OR ${c} = ?)` : `${c} = ?`)).join(' OR ')})`;
  return { sql, params: cols.map(() => String(named)), branchId: String(named), optedOut: false };
}

/**
 * The business restriction a READ should carry, in one call.
 *
 * Reads the business this request NAMED — a branch it points at, an explicit
 * `?business_id=`, the caller's pinned entity — and otherwise falls back to the
 * caller's own SCOPE. It never guesses, which is the whole point:
 *
 *   named / pinned / only-one-in-reach  →  `x.business_id = ?`
 *   caller reaches every business       →  `1 = 1`  (no narrowing: they reach all)
 *   caller granted specific businesses  →  `x.business_id IN (…)`
 *   no scope at all                     →  `1 = 0`  (fail closed)
 *
 * WHY THIS IS ONE FUNCTION. The pattern it replaces was two lines long and
 * repeated across the chart of accounts, the journal, VAT, WHT, the customer
 * classes, the creditor book, the catalogue and every report:
 *
 *     const business = await resolveBusiness(db, ctx);
 *     ... WHERE x.is_deleted = 0 AND (x.business_id = ? OR x.business_id IS NULL)
 *     ..., [String(business.id)]
 *
 * which narrowed every read to ONE business — the one `resolveBusiness` would
 * have picked, which for a caller who reaches several businesses is a guess. On a
 * live deployment with two businesses an administrator could not see the licence
 * they had just recorded: the write named a branch (a fact), the read guessed a
 * different business (a coin toss). See resolveBusiness for the rest of it.
 *
 * `allowNull` keeps the schema's meaning for rows that belong to the deployment
 * rather than to one business — the system chart of accounts, the system customer
 * classes. NULL is shared, and shared is visible to everyone.
 */
async function readBusinessFilter(db, ctx, { branch = null, column = 'business_id', alias = '', allowNull = true } = {}) {
  const scope = ctx.get('scope');
  const col = alias ? `${alias}.${column}` : column;
  // FAIL CLOSED, and before anything else: with no scope there is no business this
  // read may touch, and `resolveBusiness` would be answering a question about a user
  // it does not have.
  if (!scope) return { sql: '1 = 0', params: [] };
  const business = await resolveBusiness(db, ctx, branch, { required: false });
  if (business) return { sql: `${col} = ?`, params: [String(business.id)] };
  return businessFilter(scope, col, { allowNull });
}

/**
 * The same rule as `readBusinessFilter`, in the shape this codebase already uses
 * for branches (`const bId = branch ? String(branch.id) : null`):
 *
 *     const biz = await readBusinessId(db, ctx);
 *     ... `WHERE x.is_deleted = 0 ${biz ? 'AND x.business_id = ?' : ''}`, biz ? [biz] : []
 *
 * `null` here does NOT mean "no business" — it means NO NARROWING, because the
 * caller reaches every business and named none. Both helpers delegate to
 * `resolveBusiness(db, ctx, branch, { required: false })`; use whichever reads
 * better at the call site, never a third way.
 */
async function readBusinessId(db, ctx, { branch = null } = {}) {
  const business = await resolveBusiness(db, ctx, branch, { required: false });
  return business ? String(business.id) : null;
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

/**
 * THE SEARCH TERM AS THE PLATFORM CAN ACTUALLY RUN IT.
 *
 * Every list screen filters with `LIKE ?` on `%<term>%` — and Cloudflare D1 caps a LIKE or
 * GLOB PATTERN at 50 BYTES, not the 50,000 SQLite itself allows. A term of more than 48
 * bytes (the two `%` count toward the pattern) answers
 *   `500 D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR`
 * so a pasted string, a barcode scanner that emits a long code, or a customer name typed
 * with the phone's autocomplete returns "That failed" from a search box — while every LOCAL
 * run of the same probe passes, because the audit's own SQLite takes the pattern happily.
 * Nothing found this until T4d ran the probe against the deployment; nine routes read the
 * term and not one of them clamped it.
 *
 * Clamped rather than refused, matching `pagination()` above: a shop that types a long query
 * wants the closest thing on the shelf, not an error message. The cut is made on a CHARACTER
 * boundary, so a multi-byte character (₦, é, a Hausa name) is never split into invalid UTF-8
 * — slicing the string by BYTES would produce a term that cannot match anything and cannot
 * be sent back to the client intact.
 */
const MAX_SEARCH_BYTES = 48;
const utf8 = new TextEncoder();
function searchTerm(ctx, param = 'q') {
  const raw = String(ctx.req.queryParam(param) || '').trim();
  if (!raw || utf8.encode(raw).length <= MAX_SEARCH_BYTES) return raw;
  let cut = raw;
  while (cut.length && utf8.encode(cut).length > MAX_SEARCH_BYTES) cut = cut.slice(0, -1);
  return cut;
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
  resolveBranch, resolveBusiness, readBusinessFilter, readBusinessId, inScope, inBranchScope, assertRowAccess,
  scopeFilter, branchFilter, pushScope, pagination, listResponse, dateRange, requireField, flag,
  searchTerm, MAX_SEARCH_BYTES,
};
