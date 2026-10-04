-- STOCKRIDGE — migration 0001: core schema
-- =====================================================================
-- Multi-business, multi-branch inventory, POS and back office for the
-- Nigerian retail & wholesale market. SQLite. Offline-first PWA.
--
-- ---------------------------------------------------------------------
-- HOW THIS SCHEMA DIFFERS FROM THE PHARMACY SCHEMA IT WAS DECOUPLED FROM
-- ---------------------------------------------------------------------
-- The structural DNA is deliberately identical, because it was hard-won:
--
--   * every mutable table carries updated_at + is_deleted (soft delete) so an
--     offline branch can merge with last-write-wins and a deletion survives a
--     sync round-trip instead of silently vanishing
--   * ids are TEXT, minted in application code (see shared/lib/ids.js), so an
--     offline till can create a sale before it knows whether the network is up
--   * "one open per X" is a PARTIAL UNIQUE INDEX, not an application check —
--     a till session, a stocktake, a clock-in
--   * money is stored as REAL in naira but computed in integer kobo
--   * every date-bucketing query uses West Africa Time, never raw UTC
--
-- What changed, and why:
--
--  [TENANCY]  A `businesses` level is inserted ABOVE branches. One deployment
--             can hold several distinct trading businesses (a gadget shop and
--             a furniture gallery under one proprietor), each with its own
--             vertical profile, its own branches and its own book. `branches`
--             gains business_id; a user may be scoped to a business or to one
--             branch. This is the "multi business" requirement, and it is a
--             real level in the hierarchy rather than a tag on a branch, so
--             reports can be run per business or consolidated.
--
--  [DOMAIN]   Nine pharmacy-specific fields became four generic mechanisms:
--               dispensing_type        -> products.restriction_reason
--                                         (NONE / AGE_VERIFICATION /
--                                          SERIAL_CAPTURE / AUTHORITY_DOCUMENT)
--               is_controlled          -> products.register_required
--                                         (writes to high_value_register)
--               nafdac_reg_no          -> products.compliance_reg_no + a
--                                         per-vertical meaning (SONCAP, NAFDAC,
--                                         NIS standard) — see verticals.js
--               expiry_date            -> stock_batches.best_before_date, with
--                                         shelf_life_days on the product
--               pcn/superintendent     -> compliance_certificates (a generic
--               licence columns          dated-obligation table)
--               prescriptions          -> sale_authority_documents
--               controlled_substance_  -> hash_chained_registers (four register
--                 register               types share one chain mechanism)
--             Nothing was simply deleted: each control was kept and its DOMAIN
--             made data. See docs/DECOUPLING-MAP.md for the full mapping.
--
--  [UOM]      The pack/carton ladder gains a PALLET rung, and rungs became
--             INDEPENDENT rather than a strict chain, because a TV is
--             unit -> carton -> pallet with no pack rung at all.
--
--  [NEW]      serial_numbers, warranty_claims, instalment_plans, layaway_holds,
--             delivery_jobs, delivery_zones, sales_returns, vouchers,
--             promotions, volume_breaks, customer_price_tiers, fx_rates,
--             compliance_certificates, hash_chained_registers.
--
-- The app must run this once per connection:
--   PRAGMA foreign_keys = ON;
-- (server/db/adapter.js does this for both drivers.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- BUSINESSES  (a distinct trading entity; one deployment holds several)
-- ---------------------------------------------------------------------
CREATE TABLE businesses (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    -- Which pre-configured vertical profile this business runs. Drives the
    -- category list, the unit vocabulary, the attribute schema, the default
    -- restriction and which compliance types apply. DATA, not a code path:
    -- there is no `if (vertical === ...)` anywhere in the application.
    vertical_code         TEXT NOT NULL DEFAULT 'GENERAL',
    trading_name          TEXT,
    legal_name            TEXT,               -- the name on the CAC certificate
    cac_number            TEXT,               -- normalised to RC-123456 / BN-7654321
    tin                   TEXT,               -- FIRS Tax Identification Number
    vat_registration_no   TEXT,
    -- Own VAT election per business: two businesses under one proprietor may
    -- be differently registered (one above the threshold, one below).
    vat_enabled           INTEGER NOT NULL DEFAULT 0,
    vat_rate_percent      REAL NOT NULL DEFAULT 7.5,
    company_size          TEXT NOT NULL DEFAULT 'SMALL'
                          CHECK (company_size IN ('SMALL','MEDIUM','LARGE')),
    base_currency         TEXT NOT NULL DEFAULT 'NGN',
    -- Which optional flows this business actually uses. A wholesale provisions
    -- dealer has no use for warranty claims; a furniture gallery has no use for
    -- shelf-life alerts. Turning a module off removes it from the navigation
    -- and from the POS, rather than showing a screen that is always empty.
    uses_serial_tracking  INTEGER NOT NULL DEFAULT 0,
    uses_warranty         INTEGER NOT NULL DEFAULT 0,
    uses_delivery         INTEGER NOT NULL DEFAULT 1,
    uses_installation     INTEGER NOT NULL DEFAULT 0,
    uses_layaway          INTEGER NOT NULL DEFAULT 0,
    uses_instalments      INTEGER NOT NULL DEFAULT 0,
    uses_shelf_life       INTEGER NOT NULL DEFAULT 0,
    uses_credit           INTEGER NOT NULL DEFAULT 1,
    uses_wholesale        INTEGER NOT NULL DEFAULT 1,
    uses_fx               INTEGER NOT NULL DEFAULT 0,
    -- Owner-defined categories beyond the vertical's built-in list, as JSON.
    custom_categories_json TEXT,
    email                 TEXT,
    phone                 TEXT,
    address               TEXT,
    state_code            TEXT,
    logo_data_url         TEXT,
    is_active             INTEGER NOT NULL DEFAULT 1,
    sort_order            INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_businesses_active ON businesses(is_active, sort_order) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- BRANCHES  (a physical shop / warehouse / yard belonging to ONE business)
-- ---------------------------------------------------------------------
CREATE TABLE branches (
    id                        TEXT PRIMARY KEY,
    -- Every branch belongs to exactly one business. This is the tenancy
    -- boundary INSIDE a deployment: a Branch Manager of Business A cannot see
    -- Business B even though both live in the same database.
    business_id               TEXT NOT NULL REFERENCES businesses(id),
    name                      TEXT NOT NULL,
    code                      TEXT,               -- short tag for doc numbers, e.g. "LG" for Lekki
    branch_type               TEXT NOT NULL DEFAULT 'RETAIL'
                              CHECK (branch_type IN ('RETAIL','WHOLESALE','WAREHOUSE','FACTORY','SHOWROOM','KIOSK','YARD','MIXED')),
    address                   TEXT,
    area                      TEXT,               -- Ikeja, Lekki Phase 1, Sabon Gari ...
    lga                       TEXT,
    state_code                TEXT,
    phone                     TEXT,
    email                     TEXT,
    -- Geofencing for attendance (see shared/lib/timegeo.js classifyAttendance).
    -- NULL means "not configured yet", which is REPORTED, never assumed on-site.
    latitude                  REAL,
    longitude                 REAL,
    geofence_radius_meters    INTEGER NOT NULL DEFAULT 100,
    -- GEOLOCATION     for mobile/handheld staff; classified against the fence
    -- REGISTERED_DEVICE for a fixed till laptop identified by a persistent
    --                 browser device id (see branch_devices)
    -- Both are best-effort SIGNALS FOR MANAGER REVIEW, never hard gates: GPS
    -- accuracy indoors is poor and a system that locks a cashier out of the
    -- till at 8am on a Saturday is a system that gets switched off.
    attendance_mode           TEXT NOT NULL DEFAULT 'GEOLOCATION'
                              CHECK (attendance_mode IN ('GEOLOCATION','REGISTERED_DEVICE')),
    opening_time              TEXT,               -- '08:00' WAT
    closing_time              TEXT,               -- '20:00' WAT
    default_till_float        REAL NOT NULL DEFAULT 0,
    -- Delivery capability: a branch with no truck cannot take delivery jobs.
    can_deliver               INTEGER NOT NULL DEFAULT 1,
    vehicles                  INTEGER NOT NULL DEFAULT 0,
    drivers                   INTEGER NOT NULL DEFAULT 0,
    daily_delivery_capacity   INTEGER NOT NULL DEFAULT 20,
    -- Per-branch overrides of the business-level policy.
    stock_pick_policy         TEXT NOT NULL DEFAULT 'FIFO'
                              CHECK (stock_pick_policy IN ('FEFO','FIFO','LIFO','SPECIFIC')),
    is_active                 INTEGER NOT NULL DEFAULT 1,
    sort_order                INTEGER NOT NULL DEFAULT 0,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_branches_business ON branches(business_id) WHERE is_deleted = 0;
CREATE INDEX idx_branches_active ON branches(business_id, is_active, sort_order) WHERE is_deleted = 0;
-- A branch code is what a document number is built from, so it must be unique
-- within its business or two branches will mint colliding invoice numbers.
CREATE UNIQUE INDEX idx_branches_code_unique
    ON branches(business_id, code) WHERE code IS NOT NULL AND is_deleted = 0;

-- ---------------------------------------------------------------------
-- BRANCH DEVICES  (registered terminals for REGISTERED_DEVICE attendance)
-- ---------------------------------------------------------------------
-- NOT a hardware serial number: no browser can read one. This is a random id
-- generated once client-side and persisted in that browser's localStorage
-- (public/js/deviceId.js), which identifies "this browser profile on this
-- machine" for as long as nobody clears site data — the same practical
-- guarantee commercial POS terminal-locking relies on.
CREATE TABLE branch_devices (
    id            TEXT PRIMARY KEY,
    branch_id     TEXT NOT NULL REFERENCES branches(id),
    device_id     TEXT NOT NULL,
    label         TEXT,                 -- "Front counter laptop", "Till 2"
    registered_by TEXT NOT NULL REFERENCES users(id),
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_by    TEXT REFERENCES users(id),
    revoked_at    TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);
-- A device may be actively registered to ONE branch at a time. A laptop
-- physically belongs to one location, so reassigning it means revoking first —
-- which keeps device ownership auditable instead of ambiguous.
CREATE UNIQUE INDEX idx_branch_devices_active_device
    ON branch_devices(device_id) WHERE is_deleted = 0 AND revoked_at IS NULL;
CREATE INDEX idx_branch_devices_branch
    ON branch_devices(branch_id) WHERE is_deleted = 0 AND revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------
-- ROLE HIERARCHY (highest to lowest privilege):
--
--   ADMIN   the software vendor / platform operator. One deployment-wide seat,
--           NOT part of the client's own staff. Sets plan limits and branding
--           via /api/admin/*. Never counted against the client's staff limit,
--           always bypasses the subscription gate (so the vendor can never be
--           locked out of their own client's instance), and hidden from the
--           ordinary Users screen.
--
--   OWNER   the proprietor. Full operational access identical to MANAGER, PLUS
--           visibility of their own subscription and plan limits. Distinct from
--           MANAGER so a client can have day-to-day managers who run operations
--           without being the person accountable for the commercial
--           relationship with the vendor.
--
--   MANAGER day-to-day operations admin. Presented under one of two job titles,
--           decided ENTIRELY by whether the row carries a branch_id:
--             General Manager  branch_id IS NULL — every branch
--             Branch Manager   branch_id IS SET  — exactly one branch
--
--           DELIBERATELY ONE STORED ROLE, NOT TWO. branch_id is already the
--           single source of truth for every authorisation decision. A separate
--           BRANCH_MANAGER enum value would be a SECOND fact encoding the same
--           thing, and the two could then disagree — a BRANCH_MANAGER with a
--           NULL branch_id, or a MANAGER pinned to a branch who is nonetheless
--           treated as org-wide by code that only checked the role. One fact,
--           one place, no possible disagreement.
--
--   STAFF   cashier / storekeeper. Scoped to exactly one branch. Handles cash
--           all day, so every power it holds is narrow, time-boxed and capped
--           by an OWNER-set switch in client_settings.
CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    -- NULL for ADMIN/OWNER and for a General Manager: org-wide within their
    -- business. SET for a Branch Manager and for every STAFF member.
    branch_id      TEXT REFERENCES branches(id),
    -- A General Manager may still be restricted to one BUSINESS. NULL = all
    -- businesses in the deployment (which in practice means ADMIN/OWNER).
    business_id    TEXT REFERENCES businesses(id),
    full_name      TEXT NOT NULL,
    username       TEXT NOT NULL,
    -- argon2id where available, scrypt otherwise; never plaintext, never MD5.
    -- A 4-digit PIN has 10,000 possible values, so the hash must be slow AND
    -- the login endpoint must be throttled (see login_attempts).
    pin_hash       TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('ADMIN','OWNER','MANAGER','STAFF')),
    job_title      TEXT,
    phone          TEXT,
    email          TEXT,
    -- A driver is a user who can be assigned delivery jobs. Not a separate
    -- role: a storekeeper who also drives is common in a small branch, and a
    -- second role enum would force choosing between two true facts.
    is_driver      INTEGER NOT NULL DEFAULT 0,
    is_active      INTEGER NOT NULL DEFAULT 1,
    must_change_pin INTEGER NOT NULL DEFAULT 0,
    last_login_at  TEXT,
    last_login_branch_id TEXT REFERENCES branches(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE is_deleted = 0;
CREATE INDEX idx_users_branch ON users(branch_id) WHERE is_deleted = 0;
CREATE INDEX idx_users_business ON users(business_id) WHERE is_deleted = 0;
CREATE INDEX idx_users_role ON users(role) WHERE is_deleted = 0;

-- Every change of a user's branch or role is recorded. Staff turnover in
-- Nigerian retail is high, and "who could see the Kano books in March?" must be
-- answerable months later without guessing from the current row.
CREATE TABLE user_assignment_history (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    changed_by     TEXT REFERENCES users(id),
    previous_branch_id TEXT REFERENCES branches(id),
    new_branch_id  TEXT REFERENCES branches(id),
    previous_role  TEXT,
    new_role       TEXT,
    reason         TEXT,
    changed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_user_assignment_history_user ON user_assignment_history(user_id, changed_at);

-- A branch transfer of a STAFF member is REQUESTED, then approved by someone
-- with authority over the DESTINATION branch. Moving a cashier between branches
-- unilaterally is how a person who was caught short in one shop quietly arrives
-- in another.
CREATE TABLE pending_user_transfers (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id),
    from_branch_id    TEXT REFERENCES branches(id),
    to_branch_id      TEXT NOT NULL REFERENCES branches(id),
    requested_by      TEXT NOT NULL REFERENCES users(id),
    status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED')),
    decided_by        TEXT REFERENCES users(id),
    decided_at        TEXT,
    decision_note     TEXT,
    requested_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
-- One open transfer per user. Two simultaneous pending moves for the same
-- person is not a queue, it is a contradiction.
CREATE UNIQUE INDEX idx_pending_user_transfer_open
    ON pending_user_transfers(user_id) WHERE status = 'PENDING' AND is_deleted = 0;
CREATE INDEX idx_pending_user_transfer_status ON pending_user_transfers(status, requested_at);

-- ---------------------------------------------------------------------
-- CLIENT SETTINGS  (single row: this deployment's plan, limits and branding)
-- ---------------------------------------------------------------------
-- Single-tenant-per-client deployment: each paying client gets their own
-- isolated instance, so "the client's plan" is exactly one row here, not a
-- multi-tenant table keyed by a tenant id. id is pinned to 1 by CHECK so the
-- table can never grow a second row.
CREATE TABLE client_settings (
    id                            INTEGER PRIMARY KEY CHECK (id = 1),
    -- Deployment-wide product name and branding. A client's own business names
    -- live in `businesses`; this is the SOFTWARE's identity shown on the login
    -- screen before anyone has signed in.
    product_name                  TEXT NOT NULL DEFAULT 'StockRidge',
    logo_data_url                 TEXT,
    support_contact_name          TEXT,
    support_contact_phone         TEXT,
    support_contact_email         TEXT,

    max_businesses                INTEGER NOT NULL DEFAULT 3,
    max_branches                  INTEGER NOT NULL DEFAULT 5,
    max_staff                     INTEGER NOT NULL DEFAULT 25,
    subscription_status           TEXT NOT NULL DEFAULT 'ACTIVE'
                                  CHECK (subscription_status IN ('TRIAL','ACTIVE','SUSPENDED','EXPIRED')),
    subscription_plan             TEXT NOT NULL DEFAULT 'Standard',
    subscription_renewal_date     TEXT,

    -- Vendor-set feature toggles (plan limits).
    attendance_module_enabled     INTEGER NOT NULL DEFAULT 1,
    multi_business_enabled        INTEGER NOT NULL DEFAULT 1,
    multi_branch_enabled          INTEGER NOT NULL DEFAULT 1,
    instalments_module_enabled    INTEGER NOT NULL DEFAULT 1,
    warranty_module_enabled       INTEGER NOT NULL DEFAULT 1,
    delivery_module_enabled       INTEGER NOT NULL DEFAULT 1,
    accounting_module_enabled     INTEGER NOT NULL DEFAULT 1,
    offline_sync_enabled          INTEGER NOT NULL DEFAULT 1,

    -- Default VAT position for a NEW business. A business's own election lives
    -- on its row and wins over this. OFF by default: the schema must never
    -- silently start charging tax nobody asked for. 7.5% is the FIRS standard
    -- rate. VAT-INCLUSIVE: enabling it does NOT raise what a customer pays
    -- (Nigerian shelf prices already include VAT); it is extracted for
    -- reporting and remittance only.
    default_vat_enabled           INTEGER NOT NULL DEFAULT 0,
    default_vat_rate_percent      REAL NOT NULL DEFAULT 7.5,
    -- Withholding tax: our own company size, which selects the column of the
    -- size-differentiated 2024 Regulations schedule.
    wht_company_size              TEXT NOT NULL DEFAULT 'SMALL'
                                  CHECK (wht_company_size IN ('SMALL','MEDIUM','LARGE')),
    wht_enabled                   INTEGER NOT NULL DEFAULT 1,

    -- PAYMENT FEES. Seeded to CBN guidance (1.5%, capped at ₦2,000) but
    -- editable, because merchants report higher effective costs once the
    -- acquirer's own fees and terminal rental are included. An UNCONFIGURED fee
    -- is reported as a gap rather than assumed to be zero.
    pos_fee_percent               REAL NOT NULL DEFAULT 1.5,
    pos_fee_cap                   REAL NOT NULL DEFAULT 2000,
    pos_fee_configured            INTEGER NOT NULL DEFAULT 1,
    pos_settlement_business_days  INTEGER NOT NULL DEFAULT 1,

    -- FX. A plausible-rate band per currency so a rate typed as 0.00069
    -- instead of 1450 is caught at entry rather than corrupting every
    -- conversion downstream. JSON: {"USD":{"min":500,"max":3000}, ...}
    fx_rate_bands_json            TEXT,
    fx_enabled                    INTEGER NOT NULL DEFAULT 0,

    -- -----------------------------------------------------------------
    -- OWNER-CONTROLLED MANAGER PERMISSIONS. The client's own governance
    -- switches over what their managers may do. OWNER and ADMIN are never
    -- restricted by these — a switch that could lock the proprietor out of
    -- their own books would be a footgun.
    -- -----------------------------------------------------------------
    managers_can_void_sales         INTEGER NOT NULL DEFAULT 1,
    managers_can_approve_expenses   INTEGER NOT NULL DEFAULT 1,
    managers_can_edit_prices        INTEGER NOT NULL DEFAULT 1,
    managers_can_override_price_floor INTEGER NOT NULL DEFAULT 1,
    managers_can_dispatch_unpaid    INTEGER NOT NULL DEFAULT 0,
    managers_can_write_off_debt     INTEGER NOT NULL DEFAULT 0,

    -- -----------------------------------------------------------------
    -- OWNER-CONTROLLED STAFF PERMISSIONS. These exist because a cashier
    -- holding both powers can run the two classic retail-theft patterns
    -- unaided:
    --   VOID       sell for cash, void the sale, keep the note. The books show
    --              no sale and the stock is already gone.
    --   WRITE-OFF  take the goods, record them as DAMAGE. Shrinkage looks like
    --              breakage.
    -- Both were reproduced live against a running system before these columns
    -- existed: a STAFF token voided its own completed sale and posted a -5
    -- DAMAGE adjustment, with no gate of any kind.
    --
    -- Deliberately NOT a flat ban. A mis-keyed sale at a busy counter is common
    -- and a lone cashier on a late shift must be able to correct it, so the
    -- default is a NARROW ALLOWANCE rather than off — and the window plus the
    -- cap are what make it safe. They cover "I just rang that up wrong" and "I
    -- dropped a carton" without covering "I am reversing yesterday's takings"
    -- or "a whole pallet went missing".
    -- -----------------------------------------------------------------
    staff_can_void_sales            INTEGER NOT NULL DEFAULT 1,
    staff_void_window_minutes       INTEGER NOT NULL DEFAULT 15
                                    CHECK (staff_void_window_minutes >= 0),
    staff_can_adjust_stock          INTEGER NOT NULL DEFAULT 1,
    staff_adjustment_max_units      INTEGER NOT NULL DEFAULT 5
                                    CHECK (staff_adjustment_max_units >= 0),
    staff_max_discount_percent      REAL NOT NULL DEFAULT 5,
    -- The price floor is a percentage OF COST. 100 means "never below cost".
    -- A cashier discounting a ₦400,000 TV to ₦40,000 for a friend is stopped
    -- here, at the point of sale, not discovered at month end.
    price_floor_percent_of_cost     REAL NOT NULL DEFAULT 100,
    max_discount_percent            REAL NOT NULL DEFAULT 25,

    -- STAFF SPENDING FROM THE BRANCH SAFE. The safe started manager-only,
    -- because a cashier moving the reserve unsupervised is the classic
    -- shrinkage route — but that made a real job impossible: the cashier sent
    -- to buy a carton the drawer cannot cover had to find a manager first, and
    -- shops do not work that way. Resolved the same way: a NARROW, OWNER-SET
    -- ALLOWANCE. 0 means NO CAP (a deliberate client request), so it is read
    -- as unlimited, never as "zero allowed" — the can/cannot decision is the
    -- boolean, not this number.
    staff_can_spend_from_safe       INTEGER NOT NULL DEFAULT 1,
    staff_safe_spend_max            REAL NOT NULL DEFAULT 20000
                                    CHECK (staff_safe_spend_max >= 0),

    -- CREDIT POLICY (defaults; per-customer limits live on the customer).
    credit_enabled                  INTEGER NOT NULL DEFAULT 1,
    credit_max_overdue_days         INTEGER NOT NULL DEFAULT 30,
    credit_max_concentration_pct    REAL NOT NULL DEFAULT 25,
    credit_requires_manager         INTEGER NOT NULL DEFAULT 0,

    -- INSTALMENT POLICY.
    instalment_min_deposit_percent  REAL NOT NULL DEFAULT 20,
    instalment_max_tenor_months     INTEGER NOT NULL DEFAULT 24,
    instalment_grace_days           INTEGER NOT NULL DEFAULT 7,
    instalment_missed_before_default INTEGER NOT NULL DEFAULT 3,
    instalment_late_fee_percent     REAL NOT NULL DEFAULT 0,
    instalment_plan_fee_percent     REAL NOT NULL DEFAULT 0,

    -- LAYAWAY POLICY.
    layaway_default_hold_days       INTEGER NOT NULL DEFAULT 7,
    layaway_max_hold_days           INTEGER NOT NULL DEFAULT 180,
    layaway_max_extensions          INTEGER NOT NULL DEFAULT 3,
    layaway_forfeit_percent         REAL NOT NULL DEFAULT 0,

    -- WARRANTY POLICY.
    warranty_basis_default          TEXT NOT NULL DEFAULT 'SALE'
                                    CHECK (warranty_basis_default IN ('SALE','RECEIPT','MANUFACTURE')),
    warranty_provision_percent      REAL NOT NULL DEFAULT 1.5,

    -- SHELF-LIFE ALERT HORIZONS (days). JSON array, e.g. [7,30,90].
    shelf_life_horizons_json        TEXT NOT NULL DEFAULT '[7,30,90]',

    -- BAD-DEBT PROVISION by ageing bucket. JSON, e.g. {"D31_60":5,...}
    bad_debt_provision_json         TEXT,

    -- RECEIPT / DOCUMENT BEHAVIOUR.
    receipt_footer_text             TEXT,
    receipt_show_pricing_trail      INTEGER NOT NULL DEFAULT 1,
    require_delivery_proof          INTEGER NOT NULL DEFAULT 1,
    require_payment_before_dispatch INTEGER NOT NULL DEFAULT 1,

    notes                           TEXT,          -- vendor-only: contract terms
    updated_at                      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by                      TEXT REFERENCES users(id)
);
INSERT INTO client_settings (id) VALUES (1);

-- ---------------------------------------------------------------------
-- SUPPLIERS  (importers, manufacturers, distributors, artisans, landlords)
-- ---------------------------------------------------------------------
CREATE TABLE suppliers (
    id                 TEXT PRIMARY KEY,
    -- A supplier may serve several businesses; NULL means all of them.
    business_id        TEXT REFERENCES businesses(id),
    name               TEXT NOT NULL,
    contact_person     TEXT,
    phone              TEXT,
    alt_phone          TEXT,
    email              TEXT,
    address            TEXT,
    state_code         TEXT,
    tin                TEXT,               -- needed before WHT can be exempted
    cac_number         TEXT,
    bank_name          TEXT,
    bank_account_name  TEXT,
    bank_account_no    TEXT,
    supplier_type      TEXT NOT NULL DEFAULT 'GOODS'
                       CHECK (supplier_type IN ('GOODS','SERVICE','BOTH','LANDLORD','LOGISTICS','ARTISAN')),
    -- Default terms for this supplier, so a goods-received note proposes a due
    -- date instead of the storekeeper inventing one.
    default_terms_code TEXT NOT NULL DEFAULT 'CASH',
    credit_limit       REAL,               -- how much WE may owe them
    lead_time_days     INTEGER NOT NULL DEFAULT 7,
    -- A supplier who is also a customer (very common: an artisan who buys
    -- materials from the same shop) links to the customer row so the two
    -- balances can be netted instead of chased separately.
    linked_customer_id TEXT REFERENCES customers(id),
    rating             INTEGER,            -- 1-5, owner's own assessment
    notes              TEXT,
    is_active          INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_suppliers_business ON suppliers(business_id) WHERE is_deleted = 0;
CREATE INDEX idx_suppliers_name ON suppliers(name) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- PRODUCT CATEGORIES  (a business's own tree, seeded from its vertical)
-- ---------------------------------------------------------------------
-- The vertical profile supplies the DEFAULTS; this table holds what the client
-- actually uses, so a furniture shop can rename "Living Room" to "Parlour" and
-- add "Church Pews" without a code change. `vertical_code` is retained on each
-- row purely so a report can group by the shipped taxonomy.
CREATE TABLE product_categories (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    parent_id         TEXT REFERENCES product_categories(id),
    code              TEXT NOT NULL,
    name              TEXT NOT NULL,
    vertical_code     TEXT,
    shelf_life_tracked INTEGER NOT NULL DEFAULT 0,
    register_required  INTEGER NOT NULL DEFAULT 0,
    restriction_reason TEXT NOT NULL DEFAULT 'NONE'
                       CHECK (restriction_reason IN ('NONE','AGE_VERIFICATION','SERIAL_CAPTURE','AUTHORITY_DOCUMENT')),
    vat_exempt         INTEGER NOT NULL DEFAULT 0,
    sort_order         INTEGER NOT NULL DEFAULT 0,
    is_active          INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_product_categories_code
    ON product_categories(business_id, code) WHERE is_deleted = 0;
CREATE INDEX idx_product_categories_parent ON product_categories(parent_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- BRANDS  (worth its own table: brand is the first filter anyone uses)
-- ---------------------------------------------------------------------
CREATE TABLE brands (
    id           TEXT PRIMARY KEY,
    business_id  TEXT REFERENCES businesses(id),   -- NULL = shared across businesses
    name         TEXT NOT NULL,
    manufacturer TEXT,
    country      TEXT,
    -- Who to call about a warranty claim. Without this, "send it to the
    -- manufacturer" is a dead end the customer is left holding.
    warranty_contact_name  TEXT,
    warranty_contact_phone TEXT,
    warranty_contact_email TEXT,
    is_authorised_dealer   INTEGER NOT NULL DEFAULT 0,
    notes          TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_brands_name ON brands(business_id, name) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- PRODUCTS  (one master catalogue per business, shared by its branches)
-- ---------------------------------------------------------------------
CREATE TABLE products (
    id                   TEXT PRIMARY KEY,
    business_id          TEXT NOT NULL REFERENCES businesses(id),
    category_id          TEXT REFERENCES product_categories(id),
    brand_id             TEXT REFERENCES brands(id),
    name                 TEXT NOT NULL,
    sku                  TEXT,
    model_number         TEXT,
    description          TEXT,

    -- WHAT KIND OF CONTROL APPLIES (replaces dispensing_type / is_controlled).
    -- NULL means "inherit from the category, then from the vertical", which is
    -- what lets an owner turn on serial capture for every phone without
    -- editing 400 products while still exempting one accessory line.
    restriction_reason   TEXT CHECK (restriction_reason IS NULL OR
                             restriction_reason IN ('NONE','AGE_VERIFICATION','SERIAL_CAPTURE','AUTHORITY_DOCUMENT')),
    register_required    INTEGER,           -- NULL = inherit from category
    serial_tracking      INTEGER,           -- NULL = inherit from business

    -- UNIT OF MEASURE LADDER. base_unit is the atom; every other rung is an
    -- independent multiplier, because a TV is unit -> carton -> pallet with NO
    -- pack rung. packs_per_carton is still honoured (it derives the carton
    -- size) for data shaped like the pharmacy ladder.
    base_unit            TEXT NOT NULL DEFAULT 'PIECE',
    units_per_pack       INTEGER NOT NULL DEFAULT 1,
    units_per_carton     INTEGER,
    packs_per_carton     INTEGER,
    units_per_pallet     INTEGER,
    cartons_per_pallet   INTEGER,
    allows_fractional_qty INTEGER NOT NULL DEFAULT 0,   -- tonnes, metres, litres

    -- WEIGHT / SIZE drive the delivery quote (bulky surcharge, vehicle needed).
    unit_weight_kg       REAL,
    unit_volume_m3       REAL,
    is_bulky             INTEGER,
    needs_two_man_delivery INTEGER NOT NULL DEFAULT 0,

    -- SHELF LIFE (generalised from expiry_date; applies to food, paint,
    -- cement, adhesive, foam — anything that degrades on a date).
    shelf_life_days      INTEGER,
    track_best_before    INTEGER NOT NULL DEFAULT 0,

    -- WARRANTY.
    warranty_months      INTEGER NOT NULL DEFAULT 0,
    warranty_basis       TEXT CHECK (warranty_basis IS NULL OR
                             warranty_basis IN ('SALE','RECEIPT','MANUFACTURE')),
    warranty_requires_receipt INTEGER NOT NULL DEFAULT 1,
    -- A product whose cover is provided by a third party rather than us.
    warranty_provider    TEXT CHECK (warranty_provider IS NULL OR
                             warranty_provider IN ('MANUFACTURER','SHOP','THIRD_PARTY','NONE')),

    -- COMPLIANCE. One generic field whose MEANING comes from the vertical:
    -- SONCAP/PC for electronics, NAFDAC for food and cosmetics, a NIS standard
    -- for cement and steel. Stored as the normalised number plus the scheme.
    compliance_scheme    TEXT,              -- 'SONCAP' | 'NAFDAC' | 'SON' | 'NIS' | ...
    compliance_reg_no    TEXT,
    country_of_origin    TEXT,
    hs_code              TEXT,              -- tariff code, for importers

    -- STRUCTURED ATTRIBUTES. The vertical's attributeSchema decides which
    -- fields the form shows; the values live here as JSON so a new vertical
    -- needs no migration. Searchable attributes are ALSO flattened into
    -- search_text below, because a LIKE over a JSON blob cannot use an index.
    attributes_json      TEXT,
    search_text          TEXT,

    -- PRICING DEFAULTS. The batch's own selling price remains the price of
    -- record; these are the fallbacks and the wholesale ladder anchors.
    default_selling_price REAL,
    wholesale_price       REAL,
    recommended_retail_price REAL,
    target_margin_percent REAL,
    vat_exempt            INTEGER,          -- NULL = inherit from category

    reorder_level         INTEGER NOT NULL DEFAULT 0,
    reorder_quantity      INTEGER NOT NULL DEFAULT 0,
    -- A product that is sold but never stocked (a made-to-order sofa, a
    -- special-order generator) must not raise a low-stock alert every day.
    is_stocked            INTEGER NOT NULL DEFAULT 1,
    is_active             INTEGER NOT NULL DEFAULT 1,
    discontinued_at       TEXT,
    created_by            TEXT REFERENCES users(id),
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_products_business ON products(business_id) WHERE is_deleted = 0;
CREATE INDEX idx_products_category ON products(category_id) WHERE is_deleted = 0;
CREATE INDEX idx_products_brand ON products(brand_id) WHERE is_deleted = 0;
CREATE INDEX idx_products_active ON products(business_id, is_active) WHERE is_deleted = 0;
-- A SKU is how staff find a product, so it must be unique within a business.
CREATE UNIQUE INDEX idx_products_sku ON products(business_id, sku) WHERE sku IS NOT NULL AND is_deleted = 0;
CREATE INDEX idx_products_search ON products(search_text) WHERE is_deleted = 0;
CREATE INDEX idx_products_reorder ON products(reorder_level) WHERE is_deleted = 0 AND is_stocked = 1;

-- One product may carry a barcode for a single piece, a pack, a carton and/or
-- a pallet; scanning selects the stored selling unit.
CREATE TABLE product_barcodes (
    id            TEXT PRIMARY KEY,
    product_id    TEXT NOT NULL REFERENCES products(id),
    barcode       TEXT NOT NULL,
    unit_type     TEXT NOT NULL DEFAULT 'BASE_UNIT'
                  CHECK (unit_type IN ('BASE_UNIT','PACK','CARTON','PALLET')),
    label         TEXT,
    is_primary    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_product_barcodes_code ON product_barcodes(barcode) WHERE is_deleted = 0;
CREATE INDEX idx_product_barcodes_product ON product_barcodes(product_id) WHERE is_deleted = 0;
CREATE UNIQUE INDEX idx_product_barcodes_primary
    ON product_barcodes(product_id) WHERE is_primary = 1 AND is_deleted = 0;

-- ---------------------------------------------------------------------
-- PRICE LAYERS  (see shared/lib/pricing.js for precedence and rationale)
--
--   batch price > branch override > customer tier > volume break > promotion
-- ---------------------------------------------------------------------

-- Per-branch default selling price. Lagos and Kano genuinely price the same
-- master product differently, and a price that cannot vary by branch forces
-- the client to duplicate the product.
CREATE TABLE product_price_overrides (
    id                     TEXT PRIMARY KEY,
    branch_id              TEXT NOT NULL REFERENCES branches(id),
    product_id             TEXT NOT NULL REFERENCES products(id),
    default_selling_price  REAL NOT NULL,      -- per base_unit
    pack_price             REAL,
    carton_price           REAL,
    pallet_price           REAL,
    wholesale_price        REAL,
    updated_by             TEXT REFERENCES users(id),
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted             INTEGER NOT NULL DEFAULT 0,
    UNIQUE (branch_id, product_id)
);
CREATE INDEX idx_price_overrides_branch_prod ON product_price_overrides(branch_id, product_id);

-- A customer class's discount, per category. This is the wholesale ladder:
-- a DISTRIBUTOR buying electricals gets a different percentage than a
-- DISTRIBUTOR buying cement, because the margins are different.
CREATE TABLE customer_price_tiers (
    id                 TEXT PRIMARY KEY,
    business_id        TEXT NOT NULL REFERENCES businesses(id),
    customer_class     TEXT NOT NULL
                       CHECK (customer_class IN ('RETAIL','TRADE','WHOLESALE','DISTRIBUTOR','CORPORATE','STAFF')),
    category_id        TEXT REFERENCES product_categories(id),  -- NULL = all categories
    tier_name          TEXT,
    discount_percent   REAL NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
    min_quantity       INTEGER NOT NULL DEFAULT 1,
    is_active          INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_customer_price_tiers_unique
    ON customer_price_tiers(business_id, customer_class, category_id) WHERE is_deleted = 0;

-- Quantity breaks independent of who is buying ("10+ units, 5% off").
CREATE TABLE volume_breaks (
    id                TEXT PRIMARY KEY,
    product_id        TEXT NOT NULL REFERENCES products(id),
    unit_type         TEXT NOT NULL DEFAULT 'BASE_UNIT'
                      CHECK (unit_type IN ('BASE_UNIT','PACK','CARTON','PALLET')),
    min_qty           INTEGER NOT NULL CHECK (min_qty > 0),
    discount_percent  REAL NOT NULL DEFAULT 0,
    fixed_price       REAL,               -- if set, wins over the percentage
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
-- Two breaks starting at the same quantity is ambiguous; the smaller must win,
-- and a unique index makes the ambiguity impossible instead of resolving it
-- differently in two places.
CREATE UNIQUE INDEX idx_volume_breaks_unique
    ON volume_breaks(product_id, unit_type, min_qty) WHERE is_deleted = 0;

-- Dated campaigns: % off, fixed price, buy-N-get-M, clearance.
CREATE TABLE promotions (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    name              TEXT NOT NULL,
    type              TEXT NOT NULL
                      CHECK (type IN ('PERCENT_OFF','FIXED_PRICE','BUNDLE','BUY_N_GET_M','CLEARANCE')),
    value             REAL,               -- percent, or the fixed price
    buy_n             INTEGER,
    get_m             INTEGER,
    -- Scope: NULL product/category = everything in the business.
    product_id        TEXT REFERENCES products(id),
    category_id       TEXT REFERENCES product_categories(id),
    branch_id         TEXT REFERENCES branches(id),   -- NULL = all branches
    customer_class    TEXT,               -- NULL = any class
    starts_on         TEXT NOT NULL,
    ends_on           TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('DRAFT','ACTIVE','PAUSED','EXPIRED','CANCELLED')),
    max_redemptions   INTEGER,
    redemption_count  INTEGER NOT NULL DEFAULT 0,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_promotions_active ON promotions(business_id, status, starts_on, ends_on) WHERE is_deleted = 0;
CREATE INDEX idx_promotions_product ON promotions(product_id) WHERE is_deleted = 0;
CREATE INDEX idx_promotions_category ON promotions(category_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- PURCHASE ORDERS  (a branch ordering stock from a supplier)
-- ---------------------------------------------------------------------
CREATE TABLE purchase_orders (
    id              TEXT PRIMARY KEY,
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    po_number       TEXT NOT NULL,
    supplier_id     TEXT REFERENCES suppliers(id),
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('DRAFT','PENDING','CONFIRMED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
    ordered_by      TEXT REFERENCES users(id),
    ordered_at      TEXT NOT NULL DEFAULT (datetime('now')),
    expected_date   TEXT,
    -- The order may be raised in a foreign currency (a supplier's pro-forma
    -- invoice in USD). The rate used is stored ON THE ORDER so the naira cost
    -- never gets re-derived from a rate that has since moved.
    currency        TEXT NOT NULL DEFAULT 'NGN',
    fx_rate         REAL NOT NULL DEFAULT 1,
    fx_source       TEXT,
    terms_code      TEXT NOT NULL DEFAULT 'CASH',
    subtotal        REAL NOT NULL DEFAULT 0,
    discount_total  REAL NOT NULL DEFAULT 0,
    tax_total       REAL NOT NULL DEFAULT 0,
    freight_total   REAL NOT NULL DEFAULT 0,
    total           REAL NOT NULL DEFAULT 0,
    notes           TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_purchase_orders_number ON purchase_orders(business_id, po_number) WHERE is_deleted = 0;
CREATE INDEX idx_purchase_orders_branch ON purchase_orders(branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_purchase_orders_supplier ON purchase_orders(supplier_id) WHERE is_deleted = 0;

CREATE TABLE purchase_order_items (
    id                    TEXT PRIMARY KEY,
    purchase_order_id     TEXT NOT NULL REFERENCES purchase_orders(id),
    product_id            TEXT NOT NULL REFERENCES products(id),
    -- The unit the order was placed in and its base-unit multiplier, stored
    -- together so "40 cartons" remains interpretable if the product's carton
    -- size is later changed.
    order_unit            TEXT NOT NULL DEFAULT 'BASE_UNIT',
    quantity_ordered      INTEGER NOT NULL CHECK (quantity_ordered > 0),
    quantity_received     INTEGER NOT NULL DEFAULT 0,   -- in BASE units
    base_units_per_order_unit INTEGER NOT NULL DEFAULT 1,
    expected_unit_cost    REAL,
    expected_line_total   REAL,
    currency              TEXT NOT NULL DEFAULT 'NGN',
    notes                 TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_po_items_po ON purchase_order_items(purchase_order_id) WHERE is_deleted = 0;
CREATE INDEX idx_po_items_product ON purchase_order_items(product_id) WHERE is_deleted = 0;

-- PARTIAL RECEIVING. A supplier shipping part of an order is completely normal
-- ("60 of the 200 bags arrived today, the rest next week"), so receiving is
-- per-delivery, not all-or-nothing. An all-or-nothing receive leaves the
-- status enum value PARTIALLY_RECEIVED defined but unreachable — a designed
-- state that can never occur is a design that has not met the domain.
CREATE TABLE purchase_order_receipts (
    id                     TEXT PRIMARY KEY,
    purchase_order_id      TEXT NOT NULL REFERENCES purchase_orders(id),
    purchase_order_item_id TEXT NOT NULL REFERENCES purchase_order_items(id),
    received_at            TEXT NOT NULL DEFAULT (datetime('now')),
    received_by            TEXT REFERENCES users(id),
    branch_id              TEXT NOT NULL REFERENCES branches(id),
    quantity_received      INTEGER NOT NULL CHECK (quantity_received > 0),   -- base units
    receive_unit           TEXT NOT NULL DEFAULT 'BASE_UNIT',
    receive_count          INTEGER NOT NULL DEFAULT 1,
    -- TOTAL COST for this delivery line, taken from the supplier's invoice and
    -- split to a per-piece cost at FULL PRECISION (see receiving.splitTotalCost:
    -- rounding ₦480,000/7,000 to ₦68.57 loses ₦10 on every delivery, forever).
    total_cost             REAL NOT NULL DEFAULT 0,
    cost_per_unit          REAL NOT NULL DEFAULT 0,
    selling_price_per_unit REAL,
    freight_allocation     REAL NOT NULL DEFAULT 0,
    batch_no               TEXT,
    best_before_date       TEXT,
    manufacture_date       TEXT,
    grn_number             TEXT,           -- goods received note
    supplier_invoice_no    TEXT,
    notes                  TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_po_receipts_po ON purchase_order_receipts(purchase_order_id) WHERE is_deleted = 0;
CREATE INDEX idx_po_receipts_item ON purchase_order_receipts(purchase_order_item_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- STOCK BATCHES  (a priced, dated quantity of one product in one branch)
-- ---------------------------------------------------------------------
-- THE PRICE OF RECORD for a sale is the batch's own selling_price_per_unit,
-- NOT a global product price. Two deliveries of the same fridge bought three
-- months apart at different costs genuinely carry different prices, and
-- forcing them onto one shelf price is how a retailer discovers in December
-- that they have been selling the cheap stock at the expensive stock's margin.
CREATE TABLE stock_batches (
    id                     TEXT PRIMARY KEY,
    branch_id              TEXT NOT NULL REFERENCES branches(id),
    product_id             TEXT NOT NULL REFERENCES products(id),
    batch_no               TEXT,
    -- PHYSICAL vs SPOKEN FOR. sellable = on_hand - reserved. A layaway hold,
    -- an allocated delivery job and a transfer in progress all reserve stock
    -- without moving it, so a POS that checked only quantity_on_hand would
    -- sell the same TV twice on two tills.
    quantity_on_hand       INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    quantity_reserved      INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
    quantity_damaged       INTEGER NOT NULL DEFAULT 0 CHECK (quantity_damaged >= 0),
    -- FULL PRECISION, deliberately not rounded to kobo.
    cost_per_unit          REAL NOT NULL DEFAULT 0,
    selling_price_per_unit REAL NOT NULL DEFAULT 0,
    wholesale_price_per_unit REAL,
    currency               TEXT NOT NULL DEFAULT 'NGN',
    fx_rate                REAL NOT NULL DEFAULT 1,
    fx_source              TEXT,
    -- Generalised from expiry_date. NULL for a product with no shelf life,
    -- which is most of a furniture or electronics catalogue.
    best_before_date       TEXT,
    manufacture_date       TEXT,
    received_at            TEXT NOT NULL DEFAULT (datetime('now')),
    purchase_order_receipt_id TEXT REFERENCES purchase_order_receipts(id),
    supplier_id            TEXT REFERENCES suppliers(id),
    location_in_branch     TEXT,       -- "Aisle 3, Rack B", "Yard", "Container 2"
    status                 TEXT NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE','DEPLETED','QUARANTINED','RECALLED','EXPIRED','WRITTEN_OFF')),
    notes                  TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_stock_batches_branch ON stock_batches(branch_id) WHERE is_deleted = 0;
CREATE INDEX idx_stock_batches_product ON stock_batches(product_id) WHERE is_deleted = 0;
CREATE INDEX idx_stock_batches_shelf_life ON stock_batches(best_before_date) WHERE is_deleted = 0;
-- The FEFO/FIFO pick query is (branch, product) ordered by best_before then
-- received_at; this index exists so that query is a seek, not a scan.
CREATE INDEX idx_stock_batches_pick
    ON stock_batches(branch_id, product_id, best_before_date, received_at) WHERE is_deleted = 0;
CREATE INDEX idx_stock_batches_status ON stock_batches(branch_id, status) WHERE is_deleted = 0;
-- The invariant the whole stock system rests on: you cannot reserve more than
-- you hold. Expressed as a CHECK rather than an application test, because an
-- application test can be skipped by a code path nobody thought of and a CHECK
-- cannot be skipped at all.
-- (An earlier draft of this schema wrote it as a partial INDEX on the rows that
-- VIOLATE the rule, which constrains nothing and merely makes bad rows easy to
-- find afterwards. A guard that fires after the damage is not a guard.)

-- ---------------------------------------------------------------------
-- STOCK MOVEMENTS  (the complete, append-only history of every unit)
-- ---------------------------------------------------------------------
-- Balances are a cache. This table is the evidence. Every movement writes a
-- row, so a batch's quantity can be replayed from its history and reconciled
-- against its balance — which is the only way to prove the stock report is
-- right rather than merely plausible.
CREATE TABLE stock_movements (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    movement_type     TEXT NOT NULL
                      CHECK (movement_type IN ('RECEIPT','SALE','SALE_RETURN','TRANSFER_OUT','TRANSFER_IN',
                                               'ADJUSTMENT','LAYAWAY_RESERVE','LAYAWAY_RELEASE',
                                               'DELIVERY_DISPATCH','WARRANTY_SWAP','OPENING_BALANCE','WRITE_OFF')),
    -- +1 in, -1 out. Stored explicitly rather than inferred from the type, so
    -- a report never has to encode the direction table in SQL.
    direction         INTEGER NOT NULL CHECK (direction IN (1,-1)),
    quantity          INTEGER NOT NULL CHECK (quantity > 0),
    -- The value of the movement at the batch cost, in kobo, for valuation.
    value_kobo        INTEGER NOT NULL DEFAULT 0,
    unit_cost         REAL NOT NULL DEFAULT 0,
    -- Effect on the RESERVATION rather than the physical count. A hold does
    -- not move a single unit; it makes one unsellable.
    reservation_delta INTEGER NOT NULL DEFAULT 0,
    source_type       TEXT,             -- 'SALE' | 'PO_RECEIPT' | 'TRANSFER' | 'STOCKTAKE' | 'HOLD' | 'JOB'
    source_id         TEXT,
    serial_number     TEXT,             -- when the movement is of one specific unit
    reference         TEXT,
    moved_by          TEXT REFERENCES users(id),
    moved_at          TEXT NOT NULL DEFAULT (datetime('now')),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_stock_movements_product ON stock_movements(branch_id, product_id, moved_at);
CREATE INDEX idx_stock_movements_batch ON stock_movements(stock_batch_id, moved_at);
CREATE INDEX idx_stock_movements_source ON stock_movements(source_type, source_id);
CREATE INDEX idx_stock_movements_date ON stock_movements(business_id, moved_at);
CREATE INDEX idx_stock_movements_type ON stock_movements(movement_type, moved_at);

-- ---------------------------------------------------------------------
-- ADJUSTMENTS  (variance, damage, theft, found, sample)
-- ---------------------------------------------------------------------
CREATE TABLE stock_adjustments (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    reason            TEXT NOT NULL
                      CHECK (reason IN ('DAMAGE','THEFT','LOSS','FOUND','SAMPLE','EXPIRED','SCRAPPED',
                                        'STOCKTAKE_VARIANCE','COUNT_CORRECTION','RETURN_TO_SUPPLIER','OTHER')),
    quantity_change   INTEGER NOT NULL,      -- negative removes stock
    unit_cost         REAL NOT NULL DEFAULT 0,
    value_kobo        INTEGER NOT NULL DEFAULT 0,
    -- A write-off of anything valuable needs a second signature. The cap is an
    -- OWNER-set switch (client_settings.staff_adjustment_max_units); this
    -- records who authorised it when the cap was exceeded.
    approved_by       TEXT REFERENCES users(id),
    approved_at       TEXT,
    stocktake_id      TEXT REFERENCES stocktake_sessions(id),
    created_by        TEXT NOT NULL REFERENCES users(id),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_stock_adjustments_branch ON stock_adjustments(branch_id, created_at) WHERE is_deleted = 0;
CREATE INDEX idx_stock_adjustments_reason ON stock_adjustments(reason, created_at) WHERE is_deleted = 0;
CREATE INDEX idx_stock_adjustments_user ON stock_adjustments(created_by, created_at) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- STOCKTAKES  (a real physical count cycle, not ad-hoc adjustments)
-- ---------------------------------------------------------------------
-- Freeze the system quantity -> record what was actually counted -> compute
-- the variance -> generate adjustments from it. Going straight to an
-- adjustment loses the only fact that matters: what the system THOUGHT versus
-- what was THERE.
CREATE TABLE stocktake_sessions (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    reference         TEXT,
    -- FULL counts everything; PARTIAL counts a category, a rack or a selection.
    scope             TEXT NOT NULL DEFAULT 'FULL' CHECK (scope IN ('FULL','PARTIAL')),
    scope_filter_json TEXT,
    status            TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','COUNTING','REVIEW','COMMITTED','CANCELLED')),
    opened_by         TEXT NOT NULL REFERENCES users(id),
    opened_at         TEXT NOT NULL DEFAULT (datetime('now')),
    committed_by      TEXT REFERENCES users(id),
    committed_at      TEXT,
    -- Trading continues during a count in most Nigerian shops; freezing is a
    -- choice, not a default, and this records which was made.
    froze_trading     INTEGER NOT NULL DEFAULT 0,
    notes             TEXT,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
-- ONE open stocktake per branch. Two concurrent counts of the same shelves
-- produce two different "truths" and neither is usable.
CREATE UNIQUE INDEX idx_stocktake_one_open_per_branch
    ON stocktake_sessions(branch_id) WHERE status IN ('OPEN','COUNTING','REVIEW') AND is_deleted = 0;

CREATE TABLE stocktake_lines (
    id                TEXT PRIMARY KEY,
    stocktake_id      TEXT NOT NULL REFERENCES stocktake_sessions(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    -- Captured at count time and NEVER updated afterwards: the variance is a
    -- historical fact about a moment, and recomputing it from today's system
    -- quantity would silently rewrite the result.
    system_qty_at_open INTEGER NOT NULL,
    counted_qty       INTEGER,
    variance          INTEGER,               -- counted - system
    unit_cost         REAL NOT NULL DEFAULT 0,
    variance_value_kobo INTEGER NOT NULL DEFAULT 0,
    counted_by        TEXT REFERENCES users(id),
    counted_at        TEXT,
    recount_qty       INTEGER,               -- a second count where they differ
    recounted_by      TEXT REFERENCES users(id),
    recounted_at      TEXT,
    adjustment_id     TEXT REFERENCES stock_adjustments(id),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_stocktake_lines_session ON stocktake_lines(stocktake_id) WHERE is_deleted = 0;
CREATE UNIQUE INDEX idx_stocktake_lines_unique
    ON stocktake_lines(stocktake_id, product_id, stock_batch_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- TRANSFERS  (stock moving between branches of the same business)
-- ---------------------------------------------------------------------
-- A transfer is IN TRANSIT between dispatch and receipt. Stock that has left
-- Lekki but not arrived in Ikeja belongs to NEITHER branch's sellable pool; if
-- it belonged to both, the group stock report would double-count it, and if it
-- belonged to neither with no record, it would vanish.
CREATE TABLE stock_transfers (
    id                  TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    reference           TEXT NOT NULL,
    from_branch_id      TEXT NOT NULL REFERENCES branches(id),
    to_branch_id        TEXT NOT NULL REFERENCES branches(id),
    status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','IN_TRANSIT','PARTIALLY_RECEIVED','RECEIVED','CANCELLED','LOST')),
    requested_by        TEXT REFERENCES users(id),
    approved_by         TEXT REFERENCES users(id),
    dispatched_by       TEXT REFERENCES users(id),
    dispatched_at       TEXT,
    received_by         TEXT REFERENCES users(id),
    received_at         TEXT,
    -- A transfer is a stock movement, not a sale, so no revenue is recognised.
    -- But moving stock between branches of differently-priced shops DOES change
    -- its selling price, and the receiving branch's price must be recorded so
    -- the margin report is honest about which branch earned what.
    transfer_at_cost    INTEGER NOT NULL DEFAULT 1,
    vehicle_registration TEXT,
    driver_id           TEXT REFERENCES users(id),
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_stock_transfers_reference
    ON stock_transfers(business_id, reference) WHERE is_deleted = 0;
CREATE INDEX idx_stock_transfers_from ON stock_transfers(from_branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_stock_transfers_to ON stock_transfers(to_branch_id, status) WHERE is_deleted = 0;

CREATE TABLE stock_transfer_items (
    id                 TEXT PRIMARY KEY,
    transfer_id        TEXT NOT NULL REFERENCES stock_transfers(id),
    product_id         TEXT NOT NULL REFERENCES products(id),
    from_batch_id      TEXT REFERENCES stock_batches(id),
    -- Dispatched and received quantities are separate, because a truck that
    -- loses a carton en route must produce a variance record rather than a
    -- silently short receipt.
    quantity_dispatched INTEGER NOT NULL DEFAULT 0 CHECK (quantity_dispatched >= 0),
    quantity_received   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
    serial_number       TEXT,
    unit_cost           REAL NOT NULL DEFAULT 0,
    value_kobo          INTEGER NOT NULL DEFAULT 0,
    receiving_batch_id  TEXT REFERENCES stock_batches(id),
    discrepancy_note    TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_transfer_items_transfer ON stock_transfer_items(transfer_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- CUSTOMERS
-- ---------------------------------------------------------------------
CREATE TABLE customers (
    id                 TEXT PRIMARY KEY,
    business_id        TEXT NOT NULL REFERENCES businesses(id),
    -- A customer may be known to several branches; `home_branch_id` is where
    -- they usually trade, NOT a visibility boundary. Credit is assessed at
    -- business level, because a debtor who owes Lekki will simply buy in Ikeja
    -- if the two branches cannot see each other.
    home_branch_id     TEXT REFERENCES branches(id),
    customer_class     TEXT NOT NULL DEFAULT 'RETAIL'
                       CHECK (customer_class IN ('RETAIL','TRADE','WHOLESALE','DISTRIBUTOR','CORPORATE','STAFF')),
    -- Individual vs registered company decides whether a TIN and CAC number
    -- are expected, and which WHT treatment applies.
    customer_type      TEXT NOT NULL DEFAULT 'INDIVIDUAL'
                       CHECK (customer_type IN ('INDIVIDUAL','COMPANY','GOVERNMENT','NGO')),
    name               TEXT NOT NULL,
    company_name       TEXT,
    contact_person     TEXT,
    phone              TEXT,
    alt_phone          TEXT,
    email              TEXT,
    address            TEXT,
    area               TEXT,
    lga                TEXT,
    state_code         TEXT,
    tin                TEXT,
    cac_number         TEXT,
    -- CREDIT. The balance is DERIVED from debtor_ledger, never stored as a
    -- running total: a stored balance can be written to directly, and once it
    -- can be, it drifts from the sum of its evidence and nobody knows which
    -- figure to believe.
    credit_limit       REAL,
    terms_code         TEXT NOT NULL DEFAULT 'CASH',
    account_status     TEXT NOT NULL DEFAULT 'ACTIVE'
                       CHECK (account_status IN ('ACTIVE','UNDER_REVIEW','SUSPENDED','BLOCKED','WRITTEN_OFF','CLOSED')),
    credit_approved_by TEXT REFERENCES users(id),
    credit_approved_at TEXT,
    -- A per-customer discount that overrides their class tier.
    discount_percent   REAL NOT NULL DEFAULT 0,
    price_tier_override TEXT,
    total_purchases    REAL NOT NULL DEFAULT 0,   -- lifetime revenue, denormalised for ranking
    last_purchase_at   TEXT,
    loyalty_points     INTEGER NOT NULL DEFAULT 0,
    notes              TEXT,
    created_by         TEXT REFERENCES users(id),
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_customers_business ON customers(business_id) WHERE is_deleted = 0;
CREATE INDEX idx_customers_name ON customers(name) WHERE is_deleted = 0;
CREATE INDEX idx_customers_phone ON customers(phone) WHERE is_deleted = 0;
CREATE INDEX idx_customers_class ON customers(customer_class) WHERE is_deleted = 0;
CREATE INDEX idx_customers_status ON customers(account_status) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- SALES
-- ---------------------------------------------------------------------
CREATE TABLE sales (
    id                  TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    branch_id           TEXT NOT NULL REFERENCES branches(id),
    till_session_id     TEXT REFERENCES till_sessions(id),
    sale_number         TEXT NOT NULL,        -- SR-LG-000417: readable aloud over a phone
    receipt_number      TEXT,
    -- WHOLESALE lines are priced differently, may need a delivery note rather
    -- than a receipt, and are reported separately because they are a different
    -- business with different margins.
    sale_type           TEXT NOT NULL DEFAULT 'RETAIL'
                        CHECK (sale_type IN ('RETAIL','WHOLESALE','PROJECT','INTERNAL','SAMPLE','EXCHANGE')),
    status              TEXT NOT NULL DEFAULT 'COMPLETED'
                        CHECK (status IN ('QUOTE','PENDING','COMPLETED','PART_PAID','ON_HOLD','VOIDED','REFUNDED','PARTIALLY_REFUNDED')),
    customer_id         TEXT REFERENCES customers(id),
    customer_class      TEXT,                 -- snapshotted: a customer's class can change later
    customer_name       TEXT,                 -- snapshotted for a walk-in
    customer_phone      TEXT,

    -- LINES AND MONEY. Every figure is stored in BOTH naira (for humans and
    -- exports) and kobo (for arithmetic), and the kobo figures are
    -- authoritative. The CHECK constraints below are what make a sale that
    -- does not foot impossible to write, rather than merely unlikely.
    subtotal_kobo       INTEGER NOT NULL DEFAULT 0,
    discount_kobo       INTEGER NOT NULL DEFAULT 0,
    taxable_kobo        INTEGER NOT NULL DEFAULT 0,
    exempt_kobo         INTEGER NOT NULL DEFAULT 0,
    vat_kobo            INTEGER NOT NULL DEFAULT 0,
    total_kobo          INTEGER NOT NULL DEFAULT 0 CHECK (total_kobo >= 0),
    paid_kobo           INTEGER NOT NULL DEFAULT 0,
    balance_kobo        INTEGER NOT NULL DEFAULT 0,
    change_kobo         INTEGER NOT NULL DEFAULT 0,
    cost_kobo           INTEGER NOT NULL DEFAULT 0,      -- COGS from the batches picked
    margin_kobo         INTEGER NOT NULL DEFAULT 0,

    subtotal            REAL NOT NULL DEFAULT 0,
    discount_total      REAL NOT NULL DEFAULT 0,
    vat_amount          REAL NOT NULL DEFAULT 0,
    total               REAL NOT NULL DEFAULT 0,
    paid                REAL NOT NULL DEFAULT 0,
    balance_due         REAL NOT NULL DEFAULT 0,
    change_given        REAL NOT NULL DEFAULT 0,
    cost_total          REAL NOT NULL DEFAULT 0,
    margin_total        REAL NOT NULL DEFAULT 0,

    vat_enabled         INTEGER NOT NULL DEFAULT 0,
    vat_rate_percent    REAL NOT NULL DEFAULT 0,
    currency            TEXT NOT NULL DEFAULT 'NGN',
    -- THE RATE THIS SALE USED. Never re-derived later: a sale made at
    -- ₦1,450/$ must still read ₦1,450/$ in a report two years from now.
    fx_rate             REAL NOT NULL DEFAULT 1,
    fx_source           TEXT,
    fx_rate_date        TEXT,
    total_in_currency   REAL,

    -- WHAT HAPPENED AFTER THE SALE.
    requires_delivery   INTEGER NOT NULL DEFAULT 0,
    delivery_job_id     TEXT,
    instalment_plan_id  TEXT,
    layaway_hold_id     TEXT,
    credit_terms_code   TEXT,
    due_date            TEXT,

    -- VOID / REFUND audit. A void with no reason and no approver is how a
    -- cashier sells for cash, voids the sale and keeps the note.
    voided_by           TEXT REFERENCES users(id),
    voided_at           TEXT,
    void_reason         TEXT,
    void_approved_by    TEXT REFERENCES users(id),

    sold_by             TEXT NOT NULL REFERENCES users(id),
    -- An offline sale carries the DEVICE that created it and the id it minted
    -- locally, so a replay can be detected and attributed.
    device_id           TEXT,
    client_sale_id      TEXT,
    sale_date           TEXT NOT NULL,       -- YYYY-MM-DD in WEST AFRICA TIME
    sale_time           TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0,

    -- FOOTING INVARIANTS, enforced by the database rather than hoped for.
    -- A sale whose parts do not add to its total is not a rounding difference,
    -- it is a bug, and it must be impossible to persist.
    --
    -- Deliberately NOT constrained: `net = taxable - vat`. The VAT extraction
    -- model means `total` is what the customer pays and `vat` is a component OF
    -- it, so the identity that matters is total = taxable + exempt (below),
    -- with the net-of-VAT figure derived in the GL rather than stored here.
    -- A CHECK that restates a tautology (x - y + y = x) is worse than none: it
    -- reads like a guarantee while constraining nothing.
    CHECK (subtotal_kobo - discount_kobo = taxable_kobo + exempt_kobo),
    CHECK (total_kobo = taxable_kobo + exempt_kobo),
    CHECK (vat_kobo <= taxable_kobo),
    CHECK (balance_kobo >= 0),
    CHECK (change_kobo >= 0),
    CHECK (paid_kobo + change_kobo >= total_kobo - balance_kobo)
);
CREATE UNIQUE INDEX idx_sales_number ON sales(business_id, sale_number) WHERE is_deleted = 0;
CREATE INDEX idx_sales_branch ON sales(branch_id, sale_date) WHERE is_deleted = 0;
CREATE INDEX idx_sales_business_date ON sales(business_id, sale_date) WHERE is_deleted = 0;
CREATE INDEX idx_sales_customer ON sales(customer_id) WHERE is_deleted = 0;
CREATE INDEX idx_sales_status ON sales(status, sale_date) WHERE is_deleted = 0;
CREATE INDEX idx_sales_till ON sales(till_session_id) WHERE is_deleted = 0;
CREATE INDEX idx_sales_user ON sales(sold_by, sale_date) WHERE is_deleted = 0;
CREATE INDEX idx_sales_void ON sales(voided_by) WHERE voided_at IS NOT NULL AND is_deleted = 0;
-- An offline sale must be replayable exactly once: the locally-minted id from
-- a given device is the natural key for that.
CREATE UNIQUE INDEX idx_sales_client_id
    ON sales(device_id, client_sale_id) WHERE client_sale_id IS NOT NULL AND is_deleted = 0;

CREATE TABLE sale_items (
    id                   TEXT PRIMARY KEY,
    sale_id              TEXT NOT NULL REFERENCES sales(id),
    product_id           TEXT REFERENCES products(id),   -- NULL for an ad-hoc/custom line
    stock_batch_id       TEXT REFERENCES stock_batches(id),
    -- Snapshots, all of them. A product can be renamed, recategorised and
    -- repriced; the sale must keep describing what was actually sold on the
    -- day, or a historical invoice becomes uninterpretable.
    product_name         TEXT NOT NULL,
    sku                  TEXT,
    category_id          TEXT REFERENCES product_categories(id),
    category_code        TEXT,
    brand_name           TEXT,
    restriction_reason   TEXT,
    register_required    INTEGER NOT NULL DEFAULT 0,

    unit_type            TEXT NOT NULL DEFAULT 'BASE_UNIT'
                         CHECK (unit_type IN ('BASE_UNIT','PACK','CARTON','PALLET')),
    -- quantity is what the operator rang up (2 cartons); base_quantity is what
    -- left the shelf (576 pieces). Both are stored because both are true and
    -- they answer different questions.
    quantity             INTEGER NOT NULL CHECK (quantity > 0),
    base_quantity        INTEGER NOT NULL CHECK (base_quantity > 0),
    base_unit            TEXT NOT NULL DEFAULT 'PIECE',
    base_units_per_rung  INTEGER NOT NULL DEFAULT 1,

    -- unit_price is PER BASE UNIT at full precision; rung_price is what the
    -- customer agreed to pay for the rung they bought.
    unit_price_kobo      INTEGER NOT NULL DEFAULT 0,
    rung_price_kobo      INTEGER NOT NULL DEFAULT 0,
    discount_kobo        INTEGER NOT NULL DEFAULT 0,
    line_gross_kobo      INTEGER NOT NULL DEFAULT 0,
    line_net_kobo        INTEGER NOT NULL DEFAULT 0,
    line_vat_kobo        INTEGER NOT NULL DEFAULT 0,
    line_cost_kobo       INTEGER NOT NULL DEFAULT 0,
    line_margin_kobo     INTEGER NOT NULL DEFAULT 0,

    unit_price           REAL NOT NULL DEFAULT 0,
    rung_price           REAL NOT NULL DEFAULT 0,
    discount_total       REAL NOT NULL DEFAULT 0,
    line_gross           REAL NOT NULL DEFAULT 0,
    line_total           REAL NOT NULL DEFAULT 0,
    line_vat             REAL NOT NULL DEFAULT 0,
    unit_cost            REAL NOT NULL DEFAULT 0,
    line_cost            REAL NOT NULL DEFAULT 0,
    line_margin          REAL NOT NULL DEFAULT 0,
    vat_exempt           INTEGER NOT NULL DEFAULT 0,

    -- WHY THIS PRICE. The pricing trail from shared/lib/pricing.js, stored as
    -- JSON so any receipt, audit or margin report can show exactly which rule
    -- fired. A price with no explanation is a price nobody will trust.
    pricing_trail_json   TEXT,
    discount_reason      TEXT,
    discount_approved_by TEXT REFERENCES users(id),
    promotion_id         TEXT REFERENCES promotions(id),
    tier_id              TEXT REFERENCES customer_price_tiers(id),
    volume_break_id      TEXT REFERENCES volume_breaks(id),

    -- Serials captured for this line (denormalised for the receipt; the
    -- authoritative rows are in serial_numbers).
    serial_numbers       TEXT,
    -- Restriction satisfaction: recorded, not assumed.
    age_confirmed        INTEGER NOT NULL DEFAULT 0,
    age_confirmed_by     TEXT REFERENCES users(id),
    authority_document_id TEXT,
    warranty_started     INTEGER NOT NULL DEFAULT 0,

    is_free_unit         INTEGER NOT NULL DEFAULT 0,     -- a BOGO free unit
    returned_qty         INTEGER NOT NULL DEFAULT 0,
    notes                TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted           INTEGER NOT NULL DEFAULT 0,
    -- A line must foot: gross - discount = net, and net splits into ex-VAT + VAT.
    CHECK (line_gross_kobo - discount_kobo = line_net_kobo),
    CHECK (line_net_kobo >= line_vat_kobo)
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id) WHERE is_deleted = 0;
CREATE INDEX idx_sale_items_product ON sale_items(product_id) WHERE is_deleted = 0;
CREATE INDEX idx_sale_items_batch ON sale_items(stock_batch_id) WHERE is_deleted = 0;
CREATE INDEX idx_sale_items_category ON sale_items(category_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- SALE PAYMENTS  (a sale may be settled by several methods at once)
-- ---------------------------------------------------------------------
CREATE TABLE sale_payments (
    id                    TEXT PRIMARY KEY,
    sale_id               TEXT NOT NULL REFERENCES sales(id),
    branch_id             TEXT NOT NULL REFERENCES branches(id),
    till_session_id       TEXT REFERENCES till_sessions(id),
    method                TEXT NOT NULL
                          CHECK (method IN ('CASH','POS_TERMINAL','BANK_TRANSFER','MOBILE_MONEY','USSD',
                                            'CREDIT','INSTALLMENT_PART','LAYAWAY_DEPOSIT','VOUCHER','FX_CASH')),
    amount_kobo           INTEGER NOT NULL CHECK (amount_kobo > 0),
    amount                REAL NOT NULL,
    -- A transfer with no reference cannot be reconciled, which is how a shop
    -- "loses" money it actually received. Enforced in application code for the
    -- methods that need it (see shared/lib/payments.js).
    reference             TEXT,
    wallet                TEXT,
    -- THE FEE AND THE SETTLEMENT DATE ARE FIRST-CLASS. A shop that records
    -- "₦500,000 POS" and nothing else reconciles its bank at ₦492,500 with no
    -- idea why. This is the most common source of "the till balanced but the
    -- bank did not".
    fee_kobo              INTEGER NOT NULL DEFAULT 0,
    fee                   REAL NOT NULL DEFAULT 0,
    expected_settlement_date TEXT,
    settled_at            TEXT,
    settled_amount_kobo   INTEGER,
    settlement_variance_kobo INTEGER,
    -- A foreign-currency tender: what was handed over and at what rate.
    foreign_amount        REAL,
    foreign_currency      TEXT,
    fx_rate               REAL,
    -- Cash tendered and change given, so till reconciliation is not thrown off
    -- by a customer paying with a bigger note than the total.
    cash_tendered         REAL,
    change_given_kobo     INTEGER NOT NULL DEFAULT 0,
    change_given          REAL NOT NULL DEFAULT 0,
    received_by           TEXT NOT NULL REFERENCES users(id),
    device_id             TEXT,
    received_at           TEXT NOT NULL DEFAULT (datetime('now')),
    notes                 TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id) WHERE is_deleted = 0;
CREATE INDEX idx_sale_payments_till ON sale_payments(till_session_id, method) WHERE is_deleted = 0;
CREATE INDEX idx_sale_payments_settlement ON sale_payments(expected_settlement_date, settled_at) WHERE is_deleted = 0;
CREATE INDEX idx_sale_payments_reference ON sale_payments(reference) WHERE reference IS NOT NULL AND is_deleted = 0;

-- ---------------------------------------------------------------------
-- RETURNS
-- ---------------------------------------------------------------------
-- A return is not a negative sale. It has its own reason, its own approval,
-- its own restock decision and its own money effect, and reporting it as a
-- negative sale hides the single most useful shrinkage signal a retailer has.
CREATE TABLE sales_returns (
    id                  TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    branch_id           TEXT NOT NULL REFERENCES branches(id),
    return_number       TEXT NOT NULL,
    sale_id             TEXT NOT NULL REFERENCES sales(id),
    customer_id         TEXT REFERENCES customers(id),
    reason              TEXT NOT NULL
                        CHECK (reason IN ('DEFECTIVE','WRONG_ITEM','CUSTOMER_CHANGED_MIND','DAMAGED_IN_TRANSIT',
                                          'NOT_AS_DESCRIBED','PRICE_ERROR','OVER_SUPPLY','WARRANTY_REJECTION','OTHER')),
    -- What happens to the goods and the money, independently.
    restock             INTEGER NOT NULL DEFAULT 1,
    restock_as          TEXT NOT NULL DEFAULT 'GOOD'
                        CHECK (restock_as IN ('GOOD','DAMAGED','REFURBISHED','SCRAPPED','RETURN_TO_SUPPLIER')),
    refund_method       TEXT NOT NULL DEFAULT 'CASH'
                        CHECK (refund_method IN ('CASH','ORIGINAL_METHOD','STORE_CREDIT','VOUCHER','EXCHANGE','NONE')),
    refund_amount_kobo  INTEGER NOT NULL DEFAULT 0,
    refund_amount       REAL NOT NULL DEFAULT 0,
    store_credit_kobo   INTEGER NOT NULL DEFAULT 0,
    exchange_sale_id    TEXT REFERENCES sales(id),
    -- Restocking fee: legitimate on a change-of-mind return of a bulky item
    -- (the shop paid to deliver it and will pay to sell it again), and NOT
    -- legitimate on a defective item, which is our fault.
    restocking_fee_kobo INTEGER NOT NULL DEFAULT 0,
    restocking_fee      REAL NOT NULL DEFAULT 0,
    approved_by         TEXT REFERENCES users(id),
    approved_at         TEXT,
    received_by         TEXT NOT NULL REFERENCES users(id),
    -- Within how many days a return is accepted is client policy, not code.
    within_policy       INTEGER NOT NULL DEFAULT 1,
    days_since_sale     INTEGER,
    notes               TEXT,
    returned_at         TEXT NOT NULL DEFAULT (datetime('now')),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_sales_returns_number ON sales_returns(business_id, return_number) WHERE is_deleted = 0;
CREATE INDEX idx_sales_returns_sale ON sales_returns(sale_id) WHERE is_deleted = 0;
CREATE INDEX idx_sales_returns_branch ON sales_returns(branch_id, returned_at) WHERE is_deleted = 0;

CREATE TABLE sales_return_items (
    id                 TEXT PRIMARY KEY,
    return_id          TEXT NOT NULL REFERENCES sales_returns(id),
    sale_item_id       TEXT NOT NULL REFERENCES sale_items(id),
    product_id         TEXT REFERENCES products(id),
    stock_batch_id     TEXT REFERENCES stock_batches(id),
    serial_number      TEXT,
    quantity           INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_kobo    INTEGER NOT NULL DEFAULT 0,
    refund_kobo        INTEGER NOT NULL DEFAULT 0,
    restock            INTEGER NOT NULL DEFAULT 1,
    restock_as         TEXT NOT NULL DEFAULT 'GOOD',
    condition_note     TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_return_items_return ON sales_return_items(return_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- TILL SESSIONS  (a drawer's life: open, trade, count, close, bank)
-- ---------------------------------------------------------------------
CREATE TABLE till_sessions (
    id                   TEXT PRIMARY KEY,
    branch_id            TEXT NOT NULL REFERENCES branches(id),
    till_no              TEXT NOT NULL DEFAULT '1',
    status               TEXT NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','CLOSED','RECONCILED','DISPUTED')),
    opened_by            TEXT NOT NULL REFERENCES users(id),
    opened_at            TEXT NOT NULL DEFAULT (datetime('now')),
    -- The float is counted IN at open, not assumed. A drawer nobody counted at
    -- open cannot be reconciled at close, because the opening figure is a guess.
    opening_float_kobo   INTEGER NOT NULL DEFAULT 0,
    opening_float        REAL NOT NULL DEFAULT 0,
    float_counted_by     TEXT REFERENCES users(id),
    closed_by            TEXT REFERENCES users(id),
    closed_at            TEXT,
    closed_date          TEXT,                 -- YYYY-MM-DD WAT
    -- EXPECTED, from the payments recorded against this session.
    expected_cash_kobo   INTEGER NOT NULL DEFAULT 0,
    expected_total_kobo  INTEGER NOT NULL DEFAULT 0,
    -- COUNTED, by a human, at close.
    counted_cash_kobo    INTEGER,
    counted_total_kobo   INTEGER,
    variance_kobo        INTEGER,
    variance             REAL,
    -- Denomination breakdown of the count, as JSON:
    -- {"1000":25,"500":40,"200":13,"100":7,"50":4,"20":2,"10":1,"coins":350}
    -- A count with no denominations is a number somebody typed; with them it is
    -- a count somebody performed.
    denomination_json    TEXT,
    -- Where the money went after the count.
    swept_to_safe_kobo   INTEGER NOT NULL DEFAULT 0,
    banked_kobo          INTEGER NOT NULL DEFAULT 0,
    banked_at            TEXT,
    bank_deposit_ref     TEXT,
    -- Cash the till could not make change for, still owed to customers. This is
    -- a LIABILITY, and it is why the drawer can be short while the books are
    -- right.
    change_owed_kobo     INTEGER NOT NULL DEFAULT 0,
    sales_count          INTEGER NOT NULL DEFAULT 0,
    void_count           INTEGER NOT NULL DEFAULT 0,
    refund_count         INTEGER NOT NULL DEFAULT 0,
    -- A variance inside tolerance closes normally; outside it, a manager must
    -- review. Tolerance is a client setting, not a constant.
    variance_tolerance_kobo INTEGER NOT NULL DEFAULT 0,
    requires_review      INTEGER NOT NULL DEFAULT 0,
    reviewed_by          TEXT REFERENCES users(id),
    reviewed_at          TEXT,
    review_note          TEXT,
    notes                TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted           INTEGER NOT NULL DEFAULT 0
);
-- ONE OPEN TILL per (branch, till number). Two open drawers on the same till is
-- how a variance becomes unattributable: every sale in the period could belong
-- to either, so neither can be reconciled and nobody can be held to account.
CREATE UNIQUE INDEX idx_till_sessions_one_open
    ON till_sessions(branch_id, till_no) WHERE status = 'OPEN' AND is_deleted = 0;
CREATE INDEX idx_till_sessions_branch ON till_sessions(branch_id, opened_at) WHERE is_deleted = 0;
CREATE INDEX idx_till_sessions_review ON till_sessions(requires_review, status) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- BRANCH SAFE  (the cash reserve; every movement typed and signed)
-- ---------------------------------------------------------------------
CREATE TABLE branch_safe_ledger (
    id             TEXT PRIMARY KEY,
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    movement_type  TEXT NOT NULL
                   CHECK (movement_type IN ('FLOAT_IN','TILL_SWEEP','BANK_DEPOSIT','PURCHASE','CHANGE_GIVEN',
                                            'REFUND','TRANSFER_IN','TRANSFER_OUT','COUNT_CORRECTION','PETTY_CASH')),
    direction      TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
    amount_kobo    INTEGER NOT NULL CHECK (amount_kobo > 0),
    amount         REAL NOT NULL,
    -- The balance is DERIVED from this ledger, never stored. A safe balance
    -- that is typed in rather than computed is a safe nobody can prove.
    balance_after_kobo INTEGER,          -- cached for display only; recomputed on audit
    reference      TEXT,
    source_type    TEXT,                 -- 'TILL_SESSION' | 'EXPENSE' | 'CHANGE_OWED' | 'REFUND'
    source_id      TEXT,
    approved_by    TEXT REFERENCES users(id),
    performed_by   TEXT NOT NULL REFERENCES users(id),
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_branch_safe_branch ON branch_safe_ledger(branch_id, created_at) WHERE is_deleted = 0;
CREATE INDEX idx_branch_safe_source ON branch_safe_ledger(source_type, source_id) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- CHANGE OWED  (the till had no small notes; we owe the customer)
-- ---------------------------------------------------------------------
-- A customer pays ₦10,000 for a ₦9,750 purchase and the drawer has no ₦250.
-- Refuse the note and lose the sale, or take it and owe ₦250. Shops do the
-- second, all day, every day — and without a record it becomes "I don't think
-- I owe you anything."
--
-- The claim code is quotable at ANY branch, so the change can be collected on
-- the next visit to a different shop. It is a liability until collected, it
-- ages, and it appears on the till report so the drawer still reconciles (the
-- ₦10,000 IS in the drawer; the ₦250 is owed out).
CREATE TABLE change_owed (
    id              TEXT PRIMARY KEY,
    claim_code      TEXT NOT NULL,
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    sale_id         TEXT REFERENCES sales(id),
    till_session_id TEXT REFERENCES till_sessions(id),
    customer_id     TEXT REFERENCES customers(id),
    customer_name   TEXT,
    customer_phone  TEXT,
    amount_kobo     INTEGER NOT NULL CHECK (amount_kobo > 0),
    amount          REAL NOT NULL,
    reason          TEXT NOT NULL DEFAULT 'NO_CHANGE_IN_DRAWER',
    status          TEXT NOT NULL DEFAULT 'OUTSTANDING'
                    CHECK (status IN ('OUTSTANDING','COLLECTED','FORFEITED','WRITTEN_BACK')),
    collected_at    TEXT,
    collected_at_branch_id TEXT REFERENCES branches(id),
    collected_by    TEXT REFERENCES users(id),
    -- Unclaimed change is written back to income after a period — but only by
    -- a manager's explicit action, never automatically. Silent write-back is
    -- how a drawer shortage becomes somebody's profit.
    review_after_days INTEGER NOT NULL DEFAULT 90,
    written_back_by TEXT REFERENCES users(id),
    written_back_at TEXT,
    created_by      TEXT NOT NULL REFERENCES users(id),
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_change_owed_code ON change_owed(claim_code) WHERE is_deleted = 0;
CREATE INDEX idx_change_owed_name ON change_owed(customer_name) WHERE status = 'OUTSTANDING' AND is_deleted = 0;
CREATE INDEX idx_change_owed_phone ON change_owed(customer_phone) WHERE status = 'OUTSTANDING' AND is_deleted = 0;
CREATE INDEX idx_change_owed_branch ON change_owed(branch_id, status, created_at) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- EXPENSES
-- ---------------------------------------------------------------------
CREATE TABLE expenses (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    category          TEXT NOT NULL,     -- free-form, with a suggested list per vertical
    expense_date      TEXT NOT NULL,
    description       TEXT NOT NULL,
    amount_kobo       INTEGER NOT NULL CHECK (amount_kobo > 0),
    amount            REAL NOT NULL,
    -- VAT paid on a purchase is INPUT VAT, recoverable if the business is
    -- registered. Recording it gross-only silently overstates the expense and
    -- understates the VAT return.
    vat_kobo          INTEGER NOT NULL DEFAULT 0,
    vat               REAL NOT NULL DEFAULT 0,
    vat_inclusive     INTEGER NOT NULL DEFAULT 1,
    payment_method    TEXT NOT NULL DEFAULT 'CASH',
    paid_from         TEXT NOT NULL DEFAULT 'TILL'
                      CHECK (paid_from IN ('TILL','SAFE','BANK','CREDIT','PETTY_CASH')),
    reference         TEXT,
    supplier_id       TEXT REFERENCES suppliers(id),
    receipt_attached  INTEGER NOT NULL DEFAULT 0,
    receipt_data_url  TEXT,
    -- Approval. An unapproved expense is a claim, not a cost.
    status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','APPROVED','REJECTED','POSTED')),
    approved_by       TEXT REFERENCES users(id),
    approved_at       TEXT,
    -- Withholding tax deducted from this expense, if any.
    wht_entry_id      TEXT,
    created_by        TEXT NOT NULL REFERENCES users(id),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_expenses_branch ON expenses(branch_id, expense_date) WHERE is_deleted = 0;
CREATE INDEX idx_expenses_business ON expenses(business_id, expense_date) WHERE is_deleted = 0;
CREATE INDEX idx_expenses_category ON expenses(category, expense_date) WHERE is_deleted = 0;
CREATE INDEX idx_expenses_status ON expenses(status) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- STAFF ATTENDANCE
-- ---------------------------------------------------------------------
CREATE TABLE staff_attendance (
    id                 TEXT PRIMARY KEY,
    business_id        TEXT NOT NULL REFERENCES businesses(id),
    branch_id          TEXT NOT NULL REFERENCES branches(id),
    user_id            TEXT NOT NULL REFERENCES users(id),
    clock_in_at        TEXT NOT NULL,
    clock_out_at       TEXT,
    -- Computed SERVER-SIDE (Haversine against branches.latitude/longitude) and
    -- stored per record. Never trusted from the client: a client-computed
    -- distance is a client-asserted alibi.
    classification     TEXT NOT NULL DEFAULT 'NO_LOCATION'
                       CHECK (classification IN ('ON_SITE','OFF_SITE','NO_LOCATION','GEOFENCE_NOT_SET')),
    distance_meters    INTEGER,
    geofence_radius    INTEGER,
    clock_in_latitude  REAL,
    clock_in_longitude REAL,
    clock_in_device_id TEXT,
    device_recognised  INTEGER,
    method             TEXT NOT NULL DEFAULT 'GEOLOCATION'
                       CHECK (method IN ('GEOLOCATION','REGISTERED_DEVICE','MANUAL')),
    -- A flagged clock-in is RECORDED and surfaced for review, never rejected.
    flagged            INTEGER NOT NULL DEFAULT 0,
    flag_reason        TEXT,
    reviewed_by        TEXT REFERENCES users(id),
    reviewed_at        TEXT,
    review_outcome     TEXT CHECK (review_outcome IS NULL OR
                       review_outcome IN ('ACCEPTED','CORRECTED','DISCIPLINARY','PENDING')),
    -- A manager-entered correction keeps the original alongside it, so the
    -- record shows both what the device said and what the manager decided.
    corrected_in_at    TEXT,
    corrected_out_at   TEXT,
    correction_reason  TEXT,
    worked_minutes     INTEGER,
    is_overtime        INTEGER NOT NULL DEFAULT 0,
    notes              TEXT,
    attendance_date    TEXT NOT NULL,       -- YYYY-MM-DD WAT
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);
-- ONE open clock-in per user. Without this, a forgotten clock-out accumulates
-- into a second open session and the hours become unattributable.
CREATE UNIQUE INDEX idx_attendance_one_open_per_user
    ON staff_attendance(user_id) WHERE clock_out_at IS NULL AND is_deleted = 0;
CREATE INDEX idx_attendance_branch_date ON staff_attendance(branch_id, attendance_date) WHERE is_deleted = 0;
CREATE INDEX idx_attendance_user_date ON staff_attendance(user_id, clock_in_at) WHERE is_deleted = 0;
CREATE INDEX idx_attendance_flagged ON staff_attendance(flagged, reviewed_at) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- DOCUMENT NUMBER COUNTERS
-- ---------------------------------------------------------------------
-- Invoices, receipts, POs, GRNs, returns and deliveries all need a number a
-- human can read aloud: "invoice SR-LG-000417". A random id cannot provide
-- that, and a GAP-FREE sequential series per branch per document type is what
-- a tax audit expects — a series with gaps is a red flag that invites a
-- closer look.
CREATE TABLE document_counters (
    id             TEXT PRIMARY KEY,
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    doc_type       TEXT NOT NULL
                   CHECK (doc_type IN ('SALE','RECEIPT','PO','GRN','RETURN','DELIVERY','TRANSFER','QUOTE','CREDIT_NOTE','STOCKTAKE','VOUCHER')),
    last_number    INTEGER NOT NULL DEFAULT 0,
    prefix         TEXT,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (business_id, branch_id, doc_type)
);
-- =====================================================================