-- =====================================================================
-- 0015 — A FLAGGED SALE, AND WHO CLEARED IT
-- =====================================================================
-- A late posting, a balance still owed, a transfer with no reference, a
-- sale the cleanup refused to replay: each of these already existed as a
-- note, a column, or a row in sync_conflicts. None of them had a place a
-- person could fix the data and then clear the problem, and none of them
-- recorded who was allowed to do that.
--
-- This table is that place. It does not replace the sale. A voided sale
-- stays in the sales book; clearing a flag does not delete it, and a
-- correction here cannot change the total, the stock, or the journal.
--
-- One row per sale and problem. A cleared row stays, so the same scan
-- does not raise the same flag again the moment it is cleared.
-- =====================================================================

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

CREATE UNIQUE INDEX idx_sale_issues_sale_code ON sale_issues(sale_id, code) WHERE sale_id IS NOT NULL;
CREATE UNIQUE INDEX idx_sale_issues_client_code ON sale_issues(client_id, code) WHERE client_id IS NOT NULL AND sale_id IS NULL;
CREATE INDEX idx_sale_issues_open ON sale_issues(business_id, status, detected_at);
