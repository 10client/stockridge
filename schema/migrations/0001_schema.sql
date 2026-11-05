-- StockRidge schema.
-- One file. It replaces the numbered schema migrations 0001 through 0024,
-- except the reference catalogues, which stay in their own files because
-- they are data, not structure: 0010_nigerian_market.sql, 0013_nafdac_catalog.sql,
-- and 0014_mixed_pharmacy_categories.sql.
-- Applied on an empty database. Foreign keys are off for the create, then on.
-- turso: foreign_keys off

PRAGMA foreign_keys = OFF;
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

CREATE TABLE audit_log (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id  TEXT,
    branch_id    TEXT,
    user_id      TEXT,
    username     TEXT,
    action       TEXT NOT NULL,
    entity_type  TEXT,
    entity_id    TEXT,
    before_json  TEXT,
    after_json   TEXT,
    ip_address   TEXT,
    user_agent   TEXT,
    prev_hash    TEXT,
    row_hash     TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bill_holds (
    id              TEXT PRIMARY KEY,
    bill_id         TEXT NOT NULL REFERENCES customer_bills(id),
    batch_id        TEXT NOT NULL REFERENCES stock_batches(id),
    quantity_base   REAL NOT NULL CHECK (quantity_base > 0),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE branch_compliance_records (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id     TEXT NOT NULL REFERENCES branches(id),
    record_type   TEXT NOT NULL,          -- 'CAC','TIN','SONCAP','TRADING_PERMIT','FORESTRY_PERMIT', custom
    record_number TEXT,
    issued_by     TEXT,
    issued_date   TEXT,
    expiry_date   TEXT,                   -- ISO date; NULL = does not expire
    document_url  TEXT,
    notes         TEXT,
    created_by    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE branch_devices (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id     TEXT NOT NULL REFERENCES branches(id),
    device_id     TEXT NOT NULL,
    label         TEXT,                   -- "Front counter till", "Back office laptop"
    registered_by TEXT,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_by    TEXT,
    revoked_at    TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE branch_safe_ledger (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id     TEXT NOT NULL REFERENCES branches(id),
    business_id   TEXT NOT NULL REFERENCES businesses(id),
    entry_type    TEXT NOT NULL CHECK (entry_type IN (
        'OPENING','DEPOSIT','WITHDRAWAL','BANKING','EXPENSE','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT','TILL_FUND','TILL_RETURN')),
    amount        REAL NOT NULL,        -- + into the safe, - out of it
    balance_after REAL NOT NULL,
    reference_type TEXT,
    reference_id  TEXT,
    till_session_id TEXT,
    reason        TEXT,
    approved_by   TEXT REFERENCES users(id),
    created_by    TEXT NOT NULL REFERENCES users(id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "branch_sync_status" (
    branch_id          TEXT NOT NULL REFERENCES branches(id),
    device_id          TEXT NOT NULL,
    app_version        TEXT,
    last_heartbeat_at  TEXT,
    last_push_at       TEXT,
    last_pull_at       TEXT,
    pending_push_count INTEGER NOT NULL DEFAULT 0,
    last_sync_error    TEXT,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (branch_id, device_id)
);

CREATE TABLE "branches" (
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

CREATE TABLE businesses (
    id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name                  TEXT NOT NULL,
    legal_name            TEXT,
    profile_code          TEXT NOT NULL DEFAULT 'GENERAL_RETAIL',
    profile_overrides_json TEXT,
    cac_reg_no            TEXT,            -- Corporate Affairs Commission registration
    tin                   TEXT,            -- FIRS Tax Identification Number
    vat_registered        INTEGER NOT NULL DEFAULT 0,
    currency_code         TEXT NOT NULL DEFAULT 'NGN',
    default_price_list_id TEXT,            -- price_lists is defined below; see DEFERRED FOREIGN KEYS
    contact_name          TEXT,
    contact_phone         TEXT,
    contact_email         TEXT,
    address               TEXT,
    is_active             INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE change_owed (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    sale_id        TEXT REFERENCES sales(id),
    customer_id    TEXT REFERENCES customers(id),
    customer_name  TEXT NOT NULL,
    customer_phone TEXT,
    amount         REAL NOT NULL CHECK (amount > 0),
    claim_code     TEXT NOT NULL UNIQUE,   -- short code the customer can quote or show
    status         TEXT NOT NULL CHECK (status IN ('OUTSTANDING','REDEEMED','FORFEITED','WRITTEN_OFF')) DEFAULT 'OUTSTANDING',
    redeemed_at    TEXT,
    redeemed_by    TEXT REFERENCES users(id),
    expires_at     TEXT,
    notes          TEXT,
    created_by     TEXT REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE client_settings (
    id                            INTEGER PRIMARY KEY CHECK (id = 1),
    business_name                 TEXT,     -- white-label trading name shown in place of "StockRidge"
    logo_data_url                 TEXT,     -- validated server-side (magic-byte sniff, 500 KB cap)
    primary_business_id           TEXT REFERENCES businesses(id),
    max_businesses                INTEGER NOT NULL DEFAULT 3,
    max_branches                  INTEGER NOT NULL DEFAULT 5,
    max_staff                     INTEGER NOT NULL DEFAULT 25,
    subscription_status           TEXT NOT NULL CHECK (subscription_status IN ('TRIAL','ACTIVE','SUSPENDED','EXPIRED')) DEFAULT 'ACTIVE',
    subscription_plan             TEXT NOT NULL DEFAULT 'Standard',
    subscription_renewal_date     TEXT,
    -- Vendor plan-limit feature toggles (set by ADMIN via the Admin Portal)
    attendance_module_enabled     INTEGER NOT NULL DEFAULT 1,
    warranty_module_enabled       INTEGER NOT NULL DEFAULT 1,
    instalment_module_enabled     INTEGER NOT NULL DEFAULT 1,
    delivery_module_enabled       INTEGER NOT NULL DEFAULT 1,
    multi_branch_enabled          INTEGER NOT NULL DEFAULT 1,
    multi_business_enabled        INTEGER NOT NULL DEFAULT 1,
    serial_tracking_enabled       INTEGER NOT NULL DEFAULT 1,
    offline_sync_enabled          INTEGER NOT NULL DEFAULT 1,
    -- VAT is the CLIENT'S OWN tax-compliance status with FIRS, not a vendor
    -- toggle, so it is editable by the OWNER. OFF by default: this schema
    -- must never silently start charging tax nobody asked for. 7.5% is
    -- Nigeria's standard FIRS rate.
    vat_enabled                   INTEGER NOT NULL DEFAULT 0,
    vat_rate_percent              REAL NOT NULL DEFAULT 7.5,
    -- OWNER-controlled MANAGER permissions. Default 1 so behaviour is
    -- unchanged until an owner deliberately restricts something. OWNER and
    -- ADMIN are never restricted by these — a switch that could lock the
    -- proprietor out of their own books would be a footgun.
    managers_can_void_sales       INTEGER NOT NULL DEFAULT 1,
    managers_can_approve_expenses INTEGER NOT NULL DEFAULT 1,
    managers_can_edit_prices      INTEGER NOT NULL DEFAULT 1,
    managers_can_override_credit_limit INTEGER NOT NULL DEFAULT 1,
    -- OWNER-controlled STAFF permissions. These exist because a cashier
    -- holding both powers can run the two classic retail-theft patterns
    -- unaided:
    --   VOID:      sell for cash, void the sale, keep the note.
    --   WRITE-OFF: take the goods, record them as DAMAGE.
    -- Deliberately NOT a flat ban — a mis-keyed sale at a busy counter is
    -- common and a lone cashier on a night shift must be able to correct
    -- it. The WINDOW and the CAP are what make the allowance safe.
    staff_can_void_sales          INTEGER NOT NULL DEFAULT 1,
    staff_void_window_minutes     INTEGER NOT NULL DEFAULT 15 CHECK (staff_void_window_minutes >= 0),
    staff_can_adjust_stock        INTEGER NOT NULL DEFAULT 1,
    staff_adjustment_max_units    REAL NOT NULL DEFAULT 5 CHECK (staff_adjustment_max_units >= 0),
    staff_can_adjust_stock_value  REAL NOT NULL DEFAULT 50000 CHECK (staff_can_adjust_stock_value >= 0),
    staff_can_sell_on_credit      INTEGER NOT NULL DEFAULT 0,
    staff_credit_max              REAL NOT NULL DEFAULT 0,
    staff_discount_max_pct        REAL NOT NULL DEFAULT 5 CHECK (staff_discount_max_pct >= 0),
    -- STAFF SPENDING FROM THE SAFE. The safe started manager-only, because
    -- a cashier moving the reserve unsupervised is the classic shrinkage
    -- route. But that made a real job impossible: the storekeeper sent to
    -- buy fuel for the delivery van had to find a manager first, and shops
    -- do not work that way. Resolved the same way: a NARROW, OWNER-SET
    -- ALLOWANCE rather than a ban or a free hand.
    staff_can_spend_from_safe     INTEGER NOT NULL DEFAULT 1,
    staff_safe_spend_max          REAL NOT NULL DEFAULT 20000 CHECK (staff_safe_spend_max >= 0),
    -- Instalment/credit governance
    instalment_max_interest_pct   REAL NOT NULL DEFAULT 25 CHECK (instalment_max_interest_pct >= 0),
    instalment_max_tenure_months  INTEGER NOT NULL DEFAULT 12 CHECK (instalment_max_tenure_months > 0),
    instalment_min_deposit_pct    REAL NOT NULL DEFAULT 20 CHECK (instalment_min_deposit_pct >= 0),
    credit_max_days               INTEGER NOT NULL DEFAULT 60 CHECK (credit_max_days >= 0),
    layaway_max_days              INTEGER NOT NULL DEFAULT 90 CHECK (layaway_max_days > 0),
    layaway_min_deposit_pct       REAL NOT NULL DEFAULT 20 CHECK (layaway_min_deposit_pct >= 0),
    change_owed_expiry_days       INTEGER NOT NULL DEFAULT 30,
    return_window_days_default    INTEGER NOT NULL DEFAULT 7,
    low_stock_alert_enabled       INTEGER NOT NULL DEFAULT 1,
    expiry_alert_days             INTEGER NOT NULL DEFAULT 60,
    compliance_alert_days         INTEGER NOT NULL DEFAULT 30,
    receipt_footer_text           TEXT,
    admin_contact_name            TEXT,
    admin_contact_phone           TEXT,
    admin_contact_email           TEXT,
    notes                         TEXT,
    data_reset_at                 TEXT,
    updated_at                    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by                    TEXT REFERENCES users(id)
, credit_grace_days INTEGER NOT NULL DEFAULT 0, instalment_default_after_days INTEGER NOT NULL DEFAULT 60, instalment_default_after_missed INTEGER NOT NULL DEFAULT 3);

CREATE TABLE controlled_substance_register (
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

CREATE TABLE creditor_ledger (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id    TEXT NOT NULL REFERENCES branches(id),
    business_id  TEXT NOT NULL REFERENCES businesses(id),
    supplier_id  TEXT NOT NULL REFERENCES suppliers(id),
    entry_type   TEXT NOT NULL CHECK (entry_type IN ('PURCHASE','PAYMENT','ADJUSTMENT','RETURN','WHT')),
    reference_id TEXT,
    amount       REAL NOT NULL,       -- + = we owe more, - = we paid
    balance_after REAL NOT NULL,
    notes        TEXT,
    created_by   TEXT REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted   INTEGER NOT NULL DEFAULT 0
);

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
, sale_place TEXT, vehicle_id TEXT REFERENCES delivery_vehicles(id));

CREATE TABLE customer_classes (
    id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id           TEXT REFERENCES businesses(id),
    code                  TEXT NOT NULL,        -- 'WALK_IN','RETAIL','WHOLESALE','DISTRIBUTOR','CORPORATE'
    name                  TEXT NOT NULL,
    default_price_list_id TEXT,
    discount_pct          REAL NOT NULL DEFAULT 0,
    credit_allowed        INTEGER NOT NULL DEFAULT 0,
    default_credit_limit  REAL NOT NULL DEFAULT 0,
    payment_terms_days    INTEGER NOT NULL DEFAULT 0,
    is_system             INTEGER NOT NULL DEFAULT 0,
    is_active             INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE customers (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id       TEXT REFERENCES businesses(id),
    branch_id         TEXT REFERENCES branches(id),  -- home branch; NULL = shared/debtor across branches
    customer_class_id TEXT REFERENCES customer_classes(id),
    customer_type     TEXT NOT NULL CHECK (customer_type IN ('INDIVIDUAL','BUSINESS')) DEFAULT 'INDIVIDUAL',
    name              TEXT NOT NULL,
    company_name      TEXT,
    phone             TEXT,
    alt_phone         TEXT,
    email             TEXT,
    address           TEXT,
    city              TEXT,
    state             TEXT,
    tin               TEXT,
    cac_reg_no        TEXT,
    -- Credit control. credit_limit 0 = cash customer. The ledger check is
    -- advisory-by-default (warn at the counter, never hard-block) because
    -- a Nigerian shop floor runs on relationships and an owner will
    -- sometimes knowingly extend beyond the limit; the system's job is to
    -- make that a recorded decision, not a silent one.
    credit_limit      REAL NOT NULL DEFAULT 0,
    credit_balance    REAL NOT NULL DEFAULT 0,
    payment_terms_days INTEGER NOT NULL DEFAULT 0,
    price_list_id     TEXT REFERENCES price_lists(id),
    loyalty_points    REAL NOT NULL DEFAULT 0,
    notes             TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
, latitude REAL, longitude REAL, gps_label TEXT);

CREATE TABLE data_cleanup_log (
    id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    mode                  TEXT NOT NULL CHECK (mode IN (
        'PERIOD','ALL_BUSINESS_DATA','CLEAR_OPERATIONAL_KEEP_ACCOUNTING',
        'CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK','FULL_SETUP_RESET')),
    initiated_by          TEXT NOT NULL,
    initiated_by_username TEXT NOT NULL,
    start_date            TEXT,
    end_date              TEXT,
    deleted_summary_json  TEXT NOT NULL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE debtor_ledger (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id    TEXT NOT NULL REFERENCES branches(id),
    business_id  TEXT NOT NULL REFERENCES businesses(id),
    customer_id  TEXT NOT NULL REFERENCES customers(id),
    entry_type   TEXT NOT NULL CHECK (entry_type IN ('SALE','PAYMENT','ADJUSTMENT','WRITE_OFF','RETURN','INTEREST','INSTALMENT')),
    reference_id TEXT,
    amount       REAL NOT NULL,       -- + = owes more, - = paid down
    balance_after REAL NOT NULL,
    notes        TEXT,
    created_by   TEXT REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted   INTEGER NOT NULL DEFAULT 0
, due_date TEXT);

CREATE TABLE delivery_job_items (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    delivery_job_id TEXT NOT NULL REFERENCES delivery_jobs(id),
    sale_item_id    TEXT REFERENCES sale_items(id),
    product_id      TEXT NOT NULL REFERENCES products(id),
    variant_id      TEXT REFERENCES product_variants(id),
    serial_id       TEXT REFERENCES serial_numbers(id),
    quantity        REAL NOT NULL CHECK (quantity > 0),
    quantity_in_base REAL NOT NULL,
    unit_code       TEXT NOT NULL DEFAULT 'PIECE',
    delivered_qty   REAL NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE delivery_jobs (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    job_no            TEXT NOT NULL,
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    sale_id           TEXT REFERENCES sales(id),
    customer_id       TEXT REFERENCES customers(id),
    zone_id           TEXT REFERENCES delivery_zones(id),
    vehicle_id        TEXT REFERENCES delivery_vehicles(id),
    driver_name       TEXT,
    driver_phone      TEXT,
    delivery_address  TEXT NOT NULL,
    delivery_city     TEXT,
    delivery_state    TEXT,
    scheduled_at      TEXT,
    status            TEXT NOT NULL CHECK (status IN (
        'PENDING','SCHEDULED','PICKED','IN_TRANSIT','DELIVERED','FAILED','CANCELLED','RETURNED')) DEFAULT 'PENDING',
    fee               REAL NOT NULL DEFAULT 0,
    fee_collected     REAL NOT NULL DEFAULT 0,
    fuel_cost         REAL NOT NULL DEFAULT 0,
    distance_km       REAL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    delivered_at      TEXT,
    delivered_to      TEXT,           -- name of whoever signed
    proof_of_delivery TEXT,           -- data URL of a signature or photo
    notes             TEXT,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
, vehicle_class TEXT, arrangement TEXT, pay_basis TEXT, sales_share_pct REAL, driver_pay REAL DEFAULT 0, vehicle_no TEXT, partner_expense_id TEXT, supply_terms TEXT, goods_value REAL, amount_paid REAL, balance_due REAL, txn_customer_name TEXT, txn_customer_phone TEXT, latitude REAL, longitude REAL, transaction_note TEXT, settlement TEXT, driver_user_id TEXT, load_attached_at TEXT, load_attached_by TEXT);

CREATE TABLE delivery_vehicles (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id  TEXT REFERENCES businesses(id),
    branch_id    TEXT REFERENCES branches(id),
    name         TEXT NOT NULL,             -- "Kia Bongo 1.5T"
    plate_no     TEXT,
    capacity_kg  REAL,
    capacity_m3  REAL,
    cost_per_km  REAL NOT NULL DEFAULT 0,
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted   INTEGER NOT NULL DEFAULT 0
, vehicle_class TEXT, arrangement TEXT, pay_basis TEXT, sales_share_pct REAL, driver_name TEXT, driver_phone TEXT, driver_user_id TEXT);

CREATE TABLE delivery_zones (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id TEXT REFERENCES businesses(id),
    branch_id   TEXT REFERENCES branches(id),
    name        TEXT NOT NULL,             -- "Ikeja Mainland", "Lekki Phase 1"
    city        TEXT,
    state       TEXT,
    fee         REAL NOT NULL DEFAULT 0,
    eta_days    INTEGER NOT NULL DEFAULT 1,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE deposit_payments (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    deposit_id   TEXT NOT NULL REFERENCES deposits(id),
    branch_id    TEXT NOT NULL REFERENCES branches(id),
    amount       REAL NOT NULL CHECK (amount > 0),
    method       TEXT NOT NULL DEFAULT 'CASH',
    reference    TEXT,
    received_by  TEXT REFERENCES users(id),
    received_at  TEXT NOT NULL DEFAULT (datetime('now')),
    notes        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE deposits (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    customer_id       TEXT NOT NULL REFERENCES customers(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    variant_id        TEXT REFERENCES product_variants(id),
    batch_id          TEXT REFERENCES stock_batches(id),
    serial_id         TEXT REFERENCES serial_numbers(id),
    deposit_type      TEXT NOT NULL CHECK (deposit_type IN ('LAYAWAY','PART_PAYMENT','RESERVATION')) DEFAULT 'LAYAWAY',
    quantity          REAL NOT NULL CHECK (quantity > 0),
    unit_code         TEXT NOT NULL DEFAULT 'PIECE',
    quantity_in_base  REAL NOT NULL CHECK (quantity_in_base > 0),
    unit_price        REAL NOT NULL DEFAULT 0,
    total_price       REAL NOT NULL DEFAULT 0,
    deposit_amount    REAL NOT NULL DEFAULT 0,
    balance_due       REAL NOT NULL DEFAULT 0,
    -- The reserved quantity is held against the batch (stock_batches.
    -- quantity_reserved) so the shelf count and the sellable count stay
    -- honestly different. It is released on completion, expiry or cancel.
    expires_at        TEXT,                    -- layaway deadline; after this the hold is released
    status            TEXT NOT NULL CHECK (status IN ('ACTIVE','COMPLETED','CANCELLED','EXPIRED','FORFEITED')) DEFAULT 'ACTIVE',
    completed_sale_id TEXT REFERENCES sales(id),
    forfeit_amount    REAL NOT NULL DEFAULT 0,
    created_by        TEXT REFERENCES users(id),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    CHECK (ROUND(total_price - deposit_amount - balance_due, 2) = 0)
);

CREATE TABLE expenses (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id     TEXT NOT NULL REFERENCES branches(id),
    business_id   TEXT NOT NULL REFERENCES businesses(id),
    category      TEXT NOT NULL,          -- 'RENT','DIESEL','SALARY','TRANSPORT','MARKETING', custom
    gl_account_id TEXT,
    supplier_id   TEXT REFERENCES suppliers(id),
    description   TEXT NOT NULL,
    amount        REAL NOT NULL CHECK (amount >= 0),
    vat_amount    REAL NOT NULL DEFAULT 0,
    wht_code      TEXT,
    wht_percent   REAL,
    wht_amount    REAL NOT NULL DEFAULT 0,
    net_amount    REAL NOT NULL DEFAULT 0,
    expense_date  TEXT NOT NULL DEFAULT (datetime('now')),
    payment_method TEXT NOT NULL DEFAULT 'CASH',
    reference     TEXT,
    receipt_url   TEXT,
    status        TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED')) DEFAULT 'APPROVED',
    approved_by   TEXT REFERENCES users(id),
    approved_at   TEXT,
    paid_from     TEXT NOT NULL CHECK (paid_from IN ('TILL','SAFE','BANK','CREDIT')) DEFAULT 'TILL',
    created_by    TEXT NOT NULL REFERENCES users(id),
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
, plant_asset_id TEXT, vehicle_id TEXT REFERENCES delivery_vehicles(id));

CREATE TABLE gl_accounts (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id   TEXT REFERENCES businesses(id),
    code          TEXT NOT NULL,
    name          TEXT NOT NULL,
    account_type  TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
    parent_id     TEXT REFERENCES gl_accounts(id),
    is_system     INTEGER NOT NULL DEFAULT 0,   -- seeded chart of accounts; protected from deletion
    is_control    INTEGER NOT NULL DEFAULT 0,   -- auto-posted by the app, not manually
    normal_side   TEXT NOT NULL CHECK (normal_side IN ('DEBIT','CREDIT')),
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE gl_journal_entries (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    branch_id   TEXT REFERENCES branches(id),
    entry_no    TEXT NOT NULL,
    entry_date  TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN (
        'SALE','SALE_RETURN','PURCHASE','EXPENSE','STOCK_ADJUSTMENT','TRANSFER',
        'TILL','SAFE','DEBTOR_PAYMENT','CREDITOR_PAYMENT','WHT','VAT','DEPRECIATION',
        'INSTALMENT','WARRANTY','DELIVERY','PAYROLL','MANUAL','OPENING_BALANCE','INTERCOMPANY')),
    source_id   TEXT,
    description TEXT,
    total_debit  REAL NOT NULL DEFAULT 0,
    total_credit REAL NOT NULL DEFAULT 0,
    is_reversing INTEGER NOT NULL DEFAULT 0,
    reversed_by  TEXT,
    posted_by   TEXT REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    -- A journal entry that does not balance is not a journal entry.
    CHECK (ROUND(total_debit - total_credit, 2) = 0)
);

CREATE TABLE gl_journal_lines (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    journal_entry_id TEXT NOT NULL REFERENCES gl_journal_entries(id),
    account_id      TEXT NOT NULL REFERENCES gl_accounts(id),
    branch_id       TEXT REFERENCES branches(id),
    description     TEXT,
    debit           REAL NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit          REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
    -- The category axis of a journal line, kept so revenue can be reported
    -- by commercial category without re-joining the whole sale.
    category_id     TEXT REFERENCES product_categories(id),
    reference_type  TEXT,
    reference_id    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0,
    CHECK (NOT (debit > 0 AND credit > 0))
);

CREATE TABLE idempotency_keys (
    idempotency_key TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_status INTEGER,
    response_body   TEXT,
    status          TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')) DEFAULT 'IN_PROGRESS',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (idempotency_key, user_id)
);

CREATE TABLE installation_jobs (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    job_no           TEXT NOT NULL,
    delivery_job_id  TEXT REFERENCES delivery_jobs(id),
    sale_id          TEXT REFERENCES sales(id),
    branch_id        TEXT NOT NULL REFERENCES branches(id),
    business_id      TEXT NOT NULL REFERENCES businesses(id),
    customer_id      TEXT REFERENCES customers(id),
    product_id       TEXT NOT NULL REFERENCES products(id),
    variant_id       TEXT REFERENCES product_variants(id),
    serial_id        TEXT REFERENCES serial_numbers(id),
    technician_name  TEXT,
    technician_phone TEXT,
    scheduled_at     TEXT,
    status           TEXT NOT NULL CHECK (status IN ('PENDING','SCHEDULED','IN_PROGRESS','COMPLETED','FAILED','CANCELLED')) DEFAULT 'PENDING',
    fee              REAL NOT NULL DEFAULT 0,
    fee_collected    REAL NOT NULL DEFAULT 0,
    parts_cost       REAL NOT NULL DEFAULT 0,
    completed_at     TEXT,
    warranty_starts_at TEXT,        -- installation often starts the warranty clock, not the sale
    notes            TEXT,
    created_by       TEXT REFERENCES users(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE instalment_payments (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    plan_id      TEXT NOT NULL REFERENCES instalment_plans(id),
    schedule_id  TEXT REFERENCES instalment_schedule(id),
    branch_id    TEXT NOT NULL REFERENCES branches(id),
    amount       REAL NOT NULL CHECK (amount > 0),
    method       TEXT NOT NULL DEFAULT 'CASH',
    reference    TEXT,
    received_by  TEXT REFERENCES users(id),
    received_at  TEXT NOT NULL DEFAULT (datetime('now')),
    notes        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE instalment_plans (
    id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    plan_no            TEXT NOT NULL,
    branch_id          TEXT NOT NULL REFERENCES branches(id),
    business_id        TEXT NOT NULL REFERENCES businesses(id),
    customer_id        TEXT NOT NULL REFERENCES customers(id),
    sale_id            TEXT REFERENCES sales(id),
    deposit_id         TEXT REFERENCES deposits(id),
    principal          REAL NOT NULL CHECK (principal > 0),
    interest_percent   REAL NOT NULL DEFAULT 0,   -- 0 = interest-free plan
    interest_amount    REAL NOT NULL DEFAULT 0,
    total_payable      REAL NOT NULL CHECK (total_payable >= principal),
    deposit_amount     REAL NOT NULL DEFAULT 0,
    tenure_months      INTEGER NOT NULL CHECK (tenure_months > 0),
    frequency          TEXT NOT NULL CHECK (frequency IN ('WEEKLY','BIWEEKLY','MONTHLY')) DEFAULT 'MONTHLY',
    schedule_start     TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('ACTIVE','COMPLETED','DEFAULTED','CANCELLED')) DEFAULT 'ACTIVE',
    -- Guarantor capture is standard Nigerian practice for work-and-pay and
    -- is the difference between a recoverable and an unrecoverable book.
    guarantor_name     TEXT,
    guarantor_phone    TEXT,
    guarantor_address  TEXT,
    guarantor_id_type  TEXT,
    guarantor_id_no    TEXT,
    next_due_date      TEXT,
    amount_paid        REAL NOT NULL DEFAULT 0,
    outstanding        REAL NOT NULL DEFAULT 0,
    days_overdue       INTEGER NOT NULL DEFAULT 0,
    approved_by        TEXT REFERENCES users(id),
    created_by         TEXT REFERENCES users(id),
    notes              TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0,
    CHECK (ROUND(principal + interest_amount - total_payable, 2) = 0)
);

CREATE TABLE instalment_schedule (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    plan_id     TEXT NOT NULL REFERENCES instalment_plans(id),
    seq         INTEGER NOT NULL,
    due_date    TEXT NOT NULL,
    amount_due  REAL NOT NULL CHECK (amount_due >= 0),
    amount_paid REAL NOT NULL DEFAULT 0,
    paid_at     TEXT,
    status      TEXT NOT NULL CHECK (status IN ('PENDING','PARTIAL','PAID','OVERDUE','WAIVED')) DEFAULT 'PENDING',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (plan_id, seq)
);

CREATE TABLE login_attempts (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    username     TEXT NOT NULL,
    user_id      TEXT REFERENCES users(id),
    succeeded    INTEGER NOT NULL DEFAULT 0,
    ip_address   TEXT,
    user_agent   TEXT,
    attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE nafdac_catalog (
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

CREATE TABLE notifications (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id TEXT REFERENCES businesses(id),
    branch_id   TEXT REFERENCES branches(id),
    user_id     TEXT REFERENCES users(id),      -- NULL = broadcast to everyone with access
    type        TEXT NOT NULL,   -- 'LOW_STOCK','EXPIRY','CREDIT_OVERDUE','INSTALLMENT_DUE','WARRANTY_EXPIRING','COMPLIANCE_EXPIRY','SYNC_CONFLICT','STOCKTAKE_VARIANCE'
    severity    TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')) DEFAULT 'INFO',
    title       TEXT NOT NULL,
    body        TEXT,
    reference_type TEXT,
    reference_id TEXT,
    is_read     INTEGER NOT NULL DEFAULT 0,
    read_at     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pending_user_transfers (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id           TEXT NOT NULL REFERENCES users(id),
    from_branch_id    TEXT REFERENCES branches(id),
    to_branch_id      TEXT NOT NULL REFERENCES branches(id),
    requested_by      TEXT NOT NULL REFERENCES users(id),
    requested_at      TEXT NOT NULL DEFAULT (datetime('now')),
    status            TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','REJECTED','CANCELLED')) DEFAULT 'PENDING',
    resolved_by       TEXT REFERENCES users(id),
    resolved_at       TEXT,
    reason            TEXT,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);

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

CREATE TABLE prescriptions (
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

CREATE TABLE price_list_items (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    price_list_id  TEXT NOT NULL REFERENCES price_lists(id),
    product_id     TEXT NOT NULL REFERENCES products(id),
    variant_id     TEXT REFERENCES product_variants(id),
    unit_code      TEXT NOT NULL DEFAULT 'PIECE',
    price          REAL NOT NULL,
    min_quantity   REAL NOT NULL DEFAULT 0,  -- quantity-break pricing
    valid_from     TEXT,
    valid_to       TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE price_lists (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id TEXT REFERENCES businesses(id),
    name        TEXT NOT NULL,               -- "Retail", "Wholesale", "Distributor", "Onitsha Market"
    code        TEXT NOT NULL,
    priority    INTEGER NOT NULL DEFAULT 0,  -- higher wins when several match
    valid_from  TEXT,
    valid_to    TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE product_barcodes (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    product_id    TEXT NOT NULL REFERENCES products(id),
    variant_id    TEXT REFERENCES product_variants(id),
    barcode       TEXT NOT NULL UNIQUE,
    unit_code     TEXT NOT NULL DEFAULT 'PIECE',   -- matches product_units.code
    label         TEXT,
    is_primary    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE product_categories (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id TEXT REFERENCES businesses(id),   -- NULL = shared across the deployment
    code        TEXT NOT NULL,                     -- stable key: 'MOBILE_PHONES'
    name        TEXT NOT NULL,                     -- "Mobile Phones"
    parent_id   TEXT REFERENCES product_categories(id),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE product_measures (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    product_id       TEXT NOT NULL,
    axis             TEXT NOT NULL CHECK (axis IN ('LENGTH','AREA','VOLUME','WEIGHT')),
    sell_unit_code   TEXT NOT NULL,           -- 'METRE','SQUARE_METRE','LITRE','KILOGRAM'
    sell_unit_base_factor REAL NOT NULL CHECK (sell_unit_base_factor > 0),  -- base units per one sell unit
    base_unit_code   TEXT NOT NULL,           -- what stock is counted in
    allows_fraction  INTEGER NOT NULL DEFAULT 1,
    min_quantity     REAL NOT NULL DEFAULT 0,
    step_quantity    REAL NOT NULL DEFAULT 0.5,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (product_id, axis)
);

CREATE TABLE product_price_overrides (
    id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id             TEXT NOT NULL REFERENCES branches(id),
    product_id            TEXT NOT NULL REFERENCES products(id),
    variant_id            TEXT REFERENCES product_variants(id),
    default_selling_price REAL NOT NULL,
    pack_price            REAL,
    carton_price          REAL,
    updated_by            TEXT REFERENCES users(id),
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0,
    UNIQUE (branch_id, product_id, variant_id)
);

CREATE TABLE product_recalls (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    product_id     TEXT NOT NULL REFERENCES products(id),
    variant_id     TEXT REFERENCES product_variants(id),
    title          TEXT NOT NULL,
    reason         TEXT NOT NULL,
    recall_type    TEXT NOT NULL CHECK (recall_type IN ('SAFETY','QUALITY','REGULATORY','VOLUNTARY')) DEFAULT 'QUALITY',
    authority_ref  TEXT,                 -- SON / NAFDAC recall reference
    batch_nos      TEXT,                 -- affected batch numbers, comma separated or '*'
    serial_range_from TEXT,
    serial_range_to   TEXT,
    status         TEXT NOT NULL CHECK (status IN ('OPEN','IN_PROGRESS','CLOSED')) DEFAULT 'OPEN',
    units_affected INTEGER NOT NULL DEFAULT 0,
    units_recovered INTEGER NOT NULL DEFAULT 0,
    quarantine_stock INTEGER NOT NULL DEFAULT 1,  -- pull affected stock off the sellable pile
    notify_customers INTEGER NOT NULL DEFAULT 0,
    opened_by      TEXT REFERENCES users(id),
    opened_at      TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at      TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE product_registrations (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    product_id     TEXT NOT NULL REFERENCES products(id),
    authority      TEXT NOT NULL,           -- 'SON','NAFDAC','MAN','CITES','NCC'
    reg_type       TEXT NOT NULL,           -- 'SONCAP','NAFDAC_REG','TYPE_APPROVAL'
    reg_no         TEXT NOT NULL,
    issued_date    TEXT,
    expiry_date    TEXT,
    certificate_url TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE product_units (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    product_id       TEXT NOT NULL REFERENCES products(id),
    level            INTEGER NOT NULL,        -- 0 = base unit
    code             TEXT NOT NULL,           -- 'PIECE','PACK','CARTON','BAG','PALLET','ROLL','METRE'
    name             TEXT NOT NULL,           -- "Carton"
    plural_name      TEXT,                    -- "Cartons"
    quantity_in_base REAL NOT NULL CHECK (quantity_in_base > 0),
    is_sellable      INTEGER NOT NULL DEFAULT 1,
    is_default_sell  INTEGER NOT NULL DEFAULT 0,
    default_barcode  TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (product_id, code)
);

CREATE TABLE product_variants (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    product_id    TEXT NOT NULL REFERENCES products(id),
    sku           TEXT,
    name          TEXT NOT NULL,              -- "3-Seater, Ashanti Beige"
    attributes_json TEXT NOT NULL DEFAULT '{}', -- {"colour":"Beige","size":"3-Seater"}
    barcode       TEXT,
    cost_price    REAL,
    selling_price REAL,
    weight_kg     REAL,
    dimensions_cm TEXT,
    is_active     INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
    id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id           TEXT REFERENCES businesses(id),  -- NULL = shared master catalogue entry
    category_id           TEXT REFERENCES product_categories(id),
    sku                   TEXT,                            -- internal stock-keeping unit
    name                  TEXT NOT NULL,
    brand                 TEXT,                            -- Samsung, Innostar, Mikano
    model_no              TEXT,
    description           TEXT,
    -- Generic replacement for nafdac_reg_no. Actual registrations live in
    -- product_registrations; this is the one a cashier can read off a box.
    registration_no       TEXT,
    -- Per-vertical feature flags, all off unless the profile turns them on.
    requires_serial       INTEGER NOT NULL DEFAULT 0,      -- individual-unit identity tracking
    tracks_variants       INTEGER NOT NULL DEFAULT 0,
    warranty_months       INTEGER NOT NULL DEFAULT 0,      -- 0 = no warranty offered
    warranty_type         TEXT CHECK (warranty_type IS NULL OR warranty_type IN ('CARRY_IN','ONSITE','RETURN_TO_BASE')),
    is_bulky              INTEGER NOT NULL DEFAULT 0,      -- needs delivery vehicle sizing
    requires_installation INTEGER NOT NULL DEFAULT 0,
    has_expiry            INTEGER NOT NULL DEFAULT 0,
    is_age_restricted     INTEGER NOT NULL DEFAULT 0,
    is_fragile            INTEGER NOT NULL DEFAULT 0,
    is_returnable         INTEGER NOT NULL DEFAULT 1,
    return_window_days    INTEGER NOT NULL DEFAULT 7,
    -- Money. selling_price_* are the SUGGESTED prices; the batch's own
    -- selling price is the price of record for that stock, and a price
    -- list / branch override wins over both at the counter.
    base_unit_name        TEXT NOT NULL DEFAULT 'piece',
    cost_price            REAL NOT NULL DEFAULT 0,         -- last known weighted-average cost, per base unit, full precision
    selling_price         REAL NOT NULL DEFAULT 0,         -- per base unit
    selling_price_pack    REAL,
    selling_price_carton  REAL,
    reorder_level         REAL NOT NULL DEFAULT 0,         -- in BASE UNITS
    reorder_quantity      REAL NOT NULL DEFAULT 0,
    min_margin_pct        REAL,                            -- guard rail: warn below this
    weight_kg             REAL,
    dimensions_cm         TEXT,                            -- "60x60x120"
    barcode               TEXT,                            -- primary barcode shortcut; full registry below
    image_url             TEXT,
    -- Stock valuation method per product. WEIGHTED_AVG is the default and
    -- what glService uses; FIFO is available for businesses whose
    -- accountant requires it (batch cost layers are already stored).
    valuation_method      TEXT NOT NULL CHECK (valuation_method IN ('WEIGHTED_AVG','FIFO')) DEFAULT 'WEIGHTED_AVG',
    is_active             INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
, created_by TEXT REFERENCES users(id) ON DELETE SET NULL, offers_sale INTEGER NOT NULL DEFAULT 1, offers_hire INTEGER NOT NULL DEFAULT 0, offers_lease INTEGER NOT NULL DEFAULT 0, hire_price_per_day REAL, lease_price_per_month REAL, hire_deposit REAL, lease_deposit REAL, min_hire_days INTEGER NOT NULL DEFAULT 1, min_lease_months INTEGER NOT NULL DEFAULT 1, dispensing_class TEXT, is_controlled INTEGER NOT NULL DEFAULT 0, nafdac_catalog_id INTEGER, stock_role TEXT DEFAULT 'FINISHED');

CREATE TABLE purchase_order_items (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    purchase_order_id   TEXT NOT NULL REFERENCES purchase_orders(id),
    product_id          TEXT NOT NULL REFERENCES products(id),
    variant_id          TEXT REFERENCES product_variants(id),
    unit_code           TEXT NOT NULL DEFAULT 'PIECE',
    quantity_ordered    REAL NOT NULL,          -- in unit_code
    quantity_in_base    REAL NOT NULL,          -- resolved at order time; the invariant
    quantity_received   REAL NOT NULL DEFAULT 0,-- in BASE units
    expected_unit_cost  REAL,
    expected_total_cost REAL,
    freight_allocation  REAL NOT NULL DEFAULT 0, -- this line's share of PO freight, capitalised
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0,
    -- A line can never receive more than was ordered. Enforced at storage
    -- level because the receiving route is the one place a partial
    -- delivery can be mis-keyed under time pressure.
    CHECK (quantity_received >= 0 AND quantity_received <= quantity_in_base)
);

CREATE TABLE purchase_order_receipts (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    purchase_order_id   TEXT NOT NULL REFERENCES purchase_orders(id),
    purchase_order_item_id TEXT NOT NULL REFERENCES purchase_order_items(id),
    quantity_received   REAL NOT NULL CHECK (quantity_received > 0),  -- base units
    batch_no            TEXT,
    expiry_date         TEXT,
    cost_per_unit       REAL NOT NULL DEFAULT 0,
    freight_per_unit    REAL NOT NULL DEFAULT 0,
    selling_price       REAL,
    received_by         TEXT REFERENCES users(id),
    received_at         TEXT NOT NULL DEFAULT (datetime('now')),
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE purchase_orders (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    po_number      TEXT,                       -- human reference shown to the supplier
    supplier_id    TEXT REFERENCES suppliers(id),
    status         TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')) DEFAULT 'DRAFT',
    ordered_by     TEXT REFERENCES users(id),
    ordered_at     TEXT NOT NULL DEFAULT (datetime('now')),
    expected_date  TEXT,
    currency_code  TEXT NOT NULL DEFAULT 'NGN',
    fx_rate        REAL NOT NULL DEFAULT 1,    -- for a USD/CNY import PO: NGN per 1 foreign unit
    subtotal       REAL NOT NULL DEFAULT 0,
    discount_total REAL NOT NULL DEFAULT 0,
    freight_total  REAL NOT NULL DEFAULT 0,    -- shipping/customs/clearing, capitalised into stock cost
    vat_total      REAL NOT NULL DEFAULT 0,
    wht_code       TEXT,
    wht_percent    REAL,
    wht_amount     REAL NOT NULL DEFAULT 0,
    total          REAL NOT NULL DEFAULT 0,
    notes          TEXT,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sale_issues (
    id           TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL REFERENCES businesses(id),
    branch_id    TEXT NOT NULL REFERENCES branches(id),
    sale_id      TEXT REFERENCES sales(id),
    client_id    TEXT,
    source_id    TEXT,
    code         TEXT NOT NULL,
    summary      TEXT NOT NULL,
    detail       TEXT,
    status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLEARED')),
    detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
    cleared_at   TEXT,
    cleared_by   TEXT REFERENCES users(id),
    clear_note   TEXT,
    corrected_at TEXT,
    corrected_by TEXT REFERENCES users(id),
    correction   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sale_items (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id           TEXT NOT NULL REFERENCES sales(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    variant_id        TEXT REFERENCES product_variants(id),
    batch_id          TEXT REFERENCES stock_batches(id),
    category_id       TEXT REFERENCES product_categories(id),
    product_name      TEXT NOT NULL,           -- snapshot: the catalogue name may change later
    sku               TEXT,
    serial_no         TEXT,                    -- captured at the line for serialised goods
    -- UOM. quantity is what the customer bought, in unit_code. The base
    -- quantity is stored too, resolved at sale time, so a report never
    -- has to re-derive it from a product row that may since have changed.
    unit_code         TEXT NOT NULL DEFAULT 'PIECE',
    quantity          REAL NOT NULL CHECK (quantity > 0),
    quantity_in_base  REAL NOT NULL CHECK (quantity_in_base > 0),
    unit_price        REAL NOT NULL DEFAULT 0, -- per unit_code, as rung up
    price_source      TEXT NOT NULL CHECK (price_source IN ('BATCH','PRICE_LIST','OVERRIDE','MANUAL')) DEFAULT 'BATCH',
    price_list_id     TEXT REFERENCES price_lists(id),
    discount_amount   REAL NOT NULL DEFAULT 0,
    discount_reason   TEXT,
    vat_amount        REAL NOT NULL DEFAULT 0,
    line_total        REAL NOT NULL DEFAULT 0,
    cost_price_snapshot REAL NOT NULL DEFAULT 0,  -- per base unit at time of sale: margin history must not move
    margin            REAL NOT NULL DEFAULT 0,
    margin_pct        REAL,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
, channel TEXT NOT NULL DEFAULT 'RETAIL');

CREATE TABLE sale_payments (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id         TEXT NOT NULL REFERENCES sales(id),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    till_session_id TEXT,
    method          TEXT NOT NULL CHECK (method IN (
        'CASH','POS_TERMINAL','BANK_TRANSFER','MOBILE_MONEY','USSD','CHEQUE',
        'CREDIT','INSTALMENT','DEPOSIT','GIFT_CARD','VOUCHER','OTHER')),
    amount          REAL NOT NULL CHECK (amount >= 0),
    reference       TEXT,        -- terminal auth code, transfer reference, cheque no
    bank_name       TEXT,
    settled_at      TEXT,        -- when a transfer/POS leg actually landed
    status          TEXT NOT NULL CHECK (status IN ('PENDING','CLEARED','FAILED','REVERSED')) DEFAULT 'CLEARED',
    cash_tendered   REAL,
    change_given    REAL,
    recorded_by     TEXT REFERENCES users(id),
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sale_return_items (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_return_id   TEXT NOT NULL REFERENCES sale_returns(id),
    sale_item_id     TEXT NOT NULL REFERENCES sale_items(id),
    product_id       TEXT NOT NULL REFERENCES products(id),
    variant_id       TEXT REFERENCES product_variants(id),
    quantity         REAL NOT NULL CHECK (quantity > 0),   -- in sale unit
    quantity_in_base REAL NOT NULL CHECK (quantity_in_base > 0),
    unit_code        TEXT NOT NULL DEFAULT 'PIECE',
    refund_amount    REAL NOT NULL DEFAULT 0,
    condition        TEXT NOT NULL CHECK (condition IN ('RESALABLE','DAMAGED','DEFECTIVE','MISSING_PARTS')) DEFAULT 'RESALABLE',
    serial_no        TEXT,
    restocked_batch_id TEXT REFERENCES stock_batches(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sale_returns (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id        TEXT NOT NULL REFERENCES sales(id),
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    return_no      TEXT NOT NULL,
    customer_id    TEXT REFERENCES customers(id),
    reason_code    TEXT NOT NULL CHECK (reason_code IN (
        'DEFECTIVE','WRONG_ITEM','DAMAGED_IN_TRANSIT','CUSTOMER_CHANGE_OF_MIND',
        'OVERCHARGE','RECALL','WARRANTY','OTHER')),
    status         TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED','COMPLETED')) DEFAULT 'PENDING_APPROVAL',
    refund_method  TEXT CHECK (refund_method IS NULL OR refund_method IN ('CASH','BANK_TRANSFER','STORE_CREDIT','EXCHANGE','NONE')),
    refund_amount  REAL NOT NULL DEFAULT 0,
    restock        INTEGER NOT NULL DEFAULT 1,   -- 0 = goes to quarantine / write-off, not back on the shelf
    approved_by    TEXT REFERENCES users(id),
    approved_at    TEXT,
    processed_by   TEXT REFERENCES users(id),
    processed_at   TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0,
    CHECK (refund_amount >= 0)
);

CREATE TABLE sale_serials (
    id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id    TEXT NOT NULL REFERENCES sales(id),
    sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
    serial_id  TEXT NOT NULL REFERENCES serial_numbers(id),
    serial_no  TEXT NOT NULL,
    branch_id  TEXT NOT NULL REFERENCES branches(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (sale_id, serial_id)
);

CREATE TABLE sales (
    id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id        TEXT NOT NULL REFERENCES businesses(id),
    branch_id          TEXT NOT NULL REFERENCES branches(id),
    till_session_id    TEXT,                    -- till_sessions is defined below; see DEFERRED FOREIGN KEYS
    receipt_no         TEXT NOT NULL,           -- human receipt number, unique per branch
    customer_id        TEXT REFERENCES customers(id),
    customer_name      TEXT,                    -- snapshot for walk-ins with no customer row
    customer_phone     TEXT,
    sale_type          TEXT NOT NULL CHECK (sale_type IN ('RETAIL','WHOLESALE','CREDIT','INSTALMENT','LAYAWAY','EXCHANGE','INTERNAL')) DEFAULT 'RETAIL',
    salesperson_id     TEXT REFERENCES users(id),
    status             TEXT NOT NULL CHECK (status IN ('COMPLETED','VOIDED','PARTIALLY_REFUNDED','REFUNDED','PENDING_DELIVERY')) DEFAULT 'COMPLETED',
    subtotal           REAL NOT NULL DEFAULT 0, -- sum of line nets (VAT-INCLUSIVE), before the order-level discount
    discount_amount    REAL NOT NULL DEFAULT 0, -- line discounts PLUS the order discount: a reporting total
    -- The ORDER-LEVEL discount, stored separately from discount_amount.
    --
    -- It has to be separate for the arithmetic to be checkable. Line discounts
    -- are already netted inside each line_total, so they are inside subtotal;
    -- an order-level discount is applied AFTER the subtotal. Adding them into
    -- one column makes it impossible to reconstruct `total` from stored values
    -- without re-reading every line, which is exactly what a CHECK constraint
    -- cannot do. Receipts want the distinction too: "₦500 off this item" and
    -- "₦500 off the bill" are different conversations with a customer.
    order_discount_amount REAL NOT NULL DEFAULT 0,
    discount_reason    TEXT,
    vat_enabled        INTEGER NOT NULL DEFAULT 0,
    vat_rate_percent   REAL NOT NULL DEFAULT 0,
    -- VAT-INCLUSIVE PRICING (carried across deliberately). Enabling VAT
    -- does NOT increase what a customer pays — matching how Nigerian
    -- retail shelf prices already work. `total` is unchanged by the
    -- toggle; vat_amount is EXTRACTED from the existing total for
    -- reporting and remittance bookkeeping only.
    vat_amount         REAL NOT NULL DEFAULT 0,
    total              REAL NOT NULL DEFAULT 0,
    amount_paid        REAL NOT NULL DEFAULT 0,
    balance_due        REAL NOT NULL DEFAULT 0,
    -- Cash reconciliation: recorded so a till count is not thrown off by
    -- a customer paying with a bigger note than the total.
    cash_tendered      REAL NOT NULL DEFAULT 0,
    change_given       REAL NOT NULL DEFAULT 0,
    payment_method     TEXT NOT NULL DEFAULT 'CASH',  -- primary/dominant method; every leg is in sale_payments
    currency_code      TEXT NOT NULL DEFAULT 'NGN',
    fx_rate            REAL NOT NULL DEFAULT 1,
    due_date           TEXT,                    -- credit sales
    delivery_required  INTEGER NOT NULL DEFAULT 0,
    delivery_address   TEXT,
    delivery_fee       REAL NOT NULL DEFAULT 0,
    notes              TEXT,
    voided_at          TEXT,
    voided_by          TEXT REFERENCES users(id),
    void_reason        TEXT,
    sold_at            TEXT NOT NULL DEFAULT (datetime('now')),  -- WEST AFRICA TIME string; see the WAT note below
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0, trade_mix TEXT, settlement TEXT, sale_place TEXT, vehicle_id TEXT REFERENCES delivery_vehicles(id),
    -- THE MONEY INVARIANTS.
    --
    -- This block used to read:
    --   CHECK (ROUND(subtotal - discount_amount + vat_amount - total, 2) <= 0.005 AND ...)
    -- which is VAT-EXCLUSIVE arithmetic: total = net + VAT added on top. It
    -- directly contradicted the VAT-INCLUSIVE rule documented twelve lines
    -- above it, and because `vat_enabled` defaults to 0 the contradiction was
    -- invisible until a client switched VAT on — at which point EVERY sale
    -- failed the constraint and the shop could not trade at all. A default that
    -- hides a fatal bug is the worst kind of default.
    --
    -- VAT-inclusive means vat_amount is a COMPONENT of total, not an addition:
    --   total = subtotal - order_discount + delivery_fee
    --   vat_amount <= total
    -- 45,000 inclusive at 7.5% is 41,860.47 of revenue and 3,139.53 of VAT
    -- payable to FIRS. The customer pays 45,000 either way.
    CHECK (ROUND(subtotal - order_discount_amount + delivery_fee - total, 2) BETWEEN -0.005 AND 0.005),
    CHECK (ROUND(discount_amount - order_discount_amount, 2) >= -0.005),
    CHECK (vat_amount >= 0 AND ROUND(vat_amount - total, 2) <= 0.005),
    CHECK (amount_paid >= 0),
    CHECK (ROUND(total - amount_paid - balance_due, 2) BETWEEN -0.005 AND 0.005)
);

CREATE TABLE sales_targets (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    branch_id   TEXT REFERENCES branches(id),   -- NULL = business-wide target
    user_id     TEXT REFERENCES users(id),      -- NULL = branch-wide target
    period_type TEXT NOT NULL CHECK (period_type IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','YEARLY')),
    period_start TEXT NOT NULL,
    period_end  TEXT NOT NULL,
    target_revenue REAL NOT NULL DEFAULT 0,
    target_units   REAL NOT NULL DEFAULT 0,
    target_margin  REAL NOT NULL DEFAULT 0,
    created_by  TEXT REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE serial_events (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    serial_id    TEXT NOT NULL REFERENCES serial_numbers(id),
    serial_no    TEXT NOT NULL,                -- denormalised so the chain is readable without a join
    event_type   TEXT NOT NULL CHECK (event_type IN (
        'RECEIVED','TRANSFERRED','SOLD','RETURNED','REPAIRED','REPLACED','WRITTEN_OFF','WARRANTY_CLAIM','STATUS_CHANGE')),
    from_status  TEXT,
    to_status    TEXT,
    branch_id    TEXT REFERENCES branches(id),
    reference_type TEXT,                       -- 'SALE','TRANSFER','WARRANTY_CLAIM','ADJUSTMENT'
    reference_id TEXT,
    actor_id     TEXT REFERENCES users(id),
    customer_id  TEXT,
    notes        TEXT,
    prev_hash    TEXT,                         -- NULL for the first event on this serial
    row_hash     TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE serial_numbers (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    product_id        TEXT NOT NULL REFERENCES products(id),
    variant_id        TEXT REFERENCES product_variants(id),
    serial_no         TEXT NOT NULL,
    imei              TEXT,                    -- phones: second identity used by networks and police reports
    batch_id          TEXT REFERENCES stock_batches(id),
    branch_id         TEXT REFERENCES branches(id),   -- current holding branch
    status            TEXT NOT NULL CHECK (status IN ('IN_STOCK','RESERVED','SOLD','RETURNED','DEFECTIVE','IN_REPAIR','WRITTEN_OFF','TRANSFERRED')) DEFAULT 'IN_STOCK',
    warranty_starts_at TEXT,
    warranty_ends_at  TEXT,
    sold_at           TEXT,
    sale_id           TEXT,
    customer_id       TEXT,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE staff_attendance (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id         TEXT NOT NULL REFERENCES users(id),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    clock_in_at     TEXT NOT NULL DEFAULT (datetime('now')),
    clock_out_at    TEXT,
    clock_in_method TEXT NOT NULL CHECK (clock_in_method IN ('GEOLOCATION','REGISTERED_DEVICE','MANUAL')) DEFAULT 'GEOLOCATION',
    clock_in_lat    REAL,
    clock_in_lng    REAL,
    clock_in_device_id TEXT,
    -- Computed server-side (Haversine against branches.latitude/longitude)
    -- and STORED per record. Never silently blocks a clock-in: an off-site
    -- or no-location attempt is flagged for manager review/override,
    -- because GPS accuracy and permissions vary a lot by device and a
    -- cashier who cannot clock in is a shop that cannot open.
    location_status TEXT CHECK (location_status IS NULL OR location_status IN ('ON_SITE','OFF_SITE','NO_LOCATION','NOT_CONFIGURED')),
    distance_meters REAL,
    device_status   TEXT CHECK (device_status IS NULL OR device_status IN ('REGISTERED','UNRECOGNIZED','NOT_APPLICABLE')),
    flagged         INTEGER NOT NULL DEFAULT 0,
    flag_reason     TEXT,
    reviewed_by     TEXT REFERENCES users(id),
    reviewed_at     TEXT,
    override_by     TEXT REFERENCES users(id),
    override_reason TEXT,
    hours_worked    REAL,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stock_adjustments (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    batch_id        TEXT REFERENCES stock_batches(id),
    product_id      TEXT NOT NULL REFERENCES products(id),
    variant_id      TEXT REFERENCES product_variants(id),
    adjustment_type TEXT NOT NULL CHECK (adjustment_type IN (
        'DAMAGE','THEFT','EXPIRED','COUNT_VARIANCE','SAMPLE','SHRINKAGE','FOUND','RETURN_TO_SUPPLIER','WRITE_OFF','OTHER')),
    quantity        REAL NOT NULL,      -- + adds stock, - removes it; ALWAYS in base units
    unit_cost       REAL NOT NULL DEFAULT 0,
    total_value     REAL NOT NULL DEFAULT 0,
    reason          TEXT,
    stocktake_id    TEXT REFERENCES stocktake_sessions(id),
    requires_approval INTEGER NOT NULL DEFAULT 0,
    approved_by     TEXT REFERENCES users(id),
    approved_at     TEXT,
    created_by      TEXT NOT NULL REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stock_batches (
    id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id             TEXT NOT NULL REFERENCES branches(id),
    business_id           TEXT NOT NULL REFERENCES businesses(id),
    product_id            TEXT NOT NULL REFERENCES products(id),
    variant_id            TEXT REFERENCES product_variants(id),
    batch_no              TEXT,
    supplier_id           TEXT REFERENCES suppliers(id),
    purchase_order_id     TEXT REFERENCES purchase_orders(id),
    cost_price_per_unit   REAL NOT NULL DEFAULT 0,   -- per BASE unit, FULL PRECISION — never rounded to kobo (see note below)
    selling_price_per_unit REAL NOT NULL DEFAULT 0,  -- per BASE unit
    selling_price_pack    REAL,
    selling_price_carton  REAL,
    quantity              REAL NOT NULL DEFAULT 0,   -- BASE units remaining
    quantity_reserved     REAL NOT NULL DEFAULT 0,   -- held by a layaway/deposit or an open delivery job
    initial_quantity      REAL NOT NULL DEFAULT 0,
    manufacture_date      TEXT,
    expiry_date           TEXT,
    received_at           TEXT NOT NULL DEFAULT (datetime('now')),
    received_by           TEXT REFERENCES users(id),
    -- QUARANTINE: goods-received inspection failure, a recall, or a
    -- customer return that must not go back on the shelf until checked.
    -- Quarantined stock is counted but is NOT available to sell, which is
    -- the difference between "we have 10" and "we can sell 10".
    status                TEXT NOT NULL CHECK (status IN ('ACTIVE','QUARANTINED','EXPIRED','DEPLETED')) DEFAULT 'ACTIVE',
    warehouse_zone        TEXT,                      -- "Aisle 3 / Rack B / Shelf 2"
    notes                 TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0,
    CHECK (quantity >= 0),
    CHECK (quantity_reserved >= 0 AND quantity_reserved <= quantity)
);

CREATE TABLE stock_transfer_items (
    id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    transfer_id        TEXT NOT NULL REFERENCES stock_transfers(id),
    product_id         TEXT NOT NULL REFERENCES products(id),
    variant_id         TEXT REFERENCES product_variants(id),
    from_batch_id      TEXT REFERENCES stock_batches(id),
    to_batch_id        TEXT REFERENCES stock_batches(id),
    unit_code          TEXT NOT NULL DEFAULT 'PIECE',
    quantity_sent      REAL NOT NULL CHECK (quantity_sent > 0),
    quantity_sent_base REAL NOT NULL CHECK (quantity_sent_base > 0),
    quantity_received  REAL NOT NULL DEFAULT 0,   -- base units
    unit_cost          REAL NOT NULL DEFAULT 0,
    unit_transfer_price REAL NOT NULL DEFAULT 0,
    received_at        TEXT,
    received_by        TEXT REFERENCES users(id),
    discrepancy_note   TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0,
    CHECK (quantity_received >= 0 AND quantity_received <= quantity_sent_base)
);

CREATE TABLE stock_transfer_serials (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    transfer_id TEXT NOT NULL REFERENCES stock_transfers(id),
    transfer_item_id TEXT NOT NULL REFERENCES stock_transfer_items(id),
    serial_id   TEXT NOT NULL REFERENCES serial_numbers(id),
    serial_no   TEXT NOT NULL,
    received    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (transfer_id, serial_id)
);

CREATE TABLE stock_transfers (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    reference        TEXT NOT NULL,
    from_branch_id   TEXT NOT NULL REFERENCES branches(id),
    to_branch_id     TEXT NOT NULL REFERENCES branches(id),
    from_business_id TEXT NOT NULL REFERENCES businesses(id),
    to_business_id   TEXT NOT NULL REFERENCES businesses(id),
    -- INTER-COMPANY. Moving stock from the electronics business to the
    -- furniture business is not a relocation, it is a sale between two
    -- legal entities: it must post a debtor/creditor pair and a valuation
    -- at transfer price, or the two businesses' margins silently cross-
    -- subsidise each other and neither P&L is true.
    is_intercompany  INTEGER NOT NULL DEFAULT 0,
    transfer_price   REAL NOT NULL DEFAULT 0,
    status           TEXT NOT NULL CHECK (status IN ('INITIATED','IN_TRANSIT','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')) DEFAULT 'INITIATED',
    initiated_by     TEXT REFERENCES users(id),
    initiated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    dispatched_at    TEXT,
    received_by      TEXT REFERENCES users(id),
    received_at      TEXT,
    courier_name     TEXT,
    courier_phone    TEXT,
    vehicle_id       TEXT REFERENCES delivery_vehicles(id),
    notes            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    CHECK (from_branch_id <> to_branch_id)
);

CREATE TABLE stocktake_lines (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    stocktake_id   TEXT NOT NULL REFERENCES stocktake_sessions(id),
    product_id     TEXT NOT NULL REFERENCES products(id),
    variant_id     TEXT REFERENCES product_variants(id),
    batch_id       TEXT REFERENCES stock_batches(id),
    warehouse_zone TEXT,
    system_qty     REAL NOT NULL,       -- frozen at session open, in base units
    counted_qty    REAL,
    variance       REAL,                -- counted - system
    counted_by     TEXT REFERENCES users(id),
    counted_at     TEXT,
    recount_qty    REAL,
    recount_by     TEXT REFERENCES users(id),
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stocktake_sessions (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    reference      TEXT,
    scope          TEXT NOT NULL CHECK (scope IN ('FULL','CATEGORY','PRODUCT','ZONE')) DEFAULT 'FULL',
    scope_filter_json TEXT,
    status         TEXT NOT NULL CHECK (status IN ('OPEN','COUNTING','COMMITTED','CANCELLED')) DEFAULT 'OPEN',
    opened_by      TEXT REFERENCES users(id),
    opened_at      TEXT NOT NULL DEFAULT (datetime('now')),
    committed_by   TEXT REFERENCES users(id),
    committed_at   TEXT,
    total_variance_value REAL NOT NULL DEFAULT 0,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE suppliers (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id    TEXT REFERENCES businesses(id),
    name           TEXT NOT NULL,
    contact_person TEXT,
    phone          TEXT,
    alt_phone      TEXT,
    email          TEXT,
    address        TEXT,
    city           TEXT,
    state          TEXT,
    country        TEXT DEFAULT 'Nigeria',
    tin            TEXT,                  -- required on a real WHT credit note
    cac_reg_no     TEXT,
    is_manufacturer INTEGER NOT NULL DEFAULT 0,  -- MATTERS FOR WHT: goods manufactured by the supplier itself are NOT liable to the 2% supply-of-goods deduction; a distributor's are
    bank_name      TEXT,
    bank_account_no TEXT,
    bank_account_name TEXT,
    credit_limit   REAL NOT NULL DEFAULT 0,
    payment_terms_days INTEGER NOT NULL DEFAULT 0,
    rating         INTEGER,               -- 1..5, informal
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_change_log (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id     TEXT REFERENCES branches(id),
    device_id     TEXT,
    direction     TEXT NOT NULL CHECK (direction IN ('PUSH','PULL','HEARTBEAT')),
    table_name    TEXT,
    row_count     INTEGER DEFAULT 0,
    status        TEXT NOT NULL CHECK (status IN ('SUCCESS','PARTIAL','FAILED')) DEFAULT 'SUCCESS',
    error_message TEXT,
    synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sync_conflicts (
    id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    table_name           TEXT NOT NULL,
    row_id               TEXT NOT NULL,
    branch_id            TEXT REFERENCES branches(id),
    device_id            TEXT,
    losing_version_json  TEXT NOT NULL,
    winning_version_json TEXT NOT NULL,
    detected_at          TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by          TEXT REFERENCES users(id),
    reviewed_at          TEXT
);

CREATE TABLE till_sessions (
    id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id          TEXT NOT NULL REFERENCES branches(id),
    business_id        TEXT NOT NULL REFERENCES businesses(id),
    user_id            TEXT NOT NULL REFERENCES users(id),
    device_id          TEXT,
    status             TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')) DEFAULT 'OPEN',
    opened_at          TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at          TEXT,
    opening_cash       REAL NOT NULL DEFAULT 0,
    expected_cash      REAL,           -- opening + cash sales + safe draws - safe returns - change owed issued
    counted_cash       REAL,
    variance           REAL,
    variance_reason    TEXT,
    cash_sales_total   REAL NOT NULL DEFAULT 0,
    pos_total          REAL NOT NULL DEFAULT 0,
    transfer_total     REAL NOT NULL DEFAULT 0,
    mobile_money_total REAL NOT NULL DEFAULT 0,
    cheque_total       REAL NOT NULL DEFAULT 0,
    credit_total       REAL NOT NULL DEFAULT 0,
    other_total        REAL NOT NULL DEFAULT 0,
    grand_total        REAL NOT NULL DEFAULT 0,
    refund_total       REAL NOT NULL DEFAULT 0,
    sale_count         INTEGER NOT NULL DEFAULT 0,
    void_count         INTEGER NOT NULL DEFAULT 0,
    notes              TEXT,
    reviewed_by        TEXT REFERENCES users(id),
    reviewed_at        TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE user_assignment_history (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id        TEXT NOT NULL REFERENCES users(id),
    from_business_id TEXT,
    to_business_id   TEXT,
    from_branch_id TEXT,
    to_branch_id   TEXT,
    reason         TEXT,
    changed_by     TEXT REFERENCES users(id),
    changed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_business_access (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id     TEXT NOT NULL REFERENCES users(id),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    granted_by  TEXT REFERENCES users(id),
    granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at  TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, business_id)
);

CREATE TABLE user_sessions (
    user_id    TEXT PRIMARY KEY REFERENCES users(id),
    session_id TEXT NOT NULL,
    issued_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, device_id TEXT, user_agent TEXT);

CREATE TABLE users (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_id         TEXT REFERENCES businesses(id),   -- NULL = all businesses
    branch_id           TEXT REFERENCES branches(id),     -- NULL = general (all branches of accessible businesses)
    full_name           TEXT NOT NULL,
    username            TEXT NOT NULL UNIQUE,
    pin_hash            TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('ADMIN','OWNER','MANAGER','STAFF')),
    job_title           TEXT,                              -- free text shown in the UI: "Sales Supervisor", "Storekeeper"
    email               TEXT,
    phone               TEXT,
    nin                 TEXT,                              -- National Identification Number, HR record only
    bvn_last4           TEXT,                              -- last 4 of Bank Verification Number, for payroll
    bank_name           TEXT,
    bank_account_no     TEXT,
    employment_started  TEXT,
    employment_ended    TEXT,
    commission_rate_pct REAL,                              -- sales commission, if this business pays it
    is_active           INTEGER NOT NULL DEFAULT 1,
    last_login_at       TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
, pin_changed_at TEXT);

CREATE TABLE variant_axes (
    id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    product_id TEXT NOT NULL REFERENCES products(id),
    name       TEXT NOT NULL,              -- "Colour", "Size", "Storage", "Finish"
    options_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted INTEGER NOT NULL DEFAULT 0
);

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

CREATE TABLE "warranty_claims" (
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

CREATE TABLE wht_entries (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    direction       TEXT NOT NULL CHECK (direction IN ('PAYABLE','RECEIVABLE')),
    source_type     TEXT NOT NULL CHECK (source_type IN ('EXPENSE','SUPPLIER_PAYMENT','PO_RECEIVE','SALE','INSTALMENT')),
    source_id       TEXT NOT NULL,
    rate_code       TEXT NOT NULL,
    rate_percent    REAL NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
    -- All three money figures are STORED, not derived, because a rate can
    -- be edited later and a historical deduction must never silently
    -- re-compute. gross = net + wht, enforced below.
    gross_amount    REAL NOT NULL CHECK (gross_amount >= 0),
    wht_amount      REAL NOT NULL CHECK (wht_amount >= 0),
    net_amount      REAL NOT NULL CHECK (net_amount >= 0),
    supplier_id     TEXT REFERENCES suppliers(id),
    customer_id     TEXT REFERENCES customers(id),
    counterparty_name TEXT,
    counterparty_tin  TEXT,
    certificate_no  TEXT,
    remitted_at     TEXT,
    remittance_ref  TEXT,
    recorded_by     TEXT NOT NULL REFERENCES users(id),
    entry_date      TEXT NOT NULL DEFAULT (datetime('now')),
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0,
    -- STORAGE-LEVEL GUARD on the one invariant the whole feature rests on.
    -- Rounded to 2dp so IEEE-754 dust from money arithmetic cannot trip it.
    CHECK (ROUND(gross_amount - net_amount - wht_amount, 2) = 0)
);

CREATE TABLE wht_rates (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    rate_percent  REAL NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
    direction     TEXT NOT NULL CHECK (direction IN ('PAYABLE','RECEIVABLE','BOTH')) DEFAULT 'BOTH',
    is_system     INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_agreement_lines_agreement ON asset_agreement_lines(agreement_id);

CREATE INDEX idx_agreement_lines_product ON asset_agreement_lines(product_id) WHERE is_deleted = 0;

CREATE INDEX idx_agreement_schedule_due ON asset_agreement_schedule(agreement_id, period_no);

CREATE INDEX idx_agreements_branch ON asset_agreements(branch_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_agreements_customer ON asset_agreements(customer_id) WHERE customer_id IS NOT NULL;

CREATE INDEX idx_agreements_sale ON asset_agreements(sale_id) WHERE sale_id IS NOT NULL;

CREATE INDEX idx_attendance_branch_date ON staff_attendance(branch_id, clock_in_at);

CREATE INDEX idx_attendance_flagged ON staff_attendance(flagged, branch_id) WHERE flagged = 1 AND is_deleted = 0;

CREATE UNIQUE INDEX idx_attendance_one_open_per_user ON staff_attendance(user_id) WHERE clock_out_at IS NULL AND is_deleted = 0;

CREATE INDEX idx_attendance_user_date ON staff_attendance(user_id, clock_in_at);

CREATE INDEX idx_audit_log_branch ON audit_log(branch_id, created_at);

CREATE UNIQUE INDEX idx_audit_log_chain_link ON audit_log(prev_hash);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);

CREATE INDEX idx_audit_log_user ON audit_log(user_id, created_at);

CREATE INDEX idx_bill_holds_batch ON bill_holds(batch_id);

CREATE INDEX idx_bill_holds_bill ON bill_holds(bill_id);

CREATE UNIQUE INDEX idx_branch_devices_active_device ON branch_devices(device_id) WHERE is_deleted = 0 AND revoked_at IS NULL;

CREATE INDEX idx_branch_devices_branch ON branch_devices(branch_id) WHERE is_deleted = 0 AND revoked_at IS NULL;

CREATE INDEX idx_branch_safe_branch ON branch_safe_ledger(branch_id, created_at);

CREATE INDEX idx_branch_safe_source ON branch_safe_ledger(reference_type, reference_id);

CREATE INDEX idx_branch_sync_status_device ON branch_sync_status(device_id);

CREATE INDEX idx_branch_sync_status_heartbeat ON branch_sync_status(last_heartbeat_at DESC);

CREATE INDEX idx_branches_business ON branches (business_id) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_branches_code_per_business ON branches (business_id, code) WHERE code IS NOT NULL AND is_deleted = 0;

CREATE INDEX idx_businesses_profile ON businesses(profile_code) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_categories_code_per_business ON product_categories(business_id, code) WHERE is_deleted = 0;

CREATE INDEX idx_categories_parent ON product_categories(parent_id) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_categories_shared_code
  ON product_categories(code)
  WHERE business_id IS NULL AND is_deleted = 0;

CREATE INDEX idx_change_owed_branch ON change_owed(branch_id, status, created_at);

CREATE INDEX idx_change_owed_name ON change_owed(customer_name) WHERE status = 'OUTSTANDING' AND is_deleted = 0;

CREATE INDEX idx_change_owed_phone ON change_owed(customer_phone) WHERE status = 'OUTSTANDING' AND is_deleted = 0;

CREATE INDEX idx_compliance_branch ON branch_compliance_records(branch_id) WHERE is_deleted = 0;

CREATE INDEX idx_compliance_expiry ON branch_compliance_records(expiry_date) WHERE is_deleted = 0 AND expiry_date IS NOT NULL;

CREATE INDEX idx_controlled_branch ON controlled_substance_register(branch_id, created_at);

CREATE INDEX idx_controlled_product ON controlled_substance_register(product_id);

CREATE INDEX idx_controlled_sale ON controlled_substance_register(sale_id);

CREATE INDEX idx_creditor_ledger_branch ON creditor_ledger(branch_id);

CREATE INDEX idx_creditor_ledger_supplier ON creditor_ledger(supplier_id);

CREATE UNIQUE INDEX idx_customer_bills_no ON customer_bills(branch_id, bill_no);

CREATE INDEX idx_customer_bills_open ON customer_bills(branch_id, status) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_customer_classes_code ON customer_classes(business_id, code) WHERE is_deleted = 0;

CREATE INDEX idx_customers_branch ON customers(branch_id) WHERE is_deleted = 0;

CREATE INDEX idx_customers_class ON customers(customer_class_id) WHERE is_deleted = 0;

CREATE INDEX idx_customers_name ON customers(name) WHERE is_deleted = 0;

CREATE INDEX idx_customers_phone ON customers(phone) WHERE is_deleted = 0;

CREATE INDEX idx_data_cleanup_log_created ON data_cleanup_log(created_at);

CREATE INDEX idx_debtor_ledger_branch ON debtor_ledger(branch_id);

CREATE INDEX idx_debtor_ledger_created ON debtor_ledger(created_at);

CREATE INDEX idx_debtor_ledger_customer ON debtor_ledger(customer_id);

CREATE INDEX idx_debtor_ledger_due ON debtor_ledger(due_date);

CREATE INDEX idx_delivery_items_job ON delivery_job_items(delivery_job_id);

CREATE UNIQUE INDEX idx_delivery_job_no ON delivery_jobs(job_no) WHERE is_deleted = 0;

CREATE INDEX idx_delivery_jobs_branch ON delivery_jobs(branch_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_delivery_jobs_sale ON delivery_jobs(sale_id) WHERE sale_id IS NOT NULL;

CREATE INDEX idx_delivery_zones_branch ON delivery_zones(branch_id) WHERE is_deleted = 0;

CREATE INDEX idx_deposit_payments_deposit ON deposit_payments(deposit_id);

CREATE INDEX idx_deposits_branch ON deposits(branch_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_deposits_customer ON deposits(customer_id);

CREATE INDEX idx_expenses_branch ON expenses(branch_id, expense_date);

CREATE INDEX idx_expenses_category ON expenses(category, expense_date);

CREATE INDEX idx_expenses_plant_asset ON expenses(plant_asset_id) WHERE plant_asset_id IS NOT NULL AND is_deleted = 0;

CREATE INDEX idx_expenses_status ON expenses(status) WHERE is_deleted = 0;

CREATE INDEX idx_expenses_vehicle ON expenses(vehicle_id) WHERE is_deleted = 0 AND vehicle_id IS NOT NULL;

CREATE UNIQUE INDEX idx_gl_accounts_code ON gl_accounts(business_id, code) WHERE is_deleted = 0;

CREATE INDEX idx_gl_accounts_type ON gl_accounts(account_type);

CREATE INDEX idx_gl_journal_entries_branch ON gl_journal_entries(branch_id, entry_date);

CREATE INDEX idx_gl_journal_entries_business_date ON gl_journal_entries(business_id, entry_date);

CREATE INDEX idx_gl_journal_entries_source ON gl_journal_entries(source_type, source_id);

CREATE INDEX idx_gl_journal_lines_account ON gl_journal_lines(account_id);

CREATE INDEX idx_gl_journal_lines_category ON gl_journal_lines(category_id, journal_entry_id) WHERE category_id IS NOT NULL;

CREATE INDEX idx_gl_journal_lines_entry ON gl_journal_lines(journal_entry_id);

CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);

CREATE UNIQUE INDEX idx_installation_job_no ON installation_jobs(job_no) WHERE is_deleted = 0;

CREATE INDEX idx_installation_jobs_branch ON installation_jobs(branch_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_instalment_payments_plan ON instalment_payments(plan_id);

CREATE UNIQUE INDEX idx_instalment_plan_no ON instalment_plans(plan_no) WHERE is_deleted = 0;

CREATE INDEX idx_instalment_plans_customer ON instalment_plans(customer_id);

CREATE INDEX idx_instalment_plans_status ON instalment_plans(branch_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_instalment_schedule_due ON instalment_schedule(due_date, status);

CREATE INDEX idx_instalment_schedule_plan ON instalment_schedule(plan_id);

CREATE INDEX idx_login_attempts_time ON login_attempts(attempted_at);

CREATE INDEX idx_login_attempts_username_time ON login_attempts(username, attempted_at);

CREATE INDEX idx_nafdac_catalog_category ON nafdac_catalog(category);

CREATE INDEX idx_nafdac_catalog_ingredient ON nafdac_catalog(ingredient_key);

CREATE INDEX idx_nafdac_catalog_nafdac ON nafdac_catalog(nafdac_reg_no);

CREATE INDEX idx_nafdac_catalog_name ON nafdac_catalog(product_name);

CREATE INDEX idx_nafdac_catalog_search ON nafdac_catalog(search_blob);

CREATE INDEX idx_notifications_branch ON notifications(branch_id, is_read) WHERE is_deleted = 0;

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_pending_user_transfer_open ON pending_user_transfers(user_id) WHERE status = 'PENDING' AND is_deleted = 0;

CREATE INDEX idx_pending_user_transfer_status ON pending_user_transfers(status, requested_at);

CREATE INDEX idx_plant_assets_business ON plant_assets(business_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_po_items_po ON purchase_order_items(purchase_order_id);

CREATE INDEX idx_po_receipts_po ON purchase_order_receipts(purchase_order_id);

CREATE INDEX idx_prescriptions_branch ON prescriptions(branch_id, created_at);

CREATE INDEX idx_prescriptions_sale ON prescriptions(sale_id);

CREATE INDEX idx_price_list_items_list ON price_list_items(price_list_id) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_price_list_items_unique ON price_list_items(price_list_id, product_id, variant_id, unit_code, min_quantity) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_price_lists_code ON price_lists(business_id, code) WHERE is_deleted = 0;

CREATE INDEX idx_price_overrides_branch_prod ON product_price_overrides(branch_id, product_id);

CREATE UNIQUE INDEX idx_product_barcodes_primary ON product_barcodes(product_id) WHERE is_primary = 1 AND is_deleted = 0;

CREATE INDEX idx_product_barcodes_product ON product_barcodes(product_id) WHERE is_deleted = 0;

CREATE INDEX idx_product_recalls_product ON product_recalls(product_id) WHERE is_deleted = 0;

CREATE INDEX idx_product_registrations_expiry ON product_registrations(expiry_date) WHERE is_deleted = 0 AND expiry_date IS NOT NULL;

CREATE INDEX idx_product_registrations_product ON product_registrations(product_id) WHERE is_deleted = 0;

CREATE INDEX idx_products_business ON products(business_id) WHERE is_deleted = 0;

CREATE INDEX idx_products_category ON products(category_id) WHERE is_deleted = 0;

CREATE INDEX idx_products_created_by ON products(created_by);

CREATE INDEX idx_products_dispensing ON products(dispensing_class);

CREATE INDEX idx_products_nafdac ON products(nafdac_catalog_id);

CREATE INDEX idx_products_name ON products(name) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_products_shared_sku
  ON products(sku)
  WHERE business_id IS NULL AND sku IS NOT NULL AND is_deleted = 0;

CREATE UNIQUE INDEX idx_products_sku_per_business ON products(business_id, sku) WHERE sku IS NOT NULL AND is_deleted = 0;

CREATE INDEX idx_purchase_orders_branch ON purchase_orders(branch_id);

CREATE INDEX idx_purchase_orders_supplier ON purchase_orders(supplier_id);

CREATE INDEX idx_return_items_return ON sale_return_items(sale_return_id);

CREATE UNIQUE INDEX idx_sale_issues_client_code ON sale_issues(client_id, code) WHERE client_id IS NOT NULL AND sale_id IS NULL;

CREATE INDEX idx_sale_issues_open ON sale_issues(business_id, status, detected_at);

CREATE UNIQUE INDEX idx_sale_issues_sale_code ON sale_issues(sale_id, code) WHERE sale_id IS NOT NULL;

CREATE INDEX idx_sale_items_batch ON sale_items(batch_id);

CREATE INDEX idx_sale_items_category ON sale_items(category_id, sale_id) WHERE is_deleted = 0;

CREATE INDEX idx_sale_items_product ON sale_items(product_id);

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);

CREATE INDEX idx_sale_payments_method ON sale_payments(branch_id, method, created_at);

CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);

CREATE INDEX idx_sale_payments_till ON sale_payments(till_session_id) WHERE till_session_id IS NOT NULL;

CREATE UNIQUE INDEX idx_sale_returns_no ON sale_returns(branch_id, return_no) WHERE is_deleted = 0;

CREATE INDEX idx_sale_returns_sale ON sale_returns(sale_id);

CREATE INDEX idx_sale_serials_item ON sale_serials(sale_item_id);

CREATE INDEX idx_sale_serials_serial ON sale_serials(serial_id);

CREATE INDEX idx_sales_branch ON sales(branch_id);

CREATE INDEX idx_sales_business ON sales(business_id);

CREATE INDEX idx_sales_created ON sales(created_at);

CREATE INDEX idx_sales_customer ON sales(customer_id) WHERE customer_id IS NOT NULL;

CREATE UNIQUE INDEX idx_sales_receipt_per_branch ON sales(branch_id, receipt_no) WHERE is_deleted = 0;

CREATE INDEX idx_sales_salesperson ON sales(salesperson_id) WHERE salesperson_id IS NOT NULL;

CREATE INDEX idx_sales_sold_at ON sales(sold_at);

CREATE INDEX idx_sales_status ON sales(branch_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_sales_targets_lookup ON sales_targets(business_id, branch_id, period_start);

CREATE INDEX idx_sales_vehicle ON sales(vehicle_id) WHERE is_deleted = 0 AND vehicle_id IS NOT NULL;

CREATE UNIQUE INDEX idx_serial_events_chain_link ON serial_events(serial_no, prev_hash);

CREATE INDEX idx_serial_events_serial ON serial_events(serial_id, created_at);

CREATE INDEX idx_serial_numbers_branch ON serial_numbers(branch_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_serial_numbers_imei ON serial_numbers(imei) WHERE imei IS NOT NULL;

CREATE INDEX idx_serial_numbers_sale ON serial_numbers(sale_id) WHERE sale_id IS NOT NULL;

CREATE INDEX idx_serial_numbers_serial ON serial_numbers(serial_no);

CREATE UNIQUE INDEX idx_serial_numbers_unique ON serial_numbers(product_id, serial_no) WHERE is_deleted = 0;

CREATE INDEX idx_stock_adjustments_batch ON stock_adjustments(batch_id);

CREATE INDEX idx_stock_adjustments_branch ON stock_adjustments(branch_id, created_at);

CREATE INDEX idx_stock_adjustments_type ON stock_adjustments(adjustment_type, created_at);

CREATE INDEX idx_stock_batches_branch ON stock_batches(branch_id);

CREATE INDEX idx_stock_batches_branch_prod ON stock_batches(branch_id, product_id, expiry_date);

CREATE INDEX idx_stock_batches_expiry ON stock_batches(expiry_date);

CREATE INDEX idx_stock_batches_product ON stock_batches(product_id);

CREATE INDEX idx_stock_batches_status ON stock_batches(branch_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_stock_batches_variant ON stock_batches(variant_id);

CREATE INDEX idx_stock_transfers_from ON stock_transfers(from_branch_id);

CREATE UNIQUE INDEX idx_stock_transfers_ref ON stock_transfers(reference) WHERE is_deleted = 0;

CREATE INDEX idx_stock_transfers_status ON stock_transfers(status) WHERE is_deleted = 0;

CREATE INDEX idx_stock_transfers_to ON stock_transfers(to_branch_id);

CREATE INDEX idx_stocktake_lines_session ON stocktake_lines(stocktake_id);

CREATE UNIQUE INDEX idx_stocktake_lines_unique ON stocktake_lines(stocktake_id, product_id, variant_id, batch_id) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_stocktake_one_open_per_branch ON stocktake_sessions(branch_id) WHERE status IN ('OPEN','COUNTING') AND is_deleted = 0;

CREATE INDEX idx_suppliers_business ON suppliers(business_id) WHERE is_deleted = 0;

CREATE INDEX idx_sync_change_log_branch ON sync_change_log(branch_id, synced_at);

CREATE INDEX idx_sync_change_log_synced_at ON sync_change_log(synced_at);

CREATE INDEX idx_sync_conflicts_unreviewed ON sync_conflicts(detected_at) WHERE reviewed_by IS NULL;

CREATE INDEX idx_till_sessions_branch ON till_sessions(branch_id, opened_at);

CREATE UNIQUE INDEX idx_till_sessions_one_open_per_branch ON till_sessions(branch_id) WHERE status = 'OPEN' AND is_deleted = 0;

CREATE INDEX idx_till_sessions_user ON till_sessions(user_id);

CREATE INDEX idx_transfer_items_transfer ON stock_transfer_items(transfer_id);

CREATE INDEX idx_transfer_serials_transfer ON stock_transfer_serials(transfer_id);

CREATE INDEX idx_user_assignment_history_user ON user_assignment_history(user_id, changed_at);

CREATE INDEX idx_user_business_access_user ON user_business_access(user_id) WHERE is_deleted = 0 AND revoked_at IS NULL;

CREATE INDEX idx_user_sessions_session ON user_sessions(session_id);

CREATE INDEX idx_users_branch ON users(branch_id);

CREATE INDEX idx_users_business ON users(business_id);

CREATE INDEX idx_users_pin_changed_at ON users(pin_changed_at);

CREATE INDEX idx_users_role ON users(role) WHERE is_deleted = 0;

CREATE INDEX idx_variants_product ON product_variants(product_id) WHERE is_deleted = 0;

CREATE UNIQUE INDEX idx_variants_product_sku ON product_variants(product_id, sku) WHERE sku IS NOT NULL AND is_deleted = 0;

CREATE INDEX idx_vehicle_duties_open ON vehicle_duties(vehicle_id, starts_on) WHERE is_deleted = 0 AND ended_at IS NULL;

CREATE INDEX idx_vehicle_duties_user ON vehicle_duties(user_id, starts_on) WHERE is_deleted = 0 AND ended_at IS NULL;

CREATE UNIQUE INDEX idx_warranty_claim_no ON warranty_claims(claim_no) WHERE is_deleted = 0;

CREATE INDEX idx_warranty_claims_customer ON warranty_claims(customer_id);

CREATE INDEX idx_warranty_claims_serial ON warranty_claims(serial_id) WHERE serial_id IS NOT NULL;

CREATE INDEX idx_warranty_claims_status ON warranty_claims(branch_id, status) WHERE is_deleted = 0;

CREATE INDEX idx_wht_entries_branch_date ON wht_entries(branch_id, entry_date);

CREATE INDEX idx_wht_entries_remittance ON wht_entries(direction, remitted_at);

CREATE INDEX idx_wht_entries_source ON wht_entries(source_type, source_id);

CREATE INDEX idx_wht_rates_active ON wht_rates(is_active, is_deleted);

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

CREATE VIEW v_branch_safe_balances AS
SELECT b.id AS branch_id, b.name AS branch_name, b.business_id,
       COALESCE((SELECT SUM(sl.amount) FROM branch_safe_ledger sl
                 WHERE sl.branch_id = b.id AND sl.is_deleted = 0), 0) AS safe_balance
FROM branches b
WHERE b.is_deleted = 0;

CREATE VIEW v_branch_sync_overview AS
SELECT b.id AS branch_id, b.name AS branch_name, b.business_id,
       ss.device_id, ss.app_version,
       ss.last_heartbeat_at, ss.last_push_at, ss.last_pull_at,
       ss.pending_push_count, ss.last_sync_error,
       CAST((julianday('now') - julianday(COALESCE(ss.last_push_at, ss.last_heartbeat_at, b.created_at))) * 24 AS REAL) AS hours_since_sync,
       CASE
         WHEN ss.last_heartbeat_at IS NULL THEN 'NEVER_SYNCED'
         WHEN (julianday('now') - julianday(ss.last_heartbeat_at)) * 24 > 24 THEN 'STALE'
         WHEN ss.last_sync_error IS NOT NULL THEN 'ERROR'
         ELSE 'HEALTHY'
       END AS sync_health
FROM branches b
LEFT JOIN branch_sync_status ss ON ss.branch_id = b.id
  AND ss.device_id = (
    SELECT s2.device_id FROM branch_sync_status s2
    WHERE s2.branch_id = b.id
    ORDER BY COALESCE(s2.last_heartbeat_at, s2.last_push_at, s2.updated_at) DESC
    LIMIT 1
  )
WHERE b.is_deleted = 0;

CREATE VIEW v_change_owed_outstanding AS
SELECT branch_id,
       COUNT(*) AS claim_count,
       SUM(amount) AS total_owed
FROM change_owed
WHERE status = 'OUTSTANDING' AND is_deleted = 0
GROUP BY branch_id;

CREATE VIEW v_compliance_expiry_alerts AS
SELECT r.id, r.branch_id, b.name AS branch_name, b.business_id,
       r.record_type, r.record_number, r.issued_by, r.expiry_date,
       CAST(julianday(r.expiry_date) - julianday('now') AS INTEGER) AS days_to_expiry
FROM branch_compliance_records r
JOIN branches b ON b.id = r.branch_id
WHERE r.is_deleted = 0 AND r.expiry_date IS NOT NULL
  AND julianday(r.expiry_date) - julianday('now') <= 90
ORDER BY r.expiry_date;

CREATE VIEW v_creditor_balances AS
SELECT s.id AS supplier_id, s.name AS supplier_name, s.business_id,
       COALESCE(SUM(cl.amount), 0) AS outstanding_balance
FROM suppliers s
LEFT JOIN creditor_ledger cl ON cl.supplier_id = s.id AND cl.is_deleted = 0
WHERE s.is_deleted = 0
GROUP BY s.id
HAVING outstanding_balance <> 0;

CREATE VIEW v_daily_sales_by_branch AS
SELECT branch_id,
       date(sold_at) AS sale_day,
       COUNT(*) AS sale_count,
       SUM(total) AS gross_sales,
       SUM(vat_amount) AS vat_collected,
       SUM(discount_amount) AS discounts_given,
       SUM(CASE WHEN status = 'VOIDED' THEN 1 ELSE 0 END) AS void_count,
       SUM(CASE WHEN status <> 'VOIDED' THEN total ELSE 0 END) AS net_sales
FROM sales
WHERE is_deleted = 0 AND status <> 'VOIDED'
GROUP BY branch_id, date(sold_at);

CREATE VIEW v_daily_sales_total AS
SELECT date(sold_at) AS sale_day,
       COUNT(*) AS sale_count,
       SUM(total) AS gross_sales,
       SUM(vat_amount) AS vat_collected,
       SUM(CASE WHEN status <> 'VOIDED' THEN total ELSE 0 END) AS net_sales
FROM sales
WHERE is_deleted = 0 AND status <> 'VOIDED'
GROUP BY date(sold_at);

CREATE VIEW v_debtor_ageing AS
SELECT c.id AS customer_id, c.name AS customer_name, c.branch_id, c.business_id,
       COALESCE(SUM(dl.amount), 0) AS total_outstanding,
       COALESCE(SUM(CASE WHEN julianday('now') - julianday(dl.created_at) <= 30 THEN dl.amount ELSE 0 END), 0) AS bucket_0_30,
       COALESCE(SUM(CASE WHEN julianday('now') - julianday(dl.created_at) > 30 AND julianday('now') - julianday(dl.created_at) <= 60 THEN dl.amount ELSE 0 END), 0) AS bucket_31_60,
       COALESCE(SUM(CASE WHEN julianday('now') - julianday(dl.created_at) > 60 AND julianday('now') - julianday(dl.created_at) <= 90 THEN dl.amount ELSE 0 END), 0) AS bucket_61_90,
       COALESCE(SUM(CASE WHEN julianday('now') - julianday(dl.created_at) > 90 THEN dl.amount ELSE 0 END), 0) AS bucket_90_plus
FROM customers c
JOIN debtor_ledger dl ON dl.customer_id = c.id AND dl.is_deleted = 0
WHERE c.is_deleted = 0
GROUP BY c.id
HAVING total_outstanding > 0;

CREATE VIEW v_debtor_balances AS
SELECT c.id AS customer_id, c.name AS customer_name, c.phone, c.business_id,
       c.branch_id, c.credit_limit,
       COALESCE(SUM(dl.amount), 0) AS outstanding_balance,
       c.credit_limit - COALESCE(SUM(dl.amount), 0) AS available_credit
FROM customers c
LEFT JOIN debtor_ledger dl ON dl.customer_id = c.id AND dl.is_deleted = 0
WHERE c.is_deleted = 0
GROUP BY c.id
HAVING outstanding_balance <> 0 OR c.credit_limit > 0;

CREATE VIEW v_expiry_alerts AS
SELECT sb.id AS batch_id, sb.branch_id, br.name AS branch_name,
       p.id AS product_id, p.name AS product_name,
       sb.batch_no, sb.expiry_date, sb.quantity,
       CAST(julianday(sb.expiry_date) - julianday('now') AS INTEGER) AS days_to_expiry
FROM stock_batches sb
JOIN products p ON p.id = sb.product_id
JOIN branches br ON br.id = sb.branch_id
WHERE sb.is_deleted = 0 AND sb.expiry_date IS NOT NULL AND sb.quantity > 0
  AND sb.status <> 'DEPLETED'
  AND julianday(sb.expiry_date) - julianday('now') <= 180
ORDER BY sb.expiry_date;

CREATE VIEW v_gl_account_balances AS
SELECT a.id AS account_id, a.code, a.name, a.account_type, a.normal_side, a.business_id,
       COALESCE(SUM(l.debit), 0) AS total_debit,
       COALESCE(SUM(l.credit), 0) AS total_credit,
       COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS debit_balance
FROM gl_accounts a
LEFT JOIN gl_journal_lines l ON l.account_id = a.id AND l.is_deleted = 0
LEFT JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.is_deleted = 0
WHERE a.is_deleted = 0
GROUP BY a.id;

CREATE VIEW v_gl_account_balances_total AS
SELECT a.account_type,
       SUM(COALESCE(l.debit, 0)) AS total_debit,
       SUM(COALESCE(l.credit, 0)) AS total_credit
FROM gl_accounts a
LEFT JOIN gl_journal_lines l ON l.account_id = a.id AND l.is_deleted = 0
LEFT JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.is_deleted = 0
WHERE a.is_deleted = 0
GROUP BY a.account_type;

CREATE VIEW v_instalment_overdue AS
SELECT ip.id AS plan_id, ip.plan_no, ip.customer_id, c.name AS customer_name, c.phone,
       ip.branch_id, ip.business_id, ip.total_payable, ip.amount_paid, ip.outstanding,
       ip.next_due_date, ip.status,
       CAST(julianday('now') - julianday(ip.next_due_date) AS INTEGER) AS days_overdue,
       ip.guarantor_name, ip.guarantor_phone
FROM instalment_plans ip
JOIN customers c ON c.id = ip.customer_id
WHERE ip.is_deleted = 0 AND ip.status = 'ACTIVE' AND ip.next_due_date IS NOT NULL
  AND julianday(ip.next_due_date) < julianday('now')
ORDER BY days_overdue DESC;

CREATE VIEW v_low_stock_alerts AS
SELECT p.id AS product_id, p.name AS product_name, p.sku, p.business_id,
       sb.branch_id, br.name AS branch_name,
       p.reorder_level,
       COALESCE(SUM(sb.quantity - sb.quantity_reserved), 0) AS available_qty,
       p.reorder_quantity
FROM products p
JOIN stock_batches sb ON sb.product_id = p.id AND sb.is_deleted = 0 AND sb.status = 'ACTIVE'
JOIN branches br ON br.id = sb.branch_id
WHERE p.is_deleted = 0 AND p.reorder_level > 0
GROUP BY p.id, sb.branch_id
HAVING available_qty <= p.reorder_level;

CREATE VIEW v_pending_deliveries AS
SELECT dj.id, dj.job_no, dj.branch_id, dj.status, dj.scheduled_at, dj.delivery_address,
       dj.customer_id, c.name AS customer_name, c.phone AS customer_phone,
       dj.sale_id, s.receipt_no, dj.fee, dj.driver_name,
       (SELECT COUNT(*) FROM delivery_job_items i WHERE i.delivery_job_id = dj.id AND i.is_deleted = 0) AS item_count
FROM delivery_jobs dj
LEFT JOIN customers c ON c.id = dj.customer_id
LEFT JOIN sales s ON s.id = dj.sale_id
WHERE dj.is_deleted = 0 AND dj.status IN ('PENDING','SCHEDULED','PICKED','IN_TRANSIT')
ORDER BY dj.scheduled_at;

CREATE VIEW v_revenue_by_category AS
SELECT si.category_id, c.name AS category_name, si.product_id, p.name AS product_name,
       s.branch_id, s.business_id, date(s.sold_at) AS sale_day,
       SUM(si.quantity_in_base) AS units_sold,
       SUM(si.line_total - si.vat_amount) AS revenue_net_of_vat,
       SUM(si.margin) AS gross_margin
FROM sale_items si
JOIN sales s ON s.id = si.sale_id AND s.is_deleted = 0 AND s.status <> 'VOIDED'
JOIN products p ON p.id = si.product_id
LEFT JOIN product_categories c ON c.id = si.category_id
WHERE si.is_deleted = 0
GROUP BY si.category_id, si.product_id, s.branch_id, date(s.sold_at);

CREATE VIEW v_sales_by_business AS
SELECT s.business_id,
       b.name AS business_name,
       date(s.sold_at) AS sale_day,
       COUNT(*) AS sale_count,
       SUM(s.total) AS gross_sales,
       SUM(s.vat_amount) AS vat_collected
FROM sales s JOIN businesses b ON b.id = s.business_id
WHERE s.is_deleted = 0 AND s.status <> 'VOIDED'
GROUP BY s.business_id, date(s.sold_at);

CREATE VIEW v_stock_on_hand AS
SELECT sb.branch_id,
       sb.business_id,
       sb.product_id,
       sb.variant_id,
       SUM(sb.quantity) AS total_qty,
       SUM(sb.quantity_reserved) AS reserved_qty,
       SUM(sb.quantity - sb.quantity_reserved) AS available_qty,
       SUM(CASE WHEN sb.status = 'QUARANTINED' THEN sb.quantity ELSE 0 END) AS quarantined_qty,
       SUM(sb.quantity * sb.cost_price_per_unit) AS stock_value_at_cost,
       SUM((sb.quantity - sb.quantity_reserved) * sb.selling_price_per_unit) AS sellable_value_at_retail
FROM stock_batches sb
WHERE sb.is_deleted = 0 AND sb.status IN ('ACTIVE','QUARANTINED')
GROUP BY sb.branch_id, sb.business_id, sb.product_id, sb.variant_id;

CREATE VIEW v_stock_value_by_branch AS
SELECT b.id AS branch_id, b.name AS branch_name, b.business_id,
       COALESCE(SUM(sb.quantity * sb.cost_price_per_unit), 0) AS stock_value_at_cost,
       COALESCE(SUM((sb.quantity - sb.quantity_reserved) * sb.selling_price_per_unit), 0) AS sellable_value_at_retail,
       COUNT(DISTINCT sb.product_id) AS distinct_products
FROM branches b
LEFT JOIN stock_batches sb ON sb.branch_id = b.id AND sb.is_deleted = 0 AND sb.status <> 'DEPLETED'
WHERE b.is_deleted = 0
GROUP BY b.id;

CREATE VIEW v_top_products AS
SELECT si.product_id, p.name AS product_name, p.brand, s.business_id, s.branch_id,
       SUM(si.quantity_in_base) AS units_sold,
       SUM(si.line_total) AS revenue,
       SUM(si.margin) AS gross_margin
FROM sale_items si
JOIN sales s ON s.id = si.sale_id AND s.is_deleted = 0 AND s.status <> 'VOIDED'
JOIN products p ON p.id = si.product_id
WHERE si.is_deleted = 0
GROUP BY si.product_id, s.branch_id
ORDER BY revenue DESC;

CREATE VIEW v_void_audit_by_user AS
SELECT u.id AS user_id, u.full_name, u.username, u.role, u.branch_id,
       COUNT(s.id) AS total_sales,
       SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS voided_sales,
       ROUND(100.0 * SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) / MAX(COUNT(s.id), 1), 2) AS void_rate_pct,
       SUM(CASE WHEN s.status = 'VOIDED' THEN s.total ELSE 0 END) AS voided_value
FROM users u
LEFT JOIN sales s ON s.salesperson_id = u.id AND s.is_deleted = 0
WHERE u.is_deleted = 0 AND u.role IN ('STAFF','MANAGER')
GROUP BY u.id;

CREATE VIEW v_warranty_status AS
SELECT sn.id AS serial_id, sn.serial_no, sn.imei, sn.status AS serial_status,
       p.id AS product_id, p.name AS product_name, p.brand,
       sn.warranty_starts_at, sn.warranty_ends_at,
       CAST(julianday(sn.warranty_ends_at) - julianday('now') AS INTEGER) AS days_remaining,
       sn.sale_id, sn.customer_id, c.name AS customer_name, c.phone AS customer_phone,
       sn.branch_id
FROM serial_numbers sn
JOIN products p ON p.id = sn.product_id
LEFT JOIN customers c ON c.id = sn.customer_id
WHERE sn.is_deleted = 0 AND sn.warranty_ends_at IS NOT NULL AND sn.status = 'SOLD';

PRAGMA foreign_keys = ON;

-- Formerly 0004_mixed_pharmacy_categories.sql. Kept here so a fresh database gets the same statements.
-- A database that already applied that file does not run this again.

-- A pharmacy that also sells like a supermarket needs the other shelf
-- categories, and a supermarket that dispenses needs a place to file drugs.
-- Missing codes only. Existing categories are left where the shop put them.
-- No products, prices, or stock.
-- D1 allows five compound SELECT terms, so this list is a VALUES table.

INSERT INTO product_categories (id, business_id, code, name, sort_order, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, v.code, v.name, v.sort_order, 1, datetime('now'), datetime('now')
FROM businesses b
JOIN (
  SELECT column1 AS profile_code, column2 AS code, column3 AS name, column4 AS sort_order
  FROM (
    VALUES
      ('PHARMACEUTICAL', 'PROVISIONS', 'Provisions', 40),
      ('PHARMACEUTICAL', 'DRINKS', 'Drinks', 41),
      ('PHARMACEUTICAL', 'SNACKS', 'Snacks', 42),
      ('PHARMACEUTICAL', 'PERSONAL_CARE', 'Personal care', 43),
      ('PHARMACEUTICAL', 'HOUSEHOLD', 'Household', 44),
      ('PHARMACEUTICAL', 'BABY', 'Baby care', 45),
      ('PHARMACEUTICAL', 'ACCESSORIES', 'Accessories', 46),
      ('SUPERMARKET', 'ANALGESICS', 'Analgesics', 50),
      ('SUPERMARKET', 'VITAMINS', 'Vitamins and supplements', 51),
      ('SUPERMARKET', 'RESPIRATORY', 'Respiratory', 52)
  )
) v ON v.profile_code = b.profile_code
WHERE b.is_deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM product_categories c
    WHERE c.business_id = b.id AND c.code = v.code AND c.is_deleted = 0
  );


-- Formerly 0005_sync_watermarks.sql. Kept here so a fresh database gets the same statements.
-- A database that already applied that file does not run this again.

-- The sync watermark. A later pull asks for rows changed since a timestamp.
-- Without an index on that timestamp, Turso scans the table and counts every
-- row it walks. These indexes are additive. They do not change a stored row,
-- and they are not partial: a soft-deleted row has to be findable too, or the
-- till would re-read the shelf to notice a removal.
-- Applied only when migrations run. Do not edit 0001 to 0004.

CREATE INDEX IF NOT EXISTS idx_sync_products_updated ON products(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_units_updated ON product_units(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_variants_updated ON product_variants(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_barcodes_updated ON product_barcodes(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_categories_updated ON product_categories(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_measures_updated ON product_measures(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_price_list_items_updated ON price_list_items(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_stock_batches_updated ON stock_batches(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_customers_updated ON customers(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sales_updated ON sales(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sale_items_updated ON sale_items(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sale_payments_updated ON sale_payments(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_purchase_orders_updated ON purchase_orders(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_purchase_order_items_updated ON purchase_order_items(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sale_serials_created ON sale_serials(created_at, id);


-- Formerly 0006_sync_revisions.sql. Kept here so a fresh database gets the same statements.
-- A database that already applied that file does not run this again.

-- One row per mirrored table. A real write bumps that row.
-- An idle till reads this table and does not open the catalogue.
-- Turso bills rows scanned, not rows returned. A three-minute
-- poll that walks products is the bill. A till that does not
-- send revisions keeps the watermark page. Do not edit 0001 to 0005.

CREATE TABLE IF NOT EXISTS sync_revisions (
  table_name  TEXT PRIMARY KEY,
  revision    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A day screen filters sold_at. date(sold_at) cannot use an index.
-- These match the filter and the order. They are not partial:
-- a voided or soft-deleted row still has to be findable.
CREATE INDEX IF NOT EXISTS idx_sales_business_sold ON sales(business_id, sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_branch_sold ON sales(branch_id, sold_at);
CREATE INDEX IF NOT EXISTS idx_products_business_updated ON products(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_customers_business_updated ON customers(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_stock_batches_business_updated ON stock_batches(business_id, updated_at, id);

INSERT INTO sync_revisions (table_name, revision, updated_at) VALUES
  ('businesses', 0, datetime('now')),
  ('branches', 0, datetime('now')),
  ('users', 0, datetime('now')),
  ('customer_classes', 0, datetime('now')),
  ('customers', 0, datetime('now')),
  ('product_categories', 0, datetime('now')),
  ('products', 0, datetime('now')),
  ('product_units', 0, datetime('now')),
  ('product_variants', 0, datetime('now')),
  ('product_barcodes', 0, datetime('now')),
  ('price_lists', 0, datetime('now')),
  ('price_list_items', 0, datetime('now')),
  ('product_price_overrides', 0, datetime('now')),
  ('suppliers', 0, datetime('now')),
  ('stock_batches', 0, datetime('now')),
  ('branch_compliance_records', 0, datetime('now')),
  ('branch_safe_ledger', 0, datetime('now')),
  ('purchase_orders', 0, datetime('now')),
  ('deposits', 0, datetime('now')),
  ('instalment_plans', 0, datetime('now')),
  ('delivery_jobs', 0, datetime('now')),
  ('client_settings', 0, datetime('now')),
  ('product_measures', 0, datetime('now')),
  ('purchase_order_items', 0, datetime('now')),
  ('sales', 0, datetime('now')),
  ('sale_items', 0, datetime('now')),
  ('sale_payments', 0, datetime('now')),
  ('sale_serials', 0, datetime('now')),
  ('sale_returns', 0, datetime('now')),
  ('sale_return_items', 0, datetime('now')),
  ('customer_bills', 0, datetime('now')),
  ('bill_holds', 0, datetime('now')),
  ('sale_issues', 0, datetime('now')),
  ('change_owed', 0, datetime('now')),
  ('till_sessions', 0, datetime('now')),
  ('serial_numbers', 0, datetime('now'))
ON CONFLICT(table_name) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS trg_rev_businesses_ins
AFTER INSERT ON businesses
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('businesses', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_businesses_upd
AFTER UPDATE ON businesses
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('businesses', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_businesses_del
AFTER DELETE ON businesses
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('businesses', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branches_ins
AFTER INSERT ON branches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branches_upd
AFTER UPDATE ON branches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branches_del
AFTER DELETE ON branches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_users_ins
AFTER INSERT ON users
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('users', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_users_upd
AFTER UPDATE ON users
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('users', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_users_del
AFTER DELETE ON users
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('users', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_classes_ins
AFTER INSERT ON customer_classes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_classes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_classes_upd
AFTER UPDATE ON customer_classes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_classes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_classes_del
AFTER DELETE ON customer_classes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_classes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customers_ins
AFTER INSERT ON customers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customers_upd
AFTER UPDATE ON customers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customers_del
AFTER DELETE ON customers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_categories_ins
AFTER INSERT ON product_categories
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_categories', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_categories_upd
AFTER UPDATE ON product_categories
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_categories', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_categories_del
AFTER DELETE ON product_categories
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_categories', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_products_ins
AFTER INSERT ON products
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('products', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_products_upd
AFTER UPDATE ON products
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('products', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_products_del
AFTER DELETE ON products
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('products', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_units_ins
AFTER INSERT ON product_units
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_units', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_units_upd
AFTER UPDATE ON product_units
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_units', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_units_del
AFTER DELETE ON product_units
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_units', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_variants_ins
AFTER INSERT ON product_variants
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_variants', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_variants_upd
AFTER UPDATE ON product_variants
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_variants', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_variants_del
AFTER DELETE ON product_variants
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_variants', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_barcodes_ins
AFTER INSERT ON product_barcodes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_barcodes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_barcodes_upd
AFTER UPDATE ON product_barcodes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_barcodes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_barcodes_del
AFTER DELETE ON product_barcodes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_barcodes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_lists_ins
AFTER INSERT ON price_lists
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_lists', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_lists_upd
AFTER UPDATE ON price_lists
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_lists', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_lists_del
AFTER DELETE ON price_lists
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_lists', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_list_items_ins
AFTER INSERT ON price_list_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_list_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_list_items_upd
AFTER UPDATE ON price_list_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_list_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_list_items_del
AFTER DELETE ON price_list_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_list_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_price_overrides_ins
AFTER INSERT ON product_price_overrides
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_price_overrides', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_price_overrides_upd
AFTER UPDATE ON product_price_overrides
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_price_overrides', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_price_overrides_del
AFTER DELETE ON product_price_overrides
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_price_overrides', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_suppliers_ins
AFTER INSERT ON suppliers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('suppliers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_suppliers_upd
AFTER UPDATE ON suppliers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('suppliers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_suppliers_del
AFTER DELETE ON suppliers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('suppliers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_stock_batches_ins
AFTER INSERT ON stock_batches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('stock_batches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_stock_batches_upd
AFTER UPDATE ON stock_batches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('stock_batches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_stock_batches_del
AFTER DELETE ON stock_batches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('stock_batches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_compliance_records_ins
AFTER INSERT ON branch_compliance_records
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_compliance_records', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_compliance_records_upd
AFTER UPDATE ON branch_compliance_records
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_compliance_records', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_compliance_records_del
AFTER DELETE ON branch_compliance_records
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_compliance_records', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_safe_ledger_ins
AFTER INSERT ON branch_safe_ledger
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_safe_ledger', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_safe_ledger_upd
AFTER UPDATE ON branch_safe_ledger
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_safe_ledger', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_safe_ledger_del
AFTER DELETE ON branch_safe_ledger
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_safe_ledger', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_orders_ins
AFTER INSERT ON purchase_orders
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_orders', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_orders_upd
AFTER UPDATE ON purchase_orders
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_orders', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_orders_del
AFTER DELETE ON purchase_orders
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_orders', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_deposits_ins
AFTER INSERT ON deposits
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('deposits', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_deposits_upd
AFTER UPDATE ON deposits
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('deposits', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_deposits_del
AFTER DELETE ON deposits
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('deposits', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_instalment_plans_ins
AFTER INSERT ON instalment_plans
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('instalment_plans', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_instalment_plans_upd
AFTER UPDATE ON instalment_plans
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('instalment_plans', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_instalment_plans_del
AFTER DELETE ON instalment_plans
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('instalment_plans', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_delivery_jobs_ins
AFTER INSERT ON delivery_jobs
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('delivery_jobs', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_delivery_jobs_upd
AFTER UPDATE ON delivery_jobs
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('delivery_jobs', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_delivery_jobs_del
AFTER DELETE ON delivery_jobs
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('delivery_jobs', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_client_settings_ins
AFTER INSERT ON client_settings
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('client_settings', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_client_settings_upd
AFTER UPDATE ON client_settings
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('client_settings', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_client_settings_del
AFTER DELETE ON client_settings
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('client_settings', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_measures_ins
AFTER INSERT ON product_measures
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_measures', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_measures_upd
AFTER UPDATE ON product_measures
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_measures', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_measures_del
AFTER DELETE ON product_measures
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_measures', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_order_items_ins
AFTER INSERT ON purchase_order_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_order_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_order_items_upd
AFTER UPDATE ON purchase_order_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_order_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_order_items_del
AFTER DELETE ON purchase_order_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_order_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sales_ins
AFTER INSERT ON sales
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sales', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sales_upd
AFTER UPDATE ON sales
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sales', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sales_del
AFTER DELETE ON sales
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sales', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_items_ins
AFTER INSERT ON sale_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_items_upd
AFTER UPDATE ON sale_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_items_del
AFTER DELETE ON sale_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_payments_ins
AFTER INSERT ON sale_payments
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_payments', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_payments_upd
AFTER UPDATE ON sale_payments
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_payments', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_payments_del
AFTER DELETE ON sale_payments
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_payments', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_serials_ins
AFTER INSERT ON sale_serials
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_serials', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_serials_upd
AFTER UPDATE ON sale_serials
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_serials', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_serials_del
AFTER DELETE ON sale_serials
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_serials', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_returns_ins
AFTER INSERT ON sale_returns
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_returns', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_returns_upd
AFTER UPDATE ON sale_returns
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_returns', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_returns_del
AFTER DELETE ON sale_returns
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_returns', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_return_items_ins
AFTER INSERT ON sale_return_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_return_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_return_items_upd
AFTER UPDATE ON sale_return_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_return_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_return_items_del
AFTER DELETE ON sale_return_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_return_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_bills_ins
AFTER INSERT ON customer_bills
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_bills', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_bills_upd
AFTER UPDATE ON customer_bills
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_bills', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_bills_del
AFTER DELETE ON customer_bills
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_bills', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_bill_holds_ins
AFTER INSERT ON bill_holds
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('bill_holds', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_bill_holds_upd
AFTER UPDATE ON bill_holds
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('bill_holds', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_bill_holds_del
AFTER DELETE ON bill_holds
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('bill_holds', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_issues_ins
AFTER INSERT ON sale_issues
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_issues', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_issues_upd
AFTER UPDATE ON sale_issues
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_issues', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_issues_del
AFTER DELETE ON sale_issues
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_issues', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_change_owed_ins
AFTER INSERT ON change_owed
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('change_owed', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_change_owed_upd
AFTER UPDATE ON change_owed
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('change_owed', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_change_owed_del
AFTER DELETE ON change_owed
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('change_owed', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_till_sessions_ins
AFTER INSERT ON till_sessions
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('till_sessions', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_till_sessions_upd
AFTER UPDATE ON till_sessions
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('till_sessions', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_till_sessions_del
AFTER DELETE ON till_sessions
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('till_sessions', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_serial_numbers_ins
AFTER INSERT ON serial_numbers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('serial_numbers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_serial_numbers_upd
AFTER UPDATE ON serial_numbers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('serial_numbers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_serial_numbers_del
AFTER DELETE ON serial_numbers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('serial_numbers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;


-- Formerly 0007_pharma_shelves.sql, without the aisle retirement.
-- Drug shelves are added where missing. Other categories stay on the same list.
-- A database that already applied 0007 does not run this again.

INSERT INTO product_categories (id, business_id, code, name, sort_order, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, v.code, v.name, v.sort_order, 1, datetime('now'), datetime('now')
FROM businesses b
JOIN (
  SELECT column1 AS code, column2 AS name, column3 AS sort_order
  FROM (
    VALUES
      ('ALIMENTARY', 'Alimentary', 10),
      ('ANALGESICS', 'Analgesics', 11),
      ('ANTI_INFECTIVES', 'Anti-infectives', 12),
      ('ANTINEOPLASTIC', 'Antineoplastic', 13),
      ('ANTIPARASITIC', 'Antiparasitic', 14),
      ('BLOOD', 'Blood and blood forming', 15),
      ('CARDIOVASCULAR', 'Cardiovascular', 16),
      ('CONTROLLED', 'Controlled medicines', 17),
      ('DERMATOLOGY', 'Dermatology', 18),
      ('GENITO_URINARY', 'Genito-urinary', 19),
      ('INJECTIONS', 'Injections', 20),
      ('MEDICAL_DEVICE', 'Medical devices', 21),
      ('MUSCULOSKELETAL', 'Musculoskeletal', 22),
      ('NERVOUS_SYSTEM', 'Nervous system', 23),
      ('PHARMA_OTHER', 'Other medicines', 24),
      ('PHARMA_VARIOUS', 'Various', 25),
      ('RESPIRATORY', 'Respiratory', 26),
      ('SENSORY', 'Sensory organs', 27),
      ('SYSTEMIC_HORMONES', 'Systemic hormones', 28),
      ('VACCINES', 'Vaccines and biologics', 29),
      ('VETERINARY', 'Veterinary', 30),
      ('VITAMINS', 'Vitamins and supplements', 31)
  )
) v
WHERE b.is_deleted = 0
  AND b.profile_code = 'PHARMACEUTICAL'
  AND NOT EXISTS (
    SELECT 1 FROM product_categories c
    WHERE c.business_id = b.id AND c.code = v.code AND c.is_deleted = 0
  );

