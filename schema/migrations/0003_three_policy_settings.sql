-- =====================================================================
-- 0003_the_three_settings_the_code_already_reads.sql
-- =====================================================================
-- A SETTING THAT CANNOT BE SET IS WORSE THAN NO SETTING.
--
-- Three policy values have been read out of `client_settings` by code that was
-- written, wired and reachable since the credit and instalment modules landed —
-- and none of the three had a column, so the read always produced `undefined` and
-- the fallback in the expression always won:
--
--   domain/credit.js:198       Number(settings.credit_grace_days) || 0
--   domain/instalments.js:291  Number(settings.instalment_default_after_days) || 60
--   domain/instalments.js:292  Number(settings.instalment_default_after_missed) || 3
--
-- Both are reached with real settings from the request:
--
--   server/routes/customers.js:346   overdueWarning({ entries, settings: ctx.get('settings') })
--   server/routes/afterSales.js:1380 defaultTrigger({ plan, settings: ctx.get('settings'), today })
--
-- so the behaviour worked — at 0 days' grace, 60 days of arrears and 3 missed
-- instalments — and an owner had no way to change any of the three. The values
-- are not arbitrary: how many days late a debtor starts being a problem, and how
-- much arrears means an instalment plan has failed, are exactly the judgements a
-- Nigerian merchant makes differently from their neighbour.
--
-- The defaults below are the fallbacks the code was already using, so applying
-- this migration does not change what any existing deployment does. It only makes
-- the numbers reachable.
--
-- APPLIED ONCE, TRACKED BY CHECKSUM. `ALTER TABLE ... ADD COLUMN` is not
-- re-runnable in SQLite, so this file must be applied exactly once — which is what
-- the `_migrations` table in the Node backend and D1's own migration table both
-- guarantee. Do not add an `IF NOT EXISTS` that SQLite will not accept, and do not
-- edit this file after it has been applied: the checksum is what catches that.
-- =====================================================================

ALTER TABLE client_settings ADD COLUMN credit_grace_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE client_settings ADD COLUMN instalment_default_after_days INTEGER NOT NULL DEFAULT 60;
ALTER TABLE client_settings ADD COLUMN instalment_default_after_missed INTEGER NOT NULL DEFAULT 3;
