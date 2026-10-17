-- =====================================================================
-- 0020 — WHO A MANAGER PUT ON THE LOAD
-- =====================================================================
-- The person, the vehicle and the amounts are attached by a manager or
-- above, not typed in when somebody marks the drop delivered. The staff
-- member is a user, not only a name. Old jobs have no attachment; they
-- cannot leave a confirmed dispatch mix until a manager attaches the load.
--
-- Applied migrations are not edited.
-- =====================================================================

ALTER TABLE delivery_jobs ADD COLUMN driver_user_id TEXT;
ALTER TABLE delivery_jobs ADD COLUMN load_attached_at TEXT;
ALTER TABLE delivery_jobs ADD COLUMN load_attached_by TEXT;
