'use strict';
// =====================================================================
// server/routes/customers.js — WHO OWES WHAT, AND WHAT THEY EARN
// =====================================================================
// Credit is how Nigerian retail actually runs: a contractor buys ₦2m of cement
// and pays when their own client pays them. The system has to serve that
// reality without letting it become an unbounded hole, so three things are true
// here and nowhere else is allowed to contradict them:
//
//   1. `customers.credit_balance` is a CACHE. The truth is `debtor_ledger`,
//      which is append-only with a running `balance_after` on every row. The
//      cache is set from the ledger's final figure, never computed separately —
//      two independent computations of the same balance is how a customer ends
//      up owing two different amounts on two screens.
//
//   2. AGEING IS DERIVED, NEVER STORED. How overdue an invoice is changes every
//      day without anything happening to it, so a stored `days_overdue` is
//      stale by definition. `domain/credit.ageBalance` buckets the ledger on
//      read.
//
//   3. LIMITS ARE ADVISORY AT THE MARGIN. Exceeding one requires a recorded
//      reason from somebody with authority, rather than a hard refusal, because
//      a shop that cannot serve its best customer on a Friday afternoon will
//      route the sale around the system entirely — and then there is no record
//      at all.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { atLeast } = require('../../domain/roles');
const { resolveBranch, resolveBusiness, inScope, scopeFilter, pagination, listResponse, dateRange, numField, strField, boolField, valid } = require('../lib/respond');
const { round2 } = require('../../domain/money');
const { newId } = require('../../domain/crypto');
const { watNow, watToday } = require('../../domain/time');
const { ageBalance, creditDecision, creditTerms, daysOverdue, overdueWarning } = require('../../domain/credit');
const { oneOf, nigerianPhone, normalisePhone } = require('../../domain/validation');
const glService = require('../services/glService');

// The schema allows exactly two. A trader who wants to distinguish resellers
// from end users does it with customer CLASSES, which carry the discount and
// credit terms that actually differ — not by inventing a type the CHECK refuses.
const CUSTOMER_TYPES = ['INDIVIDUAL', 'BUSINESS'];

// Phone normalisation is imported from domain/validation.js rather than
// re-implemented here on purpose. The same person is written 08031234567,
// +2348031234567 and 803 123 4567 on three different days by three different
// cashiers; without one shared normaliser the duplicate check misses and the
// customer is created twice — and then their credit limit is split across two
// records, so somebody owes ₦400,000 while BOTH accounts show them as within
// limit. Two implementations of the same normalisation will eventually disagree,
// and the disagreement is invisible until a debt goes uncollected.

function mount(app, base = '/api') {
  // -------------------------------------------------------------------
  // LIST / SEARCH
  // -------------------------------------------------------------------
  app.get(`${base}/customers`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const { limit, offset } = pagination(ctx);
    const where = ['c.is_deleted = 0'];
    const params = [];
    const f = scopeFilter(scope, { alias: 'c' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    const search = (ctx.req.queryParam('q') || '').trim();
    if (search) {
      where.push('(c.name LIKE ? OR c.company_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.tin LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    const type = ctx.req.queryParam('type');
    if (type) { where.push('c.customer_type = ?'); params.push(String(type).toUpperCase()); }
    const classId = ctx.req.queryParam('class_id');
    if (classId) { where.push('c.customer_class_id = ?'); params.push(String(classId)); }
    const filter = ctx.req.queryParam('filter');
    if (filter === 'debtors') where.push('c.credit_balance > 0');
    if (filter === 'inactive') where.push('c.is_active = 0');
    if (filter === 'overdue') where.push('c.credit_balance > 0'); // refined below by the ledger
    const whereSql = where.join(' AND ');

    const rows = await db.all(`SELECT c.*, cc.name AS class_name, cc.code AS class_code, cc.discount_pct AS class_discount_pct,
          cc.credit_allowed AS class_credit_allowed, b.name AS branch_name, pl.name AS price_list_name,
          (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.is_deleted = 0 AND s.status <> 'VOIDED') AS sale_count,
          (SELECT COALESCE(SUM(s.total),0) FROM sales s WHERE s.customer_id = c.id AND s.is_deleted = 0 AND s.status <> 'VOIDED') AS lifetime_value,
          (SELECT MAX(s.sold_at) FROM sales s WHERE s.customer_id = c.id AND s.is_deleted = 0 AND s.status <> 'VOIDED') AS last_purchase_at
        FROM customers c
        LEFT JOIN customer_classes cc ON cc.id = c.customer_class_id
        LEFT JOIN branches b ON b.id = c.branch_id
        LEFT JOIN price_lists pl ON pl.id = c.price_list_id
        WHERE ${whereSql}
        ORDER BY c.name COLLATE NOCASE LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.scalar(`SELECT COUNT(*) FROM customers c WHERE ${whereSql}`, params);

    let data = rows.map((r) => ({
      ...r,
      credit_balance: round2(Number(r.credit_balance)),
      credit_limit: round2(Number(r.credit_limit)),
      available_credit: round2(Math.max(0, Number(r.credit_limit) - Number(r.credit_balance))),
      at_limit: Number(r.credit_limit) > 0 && Number(r.credit_balance) >= Number(r.credit_limit),
      lifetime_value: round2(Number(r.lifetime_value)),
      phone_normalised: normalisePhone(r.phone),
    }));

    if (filter === 'overdue') {
      // Ageing needs the ledger, so it is applied after the page is fetched
      // rather than in SQL: `debtor_ledger` has no due_date column, and the due
      // date is derived from the customer's terms at the time of each sale.
      const aged = await Promise.all(data.map(async (c) => {
        const entries = await db.all('SELECT * FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0 ORDER BY created_at, id', [String(c.id)]);
        return { id: c.id, ageing: ageBalance(entries) };
      }));
      const byId = new Map(aged.map((a) => [a.id, a.ageing]));
      data = data.filter((c) => {
        const a = byId.get(c.id);
        return a && (a.bucket_31_60 + a.bucket_61_90 + a.bucket_90_plus) > 0;
      }).map((c) => ({ ...c, ageing: byId.get(c.id) }));
    }

    ctx.json(listResponse(data, { limit, offset }, total));
  });

  /**
   * The debtor book: everybody who owes money, aged.
   *
   * This is the single most important screen for a business selling on credit,
   * because it is the only place that answers "how much of my working capital is
   * sitting with customers, and how much of that is going bad?".
   */
  app.get(`${base}/customers/debtors`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const scope = ctx.get('scope');
    const asAt = strField(ctx.req.queryParam('as_at'), { field: 'As-at date', maxLength: 10 }) || watToday();

    const where = ['c.is_deleted = 0', 'c.credit_balance > 0'];
    const params = [];
    const f = scopeFilter(scope, { alias: 'c' });
    if (f.sql) { where.push(f.sql); params.push(...f.params); }

    const rows = await db.all(`SELECT c.id, c.name, c.company_name, c.phone, c.credit_limit, c.credit_balance,
          c.payment_terms_days, c.branch_id, c.business_id, c.customer_class_id,
          cc.name AS class_name, b.name AS branch_name,
          (SELECT MIN(s.due_date) FROM sales s WHERE s.customer_id = c.id AND s.balance_due > 0
             AND s.status <> 'VOIDED' AND s.is_deleted = 0) AS oldest_due_date,
          (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.balance_due > 0
             AND s.status <> 'VOIDED' AND s.is_deleted = 0) AS open_invoices
        FROM customers c
        LEFT JOIN customer_classes cc ON cc.id = c.customer_class_id
        LEFT JOIN branches b ON b.id = c.branch_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.credit_balance DESC LIMIT 500`, params);

    const debtors = [];
    for (const r of rows) {
      const entries = await db.all('SELECT * FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0 ORDER BY created_at, id', [String(r.id)]);
      const ageing = ageBalance(entries, { today: asAt });
      const warn = overdueWarning({ entries, today: asAt });
      debtors.push({
        ...r,
        credit_balance: round2(Number(r.credit_balance)),
        ageing,
        oldestDays: r.oldest_due_date ? daysOverdue(r.oldest_due_date, { today: asAt }) : null,
        warning: warn,
        overLimit: Number(r.credit_limit) > 0 && Number(r.credit_balance) > Number(r.credit_limit),
        overLimitBy: Number(r.credit_limit) > 0 ? round2(Math.max(0, Number(r.credit_balance) - Number(r.credit_limit))) : null,
      });
    }

    // Totals keyed to ageBalance's own bucket names, so the per-debtor rows and
    // the summary can never drift apart.
    const buckets = debtors.reduce((a, d) => ({
      bucket_0_30: round2(a.bucket_0_30 + d.ageing.bucket_0_30),
      bucket_31_60: round2(a.bucket_31_60 + d.ageing.bucket_31_60),
      bucket_61_90: round2(a.bucket_61_90 + d.ageing.bucket_61_90),
      bucket_90_plus: round2(a.bucket_90_plus + d.ageing.bucket_90_plus),
    }), { bucket_0_30: 0, bucket_31_60: 0, bucket_61_90: 0, bucket_90_plus: 0 });
    const totalOwed = round2(debtors.reduce((a, d) => a + d.credit_balance, 0));
    const totalOverdue = round2(buckets.bucket_31_60 + buckets.bucket_61_90 + buckets.bucket_90_plus);

    ctx.json({
      ok: true, asAt, debtors, buckets,
      summary: {
        debtorCount: debtors.length, totalOwed, totalOverdue,
        overduePct: totalOwed > 0 ? round2((totalOverdue / totalOwed) * 100) : 0,
        overLimitCount: debtors.filter((d) => d.overLimit).length,
        // Anything over 90 days on a retail book is, realistically, gone. It is
        // reported separately because it belongs in a provision, not in working
        // capital, and an owner who sees one blended "debtors" figure will keep
        // planning around money that will not arrive.
        likelyBad: buckets.bucket_90_plus,
      },
    });
  });

  // -------------------------------------------------------------------
  // CREATE / UPDATE
  // -------------------------------------------------------------------
  app.post(`${base}/customers`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const body = await ctx.req.json();
    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);

    const name = strField(requireVal(body, 'name'), { field: 'Customer name', maxLength: 160, required: true });
    if (name.length < 2) throw new HttpError('Enter the customer\'s real name. A credit account has to belong to somebody findable.', { status: 400, code: 'NAME_TOO_SHORT' });

    const phone = normalisePhone(body.phone);
    if (body.phone && !phone) throw new HttpError('That phone number has no digits in it.', { status: 400, code: 'INVALID_PHONE', fields: { phone: 'Digits expected' } });
    if (phone) {
      const check = nigerianPhone(phone, { required: false });
      if (!check.ok) ctx.set('phoneAdvisory', check.error); // ADVISORY: never blocks
    }

    // Duplicate detection on the normalised number. This is the check that stops
    // one person accumulating two credit limits.
    if (phone) {
      const dupe = await db.first('SELECT id, name, phone, credit_balance FROM customers WHERE phone = ? AND is_deleted = 0 AND business_id = ? ORDER BY created_at, id', [phone, String(business.id)]);
      if (dupe && !boolField(body.allow_duplicate)) {
        throw new HttpError(
          `${dupe.name} is already on ${phone}${Number(dupe.credit_balance) > 0 ? ` and owes ₦${Number(dupe.credit_balance).toLocaleString('en-NG')}` : ''}. Open that record instead — creating a second one splits their credit limit in two. Pass allow_duplicate if this really is a different person who shares the number.`,
          { status: 409, code: 'DUPLICATE_PHONE', fields: { phone: dupe.name } },
        );
      }
    }

    const customerType = valid(oneOf(body.customer_type || 'INDIVIDUAL', CUSTOMER_TYPES, { field: 'Customer type' }), 'customer_type');
    const classId = body.customer_class_id ? String(body.customer_class_id) : null;
    const customerClass = classId ? await db.first('SELECT * FROM customer_classes WHERE id = ? AND is_deleted = 0', [classId]) : null;
    if (classId && !customerClass) throw new HttpError('That customer class does not exist.', { status: 404, code: 'CLASS_NOT_FOUND' });

    const creditLimit = numField(body.credit_limit, { field: 'Credit limit', min: 0 });
    // A limit is only meaningful if credit is actually permitted for the class,
    // and only staff with authority should be granting one at all.
    if (creditLimit > 0) {
      if (customerClass && !Number(customerClass.credit_allowed)) {
        throw new HttpError(`The ${customerClass.name} class is not allowed to buy on credit, so it cannot carry a ₦${creditLimit.toLocaleString('en-NG')} limit. Change their class, or set the limit to zero.`, { status: 400, code: 'CLASS_CREDIT_NOT_ALLOWED' });
      }
      if (!atLeast(user.role, 'MANAGER')) {
        throw new HttpError(`Only a manager or above can grant a credit limit. Ask a manager to set ₦${creditLimit.toLocaleString('en-NG')} for ${name}.`, { status: 403, code: 'CREDIT_LIMIT_NEEDS_MANAGER' });
      }
      const maxDays = Number(settings.credit_max_days) || 0;
      const terms = numField(body.payment_terms_days ?? (customerClass ? customerClass.payment_terms_days : 0), { field: 'Payment terms', min: 0, max: 365, whole: true });
      if (maxDays > 0 && terms > maxDays) {
        throw new HttpError(`This business allows at most ${maxDays} days of credit; ${terms} was requested.`, { status: 400, code: 'TERMS_OVER_LIMIT' });
      }
    }
    const paymentTermsDays = numField(body.payment_terms_days ?? (customerClass ? customerClass.payment_terms_days : 0), { field: 'Payment terms', min: 0, max: 365, whole: true });

    const tin = strField(body.tin, { field: 'TIN', maxLength: 40 });
    const id = newId();

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO customers (
          id, business_id, branch_id, customer_class_id, customer_type, name, company_name, phone, alt_phone,
          email, address, city, state, tin, cac_reg_no, credit_limit, credit_balance, payment_terms_days,
          price_list_id, loyalty_points, notes, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 0,?,?, 0,?, 1, datetime('now'), datetime('now'))`, [
        id, String(business.id), String(branch.id), classId, customerType, name,
        strField(body.company_name, { field: 'Company name', maxLength: 200 }),
        phone,
        normalisePhone(body.alt_phone),
        strField(body.email, { field: 'Email', maxLength: 160 }),
        strField(body.address, { field: 'Address', maxLength: 300 }),
        strField(body.city, { field: 'City', maxLength: 80 }),
        strField(body.state, { field: 'State', maxLength: 80 }),
        tin,
        strField(body.cac_reg_no, { field: 'CAC number', maxLength: 40 }),
        creditLimit, paymentTermsDays,
        body.price_list_id ? String(body.price_list_id) : (customerClass ? customerClass.default_price_list_id : null),
        strField(body.notes, { field: 'Notes', maxLength: 1000 }),
      ]);
    });

    await recordFromCtx(ctx, {
      action: 'CUSTOMER_CREATED', entityType: 'CUSTOMER', entityId: id, branchId: branch.id, businessId: business.id,
      after: { name, phone, customerType, classId, creditLimit, paymentTermsDays, tin },
    });
    ctx.json({
      ok: true, id,
      message: `${name} added${creditLimit > 0 ? ` with a ₦${creditLimit.toLocaleString('en-NG')} credit limit on ${paymentTermsDays}-day terms` : ''}.`,
      warnings: [ctx.get('phoneAdvisory')].filter(Boolean),
    }, 201);
  });

  app.get(`${base}/customers/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const customer = await db.first(`SELECT c.*, cc.name AS class_name, cc.code AS class_code,
          cc.discount_pct AS class_discount_pct, b.name AS branch_name, biz.name AS business_name,
          pl.name AS price_list_name
        FROM customers c
        LEFT JOIN customer_classes cc ON cc.id = c.customer_class_id
        LEFT JOIN branches b ON b.id = c.branch_id
        LEFT JOIN businesses biz ON biz.id = c.business_id
        LEFT JOIN price_lists pl ON pl.id = c.price_list_id
        WHERE c.id = ? AND c.is_deleted = 0`, [id]);
    if (!customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });
    if (!inScope(ctx.get('scope'), customer)) throw new HttpError('That customer belongs to another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });

    const [entries, sales, deposits, plans, recent] = await Promise.all([
      db.all(`SELECT dl.*, s.receipt_no, b.name AS branch_name FROM debtor_ledger dl
          LEFT JOIN sales s ON s.id = dl.reference_id
          LEFT JOIN branches b ON b.id = dl.branch_id
          WHERE dl.customer_id = ? AND dl.is_deleted = 0 ORDER BY dl.created_at DESC, dl.id DESC LIMIT 200`, [id]),
      db.first(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(balance_due),0) AS outstanding,
            MIN(sold_at) AS first_purchase, MAX(sold_at) AS last_purchase, COALESCE(AVG(total),0) AS average_sale
          FROM sales WHERE customer_id = ? AND status <> 'VOIDED' AND is_deleted = 0`, [id]),
      db.all(`SELECT d.*, p.name AS product_name FROM deposits d
          LEFT JOIN products p ON p.id = d.product_id
          WHERE d.customer_id = ? AND d.status = 'ACTIVE' AND d.is_deleted = 0
          ORDER BY d.created_at DESC LIMIT 50`, [id]),
      db.all(`SELECT ip.*, c.name AS customer_name FROM instalment_plans ip
          LEFT JOIN customers c ON c.id = ip.customer_id
          WHERE ip.customer_id = ? AND ip.status NOT IN ('COMPLETED','CANCELLED') AND ip.is_deleted = 0
          ORDER BY ip.created_at DESC LIMIT 50`, [id]),
      db.all(`SELECT s.id, s.receipt_no, s.sold_at, s.total, s.balance_due, s.status, s.payment_method,
            b.name AS branch_name FROM sales s LEFT JOIN branches b ON b.id = s.branch_id
          WHERE s.customer_id = ? AND s.is_deleted = 0 ORDER BY s.sold_at DESC LIMIT 10`, [id]),
    ]);

    const ageing = ageBalance(entries);
    const terms = creditTerms({ customer, settings: ctx.get('settings') });
    const decision = creditDecision({
      customer, currentBalance: Number(customer.credit_balance) || 0, requestedAmount: 0,
      canOverride: false, settings: ctx.get('settings'),
    });

    ctx.json({
      ok: true, customer: { ...customer, credit_balance: round2(Number(customer.credit_balance)), credit_limit: round2(Number(customer.credit_limit)) },
      ledger: entries, ageing, deposits, instalmentPlans: plans, recentSales: recent,
      stats: {
        purchases: Number(sales.count) || 0,
        revenue: round2(Number(sales.revenue)),
        outstanding: round2(Number(sales.outstanding)),
        firstPurchase: sales.first_purchase, lastPurchase: sales.last_purchase,
        averageSale: round2(Number(sales.average_sale)),
        loyaltyPoints: Number(customer.loyalty_points) || 0,
      },
      credit: {
        available: round2(Math.max(0, Number(customer.credit_limit) - Number(customer.credit_balance))),
        atLimit: Number(customer.credit_limit) > 0 && Number(customer.credit_balance) >= Number(customer.credit_limit),
        termsDays: terms.days, nextDueDate: terms.dueDate,
        termsCapped: terms.capped, termsMessage: terms.message,
        warning: overdueWarning({ entries, settings: ctx.get('settings') }),
        decision: decision.decision, message: decision.message,
      },
    });
  });

  app.put(`${base}/customers/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const settings = ctx.get('settings');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const customer = await db.first('SELECT * FROM customers WHERE id = ? AND is_deleted = 0', [id]);
    if (!customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });
    if (!inScope(ctx.get('scope'), customer)) throw new HttpError('That customer belongs to another branch.', { status: 403, code: 'BRANCH_SCOPE_VIOLATION' });

    const sets = []; const params = [];
    const strings = {
      name: { field: 'Customer name', maxLength: 160 }, company_name: { field: 'Company name', maxLength: 200 },
      email: { field: 'Email', maxLength: 160 }, address: { field: 'Address', maxLength: 300 },
      city: { field: 'City', maxLength: 80 }, state: { field: 'State', maxLength: 80 },
      tin: { field: 'TIN', maxLength: 40 }, cac_reg_no: { field: 'CAC number', maxLength: 40 },
      notes: { field: 'Notes', maxLength: 1000 },
    };
    for (const [col, opts] of Object.entries(strings)) {
      if (body[col] !== undefined) { sets.push(`${col} = ?`); params.push(strField(body[col], opts)); }
    }
    if (body.phone !== undefined) {
      const phone = normalisePhone(body.phone);
      if (phone && phone !== customer.phone) {
        const dupe = await db.first('SELECT id, name FROM customers WHERE phone = ? AND is_deleted = 0 AND id <> ? ORDER BY created_at, id', [phone, id]);
        if (dupe) throw new HttpError(`${dupe.name} already has ${phone}. Two customers cannot share one number, or the credit history splits between them.`, { status: 409, code: 'DUPLICATE_PHONE' });
      }
      sets.push('phone = ?'); params.push(phone);
    }
    if (body.customer_type !== undefined) { sets.push('customer_type = ?'); params.push(valid(oneOf(body.customer_type, CUSTOMER_TYPES, { field: 'Customer type' }), 'customer_type')); }
    if (body.customer_class_id !== undefined) {
      const cid = body.customer_class_id ? String(body.customer_class_id) : null;
      if (cid) {
        const cls = await db.first('SELECT * FROM customer_classes WHERE id = ? AND is_deleted = 0', [cid]);
        if (!cls) throw new HttpError('That customer class does not exist.', { status: 404, code: 'CLASS_NOT_FOUND' });
        if (!Number(cls.credit_allowed) && Number(customer.credit_balance) > 0) {
          throw new HttpError(`${customer.name} still owes ₦${Number(customer.credit_balance).toLocaleString('en-NG')}, so they cannot be moved to ${cls.name}, which does not allow credit. Collect the balance first.`, { status: 409, code: 'CLASS_CREDIT_NOT_ALLOWED' });
        }
      }
      sets.push('customer_class_id = ?'); params.push(cid);
    }
    // THE CREDIT LIMIT is the sensitive one: it is the only field here that lets
    // a customer take more goods than they have paid for, so it needs manager
    // authority and an audit trail of the old value.
    if (body.credit_limit !== undefined) {
      const limit = numField(body.credit_limit, { field: 'Credit limit', min: 0 });
      if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can change a credit limit.', { status: 403, code: 'CREDIT_LIMIT_NEEDS_MANAGER' });
      if (limit < Number(customer.credit_balance)) {
        throw new HttpError(`${customer.name} already owes ₦${Number(customer.credit_balance).toLocaleString('en-NG')}. A limit below what they owe would show them as over limit the moment it is saved — collect some of it first, or set the limit to what they owe.`, { status: 400, code: 'LIMIT_BELOW_BALANCE' });
      }
      sets.push('credit_limit = ?'); params.push(limit);
    }
    if (body.payment_terms_days !== undefined) {
      const days = numField(body.payment_terms_days, { field: 'Payment terms', min: 0, max: 365, whole: true });
      const maxDays = Number(settings.credit_max_days) || 0;
      if (maxDays > 0 && days > maxDays) throw new HttpError(`This business allows at most ${maxDays} days of credit.`, { status: 400, code: 'TERMS_OVER_LIMIT' });
      sets.push('payment_terms_days = ?'); params.push(days);
    }
    if (body.is_active !== undefined) { sets.push('is_active = ?'); params.push(boolField(body.is_active, 1)); }
    if (body.price_list_id !== undefined) { sets.push('price_list_id = ?'); params.push(body.price_list_id ? String(body.price_list_id) : null); }

    // credit_balance is NEVER settable from a request. It is a cache of the
    // ledger, and a route that let a caller write it would let anybody erase a
    // debt without a payment row explaining where the money came from.
    if (!sets.length) throw new HttpError('Nothing to update. Send the fields you want to change.', { status: 400, code: 'NO_CHANGES' });

    sets.push("updated_at = datetime('now')");
    params.push(id);
    const before = { ...customer };
    await db.run(`UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND is_deleted = 0`, params);

    await recordFromCtx(ctx, {
      action: 'CUSTOMER_UPDATED', entityType: 'CUSTOMER', entityId: id, branchId: customer.branch_id, businessId: customer.business_id,
      before: { name: before.name, phone: before.phone, credit_limit: before.credit_limit, customer_class_id: before.customer_class_id, payment_terms_days: before.payment_terms_days, is_active: before.is_active },
      after: body,
    });
    ctx.json({ ok: true, message: `${body.name || customer.name} updated.` });
  });

  /** Soft delete. The ledger and every sale they made stay, because they are the record. */
  app.delete(`${base}/customers/:id`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can remove a customer.', { status: 403, code: 'ROLE_REQUIRED' });
    const id = String(ctx.req.param('id'));
    const customer = await db.first('SELECT * FROM customers WHERE id = ? AND is_deleted = 0', [id]);
    if (!customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });
    if (Number(customer.credit_balance) > 0) {
      throw new HttpError(`${customer.name} still owes ₦${Number(customer.credit_balance).toLocaleString('en-NG')}. A debtor cannot be deleted — collect or write off the balance first, so the decision is on the record.`, { status: 409, code: 'CUSTOMER_HAS_DEBT' });
    }
    const sales = await db.scalar('SELECT COUNT(*) FROM sales WHERE customer_id = ? AND is_deleted = 0', [id]);
    await db.run("UPDATE customers SET is_deleted = 1, is_active = 0, notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?",
      [`\n| Removed ${watNow()} by ${user.full_name || user.username}`, id]);
    await recordFromCtx(ctx, {
      action: 'CUSTOMER_DELETED', entityType: 'CUSTOMER', entityId: id, branchId: customer.branch_id, businessId: customer.business_id,
      before: { name: customer.name, salesCount: sales }, after: { is_deleted: 1 },
    });
    ctx.json({ ok: true, message: `${customer.name} removed. Their ${sales} past sale(s) and ledger stay on file — a deleted customer is hidden, not erased.` });
  });

  // -------------------------------------------------------------------
  // LEDGER + STATEMENT
  // -------------------------------------------------------------------
  app.get(`${base}/customers/:id/ledger`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const customer = await db.first('SELECT * FROM customers WHERE id = ? AND is_deleted = 0', [id]);
    if (!customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });
    const { limit, offset } = pagination(ctx);
    const rows = await db.all(`SELECT dl.*, s.receipt_no, s.sold_at, s.due_date, b.name AS branch_name, u.full_name AS created_by_name
        FROM debtor_ledger dl
        LEFT JOIN sales s ON s.id = dl.reference_id
        LEFT JOIN branches b ON b.id = dl.branch_id
        LEFT JOIN users u ON u.id = dl.created_by
        WHERE dl.customer_id = ? AND dl.is_deleted = 0
        ORDER BY dl.created_at DESC, dl.id DESC LIMIT ? OFFSET ?`, [id, limit, offset]);
    const total = await db.scalar('SELECT COUNT(*) FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0', [id]);
    const all = await db.all('SELECT * FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0 ORDER BY created_at, id', [id]);
    // Recompute the balance from the chain and compare with the cached column.
    // When these disagree the cache is wrong, and saying so beats showing two
    // numbers and letting the user pick.
    const computed = all.length ? round2(Number(all[all.length - 1].balance_after)) : 0;
    ctx.json({
      ...listResponse(rows, { limit, offset }, total),
      customer: { id: customer.id, name: customer.name, credit_balance: round2(Number(customer.credit_balance)), credit_limit: round2(Number(customer.credit_limit)) },
      ageing: ageBalance(all),
      recomputedBalance: computed,
      cacheConsistent: Math.abs(computed - round2(Number(customer.credit_balance))) < 0.01,
      cacheMessage: Math.abs(computed - round2(Number(customer.credit_balance))) < 0.01
        ? null
        : `The stored balance (₦${Number(customer.credit_balance).toLocaleString('en-NG')}) disagrees with the ledger (₦${computed.toLocaleString('en-NG')}). A ledger row has been edited outside this app.`,
    });
  });

  /** A printable statement: opening balance, every movement, closing balance. */
  app.get(`${base}/customers/:id/statement`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const id = String(ctx.req.param('id'));
    const { from, to } = dateRange(ctx, { defaultDays: 30 });
    const customer = await db.first(`SELECT c.*, cc.name AS class_name, b.name AS branch_name, biz.name AS business_name,
          biz.legal_name, biz.address AS business_address, biz.tin AS business_tin
        FROM customers c
        LEFT JOIN customer_classes cc ON cc.id = c.customer_class_id
        LEFT JOIN branches b ON b.id = c.branch_id
        LEFT JOIN businesses biz ON biz.id = c.business_id
        WHERE c.id = ? AND c.is_deleted = 0`, [id]);
    if (!customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });

    const all = await db.all(`SELECT dl.*, s.receipt_no, s.sold_at, s.due_date, s.status AS sale_status, b.name AS branch_name
        FROM debtor_ledger dl
        LEFT JOIN sales s ON s.id = dl.reference_id
        LEFT JOIN branches b ON b.id = dl.branch_id
        WHERE dl.customer_id = ? AND dl.is_deleted = 0 ORDER BY dl.created_at, dl.id`, [id]);

    // Opening balance = everything BEFORE the window. Built by summing the
    // ledger rather than trusting a stored figure, so the statement always
    // foots: opening + debits - credits = closing.
    const opening = round2(all.filter((e) => String(e.created_at).slice(0, 10) < from).reduce((a, e) => a + Number(e.amount), 0));
    const inWindow = all.filter((e) => String(e.created_at).slice(0, 10) >= from && String(e.created_at).slice(0, 10) <= to);
    const closing = round2(opening + inWindow.reduce((a, e) => a + Number(e.amount), 0));

    ctx.json({
      ok: true, customer, range: { from, to },
      opening, closing,
      entries: inWindow.map((e) => ({
        ...e,
        amount: round2(Number(e.amount)),
        debit: Number(e.amount) > 0 ? round2(Number(e.amount)) : 0,
        credit: Number(e.amount) < 0 ? round2(-Number(e.amount)) : 0,
      })),
      totals: {
        debits: round2(inWindow.filter((e) => Number(e.amount) > 0).reduce((a, e) => a + Number(e.amount), 0)),
        credits: round2(inWindow.filter((e) => Number(e.amount) < 0).reduce((a, e) => a - Number(e.amount), 0)),
      },
      ageing: ageBalance(all, { today: to }),
    });
  });

  /**
   * Take a payment on account — not against a specific invoice.
   *
   * Distinct from `POST /api/sales/:id/pay`, which settles one invoice. A
   * customer who pays ₦100,000 "on account" without saying which invoice is
   * normal here, and forcing them to allocate it would mean the money sat
   * unrecorded until somebody worked out the allocation.
   */
  app.post(`${base}/customers/:id/payments`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const customer = await db.first('SELECT * FROM customers WHERE id = ? AND is_deleted = 0', [id]);
    if (!customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });

    const branch = await resolveBranch(db, ctx);
    const business = await resolveBusiness(db, ctx, branch);
    const amount = numField(requireVal(body, 'amount'), { field: 'Amount', min: 0.01 });
    const method = valid(oneOf(body.method || body.payment_method || 'CASH', ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'USSD', 'CHEQUE'], { field: 'Payment method' }), 'method');
    const reference = strField(body.reference, { field: 'Reference', maxLength: 80 });
    if (method === 'BANK_TRANSFER' && !reference) {
      throw new HttpError('A transfer needs its reference or alert code. Without one there is no way to match this to the bank statement, and an unmatched transfer is indistinguishable from a fictitious one.', { status: 400, code: 'REFERENCE_REQUIRED', fields: { reference: 'Required for transfers' } });
    }
    if (method === 'CHEQUE' && !reference) {
      throw new HttpError('Record the cheque number. A cheque payment with no number cannot be traced if it bounces.', { status: 400, code: 'REFERENCE_REQUIRED', fields: { reference: 'Cheque number required' } });
    }

    const balanceBefore = round2(Number(customer.credit_balance) || 0);
    // A payment larger than the balance becomes a credit on the account rather
    // than a negative debt. Letting the balance go negative would make the
    // customer look like they owe less than nothing, and the debtor book total
    // would understate what is actually owed by everybody else.
    const applied = Math.min(amount, balanceBefore);
    const onAccount = round2(amount - applied);
    const balanceAfter = round2(balanceBefore - applied);

    const note = strField(body.notes || body.note, { field: 'Note', maxLength: 500 });
    const allocateTo = body.allocate_to_sale ? String(body.allocate_to_sale) : null;
    let sale = null;
    if (allocateTo) {
      sale = await db.first('SELECT * FROM sales WHERE id = ? AND customer_id = ? AND is_deleted = 0', [allocateTo, id]);
      if (!sale) throw new HttpError('That sale does not exist or belongs to another customer.', { status: 404, code: 'SALE_NOT_FOUND' });
      if (sale.status === 'VOIDED') throw new HttpError('That sale is void — there is nothing to allocate against.', { status: 409, code: 'SALE_VOID' });
    }

    const accountIds = await glService.loadAccountCodes(db, business.id);
    const ledgerId = newId();
    const till = await db.first("SELECT * FROM till_sessions WHERE branch_id = ? AND user_id = ? AND status = 'OPEN' AND is_deleted = 0 ORDER BY opened_at DESC LIMIT 1",
      [String(branch.id), String(user.id)]);

    await db.transaction(async (tx) => {
      if (sale) {
        tx.queue(`INSERT INTO sale_payments (
            id, sale_id, branch_id, till_session_id, method, amount, reference, bank_name,
            status, cash_tendered, change_given, recorded_by, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?, ?, 0, ?, ?, datetime('now'), datetime('now'))`, [
          newId(), String(sale.id), String(branch.id), till ? String(till.id) : null,
          method, applied, reference, strField(body.bank_name, { field: 'Bank', maxLength: 120 }),
          method === 'CHEQUE' ? 'PENDING_CLEARANCE' : 'CLEARED',
          applied, String(user.id), note || `Payment on account against ${sale.receipt_no}`,
        ]);
        tx.queue(`UPDATE sales SET balance_due = balance_due - ?, amount_paid = amount_paid + ?,
            status = CASE WHEN balance_due - ? <= 0 THEN 'COMPLETED' ELSE status END,
            updated_at = datetime('now') WHERE id = ?`, [applied, applied, applied, String(sale.id)]);
      }
      tx.queue(`INSERT INTO debtor_ledger (
          id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?, ?,?,?, ?, datetime('now'), datetime('now'))`, [
        ledgerId, String(branch.id), String(business.id), id,
        sale ? 'PAYMENT' : 'PAYMENT',
        sale ? String(sale.id) : null,
        -applied, balanceAfter,
        note || `Payment received by ${method.replace(/_/g, ' ').toLowerCase()}${reference ? `, ref ${reference}` : ''}`,
        String(user.id),
      ]);
      if (onAccount > 0) {
        tx.queue(`INSERT INTO debtor_ledger (
            id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
          VALUES (?,?,?,?, 'ADJUSTMENT', NULL, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
          newId(), String(branch.id), String(business.id), id,
          -onAccount, round2(balanceAfter - onAccount),
          `Overpayment of ₦${onAccount.toLocaleString('en-NG')} held as a credit on account`, String(user.id),
        ]);
      }
      tx.queue("UPDATE customers SET credit_balance = ?, updated_at = datetime('now') WHERE id = ?",
        [round2(balanceAfter - onAccount), id]);

      for (const st of glService.postDebtorPaymentStatements({
        businessId: String(business.id), branchId: String(branch.id), customerId: id,
        customerName: customer.name, amount, method, reference: reference || (sale ? sale.receipt_no : null),
        accountIds, user,
      })) tx.queue(st.sql, st.params);

      if (till) {
        const col = { CASH: 'cash_sales_total', POS_TERMINAL: 'pos_total', BANK_TRANSFER: 'transfer_total', MOBILE_MONEY: 'mobile_money_total', USSD: 'mobile_money_total', CHEQUE: 'cheque_total' }[method];
        if (col) tx.queue(`UPDATE till_sessions SET ${col} = COALESCE(${col},0) + ?, grand_total = COALESCE(grand_total,0) + ?, updated_at = datetime('now') WHERE id = ?`, [amount, amount, String(till.id)]);
      }
    });

    await recordFromCtx(ctx, {
      action: 'CUSTOMER_PAYMENT', entityType: 'CUSTOMER', entityId: id, branchId: branch.id, businessId: business.id,
      before: { balance: balanceBefore }, after: { amount, method, reference, applied, onAccount, balanceAfter: round2(balanceAfter - onAccount), saleId: allocateTo },
    });
    ctx.json({
      ok: true, id: ledgerId,
      message: `₦${amount.toLocaleString('en-NG')} received from ${customer.name}.${sale ? ` Applied to ${sale.receipt_no}.` : ''}${onAccount > 0 ? ` ₦${onAccount.toLocaleString('en-NG')} is held as a credit on their account.` : ''} They now owe ₦${round2(balanceAfter - onAccount).toLocaleString('en-NG')}.`,
      balanceBefore, applied, onAccount, balanceAfter: round2(balanceAfter - onAccount),
      chequePending: method === 'CHEQUE',
      warning: method === 'CHEQUE' ? 'A cheque is recorded as pending clearance. It stays on the account until the bank confirms it — do not release goods against an uncleared cheque.' : null,
    }, 201);
  });

  // -------------------------------------------------------------------
  // CUSTOMER CLASSES
  // -------------------------------------------------------------------
  app.get(`${base}/customer-classes`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const business = await resolveBusiness(db, ctx);
    const rows = await db.all(`SELECT cc.*, (SELECT COUNT(*) FROM customers c WHERE c.customer_class_id = cc.id AND c.is_deleted = 0) AS customer_count,
          pl.name AS price_list_name
        FROM customer_classes cc LEFT JOIN price_lists pl ON pl.id = cc.default_price_list_id
        WHERE cc.is_deleted = 0 AND (cc.business_id = ? OR cc.business_id IS NULL)
        ORDER BY cc.is_system DESC, cc.name`, [String(business.id)]);
    ctx.json({ ok: true, data: rows });
  });

  app.post(`${base}/customer-classes`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only an owner can create a customer class. A class sets the discount and credit terms for everybody in it.', { status: 403, code: 'ROLE_REQUIRED' });
    const body = await ctx.req.json();
    const business = await resolveBusiness(db, ctx);
    const name = strField(requireVal(body, 'name'), { field: 'Class name', maxLength: 80, required: true });
    const code = (strField(body.code, { field: 'Code', maxLength: 20 }) || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)).toUpperCase();
    const dupe = await db.first('SELECT id FROM customer_classes WHERE code = ? AND is_deleted = 0', [code]);
    if (dupe) throw new HttpError(`A class with the code ${code} already exists.`, { status: 409, code: 'DUPLICATE_CODE' });
    const discountPct = numField(body.discount_pct, { field: 'Discount', min: 0, max: 100 });
    const creditAllowed = boolField(body.credit_allowed);
    const defaultLimit = creditAllowed ? numField(body.default_credit_limit, { field: 'Default credit limit', min: 0 }) : 0;
    if (!creditAllowed && defaultLimit > 0) {
      throw new HttpError('A class that cannot buy on credit cannot carry a default credit limit. Either allow credit or set the limit to zero.', { status: 400, code: 'CONTRADICTORY_CLASS' });
    }
    const terms = creditAllowed ? numField(body.payment_terms_days, { field: 'Payment terms', min: 0, max: 365, whole: true }) : 0;
    const id = newId();
    await db.run(`INSERT INTO customer_classes (
        id, business_id, code, name, default_price_list_id, discount_pct, credit_allowed,
        default_credit_limit, payment_terms_days, is_system, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, 0, 1, datetime('now'), datetime('now'))`, [
      id, String(business.id), code, name,
      body.default_price_list_id ? String(body.default_price_list_id) : null,
      discountPct, creditAllowed, defaultLimit, terms,
    ]);
    await recordFromCtx(ctx, { action: 'CUSTOMER_CLASS_CREATED', entityType: 'CUSTOMER_CLASS', entityId: id, businessId: business.id, after: { name, code, discountPct, creditAllowed, defaultLimit, terms } });
    ctx.json({ ok: true, id, message: `Customer class ${name} created${creditAllowed ? ` — credit allowed up to ₦${defaultLimit.toLocaleString('en-NG')} on ${terms}-day terms` : ' — cash only'}.` }, 201);
  });

  /** Write off a bad debt. Irreversible in effect, so it needs owner authority and a reason. */
  app.post(`${base}/customers/:id/write-off`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) {
      throw new HttpError('Only an owner can write off a debt. It removes an asset from the balance sheet and reduces profit, so it should not be one person\'s decision on a shop floor.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const id = String(ctx.req.param('id'));
    const body = await ctx.req.json();
    const customer = await db.first('SELECT * FROM customers WHERE id = ? AND is_deleted = 0', [id]);
    if (!customer) throw new HttpError('That customer does not exist.', { status: 404, code: 'CUSTOMER_NOT_FOUND' });
    const balance = round2(Number(customer.credit_balance) || 0);
    if (balance <= 0) throw new HttpError(`${customer.name} does not owe anything, so there is nothing to write off.`, { status: 409, code: 'NO_BALANCE' });

    const amount = numField(body.amount ?? balance, { field: 'Amount', min: 0.01 });
    if (amount > balance) throw new HttpError(`You cannot write off ₦${amount.toLocaleString('en-NG')} against a balance of ₦${balance.toLocaleString('en-NG')}.`, { status: 400, code: 'EXCEEDS_BALANCE' });
    const reason = strField(requireVal(body, 'reason'), { field: 'Reason', maxLength: 500, required: true });
    if (reason.length < 10) {
      throw new HttpError('Give a real reason — at least a sentence. A write-off is the one entry an auditor always asks about, and "bad debt" answers nothing.', { status: 400, code: 'REASON_REQUIRED' });
    }

    const business = await resolveBusiness(db, ctx, customer.branch_id ? await db.first('SELECT * FROM branches WHERE id = ?', [customer.branch_id]) : null);
    const accountIds = await glService.loadAccountCodes(db, business.id);
    const balanceAfter = round2(balance - amount);
    const ledgerId = newId();

    await db.transaction(async (tx) => {
      tx.queue(`INSERT INTO debtor_ledger (
          id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?, 'WRITE_OFF', NULL, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
        ledgerId, customer.branch_id, String(business.id), id,
        -amount, balanceAfter, `Written off by ${user.full_name || user.username}: ${reason}`, String(user.id),
      ]);
      tx.queue("UPDATE customers SET credit_balance = ?, updated_at = datetime('now') WHERE id = ?", [balanceAfter, id]);
      // The invoices are ANNOTATED, not restatus'd: `sales.status` allows only
      // COMPLETED, VOIDED, PARTIALLY_REFUNDED, REFUNDED and PENDING_DELIVERY, and
      // none of those means "we gave up collecting". The sale really did happen
      // and the goods really did leave, so its status stays true and the write-off
      // lives where it belongs — in the debtor ledger and the general ledger.
      tx.queue(`UPDATE sales SET notes = COALESCE(notes,'') || ?, updated_at = datetime('now')
          WHERE customer_id = ? AND balance_due > 0 AND status NOT IN ('VOIDED') AND is_deleted = 0`, [
        `\n| Debt written off ${watNow()}: ${reason}`, id,
      ]);
      // A write-off is an expense, not a reduction of revenue: the sale happened,
      // the goods left, and the VAT was accounted for. Reversing revenue would
      // understate turnover and overstate the margin on everything else.
      // Built through glService.buildEntry with sourceType MANUAL, the one
      // allowed type for a judgement entry. A hand-rolled INSERT here would also
      // have used 'DEBT_WRITE_OFF', which the schema's CHECK does not permit.
      for (const st of glService.buildEntry({
        businessId: String(business.id), branchId: customer.branch_id ? String(customer.branch_id) : null,
        sourceType: 'MANUAL', sourceId: ledgerId,
        description: `Bad debt written off: ${customer.name}`, postedBy: String(user.id), accountIds,
        lines: [
          // An expense, NOT a reduction of revenue: the sale happened, the goods
          // left and the VAT was accounted for. Reversing revenue would understate
          // turnover and overstate the margin on everything else.
          { accountCode: '5120', debit: amount, description: 'Bad debt written off' },
          { accountCode: '1200', credit: amount, description: 'Receivable removed' },
        ],
      })) tx.queue(st.sql, st.params);
    });

    await recordFromCtx(ctx, {
      action: 'DEBT_WRITTEN_OFF', entityType: 'CUSTOMER', entityId: id, branchId: customer.branch_id, businessId: business.id,
      before: { balance }, after: { amount, reason, balanceAfter },
    });
    ctx.json({
      ok: true, id: ledgerId,
      message: `₦${amount.toLocaleString('en-NG')} of ${customer.name}'s debt written off. They now owe ₦${balanceAfter.toLocaleString('en-NG')}.`,
      balanceBefore: balance, amount, balanceAfter,
    });
  });
}

function requireVal(body, field) {
  const v = body[field];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new HttpError(`${field.replace(/_/g, ' ')} is required.`, { status: 400, code: 'MISSING_FIELD', fields: { [field]: 'Required' } });
  }
  return v;
}

module.exports = { mount, CUSTOMER_TYPES, normalisePhone };
