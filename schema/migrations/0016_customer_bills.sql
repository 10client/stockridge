-- =====================================================================
-- 0016 — A BILL IS NOT A SALE
-- =====================================================================
-- Warehouse, wholesale, building-materials, furniture and electronics
-- desks print a bill, hold the goods, and print the receipt only after
-- the cashier has taken the money. The goods leave against a release
-- note, not against the bill.
--
-- This is not a new sales.status. The sales CHECK has no billed value,
-- and an applied migration cannot grow that list. An unpaid bill is not
-- revenue, not a receipt, and not a row in the sales book. Paying it
-- creates the sale. Cancelling it, or letting it expire, releases the hold.
--
-- quantity_reserved already exists on stock_batches. The trigger below
-- is what makes the hold atomic: a second desk cannot promise the same
-- units, because the insert aborts when the free quantity is not there.
-- Deleting a hold row does NOT release stock. Payment consumes the
-- reservation inside the sale. A delete-trigger would release it twice.
-- =====================================================================

CREATE TABLE customer_bills (
    id                  TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    branch_id           TEXT NOT NULL REFERENCES branches(id),
    bill_no             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PAYING', 'PAID', 'CANCELLED', 'EXPIRED')),
    customer_id         TEXT,
    customer_name       TEXT NOT NULL,
    customer_phone      TEXT,
    sale_type           TEXT NOT NULL DEFAULT 'RETAIL',
    subtotal            REAL NOT NULL DEFAULT 0,
    discount_amount     REAL NOT NULL DEFAULT 0,
    discount_reason     TEXT,
    delivery_fee        REAL NOT NULL DEFAULT 0,
    delivery_required   INTEGER NOT NULL DEFAULT 0,
    delivery_address    TEXT,
    vat_amount          REAL NOT NULL DEFAULT 0,
    total               REAL NOT NULL,
    currency_code       TEXT NOT NULL DEFAULT 'NGN',
    lines_json          TEXT NOT NULL,
    notes               TEXT,
    valid_until         TEXT NOT NULL,
    raised_by           TEXT NOT NULL REFERENCES users(id),
    raised_at           TEXT NOT NULL DEFAULT (datetime('now')),
    payment_started_at  TEXT,
    paid_sale_id        TEXT,
    paid_at             TEXT,
    paid_by             TEXT REFERENCES users(id),
    cancelled_at        TEXT,
    cancelled_by        TEXT REFERENCES users(id),
    cancel_reason       TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_customer_bills_no ON customer_bills(branch_id, bill_no);
CREATE INDEX idx_customer_bills_open ON customer_bills(branch_id, status) WHERE is_deleted = 0;

CREATE TABLE bill_holds (
    id              TEXT PRIMARY KEY,
    bill_id         TEXT NOT NULL REFERENCES customer_bills(id),
    batch_id        TEXT NOT NULL REFERENCES stock_batches(id),
    quantity_base   REAL NOT NULL CHECK (quantity_base > 0),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bill_holds_bill ON bill_holds(bill_id);
CREATE INDEX idx_bill_holds_batch ON bill_holds(batch_id);

CREATE TRIGGER bill_holds_reserve
BEFORE INSERT ON bill_holds
BEGIN
    SELECT RAISE(ABORT, 'STOCK_NOT_FREE')
    WHERE NOT EXISTS (
        SELECT 1 FROM stock_batches
        WHERE id = NEW.batch_id
          AND is_deleted = 0
          AND status = 'ACTIVE'
          AND quantity - quantity_reserved >= NEW.quantity_base
    );
    UPDATE stock_batches
       SET quantity_reserved = quantity_reserved + NEW.quantity_base,
           updated_at = datetime('now')
     WHERE id = NEW.batch_id
       AND is_deleted = 0
       AND status = 'ACTIVE'
       AND quantity - quantity_reserved >= NEW.quantity_base;
END;
