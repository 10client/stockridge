-- 0004_sync_indexes — indexes the incremental pull walks on
-- Every PULLABLE table that is filtered by business or branch must have an
-- index that matches what the pull asks: business_id and branch_id together
-- with updated_at and id, so Turso does not scan the table to answer
-- "what changed since my cursor?". A scan on a 11k product table is the
-- Turso rows-read quota, not a slow query.
--
-- These are IF NOT EXISTS so a database that already has 0001's three
-- business indexes does not error, and so a fresh database gets them from
-- 0001 plus this file. Nothing here edits 0001 to 0003.

CREATE INDEX IF NOT EXISTS idx_sync_businesses_updated ON businesses(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_branches_business_updated ON branches(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_users_business_updated ON users(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_customer_classes_business_updated ON customer_classes(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_categories_business_updated ON product_categories(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_price_lists_business_updated ON price_lists(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_suppliers_business_updated ON suppliers(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_customers_branch_updated ON customers(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_stock_batches_branch_updated ON stock_batches(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_stock_batches_business_branch_updated ON stock_batches(business_id, branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_purchase_orders_business_updated ON purchase_orders(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_purchase_orders_branch_updated ON purchase_orders(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_branch_compliance_branch_updated ON branch_compliance_records(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_branch_safe_branch_updated ON branch_safe_ledger(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_branch_safe_business_branch_updated ON branch_safe_ledger(business_id, branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_deposits_branch_updated ON deposits(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_deposits_business_branch_updated ON deposits(business_id, branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_instalment_plans_branch_updated ON instalment_plans(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_delivery_jobs_branch_updated ON delivery_jobs(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sales_business_updated2 ON sales(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sales_branch_updated ON sales(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sales_business_branch_updated ON sales(business_id, branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_customer_bills_branch_updated ON customer_bills(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_change_owed_branch_updated ON change_owed(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_till_sessions_branch_updated ON till_sessions(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_serial_numbers_branch_updated ON serial_numbers(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sale_payments_branch_updated ON sale_payments(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sale_serials_branch_created ON sale_serials(branch_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_bill_holds_created ON bill_holds(created_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_price_overrides_branch_updated ON product_price_overrides(branch_id, updated_at, id);

-- The stock gate is SELECT 1 FROM stock_batches WHERE business_id... AND branch_id... AND is_deleted=0 AND quantity>0 LIMIT 1
-- Give it a covering index so an empty shelf is a cheap seek, not a scan.
CREATE INDEX IF NOT EXISTS idx_stock_batches_gate ON stock_batches(business_id, branch_id, is_deleted, quantity);

-- Vertical copies paginate without a watermark, ordered by name or created_at.
-- Those paginations still need an index that matches the filter + order, or Turso counts rows scanned.
CREATE INDEX IF NOT EXISTS idx_asset_agreements_business_updated ON asset_agreements(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_business_updated ON delivery_jobs(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_business_updated ON stock_transfers(from_business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_stocktake_sessions_branch_updated ON stocktake_sessions(branch_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_expenses_branch_date ON expenses(branch_id, expense_date, updated_at, id);
