-- =====================================================================
-- STOCKRIDGE — migration 0009: who raised each ledger entry
-- =====================================================================
--
-- WHAT WAS WRONG
-- --------------
-- debtor_ledger and creditor_ledger recorded `received_by` and `paid_by` —
-- which answer "who took the money?" — but nothing recorded WHO RAISED THE
-- ENTRY. For a PAYMENT those are the same person. For a SALE on credit, a debit
-- note, an opening balance or an FX revaluation there is no receipt at all, so
-- the entry had no attribution.
--
-- That is not a cosmetic gap. A debtor ledger is the evidence behind a demand
-- letter and, if it comes to it, a small-claims filing. An entry nobody can
-- attribute is an entry a customer can dispute without the business being able
-- to say who made it or on what authority. And internally, a manually-raised
-- debit note with no author is indistinguishable from one somebody invented.
--
-- The sales service was already written to supply a `created_by`, and the column
-- did not exist — so every credit sale failed at that INSERT. Because the
-- failure happened AFTER the sale row had been committed in an earlier
-- transaction step, the visible symptom was worse than an error: the sale
-- completed, the stock left the shelf, the customer's `balance_due` was set on
-- the sale, and NO RECEIVABLE WAS EVER RECORDED. The debt existed on one screen
-- and nowhere in the ledger, so the ageing report, the chase list, the bad-debt
-- provision and the balance sheet all reported a customer who owed nothing.
--
-- THE FIX
-- -------
-- Add `created_by` to both ledgers. It is nullable, because rows created by a
-- system process (a scheduled revaluation, an opening-balance import) have no
-- human author and inventing one would be worse than leaving it empty.

ALTER TABLE debtor_ledger   ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE creditor_ledger ADD COLUMN created_by TEXT REFERENCES users(id);

-- An entry raised by a person must be findable by that person: "show me
-- everything this cashier put on account last month" is a question a manager
-- asks, and without an index it is a full scan of the largest table in the
-- database.
CREATE INDEX idx_debtor_ledger_created_by   ON debtor_ledger(created_by, entry_date)   WHERE created_by IS NOT NULL;
CREATE INDEX idx_creditor_ledger_created_by ON creditor_ledger(created_by, entry_date) WHERE created_by IS NOT NULL;

-- Backfill: where a payment row already knows who handled it, that person is
-- also who created the entry. Nothing else can be inferred honestly, so
-- everything else stays NULL rather than being attributed to a guess.
UPDATE debtor_ledger   SET created_by = received_by WHERE created_by IS NULL AND received_by IS NOT NULL;
UPDATE creditor_ledger SET created_by = paid_by      WHERE created_by IS NULL AND paid_by      IS NOT NULL;
