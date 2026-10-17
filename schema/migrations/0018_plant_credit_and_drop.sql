-- =====================================================================
-- 0018 — PLANT CREDIT, MANUFACTURING STOCK, THE DROP, OPTIONAL GPS
-- =====================================================================
-- A water plant and a bakery already keep credit on the customer and the
-- debtor ledger. This does not add a second ledger. It records, on the
-- drop itself, what that transaction was, and it lets a customer pin be
-- optional. Manufacturing inputs are stock that is counted and not sold
-- at the till. Leather is not seeded here: a plant adds the inputs it
-- actually uses.
--
-- Applied migrations are not edited. These columns are new. A shop that
-- never sets them keeps working.
-- =====================================================================

ALTER TABLE customers ADD COLUMN latitude REAL;
ALTER TABLE customers ADD COLUMN longitude REAL;
ALTER TABLE customers ADD COLUMN gps_label TEXT;

ALTER TABLE products ADD COLUMN stock_role TEXT DEFAULT 'FINISHED';

ALTER TABLE delivery_jobs ADD COLUMN supply_terms TEXT;
ALTER TABLE delivery_jobs ADD COLUMN goods_value REAL;
ALTER TABLE delivery_jobs ADD COLUMN amount_paid REAL;
ALTER TABLE delivery_jobs ADD COLUMN balance_due REAL;
ALTER TABLE delivery_jobs ADD COLUMN txn_customer_name TEXT;
ALTER TABLE delivery_jobs ADD COLUMN txn_customer_phone TEXT;
ALTER TABLE delivery_jobs ADD COLUMN latitude REAL;
ALTER TABLE delivery_jobs ADD COLUMN longitude REAL;
ALTER TABLE delivery_jobs ADD COLUMN transaction_note TEXT;

-- Film, flour and sugar already in a plant catalogue are inputs, not
-- counter goods. A plant that also retails an input can turn sale back on.
UPDATE products
   SET stock_role = 'INPUT',
       offers_sale = 0,
       updated_at = datetime('now')
 WHERE sku IN ('WP-PK-001', 'BK-IN-001', 'BK-IN-002')
   AND is_deleted = 0;
