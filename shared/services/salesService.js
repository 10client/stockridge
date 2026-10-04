// =====================================================================
// shared/services/salesService.js — THE POINT OF SALE
// =====================================================================
// One copy, used by both backends. This is where every decoupled domain module
// composes into a sale, and it is deliberately the most heavily-commented file
// in the project: a sale touches stock, pricing, tax, credit, serials, holds,
// instalments, delivery, the GL and a tamper-evident register, and a mistake
// here is money.
//
// ---------------------------------------------------------------------
// THE INVARIANTS A SALE MUST SATISFY
// ---------------------------------------------------------------------
// These are asserted, not assumed, and most are ALSO enforced by CHECK
// constraints in migration 0001 so that a bug in this file cannot persist a
// broken sale even if the assertion itself is wrong:
//
//   1. subtotal - discount = taxable + exempt      (the basket foots)
//   2. total = taxable + exempt                    (VAT is EXTRACTED, never
//                                                   added on top — enabling VAT
//                                                   must not raise a shelf price)
//   3. sum(line.vat) = sale.vat                    (allocated with largest
//                                                   remainder, NOT rounded per
//                                                   line — per-line rounding is
//                                                   the documented trap that
//                                                   makes the two differ by a
//                                                   kobo and the sale fail to
//                                                   post)
//   4. paid + change >= total                      (no money appears)
//   5. sum(payment.amount) = paid                  (tenders foot to the payment)
//   6. stock decremented from real batches, by a
//      policy, never below zero, never ignoring
//      reservations
//   7. one serial per serialised unit, no duplicates
//   8. a restriction is SATISFIED, not merely noted
//   9. the GL entry balances
//  10. the register chain extends correctly
//
// ---------------------------------------------------------------------
// WHY ONE TRANSACTION
// ---------------------------------------------------------------------
// A sale is stock + money + ledger + GL + register, written together. If any
// part can be written without the others, the books and the shelves disagree and
// nothing on any screen looks broken — the stock report is short by one TV, the
// till is right, and the discrepancy is only findable by a stocktake six weeks
// later. So every write below happens inside one db.transaction(), and a failure
// anywhere rolls back everything.
//
// The exception is deliberate and narrow: audit_log writes are best-effort
// (see coreService.audit). A bookkeeping feature must never be able to stop a
// shop selling something.

'use strict';

const { newId } = require('../lib/ids');
const M = require('../lib/money');
const V = require('../lib/validate');
const VERTICALS = require('../lib/verticals');
const RECEIVING = require('../lib/receiving');
const PRICING = require('../lib/pricing');
const VATLIB = require('../lib/vat');
const STOCK = require('../lib/stock');
const PAYMENTS = require('../lib/payments');
const WARRANTY = require('../lib/warranty');
const CREDIT = require('../lib/credit');
const LAYAWAY = require('../lib/layaway');
const INSTALMENTS = require('../lib/instalments');
const HASHCHAIN = require('../lib/hashchain');
const FX = require('../lib/fx');
const { todayWat, watTimestamp } = require('../lib/timegeo');
const core = require('./coreService');

// =====================================================================
// INPUT NORMALISATION AND VALIDATION
// =====================================================================
/**
 * Validate and normalise a sale request BEFORE any stock is touched.
 *
 * Split from the write path on purpose: everything here is pure and testable
 * without a database, and it means a rejected sale never acquires a partial
 * write that has to be rolled back.
 */
async function prepareSale(db, { scope, business, settings, request, branch, profile }) {
  const errors = [];
  const warnings = [];

  const vertical = profile.code;

  // ---- lines ---------------------------------------------------------
  const rawLines = Array.isArray(request.lines) ? request.lines : [];
  if (!rawLines.length) V.fail('Add at least one item to the sale.', 'NO_LINES', 'lines');
  if (rawLines.length > 500) V.fail('A single sale cannot have more than 500 lines. Split it into two sales.', 'TOO_MANY_LINES', 'lines');

  const preparedLines = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    const field = `lines[${i}]`;

    const product = await db.prepare(
      'SELECT * FROM products WHERE id = ? AND is_deleted = 0'
    ).bind(String(raw.product_id || '')).first();

    if (!product) {
      errors.push({ field: `${field}.product_id`, message: 'That product no longer exists. Remove the line or pick another.' });
      continue;
    }
    if (Number(product.is_active) !== 1) {
      errors.push({ field: `${field}.product_id`, message: `"${product.name}" is not active and cannot be sold.` });
      continue;
    }
    // A product belonging to another business must not be sellable here even if
    // the id somehow reached this branch. Cross-tenant sale is the same class of
    // leak as the reparenting bug in scope.js.
    if (String(product.business_id) !== String(business.id)) {
      errors.push({ field: `${field}.product_id`, message: 'That product belongs to another business.' });
      continue;
    }

    const category = await core.getCategory(db, product.category_id);

    // ---- unit and quantity ------------------------------------------
    // Fractional quantities are only legal where the product's unit dimension is
    // BULKY or WEIGHTED (tonnes, cubic metres). A 2.5-piece TV is a data error;
    // a 2.5-tonne load of granite is a normal Tuesday.
    const allowsFractional = VERTICALS.allowsFractionalQty(vertical, category ? category.code : null, product);
    const qty = allowsFractional
      ? Number(raw.quantity)
      : V.qty(raw.quantity, { field: `${field}.quantity` });
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push({ field: `${field}.quantity`, message: 'Quantity must be greater than zero.' });
      continue;
    }

    const unitType = String(raw.unit_type || 'BASE_UNIT').toUpperCase();
    const sellingRungs = RECEIVING.SELLING_UNITS;
    if (!sellingRungs.includes(unitType)) {
      errors.push({ field: `${field}.unit_type`, message: `Unit must be one of: ${sellingRungs.join(', ')}` });
      continue;
    }

    // Convert the rung the operator chose into base units, so stock is always
    // held, valued and decremented in ONE unit. This is the invariant the whole
    // stock system rests on.
    const perUnit = RECEIVING.piecesPerUnit(product, unitType);
    if (perUnit == null) {
      errors.push({
        field: `${field}.unit_type`,
        message: `"${product.name}" has no ${unitType.toLowerCase()} size configured. Sell in ${product.base_unit.toLowerCase()}s, or set the pack size on the product.`,
      });
      continue;
    }
    const baseQuantity = unitType === 'BASE_UNIT'
      ? (allowsFractional ? qty : Math.round(qty))
      : Math.round(qty * perUnit);
    if (!(baseQuantity > 0)) {
      errors.push({ field: `${field}.quantity`, message: 'That quantity rounds to zero base units.' });
      continue;
    }

    // ---- price -------------------------------------------------------
    // Resolve the five pricing layers as a PURE function (shared/lib/pricing.js)
    // so the precedence is identical on the POS screen, in a quote, and in a
    // re-print. Divergence between "what the screen showed" and "what was
    // stored" is a customer argument with no winner.
    const branchOverride = await db.prepare(
      'SELECT * FROM product_price_overrides WHERE branch_id = ? AND product_id = ? AND is_deleted = 0'
    ).bind(String(branch.id), String(product.id)).first();

    const customerClass = (request.customer_class
      || (request.customer && request.customer.customer_class)
      || 'RETAIL').toUpperCase();

    const tier = await resolveCustomerTier(db, business, customerClass, product.category_id, baseQuantity);
    const volumeBreak = await resolveVolumeBreak(db, product.id, unitType, Number(raw.quantity) || 0);
    const promotion = await resolvePromotion(db, business, branch, product, customerClass);

    const priced = PRICING.priceLine({
      baseQuantity,
      batchPricePerBaseUnit: raw.batch_price_per_unit != null ? raw.batch_price_per_unit : product.default_selling_price,
      unitCostPerBaseUnit: raw.unit_cost != null ? raw.unit_cost : null,
      branchPricePerBaseUnit: branchOverride ? branchOverride.default_selling_price : null,
      customer: { customer_class: customerClass },
      tier,
      volumeBreak,
      promotion,
      manualDiscount: raw.discount || null,
      policy: {
        floor_price_percent: Number(settings.price_floor_percent_of_cost) || 100,
        max_discount_percent: Number(settings.max_discount_percent) || 25,
      },
      rungUnit: unitType,
      rungQuantity: Number(raw.quantity) || 0,
      rungPriceOverride: raw.rung_price != null ? Number(raw.rung_price) : null,
      rungPieces: perUnit,
    });

    if (!priced.ok) {
      // A pricing BLOCK is a refusal, not a warning: below the price floor, or
      // past the discount limit, without a manager's approval.
      errors.push({ field: `${field}.price`, message: priced.error, code: priced.code, blocks: priced.blocks });
      continue;
    }
    for (const w of priced.warnings || []) warnings.push({ line: i, product: product.name, ...w });

    // ---- restriction -------------------------------------------------
    // A restriction is SATISFIED, not noted. A serialised product cannot leave
    // the shop without its serials; an age-restricted product cannot be sold
    // without an age confirmation. Making these warnings means they never happen
    // on a busy Saturday.
    const restriction = VERTICALS.effectiveRestriction(vertical, category ? category.code : null, product.restriction_reason);
    const registerRequired = VERTICALS.effectiveRegisterRequired(vertical, category ? category.code : null, product.register_required)
      || Number(product.register_required) === 1;

    preparedLines.push({
      index: i,
      product,
      category,
      unitType,
      rungQuantity: Number(raw.quantity) || 0,
      baseQuantity,
      perUnit,
      priced,
      restriction,
      registerRequired,
      serials: normaliseSerials(raw.serial_numbers || raw.serials || []),
      batchId: raw.stock_batch_id || null,
      notes: raw.notes ? String(raw.notes).slice(0, 500) : null,
      isFreeUnit: false,
      warnings: priced.warnings || [],
    });
  }

  if (errors.length) {
    const err = new Error(errors.map((e) => e.message).join(' '));
    err.status = 400; err.code = 'SALE_VALIDATION_FAILED'; err.details = errors; err.warnings = warnings;
    throw err;
  }

  return { lines: preparedLines, warnings, vertical };
}

function normaliseSerials(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((s) => WARRANTY.normaliseSerial(s)).filter(Boolean);
  return String(input).split(/[,\s;]+/).map((s) => WARRANTY.normaliseSerial(s)).filter(Boolean);
}

async function resolveCustomerTier(db, business, customerClass, categoryId, baseQuantity) {
  if (!customerClass || customerClass === 'RETAIL') return null;
  // A category-specific tier beats the catch-all for the same class.
  const rows = await db.prepare(`
    SELECT * FROM customer_price_tiers
     WHERE business_id = ? AND is_deleted = 0 AND is_active = 1
       AND customer_class = ?
       AND (category_id = ? OR category_id IS NULL)
       AND min_quantity <= ?
     ORDER BY (category_id IS NULL), min_quantity DESC
     LIMIT 1
  `).bind(String(business.id), String(customerClass), categoryId || '__none__', baseQuantity).all();
  if (!rows.length) return null;
  const r = rows[0];
  return { id: r.id, discount_percent: Number(r.discount_percent) || 0, min_quantity: Number(r.min_quantity) || 1, tier_name: r.tier_name };
}

async function resolveVolumeBreak(db, productId, unitType, rungQty) {
  const rows = await db.prepare(`
    SELECT * FROM volume_breaks
     WHERE product_id = ? AND is_deleted = 0 AND is_active = 1
       AND unit_type = ? AND min_qty <= ?
     ORDER BY min_qty DESC LIMIT 1
  `).bind(String(productId), String(unitType).toUpperCase(), Math.floor(rungQty)).all();
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id, min_qty: Number(r.min_qty),
    discount_percent: Number(r.discount_percent) || 0,
    fixed_price: r.fixed_price != null ? Number(r.fixed_price) : null,
  };
}

async function resolvePromotion(db, business, branch, product, customerClass) {
  const today = todayWat();
  const rows = await db.prepare(`
    SELECT * FROM promotions
     WHERE business_id = ? AND is_deleted = 0 AND status = 'ACTIVE'
       AND starts_on <= ? AND ends_on >= ?
       AND (product_id IS NULL OR product_id = ?)
       AND (category_id IS NULL OR category_id = ?)
       AND (branch_id IS NULL OR branch_id = ?)
       AND (customer_class IS NULL OR customer_class = ?)
       AND (max_redemptions IS NULL OR redemption_count < max_redemptions)
     ORDER BY (product_id IS NOT NULL) DESC, (category_id IS NOT NULL) DESC, created_at DESC
     LIMIT 1
  `).bind(String(business.id), today, today, String(product.id),
    String(product.category_id || '__none__'), String(branch.id), String(customerClass || 'RETAIL')).all();
  if (!rows.length) return null;
  const p = rows[0];
  return {
    id: p.id, name: p.name, type: p.type, value: p.value != null ? Number(p.value) : null,
    buy_n: p.buy_n != null ? Number(p.buy_n) : null, get_m: p.get_m != null ? Number(p.get_m) : null,
    status: p.status, starts_on: p.starts_on, ends_on: p.ends_on,
  };
}

// =====================================================================
// RESTRICTION SATISFACTION
// =====================================================================
/**
 * Enforce every restriction the basket carries.
 *
 * Returns the register entries that must be chained, because a restriction that
 * is satisfied but not RECORDED is worth nothing: the point of capturing a
 * buyer's ID for a laptop is to be able to answer "who bought this?" six months
 * later when it turns up in a police inquiry.
 */
async function enforceRestrictions(db, { scope, business, branch, settings, request, lines, customer }) {
  const registerEntries = [];

  for (const line of lines) {
    const { restriction, registerRequired, product, baseQuantity } = line;

    // ---- SERIAL CAPTURE ------------------------------------------------
    const needsSerials = restriction === 'SERIAL_CAPTURE'
      || Number(product.serial_tracking) === 1
      || (product.serial_tracking == null && Number(business.uses_serial_tracking) === 1 && Number(product.warranty_months) > 0);

    if (needsSerials) {
      // Which of the captured serials are UNAVAILABLE?
      //
      // Not "which exist". A serialised unit in stock has a serial_numbers row
      // precisely so it CAN be sold — treating the existence of that row as a
      // conflict makes every serialised sale fail, which is what an earlier
      // version of this code did. The conflict is a serial that has already
      // left, or that is committed elsewhere:
      //
      //   SOLD / RETURNED-but-resold / IN_REPAIR / WITH_MANUFACTURER /
      //   REPLACED / SCRAPPED / LOST / STOLEN  -> not available to sell
      //   RESERVED                              -> on a hold; not sellable until
      //                                            the hold converts or releases
      //   IN_STOCK / TRANSFERRED                -> available
      //
      // This is the double-sell guard, and it has to distinguish "we hold it"
      // from "somebody has it", or it prevents the legitimate case and allows
      // nothing.
      const UNAVAILABLE = "('SOLD','IN_REPAIR','WITH_MANUFACTURER','REPLACED','SCRAPPED','LOST','STOLEN','RESERVED')";
      const existing = line.serials.length
        ? await db.prepare(
          `SELECT serial_normalised, status, branch_id, sale_id
             FROM serial_numbers
            WHERE business_id = ? AND is_deleted = 0
              AND status IN ${UNAVAILABLE}
              AND serial_normalised IN (${line.serials.map(() => '?').join(',')})`
        ).bind(String(business.id), ...line.serials).all()
        : [];

      const capture = WARRANTY.validateCapture({
        serials: line.serials,
        requiredQty: baseQuantity,
        existingSerials: existing.map((e) => e.serial_normalised),
      });
      if (!capture.ok && existing.length) {
        // Name the actual conflict. "It cannot be sold twice" is not actionable;
        // "this one is already on invoice SR-IKJ-000123" is.
        capture.problems = capture.problems.map((pr) => {
          const row = existing.find((e) => e.serial_normalised === pr.serial);
          if (!row) return pr;
          return {
            ...pr,
            message: `"${pr.serial}" is ${String(row.status).replace(/_/g, ' ').toLowerCase()}`
              + (row.sale_id ? ' against another sale' : '')
              + (row.branch_id && row.branch_id !== branch.id ? ' at a different branch' : '')
              + ' — it cannot be sold on this sale.',
          };
        });
      }
      if (!capture.ok) {
        const msg = capture.message
          || (capture.problems && capture.problems.length ? capture.problems.map((p) => p.message).join(' ') : 'Serial capture incomplete');
        const err = new Error(`"${product.name}": ${msg}`);
        err.status = 400; err.code = 'SERIAL_CAPTURE_REQUIRED';
        err.details = { product: product.name, problems: capture.problems, short: capture.short, excess: capture.excess };
        throw err;
      }
      line.capturedSerials = capture.serials;
    }

    // ---- AGE VERIFICATION ----------------------------------------------
    if (restriction === 'AGE_VERIFICATION') {
      const confirmed = request.age_verification && request.age_verification[line.index];
      const age = confirmed ? Number(confirmed.age_stated) : 0;
      const minimum = 18;
      if (!confirmed || !confirmed.confirmed || !(age >= minimum)) {
        const err = new Error(
          `"${product.name}" is age-restricted. Confirm the buyer is 18 or over and record their stated age before completing the sale.`
        );
        err.status = 400; err.code = 'AGE_VERIFICATION_REQUIRED';
        throw err;
      }
      line.ageVerification = {
        age_stated: age,
        confirmed_by: scope.userId,
        id_checked: !!confirmed.id_checked,
        id_type: confirmed.id_type || null,
        id_number: confirmed.id_number || null,
      };
    }

    // ---- AUTHORITY DOCUMENT --------------------------------------------
    if (restriction === 'AUTHORITY_DOCUMENT') {
      const doc = request.authority_documents && request.authority_documents[line.index];
      if (!doc || !doc.document_reference || !doc.authorising_party) {
        const err = new Error(
          `"${product.name}" requires an authorising document (a purchase order, works instruction or approval letter). `
          + 'Record its reference and who authorised it before completing the sale.'
        );
        err.status = 400; err.code = 'AUTHORITY_DOCUMENT_REQUIRED';
        throw err;
      }
      line.authorityDocument = {
        document_type: doc.document_type || 'OTHER',
        document_reference: String(doc.document_reference).slice(0, 120),
        authorising_party: String(doc.authorising_party).slice(0, 200),
        authorising_person: doc.authorising_person ? String(doc.authorising_person).slice(0, 200) : null,
        issue_date: doc.issue_date || null,
      };
    }

    // ---- HIGH-VALUE REGISTER -------------------------------------------
    if (registerRequired) {
      const buyer = request.register_buyer || (customer && { name: customer.name, phone: customer.phone, address: customer.address });
      if (!buyer || !String(buyer.name || '').trim()) {
        const err = new Error(
          `"${product.name}" must be entered in the register: record the buyer's name (and ideally an ID) before completing the sale.`
        );
        err.status = 400; err.code = 'REGISTER_BUYER_REQUIRED';
        throw err;
      }
      registerEntries.push({
        line,
        entry: HASHCHAIN.highValueEntry({
          saleId: null,   // filled once the sale row exists
          saleNumber: null,
          branchId: branch.id,
          productId: product.id,
          productName: product.name,
          serials: line.capturedSerials || [],
          quantity: baseQuantity,
          unitPrice: line.pricing ? line.pricing.netPerUnit : null,
          totalAmount: line.pricing ? line.pricing.net : null,
          buyer,
          recordedBy: scope.userId,
          idType: (request.register_buyer || {}).id_type || null,
          idNumber: (request.register_buyer || {}).id_number || null,
          notes: line.notes,
        }),
      });
    }
  }

  return { registerEntries };
}

// =====================================================================
// STOCK PICKING AND DECREMENT
// =====================================================================
/**
 * Pick batches for every line, then decrement. Returns the per-line allocation
 * so COGS can be valued at the ACTUAL cost of the units that left, not at an
 * average that hides which batch was sold.
 */
async function allocateStock(db, { branch, lines, settings, request }) {
  const allocations = [];
  for (const line of lines) {
    const batches = await db.prepare(`
      SELECT id, batch_no, quantity_on_hand, quantity_reserved, cost_per_unit,
             selling_price_per_unit, best_before_date, received_at
        FROM stock_batches
       WHERE branch_id = ? AND product_id = ? AND is_deleted = 0
         AND status IN ('ACTIVE','QUARANTINED')
       ORDER BY best_before_date IS NULL, best_before_date, received_at
    `).bind(String(branch.id), String(line.product.id)).all();

    const pick = STOCK.pickBatches(batches, {
      policy: request.pick_policy || branch.stock_pick_policy || settings.default_pick_policy || 'FIFO',
      requiredQty: line.baseQuantity,
      specificBatchIds: line.batchId ? [line.batchId] : null,
    });

    if (!pick.ok) {
      const err = new Error(
        `"${line.product.name}": ${pick.error}`
        + (pick.available != null ? ` (${pick.available} sellable — ${pick.short} short.)` : '')
      );
      err.status = 409; err.code = pick.code || 'INSUFFICIENT_STOCK';
      err.details = { product: line.product.name, short: pick.short, available: pick.available, required: pick.required };
      throw err;
    }
    line.allocation = pick.allocation;
    line.batchCost = STOCK.weightedCost(pick.allocation);
    allocations.push({ line, allocation: pick.allocation, cost: line.batchCost });
  }
  return allocations;
}

// =====================================================================
// CREATE THE SALE
// =====================================================================
/**
 * Create a sale. THE main entry point.
 *
 * @param {object} ctx  { db, scope, request, deviceId, ipAddress, userAgent }
 * @returns the persisted sale with items, payments and totals
 */
async function createSale(ctx) {
  const { db, scope, request, deviceId = null, ipAddress = null, userAgent = null } = ctx;

  const settings = await core.getSettings(db);

  // ---- resolve business + branch -------------------------------------
  const business = await core.getBusiness(db, request.business_id || scope.businessId || (scope.businessIds && scope.businessIds[0]));
  if (!business) V.fail('Choose which business this sale belongs to.', 'BUSINESS_REQUIRED', 'business_id');
  const profile = VERTICALS.getProfile(business.vertical_code) || VERTICALS.GENERAL_PROFILE;

  const branchId = scope.pinned ? scope.branchId : V.str(request.branch_id, { field: 'branch_id' });
  const branch = await db.prepare('SELECT * FROM branches WHERE id = ? AND is_deleted = 0').bind(String(branchId)).first();
  if (!branch) V.fail('That branch does not exist.', 'BRANCH_NOT_FOUND', 'branch_id');
  if (String(branch.business_id) !== String(business.id)) {
    V.fail('That branch belongs to a different business.', 'BRANCH_BUSINESS_MISMATCH', 'branch_id');
  }
  if (Number(branch.is_active) !== 1) V.fail('That branch is not active.', 'BRANCH_INACTIVE', 'branch_id');

  // ---- resolve customer ----------------------------------------------
  let customer = null;
  if (request.customer_id) {
    customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(String(request.customer_id)).first();
    if (!customer) V.fail('That customer no longer exists.', 'CUSTOMER_NOT_FOUND', 'customer_id');
    if (String(customer.business_id) !== String(business.id)) V.fail('That customer belongs to another business.', 'CUSTOMER_NOT_FOUND', 'customer_id');
  }
  const customerClass = (customer ? customer.customer_class : (request.customer_class || 'RETAIL')).toUpperCase();

  // ---- validate and price the basket ---------------------------------
  const { lines, warnings } = await prepareSale(db, { scope, business, settings, request, branch, profile });

  // ---- enforce restrictions ------------------------------------------
  const { registerEntries } = await enforceRestrictions(db, {
    scope, business, branch, settings, request, lines, customer,
  });

  // ---- till session ---------------------------------------------------
  const tillSession = await resolveTillSession(db, { branch, scope, request, settings });

  // ---- money: subtotal, discount, VAT ---------------------------------
  let subtotalKobo = 0;
  let discountKobo = 0;
  let costKobo = 0;
  for (const line of lines) {
    const p = line.priced;
    subtotalKobo += p.grossKobo;
    discountKobo += p.discountKobo;
  }

  // Sale-level discount, allocated across lines by net value with largest
  // remainder so the lines still foot after the split.
  const saleDiscountPercent = V.optionalNum(request.discount_percent, { field: 'discount_percent', min: 0, max: 100 }) || 0;
  let saleDiscountKobo = 0;
  if (saleDiscountPercent > 0) {
    const netSoFar = subtotalKobo - discountKobo;
    saleDiscountKobo = Math.round((netSoFar * saleDiscountPercent) / 100);
    const authority = await requireDiscountAuthority(db, scope, settings, saleDiscountPercent);
    if (!authority.allowed) {
      const err = new Error(authority.message);
      err.status = 403; err.code = authority.code;
      throw err;
    }
  }

  // ---- stock allocation (may fail: do it BEFORE any money is written) ---
  await allocateStock(db, { branch, lines, settings, request });
  for (const line of lines) costKobo += line.batchCost.costKobo;

  // ---- VAT ------------------------------------------------------------
  // VAT-INCLUSIVE EXTRACTION. The customer pays the shelf price either way;
  // enabling VAT does not raise it. This is not a stylistic choice — it is how
  // Nigerian retail works, and adding VAT on top would silently reprice every
  // product in the shop the moment the client registered.
  const vatEnabled = business.vat_enabled == null ? Number(settings.default_vat_enabled) : Number(business.vat_enabled);
  const vatRate = Number(business.vat_rate_percent != null ? business.vat_rate_percent : settings.default_vat_rate_percent) || 0;

  const vatLines = lines.map((l) => {
    const grossForLine = l.priced.grossKobo - l.priced.discountKobo;
    // A line's share of the sale-level discount, so VAT is computed on what the
    // customer actually pays for that line.
    const share = subtotalKobo - discountKobo > 0
      ? Math.round((saleDiscountKobo * grossForLine) / (subtotalKobo - discountKobo))
      : 0;
    const category = l.category || {};
    return {
      id: l.index,
      netKobo: Math.max(0, grossForLine - share),
      category: category.code || null,
      vatExemptOverride: l.product.vat_exempt != null ? Number(l.product.vat_exempt) === 1 : null,
    };
  });

  const vatResult = VATLIB.computeSaleVat({
    lines: vatLines,
    vatEnabled: !!vatEnabled,
    vatRatePercent: vatRate,
    exemptCategoryCodes: profile.exemptCategoryCodes,
  });

  // THE FOOTING INVARIANT: the sum of the per-line VAT must equal the sale VAT
  // exactly. computeSaleVat allocates with largest remainder precisely so this
  // holds; asserting it here is what stops a future edit from silently breaking
  // it and producing a sale that will not post against the CHECK constraint.
  const lineVatSum = vatResult.lines.reduce((a, l) => a + l.vatKobo, 0);
  if (lineVatSum !== vatResult.vatKobo) {
    throw new Error(
      `Internal error: per-line VAT (${lineVatSum} kobo) does not equal the sale VAT (${vatResult.vatKobo} kobo). `
      + 'The sale was not created. This is a bug in the VAT allocation and must be fixed, not worked around.'
    );
  }

  const taxableKobo = vatResult.chargeableKobo;
  const exemptKobo = vatResult.exemptKobo;
  const totalKobo = vatResult.totalKobo;
  const netOfVatKobo = totalKobo - vatResult.vatKobo;

  // ---- payments --------------------------------------------------------
  const tenderResult = await resolveTenders(db, {
    scope, business, branch, settings, request, customer, totalKobo, lines,
  });

  const paidKobo = tenderResult.settledNowKobo;
  const changeKobo = tenderResult.changeKobo;
  const balanceKobo = Math.max(0, totalKobo - paidKobo);

  // ---- credit assessment (only if credit is actually being used) --------
  if (tenderResult.tenders.some((t) => t.method === 'CREDIT') || balanceKobo > 0) {
    await assertCreditAllowed(db, { business, settings, customer, customerClass, balanceKobo, totalKobo });
  }

  // ---- FX --------------------------------------------------------------
  let fxRecord = null;
  if (request.currency && String(request.currency).toUpperCase() !== 'NGN') {
    const cur = String(request.currency).toUpperCase();
    if (!FX.isCurrency(cur)) V.fail(`Unknown currency "${request.currency}"`, 'UNKNOWN_CURRENCY', 'currency');
    const band = await core.fxRateBands(settings);
    const rate = request.fx_rate != null
      ? FX.validateRate({ currency: cur, rate: request.fx_rate, band })
      : (await core.lookupFxRate(db, { currency: cur, businessId: business.id }))?.rate;
    if (!rate) {
      const err = new Error(`No ${cur}/NGN rate is recorded and none was supplied. Enter the rate you agreed with the customer.`);
      err.status = 400; err.code = 'MISSING_FX_RATE';
      throw err;
    }
    fxRecord = FX.conversionRecord({
      amount: request.total_in_currency != null ? Number(request.total_in_currency) : M.fromBase(M.fromKobo(totalKobo), cur, rate),
      currency: cur, rate,
      source: request.fx_source || 'AGREED',
      rateDate: todayWat(),
    });
  }

  const saleDate = request.sale_date || request.date || todayWat();
  const marginKobo = netOfVatKobo - costKobo;

  // =====================================================================
  // THE WRITE — one transaction, all of it
  // =====================================================================
  const result = await db.transaction(async (tx) => {
    const doc = await core.nextDocNumber(tx, { businessId: business.id, branchId: branch.id, docType: 'SALE' });
    const saleId = newId();
    const saleNumber = doc.number;

    // ---- sale row ------------------------------------------------------
    await tx.prepare(`
      INSERT INTO sales (
        id, business_id, branch_id, till_session_id, sale_number, receipt_number,
        sale_type, status, customer_id, customer_class, customer_name, customer_phone,
        subtotal_kobo, discount_kobo, taxable_kobo, exempt_kobo, vat_kobo, total_kobo,
        paid_kobo, balance_kobo, change_kobo, cost_kobo, margin_kobo,
        subtotal, discount_total, vat_amount, total, paid, balance_due, change_given,
        cost_total, margin_total,
        vat_enabled, vat_rate_percent, currency, fx_rate, fx_source, fx_rate_date, total_in_currency,
        requires_delivery, credit_terms_code, due_date,
        sold_by, device_id, client_sale_id, sale_date, sale_time, created_at, updated_at
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,
        ?,?,?,
        ?,?,?,?,?, datetime('now'), datetime('now')
      )
    `).bind(
      saleId, String(business.id), String(branch.id), tillSession ? tillSession.id : null,
      saleNumber, saleNumber,
      String(request.sale_type || (customerClass === 'RETAIL' ? 'RETAIL' : 'WHOLESALE')).toUpperCase(),
      balanceKobo > 0 ? 'PART_PAID' : 'COMPLETED',
      customer ? String(customer.id) : null, customerClass,
      customer ? customer.name : (request.customer_name ? String(request.customer_name).slice(0, 200) : null),
      customer ? customer.phone : (request.customer_phone ? String(request.customer_phone).slice(0, 30) : null),
      subtotalKobo, discountKobo + saleDiscountKobo, taxableKobo, exemptKobo, vatResult.vatKobo, totalKobo,
      paidKobo, balanceKobo, changeKobo, costKobo, marginKobo,
      M.fromKobo(subtotalKobo), M.fromKobo(discountKobo + saleDiscountKobo), M.fromKobo(vatResult.vatKobo),
      M.fromKobo(totalKobo), M.fromKobo(paidKobo), M.fromKobo(balanceKobo), M.fromKobo(changeKobo),
      M.fromKobo(costKobo), M.fromKobo(marginKobo),
      vatEnabled ? 1 : 0, vatEnabled ? vatRate : 0,
      fxRecord ? fxRecord.currency : 'NGN', fxRecord ? fxRecord.fx_rate : 1,
      fxRecord ? fxRecord.fx_source : null, fxRecord ? fxRecord.fx_rate_date : null,
      fxRecord ? fxRecord.amount : null,
      request.requires_delivery ? 1 : 0,
      balanceKobo > 0 ? (request.credit_terms_code || (customer ? customer.terms_code : 'CASH')) : 'CASH',
      balanceKobo > 0 ? CREDIT.dueDate(saleDate, request.credit_terms_code || (customer ? customer.terms_code : 'NET_30')) : null,
      String(scope.userId), deviceId, request.client_sale_id || null, saleDate, watTimestamp().slice(11)
    ).run();

    // ---- sale items + stock movements -----------------------------------
    for (const line of lines) {
      const p = line.priced;
      const v = vatResult.lines.find((x) => x.id === line.index) || { vatKobo: 0, netKobo: p.netKobo };
      const lineNetKobo = v.netKobo;
      const lineVatKobo = v.vatKobo;
      const lineCostKobo = line.batchCost.costKobo;
      const itemId = newId();

      await tx.prepare(`
        INSERT INTO sale_items (
          id, sale_id, product_id, stock_batch_id, product_name, sku, category_id, category_code, brand_name,
          restriction_reason, register_required,
          unit_type, quantity, base_quantity, base_unit, base_units_per_rung,
          unit_price_kobo, rung_price_kobo, discount_kobo, line_gross_kobo, line_net_kobo, line_vat_kobo,
          line_cost_kobo, line_margin_kobo,
          unit_price, rung_price, discount_total, line_gross, line_total, line_vat, unit_cost, line_cost, line_margin,
          vat_exempt, pricing_trail_json, discount_reason, discount_approved_by, promotion_id, tier_id, volume_break_id,
          serial_numbers, age_confirmed, age_confirmed_by, authority_document_id,
          notes, created_at, updated_at
        ) VALUES (
          ?,?,?,?,?,?,?,?,?,?,?,
          ?,?,?,?,?,
          ?,?,?,?,?,?,?,?,
          ?,?,?,?,?,?,?,?,?,
          ?,?,?,?,?,?,?,
          ?,?,?,?,?, datetime('now'), datetime('now')
        )
      `).bind(
        itemId, saleId, String(line.product.id), line.allocation.length === 1 ? line.allocation[0].stock_batch_id : null,
        line.product.name, line.product.sku, line.product.category_id,
        line.category ? line.category.code : null,
        line.product.brand_name_snapshot || null,
        line.restriction, line.registerRequired ? 1 : 0,
        line.unitType, line.rungQuantity, line.baseQuantity, line.product.base_unit, line.perUnit,
        p.unitPriceKobo != null ? p.unitPriceKobo : Math.round(p.netKobo / line.baseQuantity),
        p.grossKobo, p.discountKobo, p.grossKobo, lineNetKobo, lineVatKobo,
        lineCostKobo, lineNetKobo - lineVatKobo - lineCostKobo,
        M.fromKobo(p.unitPriceKobo != null ? p.unitPriceKobo : Math.round(p.netKobo / line.baseQuantity)),
        M.fromKobo(p.grossKobo), M.fromKobo(p.discountKobo), M.fromKobo(p.grossKobo),
        M.fromKobo(lineNetKobo), M.fromKobo(lineVatKobo),
        line.batchCost.costPerUnit, M.fromKobo(lineCostKobo), M.fromKobo(lineNetKobo - lineVatKobo - lineCostKobo),
        v.chargeable === false ? 1 : 0,
        JSON.stringify(p.pricingTrail || []),
        (line.priced.manualDiscount && line.priced.manualDiscount.reason) || null,
        (line.priced.manualDiscount && line.priced.manualDiscount.approved_by_manager) ? scope.userId : null,
        line.priced.promotionId || null, line.priced.tierId || null, line.priced.volumeBreakId || null,
        (line.capturedSerials || []).join(','),
        line.ageVerification ? 1 : 0, line.ageVerification ? line.ageVerification.confirmed_by : null,
        line.authorityDocumentId || null,
        line.notes
      ).run();

      // ---- decrement each picked batch ---------------------------------
      for (const alloc of line.allocation) {
        const upd = await tx.prepare(`
          UPDATE stock_batches
             SET quantity_on_hand = quantity_on_hand - ?,
                 updated_at = datetime('now')
           WHERE id = ? AND quantity_on_hand >= ? AND is_deleted = 0
        `).bind(alloc.quantity, alloc.stock_batch_id, alloc.quantity).run();

        // The guard is in the WHERE clause, so a concurrent till cannot drive a
        // batch negative between the pick and the decrement. If nothing changed,
        // somebody else took the stock first and the whole sale must roll back.
        if (!upd.meta || upd.meta.changes === 0) {
          const err = new Error(
            `"${line.product.name}" was just taken by another till. Remove it from this sale or reduce the quantity.`
          );
          err.status = 409; err.code = 'STOCK_TAKEN_CONCURRENTLY';
          throw err;
        }

        await tx.prepare(`
          INSERT INTO stock_movements
            (id, business_id, branch_id, product_id, stock_batch_id, movement_type, direction, quantity,
             value_kobo, unit_cost, source_type, source_id, serial_number, reference, moved_by, moved_at, notes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'),?)
        `).bind(
          newId(), String(business.id), String(branch.id), String(line.product.id), alloc.stock_batch_id,
          'SALE', -1, alloc.quantity,
          alloc.costKobo, alloc.cost_per_unit,
          'SALE', saleId, alloc.serial_number || null, saleNumber, String(scope.userId), line.notes || null
        ).run();
      }

      // ---- serials: mark SOLD, start the warranty clock ------------------
      for (const serial of line.capturedSerials || []) {
        const warrantyMonths = Number(line.product.warranty_months) || 0;
        const basis = line.product.warranty_basis || settings.warranty_basis_default || 'SALE';
        const expires = warrantyMonths > 0
          ? WARRANTY.warrantyExpiry({ months: warrantyMonths, basis, saleDate })
          : null;
        await tx.prepare(`
          UPDATE serial_numbers
             SET status = 'SOLD', sale_id = ?, customer_id = ?, sold_at = datetime('now'),
                 branch_id = ?, warranty_started_on = ?, warranty_expires_on = ?,
                 warranty_status = ?, updated_at = datetime('now')
           WHERE business_id = ? AND serial_normalised = ? AND is_deleted = 0
        `).bind(
          saleId, customer ? String(customer.id) : null, String(branch.id),
          saleDate, expires,
          expires ? 'IN_WARRANTY' : (warrantyMonths > 0 ? 'IN_WARRANTY' : 'OUT_OF_WARRANTY'),
          String(business.id), serial
        ).run();
        await tx.prepare(`
          INSERT INTO serial_history (id, serial_id, event_type, from_branch_id, to_status, source_type, source_id, performed_by, occurred_at)
          SELECT ?, id, 'SOLD', ?, 'SOLD', 'SALE', ?, ?, datetime('now')
            FROM serial_numbers WHERE business_id = ? AND serial_normalised = ? AND is_deleted = 0
        `).bind(newId(), String(branch.id), saleId, String(scope.userId), String(business.id), serial).run();
      }

      // ---- authority documents ------------------------------------------
      if (line.authorityDocument) {
        const docId = newId();
        line.authorityDocumentId = docId;
        await tx.prepare(`
          INSERT INTO sale_authority_documents
            (id, sale_id, sale_item_id, business_id, branch_id, document_type, document_reference,
             authorising_party, authorising_person, issue_date, captured_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))
        `).bind(
          docId, saleId, itemId, String(business.id), String(branch.id),
          line.authorityDocument.document_type, line.authorityDocument.document_reference,
          line.authorityDocument.authorising_party, line.authorityDocument.authorising_person,
          line.authorityDocument.issue_date, String(scope.userId)
        ).run();
      }
    }

    // ---- payments --------------------------------------------------------
    for (const t of tenderResult.tenders) {
      await tx.prepare(`
        INSERT INTO sale_payments
          (id, sale_id, branch_id, till_session_id, method, amount_kobo, amount, reference, wallet,
           fee_kobo, fee, expected_settlement_date, foreign_amount, foreign_currency, fx_rate,
           cash_tendered, change_given_kobo, change_given, received_by, device_id, received_at, notes,
           created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'),?, datetime('now'), datetime('now'))
      `).bind(
        newId(), saleId, String(branch.id), tillSession ? tillSession.id : null,
        t.method, t.amount_kobo, t.amount, t.reference, t.wallet,
        t.fee_kobo || 0, t.fee || 0, t.expected_settlement_date || null,
        t.foreign_amount || null, t.foreign_currency || null, t.fx_rate || null,
        t.cash_tendered || null,
        t.method === 'CASH' ? changeKobo : 0, t.method === 'CASH' ? M.fromKobo(changeKobo) : 0,
        String(scope.userId), deviceId, t.notes || null
      ).run();
    }

    // ---- change owed -----------------------------------------------------
    if (changeKobo > 0 && tenderResult.changeRoute === 'CHANGE_OWED') {
      const code = core.newClaimCode();
      await tx.prepare(`
        INSERT INTO change_owed
          (id, claim_code, business_id, branch_id, sale_id, till_session_id, customer_id, customer_name,
           customer_phone, amount_kobo, amount, reason, status, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'OUTSTANDING', ?, datetime('now'), datetime('now'))
      `).bind(
        newId(), code, String(business.id), String(branch.id), saleId,
        tillSession ? tillSession.id : null,
        customer ? String(customer.id) : null,
        customer ? customer.name : (request.customer_name || null),
        customer ? customer.phone : (request.customer_phone || null),
        changeKobo, M.fromKobo(changeKobo), 'NO_CHANGE_IN_DRAWER', String(scope.userId)
      ).run();
      tenderResult.changeOwedCode = code;
    }

    // ---- debtor ledger entry, if anything is outstanding ------------------
    if (balanceKobo > 0 && customer) {
      await tx.prepare(`
        INSERT INTO debtor_ledger
          (id, business_id, branch_id, customer_id, entry_type, direction, amount_kobo, amount,
           entry_date, terms_code, due_date, source_type, source_id, reference, created_by, notes,
           created_at, updated_at)
        VALUES (?,?,?,?, 'SALE','DEBIT',?,?,?,?,?, 'SALE',?,?,?,?, datetime('now'), datetime('now'))
      `).bind(
        newId(), String(business.id), String(branch.id), String(customer.id),
        balanceKobo, M.fromKobo(balanceKobo), saleDate,
        request.credit_terms_code || customer.terms_code || 'NET_30',
        CREDIT.dueDate(saleDate, request.credit_terms_code || customer.terms_code || 'NET_30'),
        saleId, saleNumber, String(scope.userId),
        `Sale ${saleNumber}`
      ).run();
    }

    // ---- release any layaway hold this sale settles ------------------------
    if (request.layaway_hold_id) {
      const hold = await tx.prepare('SELECT * FROM layaway_holds WHERE id = ? AND is_deleted = 0').bind(String(request.layaway_hold_id)).first();
      if (!hold) V.fail('That hold no longer exists.', 'HOLD_NOT_FOUND', 'layaway_hold_id');
      if (String(hold.branch_id) !== String(branch.id)) V.fail('That hold belongs to another branch.', 'HOLD_OUT_OF_SCOPE');
      if (hold.status !== 'ACTIVE') V.fail(`That hold is already ${hold.status.toLowerCase()}.`, 'HOLD_NOT_ACTIVE');
      await tx.prepare(`UPDATE layaway_holds SET status='CONVERTED', converted_sale_id=?, released_at=datetime('now'),
                  released_by=?, release_reason='Converted to sale', updated_at=datetime('now') WHERE id=?`)
        .bind(saleId, String(scope.userId), String(hold.id)).run();
      // The reserved quantity becomes a real decrement, so release the
      // reservation on the batches it was holding.
      const holdItems = await tx.prepare('SELECT * FROM layaway_hold_items WHERE hold_id = ? AND is_deleted = 0 AND reserved = 1').bind(String(hold.id)).all();
      for (const hi of holdItems) {
        await tx.prepare(`UPDATE stock_batches SET quantity_reserved = MAX(0, quantity_reserved - ?), updated_at = datetime('now') WHERE id = ?`)
          .bind(Number(hi.quantity), String(hi.stock_batch_id)).run();
        await tx.prepare(`UPDATE layaway_hold_items SET reserved = 0, released_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .bind(String(hi.id)).run();
      }
    }

    // ---- hash-chained register entries -------------------------------------
    for (const re of registerEntries) {
      re.entry.sale_id = saleId;
      re.entry.sale_number = saleNumber;
      const head = await tx.prepare('SELECT last_row_hash, row_count FROM hash_chain_heads WHERE chain_key = ?')
        .bind(HASHCHAIN.chainKey({ register: 'HIGH_VALUE_REGISTER', branchId: branch.id, dayIso: saleDate })).first();
      const row = HASHCHAIN.appendRow({
        register: 'HIGH_VALUE_REGISTER',
        branchId: branch.id,
        dayIso: saleDate,
        fields: re.entry,
        prevHash: head ? head.last_row_hash : HASHCHAIN.GENESIS_HASH,
      });
      const rowId = newId();
      const seq = head ? Number(head.row_count) + 1 : 1;
      await tx.prepare(`
        INSERT INTO hash_chained_registers
          (id, register_type, business_id, branch_id, chain_key, chain_day, prev_hash, row_hash, version, seq,
           payload_json, sale_id, sale_number, product_id, product_name, serial_numbers, quantity,
           unit_price_kobo, total_amount_kobo, buyer_name, buyer_phone, buyer_address, id_type, id_number,
           recorded_by, device_id, recorded_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))
      `).bind(
        rowId, 'HIGH_VALUE_REGISTER', String(business.id), String(branch.id), row.chain_key, row.chain_day,
        row.prev_hash, row.row_hash, row.version, seq, row.payload_json,
        saleId, saleNumber, String(re.entry.product_id || ''), re.entry.product_name, re.entry.serial_numbers,
        re.entry.quantity, re.entry.unit_price_kobo, re.entry.total_amount_kobo,
        re.entry.buyer_name, re.entry.buyer_phone, re.entry.buyer_address, re.entry.id_type, re.entry.id_number,
        String(scope.userId), deviceId
      ).run();
      await tx.prepare(`
        INSERT INTO hash_chain_heads (chain_key, register_type, business_id, branch_id, chain_day, last_row_id, last_row_hash, row_count, updated_at)
        VALUES (?,?,?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(chain_key) DO UPDATE SET
          last_row_id = excluded.last_row_id, last_row_hash = excluded.last_row_hash,
          row_count = excluded.row_count, updated_at = datetime('now')
      `).bind(row.chain_key, 'HIGH_VALUE_REGISTER', String(business.id), String(branch.id), row.chain_day, rowId, row.row_hash, seq).run();
    }

    // ---- age verification log (also chained) --------------------------------
    for (const line of lines) {
      if (!line.ageVerification) continue;
      await appendRegisterEntry(tx, {
        register: 'AGE_VERIFICATION_LOG', businessId: business.id, branchId: branch.id, dayIso: saleDate,
        userId: scope.userId, deviceId,
        fields: {
          sale_id: saleId, sale_number: saleNumber, product_id: String(line.product.id),
          product_name: line.product.name, quantity: line.baseQuantity,
          buyer_age_stated: line.ageVerification.age_stated,
          id_checked: line.ageVerification.id_checked ? 1 : 0,
          id_type: line.ageVerification.id_type,
          id_number: line.ageVerification.id_number,
          buyer_name: customer ? customer.name : null,
          buyer_phone: customer ? customer.phone : null,
          recorded_by: scope.userId,
        },
      });
    }

    // ---- till session counters ----------------------------------------------
    if (tillSession) {
      await tx.prepare(`UPDATE till_sessions SET sales_count = sales_count + 1, updated_at = datetime('now') WHERE id = ?`)
        .bind(tillSession.id).run();
    }

    // ---- customer denormalised totals ---------------------------------------
    if (customer) {
      await tx.prepare(`UPDATE customers SET total_purchases = total_purchases + ?, last_purchase_at = datetime('now'),
                  updated_at = datetime('now') WHERE id = ?`)
        .bind(M.fromKobo(totalKobo), String(customer.id)).run();
    }

    // ---- promotion redemption counters ---------------------------------------
    const promoIds = [...new Set(lines.map((l) => l.priced.promotionId).filter(Boolean))];
    for (const pid of promoIds) {
      await tx.prepare(`UPDATE promotions SET redemption_count = redemption_count + 1, updated_at = datetime('now') WHERE id = ?`)
        .bind(String(pid)).run();
    }

    // ---- general ledger --------------------------------------------------------
    const gl = require('./glService');
    await gl.postSaleJournal(tx, {
      business, branch, saleId, saleNumber, saleDate, scope,
      totals: {
        subtotalKobo, discountKobo: discountKobo + saleDiscountKobo, taxableKobo, exemptKobo,
        vatKobo: vatResult.vatKobo, totalKobo, netOfVatKobo, costKobo, marginKobo, paidKobo, balanceKobo,
      },
      tenders: tenderResult.tenders,
      customer,
      lines,
    });

    return { saleId, saleNumber, tillSessionId: tillSession ? tillSession.id : null };
  });

  // ---- post-commit: audit (best effort) --------------------------------------
  await core.audit(db, {
    businessId: business.id, branchId: branch.id, userId: scope.userId, userRole: scope.role,
    action: 'SALE_CREATE', entityType: 'sale', entityId: result.saleId,
    after: { sale_number: result.saleNumber, total: M.fromKobo(totalKobo), lines: lines.length },
    ipAddress, userAgent, deviceId, severity: 'INFO',
  });

  return {
    ...result,
    totals: {
      subtotal: M.fromKobo(subtotalKobo),
      discount: M.fromKobo(discountKobo + saleDiscountKobo),
      taxable: M.fromKobo(taxableKobo),
      exempt: M.fromKobo(exemptKobo),
      vat: M.fromKobo(vatResult.vatKobo),
      total: M.fromKobo(totalKobo),
      paid: M.fromKobo(paidKobo),
      balance_due: M.fromKobo(balanceKobo),
      change: M.fromKobo(changeKobo),
      cost: M.fromKobo(costKobo),
      margin: M.fromKobo(marginKobo),
      margin_percent: totalKobo > 0 ? M.round2((marginKobo / netOfVatKobo) * 100) : 0,
    },
    vat: vatResult,
    tenders: tenderResult.tenders,
    changeRoute: tenderResult.changeRoute,
    changeOwedCode: tenderResult.changeOwedCode || null,
    fx: fxRecord,
    warnings,
    lines: lines.map((l) => ({
      product_id: l.product.id, product_name: l.product.name,
      quantity: l.rungQuantity, unit_type: l.unitType, base_quantity: l.baseQuantity,
      gross: l.priced.gross, discount: l.priced.discount, net: l.priced.net,
      serials: l.capturedSerials || [], pricing_trail: l.priced.pricingTrail,
    })),
  };
}

/** Append to a hash-chained register inside an open transaction. */
async function appendRegisterEntry(tx, { register, businessId, branchId, dayIso, userId, deviceId, fields }) {
  const key = HASHCHAIN.chainKey({ register, branchId, dayIso });
  const head = await tx.prepare('SELECT last_row_hash, row_count FROM hash_chain_heads WHERE chain_key = ?').bind(key).first();
  const row = HASHCHAIN.appendRow({
    register, branchId, dayIso, fields,
    prevHash: head ? head.last_row_hash : HASHCHAIN.GENESIS_HASH,
  });
  const rowId = newId();
  const seq = head ? Number(head.row_count) + 1 : 1;
  await tx.prepare(`
    INSERT INTO hash_chained_registers
      (id, register_type, business_id, branch_id, chain_key, chain_day, prev_hash, row_hash, version, seq,
       payload_json, sale_id, sale_number, product_id, product_name, quantity, total_amount_kobo,
       buyer_name, buyer_phone, buyer_age_stated, id_checked, id_type, id_number,
       recorded_by, device_id, recorded_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))
  `).bind(
    rowId, register, String(businessId), String(branchId), row.chain_key, row.chain_day,
    row.prev_hash, row.row_hash, row.version, seq, row.payload_json,
    fields.sale_id || null, fields.sale_number || null, fields.product_id || null, fields.product_name || null,
    fields.quantity != null ? Number(fields.quantity) : null,
    fields.total_amount_kobo != null ? Number(fields.total_amount_kobo) : null,
    fields.buyer_name || null, fields.buyer_phone || null,
    fields.buyer_age_stated != null ? Number(fields.buyer_age_stated) : null,
    fields.id_checked ? 1 : 0, fields.id_type || null, fields.id_number || null,
    String(userId), deviceId || null
  ).run();
  await tx.prepare(`
    INSERT INTO hash_chain_heads (chain_key, register_type, business_id, branch_id, chain_day, last_row_id, last_row_hash, row_count, updated_at)
    VALUES (?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(chain_key) DO UPDATE SET
      last_row_id = excluded.last_row_id, last_row_hash = excluded.last_row_hash,
      row_count = excluded.row_count, updated_at = datetime('now')
  `).bind(key, register, String(businessId), String(branchId), dayIso, rowId, row.row_hash, seq).run();
  return row;
}

// =====================================================================
// TENDERS
// =====================================================================
async function resolveTenders(db, { scope, business, branch, settings, request, customer, totalKobo, lines }) {
  const rawTenders = Array.isArray(request.tenders) && request.tenders.length
    ? request.tenders.map((t) => {
        if (request.tenders.length === 1 && (t.amount == null || t.amount === '')) {
          return { ...t, amount: M.fromKobo(totalKobo) };
        }
        return t;
      })
    : (request.payment ? [{ method: request.payment.method || 'CASH', amount: request.payment.amount != null ? request.payment.amount : M.fromKobo(totalKobo), reference: request.payment.reference }] : [{ method: 'CASH', amount: M.fromKobo(totalKobo) }]);

  // Credit limit headroom, if the customer has one.
  let creditLimitKobo = null;
  if (customer && customer.credit_limit != null) {
    const bal = await db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount_kobo ELSE -amount_kobo END),0) AS bal
        FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0
    `).bind(String(customer.id)).first();
    creditLimitKobo = Math.max(0, M.toKobo(customer.credit_limit) - Math.max(0, Number(bal ? bal.bal : 0)));
  }

  // Attach POS fees and settlement dates, because a tender recorded without
  // them is a tender that will not reconcile against the bank.
  const holidays = await core.holidayDates(db, { stateCode: branch.state_code });
  const enriched = [];
  for (const t of rawTenders) {
    const method = String(t.method || '').toUpperCase();
    const info = PAYMENTS.tenderInfo(method);
    const out = { ...t, method };
    if (info && info.feeBearing && (t.fee == null)) {
      const fee = PAYMENTS.posFee({
        amount: Number(t.amount) || 0,
        percent: Number(settings.pos_fee_percent) || 0,
        cap: settings.pos_fee_cap != null ? Number(settings.pos_fee_cap) : null,
        configured: Number(settings.pos_fee_configured) === 1,
      });
      out.fee = fee.fee;
      if (!fee.configured) out.fee_warning = fee.note;
    }
    if (info && !info.settlesImmediately && !out.expected_settlement_date) {
      out.expected_settlement_date = PAYMENTS.expectedSettlement(todayWat(), {
        businessDays: Number(settings.pos_settlement_business_days) || 1, holidays,
      });
    }
    enriched.push(out);
  }

  return PAYMENTS.validateTenders({
    tenders: enriched,
    amountDue: M.fromKobo(totalKobo),
    allowShort: !!request.allow_credit || !!request.create_instalment_plan,
    customerId: customer ? customer.id : null,
    creditLimitKobo,
  });
}

async function assertCreditAllowed(db, { business, settings, customer, customerClass, balanceKobo, totalKobo }) {
  if (Number(settings.credit_enabled) !== 1) {
    const err = new Error('Credit sales are disabled. Take payment now, or ask the owner to enable credit.');
    err.status = 409; err.code = 'CREDIT_DISABLED';
    throw err;
  }
  const classInfo = VERTICALS.customerClassInfo(customerClass);
  if (classInfo && !classInfo.creditAllowed) {
    const err = new Error(
      `${classInfo.label} customers do not buy on account. Convert this to a cash, card or instalment sale, `
      + 'or register the buyer as a trade customer first.'
    );
    err.status = 409; err.code = 'CREDIT_CLASS_NOT_ALLOWED';
    throw err;
  }
  if (!customer) {
    const err = new Error('A credit sale must be against a named customer. Add them first — an anonymous debt cannot be chased.');
    err.status = 400; err.code = 'CREDIT_NEEDS_CUSTOMER';
    throw err;
  }

  const bal = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount_kobo ELSE -amount_kobo END),0) AS bal
      FROM debtor_ledger WHERE customer_id = ? AND is_deleted = 0
  `).bind(String(customer.id)).first();
  const overdue = await db.prepare(`
    SELECT COALESCE(SUM(amount_kobo),0) AS k, MAX(CAST(julianday(date('now','+1 hours')) - julianday(due_date) AS INTEGER)) AS d
      FROM debtor_ledger
     WHERE customer_id = ? AND is_deleted = 0 AND due_date IS NOT NULL AND due_date < date('now','+1 hours')
       AND entry_type IN ('SALE','DEBIT_NOTE','INSTALLMENT_DUE','OPENING_BALANCE')
  `).bind(String(customer.id)).first();

  const book = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount_kobo ELSE -amount_kobo END),0) AS k
      FROM debtor_ledger WHERE business_id = ? AND is_deleted = 0
  `).bind(String(business.id)).first();

  const assessment = CREDIT.assessCreditRequest({
    customer: {
      balance: M.fromKobo(Number(bal ? bal.bal : 0)),
      credit_limit: customer.credit_limit,
      overdue_balance: M.fromKobo(Number(overdue ? overdue.k : 0)),
      max_days_overdue: Number(overdue ? overdue.d : 0) || 0,
      account_status: customer.account_status,
      customer_class: customerClass,
      class_allows_credit: classInfo ? classInfo.creditAllowed : true,
    },
    requestedKobo: balanceKobo,
    policy: {
      max_overdue_days: Number(settings.credit_max_overdue_days) || 30,
      total_debtors: M.fromKobo(Number(book ? book.k : 0)),
      max_concentration_percent: Number(settings.credit_max_concentration_pct) || 25,
    },
  });

  if (!assessment.allowed) {
    const err = new Error(assessment.blocks.map((b) => b.message).join(' '));
    err.status = 409; err.code = assessment.blocks[0].code;
    err.details = { assessment };
    throw err;
  }
  return assessment;
}

async function requireDiscountAuthority(db, scope, settings, discountPercent) {
  const { assertDiscountAuthority } = require('../../server/lib/scope');
  return assertDiscountAuthority(db, scope, discountPercent, settings);
}

// =====================================================================
// TILL SESSION
// =====================================================================
async function resolveTillSession(db, { branch, scope, request, settings }) {
  const tillNo = String(request.till_no || '1');
  const open = await db.prepare(`
    SELECT * FROM till_sessions
     WHERE branch_id = ? AND till_no = ? AND status = 'OPEN' AND is_deleted = 0
  `).bind(String(branch.id), tillNo).first();
  if (open) return open;
  if (request.require_open_till !== false) {
    // A sale with no open till cannot be reconciled at close: its cash is in the
    // drawer but there is no session to attribute it to. Refuse rather than
    // silently create one, because an auto-opened till has no counted float and
    // therefore no meaningful opening balance.
    const err = new Error(`No till is open for till ${tillNo} at ${branch.name}. Open the till and count the float first.`);
    err.status = 409; err.code = 'NO_OPEN_TILL';
    throw err;
  }
  return null;
}

// =====================================================================
// READ
// =====================================================================
async function getSale(db, scope, saleId) {
  const sale = await db.prepare('SELECT * FROM sales WHERE id = ? AND is_deleted = 0').bind(String(saleId)).first();
  if (!sale) { const e = new Error('Sale not found'); e.status = 404; e.code = 'SALE_NOT_FOUND'; throw e; }
  const { canAccessBranch } = require('../../server/lib/scope');
  if (!canAccessBranch(scope, sale.branch_id)) {
    const e = new Error('Sale not found'); e.status = 404; e.code = 'SALE_NOT_FOUND'; throw e;
  }
  const [items, payments, customer, branch, returns, registerRows] = await Promise.all([
    db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND is_deleted = 0 ORDER BY created_at').bind(saleId).all(),
    db.prepare('SELECT * FROM sale_payments WHERE sale_id = ? AND is_deleted = 0 ORDER BY created_at').bind(saleId).all(),
    sale.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').bind(sale.customer_id).first() : null,
    db.prepare('SELECT * FROM branches WHERE id = ?').bind(sale.branch_id).first(),
    db.prepare('SELECT * FROM sales_returns WHERE sale_id = ? AND is_deleted = 0').bind(saleId).all(),
    db.prepare('SELECT * FROM hash_chained_registers WHERE sale_id = ? ORDER BY seq').bind(saleId).all(),
  ]);
  return {
    ...sale,
    items: items.map((i) => ({ ...i, pricing_trail: core.parseJsonColumn(i.pricing_trail_json, []) })),
    payments, customer, branch, returns, register_entries: registerRows,
    business: await core.getBusiness(db, sale.business_id),
  };
}

/**
 * The receipt block: everything a printed or on-screen receipt needs, including
 * the VAT wording (which must be correct whether or not the business is VAT
 * registered) and the pricing trail if the client wants to show it.
 */
async function buildReceipt(db, scope, saleId) {
  const sale = await getSale(db, scope, saleId);
  const settings = await core.getSettings(db);
  const business = sale.business;
  return {
    business: {
      name: business.trading_name || business.name,
      legal_name: business.legal_name,
      address: business.address, state: business.state_code, phone: business.phone,
      cac: business.cac_number, tin: business.tin, vat_reg: business.vat_registration_no,
      logo: business.logo_data_url || settings.logo_data_url,
    },
    branch: { name: sale.branch ? sale.branch.name : null, address: sale.branch ? sale.branch.address : null, phone: sale.branch ? sale.branch.phone : null },
    sale: {
      number: sale.sale_number, receipt_number: sale.receipt_number,
      date: sale.sale_date, time: sale.sale_time, type: sale.sale_type, status: sale.status,
      served_by: sale.sold_by_name || null,
    },
    customer: sale.customer ? { name: sale.customer.name, phone: sale.customer.phone, class: sale.customer.customer_class } : (sale.customer_name ? { name: sale.customer_name, phone: sale.customer_phone } : null),
    lines: sale.items.map((i) => ({
      name: i.product_name, sku: i.sku,
      quantity: i.quantity, unit_type: i.unit_type, base_quantity: i.base_quantity, base_unit: i.base_unit,
      unit_price: i.unit_price, rung_price: i.rung_price,
      gross: i.line_gross, discount: i.discount_total, net: i.line_total, vat: i.line_vat,
      serials: i.serial_numbers ? String(i.serial_numbers).split(',').filter(Boolean) : [],
      pricing_trail: settings.receipt_show_pricing_trail ? i.pricing_trail : [],
      exempt: !!i.vat_exempt,
    })),
    totals: {
      subtotal: sale.subtotal, discount: sale.discount_total,
      taxable: M.fromKobo(sale.taxable_kobo), exempt: M.fromKobo(sale.exempt_kobo),
      vat: sale.vat_amount, total: sale.total,
      paid: sale.paid, balance_due: sale.balance_due, change: sale.change_given,
    },
    vat: VATLIB.receiptBlock({
      enabled: !!sale.vat_enabled,
      ratePercent: Number(sale.vat_rate_percent) || 0,
      registrationNumber: business.vat_registration_no,
      chargeable: M.fromKobo(sale.taxable_kobo),
      exempt: M.fromKobo(sale.exempt_kobo),
      vat: sale.vat_amount,
      total: sale.total,
      currency: 'NGN',
    }),
    payments: sale.payments.map((p) => ({
      method: p.method, label: (PAYMENTS.tenderInfo(p.method) || {}).label || p.method,
      amount: p.amount, reference: p.reference, fee: p.fee,
    })),
    register_entries: sale.register_entries.map((r) => ({
      product: r.product_name, serials: r.serial_numbers, buyer: r.buyer_name,
      id_type: r.id_type, id_number: r.id_number, quantity: r.quantity,
    })),
    returns: sale.returns.map((r) => ({ number: r.return_number, reason: r.reason, amount: r.refund_amount, at: r.returned_at })),
    footer: settings.receipt_footer_text
      || 'Thank you for your patronage. Goods sold are returnable only with this receipt and in saleable condition.',
    delivery_note: sale.requires_delivery ? 'A delivery note accompanies these goods. Sign it on receipt.' : null,
    generated_at: watTimestamp(),
  };
}

module.exports = {
  prepareSale, enforceRestrictions, allocateStock, createSale, getSale, buildReceipt,
  resolveTenders, assertCreditAllowed, resolveTillSession, appendRegisterEntry,
  resolveCustomerTier, resolveVolumeBreak, resolvePromotion, normaliseSerials,
};
'use strict';
