-- A dispatch vehicle is assigned to a member of staff for a day, a week, or until
-- a manager changes the driver. delivery_vehicles.driver_user_id is the usual
-- driver and is not this. A sale on the plant floor and a sale from that vehicle
-- are different places on the same counter. An expense can belong to the vehicle
-- the same way a plant expense can belong to a machine.

ALTER TABLE sales ADD COLUMN sale_place TEXT;
ALTER TABLE sales ADD COLUMN vehicle_id TEXT REFERENCES delivery_vehicles(id);

ALTER TABLE expenses ADD COLUMN vehicle_id TEXT REFERENCES delivery_vehicles(id);

ALTER TABLE customer_bills ADD COLUMN sale_place TEXT;
ALTER TABLE customer_bills ADD COLUMN vehicle_id TEXT REFERENCES delivery_vehicles(id);

CREATE TABLE vehicle_duties (
    id            TEXT PRIMARY KEY,
    business_id   TEXT NOT NULL REFERENCES businesses(id),
    vehicle_id    TEXT NOT NULL REFERENCES delivery_vehicles(id),
    user_id       TEXT NOT NULL REFERENCES users(id),
    period        TEXT NOT NULL,
    starts_on     TEXT NOT NULL,
    ends_on       TEXT,
    ended_at      TEXT,
    assigned_by   TEXT REFERENCES users(id),
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_vehicle_duties_open ON vehicle_duties(vehicle_id, starts_on) WHERE is_deleted = 0 AND ended_at IS NULL;
CREATE INDEX idx_vehicle_duties_user ON vehicle_duties(user_id, starts_on) WHERE is_deleted = 0 AND ended_at IS NULL;
CREATE INDEX idx_sales_vehicle ON sales(vehicle_id) WHERE is_deleted = 0 AND vehicle_id IS NOT NULL;
CREATE INDEX idx_expenses_vehicle ON expenses(vehicle_id) WHERE is_deleted = 0 AND vehicle_id IS NOT NULL;
