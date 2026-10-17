-- =====================================================================
-- 0019 — HOW THE GOODS WERE SOLD
-- =====================================================================
-- Paid on the spot, or supplied on credit. The choice is made when the
-- sale starts and kept on the sale and on the drop. The paper handed
-- over reads it. Old sales have no choice stored; the receipt falls
-- back to the sale type and the balance.
--
-- Applied migrations are not edited.
-- =====================================================================

ALTER TABLE sales ADD COLUMN settlement TEXT;
ALTER TABLE delivery_jobs ADD COLUMN settlement TEXT;
