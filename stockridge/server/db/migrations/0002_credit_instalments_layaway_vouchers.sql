-- =====================================================================
-- STOCKRIDGE — migration 0002: credit, instalments, layaway, vouchers
-- =====================================================================
-- The flows that let a Nigerian retailer sell something the customer cannot
-- pay for in full today. Each one creates a LIABILITY or a RECEIVABLE, and
-- each is modelled so that the balance is DERIVED from evidence rather than
-- stored as a running total — a stored total can be written to directly, and
-- once it can be, it drifts from the sum of its entries and nobody knows which
-- figure to believe.

-- ---------------------------------------------------------------------
-- DEBTOR LEDGER  (what customers owe us) — APPEND-ONLY
-- ---------------------------------------------------------------------
CREATE TABLE debtor_ledger (
    id                  TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    branch_id           TEXT NOT NULL REFERENCES branches(id),
    customer_id         TEXT NOT NULL REFERENCES customers(id),
    entry_type          TEXT NOT NULL
                        CHECK (entry_type IN ('SALE','PAYMENT','CREDIT_NOTE','DEBIT_NOTE','INSTALLMENT_DUE',
                                              'BAD_DEBT','REVERSAL','OPENING_BALANCE','FX_REVALUATION','ADVANCE')),
    direction           TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
    amount_kobo         INTEGER NOT NULL CHECK (amount_kobo > 0),
    amount              REAL NOT NULL,
    entry_date          TEXT NOT NULL,
    -- TERMS. Without a terms code and a due date the debtor report is a list of
    -- numbers with no dates, and "who is late?" is unanswerable.
    terms_code          TEXT NOT NULL DEFAULT 'CASH',
    due_date            TEXT,
    source_type         TEXT,          -- 'SALE' | 'RETURN' | 'EXPENSE' | 'PLAN' | 'DELIVERY' | 'MANUAL'
    source_id           TEXT,
    reference           TEXT,
    -- A payment may be matched to a specific debt rather than applied FIFO.
    applies_to_entry_id TEXT REFERENCES debtor_ledger(id),
    method              TEXT,          -- how a PAYMENT was received
    payment_reference   TEXT,
    received_by         TEXT REFERENCES users(id),
    currency            TEXT NOT NULL DEFAULT 'NGN',
    fx_rate             REAL NOT NULL DEFAULT 1,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    -- SOFT DELETE ONLY. A ledger row must never be hard-deleted: deleting the
    -- evidence is the one action that makes an audit trail worthless. The row
    -- is flagged, and REVERSAL exists as the honest way to undo an entry.
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_debtor_ledger_customer ON debtor_ledger(customer_id, entry_date) WHERE is_deleted = 0;
CREATE INDEX idx_debtor_ledger_branch ON debtor_ledger(branch_id, entry_date) WHERE is_deleted = 0;
CREATE INDEX idx_debtor_ledger_business ON debtor_ledger(business_id, entry_date) WHERE is_deleted = 0;
CREATE INDEX idx_debtor_ledger_due ON debtor_ledger(customer_id, due_date) WHERE is_deleted = 0;
CREATE INDEX idx_debtor_ledger_source ON debtor_ledger(source_type, source_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- CREDITOR LEDGER  (what we owe suppliers) — APPEND-ONLY
-- ---------------------------------------------------------------------
CREATE TABLE creditor_ledger (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    supplier_id       TEXT NOT NULL REFERENCES suppliers(id),
    entry_type        TEXT NOT NULL
                      CHECK (entry_type IN ('PURCHASE','PAYMENT','DEBIT_NOTE','CREDIT_NOTE','WHT_DEDUCTED',
                                            'REVERSAL','OPENING_BALANCE','FREIGHT','ADVANCE')),
    direction         TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
    amount_kobo       INTEGER NOT NULL CHECK (amount_kobo > 0),
    amount            REAL NOT NULL,
    entry_date        TEXT NOT NULL,
    terms_code        TEXT NOT NULL DEFAULT 'CASH',
    due_date          TEXT,
    source_type       TEXT,
    source_id         TEXT,
    reference         TEXT,
    applies_to_entry_id TEXT REFERENCES creditor_ledger(id),
    wht_entry_id      TEXT,
    paid_by           TEXT REFERENCES users(id),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_creditor_ledger_supplier ON creditor_ledger(supplier_id, entry_date) WHERE is_deleted = 0;
CREATE INDEX idx_creditor_ledger_branch ON creditor_ledger(branch_id, entry_date) WHERE is_deleted = 0;
CREATE INDEX idx_creditor_ledger_due ON creditor_ledger(supplier_id, due_date) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- CHASE LOG  (who called, when, and what was promised)
-- ---------------------------------------------------------------------
-- A debt nobody calls about is a debt that is never paid. Without this table
-- "we have been chasing them" is an assertion with no evidence, and the same
-- customer gets called three times in a day by three different branches.
CREATE TABLE debt_chase_log (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    customer_id       TEXT NOT NULL REFERENCES customers(id),
    debtor_entry_id   TEXT REFERENCES debtor_ledger(id),
    channel           TEXT NOT NULL
                      CHECK (channel IN ('SMS','PHONE_CALL','WHATSAPP','EMAIL','VISIT','FORMAL_LETTER','LEGAL','WHATSAPP_OR_EMAIL')),
    contact_attempted TEXT NOT NULL,        -- the number/address actually used
    reached           INTEGER NOT NULL DEFAULT 0,
    outcome           TEXT NOT NULL DEFAULT 'NO_ANSWER'
                      CHECK (outcome IN ('NO_ANSWER','PROMISE_TO_PAY','PART_PAYMENT','DISPUTE','REFUSED','UNREACHABLE','ESCALATED','SETTLED')),
    promised_amount_kobo INTEGER,
    promised_date     TEXT,
    amount_outstanding_kobo INTEGER NOT NULL DEFAULT 0,
    days_overdue      INTEGER NOT NULL DEFAULT 0,
    chased_by         TEXT NOT NULL REFERENCES users(id),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_chase_log_customer ON debt_chase_log(customer_id, created_at) WHERE is_deleted = 0;
CREATE INDEX idx_chase_log_promise ON debt_chase_log(promised_date) WHERE promised_date IS NOT NULL AND is_deleted = 0;

-- ---------------------------------------------------------------------
-- INSTALMENT PLANS  ("pay small-small")
-- ---------------------------------------------------------------------
CREATE TABLE instalment_plans (
    id                    TEXT PRIMARY KEY,
    business_id           TEXT NOT NULL REFERENCES businesses(id),
    branch_id             TEXT NOT NULL REFERENCES branches(id),
    plan_number           TEXT NOT NULL,
    customer_id           TEXT NOT NULL REFERENCES customers(id),
    sale_id               TEXT REFERENCES sales(id),
    layaway_hold_id       TEXT REFERENCES layaway_holds(id),
    -- LAYAWAY_BACKED       goods stay in the shop, stock RESERVED, decremented
    --                      on completion. Lowest risk; what most furniture shops
    --                      actually do.
    -- DELIVERED_ON_DEPOSIT goods leave after the deposit, stock decremented now,
    --                      and the balance is an unsecured RECEIVABLE.
    -- Getting this wrong is the difference between a stock report that is right
    -- and one that is out by every unpaid plan in the shop.
    model                 TEXT NOT NULL DEFAULT 'LAYAWAY_BACKED'
                          CHECK (model IN ('LAYAWAY_BACKED','DELIVERED_ON_DEPOSIT')),
    status                TEXT NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT','ACTIVE','COMPLETED','DEFAULTED','CANCELLED','RESTRUCTURED')),
    frequency             TEXT NOT NULL DEFAULT 'MONTHLY'
                          CHECK (frequency IN ('WEEKLY','FORTNIGHTLY','MONTHLY')),
    total_kobo            INTEGER NOT NULL CHECK (total_kobo > 0),
    deposit_kobo          INTEGER NOT NULL DEFAULT 0 CHECK (deposit_kobo >= 0),
    deposit_percent       REAL NOT NULL DEFAULT 0,
    -- A FLAT ADMIN FEE, disclosed up front. Deliberately NOT interest: this is
    -- trade credit on the client's own goods, not lending. A feature that
    -- quietly turned a furniture shop into an unlicensed lender would be a
    -- feature that got the client in trouble, so compound interest is not
    -- modelled anywhere and the fee is a single disclosed figure.
    plan_fee_kobo         INTEGER NOT NULL DEFAULT 0,
    plan_fee_percent      REAL NOT NULL DEFAULT 0,
    financed_kobo         INTEGER NOT NULL DEFAULT 0,
    paid_kobo             INTEGER NOT NULL DEFAULT 0,
    outstanding_kobo      INTEGER NOT NULL DEFAULT 0,
    late_fees_kobo        INTEGER NOT NULL DEFAULT 0,
    instalment_count      INTEGER NOT NULL CHECK (instalment_count > 0),
    late_fee_percent      REAL NOT NULL DEFAULT 0,
    grace_days            INTEGER NOT NULL DEFAULT 7,
    missed_before_default INTEGER NOT NULL DEFAULT 3,
    missed_count          INTEGER NOT NULL DEFAULT 0,
    start_date            TEXT NOT NULL,
    first_due_date        TEXT,
    last_due_date         TEXT,
    completed_at          TEXT,
    defaulted_at          TEXT,
    cancelled_at          TEXT,
    cancelled_by          TEXT REFERENCES users(id),
    cancel_reason         TEXT,
    -- The full schedule as JSON is stored for fast rendering, but the
    -- AUTHORITATIVE rows are in instalment_schedule below. A schedule that
    -- exists only as a blob cannot be queried for "what is due this week".
    schedule_json         TEXT,
    restructured_from_id  TEXT REFERENCES instalment_plans(id),
    created_by            TEXT NOT NULL REFERENCES users(id),
    approved_by           TEXT REFERENCES users(id),
    notes                 TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0,
    -- The schedule must foot: deposit + financed = total + fee.
    CHECK (deposit_kobo + financed_kobo = total_kobo + plan_fee_kobo)
);
CREATE UNIQUE INDEX idx_instalment_plans_number ON instalment_plans(business_id, plan_number) WHERE is_deleted = 0;
CREATE INDEX idx_instalment_plans_customer ON instalment_plans(customer_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_instalment_plans_status ON instalment_plans(business_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_instalment_plans_defaulted ON instalment_plans(status, defaulted_at) WHERE status = 'DEFAULTED' AND is_deleted = 0;

CREATE TABLE instalment_schedule (
    id                     TEXT PRIMARY KEY,
    plan_id                TEXT NOT NULL REFERENCES instalment_plans(id),
    seq                    INTEGER NOT NULL CHECK (seq > 0),
    due_date               TEXT NOT NULL,
    amount_kobo            INTEGER NOT NULL CHECK (amount_kobo > 0),
    amount                 REAL NOT NULL,
    paid_kobo              INTEGER NOT NULL DEFAULT 0,
    paid_at                TEXT,
    status                 TEXT NOT NULL DEFAULT 'SCHEDULED'
                           CHECK (status IN ('SCHEDULED','PAID','MISSED','LATE_PAID','WAIVED','RESTRUCTURED','PART_PAID')),
    late_fee_kobo          INTEGER NOT NULL DEFAULT 0,
    late_fee_waived        INTEGER NOT NULL DEFAULT 0,
    late_fee_waived_by     TEXT REFERENCES users(id),
    debtor_entry_id        TEXT REFERENCES debtor_ledger(id),
    payment_id             TEXT REFERENCES sale_payments(id),
    notes                  TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted             INTEGER NOT NULL DEFAULT 0,
    UNIQUE (plan_id, seq),
    CHECK (paid_kobo <= amount_kobo + late_fee_kobo)
);
CREATE INDEX idx_instalment_schedule_plan ON instalment_schedule(plan_id, seq) WHERE is_deleted = 0;
CREATE INDEX idx_instalment_schedule_due ON instalment_schedule(due_date, status) WHERE is_deleted = 0;
CREATE INDEX idx_instalment_schedule_overdue
    ON instalment_schedule(status, due_date) WHERE status IN ('SCHEDULED','MISSED','PART_PAID') AND is_deleted = 0;

-- A repossession or settlement of a defaulted plan is a money event with its
-- own record: the goods come back into stock and a refund may be due.
CREATE TABLE instalment_settlements (
    id                    TEXT PRIMARY KEY,
    plan_id               TEXT NOT NULL REFERENCES instalment_plans(id),
    settlement_type       TEXT NOT NULL
                          CHECK (settlement_type IN ('COMPLETED','REPOSSESSION','WRITE_OFF','RESTRUCTURE','CANCEL_REFUND','LEGAL_SETTLEMENT')),
    paid_total_kobo       INTEGER NOT NULL DEFAULT 0,
    restocking_fee_kobo   INTEGER NOT NULL DEFAULT 0,
    refund_due_kobo       INTEGER NOT NULL DEFAULT 0,
    written_off_kobo      INTEGER NOT NULL DEFAULT 0,
    stock_returned        INTEGER NOT NULL DEFAULT 0,
    new_plan_id           TEXT REFERENCES instalment_plans(id),
    processed_by          TEXT NOT NULL REFERENCES users(id),
    approved_by           TEXT REFERENCES users(id),
    notes                 TEXT,
    settled_at            TEXT NOT NULL DEFAULT (datetime('now')),
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_instalment_settlements_plan ON instalment_settlements(plan_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- LAYAWAY HOLDS  ("we'll keep it for you")
-- ---------------------------------------------------------------------
-- NOT a sale and NOT an instalment plan, though it is the front door to both.
-- The critical property: a held item is still ON HAND but NOT SELLABLE, so it
-- increments stock_batches.quantity_reserved for as long as the hold lives.
CREATE TABLE layaway_holds (
    id                  TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    branch_id           TEXT NOT NULL REFERENCES branches(id),
    hold_number         TEXT NOT NULL,
    customer_id         TEXT REFERENCES customers(id),
    customer_name       TEXT,
    customer_phone      TEXT,
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','CONVERTED','RELEASED','EXPIRED','CANCELLED')),
    reason              TEXT NOT NULL DEFAULT 'CUSTOMER_REQUEST'
                        CHECK (reason IN ('CUSTOMER_REQUEST','DEPOSIT_PAID','AWAITING_PAYMENT','AWAITING_DELIVERY',
                                          'CORPORATE_PO','WARRANTY_SWAP','OTHER')),
    deposit_kobo        INTEGER NOT NULL DEFAULT 0 CHECK (deposit_kobo >= 0),
    deposit             REAL NOT NULL DEFAULT 0,
    total_value_kobo    INTEGER NOT NULL DEFAULT 0,
    total_value         REAL NOT NULL DEFAULT 0,
    balance_kobo        INTEGER NOT NULL DEFAULT 0,
    deposit_percent     REAL NOT NULL DEFAULT 0,
    held_from           TEXT NOT NULL,
    expires_on          TEXT NOT NULL,
    extension_count     INTEGER NOT NULL DEFAULT 0,
    converted_sale_id   TEXT REFERENCES sales(id),
    converted_plan_id   TEXT REFERENCES instalment_plans(id),
    released_at         TEXT,
    released_by         TEXT REFERENCES users(id),
    release_reason      TEXT,
    -- A forfeited deposit is OTHER INCOME, not sales revenue: no goods left the
    -- shop, so recognising it as revenue would overstate turnover and understate
    -- margin.
    forfeited_kobo      INTEGER NOT NULL DEFAULT 0,
    refunded_kobo       INTEGER NOT NULL DEFAULT 0,
    created_by          TEXT NOT NULL REFERENCES users(id),
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_layaway_holds_number ON layaway_holds(business_id, hold_number) WHERE is_deleted = 0;
CREATE INDEX idx_layaway_holds_branch ON layaway_holds(branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_layaway_holds_customer ON layaway_holds(customer_id) WHERE is_deleted = 0;
-- The nightly release job needs "active and past its date" to be a seek.
CREATE INDEX idx_layaway_holds_expiry
    ON layaway_holds(expires_on) WHERE status = 'ACTIVE' AND is_deleted = 0;

CREATE TABLE layaway_hold_items (
    id              TEXT PRIMARY KEY,
    hold_id         TEXT NOT NULL REFERENCES layaway_holds(id),
    product_id      TEXT NOT NULL REFERENCES products(id),
    stock_batch_id  TEXT REFERENCES stock_batches(id),
    serial_number   TEXT,
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_kobo INTEGER NOT NULL DEFAULT 0,
    line_total_kobo INTEGER NOT NULL DEFAULT 0,
    reserved        INTEGER NOT NULL DEFAULT 1,     -- is stock currently reserved for this line?
    released_at     TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_layaway_items_hold ON layaway_hold_items(hold_id) WHERE is_deleted = 0;
CREATE INDEX idx_layaway_items_product ON layaway_hold_items(product_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- VOUCHERS / GIFT CARDS
-- ---------------------------------------------------------------------
-- An unbounded, guessable voucher code is a shrinkage vector, so: 12 chars
-- from an unambiguous alphabet (no I, O, 0, 1 — a code read aloud over a phone
-- call must not be misheard as a different valid code), single-use by default,
-- expiry-dated, and redeemed inside the same transaction as the sale.
CREATE TABLE vouchers (
    id                 TEXT PRIMARY KEY,
    business_id        TEXT NOT NULL REFERENCES businesses(id),
    code               TEXT NOT NULL,
    voucher_type       TEXT NOT NULL DEFAULT 'GIFT_CARD'
                       CHECK (voucher_type IN ('GIFT_CARD','PROMO_CODE','CREDIT_NOTE','STAFF_VOUCHER','COMPENSATION','LOYALTY_REWARD')),
    -- A fixed-value voucher carries a balance that draws down; a percentage
    -- voucher does not.
    is_percentage      INTEGER NOT NULL DEFAULT 0,
    face_value_kobo    INTEGER NOT NULL DEFAULT 0,
    balance_kobo       INTEGER NOT NULL DEFAULT 0,
    percent_off        REAL,
    max_discount_kobo  INTEGER,
    min_spend_kobo     INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','PART_REDEEMED','REDEEMED','EXPIRED','CANCELLED')),
    issued_to_customer_id TEXT REFERENCES customers(id),
    issued_to_name     TEXT,
    issued_by          TEXT REFERENCES users(id),
    issued_at          TEXT NOT NULL DEFAULT (datetime('now')),
    issued_sale_id     TEXT REFERENCES sales(id),
    expires_on         TEXT,
    single_use         INTEGER NOT NULL DEFAULT 1,
    redemption_count   INTEGER NOT NULL DEFAULT 0,
    -- Restricting a voucher to a branch or a category is what makes a
    -- compensation voucher safe to issue: it cannot be cashed out elsewhere.
    valid_branch_id    TEXT REFERENCES branches(id),
    valid_category_id  TEXT REFERENCES product_categories(id),
    cancelled_by       TEXT REFERENCES users(id),
    cancelled_at       TEXT,
    cancel_reason      TEXT,
    notes              TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_vouchers_code ON vouchers(business_id, code) WHERE is_deleted = 0;
CREATE INDEX idx_vouchers_status ON vouchers(business_id, status, expires_on) WHERE is_deleted = 0;

CREATE TABLE voucher_redemptions (
    id            TEXT PRIMARY KEY,
    voucher_id    TEXT NOT NULL REFERENCES vouchers(id),
    sale_id       TEXT NOT NULL REFERENCES sales(id),
    branch_id     TEXT NOT NULL REFERENCES branches(id),
    amount_kobo   INTEGER NOT NULL CHECK (amount_kobo > 0),
    amount        REAL NOT NULL,
    redeemed_by   TEXT NOT NULL REFERENCES users(id),
    redeemed_at   TEXT NOT NULL DEFAULT (datetime('now')),
    reversed      INTEGER NOT NULL DEFAULT 0,
    reversed_at   TEXT,
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_voucher_redemptions_voucher ON voucher_redemptions(voucher_id) ;
CREATE INDEX idx_voucher_redemptions_sale ON voucher_redemptions(sale_id);
