-- =====================================================================
-- 0005_cash_over_and_short.sql — ONE ACCOUNT FOR A DRAWER THAT DOES NOT MATCH
-- =====================================================================
-- A till counted short is a real loss and an overage is real money; both need
-- an account of their own to land in, or the only place a shortage is ever
-- visible is a variance column on a till sheet that nobody reconciles.
--
-- 6910 Cash Over & Short is added to the chart of accounts in
-- server/services/glService.js so that every business provisioned from now on
-- gets it. This backfills the businesses that already exist — the live
-- deployments, whose books are the reason the account is needed at all.
--
-- WHY A DEDICATED ACCOUNT AND NOT 6900 Sundry Expenses: "how much is this shop
-- short this month" is a question an owner asks, and with shortages folded into
-- sundry there is no line in the profit and loss that answers it.
--
-- Idempotent by construction: the INSERT selects only businesses that do not
-- already carry the code, so re-running it (a restored backup, a migration
-- replayed by hand) cannot duplicate the account. Note that a migration is
-- tracked by CHECKSUM on the Node side, so this file must not be edited once it
-- has been applied anywhere.
--
-- `is_control = 1` because the application posts to it and no person picks it in
-- a form; `is_system = 1` so it cannot be deleted from the chart screen.
-- =====================================================================

INSERT INTO gl_accounts (id, business_id, code, name, account_type, is_system, is_control, normal_side, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, '6910', 'Cash Over & Short', 'EXPENSE', 1, 1, 'DEBIT', 1, datetime('now'), datetime('now')
FROM businesses b
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts a
  WHERE a.business_id = b.id AND a.code = '6910' AND a.is_deleted = 0
);
