-- One row per mirrored table. A real write bumps that row.
-- An idle till reads this table and does not open the catalogue.
-- Turso bills rows scanned, not rows returned. A three-minute
-- poll that walks products is the bill. A till that does not
-- send revisions keeps the watermark page. Do not edit 0001 to 0005.

CREATE TABLE IF NOT EXISTS sync_revisions (
  table_name  TEXT PRIMARY KEY,
  revision    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A day screen filters sold_at. date(sold_at) cannot use an index.
-- These match the filter and the order. They are not partial:
-- a voided or soft-deleted row still has to be findable.
CREATE INDEX IF NOT EXISTS idx_sales_business_sold ON sales(business_id, sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_branch_sold ON sales(branch_id, sold_at);
CREATE INDEX IF NOT EXISTS idx_products_business_updated ON products(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_customers_business_updated ON customers(business_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_stock_batches_business_updated ON stock_batches(business_id, updated_at, id);

INSERT INTO sync_revisions (table_name, revision, updated_at) VALUES
  ('businesses', 0, datetime('now')),
  ('branches', 0, datetime('now')),
  ('users', 0, datetime('now')),
  ('customer_classes', 0, datetime('now')),
  ('customers', 0, datetime('now')),
  ('product_categories', 0, datetime('now')),
  ('products', 0, datetime('now')),
  ('product_units', 0, datetime('now')),
  ('product_variants', 0, datetime('now')),
  ('product_barcodes', 0, datetime('now')),
  ('price_lists', 0, datetime('now')),
  ('price_list_items', 0, datetime('now')),
  ('product_price_overrides', 0, datetime('now')),
  ('suppliers', 0, datetime('now')),
  ('stock_batches', 0, datetime('now')),
  ('branch_compliance_records', 0, datetime('now')),
  ('branch_safe_ledger', 0, datetime('now')),
  ('purchase_orders', 0, datetime('now')),
  ('deposits', 0, datetime('now')),
  ('instalment_plans', 0, datetime('now')),
  ('delivery_jobs', 0, datetime('now')),
  ('client_settings', 0, datetime('now')),
  ('product_measures', 0, datetime('now')),
  ('purchase_order_items', 0, datetime('now')),
  ('sales', 0, datetime('now')),
  ('sale_items', 0, datetime('now')),
  ('sale_payments', 0, datetime('now')),
  ('sale_serials', 0, datetime('now')),
  ('sale_returns', 0, datetime('now')),
  ('sale_return_items', 0, datetime('now')),
  ('customer_bills', 0, datetime('now')),
  ('bill_holds', 0, datetime('now')),
  ('sale_issues', 0, datetime('now')),
  ('change_owed', 0, datetime('now')),
  ('till_sessions', 0, datetime('now')),
  ('serial_numbers', 0, datetime('now'))
ON CONFLICT(table_name) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS trg_rev_businesses_ins
AFTER INSERT ON businesses
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('businesses', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_businesses_upd
AFTER UPDATE ON businesses
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('businesses', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_businesses_del
AFTER DELETE ON businesses
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('businesses', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branches_ins
AFTER INSERT ON branches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branches_upd
AFTER UPDATE ON branches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branches_del
AFTER DELETE ON branches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_users_ins
AFTER INSERT ON users
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('users', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_users_upd
AFTER UPDATE ON users
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('users', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_users_del
AFTER DELETE ON users
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('users', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_classes_ins
AFTER INSERT ON customer_classes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_classes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_classes_upd
AFTER UPDATE ON customer_classes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_classes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_classes_del
AFTER DELETE ON customer_classes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_classes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customers_ins
AFTER INSERT ON customers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customers_upd
AFTER UPDATE ON customers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customers_del
AFTER DELETE ON customers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_categories_ins
AFTER INSERT ON product_categories
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_categories', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_categories_upd
AFTER UPDATE ON product_categories
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_categories', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_categories_del
AFTER DELETE ON product_categories
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_categories', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_products_ins
AFTER INSERT ON products
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('products', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_products_upd
AFTER UPDATE ON products
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('products', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_products_del
AFTER DELETE ON products
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('products', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_units_ins
AFTER INSERT ON product_units
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_units', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_units_upd
AFTER UPDATE ON product_units
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_units', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_units_del
AFTER DELETE ON product_units
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_units', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_variants_ins
AFTER INSERT ON product_variants
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_variants', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_variants_upd
AFTER UPDATE ON product_variants
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_variants', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_variants_del
AFTER DELETE ON product_variants
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_variants', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_barcodes_ins
AFTER INSERT ON product_barcodes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_barcodes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_barcodes_upd
AFTER UPDATE ON product_barcodes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_barcodes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_barcodes_del
AFTER DELETE ON product_barcodes
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_barcodes', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_lists_ins
AFTER INSERT ON price_lists
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_lists', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_lists_upd
AFTER UPDATE ON price_lists
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_lists', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_lists_del
AFTER DELETE ON price_lists
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_lists', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_list_items_ins
AFTER INSERT ON price_list_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_list_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_list_items_upd
AFTER UPDATE ON price_list_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_list_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_price_list_items_del
AFTER DELETE ON price_list_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('price_list_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_price_overrides_ins
AFTER INSERT ON product_price_overrides
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_price_overrides', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_price_overrides_upd
AFTER UPDATE ON product_price_overrides
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_price_overrides', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_price_overrides_del
AFTER DELETE ON product_price_overrides
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_price_overrides', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_suppliers_ins
AFTER INSERT ON suppliers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('suppliers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_suppliers_upd
AFTER UPDATE ON suppliers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('suppliers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_suppliers_del
AFTER DELETE ON suppliers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('suppliers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_stock_batches_ins
AFTER INSERT ON stock_batches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('stock_batches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_stock_batches_upd
AFTER UPDATE ON stock_batches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('stock_batches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_stock_batches_del
AFTER DELETE ON stock_batches
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('stock_batches', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_compliance_records_ins
AFTER INSERT ON branch_compliance_records
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_compliance_records', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_compliance_records_upd
AFTER UPDATE ON branch_compliance_records
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_compliance_records', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_compliance_records_del
AFTER DELETE ON branch_compliance_records
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_compliance_records', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_safe_ledger_ins
AFTER INSERT ON branch_safe_ledger
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_safe_ledger', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_safe_ledger_upd
AFTER UPDATE ON branch_safe_ledger
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_safe_ledger', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_branch_safe_ledger_del
AFTER DELETE ON branch_safe_ledger
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('branch_safe_ledger', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_orders_ins
AFTER INSERT ON purchase_orders
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_orders', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_orders_upd
AFTER UPDATE ON purchase_orders
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_orders', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_orders_del
AFTER DELETE ON purchase_orders
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_orders', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_deposits_ins
AFTER INSERT ON deposits
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('deposits', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_deposits_upd
AFTER UPDATE ON deposits
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('deposits', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_deposits_del
AFTER DELETE ON deposits
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('deposits', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_instalment_plans_ins
AFTER INSERT ON instalment_plans
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('instalment_plans', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_instalment_plans_upd
AFTER UPDATE ON instalment_plans
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('instalment_plans', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_instalment_plans_del
AFTER DELETE ON instalment_plans
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('instalment_plans', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_delivery_jobs_ins
AFTER INSERT ON delivery_jobs
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('delivery_jobs', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_delivery_jobs_upd
AFTER UPDATE ON delivery_jobs
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('delivery_jobs', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_delivery_jobs_del
AFTER DELETE ON delivery_jobs
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('delivery_jobs', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_client_settings_ins
AFTER INSERT ON client_settings
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('client_settings', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_client_settings_upd
AFTER UPDATE ON client_settings
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('client_settings', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_client_settings_del
AFTER DELETE ON client_settings
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('client_settings', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_measures_ins
AFTER INSERT ON product_measures
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_measures', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_measures_upd
AFTER UPDATE ON product_measures
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_measures', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_product_measures_del
AFTER DELETE ON product_measures
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('product_measures', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_order_items_ins
AFTER INSERT ON purchase_order_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_order_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_order_items_upd
AFTER UPDATE ON purchase_order_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_order_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_purchase_order_items_del
AFTER DELETE ON purchase_order_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('purchase_order_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sales_ins
AFTER INSERT ON sales
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sales', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sales_upd
AFTER UPDATE ON sales
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sales', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sales_del
AFTER DELETE ON sales
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sales', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_items_ins
AFTER INSERT ON sale_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_items_upd
AFTER UPDATE ON sale_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_items_del
AFTER DELETE ON sale_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_payments_ins
AFTER INSERT ON sale_payments
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_payments', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_payments_upd
AFTER UPDATE ON sale_payments
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_payments', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_payments_del
AFTER DELETE ON sale_payments
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_payments', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_serials_ins
AFTER INSERT ON sale_serials
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_serials', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_serials_upd
AFTER UPDATE ON sale_serials
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_serials', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_serials_del
AFTER DELETE ON sale_serials
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_serials', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_returns_ins
AFTER INSERT ON sale_returns
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_returns', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_returns_upd
AFTER UPDATE ON sale_returns
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_returns', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_returns_del
AFTER DELETE ON sale_returns
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_returns', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_return_items_ins
AFTER INSERT ON sale_return_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_return_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_return_items_upd
AFTER UPDATE ON sale_return_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_return_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_return_items_del
AFTER DELETE ON sale_return_items
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_return_items', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_bills_ins
AFTER INSERT ON customer_bills
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_bills', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_bills_upd
AFTER UPDATE ON customer_bills
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_bills', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_customer_bills_del
AFTER DELETE ON customer_bills
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('customer_bills', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_bill_holds_ins
AFTER INSERT ON bill_holds
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('bill_holds', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_bill_holds_upd
AFTER UPDATE ON bill_holds
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('bill_holds', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_bill_holds_del
AFTER DELETE ON bill_holds
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('bill_holds', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_issues_ins
AFTER INSERT ON sale_issues
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_issues', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_issues_upd
AFTER UPDATE ON sale_issues
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_issues', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_sale_issues_del
AFTER DELETE ON sale_issues
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('sale_issues', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_change_owed_ins
AFTER INSERT ON change_owed
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('change_owed', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_change_owed_upd
AFTER UPDATE ON change_owed
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('change_owed', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_change_owed_del
AFTER DELETE ON change_owed
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('change_owed', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_till_sessions_ins
AFTER INSERT ON till_sessions
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('till_sessions', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_till_sessions_upd
AFTER UPDATE ON till_sessions
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('till_sessions', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_till_sessions_del
AFTER DELETE ON till_sessions
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('till_sessions', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_serial_numbers_ins
AFTER INSERT ON serial_numbers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('serial_numbers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_serial_numbers_upd
AFTER UPDATE ON serial_numbers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('serial_numbers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS trg_rev_serial_numbers_del
AFTER DELETE ON serial_numbers
BEGIN
  INSERT INTO sync_revisions (table_name, revision, updated_at)
  VALUES ('serial_numbers', 1, datetime('now'))
  ON CONFLICT(table_name) DO UPDATE SET
    revision = revision + 1,
    updated_at = datetime('now');
END;
