-- =====================================================================
-- STOCKRIDGE — migration 0004: tamper-evident registers, WHT, FX, holidays
-- =====================================================================

-- ---------------------------------------------------------------------
-- HASH-CHAINED REGISTERS  (replaces controlled_substance_register)
-- ---------------------------------------------------------------------
-- The pharmacy kept an APPEND-ONLY, HASH-CHAINED log of every controlled-drug
-- dispense: each row stored the hash of the row before it, so editing or
-- deleting a row in the middle broke every subsequent link and a verification
-- query found exactly where.
--
-- That control was never really about drugs. It is the answer to: "how do you
-- make a record that a dishonest insider cannot quietly rewrite?" StockRidge
-- keeps the mechanism and generalises the purpose across four registers:
--
--   HIGH_VALUE_REGISTER       every sale of a register-required line (phones,
--                             laptops, generators, mattresses on credit):
--                             buyer name, phone, ID type and number, serial(s),
--                             price, who rang it up. When a branch reports a
--                             missing laptop this is the record that says
--                             whether it was ever sold, and to whom.
--   AGE_VERIFICATION_LOG      every alcohol/tobacco/solvent sale where the
--                             operator confirmed the buyer's age. Recorded
--                             because a shop that cannot evidence the check has
--                             no defence.
--   AUTHORITY_DOCUMENT_LOG    project and government sales where an authorising
--                             document was required. Chained so a back-dated PO
--                             cannot be inserted to justify a sale that already
--                             happened.
--   CASH_MOVEMENT_CHAIN       large safe withdrawals and till voids, per branch
--                             per day.
--   DATA_EXPORT_LOG           who exported the customer list, and when. A
--                             customer list is saleable to a competitor, so its
--                             exfiltration is a real risk with a real trail.
--   PRICE_OVERRIDE_LOG        every manual price change above a threshold.
--
-- WHAT THIS IS NOT: not a blockchain, not distributed, not immutable. A
-- determined attacker with database write access can recompute the whole chain.
-- What it does is make a rewrite EXPENSIVE, VISIBLE and PROVABLE: delete one
-- row to hide one sale and you must recompute every row after it, and the
-- verification query shows the break the moment anyone runs it. For the actual
-- threat model — a store manager covering a theft — that is a sufficient
-- deterrent.
--
-- SCOPED PER BRANCH PER DAY. A single global chain would make a Lagos sale and
-- a Kano sale compete for the same previous-hash link, serialising writes
-- across the whole business and making offline branches impossible. Independent
-- scopes let an offline branch extend its own chain locally and let the server
-- verify it on sync.
CREATE TABLE hash_chained_registers (
    id             TEXT PRIMARY KEY,
    register_type  TEXT NOT NULL
                   CHECK (register_type IN ('HIGH_VALUE_REGISTER','AGE_VERIFICATION_LOG','AUTHORITY_DOCUMENT_LOG',
                                            'CASH_MOVEMENT_CHAIN','DATA_EXPORT_LOG','PRICE_OVERRIDE_LOG')),
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    chain_key      TEXT NOT NULL,       -- register::branch::day
    chain_day      TEXT NOT NULL,       -- YYYY-MM-DD in WAT
    -- The chain. prev_hash of the first row in a scope is the published genesis
    -- value, NOT NULL — so "no previous row" and "the previous row was deleted"
    -- are distinguishable, and a NULL prev_hash on row 5 is tampering.
    prev_hash      TEXT NOT NULL,
    row_hash       TEXT NOT NULL,
    version        INTEGER NOT NULL DEFAULT 1,
    seq            INTEGER NOT NULL DEFAULT 1,
    -- The canonical payload that was hashed, stored verbatim. Hashing one thing
    -- and storing another is the mistake that makes a chain unverifiable.
    payload_json   TEXT NOT NULL,

    -- Common fields, flattened out of the payload for querying. The payload
    -- remains authoritative for verification.
    sale_id        TEXT REFERENCES sales(id),
    sale_number    TEXT,
    product_id     TEXT REFERENCES products(id),
    product_name   TEXT,
    serial_numbers TEXT,
    quantity       INTEGER,
    unit_price_kobo INTEGER,
    total_amount_kobo INTEGER,
    buyer_name     TEXT,
    buyer_phone    TEXT,
    buyer_address  TEXT,
    id_type        TEXT CHECK (id_type IS NULL OR id_type IN
                   ('NIN','BVN','DRIVERS_LICENCE','INTERNATIONAL_PASSPORT','VOTERS_CARD','STUDENT_ID',
                    'WORK_ID','COMPANY_CAC','UTILITY_BILL','OTHER')),
    id_number      TEXT,
    -- AGE_VERIFICATION_LOG
    buyer_age_stated INTEGER,
    age_confirmed_by TEXT,
    id_checked     INTEGER NOT NULL DEFAULT 0,
    -- AUTHORITY_DOCUMENT_LOG
    document_type  TEXT,
    document_reference TEXT,
    authorising_party TEXT,
    -- CASH_MOVEMENT_CHAIN
    cash_direction TEXT CHECK (cash_direction IS NULL OR cash_direction IN ('IN','OUT')),
    cash_amount_kobo INTEGER,
    -- DATA_EXPORT_LOG / PRICE_OVERRIDE_LOG
    export_scope   TEXT,
    export_row_count INTEGER,
    price_old_kobo INTEGER,
    price_new_kobo INTEGER,

    recorded_by    TEXT NOT NULL REFERENCES users(id),
    device_id      TEXT,
    recorded_at    TEXT NOT NULL DEFAULT (datetime('now')),
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    -- NO updated_at AND NO is_deleted. This table is append-only BY DESIGN:
    -- a tamper-evident log that supports UPDATE or DELETE is not one. The
    -- absence of those columns is the point, not an oversight, and the
    -- application never issues either statement against this table.
    CHECK (length(row_hash) = 64),
    CHECK (length(prev_hash) = 64)
);
CREATE UNIQUE INDEX idx_hcr_chain_link ON hash_chained_registers(chain_key, prev_hash);
CREATE UNIQUE INDEX idx_hcr_chain_seq ON hash_chained_registers(chain_key, seq);
CREATE INDEX idx_hcr_type_day ON hash_chained_registers(register_type, chain_day);
CREATE INDEX idx_hcr_branch ON hash_chained_registers(branch_id, recorded_at);
CREATE INDEX idx_hcr_sale ON hash_chained_registers(sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX idx_hcr_buyer ON hash_chained_registers(buyer_phone) WHERE buyer_phone IS NOT NULL;
CREATE INDEX idx_hcr_serial ON hash_chained_registers(serial_numbers) WHERE serial_numbers IS NOT NULL;

-- The last hash per scope, cached so appending a row is one read rather than a
-- scan of the whole chain. Recomputed from the chain on verification, so a
-- corrupted cache cannot corrupt the chain itself.
CREATE TABLE hash_chain_heads (
    chain_key      TEXT PRIMARY KEY,
    register_type  TEXT NOT NULL,
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    chain_day      TEXT NOT NULL,
    last_row_id    TEXT NOT NULL REFERENCES hash_chained_registers(id),
    last_row_hash  TEXT NOT NULL,
    row_count      INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Verification runs. A chain nobody ever verifies is a chain whose break will
-- be discovered by whoever benefits from it, or by nobody.
CREATE TABLE hash_chain_verifications (
    id               TEXT PRIMARY KEY,
    register_type    TEXT NOT NULL,
    business_id      TEXT REFERENCES businesses(id),
    branch_id        TEXT REFERENCES branches(id),
    chain_key        TEXT,
    scope_from       TEXT,
    scope_to         TEXT,
    rows_checked     INTEGER NOT NULL DEFAULT 0,
    is_intact        INTEGER NOT NULL DEFAULT 1,
    break_count      INTEGER NOT NULL DEFAULT 0,
    first_break_index INTEGER,
    breaks_json      TEXT,
    verified_by      TEXT REFERENCES users(id),   -- NULL = the scheduled job
    verified_at      TEXT NOT NULL DEFAULT (datetime('now')),
    notes            TEXT
);
CREATE INDEX idx_hcv_register ON hash_chain_verifications(register_type, verified_at);
CREATE INDEX idx_hcv_broken ON hash_chain_verifications(is_intact, verified_at) WHERE is_intact = 0;

-- ---------------------------------------------------------------------
-- WITHHOLDING TAX
-- ---------------------------------------------------------------------
-- RATES ARE DATA, NOT CODE. The Deduction of Tax at Source (Withholding)
-- Regulations 2024 (effective 1 January 2025) changed rates materially and
-- introduced a differential structure by company size. Hard-coding a percentage
-- would mean a statutory change requires a deployment while the client is
-- mid-quarter. Nothing in the application code contains a WHT percentage.
CREATE TABLE wht_rates (
    id                  TEXT PRIMARY KEY,
    code                TEXT NOT NULL UNIQUE,        -- 'RENT','SUPPLY','CONSULTANCY',...
    description         TEXT NOT NULL,
    -- The 2024 Regulations differentiate by the deducting entity's size:
    --   Small   turnover <= ₦25m
    --   Medium  turnover <= ₦100m
    --   Large   turnover >  ₦100m
    rate_percent_small  REAL NOT NULL DEFAULT 0 CHECK (rate_percent_small  >= 0 AND rate_percent_small  <= 100),
    rate_percent_medium REAL NOT NULL DEFAULT 0 CHECK (rate_percent_medium >= 0 AND rate_percent_medium <= 100),
    rate_percent_large  REAL NOT NULL DEFAULT 0 CHECK (rate_percent_large  >= 0 AND rate_percent_large  <= 100),
    -- A single rate_percent remains for simple schedules and for backwards
    -- compatibility; resolveSizeColumn() prefers the size-specific columns.
    rate_percent        REAL NOT NULL DEFAULT 0 CHECK (rate_percent >= 0 AND rate_percent <= 100),
    -- PAYABLE   = we deduct from a supplier
    -- RECEIVABLE = a customer deducts from us
    -- A RECEIVABLE-only rate must not be usable on a supplier payment. That
    -- check is the difference between a WHT schedule and a WHT schedule that
    -- quietly lets you book a receivable as a payable.
    direction           TEXT NOT NULL DEFAULT 'BOTH'
                        CHECK (direction IN ('PAYABLE','RECEIVABLE','BOTH')),
    statutory_reference TEXT,           -- e.g. 'WHT Regulations 2024, Sch. 1'
    effective_from      TEXT,
    effective_to        TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_wht_rates_code ON wht_rates(code);
CREATE INDEX idx_wht_rates_active ON wht_rates(is_active, direction) WHERE is_deleted = 0;

CREATE TABLE wht_entries (
    id                  TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL REFERENCES businesses(id),
    branch_id           TEXT REFERENCES branches(id),
    rate_code           TEXT NOT NULL REFERENCES wht_rates(code),
    direction           TEXT NOT NULL CHECK (direction IN ('PAYABLE','RECEIVABLE')),
    entry_date          TEXT NOT NULL,
    -- GROSS IN, NET OUT. A business always knows the invoice value; asking it
    -- to supply the net would mean grossing up, which is exactly the "WHT as an
    -- additional contract cost" practice the 2024 Regulations prohibit.
    gross_amount_kobo   INTEGER NOT NULL CHECK (gross_amount_kobo > 0),
    gross_amount        REAL NOT NULL,
    rate_percent        REAL NOT NULL,
    wht_amount_kobo     INTEGER NOT NULL CHECK (wht_amount_kobo >= 0),
    wht_amount          REAL NOT NULL,
    -- NET BY SUBTRACTION. Rounding both legs independently is the classic way
    -- `gross = net + wht` fails by a kobo — and the CHECK below then rejects an
    -- otherwise-correct entry, mid-transaction.
    net_amount_kobo     INTEGER NOT NULL,
    net_amount          REAL NOT NULL,
    company_size        TEXT NOT NULL DEFAULT 'SMALL'
                        CHECK (company_size IN ('SMALL','MEDIUM','LARGE')),
    source_type         TEXT NOT NULL
                        CHECK (source_type IN ('EXPENSE','PURCHASE','SALE','CREDIT_NOTE','RENT','CONTRACT','DIVIDEND','INTEREST','MANUAL')),
    source_id           TEXT,
    reference           TEXT,
    -- COUNTERPARTY. A TIN is what makes the small-company exemption arguable,
    -- so its absence is recorded rather than papered over.
    counterparty_name   TEXT NOT NULL,
    counterparty_tin    TEXT,
    counterparty_type   TEXT CHECK (counterparty_type IS NULL OR
                        counterparty_type IN ('COMPANY','INDIVIDUAL','GOVERNMENT','NGO','NON_RESIDENT')),
    supplier_id         TEXT REFERENCES suppliers(id),
    customer_id         TEXT REFERENCES customers(id),
    -- REMITTANCE. Withholding tax is filed on Form 0103 within 21 days of the
    -- month end in which the deduction was made. Missing that window attracts a
    -- penalty, so the due date is computed and stored rather than left to
    -- memory.
    remittance_due_date TEXT,
    remitted            INTEGER NOT NULL DEFAULT 0,
    remitted_at         TEXT,
    remittance_reference TEXT,
    remitted_by         TEXT REFERENCES users(id),
    -- A RECEIVABLE entry is an asset until the credit note lands. Chasing it is
    -- a real task, so its status is tracked rather than assumed.
    credit_note_received INTEGER NOT NULL DEFAULT 0,
    credit_note_reference TEXT,
    credit_note_received_at TEXT,
    status              TEXT NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN','REMITTED','CREDIT_NOTE_RECEIVED','OVERDUE','REVERSED','WAIVED')),
    -- Whether the small-company exemption was CONSIDERED. The hint is advisory
    -- and never blocks; recording that it was shown and dismissed is what stops
    -- the same question being asked every quarter.
    exemption_hint_shown INTEGER NOT NULL DEFAULT 0,
    exemption_applied   INTEGER NOT NULL DEFAULT 0,
    exemption_reason    TEXT,
    created_by          TEXT NOT NULL REFERENCES users(id),
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted          INTEGER NOT NULL DEFAULT 0,
    CHECK (gross_amount_kobo = net_amount_kobo + wht_amount_kobo),
    CHECK (wht_amount_kobo <= gross_amount_kobo)
);
CREATE INDEX idx_wht_entries_branch_date ON wht_entries(branch_id, entry_date) WHERE is_deleted = 0;
CREATE INDEX idx_wht_entries_business ON wht_entries(business_id, entry_date, direction) WHERE is_deleted = 0;
CREATE INDEX idx_wht_entries_source ON wht_entries(source_type, source_id) WHERE is_deleted = 0;
CREATE INDEX idx_wht_entries_remittance ON wht_entries(direction, remittance_due_date, remitted) WHERE is_deleted = 0;
CREATE INDEX idx_wht_entries_overdue ON wht_entries(status, remittance_due_date) WHERE status IN ('OPEN','OVERDUE') AND is_deleted = 0;

-- ---------------------------------------------------------------------
-- FX RATES
-- ---------------------------------------------------------------------
-- NIGERIA HAS HAD TWO EXCHANGE RATES IN PRACTICE. The official CBN window and
-- the parallel market have diverged, sometimes widely. A system that stores one
-- "exchange rate" stores a fiction: the rate a customer was quoted, the rate
-- the goods were bought at, and the rate the bank settled at are three
-- different numbers, and the difference between them is real money that shows
-- up nowhere if the model cannot hold all three.
CREATE TABLE fx_rates (
    id             TEXT PRIMARY KEY,
    currency       TEXT NOT NULL,        -- 'USD','GBP','EUR','CNY','GHS',...
    -- ALWAYS expressed as NGN per 1 unit of `currency`. Storing the inverse is
    -- a real source of 1e6 errors, so the direction is fixed everywhere.
    rate           REAL NOT NULL CHECK (rate > 0),
    source         TEXT NOT NULL
                   CHECK (source IN ('CBN_OFFICIAL','NAFEM','PARALLEL','BANK','SUPPLIER','AGREED','MANUAL')),
    rate_date      TEXT NOT NULL,
    -- A published rate (CBN, parallel) is reference data shared by everyone; a
    -- deal rate is specific to one business's transaction.
    business_id    TEXT REFERENCES businesses(id),
    is_reference   INTEGER NOT NULL DEFAULT 1,
    band_min       REAL,
    band_max       REAL,
    captured_by    TEXT REFERENCES users(id),
    source_url     TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_fx_rates_unique
    ON fx_rates(currency, source, rate_date, business_id) WHERE is_deleted = 0;
CREATE INDEX idx_fx_rates_lookup ON fx_rates(currency, rate_date) WHERE is_deleted = 0;
CREATE INDEX idx_fx_rates_reference ON fx_rates(currency, source, rate_date) WHERE is_reference = 1 AND is_deleted = 0;

-- ---------------------------------------------------------------------
-- PUBLIC HOLIDAYS  (settlement and due-date arithmetic depends on them)
-- ---------------------------------------------------------------------
-- A POS sale on Friday settles Monday; a NET_30 invoice due on 1 January is
-- collectable on the next business day. Hard-coding Nigerian holidays would be
-- wrong within a year (Eid moves, and states declare their own), so they are
-- client data, seeded from the published federal list and editable.
CREATE TABLE public_holidays (
    id            TEXT PRIMARY KEY,
    holiday_date  TEXT NOT NULL,
    name          TEXT NOT NULL,
    -- NULL = federal (applies everywhere). SET = one state only, since several
    -- states declare their own (e.g. Lagos Eid arrangements, state founding days).
    state_code    TEXT,
    holiday_type  TEXT NOT NULL DEFAULT 'FEDERAL'
                  CHECK (holiday_type IN ('FEDERAL','STATE','RELIGIOUS','BANK','CUSTOM')),
    -- A bank holiday stops settlement but not trading; a full holiday stops
    -- both. Treating them the same either delays money that could have arrived
    -- or expects a settlement that cannot happen.
    banks_closed  INTEGER NOT NULL DEFAULT 1,
    trading_affected INTEGER NOT NULL DEFAULT 1,
    year          INTEGER NOT NULL,
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_public_holidays_unique
    ON public_holidays(holiday_date, state_code, name) WHERE is_deleted = 0;
CREATE INDEX idx_public_holidays_year ON public_holidays(year, holiday_date) WHERE is_deleted = 0;

-- ---------------------------------------------------------------------
-- AUDIT LOG  (every mutation that matters, by whom, from where)
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    id             TEXT PRIMARY KEY,
    business_id    TEXT REFERENCES businesses(id),
    branch_id      TEXT REFERENCES branches(id),
    user_id        TEXT REFERENCES users(id),
    user_role      TEXT,
    action         TEXT NOT NULL,        -- 'SALE_VOID','PRICE_OVERRIDE','STOCK_ADJUST','USER_ROLE_CHANGE',...
    entity_type    TEXT NOT NULL,        -- 'sale','product','user','batch',...
    entity_id      TEXT,
    -- Both sides of the change, so "what was it before?" is answerable without
    -- a backup. NULL when the action has no meaningful before-state.
    before_json    TEXT,
    after_json     TEXT,
    reason         TEXT,
    approved_by    TEXT REFERENCES users(id),
    ip_address     TEXT,
    user_agent     TEXT,
    device_id      TEXT,
    severity       TEXT NOT NULL DEFAULT 'INFO'
                   CHECK (severity IN ('INFO','NOTICE','WARNING','CRITICAL')),
    occurred_at    TEXT NOT NULL DEFAULT (datetime('now')),
    -- Append-only in practice: no updated_at, and is_deleted exists only so a
    -- lawful erasure request can be honoured with a record that it happened.
    is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, occurred_at);
CREATE INDEX idx_audit_log_user ON audit_log(user_id, occurred_at);
CREATE INDEX idx_audit_log_branch ON audit_log(branch_id, occurred_at);
CREATE INDEX idx_audit_log_action ON audit_log(action, occurred_at);
CREATE INDEX idx_audit_log_severity ON audit_log(severity, occurred_at) WHERE severity IN ('WARNING','CRITICAL');

-- ---------------------------------------------------------------------
-- LOGIN THROTTLING + AUTHENTICATION AUDIT
-- ---------------------------------------------------------------------
-- WHY: reproduced live against a running system before this table existed —
-- 60 consecutive wrong PINs against the `owner` account all returned a plain
-- 401 in 1,150ms total (19ms per attempt), with no lockout, no throttle, and no
-- record anywhere that it had happened. The correct PIN then worked.
--
-- This product authenticates with SHORT NUMERIC PINs (minimum 4 digits), which
-- is right for a shop floor — a cashier with a queue cannot type a passphrase —
-- but it means the keyspace is 10,000 values, searchable in minutes at 19ms per
-- attempt. So the throttle is not a nice-to-have; it is the only thing standing
-- between a 4-digit PIN and an attacker with a script.
CREATE TABLE login_attempts (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    user_id       TEXT REFERENCES users(id),
    succeeded     INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN
                  ('BAD_PIN','UNKNOWN_USER','INACTIVE_USER','LOCKED_OUT','SUSPENDED_SUBSCRIPTION')),
    ip_address    TEXT,
    user_agent    TEXT,
    device_id     TEXT,
    branch_id     TEXT REFERENCES branches(id),
    attempted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_attempts_username_time ON login_attempts(username, attempted_at);
CREATE INDEX idx_login_attempts_time ON login_attempts(attempted_at);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip_address, attempted_at);

-- Active sessions, so "sign out everywhere" and "who is logged in on this
-- branch right now?" are both answerable, and a stolen token can be revoked
-- without changing the PIN.
CREATE TABLE user_sessions (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    user_id        TEXT NOT NULL REFERENCES users(id),
    branch_id      TEXT REFERENCES branches(id),
    device_id      TEXT,
    ip_address     TEXT,
    user_agent     TEXT,
    issued_at      TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at     TEXT NOT NULL,
    last_seen_at   TEXT,
    revoked_at     TEXT,
    revoked_by     TEXT REFERENCES users(id),
    revoke_reason  TEXT,
    is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_user_sessions_session ON user_sessions(session_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id, expires_at) WHERE revoked_at IS NULL;
