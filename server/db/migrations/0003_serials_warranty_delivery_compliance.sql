-- =====================================================================
-- STOCKRIDGE — migration 0003: serials, warranty, delivery, compliance
-- =====================================================================
-- The four features that turn a generic stock system into one an electronics
-- retailer, a furniture gallery or a building-materials dealer can actually
-- run their business on.

-- ---------------------------------------------------------------------
-- SERIAL NUMBERS  (every individual unit of a serialised product)
-- ---------------------------------------------------------------------
-- A serialised product is not "quantity 40". It is forty INDIVIDUAL objects,
-- each with its own identity, purchase date, warranty clock and history.
--
-- Three things break without this:
--   WARRANTY   a customer returns a fridge eleven months on claiming cover.
--              Without a serial linked to a sale the shop either believes
--              anyone who walks in (and eats the cost of a unit bought
--              elsewhere) or refuses everyone (and loses the customer).
--   THEFT      "we had 12 laptops, now we have 11" is not an investigation.
--              "IMEI 3582... was received in Ikeja on 3 March and never sold"
--              is.
--   RECALLS    a manufacturer announces a faulty batch. With serials the shop
--              calls exactly the affected customers. Without them it puts a
--              sign in the window.
CREATE TABLE serial_numbers (
    id                    TEXT PRIMARY KEY,
    business_id           TEXT NOT NULL REFERENCES businesses(id),
    product_id            TEXT NOT NULL REFERENCES products(id),
    serial_number         TEXT NOT NULL,
    -- Normalised (upper-cased, separators stripped) so a scan and a hand-keyed
    -- entry of the same serial match. The raw string is kept for the label.
    serial_normalised     TEXT NOT NULL,
    imei                  TEXT,
    imei2                 TEXT,
    mac_address           TEXT,
    model_number          TEXT,
    manufacture_date      TEXT,
    colour                TEXT,
    -- WHERE IT IS AND WHAT STATE IT IS IN.
    status                TEXT NOT NULL DEFAULT 'IN_STOCK'
                          CHECK (status IN ('IN_STOCK','RESERVED','SOLD','RETURNED','IN_REPAIR','WITH_MANUFACTURER',
                                            'REPLACED','SCRAPPED','LOST','STOLEN','TRANSFERRED','ON_ORDER')),
    branch_id             TEXT REFERENCES branches(id),
    stock_batch_id        TEXT REFERENCES stock_batches(id),
    purchase_order_receipt_id TEXT REFERENCES purchase_order_receipts(id),
    transfer_id           TEXT REFERENCES stock_transfers(id),
    -- WHO HAS IT.
    sale_id               TEXT REFERENCES sales(id),
    sale_item_id          TEXT REFERENCES sale_items(id),
    customer_id           TEXT REFERENCES customers(id),
    sold_at               TEXT,
    -- WARRANTY.
    warranty_months       INTEGER NOT NULL DEFAULT 0,
    warranty_extended_months INTEGER NOT NULL DEFAULT 0,
    warranty_basis        TEXT NOT NULL DEFAULT 'SALE'
                          CHECK (warranty_basis IN ('SALE','RECEIPT','MANUFACTURE')),
    warranty_started_on   TEXT,
    warranty_expires_on   TEXT,
    warranty_status       TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (warranty_status IN ('PENDING','IN_WARRANTY','OUT_OF_WARRANTY','VOID','PENDING_CLAIM',
                                                     'UNDER_REPAIR','REPLACED','REFUNDED','EXTENDED')),
    warranty_void_reason  TEXT,
    warranty_voided_by    TEXT REFERENCES users(id),
    warranty_voided_at    TEXT,
    warranty_certificate_no TEXT,
    -- A PAID extension is revenue in its own right and shops want to see how
    -- much of it they wrote.
    warranty_extension_fee_kobo INTEGER NOT NULL DEFAULT 0,
    warranty_extended_at  TEXT,
    received_at           TEXT NOT NULL DEFAULT (datetime('now')),
    received_by           TEXT REFERENCES users(id),
    cost_per_unit         REAL NOT NULL DEFAULT 0,
    notes                 TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
);
-- ONE row per serial per business. A serial recorded twice is the same physical
-- object claimed by two branches, which is either a data error or a theft —
-- and in both cases the second row must be impossible, not merely unlikely.
CREATE UNIQUE INDEX idx_serial_numbers_unique
    ON serial_numbers(business_id, serial_normalised) WHERE is_deleted = 0;
CREATE INDEX idx_serial_numbers_product ON serial_numbers(product_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_serial_numbers_branch ON serial_numbers(branch_id, status) WHERE is_deleted = 0;
CREATE INDEX idx_serial_numbers_sale ON serial_numbers(sale_id) WHERE is_deleted = 0;
CREATE INDEX idx_serial_numbers_customer ON serial_numbers(customer_id) WHERE is_deleted = 0;
CREATE INDEX idx_serial_numbers_warranty
    ON serial_numbers(warranty_expires_on) WHERE warranty_status = 'IN_WARRANTY' AND is_deleted = 0;
CREATE INDEX idx_serial_numbers_imei ON serial_numbers(imei) WHERE imei IS NOT NULL AND is_deleted = 0;

-- Full provenance of one unit. Serials change hands inside a business
-- (transfers, warranty swaps, returns) and the question "where has this been?"
-- must be answerable without reconstructing it from six tables.
CREATE TABLE serial_history (
    id             TEXT PRIMARY KEY,
    serial_id      TEXT NOT NULL REFERENCES serial_numbers(id),
    event_type     TEXT NOT NULL
                   CHECK (event_type IN ('RECEIVED','TRANSFERRED','SOLD','RETURNED','RESERVED','RELEASED',
                                         'REPAIR_SENT','REPAIR_RETURNED','REPLACED','SCRAPPED','LOST','STOLEN',
                                         'WARRANTY_VOIDED','WARRANTY_EXTENDED','STATUS_CORRECTED','RECALLED')),
    from_branch_id TEXT REFERENCES branches(id),
    to_branch_id   TEXT REFERENCES branches(id),
    from_status    TEXT,
    to_status      TEXT,
    source_type    TEXT,
    source_id      TEXT,
    reference      TEXT,
    performed_by   TEXT REFERENCES users(id),
    occurred_at    TEXT NOT NULL DEFAULT (datetime('now')),
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_serial_history_serial ON serial_history(serial_id, occurred_at);
CREATE INDEX idx_serial_history_event ON serial_history(event_type, occurred_at);

-- ---------------------------------------------------------------------
-- WARRANTY CLAIMS
-- ---------------------------------------------------------------------
CREATE TABLE warranty_claims (
    id                    TEXT PRIMARY KEY,
    business_id           TEXT NOT NULL REFERENCES businesses(id),
    branch_id             TEXT NOT NULL REFERENCES branches(id),
    claim_number          TEXT NOT NULL,
    serial_id             TEXT NOT NULL REFERENCES serial_numbers(id),
    serial_number         TEXT NOT NULL,
    product_id            TEXT NOT NULL REFERENCES products(id),
    sale_id               TEXT REFERENCES sales(id),
    customer_id           TEXT REFERENCES customers(id),
    customer_name         TEXT,
    customer_phone        TEXT,
    claim_type            TEXT NOT NULL
                          CHECK (claim_type IN ('REPAIR','REPLACE','REFUND','PARTS_ONLY','REJECT_AS_OUT_OF_COVER')),
    status                TEXT NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN','ASSESSING','AWAITING_CUSTOMER','WITH_MANUFACTURER','APPROVED',
                                            'REJECTED','COMPLETED','CANCELLED')),
    -- WHO PAYS. An in-cover claim is the manufacturer's; an out-of-cover one is
    -- the customer's and is CHARGEABLE. Booking a customer-fault repair as a
    -- warranty expense is how a shop's warranty provision quietly doubles.
    responsibility        TEXT NOT NULL DEFAULT 'MANUFACTURER'
                          CHECK (responsibility IN ('MANUFACTURER','SHOP','CUSTOMER','CARRIER','INSTALLER')),
    chargeable            INTEGER NOT NULL DEFAULT 0,
    in_cover_at_open      INTEGER NOT NULL DEFAULT 0,
    cover_status          TEXT,
    cover_expires_on      TEXT,
    cover_days_remaining  INTEGER,
    fault_description     TEXT NOT NULL,
    diagnosis             TEXT,
    outcome               TEXT CHECK (outcome IS NULL OR
                          outcome IN ('REPAIRED','REPLACED','REFUNDED','PARTS_ISSUED','OUT_OF_COVER','CUSTOMER_FAULT','NOT_RESOLVED')),
    -- The manufacturer's own reference. Without it a claim sent away is
    -- untraceable, which is how a ₦400,000 compressor disappears.
    rma_number            TEXT,
    manufacturer_contact  TEXT,
    sent_to_manufacturer_at TEXT,
    expected_return_date  TEXT,
    -- MONEY.
    quoted_amount_kobo    INTEGER NOT NULL DEFAULT 0,
    approved_amount_kobo  INTEGER NOT NULL DEFAULT 0,
    repair_cost_kobo      INTEGER NOT NULL DEFAULT 0,
    parts_cost_kobo       INTEGER NOT NULL DEFAULT 0,
    charged_to_customer_kobo INTEGER NOT NULL DEFAULT 0,
    recovered_from_manufacturer_kobo INTEGER NOT NULL DEFAULT 0,
    refund_kobo           INTEGER NOT NULL DEFAULT 0,
    -- A replacement issues a NEW serial and decrements stock; the old one goes
    -- to status REPLACED. Recording both keeps the stock report honest.
    replacement_serial_id TEXT REFERENCES serial_numbers(id),
    replacement_serial_number TEXT,
    service_agent_id      TEXT REFERENCES suppliers(id),
    technician_id         TEXT REFERENCES users(id),
    opened_by             TEXT NOT NULL REFERENCES users(id),
    opened_on             TEXT NOT NULL,
    resolved_by           TEXT REFERENCES users(id),
    resolved_on           TEXT,
    customer_satisfaction INTEGER CHECK (customer_satisfaction IS NULL OR customer_satisfaction BETWEEN 1 AND 5),
    notes                 TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted            INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_warranty_claims_number ON warranty_claims(business_id, claim_number) WHERE is_deleted = 0;
CREATE INDEX idx_warranty_claims_serial ON warranty_claims(serial_id) WHERE is_deleted = 0;
CREATE INDEX idx_warranty_claims_customer ON warranty_claims(customer_id) WHERE is_deleted = 0;
CREATE INDEX idx_warranty_claims_open ON warranty_claims(status, opened_on) WHERE is_deleted = 0;
CREATE INDEX idx_warranty_claims_product ON warranty_claims(product_id, opened_on) WHERE is_deleted = 0;
CREATE INDEX idx_warranty_claims_rma ON warranty_claims(rma_number) WHERE rma_number IS NOT NULL AND is_deleted = 0;

-- Claim status changes are logged: a claim that sits in ASSESSING for six weeks
-- needs to be findable, and "who told the customer it would be ready Friday?"
-- needs an answer.
CREATE TABLE warranty_claim_events (
    id            TEXT PRIMARY KEY,
    claim_id      TEXT NOT NULL REFERENCES warranty_claims(id),
    event_type    TEXT NOT NULL
                  CHECK (event_type IN ('OPENED','STATUS_CHANGE','CONTACTED_CUSTOMER','SENT_TO_MANUFACTURER',
                                        'RECEIVED_BACK','QUOTED','APPROVED','REJECTED','REPAIRED','REPLACED',
                                        'REFUNDED','COMPLETED','CANCELLED','NOTE','ESCALATED')),
    from_status   TEXT,
    to_status     TEXT,
    description   TEXT,
    amount_kobo   INTEGER,
    performed_by  TEXT NOT NULL REFERENCES users(id),
    occurred_at   TEXT NOT NULL DEFAULT (datetime('now')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_warranty_claim_events_claim ON warranty_claim_events(claim_id, occurred_at);

-- ---------------------------------------------------------------------
-- DELIVERY ZONES  (the fee table)
-- ---------------------------------------------------------------------
-- Nigerian cities price delivery by distance AND difficulty. Ikeja to Lekki is
-- a different job from Ikeja to Agege, and a third-floor walk-up with no lift
-- is a different job from a ground-floor shop. A flat "₦5,000 delivery" guess
-- loses money on every island job and overcharges every mainland one.
CREATE TABLE delivery_zones (
    id                  TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    -- NULL = applies to every branch of the business.
    branch_id           TEXT REFERENCES branches(id),
    code                TEXT NOT NULL,
    name                TEXT NOT NULL,
    state_code          TEXT,
    lga                 TEXT,
    area                TEXT,
    -- Every component is itemised and shown on the quote, because "₦25,000
    -- delivery" with no breakdown is the most-argued line on a furniture
    -- invoice. Showing the arithmetic ends the argument before it starts.
    base_fee            REAL NOT NULL DEFAULT 0,
    per_km_fee          REAL NOT NULL DEFAULT 0,
    bulky_surcharge     REAL NOT NULL DEFAULT 0,
    bulky_surcharge_cap REAL,
    floor_surcharge     REAL NOT NULL DEFAULT 0,
    installation_fee    REAL NOT NULL DEFAULT 0,
    two_man_surcharge   REAL NOT NULL DEFAULT 0,
    minimum_fee         REAL NOT NULL DEFAULT 0,
    -- Approximate distance from the originating branch, so a quote can be
    -- produced before anyone opens a map.
    default_distance_km REAL,
    -- Which branches may deliver here, as JSON array of branch ids (NULL = all).
    excluded_branch_ids_json TEXT,
    estimated_hours     REAL,
    -- A zone that is genuinely unreachable (a creek settlement, a security
    -- restriction) is marked rather than quietly quoted an absurd fee.
    is_serviceable      INTEGER NOT NULL DEFAULT 1,
    serviceability_note TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_delivery_zones_code ON delivery_zones(business_id, code) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_zones_branch ON delivery_zones(branch_id, is_active) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_zones_state ON delivery_zones(state_code) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- DELIVERY JOBS
-- ---------------------------------------------------------------------
-- WHEN DOES A DELIVERED ITEM LEAVE STOCK? On DISPATCH, not on delivery. The
-- moment an item is loaded onto a truck it is no longer sellable from the
-- branch, and a POS that can still sell it will sell the same fridge twice.
--   sale completed    -> stock decremented (normal)
--   job created       -> stock RESERVED against the job
--   job dispatched    -> reservation released, movement DELIVERY_DISPATCH
--   job delivered     -> nothing further to stock; proof captured
--   job failed        -> goods return to sellable stock (movement SALE_RETURN)
CREATE TABLE delivery_jobs (
    id                   TEXT PRIMARY KEY,
    business_id          TEXT NOT NULL REFERENCES businesses(id),
    branch_id            TEXT NOT NULL REFERENCES branches(id),
    job_number           TEXT NOT NULL,
    sale_id              TEXT REFERENCES sales(id),
    customer_id          TEXT NOT NULL REFERENCES customers(id),
    job_type             TEXT NOT NULL DEFAULT 'DELIVERY'
                         CHECK (job_type IN ('DELIVERY','INSTALLATION','DELIVERY_AND_INSTALLATION','ASSEMBLY',
                                             'PICKUP','RETURN_COLLECTION','SITE_SURVEY')),
    status               TEXT NOT NULL DEFAULT 'SCHEDULED'
                         CHECK (status IN ('SCHEDULED','CONFIRMED','DISPATCHED','IN_TRANSIT','DELIVERED',
                                           'PARTIALLY_DELIVERED','FAILED','CANCELLED','RESCHEDULED')),
    priority             TEXT NOT NULL DEFAULT 'NORMAL'
                         CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    scheduled_date       TEXT NOT NULL,
    window_start         TEXT,
    window_end           TEXT,
    rescheduled_from     TEXT,
    reschedule_reason    TEXT,
    -- WHERE.
    address              TEXT NOT NULL,
    landmark             TEXT,
    area                 TEXT,
    lga                  TEXT,
    state_code           TEXT,
    zone_id              TEXT REFERENCES delivery_zones(id),
    zone_code            TEXT,
    distance_km          REAL,
    delivery_latitude    REAL,
    delivery_longitude   REAL,
    floors               INTEGER NOT NULL DEFAULT 0,
    has_lift             INTEGER NOT NULL DEFAULT 1,
    needs_two_man        INTEGER NOT NULL DEFAULT 0,
    access_notes         TEXT,               -- "gate code 4412", "call on arrival", "no truck access after 6pm"
    contact_name         TEXT,
    contact_phone        TEXT,
    alt_contact_phone    TEXT,
    -- WHO AND WHAT WITH.
    driver_id            TEXT REFERENCES users(id),
    driver_name          TEXT,
    assistant_id         TEXT REFERENCES users(id),
    installer_id         TEXT REFERENCES users(id),
    vehicle_type         TEXT CHECK (vehicle_type IS NULL OR
                         vehicle_type IN ('BIKE','CAR','VAN','TRUCK_3T','TRUCK_7T','TIPPER','FLATBED','HIAB_CRANE','CUSTOMER_OWN')),
    vehicle_registration TEXT,
    dispatched_at        TEXT,
    dispatched_by        TEXT REFERENCES users(id),
    arrived_at           TEXT,
    completed_at         TEXT,
    -- MONEY.
    fee_kobo             INTEGER NOT NULL DEFAULT 0,
    fee                  REAL NOT NULL DEFAULT 0,
    fee_breakdown_json   TEXT,          -- the itemised components from quoteDelivery()
    fee_collected        INTEGER NOT NULL DEFAULT 0,
    fee_collected_at     TEXT,
    fee_collected_by     TEXT REFERENCES users(id),
    installation_fee_kobo INTEGER NOT NULL DEFAULT 0,
    redelivery_fee_kobo  INTEGER NOT NULL DEFAULT 0,
    cod_amount_kobo      INTEGER NOT NULL DEFAULT 0,   -- cash to collect on delivery
    cod_collected_kobo   INTEGER NOT NULL DEFAULT 0,
    tip_kobo             INTEGER NOT NULL DEFAULT 0,
    -- OUTCOME AND EVIDENCE. Proof of delivery is not optional: "the customer
    -- says it never arrived" is unanswerable without it and answerable in one
    -- screen with it.
    failure_reason       TEXT CHECK (failure_reason IS NULL OR failure_reason IN
                         ('CUSTOMER_NOT_AVAILABLE','WRONG_ADDRESS','ACCESS_DIFFICULT','PAYMENT_NOT_CLEARED',
                          'VEHICLE_BREAKDOWN','ITEM_DAMAGED_IN_TRANSIT','CUSTOMER_REFUSED','SECURITY_CHECKPOINT',
                          'WEATHER','OTHER')),
    failure_note         TEXT,
    attempt_count        INTEGER NOT NULL DEFAULT 0,
    on_time              INTEGER,
    receiver_name        TEXT,
    receiver_phone       TEXT,
    receiver_relationship TEXT,
    signature_captured   INTEGER NOT NULL DEFAULT 0,
    signature_data_url   TEXT,
    photo_captured       INTEGER NOT NULL DEFAULT 0,
    photo_data_urls_json TEXT,
    proof_latitude       REAL,
    proof_longitude      REAL,
    proof_captured_at    TEXT,
    customer_rating      INTEGER CHECK (customer_rating IS NULL OR customer_rating BETWEEN 1 AND 5),
    customer_feedback    TEXT,
    created_by           TEXT NOT NULL REFERENCES users(id),
    notes                TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted           INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_delivery_jobs_number ON delivery_jobs(business_id, job_number) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_jobs_branch_date ON delivery_jobs(branch_id, scheduled_date, status) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_jobs_driver ON delivery_jobs(driver_id, scheduled_date) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_jobs_sale ON delivery_jobs(sale_id) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_jobs_customer ON delivery_jobs(customer_id) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_jobs_open ON delivery_jobs(status, scheduled_date)
    WHERE status IN ('SCHEDULED','CONFIRMED','DISPATCHED','IN_TRANSIT') AND is_deleted = 0;
-- Slot capacity: a branch has a finite number of trucks, and letting a cashier
-- book 40 deliveries for Saturday is how a shop breaks a promise it cannot keep.
CREATE INDEX idx_delivery_jobs_slot ON delivery_jobs(branch_id, scheduled_date, window_start) WHERE is_deleted = 0;

CREATE TABLE delivery_job_items (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES delivery_jobs(id),
    sale_item_id    TEXT REFERENCES sale_items(id),
    product_id      TEXT NOT NULL REFERENCES products(id),
    product_name    TEXT NOT NULL,
    serial_id       TEXT REFERENCES serial_numbers(id),
    serial_number   TEXT,
    stock_batch_id  TEXT REFERENCES stock_batches(id),
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    quantity_delivered INTEGER NOT NULL DEFAULT 0,
    is_bulky        INTEGER NOT NULL DEFAULT 0,
    installed       INTEGER NOT NULL DEFAULT 0,
    installed_at    TEXT,
    installed_by    TEXT REFERENCES users(id),
    condition_on_arrival TEXT CHECK (condition_on_arrival IS NULL OR
                        condition_on_arrival IN ('GOOD','DAMAGED','MISSING','WRONG_ITEM')),
    damage_note     TEXT,
    reserved        INTEGER NOT NULL DEFAULT 1,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_delivery_job_items_job ON delivery_job_items(job_id) WHERE is_deleted = 0;
CREATE INDEX idx_delivery_job_items_serial ON delivery_job_items(serial_id) WHERE is_deleted = 0;

-- Each attempt is recorded, including failures. A failed attempt is a business
-- event with money attached: the truck went out, the fuel was burned, the
-- driver was paid. Whether it is chargeable depends on WHOSE fault it was, and
-- that determination is in the code, not left to whoever is on shift.
CREATE TABLE delivery_attempts (
    id                TEXT PRIMARY KEY,
    job_id            TEXT NOT NULL REFERENCES delivery_jobs(id),
    attempt_number    INTEGER NOT NULL,
    attempted_at      TEXT NOT NULL DEFAULT (datetime('now')),
    outcome           TEXT NOT NULL CHECK (outcome IN ('DELIVERED','PARTIALLY_DELIVERED','FAILED','CANCELLED')),
    failure_reason    TEXT,
    driver_id         TEXT REFERENCES users(id),
    vehicle_registration TEXT,
    arrived_latitude  REAL,
    arrived_longitude REAL,
    distance_from_address_m INTEGER,
    receiver_name     TEXT,
    proof_captured    INTEGER NOT NULL DEFAULT 0,
    chargeable        INTEGER NOT NULL DEFAULT 0,
    redelivery_fee_kobo INTEGER NOT NULL DEFAULT 0,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_delivery_attempts_job ON delivery_attempts(job_id, attempt_number);

-- ---------------------------------------------------------------------
-- COMPLIANCE CERTIFICATES  (dated obligations that lapse)
-- ---------------------------------------------------------------------
-- Replaces the pharmacy schema's two hard-coded licence columns
-- (pcn_license_expiry_date, superintendent_registration_expiry_date) with a
-- generic table. Every Nigerian business has dated permissions that expire;
-- which ones depends on what it trades in:
--   all            CAC registration, state trading permit, LG signage levy
--   electronics    SONCAP product certificate, NCC type approval
--   food/cosmetics NAFDAC registration, NAFDAC premises, LG food handling
--   building       SON/NIS conformity, NESREA, mines & quarry permit
--   any premises   fire safety certificate
--
-- The expiry-alert view is then ONE query over this table instead of two
-- hard-coded columns, and adding a new obligation type is a row, not a
-- migration.
CREATE TABLE compliance_certificates (
    id                  TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    -- NULL = the obligation belongs to the business; SET = to one branch.
    branch_id           TEXT REFERENCES branches(id),
    -- NULL = applies to everything the business sells; SET = one product or
    -- category (a SONCAP PC number is per product family).
    product_id          TEXT REFERENCES products(id),
    category_id         TEXT REFERENCES product_categories(id),
    certificate_type    TEXT NOT NULL,     -- 'CAC','SONCAP','NAFDAC','SON','NIS','FIRE_SAFETY',...
    certificate_number  TEXT NOT NULL,
    issuing_authority   TEXT,              -- 'SON', 'NAFDAC', 'CAC', 'Lagos State Ministry of Commerce'
    holder_name         TEXT,              -- e.g. the superintendent, the importer of record
    issue_date          TEXT,
    expiry_date         TEXT,
    -- Advance warning. Different obligations need different lead times: a
    -- SONCAP renewal blocks importing entirely, so 90 days; an LG signage levy
    -- is a fine, so 30.
    alert_days_before   INTEGER NOT NULL DEFAULT 60,
    status              TEXT NOT NULL DEFAULT 'VALID'
                        CHECK (status IN ('VALID','EXPIRING_SOON','EXPIRED','SUSPENDED','REVOKED','PENDING_RENEWAL','NOT_APPLICABLE')),
    renewal_cost        REAL,
    renewal_agent       TEXT,
    -- The document itself. A certificate nobody can produce when an inspector
    -- visits is a certificate that does not help.
    document_data_url   TEXT,
    document_filename   TEXT,
    last_reminded_at    TEXT,
    reminder_count      INTEGER NOT NULL DEFAULT 0,
    verified_by         TEXT REFERENCES users(id),
    verified_at         TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_compliance_business ON compliance_certificates(business_id, expiry_date) WHERE is_deleted = 0;
CREATE INDEX idx_compliance_expiry ON compliance_certificates(expiry_date, status) WHERE is_deleted = 0;
CREATE UNIQUE INDEX idx_compliance_unique
    ON compliance_certificates(business_id, certificate_type, certificate_number) WHERE is_deleted = 0;
CREATE INDEX idx_compliance_product ON compliance_certificates(product_id) WHERE product_id IS NOT NULL AND is_deleted = 0;

-- ---------------------------------------------------------------------
-- SALE AUTHORITY DOCUMENTS  (replaces `prescriptions`)
-- ---------------------------------------------------------------------
-- The pharmacy needed a prescriber and a patient before dispensing a POM. The
-- general equivalent is: some sales need an authorising document before they
-- may complete. A corporate purchase order, a consultant's approval, a
-- contractor's letter, a government award letter, an insurance authorisation.
--
-- The MECHANISM is identical — a document linked to a sale, captured before
-- completion, retained for audit — and so is the reason it exists: without it,
-- "who authorised this?" has no answer six months later when the customer
-- disputes the invoice.
CREATE TABLE sale_authority_documents (
    id                  TEXT PRIMARY KEY,
    sale_id             TEXT REFERENCES sales(id),
    sale_item_id        TEXT REFERENCES sale_items(id),
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    branch_id           TEXT NOT NULL REFERENCES branches(id),
    -- What kind of authority. A PO number and a consultant's signature are
    -- different evidence with different retention needs.
    document_type       TEXT NOT NULL
                        CHECK (document_type IN ('PURCHASE_ORDER','WORKS_INSTRUCTION','CONSULTANT_APPROVAL',
                                                 'CONTRACTOR_LETTER','GOVERNMENT_AWARD','INSURANCE_AUTHORISATION',
                                                 'PRO_FORMA_ACCEPTANCE','PARENT_GUARDIAN_CONSENT','OTHER')),
    document_reference  TEXT NOT NULL,
    -- WHO authorised it. Named, with contact details, so it can be verified.
    authorising_party   TEXT NOT NULL,
    authorising_person  TEXT,
    authorising_title   TEXT,
    authorising_phone   TEXT,
    authorising_email   TEXT,
    organisation_name   TEXT,
    organisation_tin    TEXT,
    issue_date          TEXT,
    valid_until         TEXT,
    amount_authorised   REAL,
    -- A project sale may be authorised up to a ceiling; recording it means a
    -- second sale against the same PO can be checked against what is left.
    amount_used         REAL NOT NULL DEFAULT 0,
    document_data_url   TEXT,
    document_filename   TEXT,
    verified_by         TEXT REFERENCES users(id),
    verified_at         TEXT,
    captured_by         TEXT NOT NULL REFERENCES users(id),
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_authority_docs_sale ON sale_authority_documents(sale_id) WHERE is_deleted = 0;
CREATE INDEX idx_authority_docs_ref ON sale_authority_documents(document_reference) WHERE is_deleted = 0;
CREATE INDEX idx_authority_docs_party ON sale_authority_documents(authorising_party) WHERE is_deleted = 0;
