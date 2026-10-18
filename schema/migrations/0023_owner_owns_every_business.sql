-- The proprietor owns every business and every branch. A business_id on an
-- owner row was only the books they were created against, and the scope
-- ignored it. A co-owner is an owner whose business_id is set, plus grants
-- for any further businesses. None exist yet, so every current owner is the
-- proprietor. Leaving the pin in place would confine them to one business
-- the moment the scope starts honouring it.

UPDATE users
   SET business_id = NULL,
       branch_id = NULL,
       updated_at = datetime('now')
 WHERE role = 'OWNER'
   AND is_deleted = 0
   AND (business_id IS NOT NULL OR branch_id IS NOT NULL);
