'use strict';
// =====================================================================
// server/services/salesService.js — THE SALE TRANSACTION
// =====================================================================
// This is the most consequential function in the application. It moves
// stock, records money, touches the customer ledger, writes the general
// ledger, captures serials and starts warranty clocks, and it does all of
// that at a counter with a queue behind it, on hardware that may lose power
// and a network that may drop mid-request.
//
// THE ORDER OF OPERATIONS IS NOT ARBITRARY.
//
//   1. RESOLVE  products, variants, batches, prices, units  (reads)
//   2. VALIDATE stock availability, authority, credit, plan limits (reads)
//   3. QUEUE    every write into the transaction collector
//   4. COMMIT   atomically
//
// Nothing is written until every read has succeeded, because a half-written
// sale is the worst possible state: stock gone with no record, or a record
// with no stock movement. The collector contract in server/lib/db.js exists
// precisely to make step 4 atomic on both backends.
//
// SPECIFIC INVARIANTS, each of which was a real bug somewhere:
//
//   STOCK DECREMENT IS IN BASE UNITS. A sale of 2 cartons of a 48-piece
//     carton decrements 96. If this is wrong, every valuation, reorder
//     alert and stocktake variance is wrong too, and the error compounds.
//
//   FIFO BATCH CONSUMPTION, expiry first. Two routes that each pick their
//     own batch can both believe they own the same one and oversell.
//     domain/uom.selectBatchesFifo is the only picker.
//
//   THE PRICE ACTUALLY CHARGED IS RECORDED WITH ITS SOURCE. A snapshot, not
//     a lookup: the batch price moves tomorrow, the sale must not.
//
//   COST IS SNAPSHOTTED PER LINE AT FULL PRECISION. Margin history that
//     drifts when a cheaper delivery arrives is not margin history.
//
//   VAT IS EXTRACTED, NEVER ADDED. See domain/nigerianTax.js.
//
//   A CREDIT SALE WRITES THE DEBTOR LEDGER IN THE SAME TRANSACTION. A sale
//     recorded without its ledger entry is a customer who owes money the
//     books do not know about — and the books are what the owner relies on
//     to refuse the NEXT sale.
//
//   SERIALS ARE MARKED SOLD AND WARRANTY CLOCKS STARTED IN THE SAME
//     TRANSACTION, and each gets a hash-chained event. A fridge sold without
//     its serial being marked is a warranty claim that cannot be verified
//     eight months later, which is a straight loss.
//
//   THE RECEIPT NUMBER IS ALLOCATED INSIDE THE TRANSACTION. Allocated
//     outside, two concurrent sales at one branch get the same number and
//     the UNIQUE index rejects the second — mid-queue.
// =====================================================================

const { newId, shortCode } = require('../../domain/crypto');
const { round2, roundTo } = require('../../domain/money');
const { toBaseUnits, selectBatchesFifo, buildLadder } = require('../../domain/uom');
const { computeSaleLine, computeSaleTotals, resolveUnitPrice, marginWarnings } = require('../../domain/pricing');
const { extractVatFromInclusive } = require('../../domain/nigerianTax');
const { creditDecision } = require('../../domain/credit');
const { canVoidSale, canDiscount, canSellOnCredit, canOverrideCreditLimit } = require('../../domain/planLimits');
const { minutesBetween, addMonths, watNow, utcToWat, watToUtc, parseTimestamp } = require('../../domain/time');
const { atLeast } = require('../../domain/roles');
const { computeRowHash } = require('../../domain/hashChain');
const { HttpError } = require('../lib/http');
const glService = require('./glService');

const SALE_TYPES = Object.freeze(['RETAIL', 'WHOLESALE', 'CREDIT', 'INSTALMENT', 'LAYAWAY', 'EXCHANGE', 'INTERNAL']);
const PAYMENT_METHODS = Object.freeze([
  'CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD', 'CHEQUE',
  'CREDIT', 'INSTALMENT', 'DEPOSIT', 'GIFT_CARD', 'VOUCHER', 'OTHER',
]);

function err(message, code = 'SALE_INVALID', status = 400) {
  return new HttpError(message, { status, code });
}

// ---------------------------------------------------------------------
// LOADERS — all reads happen here, before any write is queued
// ---------------------------------------------------------------------

async function loadCatalogue(db, ids) {
  if (!ids.length) return new Map();
  const rows = await db.all(
    `SELECT p.*, pc.code AS category_code, pc.name AS category_name
     FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id
     WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.is_deleted = 0`,
    ids,
  );
  return new Map(rows.map((r) => [String(r.id), r]));
}

async function loadVariants(db, ids) {
  if (!ids.length) return new Map();
  const rows = await db.all(
    `SELECT * FROM product_variants WHERE id IN (${ids.map(() => '?').join(',')}) AND is_deleted = 0`,
    ids,
  );
  return new Map(rows.map((r) => [String(r.id), r]));
}

async function loadLadders(db, productIds) {
  if (!productIds.length) return new Map();
  const rows = await db.all(
    `SELECT * FROM product_units WHERE product_id IN (${productIds.map(() => '?').join(',')}) AND is_deleted = 0 ORDER BY quantity_in_base ASC`,
    productIds,
  );
  const out = new Map();
  for (const r of rows) {
    const key = String(r.product_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}

async function loadMeasures(db, productIds) {
  if (!productIds.length) return new Map();
  const rows = await db.all(
    `SELECT * FROM product_measures WHERE product_id IN (${productIds.map(() => '?').join(',')}) AND is_deleted = 0`,
    productIds,
  );
  const out = new Map();
  for (const r of rows) {
    const key = String(r.product_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}

async function loadBatches(db, branchId, productIds, variantIds) {
  if (!productIds.length) return [];
  const params = [String(branchId)];
  let sql = `SELECT * FROM stock_batches
             WHERE branch_id = ? AND is_deleted = 0 AND status = 'ACTIVE'
               AND product_id IN (${productIds.map(() => '?').join(',')})`;
  params.push(...productIds.map(String));
  if (variantIds.length) {
    sql += ` AND (variant_id IS NULL OR variant_id IN (${variantIds.map(() => '?').join(',')}))`;
    params.push(...variantIds.map(String));
  }
  // Ordered to match selectBatchesFifo exactly, including the stable tiebreak.
  // Without batch_no here the SQL could return tied batches in index order —
  // which for random hex ids varies between runs — and the sort's stability
  // would then preserve that arbitrary order.
  sql += ' ORDER BY expiry_date IS NULL, expiry_date ASC, received_at ASC, created_at ASC, batch_no ASC, id ASC';
  return db.all(sql, params);
}

async function loadPriceOverrides(db, branchId, productIds, variantIds) {
  if (!productIds.length) return new Map();
  const params = [String(branchId), ...productIds.map(String)];
  let sql = `SELECT * FROM product_price_overrides
             WHERE branch_id = ? AND is_deleted = 0
               AND product_id IN (${productIds.map(() => '?').join(',')})`;
  if (variantIds.length) {
    sql += ` AND (variant_id IS NULL OR variant_id IN (${variantIds.map(() => '?').join(',')}))`;
    params.push(...variantIds.map(String));
  }
  const rows = await db.all(sql, params);
  const out = new Map();
  for (const r of rows) out.set(`${r.product_id}|${r.variant_id || ''}`, r);
  return out;
}

async function loadPriceListItems(db, priceListIds, productIds) {
  if (!priceListIds.length || !productIds.length) return [];
  return db.all(
    `SELECT * FROM price_list_items
     WHERE is_deleted = 0
       AND price_list_id IN (${priceListIds.map(() => '?').join(',')})
       AND product_id IN (${productIds.map(() => '?').join(',')})`,
    [...priceListIds.map(String), ...productIds.map(String)],
  );
}

async function loadSerials(db, serialNumbers) {
  const clean = (serialNumbers || []).filter(Boolean).map(String);
  if (!clean.length) return new Map();
  const rows = await db.all(
    `SELECT * FROM serial_numbers WHERE serial_no IN (${clean.map(() => '?').join(',')}) AND is_deleted = 0`,
    clean,
  );
  return new Map(rows.map((r) => [String(r.serial_no), r]));
}

async function nextReceiptNo(db, branchId) {
  // Allocated from the CURRENT MAXIMUM, not from a counter table. A counter
  // table is one more row to keep in step, and a gap in receipt numbers
  // invites the question "where did 4471 go?" that a shop cannot answer.
  // Contiguous numbering within a branch is what a Nigerian tax officer
  // expects to see on a receipt book.
  //
  // Called BEFORE the transaction opens. Two concurrent sales at one branch
  // can therefore compute the same number; the UNIQUE index on
  // (branch_id, receipt_no) makes one of them fail and retry rather than
  // allowing a duplicate, which is the correct outcome — a duplicated
  // receipt number is a far worse problem than one retried request.
  const row = await db.first(
    'SELECT receipt_no FROM sales WHERE branch_id = ? AND is_deleted = 0 ORDER BY CAST(receipt_no AS INTEGER) DESC LIMIT 1',
    [String(branchId)],
  );
  const last = row ? parseInt(row.receipt_no, 10) : 0;
  const next = (Number.isFinite(last) ? last : 0) + 1;
  return String(next).padStart(6, '0');
}

// ---------------------------------------------------------------------
// PREPARATION — pure computation over loaded data, no writes
// ---------------------------------------------------------------------

/**
 * Prepare a sale. Returns everything needed to write it, plus every warning
 * the counter should show, WITHOUT writing anything.
 *
 * Split from completeSale() deliberately: the POS calls prepare() on every
 * cart change to show live totals and warnings, and calls complete() once at
 * checkout. Two functions with different side-effect profiles is clearer
 * than one function with a `dryRun` flag that every caller must remember to
 * set correctly.
 */
async function prepare(db, {
  branch, business, customer = null, customerClass = null, priceLists = [],
  lines, user, settings, saleType = 'RETAIL', tillSessionId = null,
  discountAmount = 0, discountReason = null, deliveryFee = 0, deliveryRequired = false,
  deliveryAddress = null, notes = null, manualPriceOverrides = {},
}) {
  if (!branch) throw err('Choose which branch this sale belongs to.', 'BRANCH_REQUIRED');
  if (!Array.isArray(lines) || !lines.length) throw err('A sale needs at least one item.', 'EMPTY_SALE');
  if (lines.length > 500) throw err('A single sale cannot have more than 500 lines. Split it into two sales.', 'TOO_MANY_LINES');

  const productIds = [...new Set(lines.map((l) => String(l.productId)).filter((x) => x && x !== 'undefined'))];
  const variantIds = [...new Set(lines.map((l) => l.variantId).filter(Boolean).map(String))];

  const [products, variants, ladders, measures, batches, overrides, priceListItems, serials] = await Promise.all([
    loadCatalogue(db, productIds),
    loadVariants(db, variantIds),
    loadLadders(db, productIds),
    loadMeasures(db, productIds),
    loadBatches(db, branch.id, productIds, variantIds),
    loadPriceOverrides(db, branch.id, productIds, variantIds),
    loadPriceListItems(db, priceLists.map((p) => String(p.id)), productIds),
    loadSerials(db, lines.flatMap((l) => (Array.isArray(l.serialNumbers) ? l.serialNumbers : (l.serialNumber ? [l.serialNumber] : [])))),
  ]);

  const vatEnabled = Boolean(Number(settings.vat_enabled));
  const vatRatePercent = Number(settings.vat_rate_percent) || 0;

  // Group batches by product+variant so FIFO selection sees only the
  // relevant pool. Including another variant's batch would let a 2-seater
  // sofa sale consume 3-seater stock.
  const batchKey = (productId, variantId) => `${productId}|${variantId || ''}`;
  const batchesByKey = new Map();
  for (const b of batches) {
    const key = batchKey(b.product_id, b.variant_id);
    if (!batchesByKey.has(key)) batchesByKey.set(key, []);
    batchesByKey.get(key).push(b);
  }

  const resolvedLines = [];
  const problems = [];
  const warnings = [];
  const batchConsumption = new Map(); // batchId -> qty already promised to an earlier line

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const position = `Line ${i + 1}`;
    const product = products.get(String(line.productId));
    if (!product) {
      problems.push({ line: i, code: 'PRODUCT_NOT_FOUND', message: `${position}: that product does not exist or has been deleted. Remove it and search again.` });
      continue;
    }
    if (!Number(product.is_active)) {
      problems.push({ line: i, code: 'PRODUCT_INACTIVE', message: `${position}: "${product.name}" is not active and cannot be sold. Reactivate it under Products first.` });
      continue;
    }
    const variant = line.variantId ? variants.get(String(line.variantId)) : null;
    if (line.variantId && !variant) {
      problems.push({ line: i, code: 'VARIANT_NOT_FOUND', message: `${position}: that variant of "${product.name}" does not exist.` });
      continue;
    }
    if (Number(product.tracks_variants) && !variant) {
      problems.push({ line: i, code: 'VARIANT_REQUIRED', message: `${position}: "${product.name}" comes in variants — choose the specific one (colour, size or finish) the customer is buying.` });
      continue;
    }

    const ladderRows = ladders.get(String(product.id)) || [
      // A product with no configured ladder falls back to a single base unit
      // rather than refusing the sale: better to sell in pieces than to stop
      // the queue over a setup omission, and the fallback is recorded so the
      // omission is visible afterwards.
      { code: 'PIECE', name: product.base_unit_name || 'piece', level: 0, quantity_in_base: 1, is_sellable: 1, is_default_sell: 1 },
    ];
    if (!(ladders.get(String(product.id)) || []).length) {
      warnings.push({ line: i, code: 'NO_UNIT_LADDER', severity: 'INFO', message: `${position}: "${product.name}" has no unit ladder configured, so it is being sold in single ${product.base_unit_name || 'piece'}s. Set its units under Products.` });
    }
    const ladder = buildLadder(ladderRows);
    const measureRows = measures.get(String(product.id)) || [];
    const measure = measureRows[0] ? {
      axis: measureRows[0].axis,
      sellUnitCode: measureRows[0].sell_unit_code,
      sellUnitBaseFactor: measureRows[0].sell_unit_base_factor,
      sellUnitName: measureRows[0].sell_unit_code,
    } : null;

    const unitCode = String(line.unitCode || (ladder.ok ? ladder.defaultSell.code : 'PIECE')).toUpperCase();
    const conversion = toBaseUnits({ quantity: line.quantity, unitCode, ladder: ladder.ok ? ladder.ladder : ladderRows, measure });
    if (!conversion.ok) {
      problems.push({ line: i, code: conversion.code, message: `${position} ("${product.name}"): ${conversion.error}` });
      continue;
    }

    // ---- stock availability, FIFO across the batches for this product/variant
    const key = batchKey(product.id, variant ? variant.id : null);
    const pool = (batchesByKey.get(key) || []).map((b) => {
      const promised = batchConsumption.get(String(b.id)) || 0;
      return { ...b, quantity: roundTo(Number(b.quantity) - promised, 4) };
    });
    const selection = selectBatchesFifo(pool, conversion.baseQuantity);
    if (!selection.ok) {
      const available = pool.reduce((a, b) => a + Math.max(0, Number(b.quantity) - Number(b.quantity_reserved || 0)), 0);
      const name = variant ? `${product.name} (${variant.name})` : product.name;
      problems.push({
        line: i,
        code: 'INSUFFICIENT_STOCK',
        message: `${position}: only ${roundTo(available, 2).toLocaleString('en-NG')} ${product.base_unit_name || 'unit'}${available === 1 ? '' : 's'} of "${name}" is available at this branch, and this line needs ${roundTo(conversion.baseQuantity, 2).toLocaleString('en-NG')}. ${selection.shortfallBase > 0 ? `Short by ${roundTo(selection.shortfallBase, 2).toLocaleString('en-NG')}.` : ''} Transfer stock in, or sell what is on the shelf.`,
        available,
        required: conversion.baseQuantity,
        shortfall: selection.shortfallBase,
      });
      continue;
    }
    for (const pick of selection.picks) {
      batchConsumption.set(String(pick.batch.id), roundTo((batchConsumption.get(String(pick.batch.id)) || 0) + pick.quantityBase, 4));
    }

    // ---- price
    const override = overrides.get(`${product.id}|${variant ? variant.id : ''}`) || overrides.get(`${product.id}|`);
    const manual = manualPriceOverrides[i] != null ? manualPriceOverrides[i] : (line.manualPrice != null ? line.manualPrice : null);
    const pricing = resolveUnitPrice({
      product, variant,
      batch: selection.picks[0] ? selection.picks[0].batch : null,
      override,
      priceListItems,
      customer,
      unitCode,
      quantity: Number(line.quantity),
      manualPrice: manual,
      ladder: ladder.ok ? ladder.ladder : ladderRows,
    });

    // ---- authority to charge a manual price
    if (pricing.source === 'MANUAL') {
      const priceCheck = canDiscount(settings, user, { discountPct: 0 });
      if (!priceCheck.allowed && String(user.role).toUpperCase() !== 'MANAGER' && String(user.role).toUpperCase() !== 'OWNER') {
        problems.push({ line: i, code: 'MANUAL_PRICE_NOT_ALLOWED', message: `${position}: only a manager or the owner can type a price at the counter. ${priceCheck.reason || ''}` });
        continue;
      }
    }

    const computed = computeSaleLine({
      product, variant,
      batch: selection.picks[0] ? selection.picks[0].batch : null,
      ladder: ladder.ok ? ladder.ladder : ladderRows,
      measure,
      unitCode,
      quantity: Number(line.quantity),
      unitPrice: pricing.unitPrice,
      priceSource: pricing.source,
      priceListId: pricing.priceListId || null,
      discountAmount: line.discountAmount != null ? line.discountAmount : null,
      discountPct: line.discountPct != null ? line.discountPct : null,
      // Cost is the FIFO-weighted cost of the batches actually consumed, not
      // the product's last-known average: this sale is consuming THESE units.
      costPerBaseUnit: selection.picks.reduce((a, p) => a + p.quantityBase * p.costPerBaseUnit, 0) / selection.picks.reduce((a, p) => a + p.quantityBase, 0),
      vatEnabled, vatRatePercent,
    });
    if (!computed.ok) {
      problems.push({ line: i, code: computed.code, message: `${position}: ${computed.error}` });
      continue;
    }

    // ---- serials
    const requestedSerials = Array.isArray(line.serialNumbers) ? line.serialNumbers.filter(Boolean).map(String) : (line.serialNumber ? [String(line.serialNumber)] : []);
    const serialRows = [];
    if (Number(product.requires_serial)) {
      if (requestedSerials.length !== Math.ceil(conversion.baseQuantity)) {
        problems.push({
          line: i, code: 'SERIALS_REQUIRED',
          message: `${position}: "${product.name}" is serial-tracked, so each unit needs its own serial number. Expected ${Math.ceil(conversion.baseQuantity)}, got ${requestedSerials.length}. Scan or type the serial from the label on each item.`,
        });
        continue;
      }
      let serialProblem = null;
      for (const sn of requestedSerials) {
        const found = serials.get(sn);
        if (!found) {
          serialProblem = `Serial "${sn}" is not in this system. It must be captured at goods-received before it can be sold — otherwise its warranty cannot be verified later.`;
          break;
        }
        if (String(found.product_id) !== String(product.id)) {
          serialProblem = `Serial "${sn}" belongs to a different product (${found.product_id}), not "${product.name}".`;
          break;
        }
        if (found.status !== 'IN_STOCK' && found.status !== 'RESERVED') {
          serialProblem = `Serial "${sn}" is already ${String(found.status).replace(/_/g, ' ').toLowerCase()}, so it cannot be sold again. Check the label on the unit in front of you.`;
          break;
        }
        if (found.branch_id && String(found.branch_id) !== String(branch.id)) {
          serialProblem = `Serial "${sn}" is recorded at a different branch. Transfer it here first, or sell it from that branch.`;
          break;
        }
        serialRows.push(found);
      }
      if (serialProblem) { problems.push({ line: i, code: 'SERIAL_INVALID', message: `${position}: ${serialProblem}` }); continue; }
    } else if (requestedSerials.length) {
      warnings.push({ line: i, code: 'SERIALS_IGNORED', severity: 'INFO', message: `${position}: "${product.name}" is not serial-tracked, so the serial(s) entered were recorded as a note but not tracked individually.` });
    }

    // ---- margin guard rail (advisory)
    for (const w of marginWarnings({ line: computed, product, minMarginPct: product.min_margin_pct })) {
      warnings.push({ line: i, code: w.code, severity: w.severity, message: `${position} ("${product.name}"): ${w.message}` });
    }

    // ---- discount authority
    if (computed.discountAmount > 0) {
      const pct = computed.lineTotal + computed.discountAmount > 0
        ? (computed.discountAmount / (computed.lineTotal + computed.discountAmount)) * 100 : 0;
      const allowed = canDiscount(settings, user, { discountPct: pct });
      if (!allowed.allowed) {
        problems.push({ line: i, code: 'DISCOUNT_NOT_ALLOWED', message: `${position}: ${allowed.reason}` });
        continue;
      }
    }

    resolvedLines.push({
      ...computed,
      index: i,
      product, variant,
      picks: selection.picks.map((p) => ({ batchId: String(p.batch.id), quantityBase: p.quantityBase, costPerBaseUnit: p.costPerBaseUnit, expiry: p.batch.expiry_date || null })),
      serialRows,
      requestedSerials,
      measure,
      unitName: unitCode,
    });
  }

  if (problems.length) {
    const e = err(problems.map((p) => p.message).join(' '), 'SALE_PREPARATION_FAILED', 400);
    e.problems = problems;
    e.warnings = warnings;
    throw e;
  }

  const totals = computeSaleTotals({
    lines: resolvedLines, vatEnabled, vatRatePercent,
    orderDiscount: discountAmount, deliveryFee,
  });

  // ---- discount authority on the ORDER-level discount
  if (Number(discountAmount) > 0 && totals.subtotal > 0) {
    const pct = (Number(discountAmount) / totals.subtotal) * 100;
    const allowed = canDiscount(settings, user, { discountPct: pct });
    if (!allowed.allowed) throw err(allowed.reason, 'DISCOUNT_NOT_ALLOWED', 403);
  }

  // Payment validation happens in complete(), not here: prepare() is a pure
  // read used to render live totals and warnings as the cart changes, and
  // the payment legs do not exist yet at that point.
  const isCredit = ['CREDIT', 'INSTALMENT', 'LAYAWAY'].includes(String(saleType).toUpperCase());

  return {
    ok: true,
    branch, business,
    customer, customerClass,
    saleType: String(saleType).toUpperCase(),
    lines: resolvedLines,
    totals,
    warnings,
    vatEnabled, vatRatePercent,
    isCredit,
    discountAmount: round2(Number(discountAmount) || 0),
    discountReason,
    deliveryFee: round2(Number(deliveryFee) || 0),
    deliveryRequired: Boolean(deliveryRequired),
    deliveryAddress,
    notes,
    tillSessionId,
    batchConsumption,
  };
}

/**
 * Normalise and validate the payment legs.
 *
 * Kept as a separate function because the rules are fiddly and are needed in
 * three places (prepare, complete, and the offline-queue replay validation),
 * and three copies of fiddly rules is three chances to get one wrong.
 */
function validatePayments({ payments, totals, saleType, isCredit, settings, user, customer, creditInfo, changeOwed = 0 }) {
  const legs = Array.isArray(payments) ? payments.filter((p) => p && Number(p.amount) > 0) : [];
  const out = [];
  let sum = 0;

  for (const leg of legs) {
    const method = String(leg.method || '').toUpperCase();
    if (!PAYMENT_METHODS.includes(method)) {
      throw err(`"${leg.method}" is not a payment method this system records. Choose one of: ${PAYMENT_METHODS.join(', ')}.`, 'UNKNOWN_PAYMENT_METHOD');
    }
    const amount = round2(Number(leg.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw err('Each payment must be a positive amount.', 'INVALID_PAYMENT_AMOUNT');
    }
    if (method === 'CREDIT' && !isCredit) {
      throw err('A CREDIT payment leg means the customer is taking the goods now and paying later. Record the sale as a credit sale, or take a real payment.', 'CREDIT_ON_CASH_SALE');
    }
    if (['POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD', 'CHEQUE'].includes(method) && !leg.reference) {
      // Not a hard block on CASH, but every non-cash leg in Nigeria is
      // reconciled against a bank or terminal report by its reference. A leg
      // with no reference cannot be matched, so at close of day it becomes an
      // unexplained difference the owner has to investigate by hand.
      out.push({ ...leg, method, amount, warning: `No reference recorded for this ${method.replace(/_/g, ' ').toLowerCase()} payment. It will be hard to match against the bank or terminal report at reconciliation.` });
      sum = round2(sum + amount);
      continue;
    }
    out.push({
      method, amount,
      reference: leg.reference ? String(leg.reference).slice(0, 120) : null,
      bankName: leg.bank_name || leg.bankName || null,
      status: method === 'CHEQUE' ? 'PENDING' : (leg.status || 'CLEARED'),
      // EITHER SPELLING, AND THAT IS THE FIX.
      //
      // These two lines used to read `leg.cash_tendered` and `leg.change_given` — the raw
      // names a JSON body carries. But every caller of this function hands over
      // ALREADY-NORMALISED legs, and both of them use camelCase: the sales route maps
      // `cash_tendered` → `cashTendered` in `normalisePayments()`, and the after-sales
      // route builds `cashTendered` directly. So both reads were always undefined, and
      // the consequence was total rather than partial:
      //
      //   * `sale_payments.cash_tendered` was NULL on every sale ever recorded;
      //   * `sale_payments.change_given` was NULL on every sale ever recorded;
      //   * `sales.change_given` fell through to 0 — the figure the receipt, the till
      //     argument and any dispute about the counter would have to rest on;
      //   * `sales.cash_tendered` fell back to the cash APPLIED, which quietly turned
      //     "the customer handed over ₦35,500" into "the customer handed over ₦34,000".
      //
      // A key renamed between two layers, which no compiler sees and no unit test caught
      // because the unit tests call this function with the names it was reading. Found by
      // test/audit/audit.money.js, which rings a sale over HTTP and reads the tender back.
      //
      // Both spellings are accepted so a caller written either way works, and the snake
      // form stays first because that is what the function documented.
      cashTendered: (leg.cash_tendered ?? leg.cashTendered) != null ? round2(Number(leg.cash_tendered ?? leg.cashTendered)) : null,
      changeGiven: (leg.change_given ?? leg.changeGiven) != null ? round2(Number(leg.change_given ?? leg.changeGiven)) : null,
      notes: leg.notes || null,
    });
    sum = round2(sum + amount);
  }

  // ---- CHANGE OWED IS PART OF WHAT THE CUSTOMER HANDED OVER
  //
  // A till with no small notes owes the customer the difference: they pay
  // ₦3,000 for a ₦2,500 sale and collect ₦500 later on a claim code. The money
  // received is therefore the total PLUS change owed, and validating against the
  // total alone reports that as a ₦500 overpayment and refuses the sale — at the
  // counter, in front of the customer.
  //
  // `paid` stays capped at the sale total. The excess is not revenue and not a
  // part-payment; it is a liability the shop holds, recorded in change_owed with
  // its own claim code and expiry date.
  // ---- A CREDIT LEG IS A PROMISE, NOT MONEY
  //
  // Splitting the legs matters more than anything else in this function. A
  // CREDIT leg records "this much goes on the customer's account"; counting it
  // as money received made a fully-credit sale look fully PAID, so balanceDue
  // came out zero, the debtor ledger was never written, and the shop handed over
  // the goods having recognised revenue against money that does not exist. The
  // till also claimed cash it never held, so the day's count came out OVER by
  // exactly the credit sales — and a surplus variance is the one nobody
  // investigates.
  let cashSum = 0;
  let creditSum = 0;
  for (const leg of out) {
    if (leg.method === 'CREDIT') creditSum = round2(creditSum + leg.amount);
    else cashSum = round2(cashSum + leg.amount);
  }

  const owed = round2(Math.max(0, Number(changeOwed) || 0));
  const tolerance = 0.005;
  const advisories = [];

  if (isCredit) {
    // A credit sale is settled by some mixture of real money and account. The
    // two together must equal the total: less means the customer owes more than
    // anybody recorded, more means money arrived that belongs to no bill.
    const combined = round2(cashSum + creditSum);
    if (combined + tolerance < totals.total) {
      throw err(
        `This credit sale totals \u20a6${totals.total.toLocaleString('en-NG')} but only \u20a6${combined.toLocaleString('en-NG')} is accounted for (\u20a6${cashSum.toLocaleString('en-NG')} paid, \u20a6${creditSum.toLocaleString('en-NG')} on account) \u2014 \u20a6${round2(totals.total - combined).toLocaleString('en-NG')} short. Add the missing payment leg, or put the rest on account.`,
        'UNDERPAID',
      );
    }
    if (combined - tolerance > totals.total) {
      throw err(
        `This credit sale totals \u20a6${totals.total.toLocaleString('en-NG')} but \u20a6${combined.toLocaleString('en-NG')} is recorded across its payment legs \u2014 \u20a6${round2(combined - totals.total).toLocaleString('en-NG')} too much. A bill cannot be over-settled by mixing cash and credit.`,
        'OVERPAID',
      );
    }
    if (creditSum <= 0) {
      // Settled in full but recorded as a credit sale. Not an error — but the
      // sale type is now wrong and credit-sales reports would count it.
      advisories.push('This sale is marked as credit but is settled in full, so no debt is recorded. Consider recording it as a retail or wholesale sale instead.');
    }
  } else {
    // A non-credit sale may not carry a credit leg at all (enforced above), so
    // everything received is real money and must cover the total plus whatever
    // change the till owes back.
    const expected = round2(totals.total + owed);
    if (cashSum + tolerance < expected) {
      throw err(
        `This sale totals \u20a6${totals.total.toLocaleString('en-NG')}${owed > 0 ? ` plus \u20a6${owed.toLocaleString('en-NG')} change owed` : ''} but only \u20a6${cashSum.toLocaleString('en-NG')} of payment is recorded \u2014 \u20a6${round2(expected - cashSum).toLocaleString('en-NG')} short. Add the remaining payment, or record it as a credit sale if the customer is paying later.`,
        'UNDERPAID',
      );
    }
    if (cashSum - tolerance > expected) {
      throw err(
        `This sale totals \u20a6${totals.total.toLocaleString('en-NG')} but \u20a6${cashSum.toLocaleString('en-NG')} of payment is recorded \u2014 \u20a6${round2(cashSum - expected).toLocaleString('en-NG')} too much. Correct the amount, or record the difference as change owed to the customer.`,
        'OVERPAID',
      );
    }
  }

  // What actually went back over the counter — see deriveChangeGiven().
  deriveChangeGiven(out, changeOwed);

  return {
    legs: out,
    advisories,
    // Real money applied to the sale. Change owed sits above this and is a
    // liability the shop holds, not a payment.
    paid: round2(Math.min(cashSum, totals.total)),
    tendered: round2(cashSum),
    creditLeg: creditSum,
    changeOwed: round2(Math.max(0, cashSum - totals.total)),
    // What the customer still owes: for a credit sale, the total less the real
    // money taken. This is the figure the debtor ledger posts, so the two can
    // never disagree.
    balanceDue: isCredit ? round2(Math.max(0, totals.total - cashSum)) : 0,
  };
}

// ---------------------------------------------------------------------
// COMPLETE — the write path
// ---------------------------------------------------------------------

/**
 * Complete a sale atomically.
 *
 * Returns the sale row plus everything the receipt printer needs, so the
 * POS does not have to make a second round trip to render the receipt — on
 * a dropped connection that second request is the one that fails, and the
 * customer leaves without a receipt for a sale that did commit.
 */
// ---------------------------------------------------------------------
// SERIAL EVENT CHAIN — ONE FIELD SET FOR WRITING AND VERIFYING
// ---------------------------------------------------------------------
/**
 * The exact fields that go into a serial_events row hash.
 *
 * A hash chain is only evidence if a third party can RECOMPUTE it from the
 * stored row. That requires the writer and the verifier to agree on which
 * fields were hashed, in which shape. When they are written separately they
 * drift — the writer hashes a `note` the verifier does not know to include, or
 * one side stringifies a branch id and the other does not — and every chain
 * then fails verification, which is indistinguishable from the tampering the
 * chain exists to detect. A register that always reports "broken" is worse than
 * no register, because it trains everybody to ignore it.
 *
 * So there is one function, used by the writer here and by any verifier,
 * taking a stored row and returning the hashed shape.
 *
 * Deliberately excluded: ids that do not exist yet at write time (sale_id),
 * and timestamps, which SQLite fills in after the hash is computed.
 */
function serialEventFields(row) {
  return {
    serial_no: row.serial_no == null ? null : String(row.serial_no),
    event: row.event_type == null ? null : String(row.event_type),
    branchId: row.branch_id == null ? null : String(row.branch_id),
    note: row.notes == null ? null : String(row.notes),
  };
}

// ---------------------------------------------------------------------
// BACKDATED SALES — `sold_at` IS A CLAIM ABOUT WHEN TRADE HAPPENED
// ---------------------------------------------------------------------
// A sale is not always recorded at the moment it happens. Two ordinary
// situations break the assumption that `sold_at` means "now":
//
//   1. OFFLINE TILL. Power or network drops, the shop keeps trading, and the
//      device syncs hours or days later. Stamping those sales with the sync
//      time moves a whole day's takings onto the wrong day — and if that day's
//      till was already counted and closed, the books no longer agree with the
//      cash that was counted.
//   2. A LATE ENTERED SALE. A delivery note signed on site, rung up at the
//      branch the following morning.
//
// So `sold_at` is accepted from the caller. It is also GUARDED, because an
// unbounded backdate is a fraud vector: posting today's cash sale into last
// month's closed till is how takings disappear. The guard is a window rather
// than a ban, which is the same shape as every other control in this system.
const MAX_BACKDATE_DAYS = 90;
const FUTURE_SKEW_MINUTES = 10;

/**
 * Validate and normalise a caller-supplied `sold_at`.
 *
 * ZONE HANDLING. This column stores WEST AFRICA TIME. A client may send either
 * an instant (`2026-10-05T09:30:00.000Z`, or with an offset) or a bare
 * wall-clock string in the stored format. An ISO string carrying a zone marker
 * is an instant and is converted to WAT; a bare `YYYY-MM-DD HH:MM:SS` is taken
 * as already being WAT, because that is what an offline till records and what
 * the column holds. Guessing the other way would shift every synced sale by an
 * hour and split one trading day across two.
 *
 * Returns { sql, day, backdated, minutesBack, today }. Never writes.
 */
function resolveSoldAt(rawSoldAt, { user = null } = {}) {
  const now = new Date();
  const nowWatSql = watNow(now);
  const today = nowWatSql.slice(0, 10);

  if (rawSoldAt == null || String(rawSoldAt).trim() === '') {
    return { sql: nowWatSql, day: today, backdated: false, minutesBack: 0, today };
  }

  const raw = String(rawSoldAt).trim();
  const parsed = parseTimestamp(raw);
  if (!parsed) {
    throw err(`The sale time "${raw}" could not be read. Send it as "YYYY-MM-DD HH:MM:SS" (West Africa Time) or as an ISO-8601 timestamp.`, 'SOLD_AT_INVALID', 400);
  }

  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const sql = hasZone ? utcToWat(raw) : parsed.toISOString().slice(0, 19).replace('T', ' ');
  if (!sql) throw err(`The sale time "${raw}" could not be converted to West Africa Time.`, 'SOLD_AT_INVALID', 400);

  const day = sql.slice(0, 10);
  const minutesBack = minutesBetween(sql, nowWatSql) || 0;

  if (minutesBack < -FUTURE_SKEW_MINUTES) {
    // Device clocks in the field drift, and a till with a wrong clock should
    // not be unable to sell. A few minutes of forward skew is absorbed;
    // anything more is a mistake worth surfacing rather than storing.
    throw err(`That sale is stamped ${Math.abs(minutesBack)} minutes in the future, beyond the ${FUTURE_SKEW_MINUTES}-minute tolerance for device clock drift. Correct the device clock or the sale time.`, 'SOLD_AT_IN_FUTURE', 400);
  }

  const daysBack = Math.floor(Math.max(0, minutesBack) / 1440);
  if (daysBack > MAX_BACKDATE_DAYS && !(user && atLeast(user.role, 'MANAGER'))) {
    throw err(`That sale is ${daysBack} days old, beyond the ${MAX_BACKDATE_DAYS}-day backdating window for your role. Ask a manager to enter it, so the delay becomes somebody's recorded decision rather than a silent one.`, 'SOLD_AT_TOO_OLD', 400);
  }

  return { sql, day, backdated: day !== today, minutesBack: Math.max(0, minutesBack), today };
}

async function complete(db, params) {
  const {
    branch, business, user, settings, scope,
    customer = null, customerClass = null, priceLists = [],
    lines, saleType = 'RETAIL', payments = [],
    discountAmount = 0, discountReason = null,
    deliveryFee = 0, deliveryRequired = false, deliveryAddress = null,
    notes = null, tillSessionId = null, manualPriceOverrides = {},
    creditOverrideReason = null, changeOwedAmount = 0,
    deviceId = null, soldAt = null,
  } = params;

  // Resolved before anything else: which till this sale belongs to depends on
  // WHEN it happened, not on when it is being typed in.
  const sold = resolveSoldAt(soldAt, { user });

  const prepared = await prepare(db, {
    branch, business, customer, customerClass, priceLists, lines, user, settings,
    saleType, tillSessionId, discountAmount, discountReason, deliveryFee,
    deliveryRequired, deliveryAddress, notes, manualPriceOverrides,
  });

  const totals = prepared.totals;
  const isCredit = prepared.isCredit;

  // ---- credit authority, evaluated BEFORE any write
  let creditInfo = null;
  if (isCredit) {
    if (!customer) throw err('A credit sale needs a customer — the debt has to belong to somebody the system can find later.', 'CUSTOMER_REQUIRED_FOR_CREDIT');
    const currentBalance = Number(customer.credit_balance) || 0;
    const canOverride = canOverrideCreditLimit(settings, user).allowed;
    const staffCheck = canSellOnCredit(settings, user, { amount: totals.balanceDueAmount || totals.total, customerBalance: currentBalance, creditLimit: Number(customer.credit_limit) || 0 });
    if (!staffCheck.allowed) throw err(staffCheck.reason, 'CREDIT_NOT_ALLOWED', 403);

    creditInfo = creditDecision({
      customer, currentBalance, requestedAmount: totals.total,
      canOverride, overrideReason: creditOverrideReason, settings,
    });
    if (creditInfo.decision === 'REQUIRE_OVERRIDE') {
      throw err(creditInfo.message, 'CREDIT_LIMIT_EXCEEDED', 403);
    }
    if (creditInfo.decision === 'WARN' && !creditOverrideReason) {
      // The override is allowed but the REASON was not given. Recording an
      // over-limit sale without a reason is the difference between an
      // auditable judgement call and an unexplained hole — so the reason is
      // required, not optional.
      const e = err(`${creditInfo.message} Record why this was approved so the owner can review it.`, 'CREDIT_OVERRIDE_REASON_REQUIRED', 400);
      e.creditInfo = creditInfo;
      throw e;
    }
  }

  // ---- change owed, resolved BEFORE the payments are validated
  //
  // Order matters here. How much money the customer is expected to hand over
  // depends on how much of it the till is going to owe straight back, so
  // validating payments first reports a perfectly ordinary "paid ₦3,000 for a
  // ₦2,500 sale, ₦500 owed back" as a ₦500 overpayment.
  const changeOwed = round2(Math.max(0, Number(changeOwedAmount) || 0));
  if (changeOwed > 0 && !customer) {
    // THE MESSAGE USED TO PROMISE SOMETHING THE CODE REFUSED.
    //
    // It said "needs a customer name and phone", so a clerk would type a name and a phone
    // number into the sale — and be refused anyway, because the check below requires a
    // CUSTOMER RECORD, not two typed fields. A refusal that names a remedy the caller
    // cannot carry out is worse than a blunt one: it sends them round the loop twice and
    // teaches them the system is arbitrary.
    //
    // The rule itself is right and is not being changed. Change owed is the shop holding
    // somebody else's money, payable on a claim code, and it has to be attributable: a
    // name typed at the counter cannot be chased, cannot be found again, and cannot be
    // reconciled when the claim is redeemed. So the message now says what to do — put the
    // customer on the sale (their record, or the phone number they are already known by,
    // which `resolveCustomer` looks up).
    throw err('Change owed has to be attributable to a customer: the shop is holding their money until they come back for it. Put the customer on the sale — choose their record, or the phone number they are already known by — and the claim code will be redeemable.', 'CHANGE_OWED_NEEDS_CUSTOMER');
  }
  if (changeOwed > totals.total) throw err('Change owed cannot exceed the sale total.', 'CHANGE_OWED_EXCEEDS_TOTAL');


  const paymentResult = validatePayments({
    payments, totals, saleType: prepared.saleType, isCredit, settings, user, customer, creditInfo, changeOwed,
  });

  // ---- till check
  //
  // For a sale recorded NOW this is the branch's open till. For a BACKDATED
  // sale it is the till that was open THEN, found by time range — attaching
  // Tuesday's sale to Thursday's open till puts the money in the wrong drawer
  // and makes Thursday's count short by exactly that amount.
  //
  // A backdated sale whose till has since been CLOSED still references it (the
  // money WAS counted in that session) but must not alter its counters: a
  // counted, signed-off till is a historical record, and silently moving its
  // totals afterwards is how a reconciliation stops meaning anything. Such a
  // sale is flagged `latePosting` so the difference is visible rather than
  // absorbed, while the ledger still records the revenue where it belongs.
  let till = null;
  let latePosting = false;
  if (tillSessionId) {
    till = await db.first('SELECT * FROM till_sessions WHERE id = ? AND is_deleted = 0', [String(tillSessionId)]);
    if (!till) throw err('That till session does not exist.', 'TILL_NOT_FOUND', 404);
    if (String(till.branch_id) !== String(branch.id)) throw err('That till belongs to a different branch.', 'TILL_WRONG_BRANCH', 403);
    if (till.status !== 'OPEN') {
      if (!sold.backdated) throw err('That till session is not open. Open a till before selling, or choose the current one.', 'TILL_NOT_OPEN', 409);
      latePosting = true;
    }
  } else if (sold.backdated) {
    // sold.sql is WEST AFRICA TIME; opened_at and closed_at are UTC from
    // datetime('now'). Comparing them directly is out by an hour, which is
    // exactly enough to pick the wrong session for a sale near the till's open
    // or close boundary.
    const soldUtc = watToUtc(sold.sql);
    till = await db.first(`SELECT * FROM till_sessions
        WHERE branch_id = ? AND is_deleted = 0 AND opened_at <= ?
          AND (closed_at IS NULL OR closed_at >= ?)
        ORDER BY opened_at DESC LIMIT 1`,
    [String(branch.id), soldUtc, soldUtc]);
    if (!till || till.status !== 'OPEN') latePosting = true;
  } else {
    till = await db.first("SELECT * FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0", [String(branch.id)]);
    if (!till) latePosting = true;
  }

  // ---- PRE-COMPUTE everything that needs a read, BEFORE the transaction.
  //
  // The transaction collector contract (see server/lib/db.js) forbids
  // awaiting a database read inside the write phase, because better-sqlite3
  // cannot span a microtask and D1 has no interactive transaction at all.
  // The receipt number and every serial's hash-chain link are therefore
  // resolved here. This is safe under concurrency for the same reason the
  // stock decrement below is: the receipt UNIQUE index and the chain's
  // UNIQUE (serial_no, prev_hash) index both turn a lost race into a failed
  // commit rather than a duplicate.
  const receiptNo = await nextReceiptNo(db, branch.id);
  // The GL account id map is a read, so it happens here rather than inside
  // the transaction. Loading it once per sale (not per line) keeps the
  // overhead to one indexed query.
  const accountIds = await glService.loadAccountCodes(db, business.id);
  // Warranty runs from the day the goods were SOLD, which for a backdated
  // entry is not today. Starting the clock at entry time would silently
  // shorten a customer's cover by however long the sync took.
  const warrantyStart = sold.day;
  const serialChains = new Map();
  for (const line of prepared.lines) {
    for (const serialRow of line.serialRows) {
      const serialNo = String(serialRow.serial_no);
      if (serialChains.has(serialNo)) continue;
      const warrantyMonths = Number(line.product.warranty_months) || 0;
      const prevHash = await serialHeadHash(db, serialNo);
      const note = `Sold on receipt ${receiptNo}`;
      const rowHash = await computeRowHash(prevHash, {
        ...serialEventFields({ serial_no: serialNo, event_type: 'SOLD', branch_id: branch.id, notes: note }),
        // The sale id is not yet known (it is generated inside the
        // transaction), so it is NOT part of the hash. Hashing an id that
        // does not exist yet would make the chain unreproducible by a
        // verifier reading the stored row, which defeats the purpose.
      });
      serialChains.set(serialNo, {
        eventId: newId(),
        prevHash,
        rowHash,
        note,
        warrantyStart,
        warrantyEnd: warrantyMonths > 0 ? addMonths(warrantyStart, warrantyMonths) : null,
      });
    }
  }

  return db.transaction(async (tx) => {
    const saleId = tx.idFor('sale');
    const vat = vatEnabledTotals(totals, settings);

    // ---- sales header
    tx.queue(`INSERT INTO sales (
        id, business_id, branch_id, till_session_id, receipt_no, customer_id, customer_name, customer_phone,
        sale_type, salesperson_id, status, subtotal, discount_amount, order_discount_amount, discount_reason,
        vat_enabled, vat_rate_percent, vat_amount, total, amount_paid, balance_due,
        cash_tendered, change_given, payment_method, currency_code, due_date,
        delivery_required, delivery_address, delivery_fee, notes, sold_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
      saleId, String(business.id), String(branch.id), till ? String(till.id) : null, receiptNo,
      customer ? String(customer.id) : null,
      customer ? customer.name : (params.walkInName || null),
      customer ? customer.phone : (params.walkInPhone || null),
      prepared.saleType, String(user.id),
      // Status is always COMPLETED at insert time. A sale awaiting delivery is
      // flipped to PENDING_DELIVERY by the delivery block below, once its job
      // row exists — setting it here would leave a status pointing at a job
      // that has not been written yet if anything between the two failed.
      'COMPLETED',
      totals.subtotal, totals.discountAmount, round2(totals.orderDiscount || 0), discountReason,
      vat.vatEnabled, vat.vatRatePercent, vat.vatAmount,
      // `total` is what the goods cost. Change owed does NOT reduce it: the sale
      // happened at full price and the shop is holding money that belongs to the
      // customer. Reducing the total would understate revenue and understate the
      // liability at the same time.
      totals.total, paymentResult.paid, round2(Math.max(0, totals.total - paymentResult.paid)),
      // Tendered is what physically arrived (total + change owed); given is what
      // went back over the counter.
      round2(cashTenderedFrom(paymentResult.legs) || paymentResult.tendered), changeGivenFrom(paymentResult.legs),
      dominantMethod(paymentResult.legs), 'NGN',
      isCredit && paymentResult.balanceDue > 0 ? creditDueDate(customer, customerClass, settings) : null,
      deliveryRequired ? 1 : 0, deliveryAddress || null, totals.deliveryFee,
      latePosting
        ? `${notes ? notes + ' | ' : ''}Late posting: recorded ${sold.minutesBack >= 1440 ? Math.floor(sold.minutesBack / 1440) + ' day(s)' : sold.minutesBack + ' minute(s)'} after the sale, against a till that was already counted.`
        : (notes || null),
      sold.sql,
    ]);

    // ---- lines, stock decrements, serials
    for (const line of prepared.lines) {
      const itemId = tx.idFor(`item-${line.index}`);
      tx.queue(`INSERT INTO sale_items (
          id, sale_id, product_id, variant_id, batch_id, category_id, product_name, sku, serial_no,
          unit_code, quantity, quantity_in_base, unit_price, price_source, price_list_id,
          discount_amount, discount_reason, vat_amount, line_total, cost_price_snapshot, margin, margin_pct, notes,
          created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
        itemId, saleId, String(line.productId), line.variantId ? String(line.variantId) : null,
        line.picks[0] ? line.picks[0].batchId : null,
        line.categoryId ? String(line.categoryId) : null,
        line.productName, line.sku,
        line.requestedSerials.length === 1 ? line.requestedSerials[0] : null,
        line.unitCode, line.quantity, line.quantityInBase, line.unitPrice, line.priceSource,
        line.priceListId ? String(line.priceListId) : null,
        line.discountAmount, line.discountReason || null, line.vatAmount, line.lineTotal,
        line.costPriceSnapshot, line.margin, line.marginPct, line.notes || null,
      ]);

      // Stock decrement, one row per batch consumed.
      //
      // Each is a GUARDED update. If another transaction took the last of this
      // batch between our read and our write, this affects 0 rows and the
      // commit fails loudly rather than driving the quantity negative.
      //
      // The guard is `quantity - quantity_reserved >= ?`, not `quantity >= ?`.
      // Reserved units are held by a layaway or an open delivery job: they are
      // physically on the shelf but they are not for sale. The weaker guard
      // happens to hold whenever prepare() has done its arithmetic correctly,
      // which makes it a trap rather than a safety net — it depends on a
      // distant function, and a layaway created concurrently between prepare
      // and commit would break the stock_batches CHECK
      // (quantity_reserved <= quantity) with a message that names a constraint
      // rather than the reason. Guarding on what is actually SELLABLE makes the
      // invariant local to the statement that needs it.
      for (const pick of line.picks) {
        tx.queue(
          `UPDATE stock_batches
              SET quantity = quantity - ?,
                  status = CASE WHEN quantity - ? <= 0 THEN 'DEPLETED' ELSE status END,
                  updated_at = datetime('now')
            WHERE id = ? AND is_deleted = 0 AND quantity - quantity_reserved >= ?`,
          [pick.quantityBase, pick.quantityBase, pick.batchId, pick.quantityBase],
        );
      }

      // Serials: mark sold, start the warranty clock, and chain an event.
      for (let s = 0; s < line.serialRows.length; s += 1) {
        const serialRow = line.serialRows[s];
        const serialNo = String(serialRow.serial_no);
        const chain = serialChains.get(serialNo);
        if (!chain) continue; // no chain prepared (should not happen); skip rather than break the chain

        tx.queue(`UPDATE serial_numbers SET
            status = 'SOLD', branch_id = ?, sale_id = ?, customer_id = ?,
            sold_at = ?,
            warranty_starts_at = ?, warranty_ends_at = ?,
            updated_at = datetime('now')
          WHERE id = ? AND is_deleted = 0 AND status IN ('IN_STOCK','RESERVED')`, [
          String(branch.id), saleId, customer ? String(customer.id) : null,
          sold.sql, chain.warrantyStart, chain.warrantyEnd, String(serialRow.id),
        ]);

        tx.queue(`INSERT INTO sale_serials (id, sale_id, sale_item_id, serial_id, serial_no, branch_id, created_at)
                  VALUES (?,?,?,?,?,?, datetime('now'))`, [
          newId(), saleId, itemId, String(serialRow.id), serialNo, String(branch.id),
        ]);

        tx.queue(`INSERT INTO serial_events (
            id, serial_id, serial_no, event_type, from_status, to_status, branch_id,
            reference_type, reference_id, actor_id, customer_id, notes, prev_hash, row_hash, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`, [
          chain.eventId, String(serialRow.id), serialNo, 'SOLD', serialRow.status, 'SOLD', String(branch.id),
          'SALE', saleId, String(user.id), customer ? String(customer.id) : null,
          chain.note, chain.prevHash, chain.rowHash,
        ]);
      }
    }

    // ---- payment legs
    for (const leg of paymentResult.legs) {
      tx.queue(`INSERT INTO sale_payments (
          id, sale_id, branch_id, till_session_id, method, amount, reference, bank_name,
          status, cash_tendered, change_given, recorded_by, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
        newId(), saleId, String(branch.id), till ? String(till.id) : null,
        leg.method, leg.amount, leg.reference || null, leg.bankName || null,
        leg.status || 'CLEARED', leg.cashTendered, leg.changeGiven, String(user.id), leg.notes || null,
      ]);
    }

    // ---- credit sale: debtor ledger + customer balance
    //
    // THE LEDGER RECORDS THE GROSS INVOICE, THEN THE PAYMENTS AGAINST IT.
    //
    // It used to post the charge NET of the cash part-payment (`amount =
    // balanceDue`) and THEN post the part-payment again as a negative row. That
    // subtracted the same money twice: on a ₦60,000 bill settled with ₦20,000
    // cash the ledger ran to a balance of ₦20,000 while customers.credit_balance
    // correctly said ₦40,000. Two figures on the same screen disagreeing, and
    // the ledger — the one a debt collector works from — understated what every
    // part-paying customer owed by exactly what they had already paid. The
    // longer the relationship, the bigger the understatement, so the most
    // loyal credit customers looked the closest to settled.
    //
    // A statement has to show the whole invoice and each payment against it,
    // because that is the only form a customer can be argued with.
    if (isCredit && customer) {
      const prior = round2(Number(customer.credit_balance) || 0);
      const afterCharge = round2(prior + totals.total);
      const finalBalance = round2(prior + paymentResult.balanceDue);

      if (paymentResult.balanceDue > 0) {
        // `due_date` travels WITH the charge, computed from the same terms that
        // produced `sales.due_date` a few lines above. Without it every ageing
        // reader falls back to `created_at`, so "overdue" silently means "days
        // since the sale" and the owner's grace setting means something different
        // for every customer class. See migration 0004.
        const dueDate = creditDueDate(customer, customerClass, settings);
        tx.queue(`INSERT INTO debtor_ledger (
            id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, due_date, notes, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
          newId(), String(branch.id), String(business.id), String(customer.id), 'SALE', saleId,
          totals.total, afterCharge, dueDate,
          `Credit sale, receipt ${receiptNo}${creditOverrideReason ? `. Over limit: ${creditOverrideReason}` : ''}`,
          String(user.id),
        ]);
      }

      // Each real-money leg reduces the balance. A running total is kept so
      // several legs on one sale each show the balance after THAT payment,
      // which is what makes the statement readable when a customer pays cash
      // and transfer against the same bill.
      let running = afterCharge;
      for (const leg of paymentResult.legs.filter((l) => l.method !== 'CREDIT')) {
        running = round2(running - leg.amount);
        tx.queue(`INSERT INTO debtor_ledger (
            id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
          newId(), String(branch.id), String(business.id), String(customer.id), 'PAYMENT', saleId,
          -leg.amount, running,
          `Part payment on receipt ${receiptNo} by ${leg.method.replace(/_/g, ' ').toLowerCase()}`, String(user.id),
        ]);
      }

      // The customer row must end on the ledger's final figure. If a fully
      // settled credit sale is recorded, nothing was charged and the balance
      // does not move — but the UPDATE still runs so the two cannot drift.
      tx.queue("UPDATE customers SET credit_balance = ?, updated_at = datetime('now') WHERE id = ?",
        [finalBalance, String(customer.id)]);
    }

    // ---- change owed
    if (changeOwed > 0) {
      const claimCode = shortCode(8);
      const expiryDays = Number(settings.change_owed_expiry_days) || 30;
      tx.queue(`INSERT INTO change_owed (
          id, branch_id, business_id, sale_id, customer_id, customer_name, customer_phone,
          amount, claim_code, status, expires_at, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'OUTSTANDING', date('now', ?), ?, datetime('now'), datetime('now'))`, [
        newId(), String(branch.id), String(business.id), saleId,
        customer ? String(customer.id) : null,
        customer ? customer.name : String(params.walkInName || 'Walk-in customer'),
        customer ? customer.phone : (params.walkInPhone || null),
        changeOwed, claimCode, `+${expiryDays} days`, String(user.id),
      ]);
    }

    // ---- till counters
    // Skipped for a late posting: that session was already counted and closed,
    // so its totals are a signed-off historical record.
    if (till && !latePosting) {
      const byMethod = totalsByMethod(paymentResult.legs);
      tx.queue(`UPDATE till_sessions SET
          cash_sales_total = cash_sales_total + ?,
          pos_total = pos_total + ?,
          transfer_total = transfer_total + ?,
          mobile_money_total = mobile_money_total + ?,
          cheque_total = cheque_total + ?,
          credit_total = credit_total + ?,
          other_total = other_total + ?,
          grand_total = grand_total + ?,
          sale_count = sale_count + 1,
          updated_at = datetime('now')
        WHERE id = ?`, [
        byMethod.CASH, byMethod.POS_TERMINAL, byMethod.BANK_TRANSFER, byMethod.MOBILE_MONEY,
        byMethod.CHEQUE, byMethod.CREDIT, byMethod.OTHER, round2(totals.total - changeOwed), String(till.id),
      ]);
    }

    // ---- general ledger
    const glStatements = glService.postSaleStatements({
      saleId, business, branch, totals, vat, payments: paymentResult.legs,
      lines: prepared.lines, isCredit, balanceDue: paymentResult.balanceDue,
      changeOwed, user, receiptNo, customer, accountIds,
    });
    for (const s of glStatements) tx.queue(s.sql, s.params);

    // ---- delivery job, if requested
    if (deliveryRequired) {
      const jobId = tx.idFor('delivery');
      // job_no is UNIQUE ACROSS THE WHOLE DEPLOYMENT (idx_delivery_job_no is not
      // scoped to a branch), but receipt_no is only unique WITHIN a branch. The
      // first version concatenated the receipt number alone, so the moment a
      // second branch made a delivery sale whose receipt number matched one
      // already used elsewhere, the insert died on a UNIQUE constraint — and it
      // took the whole sale with it, because the job is written in the same
      // transaction. Multi-branch is the core case for this product, so this was
      // not an edge case: it was a collision waiting for branch two.
      //
      // Prefixing with the branch code keeps the number globally unique and
      // still readable on a dispatch board, where "which branch" is the first
      // question anybody asks.
      const branchTag = String(branch.code || branch.id.slice(0, 4)).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase();
      const jobNo = `DLV-${branchTag}-${receiptNo}`;
      tx.queue(`INSERT INTO delivery_jobs (
          id, job_no, branch_id, business_id, sale_id, customer_id, delivery_address, delivery_city,
          delivery_state, status, fee, fee_collected, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'PENDING', ?, ?, ?, datetime('now'), datetime('now'))`, [
        jobId, jobNo, String(branch.id), String(business.id), saleId,
        customer ? String(customer.id) : null,
        deliveryAddress || (customer && customer.address) || 'Address to be confirmed',
        (customer && customer.city) || branch.city || null,
        (customer && customer.state) || branch.state || null,
        totals.deliveryFee, round2(totals.deliveryFee), String(user.id),
      ]);
      for (const line of prepared.lines.filter((l) => Number(l.product.is_bulky) || l.quantityInBase > 0)) {
        tx.queue(`INSERT INTO delivery_job_items (
            id, delivery_job_id, sale_item_id, product_id, variant_id, quantity, quantity_in_base, unit_code, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
          newId(), jobId, tx.peek(`item-${line.index}`), String(line.productId),
          line.variantId ? String(line.variantId) : null, line.quantity, line.quantityInBase, line.unitCode,
        ]);
      }
      tx.queue("UPDATE sales SET status = 'PENDING_DELIVERY', updated_at = datetime('now') WHERE id = ?", [saleId]);
    }

    return {
      ok: true,
      saleId,
      receiptNo,
      branchId: String(branch.id),
      totals,
      vat,
      paid: paymentResult.paid,
      balanceDue: paymentResult.balanceDue,
      changeOwed,
      creditInfo,
      // Preparation warnings plus any the payment split raised. Dropping the
      // payment advisories here would mean a sale recorded as "credit" but
      // settled in full — which silently creates no debt — was never reported
      // to anybody.
      warnings: [...(prepared.warnings || []), ...(paymentResult.advisories || []).map((message) => ({ code: 'PAYMENT_ADVISORY', severity: 'WARN', message }))],
      lineCount: prepared.lines.length,
      tillSessionId: till ? String(till.id) : null,
      soldAt: sold.sql,
      // Surfaced so a caller (and the receipt printout) can say plainly that
      // this sale landed after its till was counted, instead of the cashier
      // discovering a shortfall they did not cause.
      latePosting,
      backdated: sold.backdated,
    };
  });
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------

function vatEnabledTotals(totals, settings) {
  const enabled = Boolean(Number(settings.vat_enabled));
  return {
    vatEnabled: enabled ? 1 : 0,
    vatRatePercent: enabled ? Number(settings.vat_rate_percent) || 0 : 0,
    vatAmount: enabled ? totals.vatAmount || 0 : 0,
  };
}

function dominantMethod(legs) {
  if (!legs.length) return 'CASH';
  const byAmount = legs.reduce((acc, l) => { acc[l.method] = (acc[l.method] || 0) + Number(l.amount); return acc; }, {});
  return Object.keys(byAmount).sort((a, b) => byAmount[b] - byAmount[a])[0];
}

function totalsByMethod(legs) {
  const out = { CASH: 0, POS_TERMINAL: 0, BANK_TRANSFER: 0, MOBILE_MONEY: 0, USSD: 0, CHEQUE: 0, CREDIT: 0, OTHER: 0 };
  for (const leg of legs) {
    const key = out[leg.method] === undefined ? 'OTHER' : leg.method;
    out[key] = round2(out[key] + Number(leg.amount));
  }
  // USSD and mobile money are the same rail for reconciliation purposes in
  // Nigeria; folding USSD into MOBILE_MONEY keeps the till report to the
  // categories a bank statement actually shows.
  out.MOBILE_MONEY = round2(out.MOBILE_MONEY + out.USSD);
  out.USSD = 0;
  return out;
}

/**
 * CASH HANDED BACK ACROSS THE COUNTER — derived, because nothing derived it.
 *
 * `sale_payments.change_given` and `sales.change_given` have existed since the first
 * schema, and `changeGivenFrom()` has always read `leg.changeGiven` — but that field
 * was only ever read from the REQUEST (`leg.change_given`), and the route's
 * `normalisePayments()` never copied it out of the body. So no client could set it, and
 * nothing computed it: EVERY cash sale in this system recorded ₦0 change given.
 *
 * What that costs is not the till's arithmetic — the drawer is reconciled from the
 * payment AMOUNTS, which were always right. It is the argument afterwards. A customer
 * tendered ₦35,500 for a ₦34,000 sale and the record said ₦0 went back; the cashier has
 * no evidence for the ₦1,500 that left the drawer, and neither does the owner. This
 * system exists to be that evidence.
 *
 * Found by test/audit/audit.money.js reading the sale back and finding a zero where the
 * receipt in the customer's hand said ₦1,500.
 *
 * The arithmetic: what the customer handed over, less what was applied to the sale, less
 * anything the till kept as change OWED. That last term matters and is the bug this
 * function's sibling already documents: change GIVEN is cash that left the drawer, change
 * OWED is cash that stayed in it, and lumping them together made every drawer that owed
 * change look short by exactly that amount.
 *
 * A client that states a figure itself still wins — some counters hand back from a
 * different drawer, and the person who was standing there outranks arithmetic.
 */
function deriveChangeGiven(legs, changeOwed) {
  const cashLegs = legs.filter((l) => l.method === 'CASH');
  if (!cashLegs.length) return legs;
  if (cashLegs.some((l) => l.changeGiven != null)) return legs; // the client said; do not override
  const tendered = round2(cashLegs.reduce((a, l) => a + Number(l.cashTendered || 0), 0));
  if (tendered <= 0) return legs;
  const applied = round2(cashLegs.reduce((a, l) => a + Number(l.amount || 0), 0));
  const given = round2(Math.max(0, tendered - applied - (Number(changeOwed) || 0)));
  cashLegs[0].changeGiven = given;
  return legs;
}

function cashTenderedFrom(legs) {
  const cash = legs.find((l) => l.method === 'CASH');
  return cash && cash.cashTendered != null ? cash.cashTendered : 0;
}

/**
 * Cash handed BACK over the counter.
 *
 * This used to add `changeOwed` in, conflating two opposite facts: change GIVEN
 * is cash that left the drawer, change OWED is cash that stayed in it and became
 * a liability. Adding them made the till reconciliation short by exactly the
 * amount owed, and the cashier could not tell whether the drawer was wrong or
 * the claim book was.
 */
function changeGivenFrom(legs) {
  const cash = legs.find((l) => l.method === 'CASH');
  return round2(cash && cash.changeGiven != null ? cash.changeGiven : 0);
}

function creditDueDate(customer, customerClass, settings) {
  const { creditTerms } = require('../../domain/credit');
  return creditTerms({ customer, customerClass, settings }).dueDate;
}

async function serialHeadHash(db, serialNo) {
  const row = await db.first(
    'SELECT row_hash FROM serial_events WHERE serial_no = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [String(serialNo)],
  );
  return row ? row.row_hash : null;
}

// ---------------------------------------------------------------------
// VOID
// ---------------------------------------------------------------------
/**
 * Void a completed sale.
 *
 * A void is NOT a delete. The sale row stays with status VOIDED, stock is
 * restored, the till counters are reversed, the ledger is reversed by a
 * compensating entry rather than by removal, and the reason and actor are
 * recorded. Deleting it would be the single most destructive thing this
 * system could do: it would remove the evidence that the sale ever happened,
 * which is exactly what a fraudulent void is trying to achieve.
 */
async function voidSale(db, { saleId, user, settings, reason, scope, restoreStock = true }) {
  if (!reason || String(reason).trim().length < 4) {
    throw err('Give a reason for the void. It is recorded and reviewed — "wrong item" and "customer changed their mind" are different conversations.', 'VOID_REASON_REQUIRED');
  }
  const sale = await db.first('SELECT * FROM sales WHERE id = ? AND is_deleted = 0', [String(saleId)]);
  if (!sale) throw err('That sale does not exist.', 'SALE_NOT_FOUND', 404);
  if (sale.status === 'VOIDED') throw err('That sale is already voided.', 'ALREADY_VOIDED', 409);

  // ---- THE VOID WINDOW, AND TWO BUGS THAT USED TO LIVE HERE
  //
  // `sales.sold_at` is stored in WEST AFRICA TIME. The first version of this
  // line compared it against `new Date().toISOString()` — UTC — and then took
  // `Math.abs()` of the result. Those two mistakes compounded into an
  // INVERTED window:
  //
  //   sale made  1 minute ago -> elapsed = 1 - 60 = -59 -> abs = 59 -> REFUSED
  //   sale made 75 minutes ago-> elapsed = 75 - 60 =  15 -> abs = 15 -> ALLOWED
  //
  // So the one thing the allowance exists for — a cashier correcting a
  // mis-keyed sale at a busy counter — was blocked, while the thing it exists
  // to prevent — walking away and voiding a cash sale an hour later to pocket
  // the note — was permitted. The `abs()` looked like a defence against clock
  // skew but is the wrong direction of defence: it converts "timestamped in
  // the future" into "very old", which is the permissive reading.
  //
  // Now: compare in one zone (WAT), never abs, and clamp a negative elapsed
  // to zero — a sale stamped in the future is by definition not an old sale,
  // and clock skew should cost a cashier nothing.
  const minutesSince = minutesBetween(sale.sold_at, watNow());
  const elapsed = minutesSince == null ? null : Math.max(0, minutesSince);
  const authority = canVoidSale(settings, user, sale, { nowMinutesSinceSale: elapsed });
  if (!authority.allowed) throw err(authority.reason, 'VOID_NOT_ALLOWED', 403);

  if (scope && !scope.allBranches && String(sale.branch_id) !== String(user.branch_id)) {
    throw err('That sale belongs to another branch. You can only void sales from the branch you are signed in to.', 'BRANCH_SCOPE_VIOLATION', 403);
  }

  const items = await db.all('SELECT * FROM sale_items WHERE sale_id = ? AND is_deleted = 0', [String(saleId)]);
  const serials = await db.all('SELECT * FROM sale_serials WHERE sale_id = ?', [String(saleId)]);
  const ledger = await db.all("SELECT * FROM debtor_ledger WHERE reference_id = ? AND entry_type = 'SALE' AND is_deleted = 0", [String(saleId)]);
  const customer = sale.customer_id ? await db.first('SELECT * FROM customers WHERE id = ?', [String(sale.customer_id)]) : null;
  const till = sale.till_session_id ? await db.first('SELECT * FROM till_sessions WHERE id = ?', [String(sale.till_session_id)]) : null;
  const accountIds = await glService.loadAccountCodes(db, sale.business_id);

  return db.transaction(async (tx) => {
    tx.queue(`UPDATE sales SET status = 'VOIDED', voided_at = datetime('now'), voided_by = ?, void_reason = ?, updated_at = datetime('now') WHERE id = ?`,
      [String(user.id), String(reason).slice(0, 500), String(saleId)]);

    if (restoreStock) {
      for (const item of items) {
        if (!item.batch_id) continue;
        // Restoring to the ORIGINAL batch keeps cost and price history
        // intact. Restoring to a new batch would value the returned stock at
        // today's cost rather than the cost it was actually bought at, and
        // the margin on its next sale would be fiction.
        tx.queue(`UPDATE stock_batches SET
            quantity = quantity + ?,
            status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END,
            updated_at = datetime('now')
          WHERE id = ? AND is_deleted = 0`, [item.quantity_in_base, String(item.batch_id)]);
      }
    }

    for (const s of serials) {
      tx.queue(`UPDATE serial_numbers SET status = 'IN_STOCK', sale_id = NULL, sold_at = NULL,
          warranty_starts_at = NULL, warranty_ends_at = NULL, branch_id = ?, updated_at = datetime('now')
        WHERE id = ?`, [String(sale.branch_id), String(s.serial_id)]);
      tx.queue('DELETE FROM sale_serials WHERE id = ?', [String(s.id)]);
    }

    // Reverse the debtor ledger with a compensating entry, never by deleting
    // the original: the original is the record that the credit was extended,
    // and erasing it would make the customer's history look as though they
    // had never been trusted at all.
    for (const entry of ledger) {
      const newBalance = customer ? round2((Number(customer.credit_balance) || 0) - Number(entry.amount)) : 0;
      tx.queue(`INSERT INTO debtor_ledger (id, branch_id, business_id, customer_id, entry_type, reference_id, amount, balance_after, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`, [
        newId(), String(sale.branch_id), String(sale.business_id), String(sale.customer_id), 'ADJUSTMENT', saleId,
        -Number(entry.amount), Math.max(0, newBalance), `Reversal of voided sale, receipt ${sale.receipt_no}: ${reason}`, String(user.id),
      ]);
      if (customer) tx.queue("UPDATE customers SET credit_balance = MAX(0, credit_balance - ?), updated_at = datetime('now') WHERE id = ?", [Number(entry.amount), String(customer.id)]);
    }

    if (till && till.status === 'OPEN') {
      tx.queue(`UPDATE till_sessions SET
          grand_total = MAX(0, grand_total - ?),
          cash_sales_total = MAX(0, cash_sales_total - ?),
          sale_count = MAX(0, sale_count - 1),
          void_count = void_count + 1,
          updated_at = datetime('now')
        WHERE id = ?`, [Number(sale.total), Number(sale.total), String(till.id)]);
    } else if (till && till.status === 'CLOSED') {
      // A void against a CLOSED till cannot silently rewrite a reconciled
      // day. It is allowed (the goods genuinely came back) but recorded so
      // the owner knows a closed day's figures no longer match the till
      // sheet that was signed off.
      tx.queue(`UPDATE till_sessions SET void_count = void_count + 1, notes = COALESCE(notes,'') || ?, updated_at = datetime('now') WHERE id = ?`,
        [` [Voided after close: receipt ${sale.receipt_no} on ${new Date().toISOString().slice(0, 10)}]`, String(till.id)]);
    }

    for (const s of glService.reverseSaleStatements({ sale, items, business: { id: sale.business_id }, branch: { id: sale.branch_id }, user, reason, accountIds })) {
      tx.queue(s.sql, s.params);
    }

    return { ok: true, saleId: String(saleId), receiptNo: sale.receipt_no, restoredStock: restoreStock, itemsReversed: items.length };
  });
}

module.exports = {
  SALE_TYPES, PAYMENT_METHODS,
  prepare, complete, voidSale, validatePayments, totalsByMethod, dominantMethod,
  serialEventFields,
};
