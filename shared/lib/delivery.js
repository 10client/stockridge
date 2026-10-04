// =====================================================================
// shared/lib/delivery.js — DELIVERY, INSTALLATION AND ASSEMBLY JOBS
// =====================================================================
//
// NEW TO STOCKRIDGE. For a pharmacy, delivery is an afterthought. For a
// furniture shop, an appliance dealer or a building-materials yard it IS THE
// PRODUCT: nobody carries a wardrobe, a fridge or 200 bags of cement home on a
// motorbike. A retailer that cannot schedule, dispatch, track and settle a
// delivery is a retailer whose customers buy from the shop that can.
//
// THE STOCK QUESTION, answered once and enforced everywhere:
//   When does a delivered item leave stock?
//
//   On DISPATCH, not on delivery. The moment the item is loaded onto a truck it
//   is no longer sellable from the branch, and if the POS can still sell it the
//   shop will sell the same fridge twice. So:
//     sale completed -> stock decremented (as normal)
//     delivery job created -> the item is RESERVED against the job
//     job dispatched -> reservation released, movement type DELIVERY_DISPATCH
//     job delivered -> nothing further to stock; signature/photo captured
//     job failed -> the item returns to sellable stock (movement SALE_RETURN)
//
// DELIVERY FEES are a ZONE table, not a flat guess. Nigerian cities price
// delivery by distance and by difficulty: Ikeja to Lekki is a different job
// from Ikeja to Agege, and a third-floor walk-up with no lift is a different
// job from a ground-floor shop. The zone table is client data, keyed by area
// name, with a base fee, a per-km rate and a bulky surcharge.
//
// PROOF OF DELIVERY is not optional. A signature, a phone number, and where
// possible a photo and a GPS stamp. "The customer says it never arrived" is
// unanswerable without it, and answerable in one screen with it.

'use strict';

const { round2, toKobo, fromKobo, allocateKobo } = require('./money');

const JOB_TYPES = Object.freeze(['DELIVERY', 'INSTALLATION', 'DELIVERY_AND_INSTALLATION', 'ASSEMBLY', 'PICKUP', 'RETURN_COLLECTION']);
const JOB_STATUSES = Object.freeze([
  'SCHEDULED',     // booked, a slot assigned
  'CONFIRMED',     // customer confirmed the slot
  'DISPATCHED',    // left the branch
  'IN_TRANSIT',    // en route (driver updated)
  'DELIVERED',     // completed successfully with proof
  'PARTIALLY_DELIVERED', // some items delivered, some short
  'FAILED',        // attempt made, not completed
  'CANCELLED',
  'RESCHEDULED',
]);
const FAILURE_REASONS = Object.freeze([
  'CUSTOMER_NOT_AVAILABLE', 'WRONG_ADDRESS', 'ACCESS_DIFFICULT', 'PAYMENT_NOT_CLEARED',
  'VEHICLE_BREAKDOWN', 'ITEM_DAMAGED_IN_TRANSIT', 'CUSTOMER_REFUSED', 'SECURITY_CHECKPOINT',
  'WEATHER', 'OTHER',
]);
const VEHICLE_TYPES = Object.freeze(['BIKE', 'CAR', 'VAN', 'TRUCK_3T', 'TRUCK_7T', 'TIPPER', 'FLATBED', 'HIAB_CRANE', 'CUSTOMER_OWN']);

const BULKY_SURCHARGE_UNITS = Object.freeze(new Set(['SET', 'CARTON', 'BAG', 'BOX', 'ROLL', 'BUNDLE', 'LENGTH', 'SHEET', 'BALE']));

/**
 * Delivery fee from a zone table + the items on the job.
 *
 *   fee = zone.base + (zone.perKm x km) + bulky surcharge + floors surcharge
 *         + installation labour
 *
 * Every component is returned separately and labelled, because "₦25,000
 * delivery" with no breakdown is the single most-argued line on a furniture
 * invoice. Showing "Lekki Phase 1 base ₦8,000 + 14 km @ ₦300 = ₦4,200 +
 * bulky (3 items) ₦6,000 + 3rd floor no lift ₦4,500 + installation ₦2,500"
 * ends the argument before it starts.
 */
function quoteDelivery({ zone, distanceKm = 0, items = [], floors = 0, hasLift = true, installationRequired = false, installationLabour = 0, discountKobo = 0 }) {
  const components = [];
  const z = zone || {};

  const baseFee = Number(z.base_fee || 0);
  if (baseFee > 0) components.push({ code: 'ZONE_BASE', label: `${z.name || 'Delivery'} base fee`, kobo: baseFee, amount: baseFee });

  const km = Math.max(0, Number(distanceKm) || 0);
  const perKmFee = Number(z.per_km_fee || 0);
  const kmFee = Math.round(perKmFee * km);
  if (kmFee > 0) components.push({ code: 'DISTANCE', label: `${round2(km)} km @ ${perKmFee}/km`, kobo: kmFee, amount: kmFee });

  // Bulky surcharge: per bulky item, capped so a 200-bag cement order is not
  // quoted an absurd delivery fee (those jobs are priced as a trip, not per
  // bag). The cap is zone data.
  let bulkyCount = 0;
  for (const it of items || []) {
    const unit = String(it.base_unit || '').toUpperCase();
    const isBulky = it.is_bulky != null ? !!it.is_bulky : BULKY_SURCHARGE_UNITS.has(unit);
    if (isBulky) bulkyCount += Math.max(1, Math.floor(Number(it.quantity) || 1));
  }
  const perBulkyFee = Number(z.bulky_surcharge || 0);
  const bulkyCap = z.bulky_surcharge_cap != null ? Number(z.bulky_surcharge_cap) : null;
  let bulkyFee = perBulkyFee * bulkyCount;
  if (bulkyCap != null && bulkyFee > bulkyCap) bulkyFee = bulkyCap;
  if (bulkyFee > 0) components.push({ code: 'BULKY', label: `Bulky handling (${bulkyCount} item${bulkyCount === 1 ? '' : 's'})`, kobo: bulkyFee, amount: bulkyFee });

  // Stairs. A fridge up three flights with no lift is two extra men and forty
  // minutes. This is real cost and shops that do not charge it lose money on
  // every Lagos island delivery.
  const fl = Math.max(0, Math.floor(Number(floors) || 0));
  if (fl > 0 && !hasLift) {
    const perFloorFee = Number(z.floor_surcharge || 0);
    const floorFee = perFloorFee * fl;
    if (floorFee > 0) components.push({ code: 'FLOORS', label: `${fl} floor${fl === 1 ? '' : 's'}, no lift`, kobo: floorFee, amount: floorFee });
  }

  if (installationRequired) {
    const labFee = Number(installationLabour || z.installation_fee || 0);
    if (labFee > 0) components.push({ code: 'INSTALLATION', label: 'Installation / assembly', kobo: labFee, amount: labFee });
  }

  const grossFee = components.reduce((a, c) => a + c.amount, 0);
  const discFee = Math.min(grossFee, Math.max(0, fromKobo(discountKobo) || Number(discountKobo) || 0));
  const netFee = grossFee - discFee;

  return {
    components,
    bulkyCount,
    distanceKm: round2(km),
    zoneCode: z.code || null,
    zoneName: z.name || null,
    grossKobo: toKobo(grossFee), gross: round2(grossFee),
    discountKobo: toKobo(discFee), discount: round2(discFee),
    feeKobo: toKobo(netFee), fee: round2(netFee),
  };
}

/**
 * A delivery job with its stock effects spelled out. PURE.
 */
function buildJob({ saleId, branchId, customerId, jobType, items, slot, address, driver, fee, notes, vehicle }) {
  const type = String(jobType || 'DELIVERY').toUpperCase();
  if (!JOB_TYPES.includes(type)) {
    return { ok: false, code: 'INVALID_JOB_TYPE', error: `Job type must be one of: ${JOB_TYPES.join(', ')}` };
  }
  if (!branchId) return { ok: false, code: 'JOB_NEEDS_BRANCH', error: 'A delivery job must belong to a branch.' };
  if (!customerId) return { ok: false, code: 'JOB_NEEDS_CUSTOMER', error: 'A delivery job needs a customer — an anonymous walk-in cannot be delivered to.' };
  if (!address || !String(address).trim()) return { ok: false, code: 'JOB_NEEDS_ADDRESS', error: 'Enter the delivery address.' };
  if (!slot || !slot.date) return { ok: false, code: 'JOB_NEEDS_SLOT', error: 'Choose a delivery date and window.' };
  if (!items || !items.length) return { ok: false, code: 'JOB_NEEDS_ITEMS', error: 'A delivery job needs at least one item.' };

  const needsDispatch = ['DELIVERY', 'DELIVERY_AND_INSTALLATION', 'PICKUP', 'RETURN_COLLECTION'].includes(type);

  return {
    ok: true,
    job: {
      sale_id: saleId || null,
      branch_id: branchId,
      customer_id: customerId,
      job_type: type,
      status: 'SCHEDULED',
      scheduled_date: String(slot.date).slice(0, 10),
      window_start: slot.window_start || null,
      window_end: slot.window_end || null,
      address: String(address).trim().slice(0, 500),
      area: slot.area || null,
      lga: slot.lga || null,
      state: slot.state || null,
      landmark: slot.landmark || null,
      contact_name: slot.contact_name || null,
      contact_phone: slot.contact_phone || null,
      driver_id: driver ? driver.id : null,
      driver_name: driver ? driver.name : null,
      vehicle_type: vehicle ? String(vehicle).toUpperCase() : null,
      vehicle_registration: slot.vehicle_registration || null,
      fee_kobo: toKobo(fee || 0),
      fee: fromKobo(toKobo(fee || 0)),
      fee_collected: false,
      notes: notes ? String(notes).slice(0, 1000) : null,
      items: items.map((i) => ({
        product_id: i.product_id,
        product_name: i.product_name || null,
        serial_number: i.serial_number || null,
        quantity: Math.max(1, Math.floor(Number(i.quantity) || 1)),
        stock_batch_id: i.stock_batch_id || null,
      })),
    },
    stockEffect: {
      reservesOnCreate: needsDispatch,
      movementOnDispatch: needsDispatch ? 'DELIVERY_DISPATCH' : null,
      movementOnFailure: needsDispatch ? 'SALE_RETURN' : null,
    },
  };
}

/**
 * Slot capacity. A branch has a finite number of trucks and drivers; letting a
 * cashier book 40 deliveries for Saturday is how a shop breaks a promise it
 * cannot keep. Capacity is per (branch, date, window) and is client data.
 */
function slotCapacity({ booked, capacity }) {
  const cap = Math.max(0, Math.floor(Number(capacity) || 0));
  const used = Math.max(0, Math.floor(Number(booked) || 0));
  return {
    capacity: cap,
    booked: used,
    remaining: Math.max(0, cap - used),
    isFull: cap > 0 && used >= cap,
    message: cap === 0 ? 'No capacity set for this window — deliveries are unlimited (or unset).'
      : used >= cap ? 'This window is full. Choose another, or a manager can overbook.'
        : `${cap - used} of ${cap} slot(s) left.`,
  };
}

/**
 * Record a delivery attempt. A FAILED attempt is a business event with money
 * attached: the truck went out, the fuel was burned, the driver was paid.
 * Charging a re-delivery fee is standard practice and this is where the client
 * decides whether to apply it.
 */
function recordAttempt({ job, success, reason, redeliveryFeeKobo = 0, chargeRedelivery = false, proof }) {
  if (success) {
    const p = proof || {};
    if (!p.receiver_name && !p.signature_captured && !p.photo_captured) {
      return {
        ok: false, code: 'PROOF_REQUIRED',
        error: 'Capture proof of delivery: a receiver name, a signature, or a photo. Without it the delivery cannot be evidenced if disputed.',
      };
    }
    return {
      ok: true,
      status: job.partiallyDelivered ? 'PARTIALLY_DELIVERED' : 'DELIVERED',
      proof: {
        receiver_name: p.receiver_name || null,
        receiver_phone: p.receiver_phone || null,
        signature_captured: !!p.signature_captured,
        photo_captured: !!p.photo_captured,
        gps_latitude: p.gps_latitude != null ? Number(p.gps_latitude) : null,
        gps_longitude: p.gps_longitude != null ? Number(p.gps_longitude) : null,
        delivered_at: new Date().toISOString(),
        notes: p.notes || null,
      },
      stockEffect: null,
    };
  }

  const rsn = String(reason || '').toUpperCase();
  if (!FAILURE_REASONS.includes(rsn)) {
    return { ok: false, code: 'INVALID_FAILURE_REASON', error: `Choose a failure reason: ${FAILURE_REASONS.join(', ')}` };
  }
  const chargeable = ['CUSTOMER_NOT_AVAILABLE', 'WRONG_ADDRESS', 'CUSTOMER_REFUSED', 'ACCESS_DIFFICULT'].includes(rsn);
  const feeK = (chargeRedelivery && chargeable) ? toKobo(redeliveryFeeKobo || 0) : 0;
  return {
    ok: true,
    status: 'FAILED',
    failure_reason: rsn,
    // The goods come back: reservation released, stock becomes sellable again.
    stockEffect: { type: 'SALE_RETURN', direction: 1, restock: true, note: `Delivery failed: ${rsn}` },
    redelivery_fee_kobo: feeK,
    redelivery_fee: fromKobo(feeK),
    redelivery_charged: feeK > 0,
    chargeable,
    note: feeK > 0
      ? 'Add the re-delivery fee to the customer account or collect it on the next attempt.'
      : 'No re-delivery fee — this attempt failed for a reason that is not the customer\'s fault.',
  };
}

/**
 * Dispatch a job: this is the moment stock physically leaves.
 * Guards the two mistakes that cost real money:
 *   * dispatching a job whose sale is not paid (goods leave, money never comes)
 *   * dispatching without a driver/vehicle (an untraceable trip)
 */
function dispatch({ job, sale, requirePaymentBeforeDispatch = true, driverId, vehicleRegistration }) {
  if (!driverId) return { ok: false, code: 'DRIVER_REQUIRED', error: 'Assign a driver before dispatch — an unassigned trip cannot be tracked.' };
  if (requirePaymentBeforeDispatch && sale && !sale.paid_in_full) {
    const balNum = fromKobo(toKobo(sale.balance_due || 0));
    const balStr = balNum.toLocaleString('en-NG');
    return {
      ok: false, code: 'UNPAID_BEFORE_DISPATCH',
      error: `This sale still has ${balStr} outstanding. Take payment, or a manager must authorise dispatch on credit.`,
    };
  }
  return {
    ok: true,
    status: 'DISPATCHED',
    dispatched_at: new Date().toISOString(),
    driver_id: driverId,
    vehicle_registration: vehicleRegistration || job.vehicle_registration || null,
    stockEffect: { type: 'DELIVERY_DISPATCH', direction: -1, releaseReservation: true },
  };
}

/** Driver performance over a period — the report a logistics manager needs. */
function driverScorecard(jobs) {
  const list = jobs || [];
  const delivered = list.filter((j) => ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(j.status));
  const failed = list.filter((j) => j.status === 'FAILED');
  const onTime = delivered.filter((j) => j.on_time);
  return {
    total: list.length,
    delivered: delivered.length,
    failed: failed.length,
    cancelled: list.filter((j) => j.status === 'CANCELLED').length,
    successRate: list.length ? round2((delivered.length / list.length) * 100) : 0,
    onTimeRate: delivered.length ? round2((onTime.length / delivered.length) * 100) : 0,
    failureReasons: FAILURE_REASONS.map((r) => ({
      reason: r,
      count: failed.filter((j) => j.failure_reason === r).length,
    })).filter((r) => r.count > 0).sort((a, b) => b.count - a.count),
  };
}

module.exports = {
  JOB_TYPES, JOB_STATUSES, FAILURE_REASONS, VEHICLE_TYPES, BULKY_SURCHARGE_UNITS,
  quoteDelivery, buildJob, slotCapacity, recordAttempt, dispatch, driverScorecard,
  allocateKobo,
};
