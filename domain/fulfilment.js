// =====================================================================
// StockRidge — FULFILMENT (delivery zones, dispatch, installation)
// =====================================================================
// FOR A FURNITURE OR APPLIANCE BUSINESS, DELIVERY IS PART OF THE PRODUCT.
//
// Nobody carries a 7-seater sofa or a side-by-side refrigerator home on a
// motorbike. The shop that cannot promise a delivery date does not close
// the sale, and the shop that promises one and misses it has just paid for
// a truck, upset a customer, and possibly damaged the goods on a second
// attempt. So delivery is modelled as a first-class JOB with its own
// lifecycle, its own cost, and its own accountability — not as a note on
// the receipt.
//
// ---------------------------------------------------------------------
// THE TWO COST MODELS
// ---------------------------------------------------------------------
// ZONE_FLAT       A flat fee per delivery zone. This is how Nigerian
//                 furniture and appliance retail actually prices delivery:
//                 "₦15,000 within Ikeja, ₦25,000 to the Mainland, ₦40,000
//                 outside Lagos". Simple to quote at the counter, simple to
//                 reconcile, and the customer understands it.
// TRIP_DISTANCE   Priced by the trip: a base call-out plus a per-km rate,
//                 plus a per-tonne load factor. This is how building
//                 materials move — a truck of cement to a site in Ibadan is
//                 priced on the journey, not on a zone the depot has never
//                 drawn.
//
// Both are here because both are real. The active profile picks one; the
// owner can enable the other per branch (a materials depot that also runs a
// showroom genuinely needs both).
//
// ---------------------------------------------------------------------
// WHO DOES THE WORK
// ---------------------------------------------------------------------
// Three possibilities, each with a different accounting consequence:
//   OWN_FLEET   The shop's truck and driver. Cost = fuel + driver time +
//               depreciation. It is an EXPENSE, and it must be posted as
//               one, or "free delivery" quietly eats the margin on every
//               large item and the P&L says deliveries cost nothing.
//   THIRD_PARTY A haulier. Cost = their invoice, and WHT at 2% may apply
//               (LOGISTICS_HAULAGE in the tax schedule).
//   CUSTOMER_ARRANGES  They send their own truck. Cost = 0 to us, and the
//               risk of damage in transit passes to them at handover — which
//               is why the status must record WHO took possession.
// =====================================================================

const { round2 } = require('./money');

const JOB_TYPES = Object.freeze(['DELIVERY', 'INSTALLATION', 'DELIVERY_AND_INSTALLATION', 'PICKUP', 'SITE_SURVEY', 'REPAIR_VISIT']);

const JOB_STATUSES = Object.freeze([
  'PENDING',            // booked, not yet assigned
  'ASSIGNED',           // a driver/technician and a vehicle are named
  'SCHEDULED',          // a date and time window is confirmed with the customer
  'IN_TRANSIT',         // left the branch
  'ARRIVED',            // at the customer's address
  'DELIVERED',          // goods handed over and signed for
  'INSTALLING',         // on-site installation in progress
  'INSTALLED',          // commissioned and accepted
  'PARTIALLY_DELIVERED',// some items handed over, the rest to follow
  'FAILED',             // attempted but not completed — the important one
  'CANCELLED',
  'RETURNED_TO_BRANCH', // goods came back
]);

// A FAILED job is the most valuable row in this table and the one most
// systems drop. Every failure needs a reason because the reasons cluster:
// "customer not available" is a scheduling problem, "access road impassable"
// is a routing problem, "goods damaged in transit" is a packing problem, and
// "customer refused on sight" is a sales problem. Aggregating them tells the
// owner which one to fix.
const FAILURE_REASONS = Object.freeze([
  { code: 'CUSTOMER_UNAVAILABLE', label: 'Customer not available at the address', owner: 'Scheduling' },
  { code: 'WRONG_ADDRESS', label: 'Address incorrect or not found', owner: 'Scheduling' },
  { code: 'ACCESS_IMPASSABLE', label: 'Vehicle could not reach the site', owner: 'Routing' },
  { code: 'GOODS_DAMAGED_IN_TRANSIT', label: 'Goods damaged on the way', owner: 'Packing / handling' },
  { code: 'CUSTOMER_REFUSED', label: 'Customer refused delivery on sight', owner: 'Sales' },
  { code: 'PAYMENT_NOT_CLEARED', label: 'Balance not paid before dispatch', owner: 'Credit control' },
  { code: 'VEHICLE_BREAKDOWN', label: 'Vehicle breakdown', owner: 'Fleet' },
  { code: 'INSUFFICIENT_LOAD_SPACE', label: 'Item did not fit the vehicle sent', owner: 'Dispatch' },
  { code: 'SITE_NOT_READY', label: 'Site not ready for installation', owner: 'Scheduling' },
  { code: 'OTHER', label: 'Other (record in notes)', owner: 'Other' },
]);

const FULFILMENT_PROVIDERS = Object.freeze(['OWN_FLEET', 'THIRD_PARTY', 'CUSTOMER_ARRANGES']);

// Proof of delivery. A signature, a photo, or both. This is what wins the
// argument six weeks later when a customer says the refrigerator arrived
// dented — and it is why the field is REQUIRED on a DELIVERED transition
// rather than optional, because an optional field is an empty field.
const POD_REQUIREMENTS = Object.freeze(['SIGNATURE', 'PHOTO', 'RECIPIENT_NAME', 'RECIPIENT_PHONE']);

// ---------------------------------------------------------------------
// DELIVERY ZONES (ZONE_FLAT model)
// ---------------------------------------------------------------------
// A zone is a named area with a flat fee and an estimated transit time.
// Zones are per-BRANCH because the branch in Ikeja and the branch in Kano
// have completely different geographies, and because the fee has to reflect
// what it actually costs THAT branch to make the trip.
function quoteZoneFlat({ zone, itemCount = 1, heavyItemSurcharge = 0, outsideZone = false, distanceKm = null }) {
  if (!zone) {
    return { ok: false, code: 'NO_ZONE', error: 'No delivery zone matched this address. Add the zone or price it as an out-of-zone trip.' };
  }
  const base = round2(Number(zone.fee) || 0);
  const extraItems = Math.max(0, Number(itemCount) - 1);
  const perExtra = round2(Number(zone.additional_item_fee) || 0);
  const heavy = round2(Number(heavyItemSurcharge) || 0);

  // Out-of-zone: a per-km rate applied beyond the zone boundary. Kept as an
  // explicit flag rather than inferred, because "outside Ikeja" is a
  // judgement the dispatcher makes, not something the app can compute from
  // a free-text address.
  const outOfZoneFee = outsideZone && Number.isFinite(Number(distanceKm))
    ? round2(Math.max(0, Number(distanceKm)) * round2(Number(zone.out_of_zone_rate_per_km) || 0))
    : 0;

  const total = round2(base + extraItems * perExtra + heavy + outOfZoneFee);

  return {
    ok: true,
    model: 'ZONE_FLAT',
    zone_code: zone.code,
    zone_label: zone.label,
    base_fee: base,
    additional_items: extraItems,
    additional_item_fee: round2(extraItems * perExtra),
    heavy_item_surcharge: heavy,
    out_of_zone_fee: outOfZoneFee,
    total,
    estimated_transit_hours: zone.estimated_transit_hours || null,
    breakdown: [
      { label: `Base fee — ${zone.label}`, amount: base },
      extraItems > 0 ? { label: `${extraItems} additional item(s) @ ₦${perExtra.toLocaleString('en-NG')}`, amount: round2(extraItems * perExtra) } : null,
      heavy > 0 ? { label: 'Heavy / bulky item surcharge', amount: heavy } : null,
      outOfZoneFee > 0 ? { label: `Out-of-zone (${Math.round(Number(distanceKm))} km)`, amount: outOfZoneFee } : null,
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------------
// TRIP PRICING (TRIP_DISTANCE model)
// ---------------------------------------------------------------------
// A base call-out, a per-km rate, and a load factor. The load factor exists
// because a truck carrying 200 bags of cement and one carrying 20 cost the
// same in fuel per kilometre but not in wear, in permits, or in the risk of
// the trip — and a materials depot that prices only on distance loses money
// on every heavy load.
function quoteTrip({ baseCallOut = 0, ratePerKm = 0, distanceKm = 0, loadTonnes = 0, ratePerTonneKm = 0, waitingHours = 0, ratePerWaitingHour = 0 }) {
  const base = round2(baseCallOut);
  const km = Math.max(0, Number(distanceKm) || 0);
  const perKm = round2(ratePerKm);
  const tonnes = Math.max(0, Number(loadTonnes) || 0);
  const perTonneKm = round2(ratePerTonneKm);

  const distanceFee = round2(km * perKm);
  const loadFee = round2(km * tonnes * perTonneKm);
  const waiting = round2(Math.max(0, Number(waitingHours) || 0) * round2(ratePerWaitingHour));

  // A round trip is the default assumption: the truck comes back. Quoting a
  // one-way distance is how a depot discovers at the end of the month that
  // every delivery cost twice what it charged.
  const total = round2(base + distanceFee * 2 + loadFee * 2 + waiting);

  return {
    ok: true,
    model: 'TRIP_DISTANCE',
    base_call_out: base,
    distance_km: km,
    rate_per_km: perKm,
    distance_fee_return: round2(distanceFee * 2),
    load_tonnes: tonnes,
    load_fee_return: round2(loadFee * 2),
    waiting_hours: round2(Number(waitingHours) || 0),
    waiting_fee: waiting,
    total,
    breakdown: [
      { label: 'Call-out', amount: base },
      { label: `Distance ${km.toLocaleString('en-NG')} km × ₦${perKm.toLocaleString('en-NG')} (return)`, amount: round2(distanceFee * 2) },
      loadFee > 0 ? { label: `Load ${tonnes} t × ${km} km × ₦${perTonneKm.toLocaleString('en-NG')} (return)`, amount: round2(loadFee * 2) } : null,
      waiting > 0 ? { label: 'Waiting time at site', amount: waiting } : null,
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------------
// FREE-DELIVERY THRESHOLD
// ---------------------------------------------------------------------
// "Free delivery on orders above ₦500,000" is the single most effective
// furniture promotion there is, and it must be applied to the DELIVERY FEE
// only — never to the goods. Waiving it above a threshold is a discount the
// owner chose and can measure; the code below records that it was waived and
// why, so the report can say how much free delivery cost this month.
function applyFreeDeliveryThreshold({ quote, orderSubtotal, threshold = 0 }) {
  const t = round2(threshold);
  const sub = round2(orderSubtotal);
  if (!(t > 0) || sub < t) return { ...quote, waived: false, waived_reason: null, chargeable_total: quote.total };
  return {
    ...quote,
    waived: true,
    waived_reason: `Order subtotal ₦${sub.toLocaleString('en-NG')} meets the ₦${t.toLocaleString('en-NG')} free-delivery threshold`,
    chargeable_total: 0,
    cost_to_business: quote.total, // recorded so the promotion is measurable
  };
}

// ---------------------------------------------------------------------
// INSTALLATION
// ---------------------------------------------------------------------
// Installation is a separate chargeable service with a separate technician,
// and it is where appliance retailers make or lose a reputation: an AC unit
// badly installed leaks, a gas cooker badly installed is dangerous. The
// commissioning checklist is therefore REQUIRED before a job can move to
// INSTALLED — it is the record that the work was done properly, and it is
// the shop's defence if the customer reports a fault a week later.
const INSTALLATION_CHECKLISTS = Object.freeze({
  AIR_CONDITIONER: [
    'Indoor unit mounted level and secure',
    'Outdoor unit mounted with clearance and drainage',
    'Refrigerant lines insulated and pressure-tested',
    'Electrical supply on a dedicated circuit with correct breaker',
    'Vacuum pulled and system charged to spec',
    'Test run: cooling confirmed at outlet',
    'Condensate drain flows freely',
    'Customer shown remote operation and filter cleaning',
  ],
  REFRIGERATOR_FREEZER: [
    'Unit positioned level with ventilation clearance',
    'Left standing upright for the required settling period before power-on',
    'Dedicated socket, no extension lead on a high-draw compressor',
    'Temperature controls set and verified',
    'Doors seal evenly',
    'Customer shown defrost and cleaning routine',
  ],
  WASHING_MACHINE: [
    'Levelled on all four feet',
    'Inlet connected with no leak at pressure',
    'Drain connected and discharge tested',
    'Transit bolts REMOVED',
    'Test cycle run to completion',
  ],
  GAS_COOKER: [
    'Hose and regulator fitted and within date',
    'Leak test applied to every joint with soapy water',
    'All burners ignite and hold a stable flame',
    'Oven ignites and reaches temperature',
    'Ventilation confirmed',
    'Customer shown how to shut off the cylinder',
  ],
  SOLAR_INVERTER: [
    'Panel array oriented and mounted secure',
    'DC polarity verified before connection',
    'Battery bank connected with correct series/parallel configuration',
    'Charge controller configured for the battery chemistry',
    'Inverter output voltage and frequency verified under load',
    'Changeover tested from grid to inverter and back',
    'Earthing/bonding confirmed',
    'Customer shown system status display and shutdown procedure',
  ],
  FURNITURE_ASSEMBLY: [
    'All components present against the delivery note',
    'Assembly to manufacturer specification',
    'Fasteners torqued and checked',
    'Unit level and stable, no rocking',
    'Drawers, doors and hinges operate smoothly',
    'Surfaces inspected for transit damage with the customer present',
    'Packaging removed from the premises',
  ],
  GENERIC: [
    'Item positioned as the customer requested',
    'Connected / assembled to specification',
    'Function tested with the customer present',
    'Customer shown basic operation and care',
    'Packaging removed from the premises',
  ],
});

function checklistFor(kind) {
  const key = String(kind || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return INSTALLATION_CHECKLISTS[key] || INSTALLATION_CHECKLISTS.GENERIC;
}

// ---------------------------------------------------------------------
// STATE TRANSITIONS
// ---------------------------------------------------------------------
// A job must not be able to jump from PENDING to INSTALLED, because that is
// exactly what a driver does when they want the job off the board without
// doing it. The allowed transitions are declared, and the guard requires
// proof where proof is what makes the status honest.
const ALLOWED_TRANSITIONS = Object.freeze({
  PENDING: ['ASSIGNED', 'SCHEDULED', 'CANCELLED'],
  ASSIGNED: ['SCHEDULED', 'IN_TRANSIT', 'CANCELLED', 'PENDING'],
  SCHEDULED: ['IN_TRANSIT', 'FAILED', 'CANCELLED', 'ASSIGNED'],
  IN_TRANSIT: ['ARRIVED', 'FAILED', 'RETURNED_TO_BRANCH'],
  ARRIVED: ['DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED'],
  DELIVERED: ['INSTALLING', 'COMPLETED', 'FAILED'],
  PARTIALLY_DELIVERED: ['IN_TRANSIT', 'DELIVERED', 'FAILED'],
  INSTALLING: ['INSTALLED', 'FAILED'],
  INSTALLED: ['COMPLETED'],
  FAILED: ['SCHEDULED', 'RETURNED_TO_BRANCH', 'CANCELLED'],
  RETURNED_TO_BRANCH: ['SCHEDULED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
});

function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

// What must be present for a transition to be legitimate.
const TRANSITION_REQUIREMENTS = Object.freeze({
  ASSIGNED: ['assigned_to_user_id', 'vehicle'],
  SCHEDULED: ['scheduled_date'],
  DELIVERED: ['pod_recipient_name'],
  PARTIALLY_DELIVERED: ['pod_recipient_name', 'items_delivered'],
  INSTALLED: ['checklist_completed'],
  FAILED: ['failure_reason'],
  RETURNED_TO_BRANCH: ['failure_reason'],
  CANCELLED: ['cancellation_reason'],
});

function assertTransitionAllowed({ from, to, payload = {} }) {
  if (!canTransition(from, to)) {
    return {
      ok: false, code: 'ILLEGAL_JOB_TRANSITION',
      error: `A ${String(from).replace(/_/g, ' ').toLowerCase()} job cannot move straight to ${String(to).replace(/_/g, ' ').toLowerCase()}. Allowed next states: ${(ALLOWED_TRANSITIONS[from] || []).join(', ') || 'none — this job is closed'}.`,
    };
  }
  const required = TRANSITION_REQUIREMENTS[to] || [];
  const missing = required.filter((field) => {
    const v = payload[field];
    if (Array.isArray(v)) return v.length === 0;
    return v == null || String(v).trim() === '';
  });
  if (missing.length) {
    return {
      ok: false, code: 'JOB_TRANSITION_MISSING_PROOF',
      error: `Moving a job to ${String(to).replace(/_/g, ' ').toLowerCase()} requires: ${missing.map((f) => f.replace(/_/g, ' ')).join(', ')}. This is the record that the work was actually done.`,
      missing,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------
// DISPATCH PLANNING
// ---------------------------------------------------------------------
// A simple, honest load check. The most common real failure is not a routing
// problem, it is sending a bus to collect a side-by-side refrigerator —
// INSUFFICIENT_LOAD_SPACE is in FAILURE_REASONS because it happens.
function vehicleCanCarry({ vehicleCapacityM3, items = [] }) {
  const cap = Number(vehicleCapacityM3) || 0;
  const required = items.reduce((a, it) => a + (Number(it.volume_m3) || 0) * (Number(it.quantity) || 1), 0);
  if (cap <= 0) return { ok: true, unknown: true, required: round2(required) };
  return {
    ok: round2(required) <= round2(cap),
    capacity_m3: round2(cap),
    required_m3: round2(required),
    utilisation_percent: cap > 0 ? round2((required / cap) * 100) : null,
    error: round2(required) > round2(cap)
      ? `This load needs about ${round2(required).toLocaleString('en-NG')} m³ and the vehicle holds ${round2(cap).toLocaleString('en-NG')} m³. Send a larger vehicle or split the job — "did not fit" is the most avoidable failed delivery there is.`
      : null,
  };
}

// Volumetric estimate from item dimensions (cm). Furniture and appliances
// are usually specified in centimetres on the carton, so the conversion is
// done here once rather than in three places with three different answers.
function volumeM3({ lengthCm, widthCm, heightCm }) {
  const l = Number(lengthCm) || 0;
  const w = Number(widthCm) || 0;
  const h = Number(heightCm) || 0;
  return round2((l * w * h) / 1_000_000);
}

module.exports = {
  JOB_TYPES,
  JOB_STATUSES,
  FAILURE_REASONS,
  FULFILMENT_PROVIDERS,
  POD_REQUIREMENTS,
  INSTALLATION_CHECKLISTS,
  ALLOWED_TRANSITIONS,
  TRANSITION_REQUIREMENTS,
  quoteZoneFlat,
  quoteTrip,
  applyFreeDeliveryThreshold,
  checklistFor,
  canTransition,
  assertTransitionAllowed,
  vehicleCanCarry,
  volumeM3,
};
