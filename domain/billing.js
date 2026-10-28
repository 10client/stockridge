'use strict';
// =====================================================================
// domain/billing.js — BILL, THEN RECEIPT, THEN RELEASE
// =====================================================================
// A bill is not a sale and it is not a receipt.
//
// In a Nigerian warehouse, a building-materials yard, a furniture showroom
// and an electronics plaza, the desk writes a bill, the customer takes it
// to the cashier, and the store does not hand the goods over until a
// receipt exists. The receipt proves the money. A separate release note
// is what the store or the gate keeps, so a receipt cannot be waved at
// the wrong bay and a bill cannot be waved as proof of payment.
//
// A pharmacy counter, a supermarket and a general shop pay and print the
// receipt in one step. Those profiles do not get this flow unless the
// owner turns it on. The flag is deliberately NOT in FEATURE_FLAGS:
// GENERAL_RETAIL spreads every flag on, and a blank shop must not start
// holding stock behind a bill it never asked for.

const { watNow, addDays } = require('./time');

const BILL_FIRST_PROFILES = Object.freeze([
  'WHOLESALE_RETAIL',
  'BUILDING_MATERIALS',
  'FURNITURE',
  'ELECTRONICS',
  // A water plant and a bakery release the load only after the cashier
  // has the money. The feature on the profile is the switch; this list is
  // the same fact for a profile object that has not been spread yet.
  'WATER_PACKING',
  'BAKERY',
]);

const BILL_STATUSES = Object.freeze(['OPEN', 'PAYING', 'PAID', 'CANCELLED', 'EXPIRED']);

/**
 * Does this business print a bill before it will print a receipt?
 *
 * An explicit feature wins, including an owner who turned the default off
 * or a counter shop that turned it on. A profile with no opinion falls
 * back to the businesses that work this way in the market.
 */
function billsFirst(profile) {
  if (!profile) return false;
  const features = profile.features;
  if (features && Object.prototype.hasOwnProperty.call(features, 'billBeforeReceipt')) {
    return Boolean(features.billBeforeReceipt);
  }
  return BILL_FIRST_PROFILES.includes(String(profile.code || ''));
}

/**
 * How long a bill holds the goods.
 *
 * A warehouse bill is a same-day document. Holding a pallet overnight
 * because somebody walked off with the paper is how the yard runs out of
 * the thing it still has on the shelf. A bill raised in the last ninety
 * minutes of the day stays valid until noon tomorrow, so a 11:40pm desk
 * does not print a bill that dies before the customer reaches the cashier.
 *
 * `issuedAt` is West Africa Time, `YYYY-MM-DD HH:MM:SS`.
 */
function holdUntil(issuedAt) {
  const wat = issuedAt ? String(issuedAt) : watNow();
  const day = wat.slice(0, 10);
  const clock = wat.slice(11, 16);
  const parts = clock.split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  const minutesLeft = (Number.isFinite(hh) && Number.isFinite(mm))
    ? (23 - hh) * 60 + (59 - mm)
    : 0;
  if (minutesLeft < 90) {
    const next = addDays(day, 1);
    return `${next || day} 12:00:00`;
  }
  return `${day} 23:59:59`;
}

/** True when a WAT timestamp is already past `validUntil` (same format). */
function holdExpired(validUntil, now) {
  if (!validUntil) return false;
  const clock = now || watNow();
  return String(clock) > String(validUntil);
}

/**
 * A hire or a lease is a booking, not a warehouse bill. Mixing the two
 * on one piece of paper is how a chair goes out as a sale.
 */
function billableLines(lines) {
  const rows = Array.isArray(lines) ? lines : [];
  const blocked = rows.find((line) => {
    const channel = String((line && (line.channel || line.trade)) || 'RETAIL').toUpperCase();
    return channel === 'HIRE' || channel === 'LEASE';
  });
  if (blocked) {
    return {
      ok: false,
      code: 'NOT_A_BILL',
      error: 'A hire or a lease is booked on its own document. Take that line out of this bill — the store releases goods against a receipt, and a booking is not a receipt.',
    };
  }
  if (!rows.length) {
    return { ok: false, code: 'EMPTY_BILL', error: 'A bill needs at least one item.' };
  }
  return { ok: true };
}

/** The name the store calls when the goods are released. */
function customerNameForBill(name) {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 2) {
    return {
      ok: false,
      code: 'BILL_NEEDS_NAME',
      error: 'Put the customer’s name on the bill. The store calls that name when the goods are released, and a bill with no name cannot be matched to the person who paid.',
    };
  }
  if (cleaned.length > 160) {
    return { ok: false, code: 'NAME_TOO_LONG', error: 'That name is too long to print on a bill.' };
  }
  return { ok: true, name: cleaned };
}

/**
 * A payment code the cashier can type.
 *
 * The first four characters are the hour and minute the bill was printed.
 * The last four are mixed from that clock, the bill number, the total, and
 * the shop, so two bills in the same minute do not share a code. This is
 * not a sign-in PIN. It is printed on the bill and thrown away when the
 * bill is paid.
 */
function paymentCode({ issuedAt, billNo, total, branchCode, salt = 0 }) {
  const clock = String(issuedAt || '').replace(/\D/g, '').slice(-6);
  const head = clock.slice(0, 4).padStart(4, '0');
  const soup = `${clock}|${Math.round(Number(total) || 0)}|${billNo || ''}|${branchCode || ''}|${Number(salt) || 0}`;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let n = (Number(salt) || 0) + 17;
  for (let i = 0; i < soup.length; i += 1) n = (n * 33 + soup.charCodeAt(i)) % 2147483647;
  let tail = '';
  for (let i = 0; i < 4; i += 1) {
    n = (n * 33 + soup.charCodeAt(i % soup.length) + i + 1) % 2147483647;
    tail += alphabet[n % alphabet.length];
  }
  return `${head}${tail}`;
}

function payCodeToken(code) {
  return `PAYCODE:${String(code || '').toUpperCase()}`;
}

function codeFromNotes(notes) {
  const match = String(notes || '').match(/PAYCODE:([A-Z0-9]{8})/);
  return match ? match[1] : null;
}

/** A token written onto the sale so a crashed payment can be found again. */
function saleNoteToken(billId) {
  return `[[bill:${String(billId || '').replace(/[^a-zA-Z0-9]/g, '')}]]`;
}

module.exports = {
  BILL_FIRST_PROFILES,
  BILL_STATUSES,
  billsFirst,
  holdUntil,
  holdExpired,
  billableLines,
  customerNameForBill,
  paymentCode,
  payCodeToken,
  codeFromNotes,
  saleNoteToken,
};
