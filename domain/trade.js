'use strict';
// =====================================================================
// domain/trade.js — HOW A LINE OF BUSINESS ACTUALLY MOVES
// =====================================================================
// Retail, wholesale, hire and lease are not labels on the same sale.
//
//   RETAIL     the unit leaves. The customer pays the shelf price, usually now.
//   WHOLESALE  the unit leaves, in the bulk unit, often on terms. The price
//              is the trade price, not the shelf price.
//   HIRE       the unit stays ours. It is promised for a span of days — a
//              Saturday wedding, a weekend canopy — and it comes back.
//              The fee is income. The deposit is not: it is the customer's
//              money, held until the goods are back and checked.
//   LEASE      the unit stays ours for months. Rent falls due on a schedule.
//              At the end it comes back, or the customer buys it, and only
//              the buyout is a sale.
//
// A shop can do more than one. An event yard hires chairs, sells balloons
// and invoices a planner for cartons of drinks, on one job. Each line follows
// its own rule. Mixing them on the header and hoping is how a chair is sold
// out from under a booking, or a deposit is booked as profit.
// =====================================================================

const MODES = Object.freeze(['RETAIL', 'WHOLESALE', 'HIRE', 'LEASE']);
const HOLD_MODES = Object.freeze(['HIRE', 'LEASE']);
const FOREVER = '9999-12-31';

const MODE_LABEL = Object.freeze({
  RETAIL: 'Retail sale',
  WHOLESALE: 'Wholesale sale',
  HIRE: 'Hire',
  LEASE: 'Lease',
});

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function isMode(value) {
  return MODES.includes(String(value || '').toUpperCase());
}

/** A profile's modes, or an owner's explicit set. Unknown names are dropped. */
function normaliseModes(list, fallback) {
  const source = Array.isArray(list) && list.length ? list : (fallback || ['RETAIL']);
  const out = [];
  for (const raw of source) {
    const code = String(raw || '').toUpperCase();
    if (MODES.includes(code) && !out.includes(code)) out.push(code);
  }
  return out.length ? out : ['RETAIL'];
}

function modesOf(profile) {
  return normaliseModes(profile && profile.tradeModes, ['RETAIL']);
}

/**
 * The line's arrangement.
 *
 * An explicit channel wins. Otherwise a wholesale header is wholesale, and
 * everything else is a retail sale — which is what every sale was before
 * hire and lease existed, so an old till keeps working.
 */
function channelOf(line, saleType) {
  const explicit = line && (line.channel || line.trade);
  if (explicit && isMode(explicit)) return String(explicit).toUpperCase();
  return String(saleType || '').toUpperCase() === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL';
}

function holdsStock(channel) {
  return HOLD_MODES.includes(String(channel || '').toUpperCase());
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function daysInclusive(start, end) {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

function addMonths(iso, months) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1 + Number(months), 1));
  const last = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  const end = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), day));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function addMonthsForward(iso, months) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1 + Number(months), 1));
  const last = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), day)).toISOString().slice(0, 10);
}

/**
 * The window a hire or a lease occupies, inclusive.
 * A Saturday-only hire is one day. A Friday setup returned Sunday is three.
 * A lease of N months ends the day before the same date N months on.
 */
function windowFor(line, { today }) {
  const channel = channelOf(line);
  if (channel === 'HIRE') {
    const start = String(line.starts_on || line.startsOn || '');
    const end = String(line.ends_on || line.endsOn || '');
    if (!isDate(start) || !isDate(end)) {
      return { ok: false, code: 'HIRE_DATES_REQUIRED', error: 'A hire needs the day it goes out and the day it comes back.' };
    }
    if (end < start) return { ok: false, code: 'HIRE_DATES_REVERSED', error: 'The return day is before the day it goes out.' };
    if (today && start < today) return { ok: false, code: 'HIRE_IN_THE_PAST', error: 'A hire cannot start on a day that has already passed.' };
    const days = daysInclusive(start, end);
    if (days > 90) return { ok: false, code: 'HIRE_TOO_LONG', error: 'A hire is at most 90 days. A longer commitment is a lease, not a weekend booking.' };
    return { ok: true, channel, start, end, periods: days, periodUnit: 'DAY' };
  }
  if (channel === 'LEASE') {
    const start = String(line.starts_on || line.startsOn || '');
    const months = Number(line.months || line.periods);
    if (!isDate(start)) return { ok: false, code: 'LEASE_START_REQUIRED', error: 'A lease needs the day it starts.' };
    if (today && start < today) return { ok: false, code: 'LEASE_IN_THE_PAST', error: 'A lease cannot start on a day that has already passed.' };
    if (!Number.isInteger(months) || months < 1) return { ok: false, code: 'LEASE_TERM_REQUIRED', error: 'A lease is counted in whole months, at least one.' };
    if (months > 60) return { ok: false, code: 'LEASE_TOO_LONG', error: 'A lease is at most 60 months. Record a longer one as a new term when this one ends.' };
    return { ok: true, channel, start, end: addMonths(start, months), periods: months, periodUnit: 'MONTH' };
  }
  return { ok: true, channel, start: null, end: null, periods: 1, periodUnit: null };
}

function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * The most units promised at the same time inside a window.
 * Two bookings of 200 chairs on different Saturdays share the fleet.
 * Two bookings of 200 on the same Saturday need 400.
 */
function peakInWindow(intervals, start, end) {
  const window = { start, end };
  const events = [];
  for (const row of intervals || []) {
    if (!row || !overlaps(row, window)) continue;
    const from = row.start > start ? row.start : start;
    const to = row.end < end ? row.end : end;
    const qty = Number(row.quantity) || 0;
    if (qty <= 0) continue;
    events.push({ day: from, qty });
    events.push({ day: to, qty: -qty, end: true });
  }
  events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.end === b.end ? 0 : a.end ? 1 : -1)));
  let running = 0;
  let peak = 0;
  for (const ev of events) {
    running = round2(running + ev.qty);
    if (running > peak) peak = running;
  }
  return peak;
}

function fleetFree({ onHand, reserved, intervals, start, end }) {
  const held = peakInWindow(intervals, start, end);
  return round2(Math.max(0, Number(onHand) - Number(reserved || 0) - held));
}

/**
 * Whether this business may ring this arrangement, and whether this product
 * is offered that way.
 *
 * A buyout is a sale of an asset that is already out on lease. It does not
 * require the shop to run a retail counter. A continuation payment is rent
 * on a lease that is already out; it does not take a second unit.
 */
function assertArrangement({ channel, modes, product, buyout = false, continuation = false }) {
  const code = String(channel || '').toUpperCase();
  if (!isMode(code)) return { ok: false, code: 'UNKNOWN_TRADE', error: `“${channel}” is not a way this system trades. Use retail, wholesale, hire or lease.` };
  const allowed = normaliseModes(modes, ['RETAIL', 'WHOLESALE']);
  if (!buyout && !continuation && !allowed.includes(code)) {
    return {
      ok: false,
      code: 'TRADE_NOT_OFFERED',
      error: `This business does not ${code === 'HIRE' ? 'hire goods out' : code === 'LEASE' ? 'lease goods' : code === 'WHOLESALE' ? 'sell wholesale' : 'sell retail'}. Turn that on for the business, or ring the line the way the business actually trades.`,
    };
  }
  if (continuation || buyout) return { ok: true, channel: code };
  const sale = product && product.offers_sale != null ? Number(product.offers_sale) : 1;
  const hire = product && Number(product.offers_hire) ? 1 : 0;
  const lease = product && Number(product.offers_lease) ? 1 : 0;
  const offered = (code === 'HIRE' && hire) || (code === 'LEASE' && lease) || ((code === 'RETAIL' || code === 'WHOLESALE') && sale);
  if (!offered) {
    const name = product && product.name ? product.name : 'That product';
    return {
      ok: false,
      code: 'PRODUCT_NOT_OFFERED_THAT_WAY',
      error: code === 'HIRE'
        ? `${name} is not for hire. Turn hire on for it, and set the daily rate, before booking it out.`
        : code === 'LEASE'
          ? `${name} is not for lease. Turn lease on for it, and set the monthly rent, before writing a term.`
          : `${name} is not sold. It is held for hire or lease only.`,
    };
  }
  return { ok: true, channel: code };
}

function catalogueRate(product, channel) {
  if (channel === 'HIRE') return Number(product && product.hire_price_per_day) || 0;
  if (channel === 'LEASE') return Number(product && product.lease_price_per_month) || 0;
  return Number(product && product.selling_price) || 0;
}

function catalogueDeposit(product, channel, quantity) {
  const each = channel === 'LEASE'
    ? (Number(product && product.lease_deposit) || Number(product && product.hire_deposit) || 0)
    : (Number(product && product.hire_deposit) || 0);
  return round2(each * Number(quantity || 0));
}

/**
 * What the opening receipt charges.
 * Hire: the whole window, now.
 * Lease: the first month, unless the customer is paying the term up front.
 * The deposit is not in this figure.
 */
function openingFee({ channel, rate, quantity, periods, collect }) {
  const qty = Number(quantity) || 0;
  const per = Number(rate) || 0;
  const span = Number(periods) || 0;
  if (channel === 'LEASE' && String(collect || 'FIRST').toUpperCase() !== 'TERM') {
    return round2(per * qty);
  }
  return round2(per * qty * span);
}

function revenueAccount(channel) {
  return { RETAIL: '4000', WHOLESALE: '4010', HIRE: '4020', LEASE: '4030' }[String(channel || 'RETAIL').toUpperCase()] || '4000';
}

function describeMix(channels) {
  const found = [];
  for (const raw of channels || []) {
    const code = String(raw || '').toUpperCase();
    if (isMode(code) && !found.includes(code)) found.push(code);
  }
  return found.join('+') || 'RETAIL';
}

/**
 * Split a sale's net revenue across the accounts the lines actually earned,
 * and across the categories those lines belong to.
 *
 * A receipt that sells rice and ankara is two credits, not one: provisions
 * and fabrics are different takings. A receipt that also leases a freezer
 * is a third credit, on the lease account. The last slice absorbs the kobo,
 * so the credits still equal the net.
 */
function splitRevenue(lines, saleType, netRevenue) {
  const buckets = new Map();
  for (const line of lines || []) {
    const channel = channelOf(line, saleType);
    const categoryId = line.categoryId || line.category_id || (line.product && line.product.category_id) || null;
    const categoryName = line.categoryName || line.category_name
      || (line.product && (line.product.category_name || line.product.categoryName))
      || null;
    const key = `${channel}|${categoryId || ''}`;
    const prev = buckets.get(key) || { channel, categoryId: categoryId || null, categoryName, weight: 0 };
    prev.weight = round2(prev.weight + Number(line.lineTotal || line.line_total || 0));
    if (!prev.categoryName && categoryName) prev.categoryName = categoryName;
    buckets.set(key, prev);
  }
  const gross = round2([...buckets.values()].reduce((a, b) => a + b.weight, 0));
  const net = round2(Math.max(0, Number(netRevenue) || 0));
  if (net <= 0) return [];
  if (gross <= 0) {
    const channel = String(saleType || '').toUpperCase() === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL';
    return [{ channel, categoryId: null, categoryName: null, accountCode: revenueAccount(channel), amount: net }];
  }
  const keys = [...buckets.values()].filter((bucket) => bucket.weight > 0);
  const parts = [];
  let assigned = 0;
  keys.forEach((bucket, i) => {
    const amount = i === keys.length - 1 ? round2(net - assigned) : round2(net * (bucket.weight / gross));
    assigned = round2(assigned + amount);
    if (amount > 0) {
      parts.push({
        channel: bucket.channel,
        categoryId: bucket.categoryId,
        categoryName: bucket.categoryName,
        accountCode: revenueAccount(bucket.channel),
        amount,
      });
    }
  });
  return parts;
}

function methodAccount(method) {
  return {
    CASH: '1000', POS_TERMINAL: '1030', BANK_TRANSFER: '1020', MOBILE_MONEY: '1040',
    USSD: '1040', CHEQUE: '1020', OTHER: '1020',
  }[String(method || 'CASH').toUpperCase()] || '1020';
}

function lateDays(endsOn, returnedOn) {
  if (!isDate(endsOn) || !isDate(returnedOn) || returnedOn <= endsOn) return 0;
  return daysInclusive(endsOn, returnedOn) - 1;
}

module.exports = {
  MODES, HOLD_MODES, FOREVER, MODE_LABEL,
  isMode, normaliseModes, modesOf, channelOf, holdsStock,
  isDate, daysInclusive, addMonths, addMonthsForward, windowFor,
  overlaps, peakInWindow, fleetFree,
  assertArrangement, catalogueRate, catalogueDeposit, openingFee,
  revenueAccount, describeMix, splitRevenue, methodAccount, lateDays,
};
