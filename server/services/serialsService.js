'use strict';
// =====================================================================
// server/services/serialsService.js — WHAT GOES INTO THE SERIAL REGISTER
// =====================================================================
// WHY THIS IS ONE FILE AND NOT TWO PARAGRAPHS IN TWO ROUTES.
//
// A serial number enters the system through a GOODS RECEIPT, and there are two routes
// that receive goods: the direct one (`POST /api/stock/receive`, a load of stock arriving
// with no paperwork) and the one against a purchase order (`POST /api/purchase-orders/:id/
// receive`). They were written years apart and share nothing — which is how the first
// version of serial capture ended up in one of them only, leaving the other half of the
// product silently unable to register a unit. A shop that buys appliances on a purchase
// order, which is every shop that buys appliances, would have had the same dead end.
//
// So the rules live here: what a serial is, which ones are refused and with what words,
// and what a row for one looks like with its first link in the hash chain already computed.
// Both routes call in; neither can drift.
//
// WHAT IS DELIBERATELY NOT HERE: whether the business wants serials at all. That is the
// `serial_tracking_enabled` setting, read by the caller, because the answer differs by
// deployment and this file is about the numbers themselves.
// =====================================================================

const { HttpError } = require('../lib/http');
const { newId } = require('../../domain/crypto');
const { computeRowHash } = require('../../domain/hashChain');
const { strField } = require('../lib/respond');
const { serialEventFields, serialHeadHash } = require('./salesService');

/**
 * Read the serial numbers out of a request body.
 *
 * Accepts a plain string, or `{serial_no, imei}` — a phone's second identity (the number
 * the networks and the police ask for) arrives with the first. Anything empty is dropped
 * rather than treated as a serial, because a blank line in a textarea is not a unit.
 */
function parseSerials(raw) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list
    .map((sn) => {
      if (sn && typeof sn === 'object') {
        return { serialNo: String(sn.serial_no || sn.serialNo || sn.serial || '').trim(), imei: strField(sn.imei, { field: 'IMEI', maxLength: 40 }) };
      }
      return { serialNo: String(sn == null ? '' : sn).trim(), imei: null };
    })
    .filter((sn) => sn.serialNo !== '');
}

/**
 * Decide whether the serials supplied are acceptable for a delivery of `quantityBase`.
 *
 * Returns `{ serials, warnings }` or throws an HttpError that names what is wrong and what
 * to do about it. `featureOn` is the deployment's switch; when it is off the demand is not
 * made at all — which is the whole meaning of the switch, and the reason a flagged product
 * is not a trap.
 */
async function acceptSerials(db, { product, quantityBase, supplied, featureOn, what = 'delivery' }) {
  const warnings = [];
  const tracked = Number(product.requires_serial) === 1;
  const expected = Math.ceil(Number(quantityBase) || 0);

  if (supplied.length && !tracked) {
    throw new HttpError(`${product.name} is not serial-tracked, so there is nowhere to file ${supplied.length} serial number(s). If every unit is individually identified, tick "Track serial numbers" on the product first — that flag is what makes the serial follow the unit through the sale and into the warranty.`, { status: 400, code: 'SERIALS_NOT_EXPECTED', fields: { serials: 'Not a serial-tracked product.' } });
  }
  if (tracked && featureOn && supplied.length !== expected) {
    throw new HttpError(`"${product.name}" is serial-tracked, so each unit needs its own serial number: ${expected} expected for ${quantityBase} unit(s), ${supplied.length} given. Scan or type the number off each label — a serial captured later cannot be matched to the unit it came in on, and the warranty claim it is needed for is exactly the one that arrives after the box is in the bin.`, { status: 400, code: 'SERIALS_REQUIRED', fields: { serials: `${expected} required.` } });
  }

  if (!supplied.length) return { serials: [], warnings };

  // A duplicate INSIDE one delivery is a mistyped or re-scanned label, caught here so it
  // arrives as a sentence rather than as a unique-index violation that names no line.
  const seen = new Map();
  for (const entry of supplied) {
    const key = entry.serialNo.toUpperCase();
    if (seen.has(key)) {
      throw new HttpError(`Serial "${entry.serialNo}" is on this ${what} twice. A serial identifies one unit, so it cannot be entered twice — check the label against the box.`, { status: 400, code: 'DUPLICATE_SERIAL_IN_REQUEST' });
    }
    seen.set(key, entry.serialNo);
  }

  // The register is the other half: a serial already on file would hit the unique index
  // (product_id, serial_no) anyway, but as a raw constraint failure. Read first so the
  // refusal can name the serial and the branch it is sitting at. Chunked because D1 caps a
  // statement at 100 bound parameters and a delivery of pallets easily exceeds that.
  const keys = [...seen.keys()];
  const taken = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const rows = await db.all(`SELECT UPPER(sn.serial_no) AS serial_no, sn.branch_id, b.name AS branch_name, sn.product_id, p.name AS product_name
          FROM serial_numbers sn
          LEFT JOIN branches b ON b.id = sn.branch_id
          LEFT JOIN products p ON p.id = sn.product_id
        WHERE UPPER(sn.serial_no) IN (${chunk.map(() => '?').join(',')}) AND sn.is_deleted = 0`, chunk);
    for (const r of rows) taken.set(String(r.serial_no), r);
  }

  const sameProduct = keys.filter((k) => taken.has(k) && String(taken.get(k).product_id) === String(product.id));
  if (sameProduct.length) {
    const first = taken.get(sameProduct[0]);
    throw new HttpError(`Serial "${seen.get(sameProduct[0])}" is already on file${first.branch_name ? ` at ${first.branch_name}` : ''}${sameProduct.length > 1 ? ` (and ${sameProduct.length - 1} more on this ${what})` : ''}. Two rows for one serial means either a double goods-received or a duplicated label — open the serial to see where it is before receiving it again.`, { status: 409, code: 'SERIAL_ALREADY_RECEIVED', fields: { serials: 'Already received.' } });
  }

  // A serial carried by a DIFFERENT product is legal in this schema and a real-world
  // alarm: a cloned IMEI, or a label stuck on the wrong unit. A warning rather than a
  // refusal, because a shop that sells two brands of one model meets it legitimately.
  const elsewhere = new Set(keys.filter((k) => taken.has(k) && String(taken.get(k).product_id) !== String(product.id)));
  for (const entry of supplied) {
    if (elsewhere.has(entry.serialNo.toUpperCase())) {
      warnings.push(`Serial ${entry.serialNo} is also on file against ${taken.get(entry.serialNo.toUpperCase()).product_name}. Both rows are kept — two products can share a serial across brands — but a label that has been copied is how a warranty claim ends up investigating the wrong unit.`);
    }
  }

  return { serials: supplied.map((s) => ({ serialNo: s.serialNo, imei: s.imei })), warnings };
}

/**
 * Build the rows for the serials, with their first link in the hash chain already hashed.
 *
 * Must be called BEFORE the write phase: `computeRowHash` is async and a transaction body
 * may only queue statements (better-sqlite3 cannot span a microtask, and D1 has no
 * interactive transaction at all). The batch id is passed in rather than generated, so a
 * caller that needs the id inside its own transaction does not have to guess it.
 */
async function planSerialRows(db, serials, { branchId, batchId, productId, variantId = null, note, actorId }) {
  const rows = [];
  for (const s of serials) {
    const eventNote = note || 'Received on goods receipt';
    const prevHash = await serialHeadHash(db, s.serialNo);
    rows.push({
      id: newId(),
      eventId: newId(),
      serialNo: s.serialNo,
      imei: s.imei || null,
      productId,
      variantId,
      batchId,
      branchId,
      actorId,
      note: eventNote,
      prevHash,
      rowHash: await computeRowHash(prevHash, serialEventFields({ serial_no: s.serialNo, event_type: 'RECEIVED', branch_id: branchId, notes: eventNote })),
    });
  }
  return rows;
}

/** The two statements that put a planned row into the register and start its chain. */
function serialStatements(tx, rows) {
  for (const r of rows) {
    tx.queue(`INSERT INTO serial_numbers (id, product_id, variant_id, serial_no, imei, batch_id, branch_id,
        status, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?, 'IN_STOCK', ?, datetime('now'), datetime('now'))`, [
      r.id, r.productId, r.variantId, r.serialNo, r.imei, r.batchId, r.branchId, r.note,
    ]);
    tx.queue(`INSERT INTO serial_events (id, serial_id, serial_no, event_type, from_status, to_status, branch_id,
        reference_type, reference_id, actor_id, customer_id, notes, prev_hash, row_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`, [
      r.eventId, r.id, r.serialNo, 'RECEIVED', null, 'IN_STOCK', r.branchId,
      r.referenceType || 'GOODS_RECEIVED', r.batchId, r.actorId, null, r.note, r.prevHash, r.rowHash,
    ]);
  }
}

module.exports = { parseSerials, acceptSerials, planSerialRows, serialStatements };
