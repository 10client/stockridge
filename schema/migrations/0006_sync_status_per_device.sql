-- =====================================================================
-- 0006_sync_status_per_device.sql — "WHICH PHONE IS STUCK?" HAS TO BE ANSWERABLE
-- =====================================================================
-- `branch_sync_status` was created with `branch_id TEXT PRIMARY KEY` — ONE ROW PER
-- BRANCH — and `device_id` as a plain column. That is a description of the first thing
-- that ever synced there, not a record of the devices syncing now:
--
--   * the heartbeat, the push and the pull all upsert `ON CONFLICT(branch_id)`, and
--     NONE of them ever wrote `device_id` on the update path;
--   * so the second phone in a branch is invisible in `/api/sync/status`, and the
--     `pending_push_count` and `last_sync_error` it reports are attributed to whichever
--     device happened to sync there first;
--   * and a `last_sync_error` that belongs to a device nobody can see is an error
--     nobody can fix.
--
-- A shop with a counter phone and a manager's phone is the ordinary case. "Three
-- devices are syncing and one has not been heard from in two days" is the question an
-- operator asks, and the answer has to be per DEVICE.
--
-- So the primary key becomes (branch_id, device_id): the same shape as every other
-- table in the sync module, and the shape the endpoint's own field name (`devices`)
-- always claimed.
--
-- Existing rows are carried across, so a deployment that has been running keeps its
-- sync history for the device it knew about. `v_branch_sync_health` is recreated to
-- judge a branch by its MOST RECENT device rather than by a single row, so its meaning
-- ("is this branch syncing?") does not change when a branch gains a second phone.
--
-- A migration is tracked by CHECKSUM on the Node side, so this file must not be edited
-- once it has been applied anywhere.
-- =====================================================================

-- 1. THE VIEWS THAT READ IT COME DOWN FIRST. SQLite validates a view against its
--    tables when the table is dropped, so dropping `branch_sync_status` while
--    `v_branch_sync_overview` still names it fails with "error in view ... no such
--    table" — the migration refuses before it changes anything, which is the right
--    order of failure but a confusing message. Both views are recreated below.
DROP VIEW IF EXISTS v_branch_sync_overview;

-- 2. The new shape, per (branch, device).
CREATE TABLE branch_sync_status_v2 (
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

-- 3. Carry the old rows across. A row with no branch or no device cannot be named and
--    is dropped rather than invented — `device_id` was NULLable before, and a sync
--    record with no device is not evidence of anything.
INSERT INTO branch_sync_status_v2 (branch_id, device_id, app_version, last_heartbeat_at,
       last_push_at, last_pull_at, pending_push_count, last_sync_error, updated_at)
SELECT branch_id, COALESCE(device_id, 'UNKNOWN-DEVICE'), app_version, last_heartbeat_at,
       last_push_at, last_pull_at, pending_push_count, last_sync_error, updated_at
FROM branch_sync_status
WHERE branch_id IS NOT NULL;

DROP TABLE branch_sync_status;
ALTER TABLE branch_sync_status_v2 RENAME TO branch_sync_status;

CREATE INDEX idx_branch_sync_status_heartbeat ON branch_sync_status(last_heartbeat_at DESC);
CREATE INDEX idx_branch_sync_status_device ON branch_sync_status(device_id);

-- 4. The overview view again, judging each branch by the device heard from MOST
--    RECENTLY. Its meaning does not change — "is this branch syncing?" — even though
--    the table underneath it now holds one row per phone.
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
