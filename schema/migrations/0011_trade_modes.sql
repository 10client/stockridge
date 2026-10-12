-- =====================================================================
-- 0011_trade_modes.sql — RETAIL, WHOLESALE, HIRE AND LEASE
-- =====================================================================
-- A sale and a hire are not the same movement of stock, and a deposit is
-- not income. This file adds the columns and the agreement book. It does
-- not touch 0001 or 0010, and it does not price a single shared good.
--
-- Existing products stay sale-only (offers_sale = 1, hire and lease off,
-- rates empty). A shop that hires sets the rate itself.
-- =====================================================================

ALTER TABLE products ADD COLUMN offers_sale INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN offers_hire INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN offers_lease INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN hire_price_per_day REAL;
ALTER TABLE products ADD COLUMN lease_price_per_month REAL;
ALTER TABLE products ADD COLUMN hire_deposit REAL;
ALTER TABLE products ADD COLUMN lease_deposit REAL;
ALTER TABLE products ADD COLUMN min_hire_days INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN min_lease_months INTEGER NOT NULL DEFAULT 1;

ALTER TABLE sale_items ADD COLUMN channel TEXT NOT NULL DEFAULT 'RETAIL';
ALTER TABLE sales ADD COLUMN trade_mix TEXT;

-- The promise that a unit is out, or will be out, for a span of days or
-- months. Stock is not decremented. Availability is this book, read by date.
CREATE TABLE asset_agreements (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    customer_id       TEXT REFERENCES customers(id),
    customer_name     TEXT,
    customer_phone    TEXT,
    sale_id           TEXT,
    kind              TEXT NOT NULL CHECK (kind IN ('HIRE', 'LEASE')),
    status            TEXT NOT NULL CHECK (status IN ('OUT', 'RETURNED', 'BOUGHT_OUT', 'CANCELLED')) DEFAULT 'OUT',
    starts_on         TEXT NOT NULL,
    ends_on           TEXT NOT NULL,
    periods           INTEGER NOT NULL,
    period_unit       TEXT NOT NULL CHECK (period_unit IN ('DAY', 'MONTH')),
    fee_total         REAL NOT NULL DEFAULT 0,
    deposit_due       REAL NOT NULL DEFAULT 0,
    deposit_held      REAL NOT NULL DEFAULT 0,
    deposit_method    TEXT,
    venue             TEXT,
    notes             TEXT,
    returned_at       TEXT,
    return_condition  TEXT CHECK (return_condition IS NULL OR return_condition IN ('GOOD', 'DAMAGED', 'MISSING')),
    damage_charge     REAL NOT NULL DEFAULT 0,
    late_days         INTEGER NOT NULL DEFAULT 0,
    late_charge       REAL NOT NULL DEFAULT 0,
    amount_owed       REAL NOT NULL DEFAULT 0,
    buyout_price      REAL,
    bought_out_sale_id TEXT,
    created_by        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_agreements_branch ON asset_agreements(branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_agreements_sale ON asset_agreements(sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX idx_agreements_customer ON asset_agreements(customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE asset_agreement_lines (
    id                TEXT PRIMARY KEY,
    agreement_id      TEXT NOT NULL REFERENCES asset_agreements(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    variant_id        TEXT,
    sale_item_id      TEXT,
    product_name      TEXT NOT NULL,
    sku               TEXT,
    serial_no         TEXT,
    quantity          REAL NOT NULL,
    quantity_in_base  REAL NOT NULL,
    unit_code         TEXT,
    rate              REAL NOT NULL DEFAULT 0,
    deposit           REAL NOT NULL DEFAULT 0,
    asset_cost        REAL NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_agreement_lines_product ON asset_agreement_lines(product_id) WHERE is_deleted = 0;
CREATE INDEX idx_agreement_lines_agreement ON asset_agreement_lines(agreement_id);

CREATE TABLE asset_agreement_schedule (
    id            TEXT PRIMARY KEY,
    agreement_id  TEXT NOT NULL REFERENCES asset_agreements(id),
    period_no     INTEGER NOT NULL,
    due_on        TEXT NOT NULL,
    amount        REAL NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'WAIVED')) DEFAULT 'PENDING',
    paid_at       TEXT,
    sale_id       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_agreement_schedule_due ON asset_agreement_schedule(agreement_id, period_no);

-- Hire income, lease income, and the deposit that is not either of them.
-- Inserted for businesses that already have a chart. A business created
-- after this file is seeded from the chart in glService, which now lists
-- the same codes.
INSERT INTO gl_accounts (id, business_id, code, name, account_type, is_system, is_control, normal_side, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, '4020', 'Hire income', 'REVENUE', 1, 1, 'CREDIT', 1, datetime('now'), datetime('now')
FROM businesses b
WHERE b.is_deleted = 0
  AND NOT EXISTS (SELECT 1 FROM gl_accounts g WHERE g.business_id = b.id AND g.code = '4020' AND g.is_deleted = 0);

INSERT INTO gl_accounts (id, business_id, code, name, account_type, is_system, is_control, normal_side, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, '4030', 'Lease income', 'REVENUE', 1, 1, 'CREDIT', 1, datetime('now'), datetime('now')
FROM businesses b
WHERE b.is_deleted = 0
  AND NOT EXISTS (SELECT 1 FROM gl_accounts g WHERE g.business_id = b.id AND g.code = '4030' AND g.is_deleted = 0);

INSERT INTO gl_accounts (id, business_id, code, name, account_type, is_system, is_control, normal_side, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, '4040', 'Late return and damage', 'REVENUE', 1, 1, 'CREDIT', 1, datetime('now'), datetime('now')
FROM businesses b
WHERE b.is_deleted = 0
  AND NOT EXISTS (SELECT 1 FROM gl_accounts g WHERE g.business_id = b.id AND g.code = '4040' AND g.is_deleted = 0);

INSERT INTO gl_accounts (id, business_id, code, name, account_type, is_system, is_control, normal_side, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, '2220', 'Hire and lease deposits held', 'LIABILITY', 1, 1, 'CREDIT', 1, datetime('now'), datetime('now')
FROM businesses b
WHERE b.is_deleted = 0
  AND NOT EXISTS (SELECT 1 FROM gl_accounts g WHERE g.business_id = b.id AND g.code = '2220' AND g.is_deleted = 0);
