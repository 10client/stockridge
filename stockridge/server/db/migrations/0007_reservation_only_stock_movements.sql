-- =====================================================================
-- STOCKRIDGE — migration 0007: reservation-only stock movements
-- =====================================================================
--
-- WHAT WAS WRONG
-- --------------
-- stock_movements declared:
--
--     direction INTEGER NOT NULL CHECK (direction IN (1,-1)),
--     quantity  INTEGER NOT NULL CHECK (quantity > 0),
--
-- That forces every movement to be either "units came in" or "units went out".
-- But a LAYAWAY_RESERVE does neither. A hold does not move a single unit: the
-- goods are still on the shelf, they are simply spoken for. The only thing that
-- changes is stock_batches.quantity_reserved, which this table already has a
-- column for — reservation_delta — and which the direction/quantity constraints
-- made impossible to express.
--
-- The consequence was not theoretical. To satisfy the constraint, the seeding
-- code wrote direction = 1 and quantity = N for a reservation, i.e. it recorded
-- that N units had ARRIVED. The batch balance said 1 unit on hand while the
-- movement history summed to 2. A stock reconciliation — the one report that
-- proves the shelves and the books agree — was wrong for every branch with a
-- live hold, and it was wrong in the direction that looks like stock appearing
-- from nowhere.
--
-- WHAT CHANGES
-- ------------
-- direction may now be 0, meaning "no physical movement; reservation effect
-- only". quantity may now be 0 for the same reason. The three combinations are
-- then:
--
--   direction = +1, quantity > 0   units arrived              (receipt, return)
--   direction = -1, quantity > 0   units left                 (sale, dispatch)
--   direction =  0, quantity = 0   reservation changed only   (hold, allocation)
--
-- A new CHECK forbids the fourth, meaningless combination: direction 0 with a
-- non-zero quantity. A movement that claims to move nothing while recording a
-- quantity is exactly the ambiguity this migration removes, so it is rejected
-- rather than left to be interpreted differently by two reports.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. This is the
-- documented 12-step procedure, condensed: create the new shape, copy the data,
-- drop the old table, rename. Foreign keys are switched off for the duration
-- because the drop/rename would otherwise cascade into the tables that reference
-- stock_movements — and switched back on immediately after, since a database
-- left with foreign_keys OFF silently stops enforcing every relationship in the
-- schema.

PRAGMA foreign_keys = OFF;

DROP VIEW IF EXISTS v_slow_moving_stock;

CREATE TABLE stock_movements_new (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    movement_type     TEXT NOT NULL
                      CHECK (movement_type IN ('RECEIPT','SALE','SALE_RETURN','TRANSFER_OUT','TRANSFER_IN',
                                               'ADJUSTMENT','LAYAWAY_RESERVE','LAYAWAY_RELEASE',
                                               'DELIVERY_DISPATCH','WARRANTY_SWAP','OPENING_BALANCE','WRITE_OFF')),
    -- +1 in, -1 out, 0 = reservation effect only (no unit moved).
    direction         INTEGER NOT NULL CHECK (direction IN (1, 0, -1)),
    quantity          INTEGER NOT NULL CHECK (quantity >= 0),
    value_kobo        INTEGER NOT NULL DEFAULT 0,
    unit_cost         REAL NOT NULL DEFAULT 0,
    -- Change to the RESERVATION rather than the physical count. Positive
    -- reserves units (a hold, a delivery allocation); negative releases them.
    reservation_delta INTEGER NOT NULL DEFAULT 0,
    source_type       TEXT,
    source_id         TEXT,
    serial_number     TEXT,
    reference         TEXT,
    moved_by          TEXT REFERENCES users(id),
    moved_at          TEXT NOT NULL DEFAULT (datetime('now')),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    -- The two meaningful shapes, and only those:
    --   a physical movement carries a quantity and no reservation effect
    --   a reservation movement carries a reservation effect and no quantity
    -- Allowing both on one row would let a single movement be counted twice by
    -- a report that reads quantity and again by one that reads reservation_delta.
    CHECK (
      (direction IN (1,-1) AND quantity > 0)
      OR
      (direction = 0 AND quantity = 0)
    )
);

INSERT INTO stock_movements_new (
    id, business_id, branch_id, product_id, stock_batch_id, movement_type,
    direction, quantity, value_kobo, unit_cost, reservation_delta,
    source_type, source_id, serial_number, reference, moved_by, moved_at, notes, created_at)
SELECT
    id, business_id, branch_id, product_id, stock_batch_id, movement_type,
    -- Existing LAYAWAY_RESERVE rows were written as direction=1 with a
    -- quantity, which is the mis-recording this migration exists to correct.
    -- Convert them on the way across: they become reservation-only movements,
    -- and the phantom arrival disappears from the reconciliation.
    CASE WHEN movement_type IN ('LAYAWAY_RESERVE','LAYAWAY_RELEASE') THEN 0 ELSE direction END,
    CASE WHEN movement_type IN ('LAYAWAY_RESERVE','LAYAWAY_RELEASE') THEN 0 ELSE quantity END,
    value_kobo, unit_cost,
    CASE WHEN movement_type = 'LAYAWAY_RESERVE' AND (reservation_delta IS NULL OR reservation_delta = 0)
         THEN quantity ELSE reservation_delta END,
    source_type, source_id, serial_number, reference, moved_by, moved_at, notes, created_at
FROM stock_movements;

DROP TABLE stock_movements;

ALTER TABLE stock_movements_new RENAME TO stock_movements;

CREATE INDEX idx_stock_movements_product ON stock_movements(branch_id, product_id, moved_at);
CREATE INDEX idx_stock_movements_batch ON stock_movements(stock_batch_id, moved_at);
CREATE INDEX idx_stock_movements_source ON stock_movements(source_type, source_id);
CREATE INDEX idx_stock_movements_date ON stock_movements(business_id, moved_at);
CREATE INDEX idx_stock_movements_type ON stock_movements(movement_type, moved_at);
-- The reconciliation query: physical movements only, per batch.
CREATE INDEX idx_stock_movements_physical
    ON stock_movements(stock_batch_id, direction) WHERE direction IN (1,-1);

CREATE VIEW v_slow_moving_stock AS
SELECT
    sb.branch_id,
    b.name AS branch_name,
    sb.product_id,
    p.name AS product_name,
    p.sku,
    pc.name AS category_name,
    SUM(sb.quantity_on_hand)                                   AS units_on_hand,
    SUM(sb.quantity_on_hand * sb.cost_per_unit)                AS cost_value,
    MAX(sm.moved_at)                                           AS last_movement_at,
    CAST(julianday('now') - julianday(MAX(COALESCE(sm.moved_at, sb.received_at))) AS INTEGER) AS days_since_movement,
    COUNT(DISTINCT sm.id)                                      AS movement_count
FROM stock_batches sb
JOIN products p ON p.id = sb.product_id
JOIN branches b ON b.id = sb.branch_id
LEFT JOIN product_categories pc ON pc.id = p.category_id
LEFT JOIN stock_movements sm ON sm.product_id = sb.product_id
     AND sm.branch_id = sb.branch_id AND sm.direction = -1
WHERE sb.is_deleted = 0 AND sb.quantity_on_hand > 0
GROUP BY sb.branch_id, sb.product_id
HAVING days_since_movement > 60 OR movement_count = 0;

PRAGMA foreign_keys = ON;
