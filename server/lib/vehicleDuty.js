'use strict';
// A dated assignment of one dispatch vehicle to one member of staff.
// The usual driver on the vehicle row is a different fact and is left alone.

const { HttpError } = require('./http');
const { newId } = require('../../domain/crypto');
const { watToday, addDays } = require('../../domain/time');
const { resolveProfile } = require('../../domain/verticals');
const { atLeast } = require('../../domain/roles');

const PERIODS = Object.freeze({
  DAY: 'DAY',
  WEEK: 'WEEK',
  UNTIL_CHANGED: 'UNTIL_CHANGED',
});

function parseOverrides(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

function dispatchEnabled(business) {
  if (!business) return false;
  const profile = resolveProfile(business.profile_code, parseOverrides(business.profile_overrides_json));
  return Boolean(profile && profile.dispatch);
}

function dayOf(value) {
  const day = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function covers(duty, day) {
  if (!duty || duty.ended_at) return false;
  if (String(duty.starts_on) > day) return false;
  if (duty.ends_on && String(duty.ends_on) < day) return false;
  return true;
}

function endsOnFor(period, startsOn) {
  if (period === PERIODS.DAY) return startsOn;
  if (period === PERIODS.WEEK) return addDays(startsOn, 6);
  if (period === PERIODS.UNTIL_CHANGED) return null;
  return undefined;
}

async function staffOnBusiness(db, userId, businessId) {
  const user = await db.first(
    'SELECT * FROM users WHERE id = ? AND is_deleted = 0 AND is_active = 1',
    [String(userId)],
  );
  if (!user || String(user.role) === 'ADMIN') return null;
  if (String(user.business_id) === String(businessId)) return user;
  const grant = await db.first(
    `SELECT id FROM user_business_access
      WHERE user_id = ? AND business_id = ? AND is_deleted = 0 AND revoked_at IS NULL`,
    [String(userId), String(businessId)],
  );
  return grant ? user : null;
}

async function closeOpenDuties(db, { businessId, vehicleId, userId, startsOn }) {
  await db.run(
    `UPDATE vehicle_duties
        SET ended_at = datetime('now'),
            ends_on = CASE WHEN starts_on < ? THEN date(?, '-1 day') ELSE starts_on END,
            updated_at = datetime('now')
      WHERE business_id = ? AND is_deleted = 0 AND ended_at IS NULL
        AND (vehicle_id = ? OR user_id = ?)`,
    [startsOn, startsOn, String(businessId), String(vehicleId), String(userId)],
  );
}

async function assignDuty(db, { businessId, vehicleId, userId, period, startsOn, assignedBy, notes }) {
  const kind = String(period || '').toUpperCase();
  if (!PERIODS[kind]) {
    throw new HttpError('Choose today, this week, or until you change the driver.', { status: 400, code: 'PERIOD_REQUIRED' });
  }
  const start = dayOf(startsOn) || watToday();
  const ends = endsOnFor(kind, start);
  if (ends === undefined) {
    throw new HttpError('Choose today, this week, or until you change the driver.', { status: 400, code: 'PERIOD_REQUIRED' });
  }
  const vehicle = await db.first(
    'SELECT * FROM delivery_vehicles WHERE id = ? AND business_id = ? AND is_deleted = 0',
    [String(vehicleId), String(businessId)],
  );
  if (!vehicle) throw new HttpError('That vehicle is not on this business.', { status: 404, code: 'VEHICLE_NOT_FOUND' });
  if (!Number(vehicle.is_active)) {
    throw new HttpError('That vehicle is off the fleet. Turn it on before assigning a driver.', { status: 409, code: 'VEHICLE_INACTIVE' });
  }
  const staff = await staffOnBusiness(db, userId, businessId);
  if (!staff) throw new HttpError('Choose a member of staff on this business. An outside name is not a duty.', { status: 400, code: 'STAFF_REQUIRED' });
  await closeOpenDuties(db, { businessId, vehicleId, userId, startsOn: start });
  const id = newId();
  await db.run(
    `INSERT INTO vehicle_duties (
       id, business_id, vehicle_id, user_id, period, starts_on, ends_on, assigned_by, notes, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
    [id, String(businessId), String(vehicle.id), String(staff.id), kind, start, ends, assignedBy ? String(assignedBy) : null, notes || null],
  );
  return dutyById(db, id);
}

async function endDuty(db, { businessId, dutyId }) {
  const duty = await db.first(
    'SELECT * FROM vehicle_duties WHERE id = ? AND business_id = ? AND is_deleted = 0',
    [String(dutyId), String(businessId)],
  );
  if (!duty) throw new HttpError('That assignment is not on this business.', { status: 404, code: 'DUTY_NOT_FOUND' });
  if (duty.ended_at) return dutyById(db, duty.id);
  const today = watToday();
  const ends = String(duty.starts_on) < today ? addDays(today, -1) : duty.starts_on;
  await db.run(
    `UPDATE vehicle_duties SET ended_at = datetime('now'), ends_on = ?, updated_at = datetime('now') WHERE id = ?`,
    [ends, String(duty.id)],
  );
  return dutyById(db, duty.id);
}

const DUTY_SELECT = `
  SELECT d.*, u.full_name, u.username, u.phone, u.role,
         v.name AS vehicle_name, v.plate_no, v.vehicle_class, v.arrangement
    FROM vehicle_duties d
    JOIN users u ON u.id = d.user_id
    JOIN delivery_vehicles v ON v.id = d.vehicle_id`;

async function dutyById(db, id) {
  return db.first(`${DUTY_SELECT} WHERE d.id = ?`, [String(id)]);
}

async function dutiesFor(db, { businessId, day, userId, vehicleId, activeOnly }) {
  const when = dayOf(day) || watToday();
  const where = ['d.business_id = ?', 'd.is_deleted = 0'];
  const params = [String(businessId)];
  if (userId) { where.push('d.user_id = ?'); params.push(String(userId)); }
  if (vehicleId) { where.push('d.vehicle_id = ?'); params.push(String(vehicleId)); }
  if (activeOnly) {
    where.push('d.ended_at IS NULL');
    where.push('d.starts_on <= ?');
    where.push('(d.ends_on IS NULL OR d.ends_on >= ?)');
    params.push(when, when);
  }
  return db.all(`${DUTY_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.starts_on DESC, v.name`, params);
}

async function dutyCovering(db, { businessId, userId, vehicleId, day }) {
  const rows = await dutiesFor(db, { businessId, userId, vehicleId, day, activeOnly: true });
  return rows[0] || null;
}

async function resolveSalePlace(db, business, user, body) {
  if (!dispatchEnabled(business)) return { skip: true, salePlace: null, vehicleId: null, vehicleName: null };
  const raw = String(body.sale_place || body.salePlace || 'PREMISES').trim().toUpperCase();
  if (raw === 'PREMISES' || raw === 'PLANT') {
    return { skip: false, salePlace: 'PREMISES', vehicleId: null, vehicleName: null };
  }
  if (raw !== 'VEHICLE') {
    throw new HttpError('Choose the plant premises or a vehicle.', { status: 400, code: 'SALE_PLACE_REQUIRED' });
  }
  const vehicleId = body.vehicle_id || body.vehicleId;
  if (!vehicleId) throw new HttpError('Choose the vehicle this sale is on.', { status: 400, code: 'VEHICLE_REQUIRED' });
  const day = dayOf(body.sold_at || body.soldAt) || watToday();
  const duty = await dutyCovering(db, {
    businessId: business.id,
    userId: user.id,
    vehicleId,
    day,
  });
  if (!duty) {
    throw new HttpError('This sale can be recorded on a vehicle only while that vehicle is assigned to you. Sell on the plant premises, or ask a manager to assign the vehicle.', { status: 403, code: 'DUTY_REQUIRED' });
  }
  return {
    skip: false,
    salePlace: 'VEHICLE',
    vehicleId: String(duty.vehicle_id),
    vehicleName: duty.vehicle_name || null,
    plate: duty.plate_number || null,
  };
}

async function writeSalePlace(db, saleId, place) {
  if (!place || place.skip) return;
  await db.run(
    'UPDATE sales SET sale_place = ?, vehicle_id = ? WHERE id = ?',
    [place.salePlace, place.vehicleId, String(saleId)],
  );
}

function canReadVehicle(user, dutyRows) {
  if (atLeast(user.role, 'MANAGER')) return true;
  return (dutyRows || []).some((row) => String(row.user_id) === String(user.id));
}

module.exports = {
  PERIODS,
  dispatchEnabled,
  assignDuty,
  endDuty,
  dutiesFor,
  dutyCovering,
  resolveSalePlace,
  writeSalePlace,
  canReadVehicle,
  covers,
};
