-- =====================================================================
-- 0002_ownership_and_pin_columns.sql
-- =====================================================================
-- Two columns the route layer needs that 0001 did not have. Both are additive
-- and nullable, so applying this to a database that already has data changes no
-- existing row and breaks no query.
--
-- WHY THESE ARE COLUMNS AND NOT SOMETHING ELSE
--
-- users.pin_changed_at
--   A PIN change is a security event, and the timestamp is what makes it
--   actionable. Two things depend on it:
--     * "Has this person ever changed the PIN they were issued?" — a user still
--       on their original PIN is a user whose PIN may have been read over a
--       shoulder on day one.
--     * "Are there sessions older than the last PIN change?" — if a PIN was
--       changed because it was compromised, a token issued before the change is
--       exactly the token an attacker holds. Without the timestamp there is no
--       way to distinguish those sessions from legitimate ones.
--   Storing it as a note in an audit row would make both questions a full scan of
--   the audit log, which grows without bound.
--
-- products.created_by
--   The catalogue is shared across branches, so "who added this?" cannot be
--   derived from branch scoping. Without the column the only record is the audit
--   log, which is append-only and is the wrong place to answer a question that
--   is asked constantly ("who set this price?"). Note that this records
--   CREATION only — every later change stays in the audit log, because a
--   mutable "last edited by" column would be overwritten by the edit that
--   matters least.
-- =====================================================================

ALTER TABLE users ADD COLUMN pin_changed_at TEXT;

ALTER TABLE products ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- A user who has never changed their PIN is the population worth asking about,
-- and that question is asked on a screen listing users, so it is indexed rather
-- than scanned.
CREATE INDEX IF NOT EXISTS idx_users_pin_changed_at ON users(pin_changed_at);

-- Catalogue queries filter by business and order by creation, so the creator is
-- read alongside those columns constantly.
CREATE INDEX IF NOT EXISTS idx_products_created_by ON products(created_by);
