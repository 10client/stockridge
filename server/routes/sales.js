'use strict';
// =====================================================================
// server/routes/sales.js — THE COUNTER
// =====================================================================
// This module does NOT price a sale. All of the arithmetic — unit ladders,
// FIFO batch selection, price lists, VAT extraction, margin, change owed,
// the ledger — lives in server/services/salesService.js, which is the same
// code the Worker runs. A route that recomputed a total "just to check" would
// create a second opinion, and two opinions is how a till variance starts.
//
// What the route owns is everything the SERVICE cannot know:
//   * which branch, business and till the request belongs to,
//   * who the customer is and which price list they earn,
//   * whether the caller may do this at all,
//   * and translating a machine-shaped body into the engine's shape.
//
// PREVIEW IS NOT OPTIONAL. `POST /api/sales/preview` runs the whole engine
// including FIFO batch selection and returns the totals WITHOUT writing. The
// POS calls it on every cart change so the cashier sees the real price — the
// price the ledger will post — before money changes hands. A client that prices
// locally and posts blind will disagree with the server often enough that
// cashiers learn to distrust the till.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { idempotent } = require('../lib/idempotency');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, branchFilter, scopeFilter, pagination, listResponse, dateRange, numField, strField, boolField, searchTerm } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday, addDays } = require('../../domain/time');
const salesService = require('../services/salesService');
const glService = require('../services/glService');

// ---------------------------------------------------------------------
// BODY -> ENGINE TRANSLATION
// ---------------------------------------------------------------------

/**
 * Normalise one cart line.
 *
 * The wire format accepts snake_case (what a stored offline queue contains) and
 * camelCase (what the POS builds in memory), because an offline sale recorded on
 * Monday is replayed on Tuesday by code that may have been updated in between.
 * Refusing one spelling would strand queued sales.
 */
function normaliseLine(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const productId = raw.product_id || raw.productId;
  if (!productId) return null;
  const line = {
    productId: String(productId),
    variantId: raw.variant_id || raw.variantId ? String(raw.variant_id || raw.variantId) : null,
    quantity: Number(raw.quantity),
    unitCode: raw.unit_code || raw.unitCode ? String(raw.unit_code || raw.unitCode).toUpperCase() : null,
    discountPct: raw.discount_pct != null || raw.discountPct != null ? Number(raw.discount_pct ?? raw.discountPct) : null,
    discountAmount: raw.discount_amount != null || raw.discountAmount != null ? Number(raw.discount_amount ?? raw.discountAmount) : null,
    discountReason: raw.discount_reason || raw.discountReason || null,
    manualPrice: raw.manual_price != null || raw.manualPrice != null ? Number(raw.manual_price ?? raw.manualPrice) : null,
    notes: raw.notes || null,
    serialNumbers: Array.isArray(raw.serial_numbers || raw.serialNumbers)
      ? (raw.serial_numbers || raw.serialNumbers).map((s) => String(s).trim()).filter(Boolean)
      : (raw.serial_number || raw.serialNumber ? [String(raw.serial_number || raw.serialNumber).trim()] : []),
    measurements: raw.measurements && typeof raw.measurements === 'object' ? raw.measurements : (raw.measures && typeof raw.measures === 'object' ? raw.measures : null),
  };
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
    // Caught here rather than in the engine so the error names the LINE, which
    // is what the cashier needs when the cart has eleven items in it.
    throw new HttpError(`Line ${index + 1}: the quantity must be more than zero (you sent “${raw.quantity}”).`, {
      status: 400, code: 'INVALID_QUANTITY', fields: { [`lines[${index}].quantity`]: 'Must be more than zero.' },
    });
  }
  return line;
}

function normalisePayments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((p, i) => {
    if (!p || typeof p !== 'object') return null;
    const method = String(p.method || p.payment_method || 'CASH').toUpperCase();
    if (!salesService.PAYMENT_METHODS.includes(method)) {
      throw new HttpError(`Payment ${i + 1}: “${method}” is not a payment method this system records. Use one of ${salesService.PAYMENT_METHODS.join(', ')}.`, {
        status: 400, code: 'UNKNOWN_PAYMENT_METHOD',
      });
    }
    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new HttpError(`Payment ${i + 1} (${method}): the amount must be zero or more.`, { status: 400, code: 'INVALID_AMOUNT' });
    }
    return {
      method,
      amount: round2(amount),
      cashTendered: p.cash_tendered != null || p.cashTendered != null ? Number(p.cash_tendered ?? p.cashTendered) : null,
      reference: p.reference || p.txn_ref || null,
      terminalId: p.terminal_id || p.terminalId || null,
      bankName: p.bank_name || p.bankName || null,
      receivedAt: p.received_at || p.receivedAt || null,
    };
  }).filter(Boolean);
}

/**
 * Load the customer, their class and every price list they earn.
 *
 * PRICE LISTS ARE ORDERED BY PRIORITY and all of them are passed to the engine,
 * which applies the best one per product. A wholesale customer who is also on a
 * staff list should get the better of the two on each line, and picking a single
 * list at the route would silently deny them that.
 */
async function resolveCustomer(db, ctx, branch, business, body) {
  const rawId = body.customer_id || body.customerId || null;
  const phone = body.customer_phone || body.customerPhone || null;
  if (!rawId && !phone) return { customer: null, customerClass: null, priceLists: [] };

  let customer = null;
  if (rawId) {
    customer = await db.first('SELECT * FROM customers WHERE id = ? AND is_deleted = 0', [String(rawId)]);
    if (!customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });
  } else {
    // Lookup by phone is exact. A LIKE match would let "0803" attach a sale to
    // the first customer whose number contains it.
    customer = await db.first("SELECT * FROM customers WHERE phone = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1", [String(phone).trim()]);
  }

  // Cross-business visibility: a customer belongs to a business, and a branch
  // may only serve its own business's customers unless the deployment is shared.
  if (customer && customer.business_id && String(customer.business_id) !== String(business.id)) {
    const owns = await db.first('SELECT id FROM branches WHERE id = ? AND business_id = ?', [String(branch.id), String(customer.business_id)]);
    if (!owns) {
      throw new HttpError(
        `${customer.name} is a customer of another business on this deployment, not of ${business.name}. Create them under this business, or ring the sale at their branch.`,
        { status: 403, code: 'CROSS_BUSINESS_CUSTOMER' },
      );
    }
  }
  if (customer && customer.branch_id && String(customer.branch_id) !== String(branch.id) && String(customer.branch_id) !== 'null') {
    // Home branch differs from selling branch. Allowed — a customer may buy
    // anywhere in the group — but recorded, because the debt then sits against
    // one branch while the goods left another, and the branch P&Ls must not
    // quietly absorb each other's credit.
    ctx.set('crossBranchCustomer', true);
  }

  const customerClass = customer && customer.customer_class_id
    ? await db.first('SELECT * FROM customer_classes WHERE id = ? AND is_deleted = 0', [String(customer.customer_class_id)])
    : null;

  // WHICH PRICE LISTS APPLY TO THIS CUSTOMER.
  //
  // The query this replaces filtered on `price_lists.customer_class_id` — a column that
  // has never existed in this schema. SQLite reports that as `no such column`, so EVERY
  // sale that named a customer answered 500 INTERNAL: credit sales, wholesale sales,
  // anything with a customer on it. The customer-free paths kept working, which is
  // exactly why it survived: a shop that only ever rang walk-in cash sales never saw it,
  // and the unit tests exercise the service rather than this route.
  //
  // Found by test/audit/audit.money.js the first time it tried to sell on credit.
  //
  // The schema expresses the link the other way round, and it always did:
  //
  //   customers.price_list_id             — this customer's own list
  //   customer_classes.default_price_list_id — the list their class gets
  //
  // So a list applies when the customer names it, or when their class does. Lists with
  // `business_id IS NULL` are system-wide and always apply.
  //
  // A business's OTHER lists deliberately do NOT apply. The pricing engine takes the
  // deepest quantity break among the lists it is handed (domain/pricing.js, step 3), so
  // sweeping in every list belonging to the business would hand a walk-in retail
  // customer the wholesale price the moment a wholesale list shared a product code with
  // the retail one. Assignment is the gate.
  const assigned = [];
  if (customer && customer.price_list_id) assigned.push(String(customer.price_list_id));
  if (customerClass && customerClass.default_price_list_id && !assigned.includes(String(customerClass.default_price_list_id))) {
    assigned.push(String(customerClass.default_price_list_id));
  }
  const priceLists = await db.all(
    `SELECT * FROM price_lists
      WHERE is_deleted = 0 AND is_active = 1
        AND (business_id IS NULL${assigned.length ? ` OR id IN (${assigned.map(() => '?').join(',')})` : ''})
        AND (business_id IS NULL OR business_id = ?)
        AND (valid_from IS NULL OR valid_from <= date('now'))
        AND (valid_to IS NULL OR valid_to >= date('now'))
      ORDER BY priority ASC, name ASC`,
    [...assigned, String(business.id)],
  );

  return { customer, customerClass, priceLists };
}

/**
 * An explicitly chosen till session, or null.
 *
 * The route deliberately does NOT pick a till itself. `salesService.complete`
 * resolves one — and resolving it correctly means converting the sale's WEST
 * AFRICA TIME `sold_at` to UTC before comparing it against `opened_at`, which is
 * stored in UTC. Duplicating that here would give two answers that differ by an
 * hour for any sale near a till boundary, and the one that writes is the one that
 * matters. So the route only forwards an explicit choice.
 */
function explicitTillId(body, ctx) {
  const raw = body.till_session_id || body.tillSessionId || ctx.req.queryParam('till_session_id');
  return raw ? String(raw) : null;
}

async function buildEngineParams(db, ctx, body, { forComplete }) {
  const user = ctx.get('user');
  const settings = ctx.get('settings');
  const branch = await resolveBranch(db, ctx);
  const business = await resolveBusiness(db, ctx, branch);
  const { customer, customerClass, priceLists } = await resolveCustomer(db, ctx, branch, business, body);

  const rawLines = Array.isArray(body.lines) ? body.lines : (Array.isArray(body.items) ? body.items : null);
  if (!rawLines || !rawLines.length) {
    throw new HttpError('A sale needs at least one item. Add something to the cart, or cancel.', { status: 400, code: 'EMPTY_SALE' });
  }
  const lines = rawLines.map(normaliseLine).filter(Boolean);
  if (!lines.length) throw new HttpError('None of the lines had a product id.', { status: 400, code: 'EMPTY_SALE' });

  const saleType = String(body.sale_type || body.saleType || 'RETAIL').toUpperCase();
  if (!salesService.SALE_TYPES.includes(saleType)) {
    throw new HttpError(`“${saleType}” is not a sale type. Use one of ${salesService.SALE_TYPES.join(', ')}.`, { status: 400, code: 'UNKNOWN_SALE_TYPE' });
  }
  if (saleType === 'WHOLESALE' && !atLeast(user.role, 'STAFF')) {
    throw new HttpError('Only staff or above can ring a wholesale sale.', { status: 403, code: 'ROLE_REQUIRED' });
  }

  const tillSessionId = explicitTillId(body, ctx);
  if (!tillSessionId && !forComplete) {
    // Advisory only: an owner may legitimately sell without a drawer open, and an
    // offline sale replayed after the till closed must still post. The service
    // records it against the day and flags it as a late posting.
    const open = await db.scalar("SELECT COUNT(*) FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0", [String(branch.id)]);
    if (!open) ctx.set('tillWarning', `No till is open at ${branch.name}. This sale will be recorded but not counted in a drawer.`);
  }

  const deliveryRequired = boolField(body.delivery_required ?? body.deliveryRequired);
  const deliveryFee = numField(body.delivery_fee ?? body.deliveryFee, { field: 'Delivery fee', min: 0 });
  if (deliveryRequired && deliveryFee === 0 && !boolField(body.free_delivery)) {
    ctx.set('deliveryWarning', 'Delivery was requested with no fee. If this is a goodwill delivery, that is fine — it is recorded as free.');
  }

  const discountAmount = numField(body.discount_amount ?? body.discountAmount ?? body.order_discount_amount, { field: 'Discount', min: 0 });
  const discountReason = strField(body.discount_reason || body.discountReason, { field: 'Discount reason', maxLength: 200 });
  if (discountAmount > 0 && !discountReason && !atLeast(user.role, 'MANAGER')) {
    // A discount is the single most abused control at a counter. Staff may give
    // one, but they must say why in their own words.
    throw new HttpError('Record why this discount was given. A discount without a reason cannot be reviewed later.', {
      status: 400, code: 'DISCOUNT_REASON_REQUIRED', fields: { discount_reason: 'Required for staff.' },
    });
  }

  const params = {
    branch, business, user, settings, scope: ctx.get('scope'),
    customer, customerClass, priceLists,
    lines, saleType,
    discountAmount, discountReason,
    deliveryFee, deliveryRequired,
    deliveryAddress: strField(body.delivery_address || body.deliveryAddress, { field: 'Delivery address', maxLength: 300 }),
    notes: strField(body.notes, { field: 'Notes', maxLength: 500 }),
    tillSessionId,
    manualPriceOverrides: body.manual_price_overrides && typeof body.manual_price_overrides === 'object' ? body.manual_price_overrides : {},
    walkInName: strField(body.walk_in_name || body.walkInName || body.customer_name, { field: 'Customer name', maxLength: 160 }),
    walkInPhone: strField(body.walk_in_phone || body.walkInPhone || body.customer_phone, { field: 'Customer phone', maxLength: 40 }),
  };

  if (forComplete) {
    params.payments = normalisePayments(body.payments);
    params.creditOverrideReason = strField(body.credit_override_reason || body.creditOverrideReason, { field: 'Credit override reason', maxLength: 300 });
    params.changeOwedAmount = numField(body.change_owed_amount ?? body.changeOwedAmount, { field: 'Change owed', min: 0 });
    params.deviceId = strField(body.device_id || body.deviceId || ctx.req.header('X-Device-Id'), { field: 'Device', maxLength: 120 });
    // Only a manager may backdate. The window itself is enforced in the service
    // (90 days, ±10 minutes of future skew) so the rule cannot drift between
    // the two backends.
    params.soldAt = body.sold_at || body.soldAt || null;
    if (params.soldAt && !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('Only a manager or above can record a sale as having happened at another time. Backdating moves takings between tills.', { status: 403, code: 'BACKDATE_NOT_ALLOWED' });
    }
  }
  return params;
}

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // PREVIEW — the engine, no writes
  // -------------------------------------------------------------------
  /**
   * Price a cart without recording it.
   *
   * Returns `problems` separately from `warnings`: a problem stops the sale
   * (no stock, unknown product), a warning does not (below margin floor, a
   * serial that could not be verified, an advisory NUBAN check). Collapsing the
   * two would either block legitimate sales or let a cashier ring up something
   * the system knows cannot be fulfilled.
   */
  app.post(`${base}/sales/preview`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const body = await ctx.req.json();
    const params = await buildEngineParams(db, ctx, body, { forComplete: false });
    const result = await salesService.prepare(db, params);

    if (!result.ok) {
      // The engine reports line-level problems rather than throwing, so the POS
      // can show all of them at once. Passing them back as a 422 keeps the
      // distinction between "your request was malformed" (400) and "the cart
      // cannot be sold as it stands" (422).
      return ctx.json({
        ok: false, code: 'SALE_NOT_VALID',
        message: (result.problems && result.problems.length) ? result.problems[0].message : 'This cart cannot be sold as it stands.',
        problems: result.problems || [], warnings: result.warnings || [],
      }, 422);
    }

    ctx.json({
      ok: true,
      totals: result.totals,
      lines: result.lines.map((l) => ({
        index: l.index, productId: l.productId, productName: l.productName, sku: l.sku,
        variantId: l.variantId || null, quantity: l.quantity, unitCode: l.unitCode,
        quantityInBase: l.quantityInBase, unitPrice: l.unitPrice, lineTotal: l.lineTotal,
        discountAmount: l.discountAmount, discountPct: l.discountPct, vatAmount: l.vatAmount,
        costPriceSnapshot: l.costPriceSnapshot, margin: l.margin, marginPct: l.marginPct,
        priceSource: l.priceSource, priceListId: l.priceListId || null,
        // Which physical units this line will consume. Shown so the cashier can
        // see a sale eating the last of a batch rather than discovering it on
        // the next customer's refusal.
        picks: (l.picks || []).map((p) => ({ batchId: p.batchId, batchNo: p.batchNo, quantity: p.quantity, expiryDate: p.expiryDate || null })),
        serialNumbers: l.requestedSerials || [],
      })),
      problems: [], warnings: result.warnings || [],
      vatEnabled: result.vatEnabled, vatRatePercent: result.vatRatePercent,
      isCredit: result.isCredit,
      saleType: result.saleType,
      tillSessionId: result.tillSessionId,
      customer: result.customer ? { id: result.customer.id, name: result.customer.name, creditBalance: Number(result.customer.credit_balance) || 0, creditLimit: Number(result.customer.credit_limit) || 0 } : null,
      notice: ctx.get('tillWarning') || ctx.get('deliveryWarning') || null,
    });
  });

  // -------------------------------------------------------------------
  // COMPLETE
  // -------------------------------------------------------------------
  /**
   * Record a sale.
   *
   * Wrapped in `idempotent`, so a POS that lost the response to a successful
   * sale and retries with the same Idempotency-Key gets the ORIGINAL result back
   * instead of a second sale. This is the single most important protection on
   * this endpoint: a flaky mobile network in Lagos will absolutely eat the
   * response to a completed sale, and a cashier who taps "pay" twice must not
   * produce two receipts and two stock decrements.
   */
  app.post(`${base}/sales`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const params = await buildEngineParams(db, ctx, body, { forComplete: true });

    const result = await salesService.complete(db, params);

    await recordFromCtx(ctx, {
      action: 'SALE_COMPLETED', entityType: 'SALE', entityId: result.saleId,
      branchId: result.branchId, businessId: String(params.business.id),
      after: {
        receiptNo: result.receiptNo, total: result.totals.total, paid: result.paid,
        balanceDue: result.balanceDue, lines: result.lineCount, saleType: params.saleType,
        soldAt: result.soldAt, backdated: result.backdated, deviceId: params.deviceId,
      },
    });

    if (ctx.get('idempotencyReplayed')) {
      ctx.header('Idempotency-Replayed', 'true');
    }

    ctx.json({
      ok: true,
      saleId: result.saleId,
      receiptNo: result.receiptNo,
      totals: result.totals,
      vat: result.vat,
      paid: result.paid,
      balanceDue: result.balanceDue,
      changeOwed: result.changeOwed,
      credit: result.creditInfo ? { decision: result.creditInfo.decision, message: result.creditInfo.message, balanceAfter: result.creditInfo.balanceAfter } : null,
      warnings: (result.warnings || []).map((w) => (typeof w === 'string' ? { message: w, severity: 'WARN', code: 'ADVISORY' } : w)),
      lineCount: result.lineCount,
      tillSessionId: result.tillSessionId,
      soldAt: result.soldAt,
      // Both flags travel back to the client so the receipt can say plainly what
      // happened. A sale posted after its till was counted is not an error, but
      // the cashier will be blamed for the variance unless the receipt explains
      // it, and the next person counting the drawer needs to know too.
      latePosting: result.latePosting,
      backdated: result.backdated,
      replayed: Boolean(ctx.get('idempotencyReplayed')),
      message: `Sale ${result.receiptNo} recorded — ₦${Number(result.totals.total).toLocaleString('en-NG')}.${result.balanceDue > 0 ? ` ₦${Number(result.balanceDue).toLocaleString('en-NG')} still owed.` : ''}${result.latePosting ? ' Posted after the till was counted.' : ''}`,
    }, 201);
  }));

  // -------------------------------------------------------------------
  // LIST / READ
  // -------------------------------------------------------------------
  app.get(`${base}/sales`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const { from, to } = dateRange(ctx, { defaultDays: 7 });
    const where = ['s.is_deleted = 0', "date(s.sold_at) BETWEEN ? AND ?"];
    const params = [from, to];
    const f = scopeFilter(scope, { alias: 's' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    // A BRANCH THE CALLER NAMED NARROWS THIS LIST — see branchFilter() in lib/respond.
    const bf = await branchFilter(db, ctx, { alias: 's' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }

    const status = ctx.req.queryParam('status');
    if (status) { where.push('s.status = ?'); params.push(String(status).toUpperCase()); }
    const saleType = ctx.req.queryParam('sale_type');
    if (saleType) { where.push('s.sale_type = ?'); params.push(String(saleType).toUpperCase()); }
    const method = ctx.req.queryParam('payment_method');
    if (method) { where.push('s.payment_method = ?'); params.push(String(method).toUpperCase()); }
    const cashier = ctx.req.queryParam('cashier_id');
    if (cashier) { where.push('s.salesperson_id = ?'); params.push(String(cashier)); }
    const customerId = ctx.req.queryParam('customer_id');
    if (customerId) { where.push('s.customer_id = ?'); params.push(String(customerId)); }
    if (boolField(ctx.req.queryParam('credit_only'))) where.push('s.balance_due > 0');
    const search = searchTerm(ctx);
    if (search) {
      where.push('(s.receipt_no LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.join(' AND ');

    // `sales` has no `item_count` and no `is_void` column: the line count is
    // derived from `sale_items` and a void is `status = 'VOIDED'`. Reading a
    // column that does not exist fails the whole query, so these are computed
    // rather than selected.
    const rows = await db.all(`SELECT s.id, s.receipt_no, s.sold_at, s.sale_type, s.status, s.payment_method,
          s.subtotal, s.discount_amount, s.order_discount_amount, s.vat_amount, s.delivery_fee, s.total,
          s.amount_paid, s.balance_due, s.change_given, s.cash_tendered, s.branch_id, s.business_id,
          s.salesperson_id, s.customer_id, s.customer_name, s.notes,
          s.voided_at, s.voided_by, s.void_reason, s.till_session_id,
          (s.status = 'VOIDED') AS is_void,
          (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.is_deleted = 0) AS item_count,
          (SELECT COALESCE(SUM(co.amount),0) FROM change_owed co WHERE co.sale_id = s.id AND co.status = 'OUTSTANDING' AND co.is_deleted = 0) AS change_owed,
          b.name AS branch_name, b.code AS branch_code, u.full_name AS cashier_name
        FROM sales s
        LEFT JOIN branches b ON b.id = s.branch_id
        LEFT JOIN users u ON u.id = s.salesperson_id
        WHERE ${whereSql}
        ORDER BY s.sold_at DESC, s.receipt_no DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);

    const total = await db.scalar(`SELECT COUNT(*) FROM sales s WHERE ${whereSql}`, params);
    // Aggregates over the SAME where clause, so the header figures always match
    // the list beneath them. Summing the page instead of the filter is the most
    // common way a report quietly understates the day.
    // Revenue EXCLUDES voided sales; the voided count and value are reported
    // separately. A till report that folded voids into revenue would overstate
    // the day by exactly the amount that was reversed.
    const totals = await db.first(`SELECT
          COUNT(*) AS count,
          COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END),0) AS revenue,
          COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.balance_due ELSE 0 END),0) AS outstanding,
          COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.vat_amount ELSE 0 END),0) AS vat,
          COALESCE(SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END),0) AS voided,
          COALESCE(SUM(CASE WHEN s.status = 'VOIDED' THEN s.total ELSE 0 END),0) AS voided_value,
          COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.delivery_fee ELSE 0 END),0) AS delivery_fees
        FROM sales s WHERE ${whereSql}`, params);

    ctx.json({
      ...listResponse(rows, { limit, offset }, total),
      summary: {
        sales: Number(totals.count) || 0,
        revenue: round2(Number(totals.revenue)),
        outstanding: round2(Number(totals.outstanding)),
        vat: round2(Number(totals.vat)),
        voided: Number(totals.voided) || 0,
        voidedValue: round2(Number(totals.voided_value)),
        deliveryFees: round2(Number(totals.delivery_fees)),
        averageSale: Number(totals.count) ? round2(Number(totals.revenue) / Number(totals.count)) : 0,
      },
      range: { from, to },
    });
  });

  app.get(`${base}/sales/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const id = String(ctx.req.param('id'));
    const sale = await db.first(`SELECT s.*, b.name AS branch_name, b.code AS branch_code, b.address AS branch_address,
          b.phone AS branch_phone, u.full_name AS cashier_name, biz.name AS business_name
        FROM sales s
        LEFT JOIN branches b ON b.id = s.branch_id
        LEFT JOIN users u ON u.id = s.salesperson_id
        LEFT JOIN businesses biz ON biz.id = s.business_id
        WHERE s.id = ? AND s.is_deleted = 0`, [id]);
    if (!sale) throw new HttpError('That sale does not exist, or it has been deleted.', { status: 404, code: 'SALE_NOT_FOUND' });
    if (!scope.allBranches && sale.branch_id && !scope.branchIds.has(String(sale.branch_id))) {
      throw new HttpError('That sale belongs to another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });
    }

    const [items, payments, delivery, debtorLedger, warranty, serials, changeOwedRows, gl] = await Promise.all([
      db.all(`SELECT si.*, p.name AS product_name, p.sku, p.base_unit_name, p.warranty_months, v.name AS variant_name
          FROM sale_items si JOIN products p ON p.id = si.product_id
          LEFT JOIN product_variants v ON v.id = si.variant_id
          WHERE si.sale_id = ? AND si.is_deleted = 0 ORDER BY si.created_at, si.id`, [id]),
      db.all('SELECT * FROM sale_payments WHERE sale_id = ? AND is_deleted = 0 ORDER BY created_at, id', [id]),
      db.all('SELECT * FROM delivery_jobs WHERE sale_id = ? AND is_deleted = 0 ORDER BY created_at DESC', [id]),
      db.all(`SELECT dl.*, c.name AS customer_name FROM debtor_ledger dl
          LEFT JOIN customers c ON c.id = dl.customer_id
          WHERE dl.reference_id = ? AND dl.is_deleted = 0 ORDER BY dl.created_at, dl.id`, [id]),
      db.all(`SELECT w.*, p.name AS product_name, sn.serial_no FROM warranty_claims w
          LEFT JOIN products p ON p.id = w.product_id
          LEFT JOIN serial_numbers sn ON sn.id = w.serial_id
          WHERE w.sale_id = ? AND w.is_deleted = 0 ORDER BY w.created_at, w.id`, [id]),
      db.all(`SELECT ss.*, sn.status AS serial_status, sn.warranty_starts_at, sn.warranty_ends_at,
            p.name AS product_name FROM sale_serials ss
          LEFT JOIN serial_numbers sn ON sn.id = ss.serial_id
          LEFT JOIN products p ON p.id = sn.product_id
          WHERE ss.sale_id = ? ORDER BY ss.serial_no`, [id]),
      db.all('SELECT * FROM change_owed WHERE sale_id = ? AND is_deleted = 0 ORDER BY created_at, id', [id]),
      db.all(`SELECT je.id, je.entry_no, je.entry_date, je.description AS narration, jel.account_id, jel.debit, jel.credit, a.code AS account_code, a.name AS account_name
          FROM gl_journal_entries je
          JOIN gl_journal_lines jel ON jel.journal_entry_id = je.id
          JOIN gl_accounts a ON a.id = jel.account_id
          WHERE je.source_type = 'SALE' AND je.source_id = ? AND je.is_deleted = 0 AND jel.is_deleted = 0
          ORDER BY je.entry_no, a.code`, [id]),
    ]);

    ctx.json({
      ok: true, sale, items, payments,
      delivery, debtorLedger, warranties: warranty, serials, changeOwed: changeOwedRows,
      journal: gl,
      totals: {
        subtotal: Number(sale.subtotal), discount: Number(sale.discount_amount) + Number(sale.order_discount_amount || 0),
        vat: Number(sale.vat_amount), deliveryFee: Number(sale.delivery_fee), total: Number(sale.total),
        paid: Number(sale.amount_paid), balanceDue: Number(sale.balance_due), changeOwed: Number(sale.change_owed),
      },
    });
  });

  /**
   * Look a sale up by receipt number.
   *
   * Kept separate from the id lookup because the receipt number is what a
   * customer reads aloud at the counter, and it is scoped per branch — two
   * branches legitimately both have a receipt "0042".
   */
  app.get(`${base}/sales/by-receipt/:receiptNo`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const branch = await resolveBranch(db, ctx, { required: false });
    const receiptNo = String(ctx.req.param('receiptNo')).trim();
    const where = ['s.receipt_no = ?', 's.is_deleted = 0'];
    const params = [receiptNo];
    if (branch) { where.push('s.branch_id = ?'); params.push(String(branch.id)); }
    const sale = await db.first(`SELECT s.*, b.name AS branch_name FROM sales s LEFT JOIN branches b ON b.id = s.branch_id
        WHERE ${where.join(' AND ')} ORDER BY s.sold_at DESC LIMIT 1`, params);
    if (!sale) throw new HttpError(`No sale with receipt number ${receiptNo}${branch ? ` at ${branch.name}` : ''}.`, { status: 404, code: 'SALE_NOT_FOUND' });
    const items = await db.all(`SELECT si.*, p.name AS product_name, p.sku, v.name AS variant_name
        FROM sale_items si JOIN products p ON p.id = si.product_id
        LEFT JOIN product_variants v ON v.id = si.variant_id
        WHERE si.sale_id = ? AND si.is_deleted = 0 ORDER BY si.created_at, si.id`, [sale.id]);
    const payments = await db.all('SELECT * FROM sale_payments WHERE sale_id = ? AND is_deleted = 0 ORDER BY created_at, id', [sale.id]);
    ctx.json({ ok: true, sale, items, payments });
  });

  // -------------------------------------------------------------------
  // VOID
  // -------------------------------------------------------------------
  /**
   * Void a sale. Never a delete.
   *
   * The service returns stock to the ORIGINAL batch at its ORIGINAL cost,
   * reverses the ledger rather than removing it, and increments the till's void
   * count. A void that deleted the row would erase the evidence that the sale
   * ever happened — which is exactly what a dishonest cashier wants.
   */
  app.post(`${base}/sales/:id/void`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();

    const sale = await db.first('SELECT * FROM sales WHERE id = ? AND is_deleted = 0', [id]);
    if (!sale) throw new HttpError('That sale does not exist.', { status: 404, code: 'SALE_NOT_FOUND' });
    if (sale.status === 'VOIDED') throw new HttpError('That sale is already void.', { status: 409, code: 'ALREADY_VOID' });

    const reason = strField(body.reason || body.void_reason, { field: 'Reason', maxLength: 300, required: true });
    if (reason.length < 4) {
      throw new HttpError('Give a real reason for the void. “Wrong” tells nobody anything when this is reviewed at the end of the month.', { status: 400, code: 'REASON_REQUIRED' });
    }

    // STAFF may void their OWN sale inside a short window while the till is
    // open. Beyond that it takes a manager. The window is enforced in the
    // service, comparing WAT to WAT — getting that comparison wrong in either
    // direction is how staff end up blocked from voiding a one-minute-old
    // mistake, or free to void anything all day.
    const isOwnSale = String(sale.salesperson_id) === String(user.id);
    if (!isOwnSale && !atLeast(user.role, 'MANAGER')) {
      throw new HttpError('You can only void your own sale. Ask a manager to void somebody else\'s.', { status: 403, code: 'NOT_YOUR_SALE' });
    }
    // (A guard stood here reading `settings.staff_void_requires_manager`. No such
    // setting has ever existed, in a column or in DEFAULT_SETTINGS, so the
    // expression was `Number(undefined)` — NaN — and the branch never fired. The
    // real decision is `canVoidSale` in domain/planLimits.js, called by the service
    // below, which honours `staff_can_void_sales`, `managers_can_void_sales` and the
    // window. A dead guard is worse than no guard: it reads as enforcement.
    // test/unit/settings-controls.test.js now refuses to let any route read a
    // settings key that does not exist.)

    // `saleId`, not the row. The service re-reads the sale inside its own
    // transaction and loads its own account codes, and it needs the id to find
    // the items, the serials and the debtor-ledger entry that reference it.
    // Passing the row instead of the id left `saleId` undefined, so every void
    // answered 404 "That sale does not exist" for a sale the caller was looking
    // at on screen.
    const result = await salesService.voidSale(db, {
      saleId: sale.id,
      user, settings, reason,
      scope: ctx.get('scope'),
    });

    await recordFromCtx(ctx, {
      action: 'SALE_VOIDED', entityType: 'SALE', entityId: id, branchId: sale.branch_id, businessId: sale.business_id,
      before: { total: Number(sale.total), status: sale.status, receiptNo: sale.receipt_no },
      after: { reason, total: Number(sale.total) },
    });

    ctx.json({
      ok: true,
      message: `Sale ${sale.receipt_no} voided — ₦${Number(sale.total).toLocaleString('en-NG')} reversed and the stock returned to the shelf.${result.latePosting ? ' The till it was counted in has already closed, so the reversal is posted without changing that count.' : ''}`,
      warnings: result.warnings || [],
    });
  }));

  // -------------------------------------------------------------------
  // SETTLE AN OUTSTANDING CREDIT SALE
  // -------------------------------------------------------------------
  /**
   * Take payment against a sale that still has a balance.
   *
   * This is the debtor side of a credit sale, and it is deliberately NOT a new
   * sale: it writes a payment, reduces the debtor ledger balance and posts
   * cash-against-receivable. Recording it as a second sale would double the
   * revenue and double the stock movement.
   */
  app.post(`${base}/sales/:id/pay`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();

    const sale = await db.first('SELECT s.*, b.name AS branch_name FROM sales s LEFT JOIN branches b ON b.id = s.branch_id WHERE s.id = ? AND s.is_deleted = 0', [id]);
    if (!sale) throw new HttpError('That sale does not exist.', { status: 404, code: 'SALE_NOT_FOUND' });
    if (sale.status === 'VOIDED') throw new HttpError('That sale is void — there is nothing left to pay.', { status: 409, code: 'SALE_VOID' });
    const outstanding = round2(Number(sale.balance_due));
    if (outstanding <= 0) throw new HttpError('That sale is already settled in full.', { status: 409, code: 'NO_BALANCE' });
    if (!sale.customer_id) throw new HttpError('That sale has no customer on it, so there is no debtor account to credit. Record the payment as a separate receipt instead.', { status: 409, code: 'NO_CUSTOMER' });

    // The sale row names the branch (and the debtors ledger it settles) — see the
    // row-scoped rule in resolveBranch.
    const branch = await resolveBranch(db, ctx, { fallback: sale.branch_id });
    const business = await resolveBusiness(db, ctx, branch);
    const payments = normalisePayments(body.payments);
    if (!payments.length) throw new HttpError('Send at least one payment.', { status: 400, code: 'NO_PAYMENT' });

    const creditLegs = payments.filter((p) => p.method === 'CREDIT');
    if (creditLegs.length) {
      throw new HttpError('You cannot settle a credit balance with more credit. Take cash, a transfer, a card or mobile money.', { status: 400, code: 'CREDIT_TO_SETTLE_CREDIT' });
    }
    const amount = round2(payments.reduce((a, p) => a + p.amount, 0));
    if (amount <= 0) throw new HttpError('The payment amount must be more than zero.', { status: 400, code: 'INVALID_AMOUNT' });

    // Overpayment is allowed but only up to the balance; anything more is a
    // customer deposit and belongs on the customer account, not against this
    // invoice, or the invoice balance goes negative and the debtor ledger stops
    // agreeing with the customer record.
    const applied = Math.min(amount, outstanding);
    const excess = round2(amount - applied);

    const customer = await db.first('SELECT * FROM customers WHERE id = ? AND is_deleted = 0', [String(sale.customer_id)]);
    if (!customer) throw new HttpError('The customer on that sale no longer exists.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const receiptId = newId();
    // The drawer taking this money is the cashier's own open one, matching how a
    // sale is counted. Crediting a different cashier's drawer would make their
    // count short by exactly what this counter collected.
    const till = await db.first("SELECT * FROM till_sessions WHERE branch_id = ? AND user_id = ? AND status = 'OPEN' AND is_deleted = 0 ORDER BY opened_at DESC LIMIT 1",
      [String(branch.id), String(user.id)]);

    // Every read the transaction needs happens here. The write phase may not
    // await: better-sqlite3 is synchronous and cannot span a microtask, and D1
    // has no interactive transaction at all.
    const priorBalance = round2(Number(customer.credit_balance) || 0);
    const balanceAfter = round2(priorBalance - applied);

    await db.transaction(async (tx) => {
      for (const pay of payments) {
        tx.queue(`INSERT INTO sale_payments (
            id, sale_id, branch_id, till_session_id, method, amount, reference, bank_name,
            status, cash_tendered, change_given, recorded_by, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?, 'CLEARED', ?, 0, ?, ?, datetime('now'), datetime('now'))`, [
          newId(), id, String(branch.id), till ? String(till.id) : null,
          pay.method, pay.amount, pay.reference, pay.bankName,
          pay.cashTendered != null && Number.isFinite(pay.cashTendered) ? Number(pay.cashTendered) : pay.amount,
          String(user.id),
          excess > 0 ? `Settling ${sale.receipt_no}; \u20a6${excess.toLocaleString('en-NG')} overpaid to the customer account.` : `Settling ${sale.receipt_no}`,
        ]);
      }

      tx.queue(`UPDATE sales SET balance_due = balance_due - ?, amount_paid = amount_paid + ?,
          status = CASE WHEN balance_due - ? <= 0 THEN 'COMPLETED' ELSE status END,
          updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [applied, applied, applied, id]);

      // Debtor ledger: a negative PAYMENT row carrying the running balance,
      // exactly as the sale posted its positive SALE row. Appending rather than
      // editing the original row is what keeps the account reconstructible at any
      // past date.
      tx.queue(`INSERT INTO debtor_ledger (
          id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?, 'PAYMENT', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
        newId(), String(branch.id), String(business.id), String(customer.id), id,
        -applied, balanceAfter,
        `Payment against ${sale.receipt_no} by ${payments.map((x) => x.method.replace(/_/g, ' ').toLowerCase()).join(', ')}`,
        String(user.id),
      ]);
      tx.queue("UPDATE customers SET credit_balance = ?, updated_at = datetime('now') WHERE id = ?", [balanceAfter, String(customer.id)]);

      if (excess > 0) {
        // The overpayment becomes a customer credit. Dropping it would leave cash
        // in the drawer that no ledger row explains — the surplus variance nobody
        // investigates until it is large enough to matter.
        tx.queue(`INSERT INTO debtor_ledger (
            id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
          VALUES (?,?,?,?, 'ADJUSTMENT', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
          newId(), String(branch.id), String(business.id), String(customer.id), id,
          -excess, round2(balanceAfter - excess),
          `Overpayment on ${sale.receipt_no}, held as a customer credit`, String(user.id),
        ]);
        tx.queue("UPDATE customers SET credit_balance = credit_balance - ?, updated_at = datetime('now') WHERE id = ?", [excess, String(customer.id)]);
      }

      for (const st of glService.postDebtorPaymentStatements({
        businessId: String(business.id), branchId: String(branch.id),
        customerId: String(customer.id), customerName: customer.name,
        amount: applied, method: payments[0].method, reference: sale.receipt_no,
        accountIds, user,
      })) tx.queue(st.sql, st.params);

      if (till) {
        const byMethod = salesService.totalsByMethod(payments);
        tx.queue(`UPDATE till_sessions SET
            cash_sales_total = cash_sales_total + ?,
            pos_total = pos_total + ?,
            transfer_total = transfer_total + ?,
            mobile_money_total = mobile_money_total + ?,
            cheque_total = cheque_total + ?,
            grand_total = grand_total + ?,
            updated_at = datetime('now')
          WHERE id = ?`, [
          byMethod.CASH, byMethod.POS_TERMINAL, byMethod.BANK_TRANSFER, byMethod.MOBILE_MONEY,
          byMethod.CHEQUE, applied, String(till.id),
        ]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'DEBTOR_PAYMENT', entityType: 'SALE', entityId: id, branchId: branch.id, businessId: business.id,
      before: { balanceDue: outstanding }, after: { applied, excess, balanceAfter, methods: payments.map((x) => x.method), tillSessionId: till ? String(till.id) : null },
    });

    ctx.json({
      ok: true, receiptId,
      message: `₦${applied.toLocaleString('en-NG')} received against ${sale.receipt_no}.${applied >= outstanding ? ' That invoice is now settled.' : ` ₦${round2(outstanding - applied).toLocaleString('en-NG')} still outstanding.`}${excess > 0 ? ` ₦${excess.toLocaleString('en-NG')} was overpaid and is held as a customer credit.` : ''}`,
      applied, excess, balanceDue: round2(outstanding - applied),
    });
  }));

  // -------------------------------------------------------------------
  // SERIAL LOOKUP — warranty and anti-diversion
  // -------------------------------------------------------------------
  /**
   * Trace a serial number.
   *
   * Answers the two questions a counter actually gets asked: "is this still
   * under warranty?" and "which branch sold this unit?". For appliances and
   * electronics, a serial that was never sold here is a parallel import or a
   * stolen unit, and the answer has to be immediate and certain.
   */
  app.get(`${base}/serials/:serialNo`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const serialNo = String(ctx.req.param('serialNo')).trim().toUpperCase();
    if (!serialNo) throw new HttpError('Enter a serial number.', { status: 400, code: 'MISSING_FIELD' });

    const rows = await db.all(`SELECT sn.*, p.name AS product_name, p.sku, p.warranty_months,
          b.name AS branch_name, b.code AS branch_code, biz.name AS business_name,
          s.receipt_no, s.sold_at, s.sale_type, c.name AS customer_name, c.phone AS customer_phone,
          (SELECT COUNT(*) FROM warranty_claims w WHERE w.serial_id = sn.id AND w.is_deleted = 0) AS claim_count,
          (SELECT w.status FROM warranty_claims w WHERE w.serial_id = sn.id AND w.is_deleted = 0
             ORDER BY w.opened_at DESC LIMIT 1) AS latest_claim_status
        FROM serial_numbers sn
        LEFT JOIN products p ON p.id = sn.product_id
        LEFT JOIN branches b ON b.id = sn.branch_id
        LEFT JOIN businesses biz ON biz.id = sn.business_id
        LEFT JOIN sales s ON s.id = sn.sale_id
        LEFT JOIN customers c ON c.id = sn.customer_id
        WHERE UPPER(sn.serial_no) = ?
        ORDER BY sn.created_at DESC LIMIT 20`, [serialNo]);

    const latest = rows[0];
    ctx.json({
      ok: true, serial: latest, history: rows,
      // Warranty is read off the serial itself, not off a claims table: a unit
      // that has never been claimed is still in warranty, and answering "no
      // claims" as "no warranty" would turn away a legitimate customer.
      inWarranty: Boolean(latest.warranty_ends_at) && String(latest.warranty_ends_at) >= watToday() && latest.status === 'SOLD',
      warrantyEndsAt: latest.warranty_ends_at || null,
      daysOfWarrantyLeft: latest.warranty_ends_at ? Math.max(0, Math.round((Date.parse(latest.warranty_ends_at) - Date.parse(watToday())) / 86400000)) : null,
      message: latest.sale_id
        ? `${latest.product_name} — sold on receipt ${latest.receipt_no} at ${latest.branch_name}.`
        : `${latest.product_name} — in stock at ${latest.branch_name}, not yet sold.`,
    });
  });

  // -------------------------------------------------------------------
  // DELIVERY + INSTALLATION JOBS
  // -------------------------------------------------------------------
  app.get(`${base}/deliveries`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const where = ['d.is_deleted = 0']; const params = [];
    const f = scopeFilter(scope, { alias: 'd' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    // A BRANCH THE CALLER NAMED NARROWS THIS LIST — see branchFilter() in lib/respond.
    const bf = await branchFilter(db, ctx, { alias: 'd' });
    if (bf.sql) { where.push(bf.sql); params.push(...bf.params); }
    const status = ctx.req.queryParam('status');
    if (status) { where.push('d.status = ?'); params.push(String(status).toUpperCase()); }
    else where.push("d.status NOT IN ('DELIVERED','CANCELLED','RETURNED')"); // the board shows work, not history
    const rows = await db.all(`SELECT d.*, s.receipt_no, s.total AS sale_total, b.name AS branch_name,
          c.name AS customer_name, c.phone AS customer_phone,
          (SELECT COUNT(*) FROM delivery_job_items i WHERE i.delivery_job_id = d.id AND i.is_deleted = 0) AS item_count
        FROM delivery_jobs d
        LEFT JOIN sales s ON s.id = d.sale_id
        LEFT JOIN branches b ON b.id = d.branch_id
        LEFT JOIN customers c ON c.id = d.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.created_at ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    ctx.json(listResponse(rows, { limit, offset }));
  });

  /** One job with its items, the sale behind it and any installation work. */
  app.get(`${base}/deliveries/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const job = await db.first(`SELECT d.*, b.name AS branch_name, c.name AS customer_name, c.phone AS customer_phone,
          s.receipt_no, s.total AS sale_total, s.status AS sale_status
        FROM delivery_jobs d
        LEFT JOIN branches b ON b.id = d.branch_id
        LEFT JOIN customers c ON c.id = d.customer_id
        LEFT JOIN sales s ON s.id = d.sale_id
        WHERE d.id = ? AND d.is_deleted = 0`, [id]);
    if (!job) throw new HttpError('That delivery job does not exist.', { status: 404, code: 'DELIVERY_NOT_FOUND' });
    const [items, installations] = await Promise.all([
      db.all(`SELECT i.*, p.name AS product_name, p.sku, v.name AS variant_name, sn.serial_no
          FROM delivery_job_items i
          JOIN products p ON p.id = i.product_id
          LEFT JOIN product_variants v ON v.id = i.variant_id
          LEFT JOIN serial_numbers sn ON sn.id = i.serial_id
          WHERE i.delivery_job_id = ? AND i.is_deleted = 0 ORDER BY p.name, i.id`, [id]),
      db.all(`SELECT ij.*, p.name AS product_name, sn.serial_no FROM installation_jobs ij
          LEFT JOIN products p ON p.id = ij.product_id
          LEFT JOIN serial_numbers sn ON sn.id = ij.serial_id
          WHERE ij.delivery_job_id = ? AND ij.is_deleted = 0 ORDER BY ij.created_at, ij.id`, [id]),
    ]);
    ctx.json({ ok: true, job, items, installations });
  });

  /**
   * Move a delivery job through its lifecycle.
   *
   * There is no status-history table in this schema, so the transition is
   * recorded two ways that cannot be lost: an append-only `audit_log` row
   * (before/after status, actor, IP) and a timestamped line appended to the
   * job's own notes, which is what the driver and the customer-facing screen
   * actually read. Overwriting `status` alone would leave no answer to "when did
   * it arrive?" or "who said so?" — the two questions a disputed delivery turns
   * on.
   */
  app.post(`${base}/deliveries/:id/status`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const job = await db.first('SELECT * FROM delivery_jobs WHERE id = ? AND is_deleted = 0', [id]);
    if (!job) throw new HttpError('That delivery job does not exist.', { status: 404, code: 'DELIVERY_NOT_FOUND' });

    const rawStatus = body.status || body.new_status;
    if (!rawStatus) throw new HttpError('Send the new status.', { status: 400, code: 'MISSING_FIELD', fields: { status: 'Required' } });
    const status = String(rawStatus).toUpperCase();
    // `delivery_jobs.status` allows exactly these. Installation lives on its own
    // `installation_jobs` row, so a delivered-and-installed drop is DELIVERED here
    // and COMPLETED there rather than inventing an INSTALLED status.
    const ALLOWED = ['PENDING', 'SCHEDULED', 'PICKED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'];
    if (!ALLOWED.includes(status)) throw new HttpError(`\u201c${status}\u201d is not a delivery status. Use one of ${ALLOWED.join(', ')}.`, { status: 400, code: 'INVALID_STATUS' });

    // A job may not go backwards without a manager. A driver who re-marks a
    // delivered job "in transit" is usually correcting a mistake, but is
    // sometimes un-recording a failed drop so it stops showing on the board.
    if (ALLOWED.indexOf(status) < ALLOWED.indexOf(String(job.status).toUpperCase()) && !atLeast(user.role, 'MANAGER')) {
      throw new HttpError(`That job is already ${job.status}. Only a manager can move it back — reversing a delivery status hides a failed drop.`, { status: 403, code: 'STATUS_REVERSAL' });
    }

    const needsNote = ['FAILED', 'CANCELLED', 'RETURNED'].includes(status);
    const note = strField(body.note || body.notes, { field: 'Note', maxLength: 500, required: needsNote });
    if (needsNote && note.length < 4) {
      throw new HttpError(`Say what went wrong. A ${status.toLowerCase()} delivery with no note cannot be chased up or charged back to the transporter.`, { status: 400, code: 'NOTE_REQUIRED' });
    }
    const proof = strField(body.proof_of_delivery || body.proofUrl, { field: 'Proof of delivery', maxLength: 500 });
    const deliveredTo = strField(body.delivered_to, { field: 'Received by', maxLength: 160 });
    const assignedDriver = strField(body.driver_name, { field: 'Driver', maxLength: 120 });
    const driverPhone = strField(body.driver_phone, { field: 'Driver phone', maxLength: 40 });

    const previousStatus = String(job.status);
    // A returned or cancelled delivery puts goods back on the shelf, which needs
    // the job's items and a batch to return them to. Both are READS, so both
    // happen here rather than inside the transaction's write phase.
    const stockToReturn = ['RETURNED', 'CANCELLED'].includes(status)
      ? await db.all(`SELECT i.product_id, i.variant_id, i.quantity, i.quantity_in_base,
              b.id AS batch_id, b.cost_price_per_unit
          FROM delivery_job_items i
          JOIN stock_batches b ON b.product_id = i.product_id AND b.branch_id = ? AND b.is_deleted = 0
          WHERE i.delivery_job_id = ? AND i.is_deleted = 0
          ORDER BY b.expiry_date IS NULL, b.expiry_date, b.received_at, b.batch_no, b.id`,
      [String(job.branch_id), id])
      : [];
    const sets = ['status = ?', "updated_at = datetime('now')"];
    const params = [status];
    if (status === 'DELIVERED') sets.push("delivered_at = datetime('now')");
    if (deliveredTo) { sets.push('delivered_to = ?'); params.push(deliveredTo); }
    if (proof) { sets.push('proof_of_delivery = ?'); params.push(proof); }
    if (assignedDriver) { sets.push('driver_name = ?'); params.push(assignedDriver); }
    if (driverPhone) { sets.push('driver_phone = ?'); params.push(driverPhone); }
    if (status === 'FAILED') { sets.push('attempts = COALESCE(attempts, 0) + 1'); }
    if (note) { sets.push("notes = COALESCE(notes,'') || ?"); params.push(`\n[${watNow()}] ${status} by ${user.full_name || user.username}${note ? ` — ${note}` : ''}`); }
    params.push(id);

    // Read everything the write phase needs first.
    const saleStatus = status === 'DELIVERED' ? 'COMPLETED' : 'PENDING_DELIVERY';
    const itemCounts = await db.all('SELECT product_id, quantity_in_base FROM delivery_job_items WHERE delivery_job_id = ? AND is_deleted = 0', [id]);
    void itemCounts;

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE delivery_jobs SET ${sets.join(', ')} WHERE id = ? AND is_deleted = 0`, params);

      // A returned or cancelled delivery puts the goods back on the shelf. That
      // is a stock adjustment, not a silent status change: without the batch row
      // the units would be sellable in the count but absent from FIFO, and the
      // next stocktake would find stock the system does not know it has.
      if (stockToReturn.length) {
        const returned = stockToReturn;
        const seen = new Set();
        for (const item of returned) {
          if (!item.batch_id || seen.has(item.product_id)) continue;
          seen.add(item.product_id);
          const qty = Number(item.quantity_in_base) || Number(item.quantity) || 0;
          if (qty <= 0) continue;
          tx.queue(`UPDATE stock_batches SET quantity = quantity + ?,
              status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END,
              updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [qty, String(item.batch_id)]);
          tx.queue(`INSERT INTO stock_adjustments (
              id, branch_id, business_id, batch_id, product_id, variant_id, adjustment_type, quantity,
              unit_cost, total_value, reason, requires_approval, created_by, created_at, updated_at)
            VALUES (?,?,?,?,?,?, 'FOUND', ?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'))`, [
            newId(), String(job.branch_id), String(job.business_id), String(item.batch_id),
            item.product_id, item.variant_id, qty, Number(item.cost_price_per_unit) || 0,
            round2(qty * (Number(item.cost_price_per_unit) || 0)),
            `Returned on delivery ${job.job_no}: ${note || status}`, String(user.id),
          ]);
        }
      }

      // The sale follows the job, but only if it is not void — a voided sale's
      // status is a historical record and must not be resurrected by a driver
      // tapping "delivered" on a job that was cancelled at the counter.
      if (job.sale_id) {
        tx.queue("UPDATE sales SET status = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'VOIDED' AND is_deleted = 0", [saleStatus, String(job.sale_id)]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'DELIVERY_STATUS_CHANGED', entityType: 'DELIVERY_JOB', entityId: id,
      branchId: job.branch_id, businessId: job.business_id,
      before: { status: previousStatus },
      after: { status, note, deliveredTo, proof, driver: assignedDriver, stockReturned: ['RETURNED', 'CANCELLED'].includes(status) },
    });

    ctx.json({
      ok: true,
      message: `${job.job_no} marked ${status.replace(/_/g, ' ').toLowerCase()}.${['RETURNED', 'CANCELLED'].includes(status) ? ' The goods have been returned to branch stock and the movement recorded as an adjustment.' : ''}${note ? ` Note: ${note}` : ''}`,
      previousStatus, status,
    });
  }));

  // -------------------------------------------------------------------
  // INSTALLATION
  // -------------------------------------------------------------------
  /**
   * Book installation work against a delivered job.
   *
   * Installation is its own job row rather than a flag on the delivery, because
   * it has its own fee, its own technician and — for appliances — its own
   * WARRANTY START DATE. A warranty that starts when the unit was sold rather
   * than when it was installed and commissioned charges the customer for the
   * weeks it sat in a warehouse, and manufacturers reject claims on that basis.
   */
  app.post(`${base}/deliveries/:id/installation`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const job = await db.first('SELECT * FROM delivery_jobs WHERE id = ? AND is_deleted = 0', [id]);
    if (!job) throw new HttpError('That delivery job does not exist.', { status: 404, code: 'DELIVERY_NOT_FOUND' });

    const productId = strField(body.product_id, { field: 'Product', maxLength: 64, required: true });
    const product = await db.first('SELECT * FROM products WHERE id = ? AND is_deleted = 0', [productId]);
    if (!product) throw new HttpError('That product does not exist.', { status: 404, code: 'PRODUCT_NOT_FOUND' });
    if (!Number(product.requires_installation)) {
      throw new HttpError(`${product.name} is not flagged as needing installation. If it does, tick that on the product first — the flag is what makes warranty start at commissioning rather than at sale.`, { status: 400, code: 'INSTALLATION_NOT_EXPECTED' });
    }

    const fee = numField(body.fee, { field: 'Installation fee', min: 0 });
    const feeCollected = numField(body.fee_collected ?? fee, { field: 'Fee collected', min: 0 });
    if (feeCollected > fee) {
      throw new HttpError(`You collected \u20a6${feeCollected.toLocaleString('en-NG')} against a \u20a6${fee.toLocaleString('en-NG')} fee. Correct one of the two.`, { status: 400, code: 'OVER_COLLECTION' });
    }
    const serialId = body.serial_id ? String(body.serial_id) : null;
    if (serialId) {
      const sn = await db.first('SELECT * FROM serial_numbers WHERE id = ? AND is_deleted = 0', [serialId]);
      if (!sn) throw new HttpError('That serial number does not exist.', { status: 404, code: 'SERIAL_NOT_FOUND' });
      if (String(sn.product_id) !== productId) throw new HttpError(`Serial ${sn.serial_no} belongs to another product, not ${product.name}.`, { status: 400, code: 'SERIAL_PRODUCT_MISMATCH' });
    }

    const existing = await db.first('SELECT * FROM installation_jobs WHERE delivery_job_id = ? AND product_id = ? AND status <> ? AND is_deleted = 0 ORDER BY created_at, id LIMIT 1', [id, productId, 'CANCELLED']);
    if (existing && !boolField(body.allow_duplicate)) {
      throw new HttpError(`${product.name} already has installation job ${existing.job_no} (${existing.status}). Complete or cancel it first — two open jobs for one unit is how a technician gets dispatched twice.`, { status: 409, code: 'INSTALLATION_ALREADY_BOOKED' });
    }

    const jobId = newId();
    const branchTag = String(job.branch_id).slice(0, 4).toUpperCase();
    const jobNo = `INS-${branchTag}-${String(job.job_no || '').replace(/^DLV-/, '')}-${product.sku || productId.slice(0, 4)}`.slice(0, 40);
    const startsWarranty = boolField(body.starts_warranty, true);

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO installation_jobs (
          id, job_no, delivery_job_id, sale_id, branch_id, business_id, customer_id, product_id, variant_id,
          serial_id, technician_name, technician_phone, scheduled_at, status, fee, fee_collected, parts_cost,
          warranty_starts_at, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'SCHEDULED', ?,?,?, ?, ?, ?, datetime('now'), datetime('now'))`, [
        jobId, jobNo, id, job.sale_id, String(job.branch_id), String(job.business_id), job.customer_id,
        productId, body.variant_id ? String(body.variant_id) : null, serialId,
        strField(body.technician_name, { field: 'Technician', maxLength: 120 }),
        strField(body.technician_phone, { field: 'Technician phone', maxLength: 40 }),
        strField(body.scheduled_at, { field: 'Scheduled for', maxLength: 40 }),
        fee, feeCollected, numField(body.parts_cost, { field: 'Parts cost', min: 0 }),
        // Null until it is actually commissioned. Setting it at booking would
        // start the warranty clock before the unit exists in the customer's home.
        null,
        strField(body.notes, { field: 'Notes', maxLength: 500 }),
        String(user.id),
      ]);
      if (serialId && startsWarranty) {
        tx.queue("UPDATE serial_numbers SET notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?",
          [`\nInstallation ${jobNo} booked ${watNow()} — warranty will start on commissioning.`, serialId]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'INSTALLATION_BOOKED', entityType: 'INSTALLATION_JOB', entityId: jobId,
      branchId: job.branch_id, businessId: job.business_id,
      after: { jobNo, product: product.name, fee, feeCollected, serialId },
    });
    ctx.json({
      ok: true, id: jobId, jobNo,
      message: `Installation ${jobNo} booked for ${product.name} at \u20a6${fee.toLocaleString('en-NG')}.`,
    }, 201);
  }));

  /** Complete an installation — this is where the warranty clock starts. */
  app.post(`${base}/installations/:id/complete`, idempotent(async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const job = await db.first('SELECT * FROM installation_jobs WHERE id = ? AND is_deleted = 0', [id]);
    if (!job) throw new HttpError('That installation job does not exist.', { status: 404, code: 'INSTALLATION_NOT_FOUND' });
    if (job.status === 'COMPLETED') throw new HttpError('That installation is already completed.', { status: 409, code: 'ALREADY_COMPLETED' });

    const product = await db.first('SELECT * FROM products WHERE id = ?', [job.product_id]);
    const completedAt = strField(body.completed_at, { field: 'Completed at', maxLength: 40 }) || watNow();
    const warrantyMonths = numField(body.warranty_months ?? (product ? product.warranty_months : 0), { field: 'Warranty months', min: 0, max: 360, whole: true });
    // Warranty starts at COMMISSIONING, not at sale. For an appliance delivered
    // in March and installed in May, those two dates are two months of cover
    // apart, and the manufacturer will honour the later one only if the record
    // shows the installation.
    const warrantyStartsAt = boolField(body.starts_warranty, true) && warrantyMonths > 0 ? completedAt.slice(0, 10) : null;
    const warrantyEndsAt = warrantyStartsAt ? addDays(warrantyStartsAt, warrantyMonths * 30).slice(0, 10) : null;
    const partsCost = numField(body.parts_cost ?? job.parts_cost, { field: 'Parts cost', min: 0 });
    const note = strField(body.note || body.notes, { field: 'Note', maxLength: 500 });

    await db.transaction(async (tx) => {
      tx.queue(`UPDATE installation_jobs SET status = 'COMPLETED', completed_at = ?, parts_cost = ?,
          warranty_starts_at = ?, notes = COALESCE(notes,'') || ?, updated_at = datetime('now')
        WHERE id = ? AND is_deleted = 0`, [
        completedAt, partsCost, warrantyStartsAt,
        note ? `\n[${completedAt}] Completed by ${user.full_name || user.username} — ${note}` : `\n[${completedAt}] Completed by ${user.full_name || user.username}`,
        id,
      ]);
      if (job.serial_id && warrantyStartsAt) {
        tx.queue(`UPDATE serial_numbers SET warranty_starts_at = ?, warranty_ends_at = ?,
            notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`, [
          warrantyStartsAt, warrantyEndsAt,
          `\nWarranty started ${warrantyStartsAt} on commissioning (${job.job_no}), ${warrantyMonths} month(s) to ${warrantyEndsAt}.`,
          String(job.serial_id),
        ]);
      }
      if (job.delivery_job_id) {
        tx.queue("UPDATE delivery_jobs SET status = 'DELIVERED', delivered_at = COALESCE(delivered_at, datetime('now')), updated_at = datetime('now') WHERE id = ? AND is_deleted = 0",
          [String(job.delivery_job_id)]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'INSTALLATION_COMPLETED', entityType: 'INSTALLATION_JOB', entityId: id,
      branchId: job.branch_id, businessId: job.business_id,
      before: { status: job.status },
      after: { completedAt, warrantyStartsAt, warrantyEndsAt, warrantyMonths, partsCost },
    });
    ctx.json({
      ok: true,
      message: `${job.job_no} completed.${warrantyEndsAt ? ` Warranty now runs to ${warrantyEndsAt} (${warrantyMonths} months from commissioning).` : ' No warranty attached to this unit.'}`,
      warrantyStartsAt, warrantyEndsAt,
    });
  }));
}

module.exports = { mount, normaliseLine, normalisePayments };
