-- =====================================================================
-- 0004_the_date_the_money_was_due.sql
-- =====================================================================
-- WHAT "OVERDUE" MEANS WITHOUT A DUE DATE.
--
-- `debtor_ledger` records what a customer owes and when the row was written. It
-- does not record when the money was DUE — so every reader that wants to age a
-- balance falls back to `created_at`:
--
--   domain/credit.js:overdueWarning    e.due_date || e.created_at
--   domain/credit.js:ageBalance        the same
--
-- `sales.due_date` has existed from the first migration and the sale path sets it,
-- from the customer's own terms (`creditDueDate` — the customer's override, else
-- the customer class, else `credit_max_days`). The ledger simply never carried it
-- across. The consequences are quiet and they all point the same way:
--
--   * a customer on 30-day terms who bought yesterday reads as zero days late —
--     only because the fallback happens to exist and happens to be recent. Age the
--     row and they read as late from the day of the sale, which is not what the
--     terms say and not what the warning is for;
--   * `credit_grace_days` — the setting an owner just became able to change — is
--     compared against days since the SALE, so it means something different for
--     every customer class. It should mean "days past the due date".
--
-- This adds the column, and backfills it for credit sales that already exist from
-- the sale they belong to. The backfill is exact rather than approximate: the
-- ledger row carries `reference_id` = the sale, and the sale carries the due date
-- that was computed for it at the time.
--
-- Nullable, additive, and no reader is required to change: `overdueWarning` already
-- prefers `due_date` and falls back to `created_at`, which is now only reachable
-- for the entry types that genuinely have no due date (PAYMENT, ADJUSTMENT,
-- WRITE_OFF).
-- =====================================================================

ALTER TABLE debtor_ledger ADD COLUMN due_date TEXT;

-- The credit sale that created a charge is named by `reference_id`, and it holds
-- the due date the customer's terms produced on the day. Rows with no sale behind
-- them (an opening balance entered by hand) keep NULL and age from `created_at`,
-- which is the honest answer for a debt nobody has a term for.
UPDATE debtor_ledger
   SET due_date = (SELECT s.due_date FROM sales s WHERE s.id = debtor_ledger.reference_id)
 WHERE due_date IS NULL
   AND entry_type = 'SALE'
   AND reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_debtor_ledger_due ON debtor_ledger(due_date);
