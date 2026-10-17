-- =====================================================================
-- 0021 — MACHINES, TOOLS, AND THE STOCK THEY USE
-- =====================================================================
-- A filling line, an oven, a UV lamp or a sealing jaw is not a bag of
-- flour. It is gotten once. The date and the price stay on it. Each
-- repair is an expense already on the books, pointed at this machine,
-- so the amount spent keeping it running is a sum, not a second ledger.
-- When it stops working, that date stays. It is not deleted.
--
-- Production stock — film rolls, flour, treatment chemical — stays in
-- stock_batches. This migration does not invent a parallel inventory.
--
-- Applied migrations are not edited.
-- =====================================================================

CREATE TABLE plant_assets (
    id              TEXT PRIMARY KEY,
    business_id     TEXT NOT NULL,
    branch_id       TEXT,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('MACHINE', 'TOOL')),
    acquired_at     TEXT NOT NULL,
    purchase_price  REAL NOT NULL DEFAULT 0,
    supplier_name   TEXT,
    serial_no       TEXT,
    status          TEXT NOT NULL CHECK (status IN ('WORKING', 'STOPPED')) DEFAULT 'WORKING',
    stopped_at      TEXT,
    stopped_reason  TEXT,
    notes           TEXT,
    created_by      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_plant_assets_business ON plant_assets(business_id, status) WHERE is_deleted = 0;

ALTER TABLE expenses ADD COLUMN plant_asset_id TEXT;
CREATE INDEX idx_expenses_plant_asset ON expenses(plant_asset_id) WHERE plant_asset_id IS NOT NULL AND is_deleted = 0;
