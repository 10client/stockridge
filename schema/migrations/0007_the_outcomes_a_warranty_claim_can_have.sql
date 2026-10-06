-- =====================================================================
-- 0007 — THE OUTCOMES A WARRANTY CLAIM CAN ACTUALLY HAVE
-- =====================================================================
-- The API and the screen have always spoken one vocabulary: REPAIRED,
-- REPLACED, REFUNDED, SUPPLIER_RETURN, PAID_REPAIR, REJECTED
-- (server/routes/afterSales.js, public/js/views/returns.js).
--
-- This table's CHECK constraint was written from an earlier draft —
-- REPAIR, REPLACE, REFUND, REJECT, OUT_OF_WARRANTY — that nothing else in
-- the product uses. NOT ONE VALUE OVERLAPPED. So every resolution the route
-- accepted was refused by SQLite: the manager filled in the form, the claim
-- was written, and the resolve died inside its own transaction on
-- `CHECK constraint failed`, surfacing as 400 CHECK_FAILED. The whole
-- resolution half of warranty claims — the repair, the replacement, the
-- refund, the supplier recovery that pays for it — had never once run.
--
-- It went unnoticed because nothing audited these three routes: the flow
-- coverage tool listed warranty-claims at 0/3, and a route with no audit has
-- no reader to notice that its only possible answer is an error.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt in place.
-- Nothing references warranty_claims (no foreign key, no trigger, no view),
-- and no row can carry a value from either list that the other rejects —
-- nothing was ever successfully resolved — so the copy below is a straight
-- one. The indexes are recreated because DROP TABLE takes them with it.
-- =====================================================================

DROP TABLE IF EXISTS warranty_claims_rebuilt;

CREATE TABLE warranty_claims_rebuilt (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    claim_no       TEXT NOT NULL,
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    sale_id        TEXT REFERENCES sales(id),
    sale_item_id   TEXT REFERENCES sale_items(id),
    serial_id      TEXT REFERENCES serial_numbers(id),
    product_id     TEXT NOT NULL REFERENCES products(id),
    variant_id     TEXT REFERENCES product_variants(id),
    customer_id    TEXT REFERENCES customers(id),
    status         TEXT NOT NULL CHECK (status IN (
        'OPEN','INSPECTION','APPROVED','REJECTED','IN_REPAIR','REPLACED','REFUNDED','CLOSED')) DEFAULT 'OPEN',
    fault_reported TEXT NOT NULL,
    fault_found    TEXT,
    resolution     TEXT CHECK (resolution IS NULL OR resolution IN (
        'REPAIRED','REPLACED','REFUNDED','SUPPLIER_RETURN','PAID_REPAIR','REJECTED')),
    resolution_notes TEXT,
    in_warranty    INTEGER NOT NULL DEFAULT 1,
    warranty_ends_at TEXT,
    -- Supplier recovery: most warranty work in Nigeria is a pass-through
    -- to the importer or manufacturer, and an unrecovered claim is a
    -- straight loss. Tracking it makes the recovery rate visible.
    supplier_id    TEXT REFERENCES suppliers(id),
    supplier_claim_ref TEXT,
    supplier_recovery_amount REAL NOT NULL DEFAULT 0,
    cost_to_business REAL NOT NULL DEFAULT 0,
    replacement_serial_id TEXT REFERENCES serial_numbers(id),
    opened_by      TEXT REFERENCES users(id),
    opened_at      TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_by    TEXT REFERENCES users(id),
    resolved_at    TEXT,
    closed_at      TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);

-- THE COPY CARRIES THE OLD WORDS FORWARD.
--
-- No row can hold a value from the old list — nothing ever wrote one, because the
-- only caller writes the new list and the new list was refused. But a migration
-- that ASSUMES the table is empty is a migration that fails on the one deployment
-- where it is not (an importer, a hand-written fix, a restored backup). The old
-- vocabulary is mapped onto the new one, so a row that exists arrives intact
-- rather than aborting the rebuild with a CHECK failure it cannot explain.
INSERT INTO warranty_claims_rebuilt (id, claim_no, business_id, branch_id, sale_id, sale_item_id, serial_id, product_id, variant_id, customer_id, status, fault_reported, fault_found, resolution, resolution_notes, in_warranty, warranty_ends_at, supplier_id, supplier_claim_ref, supplier_recovery_amount, cost_to_business, replacement_serial_id, opened_by, opened_at, resolved_by, resolved_at, closed_at, notes, created_at, updated_at, is_deleted)
  SELECT id, claim_no, business_id, branch_id, sale_id, sale_item_id, serial_id, product_id, variant_id, customer_id, status, fault_reported, fault_found,
      CASE resolution
        WHEN 'REPAIR' THEN 'REPAIRED'
        WHEN 'REPLACE' THEN 'REPLACED'
        WHEN 'REFUND' THEN 'REFUNDED'
        WHEN 'REJECT' THEN 'REJECTED'
        WHEN 'OUT_OF_WARRANTY' THEN 'PAID_REPAIR'
        ELSE resolution
      END,
      resolution_notes, in_warranty, warranty_ends_at, supplier_id, supplier_claim_ref, supplier_recovery_amount, cost_to_business, replacement_serial_id, opened_by, opened_at, resolved_by, resolved_at, closed_at, notes, created_at, updated_at, is_deleted FROM warranty_claims;

DROP TABLE warranty_claims;
ALTER TABLE warranty_claims_rebuilt RENAME TO warranty_claims;

CREATE UNIQUE INDEX idx_warranty_claim_no ON warranty_claims(claim_no) WHERE is_deleted = 0;
CREATE INDEX idx_warranty_claims_serial ON warranty_claims(serial_id) WHERE serial_id IS NOT NULL;
CREATE INDEX idx_warranty_claims_status ON warranty_claims(branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_warranty_claims_customer ON warranty_claims(customer_id);
