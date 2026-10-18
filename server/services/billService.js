'use strict';
// =====================================================================
// server/services/billService.js — HOLD THE GOODS, DO NOT SELL THEM
// =====================================================================
// Raising a bill reserves stock and prints a document that says it is not
// a receipt. Paying a bill is what creates the sale, through the same
// engine every other sale uses, and only then may the store release the
// goods. Cancelling or expiring an unpaid bill puts the units back.

const { HttpError } = require('../lib/http');
const { newId } = require('../../domain/crypto');
const { watNow } = require('../../domain/time');
const { round2 } = require('../../domain/money');
const { resolveProfile } = require('../../domain/verticals');
const {
  billsFirst, holdUntil, holdExpired, billableLines, customerNameForBill, saleNoteToken,
} = require('../../domain/billing');
const salesService = require('./salesService');

function fail(message, code, status = 400) {
  return new HttpError(message, { status, code });
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function profileOf(business) {
  if (!business) return null;
  let overrides = null;
  if (business.profile_overrides_json) {
    try { overrides = JSON.parse(business.profile_overrides_json); } catch (e) { overrides = null; }
  }
  return resolveProfile(business.profile_code, overrides);
}

function assertBillsFirst(business) {
  if (!billsFirst(profileOf(business))) {
    throw fail(
      'This business takes payment and prints the receipt together. A bill that holds stock is for a warehouse, a wholesale desk, a yard, a showroom or an electronics plaza — or turn “Bill, then receipt” on for this business.',
      'BILLING_NOT_ENABLED',
      409,
    );
  }
}

async function nextBillNo(db, branchId) {
  const row = await db.first(
    `SELECT bill_no FROM customer_bills WHERE branch_id = ? ORDER BY length(bill_no) DESC, bill_no DESC LIMIT 1`,
    [String(branchId)],
  );
  const last = row ? parseInt(String(row.bill_no).replace(/\D/g, ''), 10) : 0;
  const next = (Number.isFinite(last) ? last : 0) + 1;
  return `B${String(next).padStart(6, '0')}`;
}

function displayLines(prepared) {
  return (prepared.lines || []).map((line) => ({
    product_name: line.productName,
    variant_name: line.variant ? line.variant.name : null,
    quantity: line.quantity,
    unit_code: line.unitCode || null,
    unit_price: line.unitPrice,
    line_total: line.lineTotal,
    serial_no: (line.requestedSerials || []).join(', ') || null,
  }));
}

function replayLines(rawLines, prepared) {
  return (prepared.lines || []).map((line, i) => {
    const raw = rawLines[i] || {};
    return {
      product_id: line.productId,
      variant_id: line.variantId || null,
      quantity: line.quantity,
      unit_code: line.unitCode || null,
      // The price on the paper is the price they pay, even if the list moves
      // before they reach the cashier.
      manual_price: line.unitPrice,
      discount_amount: raw.discountAmount != null ? raw.discountAmount : (raw.discount_amount != null ? raw.discount_amount : null),
      discount_pct: raw.discountPct != null ? raw.discountPct : (raw.discount_pct != null ? raw.discount_pct : null),
      discount_reason: raw.discountReason || raw.discount_reason || null,
      channel: line.channel || raw.channel || null,
      serial_numbers: line.requestedSerials && line.requestedSerials.length ? line.requestedSerials : null,
      notes: raw.notes || null,
      prescription: raw.prescription || null,
      controlled_kyc: raw.controlledKyc || raw.controlled_kyc || null,
    };
  });
}

function holdsOf(prepared) {
  const holds = [];
  for (const line of prepared.lines || []) {
    for (const pick of line.picks || []) {
      if (!pick.batchId || !(Number(pick.quantityBase) > 0)) continue;
      holds.push({ batchId: String(pick.batchId), quantityBase: Number(pick.quantityBase) });
    }
  }
  return holds;
}

function serialsOf(prepared) {
  const out = [];
  for (const line of prepared.lines || []) {
    for (const sn of line.requestedSerials || []) out.push(String(sn));
  }
  return out;
}

function publicBill(row, extra = {}) {
  const packed = parseJson(row.lines_json, {});
  return {
    id: row.id,
    bill_no: row.bill_no,
    status: row.status,
    branch_id: row.branch_id,
    branch_name: row.branch_name || extra.branchName || null,
    business_id: row.business_id,
    customer_id: row.customer_id || null,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone || null,
    sale_type: row.sale_type,
    subtotal: Number(row.subtotal) || 0,
    discount_amount: Number(row.discount_amount) || 0,
    vat_amount: Number(row.vat_amount) || 0,
    total: Number(row.total) || 0,
    valid_until: row.valid_until,
    raised_at: row.raised_at,
    raised_by_name: row.raised_by_name || null,
    notes: row.notes || null,
    sale_place: row.sale_place || null,
    vehicle_id: row.vehicle_id || null,
    lines: packed.display || [],
    paid_sale_id: row.paid_sale_id || null,
    document: 'BILL',
    not_a_receipt: true,
  };
}

async function releaseHolds(db, billId) {
  const holds = await db.all('SELECT batch_id, quantity_base FROM bill_holds WHERE bill_id = ?', [String(billId)]);
  const serials = await serialsOnBill(db, billId);
  await db.transaction(async (tx) => {
    for (const hold of holds) {
      tx.queue(
        `UPDATE stock_batches
            SET quantity_reserved = quantity_reserved - ?,
                updated_at = datetime('now')
          WHERE id = ? AND is_deleted = 0 AND quantity_reserved >= ?`,
        [Number(hold.quantity_base), String(hold.batch_id), Number(hold.quantity_base)],
      );
    }
    for (const sn of serials) {
      tx.queue(
        `UPDATE serial_numbers
            SET status = 'IN_STOCK', updated_at = datetime('now')
          WHERE serial_no = ? AND status = 'RESERVED' AND is_deleted = 0`,
        [sn],
      );
    }
    tx.queue('DELETE FROM bill_holds WHERE bill_id = ?', [String(billId)]);
  });
}

async function serialsOnBill(db, billId) {
  const row = await db.first('SELECT lines_json FROM customer_bills WHERE id = ?', [String(billId)]);
  const packed = parseJson(row && row.lines_json, {});
  return Array.isArray(packed.serials) ? packed.serials.map(String) : [];
}

async function raise(db, { params, rawLines, user }) {
  assertBillsFirst(params.business);
  const named = customerNameForBill(
    (params.customer && params.customer.name)
    || params.walkInName
    || '',
  );
  if (!named.ok) throw fail(named.error, named.code);
  const gate = billableLines(params.lines);
  if (!gate.ok) throw fail(gate.error, gate.code);
  if (!params.branch) throw fail('Choose which shop this bill belongs to.', 'BRANCH_REQUIRED');

  const prepared = await salesService.prepare(db, params);
  const holds = holdsOf(prepared);
  if (!holds.length) {
    throw fail('Nothing on this bill could be held. A hire or a lease is not released from the store against a bill.', 'NOTHING_TO_HOLD');
  }
  const serials = serialsOf(prepared);
  if (serials.length) {
    const rows = await db.all(
      `SELECT serial_no, status FROM serial_numbers WHERE is_deleted = 0 AND serial_no IN (${serials.map(() => '?').join(',')})`,
      serials,
    );
    const byNo = new Map(rows.map((r) => [String(r.serial_no), r.status]));
    for (const sn of serials) {
      if (byNo.get(sn) !== 'IN_STOCK') {
        throw fail(`Serial ${sn} is not free to put on a bill. It has to be in stock at this shop.`, 'SERIAL_NOT_FREE', 409);
      }
    }
  }

  const issuedAt = watNow();
  const validUntil = holdUntil(issuedAt);
  const packed = {
    replay: replayLines(rawLines, prepared),
    display: displayLines(prepared),
    serials,
    holds,
  };
  const phone = (params.customer && params.customer.phone) || params.walkInPhone || null;
  let billId = null;
  let billNo = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2 && !billId; attempt += 1) {
    billId = newId();
    billNo = await nextBillNo(db, params.branch.id);
    try {
      await db.transaction(async (tx) => {
        tx.queue(`INSERT INTO customer_bills (
            id, business_id, branch_id, bill_no, status, customer_id, customer_name, customer_phone,
            sale_type, subtotal, discount_amount, discount_reason, delivery_fee, delivery_required, delivery_address,
            vat_amount, total, lines_json, notes, valid_until, raised_by, raised_at, created_at, updated_at)
          VALUES (?,?,?,?, 'OPEN', ?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?, ?,?, datetime('now'), datetime('now'))`, [
          billId, String(params.business.id), String(params.branch.id), billNo,
          params.customer ? String(params.customer.id) : null, named.name, phone,
          prepared.saleType || params.saleType || 'RETAIL',
          prepared.totals.subtotal, round2(Number(params.discountAmount) || 0), params.discountReason || null,
          round2(Number(params.deliveryFee) || 0), params.deliveryRequired ? 1 : 0, params.deliveryAddress || null,
          prepared.totals.vatAmount || 0, prepared.totals.total,
          JSON.stringify(packed), params.notes || null, validUntil, String(user.id), issuedAt,
        ]);
        holds.forEach((hold, index) => {
          tx.queue(
            'INSERT INTO bill_holds (id, bill_id, batch_id, quantity_base) VALUES (?,?,?,?)',
            [tx.idFor(`hold-${index}`), billId, hold.batchId, hold.quantityBase],
          );
        });
        for (const sn of serials) {
          tx.queue(
            `UPDATE serial_numbers SET status = 'RESERVED', updated_at = datetime('now')
              WHERE serial_no = ? AND status = 'IN_STOCK' AND is_deleted = 0`,
            [sn],
          );
        }
      });
    } catch (e) {
      lastError = e;
      billId = null;
      const message = String(e && e.message || '');
      if (message.includes('UNIQUE') && attempt === 0) continue;
      if (message.includes('STOCK_NOT_FREE') || message.includes('quantity_reserved')) {
        throw fail('Those goods are no longer free to hold. Another bill or a sale took them. Check the quantity and print the bill again.', 'STOCK_NOT_FREE', 409);
      }
      throw e;
    }
  }
  if (!billId) throw lastError || fail('The bill could not be numbered. Try again.', 'BILL_NUMBER_FAILED', 409);

  if (serials.length) {
    const held = await db.all(
      `SELECT serial_no, status FROM serial_numbers WHERE is_deleted = 0 AND serial_no IN (${serials.map(() => '?').join(',')})`,
      serials,
    );
    const missed = serials.filter((sn) => !held.some((row) => String(row.serial_no) === sn && row.status === 'RESERVED'));
    if (missed.length) {
      await closeUnpaid(db, { id: billId, status: 'OPEN' }, { status: 'CANCELLED', by: user.id, reason: 'A serial could not be held.' });
      throw fail(`Serial ${missed[0]} could not be held, so the bill was not raised. Nothing is reserved.`, 'SERIAL_NOT_FREE', 409);
    }
  }

  const row = await db.first('SELECT * FROM customer_bills WHERE id = ?', [billId]);
  return {
    ok: true,
    id: billId,
    bill: publicBill(row, { branchName: params.branch.name }),
    message: `Bill ${billNo} is printed. The goods are held until ${validUntil} or until it is paid. This is not a receipt — the store must not release the goods against it.`,
  };
}

async function closeUnpaid(db, bill, { status, by, reason }) {
  if (!bill || (bill.status !== 'OPEN' && bill.status !== 'PAYING')) {
    throw fail('That bill is not open, so it cannot be cancelled.', 'BILL_NOT_OPEN', 409);
  }
  await releaseHolds(db, bill.id);
  const result = await db.run(
    `UPDATE customer_bills
        SET status = ?, cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ?,
            payment_started_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status IN ('OPEN', 'PAYING') AND is_deleted = 0`,
    [status, by ? String(by) : null, reason || null, String(bill.id)],
  );
  if (!result || !result.changes) {
    throw fail('That bill changed while it was being closed. Look at it again.', 'BILL_CHANGED', 409);
  }
}

async function expireDue(db, branchIds) {
  const ids = (branchIds || []).map(String).filter(Boolean);
  if (!ids.length) return 0;
  const now = watNow();
  const rows = await db.all(
    `SELECT id, status, valid_until FROM customer_bills
      WHERE is_deleted = 0 AND status = 'OPEN' AND branch_id IN (${ids.map(() => '?').join(',')})
        AND valid_until < ?
      LIMIT 30`,
    [...ids, now],
  );
  let n = 0;
  for (const row of rows) {
    if (!holdExpired(row.valid_until, now)) continue;
    try {
      await closeUnpaid(db, row, { status: 'EXPIRED', by: null, reason: 'The bill expired before it was paid. The hold has been released.' });
      n += 1;
    } catch (e) { /* a bill that moved under us is the next list's problem */ }
  }
  return n;
}

async function recoverPaying(db, branchIds) {
  const ids = (branchIds || []).map(String).filter(Boolean);
  if (!ids.length) return;
  const stuck = await db.all(
    `SELECT * FROM customer_bills
      WHERE is_deleted = 0 AND status = 'PAYING'
        AND branch_id IN (${ids.map(() => '?').join(',')})
        AND payment_started_at IS NOT NULL
        AND payment_started_at < datetime('now', '-3 minutes')
      LIMIT 20`,
    ids,
  );
  for (const bill of stuck) {
    const token = saleNoteToken(bill.id);
    const sale = await db.first(
      `SELECT id, receipt_no FROM sales
        WHERE branch_id = ? AND is_deleted = 0 AND notes LIKE ?
        ORDER BY created_at DESC LIMIT 1`,
      [String(bill.branch_id), `%${token}%`],
    );
    if (sale) {
      await db.run('DELETE FROM bill_holds WHERE bill_id = ?', [String(bill.id)]);
      await db.run(
        `UPDATE customer_bills
            SET status = 'PAID', paid_sale_id = ?, paid_at = COALESCE(paid_at, datetime('now')),
                updated_at = datetime('now')
          WHERE id = ? AND status = 'PAYING'`,
        [String(sale.id), String(bill.id)],
      );
    } else {
      await db.run(
        `UPDATE customer_bills
            SET status = 'OPEN', payment_started_at = NULL, updated_at = datetime('now')
          WHERE id = ? AND status = 'PAYING'`,
        [String(bill.id)],
      );
    }
  }
}

async function loadBill(db, id) {
  return db.first(
    `SELECT b.*, br.name AS branch_name, u.full_name AS raised_by_name
       FROM customer_bills b
       LEFT JOIN branches br ON br.id = b.branch_id
       LEFT JOIN users u ON u.id = b.raised_by
      WHERE b.id = ? AND b.is_deleted = 0`,
    [String(id)],
  );
}

function packedOf(bill) {
  return parseJson(bill.lines_json, {});
}

/**
 * Lock an open bill so two cashiers cannot pay it into two sales.
 * Returns the body the sale engine should complete.
 */
async function beginPay(db, bill, user) {
  if (!bill) throw fail('That bill does not exist.', 'BILL_NOT_FOUND', 404);
  if (bill.status === 'PAID') {
    throw fail(`Bill ${bill.bill_no} is already paid. Print the receipt again from the sale — do not take the money twice.`, 'BILL_ALREADY_PAID', 409);
  }
  if (bill.status === 'CANCELLED' || bill.status === 'EXPIRED') {
    throw fail(`Bill ${bill.bill_no} is ${String(bill.status).toLowerCase()}. The goods are not held. Raise a new bill if the customer still wants them.`, 'BILL_NOT_OPEN', 409);
  }
  if (bill.status === 'PAYING') {
    throw fail(`Bill ${bill.bill_no} is already being paid at another desk. Wait a moment, then look again — do not take the money twice.`, 'BILL_PAYING', 409);
  }
  if (holdExpired(bill.valid_until, watNow())) {
    await closeUnpaid(db, bill, { status: 'EXPIRED', by: user.id, reason: 'Expired at the cashier before payment.' });
    throw fail(`Bill ${bill.bill_no} expired at ${bill.valid_until}. The hold has been released. Raise a new bill.`, 'BILL_EXPIRED', 409);
  }
  const locked = await db.run(
    `UPDATE customer_bills
        SET status = 'PAYING', payment_started_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'OPEN' AND is_deleted = 0`,
    [String(bill.id)],
  );
  if (!locked || !locked.changes) {
    throw fail('That bill changed while the cashier opened it. Look at the open bills again.', 'BILL_CHANGED', 409);
  }
  const packed = packedOf(bill);
  return {
    bill,
    holds: Array.isArray(packed.holds) ? packed.holds : [],
    serials: Array.isArray(packed.serials) ? packed.serials : [],
    replay: Array.isArray(packed.replay) ? packed.replay : [],
  };
}

function payRequest(bill, replay, paymentBody) {
  const token = saleNoteToken(bill.id);
  const cashierNote = paymentBody && paymentBody.notes ? String(paymentBody.notes).slice(0, 300) : '';
  const stored = bill.notes ? String(bill.notes).slice(0, 200) : '';
  const notes = [token, stored, cashierNote].filter(Boolean).join(' ').slice(0, 500);
  return {
    branch_id: bill.branch_id,
    business_id: bill.business_id,
    sale_type: bill.sale_type || 'RETAIL',
    customer_id: bill.customer_id || null,
    customer_name: bill.customer_name,
    customer_phone: bill.customer_phone || null,
    walk_in_name: bill.customer_name,
    walk_in_phone: bill.customer_phone || null,
    discount_amount: Number(bill.discount_amount) || 0,
    discount_reason: bill.discount_reason || null,
    delivery_fee: Number(bill.delivery_fee) || 0,
    delivery_required: Number(bill.delivery_required) === 1,
    delivery_address: bill.delivery_address || null,
    notes,
    lines: replay,
    payments: paymentBody.payments || [],
    credit_override_reason: paymentBody.credit_override_reason || paymentBody.creditOverrideReason || null,
    change_owed_amount: paymentBody.change_owed_amount || paymentBody.changeOwedAmount || 0,
    claim_code: paymentBody.claim_code || paymentBody.claimCode || null,
    sold_at: paymentBody.sold_at || paymentBody.soldAt || null,
  };
}

async function markPaid(db, bill, sale, user) {
  await db.run('DELETE FROM bill_holds WHERE bill_id = ?', [String(bill.id)]);
  const result = await db.run(
    `UPDATE customer_bills
        SET status = 'PAID', paid_sale_id = ?, paid_at = datetime('now'), paid_by = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'PAYING' AND is_deleted = 0`,
    [String(sale.saleId), String(user.id), String(bill.id)],
  );
  if (!result || !result.changes) {
    const err = fail(
      `Receipt ${sale.receiptNo} is recorded, but bill ${bill.bill_no} could not be closed. Do not take the payment again. Open the bills list in a moment — it will catch up.`,
      'BILL_CLOSE_FAILED',
      500,
    );
    throw err;
  }
}

async function abortPay(db, billId) {
  await db.run(
    `UPDATE customer_bills
        SET status = 'OPEN', payment_started_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'PAYING' AND is_deleted = 0`,
    [String(billId)],
  );
}

module.exports = {
  assertBillsFirst,
  publicBill,
  raise,
  expireDue,
  recoverPaying,
  loadBill,
  beginPay,
  payRequest,
  markPaid,
  abortPay,
  closeUnpaid,
  saleNoteToken,
};
