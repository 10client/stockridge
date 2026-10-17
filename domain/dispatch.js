'use strict';
// =====================================================================
// domain/dispatch.js — HOW WATER AND BREAD LEAVE THE PREMISES
// =====================================================================
// A packaged-water plant and a bakery do not share one kind of vehicle.
// The same business may send a pickup it owns to a depot and a keke the
// rider owns into the streets. The mix is one vehicle type, or two.
// Five types are offered because that is what is actually on the road:
// motorcycle, tricycle, car, pickup, van. A business does not turn all
// five on. An empty fleet of every type is not a setup.
//
// TWO ARRANGEMENTS, and they are not the same money.
//
//   OWNED    the business owns the vehicle. The driver is staff and is
//            paid a wage. A delivered drop does not mint a commission.
//   PARTNER  the driver owns the vehicle. They are paid a share of the
//            sales they carried, and only after the drop is delivered.
//            The share is of the goods, not of the delivery fee: paying
//            a cut of the fee they were hired to earn double-counts it.
//
// Neither arrangement is a fifth stored role. A driver is Staff, with a
// job title. The vehicle class is a fact about the load, not a login.
// =====================================================================

const { round2 } = require('./money');

const VEHICLE_CLASSES = Object.freeze([
  { code: 'BIKE', label: 'Motorcycle', hint: 'Last mile. A bag or two of water, or a small bread round.' },
  { code: 'TRICYCLE', label: 'Tricycle (keke)', hint: 'The neighbourhood run. Several bags, or a morning bread round.' },
  { code: 'CAR', label: 'Car', hint: 'A boot-load for an office, a hotel or a small event.' },
  { code: 'PICKUP', label: 'Pickup', hint: 'Factory gate to a depot. Bags and crates in the bed.' },
  { code: 'VAN', label: 'Van', hint: 'A covered wholesale round. Bottles and bread stay out of the rain.' },
]);

const ARRANGEMENTS = Object.freeze([
  {
    code: 'OWNED',
    label: 'Ours — we pay the driver',
    payBasis: 'WAGE',
    hint: 'The business owns the vehicle. The driver is staff and is paid a wage, not a cut of each drop.',
  },
  {
    code: 'PARTNER',
    label: 'Partner — paid on sales',
    payBasis: 'SALES_SHARE',
    hint: 'The driver owns the vehicle. They are paid a share of the sales they deliver.',
  },
]);

// A partner’s share of the goods they carried. A bike route keeps more of
// a small drop than a van keeps of a depot load. The owner can change it.
// Above 40% is not a share of sales; it is a different business, and it is
// refused so a mistyped 80 does not pay the rider four fifths of the till.
const DEFAULT_SHARE = Object.freeze({
  BIKE: 10,
  TRICYCLE: 8,
  CAR: 8,
  PICKUP: 6,
  VAN: 6,
});

const CLASS_CODES = Object.freeze(VEHICLE_CLASSES.map((v) => v.code));
const ARRANGEMENT_CODES = Object.freeze(ARRANGEMENTS.map((a) => a.code));

function classOf(code) {
  return VEHICLE_CLASSES.find((v) => v.code === String(code || '').toUpperCase()) || null;
}

function arrangementOf(code) {
  return ARRANGEMENTS.find((a) => a.code === String(code || '').toUpperCase()) || null;
}

function defaultShare(vehicleClass) {
  return DEFAULT_SHARE[String(vehicleClass || '').toUpperCase()] || 8;
}

/**
 * Turn a saved or suggested list into one or two modes.
 *
 * `null` means the owner has not confirmed a mix yet. An empty list, a
 * third mode, an unknown vehicle, or the same class and arrangement
 * twice is a refusal — not a silent drop — because a dispatch board that
 * quietly forgets a keke is how a load leaves with nobody to pay.
 */
function normaliseModes(raw) {
  if (raw == null) return { ok: true, modes: null };
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'DISPATCH_MODES', error: 'The dispatch mix has to be a list of one or two vehicle types.' };
  }
  if (raw.length < 1 || raw.length > 2) {
    return {
      ok: false,
      code: 'DISPATCH_MIX',
      error: 'Choose one vehicle type, or a mix of two. A water plant or a bakery does not run every kind of vehicle at once.',
    };
  }
  const modes = [];
  const seen = new Set();
  for (const item of raw) {
    const vehicleClass = String((item && (item.vehicleClass || item.vehicle_class)) || '').toUpperCase();
    const arrangement = String((item && item.arrangement) || '').toUpperCase();
    const vehicle = classOf(vehicleClass);
    const how = arrangementOf(arrangement);
    if (!vehicle) {
      return { ok: false, code: 'UNKNOWN_VEHICLE', error: `“${vehicleClass || 'blank'}” is not a dispatch vehicle. Use ${CLASS_CODES.join(', ')}.` };
    }
    if (!how) {
      return { ok: false, code: 'UNKNOWN_ARRANGEMENT', error: `Say whether the ${vehicle.label.toLowerCase()} is owned, or a partner’s. Use OWNED or PARTNER.` };
    }
    const key = `${vehicle.code}:${how.code}`;
    if (seen.has(key)) {
      return { ok: false, code: 'DISPATCH_DUPLICATE', error: `The ${vehicle.label.toLowerCase()} is already listed as ${how.code === 'OWNED' ? 'owned' : 'a partner vehicle'}.` };
    }
    seen.add(key);
    let salesSharePct = null;
    if (how.code === 'PARTNER') {
      const given = item.salesSharePct != null ? item.salesSharePct : item.sales_share_pct;
      const pct = given == null || given === '' ? defaultShare(vehicle.code) : Number(given);
      if (!Number.isFinite(pct) || pct < 1 || pct > 40) {
        return {
          ok: false,
          code: 'DISPATCH_SHARE',
          error: `A partner’s share of sales has to be between 1% and 40%. ${pct} is not a share a till can pay.`,
        };
      }
      salesSharePct = round2(pct);
    }
    modes.push({
      vehicleClass: vehicle.code,
      arrangement: how.code,
      payBasis: how.payBasis,
      salesSharePct,
    });
  }
  return { ok: true, modes };
}

/** The mix a new plant is offered. The owner still has to confirm it. */
function suggestedModes(profile) {
  const raw = profile && profile.dispatchDefaults;
  const parsed = normaliseModes(raw);
  return parsed.ok ? parsed.modes : null;
}

function summariseModes(modes) {
  if (!Array.isArray(modes) || !modes.length) return null;
  return modes.map((mode) => {
    const vehicle = classOf(mode.vehicleClass);
    const name = vehicle ? vehicle.label.toLowerCase() : String(mode.vehicleClass || '').toLowerCase();
    if (mode.arrangement === 'PARTNER') {
      const pct = mode.salesSharePct != null ? mode.salesSharePct : defaultShare(mode.vehicleClass);
      return `partner ${name}, ${pct}% of the sales they deliver`;
    }
    return `owned ${name}, driver on a wage`;
  }).join('; ');
}

/**
 * What a delivered drop owes the person who carried it.
 *
 * Owned: nothing here. The wage is a salary, recorded as wages, not as a
 * slice of this receipt. Partner: the share of the goods value. The
 * delivery fee is excluded so the rider is not paid a percentage of the
 * fee that already pays for the trip.
 */
function payForDrop({ arrangement, salesSharePct, goodsValue }) {
  const how = arrangementOf(arrangement);
  if (!how || how.code !== 'PARTNER') {
    return { payBasis: 'WAGE', salesSharePct: null, driverPay: 0 };
  }
  const pct = Number(salesSharePct);
  const share = Number.isFinite(pct) ? pct : 0;
  const base = Math.max(0, Number(goodsValue) || 0);
  return {
    payBasis: 'SALES_SHARE',
    salesSharePct: round2(share),
    driverPay: round2(base * share / 100),
  };
}

/** The value the share is calculated on: what the customer paid for the goods, not the trip. */
function goodsValueOf(sale) {
  if (!sale) return 0;
  const total = Number(sale.total);
  const fee = Number(sale.delivery_fee) || 0;
  if (Number.isFinite(total)) return round2(Math.max(0, total - fee));
  const sub = Number(sale.subtotal) || 0;
  const discount = Number(sale.discount_amount) || 0;
  return round2(Math.max(0, sub - discount));
}

function modeMatches(modes, vehicleClass, arrangement) {
  if (!Array.isArray(modes)) return false;
  return modes.some((mode) => mode.vehicleClass === vehicleClass && mode.arrangement === arrangement);
}

module.exports = {
  VEHICLE_CLASSES, ARRANGEMENTS, DEFAULT_SHARE, CLASS_CODES, ARRANGEMENT_CODES,
  classOf, arrangementOf, defaultShare,
  normaliseModes, suggestedModes, summariseModes, payForDrop, goodsValueOf, modeMatches,
};
