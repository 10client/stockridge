-- A pharmacy that also sells like a supermarket needs the other shelf
-- categories, and a supermarket that dispenses needs a place to file drugs.
-- Missing codes only. Existing categories are left where the shop put them.
-- No products, prices, or stock.

INSERT INTO product_categories (id, business_id, code, name, sort_order, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, v.code, v.name, v.sort_order, 1, datetime('now'), datetime('now')
FROM businesses b
JOIN (
  SELECT 'PHARMACEUTICAL' AS profile_code, 'PROVISIONS' AS code, 'Provisions' AS name, 40 AS sort_order
  UNION ALL SELECT 'PHARMACEUTICAL', 'DRINKS', 'Drinks', 41
  UNION ALL SELECT 'PHARMACEUTICAL', 'SNACKS', 'Snacks', 42
  UNION ALL SELECT 'PHARMACEUTICAL', 'PERSONAL_CARE', 'Personal care', 43
  UNION ALL SELECT 'PHARMACEUTICAL', 'HOUSEHOLD', 'Household', 44
  UNION ALL SELECT 'PHARMACEUTICAL', 'BABY', 'Baby care', 45
  UNION ALL SELECT 'PHARMACEUTICAL', 'ACCESSORIES', 'Accessories', 46
  UNION ALL SELECT 'SUPERMARKET', 'ANALGESICS', 'Analgesics', 50
  UNION ALL SELECT 'SUPERMARKET', 'VITAMINS', 'Vitamins and supplements', 51
  UNION ALL SELECT 'SUPERMARKET', 'RESPIRATORY', 'Respiratory', 52
) v ON v.profile_code = b.profile_code
WHERE b.is_deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM product_categories c
    WHERE c.business_id = b.id AND c.code = v.code AND c.is_deleted = 0
  );
