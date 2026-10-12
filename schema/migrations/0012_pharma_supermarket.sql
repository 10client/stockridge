-- Pharmaceutical and supermarket vertical.
-- The Greenbook is a reference catalogue. It is not the shared Nigerian-market list,
-- and it does not price anything. A shop copies a row into its own catalogue when it stocks it.
-- Semicolons that appear inside Greenbook text are written as char(59) so a statement
-- splitter that cuts on every semicolon cannot break a row. Each insert stays under 70KB.

CREATE TABLE IF NOT EXISTS nafdac_catalog (
    id                  INTEGER PRIMARY KEY,
    nafdac_reg_no       TEXT,
    product_name        TEXT NOT NULL,
    ingredient_name     TEXT,
    ingredient_key      TEXT,
    strength            TEXT,
    dosage_form         TEXT,
    manufacturer        TEXT,
    route               TEXT,
    pack_size           TEXT,
    atc_code            TEXT,
    category            TEXT,
    source_category     TEXT,
    base_unit           TEXT NOT NULL DEFAULT 'unit',
    is_controlled       INTEGER NOT NULL DEFAULT 0,
    dispensing_type     TEXT NOT NULL DEFAULT 'OTC' CHECK (dispensing_type IN ('OTC', 'POM')),
    approval_date       TEXT,
    registration_expiry TEXT,
    search_blob         TEXT
);

CREATE INDEX IF NOT EXISTS idx_nafdac_catalog_search ON nafdac_catalog(search_blob);
CREATE INDEX IF NOT EXISTS idx_nafdac_catalog_ingredient ON nafdac_catalog(ingredient_key);
CREATE INDEX IF NOT EXISTS idx_nafdac_catalog_name ON nafdac_catalog(product_name);
CREATE INDEX IF NOT EXISTS idx_nafdac_catalog_nafdac ON nafdac_catalog(nafdac_reg_no);
CREATE INDEX IF NOT EXISTS idx_nafdac_catalog_category ON nafdac_catalog(category);

ALTER TABLE products ADD COLUMN dispensing_class TEXT;
ALTER TABLE products ADD COLUMN is_controlled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN nafdac_catalog_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_products_dispensing ON products(dispensing_class);
CREATE INDEX IF NOT EXISTS idx_products_nafdac ON products(nafdac_catalog_id);

CREATE TABLE IF NOT EXISTS prescriptions (
    id                        TEXT PRIMARY KEY,
    business_id               TEXT NOT NULL,
    branch_id                 TEXT NOT NULL,
    sale_id                   TEXT NOT NULL,
    sale_item_id              TEXT NOT NULL,
    product_id                TEXT NOT NULL,
    prescriber_name           TEXT NOT NULL,
    prescriber_pcn_or_mdcn_no TEXT,
    patient_name              TEXT,
    patient_phone             TEXT,
    dosage_notes              TEXT,
    recorded_by               TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted                INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prescriptions_sale ON prescriptions(sale_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_branch ON prescriptions(branch_id, created_at);

CREATE TABLE IF NOT EXISTS controlled_substance_register (
    id                 TEXT PRIMARY KEY,
    business_id        TEXT NOT NULL,
    branch_id          TEXT NOT NULL,
    sale_id            TEXT,
    sale_item_id       TEXT,
    product_id         TEXT NOT NULL,
    entry_type         TEXT NOT NULL DEFAULT 'DISPENSE' CHECK (entry_type IN ('DISPENSE', 'VOID')),
    quantity_dispensed REAL NOT NULL,
    buyer_name         TEXT NOT NULL,
    buyer_phone        TEXT NOT NULL,
    buyer_id_type      TEXT,
    buyer_id_number    TEXT,
    prescription_id    TEXT,
    dispensed_by       TEXT NOT NULL,
    notes              TEXT,
    prev_hash          TEXT,
    entry_hash         TEXT NOT NULL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_controlled_branch ON controlled_substance_register(branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_controlled_sale ON controlled_substance_register(sale_id);
CREATE INDEX IF NOT EXISTS idx_controlled_product ON controlled_substance_register(product_id);
