-- =====================================================================
-- STOCKRIDGE — migration 0005: offline sync, idempotency, general ledger
-- =====================================================================

-- ---------------------------------------------------------------------
-- BRANCH SYNC STATUS
-- ---------------------------------------------------------------------
-- The whole point of an offline-first PWA is that a branch with no network
-- keeps trading. The cost is that the manager must be able to SEE which
-- branches are behind, by how much, and since when — otherwise "the numbers are
-- wrong" is indistinguishable from "the numbers are stale".
CREATE TABLE branch_sync_status (
    branch_id            TEXT PRIMARY KEY REFERENCES branches(id),
    business_id          TEXT REFERENCES businesses(id),
    device_id            TEXT,
    device_label         TEXT,
    app_version          TEXT,
    schema_version       INTEGER,
    last_heartbeat_at    TEXT,
    last_push_at         TEXT,       -- last time this branch pushed local changes up
    last_pull_at         TEXT,       -- last time it pulled central reference data down
    -- Self-reported by the device. The server cannot know how many rows a
    -- browser has queued in IndexedDB, so the client tells it — and a number
    -- that never falls is the signal that a queue is stuck.
    pending_push_count   INTEGER NOT NULL DEFAULT 0,
    last_push_row_count  INTEGER NOT NULL DEFAULT 0,
    last_push_duration_ms INTEGER,
    last_sync_error      TEXT,
    last_error_at        TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    -- A branch that has not been heard from in a long while is either closed,
    -- offline or broken. All three need a phone call, so it is surfaced rather
    -- than left to be noticed.
    staleness_minutes    INTEGER,
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only history of every push/pull that touched the server, so a manager
-- (or support) sees sync HISTORY, not just latest state.
CREATE TABLE sync_change_log (
    id             TEXT PRIMARY KEY,
    branch_id      TEXT REFERENCES branches(id),
    business_id    TEXT REFERENCES businesses(id),
    device_id      TEXT,
    user_id        TEXT REFERENCES users(id),
    direction      TEXT NOT NULL CHECK (direction IN ('PUSH','PULL','HEARTBEAT')),
    table_name     TEXT,
    row_count      INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS','PARTIAL','FAILED','REJECTED')),
    error_message  TEXT,
    error_code     TEXT,
    duration_ms    INTEGER,
    payload_bytes  INTEGER,
    synced_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sync_change_log_synced_at ON sync_change_log(synced_at);
CREATE INDEX idx_sync_change_log_branch ON sync_change_log(branch_id, synced_at);
CREATE INDEX idx_sync_change_log_failures ON sync_change_log(status, synced_at) WHERE status IN ('FAILED','PARTIAL','REJECTED');

-- ---------------------------------------------------------------------
-- SYNC CONFLICTS
-- ---------------------------------------------------------------------
-- The table-level push mechanism resolves concurrent edits to the SAME row from
-- two offline branches via last-write-wins on updated_at. LWW is simple and fine
-- for the common case, but it has a real failure mode: if Lekki and Kano both
-- edit the same shared customer while both are offline (Lekki the phone number,
-- Kano the address), the row that syncs SECOND silently overwrites the first —
-- Kano's address survives, Lekki's phone change is gone, with no error, no
-- warning, nothing in the history.
--
-- This table does not PREVENT that (a full CRDT merge is a much larger
-- undertaking). It makes it VISIBLE: every time an upsert is about to discard a
-- losing write — not merely skip a stale no-op — the discarded version is
-- recorded here BEFORE the overwrite, so a manager can review what was lost and
-- reconcile it if it mattered. That closes the "nobody would ever know" gap,
-- which is the gap that actually costs money.
CREATE TABLE sync_conflicts (
    id                   TEXT PRIMARY KEY,
    table_name           TEXT NOT NULL,
    row_id               TEXT NOT NULL,
    business_id          TEXT REFERENCES businesses(id),
    branch_id            TEXT REFERENCES branches(id),     -- branch whose push caused the overwrite
    device_id            TEXT,
    losing_branch_id     TEXT REFERENCES branches(id),     -- branch whose edit was discarded
    losing_version_json  TEXT NOT NULL,   -- full snapshot of the row about to be discarded
    winning_version_json TEXT NOT NULL,   -- full snapshot of the incoming row
    -- Which fields actually differed. A manager reviewing 40 conflicts needs to
    -- see that 38 of them are just updated_at noise and two are real.
    differing_fields_json TEXT,
    severity             TEXT NOT NULL DEFAULT 'INFO'
                         CHECK (severity IN ('INFO','NOTICE','CRITICAL')),
    auto_resolved        INTEGER NOT NULL DEFAULT 1,
    detected_at          TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by          TEXT REFERENCES users(id),
    reviewed_at          TEXT,
    resolution           TEXT CHECK (resolution IS NULL OR
                         resolution IN ('ACCEPT_WINNER','RESTORE_LOSER','MERGED','NO_ACTION_NEEDED','ESCALATED')),
    resolution_note      TEXT
);
CREATE INDEX idx_sync_conflicts_unreviewed ON sync_conflicts(detected_at) WHERE reviewed_by IS NULL;
CREATE INDEX idx_sync_conflicts_table ON sync_conflicts(table_name, row_id);
CREATE INDEX idx_sync_conflicts_critical ON sync_conflicts(severity, detected_at) WHERE severity = 'CRITICAL';

-- ---------------------------------------------------------------------
-- IDEMPOTENCY KEYS
-- ---------------------------------------------------------------------
-- Protects every mutating request against duplicate execution when a client
-- retries after losing the response (flaky connection, or the offline queue
-- replaying a request that actually already succeeded before connectivity
-- dropped). The client sends the same Idempotency-Key header on every attempt
-- of the SAME logical action; the server executes it once and replays the stored
-- response for any repeat.
--
-- This is what makes it safe for the PWA's offline queue to blindly retry
-- queued sales without risking double stock deduction, double cash counted, or
-- two register entries for one laptop.
CREATE TABLE idempotency_keys (
    idempotency_key   TEXT NOT NULL,
    user_id           TEXT NOT NULL REFERENCES users(id),
    business_id       TEXT REFERENCES businesses(id),
    branch_id         TEXT REFERENCES branches(id),
    method            TEXT NOT NULL,
    path              TEXT NOT NULL,
    -- A hash of the request body, to detect a key being REUSED for a different
    -- request. Without it, a client bug that reuses a key would silently replay
    -- yesterday's response to today's different question.
    request_hash      TEXT NOT NULL,
    response_status   INTEGER,
    response_body     TEXT,             -- JSON, replayed verbatim on retry
    status            TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                      CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
    device_id         TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at      TEXT,
    expires_at        TEXT,
    PRIMARY KEY (idempotency_key, user_id)
);
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);
CREATE INDEX idx_idempotency_keys_expiry ON idempotency_keys(expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- GENERAL LEDGER
-- ---------------------------------------------------------------------
-- Double-entry. Every sale, receipt, expense, adjustment, WHT entry and FX
-- movement posts a balanced journal entry. This is what makes the P&L and
-- balance sheet auditable rather than merely computed: a report derived from
-- operational tables can be wrong in a way nobody can check, whereas a trial
-- balance that does not balance is wrong in a way anyone can see.
CREATE TABLE gl_accounts (
    id             TEXT PRIMARY KEY,
    business_id    TEXT REFERENCES businesses(id),   -- NULL = a system account shared by all
    code           TEXT NOT NULL,        -- '1000','4000','5100' — the chart-of-accounts number
    name           TEXT NOT NULL,
    account_type   TEXT NOT NULL
                   CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
    sub_type       TEXT,                 -- 'CURRENT_ASSET','FIXED_ASSET','CURRENT_LIABILITY','COGS','OPEX',...
    normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
    parent_id      TEXT REFERENCES gl_accounts(id),
    is_system      INTEGER NOT NULL DEFAULT 0,   -- a system account cannot be deleted or renamed
    is_active      INTEGER NOT NULL DEFAULT 1,
    -- Whether this account should appear in the VAT return, and on which line.
    vat_treatment  TEXT CHECK (vat_treatment IS NULL OR
                   vat_treatment IN ('OUTPUT_VAT','INPUT_VAT','EXEMPT','OUT_OF_SCOPE')),
    description    TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_gl_accounts_code ON gl_accounts(business_id, code) WHERE is_deleted = 0;
CREATE INDEX idx_gl_accounts_type ON gl_accounts(account_type, is_active) WHERE is_deleted = 0;

CREATE TABLE gl_journal_entries (
    id             TEXT PRIMARY KEY,
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    branch_id      TEXT REFERENCES branches(id),     -- NULL = a group-level entry
    entry_number   TEXT NOT NULL,
    entry_date     TEXT NOT NULL,                    -- YYYY-MM-DD in WAT
    period         TEXT NOT NULL,                    -- YYYY-MM, for fast period reporting
    -- A DRAFT entry is not real and must never appear in a report. But a draft
    -- that is forgotten is worse than no draft, so posting is explicit and a
    -- scheduled job reports drafts older than a day.
    status         TEXT NOT NULL DEFAULT 'POSTED'
                   CHECK (status IN ('DRAFT','POSTED','REVERSED')),
    source_type    TEXT NOT NULL
                   CHECK (source_type IN ('SALE','SALE_RETURN','PO_RECEIPT','EXPENSE','STOCK_ADJUSTMENT','TRANSFER',
                                          'TILL_CLOSE','WHT','VAT','DEBTOR_PAYMENT','CREDITOR_PAYMENT','INSTALMENT',
                                          'LAYAWAY','DELIVERY','WARRANTY','FX_REVALUATION','OPENING_BALANCE',
                                          'DEPRECIATION','PROVISION','MANUAL','BAD_DEBT','CHANGE_OWED','VOUCHER')),
    source_id      TEXT,
    reference      TEXT,
    description    TEXT NOT NULL,
    total_debit_kobo  INTEGER NOT NULL DEFAULT 0,
    total_credit_kobo INTEGER NOT NULL DEFAULT 0,
    currency       TEXT NOT NULL DEFAULT 'NGN',
    fx_rate        REAL NOT NULL DEFAULT 1,
    reversed_by_entry_id TEXT REFERENCES gl_journal_entries(id),
    reverses_entry_id    TEXT REFERENCES gl_journal_entries(id),
    posted_by      TEXT REFERENCES users(id),
    posted_at      TEXT,
    created_by     TEXT REFERENCES users(id),
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted     INTEGER NOT NULL DEFAULT 0,
    -- THE FUNDAMENTAL INVARIANT. A journal entry that does not balance is not a
    -- journal entry. Enforced by the database, because an application check can
    -- be bypassed by a code path nobody thought of and this one cannot.
    CHECK (total_debit_kobo = total_credit_kobo),
    CHECK (total_debit_kobo >= 0)
);
CREATE UNIQUE INDEX idx_gl_je_number ON gl_journal_entries(business_id, entry_number) WHERE is_deleted = 0;
CREATE INDEX idx_gl_je_branch ON gl_journal_entries(branch_id, entry_date) WHERE is_deleted = 0;
CREATE INDEX idx_gl_je_period ON gl_journal_entries(business_id, period, status) WHERE is_deleted = 0;
CREATE INDEX idx_gl_je_source ON gl_journal_entries(source_type, source_id) WHERE is_deleted = 0;
CREATE INDEX idx_gl_je_draft ON gl_journal_entries(status, created_at) WHERE status = 'DRAFT' AND is_deleted = 0;

CREATE TABLE gl_journal_lines (
    id                TEXT PRIMARY KEY,
    journal_entry_id  TEXT NOT NULL REFERENCES gl_journal_entries(id),
    account_id        TEXT NOT NULL REFERENCES gl_accounts(id),
    account_code      TEXT NOT NULL,        -- denormalised so an export is readable without a join
    account_name      TEXT NOT NULL,
    direction         TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
    amount_kobo       INTEGER NOT NULL CHECK (amount_kobo > 0),
    amount            REAL NOT NULL,
    branch_id         TEXT REFERENCES branches(id),
    -- Dimensional reporting: which product category earned this revenue. This is
    -- what lets an owner answer "are the appliances carrying the furniture?"
    -- without a separate reporting system.
    category_id       TEXT REFERENCES product_categories(id),
    category_code     TEXT,
    description       TEXT,
    reference         TEXT,
    -- VAT and WHT splits carried on the line so a tax return can be produced
    -- from the ledger alone, without re-deriving it from operational tables.
    vat_kobo          INTEGER NOT NULL DEFAULT 0,
    wht_kobo          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_gl_lines_entry ON gl_journal_lines(journal_entry_id) WHERE is_deleted = 0;
CREATE INDEX idx_gl_lines_account ON gl_journal_lines(account_id, created_at) WHERE is_deleted = 0;
CREATE INDEX idx_gl_lines_category ON gl_journal_lines(category_code) WHERE category_code IS NOT NULL AND is_deleted = 0;
CREATE INDEX idx_gl_lines_branch ON gl_journal_lines(branch_id) WHERE is_deleted = 0;

-- Period close. Once a period is closed its entries cannot be amended, because
-- a set of accounts that can be silently rewritten after the owner has read
-- them is not a set of accounts.
CREATE TABLE gl_periods (
    id             TEXT PRIMARY KEY,
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    period         TEXT NOT NULL,          -- 'YYYY-MM'
    status         TEXT NOT NULL DEFAULT 'OPEN'
                   CHECK (status IN ('OPEN','CLOSED','LOCKED')),
    opened_at      TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at      TEXT,
    closed_by      TEXT REFERENCES users(id),
    -- Retained earnings carried forward, so a balance sheet can be produced for
    -- any period without replaying every prior one.
    net_income_kobo INTEGER NOT NULL DEFAULT 0,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (business_id, period)
);

-- ---------------------------------------------------------------------
-- SCHEDULER RUNS
-- ---------------------------------------------------------------------
-- Nightly jobs: release expired holds, mark overdue instalments MISSED, refresh
-- debt ageing, verify hash chains, prune idempotency keys and sync logs, check
-- compliance expiries, compute provisions. A job that silently stopped running
-- is worse than no job, so every run is recorded and a missed run is visible.
CREATE TABLE scheduler_runs (
    id             TEXT PRIMARY KEY,
    job_name       TEXT NOT NULL,
    business_id    TEXT REFERENCES businesses(id),
    status         TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS','PARTIAL','FAILED','SKIPPED')),
    started_at     TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at    TEXT,
    duration_ms    INTEGER,
    rows_affected  INTEGER NOT NULL DEFAULT 0,
    result_json    TEXT,
    error_message  TEXT,
    triggered_by   TEXT NOT NULL DEFAULT 'SCHEDULE' CHECK (triggered_by IN ('SCHEDULE','MANUAL','STARTUP'))
);
CREATE INDEX idx_scheduler_runs_job ON scheduler_runs(job_name, started_at);
CREATE INDEX idx_scheduler_runs_failed ON scheduler_runs(status, started_at) WHERE status = 'FAILED';
