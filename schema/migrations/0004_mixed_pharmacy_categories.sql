-- A pharmacy that also sells like a supermarket needs the other shelf
-- categories, and a supermarket that dispenses needs a place to file drugs.
-- Missing codes only. Existing categories are left where the shop put them.
-- No products, prices, or stock.
-- D1 allows five compound SELECT terms, so this list is a VALUES table.

INSERT INTO product_categories (id, business_id, code, name, sort_order, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, v.code, v.name, v.sort_order, 1, datetime('now'), datetime('now')
FROM businesses b
JOIN (
  SELECT column1 AS profile_code, column2 AS code, column3 AS name, column4 AS sort_order
  FROM (
    VALUES
      ('PHARMACEUTICAL', 'PROVISIONS', 'Provisions', 40),
      ('PHARMACEUTICAL', 'DRINKS', 'Drinks', 41),
      ('PHARMACEUTICAL', 'SNACKS', 'Snacks', 42),
      ('PHARMACEUTICAL', 'PERSONAL_CARE', 'Personal care', 43),
      ('PHARMACEUTICAL', 'HOUSEHOLD', 'Household', 44),
      ('PHARMACEUTICAL', 'BABY', 'Baby care', 45),
      ('PHARMACEUTICAL', 'ACCESSORIES', 'Accessories', 46),
      ('SUPERMARKET', 'ANALGESICS', 'Analgesics', 50),
      ('SUPERMARKET', 'VITAMINS', 'Vitamins and supplements', 51),
      ('SUPERMARKET', 'RESPIRATORY', 'Respiratory', 52)
  )
) v ON v.profile_code = b.profile_code
WHERE b.is_deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM product_categories c
    WHERE c.business_id = b.id AND c.code = v.code AND c.is_deleted = 0
  );
