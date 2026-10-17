-- =====================================================================
-- 0017 — WHO CARRIES THE LOAD, AND HOW THEY ARE PAID
-- =====================================================================
-- A water plant and a bakery pick one vehicle type, or a mix of two:
-- motorcycle, tricycle, car, pickup or van. Each type is either a
-- vehicle the business owns (the driver is staff, paid a wage) or a
-- partner who owns the vehicle and is paid a share of the sales they
-- deliver.
--
-- This does not add a role. users.role stays ADMIN, OWNER, MANAGER,
-- STAFF. The vehicle class is a fact about the fleet, not a login.
--
-- Applied migrations are not edited. These columns are new. A furniture
-- delivery that never sets them keeps working: the columns are nullable,
-- and a wage is not invented for a drop that has no arrangement.
-- =====================================================================

ALTER TABLE delivery_vehicles ADD COLUMN vehicle_class TEXT;
ALTER TABLE delivery_vehicles ADD COLUMN arrangement TEXT;
ALTER TABLE delivery_vehicles ADD COLUMN pay_basis TEXT;
ALTER TABLE delivery_vehicles ADD COLUMN sales_share_pct REAL;
ALTER TABLE delivery_vehicles ADD COLUMN driver_name TEXT;
ALTER TABLE delivery_vehicles ADD COLUMN driver_phone TEXT;
ALTER TABLE delivery_vehicles ADD COLUMN driver_user_id TEXT;

ALTER TABLE delivery_jobs ADD COLUMN vehicle_class TEXT;
ALTER TABLE delivery_jobs ADD COLUMN arrangement TEXT;
ALTER TABLE delivery_jobs ADD COLUMN pay_basis TEXT;
ALTER TABLE delivery_jobs ADD COLUMN sales_share_pct REAL;
ALTER TABLE delivery_jobs ADD COLUMN driver_pay REAL DEFAULT 0;
ALTER TABLE delivery_jobs ADD COLUMN vehicle_no TEXT;
ALTER TABLE delivery_jobs ADD COLUMN partner_expense_id TEXT;
