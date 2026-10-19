-- turso: foreign_keys off
-- 0024 — A RENTAL SERVICES BRANCH
--
-- The branch-type check lived in 0001 and cannot be edited. SQLite cannot
-- alter a CHECK, so the branches table is rebuilt with RENTAL added.
-- Row ids do not change. Sales, tills, hire agreements and journal lines
-- that point at a branch still point at it.
--
-- Foreign keys must be off for the drop, because other tables reference
-- branches. The Turso migrator reads the marker above and runs this file
-- as one transaction with foreign keys off. Do not apply it one statement
-- at a time with foreign keys on.

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS branches_rebuilt;

CREATE TABLE branches_rebuilt (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    name        TEXT NOT NULL,
    code        TEXT,
    branch_type TEXT NOT NULL DEFAULT 'RETAIL' CHECK (branch_type IN ('RETAIL','WHOLESALE','WAREHOUSE','SHOWROOM','RENTAL','MIXED')),
    address     TEXT,
    city        TEXT,
    state       TEXT,
    lga         TEXT,
    phone       TEXT,
    email       TEXT,
    latitude    REAL,
    longitude   REAL,
    geofence_radius_meters INTEGER NOT NULL DEFAULT 100,
    attendance_mode TEXT NOT NULL DEFAULT 'GEOLOCATION' CHECK (attendance_mode IN ('GEOLOCATION','REGISTERED_DEVICE','BOTH','NONE')),
    opening_cash REAL NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO branches_rebuilt (
    id, business_id, name, code, branch_type, address, city, state, lga, phone, email,
    latitude, longitude, geofence_radius_meters, attendance_mode, opening_cash,
    is_active, created_at, updated_at, is_deleted
)
SELECT
    id, business_id, name, code, branch_type, address, city, state, lga, phone, email,
    latitude, longitude, geofence_radius_meters, attendance_mode, opening_cash,
    is_active, created_at, updated_at, is_deleted
FROM branches;

DROP TABLE branches;

ALTER TABLE branches_rebuilt RENAME TO branches;

CREATE INDEX idx_branches_business ON branches (business_id) WHERE is_deleted = 0;
CREATE UNIQUE INDEX idx_branches_code_per_business ON branches (business_id, code) WHERE code IS NOT NULL AND is_deleted = 0;

-- A hire or lease business whose branch was stored as retail had no other
-- choice. That default is the rental yard. A type somebody chose, including
-- mixed, is left as it is.
UPDATE branches
SET branch_type = 'RENTAL', updated_at = datetime('now')
WHERE is_deleted = 0
  AND branch_type = 'RETAIL'
  AND business_id IN (
    SELECT id FROM businesses
    WHERE is_deleted = 0
      AND profile_code IN ('EVENT_RENTAL', 'EQUIPMENT_RENTAL', 'LEASING')
  );

PRAGMA foreign_keys = ON;
