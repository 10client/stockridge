-- The sync watermark. A later pull asks for rows changed since a timestamp.
-- Without an index on that timestamp, Turso scans the table and counts every
-- row it walks. These indexes are additive. They do not change a stored row,
-- and they are not partial: a soft-deleted row has to be findable too, or the
-- till would re-read the shelf to notice a removal.
-- Applied only when migrations run. Do not edit 0001 to 0004.

CREATE INDEX IF NOT EXISTS idx_sync_products_updated ON products(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_units_updated ON product_units(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_variants_updated ON product_variants(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_barcodes_updated ON product_barcodes(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_categories_updated ON product_categories(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_product_measures_updated ON product_measures(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_price_list_items_updated ON price_list_items(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_stock_batches_updated ON stock_batches(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_customers_updated ON customers(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sales_updated ON sales(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sale_items_updated ON sale_items(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sale_payments_updated ON sale_payments(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_purchase_orders_updated ON purchase_orders(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_purchase_order_items_updated ON purchase_order_items(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_sync_sale_serials_created ON sale_serials(created_at, id);
