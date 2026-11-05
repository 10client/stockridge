-- Pharmaceutical businesses list the Greenbook under drug shelves.
-- Supermarket aisles stay on supermarket businesses. Missing codes only.
-- No products are copied. The Greenbook table is not scanned.
-- 0001 to 0006 are not edited.

INSERT INTO product_categories (id, business_id, code, name, sort_order, is_active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), b.id, v.code, v.name, v.sort_order, 1, datetime('now'), datetime('now')
FROM businesses b
JOIN (
  SELECT column1 AS code, column2 AS name, column3 AS sort_order
  FROM (
    VALUES
      ('ALIMENTARY', 'Alimentary', 10),
      ('ANALGESICS', 'Analgesics', 11),
      ('ANTI_INFECTIVES', 'Anti-infectives', 12),
      ('ANTINEOPLASTIC', 'Antineoplastic', 13),
      ('ANTIPARASITIC', 'Antiparasitic', 14),
      ('BLOOD', 'Blood and blood forming', 15),
      ('CARDIOVASCULAR', 'Cardiovascular', 16),
      ('CONTROLLED', 'Controlled medicines', 17),
      ('DERMATOLOGY', 'Dermatology', 18),
      ('GENITO_URINARY', 'Genito-urinary', 19),
      ('INJECTIONS', 'Injections', 20),
      ('MEDICAL_DEVICE', 'Medical devices', 21),
      ('MUSCULOSKELETAL', 'Musculoskeletal', 22),
      ('NERVOUS_SYSTEM', 'Nervous system', 23),
      ('PHARMA_OTHER', 'Other medicines', 24),
      ('PHARMA_VARIOUS', 'Various', 25),
      ('RESPIRATORY', 'Respiratory', 26),
      ('SENSORY', 'Sensory organs', 27),
      ('SYSTEMIC_HORMONES', 'Systemic hormones', 28),
      ('VACCINES', 'Vaccines and biologics', 29),
      ('VETERINARY', 'Veterinary', 30),
      ('VITAMINS', 'Vitamins and supplements', 31)
  )
) v
WHERE b.is_deleted = 0
  AND b.profile_code = 'PHARMACEUTICAL'
  AND NOT EXISTS (
    SELECT 1 FROM product_categories c
    WHERE c.business_id = b.id AND c.code = v.code AND c.is_deleted = 0
  );

UPDATE product_categories
SET parent_id = (
      SELECT p.id FROM product_categories p
      WHERE p.business_id = product_categories.business_id
        AND p.code = 'PHARMACEUTICALS' AND p.is_deleted = 0
      LIMIT 1
    ),
    updated_at = datetime('now')
WHERE is_deleted = 0
  AND parent_id IS NULL
  AND code IN (
    'ALIMENTARY', 'ANALGESICS', 'ANTI_INFECTIVES', 'ANTINEOPLASTIC', 'ANTIPARASITIC',
    'BLOOD', 'CARDIOVASCULAR', 'CONTROLLED', 'DERMATOLOGY', 'GENITO_URINARY',
    'INJECTIONS', 'MEDICAL_DEVICE', 'MUSCULOSKELETAL', 'NERVOUS_SYSTEM', 'PHARMA_OTHER',
    'PHARMA_VARIOUS', 'RESPIRATORY', 'SENSORY', 'SYSTEMIC_HORMONES', 'VACCINES',
    'VETERINARY', 'VITAMINS'
  )
  AND business_id IN (
    SELECT id FROM businesses WHERE profile_code = 'PHARMACEUTICAL' AND is_deleted = 0
  );

UPDATE product_categories
SET is_deleted = 1, is_active = 0, updated_at = datetime('now')
WHERE is_deleted = 0
  AND code IN ('PROVISIONS', 'DRINKS', 'SNACKS', 'PERSONAL_CARE', 'HOUSEHOLD', 'BABY', 'ACCESSORIES')
  AND business_id IN (
    SELECT id FROM businesses WHERE profile_code = 'PHARMACEUTICAL' AND is_deleted = 0
  );

UPDATE products
SET category_id = NULL, updated_at = datetime('now')
WHERE is_deleted = 0
  AND category_id IN (
    SELECT id FROM product_categories
    WHERE is_deleted = 1
      AND code IN ('PROVISIONS', 'DRINKS', 'SNACKS', 'PERSONAL_CARE', 'HOUSEHOLD', 'BABY', 'ACCESSORIES')
      AND business_id IN (
        SELECT id FROM businesses WHERE profile_code = 'PHARMACEUTICAL' AND is_deleted = 0
      )
  );
