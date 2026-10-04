-- =====================================================================
-- STOCKRIDGE — MULTI-BRANCH, MULTI-BUSINESS INVENTORY / POS / BACK OFFICE
-- SQLite schema v1 — offline-first PWA, production-hardened
-- Target: the general Nigerian retail & wholesale market
-- =====================================================================
--
-- DERIVATION FROM PHARMARIDGE (what was kept, what was decoupled, what is new)
--
--  KEPT VERBATIM — domain-independent primitives that the PharmaRidge
--  audit proved out in production:
--    [SYNC]   updated_at + is_deleted on every mutable table, so offline
--             branches merge with last-write-wins and deletions survive a
--             sync round-trip instead of silently vanishing.
--    [SYNC]   branch_sync_status + sync_change_log give the manager a live
--             queryable view of each branch's sync health.
--    [SYNC]   sync_conflicts records the LOSING version whenever LWW is
--             about to discard a concurrent offline edit, so a lost write
--             is visible instead of silent.
--    [CTRL]   idempotency_keys — one logical action executes once however
--             many times a flaky connection or an offline queue replays it.
--    [UOM]    selling at BASE_UNIT/PACK/CARTON while stock decrements in
--             base units (extended here with a PALLET rung).
--    [STOCKTAKE] freeze system qty -> count -> variance -> adjustment.
--    [CASH]   cash_tendered/change_given on sale payments, till sessions,
--             branch safe ledger, change-owed claim codes.
--    [PRICE]  per-branch price overrides (Lagos vs Minna pricing).
--    [ATTENDANCE] clock in/out with best-effort geofence/device check that
--             FLAGS rather than BLOCKS.
--    [AUDIT]  hash-chained tamper-evident registers; void-rate-by-user as a
--             shrinkage signal.
--    [TIMEZONE] every day-bucketed report is a WEST AFRICA TIME day, not a
--             UTC day (PharmaRidge migration 009 — a 00:00-00:59 Lagos sale
--             was landing in the previous calendar day).
--    [AUTH]   short numeric PINs, per-account salt, PBKDF2, login throttle
--             with lockout, and a higher-ranked unlock so a mistyping owner
--             is not locked out of their own shop mid-queue.
--    [PLAN]   vendor-set plan limits + client-set permission switches, with
--             NARROW ALLOWANCES rather than flat bans on cashier voids,
--             write-offs and safe spend.
--
--  DECOUPLED — pharmacy domain policy moved OUT of the schema and INTO data:
--    products.dispensing_type / is_controlled / nafdac_reg_no
--      -> products.compliance_ref_no + compliance_schemes, and a
--         product_attributes JSON column driven by the profile's declared
--         product_fields. A gadget's storage capacity and a sofa's fabric
--         are the same mechanism.
--    products.retail_category CHECK ('PHARMACEUTICALS',...)
--      -> product_categories table, seeded per industry profile, editable
--         by the OWNER. Bounded enums in a schema cannot serve four
--         verticals; a table can serve forty.
--    branches.pcn_license_no / superintendent_pharmacist
--      -> branch_certificates (regulator, scheme, number, expiry) so the
--         same table holds a SONCAP certificate, a MAN registration, a CAC
--         filing and a PCN licence.
--    prescriptions + controlled_substance_register
--      -> compliance_register: the same append-only hash-chained log,
--         parameterised by scheme. For electronics it is the serial-number
--         custody chain (which is a genuinely harder anti-theft problem
--         than the pharmacy one it replaces); for a furniture showroom it
--         is the made-to-order sign-off; for building materials it is the
--         mill certificate presented to an engineer.
--    client_settings (single row) -> business_units (one row PER BUSINESS),
--         each with its own profile, branding, plan limits and settings.
--
--  NEW — flows a general Nigerian business needs that a pharmacy did not:
--    business_units          multi-BUSINESS tenancy (not just multi-branch)
--    product_serials         IMEI/serial/asset-tag per physical item
--    product_warranties      warranty terms, cover window, claims
--    price_tiers +           wholesale/retail/distributor/contractor pricing
--      product_tier_prices
--    payment_plans +         instalment ("Ajo") agreements with a schedule
--      payment_plan_items       that sums EXACTLY to the plan total
--      payment_plan_payments
--    layaway_holds           deposit now, collect later, stock reserved
--    delivery_jobs +         delivery/installation with vehicle, driver,
--      delivery_job_items       proof of delivery and customer signature
--    sale_delivery_requirements
--    customer_credit_limits  enforced credit ceiling per customer
--    product_suppliers       per-product supplier, lead time, last cost
--    stock_reservations      one mechanism behind layaway, delivery and
--                              instalment holds
--    audit_log               who did what, when, from which branch/device
-- =====================================================================
--
-- RUNTIME NOTES
--   Node / better-sqlite3 : the adapter sets `PRAGMA foreign_keys = ON`
--                           per connection (server/lib/db.js).
--   Cloudflare D1         : FK enforcement is ALWAYS on and cannot be set by
--                           user SQL, so there is no PRAGMA statement in this
--                           file — leaving one in aborts
--                           `wrangler d1 migrations apply`.
--
--   Every id is generated IN THE APPLICATION LAYER (shared/ids.js newId())
--   before insert, never by a SQL DEFAULT. An offline PWA must know the id
--   of the row it just created locally, and that is what makes the sync
--   protocol idempotent by construction. The DEFAULT below exists only so a
--   hand-run INSERT in a console cannot produce a NULL primary key.
-- =====================================================================

-- =====================================================================
-- 1. TENANCY: BUSINESS UNITS  (multi-business)
-- =====================================================================
-- A "business unit" is one trading business: its own industry profile,
-- branding, plan limits, tax settings and permission switches. One
-- deployment may host several — the group that owns both an appliance
-- wholesale company and a furniture showroom runs both here, and the same
-- human being may hold different roles in each.
--
-- PharmaRidge was single-tenant-per-client: one deployment = one pharmacy,
-- and `client_settings` was a single row with `CHECK (id = 1)`. That is the
-- right model when the vendor deploys per client. StockRidge supports BOTH:
-- a vendor can still run one business unit per deployment (the common
-- case), and a group can run several. Every query that used to read
-- client_settings now scopes on business_unit_id, and the ADMIN portal
-- spans units.
CREATE TABLE business_units (
    id                        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    code                      TEXT NOT NULL UNIQUE,          -- short slug used in reference numbers, e.g. 'LAG-APPL'
    name                      TEXT NOT NULL,                 -- trading name shown throughout the UI
    industry_profile          TEXT NOT NULL,                 -- see shared/industryProfiles.js PROFILES[].code
    profile_is_custom         INTEGER NOT NULL DEFAULT 0,    -- 1 = owner-defined profile stored in profile_json
    profile_json              TEXT,                          -- custom profile: same shape as a built-in one
    legal_name                TEXT,                          -- registered company name for invoices
    rc_number                 TEXT,                          -- CAC RC/BN number, printed on receipts (FIRS requirement)
    tin                       TEXT,                          -- Tax Identification Number
    address                   TEXT,
    state                     TEXT,                          -- Nigerian state, for tax jurisdiction reporting
    lga                       TEXT,
    phone                     TEXT,
    email                     TEXT,
    website                   TEXT,
    logo_data_url             TEXT,                          -- validated image data URL, capped at 500 KB
    currency                  TEXT NOT NULL DEFAULT 'NGN',
    timezone                  TEXT NOT NULL DEFAULT 'Africa/Lagos',  -- informational; all bucketing is WAT by construction
    fiscal_year_start_month   INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),

    -- PLAN LIMITS (vendor/ADMIN set). Mirrors PharmaRidge's client_settings.
    max_branches              INTEGER NOT NULL DEFAULT 5,
    max_staff                 INTEGER NOT NULL DEFAULT 25,
    max_products              INTEGER NOT NULL DEFAULT 5000,
    subscription_status       TEXT NOT NULL CHECK (subscription_status IN ('TRIAL','ACTIVE','SUSPENDED','EXPIRED')) DEFAULT 'ACTIVE',
    subscription_plan         TEXT NOT NULL DEFAULT 'Standard',
    subscription_renewal_date TEXT,

    -- FEATURE TOGGLES (vendor/ADMIN set — these are what the client PAID for)
    multi_branch_enabled          INTEGER NOT NULL DEFAULT 1,
    instalment_module_enabled     INTEGER NOT NULL DEFAULT 1,
    layaway_module_enabled        INTEGER NOT NULL DEFAULT 1,
    delivery_module_enabled       INTEGER NOT NULL DEFAULT 1,
    warranty_module_enabled       INTEGER NOT NULL DEFAULT 1,
    wholesale_tier_enabled        INTEGER NOT NULL DEFAULT 1,
    attendance_module_enabled     INTEGER NOT NULL DEFAULT 1,
    compliance_register_enabled   INTEGER NOT NULL DEFAULT 1,
    gl_module_enabled             INTEGER NOT NULL DEFAULT 1,
    offline_sync_enabled          INTEGER NOT NULL DEFAULT 1,

    -- TAX (CLIENT-owned compliance status with FIRS, not a vendor switch).
    -- OFF by default: the app must never silently start charging a tax
    -- nobody registered for.
    vat_enabled               INTEGER NOT NULL DEFAULT 0,
    vat_rate_percent          REAL NOT NULL DEFAULT 7.5,     -- FIRS standard rate
    vat_registration_no       TEXT,
    wht_enabled               INTEGER NOT NULL DEFAULT 0,

    -- VAT-INCLUSIVE PRICING MODEL (kept from PharmaRidge, and correct for
    -- every Nigerian retail vertical, not just pharmacy): enabling VAT does
    -- NOT increase what the customer pays at the counter, matching how
    -- shelf prices already work. sales.total is unchanged; VAT is EXTRACTED
    -- from the existing total for reporting and remittance bookkeeping.
    vat_inclusive_pricing     INTEGER NOT NULL DEFAULT 1,

    -- OWNER-CONTROLLED MANAGER PERMISSIONS. Client governance, not vendor
    -- plan. Default 1 so behaviour is unchanged until an owner deliberately
    -- restricts something. OWNER and ADMIN are never restricted by these —
    -- a switch that could lock a proprietor out of their own books is a
    -- footgun.
    managers_can_void_sales           INTEGER NOT NULL DEFAULT 1,
    managers_can_approve_expenses     INTEGER NOT NULL DEFAULT 1,
    managers_can_edit_prices          INTEGER NOT NULL DEFAULT 1,
    managers_can_grant_credit         INTEGER NOT NULL DEFAULT 1,
    managers_can_override_credit_limit INTEGER NOT NULL DEFAULT 1,
    managers_can_discount             INTEGER NOT NULL DEFAULT 1,
    max_discount_percent              REAL NOT NULL DEFAULT 25 CHECK (max_discount_percent >= 0),

    -- OWNER-CONTROLLED STAFF PERMISSIONS. The two classic retail-theft
    -- patterns a lone cashier can run unaided:
    --   VOID      — sell for cash, void the sale, keep the note. The books
    --               show no sale; the stock is already gone.
    --   WRITE-OFF — take the goods, record them as DAMAGE. Shrinkage looks
    --               like breakage.
    -- Both were reproduced live in the PharmaRidge audit before these
    -- columns existed. Deliberately NOT a flat ban: a mis-keyed sale at a
    -- busy counter is common, and a lone cashier on a night shift must be
    -- able to correct it. The WINDOW and the CAP are what make the
    -- allowance safe — they cover "I rang that up wrong" and "I dropped it"
    -- without covering "I am reversing yesterday's takings".
    staff_can_void_sales          INTEGER NOT NULL DEFAULT 1,
    staff_void_window_minutes     INTEGER NOT NULL DEFAULT 15 CHECK (staff_void_window_minutes >= 0),
    staff_can_adjust_stock        INTEGER NOT NULL DEFAULT 1,
    staff_adjustment_max_units    REAL NOT NULL DEFAULT 5 CHECK (staff_adjustment_max_units >= 0),
    staff_can_discount            INTEGER NOT NULL DEFAULT 0,
    staff_max_discount_percent    REAL NOT NULL DEFAULT 5 CHECK (staff_max_discount_percent >= 0),
    staff_can_take_credit_sale    INTEGER NOT NULL DEFAULT 0,
    staff_can_spend_from_safe     INTEGER NOT NULL DEFAULT 1,
    -- 0 = NO CAP, deliberately: the client may want "no limit", so this is
    -- read as unlimited and never as "zero allowed". The can/cannot
    -- decision is the boolean above.
    staff_safe_spend_max          REAL NOT NULL DEFAULT 20000 CHECK (staff_safe_spend_max >= 0),
    staff_can_create_delivery_job INTEGER NOT NULL DEFAULT 1,

    admin_contact_name          TEXT,
    admin_contact_phone         TEXT,
    admin_contact_email         TEXT,
    notes                       TEXT,
    is_active                   INTEGER NOT NULL DEFAULT 1,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted                  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_business_units_profile ON business_units(industry_profile) WHERE is_deleted = 0;
CREATE INDEX idx_business_units_active  ON business_units(is_active, is_deleted);

-- =====================================================================
-- 2. ORGANISATION: BRANCHES, DEVICES, USERS
-- =====================================================================
CREATE TABLE branches (
    id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id       TEXT NOT NULL REFERENCES business_units(id),
    code                   TEXT NOT NULL,                 -- short code used in reference numbers and till ids
    name                   TEXT NOT NULL,
    branch_type            TEXT NOT NULL CHECK (branch_type IN ('RETAIL','WHOLESALE','BOTH','WAREHOUSE','SHOWROOM','WORKSHOP','YARD')) DEFAULT 'RETAIL',
    address                TEXT,
    state                  TEXT,
    lga                    TEXT,
    city                   TEXT,
    phone                  TEXT,
    email                  TEXT,
    manager_name           TEXT,

    -- Geofencing for attendance / anti-buddy-punching.
    latitude               REAL,                          -- NULL = geofence not configured yet
    longitude              REAL,
    geofence_radius_meters INTEGER NOT NULL DEFAULT 100,
    -- Chosen by the MANAGER per branch, because different branches
    -- genuinely need different methods:
    --   GEOLOCATION       — mobile/handheld and delivery staff; clock
    --                       in/out classified against the geofence above.
    --   REGISTERED_DEVICE — branches with fixed till/back-office laptops;
    --                       classified by whether the browser's persistent
    --                       device id matches one the manager registered
    --                       for THIS branch.
    -- Both are best-effort SIGNAL, never a hard gate. GPS accuracy and
    -- permissions vary enormously by device and by shop location (a
    -- showroom inside a mall may never get a fix), so an off-site or
    -- no-location attempt is FLAGGED for manager review, never rejected —
    -- rejecting it would mean a cashier cannot start their shift.
    attendance_mode        TEXT NOT NULL CHECK (attendance_mode IN ('GEOLOCATION','REGISTERED_DEVICE')) DEFAULT 'GEOLOCATION',

    is_main                INTEGER NOT NULL DEFAULT 0,     -- the head office / consolidation branch
    is_active              INTEGER NOT NULL DEFAULT 1,
    opening_date           TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted             INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, code)
);
CREATE INDEX idx_branches_bu     ON branches(business_unit_id) WHERE is_deleted = 0;
CREATE INDEX idx_branches_active ON branches(business_unit_id, is_active, is_deleted);

-- A "device" is NOT a hardware serial number: no web browser can read one
-- (blocked for privacy on every modern browser, including in a
-- native-feeling PWA install), so no web-based system can identify a
-- laptop by real hardware. What CAN be done — and what this stores — is a
-- random id generated once client-side and persisted in that browser's
-- localStorage. It identifies "this browser profile on this machine" for
-- as long as nobody clears site data, which is the same practical
-- guarantee commercial POS terminal-locking relies on. Stated plainly
-- because overselling it would be a security lie.
CREATE TABLE branch_devices (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    branch_id        TEXT NOT NULL REFERENCES branches(id),
    business_unit_id TEXT NOT NULL REFERENCES business_units(id),
    device_id        TEXT NOT NULL,
    label            TEXT,                     -- "Front counter laptop", "Till 2"
    device_type      TEXT NOT NULL CHECK (device_type IN ('TILL','BACK_OFFICE','HANDHELD','TABLET','OTHER')) DEFAULT 'TILL',
    registered_by    TEXT REFERENCES users(id),
    registered_at    TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_by       TEXT REFERENCES users(id),
    revoked_at       TEXT,
    last_seen_at     TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted       INTEGER NOT NULL DEFAULT 0
);
-- A device may be actively registered to only ONE branch at a time — a
-- laptop physically belongs to one location, so reassigning it requires
-- revoking first. Same partial-unique-index pattern as the "one open per
-- branch" guards on tills, stocktakes and attendance.
CREATE UNIQUE INDEX idx_branch_devices_active_device ON branch_devices(device_id) WHERE is_deleted = 0 AND revoked_at IS NULL;
CREATE INDEX idx_branch_devices_branch ON branch_devices(branch_id) WHERE is_deleted = 0 AND revoked_at IS NULL;

-- ROLE HIERARCHY (highest to lowest privilege):
--   ADMIN   — the software vendor / platform administrator. NOT part of any
--             client's staff. Sets plan limits, feature toggles, subscription
--             status and branding across business units via /api/admin/*.
--             Never counted against a client's staff limit and always bypasses
--             the subscription gate, so the vendor can never be locked out of
--             a client's instance. Hidden from the ordinary Users screen.
--   OWNER   — the proprietor. Full operational access identical to MANAGER
--             across every branch of their business unit(s), PLUS visibility
--             of their own subscription/plan usage and the governance
--             switches above.
--   MANAGER — day-to-day operations admin. ONE stored role, presented under
--             two job titles decided ENTIRELY by whether branch_id is set:
--               General Manager  branch_id IS NULL — every branch
--               Branch Manager   branch_id IS SET   — exactly one branch
--             DELIBERATELY NOT TWO ROLE VALUES. branch_id is already the
--             single source of truth for every authorisation decision; a
--             separate BRANCH_MANAGER enum would be a SECOND fact encoding
--             the same thing, and the two could then disagree (a
--             BRANCH_MANAGER row with a NULL branch_id, or a MANAGER row
--             pinned to a branch they were told they could not see).
--   STAFF   — cashier / salesperson / storekeeper. Scoped to one branch.
--             Handles cash all day, so it is the role every allowance and
--             audit view is designed around.
CREATE TABLE users (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT REFERENCES branches(id),        -- NULL for ADMIN/OWNER/General Manager
    full_name         TEXT NOT NULL,
    username          TEXT NOT NULL,
    -- pbkdf2$sha256$<iterations>$<saltHex>$<hashHex>. The iteration count
    -- is stored WITH the hash so it can be raised later without
    -- invalidating existing credentials.
    pin_hash          TEXT NOT NULL,
    pin_updated_at    TEXT,
    role              TEXT NOT NULL CHECK (role IN ('ADMIN','OWNER','MANAGER','STAFF')) DEFAULT 'STAFF',
    job_title         TEXT,
    phone             TEXT,
    email             TEXT,
    -- Per-business-unit membership. A group accountant may be OWNER of one
    -- unit and MANAGER of another; see user_business_access.
    primary_unit_role TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    must_change_pin   INTEGER NOT NULL DEFAULT 0,
    last_login_at     TEXT,
    last_login_branch_id TEXT REFERENCES branches(id),
    hired_at          TEXT,
    exited_at         TEXT,
    exit_reason       TEXT,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, username)
);
CREATE INDEX idx_users_bu        ON users(business_unit_id) WHERE is_deleted = 0;
CREATE INDEX idx_users_branch    ON users(branch_id);
CREATE INDEX idx_users_role      ON users(business_unit_id, role) WHERE is_deleted = 0;
CREATE INDEX idx_users_username  ON users(username) WHERE is_deleted = 0;

-- Cross-unit access. Keeps "one human, several businesses" out of the
-- users table so a role change in one unit cannot affect another.
CREATE TABLE user_business_access (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id           TEXT NOT NULL REFERENCES users(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    role              TEXT NOT NULL CHECK (role IN ('ADMIN','OWNER','MANAGER','STAFF')),
    branch_id         TEXT REFERENCES branches(id),
    granted_by        TEXT REFERENCES users(id),
    granted_at        TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at        TEXT,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, business_unit_id)
);
CREATE INDEX idx_user_access_unit ON user_business_access(business_unit_id) WHERE is_deleted = 0 AND revoked_at IS NULL;

-- Append-only history of every branch/role change. Needed because an
-- audit question is never "what is Ada's role?" but "who could void a
-- sale at the Ikeja branch on the 14th of March?" — and by then the
-- answer has been overwritten twice.
CREATE TABLE user_assignment_history (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id        TEXT NOT NULL REFERENCES users(id),
    business_unit_id TEXT NOT NULL REFERENCES business_units(id),
    from_branch_id TEXT REFERENCES branches(id),
    to_branch_id   TEXT REFERENCES branches(id),
    from_role      TEXT,
    to_role        TEXT,
    changed_by     TEXT REFERENCES users(id),
    reason         TEXT,
    changed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_user_assignment_history_user ON user_assignment_history(user_id, changed_at);

-- A branch transfer that needs the RECEIVING manager's agreement (staff
-- accommodation, payroll, who owns the till float). Requested by one
-- manager, accepted by another — a one-sided write would let a manager
-- dump a problem employee on a peer.
CREATE TABLE pending_user_transfers (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id          TEXT NOT NULL REFERENCES users(id),
    business_unit_id TEXT NOT NULL REFERENCES business_units(id),
    from_branch_id   TEXT REFERENCES branches(id),
    to_branch_id     TEXT NOT NULL REFERENCES branches(id),
    requested_by     TEXT NOT NULL REFERENCES users(id),
    status           TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','DECLINED','CANCELLED','EXPIRED')) DEFAULT 'PENDING',
    reason           TEXT,
    responded_by     TEXT REFERENCES users(id),
    response_note    TEXT,
    requested_at     TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at     TEXT,
    expires_at       TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted       INTEGER NOT NULL DEFAULT 0
);
-- Only ONE open transfer request per user: two simultaneous pending moves
-- for the same person is not a state anyone can reason about.
CREATE UNIQUE INDEX idx_pending_user_transfer_open
    ON pending_user_transfers(user_id) WHERE status = 'PENDING' AND is_deleted = 0;
CREATE INDEX idx_pending_user_transfer_status ON pending_user_transfers(status, requested_at);

-- Sessions. Server-side revocation, so "sign out everywhere" and "this
-- laptop was stolen" are both actually enforceable rather than a client
-- deleting its own token.
CREATE TABLE user_sessions (
    session_id     TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    business_unit_id TEXT REFERENCES business_units(id),
    device_id      TEXT,
    ip_address     TEXT,
    user_agent     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at     TEXT NOT NULL,
    revoked_at     TEXT,
    revoked_reason TEXT,
    last_seen_at   TEXT
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id, created_at);

-- Login throttle + authentication audit trail.
-- WHY: a production audit against real workerd + D1 found 60 consecutive
-- wrong PINs returning a plain 401 in 1,150ms total — 19ms per attempt, no
-- lockout, no throttle, no record. With a 4-digit PIN that is a 10,000-value
-- keyspace searchable in minutes. Slow hashing stops an OFFLINE attack; this
-- stops an ONLINE one. Neither is sufficient alone.
CREATE TABLE login_attempts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL,
    business_unit_id TEXT REFERENCES business_units(id),
    user_id      TEXT REFERENCES users(id),
    succeeded    INTEGER NOT NULL DEFAULT 0,
    ip_address   TEXT,
    user_agent   TEXT,
    device_id    TEXT,
    failure_reason TEXT,
    attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_attempts_username_time ON login_attempts(username, attempted_at);
CREATE INDEX idx_login_attempts_time ON login_attempts(attempted_at);

-- =====================================================================
-- 3. BRANCH COMPLIANCE (replaces PCN licence / superintendent columns)
-- =====================================================================
-- One table holds whatever regulator applies to whatever business: a
-- SONCAP certificate for an importer, a MAN registration for a fabricator,
-- a CAC post-registration filing, a state trading licence, a PCN premises
-- licence. Expiry alerts come free for all of them.
CREATE TABLE compliance_schemes (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    code              TEXT NOT NULL,                    -- 'SONCAP', 'SON', 'MAN', 'NAFDAC', 'PCN', 'CAC', 'STATE_TRADE'
    label             TEXT NOT NULL,
    regulator         TEXT NOT NULL,
    applies_to        TEXT NOT NULL CHECK (applies_to IN ('BRANCH','BUSINESS','PRODUCT','ALL')) DEFAULT 'BRANCH',
    requires_expiry   INTEGER NOT NULL DEFAULT 1,
    renewal_warning_days INTEGER NOT NULL DEFAULT 60,
    description       TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, code)
);

CREATE TABLE branch_certificates (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT REFERENCES branches(id),     -- NULL = applies to the whole business
    scheme_code       TEXT NOT NULL,
    certificate_no    TEXT NOT NULL,
    holder_name       TEXT,                             -- e.g. the signatory engineer / superintendent
    holder_reg_no     TEXT,
    issued_at         TEXT,
    expiry_date       TEXT,                             -- ISO date
    attachment_note   TEXT,
    status            TEXT NOT NULL CHECK (status IN ('VALID','EXPIRING','EXPIRED','SUSPENDED','NOT_APPLICABLE')) DEFAULT 'VALID',
    recorded_by       TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_branch_certificates_branch ON branch_certificates(branch_id, expiry_date) WHERE is_deleted = 0;
CREATE INDEX idx_branch_certificates_bu     ON branch_certificates(business_unit_id) WHERE is_deleted = 0;

-- =====================================================================
-- 4. CATALOGUE
-- =====================================================================
-- Categories are DATA, seeded from the industry profile and editable by
-- the OWNER. PharmaRidge's bounded CHECK enum served one vertical; four
-- verticals plus whatever a client invents need a table.
CREATE TABLE product_categories (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    code              TEXT NOT NULL,
    label             TEXT NOT NULL,
    parent_id         TEXT REFERENCES product_categories(id),
    default_base_unit TEXT NOT NULL DEFAULT 'PIECE',
    -- A category can switch capabilities on for its own products: paint and
    -- cement expire, sofas do not; phones carry serials, curtains do not.
    tracks_serials    INTEGER NOT NULL DEFAULT 0,
    tracks_expiry     INTEGER NOT NULL DEFAULT 0,
    tracks_warranty   INTEGER NOT NULL DEFAULT 0,
    is_installation_item INTEGER NOT NULL DEFAULT 0,
    gl_revenue_account_id TEXT REFERENCES gl_accounts(id),
    gl_cogs_account_id    TEXT REFERENCES gl_accounts(id),
    sort_order        INTEGER NOT NULL DEFAULT 0,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, code)
);
CREATE INDEX idx_product_categories_bu ON product_categories(business_unit_id, is_active, is_deleted);

CREATE TABLE products (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    sku               TEXT,                             -- internal stock-keeping unit; unique per business
    name              TEXT NOT NULL,
    description       TEXT,
    category_id       TEXT REFERENCES product_categories(id),
    brand             TEXT,
    model_number      TEXT,

    -- UNIT OF MEASURE + PACKING LADDER (see shared/units.js)
    base_unit         TEXT NOT NULL DEFAULT 'PIECE',
    units_per_pack    INTEGER NOT NULL DEFAULT 1,
    packs_per_carton  INTEGER,
    cartons_per_pallet INTEGER,
    selling_units     TEXT NOT NULL DEFAULT 'BASE_UNIT,PACK',  -- comma list of allowed rungs

    -- COMPLIANCE (generalised from nafdac_reg_no)
    compliance_scheme TEXT,                             -- which scheme's number this is
    compliance_ref_no TEXT,                             -- SONCAP / NAFDAC / SON certificate no.
    compliance_expiry_date TEXT,
    is_regulated      INTEGER NOT NULL DEFAULT 0,       -- appears on the compliance register

    -- CAPABILITIES per product, overriding the category default
    tracks_serials    INTEGER NOT NULL DEFAULT 0,
    tracks_expiry     INTEGER NOT NULL DEFAULT 0,
    tracks_warranty   INTEGER NOT NULL DEFAULT 0,
    warranty_months   INTEGER,                          -- NULL = use the profile default
    warranty_terms    TEXT,
    requires_installation INTEGER NOT NULL DEFAULT 0,
    assembly_required INTEGER NOT NULL DEFAULT 0,
    made_to_order     INTEGER NOT NULL DEFAULT 0,
    lead_time_days    INTEGER NOT NULL DEFAULT 0,
    delivery_class    TEXT CHECK (delivery_class IS NULL OR delivery_class IN ('SMALL','MEDIUM','LARGE','BULKY')),
    is_fragile        INTEGER NOT NULL DEFAULT 0,

    -- Profile-driven extension fields (brand-specific: storage, fabric,
    -- grade, size_mm...). Stored as JSON keyed by the profile's declared
    -- product_fields[].key, so the schema never grows a column per vertical.
    attributes_json   TEXT NOT NULL DEFAULT '{}',

    -- VALUATION & REORDER
    valuation_method  TEXT NOT NULL CHECK (valuation_method IN ('FIFO','WEIGHTED_AVG','SPECIFIC')) DEFAULT 'FIFO',
    reorder_level     REAL NOT NULL DEFAULT 0,
    reorder_quantity  REAL NOT NULL DEFAULT 0,
    max_stock_level   REAL,
    default_cost_price   REAL NOT NULL DEFAULT 0,       -- per base unit
    default_selling_price REAL NOT NULL DEFAULT 0,      -- per base unit
    wholesale_selling_price REAL,                       -- per base unit, fallback when no tier rule applies
    tax_code          TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    discontinued_at   TEXT,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_products_sku ON products(business_unit_id, sku) WHERE sku IS NOT NULL AND is_deleted = 0;
CREATE INDEX idx_products_bu        ON products(business_unit_id) WHERE is_deleted = 0;
CREATE INDEX idx_products_category  ON products(category_id) WHERE is_deleted = 0;
CREATE INDEX idx_products_name      ON products(business_unit_id, name) WHERE is_deleted = 0;
CREATE INDEX idx_products_reorder   ON products(business_unit_id, is_active) WHERE is_deleted = 0 AND tracks_serials = 0;

-- Barcode / IMEI-prefix / QR registry. One product may carry a code for a
-- single piece, a pack, a carton and a pallet; scanning selects the
-- stored selling unit, which is what lets a wholesale counter scan a
-- carton barcode and sell a carton without any manual conversion.
CREATE TABLE product_barcodes (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    product_id        TEXT NOT NULL REFERENCES products(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    barcode           TEXT NOT NULL,
    unit_type         TEXT NOT NULL CHECK (unit_type IN ('BASE_UNIT','PACK','CARTON','PALLET')) DEFAULT 'BASE_UNIT',
    label             TEXT,
    is_primary        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, barcode)
);
CREATE INDEX idx_product_barcodes_product ON product_barcodes(product_id) WHERE is_deleted = 0;
-- One primary barcode per product, so "print a label" is unambiguous.
CREATE UNIQUE INDEX idx_product_barcodes_primary ON product_barcodes(product_id) WHERE is_primary = 1 AND is_deleted = 0;

-- Per-branch default selling price. Lagos and Minna can each carry a
-- different default for the same master product, and a branch that
-- receives a new batch pre-fills from here. The BATCH row remains the
-- price of record for that specific stock (see stock_batches).
CREATE TABLE product_price_overrides (
    id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id       TEXT NOT NULL REFERENCES business_units(id),
    branch_id              TEXT NOT NULL REFERENCES branches(id),
    product_id             TEXT NOT NULL REFERENCES products(id),
    default_selling_price  REAL NOT NULL,
    pack_price             REAL,
    carton_price           REAL,
    pallet_price           REAL,
    effective_from         TEXT,
    effective_to           TEXT,
    updated_by             TEXT REFERENCES users(id),
    reason                 TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted             INTEGER NOT NULL DEFAULT 0,
    UNIQUE (branch_id, product_id)
);
CREATE INDEX idx_price_overrides_branch_prod ON product_price_overrides(branch_id, product_id);

-- PRICE TIERS — the wholesale/retail split that a general trader lives on.
-- A tier is a customer class (WALK_IN / RETAIL / WHOLESALE / DISTRIBUTOR /
-- CONTRACTOR / PROJECT / GOVERNMENT), seeded per profile. Rules are either
-- a percentage off the retail price or an absolute price, and may carry a
-- minimum quantity — "₦185,000 per unit if you take 10 or more" is the
-- single most common Nigerian wholesale price expression and it must be a
-- first-class rule, not a manual override the cashier has to remember.
CREATE TABLE price_tiers (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    code              TEXT NOT NULL,
    label             TEXT NOT NULL,
    rank              INTEGER NOT NULL DEFAULT 0,        -- higher rank = better price; resolves competing rules
    requires_min_qty  INTEGER NOT NULL DEFAULT 0,
    is_default        INTEGER NOT NULL DEFAULT 0,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, code)
);

CREATE TABLE product_tier_prices (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    tier_id           TEXT NOT NULL REFERENCES price_tiers(id),
    branch_id         TEXT REFERENCES branches(id),      -- NULL = all branches
    price_type        TEXT NOT NULL CHECK (price_type IN ('FIXED','PERCENT_OFF_RETAIL','PERCENT_OFF_COST_PLUS_MARKUP')) DEFAULT 'FIXED',
    price_value       REAL NOT NULL,                     -- absolute per base unit, or the percentage
    markup_percent    REAL,                              -- for COST_PLUS
    min_quantity      REAL NOT NULL DEFAULT 1,           -- quantity break: applies at this qty or above
    max_quantity      REAL,
    effective_from    TEXT,
    effective_to      TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
-- One rule per product/tier/branch/quantity-break. Without this, two
-- overlapping rules for the same 10+ break resolve by luck.
CREATE UNIQUE INDEX idx_tier_prices_unique
    ON product_tier_prices(product_id, tier_id, branch_id, min_quantity) WHERE is_deleted = 0;
CREATE INDEX idx_tier_prices_product ON product_tier_prices(product_id) WHERE is_deleted = 0;

CREATE TABLE suppliers (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    name              TEXT NOT NULL,
    supplier_type     TEXT NOT NULL CHECK (supplier_type IN ('MANUFACTURER','IMPORTER','DISTRIBUTOR','WHOLESALE','WORKSHOP','SERVICE','OTHER')) DEFAULT 'WHOLESALE',
    contact_name      TEXT,
    phone             TEXT,
    alt_phone         TEXT,
    email             TEXT,
    address           TEXT,
    state             TEXT,
    country           TEXT NOT NULL DEFAULT 'Nigeria',
    tin               TEXT,                              -- needed for WHT exemption hints and FIRS filing
    rc_number         TEXT,
    bank_name         TEXT,
    bank_account_name TEXT,
    bank_account_no   TEXT,
    payment_terms_days INTEGER NOT NULL DEFAULT 0,       -- 0 = cash on delivery
    credit_limit      REAL NOT NULL DEFAULT 0,           -- how much WE may owe them
    currency          TEXT NOT NULL DEFAULT 'NGN',
    lead_time_days    INTEGER NOT NULL DEFAULT 0,
    rating            INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
    notes             TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_suppliers_bu ON suppliers(business_unit_id) WHERE is_deleted = 0;

-- Which supplier provides which product, at what last cost and lead time.
-- Turns "reorder" from a memory exercise into a suggestion: the low-stock
-- report can name the supplier and the phone number.
CREATE TABLE product_suppliers (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    supplier_id       TEXT NOT NULL REFERENCES suppliers(id),
    supplier_item_code TEXT,
    unit_cost         REAL,                              -- per base unit, in supplier's unit terms below
    cost_unit         TEXT NOT NULL CHECK (cost_unit IN ('BASE_UNIT','PACK','CARTON','PALLET')) DEFAULT 'BASE_UNIT',
    min_order_quantity REAL NOT NULL DEFAULT 1,
    lead_time_days    INTEGER NOT NULL DEFAULT 0,
    is_preferred      INTEGER NOT NULL DEFAULT 0,
    last_ordered_at   TEXT,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_product_suppliers_unique ON product_suppliers(product_id, supplier_id) WHERE is_deleted = 0;
CREATE INDEX idx_product_suppliers_supplier ON product_suppliers(supplier_id) WHERE is_deleted = 0;

-- =====================================================================
-- 5. STOCK
-- =====================================================================
-- A batch is stock that arrived together at one branch, carrying its own
-- cost and its own selling price. Keeping price on the BATCH (not just the
-- product) is what makes FIFO valuation, per-branch pricing and
-- "this carton costs more because the exchange rate moved" all work
-- without a separate costing engine.
CREATE TABLE stock_batches (
    id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id       TEXT NOT NULL REFERENCES business_units(id),
    branch_id              TEXT NOT NULL REFERENCES branches(id),
    product_id             TEXT NOT NULL REFERENCES products(id),
    batch_no               TEXT,
    supplier_id            TEXT REFERENCES suppliers(id),
    purchase_order_id      TEXT REFERENCES purchase_orders(id),
    transfer_id            TEXT REFERENCES stock_transfers(id),   -- set when this batch was created by an inbound transfer

    quantity_received      REAL NOT NULL DEFAULT 0,        -- base units
    quantity_remaining     REAL NOT NULL DEFAULT 0,        -- base units; the authoritative on-hand figure
    quantity_reserved      REAL NOT NULL DEFAULT 0,        -- base units held by layaway/delivery/instalment

    unit_cost              REAL NOT NULL DEFAULT 0,        -- FULL precision, never rounded to kobo: rounding
                                                           -- 480,000/7,000 to 68.57 and multiplying back gives
                                                           -- 479,990, valuing stock ₦10 below what was paid,
                                                           -- on every delivery, forever. Display rounds.
    total_cost             REAL NOT NULL DEFAULT 0,
    selling_price_per_unit REAL NOT NULL DEFAULT 0,        -- base unit price of record for THIS stock
    pack_price             REAL,
    carton_price           REAL,
    pallet_price           REAL,

    received_at            TEXT NOT NULL DEFAULT (datetime('now')),
    received_by            TEXT REFERENCES users(id),
    expiry_date            TEXT,                           -- only when the product/category tracks expiry
    manufacture_date       TEXT,
    status                 TEXT NOT NULL CHECK (status IN ('ACTIVE','DEPLETED','EXPIRED','QUARANTINED','RECALLED','RETURNED_TO_SUPPLIER')) DEFAULT 'ACTIVE',
    notes                  TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted             INTEGER NOT NULL DEFAULT 0,

    -- A batch can never claim to hold less than it has committed. These
    -- CHECKs are the last line of defence against negative stock, which is
    -- the single failure that makes every downstream report lie.
    CHECK (quantity_remaining >= 0),
    CHECK (quantity_reserved  >= 0),
    CHECK (quantity_received  >= 0)
);
CREATE INDEX idx_stock_batches_branch      ON stock_batches(branch_id) WHERE is_deleted = 0;
CREATE INDEX idx_stock_batches_product     ON stock_batches(product_id) WHERE is_deleted = 0;
CREATE INDEX idx_stock_batches_branch_prod ON stock_batches(branch_id, product_id) WHERE is_deleted = 0 AND quantity_remaining > 0;
CREATE INDEX idx_stock_batches_expiry      ON stock_batches(expiry_date) WHERE is_deleted = 0;
CREATE INDEX idx_stock_batches_bu          ON stock_batches(business_unit_id) WHERE is_deleted = 0;

-- SERIALISED ITEMS — one row per physical unit.
-- For electronics this is the IMEI/serial and it is the strongest
-- anti-theft control in the whole product: an item can only be sold once,
-- a returned item is matched to the serial that left, and a serial that
-- appears at a branch it was never transferred to is a red flag on its
-- own. For furniture it is the asset tag on a made-to-order piece; for a
-- generator dealer it is the engine number a customer will quote for
-- warranty years later.
CREATE TABLE product_serials (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),   -- where it physically is right now
    serial_no         TEXT NOT NULL,
    imei              TEXT,
    imei2             TEXT,
    model_variant     TEXT,
    colour            TEXT,
    status            TEXT NOT NULL CHECK (status IN (
                          'IN_STOCK','RESERVED','ON_HOLD','SOLD','RETURNED','DEFECTIVE',
                          'IN_TRANSIT','WARRANTY_REPAIR','SCRAPPED','LOST','DEMO_UNIT'
                      )) DEFAULT 'IN_STOCK',
    sale_id           TEXT REFERENCES sales(id),
    sale_item_id      TEXT REFERENCES sale_items(id),
    purchase_order_id TEXT REFERENCES purchase_orders(id),
    warranty_id       TEXT REFERENCES product_warranties(id),
    cost_price        REAL,
    received_at       TEXT NOT NULL DEFAULT (datetime('now')),
    received_by       TEXT REFERENCES users(id),
    sold_at           TEXT,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    -- A serial is globally unique within a business. This is the
    -- constraint that stops the same phone being sold twice.
    UNIQUE (business_unit_id, serial_no)
);
CREATE INDEX idx_serials_product  ON product_serials(product_id) WHERE is_deleted = 0;
CREATE INDEX idx_serials_branch   ON product_serials(branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_serials_batch    ON product_serials(stock_batch_id) WHERE is_deleted = 0;
CREATE INDEX idx_serials_imei     ON product_serials(imei) WHERE imei IS NOT NULL AND is_deleted = 0;
CREATE INDEX idx_serials_status   ON product_serials(business_unit_id, status) WHERE is_deleted = 0;

-- WARRANTY TERMS per serial (or per sale line for non-serialised goods).
CREATE TABLE product_warranties (
    id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id   TEXT NOT NULL REFERENCES business_units(id),
    serial_id          TEXT REFERENCES product_serials(id),
    product_id         TEXT NOT NULL REFERENCES products(id),
    sale_id            TEXT REFERENCES sales(id),
    sale_item_id       TEXT REFERENCES sale_items(id),
    customer_id        TEXT REFERENCES customers(id),
    branch_id          TEXT NOT NULL REFERENCES branches(id),
    warranty_type      TEXT NOT NULL CHECK (warranty_type IN ('MANUFACTURER','VENDOR','EXTENDED','WORKMANSHIP','INSTALLATION')) DEFAULT 'VENDOR',
    months             INTEGER NOT NULL DEFAULT 12,
    starts_at          TEXT NOT NULL,                    -- usually the sale date
    ends_at            TEXT NOT NULL,
    terms              TEXT,
    provider_name      TEXT,                             -- manufacturer / third-party service agent
    provider_phone     TEXT,
    status             TEXT NOT NULL CHECK (status IN ('ACTIVE','EXPIRED','VOIDED','CLAIMED','REPLACED')) DEFAULT 'ACTIVE',
    void_reason        TEXT,
    registered_by      TEXT REFERENCES users(id),
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_warranties_serial   ON product_warranties(serial_id) WHERE is_deleted = 0;
CREATE INDEX idx_warranties_customer ON product_warranties(customer_id) WHERE is_deleted = 0;
CREATE INDEX idx_warranties_ends     ON product_warranties(ends_at, status) WHERE is_deleted = 0;

-- WARRANTY CLAIMS. The reason a warranty register matters commercially:
-- a claim is a cost, and if the same brand fails three times in a quarter
-- the owner needs to stop stocking it.
CREATE TABLE warranty_claims (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    warranty_id       TEXT NOT NULL REFERENCES product_warranties(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    customer_id       TEXT REFERENCES customers(id),
    claim_no          TEXT NOT NULL,
    fault_description TEXT NOT NULL,
    fault_type        TEXT NOT NULL CHECK (fault_type IN ('MANUFACTURING','INSTALLATION','MISUSE','ACCIDENTAL_DAMAGE','WATER_DAMAGE','POWER_SURGE','SOFTWARE','UNKNOWN')) DEFAULT 'UNKNOWN',
    status            TEXT NOT NULL CHECK (status IN ('LOGGED','ASSESSED','APPROVED','REJECTED','REPAIRING','WITH_PROVIDER','REPLACED','REFUNDED','CLOSED')) DEFAULT 'LOGGED',
    outcome           TEXT NOT NULL CHECK (outcome IN ('PENDING','REPAIR','REPLACE','REFUND','REJECT')) DEFAULT 'PENDING',
    assessed_by       TEXT REFERENCES users(id),
    assessment_note   TEXT,
    repair_cost       REAL NOT NULL DEFAULT 0,
    recovered_from_provider REAL NOT NULL DEFAULT 0,     -- what the manufacturer reimbursed
    replacement_sale_id TEXT REFERENCES sales(id),
    refund_amount     REAL NOT NULL DEFAULT 0,
    logged_at         TEXT NOT NULL DEFAULT (datetime('now')),
    logged_by         TEXT REFERENCES users(id),
    closed_at         TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, claim_no)
);
CREATE INDEX idx_warranty_claims_warranty ON warranty_claims(warranty_id) WHERE is_deleted = 0;
CREATE INDEX idx_warranty_claims_status   ON warranty_claims(business_unit_id, status) WHERE is_deleted = 0;

-- STOCK MOVEMENTS — the single append-only ledger of every quantity
-- change. Stock levels are a CACHE of this table; when they disagree,
-- this table wins. Every movement carries the reason, the actor, the
-- branch and the device, which is what makes "where did this go?"
-- answerable months later.
CREATE TABLE stock_movements (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    serial_id         TEXT REFERENCES product_serials(id),
    direction         TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
    quantity          REAL NOT NULL CHECK (quantity > 0),  -- always positive; direction carries the sign
    unit_cost         REAL,
    movement_type     TEXT NOT NULL CHECK (movement_type IN (
                          'PURCHASE_RECEIPT','TRANSFER_IN','TRANSFER_OUT','SALE','SALE_VOID','SALE_RETURN',
                          'ADJUSTMENT_DAMAGE','ADJUSTMENT_LOSS','ADJUSTMENT_THEFT','ADJUSTMENT_FOUND',
                          'ADJUSTMENT_EXPIRY','ADJUSTMENT_CORRECTION','STOCKTAKE_VARIANCE','WARRANTY_REPLACEMENT',
                          'WARRANTY_RETURN','SUPPLIER_RETURN','SCRAP','LAYAWAY_RELEASE','SAMPLE','DEMO_UNIT'
                      )),
    source_type       TEXT,                              -- 'SALE','TRANSFER','STOCKTAKE','ADJUSTMENT','WARRANTY_CLAIM'
    source_id         TEXT,
    reference         TEXT,                              -- human-readable: receipt no., invoice no.
    balance_after     REAL NOT NULL,                     -- running qty_remaining for this branch+product
    reason            TEXT,
    performed_by      TEXT REFERENCES users(id),
    device_id         TEXT,
    occurred_at       TEXT NOT NULL DEFAULT (datetime('now')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_movements_branch_product ON stock_movements(branch_id, product_id, occurred_at);
CREATE INDEX idx_movements_bu_date        ON stock_movements(business_unit_id, occurred_at);
CREATE INDEX idx_movements_type           ON stock_movements(movement_type, occurred_at);
CREATE INDEX idx_movements_source         ON stock_movements(source_type, source_id);
CREATE INDEX idx_movements_batch          ON stock_movements(stock_batch_id);

-- STOCK RESERVATIONS — one mechanism behind three flows: a layaway hold, a
-- delivery job awaiting dispatch, and an instalment item the customer has
-- taken possession of but not finished paying for (where the shop keeps
-- title). Reserved quantity is excluded from "available to sell" so two
-- cashiers cannot both promise the last television.
CREATE TABLE stock_reservations (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    serial_id         TEXT REFERENCES product_serials(id),
    quantity          REAL NOT NULL CHECK (quantity > 0),
    source_type       TEXT NOT NULL CHECK (source_type IN ('LAYAWAY','DELIVERY_JOB','PAYMENT_PLAN','SALE_HOLD','PURCHASE_ORDER')),
    source_id         TEXT NOT NULL,
    customer_id       TEXT REFERENCES customers(id),
    status            TEXT NOT NULL CHECK (status IN ('ACTIVE','RELEASED','EXPIRED','CANCELLED','FULFILLED')) DEFAULT 'ACTIVE',
    expires_at        TEXT,
    reserved_by       TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_reservations_active_serial
    ON stock_reservations(serial_id) WHERE status = 'ACTIVE' AND serial_id IS NOT NULL AND is_deleted = 0;
CREATE INDEX idx_reservations_source ON stock_reservations(source_type, source_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_reservations_branch ON stock_reservations(branch_id, product_id, status) WHERE is_deleted = 0;

-- =====================================================================
-- 6. PURCHASING
-- =====================================================================
CREATE TABLE purchase_orders (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    po_number         TEXT NOT NULL,
    supplier_id       TEXT REFERENCES suppliers(id),
    status            TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING','APPROVED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')) DEFAULT 'DRAFT',
    ordered_by        TEXT REFERENCES users(id),
    approved_by       TEXT REFERENCES users(id),
    approved_at       TEXT,
    ordered_at        TEXT NOT NULL DEFAULT (datetime('now')),
    expected_at       TEXT,
    currency          TEXT NOT NULL DEFAULT 'NGN',
    exchange_rate     REAL NOT NULL DEFAULT 1,           -- for USD/CNY-sourced imports: the rate is a fact of
                                                         -- the purchase, not a setting that can change later
    subtotal          REAL NOT NULL DEFAULT 0,
    freight_cost      REAL NOT NULL DEFAULT 0,           -- landed cost matters for importers; excluding it
    clearing_cost     REAL NOT NULL DEFAULT 0,           -- understates every margin on imported goods
    other_cost        REAL NOT NULL DEFAULT 0,
    total_cost        REAL NOT NULL DEFAULT 0,
    wht_rate_code     TEXT,
    wht_amount        REAL NOT NULL DEFAULT 0,
    payable_amount    REAL NOT NULL DEFAULT 0,
    payment_status    TEXT NOT NULL CHECK (payment_status IN ('UNPAID','PART_PAID','PAID')) DEFAULT 'UNPAID',
    amount_paid       REAL NOT NULL DEFAULT 0,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, po_number)
);
CREATE INDEX idx_po_branch ON purchase_orders(branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id) WHERE is_deleted = 0;

CREATE TABLE purchase_order_items (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    purchase_order_id   TEXT NOT NULL REFERENCES purchase_orders(id),
    business_unit_id    TEXT NOT NULL REFERENCES business_units(id),
    product_id          TEXT NOT NULL REFERENCES products(id),
    quantity_ordered    REAL NOT NULL CHECK (quantity_ordered > 0),
    quantity_received   REAL NOT NULL DEFAULT 0,
    order_unit          TEXT NOT NULL CHECK (order_unit IN ('BASE_UNIT','PACK','CARTON','PALLET')) DEFAULT 'BASE_UNIT',
    -- PARTIAL RECEIVING. A supplier shipping only part of an order is the
    -- norm in Nigerian wholesale ("60 of the 100 arrived today, the rest
    -- next week"), so all-or-nothing receiving is unusable. The status
    -- PARTIALLY_RECEIVED must be REACHABLE, which is the gap a production
    -- audit found in the original design.
    expected_unit_cost  REAL,
    total_line_cost     REAL,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0,
    CHECK (quantity_received >= 0),
    CHECK (quantity_received <= quantity_ordered)
);
CREATE INDEX idx_po_items_po ON purchase_order_items(purchase_order_id) WHERE is_deleted = 0;

CREATE TABLE purchase_order_receipts (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    purchase_order_id   TEXT NOT NULL REFERENCES purchase_orders(id),
    purchase_order_item_id TEXT NOT NULL REFERENCES purchase_order_items(id),
    business_unit_id    TEXT NOT NULL REFERENCES business_units(id),
    branch_id           TEXT NOT NULL REFERENCES branches(id),
    stock_batch_id      TEXT REFERENCES stock_batches(id),
    quantity_received   REAL NOT NULL CHECK (quantity_received > 0),
    receive_unit        TEXT NOT NULL CHECK (receive_unit IN ('BASE_UNIT','PACK','CARTON','PALLET')) DEFAULT 'BASE_UNIT',
    pieces_received     REAL NOT NULL,                   -- resolved base units
    unit_cost           REAL NOT NULL DEFAULT 0,
    total_cost          REAL NOT NULL DEFAULT 0,
    selling_price       REAL,
    batch_no            TEXT,
    expiry_date         TEXT,
    grn_number          TEXT,                            -- goods-received note quoted to the supplier
    received_by         TEXT REFERENCES users(id),
    received_at         TEXT NOT NULL DEFAULT (datetime('now')),
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_po_receipts_po ON purchase_order_receipts(purchase_order_id);
CREATE INDEX idx_po_receipts_branch ON purchase_order_receipts(branch_id, received_at);

-- =====================================================================
-- 7. CUSTOMERS, CREDIT, TIERS
-- =====================================================================
CREATE TABLE customers (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    home_branch_id    TEXT REFERENCES branches(id),      -- which branch "owns" the relationship
    customer_code     TEXT,
    first_name        TEXT,
    last_name         TEXT,
    full_name         TEXT NOT NULL,
    customer_type     TEXT NOT NULL CHECK (customer_type IN ('WALK_IN','RETAIL','WHOLESALE','DISTRIBUTOR','SUB_DEALER','CORPORATE','GOVERNMENT','CONTRACTOR','PROJECT','HOSPITAL','RESERVED')) DEFAULT 'RETAIL',
    tier_id           TEXT REFERENCES price_tiers(id),
    phone             TEXT,                              -- normalised +234XXXXXXXXXX
    phone_national    TEXT,                              -- 0803... as displayed locally
    alt_phone         TEXT,
    email             TEXT,
    address           TEXT,
    state             TEXT,
    lga               TEXT,
    city              TEXT,
    -- Delivery details separate from billing: a contractor bills to an
    -- office in Ikeja and takes delivery at a site in Lekki.
    delivery_address  TEXT,
    delivery_state    TEXT,
    delivery_city     TEXT,
    delivery_landmark TEXT,
    delivery_instructions TEXT,

    rc_number         TEXT,
    tin               TEXT,
    company_name      TEXT,
    contact_person    TEXT,
    occupation        TEXT,
    gender            TEXT CHECK (gender IS NULL OR gender IN ('MALE','FEMALE','OTHER','PREFER_NOT_TO_SAY')),
    date_of_birth     TEXT,
    id_type           TEXT CHECK (id_type IS NULL OR id_type IN ('NIN','BVN','DRIVERS_LICENSE','INTL_PASSPORT','VOTERS_CARD','CAC','WORK_ID','OTHER')),
    id_number         TEXT,
    -- KYC is only demanded when it is needed: credit, instalments and
    -- regulated goods. Making every walk-in buyer produce a BVN would kill
    -- the counter, so it is a per-flow requirement, not a global one.
    kyc_status        TEXT NOT NULL CHECK (kyc_status IN ('NOT_REQUIRED','PENDING','VERIFIED','FAILED')) DEFAULT 'NOT_REQUIRED',
    kyc_verified_at   TEXT,
    kyc_verified_by   TEXT REFERENCES users(id),

    credit_enabled    INTEGER NOT NULL DEFAULT 0,
    credit_limit      REAL NOT NULL DEFAULT 0,
    credit_days       INTEGER NOT NULL DEFAULT 30,       -- payment terms
    -- Set by the OWNER/MANAGER as a hard stop. A branch-level override is
    -- recorded per sale (sales.credit_limit_overridden_by) so an override
    -- is always attributable to a named person rather than being a
    -- quiet escalation of the cashier's authority.
    loyalty_points    INTEGER NOT NULL DEFAULT 0,
    total_purchases   REAL NOT NULL DEFAULT 0,
    purchase_count    INTEGER NOT NULL DEFAULT 0,
    last_purchase_at  TEXT,
    notes             TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_customers_bu      ON customers(business_unit_id) WHERE is_deleted = 0;
CREATE INDEX idx_customers_phone   ON customers(phone) WHERE is_deleted = 0;
CREATE INDEX idx_customers_name    ON customers(business_unit_id, full_name) WHERE is_deleted = 0;
CREATE INDEX idx_customers_branch  ON customers(home_branch_id) WHERE is_deleted = 0;
CREATE INDEX idx_customers_tier    ON customers(tier_id) WHERE is_deleted = 0;
-- A phone number may belong to only one ACTIVE customer per business.
-- Without this, one subscriber accumulates two debtor records and defeats
-- their own credit limit — reproduced in the PharmaRidge sync audit as a
-- cross-branch customer hijack.
CREATE UNIQUE INDEX idx_customers_unique_phone
    ON customers(business_unit_id, phone) WHERE phone IS NOT NULL AND is_deleted = 0 AND is_active = 1;

-- DEBTOR LEDGER — what customers owe us. Append-only: balances are
-- derived, never stored, because a stored balance can drift from its own
-- entries and then nobody knows which is true.
CREATE TABLE debtor_ledger (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    customer_id       TEXT NOT NULL REFERENCES customers(id),
    entry_date        TEXT NOT NULL,
    entry_type        TEXT NOT NULL CHECK (entry_type IN ('SALE','PAYMENT','DEBIT_NOTE','CREDIT_NOTE','ADJUSTMENT','WRITE_OFF','REFUND','INTEREST','PLAN_INSTALMENT')),
    source_type       TEXT,
    source_id         TEXT,
    reference         TEXT,
    amount            REAL NOT NULL,                     -- positive = they owe more, negative = they owe less
    balance_after     REAL NOT NULL,                     -- denormalised running total for fast aging queries
    notes             TEXT,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_debtor_customer ON debtor_ledger(customer_id, entry_date);
CREATE INDEX idx_debtor_branch   ON debtor_ledger(branch_id, entry_date);
CREATE INDEX idx_debtor_bu       ON debtor_ledger(business_unit_id, entry_date);

-- CREDITOR LEDGER — what we owe suppliers.
CREATE TABLE creditor_ledger (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    supplier_id       TEXT NOT NULL REFERENCES suppliers(id),
    entry_date        TEXT NOT NULL,
    entry_type        TEXT NOT NULL CHECK (entry_type IN ('PURCHASE','PAYMENT','DEBIT_NOTE','CREDIT_NOTE','ADJUSTMENT','WHT_DEDUCTED','FREIGHT','REFUND')),
    source_type       TEXT,
    source_id         TEXT,
    reference         TEXT,
    amount            REAL NOT NULL,
    balance_after     REAL NOT NULL,
    wht_amount        REAL NOT NULL DEFAULT 0,
    notes             TEXT,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_creditor_supplier ON creditor_ledger(supplier_id, entry_date);
CREATE INDEX idx_creditor_branch   ON creditor_ledger(branch_id, entry_date);

-- CHANGE OWED — the till had no small notes.
-- A real and constant Nigerian retail problem, and one that silently
-- destroys cash control if it is not recorded: a customer pays ₦5,000 for
-- a ₦4,700 item, the drawer has no ₦300, and the cashier says "come back
-- later". Without a register, that ₦300 is either an unrecorded liability
-- or a quiet write-off. With a claim code, the customer can collect at any
-- branch and the till reconciles to the kobo.
CREATE TABLE change_owed (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    sale_id           TEXT REFERENCES sales(id),
    customer_id       TEXT REFERENCES customers(id),
    customer_name     TEXT,
    customer_phone    TEXT,
    claim_code        TEXT NOT NULL UNIQUE,              -- read aloud / printed on the receipt
    amount            REAL NOT NULL CHECK (amount > 0),
    reason            TEXT NOT NULL CHECK (reason IN ('NO_SMALL_CHANGE','CUSTOMER_LEFT','SYSTEM_ROUNDING','OTHER')) DEFAULT 'NO_SMALL_CHANGE',
    status            TEXT NOT NULL CHECK (status IN ('OUTSTANDING','PAID','FORFEITED','WRITTEN_OFF')) DEFAULT 'OUTSTANDING',
    paid_at           TEXT,
    paid_branch_id    TEXT REFERENCES branches(id),
    paid_by           TEXT REFERENCES users(id),
    payment_method    TEXT,
    till_session_id   TEXT REFERENCES till_sessions(id),
    expires_at        TEXT,
    notes             TEXT,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_change_owed_name   ON change_owed(customer_name) WHERE status = 'OUTSTANDING' AND is_deleted = 0;
CREATE INDEX idx_change_owed_phone  ON change_owed(customer_phone) WHERE status = 'OUTSTANDING' AND is_deleted = 0;
CREATE INDEX idx_change_owed_branch ON change_owed(branch_id, status, created_at);
CREATE INDEX idx_change_owed_sale   ON change_owed(sale_id);

-- BRANCH SAFE — reserve cash separate from the till float.
-- Started manager-only in PharmaRidge because a cashier moving the reserve
-- unsupervised is the classic shrinkage route, but that made a real job
-- impossible: the cashier sent to buy stock the drawer cannot cover had to
-- find a manager first, and shops do not work that way. Resolved the same
-- way as voids and write-offs — a NARROW OWNER-SET ALLOWANCE
-- (business_units.staff_can_spend_from_safe / staff_safe_spend_max).
CREATE TABLE branch_safe_ledger (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    entry_type        TEXT NOT NULL CHECK (entry_type IN ('OPENING_BALANCE','DEPOSIT_FROM_TILL','WITHDRAWAL_TO_TILL','BANK_DEPOSIT','PURCHASE_PAYMENT','EXPENSE_PAYMENT','TILL_FLOAT_ISSUE','ADJUSTMENT','COUNT_CORRECTION')),
    amount            REAL NOT NULL,                     -- positive = money into the safe
    balance_after     REAL NOT NULL,
    source_type       TEXT,
    source_id         TEXT,
    reference         TEXT,
    reason            TEXT,
    approved_by       TEXT REFERENCES users(id),
    performed_by      TEXT REFERENCES users(id),
    till_session_id   TEXT REFERENCES till_sessions(id),
    occurred_at       TEXT NOT NULL DEFAULT (datetime('now')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_branch_safe_branch ON branch_safe_ledger(branch_id, occurred_at);
CREATE INDEX idx_branch_safe_source ON branch_safe_ledger(source_type, source_id);

-- =====================================================================
-- 8. SALES  (POS)
-- =====================================================================
CREATE TABLE sales (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    receipt_no        TEXT NOT NULL,                     -- SR-<BRANCH>-<YYYY>-<seq>
    invoice_no        TEXT,                              -- issued for credit/wholesale/corporate sales
    till_session_id   TEXT REFERENCES till_sessions(id),
    customer_id       TEXT REFERENCES customers(id),
    customer_snapshot_json TEXT,                         -- name/phone/tier at the time of sale, so a later
                                                         -- customer edit cannot rewrite history
    sale_type         TEXT NOT NULL CHECK (sale_type IN ('RETAIL','WHOLESALE','CREDIT','INSTALLMENT','LAYAWAY_RELEASE','INTERNAL','RETURN','EXCHANGE')) DEFAULT 'RETAIL',
    tier_id           TEXT REFERENCES price_tiers(id),
    status            TEXT NOT NULL CHECK (status IN ('COMPLETED','VOIDED','PARTIALLY_REFUNDED','REFUNDED','PENDING_PAYMENT')) DEFAULT 'COMPLETED',

    subtotal          REAL NOT NULL DEFAULT 0,           -- before discount, after line discounts
    discount_amount   REAL NOT NULL DEFAULT 0,
    discount_percent  REAL NOT NULL DEFAULT 0,
    discount_reason   TEXT,
    discount_approved_by TEXT REFERENCES users(id),
    taxable_amount    REAL NOT NULL DEFAULT 0,
    vat_amount        REAL NOT NULL DEFAULT 0,           -- EXTRACTED from total when vat_inclusive_pricing
    total             REAL NOT NULL DEFAULT 0,
    amount_paid       REAL NOT NULL DEFAULT 0,
    balance_due       REAL NOT NULL DEFAULT 0,
    change_given      REAL NOT NULL DEFAULT 0,

    -- CREDIT
    is_credit_sale    INTEGER NOT NULL DEFAULT 0,
    due_date          TEXT,
    credit_limit_overridden_by TEXT REFERENCES users(id),
    credit_override_reason TEXT,

    -- LINKS TO THE OTHER FLOWS
    payment_plan_id   TEXT REFERENCES payment_plans(id),
    layaway_hold_id   TEXT REFERENCES layaway_holds(id),
    delivery_job_id   TEXT REFERENCES delivery_jobs(id),

    voided_at         TEXT,
    voided_by         TEXT REFERENCES users(id),
    void_reason       TEXT,
    refund_of_sale_id TEXT REFERENCES sales(id),

    sold_by           TEXT NOT NULL REFERENCES users(id),
    device_id         TEXT,
    -- Offline-created sales carry the device's own timestamp and are
    -- reconciled against it on sync; `created_at` stays the SERVER's
    -- opinion of when the row arrived, so a queue replaying three days
    -- later cannot backdate its way into a closed till session.
    occurred_at       TEXT NOT NULL DEFAULT (datetime('now')),
    client_created_at TEXT,
    sync_status       TEXT NOT NULL CHECK (sync_status IN ('LOCAL','SYNCED','CONFLICT')) DEFAULT 'SYNCED',
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_sales_receipt ON sales(business_unit_id, receipt_no) WHERE is_deleted = 0;
CREATE INDEX idx_sales_branch   ON sales(branch_id, occurred_at);
CREATE INDEX idx_sales_bu_date  ON sales(business_unit_id, occurred_at);
CREATE INDEX idx_sales_customer ON sales(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_sales_status   ON sales(business_unit_id, status, occurred_at);
CREATE INDEX idx_sales_sold_by  ON sales(sold_by, occurred_at);
CREATE INDEX idx_sales_plan     ON sales(payment_plan_id) WHERE payment_plan_id IS NOT NULL;

CREATE TABLE sale_items (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    sale_id           TEXT NOT NULL REFERENCES sales(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    category_id       TEXT REFERENCES product_categories(id),  -- denormalised at sale time for category P&L
    line_no           INTEGER NOT NULL DEFAULT 1,

    -- THE [UOM] DESIGN: sell by carton, decrement stock in base units.
    unit_type         TEXT NOT NULL CHECK (unit_type IN ('BASE_UNIT','PACK','CARTON','PALLET')) DEFAULT 'BASE_UNIT',
    quantity          REAL NOT NULL CHECK (quantity > 0),  -- in unit_type terms, as the customer asked
    pieces_per_unit   REAL NOT NULL DEFAULT 1,             -- conversion applied
    quantity_base     REAL NOT NULL CHECK (quantity_base > 0),  -- authoritative stock decrement

    unit_price        REAL NOT NULL DEFAULT 0,             -- per unit_type
    unit_cost         REAL NOT NULL DEFAULT 0,             -- per base unit, FULL precision
    line_subtotal     REAL NOT NULL DEFAULT 0,
    discount_amount   REAL NOT NULL DEFAULT 0,
    discount_percent  REAL NOT NULL DEFAULT 0,
    discount_reason   TEXT,
    line_total        REAL NOT NULL DEFAULT 0,
    vat_amount        REAL NOT NULL DEFAULT 0,
    gross_margin      REAL NOT NULL DEFAULT 0,
    gross_margin_percent REAL NOT NULL DEFAULT 0,

    tier_id           TEXT REFERENCES price_tiers(id),
    price_source      TEXT NOT NULL CHECK (price_source IN ('BATCH','BRANCH_OVERRIDE','TIER','MANUAL','PROMOTION','COST_PLUS')) DEFAULT 'BATCH',
    promotion_id      TEXT REFERENCES promotions(id),

    -- Services and non-stock lines: installation labour, delivery fee, a
    -- bespoke fabrication charge. These must be sellable without a product
    -- row, or the shop rings them up as "miscellaneous ₦5000" and the P&L
    -- loses the revenue category entirely.
    is_service_line   INTEGER NOT NULL DEFAULT 0,
    service_type      TEXT CHECK (service_type IS NULL OR service_type IN ('DELIVERY','INSTALLATION','ASSEMBLY','REPAIR','FABRICATION','OTHER')),

    serial_ids_json   TEXT,                                -- which physical units left the shop
    warranty_ids_json TEXT,
    item_notes        TEXT,
    is_refunded       INTEGER NOT NULL DEFAULT 0,
    refunded_quantity REAL NOT NULL DEFAULT 0,
    refunded_amount   REAL NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sale_items_sale     ON sale_items(sale_id) WHERE is_deleted = 0;
CREATE INDEX idx_sale_items_product  ON sale_items(product_id, sale_id) WHERE is_deleted = 0;
CREATE INDEX idx_sale_items_batch    ON sale_items(stock_batch_id);
CREATE INDEX idx_sale_items_category ON sale_items(category_id, sale_id) WHERE is_deleted = 0;

-- PAYMENTS — split tenders are the norm, not the exception: part cash,
-- part POS transfer, part a bank transfer the customer shows a screenshot
-- of. Recording one method per sale makes reconciliation impossible.
CREATE TABLE sale_payments (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    sale_id           TEXT NOT NULL REFERENCES sales(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    till_session_id   TEXT REFERENCES till_sessions(id),
    method            TEXT NOT NULL CHECK (method IN (
                          'CASH','POS_TERMINAL','BANK_TRANSFER','USSD','MOBILE_MONEY','CHEQUE',
                          'CREDIT','GIFT_VOUCHER','LOYALTY_REDEMPTION','CRYPTO','OTHER'
                      )),
    amount            REAL NOT NULL CHECK (amount > 0),
    currency          TEXT NOT NULL DEFAULT 'NGN',
    -- cash_tendered / change_given are recorded so till reconciliation is
    -- not thrown off by a customer paying with a bigger note than the
    -- total. The drawer's expected CASH is tendered minus change, which is
    -- not the same as the sale's cash component when change was owed.
    cash_tendered     REAL,
    change_given      REAL NOT NULL DEFAULT 0,
    change_owed_id    TEXT REFERENCES change_owed(id),
    reference         TEXT,                              -- POS auth code, transfer narration, cheque no.
    terminal_id       TEXT,
    bank_name         TEXT,
    received_at       TEXT NOT NULL DEFAULT (datetime('now')),
    received_by       TEXT REFERENCES users(id),
    device_id         TEXT,
    status            TEXT NOT NULL CHECK (status IN ('RECEIVED','PENDING_CONFIRMATION','FAILED','REVERSED','REFUNDED')) DEFAULT 'RECEIVED',
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sale_payments_sale   ON sale_payments(sale_id);
CREATE INDEX idx_sale_payments_till   ON sale_payments(till_session_id, method);
CREATE INDEX idx_sale_payments_branch ON sale_payments(branch_id, received_at);

-- Returns. A separate table rather than a negative sale, because a return
-- must reference the original sale and the original serial/batch, must be
-- attributable, and must be able to be partial.
CREATE TABLE sale_returns (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    original_sale_id  TEXT NOT NULL REFERENCES sales(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    return_no         TEXT NOT NULL,
    reason            TEXT NOT NULL CHECK (reason IN ('DEFECTIVE','WRONG_ITEM','CUSTOMER_CHANGED_MIND','DAMAGED_IN_TRANSIT','WARRANTY_FAULT','PRICE_DISPUTE','OTHER')),
    reason_detail     TEXT,
    status            TEXT NOT NULL CHECK (status IN ('APPROVED','PENDING_APPROVAL','REJECTED','COMPLETED')) DEFAULT 'PENDING_APPROVAL',
    restock           INTEGER NOT NULL DEFAULT 1,        -- does the item go back on the shelf?
    restock_batch_id  TEXT REFERENCES stock_batches(id),
    refund_method     TEXT CHECK (refund_method IS NULL OR refund_method IN ('CASH','BANK_TRANSFER','STORE_CREDIT','REPLACEMENT','POS_REVERSAL')),
    refund_amount     REAL NOT NULL DEFAULT 0,
    store_credit_amount REAL NOT NULL DEFAULT 0,
    approved_by       TEXT REFERENCES users(id),
    approved_at       TEXT,
    processed_by      TEXT REFERENCES users(id),
    processed_at      TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, return_no)
);
CREATE INDEX idx_sale_returns_sale ON sale_returns(original_sale_id) WHERE is_deleted = 0;

CREATE TABLE sale_return_items (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_return_id    TEXT NOT NULL REFERENCES sale_returns(id),
    sale_item_id      TEXT NOT NULL REFERENCES sale_items(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    serial_id         TEXT REFERENCES product_serials(id),
    quantity          REAL NOT NULL CHECK (quantity > 0),
    unit_price        REAL NOT NULL DEFAULT 0,
    refund_amount     REAL NOT NULL DEFAULT 0,
    condition         TEXT NOT NULL CHECK (condition IN ('RESALABLE','DAMAGED','DEFECTIVE','MISSING_PARTS','OPENED')) DEFAULT 'RESALABLE',
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_return_items_return ON sale_return_items(sale_return_id) WHERE is_deleted = 0;

-- Delivery requirements captured at the point of sale, so the cashier
-- never has to phone the warehouse separately.
CREATE TABLE sale_delivery_requirements (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id           TEXT NOT NULL REFERENCES sales(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    delivery_job_id   TEXT REFERENCES delivery_jobs(id),
    requires_delivery INTEGER NOT NULL DEFAULT 0,
    requires_installation INTEGER NOT NULL DEFAULT 0,
    requires_assembly INTEGER NOT NULL DEFAULT 0,
    address           TEXT,
    city              TEXT,
    state             TEXT,
    landmark          TEXT,
    contact_name      TEXT,
    contact_phone     TEXT,
    preferred_date    TEXT,
    preferred_window  TEXT CHECK (preferred_window IS NULL OR preferred_window IN ('MORNING','AFTERNOON','EVENING','ANY')),
    delivery_fee      REAL NOT NULL DEFAULT 0,
    installation_fee  REAL NOT NULL DEFAULT 0,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_sale_delivery_req_sale ON sale_delivery_requirements(sale_id) WHERE is_deleted = 0;

-- =====================================================================
-- 9. PROMOTIONS
-- =====================================================================
CREATE TABLE promotions (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    code              TEXT NOT NULL,
    name              TEXT NOT NULL,
    promo_type        TEXT NOT NULL CHECK (promo_type IN ('PERCENT_OFF','FIXED_AMOUNT_OFF','BUY_N_GET_M','BUNDLE_PRICE','TIER_UNLOCK','FREE_DELIVERY')) DEFAULT 'PERCENT_OFF',
    value             REAL NOT NULL DEFAULT 0,           -- percent, amount, or N for BUY_N_GET_M
    value2            REAL,                              -- M for BUY_N_GET_M, or bundle price
    applies_to        TEXT NOT NULL CHECK (applies_to IN ('ALL','CATEGORY','PRODUCT','BRAND','TIER')) DEFAULT 'ALL',
    scope_ids_json    TEXT,                              -- category/product/brand ids in scope
    branch_ids_json   TEXT,                              -- NULL/empty = all branches
    customer_tier_ids_json TEXT,
    min_quantity      REAL NOT NULL DEFAULT 1,
    min_cart_value    REAL NOT NULL DEFAULT 0,
    max_uses_total    INTEGER,
    max_uses_per_customer INTEGER,
    used_count        INTEGER NOT NULL DEFAULT 0,
    stackable         INTEGER NOT NULL DEFAULT 0,
    starts_at         TEXT NOT NULL,
    ends_at           TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','PAUSED','EXPIRED','EXHAUSTED')) DEFAULT 'DRAFT',
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, code)
);
CREATE INDEX idx_promotions_active ON promotions(business_unit_id, status, starts_at, ends_at) WHERE is_deleted = 0;

-- =====================================================================
-- 10. INSTALMENT PLANS  ("Ajo" / work-and-pay / lay-by credit)
-- =====================================================================
-- The most important consumer-credit flow in Nigerian retail: a customer
-- takes a generator, fridge or sofa home and pays over 3-12 months, often
-- weekly. Done on paper it is unenforceable and unauditable; done in the
-- system it produces a schedule, a balance, an aging report and a
-- guarantor record.
CREATE TABLE payment_plans (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    plan_no           TEXT NOT NULL,
    customer_id       TEXT NOT NULL REFERENCES customers(id),
    sale_id           TEXT REFERENCES sales(id),
    plan_type         TEXT NOT NULL CHECK (plan_type IN ('INSTALMENT','WORK_AND_PAY','ESUSU_AJO','LAYBY_CREDIT','STAFF_LOAN')) DEFAULT 'INSTALMENT',
    status            TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','COMPLETED','DEFAULTED','CANCELLED','RESTRUCTURED','WRITTEN_OFF')) DEFAULT 'DRAFT',

    principal         REAL NOT NULL CHECK (principal >= 0),
    deposit_amount    REAL NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
    interest_percent  REAL NOT NULL DEFAULT 0 CHECK (interest_percent >= 0),
    -- FLAT vs REDUCING is the difference the customer actually feels, and
    -- the difference that makes a "0% plan" not 0%. Both are supported and
    -- the effective total is shown to the customer before they sign.
    interest_type     TEXT NOT NULL CHECK (interest_type IN ('NONE','FLAT','REDUCING')) DEFAULT 'NONE',
    total_payable     REAL NOT NULL DEFAULT 0,
    amount_paid       REAL NOT NULL DEFAULT 0,
    balance_due       REAL NOT NULL DEFAULT 0,

    frequency         TEXT NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','FORTNIGHTLY','MONTHLY','QUARTERLY','LUMP_SUM')) DEFAULT 'MONTHLY',
    instalment_count  INTEGER NOT NULL CHECK (instalment_count > 0),
    instalment_amount REAL NOT NULL DEFAULT 0,
    first_due_date    TEXT NOT NULL,
    next_due_date     TEXT,
    last_paid_at      TEXT,
    completed_at      TEXT,

    -- POSSESSION vs TITLE. The single most consequential setting on a plan:
    --   POSSESSION_WITH_TITLE_HELD — customer has the goods, shop keeps
    --                                title until the final payment (the
    --                                normal work-and-pay arrangement).
    --   GOODS_HELD_UNTIL_PAID      — lay-by: goods stay in the shop.
    possession        TEXT NOT NULL CHECK (possession IN ('POSSESSION_WITH_TITLE_HELD','GOODS_HELD_UNTIL_PAID','POSSESSION_AND_TITLE')) DEFAULT 'POSSESSION_WITH_TITLE_HELD',

    guarantor_name    TEXT,
    guarantor_phone   TEXT,
    guarantor_address TEXT,
    guarantor_id_type TEXT,
    guarantor_id_no   TEXT,
    collateral_description TEXT,
    contract_note     TEXT,
    signed_at         TEXT,                              -- customer acknowledgement timestamp
    approved_by       TEXT REFERENCES users(id),
    created_by        TEXT REFERENCES users(id),
    defaulted_at      TEXT,
    default_reason    TEXT,
    written_off_at    TEXT,
    written_off_by    TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, plan_no)
);
CREATE INDEX idx_plans_customer ON payment_plans(customer_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_plans_branch   ON payment_plans(branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_plans_due      ON payment_plans(status, next_due_date) WHERE is_deleted = 0;

-- The schedule. Generated up-front so "how much is left and when?" is a
-- read, not a computation — and so a dispute can be settled against what
-- was agreed on day one rather than what the system thinks today.
CREATE TABLE payment_plan_items (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    payment_plan_id   TEXT NOT NULL REFERENCES payment_plans(id),
    seq               INTEGER NOT NULL,
    product_id        TEXT REFERENCES products(id),
    serial_id         TEXT REFERENCES product_serials(id),
    quantity          REAL NOT NULL DEFAULT 1,
    unit_price        REAL NOT NULL DEFAULT 0,
    line_total        REAL NOT NULL DEFAULT 0,
    due_date          TEXT NOT NULL,
    amount_due        REAL NOT NULL DEFAULT 0,           -- principal + interest share for this instalment
    principal_portion REAL NOT NULL DEFAULT 0,
    interest_portion  REAL NOT NULL DEFAULT 0,
    amount_paid       REAL NOT NULL DEFAULT 0,
    status            TEXT NOT NULL CHECK (status IN ('SCHEDULED','PART_PAID','PAID','OVERDUE','WAIVED','DEFAULTED')) DEFAULT 'SCHEDULED',
    paid_at           TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (payment_plan_id, seq)
);
CREATE INDEX idx_plan_items_plan ON payment_plan_items(payment_plan_id, seq);
CREATE INDEX idx_plan_items_due  ON payment_plan_items(status, due_date) WHERE is_deleted = 0;

CREATE TABLE payment_plan_payments (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    payment_plan_id   TEXT NOT NULL REFERENCES payment_plans(id),
    plan_item_id      TEXT REFERENCES payment_plan_items(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    till_session_id   TEXT REFERENCES till_sessions(id),
    receipt_no        TEXT NOT NULL,
    amount            REAL NOT NULL CHECK (amount > 0),
    principal_applied REAL NOT NULL DEFAULT 0,
    interest_applied  REAL NOT NULL DEFAULT 0,
    penalty_applied   REAL NOT NULL DEFAULT 0,
    method            TEXT NOT NULL CHECK (method IN ('CASH','POS_TERMINAL','BANK_TRANSFER','USSD','MOBILE_MONEY','CHEQUE','OTHER')),
    reference         TEXT,
    collected_by      TEXT REFERENCES users(id),
    device_id         TEXT,
    received_at       TEXT NOT NULL DEFAULT (datetime('now')),
    notes             TEXT,
    reversed_at       TEXT,
    reversed_by       TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_plan_payments_plan ON payment_plan_payments(payment_plan_id, received_at);

-- =====================================================================
-- 11. LAYAWAY / HOLDS
-- =====================================================================
CREATE TABLE layaway_holds (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    hold_no           TEXT NOT NULL,
    customer_id       TEXT NOT NULL REFERENCES customers(id),
    status            TEXT NOT NULL CHECK (status IN ('ACTIVE','COMPLETED','CANCELLED','EXPIRED','FORFEITED')) DEFAULT 'ACTIVE',
    deposit_percent   REAL NOT NULL DEFAULT 20,
    deposit_amount    REAL NOT NULL DEFAULT 0,
    total_amount      REAL NOT NULL DEFAULT 0,
    amount_paid       REAL NOT NULL DEFAULT 0,
    balance_due       REAL NOT NULL DEFAULT 0,
    -- Forfeiture is the commercially sensitive part: a customer who
    -- abandons a hold has paid real money. The policy is explicit and
    -- owner-set rather than left to the cashier's discretion.
    forfeiture_percent REAL NOT NULL DEFAULT 25 CHECK (forfeiture_percent >= 0 AND forfeiture_percent <= 100),
    forfeited_amount  REAL NOT NULL DEFAULT 0,
    refunded_amount   REAL NOT NULL DEFAULT 0,
    expiry_date       TEXT NOT NULL,
    completed_sale_id TEXT REFERENCES sales(id),
    created_by        TEXT REFERENCES users(id),
    cancelled_by      TEXT REFERENCES users(id),
    cancelled_at      TEXT,
    cancellation_reason TEXT,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, hold_no)
);
CREATE INDEX idx_layaway_customer ON layaway_holds(customer_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_layaway_branch   ON layaway_holds(branch_id, status, expiry_date) WHERE is_deleted = 0;

CREATE TABLE layaway_items (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    layaway_hold_id   TEXT NOT NULL REFERENCES layaway_holds(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    serial_id         TEXT REFERENCES product_serials(id),
    quantity          REAL NOT NULL CHECK (quantity > 0),
    unit_price        REAL NOT NULL DEFAULT 0,
    line_total        REAL NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_layaway_items_hold ON layaway_items(layaway_hold_id) WHERE is_deleted = 0;

CREATE TABLE layaway_payments (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    layaway_hold_id   TEXT NOT NULL REFERENCES layaway_holds(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    till_session_id   TEXT REFERENCES till_sessions(id),
    receipt_no        TEXT NOT NULL,
    amount            REAL NOT NULL CHECK (amount > 0),
    kind              TEXT NOT NULL CHECK (kind IN ('DEPOSIT','INSTALMENT','FINAL','REFUND','FORFEITURE')) DEFAULT 'INSTALMENT',
    method            TEXT NOT NULL CHECK (method IN ('CASH','POS_TERMINAL','BANK_TRANSFER','USSD','MOBILE_MONEY','CHEQUE','OTHER')),
    reference         TEXT,
    received_by       TEXT REFERENCES users(id),
    received_at       TEXT NOT NULL DEFAULT (datetime('now')),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_layaway_payments_hold ON layaway_payments(layaway_hold_id, received_at);

-- =====================================================================
-- 12. DELIVERY & INSTALLATION
-- =====================================================================
CREATE TABLE delivery_vehicles (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT REFERENCES branches(id),
    plate_number      TEXT NOT NULL,
    vehicle_type      TEXT NOT NULL CHECK (vehicle_type IN ('BIKE','KEKE','CAR','PICKUP','VAN','TRUCK','FLATBED','THIRD_PARTY')) DEFAULT 'VAN',
    capacity_kg       REAL,
    capacity_volume_m3 REAL,
    driver_name       TEXT,
    driver_phone      TEXT,
    is_third_party    INTEGER NOT NULL DEFAULT 0,
    cost_per_trip     REAL NOT NULL DEFAULT 0,
    cost_per_km       REAL NOT NULL DEFAULT 0,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, plate_number)
);

CREATE TABLE delivery_jobs (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    job_no            TEXT NOT NULL,
    job_type          TEXT NOT NULL CHECK (job_type IN ('DELIVERY','INSTALLATION','DELIVERY_AND_INSTALLATION','ASSEMBLY','SITE_SURVEY','PICKUP','RETURN_COLLECTION')) DEFAULT 'DELIVERY',
    sale_id           TEXT REFERENCES sales(id),
    customer_id       TEXT REFERENCES customers(id),
    status            TEXT NOT NULL CHECK (status IN ('SCHEDULED','ASSIGNED','LOADING','IN_TRANSIT','ARRIVED','COMPLETED','FAILED','CANCELLED','RESCHEDULED')) DEFAULT 'SCHEDULED',
    priority          TEXT NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')) DEFAULT 'NORMAL',

    address           TEXT NOT NULL,
    city              TEXT,
    state             TEXT,
    landmark          TEXT,
    latitude          REAL,
    longitude         REAL,
    contact_name      TEXT,
    contact_phone     TEXT,

    vehicle_id        TEXT REFERENCES delivery_vehicles(id),
    assigned_to       TEXT REFERENCES users(id),         -- driver / installer
    assistant_name    TEXT,
    scheduled_date    TEXT NOT NULL,
    scheduled_window  TEXT CHECK (scheduled_window IS NULL OR scheduled_window IN ('MORNING','AFTERNOON','EVENING','ANY')),
    departed_at       TEXT,
    arrived_at        TEXT,
    completed_at      TEXT,

    distance_km       REAL,
    delivery_fee      REAL NOT NULL DEFAULT 0,
    installation_fee  REAL NOT NULL DEFAULT 0,
    extra_cost        REAL NOT NULL DEFAULT 0,           -- tolls, offloading labour, generator fuel
    total_charge      REAL NOT NULL DEFAULT 0,
    paid_by_customer  INTEGER NOT NULL DEFAULT 1,
    payment_status    TEXT NOT NULL CHECK (payment_status IN ('UNPAID','PAID','WAIVED','PART_PAID')) DEFAULT 'UNPAID',
    amount_collected  REAL NOT NULL DEFAULT 0,

    -- PROOF OF DELIVERY. Without this, "they never delivered" and "they
    -- never signed" are unanswerable, and an unresolved POD dispute on a
    -- ₦1.2m fridge is a bigger loss than the delivery fee.
    pod_received      INTEGER NOT NULL DEFAULT 0,
    pod_signature_data_url TEXT,
    pod_photo_data_url TEXT,
    pod_received_by_name TEXT,
    pod_received_at   TEXT,
    pod_note          TEXT,

    failure_reason    TEXT,
    reschedule_count  INTEGER NOT NULL DEFAULT 0,
    customer_rating   INTEGER CHECK (customer_rating IS NULL OR customer_rating BETWEEN 1 AND 5),
    notes             TEXT,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, job_no)
);
CREATE INDEX idx_delivery_branch_date ON delivery_jobs(branch_id, scheduled_date, status) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_status      ON delivery_jobs(business_unit_id, status, scheduled_date) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_assigned    ON delivery_jobs(assigned_to, scheduled_date) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_sale        ON delivery_jobs(sale_id) WHERE sale_id IS NOT NULL;

CREATE TABLE delivery_job_items (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    delivery_job_id   TEXT NOT NULL REFERENCES delivery_jobs(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    product_id        TEXT REFERENCES products(id),
    sale_item_id      TEXT REFERENCES sale_items(id),
    serial_id         TEXT REFERENCES product_serials(id),
    quantity          REAL NOT NULL DEFAULT 1,
    requires_installation INTEGER NOT NULL DEFAULT 0,
    installed         INTEGER NOT NULL DEFAULT 0,
    installed_at      TEXT,
    condition_on_arrival TEXT CHECK (condition_on_arrival IS NULL OR condition_on_arrival IN ('GOOD','DAMAGED','MISSING','WRONG_ITEM')),
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_delivery_items_job ON delivery_job_items(delivery_job_id) WHERE is_deleted = 0;

-- =====================================================================
-- 13. STOCK TRANSFERS  (inter-branch)
-- =====================================================================
CREATE TABLE stock_transfers (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    transfer_no       TEXT NOT NULL,
    from_branch_id    TEXT NOT NULL REFERENCES branches(id),
    to_branch_id      TEXT NOT NULL REFERENCES branches(id),
    status            TEXT NOT NULL CHECK (status IN ('PENDING','IN_TRANSIT','RECEIVED','PARTIALLY_RECEIVED','CANCELLED','DISCREPANCY')) DEFAULT 'PENDING',
    transfer_type     TEXT NOT NULL CHECK (transfer_type IN ('STOCK_REBALANCE','NEW_BRANCH_STOCK','RETURN_TO_WAREHOUSE','DAMAGE_QUARANTINE','EVENT_STOCK')) DEFAULT 'STOCK_REBALANCE',
    requested_by      TEXT REFERENCES users(id),
    approved_by       TEXT REFERENCES users(id),
    approved_at       TEXT,
    dispatched_by     TEXT REFERENCES users(id),
    dispatched_at     TEXT,
    received_by       TEXT REFERENCES users(id),
    received_at       TEXT,
    -- Valuation basis for the receiving branch. AT_COST keeps group margin
    -- honest; AT_RETAIL would inflate the receiving branch's stock value
    -- with profit that has not been earned. Default AT_COST.
    valuation         TEXT NOT NULL CHECK (valuation IN ('AT_COST','AT_RETAIL')) DEFAULT 'AT_COST',
    total_cost_value  REAL NOT NULL DEFAULT 0,
    total_retail_value REAL NOT NULL DEFAULT 0,
    vehicle_id        TEXT REFERENCES delivery_vehicles(id),
    waybill_no        TEXT,
    discrepancy_note  TEXT,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, transfer_no),
    CHECK (from_branch_id <> to_branch_id)
);
CREATE INDEX idx_transfers_from ON stock_transfers(from_branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_transfers_to   ON stock_transfers(to_branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_transfers_bu   ON stock_transfers(business_unit_id, status, created_at) WHERE is_deleted = 0;

CREATE TABLE stock_transfer_items (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    transfer_id       TEXT NOT NULL REFERENCES stock_transfers(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    from_batch_id     TEXT REFERENCES stock_batches(id),
    to_batch_id       TEXT REFERENCES stock_batches(id),   -- the batch created at the destination
    quantity_requested REAL NOT NULL CHECK (quantity_requested > 0),
    quantity_dispatched REAL NOT NULL DEFAULT 0,
    quantity_received REAL NOT NULL DEFAULT 0,
    unit_cost         REAL NOT NULL DEFAULT 0,
    serial_ids_json   TEXT,
    discrepancy_qty   REAL NOT NULL DEFAULT 0,
    discrepancy_note  TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_transfer_items_transfer ON stock_transfer_items(transfer_id) WHERE is_deleted = 0;

-- =====================================================================
-- 14. STOCKTAKE & ADJUSTMENTS
-- =====================================================================
-- Models a full physical-count cycle rather than jumping straight to
-- ad-hoc adjustments: freeze the system quantity, record what was counted,
-- compute variance, then post adjustments. A stocktake that only produces
-- a number nobody acts on is a stocktake that will not happen twice.
CREATE TABLE stocktake_sessions (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    reference         TEXT NOT NULL,
    scope             TEXT NOT NULL CHECK (scope IN ('FULL','CATEGORY','PRODUCT','LOCATION','SAMPLE')) DEFAULT 'FULL',
    scope_ids_json    TEXT,
    status            TEXT NOT NULL CHECK (status IN ('OPEN','COUNTING','REVIEW','COMMITTED','CANCELLED')) DEFAULT 'OPEN',
    blind_count       INTEGER NOT NULL DEFAULT 0,          -- hide the system qty from the counter: a
                                                           -- non-blind count invites "yes, that looks right"
    opened_by         TEXT REFERENCES users(id),
    opened_at         TEXT NOT NULL DEFAULT (datetime('now')),
    committed_by      TEXT REFERENCES users(id),
    committed_at      TEXT,
    reviewed_by       TEXT REFERENCES users(id),
    cancelled_by      TEXT REFERENCES users(id),
    cancellation_reason TEXT,
    total_lines       INTEGER NOT NULL DEFAULT 0,
    counted_lines     INTEGER NOT NULL DEFAULT 0,
    variance_lines    INTEGER NOT NULL DEFAULT 0,
    net_variance_value REAL NOT NULL DEFAULT 0,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, reference)
);
-- ONE OPEN STOCKTAKE PER BRANCH. Two concurrent counts of the same shelves
-- produce two sets of variances against a moving system quantity, and the
-- resulting adjustments are meaningless.
CREATE UNIQUE INDEX idx_stocktake_one_open_per_branch
    ON stocktake_sessions(branch_id) WHERE status IN ('OPEN','COUNTING','REVIEW') AND is_deleted = 0;

CREATE TABLE stocktake_lines (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    stocktake_id      TEXT NOT NULL REFERENCES stocktake_sessions(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    system_quantity   REAL NOT NULL DEFAULT 0,             -- frozen at session open
    counted_quantity  REAL,                                -- NULL = not counted yet
    variance          REAL,
    variance_value    REAL,
    counted_by        TEXT REFERENCES users(id),
    counted_at        TEXT,
    recount_quantity  REAL,                                -- a second count on a big variance
    recount_by        TEXT REFERENCES users(id),
    recount_at        TEXT,
    adjustment_id     TEXT REFERENCES stock_adjustments(id),
    note              TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (stocktake_id, product_id, stock_batch_id)
);
CREATE INDEX idx_stocktake_lines_session ON stocktake_lines(stocktake_id);

CREATE TABLE stock_adjustments (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    product_id        TEXT NOT NULL REFERENCES products(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    adjustment_type   TEXT NOT NULL CHECK (adjustment_type IN (
                          'DAMAGE','LOSS','THEFT','EXPIRED','FOUND','CORRECTION','STOCKTAKE','SAMPLE','SCRAP','WRITE_OFF'
                      )),
    quantity          REAL NOT NULL,                       -- negative removes stock, positive adds
    unit_cost         REAL NOT NULL DEFAULT 0,
    value             REAL NOT NULL DEFAULT 0,
    reason            TEXT,
    reference         TEXT,
    stocktake_id      TEXT REFERENCES stocktake_sessions(id),
    status            TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED','POSTED')) DEFAULT 'POSTED',
    requested_by      TEXT REFERENCES users(id),
    approved_by       TEXT REFERENCES users(id),
    approved_at       TEXT,
    posted_at         TEXT NOT NULL DEFAULT (datetime('now')),
    device_id         TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_stock_adjustments_branch ON stock_adjustments(branch_id, posted_at);
CREATE INDEX idx_stock_adjustments_batch  ON stock_adjustments(stock_batch_id);
CREATE INDEX idx_stock_adjustments_type   ON stock_adjustments(adjustment_type, posted_at);

-- =====================================================================
-- 15. COMPLIANCE REGISTER  (generalised controlled-substance register)
-- =====================================================================
-- Append-only, HASH-CHAINED: each row stores the SHA-256 of the previous
-- row's hash, so editing or deleting any historical entry breaks the chain
-- for everything after it and is detectable. That is the same tamper
-- evidence a controlled-drug register needs — and it is exactly what a
-- serialised-electronics custody log needs, because "this iPhone left the
-- shop on this receipt" is the difference between a warranty claim and a
-- fraud investigation.
CREATE TABLE compliance_register (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    scheme_code       TEXT NOT NULL,                       -- 'SERIAL_CUSTODY','SONCAP','CONTROLLED_DRUG','CUSTOMS','SCRAp_METAL'
    event_type        TEXT NOT NULL CHECK (event_type IN (
                          'ITEM_RECEIVED','ITEM_SOLD','ITEM_RETURNED','ITEM_TRANSFERRED','ITEM_SCRAPPED',
                          'ITEM_REPAIRED','CERTIFICATE_RECORDED','CERTIFICATE_EXPIRED','INSPECTION','SEIZURE','OTHER'
                      )),
    product_id        TEXT REFERENCES products(id),
    serial_id         TEXT REFERENCES product_serials(id),
    stock_batch_id    TEXT REFERENCES stock_batches(id),
    sale_id           TEXT REFERENCES sales(id),
    transfer_id       TEXT REFERENCES stock_transfers(id),
    quantity          REAL NOT NULL DEFAULT 1,
    certificate_id    TEXT REFERENCES branch_certificates(id),

    -- Counterparty identity, captured for the events that need it.
    counterparty_name TEXT,
    counterparty_phone TEXT,
    counterparty_id_type TEXT,
    counterparty_id_no TEXT,
    counterparty_address TEXT,

    detail            TEXT,
    performed_by      TEXT REFERENCES users(id),
    device_id         TEXT,
    ip_address        TEXT,
    occurred_at       TEXT NOT NULL DEFAULT (datetime('now')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),

    -- HASH CHAIN
    prev_hash         TEXT,                                -- hash of the previous row for this branch+scheme
    row_hash          TEXT NOT NULL,                       -- sha256(prev_hash || canonical row content)
    chain_seq         INTEGER NOT NULL DEFAULT 1
);
-- One row per (branch, scheme, prev_hash) makes a broken or forked chain a
-- CONSTRAINT VIOLATION rather than something only a nightly audit would
-- notice. This is the single most load-bearing index in the schema.
CREATE UNIQUE INDEX idx_compliance_chain_link ON compliance_register(branch_id, scheme_code, prev_hash);
CREATE INDEX idx_compliance_branch_time ON compliance_register(branch_id, occurred_at);
CREATE INDEX idx_compliance_serial      ON compliance_register(serial_id);
CREATE INDEX idx_compliance_scheme      ON compliance_register(business_unit_id, scheme_code, occurred_at);
CREATE INDEX idx_compliance_product     ON compliance_register(product_id);

-- =====================================================================
-- 16. CASH CONTROL: TILL SESSIONS
-- =====================================================================
CREATE TABLE till_sessions (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    till_code         TEXT NOT NULL DEFAULT 'TILL-1',
    session_no        TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED','SUSPENDED','RECONCILED')) DEFAULT 'OPEN',
    opened_by         TEXT NOT NULL REFERENCES users(id),
    opened_at         TEXT NOT NULL DEFAULT (datetime('now')),
    closed_by         TEXT REFERENCES users(id),
    closed_at         TEXT,
    reconciled_by     TEXT REFERENCES users(id),
    reconciled_at     TEXT,
    device_id         TEXT,

    opening_float     REAL NOT NULL DEFAULT 0,
    -- SYSTEM EXPECTATIONS (derived from the sales/payments in the session)
    expected_cash     REAL NOT NULL DEFAULT 0,
    expected_pos      REAL NOT NULL DEFAULT 0,
    expected_transfer REAL NOT NULL DEFAULT 0,
    expected_ussd     REAL NOT NULL DEFAULT 0,
    expected_mobile_money REAL NOT NULL DEFAULT 0,
    expected_cheque   REAL NOT NULL DEFAULT 0,
    expected_other    REAL NOT NULL DEFAULT 0,
    expected_credit   REAL NOT NULL DEFAULT 0,
    expected_total    REAL NOT NULL DEFAULT 0,
    -- PHYSICAL COUNT at close
    counted_cash      REAL,
    counted_total     REAL,
    variance          REAL,
    variance_reason   TEXT,
    variance_approved_by TEXT REFERENCES users(id),

    safe_deposited    REAL NOT NULL DEFAULT 0,             -- cash moved to the branch safe during the shift
    safe_withdrawn    REAL NOT NULL DEFAULT 0,
    banked_amount     REAL NOT NULL DEFAULT 0,
    change_owed_outstanding REAL NOT NULL DEFAULT 0,

    sale_count        INTEGER NOT NULL DEFAULT 0,
    void_count        INTEGER NOT NULL DEFAULT 0,
    return_count      INTEGER NOT NULL DEFAULT 0,
    discount_total    REAL NOT NULL DEFAULT 0,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, session_no)
);
-- ONE OPEN TILL PER BRANCH+TILL. Two open tills on one drawer means neither
-- closing reconciles to anything, and "whose shortage is this?" becomes
-- unanswerable — the exact ambiguity that lets a real shortage disappear.
CREATE UNIQUE INDEX idx_till_one_open_per_branch
    ON till_sessions(branch_id, till_code) WHERE status = 'OPEN' AND is_deleted = 0;
CREATE INDEX idx_till_branch_date ON till_sessions(branch_id, opened_at);

-- =====================================================================
-- 17. ATTENDANCE
-- =====================================================================
CREATE TABLE staff_attendance (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    user_id           TEXT NOT NULL REFERENCES users(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    work_date         TEXT NOT NULL,                       -- WAT date, never a UTC date
    clock_in_at       TEXT NOT NULL DEFAULT (datetime('now')),
    clock_out_at      TEXT,
    in_latitude       REAL,
    in_longitude      REAL,
    in_distance_meters REAL,                               -- Haversine distance from the branch geofence centre
    in_location_status TEXT NOT NULL CHECK (in_location_status IN ('ON_SITE','OFF_SITE','NO_LOCATION','DEVICE_MATCHED','DEVICE_UNRECOGNIZED','NOT_REQUIRED')) DEFAULT 'NOT_REQUIRED',
    out_latitude      REAL,
    out_longitude     REAL,
    out_distance_meters REAL,
    out_location_status TEXT,
    device_id         TEXT,
    device_matched    INTEGER,
    -- FLAGGED, NOT BLOCKED. GPS accuracy and permissions vary enormously by
    -- device and a showroom inside a mall may never get a fix, so an
    -- off-site or no-location clock-in is queued for manager review rather
    -- than rejected. Rejecting it would mean a cashier cannot start a shift.
    needs_review      INTEGER NOT NULL DEFAULT 0,
    review_status     TEXT CHECK (review_status IS NULL OR review_status IN ('PENDING','APPROVED','REJECTED','OVERRIDE_APPROVED')),
    reviewed_by       TEXT REFERENCES users(id),
    reviewed_at       TEXT,
    review_note       TEXT,
    override_by       TEXT REFERENCES users(id),
    hours_worked      REAL,
    is_late           INTEGER NOT NULL DEFAULT 0,
    late_minutes      INTEGER NOT NULL DEFAULT 0,
    break_minutes     INTEGER NOT NULL DEFAULT 0,
    shift_type        TEXT CHECK (shift_type IS NULL OR shift_type IN ('MORNING','AFTERNOON','FULL_DAY','NIGHT','FLEX')),
    note              TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
-- ONE OPEN CLOCK-IN PER USER: a double clock-in would either create two
-- overlapping shifts or silently close the first, and both corrupt the
-- hours report.
CREATE UNIQUE INDEX idx_attendance_one_open_per_user
    ON staff_attendance(user_id) WHERE clock_out_at IS NULL AND is_deleted = 0;
CREATE INDEX idx_attendance_branch_date ON staff_attendance(branch_id, work_date);
CREATE INDEX idx_attendance_user_date   ON staff_attendance(user_id, clock_in_at);
CREATE INDEX idx_attendance_review      ON staff_attendance(needs_review, review_status) WHERE needs_review = 1;

-- Shift definitions, so "late" is a computed fact rather than an opinion.
CREATE TABLE branch_shifts (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    name              TEXT NOT NULL,
    shift_type        TEXT NOT NULL CHECK (shift_type IN ('MORNING','AFTERNOON','FULL_DAY','NIGHT','FLEX')) DEFAULT 'FULL_DAY',
    start_time        TEXT NOT NULL,                       -- 'HH:MM' local
    end_time          TEXT NOT NULL,
    grace_minutes     INTEGER NOT NULL DEFAULT 10,
    days_of_week      TEXT NOT NULL DEFAULT '1,2,3,4,5,6',  -- 1=Mon .. 7=Sun
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);

-- =====================================================================
-- 18. EXPENSES
-- =====================================================================
CREATE TABLE expense_categories (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    code              TEXT NOT NULL,
    label             TEXT NOT NULL,
    gl_account_id     TEXT REFERENCES gl_accounts(id),
    is_operational    INTEGER NOT NULL DEFAULT 1,
    requires_receipt  INTEGER NOT NULL DEFAULT 0,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, code)
);

CREATE TABLE expenses (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT NOT NULL REFERENCES branches(id),
    category_id       TEXT REFERENCES expense_categories(id),
    expense_date      TEXT NOT NULL,
    description       TEXT NOT NULL,
    amount            REAL NOT NULL CHECK (amount > 0),
    payment_method    TEXT NOT NULL CHECK (payment_method IN ('CASH','POS_TERMINAL','BANK_TRANSFER','USSD','MOBILE_MONEY','CHEQUE','SAFE','CREDIT','OTHER')) DEFAULT 'CASH',
    till_session_id   TEXT REFERENCES till_sessions(id),
    paid_from_safe    INTEGER NOT NULL DEFAULT 0,
    safe_ledger_id    TEXT REFERENCES branch_safe_ledger(id),
    supplier_id       TEXT REFERENCES suppliers(id),
    reference         TEXT,
    receipt_no        TEXT,
    receipt_data_url  TEXT,                                -- photo of the paper receipt
    -- APPROVAL WORKFLOW. An expense nobody has to approve is an expense
    -- nobody can question, and unapproved petty cash is where branch P&L
    -- goes to die.
    status            TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED','POSTED','CANCELLED')) DEFAULT 'PENDING_APPROVAL',
    requested_by      TEXT REFERENCES users(id),
    approved_by       TEXT REFERENCES users(id),
    approved_at       TEXT,
    rejection_reason  TEXT,
    wht_rate_code     TEXT,
    wht_amount        REAL NOT NULL DEFAULT 0,
    net_amount        REAL NOT NULL DEFAULT 0,
    vat_amount        REAL NOT NULL DEFAULT 0,
    is_recurring      INTEGER NOT NULL DEFAULT 0,
    recurring_parent_id TEXT REFERENCES expenses(id),
    device_id         TEXT,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_expenses_branch ON expenses(branch_id, expense_date);
CREATE INDEX idx_expenses_bu     ON expenses(business_unit_id, expense_date);
CREATE INDEX idx_expenses_status ON expenses(status, expense_date) WHERE is_deleted = 0;
CREATE INDEX idx_expenses_category ON expenses(category_id) WHERE is_deleted = 0;

-- =====================================================================
-- 19. WITHHOLDING TAX
-- =====================================================================
-- Deduction of Tax at Source (Withholding) Regulations 2024, effective
-- 1 January 2025. Rates are DATA, never code: they changed materially under
-- the 2024 Regulations and they differ by counterparty type (small company
-- vs large), so a hardcoded percentage is a compliance bug waiting for the
-- next gazette.
CREATE TABLE wht_rates (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT REFERENCES business_units(id),   -- NULL = system default schedule
    code              TEXT NOT NULL,
    label             TEXT NOT NULL,
    category          TEXT NOT NULL,
    direction         TEXT NOT NULL CHECK (direction IN ('PAYABLE','RECEIVABLE','BOTH')) DEFAULT 'BOTH',
    rate_percent      REAL NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
    rate_percent_small_company REAL CHECK (rate_percent_small_company IS NULL OR (rate_percent_small_company >= 0 AND rate_percent_small_company <= 100)),
    counterparty_type TEXT CHECK (counterparty_type IS NULL OR counterparty_type IN ('COMPANY','INDIVIDUAL','SMALL_COMPANY','MEDIUM_COMPANY','LARGE_COMPANY','GOVERNMENT','NON_RESIDENT')),
    regulation_ref    TEXT,
    effective_from    TEXT NOT NULL,
    effective_to      TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    is_system         INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_wht_rates_code ON wht_rates(code, business_unit_id, effective_from) WHERE is_deleted = 0;
CREATE INDEX idx_wht_rates_active ON wht_rates(is_active, is_deleted);

CREATE TABLE wht_entries (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT REFERENCES branches(id),
    entry_date        TEXT NOT NULL,
    direction         TEXT NOT NULL CHECK (direction IN ('PAYABLE','RECEIVABLE')),
    -- PAYABLE   = we deducted WHT from a supplier and owe FIRS the credit note
    -- RECEIVABLE = a customer deducted WHT from our invoice; we hold the credit note
    source_type       TEXT NOT NULL CHECK (source_type IN ('PURCHASE_ORDER','EXPENSE','SALE','SUPPLIER_PAYMENT','CUSTOMER_PAYMENT','OTHER')),
    source_id         TEXT NOT NULL,
    counterparty_name TEXT NOT NULL,
    counterparty_tin  TEXT,
    counterparty_type TEXT,
    rate_code         TEXT NOT NULL,
    rate_percent      REAL NOT NULL,
    gross_amount      REAL NOT NULL CHECK (gross_amount >= 0),
    wht_amount        REAL NOT NULL CHECK (wht_amount >= 0),
    net_amount        REAL NOT NULL CHECK (net_amount >= 0),
    -- Derived by SUBTRACTION, never by a second independent rounding:
    -- rounding both legs separately is the classic way gross = net + wht
    -- fails by a kobo, which the CHECK below would then reject outright.
    credit_note_no    TEXT,
    remitted_at       TEXT,
    remittance_ref    TEXT,
    filed_period      TEXT,                                -- 'YYYY-MM'
    exemption_applied INTEGER NOT NULL DEFAULT 0,
    exemption_reason  TEXT,
    notes             TEXT,
    created_by        TEXT REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    CHECK (net_amount = gross_amount - wht_amount OR abs(net_amount - (gross_amount - wht_amount)) < 0.005)
);
CREATE INDEX idx_wht_entries_branch_date ON wht_entries(branch_id, entry_date);
CREATE INDEX idx_wht_entries_source      ON wht_entries(source_type, source_id);
CREATE INDEX idx_wht_entries_remittance  ON wht_entries(direction, remitted_at);
CREATE INDEX idx_wht_entries_period      ON wht_entries(business_unit_id, filed_period);

-- =====================================================================
-- 20. GENERAL LEDGER  (double entry)
-- =====================================================================
CREATE TABLE gl_accounts (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    code              TEXT NOT NULL,
    name              TEXT NOT NULL,
    account_type      TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
    parent_id         TEXT REFERENCES gl_accounts(id),
    normal_side       TEXT NOT NULL CHECK (normal_side IN ('DEBIT','CREDIT')),
    is_system         INTEGER NOT NULL DEFAULT 0,          -- seeded chart of accounts; cannot be deleted
    is_active         INTEGER NOT NULL DEFAULT 1,
    description       TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, code)
);
CREATE INDEX idx_gl_accounts_type ON gl_accounts(business_unit_id, account_type) WHERE is_deleted = 0;

CREATE TABLE gl_journal_entries (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT REFERENCES branches(id),        -- NULL = consolidation-level entry
    entry_no          TEXT NOT NULL,
    entry_date        TEXT NOT NULL,
    source_type       TEXT NOT NULL CHECK (source_type IN ('SALE','SALE_RETURN','SALE_VOID','PURCHASE','EXPENSE','STOCK_ADJUSTMENT','STOCK_TRANSFER','PAYMENT_PLAN','LAYAWAY','DELIVERY_JOB','WARRANTY_CLAIM','WHT','MANUAL','OPENING_BALANCE','DEPRECIATION','BANK_DEPOSIT')),
    source_id         TEXT,
    reference         TEXT,
    description       TEXT NOT NULL,
    total_debit       REAL NOT NULL DEFAULT 0,
    total_credit      REAL NOT NULL DEFAULT 0,
    status            TEXT NOT NULL CHECK (status IN ('POSTED','REVERSED','DRAFT')) DEFAULT 'POSTED',
    reversed_by_entry_id TEXT REFERENCES gl_journal_entries(id),
    posted_by         TEXT REFERENCES users(id),
    posted_at         TEXT NOT NULL DEFAULT (datetime('now')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (business_unit_id, entry_no),
    -- DOUBLE ENTRY MUST BALANCE. Enforced in SQL so a bug in any service
    -- produces a loud failure instead of a silently wrong balance sheet.
    CHECK (abs(total_debit - total_credit) < 0.005)
);
CREATE INDEX idx_gl_je_branch ON gl_journal_entries(branch_id, entry_date);
CREATE INDEX idx_gl_je_source ON gl_journal_entries(source_type, source_id);
CREATE INDEX idx_gl_je_date   ON gl_journal_entries(business_unit_id, entry_date);

CREATE TABLE gl_journal_lines (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    journal_entry_id  TEXT NOT NULL REFERENCES gl_journal_entries(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_id         TEXT REFERENCES branches(id),
    account_id        TEXT NOT NULL REFERENCES gl_accounts(id),
    debit             REAL NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit            REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
    -- A line carries EITHER a debit or a credit, never both: a line with
    -- both would net out and hide itself from the trial balance.
    category_id       TEXT REFERENCES product_categories(id),
    description       TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX idx_gl_lines_entry   ON gl_journal_lines(journal_entry_id);
CREATE INDEX idx_gl_lines_account ON gl_journal_lines(account_id);
CREATE INDEX idx_gl_lines_category ON gl_journal_lines(category_id, journal_entry_id) WHERE category_id IS NOT NULL;

-- =====================================================================
-- 21. OFFLINE SYNC
-- =====================================================================
CREATE TABLE branch_sync_status (
    branch_id         TEXT PRIMARY KEY REFERENCES branches(id),
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    device_id         TEXT,
    app_version       TEXT,
    last_heartbeat_at TEXT,
    last_push_at      TEXT,
    last_pull_at      TEXT,
    pending_push_count INTEGER NOT NULL DEFAULT 0,         -- unsynced local rows, self-reported by the device
    queue_oldest_at   TEXT,
    last_sync_error   TEXT,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sync_change_log (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id  TEXT REFERENCES business_units(id),
    branch_id         TEXT REFERENCES branches(id),
    device_id         TEXT,
    direction         TEXT NOT NULL CHECK (direction IN ('PUSH','PULL','HEARTBEAT')),
    table_name        TEXT,
    row_count         INTEGER DEFAULT 0,
    status            TEXT NOT NULL CHECK (status IN ('SUCCESS','PARTIAL','FAILED')) DEFAULT 'SUCCESS',
    error_message     TEXT,
    duration_ms       INTEGER,
    synced_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sync_log_synced_at ON sync_change_log(synced_at);
CREATE INDEX idx_sync_log_branch    ON sync_change_log(branch_id, synced_at);

-- LWW is simple and fine for the common case, but it has a real failure
-- mode: two branches editing the same shared customer row while both
-- offline means the second sync silently overwrites the first, with no
-- error and nothing in the history. This table records the DISCARDED
-- version before it is overwritten, so a manager can review what was lost.
-- It does not prevent the overwrite (a full CRDT merge is a much larger
-- undertaking) but it closes the "nobody would ever know" gap.
CREATE TABLE sync_conflicts (
    id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    business_unit_id     TEXT REFERENCES business_units(id),
    table_name           TEXT NOT NULL,
    row_id               TEXT NOT NULL,
    branch_id            TEXT REFERENCES branches(id),
    device_id            TEXT,
    losing_version_json  TEXT NOT NULL,
    winning_version_json TEXT NOT NULL,
    resolution           TEXT CHECK (resolution IS NULL OR resolution IN ('KEEP_WINNER','RESTORE_LOSER','MERGED','IGNORED')),
    detected_at          TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by          TEXT REFERENCES users(id),
    reviewed_at          TEXT,
    review_note          TEXT
);
CREATE INDEX idx_sync_conflicts_unreviewed ON sync_conflicts(detected_at) WHERE reviewed_by IS NULL;

-- Protects every mutating request against duplicate execution when a client
-- retries after losing the response — flaky connection, or an offline queue
-- replaying a request that actually already succeeded server-side before
-- connectivity dropped. This is what makes it safe for the PWA's queue to
-- blindly retry without risking double stock deduction, double cash counted
-- or a duplicate register entry.
CREATE TABLE idempotency_keys (
    idempotency_key   TEXT NOT NULL,
    user_id           TEXT NOT NULL REFERENCES users(id),
    business_unit_id  TEXT REFERENCES business_units(id),
    method            TEXT NOT NULL,
    path              TEXT NOT NULL,
    request_hash      TEXT NOT NULL,                       -- detects a key reused for a DIFFERENT request
    response_status   INTEGER,
    response_body     TEXT,
    status            TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')) DEFAULT 'IN_PROGRESS',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (idempotency_key, user_id)
);
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);

-- =====================================================================
-- 22. AUDIT LOG
-- =====================================================================
CREATE TABLE audit_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    business_unit_id  TEXT REFERENCES business_units(id),
    branch_id         TEXT REFERENCES branches(id),
    user_id           TEXT REFERENCES users(id),
    actor_role        TEXT,
    action            TEXT NOT NULL,                       -- 'SALE_VOID','PRICE_EDIT','CREDIT_LIMIT_OVERRIDE',...
    entity_type       TEXT,
    entity_id         TEXT,
    before_json       TEXT,
    after_json        TEXT,
    amount            REAL,
    reason            TEXT,
    ip_address        TEXT,
    user_agent        TEXT,
    device_id         TEXT,
    occurred_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_bu_time     ON audit_log(business_unit_id, occurred_at);
CREATE INDEX idx_audit_user        ON audit_log(user_id, occurred_at);
CREATE INDEX idx_audit_entity      ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_action      ON audit_log(action, occurred_at);
CREATE INDEX idx_audit_branch_time ON audit_log(branch_id, occurred_at);

-- Housekeeping: D1/SQLite tables that grow unboundedly need pruning, and
-- the pruning must be recorded so "why is there no log before March?" is
-- answerable.
CREATE TABLE data_cleanup_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    business_unit_id  TEXT REFERENCES business_units(id),
    table_name        TEXT NOT NULL,
    rows_deleted      INTEGER NOT NULL DEFAULT 0,
    retention_days    INTEGER NOT NULL,
    performed_by      TEXT,                                -- 'CRON' or a user id
    performed_at      TEXT NOT NULL DEFAULT (datetime('now')),
    note              TEXT
);

-- Reference-number sequences. One row per (business, prefix) rather than a
-- MAX()+1 scan over the sales table: a MAX() scan is a race between two
-- tills and it gets slower every day forever.
CREATE TABLE reference_sequences (
    business_unit_id  TEXT NOT NULL REFERENCES business_units(id),
    branch_code       TEXT NOT NULL DEFAULT '*',           -- '*' = business-wide
    prefix            TEXT NOT NULL,
    period            TEXT NOT NULL DEFAULT '*',           -- 'YYYY' for per-year sequences, '*' for evergreen
    current_value     INTEGER NOT NULL DEFAULT 0,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_unit_id, branch_code, prefix, period)
);

-- =====================================================================
-- VIEWS
-- =====================================================================
-- Every "day" in a view is a WEST AFRICA TIME day. `datetime(x, '+1 hour')`
-- converts a stored UTC timestamp to WAT before date() buckets it. This is
-- the fix PharmaRidge had to retrofit as migration 009; here it is the
-- only way a date is ever taken.

CREATE VIEW v_daily_sales_by_branch AS
SELECT
    s.business_unit_id,
    s.branch_id,
    b.name AS branch_name,
    date(s.occurred_at, '+1 hour') AS sale_date,
    COUNT(DISTINCT s.id) AS sale_count,
    SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS void_count,
    COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.total ELSE 0 END), 0) AS gross_revenue,
    COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.vat_amount ELSE 0 END), 0) AS vat_collected,
    COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.discount_amount ELSE 0 END), 0) AS discount_given,
    COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.balance_due ELSE 0 END), 0) AS credit_extended,
    COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN si.gross_margin ELSE 0 END), 0) AS gross_margin
FROM sales s
JOIN branches b ON b.id = s.branch_id
LEFT JOIN sale_items si ON si.sale_id = s.id AND si.is_deleted = 0
WHERE s.is_deleted = 0
GROUP BY s.business_unit_id, s.branch_id, b.name, date(s.occurred_at, '+1 hour');

CREATE VIEW v_daily_sales_total AS
SELECT
    business_unit_id,
    sale_date,
    SUM(sale_count) AS sale_count,
    SUM(void_count) AS void_count,
    SUM(gross_revenue) AS gross_revenue,
    SUM(vat_collected) AS vat_collected,
    SUM(discount_given) AS discount_given,
    SUM(credit_extended) AS credit_extended,
    SUM(gross_margin) AS gross_margin
FROM v_daily_sales_by_branch
GROUP BY business_unit_id, sale_date;

CREATE VIEW v_stock_position_by_branch AS
SELECT
    sb.business_unit_id,
    sb.branch_id,
    b.name AS branch_name,
    sb.product_id,
    p.name AS product_name,
    p.sku,
    p.base_unit,
    pc.label AS category_label,
    COALESCE(SUM(sb.quantity_remaining), 0) AS qty_on_hand,
    COALESCE(SUM(sb.quantity_reserved), 0)  AS qty_reserved,
    COALESCE(SUM(sb.quantity_remaining - sb.quantity_reserved), 0) AS qty_available,
    COALESCE(SUM(sb.quantity_remaining * sb.unit_cost), 0) AS stock_value_at_cost,
    COALESCE(SUM(sb.quantity_remaining * sb.selling_price_per_unit), 0) AS stock_value_at_retail,
    p.reorder_level,
    CASE WHEN p.reorder_level > 0 AND SUM(sb.quantity_remaining) <= p.reorder_level THEN 1 ELSE 0 END AS below_reorder
FROM stock_batches sb
JOIN products p ON p.id = sb.product_id
JOIN branches b ON b.id = sb.branch_id
LEFT JOIN product_categories pc ON pc.id = p.category_id
WHERE sb.is_deleted = 0 AND p.is_deleted = 0 AND sb.status NOT IN ('EXPIRED','RECALLED')
GROUP BY sb.business_unit_id, sb.branch_id, b.name, sb.product_id, p.name, p.sku, p.base_unit, pc.label, p.reorder_level;

CREATE VIEW v_stock_value_by_branch AS
SELECT
    business_unit_id, branch_id, branch_name,
    SUM(qty_on_hand) AS total_units,
    SUM(stock_value_at_cost) AS value_at_cost,
    SUM(stock_value_at_retail) AS value_at_retail,
    SUM(below_reorder) AS products_below_reorder
FROM v_stock_position_by_branch
GROUP BY business_unit_id, branch_id, branch_name;

CREATE VIEW v_low_stock_alerts AS
SELECT
    business_unit_id, branch_id, branch_name, product_id, product_name, sku, base_unit,
    category_label, qty_on_hand, qty_available, reorder_level
FROM v_stock_position_by_branch
WHERE reorder_level > 0 AND qty_on_hand <= reorder_level
ORDER BY (reorder_level - qty_on_hand) DESC;

-- Expiry alerts. Only meaningful for products/categories that track expiry;
-- a sofa with a NULL expiry_date must never appear here.
CREATE VIEW v_expiry_alerts AS
SELECT
    sb.business_unit_id,
    sb.branch_id,
    b.name AS branch_name,
    sb.product_id,
    p.name AS product_name,
    sb.id AS stock_batch_id,
    sb.batch_no,
    sb.expiry_date,
    sb.quantity_remaining,
    sb.unit_cost,
    (sb.quantity_remaining * sb.unit_cost) AS value_at_risk,
    CAST(julianday(sb.expiry_date) - julianday('now', '+1 hour') AS INTEGER) AS days_to_expiry,
    CASE
        WHEN sb.expiry_date < date('now', '+1 hour') THEN 'EXPIRED'
        WHEN sb.expiry_date <= date('now', '+7 days') THEN 'CRITICAL'
        WHEN sb.expiry_date <= date('now', '+30 days') THEN 'WARNING'
        WHEN sb.expiry_date <= date('now', '+90 days') THEN 'WATCH'
        ELSE 'OK'
    END AS severity
FROM stock_batches sb
JOIN products p ON p.id = sb.product_id
JOIN branches b ON b.id = sb.branch_id
WHERE sb.is_deleted = 0
  AND sb.expiry_date IS NOT NULL
  AND sb.quantity_remaining > 0
  AND sb.status NOT IN ('EXPIRED','RETURNED_TO_SUPPLIER');

CREATE VIEW v_debtor_balances AS
SELECT
    d.business_unit_id,
    d.customer_id,
    c.full_name AS customer_name,
    c.phone,
    c.customer_type,
    c.credit_limit,
    c.credit_days,
    COALESCE(SUM(d.amount), 0) AS balance,
    COALESCE(SUM(CASE WHEN d.amount > 0
                      AND julianday('now', '+1 hour') - julianday(d.entry_date) > c.credit_days
                 THEN d.amount ELSE 0 END), 0) AS overdue_balance,
    MIN(CASE WHEN d.amount > 0 THEN d.entry_date END) AS oldest_debit,
    MAX(d.entry_date) AS last_activity
FROM debtor_ledger d
JOIN customers c ON c.id = d.customer_id
WHERE d.is_deleted = 0
GROUP BY d.business_unit_id, d.customer_id, c.full_name, c.phone, c.customer_type, c.credit_limit, c.credit_days
HAVING COALESCE(SUM(d.amount), 0) > 0.005;

CREATE VIEW v_creditor_balances AS
SELECT
    cl.business_unit_id,
    cl.supplier_id,
    s.name AS supplier_name,
    s.phone,
    s.payment_terms_days,
    COALESCE(SUM(cl.amount), 0) AS balance,
    MAX(cl.entry_date) AS last_activity
FROM creditor_ledger cl
JOIN suppliers s ON s.id = cl.supplier_id
WHERE cl.is_deleted = 0
GROUP BY cl.business_unit_id, cl.supplier_id, s.name, s.phone, s.payment_terms_days
HAVING COALESCE(SUM(cl.amount), 0) > 0.005;

CREATE VIEW v_branch_safe_balances AS
SELECT
    business_unit_id,
    branch_id,
    COALESCE(SUM(amount), 0) AS safe_balance,
    MAX(occurred_at) AS last_movement_at
FROM branch_safe_ledger
WHERE is_deleted = 0
GROUP BY business_unit_id, branch_id;

CREATE VIEW v_change_owed_outstanding AS
SELECT
    business_unit_id, branch_id,
    COUNT(*) AS claims_outstanding,
    COALESCE(SUM(amount), 0) AS total_owed,
    MIN(created_at) AS oldest_claim_at
FROM change_owed
WHERE status = 'OUTSTANDING' AND is_deleted = 0
GROUP BY business_unit_id, branch_id;

CREATE VIEW v_branch_sync_overview AS
SELECT
    b.id AS branch_id,
    b.business_unit_id,
    b.name AS branch_name,
    s.device_id,
    s.app_version,
    s.last_heartbeat_at,
    s.last_push_at,
    s.last_pull_at,
    s.pending_push_count,
    s.last_sync_error,
    -- STALE = no heartbeat in 24h. A branch that has not synced in a day
    -- is either closed, offline or broken, and all three need a human.
    CASE
        WHEN s.last_heartbeat_at IS NULL THEN 'NEVER_SYNCED'
        WHEN julianday('now') - julianday(s.last_heartbeat_at) > 1 THEN 'STALE'
        WHEN s.pending_push_count > 0 THEN 'PENDING'
        WHEN s.last_sync_error IS NOT NULL THEN 'ERROR'
        ELSE 'HEALTHY'
    END AS sync_health,
    CAST((julianday('now') - julianday(s.last_heartbeat_at)) * 24 AS REAL) AS hours_since_heartbeat
FROM branches b
LEFT JOIN branch_sync_status s ON s.branch_id = b.id
WHERE b.is_deleted = 0 AND b.is_active = 1;

-- Licence/certificate expiry alerts. Same shape as the pharmacy PCN
-- licence view, generalised to any regulator and any scheme.
CREATE VIEW v_certificate_expiry_alerts AS
SELECT
    bc.business_unit_id,
    bc.branch_id,
    COALESCE(b.name, 'All branches') AS branch_name,
    bc.scheme_code,
    bc.certificate_no,
    bc.holder_name,
    bc.expiry_date,
    bc.status,
    CAST(julianday(bc.expiry_date) - julianday('now', '+1 hour') AS INTEGER) AS days_to_expiry,
    CASE
        WHEN bc.expiry_date < date('now', '+1 hour') THEN 'EXPIRED'
        WHEN bc.expiry_date <= date('now', '+30 days') THEN 'CRITICAL'
        WHEN bc.expiry_date <= date('now', '+90 days') THEN 'WARNING'
        ELSE 'OK'
    END AS severity
FROM branch_certificates bc
LEFT JOIN branches b ON b.id = bc.branch_id
WHERE bc.is_deleted = 0 AND bc.expiry_date IS NOT NULL AND bc.status <> 'NOT_APPLICABLE';

-- Void rate by user. A lightweight shrinkage/fraud signal: a cashier whose
-- void rate is an outlier against their peers is worth a conversation long
-- before an audit finds anything.
CREATE VIEW v_void_audit_by_user AS
SELECT
    s.business_unit_id,
    s.branch_id,
    s.sold_by AS user_id,
    u.full_name AS user_name,
    u.role,
    COUNT(*) AS total_sales,
    SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) AS voided_sales,
    ROUND(100.0 * SUM(CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 2) AS void_rate_percent,
    COALESCE(SUM(CASE WHEN s.status = 'VOIDED' THEN s.total ELSE 0 END), 0) AS voided_value,
    COALESCE(SUM(s.discount_amount), 0) AS total_discount_given,
    ROUND(100.0 * COALESCE(SUM(s.discount_amount), 0) / MAX(COALESCE(SUM(CASE WHEN s.status <> 'VOIDED' THEN s.subtotal ELSE 0 END), 0), 0.01), 2) AS discount_rate_percent
FROM sales s
JOIN users u ON u.id = s.sold_by
WHERE s.is_deleted = 0
GROUP BY s.business_unit_id, s.branch_id, s.sold_by, u.full_name, u.role;

CREATE VIEW v_gl_account_balances AS
SELECT
    l.business_unit_id,
    l.branch_id,
    a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.account_type,
    a.normal_side,
    COALESCE(SUM(l.debit), 0) AS total_debit,
    COALESCE(SUM(l.credit), 0) AS total_credit,
    CASE
        WHEN a.normal_side = 'DEBIT' THEN COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0)
        ELSE COALESCE(SUM(l.credit), 0) - COALESCE(SUM(l.debit), 0)
    END AS balance
FROM gl_journal_lines l
JOIN gl_accounts a ON a.id = l.account_id
JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.status = 'POSTED' AND e.is_deleted = 0
WHERE l.is_deleted = 0
GROUP BY l.business_unit_id, l.branch_id, a.id, a.code, a.name, a.account_type, a.normal_side;

CREATE VIEW v_gl_account_balances_total AS
SELECT
    business_unit_id, account_id, account_code, account_name, account_type, normal_side,
    SUM(total_debit) AS total_debit,
    SUM(total_credit) AS total_credit,
    CASE WHEN normal_side = 'DEBIT' THEN SUM(total_debit) - SUM(total_credit)
         ELSE SUM(total_credit) - SUM(total_debit) END AS balance
FROM v_gl_account_balances
GROUP BY business_unit_id, account_id, account_code, account_name, account_type, normal_side;

CREATE VIEW v_warranty_expiring AS
SELECT
    w.business_unit_id,
    w.branch_id,
    w.id AS warranty_id,
    w.warranty_type,
    w.months,
    w.starts_at,
    w.ends_at,
    w.status,
    p.name AS product_name,
    ps.serial_no,
    c.full_name AS customer_name,
    c.phone AS customer_phone,
    CAST(julianday(w.ends_at) - julianday('now', '+1 hour') AS INTEGER) AS days_remaining
FROM product_warranties w
JOIN products p ON p.id = w.product_id
LEFT JOIN product_serials ps ON ps.id = w.serial_id
LEFT JOIN customers c ON c.id = w.customer_id
WHERE w.is_deleted = 0 AND w.status = 'ACTIVE';

-- Instalment plans at risk: overdue, or due within the next N days. This is
-- the view a branch manager opens every morning, because an instalment
-- book nobody chases on the day it falls due becomes a bad-debt book.
CREATE VIEW v_plan_installments_due AS
SELECT
    pi.business_unit_id,
    pi.payment_plan_id,
    pp.plan_no,
    pp.plan_type,
    pp.status AS plan_status,
    pp.customer_id,
    c.full_name AS customer_name,
    c.phone AS customer_phone,
    pp.branch_id,
    b.name AS branch_name,
    pi.seq,
    pi.due_date,
    pi.amount_due,
    pi.amount_paid,
    (pi.amount_due - pi.amount_paid) AS outstanding,
    pi.status,
    CAST(julianday('now', '+1 hour') - julianday(pi.due_date) AS INTEGER) AS days_overdue,
    CASE
        WHEN pi.status IN ('PAID','WAIVED') THEN 'SETTLED'
        WHEN pi.due_date < date('now', '+1 hour') THEN 'OVERDUE'
        WHEN pi.due_date <= date('now', '+7 days') THEN 'DUE_SOON'
        ELSE 'UPCOMING'
    END AS ageing
FROM payment_plan_items pi
JOIN payment_plans pp ON pp.id = pi.payment_plan_id AND pp.is_deleted = 0
JOIN customers c ON c.id = pp.customer_id
JOIN branches b ON b.id = pp.branch_id
WHERE pi.is_deleted = 0 AND pp.status IN ('ACTIVE','DEFAULTED');

CREATE VIEW v_serial_custody AS
SELECT
    ps.business_unit_id,
    ps.branch_id,
    b.name AS branch_name,
    ps.product_id,
    p.name AS product_name,
    p.brand,
    p.model_number,
    ps.serial_no,
    ps.imei,
    ps.status,
    ps.received_at,
    ps.sold_at,
    s.receipt_no,
    c.full_name AS customer_name,
    c.phone AS customer_phone,
    w.ends_at AS warranty_ends_at
FROM product_serials ps
JOIN products p ON p.id = ps.product_id
JOIN branches b ON b.id = ps.branch_id
LEFT JOIN sales s ON s.id = ps.sale_id
LEFT JOIN customers c ON c.id = s.customer_id
LEFT JOIN product_warranties w ON w.serial_id = ps.id AND w.is_deleted = 0
WHERE ps.is_deleted = 0;

CREATE VIEW v_delivery_jobs_open AS
SELECT
    dj.business_unit_id,
    dj.branch_id,
    b.name AS branch_name,
    dj.job_no,
    dj.job_type,
    dj.status,
    dj.priority,
    dj.scheduled_date,
    dj.scheduled_window,
    dj.address,
    dj.city,
    dj.contact_name,
    dj.contact_phone,
    dj.total_charge,
    dj.payment_status,
    dj.pod_received,
    u.full_name AS assigned_to_name,
    v.plate_number,
    dj.vehicle_id,
    s.receipt_no
FROM delivery_jobs dj
JOIN branches b ON b.id = dj.branch_id
LEFT JOIN users u ON u.id = dj.assigned_to
LEFT JOIN delivery_vehicles v ON v.id = dj.vehicle_id
LEFT JOIN sales s ON s.id = dj.sale_id
WHERE dj.is_deleted = 0 AND dj.status NOT IN ('COMPLETED','CANCELLED');

CREATE VIEW v_top_products AS
SELECT
    si.business_unit_id,
    si.product_id,
    p.name AS product_name,
    p.brand,
    si.category_id,
    pc.label AS category_label,
    COUNT(DISTINCT si.sale_id) AS times_sold,
    COALESCE(SUM(si.quantity_base), 0) AS units_sold,
    COALESCE(SUM(si.line_total), 0) AS revenue,
    COALESCE(SUM(si.gross_margin), 0) AS gross_margin,
    CASE WHEN SUM(si.line_total) > 0
         THEN ROUND(100.0 * SUM(si.gross_margin) / SUM(si.line_total), 2)
         ELSE 0 END AS margin_percent
FROM sale_items si
JOIN sales s ON s.id = si.sale_id AND s.status <> 'VOIDED' AND s.is_deleted = 0
JOIN products p ON p.id = si.product_id
LEFT JOIN product_categories pc ON pc.id = si.category_id
WHERE si.is_deleted = 0 AND si.is_service_line = 0
GROUP BY si.business_unit_id, si.product_id, p.name, p.brand, si.category_id, pc.label;

-- Plan usage per business unit, so the ADMIN portal and the OWNER's "My
-- Plan" screen read the same numbers the enforcement code enforces. Only
-- ACTIVE branches and ACTIVE staff consume paid slots — a closed branch
-- that kept consuming a slot was a real billing bug in the original design.
CREATE VIEW v_plan_usage AS
SELECT
    bu.id AS business_unit_id,
    bu.name AS business_name,
    bu.industry_profile,
    bu.subscription_status,
    bu.subscription_plan,
    bu.max_branches,
    bu.max_staff,
    bu.max_products,
    (SELECT COUNT(*) FROM branches b WHERE b.business_unit_id = bu.id AND b.is_active = 1 AND b.is_deleted = 0) AS branches_used,
    (SELECT COUNT(*) FROM users u WHERE u.business_unit_id = bu.id AND u.role <> 'ADMIN' AND u.is_active = 1 AND u.is_deleted = 0) AS staff_used,
    (SELECT COUNT(*) FROM products p WHERE p.business_unit_id = bu.id AND p.is_deleted = 0) AS products_used
FROM business_units bu
WHERE bu.is_deleted = 0;
