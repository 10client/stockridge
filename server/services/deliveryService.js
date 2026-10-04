// =====================================================================
// StockRidge — DELIVERY & INSTALLATION
// =====================================================================
// For a furniture showroom, an appliance wholesaler or a building-materials
// yard, delivery is not a courtesy — it is the last mile of the sale and the
// part most likely to go wrong. A ₦1.2m refrigerator sold and never
// delivered is a refund, a reputation problem and a truck journey, in that
// order of cost.
//
// THREE DESIGN DECISIONS:
//
//  1. PROOF OF DELIVERY IS A FIRST-CLASS FIELD, not a note. pod_received,
//     pod_signature_data_url, pod_photo_data_url, pod_received_by_name and
//     pod_received_at. Without them, "they never delivered" and "they never
//     signed" are both unanswerable, and an unresolved POD dispute on a big
//     ticket item is a larger loss than the delivery fee it is arguing about.
//     A job cannot be marked COMPLETED without a POD unless a manager
//     explicitly overrides it — and the override is recorded by name.
//
//  2. INSTALLATION IS TRACKED PER ITEM, not per job. A delivery of a
//     3-seater sofa, a bed frame and a wardrobe may have one item installed
//     and two left for a second visit because the customer's room was not
//     ready. A job-level "installed" flag cannot express that, so each
//     delivery_job_items row carries its own installed flag and timestamp.
//
//  3. RESCHEDULES ARE COUNTED. reschedule_count is the metric that separates
//     a logistics problem from a customer problem: a job rescheduled four
//     times is either a route-planning failure or a customer who is not
//     ready, and the two need opposite responses. Hiding the count makes
//     both invisible.
//
// FEES: a delivery charge is a SERVICE LINE on the sale, so it attracts VAT,
// lands in a delivery-income revenue account and shows up in the P&L — rather
// than being a ₦5,000 cash note in a driver's pocket that never reaches the
// books.
// =====================================================================

const { newId, watNowIso, watDate, addDays } = require('../../shared/ids');
const { round2 } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const { PREFIXES, nextReference } = require('../lib/references');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { assertCapability, capabilitiesOf } = require('../lib/capabilities');
const { getUnitSettings, assertSubscribed, staffAllowance } = require('../lib/planLimits');

const JOB_TYPES = ['DELIVERY', 'INSTALLATION', 'DELIVERY_AND_INSTALLATION', 'ASSEMBLY', 'SITE_SURVEY', 'PICKUP', 'RETURN_COLLECTION'];
const STATUSES = ['SCHEDULED', 'ASSIGNED', 'LOADING', 'IN_TRANSIT', 'ARRIVED', 'COMPLETED', 'FAILED', 'CANCELLED', 'RESCHEDULED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const WINDOWS = ['MORNING', 'AFTERNOON', 'EVENING', 'ANY'];
const DELIVERY_CLASSES = ['SMALL', 'MEDIUM', 'LARGE', 'BULKY'];

// Default fee bands by delivery class. Data, not code: an owner edits these
// under Settings → Delivery, because a bike delivery in Lagos and a flatbed
// to Kano are not the same journey.
const DEFAULT_FEE_BANDS = Object.freeze({
  SMALL: 2500, MEDIUM: 7500, LARGE: 20000, BULKY: 45000,
});

async function create(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'create a delivery job' });
  assertCapability(settings, 'delivery_management', { action: 'create a delivery job' });

  const branchId = input.branch_id || ctx.user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch this job is from.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, branchId);

  const allowance = await staffAllowance(db, businessUnitId, ctx.user);
  if (String(ctx.user.role).toUpperCase() === 'STAFF' && !allowance.can_create_delivery_job) {
    throw new HttpError(403, 'Only a manager can create delivery jobs in this business.', 'DELIVERY_STAFF_NOT_PERMITTED');
  }

  const jobType = String(input.job_type || 'DELIVERY').toUpperCase();
  if (!JOB_TYPES.includes(jobType)) throw new HttpError(400, `Job type must be one of: ${JOB_TYPES.join(', ')}.`, 'DELIVERY_JOB_TYPE_INVALID');

  if (!input.address || String(input.address).trim().length < 5) {
    throw new HttpError(400, 'A delivery address of at least 5 characters is required. A job with no address cannot be routed and cannot be evidence of anything.', 'DELIVERY_ADDRESS_REQUIRED');
  }
  if (!input.contact_phone) {
    throw new HttpError(400, 'A contact phone number is required — the driver must be able to call when they arrive.', 'DELIVERY_CONTACT_PHONE_REQUIRED');
  }

  const scheduledDate = String(input.scheduled_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) throw new HttpError(400, 'Scheduled date must be YYYY-MM-DD.', 'DELIVERY_DATE_INVALID');
  if (scheduledDate < watDate()) {
    throw new HttpError(400, 'A delivery cannot be scheduled in the past. If it already happened, record the actual dates on completion.', 'DELIVERY_DATE_PAST');
  }

  const window = input.scheduled_window ? String(input.scheduled_window).toUpperCase() : null;
  if (window && !WINDOWS.includes(window)) throw new HttpError(400, `Window must be one of: ${WINDOWS.join(', ')}.`, 'DELIVERY_WINDOW_INVALID');
  const priority = String(input.priority || 'NORMAL').toUpperCase();
  if (!PRIORITIES.includes(priority)) throw new HttpError(400, `Priority must be one of: ${PRIORITIES.join(', ')}.`, 'DELIVERY_PRIORITY_INVALID');

  // Customer and/or sale linkage.
  let customer = null;
  if (input.customer_id) {
    customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(input.customer_id).first();
    if (!customer) throw new HttpError(404, 'That customer was not found.', 'CUSTOMER_NOT_FOUND');
  }
  let sale = null;
  if (input.sale_id) {
    sale = await db.prepare('SELECT * FROM sales WHERE id = ? AND is_deleted = 0').bind(input.sale_id).first();
    if (!sale) throw new HttpError(404, 'That sale was not found.', 'SALE_NOT_FOUND');
    if (!customer) customer = sale.customer_id ? await db.prepare('SELECT * FROM customers WHERE id = ?').bind(sale.customer_id).first() : null;
  }

  const ts = watNowIso();
  const id = newId();
  const branch = await db.prepare('SELECT code FROM branches WHERE id = ?').bind(branchId).first();
  const jobNo = input.job_no
    || (await nextReference(db, { businessUnitId, prefix: PREFIXES.DELIVERY_JOB, branchCode: branch.code || '*', scope: 'YEAR' })).reference;

  // Fee. A stated fee wins; otherwise derive from the delivery class of the
  // largest item, because a mixed load is priced by what needs the biggest
  // vehicle.
  const items = Array.isArray(input.items) ? input.items : [];
  let deliveryFee = input.delivery_fee != null ? round2(Number(input.delivery_fee)) : null;
  let installationFee = input.installation_fee != null ? round2(Number(input.installation_fee)) : 0;
  if (deliveryFee == null) deliveryFee = await estimateFee(db, { businessUnitId, branchId, items, jobType });

  const statements = [];
  const resolvedItems = [];
  for (const raw of items) {
    if (!raw.product_id && !raw.sale_item_id) continue;
    const product = raw.product_id
      ? await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(raw.product_id).first()
      : null;
    const qty = Number(raw.quantity) || 1;
    const itemId = newId();
    resolvedItems.push({ id: itemId, product_id: product ? product.id : null, product_name: product ? product.name : (raw.description || 'Item'), quantity: qty });
    statements.push(db.prepare(`
      INSERT INTO delivery_job_items (
        id, delivery_job_id, business_unit_id, product_id, sale_item_id, serial_id, quantity,
        requires_installation, installed, notes, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?, 0, ?,?,?)
    `).bind(itemId, id, businessUnitId, product ? product.id : null, raw.sale_item_id || null,
      raw.serial_id || null, qty, raw.requires_installation ? 1 : 0, raw.notes || null, ts, ts));
  }

  const totalCharge = round2(deliveryFee + installationFee + round2(Number(input.extra_cost) || 0));
  statements.push(db.prepare(`
    INSERT INTO delivery_jobs (
      id, business_unit_id, branch_id, job_no, job_type, sale_id, customer_id, status, priority,
      address, city, state, landmark, latitude, longitude, contact_name, contact_phone,
      vehicle_id, assigned_to, assistant_name, scheduled_date, scheduled_window,
      distance_km, delivery_fee, installation_fee, extra_cost, total_charge, paid_by_customer,
      payment_status, notes, created_by, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?, 'SCHEDULED', ?,?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?, 'UNPAID', ?,?,?,?)
  `).bind(
    id, businessUnitId, branchId, jobNo, jobType, sale ? sale.id : null, customer ? customer.id : null, priority,
    String(input.address).slice(0, 400), input.city ? String(input.city).slice(0, 120) : null,
    input.state ? String(input.state).slice(0, 120) : null,
    input.landmark ? String(input.landmark).slice(0, 200) : null,
    input.latitude != null ? Number(input.latitude) : null,
    input.longitude != null ? Number(input.longitude) : null,
    input.contact_name ? String(input.contact_name).slice(0, 160) : (customer ? customer.full_name : null),
    String(input.contact_phone).slice(0, 20),
    input.vehicle_id || null, input.assigned_to || null,
    input.assistant_name ? String(input.assistant_name).slice(0, 160) : null,
    scheduledDate, window,
    input.distance_km != null ? Number(input.distance_km) : null,
    deliveryFee, installationFee, round2(Number(input.extra_cost) || 0), totalCharge,
    input.paid_by_customer === false ? 0 : 1,
    input.notes ? String(input.notes).slice(0, 2000) : null, ctx.user.id, ts, ts
  ));

  // If this job is for a sale that has no delivery requirement row yet,
  // create one, so the sale screen shows that a delivery is coming.
  if (sale && !input.skip_sale_link) {
    const existingReq = await db.prepare('SELECT id FROM sale_delivery_requirements WHERE sale_id = ?').bind(sale.id).first();
    if (!existingReq) {
      statements.push(db.prepare(`
        INSERT INTO sale_delivery_requirements (
          id, sale_id, business_unit_id, branch_id, delivery_job_id, requires_delivery, requires_installation,
          address, city, state, landmark, contact_name, contact_phone, preferred_date, preferred_window,
          delivery_fee, installation_fee, notes, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(newId(), sale.id, businessUnitId, branchId, id,
        ['DELIVERY', 'DELIVERY_AND_INSTALLATION', 'ASSEMBLY'].includes(jobType) ? 1 : 0,
        ['INSTALLATION', 'DELIVERY_AND_INSTALLATION', 'ASSEMBLY'].includes(jobType) ? 1 : 0,
        String(input.address).slice(0, 400), input.city || null, input.state || null, input.landmark || null,
        input.contact_name || null, String(input.contact_phone).slice(0, 20), scheduledDate, window,
        deliveryFee, installationFee, input.notes || null, ts, ts));
      statements.push(db.prepare('UPDATE sales SET delivery_job_id = ?, updated_at = ? WHERE id = ?').bind(id, ts, sale.id));
    } else {
      statements.push(db.prepare('UPDATE sale_delivery_requirements SET delivery_job_id = ?, updated_at = ? WHERE id = ?').bind(id, ts, existingReq.id));
    }
  }

  await db.batch(statements);

  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'DELIVERY_JOB_CREATED', entityType: 'DELIVERY_JOB', entityId: id, amount: totalCharge,
    after: { job_no: jobNo, job_type: jobType, scheduled_date: scheduledDate, items: resolvedItems.length },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id, job_no: jobNo, status: 'SCHEDULED', job_type: jobType,
    scheduled_date: scheduledDate, scheduled_window: window, priority,
    address: String(input.address).slice(0, 400), contact_phone: String(input.contact_phone).slice(0, 20),
    items: resolvedItems, delivery_fee: deliveryFee, installation_fee: installationFee, total_charge: totalCharge,
    customer: customer ? { id: customer.id, full_name: customer.full_name, phone: customer.phone } : null,
    sale_receipt_no: sale ? sale.receipt_no : null,
  };
}

async function estimateFee(db, { businessUnitId, branchId, items, jobType }) {
  if (!Array.isArray(items) || !items.length) return DEFAULT_FEE_BANDS.SMALL;
  let worst = 'SMALL';
  const rank = { SMALL: 0, MEDIUM: 1, LARGE: 2, BULKY: 3 };
  for (const raw of items) {
    if (!raw.product_id) continue;
    const p = await db.prepare('SELECT delivery_class, base_unit FROM products WHERE id = ?').bind(raw.product_id).first();
    const cls = p && p.delivery_class ? p.delivery_class : 'SMALL';
    if (rank[cls] > rank[worst]) worst = cls;
  }
  let fee = DEFAULT_FEE_BANDS[worst] || DEFAULT_FEE_BANDS.SMALL;
  // A branch-level override beats the default band. Owners set real rates per
  // branch because a Lekki delivery and an Ikorodu delivery from the same
  // showroom are not the same price.
  const override = await db.prepare(`
    SELECT cost_per_trip FROM delivery_vehicles WHERE business_unit_id = ? AND is_active = 1 AND is_deleted = 0 AND cost_per_trip > 0
    ORDER BY cost_per_trip ASC LIMIT 1
  `).bind(businessUnitId).first();
  if (override && Number(override.cost_per_trip) > 0) fee = Math.max(fee, round2(Number(override.cost_per_trip)));
  if (['INSTALLATION', 'DELIVERY_AND_INSTALLATION', 'ASSEMBLY'].includes(String(jobType).toUpperCase())) {
    fee = round2(fee * 1.5);
  }
  return round2(fee);
}

// Transition the job through its lifecycle. Each transition is validated:
// a job cannot ARRIVE before it departed, and cannot COMPLETE without a POD.
const TRANSITIONS = Object.freeze({
  SCHEDULED: ['ASSIGNED', 'CANCELLED', 'RESCHEDULED'],
  ASSIGNED: ['LOADING', 'CANCELLED', 'RESCHEDULED'],
  LOADING: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['ARRIVED', 'FAILED'],
  ARRIVED: ['COMPLETED', 'FAILED'],
  FAILED: ['SCHEDULED', 'RESCHEDULED', 'CANCELLED'],
  RESCHEDULED: ['ASSIGNED', 'SCHEDULED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
});

async function transition(db, ctx, { jobId, toStatus, note = null, pod = null, overridePod = false, distanceKm = null, customerRating = null }) {
  const job = await load(db, jobId, ctx.businessUnitId);
  if (!job) throw new HttpError(404, 'That delivery job was not found.', 'DELIVERY_JOB_NOT_FOUND');
  assertBranchAccess(ctx.user, job.branch_id);

  const to = String(toStatus).toUpperCase();
  if (!STATUSES.includes(to)) throw new HttpError(400, `Status must be one of: ${STATUSES.join(', ')}.`, 'DELIVERY_STATUS_INVALID');
  const allowed = TRANSITIONS[job.status] || [];
  if (!allowed.includes(to)) {
    throw new HttpError(409,
      `A job that is ${job.status} cannot move to ${to}. The allowed next states are ${allowed.length ? allowed.join(', ') : 'none — this job is closed'}.`,
      'DELIVERY_TRANSITION_INVALID');
  }

  const ts = watNowIso();
  const statements = [];
  const sets = ['status = ?', 'updated_at = ?'];
  const params = [to, ts];

  if (to === 'IN_TRANSIT') { sets.push('departed_at = ?'); params.push(ts); }
  if (to === 'ARRIVED') { sets.push('arrived_at = ?'); params.push(ts); }
  if (to === 'COMPLETED') {
    // POD IS THE GATE. Completing without proof is how a delivery becomes an
    // unanswerable dispute, so it requires either a POD or a named manager
    // override — and the override is recorded against a person.
    const hasPod = !!(pod && (pod.signature_data_url || pod.photo_data_url || pod.received_by_name));
    if (!hasPod && !overridePod) {
      throw new HttpError(400,
        'Record proof of delivery before completing this job — the recipient\u2019s name and a signature or a photo of the goods in place. '
        + 'Without it, "they never delivered" has no answer, and a manager can override this with their name recorded.',
        'DELIVERY_POD_REQUIRED');
    }
    if (!hasPod && overridePod) {
      if (String(ctx.user.role).toUpperCase() === 'STAFF') {
        throw new HttpError(403, 'Only a manager can complete a delivery without proof of delivery. The override is recorded against your name.', 'DELIVERY_POD_OVERRIDE_FORBIDDEN');
      }
      if (!note || String(note).trim().length < 5) {
        throw new HttpError(400, 'Completing without proof of delivery needs a written reason of at least 5 characters.', 'DELIVERY_POD_OVERRIDE_REASON_REQUIRED');
      }
    }
    sets.push('completed_at = ?', 'pod_received = ?', 'pod_received_at = ?', 'pod_received_by_name = ?', 'pod_note = ?');
    params.push(ts, hasPod ? 1 : 0, ts,
      pod && pod.received_by_name ? String(pod.received_by_name).slice(0, 160) : null,
      note ? String(note).slice(0, 500) : null);
    if (pod && pod.signature_data_url) { sets.push('pod_signature_data_url = ?'); params.push(String(pod.signature_data_url)); }
    if (pod && pod.photo_data_url) { sets.push('pod_photo_data_url = ?'); params.push(String(pod.photo_data_url)); }
    if (customerRating != null) { sets.push('customer_rating = ?'); params.push(Math.min(5, Math.max(1, Number(customerRating) || 0))); }
    if (distanceKm != null) { sets.push('distance_km = ?'); params.push(Number(distanceKm)); }
  }
  if (to === 'FAILED') {
    if (!note || String(note).trim().length < 5) {
      throw new HttpError(400, 'A failed delivery needs a written reason of at least 5 characters — it is the only record of why the journey was wasted.', 'DELIVERY_FAILURE_REASON_REQUIRED');
    }
    sets.push('failure_reason = ?'); params.push(String(note).slice(0, 500));
  }
  if (to === 'CANCELLED') {
    if (!note || String(note).trim().length < 4) throw new HttpError(400, 'A cancellation needs a reason.', 'DELIVERY_CANCEL_REASON_REQUIRED');
    sets.push('failure_reason = ?'); params.push(`Cancelled: ${String(note).slice(0, 400)}`);
  }
  if (to === 'RESCHEDULED') {
    sets.push('reschedule_count = reschedule_count + 1');
    if (note) { sets.push('notes = COALESCE(notes || \' | \',\'\') || ?'); params.push(`Rescheduled: ${String(note).slice(0, 200)}`); }
  }

  params.push(jobId);
  statements.push(db.prepare(`UPDATE delivery_jobs SET ${sets.join(', ')} WHERE id = ?`).bind(...params));

  await db.batch(statements);

  // Delivery income. Recognised on COMPLETION, not on scheduling — a job that
  // never runs earned nothing, and recognising the fee up front would put
  // revenue in the books for a journey that failed.
  if (to === 'COMPLETED' && Number(job.total_charge) > 0 && Number(job.paid_by_customer) === 1
    && capabilitiesOf(ctx.businessUnit || await getUnitSettings(db, job.business_unit_id)).general_ledger) {
    try {
      const glService = require('./glService');
      const fee = round2(Number(job.delivery_fee) || 0);
      const install = round2(Number(job.installation_fee) || 0);
      const extra = round2(Number(job.extra_cost) || 0);
      const lines = [];
      if (fee > 0.004) lines.push({ account_code: '4200', debit: 0, credit: fee, description: `Delivery fee ${job.job_no}` });
      if (install > 0.004) lines.push({ account_code: '4100', debit: 0, credit: install, description: `Installation ${job.job_no}` });
      if (extra > 0.004) lines.push({ account_code: '5100', debit: extra, credit: 0, description: `Delivery extra cost ${job.job_no}` });
      const total = round2(fee + install + extra);
      if (lines.length && total > 0) {
        lines.push({ account_code: '1200', debit: total, credit: 0, description: `Delivery receivable ${job.job_no}` });
        await glService.postEntry(db, {
          businessUnitId: job.business_unit_id, branchId: job.branch_id, entryDate: watDate(),
          sourceType: 'DELIVERY_JOB', sourceId: jobId, reference: job.job_no,
          description: `Delivery ${job.job_no} completed`, lines, userId: ctx.user.id,
        });
      }
    } catch (e) { console.error('[deliveryService] GL posting failed for', job.job_no, e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId: job.business_unit_id, branchId: job.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: `DELIVERY_${to}`, entityType: 'DELIVERY_JOB', entityId: jobId,
    reason: note ? String(note).slice(0, 500) : null,
    before: { status: job.status }, after: { status: to, pod_received: to === 'COMPLETED' },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return { ok: true, id: jobId, job_no: job.job_no, from: job.status, to, at: ts };
}

async function assign(db, ctx, { jobId, assignedTo = null, vehicleId = null, assistantName = null }) {
  const job = await load(db, jobId, ctx.businessUnitId);
  if (!job) throw new HttpError(404, 'That delivery job was not found.', 'DELIVERY_JOB_NOT_FOUND');
  assertBranchAccess(ctx.user, job.branch_id);
  if (!['SCHEDULED', 'ASSIGNED', 'FAILED', 'RESCHEDULED'].includes(job.status)) {
    throw new HttpError(409, `A ${job.status} job cannot be reassigned.`, 'DELIVERY_NOT_ASSIGNABLE');
  }
  if (!assignedTo && !vehicleId) throw new HttpError(400, 'Assign a driver or a vehicle.', 'DELIVERY_ASSIGNMENT_REQUIRED');

  if (assignedTo) {
    const driver = await db.prepare("SELECT * FROM users WHERE id = ? AND is_deleted = 0 AND is_active = 1").bind(assignedTo).first();
    if (!driver) throw new HttpError(404, 'That staff member was not found or is not active.', 'USER_NOT_FOUND');
    if (driver.business_unit_id !== job.business_unit_id) throw new HttpError(403, 'That staff member belongs to a different business.', 'DELIVERY_DRIVER_WRONG_BUSINESS');
  }
  if (vehicleId) {
    const v = await db.prepare('SELECT * FROM delivery_vehicles WHERE id = ? AND is_deleted = 0 AND is_active = 1').bind(vehicleId).first();
    if (!v) throw new HttpError(404, 'That vehicle was not found or is not active.', 'VEHICLE_NOT_FOUND');
    // Double-booking a vehicle is a real operational failure: two jobs, one
    // truck, one customer who waits all day.
    const clash = await db.prepare(`
      SELECT job_no FROM delivery_jobs
      WHERE vehicle_id = ? AND scheduled_date = ? AND is_deleted = 0
        AND status NOT IN ('COMPLETED','CANCELLED','FAILED') AND id <> ?
      LIMIT 1
    `).bind(vehicleId, job.scheduled_date, jobId).first();
    if (clash) {
      throw new HttpError(409, `That vehicle is already booked on ${job.scheduled_date} for job ${clash.job_no}. Choose another vehicle or another date.`, 'VEHICLE_DOUBLE_BOOKED');
    }
  }

  const ts = watNowIso();
  await db.prepare(`
    UPDATE delivery_jobs SET assigned_to = COALESCE(?, assigned_to), vehicle_id = COALESCE(?, vehicle_id),
      assistant_name = COALESCE(?, assistant_name), status = 'ASSIGNED', updated_at = ?
    WHERE id = ?
  `).bind(assignedTo, vehicleId, assistantName ? String(assistantName).slice(0, 160) : null, ts, jobId).run();

  await writeAudit(db, {
    businessUnitId: job.business_unit_id, branchId: job.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'DELIVERY_ASSIGNED', entityType: 'DELIVERY_JOB', entityId: jobId,
    after: { assigned_to: assignedTo, vehicle_id: vehicleId }, ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: jobId, status: 'ASSIGNED', assigned_to: assignedTo, vehicle_id: vehicleId };
}

async function reschedule(db, ctx, { jobId, newDate, newWindow = null, reason }) {
  const job = await load(db, jobId, ctx.businessUnitId);
  if (!job) throw new HttpError(404, 'That delivery job was not found.', 'DELIVERY_JOB_NOT_FOUND');
  assertBranchAccess(ctx.user, job.branch_id);
  const d = String(newDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'The new date must be YYYY-MM-DD.', 'DELIVERY_DATE_INVALID');
  if (d < watDate()) throw new HttpError(400, 'A job cannot be rescheduled into the past.', 'DELIVERY_DATE_PAST');
  if (!reason || String(reason).trim().length < 4) {
    throw new HttpError(400, 'A reschedule needs a reason of at least 4 characters. Repeated reschedules are a metric, and the reason is what makes the metric actionable.', 'DELIVERY_RESCHEDULE_REASON_REQUIRED');
  }
  const w = newWindow ? String(newWindow).toUpperCase() : null;
  if (w && !WINDOWS.includes(w)) throw new HttpError(400, `Window must be one of: ${WINDOWS.join(', ')}.`, 'DELIVERY_WINDOW_INVALID');

  const ts = watNowIso();
  await db.prepare(`
    UPDATE delivery_jobs SET scheduled_date = ?, scheduled_window = COALESCE(?, scheduled_window),
      status = 'RESCHEDULED', reschedule_count = reschedule_count + 1,
      notes = COALESCE(notes || ' | ','') || ?, updated_at = ?
    WHERE id = ?
  `).bind(d, w, `Rescheduled from ${job.scheduled_date}: ${String(reason).slice(0, 250)}`, ts, jobId).run();

  await writeAudit(db, {
    businessUnitId: job.business_unit_id, branchId: job.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'DELIVERY_RESCHEDULED', entityType: 'DELIVERY_JOB', entityId: jobId,
    reason: String(reason).slice(0, 500), before: { scheduled_date: job.scheduled_date }, after: { scheduled_date: d },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: jobId, scheduled_date: d, reschedule_count: Number(job.reschedule_count) + 1 };
}

async function markItemInstalled(db, ctx, { jobId, jobItemId, installed = true, note = null }) {
  const job = await load(db, jobId, ctx.businessUnitId);
  if (!job) throw new HttpError(404, 'That delivery job was not found.', 'DELIVERY_JOB_NOT_FOUND');
  assertBranchAccess(ctx.user, job.branch_id);
  const item = await db.prepare('SELECT * FROM delivery_job_items WHERE id = ? AND delivery_job_id = ? AND is_deleted = 0').bind(jobItemId, jobId).first();
  if (!item) throw new HttpError(404, 'That item is not on this job.', 'DELIVERY_ITEM_NOT_FOUND');
  const ts = watNowIso();
  await db.prepare(`
    UPDATE delivery_job_items SET installed = ?, installed_at = CASE WHEN ? THEN ? ELSE installed_at END,
      notes = COALESCE(?, notes), updated_at = ?
    WHERE id = ?
  `).bind(installed ? 1 : 0, installed ? 1 : 0, ts, note ? String(note).slice(0, 500) : null, ts, jobItemId).run();
  return { ok: true, id: jobItemId, installed: !!installed };
}

async function load(db, jobId, businessUnitId = null) {
  return db.prepare(`
    SELECT dj.*, b.name AS branch_name, c.full_name AS customer_name, c.phone AS customer_phone,
           u.full_name AS assigned_to_name, u.phone AS assigned_to_phone,
           v.plate_number, v.vehicle_type, v.driver_name, v.driver_phone,
           s.receipt_no, s.total AS sale_total
    FROM delivery_jobs dj
    JOIN branches b ON b.id = dj.branch_id
    LEFT JOIN customers c ON c.id = dj.customer_id
    LEFT JOIN users u ON u.id = dj.assigned_to
    LEFT JOIN delivery_vehicles v ON v.id = dj.vehicle_id
    LEFT JOIN sales s ON s.id = dj.sale_id
    WHERE dj.id = ? AND dj.is_deleted = 0 ${businessUnitId ? 'AND dj.business_unit_id = ?' : ''}
  `).bind(jobId, ...(businessUnitId ? [businessUnitId] : [])).first();
}

async function getWithItems(db, jobId, businessUnitId) {
  const job = await load(db, jobId, businessUnitId);
  if (!job) return null;
  const items = await db.prepare(`
    SELECT dji.*, p.name AS product_name, p.sku, p.delivery_class, ps.serial_no
    FROM delivery_job_items dji
    LEFT JOIN products p ON p.id = dji.product_id
    LEFT JOIN product_serials ps ON ps.id = dji.serial_id
    WHERE dji.delivery_job_id = ? AND dji.is_deleted = 0
  `).bind(jobId).all();
  return { ...job, items: items.results };
}

async function list(db, { businessUnitId, branchId = null, status = null, jobType = null, assignedTo = null, date = null, fromDate = null, toDate = null, priority = null, limit = 50, offset = 0 }) {
  const where = ['dj.is_deleted = 0', 'dj.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('dj.branch_id = ?'); params.push(branchId); }
  if (status) { where.push('dj.status = ?'); params.push(String(status).toUpperCase()); }
  if (jobType) { where.push('dj.job_type = ?'); params.push(String(jobType).toUpperCase()); }
  if (assignedTo) { where.push('dj.assigned_to = ?'); params.push(assignedTo); }
  if (priority) { where.push('dj.priority = ?'); params.push(String(priority).toUpperCase()); }
  if (date) { where.push('dj.scheduled_date = ?'); params.push(String(date).slice(0, 10)); }
  if (fromDate) { where.push('dj.scheduled_date >= ?'); params.push(String(fromDate).slice(0, 10)); }
  if (toDate) { where.push('dj.scheduled_date <= ?'); params.push(String(toDate).slice(0, 10)); }

  const rows = await db.prepare(`
    SELECT dj.*, b.name AS branch_name, c.full_name AS customer_name, c.phone AS customer_phone,
           u.full_name AS assigned_to_name, v.plate_number, s.receipt_no,
           (SELECT COUNT(*) FROM delivery_job_items i WHERE i.delivery_job_id = dj.id AND i.is_deleted = 0) AS item_count,
           (SELECT COUNT(*) FROM delivery_job_items i WHERE i.delivery_job_id = dj.id AND i.is_deleted = 0 AND i.installed = 1) AS installed_count
    FROM delivery_jobs dj
    JOIN branches b ON b.id = dj.branch_id
    LEFT JOIN customers c ON c.id = dj.customer_id
    LEFT JOIN users u ON u.id = dj.assigned_to
    LEFT JOIN delivery_vehicles v ON v.id = dj.vehicle_id
    LEFT JOIN sales s ON s.id = dj.sale_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE dj.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
      dj.scheduled_date ASC, dj.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();
  return rows.results;
}

// Today's run sheet: what leaves the yard today, in what order, with which
// vehicle and which driver. The one printout a dispatcher actually uses.
async function runSheet(db, { businessUnitId, branchId = null, date = null }) {
  const d = String(date || watDate()).slice(0, 10);
  const jobs = await list(db, {
    businessUnitId, branchId, date: d, limit: 500,
  });
  const open = jobs.filter((j) => !['COMPLETED', 'CANCELLED'].includes(j.status));
  const byVehicle = new Map();
  for (const j of open) {
    const key = j.plate_number || 'UNASSIGNED';
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push(j);
  }
  return {
    date: d,
    job_count: open.length,
    completed: jobs.filter((j) => j.status === 'COMPLETED').length,
    failed: jobs.filter((j) => j.status === 'FAILED').length,
    awaiting_pod: open.filter((j) => j.status === 'ARRIVED' || (j.status === 'COMPLETED' && !j.pod_received)).length,
    total_charge: round2(open.reduce((a, j) => a + Number(j.total_charge || 0), 0)),
    uncollected_charge: round2(open.filter((j) => j.payment_status !== 'PAID').reduce((a, j) => a + Number(j.total_charge || 0), 0)),
    by_vehicle: [...byVehicle.entries()].map(([vehicle, list]) => ({ vehicle, jobs: list })),
    jobs: open,
  };
}

module.exports = {
  JOB_TYPES, STATUSES, PRIORITIES, WINDOWS, DELIVERY_CLASSES, DEFAULT_FEE_BANDS, TRANSITIONS,
  create, estimateFee, transition, assign, reschedule, markItemInstalled,
  load, getWithItems, list, runSheet,
};
'use strict';
